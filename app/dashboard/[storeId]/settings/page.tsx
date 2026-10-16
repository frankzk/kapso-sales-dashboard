import Link from "next/link";
import { headers } from "next/headers";
import type { SupabaseClient } from "@supabase/supabase-js";
import { hasOrgPermission } from "@/lib/permissions-access";
import { notFound, redirect } from "next/navigation";
import { createAdminSupabase } from "@/lib/db";
import { getAccessibleStores, getUserRoleSummary } from "@/lib/access";
import { env } from "@/lib/env";
import { normalizeMetaAdAccounts } from "@/lib/meta-marketing";
import { confirmationCycleDays } from "@/lib/order-confirmation";
import { PAYMENT_METHOD_COLUMNS } from "@/lib/payment-methods";
import { leadVoiceOwnNumber, loadLeadVoiceCampaigns } from "@/lib/store-settings";
import { leadVoiceSettingsFrom } from "@/lib/voice-leads";
import { leadVoiceConfigured, loadLeadVoicePilotReport } from "@/lib/voice-leads-server";
import { RESTOCK_CATALOG_DAYS, RESTOCK_RESULTS_DAYS } from "@/lib/restock-view";
import { limaDateTimeInputValue } from "@/lib/repro-lima";
import { limaDayStartIso } from "@/lib/auto-order-ab";
import type { InvoiceMode, InvoiceStatus, InvoiceWriteMode } from "@/lib/invoicing/rules";
import {
  invoiceEmitAllowedHere,
  loadInvoiceEmitNowOffers,
  type InvoiceEmitNowOffer,
} from "@/lib/invoicing/server";
import { EmptyState } from "@/components/ui";
import { StoreSettings, type StoreSettingsData } from "@/components/store-settings";
import type { InvoiceSettingsData } from "@/components/invoice-settings-section";
import { listEscalation } from "./actions";
import { listEscalationCandidates } from "@/app/dashboard/cobranza/actions";

export const dynamic = "force-dynamic";

/**
 * "Probar conexión" de Shalom pide el token de sesión, y esa llamada hace un
 * login real contra pro.shalom.pe: hasta 2 minutos la primera vez de cada
 * cuenta. Con el límite por defecto el botón se cortaría solo.
 */
export const maxDuration = 300;

const SHOPIFY_ERRORS: Record<string, string> = {
  "oauth-no-config": "OAuth de Shopify no está configurado en el servidor.",
  "parametros-invalidos": "Parámetros de OAuth inválidos.",
  "state-invalido": "La sesión de instalación expiró o no coincide. Intenta de nuevo.",
  "hmac-invalido": "Firma de Shopify inválida.",
  "tienda-no-encontrada": "No se encontró la tienda.",
  "shop-no-coincide": "El dominio autorizado no coincide con el de la tienda.",
  "sin-permiso": "No tienes permiso sobre esta tienda.",
  "intercambio-fallo": "Shopify rechazó el intercambio del código por token.",
  "guardado-fallo": "No se pudo guardar el token.",
};

/**
 * Sin permiso, o si la lectura entera se cayó: nada que mostrar, y sin «Emitir»
 * (falla cerrada).
 */
const NO_INVOICES: Omit<InvoiceSettingsData, "canManage"> = {
  emitHere: false,
  issuers: null,
  accounts: null,
  recent: null,
};

/** Lo de hoy por RUC (MOM §35.8): los cuatro estados que se miran a diario. */
const INVOICE_TODAY_STATUSES = ["emitida", "simulada", "en_duda", "error"] as const;

/**
 * «Boletas y facturas» (MOM §35): los RUC de la organización, lo de hoy de
 * cada uno, las cuentas activas de esta tienda con su RUC y los últimos 20
 * comprobantes de la tienda. Cada lectura que falla deja su lista en null, que
 * la sección dice como «no se pudo leer» y no como «no hay».
 *
 * De esos últimos, cuáles llevan «Emitir» (`emitNow`): la simulada más nueva
 * de cada pedido, cuando el drawer de ese pedido ofrecería «Emitir esta
 * boleta» (`loadInvoiceEmitNowOffers`). Si algo no se pudo leer, ninguna lo
 * lleva (falla cerrada). Al pulsar, el servidor vuelve a revisar todo. Fuera
 * de producción, ninguna (`emitHere`, `invoiceEmitAllowedHere`).
 *
 * `token_enc` no se selecciona nunca: si hay token se sabe con un filtro
 * (`not token_enc is null`) que devuelve solo ids.
 */
