// Almacén: «Reintentos por salir» en el servidor (lib/warehouse-retries-access.ts;
// MOM §9.5, entrega 1c). Con una base en memoria que anota cada consulta: la
// puerta (`warehouse.prepare` y tiendas) antes de leer nada, cada lectura
// acotada a las tiendas de quien mira, los filtros de fecha, los acuerdos que
// ya están en «Por armar» (su día: programa, caja de Grupo GF o acordado; y
// solo mientras su salida nueva sea la de ese intento), los lotes y el tope,
// el motor de Repro Lima sin cerrar casos, ninguna escritura ni RPC, y un
// fallo que nunca lanza.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const real = vi.hoisted(() => ({
  loadReproLima: null as null | typeof import("@/lib/repro-lima-access").loadReproLima,
  admin: null as unknown,
}));

vi.mock("next/server", () => ({ after: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: vi.fn(() => {
    throw new Error("NEXT_REDIRECT");
  }),
  unstable_rethrow: vi.fn((error: unknown) => {
    if (error instanceof Error && error.message === "NEXT_REDIRECT") throw error;
  }),
}));
vi.mock("@/lib/access", () => ({
  getCurrentUser: vi.fn(async () => ({ id: "u-almacen", email: null })),
  getAccessibleStores: vi.fn(async () => [{ id: "s1" }]),
}));
vi.mock("@/lib/permissions-access", () => ({
  getMasterPermissions: vi.fn(async () => ({ can: (permission: string) => permission === "warehouse.prepare" })),
}));
vi.mock("@/lib/agent-names", () => ({
  resolveAgentNames: async (ids: Iterable<string>) => Object.fromEntries([...ids].map((id) => [id, id.replace(/^u-/, "")])),
}));
vi.mock("@/lib/db", () => ({ createAdminSupabase: vi.fn(() => real.admin) }));
vi.mock("@/lib/repro-lima-access", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/repro-lima-access")>();
  real.loadReproLima = actual.loadReproLima;
  return { ...actual, loadReproLima: vi.fn(actual.loadReproLima) };
});

import { after } from "next/server";
import { getAccessibleStores, getCurrentUser } from "@/lib/access";
import { getMasterPermissions } from "@/lib/permissions-access";
import { createAdminSupabase } from "@/lib/db";
import { loadReproLima, REPRO_NO_STORES } from "@/lib/repro-lima-access";
import { getWarehouseRetries, WAREHOUSE_NO_PERMISSION, RETRY_CANDIDATES_MAX } from "@/lib/warehouse-retries-access";
import {
  HANDOFF_LINE_DESARMAR,
  HANDOFF_LINE_GF,
  RETRY_DEFAULT_CHIP,
  RETRY_ERROR,
  RETRY_NO_GF_PROGRAM,
  RETRY_OVERDUE,
  RETRY_UNCONFIRMED,
} from "@/lib/warehouse-retries";

type Row = Record<string, any>;
type Filter = [method: string, column: string, value: unknown];
interface Query {
  table: string;
  op: "select" | "update" | "insert" | "upsert" | "delete";
  columns: string | null;
  filters: Filter[];
}

/** El tope de filas por respuesta de PostgREST (`db-max-rows`). */
const MAX_ROWS = 1000;

/**
 * Una base en memoria que anota cada consulta al resolverse. `fail` hace que
 * esa consulta responda con error, como PostgREST.
 */
