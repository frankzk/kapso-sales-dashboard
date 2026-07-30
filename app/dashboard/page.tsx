import Link from "next/link";
import { Suspense } from "react";
import { redirect } from "next/navigation";
import {
  getAccessibleStores,
  getAdNames,
  getCampaignDeliveryOutcomes,
  getCampaignLeadsForDashboard,
  getConversations,
  getLatestOps,
  getLeadsForDashboard,
  getMetaAdPerformance,
  getOrdersByIds,
  getOrders,
  getRollups,
  getUserRoleSummary,
  getWaNumbers,
  parseRange,
  previousRange,
} from "@/lib/access";
import { ExecutiveDashboard } from "@/components/executive-dashboard";
import { EmptyState } from "@/components/ui";
import { DashboardRouteSkeleton } from "@/components/dashboard-route-skeleton";

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
  const campaignDeliveriesPromise = campaignLeadsPromise.then((leads) =>
    getCampaignDeliveryOutcomes(leads.map((l) => l.order_id)),
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
    ]);

  const first = stores[0]!;
  const currency = stores.every((s) => s.currency === first.currency) ? first.currency : "PEN";

  return (
    <ExecutiveDashboard
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
      campaignDeliveries={campaignDeliveries}
      campaignLeads={campaignLeads}
      campaignOrders={campaignOrders}
      metaAdPerformance={metaAdPerformance}
    />
  );
}
