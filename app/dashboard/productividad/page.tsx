import { redirect } from "next/navigation";
import { getAccessibleStores, getUserRoleSummary, parseRange } from "@/lib/access";
import { getAdvisorProductivity } from "@/lib/productivity";
import { ProductivityBoard } from "@/components/productivity";
import { EmptyState } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function ProductividadPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string; store?: string }>;
}) {
  if ((await getUserRoleSummary()).isVendedoraOnly) redirect("/dashboard/leads");
  const sp = await searchParams;
  const range = parseRange(sp);
  const stores = await getAccessibleStores();

  if (!stores.length) {
    return <EmptyState title="Aún no tienes tiendas conectadas" />;
  }

  const storeIds = stores.map((s) => s.id);
  const storeId = sp.store && stores.some((s) => s.id === sp.store) ? sp.store : null;
  const scopeIds = storeId ? [storeId] : storeIds;

  const rows = await getAdvisorProductivity(scopeIds, range);
  const first = stores[0]!;
  const currency = stores.every((s) => s.currency === first.currency) ? first.currency : "PEN";

  return (
    <ProductivityBoard rows={rows} range={range} currency={currency} stores={stores} storeId={storeId} />
  );
}
