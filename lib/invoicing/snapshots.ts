// La foto del pedido para su boleta (MOM §35.10, owner 23-10-2026).
//
// POR QUÉ. Shopify cierra Kenku Perú y Aurela el 28-10-2026, y cada boleta
// vuelve a leer su pedido en Shopify justo antes de emitir (§35.3). Los pedidos
// vendidos en Shopify se siguen cobrando después del cierre: sin una copia de lo
// que esa lectura devuelve, no tendrían boleta nunca. Este barrido la toma
// mientras Shopify responde y la guarda en `order_invoice_snapshots` (0274);
// `fetchOrderForInvoice` la usa solo cuando la tienda ya no tiene token o
// Shopify contesta por ella que ya no está.
//
// QUÉ PIDE. Exactamente ORDER_FOR_INVOICE_QUERY, con la misma llamada que la
// boleta (`requestOrderForInvoice`): la foto es lo que la boleta habría leído.
// Nada de la clienta: la consulta no lo pide.
//
// CUÁNTO. Las tiendas de las organizaciones que facturan en Kapta (con un RUC
// dado de alta, §35.2) y activas; las tiendas cliente facturan fuera (§29.15) y
// su Shopify no se toca. Por tienda, un pedido a la vez, a lo más
// `INVOICE_SNAPSHOT_MAX_PER_STORE` por pasada y nada nuevo pasados
// `INVOICE_SNAPSHOT_BUDGET_MS`; dos tiendas a la vez como mucho (cada tienda
// tiene su propio cupo en Shopify). Cada pedido pide a Shopify mucho cupo por
// adelantado y devuelve casi todo: antes de cada llamada se espera a que la
// tienda tenga ese cupo más una reserva (`INVOICE_SNAPSHOT_RESERVE`), para que
// el sync, los webhooks y «Generar pedido» nunca se queden sin él. Si Shopify
// contesta THROTTLED, la tienda para hasta la próxima pasada.
//
// IDEMPOTENTE. La base elige qué falta (`invoice_snapshot_candidates`) y guarda
// (`invoice_snapshot_put`) solo un pedido de Shopify de esa tienda y nunca una
// foto más vieja sobre una más nueva. Un pedido que cambió en Shopify después
// de su foto vuelve a entrar. Cualquier falla de Shopify corta la tienda en esa
// pasada y lo que faltó entra en la siguiente.

import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminSupabase } from "@/lib/db";
import { isShopifyShopGone, shopifyFailureDetail, type ShopifyQueryCost } from "@/lib/shopify";
import {
  requestOrderForInvoice,
  shopifyConnOf,
  shopifyOrderGidOf,
  type ShopifyConn,
} from "@/lib/invoicing/shopify-order";

// ── Constantes ───────────────────────────────────────────────────────────────

/** El cierre de Shopify para Kenku Perú y Aurela (00:00 UTC = 27-10, 19:00 de Lima). */
export const SHOPIFY_SHUTDOWN_AT = "2026-10-28T00:00:00.000Z";

/**
 * Desde cuándo hace falta la foto: el cierre menos los 60 días que mira el
 * barrido de boletas (`invoice_candidates`, 0260: `order_created_at >= now() -
 * interval '60 days'`). Un pedido más viejo no vuelve a entrar al barrido
 * después del cierre.
 */
export const INVOICE_SNAPSHOT_SINCE = "2026-08-29T00:00:00.000Z";

/** Pedidos por tienda en una pasada, como mucho. */
export const INVOICE_SNAPSHOT_MAX_PER_STORE = 100;

/**
 * Pasado esto no se empieza otro pedido (la función tiene 60 s). Una lectura
 * cuesta hasta 15 s: la pasada termina antes de 40 s.
 */
export const INVOICE_SNAPSHOT_BUDGET_MS = 20_000;

/** Tiendas a la vez. Cada una tiene su propio cupo en Shopify. */
export const INVOICE_SNAPSHOT_PARALLEL_STORES = 2;

/** La parte del cupo de la tienda que la foto nunca usa: queda para el sync y las asesoras. */
export const INVOICE_SNAPSHOT_RESERVE = 0.25;

// ── Tipos ────────────────────────────────────────────────────────────────────

/** Por qué una tienda dejó de pedir fotos en esta pasada. */
export type SnapshotStop =
  /** Se acabó el tiempo de la pasada. */
  | "presupuesto"
  /** Shopify no tenía cupo para otro pedido, o contestó THROTTLED. */
  | "cuota"
  /** La tienda no tiene token de Shopify: no hay a quién preguntar. */
  | "sin_shopify"
  /** Shopify contestó por la tienda que ya no está (401, 402, 403, 404, 423). */
  | "tienda_caida"
  /** Otra falla de Shopify (red, 5xx, tiempo, una respuesta que no se entiende). */
  | "shopify"
  /** No se pudo leer o escribir en la base. */
  | "base";

