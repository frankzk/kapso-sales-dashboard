// El agente de leads (MOM §33) comparte `voice_calls`, la conexión de Telnyx y
// el vigilante con el agente de Reproprovincia (§11.8). Estas pruebas fijan que
// ninguno de los dos ve, cuenta, cierra ni puentea las llamadas del otro:
//   · la atadura (`openCalls` + `pickOpenCall`) y la fila (`loadCall`) son por
//     propósito;
//   · el vigilante cierra las de los dos, pero el «no contesta» de un lead es
//     una nota del lead, nunca la v2 del pedido; y una fila de lead que el
//     agente ya registró se cierra con SU resultado, sin «no contestó» encima;
//   · el tramo al agente de un lead va a SU puerta SIP con SU número;
//   · el tope diario, la salida Swayp y los tableros de Envíos son por pedido;
//     el de leads no cuenta lo que Telnyx rechazó antes de marcar, y un tope
//     que no se puede leer es un error (null), nunca «tope del día»;
//   · la lista «no llamar» se comparte a propósito.

import { generateKeyPairSync, sign } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

type Row = Record<string, unknown>;
type Filter = { op: "eq" | "neq" | "in" | "is" | "gte" | "lt" | "not"; col: string; val: unknown };
interface Op {
  table: string;
  kind: "select" | "update" | "insert";
  cols?: string;
  head?: boolean;
  patch?: Row;
  filters: Filter[];
  range?: [number, number];
}

const state = vi.hoisted(() => ({
  tables: {} as Record<string, Record<string, unknown>[]>,
  ops: [] as unknown[],
  rpcs: [] as { fn: string; args: unknown }[],
  leadNoAnswer: vi.fn(),
  recompute: vi.fn(),
  admin: null as unknown,
}));

vi.mock("@/lib/voice-leads-writeback", () => ({
  writeLeadNoAnswer: state.leadNoAnswer,
  loadLeadCall: vi.fn(),
  applyLeadVoiceResult: vi.fn(),
}));
vi.mock("@/lib/order-master", () => ({ recomputeOrderMasterSafe: state.recompute }));
vi.mock("@/lib/swayp-reenvio", () => ({ buscarOrigenReenvio: async () => null, reenviarGuiaAnulada: vi.fn() }));
vi.mock("@/lib/db", () => ({ createAdminSupabase: () => state.admin }));

import { callsForEngine, isStale, LEAD_IN_PROGRESS_TTL_MINUTES, pickOpenCall, type OpenCall } from "@/lib/voice-recovery";
import {
  closeAsNoAnswer,
  loadCall,
  loadDoNotCallPhones,
  openCalls,
  realCallsToday,
  salidasSwaypPendientes,
  sweepStaleCalls,
} from "@/lib/voice-recovery-server";
import { encodeClientState } from "@/lib/telnyx";
import { POST as telnyxWebhook } from "@/app/api/webhooks/telnyx/route";

// ── Una base en memoria con lo justo de PostgREST ────────────────────────────

/** `a->b` da el JSON; `a->>b` el texto, como en PostgREST. */
function valueAt(row: Row, col: string): unknown {
  const parts = col.split(/->>?/);
  let v: unknown = row[parts[0]!];
  for (const p of parts.slice(1)) v = v && typeof v === "object" ? (v as Row)[p] : undefined;
  if (col.includes("->>") && v !== null && v !== undefined) return String(v);
  return v;
}

function matches(row: Row, filters: Filter[]): boolean {
  return filters.every(({ op, col, val }) => {
    const v = valueAt(row, col);
    if (op === "eq") return v === val;
    // Como en SQL: `NULL <> x` no es verdadero, así que un NULL no pasa.
    if (op === "neq") return v !== null && v !== undefined && v !== val;
    if (op === "in") return (val as unknown[]).includes(v);
    if (op === "is") return val === null ? v === null || v === undefined : v === val;
    if (op === "not") return v !== null && v !== undefined;
    if (op === "gte") return String(v) >= String(val);
    return String(v) < String(val);
  });
}

function fakeAdmin(): SupabaseClient {
  return {
    from(table: string) {
      const op: Op = { table, kind: "select", filters: [] };
      const run = () => {
        state.ops.push(op);
        const rows = (state.tables[table] ??= []);
        if (op.kind === "insert") {
          rows.push({ ...(op.patch ?? {}) });
          return Promise.resolve({ data: [op.patch], error: null });
        }
        const hit = rows.filter((r) => matches(r, op.filters));
        if (op.kind === "update") for (const r of hit) Object.assign(r, op.patch);
        if (op.head) return Promise.resolve({ data: null, error: null, count: hit.length });
        const page = op.range ? hit.slice(op.range[0], op.range[1] + 1) : hit;
        return Promise.resolve({ data: page.map((r) => ({ ...r })), error: null });
      };
      const filter = (kind: Filter["op"]) => (col: string, val?: unknown) => {
        op.filters.push({ op: kind, col, val });
        return q;
      };
      const q: Record<string, unknown> = {
        select(cols?: string, opts?: { head?: boolean }) {
          if (op.kind === "select") {
            op.cols = cols;
            op.head = Boolean(opts?.head);
          }
          return q;
        },
        update(patch: Row) {
          op.kind = "update";
          op.patch = patch;
          return q;
        },
        insert(patch: Row) {
          op.kind = "insert";
          op.patch = patch;
          return q;
        },
        eq: filter("eq"),
        neq: filter("neq"),
        in: filter("in"),
        is: filter("is"),
        gte: filter("gte"),
        lt: filter("lt"),
        not: filter("not"),
        order: () => q,
        limit: () => q,
        range(from: number, to: number) {
          op.range = [from, to];
          return q;
        },
        maybeSingle: () =>
          run().then((r) => ({ ...r, data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data })),
        single: () => run().then((r) => ({ ...r, data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data })),
        then: (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) => run().then(ok, ko),
      };
      return q;
    },
    rpc(fn: string, args: unknown) {
      state.rpcs.push({ fn, args });
      return Promise.resolve({ data: null, error: null });
    },
  } as unknown as SupabaseClient;
}

