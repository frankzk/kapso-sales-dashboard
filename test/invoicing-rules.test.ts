// Comprobantes electrónicos por RUC — las reglas puras de lib/invoicing/rules.ts
// (MOM §35).
//
// Aquí no hay base ni red. Cada prueba fija una decisión que, si cambiara en
// silencio, emitiría una boleta de más o a nombre del RUC equivocado: una boleta
// enviada a SUNAT no se borra y SimpleFact no tiene llave de idempotencia. Por
// eso casi todo lo que se prueba es el lado cerrado: en la duda no se emite, y
// el motivo es la primera condición que falla, en el orden de la tabla de
// §35.3. Las cuentas son las de producción: «Grupo GF S.A.C.» ···309 y la
// pasarela Flow «Aurela Kenku» son de GRUPO GF S.A.C.; las cuentas personales
// de los dueños no tienen RUC (§35.2). La lectura de Shopify, el cliente de
// SimpleFact y el barrido tienen sus propias pruebas (test/invoicing-*.test.ts).

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BOLETA_MAX_CENTS,
  BOLETA_TYPE,
  IGV_PERCENT,
  INVOICE_DAILY_LIMIT_DEFAULT,
  INVOICE_DAILY_LIMIT_MAX,
  INVOICE_DAILY_LIMIT_MIN,
  INVOICE_MAX_PER_RUN,
  INVOICE_MODES,
  INVOICE_REASON_LABEL,
  INVOICE_REASONS,
  INVOICE_STATUS_LABEL,
  INVOICE_STATUSES,
  LIVE_REAL_STATUSES,
  SIMPLEFACT_DOMAIN,
  WALKIN_CUSTOMER,
  buildSalePayload,
  classifySaleResponse,
  creditNoteWarning,
  findSaleByNote,
  gatewayAccounts,
  invoiceEligibility,
  invoiceNote,
  invoiceNoteRef,
  isValidRuc,
  normalizeSubdomain,
  resolvePaymentAccounts,
  rucFromSalesList,
  rucFromSimplefactSale,
  rucFromSimplefactText,
  simplefactBaseUrl,
  type InvoiceAccount,
  type InvoiceIssuer,
  type InvoiceItem,
  type InvoiceOrderFacts,
  type InvoicePayment,
  type InvoiceReason,
  type InvoiceStatus,
} from "@/lib/invoicing/rules";

// ── Datos de producción ──────────────────────────────────────────────────────

const RUC_GF = "20556792829";
/** Otra razón social del grupo. RUC sintético, con su dígito verificador. */
const RUC_OTRO = "20600000005";

/** «Emitir desde»: la medianoche de Lima del 14-10-2026. */
const DESDE = "2026-10-14T05:00:00.000Z";
/**
 * Cuándo entró a Kapta el pago de la mayoría de los casos (`registered_at`): la
 * fecha de «quedó pagado».
 */
const PAGADO = "2026-10-14T15:00:00.000Z";
/** Cuándo lo validó finanzas (`validated_at`): solo para auditar la base. */
const VALIDADO = "2026-10-14T15:20:00.000Z";
const FECHA_PEDIDO = "2026-10-14T13:00:00.000Z";

const GF: InvoiceIssuer = {
  id: "iss-gf",
  orgId: "org-grupo-gf",
  ruc: RUC_GF,
  legalName: "GRUPO GF S.A.C.",
  mode: "real",
  emitFrom: DESDE,
  dailyLimit: 40,
  hasToken: true,
  checkedRuc: RUC_GF,
};

const OTRO: InvoiceIssuer = {
  ...GF,
  id: "iss-otro",
  ruc: RUC_OTRO,
  legalName: "OTRA RAZÓN SOCIAL S.A.C.",
  checkedRuc: RUC_OTRO,
};

const CUENTA_GF: InvoiceAccount = {
  id: "acc-gf",
  label: "Grupo GF S.A.C.",
  aliases: [],
  phoneLastDigits: "309",
  issuerId: GF.id,
};
const CUENTA_GABRIELA: InvoiceAccount = {
  id: "acc-gabriela",
  label: "Gabriela Reaño Vera",
  aliases: [],
  phoneLastDigits: "147",
  issuerId: null,
};
const CUENTA_FRANKZ: InvoiceAccount = {
  id: "acc-frankz",
  label: "Frankz Alberto Paolo Kastner Cam",
  // La constancia del banco escribe los apellidos primero.
  aliases: ["Kastner Cam Frankz Alberto Paolo"],
  phoneLastDigits: "481",
  issuerId: null,
};
/** La pasarela Flow: cobra como «Aurela Kenku» y no tiene celular (0198). */
const CUENTA_FLOW: InvoiceAccount = {
  id: "acc-flow",
  label: "Aurela Kenku",
  aliases: [],
  phoneLastDigits: null,
  issuerId: GF.id,
};
const CUENTAS: InvoiceAccount[] = [CUENTA_GF, CUENTA_GABRIELA, CUENTA_FRANKZ, CUENTA_FLOW];

type Extraido = {
  recipient_name?: string | null;
  recipient_phone_last_digits?: string | null;
  payer_name?: string | null;
  received_view?: boolean;
  yape_empresa_marker?: boolean;
  recipient_check?: string;
  recipient_account?: string | null;
};

/** La forma real de `order_payments.vision` (lib/voucher-inspect.ts). */
function lectura(extracted: Extraido) {
  return {
    ok: true,
    model: "lector",
    extracted: {
      operation_number: "15926914",
      operation_label: "Nro. de operación",
      amount: 150,
      paid_at: "2026-10-14T14:58:00.000Z",
      payer_name: null,
      recipient_name: null,
      recipient_phone_last_digits: null,
      recipient_swapped: false,
      received_view: false,
      yape_empresa_marker: false,
      recipient_check: "missing",
      recipient_account: null,
      ...extracted,
    },
  };
}

const LECTURA_GF = lectura({
  recipient_name: "Grupo GF S.A.C.",
  recipient_phone_last_digits: "309",
  recipient_check: "verified",
  recipient_account: "Grupo GF S.A.C.",
});
const LECTURA_GABRIELA = lectura({ recipient_name: "Gabriela Reaño Vera", recipient_phone_last_digits: "147" });

function pago(over: Partial<InvoicePayment> = {}): InvoicePayment {
  return {
    id: "pay-1",
    kind: "total",
    amount: 150,
    validationStatus: "validado",
    registeredAt: PAGADO,
    validatedAt: VALIDADO,
    vision: LECTURA_GF,
    flowLinked: false,
    statementDestination: null,
    ...over,
  };
}

/** Un pedido que SÍ lleva comprobante: S/ 150 por Yape a Grupo GF, validado hoy. */
function hechos(over: Partial<InvoiceOrderFacts> = {}): InvoiceOrderFacts {
  return {
    orderId: "ord-1",
    storeId: "store-1",
    orderName: "#KP136181",
    total: 150,
    currency: "PEN",
    cancelledAt: null,
    totalRefunded: 0,
    financialStatus: "pending",
    paymentGateway: "manual",
    orderDate: FECHA_PEDIDO,
    customerName: "María Pérez Soto",
    payments: [pago()],
    accounts: CUENTAS,
    issuers: [GF, OTRO],
    existing: { realLive: false, simulated: false, errorBlocked: false },
    ...over,
  };
}

/** Un prepago web: el checkout de Flow cobró y no hay filas de pago. */
function prepago(over: Partial<InvoiceOrderFacts> = {}): InvoiceOrderFacts {
  return hechos({ financialStatus: "paid", paymentGateway: "checkout", payments: [], total: 89.9, ...over });
}

function motivo(f: InvoiceOrderFacts): InvoiceReason | "ok" {
  const r = invoiceEligibility(f);
  return r.ok ? "ok" : r.reason;
}

const SIN_NADA = { realLive: false, simulated: false, errorBlocked: false };

// ── ¿Lleva comprobante? ──────────────────────────────────────────────────────

describe("MOM §35.3 — invoiceEligibility: el pedido que sí lleva comprobante", () => {
  it("S/ 150 por Yape a Grupo GF, pagado después de «Emitir desde»: boleta real de GRUPO GF", () => {
    expect(invoiceEligibility(hechos())).toEqual({
      ok: true,
      issuer: GF,
      mode: "real",
      totalCents: 15_000,
      paidAt: PAGADO,
      basis: {
        prepaid: false,
        payments: [
          { id: "pay-1", amount: 150, source: "lectura_verificada", accountIds: ["acc-gf"], validatedAt: VALIDADO },
        ],
      },
    });
  });

  it("dos pagos que juntos cubren el total: paidAt es el ÚLTIMO registrado y la base lleva los dos", () => {
    const tarde = "2026-10-14T18:30:00.000Z";
    const tardeValidado = "2026-10-14T18:45:00.000Z";
    const r = invoiceEligibility(
      hechos({
        payments: [
          // El último registrado va primero: cuenta la fecha, no la posición.
          pago({
            id: "pay-dif",
            kind: "diferencia",
            amount: 100,
            registeredAt: tarde,
            validatedAt: tardeValidado,
            statementDestination: "GRUPO GF S.A.C.",
          }),
          pago({ id: "pay-ade", kind: "adelanto", amount: 50 }),
        ],
      }),
    );
    expect(r).toEqual({
      ok: true,
      issuer: GF,
      mode: "real",
      totalCents: 15_000,
      paidAt: tarde,
      basis: {
        prepaid: false,
        payments: [
          { id: "pay-dif", amount: 100, source: "estado_yape", accountIds: ["acc-gf"], validatedAt: tardeValidado },
          { id: "pay-ade", amount: 50, source: "lectura_verificada", accountIds: ["acc-gf"], validatedAt: VALIDADO },
        ],
      },
    });
  });

  it("en simulación devuelve el modo simulación y no le pide token ni prueba de conexión", () => {
    const sim = { ...GF, mode: "simulacion" as const, hasToken: false, checkedRuc: null };
    const r = invoiceEligibility(hechos({ issuers: [sim] }));
    expect(r).toMatchObject({ ok: true, mode: "simulacion", issuer: sim, totalCents: 15_000 });
  });

  it("los céntimos se redondean, no se truncan: S/ 19.99 son 1999 céntimos", () => {
    const r = invoiceEligibility(hechos({ total: 19.99, payments: [pago({ amount: 19.99 })] }));
    expect(r).toMatchObject({ ok: true, totalCents: 1999 });
  });

  it("un pago de más cubre el total: la boleta va por el total del pedido, no por lo pagado", () => {
    const r = invoiceEligibility(hechos({ payments: [pago({ amount: 200 })] }));
    expect(r).toMatchObject({ ok: true, totalCents: 15_000, basis: { payments: [{ amount: 200 }] } });
  });
});

