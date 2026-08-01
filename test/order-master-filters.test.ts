import { describe, expect, it } from "vitest";
import {
  agencySummary,
  applyFilters,
  emptyFilters,
  facetValues,
  hasActiveFilters,
  matchesFilters,
  sortRows,
  type MasterFilters,
} from "@/lib/order-master-filters";
import type { OrderMasterRow } from "@/lib/types";

const NOW = "2026-07-20T12:00:00.000Z";

function row(id: string, overrides: Partial<OrderMasterRow> = {}): OrderMasterRow {
  return {
    id,
    store_id: "store-a",
    order_id: `order-${id}`,
    order_name: `#KP${id}`,
    shopify_order_id: id,
    order_created_at: "2026-07-01T10:00:00.000Z",
    customer_name: "Ana Quispe",
    customer_phone: "51987654321",
    region: "Junín",
    province: "Huancayo",
    district: "El Tambo",
    address: "Av. Siempre Viva 123",
    reference: null,
    latitude: null,
    longitude: null,
    geo_source: "shopify",
    shipping_mode: "cod",
    order_total: 120,
    general_status: "en_proceso",
    operational_status: "en_ruta",
    status_since: "2026-07-05T10:00:00.000Z",
    status_source: "aliclik",
    status_locked: false,
    current_courier: "aliclik",
    last_courier: "aliclik",
    courier_count: 1,
    attempt_count: 0,
    guide_code: `AUR5X${id}`,
    dispatched_at: "2026-07-04T10:00:00.000Z",
    delivered_at: null,
    delivered_courier: null,
    returned_at: null,
    last_movement_at: "2026-07-18T10:00:00.000Z",
    comment_count: 0,
    logistics_cost: null,
    pickup_state: null,
    payment_state: null,
    key_state: null,
    agency_branch: null,
    agency_arrived_at: null,
    agency_expires_at: null,
    ...overrides,
  };
}

function withFilter(patch: Partial<MasterFilters>): MasterFilters {
  return { ...emptyFilters(), ...patch };
}

describe("matchesFilters — dimensiones multi-selección", () => {
  it("un conjunto vacío no filtra nada", () => {
    expect(matchesFilters(row("1"), emptyFilters(), NOW)).toBe(true);
    expect(hasActiveFilters(emptyFilters())).toBe(false);
  });

  it("filtra por varias provincias a la vez (§13)", () => {
    const huancayo = row("1", { province: "Huancayo" });
    const cusco = row("2", { province: "Cusco" });
    const lima = row("3", { province: "Lima" });
    const f = withFilter({ provinces: new Set(["Huancayo", "Cusco"]) });
    expect(applyFilters([huancayo, cusco, lima], f, NOW).map((r) => r.id)).toEqual(["1", "2"]);
  });

  it("filtra por región y distrito", () => {
    const f = withFilter({ regions: new Set(["Junín"]), districts: new Set(["El Tambo"]) });
    expect(matchesFilters(row("1"), f, NOW)).toBe(true);
    expect(matchesFilters(row("2", { district: "Chilca" }), f, NOW)).toBe(false);
  });

  it("una fila sin valor en la dimensión filtrada queda fuera", () => {
    const f = withFilter({ provinces: new Set(["Huancayo"]) });
    expect(matchesFilters(row("1", { province: null }), f, NOW)).toBe(false);
  });

  it("el filtro de courier mira el actual y el último", () => {
    const f = withFilter({ couriers: new Set(["fenix"]) });
    // Ya pasó a otra guía, pero Fenix lo gestionó: debe seguir apareciendo.
    expect(matchesFilters(row("1", { current_courier: "shalom", last_courier: "fenix" }), f, NOW)).toBe(true);
    expect(matchesFilters(row("2", { current_courier: "aliclik", last_courier: "aliclik" }), f, NOW)).toBe(false);
  });

  it("filtra por estado general y operativo", () => {
    const f = withFilter({
      generalStatuses: new Set(["entregado"]),
      operationalStatuses: new Set(["recogido"]),
    });
    expect(matchesFilters(row("1", { general_status: "entregado", operational_status: "recogido" }), f, NOW)).toBe(true);
    expect(matchesFilters(row("2", { general_status: "entregado", operational_status: "entregado" }), f, NOW)).toBe(false);
  });
});

