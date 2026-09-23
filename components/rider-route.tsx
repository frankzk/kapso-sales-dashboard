"use client";

// La pantalla del motorizado. Pensada para un teléfono, con una mano, en la
// calle y con mala señal:
//
//   - una parada a la vez, no una tabla;
//   - botones grandes y pocos;
//   - la dirección y el mapa antes que nada, que es lo que necesita primero;
//   - el formulario valida ANTES de subir nada, para no gastarle datos;
//   - la foto se sube aparte del reporte, así una caída de red no le borra lo
//     que ya escribió.

import { Suspense, useCallback, useEffect, useMemo, useState, useTransition } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  NON_DELIVERY_REASONS,
  PAYMENT_METHODS,
  routeTotals,
  validateStopReport,
  type PaymentMethod,
  type StopStatus,
} from "@/lib/routes";
import type { RouteRow, StopWithOrder } from "@/lib/routes-access";
import { addManualStop, addSheetOnlyPoint, reportStop, searchOrdersForRider } from "@/app/reparto/actions";
import { ScanAction } from "@/components/scan-action";
import { confirmMyGfPickup, declineMyGfPackage } from "@/app/reparto/receive";
import { DECLINE_REASONS } from "@/lib/rider-decline-reasons";
import { riderStopDecision, type RiderPickupMode } from "@/lib/grupo-gf-courier";
import type { RiderOrderCandidate, RiderVocabulary } from "@/lib/sheets/rider-access";
import { resolveWrittenForStop } from "@/lib/sheets/stop-bridge";
import { montoDiffers } from "@/lib/sheets/rider-cuaderno";
import { REPARTO_PAYMENT_METHODS } from "@/lib/sheets/templates";

const money = (n: number | null | undefined) =>
  n === null || n === undefined ? "—" : `S/ ${n.toFixed(2)}`;

function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

