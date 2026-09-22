"use client";

// Despacho del día (MOM §29.13): dos pasos en una pantalla.
//   1 · Asignar: la cola de Lima (disponibles + tomados sin ruta) → un
//       motorizado, con tomar+asignar en una sola acción.
//   2 · Cotejar: las cajas de hoy por motorizado, con el cotejo de oficina en
//       línea, y quitar o mover un paquete desde la misma fila.
// Antes esto eran tres pantallas y 9-10 clics (docs/plan/despacho-crm.md).
// Absorbe lo que aportaban las pestañas «Pedidos disponibles» y «Pedidos
// tomados» (retiradas): teléfono y fecha en la fila, «2.º intento», los
// excluidos con motivo, el picker de filtros y los estados del paquete en
// cada caja. Las tiles de métricas son esos mismos filtros con su cantidad.

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { OrderLink } from "@/components/order-link";
import { useRouter } from "next/navigation";
import { cn, STICKY_HEAD } from "@/components/ui";
import { Hint } from "@/components/hint";
import { Chip, CountChip, Sheet } from "@/components/filter-sheet";
import { ScanAction } from "@/components/scan-action";
import { activeDispatchItems } from "@/lib/dispatch";
import {
  activeFilterCount,
  BLOCKED_REASON_LABEL,
  BOX_ITEM_FILTERS,
  BOX_TILE_LABEL,
  boxNextStep,
  boxTileCounts,
  CREATED_WINDOW_LABEL,
  dayBoxes,
  declinedPackages,
  EMPTY_QUEUE_FILTERS,
  filterBoxItems,
  filterQueue,
  limaDay,
  PACKAGE_STAGE_LABEL,
  packageStage,
  QUEUE_TILE_LABEL,
  queueFacetCounts,
  queueSubstageOptions,
  queueTileActive,
  queueTileCounts,
  SCHEDULED_BUCKET_LABEL,
  SCHEDULED_BUCKETS,
  setStages,
  splitAssignment,
  toggleBoxTile,
  toggleInList,
  toggleQueueTile,
  type BoxItemFilter,
  type BoxTile,
  type CreatedWindow,
  type DayManifest,
  type QueueFilters,
  type QueueRow,
  type QueueTile,
  type RiderBox,
} from "@/lib/dispatch-day";
import { macroStageLabel, macroSubstageLabel, ORDER_MACRO_STAGES } from "@/lib/order-macro-stage";
import { addToTray, removeFromTray, type TrayEntry } from "@/lib/dispatch-scan-tray";
import type { DispatchManifest } from "@/lib/dispatch-access";
import type { RiderPickupMode } from "@/lib/grupo-gf-courier";
import {
  assignGroupGfCourierRoute,
  moveManifestItem,
  scanAssignToRider,
  takeAndAssignGroupGfCourierOrders,
  type ScanAssignLine,
  type CourierAcceptedOrder,
  type CourierActionResult,
  type CourierAvailableOrder,
  type CourierBlockedOrder,
  type CourierRiderOption,
} from "@/app/dashboard/courier/actions";
import { removeManifestItem, scanManifestItem } from "@/app/dashboard/pedidos/despacho/actions";

interface Props {
  orgId: string;
  day: string;
  available: CourierAvailableOrder[];
  accepted: CourierAcceptedOrder[];
  /** Pedidos de Lima que no entran en la cola, con su motivo («sin condiciones»). */
  blocked: CourierBlockedOrder[];
  riders: CourierRiderOption[];
  manifests: DispatchManifest[];
  canManageDispatch: boolean;
  /** 0177: exigir (verifica su caja antes de la ruta) · confirmar («Lo llevo» por paquete) · ninguno. */
  riderPickupMode: RiderPickupMode;
  /** Umbrales de efectivo de la ruta (MOM §29.9): aviso y límite. */
  cashWarning: number;
  cashLimit: number;
  pending: boolean;
  run: (action: () => Promise<CourierActionResult>) => void;
}

const money = (n: number) => `S/ ${n.toFixed(2)}`;
/** Sin decimales, para las líneas de una sola fila. */
const moneyShort = (n: number) => `S/ ${Math.round(n).toLocaleString("es-PE")}`;
const HELP_KEY = "kapta.despacho.ayuda-escaneo";

