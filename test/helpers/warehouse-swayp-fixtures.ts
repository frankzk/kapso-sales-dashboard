// «Swayp por salir · Lima»: un lote armado con el constructor de verdad
// (`buildWarehouseSwayp`), para las pruebas de la pantalla y de la estación.
// Las filas imitan las de producción del 03-11-2026 (leídas con SELECT), con
// nombres de clientes y personas cambiados; los casos de «Salieron», «Revisar»,
// la hermana de Grupo GF y la tardía están puestos a mano.
//
// Martes 3 nov, 17:42 de Lima: el lote de hoy salió (una sin armar) y el del
// miércoles 4 nov se está armando.

import {
  buildWarehouseSwayp,
  type SwaypCallRow,
  type SwaypEmissionRow,
  type SwaypInput,
  type SwaypOrderRow,
  type SwaypShipmentRow,
  type WarehouseSwaypData,
} from "@/lib/warehouse-swayp";

export const SWAYP_STORE = "store-1";
/** Mar 3 nov, 17:42 de Lima. */
export const SWAYP_NOW = new Date("2026-11-03T22:42:00Z");
/** Un instante de Lima (UTC−5). */
export const limaAt = (day: string, time: string): Date => new Date(`${day}T${time}:00-05:00`);

export function swaypShipment(id: string, extra: Partial<SwaypShipmentRow> = {}): SwaypShipmentRow {
  return {
    id, store_id: SWAYP_STORE, courier: "fenix", guide_code: null, swayp_guide: null, swayp_state: 1,
    delivery_status: "en_ruta", status_category: "in_route", order_id: `o-${id}`, order_name: null,
    customer_name: "Cliente", product: "Producto", district: "Surco", city: "lima", province: null,
    next_followup_at: "2026-11-04T00:00:00+00:00", created_at: "2026-11-03T15:00:00Z", output_code: `${id}-S01`,
    output_number: 1, preparation_state: "no_iniciado", custody_state: "empresa", ready_at: null, ready_by: null,
    custody_transferred_at: null, dispatched_at: null, returned_at: null, ...extra,
  };
}

function order(orderId: string, extra: Partial<SwaypOrderRow> = {}): SwaypOrderRow {
  return {
    order_id: orderId, store_id: SWAYP_STORE, order_name: `#${orderId}`, customer_name: "Cliente", macro_operation: "lima",
    general_status: "en_proceso", product_titles: ["Producto"], district: "Surco", province: "Lima", region: "Lima (provincia)",
    cancelled_at: null, ...extra,
  };
}

function call(shipmentId: string, occurredAt: string, extra: Partial<SwaypCallRow> = {}): SwaypCallRow {
  return { shipment_id: shipmentId, agent: "u-asesora-a", kind: "reroute", note: "Guía Swayp directa creada", occurred_at: occurredAt, next_followup_at: null, ...extra };
}

interface Guide {
  shipment: SwaypShipmentRow;
  order: SwaypOrderRow;
  emission: SwaypEmissionRow;
  call: SwaypCallRow;
}

/** Una guía Swayp directa de Lima: salida `sh-<código>`, pedido `o-<KP…>`, su emisión y la gestión de quien la creó. */
export function swaypLimaGuide(code: string, opts: {
  day?: string;
  guide: string;
  district?: string;
  customer?: string;
  createdAt: string;
  emittedAt: string;
  readyAt?: string | null;
  readyBy?: string | null;
  agent?: string | null;
  extra?: Partial<SwaypShipmentRow>;
  orderExtra?: Partial<SwaypOrderRow>;
}): Guide {
  const id = `sh-${code}`;
  const base = code.split("-")[0]!;
  const orderId = `o-${base}`;
  const day = opts.day ?? "2026-11-04";
  return {
    shipment: swaypShipment(id, {
      order_id: orderId, order_name: `#${base}`, output_code: code, output_number: Number(code.slice(-2)),
      guide_code: opts.guide, swayp_guide: opts.guide, district: opts.district ?? "Surco", customer_name: opts.customer ?? "Cliente",
      next_followup_at: `${day}T00:00:00+00:00`, created_at: opts.createdAt,
      preparation_state: opts.readyAt ? "listo_despacho" : "no_iniciado", ready_at: opts.readyAt ?? null, ready_by: opts.readyBy ?? null,
      ...opts.extra,
    }),
    order: order(orderId, { order_name: `#${base}`, ...opts.orderExtra }),
    emission: {
      id: `e-${code}`, source_key: `direct:${orderId}:${day}T00:00:00.000Z`, order_id: orderId, store_id: SWAYP_STORE, automatic: false,
      state: "created", guide_code: opts.guide, child_id: id, created_at: opts.emittedAt,
    },
    call: call(id, new Date(Date.parse(opts.emittedAt) + 1500).toISOString(), {
      agent: opts.agent === undefined ? "u-asesora-a" : opts.agent,
      next_followup_at: `${day}T00:00:00+00:00`,
    }),
  };
}

export function swaypInput(guides: Guide[], more: Partial<SwaypInput> = {}): SwaypInput {
  return {
    shipments: [...guides.map((g) => g.shipment), ...(more.shipments ?? [])],
    orders: [...guides.map((g) => g.order), ...(more.orders ?? [])],
    emissions: [...guides.map((g) => g.emission), ...(more.emissions ?? [])],
    calls: [...guides.map((g) => g.call), ...(more.calls ?? [])],
    names: { "u-asesora-a": "Asesora A", "u-asesora-b": "Asesora B", "u-almacen-a": "Almacén A", "u-almacen-b": "Almacén B", ...(more.names ?? {}) },
    storeNames: more.storeNames ?? { [SWAYP_STORE]: "Kenku Peru" },
  };
}