async function loadInvoiceSettings(
  admin: SupabaseClient,
  orgId: string,
  storeId: string,
): Promise<Omit<InvoiceSettingsData, "canManage">> {
  const [issuerRows, tokenRows, accountRows, recentRows] = await Promise.all([
    admin
      .from("invoice_issuers")
      .select("id,ruc,legal_name,simplefact_subdomain,mode,emit_from,daily_limit,checked_at,checked_ruc,check_error")
      .eq("org_id", orgId)
      .order("legal_name", { ascending: true }),
    admin.from("invoice_issuers").select("id").eq("org_id", orgId).not("token_enc", "is", null),
    admin
      .from("store_collection_accounts")
      .select("id,label,aliases,phone_last_digits,invoice_issuer_id")
      .eq("store_id", storeId)
      .eq("active", true)
      .order("label", { ascending: true }),
    admin
      .from("order_invoices")
      .select("id,order_id,order_name,issuer_id,ruc,mode,status,serie,correlative,total,error,created_at,ruc_mismatch")
      .eq("store_id", storeId)
      .order("created_at", { ascending: false })
      .limit(20),
  ]);

  type IssuerRow = {
    id: string;
    ruc: string;
    legal_name: string;
    simplefact_subdomain: string;
    mode: InvoiceMode;
    emit_from: string | null;
    daily_limit: number;
    checked_at: string | null;
    checked_ruc: string | null;
    check_error: string | null;
  };
  // Sin saber si hay token, «Configurado» podría mentir: los dos o ninguno.
  const rows = issuerRows.error || tokenRows.error ? null : ((issuerRows.data ?? []) as IssuerRow[]);
  const withToken = new Set(((tokenRows.data ?? []) as { id: string }[]).map((r) => r.id));

  // Lo de hoy cuenta desde el inicio del día de Lima, como el tope (0257).
  const since = limaDayStartIso(Date.now());
  const today = await Promise.all(
    (rows ?? []).map(async (r) => {
      const counts = await Promise.all(
        INVOICE_TODAY_STATUSES.map((status) =>
          admin
            .from("order_invoices")
            .select("id", { count: "exact", head: true })
            .eq("issuer_id", r.id)
            .eq("status", status)
            .gte("created_at", since),
        ),
      );
      if (counts.some((c) => c.error || c.count == null)) return null;
      const [emitidas, simuladas, enDuda, errores] = counts.map((c) => c.count ?? 0);
      return { emitidas: emitidas!, simuladas: simuladas!, enDuda: enDuda!, errores: errores! };
    }),
  );

  type AccountRow = {
    id: string;
    label: string;
    aliases: string[] | null;
    phone_last_digits: string | null;
    invoice_issuer_id: string | null;
  };
  type RecentRow = {
    id: string;
    order_id: string;
    order_name: string | null;
    issuer_id: string | null;
    ruc: string;
    mode: InvoiceWriteMode;
    status: InvoiceStatus;
    serie: string | null;
    correlative: string | null;
    total: number | string;
    error: string | null;
    created_at: string;
    /** SimpleFact contestó con archivos de otro RUC: la emitida no es de quien cobró. */
    ruc_mismatch: boolean | null;
  };

  // «Emitir» en los últimos comprobantes (owner, 15-10-2026): en la simulada
  // más nueva de cada pedido, y solo si el drawer ofrecería ahora «Emitir esta
  // boleta» para ese pedido. Lo decide la MISMA función que el drawer
  // (`invoiceEmitNowReadiness`, por `loadInvoiceEmitNowOffers`): la tienda
  // activa, sin comprobante real vivo, las reglas como una emisión real, el RUC
  // ACTUAL del pedido en «Manual» y sin un bloqueo de Shopify de la última
  // pasada. Antes bastaba con que el RUC de la simulada estuviera en Manual y el
  // pedido no tuviera real viva, y el botón salía en pedidos que el drawer no
  // dejaba emitir. Los pedidos de la lista se leen de una vez.
  const recent = recentRows.error ? null : ((recentRows.data ?? []) as RecentRow[]);
  // Del más nuevo al más viejo: la primera simulada de cada pedido es la que vale.
  const newestSimulated = new Map<string, string>();
  for (const r of recent ?? []) {
    if (r.status === "simulada" && r.mode === "simulacion" && !newestSimulated.has(r.order_id)) {
      newestSimulated.set(r.order_id, r.id);
    }
  }
  let offers = new Map<string, InvoiceEmitNowOffer>();
  // SOLO EN PRODUCCIÓN. Una vista previa comparte la base y la llave de cifrado
  // con producción: desde ella «Emitir» mandaría una boleta real a SUNAT. La
  // acción ya la rechaza ahí y `loadInvoiceEmitNowOffers` no ofrece nada, pero
  // la página no se fía de que otro lo diga: ni pregunta, y la sección dice por
  // qué no hay botón (`emitHere`).
  const emitHere = invoiceEmitAllowedHere();
  // Sin un RUC en «Manual» no hay botón posible: ni se pregunta.
  if (emitHere && newestSimulated.size && (rows ?? []).some((r) => r.mode === "manual")) {
    try {
      offers = await loadInvoiceEmitNowOffers(admin, [...newestSimulated.keys()]);
    } catch (cause) {
      // FALLA CERRADA: sin saber si el drawer lo ofrecería, ninguna lleva
      // «Emitir». El resto de la sección se ve igual. El mensaje es de la base
      // (tablas y columnas), sin datos de la clienta.
      console.error(
        `[invoices] Ajustes: no se pudo revisar qué simuladas llevan «Emitir» — ${cause instanceof Error ? cause.message : String(cause)}`,
      );
      offers = new Map();
    }
  }
  const emitNowOf = (r: RecentRow) => (newestSimulated.get(r.order_id) === r.id ? offers.get(r.order_id) ?? null : null);

  return {
    emitHere,
    issuers:
      rows?.map((r, i) => ({
        id: r.id,
        ruc: r.ruc,
        legalName: r.legal_name,
        subdomain: r.simplefact_subdomain,
        mode: r.mode,
        emitFromInput: limaDateTimeInputValue(r.emit_from),
        dailyLimit: r.daily_limit,
        hasToken: withToken.has(r.id),
        checkedAt: r.checked_at,
        checkedRuc: r.checked_ruc,
        checkError: r.check_error,
        today: today[i] ?? null,
      })) ?? null,
    accounts: accountRows.error
      ? null
      : ((accountRows.data ?? []) as AccountRow[]).map((a) => ({
          id: a.id,
          label: a.label,
          aliases: a.aliases ?? [],
          phoneLastDigits: a.phone_last_digits,
          issuerId: a.invoice_issuer_id,
        })),
    recent:
      recent?.map((r) => ({
        id: r.id,
        orderId: r.order_id,
        orderName: r.order_name,
        issuerId: r.issuer_id,
        ruc: r.ruc,
        mode: r.mode,
        status: r.status,
        serie: r.serie,
        correlative: r.correlative,
        total: Number(r.total),
        error: r.error,
        createdAt: r.created_at,
        rucMismatch: r.ruc_mismatch === true,
        emitNow: emitNowOf(r),
      })) ?? null,
  };
}