const ops = () => state.ops as Op[];
const NOW = new Date("2026-10-12T16:00:00Z");
const hace = (min: number) => new Date(NOW.getTime() - min * 60_000).toISOString();

beforeEach(() => {
  state.tables = {};
  state.ops = [];
  state.rpcs = [];
  state.leadNoAnswer.mockReset();
  state.recompute.mockReset();
  state.admin = fakeAdmin();
});

// ── Reglas puras ─────────────────────────────────────────────────────────────

describe("ventana de una llamada de lead (MOM §33)", () => {
  const call = (o: Partial<OpenCall>): OpenCall => ({
    id: "c",
    agent_number: "leads",
    phone: "930000001",
    status: "in_progress",
    dialed_at: hace(10),
    started_at: hace(6),
    ...o,
  });

  it("en curso, un lead dura 8 minutos; un pedido sigue en 5", () => {
    expect(LEAD_IN_PROGRESS_TTL_MINUTES).toBe(8);
    expect(isStale(call({ purpose: "lead", started_at: hace(6) }), NOW)).toBe(false);
    expect(isStale(call({ purpose: "lead", started_at: hace(7.9) }), NOW)).toBe(false);
    expect(isStale(call({ purpose: "lead", started_at: hace(8.1) }), NOW)).toBe(true);
    expect(isStale(call({ purpose: "order", started_at: hace(6) }), NOW)).toBe(true);
  });

  it("sin propósito es pedido: lo que la base pone por defecto", () => {
    expect(isStale(call({ started_at: hace(6) }), NOW)).toBe(true);
    expect(isStale(call({ purpose: null, started_at: hace(6) }), NOW)).toBe(true);
  });

  it("marcando, los dos caen a los 3 minutos", () => {
    expect(isStale(call({ purpose: "lead", status: "dialing", dialed_at: hace(4) }), NOW)).toBe(true);
    expect(isStale(call({ purpose: "lead", status: "dialing", dialed_at: hace(2) }), NOW)).toBe(false);
  });
});

// ── La atadura ───────────────────────────────────────────────────────────────

describe("cada agente ve solo sus llamadas abiertas", () => {
  // Mismos dígitos de agente («111») y el mismo motor: solo el propósito separa.
  const pedido = {
    id: "pedido",
    store_id: "s1",
    order_id: "o1",
    lead_id: null,
    purpose: "order",
    mode: "real",
    agent_number: "1-11#elevenlabs",
    phone: "930000001",
    provider: "elevenlabs",
    status: "dialing",
    dialed_at: NOW.toISOString(),
    started_at: null,
  };
  const lead = { ...pedido, id: "lead", order_id: null, lead_id: "L1", purpose: "lead", agent_number: "1-11#leads", phone: "930000002" };

  it("sin el filtro, el inicio de Reproprovincia no sabría cuál es la suya", () => {
    const raw = [pedido, lead] as unknown as OpenCall[];
    expect(pickOpenCall(callsForEngine(raw, "elevenlabs"), "dialing", { now: NOW, agentNumber: "1-11" })).toEqual({
      error: "ambigua",
    });
  });

  it("openCalls() es de pedidos por defecto, y trae el propósito", async () => {
    state.tables.voice_calls = [{ ...pedido }, { ...lead }];
    const open = await openCalls(state.admin as SupabaseClient);
    expect(open.map((c) => c.id)).toEqual(["pedido"]);
    const read = ops().find((o) => o.table === "voice_calls")!;
    expect(read.cols).toContain("purpose");
    expect(read.filters).toContainEqual({ op: "eq", col: "purpose", val: "order" });
    const picked = pickOpenCall(callsForEngine(open, "elevenlabs"), "dialing", { now: NOW, agentNumber: "1-11" });
    expect("call" in picked && picked.call.id).toBe("pedido");
    // Sin número de agente: la única abierta de pedidos, nunca la del lead.
    const solo = pickOpenCall(open, "dialing", { now: NOW });
    expect("call" in solo && solo.call.id).toBe("pedido");
  });

  it("con solo un lead abierto, las tools de Reproprovincia no encuentran nada", async () => {
    state.tables.voice_calls = [{ ...lead }];
    const open = await openCalls(state.admin as SupabaseClient);
    expect(pickOpenCall(open, "dialing", { now: NOW })).toEqual({ error: "ninguna" });
  });

  it("openCalls(admin, \"lead\") ve solo las de lead", async () => {
    state.tables.voice_calls = [{ ...pedido }, { ...lead }];
    const open = await openCalls(state.admin as SupabaseClient, "lead");
    expect(open.map((c) => c.id)).toEqual(["lead"]);
    expect(open[0]?.purpose).toBe("lead");
  });

  it("loadCall no devuelve una fila de lead: todo lo que cuelga de ella escribe sobre un pedido", async () => {
    state.tables.voice_calls = [{ ...pedido }, { ...lead }];
    expect(await loadCall(state.admin as SupabaseClient, "lead")).toBeNull();
    expect((await loadCall(state.admin as SupabaseClient, "pedido"))?.order_id).toBe("o1");
  });
});

// ── El vigilante y el cierre ─────────────────────────────────────────────────

