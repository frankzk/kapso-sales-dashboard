import { describe, expect, it } from "vitest";
import {
  buildMomOwnerSummary,
  momOwnerPeriods,
  type BuildMomOwnerSummaryInput,
  type MomOwnerOrderFact,
} from "@/lib/mom-owner-summary";

const TODAY = "2026-08-01";
const YESTERDAY = "2026-07-31T15:00:00.000Z";

function order(
  orderId: string,
  over: Partial<MomOwnerOrderFact> = {},
): MomOwnerOrderFact {
  return {
    orderId,
    createdAt: YESTERDAY,
    coverage: "provincia_cod",
    orderTotal: 100,
    stage: "por_confirmar",
    substage: "sin_llamar",
    reasons: [],
    paymentState: "sin_pago",
    deliveredAt: null,
    deliveredCourier: null,
    lastMovementAt: YESTERDAY,
    ...over,
  };
}

function build(over: Partial<BuildMomOwnerSummaryInput> = {}) {
  return buildMomOwnerSummary({
    today: TODAY,
    nowIso: "2026-08-01T18:00:00.000Z",
    orders: [],
    shipments: [],
    payments: [],
    events: [],
    manifests: [],
    ...over,
  });
}

describe("ventanas del resumen diario MOM", () => {
  it("usa cortes de medianoche de Lima y conserva el mes anterior completo", () => {
    expect(momOwnerPeriods(TODAY)).toEqual([
      {
        key: "yesterday",
        label: "Ayer",
        startIso: "2026-07-31T05:00:00.000Z",
        endIso: "2026-08-01T05:00:00.000Z",
      },
      {
        key: "last7",
        label: "Últimos 7 días",
        startIso: "2026-07-26T05:00:00.000Z",
        endIso: "2026-08-02T05:00:00.000Z",
      },
      {
        key: "month",
        label: "Mes actual",
        startIso: "2026-08-01T05:00:00.000Z",
        endIso: "2026-08-02T05:00:00.000Z",
      },
      {
        key: "previous_month",
        label: "Mes anterior",
        startIso: "2026-07-01T05:00:00.000Z",
        endIso: "2026-08-01T05:00:00.000Z",
      },
    ]);
  });
});

