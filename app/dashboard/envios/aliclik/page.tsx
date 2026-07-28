import { Suspense } from "react";
import { getAccessibleStores } from "@/lib/access";
import { getMasterPermissions } from "@/lib/permissions-access";
import { EmptyState } from "@/components/ui";
import { AliclikCatalog } from "@/components/aliclik-catalog";
import { DashboardRouteSkeleton } from "@/components/dashboard-route-skeleton";
import { loadCatalogView } from "./actions";

export const dynamic = "force-dynamic";

// Catálogo de Aliclik y mapeo de SKUs.
//
// Vive bajo Envíos y no en el Master porque es DATO MAESTRO: se configura una
// vez por tienda y sirve para todos los pedidos, no se toca pedido a pedido.

export default function AliclikCatalogPage({
  searchParams,
}: {
  searchParams: Promise<{ store?: string }>;
}) {
  return (
    <Suspense fallback={<DashboardRouteSkeleton />}>
      <Content searchParams={searchParams} />
    </Suspense>
  );
}

async function Content({ searchParams }: { searchParams: Promise<{ store?: string }> }) {
  const [sp, stores, perms] = await Promise.all([
    searchParams,
    getAccessibleStores(),
    getMasterPermissions(),
  ]);
  if (!stores.length) return <EmptyState title="No tienes tiendas asignadas" />;

  // El catálogo es por tienda porque el token de Aliclik lo es.
  const store = stores.find((s) => s.id === sp.store) ?? stores[0]!;
  const view = await loadCatalogView(store.id);

  return (
    <div className="space-y-4">
      {stores.length > 1 && (
        <nav className="flex flex-wrap gap-2">
          {stores.map((s) => (
            <a
              key={s.id}
              href={`/dashboard/envios/aliclik?store=${s.id}`}
              className={`rounded-lg px-3 py-1.5 text-sm ${
                s.id === store.id
                  ? "bg-slate-900 text-white"
                  : "border border-slate-300 text-slate-700 hover:bg-slate-50"
              }`}
            >
              {s.name}
            </a>
          ))}
        </nav>
      )}
      <AliclikCatalog
        view={view}
        storeId={store.id}
        storeName={store.name}
        canManage={perms.can("aliclik.manage_catalog")}
      />
    </div>
  );
}