export interface InvoiceSnapshotStoreReport {
  storeId: string;
  /** Los que la base dio para mirar (a lo más `INVOICE_SNAPSHOT_MAX_PER_STORE`). */
  candidates: number;
  /** Fotos nuevas. */
  saved: number;
  /** Fotos vueltas a tomar porque el pedido cambió en Shopify. */
  refreshed: number;
  /** De las anteriores, cuántas dicen que Shopify no devolvió el pedido. */
  notFound: number;
  /** Lo que la base no guardó: ya había una foto más nueva o el pedido dejó de ser de Shopify. */
  skipped: number;
  /** Lo que quedó para la próxima pasada. */
  pending: number;
  stopped: SnapshotStop | null;
  /** Por qué falló Shopify, en corto y sin nada de la respuesta. */
  detail?: string;
}

export interface InvoiceSnapshotReport {
  dry: boolean;
  at: string;
  since: string;
  stores: InvoiceSnapshotStoreReport[];
  /** Fallas de la base. Si hay alguna, el cron se ve rojo. */
  errors: string[];
}

export interface InvoiceSnapshotDeps {
  /** Milisegundos, como `Date.now()`. */
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** La conexión de la tienda con Shopify, o null si no tiene. Lanza si no se pudo leer. */
  conn: (storeId: string) => Promise<ShopifyConn | null>;
  fetchImpl?: typeof fetch;
}

export function defaultInvoiceSnapshotDeps(admin: SupabaseClient): InvoiceSnapshotDeps {
  return {
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    conn: (storeId) => shopifyConnOf(admin, storeId),
  };
}

// ── Sin la 0274 ──────────────────────────────────────────────────────────────

/** Lo que crea la 0274. */
const SNAPSHOT_OBJECTS = /\b(?:order_invoice_snapshots|invoice_snapshot_candidates|invoice_snapshot_put)\b/;

/** «No existe» de Postgres (42P01, 42883) y de PostgREST (PGRST205, PGRST202). */
const MISSING_CODES: ReadonlySet<string> = new Set(["42P01", "42883", "PGRST205", "PGRST202"]);

/** Falta aplicar la 0274: el código puede llegar a producción antes que la base. */
export class InvoiceSnapshotMigrationMissingError extends Error {
  constructor() {
    super("Falta aplicar la migración 0274 (fotos de pedidos para boletas).");
    this.name = "InvoiceSnapshotMigrationMissingError";
  }
}

/** ¿El error dice que no existe algo de la 0274? Otra tabla que falta es una base rota. */
export function isInvoiceSnapshotMigrationMissing(error: unknown): boolean {
  if (error instanceof InvoiceSnapshotMigrationMissingError) return true;
  if (!error || typeof error !== "object") return false;
  const e = error as { code?: unknown; message?: unknown; details?: unknown; hint?: unknown };
  if (typeof e.code !== "string" || !MISSING_CODES.has(e.code)) return false;
  return [e.message, e.details, e.hint].some((t) => typeof t === "string" && SNAPSHOT_OBJECTS.test(t));
}

/** Un error de la base, sin repetir sus valores: solo su código. */
function dbFailure(what: string, error: { code?: unknown } | null | undefined): string {
  const code = typeof error?.code === "string" && /^[A-Z0-9]{2,10}$/.test(error.code) ? ` (${error.code})` : "";
  return `No se pudo ${what}${code}.`;
}

// ── El cupo de la tienda en Shopify ──────────────────────────────────────────

