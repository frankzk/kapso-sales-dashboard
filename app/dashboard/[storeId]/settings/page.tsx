import Link from "next/link";
import { notFound } from "next/navigation";
import { createAdminSupabase } from "@/lib/db";
import { getAccessibleStores, getAdminOrgs } from "@/lib/access";
import { EmptyState } from "@/components/ui";
import { StoreSettings, type StoreSettingsData } from "@/components/store-settings";

export const dynamic = "force-dynamic";

export default async function StoreSettingsPage({
  params,
}: {
  params: Promise<{ storeId: string }>;
}) {
  const { storeId } = await params;

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

  const admin = createAdminSupabase();
  const [{ data: full }, { data: sync }, { data: ops }, { count }] = await Promise.all([
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
    },
    has: {
      shopifyToken: Boolean(full.shopify_token_enc),
      webhookSecret: Boolean(full.shopify_webhook_secret_enc),
      kapsoKey: Boolean(full.kapso_api_key_enc),
    },
    sync: (sync as StoreSettingsData["sync"]) ?? [],
    lastOpsAt: ops?.captured_at ?? null,
    webhookCount: count ?? 0,
  };

  return <StoreSettings data={data} />;
}
