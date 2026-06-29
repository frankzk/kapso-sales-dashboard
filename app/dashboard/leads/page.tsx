import { getAccessibleStores, getAdNames, getCurrentUser, getWaNumbers } from "@/lib/access";
import { LEAD_VIEWS, getLeadCounts, getStoreLeads, type LeadView } from "@/lib/leads-access";
import { getLeadsInsights } from "@/lib/leads-insights";
import { isLeadGestion, isLeadSegment, type LeadGestion, type LeadSegment } from "@/lib/leads";
import { EmptyState } from "@/components/ui";
import { LeadsBoard } from "@/components/leads";

export const dynamic = "force-dynamic";

function isLeadView(v: string | undefined): v is LeadView {
  return !!v && LEAD_VIEWS.some((view) => view.key === v);
}

export default async function LeadsPage({
  searchParams,
}: {
  searchParams: Promise<{ store?: string; view?: string; seg?: string; gest?: string; open?: string }>;
}) {
  const sp = await searchParams;
  const stores = await getAccessibleStores();

  if (!stores.length) {
    return <EmptyState title="No tienes tiendas asignadas" />;
  }

  const fallback = stores[0]!;
  const storeId = sp.store && stores.some((s) => s.id === sp.store) ? sp.store : fallback.id;
  const view: LeadView = isLeadView(sp.view) ? sp.view : "por_llamar";
  // Initial sub-filter when arriving via a link; within the queue these are then
  // driven client-side in the board for instant switching (no refetch).
  const initialSeg: LeadSegment | null = isLeadSegment(sp.seg) ? sp.seg : null;
  const initialGest: LeadGestion | null = isLeadGestion(sp.gest) ? sp.gest : null;

  const [counts, leads, user] = await Promise.all([
    getLeadCounts(storeId),
    // "Por llamar" se filtra/cuenta en cliente (jerarquía de facetas), así que la
    // cola debe cargarse completa para que los conteos reflejen el total real;
    // las demás vistas mantienen el tope estándar.
    getStoreLeads(storeId, view, view === "por_llamar" ? 1000 : 200),
    getCurrentUser(),
  ]);

  const store = stores.find((s) => s.id === storeId);
  const currency = store?.currency ?? "PEN";
  const timezone = store?.timezone ?? "America/Lima";

  // Meta ad attribution + WhatsApp-number labels for the leads in view, plus the
  // "Tablero de hoy" insights (burndown + 7-day flow/saldo + productividad). The
  // insights anchor on the current "por llamar" count, so they wait on `counts`.
  const [adNames, waNumbers, insights] = await Promise.all([
    getAdNames(leads.map((l) => l.ad_id)),
    getWaNumbers(leads.map((l) => l.wa_phone_number_id)),
    getLeadsInsights(storeId, timezone, counts.por_llamar),
  ]);

  return (
    <LeadsBoard
      stores={stores}
      storeId={storeId}
      view={view}
      counts={counts}
      leads={leads}
      adNames={adNames}
      waNumbers={waNumbers}
      currency={currency}
      insights={insights}
      initialSeg={initialSeg}
      initialGest={initialGest}
      initialOpenId={typeof sp.open === "string" ? sp.open : null}
      currentUserId={user?.id ?? ""}
    />
  );
}