describe("MOM §35.3 — el orden de la tabla: la primera condición que falla es el motivo", () => {
  // El barrido guarda ese motivo y el panel lo muestra. Si el código evaluara en
  // otro orden, el panel diría por qué no con una razón que no es la primera.
  it("todo roto a la vez, y se arregla de a una: los motivos salen en el orden de §35.3", () => {
    const gf: InvoiceIssuer = { ...GF, mode: "apagado", emitFrom: null, hasToken: false };
    const gabriela: InvoiceAccount = { ...CUENTA_GABRIELA };
    const pagoGf = pago({ id: "pay-gf", amount: 150 });
    const duplicado = pago({ id: "pay-dup", kind: "diferencia", validationStatus: "posible_duplicado" });
    const enRevision = pago({ id: "pay-rev", kind: "diferencia", validationStatus: "pendiente_revision", validatedAt: null });
    const sinLectura = pago({ id: "pay-sin-lectura", kind: "diferencia", amount: 0, vision: null });
    const f = hechos({
      cancelledAt: "2026-10-14T16:00:00.000Z",
      totalRefunded: 10,
      currency: "USD",
      total: 800,
      payments: [pagoGf, duplicado, enRevision, sinLectura],
      accounts: [CUENTA_GF, gabriela, CUENTA_FRANKZ, CUENTA_FLOW],
      issuers: [gf, OTRO],
      existing: { realLive: true, simulated: true, errorBlocked: true },
    });
    const pasos: [InvoiceReason, () => void][] = [
      ["anulado", () => (f.cancelledAt = null)],
      ["reembolsado", () => (f.totalRefunded = 0)],
      ["moneda", () => (f.currency = "PEN")],
      // Un pago rechazado ya no es un pago vivo.
      ["posible_duplicado", () => (duplicado.validationStatus = "rechazado")],
      ["pagos_en_revision", () => (enRevision.validationStatus = "rechazado")],
      // Lo validado (S/ 150) no cubre S/ 800.
      ["sin_pago_completo", () => (pagoGf.amount = 800)],
      ["pago_sin_cuenta", () => (sinLectura.vision = LECTURA_GABRIELA)],
      ["cuenta_sin_ruc", () => (gabriela.issuerId = OTRO.id)],
      ["ruc_mezclados", () => (gabriela.issuerId = GF.id)],
      ["monto_mayor_700", () => ((f.total = 700), (pagoGf.amount = 700))],
      ["ruc_apagado", () => (gf.mode = "real")],
      ["antes_de_inicio", () => (gf.emitFrom = DESDE)],
      ["ya_tiene", () => (f.existing.realLive = false)],
      // En real, una simulación previa no frena: el siguiente es el error.
      ["error_previo", () => (f.existing.errorBlocked = false)],
      ["sin_conexion", () => (gf.hasToken = true)],
    ];
    for (const [esperado, arreglar] of pasos) {
      expect(motivo(f)).toBe(esperado);
      arreglar();
    }
    expect(motivo(f)).toBe("ok");

    // Y ese orden es el de INVOICE_REASONS, que es el de la tabla del MOM.
    const posiciones = pasos.map(([r]) => INVOICE_REASONS.indexOf(r));
    expect(posiciones).toEqual([...posiciones].sort((a, b) => a - b));
  });

  it("en simulación: ya_tiene antes que ya_simulado; el error previo y la conexión no cuentan", () => {
    const sim: InvoiceIssuer = { ...GF, mode: "simulacion", hasToken: false, checkedRuc: null };
    const f = hechos({ issuers: [sim], existing: { realLive: true, simulated: true, errorBlocked: true } });
    expect(motivo(f)).toBe("ya_tiene");
    f.existing.realLive = false;
    expect(motivo(f)).toBe("ya_simulado");
    f.existing.simulated = false;
    expect(invoiceEligibility(f)).toMatchObject({ ok: true, mode: "simulacion" });
  });

  it("prepago web: prepago_con_comprobantes → pago_sin_cuenta → cuenta_sin_ruc → monto_cero → antes_de_inicio", () => {
    const flow: InvoiceAccount = { ...CUENTA_FLOW, issuerId: null };
    const captura = pago({ id: "pay-captura" });
    const f = prepago({
      total: 0,
      orderDate: "2026-10-13T20:00:00.000Z",
      payments: [captura],
      accounts: [CUENTA_GF, CUENTA_GABRIELA],
      issuers: [GF],
    });
    const pasos: [InvoiceReason, () => void][] = [
      ["prepago_con_comprobantes", () => (captura.validationStatus = "rechazado")],
      ["pago_sin_cuenta", () => (f.accounts = [...f.accounts, flow])],
      ["cuenta_sin_ruc", () => (flow.issuerId = GF.id)],
      ["monto_cero", () => (f.total = 89.9)],
      ["antes_de_inicio", () => (f.orderDate = FECHA_PEDIDO)],
    ];
    for (const [esperado, arreglar] of pasos) {
      expect(motivo(f)).toBe(esperado);
      arreglar();
    }
    expect(motivo(f)).toBe("ok");
  });
});

describe("MOM §35.3 fila 1 — anulado, reembolsado, en soles", () => {
  it("anulado: el motivo va solo, sin RUC (todavía no se sabe)", () => {
    expect(invoiceEligibility(hechos({ cancelledAt: "2026-10-14T16:00:00.000Z" }))).toEqual({
      ok: false,
      reason: "anulado",
    });
  });

  it.each([
    ["un reembolso parcial", 10],
    ["un reembolso de céntimos", 0.01],
    ["un reembolso negativo (dato raro)", -5],
    ["un número que no es número", Number.NaN],
    ["infinito", Number.POSITIVE_INFINITY],
  ])("reembolsado con %s", (_porque, totalRefunded) => {
    expect(motivo(hechos({ totalRefunded }))).toBe("reembolsado");
  });

  it("sin dato de reembolso (null) no bloquea", () => {
    expect(motivo(hechos({ totalRefunded: null }))).toBe("ok");
  });

  it.each([
    ["USD", "USD"],
    ["sin moneda", null],
    ["vacía", ""],
  ])("moneda: %s", (_porque, currency) => {
    expect(motivo(hechos({ currency }))).toBe("moneda");
  });

  it("«pen» en minúsculas es soles", () => {
    expect(motivo(hechos({ currency: "pen" }))).toBe("ok");
  });
});

describe("MOM §35.3 fila 2 — todos los pagos vivos validados", () => {
  it("un posible duplicado bloquea aunque lo validado cubra el total", () => {
    const f = hechos({
      payments: [pago(), pago({ id: "pay-dup", kind: "diferencia", validationStatus: "posible_duplicado" })],
    });
    expect(motivo(f)).toBe("posible_duplicado");
  });

  it("posible_duplicado le gana a pagos_en_revision, esté donde esté en la lista", () => {
    const revision = pago({ id: "pay-rev", validationStatus: "pendiente_revision", validatedAt: null });
    const duplicado = pago({ id: "pay-dup", validationStatus: "posible_duplicado" });
    expect(motivo(hechos({ payments: [revision, duplicado] }))).toBe("posible_duplicado");
    expect(motivo(hechos({ payments: [duplicado, revision] }))).toBe("posible_duplicado");
  });

  it.each(["pendiente_revision", "info_incompleta", "revision_admin"])(
    "un pago en «%s» deja el pedido en pagos_en_revision aunque otro cubra el total",
    (validationStatus) => {
      const f = hechos({ payments: [pago(), pago({ id: "pay-2", kind: "diferencia", validationStatus })] });
      expect(motivo(f)).toBe("pagos_en_revision");
    },
  );

  it("los pagos rechazados no cuentan: ni bloquean, ni suman, ni entran en la base", () => {
    const rechazado = pago({
      id: "pay-rechazado",
      kind: "adelanto",
      amount: 999,
      validationStatus: "rechazado",
      validatedAt: null,
      vision: null,
    });
    const r = invoiceEligibility(hechos({ payments: [rechazado, pago()] }));
    expect(r).toMatchObject({ ok: true, basis: { payments: [{ id: "pay-1" }] } });
    if (r.ok) expect(r.basis.payments).toHaveLength(1);

    // Y un rechazado no completa lo que falta.
    const corto = hechos({ payments: [rechazado, pago({ amount: 100 })] });
    expect(motivo(corto)).toBe("sin_pago_completo");
  });
});

