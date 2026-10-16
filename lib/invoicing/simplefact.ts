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
//     página de error que imprime las cabeceras), tal cual o escapado (JSON,
//     HTML, URL), porque la respuesta se guarda en `order_invoices.response` y
//     el panel la puede mostrar.
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

/**
 * Lo más largo que se acepta, lo mismo que deja guardar Ajustes. El limpiador
 * de abajo es una expresión con un grupo por carácter del token y V8 se queda
 * sin pila al compilarla pasados unos 3.900: un token más largo no se envía.
 */
export const SIMPLEFACT_TOKEN_MAX_CHARS = 2_000;

/** Por debajo de esto no es un token real y limpiarlo destrozaría el texto. */
const SCRUB_MIN_LENGTH = 8;
const REDACTED = "[token]";

// El token no vuelve solo tal cual. Una respuesta que lo repite lo trae como lo
// escribió quien la armó, y en las ramas que no se interpretan (la respuesta
// demasiado grande, la que no es JSON) llega así a `body.raw`:
//
//   - JSON: `"` → `\"` y `\` → `\\` (JSON.stringify); PHP/Laravel además
//     `/` → `\/`; Symfony, Go o un codificador «solo ASCII» escriben cualquier
//     carácter como `\u002F` o `\u002f`.
//   - JSON guardado como texto dentro de otro JSON (un `debug` con las
//     cabeceras ya codificadas): cada nivel duplica las barras invertidas.
//   - HTML (una página de error que imprime las cabeceras): `&amp;`, `&quot;`,
//     `&#039;`, `&#x2F;`…
//   - URL: `%7C`, `%2F`…
//
// Buscar solo el token literal deja pasar todas estas. Por eso se arma una
// expresión que, carácter por carácter, acepta el carácter o cualquiera de sus
// escrituras, y se aplica igual a todo lo que se devuelve: valores y llaves del
// JSON ya leído (un JSON dentro de un texto sigue escapado), el texto crudo y
// los mensajes de error. Siempre ANTES de recortar: recortar primero parte el
// token en el corte y su comienzo ya no se reconoce.

/** Lo que escapa `htmlspecialchars` con ENT_QUOTES (más `&apos;` de HTML5). */
const HTML_NAMED: Readonly<Record<string, string>> = { "&": "amp", "<": "lt", ">": "gt", '"': "quot", "'": "apos" };

/** Hasta cuántos JSON uno dentro de otro se reconoce el token (3 = hasta 8 barras invertidas por una). */
const SCRUB_JSON_DEPTH = 3;

/** `abc` → `[aA][bB][cC]`: `\u002F` y `\u002f`, `&AMP;` y `&amp;` son lo mismo. */
function anyCase(s: string): string {
  return s.replace(/[a-z]/gi, (c) => `[${c.toLowerCase()}${c.toUpperCase()}]`);
}

function hexRe(code: number, width: number): string {
  return anyCase(code.toString(16).padStart(width, "0"));
}

/** Un carácter del token como texto literal dentro de la expresión. */
function literalRe(ch: string): string {
  return ch.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

/**
 * Las escrituras de un carácter (que no es `\`) fuera de JSON. El carácter tal
 * cual va al final: si fuera primero, un token que termina en `&` dejaría el
 * `amp;` de `&amp;` fuera de lo limpiado (y un `%` el `25` de `%25`).
 */
function charFormsRe(ch: string): string {
  const code = ch.charCodeAt(0);
  const forms = [
    `%${hexRe(code, 2)}`, // URL: %2F
    `&#0{0,3}${code};`, // HTML decimal: &#47; &#039;
    `&#[xX]0{0,2}${hexRe(code, 2)};`, // HTML hexadecimal: &#x2F;
  ];
  const named = HTML_NAMED[ch];
  if (named) forms.push(`&${anyCase(named)};`);
  forms.push(literalRe(ch));
  return forms.join("|");
}

/**
 * Un carácter del token escrito en el nivel `depth` de JSON (0 = texto crudo).
 *
 * En el nivel n, una barra invertida del token son exactamente 2^n, y delante
 * de cualquier otro carácter caben de 0 a 2^n − 1 barras de escape (`\/`,
 * `\\\"`). Las cuentas son exactas a propósito: una barra invertida que
 * aceptara «de 1 a 8» dejaría a la expresión probar cada reparto posible de
 * una tira larga de barras entre los caracteres del token, y una respuesta así
 * colgaría la pasada. Con cuentas exactas cada carácter calza de una sola
 * manera.
 *
 * La escritura `\u002F` va primero y con sus propias barras delante: si no, en
 * `\u0075` las barras se llevarían la `\` y una «u» del token calzaría
 * con la `u`, dejando `0075` fuera de lo limpiado.
 */
function unitRe(ch: string, depth: number): string {
  if (ch === "\\") {
    const viaU = Math.max(1, 2 ** (depth - 1)); // \u005c, y en el nivel 2 \\u005c
    return `(?:\\\\{${viaU}}u${hexRe(92, 4)}|\\\\{${2 ** depth}}|%${hexRe(92, 2)}|&#0{0,3}92;|&#[xX]0{0,2}${hexRe(92, 2)};)`;
  }
  const escapes = 2 ** depth - 1;
  const before = escapes > 0 ? `\\\\{0,${escapes}}` : "";
  return `(?:${before}\\\\u${hexRe(ch.charCodeAt(0), 4)}|${before}(?:${charFormsRe(ch)}))`;
}

type Scrub = (value: string) => string;

/**
 * El limpiador de un token: cambia por `[token]` toda escritura suya. Sin
 * barras invertidas en el token, el nivel más hondo acepta también los de
 * arriba (0 barras de escape caben en «de 0 a 7»); con ellas, cada nivel va
 * aparte porque una barra del token cuenta distinto en cada uno.
 */
function tokenScrubber(token: string): Scrub {
  if (token.length < SCRUB_MIN_LENGTH) return (value) => value;
  const depths = token.includes("\\")
    ? Array.from({ length: SCRUB_JSON_DEPTH + 1 }, (_, i) => SCRUB_JSON_DEPTH - i)
    : [SCRUB_JSON_DEPTH];
  const re = new RegExp(depths.map((d) => Array.from(token, (ch) => unitRe(ch, d)).join("")).join("|"), "g");
  return (value) => {
    try {
      return value.replace(re, REDACTED);
    } catch {
      // El motor no pudo correr la expresión (V8 la compila al usarla y una muy
      // larga se queda sin pila). Sin poder buscar el token no se devuelve nada
      // del texto: el código HTTP sigue mandando y el texto queda en blanco.
      return REDACTED;
    }
  };
}

/** Quita el token de todo texto de la respuesta, valores y llaves. */
function scrubDeep(value: unknown, scrub: Scrub): unknown {
  if (typeof value === "string") return scrub(value);
  if (Array.isArray(value)) return value.map((v) => scrubDeep(v, scrub));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      // Como propiedad propia: una llave «__proto__» del JSON asignada con `=`
      // cambiaría el prototipo, y lo que trae se leería como si fuera de la
      // respuesta (un `success` heredado) sin aparecer en lo que se guarda.
      Object.defineProperty(out, scrub(k), { value: scrubDeep(v, scrub), enumerable: true, writable: true, configurable: true });
    }
    return out;
  }
  return value;
}

