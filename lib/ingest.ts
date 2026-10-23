// Ingestion orchestration shared by the webhook handler and the sync cron.
// All writes go through the service-role admin client (RLS-bypassing) and are
// idempotent. Per-store tokens are decrypted here, on demand, server-side only.

import { createHash, timingSafeEqual } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminSupabase } from "@/lib/db";
import { env } from "@/lib/env";
import { decryptOrNull } from "@/lib/crypto";
import { OWN_APP, ownAppPrevSecretValidUntil, ownAppTokenForUse } from "@/lib/shopify-own-app";
import { chunk } from "@/lib/access";
import { recomputeOrderMasterSafe, reconcileOrderMaster } from "@/lib/order-master";
import { fetchMetaAdMeta, normalizeMetaAdAccounts, type StoreMetaAdAccount } from "@/lib/meta-marketing";
import {
  buildAllOrdersSearchQuery,
  buildDraftOrdersSearchQuery,
  buildKapsoOrdersSearchQuery,
  DRAFT_OPEN_WINDOW_DAYS,
  fetchDraftOrdersPage,
  fetchOrdersPage,
  hasKapsoTag,
  mapRestDraftOrder,
  mapRestOrder,
  verifyShopifyHmac,
  routeShopifyTopic,
  type ShopifyWebhookRoute,
} from "@/lib/shopify";
import {
  classifyKapsoEvent,
  fetchConversationSignals,
  getPhoneHealth,
  listAllConversations,
  listApiLogs,
  listWhatsappNumbers,
  mapKapsoConversation,
  type KapsoPhoneNumber,
} from "@/lib/kapso";
import {
  buildOpsSnapshotPayload,
  summarizeApiLogs,
  tzParts,
} from "@/lib/metrics";
import { applyWhatsappStatusEvents, parseWhatsappStatusEvents } from "@/lib/whatsapp-outbox";
import { handleInboundMessage } from "@/lib/wa-button-replies";
import {
  applyHandoff,
  archiveStaleLeads,
  closeCartLeadsWithOrders,
  eventOverridesDisposition,
  expireColdHandoffs,
  flagCartAttentionWaves,
  flagOverdueFollowups,
  ingestConversationEvent,
  lastDispositionAtByPhone,
  linkDraftOrdersToLeads,
  linkOrderToLead,
  linkOrdersToLeads,
  processBrowseAbandonment,
  processWinback,
  sendSeguimientoDrip,
  syncStoreLeads,
  type LeadEnrichStats,
} from "@/lib/leads-ingest";
import { runCartSequence } from "@/lib/cart-sequence";
import { autoTrialDeps, processAutoOrderTrials } from "@/lib/auto-order-trials";
import { abDeps, enrollAbCohorts } from "@/lib/auto-order-ab";
import { runReturnRecovery } from "@/lib/return-recovery";
import { runDeliveredThanks } from "@/lib/delivered-thanks";
import { runRestockReminders, sweepRestockReplies } from "@/lib/restock-reminder";
import { enrichLeadLocationsFromShopify } from "@/lib/lead-shopify-location";
import {
  WOO_CANCELLED_STATUSES,
  fetchWooOrder,
  fetchWooOrdersPage,
  mapWooOrder,
  parseWooWebhookPing,
  verifyWooSignature,
  wooOrderId,
  type WooOrder,
} from "@/lib/woocommerce";
import {
  WOO_SYNC_BUDGET_MS,
  WOO_SYNC_MAX_PAGES,
  WOO_SYNC_PER_PAGE,
  WOO_SYNC_SOURCE,
  hasWooApiCredentials,
  isWooCreatedBeforeFloor,
  isWooIntakeTopic,
  laterIso,
  loadWooStoreCreds,
  maxWooModified,
  nextWooPage,
  recordWooLastError,
  withWooAuthFallback,
  wooClientOpts,
  wooHostOf,
  wooIntakeFloor,
  wooSourceMatchesSite,
  formatWooSyncCursor,
  parseWooSyncCursor,
  wooSyncFirstRequest,
  wooWebhookEventKey,
  wooWebhookTopic,
  type WooStoreCreds,
} from "@/lib/woocommerce-intake";
import type { ConversationRow, DraftOrderRow, OrderRow } from "@/lib/types";

/* eslint-disable @typescript-eslint/no-explicit-any */

// Max conversations to fetch message-timing for per sync run (bounds API cost).
const KAPSO_TIMING_CAP = 50;

export interface StoreCreds {
  id: string;
  org_id: string;
  name: string;
  shopify_domain: string;
  /** Con qué app se conectó (0249, 0271): 'interna', 'clientes' o 'propia'. */
  shopify_app?: string;
  shopify_token: string | null;
  shopify_webhook_secret: string | null;
  /**
   * Solo app propia (0271): cuándo vence `shopify_token`, para renovarlo al
   * usarlo después de autenticar un webhook (`ownAppCredsForUse`).
   */
  shopify_token_expires_at?: string | null;
  /**
   * Solo app propia (0271, MOM §36.4): el Client secret anterior tras rotarlo,
   * mientras dura la gracia. Firma los webhooks hasta que se revoca en Shopify.
   * En Kenku, Aurela y las tiendas 'clientes' no existe.
   */
  shopify_webhook_secret_prev?: string | null;
  kapso_project_id: string | null;
  kapso_api_key: string | null;
  flow_webhook_secret: string | null;
  kapso_webhook_secret: string | null;
  /** Flow.cl (pasarela). OJO: `flow_webhook_secret` de arriba es Shopify Flow. */
  flowcl_api_key: string | null;
  flowcl_secret_key: string | null;
  flowcl_webhook_secret: string | null;
  /** El botón «Link de pago» cobra de verdad por Flow.cl (0168). */
  flowcl_link_enabled: boolean;
  flowcl_link_email: string | null;
  flowcl_link_ttl_hours: number;
  flowcl_link_yape_only: boolean;
  whatsapp_phone_number_id: string | null;
  currency: string;
  timezone: string;
  status: string;
  browse_template_enabled: boolean;
  browse_template_name: string | null;
  browse_template_language: string | null;
  winback_template_enabled: boolean;
  winback_template_name: string | null;
  winback_template_language: string | null;
  drip_template_enabled: boolean;
  drip_template_name: string | null;
  drip_template_language: string | null;
  cart_seq_enabled: boolean;
  cart_seq_template_1_name: string | null;
  cart_seq_template_1_language: string | null;
  cart_seq_template_2_name: string | null;
  cart_seq_template_2_language: string | null;
  cart_seq_hours_1: number;
  cart_seq_hours_2: number;
  cart_seq_hour_start: number;
  cart_seq_hour_end: number;
  /** Prueba de imagen en el mensaje 1 (0233): plantilla con cabecera de imagen. */
  cart_seq_image_test_enabled: boolean;
  cart_seq_image_template_1_name: string | null;
  cart_seq_image_template_1_language: string | null;
  /** Recuperación del pedido devuelto (0112). `enabled` habilita la cola y el
   *  botón; `auto` deja que el cron envíe solo. Ver lib/return-recovery.ts. */
  return_recovery_enabled: boolean;
  return_recovery_auto: boolean;
  return_recovery_template_name: string | null;
  return_recovery_template_language: string | null;
  return_recovery_params: string | null;
  /** Número propio para este envío (0114). NULL ⇒ el de la tienda. Solo afecta
   *  a la recuperación; el drip y los carritos siguen usando el de la clienta. */
  return_recovery_phone_number_id: string | null;
  /** Prefijo de los nombres de pedido de esta tienda, sin "#" (0115). */
  order_prefix: string | null;
  return_recovery_hour_start: number;
  return_recovery_hour_end: number;
  return_recovery_max_days: number;
  /** Agradecimiento con catálogo al entregar (0193). Ver lib/delivered-thanks.ts. */
  delivered_thanks_enabled: boolean;
  delivered_thanks_template_name: string | null;
  delivered_thanks_template_language: string | null;
  delivered_thanks_params: string | null;
  delivered_thanks_button_param: string | null;
  delivered_thanks_phone_number_id: string | null;
  delivered_thanks_hour_start: number;
  delivered_thanks_hour_end: number;
  delivered_thanks_max_hours: number;
  /** Ritmo (0195): como mucho `count` intentos cada `minutes` minutos. */
  delivered_thanks_pace_count: number;
  delivered_thanks_pace_minutes: number;
  /** Recordatorio de reposición (0255). Ver lib/restock-reminder.ts. */
  restock_enabled: boolean;
  restock_template_name: string | null;
  restock_template_language: string | null;
  restock_params: string | null;
  restock_phone_number_id: string | null;
  restock_button_label: string | null;
  restock_hour_start: number;
  restock_hour_end: number;
  restock_pace_count: number;
  restock_pace_minutes: number;
  restock_days_before: number;
  restock_control_pct: number;
  telegram_bot_token: string | null;
  telegram_chat_id: string | null;
  meta_access_token: string | null;
  /** API key de Anthropic de ESTA tienda; null = usa la del entorno. */
  anthropic_api_key: string | null;
  anthropic_model: string | null;
  /** Token de la API de integración de Aliclik (0054). */
  aliclik_api_token: string | null;
  /** Secreto del webhook de Aliclik: su API no firma las notificaciones. */
  aliclik_webhook_secret: string | null;
  /** Interruptor por tienda de la creación de guías. */
  aliclik_enabled: boolean;
  meta_ad_accounts: StoreMetaAdAccount[];
  /** Aviso por WhatsApp cuando la guía de Shalom sale en tránsito (0166).
   *  Ver lib/shalom/transit-notify.ts. Nace apagado. */
  shalom_transit_template_enabled: boolean;
  shalom_transit_template_name: string | null;
  shalom_transit_template_language: string | null;
  shalom_transit_params: string | null;
  shalom_transit_attach_ticket: boolean;
  shalom_transit_phone_number_id: string | null;
  shalom_transit_hour_start: number;
  /** Tope de avisos de Shalom/Olva: 24 h móviles y última hora (0194). */
  shalom_notice_daily_cap: number;
  shalom_notice_hourly_cap: number;
  shalom_transit_hour_end: number;
  /** Respuesta al botón «Link de pago», con {saldo}, {pedido} y {yape}. */
  shalom_transit_payment_link: string | null;
  /** Aviso de «ya llegó a la agencia» (0169). Comparte número y horario. */
  shalom_arrival_template_enabled: boolean;
  shalom_arrival_template_name: string | null;
  shalom_arrival_params: string | null;
  shalom_arrival_attach_ticket: boolean;
  /** Registrar solos los comprobantes que llegan por WhatsApp (0171). */
  shalom_voucher_intake_enabled: boolean;
  /** Mandar la clave de recojo al validar el pago que cubre el pedido (0173). */
  shalom_pickup_key_autosend_enabled: boolean;
  /** Los dos avisos de Olva (0175). Comparten número, idioma, horario y
   *  cuentas con los de Shalom; solo la plantilla y sus variables son propias. */
  olva_transit_template_enabled: boolean;
  olva_transit_template_name: string | null;
  olva_transit_params: string | null;
  olva_arrival_template_enabled: boolean;
  olva_arrival_template_name: string | null;
  olva_arrival_params: string | null;
  /** Recordatorio de recojo, día 3 y día 7 en la agencia (0242). Interruptor
   *  y plantilla por courier; la imagen de respaldo es de la tienda. */
  shalom_reminder_template_enabled: boolean;
  shalom_reminder_template_name: string | null;
  shalom_reminder_params: string | null;
  olva_reminder_template_enabled: boolean;
  olva_reminder_template_name: string | null;
  olva_reminder_params: string | null;
  shalom_reminder_fallback_image_url: string | null;
}

/**
 * Solo el prefijo de pedido de la tienda (0115). Existe aparte de
 * `getStoreCreds` porque los importadores de courier no necesitan —ni deben
 * pagar— el descifrado de todos los secretos de la tienda para completar un
 * número de pedido.
 */
export async function getStoreOrderPrefix(
  admin: SupabaseClient,
  storeId: string,
): Promise<string | null> {
  const { data, error } = await admin
    .from("stores")
    .select("order_prefix")
    .eq("id", storeId)
    .maybeSingle();
  // Pre-0115 la columna no existe: el error se traga y se devuelve null, que
  // significa "no adivines el pedido", no "falla la importación".
  if (error || !data) return null;
  return ((data as { order_prefix?: string | null }).order_prefix ?? null) || null;
}

/** El secreto anterior de una app propia; uno que no se descifra no tumba la tienda. */
function prevSecretOrNull(value: unknown): string | null {
  try {
    return typeof value === "string" ? decryptOrNull(value) : null;
  } catch {
    return null;
  }
}

/**
 * Load a store row and decrypt its credentials (service-role only).
 *
 * `renewOwnApp: false` (0271): no renueva el token de una tienda con app propia.
 * Lo pasan quienes reciben un webhook o un aviso de afuera y todavía no
 * comprobaron su firma o su secreto: una petición falsa no puede hacer que
 * Kapta le mande el Client secret a Shopify. Después de autenticar, si usan
 * Shopify, llaman a `ownAppCredsForUse`.
 */
