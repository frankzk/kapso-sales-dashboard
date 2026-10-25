// La revisión de los webhooks de WooCommerce (MOM §38.14, 25-10-2026).
//
// WooCommerce no reintenta un aviso que falló y DESACTIVA el webhook después de
// 5 fallos seguidos (MOM §38.8 y §38.11). Desactivado, no vuelve solo, y nadie
// se entera: los pedidos siguen llegando por la pasada `woo_orders` con hasta
// 5 minutos de retraso y el Master no muestra nada raro. Esta revisión lee la
// lista de webhooks del sitio (`GET /wp-json/wc/v3/webhooks`) y comprueba que
// cada uno de los cuatro temas de pedido (`WOO_INTAKE_TOPICS`) tenga al menos un
// webhook «Activo» que entregue a esta tienda de Kapta
// (`/api/webhooks/woocommerce/<storeId>`). Lo que encuentra queda en
// `sync_state` (fuente `woo_webhooks`) y, si algo falla, en
// `stores.woo_last_error`, que es lo que Ajustes → WooCommerce ya muestra.
//
// La corre el cron `/api/cron/woo-webhooks` cada hora, y Ajustes → WooCommerce
// al «Guardar» o «Probar conexión» con las claves que acaba de probar.
//
// SOLO LECTURA contra WooCommerce: nunca crea, reactiva, cambia ni borra un
// webhook. Arreglarlo es de quien administra el WordPress; Kapta solo avisa.
//
// LO QUE NO SALE DE AQUÍ. De cada webhook se queda solo su id, su estado, su
// tema y a qué tienda de Kapta entrega: ni la dirección de entrega, ni el
// nombre, ni nada más de la respuesta llega a la base, al reporte o al log. (El
// secreto de un webhook es de solo escritura en la API: no viene, y si viniera
// tampoco se leería.)
//
// EL HOST DE LA DIRECCIÓN NO SE COMPARA. Kapta contesta en más de una dirección
// (la de `NEXT_PUBLIC_SITE_URL` y la que tenía el navegador cuando el owner
// copió la de Ajustes), así que exigir una sola daría por malos webhooks que
// funcionan. La tienda va en la ruta (`/api/webhooks/woocommerce/<storeId>`) y
// eso es lo que se compara. Una dirección que no llega a Kapta falla en cada
// aviso y WooCommerce la desactiva tras 5 fallos: eso sí se ve aquí.
//
// LO QUE LA LISTA NO DICE (y por eso no se revisa). `GET /webhooks` devuelve
// id, nombre, estado, tema, recurso, evento, hooks, dirección de entrega y
// fechas: NO la versión de la API del webhook («WP REST API Integration v3»),
// ni el secreto (de solo escritura), ni cuántas veces falló. Así que la versión
// se mira a mano en WooCommerce, y un webhook con el secreto mal puesto sigue
// «Activo» hasta su quinto fallo seguido: la revisión lo ve cuando WooCommerce
// lo desactiva, no antes.

import type { SupabaseClient } from "@supabase/supabase-js";
import { WooError, wooGetPage, type WooAuthMode, type WooClientOpts, type WooErrorKind } from "@/lib/woocommerce";
import {
  WOO_INTAKE_TOPICS,
  WOO_STORE_COLUMNS,
  hasWooApiCredentials,
  recordWooLastError,
  withWooAuthFallback,
  wooClientOpts,
  wooCredsFromRow,
  type WooIntakeTopic,
} from "@/lib/woocommerce-intake";
import { isWooMigrationMissing } from "@/lib/woocommerce-settings";

/** La fuente de `sync_state` de la revisión. */
export const WOO_WEBHOOKS_SOURCE = "woo_webhooks";
/**
 * Prefijo de lo que la revisión deja en `stores.woo_last_error`. Distinto del
 * «Webhook: » del aviso que entra (que lo limpia un aviso bueno) y del
 * «Sincronización: » de la pasada (que lo limpia una pasada buena): este solo
 * lo limpia una revisión que encuentra todo bien.
 */
