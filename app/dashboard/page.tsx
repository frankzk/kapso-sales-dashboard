import Link from "next/link";
import { redirect } from "next/navigation";
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
import { EmptyState } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function ConsolidatedPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string }>;
}) {
  if ((await getUserRoleSummary()).isVendedoraOnly) redirect("/dashboard/leads");
  const sp = await searchParams;
  const range = parseRange(sp);
  const stores = await getAccessibleStores();

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
  const [rollups, prevRollups, orders, conversations, ops] = await Promise.all([
    getRollups(storeIds, range),
    getRollups(storeIds, prev),
    getOrders(storeIds, range),
    getConversations(storeIds, range),
    getLatestOps(storeIds),
  ]);

  const first = stores[0]!;
  const currency = stores.every((s) => s.currency === first.currency) ? first.currency : "PEN";

  return (
    <DashboardView
      stores={stores}
      scope="all"
      range={range}
      rollups={rollups}
      prevRollups={prevRollups}
      orders={orders}
      conversations={conversations}
      ops={ops}
      currency={currency}
      timezone={first.timezone}
    />
  );
}
