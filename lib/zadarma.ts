// Cliente mínimo de la API de Zadarma para el agente de voz (MOM §11.8).
//
// Solo lo que la Fase 1 probó que funciona (docs/voz-reproprovincia-plan.md):
//
//   GET /v1/request/callback/?from=17058243&sip=<ext>&to=930555309
//
// - SIN `predicted`. Zadarma reproduce «espere a la conexión» a quien contesta
//   primero y la API no deja apagarlo. Sin `predicted` contesta primero el
//   agente (oye la locución y calla) y la clienta, al descolgar, oye al agente.
// - Los números van SIN 51: la cuenta antepone el código de Perú, y con el 51
//   el historial registraba `5151…` y `failed`.
// - `sip` es obligatorio aquí aunque la API lo tenga opcional: es la extensión
//   cuyo caller ID ve la clienta, y ese número tiene que ser peruano. Sin él
//   Zadarma usa el de la cuenta, que es de EE. UU. y lo comparte otra operación.
//
// La firma es la de su librería oficial (zadarma/user-api-v1, Api.php):
//   base64( hex( hmac_sha1( metodo + query + md5hex(query), secret ) ) )
// con la query ordenada por clave y codificada como `http_build_query` de PHP
// (RFC 1738: espacio → «+»).

import { createHash, createHmac } from "node:crypto";

export const ZADARMA_API_BASE = "https://api.zadarma.com";

/** `urlencode` de PHP: igual que RFC 3986 salvo el espacio (+) y `~` (%7E). */
export function phpUrlencode(value: string): string {
  return encodeURIComponent(value)
    .replace(/[!'()*~]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/%20/g, "+");
}

/** `http_build_query` con las claves ordenadas, como `ksort` antes de firmar. */
export function zadarmaQuery(params: Record<string, string | number | undefined | null>): string {
  return Object.keys(params)
    .filter((k) => params[k] !== undefined && params[k] !== null && params[k] !== "")
    .sort()
    .map((k) => `${phpUrlencode(k)}=${phpUrlencode(String(params[k]))}`)
    .join("&");
}

export function zadarmaSignature(method: string, query: string, secret: string): string {
  const md5 = createHash("md5").update(query, "utf8").digest("hex");
  const hex = createHmac("sha1", secret).update(method + query + md5, "utf8").digest("hex");
  return Buffer.from(hex, "utf8").toString("base64");
}

/**
 * Un teléfono peruano en el formato que marca la cuenta: dígitos, sin `+` ni
 * `51`. Móvil: 9 dígitos que empiezan en 9. Fijo de Lima: 1 + 7 dígitos.
 * Devuelve null si no parece peruano: mejor no llamar que marcar a otro país.
 */
export function zadarmaLocalPeru(raw: string | null | undefined): string | null {
  let digits = String(raw ?? "").replace(/\D/g, "");
  if (digits.startsWith("0051")) digits = digits.slice(4);
  else if (digits.length === 11 && digits.startsWith("51")) digits = digits.slice(2);
  else if (digits.length === 10 && digits.startsWith("511")) digits = digits.slice(2);
  else if (digits.length === 9 && digits.startsWith("01")) digits = digits.slice(1);
  if (/^9\d{8}$/.test(digits)) return digits;
  if (/^1\d{7}$/.test(digits)) return digits;
  return null;
}

export interface ZadarmaCredentials {
  key: string;
  secret: string;
}

export interface CallbackRequest {
  /** Número del agente (sin 51). Zadarma lo marca PRIMERO. */
  agentNumber: string;
  /** Teléfono de la clienta, en cualquier formato peruano. */
  customerPhone: string;
  /** Extensión o SIP cuyo caller ID peruano ve la clienta. Obligatorio. */
  sip: string;
}

export type CallbackResult =
  | { ok: true; response: Record<string, unknown>; from: string; to: string }
  | { ok: false; error: string; response?: Record<string, unknown> };

/** Solo arma y valida; no llama. Separado para poder probarlo sin red. */
export function buildCallbackParams(req: CallbackRequest):
  | { ok: true; params: { from: string; sip: string; to: string } }
  | { ok: false; error: string } {
  const from = zadarmaLocalPeru(req.agentNumber);
  if (!from) return { ok: false, error: "El número del agente no es un número peruano válido." };
  const to = zadarmaLocalPeru(req.customerPhone);
  if (!to) return { ok: false, error: "El teléfono de la clienta no es un número peruano válido." };
  const sip = String(req.sip ?? "").trim();
  if (!sip) {
    return {
      ok: false,
      error: "Falta la extensión de Zadarma con caller ID peruano: sin ella la clienta vería el número de EE. UU. de la cuenta.",
    };
  }
  return { ok: true, params: { from, sip, to } };
}

export async function requestCallback(
  creds: ZadarmaCredentials,
  req: CallbackRequest,
  fetchImpl: typeof fetch = fetch,
): Promise<CallbackResult> {
  const built = buildCallbackParams(req);
  if (!built.ok) return built;
  const method = "/v1/request/callback/";
  const query = zadarmaQuery(built.params);
  const sign = zadarmaSignature(method, query, creds.secret);
  let res: Response;
  try {
    res = await fetchImpl(`${ZADARMA_API_BASE}${method}?${query}`, {
      method: "GET",
      headers: { Authorization: `${creds.key}:${sign}` },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    return { ok: false, error: `Zadarma no respondió: ${(err as Error).message}` };
  }
  let body: Record<string, unknown> = {};
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    return { ok: false, error: `Zadarma respondió ${res.status} sin JSON.` };
  }
  if (!res.ok || body.status !== "success") {
    return {
      ok: false,
      error: `Zadarma rechazó la llamada: ${String(body.message ?? res.status)}`,
      response: body,
    };
  }
  return { ok: true, response: body, from: built.params.from, to: built.params.to };
}