export function DispatchDayBoard(props: Props) {
  const { orgId, day, riders, canManageDispatch, pending, run } = props;
  const router = useRouter();
  // Sin motorizado preseleccionado: elegirlo es el primer gesto del supervisor.
  // Preseleccionar al primero de la lista mandaba paquetes a la caja de quien
  // tocara. Lo que se escanea antes de elegir espera en la bandeja.
  const [riderId, setRiderId] = useState("");
  const [overrideCash, setOverrideCash] = useState(false);
  // Una sola fuente de verdad para el filtrado de la lista: el picker, los
  // chips y las tiles de métricas leen y escriben `filters`.
  const [filters, setFilters] = useState<QueueFilters>(EMPTY_QUEUE_FILTERS);
  // La lista se pinta por tandas de 100 para no cargar 1.600 filas de golpe;
  // «Mostrar 100 más» amplía. Cambiar el filtro vuelve a la primera tanda.
  const [limit, setLimit] = useState(100);
  const patchFilters = (patch: Partial<QueueFilters>) => { setFilters((cur) => ({ ...cur, ...patch })); setLimit(100); };
  // Dos formas de asignar, una a la vista: por QR (con el paquete en la mano)
  // o desde la lista. Abrir una pliega la otra; el motorizado es común.
  // Tres pestañas en una sola columna: QR, lista y cajas. Antes las cajas
  // iban en una segunda columna y la lista se quedaba con media pantalla.
  const [method, setMethod] = useState<"qr" | "lista" | "cajas">("qr");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [blockedOpen, setBlockedOpen] = useState(false);
  // Filtro rápido de las cajas (Todos · Por armar · Listos para cotejo · Sin
  // confirmar): compartido por todas las cajas y por las tiles.
  const [boxFilter, setBoxFilter] = useState<BoxItemFilter>("todos");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [openBox, setOpenBox] = useState<string | null>(null);
  // Modo escaneo (§29.13): la vía principal. Fecha de la caja, hoy por defecto.
  const [scanDay, setScanDay] = useState(day);
  const [dayOpen, setDayOpen] = useState(false);
  // Una línea de ayuda bajo el campo de código que se cierra y no vuelve.
  const [helpDismissed, setHelpDismissed] = useState(true);
  useEffect(() => {
    try {
      setHelpDismissed(window.localStorage.getItem(HELP_KEY) === "1");
    } catch {
      setHelpDismissed(false);
    }
  }, []);
  const dismissHelp = () => {
    setHelpDismissed(true);
    try {
      window.localStorage.setItem(HELP_KEY, "1");
    } catch {
      /* sin almacenamiento: se cierra solo en esta vista */
    }
  };
  const [lines, setLines] = useState<ScanAssignLine[]>([]);
  const [tray, setTray] = useState<TrayEntry[]>([]);
  const [draining, setDraining] = useState(false);

  function pushLine(line: ScanAssignLine) {
    setLines((cur) => [line, ...cur].slice(0, 200));
    if (line.status === "asignado" || line.status === "ya_en_caja") router.refresh();
  }

  /** «Escanear primero»: al elegir motorizado, la bandeja se vacía en la caja de una vez. */
  async function drainTray(targetRiderId: string) {
    if (!targetRiderId || !tray.length || draining) return;
    setDraining(true);
    try {
      for (const entry of tray) {
        const line = await scanAssignToRider(orgId, targetRiderId, entry.code, { overrideCash, scheduledFor: scanDay });
        setLines((cur) => [line, ...cur].slice(0, 200));
        setTray((cur) => removeFromTray(cur, entry.code));
      }
      router.refresh();
    } finally {
      setDraining(false);
    }
  }

  const queue = useMemo<QueueRow[]>(() => {
    const taken: QueueRow[] = props.accepted
      .filter((o) => !o.route)
      .map((o) => ({
        orderId: o.orderId,
        orderName: o.orderName,
        storeName: o.storeName,
        customerName: o.customerName,
        customerPhone: o.customerPhone,
        district: o.district,
        orderTotal: o.orderTotal,
        createdAt: o.orderCreatedAt,
        scheduledFor: o.scheduledFor,
        tariffAmount: o.tariffAmount,
        taken: true,
        requestId: o.requestId,
        armed: o.preparationState === "listo_despacho",
        observation: o.observation,
        hasPriorDispatch: Boolean(o.hasPriorDispatch),
        macroStage: o.macroStage,
        macroSubstage: o.macroSubstage,
        assignable: true,
        route: null,
      }));
    const takenIds = new Set(taken.map((t) => t.orderId));
    const free: QueueRow[] = props.available
      .filter((o) => !takenIds.has(o.orderId))
      .map((o) => ({
        orderId: o.orderId,
        orderName: o.orderName,
        storeName: o.storeName,
        customerName: o.customerName,
        customerPhone: o.customerPhone,
        district: o.district,
        orderTotal: o.orderTotal,
        createdAt: o.orderCreatedAt,
        scheduledFor: o.scheduledFor,
        tariffAmount: o.tariffAmount,
        taken: false,
        requestId: null,
        armed: null,
        observation: null,
        hasPriorDispatch: o.hasPriorDispatch,
        macroStage: o.macroStage,
        macroSubstage: o.macroSubstage,
        assignable: true,
        route: null,
      }));
    return [...taken, ...free];
  }, [props.accepted, props.available]);
  // Los que ya salieron con Grupo GF (tienen caja): no se asignan desde aquí,
  // pero cuentan en Etapa y se listan para seguimiento al elegir la suya.
  const tracked = useMemo<QueueRow[]>(() => props.accepted
    .filter((o) => o.route)
    .map((o) => ({
      orderId: o.orderId,
      orderName: o.orderName,
      storeName: o.storeName,
      customerName: o.customerName,
      customerPhone: o.customerPhone,
      district: o.district,
      orderTotal: o.orderTotal,
      createdAt: o.orderCreatedAt,
      scheduledFor: o.scheduledFor,
      tariffAmount: o.tariffAmount,
      taken: true,
      requestId: o.requestId,
      armed: o.preparationState === "listo_despacho",
      observation: o.observation,
      hasPriorDispatch: Boolean(o.hasPriorDispatch),
      macroStage: o.macroStage,
      macroSubstage: o.macroSubstage,
      assignable: false,
      route: o.route && {
        riderName: o.route.riderName,
        routeDate: o.route.routeDate,
        loadNumber: o.route.loadNumber,
        state: o.route.state,
        officeCheckedAt: o.route.officeCheckedAt,
        pickupCheckedAt: o.route.pickupCheckedAt,
      },
    })), [props.accepted]);
  const allRows = useMemo(() => [...queue, ...tracked], [queue, tracked]);

  const stores = useMemo(() => [...new Set(queue.map((q) => q.storeName))].sort(), [queue]);
  const districts = useMemo(() => [...new Set(queue.map((q) => q.district))].sort((a, b) => a.localeCompare(b, "es")), [queue]);
  const filtered = useMemo(() => filterQueue(allRows, filters, day), [allRows, filters, day]);
  // Chips de etapa, subetapa y fecha pactada con su cantidad facetada (cuántas
  // quedarían al tocarlo con el resto de filtros como están). Las subetapas
  // son las de la etapa elegida; sin etapa no se muestran.
  const substageOptions = useMemo(() => queueSubstageOptions(allRows, filters.stages), [allRows, filters.stages]);
  const facets = useMemo(() => queueFacetCounts(allRows, filters, day), [allRows, filters, day]);
  const tracking = filters.stages.length > 0;
  const activeFilters = activeFilterCount(filters);
  const filtersButton = useRef<HTMLButtonElement>(null);
  const visible = filtered.slice(0, limit);
  const visibleAssignable = visible.filter((q) => q.assignable);
  const allVisibleSelected = visibleAssignable.length > 0 && visibleAssignable.every((q) => selected.has(q.orderId));
  const selectedTotal = queue.filter((q) => selected.has(q.orderId)).reduce((sum, q) => sum + q.orderTotal, 0);
  // Las cajas siguen al día elegido arriba («cambiar día»): cambiar la fecha
  // sin ver las cajas de ese día dejaba la impresión de que no se creó nada.
  const boxes = useMemo(() => dayBoxes(props.manifests as unknown as DayManifest[], scanDay), [props.manifests, scanDay]);
  const riderName = riders.find((r) => r.id === riderId)?.fullName ?? "";
  const riderBoxCount = (id: string) => boxes.find((b) => b.riderId === id)?.assigned ?? 0;
  /** Efectivo previsto por motorizado hoy: suma de los pedidos tomados con ruta de ese día. */
  const boxCash = useMemo(() => {
    const out = new Map<string, number>();
    for (const o of props.accepted) {
      if (!o.route || o.route.routeDate !== scanDay || !o.route.riderId) continue;
      out.set(o.route.riderId, (out.get(o.route.riderId) ?? 0) + o.orderTotal);
    }
    return out;
  }, [props.accepted, scanDay]);
  const declined = useMemo(() => declinedPackages(boxes), [boxes]);
  const dayCod = boxes.reduce((sum, b) => sum + b.loads.reduce((s, l) => s + activeDispatchItems(l.items).length, 0), 0);
  const queueTiles = useMemo(() => queueTileCounts(queue), [queue]);
  const boxTiles = useMemo(() => boxTileCounts(boxes), [boxes]);
  /** Tocar una tile de la cola: abre «Desde la lista» con ese filtro (o lo quita). */
  const tapQueueTile = (tile: QueueTile) => {
    setFilters((cur) => toggleQueueTile(cur, tile));
    setLimit(100);
    setMethod("lista");
  };
  /** Tocar una tile de cajas: abre «Cajas de hoy» con ese filtro rápido (o lo quita). */
  const tapBoxTile = (tile: BoxTile) => {
    setBoxFilter((cur) => toggleBoxTile(cur, tile));
    setMethod("cajas");
    if (!openBox && boxes[0]) setOpenBox(boxes[0].riderId ?? boxes[0].riderName);
  };

  function toggle(id: string) {
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function assign() {
    if (!riderId || !selected.size) return;
    const split = splitAssignment(selected, props.available, props.accepted);
    setSelected(new Set());
    run(async () => {
      // Lo que falló se dice como error, en rojo y sin repetirse; lo demás
      // como aviso. Antes todo salía junto en verde, también los rechazos.
      const notices: string[] = [];
      const errors: string[] = [];
      for (let i = 0; i < split.orderIds.length; i += 50) {
        const r = await takeAndAssignGroupGfCourierOrders(orgId, riderId, split.orderIds.slice(i, i + 50), { overrideCash, day: scanDay });
        if (r.error) errors.push(r.error);
        else if (r.notice) notices.push(r.notice);
      }
      if (split.requestIds.length) {
        const r = await assignGroupGfCourierRoute(orgId, riderId, split.requestIds, { overrideCash, day: scanDay });
        if (r.notice) notices.push(r.notice);
        if (r.cashWarning) notices.push(r.cashWarning);
        if (r.error) errors.push(r.error);
        for (const f of r.failed) errors.push(f.error);
      }
      const unique = (list: string[]) => [...new Set(list.filter(Boolean))].join(" ");
      if (errors.length) return { error: unique([...errors, ...notices]) };
      return { notice: unique(notices) || `Asignados a ${riderName}.` };
    });
  }

  const riderTail = props.riderPickupMode === "exigir"
    ? " Él verifica la caja antes de ver la ruta."
    : props.riderPickupMode === "confirmar"
      ? " Él confirma cada paquete al cargarlo en la moto («Lo llevo»)."
      : "";
  const helpText = `Escanea con el paquete en la mano: entra a la caja del motorizado y a su ruta del día elegido arriba.${riderTail}`;

  return (
    <section aria-labelledby="dispatch-day-title" className="space-y-3">
      {/* Cabecera: una sola línea. Fecha · contadores · cambiar día. */}
      <div className="flex items-center gap-2 text-xs text-slate-600">
        <h2 id="dispatch-day-title" className="sr-only">Despacho del día</h2>
        <span className="min-w-0 truncate whitespace-nowrap" title={`${queue.length} por asignar${boxes.length ? ` · ${boxes.length} cajas · ${dayCod} paquetes` : ""}`}>
          <b className="text-slate-900">{scanDay === day ? `Hoy, ${formatDayShort(day)}` : formatDayShort(scanDay)}</b>
          {" · "}<span className="tabular-nums">{queue.length.toLocaleString("es-PE")}</span> por asignar
          {props.blocked.length > 0 && (
            <> · <button type="button" onClick={() => setBlockedOpen(true)} className="min-h-0 p-0 text-amber-700 underline-offset-2 hover:underline" title="Pedidos de Lima que no entran en la cola: tarifa faltante, distrito inválido, servicio pausado o sin salida armable"><span className="tabular-nums">{props.blocked.length.toLocaleString("es-PE")}</span> sin condiciones</button></>
          )}
          {boxes.length > 0 && <> · <span className="tabular-nums">{boxes.length}</span> {boxes.length === 1 ? "caja" : "cajas"} · <span className="tabular-nums">{dayCod}</span> paq.</>}
        </span>
        <Hint label="Cómo funciona el despacho" text={helpText} />
        {dayOpen ? (
          <span className="ml-auto flex shrink-0 items-center gap-1">
            <input type="date" value={scanDay} min={day} onChange={(e) => setScanDay(e.target.value || day)} aria-label="Día de la caja" className="min-h-7 rounded-lg border border-slate-300 px-1 text-xs" />
            <button type="button" onClick={() => { setScanDay(day); setDayOpen(false); }} className="underline">hoy</button>
          </span>
        ) : (
          <button type="button" onClick={() => setDayOpen(true)} className="ml-auto shrink-0 whitespace-nowrap text-slate-400 underline-offset-2 hover:text-slate-700 hover:underline" title="Por defecto la caja es de hoy; elige otro día solo para adelantar cajas">cambiar día</button>
        )}
      </div>

      {/* Tiles de métricas: cada una es un filtro con su cantidad (misma fuente de verdad que el picker). */}
      <div role="group" aria-label="Métricas y filtros del día" className="-mx-1 flex snap-x gap-2 overflow-x-auto px-1 pb-1 xl:mx-0 xl:grid xl:grid-cols-8 xl:overflow-visible xl:px-0">
        {(Object.keys(QUEUE_TILE_LABEL) as QueueTile[]).map((tile) => (
          <Tile key={tile} label={QUEUE_TILE_LABEL[tile].label} hint={QUEUE_TILE_LABEL[tile].hint} value={queueTiles[tile]} active={queueTileActive(filters, tile) && method === "lista"} onClick={() => tapQueueTile(tile)} />
        ))}
        <Tile label="Sin condiciones" hint="Pedidos de Lima que no entran en la cola: tarifa faltante, distrito inválido, servicio pausado o sin salida armable. Abre la lista con el motivo de cada uno." value={props.blocked.length} active={blockedOpen} tone="amber" onClick={() => setBlockedOpen((v) => !v)} />
        {boxes.length > 0 && (Object.keys(BOX_TILE_LABEL) as BoxTile[]).map((tile) => (
          <Tile key={tile} label={BOX_TILE_LABEL[tile].label} hint={BOX_TILE_LABEL[tile].hint} value={boxTiles[tile]} active={boxFilter === tile} onClick={() => tapBoxTile(tile)} />
        ))}
      </div>

      {blockedOpen && (
        <Sheet title={`${props.blocked.length.toLocaleString("es-PE")} sin condiciones para salir`} onClose={() => setBlockedOpen(false)} wide>
          <p className="text-xs text-slate-500">No entran en la cola hasta que se arregle el motivo. Tarifa y pausa se corrigen en el Tarifario; el resto en el pedido o en la caja.</p>
          <ul className="mt-2 max-h-[50vh] divide-y divide-slate-100 overflow-auto text-sm">
            {props.blocked.map((b) => {
              const reason = BLOCKED_REASON_LABEL[b.reason];
              return (
                <li key={b.orderId} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 py-1.5">
                  <OrderLink orderId={b.orderId} className="font-semibold text-slate-950 hover:text-brand-700">{b.orderName}</OrderLink>
                  <span className="text-xs text-slate-500">{b.storeName} · {b.customerName} · {b.district}</span>
                  <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-800">{reason.label}</span>
                  {reason.fix === "tarifario" && <Link href="/dashboard/courier?tab=tariffs" className="text-[11px] text-brand-700 underline">Arreglar en Tarifario</Link>}
                </li>
              );
            })}
            {!props.blocked.length && <li className="py-4 text-center text-xs text-slate-500">Todos los pedidos de Lima tienen condiciones para salir.</li>}
          </ul>
        </Sheet>
      )}

      {declined.length > 0 && (
        <details className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          <summary className="cursor-pointer font-semibold">{declined.length} {declined.length === 1 ? "paquete no recogido" : "paquetes no recogidos"} · vuelven a «por asignar»</summary>
          <ul className="mt-1 space-y-1">
            {declined.map((d) => (
              <li key={`${d.manifestId}:${d.shipmentId}`} className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{d.orderName ?? "Pedido"}</span>
                <span className="text-amber-800/80">{d.customerName} · {d.district}</span>
                <span>· no recogido por <b>{d.riderName}</b>: {d.reason}</span>
              </li>
            ))}
          </ul>
        </details>
      )}

      <div className="min-w-0">
        {/* ── Asignar y cajas, en una sola tarjeta con tres pestañas ── */}
        <div className="min-w-0 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
          <div className="px-4 py-3">
            <div className="flex flex-col gap-2">
              <div className="min-w-0 flex-1">
                <select
                  value={riderId}
                  onChange={(e) => { setRiderId(e.target.value); if (tray.length) void drainTray(e.target.value); }}
                  aria-label="¿Quién sale hoy?"
                  className="min-h-14 w-full rounded-xl border border-slate-300 bg-white px-3 text-base font-medium text-slate-900 focus-visible:outline-none focus-visible:border-brand-500 focus-visible:ring-4 focus-visible:ring-brand-500/15 sm:min-h-12 sm:text-sm"
                >
                  <option value="">¿Quién sale hoy?</option>
                  {riders.map((r) => <option key={r.id} value={r.id}>{r.fullName}</option>)}
                </select>
                {riderId && riderBoxCount(riderId) > 0 && (
                  <p className="mt-1 truncate text-xs text-slate-500">{riderName} · {riderBoxCount(riderId)} en su caja</p>
                )}
              </div>
              <div role="tablist" aria-label="Forma de asignar" className="grid grid-cols-3 rounded-xl bg-slate-100 p-1 text-sm font-medium">
                <button type="button" role="tab" aria-selected={method === "qr"} onClick={() => setMethod("qr")}
                  className={cn("min-h-10 rounded-lg px-3", method === "qr" ? "bg-white text-slate-900 shadow-sm" : "text-slate-500 hover:text-slate-800")}>
                  Asignación por QR
                </button>
                <button type="button" role="tab" aria-selected={method === "lista"} onClick={() => setMethod("lista")}
                  className={cn("min-h-10 rounded-lg px-3", method === "lista" ? "bg-white text-slate-900 shadow-sm" : "text-slate-500 hover:text-slate-800")}>
                  Desde la lista
                </button>
                <button type="button" role="tab" aria-selected={method === "cajas"} onClick={() => setMethod("cajas")}
                  className={cn("flex min-h-10 items-center justify-center gap-2 rounded-lg px-3", method === "cajas" ? "bg-white text-slate-900 shadow-sm" : "text-slate-500 hover:text-slate-800")}>
                  <span className="truncate">{scanDay === day ? "Cajas de hoy" : `Cajas del ${formatDayShort(scanDay)}`}</span>
                  <span className={cn("grid h-5 min-w-5 shrink-0 place-items-center rounded-full px-1.5 text-[11px] font-bold tabular-nums", dayCod ? "bg-brand-600 text-white" : "bg-slate-200 text-slate-600")} title={`${boxes.length} ${boxes.length === 1 ? "caja" : "cajas"} · ${dayCod} paquetes`}>{dayCod}</span>
                </button>
              </div>
              {method === "qr" && (
              <div>
                {canManageDispatch ? (
                  <ScanAction
                    context="supervisor_asignacion"
                    compact
                    continuous
                    progress={riderId ? { done: riderBoxCount(riderId), label: `${riderBoxCount(riderId)} en la caja de ${riderName}` } : undefined}
                    disabled={pending || draining}
                    assign={{ orgId, riderId, scheduledFor: scanDay, overrideCash }}
                    onQueue={(code) => setTray((cur) => addToTray(cur, code))}
                    onResult={(r) => { if (r.line) pushLine(r.line); }}
                  />
                ) : (
                  <p className="text-xs text-amber-700">Tu rol no organiza rutas: puedes mirar, no asignar.</p>
                )}
              </div>
              )}
            </div>
            {method === "qr" && !helpDismissed && canManageDispatch && (
              <p className="mt-2 flex items-center gap-2 text-xs text-slate-500">
                <span className="min-w-0 flex-1">Cada escaneo toma el pedido y lo pone en la caja de {riderName || "quien elijas"}. Después, oficina lo verifica en «Verificar caja».</span>
                <button type="button" onClick={dismissHelp} aria-label="Cerrar ayuda" className="shrink-0 text-slate-400 hover:text-slate-700">×</button>
              </p>
            )}

            {method === "qr" && tray.length > 0 && (
              <div className="mt-2 flex flex-wrap items-center gap-2 rounded-lg bg-sky-50 px-2 py-1.5 text-xs text-sky-900">
                <span><b>{tray.length}</b> en espera de motorizado</span>
                {tray.map((e) => (
                  <span key={e.code} className="flex items-center gap-1 rounded-full bg-white px-2 py-0.5 font-mono">
                    {e.code}
                    <button type="button" aria-label={`Quitar ${e.code}`} onClick={() => setTray((cur) => removeFromTray(cur, e.code))} className="text-slate-400 hover:text-red-600">×</button>
                  </span>
                ))}
                <button type="button" disabled={!riderId || draining} onClick={() => void drainTray(riderId)} className="ml-auto min-h-8 rounded-lg bg-sky-700 px-3 font-semibold text-white disabled:opacity-50">
                  {draining ? "Asignando…" : riderId ? `Asignar a ${riderName}` : "Elige motorizado"}
                </button>
              </div>
            )}

            {method === "qr" && lines.length > 0 && (
              <div className="mt-3">
                <ul className="max-h-72 divide-y divide-slate-100 overflow-auto rounded-xl border border-slate-200" aria-live="polite">
                  {lines.map((l, i) => {
                    const r = scanRowPresentation(l, riderName);
                    return (
                      <li key={`${l.code}:${i}`} className={cn("flex items-center gap-2 px-3 py-1.5 text-sm", r.rowClass)} title={[l.message, l.cashWarning].filter(Boolean).join(" · ")}>
                        <span className="min-w-0 flex-1 truncate">
                          <span className="font-semibold text-slate-900">{l.orderName ?? l.code}</span>
                          <span className={cn("ml-2 text-xs font-medium", r.textClass)}>{r.text}</span>
                        </span>
                        {l.amount != null && <span className="shrink-0 text-xs tabular-nums text-slate-600">{moneyShort(l.amount)}</span>}
                        {l.status === "en_otra_caja" && l.manifestId && l.shipmentId && riderId && (
                          <button type="button" disabled={pending || draining} onClick={() => run(async () => moveManifestItem(orgId, l.manifestId!, l.shipmentId!, riderId, `Escaneado en la caja de ${riderName}`))} className="min-h-8 shrink-0 rounded-lg border border-amber-300 px-2 text-xs font-medium text-amber-800 disabled:opacity-50">Mover</button>
                        )}
                        {l.status === "bloqueado_efectivo" && !overrideCash && (
                          <button type="button" onClick={() => setOverrideCash(true)} title="Autoriza superar el límite de efectivo de la ruta y vuelve a escanear" className="min-h-8 shrink-0 rounded-lg border border-amber-300 px-2 text-xs font-medium text-amber-800">Autorizar</button>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}
            {/* El total de la caja, del servidor: sobrevive a recargar la página
                (la lista de escaneos de arriba es solo de esta sesión). Al doble
                de tamaño para leerlo con la pistola en la mano. */}
            {method === "qr" && riderId && (riderBoxCount(riderId) > 0 || lines.length > 0) && (() => {
              const count = riderBoxCount(riderId);
              const cash = boxCash.get(riderId) ?? 0;
              return (
                <div className={cn("mt-2 flex items-center gap-2", cash >= props.cashLimit ? "text-red-700" : cash >= props.cashWarning ? "text-amber-700" : "text-slate-800")}>
                  <span className="min-w-0 truncate text-[24px] font-medium leading-tight" title={`${count} en la caja de ${riderName} · efectivo previsto ${money(cash)}${cash >= props.cashLimit ? " · supera el límite" : cash >= props.cashWarning ? " · cerca del límite" : ""}${overrideCash ? " · límite autorizado" : ""}`}>
                    <b className="tabular-nums">{count}</b> en la caja de {riderName} · <b className="tabular-nums">{moneyShort(cash)}</b>
                  </span>
                  {lines.length > 0 && <button type="button" onClick={() => setLines([])} className="ml-auto shrink-0 text-xs text-slate-500 underline">Limpiar lista</button>}
                </div>
              );
            })()}
          </div>
          {method === "lista" && (
          <div className="border-t border-slate-100">
          <div className="border-b border-slate-200 px-4 py-3">
            <div className="flex items-center gap-2">
              <input
                value={filters.query}
                onChange={(e) => patchFilters({ query: e.target.value })}
                placeholder="Pedido, cliente, distrito o teléfono"
                aria-label="Buscar en la cola"
                className="min-h-10 min-w-0 flex-1 rounded-lg border border-slate-300 px-3 text-sm"
              />
              <div className="relative">
                <button
                  ref={filtersButton}
                  type="button"
                  onClick={() => setFiltersOpen((v) => !v)}
                  aria-expanded={filtersOpen}
                  aria-haspopup="dialog"
                  className={cn("min-h-10 rounded-lg border px-3 text-sm font-medium", activeFilters ? "border-brand-300 bg-brand-50 text-brand-800" : "border-slate-300 text-slate-700 hover:bg-slate-50")}
                >
                  Filtros{activeFilters ? ` · ${activeFilters}` : ""}
                </button>
                {filtersOpen && (
                  <Sheet title="Filtros" onClose={() => setFiltersOpen(false)} anchored anchorRef={filtersButton}>
                    <div className="grid gap-3 text-sm">
                      {/* Etapa, subetapa y fecha pactada como en el Master, dentro
                          del mismo flotante que tienda y distrito: un solo sitio
                          para filtrar. Etapa cuenta todos los pedidos de Grupo GF;
                          elegir una que no se asigna (En curso, Por cerrar…) lista
                          esos pedidos para seguimiento. Las subetapas aparecen
                          solo con una etapa elegida. */}
                      <div role="group" aria-label="Etapa" className="grid gap-1">
                        <span className="text-xs font-medium text-slate-600">Etapa</span>
                        <div className="grid grid-cols-2 gap-1">
                          {ORDER_MACRO_STAGES.map((stage) => {
                            const count = facets.stage[stage.code] ?? 0;
                            const active = filters.stages.includes(stage.code);
                            return (
                              <button
                                key={stage.code}
                                type="button"
                                aria-pressed={active}
                                disabled={count === 0 && !active}
                                onClick={() => patchFilters(setStages(filters, toggleInList(filters.stages, stage.code)))}
                                title={count === 0 ? "Ningún pedido de Grupo GF en esta etapa" : ["preparacion", "por_despachar"].includes(stage.code) ? undefined : "Ya salieron con Grupo GF: se listan para seguimiento, sin asignar"}
                                className={cn(
                                  "flex min-h-10 items-center gap-2 rounded-lg border px-2 text-left transition",
                                  active ? "border-slate-950 bg-slate-950 text-white" : "border-slate-200 bg-white text-slate-700 hover:border-slate-300",
                                  count === 0 && !active && "cursor-not-allowed opacity-40",
                                )}
                              >
                                <span className={cn("grid h-5 w-5 shrink-0 place-items-center rounded-full text-[10px] font-bold", active ? "bg-white/15 text-white" : "bg-slate-100 text-slate-500")}>{String(stage.order).padStart(2, "0")}</span>
                                <span className="min-w-0">
                                  <span className="block truncate text-xs font-semibold">{stage.label}</span>
                                  <span className={cn("block text-[11px] tabular-nums", active ? "text-slate-300" : "text-slate-400")}>{count.toLocaleString("es-PE")} pedidos</span>
                                </span>
                              </button>
                            );
                          })}
                        </div>
                      </div>
                      {substageOptions.length > 0 && (
                      <div role="group" aria-label="Subetapas" className="grid gap-1">
                        <span className="text-xs font-medium text-slate-600">Subetapas</span>
                        <div className="flex flex-wrap gap-1.5">
                          {substageOptions.map((opt) => (
                            <CountChip
                              key={opt.substage}
                              label={opt.substage === "sin_subetapa" ? "Sin subetapa" : macroSubstageLabel(opt.substage)}
                              count={facets.substage[opt.substage] ?? 0}
                              active={filters.substages.includes(opt.substage)}
                              title={opt.stage ? `${macroStageLabel(opt.stage)} · ${macroSubstageLabel(opt.substage)}` : undefined}
                              onClick={() => patchFilters({ substages: toggleInList(filters.substages, opt.substage) })}
                            />
                          ))}
                        </div>
                      </div>
                      )}
                      <div role="group" aria-label="Fecha pactada" className="grid gap-1">
                        <span className="flex items-center gap-1 text-xs font-medium text-slate-600">
                          Fecha pactada
                          <Hint label="Qué es la fecha pactada" text="Fecha pactada de salida: la de la solicitud ya tomada o, si el pedido sigue disponible, hoy o mañana según el corte de las 11:30. «Vencidos» son tomados cuya salida ya pasó." />
                        </span>
                        <div className="flex flex-wrap gap-1.5">
                          {SCHEDULED_BUCKETS.map((bucket) => (
                            <CountChip key={bucket} label={SCHEDULED_BUCKET_LABEL[bucket]} count={facets.due[bucket]} active={filters.due.includes(bucket)} onClick={() => patchFilters({ due: toggleInList(filters.due, bucket) })} />
                          ))}
                        </div>
                      </div>
                      <label className="grid gap-1 text-xs font-medium text-slate-600">Tienda
                        <select value={filters.store} onChange={(e) => patchFilters({ store: e.target.value })} className="block min-h-10 w-full min-w-0 rounded-lg border border-slate-300 px-2 text-sm text-slate-900">
                          <option value="">Todas</option>
                          {stores.map((st) => <option key={st} value={st}>{st}</option>)}
                        </select>
                      </label>
                      <label className="grid gap-1 text-xs font-medium text-slate-600">Distrito
                        <select value={filters.district} onChange={(e) => patchFilters({ district: e.target.value })} className="block min-h-10 w-full min-w-0 rounded-lg border border-slate-300 px-2 text-sm text-slate-900">
                          <option value="">Todos</option>
                          {districts.map((d) => <option key={d} value={d}>{d}</option>)}
                        </select>
                      </label>
                      <label className="grid gap-1 text-xs font-medium text-slate-600">Fecha de creación
                        <select value={filters.created} onChange={(e) => patchFilters({ created: e.target.value as CreatedWindow })} className="block min-h-10 w-full min-w-0 rounded-lg border border-slate-300 px-2 text-sm text-slate-900">
                          <option value="todo">Todo</option>
                          <option value="hoy">Hoy</option>
                          <option value="ayer">Ayer</option>
                          <option value="7d">Últimos 7 días</option>
                        </select>
                      </label>
                      <label className="flex min-h-10 items-center gap-2"><input type="checkbox" checked={filters.secondAttempt} onChange={(e) => patchFilters({ secondAttempt: e.target.checked })} /> Solo con salida previa</label>
                      <label className="flex min-h-10 items-center gap-2"><input type="checkbox" checked={filters.armedOnly} onChange={(e) => patchFilters({ armedOnly: e.target.checked })} /> Solo armados</label>
                      <label className="flex min-h-10 items-center gap-2"><input type="checkbox" checked={filters.takenOnly} onChange={(e) => patchFilters({ takenOnly: e.target.checked })} /> Solo tomados sin caja</label>
                      {activeFilters > 0 && <button type="button" onClick={() => patchFilters({ ...EMPTY_QUEUE_FILTERS, query: filters.query })} className="min-h-10 rounded-lg border border-slate-300 px-3 text-sm font-medium text-slate-700">Quitar filtros</button>}
                    </div>
                  </Sheet>
                )}
              </div>
            </div>
            <p className="mt-2 text-xs tabular-nums text-slate-500">
              <b className="text-slate-900">{filtered.length.toLocaleString("es-PE")}</b> {tracking ? "pedidos en esa etapa" : "en cola"}{filtered.length > visible.length ? ` · se muestran ${visible.length}` : ""}
            </p>
            {activeFilters > 0 && (
              <ul className="mt-1 flex flex-wrap gap-1.5 text-xs" aria-label="Filtros activos">
                {filters.store && <Chip onRemove={() => patchFilters({ store: "" })}>{filters.store}</Chip>}
                {filters.district && <Chip onRemove={() => patchFilters({ district: "" })}>{filters.district}</Chip>}
                {filters.created !== "todo" && <Chip onRemove={() => patchFilters({ created: "todo" })}>{CREATED_WINDOW_LABEL[filters.created]}</Chip>}
                {filters.secondAttempt && <Chip onRemove={() => patchFilters({ secondAttempt: false })}>con salida previa</Chip>}
                {filters.armedOnly && <Chip onRemove={() => patchFilters({ armedOnly: false })}>armados</Chip>}
                {filters.takenOnly && <Chip onRemove={() => patchFilters({ takenOnly: false })}>tomados sin caja</Chip>}
                {filters.stages.map((code) => <Chip key={code} onRemove={() => patchFilters({ stages: toggleInList(filters.stages, code) })}>{code === "sin_etapa" ? "sin etapa" : macroStageLabel(code)}</Chip>)}
                {filters.substages.map((code) => <Chip key={code} onRemove={() => patchFilters({ substages: toggleInList(filters.substages, code) })}>{code === "sin_subetapa" ? "sin subetapa" : macroSubstageLabel(code).toLocaleLowerCase("es")}</Chip>)}
                {filters.due.map((bucket) => <Chip key={bucket} onRemove={() => patchFilters({ due: toggleInList(filters.due, bucket) })}>salida: {SCHEDULED_BUCKET_LABEL[bucket].toLocaleLowerCase("es")}</Chip>)}
              </ul>
            )}
          </div>

          <div className="sticky top-0 z-10 flex flex-wrap items-center gap-2 border-b border-slate-200 bg-slate-50 px-4 py-2">
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={allVisibleSelected} disabled={!visibleAssignable.length} onChange={() => setSelected(allVisibleSelected ? new Set() : new Set(visibleAssignable.map((q) => q.orderId)))} aria-label="Marcar los visibles" />
              <span className="font-medium text-slate-800">{selected.size ? `${selected.size} marcados · ${money(selectedTotal)}` : "Marca pedidos"}</span>
            </label>
            <button
              type="button"
              disabled={pending || !canManageDispatch || !riderId || !selected.size}
              onClick={assign}
              title={riderId ? undefined : "Elige el motorizado arriba"}
              className="min-h-10 max-w-full truncate rounded-lg bg-brand-600 px-4 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50"
            >
              {pending ? "Asignando…" : `Asignar${selected.size ? ` ${selected.size}` : ""} a ${riderName || "…"}`}
            </button>
            <label className="flex items-center gap-1 text-xs text-slate-600" title="Límite de efectivo de la ruta (MOM §29.9)">
              <input type="checkbox" checked={overrideCash} onChange={(e) => setOverrideCash(e.target.checked)} /> <span className="whitespace-nowrap">superar el límite</span>
            </label>
          </div>

          {/* Tabla de columnas, como el Master: anchos fijos para lo corto
              (fechas, importes) y flexibles para pedido, cliente y estado. Lo
              que se trunca lleva el texto completo en `title`. En pantallas
              estrechas la tabla desplaza en horizontal. */}
          <div className="max-h-[60vh] overflow-auto">
            <table className={cn("w-full min-w-[880px] table-fixed border-collapse text-sm", STICKY_HEAD)}>
              <colgroup>
                <col className="w-9" />
                <col className="w-[8.5rem]" />
                <col className="w-[6.5rem]" />
                <col />
                <col className="w-[8rem]" />
                <col />
                <col className="w-[4.25rem]" />
                <col className="w-[5rem]" />
                <col className="w-[5.5rem]" />
                <col className="w-[4.5rem]" />
              </colgroup>
              <thead>
                <tr className="text-left text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                  <th className="px-3 py-2"><span className="sr-only">Marcar</span></th>
                  <th className="px-3 py-2">Pedido</th>
                  <th className="px-3 py-2">Tienda</th>
                  <th className="px-3 py-2">Cliente</th>
                  <th className="px-3 py-2">Distrito</th>
                  <th className="px-3 py-2">Estado</th>
                  <th className="px-3 py-2">Creado</th>
                  <th className="px-3 py-2" title="Salida prevista: después del corte de las 11:30 el pedido sale al día siguiente. Para los que ya salieron, el día de su caja.">Sale</th>
                  <th className="px-3 py-2 text-right">Venta</th>
                  <th className="px-3 py-2 text-right">Tarifa</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {visible.map((q) => (
                  <tr key={q.orderId} className={cn("align-top hover:bg-slate-50", selected.has(q.orderId) && "bg-brand-50/60")}>
                    <td className="px-3 py-2">
                      {q.assignable
                        ? <input type="checkbox" checked={selected.has(q.orderId)} onChange={() => toggle(q.orderId)} aria-label={`Marcar ${q.orderName}`} className="mt-0.5" />
                        : <span aria-hidden className="mt-0.5 inline-block h-4 w-4 rounded border border-dashed border-slate-300" title="Ya salió: se sigue, no se asigna" />}
                    </td>
                    <td className="px-3 py-2">
                      <OrderLink orderId={q.orderId} className="block truncate font-semibold text-slate-950 hover:text-brand-700" title={q.orderName}>{q.orderName}</OrderLink>
                      <OrderLink orderId={q.orderId} section="historial" className="text-[11px] text-brand-700 underline">Ver actividad</OrderLink>
                    </td>
                    <td className="truncate px-3 py-2 text-xs text-slate-600" title={q.storeName}>{q.storeName}</td>
                    <td className="px-3 py-2">
                      <p className="truncate text-slate-800" title={q.customerName}>{q.customerName}</p>
                      <p className="truncate text-xs text-slate-500" title={q.customerPhone ?? undefined}>{q.customerPhone ?? "sin teléfono"}</p>
                    </td>
                    <td className="truncate px-3 py-2 text-slate-700" title={q.district}>{q.district}</td>
                    <td className="px-3 py-2">
                      <div className="flex flex-wrap items-center gap-1">
                        {q.taken && !q.route && <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-700">tomado · sin caja</span>}
                        {!q.assignable && q.macroSubstage && <span className="rounded-full bg-sky-100 px-2 py-0.5 text-[11px] font-medium text-sky-800" title={macroStageLabel(q.macroStage)}>{macroSubstageLabel(q.macroSubstage)}</span>}
                        {q.taken && q.armed && <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700">armado</span>}
                        {q.hasPriorDispatch && <span className="rounded-full bg-violet-50 px-2 py-0.5 text-[11px] font-medium text-violet-800" title="Ya tuvo al menos una salida física y volvió; revísalo como reprogramación o recuperación">salida previa</span>}
                        {q.observation && <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-800" title={q.observation}>observado</span>}
                        {!q.taken && !q.hasPriorDispatch && !q.observation && <span className="text-xs text-slate-400">disponible</span>}
                      </div>
                      {q.route && (
                        <p className="mt-0.5 truncate text-xs text-slate-600" title={`${q.route.riderName} · caja del ${formatDayNumeric(q.route.routeDate)}${q.route.loadNumber > 1 ? ` · carga ${q.route.loadNumber}` : ""}`}>
                          <b>{q.route.riderName}</b>{q.route.loadNumber > 1 ? ` · carga ${q.route.loadNumber}` : ""}
                          {" · "}{q.route.pickupCheckedAt ? "lo lleva" : q.route.officeCheckedAt ? "cotejado · sin «Lo llevo»" : "en la caja · sin cotejar"}
                        </p>
                      )}
                    </td>
                    <td className="px-3 py-2 text-xs tabular-nums text-slate-600" title={q.createdAt ? `Creado el ${formatDay(limaDay(q.createdAt) ?? q.createdAt)}` : undefined}>{q.createdAt ? formatDayNumeric(limaDay(q.createdAt)) : "—"}</td>
                    <td className="px-3 py-2 text-xs tabular-nums text-slate-600" title={q.route ? `Caja del ${formatDay(q.route.routeDate)}` : `Salida prevista: ${formatDay(q.scheduledFor)}`}>
                      {q.route ? `caja ${formatDayNumeric(q.route.routeDate)}` : formatDayNumeric(q.scheduledFor)}
                    </td>
                    <td className="px-3 py-2 text-right text-xs font-semibold tabular-nums text-slate-900">{money(q.orderTotal)}</td>
                    <td className="px-3 py-2 text-right text-xs tabular-nums text-slate-600">{money(q.tariffAmount)}</td>
                  </tr>
                ))}
                {!visible.length && <tr><td colSpan={10} className="px-4 py-8 text-center text-sm text-slate-500">{tracking ? "Ningún pedido de Grupo GF con ese filtro." : "Nada por asignar con ese filtro."}</td></tr>}
                {filtered.length > visible.length && (
                  <tr>
                    <td colSpan={10} className="px-4 py-3 text-center">
                      <button type="button" onClick={() => setLimit((n) => n + 100)} className="min-h-10 rounded-lg border border-slate-300 px-4 text-sm font-medium text-slate-700 hover:bg-slate-50">
                        Mostrar 100 más · quedan {(filtered.length - visible.length).toLocaleString("es-PE")}
                      </button>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          </div>
          )}
          {method === "cajas" && (
          <div className="border-t border-slate-100">
            {/* Sin título: la pestaña ya dice «Cajas de hoy». Solo el resumen. */}
            {boxes.length > 0 && (
              <p className="px-4 py-2 text-xs tabular-nums text-slate-500">{boxes.length} {boxes.length === 1 ? "caja" : "cajas"} · {dayCod} paq. · toca una caja para ver sus paquetes</p>
            )}
            {boxes.length ? (
              <ul className="divide-y divide-slate-100 border-t border-slate-100">
                {boxes.map((box) => (
                  <BoxRow
                    key={box.riderId ?? box.riderName}
                    box={box}
                    cash={box.riderId ? (boxCash.get(box.riderId) ?? 0) : 0}
                    riders={riders}
                    orgId={orgId}
                    open={openBox === (box.riderId ?? box.riderName)}
                    onToggle={() => setOpenBox(openBox === (box.riderId ?? box.riderName) ? null : (box.riderId ?? box.riderName))}
                    canManage={canManageDispatch}
                    onChanged={() => router.refresh()}
                    pickupMode={props.riderPickupMode}
                    filter={boxFilter}
                    onFilter={setBoxFilter}
                  />
                ))}
              </ul>
            ) : (
              <p className="px-4 py-8 text-center text-sm text-slate-500">Todavía no hay cajas {scanDay === day ? "hoy" : "ese día"}: escanea o asigna desde la lista.</p>
            )}
          </div>
          )}
        </div>
      </div>
    </section>
  );
}

function BoxRow({ box, cash, riders, orgId, open, onToggle, canManage, onChanged, pickupMode, filter, onFilter }: {
  box: RiderBox;
  /** Efectivo previsto de la caja. */
  cash: number;
  riders: CourierRiderOption[];
  orgId: string;
  open: boolean;
  onToggle: () => void;
  canManage: boolean;
  onChanged: () => void;
  pickupMode: RiderPickupMode;
  /** Filtro rápido compartido: Todos · Por armar · Listos para cotejo · Sin confirmar. */
  filter: BoxItemFilter;
  onFilter: (next: BoxItemFilter) => void;
}) {
  const [pending, start] = useTransition();
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [scanMode, setScanMode] = useState<"oficina_cotejo" | "supervisor_retiro">("oficina_cotejo");
  const load = box.loads[0]!;
  const canCheck = canManage && !["in_custody", "cancelled"].includes(load.state);
  const say = (r: { error?: string; notice?: string }) => {
    setMessage(r.error ? { ok: false, text: r.error } : r.notice ? { ok: true, text: r.notice } : null);
    if (!r.error) onChanged();
  };
  const scan = (manifestId: string, code: string) => start(async () => say(await scanManifestItem(manifestId, code, "office")));
  const remove = (manifestId: string, shipmentId: string) => {
    const reason = window.prompt("¿Por qué se quita este paquete de la caja?");
    if (!reason) return;
    start(async () => say(await removeManifestItem(manifestId, shipmentId, reason)));
  };
  const move = (manifestId: string, shipmentId: string, targetRiderId: string) => {
    const reason = window.prompt("¿Por qué cambia de motorizado?");
    if (!reason) return;
    start(async () => say(await moveManifestItem(orgId, manifestId, shipmentId, targetRiderId, reason)));
  };
  const pct = box.assigned ? Math.round((box.officeChecked / box.assigned) * 100) : 0;
  // Modo «confirmar» (0177): lo asignado que el motorizado aún no confirmó con
  // «Lo llevo». Se puede quitar o mover desde aquí; el RPC borra su parada.
  const confirmMode = pickupMode === "confirmar";
  const unconfirmed = confirmMode
    ? box.loads.filter((m) => m.state === "in_custody").flatMap((m) => activeDispatchItems(m.items).filter((i) => !i.pickup_checked_at).map((i) => ({ manifestId: m.id, item: i })))
    : [];
  return (
    <li>
      <button type="button" onClick={onToggle} aria-expanded={open} title={`${boxNextStep(box)} · ${box.assigned} paquetes · ${box.armed} armados por Almacén · ${box.officeChecked} cotejados en oficina · ${box.pickupChecked} ${confirmMode ? "confirmados con «Lo llevo»" : "recibidos por el motorizado"}${box.declined ? ` · ${box.declined} no los llevó` : ""}${box.loads.length > 1 ? ` · ${box.loads.length} cargas` : ""} · efectivo previsto ${money(cash)}`} className="flex w-full items-center gap-2 px-4 py-2.5 text-left text-sm hover:bg-slate-50">
        <span className="min-w-0 flex-1 truncate whitespace-nowrap">
          <span className="font-semibold text-slate-950">{box.riderName}</span>
          <span className="text-slate-600"> · <span className="tabular-nums">{box.assigned}</span> paq. · <span className="tabular-nums">{moneyShort(cash)}</span></span>
          {/* Cadena de estados del paquete: armado → cotejado → confirmado. */}
          <span className={cn("text-xs tabular-nums", box.armed < box.assigned ? "text-amber-700" : "text-emerald-700")}> · {box.armed} armados</span>
          <span className={cn("text-xs tabular-nums", load.state === "in_custody" ? "text-emerald-700" : box.officeChecked < box.assigned ? "text-amber-700" : "text-sky-700")}> · {box.officeChecked} cotejados</span>
          <span className={cn("text-xs tabular-nums", box.pickupChecked < box.assigned ? "text-amber-700" : "text-emerald-700")}> · {box.pickupChecked} {confirmMode ? "confirmados" : "recibidos"}</span>
          {box.declined ? <span className="text-xs text-amber-700"> · {box.declined} no rec.</span> : null}
        </span>
        <span aria-hidden className="shrink-0 text-slate-400">{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <div className="space-y-3 border-t border-slate-100 bg-slate-50/60 px-4 py-3">
          {message && <p role="status" className={cn("rounded-lg px-3 py-2 text-sm", message.ok ? "bg-emerald-50 text-emerald-800" : "bg-red-50 text-red-700")}>{message.text}</p>}
          <div role="group" aria-label="Filtro rápido de la caja" className="flex flex-wrap gap-1 text-xs">
            {BOX_ITEM_FILTERS.map((f) => (
              <button key={f.id} type="button" onClick={() => onFilter(f.id)} aria-pressed={filter === f.id} className={cn("rounded-full px-3 py-1 font-medium", filter === f.id ? "bg-slate-900 text-white" : "bg-white text-slate-700 ring-1 ring-slate-200 hover:bg-slate-100")}>
                {f.label}
              </button>
            ))}
          </div>
          {confirmMode && unconfirmed.length > 0 && (
            <details className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
              <summary className="cursor-pointer font-semibold">Sin confirmar por {box.riderName} · {unconfirmed.length}</summary>
              <p className="mt-1 text-xs text-amber-800/80">Asignados que todavía no escaneó al sacarlos del almacén. Si no se los llevó, quítalos o muévelos: vuelven a «por asignar».</p>
              <ul className="mt-1 divide-y divide-amber-100">
                {unconfirmed.map(({ manifestId, item }) => {
                  const s = item.shipment;
                  const code = s?.output_code ?? s?.guide_code ?? s?.order_name ?? "";
                  return (
                    <li key={item.id} className="flex items-center gap-2 py-1.5">
                      <span className="min-w-0 flex-1 truncate"><span className="font-medium">{s?.order_name ?? code}</span> <span className="text-xs text-amber-800/80">{s?.customer_name} · {s?.district}</span></span>
                      {canManage && (
                        <>
                          <select
                            aria-label={`Mover ${s?.order_name ?? code} a otro motorizado`}
                            defaultValue=""
                            disabled={pending}
                            onChange={(e) => { const v = e.target.value; e.target.value = ""; if (v) move(manifestId, item.shipment_id, v); }}
                            className="min-h-9 rounded-lg border border-amber-300 bg-white px-1 text-xs"
                          >
                            <option value="">Mover a…</option>
                            {riders.filter((r) => r.id !== box.riderId).map((r) => <option key={r.id} value={r.id}>{r.fullName}</option>)}
                          </select>
                          <button type="button" disabled={pending} onClick={() => remove(manifestId, item.shipment_id)} className="min-h-9 rounded-lg px-2 text-xs font-medium text-red-700 hover:bg-red-100 disabled:opacity-50">Quitar</button>
                        </>
                      )}
                    </li>
                  );
                })}
              </ul>
            </details>
          )}
          {box.loads.map((m) => {
            const active = filterBoxItems(m.items, filter);
            const removed = m.items.filter((i) => !!i.removed_at);
            const checkable = canCheck && !["in_custody", "cancelled"].includes(m.state);
            return (
              <div key={m.id} className="rounded-lg border border-slate-200 bg-white">
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-3 py-2 text-xs">
                  <span className="font-medium text-slate-700">Carga {m.load_number ?? 1} · {stateLabel(m.state)}</span>
                  <Link href={`/dashboard/courier/rutas?manifiesto=${encodeURIComponent(m.id)}`} className="text-brand-700 underline">Abrir en la mesa</Link>
                </div>
                {checkable && (
                  <div className="px-3 pb-2">
                    <div className="mt-2 flex gap-1 text-xs" role="group" aria-label="Qué hace el escaneo">
                      {([["oficina_cotejo", "Cotejar"], ["supervisor_retiro", "Retirar"]] as const).map(([mode, text]) => (
                        <button key={mode} type="button" onClick={() => setScanMode(mode)} aria-pressed={scanMode === mode} className={cn("rounded-full px-3 py-1 font-medium", scanMode === mode ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-700")}>{text}</button>
                      ))}
                    </div>
                    <ScanAction context={scanMode} manifestId={m.id} disabled={pending} onResult={(r) => say(r)} />
                  </div>
                )}
                <ul className="divide-y divide-slate-100">
                  {active.map((item) => {
                    const s = item.shipment;
                    const code = s?.output_code ?? s?.guide_code ?? s?.order_name ?? "";
                    return (
                      <li key={item.id} className={cn("flex items-center gap-2 px-3 py-2 text-sm", item.office_checked_at ? "bg-emerald-50/50" : "")}>
                        <span aria-label={item.office_checked_at ? "Cotejado" : "Pendiente"} className={cn("grid size-5 shrink-0 place-items-center rounded-full text-[11px] font-bold", item.office_checked_at ? "bg-emerald-600 text-white" : "bg-slate-200 text-slate-600")}>{item.office_checked_at ? "✓" : "·"}</span>
                        <div className="min-w-0 flex-1">
                          <p className="truncate font-medium text-slate-900">{s?.order_name ?? code} <span className="text-xs font-normal text-slate-500">{s?.customer_name} · {s?.district}</span></p>
                          <p className="flex flex-wrap gap-1 text-[11px]"><StageChip stage={packageStage(item)} confirmMode={confirmMode} />{confirmMode && m.state === "in_custody" && !item.pickup_checked_at && !item.pickup_declined_at && <span className="text-amber-700">por confirmar</span>}</p>
                          {s?.order_id && <OrderLink orderId={s.order_id} section="historial" className="text-[11px] text-brand-700 underline">Ver actividad</OrderLink>}
                        </div>
                        {checkable && !item.office_checked_at && code && (
                          <button type="button" disabled={pending} onClick={() => scan(m.id, code)} className="min-h-9 rounded-lg border border-slate-300 px-2 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50">Cotejar</button>
                        )}
                        {checkable && (
                          <>
                            <select
                              aria-label={`Mover ${s?.order_name ?? code} a otro motorizado`}
                              defaultValue=""
                              disabled={pending}
                              onChange={(e) => { const v = e.target.value; e.target.value = ""; if (v) move(m.id, item.shipment_id, v); }}
                              className="min-h-9 rounded-lg border border-slate-300 px-1 text-xs"
                            >
                              <option value="">Mover a…</option>
                              {riders.filter((r) => r.id !== box.riderId).map((r) => <option key={r.id} value={r.id}>{r.fullName}</option>)}
                            </select>
                            <button type="button" disabled={pending} onClick={() => remove(m.id, item.shipment_id)} className="min-h-9 rounded-lg px-2 text-xs font-medium text-red-700 hover:bg-red-50 disabled:opacity-50">Quitar</button>
                          </>
                        )}
                      </li>
                    );
                  })}
                  {!active.length && <li className="px-3 py-4 text-center text-xs text-slate-500">{filter === "todos" ? "Sin paquetes activos." : "Nada con ese filtro en esta carga."}</li>}
                </ul>
                {removed.length > 0 && (
                  <details className="border-t border-slate-100 px-3 py-2 text-xs text-slate-600">
                    <summary className="cursor-pointer">Retirados o no recogidos ({removed.length})</summary>
                    <ul className="mt-1 space-y-1">
                      {removed.map((i) => <li key={i.id}>{i.shipment?.order_name ?? i.shipment_id} · {i.removal_reason}</li>)}
                    </ul>
                  </details>
                )}
              </div>
            );
          })}
        </div>
      )}
    </li>
  );
}

function stateLabel(state: string): string {
  return ({
    draft: "sin cotejar",
    office_check: "cotejo de oficina",
    ready_for_pickup: "lista para que la reciba",
    pickup_check: "el motorizado está recibiendo",
    in_custody: "en poder del motorizado",
    cancelled: "cancelada",
  } as Record<string, string>)[state] ?? state;
}

function formatDay(value: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : value;
}

const MONTHS_SHORT = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "set", "oct", "nov", "dic"];

/** `2026-09-19` → «19 set». */
function formatDayShort(value: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!m) return value;
  return `${Number(m[3])} ${MONTHS_SHORT[Number(m[2]) - 1] ?? m[2]}`;
}

/**
 * Cómo se lee el resultado de un escaneo en su fila, con color por gravedad:
 * verde entró, ámbar hay algo que decidir (mover, autorizar, ya estaba), rojo
 * no entró.
 */
function scanRowPresentation(l: ScanAssignLine, riderName: string): { text: string; textClass: string; rowClass: string } {
  switch (l.status) {
    case "asignado":
      return { text: `En la caja de ${l.riderName ?? riderName}`, textClass: "text-emerald-700", rowClass: "bg-emerald-50/50" };
    case "ya_en_caja":
      return { text: "Ya estaba", textClass: "text-amber-700", rowClass: "bg-amber-50/40" };
    case "en_otra_caja":
      return { text: `En la caja de ${l.riderName ?? "otro"} → Mover`, textClass: "text-amber-700", rowClass: "bg-amber-50/40" };
    case "bloqueado_efectivo":
      return { text: "Límite de efectivo → Autorizar", textClass: "text-amber-700", rowClass: "bg-amber-50/40" };
    case "no_elegible":
      return { text: l.message ? `No elegible: ${l.message.replace(/\.$/, "")}` : "No elegible", textClass: "text-red-700", rowClass: "bg-red-50/50" };
    default:
      return { text: "QR desconocido", textClass: "text-red-700", rowClass: "bg-red-50/50" };
  }
}

/** Tile compacta de métrica: etiqueta pequeña, cifra grande; es un filtro. */
function Tile({ label, hint, value, active, onClick, tone = "slate" }: { label: string; hint: string; value: number; active: boolean; onClick: () => void; tone?: "slate" | "amber" }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      title={hint}
      className={cn(
        "flex h-12 min-w-[7.5rem] shrink-0 snap-start flex-col justify-center rounded-xl border px-3 text-left leading-tight xl:min-w-0",
        active ? "border-brand-500 bg-brand-50 text-brand-900 ring-1 ring-brand-500" : tone === "amber" ? "border-amber-200 bg-amber-50/60 text-amber-900 hover:bg-amber-50" : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50",
      )}
    >
      <span className="truncate text-xs">{label}</span>
      <span className="text-base font-semibold tabular-nums">{value.toLocaleString("es-PE")}</span>
    </button>
  );
}

/**
 * Panel: popover bajo el disparador en escritorio, hoja inferior en el móvil.
 * Sin dependencias; cierra con Escape o tocando fuera (patrón de `Hint`).
 */
/** Chapa del estado del paquete en la caja: por armar · armado · cotejado · confirmado · no lo llevó. */
function StageChip({ stage, confirmMode }: { stage: ReturnType<typeof packageStage>; confirmMode: boolean }) {
  const text = stage === "confirmado" && !confirmMode ? "recibido" : PACKAGE_STAGE_LABEL[stage];
  return (
    <span className={cn(
      "rounded-full px-2 py-0.5 font-medium",
      stage === "por_armar" && "bg-amber-50 text-amber-800",
      stage === "armado" && "bg-sky-50 text-sky-800",
      stage === "cotejado" && "bg-emerald-50 text-emerald-700",
      stage === "confirmado" && "bg-emerald-600 text-white",
      stage === "no_lo_llevo" && "bg-red-50 text-red-700",
    )}>{text}</span>
  );
}

/** «19/09» desde YYYY-MM-DD; vacío si no hay fecha. */
function formatDayNumeric(day: string | null): string {
  if (!day) return "";
  const [, m, d] = day.split("-");
  return `${d}/${m}`;
}