describe("el «no contesta» de un lead nunca toca un pedido", () => {
  const base = { store_id: "s1", mode: "real", agent_number: "x", phone: "930000001", provider: "elevenlabs" };

  it("el barrido cierra las de los dos, cada una por su lado y con su ventana", async () => {
    state.tables.voice_calls = [
      { ...base, id: "pedido-colgado", order_id: "o1", lead_id: null, purpose: "order", status: "in_progress", dialed_at: hace(8), started_at: hace(6) },
      { ...base, id: "lead-hablando", order_id: null, lead_id: "L1", purpose: "lead", status: "in_progress", dialed_at: hace(8), started_at: hace(6) },
      { ...base, id: "lead-sin-contestar", order_id: null, lead_id: "L2", purpose: "lead", status: "dialing", dialed_at: hace(4), started_at: null },
    ];
    await sweepStaleCalls(state.admin as SupabaseClient, NOW);

    const read = ops().find((o) => o.kind === "select" && o.table === "voice_calls")!;
    expect(read.cols).toContain("purpose");
    expect(read.cols).toContain("lead_id");
    // Sin filtro de propósito: una fila de lead colgada también ocupa su carril.
    expect(read.filters.some((f) => f.col === "purpose")).toBe(false);

    const status = Object.fromEntries(state.tables.voice_calls.map((r) => [r.id, r.status]));
    expect(status).toEqual({
      "pedido-colgado": "completed",
      "lead-hablando": "in_progress",
      "lead-sin-contestar": "completed",
    });
    // El pedido, por la v2; el lead, por su nota. Ni uno por el camino del otro.
    expect(state.rpcs.map((r) => (r.args as { p_order_id: string }).p_order_id)).toEqual(["o1"]);
    expect(state.recompute).toHaveBeenCalledTimes(1);
    expect(state.recompute.mock.calls[0]?.[1]).toEqual(["o1"]);
    expect(state.leadNoAnswer).toHaveBeenCalledTimes(1);
    expect(state.leadNoAnswer.mock.calls[0]?.[1]).toEqual({ id: "lead-sin-contestar", store_id: "s1", lead_id: "L2", mode: "real" });
    expect(state.leadNoAnswer.mock.calls[0]?.[2]).toBe("No contestó: la llamada no llegó al agente.");
    // Nunca la marca `failed` de «El pedido no pertenece a la tienda indicada.»
    expect(state.tables.voice_calls.find((r) => r.id === "lead-sin-contestar")?.outcome).toBe("no_contesta");
  });

  it("una fila sin pedido es de lead aunque no diga su propósito", async () => {
    state.tables.voice_calls = [{ ...base, id: "c", order_id: null, lead_id: "L1", status: "dialing" }];
    await closeAsNoAnswer(
      state.admin as SupabaseClient,
      { id: "c", status: "dialing", store_id: "s1", order_id: null, lead_id: "L1", mode: "real" },
      "No contestó.",
      NOW,
    );
    expect(state.rpcs).toEqual([]);
    expect(state.recompute).not.toHaveBeenCalled();
    expect(state.leadNoAnswer).toHaveBeenCalledTimes(1);
  });

  it("en prueba no se escribe nada, como en pedidos", async () => {
    state.tables.voice_calls = [{ ...base, id: "c", order_id: null, lead_id: "L1", purpose: "lead", mode: "test", status: "dialing" }];
    await closeAsNoAnswer(
      state.admin as SupabaseClient,
      { id: "c", status: "dialing", store_id: "s1", order_id: null, lead_id: "L1", purpose: "lead", mode: "test" },
      "No contestó.",
      NOW,
    );
    expect(state.tables.voice_calls[0]?.status).toBe("completed");
    expect(state.leadNoAnswer).not.toHaveBeenCalled();
    expect(state.rpcs).toEqual([]);
  });

  it("si la nota del lead falla, el barrido de Reproprovincia sigue", async () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    state.leadNoAnswer.mockRejectedValueOnce(new Error("boom"));
    state.tables.voice_calls = [
      { ...base, id: "lead", order_id: null, lead_id: "L1", purpose: "lead", status: "dialing", dialed_at: hace(4), started_at: null },
      { ...base, id: "pedido", order_id: "o1", lead_id: null, purpose: "order", status: "dialing", dialed_at: hace(4), started_at: null },
    ];
    await expect(sweepStaleCalls(state.admin as SupabaseClient, NOW)).resolves.toBeUndefined();
    expect(state.rpcs).toHaveLength(1);
    expect(String(quiet.mock.calls[0]?.[0])).toContain("(llamada lead)");
    quiet.mockRestore();
  });
});

