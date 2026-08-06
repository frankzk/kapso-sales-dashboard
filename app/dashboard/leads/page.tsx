import { Suspense } from "react";
import { getAccessibleStores, getAdNames, getCurrentUser, getWaNumbers } from "@/lib/access";
import {
  ALL_STORES,
  LEAD_VIEWS,
  getLeadQueueSnapshot,
  getStoreLeads,
  leadsViewLimit,
  type LeadView,
  type StoreScope,
} from "@/lib/leads-access";
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
import { DashboardRouteSkeleton } from "@/components/dashboard-route-skeleton";

export const dynamic = "force-dynamic";

function isLeadView(v: string | undefined): v is LeadView {
  return !!v && LEAD_VIEWS.some((view) => view.key === v);
}

type LeadsSearchParams = {
  store?: string;
  view?: string;
  state?: string;
  tab?: string; // back-compat con el PR #76 (fila plana)
  seg?: string;
  gest?: string;
  last_date?: string;
  last_before?: string;
  open?: string;
};

export default function LeadsPage({
  searchParams,
}: {
  searchParams: Promise<LeadsSearchParams>;
}) {
  return (
    <Suspense fallback={<DashboardRouteSkeleton />}>
      <LeadsContent searchParams={searchParams} />
    </Suspense>
  );
}

async function LeadsContent({
  searchParams,
}: {
  searchParams: Promise<LeadsSearchParams>;
}) {
  const sp = await searchParams;
  const stores = await getAccessibleStores();

  if (!stores.length) {
    return <EmptyState title="No tienes tiendas asignadas" />;
  }

  const fallback = stores[0]!;
  // `?store=all` = todas las tiendas que ESTE usuario puede ver. Nunca "todas
  // las de la base": el universo sale de getAccessibleStores, y la RLS lo
  // respalda por debajo.
  //
  // "Todas" solo se ofrece si las tiendas comparten moneda y zona horaria. No es
  // una limitación técnica sino de significado: la cola muestra montos de
  // carrito y ventanas de 24 h, y mezclar dos monedas sumaría soles con otra
  // cosa sin decirlo. Hoy las dos son PEN/Lima, así que se ofrece; el día que
  // entre una tienda de otro país, el selector deja de mostrarlo solo.
  const uniform =
    stores.length > 1 &&
    stores.every((s) => s.currency === fallback.currency && s.timezone === fallback.timezone);
  const allSelected = uniform && sp.store === ALL_STORES;
  const storeId = sp.store && stores.some((s) => s.id === sp.store) ? sp.store : fallback.id;
  // Alcance efectivo de TODA la vista: lista, conteos, gráficos y firma.
  const scope: StoreScope = allSelected ? stores.map((s) => s.id) : [storeId];
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

  const store = allSelected ? fallback : stores.find((s) => s.id === storeId);
  const currency = store?.currency ?? "PEN";
  const timezone = store?.timezone ?? "America/Lima";

  const snapshotPromise = getLeadQueueSnapshot(scope);
  // "Por llamar" se filtra/cuenta en cliente (jerarquía de facetas), así que la
  // cola se pagina completa (`null`) para que los conteos y drill-downs usen el
  // mismo universo que el gráfico; las demás vistas mantienen el tope estándar.
  const leadsPromise = getStoreLeads(scope, view, leadsViewLimit(view));
  const userPromise = getCurrentUser();
  // These lookups depend only on the list, so pipeline them as soon as that
  // promise settles instead of waiting for counts and user first.
  const adNamesPromise = leadsPromise.then((rows) => getAdNames(rows.map((l) => l.ad_id)));
  const waNumbersPromise = leadsPromise.then((rows) => getWaNumbers(rows.map((l) => l.wa_phone_number_id)));
  const [snapshot, leads, user, adNames, waNumbers] = await Promise.all([
    snapshotPromise,
    leadsPromise,
    userPromise,
    adNamesPromise,
    waNumbersPromise,
  ]);

  return (
    <LeadsBoard
      key={`${scope.join(",")}:${view}`}
      stores={stores}
      storeId={allSelected ? ALL_STORES : storeId}
      scope={scope}
      allStoresAvailable={uniform}
      view={view}
      counts={snapshot.counts}
      queueSignature={snapshot.signature}
      leads={leads}
      adNames={adNames}
      waNumbers={waNumbers}
      currency={currency}
      timezone={timezone}
      insights={null}
      initialState={initialState}
      initialSeg={initialSeg}
      initialGest={initialGest}
      initialInteractionDate={initialInteractionDate}
      initialOpenId={typeof sp.open === "string" ? sp.open : null}
      currentUserId={user?.id ?? ""}
      leadsComplete={leadsViewLimit(view) === null}
    />
  );
}
