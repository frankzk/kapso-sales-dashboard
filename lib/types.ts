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
  /** Shopify option combination, e.g. "38-39 / Negro". */
  variant_title?: string | null;
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
  /**
   * Coordenadas que Shopify geocodifica de la dirección. Llegan en el mismo
   * `shipping_address` de siempre; durante mucho tiempo no se leyeron porque la
   * consulta GraphQL no las pedía. Son las que Aliclik exige para cotizar y
   * crear una guía.
   */
  latitude: number | null;
  longitude: number | null;
}

export interface ShipmentOrderDetail {
  name: string | null;
  shopify_order_id: string | null;
  line_items: OrderLineItem[];
  shipping_address: OrderShippingAddress | null;
}

/** A row ready to be upserted into the `orders` table. */
export interface OrderRow {
  /** Internal Supabase UUID. Leads.order_id and shipments.order_id point here. */
  id?: string;
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
  /** NULLABLE desde la 0105. Un cliente que adoptó un username de WhatsApp llega
   *  sin número: su identidad es el `bsuid`. Se tipa nullable a propósito para
   *  que el compilador marque cada sitio que asumía un teléfono — llamar, wa.me,
   *  el QR de llamada — en vez de descubrirlo con un `.trim()` de null en
   *  producción. Ver `leadHandle` / `leadCanCall` en lib/leads.ts. */
  phone: string | null;
  wa_id: string | null;
  /** Identidad de WhatsApp scopeada al portfolio (0103). Clave alternativa
   *  cuando no hay teléfono (0105). NO es comparable entre tiendas. */
  bsuid?: string | null;
  /** Username público de WhatsApp, si el cliente adoptó uno (0103). */
  username?: string | null;
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
  /** First message the customer wrote — opener context for the advisor (0044). */
  first_inbound_text?: string | null;
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
  /** Identidad MOM de la salida física. Opcional durante el despliegue de 0059. */
  output_number?: number | null;
  output_code?: string | null;
  qr_token?: string | null;
  preparation_state?: string | null;
  custody_state?: string | null;
  ready_at?: string | null;
  ready_by?: string | null;
  custody_transferred_at?: string | null;
  custody_transferred_by?: string | null;
  returned_at?: string | null;
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
  /** Administrative province imported from Aliclik (not the Fenix coverage city). */
  province?: string | null;
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
  /** Current stock evaluation, added at read time for the Envios UI. */
  fenix_reason?: "ok" | "sin_stock" | "sin_cobertura";
  fenix_shipment_id: string | null;
  /** 'fenix_directo' = guía creada desde un pedido, sin guía Aliclik madre. */
  created_via?: string | null;
  delivered_source: string | null; // 'aliclik' | 'fenix' — sub-state of Entregado
  /**
   * Shalom identifica un envío con DOS cosas en su panel: el nº de orden
   * (`guide_code`) y un código corto (`77PH`). Sin el corto hay que abrir cada
   * envío en pro.shalom.pe para saber cuál es cuál. Nulo en las guías que
   * llegaron por el reporte Excel; solo lo traen las creadas por API (0061).
   */
  shalom_codigo?: string | null;
  /** Id con el que Shalom sirve el rótulo PDF. Solo en las creadas por API. */
  shalom_ose_id?: number | null;
  /**
   * Estado del flujo de agencia de ESTA salida (§10). Es lo que el courier
   * reporta —«pendiente de envío», «disponible para recojo»— y no coincide con
   * `delivery_status`, que se queda en «pendiente» todo ese trayecto.
   */
  pickup_state?: string | null;
  /** Delivery attempts reported by Aliclik's daily Excel (NRO. INTENTOS). */
  aliclik_attempts: number | null;
  /** Operative delivery date reported by Aliclik, as YYYY-MM-DD. */
  aliclik_service_date: string | null;
  reroute_attempts: number;
  /** Number of logged calls, populated on shipment queue reads. */
  contact_count?: number;
  /** Number of calls logged today in Lima, across the whole team. */
  today_contact_count?: number;
  /** ISO time of the most recent gestión our team logged for this guide OR its
   *  linked chain (reprogramación origin ↔ Fenix child). Added at read time to
   *  show how long a shipment has gone without our attention. */
  last_gestion_at?: string | null;
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

/** Latest logistics outcome for one Shopify order, used by campaign attribution. */
export interface CampaignDeliveryOutcome {
  orderId: string;
  deliveryStatus: string | null;
  statusCategory: string | null;
  createdAt: string | null;
}

/** Aggregated historical Meta Insights for one ad in the selected date range. */
export interface MetaAdPerformance {
  storeId: string;
  adId: string;
  accountId: string | null;
  currency: string | null;
  metaConversations: number;
  spend: number;
  impressions: number;
  reach: number;
  clicks: number;
  inlineLinkClicks: number;
  activeDays: number;
  firstDate: string | null;
  lastDate: string | null;
  syncedAt: string | null;
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

export interface ShipmentHistoryGuide extends LinkedShipmentSummary {
  fenix_shipment_id: string | null;
  created_via?: string | null;
  created_at: string | null;
  is_current: boolean;
  calls: ShipmentCallRow[];
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
  note_edited_at?: string | null; // set when the note was edited after the fact
  note_edited_by?: string | null; // user id who last edited the note
  note_editor_name?: string | null; // resolved display name of the editor (UI only)
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

// ── Master de Pedidos ───────────────────────────────────────────────────────

/** Una fila del Master: el read-model materializado en `order_master` (0045). */
/**
 * Una fila del Master. Los campos OPCIONALES son los que el listado no manda
 * (ver MASTER_COLUMNS en lib/orders-master-access.ts): pagar su nombre y su
 * valor diez mil veces por carga no compensa cuando solo se leen al abrir un
 * pedido. El detalle sí los trae completos.
 */
export interface OrderMasterRow {
  id: string;
  store_id: string;
  order_id: string;
  order_name: string | null;
  shopify_order_id?: string;
  order_created_at: string | null;
  customer_name: string | null;
  customer_phone: string | null;
  region: string | null;
  province: string | null;
  district: string | null;
  /** Flujo operativo derivado de la ubicación y la cobertura COD vigente. */
  coverage?: "lima" | "provincia_cod" | "agencia" | "por_revisar" | null;
  address?: string | null;
  reference?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  /** Origen de la ubicación: manual | courier | ubigeo | shopify | draft. */
  geo_source?: string | null;
  shipping_mode: string | null; // cod | agency
  order_total: number | null;
  general_status: string;
  operational_status: string;
  /** Macroetapa MOM v1 usada por la navegación principal; opcional hasta aplicar 0059. */
  macro_stage?: string | null;
  macro_substage?: string | null;
  macro_reasons?: string[] | null;
  macro_operation?: string | null;
  macro_version?: string | null;
  macro_since?: string | null;
  status_since: string | null;
  status_source?: string | null;
  status_locked: boolean;
  current_courier: string | null;
  last_courier: string | null;
  courier_count: number;
  attempt_count: number;
  guide_code: string | null;
  dispatched_at: string | null;
  delivered_at: string | null;
  delivered_courier?: string | null;
  returned_at?: string | null;
  last_movement_at: string | null;
  comment_count: number;
  logistics_cost: number | null;
  /** Seguimiento de agencia (Shalom/Olva): ver §10 de la especificación. */
  pickup_state: string | null;
  /** Indicadores del cobro Yape y de la clave de recojo (Shalom). */
  payment_state: string | null;
  key_state: string | null;
  agency_branch: string | null;
  agency_arrived_at: string | null;
  agency_expires_at: string | null;
  recomputed_at?: string;
  updated_at?: string;
}

/** Un movimiento de la línea de tiempo (`order_events`, append-only). */
export interface OrderEventRow {
  id: string;
  store_id: string;
  order_id: string;
  kind: string;
  occurred_at: string;
  actor: string | null;
  source: string;
  courier: string | null;
  guide_code: string | null;
  previous_status: string | null;
  new_status: string | null;
  previous_operational: string | null;
  new_operational: string | null;
  attempt_number: number | null;
  reason: string | null;
  note: string | null;
  comment_type: string | null;
  shipment_id: string | null;
  batch_id: string | null;
  payload?: Record<string, unknown>;
  created_at?: string;
  /** Nombre resuelto de quien lo registró (solo UI). */
  actor_name?: string | null;
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
