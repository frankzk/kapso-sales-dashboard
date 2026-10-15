// Comprobantes electrónicos por RUC (MOM §35). Puro: sin base ni red.
//
// Grupo GF tiene cuatro razones sociales, cada una con su RUC y su cuenta de
// SimpleFact, y la boleta de una venta la emite LA EMPRESA QUE RECIBIÓ EL
// DINERO. Aquí vive todo lo que decide: a qué cuenta entró cada pago, de qué RUC
// es el pedido, si lleva comprobante y por qué no, cómo se arma la boleta y qué
// quiere decir lo que contestó SimpleFact.
//
// LA REGLA ES CERRADA A PROPÓSITO. Una boleta enviada a SUNAT no se borra, y
// SimpleFact no tiene llave de idempotencia. En la duda —un pago que no se sabe a
// qué cuenta entró, dos RUC, un dato que no se pudo leer— el pedido no lleva
// comprobante y el panel dice por qué. Emitir de menos se arregla a mano; emitir
// de más, o al RUC equivocado, se paga en impuestos.

import {
  verifyYapeRecipient,
  yapeRecipientReadingFromVision,
  type CollectionAccount,
} from "@/lib/yape-recipient";
import { statementAccountKey } from "@/lib/yape-statement/match";
import { isWebPrepaid } from "@/lib/order-paid";
import type { PaymentGateway } from "@/lib/payment-gateway";

// ── Constantes ───────────────────────────────────────────────────────────────

/**
 * Los modos de un RUC (MOM §35.8). «Manual» es el paso entre la simulación y lo
 * automático (owner, 15-10-2026): el barrido solo simula, y una persona con
 * `invoices.manage` emite pedido por pedido con «Emitir esta boleta», con los
 * mismos candados que el barrido en real. Las primeras boletas reales salen una
 * a una y se revisan en SimpleFact antes de pasar a «Real».
 */
export const INVOICE_MODES = ["apagado", "simulacion", "manual", "real"] as const;
export type InvoiceMode = (typeof INVOICE_MODES)[number];
/** Los modos encendidos: los que el barrido mira. */
export type InvoiceEnabledMode = Exclude<InvoiceMode, "apagado">;
/**
 * Los modos de un comprobante (`order_invoices.mode`, 0257): la simulación y lo
 * enviado. Un RUC en «Manual» escribe de los dos: el barrido simula y la
 * persona que pulsa «Emitir esta boleta» envía.
 */
export type InvoiceWriteMode = Extract<InvoiceMode, "simulacion" | "real">;

export const INVOICE_MODE_LABEL: Record<InvoiceMode, string> = {
  apagado: "Apagado",
  simulacion: "Simulación",
  manual: "Manual",
  real: "Real",
};

/**
 * Bajo qué modo barre el barrido un RUC: el de la fila que escribe su turno. En
 * «Manual» el barrido no envía nada, simula como en «Simulación»: lo real lo
 * emite una persona. Apagado no se barre (null).
 */
export function invoiceSweepMode(mode: InvoiceMode): InvoiceWriteMode | null {
  if (mode === "real") return "real";
  if (mode === "simulacion" || mode === "manual") return "simulacion";
  return null;
}

export const INVOICE_STATUSES = [
  "simulada",
  "emitiendo",
  "emitida",
  "en_duda",
  "error",
  "externa",
] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

export const INVOICE_STATUS_LABEL: Record<InvoiceStatus, string> = {
  simulada: "Simulada",
  emitiendo: "Emitiendo",
  emitida: "Emitida",
  en_duda: "En duda",
  error: "Error",
  externa: "Emitida fuera de Kapta",
};

/** Un comprobante real VIVO: el que impide otro por el mismo pedido (0257). */
export const LIVE_REAL_STATUSES: readonly InvoiceStatus[] = ["emitiendo", "emitida", "en_duda", "externa"];

/**
 * S/ 700: desde ahí la boleta tiene que identificar al comprador con su
 * documento (SUNAT). Kapta no tiene el DNI de forma confiable, así que no emite
 * por encima (MOM §35.5). Inclusive: S/ 700.00 sí se emite.
 */
export const BOLETA_MAX_CENTS = 70_000;

/** Tope diario por RUC (0257): el pico medido fue 34 pedidos en un día. */
export const INVOICE_DAILY_LIMIT_DEFAULT = 40;
export const INVOICE_DAILY_LIMIT_MIN = 1;
export const INVOICE_DAILY_LIMIT_MAX = 300;

/** A lo más tantos comprobantes por RUC en una pasada del barrido (MOM §35.4). */
export const INVOICE_MAX_PER_RUN = 15;

/**
 * Desde cuándo «Emitir esta boleta» puede emitir un pedido que quedó pagado
 * ANTES de «Emitir desde» del RUC: el 01/10/2026 00:00 de Lima (owner,
 * 15-10-2026), para su último registro y también para su primer dinero
 * (`firstPaidAt`: la fecha más temprana entre el comprobante y el registro de
 * sus pagos validados). Solo con el RUC en «Manual», solo con el botón (una
 * persona) y solo si esa persona confirma que lo buscó en SimpleFact y no tiene
 * boleta (`sin_revision_simplefact`): antes de Kapta las boletas se emitían a mano, y
 * Kapta no sabe si ese pedido ya tiene una. Dos boletas son dos veces el
 * impuesto. Y solo si «Emitir desde» ya llegó: con una fecha en el futuro
 * (Ajustes la acepta), nada pagado antes de ella sale, ni con el botón. El
 * barrido nunca va hacia atrás. La base exige lo mismo (0266).
 */
export const INVOICE_BACKFILL_FROM = "2026-10-01T05:00:00.000Z";

/** El IGV va incluido en el precio de Shopify (owner, 14-10-2026). */
export const IGV_PERCENT = 18;

/** Boleta de venta electrónica. La factura (`01`) queda fuera de esta versión. */
export const BOLETA_TYPE = "03";

/**
 * El comprador de una boleta hasta S/ 700 que no se identifica (MOM §35.5). Se
 * confirma con el contador y con la primera boleta real (§35.8).
 */
export const WALKIN_CUSTOMER = {
  name: "CLIENTES VARIOS",
  documentType: 1,
  documentNumber: "00000000",
} as const;

