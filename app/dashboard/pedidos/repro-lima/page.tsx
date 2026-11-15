import { Suspense } from "react";
import { EmptyState } from "@/components/ui";
import { ReproLimaBoard } from "@/components/repro-lima-board";
import { createAdminSupabase } from "@/lib/db";
import { loadReproLima, requireReproLima } from "@/lib/repro-lima-access";
import { loadLimaPending } from "@/lib/repro-lima-pending-access";
import { getMasterPermissions } from "@/lib/permissions-access";
import type { LimaPendingOrder } from "@/lib/repro-lima-pending";
import ReproLimaLoading from "./loading";

// «Repro Lima» (fase 1, entrega 1a; MOM §9.5): los clientes de Lima con
// entrega fallida. Entra quien llama a los clientes o despacha
// (`repro_lima.manage`) en las tiendas que tiene en Equipo (E36). La lista se lee con
// el cliente de servicio DESPUÉS de comprobar el permiso y las tiendas
// (`requireReproLima`); cada acción lo vuelve a comprobar. En paralelo se
// lee la lista amplia de pendientes de entrega (28-10-2026), sin crear casos
// para quienes no tuvieron un fallo. Una única tabla presenta la atención de
// todos los pendientes; no carga otro resumen ni una segunda vista. Desde el
// 15-11-2026 la pantalla la ordena en el «Flujo del día» (cinco pasos que
// suman el total) y la «Agenda», y «Agendar» pone el día por la acción de cada pedido:
// «Programar envío» pide `master.edit`, que solo se lee para no ofrecerlo a
// quien no lo tiene (la acción lo vuelve a pedir).
// Un error de lectura impide presentar un total parcial como completo.

export const dynamic = "force-dynamic";

export default function ReproLimaPage() {
  return (
    <Suspense fallback={<ReproLimaLoading />}>
      <ReproLimaContent />
    </Suspense>
  );
}

async function ReproLimaContent() {
  // Despacho entra solo a «Reintentos Aliclik» (`repro_lima.retries`).
  const scope = await requireReproLima({ retries: true });
  if ("error" in scope) {
    return scope.reason === "permiso"
      ? <EmptyState title="Acceso restringido">{scope.error}</EmptyState>
      : <EmptyState title="No tienes tiendas asignadas">{scope.error}</EmptyState>;
  }
  let data: Awaited<ReturnType<typeof loadReproLima>>;
  let pending: LimaPendingOrder[];
  let canScheduleDispatch = false;
  try {
    let permissions: Awaited<ReturnType<typeof getMasterPermissions>>;
    [data, pending, permissions] = await Promise.all([
      loadReproLima(createAdminSupabase(), scope, new Date(), { attention: true }),
      loadLimaPending(createAdminSupabase(), scope),
      getMasterPermissions(),
    ]);
    canScheduleDispatch = permissions.can("master.edit");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return <EmptyState title="No pudimos cargar Repro Lima">{`${message} Recarga la página.`}</EmptyState>;
  }
  return <ReproLimaBoard data={data} pending={pending} retriesOnly={scope.retriesOnly} canScheduleDispatch={!scope.retriesOnly && canScheduleDispatch} />;
}