/** Un motivo corto de un fallo de red: el código (ECONNRESET), nunca el objeto entero. */
function networkReason(err: unknown, scrub: Scrub): string {
  const e = err as { name?: unknown; code?: unknown; message?: unknown; cause?: { code?: unknown; message?: unknown } };
  const raw = [e?.cause?.code, e?.code, e?.cause?.message, e?.message, e?.name].find(
    (v): v is string => typeof v === "string" && v.trim() !== "",
  );
  return scrub((raw ?? "error de red").trim()).slice(0, 200);
}

// ── Transporte ───────────────────────────────────────────────────────────────

type Prepared = { ok: true; base: string; token: string; scrub: Scrub } | { ok: false; error: string };

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
  if (!TOKEN_RE.test(token) || token.length > SIMPLEFACT_TOKEN_MAX_CHARS) {
    return { ok: false, error: "El token de SimpleFact no es válido" };
  }
  // El limpiador se arma y se prueba antes de salir: si no reconoce el token tal
  // cual y como lo escribe PHP, lo que vuelva no se podría limpiar, y no se
  // envía nada. La prueba lleva texto alrededor porque un limpiador que no pudo
  // correr devuelve todo en blanco, y eso no es reconocer el token. Un token de
  // menos de 8 no se limpia (ver SCRUB_MIN_LENGTH) y tampoco se prueba.
  let scrub: Scrub;
  try {
    scrub = tokenScrubber(token);
    const php = JSON.stringify(token).slice(1, -1).replace(/\//g, "\\/");
    for (const probe of token.length >= SCRUB_MIN_LENGTH ? [token, php] : []) {
      if (scrub(`< ${probe} >`) !== `< ${REDACTED} >`) throw new Error("el limpiador no reconoce el token");
    }
  } catch {
    return { ok: false, error: "El token de SimpleFact no es válido" };
  }
  return { ok: true, base, token, scrub };
}

/** Lee el cuerpo: JSON si lo es; si no, el texto recortado. Sin el token. */
function parseBody(text: string, scrub: Scrub): { body: unknown; error?: string } {
  if (text.length > SIMPLEFACT_BODY_MAX_CHARS) {
    // Primero se limpia y después se recorta, como abajo: recortar antes parte
    // un token que cruza el carácter 2000 y su comienzo ya no se reconoce. Un
    // recorte previo con margen tampoco sirve: cada token limpiado acorta el
    // texto y arrastra hacia el corte un pedazo del siguiente. El cuerpo ya está
    // entero en memoria; limpiarlo es una pasada más.
    return {
      body: { raw: scrub(text).slice(0, SIMPLEFACT_RAW_MAX_CHARS) },
      error: "La respuesta de SimpleFact es demasiado grande",
    };
  }
  try {
    return { body: scrubDeep(JSON.parse(text), scrub) };
  } catch {
    // Una página de error, un proxy o un portal cautivo: se guarda el comienzo.
    // Se limpia el texto entero antes de recortar, para no partir el token.
    return { body: { raw: scrub(text).slice(0, SIMPLEFACT_RAW_MAX_CHARS) } };
  }
}

async function send(
  conn: SimplefactConn,
  prepared: Extract<Prepared, { ok: true }>,
  method: "GET" | "POST",
  path: string,
  payload?: SimplefactSalePayload,
): Promise<SimplefactHttp> {
  const { base, token, scrub } = prepared;
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
          : `No hubo respuesta de SimpleFact (${networkReason(err, scrub)})`,
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
          : `SimpleFact cortó la respuesta (${networkReason(err, scrub)})`,
      };
    }

    const parsed = parseBody(text, scrub);
    return parsed.error ? { http: status, body: parsed.body, error: parsed.error } : { http: status, body: parsed.body };
  } catch (err) {
    // Nada de lo de arriba debería lanzar; si algo lo hace, es un no-respondió.
    return { http: null, body: null, error: `Fallo al llamar a SimpleFact (${networkReason(err, scrub)})` };
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
