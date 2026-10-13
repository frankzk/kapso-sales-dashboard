// «Repro Lima»: la lista de la pantalla (lib/repro-lima-access.ts; MOM §9.5,
// §11.7). Con una base en memoria que corta cada respuesta en 1000 filas, como
// PostgREST: la última llamada, la sugerencia de cerrar, la línea del fallo de
// otro courier, el acuerdo para hoy que ya no alcanza y los cierres después de
// responder, que releen la etapa antes de cerrar.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/server", () => ({ after: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/lib/access", () => ({ getCurrentUser: async () => null, getAccessibleStores: async () => [] }));
vi.mock("@/lib/permissions-access", () => ({ getMasterPermissions: async () => ({ can: () => true }) }));
vi.mock("@/lib/agent-names", () => ({
  resolveAgentNames: async (ids: Iterable<string>) => Object.fromEntries([...ids].map((id) => [id, id.replace(/^u-/, "")])),
}));

import { loadReproLima, type ReproScope } from "@/lib/repro-lima-access";

type Row = Record<string, any>;

/** El tope de filas por respuesta de PostgREST (`db-max-rows`). */
const MAX_ROWS = 1000;

function fakeDb(seed: Record<string, Row[]>, opts: { onRead?: (table: string, from: number | null, db: Record<string, Row[]>) => void } = {}) {
  const db: Record<string, Row[]> = Object.fromEntries(Object.entries(seed).map(([t, rows]) => [t, rows.map((r) => ({ ...r }))]));
  const from = (table: string) => {
    const filters: Array<(row: Row) => boolean> = [];
    const orders: Array<{ col: string; asc: boolean }> = [];
    let op: "select" | "update" = "select";
    let value: any = null;
    let single = false;
    let range: [number, number] | null = null;
    const q: any = {};
    q.select = () => q;
    q.eq = (col: string, v: unknown) => { filters.push((r) => r[col] === v); return q; };
    q.neq = (col: string, v: unknown) => { filters.push((r) => r[col] !== v); return q; };
    q.in = (col: string, vs: unknown[]) => { filters.push((r) => vs.includes(r[col])); return q; };
    q.is = (col: string, v: unknown) => { filters.push((r) => (v === null ? r[col] == null : r[col] === v)); return q; };
    q.gt = (col: string, v: string) => { filters.push((r) => r[col] != null && r[col] > v); return q; };
    q.not = (col: string, operator: string, v: unknown) => { filters.push((r) => (operator === "is" && v === null ? r[col] != null : r[col] !== v)); return q; };
    q.order = (col: string, o?: { ascending?: boolean }) => { orders.push({ col, asc: o?.ascending !== false }); return q; };
    q.limit = () => q;
    q.range = (a: number, b: number) => { range = [a, b]; return q; };
    q.update = (v: any) => { op = "update"; value = v; return q; };
    const run = () => {
      const rows = (db[table] ??= []);
      const match = (r: Row) => filters.every((f) => f(r));
      if (op === "update") {
        const affected = rows.filter(match);
        for (const r of affected) Object.assign(r, value);
        return { data: affected, error: null };
      }
      let out = rows.filter(match);
      if (orders.length) {
        out = [...out].sort((a, b) => {
          for (const { col, asc } of orders) {
            const x = a[col] ?? "";
            const y = b[col] ?? "";
            if (x < y) return asc ? -1 : 1;
            if (x > y) return asc ? 1 : -1;
          }
          return 0;
        });
      }
      if (range) out = out.slice(range[0], range[1] + 1);
      out = out.slice(0, MAX_ROWS);
      opts.onRead?.(table, range?.[0] ?? null, db);
      return { data: single ? out[0] ?? null : out, error: null };
    };
    q.maybeSingle = q.single = async () => { single = true; return run(); };
    q.then = (resolve: (r: unknown) => unknown, reject: (e: unknown) => unknown) => Promise.resolve().then(run).then(resolve, reject);
    return q;
  };
  return { admin: { from, rpc: vi.fn(), auth: { admin: { getUserById: async () => ({ data: { user: null } }) } } } as never, db };
}

