// La foto del pedido para su boleta (MOM §35.10, owner 23-10-2026).
//
// POR QUÉ. Shopify cierra Kenku Perú y Aurela el 28-10-2026, y cada boleta
// vuelve a leer su pedido en Shopify justo antes de emitir (§35.3). Los pedidos
// vendidos en Shopify se siguen cobrando después del cierre: sin una copia de lo
// que esa lectura devuelve, no tendrían boleta nunca. Este barrido la toma
// mientras Shopify responde y la guarda en `order_invoice_snapshots` (0275);
// `fetchOrderForInvoice` la usa solo cuando la tienda ya no tiene token o, desde
// el cierre, Shopify contesta por ella que ya no está.
//
// QUÉ PIDE. Los MISMOS campos de ORDER_FOR_INVOICE_QUERY, de varios pedidos por
// llamada (`nodes(ids: …)`, `ORDERS_FOR_INVOICE_BATCH_QUERY`), con páginas más
// cortas de líneas, cobros y envíos para que la consulta quepa en el tope de
// costo de Shopify. Un pedido que llenó alguna de esas páginas (puede tener más)
// o que no volvió se pide solo, con la llamada exacta de la boleta
// (`requestOrderForInvoice`). Así lo guardado es siempre, campo por campo, lo
// que la boleta habría leído. Nada de la clienta: la consulta no lo pide.
//
// CUÁNTO. Las tiendas de las organizaciones que facturan en Kapta (con un RUC
// dado de alta, §35.2) y activas, las dos a la vez (cada tienda tiene su propio
// cupo en Shopify); las tiendas cliente facturan fuera (§29.15) y su Shopify no
// se toca. El cron corre cada 2 minutos (en los impares, `1-59/2`, lejos del
// barrido de boletas) y cada pasada trabaja hasta `INVOICE_SNAPSHOT_BUDGET_MS`
// (la ruta tiene 120 s); un turno por tienda en la base
// (`invoice_snapshot_lease`) impide dos pasadas a la vez sobre la misma tienda.
//
// EL CUPO DE LA TIENDA. Shopify cobra por adelantado lo que pide la consulta y
// devuelve lo que no usó. Antes de cada llamada se espera a que la tienda tenga
// ese costo más una reserva (`snapshotReservePoints`): un cuarto del balde
// (`INVOICE_SNAPSHOT_RESERVE`) y nunca menos que lo que pide la lectura de una
// boleta (`INVOICE_READ_POINTS`), y el lote se arma para que eso quepa; y la
// foto gasta, en promedio, a lo más el 75 % de lo que el balde se repone por
// segundo. Una boleta que se lee mientras corre la foto (el barrido o «Emitir
// esta boleta»), el sync, los webhooks y «Generar pedido» tienen siempre esa
// reserva y un cuarto de la reposición. Si Shopify contesta THROTTLED, la
// tienda para hasta la próxima pasada.
//
// UNA FALLA NO TAPA LA COLA. Lo que es de la tienda (THROTTLED, la tienda que ya
// no está, un 5xx, la red, un tiempo agotado sin nada bueno antes) la para. Lo
// que es de un pedido (un error de GraphQL, una respuesta sin el pedido o con
// otro, un tiempo agotado después de otros buenos) se anota en
// `invoice_snapshot_attempts` y la pasada sigue con el siguiente: el que falla
// va detrás de los que nunca fallaron y se reintenta más espaciado. Si la
// tienda para por Shopify, o un pedido falla `INVOICE_SNAPSHOT_ALERT_FAILS`
// veces seguidas, la ruta contesta 502 (el cron se ve rojo).
//
// IDEMPOTENTE. La base elige qué falta (`invoice_snapshot_candidates`) y guarda
// (`invoice_snapshot_put`) solo un pedido de Shopify de esa tienda, nunca una
// foto más vieja sobre una más nueva y nunca `{order: null}` sobre una foto con
// el pedido: una foto buena no se pierde porque una lectura posterior no lo
// trajo (se conserva, cuenta en `kept` y el pedido se reintenta más espaciado,
// sin poner el cron en rojo). Un pedido que cambió en Shopify después de su
// foto vuelve a entrar.
//
// EL RITMO, EN EL LOG. Cada pasada dice cuántas fotos guardó (`orders`), a qué
// ritmo (`perMinute`) y, por tienda, las llamadas, el tamaño del último lote,
// los puntos que pidió y gastó (`points`) y el balde que informó Shopify
// (`quota`).

import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminSupabase } from "@/lib/db";
import {
  isShopifyShopGone,
  shopifyFailureDetail,
  shopifyGraphQL,
  shopifyHttpStatusOf,
  type ShopifyQueryCost,
} from "@/lib/shopify";
import {
  ORDER_FOR_INVOICE_QUERY,
  SHOPIFY_READ_TIMEOUT_MS,
  requestOrderForInvoice,
  shopifyConnOf,
  shopifyOrderGidOf,
  type ShopifyConn,
} from "@/lib/invoicing/shopify-order";
import { SHOPIFY_SHUTDOWN_AT } from "@/lib/invoicing/shopify-cutoff";

