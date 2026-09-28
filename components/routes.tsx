"use client";

// Pantalla del coordinador: armar la ruta del día, entregarla y cerrarla.
//
// El ciclo que la gobierna tiene tres puertas, y cada una existe por una razón:
//
//   planificada → el motorizado NO la ve. Se puede añadir y quitar paradas.
//   en_curso    → ya está en su teléfono. Lo que él reporta ya no se borra.
//   cerrada     → generó su liquidación. Se acabó.

import { useEffect, useId, useMemo, useState, useTransition } from "react";
import type { MouseEvent, ReactNode } from "react";
import { useRouter } from "next/navigation";
import { OrderLink } from "@/components/order-link";
import { Card, EmptyState, Section, cn, STICKY_HEAD, TABLE_WRAP_FROM } from "@/components/ui";
import {
  NON_DELIVERY_REASONS,
  PAYMENT_METHODS,
  rejectionNeedsPhoto,
  routeCloseBlockers,
  routeTotals,
  stopsMissingEvidence,
  type EvidenceStop,
  type OpenLoad,
  type RouteCloseBlocker,
} from "@/lib/routes";
import type { RouteCloseContext } from "@/lib/route-close";
import { courierBoxHref } from "@/lib/courier-box-href";
import { RISK_LABELS, type RiskAssessment } from "@/lib/retries";
import type { RouteRow, StopWithOrder } from "@/lib/routes-access";
import type { RiderRow } from "@/lib/settlements-access";
import { Hint } from "@/components/hint";
import { IconAlert, IconCamera, IconCheckCircle, IconClock, IconReceipt, IconTruck } from "@/components/icons";
import { RIDER_PAY_BALANCE_HINT, RIDER_RATE_FORM_ID, RiderPayPanel, riderPayBalanceLabel } from "@/components/rider-pay-panel";
import { checkStopRate, stopEarnings } from "@/lib/rider-pay";
import type { RiderPayDetail } from "@/lib/rider-pay";
import {
  addStops,
  closeRoute,
  reopenRoute,
  ensureRoute,
  linkRiderAccount,
  removeStop,
  searchAssignable,
  startRoute,
} from "@/app/dashboard/rutas/actions";
import { cancelDispatchManifest } from "@/app/dashboard/pedidos/despacho/actions";

interface StoreOpt {
  id: string;
  name: string;
}

interface Assignable {
  order_id: string;
  store_id: string;
  order_name: string | null;
  customer_name: string | null;
  district: string | null;
  address: string | null;
  order_total: number | null;
}

export interface RetryItem {
  order_id: string;
  store_id: string;
  order_name: string | null;
  customer_name: string | null;
  district: string | null;
  order_total: number | null;
  attempts: number;
  lastReason: string | null;
  lastTriedAt: string | null;
  risk: RiskAssessment;
}

const RISK_STYLE: Record<string, string> = {
  ok: "bg-slate-100 text-slate-600",
  vigilar: "bg-amber-50 text-amber-700",
  alto: "bg-red-50 text-red-700",
};

const money = (n: number | null | undefined) =>
  n === null || n === undefined ? "—" : `S/ ${n.toFixed(2)}`;

const ROUTE_STATUS: Record<string, { label: string; style: string }> = {
  planificada: { label: "Armando", style: "bg-slate-100 text-slate-600" },
  en_curso: { label: "En curso", style: "bg-sky-50 text-sky-700" },
  cerrada: { label: "Cerrada", style: "bg-slate-800 text-white" },
};

const reasonLabel = (code: string | null) =>
  NON_DELIVERY_REASONS.find((r) => r.code === code)?.label ?? code ?? "—";
const methodLabel = (code: string | null) =>
  PAYMENT_METHODS.find((m) => m.code === code)?.label ?? code ?? "—";

type RunAction = (fn: () => Promise<{ ok: boolean; error?: string; message?: string }>) => void;

/** Qué paradas enseña la tabla: todas, o las que frenan el cierre o el pago. */
type StopView = "todas" | "sin_reportar" | "sin_foto" | "sin_captura";

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** «#KP1, #KP2, #KP3 y 5 más»: los pedidos de un bloqueo en una línea. */
function orderNames(stops: readonly EvidenceStop[], max = 4): string {
  const names = stops.map((stop) => stop.order?.name ?? `parada ${stop.seq ?? "sin número"}`);
  return names.length <= max ? names.join(", ") : `${names.slice(0, max).join(", ")} y ${names.length - max} más`;
}

/** Lleva la vista a un elemento del panel (el panel lateral es quien desplaza). */
function reveal(id: string) {
  const smooth = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  document.getElementById(id)?.scrollIntoView({ behavior: smooth ? "smooth" : "auto", block: "start" });
}

/** Abre «Tarifa de …» del panel de pago y lo trae a la vista. */
function openRiderRateForm() {
  const form = document.getElementById(RIDER_RATE_FORM_ID);
  if (form instanceof HTMLDetailsElement) form.open = true;
  reveal(RIDER_RATE_FORM_ID);
  form?.querySelector<HTMLElement>("select, input")?.focus({ preventScroll: true });
}

/** Abre la caja en el mismo lugar (cierra este panel), como la fila de Rutas. */
function openBoxInPlace(event: MouseEvent<HTMLAnchorElement>, manifestId: string) {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  window.history.pushState(null, "", courierBoxHref(manifestId, { pathname: window.location.pathname, search: window.location.search }));
}