const scope: ReproScope = { userId: "u-me", storeIds: new Set(["s1"]) };

function orderRow(id: string, extra: Row = {}): Row {
  return {
    order_id: id, store_id: "s1", order_name: `#${id}`, customer_name: "Ana", customer_phone: "987654321",
    district: "Surco", region: "Lima", province: "Lima", order_total: 120, macro_since: "2026-10-10T20:00:00Z",
    macro_stage: "en_curso", macro_substage: "por_reprogramar_lima", operational_status: null, ...extra,
  };
}

function openCase(extra: Row = {}): Row {
  return {
    id: "case-1", store_id: "s1", order_id: "o1", episode_key: "s:stop-1|o:-", episode_at: "2026-10-10T20:00:00.000Z",
    opened_at: "2026-10-11T14:00:00Z", opened_by: "u-diana", claimed_by: null, claimed_until: null,
    call_count: 0, no_answer_count: 0, last_call_at: null, last_outcome: null, next_call_at: null,
    agreement_call_id: null, agreed_on: null, agreed_courier: null, changes: {}, box_action: null, box_location: null,
    decided_by: null, decided_at: null, materialized_at: null, materialized_on: null,
    closed_at: null, closed_by: null, close_reason: null, close_note: null, ...extra,
  };
}

/** KP o1: Roy no lo entregó el sáb 10/10 con su S01 (`stop-1`). */
function seed(over: { cases?: Row[]; calls?: Row[]; events?: Row[]; items?: Row[]; shipments?: Row[]; stops?: Row[] } = {}): Record<string, Row[]> {
  return {
    order_master: [orderRow("o1")],
    orders: [{ id: "o1", store_id: "s1", cancelled_at: null }],
    shipments: over.shipments ?? [{
      id: "sh1", order_id: "o1", store_id: "s1", courier: "propio", created_via: "grupo_gf_courier", delivery_status: "pendiente",
      custody_state: "empresa", custody_transferred_at: null, output_number: 1, output_code: "KP1-S01", guide_code: null,
      status_category: "pending", reported_status: null, swayp_state: null, returned_at: null, dispatched_at: "2026-10-10T14:00:00Z",
      updated_at: "2026-10-10T20:00:00Z", closed_at: null,
    }],
    delivery_stops: over.stops ?? [{
      id: "stop-1", order_id: "o1", shipment_id: "sh1", route_id: "r1", status: "no_entregado", outcome_reason: "no_contesta",
      note: null, photo_path: null, reported_at: "2026-10-10T20:00:00Z", requested_date: null, dispatch_manifest_id: "box-1",
    }],
    delivery_routes: [{ id: "r1", route_date: "2026-10-10", rider_id: "rd1" }],
    riders: [{ id: "rd1", full_name: "Roy" }],
    stores: [{ id: "s1", name: "Tienda", org_id: "org1" }],
    logistics_providers: [{ id: "p1", org_id: "org1", status: "active", same_day_cutoff: "12:00:00", code: "grupo-gf-courier" }],
    logistics_requests: [],
    gf_dispatch_programs: [],
    order_events: over.events ?? [],
    lima_repro_cases: over.cases ?? [openCase()],
    lima_repro_calls: over.calls ?? [],
    dispatch_manifest_items: over.items ?? [],
    dispatch_manifests: [{ id: "box-1", courier: "propio", route_date: "2026-10-10", rider_id: "rd1", driver_name: "Roy", state: "open", load_number: 1, delivery_route_id: "r1" }],
  };
}

/** Lun 12/10 a las 10:00 de Lima, antes del corte. */
const NOW = new Date("2026-10-12T15:00:00Z");

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

