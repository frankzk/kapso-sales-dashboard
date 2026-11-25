import { Suspense } from "react";
import { getAccessibleStores } from "@/lib/access";
import { createAdminSupabase, createServerSupabase } from "@/lib/db";
import { getMasterPermissions } from "@/lib/permissions-access";
import { zernioConfigured } from "@/lib/zernio";
import { EmptyState } from "@/components/ui";
import { DashboardRouteSkeleton } from "@/components/dashboard-route-skeleton";
import { SocialInbox, type SocialAccountView, type SocialThreadView } from "@/components/social-inbox";

export const dynamic = "force-dynamic";

// Leads → Redes (MOM §25.4): comentarios y mensajes directos de Facebook e
// Instagram de las tiendas, por Zernio. Lo ve quien ve Leads; solo sus tiendas (RLS).
export default function RedesPage() {
  return (
    <Suspense fallback={<DashboardRouteSkeleton />}>
      <RedesContent />
    </Suspense>
  );
}

async function RedesContent() {
  const [stores, perms] = await Promise.all([getAccessibleStores(), getMasterPermissions()]);
  if (!stores.length) return <EmptyState title="No tienes tiendas asignadas" />;
  const sb = await createServerSupabase();
  const canManage = perms.can("stores.manage");
  const [{ data: threads }, { data: accounts }] = await Promise.all([
    sb.from("social_threads")
      .select("id,store_id,account_id,platform,kind,post_text,post_permalink,post_image_url,ad_id,participant_name,participant_username,participant_picture,last_inbound_at,last_message_at,last_message_text,last_direction,unread,status,private_reply_at,created_at")
      .order("last_message_at", { ascending: false, nullsFirst: false }).limit(300),
    // Quien gestiona tiendas ve también las cuentas sin tienda, para asignarlas.
    canManage
      ? createAdminSupabase().from("social_accounts").select("account_id,store_id,platform,username,display_name,active")
      : sb.from("social_accounts").select("account_id,store_id,platform,username,display_name,active"),
  ]);
  return (
    <SocialInbox
      threads={(threads ?? []) as SocialThreadView[]}
      accounts={(accounts ?? []) as SocialAccountView[]}
      stores={stores.map((s) => ({ id: s.id, name: s.name }))}
      canManage={canManage}
      configured={zernioConfigured()}
    />
  );
}
