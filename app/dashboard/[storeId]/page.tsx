import { notFound, redirect } from "next/navigation";
import {
  getAccessibleStores,
  getConversations,
  getLatestOps,
  getOrders,
  getRollups,
  getUserRoleSummary,
  parseRange,
  previousRange,
} from "@/lib/access";
import { DashboardView } from "@/components/dashboard-view";

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
  const [rollups, prevRollups, orders, conversations, ops] = await Promise.all([
    getRollups([storeId], range),
    getRollups([storeId], prev),
    getOrders([storeId], range),
    getConversations([storeId], range),
    getLatestOps([storeId]),
  ]);

  return (
    <DashboardView
      stores={stores}
      scope={storeId}
      range={range}
      rollups={rollups}
      prevRollups={prevRollups}
      orders={orders}
      conversations={conversations}
      ops={ops}
      currency={store.currency}
      timezone={store.timezone}
      singleStore={store}
    />
  );
}
