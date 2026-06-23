import { notFound, redirect } from "next/navigation";
import {
  getAccessibleStores,
  getConversations,
  getLatestOps,
  getLeadsForDashboard,
  getOrders,
  getRollups,
  getUserRoleSummary,
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
    />
  );
}