export async function getStoreCreds(
  storeId: string,
  admin: SupabaseClient = createAdminSupabase(),
  opts: { renewOwnApp?: boolean } = {},
): Promise<StoreCreds | null> {
  const { data, error } = await admin
    .from("stores")
    .select("*")
    .eq("id", storeId)
    .single();
  if (error || !data) return null;
  const ownApp = data.shopify_app === OWN_APP;
  let shopifyToken = decryptOrNull(data.shopify_token_enc);
  // App propia (0271, owner 23-10-2026): su token dura ~24 h. Si vence en menos
  // de 15 minutos se renueva antes de usarlo. Solo para 'propia': Kenku, Aurela
  // y las tiendas de la app de clientes no pasan por aquí (ni consulta ni red).
  if (ownApp && opts.renewOwnApp !== false) shopifyToken = await ownAppTokenForUse(admin, data, shopifyToken);
  return {
    id: data.id,
    org_id: data.org_id,
    name: data.name,
    shopify_domain: data.shopify_domain,
    shopify_app: data.shopify_app ?? "interna",
    shopify_token: shopifyToken,
    shopify_webhook_secret: decryptOrNull(data.shopify_webhook_secret_enc),
    // Solo en tiendas con app propia: las demás no llevan estas claves.
    ...(ownApp
      ? {
          shopify_token_expires_at: data.shopify_token_expires_at ?? null,
          shopify_webhook_secret_prev: ownAppPrevSecretValidUntil(data.shopify_webhook_secret_prev_set_at, new Date())
            ? prevSecretOrNull(data.shopify_webhook_secret_prev_enc)
            : null,
        }
      : {}),
    kapso_project_id: data.kapso_project_id ?? null,
    kapso_api_key: decryptOrNull(data.kapso_api_key_enc),
    flow_webhook_secret: decryptOrNull(data.flow_webhook_secret_enc),
    kapso_webhook_secret: decryptOrNull(data.kapso_webhook_secret_enc),
    flowcl_api_key: decryptOrNull(data.flowcl_api_key_enc),
    flowcl_secret_key: decryptOrNull(data.flowcl_secret_key_enc),
    flowcl_webhook_secret: decryptOrNull(data.flowcl_webhook_secret_enc),
    flowcl_link_enabled: data.flowcl_link_enabled ?? false,
    flowcl_link_email: data.flowcl_link_email ?? null,
    flowcl_link_ttl_hours: data.flowcl_link_ttl_hours ?? 48,
    flowcl_link_yape_only: data.flowcl_link_yape_only ?? false,
    whatsapp_phone_number_id: data.whatsapp_phone_number_id ?? null,
    currency: data.currency ?? "PEN",
    timezone: data.timezone ?? "America/Lima",
    status: data.status ?? "active",
    browse_template_enabled: data.browse_template_enabled ?? false,
    browse_template_name: data.browse_template_name ?? null,
    browse_template_language: data.browse_template_language ?? null,
    winback_template_enabled: data.winback_template_enabled ?? false,
    winback_template_name: data.winback_template_name ?? null,
    winback_template_language: data.winback_template_language ?? null,
    // Pre-0035 las columnas no existen (select * → undefined) ⇒ drip apagado.
    drip_template_enabled: data.drip_template_enabled ?? false,
    drip_template_name: data.drip_template_name ?? null,
    drip_template_language: data.drip_template_language ?? null,
    // Pre-0040 ⇒ secuencia de carritos apagada, defaults espejo de la migración.
    cart_seq_enabled: data.cart_seq_enabled ?? false,
    cart_seq_template_1_name: data.cart_seq_template_1_name ?? null,
    cart_seq_template_1_language: data.cart_seq_template_1_language ?? null,
    cart_seq_template_2_name: data.cart_seq_template_2_name ?? null,
    cart_seq_template_2_language: data.cart_seq_template_2_language ?? null,
    cart_seq_hours_1: data.cart_seq_hours_1 ?? 3,
    cart_seq_hours_2: data.cart_seq_hours_2 ?? 24,
    cart_seq_hour_start: data.cart_seq_hour_start ?? 8,
    cart_seq_hour_end: data.cart_seq_hour_end ?? 21,
    // Pre-0233 ⇒ sin prueba de imagen: el mensaje 1 sale como siempre.
    cart_seq_image_test_enabled: data.cart_seq_image_test_enabled ?? false,
    cart_seq_image_template_1_name: data.cart_seq_image_template_1_name ?? null,
    cart_seq_image_template_1_language: data.cart_seq_image_template_1_language ?? null,
    // Pre-0112 las columnas no existen (select * → undefined) ⇒ recuperación
    // apagada, que es exactamente el comportamiento anterior.
    return_recovery_enabled: data.return_recovery_enabled ?? false,
    return_recovery_auto: data.return_recovery_auto ?? false,
    return_recovery_template_name: data.return_recovery_template_name ?? null,
    return_recovery_template_language: data.return_recovery_template_language ?? null,
    return_recovery_params: data.return_recovery_params ?? null,
    // Pre-0114 la columna no existe ⇒ null ⇒ sale del número de la tienda.
    return_recovery_phone_number_id: data.return_recovery_phone_number_id ?? null,
    // Pre-0115 la columna no existe ⇒ null ⇒ no se adivina pedido desde un
    // número suelto, que es el comportamiento seguro.
    order_prefix: data.order_prefix ?? null,
    return_recovery_hour_start: data.return_recovery_hour_start ?? 8,
    return_recovery_hour_end: data.return_recovery_hour_end ?? 21,
    return_recovery_max_days: data.return_recovery_max_days ?? 30,
    // Pre-0193 las columnas no existen (select * → undefined) ⇒ apagado.
    delivered_thanks_enabled: data.delivered_thanks_enabled ?? false,
    delivered_thanks_template_name: data.delivered_thanks_template_name ?? null,
    delivered_thanks_template_language: data.delivered_thanks_template_language ?? null,
    delivered_thanks_params: data.delivered_thanks_params ?? null,
    delivered_thanks_button_param: data.delivered_thanks_button_param ?? null,
    delivered_thanks_phone_number_id: data.delivered_thanks_phone_number_id ?? null,
    delivered_thanks_hour_start: data.delivered_thanks_hour_start ?? 9,
    delivered_thanks_hour_end: data.delivered_thanks_hour_end ?? 21,
    delivered_thanks_max_hours: data.delivered_thanks_max_hours ?? 72,
    // Pre-0195 ⇒ el ritmo por defecto, 5 cada 20 minutos.
    delivered_thanks_pace_count: data.delivered_thanks_pace_count ?? 5,
    delivered_thanks_pace_minutes: data.delivered_thanks_pace_minutes ?? 20,
    // Pre-0255 las columnas no existen (select * → undefined) ⇒ apagado.
    restock_enabled: data.restock_enabled ?? false,
    restock_template_name: data.restock_template_name ?? null,
    restock_template_language: data.restock_template_language ?? null,
    restock_params: data.restock_params ?? null,
    restock_phone_number_id: data.restock_phone_number_id ?? null,
    restock_button_label: data.restock_button_label ?? null,
    restock_hour_start: data.restock_hour_start ?? 9,
    restock_hour_end: data.restock_hour_end ?? 20,
    restock_pace_count: data.restock_pace_count ?? 5,
    restock_pace_minutes: data.restock_pace_minutes ?? 20,
    restock_days_before: data.restock_days_before ?? 7,
    restock_control_pct: data.restock_control_pct ?? 10,
    telegram_bot_token: decryptOrNull(data.telegram_bot_token_enc),
    telegram_chat_id: data.telegram_chat_id ?? null,
    meta_access_token: decryptOrNull(data.meta_access_token_enc),
    // Pre-0052 la columna no existe (select * → undefined) ⇒ se usa la clave del
    // entorno como respaldo, que es el comportamiento anterior.
    anthropic_api_key: decryptOrNull(data.anthropic_api_key_enc),
    anthropic_model: data.anthropic_model ?? null,
    // Pre-0054 las columnas no existen (select * → undefined) ⇒ integración
    // apagada, que es exactamente el comportamiento anterior.
    aliclik_api_token: decryptOrNull(data.aliclik_api_token_enc),
    aliclik_webhook_secret: decryptOrNull(data.aliclik_webhook_secret_enc),
    aliclik_enabled: data.aliclik_enabled ?? false,
    meta_ad_accounts: normalizeMetaAdAccounts(
      data.meta_ad_accounts,
      data.meta_ad_account_id,
      data.meta_ad_account_name,
    ),
    // Pre-0166 las columnas no existen (select * → undefined) ⇒ aviso apagado.
    shalom_transit_template_enabled: data.shalom_transit_template_enabled ?? false,
    shalom_transit_template_name: data.shalom_transit_template_name ?? null,
    shalom_transit_template_language: data.shalom_transit_template_language ?? null,
    shalom_transit_params: data.shalom_transit_params ?? null,
    shalom_transit_attach_ticket: data.shalom_transit_attach_ticket ?? false,
    shalom_transit_phone_number_id: data.shalom_transit_phone_number_id ?? null,
    shalom_transit_hour_start: data.shalom_transit_hour_start ?? 8,
    shalom_notice_daily_cap: data.shalom_notice_daily_cap ?? 30,
    shalom_notice_hourly_cap: data.shalom_notice_hourly_cap ?? 8,
    shalom_transit_hour_end: data.shalom_transit_hour_end ?? 21,
    shalom_transit_payment_link: data.shalom_transit_payment_link ?? null,
    shalom_arrival_template_enabled: data.shalom_arrival_template_enabled ?? false,
    shalom_arrival_template_name: data.shalom_arrival_template_name ?? null,
    shalom_arrival_params: data.shalom_arrival_params ?? null,
    shalom_arrival_attach_ticket: data.shalom_arrival_attach_ticket ?? false,
    shalom_voucher_intake_enabled: data.shalom_voucher_intake_enabled ?? false,
    shalom_pickup_key_autosend_enabled: data.shalom_pickup_key_autosend_enabled ?? false,
    olva_transit_template_enabled: data.olva_transit_template_enabled ?? false,
    olva_transit_template_name: data.olva_transit_template_name ?? null,
    olva_transit_params: data.olva_transit_params ?? null,
    olva_arrival_template_enabled: data.olva_arrival_template_enabled ?? false,
    olva_arrival_template_name: data.olva_arrival_template_name ?? null,
    olva_arrival_params: data.olva_arrival_params ?? null,
    // Pre-0242 las columnas no existen ⇒ recordatorio apagado; nombres y orden
    // de variables, espejo de los defaults de la migración.
    shalom_reminder_template_enabled: data.shalom_reminder_template_enabled ?? false,
    shalom_reminder_template_name: data.shalom_reminder_template_name ?? "guias_shalom_recordatorio",
    shalom_reminder_params: data.shalom_reminder_params ?? "nombre,agencia,guia,saldo,vence",
    olva_reminder_template_enabled: data.olva_reminder_template_enabled ?? false,
    olva_reminder_template_name: data.olva_reminder_template_name ?? "guias_olva_recordatorio",
    olva_reminder_params: data.olva_reminder_params ?? "nombre,agencia,guia,saldo,vence",
    shalom_reminder_fallback_image_url: data.shalom_reminder_fallback_image_url ?? null,
  };
}

/**
 * App propia (0271): las mismas credenciales con el token renovado si le queda
 * poco (`ownAppTokenForUse`, con su freno). Para quien leyó con
 * `renewOwnApp: false` y ya autenticó la petición. Kenku, Aurela y las tiendas
 * 'clientes' vuelven tal cual, sin consulta ni red.
 */
export async function ownAppCredsForUse(admin: SupabaseClient, creds: StoreCreds): Promise<StoreCreds> {
  if (creds.shopify_app !== OWN_APP) return creds;
  const token = await ownAppTokenForUse(
    admin,
    {
      id: creds.id,
      shopify_app: creds.shopify_app,
      status: creds.status,
      shopify_token_expires_at: creds.shopify_token_expires_at ?? null,
    },
    creds.shopify_token,
  );
  return token === creds.shopify_token ? creds : { ...creds, shopify_token: token };
}

/**
 * Las ramas del handler que aceptan un webhook firmado SOLO con el Client
 * secret anterior de una app propia. Pedidos y borradores (y un tema que se
 * ignora, que no cambia nada) siguen durante la gracia. `app/uninstalled` no:
 * deshabilita la tienda y le borra el token, y quien tuviera un secreto
 * anterior filtrado podría falsificarla (MOM §36.4). Una rama nueva queda
 * fuera hasta que alguien decida que es segura.
 */
const PREV_SECRET_ROUTES: ReadonlySet<ShopifyWebhookRoute> = new Set(["order", "draft", "ignore"]);

/**
 * La firma de un webhook de Shopify. Con el secreto de la tienda, como
 * siempre; y SOLO en una tienda con app propia, también con el Client secret
 * anterior mientras dura su gracia (MOM §36.4: tras rotarlo, Shopify firma con
 * el más viejo que no se revocó), y solo en las ramas de `PREV_SECRET_ROUTES`:
 * una desinstalación firmada solo con el anterior se rechaza (401) y Shopify
 * la reintenta. Kenku, Aurela y las tiendas 'clientes' se comprueban
 * exactamente como antes.
 */
export function verifyStoreShopifyHmac(
  rawBody: string,
  hmacHeader: string | null,
  creds: StoreCreds,
  route: ShopifyWebhookRoute,
): boolean {
  if (verifyShopifyHmac(rawBody, hmacHeader, creds.shopify_webhook_secret)) return true;
  if (creds.shopify_app !== OWN_APP || !creds.shopify_webhook_secret_prev) return false;
  if (!verifyShopifyHmac(rawBody, hmacHeader, creds.shopify_webhook_secret_prev)) return false;
  if (PREV_SECRET_ROUTES.has(route)) return true;
  // Sin secretos en el log: solo la tienda y la rama, para que soporte vea
  // por qué una desinstalación no la deshabilitó.
  console.warn(`[shopify-own-app] ${JSON.stringify({ webhook: route, rechazado: "firmado_con_secreto_anterior", storeId: creds.id })}`);
  return false;
}

/** Map a Kapso phone-number record → a `whatsapp_numbers` label row. `kind` is
 *  normalized to our 'api' | 'business' | 'sandbox' vocabulary: a sandbox number
 *  stays sandbox; a coexistence (Business app) number is 'business'; anything
 *  else on Cloud API is 'api'. */
export function mapKapsoNumber(
  n: KapsoPhoneNumber,
): { phone_number_id: string; name: string | null; display_phone: string | null; kind: string } | null {
  const id = n.phone_number_id ? String(n.phone_number_id) : null;
  if (!id) return null;
  const kind = n.kind === "sandbox" ? "sandbox" : n.is_coexistence ? "business" : "api";
  return {
    phone_number_id: id,
    name: n.name ?? n.verified_name ?? n.display_name ?? null,
    display_phone: n.display_phone_number ?? null,
    kind,
  };
}

