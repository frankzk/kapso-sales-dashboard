import { Suspense } from "react";
import { getAccessibleStores } from "@/lib/access";
import { getMasterPermissions } from "@/lib/permissions-access";
import { EmptyState } from "@/components/ui";
import { ReturnRecoveryQueue } from "@/components/return-recovery-queue";
import { DashboardRouteSkeleton } from "@/components/dashboard-route-skeleton";
import { loadRecoveryView } from "./actions";

export const dynamic = "force-dynamic";

// Recuperación del pedido devuelto (MOM §11).
//
// Es por TIENDA y no multitienda como el resto de Envíos, aunque las guías sean
// un pool compartido: lo que se envía es una plantilla aprobada por Meta, y la
// aprobación es de la WABA de cada tienda. Kenku y Aurela no tienen la misma
// plantilla —hoy Aurela no tiene ninguna—, así que una cola mezclada mostraría
// un botón que funciona para unas filas y no para otras.

export default function RecuperacionPage({
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

  const store = stores.find((s) => s.id === sp.store) ?? stores[0]!;
  const view = await loadRecoveryView(store.id);

  return (
    <div className="space-y-4">
      {stores.length > 1 && (
        <nav className="flex flex-wrap gap-2">
          {stores.map((s) => (
            <a
              key={s.id}
              href={`/dashboard/envios/recuperacion?store=${s.id}`}
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
      <ReturnRecoveryQueue
        view={view}
        storeId={store.id}
        storeName={store.name}
        canContact={perms.can("recovery.contact")}
      />
    </div>
  );
}
