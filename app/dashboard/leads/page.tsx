import { getAccessibleStores, getCurrentUser } from "@/lib/access";
import { LEAD_VIEWS, getLeadCounts, getStoreLeads, type LeadView } from "@/lib/leads-access";
import { EmptyState } from "@/components/ui";
import { LeadsBoard } from "@/components/leads";

export const dynamic = "force-dynamic";

function isLeadView(v: string | undefined): v is LeadView {
  return !!v && LEAD_VIEWS.some((view) => view.key === v);
}

export default async function LeadsPage({
  searchParams,
}: {
  searchParams: Promise<{ store?: string; view?: string }>;
}) {
  const sp = await searchParams;
  const stores = await getAccessibleStores();

  if (!stores.length) {
    return <EmptyState title="No tienes tiendas asignadas" />;
  }

  const fallback = stores[0]!;
  const storeId = sp.store && stores.some((s) => s.id === sp.store) ? sp.store : fallback.id;
  const view: LeadView = isLeadView(sp.view) ? sp.view : "por_llamar";

  // Segment + gestión sub-filtering is client-side in the board now (instant, no
  // navigation), so the page only fetches the active view's leads + counts.
  const [counts, leads, user] = await Promise.all([
    getLeadCounts(storeId),
    getStoreLeads(storeId, view),
    getCurrentUser(),
  ]);

  return (
    <LeadsBoard
      stores={stores}
      storeId={storeId}
      view={view}
      counts={counts}
      leads={leads}
      currentUserId={user?.id ?? ""}
    />
  );
}