describe("indicadores operativos del owner", () => {
  it("respeta la unidad pedido/salida y expone numerador y denominador", () => {
    const orders = [
      order("province-confirmed", { stage: "preparacion" }),
      order("province-open"),
      order("agency-advance", { coverage: "agencia" }),
      order("agency-open", { coverage: "agencia" }),
      order("lima-delivered", { coverage: "lima" }),
      order("lima-open", { coverage: "lima" }),
      order("agency-paid", { coverage: "agencia", orderTotal: 100 }),
      order("agency-partial", { coverage: "agencia", orderTotal: 80 }),
    ];
    const summary = build({
      orders,
      shipments: [
        { id: "a1", orderId: "province-confirmed", courier: "Aliclik", dispatchedAt: null, deliveryStatus: "pendiente" },
        { id: "a2", orderId: "province-open", courier: "Aliclik", dispatchedAt: YESTERDAY, deliveryStatus: "entregado" },
        { id: "a3", orderId: "agency-open", courier: "Aliclik", dispatchedAt: YESTERDAY, deliveryStatus: "en_ruta" },
        { id: "l1", orderId: "lima-delivered", courier: "Axel", dispatchedAt: YESTERDAY, deliveryStatus: "entregado" },
        { id: "l2", orderId: "lima-open", courier: "Urpi", dispatchedAt: YESTERDAY, deliveryStatus: "en_ruta" },
        { id: "g1", orderId: "agency-paid", courier: "Shalom", dispatchedAt: YESTERDAY, deliveryStatus: "en_ruta" },
        { id: "g2", orderId: "agency-partial", courier: "Olva", dispatchedAt: YESTERDAY, deliveryStatus: "en_ruta" },
      ],
      payments: [
        { orderId: "agency-advance", amount: 30, paidAt: YESTERDAY },
        { orderId: "agency-paid", amount: 100, paidAt: YESTERDAY },
        { orderId: "agency-partial", amount: 30, paidAt: YESTERDAY },
      ],
      events: [],
    });

    const yesterday = summary.periods.find((period) => period.key === "yesterday")!;
    expect(yesterday.kpis.province_confirmation).toEqual({
      numerator: 2,
      denominator: 2,
      rate: 1,
    });
    expect(yesterday.kpis.agency_advance).toEqual({
      numerator: 3,
      denominator: 4,
      rate: 0.75,
    });
    expect(yesterday.kpis.aliclik_delivery).toEqual({
      numerator: 1,
      denominator: 2,
      rate: 0.5,
    });
    expect(yesterday.kpis.lima_delivery).toEqual({
      numerator: 1,
      denominator: 2,
      rate: 0.5,
    });
    expect(yesterday.kpis.agency_full_payment).toEqual({
      numerator: 1,
      denominator: 2,
      rate: 0.5,
    });
  });

  it("presenta un universo vacío como Sin datos, no como cero por ciento", () => {
    const summary = build();
    for (const value of Object.values(summary.periods[0]!.kpis)) {
      expect(value).toEqual({ numerator: 0, denominator: 0, rate: null });
    }
  });

  it("cuenta el pago completo de Agencia solo si el dinero cayó en la ventana", () => {
    const summary = build({
      orders: [order("agency", { coverage: "agencia", orderTotal: 100 })],
      shipments: [
        { id: "guide", orderId: "agency", courier: "Shalom", dispatchedAt: YESTERDAY, deliveryStatus: "en_ruta" },
      ],
      payments: [
        { orderId: "agency", amount: 100, paidAt: "2026-07-20T15:00:00.000Z" },
      ],
    });
    const yesterday = summary.periods.find((period) => period.key === "yesterday")!;
    expect(yesterday.kpis.agency_full_payment).toEqual({ numerator: 0, denominator: 1, rate: 0 });
  });
});

describe("alertas críticas del MOM", () => {
  it("aplica el SLA por courier, excluye Tanders y respeta reprogramaciones explícitas", () => {
    const summary = build({
      orders: [
        order("picked", { reasons: ["recogido_sin_pago_completo"], stage: "por_cerrar" }),
        order("aliclik-late", {
          reasons: ["pendiente_liquidacion"],
          stage: "por_cerrar",
          deliveredAt: "2026-07-30T15:00:00.000Z",
          deliveredCourier: "Aliclik",
        }),
        order("axel-on-time", {
          reasons: ["pendiente_liquidacion"],
          stage: "por_cerrar",
          deliveredAt: "2026-07-30T15:00:00.000Z",
          deliveredCourier: "Axel Courier",
        }),
        order("swayp-late", {
          reasons: ["liquidacion_observada"],
          stage: "por_cerrar",
          deliveredAt: "2026-07-27T15:00:00.000Z",
          deliveredCourier: "Swayp",
        }),
        order("tanders-direct", {
          reasons: ["pendiente_liquidacion"],
          stage: "por_cerrar",
          deliveredAt: "2026-07-01T15:00:00.000Z",
          deliveredCourier: "Tanders",
        }),
        order("stale", {
          createdAt: "2026-05-01T15:00:00.000Z",
          lastMovementAt: "2026-05-20T15:00:00.000Z",
        }),
        order("stale-reprogrammed", {
          createdAt: "2026-05-01T15:00:00.000Z",
          lastMovementAt: "2026-05-20T15:00:00.000Z",
          substage: "por_reprogramar_lima",
        }),
      ],
      manifests: [
        { id: "m1", state: "office_check" },
        { id: "m2", state: "pickup_check" },
        { id: "m3", state: "draft" },
      ],
    });

    expect(Object.fromEntries(summary.alerts.map((alert) => [alert.key, alert.count]))).toEqual({
      picked_without_payment: 1,
      overdue_settlement: 2,
      incomplete_manifest: 2,
      stale_order: 1,
    });
  });
});
