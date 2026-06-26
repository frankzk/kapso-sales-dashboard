import { redirect } from "next/navigation";
import { getAccessibleStores, getUserRoleSummary, parseRange } from "@/lib/access";
import { getAdvisorProductivityCompare } from "@/lib/productivity";
import { ProductivityBoard } from "@/components/productivity";
import { EmptyState } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function ProductividadPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string; store?: string; src?: string }>;
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
  const source =
    sp.src === "meta_ad" || sp.src === "cod_cart" || sp.src === "organic" ? sp.src : null;

  const first = stores[0]!;
  const currency = stores.every((s) => s.currency === first.currency) ? first.currency : "PEN";
  // Infer active hours by each store's local day; mixed tz → Lima (the business default).
  const tz = stores.every((s) => s.timezone === first.timezone) ? first.timezone : "America/Lima";

  const { rows, prevTotals, prevRange, hasPrev } = await getAdvisorProductivityCompare(
    scopeIds,
    range,
    source,
    tz,
  );

  return (
    <ProductivityBoard
      rows={rows}
      prevTotals={prevTotals}
      prevRange={prevRange}
      hasPrev={hasPrev}
      range={range}
      currency={currency}
      stores={stores}
      storeId={storeId}
      source={source}
    />
  );
}