describe("MOM §35.3 fila 3 — la empresa recibió el pago", () => {
  it.each<[string, Partial<InvoiceOrderFacts>]>([
    ["lo validado no llega al total por un céntimo", { payments: [pago({ amount: 149.99 })] }],
    ["sin pagos", { payments: [] }],
    ["solo pagos rechazados", { payments: [pago({ validationStatus: "rechazado" })] }],
    ["un pago validado sin monto", { payments: [pago({ amount: null })] }],
    ["el pedido sin total", { total: null }],
    ["el pedido en cero", { total: 0, payments: [pago({ amount: 0 })] }],
    ["un monto negativo no suma", { payments: [pago({ amount: 140 }), pago({ id: "p2", amount: -10 })] }],
  ])("sin_pago_completo: %s", (_porque, over) => {
    expect(motivo(hechos(over))).toBe("sin_pago_completo");
  });

  it("un monto negativo (dato raro) tampoco resta: cuenta como 0, también en la base", () => {
    const r = invoiceEligibility(hechos({ payments: [pago({ amount: 150 }), pago({ id: "p2", amount: -10 })] }));
    expect(r).toMatchObject({ ok: true, basis: { payments: [{ id: "pay-1", amount: 150 }, { id: "p2", amount: 0 }] } });
  });

  it("prepago web confirmado (checkout + paid + sin reembolso): la cuenta es la pasarela y paidAt la fecha del pedido", () => {
    expect(invoiceEligibility(prepago())).toEqual({
      ok: true,
      issuer: GF,
      mode: "real",
      totalCents: 8990,
      paidAt: FECHA_PEDIDO,
      basis: {
        prepaid: true,
        payments: [
          { id: null, amount: 89.9, source: "prepago_web", accountIds: ["acc-flow"], validatedAt: FECHA_PEDIDO },
        ],
      },
    });
  });

  it.each<[string, Partial<InvoiceOrderFacts>]>([
    ["marcado como pagado a mano en Shopify", { paymentGateway: "manual" }],
    ["contraentrega", { paymentGateway: "cod" }],
    ["pasarela desconocida", { paymentGateway: null }],
    ["el checkout todavía no cobró", { financialStatus: "pending" }],
    ["sin estado financiero", { financialStatus: null }],
  ])("no es prepago web si está %s: sin comprobantes no hay pago completo", (_porque, over) => {
    expect(motivo(prepago(over))).toBe("sin_pago_completo");
  });

  it("«PAID» en mayúsculas también es pagado", () => {
    expect(motivo(prepago({ financialStatus: "PAID" }))).toBe("ok");
  });

  it("prepago web con un comprobante validado cargado: no se adivina cuál vale", () => {
    expect(motivo(prepago({ payments: [pago({ amount: 89.9 })] }))).toBe("prepago_con_comprobantes");
  });

  it("prepago web con un comprobante rechazado: el rechazado no cuenta", () => {
    expect(motivo(prepago({ payments: [pago({ validationStatus: "rechazado" })] }))).toBe("ok");
  });

  it("prepago web con un comprobante en revisión: primero manda la fila 2", () => {
    expect(motivo(prepago({ payments: [pago({ validationStatus: "pendiente_revision" })] }))).toBe(
      "pagos_en_revision",
    );
  });

  it("prepago web y la tienda no tiene la pasarela: pago_sin_cuenta", () => {
    const r = invoiceEligibility(prepago({ accounts: [CUENTA_GF, CUENTA_GABRIELA, CUENTA_FRANKZ] }));
    expect(r).toMatchObject({ ok: false, reason: "pago_sin_cuenta" });
  });

  it("prepago web con total 0: monto_cero, con el RUC ya decidido", () => {
    expect(invoiceEligibility(prepago({ total: 0 }))).toEqual({ ok: false, reason: "monto_cero", issuerId: GF.id });
    expect(invoiceEligibility(prepago({ total: null }))).toEqual({ ok: false, reason: "monto_cero", issuerId: GF.id });
  });
});

describe("MOM §35.3 filas 4 y 5 — cada pago tiene cuenta, y todas el mismo RUC", () => {
  it("pago_sin_cuenta: un pago validado sin lectura del comprobante, con el porqué", () => {
    const f = hechos({ payments: [pago(), pago({ id: "pay-2", amount: 0, vision: null })] });
    expect(invoiceEligibility(f)).toEqual({
      ok: false,
      reason: "pago_sin_cuenta",
      detail: "El pago no tiene lectura del comprobante.",
    });
  });

  it("pago_sin_cuenta: un comprobante validado con excepción que no es de ninguna cuenta nuestra", () => {
    const vision = lectura({ recipient_name: "Otro negocio", recipient_phone_last_digits: "555" });
    expect(motivo(hechos({ payments: [pago({ vision })] }))).toBe("pago_sin_cuenta");
  });

  it("pago_sin_cuenta: el cobro del courier sin estado de cuenta Yape", () => {
    expect(motivo(hechos({ payments: [pago({ kind: "cobro_courier" })] }))).toBe("pago_sin_cuenta");
  });

  it("cuenta_sin_ruc: la cuenta personal de una dueña («Sin comprobante»), y dice cuál", () => {
    const f = hechos({ payments: [pago({ vision: LECTURA_GABRIELA })] });
    expect(invoiceEligibility(f)).toEqual({
      ok: false,
      reason: "cuenta_sin_ruc",
      detail: "Gabriela Reaño Vera no tiene RUC.",
    });
  });

  it("cuenta_sin_ruc: la cuenta apunta a un RUC que no es de la organización", () => {
    const ajena: InvoiceAccount = { ...CUENTA_GF, issuerId: "iss-de-otra-org" };
    expect(motivo(hechos({ accounts: [ajena, CUENTA_FLOW] }))).toBe("cuenta_sin_ruc");
    expect(motivo(hechos({ issuers: [] }))).toBe("cuenta_sin_ruc");
  });

  it("cuenta_sin_ruc: una lectura parcial que encaja con una cuenta personal (alias enmascarado)", () => {
    const vision = lectura({ recipient_name: "Kastner Ca*** Fr*** Al*** Pa***" });
    expect(motivo(hechos({ payments: [pago({ vision })] }))).toBe("cuenta_sin_ruc");
  });

  it("cuenta_sin_ruc le gana a ruc_mezclados aunque el pago sin RUC venga después", () => {
    const frankzOtro: InvoiceAccount = { ...CUENTA_FRANKZ, issuerId: OTRO.id };
    const f = hechos({
      accounts: [CUENTA_GF, CUENTA_GABRIELA, frankzOtro, CUENTA_FLOW],
      payments: [
        pago({ id: "p-gf", amount: 50 }),
        pago({ id: "p-frankz", amount: 50, vision: lectura({ recipient_name: "KASTNER CAM FRANKZ ALBERTO PAOLO", recipient_phone_last_digits: "481" }) }),
        pago({ id: "p-gabriela", amount: 50, vision: LECTURA_GABRIELA }),
      ],
    });
    expect(motivo(f)).toBe("cuenta_sin_ruc");
  });

  it("ruc_mezclados: un pago a Grupo GF y otro a una cuenta de otro RUC", () => {
    const gabrielaOtro: InvoiceAccount = { ...CUENTA_GABRIELA, issuerId: OTRO.id };
    const f = hechos({
      accounts: [CUENTA_GF, gabrielaOtro, CUENTA_FRANKZ, CUENTA_FLOW],
      payments: [pago({ id: "p-gf", amount: 100 }), pago({ id: "p-gab", amount: 50, vision: LECTURA_GABRIELA })],
    });
    expect(invoiceEligibility(f)).toEqual({ ok: false, reason: "ruc_mezclados" });
  });

  it("ruc_mezclados: un solo pago cuyas cuentas candidatas son de dos RUC (dos pasarelas)", () => {
    const otraPasarela: InvoiceAccount = { id: "acc-flow-2", label: "Otra Pasarela", aliases: [], phoneLastDigits: null, issuerId: OTRO.id };
    const f = hechos({
      accounts: [...CUENTAS, otraPasarela],
      payments: [pago({ flowLinked: true })],
    });
    expect(motivo(f)).toBe("ruc_mezclados");
  });

  it("dos pagos a cuentas distintas del MISMO RUC (Yape ···309 y Flow): sí lleva comprobante", () => {
    const f = hechos({
      payments: [pago({ id: "p-yape", amount: 100 }), pago({ id: "p-flow", amount: 50, flowLinked: true, vision: null })],
    });
    expect(invoiceEligibility(f)).toMatchObject({
      ok: true,
      issuer: { id: GF.id },
      basis: {
        payments: [
          { id: "p-yape", source: "lectura_verificada", accountIds: ["acc-gf"] },
          { id: "p-flow", source: "flow", accountIds: ["acc-flow"] },
        ],
      },
    });
  });

  it("el nombre de la clienta llega al lector: su nombre en la nota del Yape no desmiente el ···309", () => {
    const vision = lectura({ recipient_name: "sonia ludeña", recipient_phone_last_digits: "309" });
    const f = hechos({ customerName: "SONIA IBETH LUDEÑA QUISPE", payments: [pago({ vision })] });
    expect(invoiceEligibility(f)).toMatchObject({
      ok: true,
      basis: { payments: [{ source: "lectura_parcial", accountIds: ["acc-gf"] }] },
    });
    expect(motivo({ ...f, customerName: null })).toBe("pago_sin_cuenta");
  });

  it("la constancia BCP «Grupo Gf S. **** 0012» entra por la fila de Grupo GF (lectura parcial)", () => {
    const vision = lectura({ recipient_name: "Grupo Gf S. **** 0012", recipient_phone_last_digits: null });
    expect(invoiceEligibility(hechos({ payments: [pago({ vision })] }))).toMatchObject({
      ok: true,
      basis: { payments: [{ source: "lectura_parcial", accountIds: ["acc-gf"] }] },
    });
  });
});

describe("MOM §35.3 fila 6 y §35.5 — el monto y el tope de S/ 700", () => {
  it("S/ 700.00 justos sí se emiten", () => {
    const r = invoiceEligibility(hechos({ total: 700, payments: [pago({ amount: 700 })] }));
    expect(r).toMatchObject({ ok: true, totalCents: 70_000 });
  });

  it("S/ 700.01 no: se emite a mano y se registra como externa", () => {
    const r = invoiceEligibility(hechos({ total: 700.01, payments: [pago({ amount: 700.01 })] }));
    expect(r).toEqual({ ok: false, reason: "monto_mayor_700", issuerId: GF.id });
  });

  it("el tope es el de la constante y la constante es S/ 700", () => {
    expect(BOLETA_MAX_CENTS).toBe(70_000);
  });
});

describe("MOM §35.3 fila 7 — el RUC encendido", () => {
  it("un RUC apagado no emite, y el motivo dice de qué RUC es", () => {
    const apagado: InvoiceIssuer = { ...GF, mode: "apagado" };
    expect(invoiceEligibility(hechos({ issuers: [apagado] }))).toEqual({
      ok: false,
      reason: "ruc_apagado",
      issuerId: GF.id,
    });
  });
});

