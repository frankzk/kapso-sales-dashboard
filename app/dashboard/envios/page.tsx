import { Suspense } from "react";
import { getAccessibleStores } from "@/lib/access";
import {
  getReprogramStats,
  getReproTodayByAgent,
  getVoiceScore,
  getShipmentCounts,
  getStoreShipments,
  isShipmentView,
  type ShipmentView,
} from "@/lib/shipments-access";
import { limaTodayKey } from "@/lib/shipments";
import { EmptyState } from "@/components/ui";
import { ShipmentsBoard } from "@/components/shipments";
import { DashboardRouteSkeleton } from "@/components/dashboard-route-skeleton";

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
  const [sp, stores] = await Promise.all([searchParams, getAccessibleStores()]);
  if (!stores.length) {
    return <EmptyState title="No tienes tiendas asignadas" />;
  }

  const view: ShipmentView = isShipmentView(sp.view) ? sp.view : "pendiente";

  // counts + queue span ALL accessible stores (guides are a shared multitienda
  // pool); the store/province/district filters happen client-side in the board.
  const storeIds = stores.map((s) => s.id);
  const today = limaTodayKey();
  const [counts, shipments, reprogram, todayByAgent, voiceScore] = await Promise.all([
    getShipmentCounts(storeIds),
    getStoreShipments(storeIds, view),
    getReprogramStats(storeIds),
    getReproTodayByAgent(storeIds),
    getVoiceScore(storeIds, today, today),
  ]);

  // El automático Aliclik → Swayp se abre desde las acciones de la cabecera
  // del tablero: vivía en un enlace suelto encima de la página.
  return (
    <ShipmentsBoard
      stores={stores}
      view={view}
      reprogram={reprogram}
      counts={counts}
      shipments={shipments}
      todayByAgent={todayByAgent}
      voiceScore={voiceScore}
      initialOpenId={sp.open ?? null}
    />
  );
}
