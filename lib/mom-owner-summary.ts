import { CONFIRMATION_SIGNAL_KINDS } from "@/lib/order-confirmation";
import { ADELANTO_MINIMO } from "@/lib/adelanto-minimo";

const DAY_MS = 24 * 60 * 60 * 1000;

export type MomOwnerPeriodKey = "today" | "yesterday" | "last7" | "month" | "previous_month";
export type MomOwnerKpiKey =
  | "province_confirmation"
  | "agency_advance"
  | "aliclik_delivery"
  | "lima_delivery"
  | "agency_full_payment";
export type MomOwnerAlertKey =
  | "picked_without_payment"
  | "overdue_settlement"
  | "incomplete_manifest"
  | "stale_order";

export interface MomOwnerPeriod {
  key: MomOwnerPeriodKey;
  label: string;
  startIso: string;
  endIso: string;
}

export interface MomOwnerOrderFact {
  orderId: string;
  createdAt: string | null;
  coverage: string | null;
  orderTotal: number | null;
  stage: string | null;
  substage: string | null;
  reasons: string[];
  paymentState: string | null;
  deliveredAt: string | null;
  deliveredCourier: string | null;
  lastMovementAt: string | null;
}

export interface MomOwnerShipmentFact {
  id: string;
  orderId: string | null;
  courier: string | null;
  dispatchedAt: string | null;
  deliveryStatus: string | null;
  /** Creación de la guía. Para Shalom/Olva ES el despacho: la caja va a la agencia al crearla. */
  createdAt: string | null;
  /** Escaneo «listo despacho» en la Mesa. Para Lima es la última señal que existe. */
  readyAt: string | null;
  /** Entrega de custodia al motorizado. Cuando exista, gana sobre `readyAt`. */
  custodyTransferredAt: string | null;
}

/**
 * Cuándo se despachó una salida, según el courier.
 *
 * `dispatched_at` solo lo escribe Aliclik (auditado el 08-09-2026: 2.940 de
 * 3.145 salidas Aliclik lo tenían; Shalom, Tanders, propio, Urpi y las 2.641
 * salidas «por definir» de Lima, CERO). Mientras el tablero miraba solo ese
 * campo, «Entrega Lima total» y «Pago completo de Agencia» daban 0 de 0 con 740
 * pedidos Lima y 453 guías Shalom delante.
 *
 *   - Aliclik: `dispatched_at` y nada más. Una guía Aliclik lista en la Mesa
 *     pero que el motorizado no recogió NO está despachada, y contarla bajaría
 *     su tasa de entrega por algo que no es culpa del courier.
 *   - Shalom / Olva: la creación de la guía. Es el momento en que la caja va a
 *     la agencia; no hay ningún otro registro después.
 *   - El resto (Lima: por definir, Tanders, propio, Urpi): la entrega de
 *     custodia al motorizado si se registró, y si no el escaneo «listo
 *     despacho». Hoy la custodia nunca se registra, así que en la práctica es
 *     el escaneo — la última señal que existe de que la caja salió.
 */
export function dispatchSignalAt(shipment: MomOwnerShipmentFact): string | null {
  if (isCourier(shipment.courier, ["aliclik"])) return shipment.dispatchedAt;
  if (isCourier(shipment.courier, ["shalom", "olva"])) {
    return shipment.dispatchedAt ?? shipment.createdAt;
  }
  return shipment.dispatchedAt ?? shipment.custodyTransferredAt ?? shipment.readyAt;
}

export interface MomOwnerPaymentFact {
  orderId: string;
  amount: number;
  paidAt: string | null;
}

export interface MomOwnerEventFact {
  orderId: string;
  kind: string;
  occurredAt: string;
}

export interface MomOwnerManifestFact {
  id: string;
  state: string;
}

export interface MomOwnerKpiValue {
  numerator: number;
  denominator: number;
  rate: number | null;
}

export interface MomOwnerPeriodSummary extends MomOwnerPeriod {
  kpis: Record<MomOwnerKpiKey, MomOwnerKpiValue>;
}

export interface MomOwnerAlert {
  key: MomOwnerAlertKey;
  label: string;
  description: string;
  count: number;
  href: string;
}

