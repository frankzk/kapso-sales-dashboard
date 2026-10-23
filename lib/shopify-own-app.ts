/**
 * «App propia» de Shopify (owner, 23-10-2026; MOM §36).
 *
 * QUÉ ES. Desde el 01-01-2026 Shopify ya no deja crear apps personalizadas en
 * el admin de una tienda, y la app pública «Kapta» (la de clientes, §29.15.9)
 * no está revisada. Una tienda cuya ORGANIZACIÓN de Shopify crea su propia app
 * en el Dev Dashboard y la instala en la tienda obtiene el token de la Admin API
 * con el «client credentials grant»:
 *
 *   POST https://{tienda}.myshopify.com/admin/oauth/access_token
 *   grant_type=client_credentials&client_id=…&client_secret=…
 *   → 200 { access_token, scope, expires_in: 86399 }
 *
 * El token dura ~24 h. Cada pedido acuña uno nuevo y los anteriores siguen
 * valiendo hasta que vencen. Kapta guarda el Client ID y el Client secret
 * (cifrado) de la tienda y renueva el token: el cron cada hora, 12 h antes de
 * que venza, y al usarlo si le quedan menos de 15 minutos.
 *
 * A QUIÉN NO TOCA. Solo a tiendas con `shopify_app = 'propia'`. Kenku y Aurela
 * ('interna') y las de la app de clientes ('clientes') siguen exactamente como
 * antes: nada de aquí lee, renueva ni escribe una tienda que no sea 'propia';
 * cada escritura lleva además `shopify_app = 'propia'` en el filtro.
 *
 * Nunca se escribe el Client secret ni el token en un mensaje, un log o un
 * error: los mensajes son plantillas fijas.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { decrypt, encrypt } from "@/lib/crypto";
import { isValidShopDomain, SHOPIFY_CLIENT_APP_SCOPES } from "@/lib/shopify";

/** Lo que vale `stores.shopify_app` para las tiendas de este camino (0271). */
export const OWN_APP = "propia";

/**
 * Los permisos que la app propia tiene que tener: los mismos que la app de
 * clientes (`SHOPIFY_CLIENT_APP_SCOPES`), que es la que Kapta sabe usar entera.
 */
export const OWN_APP_REQUIRED_SCOPES: readonly string[] = SHOPIFY_CLIENT_APP_SCOPES.split(",")
  .map((s) => s.trim())
  .filter(Boolean);

/** El cron renueva lo que vence en las próximas 12 horas (corre cada hora). */
export const OWN_APP_RENEW_BEFORE_MS = 12 * 60 * 60 * 1000;
/** Al usar el token se renueva si le quedan menos de 15 minutos. */
export const OWN_APP_RENEW_ON_USE_MS = 15 * 60 * 1000;
/** Si Shopify no dice cuánto dura el token (o dice algo raro), 24 horas. */
export const OWN_APP_TOKEN_TTL_FALLBACK_SECONDS = 24 * 60 * 60;
/** Tope de la llamada a Shopify: una tienda colgada no se come el cron. */
export const OWN_APP_TOKEN_TIMEOUT_MS = 15_000;
/**
 * Freno de la renovación AL USAR el token: tras un intento no se vuelve a pedir
 * otro a Shopify en 5 minutos, y si Shopify no respondió bien (red, 429, 5xx),
 * en 15. Sin él, con el secreto revocado o Shopify caído, cada webhook, cada
 * sincronización y cada boleta mandaban el Client secret a Shopify otra vez.
 * El cron (una vez por hora) y «Renovar ahora» no lo miran.
 */
export const OWN_APP_ON_USE_RETRY_MS = 5 * 60 * 1000;
export const OWN_APP_ON_USE_RETRY_AFTER_RED_MS = 15 * 60 * 1000;
/**
 * Cuánto se aceptan los webhooks firmados con el Client secret ANTERIOR tras
 * rotarlo en Ajustes. Shopify firma con el secreto más viejo que no se revocó:
 * hasta que se revoca el anterior, firma con él (y unos minutos después
 * también). Pasado este plazo, o cuando alguien confirma que lo revocó, el
 * anterior ya no vale.
 */
