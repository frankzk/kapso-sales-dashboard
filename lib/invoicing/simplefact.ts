// El cliente de SimpleFact (MOM §35.4): crear la venta con su boleta y leer las
// ventas de una cuenta.
//
//   POST {base}/sales/orders                                → crea la venta
//   GET  {base}/sales/orders?shortdate=&pageSize=&page=     → ventas de la cuenta
//
// `base` es https://<subdominio>.simplefact.pe/api/v1 y sale SIEMPRE de
// `simplefactBaseUrl` (lib/invoicing/rules.ts): el token solo viaja a un
// subdominio de simplefact.pe, por https (§35.2).
//
// Tres cosas mandan sobre este cliente:
//
//  1. CREAR NO ES IDEMPOTENTE. SimpleFact no tiene llave de idempotencia: la
//     misma venta mandada dos veces son dos boletas, y una boleta enviada a SUNAT
//     no se borra. Aquí no hay reintento de ningún tipo. Sin respuesta (red
//     caída, tiempo agotado) devuelve `http: null`, y `classifySaleResponse` lo
//     deja `en_duda`: se concilia con la nota «Kapta ‹ref›», nunca se repite.
//
//  2. EL TOKEN NO SALE. Va solo en `Authorization`, nunca en la URL. Las
//     redirecciones no se siguen (`redirect: "manual"`): un 3xx vuelve tal cual
//     y, al crear, queda `en_duda` —la venta pudo crearse antes de redirigir—.
//     Ningún texto que devuelve este módulo lleva el token: los errores se
//     arman aquí, y lo que contestó SimpleFact se limpia por si lo repite (una
//     página de error que imprime las cabeceras), porque la respuesta se guarda
//     en `order_invoices.response` y el panel la puede mostrar.
//
//  3. NO LANZA. Todo termina en `{ http, body, error? }`. Quien decide qué
//     quiere decir es `classifySaleResponse` (crear) o `testSimplefactConnection`
//     (probar la conexión), no el transporte.
//
// SERVER-ONLY: recibe el token en claro. No importa `node:crypto` ni la base:
// el token lo descifra quien llama.

import {
  rucFromSalesList,
  simplefactBaseUrl,
  type SimplefactSalePayload,
} from "@/lib/invoicing/rules";

/**
 * Crear espera más que leer: SimpleFact arma la boleta y puede hablar con SUNAT
 * antes de contestar, y un corte al crear deja el comprobante en duda (alguien
 * lo concilia). Leer se puede repetir en la próxima pasada.
 */
export const SIMPLEFACT_POST_TIMEOUT_MS = 25_000;
export const SIMPLEFACT_GET_TIMEOUT_MS = 15_000;

/** Lo que se guarda de una respuesta que no es JSON: una página de error, un proxy. */
export const SIMPLEFACT_RAW_MAX_CHARS = 2_000;

/**
 * Una respuesta más grande no se interpreta. La lista de ventas con 100 por
 * página pesa unos cientos de KB; más que esto no es SimpleFact contestando.
 */
export const SIMPLEFACT_BODY_MAX_CHARS = 2_000_000;

/** Las ventas que lee «Probar conexión» para sacar el RUC de sus archivos. */
export const SIMPLEFACT_TEST_PAGE_SIZE = 20;

export interface SimplefactConn {
  subdomain: string;
  /** En claro. Solo viaja en la cabecera `Authorization`. */
  token: string;
  fetchImpl?: typeof fetch;
  /** Por omisión 25 s al crear y 15 s al leer. */
  timeoutMs?: number;
}

/** `http` null = no hubo respuesta (red, tiempo agotado) o no se llegó a enviar. */
export interface SimplefactHttp {
  http: number | null;
  body: unknown;
  error?: string;
}

export interface SimplefactListQuery {
  shortdate?: "today" | "yesterday";
  pageSize?: number;
  page?: number;
}

// ── El token no sale ─────────────────────────────────────────────────────────

/**
 * Un token de SimpleFact es una sola palabra de ASCII visible (hex, o
 * «id|secreto» de Laravel). Uno con espacios o saltos de línea es un pegado
 * roto, y `fetch` lo rechazaría con un mensaje que cita la cabecera entera.
 */
const TOKEN_RE = /^[\x21-\x7e]+$/;

/** Por debajo de esto no es un token real y limpiarlo destrozaría el texto. */
const SCRUB_MIN_LENGTH = 8;
const REDACTED = "[token]";

function scrubText(value: string, token: string): string {
  return token.length >= SCRUB_MIN_LENGTH && value.includes(token) ? value.split(token).join(REDACTED) : value;
}