/** Auto-populate the `whatsapp_numbers` label lookup from Kapso (one upsert per
 *  number, keyed by phone_number_id). Returns how many were written. Best-effort:
 *  the caller swallows errors so a label refresh never fails the sync. */
export async function upsertWhatsappNumbers(
  admin: SupabaseClient,
  numbers: KapsoPhoneNumber[],
): Promise<number> {
  const rows = numbers.map(mapKapsoNumber).filter((r): r is NonNullable<typeof r> => r !== null);
  if (!rows.length) return 0;
  const { error } = await admin
    .from("whatsapp_numbers")
    .upsert(
      rows.map((r) => ({ ...r, fetched_at: new Date().toISOString() })),
      { onConflict: "phone_number_id" },
    );
  if (error) throw new Error(`upsertWhatsappNumbers: ${error.message}`);
  return rows.length;
}

/**
 * Columnas de `orders` que añade una migración posterior al código que las
 * escribe.
 *
 * POR QUÉ EXISTE ESTA LISTA. Desplegar NO aplica migraciones —el `build` es
 * `next build` a secas— así que hay una ventana, a veces de días, en la que el
 * código escribe una columna que la base todavía no tiene. Sin escalón, ese
 * upsert falla y se lleva por delante la ingesta ENTERA de pedidos: se pierde
 * todo por un campo accesorio.
 *
 * Antes esto cubría solo `discount_codes` con un `if` a medida. Se generaliza al
 * añadir `cancel_reason` (0125) porque el segundo caso demuestra que no era una
 * excepción, era un patrón.
 */
const LATE_ORDER_COLUMNS = ["discount_codes", "cancel_reason"] as const;

export async function upsertOrders(
  admin: SupabaseClient,
  rows: OrderRow[],
): Promise<void> {
  if (!rows.length) return;

  let payload: Record<string, unknown>[] = rows as unknown as Record<string, unknown>[];
  // Un intento por columna prescindible, más el inicial. El bucle termina
  // siempre: cada vuelta quita una columna de `payload`, y solo reintenta si la
  // columna que Postgres nombra sigue presente.
  for (let intento = 0; intento <= LATE_ORDER_COLUMNS.length; intento++) {
    const { error } = await admin
      .from("orders")
      .upsert(payload, { onConflict: "store_id,shopify_order_id" });
    if (!error) return;

    const faltante = LATE_ORDER_COLUMNS.find(
      (col) => error.message.includes(col) && payload.some((row) => col in row),
    );
    if (!faltante) throw new Error(`upsertOrders: ${error.message}`);

    // Se sigue sin ese campo: el pedido entra igual y solo se pierde el dato
    // accesorio hasta que la migración corra. Deja rastro, porque un dato que
    // desaparece en silencio es exactamente lo que cuesta encontrar después.
    console.error(`upsertOrders: la base aún no tiene "${faltante}"; se ingiere sin ese campo`);
    payload = payload.map(({ [faltante]: _drop, ...resto }) => resto);
  }
  throw new Error("upsertOrders: no se pudo insertar ni quitando las columnas opcionales");
}

export async function upsertDraftOrders(
  admin: SupabaseClient,
  rows: DraftOrderRow[],
): Promise<void> {
  if (!rows.length) return;
  const { error } = await admin
    .from("draft_orders")
    .upsert(rows, { onConflict: "store_id,shopify_draft_order_id" });
  if (error) throw new Error(`upsertDraftOrders: ${error.message}`);
}

export async function upsertConversations(
  admin: SupabaseClient,
  rows: ConversationRow[],
): Promise<void> {
  if (!rows.length) return;
  const { error } = await admin
    .from("conversations")
    .upsert(rows, { onConflict: "store_id,kapso_conversation_id" });
  if (error) throw new Error(`upsertConversations: ${error.message}`);
}

export async function recomputeRollups(
  admin: SupabaseClient,
  storeId: string,
  from: string,
  to: string,
): Promise<void> {
  const { error } = await admin.rpc("recompute_daily_rollups", {
    p_store_id: storeId,
    p_from: from,
    p_to: to,
  });
  if (error) throw new Error(`recompute_daily_rollups: ${error.message}`);
}

// ─── El cursor de cada sincronización sobrevive a sus errores (02-10-2026) ────
//
// Cada pasada (shopify, shopify_all, shopify_drafts, kapso) guarda hasta dónde
// llegó en `sync_state.cursor`, y la siguiente sigue desde ahí. Sin cursor se
// pide TODO: todos los pedidos tag:kapso, todos los de la tienda desde
// ORDERS_SYNC_FROM, todas las conversaciones de Kapso.
//
// Dos cosas lo dejaban en blanco justo cuando la base estaba mal, y ambas
// amplificaban la caída del 01-10-2026:
//
// - Al fallar, cada `catch` escribía `cursor: null`. Una pasada que fallaba
//   por un timeout hacía que la siguiente recorriera todo desde el principio:
//   más carga sobre una base que ya no daba abasto, más timeouts, más pasadas
//   desde cero. Ahora el error se registra con recordSyncError, que no toca el
//   cursor: la siguiente reintenta desde el mismo punto.
// - getSyncCursor tomaba un error de lectura por «no hay cursor» y la pasada
//   arrancaba desde cero. Ahora lanza, y el `catch` de la sección lo registra.

export async function getSyncCursor(
  admin: SupabaseClient,
  storeId: string,
  source: string,
): Promise<string | null> {
  const { data, error } = await admin
    .from("sync_state")
    .select("cursor")
    .match({ store_id: storeId, source })
    .maybeSingle();
  if (error) throw new Error(`cursor de ${source}: ${error.message}`);
  return data?.cursor ?? null;
}

/**
 * Deja constancia de que la pasada `source` falló, SIN tocar su cursor: el
 * upsert no lleva la columna, así que la fila conserva el que tenía (y una fila
 * nueva queda sin cursor, como siempre).
 */
export async function recordSyncError(
  admin: SupabaseClient,
  storeId: string,
  source: string,
  message: string,
): Promise<void> {
  await admin.from("sync_state").upsert(
    { store_id: storeId, source, last_run_at: new Date().toISOString(), status: "error", error: message },
    { onConflict: "store_id,source" },
  );
}

const AB_SYNC_SOURCE = "auto_ab";
const AB_ENROLL_EVERY_MIN = 20;

/**
 * ¿Toca inscribir en la prueba A/B? Una vez cada AB_ENROLL_EVERY_MIN por tienda.
 * Un error al fallar también cuenta como pasada: si la consulta revienta, no se
 * reintenta cada 5 minutos contra una base que quizá ya va cargada.
 */
async function abEnrollDue(admin: SupabaseClient, storeId: string): Promise<boolean> {
  const { data } = await admin
    .from("sync_state")
    .select("last_run_at")
    .match({ store_id: storeId, source: AB_SYNC_SOURCE })
    .maybeSingle();
  const last = Date.parse((data as { last_run_at?: string | null } | null)?.last_run_at ?? "");
  return !Number.isFinite(last) || Date.now() - last >= AB_ENROLL_EVERY_MIN * 60_000;
}

/** Una pasada terminó bien: avanza el cursor hasta donde llegó y limpia el error. */
async function recordSyncOk(
  admin: SupabaseClient,
  storeId: string,
  source: string,
  cursor: string | null,
): Promise<void> {
  await admin.from("sync_state").upsert(
    { store_id: storeId, source, cursor, last_run_at: new Date().toISOString(), status: "ok", error: null },
    { onConflict: "store_id,source" },
  );
}

// ---------------------------------------------------------------------------
// Webhook processing (HMAC + idempotency)
// ---------------------------------------------------------------------------

export type WebhookStatus = "ok" | "duplicate" | "unauthorized" | "error";
export interface WebhookResult {
  status: WebhookStatus;
  message?: string;
}

export interface ProcessWebhookParams {
  storeId: string;
  topic: string;
  rawBody: string;
  hmacHeader: string | null;
  webhookIdHeader?: string | null;
}

/**
 * Verify a Shopify webhook (HMAC), parse it, then route by topic: orders/* →
 * processOrderWebhook (upsert kapso order, recompute the day, link won);
 * draft_orders/* → processDraftOrderWebhook (upsert draft, (re)link the cart
 * lead). Idempotent: re-delivering the same webhook (same X-Shopify-Webhook-Id,
 * or identical body) is a no-op returning "duplicate".
 */
export async function processShopifyWebhook(
  params: ProcessWebhookParams,
  admin: SupabaseClient = createAdminSupabase(),
): Promise<WebhookResult> {
  // Sin renovar el token de una app propia: la firma todavía no se comprobó
  // (0271). El único camino que usa Shopify (borradores) lo renueva después.
  const creds = await getStoreCreds(params.storeId, admin, { renewOwnApp: false });
  if (!creds) return { status: "error", message: "unknown store" };

  // La rama se sabe antes de la firma: el secreto anterior de una app propia
  // no vale para todas (MOM §36.4).
  const route = routeShopifyTopic(params.topic);
  if (!verifyStoreShopifyHmac(params.rawBody, params.hmacHeader, creds, route)) {
    return { status: "unauthorized" };
  }

  const webhookId =
    params.webhookIdHeader ||
    createHash("sha256").update(params.rawBody, "utf8").digest("hex");

  let payload: any;
  try {
    payload = JSON.parse(params.rawBody);
  } catch {
    return { status: "error", message: "invalid json" };
  }

  // Route by topic. Order topics (orders/*) and draft topics (draft_orders/*)
  // share the HMAC/idempotency/JSON prefix above, then diverge. La
  // desinstalación tiene su rama; un tema desconocido ya no entra como pedido.
  switch (route) {
    case "draft":
      return processDraftOrderWebhook(admin, creds, params, payload, webhookId);
    case "order":
      return processOrderWebhook(admin, creds, params, payload, webhookId);
    case "uninstalled":
      return processAppUninstalled(admin, params, webhookId);
    default:
      return { status: "ok", message: `tema ignorado: ${params.topic}` };
  }
}

/**
 * `app/uninstalled` (MOM §29.15.9): la tienda desinstaló la app. Queda
 * deshabilitada (los crons solo corren sobre tiendas activas) y sin token, que
 * Shopify ya revocó. No se borra nada: pedidos e historial siguen. Los datos
 * personales de sus compradores se anonimizan cuando llega el `shop/redact`.
 * En una app propia solo llega aquí firmada con el Client secret vigente,
 * nunca solo con el anterior (`verifyStoreShopifyHmac`, MOM §36.4).
 */
async function processAppUninstalled(
  admin: SupabaseClient,
  params: ProcessWebhookParams,
  webhookId: string,
): Promise<WebhookResult> {
  const { error: insErr } = await admin.from("webhook_events").insert({
    store_id: params.storeId,
    topic: params.topic,
    shopify_id: null,
    webhook_id: webhookId,
    processed: true,
  });
  if (insErr) {
    if ((insErr as any).code === "23505") return { status: "duplicate" };
    throw new Error(`webhook_events insert: ${insErr.message}`);
  }
  const { error } = await admin
    .from("stores")
    .update({
      shopify_token_enc: null,
      status: "disabled",
      shopify_uninstalled_at: new Date().toISOString(),
    })
    .eq("id", params.storeId);
  if (error) throw new Error(`stores update: ${error.message}`);
  return { status: "ok" };
}

export interface FlowWebhookParams {
  storeId: string;
  secretHeader: string | null;
  rawBody: string;
}

/** Constant-time compare of the X-RecoverOps-Secret header vs the store secret. */
function verifyFlowSecret(provided: string | null | undefined, expected: string | null): boolean {
  if (!expected || !provided) return false;
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Best-effort: record a REJECTED Flow webhook (bad secret / bad payload) in
 *  `webhook_events` so it shows in the store's webhook log — invaluable for
 *  debugging a 401/400 without guessing. Deduped by a body hash so a retried bad
 *  request doesn't pile up. (Logs unauthenticated POSTs to a valid store's flow
 *  URL; acceptable since the storeId is semi-secret.) Never throws. */
async function recordFlowRejection(
  admin: SupabaseClient,
  storeId: string,
  rawBody: string,
  topic: string,
  error: string,
): Promise<void> {
  try {
    const webhookId = "rej-" + createHash("sha256").update(rawBody, "utf8").digest("hex").slice(0, 40);
    await admin
      .from("webhook_events")
      .insert({ store_id: storeId, topic, shopify_id: null, webhook_id: webhookId, processed: false, error });
  } catch {
    /* logging is best-effort — never let it affect the webhook response */
  }
}

/**
 * Authenticate + route an inbound Shopify Flow webhook (shared per-store secret
 * in the X-RecoverOps-Secret header). Routes by `body.source`:
 * `abandoned_browse` (Búsquedas abandonadas) → processBrowseAbandonment;
 * `winback` (Recuperación de clientes 60d) → processWinback. Unknown sources
 * are accepted (no Flow retry) and ignored — extensible to more events.
 */
export async function processFlowWebhook(
  params: FlowWebhookParams,
  admin: SupabaseClient = createAdminSupabase(),
): Promise<WebhookResult> {
  // Shopify Flow no usa el token de Shopify: nunca renueva el de una app propia.
  const creds = await getStoreCreds(params.storeId, admin, { renewOwnApp: false });
  if (!creds) return { status: "error", message: "unknown store" };
  if (!verifyFlowSecret(params.secretHeader, creds.flow_webhook_secret)) {
    await recordFlowRejection(
      admin,
      params.storeId,
      params.rawBody,
      "flow/unauthorized",
      "Secreto X-RecoverOps-Secret inválido o ausente",
    );
    return { status: "unauthorized" };
  }

  let payload: any;
  try {
    payload = JSON.parse(params.rawBody);
  } catch {
    await recordFlowRejection(admin, params.storeId, params.rawBody, "flow/bad_request", "El body no es JSON válido");
    return { status: "error", message: "invalid json" };
  }

  if (String(payload?.source ?? "") === "abandoned_browse") {
    return processBrowseAbandonment(admin, params.storeId, payload, creds);
  }
  if (String(payload?.source ?? "") === "winback") {
    return processWinback(admin, params.storeId, payload, creds);
  }
  return { status: "ok" }; // unknown Flow source — accept + ignore
}

