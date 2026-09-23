"use client";

// Pantalla del coordinador: armar la ruta del día, entregarla y cerrarla.
//
// El ciclo que la gobierna tiene tres puertas, y cada una existe por una razón:
//
//   planificada → el motorizado NO la ve. Se puede añadir y quitar paradas.
//   en_curso    → ya está en su teléfono. Lo que él reporta ya no se borra.
//   cerrada     → generó su liquidación. Se acabó.

import { useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { OrderLink } from "@/components/order-link";
import { Card, EmptyState, Section, cn, STICKY_HEAD, TABLE_WRAP_FROM } from "@/components/ui";
import { NON_DELIVERY_REASONS, PAYMENT_METHODS, routeTotals } from "@/lib/routes";
import { RISK_LABELS, type RiskAssessment } from "@/lib/retries";
import type { RouteRow, StopWithOrder } from "@/lib/routes-access";
import type { RiderRow } from "@/lib/settlements-access";
import { Hint } from "@/components/hint";
import { RIDER_PAY_BALANCE_HINT, RiderPayPanel, riderPayBalanceLabel } from "@/components/rider-pay-panel";
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
}: {
  /** Tras cada acción que salió bien (el panel lateral recarga su detalle). */
  onChanged?: () => void;
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
      {detailOnly && msg && <Card className="border-brand-200 bg-brand-50 p-3 text-sm text-brand-800">{msg}</Card>}
      {detailOnly && err && <Card className="border-red-200 bg-red-50 p-3 text-sm text-red-700">{err}</Card>}

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
}: {
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

  return (
    <Card className={cn("space-y-4", compact ? "p-0 shadow-none border-0" : "p-4")}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        {/* Izquierda: el título (vista completa) o «Reportar entregas», que es
            el gesto del día a día y va discreto; derecha: cerrar la ruta. */}
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          {!compact && (
            <h3 className="text-sm font-semibold text-slate-800">
              {riderName} · {route.route_date}
            </h3>
          )}
          {canReport && route.status === "en_curso" && (
            <a href={`/reparto?ruta=${route.id}&modo=coordinacion`} className="inline-flex min-h-9 items-center rounded-lg border border-brand-200 bg-brand-50 px-3 text-sm font-medium text-brand-800 hover:bg-brand-100">
              Reportar entregas
            </a>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {planning && (
            <button
              disabled={disabled || !stops.length}
              onClick={() => onRun(() => startRoute(route.id))}
              className="rounded-lg bg-sky-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-700 disabled:opacity-50"
            >
              Entregar la ruta
            </button>
          )}
          {route.status === "en_curso" && (
            <>
              <button
                disabled={disabled}
                onClick={() => onRun(() => closeRoute(route.id))}
                className="rounded-lg bg-slate-800 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-900 disabled:opacity-50"
              >
                Terminar ruta operativa
              </button>
              {totals.pendientes > 0 && (
                <button
                  disabled={disabled}
                  onClick={() => {
                    if (
                      !confirm(
                        `Quedan ${totals.pendientes} parada(s) sin reportar. Se cerrará igual y esas paradas no entrarán en la liquidación. ¿Seguro?`,
                      )
                    )
                      return;
                    onRun(() => closeRoute(route.id, { force: true }));
                  }}
                  className="text-xs text-red-600 underline hover:text-red-700 disabled:opacity-50"
                >
                  Cerrar con paradas sin reportar
                </button>
              )}
            </>
          )}
        </div>
      </div>

      {/* Una sola fila de métricas: lo operativo (paradas y cobros) y lo del
          pago del motorizado (ganancia y saldo), sin repetirlo más abajo. */}
      <div className="grid gap-2 sm:grid-cols-3 lg:grid-cols-6">
        <Tile label="Paradas" value={String(totals.total)} sub={`${totals.entregados} entregadas · ${totals.noEntregados} no · ${totals.pendientes} sin reportar`} />
        <Tile label="Efectivo en manos" value={money(totals.efectivo)} />
        <Tile label="Yape / POS" value={`${money(totals.yape)} / ${money(totals.pos)}`} />
        <Tile label="Ganancia base" value={snap ? (snap.missing ? "Sin tarifa" : money(snap.base)) : "…"} sub={snap?.missing ? `${snap.missing} punto(s) sin tarifa` : undefined} />
        <Tile label="Adicionales" value={snap ? money(snap.extra) : "…"} />
        <Tile
          label={snap ? riderPayBalanceLabel(snap.net_cash) : "Saldo"}
          value={snap ? (snap.net_cash === null ? "—" : money(Math.abs(snap.net_cash))) : "…"}
          highlight
          hint={RIDER_PAY_BALANCE_HINT}
        />
      </div>

      {/* Tabla única de paradas: en escritorio cabe; en pantallas estrechas se
          desplaza en horizontal con el cliente fijo a la izquierda. */}
      <div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
        <table className="w-full min-w-[1120px] text-sm">
          <thead className="border-b border-slate-200 text-left text-xs text-slate-500">
            <tr>
              <th className="sticky left-0 z-[1] bg-white px-3 py-2 font-medium">Cliente</th>
              <th className="px-3 py-2 font-medium">Pedido</th>
              <th className="px-3 py-2 text-right font-medium">Monto</th>
              <th className="px-3 py-2 font-medium">Tienda</th>
              <th className="px-3 py-2 font-medium">Distrito</th>
              <th className="px-3 py-2 font-medium">Resultado</th>
              <th className="px-3 py-2 font-medium">Cobró</th>
              <th className="px-3 py-2 font-medium">Respaldo</th>
              <th className="px-3 py-2 text-right font-medium">Tarifa</th>
              <th className="px-3 py-2 text-right font-medium">Adicional</th>
              <th className="px-3 py-2 text-right font-medium">Ganancia</th>
              {(planning || canExtra) && <th className="px-3 py-2 font-medium" />}
            </tr>
          </thead>
          <tbody>
            {stops.map((s) => {
              const pr = payRow.get(s.id);
              return (
              <tr key={s.id} className="border-b border-slate-100 whitespace-nowrap">
                <td className="sticky left-0 z-[1] bg-white px-3 py-2 text-slate-700">
                  <span className="mr-1.5 text-xs tabular-nums text-slate-400">{s.seq}</span>
                  {s.order?.customer_name ?? "—"}
                </td>
                <td className="px-3 py-2 text-slate-500">
                  {s.order?.name ? <OrderLink orderId={s.order_id} className="underline decoration-slate-300 hover:text-brand-700" title="Abrir la ficha del pedido">{s.order.name}</OrderLink> : "—"}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-slate-700">{s.order?.total == null ? "—" : money(s.order.total)}</td>
                <td className="px-3 py-2 text-slate-500">{storeName(s.store_id)}</td>
                <td className="px-3 py-2 text-slate-500">{s.order?.district ?? "—"}</td>
                <td className="px-3 py-2">
                  {s.status === "pendiente" ? (
                    <span className="text-xs text-slate-400">Sin reportar</span>
                  ) : s.status === "entregado" ? (
                    <span className="text-xs font-medium text-emerald-700">Entregado</span>
                  ) : (
                    <span className="text-xs font-medium text-red-700">
                      No entregado · {reasonLabel(s.outcome_reason)}
                    </span>
                  )}
                  {/* Todo no entregado vuelve físicamente a la oficina (0188/0189). */}
                  {s.status === "no_entregado" && s.dispatch_manifest_id && (
                    s.returned_at
                      ? <p className="mt-0.5"><span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-semibold text-emerald-800" title={`Recibido en oficina el ${new Date(s.returned_at).toLocaleString("es-PE", { timeZone: "America/Lima" })}`}>Devuelto · {new Date(s.returned_at).toLocaleString("es-PE", { timeZone: "America/Lima", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}</span></p>
                      : <p className="mt-0.5"><span className="rounded-full bg-red-100 px-2 py-0.5 text-[11px] font-semibold text-red-800">Por devolver</span></p>
                  )}
                  {s.note && <p className="text-[11px] text-slate-400">{s.note}</p>}
                </td>
                <td className="px-3 py-2 text-slate-700">
                  {s.status === "entregado" ? <>{methodLabel(s.payment_method)} · {money(s.collected_amount)}</> : "—"}
                </td>
                <td className="px-3 py-2 text-xs text-slate-500">
                  {/* Cada respaldo abre en grande en otra pestaña (GET /api/reparto/foto). */}
                  {s.photo_path
                    ? <a href={`/api/reparto/foto?path=${encodeURIComponent(s.photo_path)}`} target="_blank" rel="noreferrer" title="Ver la foto de la entrega" className="rounded px-1 text-base hover:bg-slate-100">📷</a>
                    : "—"}
                  {s.voucher_path && <a href={`/api/reparto/foto?path=${encodeURIComponent(s.voucher_path)}`} target="_blank" rel="noreferrer" title="Ver el comprobante de pago" className="ml-1 rounded px-1 text-base hover:bg-slate-100">🧾</a>}
                </td>
                {/* La tarifa solo se gana con la parada reportada (entregada o
                    rechazada); antes de eso no es S/ 0,00, es «todavía no». Sin
                    tarifa personal vigente se dice, para que se configure. */}
                <td className="px-3 py-2 text-right tabular-nums text-slate-700">
                  {!pr ? "—"
                    : pr.configured_rate == null ? <span className="text-xs text-amber-700" title="Configura la tarifa del motorizado en «Tarifa de …», abajo">Sin tarifa</span>
                    : s.status === "pendiente" ? <span className="text-xs text-slate-400" title={`${money(pr.configured_rate)} al reportar`}>—</span>
                    : pr.base === null ? <span className="text-xs text-amber-700">Sin tarifa</span>
                    : money(pr.base)}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-slate-700">{pr && pr.extra ? money(pr.extra) : "—"}</td>
                <td className="px-3 py-2 text-right font-semibold tabular-nums text-slate-900">{pr && pr.base !== null && pr.configured_rate != null && s.status !== "pendiente" ? money(pr.base + pr.extra) : "—"}</td>
                {(planning || canExtra) && (
                  <td className="px-3 py-2 text-right">
                    {planning && (
                      <button
                        disabled={disabled}
                        onClick={() => onRun(() => removeStop(s.id))}
                        className="text-xs text-slate-500 underline hover:text-red-600 disabled:opacity-50"
                      >
                        Quitar
                      </button>
                    )}
                    {canExtra && (
                      <button type="button" onClick={() => onExtra?.(s.id)} className="text-xs text-brand-700 underline-offset-2 hover:underline" title="Aprobar un adicional para este punto">+ adicional</button>
                    )}
                  </td>
                )}
              </tr>
              );
            })}
            {stops.length === 0 && (
              <tr>
                <td colSpan={11} className="px-3 py-6 text-center text-sm text-slate-500">
                  {canAddStops ? "Esta ruta no tiene paradas. Añádelas abajo." : "Esta ruta no tiene paradas."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

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

      {closed && (
        <p className="flex flex-wrap items-center gap-x-2 border-t border-slate-100 pt-3 text-xs text-slate-500">
          <button
            type="button"
            disabled={disabled}
            onClick={() => { if (window.confirm("¿Reabrir la ruta? Se descarta su liquidación en borrador; al volver a terminarla se crea de nuevo.")) onRun(() => reopenRoute(route.id)); }}
            className="min-h-0 rounded-md border border-slate-300 px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
            title="Solo mientras la liquidación siga en borrador y el cálculo diario no esté aprobado"
          >
            Reabrir ruta
          </button>
          Ruta cerrada. Su liquidación está en{" "}
          <a href="/dashboard/liquidaciones" className="font-medium text-brand-700 underline">
            Liquidaciones
          </a>
          , ya con todas las líneas vinculadas.
        </p>
      )}
    </Card>
  );
}

function closedStatus(status: string): boolean {
  return status === "cerrada";
}

function Tile({ label, value, sub, hint, highlight }: { label: string; value: string; sub?: string; hint?: string; highlight?: boolean }) {
  return (
    <div className={cn("min-w-0 rounded-lg border p-2.5", highlight ? "border-slate-900 bg-slate-900 text-white" : "border-slate-200")}>
      <p className={cn("flex items-center gap-1 text-[11px]", highlight ? "text-slate-300" : "text-slate-500")}>
        <span className="truncate">{label}</span>
        {hint && <Hint text={hint} className={highlight ? "text-slate-300" : undefined} />}
      </p>
      <p className={cn("mt-0.5 truncate text-sm font-semibold tabular-nums", highlight ? "text-white" : "text-slate-800")}>{value}</p>
      {sub && <p className={cn("mt-0.5 truncate text-[11px]", highlight ? "text-slate-300" : "text-slate-500")}>{sub}</p>}
    </div>
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
