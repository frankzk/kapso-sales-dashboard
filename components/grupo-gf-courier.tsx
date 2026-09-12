"use client";

import mobile from "./courier-mobile.module.css";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Card, cn, STICKY_HEAD, TABLE_WRAP_FROM } from "@/components/ui";
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
  type CourierRouteSummary,
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

export function GrupoGfCourierBoard({
  orgId,
  snapshot,
}: {
  orgId: string;
  snapshot: CourierConfigSnapshot;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const searchParams = useSearchParams();
  const [tab, setTab] = useState<"available" | "preparation" | "routes" | "tariffs">(
    searchParams.get("tab") === "routes" ? "routes" : "available",
  );

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
      <header className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">
            Operación logística
          </p>
          <h1 className="mt-1 text-xl font-semibold text-slate-950">Grupo GF Courier</h1>
          <p className="mt-1 hidden max-w-3xl text-sm text-slate-600 sm:block">
            Toma pedidos de Aurela y Kenku. Almacén arma cada caja y el mismo QR acompaña toda la entrega.
          </p>
        </div>
        <details className="rounded-xl border border-slate-200 bg-white px-3 text-sm lg:min-w-80"><summary className="min-h-12 cursor-pointer py-3 font-medium text-slate-600">Condiciones del servicio</summary><div className="grid grid-cols-3 divide-x divide-slate-200 pb-3">
          <Summary label="Corte" value={provider.same_day_cutoff.slice(0, 5)} />
          <Summary label="Yape" value={`${snapshot.yapePercentage} %`} />
          <Summary label="Efectivo máximo" value={money(provider.cash_limit_amount)} />
        </div></details>
      </header>

      <nav aria-label="Secciones de Grupo GF Courier" className="grid grid-cols-4 gap-1 border-b border-slate-200 sm:flex">
        <CourierTab
          active={tab === "available"}
          onClick={() => setTab("available")}
          label="Pedidos disponibles"
          shortLabel="Disponibles"
          count={snapshot.operations.available.length}
        />
        <CourierTab
          active={tab === "preparation"}
          onClick={() => setTab("preparation")}
          label="Pedidos tomados"
          shortLabel="Tomados"
          count={snapshot.operations.accepted.length}
        />
        <CourierTab
          active={tab === "routes"}
          onClick={() => setTab("routes")}
          label="Rutas operativas"
          shortLabel="Rutas"
          count={new Set(snapshot.operations.routes.map((route) => `${route.riderId}:${route.routeDate}`)).size}
        />
        <CourierTab
          active={tab === "tariffs"}
          onClick={() => setTab("tariffs")}
          label="Tarifario"
        />
      </nav>

      {error && <p role="alert" className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p>}
      {notice && <p className="rounded-xl bg-emerald-50 px-4 py-3 text-sm text-emerald-700">{notice}</p>}

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
        <CourierRoutes
          routes={snapshot.operations.routes}
          unassignedCount={snapshot.operations.accepted.filter((order) => !order.route).length}
          onShowUnassigned={() => setTab("preparation")}
        />
      )}
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
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className={cn(
        "relative flex min-h-14 min-w-0 flex-col items-center justify-center gap-1 px-1 py-2 text-xs font-semibold sm:flex-row sm:px-3 sm:text-sm transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2",
        active ? "text-brand-700" : "text-slate-500 hover:text-slate-800",
      )}
    >
      <span className={shortLabel ? "hidden sm:inline" : ""}>{label}</span>{shortLabel && <span className="sm:hidden">{shortLabel}</span>}
      {count != null && (
        <span className={cn(
          "rounded-full px-1.5 py-0.5 text-xs tabular-nums sm:ml-1",
          active ? "bg-brand-50 text-brand-700" : "bg-slate-100 text-slate-600",
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
        <div className="relative z-20 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-brand-200 bg-brand-50 px-4 py-3 shadow-sm">
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
                  <Link href={`/dashboard/pedidos?q=${encodeURIComponent(order.orderName)}`} className="font-semibold text-slate-950 hover:text-brand-700">
                    {order.orderName}
                  </Link>
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
    run(() => assignGroupGfCourierRoute(orgId, riderId, requestIds));
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
                    <Link href={`/dashboard/pedidos?q=${encodeURIComponent(order.orderName)}`} className="font-semibold text-slate-950 hover:text-brand-700">{order.orderName}</Link>
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

function routeStateLabel(state: string): string {
  return ({
    draft: "Planificada",
    office_check: "Cotejo en almacén",
    ready_for_pickup: "Caja lista",
    pickup_check: "Recibiendo motorizado",
    in_custody: "En reparto",
  } as Record<string, string>)[state] ?? state;
}

function CourierRoutes({
  routes,
  unassignedCount,
  onShowUnassigned,
}: {
  routes: CourierRouteSummary[];
  unassignedCount: number;
  onShowUnassigned: () => void;
}) {
  return (
    <section aria-labelledby="courier-routes-title" className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 id="courier-routes-title" className="text-base font-semibold text-slate-950">Rutas y cajas operativas</h2>
          <p className="mt-1 max-w-4xl text-sm leading-6 text-slate-600">
            Abre la caja del motorizado para verificar sus paquetes y registrar la recepción.
          </p>
        </div>
        {unassignedCount > 0 && (
          <button
            type="button"
            onClick={onShowUnassigned}
            className="h-10 rounded-lg border border-amber-200 bg-amber-50 px-3 text-sm font-semibold text-amber-800 transition hover:bg-amber-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
          >
            {unassignedCount} pedido{unassignedCount === 1 ? "" : "s"} sin ruta →
          </button>
        )}
      </div>

      <div className="space-y-3 md:hidden" aria-label="Cajas operativas">
        {routes.map((route) => <article key={route.manifestId} className="rounded-xl border border-slate-200 bg-white p-4">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div><h3 className="text-base font-semibold text-slate-950">{route.riderName}</h3><p className="mt-1 text-sm text-slate-600">{formatDate(route.routeDate)} · Carga {route.loadNumber ?? 1}</p></div>
            <span className="rounded-md bg-slate-100 px-2 py-1 text-xs font-semibold text-slate-700">{routeStateLabel(route.state)}</span>
          </div>
          <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
            <div className="flex justify-between gap-2"><dt className="text-slate-600">Asignados</dt><dd className="font-semibold tabular-nums">{route.assignedCount}</dd></div>
            <div className="flex justify-between gap-2"><dt className="text-slate-600">Armados</dt><dd className="font-semibold tabular-nums">{route.armedCount}</dd></div>
            <div className="flex justify-between gap-2"><dt className="text-slate-600">Verificados</dt><dd className="font-semibold tabular-nums">{route.officeCheckedCount}</dd></div>
            <div className="flex justify-between gap-2"><dt className="text-slate-600">Recibidos</dt><dd className="font-semibold tabular-nums">{route.pickupCheckedCount}</dd></div>
          </dl>
          <progress aria-label={`Verificación de la caja de ${route.riderName}`} max={route.assignedCount || 1} value={route.officeCheckedCount} className="mt-3 h-2 w-full accent-brand-600" />
          <Link href={`/dashboard/courier/rutas?manifiesto=${encodeURIComponent(route.manifestId)}`} className="mt-3 flex min-h-12 items-center justify-center rounded-xl bg-brand-600 px-4 text-sm font-semibold text-white hover:bg-brand-700 focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2">
            {route.state === "in_custody" ? "Ver caja recibida" : route.state === "ready_for_pickup" || route.state === "pickup_check" ? "Recibir carga" : "Verificar caja"}
          </Link>
          {route.deliveryRouteId && route.state === "in_custody" && <Link href={`/dashboard/rutas?id=${route.deliveryRouteId}`} className="mt-2 flex min-h-12 items-center justify-center text-sm font-semibold text-brand-700">Ver reparto y liquidación</Link>}
        </article>)}
        {!routes.length && <p className="rounded-xl border border-dashed border-slate-300 p-5 text-sm text-slate-600">Todavía no hay rutas. Asigna pedidos a un motorizado desde Pedidos tomados.</p>}
      </div>
      <div className={cn(TABLE_WRAP_FROM[980], "hidden rounded-xl border border-slate-200 bg-white shadow-sm md:block")}>
        <table className="w-full min-w-[980px] text-sm">
          <thead className={STICKY_HEAD}>
            <tr className="text-left text-xs text-slate-500">
              <th className="px-4 py-3 font-medium">Motorizado / caja</th>
              <th className="px-3 py-3 font-medium">Situación</th>
              <th className="px-3 py-3 text-center font-medium">Asignados</th>
              <th className="px-3 py-3 text-center font-medium">Armados</th>
              <th className="px-3 py-3 text-center font-medium">Cotejados</th>
              <th className="px-3 py-3 text-center font-medium">Recibidos</th>
              <th className="px-4 py-3 font-medium">Avance físico</th>
              <th className="px-4 py-3 text-right font-medium">Acción</th>
            </tr>
          </thead>
          <tbody>
            {routes.map((route) => {
              const progress = route.assignedCount
                ? Math.round((route.officeCheckedCount / route.assignedCount) * 100)
                : 0;
              return (
                <tr key={route.manifestId} className="border-b border-slate-100 last:border-0">
                  <td className="px-4 py-3">
                    <p className="font-semibold text-slate-950">{route.riderName}</p>
                    <p className="mt-0.5 text-xs text-slate-500">{formatDate(route.routeDate)} · Carga {route.loadNumber ?? 1}</p>
                  </td>
                  <td className="px-3 py-3">
                    <span className="rounded-md bg-slate-100 px-2 py-1 text-xs font-semibold text-slate-700">
                      {routeStateLabel(route.state)}
                    </span>
                  </td>
                  <td className="px-3 py-3 text-center font-semibold tabular-nums text-slate-900">{route.assignedCount}</td>
                  <td className="px-3 py-3 text-center font-semibold tabular-nums text-sky-700">{route.armedCount}</td>
                  <td className="px-3 py-3 text-center font-semibold tabular-nums text-emerald-700">{route.officeCheckedCount}</td>
                  <td className="px-3 py-3 text-center font-semibold tabular-nums text-violet-700">{route.pickupCheckedCount}</td>
                  <td className="px-4 py-3">
                    <div className="flex min-w-44 items-center gap-3">
                      <div className="h-2 flex-1 overflow-hidden rounded-full bg-slate-100" aria-hidden="true">
                        <div className="h-full rounded-full bg-emerald-500" style={{ width: `${progress}%` }} />
                      </div>
                      <span className="w-9 text-right text-xs font-semibold tabular-nums text-slate-600">{progress}%</span>
                    </div>
                    <p className="mt-1 text-xs text-slate-500">
                      {route.armedCount < route.assignedCount
                        ? `${route.assignedCount - route.armedCount} por armar`
                        : route.officeCheckedCount < route.assignedCount
                          ? `${route.assignedCount - route.officeCheckedCount} por cotejar`
                          : "Caja cotejada al 100 %"}
                    </p>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <Link
                      href={`/dashboard/courier/rutas?manifiesto=${encodeURIComponent(route.manifestId)}`}
                      className="inline-flex h-9 items-center rounded-lg bg-slate-950 px-3 text-sm font-semibold text-white transition hover:bg-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 focus-visible:ring-offset-2"
                    >
                      Abrir caja
                    </Link>
                    {route.deliveryRouteId && route.state === "in_custody" && <Link href={`/dashboard/rutas?id=${route.deliveryRouteId}`} className="mt-2 block text-xs font-semibold text-brand-700">Ver reparto y liquidación</Link>}
                  </td>
                </tr>
              );
            })}
            {!routes.length && (
              <tr>
                <td colSpan={8} className="px-6 py-16 text-center">
                  <p className="font-medium text-slate-800">Todavía no hay rutas operativas.</p>
                  <p className="mt-1 text-sm text-slate-500">Asigna pedidos desde “Pedidos tomados” para crear la caja diaria del motorizado.</p>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <p className="text-xs leading-5 text-slate-500">
        “Armado” viene de Almacén. “Cotejado” es el primer control físico de la caja; “Recibido” es el segundo control del motorizado.
      </p>
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