function fakeDb(seed: Record<string, Row[]>, opts: { fail?: (query: Query) => boolean } = {}) {
  const db: Record<string, Row[]> = Object.fromEntries(Object.entries(seed).map(([t, rows]) => [t, rows.map((r) => ({ ...r }))]));
  const queries: Query[] = [];
  const rpc = vi.fn(async () => ({ data: null, error: null }));
  const from = (table: string) => {
    const query: Query = { table, op: "select", columns: null, filters: [] };
    const tests: Array<(row: Row) => boolean> = [];
    const orders: Array<{ col: string; asc: boolean }> = [];
    let value: any = null;
    let single = false;
    let range: [number, number] | null = null;
    const q: any = {};
    const filter = (method: string, col: string, v: unknown, test: (row: Row) => boolean) => {
      query.filters.push([method, col, v]);
      tests.push(test);
      return q;
    };
    const cmp = (method: string, test: (a: string, b: string) => boolean) => (col: string, v: string) =>
      filter(method, col, v, (r) => r[col] != null && test(String(r[col]), String(v)));
    q.select = (columns?: string) => {
      if (query.op === "select") query.columns = columns ?? "*";
      return q;
    };
    q.eq = (col: string, v: unknown) => filter("eq", col, v, (r) => r[col] === v);
    q.neq = (col: string, v: unknown) => filter("neq", col, v, (r) => r[col] !== v);
    q.in = (col: string, vs: unknown[]) => filter("in", col, vs, (r) => vs.includes(r[col]));
    q.is = (col: string, v: unknown) => filter("is", col, v, (r) => (v === null ? r[col] == null : r[col] === v));
    q.not = (col: string, operator: string, v: unknown) =>
      filter("not", col, [operator, v], (r) => (operator === "is" && v === null ? r[col] != null : r[col] !== v));
    q.gt = cmp("gt", (a, b) => a > b);
    q.gte = cmp("gte", (a, b) => a >= b);
    q.lt = cmp("lt", (a, b) => a < b);
    q.lte = cmp("lte", (a, b) => a <= b);
    q.order = (col: string, o?: { ascending?: boolean }) => {
      orders.push({ col, asc: o?.ascending !== false });
      return q;
    };
    q.limit = () => q;
    q.range = (a: number, b: number) => {
      range = [a, b];
      return q;
    };
    for (const op of ["update", "insert", "upsert", "delete"] as const) {
      q[op] = (v?: unknown) => {
        query.op = op;
        value = v;
        return q;
      };
    }
    const run = () => {
      queries.push(query);
      if (opts.fail?.(query)) return { data: null, error: { message: `falló ${table}` } };
      const rows = (db[table] ??= []);
      const match = (r: Row) => tests.every((t) => t(r));
      if (query.op !== "select") {
        const affected = rows.filter(match);
        if (query.op === "update") for (const r of affected) Object.assign(r, value);
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
      return { data: single ? out[0] ?? null : out, error: null };
    };
    q.maybeSingle = q.single = async () => {
      single = true;
      return run();
    };
    q.then = (resolve: (r: unknown) => unknown, reject: (e: unknown) => unknown) => Promise.resolve().then(run).then(resolve, reject);
    return q;
  };
  const admin = { from, rpc, auth: { admin: { getUserById: async () => ({ data: { user: null } }) } } };
  return { admin, db, queries, rpc };
}

/** Mar 13/10 a las 10:00 de Lima, antes del corte. */
const NOW = new Date("2026-10-13T15:00:00Z");

function orderRow(id: string, extra: Row = {}): Row {
  return {
    order_id: id, store_id: "s1", order_name: `#${id}`, customer_name: "Ana", customer_phone: "987654321",
    district: "Surco", region: "Lima", province: "Lima", order_total: 120, macro_since: "2026-10-10T20:00:00Z",
    macro_stage: "en_curso", macro_substage: "por_reprogramar_lima", operational_status: null, ...extra,
  };
}

function shipment(id: string, orderId: string, extra: Row = {}): Row {
  return {
    id, order_id: orderId, store_id: "s1", courier: "propio", created_via: "grupo_gf_courier", delivery_status: "pendiente",
    custody_state: "empresa", custody_transferred_at: null, output_number: 1, output_code: `${orderId}-S01`, guide_code: null,
    status_category: "pending", reported_status: null, swayp_state: null, returned_at: null, dispatched_at: "2026-10-10T14:00:00Z",
    updated_at: "2026-10-10T20:00:00Z", closed_at: null, preparation_state: "listo_despacho", ready_at: "2026-10-09T15:00:00Z",
    created_at: "2026-10-09T14:00:00Z", address_updated_at: null, ...extra,
  };
}

function caseRow(id: string, orderId: string, extra: Row = {}): Row {
  return {
    id, store_id: "s1", order_id: orderId, episode_key: `order:${orderId}`, episode_at: "2026-10-10T20:00:00.000Z",
    opened_at: "2026-10-11T14:00:00Z", opened_by: "u-diana", claimed_by: null, claimed_until: null,
    call_count: 1, no_answer_count: 0, last_call_at: null, last_outcome: null, next_call_at: null,
    agreement_call_id: null, agreed_on: null, agreed_courier: null, changes: {}, box_action: null, box_location: null,
    decided_by: null, decided_at: null, materialized_at: null, materialized_on: null,
    closed_at: null, closed_by: null, close_reason: null, close_note: null, ...extra,
  };
}

const GF_REASON = "Programado por Despacho GF";
const RIDER_REASON = "Reprogramado por el cliente (reporte de la parada de Roy, 12/10)";

/**
 * El día 1 de producción, con lo que lo rodea:
 * - o1: caja propia de Grupo GF en oficina, programa vencido sin caso;
 * - o2: reintento de otro courier cuya caja todavía vuelve con Swayp;
 * - o3: fecha del motorizado (#908) con la caja en su caja;
 * - o4: programa viejo de un pedido que ya salió de la etapa;
 * - o8: acuerdo para mañana con Grupo GF, sin programa todavía;
 * - o5: acuerdo cuya salida nueva ya está en «Por armar»; o6 tiene un caso
 *   más nuevo; o7 ya no está en «Por armar»;
 * - z1: otra tienda, fuera del alcance.
 */
function daySeed(): Record<string, Row[]> {
  const ids = ["o1", "o2", "o3", "o4", "o5", "o6", "o7", "o8", "z1"];
  return {
    order_master: [
      orderRow("o1"),
      orderRow("o2", { operational_status: "pendiente_nuevo_courier" }),
      orderRow("o3"),
      orderRow("o4", { macro_stage: "en_curso", macro_substage: "por_cerrar" }),
      orderRow("o5", { macro_stage: "preparacion", macro_substage: "por_armar" }),
      orderRow("o6", { macro_stage: "preparacion", macro_substage: "por_armar" }),
      orderRow("o7", { macro_stage: "por_despachar", macro_substage: "por_asignar" }),
      orderRow("o8"),
      orderRow("z1", { store_id: "s2" }),
    ],
    orders: ids.map((id) => ({ id, store_id: id === "z1" ? "s2" : "s1", cancelled_at: null })),
    shipments: [
      shipment("sh1", "o1", { address_updated_at: "2026-10-11T20:00:00Z" }),
      shipment("sw2", "o2", {
        courier: "fenix", created_via: "fenix", delivery_status: "en_ruta", custody_state: null, output_code: null, guide_code: "SW-2",
        status_category: null, swayp_state: 9, updated_at: "2026-10-12T14:00:00Z",
      }),
      shipment("sh3", "o3"),
      shipment("sh4", "o4"),
      shipment("tx5", "o5", { courier: "tanders", output_code: "o5-S01", delivery_status: "no_entregado" }),
      shipment("sh5", "o5", { output_number: 2, output_code: "o5-S02", preparation_state: "rotulo_generado", ready_at: null, created_at: "2026-10-13T13:30:00Z" }),
      shipment("sh6", "o6", { output_number: 2, output_code: "o6-S02", created_at: "2026-10-13T13:30:00Z" }),
      shipment("sh7", "o7", { output_number: 2, output_code: "o7-S02", created_at: "2026-10-13T13:30:00Z" }),
      shipment("sh8", "o8"),
      shipment("shz", "z1", { store_id: "s2" }),
    ],
    delivery_stops: [
      { id: "stop-1", order_id: "o1", shipment_id: "sh1", route_id: "r1", status: "no_entregado", outcome_reason: "no_contesta", note: null, photo_path: null, reported_at: "2026-10-10T20:00:00Z", requested_date: null, dispatch_manifest_id: "box-1", created_at: "2026-10-10T13:00:00Z" },
      { id: "stop-3", order_id: "o3", shipment_id: "sh3", route_id: "r3", status: "no_entregado", outcome_reason: "reprogramado", note: null, photo_path: null, reported_at: "2026-10-12T20:00:00Z", requested_date: "2026-10-12", dispatch_manifest_id: "box-3", created_at: "2026-10-12T13:00:00Z" },
      { id: "stop-8", order_id: "o8", shipment_id: "sh8", route_id: "r1", status: "no_entregado", outcome_reason: "no_contesta", note: null, photo_path: null, reported_at: "2026-10-10T20:00:00Z", requested_date: null, dispatch_manifest_id: "box-1", created_at: "2026-10-10T13:00:00Z" },
    ],
    delivery_routes: [
      { id: "r1", route_date: "2026-10-10", rider_id: "rd1" },
      { id: "r3", route_date: "2026-10-12", rider_id: "rd1" },
    ],
    riders: [{ id: "rd1", full_name: "Roy" }],
    dispatch_manifests: [{ id: "box-3", courier: "propio", route_date: "2026-10-12", rider_id: "rd1", driver_name: "Roy", state: "open", load_number: 1, delivery_route_id: "r3" }],
    dispatch_manifest_items: [{ id: "item-3", shipment_id: "sh3", manifest_id: "box-3", removed_at: null, office_checked_at: null, pickup_checked_at: null }],
    stores: [
      { id: "s1", name: "Tienda", org_id: "org1" },
      { id: "s2", name: "Otra", org_id: "org2" },
    ],
    logistics_providers: [
      { id: "p1", org_id: "org1", status: "active", same_day_cutoff: "12:00:00", code: "grupo-gf-courier" },
      { id: "p2", org_id: "org2", status: "active", same_day_cutoff: "11:00:00", code: "grupo-gf-courier" },
    ],
    logistics_requests: [],
    gf_dispatch_programs: [
      { order_id: "o1", store_id: "s1", scheduled_for: "2026-10-12", reason: GF_REASON, set_at: "2026-10-11T14:00:00Z" },
      { order_id: "o2", store_id: "s1", scheduled_for: "2026-10-12", reason: GF_REASON, set_at: "2026-10-11T14:00:00Z" },
      { order_id: "o3", store_id: "s1", scheduled_for: "2026-10-12", reason: RIDER_REASON, set_at: "2026-10-12T20:00:00Z" },
      { order_id: "o4", store_id: "s1", scheduled_for: "2026-10-09", reason: GF_REASON, set_at: "2026-10-08T14:00:00Z" },
      { order_id: "z1", store_id: "s2", scheduled_for: "2026-10-13", reason: GF_REASON, set_at: "2026-10-12T14:00:00Z" },
    ],
    order_events: [
      { id: "ev-1", order_id: "o1", shipment_id: "sh1", kind: "returned_to_office", occurred_at: "2026-10-11T15:00:00Z" },
      { id: "ev-8", order_id: "o8", shipment_id: "sh8", kind: "returned_to_office", occurred_at: "2026-10-11T15:00:00Z" },
    ],
    lima_repro_cases: [
      // o4: un caso abierto que ya no sirve (fuera de la etapa). Repro Lima lo
      // cerraría al responder; Almacén no.
      caseRow("case-4", "o4"),
      caseRow("case-8", "o8", {
        agreement_call_id: "call-8", agreed_on: "2026-10-14", agreed_courier: "propio", box_action: "mantener",
        box_location: "en_oficina", decided_by: "u-diana", decided_at: "2026-10-12T21:00:00Z", episode_key: "s:stop-8|o:-",
      }),
      caseRow("case-5", "o5", {
        agreement_call_id: "call-5", agreed_on: "2026-10-14", agreed_courier: "propio", box_action: "salida_nueva_rearmar",
        decided_by: "u-diana", decided_at: "2026-10-12T21:00:00Z", opened_at: "2026-10-12T20:00:00Z",
        closed_at: "2026-10-13T14:00:00Z", close_reason: "fuera_de_etapa",
      }),
      caseRow("case-5-old", "o5", {
        agreement_call_id: "call-5-old", agreed_on: "2026-10-13", agreed_courier: "propio", box_action: "desarmar_rearmar",
        decided_by: "u-diana", decided_at: "2026-10-11T21:00:00Z", opened_at: "2026-10-11T14:00:00Z",
        closed_at: "2026-10-12T14:00:00Z", close_reason: "fuera_de_etapa",
      }),
      caseRow("case-6", "o6", {
        agreement_call_id: "call-6", agreed_on: "2026-10-13", agreed_courier: "propio", box_action: "desarmar_rearmar",
        decided_by: "u-diana", decided_at: "2026-10-12T21:00:00Z", opened_at: "2026-10-12T14:00:00Z",
        closed_at: "2026-10-13T14:00:00Z", close_reason: "fuera_de_etapa",
      }),
      caseRow("case-6-new", "o6", { opened_at: "2026-10-13T14:30:00Z" }),
      caseRow("case-7", "o7", {
        agreement_call_id: "call-7", agreed_on: "2026-10-13", agreed_courier: "propio", box_action: "caja_nueva_stock",
        decided_by: "u-diana", decided_at: "2026-10-12T21:00:00Z", closed_at: "2026-10-13T14:00:00Z", close_reason: "fuera_de_etapa",
      }),
    ],
    lima_repro_calls: [],
  };
}

function useDb(seed: Record<string, Row[]>, opts: Parameters<typeof fakeDb>[1] = {}) {
  const fake = fakeDb(seed, opts);
  real.admin = fake.admin;
  return fake;
}

const writes = (queries: Query[]) => queries.filter((query) => query.op !== "select");

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.mocked(loadReproLima).mockImplementation(real.loadReproLima!);
  vi.mocked(createAdminSupabase).mockClear();
  vi.mocked(loadReproLima).mockClear();
  vi.mocked(after).mockClear();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.mocked(getCurrentUser).mockImplementation(async () => ({ id: "u-almacen", email: null }));
  vi.mocked(getAccessibleStores).mockImplementation(async () => [{ id: "s1" }] as never);
  vi.mocked(getMasterPermissions).mockImplementation(async () => ({ can: (permission: string) => permission === "warehouse.prepare" }) as never);
});

