// Cliente mínimo de la API de Zadarma para el agente de voz (MOM §11.8).
//
// Solo lo que se probó que funciona (docs/voz-reproprovincia-plan.md):
//
//   GET /v1/request/callback/?from=1-11&sip=<ext>&to=930555309
//
// - `from` es un ESCENARIO de la centralita («menú-tecla», p. ej. `1-11`: un
//   menú sin números asignados cuyo escenario «sin pulsar» llama a una
//   extensión desviada «siempre» al SIP URI de xAI). Zadarma marca `from`
//   primero y, cuando contesta, marca `to`. Así el tramo del agente queda
//   DENTRO de la centralita (probado el 24-09-2026): la locución «espere a
//   la conexión» la oye el agente, la clienta no oye locución ni tono, y el
//   audio no pasa por la red telefónica.
// - Descartado: el número del agente como `from` o `to` (el tramo sale a la
//   red y vuelve: audio comprimido; y como `to`, la clienta oía locución y
//   tono) y una extensión suelta como `from`/`to` (el callback no aplica su
//   desvío). Un número peruano como `from` sigue aceptado, por compatibilidad.
// - Lo que se paga: el agente conecta antes que la clienta, así que xAI cobra
//   los segundos de timbre y las que no contestan hasta el corte por silencio.
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

import { createHash, createHmac, timingSafeEqual } from "node:crypto";

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

/** Escenario de la centralita en la forma «menú-tecla» (`1-11`), o null. */
export function zadarmaScenario(raw: string | null | undefined): string | null {
  const t = String(raw ?? "").trim();
  return /^\d{1,3}-\d{1,3}$/.test(t) ? t : null;
}

/** Lo que va en `from`: un escenario tal cual, o un número peruano sin 51. */
export function zadarmaAgentEndpoint(raw: string | null | undefined): string | null {
  return zadarmaScenario(raw) ?? zadarmaLocalPeru(raw);
}

export interface ZadarmaCredentials {
  key: string;
  secret: string;
}