export default async function StoreSettingsPage({
  params,
  searchParams,
}: {
  params: Promise<{ storeId: string }>;
  searchParams: Promise<{ installed?: string; shopify_error?: string }>;
}) {
  if ((await getUserRoleSummary()).isVendedoraOnly) redirect("/dashboard/leads");
  const { storeId } = await params;
  const sp = await searchParams;

  // RLS gate: the store must be accessible to the caller.
  const stores = await getAccessibleStores();
  const store = stores.find((s) => s.id === storeId);
  if (!store) notFound();

  // Editing requires «Administrar tiendas» in the store's org (MOM §16).
  const isAdmin = await hasOrgPermission(store.org_id, "stores.manage");
  if (!isAdmin) {
    return (
      <EmptyState title="Tu rol no permite editar esta tienda">
        <Link href={`/dashboard/${storeId}`} className="text-brand-700 hover:underline">
          ← Volver al panel
        </Link>
      </EmptyState>
    );
  }

  // «Boletas y facturas» pide además su propio permiso (MOM §35.7). Sin él la
  // sección solo dice quién la configura, y no se lee nada de los RUC.
  const canManageInvoices = await hasOrgPermission(store.org_id, "invoices.manage");

  // Absolute base URL for copy-paste webhook URLs (works in preview + prod).
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "";
  const proto = h.get("x-forwarded-proto") ?? "https";
  const siteUrl = host ? `${proto}://${host}` : "";

  const admin = createAdminSupabase();
  const [
    { data: full },
    { data: sync },
    { data: ops },
    { count },
    { data: events },
    // Pre-0113 la tabla no existe ⇒ `error` y catálogo vacío, sin tumbar Ajustes.
    { data: replyTemplates },
    // Pre-0121 la tabla no existe ⇒ `error` y lista vacía, que es además el
    // estado normal: la tabla solo guarda excepciones.
    { data: districtCoverage },
    // Pre-0166 la tabla no existe ⇒ `error` y lista vacía: sin cuentas no se
    // contesta ningún botón, que es el lado seguro.
    { data: paymentMethods },
    // Pre-0257 las tablas no existen ⇒ cada lista en null («no se pudo leer»),
    // sin tumbar Ajustes. Nunca trae el token, solo si hay uno.
    invoices,
  ] = await Promise.all([
    admin.from("stores").select("*").eq("id", storeId).single(),
    admin
      .from("sync_state")
      .select("source, status, last_run_at, cursor, error")
      .eq("store_id", storeId)
      .order("source"),
    admin
      .from("ops_snapshots")
      .select("captured_at")
      .eq("store_id", storeId)
      .order("captured_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    admin.from("webhook_events").select("*", { count: "exact", head: true }).eq("store_id", storeId),
    admin
      .from("webhook_events")
      .select("id, topic, shopify_id, received_at, processed, error")
      .eq("store_id", storeId)
      .order("received_at", { ascending: false })
      .limit(30),
    admin
      .from("wa_reply_templates")
      .select("id, label, template_name, language, body_preview, params, active, sort")
      .eq("store_id", storeId)
      .order("sort", { ascending: true })
      .order("created_at", { ascending: true }),
    admin
      .from("district_coverage")
      .select("id,store_id,district,coverage,note,updated_at")
      .or(`store_id.is.null,store_id.eq.${storeId}`)
      .order("district", { ascending: true }),
    admin
      .from("store_payment_methods")
      .select(PAYMENT_METHOD_COLUMNS)
      .eq("store_id", storeId)
      .order("sort", { ascending: true })
      .order("created_at", { ascending: true }),
    canManageInvoices
      ? loadInvoiceSettings(admin, store.org_id, storeId).catch(() => NO_INVOICES)
      : Promise.resolve(NO_INVOICES),
  ]);

  // Los ajustes del agente de leads (MOM §33) con los defectos de 0247: lo que
  // la página pinta es lo mismo que lee el agente al llamar.
  const leadVoice = leadVoiceSettingsFrom(full);
  const now = new Date();

  // La escalera de cobranza y quién puede entrar en ella (0172). Van aparte
  // del Promise.all porque pasan por `requireStoreAdmin`, que ya comprueba
  // permisos por su cuenta. Con ellas, lo del agente de leads que depende de
  // la fila de la tienda: las campañas para elegir (incluye siempre las ya
  // elegidas; nunca falla) y el tablero del piloto. El tablero no tumba
  // Ajustes: pre-0247, o si una lectura falla, sale vacío.
  const [escalation, escalationCandidates, leadVoiceCampaigns, leadVoiceReport] = await Promise.all([
    listEscalation(storeId),
    listEscalationCandidates(storeId),
    loadLeadVoiceCampaigns(admin, storeId, leadVoice.campaignIds, now),
    loadLeadVoicePilotReport(admin, storeId, now).catch(() => null),
  ]);

  // La prueba de imagen en carritos (0233), desde que se encendió. Pre-0233
  // la función no existe ⇒ `error` y sin resultados, sin tumbar Ajustes.
  const { data: cartImageTest } = full?.cart_seq_image_test_started_at
    ? await admin.rpc("cart_image_test_results", {
        p_store_id: storeId,
        p_since: full.cart_seq_image_test_started_at,
      })
    : { data: null };

  // Recordatorio de reposición (0255): lo vendido, lo configurado y cómo le va
  // a cada grupo. Pre-0255 las funciones no existen ⇒ listas vacías, sin tumbar
  // Ajustes.
  const [restockCatalog, restockProducts, restockResults, restockImages] = await Promise.all([
    admin.rpc("restock_product_catalog", {
      p_store_id: storeId,
      p_since: new Date(now.getTime() - RESTOCK_CATALOG_DAYS * 86_400_000).toISOString(),
    }),
    admin
      .from("restock_products")
      .select("product_key, shopify_title, short_name, days_per_unit")
      .eq("store_id", storeId),
    admin.rpc("restock_results", {
      p_store_id: storeId,
      p_since: new Date(now.getTime() - RESTOCK_RESULTS_DAYS * 86_400_000).toISOString(),
    }),
    // Qué productos tienen foto: sin foto no se envía (la plantilla la lleva).
    admin.from("shopify_product_images").select("product_id").eq("store_id", storeId).not("image_url", "is", null),
  ]);

  const data: StoreSettingsData = {
    store: {
      id: full.id,
      name: full.name,
      shopify_domain: full.shopify_domain,
      currency: full.currency,
      timezone: full.timezone,
      status: full.status,
      whatsapp_phone_number_id: full.whatsapp_phone_number_id ?? null,
      kapso_project_id: full.kapso_project_id ?? null,
      // Pre-0115 la columna no existe ⇒ el importador no adivina pedidos.
      order_prefix: full.order_prefix ?? null,
      browse_template_enabled: full.browse_template_enabled ?? false,
      browse_template_name: full.browse_template_name ?? null,
      browse_template_language: full.browse_template_language ?? null,
      winback_template_enabled: full.winback_template_enabled ?? false,
      winback_template_name: full.winback_template_name ?? null,
      winback_template_language: full.winback_template_language ?? null,
      drip_template_enabled: full.drip_template_enabled ?? false,
      drip_template_name: full.drip_template_name ?? null,
      drip_template_language: full.drip_template_language ?? null,
      cart_seq_enabled: full.cart_seq_enabled ?? false,
      cart_seq_template_1_name: full.cart_seq_template_1_name ?? null,
      cart_seq_template_1_language: full.cart_seq_template_1_language ?? null,
      cart_seq_template_2_name: full.cart_seq_template_2_name ?? null,
      cart_seq_template_2_language: full.cart_seq_template_2_language ?? null,
      cart_seq_hours_1: full.cart_seq_hours_1 ?? 3,
      cart_seq_hours_2: full.cart_seq_hours_2 ?? 24,
      cart_seq_hour_start: full.cart_seq_hour_start ?? 8,
      cart_seq_hour_end: full.cart_seq_hour_end ?? 21,
      // Pre-0233 ⇒ sin prueba de imagen.
      cart_seq_image_test_enabled: full.cart_seq_image_test_enabled ?? false,
      cart_seq_image_template_1_name: full.cart_seq_image_template_1_name ?? null,
      cart_seq_image_template_1_language: full.cart_seq_image_template_1_language ?? null,
      cart_seq_image_test_started_at: full.cart_seq_image_test_started_at ?? null,
      // Pre-0112 las columnas no existen ⇒ recuperación apagada.
      return_recovery_enabled: full.return_recovery_enabled ?? false,
      return_recovery_auto: full.return_recovery_auto ?? false,
      return_recovery_template_name: full.return_recovery_template_name ?? null,
      return_recovery_template_language: full.return_recovery_template_language ?? null,
      return_recovery_params: full.return_recovery_params ?? null,
      // Pre-0114 la columna no existe ⇒ sale del número de la tienda.
      return_recovery_phone_number_id: full.return_recovery_phone_number_id ?? null,
      return_recovery_hour_start: full.return_recovery_hour_start ?? 8,
      return_recovery_hour_end: full.return_recovery_hour_end ?? 21,
      return_recovery_max_days: full.return_recovery_max_days ?? 30,
      // Pre-0193 las columnas no existen ⇒ agradecimiento apagado.
      delivered_thanks_enabled: full.delivered_thanks_enabled ?? false,
      delivered_thanks_template_name: full.delivered_thanks_template_name ?? null,
      delivered_thanks_template_language: full.delivered_thanks_template_language ?? null,
      delivered_thanks_params: full.delivered_thanks_params ?? null,
      delivered_thanks_button_param: full.delivered_thanks_button_param ?? "telefono",
      delivered_thanks_phone_number_id: full.delivered_thanks_phone_number_id ?? null,
      delivered_thanks_hour_start: full.delivered_thanks_hour_start ?? 9,
      delivered_thanks_hour_end: full.delivered_thanks_hour_end ?? 21,
      delivered_thanks_max_hours: full.delivered_thanks_max_hours ?? 72,
      delivered_thanks_pace_count: full.delivered_thanks_pace_count ?? 5,
      delivered_thanks_pace_minutes: full.delivered_thanks_pace_minutes ?? 20,
      // Pre-0255 las columnas no existen ⇒ recordatorio apagado.
      restock_enabled: full.restock_enabled ?? false,
      restock_template_name: full.restock_template_name ?? null,
      restock_template_language: full.restock_template_language ?? null,
      restock_params: full.restock_params ?? null,
      restock_phone_number_id: full.restock_phone_number_id ?? null,
      restock_button_label: full.restock_button_label ?? null,
      restock_hour_start: full.restock_hour_start ?? 9,
      restock_hour_end: full.restock_hour_end ?? 20,
      restock_pace_count: full.restock_pace_count ?? 5,
      restock_pace_minutes: full.restock_pace_minutes ?? 20,
      restock_days_before: full.restock_days_before ?? 7,
      restock_control_pct: full.restock_control_pct ?? 10,
      // Pre-0190 las columnas no existen ⇒ agente de voz apagado.
      voice_recovery_enabled: full.voice_recovery_enabled ?? false,
      voice_recovery_auto: full.voice_recovery_auto ?? false,
      voice_recovery_can_discard: full.voice_recovery_can_discard ?? false,
      voice_recovery_daily_cap: full.voice_recovery_daily_cap ?? 30,
      voice_recovery_max_attempts: full.voice_recovery_max_attempts ?? 2,
      voice_recovery_max_age_days: full.voice_recovery_max_age_days ?? 7,
      voice_recovery_hour_start: full.voice_recovery_hour_start ?? 9,
      voice_recovery_hour_end: full.voice_recovery_hour_end ?? 20,
      voice_recovery_agent_number: full.voice_recovery_agent_number ?? null,
      voice_recovery_zadarma_sip: full.voice_recovery_zadarma_sip ?? null,
      // Pre-0247 las columnas no existen ⇒ agente de leads apagado (y los
      // defectos de la migración, vía leadVoiceSettingsFrom).
      voice_lead_enabled: leadVoice.enabled,
      voice_lead_auto: leadVoice.auto,
      voice_lead_daily_cap: leadVoice.dailyCap,
      voice_lead_max_attempts: leadVoice.maxAttempts,
      voice_lead_wait_minutes: leadVoice.waitMinutes,
      voice_lead_max_age_hours: leadVoice.maxAgeHours,
      voice_lead_holdout_pct: leadVoice.holdoutPct,
      voice_lead_hour_start: leadVoice.hourStart,
      voice_lead_hour_end: leadVoice.hourEnd,
      voice_lead_campaign_ids: leadVoice.campaignIds,
      voice_lead_product: leadVoice.product || null,
      voice_lead_offer: leadVoice.offer || null,
      // Pre-0133 la columna no existe ⇒ el ciclo por defecto del MOM.
      confirmation_cycle_days: confirmationCycleDays(full.confirmation_cycle_days),
      telegram_chat_id: full.telegram_chat_id ?? null,
      // Pre-0226 la columna no existe ⇒ sin grupo de alertas urgentes.
      urgent_telegram_chat_id: full.urgent_telegram_chat_id ?? null,
      anthropic_model: full.anthropic_model ?? null,
      // Pre-0054 la columna no existe ⇒ integración apagada.
      aliclik_enabled: Boolean(full.aliclik_enabled),
      tanders_email: full.tanders_email ?? null,
      tanders_origin_address: full.tanders_origin_address ?? null,
      tanders_origin_lat: full.tanders_origin_lat ?? null,
      tanders_origin_lng: full.tanders_origin_lng ?? null,
      shalom_pro_email: full.shalom_pro_email ?? null,
      shalom_origin_terminal_id: full.shalom_origin_terminal_id ?? null,
      shalom_origin_terminal_name: full.shalom_origin_terminal_name ?? null,
      shalom_default_product_id: full.shalom_default_product_id ?? null,
      // Pre-0166 las columnas no existen ⇒ aviso apagado, defaults de la migración.
      shalom_transit_template_enabled: full.shalom_transit_template_enabled ?? false,
      shalom_transit_template_name: full.shalom_transit_template_name ?? null,
      shalom_transit_template_language: full.shalom_transit_template_language ?? null,
      shalom_transit_params: full.shalom_transit_params ?? null,
      shalom_transit_attach_ticket: full.shalom_transit_attach_ticket ?? false,
      shalom_transit_phone_number_id: full.shalom_transit_phone_number_id ?? null,
      shalom_transit_hour_start: full.shalom_transit_hour_start ?? 8,
      shalom_notice_daily_cap: full.shalom_notice_daily_cap ?? 30,
      shalom_notice_hourly_cap: full.shalom_notice_hourly_cap ?? 8,
      shalom_transit_hour_end: full.shalom_transit_hour_end ?? 21,
      shalom_transit_payment_link: full.shalom_transit_payment_link ?? null,
      shalom_arrival_template_enabled: full.shalom_arrival_template_enabled ?? false,
      shalom_arrival_template_name: full.shalom_arrival_template_name ?? null,
      shalom_arrival_params: full.shalom_arrival_params ?? null,
      shalom_arrival_attach_ticket: full.shalom_arrival_attach_ticket ?? false,
      shalom_voucher_intake_enabled: full.shalom_voucher_intake_enabled ?? false,
      shalom_pickup_key_autosend_enabled: full.shalom_pickup_key_autosend_enabled ?? false,
      // Pre-0175 las columnas no existen ⇒ avisos de Olva apagados.
      olva_transit_template_enabled: full.olva_transit_template_enabled ?? false,
      olva_transit_template_name: full.olva_transit_template_name ?? null,
      olva_transit_params: full.olva_transit_params ?? null,
      olva_arrival_template_enabled: full.olva_arrival_template_enabled ?? false,
      olva_arrival_template_name: full.olva_arrival_template_name ?? null,
      olva_arrival_params: full.olva_arrival_params ?? null,
      // Pre-0242 las columnas no existen ⇒ recordatorio apagado, defaults de la
      // migración.
      shalom_reminder_template_enabled: full.shalom_reminder_template_enabled ?? false,
      shalom_reminder_template_name: full.shalom_reminder_template_name ?? "guias_shalom_recordatorio",
      shalom_reminder_params: full.shalom_reminder_params ?? "nombre,agencia,guia,saldo,vence",
      olva_reminder_template_enabled: full.olva_reminder_template_enabled ?? false,
      olva_reminder_template_name: full.olva_reminder_template_name ?? "guias_olva_recordatorio",
      olva_reminder_params: full.olva_reminder_params ?? "nombre,agencia,guia,saldo,vence",
      shalom_reminder_fallback_image_url: full.shalom_reminder_fallback_image_url ?? null,
      olva_portal_username: full.olva_portal_username ?? null,
      olva_portal_ruc: full.olva_portal_ruc ?? null,
      flowcl_link_enabled: full.flowcl_link_enabled ?? false,
      flowcl_link_email: full.flowcl_link_email ?? null,
      flowcl_link_ttl_hours: full.flowcl_link_ttl_hours ?? 48,
      flowcl_link_yape_only: full.flowcl_link_yape_only ?? false,
      meta_ad_accounts: normalizeMetaAdAccounts(
        full.meta_ad_accounts,
        full.meta_ad_account_id,
        full.meta_ad_account_name,
      ),
    },
    has: {
      shopifyToken: Boolean(full.shopify_token_enc),
      webhookSecret: Boolean(full.shopify_webhook_secret_enc),
      kapsoKey: Boolean(full.kapso_api_key_enc),
      flowSecret: Boolean(full.flow_webhook_secret_enc),
      kapsoWebhookSecret: Boolean(full.kapso_webhook_secret_enc),
      flowclApiKey: Boolean(full.flowcl_api_key_enc),
      flowclSecretKey: Boolean(full.flowcl_secret_key_enc),
      flowclWebhookSecret: Boolean(full.flowcl_webhook_secret_enc),
      telegramToken: Boolean(full.telegram_bot_token_enc),
      metaToken: Boolean(full.meta_access_token_enc),
      anthropicKey: Boolean(full.anthropic_api_key_enc),
      aliclikToken: Boolean(full.aliclik_api_token_enc),
      aliclikWebhookSecret: Boolean(full.aliclik_webhook_secret_enc),
      tandersPassword: Boolean(full.tanders_password_enc),
      shalomProPassword: Boolean(full.shalom_pro_password_enc),
      olvaPortalPassword: Boolean(full.olva_portal_password_enc),
    },
    oauthAvailable: env.shopifyOAuthConfigured(),
    // Solo sí/no, nunca los valores: la página llega al navegador.
    leadVoice: {
      configured: leadVoiceConfigured(),
      // Sin número propio el lead ve TELNYX_FROM_NUMBER, el de Reproprovincia
      // (env.telnyxLeadsFromNumber cae a ese). Uno con los mismos dígitos
      // tampoco es propio: el lead vería el mismo número.
      ownNumber: leadVoiceOwnNumber(process.env.TELNYX_LEADS_FROM_NUMBER, process.env.TELNYX_FROM_NUMBER),
      campaigns: leadVoiceCampaigns,
      report: leadVoiceReport,
    },
    siteUrl,
    sync: (sync as StoreSettingsData["sync"]) ?? [],
    lastOpsAt: ops?.captured_at ?? null,
    webhookCount: count ?? 0,
    webhookEvents: (events as StoreSettingsData["webhookEvents"]) ?? [],
    replyTemplates: (replyTemplates as StoreSettingsData["replyTemplates"]) ?? [],
    districtCoverage: (districtCoverage as StoreSettingsData["districtCoverage"]) ?? [],
    paymentMethods: (paymentMethods as StoreSettingsData["paymentMethods"]) ?? [],
    invoices: { canManage: canManageInvoices, ...invoices },
    escalation,
    escalationCandidates,
    cartImageTest: (cartImageTest as StoreSettingsData["cartImageTest"] | null) ?? [],
    restock: {
      catalog: (restockCatalog.data as StoreSettingsData["restock"]["catalog"] | null) ?? [],
      products: (restockProducts.data as StoreSettingsData["restock"]["products"] | null) ?? [],
      results: (restockResults.data as StoreSettingsData["restock"]["results"] | null) ?? [],
      withImage: ((restockImages.data as { product_id: string }[] | null) ?? []).map((r) => String(r.product_id)),
    },
  };

  const banner = sp.installed
    ? { kind: "ok" as const, msg: "Tienda conectada con Shopify. Webhooks registrados y backfill iniciado." }
    : sp.shopify_error
      ? { kind: "error" as const, msg: `No se pudo conectar con Shopify: ${SHOPIFY_ERRORS[sp.shopify_error] ?? sp.shopify_error}` }
      : null;

  return <StoreSettings data={data} banner={banner} />;
}
