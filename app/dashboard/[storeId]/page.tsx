import { notFound, redirect } from "next/navigation";
import {
  getAccessibleStores,
  getAdNames,
  getCampaignDeliveryOutcomes,
  getCampaignLeadsForDashboard,
  getAttributionInputs,
  getConversations,
  getLatestOps,
  getLeadsForDashboard,
  getMetaAdPerformance,
  getMetaSpend,
  getOrders,
  getOrdersByIds,
  getRollups,
  getUserRoleSummary,
  getWaNumbers,
  parseRange,
  previousRange,
} from "@/lib/access";
import { salesAttribution } from "@/lib/metrics";
import { ExecutiveDashboard } from "@/components/executive-dashboard";

export const dynamic = "force-dynamic";

export default async function StorePage({
  params,
  searchParams,
}: {
  params: Promise<{ storeId: string }>;
  searchParams: Promise<{ from?: string; to?: string }>;
}) {
  if ((await getUserRoleSummary()).isVendedoraOnly) redirect("/dashboard/leads");
  const { storeId } = await params;
  const sp = await searchParams;
  const range = parseRange(sp);

  const stores = await getAccessibleStores();
  const store = stores.find((s) => s.id === storeId);
  if (!store) notFound(); // not accessible (RLS) or non-existent

  const prev = previousRange(range);
  const [rollups, prevRollups, orders, conversations, leads, ops] = await Promise.all([
    getRollups([storeId], range),
    getRollups([storeId], prev),
    getOrders([storeId], range),
    getConversations([storeId], range),
    getLeadsForDashboard([storeId], range),
    getLatestOps([storeId]),
  ]);
  const campaignLeads = await getCampaignLeadsForDashboard(storeId, range, store.timezone);
  const campaignOrdersPromise = getOrdersByIds([storeId], campaignLeads.map((lead) => lead.order_id));

  // Resolve Meta ad names + WhatsApp-number labels for the breakdowns, the
  // per-phone attribution signals (source / advisor touches / winback sends,
  // keyed off the period's orders), and Meta ad spend for ROAS. All best-effort.
  const [metaAdPerformance, waNumbers, attributionInputs, metaSpend, campaignDeliveries] = await Promise.all([
    getMetaAdPerformance(storeId, range),
    getWaNumbers(leads.map((l) => l.wa_phone_number_id)),
    getAttributionInputs([storeId], orders),
    getMetaSpend(storeId, range),
    getCampaignDeliveryOutcomes(campaignLeads.map((l) => l.order_id)),
  ]);
  const campaignOrders = await campaignOrdersPromise;
  const adNames = await getAdNames([
    ...campaignLeads.map((l) => l.ad_id),
    ...metaAdPerformance.map((row) => row.adId),
  ]);
  // Compute attribution server-side so only plain, serializable objects cross to
  // the client (the inputs are Maps keyed by phone).
  const attribution = salesAttribution(orders, attributionInputs);

  return (
    <ExecutiveDashboard
      stores={stores}
      scope={storeId}
      range={range}
      rollups={rollups}
      prevRollups={prevRollups}
      orders={orders}
      conversations={conversations}
      leads={leads}
      ops={ops}
      currency={store.currency}
      timezone={store.timezone}
      singleStore={store}
      adNames={adNames}
      waNumbers={waNumbers}
      attribution={attribution}
      metaSpend={metaSpend}
      campaignDeliveries={campaignDeliveries}
      campaignLeads={campaignLeads}
      campaignOrders={campaignOrders}
      metaAdPerformance={metaAdPerformance}
    />
  );
}
