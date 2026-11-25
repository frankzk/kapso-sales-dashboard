import { Suspense } from "react";
import { getAccessibleStores } from "@/lib/access";
import { createAdminSupabase, createServerSupabase } from "@/lib/db";
import { getMasterPermissions } from "@/lib/permissions-access";
import { zernioConfigured } from "@/lib/zernio";
import { loadAutoSettings, storeWhatsappPhone } from "@/lib/social-auto-server";
import { DEFAULT_COMMENT_KEYWORDS, DEFAULT_DM_TEXT, DEFAULT_PRIVATE_TEXT, DEFAULT_PUBLIC_TEXT, whatsappLink } from "@/lib/social-auto";
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
  // El WhatsApp de cada tienda (para «Pasar a WhatsApp») y sus respuestas automáticas.
  const admin = createAdminSupabase();
  const perStore = await Promise.all(stores.map(async (s) => {
    const [phone, auto] = await Promise.all([storeWhatsappPhone(admin, s.id), loadAutoSettings(admin, s.id)]);
    return {
      storeId: s.id,
      whatsapp: whatsappLink(phone, "Hola, vengo de redes y quiero información"),
      auto: {
        storeId: s.id,
        enabled: auto?.enabled ?? false,
        keywords: (auto?.comment_keywords?.length ? auto.comment_keywords : DEFAULT_COMMENT_KEYWORDS).join(", "),
        publicText: auto?.public_text ?? DEFAULT_PUBLIC_TEXT,
        privateText: auto?.private_text ?? DEFAULT_PRIVATE_TEXT,
        dmText: auto?.dm_text ?? DEFAULT_DM_TEXT,
      },
    };
  }));
  return (
    <SocialInbox
      whatsappByStore={Object.fromEntries(perStore.map((p) => [p.storeId, p.whatsapp]))}
      autoSettings={perStore.map((p) => p.auto)}
      threads={(threads ?? []) as SocialThreadView[]}
      accounts={(accounts ?? []) as SocialAccountView[]}
      stores={stores.map((s) => ({ id: s.id, name: s.name }))}
      canManage={canManage}
      configured={zernioConfigured()}
    />
  );
}