export interface MomOwnerSummary {
  generatedAt: string;
  periods: MomOwnerPeriodSummary[];
  alerts: MomOwnerAlert[];
}

export interface BuildMomOwnerSummaryInput {
  today: string;
  nowIso?: string;
  orders: MomOwnerOrderFact[];
  shipments: MomOwnerShipmentFact[];
  payments: MomOwnerPaymentFact[];
  events: MomOwnerEventFact[];
  manifests: MomOwnerManifestFact[];
}

function dayMs(day: string): number {
  return Date.parse(`${day}T00:00:00.000Z`);
}

function dayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function addDays(day: string, amount: number): string {
  return dayKey(dayMs(day) + amount * DAY_MS);
}

function monthStart(day: string): string {
  return `${day.slice(0, 7)}-01`;
}

function previousMonthStart(day: string): string {
  const current = new Date(`${monthStart(day)}T00:00:00.000Z`);
  current.setUTCMonth(current.getUTCMonth() - 1);
  return current.toISOString().slice(0, 10);
}

function limaStartIso(day: string): string {
  return `${day}T05:00:00.000Z`;
}

export function momOwnerPeriods(today: string): MomOwnerPeriod[] {
  const currentMonth = monthStart(today);
  return [
    // «Hoy» es un día a medias y se lee como tal: la cohorte de esta mañana
    // apenas ha tenido tiempo de confirmarse o pagar, así que su tasa va a ser
    // baja a las 9 y subir durante el día. Está para ver ese progreso, no para
    // compararla con un día cerrado.
    {
      key: "today",
      label: "Hoy",
      startIso: limaStartIso(today),
      endIso: limaStartIso(addDays(today, 1)),
    },
    {
      key: "yesterday",
      label: "Ayer",
      startIso: limaStartIso(addDays(today, -1)),
      endIso: limaStartIso(today),
    },
    {
      key: "last7",
      label: "Últimos 7 días",
      startIso: limaStartIso(addDays(today, -6)),
      endIso: limaStartIso(addDays(today, 1)),
    },
    {
      key: "month",
      label: "Mes actual",
      startIso: limaStartIso(currentMonth),
      endIso: limaStartIso(addDays(today, 1)),
    },
    {
      key: "previous_month",
      label: "Mes anterior",
      startIso: limaStartIso(previousMonthStart(today)),
      endIso: limaStartIso(currentMonth),
    },
  ];
}

function inPeriod(value: string | null, period: MomOwnerPeriod): boolean {
  return Boolean(value && value >= period.startIso && value < period.endIso);
}

