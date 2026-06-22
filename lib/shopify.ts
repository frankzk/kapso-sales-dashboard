// Shopify Admin API integration: webhook HMAC verification, order mapping
// (REST webhook payloads + GraphQL backfill nodes), and a small Admin GraphQL
// client used for backfill, webhook registration and shop info.

import { createHmac, timingSafeEqual } from "node:crypto";
import {
  type OrderLineItem,
  type OrderRow,
  type ShippingMode,
  NOTE_ATTR,
  TAGS,
} from "@/lib/types";

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

  const priceSet = node?.currentTotalPriceSet ?? node?.totalPriceSet;
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
    tags,
    ...flags,
    line_items,
    raw: node,
  };
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

export const ORDERS_QUERY = /* GraphQL */ `
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
          displayFinancialStatus
          currentTotalPriceSet { shopMoney { amount currencyCode } }
          tags
          customAttributes { key value }
          lineItems(first: 100) {
            edges {
              node {
                title
                quantity
                sku
                product { id }
                variant { id }
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
  const data = await shopifyGraphQL<any>({
    ...opts,
    query: ORDERS_QUERY,
    variables: {
      first: opts.first ?? 100,
      after: opts.after ?? null,
      query: opts.searchQuery,
    },
  });

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

/** Register orders/create + orders/updated webhooks pointing at our handler. */
export async function registerOrderWebhooks(
  opts: ShopifyClientOpts & { callbackUrl: string },
): Promise<Array<{ topic: string; id: string | null; error?: string }>> {
  const results: Array<{ topic: string; id: string | null; error?: string }> = [];
  for (const topic of ORDER_WEBHOOK_TOPICS) {
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
