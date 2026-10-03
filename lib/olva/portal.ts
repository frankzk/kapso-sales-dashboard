// El portal de clientes de Olva (atc.olvaexpress.pe): entrar con la cuenta de
// la empresa y traer la lista de envíos que registró (MOM §12, «Cotejar Olva»).
//
// NO ES UNA API PÚBLICA. Es lo que hace el navegador al usar «Reportes →
// Seguimiento de envíos», leído el 02-10-2026 en las herramientas del
// navegador:
//
//   1. GET  /atc/user/login       → cookie de sesión y un `_csrf_token` en el form.
//   2. POST /user/login_check     → form con `_username`, `_password`, el token y
//      las rutas de éxito/fallo. Redirige a /user/redirect si entró y a
//      /user/failure si no.
//   3. GET  /atc/follow           → la página trae el JWT en un
//      `<input type="hidden" id="jwt" value="…">`. Vale 24 h.
//   4. GET  reports.olvaexpress.pe/atc/auth/getTrackingsClient?… con
//      `Authorization: Bearer <jwt>` → `{ success, msg, data: [envío, …] }`.
//
// CLOUDFLARE está delante del portal. Si decide que quien entra no es una
// persona, contesta con un desafío y aquí no hay forma de resolverlo: se
// devuelve `blocked` y la pantalla ofrece pegar la respuesta a mano, que pasa
// por el mismo cotejo. Por eso el parser vive aparte del transporte.
//
// Lo que se lee de cada envío son SOLO los campos que el cotejo necesita.

import { parseOlvaTracking, type OlvaTrackingId } from "@/lib/olva/tracking";

export const OLVA_PORTAL_BASE = "https://atc.olvaexpress.pe";
export const OLVA_REPORTS_BASE = "https://reports.olvaexpress.pe";

const TIMEOUT_MS = 20_000;
const MAX_REDIRECTS = 6;
/** El portal sirve otra cosa a quien no parece un navegador. */
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

export interface OlvaPortalCredentials {
  username: string;
  password: string;
}

/** Un envío del portal, reducido a lo que el cotejo usa. */
export interface OlvaPortalRow {
  id: OlvaTrackingId;
  /** «02649804/26», como lo escribe el portal. */
  rawTracking: string;
  estado: string | null;
  destinatario: string;
  departamento: string | null;
  provincia: string | null;
  distrito: string | null;
  direccion: string;
  /** YYYY-MM-DD: el día que se registró el envío en Olva. */
  fechaRegistro: string | null;
  /** Lo que la empresa escribió en «Doc. externo» al registrar el envío. */
  docExterno: string | null;
}

export type OlvaPortalFailure =
  | { ok: false; kind: "blocked"; error: string }
  | { ok: false; kind: "auth"; error: string }
  | { ok: false; kind: "error"; error: string };

export type OlvaPortalResult = { ok: true; rows: OlvaPortalRow[]; skipped: number } | OlvaPortalFailure;

// ---------------------------------------------------------------------------
// Lectura del HTML y de la respuesta: puro.
// ---------------------------------------------------------------------------

function attr(tag: string, name: string): string | null {
  const m = tag.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i"));
  return m ? (m[1] ?? m[2] ?? null) : null;
}

/** El valor del `<input>` cuyo `name` o `id` es `key`, sea cual sea el orden. */
function inputValue(html: string, key: string, by: "name" | "id"): string | null {
  for (const m of html.matchAll(/<input\b[^>]*>/gi)) {
    if (attr(m[0], by) === key) {
      const v = attr(m[0], "value");
      if (v) return v;
    }
  }
  return null;
}

export function extractCsrfToken(html: string): string | null {
  return inputValue(html, "_csrf_token", "name");
}

export function extractPortalJwt(html: string): string | null {
  const v = inputValue(html, "jwt", "id");
  return v && v.startsWith("eyJ") ? v : null;
}

/**
 * ¿Es un desafío de Cloudflare y no la página? Cloudflare lo marca con la
 * cabecera `cf-mitigated: challenge`; las versiones viejas, solo con el HTML.
 */
export function isCloudflareChallenge(status: number, headers: Headers, body: string): boolean {
  if ((headers.get("cf-mitigated") ?? "").toLowerCase() === "challenge") return true;
  if (status !== 403 && status !== 503 && status !== 429) return false;
  return /challenge-platform|cf-chl|Just a moment|Attention Required/i.test(body);
}

function str(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t ? t : null;
}

/**
 * Lee la respuesta de `getTrackingsClient`. Acepta el objeto entero o solo su
 * `data`, que es lo que alguien puede terminar copiando del navegador. Un envío
 * sin tracking legible o sin destinatario se cuenta en `skipped` y no se cotea.
 */
