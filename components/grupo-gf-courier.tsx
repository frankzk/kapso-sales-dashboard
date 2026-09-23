"use client";

import mobile from "./courier-mobile.module.css";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { OrderLink } from "@/components/order-link";
import { useRouter, useSearchParams } from "next/navigation";
import { Card, cn, STICKY_HEAD, TABLE_WRAP_FROM } from "@/components/ui";
import { DispatchDayBoard } from "@/components/dispatch-day-board";
import { CourierRoutesLedger } from "@/components/courier-routes-ledger";
import { CourierBoxDrawer } from "@/components/courier-box-drawer";
import { CourierRouteReportDrawer } from "@/components/courier-route-report-drawer";
import type { DispatchManifest } from "@/lib/dispatch-access";
import type { CourierLedgerRow, PendingReturn } from "@/lib/courier-route-ledger";
import { resolveDistrictAvailability, resolveDistrictTariff } from "@/lib/grupo-gf-courier";
import {
  activateGroupGfCourier,
  assignGroupGfCourierRoute,
  saveDistrictTariff,
  setDistrictAvailability,
  takeGroupGfCourierOrders,
  takeAndAssignGroupGfCourierOrders,
  type CourierActionResult,
  type CourierConfigSnapshot,
  type CourierAgreementRow,
  type CourierAvailableOrder,
  type CourierAcceptedOrder,
  type CourierRiderOption,
  type PeruDistrictRow,
} from "@/app/dashboard/courier/actions";

