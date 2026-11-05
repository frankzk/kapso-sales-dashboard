// El cuadre de la pantalla Devoluciones (MOM §9.4): un bloque por courier, y
// una lectura que falla se dice en vez de pintarse como «0 por recibir».

import { beforeEach, describe, expect, it, vi } from "vitest";

interface Call {
  table: string;
  filters: [string, unknown][];
}

const state = vi.hoisted(() => ({
  calls: [] as Call[],
  failTable: null as string | null,
  /** Falla solo la lectura de `order_events` de ese `kind`. */
  failKind: null as string | null,
  rows: {} as Record<string, unknown[]>,
  /** Lo que devuelve `getPendingReturns` (Grupo GF) y con qué alcance se llamó. */
  pending: [] as unknown[],
  pendingFails: false,
  pendingScopes: [] as unknown[],
}));

vi.mock("@/lib/courier-route-ledger", () => ({
  getPendingReturns: async (scope: unknown) => {
    state.pendingScopes.push(scope);
    if (state.pendingFails) throw new Error("57014 statement timeout");
    return state.pending;
  },
}));

vi.mock("@/lib/db", () => ({
  createServerSupabase: async () => ({
    from: (table: string) => {
      const call: Call = { table, filters: [] };
      state.calls.push(call);
      const q: Record<string, unknown> = {};
      for (const m of ["select", "eq", "neq", "in", "or", "limit", "gte", "lt"]) q[m] = (col: unknown, val?: unknown) => (call.filters.push([`${m}:${String(col)}`, val]), q);
      const courier = () => call.filters.find(([k]) => k === "eq:courier")?.[1] as string | undefined;
      const kind = () => call.filters.find(([k]) => k === "eq:kind")?.[1] as string | undefined;
      const result = () =>
        state.failTable === `${table}:${courier() ?? ""}` || state.failTable === table || (state.failKind && state.failKind === kind())
          ? { data: null, error: { message: "57014 statement timeout" } }
          : { data: state.rows[`${table}:${kind() === "returned_to_office" ? "gf" : courier() ?? ""}`] ?? [], error: null };
      q.then = (resolve: (r: unknown) => unknown, reject: (e: unknown) => unknown) => Promise.resolve(result()).then(resolve, reject);
      return q;
    },
  }),
  createAdminSupabase: vi.fn(),
}));

import { getReturnsReceptionData } from "@/lib/dispatch-access";

beforeEach(() => {
  Object.assign(state, { calls: [], failTable: null, failKind: null, rows: {}, pending: [], pendingFails: false, pendingScopes: [] });
});

describe("getReturnsReceptionData", () => {
  it("Shalom entra con lo que el rastreo dejó de vuelta y lo ya recibido, nunca lo entregado", async () => {
    state.rows["shipments:shalom"] = [
      { id: "a", guide_code: "92083386", order_name: "#KP128064", custody_state: "devuelto", returned_at: "2026-10-03T01:13:29Z", closed_at: null, updated_at: null },
      { id: "b", guide_code: "92083391", order_name: "#KP130176", custody_state: "retorno", returned_at: null, closed_at: "2026-09-22 10:26:00", updated_at: null },
    ];
    state.rows["order_events:"] = [{ shipment_id: "a", occurred_at: "2026-10-03T01:13:29Z" }];

    const data = await getReturnsReceptionData();

    expect(data.shalom.porRecibir.map((r) => r.id)).toEqual(["b"]);
    expect(data.shalom.recibidas.map((r) => [r.id, r.received_at])).toEqual([["a", "2026-10-03T01:13:29Z"]]);
    const shalom = state.calls.find((c) => c.table === "shipments" && c.filters.some(([k, v]) => k === "eq:courier" && v === "shalom"))!;
    expect(shalom.filters).toEqual(
      expect.arrayContaining([
        ["neq:delivery_status", "entregado"],
        ["or:custody_state.in.(retorno,devuelto),returned_at.not.is.null", undefined],
      ]),
    );
    expect(data.tanders).toEqual({ recibidas: [], faltan: [], enCamino: [] });
  });

  it.each(["shipments:shalom", "shipments:tanders"])("si no se puede leer %s, lanza en vez de decir que no falta nada", async (table) => {
    state.failTable = table;
    await expect(getReturnsReceptionData()).rejects.toThrow("57014 statement timeout");
  });

  it("tampoco da por no recibidas las cajas si falla la lectura de las recepciones", async () => {
    state.rows["shipments:shalom"] = [
      { id: "a", guide_code: "92083386", order_name: "#KP128064", custody_state: "retorno", returned_at: null, closed_at: null, updated_at: null },
    ];
    state.failKind = "return_received";
    await expect(getReturnsReceptionData()).rejects.toThrow("recepciones en almacén");
  });
});