/** Quita el token de todo texto de la respuesta, valores y llaves. */
function scrubDeep(value: unknown, token: string): unknown {
  if (typeof value === "string") return scrubText(value, token);
  if (Array.isArray(value)) return value.map((v) => scrubDeep(v, token));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[scrubText(k, token)] = scrubDeep(v, token);
    }
    return out;
  }
  return value;
}

/** Un motivo corto de un fallo de red: el código (ECONNRESET), nunca el objeto entero. */
function networkReason(err: unknown, token: string): string {
  const e = err as { name?: unknown; code?: unknown; message?: unknown; cause?: { code?: unknown; message?: unknown } };
  const raw = [e?.cause?.code, e?.code, e?.cause?.message, e?.message, e?.name].find(
    (v): v is string => typeof v === "string" && v.trim() !== "",
  );
  return scrubText((raw ?? "error de red").trim(), token).slice(0, 200);
}

// ── Transporte ───────────────────────────────────────────────────────────────

type Prepared = { ok: true; base: string; token: string } | { ok: false; error: string };

/** Lo que se revisa antes de salir a la red: nada se envía si no sirve. */
function prepare(conn: SimplefactConn): Prepared {
  let base: string;
  try {
    base = simplefactBaseUrl(conn.subdomain);
  } catch {
    return { ok: false, error: "Subdominio de SimpleFact inválido" };
  }
  const token = (conn.token ?? "").trim();
  if (!token) return { ok: false, error: "Falta el token de SimpleFact" };
  if (!TOKEN_RE.test(token)) return { ok: false, error: "El token de SimpleFact no es válido" };
  return { ok: true, base, token };
}

/** Lee el cuerpo: JSON si lo es; si no, el texto recortado. Sin el token. */
function parseBody(text: string, token: string): { body: unknown; error?: string } {
  if (text.length > SIMPLEFACT_BODY_MAX_CHARS) {
    return {
      body: { raw: scrubText(text.slice(0, SIMPLEFACT_RAW_MAX_CHARS), token) },
      error: "La respuesta de SimpleFact es demasiado grande",
    };
  }
  try {
    return { body: scrubDeep(JSON.parse(text), token) };
  } catch {
    // Una página de error, un proxy o un portal cautivo: se guarda el comienzo.
    // Se limpia el texto entero antes de recortar, para no partir el token.
    return { body: { raw: scrubText(text, token).slice(0, SIMPLEFACT_RAW_MAX_CHARS) } };
  }
}

async function send(
  conn: SimplefactConn,
  prepared: Extract<Prepared, { ok: true }>,
  method: "GET" | "POST",
  path: string,
  payload?: SimplefactSalePayload,
): Promise<SimplefactHttp> {
  const { base, token } = prepared;
  const fetchImpl = conn.fetchImpl ?? fetch;
  const timeoutMs =
    conn.timeoutMs !== undefined && Number.isFinite(conn.timeoutMs) && conn.timeoutMs > 0
      ? conn.timeoutMs
      : method === "POST"
        ? SIMPLEFACT_POST_TIMEOUT_MS
        : SIMPLEFACT_GET_TIMEOUT_MS;

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
  };
  if (method === "POST") headers["Content-Type"] = "application/json";

  // El reloj corre hasta leer el cuerpo entero, y se compite contra él: un
  // `fetchImpl` que no escucha la señal tampoco deja colgada la pasada.
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error("timeout"));
    }, timeoutMs);
  });
  // Si nadie la espera (fetch respondió antes), no se queja como rechazo suelto.
  expired.catch(() => undefined);

  try {
    let res: Response;
    try {
      res = await Promise.race([
        fetchImpl(`${base}${path}`, {
          method,
          headers,
          ...(payload ? { body: JSON.stringify(payload) } : {}),
          // Un 3xx no se sigue: el token no viaja a otra dirección, y al crear
          // la venta pudo quedar hecha antes de la redirección (`en_duda`).
          redirect: "manual",
          cache: "no-store",
          signal: controller.signal,
        }),
        expired,
      ]);
    } catch (err) {
      return {
        http: null,
        body: null,
        error: controller.signal.aborted
          ? `SimpleFact no respondió en ${timeoutMs} ms`
          : `No hubo respuesta de SimpleFact (${networkReason(err, token)})`,
      };
    }

    // Algo que no trae un código HTTP no es una respuesta.
    const status = typeof res?.status === "number" && Number.isInteger(res.status) ? res.status : null;
    if (status === null) return { http: null, body: null, error: "SimpleFact no devolvió una respuesta HTTP" };

    let text: string;
    try {
      text = await Promise.race([res.text(), expired]);
    } catch (err) {
      // Contestó con un código pero el cuerpo no llegó entero. El código manda:
      // un 2xx sin la venta queda en duda, un 4xx sigue siendo un no.
      return {
        http: status,
        body: null,
        error: controller.signal.aborted
          ? `SimpleFact no terminó de responder en ${timeoutMs} ms`
          : `SimpleFact cortó la respuesta (${networkReason(err, token)})`,
      };
    }

    const parsed = parseBody(text, token);
    return parsed.error ? { http: status, body: parsed.body, error: parsed.error } : { http: status, body: parsed.body };
  } catch (err) {
    // Nada de lo de arriba debería lanzar; si algo lo hace, es un no-respondió.
    return { http: null, body: null, error: `Fallo al llamar a SimpleFact (${networkReason(err, token)})` };
  } finally {
    clearTimeout(timer);
  }
}