export const WOO_WEBHOOKS_ERROR_PREFIX = "Webhooks en WooCommerce: ";
/** La ruta de la API REST v3 que se lee (solo `GET`). */
export const WOO_WEBHOOKS_PATH = "/webhooks";
/** Webhooks por página: el máximo de WooCommerce. */
export const WOO_WEBHOOKS_PER_PAGE = 100;
/** Páginas como mucho (200 webhooks): un sitio de verdad tiene unos pocos. */
export const WOO_WEBHOOKS_MAX_PAGES = 2;
/**
 * Reloj por tienda: después de esto no se pide otra página. Cada llamada corta
 * además a los 15 s (`WOO_TIMEOUT_MS`, el de todas las llamadas a WooCommerce).
 */
export const WOO_WEBHOOKS_BUDGET_MS = 30_000;
/**
 * Fallos de lectura que no se escriben en `woo_last_error`: WooCommerce caído,
 * lento o pidiendo esperar. Eso ya lo dice la pasada `woo_orders` cada 5
 * minutos; la revisión lo deja solo en `sync_state`. Los demás (permisos, una
 * respuesta que no es la API) sí van: con ellos la revisión está ciega.
 */
export const WOO_WEBHOOKS_TRANSIENT_ERRORS: readonly WooErrorKind[] = ["red", "tiempo", "servidor", "limite"];

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const UUID_RE = new RegExp(`^${UUID}$`, "i");
/** La ruta del webhook de Kapta (`app/api/webhooks/woocommerce/[storeId]`), con o sin barra final. */
const KAPTA_WEBHOOK_PATH_RE = new RegExp(`^/api/webhooks/woocommerce/(${UUID})/?$`, "i");

/** Lo único que se toma de cada webhook de la lista. */
export interface WooWebhookSummary {
  id: number | null;
  /** `active`, `paused` o `disabled`, en minúsculas. */
  status: string;
  /** `order.created`…, en minúsculas. */
  topic: string;
  /** La tienda de Kapta a la que entrega (`/api/webhooks/woocommerce/<id>`), o null si entrega a otra parte. */
  kaptaStoreId: string | null;
}

/** La tienda de Kapta de una dirección de entrega, o null si no es la ruta del webhook de Kapta. */
export function wooWebhookKaptaStore(deliveryUrl: unknown): string | null {
  const raw = typeof deliveryUrl === "string" ? deliveryUrl.trim() : "";
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const m = KAPTA_WEBHOOK_PATH_RE.exec(url.pathname);
  return m ? m[1]!.toLowerCase() : null;
}