function normalizedCourier(value: string | null | undefined): string {
  return (value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase();
}

function isCourier(value: string | null | undefined, names: readonly string[]): boolean {
  const courier = normalizedCourier(value);
  return names.some((name) => courier === name || courier.includes(name));
}

function ratio(numerator: number, denominator: number): MomOwnerKpiValue {
  return {
    numerator,
    denominator,
    rate: denominator > 0 ? numerator / denominator : null,
  };
}

function uniqueOrderIds(rows: MomOwnerShipmentFact[]): Set<string> {
  return new Set(rows.map((row) => row.orderId).filter((id): id is string => Boolean(id)));
}

/**
 * Lo cobrado y validado por pedido, SIN mirar cuándo se cobró.
 *
 * Tuvo un parámetro `period` que descartaba los pagos de fuera de la ventana, y
 * se quitó el 09-09-2026 con las cifras delante. El cobro por agencia llega a
 * los 5,6 días de mediana tras el despacho, así que exigir que el pago cayera en
 * la MISMA ventana que el envío borraba todo lo despachado en los últimos ~6
 * días del mes: agosto mostraba 50,0% (324 de 648) cuando la cobranza real fue
 * 70,7% (458). Se perdían 134 pedidos, y no en el mes siguiente —donde tampoco
 * entraban, porque el denominador va por fecha de despacho— sino para siempre.
 *
 * De los 134: 107 por cobrar en el mes siguiente y 27 por pagos sin `paid_at`,
 * que `inPeriod(null)` descartaba en silencio. Al no filtrar por fecha, los dos
 * casos se arreglan solos: un pago validado cuenta, tenga fecha o no.
 *
 * Y no hay `period` opcional «por si acaso»: un parámetro que ningún caller
 * ejerce es un parámetro que ninguna prueba cubre.
 */
function summedPaymentsByOrder(payments: MomOwnerPaymentFact[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const payment of payments) {
    out.set(payment.orderId, (out.get(payment.orderId) ?? 0) + payment.amount);
  }
  return out;
}

function hasAdvance(order: MomOwnerOrderFact, currentPayments: Map<string, number>): boolean {
  if ((currentPayments.get(order.orderId) ?? 0) >= ADELANTO_MINIMO) return true;
  return [
    "adelanto_validado",
    "diferencia_pendiente",
    "diferencia_cargada",
    "pago_completo",
  ].includes(order.paymentState ?? "");
}

function settlementSlaDays(courier: string | null): number | null {
  if (isCourier(courier, ["tanders", "tander"])) return null;
  if (isCourier(courier, ["swayp", "fenix"])) return 4;
  if (isCourier(courier, ["axel", "urpi"])) return 3;
  if (
    isCourier(courier, [
      "aliclik",
      "propio",
      "motorizado propio",
      "johnny",
      "roy",
      "douglas",
    ])
  ) {
    return 1;
  }
  return null;
}

function daysSince(value: string, today: string): number {
  return Math.max(0, Math.floor((dayMs(today) - Date.parse(value)) / DAY_MS));
}

const EXPLICIT_REPROGRAM_SUBSTAGES = new Set([
  "volver_a_contactar",
  "por_reprogramar_lima",
  "gestion_reproprovincia",
  "salida_swayp_programada",
]);

const CONFIRMATION_EVENTS = new Set<string>(CONFIRMATION_SIGNAL_KINDS);

export function buildMomOwnerSummary(input: BuildMomOwnerSummaryInput): MomOwnerSummary {
  const periods = momOwnerPeriods(input.today);
  const orderById = new Map(input.orders.map((order) => [order.orderId, order]));
  const shipmentsByOrder = new Map<string, MomOwnerShipmentFact[]>();
  for (const shipment of input.shipments) {
    if (!shipment.orderId) continue;
    const rows = shipmentsByOrder.get(shipment.orderId) ?? [];
    rows.push(shipment);
    shipmentsByOrder.set(shipment.orderId, rows);
  }
  const confirmedOrders = new Set(
    input.events
      .filter((event) => CONFIRMATION_EVENTS.has(event.kind))
      .map((event) => event.orderId),
  );
  const currentPayments = summedPaymentsByOrder(input.payments);

  const periodSummaries: MomOwnerPeriodSummary[] = periods.map((period) => {
    const orderCohort = input.orders.filter((order) => inPeriod(order.createdAt, period));
    const provinceOrders = orderCohort.filter((order) => order.coverage === "provincia_cod");
    const confirmedProvince = provinceOrders.filter((order) => {
      if (confirmedOrders.has(order.orderId)) return true;
      if ((shipmentsByOrder.get(order.orderId) ?? []).length > 0) return true;
      return ["preparacion", "por_despachar", "en_curso", "por_cerrar"].includes(order.stage ?? "");
    }).length;

    const agencyOrders = orderCohort.filter((order) => order.coverage === "agencia");
    const agencyWithAdvance = agencyOrders.filter((order) => hasAdvance(order, currentPayments)).length;

    const periodShipments = input.shipments.filter((shipment) =>
      inPeriod(dispatchSignalAt(shipment), period),
    );
    const aliclikShipments = periodShipments.filter((shipment) => isCourier(shipment.courier, ["aliclik"]));
    const deliveredAliclik = aliclikShipments.filter(
      (shipment) => shipment.deliveryStatus === "entregado",
    ).length;

    const limaShipments = periodShipments.filter((shipment) => {
      const order = shipment.orderId ? orderById.get(shipment.orderId) : null;
      return order?.coverage === "lima";
    });
    const limaOrders = uniqueOrderIds(limaShipments);
    const deliveredLimaOrders = new Set(
      limaShipments
        .filter((shipment) => shipment.deliveryStatus === "entregado")
        .map((shipment) => shipment.orderId)
        .filter((id): id is string => Boolean(id)),
    );

    const agencyShipments = periodShipments.filter((shipment) =>
      isCourier(shipment.courier, ["shalom", "olva"]),
    );
    const dispatchedAgencyOrders = uniqueOrderIds(agencyShipments);
    // La COHORTE es por fecha de despacho; el COBRO cuenta cuando llegue. Igual
    // que el resto del tablero, «los resultados tardíos actualizan la cohorte de
    // la fecha original». Antes el pago tenía que caer dentro de la misma
    // ventana y eso enterraba 134 pedidos de agosto (ver summedPaymentsByOrder).
    //
    // Efecto secundario buscado: la fila deja de contradecir a la de arriba.
    // «Adelanto de Agencia» ya contaba todos los pagos validados sin mirar la
    // fecha; puestas una debajo de otra, dos reglas distintas se leen como
    // comparables y no lo eran.
    let fullyPaidAgencyOrders = 0;
    for (const orderId of dispatchedAgencyOrders) {
      const total = orderById.get(orderId)?.orderTotal;
      if (total != null && total > 0 && (currentPayments.get(orderId) ?? 0) >= total) {
        fullyPaidAgencyOrders += 1;
      }
    }

    return {
      ...period,
      kpis: {
        province_confirmation: ratio(confirmedProvince, provinceOrders.length),
        agency_advance: ratio(agencyWithAdvance, agencyOrders.length),
        aliclik_delivery: ratio(deliveredAliclik, aliclikShipments.length),
        lima_delivery: ratio(deliveredLimaOrders.size, limaOrders.size),
        agency_full_payment: ratio(fullyPaidAgencyOrders, dispatchedAgencyOrders.size),
      },
    };
  });

  const pickedWithoutPayment = input.orders.filter((order) =>
    order.reasons.includes("recogido_sin_pago_completo"),
  ).length;
  const overdueSettlement = input.orders.filter((order) => {
    if (
      !order.reasons.includes("pendiente_liquidacion") &&
      !order.reasons.includes("liquidacion_observada")
    ) {
      return false;
    }
    if (!order.deliveredAt) return false;
    const sla = settlementSlaDays(order.deliveredCourier);
    return sla != null && daysSince(order.deliveredAt, input.today) >= sla;
  }).length;
  const incompleteManifest = input.manifests.filter((manifest) =>
    ["office_check", "pickup_check"].includes(manifest.state),
  ).length;
  const staleCutoff = limaStartIso(addDays(input.today, -60));
  const staleOrder = input.orders.filter((order) => {
    if (order.stage === "finalizado") return false;
    if (EXPLICIT_REPROGRAM_SUBSTAGES.has(order.substage ?? "")) return false;
    const lastSignal = order.lastMovementAt ?? order.createdAt;
    return Boolean(lastSignal && lastSignal < staleCutoff);
  }).length;

  return {
    generatedAt: input.nowIso ?? new Date().toISOString(),
    periods: periodSummaries,
    alerts: [
      {
        key: "picked_without_payment",
        label: "Recogido sin pago completo",
        description: "Agencia entregó o marcó recojo sin cubrir el total.",
        count: pickedWithoutPayment,
        href: "/dashboard/pedidos?view=por_cerrar&substage=recogido_sin_pago_completo",
      },
      {
        key: "overdue_settlement",
        label: "Liquidación vencida",
        description: "Entrega que superó el plazo de liquidación del courier.",
        count: overdueSettlement,
        href: "/dashboard/pedidos?view=por_cerrar&substage=pendiente_liquidacion",
      },
      {
        key: "incomplete_manifest",
        label: "Manifiesto incompleto",
        description: "Ruta con cotejo de oficina o recojo todavía incompleto.",
        count: incompleteManifest,
        href: "/dashboard/pedidos/despacho",
      },
      {
        key: "stale_order",
        label: "Sin movimiento por 60 días",
        description: "Pedido abierto sin una señal operativa reciente.",
        count: staleOrder,
        href: "/dashboard/pedidos?sd=60",
      },
    ],
  };
}
