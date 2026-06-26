// Shopify Admin API integration: webhook HMAC verification, order mapping
// (REST webhook payloads + GraphQL backfill nodes), and a small Admin GraphQL
// client used for backfill, webhook registration and shop info.

import { createHmac, timingSafeEqual } from "node:crypto";
import {
  type DraftOrderRow,
  type DraftOrderStatus,
  type OrderLineItem,
  type OrderRow,
  type ShippingMode,
  NOTE_ATTR,
  TAGS,
} from "@/lib/types";
import { normalizePhone } from "@/lib/phone";

export const SHOPIFY_DEFAULT_API_VERSION = "2025-01";

// ---------------------------------------------------------------------------
// Webhook HMAC verification
// ---------------------------------------------------------------------------

/**
 * Verify a Shopify webhook signature (header `X-Shopify-Hmac-Sha256`) against
 * the raw request body using the store's API secret. Constant-time comparison.
 */
export function verifyShopifyHmac(
  rawBody: string | Buffer,
  hmacHeader: string | null | undefined,
  secret: string | null | undefined,
): boolean {
  if (!hmacHeader || !secret) return false;
  const body = typeof rawBody === "string" ? Buffer.from(rawBody, "utf8") : rawBody;
  const digest = createHmac("sha256", secret).update(body).digest();

  let provided: Buffer;
  try {
    provided = Buffer.from(hmacHeader, "base64");
  } catch {
    return false;
  }
  if (provided.length !== digest.length) return false;
  return timingSafeEqual(provided, digest);
}

// ---------------------------------------------------------------------------
// Mapping helpers
// ---------------------------------------------------------------------------

/** Normalise tags from REST (comma string) or GraphQL (array) into string[]. */
export function parseTags(
  input: string | string[] | null | undefined,
): string[] {
  if (Array.isArray(input)) {
    return input.map((t) => String(t).trim()).filter(Boolean);
  }
  if (typeof input === "string") {
    return input.split(",").map((t) => t.trim()).filter(Boolean);
  }
  return [];
}

/**
 * Whether an order is Kapso-attributed — i.e. carries the `kapso` tag
 * (case-insensitive). Shopify fires order webhooks for the whole shop, so the
 * webhook ingestion path uses this to keep only Kapso orders, in parity with
 * the GraphQL reconciliation sync (`buildKapsoOrdersSearchQuery` → `tag:kapso`)
 * and the dashboard's documented `tag:kapso` data model (see DEPLOY.md §7).
 */
export function hasKapsoTag(tags: string[]): boolean {
  return tags.some((t) => t.toLowerCase() === TAGS.kapso);
}

/**
 * Build a lower-cased key→value map from REST `note_attributes` ({name,value})
 * or GraphQL `customAttributes` ({key,value}).
 */
export function noteAttributesToMap(
  attrs: Array<{ name?: string; key?: string; value?: unknown }> | null | undefined,
): Record<string, string> {
  const map: Record<string, string> = {};
  if (!Array.isArray(attrs)) return map;
  for (const a of attrs) {
    if (!a) continue;
    const key = a.name ?? a.key;
    if (typeof key !== "string") continue;
    map[key.toLowerCase()] = a.value == null ? "" : String(a.value);
  }
  return map;
}

/** Extract the trailing numeric id from a Shopify GID or pass numbers through. */
export function extractNumericId(
  gid: string | number | null | undefined,
): string {
  if (gid == null) return "";
  const s = String(gid);
  const m = s.match(/(\d+)\s*$/);
  return m?.[1] ?? s;
}