export { SHOPIFY_SHUTDOWN_AT };

// ── Constantes ───────────────────────────────────────────────────────────────

/**
 * Desde cuándo hace falta la foto: el cierre menos los 60 días que mira el
 * barrido de boletas (`invoice_candidates`, 0260: `order_created_at >= now() -
 * interval '60 days'`). Un pedido más viejo no vuelve a entrar al barrido
 * después del cierre.
 */
export const INVOICE_SNAPSHOT_SINCE = "2026-08-29T00:00:00.000Z";

/** Pedidos por tienda que la base da en una pasada, como mucho. */
export const INVOICE_SNAPSHOT_MAX_PER_STORE = 600;

/** El `maxDuration` de la ruta (app/api/cron/invoice-snapshots/route.ts), en segundos. */
export const INVOICE_SNAPSHOT_MAX_DURATION_S = 120;

/**
 * Pasado esto no se empieza otra llamada a Shopify. Una llamada corta a los
 * 15 s (`SHOPIFY_READ_TIMEOUT_MS`) y guardar un lote toma menos de 2 s: la
 * pasada termina antes de ~112 s, dentro de los 120 s de la ruta y antes de que
 * el cron vuelva a correr (cada 2 minutos).
 */
export const INVOICE_SNAPSHOT_BUDGET_MS = 95_000;

/** Lo que dura el turno de una tienda si la pasada muere sin soltarlo. */
export const INVOICE_SNAPSHOT_LEASE_S = INVOICE_SNAPSHOT_MAX_DURATION_S + 5;

/** Tiendas a la vez. Cada una tiene su propio cupo en Shopify. */
export const INVOICE_SNAPSHOT_PARALLEL_STORES = 2;

/**
 * La parte del cupo de la tienda que la foto nunca usa: del balde (lo que queda
 * después de cobrar por adelantado la consulta) y de la reposición por segundo.
 */
export const INVOICE_SNAPSHOT_RESERVE = 0.25;

/**
 * Lo que pide la lectura de UNA boleta (`ORDER_FOR_INVOICE_QUERY`: 100 líneas,
 * 20 cobros, 10 envíos), unos 810 puntos, con margen. Con un balde de 1000 un
 * cuarto (250) no la deja entrar mientras la foto tiene su lote cobrado: la
 * boleta quedaba en `lectura_fallida` hasta la próxima pasada.
 */
export const INVOICE_READ_POINTS = 850;

/**
 * Los puntos del balde que la foto nunca usa: un cuarto, y nunca menos que una
 * boleta (sin pasar del balde). Balde de 1000: 850 (lotes de un pedido; el ritmo
 * lo sigue poniendo la reposición); de 2000: 850; de 4000 o más: un cuarto.
 */
export function snapshotReservePoints(max: number): number {
  return Math.min(max, Math.max(max * INVOICE_SNAPSHOT_RESERVE, INVOICE_READ_POINTS));
}

/** El tope de costo de UNA consulta en la Admin API de Shopify. */
export const SHOPIFY_MAX_QUERY_COST = 1000;

/** Pedidos por llamada, como mucho (aunque el costo diera para más). */
export const INVOICE_SNAPSHOT_MAX_BATCH = 25;

/**
 * Lo que se supone que pide cada pedido del lote si Shopify no dice lo que de
 * verdad pide (`requestedQueryCost` / pedidos). Por lo alto: con un balde de
 * 2000 da lotes de 6. La primera llamada de cada pasada lleva un solo pedido
 * para saberlo.
 */
export const INVOICE_SNAPSHOT_ORDER_COST_GUESS = 160;

/**
 * Las páginas del lote. La boleta pide 100 líneas, 20 cobros y 10 envíos por
 * pedido; en el lote se piden menos (los pedidos de Kenku y Aurela desde el
 * 29-08 tienen a lo más 7 líneas y 1 envío). Un pedido que llena alguna se
 * vuelve a pedir solo, con la consulta de la boleta.
 */
export const INVOICE_SNAPSHOT_BATCH_PAGES = { lineItems: 10, transactions: 10, shippingLines: 5 } as const;

/** Fallas seguidas de un mismo pedido que ponen el cron en rojo. */
export const INVOICE_SNAPSHOT_ALERT_FAILS = 3;

/** Pedidos seguidos que fallan solos antes de dar la tienda por caída en esta pasada. */
export const INVOICE_SNAPSHOT_MAX_CONSECUTIVE_FAILS = 5;

/**
 * El `p_alert` de una anotación que nunca pone el cron en rojo (el tope de un
 * `integer` de Postgres): una foto buena que se conservó no es una falla.
 */
const NO_ALERT = 2_147_483_647;

/** Lo que se anota cuando Shopify ya no devolvió un pedido que tiene foto buena. */
export const INVOICE_SNAPSHOT_KEPT_DETAIL = "Shopify no devolvió el pedido; se conserva su foto anterior.";

// ── La consulta del lote ─────────────────────────────────────────────────────