// ── La API ───────────────────────────────────────────────────────────────────

/**
 * Crea la venta con su boleta. UNA SOLA LLAMADA: no reintenta, ni ante un corte
 * ni ante un 5xx. Lo que devuelve se interpreta con `classifySaleResponse`.
 */
export async function simplefactCreateSale(
  conn: SimplefactConn,
  payload: SimplefactSalePayload,
): Promise<SimplefactHttp> {
  const prepared = prepare(conn);
  if (!prepared.ok) return { http: null, body: null, error: prepared.error };
  return send(conn, prepared, "POST", "/sales/orders", payload);
}

/**
 * Las ventas de la cuenta, con solo los filtros que se pasan. Sirve para
 * conciliar un `en_duda` (las de hoy y ayer, `findSaleByNote`) y para «Probar
 * conexión». Un número que no es entero positivo no se manda.
 */
export async function simplefactListSales(
  conn: SimplefactConn,
  query: SimplefactListQuery,
): Promise<SimplefactHttp> {
  const prepared = prepare(conn);
  if (!prepared.ok) return { http: null, body: null, error: prepared.error };
  const params = new URLSearchParams();
  if (typeof query.shortdate === "string" && query.shortdate) params.set("shortdate", query.shortdate);
  for (const key of ["pageSize", "page"] as const) {
    const value = query[key];
    if (typeof value === "number" && Number.isInteger(value) && value > 0) params.set(key, String(value));
  }
  const qs = params.toString();
  return send(conn, prepared, "GET", `/sales/orders${qs ? `?${qs}` : ""}`);
}

function hasSalesList(body: unknown): boolean {
  return (
    !!body &&
    typeof body === "object" &&
    !Array.isArray(body) &&
    Array.isArray((body as Record<string, unknown>).data)
  );
}

/**
 * «Probar conexión» (MOM §35.4): el token tiene que ser del RUC declarado. Lee
 * las ventas de la cuenta y saca el RUC del nombre de sus archivos
 * (`20556792829-03-B001-…`). Sin una venta con archivos no se puede confirmar, y
 * sin confirmar el RUC la base no deja pasar a real.
 */
export async function testSimplefactConnection(
  conn: SimplefactConn,
  expectedRuc: string,
): Promise<{ ok: true; ruc: string; sales: number } | { ok: false; error: string; ruc: string | null }> {
  const prepared = prepare(conn);
  if (!prepared.ok) return { ok: false, error: prepared.error, ruc: null };

  const res = await simplefactListSales(conn, { pageSize: SIMPLEFACT_TEST_PAGE_SIZE });
  if (res.http === null) return { ok: false, error: "SimpleFact no respondió", ruc: null };
  if (res.http === 401 || res.http === 403) return { ok: false, error: "Token rechazado", ruc: null };
  if (res.http < 200 || res.http >= 300) return { ok: false, error: `SimpleFact contestó ${res.http}`, ruc: null };
  // Un 200 que no es la lista (un proxy, un portal cautivo) no es «la cuenta no
  // tiene ventas»: es que no contestó SimpleFact.
  if (!hasSalesList(res.body)) return { ok: false, error: "SimpleFact no devolvió la lista de ventas", ruc: null };

  const read = rucFromSalesList(res.body);
  if (read.ambiguous) return { ok: false, error: "La cuenta tiene ventas de más de un RUC", ruc: null };
  if (!read.ruc) {
    return { ok: false, error: "La cuenta no tiene ventas con archivos: no se pudo confirmar el RUC", ruc: null };
  }
  const expected = (expectedRuc ?? "").trim();
  if (read.ruc !== expected) {
    return { ok: false, error: `El token es del RUC ${read.ruc}, no del ${expected}`, ruc: read.ruc };
  }
  return { ok: true, ruc: read.ruc, sales: read.sales };
}