describe("MOM §35.3 fila 8 y §35.4 — «Emitir desde»: ningún RUC emite hacia atrás", () => {
  const conDesde = (emitFrom: string | null) => [{ ...GF, emitFrom }];

  it("sin «Emitir desde» no se emite", () => {
    expect(invoiceEligibility(hechos({ issuers: conDesde(null) }))).toEqual({
      ok: false,
      reason: "antes_de_inicio",
      issuerId: GF.id,
    });
  });

  it("pagado justo en «Emitir desde»: sí", () => {
    expect(motivo(hechos({ issuers: conDesde(PAGADO) }))).toBe("ok");
  });

  it("pagado un milisegundo antes: no", () => {
    expect(motivo(hechos({ issuers: conDesde("2026-10-14T15:00:00.001Z") }))).toBe("antes_de_inicio");
  });

  it("se comparan instantes, no textos: la misma hora escrita con zona de Lima es la misma", () => {
    expect(motivo(hechos({ issuers: conDesde("2026-10-14T10:00:00-05:00") }))).toBe("ok");
    expect(motivo(hechos({ issuers: conDesde("2026-10-14T10:00:01-05:00") }))).toBe("antes_de_inicio");
  });

  it("cuenta el ÚLTIMO pago registrado: uno antes y otro después de «Emitir desde» entra", () => {
    const f = hechos({
      payments: [
        pago({ id: "p-ayer", amount: 50, registeredAt: "2026-10-13T20:00:00.000Z" }),
        pago({ id: "p-hoy", amount: 100, registeredAt: PAGADO }),
      ],
    });
    expect(invoiceEligibility(f)).toMatchObject({ ok: true, paidAt: PAGADO });
  });

  it("todos los pagos registrados antes de «Emitir desde»: no", () => {
    const f = hechos({ payments: [pago({ registeredAt: "2026-10-14T04:59:59.000Z" })] });
    expect(motivo(f)).toBe("antes_de_inicio");
  });

  it.each([
    ["sin fecha", null],
    ["con una fecha que no se entiende", "ayer"],
  ])("un pago validado registrado %s bloquea aunque otro sea de hoy: no se sabe cuándo quedó pagado", (_porque, registeredAt) => {
    const f = hechos({
      payments: [pago({ id: "p-hoy", amount: 100 }), pago({ id: "p-sin-fecha", amount: 50, registeredAt })],
    });
    expect(motivo(f)).toBe("antes_de_inicio");
  });

  // `validated_at` cambia: observar un pago lo borra (observePayment) y volver a
  // validarlo lo pone en ahora (lib/payment-validation.ts). Si contara, un pedido
  // pagado antes de «Emitir desde» se colaría con una boleta hacia atrás.
  it("pagado antes de «Emitir desde» y vuelto a validar después: no", () => {
    const f = hechos({
      payments: [pago({ registeredAt: "2026-10-13T20:00:00.000Z", validatedAt: "2026-10-14T16:00:00.000Z" })],
    });
    expect(invoiceEligibility(f)).toEqual({ ok: false, reason: "antes_de_inicio", issuerId: GF.id });
  });

  it("adelanto antes de «Emitir desde» y diferencia después: entra, y paidAt es el registro de la diferencia", () => {
    const diferencia = "2026-10-14T09:30:00.000Z";
    const f = hechos({
      payments: [
        // El adelanto se volvió a validar al final del día: su validated_at es el
        // más tardío de todos, y aun así no es la fecha de pago.
        pago({
          id: "p-adelanto",
          kind: "adelanto",
          amount: 50,
          registeredAt: "2026-10-13T20:00:00.000Z",
          validatedAt: "2026-10-14T22:00:00.000Z",
        }),
        pago({
          id: "p-diferencia",
          kind: "diferencia",
          amount: 100,
          registeredAt: diferencia,
          validatedAt: "2026-10-14T10:00:00.000Z",
        }),
      ],
    });
    expect(invoiceEligibility(f)).toMatchObject({
      ok: true,
      paidAt: diferencia,
      basis: {
        payments: [
          { id: "p-adelanto", validatedAt: "2026-10-14T22:00:00.000Z" },
          { id: "p-diferencia", validatedAt: "2026-10-14T10:00:00.000Z" },
        ],
      },
    });
  });

  it.each([
    ["sin fecha", null],
    ["con una fecha que no se entiende", "ayer"],
  ])("validated_at %s no decide nada: la fecha de pago es la del registro", (_porque, validatedAt) => {
    const r = invoiceEligibility(hechos({ payments: [pago({ validatedAt })] }));
    expect(r).toMatchObject({ ok: true, paidAt: PAGADO, basis: { payments: [{ id: "pay-1", validatedAt }] } });
  });

  it("un «Emitir desde» que no se entiende no deja emitir", () => {
    expect(motivo(hechos({ issuers: conDesde("pronto") }))).toBe("antes_de_inicio");
  });

  it("el prepago web cuenta desde la fecha del pedido, no desde un pago", () => {
    expect(motivo(prepago({ orderDate: "2026-10-14T04:00:00.000Z" }))).toBe("antes_de_inicio");
    expect(motivo(prepago({ orderDate: null }))).toBe("antes_de_inicio");
    expect(motivo(prepago({ orderDate: DESDE }))).toBe("ok");
  });
});

describe("MOM §35.3 filas 9 y 10 y §35.4 — uno por pedido, y un error no se reintenta solo", () => {
  const sim: InvoiceIssuer = { ...GF, mode: "simulacion" };

  it("ya_tiene: un comprobante real vivo (o externo) frena en real y en simulación", () => {
    const existing = { ...SIN_NADA, realLive: true };
    expect(invoiceEligibility(hechos({ existing }))).toEqual({ ok: false, reason: "ya_tiene", issuerId: GF.id });
    expect(motivo(hechos({ existing, issuers: [sim] }))).toBe("ya_tiene");
  });

  it("ya_simulado solo en simulación: una simulación no impide la emisión real", () => {
    const existing = { ...SIN_NADA, simulated: true };
    expect(invoiceEligibility(hechos({ existing, issuers: [sim] }))).toEqual({
      ok: false,
      reason: "ya_simulado",
      issuerId: GF.id,
    });
    expect(motivo(hechos({ existing }))).toBe("ok");
  });

  it("error_previo solo en real: la simulación de un pedido con error sí se arma", () => {
    const existing = { ...SIN_NADA, errorBlocked: true };
    expect(invoiceEligibility(hechos({ existing }))).toEqual({ ok: false, reason: "error_previo", issuerId: GF.id });
    expect(motivo(hechos({ existing, issuers: [sim] }))).toBe("ok");
  });
});

describe("MOM §35.3 y §35.8 — la conexión del RUC (solo en real)", () => {
  it.each<[string, Partial<InvoiceIssuer>]>([
    ["sin token", { hasToken: false }],
    ["sin prueba de conexión", { checkedRuc: null }],
    ["la prueba leyó OTRO RUC", { checkedRuc: RUC_OTRO }],
  ])("sin_conexion: %s", (_porque, over) => {
    expect(invoiceEligibility(hechos({ issuers: [{ ...GF, ...over }] }))).toEqual({
      ok: false,
      reason: "sin_conexion",
      issuerId: GF.id,
    });
  });

  it("en simulación no hace falta token ni prueba", () => {
    const sim: InvoiceIssuer = { ...GF, mode: "simulacion", hasToken: false, checkedRuc: RUC_OTRO };
    expect(motivo(hechos({ issuers: [sim] }))).toBe("ok");
  });
});

// ── A qué cuenta entró cada pago ─────────────────────────────────────────────