describe("el vigilante no pisa lo que el agente de leads ya registró (MOM §33.6)", () => {
  // `registrar_resultado_lead` reserva la fila (`outcome` vacío → el
  // resultado) y escribe sobre el lead ANTES de cerrarla. Si ese cierre no
  // llega, la fila sigue `in_progress` con su resultado y el vigilante la ve.
  const base = { store_id: "s1", mode: "real", agent_number: "x", phone: "930000001", provider: "elevenlabs" };
  const OPEN = ["queued", "dialing", "in_progress"];
  const fila = (id: string) => state.tables.voice_calls!.find((r) => r.id === id)!;
  const cierreDe = (id: string) =>
    ops().filter((o) => o.kind === "update" && o.filters.some((f) => f.col === "id" && f.val === id));

  it("una fila de lead ya reservada se cierra completed con SU resultado, sin nota «No contestó»", async () => {
    const payload = { resultado: "atender_ahora", captura: { direccion: "Jr. Los Pinos 123" } };
    state.tables.voice_calls = [
      {
        ...base,
        id: "lead-registrado",
        order_id: null,
        lead_id: "L1",
        purpose: "lead",
        status: "in_progress",
        outcome: "atender_ahora",
        outcome_payload: payload,
        error: null,
        dialed_at: hace(10),
        started_at: hace(9),
      },
      // Mismo vigilante, misma pasada: la que nadie registró sigue siendo «no contestó».
      { ...base, id: "lead-sin-gestion", order_id: null, lead_id: "L2", purpose: "lead", status: "in_progress", outcome: null, dialed_at: hace(10), started_at: hace(9) },
    ];
    await sweepStaleCalls(state.admin as SupabaseClient, NOW);

    const read = ops().find((o) => o.kind === "select" && o.table === "voice_calls")!;
    expect(read.cols).toContain("outcome");

    expect(fila("lead-registrado")).toMatchObject({
      status: "completed",
      outcome: "atender_ahora",
      outcome_payload: payload,
      ended_at: NOW.toISOString(),
    });
    expect(String(fila("lead-registrado").error)).toContain("registrada");
    expect(String(fila("lead-registrado").error)).not.toContain("sin registrar_gestion");

    // Un solo cierre, que no toca el resultado ni lo que guardó la tool, y solo
    // si la fila seguía abierta.
    const [cierre, ...otros] = cierreDe("lead-registrado");
    expect(otros).toEqual([]);
    expect(cierre?.patch).not.toHaveProperty("outcome");
    expect(cierre?.patch).not.toHaveProperty("outcome_payload");
    expect(cierre?.filters).toContainEqual({ op: "in", col: "status", val: OPEN });

    // La nota «No contestó» va solo al lead que de verdad no tuvo gestión.
    expect(state.leadNoAnswer).toHaveBeenCalledTimes(1);
    expect(state.leadNoAnswer.mock.calls[0]?.[1]).toMatchObject({ id: "lead-sin-gestion", lead_id: "L2" });
    expect(state.leadNoAnswer.mock.calls[0]?.[2]).toBe(
      "No contestó: la llamada llegó al agente pero se cortó sin gestión (buzón o cuelgue).",
    );
    expect(fila("lead-sin-gestion")).toMatchObject({
      status: "completed",
      outcome: "no_contesta",
      error: "sin registrar_gestion dentro de la ventana",
    });
    // Ni la v2 ni el Master: son filas de lead.
    expect(state.rpcs).toEqual([]);
    expect(state.recompute).not.toHaveBeenCalled();
  });

  it("vale para cualquier resultado reservado y también en prueba; una todavía en ventana no se toca", async () => {
    state.tables.voice_calls = [
      { ...base, id: "no-llamar", order_id: null, lead_id: "L1", purpose: "lead", status: "in_progress", outcome: "no_llamar", dialed_at: hace(12), started_at: hace(10) },
      { ...base, id: "prueba", order_id: null, lead_id: "L2", purpose: "lead", mode: "test", status: "in_progress", outcome: "volver_a_llamar", dialed_at: hace(12), started_at: hace(10) },
      // Reservada sin que el inicio la pasara a «en curso»: sigue «marcando» pasada su ventana.
      { ...base, id: "marcando", order_id: null, lead_id: "L3", purpose: "lead", status: "dialing", outcome: "no_compra", dialed_at: hace(4), started_at: null },
      // Reservada hace poco: la tool todavía está escribiendo.
      { ...base, id: "en-ventana", order_id: null, lead_id: "L4", purpose: "lead", status: "in_progress", outcome: "atender_ahora", dialed_at: hace(7), started_at: hace(6) },
    ];
    await sweepStaleCalls(state.admin as SupabaseClient, NOW);

    expect(fila("no-llamar")).toMatchObject({ status: "completed", outcome: "no_llamar" });
    // Sin el cierre de la tool, lo mínimo: el resultado y la marca «no llamar»
    // (solo en real), para que la lista de la tienda la vea.
    expect(fila("no-llamar").outcome_payload).toEqual({ resultado: "no_llamar", no_llamar: true });
    expect(fila("prueba")).toMatchObject({ status: "completed", outcome: "volver_a_llamar" });
    expect(fila("prueba").outcome_payload).toEqual({ resultado: "volver_a_llamar", no_llamar: false });
    expect(fila("marcando")).toMatchObject({ status: "completed", outcome: "no_compra" });
    expect(fila("en-ventana")).toMatchObject({ status: "in_progress", outcome: "atender_ahora" });
    expect(fila("en-ventana")).not.toHaveProperty("ended_at");
    expect(cierreDe("en-ventana")).toEqual([]);
    expect(state.leadNoAnswer).not.toHaveBeenCalled();
    expect(state.rpcs).toEqual([]);
  });

  it("si el cierre del registro llega justo antes, el vigilante no lo pisa", async () => {
    state.tables.voice_calls = [
      { ...base, id: "lead", order_id: null, lead_id: "L1", purpose: "lead", status: "in_progress", outcome: "atender_ahora", error: null, dialed_at: hace(10), started_at: hace(9) },
    ];
    const cierreDelRegistro = { status: "completed", outcome_payload: { resultado: "atender_ahora" }, ended_at: hace(0.5), error: null };
    // Entre la lectura del vigilante y su `update`, el registro cierra la fila.
    const inner = fakeAdmin();
    const admin = {
      from(table: string) {
        const q = (inner as unknown as { from: (t: string) => Record<string, (...a: unknown[]) => unknown> }).from(table);
        const update = q.update!;
        q.update = (patch: unknown) => {
          Object.assign(fila("lead"), cierreDelRegistro);
          return update(patch);
        };
        return q;
      },
      rpc: (inner as unknown as { rpc: unknown }).rpc,
    } as unknown as SupabaseClient;

    await sweepStaleCalls(admin, NOW);

    expect(fila("lead")).toMatchObject({ ...cierreDelRegistro, outcome: "atender_ahora" });
    expect(cierreDe("lead")).toHaveLength(1);
    expect(state.leadNoAnswer).not.toHaveBeenCalled();
  });

  it("solo las de lead: una de pedido tomada y vencida sigue cerrándose «no contesta» por la v2 (§11.8)", async () => {
    state.tables.voice_calls = [
      { ...base, id: "pedido", order_id: "o1", lead_id: null, purpose: "order", status: "in_progress", outcome: "confirma", dialed_at: hace(8), started_at: hace(6) },
    ];
    await sweepStaleCalls(state.admin as SupabaseClient, NOW);
    expect(fila("pedido")).toMatchObject({ status: "completed", outcome: "no_contesta" });
    expect(state.rpcs.map((r) => (r.args as { p_order_id: string }).p_order_id)).toEqual(["o1"]);
    expect(state.leadNoAnswer).not.toHaveBeenCalled();
  });
});

