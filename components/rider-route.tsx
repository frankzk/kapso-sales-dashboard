"use client";

// La pantalla del motorizado. Pensada para un teléfono, con una mano, en la
// calle y con mala señal:
//
//   - una parada a la vez, no una tabla;
//   - lo que cobra y adónde va, antes que nada; ir con Maps, escribir por
//     WhatsApp como la tienda y llamar, a un toque desde la lista o la ficha
//     (30-09-2026, pedido por Frankz: «lo que tendría la app de Rappi»);
//   - botones grandes y pocos, y ningún teclado abierto por defecto;
//   - el formulario valida ANTES de subir nada, para no gastarle datos, y dice
//     qué falta antes de pulsar «Guardar»;
//   - la foto se toma DENTRO de la página y se reduce antes de subirla
//     (PhotoCapture), aparte del reporte: una caída de red no le borra lo que
//     ya marcó, y Android no cierra Chrome por abrir la app de cámara.

import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState, useTransition, type ComponentType, type KeyboardEvent, type SVGProps } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  NON_DELIVERY_REASONS,
  PAYMENT_METHODS,
  nonDeliveryNeedsPhoto,
  routeTotals,
  validateStopReport,
  type PaymentMethod,
  type StopStatus,
} from "@/lib/routes";
import type { RouteRow, StopWithOrder } from "@/lib/routes-access";
import { addManualStop, addSheetOnlyPoint, reportStop, searchOrdersForRider } from "@/app/reparto/actions";
import { PhotoCapture } from "@/components/photo-capture";
import { confirmMyGfPickup, declineMyGfPackage } from "@/app/reparto/receive";
import { DECLINE_REASONS } from "@/lib/rider-decline-reasons";
import { riderStopDecision, type RiderPickupMode } from "@/lib/grupo-gf-courier";
import type { RiderOrderCandidate, RiderVocabulary } from "@/lib/sheets/rider-access";
import { resolveWrittenForStop, sheetPaymentToStop, stopPaymentToSheet } from "@/lib/sheets/stop-bridge";
import { montoDiffers } from "@/lib/sheets/monto";
import { REPARTO_PAYMENT_METHODS } from "@/lib/sheets/payment-methods";
import {
  RIDER_MESSAGE_LABEL,
  addressToCopy,
  firstName,
  navigationHref,
  riderWhatsappMessage,
  soles,
  telHref,
  wazeHref,
  whatsappHref,
  whatsappNumber,
  type RiderMessageKind,
} from "@/lib/rider-contact";
import { Badge, Banner } from "@/components/ops-ui";
import { copyLabel, useCopyToClipboard } from "@/components/copy-button";
import {
  IconArrowLeft,
  IconCheck,
  IconCopy,
  IconMapPin,
  IconNavigate,
  IconPhone,
  IconWhatsApp,
  IconX,
} from "@/components/icons";

// El escáner de QR («Confirmar todos», «Lo llevo») se descarga al tocarlo: la
// mayoría de las visitas no lo usa y arrastra la cámara de QR y su lector.
const ScanAction = lazy(() => import("@/components/scan-action").then((m) => ({ default: m.ScanAction })));

/** Mientras baja el escáner: un bloque quieto del alto del campo. */
const SCAN_LOADING = <div aria-hidden className="mt-2 h-12 animate-pulse rounded-md bg-wash" />;

const money = (n: number | null | undefined) => (n === null || n === undefined ? "—" : soles(n));

function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

type Glyph = ComponentType<SVGProps<SVGSVGElement>>;

/** Campo del motorizado: 48 px, texto de 16 px (Android no hace zoom), anillo fino y foco azul. */
const RIDER_FIELD =
  "block h-12 w-full min-w-0 rounded-md border-0 bg-white px-3 text-base text-ink-900 shadow-control ring-1 ring-inset ring-line-strong placeholder:text-ink-500 transition-shadow focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500";

/** Botón secundario del motorizado: blanco, anillo y sombra corta. */
const RIDER_SECONDARY =
  "bg-white text-ink-700 shadow-control ring-1 ring-inset ring-line-strong transition-[background-color,color,box-shadow] duration-150 hover:bg-wash hover:text-ink-900";

/** Opción elegida: velo azul y anillo de 2 px (el lenguaje de la selección). */
const RIDER_CHOSEN = "bg-brand-50 text-brand-700 ring-2 ring-inset ring-brand-600";