// ---------------------------------------------------------------------------
// Kapso webhook (per-store secret + tenant isolation)
// ---------------------------------------------------------------------------

export interface KapsoWebhookParams {
  storeId: string;
  /** Secret from the `?secret=` query param on the webhook URL. */
  providedSecret: string | null;
  /** The `X-Webhook-Event` header (used to classify the event). */
  eventHeader: string | null;
  body: any;
}

export interface KapsoWebhookResult {
  status: "ok" | "unauthorized";
  kind?: string;
  reason?: string;
}

/** Constant-time string compare (equal-length gate first, then timingSafeEqual). */
function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * Authorize a Kapso webhook call. A store's OWN secret is authoritative: once
 * `perStoreSecret` is set, only it is accepted (the shared CRON_SECRET no longer
 * authorizes writes to that store, closing the cross-tenant injection hole).
 * Stores that have not set a per-store secret yet fall back to `cronSecret` so
 * existing wiring keeps working during migration. Pure + unit-tested.
 */
export function authorizeKapsoWebhook(
  provided: string | null | undefined,
  perStoreSecret: string | null,
  cronSecret: string | null,
): boolean {
  const expected = perStoreSecret ?? cronSecret;
  if (!expected || !provided) return false;
  return constantTimeEquals(provided, expected);
}

/**
 * Authenticate + dispatch an inbound Kapso webhook for a single store. Loads the
 * store's per-store secret, authorizes (see authorizeKapsoWebhook), then routes:
 * a Platform `workflow.execution.handoff` → hot lead; a WhatsApp
 * `conversation.ended/inactive` → abandono lead; message events are acked and
 * ignored. All writes are scoped to `storeId` by the callees.
 */
/**
 * Load a store and authorize a Kapso webhook request against its per-store
 * secret (with the CRON_SECRET fallback). Returns the decrypted creds when the
 * caller is authorized, or null when the store is unknown OR the secret is
 * wrong — callers must not distinguish the two (no store enumeration). Shared by
 * the POST handler and the GET validation ping.
 */
export async function authorizeKapsoRequest(
  storeId: string,
  providedSecret: string | null,
  admin: SupabaseClient = createAdminSupabase(),
): Promise<StoreCreds | null> {
  // Los webhooks de Kapso no usan el token de Shopify, y aquí el secreto aún no
  // se comprobó: nunca renueva el de una app propia (0271).
  const creds = await getStoreCreds(storeId, admin, { renewOwnApp: false });
  if (!creds) return null;
  // Only need the shared CRON_SECRET as a fallback when this store has no secret
  // of its own; read it lazily so a per-store-secured store works even without
  // CRON_SECRET configured.
  let cronSecret: string | null = null;
  if (!creds.kapso_webhook_secret) {
    try {
      cronSecret = env.cronSecret();
    } catch {
      cronSecret = null;
    }
  }
  return authorizeKapsoWebhook(providedSecret, creds.kapso_webhook_secret, cronSecret) ? creds : null;
}

export async function processKapsoWebhook(
  params: KapsoWebhookParams,
  admin: SupabaseClient = createAdminSupabase(),
): Promise<KapsoWebhookResult> {
  const creds = await authorizeKapsoRequest(params.storeId, params.providedSecret, admin);
  // Unknown store OR bad secret → unauthorized (don't reveal which).
  if (!creds) return { status: "unauthorized" };

  const kind = classifyKapsoEvent(params.eventHeader, params.body);
  if (kind === "handoff") {
    const res = await applyHandoff(admin, params.storeId, params.body, params.eventHeader);
    return { status: "ok", kind, reason: res.reason };
  }
  if (kind === "conversation") {
    const res = await ingestConversationEvent(admin, params.storeId, params.body);
    return { status: "ok", kind, reason: res.reason };
  }
  if (kind === "message_status") {
    const events = parseWhatsappStatusEvents(params.body, params.eventHeader);
    const updated = await applyWhatsappStatusEvents(admin, params.storeId, events);
    return { status: "ok", kind, reason: `statuses:${events.length};updated:${updated}` };
  }
  if (kind === "inbound_message") {
    // Solo los botones del aviso de guía en tránsito; cualquier otro mensaje
    // entrante se ignora aquí igual que antes (el transcript viene del sync).
    const res = await handleInboundMessage(admin, params.storeId, creds, params.body);
    return { status: "ok", kind, reason: res.reason };
  }
  return { status: "ok", kind, reason: "skipped" };
}

/** orders/create|updated → upsert the kapso order, recompute the day, link won. */
async function processOrderWebhook(
  admin: SupabaseClient,
  creds: StoreCreds,
  params: ProcessWebhookParams,
  payload: any,
  webhookId: string,
): Promise<WebhookResult> {
  const row = mapRestOrder(payload, params.storeId);

  // Shopify dispara los webhooks de pedidos para TODA la tienda. El Master de
  // Pedidos necesita ese universo completo (§1: "todos los pedidos gestionados
  // por las dos tiendas"), así que ya no se descartan los que no llevan
  // `tag:kapso` — se ingestan igual.
  //
  // Lo que sigue siendo exclusivo de los pedidos del bot son los EFECTOS: los
  // rollups y el vínculo con el lead. Las métricas de ventas/embudo se calculan
  // sobre tag:kapso en `recompute_daily_rollups` y en lib/access.ts:getOrders,
  // así que ampliar la ingesta no mueve ninguna cifra histórica de esos
  // módulos. La cabecera del tablero, en cambio, cuenta todos los pedidos
  // desde la 0268 (`ventas_por_origen`, MOM §17.4).
  const isKapsoOrder = hasKapsoTag(row.tags);

  const orderId = payload?.id != null ? String(payload.id) : null;

  // Idempotency: the unique (store_id, webhook_id) guards against re-delivery.
  const { error: insErr } = await admin.from("webhook_events").insert({
    store_id: params.storeId,
    topic: params.topic,
    shopify_id: orderId,
    webhook_id: webhookId,
    processed: false,
  });
  if (insErr) {
    if ((insErr as any).code === "23505") return { status: "duplicate" };
    throw new Error(`webhook_events insert: ${insErr.message}`);
  }

  await upsertOrders(admin, [row]);

  if (isKapsoOrder && row.created_at) {
    const { date } = tzParts(row.created_at, creds.timezone);
    await recomputeRollups(admin, params.storeId, date, date);
  }

  // Link the order to its lead (won), best-effort.
  if (isKapsoOrder && row.customer_phone) {
    try {
      const { data: ord } = await admin
        .from("orders")
        .select("id")
        .eq("store_id", params.storeId)
        .eq("shopify_order_id", row.shopify_order_id)
        .maybeSingle();
      // Don't override a registered call result with an order that predates it.
      const dispAt = await lastDispositionAtByPhone(admin, params.storeId, [row.customer_phone]);
      await linkOrderToLead(admin, {
        storeId: params.storeId,
        phone: row.customer_phone,
        orderId: ord?.id ?? null,
        win: eventOverridesDisposition(row.created_at, dispAt.get(row.customer_phone)),
        orderCreatedAt: row.created_at,
      });
    } catch {
      /* best-effort */
    }
  }

  // Un pedido SIN tag `kapso` no gana el lead, pero sí saca de la cola el
  // carrito del mismo teléfono si trae uno de sus productos: la clienta lo cerró
  // por otra vía (bot de carritos, formulario web). Al instante, para que nadie
  // la llame después de comprar. Best-effort: el barrido del cron lo repite.
  if (!isKapsoOrder && row.customer_phone && !row.cancelled_at) {
    try {
      await closeCartLeadsWithOrders(admin, params.storeId, { phones: [row.customer_phone] });
    } catch {
      /* best-effort */
    }
  }

  // El pedido acaba de entrar o cambiar (incluida una anulación en Shopify, que
  // es la fuente principal del estado Anulado — §3.4): refresca su fila del Master.
  try {
    const { data: ord } = await admin
      .from("orders")
      .select("id")
      .eq("store_id", params.storeId)
      .eq("shopify_order_id", row.shopify_order_id)
      .maybeSingle();
    if (ord?.id) await recomputeOrderMasterSafe(admin, [ord.id as string]);
  } catch {
    /* best-effort: el barrido del cron lo pondrá al día */
  }

  await admin
    .from("webhook_events")
    .update({ processed: true })
    .match({ store_id: params.storeId, webhook_id: webhookId });

  return { status: "ok" };
}

/**
 * draft_orders/create|update|delete → upsert the draft + (re)link its lead. NO
 * tag:kapso filter (the Releasit COD form isn't the bot) — isCodFormDraft inside
 * linkDraftOrdersToLeads decides. delete: drop the row + clear the lead's cart
 * fields, but keep the lead (don't auto-lose it).
 */
async function processDraftOrderWebhook(
  admin: SupabaseClient,
  creds: StoreCreds,
  params: ProcessWebhookParams,
  payload: any,
  webhookId: string,
): Promise<WebhookResult> {
  const draftId = payload?.id != null ? String(payload.id) : null;

  const { error: insErr } = await admin.from("webhook_events").insert({
    store_id: params.storeId,
    topic: params.topic,
    shopify_id: draftId,
    webhook_id: webhookId,
    processed: false,
  });
  if (insErr) {
    if ((insErr as any).code === "23505") return { status: "duplicate" };
    throw new Error(`webhook_events insert: ${insErr.message}`);
  }

  if (params.topic === "draft_orders/delete") {
    if (draftId) {
      await admin
        .from("draft_orders")
        .delete()
        .match({ store_id: params.storeId, shopify_draft_order_id: draftId });
      // Clear the cart signals (only 0007 columns, always present) so the lead
      // drops out of "Con carrito"; keep the lead row itself.
      const gid = payload?.admin_graphql_api_id ?? `gid://shopify/DraftOrder/${draftId}`;
      await admin
        .from("leads")
        .update({ draft_order_gid: null, cart_value: null, cart_item_count: null, cart_summary: null })
        .eq("store_id", params.storeId)
        .eq("draft_order_gid", gid);
    }
  } else {
    const row = mapRestDraftOrder(payload, params.storeId);
    await upsertDraftOrders(admin, [row]);
    // App propia (0271): la firma ya se comprobó; ahora sí, el token renovado
    // si le queda poco. Las demás tiendas, tal cual.
    const live = await ownAppCredsForUse(admin, creds);
    const shopify = live.shopify_token ? { domain: live.shopify_domain, token: live.shopify_token } : undefined;
    const recovered = await linkDraftOrdersToLeads(admin, params.storeId, [row], shopify);
    if (recovered.length) {
      try {
        await recomputeRollups(
          admin,
          params.storeId,
          tzParts(recovered[0]!, creds.timezone).date,
          tzParts(recovered[recovered.length - 1]!, creds.timezone).date,
        );
      } catch {
        /* rollup recompute is best-effort */
      }
    }
  }

  await admin
    .from("webhook_events")
    .update({ processed: true })
    .match({ store_id: params.storeId, webhook_id: webhookId });

  return { status: "ok" };
}

// ---------------------------------------------------------------------------
// WooCommerce: webhooks de pedidos (MOM §38.11)
// ---------------------------------------------------------------------------
//
// Todo lo de aquí es APARTE del camino de Shopify: otra ruta, otra lectura de
// la tienda (solo las columnas `woo_*`), otro secreto. `processShopifyWebhook`
// y `processOrderWebhook` no se tocaron; los pasos que siguen al upsert son los
// mismos (rollups y lead si es del bot, carrito si no, fila del Master), con
// los mismos helpers.
//
// POR QUÉ CASI TODO CONTESTA 200. WooCommerce no reintenta un aviso que falló,
// y desactiva el webhook después de 5 fallos seguidos. Un 4xx/5xx no trae el
// aviso de vuelta: solo acerca la desactivación. Lo que no se pudo procesar lo
// recoge la pasada `woo_orders` (cada 5 minutos, por `modified_after`). Por eso:
//   · 200 al ping de alta, ANTES de la firma (no la trae);
//   · 401 solo a una firma que no cuadra: es lo que debe verse en WooCommerce
//     si el secreto está mal;
//   · 200 a todo lo demás, con `{ok:false}` y el motivo en el cuerpo (WooCommerce
//     lo guarda en su registro de entregas) y en `webhook_events.error`.

export type WooWebhookStatus =
  | "ok"
  | "duplicate"
  | "ping"
  | "ignored"
  | "unauthorized"
  | "unknown_store"
  | "error";

export interface WooWebhookResult {
  status: WooWebhookStatus;
  message?: string;
  /** Era el ping de alta (`webhook_id=N`). */
  ping?: boolean;
}

export interface WooWebhookParams {
  storeId: string;
  /** El cuerpo CRUDO: la firma es sobre estos bytes. */
  rawBody: string;
  /** `X-WC-Webhook-Topic`. */
  topic: string | null;
  /** `X-WC-Webhook-Resource` y `X-WC-Webhook-Event`, por si falta el tema. */
  resource?: string | null;
  event?: string | null;
  /** `X-WC-Webhook-Signature`. */
  signature: string | null;
  /** `X-WC-Webhook-Delivery-ID`: solo para `order.deleted` (ver `wooWebhookEventKey`). */
  deliveryId?: string | null;
  /** `X-WC-Webhook-Source`: el sitio que lo mandó. */
  source?: string | null;
}

/** Prefijo de lo que el webhook deja en `stores.woo_last_error`. */
const WOO_WEBHOOK_ERROR_PREFIX = "Webhook: ";
/** Prefijo de lo que la pasada deja en `stores.woo_last_error`. */
const WOO_SYNC_ERROR_PREFIX = "Sincronización: ";