/** La selección de `order(id: $id) { … }` de ORDER_FOR_INVOICE_QUERY, tal cual. */
export function orderForInvoiceSelection(query: string = ORDER_FOR_INVOICE_QUERY): string {
  const head = "order(id: $id) {";
  const start = query.indexOf(head);
  if (start < 0) throw new Error("ORDER_FOR_INVOICE_QUERY sin `order(id: $id) {`");
  let depth = 0;
  for (let i = start + head.length - 1; i < query.length; i++) {
    if (query[i] === "{") depth++;
    else if (query[i] === "}") {
      depth--;
      if (depth === 0) return query.slice(start + head.length, i);
    }
  }
  throw new Error("ORDER_FOR_INVOICE_QUERY con llaves sin cerrar");
}

/** Cambia el `first:` de un campo de la selección; tiene que estar una sola vez. */
function withFirst(selection: string, field: string, first: number): string {
  const re = new RegExp(`\\b${field}\\(first: \\d+`, "g");
  const found = selection.match(re) ?? [];
  if (found.length !== 1) throw new Error(`ORDER_FOR_INVOICE_QUERY: ${field}(first: …) aparece ${found.length} veces`);
  return selection.replace(re, `${field}(first: ${first}`);
}

/** La selección de la boleta con las páginas del lote. Mismos campos, mismo orden. */
export function batchSelection(selection: string = orderForInvoiceSelection()): string {
  let s = selection;
  s = withFirst(s, "transactions", INVOICE_SNAPSHOT_BATCH_PAGES.transactions);
  s = withFirst(s, "lineItems", INVOICE_SNAPSHOT_BATCH_PAGES.lineItems);
  s = withFirst(s, "shippingLines", INVOICE_SNAPSHOT_BATCH_PAGES.shippingLines);
  return s;
}

/** Varios pedidos por llamada, con los campos de ORDER_FOR_INVOICE_QUERY. */
export const ORDERS_FOR_INVOICE_BATCH_QUERY = /* GraphQL */ `
  query OrdersForInvoice($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on Order {${batchSelection()}}
    }
  }
`;

function isObj(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * ¿El nodo del lote es completo, o sea, igual a lo que contestaría
 * ORDER_FOR_INVOICE_QUERY? Lo es si ninguna de las páginas cortas se llenó:
 * menos de 10 cobros y de 5 envíos, y las líneas sin página siguiente. Si no se
 * entiende, tampoco: se pide solo.
 */
export function isCompleteBatchNode(node: unknown): boolean {
  if (!isObj(node)) return false;
  const lines = node.lineItems;
  if (!isObj(lines) || !isObj(lines.pageInfo) || lines.pageInfo.hasNextPage !== false) return false;
  if (!Array.isArray(lines.nodes) || lines.nodes.length > INVOICE_SNAPSHOT_BATCH_PAGES.lineItems) return false;
  if (!Array.isArray(node.transactions) || node.transactions.length >= INVOICE_SNAPSHOT_BATCH_PAGES.transactions) return false;
  const shipping = node.shippingLines;
  if (!isObj(shipping) || !Array.isArray(shipping.nodes)) return false;
  return shipping.nodes.length < INVOICE_SNAPSHOT_BATCH_PAGES.shippingLines;
}

async function requestOrdersForInvoiceBatch(
  conn: ShopifyConn,
  numericIds: string[],
  deps: { fetchImpl?: typeof fetch; onCost: (cost: ShopifyQueryCost) => void },
): Promise<unknown> {
  const baseFetch = deps.fetchImpl ?? fetch;
  return shopifyGraphQL<unknown>({
    domain: conn.domain,
    token: conn.token,
    fetchImpl: (url, init) => baseFetch(url, { ...init, signal: AbortSignal.timeout(SHOPIFY_READ_TIMEOUT_MS) }),
    query: ORDERS_FOR_INVOICE_BATCH_QUERY,
    variables: { ids: numericIds.map(shopifyOrderGidOf) },
    onCost: deps.onCost,
  });
}

// ── Tipos ────────────────────────────────────────────────────────────────────

/** Por qué una tienda dejó de pedir fotos en esta pasada. */
export type SnapshotStop =
  /** Se acabó el tiempo de la pasada. */
  | "presupuesto"
  /** Shopify no tenía cupo para otra llamada, o contestó THROTTLED. */
  | "cuota"
  /** La tienda no tiene token de Shopify: no hay a quién preguntar. */
  | "sin_shopify"
  /** Shopify contestó por la tienda que ya no está (401, 402, 403, 404, 423). */
  | "tienda_caida"
  /** Otra falla de Shopify (red, 5xx, tiempo, una respuesta que no se entiende). */
  | "shopify"
  /** Otra pasada tiene el turno de la tienda. */
  | "ocupada"
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
  /**
   * Lo que la base no guardó: ya había una foto más nueva, el pedido dejó de
   * ser de Shopify, o la que había trae el pedido y la nueva no (`kept`).
   */
  skipped: number;
  /**
   * De las anteriores, fotos con el pedido que se conservaron porque Shopify,
   * al volver a leerlo, no lo devolvió (`{order: null}` no pisa una buena).
   */
  kept: number;
  /** Pedidos que fallaron solos: quedan anotados y se reintentan más tarde. */
  failed: number;
  /** Lo que quedó para la próxima pasada. */
  pending: number;
  stopped: SnapshotStop | null;
  /** Por qué falló Shopify, en corto y sin nada de la respuesta. */
  detail?: string;
  /** Llamadas a Shopify. */
  calls: number;
  /** Pedidos por llamada en el último lote. */
  batch: number;
  /**
   * Puntos del cupo de Shopify en esta pasada: los que pidieron las llamadas
   * (`requestedQueryCost`, se cobran por adelantado) y los que de verdad
   * gastaron (`actualQueryCost`; THROTTLED no gasta).
   */
  points: { requested: number; actual: number };
  /** Lo que tardó la tienda en esta pasada. */
  ms: number;
  /** Lo último que dijo Shopify del cupo de la tienda (puntos y puntos por segundo). */
  quota?: { max: number; restore: number; available: number };
}

