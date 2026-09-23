// La llamada de rastreo que hace la página pública de Olva, hecha desde aquí.
//
//   GET {base}/webservice/rest/getTrackingInformation
//       ?tracking=2552504&emision=26&apikey=…&details=1
//
// OLVA NO TIENE API PARA CLIENTES. Lo que tiene es una página de seguimiento
// (tracking.olvaexpress.pe) cuyo JavaScript llama a este servicio con una
// apikey fija que viaja a cada visitante. Se usa exactamente igual que la
// página: el mismo GET, los mismos parámetros, con `Origin` y `Referer` de la
// página porque el navegador los manda y no se sabe si el servidor los mira.
//
// LO QUE ESO IMPLICA. La apikey es de Olva, no nuestra, y la pueden rotar sin
// avisar. Por eso vive en el entorno (OLVA_TRACKING_APIKEY) y no en el código,
// y por eso el cron trata un 401/403 o un cuerpo sin la forma esperada como
// «Olva cambió algo», reporta y NO toca estados: el marcado a mano del drawer
// sigue siendo el camino de respaldo (§12).
//
// UNA GUÍA POR LLAMADA: el servicio no tiene lote. Con las salidas vivas de
// Olva que hay hoy (decenas, no miles) alcanza de sobra en una pasada.
//
// SERVER-ONLY.

import type { OlvaTrackingId, OlvaTrackingPayload } from "./tracking";

export const OLVA_TRACKING_API_BASE = "https://reports.olvaexpress.pe";
const PAGE_ORIGIN = "https://tracking.olvaexpress.pe";
const DEFAULT_TIMEOUT_MS = 20_000;

export class OlvaApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = "OlvaApiError";
  }
}

export class OlvaTimeoutError extends Error {
  constructor(ms: number) {
    super(`Olva no respondió en ${Math.round(ms / 1000)} s.`);
    this.name = "OlvaTimeoutError";
  }
}

export interface OlvaClientOpts {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export type OlvaTrackResult =
  | { ok: true; payload: OlvaTrackingPayload }
  /** Olva contestó bien pero no reconoce la guía (`success:false`). */
  | { ok: false; reason: string };

/** ¿La respuesta tiene la forma que la página de Olva pinta? */
export function isOlvaTrackingPayload(body: unknown): body is OlvaTrackingPayload {
  if (!body || typeof body !== "object") return false;
  const obj = body as Record<string, unknown>;
  if (typeof obj.success !== "boolean") return false;
  if (obj.success === false) return true;
  const data = obj.data as Record<string, unknown> | null | undefined;
  return Boolean(data && typeof data === "object" && data.general && typeof data.general === "object");
}

export function trackingUrl(base: string, id: OlvaTrackingId, apiKey: string): string {
  const u = new URL("/webservice/rest/getTrackingInformation", base.replace(/\/$/, "") + "/");
  u.searchParams.set("tracking", id.tracking);
  u.searchParams.set("emision", id.emision);
  u.searchParams.set("apikey", apiKey);
  u.searchParams.set("details", "1");
  return u.toString();
}

export async function fetchOlvaTracking(id: OlvaTrackingId, opts: OlvaClientOpts): Promise<OlvaTrackResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const url = trackingUrl(opts.baseUrl ?? OLVA_TRACKING_API_BASE, id, opts.apiKey);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: "GET",
      headers: {
        accept: "*/*",
        origin: PAGE_ORIGIN,
        referer: `${PAGE_ORIGIN}/`,
      },
      signal: controller.signal,
      cache: "no-store",
    });
  } catch (err) {
    if ((err as Error)?.name === "AbortError") throw new OlvaTimeoutError(timeoutMs);
    throw err;
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // Se deja el texto: un HTML de error o de Cloudflare se lee mejor así.
  }

  if (!res.ok) {
    // Sin la apikey en el mensaje: va en la URL y un log no tiene por qué
    // repetirla.
    const snippet = typeof body === "string" ? body.slice(0, 200) : JSON.stringify(body).slice(0, 200);
    throw new OlvaApiError(`Olva respondió ${res.status}: ${snippet}`, res.status, body);
  }
  if (!isOlvaTrackingPayload(body)) {
    throw new OlvaApiError("Olva respondió con un formato que Kapta no reconoce.", res.status, body);
  }
  if (body.success === false) {
    return { ok: false, reason: (body.msg ?? "Olva no reconoce esa guía.").slice(0, 200) };
  }
  return { ok: true, payload: body };
}

export function describeOlvaError(err: unknown): string {
  if (err instanceof OlvaTimeoutError) return err.message;
  if (err instanceof OlvaApiError) {
    if (err.status === 401 || err.status === 403) {
      return `${err.message} Olva pudo rotar la apikey de su página de seguimiento: captura la nueva desde tracking.olvaexpress.pe y cámbiala en OLVA_TRACKING_APIKEY.`;
    }
    return err.message;
  }
  return err instanceof Error ? err.message : "Error desconocido de Olva.";
}