/** Lo que falta cobrar: el saldo si se conoce; si no, el total del pedido. */
function amountDue(stop: StopWithOrder): number | null {
  return stop.collection?.remaining ?? stop.order?.total ?? null;
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
  /** Modo de recojo (0185): en «confirmar» cada parada nace «por confirmar». */
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
  // WhatsApp abre una hoja con los dos mensajes; vale desde la lista y la ficha.
  const [whatsappFor, setWhatsappFor] = useState<string | null>(null);
  const whatsappStop = whatsappFor ? stops.find((s) => s.id === whatsappFor) ?? null : null;
  // Los contadores de arriba son filtros: tocar uno deja solo esas paradas;
  // tocarlo otra vez vuelve a mostrar todas.
  const [statusFilter, setStatusFilter] = useState<"pendiente" | "entregado" | "no_entregado" | null>(null);
  const toggleStatus = (s: "pendiente" | "entregado" | "no_entregado") => setStatusFilter((cur) => (cur === s ? null : s));
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
  // La siguiente es la primera por entregar en el orden de la ruta.
  const nextId = useMemo(() => (closed ? null : stops.find((s) => s.status === "pendiente")?.id ?? null), [stops, closed]);

  if (!route) {
    return (
      <main className="rider-scale mx-auto flex min-h-screen max-w-md flex-col justify-center gap-4 bg-slate-50 p-4">
        <div className="rounded-lg bg-white p-6 text-center shadow-control ring-1 ring-inset ring-line">
          <h1 className="text-lg font-semibold text-ink-900">Hola, {riderName}</h1>
          <p className="mt-2 text-sm text-ink-600">
            Todavía no tienes ninguna ruta asignada. Cuando el coordinador te la entregue, aparecerá
            aquí. Si ya saliste con paquetes, añádelos abajo.
          </p>
        </div>
        {!coordinator && vocabulary && today && <AddPointPanel fecha={today} onDone={() => router.refresh()} />}
      </main>
    );
  }

  const reported = totals.total - totals.pendientes;
  return (
    <main className="rider-scale mx-auto min-h-screen max-w-md bg-slate-50 lg:grid lg:max-w-5xl lg:grid-cols-[28rem_minmax(0,1fr)] lg:items-start">
      <div className="min-w-0 pb-24 lg:min-h-screen lg:shadow-[inset_-1px_0_0_var(--color-line)]">
      <header className="sticky top-0 z-10 bg-white px-4 pb-3 pt-3 shadow-[inset_0_-1px_0_var(--color-line)]">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <h1 className="truncate text-base font-semibold text-ink-900">{riderName}</h1>
            <p className="text-xs tabular-nums text-ink-500">
              {totals.total ? `${reported} de ${totals.total} reportadas` : "Sin paradas"}
            </p>
          </div>
          {routes.length > 1 ? (
            <select
              value={route.id}
              onChange={(e) => router.push(`/reparto?ruta=${e.target.value}${coordinator ? "&modo=coordinacion" : ""}`)}
              aria-label="Ruta a reportar"
              className="h-10 shrink-0 rounded-md border-0 bg-white px-2 text-xs text-ink-700 shadow-control ring-1 ring-inset ring-line-strong"
            >
              {routes.map((r) => (
                <option key={r.id} value={r.id}>
                  {routeLabels?.[r.id] ?? r.route_date}
                  {r.status === "cerrada" ? " (cerrada)" : ""}
                </option>
              ))}
            </select>
          ) : (
            <span className="shrink-0 text-xs tabular-nums text-ink-500">{route.route_date}</span>
          )}
        </div>
        {coordinator && (
          <Banner tone="info" className="mt-3">
            Reportas como <strong className="font-semibold text-ink-900">{coordinator}</strong> por el motorizado. Tu usuario quedará registrado.{" "}
            <a className="font-medium text-brand-700 underline underline-offset-2" href="/dashboard/courier/reparto">Volver a Rutas</a>
          </Banner>
        )}
        {/* Las cifras son filtros (la regla de Cifras Navegan): tocar una deja
            solo esas paradas; tocarla otra vez las muestra todas. */}
        <div className="mt-3 grid grid-cols-3 gap-2">
          <RouteCount label="Por entregar" value={totals.pendientes} active={statusFilter === "pendiente"} onClick={() => toggleStatus("pendiente")} />
          <RouteCount label="Entregados" value={totals.entregados} active={statusFilter === "entregado"} onClick={() => toggleStatus("entregado")} />
          <RouteCount label="No entregados" value={totals.noEntregados} active={statusFilter === "no_entregado"} onClick={() => toggleStatus("no_entregado")} />
        </div>
        {mode === "confirmar" && unconfirmed > 0 && !coordinator && (
          <div className="mt-3">
            <button
              type="button"
              onClick={() => { setScanSession({ base: confirmable - unconfirmed, scanned: 0 }); setConfirmAll((v) => !v); }}
              aria-expanded={confirmAll}
              className={cn("inline-flex h-12 w-full items-center justify-center rounded-md px-3 text-sm font-semibold", confirmAll ? RIDER_SECONDARY : "bg-brand-600 text-white shadow-primary hover:bg-brand-700")}
            >
              {confirmAll ? "Cerrar el escáner" : `Confirmar todos · escanea ${unconfirmed} ${unconfirmed === 1 ? "paquete" : "paquetes"}`}
            </button>
            {confirmAll && (
              <Suspense fallback={SCAN_LOADING}>
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
              </Suspense>
            )}
            {headerMessage && <Banner tone={headerMessage.ok ? "ok" : "crit"} role="status" className="mt-2">{headerMessage.text}</Banner>}
          </div>
        )}
        {mode === "confirmar" && unconfirmed > 0 && coordinator && (
          <p className="mt-2"><Badge tone="warn">{unconfirmed} por confirmar</Badge></p>
        )}
        {totals.efectivo > 0 && (
          <p className="mt-2 text-xs tabular-nums text-ink-500">
            {coordinator ? "Efectivo reportado por la ruta:" : "Efectivo en tu mano:"}{" "}
            <strong className="font-semibold text-ink-900">{money(totals.efectivo)}</strong>
            {totals.yape > 0 && <> · Yape {money(totals.yape)}</>}
            {totals.pos > 0 && <> · POS {money(totals.pos)}</>}
          </p>
        )}
        {closed && (
          <Banner tone="info" className="mt-3">Esta ruta ya está cerrada. Si algo quedó mal, avisa al coordinador.</Banner>
        )}
      </header>

      <ul className="space-y-2 p-3">
        {statusFilter && (
          <li className="flex items-center justify-between gap-3 rounded-lg bg-wash px-3 py-2 text-sm text-ink-700">
            <span>Mostrando solo {statusFilter === "pendiente" ? "por entregar" : statusFilter === "entregado" ? "entregados" : "no entregados"}</span>
            <button type="button" onClick={() => setStatusFilter(null)} className="min-h-11 font-semibold text-brand-700 underline underline-offset-2">Ver todos</button>
          </li>
        )}
        {stops.map((stop, index) => ({ stop, number: index + 1 })).filter(({ stop }) => !statusFilter || stop.status === statusFilter).map(({ stop, number }) => (
          <li key={stop.id}>
            <StopCard
              stop={stop}
              number={number}
              isNext={stop.id === nextId}
              selected={openId === stop.id}
              readOnly={closed}
              delegated={Boolean(coordinator)}
              pickupMode={mode}
              onOpen={() => openStopPanel(stop.id)}
              onDone={() => setRefreshTick((n) => n + 1)}
              onWhatsApp={() => setWhatsappFor(stop.id)}
            />
          </li>
        ))}
        {stops.length === 0 && (
          <li className="rounded-lg bg-white p-6 text-center text-sm text-ink-500 shadow-control ring-1 ring-inset ring-line">
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
        <div className="fixed inset-x-0 bottom-0 z-10 mx-auto max-w-md bg-ok-wash px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3 text-center text-sm text-ink-700 shadow-[inset_0_1px_0_var(--color-line)] lg:max-w-5xl">
          <span className="font-semibold text-ok-fg">Terminaste tus {totals.total} paradas.</span> Ya puedes entregar{" "}
          <strong className="font-semibold tabular-nums text-ink-900">{money(totals.efectivo)}</strong> en efectivo.
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
          onWhatsApp={() => setWhatsappFor(openStop.id)}
        />
      ) : (
        <aside aria-hidden="true" className="hidden lg:sticky lg:top-0 lg:flex lg:h-screen lg:items-center lg:justify-center lg:p-6">
          <p className="text-sm text-ink-500">Toca una parada para ver su detalle.</p>
        </aside>
      )}

      {whatsappStop && <WhatsAppSheet stop={whatsappStop} riderName={riderName} onClose={() => setWhatsappFor(null)} />}
    </main>
  );
}