function today(): string {
  const value = new Date();
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function money(value: number): string {
  return `S/ ${value.toFixed(2)}`;
}

type CourierTabId = "dispatch" | "available" | "preparation" | "routes" | "tariffs";
function readCourierTab(value: string | null): CourierTabId {
  return value === "available" || value === "preparation" || value === "routes" || value === "tariffs" ? value : "dispatch";
}
/** Vistas anteriores: fuera de la barra, accesibles desde «⋯». Despacho del día ya hace lo suyo en un paso. */
const LEGACY_TABS: ReadonlyArray<{ id: CourierTabId; label: string }> = [
  { id: "available", label: "Pedidos disponibles" },
  { id: "preparation", label: "Pedidos tomados" },
];

export function GrupoGfCourierBoard({
  orgId,
  snapshot,
  manifests = [],
  today = "",
  ledger = [],
  pendingReturns = [],
}: {
  orgId: string;
  snapshot: CourierConfigSnapshot;
  /** Cajas (manifiestos) visibles para «Despacho del día». */
  manifests?: DispatchManifest[];
  /** Hoy en Lima. */
  today?: string;
  /** Rutas y cajas para la pestaña Rutas (MOM §29.14). */
  ledger?: CourierLedgerRow[];
  /** «No entregado» que siguen en una caja: habilitan «Recibir devoluciones». */
  pendingReturns?: PendingReturn[];
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const searchParams = useSearchParams();
  const requestedTab = searchParams.get("tab");
  const [tab, setTab] = useState<CourierTabId>(readCourierTab(requestedTab));
  useEffect(() => { setTab(readCourierTab(requestedTab)); }, [requestedTab]);

  function run(action: () => Promise<CourierActionResult>) {
    startTransition(async () => {
      const result = await action();
      setError(result.error ?? null);
      setNotice(result.notice ?? null);
      if (!result.error) router.refresh();
    });
  }

  if (!snapshot.provider) {
    return (
      <div className="mx-auto max-w-4xl space-y-6">
        <header>
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">
            Operación logística
          </p>
          <h1 className="mt-1 text-xl font-semibold text-slate-950">Grupo GF Courier</h1>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-slate-600">
            Activa el operador sin cambiar rutas ni inventario actuales. Se crearán los contratos
            de las tiendas activas, Yape 3.5 % y una bolsa de inventario todavía opcional.
          </p>
        </header>
        {error && <p className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p>}
        <Card className="flex flex-col gap-5 p-6 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-sm font-semibold text-slate-900">Fundación lista para activar</p>
            <ul className="mt-2 space-y-1 text-sm text-slate-600">
              <li>Lima Metropolitana y Callao</li>
              <li>Corte del mismo día: 11:30</li>
              <li>Advertencia S/ 4,000; límite S/ 5,000</li>
            </ul>
          </div>
          <button
            type="button"
            disabled={pending}
            onClick={() => run(() => activateGroupGfCourier(orgId))}
            className="h-10 rounded-lg bg-brand-600 px-4 text-sm font-semibold text-white transition hover:bg-brand-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 disabled:opacity-50"
          >
            {pending ? "Activando…" : "Activar Grupo GF Courier"}
          </button>
        </Card>
      </div>
    );
  }

  const provider = snapshot.provider;
  return (
    <div className={cn("space-y-4", mobile.board)}>
      {/* En el móvil la barra superior del panel ya dice «Grupo GF Courier»: la cabecera solo existe desde `sm`. */}
      <header className="hidden sm:flex sm:flex-col sm:gap-3 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">
            Operación logística
          </p>
          <h1 className="mt-1 text-xl font-semibold text-slate-950">Grupo GF Courier</h1>
          <p className="mt-1 max-w-3xl text-sm text-slate-600">
            Toma pedidos de Aurela y Kenku. Almacén arma cada caja y el mismo QR acompaña toda la entrega.
          </p>
        </div>
      </header>

      <nav aria-label="Secciones de Grupo GF Courier" className="grid grid-cols-[1fr_1fr_1fr_auto] gap-1 border-b border-slate-200 lg:flex">
        <CourierTab
          label="Despacho del día"
          shortLabel="Despacho"
          active={tab === "dispatch"}
          onClick={() => setTab("dispatch")}
          count={new Set(manifests.filter((m) => m.route_date === today && m.state !== "cancelled" && m.courier === "propio").map((m) => m.rider_id ?? m.driver_name)).size}
        />
        <CourierTab
          active={tab === "routes"}
          onClick={() => setTab("routes")}
          label="Rutas"
          shortLabel="Rutas"
          count={ledger.filter((row) => row.routeDate === today).length}
        />
        <CourierTab
          active={tab === "tariffs"}
          onClick={() => setTab("tariffs")}
          label="Tarifario"
        />
        <MoreViewsMenu
          active={LEGACY_TABS.some((t) => t.id === tab)}
          items={LEGACY_TABS.map((t) => ({ ...t, count: t.id === "available" ? snapshot.operations.available.length : snapshot.operations.accepted.length }))}
          onPick={(id) => setTab(id)}
        />
      </nav>
      {LEGACY_TABS.some((t) => t.id === tab) && (
        <p className="flex flex-wrap items-center gap-x-2 text-xs text-slate-500">
          <span>Vista anterior · Despacho del día ya hace esto en un paso.</span>
          <button type="button" onClick={() => setTab("dispatch")} className="min-h-0 p-0 font-medium text-brand-700 underline-offset-2 hover:underline">Ir a Despacho del día</button>
        </p>
      )}

      {error && <p role="alert" className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p>}
      {notice && <p className="rounded-xl bg-emerald-50 px-4 py-3 text-sm text-emerald-700">{notice}</p>}

      {tab === "dispatch" && (
        <DispatchDayBoard
          orgId={orgId}
          day={today}
          available={snapshot.operations.available}
          accepted={snapshot.operations.accepted}
          blocked={snapshot.operations.blocked}
          riders={snapshot.operations.riders}
          manifests={manifests}
          canManageDispatch={snapshot.canManageDispatch}
          riderPickupMode={provider.rider_pickup_mode ?? "exigir"}
          cashWarning={provider.cash_warning_amount}
          cashLimit={provider.cash_limit_amount}
          pending={pending}
          run={run}
        />
      )}
      {tab === "available" && (
        <AvailableOrders
          orgId={orgId}
          orders={snapshot.operations.available}
          blockedCount={snapshot.operations.blockedCount}
          sourceCount={snapshot.operations.sourceCount}
          riders={snapshot.operations.riders}
          canManageDispatch={snapshot.canManageDispatch}
          pending={pending}
          run={run}
        />
      )}
      {tab === "preparation" && (
        <AcceptedOrders
          orgId={orgId}
          orders={snapshot.operations.accepted}
          riders={snapshot.operations.riders}
          canManageDispatch={snapshot.canManageDispatch}
          pending={pending}
          run={run}
        />
      )}
      {tab === "routes" && (
        <CourierRoutesLedger
          rows={ledger}
          riders={snapshot.operations.riders}
          today={today}
          unassignedCount={snapshot.operations.accepted.filter((order) => !order.route).length}
          onShowUnassigned={() => setTab("dispatch")}
          orgId={orgId}
          pendingReturns={pendingReturns}
        />
      )}
      <CourierBoxDrawer />
      <CourierRouteReportDrawer />
      {tab === "tariffs" && (
        <TariffMatrix
          orgId={orgId}
          snapshot={snapshot}
          pending={pending}
          error={null}
          notice={null}
          onSave={(input) => run(() => saveDistrictTariff(input))}
          onAvailability={(input) => run(() => setDistrictAvailability(input))}
        />
      )}
    </div>
  );
}

/** «⋯» al final de las pestañas: las vistas anteriores en un desplegable pequeño. Escape o clic fuera lo cierran. */
function MoreViewsMenu({ active, items, onPick }: {
  active: boolean;
  items: ReadonlyArray<{ id: CourierTabId; label: string; count: number }>;
  onPick: (id: CourierTabId) => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => { if (root.current && !root.current.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("pointerdown", close); document.removeEventListener("keydown", esc); };
  }, [open]);
  return (
    <div ref={root} className="relative flex items-center justify-center lg:ml-auto">
      <button
        type="button"
        aria-label="Más vistas"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "relative flex min-h-12 min-w-12 items-center justify-center rounded-lg px-2 text-lg leading-none lg:min-h-14 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2",
          active ? "text-brand-700" : "text-slate-500 hover:text-slate-800",
        )}
      >
        ⋯
        {active && <span className="absolute inset-x-2 bottom-0 h-0.5 rounded-full bg-brand-600" />}
      </button>
      {open && (
        <ul role="menu" className="absolute right-0 top-full z-30 mt-1 w-60 rounded-xl border border-slate-200 bg-white p-1 text-sm shadow-lg">
          {items.map((item) => (
            <li key={item.id} role="none">
              <button
                type="button"
                role="menuitem"
                onClick={() => { onPick(item.id); setOpen(false); }}
                className="flex min-h-10 w-full items-center justify-between gap-2 rounded-lg px-3 text-left text-slate-800 hover:bg-slate-50"
              >
                <span>{item.label}</span>
                <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-[11px] tabular-nums text-slate-600">{item.count.toLocaleString("es-PE")}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function CourierTab({
  shortLabel,
  active,
  onClick,
  label,
  count,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  count?: number;
  shortLabel?: string;
}) {
  // Sin badge cuando la activa está en 0; en el móvil solo la activa lleva número.
  const showCount = count != null && !(active && count === 0);
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className={cn(
        "relative flex min-h-12 min-w-0 items-center justify-center gap-1 px-1 py-2 text-xs font-semibold lg:min-h-14 lg:px-3 lg:text-sm transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2",
        active ? "text-brand-700" : "text-slate-500 hover:text-slate-800",
      )}
    >
      <span className={cn("truncate", shortLabel ? "hidden lg:inline" : "")}>{label}</span>{shortLabel && <span className="truncate lg:hidden">{shortLabel}</span>}
      {showCount && (
        <span className={cn(
          "rounded-full px-1.5 py-0.5 text-[11px] tabular-nums",
          active ? "bg-brand-50 text-brand-700" : "hidden bg-slate-100 text-slate-600 sm:inline",
        )}>
          {count}
        </span>
      )}
      {active && <span className="absolute inset-x-2 bottom-0 h-0.5 rounded-full bg-brand-600" />}
    </button>
  );
}

function AvailableOrders({
  orgId,
  orders,
  blockedCount,
  sourceCount,
  riders,
  canManageDispatch,
  pending,
  run,
}: {
  orgId: string;
  orders: CourierAvailableOrder[];
  blockedCount: number;
  sourceCount: number;
  riders: CourierRiderOption[];
  canManageDispatch: boolean;
  pending: boolean;
  run: (action: () => Promise<CourierActionResult>) => void;
}) {
  const searchParams = useSearchParams();
  const requestedOrderId = searchParams.get("pedido") ?? "";
  const requestedOrder = orders.find((order) => order.orderId === requestedOrderId);
  const [query, setQuery] = useState(requestedOrderId);
  const [segment, setSegment] = useState<"never_dispatched" | "prior_dispatch">(
    requestedOrder?.hasPriorDispatch ? "prior_dispatch" : "never_dispatched",
  );
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [riderId, setRiderId] = useState("");
  const [page, setPage] = useState(0);
  const segmentCounts = useMemo(() => ({
    neverDispatched: orders.filter((order) => !order.hasPriorDispatch).length,
    priorDispatch: orders.filter((order) => order.hasPriorDispatch).length,
  }), [orders]);
  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase("es");
    return orders.filter((order) => {
      const belongsToSegment = segment === "never_dispatched"
        ? !order.hasPriorDispatch
        : order.hasPriorDispatch;
      if (!belongsToSegment) return false;
      if (!needle) return true;
      return `${order.orderId} ${order.orderName} ${order.customerName} ${order.customerPhone ?? ""} ${order.district} ${order.storeName}`
          .toLocaleLowerCase("es")
          .includes(needle);
    });
  }, [orders, query, segment]);
  const currentPage = Math.min(page, Math.max(0, Math.ceil(filtered.length / 50) - 1));
  const visible = filtered.slice(currentPage * 50, currentPage * 50 + 50);
  const visibleIds = visible.map((order) => order.orderId);
  const allVisibleSelected = visibleIds.length > 0 && visibleIds.every((id) => selected.has(id));

  function toggle(orderId: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(orderId)) next.delete(orderId);
      else next.add(orderId);
      return next;
    });
  }

  function take(ids: string[]) {
    if (!ids.length) return;
    setSelected(new Set());
    run(async () => {
      const messages: string[] = [];
      const errors: string[] = [];
      for (let offset = 0; offset < ids.length; offset += 50) {
        const result = await takeGroupGfCourierOrders(orgId, ids.slice(offset, offset + 50));
        if (result.notice) messages.push(result.notice);
        errors.push(...result.failed.map((item) => `${item.orderId}: ${item.error}`));
        if (result.error && !result.failed.length) errors.push(result.error);
      }
      return { notice: [...messages, ...errors].join(" ") };
    });
  }

  function takeAndAssign() {
    if (!riderId || !selected.size) return;
    const ids = [...selected];
    run(async () => {
      const messages: string[] = [];
      for (let offset = 0; offset < ids.length; offset += 50) {
        const result = await takeAndAssignGroupGfCourierOrders(orgId, riderId, ids.slice(offset, offset + 50));
        messages.push(result.error ?? result.notice ?? "");
      }
      setSelected(new Set());
      return { notice: messages.join(" ") };
    });
  }

  return (
    <section aria-labelledby="available-orders-title" className="space-y-4">
      <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
        <div>
          <h2 id="available-orders-title" className="text-base font-semibold text-slate-950">
            Pedidos disponibles para el courier
          </h2>
          <p className="mt-1 max-w-3xl text-sm leading-6 text-slate-600">
            Puedes tomarlos antes, durante o después del armado. Almacén siempre los prepara; tomar solo reserva el servicio y la tarifa.
          </p>
          <p className="mt-1 text-xs text-slate-500">
            {orders.length.toLocaleString("es-PE")} disponibles de {sourceCount.toLocaleString("es-PE")} pedidos revisados. La búsqueda cubre toda la bandeja, sin aprobación adicional del Master.
          </p>
          {blockedCount > 0 && (
            <p className="mt-1 text-xs text-amber-700">
              {blockedCount} pedido{blockedCount === 1 ? "" : "s"} no aparece{blockedCount === 1 ? "" : "n"} por tarifa faltante, distrito inválido o servicio pausado.
            </p>
          )}
        </div>
        <label className="text-xs font-medium text-slate-600">
          Buscar
          <input
            value={query}
            onChange={(event) => { setQuery(event.target.value); setPage(0); setSelected(new Set()); }}
            placeholder="Pedido, cliente, teléfono o distrito"
            className="mt-1 block h-10 w-full min-w-72 rounded-lg border border-slate-200 bg-white px-3 text-sm text-slate-900 outline-none placeholder:text-slate-400 focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
          />
        </label>
      </div>

      <div className="border-b border-slate-200" role="tablist" aria-label="Prioridad de pedidos disponibles">
        <div className="flex flex-wrap gap-6">
          <AvailabilitySegmentTab
            active={segment === "never_dispatched"}
            label="Prioridad urgente · nunca salieron"
            count={segmentCounts.neverDispatched}
            onClick={() => {
              setSegment("never_dispatched");
              setPage(0);
              setSelected(new Set());
            }}
          />
          <AvailabilitySegmentTab
            active={segment === "prior_dispatch"}
            label="Con salida previa"
            count={segmentCounts.priorDispatch}
            onClick={() => {
              setSegment("prior_dispatch");
              setPage(0);
              setSelected(new Set());
            }}
          />
        </div>
      </div>
      <p className={cn(
        "rounded-lg px-3 py-2 text-xs leading-5",
        segment === "never_dispatched"
          ? "bg-amber-50 text-amber-800"
          : "bg-slate-100 text-slate-600",
      )}>
        {segment === "never_dispatched"
          ? "No tienen ningún despacho histórico. Se muestran primero y, dentro de esta cola, del más reciente al más antiguo."
          : "Ya tuvieron al menos una salida física. Revísalos como reprogramaciones o recuperaciones antes de volver a tomarlos."}
      </p>

      {selected.size > 0 && (
        <div className="relative z-20 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-brand-200 bg-brand-50 px-4 py-3 shadow-sm lg:sticky lg:top-3">
          <p className="text-sm font-semibold text-brand-950">
            {selected.size} pedido{selected.size === 1 ? "" : "s"} seleccionado{selected.size === 1 ? "" : "s"}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            {canManageDispatch && <>
              <select aria-label="Motorizado para tomar y asignar" value={riderId} onChange={(event) => setRiderId(event.target.value)} disabled={pending} className="h-10 rounded-lg border border-slate-300 bg-white px-3 text-sm">
                <option value="">Elegir motorizado</option>
                {riders.map((rider) => <option key={rider.id} value={rider.id}>{rider.fullName}</option>)}
              </select>
              <button type="button" disabled={pending || !riderId} onClick={takeAndAssign} className="h-10 rounded-lg bg-brand-600 px-4 text-sm font-semibold text-white disabled:opacity-50">
                {pending ? "Procesando…" : "Tomar y asignar"}
              </button>
            </>}
            <button
              type="button"
              onClick={() => setSelected(new Set())}
              className="h-9 rounded-lg px-3 text-sm font-medium text-slate-600 hover:bg-white"
            >
              Limpiar
            </button>
            <button
              type="button"
              disabled={pending}
              onClick={() => take([...selected])}
              className="h-9 rounded-lg bg-brand-600 px-4 text-sm font-semibold text-white transition hover:bg-brand-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 disabled:opacity-50"
            >
              {pending ? "Tomando pedidos…" : "Tomar sin asignar"}
            </button>
          </div>
        </div>
      )}

      <div className={cn(TABLE_WRAP_FROM[980], "rounded-xl border border-slate-200 bg-white shadow-sm", mobile.orders)}>
        <table className="w-full min-w-[980px] text-sm">
          <thead className={STICKY_HEAD}>
            <tr className="text-left text-xs text-slate-500">
              <th className="w-12 px-4 py-3">
                <label className={mobile.check}><input
                  type="checkbox"
                  aria-label="Seleccionar pedidos visibles"
                  checked={allVisibleSelected}
                  onChange={() => {
                    setSelected((current) => {
                      const next = new Set(current);
                      if (allVisibleSelected) visibleIds.forEach((id) => next.delete(id));
                      else visibleIds.forEach((id) => next.add(id));
                      return next;
                    });
                  }}
                /></label>
              </th>
              <th className="px-3 py-3 font-medium">Pedido</th>
              <th className="px-3 py-3 font-medium">Cliente</th>
              <th className="px-3 py-3 font-medium">Destino</th>
              <th className="px-3 py-3 text-right font-medium">Venta</th>
              <th className="px-3 py-3 text-right font-medium">Tarifa</th>
              <th className="px-3 py-3 font-medium">Salida prevista</th>
              <th className="px-4 py-3 text-right font-medium">Acción</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((order) => (
              <tr key={order.orderId} className="border-b border-slate-100 last:border-0 hover:bg-slate-50/70">
                <td className="px-4 py-3">
                  <label className={mobile.check}><input
                    type="checkbox"
                    aria-label={`Seleccionar ${order.orderName}`}
                    checked={selected.has(order.orderId)}
                    onChange={() => toggle(order.orderId)}
                  /></label>
                </td>
                <td className="px-3 py-3">
                  <OrderLink orderId={order.orderId} className="font-semibold text-slate-950 hover:text-brand-700">
                    {order.orderName}
                  </OrderLink>
                  <p className="mt-0.5 text-xs text-slate-500">
                    {order.storeName}
                    {order.hasPriorDispatch && order.lastDispatchedAt
                      ? ` · Última salida ${formatTimestampDate(order.lastDispatchedAt)}`
                      : order.orderCreatedAt
                        ? ` · Creado ${formatTimestampDate(order.orderCreatedAt)}`
                        : ""}
                  </p>
                </td>
                <td className="px-3 py-3">
                  <p className="font-medium text-slate-800">{order.customerName}</p>
                  <p className="mt-0.5 text-xs text-slate-500">{order.customerPhone ?? "Sin teléfono"}</p>
                </td>
                <td data-label="Destino" className="px-3 py-3 text-slate-700">{order.district}</td>
                <td data-label="Venta" className="px-3 py-3 text-right tabular-nums text-slate-700">{money(order.orderTotal)}</td>
                <td data-label="Tarifa" className="px-3 py-3 text-right font-semibold tabular-nums text-slate-900">{money(order.tariffAmount)}</td>
                <td data-label="Salida" className="px-3 py-3 text-slate-700">{formatDate(order.scheduledFor)}</td>
                <td className="px-4 py-3 text-right">
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() => take([order.orderId])}
                    className="h-9 rounded-lg bg-slate-950 px-3 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:opacity-50"
                  >
                    Tomar pedido
                  </button>
                </td>
              </tr>
            ))}
            {!filtered.length && (
              <tr>
                <td colSpan={8} className="px-6 py-16 text-center">
                  <p className="font-medium text-slate-800">
                    {query.trim()
                      ? "Ningún pedido coincide con la búsqueda en este segmento."
                      : orders.length
                        ? segment === "never_dispatched"
                          ? "No hay pedidos urgentes sin salida previa."
                          : "No hay pedidos con salida previa en la cola visible."
                        : "No hay pedidos pendientes de admisión."}
                  </p>
                  <p className="mx-auto mt-1 max-w-xl text-sm text-slate-500">
                    {orders.length
                      ? "Puedes revisar el otro segmento sin perder el orden de prioridad."
                      : "Los pedidos Lima de Aurela y Kenku aparecerán aquí automáticamente al entrar a Preparación."}
                  </p>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="flex flex-col items-start justify-between gap-3 text-sm sm:flex-row sm:items-center" aria-label="Paginación de pedidos disponibles">
        <span>{filtered.length} resultados · Página {currentPage + 1} de {Math.max(1, Math.ceil(filtered.length / 50))}</span>
        <div className="flex gap-2">
          <button disabled={currentPage === 0 || pending} onClick={() => setPage(currentPage - 1)} className="rounded-lg border px-3 py-2 disabled:opacity-40">Anterior</button>
          <button disabled={(currentPage + 1) * 50 >= filtered.length || pending} onClick={() => setPage(currentPage + 1)} className="rounded-lg border px-3 py-2 disabled:opacity-40">Siguiente</button>
        </div>
      </div>
    </section>
  );
}

