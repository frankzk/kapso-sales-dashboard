import { describe, expect, it } from "vitest";
import { CONFIRMATION_SIGNAL_KINDS as CONFIRMATION_KINDS } from "@/lib/order-confirmation";
import {
  buildMomOwnerSummary,
  dispatchSignalAt,
  momChosenMonth,
  momMonthPeriod,
  momOwnerPeriods,
  momOwnerPeriodsWith,
  type BuildMomOwnerSummaryInput,
  type MomOwnerOrderFact,
  type MomOwnerShipmentFact,
} from "@/lib/mom-owner-summary";

const TODAY = "2026-08-01";
const YESTERDAY = "2026-07-31T15:00:00.000Z";
const LAST_WEEK = "2026-07-24T15:00:00.000Z";

function guide(
  id: string,
  orderId: string,
  over: Partial<MomOwnerShipmentFact> = {},
): MomOwnerShipmentFact {
  return {
    id,
    orderId,
    courier: "Aliclik",
    dispatchedAt: null,
    deliveryStatus: "pendiente",
    createdAt: LAST_WEEK,
    readyAt: null,
    custodyTransferredAt: null,
    ...over,
  };
}

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
        key: "today",
        label: "Hoy",
        startIso: "2026-08-01T05:00:00.000Z",
        endIso: "2026-08-02T05:00:00.000Z",
      },
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

