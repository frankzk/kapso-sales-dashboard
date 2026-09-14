// Cliente del API REST de Flow.cl (pasarela de pagos peruana/chilena).
//
//   POST /payment/create     → url + token con los que se arma el link de pago
//   GET  /payment/getStatus  ?token  → estado de la orden
//
// Tres cosas mandan sobre el diseño de este cliente:
//
//  1. `payment/create` CREA UNA ORDEN COBRABLE y no es idempotente. No se
//     reintenta nunca a ciegas: ante un corte se consulta con el
//     `commerceOrder` que ya se eligió, no se vuelve a crear. Un reintegro a
//     ciegas deja dos links vivos por el mismo pedido y el cliente puede pagar
//     los dos.
//
//  2. TODO PARÁMETRO QUE SE ENVÍA VA FIRMADO. El cuerpo se arma desde
//     `flowRequestPairs`, que es la misma función que firma: no hay un punto
//     donde se pueda añadir un campo al vuelo. Un opcional sin firmar da un
//     401 que no dice por qué (ver `lib/flow/sign.ts`).
//
//  3. LA RESPUESTA PUEDE NO SER DE FLOW. Un proxy, un portal cautivo o una
//     caída devuelven HTML con un 200 o un 403 que no es de la pasarela.
//     Tratar eso como «Flow dijo que no» es inventarse una respuesta: acá
//     falla como error de transporte y se nota.
//
// SERVER-ONLY: recibe el secretKey en claro y firma con él.

import {
  FlowApiError,
  FlowTimeoutError,
  FLOW_API_BASE,
  type FlowParams,
  type FlowPayResponse,
  type FlowPaymentStatus,
} from "./types";
import { flowRequestPairs } from "./sign";

/**
 * Flow responde rápido —crea una orden, no cobra nada— pero el asesor está
 * mirando el drawer mientras tanto. Si en 20 s no contestó, algo pasa y es
 * mejor decirlo que dejar el botón girando.
 */
export const FLOW_TIMEOUT_MS = 20_000;

export interface FlowClientOpts {
  apiKey: string;
  secretKey: string;
  /** Por omisión producción. El sandbox es otra cuenta, no un modo. */
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface FlowCreatePaymentInput {
  /** Identificador del comercio para esta orden. Es la llave de idempotencia. */
  commerceOrder: string;
  subject: string;
  /**
   * Monto. Para importes con decimales conviene pasar el string ya formateado:
   * lo que se firma es `String(valor)`, y JavaScript escribe 20.50 como «20.5».
   * El comportamiento de Flow ante decimales no se ha comprobado todavía
   * contra la API real — la sonda solo probó enteros.
   */
  amount: number | string;
  email: string;
  /** Dónde Flow avisa del pago (servidor). */
  urlConfirmation: string;
  /** Dónde vuelve el pagador (browser). */
  urlReturn: string;
  currency?: string;
  /** Medio de pago. Sin él, Flow enseña su página de selección. */
  paymentMethod?: number;
  /** Segundos hasta que la orden caduca. Sin esto queda pagable para siempre. */
  timeout?: number;
  /** JSON clave=valor que Flow devuelve tal cual en `getStatus`. */
  optional?: string;
}

export class FlowClient {
  private readonly apiKey: string;
  private readonly secretKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(opts: FlowClientOpts) {
    if (!opts.apiKey || !opts.secretKey) {
      throw new Error("FlowClient necesita apiKey y secretKey.");
    }
    this.apiKey = opts.apiKey;
    this.secretKey = opts.secretKey;
    this.baseUrl = (opts.baseUrl ?? FLOW_API_BASE).replace(/\/$/, "");
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? FLOW_TIMEOUT_MS;
  }

  /**
   * Crea la orden y devuelve el link listo para mandar.
   *
   * NO SE REINTENTA. Si esto lanza, el `commerceOrder` puede haber quedado
   * creado del otro lado: se consulta, no se repite.
   */
  async createPayment(
    input: FlowCreatePaymentInput,
  ): Promise<FlowPayResponse & { link: string }> {
    for (const campo of ["urlConfirmation", "urlReturn"] as const) {
      const url = input[campo];
      // Una variable de entorno vacía produce «undefined/api/…», que Flow
      // acepta o rechaza de formas poco claras y deja el cobro sin confirmar.
      // Se ve acá, no en el soporte de Flow tres días después.
      if (!/^https?:\/\//i.test(url)) {
        throw new Error(`\`${campo}\` debe ser una URL absoluta; llegó «${url}».`);
      }
    }

    const params: FlowParams = {
      apiKey: this.apiKey,
      commerceOrder: input.commerceOrder,
      subject: input.subject,
      amount: input.amount,
      email: input.email,
      urlConfirmation: input.urlConfirmation,
      urlReturn: input.urlReturn,
    };
    if (input.currency) params.currency = input.currency;
    if (input.paymentMethod !== undefined) params.paymentMethod = input.paymentMethod;
    if (input.timeout !== undefined) params.timeout = input.timeout;
    if (input.optional) params.optional = input.optional;

    const body = new URLSearchParams(flowRequestPairs(params, this.secretKey));
    const json = await this.request("/payment/create", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });

    const pay = json as Partial<FlowPayResponse>;
    if (!pay?.url || !pay?.token) {
      throw new FlowApiError(
        "Flow respondió sin url ni token al crear el pago.",
        200,
        null,
        json,
      );
    }
    return {
      url: pay.url,
      token: pay.token,
      flowOrder: Number(pay.flowOrder ?? 0),
      link: flowPaymentLink(pay.url, pay.token),
    };
  }

  /** Estado de una orden. Es lectura: reintentar es seguro. */
  async getStatus(token: string): Promise<FlowPaymentStatus> {
    if (!token) throw new Error("getStatus necesita el token de la transacción.");
    const pairs = flowRequestPairs({ apiKey: this.apiKey, token }, this.secretKey);
    const qs = new URLSearchParams(pairs).toString();
    return (await this.request(`/payment/getStatus?${qs}`, {
      method: "GET",
    })) as FlowPaymentStatus;
  }

  private async request(path: string, init: RequestInit): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        ...init,
        signal: controller.signal,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (controller.signal.aborted) {
        throw new FlowTimeoutError(`Flow no respondió en ${this.timeoutMs} ms (${path}).`);
      }
      throw new FlowTimeoutError(`No hubo respuesta de Flow (${path}): ${msg}`);
    } finally {
      clearTimeout(timer);
    }

    const text = await res.text();
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* más abajo */
    }

    // Sin JSON no contestó Flow, contestó otra cosa: un proxy, un portal
    // cautivo, una página de error. Darlo por «Flow rechazó el pago» sería
    // afirmar algo que nadie dijo.
    if (json === null || typeof json !== "object") {
      throw new FlowTimeoutError(
        `Respuesta no-JSON de Flow (HTTP ${res.status}, ${path}): ${text.slice(0, 200)}`,
      );
    }

    if (!res.ok) {
      const err = json as { code?: number; message?: string };
      throw new FlowApiError(
        err.message ?? `Flow respondió HTTP ${res.status}`,
        res.status,
        typeof err.code === "number" ? err.code : null,
        json,
      );
    }
    return json;
  }
}

/**
 * El link de pago. Flow devuelve la url y el token por separado y el manual
 * dice literalmente cómo se unen; se hace en un sitio para que nadie lo
 * concatene a mano con un `&` en vez de un `?`.
 */
export function flowPaymentLink(url: string, token: string): string {
  return `${url}?token=${encodeURIComponent(token)}`;
}