describe("MOM §35.2 — resolvePaymentAccounts: la primera señal que exista, en orden", () => {
  const resolver = (over: Partial<InvoicePayment>, accounts = CUENTAS, customer: string | null = null) =>
    resolvePaymentAccounts(pago(over), accounts, customer);

  it("1. link de Flow: la pasarela, aunque el estado de cuenta y el lector digan otra cosa", () => {
    expect(
      resolver({ flowLinked: true, statementDestination: "Gabriela Reaño Vera", vision: LECTURA_GABRIELA }),
    ).toEqual({ ok: true, value: { paymentId: "pay-1", source: "flow", accountIds: ["acc-flow"] } });
  });

  it("1. link de Flow y la tienda sin pasarela: no se adivina", () => {
    expect(resolver({ flowLinked: true }, [CUENTA_GF, CUENTA_GABRIELA])).toEqual({
      ok: false,
      detail: "Pago por Flow y la tienda no tiene la cuenta de la pasarela.",
    });
  });

  it("1. constancia de Flow que Flow confirmó pagada (`vision.flow.state = 'pagado'`): la pasarela", () => {
    // lib/flow/verify.ts le pregunta a Flow por la orden de la constancia; si
    // la confirma pagada en la cuenta de la tienda, el lector no tiene nombre ni
    // celular que contrastar, pero el dinero entró por la pasarela.
    const vision = { flow: { state: "pagado", flowOrder: "184932654" }, extracted: {} };
    expect(resolver({ vision })).toEqual({
      ok: true,
      value: { paymentId: "pay-1", source: "flow", accountIds: ["acc-flow"] },
    });
    expect(resolver({ vision }, [CUENTA_GF, CUENTA_GABRIELA])).toEqual({
      ok: false,
      detail: "Pago por Flow y la tienda no tiene la cuenta de la pasarela.",
    });
  });

  it("1. una constancia de Flow que Flow NO confirmó no es la pasarela", () => {
    for (const state of ["no_pagado", "no_encontrado", "sin_flow", "error"]) {
      const r = resolver({ vision: { flow: { state, flowOrder: "184932654" }, extracted: {} } });
      expect(r.ok, state).toBe(false);
    }
  });

  it("2. estado de cuenta Yape: manda sobre el lector del comprobante", () => {
    expect(resolver({ statementDestination: "GRUPO GF S.A.C.", vision: LECTURA_GABRIELA })).toEqual({
      ok: true,
      value: { paymentId: "pay-1", source: "estado_yape", accountIds: ["acc-gf"] },
    });
  });

  it.each([
    ["el nombre en mayúsculas y con puntos", "GRUPO GF S.A.C.", "acc-gf"],
    ["el nombre como está en la cuenta", "Grupo GF S.A.C.", "acc-gf"],
    ["el nombre sin puntos", "Grupo GF SAC", "acc-gf"],
    ["con tildes y eñe", "GABRIELA REAÑO VERA", "acc-gabriela"],
    ["el alias de la constancia (apellidos primero)", "Kastner Cam Frankz Alberto Paolo", "acc-frankz"],
  ])("2. el destino encaja por statementAccountKey: %s", (_porque, statementDestination, cuenta) => {
    expect(resolver({ statementDestination })).toEqual({
      ok: true,
      value: { paymentId: "pay-1", source: "estado_yape", accountIds: [cuenta] },
    });
  });

  it.each([
    ["una cuenta que la tienda no tiene", "Otra Empresa S.A.C."],
    ["un nombre recortado (no es igualdad)", "Grupo GF"],
  ])("2. el destino es %s: falla, no cae al lector", (_porque, statementDestination) => {
    expect(resolver({ statementDestination })).toEqual({
      ok: false,
      detail: "El estado de cuenta Yape lo llevó a una cuenta que la tienda no tiene.",
    });
  });

  it("el cobro del courier con estado de cuenta Yape sí tiene cuenta", () => {
    expect(resolver({ kind: "cobro_courier", statementDestination: "GRUPO GF S.A.C." })).toMatchObject({
      ok: true,
      value: { source: "estado_yape", accountIds: ["acc-gf"] },
    });
  });

  it("el cobro del courier sin estado de cuenta: falla aunque el lector diga Grupo GF (§35.9)", () => {
    expect(resolver({ kind: "cobro_courier" })).toEqual({
      ok: false,
      detail: "Cobro del courier sin estado de cuenta Yape.",
    });
  });

  it.each([
    ["con el aviso de Yape Empresa", true],
    ["sin el aviso", false],
  ])("«Te yapearon» %s: no dice cuál de nuestras cuentas recibió", (_porque, yape_empresa_marker) => {
    const vision = lectura({
      payer_name: "Guadalupe Del*",
      received_view: true,
      yape_empresa_marker,
      recipient_check: "verified",
    });
    expect(resolver({ vision })).toEqual({
      ok: false,
      detail: "Captura «Te yapearon»: no dice cuál de nuestras cuentas recibió.",
    });
  });

  it.each<[string, Extraido, string]>([
    ["Grupo GF con nombre y celular", { recipient_name: "Grupo GF S.A.C.", recipient_phone_last_digits: "309" }, "acc-gf"],
    ["Grupo GF con el celular entero", { recipient_name: "GRUPO GF SAC", recipient_phone_last_digits: "930 555 309" }, "acc-gf"],
    ["la cuenta de Gabriela", { recipient_name: "Gabriela Reaño Vera", recipient_phone_last_digits: "147" }, "acc-gabriela"],
    ["el alias de Frankz", { recipient_name: "KASTNER CAM FRANKZ ALBERTO PAOLO", recipient_phone_last_digits: "481" }, "acc-frankz"],
    ["la pasarela, que no muestra celular", { recipient_name: "Aurela Kenku", recipient_phone_last_digits: null }, "acc-flow"],
    [
      "la lectura invertida (pagador y receptor cambiados) se corrige",
      { payer_name: "Grupo Gf S.a.c.", recipient_name: "Gloria Fujimotom", recipient_phone_last_digits: "309" },
      "acc-gf",
    ],
  ])("3. lectura verificada: %s → esa cuenta", (_porque, extraido, cuenta) => {
    expect(resolver({ vision: lectura(extraido) })).toEqual({
      ok: true,
      value: { paymentId: "pay-1", source: "lectura_verificada", accountIds: [cuenta] },
    });
  });

  it.each<[string, Extraido, string[]]>([
    ["constancia BCP con la cuenta enmascarada", { recipient_name: "Grupo Gf S. **** 0012" }, ["acc-gf"]],
    ["nombre recortado por la pantalla", { recipient_name: "Grupo Gf S" }, ["acc-gf"]],
    ["Plin con la billetera al final", { recipient_name: "Grupo Gf S - Yape" }, ["acc-gf"]],
    ["BBVA con el celular pegado al nombre", { recipient_name: "Grupo gf s •5309" }, ["acc-gf"]],
    ["solo el celular ···309", { recipient_name: null, recipient_phone_last_digits: "309" }, ["acc-gf"]],
    ["el alias enmascarado de Frankz", { recipient_name: "Kastner Ca*** Fr*** Al*** Pa***" }, ["acc-frankz"]],
  ])("4. lectura parcial: %s → solo las cuentas con que encaja", (_porque, extraido, cuentas) => {
    expect(resolver({ vision: lectura(extraido) })).toEqual({
      ok: true,
      value: { paymentId: "pay-1", source: "lectura_parcial", accountIds: cuentas },
    });
  });

  it("4. una lectura parcial que encaja con dos cuentas devuelve las dos (y el RUC sale solo si comparten)", () => {
    const plinGf: InvoiceAccount = { id: "acc-plin-gf", label: "Grupo GF S.A.C.", aliases: [], phoneLastDigits: "777", issuerId: GF.id };
    const r = resolver({ vision: lectura({ recipient_name: "Grupo Gf S" }) }, [...CUENTAS, plinGf]);
    expect(r).toEqual({
      ok: true,
      value: { paymentId: "pay-1", source: "lectura_parcial", accountIds: ["acc-gf", "acc-plin-gf"] },
    });
  });

  it("4. una cuenta mal cargada (celular que no son tres dígitos) no es candidata", () => {
    const malCargada: InvoiceAccount = { id: "acc-mal", label: "Cuenta Mal Cargada", aliases: [], phoneLastDigits: "12", issuerId: OTRO.id };
    const vision = lectura({ recipient_name: null, recipient_phone_last_digits: "309" });
    expect(resolver({ vision }, [...CUENTAS, malCargada])).toEqual({
      ok: true,
      value: { paymentId: "pay-1", source: "lectura_parcial", accountIds: ["acc-gf"] },
    });
  });

  it("4. sin cuentas con las que contrastar, una lectura parcial no da cuenta", () => {
    const vision = lectura({ recipient_name: null, recipient_phone_last_digits: "309" });
    expect(resolver({ vision }, [])).toEqual({
      ok: false,
      detail: "El comprobante no dice con claridad a qué cuenta se pagó.",
    });
  });

  it("el nombre de la clienta en la nota del Yape no es el receptor: se juzga por el celular", () => {
    const vision = lectura({ recipient_name: "sonia ludeña", recipient_phone_last_digits: "309" });
    expect(resolver({ vision }, CUENTAS, "SONIA IBETH LUDEÑA QUISPE")).toEqual({
      ok: true,
      value: { paymentId: "pay-1", source: "lectura_parcial", accountIds: ["acc-gf"] },
    });
    // Sin el nombre de la clienta, ese nombre desmiente la cuenta.
    expect(resolver({ vision }, CUENTAS, null)).toMatchObject({ ok: false });
  });

  it.each<[string, Extraido]>([
    ["otro receptor con otro celular", { recipient_name: "Otro negocio", recipient_phone_last_digits: "555" }],
    ["nuestro nombre recortado con un celular ajeno", { recipient_name: "Grupo Gf S", recipient_phone_last_digits: "123" }],
    ["nombre de una cuenta y celular de otra", { recipient_name: "Gabriela Reaño Vera", recipient_phone_last_digits: "309" }],
  ])("mismatch validado con excepción: %s → sin cuenta", (_porque, extraido) => {
    expect(resolver({ vision: lectura(extraido) })).toEqual({
      ok: false,
      detail: "El comprobante no es de ninguna cuenta nuestra (validado con excepción).",
    });
  });

  it("se recalcula con las cuentas vivas, nunca con el recipient_check guardado", () => {
    const vision = lectura({
      recipient_name: "Otro negocio",
      recipient_phone_last_digits: "555",
      recipient_check: "verified",
      recipient_account: "Grupo GF S.A.C.",
    });
    expect(resolver({ vision })).toMatchObject({ ok: false });
    // Y si la cuenta ya no está activa, la lectura de Grupo GF ya no encaja.
    expect(resolver({}, [CUENTA_GABRIELA, CUENTA_FRANKZ, CUENTA_FLOW])).toMatchObject({ ok: false });
  });

  it.each<[string, unknown]>([
    ["sin vision", null],
    ["vision vacía", {}],
    ["sin extracted", { ok: true }],
    ["extracted sin receptor", lectura({})],
  ])("sin lectura (%s): no se adivina", (_porque, vision) => {
    expect(resolver({ vision })).toEqual({ ok: false, detail: "El pago no tiene lectura del comprobante." });
  });

  it("gatewayAccounts: las cuentas sin celular son la pasarela", () => {
    expect(gatewayAccounts(CUENTAS).map((a) => a.id)).toEqual(["acc-flow"]);
    expect(gatewayAccounts([CUENTA_GF])).toEqual([]);
  });
});

// ── RUC y subdominio ─────────────────────────────────────────────────────────

describe("MOM §35.2 — isValidRuc", () => {
  it.each([
    ["GRUPO GF S.A.C.", RUC_GF],
    ["con espacios alrededor", ` ${RUC_GF} `],
    ["persona natural (10)", "10123456781"],
    ["suma múltiplo de 11: el dígito es 1", "20000000061"],
    ["resto 1: el dígito es 0", "20000000010"],
  ])("válido: %s", (_porque, ruc) => {
    expect(isValidRuc(ruc)).toBe(true);
  });

  it.each([
    ["dígito verificador equivocado", "20556792828"],
    ["resto 0 con dígito 0", "20000000060"],
    ["resto 1 con dígito 1", "20000000011"],
    // Estos tendrían el dígito bien: lo que falla es el prefijo.
    ["prefijo 30", "30556792824"],
    ["prefijo 11", "11556792820"],
    ["prefijo 00", "00556792828"],
    ["diez dígitos", "2055679282"],
    ["doce dígitos", "205567928290"],
    ["con letras", "2055679282X"],
    ["vacío", ""],
    ["null", null],
    ["undefined", undefined],
  ])("inválido: %s", (_porque, ruc) => {
    expect(isValidRuc(ruc)).toBe(false);
  });
});

