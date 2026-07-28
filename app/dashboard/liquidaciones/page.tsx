import { Suspense } from "react";
import { getAccessibleStores } from "@/lib/access";
import { getMasterPermissions } from "@/lib/permissions-access";
import {
  getRiders,
  getRiderTariffs,
  getSettlementDetail,
  getSettlements,
} from "@/lib/settlements-access";
import { computeRiderPayout } from "@/lib/settlements";
import { EmptyState } from "@/components/ui";
import { SettlementsBoard } from "@/components/settlements";
import { DashboardRouteSkeleton } from "@/components/dashboard-route-skeleton";

export const dynamic = "force-dynamic";

export default function LiquidacionesPage({
  searchParams,
}: {
  searchParams: Promise<{ id?: string }>;
}) {
  return (
    <Suspense fallback={<DashboardRouteSkeleton />}>
      <LiquidacionesContent searchParams={searchParams} />
    </Suspense>
  );
}

async function LiquidacionesContent({
  searchParams,
}: {
  searchParams: Promise<{ id?: string }>;
}) {
  const [sp, stores, perms] = await Promise.all([
    searchParams,
    getAccessibleStores(),
    getMasterPermissions(),
  ]);
  if (!stores.length) {
    return <EmptyState title="No tienes tiendas asignadas" />;
  }

  const storeIds = stores.map((s) => s.id);
  const [settlements, riders] = await Promise.all([getSettlements(storeIds), getRiders()]);

  // El detalle se carga solo cuando hay una liquidación abierta: es una consulta
  // por pedido mencionado y no hace falta pagarla al entrar al listado.
  const openId = sp.id && settlements.some((s) => s.id === sp.id) ? sp.id : null;
  const [detail, tariffs] = openId
    ? await Promise.all([getSettlementDetail(openId), getRiderTariffs()])
    : [null, []];

  // El pago se PREVISUALIZA con las tarifas de hoy; al cerrar se vuelve a
  // calcular y se congela. Si falta una tarifa, se ve antes de intentar cerrar.
  const payout =
    detail && detail.settlement.status !== "cerrada"
      ? computeRiderPayout(detail.reconciled.lines, tariffs, detail.settlement.settlement_date)
      : null;

  return (
    <SettlementsBoard
      stores={stores}
      riders={riders}
      settlements={settlements}
      detail={detail}
      payout={payout}
      canEdit={perms.can("settlements.manage")}
      canClose={perms.can("settlements.close")}
    />
  );
}
