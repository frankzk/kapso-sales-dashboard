"use client";

// La caja del motorizado, abierta al lado de la lista de Rutas (MOM §29.14).
//
// Mira la URL como la ficha del pedido (order-drawer-host.tsx): `?caja=` abre
// una carga con sus tres pasos; `?ruta=` abre una ruta sin caja (las que
// trajo el cuaderno). El reparto y la liquidación de la ruta tienen su propio
// panel (courier-route-report-drawer.tsx), abierto desde la columna
// «Liquidación» de la lista. Cerrar reemplaza la URL sin apilar
// historial y conserva los filtros de la lista. Tras cada acción se recarga
// el detalle y se refresca la pantalla de atrás, para que la fila cambie.

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Badge, Banner, SidePanel, Skeleton } from "@/components/ops-ui";
import { SITUATION_TONE } from "@/components/courier-routes-ledger";
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

  async function refresh(preferId?: string | null) {
    if (!detail) return;
    const fresh = await loadDispatchWorkspace(preferId ?? detail.manifestId);
    setDetail({ ...detail, data: fresh });
    onChanged();
  }

  return <CourierBoxView detail={detail} error={error} onClose={onClose} refresh={refresh} />;
}

/**
 * Lo que el panel de la caja enseña, sin cargar nada: cabecera con la
 * situación de la ruta y los tres pasos. Separado de la carga para poder
 * mirarlo con datos de ejemplo.
 */
export function CourierBoxView({ detail, error, onClose, refresh }: {
  detail: CourierBoxDetail | null;
  error: string | null;
  onClose: () => void;
  refresh: (preferId?: string | null) => Promise<void>;
}) {
  const storeName = useMemo(() => new Map((detail?.stores ?? []).map((s) => [s.id, s.name])), [detail?.stores]);
  const manifest = detail?.manifestId ? detail.data.manifests.find((m) => m.id === detail.manifestId) ?? null : null;
  const route = detail?.route ?? null;
  const situation = route
    ? ledgerSituation({ routeStatus: route.status, manifestState: manifest?.state ?? null, settlementStatus: route.settlementStatus })
    : null;
  const title = route?.riderName ?? manifest?.driver_name ?? "Caja";
  const day = route?.routeDate ?? manifest?.route_date ?? null;

  return (
    <SidePanel
      label={`Caja de ${title}`}
      title={title}
      badge={situation && <Badge tone={SITUATION_TONE[situation]}>{LEDGER_SITUATION_LABELS[situation]}</Badge>}
      meta={<>
        {day ? routeDayLong(day) : ""}
        {manifest ? ` · Carga ${manifest.load_number ?? 1}` : route ? " · Sin caja de despacho" : ""}
      </>}
      width="max-w-[760px]"
      onClose={onClose}
    >
      <div className="space-y-4">
        {error && <Banner tone="crit" role="alert">{error}</Banner>}
        {!detail && !error && <><Skeleton className="h-11" /><Skeleton className="h-64" /></>}
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
          <Banner tone="info" title="Esta ruta no pasó por Despacho del día.">
            Sus paradas vienen del cuaderno del motorizado (Liquidaciones 2). Los tres pasos de la caja no aplican; el reparto y su cierre se abren desde «Liquidación» en la lista.
          </Banner>
        )}
      </div>
    </SidePanel>
  );
}
