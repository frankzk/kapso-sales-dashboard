import { Suspense } from "react";
import { getAccessibleStores } from "@/lib/access";
import {
  getReprogramStats,
  getTeamScore,
  getShipmentCounts,
  getStoreShipments,
  isShipmentView,
  type ShipmentView,
} from "@/lib/shipments-access";
import { limaTodayKey } from "@/lib/shipments";
import { EmptyState } from "@/components/ui";
import { ShipmentsBoard } from "@/components/shipments";
import { SwaypUnknownGuides } from "@/components/swayp-unknown-guides";
import { getSwaypUnknownGuides } from "@/lib/swayp-unknown-guides-access";
import { DashboardRouteSkeleton } from "@/components/dashboard-route-skeleton";
import { pageLoadTimer } from "@/lib/page-load-log";

export const dynamic = "force-dynamic";

export default function EnviosPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string; open?: string }>;
}) {
  return (
    <Suspense fallback={<DashboardRouteSkeleton />}>
      <EnviosContent searchParams={searchParams} />
    </Suspense>
  );
}

async function EnviosContent({
  searchParams,
}: {
  searchParams: Promise<{ view?: string; open?: string }>;
}) {
  // Una línea por carga en los logs (lib/page-load-log.ts): solo tiempos y conteos.
  const load = pageLoadTimer("envios");
  const [sp, stores] = await Promise.all([searchParams, getAccessibleStores()]);
  if (!stores.length) {
    return <EmptyState title="No tienes tiendas asignadas" />;
  }

  const view: ShipmentView = isShipmentView(sp.view) ? sp.view : "pendiente";

  // counts + queue span ALL accessible stores (guides are a shared multitienda
  // pool); the store/province/district filters happen client-side in the board.
  const storeIds = stores.map((s) => s.id);
  const today = limaTodayKey();
  const [counts, shipments, reprogram, teamScore, swaypUnknown] = await Promise.all([
    load.timed("contadores", getShipmentCounts(storeIds)),
    load.timed("guias", getStoreShipments(storeIds, view)),
    load.timed("reprogramacion", getReprogramStats(storeIds)),
    load.timed("equipo", getTeamScore(storeIds, today, today)),
    // Sin la 0282 (o si falla la lectura) no hay tarjeta: nunca tumba Envíos.
    getSwaypUnknownGuides(storeIds).catch(() => null),
  ]);
  load.done({ filas: shipments.length });

  // El automático Aliclik → Swayp se abre desde las acciones de la cabecera
  // del tablero: vivía en un enlace suelto encima de la página.
  return (
    <ShipmentsBoard
      stores={stores}
      view={view}
      reprogram={reprogram}
      counts={counts}
      shipments={shipments}
      teamScore={teamScore}
      initialOpenId={sp.open ?? null}
      swaypUnknown={swaypUnknown?.length ? <SwaypUnknownGuides guides={swaypUnknown} /> : null}
    />
  );
}