// ── Topes, salida Swayp y «no llamar» ───────────────────────────────────────

describe("cada agente con su tope; la salida Swayp solo de pedidos", () => {
  it("realCallsToday cuenta un solo propósito, pedido por defecto", async () => {
    const today = NOW.toISOString();
    state.tables.voice_calls = [
      { id: "a", store_id: "s1", mode: "real", purpose: "order", status: "completed", queued_at: today },
      { id: "b", store_id: "s1", mode: "real", purpose: "lead", status: "completed", queued_at: today },
      { id: "c", store_id: "s1", mode: "real", purpose: "lead", status: "completed", queued_at: today },
      { id: "d", store_id: "s1", mode: "test", purpose: "lead", status: "completed", queued_at: today },
    ];
    expect(await realCallsToday(state.admin as SupabaseClient, "s1", NOW)).toBe(1);
    expect(await realCallsToday(state.admin as SupabaseClient, "s1", NOW, "lead")).toBe(2);
  });

  it("el tope de leads no cuenta las que Telnyx rechazó antes de marcar (cancelled), sí las que sonaron", async () => {
    // NOW es 11:00 de Lima: el día empieza a las 05:00 UTC.
    const lead = (id: string, status: string, queued_at = NOW.toISOString(), o: Row = {}) => ({
      id,
      store_id: "s1",
      mode: "real",
      purpose: "lead",
      status,
      queued_at,
      ...o,
    });
    state.tables.voice_calls = [
      lead("rechazada-1", "cancelled"),
      lead("rechazada-2", "cancelled"),
      lead("rechazada-3", "cancelled"),
      lead("contesto", "completed"),
      // Telnyx no respondió a tiempo: pudo sonar, gasta cupo.
      lead("sin-respuesta", "failed"),
      lead("marcando", "dialing"),
      lead("hablando", "in_progress"),
      lead("en-cola", "queued"),
      lead("medianoche", "completed", "2026-10-12T05:00:00.000Z"),
      // Ayer en Lima (23:59), aunque ya sea 12 en UTC.
      lead("ayer", "completed", "2026-10-12T04:59:00.000Z"),
      lead("prueba", "completed", NOW.toISOString(), { mode: "test" }),
      lead("otra-tienda", "completed", NOW.toISOString(), { store_id: "s2" }),
      { id: "pedido", store_id: "s1", mode: "real", purpose: "order", status: "completed", queued_at: NOW.toISOString() },
    ];
    expect(await realCallsToday(state.admin as SupabaseClient, "s1", NOW, "lead")).toBe(6);

    const leadRead = ops().find((o) => o.filters.some((f) => f.col === "purpose" && f.val === "lead"))!;
    await realCallsToday(state.admin as SupabaseClient, "s1", NOW);
    const orderRead = ops()[ops().length - 1]!;
    expect(leadRead.head).toBe(true);
    expect(leadRead.filters).toContainEqual({ op: "neq", col: "status", val: "cancelled" });
    expect(leadRead.filters).toContainEqual({ op: "eq", col: "mode", val: "real" });
    expect(leadRead.filters).toContainEqual({ op: "gte", col: "queued_at", val: "2026-10-12T05:00:00.000Z" });
    // El de pedidos no lleva el filtro: el cambio es solo del carril de leads.
    expect(orderRead.filters).toContainEqual({ op: "eq", col: "purpose", val: "order" });
    expect(orderRead.filters.some((f) => f.col === "status")).toBe(false);
  });

  it("un día de Telnyx caído no se come el tope: con solo rechazos, el cupo sigue en 0", async () => {
    state.tables.voice_calls = Array.from({ length: 40 }, (_, i) => ({
      id: `r${i}`,
      store_id: "s1",
      mode: "real",
      purpose: "lead",
      status: "cancelled",
      queued_at: hace(i),
    }));
    expect(await realCallsToday(state.admin as SupabaseClient, "s1", NOW, "lead")).toBe(0);
  });

  it("realCallsToday sin poder leer devuelve null y lo avisa: ni 0 (llamaría sin tope) ni «tope lleno»", async () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    const llamados: string[] = [];
    const roto = {
      from: () => {
        const q: Record<string, unknown> = {};
        for (const m of ["select", "eq", "neq", "gte"]) {
          q[m] = () => {
            llamados.push(m);
            return q;
          };
        }
        q.then = (ok: (v: unknown) => unknown) => Promise.resolve({ count: null, error: { message: "caída" } }).then(ok);
        return q;
      },
    };
    expect(await realCallsToday(roto as unknown as SupabaseClient, "s1", NOW, "lead")).toBeNull();
    expect(llamados).toContain("neq");
    expect(await realCallsToday(roto as unknown as SupabaseClient, "s1", NOW)).toBeNull();
    const avisos = quiet.mock.calls.map((c) => String(c[0]));
    expect(avisos).toEqual([
      "[voice] tope diario sin leer (lead): caída",
      "[voice] tope diario sin leer (order): caída",
    ]);
    quiet.mockRestore();
  });

  it("una cuenta sin error y sin número es 0, no null", async () => {
    const vacio = {
      from: () => {
        const q: Record<string, unknown> = {};
        for (const m of ["select", "eq", "neq", "gte"]) q[m] = () => q;
        q.then = (ok: (v: unknown) => unknown) => Promise.resolve({ count: null, error: null }).then(ok);
        return q;
      },
    };
    expect(await realCallsToday(vacio as unknown as SupabaseClient, "s1", NOW, "lead")).toBe(0);
    expect(await realCallsToday(vacio as unknown as SupabaseClient, "s1", NOW)).toBe(0);
  });

  it("una fila de lead nunca pide salida Swayp, aunque traiga la marca", async () => {
    state.tables.voice_calls = [
      {
        id: "lead",
        store_id: "s1",
        order_id: null,
        purpose: "lead",
        mode: "real",
        status: "completed",
        outcome: "confirma",
        queued_at: NOW.toISOString(),
        outcome_payload: { resultado: "confirmado", fecha: "2026-10-13" },
      },
    ];
    expect(await salidasSwaypPendientes(state.admin as SupabaseClient, NOW)).toEqual([]);
    expect(ops()[0]?.filters).toContainEqual({ op: "eq", col: "purpose", val: "order" });
  });

  it("la lista «no llamar» es por tienda y teléfono, de los dos agentes a propósito", async () => {
    state.tables.voice_calls = [
      { id: "1", store_id: "s1", purpose: "order", phone: "+51 930 000 001", outcome_payload: { no_llamar: true } },
      { id: "2", store_id: "s1", purpose: "lead", phone: "51930000002", outcome_payload: { no_llamar: true } },
      { id: "3", store_id: "s1", purpose: "lead", phone: "930000003", outcome_payload: { no_llamar: false } },
      { id: "4", store_id: "s2", purpose: "lead", phone: "930000004", outcome_payload: { no_llamar: true } },
    ];
    const dnc = await loadDoNotCallPhones(state.admin as SupabaseClient, "s1");
    expect([...dnc].sort()).toEqual(["930000001", "930000002"]);
    expect(ops()[0]?.filters.some((f) => f.col === "purpose")).toBe(false);
  });

  it("si la lista «no llamar» no se puede leer, la cola no sale (no se llama a quien pidió que no)", async () => {
    const broken = {
      from: () => {
        const q: Record<string, unknown> = {};
        for (const m of ["select", "eq", "order"]) q[m] = () => q;
        q.range = () => Promise.resolve({ data: null, error: { message: "caída" } });
        return q;
      },
    } as unknown as SupabaseClient;
    await expect(loadDoNotCallPhones(broken, "s1")).rejects.toThrow("caída");
  });
});