export interface CallbackRequest {
  /** Escenario de la centralita («menú-tecla») o número del agente. Se marca PRIMERO. */
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
  const from = zadarmaAgentEndpoint(req.agentNumber);
  if (!from) {
    return {
      ok: false,
      error: "El agente debe ser un escenario de la centralita («menú-tecla», p. ej. 1-11) o un número peruano.",
    };
  }
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

// ── Avisos de la centralita (webhook) ───────────────────────────────────────
//
// Zadarma avisa los pasos de cada llamada por POST (formulario) a la URL de
// «Notificaciones» de la centralita. Firma de su librería oficial
// (zadarma/user-api-v1, lib/Webhook/*.php y Client::encodeSignature):
//
//   Signature = base64( hex( hmac_sha1( cadena, secret ) ) )
//
// con la cadena según el evento:
//   NOTIFY_START, NOTIFY_END          → caller_id + called_did + call_start
//   NOTIFY_OUT_START, NOTIFY_OUT_END  → internal + destination + call_start
//
// Al guardar la URL, Zadarma la verifica con `?zd_echo=<x>` y espera `<x>`.

export const ZADARMA_END_EVENTS = new Set(["NOTIFY_END", "NOTIFY_OUT_END"]);

/** La cadena firmada de un aviso, o null si el evento no se maneja. */
export function zadarmaNotifyString(p: Record<string, string>): string | null {
  switch (p.event) {
    case "NOTIFY_START":
    case "NOTIFY_END":
      return `${p.caller_id ?? ""}${p.called_did ?? ""}${p.call_start ?? ""}`;
    case "NOTIFY_OUT_START":
    case "NOTIFY_OUT_END":
      return `${p.internal ?? ""}${p.destination ?? ""}${p.call_start ?? ""}`;
    default:
      return null;
  }
}

export function zadarmaNotifySignature(str: string, secret: string): string {
  const hex = createHmac("sha1", secret).update(str, "utf8").digest("hex");
  return Buffer.from(hex, "utf8").toString("base64");
}

/** ¿El aviso viene firmado por la cuenta? Un evento que no se maneja, no. */
export function zadarmaNotifyValid(p: Record<string, string>, signature: string | null, secret: string): boolean {
  const str = zadarmaNotifyString(p);
  if (str === null || !signature || !secret) return false;
  const want = Buffer.from(zadarmaNotifySignature(str, secret));
  const got = Buffer.from(signature.trim());
  return want.length === got.length && timingSafeEqual(want, got);
}

/** Los teléfonos de un aviso, en el formato de la cuenta: el de la clienta está entre ellos. */
export function zadarmaNotifyPhones(p: Record<string, string>): string[] {
  return [p.destination, p.caller_id, p.called_did]
    .map((x) => zadarmaLocalPeru(x))
    .filter((x): x is string => Boolean(x));
}

// ── Llamadas terminadas, por consulta (05-10-2026) ──────────────────────────
//
// El aviso de fin de llamada (webhook) no se puede usar: la cuenta comparte la
// única URL de «llamadas a la centralita» con otra operación (KairoAI). En su
// lugar, el barrido le pregunta a Zadarma por las llamadas TERMINADAS
// (`/v1/statistics/` y `/v1/statistics/pbx/`, que solo listan llamadas que ya
// acabaron) y cierra las de Daaph que Kapta sigue viendo abiertas.
//
// Las horas de la estadística (`callstart`) vienen en la zona horaria de la
// cuenta: se lee con `/v1/info/timezone/` (hora local y unixtime) y se corrige.

/** GET firmado a la API de Zadarma; null si falla (quien llama sigue sin cerrar). */
export async function zadarmaGet(
  creds: ZadarmaCredentials,
  method: string,
  params: Record<string, string | number | undefined | null>,
  fetchImpl: typeof fetch = fetch,
): Promise<Record<string, unknown> | null> {
  const query = zadarmaQuery(params);
  const sign = zadarmaSignature(method, query, creds.secret);
  try {
    const res = await fetchImpl(`${ZADARMA_API_BASE}${method}${query ? `?${query}` : ""}`, {
      method: "GET",
      headers: { Authorization: `${creds.key}:${sign}` },
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await res.json()) as Record<string, unknown>;
    return res.ok && body.status === "success" ? body : null;
  } catch {
    return null;
  }
}

/**
 * Cuánto adelanta la hora local de la cuenta a UTC, en ms, a partir de la
 * respuesta de `/v1/info/timezone/` (`unixtime` y `datetime` local). Se
 * redondea a 15 min: la diferencia entre ambos campos es solo la zona.
 */
export function zadarmaOffsetMs(tz: { unixtime?: unknown; datetime?: unknown } | null): number | null {
  const unix = Number(tz?.unixtime);
  const local = Date.parse(`${String(tz?.datetime ?? "").replace(" ", "T")}Z`);
  if (!Number.isFinite(unix) || !Number.isFinite(local)) return null;
  const q = 15 * 60_000;
  return Math.round((local - unix * 1000) / q) * q;
}

/** Fecha en la hora local de la cuenta, como la pide la estadística (`Y-m-d H:i:s`). */
export function zadarmaLocalStamp(at: Date, offsetMs: number): string {
  return new Date(at.getTime() + offsetMs).toISOString().slice(0, 19).replace("T", " ");
}

export interface ZadarmaEndedCall {
  disposition: string;
  seconds: number | null;
  /** Inicio de la llamada en UTC (ISO). */
  startedAt: string;
}

/**
 * ¿Terminó la llamada a este teléfono que Kapta marcó en `dialedAt`? Busca en la
 * estadística (que solo trae llamadas terminadas) una al mismo número que haya
 * empezado desde un minuto antes de marcar. Una llamada anterior al mismo
 * teléfono (otro intento, otro día) no cuenta.
 */
export function zadarmaEndedCallFor(
  stats: readonly Record<string, unknown>[],
  opts: { phone: string; dialedAt: string; offsetMs: number },
): ZadarmaEndedCall | null {
  const phone = zadarmaLocalPeru(opts.phone);
  const since = Date.parse(opts.dialedAt) - 60_000;
  if (!phone || !Number.isFinite(since)) return null;
  for (const s of stats) {
    const to = [s.to, s.destination].map((x) => zadarmaLocalPeru(x == null ? null : String(x)));
    if (!to.includes(phone)) continue;
    const local = Date.parse(`${String(s.callstart ?? "").replace(" ", "T")}Z`);
    if (!Number.isFinite(local)) continue;
    const startedAt = local - opts.offsetMs;
    if (startedAt < since) continue;
    const seconds = Number(s.billseconds ?? s.seconds);
    return {
      disposition: String(s.disposition ?? ""),
      seconds: Number.isFinite(seconds) ? seconds : null,
      startedAt: new Date(startedAt).toISOString(),
    };
  }
  return null;
}

/** Cómo se dice en el historial lo que Zadarma contestó de una llamada que no llegó al agente. */
export function zadarmaNoAnswerResumen(disposition: string | undefined): string {
  switch ((disposition ?? "").toLowerCase()) {
    case "busy":
      return "No contestó: la línea estaba ocupada.";
    case "no answer":
      return "No contestó: timbró sin respuesta.";
    case "cancel":
      return "No contestó: la llamada se canceló antes de que contestara.";
    case "answered":
      return "No contestó: colgó antes de hablar con el agente.";
    case "unallocated number":
      return "No contestó: el número no existe.";
    default:
      return `No contestó: la llamada no se completó (${disposition || "sin causa"}).`;
  }
}