export const OWN_APP_PREV_WEBHOOK_SECRET_GRACE_MS = 48 * 60 * 60 * 1000;
/**
 * Los estados en que una tienda propia renueva su token. «Pausada» renueva:
 * pausar solo detiene los barridos, y los webhooks, «Sincronizar ahora» y las
 * demás acciones siguen usando Shopify. Solo una deshabilitada (por ejemplo,
 * desinstalada) no se renueva ni se resucita.
 */
export const OWN_APP_RENEWABLE_STATUSES: readonly string[] = ["active", "paused"];

/** Lo que se le dice a quien conecta si la base no tiene la 0271. */
export const OWN_APP_MIGRATION_MISSING_MESSAGE =
  "Falta aplicar la migración 0271 (app propia de Shopify) en la base. No se cambió nada.";

export type OwnAppTokenFailure = "credenciales" | "no_instalada" | "otra_organizacion" | "red" | "respuesta_invalida";

/** ¿La tienda propia en este estado renueva su token? Solo 'active' y 'paused'. */
export function isOwnAppRenewableStatus(status: unknown): boolean {
  return typeof status === "string" && OWN_APP_RENEWABLE_STATUSES.includes(status);
}

export type OwnAppTokenResult =
  | { ok: true; token: string; scopes: string[]; expiresAt: Date }
  | { ok: false; reason: OwnAppTokenFailure; message: string };

// ── Puras ────────────────────────────────────────────────────────────────────

/** Los permisos que Shopify devuelve en `scope` («read_orders,write_orders»). */
export function parseScopes(scope: unknown): string[] {
  const parts = Array.isArray(scope) ? scope.map(String) : typeof scope === "string" ? scope.split(/[\s,]+/) : [];
  return [...new Set(parts.map((s) => s.trim().toLowerCase()).filter(Boolean))];
}

/**
 * Los permisos que faltan, en el orden de `required`. `write_X` implica
 * `read_X`: Shopify a veces devuelve solo el de escritura.
 */
export function missingScopes(
  granted: readonly string[],
  required: readonly string[] = OWN_APP_REQUIRED_SCOPES,
): string[] {
  const have = new Set(granted.map((s) => s.trim().toLowerCase()));
  return required.filter((scope) => {
    if (have.has(scope)) return false;
    if (scope.startsWith("read_") && have.has(`write_${scope.slice("read_".length)}`)) return false;
    return true;
  });
}

function toDate(value: Date | string | null | undefined): Date | null {
  if (value == null || value === "") return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isFinite(d.getTime()) ? d : null;
}

/**
 * ¿Hay que renovar? Sí si no se sabe cuándo vence (o la fecha no se entiende),
 * o si vence dentro de `thresholdMs` (o ya venció).
 */
export function shouldRenew(expiresAt: Date | string | null | undefined, now: Date, thresholdMs: number): boolean {
  const d = toDate(expiresAt);
  if (!d) return true;
  return d.getTime() - now.getTime() <= thresholdMs;
}

/** Cuándo vence un token, a partir de `expires_in`. Sin dato válido: 24 h. */
export function tokenExpiresAt(expiresIn: unknown, now: Date): Date {
  const n = typeof expiresIn === "string" && expiresIn.trim() !== "" ? Number(expiresIn) : expiresIn;
  const seconds =
    typeof n === "number" && Number.isFinite(n) && n > 0
      ? // Nunca más de 24 h: renovar antes de tiempo no cuesta nada; tarde, sí.
        Math.min(n, OWN_APP_TOKEN_TTL_FALLBACK_SECONDS)
      : OWN_APP_TOKEN_TTL_FALLBACK_SECONDS;
  return new Date(now.getTime() + seconds * 1000);
}

/**
 * El dominio canónico de la tienda a partir de lo que pegó quien conecta:
 * «https://Tienda.myshopify.com/admin» → «tienda.myshopify.com», y la URL del
 * admin nuevo «admin.shopify.com/store/tienda» → «tienda.myshopify.com».
 * null si no queda un *.myshopify.com válido (la guarda contra SSRF de siempre).
 */