/**
 * Una cifra de la ruta que filtra la lista (la tarjeta de estado del mundo de
 * operación). Con el texto del motorizado un 30 % más grande, «No entregados»
 * no cabe en una línea a 390 px: la etiqueta parte en dos en vez de cortarse.
 */
function RouteCount({ label, value, active, onClick }: { label: string; value: number; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "flex min-w-0 flex-col items-start justify-between gap-1 rounded-lg bg-white px-3 py-2 text-left shadow-control transition-shadow",
        active ? "ring-2 ring-inset ring-brand-600" : "ring-1 ring-inset ring-line hover:ring-line-strong",
      )}
    >
      <span className={cn("text-xs font-medium leading-tight", active ? "text-brand-700" : "text-ink-600")}>{label}</span>
      <span className={cn("text-xl font-semibold leading-7 tabular-nums", active ? "text-brand-700" : "text-ink-900")}>{value.toLocaleString("es-PE")}</span>
    </button>
  );
}

/**
 * El detalle de la parada, al lado de la lista. En el teléfono cubre el
 * contenedor de la lista (mismo ancho, alto de pantalla) y se cierra con «←»
 * o con «atrás»; en pantalla ancha es la columna derecha. El scroll es suyo, y
 * «Guardar» queda pegado abajo, al alcance del pulgar.
 */