async function load(s: Record<string, Row[]>, now: Date = NOW, opts: Parameters<typeof fakeDb>[1] = {}) {
  const { admin, db } = fakeDb(s, opts);
  const tasks: Array<() => Promise<void>> = [];
  const data = await loadReproLima(admin, scope, now, { defer: (task) => tasks.push(task) });
  return { data, db, tasks };
}

describe("la última llamada (F11)", () => {
  it("con más de 1000 llamadas en el lote, la más reciente no se pierde", async () => {
    const calls: Row[] = Array.from({ length: 1000 }, (_, i) => ({
      id: `call-${String(i).padStart(4, "0")}`, case_id: "case-1", actor: "u-yohalis", outcome: "no_contesta", channel: "llamada",
      occurred_at: new Date(Date.parse("2026-10-05T13:00:00Z") + i * 60_000).toISOString(),
    }));
    calls.push({ id: "call-last", case_id: "case-1", actor: "u-daysi", outcome: "no_contesta", channel: "whatsapp", occurred_at: "2026-10-12T14:55:00.000Z" });
    const { data } = await load(seed({ cases: [openCase({ call_count: 1001, no_answer_count: 1001 })], calls }));
    expect(data.rows[0]!.lastCall).toEqual({ at: "2026-10-12T14:55:00.000Z", byName: "daysi", outcome: "no_contesta" });
  });
});

describe("«Sugerido: desarmar y cerrar» cuenta desde la recepción de ESTA caja (F9, F16)", () => {
  const noAnswer = openCase({ no_answer_count: 3, call_count: 3 });

  it("la caja sigue con Roy: una recepción de un episodio anterior no cuenta", async () => {
    const { data } = await load(seed({
      cases: [noAnswer],
      events: [{ id: "ev-0", order_id: "o1", shipment_id: "sh1", kind: "returned_to_office", occurred_at: "2026-09-29T15:00:00Z" }],
      items: [{ id: "item-1", shipment_id: "sh1", manifest_id: "box-1", removed_at: null, office_checked_at: null, pickup_checked_at: null }],
    }));
    const row = data.rows[0]!;
    expect(row.box).toMatchObject({ kind: "con_motorizado", riderName: "Roy" });
    expect(row.receivedAt).toBeNull();
    expect(row.dismantleSuggested).toBe(false);
  });

  it("recibida en oficina hace diez días, en este episodio: sí", async () => {
    const stops = [{
      id: "stop-1", order_id: "o1", shipment_id: "sh1", route_id: "r0", status: "no_entregado", outcome_reason: "no_contesta",
      note: null, photo_path: null, reported_at: "2026-10-01T20:00:00Z", requested_date: null, dispatch_manifest_id: "box-0",
    }];
    const s = seed({
      cases: [noAnswer],
      stops,
      events: [{ id: "ev-1", order_id: "o1", shipment_id: "sh1", kind: "returned_to_office", occurred_at: "2026-10-02T15:00:00Z" }],
    });
    s.delivery_routes!.push({ id: "r0", route_date: "2026-10-01", rider_id: "rd1" });
    const { data } = await load(s);
    const row = data.rows[0]!;
    expect(row.box).toMatchObject({ kind: "en_oficina", since: "2026-10-02T15:00:00Z" });
    expect(row.dismantleSuggested).toBe(true);
  });
});

describe("la línea del fallo de otro courier (F17)", () => {
  it("Swayp: dice el día en que salió, no un «no entregado el» de ese día", async () => {
    const swayp = {
      id: "sw1", order_id: "o1", store_id: "s1", courier: "fenix", created_via: "fenix", delivery_status: "en_ruta",
      custody_state: null, custody_transferred_at: null, output_number: 1, output_code: null, guide_code: "SW-1",
      status_category: null, reported_status: null, swayp_state: 9, returned_at: null, dispatched_at: "2026-10-10T14:00:00Z",
      updated_at: "2026-10-12T14:00:00Z", closed_at: null,
    };
    const { data } = await load(seed({ shipments: [swayp], stops: [], cases: [] }));
    // Devolución confirmada (9): no entregó. Su barrido reescribe `updated_at`.
    const row = data.rows[0]!;
    expect(row.failure?.text.startsWith("Salió el sáb 10/10 con Swayp · ")).toBe(true);
    // El orden de «Por decidir» conserva el ancla de la salida (como `macro_since`): el sábado es el último día de reparto.
    expect(row.rank).toBe(0);
  });
});

