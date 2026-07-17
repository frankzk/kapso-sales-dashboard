import { getAccessibleStores, getAdNames, getCurrentUser, getWaNumbers } from "@/lib/access";
import { LEAD_VIEWS, getLeadCounts, getStoreLeads, type LeadView } from "@/lib/leads-access";
import { getLeadsInsights } from "@/lib/leads-insights";
import {
  isLeadGestion,
  isLeadSegment,
  isQueueState,
  leadInteractionDateFilterFromParams,
  type LeadGestion,
  type LeadSegment,
  type QueueState,
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
  searchParams: Promise<{
    store?: string;
    view?: string;
    state?: string;
    tab?: string; // back-compat con el PR #76 (fila plana)
    seg?: string;
    gest?: string;
    last_date?: string;
    last_before?: string;
    open?: string;
  }>;
}) {
  const sp = await searchParams;
  const stores = await getAccessibleStores();

  if (!stores.length) {
    return <EmptyState title="No tienes tiendas asignadas" />;
  }

  const fallback = stores[0]!;
  const storeId = sp.store && stores.some((s) => s.id === sp.store) ? sp.store : fallback.id;
  const view: LeadView = isLeadView(sp.view) ? sp.view : "por_llamar";
  // Pestaña inicial de la cola al llegar por link; dentro de la cola se maneja
  // client-side en el board (cambio instantáneo, sin refetch). Back-compat: un
  // ?seg= (drill-down) abre ese segmento; un ?gest= de seguimiento abre la pestaña
  // "En seguimiento" para que el filtro de gestión tenga sentido.
  // Eje 1 (estado): ?state=. Back-compat: ?tab=sin_llamar|seguimiento del PR #76, o
  // un ?gest= de seguimiento abre "En seguimiento" para que el filtro tenga sentido.
  const initialState: QueueState | null = isQueueState(sp.state)
    ? sp.state
    : isQueueState(sp.tab)
      ? sp.tab
      : isLeadGestion(sp.gest) && sp.gest !== "sin_llamar"
        ? "seguimiento"
        : null;
  // Eje 2 (segmento): ?seg=, o un ?tab=<segmento> viejo del PR #76.
  const initialSeg: LeadSegment | null = isLeadSegment(sp.seg)
    ? sp.seg
    : isLeadSegment(sp.tab)
      ? sp.tab
      : null;
  const initialGest: LeadGestion | null = isLeadGestion(sp.gest) ? sp.gest : null;
  const initialInteractionDate = leadInteractionDateFilterFromParams(sp.last_date, sp.last_before);

  const [counts, leads, user] = await Promise.all([
    getLeadCounts(storeId),
    // "Por llamar" se filtra/cuenta en cliente (jerarquía de facetas), así que la
    // cola se pagina completa (`null`) para que los conteos y drill-downs usen el
    // mismo universo que el gráfico; las demás vistas mantienen el tope estándar.
    getStoreLeads(storeId, view, view === "por_llamar" ? null : 200),
    getCurrentUser(),
  ]);

  const store = stores.find((s) => s.id === storeId);
  const currency = store?.currency ?? "PEN";
  const timezone = store?.timezone ?? "America/Lima";

  // Meta ad attribution + WhatsApp-number labels for the leads in view, plus the
  // "Tablero de hoy" insights (burndown + sin llamar + productividad). El burndown
  // ancla en el conteo "Sin llamar" (la prioridad: primer contacto), así que espera `counts`.
  const [adNames, waNumbers, insights] = await Promise.all([
    getAdNames(leads.map((l) => l.ad_id)),
    getWaNumbers(leads.map((l) => l.wa_phone_number_id)),
    getLeadsInsights(storeId, timezone, counts.sin_llamar),
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
      timezone={timezone}
      insights={insights}
      initialState={initialState}
      initialSeg={initialSeg}
      initialGest={initialGest}
      initialInteractionDate={initialInteractionDate}
      initialOpenId={typeof sp.open === "string" ? sp.open : null}
      currentUserId={user?.id ?? ""}
    />
  );
}