function toNumber(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Sum refunded money from a REST order's `refunds[].transactions[]`. */
export function sumRestRefunds(refunds: any): number {
  if (!Array.isArray(refunds)) return 0;
  let total = 0;
  for (const r of refunds) {
    const txns = r?.transactions;
    if (Array.isArray(txns)) {
      for (const t of txns) {
        if (t?.kind === "refund") total += toNumber(t?.amount) ?? 0;
      }
    }
  }
  return Math.round((total + Number.EPSILON) * 100) / 100;
}

const TRUTHY = new Set(["true", "1", "yes", "si", "sí", "y"]);

function normalizeShippingMode(value?: string | null): ShippingMode {
  if (!value) return null;
  const s = value.toLowerCase().trim();
  if (["cod", "contraentrega", "contra-entrega", "contra entrega", "cash"].includes(s)) {
    return "cod";
  }
  if (["agency", "agencia", "courier"].includes(s)) return "agency";
  return null;
}

function shippingFromTags(lowerTags: string[]): ShippingMode {
  if (lowerTags.some((t) => ["cod", "contraentrega", "contra-entrega", "contra entrega"].includes(t))) {
    return "cod";
  }
  if (lowerTags.some((t) => ["agencia", "agency"].includes(t))) return "agency";
  return null;
}

/** Derive the business-breakdown flags from tags + note attributes. */
export function deriveOrderFlags(
  tags: string[],
  attrs: Record<string, string>,
): Pick<OrderRow, "promo_applied" | "stock_por_validar" | "shipping_mode" | "kapso_conversation_id"> {
  const lower = tags.map((t) => t.toLowerCase());
  const promo_applied = lower.includes(TAGS.promo);
  const stock_por_validar =
    lower.includes(TAGS.stockPorValidar) ||
    TRUTHY.has((attrs[NOTE_ATTR.stockPorValidar] ?? "").toLowerCase());
  const shipping_mode =
    normalizeShippingMode(attrs[NOTE_ATTR.shippingMode]) ?? shippingFromTags(lower);
  const kapso_conversation_id = attrs[NOTE_ATTR.conversationId] || null;
  return { promo_applied, stock_por_validar, shipping_mode, kapso_conversation_id };
}

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Map a Shopify REST webhook order payload (orders/create|updated) → OrderRow.
 * Note: `payload` is assumed already JSON-parsed; Shopify REST order ids are
 * within the safe-integer range, so no precision is lost. (GraphQL ids arrive
 * as GID strings and are always precise.)
 */
export function mapRestOrder(payload: any, storeId: string): OrderRow {
  const tags = parseTags(payload?.tags);
  const attrs = noteAttributesToMap(payload?.note_attributes);
  const flags = deriveOrderFlags(tags, attrs);

  const line_items: OrderLineItem[] = Array.isArray(payload?.line_items)
    ? payload.line_items.map((li: any) => ({
        title: String(li?.title ?? li?.name ?? ""),
        quantity: Number(li?.quantity ?? 0),
        sku: li?.sku ?? null,
        product_id: li?.product_id != null ? String(li.product_id) : null,
        variant_id: li?.variant_id != null ? String(li.variant_id) : null,
        price: toNumber(li?.price),
      }))
    : [];

  return {
    store_id: storeId,
    shopify_order_id: extractNumericId(payload?.id),
    name: payload?.name ?? null,
    created_at: payload?.created_at ?? null,
    processed_at: payload?.processed_at ?? null,
    updated_at: payload?.updated_at ?? null,
    total_amount: toNumber(payload?.total_price ?? payload?.current_total_price),
    currency: payload?.currency ?? payload?.presentment_currency ?? null,
    financial_status: payload?.financial_status ?? null,
    cancelled_at: payload?.cancelled_at ?? null,
    total_refunded: toNumber(payload?.total_refunded) ?? sumRestRefunds(payload?.refunds),
    customer_phone: normalizePhone(
      payload?.customer?.phone ??
        payload?.phone ??
        payload?.shipping_address?.phone ??
        payload?.billing_address?.phone,
    ),
    tags,
    ...flags,
    line_items,
    raw: payload,
  };
}

/** Map a Shopify GraphQL order node (backfill/reconciliation) → OrderRow. */
export function mapGraphqlOrder(node: any, storeId: string): OrderRow {
  const tags = parseTags(node?.tags);
  const attrs = noteAttributesToMap(node?.customAttributes);
  const flags = deriveOrderFlags(tags, attrs);

  // Gross order value (before refunds) — prefer the original total set.
  const priceSet = node?.totalPriceSet ?? node?.currentTotalPriceSet;
  const liEdges: any[] = node?.lineItems?.edges ?? [];
  const line_items: OrderLineItem[] = liEdges.map((e) => {
    const n = e?.node ?? {};
    return {
      title: String(n?.title ?? ""),
      quantity: Number(n?.quantity ?? 0),
      sku: n?.sku ?? null,
      product_id: n?.product?.id ? extractNumericId(n.product.id) : null,
      variant_id: n?.variant?.id ? extractNumericId(n.variant.id) : null,
      price: toNumber(n?.originalUnitPriceSet?.shopMoney?.amount),
    };
  });

  return {
    store_id: storeId,
    shopify_order_id: extractNumericId(node?.id),
    name: node?.name ?? null,
    created_at: node?.createdAt ?? null,
    processed_at: node?.processedAt ?? null,
    updated_at: node?.updatedAt ?? null,
    total_amount: toNumber(priceSet?.shopMoney?.amount),
    currency: priceSet?.shopMoney?.currencyCode ?? null,
    financial_status: node?.displayFinancialStatus
      ? String(node.displayFinancialStatus).toLowerCase()
      : null,
    cancelled_at: node?.cancelledAt ?? null,
    total_refunded: toNumber(node?.totalRefundedSet?.shopMoney?.amount) ?? 0,
    customer_phone: normalizePhone(
      node?.phone ?? node?.shippingAddress?.phone ?? node?.billingAddress?.phone,
    ),
    tags,
    ...flags,
    line_items,
    raw: node,
  };
}

// ---------------------------------------------------------------------------
// Draft orders (Releasit COD form abandoned carts)
// ---------------------------------------------------------------------------

/** Lowercase a Shopify DraftOrderStatus (OPEN/INVOICE_SENT/COMPLETED). */
function normalizeDraftStatus(v: unknown): DraftOrderStatus {
  if (v == null) return null;
  const s = String(v).toLowerCase();
  return s === "open" || s === "invoice_sent" || s === "completed" ? s : null;
}

/** Map a Shopify GraphQL DraftOrder node → DraftOrderRow. Mirrors mapGraphqlOrder. */
export function mapGraphqlDraftOrder(node: any, storeId: string): DraftOrderRow {
  const tags = parseTags(node?.tags);
  const ship = node?.shippingAddress ?? null;
  const liEdges: any[] = node?.lineItems?.edges ?? [];
  const line_items: OrderLineItem[] = liEdges.map((e) => {
    const n = e?.node ?? {};
    return {
      title: String(n?.title ?? n?.name ?? ""),
      quantity: Number(n?.quantity ?? 0),
      sku: n?.sku ?? null,
      product_id: n?.product?.id ? extractNumericId(n.product.id) : null,
      variant_id: n?.variant?.id ? extractNumericId(n.variant.id) : null,
      price: toNumber(n?.originalUnitPriceSet?.shopMoney?.amount),
    };
  });
  const province = ship?.province ?? null;
  return {
    store_id: storeId,
    shopify_draft_order_id: extractNumericId(node?.id),
    draft_order_gid: String(node?.id ?? ""),
    name: node?.name ?? null,
    status: normalizeDraftStatus(node?.status),
    created_at: node?.createdAt ?? null,
    updated_at: node?.updatedAt ?? null,
    completed_at: node?.completedAt ?? null,
    invoice_url: node?.invoiceUrl ?? null,
    total_amount: toNumber(node?.totalPriceSet?.shopMoney?.amount),
    currency: node?.totalPriceSet?.shopMoney?.currencyCode ?? null,
    customer_phone: normalizePhone(node?.phone ?? ship?.phone),
    customer_name: node?.customer?.displayName ?? ship?.name ?? null,
    district: ship?.city ?? null,
    province,
    region: province, // Peru has no 3rd Shopify admin level; province ≈ region
    address1: ship?.address1 ?? null,
    referencia: ship?.address2 ?? null,
    tags,
    note: node?.note2 ?? null,
    line_items,
    order_gid: node?.order?.id ?? null,
    raw: node,
  };
}

/** Map a Shopify REST draft_order webhook payload → DraftOrderRow. */
export function mapRestDraftOrder(payload: any, storeId: string): DraftOrderRow {
  const tags = parseTags(payload?.tags);
  const ship = payload?.shipping_address ?? null;
  const cust = payload?.customer ?? null;
  const line_items: OrderLineItem[] = Array.isArray(payload?.line_items)
    ? payload.line_items.map((li: any) => ({
        title: String(li?.title ?? li?.name ?? ""),
        quantity: Number(li?.quantity ?? 0),
        sku: li?.sku ?? null,
        product_id: li?.product_id != null ? String(li.product_id) : null,
        variant_id: li?.variant_id != null ? String(li.variant_id) : null,
        price: toNumber(li?.price),
      }))
    : [];
  const province = ship?.province ?? null;
  const custName = cust
    ? [cust.first_name, cust.last_name].filter(Boolean).join(" ").trim() || null
    : null;
  const numericId = extractNumericId(payload?.id);
  return {
    store_id: storeId,
    shopify_draft_order_id: numericId,
    draft_order_gid:
      payload?.admin_graphql_api_id ?? (numericId ? `gid://shopify/DraftOrder/${numericId}` : ""),
    name: payload?.name ?? null,
    status: normalizeDraftStatus(payload?.status),
    created_at: payload?.created_at ?? null,
    updated_at: payload?.updated_at ?? null,
    completed_at: payload?.completed_at ?? null,
    invoice_url: payload?.invoice_url ?? null,
    total_amount: toNumber(payload?.total_price),
    currency: payload?.currency ?? null,
    customer_phone: normalizePhone(payload?.phone ?? ship?.phone ?? cust?.phone),
    customer_name: custName ?? ship?.name ?? null,
    district: ship?.city ?? null,
    province,
    region: province,
    address1: ship?.address1 ?? null,
    referencia: ship?.address2 ?? null,
    tags,
    note: payload?.note ?? null,
    line_items,
    order_gid:
      payload?.order_id != null ? `gid://shopify/Order/${extractNumericId(payload.order_id)}` : null,
    raw: payload,
  };
}

// Releasit (formerly EasySell) COD Form tags its drafts — confirmed on live Aurela
// drafts: `easysell_cod_form` + `easysell-abandoned-checkout` (plus the variant
// `abandoned_checkout_releasit_cod_form`). Matched case-insensitively as substrings
// so every variant qualifies. This marker is what tells a real abandoned COD cart
// apart from a manual quote/wholesale draft (which carries none).
const RELEASIT_DRAFT_HINTS = ["easysell", "releasit", "cod_form", "cod form"];

/**
 * Whether a draft is a Releasit/EasySell COD-form abandoned cart (vs a manual
 * quote/wholesale draft that must NOT become a call lead). Requires a Releasit
 * tag/note marker — manual/test drafts have none, so they're excluded.
 */
export function isCodFormDraft(row: DraftOrderRow): boolean {
  const hay = [...row.tags, row.note ?? ""].join(" ").toLowerCase();
  return RELEASIT_DRAFT_HINTS.some((h) => hay.includes(h));
}

// ---------------------------------------------------------------------------
// Admin GraphQL client
// ---------------------------------------------------------------------------

export interface ShopifyClientOpts {
  domain: string; // e.g. aurela.myshopify.com
  token: string; // Admin API access token (decrypted, server-only)
  apiVersion?: string;
  fetchImpl?: typeof fetch;
}

export async function shopifyGraphQL<T = any>(
  opts: ShopifyClientOpts & {
    query: string;
    variables?: Record<string, unknown>;
  },
): Promise<T> {
  const apiVersion = opts.apiVersion ?? SHOPIFY_DEFAULT_API_VERSION;
  const url = `https://${opts.domain}/admin/api/${apiVersion}/graphql.json`;
  const doFetch = opts.fetchImpl ?? fetch;

  const res = await doFetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "X-Shopify-Access-Token": opts.token,
    },
    body: JSON.stringify({ query: opts.query, variables: opts.variables ?? {} }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Shopify GraphQL HTTP ${res.status}: ${text.slice(0, 500)}`);
  }
  const json: any = await res.json();
  if (json?.errors) {
    throw new Error(
      `Shopify GraphQL errors: ${JSON.stringify(json.errors).slice(0, 500)}`,
    );
  }
  return json.data as T;
}

/** Shopify order search query for tag:kapso, optionally bounded by updated_at. */
export function buildKapsoOrdersSearchQuery(
  updatedAtCursorIso?: string | null,
): string {
  const base = `tag:${TAGS.kapso}`;
  return updatedAtCursorIso ? `${base} updated_at:>=${updatedAtCursorIso}` : base;
}

export function buildOrdersQuery(withPhone: boolean): string {
  // Order/address phone is "protected customer data" — included only on the
  // first attempt; fetchOrdersPage falls back to the no-phone query if the
  // store hasn't granted access, so the order sync never breaks.
  const phoneFields = withPhone
    ? `
          phone
          shippingAddress { phone }
          billingAddress { phone }`
    : "";
  return /* GraphQL */ `
  query KapsoOrders($first: Int!, $after: String, $query: String!) {
    orders(first: $first, after: $after, query: $query, sortKey: UPDATED_AT) {
      edges {
        cursor
        node {
          id
          name
          createdAt
          processedAt
          updatedAt
          cancelledAt
          displayFinancialStatus
          totalPriceSet { shopMoney { amount currencyCode } }
          currentTotalPriceSet { shopMoney { amount currencyCode } }
          totalRefundedSet { shopMoney { amount } }
          tags
          customAttributes { key value }${phoneFields}
          lineItems(first: 100) {
            edges {
              node {
                title
                quantity
                sku
                originalUnitPriceSet { shopMoney { amount } }
              }
            }
          }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;
}

export const ORDERS_QUERY = buildOrdersQuery(false);
const ORDERS_QUERY_WITH_PHONE = buildOrdersQuery(true);

// Per-process memo: once a store proves it can't read protected phone data,
// stop asking for it (avoids a failed+retry round-trip on every page).
let ordersPhoneSupported = true;

export interface OrdersPage {
  orders: OrderRow[];
  hasNextPage: boolean;
  endCursor: string | null;
  /** Max updated_at seen on this page (advances the reconciliation cursor). */
  maxUpdatedAt: string | null;
}

/** Fetch one page of tag:kapso orders, already mapped to OrderRow. */
export async function fetchOrdersPage(
  opts: ShopifyClientOpts & {
    storeId: string;
    searchQuery: string;
    after?: string | null;
    first?: number;
  },
): Promise<OrdersPage> {
  const variables = {
    first: opts.first ?? 100,
    after: opts.after ?? null,
    query: opts.searchQuery,
  };
  let data: any;
  try {
    data = await shopifyGraphQL<any>({
      ...opts,
      query: ordersPhoneSupported ? ORDERS_QUERY_WITH_PHONE : ORDERS_QUERY,
      variables,
    });
  } catch (e) {
    const msg = String((e as Error)?.message ?? e).toLowerCase();
    const accessIssue =
      /access denied|access_denied|protected customer|not authorized|cannot query field|doesn't exist/.test(
        msg,
      );
    if (ordersPhoneSupported && accessIssue) {
      ordersPhoneSupported = false; // degrade gracefully — keep syncing without phone
      data = await shopifyGraphQL<any>({ ...opts, query: ORDERS_QUERY, variables });
    } else {
      throw e;
    }
  }

  const edges: any[] = data?.orders?.edges ?? [];
  const orders = edges.map((e) => mapGraphqlOrder(e.node, opts.storeId));
  let maxUpdatedAt: string | null = null;
  for (const o of orders) {
    if (o.updated_at && (!maxUpdatedAt || o.updated_at > maxUpdatedAt)) {
      maxUpdatedAt = o.updated_at;
    }
  }
  return {
    orders,
    hasNextPage: Boolean(data?.orders?.pageInfo?.hasNextPage),
    endCursor: data?.orders?.pageInfo?.endCursor ?? null,
    maxUpdatedAt,
  };
}

// ---------------------------------------------------------------------------
// Draft-order fetch (read_draft_orders) + complete (write_draft_orders)
// ---------------------------------------------------------------------------

/** Only ingest carts updated within this window — keeps a backlog of dead drafts
 *  out of the queue. The draft sync re-scans this whole window every run (cheap,
 *  since it's a couple of days), which is also what promotes a cart to a lead
 *  once it ages past the grace period below. */
export const DRAFT_OPEN_WINDOW_DAYS = 2;

/** Grace period before a brand-new abandoned cart becomes a callable lead — gives
 *  the customer a few minutes to finish checkout on their own (if they do, the
 *  draft is completed and lands as won instead of a call task). Applied to
 *  OPEN/INVOICE_SENT drafts only; a completed cart is surfaced immediately. */
export const DRAFT_GRACE_MINUTES = 5;

export function buildDraftOrdersQuery(withPhone: boolean): string {
  // Draft/shipping phone is "protected customer data" — requested only on the
  // first attempt; fetchDraftOrdersPage retries without it if access is denied.
  const draftPhone = withPhone ? "\n          phone" : "";
  const shipPhone = withPhone ? " phone" : "";
  return /* GraphQL */ `
  query DraftOrders($first: Int!, $after: String, $query: String!) {
    draftOrders(first: $first, after: $after, query: $query, sortKey: UPDATED_AT) {
      edges {
        cursor
        node {
          id
          name
          status
          createdAt
          updatedAt
          completedAt
          invoiceUrl
          note2
          tags${draftPhone}
          totalPriceSet { shopMoney { amount currencyCode } }
          customer { displayName }
          shippingAddress { city province address1 address2 name${shipPhone} }
          order { id }
          lineItems(first: 100) {
            edges {
              node {
                title
                quantity
                sku
                originalUnitPriceSet { shopMoney { amount } }
              }
            }
          }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;
}

export const DRAFT_ORDERS_QUERY = buildDraftOrdersQuery(false);
const DRAFT_ORDERS_QUERY_WITH_PHONE = buildDraftOrdersQuery(true);

// Per-process memo (mirrors ordersPhoneSupported): once a store proves it can't
// read protected phone data, stop asking for it.
let draftPhoneSupported = true;

/** Search for draft orders of a given status, bounded by an updated_at cursor.
 *  The OPEN-cart 30-day floor is applied by the caller (passed in via the iso). */
export function buildDraftOrdersSearchQuery(
  status: "open" | "completed",
  updatedAtCursorIso?: string | null,
): string {
  const parts = [`status:${status}`];
  if (updatedAtCursorIso) parts.push(`updated_at:>=${updatedAtCursorIso}`);
  return parts.join(" ");
}

export interface DraftOrdersPage {
  draftOrders: DraftOrderRow[];
  hasNextPage: boolean;
  endCursor: string | null;
  /** Max updated_at on this page (advances the reconciliation cursor). */
  maxUpdatedAt: string | null;
}

/**
 * Fetch one page of draft orders, mapped to DraftOrderRow. Degrades like
 * fetchOrdersPage: drops the protected phone fields if access is denied. If the
 * whole `draftOrders` field is denied (missing read_draft_orders), this throws —
 * the caller (runStoreSync) records it and the feature stays empty, non-breaking.
 */
export async function fetchDraftOrdersPage(
  opts: ShopifyClientOpts & {
    storeId: string;
    searchQuery: string;
    after?: string | null;
    first?: number;
  },
): Promise<DraftOrdersPage> {
  const variables = {
    first: opts.first ?? 100,
    after: opts.after ?? null,
    query: opts.searchQuery,
  };
  let data: any;
  try {
    data = await shopifyGraphQL<any>({
      ...opts,
      query: draftPhoneSupported ? DRAFT_ORDERS_QUERY_WITH_PHONE : DRAFT_ORDERS_QUERY,
      variables,
    });
  } catch (e) {
    const msg = String((e as Error)?.message ?? e).toLowerCase();
    const accessIssue =
      /access denied|access_denied|protected customer|not authorized|cannot query field|doesn't exist/.test(
        msg,
      );
    if (draftPhoneSupported && accessIssue) {
      draftPhoneSupported = false; // degrade gracefully — keep syncing without phone
      data = await shopifyGraphQL<any>({ ...opts, query: DRAFT_ORDERS_QUERY, variables });
    } else {
      throw e;
    }
  }

  const edges: any[] = data?.draftOrders?.edges ?? [];
  const draftOrders = edges.map((e) => mapGraphqlDraftOrder(e.node, opts.storeId));
  let maxUpdatedAt: string | null = null;
  for (const d of draftOrders) {
    if (d.updated_at && (!maxUpdatedAt || d.updated_at > maxUpdatedAt)) {
      maxUpdatedAt = d.updated_at;
    }
  }
  return {
    draftOrders,
    hasNextPage: Boolean(data?.draftOrders?.pageInfo?.hasNextPage),
    endCursor: data?.draftOrders?.pageInfo?.endCursor ?? null,
    maxUpdatedAt,
  };
}

const DRAFT_ORDER_COMPLETE_MUTATION = /* GraphQL */ `
  mutation DraftOrderComplete($id: ID!, $paymentPending: Boolean) {
    draftOrderComplete(id: $id, paymentPending: $paymentPending) {
      draftOrder { id status order { id name } }
      userErrors { field message }
    }
  }
`;

export interface DraftOrderCompleteResult {
  orderGid: string | null;
  orderName: string | null;
  status: DraftOrderStatus;
}

/**
 * Complete a draft order in Shopify → a real order (requires write_draft_orders).
 * COD ⇒ paymentPending:true (the order is created unpaid). Throws on userErrors
 * (e.g. the draft was already completed); the caller maps that to "recovered".
 */
export async function completeDraftOrder(
  opts: ShopifyClientOpts & { draftGid: string; paymentPending?: boolean },
): Promise<DraftOrderCompleteResult> {
  const data = await shopifyGraphQL<any>({
    ...opts,
    query: DRAFT_ORDER_COMPLETE_MUTATION,
    variables: { id: opts.draftGid, paymentPending: opts.paymentPending ?? true },
  });
  const errs = data?.draftOrderComplete?.userErrors ?? [];
  if (errs.length) {
    throw new Error(`draftOrderComplete: ${errs.map((e: any) => e.message).join("; ")}`);
  }
  const draft = data?.draftOrderComplete?.draftOrder ?? null;
  return {
    orderGid: draft?.order?.id ?? null,
    orderName: draft?.order?.name ?? null,
    status: normalizeDraftStatus(draft?.status),
  };
}

// ---------------------------------------------------------------------------
// Order form: catalog search + draft create/update/read (for the unified
// "Generar pedido / Registrar pedido" flow). Requires read_products (search)
// and write_draft_orders (create/update/complete).
// ---------------------------------------------------------------------------

export interface ProductVariantResult {
  variantId: string; // gid
  title: string; // "Producto · Variante"
  price: number | null;
  inventory: number | null;
  sku: string | null;
  imageUrl: string | null;
}

const PRODUCT_SEARCH_QUERY = /* GraphQL */ `
  query SearchProducts($q: String!, $first: Int!) {
    products(first: $first, query: $q, sortKey: RELEVANCE) {
      edges {
        node {
          id
          title
          featuredImage { url }
          variants(first: 20) {
            edges { node { id title price inventoryQuantity sku } }
          }
        }
      }
    }
  }
`;

/** Search the store catalog → flat list of variants (title · price · stock). */
export async function searchProductVariants(
  opts: ShopifyClientOpts & { query: string; first?: number },
): Promise<ProductVariantResult[]> {
  const q = opts.query.trim();
  const search = q ? `${q} status:active` : "status:active";
  const data = await shopifyGraphQL<any>({
    ...opts,
    query: PRODUCT_SEARCH_QUERY,
    variables: { q: search, first: opts.first ?? 20 },
  });
  const out: ProductVariantResult[] = [];
  for (const pe of data?.products?.edges ?? []) {
    const p = pe?.node ?? {};
    const img = p?.featuredImage?.url ?? null;
    for (const ve of p?.variants?.edges ?? []) {
      const v = ve?.node ?? {};
      const vt = String(v?.title ?? "");
      out.push({
        variantId: String(v?.id ?? ""),
        title: vt && vt !== "Default Title" ? `${p.title} · ${vt}` : String(p.title ?? ""),
        price: toNumber(v?.price),
        inventory: typeof v?.inventoryQuantity === "number" ? v.inventoryQuantity : null,
        sku: v?.sku ?? null,
        imageUrl: img,
      });
    }
  }
  return out;
}

export interface OrderLineItemInput {
  variantId?: string | null; // gid (catalog item)
  title?: string | null; // custom item
  quantity: number;
  unitPrice?: number | null;
}
export interface OrderAddressInput {
  name?: string | null;
  phone?: string | null;
  address1?: string | null;
  address2?: string | null; // referencia
  city?: string | null; // distrito
  province?: string | null; // región
  country?: string | null;
}
export interface BuildDraftOrderInput {
  lineItems: OrderLineItemInput[];
  address?: OrderAddressInput | null;
  phone?: string | null;
  email?: string | null;
  note?: string | null;
  tags?: string[];
}

/** Format a phone to E.164 (+<digits>) — Shopify rejects bare local numbers with
 *  "Phone is invalid". Returns null if too short to be a real number. */
function toE164(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const digits = String(phone).replace(/[^\d]/g, "");
  return digits.length >= 8 ? `+${digits}` : null;
}

function toGqlDraftInput(input: BuildDraftOrderInput): Record<string, unknown> {
  const lineItems = input.lineItems
    .filter((li) => (li.variantId || li.title) && li.quantity > 0)
    .map((li) => {
      const item: Record<string, unknown> = { quantity: Math.max(1, Math.floor(li.quantity)) };
      if (li.variantId) item.variantId = li.variantId;
      else item.title = li.title || "Producto";
      // Preserve the exact agreed unit price. NOTE: if a future API version
      // rejects `originalUnitPrice`, switch this single line to `priceOverride`.
      if (li.unitPrice != null) item.originalUnitPrice = li.unitPrice.toFixed(2);
      return item;
    });
  const gql: Record<string, unknown> = { lineItems };
  if (input.note) gql.note = input.note;
  if (input.tags?.length) gql.tags = input.tags;
  if (input.email) gql.email = input.email;
  const e164 = toE164(input.phone);
  if (e164) gql.phone = e164;
  const a = input.address;
  if (a) {
    const parts = (a.name ?? "").trim().split(/\s+/).filter(Boolean);
    gql.shippingAddress = {
      address1: a.address1 ?? null,
      address2: a.address2 ?? null,
      city: a.city ?? null,
      province: a.province ?? null,
      country: a.country ?? "Peru",
      phone: toE164(a.phone ?? input.phone),
      firstName: parts[0] ?? (a.name ?? null),
      lastName: parts.length > 1 ? parts.slice(1).join(" ") : null,
    };
  }
  return gql;
}

const DRAFT_ORDER_CREATE_MUTATION = /* GraphQL */ `
  mutation DraftOrderCreate($input: DraftOrderInput!) {
    draftOrderCreate(input: $input) {
      draftOrder { id name }
      userErrors { field message }
    }
  }
`;
const DRAFT_ORDER_UPDATE_MUTATION = /* GraphQL */ `
  mutation DraftOrderUpdate($id: ID!, $input: DraftOrderInput!) {
    draftOrderUpdate(id: $id, input: $input) {
      draftOrder { id name }
      userErrors { field message }
    }
  }
`;

/** Create a draft order (new sale) → returns its GID; complete it separately. */
export async function createDraftOrder(
  opts: ShopifyClientOpts & { input: BuildDraftOrderInput },
): Promise<{ gid: string; name: string | null }> {
  const data = await shopifyGraphQL<any>({
    ...opts,
    query: DRAFT_ORDER_CREATE_MUTATION,
    variables: { input: toGqlDraftInput(opts.input) },
  });
  const errs = data?.draftOrderCreate?.userErrors ?? [];
  if (errs.length) throw new Error(`draftOrderCreate: ${errs.map((e: any) => e.message).join("; ")}`);
  const d = data?.draftOrderCreate?.draftOrder;
  if (!d?.id) throw new Error("draftOrderCreate: respuesta sin draftOrder");
  return { gid: String(d.id), name: d.name ?? null };
}

/** Update an existing draft (cart) with corrected line items / address. */
export async function updateDraftOrder(
  opts: ShopifyClientOpts & { gid: string; input: BuildDraftOrderInput },
): Promise<void> {
  const data = await shopifyGraphQL<any>({
    ...opts,
    query: DRAFT_ORDER_UPDATE_MUTATION,
    variables: { id: opts.gid, input: toGqlDraftInput(opts.input) },
  });
  const errs = data?.draftOrderUpdate?.userErrors ?? [];
  if (errs.length) throw new Error(`draftOrderUpdate: ${errs.map((e: any) => e.message).join("; ")}`);
}

export interface DraftOrderEdit {
  gid: string;
  name: string | null;
  lineItems: { variantId: string | null; title: string; quantity: number; unitPrice: number | null }[];
  address: {
    name: string | null;
    address1: string | null;
    address2: string | null;
    city: string | null;
    province: string | null;
  };
}

const DRAFT_ORDER_GET_QUERY = /* GraphQL */ `
  query GetDraft($id: ID!) {
    draftOrder(id: $id) {
      id
      name
      shippingAddress { address1 address2 city province name }
      lineItems(first: 50) {
        edges {
          node {
            title
            quantity
            originalUnitPriceSet { shopMoney { amount } }
            variant { id }
          }
        }
      }
    }
  }
`;

/** Read a draft live (with variant ids + prices) to pre-fill the order form. */
export async function getDraftOrderForEdit(
  opts: ShopifyClientOpts & { gid: string },
): Promise<DraftOrderEdit | null> {
  const data = await shopifyGraphQL<any>({ ...opts, query: DRAFT_ORDER_GET_QUERY, variables: { id: opts.gid } });
  const d = data?.draftOrder;
  if (!d) return null;
  const lineItems = (d.lineItems?.edges ?? []).map((e: any) => {
    const n = e?.node ?? {};
    return {
      variantId: n?.variant?.id ? String(n.variant.id) : null,
      title: String(n?.title ?? ""),
      quantity: Number(n?.quantity ?? 1),
      unitPrice: toNumber(n?.originalUnitPriceSet?.shopMoney?.amount),
    };
  });
  const a = d.shippingAddress ?? {};
  return {
    gid: String(d.id),
    name: d.name ?? null,
    lineItems,
    address: {
      name: a.name ?? null,
      address1: a.address1 ?? null,
      address2: a.address2 ?? null,
      city: a.city ?? null,
      province: a.province ?? null,
    },
  };
}

const WEBHOOK_CREATE_MUTATION = /* GraphQL */ `
  mutation CreateWebhook($topic: WebhookSubscriptionTopic!, $callbackUrl: URL!) {
    webhookSubscriptionCreate(
      topic: $topic
      webhookSubscription: { callbackUrl: $callbackUrl, format: JSON }
    ) {
      webhookSubscription { id topic }
      userErrors { field message }
    }
  }
`;

export const ORDER_WEBHOOK_TOPICS = ["ORDERS_CREATE", "ORDERS_UPDATED"] as const;
// Draft-order topics (note the singular DRAFT_ORDERS_UPDATE, unlike ORDERS_UPDATED).
// Registering these needs read_draft_orders; without it Shopify returns a
// userError per topic (collected below) rather than throwing — non-breaking.
export const DRAFT_ORDER_WEBHOOK_TOPICS = [
  "DRAFT_ORDERS_CREATE",
  "DRAFT_ORDERS_UPDATE",
  "DRAFT_ORDERS_DELETE",
] as const;

/** Register orders + draft_orders create/update(/delete) webhooks at our handler. */
export async function registerOrderWebhooks(
  opts: ShopifyClientOpts & { callbackUrl: string },
): Promise<Array<{ topic: string; id: string | null; error?: string }>> {
  const results: Array<{ topic: string; id: string | null; error?: string }> = [];
  for (const topic of [...ORDER_WEBHOOK_TOPICS, ...DRAFT_ORDER_WEBHOOK_TOPICS]) {
    const data = await shopifyGraphQL<any>({
      ...opts,
      query: WEBHOOK_CREATE_MUTATION,
      variables: { topic, callbackUrl: opts.callbackUrl },
    });
    const errs = data?.webhookSubscriptionCreate?.userErrors ?? [];
    results.push({
      topic,
      id: data?.webhookSubscriptionCreate?.webhookSubscription?.id ?? null,
      error: errs.length ? errs.map((e: any) => e.message).join("; ") : undefined,
    });
  }
  return results;
}

const SHOP_INFO_QUERY = /* GraphQL */ `
  query ShopInfo {
    shop { name currencyCode ianaTimezone myshopifyDomain }
  }
`;

export interface ShopInfo {
  name: string;
  currencyCode: string;
  ianaTimezone: string;
  myshopifyDomain: string;
}

/** Fetch shop name/currency/timezone — used to validate a token at onboarding. */
export async function fetchShopInfo(opts: ShopifyClientOpts): Promise<ShopInfo> {
  const data = await shopifyGraphQL<{ shop: ShopInfo }>({
    ...opts,
    query: SHOP_INFO_QUERY,
  });
  return data.shop;
}

// ---------------------------------------------------------------------------
// OAuth install flow ("Install on Shopify" → token captured automatically)
// ---------------------------------------------------------------------------

const SHOP_DOMAIN_RE = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;

/** Guard against SSRF: only accept canonical *.myshopify.com hosts. */
export function isValidShopDomain(shop: string): boolean {
  return SHOP_DOMAIN_RE.test((shop ?? "").toLowerCase());
}

export function buildAuthorizeUrl(opts: {
  shop: string;
  apiKey: string;
  scopes: string;
  redirectUri: string;
  state: string;
}): string {
  const u = new URL(`https://${opts.shop}/admin/oauth/authorize`);
  u.searchParams.set("client_id", opts.apiKey);
  u.searchParams.set("scope", opts.scopes);
  u.searchParams.set("redirect_uri", opts.redirectUri);
  u.searchParams.set("state", opts.state);
  return u.toString();
}

/** Verify the HMAC Shopify appends to the OAuth callback query (hex digest). */
export function verifyShopifyOAuthHmac(
  params: URLSearchParams,
  secret: string | null | undefined,
): boolean {
  const provided = params.get("hmac");
  if (!provided || !secret) return false;
  const pairs: string[] = [];
  for (const [k, v] of params.entries()) {
    if (k === "hmac" || k === "signature") continue;
    pairs.push(`${k}=${v}`);
  }
  pairs.sort();
  const digest = createHmac("sha256", secret).update(pairs.join("&")).digest("hex");
  const a = Buffer.from(digest);
  const b = Buffer.from(provided);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Exchange an OAuth authorization code for an Admin API access token. */
export async function exchangeCodeForToken(opts: {
  shop: string;
  apiKey: string;
  apiSecret: string;
  code: string;
  fetchImpl?: typeof fetch;
}): Promise<{ access_token: string; scope: string }> {
  const doFetch = opts.fetchImpl ?? fetch;
  const res = await doFetch(`https://${opts.shop}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ client_id: opts.apiKey, client_secret: opts.apiSecret, code: opts.code }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Shopify token exchange HTTP ${res.status}: ${t.slice(0, 300)}`);
  }
  const json: any = await res.json();
  if (!json?.access_token) throw new Error("Shopify token exchange: missing access_token");
  return { access_token: String(json.access_token), scope: String(json.scope ?? "") };
}