/** Estado de un pedido de WooCommerce, como lo normaliza el mapeador. */
function wooStatusOf(order: { status?: unknown } | null | undefined): string {
  return String(order?.status ?? "")
    .trim()
    .toLowerCase()
    .replace(/^wc-/, "");
}

interface ExistingWooOrder {
  cancelled_at: string | null;
  updated_at: string | null;
}

/**
 * Lo que ya tienen en `orders` estos pedidos de WooCommerce: `cancelled_at`
 * (para no moverlo, MOM §38.3) y `updated_at` (para no pisar un estado más
 * nuevo con uno más viejo, `isStaleWooRow`).
 */
async function existingWooOrders(
  admin: SupabaseClient,
  storeId: string,
  orderIds: string[],
): Promise<Map<string, ExistingWooOrder>> {
  const out = new Map<string, ExistingWooOrder>();
  for (const batch of chunk([...new Set(orderIds)], 200)) {
    if (!batch.length) continue;
    const { data, error } = await admin
      .from("orders")
      .select("shopify_order_id, cancelled_at, updated_at")
      .eq("store_id", storeId)
      .in("shopify_order_id", batch);
    if (error) throw new Error(`orders (WooCommerce): ${error.message}`);
    for (const r of (data as ({ shopify_order_id: string } & ExistingWooOrder)[] | null) ?? []) {
      out.set(String(r.shopify_order_id), { cancelled_at: r.cancelled_at ?? null, updated_at: r.updated_at ?? null });
    }
  }
  return out;
}

/**
 * ¿Lo que llegó es MÁS VIEJO que lo guardado? WooCommerce entrega los webhooks
 * en segundo plano (Action Scheduler): uno puede llegar después de que la
 * sincronización ya leyó un cambio posterior, o después de otro aviso más
 * nuevo. Se compara la fecha de modificación de WooCommerce de los dos lados
 * (`updated_at` = `date_modified_gmt`); igual no es más viejo (se aplica: es
 * idempotente). Solo para WooCommerce: Shopify sigue como siempre.
 */
export function isStaleWooRow(
  row: Pick<OrderRow, "updated_at">,
  existing: Pick<ExistingWooOrder, "updated_at"> | null | undefined,
): boolean {
  const incoming = Date.parse(row.updated_at ?? "");
  const stored = Date.parse(existing?.updated_at ?? "");
  return Number.isFinite(incoming) && Number.isFinite(stored) && incoming < stored;
}

/**
 * ¿Es un anulado que nunca fue pedido? WooCommerce anula solo los pedidos que
 * quedaron `pending` sin pagar (el checkout abandonado, al vencer la reserva de
 * stock), y esos nunca entraron a Kapta (MOM §38.3). Si llega uno anulado que
 * Kapta no tiene y que nunca llegó a «processing» (`date_paid` vacío: WooCommerce
 * lo llena al pasar a «processing», también en contraentrega), no se crea: sería
 * un Anulado en el Master de algo que no fue un pedido. Uno que Kapta ya tiene
 * se anula como siempre.
 */
export function isNeverLiveCancelledWoo(
  row: Pick<OrderRow, "cancelled_at">,
  payload: Pick<WooOrder, "date_paid_gmt">,
  existing: unknown,
): boolean {
  return Boolean(row.cancelled_at) && !existing && !String(payload?.date_paid_gmt ?? "").trim();
}

type WooApplyOutcome = { applied: true; row: OrderRow } | { applied: false; message: string };

/**
 * Un pedido de WooCommerce (del webhook o releído por la API) → `orders`, con
 * el `cancelled_at` que ya tenía y sin pisar un estado más nuevo; y los mismos
 * efectos que un pedido de Shopify (`applyWooOrderEffects`).
 */
async function applyWooOrderPayload(
  admin: SupabaseClient,
  creds: WooStoreCreds & { siteKey: string },
  payload: WooOrder,
): Promise<WooApplyOutcome> {
  const id = wooOrderId(creds.siteKey, payload.id);
  const existing = (await existingWooOrders(admin, creds.id, [id])).get(id) ?? null;
  const row = mapWooOrder(
    payload,
    { id: creds.id, woo_site_key: creds.siteKey },
    { previousCancelledAt: existing?.cancelled_at ?? null },
  );
  if (!row) {
    // pending, failed, checkout-draft…: todavía no es un pedido (MOM §38.3).
    return { applied: false, message: `estado que no entra al Master: ${wooStatusOf(payload) || "(sin estado)"}` };
  }
  if (isStaleWooRow(row, existing)) {
    return { applied: false, message: "llegó un estado más viejo que el guardado: no se aplicó" };
  }
  if (isNeverLiveCancelledWoo(row, payload, existing)) {
    return { applied: false, message: "anulado sin haber llegado a ser pedido (pago no completado): no entra al Master" };
  }
  // Creado antes de que la tienda empezara a recibir pedidos de WooCommerce
  // (la historia de Shopify importada al WordPress): no es un pedido nuevo.
  if (!existing && isWooCreatedBeforeFloor(payload, wooIntakeFloor(creds, env.ordersSyncFrom()))) {
    return { applied: false, message: "creado antes de que la tienda recibiera pedidos de WooCommerce en Kapta (woo_intake_from): no entra al Master" };
  }
  await upsertOrders(admin, [row]);
  await applyWooOrderEffects(admin, creds.id, creds.timezone, row);
  return { applied: true, row };
}

/**
 * Lo que sigue al upsert de UN pedido, igual que en `processOrderWebhook`:
 * rollups del día y lead ganado si es del bot (`kapso`); si no, saca de la cola
 * el carrito del mismo teléfono; y la fila del Master.
 *
 * Exportada para el pedido que crea Kapta a pedido del bot de Kapso
 * (lib/bot-orders.ts, MOM §38.13): los mismos pasos que la entrada, por el
 * mismo código, sin esperar al webhook.
 */
export async function applyWooOrderEffects(
  admin: SupabaseClient,
  storeId: string,
  timezone: string,
  row: OrderRow,
): Promise<void> {
  const isKapsoOrder = hasKapsoTag(row.tags);
  if (isKapsoOrder && row.created_at) {
    const { date } = tzParts(row.created_at, timezone);
    await recomputeRollups(admin, storeId, date, date);
  }

  const { data: ord } = await admin
    .from("orders")
    .select("id")
    .eq("store_id", storeId)
    .eq("shopify_order_id", row.shopify_order_id)
    .maybeSingle();
  const orderUuid = (ord as { id?: string } | null)?.id ?? null;

  if (isKapsoOrder && row.customer_phone) {
    try {
      const dispAt = await lastDispositionAtByPhone(admin, storeId, [row.customer_phone]);
      await linkOrderToLead(admin, {
        storeId,
        phone: row.customer_phone,
        orderId: orderUuid,
        win: eventOverridesDisposition(row.created_at, dispAt.get(row.customer_phone)),
        orderCreatedAt: row.created_at,
      });
    } catch {
      /* best-effort, como en Shopify */
    }
  }

  if (!isKapsoOrder && row.customer_phone && !row.cancelled_at) {
    try {
      await closeCartLeadsWithOrders(admin, storeId, { phones: [row.customer_phone] });
    } catch {
      /* best-effort: el barrido del cron lo repite */
    }
  }

  if (orderUuid) {
    try {
      await recomputeOrderMasterSafe(admin, [orderUuid]);
    } catch {
      /* best-effort: el barrido del cron lo pondrá al día */
    }
  }
}

/**
 * `order.deleted`: WooCommerce lo manda al mandar el pedido a la papelera, y su
 * cuerpo es solo `{id}`. Kapta NUNCA borra el pedido (MOM §2 punto 6, §38.3).
 *
 * Primero vuelve a leer el pedido por la API (`GET /orders/{id}`, que también
 * devuelve los de la papelera): así entra con su estado y su fecha de
 * WooCommerce, y un aviso que llegó tarde (el pedido ya volvió de la papelera)
 * no lo anula. Si la tienda no tiene claves de la API, o WooCommerce no
 * contesta, o el pedido ya no existe, lo marca anulado como un `trash`
 * (`markWooOrderDeleted`). Si sale de la papelera llega `order.restored` con el
 * pedido entero, y el mapeador lo deja vivo otra vez.
 */
async function processWooOrderDeleted(
  admin: SupabaseClient,
  creds: WooStoreCreds & { siteKey: string },
  wooId: unknown,
  orderId: string,
  fetchImpl?: typeof fetch,
): Promise<string | undefined> {
  // Un pedido que Kapta no tiene no se crea desde la papelera: o nunca fue
  // pedido (un pendiente sin pagar) o ya se perdió su historia. Nada que marcar.
  const known = (await existingWooOrders(admin, creds.id, [orderId])).get(orderId);
  if (!known) return "el pedido no estaba en Kapta";
  if (hasWooApiCredentials(creds)) {
    try {
      const { value: live } = await withWooAuthFallback(
        wooClientOpts(creds, fetchImpl ? { fetchImpl } : {}),
        (o) => fetchWooOrder(o, wooId as number),
      );
      if (String(live?.id ?? "") !== String(wooId)) throw new Error("WooCommerce devolvió otro pedido");
      if (WOO_CANCELLED_STATUSES.includes(wooStatusOf(live))) {
        const out = await applyWooOrderPayload(admin, creds, live);
        if (out.applied) return undefined;
        // Un estado más viejo o que no entra: se marca igual, como en la papelera.
      } else {
        // Ya volvió de la papelera (o nunca fue): manda lo que dice WooCommerce.
        const out = await applyWooOrderPayload(admin, creds, live);
        return out.applied ? "el pedido ya no está en la papelera: se aplicó su estado actual" : out.message;
      }
    } catch {
      /* sin API (o borrado del todo): se marca con lo que se sabe */
    }
  }
  const outcome = await markWooOrderDeleted(admin, creds.id, orderId);
  return outcome === "absent" ? "el pedido no estaba en Kapta" : undefined;
}

/** Marca anulado un pedido que fue a la papelera, sin borrarlo. */
async function markWooOrderDeleted(
  admin: SupabaseClient,
  storeId: string,
  orderId: string,
): Promise<"marked" | "already" | "absent"> {
  const { data, error } = await admin
    .from("orders")
    .select("id, cancelled_at")
    .eq("store_id", storeId)
    .eq("shopify_order_id", orderId)
    .maybeSingle();
  if (error) throw new Error(`orders (papelera): ${error.message}`);
  const row = data as { id: string; cancelled_at: string | null } | null;
  if (!row) return "absent";
  let outcome: "marked" | "already" = "already";
  if (!row.cancelled_at) {
    const { error: upErr } = await admin
      .from("orders")
      .update({ cancelled_at: new Date().toISOString(), financial_status: "voided" })
      .eq("id", row.id)
      .is("cancelled_at", null);
    if (upErr) throw new Error(`orders (papelera): ${upErr.message}`);
    outcome = "marked";
  }
  try {
    await recomputeOrderMasterSafe(admin, [row.id]);
  } catch {
    /* best-effort */
  }
  return outcome;
}

/**
 * Un webhook de WooCommerce (`/api/webhooks/woocommerce/[storeId]`), en este
 * orden: el ping de alta; la tienda y su secreto; la firma
 * (`X-WC-Webhook-Signature`); que venga del sitio guardado; el tema; y el aviso
 * repetido (sha256 del cuerpo en `webhook_events`, `wooWebhookEventKey`).
 * `order.created`, `order.updated` y `order.restored` pasan por `mapWooOrder` y
 * `upsertOrders`; `order.deleted` marca, no borra.
 */
