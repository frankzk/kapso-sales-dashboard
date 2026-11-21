import { env } from "@/lib/env";
import { loadGfAutoActiveStores } from "@/lib/gf-auto-guide-server";
import { loadLimaCourierAutoActiveStores } from "@/lib/lima-courier-auto-server";
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

/** Las tiendas con GF Courier habilitado para crear guías (`stores.gf_courier_enabled` y la llave global). */
async function loadGfCourierStores(storeIds: readonly string[]): Promise<string[]> {
  if (!env.gfCourierWriteEnabled() || !storeIds.length) return [];
  const { data, error } = await createAdminSupabase().from("stores").select("id").in("id", [...storeIds]).eq("gf_courier_enabled", true);
  if (error) throw new Error(error.message);
  return ((data ?? []) as Array<{ id: string }>).map((r) => r.id);
}

/** Cuánto tarda cada lectura (owner, 21-11-2026: «anda cargando súper lento»):
 *  una línea en los logs de Vercel por carga, para medir en vez de adivinar. */
async function timed<T>(times: Record<string, number>, label: string, work: Promise<T>): Promise<T> {
  const started = Date.now();
  try {
    return await work;
  } finally {
    times[label] = Date.now() - started;
  }
}

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
  // «No se entregó» escribe por el motorizado: pide lo mismo que Coordinación (`routes.report_others`).
  let canReportForRider = false;
  let autoGuideStores: string[] = [];
  // «Guía Aliclik» y «Guía GF» bajo «Atender» (owner, 16-11-2026): el permiso de
  // cada courier y las tiendas con GF Courier habilitado (las acciones lo vuelven a pedir).
  let quickGuide: { aliclik: boolean; gfStores: string[] } | undefined;
  // Las tiendas con GF Courier por API: «Programar» ofrece GF Courier en vez de Grupo GF (16-11-2026).
  let gfApiStores: string[] = [];
  // Las tiendas con la guía Aliclik y Swayp del día programado en Activo (0349).
  let courierAutoStores: string[] = [];
  const times: Record<string, number> = {};
  const started = Date.now();
  try {
    let permissions: Awaited<ReturnType<typeof getMasterPermissions>>;
    let gfStores: string[];
    [data, pending, permissions, autoGuideStores, gfStores, courierAutoStores] = await Promise.all([
      timed(times, "casos", loadReproLima(createAdminSupabase(), scope, new Date(), { attention: true })),
      timed(times, "pendientes", loadLimaPending(createAdminSupabase(), scope)),
      getMasterPermissions(),
      // Best-effort: sin la lectura, «Mañana sin guía» alarma como antes.
      loadGfAutoActiveStores(createAdminSupabase(), [...scope.storeIds]).catch(() => []),
      // Best-effort: sin la lectura, la fila no ofrece «Guía GF» (la ficha sí).
      loadGfCourierStores([...scope.storeIds]).catch(() => []),
      // Best-effort: sin la lectura, «Programar» dice que la guía se crea a mano.
      loadLimaCourierAutoActiveStores(createAdminSupabase(), [...scope.storeIds]).catch(() => []),
    ]);
    gfApiStores = gfStores;
    canScheduleDispatch = permissions.can("master.edit");
    canReportForRider = permissions.can("routes.report_others");
    quickGuide = {
      aliclik: permissions.can("aliclik.create_guide"),
      gfStores: permissions.can("gf_courier.create_guide") ? gfStores : [],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return <EmptyState title="No pudimos cargar Repro Lima">{`${message} Recarga la página.`}</EmptyState>;
  } finally {
    console.info(`[repro-lima] carga ${JSON.stringify({ totalMs: Date.now() - started, ...times })}`);
  }
  return <ReproLimaBoard data={data} pending={pending} retriesOnly={scope.retriesOnly} canScheduleDispatch={!scope.retriesOnly && canScheduleDispatch} canReportForRider={!scope.retriesOnly && canReportForRider} autoGuideStores={autoGuideStores} quickGuide={scope.retriesOnly ? undefined : quickGuide} gfApiStores={gfApiStores} courierAutoStores={courierAutoStores} />;
}
