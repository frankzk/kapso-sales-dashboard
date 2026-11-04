// Almacén: «Swayp por salir · Lima» en el servidor (lib/warehouse-swayp-access.ts;
// fase 1, solo lectura, owner 03-11-2026). Con una base en memoria que anota
// cada consulta: la puerta (`warehouse.prepare` y tiendas) antes de leer nada,
// cada lectura acotada a las tiendas de quien mira, la forma de las consultas
// (courier, rango UTC de los días, directas por su fecha original), las páginas
// del tope de PostgREST, ninguna escritura ni RPC, y un fallo que nunca lanza.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const real = vi.hoisted(() => ({ admin: null as unknown }));

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
  resolveAgentNames: vi.fn(async (ids: Iterable<string>) => Object.fromEntries([...ids].map((id) => [id, id.replace(/^u-/, "")]))),
}));
vi.mock("@/lib/db", () => ({ createAdminSupabase: vi.fn(() => real.admin) }));

import { getAccessibleStores, getCurrentUser } from "@/lib/access";
import { getMasterPermissions } from "@/lib/permissions-access";
import { createAdminSupabase } from "@/lib/db";
import { resolveAgentNames } from "@/lib/agent-names";
import { REPRO_NO_STORES } from "@/lib/repro-lima-access";
import { WAREHOUSE_NO_PERMISSION } from "@/lib/warehouse-retries-access";
import { getWarehouseSwayp } from "@/lib/warehouse-swayp-access";
import { SWAYP_ERROR } from "@/lib/warehouse-swayp";

type Row = Record<string, any>;
type Filter = [method: string, column: string, value: unknown];
interface Query {
  table: string;
  op: "select" | "update" | "insert" | "upsert" | "delete";
  columns: string | null;
  filters: Filter[];
  range: [number, number] | null;
  /** Las columnas de `.order()`, en orden. */
  order: string[];
}

/** El tope de filas por respuesta de PostgREST (`db-max-rows`). */
const MAX_ROWS = 1000;

/** `like` de SQL: `%` cualquier cosa, `_` un carácter. */
function likeTest(pattern: string): RegExp {
  const body = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*").replace(/_/g, ".");
  return new RegExp(`^${body}$`);
}