describe("la puerta va dentro del cargador", () => {
  it("sin `warehouse.prepare`: el motivo, y ninguna lectura", async () => {
    vi.mocked(getMasterPermissions).mockImplementation(async () => ({ can: () => false }) as never);
    const { queries } = useDb(daySeed());
    const data = await getWarehouseRetries(NOW);
    expect(data).toMatchObject({ error: WAREHOUSE_NO_PERMISSION, rows: [], handoffs: [], today: "2026-10-13" });
    expect(queries).toHaveLength(0);
    expect(createAdminSupabase).not.toHaveBeenCalled();
  });

  it("sin tiendas: el motivo, y ninguna lectura", async () => {
    vi.mocked(getAccessibleStores).mockImplementation(async () => []);
    const { queries } = useDb(daySeed());
    const data = await getWarehouseRetries(NOW);
    expect(data.error).toBe(REPRO_NO_STORES);
    expect(queries).toHaveLength(0);
  });

  it("sin sesión, a /login (la redirección no se traga)", async () => {
    vi.mocked(getCurrentUser).mockImplementation(async () => null);
    vi.spyOn(console, "error").mockImplementation(() => {});
    useDb(daySeed());
    await expect(getWarehouseRetries(NOW)).rejects.toThrow("NEXT_REDIRECT");
  });

  it("el rol «Almacén» entra sin `repro_lima.manage`", async () => {
    useDb(daySeed());
    const data = await getWarehouseRetries(NOW);
    expect(data.error).toBeUndefined();
    expect(data.rows.length).toBeGreaterThan(0);
  });
});