describe("matchesFilters — fechas", () => {
  it("acota por fecha de creación, extremos inclusive", () => {
    const f = withFilter({ createdFrom: "2026-07-01", createdTo: "2026-07-01" });
    expect(matchesFilters(row("1"), f, NOW)).toBe(true);
    expect(matchesFilters(row("2", { order_created_at: "2026-07-02T00:00:00.000Z" }), f, NOW)).toBe(false);
  });

  it("acota por fecha de despacho, de entrega y de último movimiento", () => {
    expect(matchesFilters(row("1"), withFilter({ dispatchedFrom: "2026-07-04" }), NOW)).toBe(true);
    expect(matchesFilters(row("1"), withFilter({ dispatchedFrom: "2026-07-05" }), NOW)).toBe(false);
    expect(matchesFilters(row("1"), withFilter({ movementTo: "2026-07-17" }), NOW)).toBe(false);
    expect(
      matchesFilters(row("1", { delivered_at: "2026-07-09T10:00:00.000Z" }), withFilter({ deliveredFrom: "2026-07-09" }), NOW),
    ).toBe(true);
  });

  it("una fila sin la fecha filtrada queda fuera", () => {
    expect(matchesFilters(row("1", { delivered_at: null }), withFilter({ deliveredFrom: "2026-07-01" }), NOW)).toBe(false);
  });
});

describe("matchesFilters — banderas operativas", () => {
  it("con comentarios", () => {
    const f = withFilter({ withComments: true });
    expect(matchesFilters(row("1", { comment_count: 2 }), f, NOW)).toBe(true);
    expect(matchesFilters(row("2", { comment_count: 0 }), f, NOW)).toBe(false);
  });

  it("más de un courier y más de un intento", () => {
    expect(matchesFilters(row("1", { courier_count: 2 }), withFilter({ multiCourier: true }), NOW)).toBe(true);
    expect(matchesFilters(row("2", { courier_count: 1 }), withFilter({ multiCourier: true }), NOW)).toBe(false);
    expect(matchesFilters(row("3", { attempt_count: 3 }), withFilter({ multiAttempt: true }), NOW)).toBe(true);
    expect(matchesFilters(row("4", { attempt_count: 1 }), withFilter({ multiAttempt: true }), NOW)).toBe(false);
  });

  it("sin movimientos recientes incluye a los que nunca se movieron", () => {
    const f = withFilter({ staleDays: 5 });
    // Último movimiento hace 2 días → tiene movimiento reciente, queda fuera.
    expect(matchesFilters(row("1", { last_movement_at: "2026-07-18T10:00:00.000Z" }), f, NOW)).toBe(false);
    // Hace 10 días → entra.
    expect(matchesFilters(row("2", { last_movement_at: "2026-07-10T10:00:00.000Z" }), f, NOW)).toBe(true);
    // Nunca se movió → es justamente el que nadie está mirando: entra.
    expect(matchesFilters(row("3", { last_movement_at: null }), f, NOW)).toBe(true);
  });

  it("la búsqueda libre cubre código, cliente, teléfono y guía", () => {
    const r = row("114985", { order_name: "#KP114985", guide_code: "AUR5XABC" });
    expect(matchesFilters(r, withFilter({ search: "kp114985" }), NOW)).toBe(true);
    expect(matchesFilters(r, withFilter({ search: "#KP114985" }), NOW)).toBe(true);
    expect(matchesFilters(r, withFilter({ search: "aur5xabc" }), NOW)).toBe(true);
    expect(matchesFilters(r, withFilter({ search: "quispe" }), NOW)).toBe(true);
    expect(matchesFilters(r, withFilter({ search: "987654321" }), NOW)).toBe(true);
    expect(matchesFilters(r, withFilter({ search: "zzz" }), NOW)).toBe(false);
  });

  it("los filtros se combinan (AND)", () => {
    const f = withFilter({
      generalStatuses: new Set(["en_proceso"]),
      provinces: new Set(["Huancayo"]),
      multiAttempt: true,
    });
    expect(matchesFilters(row("1", { attempt_count: 2 }), f, NOW)).toBe(true);
    expect(matchesFilters(row("2", { attempt_count: 0 }), f, NOW)).toBe(false);
    expect(hasActiveFilters(f)).toBe(true);
  });
});