describe("getReturnsReceptionData · Grupo GF (05-11-2026)", () => {
  const PENDING = {
    shipmentId: "s-1", replaced: false, orderId: "o-1", orderName: "#KP201949", customerName: "Clienta Privada",
    district: "Surco", riderName: "Yhoni", routeDate: "2026-11-04", reason: "no_contesta", code: "KP201949-S01",
  };

  it("lo que sigue en cajas sale de la lista de Despacho del día, acotada a las tiendas que el usuario ve, sin datos del cliente", async () => {
    state.rows["stores:"] = [{ id: "store-1" }, { id: "store-2" }];
    state.pending = [PENDING];
    const data = await getReturnsReceptionData();
    expect(state.pendingScopes).toEqual([{ storeIds: ["store-1", "store-2"] }]);
    expect(data.gf.pendientes).toEqual([
      { shipmentId: "s-1", orderName: "#KP201949", code: "KP201949-S01", riderName: "Yhoni", routeDate: "2026-11-04", reason: "no_contesta", replaced: false },
    ]);
    expect(JSON.stringify(data.gf)).not.toContain("Clienta Privada");
  });

  it("sin tiendas visibles no lee nada de otra organización", async () => {
    await getReturnsReceptionData();
    expect(state.pendingScopes).toEqual([{ storeIds: [] }]);
  });

  it("lo recibido hoy: `returned_to_office` de `dispatch_events` del día Lima, una vez por salida y sin «Mover» en la oficina", async () => {
    // `dispatch_events` y no `order_events`: `gf_return_to_office` lo escribe
    // en sus dos ramas. La de stock o inventario (el anulado en la tienda, la
    // reemplazada, la que ya constaba devuelta) en `order_events` solo deja un
    // `return_received`, y no siempre: contarlo de ahí dejaba X quieto mientras
    // «Esta tanda» sumaba. «b» es una de esas (to_stock).
    state.rows["dispatch_events:gf"] = [
      { shipment_id: "a", payload: {} },
      { shipment_id: "a", payload: {} },
      { shipment_id: "b", payload: { stop_id: "st-1", to_stock: true, store_cancelled: true } },
      { shipment_id: "c", payload: { reclaimed_in_office: true } },
    ];
    const data = await getReturnsReceptionData();
    expect(data.gf.recibidasHoy).toBe(2);
    expect(state.calls.some((c) => c.table === "order_events" && c.filters.some(([k, v]) => k === "eq:kind" && v === "returned_to_office"))).toBe(false);
    const read = state.calls.find((c) => c.table === "dispatch_events" && c.filters.some(([k, v]) => k === "eq:kind" && v === "returned_to_office"))!;
    const gte = read.filters.find(([k]) => k === "gte:occurred_at")?.[1] as string;
    const lt = read.filters.find(([k]) => k === "lt:occurred_at")?.[1] as string;
    // Medianoche de Lima (UTC-5) a medianoche de Lima.
    expect(gte).toMatch(/T05:00:00\.000Z$/);
    expect(Date.parse(lt) - Date.parse(gte)).toBe(86_400_000);
  });

  it("si falla la lista de cajas, lanza: «0 en cajas» mandaría a dar por recibido lo que nadie trajo", async () => {
    state.pendingFails = true;
    await expect(getReturnsReceptionData()).rejects.toThrow("devoluciones de Grupo GF: 57014 statement timeout");
  });

  it("si falla la lectura de lo recibido hoy o de las tiendas, también lanza", async () => {
    state.failKind = "returned_to_office";
    await expect(getReturnsReceptionData()).rejects.toThrow("recepciones de Grupo GF en oficina");
    state.failKind = null;
    state.failTable = "stores";
    await expect(getReturnsReceptionData()).rejects.toThrow("tiendas de Grupo GF");
  });
});