describe("el día 1 de producción, de punta a punta", () => {
  it("las tres formas del día: caja propia en oficina, reintento que vuelve, fecha del motorizado", async () => {
    useDb(daySeed());
    const data = await getWarehouseRetries(NOW);
    const byId = new Map(data.rows.map((row) => [row.orderId, row]));
    expect([...byId.keys()].sort()).toEqual(["o1", "o2", "o3", "o8"]);

    const own = byId.get("o1")!;
    expect(own).toMatchObject({
      bucket: "hoy", overdue: true, dayFrom: "programa", action: "mantener", actionSource: "por_defecto",
      group: "con_aviso", inOffice: true, whereLine: "Debería estar en el anaquel del lun 12/10",
    });
    expect(own.chips).toContainEqual({ tone: "crit", text: RETRY_OVERDUE("lun 12/10") });
    expect(own.chips).toContainEqual({ tone: "neutral", text: RETRY_DEFAULT_CHIP });
    // La dirección cambió después de armar (sh1): se dice; por eso «Con aviso».
    expect(own.chips).toContainEqual({
      tone: "warn",
      text: "La dirección cambió el 11/10, después de armar la caja: el rótulo tiene la anterior. Avisa a Repro Lima.",
    });

    expect(byId.get("o2")).toMatchObject({
      bucket: "hoy", overdue: true, action: "salida_nueva_rearmar", actionSource: "por_defecto", group: "fuera",
      boxLabel: "Vuelve con Swayp", inOffice: false, label: null,
    });

    const rider = byId.get("o3")!;
    expect(rider).toMatchObject({ bucket: "hoy", overdue: true, action: "mantener", group: "fuera", boxLabel: "Con Roy desde lun 12/10", programReason: RIDER_REASON });
    expect(rider.chips).toContainEqual({ tone: "warn", text: RETRY_UNCONFIRMED });
    expect(rider.chips).toContainEqual({ tone: "warn", text: "Fecha del motorizado sin confirmar: lun 12/10" });

    const agreed = byId.get("o8")!;
    expect(agreed).toMatchObject({ bucket: "manana", dayFrom: "acuerdo", action: "mantener", actionSource: "acuerdo", decidedLine: "Decidió diana 12/10 16:00" });
    expect(agreed.chips).toContainEqual({ tone: "warn", text: RETRY_NO_GF_PROGRAM });

    expect(data.counts).toEqual({ hoy: 3, manana: 1, hoyEnOficina: 1, hoyFuera: 2, mananaNoche: 0 });
    expect(data).toMatchObject({ today: "2026-10-13", cutoffLabel: "12:00", omitted: 0, showStore: false });
  });

  it("lo que ya está en «Por armar» se lista aparte y no se cuenta", async () => {
    useDb(daySeed());
    const data = await getWarehouseRetries(NOW);
    // o5 sí (último caso, «Por armar»); su caso anterior no; o6 tiene un caso más nuevo; o7 ya salió de «Por armar».
    expect(data.handoffs).toEqual([{
      orderId: "o5", orderName: "#o5", storeName: "Tienda", customerName: "Ana", district: "Surco",
      bucket: "manana", day: "2026-10-14", dayLabel: "mié 14/10", overdue: false, action: "salida_nueva_rearmar",
      courierName: "Grupo GF", line: HANDOFF_LINE_GF, salida: { code: "o5-S02", armed: false, readyAt: null },
    }]);
    expect(data.handoffs.some((row) => row.line === HANDOFF_LINE_DESARMAR)).toBe(false);
    expect(data.counts.hoy + data.counts.manana).toBe(data.rows.length);
  });
});

