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
import { cn } from "@/components/ui";
import { RoutesBoard } from "@/components/routes";
import { loadCourierRouteReport, type CourierRouteReport } from "@/app/dashboard/courier/actions";
import { closeCourierBoxHref, readCourierReportRequest } from "@/lib/courier-box-href";
import { routeDayLong } from "@/lib/dispatch";

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

  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
  }, [onClose]);

  const route = report?.detail.route ?? null;
  const riderName = route ? (report?.riders.find((r) => r.id === route.rider_id)?.full_name ?? "Motorizado") : "Ruta";
  const title = route ? `${riderName} · ${routeDayLong(route.route_date)}` : "Reparto y liquidación";

  return (
    <div className="fixed inset-0 z-30 flex justify-end bg-slate-900/40 backdrop-blur-[1px]" onClick={onClose}>
      <aside
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={`Reparto y liquidación de ${riderName}`}
        className="flex h-full w-full max-w-[960px] flex-col overflow-y-auto bg-white shadow-2xl"
      >
        <div className="sticky top-0 z-10 border-b border-slate-200 bg-white/95 backdrop-blur">
          <div className="flex items-start justify-between gap-3 px-4 py-3 sm:px-5">
            <div className="min-w-0">
              <p className="truncate text-base font-semibold text-slate-900">{title}</p>
              {route && <p className="mt-0.5 text-sm text-slate-500">Reparto y liquidación</p>}
            </div>
            <button type="button" onClick={onClose} aria-label="Cerrar" className="min-h-0 shrink-0 rounded-lg border-0 bg-transparent p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-700">
              <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" /></svg>
            </button>
          </div>
        </div>

        <div className={cn("flex-1 p-4 sm:p-5", !report && !error && "animate-pulse")}>
          {error && <p role="alert" className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p>}
          {!report && !error && (
            <div className="space-y-3">
              <div className="h-24 rounded-2xl bg-slate-100" />
              <div className="h-48 rounded-2xl bg-slate-100" />
            </div>
          )}
          {report && (
            <RoutesBoard
              detailOnly
              stores={report.stores}
              riders={report.riders}
              routes={[report.detail.route]}
              detail={report.detail}
              assignable={report.assignable}
              retries={report.retries}
              day={report.day}
              canReport={report.canReport}
              onChanged={() => { load(); onChanged(); }}
            />
          )}
        </div>
      </aside>
    </div>
  );
}