describe("«Otro mes…»: un mes cerrado elegido con su mes y año (02-11-2026)", () => {
  it("solo vale un mes anterior al mes anterior, desde enero de 2025", () => {
    expect(momChosenMonth("2026-05", TODAY)).toBe("2026-05");
    expect(momChosenMonth("2025-01", TODAY)).toBe("2025-01");
    // «Este mes» y «Mes anterior» ya tienen su chip.
    expect(momChosenMonth("2026-08", TODAY)).toBeNull();
    expect(momChosenMonth("2026-07", TODAY)).toBeNull();
    expect(momChosenMonth("2026-09", TODAY)).toBeNull();
    expect(momChosenMonth("2024-12", TODAY)).toBeNull();
    expect(momChosenMonth("2026-13", TODAY)).toBeNull();
    expect(momChosenMonth("mayo", TODAY)).toBeNull();
    expect(momChosenMonth(null, TODAY)).toBeNull();
  });

  it("es el mes entero en días de Lima, también al cruzar el año", () => {
    expect(momMonthPeriod("2025-12")).toEqual({
      key: "chosen_month",
      label: "Diciembre 2025",
      startIso: "2025-12-01T05:00:00.000Z",
      endIso: "2026-01-01T05:00:00.000Z",
    });
    expect(momOwnerPeriodsWith(TODAY, "2026-05").map((p) => p.key)).toEqual([
      "today",
      "yesterday",
      "last7",
      "month",
      "previous_month",
      "chosen_month",
    ]);
    expect(momOwnerPeriodsWith(TODAY, "2026-07")).toEqual(momOwnerPeriods(TODAY));
  });

  it("cuenta la cohorte de ese mes y nada de los otros", () => {
    const summary = build({
      month: "2026-05",
      orders: [
        order("mayo-1", { createdAt: "2026-05-01T05:00:00.000Z", stage: "finalizado" }),
        order("mayo-31", { createdAt: "2026-06-01T04:59:00.000Z" }),
        order("junio-1", { createdAt: "2026-06-01T05:00:00.000Z", stage: "preparacion" }),
        order("ayer", { stage: "preparacion" }),
      ],
      // El pedido del 31 salió el 2 de junio: se confirmó, y sigue siendo de mayo.
      shipments: [guide("g-mayo-31", "mayo-31", { courier: "Shalom", createdAt: "2026-06-02T15:00:00.000Z" })],
      events: [{ orderId: "mayo-1", kind: [...CONFIRMATION_KINDS][0]!, occurredAt: "2026-05-01T16:00:00.000Z" }],
    });
    const may = summary.periods.find((period) => period.key === "chosen_month")!;
    expect(may.label).toBe("Mayo 2026");
    expect(may.kpis.province_confirmation).toEqual({ numerator: 2, denominator: 2, rate: 1 });
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
        guide("a1", "province-confirmed"),
        guide("a2", "province-open", { dispatchedAt: YESTERDAY, deliveryStatus: "entregado" }),
        guide("a3", "agency-open", { dispatchedAt: YESTERDAY, deliveryStatus: "en_ruta" }),
        guide("l1", "lima-delivered", { courier: "Axel", dispatchedAt: YESTERDAY, deliveryStatus: "entregado" }),
        guide("l2", "lima-open", { courier: "Urpi", dispatchedAt: YESTERDAY, deliveryStatus: "en_ruta" }),
        guide("g1", "agency-paid", { courier: "Shalom", dispatchedAt: YESTERDAY, deliveryStatus: "en_ruta" }),
        guide("g2", "agency-partial", { courier: "Olva", dispatchedAt: YESTERDAY, deliveryStatus: "en_ruta" }),
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

  it("«Hoy» es la cohorte creada desde la medianoche de Lima, y no se mezcla con «Ayer»", () => {
    // Un pedido creado a las 23:30 de Lima del 31 de julio es de AYER aunque en
    // UTC ya sea 1 de agosto. Uno creado a las 00:30 de Lima del 1 de agosto es
    // de HOY. El corte es la medianoche de Lima, no la de UTC.
    const summary = build({
      orders: [
        order("anoche", { createdAt: "2026-08-01T04:30:00.000Z", stage: "preparacion" }),
        order("madrugada", { createdAt: "2026-08-01T05:30:00.000Z" }),
        order("manana", { createdAt: "2026-08-01T14:00:00.000Z", stage: "preparacion" }),
      ],
    });
    const today = summary.periods.find((period) => period.key === "today")!;
    const yesterday = summary.periods.find((period) => period.key === "yesterday")!;
    expect(today.kpis.province_confirmation).toEqual({ numerator: 1, denominator: 2, rate: 0.5 });
    expect(yesterday.kpis.province_confirmation).toEqual({ numerator: 1, denominator: 1, rate: 1 });
    // Y hoy sigue contando dentro de los 7 días y del mes, como antes.
    const last7 = summary.periods.find((period) => period.key === "last7")!;
    const month = summary.periods.find((period) => period.key === "month")!;
    expect(last7.kpis.province_confirmation.denominator).toBe(3);
    expect(month.kpis.province_confirmation.denominator).toBe(2);
  });

  it("presenta un universo vacío como Sin datos, no como cero por ciento", () => {
    const summary = build();
    for (const value of Object.values(summary.periods[0]!.kpis)) {
      expect(value).toEqual({ numerator: 0, denominator: 0, rate: null });
    }
  });

  // LA COHORTE ES POR DESPACHO; EL COBRO CUENTA CUANDO LLEGUE. Hasta el
  // 09-09-2026 el pago tenía que caer en la MISMA ventana que el envío, y con
  // una mediana de cobro de 5,6 días eso borraba todo lo despachado en los
  // últimos ~6 días del mes: agosto mostraba 50,0% (324 de 648) con una cobranza
  // real del 70,7% (458). Los 134 que faltaban no aparecían el mes siguiente
  // —el denominador va por fecha de despacho— sino nunca.
  it("el pago cuenta aunque llegue después de la ventana del despacho", () => {
    const summary = build({
      orders: [order("agency", { coverage: "agencia", orderTotal: 100 })],
      shipments: [
        guide("guide", "agency", { courier: "Shalom", dispatchedAt: YESTERDAY, deliveryStatus: "en_ruta" }),
      ],
      // Cobrado tres semanas ANTES de la ventana: con la regla vieja no contaba.
      payments: [{ orderId: "agency", amount: 100, paidAt: "2026-07-20T15:00:00.000Z" }],
    });
    const yesterday = summary.periods.find((period) => period.key === "yesterday")!;
    expect(yesterday.kpis.agency_full_payment).toEqual({ numerator: 1, denominator: 1, rate: 1 });
  });

  // `paid_at` no lo teclea nadie: lo saca la visión del comprobante, y a veces no
  // lo consigue. Había 62 pagos validados sin fecha (S/ 6.355) que `inPeriod(null)`
  // descartaba en silencio — 27 de los 134 pedidos perdidos de agosto. Un pago
  // validado es dinero cobrado, con fecha legible o sin ella.
  it("un pago validado sin fecha sigue siendo dinero cobrado", () => {
    const summary = build({
      orders: [order("agency", { coverage: "agencia", orderTotal: 100 })],
      shipments: [
        guide("guide", "agency", { courier: "Shalom", dispatchedAt: YESTERDAY, deliveryStatus: "en_ruta" }),
      ],
      payments: [{ orderId: "agency", amount: 100, paidAt: null }],
    });
    const yesterday = summary.periods.find((period) => period.key === "yesterday")!;
    expect(yesterday.kpis.agency_full_payment).toEqual({ numerator: 1, denominator: 1, rate: 1 });
  });

  // Lo que NO cambia: la cohorte. Un pedido despachado fuera de la ventana no
  // entra por mucho que esté pagado — si no, «Ayer» acabaría contando el mes
  // entero.
  it("la cohorte sigue siendo la del despacho", () => {
    const summary = build({
      orders: [order("agency", { coverage: "agencia", orderTotal: 100 })],
      shipments: [
        guide("guide", "agency", {
          courier: "Shalom",
          dispatchedAt: "2026-07-20T15:00:00.000Z",
          deliveryStatus: "en_ruta",
        }),
      ],
      payments: [{ orderId: "agency", amount: 100, paidAt: YESTERDAY }],
    });
    const yesterday = summary.periods.find((period) => period.key === "yesterday")!;
    expect(yesterday.kpis.agency_full_payment).toEqual({ numerator: 0, denominator: 0, rate: null });
  });

  // Y un pago que no llega al total sigue sin contar, venga cuando venga.
  it("un pago parcial no cuenta por mucho que sea antiguo", () => {
    const summary = build({
      orders: [order("agency", { coverage: "agencia", orderTotal: 100 })],
      shipments: [
        guide("guide", "agency", { courier: "Shalom", dispatchedAt: YESTERDAY, deliveryStatus: "en_ruta" }),
      ],
      payments: [{ orderId: "agency", amount: 60, paidAt: "2026-07-20T15:00:00.000Z" }],
    });
    const yesterday = summary.periods.find((period) => period.key === "yesterday")!;
    expect(yesterday.kpis.agency_full_payment).toEqual({ numerator: 0, denominator: 1, rate: 0 });
  });
});

describe("cuándo se despachó una salida depende del courier", () => {
  // AUDITADO EL 08-09-2026. `dispatched_at` solo lo escribe Aliclik; Shalom,
  // Tanders, propio, Urpi y las 2.641 salidas «por definir» de Lima tenían
  // CERO. Mientras el tablero miraba solo ese campo, «Entrega Lima total» y
  // «Pago completo de Agencia» daban 0 de 0 con 740 pedidos Lima y 453 guías
  // Shalom delante.

  it("Aliclik: solo `dispatched_at`; lista en la Mesa no es despachada", () => {
    // Una guía Aliclik que el motorizado no recogió no cuenta como salida
    // despachada: contarla bajaría la tasa de entrega por algo ajeno al courier.
    expect(dispatchSignalAt(guide("a", "o", { readyAt: YESTERDAY }))).toBeNull();
    expect(dispatchSignalAt(guide("a", "o", { readyAt: LAST_WEEK, dispatchedAt: YESTERDAY }))).toBe(
      YESTERDAY,
    );
  });

  it("Shalom / Olva: la creación de la guía es el despacho", () => {
    // La caja va a la agencia al crear la guía y no hay ningún registro después.
    expect(dispatchSignalAt(guide("g", "o", { courier: "Shalom", createdAt: YESTERDAY }))).toBe(
      YESTERDAY,
    );
    expect(dispatchSignalAt(guide("g", "o", { courier: "olva", createdAt: YESTERDAY }))).toBe(YESTERDAY);
    // Si algún día llega un `dispatched_at` real, manda él.
    expect(
      dispatchSignalAt(guide("g", "o", { courier: "Shalom", createdAt: LAST_WEEK, dispatchedAt: YESTERDAY })),
    ).toBe(YESTERDAY);
  });

  it("Lima: la custodia al motorizado si existe, y si no el escaneo «listo despacho»", () => {
    expect(dispatchSignalAt(guide("l", "o", { courier: "por_definir", readyAt: YESTERDAY }))).toBe(
      YESTERDAY,
    );
    expect(
      dispatchSignalAt(
        guide("l", "o", { courier: "por_definir", readyAt: LAST_WEEK, custodyTransferredAt: YESTERDAY }),
      ),
    ).toBe(YESTERDAY);
    expect(dispatchSignalAt(guide("l", "o", { courier: "tanders" }))).toBeNull();
  });

  it("«Entrega Lima total» ve las salidas listas en la Mesa aunque nadie registre la custodia", () => {
    // Lo que el owner esperaba ver: «0 de N», no «Sin datos».
    const summary = build({
      orders: [
        order("lima-1", { coverage: "lima" }),
        order("lima-2", { coverage: "lima" }),
        order("lima-vieja", { coverage: "lima" }),
      ],
      shipments: [
        guide("s1", "lima-1", { courier: "por_definir", readyAt: YESTERDAY }),
        guide("s2", "lima-2", { courier: "por_definir", readyAt: YESTERDAY, deliveryStatus: "entregado" }),
        // Lista la semana pasada: es de otra ventana.
        guide("s3", "lima-vieja", { courier: "por_definir", readyAt: LAST_WEEK }),
      ],
    });
    const yesterday = summary.periods.find((period) => period.key === "yesterday")!;
    expect(yesterday.kpis.lima_delivery).toEqual({ numerator: 1, denominator: 2, rate: 0.5 });
  });

  it("«Pago completo de Agencia» ve las guías Shalom por su fecha de creación", () => {
    const summary = build({
      orders: [
        order("pagado", { coverage: "agencia", orderTotal: 100 }),
        order("adelanto", { coverage: "agencia", orderTotal: 100 }),
      ],
      shipments: [
        guide("g1", "pagado", { courier: "shalom", createdAt: YESTERDAY, deliveryStatus: "en_ruta" }),
        guide("g2", "adelanto", { courier: "shalom", createdAt: YESTERDAY, deliveryStatus: "en_ruta" }),
      ],
      payments: [
        { orderId: "pagado", amount: 30, paidAt: YESTERDAY },
        { orderId: "pagado", amount: 70, paidAt: YESTERDAY },
        { orderId: "adelanto", amount: 30, paidAt: YESTERDAY },
      ],
    });
    const yesterday = summary.periods.find((period) => period.key === "yesterday")!;
    expect(yesterday.kpis.agency_full_payment).toEqual({ numerator: 1, denominator: 2, rate: 0.5 });
  });

  it("«Entrega Aliclik» NO cambia: una guía lista pero no recogida sigue fuera", () => {
    const summary = build({
      orders: [order("p1"), order("p2")],
      shipments: [
        guide("a1", "p1", { dispatchedAt: YESTERDAY, deliveryStatus: "entregado" }),
        guide("a2", "p2", { readyAt: YESTERDAY }),
      ],
    });
    const yesterday = summary.periods.find((period) => period.key === "yesterday")!;
    expect(yesterday.kpis.aliclik_delivery).toEqual({ numerator: 1, denominator: 1, rate: 1 });
  });
});

describe("alertas críticas del MOM", () => {
  it("aplica el SLA por courier, excluye Tanders y respeta reprogramaciones explícitas", () => {
    const summary = build({
      orders: [
        order("picked", {
          reasons: ["recogido_sin_pago_completo"],
          stage: "por_cerrar",
          substage: "recogido_sin_pago_completo",
        }),
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