describe("«Ya en «Por armar»» con el caso todavía abierto", () => {
  /**
   * o9: su salida nueva lo llevó a «Por armar», pero nadie abrió Repro Lima
   * todavía: el caso sigue abierto (Almacén no lo cierra). o10: la misma
   * acción, pero el pedido sigue en la etapa: no es de «Por armar».
   */
  function openSeed(): Record<string, Row[]> {
    const seed = daySeed();
    seed.order_master!.push(
      orderRow("o9", { macro_stage: "preparacion", macro_substage: "por_armar" }),
      orderRow("o10"),
    );
    seed.orders!.push({ id: "o9", store_id: "s1", cancelled_at: null }, { id: "o10", store_id: "s1", cancelled_at: null });
    seed.shipments!.push(
      shipment("sh9", "o9", { delivery_status: "no_entregado" }),
      shipment("sh9b", "o9", { output_number: 2, output_code: "o9-S02", preparation_state: "rotulo_generado", ready_at: null, created_at: "2026-10-13T13:30:00Z" }),
      shipment("sh10", "o10"),
    );
    seed.lima_repro_cases!.push(
      caseRow("case-9", "o9", {
        agreement_call_id: "call-9", agreed_on: "2026-10-13", agreed_courier: "propio", box_action: "salida_nueva_rearmar",
        decided_by: "u-diana", decided_at: "2026-10-12T21:00:00Z", opened_at: "2026-10-12T20:00:00Z",
      }),
      caseRow("case-10", "o10", {
        agreement_call_id: "call-10", agreed_on: "2026-10-14", agreed_courier: "propio", box_action: "salida_nueva_rearmar",
        decided_by: "u-diana", decided_at: "2026-10-12T21:00:00Z", opened_at: "2026-10-12T20:00:00Z",
      }),
    );
    return seed;
  }

  it("se lista con el caso abierto, y el caso sigue abierto", async () => {
    const { db, queries } = useDb(openSeed());
    const data = await getWarehouseRetries(NOW);
    expect(data.handoffs.map((row) => row.orderId)).toEqual(["o9", "o5"]);
    expect(data.handoffs[0]).toMatchObject({
      orderId: "o9", bucket: "hoy", day: "2026-10-13", overdue: false, action: "salida_nueva_rearmar",
      line: HANDOFF_LINE_GF, salida: { code: "o9-S02", armed: false, readyAt: null },
    });
    // El que sigue en la etapa no es de «Por armar»: no sale aquí.
    expect(data.handoffs.some((row) => row.orderId === "o10")).toBe(false);
    expect(db.lima_repro_cases!.find((row) => row.id === "case-9")!.closed_at).toBeNull();
    expect(writes(queries)).toEqual([]);
  });

  it("los abiertos se leen sin ventana de 14 días ni motivo de cierre; los cerrados, con ellos", async () => {
    const { queries } = useDb(openSeed());
    await getWarehouseRetries(NOW);
    const open = queries.find((query) =>
      query.table === "lima_repro_cases" &&
      query.filters.some(([method, col]) => method === "in" && col === "box_action") &&
      query.filters.some(([method, col]) => method === "is" && col === "closed_at"))!;
    expect(open).toBeTruthy();
    expect(open.filters).toEqual(expect.arrayContaining([
      ["is", "closed_at", null],
      ["not", "agreed_on", ["is", null]],
      ["in", "box_action", ["salida_nueva_rearmar", "desarmar_rearmar", "caja_nueva_stock"]],
    ]));
    // Sin tope de día acordado: el día lo deciden el programa vigente o la caja.
    expect(open.filters.some(([method, col]) => col === "agreed_on" && (method === "lte" || method === "gte"))).toBe(false);
    expect(open.filters.some(([, col]) => col === "close_reason")).toBe(false);
    expect(open.filters.some(([method, col]) => method === "gte" && col === "closed_at")).toBe(false);
    const closed = queries.find((query) => query.table === "lima_repro_cases" && query.filters.some(([, col]) => col === "close_reason"))!;
    expect(closed.filters).toContainEqual(["gte", "closed_at", "2026-09-29T15:00:00.000Z"]);
    expect(closed.filters.some(([method, col]) => method === "is" && col === "closed_at")).toBe(false);
  });

  it("solo el último caso del pedido: un caso cerrado anterior no se lista junto al abierto", async () => {
    const seed = openSeed();
    seed.lima_repro_cases!.push(caseRow("case-9-old", "o9", {
      agreement_call_id: "call-9-old", agreed_on: "2026-10-12", agreed_courier: "propio", box_action: "desarmar_rearmar",
      decided_by: "u-diana", decided_at: "2026-10-11T21:00:00Z", opened_at: "2026-10-11T14:00:00Z",
      closed_at: "2026-10-12T14:00:00Z", close_reason: "fuera_de_etapa",
    }));
    useDb(seed);
    const data = await getWarehouseRetries(NOW);
    expect(data.handoffs.filter((row) => row.orderId === "o9")).toEqual([
      expect.objectContaining({ action: "salida_nueva_rearmar", day: "2026-10-13" }),
    ]);
  });
});