export function RoutesBoard({
  stores,
  riders,
  routes,
  detail,
  assignable,
  retries,
  day,
  canReport = false,
  detailOnly = false,
  onChanged,
  onRefresh,
  closeContext = null,
  canCancelLoads = false,
}: {
  /** Tras cada acción que salió bien (el panel lateral recarga su detalle). */
  onChanged?: () => void;
  /** «Volver a comprobar»: vuelve a leer paradas y cargas sin hacer nada. */
  onRefresh?: () => Promise<void>;
  /** Cargas de Grupo GF de la ruta (null: no se pudieron leer). */
  closeContext?: RouteCloseContext | null;
  /** Puede cancelar una carga vacía (dispatch.manage). */
  canCancelLoads?: boolean;
  /** Solo el reparto y cierre de la ruta abierta: la lista vive en Grupo GF Courier · Rutas (MOM §29.14). */
  detailOnly?: boolean;
  stores: StoreOpt[];
  riders: RiderRow[];
  routes: RouteRow[];
  detail: { route: RouteRow; stops: StopWithOrder[] } | null;
  assignable: Assignable[];
  retries: RetryItem[];
  day: string;
  canReport?: boolean;
}) {
  const router = useRouter();
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [pending, start] = useTransition();
  // El cálculo del motorizado lo carga RiderPayPanel; la tabla única de la
  // ruta lo enseña por parada (tarifa, adicional, ganancia) y en las métricas.
  const [pay, setPay] = useState<RiderPayDetail | null>(null);
  const [extraStop, setExtraStop] = useState<string | null>(null);

  const run = (fn: () => Promise<{ ok: boolean; error?: string; message?: string }>) =>
    start(async () => {
      setErr(null);
      const res = await fn();
      if (!res.ok) setErr(res.error ?? "No se pudo completar.");
      else {
        setMsg(res.message ?? "Listo.");
        router.refresh();
        onChanged?.();
      }
    });

  const riderName = (id: string) => riders.find((r) => r.id === id)?.full_name ?? "—";
  // Una ruta mezcla tiendas (0057), así que cada parada y cada pedido asignable
  // dicen de cuál son: sin eso el coordinador no sabe qué está cargando.
  const storeName = (id: string | null) => stores.find((s) => s.id === id)?.name ?? "—";

  return (
    <div className="space-y-6">
      {!detailOnly && <>
      <Section title="Rutas de reparto">
        <p className="text-sm text-slate-500">
          Consulta las entregas y revisa la ganancia de cada motorizado. Terminar la ruta
          y aprobar su cálculo financiero son pasos distintos; ninguno registra un depósito.
        </p>
      </Section>

      {msg && <Card className="border-brand-200 bg-brand-50 p-3 text-sm text-brand-800">{msg}</Card>}
      {err && <Card className="border-red-200 bg-red-50 p-3 text-sm text-red-700">{err}</Card>}

      <a href="/dashboard/courier" className="inline-flex min-h-12 items-center rounded-lg bg-brand-600 px-4 text-sm font-semibold text-white">Tomar y asignar pedidos</a>
      <details className="border-b border-slate-200 pb-3">
        <summary className="min-h-12 cursor-pointer py-3 text-sm font-medium text-slate-600">Accesos de motorizados</summary>
        <RidersAccess riders={riders} disabled={pending} onRun={run} />
      </details>

      <Card className="p-0">
        <div className={TABLE_WRAP_FROM[980]}>
          <table className="w-full min-w-[640px] text-sm">
            <thead className={cn(STICKY_HEAD, "bg-slate-50 text-left text-xs text-slate-500")}>
              <tr>
                <th className="px-4 py-2.5 font-medium">Fecha</th>
                <th className="px-4 py-2.5 font-medium">Motorizado</th>
                <th className="px-4 py-2.5 font-medium">Estado</th>
                <th className="px-4 py-2.5 font-medium">Liquidación</th>
              </tr>
            </thead>
            <tbody>
              {routes.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-4 py-10">
                    <EmptyState title="Todavía no hay rutas">
                      Toma y asigna pedidos desde Grupo GF Courier para comenzar.
                    </EmptyState>
                  </td>
                </tr>
              )}
              {routes.map((r) => {
                const open = detail?.route.id === r.id;
                const st = ROUTE_STATUS[r.status] ?? ROUTE_STATUS.planificada!;
                return (
                  <tr
                    key={r.id}
                    onClick={() =>
                      router.push(open ? "/dashboard/courier/reparto" : `/dashboard/courier/reparto?id=${r.id}&dia=${r.route_date}`)
                    }
                    className={cn(
                      "cursor-pointer border-b border-slate-100 hover:bg-slate-50",
                      open && "bg-slate-50",
                    )}
                  >
                    <td className="px-4 py-2.5 font-medium text-slate-800">{r.route_date}</td>
                    <td className="px-4 py-2.5 text-slate-700">{riderName(r.rider_id)}</td>
                    <td className="px-4 py-2.5">
                      <span className={cn("rounded-full px-2 py-0.5 text-xs font-medium", st.style)}>
                        {st.label}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-xs text-slate-500">
                      {r.settlement_id ? "Creada" : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      </>}
      {detailOnly && msg && <p role="status" className="rounded-xl border border-brand-200 bg-brand-50 px-4 py-3 text-sm text-brand-800">{msg}</p>}
      {detailOnly && err && <p role="alert" className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">{err}</p>}

      {detail && (
        <>
        <RouteDetail
          detail={detail}
          assignable={assignable}
          retries={retries}
          riderName={riderName(detail.route.rider_id)}
          storeName={storeName}
          disabled={pending}
          onRun={run}
          canReport={canReport}
          // En el panel de Reparto y liquidación (detailOnly) no se añaden
          // paradas: eso es de la caja (paso 1) y de Despacho del día. Aquí
          // solo se reporta, se cierra y se liquida.
          canAddStops={!detailOnly}
          compact={detailOnly}
          pay={pay}
          onExtra={detailOnly ? setExtraStop : undefined}
          closeContext={closeContext}
          canCancelLoads={canCancelLoads}
          onRefresh={onRefresh ?? (async () => router.refresh())}
        />
        {/* La clave lleva el estado: al terminar o reabrir la ruta el cálculo
            se vuelve a pedir; si no, el checkbox seguía bloqueado por un
            cálculo viejo que aún decía «termina la ruta». */}
        <RiderPayPanel key={`${detail.route.id}:${detail.route.status}`} routeId={detail.route.id} compact={detailOnly} onDetail={setPay} presetStopId={extraStop} />
        </>
      )}
    </div>
  );
}

function NewRoute({
  stores,
  riders,
  day,
  disabled,
  onRun,
}: {
  stores: StoreOpt[];
  riders: RiderRow[];
  day: string;
  disabled: boolean;
  onRun: (fn: () => Promise<{ ok: boolean; error?: string; message?: string }>) => void;
}) {
  const router = useRouter();
  const [storeId, setStoreId] = useState(stores[0]?.id ?? "");
  const [riderId, setRiderId] = useState(riders[0]?.id ?? "");
  const [date, setDate] = useState(day);

  return (
    <Card className="space-y-3 p-4">
      <h3 className="text-sm font-semibold text-slate-800">Armar la ruta del día</h3>
      <p className="text-xs text-slate-500">
        Una ruta por motorizado y día. Puede llevar pedidos de varias tiendas en el mismo viaje: al
        cerrarla sale una liquidación por cada tienda, porque el dinero se cuadra por separado.
      </p>
      {riders.length === 0 ? (
        <p className="text-sm text-slate-500">
          Primero da de alta a tus motorizados en Liquidaciones; luego aquí les armas la ruta.
        </p>
      ) : (
        <div className="flex flex-wrap gap-2">
          <select
            value={storeId}
            onChange={(e) => setStoreId(e.target.value)}
            className="rounded-lg border border-slate-300 px-2 py-2 text-sm"
          >
            {stores.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          <select
            value={riderId}
            onChange={(e) => setRiderId(e.target.value)}
            className="rounded-lg border border-slate-300 px-2 py-2 text-sm"
          >
            {riders.map((r) => (
              <option key={r.id} value={r.id}>
                {r.full_name}
              </option>
            ))}
          </select>
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="rounded-lg border border-slate-300 px-2 py-2 text-sm"
          />
          <button
            disabled={disabled || !storeId || !riderId}
            onClick={() =>
              onRun(async () => {
                const res = await ensureRoute({ storeId, riderId, routeDate: date });
                if (res.ok && res.routeId) {
                  router.push(`/dashboard/courier/reparto?id=${res.routeId}&dia=${date}`);
                }
                return res;
              })
            }
            className="rounded-lg bg-brand-600 px-3 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50"
          >
            Abrir ruta
          </button>
        </div>
      )}
    </Card>
  );
}

/** Alta de acceso web: el motorizado necesita un correo para entrar a /reparto. */
function RidersAccess({
  riders,
  disabled,
  onRun,
}: {
  riders: RiderRow[];
  disabled: boolean;
  onRun: (fn: () => Promise<{ ok: boolean; error?: string; message?: string }>) => void;
}) {
  const [riderId, setRiderId] = useState("");
  const [email, setEmail] = useState("");
  if (!riders.length) return null;

  return (
    <Card className="space-y-2 p-4">
      <h3 className="text-sm font-semibold text-slate-800">Dar acceso a un motorizado</h3>
      <p className="text-xs text-slate-500">
        Con su correo entra a <strong className="text-slate-700">/reparto</strong> con enlace
        mágico, igual que el equipo. Solo ve sus propias rutas, y solo cuando se las entregas.
      </p>
      <div className="flex flex-wrap gap-2">
        <select
          value={riderId}
          onChange={(e) => setRiderId(e.target.value)}
          className="rounded-lg border border-slate-300 px-2 py-2 text-sm"
        >
          <option value="">Elige el motorizado</option>
          {riders.map((r) => (
            <option key={r.id} value={r.id}>
              {r.full_name}
            </option>
          ))}
        </select>
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="correo@ejemplo.com"
          className="w-56 rounded-lg border border-slate-300 px-2 py-2 text-sm"
        />
        <button
          disabled={disabled || !riderId || !email.trim()}
          onClick={() =>
            onRun(async () => {
              const res = await linkRiderAccount(riderId, email);
              if (res.ok) setEmail("");
              return res;
            })
          }
          className="rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-50"
        >
          Dar acceso
        </button>
      </div>
    </Card>
  );
}

function RouteDetail({
  detail,
  assignable,
  retries,
  riderName,
  storeName,
  disabled,
  onRun,
  canReport,
  canAddStops = true,
  compact = false,
  pay = null,
  onExtra,
  closeContext = null,
  canCancelLoads = false,
  onRefresh,
}: {
  /** Cargas de Grupo GF de la ruta: con esto el panel dice qué impide
   *  terminarla antes de pulsar (la misma regla que aplica el cierre). */
  closeContext?: RouteCloseContext | null;
  canCancelLoads?: boolean;
  onRefresh?: () => Promise<void>;
  detail: { route: RouteRow; stops: StopWithOrder[] };
  assignable: Assignable[];
  retries: RetryItem[];
  riderName: string;
  storeName: (id: string | null) => string;
  disabled: boolean;
  onRun: (fn: () => Promise<{ ok: boolean; error?: string; message?: string }>) => void;
  canReport?: boolean;
  canAddStops?: boolean;
  /** Dentro del panel lateral: sin título propio (el panel ya lo lleva). */
  compact?: boolean;
  /** Cálculo del motorizado, para las columnas de tarifa y el saldo. */
  pay?: RiderPayDetail | null;
  /** «+ adicional» en la fila: abre el formulario con ese punto elegido. */
  onExtra?: (stopId: string) => void;
}) {
  const { route, stops } = detail;
  const totals = useMemo(() => routeTotals(stops), [stops]);
  const payRow = useMemo(() => new Map((pay?.snapshot.rows ?? []).map((r) => [r.stop_id, r])), [pay]);
  const snap = pay?.snapshot ?? null;
  const canExtra = !!onExtra && !!pay && !pay.approved && pay.canApprove && !closedStatus(route.status);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState("");

  const planning = route.status === "planificada";
  const closed = route.status === "cerrada";

  // `assignable` es una MUESTRA: los más recientes del pool, que hoy son ~1.800.
  // Filtrar solo en memoria hacía que un pedido fuera de la muestra no
  // apareciera nunca, ni tecleando su código exacto. Así que a partir de dos
  // caracteres la búsqueda se le pregunta al servidor, que mira el pool entero,
  // y mientras tanto se sigue viendo lo que ya está en pantalla.
  const [remoto, setRemoto] = useState<Assignable[] | null>(null);
  const [buscando, setBuscando] = useState(false);
  const termino = filter.trim();

  useEffect(() => {
    if (termino.length < 2) {
      setRemoto(null);
      setBuscando(false);
      return;
    }
    let vigente = true;
    setBuscando(true);
    const t = setTimeout(async () => {
      const res = await searchAssignable(route.route_date, termino);
      // Una respuesta vieja no pisa a una nueva: se teclea más rápido de lo que
      // contesta el servidor.
      if (!vigente) return;
      setRemoto(res.ok ? res.rows : []);
      setBuscando(false);
    }, 300);
    return () => {
      vigente = false;
      clearTimeout(t);
    };
  }, [termino, route.route_date]);

  const enMemoria = assignable.filter((o) => {
    if (!termino) return true;
    const q = termino.toLowerCase();
    return (
      (o.customer_name ?? "").toLowerCase().includes(q) ||
      (o.district ?? "").toLowerCase().includes(q) ||
      (o.order_name ?? "").toLowerCase().includes(q)
    );
  });
  const visible = remoto ?? enMemoria;

  // Lo que impide terminar la ruta, con la MISMA regla que el cierre del
  // servidor (lib/routes.ts): se ve todo a la vez y antes de pulsar. Sin
  // contexto de cargas no se sabe si es de Grupo GF, y el cierre tampoco
  // deja terminarla: el panel lo dice en vez de adivinar.
  const inProgress = route.status === "en_curso";
  const known = closeContext !== null;
  const isGf = closeContext?.isGf ?? false;
  const blockers = useMemo(
    () => (inProgress && closeContext ? routeCloseBlockers({ isGf: closeContext.isGf, openLoads: closeContext.openLoads, stops, routeDate: route.route_date }) : []),
    [inProgress, closeContext, stops, route.route_date],
  );
  const hardBlockers = blockers.filter((b) => !(b.kind === "sin_reportar" && b.forceable));
  const pendingIds = useMemo(() => new Set(stops.filter((s) => s.status === "pendiente").map((s) => s.id)), [stops]);
  // «Falta foto» solo frena el cierre en Grupo GF; fuera de ahí no se marca.
  // Los rechazos de rutas anteriores al 28/09 no la exigen (MOM §29.7).
  const rejectionsNeedPhoto = rejectionNeedsPhoto(route.route_date);
  const missingPhotoIds = useMemo(() => new Set(isGf ? stopsMissingEvidence(stops, route.route_date).map((s) => s.id) : []), [isGf, stops, route.route_date]);
  const exemptRejection = (s: StopWithOrder) => !rejectionsNeedPhoto && s.outcome_reason === "rechazado" && !s.photo_path;
  // Un Yape sin captura no frena el cierre, pero sí aprobar el pago (0162).
  const missingVoucherIds = useMemo(
    () => new Set(stops.filter((s) => s.status === "entregado" && s.payment_method === "yape" && !s.voucher_path).map((s) => s.id)),
    [stops],
  );
  const viewIds: Record<Exclude<StopView, "todas">, Set<string>> = {
    sin_reportar: pendingIds,
    sin_foto: missingPhotoIds,
    sin_captura: missingVoucherIds,
  };
  const [pickedView, setView] = useState<StopView>("todas");
  // Si el filtro se queda vacío (ya se reportó todo), vuelve a «Todas».
  const view: StopView = pickedView !== "todas" && viewIds[pickedView].size === 0 ? "todas" : pickedView;
  const shown = view === "todas" ? stops : stops.filter((s) => viewIds[view].has(s.id));
  const tableId = `paradas-${route.id}`;
  const showView = (next: StopView) => {
    setView(next);
    reveal(tableId);
  };
  // Lo que después frena APROBAR EL PAGO, dicho ya: la tarifa del motorizado y
  // la captura de cada Yape se resuelven mientras la ruta sigue abierta.
  const payNotes: PayNote[] = [];
  if (pay && pay.snapshot.missing > 0) {
    payNotes.push({
      key: "tarifa",
      text: `${plural(pay.snapshot.missing, "punto", "puntos")} sin tarifa de pago para ${riderName}.`,
      action: pay.canConfigure ? { label: "Configurar tarifa", run: openRiderRateForm } : undefined,
    });
  }
  if (missingVoucherIds.size > 0) {
    payNotes.push({
      key: "captura",
      text: `${plural(missingVoucherIds.size, "cobro Yape", "cobros Yape")} sin captura: adjúntala con «Corregir» en «Reportar entregas».`,
      action: { label: "Ver en la tabla", run: () => showView("sin_captura") },
    });
  }
  const views: { key: StopView; label: string; count: number }[] = [
    { key: "todas", label: "Todas", count: stops.length },
    { key: "sin_reportar", label: "Sin reportar", count: pendingIds.size },
    { key: "sin_foto", label: "Sin foto", count: missingPhotoIds.size },
    { key: "sin_captura", label: "Yape sin captura", count: missingVoucherIds.size },
  ];

  return (
    <div className={cn("space-y-5", !compact && "rounded-2xl border border-slate-200 bg-white p-4 shadow-sm")}>
      {!compact && (
        <h3 className="text-sm font-semibold text-slate-800">
          {riderName} · {route.route_date}
        </h3>
      )}

      {planning && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 px-4 py-3">
          <p className="text-sm text-slate-600">La ruta se está armando: el motorizado todavía no la ve.</p>
          <button
            disabled={disabled || !stops.length}
            onClick={() => onRun(() => startRoute(route.id))}
            className={BTN_PRIMARY}
          >
            Entregar la ruta
          </button>
        </div>
      )}

      {inProgress && (
        <RouteClosePanel
          routeId={route.id}
          known={known}
          isGf={isGf}
          blockers={blockers}
          hardBlockers={hardBlockers}
          payNotes={payNotes}
          canReport={!!canReport}
          canCancelLoads={canCancelLoads}
          disabled={disabled}
          onRun={onRun}
          onRefresh={onRefresh}
          onShowView={showView}
          rejectionsNeedPhoto={rejectionsNeedPhoto}
          exemptRejections={stops.filter(exemptRejection).length}
        />
      )}

      {closed && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 px-4 py-3">
          <p className="text-sm text-slate-600">
            Ruta cerrada. Su liquidación está en{" "}
            <a href="/dashboard/liquidaciones" className="font-medium text-brand-700 underline underline-offset-2">
              Liquidaciones
            </a>
            , ya con todas las líneas vinculadas.
          </p>
          <button
            type="button"
            disabled={disabled}
            onClick={() => { if (window.confirm("¿Reabrir la ruta? Se descarta su liquidación en borrador; al volver a terminarla se crea de nuevo.")) onRun(() => reopenRoute(route.id)); }}
            className={BTN_SECONDARY}
            title="Solo mientras la liquidación siga en borrador y el cálculo diario no esté aprobado"
          >
            Reabrir ruta
          </button>
        </div>
      )}

      {/* Una sola fila de métricas: lo operativo (paradas y cobros) y lo del
          pago del motorizado (ganancia y saldo), sin repetirlo más abajo. En
          tres columnas y sin recortar: en seis no cabían en el panel. */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        <Tile label="Paradas" value={String(totals.total)} sub={`${totals.entregados} entregadas · ${totals.noEntregados} no entregadas · ${totals.pendientes} sin reportar`} />
        <Tile label="Efectivo en manos" value={money(totals.efectivo)} />
        <Tile label="Yape / POS" value={`${money(totals.yape)} / ${money(totals.pos)}`} />
        <Tile label="Ganancia base" value={snap ? (snap.missing ? "Sin tarifa" : money(snap.base)) : "…"} sub={snap?.missing ? `${plural(snap.missing, "punto", "puntos")} sin tarifa` : undefined} warn={!!snap?.missing} />
        <Tile label="Adicionales" value={snap ? money(snap.extra) : "…"} />
        <Tile
          label={snap ? riderPayBalanceLabel(snap.net_cash) : "Saldo"}
          value={snap ? (snap.net_cash === null ? "—" : money(Math.abs(snap.net_cash))) : "…"}
          highlight
          hint={RIDER_PAY_BALANCE_HINT}
        />
      </div>

      <section id={tableId} aria-label="Paradas de la ruta" className="scroll-mt-24 space-y-2">
        {views.some((v) => v.key !== "todas" && v.count > 0) && (
          <div role="group" aria-label="Filtrar paradas" className="flex flex-wrap gap-1.5">
            {views.filter((v) => v.key === "todas" || v.count > 0).map((v) => (
              <button
                key={v.key}
                type="button"
                aria-pressed={view === v.key}
                onClick={() => setView(v.key)}
                className={cn(
                  "inline-flex min-h-9 items-center gap-1.5 rounded-full border px-3 text-sm font-medium",
                  view === v.key ? "border-slate-900 bg-slate-900 text-white" : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50",
                )}
              >
                {v.label}
                <span className={cn("tabular-nums", view === v.key ? "text-slate-300" : "text-slate-500")}>{v.count}</span>
              </button>
            ))}
          </div>
        )}

        {/* En el teléfono, una lista: la tabla escondía el resultado y la
            foto detrás del scroll horizontal, que es justo lo que se revisa. */}
        <ul className="divide-y divide-slate-100 border-y border-slate-200 sm:hidden">
          {shown.map((s) => (
            <li key={s.id} className="space-y-1.5 py-3">
              <div className="flex items-start justify-between gap-3">
                <p className="min-w-0 font-medium text-slate-900">
                  <span className="mr-1.5 text-xs tabular-nums text-slate-400">{s.seq}</span>
                  {s.order?.customer_name ?? "—"}
                </p>
                <StopEarnings stop={s} row={payRow.get(s.id)} pay={pay} onExtra={canExtra ? onExtra : undefined} />
              </div>
              <p className="text-xs text-slate-500">
                {s.order?.name ? <OrderLink orderId={s.order_id} className="text-slate-700 underline decoration-slate-300 underline-offset-2 hover:text-brand-700" title="Abrir la ficha del pedido">{s.order.name}</OrderLink> : "—"}
                {" · "}<span className="tabular-nums">{s.order?.total == null ? "—" : money(s.order.total)}</span>
                {" · "}{s.order?.district ?? "—"} · {storeName(s.store_id)}
              </p>
              <StopResult stop={s} />
              {(s.status === "entregado" || s.photo_path || s.voucher_path) && (
                <StopCollection stop={s} needsPhoto={missingPhotoIds.has(s.id)} needsVoucher={missingVoucherIds.has(s.id)} exempt={exemptRejection(s)} />
              )}
              {planning && (
                <button
                  disabled={disabled}
                  onClick={() => onRun(() => removeStop(s.id))}
                  className="text-xs text-slate-500 underline hover:text-red-600 disabled:opacity-50"
                >
                  Quitar
                </button>
              )}
            </li>
          ))}
          {stops.length === 0 && (
            <li className="py-6 text-center text-sm text-slate-500">
              {canAddStops ? "Esta ruta no tiene paradas. Añádelas abajo." : "Esta ruta no tiene paradas."}
            </li>
          )}
        </ul>

        {/* Tabla única de paradas: en el panel cabe entera; en pantallas
            medianas se desplaza en horizontal con el cliente fijo a la izquierda. */}
        <div className="hidden overflow-x-auto sm:block">
          <table className="w-full min-w-[840px] text-sm">
            <thead className="border-b border-slate-200 text-left text-xs text-slate-500">
              <tr>
                <th className="sticky left-0 z-[1] bg-white px-2.5 py-2 font-medium">Cliente</th>
                <th className="px-2.5 py-2 font-medium">Pedido</th>
                <th className="px-2.5 py-2 font-medium">Distrito</th>
                <th className="px-2.5 py-2 font-medium">Resultado</th>
                <th className="px-2.5 py-2 font-medium">Cobro y respaldo</th>
                <th className="px-2.5 py-2 text-right font-medium">Ganancia</th>
                {planning && <th className="px-2.5 py-2 font-medium"><span className="sr-only">Acciones</span></th>}
              </tr>
            </thead>
            <tbody>
              {shown.map((s) => (
                <tr key={s.id} className="group border-b border-slate-100 align-top hover:bg-slate-50">
                  <td className="sticky left-0 z-[1] bg-white px-2.5 py-2.5 text-slate-800 group-hover:bg-slate-50">
                    <div className="flex min-w-[8rem] gap-2">
                      <span className="w-4 shrink-0 text-right text-xs leading-5 tabular-nums text-slate-400">{s.seq}</span>
                      <span>{s.order?.customer_name ?? "—"}</span>
                    </div>
                  </td>
                  <td className="whitespace-nowrap px-2.5 py-2.5">
                    {s.order?.name ? <OrderLink orderId={s.order_id} className="text-slate-700 underline decoration-slate-300 underline-offset-2 hover:text-brand-700" title="Abrir la ficha del pedido">{s.order.name}</OrderLink> : "—"}
                    <p className="text-xs tabular-nums text-slate-500">{s.order?.total == null ? "—" : money(s.order.total)}</p>
                  </td>
                  <td className="px-2.5 py-2.5">
                    <p className="min-w-[6rem] text-slate-700">{s.order?.district ?? "—"}</p>
                    <p className="text-xs text-slate-500">{storeName(s.store_id)}</p>
                  </td>
                  <td className="px-2.5 py-2.5">
                    <div className="min-w-[7.5rem]"><StopResult stop={s} /></div>
                  </td>
                  <td className="px-2.5 py-2.5">
                    <div className="min-w-[10rem]">
                      <StopCollection stop={s} needsPhoto={missingPhotoIds.has(s.id)} needsVoucher={missingVoucherIds.has(s.id)} exempt={exemptRejection(s)} />
                    </div>
                  </td>
                  <td className="px-2.5 py-2.5 text-right">
                    <StopEarnings stop={s} row={payRow.get(s.id)} pay={pay} onExtra={canExtra ? onExtra : undefined} />
                  </td>
                  {planning && (
                    <td className="px-2.5 py-2.5 text-right">
                      <button
                        disabled={disabled}
                        onClick={() => onRun(() => removeStop(s.id))}
                        className="text-xs text-slate-500 underline hover:text-red-600 disabled:opacity-50"
                      >
                        Quitar
                      </button>
                    </td>
                  )}
                </tr>
              ))}
              {stops.length === 0 && (
                <tr>
                  <td colSpan={planning ? 7 : 6} className="px-3 py-6 text-center text-sm text-slate-500">
                    {canAddStops ? "Esta ruta no tiene paradas. Añádelas abajo." : "Esta ruta no tiene paradas."}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {!closed && canAddStops && retries.length > 0 && (
        <RetryPanel
          retries={retries}
          storeName={storeName}
          disabled={disabled}
          onAdd={(ids) => onRun(() => addStops(route.id, ids))}
        />
      )}

      {!closed && canAddStops && (
        <div className="space-y-2 border-t border-slate-100 pt-3">
          <div className="flex flex-wrap items-center gap-2">
            <h4 className="text-sm font-medium text-slate-700">Añadir paradas nuevas</h4>
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Buscar por cliente, distrito o pedido (ej. KP131277)"
              className="flex-1 rounded-lg border border-slate-300 px-2 py-1.5 text-sm"
            />
            <button
              disabled={disabled || picked.size === 0}
              onClick={() =>
                onRun(async () => {
                  const res = await addStops(route.id, [...picked]);
                  if (res.ok) setPicked(new Set());
                  return res;
                })
              }
              className="rounded-lg bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50"
            >
              Añadir {picked.size > 0 ? `(${picked.size})` : ""}
            </button>
          </div>
          {!termino && assignable.length >= 300 && (
            // Decir que la lista está recortada, en vez de que parezca completa.
            <p className="text-xs text-slate-500">
              Se muestran los {assignable.length} más recientes. Escribe para buscar entre
              todos los pedidos listos para asignar.
            </p>
          )}
          <div className="max-h-72 overflow-y-auto rounded-lg border border-slate-200">
            {visible.length === 0 && (
              <p className="p-4 text-center text-sm text-slate-500">
                {buscando
                  ? "Buscando…"
                  : termino
                    ? `Ningún pedido listo para asignar coincide con «${termino}».`
                    : "No hay pedidos sin asignar para ese día."}
              </p>
            )}
            {visible.map((o) => (
              <label
                key={o.order_id}
                className="flex cursor-pointer items-center gap-2 border-b border-slate-100 px-3 py-2 text-sm last:border-0 hover:bg-slate-50"
              >
                <input
                  type="checkbox"
                  checked={picked.has(o.order_id)}
                  onChange={(e) => {
                    const next = new Set(picked);
                    if (e.target.checked) next.add(o.order_id);
                    else next.delete(o.order_id);
                    setPicked(next);
                  }}
                />
                <span className="flex-1 truncate text-slate-700">
                  {o.customer_name ?? "Sin nombre"}
                  <span className="ml-1.5 text-xs text-slate-400">
                    {storeName(o.store_id)} · {o.district ?? "—"} · {o.order_name ? <OrderLink orderId={o.order_id} className="text-slate-500 underline decoration-slate-300 hover:text-brand-700" title="Abrir la ficha del pedido">{o.order_name}</OrderLink> : "—"}
                  </span>
                </span>
                <span className="text-slate-600">{money(o.order_total)}</span>
              </label>
            ))}
          </div>
        </div>
      )}

    </div>
  );
}

/** Resultado de la parada: entregada, no entregada (con motivo) o sin reportar. */
function StopResult({ stop: s }: { stop: StopWithOrder }) {
  return (
    <div className="space-y-1">
      {s.status === "pendiente" ? (
        <span className="inline-flex rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-900">Sin reportar</span>
      ) : s.status === "entregado" ? (
        <p className="text-xs font-semibold text-emerald-700">Entregado</p>
      ) : (
        <div className="text-xs">
          <p className="font-semibold text-red-700">No entregado</p>
          <p className="text-slate-600">{reasonLabel(s.outcome_reason)}</p>
        </div>
      )}
      {/* Todo no entregado vuelve físicamente a la oficina (0188/0189). */}
      {s.status === "no_entregado" && s.dispatch_manifest_id && (
        s.returned_at
          ? <p><span className="whitespace-nowrap rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-semibold text-emerald-800" title={`Recibido en oficina el ${new Date(s.returned_at).toLocaleString("es-PE", { timeZone: "America/Lima" })}`}>Devuelto · {new Date(s.returned_at).toLocaleString("es-PE", { timeZone: "America/Lima", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}</span></p>
          : <p><span className="whitespace-nowrap rounded-full bg-red-100 px-2 py-0.5 text-[11px] font-semibold text-red-800">Por devolver</span></p>
      )}
      {s.note && <p className="text-xs text-slate-500">{s.note}</p>}
    </div>
  );
}

/**
 * Cobro y respaldo: cómo y cuánto cobró, y su foto y comprobante (cada uno abre
 * en grande en otra pestaña, GET /api/reparto/foto), o lo que falta.
 */
function StopCollection({ stop: s, needsPhoto, needsVoucher, exempt = false }: {
  stop: StopWithOrder;
  needsPhoto: boolean;
  needsVoucher: boolean;
  /** Rechazo sin foto de una ruta anterior al 28/09: no se exige (MOM §29.7). */
  exempt?: boolean;
}) {
  return (
    <div className="space-y-1.5">
      <p className="whitespace-nowrap text-slate-700">
        {s.status === "entregado" ? <>{methodLabel(s.payment_method)} · <span className="tabular-nums">{money(s.collected_amount)}</span></> : <span className="text-slate-400">—</span>}
      </p>
      {(s.photo_path || s.voucher_path || needsPhoto || needsVoucher) && (
        <div className="flex flex-wrap items-center gap-1">
          {s.photo_path && (
            <a href={`/api/reparto/foto?path=${encodeURIComponent(s.photo_path)}`} target="_blank" rel="noreferrer" title="Ver la foto en otra pestaña" className={EVIDENCE_LINK}>
              <IconCamera aria-hidden="true" className="h-3.5 w-3.5" />Foto
            </a>
          )}
          {s.voucher_path && (
            <a href={`/api/reparto/foto?path=${encodeURIComponent(s.voucher_path)}`} target="_blank" rel="noreferrer" title="Ver el comprobante de pago en otra pestaña" className={EVIDENCE_LINK}>
              <IconReceipt aria-hidden="true" className="h-3.5 w-3.5" />{s.payment_method === "yape" ? "Captura" : "Voucher"}
            </a>
          )}
          {(needsPhoto || needsVoucher) && (
            <span className={MISSING_CHIP}>
              {needsPhoto ? <IconCamera aria-hidden="true" className="h-3.5 w-3.5" /> : <IconReceipt aria-hidden="true" className="h-3.5 w-3.5" />}
              {needsPhoto && needsVoucher ? "Falta foto y captura" : needsPhoto ? "Falta foto" : "Falta captura"}
            </span>
          )}
        </div>
      )}
      {exempt && (
        <p className="text-xs text-slate-500" title="Hasta el 27/09 el teléfono no pedía foto al rechazar: esos rechazos no la exigen para cerrar ni para pagar (MOM §29.7).">
          Sin foto · no se exige (antes del 28/09)
        </p>
      )}
    </div>
  );
}

/**
 * Ganancia del motorizado por el punto y de dónde sale: tarifa (del distrito o
 * general) más adicional, y aviso si no cuadra con las tarifas registradas
 * (MOM §29.9). Solo existe con la parada reportada (entregada o rechazada):
 * antes no es S/ 0,00, es «todavía no». Sin tarifa personal vigente se dice,
 * para que se configure.
 */
function StopEarnings({ stop: s, row: pr, pay, onExtra }: {
  stop: StopWithOrder;
  row: RiderPayDetail["snapshot"]["rows"][number] | undefined;
  pay: RiderPayDetail | null;
  /** «+ adicional»: abre el formulario con este punto elegido. */
  onExtra?: (stopId: string) => void;
}) {
  const check = pr && pay ? checkStopRate(pr, pay.rates, pay.snapshot.day) : null;
  // Qué se muestra lo decide `stopEarnings` (lib/rider-pay.ts): un no entregado
  // que no es rechazo dice «No se paga», no «Sin tarifa» (MOM §29.10).
  const state = pr ? stopEarnings(s, pr) : null;
  const earned = state?.kind === "ganada" ? state.base : null;
  const noRateTitle = "Configura la tarifa del motorizado en «Tarifa de …», abajo";
  return (
    <div className="ml-auto min-w-[6.5rem] shrink-0 space-y-0.5 text-right">
      {!pr || !state ? <span className="text-slate-400">—</span>
        : earned !== null ? <p className="font-semibold tabular-nums text-slate-900">{money(earned + pr.extra)}</p>
        : state.kind === "no_se_paga"
          ? (pr.extra ? <p className="font-semibold tabular-nums text-slate-900">{money(pr.extra)}</p> : <p className="text-xs font-medium text-slate-600">No se paga</p>)
        : state.kind === "sin_tarifa" ? <p className="text-xs font-medium text-amber-800" title={noRateTitle}>Sin tarifa</p>
        : <span className="text-slate-400">—</span>}
      {pr && earned !== null && (
        <p className="whitespace-nowrap text-xs tabular-nums text-slate-500">
          Tarifa {money(earned)}{check?.source ? ` · ${check.source === "distrito" ? "distrito" : "general"}` : ""}
        </p>
      )}
      {state?.kind === "no_se_paga" && (
        <p className={cn("text-xs text-slate-500", !pr?.extra && "whitespace-nowrap")}>{pr?.extra ? "El punto no se paga: " : ""}solo entrega o rechazo</p>
      )}
      {state?.kind === "pendiente" && (state.rate != null
        ? <p className="whitespace-nowrap text-xs tabular-nums text-slate-500">{money(state.rate)} al reportar</p>
        : <p className="text-xs font-medium text-amber-800" title={noRateTitle}>Sin tarifa</p>)}
      {pr && pr.extra ? <p className="whitespace-nowrap text-xs tabular-nums text-slate-500">Adicional {money(pr.extra)}</p> : null}
      {check?.warning && state?.kind !== "no_se_paga" && (
        <p className="flex items-start justify-end gap-1 text-left text-xs leading-snug text-amber-800" title={check.warning}>
          <IconAlert aria-hidden="true" className="mt-px h-3.5 w-3.5 shrink-0" />
          <span className="max-w-[13rem]">{check.warning}</span>
        </p>
      )}
      {onExtra && s.status !== "pendiente" && (
        <button type="button" onClick={() => onExtra(s.id)} className="min-h-0 text-xs font-medium text-brand-700 underline-offset-2 hover:underline" title="Aprobar un adicional para este punto">+ adicional</button>
      )}
    </div>
  );
}

function closedStatus(status: string): boolean {
  return status === "cerrada";
}

// Botones del panel: uno por jerarquía, para que «Terminar» se distinga de sus arreglos.
const BTN = "inline-flex min-h-10 items-center justify-center gap-1.5 rounded-lg px-3.5 text-sm font-medium whitespace-nowrap disabled:cursor-not-allowed disabled:opacity-50";
const BTN_PRIMARY = cn(BTN, "bg-slate-900 font-semibold text-white hover:bg-slate-800");
const BTN_SECONDARY = cn(BTN, "border border-slate-300 bg-white text-slate-700 hover:border-slate-400 hover:bg-slate-50");
const BTN_DANGER = cn(BTN, "bg-red-600 font-semibold text-white hover:bg-red-700");
const BTN_LINK = "min-h-0 text-sm font-medium text-brand-700 underline decoration-brand-200 underline-offset-2 hover:decoration-brand-700 disabled:opacity-50";
// Respaldo de la parada: enlace a la foto o al comprobante, o lo que falta.
const EVIDENCE_LINK = "inline-flex min-h-8 items-center gap-1 rounded-md border border-slate-200 bg-white px-1.5 text-xs font-medium text-slate-600 hover:border-slate-300 hover:text-slate-900 pointer-coarse:min-h-11";
const MISSING_CHIP = "inline-flex items-center gap-1 whitespace-nowrap rounded-md bg-amber-100 px-1.5 py-1 text-xs font-semibold text-amber-900";

function Tile({ label, value, sub, hint, highlight, warn }: { label: string; value: string; sub?: string; hint?: string; highlight?: boolean; warn?: boolean }) {
  return (
    <div className={cn("min-w-0 rounded-lg border px-3 py-2.5", highlight ? "border-slate-900 bg-slate-900 text-white" : "border-slate-200 bg-white")}>
      <p className={cn("flex items-start gap-1 text-xs leading-snug", highlight ? "text-slate-300" : "text-slate-500")}>
        <span>{label}</span>
        {hint && <Hint text={hint} className={highlight ? "text-slate-300" : undefined} />}
      </p>
      <p className={cn("mt-1 text-base font-semibold leading-tight tabular-nums", highlight ? "text-white" : warn ? "text-amber-800" : "text-slate-900")}>{value.replaceAll("S/ ", "S/ ")}</p>
      {sub && <p className={cn("mt-1 text-xs leading-snug", highlight ? "text-slate-300" : warn ? "text-amber-800" : "text-slate-500")}>{sub}</p>}
    </div>
  );
}

interface PayNote {
  key: string;
  text: string;
  action?: { label: string; run: () => void };
}

/**
 * «Para terminar la ruta»: lo que el cierre va a rechazar, TODO a la vez, con
 * su arreglo al lado y el botón de terminar en el mismo sitio. Antes el
 * coordinador pulsaba «Terminar ruta operativa», leía UN error, lo arreglaba y
 * volvía a pulsar para descubrir el siguiente (Roy, 19/09: 8 sin reportar, 8
 * sin foto y 7 Yape sin captura, de a uno). La lista sale de la misma regla que
 * aplica el servidor (`routeCloseBlockers`), así que el botón se habilita justo
 * cuando el cierre va a pasar.
 */
function RouteClosePanel({
  routeId,
  known,
  isGf,
  blockers,
  hardBlockers,
  payNotes,
  canReport,
  canCancelLoads,
  disabled,
  onRun,
  onRefresh,
  onShowView,
  rejectionsNeedPhoto,
  exemptRejections,
}: {
  routeId: string;
  /** Se pudieron leer las cargas; sin eso el cierre tampoco pasa. */
  known: boolean;
  isGf: boolean;
  blockers: RouteCloseBlocker[];
  /** Los que no se pueden forzar. */
  hardBlockers: RouteCloseBlocker[];
  payNotes: PayNote[];
  canReport: boolean;
  canCancelLoads: boolean;
  disabled: boolean;
  onRun: RunAction;
  onRefresh?: () => Promise<void>;
  onShowView: (view: StopView) => void;
  /** La ruta es del 28/09 o después: sus rechazos también exigen foto. */
  rejectionsNeedPhoto: boolean;
  /** Rechazos sin foto que no la exigen (ruta anterior al 28/09). */
  exemptRejections: number;
}) {
  const headingId = useId();
  const summaryId = useId();
  const [checking, setChecking] = useState(false);
  const ready = known && blockers.length === 0;
  const forceable = blockers.find((b) => b.kind === "sin_reportar" && b.forceable);
  const canForce = known && hardBlockers.length === 0 && !!forceable;
  // Cada carga abierta cuenta como un pendiente por sí sola.
  const pendientes = blockers.reduce((n, b) => n + (b.kind === "carga_sin_recibir" ? b.loads.length : 1), 0);
  const summary = !known
    ? "No se pudieron leer las cargas de Grupo GF de esta ruta, y sin eso no se puede terminar."
    : ready
      ? isGf && exemptRejections > 0
        ? "Todo reportado; los rechazos antes del 28/09 no exigen foto. Al terminarla se crea la liquidación de cada tienda."
        : `Todas las paradas tienen su reporte${isGf ? " y su foto" : ""}. Al terminarla se crea la liquidación de cada tienda.`
      : canForce
        ? "Quedan paradas sin reportar: espera a que las reporte o ciérrala igual."
        : `Falta resolver ${plural(pendientes, "cosa", "cosas")} antes de terminarla.`;

  const recheck = async () => {
    if (!onRefresh) return;
    setChecking(true);
    try {
      await onRefresh();
    } finally {
      setChecking(false);
    }
  };

  return (
    <section aria-labelledby={headingId} className={cn("overflow-hidden rounded-xl border", ready ? "border-emerald-200" : "border-amber-200")}>
      <div className={cn("flex flex-wrap items-start justify-between gap-x-4 gap-y-3 px-4 py-3.5", ready ? "bg-emerald-50" : "bg-amber-50")}>
        <div className="flex min-w-0 flex-1 basis-72 gap-2.5">
          {ready
            ? <IconCheckCircle aria-hidden="true" className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600" />
            : <IconAlert aria-hidden="true" className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" />}
          <div className="min-w-0">
            <h3 id={headingId} className="text-sm font-semibold text-slate-900">{ready ? "Lista para terminar" : "Para terminar la ruta"}</h3>
            <p id={summaryId} className={cn("mt-0.5 text-sm", ready ? "text-emerald-900" : "text-amber-900")}>{summary}</p>
          </div>
        </div>
        <div className="grid w-full grid-cols-2 gap-2 sm:flex sm:w-auto sm:flex-wrap sm:items-center">
          {!ready && onRefresh && (
            <button type="button" onClick={recheck} disabled={checking || disabled} className={BTN_SECONDARY} aria-live="polite">
              {checking ? "Comprobando…" : "Volver a comprobar"}
            </button>
          )}
          {canReport && (
            <a href={`/reparto?ruta=${routeId}&modo=coordinacion`} className={cn(BTN_SECONDARY, "pointer-coarse:min-h-11", (ready || !onRefresh) && "col-span-2")}>
              Reportar entregas
            </a>
          )}
          <button
            type="button"
            disabled={disabled || !ready}
            aria-describedby={summaryId}
            onClick={() => onRun(() => closeRoute(routeId))}
            className={cn(BTN_PRIMARY, "col-span-2")}
          >
            Terminar ruta operativa
          </button>
        </div>
      </div>

      {blockers.length > 0 && (
        <ul className="divide-y divide-slate-100 border-t border-amber-200 bg-white">
          {blockers.map((b) => {
            switch (b.kind) {
              case "carga_sin_recibir":
                return b.loads.map((load) => (
                  <LoadBlockerRow key={load.id} load={load} canCancel={canCancelLoads} disabled={disabled} onRun={onRun} />
                ));
              case "sin_paradas":
                return (
                  <BlockerRow
                    key="sin_paradas"
                    icon={<IconAlert aria-hidden="true" className="h-4 w-4" />}
                    title="La ruta no tiene paradas"
                    detail="No hay nada que terminar ni liquidar."
                  />
                );
              case "sin_reportar":
                return (
                  <BlockerRow
                    key="sin_reportar"
                    icon={<IconClock aria-hidden="true" className="h-4 w-4" />}
                    title={`${plural(b.stops.length, "parada", "paradas")} sin reportar`}
                    detail={b.forceable
                      ? "Espera a que las reporte, o ciérrala igual: esas paradas no entran en la liquidación."
                      : "En Grupo GF no se cierra sin el reporte de cada parada."}
                    orders={orderNames(b.stops)}
                    actions={<>
                      <button type="button" onClick={() => onShowView("sin_reportar")} className={BTN_LINK}>Ver en la tabla</button>
                      {canForce && (
                        <button
                          type="button"
                          disabled={disabled}
                          onClick={() => {
                            if (!confirm(`Quedan ${plural(b.stops.length, "parada", "paradas")} sin reportar. Se cerrará igual y esas paradas no entrarán en la liquidación. ¿Seguro?`)) return;
                            onRun(() => closeRoute(routeId, { force: true }));
                          }}
                          className="min-h-0 text-sm font-medium text-red-700 underline underline-offset-2 hover:text-red-800 disabled:opacity-50"
                        >
                          Cerrar con paradas sin reportar
                        </button>
                      )}
                    </>}
                  />
                );
              case "sin_foto":
                return (
                  <BlockerRow
                    key="sin_foto"
                    icon={<IconCamera aria-hidden="true" className="h-4 w-4" />}
                    title={`${plural(b.stops.length, "parada", "paradas")} sin foto`}
                    detail={rejectionsNeedPhoto
                      ? "Cada entrega y cada rechazo llevan su foto: adjúntala con «Corregir» en «Reportar entregas»."
                      : "Cada entrega lleva su foto: adjúntala con «Corregir» en «Reportar entregas». Los rechazos de esta ruta no la exigen (antes del 28/09)."}
                    orders={orderNames(b.stops)}
                    actions={<button type="button" onClick={() => onShowView("sin_foto")} className={BTN_LINK}>Ver en la tabla</button>}
                  />
                );
            }
          })}
        </ul>
      )}

      {payNotes.length > 0 && (
        <div className="border-t border-slate-200 bg-white px-4 py-3">
          <h4 className="text-sm font-medium text-slate-800">Para aprobar el pago, después</h4>
          <ul className="mt-1.5 space-y-1.5">
            {payNotes.map((note) => (
              <li key={note.key} className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-sm text-slate-600">
                <span>{note.text}</span>
                {note.action && <button type="button" onClick={note.action.run} className={BTN_LINK}>{note.action.label}</button>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

/** Una fila de «Para terminar la ruta»: qué pasa, con qué pedidos y su arreglo. */
function BlockerRow({ icon, title, detail, orders, actions, below }: {
  icon: ReactNode;
  title: string;
  detail: string;
  orders?: string;
  actions?: ReactNode;
  below?: ReactNode;
}) {
  return (
    <li className="grid grid-cols-[1rem_minmax(0,1fr)] gap-x-3 gap-y-2 px-4 py-3 sm:grid-cols-[1rem_minmax(0,1fr)_auto]">
      <span className="pt-0.5 text-amber-600">{icon}</span>
      <div className="min-w-0">
        <p className="text-sm font-semibold text-slate-900">{title}</p>
        <p className="text-sm text-slate-600">{detail}</p>
        {orders && <p className="mt-1 text-xs text-slate-500">{orders}</p>}
      </div>
      {actions && <div className="col-start-2 flex flex-wrap items-center gap-x-4 gap-y-2 sm:col-start-3 sm:justify-end sm:self-center">{actions}</div>}
      {below && <div className="col-start-2 sm:col-end-4">{below}</div>}
    </li>
  );
}

/**
 * Una carga sin recibir. Vacía: se cancela aquí mismo con motivo (lo que antes
 * obligaba a ir a Despacho); con paquetes: la recibe el motorizado o se abre
 * la caja para retirar lo que no va.
 */
function LoadBlockerRow({ load, canCancel, disabled, onRun }: { load: OpenLoad; canCancel: boolean; disabled: boolean; onRun: RunAction }) {
  const [cancelling, setCancelling] = useState(false);
  const [reason, setReason] = useState("");
  const inputId = useId();
  const empty = load.items === 0;
  const valid = reason.trim().length >= 3;
  return (
    <BlockerRow
      icon={<IconTruck aria-hidden="true" className="h-4 w-4" />}
      title={empty
        ? `Carga ${load.load_number} abierta y vacía`
        : `Carga ${load.load_number}: ${plural(load.items, "paquete", "paquetes")} sin recibir`}
      detail={empty
        ? canCancel
          ? "No lleva paquetes: cancélala con un motivo y la ruta queda libre para terminar."
          : "No lleva paquetes: pide a quien arma las cajas que la cancele con un motivo."
        : "Que el motorizado la reciba desde su teléfono, o retira desde la caja los paquetes que no van."}
      actions={empty
        ? canCancel && !cancelling && (
          <button type="button" onClick={() => setCancelling(true)} disabled={disabled} className={BTN_SECONDARY}>
            Cancelar carga {load.load_number}
          </button>
        )
        : (
          <a href={courierBoxHref(load.id)} onClick={(e) => openBoxInPlace(e, load.id)} className={cn(BTN_SECONDARY, "pointer-coarse:min-h-11")}>
            Abrir la caja
          </a>
        )}
      below={empty && canCancel && cancelling && (
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (!valid) return;
            onRun(async () => {
              const res = await cancelDispatchManifest(load.id, reason);
              return res.error ? { ok: false, error: res.error } : { ok: true, message: `Carga ${load.load_number} cancelada.` };
            });
          }}
        >
          <label htmlFor={inputId} className="grid min-w-0 flex-1 basis-60 gap-1 text-xs font-medium text-slate-600">
            Motivo de la cancelación
            <input
              id={inputId}
              autoFocus
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              minLength={3}
              required
              placeholder="Ej. se abrió por error"
              className="min-h-10 rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-900 placeholder:text-slate-500"
            />
          </label>
          <button type="submit" disabled={disabled || !valid} className={BTN_DANGER}>Cancelar carga</button>
          <button type="button" onClick={() => { setCancelling(false); setReason(""); }} className={cn(BTN, "text-slate-600 hover:bg-slate-100")}>Volver</button>
        </form>
      )}
    />
  );
}

/**
 * Los que ya se intentaron y no llegaron. Es la pantalla que ataca la tasa de
 * entrega: sin esto, un pedido que ayer no contestó se queda esperando a que
 * alguien se acuerde, y nadie se acuerda.
 *
 * Lo bloqueado y lo de riesgo alto salen arriba, con el motivo escrito, para que
 * la decisión se tome mirando y no adivinando. Nada se despacha solo.
 */
function RetryPanel({
  retries,
  storeName,
  disabled,
  onAdd,
}: {
  retries: RetryItem[];
  storeName: (id: string | null) => string;
  disabled: boolean;
  onAdd: (orderIds: string[]) => void;
}) {
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [showBlocked, setShowBlocked] = useState(false);

  const visible = showBlocked ? retries : retries.filter((r) => r.risk.retryable);
  const blocked = retries.length - retries.filter((r) => r.risk.retryable).length;
  const sanos = retries.filter((r) => r.risk.retryable && r.risk.level === "ok");

  return (
    <div className="space-y-2 border-t border-slate-100 pt-3">
      <div className="flex flex-wrap items-center gap-2">
        <h4 className="text-sm font-medium text-slate-700">
          Reintentos pendientes ({retries.length})
        </h4>
        {sanos.length > 0 && (
          <button
            disabled={disabled}
            onClick={() => onAdd(sanos.map((r) => r.order_id))}
            className="rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
            title="Añade los que no tienen nada raro; los marcados los decides tú"
          >
            Traer los {sanos.length} sin pendientes
          </button>
        )}
        <button
          disabled={disabled || picked.size === 0}
          onClick={() => {
            onAdd([...picked]);
            setPicked(new Set());
          }}
          className="rounded-lg bg-brand-600 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-brand-700 disabled:opacity-50"
        >
          Añadir seleccionados {picked.size > 0 ? `(${picked.size})` : ""}
        </button>
        {blocked > 0 && (
          <button
            onClick={() => setShowBlocked(!showBlocked)}
            className="ml-auto text-xs text-slate-500 underline hover:text-slate-700"
          >
            {showBlocked ? "Ocultar" : `Ver ${blocked} que no se pueden reintentar tal cual`}
          </button>
        )}
      </div>

      <div className="max-h-80 overflow-y-auto rounded-lg border border-slate-200">
        {visible.map((r) => (
          <div
            key={r.order_id}
            className="flex items-start gap-2 border-b border-slate-100 px-3 py-2 text-sm last:border-0"
          >
            <input
              type="checkbox"
              className="mt-1"
              disabled={!r.risk.retryable}
              checked={picked.has(r.order_id)}
              onChange={(e) => {
                const next = new Set(picked);
                if (e.target.checked) next.add(r.order_id);
                else next.delete(r.order_id);
                setPicked(next);
              }}
            />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="truncate font-medium text-slate-800">
                  {r.customer_name ?? "Sin nombre"}
                </span>
                <span
                  className={cn(
                    "rounded-full px-1.5 py-0.5 text-[11px] font-medium",
                    RISK_STYLE[r.risk.level],
                  )}
                >
                  {RISK_LABELS[r.risk.level]}
                </span>
                <span className="text-xs text-slate-400">
                  {storeName(r.store_id)} · {r.district ?? "—"} · {r.order_name ? <OrderLink orderId={r.order_id} className="text-slate-500 underline decoration-slate-300 hover:text-brand-700" title="Abrir la ficha del pedido">{r.order_name}</OrderLink> : "—"}
                </span>
              </div>
              <p className="text-[11px] text-slate-500">
                {r.attempts} intento(s) · último: {reasonLabel(r.lastReason)}
                {r.lastTriedAt && ` · ${r.lastTriedAt.slice(0, 10)}`}
              </p>
              {r.risk.level !== "ok" && (
                <p className="text-[11px] text-slate-500">{r.risk.reasons.join(" ")}</p>
              )}
            </div>
            <span className="shrink-0 text-slate-600">{money(r.order_total)}</span>
          </div>
        ))}
        {visible.length === 0 && (
          <p className="p-4 text-center text-sm text-slate-500">
            Nada que reintentar ahora mismo.
          </p>
        )}
      </div>
    </div>
  );
}