/** Una base en memoria que anota cada consulta al resolverse. `fail` hace que esa consulta responda con error. */
function fakeDb(seed: Record<string, Row[]>, opts: { fail?: (query: Query) => boolean } = {}) {
  const db: Record<string, Row[]> = Object.fromEntries(Object.entries(seed).map(([t, rows]) => [t, rows.map((r) => ({ ...r }))]));
  const queries: Query[] = [];
  const rpc = vi.fn(async () => ({ data: null, error: null }));
  const from = (table: string) => {
    const query: Query = { table, op: "select", columns: null, filters: [], range: null, order: [] };
    const tests: Array<(row: Row) => boolean> = [];
    const orders: Array<{ col: string; asc: boolean }> = [];
    let value: any = null;
    let single = false;
    const q: any = {};
    const filter = (method: string, col: string, v: unknown, test: (row: Row) => boolean) => {
      query.filters.push([method, col, v]);
      tests.push(test);
      return q;
    };
    const cmp = (method: string, test: (a: number, b: number) => boolean) => (col: string, v: string) =>
      filter(method, col, v, (r) => r[col] != null && test(Date.parse(String(r[col])), Date.parse(String(v))));
    q.select = (columns?: string) => {
      if (query.op === "select") query.columns = columns ?? "*";
      return q;
    };
    q.eq = (col: string, v: unknown) => filter("eq", col, v, (r) => r[col] === v);
    q.in = (col: string, vs: unknown[]) => filter("in", col, vs, (r) => vs.includes(r[col]));
    q.is = (col: string, v: unknown) => filter("is", col, v, (r) => (v === null ? r[col] == null : r[col] === v));
    q.not = (col: string, operator: string, v: unknown) =>
      filter("not", col, [operator, v], (r) => (operator === "is" && v === null ? r[col] != null : r[col] !== v));
    q.like = (col: string, pattern: string) => filter("like", col, pattern, (r) => likeTest(pattern).test(String(r[col] ?? "")));
    q.ilike = (col: string, pattern: string) =>
      filter("ilike", col, pattern, (r) => new RegExp(likeTest(pattern).source, "i").test(String(r[col] ?? "")));
    q.gte = cmp("gte", (a, b) => a >= b);
    q.lt = cmp("lt", (a, b) => a < b);
    q.order = (col: string, o?: { ascending?: boolean }) => {
      orders.push({ col, asc: o?.ascending !== false });
      query.order.push(col);
      return q;
    };
    q.limit = () => q;
    q.range = (a: number, b: number) => {
      query.range = [a, b];
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
      if (query.range) out = out.slice(query.range[0], query.range[1] + 1);
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

/** Mar 3 nov, 17:42 de Lima. */
const NOW = new Date("2026-11-03T22:42:00Z");

function shipment(id: string, extra: Row = {}): Row {
  return {
    id, store_id: "s1", courier: "fenix", guide_code: `G-${id}`, swayp_guide: `G-${id}`, swayp_state: 1, delivery_status: "en_ruta",
    status_category: "in_route", order_id: `o-${id}`, order_name: `#${id}`, customer_name: "Cliente Ejemplo", product: "Producto", district: "Surco",
    city: "lima", province: null, next_followup_at: "2026-11-04T00:00:00+00:00", created_at: "2026-11-03T15:00:00Z",
    output_code: `${id}-S01`, output_number: 1, preparation_state: "no_iniciado", custody_state: "empresa", ready_at: null, ready_by: null,
    custody_transferred_at: null, dispatched_at: null, returned_at: null, updated_at: "2026-11-03T15:00:00Z", ...extra,
  };
}

function master(orderId: string, extra: Row = {}): Row {
  return {
    order_id: orderId, store_id: "s1", order_name: `#${orderId}`, customer_name: "Cliente Ejemplo", macro_operation: "lima", general_status: "en_proceso",
    product_titles: ["Producto"], district: "Surco", province: "Lima", region: "Lima (provincia)", macro_stage: "en_curso", ...extra,
  };
}

function directEmission(id: string, shipmentRow: Row, day: string, createdAt: string, extra: Row = {}): Row {
  return {
    id, source_key: `direct:${shipmentRow.order_id}:${day}T00:00:00.000Z`, order_id: shipmentRow.order_id, store_id: shipmentRow.store_id,
    org_id: "org1", automatic: false, state: "created", city: "lima", products: [], evidence: {}, guide_code: shipmentRow.guide_code,
    swayp_state: 1, child_id: shipmentRow.id, error: null, created_at: createdAt, ...extra,
  };
}

/**
 * El 03-11 de producción, reducido:
 * - KP201878-S01: martes, armada como «por definir» (07:19) antes de su guía (16:02);
 * - KP202022-S01: martes, armada a las 17:19 después de su guía;
 * - KP143987-S02: miércoles, sin armar; su S01 de Aliclik volvió a la oficina;
 * - KP300-S01: directa creada para el miércoles que ahora sale el viernes;
 * - KP400-S01: provincia del miércoles, con `city` nulo;
 * - z1: otra tienda, fuera del alcance.
 */
function daySeed(): Record<string, Row[]> {
  const kp201878 = shipment("KP201878", {
    output_code: "KP201878-S01", next_followup_at: "2026-11-03T00:00:00+00:00", created_at: "2026-11-02T12:06:37Z",
    preparation_state: "listo_despacho", ready_at: "2026-11-02T12:19:37Z", ready_by: "u-almacen-a", district: "La Victoria",
  });
  const kp202022 = shipment("KP202022", {
    output_code: "KP202022-S01", next_followup_at: "2026-11-03T00:00:00+00:00", created_at: "2026-11-02T19:06:03Z",
    preparation_state: "listo_despacho", ready_at: "2026-11-02T22:19:53Z", ready_by: "u-almacen-b", district: "Cieneguilla",
  });
  const kp143987 = shipment("KP143987", {
    output_code: "KP143987-S02", output_number: 2, guide_code: "50000165022", swayp_guide: "50000165022",
    created_at: "2026-11-03T05:11:10.904Z", district: "san bartolo",
  });
  const aliclik = shipment("KP143987-old", {
    order_id: "o-KP143987", courier: "aliclik", guide_code: "AUR5X246218871979", swayp_guide: null, output_code: "KP143987-S01",
    preparation_state: "listo_despacho", custody_state: "devuelto", delivery_status: "anulado", status_category: "closed", swayp_state: null,
    returned_at: "2026-11-02T18:51:16Z", next_followup_at: "2026-10-25T17:00:00+00:00", created_at: "2026-10-25T20:53:31Z",
  });
  const moved = shipment("KP300", { next_followup_at: "2026-11-06T00:00:00+00:00", preparation_state: "listo_despacho", ready_at: "2026-11-03T16:30:00Z" });
  const provincia = shipment("KP400", { city: null, province: "Ica", district: "Ica" });
  const other = shipment("z1", { store_id: "s2" });
  return {
    shipments: [kp201878, kp202022, kp143987, aliclik, moved, provincia, other],
    order_master: [
      master("o-KP201878"), master("o-KP202022"), master("o-KP143987", { district: "san bartolo" }), master("o-KP300"),
      master("o-KP400", { macro_operation: "provincia_cod" }), master("o-z1", { store_id: "s2" }),
    ],
    orders: [
      { id: "o-KP201878", store_id: "s1", cancelled_at: null },
      { id: "o-KP143987", store_id: "s1", cancelled_at: null },
    ],
    swayp_guide_emissions: [
      directEmission("e-1", kp201878, "2026-11-03", "2026-11-02T21:02:13Z"),
      directEmission("e-2", kp202022, "2026-11-03", "2026-11-02T21:03:03Z"),
      directEmission("e-3", kp143987, "2026-11-04", "2026-11-03T05:11:09.552Z"),
      directEmission("e-4", moved, "2026-11-04", "2026-11-03T15:00:00Z"),
      directEmission("e-z", other, "2026-11-04", "2026-11-03T15:00:00Z"),
    ],
    shipment_calls: [
      { id: "c1", shipment_id: kp201878.id, store_id: "s1", agent: "u-asesora-a", kind: "reroute", new_status: null, note: "Guía Swayp directa creada", occurred_at: "2026-11-02T21:02:14Z", next_followup_at: "2026-11-03T00:00:00+00:00" },
      { id: "c2", shipment_id: kp202022.id, store_id: "s1", agent: "u-asesora-a", kind: "reroute", new_status: null, note: "Guía Swayp directa creada", occurred_at: "2026-11-02T21:03:05Z", next_followup_at: "2026-11-03T00:00:00+00:00" },
      { id: "c3", shipment_id: kp143987.id, store_id: "s1", agent: "u-asesora-b", kind: "reroute", new_status: null, note: "Guía Swayp directa creada", occurred_at: "2026-11-03T05:11:10.938Z", next_followup_at: "2026-11-04T00:00:00+00:00" },
      { id: "c4", shipment_id: moved.id, store_id: "s1", agent: null, kind: "call", new_status: null, note: "Agente de voz: reprogramar", occurred_at: "2026-11-03T23:40:00Z", next_followup_at: "2026-11-06T00:00:00+00:00" },
      { id: "cz", shipment_id: other.id, store_id: "s2", agent: "u-otra", kind: "reroute", new_status: null, note: "otra tienda", occurred_at: "2026-11-03T15:00:00Z", next_followup_at: null },
    ],
    stores: [
      { id: "s1", name: "Kenku Peru", org_id: "org1" },
      { id: "s2", name: "Otra", org_id: "org2" },
    ],
  };
}

function useDb(seed: Record<string, Row[]>, opts: Parameters<typeof fakeDb>[1] = {}) {
  const fake = fakeDb(seed, opts);
  real.admin = fake.admin;
  return fake;
}

const SCOPED_TABLES = new Set(["shipments", "order_master", "orders", "swayp_guide_emissions", "shipment_calls"]);

beforeEach(() => {
  vi.mocked(createAdminSupabase).mockClear();
  vi.mocked(resolveAgentNames).mockClear();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(getCurrentUser).mockImplementation(async () => ({ id: "u-almacen", email: null }) as never);
  vi.mocked(getAccessibleStores).mockImplementation(async () => [{ id: "s1" }] as never);
  vi.mocked(getMasterPermissions).mockImplementation(async () => ({ can: (permission: string) => permission === "warehouse.prepare" }) as never);
});

describe("la puerta va dentro del cargador", () => {
  it("sin `warehouse.prepare`: el motivo, y ninguna lectura", async () => {
    vi.mocked(getMasterPermissions).mockImplementation(async () => ({ can: () => false }) as never);
    const { queries } = useDb(daySeed());
    const data = await getWarehouseSwayp(NOW);
    expect(data).toMatchObject({ error: WAREHOUSE_NO_PERMISSION, today: "2026-11-03" });
    expect(data.proximo.faltan).toEqual([]);
    expect(queries).toHaveLength(0);
    expect(createAdminSupabase).not.toHaveBeenCalled();
  });

  it("sin tiendas: el motivo, y ninguna lectura", async () => {
    vi.mocked(getAccessibleStores).mockImplementation(async () => []);
    const { queries } = useDb(daySeed());
    expect((await getWarehouseSwayp(NOW)).error).toBe(REPRO_NO_STORES);
    expect(queries).toHaveLength(0);
  });

  it("sin sesión, a /login (la redirección no se traga)", async () => {
    vi.mocked(getCurrentUser).mockImplementation(async () => null);
    useDb(daySeed());
    await expect(getWarehouseSwayp(NOW)).rejects.toThrow("NEXT_REDIRECT");
  });
});

describe("el 03-11 de punta a punta", () => {
  it("hoy 2 programadas y armadas; mañana falta KP143987-S02 con su caja de Aliclik; la que cambió de fecha salió", async () => {
    useDb(daySeed());
    const data = await getWarehouseSwayp(NOW);
    expect(data.error).toBeUndefined();
    expect(data.hoy!.headline).toBe("Swayp hoy: 2 programadas · 2 armadas");
    expect(data.hoy!.armadas.map((a) => [a.code, a.armedBeforeGuide, a.readyBy])).toEqual([
      ["KP201878-S01", true, "almacen-a"],
      ["KP202022-S01", false, "almacen-b"],
    ]);
    const next = data.proximo;
    expect(next.headline).toBe("Swayp miércoles 4 nov: 1 programada · 0 armadas · falta 1");
    expect(next.faltan).toHaveLength(1);
    expect(next.faltan[0]).toMatchObject({
      code: "KP143987-S02",
      title: "KP143987-S02 · guía 50000165022",
      customerLine: "Cliente Ejemplo · San Bartolo",
      orderLine: "#o-KP143987 · Kenku Peru · Producto",
      createdLine: "Creó la guía: asesora-b · martes 3 nov 00:11",
      newSalida: true,
    });
    expect(next.faltan[0]!.where?.text).toBe(
      "La KP143987-S01 (Aliclik) volvió a la oficina: si la caja está entera, úsala con el rótulo KP143987-S02; si no, ármala desde stock.",
    );
    expect(next.salieron.map((s) => [s.code, s.text, s.armedText])).toEqual([
      ["KP300-S01", "Fecha cambiada: ahora sale el viernes 6 nov (cambió el martes 3 nov 18:40)", "Estaba armada: sácala del sitio de Swayp."],
    ]);
    expect(next.provincia).toMatchObject({ total: 1, porCiudad: [{ city: "Ica", count: 1 }] });
    expect(data.showStore).toBe(false);
    // Los nombres se resuelven una vez, con el cliente de servicio: quien creó y quien armó.
    expect(resolveAgentNames).toHaveBeenCalledTimes(1);
    expect([...vi.mocked(resolveAgentNames).mock.calls[0]![0]].sort()).toEqual(["u-almacen-a", "u-almacen-b", "u-asesora-a", "u-asesora-b"]);
  });

  it("solo lee: ni escrituras ni RPC", async () => {
    const { queries, rpc } = useDb(daySeed());
    await getWarehouseSwayp(NOW);
    expect(queries.filter((query) => query.op !== "select")).toEqual([]);
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe("el alcance y la forma de las consultas", () => {
  it("cada lectura va por las tiendas de quien mira; la otra tienda no aparece", async () => {
    const { queries } = useDb(daySeed());
    const data = await getWarehouseSwayp(NOW);
    for (const query of queries) {
      if (SCOPED_TABLES.has(query.table)) {
        expect(query.filters).toContainEqual(["in", "store_id", ["s1"]]);
      } else if (query.table === "dispatch_manifests") {
        // La entrega a Swayp es por organización (fase 3): la de las tiendas de quien mira.
        expect(query.filters.find(([method, column]) => method === "in" && column === "org_id")).toBeTruthy();
        expect(query.filters).not.toContainEqual(["in", "org_id", expect.arrayContaining(["org2"])]);
      } else if (query.table === "dispatch_manifest_items") {
        expect(query.filters.some(([method, column]) => method === "eq" && column === "manifest_id")).toBe(true);
      } else {
        expect(query.table).toBe("stores");
        expect(query.filters).toContainEqual(["in", "id", ["s1"]]);
      }
    }
    const codes = [...(data.hoy?.armadas ?? []), ...data.proximo.faltan, ...data.proximo.salieron].map((row) => row.code);
    expect(codes).not.toContain("z1-S01");
  });

  it("las guías: courier Swayp y el rango UTC de los días de las zonas; las directas, por su fecha original", async () => {
    const { queries } = useDb(daySeed());
    await getWarehouseSwayp(NOW);
    const zone = queries.find((q) => q.table === "shipments" && q.filters.some(([m]) => m === "gte"))!;
    expect(zone.filters).toEqual(expect.arrayContaining([
      ["eq", "courier", "fenix"],
      ["gte", "next_followup_at", "2026-11-03T00:00:00.000Z"],
      ["lt", "next_followup_at", "2026-11-05T00:00:00.000Z"],
    ]));
    // Sin filtro de estado: lo cancelado y lo anulado tienen que salir con su motivo.
    expect(zone.filters.map(([, column]) => column)).not.toContain("status_category");
    expect(zone.range).toEqual([0, 499]);
    const likes = queries.filter((q) => q.table === "swayp_guide_emissions" && q.filters.some(([m]) => m === "like"));
    expect(likes.map((q) => q.filters.find(([m]) => m === "like")![2]).sort()).toEqual(["direct:%:2026-11-03T%", "direct:%:2026-11-04T%"]);
    // Nunca `shipments.created_at` como hora de la guía: no se filtra ni se ordena por ella.
    expect(queries.every((q) => !q.filters.some(([, column]) => column === "created_at"))).toBe(true);
    // La cancelación de la tienda: solo los pedidos cancelados.
    const orders = queries.find((q) => q.table === "orders")!;
    expect(orders.filters).toContainEqual(["not", "cancelled_at", ["is", null]]);
    // Las páginas de gestiones con un orden único: la hora y, para desempatar, el id.
    const calls = queries.filter((q) => q.table === "shipment_calls");
    expect(calls.length).toBeGreaterThan(0);
    for (const query of calls) expect(query.order).toEqual(["occurred_at", "id"]);
  });

  it("una directa anulada en Kapta pierde la fecha y se encuentra por su emisión: sale en «Salieron» (KP139661-S01)", async () => {
    const seed = daySeed();
    // `cancelFenixDirectGuide`: anulada, sin fecha; estaba armada y sigue en la empresa.
    const annulled = shipment("KP500", {
      next_followup_at: null, delivery_status: "anulado", status_category: "closed", preparation_state: "listo_despacho",
      ready_at: "2026-11-03T16:00:00Z",
    });
    seed.shipments!.push(annulled);
    seed.order_master!.push(master("o-KP500"));
    seed.swayp_guide_emissions!.push(directEmission("e-5", annulled, "2026-11-04", "2026-11-03T15:00:00Z"));
    useDb(seed);
    const data = await getWarehouseSwayp(NOW);
    expect(data.proximo.salieron.map((row) => [row.code, row.reason, row.armedText])).toContainEqual([
      "KP500-S01", "guia_anulada", "Estaba armada: sácala del sitio de Swayp.",
    ]);
    expect(data.proximo.counts.programadas).toBe(1);
  });

  it("el sábado lee del sábado al lunes; el domingo, solo el lunes", async () => {
    const saturday = useDb(daySeed());
    const sat = await getWarehouseSwayp(new Date("2026-11-07T15:00:00Z"));
    expect(sat.hoy?.title).toBe("Hoy · sábado 7 nov");
    expect(sat.proximo.title).toBe("Próximo despacho · lunes 9 nov");
    const zoneSat = saturday.queries.find((q) => q.table === "shipments" && q.filters.some(([m]) => m === "gte"))!;
    expect(zoneSat.filters).toEqual(expect.arrayContaining([
      ["gte", "next_followup_at", "2026-11-07T00:00:00.000Z"],
      ["lt", "next_followup_at", "2026-11-10T00:00:00.000Z"],
    ]));
    const sunday = useDb(daySeed());
    const sun = await getWarehouseSwayp(new Date("2026-11-08T15:00:00Z"));
    expect(sun.hoy).toBeNull();
    const zoneSun = sunday.queries.find((q) => q.table === "shipments" && q.filters.some(([m]) => m === "gte"))!;
    expect(zoneSun.filters).toEqual(expect.arrayContaining([
      ["gte", "next_followup_at", "2026-11-09T00:00:00.000Z"],
      ["lt", "next_followup_at", "2026-11-10T00:00:00.000Z"],
    ]));
  });

  it("pasa el tope de 1.000 filas de PostgREST por páginas: sin tope ni paginación en la lista", async () => {
    const seed = daySeed();
    for (let i = 0; i < 1100; i += 1) {
      const id = `L${String(i).padStart(4, "0")}`;
      seed.shipments!.push(shipment(id));
      seed.order_master!.push(master(`o-${id}`));
    }
    useDb(seed);
    const data = await getWarehouseSwayp(NOW);
    expect(data.error).toBeUndefined();
    expect(data.proximo.counts.faltan).toBe(1101);
    expect(data.proximo.faltan).toHaveLength(1101);
  });

  it("sin guías en esos días: la lista vacía, sin leer pedidos", async () => {
    const { queries } = useDb({ stores: [{ id: "s1", name: "Kenku Peru" }] });
    const data = await getWarehouseSwayp(NOW);
    expect(data.error).toBeUndefined();
    expect(data.proximo.headline).toBe("Swayp no lleva nada de Lima el miércoles 4 nov.");
    expect(queries.some((q) => q.table === "order_master")).toBe(false);
  });
});

describe("nunca lanza", () => {
  it.each(["shipments", "order_master", "swayp_guide_emissions", "shipment_calls"])("si falla %s, el error con texto y la estación sigue", async (table) => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    useDb(daySeed(), { fail: (query) => query.table === table });
    const data = await getWarehouseSwayp(NOW);
    expect(data.error).toBe(SWAYP_ERROR);
    expect(data.proximo).toMatchObject({ title: "Mañana · miércoles 4 nov", faltan: [] });
  });
});
