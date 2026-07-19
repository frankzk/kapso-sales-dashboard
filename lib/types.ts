// Shared domain types + constants used across ingestion, metrics and UI.

export type Role = "owner" | "admin" | "viewer" | "vendedora";
export type ShippingMode = "cod" | "agency" | null;
export type SyncSource = "shopify" | "kapso" | "ops";

/** Tags / attribute keys the WhatsApp bot writes onto Shopify orders. */
export const TAGS = {
  kapso: "kapso",
  whatsapp: "whatsapp",
  promo: "promo-whatsapp",
  stockPorValidar: "stock-por-validar",
} as const;

export const NOTE_ATTR = {
  conversationId: "kapso_conversation_id",
  phoneNumberId: "kapso_phone_number_id",
  source: "source",
  shippingMode: "shipping_mode",
  stockPorValidar: "stock_por_validar",
} as const;

export const WHATSAPP_BOT_SOURCE = "whatsapp-bot";

/** `leads.source` for a lead created from a Shopify draft order (Releasit COD
 *  form) with no prior WhatsApp conversation — a pure-web abandoned cart. */
export const COD_CART_SOURCE = "cod_cart";

/** `leads.source` for a lead created from an abandoned BROWSE (Shopify Flow
 *  "customer left online store"): an identified visitor who only viewed a
 *  product page — no cart, no WhatsApp chat. Weakest-intent web source. */
export const BROWSE_SOURCE = "abandoned_browse";

export interface OrderLineItem {
  title: string;
  quantity: number;
  sku: string | null;
  product_id: string | null;
  variant_id: string | null;
  price: number | null;
}

/** Shopify order fields shown inside the shipment drawer. */
export interface OrderShippingAddress {
  address1: string | null;
  address2: string | null;
  city: string | null;
  province: string | null;
  name: string | null;
  phone: string | null;
}

export interface ShipmentOrderDetail {
  name: string | null;
  shopify_order_id: string | null;
  line_items: OrderLineItem[];
  shipping_address: OrderShippingAddress | null;
}

/** A row ready to be upserted into the `orders` table. */
export interface OrderRow {
  store_id: string;
  shopify_order_id: string;
  name: string | null;
  created_at: string | null;
  processed_at: string | null;
  updated_at: string | null;
  total_amount: number | null;
  currency: string | null;
  financial_status: string | null;
  cancelled_at: string | null;
  total_refunded: number;
  customer_phone?: string | null;
  tags: string[];
  discount_codes: string[]; // coupon codes applied (e.g. ["AURELA10"]); [] when none
  promo_applied: boolean;
  stock_por_validar: boolean;
  shipping_mode: ShippingMode;
  kapso_conversation_id: string | null;
  line_items: OrderLineItem[];
  raw?: unknown;
}

export type DraftOrderStatus = "open" | "invoice_sent" | "completed" | null;

/**
 * A Shopify Draft Order (Releasit COD form) ready to upsert into `draft_orders`.
 * `open` = abandoned cart to work; `completed` = recovered (became a real order).
 * Mirrors OrderRow and reuses OrderLineItem. Phone normalized via normalizePhone().
 */
export interface DraftOrderRow {
  store_id: string;
  shopify_draft_order_id: string; // numeric id as text (from the GID)
  draft_order_gid: string; // gid://shopify/DraftOrder/...
  name: string | null; // "#D123"
  status: DraftOrderStatus; // OPEN | INVOICE_SENT | COMPLETED -> lowercased
  created_at: string | null;
  updated_at: string | null; // reconciliation cursor
  completed_at: string | null;
  invoice_url: string | null;
  total_amount: number | null;
  currency: string | null;
  customer_phone?: string | null; // normalizePhone() applied
  customer_name: string | null;
  district: string | null; // shippingAddress.city
  province: string | null;
  region: string | null;
  address1: string | null;
  referencia: string | null; // shippingAddress.address2
  tags: string[];
  note: string | null;
  line_items: OrderLineItem[];
  order_gid: string | null; // the resulting order GID once completed
  raw?: unknown;
}

export interface ConversationRow {
  store_id: string;
  kapso_conversation_id: string;
  phone_number_id: string | null;
  started_at: string | null;
  status: string | null;
  message_count: number;
  last_message_at: string | null;
  /** Inbound (customer→bot) message count, captured best-effort from Kapso. */
  inbound_count?: number | null;
  /** Seconds from first inbound to first outbound reply (null = unknown). */
  first_response_seconds?: number | null;
  raw?: unknown;
}

export interface DailyRollupRow {
  store_id: string;
  date: string; // YYYY-MM-DD
  orders_count: number;
  revenue: number;
  aov: number;
  conversations_count: number;
  conversion_rate: number;
  promo_orders: number;
  stock_validar_orders: number;
  cod_orders: number;
  agency_orders: number;
  cancelled_orders: number;
  refunded_amount: number;
  // Message-timing family (0005). Stored as sum+samples so the average stays
  // aggregatable across stores/days; the avg is computed at read time.
  inbound_messages: number;
  response_seconds_sum: number;
  response_samples: number;
}

export interface StoreSummary {
  id: string;
  org_id: string;
  name: string;
  shopify_domain: string;
  currency: string;
  timezone: string;
  status: string;
}