describe("sortRows", () => {
  it("ordena por fecha de creación descendente para la regla fija del Master", () => {
    const antiguo = row("1", { order_created_at: "2026-07-10T10:00:00.000Z" });
    const nuevo = row("2", { order_created_at: "2026-07-18T10:00:00.000Z" });
    expect(sortRows([antiguo, nuevo], "created").map((r) => r.id)).toEqual(["2", "1"]);
  });

  it("ordena por último movimiento descendente por defecto", () => {
    const a = row("1", { last_movement_at: "2026-07-10T10:00:00.000Z" });
    const b = row("2", { last_movement_at: "2026-07-18T10:00:00.000Z" });
    expect(sortRows([a, b], "movement").map((r) => r.id)).toEqual(["2", "1"]);
    expect(sortRows([a, b], "movement", "asc").map((r) => r.id)).toEqual(["1", "2"]);
  });

  it("por fecha de creación deja el correlativo corrido pese al último movimiento", () => {
    // Caso real: una importación de reporte mueve a la vez pedidos salteados
    // del correlativo. Ordenando por creación no deben adelantar a sus vecinos.
    const lote = "2026-07-26T21:11:05.000Z";
    const c144 = row("144", { order_created_at: "2026-07-24T04:40:00.000Z", last_movement_at: lote });
    const c145 = row("145", { order_created_at: "2026-07-24T04:50:00.000Z", last_movement_at: "2026-07-24T20:56:00.000Z" });
    const c146 = row("146", { order_created_at: "2026-07-24T06:10:00.000Z", last_movement_at: lote });
    expect(sortRows([c144, c145, c146], "created").map((r) => r.id)).toEqual(["146", "145", "144"]);
    // Por último movimiento sí se agrupan los del lote y el 145 cae al final.
    expect(sortRows([c144, c145, c146], "movement").map((r) => r.id)).toEqual(["144", "146", "145"]);
  });

  it("los nulos van al final en ambas direcciones", () => {
    const a = row("1", { last_movement_at: null });
    const b = row("2", { last_movement_at: "2026-07-18T10:00:00.000Z" });
    expect(sortRows([a, b], "movement").map((r) => r.id)).toEqual(["2", "1"]);
    expect(sortRows([a, b], "movement", "asc").map((r) => r.id)).toEqual(["2", "1"]);
  });

  it("ordena por intentos y por couriers", () => {
    const a = row("1", { attempt_count: 1, courier_count: 3 });
    const b = row("2", { attempt_count: 5, courier_count: 1 });
    expect(sortRows([a, b], "attempts").map((r) => r.id)).toEqual(["2", "1"]);
    expect(sortRows([a, b], "couriers").map((r) => r.id)).toEqual(["1", "2"]);
  });

  it("no muta el arreglo de entrada", () => {
    const rows = [row("1", { attempt_count: 1 }), row("2", { attempt_count: 9 })];
    sortRows(rows, "attempts");
    expect(rows.map((r) => r.id)).toEqual(["1", "2"]);
  });
});

describe("facetValues", () => {
  it("devuelve valores únicos y ordenados, ignorando nulos", () => {
    const rows = [
      row("1", { province: "Huancayo" }),
      row("2", { province: "Cusco" }),
      row("3", { province: "Huancayo" }),
      row("4", { province: null }),
    ];
    expect(facetValues(rows, "province")).toEqual(["Cusco", "Huancayo"]);
  });
});

describe("agencia (§10)", () => {
  function agencyRow(id: string, over: Partial<OrderMasterRow> = {}): OrderMasterRow {
    return row(id, {
      shipping_mode: "agency",
      current_courier: "shalom",
      last_courier: "shalom",
      pickup_state: "disponible_para_recojo",
      agency_branch: "Shalom Huancayo",
      agency_arrived_at: "2026-07-14T10:00:00.000Z",
      agency_expires_at: "2026-07-30T10:00:00.000Z",
      ...over,
    });
  }

  it("filtra por sub-estado de agencia", () => {
    const f = withFilter({ pickupStates: new Set(["retorno_iniciado"]) });
    expect(matchesFilters(agencyRow("1", { pickup_state: "retorno_iniciado" }), f, NOW)).toBe(true);
    expect(matchesFilters(agencyRow("2"), f, NOW)).toBe(false);
  });

  it("próximo a vencer incluye lo que vence dentro de 3 días y lo ya vencido", () => {
    const f = withFilter({ expiringSoon: true });
    expect(matchesFilters(agencyRow("1", { agency_expires_at: "2026-07-22T10:00:00.000Z" }), f, NOW)).toBe(true);
    expect(matchesFilters(agencyRow("2", { agency_expires_at: "2026-07-18T10:00:00.000Z" }), f, NOW)).toBe(true);
    expect(matchesFilters(agencyRow("3", { agency_expires_at: "2026-07-30T10:00:00.000Z" }), f, NOW)).toBe(false);
    // Un pedido sin fecha límite no puede estar "por vencer".
    expect(matchesFilters(agencyRow("4", { agency_expires_at: null }), f, NOW)).toBe(false);
  });

  it("el resumen cuenta lo accionable y separa los ya devueltos", () => {
    const summary = agencySummary(
      [
        agencyRow("1"),
        agencyRow("2", { pickup_state: "pendiente_de_recojo", agency_expires_at: "2026-07-21T10:00:00.000Z" }),
        agencyRow("3", { pickup_state: "retorno_iniciado" }),
        agencyRow("4", { pickup_state: "devuelto_al_origen", general_status: "devuelto" }),
        row("5"), // reparto normal: no cuenta
      ],
      NOW,
    );
    expect(summary).toEqual({
      total: 4,
      disponibles: 2,
      proximosAVencer: 1,
      retornoIniciado: 1,
      devueltos: 1,
    });
  });
});
