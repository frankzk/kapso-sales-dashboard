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
  rows: {} as Record<string, unknown[]>,
}));

vi.mock("@/lib/db", () => ({
  createServerSupabase: async () => ({
    from: (table: string) => {
      const call: Call = { table, filters: [] };
      state.calls.push(call);
      const q: Record<string, unknown> = {};
      for (const m of ["select", "eq", "neq", "in", "or", "limit"]) q[m] = (col: unknown, val?: unknown) => (call.filters.push([`${m}:${String(col)}`, val]), q);
      const courier = () => call.filters.find(([k]) => k === "eq:courier")?.[1] as string | undefined;
      const result = () =>
        state.failTable === `${table}:${courier() ?? ""}` || state.failTable === table
          ? { data: null, error: { message: "57014 statement timeout" } }
          : { data: state.rows[`${table}:${courier() ?? ""}`] ?? [], error: null };
      q.then = (resolve: (r: unknown) => unknown, reject: (e: unknown) => unknown) => Promise.resolve(result()).then(resolve, reject);
      return q;
    },
  }),
  createAdminSupabase: vi.fn(),
}));

import { getReturnsReceptionData } from "@/lib/dispatch-access";

beforeEach(() => {
  Object.assign(state, { calls: [], failTable: null, rows: {} });
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
    state.failTable = "order_events";
    await expect(getReturnsReceptionData()).rejects.toThrow("recepciones en almacén");
  });
});