/** El token solo viaja a un subdominio de este dominio. */
export const SIMPLEFACT_DOMAIN = "simplefact.pe";

const SUBDOMAIN_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

// ── RUC y subdominio ─────────────────────────────────────────────────────────

/**
 * ¿Es un RUC peruano bien formado? Once dígitos, un prefijo que existe (10, 15,
 * 16, 17, 20) y el dígito verificador del módulo 11 de SUNAT.
 */
export function isValidRuc(value: string | null | undefined): boolean {
  const ruc = (value ?? "").trim();
  if (!/^(10|15|16|17|20)\d{9}$/.test(ruc)) return false;
  const weights = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  const sum = weights.reduce((acc, w, i) => acc + w * Number(ruc[i]), 0);
  const check = (11 - (sum % 11)) % 10;
  return check === Number(ruc[10]);
}

/** El subdominio tal como se escribe en Ajustes, o null si no sirve. */
export function normalizeSubdomain(value: string | null | undefined): string | null {
  let raw = (value ?? "").trim().toLowerCase();
  // Se acepta pegar la dirección entera: «https://grupogf.simplefact.pe/…».
  raw = raw.replace(/^https?:\/\//, "").split("/")[0] ?? "";
  if (raw.endsWith(`.${SIMPLEFACT_DOMAIN}`)) raw = raw.slice(0, -(SIMPLEFACT_DOMAIN.length + 1));
  return SUBDOMAIN_RE.test(raw) ? raw : null;
}

/** La base de la API de una cuenta: siempre https y siempre *.simplefact.pe. */
export function simplefactBaseUrl(subdomain: string): string {
  const sub = normalizeSubdomain(subdomain);
  if (!sub) throw new Error("Subdominio de SimpleFact inválido");
  return `https://${sub}.${SIMPLEFACT_DOMAIN}/api/v1`;
}

/**
 * El RUC que aparece en el nombre de un archivo de SimpleFact:
 * «invoices/20601643316-03-B001-97.xml», «R-20601643316-01-F001-141.zip».
 */
export function rucFromSimplefactText(text: unknown): string | null {
  if (typeof text !== "string") return null;
  const m = /(?:^|[^0-9])(\d{11})-(?:01|03|07|08|09)-[A-Z0-9]{4}-\d+/i.exec(text);
  return m?.[1] ?? null;
}

function obj(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** El RUC de una venta de SimpleFact, leído de sus archivos. */
export function rucFromSimplefactSale(sale: unknown): string | null {
  const s = obj(sale);
  const bill = obj(s.bill);
  for (const candidate of [bill.xml_path, bill.pdf_path, bill.cdr_url, bill.cdr_path, s.xml_url, s.pdf_url]) {
    const ruc = rucFromSimplefactText(candidate);
    if (ruc) return ruc;
  }
  return null;
}

/**
 * Lo que dice «Probar conexión» de la lista de ventas: qué RUC tienen los
 * archivos de esa cuenta. Dos RUC distintos en la misma cuenta no se adivinan.
 */
export function rucFromSalesList(body: unknown): { ruc: string | null; sales: number; ambiguous: boolean } {
  const data = Array.isArray(obj(body).data) ? (obj(body).data as unknown[]) : [];
  const rucs = new Set<string>();
  for (const sale of data) {
    const ruc = rucFromSimplefactSale(sale);
    if (ruc) rucs.add(ruc);
  }
  return {
    ruc: rucs.size === 1 ? [...rucs][0] ?? null : null,
    sales: data.length,
    ambiguous: rucs.size > 1,
  };
}

// ── Hechos que la base le pasa a las reglas ──────────────────────────────────

/** Una cuenta de cobro de la tienda (`store_collection_accounts`) con su RUC. */
export interface InvoiceAccount {
  id: string;
  label: string;
  aliases: string[];
  /** null = cuenta sin celular: la pasarela Flow (0198). */
  phoneLastDigits: string | null;
  issuerId: string | null;
}

/** Una empresa emisora (`invoice_issuers`), sin el token. */
export interface InvoiceIssuer {
  id: string;
  orgId: string;
  ruc: string;
  legalName: string;
  mode: InvoiceMode;
  emitFrom: string | null;
  dailyLimit: number;
  hasToken: boolean;
  checkedRuc: string | null;
}

export interface InvoicePayment {
  id: string;
  kind: string;
  amount: number | null;
  validationStatus: string;
  /**
   * `order_payments.registered_at`: cuándo entró el pago a Kapta. Se fija al
   * insertar y nada lo vuelve a escribir, así que es la fecha de «quedó pagado»
   * (MOM §35.3, fila 8).
   */
  registeredAt: string | null;
  /**
   * `order_payments.paid_at`: la fecha y hora del movimiento, como la dice el
   * comprobante. Puede faltar (el lector no siempre la lee) y NO cuenta para la
   * condición 8. Solo cuenta para el piso de lo pagado antes de «Emitir desde»
   * (`INVOICE_BACKFILL_FROM`): ahí vale la más temprana entre ésta y
   * `registeredAt`, porque la plata pudo moverse antes de entrar a Kapta.
   */
  paidAt: string | null;
  /**
   * `order_payments.validated_at`: solo para auditar la base del comprobante.
   * NO dice cuándo quedó pagado: observar un pago lo borra y volver a validarlo
   * lo pone en el momento de la nueva validación.
   */
  validatedAt: string | null;
  /** `order_payments.vision`: lo que leyó el lector del comprobante. */
  vision: unknown;
  /** El pago nació de un link de Flow (`flowcl_payment_links.payment_id`). */
  flowLinked: boolean;
  /**
   * El destino del movimiento del estado de cuenta Yape que lo validó
   * (`yape_statement_matches` validado → `yape_statement_movements.destination`).
   */
  statementDestination: string | null;
}

/** Lo que hay en Kapta de un comprobante para este pedido. */
export interface InvoiceExisting {
  /** Hay uno real vivo: emitiendo, emitida, en duda o externa. */
  realLive: boolean;
  /** Ya tiene su simulación. */
  simulated: boolean;
  /** Su último intento real terminó en error y nadie pidió reintentar. */
  errorBlocked: boolean;
}

export interface InvoiceOrderFacts {
  orderId: string;
  storeId: string;
  orderName: string | null;
  /** `orders.total_amount`. */
  total: number | null;
  currency: string | null;
  cancelledAt: string | null;
  totalRefunded: number | null;
  financialStatus: string | null;
  paymentGateway: PaymentGateway | null;
  /** Fecha del pedido en Shopify (`processed_at`, si no `created_at`). */
  orderDate: string | null;
  /** Para reconocer su nombre en la nota de un Yape (`yapeRecipientReading`). */
  customerName: string | null;
  payments: InvoicePayment[];
  /** Las cuentas ACTIVAS de la tienda. */
  accounts: InvoiceAccount[];
  /** Las empresas emisoras de la organización. */
  issuers: InvoiceIssuer[];
  existing: InvoiceExisting;
}

// ── Motivos ──────────────────────────────────────────────────────────────────

export const INVOICE_REASONS = [
  // Reglas de la base (MOM §35.3, en orden).
  "anulado",
  "reembolsado",
  "moneda",
  "posible_duplicado",
  "pagos_en_revision",
  "sin_pago_completo",
  "prepago_con_comprobantes",
  "pago_sin_cuenta",
  "cuenta_sin_ruc",
  "ruc_mezclados",
  "monto_cero",
  "monto_mayor_700",
  "ruc_apagado",
  "antes_de_inicio",
  "ya_tiene",
  "ya_simulado",
  "error_previo",
  "sin_conexion",
  // La lectura de Shopify (lib/invoicing/shopify-order.ts).
  "no_encontrado",
  "sin_token_shopify",
  "prueba",
  "editado",
  "cantidad_editada",
  "envio_editado",
  "propina",
  "gift_card",
  "linea_gratuita",
  "impuesto_encima",
  "demasiadas_lineas",
  "no_cuadra",
  "total_distinto",
  "pago_web_no_confirmado",
  "lectura_fallida",
  // El turno (`invoice_claim`, 0257).
  "tope",
  "tienda",
  "pedido",
  "ruc_ajeno",
  "sin_boleta",
  // El turno pidió un modo en que el RUC no está (0261). «Emitir esta boleta»
  // también lo dice antes del turno, justo después de `ruc_apagado`: emitir a
  // mano pide un RUC en «Manual» (o «Real»). Va aquí, y no en la tabla de §35.3,
  // porque esa tabla es la del barrido, que nunca pide otro modo que el suyo.
  "modo_distinto",
  // «Emitir esta boleta» (`emitInvoiceNow`, lib/invoicing/server.ts): lo que no
  // es del pedido sino de Kapta, y que la persona que pulsó tiene que leer.
  "sin_migracion",
  "turno_fallido",
  // Lo que la persona confirmó (el RUC y el total) ya no es lo que saldría: el
  // pedido, sus pagos o la cuenta del RUC cambiaron desde que lo abrió. Lo dice
  // `emitInvoiceNow` con SU lectura, la misma con la que arma la boleta.
  "pedido_cambio",
  // Quedó pagado antes de «Emitir desde» (`INVOICE_BACKFILL_FROM`) y quien
  // pulsó no marcó que lo revisó en SimpleFact. Es de quien pulsa, no del
  // pedido: solo lo dice `emitInvoiceNow`, y el barrido nunca lo guarda.
  "sin_revision_simplefact",
  // El despliegue no es producción: una vista previa comparte la base y la
  // llave de cifrado con producción, y desde ella saldría una boleta real.
  "no_produccion",
] as const;
export type InvoiceReason = (typeof INVOICE_REASONS)[number];

export const INVOICE_REASON_LABEL: Record<InvoiceReason, string> = {
  anulado: "El pedido está anulado.",
  reembolsado: "El pedido tiene un reembolso.",
  moneda: "El pedido no está en soles.",
  posible_duplicado: "Un comprobante está marcado como posible duplicado.",
  pagos_en_revision: "Hay pagos que todavía no están validados.",
  sin_pago_completo: "Lo validado no cubre el total: la empresa todavía no recibió todo el pago.",
  prepago_con_comprobantes: "Se pagó en la web y además tiene comprobantes cargados: no se adivina cuál vale.",
  pago_sin_cuenta: "No se sabe a qué cuenta entró un pago.",
  cuenta_sin_ruc: "Un pago entró a una cuenta sin RUC asignado.",
  ruc_mezclados: "Los pagos entraron a cuentas de RUC distintos.",
  monto_cero: "El pedido no tiene monto.",
  monto_mayor_700: "Pasa de S/ 700: la boleta tiene que llevar el DNI del comprador. Se emite a mano.",
  ruc_apagado: "El RUC de la cuenta está apagado.",
  antes_de_inicio: "Quedó pagado antes de «Emitir desde» del RUC.",
  ya_tiene: "Ya tiene comprobante.",
  ya_simulado: "Ya tiene su simulación.",
  error_previo: "Su último intento terminó en error: falta que alguien pida volver a intentar.",
  sin_conexion: "El RUC no tiene token o su prueba de conexión no confirmó el RUC.",
  no_encontrado: "Shopify no devolvió el pedido.",
  sin_token_shopify: "La tienda no tiene conexión con Shopify.",
  prueba: "Es un pedido de prueba en Shopify.",
  editado: "El pedido fue editado en Shopify.",
  cantidad_editada: "Se cambió la cantidad de una línea en Shopify.",
  envio_editado: "Se quitó o cambió el envío en Shopify.",
  propina: "El pedido tiene propina.",
  gift_card: "El pedido tiene una tarjeta de regalo.",
  linea_gratuita: "Tiene una línea gratis: la boleta de un regalo no se emite sola.",
  impuesto_encima: "Shopify sumó el impuesto aparte del precio.",
  demasiadas_lineas: "Tiene más de 100 líneas.",
  no_cuadra: "El detalle de Shopify no suma el total.",
  total_distinto: "El total de Shopify no es el de Kapta.",
  pago_web_no_confirmado: "Shopify no confirma el cobro de la pasarela por el total.",
  lectura_fallida: "No se pudo leer el pedido: se vuelve a intentar en la próxima pasada.",
  tope: "Se llegó al tope diario del RUC: sale mañana.",
  tienda: "La tienda no está activa.",
  pedido: "El pedido no es de esta tienda.",
  ruc_ajeno: "El RUC no es de la organización de la tienda.",
  sin_boleta: "No se pudo armar la boleta.",
  modo_distinto: "El RUC no está en ese modo.",
  sin_migracion: "Falta aplicar una migración de comprobantes: no se emitió nada.",
  turno_fallido: "El turno de la base no respondió como se esperaba: no se envió nada a SimpleFact.",
  pedido_cambio:
    "El pedido cambió desde que lo abriste (el RUC o el total): vuelve a abrirlo y revisa la boleta antes de emitirla.",
  sin_revision_simplefact:
    "Quedó pagado antes de «Emitir desde»: falta confirmar que en SimpleFact no tiene boleta.",
  no_produccion: "Emitir solo funciona en producción: este despliegue es una vista previa.",
};

// ── A qué cuenta entró cada pago (MOM §35.2) ─────────────────────────────────

export type AccountSource = "flow" | "estado_yape" | "lectura_verificada" | "lectura_parcial" | "prepago_web";

export interface PaymentAccounts {
  /** null en el prepago web: no hay fila de pago. */
  paymentId: string | null;
  source: AccountSource;
  /** Las cuentas candidatas. El RUC sale solo si todas comparten uno. */
  accountIds: string[];
}

export type PaymentAccountsResult =
  | { ok: true; value: PaymentAccounts }
  | { ok: false; detail: string };

function asCollectionAccounts(accounts: InvoiceAccount[]): Map<CollectionAccount, InvoiceAccount> {
  const map = new Map<CollectionAccount, InvoiceAccount>();
  for (const a of accounts) {
    map.set({ name: a.label, aliases: a.aliases, phoneLastDigits: a.phoneLastDigits }, a);
  }
  return map;
}

/**
 * ¿Flow confirmó esta constancia como pagada en la cuenta de la tienda? Es la
 * marca que deja lib/flow/verify.ts al preguntarle a Flow por la orden; el
 * lector no tiene nombre ni celular que contrastar en esa pantalla.
 */
function flowConfirmed(vision: unknown): boolean {
  const root = obj(vision);
  return obj(root.flow).state === "pagado";
}

/** Las cuentas sin celular: la pasarela Flow (0198). */
export function gatewayAccounts(accounts: InvoiceAccount[]): InvoiceAccount[] {
  return accounts.filter((a) => a.phoneLastDigits === null);
}

/**
 * Las cuentas candidatas de UN pago validado, con la primera señal que exista:
 * el link de Flow, el estado de cuenta Yape, el lector del comprobante. Si
 * ninguna dice a qué cuenta entró, no se adivina.
 */
export function resolvePaymentAccounts(
  payment: InvoicePayment,
  accounts: InvoiceAccount[],
  customerName: string | null,
): PaymentAccountsResult {
  // 1. Link de Flow, o una constancia de Flow que Flow confirmó pagada en la
  // cuenta de la tienda (lib/flow/verify.ts deja `vision.flow.state =
  // 'pagado'`, MOM §12): el dinero entró por la pasarela.
  if (payment.flowLinked || flowConfirmed(payment.vision)) {
    const ids = gatewayAccounts(accounts).map((a) => a.id);
    return ids.length
      ? { ok: true, value: { paymentId: payment.id, source: "flow", accountIds: ids } }
      : { ok: false, detail: "Pago por Flow y la tienda no tiene la cuenta de la pasarela." };
  }

  // 2. Estado de cuenta Yape: el movimiento dice a qué cuenta llegó.
  if (payment.statementDestination) {
    const want = statementAccountKey(payment.statementDestination);
    const ids = accounts
      .filter((a) => [a.label, ...a.aliases].some((n) => statementAccountKey(n) === want))
      .map((a) => a.id);
    return ids.length
      ? { ok: true, value: { paymentId: payment.id, source: "estado_yape", accountIds: ids } }
      : { ok: false, detail: "El estado de cuenta Yape lo llevó a una cuenta que la tienda no tiene." };
  }

  // El cobro del courier guarda su lectura con otra forma y otra regla de
  // receptor (MOM §35.9): sin estado de cuenta no se sabe a qué cuenta entró.
  if (payment.kind === "cobro_courier") {
    return { ok: false, detail: "Cobro del courier sin estado de cuenta Yape." };
  }

  // 3 y 4. El lector del comprobante, recalculado con las cuentas vivas.
  const map = asCollectionAccounts(accounts);
  const collection = [...map.keys()];
  const reading = yapeRecipientReadingFromVision(payment.vision, collection, customerName);

  if (reading.receivedView) {
    return { ok: false, detail: "Captura «Te yapearon»: no dice cuál de nuestras cuentas recibió." };
  }
  if (reading.status === "verified" && reading.account) {
    const account = map.get(reading.account);
    return account
      ? { ok: true, value: { paymentId: payment.id, source: "lectura_verificada", accountIds: [account.id] } }
      : { ok: false, detail: "El lector encajó con una cuenta que ya no está." };
  }
  if (reading.status === "partial") {
    const ids = collection
      .filter((ca) => {
        const v = verifyYapeRecipient(reading.name, reading.phoneLastDigits, [ca]);
        return (v.status === "verified" || v.status === "partial") && v.account !== null;
      })
      .map((ca) => map.get(ca)!.id);
    return ids.length
      ? { ok: true, value: { paymentId: payment.id, source: "lectura_parcial", accountIds: ids } }
      : { ok: false, detail: "El comprobante no dice con claridad a qué cuenta se pagó." };
  }
  if (reading.status === "mismatch") {
    return { ok: false, detail: "El comprobante no es de ninguna cuenta nuestra (validado con excepción)." };
  }
  return { ok: false, detail: "El pago no tiene lectura del comprobante." };
}

// ── ¿Lleva comprobante? (MOM §35.3) ─────────────────────────────────────────

export interface InvoiceBasis {
  prepaid: boolean;
  payments: Array<{
    id: string | null;
    amount: number;
    source: AccountSource;
    accountIds: string[];
    /**
     * Cuándo se validó el pago, para auditar; en el prepago web, la fecha del
     * pedido. La fecha que decide «Emitir desde» es `paidAt`, no ésta.
     */
    validatedAt: string | null;
  }>;
}

export type InvoiceEligibility =
  | {
      ok: true;
      issuer: InvoiceIssuer;
      mode: InvoiceWriteMode;
      totalCents: number;
      /**
       * Cuándo quedó pagado: el `registeredAt` más tardío de sus pagos
       * validados, o la fecha del pedido en el prepago web (§35.3, fila 8).
       */
      paidAt: string;
      /**
       * Cuándo se movió el primer dinero del pedido: la fecha más temprana
       * entre el comprobante (`paidAt` de cada pago) y su registro
       * (`registeredAt`), de todos sus pagos validados; en el prepago web, la
       * fecha del pedido. Es la que se mide contra el piso de lo pagado antes
       * de «Emitir desde» (`INVOICE_BACKFILL_FROM`) y la que dice la
       * confirmación. No cambia la condición 8.
       */
      firstPaidAt: string;
      /**
       * Quedó pagado antes de «Emitir desde» y solo pasa por la excepción de
       * «Emitir esta boleta» (`INVOICE_BACKFILL_FROM`). Con él, `emitInvoiceNow`
       * pide que la persona confirme que lo revisó en SimpleFact y el turno va
       * con `p_backfill` (0266). Siempre false sin `emitNow`, y con «Emitir
       * desde» en el futuro.
       */
      beforeStart: boolean;
      basis: InvoiceBasis;
    }
  | {
      ok: false;
      reason: InvoiceReason;
      detail?: string;
      /** El RUC que decidió, cuando se llegó a saber. */
      issuerId?: string | null;
    };

function toCents(value: number | null | undefined): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

function time(value: string | null | undefined): number | null {
  if (!value) return null;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : null;
}

const fail = (reason: InvoiceReason, detail?: string, issuerId?: string | null): InvoiceEligibility => ({
  ok: false,
  reason,
  ...(detail ? { detail } : {}),
  ...(issuerId !== undefined ? { issuerId } : {}),
});

export interface InvoiceEligibilityOptions {
  /**
   * «Emitir esta boleta» (§35.7): una persona emite ESTE pedido ahora. Se
   * evalúa como una emisión real del barrido —cuentan el comprobante real vivo,
   * el error sin reintento y la conexión del RUC; una simulación no frena—, y el
   * RUC tiene que estar en «Manual» o en «Real»; si no, `modo_distinto`. Sin
   * esto (el barrido y el panel) un RUC en «Manual» se evalúa como en
   * «Simulación»: el barrido no emite por él.
   *
   * Y con el RUC en «Manual», un pedido pagado antes de «Emitir desde» pero
   * desde `INVOICE_BACKFILL_FROM` —su último registro y su primer dinero
   * (`firstPaidAt`)— pasa la condición 8 con `beforeStart` (owner,
   * 15-10-2026), si «Emitir desde» ya llegó (`now`). Sin `emitNow`, en
   * «Real» o con «Emitir desde» en el futuro, nunca.
   */
  emitNow?: boolean;
  /**
   * El reloj con que se mira si «Emitir desde» ya llegó, solo para la excepción
   * de lo pagado antes (`emitNow`). Por defecto, ahora. Un reloj que no se
   * entiende no cuenta como «ya llegó»: no hay excepción.
   */
  now?: Date;
}

/**
 * ¿Este pedido lleva comprobante, de qué RUC y en qué modo? Las condiciones van
 * en el orden de MOM §35.3 y la primera que falla es el motivo.
 *
 * Solo decide con lo que hay en Kapta. La lectura de Shopify (los ítems al
 * céntimo) y el turno en la base (`invoice_claim`) vienen después y vuelven a
 * revisar lo que pueden.
 */
export function invoiceEligibility(
  facts: InvoiceOrderFacts,
  opts: InvoiceEligibilityOptions = {},
): InvoiceEligibility {
  // 1. Anulado, reembolsado, en soles.
  if (facts.cancelledAt) return fail("anulado");
  const refunded = Number(facts.totalRefunded ?? 0);
  if (!Number.isFinite(refunded) || refunded !== 0) return fail("reembolsado");
  if ((facts.currency ?? "").toUpperCase() !== "PEN") return fail("moneda");

  // 2. Todos los pagos vivos validados.
  const live = facts.payments.filter((p) => p.validationStatus !== "rechazado");
  if (live.some((p) => p.validationStatus === "posible_duplicado")) return fail("posible_duplicado");
  if (live.some((p) => p.validationStatus !== "validado")) return fail("pagos_en_revision");

  // 3. La empresa recibió el pago.
  const totalCents = toCents(facts.total);
  const prepaid = isWebPrepaid({
    financialStatus: facts.financialStatus,
    totalRefunded: facts.totalRefunded,
    paymentGateway: facts.paymentGateway,
  });
  if (prepaid && live.length > 0) return fail("prepago_con_comprobantes");
  if (!prepaid) {
    const validatedCents = live.reduce((sum, p) => sum + Math.max(0, toCents(p.amount) ?? 0), 0);
    if (totalCents === null || totalCents <= 0 || validatedCents < totalCents) {
      return fail("sin_pago_completo");
    }
  }

  // 4. Cada pago tiene cuenta.
  const resolved: PaymentAccounts[] = [];
  if (prepaid) {
    const ids = gatewayAccounts(facts.accounts).map((a) => a.id);
    if (!ids.length) return fail("pago_sin_cuenta", "Prepago web y la tienda no tiene la cuenta de la pasarela.");
    resolved.push({ paymentId: null, source: "prepago_web", accountIds: ids });
  } else {
    for (const payment of live) {
      const r = resolvePaymentAccounts(payment, facts.accounts, facts.customerName);
      if (!r.ok) return fail("pago_sin_cuenta", r.detail);
      resolved.push(r.value);
    }
  }

  // 5. Todas las cuentas tienen RUC, y es el mismo.
  const byId = new Map(facts.accounts.map((a) => [a.id, a]));
  const issuersById = new Map(facts.issuers.map((i) => [i.id, i]));
  const issuerIds = new Set<string>();
  for (const r of resolved) {
    for (const id of r.accountIds) {
      const account = byId.get(id);
      const issuerId = account?.issuerId ?? null;
      if (!issuerId || !issuersById.has(issuerId)) {
        return fail("cuenta_sin_ruc", account ? `${account.label} no tiene RUC.` : undefined);
      }
      issuerIds.add(issuerId);
    }
  }
  const [onlyIssuerId] = [...issuerIds];
  if (issuerIds.size !== 1 || !onlyIssuerId) return fail("ruc_mezclados");
  const issuer = issuersById.get(onlyIssuerId)!;

  // 6. Monto.
  if (totalCents === null || totalCents <= 0) return fail("monto_cero", undefined, issuer.id);
  if (totalCents > BOLETA_MAX_CENTS) return fail("monto_mayor_700", undefined, issuer.id);

  // 7. RUC encendido.
  const sweepMode = invoiceSweepMode(issuer.mode);
  if (sweepMode === null) return fail("ruc_apagado", undefined, issuer.id);
  // Emitir a mano es una emisión real, y solo la hace un RUC que emite de
  // verdad: en «Manual» (para eso existe) o en «Real» (los mismos candados que
  // el barrido). Un RUC en «Simulación» no tiene su token probado para emitir:
  // la base no lo deja pasar a real sin esa prueba (0257), y aquí tampoco.
  if (opts.emitNow && issuer.mode !== "manual" && issuer.mode !== "real") {
    return fail("modo_distinto", `El RUC está en «${INVOICE_MODE_LABEL[issuer.mode]}».`, issuer.id);
  }
  // Sin `emitNow`, un RUC en «Manual» se evalúa como en «Simulación»: es lo
  // que hace el barrido con él.
  const mode: InvoiceWriteMode = opts.emitNow ? "real" : sweepMode;

  // 8. Pagado desde «Emitir desde». Quedó pagado cuando entró a Kapta el ÚLTIMO
  // de sus pagos validados (`registered_at`, que no cambia nunca), o en la fecha
  // del pedido si es prepago web. No cuenta `validated_at`: observar un pago lo
  // borra y volver a validarlo lo pone en ahora, y un pedido pagado antes de
  // «Emitir desde» se colaría con una boleta hacia atrás.
  const paidAt = prepaid
    ? facts.orderDate
    : live.reduce<string | null>((latest, p) => {
        if (!p.registeredAt || time(p.registeredAt) === null) return latest;
        return latest === null || time(p.registeredAt)! > time(latest)! ? p.registeredAt : latest;
      }, null);
  const paidTime = time(paidAt);
  // Un pago validado sin fecha de registro no deja saber cuándo quedó pagado:
  // no se emite.
  const undated = !prepaid && live.some((p) => time(p.registeredAt) === null);
  const from = time(issuer.emitFrom);
  if (paidTime === null || undated || from === null) return fail("antes_de_inicio", undefined, issuer.id);
  // El primer dinero: para el piso de la excepción no basta con cuándo entró a
  // Kapta el último pago. Un pago cuyo comprobante dice 29/09 y que se registró
  // el 01/10 movió la plata antes del piso, cuando las boletas se emitían a
  // mano. Cuenta la fecha más temprana entre el comprobante (`paidAt`) y el
  // registro de cada pago validado; sin fecha de comprobante, o con una que no
  // se entiende, la de registro. En el prepago web, la fecha del pedido.
  const firstPaidAt = prepaid
    ? facts.orderDate
    : live.reduce<string | null>((first, p) => {
        const registered = time(p.registeredAt);
        if (registered === null) return first;
        const receipt = time(p.paidAt);
        const at = receipt !== null && receipt < registered ? p.paidAt! : p.registeredAt!;
        return first === null || time(at)! < time(first)! ? at : first;
      }, null);
  const firstTime = time(firstPaidAt);
  // La excepción (owner, 15-10-2026): lo pagado antes de «Emitir desde», pero
  // desde el 01/10/2026 00:00 de Lima —el último registro Y el primer dinero—,
  // lo puede emitir una persona con «Emitir esta boleta» y el RUC en «Manual».
  // Antes de Kapta las boletas se emitían a mano en SimpleFact: quien pulsa
  // tiene que confirmar que lo revisó ahí (`emitInvoiceNow`). El barrido nunca
  // va hacia atrás, y en «Real» tampoco.
  // Solo con «Emitir desde» ya llegado: Ajustes acepta una fecha en el futuro
  // (un cambio de modo solo mueve una que quedó atrás), y lo pagado antes de
  // ella no sale, ni con el botón. La excepción es para lo pagado antes de un
  // inicio que ya pasó, nunca para emitir antes de la fecha que puso el owner.
  const floor = time(INVOICE_BACKFILL_FROM)!;
  const nowTime = (opts.now ?? new Date()).getTime();
  const backfill =
    opts.emitNow === true &&
    issuer.mode === "manual" &&
    Number.isFinite(nowTime) &&
    from <= nowTime &&
    paidTime >= floor &&
    firstTime !== null &&
    firstTime >= floor;
  if (paidTime < from && !backfill) return fail("antes_de_inicio", undefined, issuer.id);
  const beforeStart = paidTime < from;

  // 9. Uno por pedido.
  if (facts.existing.realLive) return fail("ya_tiene", undefined, issuer.id);
  if (mode === "simulacion" && facts.existing.simulated) return fail("ya_simulado", undefined, issuer.id);

  // 10. Un error no se reintenta solo.
  if (mode === "real" && facts.existing.errorBlocked) return fail("error_previo", undefined, issuer.id);

  // La conexión: el turno la vuelve a revisar dentro de la base.
  if (mode === "real" && (!issuer.hasToken || issuer.checkedRuc !== issuer.ruc)) {
    return fail("sin_conexion", undefined, issuer.id);
  }

  const amounts = new Map(live.map((p) => [p.id, Math.max(0, toCents(p.amount) ?? 0) / 100]));
  const validatedAt = new Map(live.map((p) => [p.id, p.validatedAt]));
  return {
    ok: true,
    issuer,
    mode,
    totalCents,
    paidAt: paidAt!,
    firstPaidAt: firstPaidAt!,
    beforeStart,
    basis: {
      prepaid,
      payments: resolved.map((r) => ({
        id: r.paymentId,
        amount: r.paymentId ? amounts.get(r.paymentId) ?? 0 : totalCents / 100,
        source: r.source,
        accountIds: r.accountIds,
        validatedAt: r.paymentId ? validatedAt.get(r.paymentId) ?? null : paidAt,
      })),
    },
  };
}

// ── La boleta (MOM §35.5) ────────────────────────────────────────────────────

/** Un ítem de la boleta: precio unitario CON IGV, en céntimos. */
export interface InvoiceItem {
  code: string;
  name: string;
  qty: number;
  priceCents: number;
}

export interface SimplefactSalePayload {
  invoice_type: typeof BOLETA_TYPE;
  currency: "PEN";
  total: number;
  customer_name: string;
  customer_document_type: number;
  customer_document_number: string;
  email_send: false;
  notes: string;
  items: Array<{ code: string; name: string; qty: number; price: number; tax_percent: number }>;
}

/** «Kapta 6f1c2a3b»: lo que busca la conciliación en la nota de la venta. */
export function invoiceNoteRef(invoiceId: string): string {
  return `Kapta ${invoiceId.replace(/-/g, "").slice(0, 8).toLowerCase()}`;
}

/** «Pedido #KP136181 · Kapta 6f1c2a3b». */
export function invoiceNote(orderName: string | null, invoiceId: string): string {
  const name = (orderName ?? "").trim();
  return name ? `Pedido ${name} · ${invoiceNoteRef(invoiceId)}` : invoiceNoteRef(invoiceId);
}

/**
 * La boleta que se manda (o que se habría mandado, en simulación). Devuelve
 * null si los ítems no suman EXACTAMENTE el total: una boleta que no cuadra no
 * se manda.
 */
export function buildSalePayload(input: {
  invoiceId: string;
  orderName: string | null;
  items: InvoiceItem[];
  totalCents: number;
}): SimplefactSalePayload | null {
  const { items, totalCents } = input;
  if (!Number.isInteger(totalCents) || totalCents <= 0 || totalCents > BOLETA_MAX_CENTS) return null;
  if (!items.length) return null;
  for (const item of items) {
    if (!Number.isInteger(item.qty) || item.qty <= 0) return null;
    if (!Number.isInteger(item.priceCents) || item.priceCents <= 0) return null;
    if (!item.code.trim() || !item.name.trim()) return null;
  }
  const sum = items.reduce((acc, item) => acc + item.priceCents * item.qty, 0);
  if (sum !== totalCents) return null;

  return {
    invoice_type: BOLETA_TYPE,
    currency: "PEN",
    total: totalCents / 100,
    customer_name: WALKIN_CUSTOMER.name,
    customer_document_type: WALKIN_CUSTOMER.documentType,
    customer_document_number: WALKIN_CUSTOMER.documentNumber,
    email_send: false,
    notes: invoiceNote(input.orderName, input.invoiceId),
    items: items.map((item) => ({
      code: item.code.trim().slice(0, 60),
      name: item.name.trim().slice(0, 250),
      qty: item.qty,
      price: item.priceCents / 100,
      tax_percent: IGV_PERCENT,
    })),
  };
}

// ── Lo que contestó SimpleFact (MOM §35.4) ───────────────────────────────────

export type SaleOutcome =
  | {
      status: "emitida";
      simplefactId: number;
      serie: string | null;
      correlative: string | null;
      pdfUrl: string | null;
      xmlUrl: string | null;
      sunatStatus: string | null;
      /** El RUC de los archivos de la venta, si se pudo leer. */
      ruc: string | null;
      /** Los archivos traen OTRO RUC que el esperado: se marca y se apaga el RUC. */
      rucMismatch: boolean;
    }
  | {
      status: "error";
      error: string;
      /**
       * `issuer`: apagar el RUC (token rechazado, cuenta inexistente) — seguir
       * llenaría de errores. `run`: cortar esta pasada (demasiadas peticiones).
       */
      stop: "issuer" | "run" | null;
    }
  | { status: "en_duda"; error: string };

function text(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function messageOf(body: unknown): string | null {
  const b = obj(body);
  const parts: string[] = [];
  const message = text(b.message) ?? text(b.error);
  if (message) parts.push(message);
  const errors = b.errors;
  if (errors && typeof errors === "object") {
    for (const value of Object.values(errors as Record<string, unknown>)) {
      const list = Array.isArray(value) ? value : [value];
      for (const v of list) {
        const t = text(v);
        if (t) parts.push(t);
      }
    }
  }
  return parts.length ? parts.join(" · ").slice(0, 500) : null;
}

/** Los 4xx que dicen con certeza que la venta NO se creó. */
const DEFINITIVE_NO = new Set([400, 401, 403, 404, 405, 409, 422, 429]);

/**
 * Qué quiere decir lo que contestó SimpleFact al crear la venta. `http` null =
 * no hubo respuesta (red caída, tiempo agotado). En la duda, `en_duda`: la
 * boleta puede existir, así que nunca se repite sola.
 */
export function classifySaleResponse(
  http: number | null,
  body: unknown,
  expectedRuc: string,
): SaleOutcome {
  if (http === null) return { status: "en_duda", error: "SimpleFact no respondió." };

  if (http >= 200 && http < 300) {
    const b = obj(body);
    const data = obj(b.data);
    const id = typeof data.id === "number" && Number.isInteger(data.id) && data.id > 0 ? data.id : null;
    if (b.success === true && id !== null) {
      const ruc = rucFromSimplefactSale(data);
      return {
        status: "emitida",
        simplefactId: id,
        serie: text(data.serie),
        correlative: text(data.correlative),
        pdfUrl: text(data.pdf_url),
        xmlUrl: text(data.xml_url),
        sunatStatus: text(obj(data.bill).status) ?? text(data.status),
        ruc,
        rucMismatch: ruc !== null && ruc !== expectedRuc,
      };
    }
    return { status: "en_duda", error: `SimpleFact contestó ${http} sin la venta.` };
  }

  if (DEFINITIVE_NO.has(http)) {
    const message = messageOf(body) ?? `SimpleFact contestó ${http}.`;
    if (http === 401 || http === 403) return { status: "error", error: `Token rechazado (${http}). ${message}`.trim(), stop: "issuer" };
    if (http === 404 || http === 405) return { status: "error", error: `La cuenta de SimpleFact no responde (${http}).`, stop: "issuer" };
    if (http === 429) return { status: "error", error: "SimpleFact pidió esperar (429).", stop: "run" };
    return { status: "error", error: message, stop: null };
  }

  return { status: "en_duda", error: `SimpleFact contestó ${http}.` };
}

/**
 * Concilia un `en_duda`: la venta cuya nota trae la referencia de este
 * comprobante. Dos ventas con la misma referencia no se adivinan.
 */
export function findSaleByNote(body: unknown, invoiceId: string): unknown | null {
  const data = Array.isArray(obj(body).data) ? (obj(body).data as unknown[]) : [];
  const ref = invoiceNoteRef(invoiceId).toLowerCase();
  const hits = data.filter((sale) => (text(obj(sale).notes) ?? "").toLowerCase().includes(ref));
  return hits.length === 1 ? hits[0] : null;
}

// ── Liberar un `en_duda` (MOM §35.4) ─────────────────────────────────────────

/**
 * Cuánto tiene que llevar un comprobante en duda antes de que una persona lo
 * libere con «No está en SimpleFact: volver a intentar»: 30 minutos.
 *
 * POR QUÉ ESPERAR. Un POST que se cortó por tiempo puede haber llegado:
 * SimpleFact recibió la venta y todavía no la muestra en su lista. Quien busca
 * la nota «Kapta ‹ref›» en ese rato no la encuentra, la libera, vuelve a pulsar
 * «Emitir esta boleta» y salen DOS boletas a SUNAT, que no se borran. Mientras
 * espera, la conciliación del barrido (cada 10 minutos) la sigue buscando y, si
 * aparece, la deja `emitida` sola. Confirmar que SÍ está en SimpleFact
 * («registrar su serie») no espera: registrar una boleta que existe no emite
 * otra.
 */
export const INVOICE_RELEASE_MIN_AGE_MS = 30 * 60_000;

/**
 * Desde cuándo se puede liberar un `en_duda` (ISO), redondeado hacia arriba al
 * minuto: el aviso dice «hasta las HH:MM», y a esa hora ya se puede.
 *
 * EL RELOJ EMPIEZA CUANDO QUEDÓ EN DUDA: `updated_at`. El candado de la base
 * (`order_invoices_guard`, 0257/0260) lo pone en now() en cada UPDATE que deja
 * pasar, y Kapta solo le escribe a una fila `en_duda` para sacarla de la duda
 * (a `emitida` o a `error`); la cascada de borrar una cuenta tampoco lo mueve
 * (0260). Así, mientras sigue en duda, `updated_at` es cuando pasó a `en_duda`:
 * al contestar SimpleFact, o en la conciliación pasados los 10 minutos de
 * `emitiendo`. Es más tarde que el POST, nunca antes, así que espera de más y
 * no de menos. `created_at` (el turno, justo antes del POST) queda de piso.
 *
 * null si no se sabe cuándo quedó en duda: entonces no se libera (falla
 * cerrada).
 */
export function invoiceReleaseAvailableAt(row: {
  createdAt: string | null | undefined;
  updatedAt: string | null | undefined;
}): string | null {
  const since = time(row.updatedAt);
  if (since === null) return null;
  const start = Math.max(since, time(row.createdAt) ?? since);
  return new Date(Math.ceil((start + INVOICE_RELEASE_MIN_AGE_MS) / 60_000) * 60_000).toISOString();
}

/**
 * «15:42», en hora de Lima. A mano y no con Intl, como `limaShort`
 * (lib/payment-review.ts): Perú es UTC-5 fijo, sin horario de verano.
 */
function limaHourMinute(iso: string): string {
  return new Date(Date.parse(iso) - 5 * 3_600_000).toISOString().slice(11, 16);
}

/** Lo que se le dice a quien quiere liberar un `en_duda` antes de tiempo. */
export function invoiceReleaseWaitText(availableAt: string): string {
  return `Espera hasta las ${limaHourMinute(availableAt)} (hora de Lima): SimpleFact puede tardar en mostrar una boleta que sí recibió. Mientras tanto Kapta la sigue buscando.`;
}

/** No se supo cuándo quedó en duda: no se libera. */
export const INVOICE_RELEASE_UNKNOWN_TEXT =
  "No se pudo saber desde cuándo está en duda: no se libera. Vuelve a abrir el pedido.";

/**
 * ¿Se puede liberar ya este `en_duda`? null: sí. Si no, lo que se le dice a la
 * persona: hasta qué hora esperar, o que no se supo desde cuándo está en duda.
 */
export function invoiceReleaseBlock(
  row: { createdAt: string | null | undefined; updatedAt: string | null | undefined },
  now: Date,
): string | null {
  const availableAt = invoiceReleaseAvailableAt(row);
  if (availableAt === null) return INVOICE_RELEASE_UNKNOWN_TEXT;
  // Un reloj que no se entiende no cuenta como «ya pasó».
  const at = now.getTime();
  return !Number.isFinite(at) || at < Date.parse(availableAt) ? invoiceReleaseWaitText(availableAt) : null;
}

// ── Avisos después de emitir (MOM §35.9) ─────────────────────────────────────

/**
 * Lo emitido no se toca, pero si después un pago dejó de estar validado o el
 * pedido se anuló o se reembolsó, alguien tiene que mirar si corresponde una
 * nota de crédito. Kapta no la emite (§2, principio 11).
 */
export function creditNoteWarning(input: {
  status: InvoiceStatus;
  mode: InvoiceWriteMode;
  basisPaymentIds: string[];
  validatedPaymentIds: string[];
  cancelled: boolean;
  refunded: boolean;
}): string | null {
  if (input.mode !== "real" || !["emitida", "en_duda", "externa"].includes(input.status)) return null;
  if (input.cancelled) return "El pedido se anuló después del comprobante: revisa si corresponde una nota de crédito.";
  if (input.refunded) return "El pedido tiene un reembolso: revisa si corresponde una nota de crédito.";
  const still = new Set(input.validatedPaymentIds);
  if (input.basisPaymentIds.some((id) => !still.has(id))) {
    return "Un pago del comprobante ya no está validado: revisa si corresponde una nota de crédito.";
  }
  return null;
}
