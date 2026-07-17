import Link from "next/link";
import { Suspense } from "react";
import { redirect } from "next/navigation";
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
  const adNamesPromise = leadsPromise.then((leads) => getAdNames(leads.map((l) => l.ad_id)));
  const waNumbersPromise = leadsPromise.then((leads) =>
    getWaNumbers(leads.map((l) => l.wa_phone_number_id)),
  );
  const [rollups, prevRollups, orders, conversations, leads, ops, adNames, waNumbers] =
    await Promise.all([
      getRollups(storeIds, range),
      getRollups(storeIds, prev),
      getOrders(storeIds, range),
      getConversations(storeIds, range),
      leadsPromise,
      getLatestOps(storeIds),
      adNamesPromise,
      waNumbersPromise,
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
    />
  );
}
