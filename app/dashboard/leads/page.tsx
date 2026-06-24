import { getAccessibleStores, getCurrentUser } from "@/lib/access";
import {
  LEAD_VIEWS,
  getLeadCounts,
  getStoreLeads,
  type LeadView,
} from "@/lib/leads-access";
import {
  countLeadSegments,
  isLeadSegment,
  leadSegment,
  type LeadSegment,
} from "@/lib/leads";
import { EmptyState } from "@/components/ui";
import { LeadsBoard } from "@/components/leads";

export const dynamic = "force-dynamic";

function isLeadView(v: string | undefined): v is LeadView {
  return !!v && LEAD_VIEWS.some((view) => view.key === v);
}

export default async function LeadsPage({
  searchParams,
}: {
  searchParams: Promise<{ store?: string; view?: string; seg?: string }>;
}) {
  const sp = await searchParams;
  const stores = await getAccessibleStores();

  if (!stores.length) {
    return <EmptyState title="No tienes tiendas asignadas" />;
  }

  const fallback = stores[0]!;
  const storeId = sp.store && stores.some((s) => s.id === sp.store) ? sp.store : fallback.id;
  const view: LeadView = isLeadView(sp.view) ? sp.view : "por_llamar";

  const [counts, leads] = await Promise.all([getLeadCounts(storeId), getStoreLeads(storeId, view)]);
  const user = await getCurrentUser();

  // The unified nav always shows the "Por llamar" sub-segment counts, so we need
  // those leads even when another tab is active (bounded by getStoreLeads' limit).
  // Segment filtering only applies within "Por llamar".
  const porLlamarLeads = view === "por_llamar" ? leads : await getStoreLeads(storeId, "por_llamar");
  const segCounts = countLeadSegments(porLlamarLeads);
  let segment: LeadSegment | null = null;
  let displayLeads = leads;
  if (view === "por_llamar") {
    segment = isLeadSegment(sp.seg) ? sp.seg : null;
    if (segment) displayLeads = leads.filter((l) => leadSegment(l) === segment);
  }

  return (
    <LeadsBoard
      stores={stores}
      storeId={storeId}
      view={view}
      counts={counts}
      leads={displayLeads}
      segCounts={segCounts}
      segment={segment}
      currentUserId={user?.id ?? ""}
    />
  );
}