// ── El aviso de Telnyx: a qué agente va el tramo ────────────────────────────

describe("webhook de Telnyx con una llamada de lead", () => {
  const keys = generateKeyPairSync("ed25519");
  const der = keys.publicKey.export({ format: "der", type: "spki" });
  const publicB64 = Buffer.from(der.subarray(der.length - 32)).toString("base64");
  const posts: { url: string; body: Row }[] = [];

  function signed(event: Row): Request {
    const raw = JSON.stringify({ data: event });
    const ts = String(Math.floor(Date.now() / 1000));
    const signature = sign(null, Buffer.from(`${ts}|${raw}`, "utf8"), keys.privateKey).toString("base64");
    return new Request("https://kapta.test/api/webhooks/telnyx", {
      method: "POST",
      headers: { "telnyx-signature-ed25519": signature, "telnyx-timestamp": ts, "content-type": "application/json" },
      body: raw,
    });
  }
  const answered = (vc: string) =>
    signed({
      event_type: "call.answered",
      occurred_at: new Date().toISOString(),
      payload: { call_control_id: "cliente-ccid", client_state: encodeClientState({ vc, leg: "cliente" }) },
    });
  const row = (o: Row) => ({
    store_id: "s1",
    mode: "real",
    status: "dialing",
    telephony: "telnyx",
    provider: "elevenlabs",
    telephony_response: { cliente: "cliente-ccid", eventos: [] },
    updated_at: "2026-10-12T15:59:00Z",
    ...o,
  });

  beforeEach(() => {
    posts.length = 0;
    vi.stubEnv("TELNYX_PUBLIC_KEY", publicB64);
    vi.stubEnv("TELNYX_API_KEY", "k");
    vi.stubEnv("TELNYX_CONNECTION_ID", "conn-1");
    vi.stubEnv("TELNYX_FROM_NUMBER", "+19180000000");
    vi.stubEnv("TELNYX_XAI_SIP_URI", "sip:xai");
    vi.stubEnv("TELNYX_ELEVENLABS_SIP_URI", "sip:repro-elevenlabs");
    vi.stubEnv("TELNYX_LEADS_SIP_URI", "sip:leads-elevenlabs");
    vi.stubEnv("TELNYX_LEADS_FROM_NUMBER", "+5117000000");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: { body: string }) => {
        posts.push({ url, body: JSON.parse(init.body) as Row });
        return new Response(JSON.stringify({ data: { call_control_id: "agente-ccid" } }), { status: 200 });
      }),
    );
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("el tramo al agente de un lead va a la puerta del agente de leads, con el número que ve el lead", async () => {
    state.tables.voice_calls = [row({ id: "lead", order_id: null, lead_id: "L1", purpose: "lead" })];
    const res = await telnyxWebhook(answered("lead") as never);
    expect(await res.json()).toMatchObject({ action: "agente_marcado" });
    const dial = posts.find((p) => p.url.endsWith("/calls"))!;
    expect(dial.body).toMatchObject({ to: "sip:leads-elevenlabs", from: "+5117000000", link_to: "cliente-ccid" });
    expect(posts.some((p) => p.body.to === "sip:repro-elevenlabs")).toBe(false);
  });

  it("una de pedido sigue yendo al agente de Reproprovincia, con su número", async () => {
    state.tables.voice_calls = [row({ id: "pedido", order_id: "o1", lead_id: null, purpose: "order" })];
    await telnyxWebhook(answered("pedido") as never);
    const dial = posts.find((p) => p.url.endsWith("/calls"))!;
    expect(dial.body).toMatchObject({ to: "sip:repro-elevenlabs", from: "+19180000000" });
  });

  it("sin la puerta del agente de leads, la llamada falla: nunca cae al de Reproprovincia", async () => {
    vi.stubEnv("TELNYX_LEADS_SIP_URI", "");
    state.tables.voice_calls = [row({ id: "lead", order_id: null, lead_id: "L1", purpose: "lead" })];
    const res = await telnyxWebhook(answered("lead") as never);
    expect(await res.json()).toMatchObject({ action: "agente_no_conecta" });
    expect(posts.some((p) => p.url.endsWith("/calls"))).toBe(false);
    expect(posts.some((p) => p.url.includes("/calls/cliente-ccid/actions/hangup"))).toBe(true);
    const fila = state.tables.voice_calls[0]!;
    expect(fila.status).toBe("failed");
    expect(String(fila.error)).toContain("falta TELNYX_LEADS_SIP_URI");
  });

  it("si el lead no contesta, se cierra al momento con una nota del lead, sin la v2", async () => {
    state.tables.voice_calls = [row({ id: "lead", order_id: null, lead_id: "L1", purpose: "lead" })];
    const hangup = signed({
      event_type: "call.hangup",
      occurred_at: new Date().toISOString(),
      payload: { call_control_id: "cliente-ccid", client_state: encodeClientState({ vc: "lead", leg: "cliente" }), hangup_cause: "timeout" },
    });
    await telnyxWebhook(hangup as never);
    expect(state.tables.voice_calls[0]).toMatchObject({ status: "completed", outcome: "no_contesta" });
    expect(state.leadNoAnswer).toHaveBeenCalledTimes(1);
    expect(state.leadNoAnswer.mock.calls[0]?.[1]).toMatchObject({ id: "lead", lead_id: "L1", mode: "real" });
    expect(state.rpcs).toEqual([]);
    expect(state.recompute).not.toHaveBeenCalled();
  });
});