function StopPanel({
  stop,
  readOnly,
  delegated,
  vocabulary,
  pickupMode,
  onClose,
  onDone,
  onWhatsApp,
}: {
  stop: StopWithOrder;
  readOnly: boolean;
  delegated: boolean;
  vocabulary: RiderVocabulary | null;
  pickupMode: RiderPickupMode;
  onClose: () => void;
  onDone: () => void;
  onWhatsApp: () => void;
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
      <div className="flex h-full flex-col bg-white shadow-pop animate-slide-in-right lg:animate-none lg:shadow-none">
      <header className="flex items-center gap-1 py-1.5 pl-1 pr-4 shadow-[inset_0_-1px_0_var(--color-line)]">
        <button
          type="button"
          onClick={onClose}
          aria-label="Volver a la lista"
          className="grid size-12 shrink-0 place-items-center rounded-md text-ink-600 transition-colors hover:bg-wash hover:text-ink-900"
        >
          <IconArrowLeft className="size-6" />
        </button>
        <div className="min-w-0 flex-1">
          <p className="truncate text-base font-semibold text-ink-900">{o?.customer_name ?? "Sin nombre"}</p>
          <p className="truncate text-xs text-ink-500">
            {o?.name ?? "—"} · {o?.district ?? "—"}
          </p>
        </div>
        <span className="flex shrink-0 flex-col items-end gap-1">
          <StopStatusLine stop={stop} badge={decision.badge} />
        </span>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {!delegated && (decision.canConfirm || decision.canDecline) && (
          <div className="lg:hidden">
            <PickupConfirmBar stop={stop} onDone={onDone} />
          </div>
        )}
        <div className="space-y-4 px-4 pt-4">
          <AddressBlock stop={stop} />
          <QuickActions stop={stop} variant="bar" onWhatsApp={onWhatsApp} />
        </div>

        {readOnly ? (
          <p className="px-4 py-5 text-sm text-ink-500">
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

/** Lo que el motorizado ya reportó: estado escrito o el de Kapta, y el recojo. */
function StopStatusLine({ stop, badge, quietPending = false }: {
  stop: StopWithOrder;
  badge: ReturnType<typeof riderStopDecision>["badge"];
  /** En la lista, «Por entregar» ya lo dicen el número oscuro y los atajos. */
  quietPending?: boolean;
}) {
  const tone = stop.status === "entregado" ? "ok" : stop.status === "no_entregado" ? "crit" : "neutral";
  const hideStatus = quietPending && stop.status === "pendiente" && !stop.written_status;
  return (
    <>
      {!hideStatus && <Badge tone={tone} wrap>
        {stop.written_status
          ? stop.written_status
          : stop.status === "entregado"
            ? "Entregado"
            : stop.status === "no_entregado"
              ? "No entregado"
              : "Por entregar"}
      </Badge>}
      {badge && (
        <Badge tone={badge === "lo_llevo" ? "ok" : "warn"}>
          {badge === "lo_llevo" ? <><IconCheck className="size-3.5" /> Lo llevo</> : "Por confirmar"}
        </Badge>
      )}
      {stop.status === "entregado" && stop.pickup_confirmed === false && (
        <Badge tone="warn">Sin confirmar recojo</Badge>
      )}
    </>
  );
}

/** La dirección, su referencia y dos atajos: copiarla y abrirla en Waze. */
function AddressBlock({ stop }: { stop: StopWithOrder }) {
  const o = stop.order;
  // El mismo copiar de todo Kapta: dice «No se pudo copiar» si el navegador lo niega.
  const { state: copyState, copy } = useCopyToClipboard();
  const text = addressToCopy(o);
  const waze = wazeHref(o);
  return (
    <div className="flex gap-3">
      <IconMapPin className="mt-0.5 size-5 shrink-0 text-ink-500" />
      <div className="min-w-0 flex-1">
        <p className="text-sm text-ink-900">{o?.address ?? "Sin dirección"}</p>
        {o?.reference && <p className="mt-0.5 text-xs text-ink-600">Ref: {o.reference}</p>}
        {(text || waze) && (
          <div className="mt-1 flex flex-wrap gap-x-5">
            {text && (
              <button
                type="button"
                onClick={() => copy(text)}
                aria-label={copyState === "idle" ? "Copiar dirección" : undefined}
                className={cn("inline-flex min-h-11 items-center gap-1.5 text-xs font-semibold", copyState === "fail" ? "text-crit-fg" : "text-brand-700")}
              >
                {copyState === "ok" ? <IconCheck className="size-4" /> : <IconCopy className="size-4" />}
                <span aria-live="polite">{copyLabel(copyState)}</span>
              </button>
            )}
            {waze && (
              <a href={waze} target="_blank" rel="noreferrer" aria-label="Abrir en Waze" className="inline-flex min-h-11 items-center gap-1.5 text-xs font-semibold text-brand-700">
                <IconNavigate className="size-4" />
                Waze
              </a>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Ir, WhatsApp y Llamar: los tres gestos de un repartidor en la calle. En la
 * tarjeta son una fila bajo la parada; en la ficha, tres botones de 56 px.
 * Sin número o sin dirección, el gesto se ve apagado y dice por qué.
 */
function QuickActions({ stop, variant, onWhatsApp }: { stop: StopWithOrder; variant: "row" | "bar"; onWhatsApp: () => void }) {
  const o = stop.order;
  const nav = navigationHref(o);
  const tel = telHref(o?.customer_phone);
  const canWhatsApp = Boolean(whatsappNumber(o?.customer_phone));
  const actions: { key: string; label: string; icon: Glyph; href?: string | null; onClick?: () => void; missing: string; external?: boolean }[] = [
    { key: "ir", label: "Ir", icon: IconNavigate, href: nav, missing: "Sin dirección", external: true },
    { key: "whatsapp", label: "WhatsApp", icon: IconWhatsApp, onClick: canWhatsApp ? onWhatsApp : undefined, missing: "Sin celular" },
    { key: "llamar", label: "Llamar", icon: IconPhone, href: tel, missing: "Sin número" },
  ];
  const bar = variant === "bar";
  return (
    <div className={bar ? "grid grid-cols-3 gap-2" : "grid grid-cols-3 shadow-[inset_0_1px_0_var(--color-line)]"}>
      {actions.map(({ key, label, icon: Icon, href, onClick, missing, external }, i) => {
        const enabled = Boolean(href || onClick);
        const body = (
          <>
            <Icon className={bar ? "size-6" : "size-5"} />
            <span className={bar ? "text-xs font-semibold" : "text-xs font-medium"}>{enabled ? label : missing}</span>
          </>
        );
        const cls = bar
          ? cn("flex h-14 flex-col items-center justify-center gap-1 rounded-md", enabled ? RIDER_SECONDARY : "bg-wash text-ink-300")
          : cn(
              "flex h-12 items-center justify-center gap-2 transition-colors",
              i > 0 && "shadow-[inset_1px_0_0_var(--color-line)]",
              enabled ? "text-ink-700 hover:bg-wash hover:text-ink-900" : "text-ink-300",
            );
        if (!enabled) {
          return <span key={key} aria-disabled="true" className={cls}>{body}</span>;
        }
        if (href) {
          return (
            <a key={key} href={href} {...(external ? { target: "_blank", rel: "noreferrer" } : {})} aria-label={key === "ir" ? "Ir con Google Maps" : undefined} className={cls}>
              {body}
            </a>
          );
        }
        return (
          <button key={key} type="button" onClick={onClick} className={cls}>
            {body}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Los dos mensajes de WhatsApp, presentándose como la tienda del pedido
 * (decisión de Frankz, 30-09-2026). Se abre WhatsApp con el texto escrito y el
 * motorizado lo envía; Kapta no manda nada por él.
 */
function WhatsAppSheet({ stop, riderName, onClose }: { stop: StopWithOrder; riderName: string; onClose: () => void }) {
  const o = stop.order;
  const first = useRef<HTMLAnchorElement>(null);
  // Quien la abre pasa un `onClose` nuevo en cada render; el efecto de foco y
  // Escape corre una sola vez y lee el último.
  const close = useRef(onClose);
  useEffect(() => { close.current = onClose; });
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    first.current?.focus({ preventScroll: true });
    const onKey = (e: globalThis.KeyboardEvent) => { if (e.key === "Escape") close.current(); };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      if (before?.isConnected) before.focus({ preventScroll: true });
    };
  }, []);
  const context = {
    customerName: o?.customer_name,
    riderName,
    storeName: stop.store_name,
    orderName: o?.name,
    amountDue: stop.collection?.remaining ?? null,
  };
  const kinds: RiderMessageKind[] = ["en_camino", "llegue"];
  const plain = whatsappHref(o?.customer_phone);
  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-ink-900/30 lg:items-center" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="rider-whatsapp-title"
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md rounded-t-lg bg-white px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-4 shadow-pop lg:rounded-lg"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 id="rider-whatsapp-title" className="text-base font-semibold text-ink-900">
              Escribir a {firstName(o?.customer_name) ?? "el cliente"}
            </h2>
            <p className="text-xs text-ink-500">Se abre WhatsApp con el mensaje escrito; tú lo envías.</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Cerrar" className="-mr-2 -mt-1 grid size-11 shrink-0 place-items-center rounded-md text-ink-500 transition-colors hover:bg-wash hover:text-ink-900">
            <IconX className="size-5" />
          </button>
        </div>
        <ul className="mt-3 space-y-2">
          {kinds.map((kind, i) => {
            const text = riderWhatsappMessage(kind, context);
            return (
              <li key={kind}>
                <a
                  ref={i === 0 ? first : undefined}
                  href={whatsappHref(o?.customer_phone, text) ?? undefined}
                  target="_blank"
                  rel="noreferrer"
                  onClick={onClose}
                  className={cn("block rounded-lg p-3", RIDER_SECONDARY)}
                >
                  <span className="flex items-center gap-2 text-sm font-semibold text-ink-900">
                    <IconWhatsApp className="size-5 shrink-0 text-ink-600" />
                    {RIDER_MESSAGE_LABEL[kind]}
                  </span>
                  <span className="mt-1 block text-xs text-ink-600">{text}</span>
                </a>
              </li>
            );
          })}
        </ul>
        {plain && (
          <a href={plain} target="_blank" rel="noreferrer" onClick={onClose} className="mt-1 flex min-h-12 items-center justify-center text-sm font-semibold text-brand-700">
            Abrir el chat sin mensaje
          </a>
        )}
      </div>
    </div>
  );
}

function StopCard({
  stop,
  number,
  isNext = false,
  selected,
  readOnly,
  delegated = false,
  pickupMode = "exigir",
  onOpen,
  onDone,
  onWhatsApp,
}: {
  stop: StopWithOrder;
  number: number;
  isNext?: boolean;
  selected: boolean;
  readOnly: boolean;
  delegated?: boolean;
  pickupMode?: RiderPickupMode;
  onOpen: () => void;
  onDone: () => void;
  onWhatsApp: () => void;
}) {
  const o = stop.order;
  // «Lo llevo» / «No lo llevo» (0185): solo en modo confirmar, sobre paradas
  // pendientes que salieron de una caja y que el motorizado aún no confirmó.
  const decision = riderStopDecision(pickupMode, {
    status: stop.status,
    pickupCheckedAt: stop.pickup_checked_at,
    hasManifestItem: Boolean(stop.manifest_item_id),
    routeClosed: readOnly,
  });
  const pending = stop.status === "pendiente";
  // Por entregar: lo que falta cobrar. Entregada: lo cobrado y cómo.
  const due = pending ? amountDue(stop) : stop.status === "entregado" ? stop.collected_amount : o?.total ?? null;
  const method = stop.status === "entregado" ? PAYMENT_METHODS.find((m) => m.code === stop.payment_method)?.label : null;

  return (
    <article
      className={cn(
        "overflow-hidden rounded-lg bg-white shadow-control ring-inset transition-shadow",
        selected ? "ring-2 ring-brand-600" : "ring-1 ring-line",
      )}
    >
      <button type="button" onClick={onOpen} aria-current={selected ? "true" : undefined} className="flex w-full items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-wash focus-visible:bg-wash">
        <span
          aria-hidden
          className={cn(
            "mt-0.5 grid size-7 shrink-0 place-items-center rounded-full text-xs font-semibold tabular-nums",
            pending ? "bg-ink-900 text-white" : "bg-line text-ink-600",
          )}
        >
          {number}
        </span>
        <span className="min-w-0 flex-1">
          <span className={cn("block truncate text-sm font-semibold", pending ? "text-ink-900" : "text-ink-600")}>
            {o?.customer_name ?? "Sin nombre"}
          </span>
          <span className="block truncate text-xs text-ink-500">
            {o?.district ?? "—"} · {o?.name ?? "—"}
          </span>
          <span className="mt-1.5 flex flex-wrap items-center gap-1.5 empty:hidden">
            {isNext && <Badge tone="brand">Siguiente</Badge>}
            <StopStatusLine stop={stop} badge={decision.badge} quietPending />
          </span>
        </span>
        <span className="shrink-0 text-right">
          <span className={cn("block text-sm font-semibold tabular-nums", pending ? "text-ink-900" : "text-ink-600")}>
            {pending && due === 0 ? "Pagado" : money(due)}
          </span>
          {method && <span className="block text-xs text-ink-500">{method}</span>}
        </span>
      </button>
      {pending && !readOnly && <QuickActions stop={stop} variant="row" onWhatsApp={onWhatsApp} />}
      {!delegated && (decision.canConfirm || decision.canDecline) && (
        <PickupConfirmBar stop={stop} onDone={onDone} />
      )}
    </article>
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
    <div className="bg-warn-wash px-4 py-3 shadow-[inset_0_1px_0_var(--color-line)]">
      <div className="flex gap-2">
        <button
          type="button"
          disabled={pending}
          onClick={() => setPanel(panel === "confirm" ? "none" : "confirm")}
          aria-expanded={panel === "confirm"}
          className="h-12 flex-1 rounded-md bg-brand-600 px-3 text-sm font-semibold text-white shadow-primary transition-colors hover:bg-brand-700 disabled:opacity-50"
        >
          Lo llevo
        </button>
        <button
          type="button"
          disabled={pending}
          onClick={() => setPanel(panel === "decline" ? "none" : "decline")}
          aria-expanded={panel === "decline"}
          className={cn("h-12 rounded-md px-3 text-sm font-semibold disabled:opacity-50", RIDER_SECONDARY)}
        >
          No lo llevo
        </button>
      </div>
      {panel === "confirm" && (
        <div className="mt-2 space-y-2">
          <Suspense fallback={SCAN_LOADING}>
            <ScanAction context="motorizado_recepcion" itemId={stop.manifest_item_id} compact label="Escanear el paquete" disabled={pending} onResult={say} />
          </Suspense>
          <button
            type="button"
            disabled={pending}
            onClick={() => start(async () => say(await confirmMyGfPickup({ itemId: stop.manifest_item_id })))}
            className={cn("h-11 w-full rounded-md px-3 text-xs font-semibold disabled:opacity-50", RIDER_SECONDARY)}
          >
            Sin escanear: confirmo que lo llevo
          </button>
        </div>
      )}
      {panel === "decline" && (
        <div className="mt-2 space-y-2">
          <select value={reason} onChange={(e) => setReason(e.target.value)} aria-label="Por qué no lo llevas" className={RIDER_FIELD}>
            {DECLINE_REASONS.map((r) => <option key={r.code} value={r.code}>{r.label}</option>)}
          </select>
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder={reason === "otro" ? "Di en una línea qué pasó" : "Detalle (opcional)"} aria-label="Detalle" className={RIDER_FIELD} />
          <button
            type="button"
            disabled={pending || !stop.dispatch_manifest_id || !stop.shipment_id}
            onClick={() => start(async () => say(await declineMyGfPackage(stop.dispatch_manifest_id ?? "", stop.shipment_id ?? "", reason, note)))}
            className="h-12 w-full rounded-md bg-white px-3 text-sm font-semibold text-warn-fg shadow-control ring-1 ring-inset ring-line-strong transition-colors hover:bg-warn-wash disabled:opacity-50"
          >
            Confirmar que no lo llevo
          </button>
        </div>
      )}
      {message && <Banner tone={message.ok ? "ok" : "crit"} role="status" className="mt-2">{message.text}</Banner>}
    </div>
  );
}

/** Elección de una sola opción que siempre tiene valor: flechas para moverse, como un radio. */
function radioKeys(e: KeyboardEvent<HTMLButtonElement>, choose: (delta: 1 | -1) => void) {
  if (e.key === "ArrowRight" || e.key === "ArrowDown") { e.preventDefault(); choose(1); }
  if (e.key === "ArrowLeft" || e.key === "ArrowUp") { e.preventDefault(); choose(-1); }
}

const OUTCOMES: { value: "entregado" | "no_entregado"; label: string; icon: Glyph; chosen: string }[] = [
  { value: "entregado", label: "Entregado", icon: IconCheck, chosen: "bg-ok-bg text-ok-fg ring-2 ring-inset ring-ok-fg" },
  { value: "no_entregado", label: "No entregado", icon: IconX, chosen: "bg-crit-bg text-crit-fg ring-2 ring-inset ring-crit-fg" },
];

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
  const [otherAccount, setOtherAccount] = useState(false);
  const [accountsOpen, setAccountsOpen] = useState(false);
  const outcomeRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const numericAmount = amount.trim() ? Number(amount.replace(",", ".")) : null;
  const collectedForReason = status === "entregado" ? (method === "sin_cobro" ? 0 : numericAmount) : null;
  const mustExplain = status === "entregado" && Boolean(vocabulary) && montoDiffers(collectedForReason, stop.order?.total ?? null);
  // Las cuentas del cuaderno para el método elegido (p. ej. los Yape de la
  // empresa). Solo se ofrecen si hay más de una: si no, la deduce el método.
  const accounts = useMemo(
    () => (method && method !== "sin_cobro" ? REPARTO_PAYMENT_METHODS.filter((m) => sheetPaymentToStop(m) === method) : []),
    [method],
  );
  const noteRequired = status === "no_entregado" && reason === "otro";

  // Lo que el servidor va a pedir, dicho antes de pulsar: la MISMA función.
  const check = validateStopReport({
    status,
    paymentMethod: status === "entregado" ? method : null,
    collectedAmount: status === "entregado" ? (method === "sin_cobro" ? 0 : numericAmount) : null,
    outcomeReason: status === "no_entregado" ? reason || null : null,
    note,
    hasPhoto: Boolean(photoPath),
    hasVoucher: Boolean(voucherPath),
  });
  const nextStep = !check.ok ? check.errors[0] : mustExplain && !reasonCode ? "Elige por qué cobraste distinto." : null;

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

  const chooseOutcome = (value: "entregado" | "no_entregado") => { setStatus(value); setErr(null); };
  const saveLabel = pending
    ? "Guardando…"
    : stop.status !== "pendiente"
      ? "Corregir"
      : status === "no_entregado" ? "Guardar no entrega" : "Guardar entrega";

  return (
    <div>
      <div className="space-y-5 px-4 pb-4 pt-5">
        {delegated && <label className="block text-sm font-semibold text-ink-900">Motivo del reporte por el motorizado
          <input required value={reportReason} onChange={(e) => setReportReason(e.target.value)} placeholder="Ej. Roy envió la evidencia y está sin conexión" className={cn(RIDER_FIELD, "mt-1.5 font-normal")} />
        </label>}

        <fieldset>
          <legend className="text-sm font-semibold text-ink-900">¿Qué pasó?</legend>
          <div role="radiogroup" aria-label="Resultado de la parada" className="mt-2 grid grid-cols-2 gap-2">
            {OUTCOMES.map(({ value, label, icon: Icon, chosen }, i) => {
              const checked = status === value;
              return (
                <button
                  key={value}
                  ref={(el) => { outcomeRefs.current[i] = el; }}
                  type="button"
                  role="radio"
                  aria-checked={checked}
                  tabIndex={checked ? 0 : -1}
                  onClick={() => chooseOutcome(value)}
                  onKeyDown={(e) => radioKeys(e, () => {
                    const next = OUTCOMES[(i + 1) % OUTCOMES.length]!;
                    chooseOutcome(next.value);
                    outcomeRefs.current[(i + 1) % OUTCOMES.length]?.focus();
                  })}
                  className={cn(
                    "inline-flex h-14 items-center justify-center gap-2 rounded-md text-sm font-semibold transition-[background-color,color,box-shadow] duration-150",
                    checked ? chosen : RIDER_SECONDARY,
                  )}
                >
                  <Icon className="size-5" />
                  {label}
                </button>
              );
            })}
          </div>
        </fieldset>

        {status === "entregado" && (
          <>
            <div className="rounded-lg bg-wash px-4 py-3">
              <p className="text-xs font-medium text-ink-600">Saldo por cobrar</p>
              <p className="text-lg font-semibold tabular-nums text-ink-900">
                {stop.collection?.remaining == null ? "No disponible, actualiza la ruta" : money(stop.collection.remaining)}
              </p>
              {!!stop.collection?.validated && <p className="text-xs tabular-nums text-ink-600">Pagos previos validados: {money(stop.collection.validated)}</p>}
              {!!stop.collection?.pending && <p className="mt-1 text-xs text-warn-fg">Hay {money(stop.collection.pending)} pendientes de validar. Consulta a coordinación antes de volver a cobrar.</p>}
            </div>

            <fieldset>
              <legend className="text-sm font-semibold text-ink-900">¿Cómo pagó?</legend>
              <div className="mt-2 grid grid-cols-2 gap-2">
                {PAYMENT_METHODS.map((m) => (
                  <button
                    key={m.code}
                    type="button"
                    aria-pressed={method === m.code}
                    disabled={pending}
                    onClick={() => { setMethod(m.code); setWrittenPayment(""); setOtherAccount(false); setAccountsOpen(false); setErr(null); }}
                    className={cn(
                      "h-12 rounded-md px-3 text-sm font-semibold transition-[background-color,color,box-shadow] duration-150 disabled:opacity-50",
                      method === m.code ? RIDER_CHOSEN : RIDER_SECONDARY,
                    )}
                  >
                    {m.label}
                  </button>
                ))}
              </div>
            </fieldset>

            {method && method !== "sin_cobro" && (
              <label className="block">
                <span className="text-sm font-semibold text-ink-900">Importe cobrado en esta entrega</span>
                <span className="relative mt-1.5 block">
                  <span aria-hidden className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-base text-ink-500">S/</span>
                  <input
                    inputMode="decimal"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    placeholder="¿Cuánto cobraste?"
                    className={cn(RIDER_FIELD, "pl-10 font-semibold tabular-nums")}
                  />
                </span>
              </label>
            )}

            {vocabulary && accounts.length > 1 && (
              <div>
                {/* La cuenta casi siempre es la de la empresa: se dice en una
                    línea y las demás aparecen solo si el pago fue a otra. */}
                <div className="flex items-center justify-between gap-3">
                  <p className="min-w-0 text-sm text-ink-700">
                    <span className="font-semibold text-ink-900">Cuenta:</span>{" "}
                    {writtenPayment.trim() || <>{stopPaymentToSheet(method)} <span className="text-ink-500">(la de siempre)</span></>}
                  </p>
                  <button type="button" aria-expanded={accountsOpen} onClick={() => setAccountsOpen((v) => !v)} className="min-h-11 shrink-0 text-xs font-semibold text-brand-700">
                    {accountsOpen ? "Listo" : "Cambiar"}
                  </button>
                </div>
                {accountsOpen && (
                  <fieldset className="mt-1">
                    <legend className="sr-only">¿A qué cuenta se pagó?</legend>
                    <div className="flex flex-wrap gap-2">
                      {accounts.map((a) => {
                        // Vacío = la de siempre: el cuaderno la deduce del método.
                        const usual = a === stopPaymentToSheet(method);
                        const chosen = writtenPayment.trim() ? writtenPayment === a : usual && !otherAccount;
                        return (
                        <button
                          key={a}
                          type="button"
                          aria-pressed={chosen}
                          onClick={() => { setWrittenPayment(usual ? "" : a); setOtherAccount(false); }}
                          className={cn("h-11 rounded-full px-4 text-sm font-medium transition-[background-color,color,box-shadow] duration-150", chosen ? RIDER_CHOSEN : RIDER_SECONDARY)}
                        >
                          {a}
                        </button>
                        );
                      })}
                      <button
                        type="button"
                        aria-expanded={otherAccount}
                        onClick={() => { setOtherAccount((v) => !v); if (accounts.includes(writtenPayment as (typeof accounts)[number])) setWrittenPayment(""); }}
                        className={cn("h-11 rounded-full px-4 text-sm font-medium", otherAccount ? RIDER_CHOSEN : RIDER_SECONDARY)}
                      >
                        Otra…
                      </button>
                    </div>
                    {otherAccount && (
                      <label className="mt-2 block text-xs font-medium text-ink-600">Escríbela como en el cuaderno
                        <input
                          list={`pagos-${stop.id}`}
                          value={writtenPayment}
                          onChange={(e) => setWrittenPayment(e.target.value)}
                          placeholder="YAPE GF, PLIN FRANKZ, IZIPAY…"
                          className={cn(RIDER_FIELD, "mt-1 uppercase")}
                          autoCapitalize="characters"
                        />
                        <datalist id={`pagos-${stop.id}`}>
                          {REPARTO_PAYMENT_METHODS.map((m) => (
                            <option key={m} value={m} />
                          ))}
                        </datalist>
                      </label>
                    )}
                  </fieldset>
                )}
              </div>
            )}

            {mustExplain && vocabulary && (
              <div className="space-y-2 rounded-lg bg-warn-wash p-3 text-sm">
                <p className="font-semibold text-warn-fg">Cobraste {money(collectedForReason)} y el pedido es de {money(stop.order?.total)}. ¿Por qué?</p>
                <select value={reasonCode} onChange={(e) => setReasonCode(e.target.value)} aria-label="Motivo de la diferencia" className={RIDER_FIELD}>
                  <option value="">Elige el motivo</option>
                  {vocabulary.reasons.map((r) => (
                    <option key={r.code} value={r.code}>{r.label}</option>
                  ))}
                </select>
                <input value={reasonNote} onChange={(e) => setReasonNote(e.target.value)} placeholder="Nota (obligatoria con «Otro»)" aria-label="Nota del motivo" className={RIDER_FIELD} />
              </div>
            )}
            {method === "sin_cobro" && <p className="text-sm text-ink-600">Se registrará S/ 0.00. Si queda saldo, explica el motivo en la nota.</p>}
            {method === "yape" && <p className="text-xs text-ink-500">Yape reportado a la empresa. La captura no equivale a validación bancaria.</p>}

            <div className="space-y-2">
              <PhotoCapture
                stopId={stop.id}
                kind="entrega"
                photoPath={photoPath}
                label="Foto de la entrega"
                onResult={(r) => { if (r.path) setPhotoPath(r.path); }}
              />
              {method === "yape" && (
                <PhotoCapture
                  stopId={stop.id}
                  kind="yape"
                  photoPath={voucherPath}
                  label="Captura del Yape"
                  onResult={(r) => { if (r.path) setVoucherPath(r.path); }}
                />
              )}
            </div>
          </>
        )}

        {status === "no_entregado" && (
          <fieldset>
            <legend className="text-sm font-semibold text-ink-900">¿Por qué no se entregó?</legend>
            <div className="mt-2 grid grid-cols-2 gap-2">
              {NON_DELIVERY_REASONS.map((r) => (
                <button
                  key={r.code}
                  type="button"
                  aria-pressed={reason === r.code}
                  onClick={() => { setReason(r.code); setErr(null); }}
                  className={cn(
                    "min-h-12 rounded-md px-3 py-2 text-left text-sm font-semibold leading-snug transition-[background-color,color,box-shadow] duration-150",
                    reason === r.code ? RIDER_CHOSEN : RIDER_SECONDARY,
                  )}
                >
                  {r.label}
                </button>
              ))}
            </div>
          </fieldset>
        )}

        {/* Un rechazo se cobra a la tienda: el motorizado lo fotografía en la
            puerta, como una entrega. Cualquier otra no entrega solo lleva foto
            cuando reporta otra persona por él. */}
        {status === "no_entregado" && nonDeliveryNeedsPhoto(reason, delegated) && <PhotoCapture
          stopId={stop.id}
          kind="entrega"
          photoPath={photoPath}
          label={delegated ? "Evidencia del reporte" : "Foto del rechazo"}
          onResult={(r) => { if (r.path) setPhotoPath(r.path); }}
        />}

        {vocabulary && (
          <label className="block text-sm font-semibold text-ink-900">
            Como en tu cuaderno <span className="font-normal text-ink-500">(opcional)</span>
            <input
              list={`estados-${stop.id}`}
              value={written}
              onChange={(e) => applyWritten(e.target.value)}
              placeholder="ENTREGADO, NO RESPONDE, LO DEJA…"
              className={cn(RIDER_FIELD, "mt-1.5 font-normal uppercase")}
              autoCapitalize="characters"
            />
            <datalist id={`estados-${stop.id}`}>
              {vocabulary.suggestions.map((sug) => (
                <option key={sug} value={sug} />
              ))}
            </datalist>
            {written.trim() && (
              <span className={cn("mt-1 block text-xs font-normal", resolved?.code ? "text-ok-fg" : "text-warn-fg")}>
                {resolved?.code ? `Se entiende como «${resolved.label}».` : "Todavía no tiene equivalente: se guarda igual y alguien lo asignará."}
              </span>
            )}
          </label>
        )}

        <label className="block text-sm font-semibold text-ink-900">
          Nota {noteRequired ? <span className="font-normal text-warn-fg">(obligatoria con «Otro»)</span> : <span className="font-normal text-ink-500">(opcional)</span>}
          <textarea
            aria-label="Nota del reporte"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder={noteRequired ? "Qué pasó, en una línea" : "Algo que coordinación deba saber"}
            rows={2}
            className="mt-1.5 block w-full rounded-md border-0 bg-white px-3 py-2.5 text-base font-normal text-ink-900 shadow-control ring-1 ring-inset ring-line-strong placeholder:text-ink-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
          />
        </label>
      </div>

      {/* «Guardar» pegado abajo, al alcance del pulgar, con lo que falta dicho
          antes de pulsar. */}
      <div className="sticky bottom-0 z-10 bg-white px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3 shadow-[inset_0_1px_0_var(--color-line)]">
        {err ? (
          <p role="alert" className="mb-2 text-sm text-crit-fg">{err}</p>
        ) : nextStep ? (
          <p className="mb-2 text-xs text-ink-600" aria-live="polite">Antes de guardar: {nextStep.charAt(0).toLowerCase() + nextStep.slice(1)}</p>
        ) : null}
        <button
          type="button"
          onClick={submit}
          disabled={pending || (status === "entregado" && (method === null || stop.collection?.remaining == null))}
          className="h-[3.25rem] w-full rounded-md bg-brand-600 px-4 text-sm font-semibold text-white shadow-primary transition-colors hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-brand-600"
        >
          {saveLabel}
        </button>
      </div>
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
      <button type="button" onClick={() => setOpen(true)} className="h-12 w-full rounded-lg border border-dashed border-line-strong bg-white px-4 text-sm font-medium text-ink-600 transition-colors hover:border-ink-300 hover:text-ink-900">
        + Añadir un punto que no está en mi ruta
      </button>
    );
  }
  return (
    <section className="space-y-3 rounded-lg bg-white p-4 shadow-control ring-1 ring-inset ring-line" aria-label="Añadir punto">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-ink-900">Añadir punto · {fecha}</h2>
        <button type="button" onClick={() => setOpen(false)} className="min-h-11 text-xs font-medium text-ink-600 underline underline-offset-2">Cerrar</button>
      </div>
      <div className="flex gap-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void search()}
          placeholder="Nº de pedido o nombre del cliente"
          aria-label="Buscar pedido"
          className={cn(RIDER_FIELD, "flex-1")}
        />
        <button type="button" onClick={() => void search()} className={cn("h-12 shrink-0 rounded-md px-4 text-sm font-semibold", RIDER_SECONDARY)}>Buscar</button>
      </div>
      {results.length > 0 && (
        <ul className="divide-y divide-line rounded-lg ring-1 ring-inset ring-line">
          {results.map((r) => (
            <li key={r.order_id} className="flex items-center justify-between gap-2 px-3 py-2 text-sm">
              <div className="min-w-0">
                <p className="truncate font-medium text-ink-900">{r.order_name} · {r.customer_name ?? "Sin nombre"}</p>
                <p className="truncate text-xs tabular-nums text-ink-500">{r.district ?? "—"} · {money(r.order_total)}</p>
              </div>
              <button type="button" disabled={pending} onClick={() => add(r.order_id)} className="h-11 shrink-0 rounded-md bg-brand-600 px-3 text-xs font-semibold text-white shadow-primary transition-colors hover:bg-brand-700 disabled:opacity-50">Añadir</button>
            </li>
          ))}
        </ul>
      )}
      <details className="text-sm">
        <summary className="min-h-11 cursor-pointer py-2 text-ink-600">Punto sin pedido de Kapta (Kast, encargo)</summary>
        <div className="mt-2 flex gap-2">
          <input value={kastName} onChange={(e) => setKastName(e.target.value)} placeholder="Nombre del cliente" aria-label="Cliente del punto sin pedido" className={cn(RIDER_FIELD, "flex-1")} />
          <button type="button" disabled={pending || !kastName.trim()} onClick={addKast} className={cn("h-12 shrink-0 rounded-md px-4 text-sm font-semibold disabled:opacity-50", RIDER_SECONDARY)}>Añadir</button>
        </div>
        <p className="mt-1 text-xs text-ink-500">Queda solo en tu cuaderno: sin pedido no hay parada que cobrar en Kapta.</p>
      </details>
      {msg && <p role="status" className={cn("text-sm", msg.ok ? "text-ok-fg" : "text-crit-fg")}>{msg.text}</p>}
    </section>
  );
}