describe("«Ya en «Por armar»»: el día es el del programa vigente, sea cual sea", () => {
  it("si Grupo GF lo movió a después de mañana, no se lista (aunque el acuerdo sea de mañana)", async () => {
    const seed = daySeed();
    seed.gf_dispatch_programs!.push({ order_id: "o5", store_id: "s1", scheduled_for: "2026-10-16", reason: GF_REASON, set_at: "2026-10-13T14:30:00Z" });
    const { queries } = useDb(seed);
    const data = await getWarehouseRetries(NOW);
    expect(data.handoffs).toEqual([]);
    // El programa de los candidatos se lee sin filtro de fecha, por sus tiendas.
    const live = queries.find((query) =>
      query.table === "gf_dispatch_programs" && query.filters.some(([method, col]) => method === "in" && col === "order_id"))!;
    expect(live).toBeTruthy();
    expect(live.filters.some(([method]) => method === "lte" || method === "gte")).toBe(false);
    expect(live.filters).toContainEqual(["in", "store_id", ["s1"]]);
    expect(live.filters).toContainEqual(["in", "order_id", ["o5", "o6", "o7"]]);
  });

  it("con programa para hoy o un día pasado, manda el suyo", async () => {
    const seed = daySeed();
    seed.gf_dispatch_programs!.push({ order_id: "o5", store_id: "s1", scheduled_for: "2026-10-12", reason: GF_REASON, set_at: "2026-10-12T14:30:00Z" });
    useDb(seed);
    const data = await getWarehouseRetries(NOW);
    expect(data.handoffs).toEqual([expect.objectContaining({ orderId: "o5", bucket: "hoy", day: "2026-10-12", overdue: true, dayLabel: "lun 12/10" })]);
  });

  it.each([
    ["hoy", "2026-10-13", { bucket: "hoy", day: "2026-10-13", overdue: false }],
    ["mañana", "2026-10-14", { bucket: "manana", day: "2026-10-14", overdue: false }],
    ["un día que pasó", "2026-10-12", { bucket: "hoy", day: "2026-10-12", overdue: true }],
  ])("Grupo GF lo adelantó a %s y el acuerdo es para después de mañana: se lista con su día", async (_label, scheduledFor, expected) => {
    const seed = daySeed();
    Object.assign(seed.lima_repro_cases!.find((row) => row.id === "case-5")!, { agreed_on: "2026-10-16" });
    seed.gf_dispatch_programs!.push({ order_id: "o5", store_id: "s1", scheduled_for: scheduledFor, reason: GF_REASON, set_at: "2026-10-13T14:30:00Z" });
    const { queries } = useDb(seed);
    const data = await getWarehouseRetries(NOW);
    expect(data.handoffs).toEqual([expect.objectContaining({ orderId: "o5", ...expected })]);
    expect(writes(queries)).toEqual([]);
  });

  it("con el caso abierto también; sin programa, un acuerdo para después de mañana no se lista", async () => {
    const seed = daySeed();
    const c5 = seed.lima_repro_cases!.find((row) => row.id === "case-5")!;
    Object.assign(c5, { agreed_on: "2026-10-16", closed_at: null, close_reason: null });
    useDb(seed);
    expect((await getWarehouseRetries(NOW)).handoffs).toEqual([]);
    seed.gf_dispatch_programs!.push({ order_id: "o5", store_id: "s1", scheduled_for: "2026-10-13", reason: GF_REASON, set_at: "2026-10-13T14:30:00Z" });
    useDb(seed);
    expect((await getWarehouseRetries(NOW)).handoffs).toEqual([expect.objectContaining({ orderId: "o5", bucket: "hoy", day: "2026-10-13", overdue: false })]);
  });
});

describe("«Ya en «Por armar»»: sin programa, el día de la caja de Grupo GF de la salida nueva", () => {
  /**
   * o5, acordado para el lun 12/10: Grupo GF lo movió y asignó su salida nueva
   * (sh5, todavía por armar) a la caja de Roy; al asignarla, el programa se
   * dio por cumplido y se borró.
   */
  function boxSeed(routeDate: string, item: Row = {}, box: Row = {}): Record<string, Row[]> {
    const seed = daySeed();
    Object.assign(seed.lima_repro_cases!.find((row) => row.id === "case-5")!, { agreed_on: "2026-10-12" });
    seed.dispatch_manifests!.push({
      id: "box-5", org_id: "org1", courier: "propio", route_date: routeDate, rider_id: "rd1", driver_name: "Roy", state: "open",
      load_number: 1, delivery_route_id: null, ...box,
    });
    seed.dispatch_manifest_items!.push({
      id: "item-5", shipment_id: "sh5", manifest_id: "box-5", store_id: "s1", removed_at: null, office_checked_at: null, pickup_checked_at: null, ...item,
    });
    return seed;
  }

  /** La lectura de la caja de esa salida (el motor de Repro Lima lee las de sus salidas propias aparte). */
  const boxItemsOf = (shipmentId: string) => (query: Query) =>
    query.table === "dispatch_manifest_items" &&
    query.filters.some(([method, col, value]) => method === "in" && col === "shipment_id" && (value as string[]).includes(shipmentId));

  it("la caja de hoy manda sobre el acordado de ayer: «Hoy», sin «Vencido»", async () => {
    const { queries } = useDb(boxSeed("2026-10-13"));
    const data = await getWarehouseRetries(NOW);
    expect(data.handoffs).toEqual([expect.objectContaining({ orderId: "o5", bucket: "hoy", day: "2026-10-13", dayLabel: "mar 13/10", overdue: false })]);
    // Los ítems por las tiendas de quien mira; las cajas, por sus organizaciones.
    const items = queries.find(boxItemsOf("sh5"))!;
    expect(items.filters).toEqual(expect.arrayContaining([["in", "store_id", ["s1"]], ["in", "shipment_id", ["sh5"]], ["is", "removed_at", null]]));
    const boxes = queries.find((query) => query.table === "dispatch_manifests" && query.filters.some(([method, col, value]) => method === "in" && col === "id" && (value as string[]).includes("box-5")))!;
    expect(boxes.filters).toEqual(expect.arrayContaining([["in", "org_id", ["org1"]], ["in", "id", ["box-5"]]]));
    expect(writes(queries)).toEqual([]);
  });

  it("la caja de mañana va a «Mañana»; la de después de mañana no se lista", async () => {
    useDb(boxSeed("2026-10-14"));
    expect((await getWarehouseRetries(NOW)).handoffs).toEqual([expect.objectContaining({ orderId: "o5", bucket: "manana", day: "2026-10-14", overdue: false })]);
    useDb(boxSeed("2026-10-16"));
    expect((await getWarehouseRetries(NOW)).handoffs).toEqual([]);
  });

  it.each([
    ["la sacaron de la caja", { removed_at: "2026-10-13T14:00:00Z", removal_reason: "Se sacó" }, {}],
    ["la caja se anuló", {}, { state: "cancelled" }],
    ["la caja es de otra organización", {}, { org_id: "org2" }],
  ])("sin caja vigente (%s), el acordado", async (_label, item, box) => {
    useDb(boxSeed("2026-10-13", item, box));
    const data = await getWarehouseRetries(NOW);
    expect(data.handoffs).toEqual([expect.objectContaining({ orderId: "o5", bucket: "hoy", day: "2026-10-12", overdue: true })]);
  });

  it("el programa vigente manda sobre la caja", async () => {
    const seed = boxSeed("2026-10-13");
    seed.gf_dispatch_programs!.push({ order_id: "o5", store_id: "s1", scheduled_for: "2026-10-14", reason: GF_REASON, set_at: "2026-10-13T14:30:00Z" });
    const { queries } = useDb(seed);
    const data = await getWarehouseRetries(NOW);
    expect(data.handoffs).toEqual([expect.objectContaining({ orderId: "o5", bucket: "manana", day: "2026-10-14" })]);
    expect(queries.some(boxItemsOf("sh5"))).toBe(false);
  });

  it("la salida nueva de otro courier no mira cajas: el acordado", async () => {
    const seed = boxSeed("2026-10-13");
    Object.assign(seed.lima_repro_cases!.find((row) => row.id === "case-5")!, { agreed_courier: "tanders" });
    Object.assign(seed.shipments!.find((row) => row.id === "sh5")!, { courier: "tanders" });
    const { queries } = useDb(seed);
    const data = await getWarehouseRetries(NOW);
    expect(data.handoffs).toEqual([expect.objectContaining({ orderId: "o5", day: "2026-10-12", overdue: true, courierName: "Tanders" })]);
    expect(queries.some(boxItemsOf("sh5"))).toBe(false);
  });
});

