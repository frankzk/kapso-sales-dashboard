import { describe, expect, it, vi } from "vitest";

/**
 * LA VISTA NO PUEDE LLEGAR VACÍA CUANDO LA BASE DEVOLVIÓ FILAS.
 *
 * EL CASO, 15-09-2026. La pestaña «En ruta» decía 591 y la tabla decía «Sin
 * envíos en esta vista». PostgREST había devuelto las 590 filas —content-range
 * `0-589/*` en los logs—, así que el dato existía y se perdía en el camino.
 *
 * La causa era un alias. `getStoreShipments` hacía:
 *
 *     const decididas = await withRecoveryState(sb, out);
 *     out.length = 0;
 *     out.push(...decididas);
 *
 * y `withRecoveryState` tiene un atajo: si ninguna fila es candidata a
 * recuperación devuelve EL MISMO array que recibió. `decididas === out`, vaciar
 * `out` vaciaba las dos referencias y el push no reponía nada. El atajo se toma
 * precisamente cuando la vista no tiene ninguna guía cerrada de Aliclik, o sea
 * en En ruta, Entregado y Transferido: se vaciaban siempre.
 *
 * Lo que lo volvió invisible seis días es que el CONTADOR sale de otra consulta
 * —`countByCategory`, sin ese paso— y seguía diciendo la verdad. El número
 * encima de la tabla y la tabla contaban cosas distintas.
 *
 * Por eso la prueba no mira el array intermedio ni la implementación: entra por
 * `getStoreShipments` y exige que lo que la base devuelve llegue entero.
 */

const FILAS_EN_RUTA = [
  {
    id: "g1",
    store_id: "s1",
    courier: "fenix",
    guide_code: "50000130971",
    delivery_status: "en_ruta",
    status_category: "in_route",
    order_id: "o1",
    matched: true,
    order_name: "#KP132394",
    city: "lima",
    district: "Lurigancho-Chosica",
    reported_status: null,
    closed_at: null,
    returned_at: null,
    updated_at: "2026-09-15T02:00:00.000Z",
  },
  {
    id: "g2",
    store_id: "s1",
    courier: "aliclik",
    guide_code: "AUR5X161149432479",
    delivery_status: "en_ruta",
    status_category: "in_route",
    order_id: "o2",
    matched: true,
    order_name: "#KP131632",
    city: "arequipa",
    district: "Cayma",
    reported_status: null,
    closed_at: null,
    returned_at: null,
    updated_at: "2026-09-15T01:00:00.000Z",
  },
];

/** Cliente mínimo: cada tabla devuelve lo suyo y cualquier encadenado se ignora. */
function supabaseFalso(porTabla: Record<string, unknown[]>) {
  const from = (tabla: string) => {
    const q: Record<string, unknown> = {};
    for (const metodo of [
      "select", "in", "not", "eq", "neq", "gte", "lt", "is", "or", "order", "range", "limit",
    ]) {
      q[metodo] = () => q;
    }
    q.then = (ok: (v: unknown) => unknown, fail?: (e: unknown) => unknown) =>
      Promise.resolve({ data: porTabla[tabla] ?? [], error: null }).then(ok, fail);
    return q;
  };
  return { from };
}

const tablas: Record<string, unknown[]> = {
  shipments: FILAS_EN_RUTA,
  shipment_calls: [],
  stores: [{ id: "s1", org_id: "org1" }],
  fenix_stock: [],
  orders: [],
  order_events: [],
};

vi.mock("@/lib/db", () => ({
  createServerSupabase: async () => supabaseFalso(tablas),
}));

const { getStoreShipments } = await import("@/lib/shipments-access");

describe("getStoreShipments no pierde las filas que la base devolvió", () => {
  it("«En ruta» entrega las mismas guías que trajo la consulta", async () => {
    const filas = await getStoreShipments(["s1"], "en_ruta");
    expect(filas).toHaveLength(FILAS_EN_RUTA.length);
    expect(filas.map((f) => f.id).sort()).toEqual(["g1", "g2"]);
  });

  it("y lo mismo en las otras vistas que no tienen cerradas de Aliclik", async () => {
    // Entregado y Transferido toman el mismo atajo de `withRecoveryState`, así
    // que se vaciaban por la misma razón. Arreglar solo «En ruta» dejaría la
    // trampa puesta en las otras dos.
    for (const vista of ["entregado", "transferido"] as const) {
      const filas = await getStoreShipments(["s1"], vista);
      expect(filas, vista).toHaveLength(FILAS_EN_RUTA.length);
    }
  });

  it("las filas conservan su identidad, no vuelven vacías ni a medias", async () => {
    const filas = await getStoreShipments(["s1"], "en_ruta");
    const fila = filas.find((f) => f.id === "g1");
    expect(fila?.guide_code).toBe("50000130971");
    expect(fila?.order_name).toBe("#KP132394");
    expect(fila?.store_id).toBe("s1");
  });
});