describe("MOM §35.2 — el token solo viaja a un subdominio de simplefact.pe", () => {
  it.each([
    ["el subdominio solo", "grupogf", "grupogf"],
    ["en mayúsculas", "GrupoGF", "grupogf"],
    ["con espacios", "  grupogf  ", "grupogf"],
    ["con guion", "grupo-gf", "grupo-gf"],
    ["con el dominio", "grupogf.simplefact.pe", "grupogf"],
    ["la dirección pegada entera, con ruta", "https://grupogf.simplefact.pe/api/v1/sales/orders", "grupogf"],
    ["en http y mayúsculas", "HTTP://GRUPOGF.SIMPLEFACT.PE/", "grupogf"],
    ["63 caracteres", "a".repeat(63), "a".repeat(63)],
  ])("normalizeSubdomain: %s", (_porque, entrada, esperado) => {
    expect(normalizeSubdomain(entrada)).toBe(esperado);
  });

  it.each([
    ["otro dominio que termina en simplefact.pe.evil.com", "grupogf.simplefact.pe.evil.com"],
    ["otro dominio", "evil.com"],
    ["otro dominio con simplefact.pe en la ruta", "https://evil.com/grupogf.simplefact.pe"],
    ["con puerto", "grupogf.simplefact.pe:8443"],
    ["con usuario", "user@grupogf.simplefact.pe"],
    ["dos niveles", "a.b.simplefact.pe"],
    ["el dominio solo", "simplefact.pe"],
    ["empieza con guion", "-grupogf"],
    ["termina con guion", "grupogf-"],
    ["guion bajo", "grupo_gf"],
    ["64 caracteres", "a".repeat(64)],
    ["vacío", ""],
    ["solo espacios", "   "],
    ["null", null],
    ["undefined", undefined],
  ])("normalizeSubdomain rechaza %s", (_porque, entrada) => {
    expect(normalizeSubdomain(entrada)).toBeNull();
  });

  it("simplefactBaseUrl: siempre https y siempre *.simplefact.pe/api/v1", () => {
    expect(simplefactBaseUrl("grupogf")).toBe("https://grupogf.simplefact.pe/api/v1");
    expect(simplefactBaseUrl("https://GRUPOGF.simplefact.pe/")).toBe("https://grupogf.simplefact.pe/api/v1");
    expect(SIMPLEFACT_DOMAIN).toBe("simplefact.pe");
  });

  it.each(["evil.com", "grupogf.simplefact.pe.evil.com", "", "grupo gf"])(
    "simplefactBaseUrl lanza con «%s»",
    (entrada) => {
      expect(() => simplefactBaseUrl(entrada)).toThrow("Subdominio de SimpleFact inválido");
    },
  );
});

// ── El RUC que dicen los archivos de SimpleFact ──────────────────────────────

/** «Listar ventas»: el cuerpo 200 de la documentación (api/sales). */
const LISTA_DOCS = {
  data: [
    {
      id: 409,
      invoice_type_name: "Factura de Venta Electrónica",
      invoice_type: "01",
      serie: "F001",
      correlative: "141",
      customer_name: "ACR TECHNOLGIES SAC",
      status: "processing",
      total: "40000.00",
      currency: "PEN",
      xml_url: "https://demo.simplefact.pe/app/download/invoices/20601643316-01-F001-141.xml",
      pdf_url: "https://demo.simplefact.pe/app/download/invoices/20601643316-01-F001-141.pdf",
      bill: {
        id: 276,
        message: "La Factura numero F001-141, ha sido aceptada",
        order_id: 409,
        cdr_url: "https://demo.simplefact.pe/app/download/invoices/R-20601643316-01-F001-141.zip",
        status: "accepted",
      },
      void: null,
      notes: null,
      items: [],
      origin: "api",
    },
  ],
  links: { first: "https://demo.simplefact.pe/api/v1/sales/orders?page=1", next: null },
  meta: { current_page: 1, last_page: 237, total: 237 },
};

/** «Crear una venta»: el cuerpo 200 de la documentación (la boleta B001-97). */
const VENTA_DOCS = {
  success: true,
  data: {
    id: 407,
    invoice_type: "03",
    invoice_type_name: "Boleta de Venta Electrónica",
    invoice_number: "B001-97",
    serie: "B001",
    correlative: "97",
    customer_name: "Juan Perez",
    customer_document_type: "1",
    customer_document_number: "00000000",
    status: "processing",
    total: "644.00",
    currency: "PEN",
    // En la venta creada los enlaces son de la CDN: no dicen el RUC.
    xml_url: "https://demo.simplefact.pe/cdn/ZXlKcGRpSTZJamRselVHWkJhRElyZUZOSWNsZHZWSGhOYlVFOVBTSXNJbloiZlE9PQ==",
    pdf_url: "https://demo.simplefact.pe/cdn/ZXlKcGRpE5kVEp3VGxCcU5YRkdXV05zYVVFOVBTSXNJblpoYkhWbElqb2lie=",
    notes: null,
    bill: {
      id: 275,
      order_id: 407,
      xml_path: "invoices/20601643316-03-B001-97.xml",
      cdr_path: null,
      pdf_path: "invoices/20601643316-03-B001-97.pdf",
      status: "success",
      error: null,
      message: "Enviado a SUNAT",
    },
  },
};

// El demo de la documentación usa el RUC 20601643316, que no cumple el dígito
// verificador. Da igual: lo que se lee se contrasta contra el RUC declarado.
const RUC_DEMO = "20601643316";

describe("MOM §35.4 — el RUC sale del nombre de los archivos de SimpleFact", () => {
  it.each([
    ["la ruta del XML de una boleta", "invoices/20601643316-03-B001-97.xml"],
    ["el enlace del XML de una factura", "https://demo.simplefact.pe/app/download/invoices/20601643316-01-F001-141.xml"],
    ["el CDR, que empieza por «R-»", "https://demo.simplefact.pe/app/download/invoices/R-20601643316-01-F001-141.zip"],
    ["una nota de crédito", "invoices/20601643316-07-BC01-3.xml"],
  ])("rucFromSimplefactText: %s", (_porque, texto) => {
    expect(rucFromSimplefactText(texto)).toBe(RUC_DEMO);
  });

  it.each<[string, unknown]>([
    ["un enlace de la CDN", VENTA_DOCS.data.xml_url],
    ["doce dígitos", "invoices/120601643316-03-B001-97.xml"],
    ["un tipo de comprobante que no existe", "invoices/20601643316-02-B001-97.xml"],
    ["sin correlativo", "invoices/20601643316-03-B001-.xml"],
    ["null", null],
    ["un número", 20601643316],
  ])("rucFromSimplefactText: nada con %s", (_porque, texto) => {
    expect(rucFromSimplefactText(texto)).toBeNull();
  });

  it("rucFromSimplefactSale: la venta creada lo dice en bill.xml_path", () => {
    expect(rucFromSimplefactSale(VENTA_DOCS.data)).toBe(RUC_DEMO);
  });

  it("rucFromSimplefactSale: la venta de la lista lo dice en xml_url", () => {
    const sale = LISTA_DOCS.data[0]!;
    expect(rucFromSimplefactSale(sale)).toBe(RUC_DEMO);
    expect(rucFromSimplefactSale({ ...sale, bill: {} })).toBe(RUC_DEMO);
  });

  it("rucFromSimplefactSale: con solo el CDR también", () => {
    const sale = { id: 1, bill: { cdr_url: LISTA_DOCS.data[0]!.bill.cdr_url } };
    expect(rucFromSimplefactSale(sale)).toBe(RUC_DEMO);
  });

  it.each<[string, unknown]>([
    ["sin archivos", { id: 1, bill: { status: "pending" } }],
    ["null", null],
    ["una lista", [VENTA_DOCS.data]],
  ])("rucFromSimplefactSale: null %s", (_porque, sale) => {
    expect(rucFromSimplefactSale(sale)).toBeNull();
  });

  it("rucFromSalesList: la lista de la documentación tiene un RUC", () => {
    expect(rucFromSalesList(LISTA_DOCS)).toEqual({ ruc: RUC_DEMO, sales: 1, ambiguous: false });
  });

  it("rucFromSalesList: dos RUC en la misma cuenta no se adivinan", () => {
    const otra = {
      ...LISTA_DOCS.data[0]!,
      id: 410,
      xml_url: `https://grupogf.simplefact.pe/app/download/invoices/${RUC_GF}-03-B001-1.xml`,
      pdf_url: null,
      bill: {},
    };
    expect(rucFromSalesList({ data: [LISTA_DOCS.data[0], otra] })).toEqual({ ruc: null, sales: 2, ambiguous: true });
  });

  it("rucFromSalesList: ventas sin archivos se cuentan pero no dan RUC", () => {
    expect(rucFromSalesList({ data: [{ id: 1 }, LISTA_DOCS.data[0], { id: 2 }] })).toEqual({
      ruc: RUC_DEMO,
      sales: 3,
      ambiguous: false,
    });
    expect(rucFromSalesList({ data: [{ id: 1 }] })).toEqual({ ruc: null, sales: 1, ambiguous: false });
  });

  it.each<[string, unknown]>([
    ["sin ventas", { data: [] }],
    ["sin data", { message: "Unauthenticated." }],
    ["data que no es lista", { data: { id: 1 } }],
    ["null", null],
    ["texto", "<html>"],
  ])("rucFromSalesList: %s", (_porque, body) => {
    expect(rucFromSalesList(body)).toEqual({ ruc: null, sales: 0, ambiguous: false });
  });
});

// ── La boleta ────────────────────────────────────────────────────────────────

const INVOICE_ID = "6f1c2a3b-1d2e-4f50-9a8b-0c1d2e3f4a5b";