export interface InvoiceSnapshotReport {
  dry: boolean;
  at: string;
  since: string;
  /** Lo que tardó la pasada. */
  ms: number;
  /** Fotos guardadas en esta pasada (nuevas y vueltas a tomar), entre todas las tiendas. */
  orders: number;
  /** El ritmo de esta pasada: `orders` por minuto. */
  perMinute: number;
  stores: InvoiceSnapshotStoreReport[];
  /** Fallas de la base, de Shopify o de pedidos que no salen. Si hay alguna, el cron se ve rojo. */
  errors: string[];
}

export interface InvoiceSnapshotDeps {
  /** Milisegundos, como `Date.now()`. */
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** La conexión de la tienda con Shopify, o null si no tiene. Lanza si no se pudo leer. */
  conn: (storeId: string) => Promise<ShopifyConn | null>;
  fetchImpl?: typeof fetch;
  /** Quién pide el turno de la tienda; por defecto un uuid nuevo por pasada. */
  holder?: () => string;
}

export function defaultInvoiceSnapshotDeps(admin: SupabaseClient): InvoiceSnapshotDeps {
  return {
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    conn: (storeId) => shopifyConnOf(admin, storeId),
  };
}

// ── Sin la 0275 ──────────────────────────────────────────────────────────────

/** Lo que crea la 0275. */
const SNAPSHOT_OBJECTS =
  /\b(?:order_invoice_snapshots|invoice_snapshot_candidates|invoice_snapshot_put|invoice_snapshot_attempts|invoice_snapshot_failed|invoice_snapshot_leases|invoice_snapshot_lease|invoice_snapshot_release)\b/;

/** «No existe» de Postgres (42P01, 42883) y de PostgREST (PGRST205, PGRST202). */
const MISSING_CODES: ReadonlySet<string> = new Set(["42P01", "42883", "PGRST205", "PGRST202"]);

/** Falta aplicar la 0275: el código puede llegar a producción antes que la base. */
export class InvoiceSnapshotMigrationMissingError extends Error {
  constructor() {
    super("Falta aplicar la migración 0275 (fotos de pedidos para boletas).");
    this.name = "InvoiceSnapshotMigrationMissingError";
  }
}

/** ¿El error dice que no existe algo de la 0275? Otra tabla que falta es una base rota. */
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
  available: number;
  max: number;
  restore: number;
  at: number;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Lo que dijo Shopify del cupo, o lo de antes si no se entiende. */
function bucketOf(cost: ShopifyQueryCost, at: number, previous: ShopifyQuotaBucket | null): ShopifyQuotaBucket | null {
  const t = cost.throttleStatus;
  const available = finiteNumber(t?.currentlyAvailable);
  const max = finiteNumber(t?.maximumAvailable);
  const restore = finiteNumber(t?.restoreRate);
  if (available === null || max === null || restore === null || max <= 0) return previous;
  return { available, max, restore, at };
}

/**
 * Cuánto esperar antes de una llamada que pide `requested` puntos para que la
 * tienda tenga ese costo más la reserva. 0 si ya lo tiene o si todavía no se
 * sabe; Infinity si nunca se repone.
 */
export function snapshotWaitMs(bucket: ShopifyQuotaBucket | null, now: number, requested: number): number {
  if (!bucket) return 0;
  const need = Math.min(requested + snapshotReservePoints(bucket.max), bucket.max);
  const elapsed = Math.max(0, now - bucket.at) / 1000;
  const availableNow = Math.min(bucket.max, bucket.available + bucket.restore * elapsed);
  if (availableNow >= need) return 0;
  if (bucket.restore <= 0) return Number.POSITIVE_INFINITY;
  return Math.ceil(((need - availableNow) / bucket.restore) * 1000);
}

/**
 * Pedidos por llamada: los que caben en el tope de costo de una consulta y en
 * el balde menos la reserva, con lo que se sabe que pide cada uno; entre 1 y
 * `cap` (y nunca más de los que quedan).
 */