// ── Guardas de texto fuente ──────────────────────────────────────────────────

describe("guardas del aislamiento (código)", () => {
  const read = (p: string) => readFileSync(resolve(__dirname, "..", p), "utf8");
  const server = read("lib/voice-recovery-server.ts");
  const route = read("app/api/webhooks/telnyx/route.ts");
  const access = read("lib/shipments-access.ts");
  const fn = (src: string, head: string) => {
    const from = src.slice(src.indexOf(head));
    return from.slice(0, from.indexOf("\n}\n"));
  };

  it("las tools, el inicio y el barrido de Reproprovincia siguen llamando a openCalls sin propósito (= pedidos)", () => {
    for (const p of [
      "app/api/voice/tools/identificar_llamada/route.ts",
      "app/api/voice/tools/registrar_gestion/route.ts",
      "app/api/voice/elevenlabs/inicio/route.ts",
      "app/api/cron/voice-recovery/route.ts",
    ]) {
      const src = read(p);
      expect(src).toContain("await openCalls(admin)");
      expect(src).not.toContain('openCalls(admin, "lead")');
    }
    const open = fn(server, "export async function openCalls(");
    expect(open).toContain('purpose: "order" | "lead" = "order"');
    expect(open).toContain('.eq("purpose", purpose)');
  });

  it("el cierre manda el lead a su nota ANTES de la v2, y después del candado de una sola vez", () => {
    const close = fn(server, "export async function closeAsNoAnswer(");
    const guard = close.indexOf("if (!r.registerNoAnswer || !closed?.length) return;");
    const branch = close.indexOf('if (c.purpose === "lead" || c.order_id == null) {');
    expect(guard).toBeGreaterThan(-1);
    expect(branch).toBeGreaterThan(guard);
    expect(branch).toBeLessThan(close.indexOf("writeLeadNoAnswer("));
    expect(close.indexOf("writeLeadNoAnswer(")).toBeLessThan(close.indexOf("translateGestion("));
    expect(close.indexOf("writeLeadNoAnswer(")).toBeLessThan(close.indexOf("writeVoiceAttempt("));
    expect(close).toContain('if (opts.soloSinGestion) close = close.is("outcome", null);');
    expect(server).toContain('import { writeLeadNoAnswer } from "@/lib/voice-leads-writeback";');
  });

  it("el barrido lee propósito y lead de todas las abiertas", () => {
    const sweep = fn(server, "export async function sweepStaleCalls(");
    expect(sweep).toContain("lead_id, purpose");
    expect(sweep).not.toContain('.eq("purpose"');
  });

  it("el barrido lee el resultado y cierra la fila de lead ya registrada ANTES del «no contesta»", () => {
    const sweep = fn(server, "export async function sweepStaleCalls(");
    expect(sweep).toContain("status, outcome, outcome_payload, dialed_at");
    const branch = sweep.indexOf('if (c.purpose === "lead" && c.outcome) {');
    expect(branch).toBeGreaterThan(-1);
    expect(branch).toBeLessThan(sweep.indexOf("await closeAsNoAnswer(admin, c, resumen, now);"));
    const body = sweep.slice(branch, sweep.indexOf("continue;", branch));
    expect(body).toContain('status: "completed"');
    expect(body).toContain(".in(\"status\", OPEN_STATUSES");
    expect(body).not.toContain("outcome:");
    expect(body).not.toContain("writeLeadNoAnswer");
  });

  it("tope diario, fila de pedido y salida Swayp: solo pedidos", () => {
    expect(fn(server, "export async function realCallsToday(")).toContain('.eq("purpose", purpose)');
    expect(fn(server, "export async function loadCall(")).toContain('.eq("purpose", "order")');
    expect(fn(server, "export async function salidasSwaypPendientes(")).toContain('.eq("purpose", "order")');
  });

  it("realCallsToday: null al fallar (nunca infinito ni 0) y, en leads, sin las rechazadas", () => {
    const today = fn(server, "export async function realCallsToday(");
    expect(today).toContain("Promise<number | null>");
    expect(today).toContain('if (purpose === "lead") q = q.neq("status", "cancelled");');
    expect(today).toContain("return null;");
    expect(today).not.toContain("POSITIVE_INFINITY");
    expect(today).not.toContain("Infinity");
  });

  it("quien lee el tope trata null como error, nunca como «tope del día»", () => {
    // Todos los que llaman a realCallsToday, para que uno nuevo no se cuele sin la guarda.
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
        d.isDirectory() ? walk(join(dir, d.name)) : /\.tsx?$/.test(d.name) ? [join(dir, d.name)] : [],
      );
    const root = resolve(__dirname, "..");
    const callers = ["app", "lib"]
      .flatMap((d) => walk(join(root, d)))
      .filter((p) => /\brealCallsToday\(/.test(readFileSync(p, "utf8").replace("export async function realCallsToday(", "")))
      .map((p) => relative(root, p).split("\\").join("/"))
      .sort();
    expect(callers).toEqual([
      "app/api/cron/voice-leads/route.ts",
      "app/api/cron/voice-recovery/route.ts",
      "app/dashboard/pedidos/actions.ts",
    ]);

    const cron = (p: string, call: string) => {
      const src = read(p);
      const at = src.indexOf(`const used = await ${call};`);
      expect(at).toBeGreaterThan(-1);
      const guard = src.indexOf("if (used === null) {", at);
      const tope = src.indexOf('report.action = "tope_diario";', at);
      expect(guard).toBeGreaterThan(at);
      expect(guard).toBeLessThan(tope);
      const block = src.slice(guard, src.indexOf("continue;", guard));
      expect(block).toContain('report.action = "error";');
      expect(block).toContain('report.error = "No se pudo leer el tope del día');
      // Nada de restar o comparar el resultado sin mirar antes si es null.
      expect(src).not.toMatch(/- \(await realCallsToday\(/);
      expect(src).not.toMatch(/\(await realCallsToday\([^)]*\)\) >=/);
    };
    cron("app/api/cron/voice-recovery/route.ts", "realCallsToday(admin, store.id, now)");
    cron("app/api/cron/voice-leads/route.ts", 'realCallsToday(admin, store.id, now, "lead")');

    const llamar = fn(read("app/dashboard/pedidos/actions.ts"), "export async function llamarConAgente(");
    const nulo = llamar.indexOf(
      'if (used === null) return { error: "No se pudo leer el tope de llamadas de hoy. Intenta de nuevo." };',
    );
    expect(llamar).toContain("const used = await realCallsToday(admin, store.id, now);");
    expect(nulo).toBeGreaterThan(llamar.indexOf("const used = await realCallsToday("));
    expect(nulo).toBeLessThan(llamar.indexOf("if (used >= store.voice_recovery_daily_cap) {"));
    expect(llamar).toContain('return { error: "La tienda ya llegó al tope de llamadas del agente de hoy." };');
  });

  it("la cola de Reproprovincia usa la lista «no llamar» compartida, sin filtro de propósito", () => {
    expect(fn(server, "export async function loadVoiceQueue(")).toContain("loadDoNotCallPhones(admin, store.id)");
    const dnc = fn(server, "export async function loadDoNotCallPhones(");
    expect(dnc).toContain('.eq("outcome_payload->>no_llamar", "true")');
    expect(dnc).not.toContain("purpose");
  });

  it("el webhook de Telnyx lee el propósito y separa la puerta y el número del lead", () => {
    expect(route.match(/lead_id, purpose, mode, status, telephony, provider/g)).toHaveLength(2);
    expect(route).toContain('const lead = row.purpose === "lead" || row.order_id == null;');
    expect(route).toContain("? env.telnyxLeadsSipUri() || null");
    expect(route).toContain("fromNumber: env.telnyxLeadsFromNumber()");
    expect(route).toContain('"falta TELNYX_LEADS_SIP_URI"');
    expect(route).toContain("dialTelnyx(legCfg, agenteDialBody(legCfg,");
    // Los cortes siguen cerrándose al momento por los dos tramos.
    expect(route.match(/if \(row\.status === "in_progress"\) await closeCutWithoutGestion\(admin, asOpen\(row\), now\);/g)).toHaveLength(2);
  });

  it("Envíos (comparación, «Llamando ahora» y «Última») solo ve llamadas de pedido", () => {
    for (const head of [
      "export async function getVoiceScore(",
      "export async function getLiveVoiceCalls(",
      "export async function getVoiceLiveStatus(",
    ]) {
      const body = fn(access, head);
      expect(body).toContain('.eq("mode", "real")');
      expect(body).toContain('.eq("purpose", "order")');
    }
  });

  it("telnyxConfig lleva la puerta del agente de leads", () => {
    expect(fn(server, "export function telnyxConfig(")).toContain("leadsSipUri: env.telnyxLeadsSipUri()");
  });
});
