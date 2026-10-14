import Link from "next/link";
import { Suspense } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import {
  getAccessibleStores,
  getAdNames,
  getAttributionInputs,
  getCampaignDeliveryOutcomes,
  getClosingChannels,
  getCampaignLeadsForDashboard,
  getOriginSales,
  getSourceConversion,
  getConversations,
  getLatestOps,
  getLeadsForDashboard,
  getMetaAdCatalog,
  getMetaAdPerformance,
  getOrdersByIds,
  getOrders,
  getWebAdOrders,
  getRollups,
  getUserRoleSummary,
  getWaNumbers,
  parseRange,
  previousRange,
} from "@/lib/access";
import { ExecutiveDashboard } from "@/components/executive-dashboard";
import { salesAttribution } from "@/lib/metrics";
import { EmptyState } from "@/components/ui";
import { DashboardRouteSkeleton } from "@/components/dashboard-route-skeleton";
import {
  MomOwnerSummaryPanel,
  MomOwnerSummarySkeleton,
} from "@/components/mom-owner-summary";
import { getMomOwnerSummary } from "@/lib/mom-owner-summary-access";
import { Banner } from "@/components/ops-ui";
import { LtvCpaPanel, LtvCpaSkeleton } from "@/components/ltv-cpa";
import { getLtvInputs } from "@/lib/ltv-access";
import { buildCohorts } from "@/lib/ltv";
import { PENDING_INSTALL_COOKIE } from "@/lib/shopify-client-app";

export const dynamic = "force-dynamic";

export default function ConsolidatedPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string }>;
}) {
  return (
    <Suspense fallback={<DashboardRouteSkeleton />}>
      <ConsolidatedContent searchParams={searchParams} />
    </Suspense>
  );
}

