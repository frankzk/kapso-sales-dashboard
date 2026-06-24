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

export interface OrderLineItem {
  title: string;
  quantity: number;
  sku: string | null;
  product_id: string | null;
  variant_id: string | null;
  price: number | null;
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
  promo_applied: boolean;
  stock_por_validar: boolean;
  shipping_mode: ShippingMode;
  kapso_conversation_id: string | null;
  line_items: OrderLineItem[];
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
  inbound_count?: number | null;
  // Source / channel attribution (0008). 'meta_ad' for Click-to-WhatsApp ad
  // leads (captured from the first inbound message's `referral`); null = organic.
  source?: string | null;
  ad_id?: string | null;
  ad_headline?: string | null;
  ctwa_clid?: string | null;
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
