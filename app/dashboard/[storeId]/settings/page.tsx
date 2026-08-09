import Link from "next/link";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { createAdminSupabase } from "@/lib/db";
import { getAccessibleStores, getAdminOrgs, getUserRoleSummary } from "@/lib/access";
import { env } from "@/lib/env";
import { normalizeMetaAdAccounts } from "@/lib/meta-marketing";
import { EmptyState } from "@/components/ui";
import { StoreSettings, type StoreSettingsData } from "@/components/store-settings";

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

  // Editing requires owner/admin of the store's org.
  const adminOrgs = await getAdminOrgs();
  const isAdmin = adminOrgs.some(
    (o) => o.org_id === store.org_id && (o.role === "owner" || o.role === "admin"),
  );
  if (!isAdmin) {
    return (
      <EmptyState title="Necesitas rol admin u owner para editar esta tienda">
        <Link href={`/dashboard/${storeId}`} className="text-brand-700 hover:underline">
          ← Volver al panel
        </Link>
      </EmptyState>
    );
  }

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
      telegram_chat_id: full.telegram_chat_id ?? null,
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
      telegramToken: Boolean(full.telegram_bot_token_enc),
      metaToken: Boolean(full.meta_access_token_enc),
      anthropicKey: Boolean(full.anthropic_api_key_enc),
      aliclikToken: Boolean(full.aliclik_api_token_enc),
      aliclikWebhookSecret: Boolean(full.aliclik_webhook_secret_enc),
      tandersPassword: Boolean(full.tanders_password_enc),
      shalomProPassword: Boolean(full.shalom_pro_password_enc),
    },
    oauthAvailable: env.shopifyOAuthConfigured(),
    siteUrl,
    sync: (sync as StoreSettingsData["sync"]) ?? [],
    lastOpsAt: ops?.captured_at ?? null,
    webhookCount: count ?? 0,
    webhookEvents: (events as StoreSettingsData["webhookEvents"]) ?? [],
    replyTemplates: (replyTemplates as StoreSettingsData["replyTemplates"]) ?? [],
  };

  const banner = sp.installed
    ? { kind: "ok" as const, msg: "✅ Tienda conectada con Shopify. Webhooks registrados y backfill iniciado." }
    : sp.shopify_error
      ? { kind: "error" as const, msg: `No se pudo conectar con Shopify: ${SHOPIFY_ERRORS[sp.shopify_error] ?? sp.shopify_error}` }
      : null;

  return <StoreSettings data={data} banner={banner} />;
}
