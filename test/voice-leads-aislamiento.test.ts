// El agente de leads (MOM §33) comparte `voice_calls`, la conexión de Telnyx y
// el vigilante con el agente de Reproprovincia (§11.8). Estas pruebas fijan que
// ninguno de los dos ve, cuenta, cierra ni puentea las llamadas del otro:
//   · la atadura (`openCalls` + `pickOpenCall`) y la fila (`loadCall`) son por
//     propósito;
//   · el vigilante cierra las de los dos, pero el «no contesta» de un lead es
//     una nota del lead, nunca la v2 del pedido;
//   · el tramo al agente de un lead va a SU puerta SIP con SU número;
//   · el tope diario, la salida Swayp y los tableros de Envíos son por pedido;
//   · la lista «no llamar» se comparte a propósito.

import { generateKeyPairSync, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

type Row = Record<string, unknown>;
type Filter = { op: "eq" | "in" | "is" | "gte" | "lt" | "not"; col: string; val: unknown };
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

// ── Topes, salida Swayp y «no llamar» ───────────────────────────────────────

describe("cada agente con su tope; la salida Swayp solo de pedidos", () => {
  it("realCallsToday cuenta un solo propósito, pedido por defecto", async () => {
    const today = NOW.toISOString();
    state.tables.voice_calls = [
      { id: "a", store_id: "s1", mode: "real", purpose: "order", queued_at: today },
      { id: "b", store_id: "s1", mode: "real", purpose: "lead", queued_at: today },
      { id: "c", store_id: "s1", mode: "real", purpose: "lead", queued_at: today },
      { id: "d", store_id: "s1", mode: "test", purpose: "lead", queued_at: today },
    ];
    expect(await realCallsToday(state.admin as SupabaseClient, "s1", NOW)).toBe(1);
    expect(await realCallsToday(state.admin as SupabaseClient, "s1", NOW, "lead")).toBe(2);
  });

  it("realCallsToday sin poder leer da el tope por lleno (antes devolvía 0 y no frenaba)", async () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    const roto = {
      from: () => {
        const q: Record<string, unknown> = {};
        for (const m of ["select", "eq", "gte"]) q[m] = () => q;
        q.then = (ok: (v: unknown) => unknown) => Promise.resolve({ count: null, error: { message: "caída" } }).then(ok);
        return q;
      },
    };
    expect(await realCallsToday(roto as unknown as SupabaseClient, "s1", NOW, "lead")).toBe(Number.POSITIVE_INFINITY);
    expect(await realCallsToday(roto as unknown as SupabaseClient, "s1", NOW)).toBe(Number.POSITIVE_INFINITY);
    quiet.mockRestore();
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

  it("tope diario, fila de pedido y salida Swayp: solo pedidos", () => {
    expect(fn(server, "export async function realCallsToday(")).toContain('.eq("purpose", purpose)');
    expect(fn(server, "export async function loadCall(")).toContain('.eq("purpose", "order")');
    expect(fn(server, "export async function salidasSwaypPendientes(")).toContain('.eq("purpose", "order")');
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
