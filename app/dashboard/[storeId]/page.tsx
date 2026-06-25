import { notFound, redirect } from "next/navigation";
import {
  getAccessibleStores,
  getAdNames,
  getConversations,
  getLatestOps,
  getLeadsForDashboard,
  getOrders,
  getRollups,
  getUserRoleSummary,
  getWaNumbers,
  parseRange,
  previousRange,
} from "@/lib/access";
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

  // Resolve Meta ad names + WhatsApp-number labels for the breakdowns.
  const [adNames, waNumbers] = await Promise.all([
    getAdNames(leads.map((l) => l.ad_id)),
    getWaNumbers(leads.map((l) => l.wa_phone_number_id)),
  ]);

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
    />
  );
}