export interface ShopifyQuotaBucket {
  requested: number;
  available: number;
  max: number;
  restore: number;
  at: number;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Lo que dijo Shopify del cupo, o null si no se entiende. */
function bucketOf(cost: ShopifyQueryCost, at: number, previous: ShopifyQuotaBucket | null): ShopifyQuotaBucket | null {
  const t = cost.throttleStatus;
  const available = finiteNumber(t?.currentlyAvailable);
  const max = finiteNumber(t?.maximumAvailable);
  const restore = finiteNumber(t?.restoreRate);
  if (available === null || max === null || restore === null || max <= 0) return previous;
  const requested = finiteNumber(cost.requestedQueryCost) ?? previous?.requested ?? 0;
  return { requested, available, max, restore, at };
}

/**
 * Cuánto esperar antes de la próxima llamada para que la tienda tenga el cupo
 * que pide la consulta más la reserva. 0 si ya lo tiene o si todavía no se
 * sabe; Infinity si nunca se repone.
 */
export function snapshotWaitMs(bucket: ShopifyQuotaBucket | null, now: number): number {
  if (!bucket) return 0;
  const need = Math.min(bucket.requested + bucket.max * INVOICE_SNAPSHOT_RESERVE, bucket.max);
  const elapsed = Math.max(0, now - bucket.at) / 1000;
  const availableNow = Math.min(bucket.max, bucket.available + bucket.restore * elapsed);
  if (availableNow >= need) return 0;
  if (bucket.restore <= 0) return Number.POSITIVE_INFINITY;
  return Math.ceil(((need - availableNow) / bucket.restore) * 1000);
}

function isThrottled(e: unknown): boolean {
  const message = e instanceof Error ? e.message : String(e);
  return /THROTTLED/i.test(message);
}

// ── Una tienda ───────────────────────────────────────────────────────────────

interface Candidate {
  order_id: string;
  shopify_order_id: string;
  refresh: boolean;
}

function candidatesOf(data: unknown): Candidate[] {
  if (!Array.isArray(data)) return [];
  return data.filter(
    (c): c is Candidate =>
      !!c &&
      typeof c === "object" &&
      typeof (c as Candidate).order_id === "string" &&
      typeof (c as Candidate).shopify_order_id === "string" &&
      /^\d+$/.test((c as Candidate).shopify_order_id),
  );
}

async function runStore(
  admin: SupabaseClient,
  deps: InvoiceSnapshotDeps,
  storeId: string,
  ctx: { dry: boolean; started: number; errors: string[] },
): Promise<InvoiceSnapshotStoreReport> {
  const report: InvoiceSnapshotStoreReport = {
    storeId,
    candidates: 0,
    saved: 0,
    refreshed: 0,
    notFound: 0,
    skipped: 0,
    pending: 0,
    stopped: null,
  };

  const listed = await admin.rpc("invoice_snapshot_candidates", {
    p_store: storeId,
    p_since: INVOICE_SNAPSHOT_SINCE,
    p_limit: INVOICE_SNAPSHOT_MAX_PER_STORE,
  });
  if (listed.error) {
    if (isInvoiceSnapshotMigrationMissing(listed.error)) throw new InvoiceSnapshotMigrationMissingError();
    ctx.errors.push(dbFailure("leer los pedidos sin foto", listed.error));
    report.stopped = "base";
    return report;
  }
  const candidates = candidatesOf(listed.data);
  report.candidates = candidates.length;
  if (!candidates.length) return report;
  if (ctx.dry) {
    report.pending = candidates.length;
    return report;
  }

  let conn: ShopifyConn | null;
  try {
    conn = await deps.conn(storeId);
  } catch {
    ctx.errors.push("No se pudo leer la conexión de la tienda con Shopify.");
    report.stopped = "base";
    report.pending = candidates.length;
    return report;
  }
  if (!conn) {
    report.stopped = "sin_shopify";
    report.pending = candidates.length;
    return report;
  }

  // Lo último que dijo Shopify del cupo de esta tienda.
  const quota: { bucket: ShopifyQuotaBucket | null } = { bucket: null };
  const onCost = (cost: ShopifyQueryCost) => {
    quota.bucket = bucketOf(cost, deps.now(), quota.bucket);
  };

  for (const [i, c] of candidates.entries()) {
    const stop = (why: SnapshotStop, detail?: string) => {
      report.stopped = why;
      report.pending = candidates.length - i;
      if (detail) report.detail = detail;
    };

    if (deps.now() - ctx.started > INVOICE_SNAPSHOT_BUDGET_MS) {
      stop("presupuesto");
      break;
    }
    const wait = snapshotWaitMs(quota.bucket, deps.now());
    if (wait > 0) {
      if (deps.now() - ctx.started + wait > INVOICE_SNAPSHOT_BUDGET_MS) {
        stop("cuota");
        break;
      }
      await deps.sleep(wait);
    }

    const gid = shopifyOrderGidOf(c.shopify_order_id);
    const fetchedAt = new Date(deps.now()).toISOString();
    let data: unknown;
    try {
      data = await requestOrderForInvoice(conn, c.shopify_order_id, {
        ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
        onCost,
      });
    } catch (e) {
      if (isThrottled(e)) stop("cuota");
      else stop(isShopifyShopGone(e) ? "tienda_caida" : "shopify", shopifyFailureDetail(e));
      break;
    }

    // Lo que se guarda es la respuesta tal cual: `{ order: … }`. Sin `order`
    // es una respuesta que no entendemos; con otro pedido, tampoco se guarda.
    if (!data || typeof data !== "object" || Array.isArray(data) || !("order" in data)) {
      stop("shopify", "Shopify contestó sin el pedido.");
      break;
    }
    const order = (data as { order: unknown }).order;
    if (order !== null && (typeof order !== "object" || Array.isArray(order) || (order as { id?: unknown }).id !== gid)) {
      stop("shopify", "Shopify devolvió otro pedido.");
      break;
    }

    const put = await admin.rpc("invoice_snapshot_put", {
      p_order: c.order_id,
      p_store: storeId,
      p_gid: gid,
      p_payload: data,
      p_fetched_at: fetchedAt,
    });
    if (put.error) {
      if (isInvoiceSnapshotMigrationMissing(put.error)) throw new InvoiceSnapshotMigrationMissingError();
      ctx.errors.push(dbFailure("guardar la foto de un pedido", put.error));
      stop("base");
      break;
    }
    if (put.data !== true) {
      report.skipped += 1;
      continue;
    }
    if (c.refresh) report.refreshed += 1;
    else report.saved += 1;
    if (order === null) report.notFound += 1;
  }
  return report;
}

// ── La pasada ────────────────────────────────────────────────────────────────

/**
 * Las tiendas que facturan en Kapta: activas y de una organización con un RUC
 * dado de alta (§35.2). Con `storeId`, solo esa, si es una de ellas.
 */
async function snapshotStores(admin: SupabaseClient, storeId?: string): Promise<string[]> {
  const issuers = await admin.from("invoice_issuers").select("org_id");
  if (issuers.error) throw new Error(dbFailure("leer las empresas emisoras", issuers.error));
  const orgIds = [
    ...new Set(
      ((issuers.data ?? []) as { org_id?: unknown }[])
        .map((r) => r.org_id)
        .filter((id): id is string => typeof id === "string"),
    ),
  ];
  if (!orgIds.length) return [];
  let query = admin.from("stores").select("id").in("org_id", orgIds).eq("status", "active");
  if (storeId) query = query.eq("id", storeId);
  const stores = await query;
  if (stores.error) throw new Error(dbFailure("leer las tiendas", stores.error));
  return ((stores.data ?? []) as { id?: unknown }[])
    .map((s) => s.id)
    .filter((id): id is string => typeof id === "string")
    .sort();
}

/**
 * Una pasada: por cada tienda que factura, pide a Shopify los pedidos que le
 * faltan a su foto y los guarda. Con `dry`, solo cuenta cuántos faltan: no
 * llama a Shopify ni escribe. Lanza `InvoiceSnapshotMigrationMissingError` sin
 * la 0274.
 */
export async function runInvoiceSnapshotSweep(
  admin: SupabaseClient = createAdminSupabase(),
  opts: { dry?: boolean; storeId?: string } = {},
  deps: InvoiceSnapshotDeps = defaultInvoiceSnapshotDeps(admin),
): Promise<InvoiceSnapshotReport> {
  const dry = opts.dry === true;
  const started = deps.now();
  const report: InvoiceSnapshotReport = {
    dry,
    at: new Date(started).toISOString(),
    since: INVOICE_SNAPSHOT_SINCE,
    stores: [],
    errors: [],
  };

  let storeIds: string[];
  try {
    storeIds = await snapshotStores(admin, opts.storeId);
  } catch (e) {
    report.errors.push(e instanceof Error ? e.message : "No se pudieron leer las tiendas.");
    return report;
  }

  const queue = [...storeIds];
  const ctx = { dry, started, errors: report.errors };
  // Lo que lanza una tienda (sin la 0274) para la cola, pero se espera a la
  // otra: ninguna sigue llamando a Shopify después de que la ruta contestó.
  let thrown: unknown = null;
  const workers = Array.from({ length: Math.min(INVOICE_SNAPSHOT_PARALLEL_STORES, queue.length) }, async () => {
    for (let id = queue.shift(); id !== undefined && thrown === null; id = queue.shift()) {
      try {
        report.stores.push(await runStore(admin, deps, id, ctx));
      } catch (e) {
        thrown = e;
      }
    }
  });
  await Promise.all(workers);
  if (thrown !== null) throw thrown;
  report.stores.sort((a, b) => (a.storeId < b.storeId ? -1 : a.storeId > b.storeId ? 1 : 0));
  return report;
}
