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

const salida = (id: string, orderId: string | null) => ({
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
  it("deja fuera las salidas cuyo pedido ya no está Por armar", async () => {
    const double = supabaseDouble((call) => {
      if (call.table === "order_master") {
        // Sólo `vivo` sigue contado por el Master como Por armar.
        return [{ order_id: "pedido-vivo", macro_operation: "lima" }];
      }
      if (call.eq.some(([col, val]) => col === "preparation_state" && val === "listo_despacho")) {
        return [{ ...salida("armada", "pedido-vivo"), preparation_state: "listo_despacho", ready_at: "2026-08-07T15:00:00Z" }];
      }
      return [salida("s1", "pedido-vivo"), salida("s2", "pedido-cancelado"), salida("s3", null)];
    });
    createServerSupabaseMock.mockResolvedValue(double.client);

    const data = await getWarehouseStationData();

    expect(data.pending.map((s) => s.id)).toEqual(["s1"]);
    expect(data.pending[0]?.operation).toBe("lima");
    expect(data.armedToday.map((s) => s.id)).toEqual(["armada"]);
    expect(data.pendingOmitted).toBe(0);
  });

  it("pide sólo lo que sigue en casa sin armar, y lo armado desde el corte del día", async () => {
    const double = supabaseDouble(() => []);
    createServerSupabaseMock.mockResolvedValue(double.client);

    await getWarehouseStationData();

    const [pendientes, armadas] = double.calls;
    expect(pendientes?.eq).toContainEqual(["custody_state", "empresa"]);
    expect(pendientes?.in).toContainEqual(["preparation_state", ["rotulo_generado", "en_armado"]]);
    expect(armadas?.eq).toContainEqual(["preparation_state", "listo_despacho"]);
    // El corte del día de Lima es 05:00Z: sin él, "armados hoy" arrastraría ayer.
    expect(armadas?.gte[0]?.[0]).toBe("ready_at");
    expect(String(armadas?.gte[0]?.[1])).toMatch(/T05:00:00\.000Z$/);
  });

  it("no consulta el Master cuando no hay nada pendiente", async () => {
    const double = supabaseDouble(() => []);
    createServerSupabaseMock.mockResolvedValue(double.client);

    const data = await getWarehouseStationData();

    expect(double.calls.some((call) => call.table === "order_master")).toBe(false);
    expect(data.pending).toEqual([]);
  });
});