describe("«Ya en «Por armar»»: solo mientras la salida nueva sea la de ese acuerdo", () => {
  /**
   * o5: la salida nueva del acuerdo (sh5, S02) ya salió; sh5c (S03) nació de
   * otro intento y nadie pulsó «Atender»: no hay caso nuevo y case-5 sigue
   * siendo el último del pedido.
   */
  function laterSeed(salida: Row, stops: Row[] = []): Record<string, Row[]> {
    const seed = daySeed();
    Object.assign(seed.shipments!.find((row) => row.id === "sh5")!, { preparation_state: "listo_despacho", ready_at: "2026-10-13T13:45:00Z", ...salida });
    seed.shipments!.push(shipment("sh5c", "o5", {
      output_number: 3, output_code: "o5-S03", preparation_state: "rotulo_generado", ready_at: null, dispatched_at: null, created_at: "2026-10-13T14:40:00Z",
    }));
    seed.delivery_stops!.push(...stops);
    return seed;
  }
  const stop5 = (shipmentId: string): Row => ({
    id: `stop-${shipmentId}`, order_id: "o5", store_id: "s1", shipment_id: shipmentId, route_id: "r5", status: "no_entregado",
    outcome_reason: "no_contesta", note: null, photo_path: null, reported_at: "2026-10-13T14:20:00Z", requested_date: null,
    dispatch_manifest_id: "box-5", created_at: "2026-10-13T13:50:00Z",
  });

  it.each([
    ["su parada de Grupo GF dice «No entregado»", { custody_state: "courier", custody_transferred_at: "2026-10-13T13:50:00Z" }, [stop5("sh5")]],
    ["«Sacar con salida nueva» con la caja en el motorizado", { custody_state: "retorno" }, []],
    ["la caja reemplazada ya volvió", { custody_state: "devuelto", returned_at: "2026-10-13T14:30:00Z" }, []],
    ["la de Tanders volvió", { courier: "tanders", custody_state: null, returned_at: "2026-10-13T14:30:00Z" }, []],
  ])("un fallo nuevo sin caso nuevo (%s): no se lista", async (_label, salida, stops) => {
    const { queries } = useDb(laterSeed(salida, stops));
    const data = await getWarehouseRetries(NOW);
    expect(data.handoffs).toEqual([]);
    expect(writes(queries)).toEqual([]);
  });

  it("el fallo de una salida de antes del acuerdo no cuenta; las paradas se leen por sus tiendas", async () => {
    const seed = daySeed();
    seed.delivery_stops!.push(stop5("tx5"));
    const { queries } = useDb(seed);
    const data = await getWarehouseRetries(NOW);
    expect(data.handoffs).toEqual([expect.objectContaining({ orderId: "o5", salida: { code: "o5-S02", armed: false, readyAt: null } })]);
    const stops = queries.find((query) => query.table === "delivery_stops")!;
    expect(stops.filters).toEqual(expect.arrayContaining([
      ["in", "store_id", ["s1"]], ["in", "order_id", ["o5", "o6", "o7"]], ["eq", "status", "no_entregado"], ["not", "shipment_id", ["is", null]],
    ]));
  });
});

describe("«Ya en «Por armar»»: al armar la salida nueva, la fila sale de la lista", () => {
  it("el pedido pasa a «Por despachar»: el cargador no devuelve una salida nueva armada", async () => {
    const seed = daySeed();
    Object.assign(seed.shipments!.find((row) => row.id === "sh5")!, { preparation_state: "listo_despacho", ready_at: "2026-10-13T15:12:00Z" });
    Object.assign(seed.order_master!.find((row) => row.order_id === "o5")!, { macro_stage: "por_despachar", macro_substage: "por_asignar" });
    useDb(seed);
    const data = await getWarehouseRetries(NOW);
    expect(data.handoffs).toEqual([]);
  });
});

