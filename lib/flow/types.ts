// Tipos y errores del API REST de Flow.cl.
//
// OJO CON EL NOMBRE. En este repo «flow» ya significa otra cosa: Shopify Flow,
// la automatización de carritos abandonados que entra por
// `app/api/webhooks/flow/` y guarda su secreto en `stores.flow_webhook_secret_enc`
// (migración 0014). Esto es Flow.cl, la pasarela de pagos, y NO tiene nada que
// ver. Por eso todo lo de acá lleva el prefijo `flowcl` fuera del módulo —las
// variables de entorno, la ruta del webhook—: la colisión ya existe dentro de
// la base de datos y confundirlas sería mezclar un carrito abandonado con un
// cobro real.
//
// SERVER-ONLY: el secretKey firma cada petición y nunca puede llegar al browser.

/** Producción. Mueve plata de verdad. */
export const FLOW_API_BASE = "https://www.flow.cl/api";
/**
 * Sandbox. Es una CUENTA DISTINTA de la de producción, con sus propias
 * credenciales y sus propios IDs de medio de pago — no un modo de la misma
 * cuenta. Una apiKey de producción contra este host responde «apiKey not
 * found», que suena a llave mal copiada y no lo es.
 */
export const FLOW_SANDBOX_API_BASE = "https://sandbox.flow.cl/api";

/**
 * Identificador del medio de pago «Pago con Yape One Shot» en la cuenta de
 * Aurela Kenku, comprobado el 12-09-2026 en el HTML del checkout
 * (`data-id="170"`, `alt="Yape One Shot"`).
 *
 * NO ES UN NÚMERO CUALQUIERA. El panel de Flow lista dos medios llamados
 * «Yape / Billetera» que son indistinguibles ahí: el 170 y el 152. El 152 es
 * la integración antigua —pide teléfono y código en un formulario— y cuesta
 * 0.80 PEN fijos de más por cobro; sobre un adelanto de S/ 20 eso es pagar
 * 8.9 % en vez de 4.1 %. El 170 abre la app Yape con un botón «Yapear».
 *
 * Es de PRODUCCIÓN: el sandbox tiene sus propios IDs y éste no vale allí.
 */
export const FLOW_MEDIO_YAPE_ONE_SHOT = 170;

/**
 * Estado de una orden en Flow. Los números son de Flow, no nuestros.
 *
 * `pendiente` es el estado en que nace una orden creada con `payment/create` y
 * en el que se queda mientras nadie la pague. No significa «algo va mal».
 */
export const FLOW_STATUS = {
  pendiente: 1,
  pagada: 2,
  rechazada: 3,
  anulada: 4,
} as const;

export type FlowStatusCode = (typeof FLOW_STATUS)[keyof typeof FLOW_STATUS];

/** Para leer un `status` sin escribir el número a mano en cada sitio. */
export function isFlowPaid(status: number | null | undefined): boolean {
  return status === FLOW_STATUS.pagada;
}

/**
 * Un valor de parámetro tal como viaja por el cable.
 *
 * Se admite `number` por comodidad, pero lo que se firma es SIEMPRE el
 * resultado de `String(v)` — ver `lib/flow/sign.ts`. Para montos con decimales
 * conviene pasar el string ya formateado y no dejar que JavaScript decida si
 * 20.50 se escribe «20.5».
 */
export type FlowParamValue = string | number;
export type FlowParams = Record<string, FlowParamValue>;

/** Lo que devuelve `payment/create` y `payment/createEmail`. */
export interface FlowPayResponse {
  /** URL del checkout. El link se forma `url + "?token=" + token`. */
  url: string;
  token: string;
  flowOrder: number;
}

/** Datos del pago dentro de un `PaymentStatus`. */
export interface FlowPaymentData {
  date?: string | null;
  /** El medio con el que se pagó de verdad («Yape», «webpay»…). */
  media?: string | null;
  amount?: number | null;
  currency?: string | null;
  /** Comisión de Flow. */
  fee?: number | null;
  /** Lo que queda por abonar tras la comisión. */
  balance?: number | null;
  transferDate?: string | null;
  conversionDate?: string | null;
  conversionRate?: number | null;
}

/** Lo que devuelve `payment/getStatus`. */
export interface FlowPaymentStatus {
  flowOrder: number;
  commerceOrder: string;
  requestDate: string;
  status: number;
  subject: string;
  currency: string;
  amount: number;
  /** Email del pagador. */
  payer: string;
  optional?: unknown;
  pending_info?: { media?: string | null; date?: string | null } | null;
  paymentData?: FlowPaymentData | null;
  merchantId?: string | null;
}

/**
 * Error de negocio de Flow. Su objeto `Error` trae `code` numérico y
 * `message`, y el `message` es la parte útil: «apiKey not found»,
 * «The userEmail: … is not valid», «Transaction not found».
 */
export class FlowApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: number | null = null,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = "FlowApiError";
  }

  /**
   * ¿El fallo es que Flow no reconoce la apiKey? Distinguirlo importa porque
   * se parece a una llave mal copiada y casi siempre es otra cosa: la llave de
   * producción usada contra el sandbox, o al revés.
   */
  get isUnknownApiKey(): boolean {
    return /apikey not found/i.test(this.message);
  }
}

export class FlowTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FlowTimeoutError";
  }
}
