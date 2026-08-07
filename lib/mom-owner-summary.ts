import { CONFIRMATION_SIGNAL_KINDS } from "@/lib/order-confirmation";

const DAY_MS = 24 * 60 * 60 * 1000;

export type MomOwnerPeriodKey = "yesterday" | "last7" | "month" | "previous_month";
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

function summedPaymentsByOrder(
  payments: MomOwnerPaymentFact[],
  period?: MomOwnerPeriod,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const payment of payments) {
    if (period && !inPeriod(payment.paidAt, period)) continue;
    out.set(payment.orderId, (out.get(payment.orderId) ?? 0) + payment.amount);
  }
  return out;
}

function hasAdvance(order: MomOwnerOrderFact, currentPayments: Map<string, number>): boolean {
  if ((currentPayments.get(order.orderId) ?? 0) >= 30) return true;
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

    const periodShipments = input.shipments.filter((shipment) => inPeriod(shipment.dispatchedAt, period));
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
    const periodPayments = summedPaymentsByOrder(input.payments, period);
    let fullyPaidAgencyOrders = 0;
    for (const orderId of dispatchedAgencyOrders) {
      const total = orderById.get(orderId)?.orderTotal;
      if (total != null && total > 0 && (periodPayments.get(orderId) ?? 0) >= total) {
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