describe("solo lee", () => {
  it("el motor de Repro Lima va con `closeStale: false`: ni escrituras, ni RPC, ni `after()`", async () => {
    const { queries, rpc, db } = useDb(daySeed());
    await getWarehouseRetries(NOW);
    expect(loadReproLima).toHaveBeenCalled();
    for (const call of vi.mocked(loadReproLima).mock.calls) expect(call[3]).toMatchObject({ closeStale: false });
    expect(writes(queries)).toEqual([]);
    expect(rpc).not.toHaveBeenCalled();
    expect(after).not.toHaveBeenCalled();
    // El caso que ya no sirve sigue abierto: Repro Lima lo cierra al leer, Almacén no.
    expect(db.lima_repro_cases!.find((row) => row.id === "case-4")!.closed_at).toBeNull();
  });

  it("cada consulta va por las tiendas de quien mira", async () => {
    // El motor de Repro Lima lee de otra base: aquí solo quedan las consultas propias.
    const shadow = fakeDb(daySeed());
    vi.mocked(loadReproLima).mockImplementation((_admin, scope, now, opts) => real.loadReproLima!(shadow.admin as never, scope, now, opts));
    const { queries } = useDb(daySeed());
    const data = await getWarehouseRetries(NOW);
    expect(data.rows.length).toBeGreaterThan(0);
    // `delivery_stops` y `dispatch_manifest_items`: el fallo y la caja de la salida nueva de o5.
    expect(new Set(queries.map((query) => query.table))).toEqual(new Set([
      "gf_dispatch_programs", "lima_repro_cases", "stores", "logistics_providers", "order_master", "shipments",
      "delivery_stops", "dispatch_manifest_items",
    ]));
    for (const query of queries) {
      const column = query.table === "stores" ? "id" : query.table === "logistics_providers" || query.table === "dispatch_manifests" ? "org_id" : "store_id";
      const scoped = query.filters.find(([method, col]) => method === "in" && col === column);
      expect(scoped, `${query.table} ${query.columns}`).toBeTruthy();
      const allowed = column === "org_id" ? ["org1"] : ["s1"];
      expect((scoped![2] as string[]).every((value) => allowed.includes(value)), `${query.table}`).toBe(true);
    }
    expect(writes(queries)).toEqual([]);
  });

  it("los filtros de fecha: programas hasta mañana (lo vencido incluido) y acuerdos abiertos de hoy o mañana", async () => {
    const { queries } = useDb(daySeed());
    await getWarehouseRetries(NOW);
    const programs = queries.find((query) => query.table === "gf_dispatch_programs" && query.columns === "order_id,scheduled_for")!;
    expect(programs.filters).toContainEqual(["lte", "scheduled_for", "2026-10-14"]);
    expect(programs.filters.some(([method]) => method === "gte")).toBe(false);
    const open = queries.find((query) => query.table === "lima_repro_cases" && query.columns === "order_id,agreed_on")!;
    expect(open.filters).toEqual(expect.arrayContaining([
      ["is", "closed_at", null],
      ["gte", "agreed_on", "2026-10-13"],
      ["lte", "agreed_on", "2026-10-14"],
    ]));
  });

  it("los acuerdos que ya dejaron la etapa: `fuera_de_etapa`, las tres acciones, 14 días, «Por armar»", async () => {
    const { queries } = useDb(daySeed());
    await getWarehouseRetries(NOW);
    const handoff = queries.find((query) => query.table === "lima_repro_cases" && query.filters.some(([, col]) => col === "close_reason"))!;
    expect(handoff.filters).toEqual(expect.arrayContaining([
      ["eq", "close_reason", "fuera_de_etapa"],
      ["not", "agreed_on", ["is", null]],
      ["in", "box_action", ["salida_nueva_rearmar", "desarmar_rearmar", "caja_nueva_stock"]],
      ["gte", "closed_at", "2026-09-29T15:00:00.000Z"],
    ]));
    expect(handoff.filters.some(([method, col]) => col === "agreed_on" && (method === "lte" || method === "gte"))).toBe(false);
    const master = queries.find((query) => query.table === "order_master" && query.columns?.includes("macro_substage") && query.filters.some(([, col, value]) => col === "macro_substage" && value === "por_armar"))!;
    expect(master.filters).toContainEqual(["eq", "macro_stage", "preparacion"]);
  });
});

describe("lotes y tope", () => {
  it("de 100 en 100 hasta 300, lo más antiguo primero; el resto va en `omitted`", async () => {
    const seed = daySeed();
    const ids = Array.from({ length: 350 }, (_, i) => `p${String(i).padStart(3, "0")}`);
    // Los 50 primeros salen mañana: son los que quedan fuera del tope.
    seed.gf_dispatch_programs = ids.map((id, i) => ({
      order_id: id, store_id: "s1", scheduled_for: i < 50 ? "2026-10-14" : "2026-10-13", reason: GF_REASON, set_at: "2026-10-12T14:00:00Z",
    }));
    seed.lima_repro_cases = [];
    useDb(seed);
    const data = await getWarehouseRetries(NOW);
    const calls = vi.mocked(loadReproLima).mock.calls;
    expect(calls.map((call) => call[3]?.orderIds?.length)).toEqual([100, 100, 100]);
    const read = calls.flatMap((call) => [...(call[3]?.orderIds ?? [])]);
    expect(read).toHaveLength(RETRY_CANDIDATES_MAX);
    expect(read.some((id) => ids.indexOf(id) < 50)).toBe(false);
    expect(data.omitted).toBe(50);
  });
});

describe("nunca lanza", () => {
  it("una lectura que falla devuelve el aviso de error, sin filas", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    useDb(daySeed(), { fail: (query) => query.table === "gf_dispatch_programs" });
    const data = await getWarehouseRetries(NOW);
    expect(data).toMatchObject({ error: RETRY_ERROR, rows: [], handoffs: [], today: "2026-10-13" });
    expect(data.counts).toEqual({ hoy: 0, manana: 0, hoyEnOficina: 0, hoyFuera: 0, mananaNoche: 0 });
    expect(errors).toHaveBeenCalled();
  });

  it("también si falla dentro del motor de Repro Lima", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    useDb(daySeed(), { fail: (query) => query.table === "delivery_stops" });
    const data = await getWarehouseRetries(NOW);
    expect(data.error).toBe(RETRY_ERROR);
  });
});