export function snapshotBatchSize(
  bucket: Pick<ShopifyQuotaBucket, "max"> | null,
  perOrder: number,
  cap: number,
  remaining: number,
  maxQueryCost: number = SHOPIFY_MAX_QUERY_COST,
): number {
  // Si Shopify no informó el balde no se espera nada (`snapshotWaitMs`) y el
  // lote se arma como para uno de 1000 con un cuarto de reserva.
  const max = bucket?.max ?? SHOPIFY_MAX_QUERY_COST;
  const reserve = bucket ? snapshotReservePoints(max) : max * INVOICE_SNAPSHOT_RESERVE;
  const limit = Math.min(maxQueryCost, max - reserve);
  const fits = Math.floor(limit / Math.max(1, perOrder));
  return Math.max(1, Math.min(fits, cap, remaining));
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function isThrottled(e: unknown): boolean {
  return /THROTTLED/i.test(errorText(e));
}

/** «Query cost is 1500, which exceeds the single query max cost limit (1000)». */
function maxCostExceeded(e: unknown): { cost: number | null; max: number | null } | null {
  const text = errorText(e);
  if (!/MAX_COST_EXCEEDED|exceeds the single query max cost/i.test(text)) return null;
  const cost = /Query cost is (\d+)/i.exec(text);
  const max = /max cost limit \((\d+)\)/i.exec(text);
  return { cost: cost ? Number(cost[1]) : null, max: max ? Number(max[1]) : null };
}

/** De quién es la falla de una llamada a Shopify. */
type FailureKind = "cuota" | "costo" | "tienda_caida" | "tienda" | "tiempo" | "pedido";

function failureKind(e: unknown): FailureKind {
  if (isThrottled(e)) return "cuota";
  if (maxCostExceeded(e)) return "costo";
  if (isShopifyShopGone(e)) return "tienda_caida";
  // Un 5xx, un 429 u otro código: es la tienda o Shopify, no un pedido.
  if (shopifyHttpStatusOf(e) !== null) return "tienda";
  const name = e instanceof Error ? e.name : "";
  if (name === "TimeoutError" || name === "AbortError") return "tiempo";
  // Un error de GraphQL puede ser de un pedido (o de uno del lote).
  if (errorText(e).startsWith("Shopify GraphQL errors")) return "pedido";
  // La red, o una respuesta que no es JSON.
  return "tienda";
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

interface RunCtx {
  dry: boolean;
  started: number;
  errors: string[];
}

/** Lo que una tienda lleva aprendido de Shopify en esta pasada. */
interface StoreState {
  bucket: ShopifyQuotaBucket | null;
  /** Puntos que pide cada pedido del lote. */
  perOrder: number;
  /** Puntos que pide ORDER_FOR_INVOICE_QUERY. */
  singleCost: number;
  maxQueryCost: number;
  batchCap: number;
  /** Antes de esto no se llama (la foto gasta a lo más el 75 % de la reposición). */
  paceReadyAt: number;
  /** Alguna llamada salió bien en esta pasada. */
  succeeded: boolean;
  consecutiveFailures: number;
  /**
   * Ni un lote de UN pedido cabe en el tope de una consulta: el resto de la
   * pasada va de a uno con la consulta de la boleta, sin gastar una llamada
   * rechazada por pedido.
   */
  singlesOnly: boolean;
}

/** Una pasada sobre una tienda, con su turno ya tomado. */
class StoreRun {
  readonly report: InvoiceSnapshotStoreReport;
  private readonly state: StoreState;

  constructor(
    private readonly admin: SupabaseClient,
    private readonly deps: InvoiceSnapshotDeps,
    private readonly ctx: RunCtx,
    private readonly conn: ShopifyConn,
    report: InvoiceSnapshotStoreReport,
  ) {
    this.report = report;
    this.state = {
      bucket: null,
      perOrder: INVOICE_SNAPSHOT_ORDER_COST_GUESS,
      singleCost: SHOPIFY_MAX_QUERY_COST,
      maxQueryCost: SHOPIFY_MAX_QUERY_COST,
      batchCap: INVOICE_SNAPSHOT_MAX_BATCH,
      paceReadyAt: 0,
      succeeded: false,
      consecutiveFailures: 0,
      singlesOnly: false,
    };
  }

  private get storeId(): string {
    return this.report.storeId;
  }

  private stop(why: SnapshotStop, detail?: string): void {
    this.report.stopped = why;
    if (detail) this.report.detail = detail;
  }

  private overBudget(): boolean {
    return this.deps.now() - this.ctx.started > INVOICE_SNAPSHOT_BUDGET_MS;
  }

  /** Espera el cupo (con la reserva) y el ritmo. false si eso pasa del tiempo de la pasada. */
  private async waitTurn(requested: number): Promise<boolean> {
    const now = this.deps.now();
    const wait = Math.max(snapshotWaitMs(this.state.bucket, now, requested), this.state.paceReadyAt - now, 0);
    if (wait <= 0) return true;
    if (!Number.isFinite(wait) || now - this.ctx.started + wait > INVOICE_SNAPSHOT_BUDGET_MS) return false;
    await this.deps.sleep(wait);
    return true;
  }

  /** Una llamada a Shopify: cuenta, mide el cupo y lleva el ritmo. */
  private async call<T>(
    fn: (onCost: (cost: ShopifyQueryCost) => void) => Promise<T>,
  ): Promise<{ ok: true; value: T; requested: number | null } | { ok: false; error: unknown; requested: number | null }> {
    const box: { cost: ShopifyQueryCost | null } = { cost: null };
    const onCost = (cost: ShopifyQueryCost) => {
      box.cost = cost;
      this.state.bucket = bucketOf(cost, this.deps.now(), this.state.bucket);
    };
    const startedAt = this.deps.now();
    this.report.calls += 1;
    let result: { ok: true; value: T } | { ok: false; error: unknown };
    try {
      result = { ok: true, value: await fn(onCost) };
    } catch (error) {
      result = { ok: false, error };
    }
    const requested = finiteNumber(box.cost?.requestedQueryCost);
    // Lo que de verdad gastó (THROTTLED no gasta). El ritmo: a lo más el 75 %
    // de la reposición, en promedio.
    const spent = finiteNumber(box.cost?.actualQueryCost) ?? (result.ok ? requested : null) ?? 0;
    this.report.points.requested += requested ?? 0;
    this.report.points.actual += spent;
    const restore = this.state.bucket?.restore ?? 0;
    if (spent > 0 && restore > 0) {
      const pace = (spent / (restore * (1 - INVOICE_SNAPSHOT_RESERVE))) * 1000;
      this.state.paceReadyAt = Math.max(this.state.paceReadyAt, startedAt) + pace;
    }
    return { ...result, requested };
  }

  private async put(c: Candidate, payload: unknown, fetchedAt: string): Promise<boolean> {
    const put = await this.admin.rpc("invoice_snapshot_put", {
      p_order: c.order_id,
      p_store: this.storeId,
      p_gid: shopifyOrderGidOf(c.shopify_order_id),
      p_payload: payload,
      p_fetched_at: fetchedAt,
    });
    if (put.error) {
      if (isInvoiceSnapshotMigrationMissing(put.error)) throw new InvoiceSnapshotMigrationMissingError();
      this.ctx.errors.push(dbFailure("guardar la foto de un pedido", put.error));
      this.stop("base");
      return false;
    }
    // Una respuesta buena de un pedido corta la racha de fallas.
    this.state.consecutiveFailures = 0;
    if (put.data !== true) {
      this.report.skipped += 1;
      // Ya tenía foto y Shopify ahora no lo devolvió: la base conserva la
      // buena. Se anota (sin rojo) para que no se vuelva a pedir en cada pasada.
      if (c.refresh && isObj(payload) && payload.order === null) {
        this.report.kept += 1;
        return this.markFailed([c], INVOICE_SNAPSHOT_KEPT_DETAIL, false, false);
      }
      return true;
    }
    if (c.refresh) this.report.refreshed += 1;
    else this.report.saved += 1;
    if (isObj(payload) && payload.order === null) this.report.notFound += 1;
    return true;
  }

  /**
   * Anota que estos pedidos fallaron (van detrás en la próxima lista). Con
   * `counted`, cuentan como fallas de pedido en el reporte; sin `alert`, nunca
   * ponen el cron en rojo. false si la base no pudo.
   */
  private async markFailed(list: Candidate[], detail: string, counted: boolean, alert = true): Promise<boolean> {
    if (!list.length) return true;
    const res = await this.admin.rpc("invoice_snapshot_failed", {
      p_store: this.storeId,
      p_orders: list.map((c) => c.order_id),
      p_detail: detail.slice(0, 200),
      p_alert: alert ? INVOICE_SNAPSHOT_ALERT_FAILS : NO_ALERT,
    });
    if (res.error) {
      if (isInvoiceSnapshotMigrationMissing(res.error)) throw new InvoiceSnapshotMigrationMissingError();
      this.ctx.errors.push(dbFailure("anotar un pedido que falló", res.error));
      this.stop("base");
      return false;
    }
    if (counted) this.report.failed += list.length;
    const alerts = alert && typeof res.data === "number" && Number.isFinite(res.data) ? res.data : 0;
    if (alerts > 0) {
      this.ctx.errors.push(
        `Tienda ${this.storeId}: ${alerts} pedido${alerts === 1 ? "" : "s"} sin foto falla${alerts === 1 ? "" : "n"} desde hace ${INVOICE_SNAPSHOT_ALERT_FAILS} pasadas o más (invoice_snapshot_attempts).`,
      );
    }
    return true;
  }

  /**
   * La falla de una llamada que no es de un pedido: la tienda para. Lo que
   * estaba en vuelo se anota (sin contarlo como falla de pedido) para que la
   * próxima pasada empiece por otros: un pedido que tumba la llamada no tapa
   * la cola.
   */
  private async storeFailure(kind: FailureKind, e: unknown, inFlight: Candidate[]): Promise<void> {
    if (kind === "cuota") return this.stop("cuota");
    const detail = shopifyFailureDetail(e);
    if (kind === "tienda_caida") return this.stop("tienda_caida", detail);
    if (!(await this.markFailed(inFlight, detail, false))) return;
    this.stop("shopify", detail);
  }

  /** Un pedido que falló solo. false si la tienda tiene que parar. */
  private async orderFailure(c: Candidate, detail: string): Promise<boolean> {
    if (!(await this.markFailed([c], detail, true))) return false;
    this.state.consecutiveFailures += 1;
    if (this.state.consecutiveFailures >= INVOICE_SNAPSHOT_MAX_CONSECUTIVE_FAILS) {
      this.stop("shopify", detail);
      return false;
    }
    return true;
  }

  /** Pedidos de a uno, con la llamada exacta de la boleta. false si la tienda paró. */
  private async singles(list: Candidate[]): Promise<boolean> {
    for (const c of list) {
      if (this.overBudget()) {
        this.stop("presupuesto");
        return false;
      }
      if (!(await this.waitTurn(this.state.singleCost))) {
        this.stop("cuota");
        return false;
      }
      const gid = shopifyOrderGidOf(c.shopify_order_id);
      const fetchedAt = new Date(this.deps.now()).toISOString();
      const res = await this.call((onCost) =>
        requestOrderForInvoice(this.conn, c.shopify_order_id, {
          ...(this.deps.fetchImpl ? { fetchImpl: this.deps.fetchImpl } : {}),
          onCost,
        }),
      );
      if (res.requested !== null) this.state.singleCost = res.requested;
      if (!res.ok) {
        const kind = failureKind(res.error);
        if (kind === "cuota" || kind === "tienda_caida" || kind === "tienda" || (kind === "tiempo" && !this.state.succeeded)) {
          await this.storeFailure(kind, res.error, [c]);
          return false;
        }
        // Un error de GraphQL, un costo que no cabe o un tiempo agotado después
        // de otros buenos: es de este pedido.
        if (!(await this.orderFailure(c, shopifyFailureDetail(res.error)))) return false;
        continue;
      }
      this.state.succeeded = true;
      // Lo que se guarda es la respuesta tal cual: `{ order: … }`. Sin `order`
      // es una respuesta que no entendemos; con otro pedido, tampoco se guarda.
      const data = res.value;
      if (!isObj(data) || !("order" in data)) {
        if (!(await this.orderFailure(c, "Shopify contestó sin el pedido."))) return false;
        continue;
      }
      const order = data.order;
      if (order !== null && (!isObj(order) || order.id !== gid)) {
        if (!(await this.orderFailure(c, "Shopify devolvió otro pedido."))) return false;
        continue;
      }
      if (!(await this.put(c, data, fetchedAt))) return false;
    }
    return true;
  }

  async run(candidates: Candidate[]): Promise<void> {
    let i = 0;
    while (i < candidates.length) {
      if (this.overBudget()) return this.stop("presupuesto");
      if (this.state.singlesOnly) {
        await this.singles(candidates.slice(i));
        return;
      }
      // La primera llamada de la pasada lleva UN pedido: todavía no se sabe
      // cuánto pide cada uno ni cuánto cupo tiene la tienda, y un lote más
      // grande que lo supuesto dejaría a la tienda sin la reserva mientras
      // dura. Con lo que Shopify contesta, los lotes crecen.
      const size =
        this.report.calls === 0
          ? 1
          : snapshotBatchSize(
              this.state.bucket,
              this.state.perOrder,
              this.state.batchCap,
              candidates.length - i,
              this.state.maxQueryCost,
            );
      const batch = candidates.slice(i, i + size);
      this.report.batch = batch.length;
      if (!(await this.waitTurn(this.state.perOrder * batch.length))) return this.stop("cuota");

      const fetchedAt = new Date(this.deps.now()).toISOString();
      const res = await this.call((onCost) =>
        requestOrdersForInvoiceBatch(
          this.conn,
          batch.map((c) => c.shopify_order_id),
          { ...(this.deps.fetchImpl ? { fetchImpl: this.deps.fetchImpl } : {}), onCost },
        ),
      );
      if (res.requested !== null) this.state.perOrder = Math.max(1, res.requested / batch.length);

      if (!res.ok) {
        const kind = failureKind(res.error);
        if (kind === "costo") {
          // No cupo en el tope de una consulta: lotes más chicos, con lo que
          // Shopify dijo que costaba. No gasta cupo.
          const over = maxCostExceeded(res.error);
          if (over?.max) this.state.maxQueryCost = over.max;
          if (over?.cost) this.state.perOrder = Math.max(this.state.perOrder, over.cost / batch.length);
          this.state.batchCap = Math.max(1, Math.floor(batch.length / 2));
          if (batch.length > 1) continue;
          // Ni uno solo cabe en el lote: de a uno, con la consulta de la boleta,
          // este y los que quedan de la pasada.
          this.state.singlesOnly = true;
        } else if (kind === "cuota" || kind === "tienda_caida" || kind === "tienda" || (kind === "tiempo" && !this.state.succeeded)) {
          return this.storeFailure(kind, res.error, batch);
        }
        // Un error que puede ser de un pedido del lote: de a uno, para saber cuál.
        if (!(await this.singles(batch))) return;
        i += batch.length;
        continue;
      }

      this.state.succeeded = true;
      const nodes = isObj(res.value) ? res.value.nodes : undefined;
      const alone: Candidate[] = [];
      for (const [k, c] of batch.entries()) {
        const node = Array.isArray(nodes) && nodes.length === batch.length ? nodes[k] : undefined;
        // Completo y de este pedido: es lo que contestaría la consulta de la
        // boleta. Si no volvió (null), llenó una página o no se entiende, se
        // pide solo.
        if (isObj(node) && node.id === shopifyOrderGidOf(c.shopify_order_id) && isCompleteBatchNode(node)) {
          if (!(await this.put(c, { order: node }, fetchedAt))) return;
        } else {
          alone.push(c);
        }
      }
      if (alone.length && !(await this.singles(alone))) return;
      i += batch.length;
    }
  }

  quota(): InvoiceSnapshotStoreReport["quota"] {
    const b = this.state.bucket;
    return b ? { max: b.max, restore: b.restore, available: b.available } : undefined;
  }
}

async function runStore(
  admin: SupabaseClient,
  deps: InvoiceSnapshotDeps,
  storeId: string,
  ctx: RunCtx,
): Promise<InvoiceSnapshotStoreReport> {
  const startedAt = deps.now();
  const report: InvoiceSnapshotStoreReport = {
    storeId,
    candidates: 0,
    saved: 0,
    refreshed: 0,
    notFound: 0,
    skipped: 0,
    kept: 0,
    failed: 0,
    pending: 0,
    stopped: null,
    calls: 0,
    batch: 0,
    points: { requested: 0, actual: 0 },
    ms: 0,
  };
  const finish = (r: InvoiceSnapshotStoreReport) => {
    r.pending = Math.max(0, r.candidates - (r.saved + r.refreshed + r.skipped + r.failed));
    r.ms = Math.max(0, deps.now() - startedAt);
    return r;
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
    return finish(report);
  }
  const candidates = candidatesOf(listed.data);
  report.candidates = candidates.length;
  if (!candidates.length || ctx.dry) return finish(report);

  // El turno de la tienda: dos pasadas a la vez gastarían dos veces el cupo.
  const holder = deps.holder ? deps.holder() : randomUUID();
  const lease = await admin.rpc("invoice_snapshot_lease", {
    p_store: storeId,
    p_holder: holder,
    p_seconds: INVOICE_SNAPSHOT_LEASE_S,
  });
  if (lease.error) {
    if (isInvoiceSnapshotMigrationMissing(lease.error)) throw new InvoiceSnapshotMigrationMissingError();
    ctx.errors.push(dbFailure("tomar el turno de la tienda", lease.error));
    report.stopped = "base";
    return finish(report);
  }
  if (lease.data !== true) {
    report.stopped = "ocupada";
    return finish(report);
  }

  try {
    let conn: ShopifyConn | null;
    try {
      conn = await deps.conn(storeId);
    } catch {
      ctx.errors.push("No se pudo leer la conexión de la tienda con Shopify.");
      report.stopped = "base";
      return finish(report);
    }
    if (!conn) {
      report.stopped = "sin_shopify";
      return finish(report);
    }

    const run = new StoreRun(admin, deps, ctx, conn, report);
    await run.run(candidates);
    const quota = run.quota();
    if (quota) report.quota = quota;
    if (report.stopped === "shopify" || report.stopped === "tienda_caida") {
      ctx.errors.push(`Tienda ${storeId}: Shopify falló (${report.stopped}): ${report.detail ?? "sin detalle"}`);
    }
    return finish(report);
  } finally {
    try {
      await admin.rpc("invoice_snapshot_release", { p_store: storeId, p_holder: holder });
    } catch {
      // El turno vence solo (`INVOICE_SNAPSHOT_LEASE_S`).
    }
  }
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
 * faltan a su foto y los guarda. Con `dry`, solo cuenta cuántos faltan (hasta
 * `INVOICE_SNAPSHOT_MAX_PER_STORE`): no llama a Shopify ni escribe. Lanza
 * `InvoiceSnapshotMigrationMissingError` sin la 0275.
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
    ms: 0,
    orders: 0,
    perMinute: 0,
    stores: [],
    errors: [],
  };
  const finish = () => {
    report.ms = Math.max(0, deps.now() - started);
    report.orders = report.stores.reduce((n, s) => n + s.saved + s.refreshed, 0);
    report.perMinute = report.ms > 0 ? Math.round((report.orders / report.ms) * 60_000) : 0;
    return report;
  };

  let storeIds: string[];
  try {
    storeIds = await snapshotStores(admin, opts.storeId);
  } catch (e) {
    report.errors.push(e instanceof Error ? e.message : "No se pudieron leer las tiendas.");
    return finish();
  }

  const queue = [...storeIds];
  const ctx: RunCtx = { dry, started, errors: report.errors };
  // Lo que lanza una tienda (sin la 0275) para la cola, pero se espera a la
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
  return finish();
}