export function parsePortalTrackings(
  payload: unknown,
): { ok: true; rows: OlvaPortalRow[]; skipped: number } | { ok: false; error: string } {
  const root = payload as { success?: unknown; msg?: unknown; data?: unknown } | unknown[] | null;
  let list: unknown;
  if (Array.isArray(root)) list = root;
  else if (root && typeof root === "object") {
    if (root.success === false) {
      return { ok: false, error: `Olva respondió sin éxito: ${str(root.msg) ?? "sin mensaje"}` };
    }
    list = root.data;
  }
  if (!Array.isArray(list)) {
    return { ok: false, error: "La respuesta no trae la lista de envíos (`data`)." };
  }

  const rows: OlvaPortalRow[] = [];
  let skipped = 0;
  for (const item of list) {
    const r = (item ?? {}) as Record<string, unknown>;
    const rawTracking = str(r.tracking);
    const parsed = rawTracking ? parseOlvaTracking(rawTracking) : null;
    // «destinario», sin la t: así se llama el campo en el portal.
    const destinatario = str(r.destinario) ?? str(r.destinatario);
    if (!rawTracking || !parsed?.ok || !destinatario) {
      skipped += 1;
      continue;
    }
    const fecha = str(r.fecha_registro);
    rows.push({
      id: parsed.value,
      rawTracking,
      estado: str(r.estado),
      destinatario,
      departamento: str(r.departamento),
      provincia: str(r.provincia),
      distrito: str(r.distrito),
      direccion: str(r.direccion) ?? "",
      fechaRegistro: fecha && /^\d{4}-\d{2}-\d{2}/.test(fecha) ? fecha.slice(0, 10) : null,
      docExterno: str(r.doc_externo),
    });
  }
  return { ok: true, rows, skipped };
}

/** La URL de la consulta, con los mismos parámetros que manda el portal. */
export function portalTrackingsUrl(input: { ruc: string; desde: string; hasta: string; dni?: string | null }): string {
  // El portal filtra también por año de emisión, a dos dígitos. Con un rango
  // que cruza de año habría que hacer dos consultas; el cotejo pide días.
  const emision = input.hasta.slice(2, 4);
  const params = new URLSearchParams({
    desde: `${input.desde} 00:00:00`,
    hasta: `${input.hasta} 23:59:59`,
    documento: input.ruc,
    estado: "",
    centro_costo: "",
    emision_orden: emision,
    orden_servicio: "",
    doc_externo: "",
    motivaciones: "",
    emision_tracking: emision,
    tracking: "",
    ubigeos: "",
    // El filtro del portal por documento del destinatario: la respuesta no
    // trae el DNI, pero sí se puede preguntar por él (ver portal-match.ts).
    dni_consignado: input.dni ?? "",
    nombre_consignado: "",
    tipo_cliente: "CONTADO",
  });
  return `${OLVA_REPORTS_BASE}/atc/auth/getTrackingsClient?${params.toString()}`;
}

// ---------------------------------------------------------------------------
// Transporte.
// ---------------------------------------------------------------------------

type FetchImpl = typeof fetch;

/** Las cookies que el portal va dejando, como las guardaría el navegador. */
class CookieJar {
  private readonly cookies = new Map<string, string>();

