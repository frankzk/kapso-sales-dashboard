// Shared domain types + constants used across ingestion, metrics and UI.

export type Role = "owner" | "admin" | "viewer";
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
