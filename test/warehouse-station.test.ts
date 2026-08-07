import { describe, expect, it, vi } from "vitest";

const { createServerSupabaseMock } = vi.hoisted(() => ({ createServerSupabaseMock: vi.fn() }));

vi.mock("@/lib/db", () => ({
  createServerSupabase: createServerSupabaseMock,
  createAdminSupabase: vi.fn(),
}));

import { getWarehouseStationData } from "@/lib/dispatch-access";

interface Call {
  table: string;
  eq: [string, unknown][];
  in: [string, unknown][];
  gte: [string, unknown][];
}

/**
 * Doble de PostgREST: registra las restricciones y deja que el caso decida qué
 * filas devuelve cada consulta. Lo que se comprueba es la REGLA de la cola, no
 * la base.
 */
function supabaseDouble(resolve: (call: Call) => unknown[]) {
  const calls: Call[] = [];
  return {
    calls,
    /** La consulta que trae las salidas por armar (la que acota por pedido). */
    pendingCall: () => calls.find((c) => c.table === "shipments" && c.in.some(([col]) => col === "order_id")),
    armedCall: () => calls.find((c) => c.table === "shipments" && c.gte.length > 0),
    client: {
      from(table: string) {
        const call: Call = { table, eq: [], in: [], gte: [] };
        calls.push(call);
        const builder: Record<string, unknown> = {};
        const chain = (fn?: (...args: unknown[]) => void) =>
          (...args: unknown[]) => {
            fn?.(...args);
            return builder;
          };
        Object.assign(builder, {
          select: chain(),
          order: chain(),
          limit: chain(),
          eq: chain((col, val) => call.eq.push([col as string, val])),
          in: chain((col, val) => call.in.push([col as string, val])),
          gte: chain((col, val) => call.gte.push([col as string, val])),
          then: (done: (value: unknown) => unknown) => done({ data: resolve(call), error: null }),
        });
        return builder;
      },
    },
  };
}

const salida = (id: string, orderId: string) => ({
  id,
  store_id: "store-1",
  courier: "por_definir",
  guide_code: `G-${id}`,
  output_code: `KP-${id}`,
  order_id: orderId,
  order_name: `#KP-${id}`,
  custody_state: "empresa",
  preparation_state: "rotulo_generado",
  ready_at: null,
  customer_name: "Cliente",
  district: "San Borja",
});

describe("getWarehouseStationData", () => {
  it("baja desde los pedidos Por armar a sus salidas, con la operación de cada uno", async () => {
    const double = supabaseDouble((call) => {
      if (call.table === "order_master") {
        return [
          { order_id: "pedido-lima", macro_operation: "lima" },
          { order_id: "pedido-provincia", macro_operation: "provincia_cod" },
        ];
      }
      if (call.gte.length) {
        return [{ ...salida("armada", "pedido-lima"), preparation_state: "listo_despacho", ready_at: "2026-08-07T15:00:00Z" }];
      }
      return [salida("s1", "pedido-lima"), salida("s2", "pedido-provincia")];
    });
    createServerSupabaseMock.mockResolvedValue(double.client);

    const data = await getWarehouseStationData();

    expect(data.pending.map((s) => s.id)).toEqual(["s1", "s2"]);
    expect(data.pending.map((s) => s.operation)).toEqual(["lima", "provincia_cod"]);
    expect(data.armedToday.map((s) => s.id)).toEqual(["armada"]);
    expect(data.pendingOmitted).toBe(0);
  });

  it("acota las salidas a los pedidos Por armar, en casa y sin escanear", async () => {
    const double = supabaseDouble((call) =>
      call.table === "order_master" ? [{ order_id: "pedido-lima", macro_operation: "lima" }] : [],
    );
    createServerSupabaseMock.mockResolvedValue(double.client);

    await getWarehouseStationData();

    const pending = double.pendingCall();
    expect(pending?.in).toContainEqual(["order_id", ["pedido-lima"]]);
    expect(pending?.eq).toContainEqual(["custody_state", "empresa"]);
    expect(pending?.in).toContainEqual(["preparation_state", ["rotulo_generado", "en_armado"]]);

    const armed = double.armedCall();
    expect(armed?.eq).toContainEqual(["preparation_state", "listo_despacho"]);
    // El corte del día de Lima es 05:00Z: sin él, "armados hoy" arrastraría ayer.
    expect(String(armed?.gte[0]?.[1])).toMatch(/T05:00:00\.000Z$/);
  });

  it("no busca salidas cuando ningún pedido está Por armar", async () => {
    const double = supabaseDouble(() => []);
    createServerSupabaseMock.mockResolvedValue(double.client);

    const data = await getWarehouseStationData();

    expect(double.pendingCall()).toBeUndefined();
    expect(data.pending).toEqual([]);
  });
});