export function normalizeShopDomain(raw: string): string | null {
  const text = (raw ?? "").trim().toLowerCase();
  if (!text) return null;
  const noProto = text.replace(/^https?:\/\//, "");
  const admin = /^admin\.shopify\.com\/store\/([a-z0-9][a-z0-9-]*)(?:[/?#]|$)/.exec(noProto);
  const host = admin ? `${admin[1]}.myshopify.com` : noProto.replace(/[/?#].*$/, "");
  return isValidShopDomain(host) ? host : null;
}

const SAFE_CODE = /^[a-z][a-z0-9_]{1,39}$/;

/** Clasifica un rechazo de Shopify. Solo usa el estado y el código de error. */
function classifyRejection(status: number, code: string, text: string): { reason: OwnAppTokenFailure; message: string } {
  const tag = SAFE_CODE.test(code) ? `HTTP ${status} · ${code}` : `HTTP ${status}`;
  if (status === 429 || status >= 500) {
    return {
      reason: "red",
      message: `Shopify no está respondiendo bien (${tag}). Intenta de nuevo en unos minutos.`,
    };
  }
  if (status === 403 || /shop_not_permitted|not_permitted|not permitted|organi[sz]ation/.test(text)) {
    return {
      reason: "otra_organizacion",
      // Este rechazo puede venir también de una app que no está instalada en
      // la tienda: el mensaje nombra las dos causas.
      message: `La tienda no es de la organización de Shopify que creó la app, o la app no está instalada en ella (${tag}). La app propia solo sirve en tiendas de su misma organización donde esté instalada.`,
    };
  }
  if (status === 404 || (status >= 300 && status < 400) || /not[_ ]installed|uninstalled|app_not_found|shop_not_found/.test(text)) {
    return {
      reason: "no_instalada",
      message: `La app no está instalada en esa tienda, o la tienda no existe (${tag}). Instálala en la tienda desde el Dev Dashboard y vuelve a intentar.`,
    };
  }
  return {
    reason: "credenciales",
    message: `Shopify rechazó el Client ID o el Client secret (${tag}). Cópialos de nuevo desde el Dev Dashboard; si están bien, revisa que la app esté instalada en la tienda y que la tienda sea de la organización que creó la app.`,
  };
}

/** Quita de un texto cualquier aparición de los secretos. Defensa extra. */
function redact(text: string, secrets: Array<string | null | undefined>): string {
  let out = text;
  for (const s of secrets) if (s && s.length >= 4) out = out.split(s).join("[oculto]");
  return out;
}

// ── IO ───────────────────────────────────────────────────────────────────────

/**
 * Pide un token de la Admin API con el client credentials grant. Nunca lanza.
 * El mensaje de un fallo no lleva nada de la respuesta salvo el código HTTP y,
 * si lo hay y es un código simple, el `error` de Shopify.
 */
export async function requestClientCredentialsToken(input: {
  shop: string;
  clientId: string;
  clientSecret: string;
  fetchImpl?: typeof fetch;
  now?: Date;
}): Promise<OwnAppTokenResult> {
  const shop = (input.shop ?? "").trim().toLowerCase();
  const clientId = (input.clientId ?? "").trim();
  const clientSecret = (input.clientSecret ?? "").trim();
  if (!isValidShopDomain(shop)) {
    return { ok: false, reason: "credenciales", message: "El dominio no es una tienda tu-tienda.myshopify.com." };
  }
  if (!clientId || !clientSecret) {
    return { ok: false, reason: "credenciales", message: "Falta el Client ID o el Client secret." };
  }

  const doFetch = input.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await doFetch(`https://${shop}/admin/oauth/access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: clientId,
        client_secret: clientSecret,
      }).toString(),
      // Una redirección no se sigue: reenviaría el secreto a otra dirección.
      redirect: "manual",
      signal: AbortSignal.timeout(OWN_APP_TOKEN_TIMEOUT_MS),
    });
  } catch (e) {
    const name = e instanceof Error ? e.name : "";
    return {
      ok: false,
      reason: "red",
      message:
        name === "TimeoutError" || name === "AbortError"
          ? "Shopify no respondió a tiempo. Intenta de nuevo."
          : "No se pudo conectar con Shopify. Intenta de nuevo.",
    };
  }

  if (res.status !== 200) {
    let code = "";
    let text = "";
    try {
      const raw = (await res.text()).slice(0, 4000);
      try {
        const body = JSON.parse(raw) as Record<string, unknown>;
        code = typeof body?.error === "string" ? body.error.trim().toLowerCase() : "";
        const desc =
          typeof body?.error_description === "string"
            ? body.error_description
            : typeof body?.errors === "string"
              ? body.errors
              : "";
        text = `${code} ${desc}`.toLowerCase();
      } catch {
        text = raw.toLowerCase();
      }
    } catch {
      /* sin cuerpo: se clasifica por el estado */
    }
    const r = classifyRejection(res.status, code, text);
    return { ok: false, reason: r.reason, message: redact(r.message, [clientSecret, clientId]) };
  }

  let json: Record<string, unknown> | null = null;
  try {
    json = (await res.json()) as Record<string, unknown>;
  } catch {
    json = null;
  }
  const token = json && typeof json.access_token === "string" ? json.access_token.trim() : "";
  if (!json || !token) {
    return { ok: false, reason: "respuesta_invalida", message: "Shopify contestó sin un token de acceso." };
  }
  return {
    ok: true,
    token,
    scopes: parseScopes(json.scope),
    expiresAt: tokenExpiresAt(json.expires_in, input.now ?? new Date()),
  };
}

const MISSING_SCOPES_PREFIX = "A la app le faltan permisos que Kapta necesita: ";

/** El aviso de permisos que faltan, en castellano. */
export function missingScopesMessage(missing: readonly string[]): string {
  return `${MISSING_SCOPES_PREFIX}${missing.join(", ")}. Agrégalos en el Dev Dashboard (nueva versión de la app), vuelve a instalarla en la tienda y prueba de nuevo.`;
}

/**
 * El título del aviso de Ajustes para `shopify_token_error`. Una renovación que
 * salió bien con permisos de menos guarda el aviso de permisos: no es «falló».
 */
export function ownAppErrorTitle(error: string | null | undefined): string {
  return (error ?? "").startsWith(MISSING_SCOPES_PREFIX) ? "Faltan permisos en la app" : "La última renovación falló";
}

const OWN_APP_COLUMNS_RE =
  /shopify_client_id|shopify_client_secret_enc|shopify_token_expires_at|shopify_token_error|shopify_token_renewed_at|shopify_token_retry_at|shopify_webhook_secret_prev_enc|shopify_webhook_secret_prev_set_at|stores_shopify_app_check/;

/**
 * ¿El error dice que falta la 0271? Una columna nueva que no existe (42703 de
 * Postgres o PGRST204 de PostgREST) o el CHECK viejo que no acepta 'propia'
 * (23514). Otro error es otra cosa y no se disfraza de «falta la migración».
 */
export function isOwnAppMigrationMissing(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const { code, message, details } = error as { code?: unknown; message?: unknown; details?: unknown };
  if (code !== "42703" && code !== "PGRST204" && code !== "23514") return false;
  return [message, details].some((t) => typeof t === "string" && OWN_APP_COLUMNS_RE.test(t));
}

/** Las columnas que lee la renovación. Nunca se mandan al navegador. */
const RENEW_COLUMNS =
  "id,shopify_domain,shopify_app,status,shopify_client_id,shopify_client_secret_enc,shopify_token_enc,shopify_token_expires_at,shopify_token_retry_at";

interface OwnAppStoreRow {
  id: string;
  shopify_domain: string | null;
  shopify_app: string | null;
  status: string | null;
  shopify_client_id: string | null;
  shopify_client_secret_enc: string | null;
  shopify_token_enc: string | null;
  shopify_token_expires_at: string | null;
  shopify_token_retry_at?: string | null;
}

export type OwnAppRenewFailure =
  | OwnAppTokenFailure
  | "sin_migracion"
  | "lectura"
  | "no_encontrada"
  | "no_propia"
  | "inactiva"
  | "sin_credenciales"
  | "guardado"
  /** Renovación al usar: otro intento reciente; se espera al freno (`shopify_token_retry_at`). */
  | "en_espera";

export type OwnAppRenewResult =
  | {
      ok: true;
      token: string;
      expiresAt: Date;
      /** false: el token guardado aún servía (`skipIfValidForMs`) y no se pidió otro. */
      renewed: boolean;
      /** false: se pidió, pero en la base ya había uno que vence después, o la tienda cambió. */
      stored: boolean;
      /** Permisos que la app ya no tiene (el token se guarda igual). */
      missingScopes: string[];
    }
  | { ok: false; reason: OwnAppRenewFailure; message: string };

/**
 * Anota por qué no se renovó, sin tocar el token actual. Nunca lanza.
 *
 * `attemptStart` es cuándo empezó ESTE intento: si mientras tanto otro proceso
 * guardó un token (su `shopify_token_renewed_at` es posterior), el fallo es
 * viejo y no se escribe: no pisa el «salió bien» de una renovación más nueva.
 * Con `retryAt` además frena la renovación al usar hasta esa hora.
 */
async function writeTokenError(
  admin: SupabaseClient,
  storeId: string,
  message: string,
  attemptStart: Date,
  retryAt?: Date,
): Promise<void> {
  try {
    await admin
      .from("stores")
      .update({
        shopify_token_error: message.slice(0, 500),
        ...(retryAt ? { shopify_token_retry_at: retryAt.toISOString() } : {}),
      })
      .eq("id", storeId)
      .eq("shopify_app", OWN_APP)
      .or(`shopify_token_renewed_at.is.null,shopify_token_renewed_at.lt.${attemptStart.toISOString()}`);
  } catch {
    /* best-effort: el motivo también sale en el resultado */
  }
}

/**
 * Renovación al usar: reserva el intento de forma atómica. Solo una llamada
 * gana la ventana de `OWN_APP_ON_USE_RETRY_MS`; las demás no salen a Shopify.
 * Devuelve false si otra ya la tiene (o no se pudo reservar).
 */
async function claimOnUseAttempt(admin: SupabaseClient, storeId: string, now: Date): Promise<boolean> {
  try {
    const nowIso = now.toISOString();
    const { data, error } = await admin
      .from("stores")
      .update({ shopify_token_retry_at: new Date(now.getTime() + OWN_APP_ON_USE_RETRY_MS).toISOString() })
      .eq("id", storeId)
      .eq("shopify_app", OWN_APP)
      .in("status", [...OWN_APP_RENEWABLE_STATUSES])
      .or(`shopify_token_retry_at.is.null,shopify_token_retry_at.lte.${nowIso}`)
      .select("id");
    if (error) return false;
    return Array.isArray(data) ? data.length > 0 : Boolean(data);
  } catch {
    return false;
  }
}

/**
 * Renueva el token de una tienda con app propia. Solo actúa si la tienda es
 * 'propia' y está activa o en pausa; si no, no escribe nada. Con
 * `skipIfValidForMs`, si el token guardado aún sirve ese tiempo no pide otro
 * (dos procesos a la vez no acuñan dos).
 *
 * Con `onUse` (la renovación al usar el token) respeta el freno de
 * `shopify_token_retry_at` y reserva el intento antes de salir a Shopify: con
 * Shopify caído o el secreto revocado, como mucho un pedido cada 5 minutos (15
 * tras un fallo de red), no uno por cada uso. El cron y «Renovar ahora» no
 * pasan `onUse`.
 *
 * Al guardar, la condición es que la tienda siga 'propia' y no deshabilitada
 * (el cron no resucita una tienda desinstalada) y que no haya uno que venza
 * DESPUÉS (no se pisa un token más nuevo con uno más viejo). Si falla, deja el
 * motivo en `shopify_token_error` (salvo que otro proceso haya renovado
 * mientras tanto) y el token actual sigue como estaba.
 */
export async function renewOwnAppToken(
  admin: SupabaseClient,
  storeId: string,
  opts: { fetchImpl?: typeof fetch; now?: Date; skipIfValidForMs?: number; onUse?: boolean } = {},
): Promise<OwnAppRenewResult> {
  const now = opts.now ?? new Date();
  const { data, error } = await admin.from("stores").select(RENEW_COLUMNS).eq("id", storeId).maybeSingle();
  if (error) {
    return isOwnAppMigrationMissing(error)
      ? { ok: false, reason: "sin_migracion", message: OWN_APP_MIGRATION_MISSING_MESSAGE }
      : { ok: false, reason: "lectura", message: "No se pudo leer la tienda." };
  }
  const row = data as OwnAppStoreRow | null;
  if (!row) return { ok: false, reason: "no_encontrada", message: "La tienda no existe." };
  if (row.shopify_app !== OWN_APP) {
    return { ok: false, reason: "no_propia", message: "Esta tienda no usa app propia: no se toca." };
  }
  if (!isOwnAppRenewableStatus(row.status)) {
    return { ok: false, reason: "inactiva", message: "La tienda está deshabilitada: no se renueva su acceso." };
  }

  if (opts.skipIfValidForMs != null && row.shopify_token_enc && !shouldRenew(row.shopify_token_expires_at, now, opts.skipIfValidForMs)) {
    try {
      return {
        ok: true,
        token: decrypt(row.shopify_token_enc),
        expiresAt: toDate(row.shopify_token_expires_at)!,
        renewed: false,
        stored: false,
        missingScopes: [],
      };
    } catch {
      /* el guardado no se descifra: se pide uno nuevo */
    }
  }

  if (opts.onUse) {
    // El freno: otro intento reciente (o un fallo de red hace poco). Ni base
    // ni red; quien llama sigue con el token que tiene mientras valga.
    const retryAt = toDate(row.shopify_token_retry_at);
    const waiting = { ok: false as const, reason: "en_espera" as const, message: "Hubo un intento hace poco: se espera antes de pedir otro token." };
    if (retryAt && retryAt.getTime() > now.getTime()) return waiting;
    if (!(await claimOnUseAttempt(admin, storeId, now))) return waiting;
  }

  const clientId = (row.shopify_client_id ?? "").trim();
  if (!clientId || !row.shopify_client_secret_enc) {
    const message = "Faltan el Client ID o el Client secret de la app propia: guárdalos en Ajustes → Shopify.";
    await writeTokenError(admin, storeId, message, now);
    return { ok: false, reason: "sin_credenciales", message };
  }
  let clientSecret: string;
  try {
    clientSecret = decrypt(row.shopify_client_secret_enc);
  } catch {
    const message = "No se pudo leer el Client secret guardado: vuelve a guardarlo en Ajustes → Shopify.";
    await writeTokenError(admin, storeId, message, now);
    return { ok: false, reason: "sin_credenciales", message };
  }

  const got = await requestClientCredentialsToken({
    shop: row.shopify_domain ?? "",
    clientId,
    clientSecret,
    fetchImpl: opts.fetchImpl,
    now,
  });
  if (!got.ok) {
    // Shopify no respondió bien (red, 429, 5xx): la renovación al usar espera
    // más antes de volver a intentar. El cron sigue a su hora.
    const retryAt = got.reason === "red" ? new Date(now.getTime() + OWN_APP_ON_USE_RETRY_AFTER_RED_MS) : undefined;
    await writeTokenError(admin, storeId, got.message, now, retryAt);
    return got;
  }

  const missing = missingScopes(got.scopes);
  const expiresIso = got.expiresAt.toISOString();
  const { data: saved, error: saveError } = await admin
    .from("stores")
    .update({
      shopify_token_enc: encrypt(got.token),
      shopify_token_expires_at: expiresIso,
      shopify_token_renewed_at: now.toISOString(),
      shopify_token_error: missing.length ? missingScopesMessage(missing) : null,
      shopify_token_retry_at: null,
    })
    .eq("id", storeId)
    .eq("shopify_app", OWN_APP)
    .in("status", [...OWN_APP_RENEWABLE_STATUSES])
    .or(`shopify_token_expires_at.is.null,shopify_token_expires_at.lt.${expiresIso}`)
    .select("id");
  if (saveError) {
    return { ok: false, reason: "guardado", message: "Shopify dio el token, pero no se pudo guardar en la base." };
  }
  const stored = Array.isArray(saved) ? saved.length > 0 : Boolean(saved);
  return { ok: true, token: got.token, expiresAt: got.expiresAt, renewed: true, stored, missingScopes: missing };
}

/**
 * El token para usar AHORA en una tienda. Para lo que no es 'propia' devuelve
 * `current` sin más (ni consulta ni red). Para una 'propia' activa o en pausa
 * cuyo token vence en menos de `OWN_APP_RENEW_ON_USE_MS` (o no hay), lo renueva
 * antes, con el freno de `onUse`; si la renovación falla o está frenada, sirve
 * el actual mientras no haya vencido.
 *
 * Quien recibe un webhook o un aviso de afuera lo llama DESPUÉS de comprobar la
 * firma o el secreto: una petición falsa no hace salir el Client secret.
 */
export async function ownAppTokenForUse(
  admin: SupabaseClient,
  row: { id: string; shopify_app?: unknown; status?: unknown; shopify_token_expires_at?: unknown },
  current: string | null,
  opts: { now?: Date; fetchImpl?: typeof fetch } = {},
): Promise<string | null> {
  if (row.shopify_app !== OWN_APP || !isOwnAppRenewableStatus(row.status)) return current;
  const now = opts.now ?? new Date();
  const expires = typeof row.shopify_token_expires_at === "string" ? row.shopify_token_expires_at : null;
  if (current && !shouldRenew(expires, now, OWN_APP_RENEW_ON_USE_MS)) return current;

  let renewed: OwnAppRenewResult | null = null;
  try {
    renewed = await renewOwnAppToken(admin, row.id, {
      now,
      fetchImpl: opts.fetchImpl,
      skipIfValidForMs: OWN_APP_RENEW_ON_USE_MS,
      onUse: true,
    });
  } catch {
    renewed = null;
  }
  if (renewed?.ok) return renewed.token;
  // Frenada: el intento que la frenó ya dejó su línea (o su motivo en la base).
  if (renewed?.reason !== "en_espera") {
    console.warn(
      `[shopify-own-app] ${JSON.stringify({ storeId: row.id, renovado: false, motivo: renewed?.reason ?? "excepcion" })}`,
    );
  }
  if (!current) return null;
  const exp = toDate(expires);
  // Se sabe que venció: no sirve. Si no se sabe, se usa (mejor esfuerzo).
  return exp && exp.getTime() <= now.getTime() ? null : current;
}

/**
 * Igual que `ownAppTokenForUse`, para quien solo leyó el dominio y el token:
 * lee lo que falta de la tienda. Solo se llama para tiendas 'propia'.
 */
export async function ownAppTokenForUseById(
  admin: SupabaseClient,
  storeId: string,
  current: string | null,
  opts: { now?: Date; fetchImpl?: typeof fetch } = {},
): Promise<string | null> {
  const { data, error } = await admin
    .from("stores")
    .select("id,shopify_app,status,shopify_token_expires_at")
    .eq("id", storeId)
    .maybeSingle();
  if (error || !data) return current;
  return ownAppTokenForUse(admin, data as { id: string }, current, opts);
}

// ── Lo que se muestra en Ajustes ─────────────────────────────────────────────

function hhmm(d: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("es-PE", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d);
}

function ymd(d: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

function ago(ms: number): string {
  const min = Math.floor(ms / 60_000);
  if (min < 1) return "hace un momento";
  if (min < 60) return `hace ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 48) return `hace ${h} h`;
  return `hace ${Math.floor(h / 24)} días`;
}

/**
 * La zona de la tienda si Intl la entiende; si no, America/Lima. `timezone` es
 * texto libre en Ajustes: una zona mala («Lima», «GMT-5») no tumba la página.
 */
function safeTimeZone(timeZone: string | null | undefined): string {
  const tz = (timeZone ?? "").trim();
  if (!tz) return "America/Lima";
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: tz });
    return tz;
  } catch {
    return "America/Lima";
  }
}

/** «el 23/10 a las 14:20», en la zona de la tienda. */
function dayAndTime(d: Date, tz: string): string {
  const day = ymd(d, tz);
  return `el ${day.slice(8, 10)}/${day.slice(5, 7)} a las ${hhmm(d, tz)}`;
}

/**
 * La línea de estado de Ajustes: «App propia · acceso renovado hace 35 min ·
 * vence a las 14:20». Las horas, en la zona de la tienda.
 *
 * Una tienda deshabilitada (desinstalada) o sin token no muestra «vence …»: el
 * vencimiento que quedó guardado ya no es de un acceso que valga.
 */
export function ownAppStatusLine(input: {
  renewedAt: string | null | undefined;
  expiresAt: string | null | undefined;
  now: Date;
  timeZone?: string;
  /** `stores.status`. Sin dato, como activa. */
  status?: string | null;
  /** ¿Hay token guardado? Sin dato, como si lo hubiera. */
  hasToken?: boolean;
  /** `stores.shopify_uninstalled_at`. */
  uninstalledAt?: string | null;
}): string {
  const tz = safeTimeZone(input.timeZone);
  const parts = ["App propia"];
  if (input.status === "disabled") {
    const uninstalled = toDate(input.uninstalledAt);
    parts.push(
      uninstalled
        ? `app desinstalada ${dayAndTime(uninstalled, tz)}`
        : "tienda deshabilitada: Kapta no renueva su acceso",
    );
    return parts.join(" · ");
  }
  const renewed = toDate(input.renewedAt);
  parts.push(renewed ? `acceso renovado ${ago(Math.max(0, input.now.getTime() - renewed.getTime()))}` : "acceso aún sin renovar");
  if (input.hasToken === false) {
    parts.push("sin token vigente");
    return parts.join(" · ");
  }
  const expires = toDate(input.expiresAt);
  if (expires) {
    const past = expires.getTime() <= input.now.getTime();
    const day = ymd(expires, tz);
    const today = ymd(input.now, tz);
    const tomorrow = ymd(new Date(input.now.getTime() + 86_400_000), tz);
    const when =
      day === today
        ? `a las ${hhmm(expires, tz)}`
        : day === tomorrow && !past
          ? `mañana a las ${hhmm(expires, tz)}`
          : dayAndTime(expires, tz);
    parts.push(`${past ? "venció" : "vence"} ${when}`);
  }
  return parts.join(" · ");
}

/**
 * La ayuda bajo la línea de estado: qué hacer según cómo está la tienda. A una
 * deshabilitada no se le sugiere «renueva» («Renovar ahora» la rechaza).
 */
export function ownAppAccessHint(input: {
  status?: string | null;
  hasToken: boolean;
  uninstalledAt?: string | null;
}): string {
  if (input.status === "disabled") {
    return toDate(input.uninstalledAt)
      ? "Reinstala la app en la tienda desde el Dev Dashboard, guarda otra vez las credenciales aquí, pasa la tienda a «Activa» en Tienda y re-registra los webhooks."
      : "La tienda está deshabilitada: Kapta no le pide token a Shopify. Pásala a «Activa» en Tienda para que vuelva a hacerlo.";
  }
  return input.hasToken
    ? "Token configurado (cifrado)."
    : "Aún sin token: pulsa «Renovar ahora» o vuelve a guardar las credenciales.";
}

/**
 * Hasta cuándo se aceptan los webhooks firmados con el Client secret anterior,
 * o null si ya no se acepta (no hay, o pasó el plazo).
 */
export function ownAppPrevSecretValidUntil(prevSetAt: string | null | undefined, now: Date): Date | null {
  const set = toDate(prevSetAt);
  if (!set) return null;
  const until = new Date(set.getTime() + OWN_APP_PREV_WEBHOOK_SECRET_GRACE_MS);
  return until.getTime() > now.getTime() ? until : null;
}

/** «hasta el 25/10 a las 14:20», en la zona de la tienda. */
export function ownAppPrevSecretLine(until: Date, timeZone?: string | null): string {
  return `hasta ${dayAndTime(until, safeTimeZone(timeZone))}`;
}