  absorb(headers: Headers): void {
    const list =
      typeof (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie === "function"
        ? (headers as Headers & { getSetCookie: () => string[] }).getSetCookie()
        : (headers.get("set-cookie") ?? "").split(/,(?=\s*[^;=\s]+=)/);
    for (const raw of list) {
      const pair = raw.split(";")[0]?.trim();
      if (!pair) continue;
      const eq = pair.indexOf("=");
      if (eq <= 0) continue;
      this.cookies.set(pair.slice(0, eq), pair.slice(eq + 1));
    }
  }

  header(): string {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  }
}

class PortalStop extends Error {
  constructor(readonly failure: OlvaPortalFailure) {
    super(failure.error);
  }
}

const BLOCKED: OlvaPortalFailure = {
  ok: false,
  kind: "blocked",
  error:
    "Cloudflare, delante del portal de Olva, no dejó entrar al acceso automático. Usa «Pegar respuesta» con lo que copies del navegador.",
};

async function request(
  fetchImpl: FetchImpl,
  jar: CookieJar,
  url: string,
  init: { method?: string; body?: string; contentType?: string; referer?: string } = {},
): Promise<{ status: number; headers: Headers; body: string; url: string }> {
  let current = url;
  let method = init.method ?? "GET";
  let body = init.body;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const headers: Record<string, string> = {
      "user-agent": USER_AGENT,
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "accept-language": "es-PE,es;q=0.9",
      origin: OLVA_PORTAL_BASE,
      referer: init.referer ?? `${OLVA_PORTAL_BASE}/`,
    };
    const cookie = jar.header();
    if (cookie) headers.cookie = cookie;
    if (body !== undefined) headers["content-type"] = init.contentType ?? "application/x-www-form-urlencoded";

    const res = await fetchImpl(current, {
      method,
      headers,
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    jar.absorb(res.headers);
    const location = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && location) {
      // El portal redirige a http://; se sigue siempre por https.
      current = new URL(location, current).toString().replace(/^http:\/\//, "https://");
      // 301/302/303 pasan a GET sin cuerpo, como hace el navegador; 307/308 no.
      if (res.status !== 307 && res.status !== 308) {
        method = "GET";
        body = undefined;
      }
      continue;
    }
    const text = await res.text();
    if (isCloudflareChallenge(res.status, res.headers, text)) throw new PortalStop(BLOCKED);
    return { status: res.status, headers: res.headers, body: text, url: current };
  }
  throw new PortalStop({ ok: false, kind: "error", error: "El portal de Olva redirigió demasiadas veces." });
}

/** Entra al portal y devuelve el JWT con el que se consultan los reportes. */
export async function olvaPortalLogin(
  creds: OlvaPortalCredentials,
  fetchImpl: FetchImpl = fetch,
): Promise<{ ok: true; jwt: string } | OlvaPortalFailure> {
  const jar = new CookieJar();
  try {
    const loginUrl = `${OLVA_PORTAL_BASE}/atc/user/login`;
    const page = await request(fetchImpl, jar, loginUrl);
    const csrf = extractCsrfToken(page.body);
    if (!csrf) {
      return { ok: false, kind: "error", error: "La página de ingreso de Olva cambió: no trae el token del formulario." };
    }

    const form = new URLSearchParams({
      _username: creds.username,
      _password: creds.password,
      _target_path: "/user/redirect",
      _failure_path: "/user/failure",
      _csrf_token: csrf,
    });
    const after = await request(fetchImpl, jar, `${OLVA_PORTAL_BASE}/user/login_check`, {
      method: "POST",
      body: form.toString(),
      referer: loginUrl,
    });
    if (/\/user\/(failure|login)\b/.test(new URL(after.url).pathname)) {
      return { ok: false, kind: "auth", error: "Olva rechazó el usuario o la contraseña del portal." };
    }

    const follow = await request(fetchImpl, jar, `${OLVA_PORTAL_BASE}/atc/follow`, { referer: after.url });
    const jwt = extractPortalJwt(follow.body);
    if (!jwt) {
      // Sin JWT y de vuelta en el login es una sesión que no se abrió.
      if (/_csrf_token|_password/.test(follow.body)) {
        return { ok: false, kind: "auth", error: "Olva no abrió la sesión con ese usuario y contraseña." };
      }
      return { ok: false, kind: "error", error: "La página de seguimiento de Olva cambió: no trae el token de acceso." };
    }
    return { ok: true, jwt };
  } catch (e) {
    if (e instanceof PortalStop) return e.failure;
    return { ok: false, kind: "error", error: `No se pudo entrar al portal de Olva: ${describe(e)}` };
  }
}

/** Trae los envíos registrados entre dos días (YYYY-MM-DD, hora de Lima). */
export async function fetchOlvaPortalTrackings(
  input: { jwt: string; ruc: string; desde: string; hasta: string; dni?: string | null },
  fetchImpl: FetchImpl = fetch,
): Promise<OlvaPortalResult> {
  try {
    const res = await fetchImpl(portalTrackingsUrl(input), {
      headers: {
        accept: "*/*",
        authorization: `Bearer ${input.jwt}`,
        origin: OLVA_PORTAL_BASE,
        referer: `${OLVA_PORTAL_BASE}/`,
        "user-agent": USER_AGENT,
      },
      signal: AbortSignal.timeout(TIMEOUT_MS * 3),
    });
    const text = await res.text();
    if (isCloudflareChallenge(res.status, res.headers, text)) return BLOCKED;
    if (res.status === 401 || res.status === 403) {
      return { ok: false, kind: "auth", error: `Olva no aceptó el acceso a los reportes (HTTP ${res.status}).` };
    }
    if (!res.ok) return { ok: false, kind: "error", error: `Los reportes de Olva respondieron HTTP ${res.status}.` };
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return { ok: false, kind: "error", error: "Los reportes de Olva no devolvieron JSON." };
    }
    const parsed = parsePortalTrackings(json);
    return parsed.ok ? parsed : { ok: false, kind: "error", error: parsed.error };
  } catch (e) {
    return { ok: false, kind: "error", error: `No se pudo consultar los reportes de Olva: ${describe(e)}` };
  }
}

function describe(e: unknown): string {
  if (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")) return "Olva tardó demasiado";
  return e instanceof Error ? e.message : String(e);
}