async function ConsolidatedContent({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string }>;
}) {
  // Quien instaló la app de Shopify para tiendas cliente sin sesión abierta
  // entra al login, y el login siempre aterriza aquí: se retoma el reclamo de
  // la instalación (MOM §29.15.9). La cookie vence con la instalación.
  if ((await cookies()).get(PENDING_INSTALL_COOKIE)) redirect("/dashboard/conectar-shopify");
  const [role, sp, stores] = await Promise.all([
    getUserRoleSummary(),
    searchParams,
    getAccessibleStores(),
  ]);
  if (role.isVendedoraOnly) redirect("/dashboard/leads");
  const range = parseRange(sp);

  if (!stores.length) {
    return (
      <EmptyState title="Aún no tienes tiendas conectadas">
        <Link
          href="/dashboard/stores/new"
          className="mt-2 inline-block rounded-lg bg-brand-600 px-4 py-2 font-medium text-white hover:bg-brand-700"
        >
          Conectar tu primera tienda
        </Link>
      </EmptyState>
    );
  }

  const storeIds = stores.map((s) => s.id);
  const prev = previousRange(range);
  const leadsPromise = getLeadsForDashboard(storeIds, range);
  const campaignLeadsPromise = Promise.all(
    stores.map((store) => getCampaignLeadsForDashboard(store.id, range, store.timezone)),
  ).then((rows) => rows.flat());
  // The consolidated dashboard used to omit Meta Insights entirely, so the
  // campaign table fell back to conversion (for example 4.0%) where CPA should
  // appear even though every store already had synchronized spend history.
  const metaAdPerformancePromise = Promise.all(
    storeIds.map((storeId) => getMetaAdPerformance(storeId, range)),
  ).then((rows) => rows.flat());
  const adNamesPromise = Promise.all([campaignLeadsPromise, metaAdPerformancePromise]).then(
    ([leads, performance]) =>
      getAdNames([
        ...leads.map((lead) => lead.ad_id),
        ...performance.map((row) => row.adId),
      ]),
  );
  const waNumbersPromise = leadsPromise.then((leads) =>
    getWaNumbers(leads.map((l) => l.wa_phone_number_id)),
  );
  const campaignOrdersPromise = campaignLeadsPromise.then((campaignLeads) =>
    getOrdersByIds(storeIds, campaignLeads.map((lead) => lead.order_id)),
  );
  // Los pedidos del carrito COD de la web, que no llegan por ningún lead y por
  // eso el panel de anuncios no los veía (lib/cod-cart-attribution.ts).
  const webAdOrdersPromise = getWebAdOrders(storeIds, range);
  const metaAdCatalogPromise = webAdOrdersPromise.then((web) => getMetaAdCatalog(web));
  // La entrega de ESTOS pedidos también, o su ROAS entregado saldría en cero y
  // el panel diría que un anuncio que vende no entrega nada.
  const campaignDeliveriesPromise = Promise.all([campaignLeadsPromise, webAdOrdersPromise]).then(
    ([leads, web]) =>
      getCampaignDeliveryOutcomes([
        ...leads.map((l) => l.order_id),
        ...web.map((w) => w.order.id),
      ]),
  );
  const [
    rollups,
    prevRollups,
    orders,
    conversations,
    leads,
    ops,
    adNames,
    waNumbers,
    campaignDeliveries,
    campaignLeads,
    campaignOrders,
    metaAdPerformance,
    webAdOrders,
    metaAdCatalog,
    closing,
    origin,
    sourceConversion,
  ] =
    await Promise.all([
      getRollups(storeIds, range),
      getRollups(storeIds, prev),
      getOrders(storeIds, range),
      getConversations(storeIds, range),
      leadsPromise,
      getLatestOps(storeIds),
      adNamesPromise,
      waNumbersPromise,
      campaignDeliveriesPromise,
      campaignLeadsPromise,
      campaignOrdersPromise,
      metaAdPerformancePromise,
      webAdOrdersPromise,
      metaAdCatalogPromise,
      // Quién cerró TODAS las ventas de las tiendas, no solo las del bot (MOM §17.3).
      getClosingChannels(storeIds, range),
      // Todas las ventas por día y origen, y la conversión de cada fuente (MOM §17.4).
      getOriginSales(storeIds, range),
      getSourceConversion(storeIds, range),
    ]);

  // Atribución de fuente y canal de cierre, igual que en la página de tienda.
  // Va después del bloque paralelo porque necesita los pedidos ya resueltos: sus
  // señales se buscan por el teléfono de cada pedido. Faltaba acá, y esa
  // ausencia era el bug — el Consolidado repartía las ventas entre BOT y asesor
  // por la etiqueta del pedido, así que las 12.667 gestiones que las asesoras
  // registran cada 30 días no contaban salvo que además hubieran creado el
  // pedido desde el dashboard.
  const attribution = salesAttribution(orders, await getAttributionInputs(storeIds, orders));

  const first = stores[0]!;
  const currency = stores.every((s) => s.currency === first.currency) ? first.currency : "PEN";

  return (
    <ExecutiveDashboard
      operations={
        // La operación del MOM y LTV : CPA (MOM §17.2, «debajo del resumen
        // operativo») no siguen al periodo: llegan cada una por su lado y no
        // frenan el tablero comercial.
        <>
          <Suspense fallback={<MomOwnerSummarySkeleton />}>
            <MomOwnerSummaryLoader
              storeIds={storeIds}
              orgIds={[...new Set(stores.map((store) => store.org_id))]}
            />
          </Suspense>
          <Suspense fallback={<LtvCpaSkeleton />}>
            <LtvCpaLoader stores={stores.map((store) => ({ id: store.id, name: store.name, currency: store.currency }))} />
          </Suspense>
        </>
      }
      stores={stores}
      scope="all"
      range={range}
      rollups={rollups}
      prevRollups={prevRollups}
      orders={orders}
      conversations={conversations}
      leads={leads}
      ops={ops}
      currency={currency}
      timezone={first.timezone}
      adNames={adNames}
      waNumbers={waNumbers}
      attribution={attribution}
      closing={closing}
      origin={origin}
      sourceConversion={sourceConversion}
      campaignDeliveries={campaignDeliveries}
      campaignLeads={campaignLeads}
      campaignOrders={campaignOrders}
      metaAdPerformance={metaAdPerformance}
      webAdOrders={webAdOrders}
      metaAdCatalog={metaAdCatalog}
    />
  );
}

async function MomOwnerSummaryLoader({
  storeIds,
  orgIds,
}: {
  storeIds: string[];
  orgIds: string[];
}) {
  try {
    const summary = await getMomOwnerSummary(storeIds, orgIds);
    return <MomOwnerSummaryPanel summary={summary} />;
  } catch (error) {
    console.error("No se pudo cargar el resumen operativo MOM", error);
    return (
      <Banner tone="warn" role="status" title="La operación no pudo actualizarse">
        Las ventas del periodo y el Master de Pedidos siguen disponibles.
      </Banner>
    );
  }
}

/** LTV : CPA por mes de primera compra (MOM §17). Un fallo no tumba el resto. */
async function LtvCpaLoader({ stores }: { stores: { id: string; name: string; currency: string }[] }) {
  try {
    const { cohorts, spend } = await getLtvInputs(stores.map((store) => store.id));
    const currencyByStore = Object.fromEntries(stores.map((store) => [store.id, store.currency]));
    const views = buildCohorts(cohorts, spend, currencyByStore, new Date());
    return <LtvCpaPanel stores={stores} views={views} />;
  } catch (error) {
    console.error("No se pudo cargar LTV : CPA", error);
    return (
      <Banner tone="warn" role="status">
        LTV : CPA no pudo calcularse ahora. El resto del Consolidado sigue disponible.
      </Banner>
    );
  }
}