/**
 * El lote de la pantalla, a las 17:42 del martes 3 nov:
 * - Mañana (mié 4 nov), 4 programadas, 2 armadas, faltan 2:
 *   KP143987-S02 (salida nueva; su S01 de Aliclik volvió a la oficina) y
 *   KP7-S02 (la caja está armada como KP7-S01 de Grupo GF, D4). Armadas:
 *   KP30-S01 y KP31-S01, esta agregada a las 17:30. Salieron: KP10-S01 (Swayp
 *   la canceló, estaba armada) y KP14-S01 (ahora sale el viernes 6 nov).
 *   Revisar: KP4-S01 (agencia). Provincia: una de Arequipa.
 * - Hoy (mar 3 nov), 2 programadas, 1 armada (como «por definir»), falta
 *   KP40-S01: sigue en la empresa y Swayp aún no la tomó.
 */
export function swaypLotInput(): SwaypInput {
  const s02 = swaypLimaGuide("KP143987-S02", {
    guide: "50000165022", district: "san bartolo", customer: "Cliente Ejemplo", agent: "u-asesora-b",
    createdAt: "2026-11-03T05:11:10.904Z", emittedAt: "2026-11-03T05:11:09.552Z",
    extra: { product: "ASTAXANTINA – Antioxidante De Alta Potencia (120 Cápsulas)" },
  });
  const aliclikS01 = swaypShipment("sh-KP143987-S01", {
    order_id: s02.order.order_id, courier: "aliclik", guide_code: "AUR5X246218871979", output_code: "KP143987-S01", output_number: 1,
    preparation_state: "listo_despacho", custody_state: "devuelto", ready_at: "2026-10-25T20:58:30Z", delivery_status: "anulado",
    status_category: "closed", swayp_state: null, returned_at: "2026-11-02T18:51:16Z", next_followup_at: "2026-10-25T17:00:00+00:00",
    created_at: "2026-10-25T20:53:31Z",
  });
  const gfCase = swaypLimaGuide("KP7-S02", { guide: "50000165030", district: "Ate", createdAt: "2026-11-03T16:00:00Z", emittedAt: "2026-11-03T16:00:00Z" });
  const gfS01 = swaypShipment("sh-KP7-S01", {
    order_id: gfCase.order.order_id, courier: "propio", guide_code: "GF-7", output_code: "KP7-S01", output_number: 1,
    preparation_state: "listo_despacho", custody_state: "empresa", ready_at: "2026-11-03T14:00:00Z",
    delivery_status: "anulado", status_category: "closed", swayp_state: null, next_followup_at: null,
  });
  const armed = swaypLimaGuide("KP30-S01", {
    guide: "50000165040", district: "Cieneguilla", createdAt: "2026-11-03T15:00:00Z", emittedAt: "2026-11-03T15:00:00Z",
    readyAt: "2026-11-03T21:00:00Z", readyBy: "u-almacen-b",
  });
  const late = swaypLimaGuide("KP31-S01", {
    guide: "50000165041", district: "Los Olivos", createdAt: "2026-11-03T22:30:00Z", emittedAt: "2026-11-03T22:30:00Z",
    readyAt: "2026-11-03T22:40:00Z", readyBy: "u-almacen-a",
  });
  const cancelled = swaypLimaGuide("KP10-S01", {
    guide: "50000165050", createdAt: "2026-11-03T15:00:00Z", emittedAt: "2026-11-03T15:00:00Z",
    extra: { delivery_status: "anulado", status_category: "closed", swayp_state: 10, preparation_state: "listo_despacho", ready_at: "2026-11-03T16:00:00Z" },
  });
  const moved = swaypLimaGuide("KP14-S01", {
    guide: "50000165051", createdAt: "2026-11-03T15:00:00Z", emittedAt: "2026-11-03T15:00:00Z", readyAt: "2026-11-03T16:30:00Z",
  });
  moved.shipment = { ...moved.shipment, next_followup_at: "2026-11-06T00:00:00+00:00" };
  const moveCall = call(moved.shipment.id, "2026-11-03T22:20:00Z", { kind: "call", agent: null, next_followup_at: "2026-11-06T00:00:00+00:00" });
  const agencia = swaypLimaGuide("KP4-S01", {
    guide: "50000165060", createdAt: "2026-11-03T15:00:00Z", emittedAt: "2026-11-03T15:00:00Z", orderExtra: { macro_operation: "agencia" },
  });
  const provincia = swaypLimaGuide("KP50-S01", {
    guide: "50000165070", createdAt: "2026-11-03T15:00:00Z", emittedAt: "2026-11-03T15:00:00Z",
    extra: { city: "arequipa", district: "Cerro Colorado" }, orderExtra: { macro_operation: "provincia_cod" },
  });
  const todayArmed = swaypLimaGuide("KP201878-S01", {
    day: "2026-11-03", guide: "50000164617", district: "La Victoria", createdAt: "2026-11-02T12:06:37Z", emittedAt: "2026-11-02T21:02:13Z",
    readyAt: "2026-11-02T12:19:37Z", readyBy: "u-almacen-a",
  });
  const todayMissing = swaypLimaGuide("KP40-S01", {
    day: "2026-11-03", guide: "50000164700", district: "Ate", createdAt: "2026-11-02T20:00:00Z", emittedAt: "2026-11-02T20:00:00Z",
  });
  return swaypInput(
    [s02, gfCase, armed, late, cancelled, moved, agencia, provincia, todayArmed, todayMissing],
    { shipments: [aliclikS01, gfS01], calls: [moveCall] },
  );
}

export function swaypLot(now: Date = SWAYP_NOW, input: SwaypInput = swaypLotInput()): WarehouseSwaypData {
  return buildWarehouseSwayp(input, now);
}