function lowerText(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

/**
 * La respuesta de `GET /webhooks` → lo único que la revisión necesita. La
 * dirección de entrega se reduce aquí mismo a «a qué tienda de Kapta va»: el
 * resto no sigue. Lo que no es un objeto se descarta.
 */
export function summarizeWooWebhooks(items: readonly unknown[]): WooWebhookSummary[] {
  const out: WooWebhookSummary[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const w = item as Record<string, unknown>;
    const id = typeof w.id === "number" && Number.isInteger(w.id) ? w.id : null;
    out.push({ id, status: lowerText(w.status), topic: lowerText(w.topic), kaptaStoreId: wooWebhookKaptaStore(w.delivery_url) });
  }
  return out;
}

/**
 * Cómo está cada tema:
 *   · `ok`: hay al menos uno «Activo» que entrega a esta tienda (si además hay
 *     otros viejos desactivados, no importa: el tema está cubierto);
 *   · `desactivado`: los de esta tienda están desactivados (WooCommerce lo
 *     hace solo tras 5 fallos seguidos);
 *   · `en_pausa`: los de esta tienda están en pausa (lo hizo alguien);
 *   · `inactivo`: los de esta tienda están en otro estado que no es «Activo»;
 *   · `otra_tienda`: ninguno entrega a esta tienda, pero alguno entrega a otra
 *     tienda de Kapta (la dirección de otra tienda pegada por error);
 *   · `falta`: no hay ninguno de ese tema que entregue a Kapta.
 */
export type WooWebhookTopicState = "ok" | "falta" | "desactivado" | "en_pausa" | "inactivo" | "otra_tienda";

export interface WooWebhooksVerdict {
  ok: boolean;
  topics: Record<WooIntakeTopic, WooWebhookTopicState>;
  /** Qué falta y qué hacer, para Ajustes; null si todo bien. Sin direcciones ni secretos. */
  problem: string | null;
}

function topicProblem(topic: WooIntakeTopic, state: Exclude<WooWebhookTopicState, "ok">): string {
  switch (state) {
    case "falta":
      return `falta ${topic}`;
    case "desactivado":
      return `${topic} está desactivado`;
    case "en_pausa":
      return `${topic} está en pausa`;
    case "inactivo":
      return `${topic} no está activo`;
    case "otra_tienda":
      return `${topic} entrega a otra tienda de Kapta`;
  }
}

/** Revisa la lista contra los cuatro temas de esta tienda. Pura. */
export function evaluateWooWebhooks(webhooks: readonly WooWebhookSummary[], storeId: string): WooWebhooksVerdict {
  const me = storeId.trim().toLowerCase();
  const topics = {} as Record<WooIntakeTopic, WooWebhookTopicState>;
  const parts: string[] = [];
  for (const topic of WOO_INTAKE_TOPICS) {
    const toKapta = webhooks.filter((w) => w.topic === topic && w.kaptaStoreId);
    const mine = toKapta.filter((w) => w.kaptaStoreId === me);
    let state: WooWebhookTopicState;
    if (mine.some((w) => w.status === "active")) state = "ok";
    else if (mine.some((w) => w.status === "disabled")) state = "desactivado";
    else if (mine.some((w) => w.status === "paused")) state = "en_pausa";
    else if (mine.length) state = "inactivo";
    else if (toKapta.length) state = "otra_tienda";
    else state = "falta";
    topics[topic] = state;
    if (state !== "ok") parts.push(topicProblem(topic, state));
  }
  if (!parts.length) return { ok: true, topics, problem: null };

  const states = new Set(Object.values(topics));
  // Sin mayúscula: empieza por el nombre del tema («order.created está…»).
  const lines = [
    `${parts.join(", ")}.`,
    "En WooCommerce → Ajustes → Avanzado → Webhooks cada tema necesita uno «Activo», con la dirección y el secreto de esta tienda.",
  ];
  if (states.has("desactivado")) {
    lines.push("WooCommerce desactiva uno tras 5 fallos seguidos: revisa el secreto y la dirección antes de volver a activarlo.");
  }
  lines.push("Mientras tanto los pedidos llegan por la sincronización, cada 5 minutos.");
  return { ok: false, topics, problem: lines.join(" ") };
}

export type WooWebhooksStatus = "ok" | "warning" | "error";

/** El resultado de una revisión. Sin direcciones ni secretos: va a la base, al reporte y al log. */
export interface WooWebhooksCheck {
  /** `ok`: los cuatro bien; `warning`: se leyó la lista y algo falta; `error`: no se pudo leer o no alcanzó. */
  status: WooWebhooksStatus;
  /** Cómo está cada tema; null si no se pudo leer la lista. */
  topics: Record<WooIntakeTopic, WooWebhookTopicState> | null;
  /** Qué falta (`warning`) o por qué no se pudo revisar (`error`); null si todo bien. */
  message: string | null;
  /** El tipo de fallo de WooCommerce, si lo hubo. */
  errorKind: WooErrorKind | null;
  /** Cuántos webhooks se leyeron (de todos los temas y destinos). */
  webhooks: number;
  pages: number;
  /** Con qué autenticación salió la lectura (`query` si el hosting borra la cabecera). */
  auth: WooAuthMode | null;
}

export interface WooWebhooksCheckOptions {
  now?: () => number;
  budgetMs?: number;
  maxPages?: number;
}

/**
 * Lee los webhooks del sitio (`GET /webhooks?per_page=100&page=N`, con el
 * respaldo de la query string si el hosting borra la cabecera Authorization)
 * y los revisa. Nunca lanza. Solo `GET`: no cambia nada en WooCommerce.
 */
export async function checkWooWebhooks(
  client: WooClientOpts,
  storeId: string,
  opts: WooWebhooksCheckOptions = {},
): Promise<WooWebhooksCheck> {
  const now = opts.now ?? Date.now;
  const deadline = now() + (opts.budgetMs ?? WOO_WEBHOOKS_BUDGET_MS);
  const maxPages = Math.max(1, opts.maxPages ?? WOO_WEBHOOKS_MAX_PAGES);
  const items: WooWebhookSummary[] = [];
  let auth: WooAuthMode | undefined = client.auth;
  let pages = 0;
  let complete = false;
  try {
    for (let page = 1; page <= maxPages; page++) {
      if (page > 1 && now() >= deadline) break;
      const { value, auth: used } = await withWooAuthFallback({ ...client, auth }, (o) =>
        wooGetPage<unknown>(o, WOO_WEBHOOKS_PATH, { per_page: WOO_WEBHOOKS_PER_PAGE, page }),
      );
      auth = used;
      pages++;
      items.push(...summarizeWooWebhooks(value.items));
      if (value.items.length < WOO_WEBHOOKS_PER_PAGE || (value.totalPages != null && page >= value.totalPages)) {
        complete = true;
        break;
      }
    }
  } catch (e) {
    // Si lo ya leído alcanza para decir «bien», una página siguiente que falla
    // no lo cambia: lo que falte no puede estar en ella.
    if (pages > 0) {
      const partial = evaluateWooWebhooks(items, storeId);
      if (partial.ok) {
        return { status: "ok", topics: partial.topics, message: null, errorKind: null, webhooks: items.length, pages, auth: auth ?? null };
      }
    }
    const err = e instanceof WooError ? e : null;
    return {
      status: "error",
      topics: null,
      message: `no se pudieron revisar: ${err ? err.message : "no se pudo conectar con WooCommerce."}`,
      errorKind: err?.kind ?? null,
      webhooks: items.length,
      pages,
      auth: auth ?? null,
    };
  }

  const verdict = evaluateWooWebhooks(items, storeId);
  const base = { topics: verdict.topics, errorKind: null, webhooks: items.length, pages, auth: auth ?? null };
  if (verdict.ok) return { status: "ok", message: null, ...base };
  // Sin la lista entera, «falta» puede estar en la parte que no se leyó.
  if (!complete) {
    return {
      status: "error",
      message: `no se pudieron revisar: el sitio tiene más de ${items.length} webhooks y Kapta no alcanzó a leerlos todos.`,
      ...base,
    };
  }
  return { status: "warning", message: verdict.problem, ...base };
}

/**
 * Qué escribir en `stores.woo_last_error` después de una revisión: el texto,
 * null (limpiar el aviso de una revisión anterior) o undefined (no tocarlo).
 * Solo limpia lo que empieza con `WOO_WEBHOOKS_ERROR_PREFIX`: el aviso de la
 * pasada o de un webhook lo limpian ellos. Pura.
 */
export function wooWebhooksLastError(
  check: Pick<WooWebhooksCheck, "status" | "message" | "errorKind">,
  current: string | null | undefined,
): string | null | undefined {
  if (check.status === "ok") return current?.startsWith(WOO_WEBHOOKS_ERROR_PREFIX) ? null : undefined;
  if (check.status === "error" && check.errorKind && WOO_WEBHOOKS_TRANSIENT_ERRORS.includes(check.errorKind)) {
    return undefined;
  }
  return `${WOO_WEBHOOKS_ERROR_PREFIX}${check.message ?? "algo no está bien."}`;
}

/**
 * Deja la revisión en `sync_state` (fuente `woo_webhooks`: estado, hora y el
 * texto si algo falla; el cursor no se usa) y, si corresponde, en
 * `stores.woo_last_error`. Nunca lanza.
 */
export async function recordWooWebhooksCheck(
  admin: SupabaseClient,
  storeId: string,
  check: WooWebhooksCheck,
  currentLastError: string | null | undefined,
): Promise<void> {
  try {
    await admin.from("sync_state").upsert(
      {
        store_id: storeId,
        source: WOO_WEBHOOKS_SOURCE,
        last_run_at: new Date().toISOString(),
        status: check.status,
        error: check.message,
      },
      { onConflict: "store_id,source" },
    );
  } catch {
    /* best-effort: es un aviso, no un paso del proceso */
  }
  const next = wooWebhooksLastError(check, currentLastError);
  if (next !== undefined) await recordWooLastError(admin, storeId, next, currentLastError);
}

/** La línea que Ajustes agrega a su aviso después de «Guardar» o «Probar conexión». */
export function wooWebhooksNotice(check: Pick<WooWebhooksCheck, "status" | "message">): string {
  if (check.status === "ok") return "Webhooks: los cuatro temas tienen uno activo que entrega a esta tienda.";
  if (check.status === "warning") return `Webhooks: ${check.message}`;
  return `Los webhooks ${check.message}`;
}

// ---------------------------------------------------------------------------
// El cron: todas las tiendas con WooCommerce conectado
// ---------------------------------------------------------------------------

/** Lo que el cron cuenta de cada tienda. Ids, estados y tipos de fallo: nada más. */
export interface WooWebhooksStoreReport {
  storeId: string;
  /** `skipped`: la tienda no tiene el sitio, la clave del sitio y las dos claves de la API. */
  status: WooWebhooksStatus | "skipped";
  topics?: Record<WooIntakeTopic, WooWebhookTopicState> | null;
  errorKind?: WooErrorKind | null;
  webhooks?: number;
}

export interface WooWebhooksRunReport {
  ok: boolean;
  dry: boolean;
  at: string;
  /** Pre-0274 (el código puede llegar antes que la base): no hay nada que revisar. */
  skipped?: "sin_migracion";
  error?: string;
  stores: WooWebhooksStoreReport[];
}

export interface WooWebhooksRunOptions extends WooWebhooksCheckOptions {
  /** Solo esa tienda. */
  storeId?: string;
  /** Revisa sin escribir nada en la base. */
  dry?: boolean;
  fetchImpl?: typeof fetch;
}

/**
 * Revisa los webhooks de cada tienda ACTIVA con WooCommerce conectado (sitio,
 * clave del sitio y las dos claves de la API, lo mismo que activa la pasada
 * `woo_orders`), en paralelo: son sitios distintos y pocas tiendas. Una tienda
 * sin eso no hace ni una llamada. Nunca lanza.
 */
export async function runWooWebhooksChecks(
  admin: SupabaseClient,
  opts: WooWebhooksRunOptions = {},
): Promise<WooWebhooksRunReport> {
  const dry = Boolean(opts.dry);
  const report: WooWebhooksRunReport = { ok: true, dry, at: new Date().toISOString(), stores: [] };
  if (opts.storeId !== undefined && !UUID_RE.test(opts.storeId)) {
    return { ...report, ok: false, error: "storeId inválido" };
  }

  let query = admin.from("stores").select(WOO_STORE_COLUMNS).eq("status", "active").not("woo_site_url", "is", null);
  if (opts.storeId) query = query.eq("id", opts.storeId);
  let rows: Record<string, unknown>[];
  try {
    const { data, error } = await query;
    if (error) {
      if (isWooMigrationMissing(error)) return { ...report, skipped: "sin_migracion" };
      return { ...report, ok: false, error: "No se pudieron leer las tiendas." };
    }
    rows = (data ?? []) as Record<string, unknown>[];
  } catch {
    return { ...report, ok: false, error: "No se pudieron leer las tiendas." };
  }

  report.stores = await Promise.all(
    rows.map(async (row): Promise<WooWebhooksStoreReport> => {
      const creds = wooCredsFromRow(row);
      if (!hasWooApiCredentials(creds)) return { storeId: creds.id, status: "skipped" };
      const client = wooClientOpts(creds, opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {});
      const check = await checkWooWebhooks(client, creds.id, opts);
      if (!dry) await recordWooWebhooksCheck(admin, creds.id, check, creds.lastError);
      return { storeId: creds.id, status: check.status, topics: check.topics, errorKind: check.errorKind, webhooks: check.webhooks };
    }),
  );
  report.ok = report.stores.every((s) => s.status === "ok" || s.status === "skipped");
  return report;
}