export async function processWooWebhook(
  params: WooWebhookParams,
  admin: SupabaseClient = createAdminSupabase(),
  opts: { fetchImpl?: typeof fetch } = {},
): Promise<WooWebhookResult> {
  // 1) El ping de alta (`webhook_id=N`, en formulario, SIN firma). Si no recibe
  //    un 200, WooCommerce no activa el webhook. Solo se mira que la tienda
  //    exista: un 404 en la pantalla de WooCommerce delata una dirección mal
  //    pegada en el momento de crearlo, no días después.
  if (parseWooWebhookPing(params.rawBody) != null) {
    const { creds, error } = await loadWooStoreCreds(admin, params.storeId);
    if (error) return { status: "error", message: "No se pudo leer la tienda.", ping: true };
    if (!creds) return { status: "unknown_store", ping: true };
    return { status: "ping", ping: true };
  }

  const { creds, error } = await loadWooStoreCreds(admin, params.storeId);
  if (error) {
    console.error(`[woo-webhook] ${JSON.stringify({ storeId: params.storeId, paso: "tienda", error })}`);
    return { status: "error", message: "No se pudo leer la tienda." };
  }
  if (!creds) return { status: "ignored", message: "tienda desconocida" };

  // 2) Sin secreto no hay cómo saber quién lo manda: no se procesa. Este paso
  //    va ANTES de la firma, así que cualquiera que sepa el id de una tienda
  //    llega aquí: solo una tienda que ya tiene su sitio WooCommerce guardado
  //    (en plena puesta en marcha) deja el aviso en Ajustes. En una tienda solo
  //    de Shopify, como Kenku o Aurela hoy, nada se escribe. La pasada trae
  //    igual el pedido.
  if (!creds.webhookSecret) {
    if (creds.siteUrl) {
      await recordWooLastError(
        admin,
        creds.id,
        `${WOO_WEBHOOK_ERROR_PREFIX}llegó un aviso de WooCommerce, pero la tienda no tiene guardado el secreto de los webhooks${creds.undecryptable.includes("woo_webhook_secret_enc") ? " (el guardado no se pudo descifrar)" : ""}. Guárdalo en Ajustes → WooCommerce.`,
        creds.lastError,
      );
    }
    return { status: "ignored", message: "la tienda no tiene el secreto de los webhooks" };
  }

  // 3) La firma: HMAC-SHA256 del cuerpo crudo, en base64.
  if (!verifyWooSignature(params.rawBody, params.signature, creds.webhookSecret)) {
    return { status: "unauthorized" };
  }

  // 4) Firmado, pero de otro sitio (un sitio de prueba con el mismo secreto):
  //    sus pedidos no van al Master.
  if (!wooSourceMatchesSite(params.source, creds.siteUrl)) {
    await recordWooLastError(
      admin,
      creds.id,
      `${WOO_WEBHOOK_ERROR_PREFIX}llegó un aviso firmado desde ${wooHostOf(params.source)}, que no es el sitio guardado (${wooHostOf(creds.siteUrl)}). No se procesó.`,
      creds.lastError,
    );
    return { status: "ignored", message: "el aviso viene de otro sitio" };
  }

  // 5) Solo los temas de pedidos.
  const topic = wooWebhookTopic(params.topic, params.resource, params.event);
  if (!isWooIntakeTopic(topic)) return { status: "ignored", message: `tema ignorado: ${topic || "(sin tema)"}` };

  if (!creds.siteKey) {
    await recordWooLastError(
      admin,
      creds.id,
      `${WOO_WEBHOOK_ERROR_PREFIX}la tienda no tiene la clave del sitio (woo_site_key): sin ella los pedidos no tienen id. Guárdala en Ajustes → WooCommerce.`,
      creds.lastError,
    );
    return { status: "ignored", message: "la tienda no tiene la clave del sitio" };
  }

  let payload: WooOrder;
  try {
    payload = JSON.parse(params.rawBody) as WooOrder;
  } catch {
    return { status: "ignored", message: "el cuerpo no es JSON" };
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { status: "ignored", message: "el cuerpo no es un pedido" };
  }
  let orderId: string;
  try {
    orderId = wooOrderId(creds.siteKey, payload.id);
  } catch {
    return { status: "ignored", message: "el pedido no trae un id válido" };
  }

  // 6) El aviso repetido: la clave única (store_id, webhook_id).
  const webhookId = wooWebhookEventKey(topic, params.rawBody, params.deliveryId);
  const { error: insErr } = await admin.from("webhook_events").insert({
    store_id: creds.id,
    topic,
    shopify_id: orderId,
    webhook_id: webhookId,
    processed: false,
  });
  if (insErr) {
    if ((insErr as any).code === "23505") return { status: "duplicate" };
    console.error(`[woo-webhook] ${JSON.stringify({ storeId: creds.id, topic, paso: "webhook_events", error: insErr.message })}`);
    return { status: "error", message: "No se pudo registrar el aviso." };
  }

  let message: string | undefined;
  const store = { ...creds, siteKey: creds.siteKey };
  try {
    if (topic === "order.deleted") {
      message = await processWooOrderDeleted(admin, store, payload.id, orderId, opts.fetchImpl);
    } else {
      const out = await applyWooOrderPayload(admin, store, payload);
      if (!out.applied) message = out.message;
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[woo-webhook] ${JSON.stringify({ storeId: creds.id, topic, orderId, error: msg })}`);
    try {
      await admin
        .from("webhook_events")
        .update({ error: msg.slice(0, 500) })
        .match({ store_id: creds.id, webhook_id: webhookId });
    } catch {
      /* best-effort */
    }
    return { status: "error", message: msg };
  }

  await admin
    .from("webhook_events")
    .update({ processed: true })
    .match({ store_id: creds.id, webhook_id: webhookId });
  // Un aviso que entró bien borra el aviso que dejó un webhook anterior (no el
  // de la sincronización: ese lo limpia la pasada).
  if (creds.lastError?.startsWith(WOO_WEBHOOK_ERROR_PREFIX)) {
    await recordWooLastError(admin, creds.id, null, creds.lastError);
  }
  return message ? { status: "ok", message } : { status: "ok" };
}

// ---------------------------------------------------------------------------
// WooCommerce: la pasada `woo_orders` de la sincronización (MOM §38.11)
// ---------------------------------------------------------------------------

export interface WooSyncResult {
  /** Corrió: la tienda tiene sitio, clave y las dos claves de la API. */
  ran: boolean;
  /** Pedidos que entraron o se actualizaron en `orders`. */
  orders: number;
  /** Pedidos leídos que no entran (`pending`, `failed`, `checkout-draft`…) o sin id válido. */
  skipped: number;
  pages: number;
  /** Hasta dónde llegó (el `date_modified` más nuevo leído), o el de antes. */
  cursor: string | null;
  /** Llegó al final (si no, paró por el tope de páginas o el reloj y sigue en la próxima). */
  done: boolean;
  error: string | null;
  /** Días (en la zona de la tienda) con pedidos del bot: para los rollups. */
  kapsoDates: string[];
}

export interface WooSyncOptions {
  fetchImpl?: typeof fetch;
  /** Reloj, para las pruebas. */
  now?: () => number;
  budgetMs?: number;
  maxPages?: number;
  perPage?: number;
  /**
   * Desde dónde pide la primera pasada (`modified_after`); por defecto el piso
   * de la tienda (`wooIntakeFloor`: `woo_intake_from`, `platform_switched_at` o
   * `ORDERS_SYNC_FROM`).
   */
  floor?: string;
}

/**
 * `sync_state` de la pasada, sin escribir nunca un cursor nulo (ver
 * `recordSyncError`). `warning`: corrió sin fallar pero no avanzó.
 */
async function recordWooSyncState(
  admin: SupabaseClient,
  storeId: string,
  cursor: string | null,
  error: string | null,
  status: "ok" | "error" | "warning" = error ? "error" : "ok",
): Promise<void> {
  const row: Record<string, unknown> = {
    store_id: storeId,
    source: WOO_SYNC_SOURCE,
    last_run_at: new Date().toISOString(),
    status,
    error,
  };
  if (cursor) row.cursor = cursor;
  await admin.from("sync_state").upsert(row, { onConflict: "store_id,source" });
}

/** Una página de pedidos de WooCommerce → `orders`, con los efectos del lote. */
async function applyWooOrdersPage(
  admin: SupabaseClient,
  creds: WooStoreCreds & { siteKey: string },
  items: WooOrder[],
): Promise<{ upserted: number; skipped: number; kapsoDates: string[] }> {
  const storeId = creds.id;
  const store = { id: storeId, woo_site_key: creds.siteKey };
  const ids: string[] = [];
  for (const o of items) {
    try {
      ids.push(wooOrderId(creds.siteKey, o?.id));
    } catch {
      /* sin id válido: se cuenta abajo */
    }
  }
  const existing = ids.length ? await existingWooOrders(admin, storeId, ids) : new Map<string, ExistingWooOrder>();
  const floor = wooIntakeFloor(creds, env.ordersSyncFrom());

  const byId = new Map<string, OrderRow>();
  let skipped = 0;
  for (const o of items) {
    let row: OrderRow | null;
    let before: ExistingWooOrder | null = null;
    try {
      const id = wooOrderId(creds.siteKey, o?.id);
      before = existing.get(id) ?? null;
      row = mapWooOrder(o, store, { previousCancelledAt: before?.cancelled_at ?? null });
    } catch {
      row = null;
    }
    // Lo que no entra, lo que un webhook ya dejó más nuevo entre la lectura y
    // ahora, el anulado que nunca fue pedido y lo creado antes del piso de la
    // tienda que Kapta no tiene (la historia importada), no se escribe.
    if (
      !row ||
      isStaleWooRow(row, before) ||
      isNeverLiveCancelledWoo(row, o, before) ||
      (!before && isWooCreatedBeforeFloor(o, floor))
    ) {
      skipped++;
      continue;
    }
    // Con la llave por fecha una página puede repetir un pedido de la anterior,
    // nunca dentro de la misma; aun así, uno por id (un upsert con dos filas de
    // la misma clave falla entero).
    byId.set(row.shopify_order_id, row);
  }
  const rows = [...byId.values()];
  if (!rows.length) return { upserted: 0, skipped, kapsoDates: [] };

  await upsertOrders(admin, rows);

  // Pedidos del bot → lead ganado (como la pasada tag:kapso de Shopify).
  const kapso = rows.filter((r) => hasKapsoTag(r.tags));
  if (kapso.length) await linkOrdersToLeads(admin, storeId, kapso);
  const kapsoDates = kapso
    .filter((r) => r.created_at)
    .map((r) => tzParts(r.created_at!, creds.timezone).date);

  // La fila del Master de cada pedido tocado. Los carritos del mismo teléfono
  // los saca de la cola el paso 1c de `runStoreSync`, que corre después.
  for (const batch of chunk(rows.map((r) => r.shopify_order_id), 200)) {
    const { data } = await admin.from("orders").select("id").eq("store_id", storeId).in("shopify_order_id", batch);
    await recomputeOrderMasterSafe(
      admin,
      ((data ?? []) as { id: string }[]).map((r) => r.id),
    );
  }
  return { upserted: rows.length, skipped, kapsoDates };
}

/**
 * La red de seguridad de los webhooks de WooCommerce: los pedidos modificados
 * desde el cursor (`sync_state`, fuente `woo_orders`), del más viejo al más
 * nuevo:
 * `GET /wp-json/wc/v3/orders?modified_after=<cursor>&dates_are_gmt=true&orderby=modified&order=asc&per_page=100&page=N`.
 *
 * Solo corre en una tienda con sitio, clave del sitio y las dos claves de la
 * API. Nunca lanza: un fallo queda en `sync_state` y en `stores.woo_last_error`
 * y se devuelve en `error`, y las pasadas de Shopify, de Kapso y de los leads
 * siguen igual. Lo que avanzó antes del fallo se guarda.
 */
export async function syncWooOrders(
  admin: SupabaseClient,
  storeId: string,
  opts: WooSyncOptions = {},
): Promise<WooSyncResult> {
  const result: WooSyncResult = {
    ran: false,
    orders: 0,
    skipped: 0,
    pages: 0,
    cursor: null,
    done: false,
    error: null,
    kapsoDates: [],
  };
  const loaded = await loadWooStoreCreds(admin, storeId);
  if (loaded.error) {
    result.error = `no se pudo leer la tienda: ${loaded.error}`;
    return result;
  }
  const creds = loaded.creds;
  if (!creds) return result;
  const brokenApiSecret = creds.undecryptable.filter(
    (c) => c === "woo_consumer_key_enc" || c === "woo_consumer_secret_enc",
  );
  if (brokenApiSecret.length && creds.siteUrl && creds.siteKey) {
    result.ran = true;
    result.error = "las claves de la API de WooCommerce guardadas no se pueden descifrar: vuelve a guardarlas en Ajustes.";
    await recordWooSyncState(admin, storeId, null, result.error);
    await recordWooLastError(admin, storeId, `${WOO_SYNC_ERROR_PREFIX}${result.error}`, creds.lastError);
    return result;
  }
  if (!hasWooApiCredentials(creds)) return result;
  result.ran = true;

  const now = opts.now ?? Date.now;
  const deadline = now() + (opts.budgetMs ?? WOO_SYNC_BUDGET_MS);
  const maxPages = opts.maxPages ?? WOO_SYNC_MAX_PAGES;
  const perPage = opts.perPage ?? WOO_SYNC_PER_PAGE;
  const floor = opts.floor ?? wooIntakeFloor(creds, env.ordersSyncFrom());
  let previousCursor: string | null = null;
  let high: string | null = null;
  // La página que toca pedir. Si la pasada no llega al final, es donde sigue
  // la próxima (sin solape): ver `WooSyncCursor`.
  let req: { modifiedAfter: string; page: number } | null = null;
  try {
    previousCursor = await getSyncCursor(admin, storeId, WOO_SYNC_SOURCE);
    high = parseWooSyncCursor(previousCursor).high;
    req = wooSyncFirstRequest(previousCursor, floor);
    const startReq = req;
    let client = wooClientOpts(creds, opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {});
    const dates = new Set<string>();
    for (let n = 0; n < maxPages; n++) {
      if (n > 0 && now() >= deadline) break;
      const current: { modifiedAfter: string; page: number } = req;
      const { value: page, auth } = await withWooAuthFallback(client, (o) =>
        fetchWooOrdersPage(o, { modifiedAfter: current.modifiedAfter, page: current.page, perPage }),
      );
      client = { ...client, auth };
      result.pages++;
      const applied = await applyWooOrdersPage(admin, creds, page.items);
      result.orders += applied.upserted;
      result.skipped += applied.skipped;
      for (const d of applied.kapsoDates) dates.add(d);
      const pageMax = maxWooModified(page.items);
      high = laterIso(high, pageMax);
      if (page.items.length < perPage || (page.totalPages != null && current.page >= page.totalPages)) {
        result.done = true;
        break;
      }
      req = nextWooPage(current, pageMax);
    }
    result.kapsoDates = [...dates].sort();
    result.cursor = high;
    const cursorText = formatWooSyncCursor({ high, resume: result.done ? null : req });
    // Sin llegar al final y sin moverse de donde empezó: la pasada no avanza.
    // Que no se vea «bien».
    const stuck = !result.done && req.modifiedAfter === startReq.modifiedAfter && req.page === startReq.page;
    if (stuck) {
      const msg = `la pasada no avanzó (sigue pidiendo modified_after=${req.modifiedAfter}, página ${req.page}).`;
      result.error = msg;
      await recordWooSyncState(admin, storeId, cursorText, msg, "warning");
      await recordWooLastError(admin, storeId, `${WOO_SYNC_ERROR_PREFIX}${msg}`, creds.lastError);
    } else {
      await recordWooSyncState(admin, storeId, cursorText, null);
      if (creds.lastError?.startsWith(WOO_SYNC_ERROR_PREFIX)) {
        await recordWooLastError(admin, storeId, null, creds.lastError);
      }
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    result.error = msg;
    result.cursor = high;
    // Lo que se procesó antes del fallo no se vuelve a pedir: la próxima sigue
    // en la página que falló. Sin nada procesado, el cursor no se toca (nunca
    // retrocede ni queda en blanco).
    const progressed = result.pages > 0 && req ? formatWooSyncCursor({ high, resume: req }) : null;
    try {
      await recordWooSyncState(admin, storeId, progressed, msg);
    } catch {
      /* best-effort */
    }
    await recordWooLastError(admin, storeId, `${WOO_SYNC_ERROR_PREFIX}${msg}`, creds.lastError);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Full store sync (cron): Shopify reconciliation + Kapso pull + ops snapshot
// ---------------------------------------------------------------------------

export interface SyncReport {
  storeId: string;
  shopifyOrders: number;
  draftOrders: number;
  kapsoConversations: number;
  leads: number;
  enriched: LeadEnrichStats;
  /** Conversaciones descartadas por venir sin teléfono (no generan lead). Es el
   *  disparador de la migración de identidad de WhatsApp: mientras sea 0 no hay
   *  nada que hacer, y se sabe con certeza en vez de suponerlo. Ver
   *  SyncLeadsResult.sinTelefono. */
  leadsSinTelefono: number;
  opsCaptured: boolean;
  whatsappNumbers: number;
  archived: number;
  metaAdsResolved: number; // Meta ad_ids whose real names we resolved this run
  dripSent: number; // plantillas de seguimiento enviadas esta corrida
  cartSeqSent: number; // plantillas de carrito abandonado enviadas esta corrida
  returnRecoverySent: number; // plantillas de recuperación de devueltos enviadas
  deliveredThanksSent: number; // agradecimientos con catálogo al entregar
  restockSent: number; // recordatorios de reposición (sin contar el grupo de control)
  requeued: number; // carritos reencolados con atención (olas, máx 2 por lead)
  cartsClosedByOrder: number; // carritos que salieron de la cola porque ya son pedido
  autoOrdersGenerated: number; // pedidos de la prueba de recompra automática (0214)
  abEnrolled: number; // carritos inscritos en la prueba A/B de recompra (0238), las dos mitades
  orderMaster: number; // filas del Master reconciliadas en esta corrida
  /** Leads sin ubicación buscados en Shopify por celular, y cuántos tenían
   *  dirección (0228). Es la medida de si esta pista sirve. */
  shopifyLocations: { checked: number; found: number };
  /** Pedidos de WooCommerce que entraron o cambiaron por la pasada `woo_orders` (MOM §38.11). */
  wooOrders: number;
  errors: string[];
}

// Resolve up to this many new/stale Meta ad_ids per run (drains a backlog over a
// few runs; keeps a run's Graph API load bounded).
const META_AD_RESOLVE_CAP = 25;
// Re-resolve a cached ad older than this so its status (ACTIVE/PAUSED) stays current.
const META_AD_STALE_DAYS = 7;

/**
 * Populate the `meta_ads` lookup with real ad / adset / campaign names so the
 * "Rendimiento por anuncio" report shows the creative name instead of the shared
 * CTWA headline ("Madera Como Nueva"). Resolves this store's meta_ad lead ad_ids
 * that aren't cached yet (or are stale) via the Meta Graph API, then upserts.
 * Best-effort; returns how many rows it resolved. Never throws.
 */
export async function resolveMetaAdNames(
  admin: SupabaseClient,
  storeId: string,
  token: string,
  opts?: { fetchImpl?: typeof fetch },
): Promise<number> {
  if (!token) return 0;
  const { data: leadAds } = await admin
    .from("leads")
    .select("ad_id")
    .eq("store_id", storeId)
    .eq("source", "meta_ad")
    .not("ad_id", "is", null)
    .limit(2000);
  const adIds = [
    ...new Set(((leadAds as { ad_id: string | null }[]) ?? []).map((l) => l.ad_id).filter((x): x is string => !!x)),
  ];
  if (!adIds.length) return 0;

  // Which are already cached AND fresh? (meta_ads is global — creative names
  // aren't store-scoped.) Missing or stale ids get (re)resolved.
  const { data: cached } = await admin.from("meta_ads").select("ad_id, fetched_at").in("ad_id", adIds);
  const staleCut = Date.now() - META_AD_STALE_DAYS * 86_400_000;
  const fresh = new Set<string>();
  for (const r of (cached as { ad_id: string; fetched_at: string | null }[]) ?? []) {
    if (r.fetched_at && new Date(r.fetched_at).getTime() > staleCut) fresh.add(r.ad_id);
  }
  const toResolve = adIds.filter((id) => !fresh.has(id)).slice(0, META_AD_RESOLVE_CAP);
  if (!toResolve.length) return 0;

  const rows = await fetchMetaAdMeta(token, toResolve, opts);
  if (!rows.length) return 0;
  const now = new Date().toISOString();
  await admin.from("meta_ads").upsert(
    rows.map((r) => ({ ...r, fetched_at: now })),
    { onConflict: "ad_id" },
  );
  return rows.length;
}

export async function runStoreSync(
  storeId: string,
  admin: SupabaseClient = createAdminSupabase(),
  opts: { skipMasterReconcile?: boolean } = {},
): Promise<SyncReport> {
  const report: SyncReport = {
    storeId,
    shopifyOrders: 0,
    draftOrders: 0,
    kapsoConversations: 0,
    leads: 0,
    enriched: { candidates: 0, fetched: 0, inbound: 0, cart: 0, district: 0, yape: 0, visionChecks: 0 },
    leadsSinTelefono: 0,
    opsCaptured: false,
    whatsappNumbers: 0,
    archived: 0,
    metaAdsResolved: 0,
    dripSent: 0,
    cartSeqSent: 0,
    returnRecoverySent: 0,
    deliveredThanksSent: 0,
    restockSent: 0,
    requeued: 0,
    cartsClosedByOrder: 0,
    autoOrdersGenerated: 0,
    abEnrolled: 0,
    orderMaster: 0,
    shopifyLocations: { checked: 0, found: 0 },
    wooOrders: 0,
    errors: [],
  };
  const creds = await getStoreCreds(storeId, admin);
  if (!creds) {
    report.errors.push("unknown store");
    return report;
  }
  const affectedDates = new Set<string>();

  // 1) Shopify reconciliation (tag:kapso, bounded by updated_at cursor)
  if (creds.shopify_token) {
    try {
      const cursor = await getSyncCursor(admin, storeId, "shopify");
      const searchQuery = buildKapsoOrdersSearchQuery(cursor);
      let after: string | null = null;
      let maxUpdatedAt = cursor;
      for (let i = 0; i < 50; i++) {
        const page = await fetchOrdersPage({
          domain: creds.shopify_domain,
          token: creds.shopify_token,
          storeId,
          searchQuery,
          after,
        });
        if (page.orders.length) {
          await upsertOrders(admin, page.orders);
          await linkOrdersToLeads(admin, storeId, page.orders); // order → lead (won)
          report.shopifyOrders += page.orders.length;
          for (const o of page.orders) {
            if (o.created_at) affectedDates.add(tzParts(o.created_at, creds.timezone).date);
          }
        }
        if (page.maxUpdatedAt && (!maxUpdatedAt || page.maxUpdatedAt > maxUpdatedAt)) {
          maxUpdatedAt = page.maxUpdatedAt;
        }
        if (!page.hasNextPage) break;
        after = page.endCursor;
      }
      await recordSyncOk(admin, storeId, "shopify", maxUpdatedAt);
    } catch (e: any) {
      report.errors.push(`shopify: ${e.message}`);
      await recordSyncError(admin, storeId, "shopify", e.message);
    }
  }

  // 1a-bis) Reconciliación SIN filtro de tag, para el Master de Pedidos.
  //     Segunda pasada con su propio cursor (`shopify_all`) para no interferir
  //     con el de la pasada tag:kapso. Trae el resto de pedidos de la tienda —
  //     los del formulario web/COD, los creados a mano — que el Master necesita
  //     y que las métricas siguen sin contar (filtran por tag:kapso).
  //     Acotada por ORDERS_SYNC_FROM para no arrastrar años de histórico.
  //     try/catch propio: si esta pasada falla, la sincronización del bot y de
  //     los leads sigue funcionando igual.
  if (creds.shopify_token) {
    try {
      const cursor = await getSyncCursor(admin, storeId, "shopify_all");
      const searchQuery = buildAllOrdersSearchQuery(cursor, env.ordersSyncFrom());
      let after: string | null = null;
      let maxUpdatedAt = cursor;
      const touched: string[] = [];
      for (let i = 0; i < 50; i++) {
        const page = await fetchOrdersPage({
          domain: creds.shopify_domain,
          token: creds.shopify_token,
          storeId,
          searchQuery,
          after,
        });
        if (page.orders.length) {
          await upsertOrders(admin, page.orders);
          report.shopifyOrders += page.orders.length;
          for (const o of page.orders) touched.push(o.shopify_order_id);
        }
        if (page.maxUpdatedAt && (!maxUpdatedAt || page.maxUpdatedAt > maxUpdatedAt)) {
          maxUpdatedAt = page.maxUpdatedAt;
        }
        if (!page.hasNextPage) break;
        after = page.endCursor;
      }
      await recordSyncOk(admin, storeId, "shopify_all", maxUpdatedAt);
      // Refresca el Master para los pedidos que acaba de tocar esta pasada.
      for (const batch of chunk(touched, 200)) {
        const { data } = await admin
          .from("orders")
          .select("id")
          .eq("store_id", storeId)
          .in("shopify_order_id", batch);
        await recomputeOrderMasterSafe(
          admin,
          ((data ?? []) as { id: string }[]).map((r) => r.id),
        );
      }
    } catch (e: any) {
      report.errors.push(`shopify_all: ${e.message}`);
      await recordSyncError(admin, storeId, "shopify_all", e.message);
    }
  }

  // 1b) Shopify draft orders (Releasit COD carts → "Con carrito" leads).
  //     Re-scan the whole DRAFT_OPEN_WINDOW_DAYS window EVERY run (not incremental):
  //     a cart created fresh is held back by the grace period in
  //     linkDraftOrdersToLeads, and re-scanning is what promotes it to a lead once
  //     it ages past the grace. The window is small (a couple of days) so a full
  //     rescan is cheap. Own try/catch: a missing read_draft_orders scope just
  //     records an error here and never breaks the orders/Kapso/leads sync.
  if (creds.shopify_token) {
    try {
      const floor = new Date(Date.now() - DRAFT_OPEN_WINDOW_DAYS * 86_400_000).toISOString();
      let maxUpdatedAt: string | null = null;
      for (const status of ["open", "completed"] as const) {
        const searchQuery = buildDraftOrdersSearchQuery(status, floor);
        let after: string | null = null;
        for (let i = 0; i < 50; i++) {
          const page = await fetchDraftOrdersPage({
            domain: creds.shopify_domain,
            token: creds.shopify_token,
            storeId,
            searchQuery,
            after,
          });
          if (page.draftOrders.length) {
            await upsertDraftOrders(admin, page.draftOrders);
            // Capture COD-recovered orders (not tag:kapso) so their revenue counts;
            // their dates feed the daily-rollup recompute below.
            const recovered = await linkDraftOrdersToLeads(admin, storeId, page.draftOrders, {
              domain: creds.shopify_domain,
              token: creds.shopify_token,
            });
            for (const iso of recovered) affectedDates.add(tzParts(iso, creds.timezone).date);
            report.draftOrders += page.draftOrders.length;
          }
          if (page.maxUpdatedAt && (!maxUpdatedAt || page.maxUpdatedAt > maxUpdatedAt)) {
            maxUpdatedAt = page.maxUpdatedAt;
          }
          if (!page.hasNextPage) break;
          after = page.endCursor;
        }
      }
      await recordSyncOk(admin, storeId, "shopify_drafts", maxUpdatedAt);
    } catch (e: any) {
      report.errors.push(`shopify_drafts: ${e.message}`);
      await recordSyncError(admin, storeId, "shopify_drafts", e.message);
    }
  }

  // 1b-bis) WooCommerce (MOM §38.11): los pedidos modificados desde el cursor
  //     `woo_orders`, la red de seguridad de sus webhooks. Solo en una tienda
  //     con sitio, clave del sitio y claves de la API guardadas; las demás (y
  //     Kenku y Aurela mientras sigan solo en Shopify) no hacen ni una llamada.
  //     No mira el token de Shopify ni lo toca: una tienda con las dos fuentes
  //     recibe las dos. Nunca lanza, tiene su propio reloj y su fallo queda en
  //     sync_state y en `stores.woo_last_error`. Va antes de 1c para que el
  //     carrito de una clienta que compró en WooCommerce salga de la cola en
  //     esta misma corrida.
  try {
    const woo = await syncWooOrders(admin, storeId);
    report.wooOrders = woo.orders;
    for (const d of woo.kapsoDates) affectedDates.add(d);
    if (woo.error) report.errors.push(`woo_orders: ${woo.error}`);
  } catch (e: any) {
    report.errors.push(`woo_orders: ${e.message}`);
  }

  // 1c) Carritos que ya son pedido. Va DESPUÉS de 1a-bis (todos los pedidos) y
  //     de 1b (carritos → leads) a propósito: 1b puede crear el lead de un
  //     carrito cuyo pedido ya llegó, y así sale de la cola en la misma corrida.
  //     No llama a Shopify, así que corre aunque falte el token.
  try {
    report.cartsClosedByOrder = await closeCartLeadsWithOrders(admin, storeId);
  } catch (e: any) {
    report.errors.push(`carritos_con_pedido: ${e.message}`);
  }

  // 1d) Prueba de pedidos automáticos de recompra (0214). Solo procesa los
  //     carritos que una persona autorizó en `auto_order_trials`; sin filas
  //     pendientes es una sola lectura. Va después de 1c para que un carrito
  //     que ya es pedido salga de la cola antes y la prueba lo omita.
  if (creds.shopify_token) {
    // 1d-0) Prueba A/B (0238): inscribe carritos nuevos y los sortea entre
    //     `auto` (el generador de abajo los convierte en pedido en esta misma
    //     corrida) y `control` (se quedan en la cola). La consulta de candidatos
    //     recorre los pedidos por teléfono, así que corre cada AB_ENROLL_EVERY_MIN
    //     y no en cada pasada de 5 minutos; sin cohorte encendida no lee nada más.
    try {
      if (await abEnrollDue(admin, storeId)) {
        const ab = await enrollAbCohorts(storeId, abDeps(admin, storeId));
        report.abEnrolled = ab.enrolledAuto + ab.enrolledControl;
        await recordSyncOk(admin, storeId, AB_SYNC_SOURCE, null);
      }
    } catch (e: any) {
      report.errors.push(`ab_recompra: ${e.message}`);
      await recordSyncError(admin, storeId, AB_SYNC_SOURCE, e.message);
    }
    try {
      const trials = await processAutoOrderTrials(
        autoTrialDeps(admin, storeId, { domain: creds.shopify_domain, token: creds.shopify_token }),
      );
      report.autoOrdersGenerated = trials.generated;
      for (const iso of trials.orderDates) affectedDates.add(tzParts(iso, creds.timezone).date);
    } catch (e: any) {
      report.errors.push(`pedidos_auto: ${e.message}`);
    }
  }

  // 2) Kapso pull (conversations since last_active cursor)
  if (creds.kapso_api_key) {
    try {
      const k = { apiKey: creds.kapso_api_key };
      const cursor = await getSyncCursor(admin, storeId, "kapso");
      const convs = await listAllConversations(k, {
        // All of the store's WhatsApp numbers (not just the send-from number) —
        // see the note in syncStoreLeads. Keeps both API + Business numbers synced.
        lastActiveAfter: cursor ?? undefined,
      });
      const rows = convs.map((c) => mapKapsoConversation(c, storeId));
      await upsertConversations(admin, rows);
      report.kapsoConversations = rows.length;
      // Best-effort: capture first-response timing for a bounded number of
      // conversations (one message page each). Written as a separate guarded
      // update so it tolerates the timing columns not existing yet (i.e. if the
      // code deploys before migration 0005 is applied) without breaking sync.
      for (const r of rows.slice(0, KAPSO_TIMING_CAP)) {
        const t = await fetchConversationSignals(k, r.kapso_conversation_id);
        if (!t) continue;
        const { error: tErr } = await admin
          .from("conversations")
          .update({ inbound_count: t.inbound_count, first_response_seconds: t.first_response_seconds })
          .eq("store_id", storeId)
          .eq("kapso_conversation_id", r.kapso_conversation_id);
        if (tErr) break; // columns missing (migration pending) or transient — stop this run
      }

      let maxTs = cursor;
      for (const r of rows) {
        const ts = r.last_message_at ?? r.started_at;
        if (ts && (!maxTs || ts > maxTs)) maxTs = ts;
        if (r.started_at) affectedDates.add(tzParts(r.started_at, creds.timezone).date);
      }
      await recordSyncOk(admin, storeId, "kapso", maxTs);
    } catch (e: any) {
      report.errors.push(`kapso: ${e.message}`);
      await recordSyncError(admin, storeId, "kapso", e.message);
    }
  }

  // 2b) Leads — build/refresh from conversations + order linkage.
  if (creds.kapso_api_key) {
    try {
      const lr = await syncStoreLeads(admin, storeId, {
        kapso_api_key: creds.kapso_api_key,
        whatsapp_phone_number_id: creds.whatsapp_phone_number_id,
      });
      report.leads = lr.touched;
      report.enriched = lr.enriched;
      report.leadsSinTelefono = lr.sinTelefono;
      // Visible en los errores del reporte para que no haya que leer un JSON:
      // el día que Meta empiece a mandar conversaciones sin teléfono, se ve.
      if (lr.sinTelefono > 0) {
        report.errors.push(
          `identidad: ${lr.sinTelefono} conversacion(es) sin telefono — no generaron lead`,
        );
      }
    } catch (e: any) {
      report.errors.push(`leads: ${e.message}`);
    }
  }

  // 2b.5) Ubicación del cliente en Shopify (0228): a los leads de la cola que no
  //       dicen dónde viven ni tienen pedido anterior, se los busca por celular
  //       con la conexión de la tienda. Va después de 2b para que un lead creado
  //       en esta misma corrida ya se pueda buscar. Acotado por corrida; si
  //       Shopify falla, corta y reintenta en la siguiente. Best-effort.
  if (creds.shopify_token) {
    try {
      const loc = await enrichLeadLocationsFromShopify(admin, storeId, {
        domain: creds.shopify_domain,
        token: creds.shopify_token,
      });
      report.shopifyLocations = { checked: loc.checked, found: loc.found };
      if (loc.error) report.errors.push(`shopify_ubicacion: ${loc.error}`);
    } catch (e: any) {
      report.errors.push(`shopify_ubicacion: ${e.message}`);
    }
  }

  // 2c) Bubble overdue follow-ups back up (needs_attention) so they don't slip.
  try {
    await flagOverdueFollowups(admin, storeId);
  } catch (e: any) {
    report.errors.push(`followups: ${e.message}`);
  }

  // 2c.5) Drip de seguimiento: plantilla WhatsApp a leads nr/buzón/cuelga sin
  //       respuesta (máx 2 toques, horario laboral). Va DESPUÉS de 2c a
  //       propósito: un seguimiento manual vencido acaba de ganar
  //       needs_attention=true y el drip lo respeta (la asesora manda sobre el
  //       bot). Gateado por Ajustes; best-effort.
  if (creds.drip_template_enabled) {
    try {
      const drip = await sendSeguimientoDrip(admin, storeId, creds);
      report.dripSent = drip.sent;
      if (drip.failed) report.errors.push(`drip: ${drip.failed} envíos fallidos`);
    } catch (e: any) {
      report.errors.push(`drip: ${e.message}`);
    }
  }

  // 2c.55) Secuencia de carritos abandonados: 2 plantillas ancladas a la
  //        creación del carrito (+3h/+24h configurables, horario local). Canal
  //        independiente del drip y de la gestión humana: solo-envío, nunca
  //        toca status/category (ver lib/cart-sequence.ts). Gateado por
  //        Ajustes; best-effort. Pre-0040 es un no-op (enabled=false).
  if (creds.cart_seq_enabled) {
    try {
      const seq = await runCartSequence(admin, storeId, creds);
      report.cartSeqSent = seq.sent;
      if (seq.failed) report.errors.push(`cart_seq: ${seq.failed} envíos fallidos`);
    } catch (e: any) {
      report.errors.push(`cart_seq: ${e.message}`);
    }
  }

  // 2c.57) Recuperación del pedido devuelto: plantilla a las clientas cuya guía
  //        de provincia volvió al almacén, proponiéndoles el reenvío por
  //        agencia con adelanto (MOM §11-§12). Doble interruptor a propósito:
  //        `enabled` habilita la cola y el botón, `auto` es el que deja enviar
  //        sin que nadie mire — el mensaje pide plata por adelantado. Los que
  //        rechazaron el producto en la puerta quedan fuera por regla del MOM.
  //        Best-effort. Pre-0112 es un no-op (auto=false).
  if (creds.return_recovery_auto) {
    try {
      const rec = await runReturnRecovery(admin, storeId, creds);
      report.returnRecoverySent = rec.sent;
      if (rec.failed) report.errors.push(`return_recovery: ${rec.failed} envíos fallidos`);
    } catch (e: any) {
      report.errors.push(`return_recovery: ${e.message}`);
    }
  }

  // 2c.58) Agradecimiento con catálogo al entregar: plantilla de marketing a
  //         la clienta cuyo pedido acaba de pasar a entregado. Una vez por
  //         pedido y por clienta cada 7 días, con tope por corrida y horario:
  //         una importación que marca 200 entregas de golpe no puede volverse
  //         200 plantillas en un minuto. Apagado por defecto. Best-effort.
  if (creds.delivered_thanks_enabled) {
    try {
      const thanks = await runDeliveredThanks(admin, storeId, creds);
      report.deliveredThanksSent = thanks.sent;
      if (thanks.failed) report.errors.push(`delivered_thanks: ${thanks.failed} envíos fallidos`);
    } catch (e: any) {
      report.errors.push(`delivered_thanks: ${e.message}`);
    }
  }

  // 2c.59) Recordatorio de reposición (MOM §34): a la clienta a la que se le
  //         está por acabar lo que compró, con su grupo de control. Mismo ritmo
  //         y horario que el agradecimiento. Apagado por defecto. Best-effort.
  if (creds.restock_enabled) {
    try {
      const restock = await runRestockReminders(admin, storeId, creds);
      report.restockSent = restock.sent;
      if (restock.failed) report.errors.push(`restock: ${restock.failed} envíos fallidos`);
    } catch (e: any) {
      report.errors.push(`restock: ${e.message}`);
    }
    // Las respuestas que el webhook no trajo (ver sweepRestockReplies).
    try {
      await sweepRestockReplies(admin, storeId, creds);
    } catch (e: any) {
      report.errors.push(`restock sweep: ${e.message}`);
    }
  }

  // 2c.6) Olas de reencolado: carritos en nr/buzón/cuelga quietos 48h suben con
  //       needs_attention (máx 2 olas por lead) para que la llamada de
  //       recontacto no se pase. Pre-0036 es un no-op. Best-effort.
  try {
    report.requeued = await flagCartAttentionWaves(admin, storeId);
  } catch (e: any) {
    report.errors.push(`waves: ${e.message}`);
  }

  // 2c.7) Expira handoffs FRÍOS: los que el bot derivó, nadie atendió y el
  //       cliente abandonó (>24h sin escribir) salen de "Atender ahora" y bajan
  //       a la cola normal. Es el reductor automático que evita que esa cola
  //       solo crezca. Va DESPUÉS de las olas para no pisar una atención de ola
  //       recién puesta. Best-effort.
  try {
    await expireColdHandoffs(admin, storeId);
  } catch (e: any) {
    report.errors.push(`handoffs: ${e.message}`);
  }

  // 2d) Auto-archivar leads vencidos viejos (sin interacción > STALE_LEAD_DAYS)
  //     para que la cola "Por llamar" no se reacumule de backlog. Best-effort.
  try {
    report.archived = await archiveStaleLeads(admin, storeId);
  } catch (e: any) {
    report.errors.push(`archive: ${e.message}`);
  }

  // 2e) Resolver nombres reales de anuncios Meta (meta_ads) para "Rendimiento por
  //     anuncio". Best-effort, gateado por el token de Meta; drena por corrida.
  if (creds.meta_access_token) {
    try {
      report.metaAdsResolved = await resolveMetaAdNames(admin, storeId, creds.meta_access_token);
    } catch (e: any) {
      report.errors.push(`meta-ads: ${e.message}`);
    }
  }

  // 3) Operational snapshot (best-effort; never fails the run)
  if (creds.kapso_api_key) {
    try {
      const k = { apiKey: creds.kapso_api_key };
      let health: { status: string; error?: string | null; checks?: Record<string, unknown> | null } | null = null;
      let apiLogs = null;
      let activity24h = null;

      if (creds.whatsapp_phone_number_id) {
        try {
          const h = await getPhoneHealth(k, creds.whatsapp_phone_number_id);
          health = { status: h.status, error: h.error ?? null, checks: h.checks ?? null };
        } catch {
          /* best-effort */
        }
      }
      try {
        const logs = await listApiLogs(k, { period: "24h", limit: 100 });
        apiLogs = summarizeApiLogs(logs.data ?? []);
      } catch {
        /* best-effort */
      }
      try {
        const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
        const recent = await listAllConversations(
          k,
          { lastActiveAfter: since }, // all numbers
          10,
        );
        activity24h = {
          conversations: recent.length,
          activeConversations: recent.filter((c) => c.status === "active").length,
        };
      } catch {
        /* best-effort */
      }

      const payload = buildOpsSnapshotPayload({ health, apiLogs, activity24h });
      await admin.from("ops_snapshots").insert({ store_id: storeId, payload });
      report.opsCaptured = true;
    } catch (e: any) {
      report.errors.push(`ops: ${e.message}`);
    }
  }

  // 3b) Refresh the WhatsApp number → name lookup from Kapso (best-effort; the
  //     drawer/queue resolve `phone_number_id` → friendly name through it).
  if (creds.kapso_api_key) {
    try {
      const numbers = await listWhatsappNumbers({ apiKey: creds.kapso_api_key });
      report.whatsappNumbers = await upsertWhatsappNumbers(admin, numbers);
    } catch (e: any) {
      report.errors.push(`wa_numbers: ${e.message}`);
    }
  }

  // Recompute rollups for every touched day in one range call.
  if (affectedDates.size) {
    const sorted = [...affectedDates].sort();
    try {
      await recomputeRollups(admin, storeId, sorted[0]!, sorted[sorted.length - 1]!);
    } catch (e: any) {
      report.errors.push(`rollups: ${e.message}`);
    }
  }

  // Red de seguridad del Master: cualquier ruta que haya tocado una guía sin
  // recalcular deja aquí su fila al día. También es lo que rellena el Master la
  // primera vez, sin necesidad de un backfill manual.
  //
  // VA LA ÚLTIMA, Y ESO TIENE UN PRECIO. Cuando quien llama recorre VARIAS
  // tiendas en serie bajo un solo `maxDuration`, la última línea de la última
  // tienda es lo primero que se queda sin ejecutar — medido el 17-08-2026:
  // Kenku con 207 pedidos desfasados y 50 h de media, Aurela con cero. Por eso
  // el cron la salta y delega en `/api/cron/master-reconcile`, que tiene reloj
  // propio y lo reparte entre tiendas.
  //
  // Se conserva aquí para quien sincroniza UNA tienda y espera verla al día
  // enseguida: la conexión inicial de Shopify —que estrena el Master— y el botón
  // de sincronizar. Ahí no hay cola que agote el reloj.
  if (opts.skipMasterReconcile) return report;

  try {
    const reconciled = await reconcileOrderMaster(admin, [storeId]);
    report.orderMaster = reconciled.written;
    // Que el barrido siga adelante ante un pedido que revienta es lo correcto;
    // que nadie se entere, no. Un fallo aquí significa etapas viejas en pantalla.
    if (reconciled.failed) {
      report.errors.push(`order_master: ${reconciled.failed} pedidos sin recalcular`);
    }
  } catch (e: any) {
    report.errors.push(`order_master: ${e.message}`);
  }

  return report;
}
