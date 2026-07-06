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
  const [{ data: full }, { data: sync }, { data: ops }, { count }, { data: events }] = await Promise.all([
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
      telegram_chat_id: full.telegram_chat_id ?? null,
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
      telegramToken: Boolean(full.telegram_bot_token_enc),
      metaToken: Boolean(full.meta_access_token_enc),
    },
    oauthAvailable: env.shopifyOAuthConfigured(),
    siteUrl,
    sync: (sync as StoreSettingsData["sync"]) ?? [],
    lastOpsAt: ops?.captured_at ?? null,
    webhookCount: count ?? 0,
    webhookEvents: (events as StoreSettingsData["webhookEvents"]) ?? [],
  };

  const banner = sp.installed
    ? { kind: "ok" as const, msg: "✅ Tienda conectada con Shopify. Webhooks registrados y backfill iniciado." }
    : sp.shopify_error
      ? { kind: "error" as const, msg: `No se pudo conectar con Shopify: ${SHOPIFY_ERRORS[sp.shopify_error] ?? sp.shopify_error}` }
      : null;

  return <StoreSettings data={data} banner={banner} />;
}
