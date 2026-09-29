"use client";

// Reparto y liquidación de una ruta, al lado de la lista de Rutas (MOM
// §29.14): el mismo panel que la caja, con `?reparto=<ruta>` en la URL.
//
// Antes «Reparto y liquidación» era otra página entera; ahora la fila de la
// lista lo abre aquí, con `history.pushState` (sin pedir la pantalla al
// servidor), cerrar reemplaza la URL conservando filtros, Escape cierra, y
// tras cada acción (terminar ruta, cerrar, añadir paradas, aprobar pago) se
// recarga el detalle y se refresca la fila de atrás. Solo un panel a la vez:
// abrir este cierra la caja y viceversa (lib/courier-box-href.ts).

import { Suspense, useCallback, useEffect, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Badge, Banner, SidePanel, Skeleton, type BadgeTone } from "@/components/ops-ui";
import { RoutesBoard } from "@/components/routes";
import { loadCourierRouteReport, type CourierRouteReport } from "@/app/dashboard/courier/actions";
import { closeCourierBoxHref, readCourierReportRequest } from "@/lib/courier-box-href";
import { routeDayLong } from "@/lib/dispatch";

/** Estado de la ruta en la cabecera: armando, en curso o cerrada (lib/routes-access). */
const ROUTE_TONE: Record<string, { label: string; tone: BadgeTone }> = {
  planificada: { label: "Armando", tone: "neutral" },
  en_curso: { label: "En curso", tone: "info" },
  cerrada: { label: "Cerrada", tone: "neutral" },
};

export function CourierRouteReportDrawer() {
  return (
    <Suspense fallback={null}>
      <CourierRouteReportDrawerInner />
    </Suspense>
  );
}

function CourierRouteReportDrawerInner() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const router = useRouter();
  const search = searchParams.toString();
  const request = readCourierReportRequest({ pathname, search });

  const close = useCallback(() => {
    window.history.replaceState(null, "", closeCourierBoxHref({ pathname, search }));
  }, [pathname, search]);

  // `router.refresh()` diferido: en el mismo tick que un cambio de URL, Next
  // pisaba la URL nueva con la vieja.
  const [refreshTick, setRefreshTick] = useState(0);
  useEffect(() => {
    if (refreshTick) router.refresh();
  }, [refreshTick, router]);

  if (!request) return null;
  return <CourierRouteReportPanel key={request.routeId} routeId={request.routeId} onClose={close} onChanged={() => setRefreshTick((n) => n + 1)} />;
}

function CourierRouteReportPanel({ routeId, onClose, onChanged }: { routeId: string; onClose: () => void; onChanged: () => void }) {
  const [report, setReport] = useState<CourierRouteReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    let alive = true;
    loadCourierRouteReport(routeId).then((res) => {
      if (!alive) return;
      if ("error" in res) setError(res.error);
      else setReport(res);
    }).catch(() => { if (alive) setError("No se pudo cargar el reparto. Revisa la conexión."); });
    return () => { alive = false; };
  }, [routeId]);

  useEffect(() => load(), [load]);

  // «Volver a comprobar» del panel de cierre: lo que el motorizado reportó
  // desde su teléfono mientras el panel estaba abierto.
  const recheck = useCallback(async () => {
    try {
      const res = await loadCourierRouteReport(routeId);
      if ("error" in res) setError(res.error);
      else { setError(null); setReport(res); }
    } catch {
      setError("No se pudo comprobar de nuevo. Revisa la conexión.");
    }
  }, [routeId]);

  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
  }, [onClose]);

  return <CourierRouteReportView report={report} error={error} onClose={onClose} onChanged={() => { load(); onChanged(); }} onRefresh={recheck} />;
}

/** Lo que el panel enseña, sin cargar nada (se puede mirar con datos de ejemplo). */
export function CourierRouteReportView({ report, error, onClose, onChanged, onRefresh }: {
  report: CourierRouteReport | null;
  error: string | null;
  onClose: () => void;
  onChanged: () => void;
  onRefresh: () => Promise<void>;
}) {
  const route = report?.detail.route ?? null;
  const riderName = route ? (report?.riders.find((r) => r.id === route.rider_id)?.full_name ?? "Motorizado") : "Ruta";

  return (
    <SidePanel
      label={`Reparto y liquidación de ${riderName}`}
      title={route ? riderName : "Reparto y liquidación"}
      badge={route && <Badge tone={ROUTE_TONE[route.status]?.tone ?? "neutral"}>{ROUTE_TONE[route.status]?.label ?? route.status}</Badge>}
      meta={route && `${routeDayLong(route.route_date)} · Reparto y liquidación`}
      width="max-w-[960px]"
      onClose={onClose}
    >
      {error && <Banner tone="crit" role="alert" className="mb-4">{error}</Banner>}
      {!report && !error && (
        <div className="space-y-3">
          <Skeleton className="h-24" />
          <Skeleton className="h-48" />
        </div>
      )}
      {report && (
        <RoutesBoard
          detailOnly
          stores={report.stores}
          riders={report.riders}
          routes={[report.detail.route]}
          detail={report.detail}
          assignable={[]}
          retries={[]}
          day={report.day}
          canReport={report.canReport}
          closeContext={report.closeContext}
          canCancelLoads={report.canCancelLoads}
          onChanged={onChanged}
          onRefresh={onRefresh}
        />
      )}
    </SidePanel>
  );
}