const ITEMS: InvoiceItem[] = [
  { code: "FAJA-01", name: "Faja reductora talla M", qty: 2, priceCents: 4990 },
  { code: "ENVIO", name: "Servicio de envío", qty: 1, priceCents: 1000 },
];

describe("MOM §35.5 — buildSalePayload: la boleta exacta", () => {
  it("boleta 03 en soles a CLIENTES VARIOS con DNI 00000000, sin correo, IGV incluido al 18 %", () => {
    expect(buildSalePayload({ invoiceId: INVOICE_ID, orderName: "#KP1", items: ITEMS, totalCents: 10_980 })).toStrictEqual({
      invoice_type: "03",
      currency: "PEN",
      total: 109.8,
      customer_name: "CLIENTES VARIOS",
      customer_document_type: 1,
      customer_document_number: "00000000",
      email_send: false,
      notes: "Pedido #KP1 · Kapta 6f1c2a3b",
      items: [
        { code: "FAJA-01", name: "Faja reductora talla M", qty: 2, price: 49.9, tax_percent: 18 },
        { code: "ENVIO", name: "Servicio de envío", qty: 1, price: 10, tax_percent: 18 },
      ],
    });
  });

  it("las constantes de la boleta son las del MOM", () => {
    expect(BOLETA_TYPE).toBe("03");
    expect(IGV_PERCENT).toBe(18);
    expect(WALKIN_CUSTOMER).toEqual({ name: "CLIENTES VARIOS", documentType: 1, documentNumber: "00000000" });
  });

  it("no le manda a SimpleFact datos de la clienta: ni correo, ni celular, ni dirección", () => {
    const payload = buildSalePayload({ invoiceId: INVOICE_ID, orderName: "#KP1", items: ITEMS, totalCents: 10_980 });
    expect(Object.keys(payload ?? {}).sort()).toEqual(
      [
        "currency",
        "customer_document_number",
        "customer_document_type",
        "customer_name",
        "email_send",
        "invoice_type",
        "items",
        "notes",
        "total",
      ].sort(),
    );
  });

  it("sin nombre de pedido la nota es solo la referencia", () => {
    const payload = buildSalePayload({ invoiceId: INVOICE_ID, orderName: null, items: ITEMS, totalCents: 10_980 });
    expect(payload?.notes).toBe("Kapta 6f1c2a3b");
    expect(buildSalePayload({ invoiceId: INVOICE_ID, orderName: "   ", items: ITEMS, totalCents: 10_980 })?.notes).toBe(
      "Kapta 6f1c2a3b",
    );
  });

  it("recorta los espacios y los largos del código (60) y del nombre (250)", () => {
    const items: InvoiceItem[] = [{ code: `  ${"C".repeat(80)} `, name: ` ${"N".repeat(300)}  `, qty: 1, priceCents: 500 }];
    const payload = buildSalePayload({ invoiceId: INVOICE_ID, orderName: "#KP1", items, totalCents: 500 });
    expect(payload?.items[0]).toEqual({ code: "C".repeat(60), name: "N".repeat(250), qty: 1, price: 5, tax_percent: 18 });
  });

  it("S/ 700.00 justos se arman; S/ 700.01 no", () => {
    const de = (cents: number) => [{ code: "X", name: "Producto", qty: 1, priceCents: cents }];
    expect(buildSalePayload({ invoiceId: INVOICE_ID, orderName: "#KP1", items: de(70_000), totalCents: 70_000 })?.total).toBe(700);
    expect(buildSalePayload({ invoiceId: INVOICE_ID, orderName: "#KP1", items: de(70_001), totalCents: 70_001 })).toBeNull();
  });

  it.each<[string, InvoiceItem[], number]>([
    ["los ítems no suman el total (un céntimo de menos)", ITEMS, 10_981],
    ["los ítems no suman el total (un céntimo de más)", ITEMS, 10_979],
    ["sin ítems", [], 1000],
    ["cantidad con decimales", [{ code: "X", name: "Producto", qty: 1.5, priceCents: 1000 }], 1500],
    ["cantidad 0", [{ code: "X", name: "Producto", qty: 0, priceCents: 1000 }], 0],
    ["cantidad negativa", [{ code: "X", name: "Producto", qty: -1, priceCents: 1000 }, { code: "Y", name: "Otro", qty: 2, priceCents: 1000 }], 1000],
    ["precio con fracción de céntimo", [{ code: "X", name: "Producto", qty: 2, priceCents: 499.5 }], 999],
    ["precio 0 (línea gratis)", [{ code: "X", name: "Producto", qty: 1, priceCents: 1000 }, { code: "R", name: "Regalo", qty: 1, priceCents: 0 }], 1000],
    ["precio negativo", [{ code: "X", name: "Producto", qty: 1, priceCents: 2000 }, { code: "D", name: "Descuento", qty: 1, priceCents: -1000 }], 1000],
    ["código vacío", [{ code: "  ", name: "Producto", qty: 1, priceCents: 1000 }], 1000],
    ["nombre vacío", [{ code: "X", name: "", qty: 1, priceCents: 1000 }], 1000],
    ["total 0", [{ code: "X", name: "Producto", qty: 1, priceCents: 1000 }], 0],
    ["total con fracción de céntimo", [{ code: "X", name: "Producto", qty: 1, priceCents: 1000 }], 1000.5],
    ["total de más de S/ 700", [{ code: "X", name: "Producto", qty: 2, priceCents: 40_000 }], 80_000],
  ])("null: %s", (_porque, items, totalCents) => {
    expect(buildSalePayload({ invoiceId: INVOICE_ID, orderName: "#KP1", items, totalCents })).toBeNull();
  });
});

describe("MOM §35.5 — la nota «Pedido #KP… · Kapta ‹ref›»", () => {
  it("invoiceNoteRef: los primeros 8 caracteres del id, sin guiones y en minúsculas", () => {
    expect(invoiceNoteRef(INVOICE_ID)).toBe("Kapta 6f1c2a3b");
    expect(invoiceNoteRef("6F1C-2A3B-99")).toBe("Kapta 6f1c2a3b");
    expect(invoiceNoteRef(INVOICE_ID.toUpperCase())).toBe("Kapta 6f1c2a3b");
  });

  it("invoiceNote: con el nombre del pedido delante", () => {
    expect(invoiceNote("#KP136181", INVOICE_ID)).toBe("Pedido #KP136181 · Kapta 6f1c2a3b");
    expect(invoiceNote(" #KP136181 ", INVOICE_ID)).toBe("Pedido #KP136181 · Kapta 6f1c2a3b");
  });
});

// ── Lo que contestó SimpleFact ───────────────────────────────────────────────

describe("MOM §35.4 — classifySaleResponse: emitida, error o en duda", () => {
  it.each([200, 201])("%i con success y el id de la venta: emitida, con sus datos", (http) => {
    expect(classifySaleResponse(http, VENTA_DOCS, RUC_DEMO)).toEqual({
      status: "emitida",
      simplefactId: 407,
      serie: "B001",
      correlative: "97",
      pdfUrl: VENTA_DOCS.data.pdf_url,
      xmlUrl: VENTA_DOCS.data.xml_url,
      sunatStatus: "success",
      ruc: RUC_DEMO,
      rucMismatch: false,
    });
  });

  it("los archivos traen OTRO RUC que el esperado: se marca para apagar el RUC", () => {
    expect(classifySaleResponse(200, VENTA_DOCS, RUC_GF)).toMatchObject({
      status: "emitida",
      ruc: RUC_DEMO,
      rucMismatch: true,
    });
  });

  it("sin archivos que digan el RUC no se acusa un desvío", () => {
    const body = { success: true, data: { ...VENTA_DOCS.data, bill: { status: "pending" } } };
    expect(classifySaleResponse(200, body, RUC_GF)).toMatchObject({ status: "emitida", ruc: null, rucMismatch: false });
  });

  it("sin bill.status, el estado de la venta", () => {
    const body = { success: true, data: { id: 9, status: "processing", serie: "B001", correlative: 12 } };
    expect(classifySaleResponse(200, body, RUC_GF)).toEqual({
      status: "emitida",
      simplefactId: 9,
      serie: "B001",
      correlative: "12",
      pdfUrl: null,
      xmlUrl: null,
      sunatStatus: "processing",
      ruc: null,
      rucMismatch: false,
    });
  });

  it.each<[string, unknown]>([
    ["success false", { success: false, message: "Error" }],
    ["sin success", { data: VENTA_DOCS.data }],
    ["success como texto", { success: "true", data: VENTA_DOCS.data }],
    ["sin data", { success: true }],
    ["id como texto", { success: true, data: { id: "407" } }],
    ["id 0", { success: true, data: { id: 0 } }],
    ["id con decimales", { success: true, data: { id: 4.5 } }],
    ["cuerpo vacío", null],
    ["HTML", "<html>ok</html>"],
  ])("2xx %s: en_duda (la boleta puede existir)", (_porque, body) => {
    expect(classifySaleResponse(200, body, RUC_GF)).toEqual({
      status: "en_duda",
      error: "SimpleFact contestó 200 sin la venta.",
    });
  });

  it("sin respuesta (red caída o tiempo agotado): en_duda", () => {
    expect(classifySaleResponse(null, null, RUC_GF)).toEqual({ status: "en_duda", error: "SimpleFact no respondió." });
  });

  it.each([401, 403])("%i: token rechazado, se apaga el RUC", (http) => {
    expect(classifySaleResponse(http, { message: "Unauthenticated." }, RUC_GF)).toEqual({
      status: "error",
      error: `Token rechazado (${http}). Unauthenticated.`,
      stop: "issuer",
    });
    expect(classifySaleResponse(http, null, RUC_GF)).toMatchObject({ status: "error", stop: "issuer" });
  });

  it.each([404, 405])("%i: la cuenta de SimpleFact no responde, se apaga el RUC", (http) => {
    expect(classifySaleResponse(http, "<html>Not Found</html>", RUC_GF)).toEqual({
      status: "error",
      error: `La cuenta de SimpleFact no responde (${http}).`,
      stop: "issuer",
    });
  });

  it("422 con errores de validación: error con los mensajes juntos, sin apagar nada", () => {
    const body = {
      message: "The given data was invalid.",
      errors: { items: ["El campo items es obligatorio."], total: "El total no cuadra.", otro: [12, null, ""] },
    };
    expect(classifySaleResponse(422, body, RUC_GF)).toEqual({
      status: "error",
      error: "The given data was invalid. · El campo items es obligatorio. · El total no cuadra. · 12",
      stop: null,
    });
  });

  it("el mensaje sale de `error` si no hay `message`, y se corta a 500 caracteres", () => {
    expect(classifySaleResponse(400, { error: "Serie inválida" }, RUC_GF)).toEqual({
      status: "error",
      error: "Serie inválida",
      stop: null,
    });
    const largo = classifySaleResponse(422, { message: "x".repeat(800) }, RUC_GF);
    expect(largo.status === "error" && largo.error.length).toBe(500);
  });

  it.each([400, 409, 422])("%i sin cuerpo: error con el código, sin apagar nada", (http) => {
    expect(classifySaleResponse(http, null, RUC_GF)).toEqual({
      status: "error",
      error: `SimpleFact contestó ${http}.`,
      stop: null,
    });
  });

  it("429: SimpleFact pidió esperar, se corta la pasada", () => {
    expect(classifySaleResponse(429, { message: "Too Many Attempts." }, RUC_GF)).toEqual({
      status: "error",
      error: "SimpleFact pidió esperar (429).",
      stop: "run",
    });
  });

  it.each([500, 502, 503, 504, 302, 301, 408, 418, 0, 199])(
    "%i: no dice con certeza que no se creó → en_duda, nunca se repite sola",
    (http) => {
      expect(classifySaleResponse(http, { message: "Server Error" }, RUC_GF)).toEqual({
        status: "en_duda",
        error: `SimpleFact contestó ${http}.`,
      });
    },
  );
});