export interface LeadRow {
  id: string;
  store_id: string;
  phone: string;
  wa_id: string | null;
  name: string | null;
  email: string | null;
  first_seen_at: string | null;
  last_interaction_at: string | null;
  kapso_conversation_id: string | null;
  bot_compra_state: string | null;
  handoff_reason: string | null;
  handoff_context: string | null;
  handoff_at: string | null;
  category: string; // won | hot | open | lost
  status: string;
  needs_attention: boolean;
  order_id: string | null;
  has_order: boolean;
  // Enrichment signals for sub-segmenting "Por llamar" (0007). Informational —
  // do not affect category/status. Cart + district come from an open Shopify
  // draft order (COD form); inbound_count from the Kapso conversation. Optional:
  // not every row/factory carries them (the DB returns null when unset).
  district?: string | null;
  cart_value?: number | null;
  cart_item_count?: number | null;
  cart_summary?: string | null;
  draft_order_gid?: string | null;
  // Draft-order denormalized fields (0013): the board reads these directly so it
  // never needs to join `draft_orders`. Extended address mirrors the COD form.
  draft_order_name?: string | null;
  draft_order_status?: string | null; // open | invoice_sent | completed
  draft_order_url?: string | null; // Shopify draft invoiceUrl ("Ver borrador")
  province?: string | null;
  region?: string | null;
  referencia?: string | null;
  address1?: string | null; // shippingAddress.address1 (calle) — 0032
  ship_name?: string | null; // shipping recipient (draft customer_name) — 0032
  inbound_count?: number | null;
  // Source / channel attribution (0008). 'meta_ad' = structured Click-to-WhatsApp
  // referral (real ad_id); 'fb_web' = reached WhatsApp via a Facebook/IG web link
  // (utm_source=facebook/fbclid, no ad_id); 'cod_cart'/'abandoned_browse' = flows;
  // null = organic. Captured from the first inbound message's `referral`.
  source?: string | null;
  ad_id?: string | null;
  ad_headline?: string | null;
  ctwa_clid?: string | null;
  wa_phone_number_id?: string | null; // which WhatsApp business number the lead wrote to (0012)
  last_inbound_at?: string | null; // last customer inbound — drives the 24h window clock
  claimed_by: string | null;
  claimed_at: string | null;
  closed_by: string | null;
  next_followup_at: string | null;
  created_at?: string;
  updated_at?: string;
}

export interface LeadCallRow {
  id?: string;
  lead_id: string;
  store_id: string;
  vendedora: string | null;
  kind: string; // call | state_change | note | sale | system
  new_status: string | null;
  note: string | null;
  next_followup_at: string | null;
  occurred_at?: string;
  vendedora_name?: string | null; // resolved display name of who logged it (UI only)
}

// ── Envíos module (couriers Aliclik / Fenix) ────────────────────────────────

export interface ShipmentRow {
  id: string;
  store_id: string;
  courier: string; // aliclik | fenix
  guide_code: string; // AUR5X… (aliclik) or Fenix tracking
  delivery_status: string; // see lib/shipments.ts
  status_category: string; // pending | in_route | delivered | closed
  order_id: string | null;
  matched: boolean;
  match_method: string | null; // order_name | phone | manual | none
  order_name: string | null;
  customer_name: string | null;
  customer_phone: string | null;
  product: string | null;
  district: string | null;
  city: string | null; // normalized coverage key
  region: string | null;
  delivery_address: string | null;
  delivery_reference: string | null;
  latitude: number | null;
  longitude: number | null;
  address_override: boolean;
  address_updated_at: string | null;
  address_updated_by: string | null;
  fenix_eligible: boolean;
  fenix_shipment_id: string | null;
  delivered_source: string | null; // 'aliclik' | 'fenix' — sub-state of Entregado
  /** Delivery attempts reported by Aliclik's daily Excel (NRO. INTENTOS). */
  aliclik_attempts: number | null;
  /** Operative delivery date reported by Aliclik, as YYYY-MM-DD. */
  aliclik_service_date: string | null;
  reroute_attempts: number;
  /** Number of logged calls, populated on shipment queue reads. */
  contact_count?: number;
  /** Number of calls logged today in Lima, across the whole team. */
  today_contact_count?: number;
  reroute_outcome: string | null;
  claimed_by: string | null;
  claimed_at: string | null;
  next_followup_at: string | null;
  source_batch_id: string | null;
  last_report_at: string | null;
  suggested_order_gid: string | null;
  suggested_store_id: string | null;
  suggested_order_name: string | null;
  created_at?: string;
  updated_at?: string;
}

/** Minimal linked-guide identity used to move from a frozen source guide to
 * the active Fenix guide without leaving the drawer. */
export interface LinkedShipmentSummary {
  id: string;
  courier: string;
  guide_code: string;
  delivery_status: string;
  status_category: string;
}

export interface ShipmentCallRow {
  id?: string;
  shipment_id: string;
  store_id: string;
  agent: string | null;
  kind: string; // call | state_change | note | reroute | system
  new_status: string | null;
  note: string | null;
  next_followup_at: string | null;
  occurred_at?: string;
  agent_name?: string | null; // resolved display name (UI only)
}

export interface FenixStockRowDb {
  id: string;
  org_id: string;
  city: string;
  product: string;
  sku: string | null;
  quantity: number;
  updated_by: string | null;
  updated_at?: string;
  created_at?: string;
}

export interface ImportBatchRow {
  id: string;
  store_id: string;
  kind: string;
  filename: string | null;
  uploaded_by: string | null;
  row_count: number;
  matched_count: number;
  unmatched_count: number;
  status: string; // processing | processed | failed
  error: string | null;
  created_at?: string;
}

export interface ImportRowRow {
  id: string;
  batch_id: string;
  store_id: string;
  row_index: number;
  raw: Record<string, string>;
  parsed: Record<string, unknown> | null;
  match_status: string; // matched | unmatched | review | error
  shipment_id: string | null;
  error: string | null;
  created_at?: string;
}
