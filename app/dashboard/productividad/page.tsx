import { Suspense } from "react";
import { redirect } from "next/navigation";
import { getAccessibleStores, getUserRoleSummary } from "@/lib/access";
import { getProductivityBoard, productivityInitialRange } from "@/lib/productivity";
import { ProductivityBoard } from "@/components/productivity";
import { EmptyState } from "@/components/ui";
import { DashboardRouteSkeleton } from "@/components/dashboard-route-skeleton";

export const dynamic = "force-dynamic";

export default function ProductividadPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string; store?: string; src?: string }>;
}) {
  return (
    <Suspense fallback={<DashboardRouteSkeleton />}>
      <ProductividadContent searchParams={searchParams} />
    </Suspense>
  );
}

async function ProductividadContent({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string; store?: string; src?: string }>;
}) {
  const [role, sp, stores] = await Promise.all([
    getUserRoleSummary(),
    searchParams,
    getAccessibleStores(),
  ]);
  if (role.isVendedoraOnly) redirect("/dashboard/leads");
  if (!stores.length) {
    return <EmptyState title="Aún no tienes tiendas conectadas" />;
  }

  const storeIds = stores.map((s) => s.id);
  const storeId = sp.store && stores.some((s) => s.id === sp.store) ? sp.store : null;
  const scopeIds = storeId ? [storeId] : storeIds;
  const source =
    sp.src === "meta_ad" ||
    sp.src === "fb_web" ||
    sp.src === "cod_cart" ||
    sp.src === "abandoned_browse" ||
    sp.src === "organic"
      ? sp.src
      : null;

  const first = stores[0]!;
  const currency = stores.every((s) => s.currency === first.currency) ? first.currency : "PEN";
  // Infer active hours by each store's local day; mixed tz → Lima (the business default).
  const tz = stores.every((s) => s.timezone === first.timezone) ? first.timezone : "America/Lima";

  const range = productivityInitialRange(sp, tz);
  const board = await getProductivityBoard(scopeIds, range, source, tz);
  // Dots iniciales: asesoras del tablero online + las online sin actividad.
  const initialOnlineIds = [
    ...board.rows.filter((r) => r.online).map((r) => r.userId),
    ...board.onlineIdle.map((i) => i.userId),
  ];

  return (
    <ProductivityBoard
      rows={board.rows}
      prevTotals={board.prevTotals}
      prevRange={board.prevRange}
      hasPrev={board.hasPrev}
      range={range}
      currency={currency}
      stores={stores}
      storeId={storeId}
      source={source}
      tz={tz}
      heatMax={board.heatMax}
      heatMode={board.heatMode}
      onlineIdle={board.onlineIdle}
      initialOnlineIds={initialOnlineIds}
    />
  );
}