describe("MOM §35.4 — findSaleByNote: concilia un en_duda por la nota", () => {
  const venta = (id: number, notes: unknown) => ({ ...LISTA_DOCS.data[0], id, notes });

  it("una venta con la nota: esa", () => {
    const hit = venta(501, "Pedido #KP136181 · Kapta 6f1c2a3b");
    const body = { data: [venta(500, null), hit, venta(502, "Pedido #KP1 · Kapta 99999999")] };
    expect(findSaleByNote(body, INVOICE_ID)).toBe(hit);
  });

  it("sin distinguir mayúsculas", () => {
    const hit = venta(501, "PEDIDO #KP136181 · KAPTA 6F1C2A3B");
    expect(findSaleByNote({ data: [hit] }, INVOICE_ID)).toBe(hit);
  });

  it("ninguna: null", () => {
    expect(findSaleByNote({ data: [venta(500, null), venta(502, "Kapta 99999999")] }, INVOICE_ID)).toBeNull();
    expect(findSaleByNote(LISTA_DOCS, INVOICE_ID)).toBeNull();
  });

  it("dos con la misma referencia no se adivinan: null", () => {
    const body = { data: [venta(501, "Kapta 6f1c2a3b"), venta(502, "Pedido #KP2 · Kapta 6f1c2a3b")] };
    expect(findSaleByNote(body, INVOICE_ID)).toBeNull();
  });

  it.each<[string, unknown]>([
    ["sin data", {}],
    ["data que no es lista", { data: venta(501, "Kapta 6f1c2a3b") }],
    ["null", null],
  ])("un cuerpo raro (%s): null", (_porque, body) => {
    expect(findSaleByNote(body, INVOICE_ID)).toBeNull();
  });
});

// ── Después de emitir ────────────────────────────────────────────────────────

describe("MOM §35.9 — creditNoteWarning: Kapta avisa, no emite la nota de crédito", () => {
  const base = {
    status: "emitida" as InvoiceStatus,
    mode: "real" as const,
    basisPaymentIds: ["pay-1", "pay-2"],
    validatedPaymentIds: ["pay-1", "pay-2", "pay-3"],
    cancelled: false,
    refunded: false,
  };

  it("todo en orden: sin aviso", () => {
    expect(creditNoteWarning(base)).toBeNull();
  });

  it("anulado después de la boleta (y le gana al reembolso)", () => {
    expect(creditNoteWarning({ ...base, cancelled: true, refunded: true })).toBe(
      "El pedido se anuló después del comprobante: revisa si corresponde una nota de crédito.",
    );
  });

  it("reembolsado", () => {
    expect(creditNoteWarning({ ...base, refunded: true })).toBe(
      "El pedido tiene un reembolso: revisa si corresponde una nota de crédito.",
    );
  });

  it("un pago de la base dejó de estar validado", () => {
    expect(creditNoteWarning({ ...base, validatedPaymentIds: ["pay-1"] })).toBe(
      "Un pago del comprobante ya no está validado: revisa si corresponde una nota de crédito.",
    );
  });

  it.each<InvoiceStatus>(["emitida", "en_duda", "externa"])("avisa con un comprobante %s", (status) => {
    expect(creditNoteWarning({ ...base, status, cancelled: true })).not.toBeNull();
  });

  it.each<InvoiceStatus>(["emitiendo", "error", "simulada"])("no avisa con un comprobante %s: no hay boleta", (status) => {
    expect(creditNoteWarning({ ...base, status, cancelled: true })).toBeNull();
  });

  it("una simulación nunca avisa", () => {
    expect(
      creditNoteWarning({ ...base, mode: "simulacion", status: "simulada", cancelled: true, refunded: true, validatedPaymentIds: [] }),
    ).toBeNull();
    expect(creditNoteWarning({ ...base, mode: "simulacion", cancelled: true })).toBeNull();
  });
});

// ── Constantes, etiquetas, la 0257 y la 0258 ─────────────────────────────────

describe("MOM §35.3 a §35.6 — los motivos, las etiquetas y la base dicen lo mismo", () => {
  // Las tablas, sus restricciones y sus índices son de la 0257, que corrió en
  // producción y no se reescribe; el turno vigente es el de la 0258.
  const sql = readFileSync(resolve(process.cwd(), "db/migrations/0257_invoices.sql"), "utf8");
  const sql0258 = readFileSync(resolve(process.cwd(), "db/migrations/0258_invoices_hardening.sql"), "utf8");
  const claim = /create or replace function invoice_claim\([\s\S]*?\n\$\$;/.exec(sql0258)?.[0] ?? "";
  const mom = readFileSync(resolve(process.cwd(), "docs/mom/master-pedidos-v1.md"), "utf8");

  it("cada motivo y cada estado tiene su texto para el panel", () => {
    expect(Object.keys(INVOICE_REASON_LABEL).sort()).toEqual([...INVOICE_REASONS].sort());
    for (const reason of INVOICE_REASONS) expect(INVOICE_REASON_LABEL[reason].trim()).not.toBe("");
    expect(Object.keys(INVOICE_STATUS_LABEL).sort()).toEqual([...INVOICE_STATUSES].sort());
  });

  it("la tabla de §35.3 nombra los motivos de la regla pura, en el mismo orden", () => {
    const desde = mom.indexOf("### 35.3 Cuándo se emite");
    const hasta = mom.indexOf("### 35.4", desde);
    expect(desde).toBeGreaterThan(0);
    const filas = mom
      .slice(desde, hasta)
      .split("\n")
      .filter((l) => /^\| \d+ \|/.test(l));
    expect(filas).toHaveLength(10);
    const codigos = filas.flatMap((l) => [...(l.split("|").at(-2) ?? "").matchAll(/`([a-z_0-9]+)`/g)].map((m) => m[1]));
    expect(codigos).toEqual(INVOICE_REASONS.slice(0, INVOICE_REASONS.indexOf("sin_conexion")));
  });

  it("cada motivo que devuelve invoice_claim existe en INVOICE_REASONS", () => {
    expect(claim).not.toBe("");
    const deLaBase = [...claim.matchAll(/'reason', '([a-z_0-9]+)'/g)].map((m) => m[1]);
    expect(deLaBase.length).toBeGreaterThan(5);
    expect(deLaBase).toContain("pagos_en_revision");
    for (const r of deLaBase) expect(INVOICE_REASONS).toContain(r);
  });

  it("modos, estados y el comprobante real vivo son los de la 0257", () => {
    expect(sql).toContain(`check (mode in (${INVOICE_MODES.map((m) => `'${m}'`).join(", ")}))`);
    expect(sql).toContain(`check (status in (${INVOICE_STATUSES.map((s) => `'${s}'`).join(", ")}))`);
    const indice = /create unique index if not exists order_invoices_one_real[\s\S]*?status in \(([^)]*)\)/.exec(sql);
    expect(indice?.[1]?.split(",").map((s) => s.trim().replace(/'/g, ""))).toEqual([...LIVE_REAL_STATUSES]);
  });

  it("el tope diario, el tope por pasada y los S/ 700 son los de la base y el MOM", () => {
    expect(sql).toMatch(
      new RegExp(
        `default ${INVOICE_DAILY_LIMIT_DEFAULT}\\s+check \\(daily_limit between ${INVOICE_DAILY_LIMIT_MIN} and ${INVOICE_DAILY_LIMIT_MAX}\\)`,
      ),
    );
    expect(claim).toContain(`p_total > ${BOLETA_MAX_CENTS / 100}`);
    expect(INVOICE_MAX_PER_RUN).toBe(15);
    // La prosa del MOM se re-envuelve: se compara sin saltos de línea.
    expect(mom.replace(/\s+/g, " ")).toContain(`a lo más ${INVOICE_MAX_PER_RUN} comprobantes por RUC`);
  });

  it("lo que normalizeSubdomain acepta es lo que la base acepta como subdominio", () => {
    const m = /simplefact_subdomain ~ '([^']+)'/.exec(sql);
    expect(m).not.toBeNull();
    const deLaBase = new RegExp(m![1]!);
    for (const entrada of ["grupogf", "https://GRUPO-GF.simplefact.pe/x", "a".repeat(63), "9"]) {
      const sub = normalizeSubdomain(entrada);
      expect(sub).not.toBeNull();
      expect(deLaBase.test(sub!)).toBe(true);
    }
  });
});