function AvailabilitySegmentTab({
  active,
  label,
  count,
  onClick,
}: {
  active: boolean;
  label: string;
  count: number;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        "relative min-h-11 pb-3 pt-2 text-left text-sm font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2",
        active ? "text-slate-950" : "text-slate-500 hover:text-slate-800",
      )}
    >
      {label}
      <span className={cn(
        "ml-2 rounded-full px-2 py-0.5 text-xs tabular-nums",
        active ? "bg-slate-950 text-white" : "bg-slate-100 text-slate-600",
      )}>
        {count}
      </span>
      {active && <span className="absolute inset-x-0 bottom-0 h-0.5 rounded-full bg-slate-950" />}
    </button>
  );
}

function preparationLabel(order: CourierAcceptedOrder): { label: string; tone: string } {
  if (order.requestStatus === "observed") return { label: "Requiere revisión", tone: "bg-red-50 text-red-700" };
  if (order.preparationState === "listo_despacho") return { label: "Armado · listo para ruta", tone: "bg-emerald-50 text-emerald-700" };
  if (order.preparationState === "en_armado") return { label: "Almacén armando", tone: "bg-sky-50 text-sky-700" };
  return { label: "Pendiente de armado", tone: "bg-amber-50 text-amber-700" };
}

function AcceptedOrders({
  orgId,
  orders,
  riders,
  canManageDispatch,
  pending,
  run,
}: {
  orgId: string;
  orders: CourierAcceptedOrder[];
  riders: CourierRiderOption[];
  canManageDispatch: boolean;
  pending: boolean;
  run: (action: () => Promise<CourierActionResult>) => void;
}) {
  type AcceptedSegment = "unassigned" | "assigned" | "pending_arm" | "ready_check";
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [riderId, setRiderId] = useState(riders[0]?.id ?? "");
  const [overrideCash, setOverrideCash] = useState(false);
  const [segment, setSegment] = useState<AcceptedSegment>("unassigned");
  const segmentCounts: Record<AcceptedSegment, number> = {
    unassigned: orders.filter((order) => !order.route).length,
    assigned: orders.filter((order) => !!order.route).length,
    pending_arm: orders.filter((order) => order.route && order.preparationState !== "listo_despacho").length,
    ready_check: orders.filter(
      (order) => order.route && order.preparationState === "listo_despacho" && !order.route.officeCheckedAt,
    ).length,
  };
  const filteredOrders = orders.filter((order) => {
    if (segment === "unassigned") return !order.route;
    if (segment === "assigned") return !!order.route;
    if (segment === "pending_arm") return !!order.route && order.preparationState !== "listo_despacho";
    return !!order.route && order.preparationState === "listo_despacho" && !order.route.officeCheckedAt;
  });
  const assignable = filteredOrders.filter(
    (order) => !order.route && order.shipmentId && order.requestStatus !== "observed",
  );
  const assignableIds = assignable.map((order) => order.requestId);
  const allSelected = assignableIds.length > 0 && assignableIds.every((id) => selected.has(id));

  function toggle(requestId: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(requestId)) next.delete(requestId);
      else next.add(requestId);
      return next;
    });
  }

  function assign() {
    if (!riderId || !selected.size) return;
    const requestIds = [...selected];
    setSelected(new Set());
    run(async () => {
      const result = await assignGroupGfCourierRoute(orgId, riderId, requestIds, { overrideCash });
      return { ...result, notice: [result.notice, result.cashWarning].filter(Boolean).join(" ") || undefined };
    });
  }

  return (
    <section aria-labelledby="accepted-orders-title" className="space-y-4">
      <div>
        <h2 id="accepted-orders-title" className="text-base font-semibold text-slate-950">Pedidos tomados</h2>
        <p className="mt-1 max-w-4xl text-sm leading-6 text-slate-600">
          Asigna qué pedidos llevará cada motorizado. Almacén arma en paralelo; abre la caja desde Rutas operativas para verificarla y recibirla aquí, en Grupo GF Courier.
        </p>
      </div>

      <div className="flex flex-col gap-3 rounded-xl border border-slate-200 bg-slate-50 px-4 py-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <p className="text-sm font-semibold text-slate-900">Asignar a ruta diaria</p>
          <p className="mt-1 text-xs leading-5 text-slate-600">
            Se reutiliza una sola ruta por motorizado y fecha. “Pendiente de armado” informa; no bloquea la planificación.
          </p>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
          <label className="text-xs font-medium text-slate-600">
            Motorizado
            <select
              value={riderId}
              onChange={(event) => setRiderId(event.target.value)}
              disabled={!canManageDispatch || !riders.length || pending}
              className="mt-1 block h-10 min-w-56 rounded-lg border border-slate-200 bg-white px-3 text-sm text-slate-900 outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100 disabled:opacity-50"
            >
              {!riders.length && <option value="">Sin motorizados disponibles</option>}
              {riders.map((rider) => <option key={rider.id} value={rider.id}>{rider.fullName}</option>)}
            </select>
          </label>
          <label className="flex items-center gap-2 text-xs text-slate-600">
            <input type="checkbox" checked={overrideCash} onChange={(e) => setOverrideCash(e.target.checked)} disabled={pending} />
            Autorizo superar el límite de efectivo de la ruta
          </label>
          <button
            type="button"
            disabled={!canManageDispatch || !riderId || !selected.size || pending}
            onClick={assign}
            className="h-10 rounded-lg bg-slate-950 px-4 text-sm font-semibold text-white transition hover:bg-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {pending ? "Asignando…" : `Asignar ${selected.size || ""} a ruta`.replace("  ", " ")}
          </button>
        </div>
      </div>
      {!riders.length && (
        <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
          Registra o activa los motorizados de Grupo GF en Equipo → Motorizados para poder asignarles una caja.
        </p>
      )}
      {!canManageDispatch && (
        <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
          Puedes revisar los pedidos tomados, pero necesitas el permiso “Organizar despacho” para asignarlos a una ruta.
        </p>
      )}
      <div className="border-b border-slate-200" role="tablist" aria-label="Situación de pedidos tomados">
        <div className="flex flex-wrap gap-6">
          {([
            ["unassigned", "Sin ruta"],
            ["assigned", "Asignados"],
            ["pending_arm", "Pendientes de armado"],
            ["ready_check", "Listos para cotejo"],
          ] as Array<[AcceptedSegment, string]>).map(([key, label]) => (
            <AvailabilitySegmentTab
              key={key}
              active={segment === key}
              label={label}
              count={segmentCounts[key]}
              onClick={() => {
                setSegment(key);
                setSelected(new Set());
              }}
            />
          ))}
        </div>
      </div>
      <div className={cn(TABLE_WRAP_FROM[980], "rounded-xl border border-slate-200 bg-white shadow-sm", mobile.orders)}>
        <table className="w-full min-w-[1080px] text-sm">
          <thead className={STICKY_HEAD}>
            <tr className="text-left text-xs text-slate-500">
              <th className="w-12 px-4 py-3">
                <label className={mobile.check}><input
                  type="checkbox"
                  aria-label="Seleccionar pedidos sin ruta"
                  checked={allSelected}
                  disabled={!canManageDispatch || !assignableIds.length}
                  onChange={() => {
                    setSelected((current) => {
                      const next = new Set(current);
                      if (allSelected) assignableIds.forEach((id) => next.delete(id));
                      else assignableIds.forEach((id) => next.add(id));
                      return next;
                    });
                  }}
                /></label>
              </th>
              <th className="px-4 py-3 font-medium">Pedido</th>
              <th className="px-3 py-3 font-medium">Cliente</th>
              <th className="px-3 py-3 font-medium">Salida</th>
              <th className="px-3 py-3 font-medium">Preparación física</th>
              <th className="px-3 py-3 text-right font-medium">Tarifa</th>
              <th className="px-4 py-3 font-medium">Ruta / caja</th>
            </tr>
          </thead>
          <tbody>
            {filteredOrders.map((order) => {
              const status = preparationLabel(order);
              const canAssign = !order.route && !!order.shipmentId && order.requestStatus !== "observed";
              return (
                <tr key={order.requestId} className="border-b border-slate-100 last:border-0">
                  <td className="px-4 py-3">
                    <label className={mobile.check}><input
                      type="checkbox"
                      aria-label={`Seleccionar ${order.orderName} para una ruta`}
                      checked={selected.has(order.requestId)}
                      disabled={!canManageDispatch || !canAssign}
                      onChange={() => toggle(order.requestId)}
                    /></label>
                  </td>
                  <td className="px-4 py-3">
                    <OrderLink orderId={order.orderId} className="font-semibold text-slate-950 hover:text-brand-700">{order.orderName}</OrderLink>
                    <p className="mt-0.5 text-xs text-slate-500">{order.storeName} · {order.district}</p>
                  </td>
                  <td className="px-3 py-3 text-slate-700">{order.customerName}</td>
                  <td className="px-3 py-3 font-mono text-xs font-semibold text-slate-700">{order.outputCode ?? "Generando…"}</td>
                  <td className="px-3 py-3">
                    <span className={cn("rounded-md px-2 py-1 text-xs font-semibold", status.tone)}>{status.label}</span>
                    {order.observation && <p className="mt-1 max-w-64 text-xs text-red-600">{order.observation}</p>}
                  </td>
                  <td data-label="Tarifa" className="px-3 py-3 text-right font-semibold tabular-nums text-slate-900">{money(order.tariffAmount)}</td>
                  <td className="px-4 py-3">
                    {order.route ? (
                      <div>
                        <p className="text-sm font-semibold text-slate-900">{order.route.riderName}</p>
                        <p className="mt-0.5 text-xs text-slate-500">Caja del {formatDate(order.route.routeDate)}</p>
                        <Link
                          href={`/dashboard/courier/rutas?manifiesto=${encodeURIComponent(order.route.manifestId)}`}
                          className="mt-1 inline-flex text-xs font-semibold text-brand-700 hover:underline"
                        >
                          Abrir caja y cotejar →
                        </Link>
                      </div>
                    ) : (
                      <div>
                        <p className="text-xs font-semibold text-amber-700">Sin ruta asignada</p>
                        <p className="mt-0.5 text-xs text-slate-500">
                          {order.requestStatus === "observed" ? "Corrige la solicitud primero" : "Selecciona este pedido arriba"}
                        </p>
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
            {!filteredOrders.length && (
              <tr><td colSpan={7} className="px-6 py-16 text-center text-sm text-slate-500">
                {orders.length ? "No hay pedidos en este segmento." : "Todavía no hay pedidos tomados."}
              </td></tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function TariffMatrix({
  orgId,
  snapshot,
  pending,
  error,
  notice,
  onSave,
  onAvailability,
}: {
  orgId: string;
  snapshot: CourierConfigSnapshot;
  pending: boolean;
  error: string | null;
  notice: string | null;
  onSave: (input: Parameters<typeof saveDistrictTariff>[0]) => void;
  onAvailability: (input: Parameters<typeof setDistrictAvailability>[0]) => void;
}) {
  const provider = snapshot.provider!;
  const [scope, setScope] = useState("general");
  const [query, setQuery] = useState("");
  const [effectiveFrom, setEffectiveFrom] = useState(today());
  const agreementId = scope === "general" ? null : scope;
  const districts = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase("es");
    if (!needle) return snapshot.districts;
    return snapshot.districts.filter((district) =>
      `${district.district} ${district.province}`.toLocaleLowerCase("es").includes(needle),
    );
  }, [query, snapshot.districts]);
  const configured = snapshot.districts.filter(
    (district) =>
      resolveDistrictTariff(snapshot.tariffs, {
        providerId: provider.id,
        agreementId,
        districtKey: district.district_key,
        day: effectiveFrom,
      }).kind === "found",
  ).length;
  const paused = snapshot.districts.filter(
    (district) =>
      resolveDistrictAvailability(snapshot.availabilityEvents, {
        providerId: provider.id,
        agreementId,
        districtKey: district.district_key,
        day: today(),
      }).status === "paused",
  ).length;

  return (
    <div className="space-y-5">
      <details className="rounded-xl border border-slate-200 bg-white px-3 text-sm">
        <summary className="min-h-12 cursor-pointer py-3 font-medium text-slate-600">Condiciones del servicio</summary>
        <p className="pb-2 text-xs text-slate-500">Toma pedidos de Aurela y Kenku. Almacén arma cada caja y el mismo QR acompaña toda la entrega.</p>
        <div className="grid grid-cols-3 divide-x divide-slate-200 pb-3">
          <Summary label="Corte" value={provider.same_day_cutoff.slice(0, 5)} />
          <Summary label="Yape" value={`${snapshot.yapePercentage} %`} />
          <Summary label="Efectivo máximo" value={money(provider.cash_limit_amount)} />
        </div>
      </details>
      {error && <p role="alert" className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p>}
      {notice && <p className="rounded-xl bg-emerald-50 px-4 py-3 text-sm text-emerald-700">{notice}</p>}

      <section aria-label="Filtros de tarifas" className="flex flex-col gap-3 border-y border-slate-200 py-4 md:flex-row md:items-end">
        <label className="text-xs font-medium text-slate-600">
          Tarifario
          <select
            value={scope}
            onChange={(event) => setScope(event.target.value)}
            className="mt-1 block h-10 min-w-56 rounded-lg border border-slate-200 bg-white px-3 text-sm text-slate-900 outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
          >
            <option value="general">General de Grupo GF</option>
            {snapshot.agreements.map((agreement) => (
              <option key={agreement.id} value={agreement.id}>{agreement.client_label}</option>
            ))}
          </select>
        </label>
        <label className="min-w-0 flex-1 text-xs font-medium text-slate-600">
          Buscar distrito
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Ej. Miraflores o Callao"
            className="mt-1 block h-10 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm text-slate-900 outline-none placeholder:text-slate-400 focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
          />
        </label>
        <label className="text-xs font-medium text-slate-600">
          Ver y registrar desde
          <input
            type="date"
            value={effectiveFrom}
            onChange={(event) => setEffectiveFrom(event.target.value)}
            className="mt-1 block h-10 rounded-lg border border-slate-200 bg-white px-3 text-sm text-slate-900 outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
          />
        </label>
        <p className="pb-2 text-xs tabular-nums text-slate-500">
          {configured}/{snapshot.districts.length} configurados
          {paused > 0 && <span className="ml-2 font-medium text-amber-700">· {paused} pausado{paused === 1 ? "" : "s"}</span>}
        </p>
      </section>

      <div className={cn(TABLE_WRAP_FROM[980], "rounded-xl border border-slate-200 bg-white shadow-sm", mobile.orders, mobile.tariffs)}>
        <table className="w-full min-w-[980px] text-sm">
          <thead className={STICKY_HEAD}>
            <tr className="text-left text-xs text-slate-500">
              <th className="px-4 py-3 font-medium">Distrito</th>
              <th className="px-3 py-3 font-medium">Servicio</th>
              <th className="px-3 py-3 font-medium">Zona</th>
              <th className="px-3 py-3 text-right font-medium">Entrega o rechazo</th>
              <th className="px-3 py-3 font-medium">Origen</th>
              <th className="px-4 py-3 text-right font-medium">Acción</th>
            </tr>
          </thead>
          <tbody>
            {districts.map((district) => (
              <TariffRow
                key={`${scope}:${district.district_key}:${effectiveFrom}`}
                orgId={orgId}
                providerId={provider.id}
                agreementId={agreementId}
                agreement={snapshot.agreements.find((item) => item.id === agreementId) ?? null}
                district={district}
                tariffs={snapshot.tariffs}
                availabilityEvents={snapshot.availabilityEvents}
                effectiveFrom={effectiveFrom}
                pending={pending}
                onSave={onSave}
                onAvailability={onAvailability}
              />
            ))}
            {!districts.length && (
              <tr><td colSpan={6} className="px-4 py-10 text-center text-sm text-slate-500">Ningún distrito coincide con la búsqueda.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Summary({ label, value }: { label: string; value: string }) {
  return (
    <div className="px-4">
      <p className="text-[11px] text-slate-500">{label}</p>
      <p className="mt-0.5 whitespace-nowrap font-semibold tabular-nums text-slate-900">{value}</p>
    </div>
  );
}

function TariffRow({
  orgId,
  providerId,
  agreementId,
  agreement,
  district,
  tariffs,
  availabilityEvents,
  effectiveFrom,
  pending,
  onSave,
  onAvailability,
}: {
  orgId: string;
  providerId: string;
  agreementId: string | null;
  agreement: CourierAgreementRow | null;
  district: PeruDistrictRow;
  tariffs: CourierConfigSnapshot["tariffs"];
  availabilityEvents: CourierConfigSnapshot["availabilityEvents"];
  effectiveFrom: string;
  pending: boolean;
  onSave: (input: Parameters<typeof saveDistrictTariff>[0]) => void;
  onAvailability: (input: Parameters<typeof setDistrictAvailability>[0]) => void;
}) {
  const resolution = resolveDistrictTariff(tariffs, {
    providerId,
    agreementId,
    districtKey: district.district_key,
    day: effectiveFrom,
  });
  const tariff = resolution.kind === "found" ? resolution.tariff : null;
  const [zone, setZone] = useState(tariff?.zone ?? "");
  const [delivery, setDelivery] = useState(tariff ? String(tariff.delivery_amount) : "");
  const [showPauseForm, setShowPauseForm] = useState(false);
  const [pauseReason, setPauseReason] = useState("");
  const [pausedUntil, setPausedUntil] = useState("");
  const inherited = agreementId != null && resolution.kind === "found" && resolution.source === "general";
  const availability = resolveDistrictAvailability(availabilityEvents, {
    providerId,
    agreementId,
    districtKey: district.district_key,
    day: today(),
  });
  const inheritedPause =
    agreementId != null && availability.status === "paused" && availability.source === "general";

  return (
    <>
      <tr className={cn(
        "border-b border-slate-100 last:border-0 hover:bg-slate-50/60",
        availability.status === "paused" && "bg-amber-50/40 hover:bg-amber-50/60",
      )}>
        <td className="px-4 py-3">
          <p className="font-medium text-slate-900">{district.district}</p>
          <p className="text-xs text-slate-500">
            {district.province} · {district.order_count.toLocaleString("es-PE")} pedidos Lima
          </p>
        </td>
        <td className="px-3 py-3">
          {availability.status === "paused" ? (
            <div className="min-w-44 space-y-1.5">
              <div className="flex items-center gap-2">
                <span className="rounded-md bg-amber-100 px-2 py-1 text-xs font-semibold text-amber-800">
                  {inheritedPause ? "Pausado general" : "Pausado"}
                </span>
                {!inheritedPause && (
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() => onAvailability({
                      orgId,
                      providerId,
                      agreementId,
                      districtKey: district.district_key,
                      status: "available",
                    })}
                    className="rounded-md px-1.5 py-1 text-xs font-semibold text-brand-700 transition hover:bg-brand-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 disabled:opacity-50"
                  >
                    Reactivar
                  </button>
                )}
              </div>
              <p className="max-w-52 truncate text-xs text-amber-800" title={availability.event.reason ?? undefined}>
                {availability.event.reason}
                {availability.event.paused_until && ` · hasta ${formatDate(availability.event.paused_until)}`}
              </p>
            </div>
          ) : (
            <button
              type="button"
              aria-expanded={showPauseForm}
              onClick={() => setShowPauseForm((current) => !current)}
              className="rounded-md border border-emerald-200 bg-emerald-50 px-2.5 py-1.5 text-xs font-semibold text-emerald-700 transition hover:border-emerald-300 hover:bg-emerald-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
            >
              Disponible · Pausar
            </button>
          )}
        </td>
        <td data-label="Zona" className="px-3 py-3">
          <input
            value={zone}
            onChange={(event) => setZone(event.target.value)}
            aria-label={`Zona de ${district.district}`}
            placeholder="Sin zona"
            className="h-9 w-40 rounded-lg border border-slate-200 bg-white px-2.5 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
          />
        </td>
        <td data-label="Entrega o rechazo" className="px-3 py-3 text-right">
          <MoneyInput label={`Tarifa de entrega o rechazo en ${district.district}`} value={delivery} onChange={setDelivery} />
        </td>
        <td className="px-3 py-3">
          {resolution.kind === "missing" ? (
            <span className="rounded-md bg-amber-50 px-2 py-1 text-xs font-medium text-amber-700">Sin tarifa</span>
          ) : inherited ? (
            <span className="rounded-md bg-slate-100 px-2 py-1 text-xs text-slate-600">Heredada de general</span>
          ) : (
            <span className="text-xs text-slate-500">{agreement?.client_label ?? "General"}</span>
          )}
        </td>
        <td className="px-4 py-3 text-right">
          <button
            type="button"
            disabled={pending || delivery.trim() === ""}
            onClick={() => onSave({
              orgId,
              providerId,
              agreementId,
              districtKey: district.district_key,
              zone,
              deliveryAmount: delivery,
              effectiveFrom,
            })}
            className="h-9 rounded-lg px-3 text-sm font-semibold text-brand-700 transition hover:bg-brand-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 disabled:text-slate-300"
          >
            {tariff && !inherited ? "Cambiar" : inherited ? "Crear excepción" : "Guardar"}
          </button>
        </td>
      </tr>
      {showPauseForm && availability.status === "available" && (
        <tr className="border-b border-amber-100 bg-amber-50/60">
          <td colSpan={6} className="px-4 py-3">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-end">
              <label className="min-w-0 flex-1 text-xs font-medium text-slate-700">
                Motivo para pausar {district.district}
                <input
                  autoFocus
                  value={pauseReason}
                  onChange={(event) => setPauseReason(event.target.value)}
                  placeholder="Ej. Capacidad completa o zona temporalmente restringida"
                  className="mt-1 block h-10 w-full rounded-lg border border-amber-200 bg-white px-3 text-sm text-slate-900 outline-none placeholder:text-slate-400 focus:border-amber-500 focus:ring-2 focus:ring-amber-100"
                />
              </label>
              <label className="text-xs font-medium text-slate-700">
                Reactivar después de esta fecha (opcional)
                <input
                  type="date"
                  min={today()}
                  value={pausedUntil}
                  onChange={(event) => setPausedUntil(event.target.value)}
                  className="mt-1 block h-10 rounded-lg border border-amber-200 bg-white px-3 text-sm text-slate-900 outline-none focus:border-amber-500 focus:ring-2 focus:ring-amber-100"
                />
              </label>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={pending || pauseReason.trim().length < 4}
                  onClick={() => {
                    onAvailability({
                      orgId,
                      providerId,
                      agreementId,
                      districtKey: district.district_key,
                      status: "paused",
                      reason: pauseReason,
                      pausedUntil,
                    });
                    setShowPauseForm(false);
                  }}
                  className="h-10 rounded-lg bg-amber-600 px-4 text-sm font-semibold text-white transition hover:bg-amber-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 focus-visible:ring-offset-2 disabled:opacity-50"
                >
                  Confirmar pausa
                </button>
                <button
                  type="button"
                  onClick={() => setShowPauseForm(false)}
                  className="h-10 rounded-lg px-3 text-sm font-medium text-slate-600 transition hover:bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400"
                >
                  Cancelar
                </button>
              </div>
            </div>
            <p className="mt-2 text-xs text-slate-600">
              Solo bloquea asignaciones nuevas. Las rutas que ya comenzaron continúan sin cambios.
            </p>
          </td>
        </tr>
      )}
    </>
  );
}

function formatDate(value: string): string {
  const [year, month, day] = value.split("-");
  return `${day}/${month}/${year}`;
}

function formatTimestampDate(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value.slice(0, 10);
  return new Intl.DateTimeFormat("es-PE", {
    timeZone: "America/Lima",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(parsed);
}

function MoneyInput({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="relative inline-block">
      <span className="sr-only">{label}</span>
      <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-xs text-slate-400">S/</span>
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        inputMode="decimal"
        aria-label={label}
        placeholder="0.00"
        className="h-9 w-24 rounded-lg border border-slate-200 bg-white pl-8 pr-2 text-right text-sm tabular-nums outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
      />
    </label>
  );
}