describe("un acuerdo con Grupo GF para hoy que ya no alcanza (E25, F5/F13)", () => {
  const today = openCase({
    agreement_call_id: "call-1", agreed_on: "2026-10-12", agreed_courier: "propio", box_action: "mantener",
    box_location: "con_motorizado", decided_by: "u-diana", decided_at: "2026-10-11T15:00:00Z",
  });
  const received = [{ id: "ev-1", order_id: "o1", shipment_id: "sh1", kind: "returned_to_office", occurred_at: "2026-10-12T19:00:00Z" }];

  it("antes del corte: «Programados», falta programarlo", async () => {
    const { data } = await load(seed({ cases: [today], events: received }));
    expect(data.rows[0]).toMatchObject({ list: "programados", state: { kind: "por_programar" } });
  });

  it("la caja llegó a las 14:00: «Por decidir», vencido, y dice que ya no alcanza hoy", async () => {
    const at14 = new Date("2026-10-12T19:00:00Z");
    vi.setSystemTime(at14);
    const { data } = await load(seed({ cases: [today], events: received }), at14);
    const row = data.rows[0]!;
    expect(row).toMatchObject({ list: "por_decidir", overdue: true, state: { kind: "acuerdo_vencido" } });
    expect(row.stateLabel).toBe("El acuerdo era para hoy (lun 12/10) y ya no alcanza: confírmalo de nuevo");
    expect(row.chips).toContainEqual({ key: "acuerdo_vencido", text: "Acuerdo vencido: era para hoy y ya no alcanza" });
  });
});

describe("los cierres después de responder releen la etapa (F10)", () => {
  it("un pedido que la lectura por páginas se saltó no se cierra; uno fuera de la etapa sí", async () => {
    // 501 pedidos en la etapa: dos páginas de 500. Al leer la primera, o000
    // sale de la etapa: la segunda página empieza un puesto más allá y o500,
    // que tiene su caso abierto, no viene.
    const ids = Array.from({ length: 501 }, (_, i) => `o${String(i).padStart(3, "0")}`);
    const s = seed({
      cases: [
        openCase({ id: "case-500", order_id: "o500", episode_key: "order:o500" }),
        openCase({ id: "case-x", order_id: "ox", episode_key: "order:ox" }),
      ],
      stops: [],
      shipments: [],
    });
    s.order_master = [...ids.map((id) => orderRow(id)), orderRow("ox", { macro_substage: "por_cerrar" })];
    s.orders = [...ids, "ox"].map((id) => ({ id, store_id: "s1", cancelled_at: null }));
    let moved = false;
    const { data, db, tasks } = await load(s, NOW, {
      onRead: (table, from, tables) => {
        if (table === "order_master" && from === 0 && !moved) {
          moved = true;
          tables.order_master!.find((row) => row.order_id === "o000")!.macro_substage = "por_cerrar";
        }
      },
    });
    expect(data.rows.some((row) => row.orderId === "o500")).toBe(false);
    expect(tasks).toHaveLength(1);
    await tasks[0]!();
    const byId = (id: string) => db.lima_repro_cases!.find((row) => row.id === id)!;
    expect(byId("case-500").closed_at).toBeNull();
    expect(byId("case-x")).toMatchObject({ close_reason: "fuera_de_etapa" });
    expect(byId("case-x").closed_at).toBeTruthy();
  });
});
