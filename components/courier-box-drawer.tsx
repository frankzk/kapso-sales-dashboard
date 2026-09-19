"use client";

// La caja del motorizado, abierta al lado de la lista de Rutas (MOM §29.14).
//
// Mira la URL como la ficha del pedido (order-drawer-host.tsx): `?caja=` abre
// una carga con sus tres pasos; `?ruta=` abre una ruta sin caja (las que
// trajo el cuaderno) y lleva a su reparto. Cerrar reemplaza la URL sin apilar
// historial y conserva los filtros de la lista. Tras cada acción se recarga
// el detalle y se refresca la pantalla de atrás, para que la fila cambie.

import Link from "next/link";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { cn } from "@/components/ui";
import { DispatchBoxPanel } from "@/components/dispatch-workspace";
import { loadCourierBox, type CourierBoxDetail } from "@/app/dashboard/courier/actions";
import { loadDispatchWorkspace } from "@/app/dashboard/pedidos/despacho/actions";
import { closeCourierBoxHref, readCourierBoxRequest, type CourierBoxRequest } from "@/lib/courier-box-href";
import { routeDayLong } from "@/lib/dispatch";
import { LEDGER_SITUATION_LABELS, ledgerSituation } from "@/lib/courier-route-ledger";

export function CourierBoxDrawer() {
  return (
    <Suspense fallback={null}>
      <CourierBoxDrawerInner />
    </Suspense>
  );
}

function CourierBoxDrawerInner() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const router = useRouter();
  const search = searchParams.toString();
  const request = readCourierBoxRequest({ pathname, search });

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
  const key = request.kind === "caja" ? `caja:${request.manifestId}` : `ruta:${request.routeId}`;
  return <CourierBoxPanel key={key} request={request} onClose={close} onChanged={() => setRefreshTick((n) => n + 1)} />;
}

function CourierBoxPanel({ request, onClose, onChanged }: { request: CourierBoxRequest; onClose: () => void; onChanged: () => void }) {
  const [detail, setDetail] = useState<CourierBoxDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const args = request.kind === "caja" ? { manifestId: request.manifestId } : { routeId: request.routeId };
    loadCourierBox(args).then((res) => {
      if (!alive) return;
      if ("error" in res) setError(res.error);
      else setDetail(res);
    }).catch(() => { if (alive) setError("No se pudo cargar la caja. Revisa la conexión."); });
    return () => { alive = false; };
  }, [request]);

  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
  }, [onClose]);

  const storeName = useMemo(() => new Map((detail?.stores ?? []).map((s) => [s.id, s.name])), [detail?.stores]);
  const manifest = detail?.manifestId ? detail.data.manifests.find((m) => m.id === detail.manifestId) ?? null : null;
  const route = detail?.route ?? null;
  const situation = route
    ? LEDGER_SITUATION_LABELS[ledgerSituation({ routeStatus: route.status, manifestState: manifest?.state ?? null, settlementStatus: route.settlementStatus })]
    : null;
  const title = route?.riderName ?? manifest?.driver_name ?? "Caja";
  const day = route?.routeDate ?? manifest?.route_date ?? null;

  async function refresh(preferId?: string | null) {
    if (!detail) return;
    const fresh = await loadDispatchWorkspace(preferId ?? detail.manifestId);
    setDetail({ ...detail, data: fresh });
    onChanged();
  }

  return (
    <div className="fixed inset-0 z-30 flex justify-end bg-slate-900/40 backdrop-blur-[1px]" onClick={onClose}>
      <aside
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={`Caja de ${title}`}
        className="flex h-full w-full max-w-[760px] flex-col overflow-y-auto bg-white shadow-2xl"
      >
        <div className="sticky top-0 z-10 border-b border-slate-200 bg-white/95 backdrop-blur">
          <div className="flex items-start justify-between gap-3 px-4 py-3 sm:px-5">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-base font-semibold text-slate-900">{title}</p>
                {situation && <span className="rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-semibold text-slate-700">{situation}</span>}
              </div>
              <p className="mt-0.5 text-sm text-slate-500">
                {day ? routeDayLong(day) : ""}
                {manifest ? ` · Carga ${manifest.load_number ?? 1}` : route ? " · Sin caja de despacho" : ""}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              {route && (
                <Link href={`/dashboard/courier/reparto?id=${route.id}&dia=${route.routeDate}`} className="inline-flex min-h-9 items-center gap-1 rounded-lg px-2 text-sm font-medium text-brand-700 hover:bg-brand-50">
                  Reparto y liquidación
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
                </Link>
              )}
              <button type="button" onClick={onClose} aria-label="Cerrar" className="min-h-0 rounded-lg border-0 bg-transparent p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-700">
                <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" /></svg>
              </button>
            </div>
          </div>
        </div>

        <div className={cn("flex-1 space-y-4 p-4 sm:p-5", !detail && !error && "animate-pulse")}>
          {error && <p role="alert" className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p>}
          {!detail && !error && <div className="h-40 rounded-2xl bg-slate-100" />}
          {detail && manifest && (
            <DispatchBoxPanel
              data={detail.data}
              manifestId={manifest.id}
              manifests={[manifest]}
              canManage={detail.canManage}
              canPickup={detail.canPickup}
              surface="gf"
              storeName={storeName}
              refresh={refresh}
              showTarget={false}
            />
          )}
          {detail && !manifest && route && (
            <div className="rounded-2xl border border-dashed border-slate-300 p-5 text-sm text-slate-600">
              <p className="font-medium text-slate-800">Esta ruta no pasó por Despacho del día.</p>
              <p className="mt-1">Sus paradas vienen del cuaderno del motorizado (Liquidaciones 2). Los tres pasos de la caja no aplican; el reparto y su cierre sí.</p>
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}