/** Enlace al mapa: por coordenadas si las hay, si no por la dirección escrita. */
function mapHref(stop: StopWithOrder): string {
  const o = stop.order;
  if (o?.latitude != null && o?.longitude != null) {
    return `https://www.google.com/maps/search/?api=1&query=${o.latitude},${o.longitude}`;
  }
  const parts = [o?.address, o?.district, o?.province, "Perú"].filter(Boolean).join(", ");
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(parts)}`;
}

//   - el detalle de una parada se abre en un panel al lado (`?parada=`), no
//     debajo de la tarjeta: en el teléfono cubre la lista y «atrás» lo cierra;
//     en pantalla ancha, lista y detalle van en dos columnas.

type RiderRouteScreenProps = {
  riderName: string;
  routes: RouteRow[];
  route: RouteRow | null;
  stops: StopWithOrder[];
  coordinator?: string;
  routeLabels?: Record<string, string>;
  /** Vocabulario de su hoja de Reparto propio (MOM §30.9); ausente si no tiene hoja. */
  vocabulary?: RiderVocabulary | null;
  /** Hoy en Lima, para los puntos añadidos a mano. */
  today?: string;
  /** Modo de recojo (0177): en «confirmar» cada parada nace «por confirmar». */
  pickupMode?: RiderPickupMode;
};

export function RiderRouteScreen(props: RiderRouteScreenProps) {
  // `useSearchParams` pide un límite de Suspense por si la ruta se prerrenderiza.
  return (
    <Suspense fallback={null}>
      <RiderRouteScreenInner {...props} />
    </Suspense>
  );
}

/** Parámetro de la parada abierta en la URL, como `?ficha=` en el panel. */
const STOP_PARAM = "parada";

function RiderRouteScreenInner({
  riderName,
  routes,
  route,
  stops,
  coordinator,
  routeLabels,
  vocabulary,
  today,
  pickupMode,
}: RiderRouteScreenProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  // La parada abierta vive en la URL: «atrás» del navegador cierra el panel y
  // un refresco vuelve al mismo sitio. Un id que ya no está en la ruta se
  // ignora, así un enlace viejo no deja un panel vacío.
  const wantedId = searchParams.get(STOP_PARAM);
  const openStop = useMemo(() => (wantedId ? stops.find((s) => s.id === wantedId) ?? null : null), [stops, wantedId]);
  const openId = openStop?.id ?? null;
  const hrefWithStop = useCallback(
    (stopId: string | null) => {
      const next = new URLSearchParams(searchParams.toString());
      if (stopId) next.set(STOP_PARAM, stopId);
      else next.delete(STOP_PARAM);
      const query = next.toString();
      return query ? `${pathname}?${query}` : pathname;
    },
    [pathname, searchParams],
  );
  // Abrir apila historial (así «atrás» cierra); cerrar reemplaza, sin
  // volver a pedir la página. Next sincroniza `useSearchParams` con ambos.
  const openStopPanel = useCallback((stopId: string) => {
    if (stopId === openId) return;
    window.history.pushState(null, "", hrefWithStop(stopId));
  }, [hrefWithStop, openId]);
  const closeStopPanel = useCallback(() => {
    window.history.replaceState(null, "", hrefWithStop(null));
  }, [hrefWithStop]);
  // Con el panel abierto en el teléfono, la página de atrás no hace scroll:
  // el scroll es del panel. En pantalla ancha las dos columnas conviven.
  useEffect(() => {
    if (!openId) return;
    const narrow = window.matchMedia("(max-width: 1023px)");
    if (!narrow.matches) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [openId]);
  // `router.refresh()` en el mismo tick que el replaceState pisaba la URL
  // nueva con la vieja; diferido no compite.
  const [refreshTick, setRefreshTick] = useState(0);
  useEffect(() => {
    if (refreshTick) router.refresh();
  }, [refreshTick, router]);
  const finishStop = useCallback(() => {
    closeStopPanel();
    setRefreshTick((n) => n + 1);
  }, [closeStopPanel]);
  const [confirmAll, setConfirmAll] = useState(false);
  const [headerMessage, setHeaderMessage] = useState<{ ok: boolean; text: string } | null>(null);
  // Avance del escaneo en serie: lo confirmado según el servidor más lo que se
  // confirmó en esta tanda y aún no volvió con el refresh (el motorizado no
  // espera a la red para ver que la barra avanza).
  const [scanSession, setScanSession] = useState({ base: 0, scanned: 0 });
  const totals = useMemo(() => routeTotals(stops), [stops]);
  const closed = route?.status === "cerrada";
  const mode: RiderPickupMode = pickupMode ?? "exigir";
  const unconfirmed = useMemo(
    () => stops.filter((s) => riderStopDecision(mode, { status: s.status, pickupCheckedAt: s.pickup_checked_at, hasManifestItem: Boolean(s.manifest_item_id), routeClosed: closed }).canConfirm).length,
    [stops, mode, closed],
  );
  const confirmable = useMemo(() => stops.filter((s) => Boolean(s.manifest_item_id)).length, [stops]);
  const confirmProgress = useMemo(
    () => ({ done: Math.min(confirmable, Math.max(confirmable - unconfirmed, scanSession.base + scanSession.scanned)), total: confirmable }),
    [confirmable, unconfirmed, scanSession],
  );

  if (!route) {
    return (
      <main className="rider-scale mx-auto flex min-h-screen max-w-md flex-col justify-center gap-4 p-6">
        <div className="rounded-2xl border border-slate-200 bg-white p-6 text-center">
          <h1 className="text-lg font-semibold text-slate-900">Hola, {riderName}</h1>
          <p className="mt-2 text-sm text-slate-500">
            Todavía no tienes ninguna ruta asignada. Cuando el coordinador te la entregue, aparecerá
            aquí. Si ya saliste con paquetes, añádelos abajo.
          </p>
        </div>
        {!coordinator && vocabulary && today && <AddPointPanel fecha={today} onDone={() => router.refresh()} />}
      </main>
    );
  }

  return (
    <main className="rider-scale mx-auto min-h-screen max-w-md bg-slate-50 lg:grid lg:max-w-3xl lg:grid-cols-[28rem_minmax(0,1fr)] lg:items-start">
      <div className="min-w-0 pb-24 lg:min-h-screen lg:border-r lg:border-slate-200">
      <header className="sticky top-0 z-10 border-b border-slate-200 bg-white px-4 py-3">
        <div className="flex items-baseline justify-between">
          <h1 className="text-base font-semibold text-slate-900">{riderName}</h1>
          {routes.length > 1 ? (
            <select
              value={route.id}
              onChange={(e) => router.push(`/reparto?ruta=${e.target.value}${coordinator ? "&modo=coordinacion" : ""}`)}
              aria-label="Ruta a reportar"
              className="rounded-lg border border-slate-300 px-2 py-1 text-xs text-slate-600"
            >
              {routes.map((r) => (
                <option key={r.id} value={r.id}>
                  {routeLabels?.[r.id] ?? r.route_date}
                  {r.status === "cerrada" ? " (cerrada)" : ""}
                </option>
              ))}
            </select>
          ) : (
            <span className="text-xs text-slate-500">{route.route_date}</span>
          )}
        </div>
        {coordinator && <p className="mt-2 text-sm text-slate-600">Reportas como <strong>{coordinator}</strong> por el motorizado. Tu usuario quedará registrado. <a className="underline" href="/dashboard/courier/reparto">Volver a Rutas</a></p>}
        <div className="mt-2 flex flex-wrap gap-3 text-xs">
          <Pill label="Por entregar" value={totals.pendientes} tone="pend" />
          <Pill label="Entregados" value={totals.entregados} tone="ok" />
          <Pill label="No entregados" value={totals.noEntregados} tone="bad" />
          {mode === "confirmar" && unconfirmed > 0 && <Pill label="por confirmar" value={unconfirmed} tone="warn" />}
        </div>
        {mode === "confirmar" && unconfirmed > 0 && !coordinator && (
          <div className="mt-2">
            <button
              type="button"
              onClick={() => { setScanSession({ base: confirmable - unconfirmed, scanned: 0 }); setConfirmAll((v) => !v); }}
              aria-expanded={confirmAll}
              className="min-h-10 w-full rounded-lg border border-brand-300 bg-brand-50 px-3 text-sm font-semibold text-brand-800"
            >
              {confirmAll ? "Cerrar el escáner" : `Confirmar todos · escanea ${unconfirmed} ${unconfirmed === 1 ? "paquete" : "paquetes"}`}
            </button>
            {confirmAll && (
              <ScanAction
                context="motorizado_recepcion"
                compact
                continuous
                progress={confirmProgress}
                label="Escanear «Lo llevo»"
                onResult={(r) => {
                  setHeaderMessage(r.error ? { ok: false, text: r.error } : { ok: true, text: r.notice ?? "Lo llevas." });
                  if (!r.error) {
                    setScanSession((c) => ({ ...c, scanned: c.scanned + 1 }));
                    router.refresh();
                  }
                }}
              />
            )}
            {headerMessage && <p role="status" className={cn("mt-2 rounded-lg px-3 py-2 text-sm", headerMessage.ok ? "bg-emerald-50 text-emerald-800" : "bg-red-50 text-red-700")}>{headerMessage.text}</p>}
          </div>
        )}
        {totals.efectivo > 0 && (
          <p className="mt-2 text-xs text-slate-500">
            {coordinator ? "Efectivo reportado por la ruta:" : "Efectivo en tu mano:"}{" "}
            <strong className="text-slate-800">{money(totals.efectivo)}</strong>
            {totals.yape > 0 && <> · Yape {money(totals.yape)}</>}
            {totals.pos > 0 && <> · POS {money(totals.pos)}</>}
          </p>
        )}
        {closed && (
          <p className="mt-2 rounded-lg bg-slate-100 px-2 py-1 text-xs text-slate-600">
            Esta ruta ya está cerrada. Si algo quedó mal, avisa al coordinador.
          </p>
        )}
      </header>

      <ul className="space-y-2 p-3">
        {stops.map((stop) => (
          <li key={stop.id}>
            <StopCard
              stop={stop}
              selected={openId === stop.id}
              readOnly={closed}
              delegated={Boolean(coordinator)}
              pickupMode={mode}
              onOpen={() => openStopPanel(stop.id)}
              onDone={() => setRefreshTick((n) => n + 1)}
            />
          </li>
        ))}
        {stops.length === 0 && (
          <li className="rounded-xl border border-slate-200 bg-white p-6 text-center text-sm text-slate-500">
            Esta ruta no tiene paradas.
          </li>
        )}
      </ul>

      {!closed && !coordinator && vocabulary && (
        <div className="px-3 pb-3">
          <AddPointPanel fecha={route.route_date} onDone={() => router.refresh()} />
        </div>
      )}

      {totals.completa && !closed && !coordinator && (
        <div className="fixed inset-x-0 bottom-0 mx-auto max-w-md border-t border-emerald-200 bg-emerald-50 px-4 py-3 text-center text-sm text-emerald-800 lg:max-w-3xl">
          Terminaste tus {totals.total} paradas. Ya puedes entregar{" "}
          <strong>{money(totals.efectivo)}</strong> en efectivo.
        </div>
      )}
      </div>

      {openStop ? (
        <StopPanel
          key={openStop.id}
          stop={openStop}
          readOnly={closed}
          delegated={Boolean(coordinator)}
          vocabulary={vocabulary ?? null}
          pickupMode={mode}
          onClose={closeStopPanel}
          onDone={finishStop}
        />
      ) : (
        <aside aria-hidden="true" className="hidden lg:sticky lg:top-0 lg:flex lg:h-screen lg:items-center lg:justify-center lg:p-6">
          <p className="text-sm text-slate-400">Toca una parada para ver su detalle.</p>
        </aside>
      )}
    </main>
  );
}

/**
 * El detalle de la parada, al lado de la lista. En el teléfono cubre el
 * contenedor de la lista (mismo ancho, alto de pantalla) y se cierra con «←»
 * o con «atrás»; en pantalla ancha es la columna derecha. El scroll es suyo.
 */
function StopPanel({
  stop,
  readOnly,
  delegated,
  vocabulary,
  pickupMode,
  onClose,
  onDone,
}: {
  stop: StopWithOrder;
  readOnly: boolean;
  delegated: boolean;
  vocabulary: RiderVocabulary | null;
  pickupMode: RiderPickupMode;
  onClose: () => void;
  onDone: () => void;
}) {
  const o = stop.order;
  const done = stop.status !== "pendiente";
  const decision = riderStopDecision(pickupMode, {
    status: stop.status,
    pickupCheckedAt: stop.pickup_checked_at,
    hasManifestItem: Boolean(stop.manifest_item_id),
    routeClosed: readOnly,
  });
  return (
    <section
      aria-label={`Parada de ${o?.customer_name ?? "sin nombre"}`}
      className="fixed inset-y-0 left-1/2 z-20 w-full max-w-md -translate-x-1/2 overflow-hidden lg:sticky lg:inset-y-auto lg:left-auto lg:top-0 lg:h-screen lg:max-w-none lg:translate-x-0"
    >
      {/* Capa interior: es la que se desliza desde la derecha en el teléfono
          (la exterior ya usa translate para centrarse). En lg entra sin animar. */}
      <div className="flex h-full flex-col bg-white shadow-xl animate-slide-in-right lg:animate-none lg:shadow-none">
      <header className="flex items-start gap-2 border-b border-slate-200 px-3 py-3">
        <button
          type="button"
          onClick={onClose}
          aria-label="Volver a la lista"
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-xl text-slate-600 hover:bg-slate-100 focus-visible:outline-none focus-visible:border-brand-500 focus-visible:ring-4 focus-visible:ring-brand-500/15"
        >
          ←
        </button>
        <div className="min-w-0 flex-1 pt-1">
          <p className="truncate text-base font-semibold text-slate-900">{o?.customer_name ?? "Sin nombre"}</p>
          <p className="truncate text-xs text-slate-500">
            {o?.district ?? "—"} · {o?.name ?? "—"}
          </p>
        </div>
        <div className="shrink-0 pt-1 text-right">
          <p className="text-sm font-semibold text-slate-800">{money(o?.total)}</p>
          <StopStatusLine stop={stop} badge={decision.badge} />
        </div>
      </header>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3 pb-8">
        {!delegated && (decision.canConfirm || decision.canDecline) && (
          <div className="-mx-4 lg:hidden">
            <PickupConfirmBar stop={stop} onDone={onDone} />
          </div>
        )}
        <div className="text-sm text-slate-700">
          <p>{o?.address ?? "Sin dirección"}</p>
          {o?.reference && <p className="text-xs text-slate-500">Ref: {o.reference}</p>}
        </div>
        <div className="flex gap-2">
          <a
            href={mapHref(stop)}
            target="_blank"
            rel="noreferrer"
            className="flex-1 rounded-lg bg-slate-800 px-3 py-2.5 text-center text-sm font-medium text-white"
          >
            Abrir mapa
          </a>
          {o?.customer_phone && (
            <a
              href={`tel:${o.customer_phone}`}
              className="flex-1 rounded-lg border border-slate-300 px-3 py-2.5 text-center text-sm font-medium text-slate-700"
            >
              Llamar
            </a>
          )}
        </div>

        {readOnly ? (
          <p className="text-xs text-slate-500">
            {done ? "Ya reportada." : "Sin reportar."} La ruta está cerrada.
          </p>
        ) : (
          <ReportForm stop={stop} onDone={onDone} delegated={delegated} vocabulary={vocabulary} />
        )}
      </div>
      </div>
    </section>
  );
}

/** Lo que el motorizado ya reportó, en una línea: estado escrito o el de Kapta, y el recojo. */
function StopStatusLine({ stop, badge }: { stop: StopWithOrder; badge: ReturnType<typeof riderStopDecision>["badge"] }) {
  return (
    <>
      {/* El estado como chapa de color lleno: se distingue de un vistazo. */}
      <p
        className={cn(
          "mt-0.5 inline-block rounded-full px-2 py-0.5 text-[11px] font-semibold",
          stop.status === "entregado" && "bg-emerald-600 text-white",
          stop.status === "no_entregado" && "bg-red-600 text-white",
          stop.status === "pendiente" && "bg-slate-200 text-slate-700",
        )}
      >
        {stop.written_status
          ? stop.written_status
          : stop.status === "entregado"
            ? "Entregado"
            : stop.status === "no_entregado"
              ? "No entregado"
              : "Por entregar"}
      </p>
      {badge && (
        <p className={cn("text-[11px] font-medium", badge === "lo_llevo" ? "text-emerald-700" : "text-amber-700")}>
          {badge === "lo_llevo" ? "✓ Lo llevo" : "Por confirmar"}
        </p>
      )}
      {stop.status === "entregado" && stop.pickup_confirmed === false && (
        <p className="text-[11px] text-amber-700">sin confirmar recojo</p>
      )}
    </>
  );
}

function Pill({ label, value, tone }: { label: string; value: number; tone: "pend" | "ok" | "bad" | "warn" }) {
  return (
    <span
      className={cn(
        "rounded-full px-2 py-0.5 text-xs font-medium",
        tone === "ok" && "bg-emerald-600 text-white",
        tone === "bad" && "bg-red-600 text-white",
        tone === "pend" && "bg-slate-200 text-slate-800",
        tone === "warn" && "bg-amber-500 text-white",
      )}
    >
      {value} {label}
    </span>
  );
}

function StopCard({
  stop,
  selected,
  readOnly,
  delegated = false,
  pickupMode = "exigir",
  onOpen,
  onDone,
}: {
  stop: StopWithOrder;
  selected: boolean;
  readOnly: boolean;
  delegated?: boolean;
  pickupMode?: RiderPickupMode;
  onOpen: () => void;
  onDone: () => void;
}) {
  const o = stop.order;
  // «Lo llevo» / «No lo llevo» (0177): solo en modo confirmar, sobre paradas
  // pendientes que salieron de una caja y que el motorizado aún no confirmó.
  const decision = riderStopDecision(pickupMode, {
    status: stop.status,
    pickupCheckedAt: stop.pickup_checked_at,
    hasManifestItem: Boolean(stop.manifest_item_id),
    routeClosed: readOnly,
  });

  return (
    <div
      className={cn(
        // Fondo y franja izquierda por estado: el cambio se ve sin leer.
        "overflow-hidden rounded-xl border border-l-[6px]",
        stop.status === "entregado" && "border-emerald-300 border-l-emerald-600 bg-emerald-100",
        stop.status === "no_entregado" && "border-red-300 border-l-red-600 bg-red-100",
        stop.status === "pendiente" && "border-slate-200 border-l-slate-300 bg-white",
        selected && "ring-4 ring-brand-500/15 border-brand-500",
      )}
    >
      <button type="button" onClick={onOpen} aria-current={selected ? "true" : undefined} className="w-full bg-transparent px-4 py-3 text-left focus-visible:outline-none focus-visible:bg-black/5">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-slate-900">
              {o?.customer_name ?? "Sin nombre"}
            </p>
            <p className="truncate text-xs text-slate-500">
              {o?.district ?? "—"} · {o?.name ?? "—"}
            </p>
          </div>
          <div className="shrink-0 text-right">
            <p className="text-sm font-semibold text-slate-800">{money(o?.total)}</p>
            <StopStatusLine stop={stop} badge={decision.badge} />
          </div>
        </div>
      </button>
      {!delegated && (decision.canConfirm || decision.canDecline) && (
        <PickupConfirmBar stop={stop} onDone={onDone} />
      )}
    </div>
  );
}

/**
 * «Lo llevo» abre el gesto único (`motorizado_recepcion`, sin caja: confirma
 * el ítem de esta parada); «No lo llevo» pide un motivo corto y devuelve el
 * paquete a «por asignar». Una parada sin confirmar se entrega igual.
 */
function PickupConfirmBar({ stop, onDone }: { stop: StopWithOrder; onDone: () => void }) {
  const [pending, start] = useTransition();
  const [panel, setPanel] = useState<"none" | "confirm" | "decline">("none");
  const [reason, setReason] = useState<string>(DECLINE_REASONS[0].code);
  const [note, setNote] = useState("");
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const say = (r: { error?: string; notice?: string }) => {
    setMessage(r.error ? { ok: false, text: r.error } : { ok: true, text: r.notice ?? "Anotado." });
    if (!r.error) onDone();
  };
  return (
    <div className="border-t border-amber-100 bg-amber-50/50 px-4 py-2">
      <div className="flex gap-2">
        <button
          type="button"
          disabled={pending}
          onClick={() => setPanel(panel === "confirm" ? "none" : "confirm")}
          aria-expanded={panel === "confirm"}
          className="min-h-11 flex-1 rounded-lg bg-brand-600 px-3 text-sm font-semibold text-white disabled:opacity-50"
        >
          Lo llevo
        </button>
        <button
          type="button"
          disabled={pending}
          onClick={() => setPanel(panel === "decline" ? "none" : "decline")}
          aria-expanded={panel === "decline"}
          className="min-h-11 rounded-lg border border-amber-300 px-3 text-sm font-medium text-amber-800 disabled:opacity-50"
        >
          No lo llevo
        </button>
      </div>
      {panel === "confirm" && (
        <div className="mt-2 space-y-2">
          <ScanAction context="motorizado_recepcion" itemId={stop.manifest_item_id} compact label="Escanear el paquete" disabled={pending} onResult={say} />
          <button
            type="button"
            disabled={pending}
            onClick={() => start(async () => say(await confirmMyGfPickup({ itemId: stop.manifest_item_id })))}
            className="min-h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-xs font-medium text-slate-700 disabled:opacity-50"
          >
            Sin escanear: confirmo que lo llevo
          </button>
        </div>
      )}
      {panel === "decline" && (
        <div className="mt-2 space-y-2 rounded-lg bg-amber-50 p-2">
          <select value={reason} onChange={(e) => setReason(e.target.value)} aria-label="Por qué no lo llevas" className="min-h-11 w-full rounded-lg border border-amber-300 px-2 text-sm">
            {DECLINE_REASONS.map((r) => <option key={r.code} value={r.code}>{r.label}</option>)}
          </select>
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder={reason === "otro" ? "Di en una línea qué pasó" : "Detalle (opcional)"} aria-label="Detalle" className="min-h-11 w-full rounded-lg border border-amber-300 px-2 text-sm" />
          <button
            type="button"
            disabled={pending || !stop.dispatch_manifest_id || !stop.shipment_id}
            onClick={() => start(async () => say(await declineMyGfPackage(stop.dispatch_manifest_id ?? "", stop.shipment_id ?? "", reason, note)))}
            className="min-h-11 w-full rounded-lg bg-amber-600 px-3 text-sm font-semibold text-white disabled:opacity-50"
          >
            Confirmar que no lo llevo
          </button>
        </div>
      )}
      {message && <p role="status" className={cn("mt-2 rounded-lg px-3 py-2 text-sm", message.ok ? "bg-emerald-50 text-emerald-800" : "bg-red-50 text-red-700")}>{message.text}</p>}
    </div>
  );
}

export function ReportForm({ stop, onDone, delegated = false, vocabulary = null }: { stop: StopWithOrder; onDone: () => void; delegated?: boolean; vocabulary?: RiderVocabulary | null }) {
  const [pending, start] = useTransition();
  // Lo que escribe el motorizado, tal cual (MOM §30.7): se guarda literal y se
  // resuelve con el vocabulario de su hoja; si resuelve, mueve los botones.
  const [written, setWritten] = useState(stop.written_status ?? "");
  const [writtenPayment, setWrittenPayment] = useState(stop.written_payment ?? "");
  const [reasonCode, setReasonCode] = useState("");
  const [reasonNote, setReasonNote] = useState("");
  const resolved = useMemo(() => (vocabulary ? resolveWrittenForStop(written, vocabulary) : null), [written, vocabulary]);
  const [status, setStatus] = useState<StopStatus>(
    stop.status === "pendiente" ? "entregado" : stop.status,
  );
  const [method, setMethod] = useState<PaymentMethod | null>(
    (stop.payment_method as PaymentMethod | null) ?? null,
  );
  const [amount, setAmount] = useState(
    stop.collected_amount != null ? String(stop.collected_amount) : String(stop.collection?.remaining ?? ""),
  );
  const [reason, setReason] = useState(stop.outcome_reason ?? "");
  const [note, setNote] = useState(stop.note ?? "");
  const [photoPath, setPhotoPath] = useState<string | null>(stop.photo_path);
  const [voucherPath, setVoucherPath] = useState<string | null>(stop.voucher_path);
  const [err, setErr] = useState<string | null>(null);
  const [reportReason, setReportReason] = useState("");

  const numericAmount = amount.trim() ? Number(amount.replace(",", ".")) : null;
  const collectedForReason = status === "entregado" ? (method === "sin_cobro" ? 0 : numericAmount) : null;
  const mustExplain = status === "entregado" && Boolean(vocabulary) && montoDiffers(collectedForReason, stop.order?.total ?? null);

  function applyWritten(text: string) {
    setWritten(text);
    if (!vocabulary) return;
    const res = resolveWrittenForStop(text, vocabulary);
    if (!res.target) return;
    if (res.target.status === "entregado") setStatus("entregado");
    else if (res.target.status === "no_entregado") {
      setStatus("no_entregado");
      setReason(res.target.outcome_reason ?? "");
    }
  }

  function submit() {
    if (delegated && !reportReason.trim()) {
      setErr("Indica por qué reportas por el motorizado.");
      return;
    }
    if (delegated && !photoPath) {
      setErr("Adjunta la evidencia del reporte por el motorizado.");
      return;
    }
    // Se valida con la MISMA función que el servidor, para avisarle antes de
    // gastarle datos en una petición que va a rebotar igual.
    const check = validateStopReport({
      status,
      paymentMethod: status === "entregado" ? method : null,
      collectedAmount: status === "entregado" ? (method === "sin_cobro" ? 0 : numericAmount) : null,
      outcomeReason: status === "no_entregado" ? reason || null : null,
      note,
      hasPhoto: Boolean(photoPath),
      hasVoucher: Boolean(voucherPath),
    });
    if (!check.ok) {
      setErr(check.errors.join(" "));
      return;
    }
    if (mustExplain && !reasonCode) {
      setErr(`Cobraste ${money(collectedForReason)} y el pedido es de ${money(stop.order?.total)}. Elige por qué.`);
      return;
    }
    if (mustExplain && reasonCode === "otro" && reasonNote.trim().length < 3) {
      setErr("Con motivo «Otro», escribe una nota.");
      return;
    }
    start(async () => {
      setErr(null);
      try {
        const res = await reportStop({
          stopId: stop.id,
          status,
          paymentMethod: status === "entregado" ? method : null,
          collectedAmount: status === "entregado" ? (method === "sin_cobro" ? 0 : numericAmount) : null,
          outcomeReason: status === "no_entregado" ? reason || null : null,
          note: note.trim() || null,
          photoPath,
          voucherPath,
          reportReason: delegated ? reportReason : null,
          writtenStatus: written.trim() || null,
          writtenStatusCode: resolved?.code ?? null,
          writtenPayment: writtenPayment.trim() || null,
          reasonCode: mustExplain ? reasonCode : null,
          reasonNote: mustExplain ? reasonNote.trim() || null : null,
        });
        if (!res.ok) setErr(res.error ?? "No se pudo guardar.");
        else onDone();
      } catch {
        setErr("No se pudo confirmar el guardado. Revisa tu conexión y actualiza la ruta antes de reintentar.");
      }
    });
  }

  return (
    <div className="space-y-3">
      {delegated && <label className="block text-sm text-slate-700">Motivo del reporte por el motorizado
        <input required value={reportReason} onChange={(e) => setReportReason(e.target.value)} placeholder="Ej. Roy envió la evidencia y está sin conexión" className="mt-1 min-h-12 w-full rounded-lg border border-slate-300 px-3 text-base" />
      </label>}
      {vocabulary && (
        <label className="block text-sm text-slate-700">
          ¿Qué pasó? Escríbelo como en tu cuaderno
          <input
            list={`estados-${stop.id}`}
            value={written}
            onChange={(e) => applyWritten(e.target.value)}
            placeholder="ENTREGADO, NO RESPONDE, LO DEJA…"
            className="mt-1 min-h-12 w-full rounded-lg border border-slate-300 px-3 text-base uppercase"
            autoCapitalize="characters"
          />
          <datalist id={`estados-${stop.id}`}>
            {vocabulary.suggestions.map((sug) => (
              <option key={sug} value={sug} />
            ))}
          </datalist>
          {written.trim() && (
            <p className={cn("mt-1 text-xs", resolved?.code ? "text-emerald-700" : "text-amber-700")}>
              {resolved?.code ? `Se entiende como «${resolved.label}».` : "Todavía no tiene equivalente: se guarda igual y alguien lo asignará."}
            </p>
          )}
        </label>
      )}
      <div className="grid grid-cols-2 gap-2">
        <button
          onClick={() => setStatus("entregado")}
          className={cn(
            "rounded-lg px-3 py-2.5 text-sm font-medium",
            status === "entregado"
              ? "bg-emerald-600 text-white"
              : "border border-slate-300 text-slate-700",
          )}
        >
          Entregado
        </button>
        <button
          onClick={() => setStatus("no_entregado")}
          className={cn(
            "rounded-lg px-3 py-2.5 text-sm font-medium",
            status === "no_entregado"
              ? "bg-red-600 text-white"
              : "border border-slate-300 text-slate-700",
          )}
        >
          No entregado
        </button>
      </div>

      {status === "entregado" && (
        <>
          <div className="space-y-1 rounded-lg bg-slate-50 p-3 text-sm">
            <p className="font-semibold">Saldo por cobrar: {stop.collection?.remaining == null ? "No disponible, actualiza la ruta" : money(stop.collection.remaining)}</p>
            {!!stop.collection?.validated && <p>Pagos previos validados: {money(stop.collection.validated)}</p>}
            {!!stop.collection?.pending && <p className="text-amber-800">Hay {money(stop.collection.pending)} pendientes de validar. Consulta a coordinación antes de volver a cobrar.</p>}
          </div>
          <p className="text-sm font-medium">¿Cómo se pagó esta entrega? Elige una opción.</p>
          <div className="flex flex-wrap gap-1.5">
            {PAYMENT_METHODS.map((m) => (
              <button
                key={m.code}
                type="button"
                aria-pressed={method === m.code}
                disabled={pending}
                onClick={() => setMethod(m.code)}
                className={cn(
                  "min-h-12 rounded-lg px-3 py-2 text-sm font-medium disabled:opacity-50",
                  method === m.code
                    ? "bg-slate-800 text-white"
                    : "border border-slate-300 text-slate-700",
                )}
              >
                {m.label}
              </button>
            ))}
          </div>
          {method && method !== "sin_cobro" && (
            <label className="block text-sm font-medium">Importe cobrado en esta entrega
            <input
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="¿Cuánto cobraste?"
              className="mt-1 min-h-12 w-full rounded-lg border border-slate-300 px-3 py-2.5 text-base"
            />
            </label>
          )}
          {vocabulary && method && method !== "sin_cobro" && (
            <label className="block text-sm text-slate-700">Detalle del pago (a qué cuenta, como en el cuaderno)
              <input
                list={`pagos-${stop.id}`}
                value={writtenPayment}
                onChange={(e) => setWrittenPayment(e.target.value)}
                placeholder="YAPE GF, PLIN FRANKZ, IZIPAY…"
                className="mt-1 min-h-12 w-full rounded-lg border border-slate-300 px-3 text-base uppercase"
                autoCapitalize="characters"
              />
              <datalist id={`pagos-${stop.id}`}>
                {REPARTO_PAYMENT_METHODS.map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
            </label>
          )}
          {mustExplain && vocabulary && (
            <div className="space-y-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm">
              <p className="font-medium text-amber-900">Cobraste {money(collectedForReason)} y el pedido es de {money(stop.order?.total)}. ¿Por qué?</p>
              <select value={reasonCode} onChange={(e) => setReasonCode(e.target.value)} aria-label="Motivo de la diferencia" className="min-h-12 w-full rounded-lg border border-amber-300 bg-white px-3 text-base">
                <option value="">Elige el motivo</option>
                {vocabulary.reasons.map((r) => (
                  <option key={r.code} value={r.code}>{r.label}</option>
                ))}
              </select>
              <input value={reasonNote} onChange={(e) => setReasonNote(e.target.value)} placeholder="Nota (obligatoria con «Otro»)" aria-label="Nota del motivo" className="min-h-12 w-full rounded-lg border border-amber-300 bg-white px-3 text-base" />
            </div>
          )}
          {method === "sin_cobro" && <p className="text-sm">Se registrará S/ 0.00. Si queda saldo, explica el motivo en la nota.</p>}
          {method === "yape" && <p className="text-sm text-slate-600">Yape reportado a la empresa. La captura no equivale a validación bancaria.</p>}
          <ScanAction
            context="motorizado_entrega"
            stopId={stop.id}
            photoKind="entrega"
            photoPath={photoPath}
            label="Foto de la entrega"
            onResult={(r) => { if (r.error) setErr(r.error); else if (r.path) setPhotoPath(r.path); }}
          />
          {method === "yape" && (
            <ScanAction
              context="motorizado_entrega"
              stopId={stop.id}
              photoKind="yape"
              photoPath={voucherPath}
              label="Captura del Yape"
              onResult={(r) => { if (r.error) setErr(r.error); else if (r.path) setVoucherPath(r.path); }}
            />
          )}
        </>
      )}

      {status === "no_entregado" && (
        <select
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          className="w-full rounded-lg border border-slate-300 px-3 py-2.5 text-base"
        >
          <option value="">¿Por qué no se entregó?</option>
          {NON_DELIVERY_REASONS.map((r) => (
            <option key={r.code} value={r.code}>
              {r.label}
            </option>
          ))}
        </select>
      )}

      {status === "no_entregado" && delegated && <ScanAction
        context="motorizado_entrega"
        stopId={stop.id}
        photoKind="entrega"
        photoPath={photoPath}
        label="Evidencia del reporte"
        onResult={(r) => { if (r.error) setErr(r.error); else if (r.path) setPhotoPath(r.path); }}
      />}
      <textarea
        aria-label="Nota del reporte"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="Nota (opcional)"
        rows={2}
        className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
      />

      {err && <p role="alert" className="text-sm text-red-600">{err}</p>}

      <button
        onClick={submit}
        disabled={pending || (status === "entregado" && (method === null || stop.collection?.remaining == null))}
        className="w-full rounded-lg bg-brand-600 px-4 py-3 text-sm font-semibold text-white disabled:opacity-50"
      >
        {pending ? "Guardando…" : stop.status === "pendiente" ? "Guardar" : "Corregir"}
      </button>
    </div>
  );
}

/**
 * Puntos que no vienen de una carga: un pedido de Kapta se crea como PARADA en
 * la ruta del día (la verdad, MOM §29.12); un punto sin pedido (Kast) vive
 * solo en la hoja porque una parada exige pedido.
 */
function AddPointPanel({ fecha, onDone }: { fecha: string; onDone: () => void }) {
  const [pending, start] = useTransition();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<RiderOrderCandidate[]>([]);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [kastName, setKastName] = useState("");

  async function search() {
    const q = query.trim();
    if (q.length < 3) return;
    const res = await searchOrdersForRider(q);
    setResults(res.results);
    if (!res.ok) setMsg({ ok: false, text: res.error ?? "No se pudo buscar." });
  }
  function add(orderId: string) {
    start(async () => {
      const res = await addManualStop({ orderId, fecha });
      setMsg({ ok: res.ok, text: res.ok ? (res.message ?? "Añadido.") : (res.error ?? "No se pudo añadir.") });
      if (res.ok) {
        setResults([]);
        setQuery("");
        onDone();
      }
    });
  }
  function addKast() {
    start(async () => {
      const res = await addSheetOnlyPoint({ fecha, cliente: kastName, tienda: "Kast" });
      setMsg({ ok: res.ok, text: res.ok ? (res.message ?? "Añadido.") : (res.error ?? "No se pudo añadir.") });
      if (res.ok) setKastName("");
    });
  }
  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="w-full rounded-xl border border-dashed border-slate-300 bg-white px-4 py-3 text-sm font-medium text-slate-700">
        + Añadir un punto que no está en mi ruta
      </button>
    );
  }
  return (
    <section className="space-y-3 rounded-xl border border-slate-200 bg-white p-4" aria-label="Añadir punto">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-slate-900">Añadir punto · {fecha}</h2>
        <button type="button" onClick={() => setOpen(false)} className="text-xs text-slate-500 underline">Cerrar</button>
      </div>
      <div className="flex gap-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void search()}
          placeholder="Nº de pedido o nombre del cliente"
          aria-label="Buscar pedido"
          className="min-h-12 flex-1 rounded-lg border border-slate-300 px-3 text-base"
        />
        <button type="button" onClick={() => void search()} className="min-h-12 rounded-lg bg-slate-800 px-3 text-sm font-medium text-white">Buscar</button>
      </div>
      {results.length > 0 && (
        <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200">
          {results.map((r) => (
            <li key={r.order_id} className="flex items-center justify-between gap-2 px-3 py-2 text-sm">
              <div className="min-w-0">
                <p className="truncate font-medium text-slate-900">{r.order_name} · {r.customer_name ?? "Sin nombre"}</p>
                <p className="truncate text-xs text-slate-500">{r.district ?? "—"} · {money(r.order_total)}</p>
              </div>
              <button type="button" disabled={pending} onClick={() => add(r.order_id)} className="rounded-lg bg-brand-600 px-3 py-2 text-xs font-semibold text-white disabled:opacity-50">Añadir</button>
            </li>
          ))}
        </ul>
      )}
      <details className="text-sm">
        <summary className="cursor-pointer text-slate-600">Punto sin pedido de Kapta (Kast, encargo)</summary>
        <div className="mt-2 flex gap-2">
          <input value={kastName} onChange={(e) => setKastName(e.target.value)} placeholder="Nombre del cliente" aria-label="Cliente del punto sin pedido" className="min-h-12 flex-1 rounded-lg border border-slate-300 px-3 text-base" />
          <button type="button" disabled={pending || !kastName.trim()} onClick={addKast} className="min-h-12 rounded-lg border border-slate-300 px-3 text-sm font-medium text-slate-700 disabled:opacity-50">Añadir</button>
        </div>
        <p className="mt-1 text-xs text-slate-500">Queda solo en tu cuaderno: sin pedido no hay parada que cobrar en Kapta.</p>
      </details>
      {msg && <p role="status" className={cn("text-sm", msg.ok ? "text-emerald-700" : "text-red-600")}>{msg.text}</p>}
    </section>
  );
}
