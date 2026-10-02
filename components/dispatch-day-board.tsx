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
// cada caja. Desde el 29-09-2026 la lista se parte en apartados (programados
// hoy, mañana, nunca salieron, ya salieron, +30 días, programados después) y el
// calendario programa la salida sin tomar el pedido (0199). El mismo día la
// vista pasó al mundo de operación (components/ops-ui.tsx): el lenguaje del
// panel de Stripe con el azul Kapta. Los apartados son tarjetas de estado,
// las excepciones píldoras al borde, los filtros píldoras discontinuas.

import { useEffect, useMemo, useRef, useState, useTransition, type ReactNode } from "react";
import Link from "next/link";
import { OrderLink } from "@/components/order-link";
import { useRouter } from "next/navigation";
import { cn } from "@/components/ui";
import { Hint } from "@/components/hint";
import { Sheet } from "@/components/filter-sheet";
import { AttentionPill, Badge, Banner, CHECKBOX, FIELD, FilterPill, OpsButton, StatusCard, type BadgeTone } from "@/components/ops-ui";
import { IconAlert, IconCalendar, IconCheck, IconChevronDown, IconChevronRight, IconInfo, IconList, IconPackage, IconQr, IconRepeat, IconSearch, IconUndo, IconX } from "@/components/icons";
import { ReturnsScanner } from "@/components/returns-scanner";
import type { PendingReturn } from "@/lib/courier-route-ledger";
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
  programDayLabel,
  programNeedsConfirm,
  QUEUE_SEGMENT_LABEL,
  QUEUE_SEGMENTS,
  QUEUE_TILE_LABEL,
  queueFacetCounts,
  queueSubstageOptions,
  queueTileActive,
  queueTileCounts,
  SCHEDULED_BUCKET_LABEL,
  SCHEDULED_BUCKETS,
  setStages,
  sortQueue,
  splitAssignment,
  toggleInList,
  toggleQueueTile,
  isReturnable,
  takenIsAssignable,
  type BoxItemFilter,
  type CreatedWindow,
  type DayManifest,
  type QueueFilters,
  type QueueRow,
  type QueueSegment,
  type QueueTile,
  type RiderBox,
} from "@/lib/dispatch-day";
import { macroStageLabel, macroSubstageLabel, ORDER_MACRO_STAGES } from "@/lib/order-macro-stage";
import { nonDeliveryReasonLabel } from "@/lib/gf-delivery";
import { failedOutputLabel } from "@/lib/gf-retry";
import { confirmedTandersReview, type TandersConfirmations, type TandersPackageLocation } from "@/lib/gf-tanders-review";
import { addToTray, optimisticBox, removeFromTray, type TrayEntry } from "@/lib/dispatch-scan-tray";
import type { DispatchManifest } from "@/lib/dispatch-access";
import type { RiderPickupMode } from "@/lib/grupo-gf-courier";
import {
  assignGroupGfCourierRoute,
  moveManifestItem,
  scanAssignToRider,
  takeAndAssignGroupGfCourierOrders,
  rescheduleGroupGfCourierOrders,
  clearGroupGfCourierPrograms,
  returnUndeliveredToOffice,
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
  /** 0185: exigir (verifica su caja antes de la ruta) · confirmar («Lo llevo» por paquete) · ninguno. */
  riderPickupMode: RiderPickupMode;
  /** Umbrales de efectivo de la ruta (MOM §29.9): aviso y límite. */
  cashWarning: number;
  cashLimit: number;
  pending: boolean;
  run: (action: () => Promise<CourierActionResult>) => void;
  /** «No entregado» que siguen en una caja, de cualquier fecha: tarjeta «Devoluciones». */
  pendingReturns?: PendingReturn[];
}

const money = (n: number) => `S/ ${n.toFixed(2)}`;
/** Sin decimales, para las líneas de una sola fila. */
const moneyShort = (n: number) => `S/ ${Math.round(n).toLocaleString("es-PE")}`;
const HELP_KEY = "kapta.despacho.ayuda-escaneo";
/** Motivos frecuentes al programar una salida; el campo admite cualquier otro. */
const PROGRAM_REASONS = ["La clienta pidió ese día", "La clienta no está antes", "Sin motorizado para el distrito"];

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
  // «devoluciones» no es una pestaña: lo abre la tarjeta del mismo nombre y
  // deja el recuadro solo con el escáner para confirmar lo que vuelve.
  const [method, setMethod] = useState<"qr" | "lista" | "cajas" | "devoluciones">("qr");
  const pendingReturns = props.pendingReturns ?? [];
  // Un popover de filtro abierto a la vez, anclado a su píldora.
  const [openPill, setOpenPill] = useState<PillId | null>(null);
  const pillRef: Record<PillId, React.RefObject<HTMLButtonElement | null>> = {
    etapa: useRef<HTMLButtonElement>(null),
    fecha: useRef<HTMLButtonElement>(null),
    tienda: useRef<HTMLButtonElement>(null),
    distrito: useRef<HTMLButtonElement>(null),
    creado: useRef<HTMLButtonElement>(null),
  };
  const [blockedOpen, setBlockedOpen] = useState(false);
  const [declinedOpen, setDeclinedOpen] = useState(false);
  // Filtro rápido de las cajas (Todos · Por armar · Listos para cotejo · Sin
  // confirmar): compartido por todas las cajas de la pestaña.
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
  // Cada respuesta conserva el destino elegido al leer el QR, aunque el
  // usuario cambie de motorizado o día mientras espera al servidor.
  const scanScope = JSON.stringify([orgId, riderId, scanDay]);
  const [linesByScope, setLinesByScope] = useState<Record<string, ScanAssignLine[]>>({});
  const lines = useMemo(() => linesByScope[scanScope] ?? [], [linesByScope, scanScope]);
  function updateLines(scope: string, update: (current: ScanAssignLine[]) => ScanAssignLine[]) {
    setLinesByScope((current) => ({ ...current, [scope]: update(current[scope] ?? []) }));
  }
  function setLines(update: ScanAssignLine[] | ((current: ScanAssignLine[]) => ScanAssignLine[])) {
    updateLines(scanScope, (current) => typeof update === "function" ? update(current) : update);
  }
  const [tray, setTray] = useState<TrayEntry[]>([]);
  const [draining, setDraining] = useState(false);

  // Un solo refresco de la página, 2 s después del último resultado: refrescar
  // tras cada QR reconstruía la pantalla entera por escaneo.
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  function scheduleRefresh() {
    if (refreshTimer.current) clearTimeout(refreshTimer.current);
    refreshTimer.current = setTimeout(() => { refreshTimer.current = null; router.refresh(); }, 2000);
  }
  useEffect(() => () => { if (refreshTimer.current) clearTimeout(refreshTimer.current); }, []);

  /** El QR se leyó: su línea aparece al instante, «asignando…». */
  function pendingLine(code: string) {
    const line: ScanAssignLine = { code, status: "procesando", orderId: null, orderName: null, shipmentId: null, manifestId: null, riderName: null, amount: null, message: "Asignando…" };
    setLines((cur) => [line, ...cur].slice(0, 200));
  }

  /** Llega el resultado: reemplaza su línea «asignando…» (o entra arriba). */
  function pushLine(line: ScanAssignLine) {
    setLines((cur) => {
      const i = cur.findIndex((l) => l.status === "procesando" && l.code.toLowerCase() === line.code.toLowerCase());
      if (i < 0) return [line, ...cur].slice(0, 200);
      const next = [...cur];
      next[i] = line;
      return next;
    });
    if (line.status === "asignado" || line.status === "ya_en_caja") scheduleRefresh();
  }

  /** «Asignar igual» un QR programado para otro día: su línea vuelve a «asignando…». */
  async function confirmScanned(line: ScanAssignLine) {
    setLines((cur) => cur.map((l) => (l === line ? { ...l, status: "procesando", message: "Asignando…" } : l)));
    pushLine(await scanAssignToRider(orgId, riderId, line.code, { overrideCash, scheduledFor: scanDay, confirmProgrammed: true }));
  }

  /** «Escanear primero»: al elegir motorizado, la bandeja se vacía en la caja de una vez. */
  async function drainTray(targetRiderId: string) {
    if (!targetRiderId || !tray.length || draining) return;
    const targetScope = JSON.stringify([orgId, targetRiderId, scanDay]);
    setDraining(true);
    try {
      for (const entry of tray) {
        const line = await scanAssignToRider(orgId, targetRiderId, entry.code, { overrideCash, scheduledFor: scanDay });
        updateLines(targetScope, (cur) => [line, ...cur].slice(0, 200));
        setTray((cur) => removeFromTray(cur, entry.code));
      }
      router.refresh();
    } finally {
      setDraining(false);
    }
  }

  const queue = useMemo<QueueRow[]>(() => {
    // Un tomado cuyo pedido ya está en Por cerrar o Finalizado no se asigna:
    // pasa a seguimiento (`takenIsAssignable`).
    const taken: QueueRow[] = props.accepted
      .filter((o) => !o.route && takenIsAssignable(o.macroStage))
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
        hasPriorDispatch: o.hasPriorDispatch,
        programmedFor: o.programmedFor,
        programReason: o.programReason,
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
        programmedFor: o.programmedFor,
        programReason: o.programReason,
        macroStage: o.macroStage,
        macroSubstage: o.macroSubstage,
        assignable: true,
        route: null,
        failedOutput: o.failedOutput ?? null,
        tandersReview: o.tandersReview ?? null,
      }));
    return [...taken, ...free];
  }, [props.accepted, props.available]);
  // Los que ya salieron con Grupo GF (tienen caja): no se asignan desde aquí,
  // pero cuentan en Etapa y se listan para seguimiento al elegir la suya.
  const tracked = useMemo<QueueRow[]>(() => props.accepted
    .filter((o) => o.route || !takenIsAssignable(o.macroStage))
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
      hasPriorDispatch: o.hasPriorDispatch,
      programmedFor: null,
      programReason: null,
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
        undeliveredReason: o.route.undeliveredReason ?? null,
      },
    })), [props.accepted]);
  const allRows = useMemo(() => [...queue, ...tracked], [queue, tracked]);

  const stores = useMemo(() => [...new Set(queue.map((q) => q.storeName))].sort(), [queue]);
  const districts = useMemo(() => [...new Set(queue.map((q) => q.district))].sort((a, b) => a.localeCompare(b, "es")), [queue]);
  // Filtrada y en el orden de los apartados: programados hoy, mañana, nunca salieron,
  // ya salieron, +30 días y programados después.
  const filtered = useMemo(() => sortQueue(filterQueue(allRows, filters, day), day), [allRows, filters, day]);
  // Chips de etapa, subetapa y fecha pactada con su cantidad facetada (cuántas
  // quedarían al tocarlo con el resto de filtros como están). Las subetapas
  // son las de la etapa elegida; sin etapa no se muestran.
  const substageOptions = useMemo(() => queueSubstageOptions(allRows, filters.stages), [allRows, filters.stages]);
  const facets = useMemo(() => queueFacetCounts(allRows, filters, day), [allRows, filters, day]);
  const tracking = filters.stages.length > 0;
  const activeFilters = activeFilterCount(filters);
  const visible = filtered.slice(0, limit);
  // Un «No entregado» que sigue en una caja se lista para recibirlo en oficina,
  // pero no es «por asignar»: se cuenta aparte.
  const returnableCount = filtered.filter((q) => !tracking && isReturnable(q)).length;
  const visibleAssignable = visible.filter((q) => q.assignable || isReturnable(q));
  const selectedAssignable = allRows.filter((q) => q.assignable && selected.has(q.orderId)).map((q) => q.orderId);
  const selectedReturnable = allRows.filter((q) => isReturnable(q) && selected.has(q.orderId)).map((q) => q.orderId);
  // Programar la salida (0199): solo guarda el día, con motivo; no toma el pedido.
  const [rescheduleOpen, setRescheduleOpen] = useState(false);
  const [rescheduleDay, setRescheduleDay] = useState("");
  const [programReason, setProgramReason] = useState("");
  const rescheduleButton = useRef<HTMLButtonElement>(null);
  const selectedProgrammed = allRows.filter((q) => q.assignable && q.programmedFor && selected.has(q.orderId)).map((q) => q.orderId);
  const reasonOk = programReason.trim().length >= 3;
  function reschedule() {
    if (!rescheduleDay || !reasonOk || !selectedAssignable.length) return;
    const ids = selectedAssignable;
    const reason = programReason.trim();
    setRescheduleOpen(false);
    setSelected(new Set());
    setProgramReason("");
    run(() => rescheduleGroupGfCourierOrders(orgId, ids, rescheduleDay, reason));
  }
  function clearProgram() {
    if (!selectedProgrammed.length) return;
    const ids = selectedProgrammed;
    setRescheduleOpen(false);
    setSelected(new Set());
    run(() => clearGroupGfCourierPrograms(orgId, ids));
  }
  function receiveInOffice() {
    if (!selectedReturnable.length) return;
    const ids = selectedReturnable;
    setSelected(new Set());
    run(() => returnUndeliveredToOffice(orgId, ids));
  }
  const allVisibleSelected = visibleAssignable.length > 0 && visibleAssignable.every((q) => selected.has(q.orderId));
  const selectedTotal = queue.filter((q) => selected.has(q.orderId)).reduce((sum, q) => sum + q.orderTotal, 0);
  // Las cajas siguen al día elegido arriba («cambiar día»): cambiar la fecha
  // sin ver las cajas de ese día dejaba la impresión de que no se creó nada.
  const boxes = useMemo(() => dayBoxes(props.manifests as unknown as DayManifest[], scanDay), [props.manifests, scanDay]);
  const riderName = riders.find((r) => r.id === riderId)?.fullName ?? "";
  const riderBoxCount = (id: string) => boxes.find((b) => b.riderId === id)?.assigned ?? 0;
  // Lo que la caja del motorizado elegido tiene según la última carga, más lo
  // leído que todavía no aparece: el número sube en el mismo instante del QR.
  const liveBox = useMemo(() => {
    const box = boxes.find((b) => b.riderId === riderId);
    const orderIds = new Set<string>();
    for (const load of box?.loads ?? []) for (const item of load.items) if (!item.removed_at && item.shipment?.order_id) orderIds.add(item.shipment.order_id);
    let cash = 0;
    for (const o of props.accepted) if (o.route && o.route.routeDate === scanDay && o.route.riderId === riderId) cash += o.orderTotal;
    return optimisticBox(lines, { count: box?.assigned ?? 0, cash, orderIds });
  }, [boxes, riderId, lines, props.accepted, scanDay]);
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
  const queueTiles = useMemo(() => queueTileCounts(queue, allRows, day), [queue, allRows, day]);
  const boxTiles = useMemo(() => boxTileCounts(boxes), [boxes]);
  /** Tocar una tile de la cola: abre «Desde la lista» con ese filtro (o lo quita). */
  const tapQueueTile = (tile: QueueTile) => {
    setFilters((cur) => toggleQueueTile(cur, tile));
    setLimit(100);
    setMethod("lista");
  };

  function toggle(id: string) {
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  // Asignar a la caja de otro día un pedido programado pide confirmar (§29.6):
  // la franja ámbar sobre la tabla dice cuáles y para cuándo estaban.
  const [programConfirm, setProgramConfirm] = useState<QueueRow[] | null>(null);
  type AssignOptions = { confirmProgrammed?: boolean; skip?: ReadonlySet<string>; tandersConfirmations?: TandersConfirmations };
  const [tandersConfirm, setTandersConfirm] = useState<{ rows: QueueRow[]; opts: AssignOptions } | null>(null);
  const [tandersChoices, setTandersChoices] = useState<TandersConfirmations>({});
  useEffect(() => { setTandersConfirm(null); setTandersChoices({}); }, [selected, riderId, scanDay, props.available]);
  const confirmFirst = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (programConfirm) confirmFirst.current?.focus(); }, [programConfirm]);
  // Cambiar lo marcado deja la franja sin objeto: se vuelve a preguntar al asignar.
  useEffect(() => { setProgramConfirm(null); }, [selected]);
  function assign(opts: AssignOptions = {}) {
    if (!riderId || !selected.size) return;
    const ids = new Set([...selected].filter((id) => !opts.skip?.has(id)));
    if (!ids.size) { setProgramConfirm(null); return; }
    if (!opts.confirmProgrammed) {
      const conflicts = queue.filter((q) => ids.has(q.orderId) && programNeedsConfirm(q.programmedFor, scanDay, day));
      if (conflicts.length) { setProgramConfirm(conflicts); return; }
    }
    setProgramConfirm(null);
    const reviews = queue.filter((q) => ids.has(q.orderId) && q.tandersReview);
    if (reviews.some((q) => !confirmedTandersReview(q.tandersReview!, opts.tandersConfirmations?.[q.orderId]))) {
      setTandersChoices({});
      setTandersConfirm({ rows: reviews, opts });
      return;
    }
    setTandersConfirm(null);
    const confirmProgrammed = Boolean(opts.confirmProgrammed);
    const split = splitAssignment(ids, props.available, props.accepted);
    setSelected(new Set());
    run(async () => {
      // Lo que falló se dice como error, en rojo y sin repetirse; lo demás
      // como aviso. Antes todo salía junto en verde, también los rechazos.
      const notices: string[] = [];
      const errors: string[] = [];
      for (let i = 0; i < split.orderIds.length; i += 50) {
        const r = await takeAndAssignGroupGfCourierOrders(orgId, riderId, split.orderIds.slice(i, i + 50), { overrideCash, day: scanDay, confirmProgrammed, tandersConfirmations: opts.tandersConfirmations });
        if (r.error) errors.push(r.error);
        else if (r.notice) notices.push(r.notice);
      }
      if (split.requestIds.length) {
        const r = await assignGroupGfCourierRoute(orgId, riderId, split.requestIds, { overrideCash, day: scanDay, confirmProgrammed });
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

  // Tarjetas de estado: los apartados con su cantidad y los filtros de la
  // lista aplicados, pero sin la etapa de seguimiento: elegir «Por
  // reprogramar» no deja las tarjetas en cero.
  const cards = useMemo(() => queueFacetCounts(allRows, { ...filters, stages: [], substages: [] }, day), [allRows, filters, day]);
  /** Tocar una tarjeta: abre «Desde la lista» en ese apartado (o lo quita). */
  const tapSegment = (segment: QueueSegment) => {
    setFilters((cur) => ({ ...cur, segment: cur.segment === segment && method === "lista" ? null : segment, stages: [], substages: [] }));
    setLimit(100);
    setMethod("lista");
  };
  const pillValue: Record<PillId, string | null> = {
    etapa: filters.stages.length
      ? `${filters.stages.map((code) => (code === "sin_etapa" ? "Sin etapa" : macroStageLabel(code))).join(", ")}${filters.substages.length ? ` · ${filters.substages.length} ${filters.substages.length === 1 ? "subetapa" : "subetapas"}` : ""}`
      : null,
    fecha: filters.due.length ? filters.due.map((bucket) => SCHEDULED_BUCKET_LABEL[bucket]).join(", ") : null,
    tienda: filters.store || null,
    distrito: filters.district || null,
    creado: filters.created !== "todo" ? CREATED_WINDOW_LABEL[filters.created] : null,
  };
  const togglePill = (id: PillId) => setOpenPill((cur) => (cur === id ? null : id));
  const closePill = () => setOpenPill(null);

  return (
    <section aria-labelledby="dispatch-day-title" className="space-y-4">
      <h2 id="dispatch-day-title" className="sr-only">Despacho del día</h2>

      {/* Línea del día: la fecha de la caja, el resumen y las excepciones que
          esperan al borde de la tarea. */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="flex items-center gap-2">
          {dayOpen ? (
            <span className="flex items-center gap-1.5">
              <input type="date" value={scanDay} min={day} onChange={(e) => setScanDay(e.target.value || day)} aria-label="Día de la caja" className={cn(FIELD, "h-8 w-auto")} />
              <OpsButton variant="ghost" size="sm" onClick={() => { setScanDay(day); setDayOpen(false); }}>Volver a hoy</OpsButton>
            </span>
          ) : (
            <OpsButton size="sm" onClick={() => setDayOpen(true)} title="Día de la caja: por defecto hoy; elige otro solo para adelantar cajas" aria-label={`Día de la caja: ${scanDay === day ? "hoy" : formatDayShort(scanDay)}. Cambiar día`}>
              <IconCalendar className="text-ink-500" />
              {scanDay === day ? `Hoy, ${formatDayShort(day)}` : formatDayShort(scanDay)}
              <IconChevronDown className="text-ink-500" />
            </OpsButton>
          )}
          <Hint label="Cómo funciona el despacho" text={helpText} />
        </div>
        <p className="min-w-0 text-[13px] text-ink-500">
          <b className="font-semibold tabular-nums text-ink-900">{queue.length.toLocaleString("es-PE")}</b> por asignar
          {boxes.length > 0 && <> · <b className="font-semibold tabular-nums text-ink-900">{boxes.length}</b> {boxes.length === 1 ? "caja" : "cajas"} · <b className="font-semibold tabular-nums text-ink-900">{dayCod}</b> paq.</>}
        </p>
        <div role="group" aria-label="Excepciones del día" className="flex flex-wrap items-center gap-2 lg:ml-auto">
          <AttentionPill icon={IconRepeat} label="Por reprogramar" count={queueTiles.por_reprogramar} hint={QUEUE_TILE_LABEL.por_reprogramar.hint} active={queueTileActive(filters, "por_reprogramar") && method === "lista"} onClick={() => tapQueueTile("por_reprogramar")} />
          <AttentionPill icon={IconUndo} label="Devoluciones" count={pendingReturns.length} hint="No entregados que el motorizado tiene que traer de vuelta, de cualquier fecha. Toca para escanear y confirmar que llegaron a la oficina." active={method === "devoluciones"} onClick={() => setMethod((m) => (m === "devoluciones" ? "qr" : "devoluciones"))} />
          {declined.length > 0 && (
            <AttentionPill icon={IconPackage} label="No recogidos" count={declined.length} hint="Paquetes que el motorizado no recogió de su caja: vuelven a «por asignar». Toca para ver cuáles." active={declinedOpen} onClick={() => setDeclinedOpen((v) => !v)} />
          )}
          <AttentionPill icon={IconAlert} label="Sin condiciones" count={props.blocked.length} hint="Pedidos de Lima que no entran en la cola: tarifa faltante, distrito inválido, servicio pausado o sin salida armable. Abre la lista con el motivo de cada uno." active={blockedOpen} onClick={() => setBlockedOpen((v) => !v)} />
        </div>
      </div>

      {/* Apartados de la cola como tarjetas de estado: cada una es un filtro con
          su cantidad y la elegida lleva el borde azul. «Nunca salieron» es el
          apartado a dejar en cero, como «Sin llamar» en Por confirmar. */}
      <div role="group" aria-label="Apartados de la cola" className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-7 [&>button>span:first-child]:whitespace-normal [&>button>span:last-child]:mt-auto">
        <StatusCard label="Por asignar" value={QUEUE_SEGMENTS.reduce((sum, segment) => sum + cards.segment[segment], 0)} hint={QUEUE_TILE_LABEL.por_asignar.hint} active={method === "lista" && !tracking && filters.segment === null} onClick={() => tapQueueTile("por_asignar")} />
        {QUEUE_SEGMENTS.map((segment) => (
          <StatusCard key={segment} label={QUEUE_SEGMENT_LABEL[segment].label} value={cards.segment[segment]} hint={QUEUE_SEGMENT_LABEL[segment].hint} active={method === "lista" && filters.segment === segment} onClick={() => tapSegment(segment)} />
        ))}
      </div>

      {blockedOpen && (
        <Sheet look="ops" title={`${props.blocked.length.toLocaleString("es-PE")} sin condiciones para salir`} onClose={() => setBlockedOpen(false)} wide>
          <p className="text-[13px] text-ink-500">No entran en la cola hasta que se arregle el motivo. Tarifa y pausa se corrigen en el Tarifario; el resto en el pedido o en la caja.</p>
          <ul className="mt-3 max-h-[50vh] divide-y divide-line overflow-auto border-t border-line text-sm">
            {props.blocked.map((b) => {
              const reason = BLOCKED_REASON_LABEL[b.reason];
              return (
                <li key={b.orderId} className="flex flex-wrap items-center gap-x-2 gap-y-1 py-2">
                  <OrderLink orderId={b.orderId} className="font-semibold text-ink-900 hover:text-brand-700">{b.orderName}</OrderLink>
                  <span className="text-[13px] text-ink-500">{b.storeName} · {b.customerName} · {b.district}</span>
                  <Badge tone="warn">{reason.label}</Badge>
                  {reason.fix === "tarifario" && <Link href="/dashboard/courier?tab=tariffs" className="text-xs font-medium text-brand-700 hover:underline">Arreglar en Tarifario</Link>}
                </li>
              );
            })}
            {!props.blocked.length && <li className="py-6 text-center text-[13px] text-ink-500">Todos los pedidos de Lima tienen condiciones para salir.</li>}
          </ul>
        </Sheet>
      )}

      {declinedOpen && declined.length > 0 && (
        <Sheet look="ops" title={`${declined.length} ${declined.length === 1 ? "paquete no recogido" : "paquetes no recogidos"}`} onClose={() => setDeclinedOpen(false)} wide>
          <p className="text-[13px] text-ink-500">El motorizado no los recogió de su caja: vuelven a «por asignar».</p>
          <ul className="mt-3 divide-y divide-line border-t border-line text-sm">
            {declined.map((d) => (
              <li key={`${d.manifestId}:${d.shipmentId}`} className="flex flex-wrap items-center gap-x-2 gap-y-1 py-2">
                <span className="font-semibold text-ink-900">{d.orderName ?? "Pedido"}</span>
                <span className="text-[13px] text-ink-500">{d.customerName} · {d.district}</span>
                <Badge tone="warn">{d.riderName}: {d.reason}</Badge>
              </li>
            ))}
          </ul>
        </Sheet>
      )}

      {/* ── La tarea: quién sale y cómo se le asigna. Una sola tarjeta. ── */}
      <div className="min-w-0 overflow-hidden rounded-lg bg-white shadow-control ring-1 ring-line">
        {method === "devoluciones" && (
          <div className="flex flex-col gap-3 p-4">
            <div className="flex items-center gap-2">
              <IconUndo className="size-4 text-ink-500" />
              <p className="text-sm font-semibold text-ink-900">Recibir devoluciones en oficina</p>
              <OpsButton variant="ghost" size="sm" className="ml-auto" onClick={() => setMethod("qr")}>Volver a asignar</OpsButton>
            </div>
            {canManageDispatch
              ? <ReturnsScanner key={pendingReturns.length ? "con" : "sin"} orgId={orgId} pending={pendingReturns} />
              : <Banner tone="warn">Tu rol no organiza rutas: puedes mirar, no recibir.</Banner>}
          </div>
        )}
        <div className={cn("flex flex-col gap-3 p-4 lg:flex-row lg:items-end", method === "devoluciones" && "hidden")}>
          <label className="grid min-w-0 gap-1.5 lg:w-80 lg:shrink-0">
            <span className="text-[13px] font-medium text-ink-700">Motorizado</span>
            <select
              value={riderId}
              onChange={(e) => { setRiderId(e.target.value); if (tray.length) void drainTray(e.target.value); }}
              aria-label="¿Quién sale hoy?"
              className={cn(FIELD, "h-10 font-medium")}
            >
              <option value="">¿Quién sale hoy?</option>
              {riders.map((r) => <option key={r.id} value={r.id}>{r.fullName}</option>)}
            </select>
          </label>
          <div role="tablist" aria-label="Forma de asignar" className="grid min-w-0 flex-1 grid-cols-3 gap-0.5 rounded-lg bg-wash p-0.5 ring-1 ring-inset ring-line">
            <MethodTab active={method === "qr"} onClick={() => setMethod("qr")} icon={IconQr} label="Asignar por QR" shortLabel="Por QR" />
            <MethodTab active={method === "lista"} onClick={() => setMethod("lista")} icon={IconList} label="Desde la lista" shortLabel="Lista" />
            <MethodTab active={method === "cajas"} onClick={() => setMethod("cajas")} icon={IconPackage} label={scanDay === day ? "Cajas de hoy" : `Cajas del ${formatDayShort(scanDay)}`} shortLabel="Cajas">
              <Badge tone={dayCod ? "brand" : "neutral"} title={`${boxes.length} ${boxes.length === 1 ? "caja" : "cajas"} · ${dayCod} paquetes`} className="tabular-nums">{dayCod}</Badge>
            </MethodTab>
          </div>
        </div>
        {method !== "devoluciones" && riderId && riderBoxCount(riderId) > 0 && (
          <p className="-mt-2 px-4 pb-3 text-[13px] text-ink-500"><b className="font-semibold text-ink-700">{riderName}</b> · <span className="tabular-nums">{riderBoxCount(riderId)}</span> en su caja</p>
        )}

        {method === "qr" && (
          <div className="border-t border-line p-4">
            {canManageDispatch ? (
              <ScanAction
                context="supervisor_asignacion"
                compact
                continuous
                look="ops"
                progress={riderId ? { done: liveBox.count, label: `${liveBox.count} en la caja de ${riderName}${liveBox.pending ? ` · ${liveBox.pending} asignando…` : ""}` } : undefined}
                disabled={draining}
                assign={{ orgId, riderId, scheduledFor: scanDay, overrideCash }}
                onQueue={(code) => setTray((cur) => addToTray(cur, code))}
                onPending={pendingLine}
                onResult={(r) => { if (r.line) pushLine(r.line); }}
              />
            ) : (
              <Banner tone="warn">Tu rol no organiza rutas: puedes mirar, no asignar.</Banner>
            )}
            {!helpDismissed && canManageDispatch && (
              <p className="mt-3 flex items-start gap-2 text-[13px] text-ink-500">
                <IconInfo className="mt-px size-4 shrink-0 text-ink-300" />
                <span className="min-w-0 flex-1">Cada escaneo toma el pedido y lo pone en la caja de {riderName || "quien elijas"}. Después, oficina lo verifica en «Verificar caja».</span>
                <button type="button" onClick={dismissHelp} aria-label="Cerrar ayuda" className="grid size-6 shrink-0 place-items-center rounded-md text-ink-500 hover:bg-wash hover:text-ink-900"><IconX className="size-3.5" /></button>
              </p>
            )}

            {tray.length > 0 && (
              <div className="mt-3 flex flex-wrap items-center gap-2 rounded-lg bg-info-wash px-3 py-2 text-[13px] text-ink-700">
                <span><b className="font-semibold tabular-nums text-ink-900">{tray.length}</b> en espera de motorizado</span>
                {tray.map((e) => (
                  <span key={e.code} className="flex items-center gap-1 rounded bg-white py-0.5 pl-2 pr-1 font-mono text-xs text-ink-700 ring-1 ring-inset ring-line">
                    {e.code}
                    <button type="button" aria-label={`Quitar ${e.code}`} onClick={() => setTray((cur) => removeFromTray(cur, e.code))} className="grid size-5 place-items-center rounded text-ink-500 hover:bg-crit-wash hover:text-crit-fg"><IconX className="size-3" /></button>
                  </span>
                ))}
                <OpsButton variant="primary" size="sm" className="ml-auto" disabled={!riderId || draining} onClick={() => void drainTray(riderId)}>
                  {draining ? "Asignando…" : riderId ? `Asignar a ${riderName}` : "Elige motorizado"}
                </OpsButton>
              </div>
            )}

            {lines.length > 0 && (
              <ul className="mt-3 max-h-72 divide-y divide-line overflow-auto rounded-lg ring-1 ring-line" aria-live="polite">
                {lines.map((l, i) => {
                  const r = scanRowPresentation(l, riderName);
                  return (
                    <li key={`${l.code}:${i}`} className="flex items-center gap-2 px-3 py-2 text-sm" title={[l.message, l.cashWarning].filter(Boolean).join(" · ")}>
                      <span className="flex min-w-0 flex-1 items-center gap-2">
                        <span className="shrink-0 font-semibold text-ink-900">{l.orderName ?? l.code}</span>
                        <Badge tone={r.tone} className="min-w-0">{r.text}</Badge>
                      </span>
                      {l.amount != null && <span className="shrink-0 text-[13px] tabular-nums text-ink-500">{moneyShort(l.amount)}</span>}
                      {l.status === "en_otra_caja" && l.manifestId && l.shipmentId && riderId && (
                        <OpsButton size="sm" disabled={pending || draining} onClick={() => run(async () => moveManifestItem(orgId, l.manifestId!, l.shipmentId!, riderId, `Escaneado en la caja de ${riderName}`))}>Mover</OpsButton>
                      )}
                      {l.status === "programado_otro_dia" && riderId && (
                        <OpsButton size="sm" disabled={pending || draining} onClick={() => confirmScanned(l)} title={l.message}>Asignar igual</OpsButton>
                      )}
                      {l.status === "bloqueado_efectivo" && !overrideCash && (
                        <OpsButton size="sm" onClick={() => setOverrideCash(true)} title={`${cashOverrideHint(props.cashWarning, props.cashLimit)} Toca «Autorizar» y vuelve a escanear.`}>Autorizar</OpsButton>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
            {/* El total de la caja, del servidor: sobrevive a recargar la página
                (la lista de escaneos de arriba es solo de esta sesión). Más grande
                para leerlo con la pistola en la mano. */}
            {riderId && (liveBox.count > 0 || lines.length > 0) && (() => {
              const { count, cash, pending: inFlight } = liveBox;
              return (
                <div className={cn("mt-3 flex items-center gap-2", cash >= props.cashLimit ? "text-crit-fg" : cash >= props.cashWarning ? "text-warn-fg" : "text-ink-900")}>
                  <span className="min-w-0 truncate text-[17px] font-medium leading-tight" title={`${count} en la caja de ${riderName} · efectivo previsto ${money(cash)}${cash >= props.cashLimit ? " · supera el límite" : cash >= props.cashWarning ? " · cerca del límite" : ""}${overrideCash ? " · límite autorizado" : ""}`}>
                    <b className="font-semibold tabular-nums">{count}</b> en la caja de {riderName} · <b className="font-semibold tabular-nums">{moneyShort(cash)}</b>
                  </span>
                  {inFlight > 0 && <span className="shrink-0 text-[13px] text-ink-500">{inFlight} asignando…</span>}
                  {lines.length > 0 && <OpsButton variant="ghost" size="sm" className="ml-auto" onClick={() => setLines([])}>Limpiar lista</OpsButton>}
                </div>
              );
            })()}
          </div>
        )}

        {method === "lista" && (
          <div className="border-t border-line">
            {/* Búsqueda y filtros en píldoras, como en Stripe: discontinuas hasta
                que filtran; sólidas con su valor y una «x» para quitarlas. */}
            <div className="flex flex-wrap items-center gap-2 px-4 py-3">
              <label className="relative w-full sm:w-72">
                <span className="sr-only">Buscar en la cola</span>
                <IconSearch className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-ink-500" />
                <input
                  value={filters.query}
                  onChange={(e) => patchFilters({ query: e.target.value })}
                  placeholder="Pedido, cliente, distrito o teléfono"
                  aria-label="Buscar en la cola"
                  className={cn(FIELD, "h-8 pl-8")}
                />
              </label>
              <FilterPill ref={pillRef.etapa} label="Etapa" value={pillValue.etapa} expanded={openPill === "etapa"} onClick={() => togglePill("etapa")} onClear={() => patchFilters({ stages: [], substages: [] })} />
              <FilterPill ref={pillRef.fecha} label="Fecha pactada" value={pillValue.fecha} expanded={openPill === "fecha"} onClick={() => togglePill("fecha")} onClear={() => patchFilters({ due: [] })} />
              <FilterPill ref={pillRef.tienda} label="Tienda" value={pillValue.tienda} expanded={openPill === "tienda"} onClick={() => togglePill("tienda")} onClear={() => patchFilters({ store: "" })} />
              <FilterPill ref={pillRef.distrito} label="Distrito" value={pillValue.distrito} expanded={openPill === "distrito"} onClick={() => togglePill("distrito")} onClear={() => patchFilters({ district: "" })} />
              <FilterPill ref={pillRef.creado} label="Creado" value={pillValue.creado} expanded={openPill === "creado"} onClick={() => togglePill("creado")} onClear={() => patchFilters({ created: "todo" })} />
              <FilterPill label="Armados" count={queueTiles.armados} active={filters.armedOnly} title={QUEUE_TILE_LABEL.armados.hint} onClick={() => patchFilters({ armedOnly: !filters.armedOnly })} onClear={() => patchFilters({ armedOnly: false })} />
              <FilterPill label="Tomados sin caja" count={queueTiles.tomados_sin_caja} active={filters.takenOnly} title={QUEUE_TILE_LABEL.tomados_sin_caja.hint} onClick={() => patchFilters({ takenOnly: !filters.takenOnly })} onClear={() => patchFilters({ takenOnly: false })} />
              {activeFilters > 0 && (
                <OpsButton variant="ghost" size="sm" onClick={() => patchFilters({ ...EMPTY_QUEUE_FILTERS, query: filters.query, segment: filters.segment })}>Quitar filtros</OpsButton>
              )}
              <p className="w-full text-[13px] tabular-nums text-ink-500 lg:ml-auto lg:w-auto">
                <b className="font-semibold text-ink-900">{(filtered.length - returnableCount).toLocaleString("es-PE")}</b> {tracking ? "pedidos en esa etapa" : filters.segment ? QUEUE_SEGMENT_LABEL[filters.segment].label.toLocaleLowerCase("es") : "por asignar"}
                {returnableCount > 0 && <> · <b className="font-semibold text-ink-900">{returnableCount.toLocaleString("es-PE")}</b> por recibir en oficina</>}
              </p>
            </div>

            {openPill === "etapa" && (
              <Sheet look="ops" title="Etapa" onClose={closePill} anchored anchorRef={pillRef.etapa}>
                {/* Etapa, como en el Master: cuenta todos los pedidos de Grupo GF;
                    elegir una que no se asigna (En curso, Por cerrar…) lista esos
                    pedidos para seguimiento. Las subetapas aparecen con una etapa. */}
                <div className="grid gap-4 text-sm">
                  <div role="group" aria-label="Etapa" className="grid grid-cols-2 gap-1.5">
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
                            "flex min-h-11 min-w-0 flex-col justify-center rounded-md px-2.5 py-1.5 text-left transition-shadow",
                            active ? "bg-brand-50 ring-2 ring-inset ring-brand-600" : "bg-white ring-1 ring-inset ring-line-strong hover:ring-ink-300",
                            count === 0 && !active && "cursor-not-allowed opacity-40",
                          )}
                        >
                          <span className={cn("block truncate text-[13px] font-semibold", active ? "text-brand-700" : "text-ink-900")}>{stage.label}</span>
                          <span className={cn("block text-xs tabular-nums", active ? "text-brand-700" : "text-ink-500")}>{count.toLocaleString("es-PE")} pedidos</span>
                        </button>
                      );
                    })}
                  </div>
                  {substageOptions.length > 0 && (
                    <div role="group" aria-label="Subetapas" className="grid gap-2">
                      <span className="text-xs font-semibold text-ink-600">Subetapas</span>
                      <div className="flex flex-wrap gap-1.5">
                        {substageOptions.map((opt) => (
                          <ChoiceChip
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
                </div>
              </Sheet>
            )}
            {openPill === "fecha" && (
              <Sheet look="ops" title="Fecha pactada" onClose={closePill} anchored anchorRef={pillRef.fecha}>
                <p className="text-[13px] text-ink-500">Fecha pactada de salida: la programada, la de la solicitud ya tomada o, si el pedido sigue disponible, hoy o mañana según el corte de las 11:30. «Vencidos» son los que ya debían haber salido.</p>
                <div role="group" aria-label="Fecha pactada" className="mt-3 flex flex-wrap gap-1.5">
                  {SCHEDULED_BUCKETS.map((bucket) => (
                    <ChoiceChip key={bucket} label={SCHEDULED_BUCKET_LABEL[bucket]} count={facets.due[bucket]} active={filters.due.includes(bucket)} onClick={() => patchFilters({ due: toggleInList(filters.due, bucket) })} />
                  ))}
                </div>
              </Sheet>
            )}
            {openPill === "tienda" && (
              <Sheet look="ops" title="Tienda" onClose={closePill} anchored anchorRef={pillRef.tienda}>
                <OptionList options={[{ value: "", label: "Todas" }, ...stores.map((st) => ({ value: st, label: st }))]} value={filters.store} onPick={(store) => { patchFilters({ store }); closePill(); }} />
              </Sheet>
            )}
            {openPill === "distrito" && (
              <Sheet look="ops" title="Distrito" onClose={closePill} anchored anchorRef={pillRef.distrito}>
                <select value={filters.district} onChange={(e) => { patchFilters({ district: e.target.value }); closePill(); }} aria-label="Distrito" className={FIELD}>
                  <option value="">Todos</option>
                  {districts.map((d) => <option key={d} value={d}>{d}</option>)}
                </select>
              </Sheet>
            )}
            {openPill === "creado" && (
              <Sheet look="ops" title="Fecha de creación" onClose={closePill} anchored anchorRef={pillRef.creado}>
                <OptionList
                  options={(["todo", "hoy", "ayer", "7d"] as CreatedWindow[]).map((w) => ({ value: w, label: w === "todo" ? "Cualquier fecha" : w === "hoy" ? "Hoy" : w === "ayer" ? "Ayer" : "Últimos 7 días" }))}
                  value={filters.created}
                  onPick={(created) => { patchFilters({ created: created as CreatedWindow }); closePill(); }}
                />
              </Sheet>
            )}

            {/* Barra de acciones: marca, asigna, programa. Pegada arriba al bajar. */}
            <div className="sticky top-0 z-10 flex flex-wrap items-center gap-2 border-y border-line bg-wash px-4 py-2">
              <label className="flex min-h-8 items-center gap-2 text-sm">
                <input type="checkbox" className={CHECKBOX} checked={allVisibleSelected} disabled={!visibleAssignable.length} onChange={() => setSelected(allVisibleSelected ? new Set() : new Set(visibleAssignable.map((q) => q.orderId)))} aria-label="Marcar los visibles" />
                <span className={cn("font-medium", selected.size ? "text-ink-900" : "text-ink-600")}>{selected.size ? <><span className="tabular-nums">{selected.size}</span> marcados · <span className="tabular-nums">{money(selectedTotal)}</span></> : "Marca pedidos"}</span>
              </label>
              <OpsButton
                variant="primary"
                disabled={pending || !canManageDispatch || !riderId || !selected.size}
                onClick={() => assign()}
                title={riderId ? undefined : "Elige el motorizado arriba"}
                className="max-w-full truncate"
              >
                {pending ? "Asignando…" : `Asignar${selected.size ? ` ${selected.size}` : ""} a ${riderName || "…"}`}
              </OpsButton>
              {/* Programar: guarda el día de salida de los marcados, sin tomarlos. */}
              <div className="relative">
                <OpsButton
                  ref={rescheduleButton}
                  disabled={pending || !canManageDispatch || !selectedAssignable.length}
                  onClick={() => { setRescheduleDay((d) => d || day); setRescheduleOpen((v) => !v); }}
                  aria-label="Programar la salida de los marcados"
                  aria-expanded={rescheduleOpen}
                  title={selectedAssignable.length ? `Programar la salida de ${selectedAssignable.length} ${selectedAssignable.length === 1 ? "pedido" : "pedidos"}` : "Marca pedidos para programar el día en que deben salir"}
                >
                  <IconCalendar className="text-ink-500" />
                  Programar
                </OpsButton>
                {rescheduleOpen && (
                  <Sheet look="ops" title="Programar salida" onClose={() => setRescheduleOpen(false)} anchored anchorRef={rescheduleButton}>
                    <form className="grid gap-3 text-sm" onSubmit={(e) => { e.preventDefault(); reschedule(); }}>
                      <p className="text-[13px] text-ink-500">{selectedAssignable.length} {selectedAssignable.length === 1 ? "pedido" : "pedidos"}. Guarda el día en que deben salir; no los toma ni los asigna. Ese día aparecen en «Programados hoy». Los que ya están en la caja de un motorizado no se mueven.</p>
                      <label className="grid gap-1.5 text-[13px] font-medium text-ink-700">Día de salida
                        <input type="date" value={rescheduleDay} min={day} onChange={(e) => setRescheduleDay(e.target.value)} className={FIELD} />
                      </label>
                      <label className="grid gap-1.5 text-[13px] font-medium text-ink-700">Motivo
                        <input value={programReason} onChange={(e) => setProgramReason(e.target.value)} maxLength={200} placeholder="Queda en el historial del pedido" className={FIELD} />
                      </label>
                      <div role="group" aria-label="Motivos frecuentes" className="flex flex-wrap gap-1.5">
                        {PROGRAM_REASONS.map((reason) => (
                          <ChoiceChip key={reason} label={reason} active={programReason === reason} onClick={() => setProgramReason(reason)} />
                        ))}
                      </div>
                      <OpsButton type="submit" variant="primary" disabled={!rescheduleDay || !reasonOk || pending} className="w-full">
                        Programar {selectedAssignable.length}{rescheduleDay ? ` para el ${programDayLabel(rescheduleDay)}` : ""}
                      </OpsButton>
                      {selectedProgrammed.length > 0 && (
                        <OpsButton disabled={pending} onClick={clearProgram} className="w-full">
                          Quitar la fecha de {selectedProgrammed.length} {selectedProgrammed.length === 1 ? "programado" : "programados"}
                        </OpsButton>
                      )}
                    </form>
                  </Sheet>
                )}
              </div>
              {selectedReturnable.length > 0 && (
                <OpsButton variant="danger" disabled={pending || !canManageDispatch} onClick={receiveInOffice} title="El paquete volvió físicamente a la oficina: sale de la caja del motorizado y vuelve a «por asignar»">
                  Recibir en oficina {selectedReturnable.length}
                </OpsButton>
              )}
              <label className="flex min-h-8 items-center gap-2 text-[13px] text-ink-600 sm:ml-auto" title={cashOverrideHint(props.cashWarning, props.cashLimit)}>
                <input type="checkbox" className={CHECKBOX} checked={overrideCash} onChange={(e) => setOverrideCash(e.target.checked)} /> <span className="whitespace-nowrap">Superar el límite</span>
              </label>
            </div>

            {tandersConfirm && (
              <Sheet look="ops" title="Revisar paquetes de Tanders" onClose={() => setTandersConfirm(null)} wide>
                <p className="mb-4 text-sm text-ink-600">Estos pedidos salieron en días anteriores y siguen sin entrega registrada. Confirma qué paquete saldrá con {riderName}. La guía de Tanders conserva su historial; Grupo GF tendrá una nueva salida y rótulo.</p>
                <div className="space-y-4">
                  {tandersConfirm.rows.map((q) => (
                    <fieldset key={q.orderId} className="rounded-lg border border-line p-3">
                      <legend className="px-1 text-sm font-semibold">{q.orderName} · despachado {programDayLabel(limaDay(q.tandersReview!.dispatchedAt)!)}</legend>
                      {([
                        ["returned", "El paquete volvió al almacén"],
                        ["additional", "Saldrá otro paquete mientras se recupera el anterior"],
                      ] as const).map(([value, label]) => (
                        <label key={value} className="flex min-h-11 items-center gap-2 text-sm">
                          <input type="radio" name={`tanders-${q.orderId}`} value={value} checked={tandersChoices[q.orderId]?.packageLocation === value}
                            onChange={() => setTandersChoices((choices) => ({ ...choices, [q.orderId]: { shipmentIds: q.tandersReview!.shipmentIds, packageLocation: value as TandersPackageLocation } }))} />
                          {label}
                        </label>
                      ))}
                    </fieldset>
                  ))}
                </div>
                <div className="mt-4 flex flex-wrap gap-2">
                  <OpsButton variant="primary" disabled={pending || tandersConfirm.rows.some((q) => !confirmedTandersReview(q.tandersReview!, tandersChoices[q.orderId]))}
                    onClick={() => assign({ ...tandersConfirm.opts, tandersConfirmations: tandersChoices })}>Confirmar y asignar a {riderName}</OpsButton>
                  <OpsButton variant="ghost" onClick={() => setTandersConfirm(null)}>Cancelar</OpsButton>
                </div>
              </Sheet>
            )}

            {programConfirm && (() => {
              const others = [...selected].filter((id) => !programConfirm.some((q) => q.orderId === id)).length;
              const target = scanDay === day ? "hoy" : `el ${programDayLabel(scanDay)}`;
              return (
                <div role="alertdialog" aria-labelledby="program-confirm-title" aria-describedby="program-confirm-list" className="border-b border-line bg-warn-wash px-4 py-3 text-sm text-ink-700">
                  <p id="program-confirm-title" className="flex items-center gap-2 font-semibold text-warn-fg">
                    <IconAlert className="size-4" />
                    {programConfirm.length === 1 ? "1 marcado está programado para otro día" : `${programConfirm.length} marcados están programados para otro día`}
                  </p>
                  <ul id="program-confirm-list" className="mt-1.5 flex flex-wrap gap-x-4 gap-y-0.5 pl-6 text-[13px]">
                    {programConfirm.slice(0, 8).map((q) => (
                      <li key={q.orderId}><b className="font-semibold text-ink-900">{q.orderName}</b> · {programDayLabel(q.programmedFor ?? "")}{q.programReason ? ` · ${q.programReason}` : ""}</li>
                    ))}
                    {programConfirm.length > 8 && <li>y {programConfirm.length - 8} más</li>}
                  </ul>
                  <div className="mt-2.5 flex flex-wrap items-center gap-2 pl-6">
                    <OpsButton ref={confirmFirst} variant="primary" size="sm" disabled={pending} onClick={() => assign({ confirmProgrammed: true })}>
                      Asignar igual {target}
                    </OpsButton>
                    {others > 0 && (
                      <OpsButton size="sm" disabled={pending} onClick={() => assign({ skip: new Set(programConfirm.map((q) => q.orderId)) })}>
                        Asignar solo los otros {others}
                      </OpsButton>
                    )}
                    <OpsButton variant="ghost" size="sm" onClick={() => setProgramConfirm(null)}>Cancelar</OpsButton>
                  </div>
                </div>
              );
            })()}

            {/* Escritorio: tabla de columnas como el Master, anchos fijos para
                lo corto y flexibles para pedido, cliente y estado; lo que se
                trunca lleva el texto completo en `title`. */}
            <div className="hidden max-h-[60vh] overflow-auto sm:block">
              <table className="w-full min-w-[900px] table-fixed border-collapse text-sm [&_th]:sticky [&_th]:top-0 [&_th]:z-10 [&_th]:bg-white [&_th]:shadow-[inset_0_-1px_0_var(--color-line)]">
                <colgroup>
                  <col className="w-11" />
                  <col className="w-[8.5rem]" />
                  <col className="w-[6.5rem]" />
                  <col />
                  <col className="w-[9.5rem]" />
                  <col className="w-[10rem]" />
                  <col className="w-[4.5rem]" />
                  <col className="w-[4.5rem]" />
                  <col className="w-[6rem]" />
                  <col className="w-[5.5rem]" />
                </colgroup>
                <thead>
                  <tr className="text-left text-xs font-semibold text-ink-600">
                    <th className="px-4 py-2.5"><span className="sr-only">Marcar</span></th>
                    <th className="px-3 py-2.5">Pedido</th>
                    <th className="px-3 py-2.5">Tienda</th>
                    <th className="px-3 py-2.5">Cliente</th>
                    <th className="px-3 py-2.5">Distrito</th>
                    <th className="px-3 py-2.5">Estado</th>
                    <th className="px-3 py-2.5">Creado</th>
                    <th className="px-3 py-2.5" title="Salida prevista: el día programado si lo tiene; si no, después del corte de las 11:30 el pedido sale al día siguiente. Para los que ya salieron, el día de su caja.">Sale</th>
                    <th className="px-3 py-2.5 text-right">Venta</th>
                    <th className="px-4 py-2.5 text-right">Tarifa</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((q) => (
                    <tr key={q.orderId} className={cn("border-b border-line align-top transition-colors", selected.has(q.orderId) ? "bg-brand-50/60" : "hover:bg-wash")}>
                      <td className="px-4 py-3">
                        <RowCheck q={q} checked={selected.has(q.orderId)} onToggle={() => toggle(q.orderId)} />
                      </td>
                      <td className="px-3 py-3">
                        <OrderLink orderId={q.orderId} className="block truncate font-semibold text-ink-900 hover:text-brand-700" title={q.orderName}>{q.orderName}</OrderLink>
                        <OrderLink orderId={q.orderId} section="historial" className="text-xs font-medium text-brand-700 hover:underline">Ver actividad</OrderLink>
                      </td>
                      <td className="truncate px-3 py-3 text-[13px] text-ink-600" title={q.storeName}>{q.storeName}</td>
                      <td className="px-3 py-3">
                        <p className="truncate text-ink-900" title={q.customerName}>{q.customerName}</p>
                        <p className="truncate text-xs tabular-nums text-ink-500" title={q.customerPhone ?? undefined}>{q.customerPhone ?? "sin teléfono"}</p>
                      </td>
                      <td className="truncate px-3 py-3 text-ink-700" title={q.district}>{q.district}</td>
                      <td className="px-3 py-3">
                        <StateBadges q={q} today={day} />
                        <RouteLine q={q} />
                      </td>
                      <td className="whitespace-nowrap px-3 py-3 text-[13px] tabular-nums text-ink-500" title={q.createdAt ? `Creado el ${formatDay(limaDay(q.createdAt) ?? q.createdAt)}` : undefined}>{q.createdAt ? formatDayNumeric(limaDay(q.createdAt)) : "—"}</td>
                      <td className="whitespace-nowrap px-3 py-3 text-[13px] tabular-nums text-ink-500" title={q.route ? `Caja del ${formatDay(q.route.routeDate)}` : `Salida prevista: ${formatDay(q.scheduledFor)}`}>
                        {q.route ? `caja ${formatDayNumeric(q.route.routeDate)}` : formatDayNumeric(q.scheduledFor)}
                      </td>
                      <td className="whitespace-nowrap px-3 py-3 text-right font-semibold tabular-nums text-ink-900">{money(q.orderTotal)}</td>
                      <td className="whitespace-nowrap px-4 py-3 text-right text-[13px] tabular-nums text-ink-500">{money(q.tariffAmount)}</td>
                    </tr>
                  ))}
                  {!visible.length && (
                    <tr><td colSpan={10} className="px-4 py-12 text-center text-sm text-ink-500">{tracking ? "Ningún pedido de Grupo GF con ese filtro." : "Nada por asignar con ese filtro."}</td></tr>
                  )}
                </tbody>
              </table>
            </div>

            {/* Teléfono: la misma fila como tarjeta, sin desplazamiento lateral. */}
            <ul className="divide-y divide-line sm:hidden">
              {visible.map((q) => (
                <li key={q.orderId} className={cn("flex gap-3 px-4 py-3", selected.has(q.orderId) && "bg-brand-50/60")}>
                  <div className="pt-0.5"><RowCheck q={q} checked={selected.has(q.orderId)} onToggle={() => toggle(q.orderId)} /></div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline justify-between gap-3">
                      <OrderLink orderId={q.orderId} className="min-w-0 truncate font-semibold text-ink-900" title={q.orderName}>{q.orderName}</OrderLink>
                      <span className="shrink-0 font-semibold tabular-nums text-ink-900">{money(q.orderTotal)}</span>
                    </div>
                    <p className="mt-0.5 text-[13px] text-ink-700">{q.customerName} · {q.district}</p>
                    <div className="mt-2"><StateBadges q={q} today={day} /></div>
                    <RouteLine q={q} />
                    <p className="mt-2 text-xs tabular-nums text-ink-500">
                      {q.storeName}{q.createdAt ? ` · creado ${formatDayNumeric(limaDay(q.createdAt))}` : ""} · {q.route ? `caja ${formatDayNumeric(q.route.routeDate)}` : `sale ${formatDayNumeric(q.scheduledFor)}`} · <span className="whitespace-nowrap">tarifa {money(q.tariffAmount)}</span>
                    </p>
                    <OrderLink orderId={q.orderId} section="historial" className="mt-1 inline-flex min-h-8 items-center text-xs font-medium text-brand-700">Ver actividad</OrderLink>
                  </div>
                </li>
              ))}
              {!visible.length && <li className="px-4 py-12 text-center text-sm text-ink-500">{tracking ? "Ningún pedido de Grupo GF con ese filtro." : "Nada por asignar con ese filtro."}</li>}
            </ul>

            {filtered.length > 0 && (
              <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line px-4 py-3 text-[13px] tabular-nums text-ink-500">
                <span>Mostrando <b className="font-semibold text-ink-900">{visible.length.toLocaleString("es-PE")}</b> de {filtered.length.toLocaleString("es-PE")}</span>
                {filtered.length > visible.length && (
                  <OpsButton size="sm" onClick={() => setLimit((n) => n + 100)}>
                    Mostrar 100 más
                  </OpsButton>
                )}
              </div>
            )}
          </div>
        )}

        {method === "cajas" && (
          <div className="border-t border-line">
            {/* El estado de los paquetes de todas las cajas del día: un filtro
                rápido compartido, con su cantidad. */}
            <div className="flex flex-wrap items-center gap-2 px-4 py-3">
              <div role="group" aria-label="Filtro rápido de las cajas" className="flex flex-wrap gap-1.5">
                {BOX_ITEM_FILTERS.map((f) => (
                  <ChoiceChip
                    key={f.id}
                    label={f.label}
                    count={f.id === "todos" ? dayCod : boxTiles[f.id]}
                    active={boxFilter === f.id}
                    title={f.id === "todos" ? undefined : BOX_TILE_LABEL[f.id].hint}
                    onClick={() => setBoxFilter(f.id)}
                  />
                ))}
              </div>
              {boxes.length > 0 && <p className="text-[13px] tabular-nums text-ink-500 lg:ml-auto">{boxes.length} {boxes.length === 1 ? "caja" : "cajas"} · {dayCod} paq. · toca una caja para ver sus paquetes</p>}
            </div>
            {boxes.length ? (
              <ul className="divide-y divide-line border-t border-line">
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
                  />
                ))}
              </ul>
            ) : (
              <p className="border-t border-line px-4 py-12 text-center text-sm text-ink-500">Todavía no hay cajas {scanDay === day ? "hoy" : "ese día"}: escanea o asigna desde la lista.</p>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

type PillId = "etapa" | "fecha" | "tienda" | "distrito" | "creado";

/** Pestaña de la forma de asignar: control segmentado con icono. */
function MethodTab({ active, onClick, icon: Glyph, label, shortLabel, children }: { active: boolean; onClick: () => void; icon: typeof IconQr; label: string; shortLabel: string; children?: ReactNode }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        "flex h-9 min-w-0 items-center justify-center gap-2 rounded-md px-2 text-sm font-semibold transition-[background-color,color,box-shadow] duration-150",
        active ? "bg-white text-ink-900 shadow-control ring-1 ring-line" : "text-ink-500 hover:text-ink-900",
      )}
    >
      <Glyph className={cn("hidden size-4 shrink-0 sm:block", active ? "text-brand-600" : "text-ink-500")} />
      <span className="truncate sm:hidden" aria-hidden>{shortLabel}</span>
      <span className="max-sm:sr-only truncate">{label}</span>
      {children}
    </button>
  );
}

/** Chip de elección con cantidad (subetapas, plazos, motivos, filtro de cajas). */
function ChoiceChip({ label, count, active, onClick, title }: { label: string; count?: number; active: boolean; onClick: () => void; title?: string }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      disabled={count === 0 && !active}
      onClick={onClick}
      title={title}
      className={cn(
        "inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-full px-3 text-[13px] font-medium transition-shadow",
        active ? "bg-brand-50 text-brand-700 ring-2 ring-inset ring-brand-600" : "bg-white text-ink-700 ring-1 ring-inset ring-line-strong hover:ring-ink-300",
        count === 0 && !active && "cursor-not-allowed opacity-40",
      )}
    >
      {label}
      {count != null && <span className={cn("tabular-nums", active ? "text-brand-700" : "text-ink-500")}>{count.toLocaleString("es-PE")}</span>}
    </button>
  );
}

/** Lista de una sola elección dentro de un popover de filtro. */
function OptionList({ options, value, onPick }: { options: Array<{ value: string; label: string }>; value: string; onPick: (value: string) => void }) {
  return (
    <div role="group" className="-mx-1 grid max-h-72 gap-0.5 overflow-auto">
      {options.map((o) => (
        <button
          key={o.value || "todas"}
          type="button"
          aria-pressed={o.value === value}
          onClick={() => onPick(o.value)}
          className={cn("flex h-9 items-center justify-between gap-2 rounded-md px-2 text-left text-sm hover:bg-wash", o.value === value ? "font-semibold text-ink-900" : "text-ink-700")}
        >
          <span className="truncate">{o.label}</span>
          {o.value === value && <IconCheck className="size-4 shrink-0 text-brand-600" />}
        </button>
      ))}
    </div>
  );
}

/** La casilla de una fila, o el hueco punteado de lo que solo se sigue. */
function RowCheck({ q, checked, onToggle }: { q: QueueRow; checked: boolean; onToggle: () => void }) {
  if (q.assignable || isReturnable(q)) {
    return <input type="checkbox" className={CHECKBOX} checked={checked} onChange={onToggle} aria-label={`Marcar ${q.orderName}`} />;
  }
  return <span aria-hidden className="block size-4 rounded border border-dashed border-line-strong" title={q.route ? "Ya salió: se sigue, no se asigna" : "Pedido cerrado o cerrándose: no se asigna"} />;
}

/** Las chapas de estado de una fila de la cola. */
function StateBadges({ q, today }: { q: QueueRow; today: string }) {
  return (
    <div className="flex flex-wrap items-center gap-1">
      {q.route?.undeliveredReason && <Badge tone="urgent" title="Sigue en la caja del motorizado: márcalo y «Recibir en oficina» cuando vuelva el paquete">No entregado · {nonDeliveryReasonLabel(q.route.undeliveredReason)}</Badge>}
      {q.failedOutput && <Badge tone="crit" title="Otro courier no lo entregó. Al asignarlo se crea una salida nueva y Almacén arma otra caja con su rótulo.">{failedOutputLabel(q.failedOutput)}</Badge>}
      {q.tandersReview && <span className="text-xs text-warn-fg" title="Confirma el paquete antes de asignar. Tanders conserva su salida original.">Tanders · despacho anterior · sin entrega · {programDayLabel(limaDay(q.tandersReview.dispatchedAt)!)}</span>}
      {q.assignable && q.programmedFor && <ProgramChip day={q.programmedFor} today={today} reason={q.programReason ?? null} />}
      {q.taken && !q.route && <Badge>tomado · sin caja</Badge>}
      {!q.assignable && q.macroSubstage && <Badge tone="info" title={macroStageLabel(q.macroStage)}>{macroSubstageLabel(q.macroSubstage)}</Badge>}
      {q.taken && q.armed && <Badge tone="ok">armado</Badge>}
      {q.hasPriorDispatch && <Badge title="Salió a reparto al menos una vez y volvió: reprogramación o recuperación"><IconRepeat className="size-3" />ya salió</Badge>}
      {q.observation && <Badge tone="warn" title={q.observation}>observado</Badge>}
      {!q.taken && !q.hasPriorDispatch && !q.observation && !q.programmedFor && <span className="text-[13px] text-ink-500">disponible</span>}
    </div>
  );
}

/** Para lo que ya salió: el motorizado, la carga y si lo lleva. */
function RouteLine({ q }: { q: QueueRow }) {
  if (!q.route) return null;
  return (
    <p className="mt-1 truncate text-xs text-ink-500" title={`${q.route.riderName} · caja del ${formatDayNumeric(q.route.routeDate)}${q.route.loadNumber > 1 ? ` · carga ${q.route.loadNumber}` : ""}`}>
      <b className="font-semibold text-ink-700">{q.route.riderName}</b>{q.route.loadNumber > 1 ? ` · carga ${q.route.loadNumber}` : ""}
      {" · "}{q.route.pickupCheckedAt ? "lo lleva" : q.route.officeCheckedAt ? "cotejado · sin «Lo llevo»" : "en la caja · sin cotejar"}
    </p>
  );
}

function BoxRow({ box, cash, riders, orgId, open, onToggle, canManage, onChanged, pickupMode, filter }: {
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
  // Modo «confirmar» (0185): lo asignado que el motorizado aún no confirmó con
  // «Lo llevo». Se puede quitar o mover desde aquí; el RPC borra su parada.
  const confirmMode = pickupMode === "confirmar";
  const unconfirmed = confirmMode
    ? box.loads.filter((m) => m.state === "in_custody").flatMap((m) => activeDispatchItems(m.items).filter((i) => !i.pickup_checked_at).map((i) => ({ manifestId: m.id, item: i })))
    : [];
  const initials = box.riderName.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toLocaleUpperCase("es")).join("");
  const step = (done: number, label: string) => (
    <Badge tone={box.assigned && done >= box.assigned ? "ok" : "neutral"} className="tabular-nums">{done}/{box.assigned} {label}</Badge>
  );
  return (
    <li>
      <button type="button" onClick={onToggle} aria-expanded={open} title={`${boxNextStep(box)} · ${box.assigned} paquetes · ${box.armed} armados por Almacén · ${box.officeChecked} cotejados en oficina · ${box.pickupChecked} ${confirmMode ? "confirmados con «Lo llevo»" : "recibidos por el motorizado"}${box.declined ? ` · ${box.declined} no los llevó` : ""}${box.loads.length > 1 ? ` · ${box.loads.length} cargas` : ""} · efectivo previsto ${money(cash)}`} className="flex w-full items-center gap-3 px-4 py-3 text-left text-sm transition-colors hover:bg-wash">
        <span aria-hidden className="grid size-8 shrink-0 place-items-center rounded-full bg-line text-xs font-semibold text-ink-600">{initials}</span>
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-baseline gap-x-2">
            <span className="font-semibold text-ink-900">{box.riderName}</span>
            <span className="text-[13px] tabular-nums text-ink-500">{box.assigned} paq. · {moneyShort(cash)}{box.loads.length > 1 ? ` · ${box.loads.length} cargas` : ""}</span>
          </span>
          <span className="mt-1 flex flex-wrap gap-1">
            {step(box.armed, "armados")}
            {step(box.officeChecked, "cotejados")}
            {step(box.pickupChecked, confirmMode ? "confirmados" : "recibidos")}
            {box.declined > 0 && <Badge tone="crit" className="tabular-nums">{box.declined} no recogidos</Badge>}
          </span>
        </span>
        <span className="hidden shrink-0 text-[13px] text-ink-500 md:block">{boxNextStep(box)}</span>
        <IconChevronRight className={cn("size-4 shrink-0 text-ink-500 transition-transform duration-150", open && "rotate-90")} />
      </button>
      {open && (
        <div className="space-y-3 border-t border-line bg-wash px-4 py-3">
          {message && <Banner tone={message.ok ? "ok" : "crit"} role={message.ok ? "status" : "alert"}>{message.text}</Banner>}
          {confirmMode && unconfirmed.length > 0 && (
            <Banner tone="warn">
              <details>
                <summary className="flex cursor-pointer list-none items-center gap-1.5 font-semibold text-warn-fg [&::-webkit-details-marker]:hidden">Sin confirmar por {box.riderName} · {unconfirmed.length}<IconChevronDown className="size-4" /></summary>
                <p className="mt-1 text-[13px]">Asignados que todavía no escaneó al sacarlos del almacén. Si no se los llevó, quítalos o muévelos: vuelven a «por asignar».</p>
                <ul className="mt-2 divide-y divide-warn-bg">
                  {unconfirmed.map(({ manifestId, item }) => {
                    const s = item.shipment;
                    const code = s?.output_code ?? s?.guide_code ?? s?.order_name ?? "";
                    return (
                      <li key={item.id} className="flex flex-wrap items-center gap-2 py-1.5">
                        <span className="min-w-0 flex-1 truncate"><span className="font-semibold text-ink-900">{s?.order_name ?? code}</span> <span className="text-[13px] text-ink-500">{s?.customer_name} · {s?.district}</span></span>
                        {canManage && (
                          <>
                            <MoveSelect riders={riders} currentRiderId={box.riderId} disabled={pending} label={`Mover ${s?.order_name ?? code} a otro motorizado`} onPick={(v) => move(manifestId, item.shipment_id, v)} />
                            <OpsButton variant="ghost" size="sm" disabled={pending} onClick={() => remove(manifestId, item.shipment_id)} className="text-crit-fg hover:bg-crit-wash hover:text-crit-fg">Quitar</OpsButton>
                          </>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </details>
            </Banner>
          )}
          {box.loads.map((m) => {
            const active = filterBoxItems(m.items, filter);
            const removed = m.items.filter((i) => !!i.removed_at);
            const checkable = canCheck && !["in_custody", "cancelled"].includes(m.state);
            return (
              <div key={m.id} className="overflow-hidden rounded-lg bg-white shadow-control ring-1 ring-line">
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-3 py-2 text-[13px]">
                  <span className="font-semibold text-ink-900">Carga {m.load_number ?? 1} <span className="font-normal text-ink-500">· {stateLabel(m.state)}</span></span>
                  <Link href={`/dashboard/courier/rutas?manifiesto=${encodeURIComponent(m.id)}`} className="text-xs font-medium text-brand-700 hover:underline">Abrir en la mesa</Link>
                </div>
                {checkable && (
                  <div className="space-y-2 border-b border-line px-3 py-3">
                    <div className="inline-grid grid-cols-2 gap-0.5 rounded-md bg-wash p-0.5 ring-1 ring-inset ring-line" role="group" aria-label="Qué hace el escaneo">
                      {([["oficina_cotejo", "Cotejar"], ["supervisor_retiro", "Retirar"]] as const).map(([mode, text]) => (
                        <button key={mode} type="button" onClick={() => setScanMode(mode)} aria-pressed={scanMode === mode} className={cn("h-7 rounded px-3 text-xs font-semibold transition-colors", scanMode === mode ? "bg-white text-ink-900 shadow-control" : "text-ink-500 hover:text-ink-900")}>{text}</button>
                      ))}
                    </div>
                    <ScanAction context={scanMode} manifestId={m.id} disabled={pending} onResult={(r) => say(r)} />
                  </div>
                )}
                <ul className="divide-y divide-line">
                  {active.map((item) => {
                    const s = item.shipment;
                    const code = s?.output_code ?? s?.guide_code ?? s?.order_name ?? "";
                    return (
                      <li key={item.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2.5 text-sm">
                        <span aria-label={item.office_checked_at ? "Cotejado" : "Pendiente"} className={cn("grid size-5 shrink-0 place-items-center rounded-full", item.office_checked_at ? "bg-ok-fg text-white" : "ring-1 ring-inset ring-line-strong")}>
                          {item.office_checked_at && <IconCheck className="size-3" />}
                        </span>
                        <div className="min-w-0 flex-1">
                          <p className="truncate"><span className="font-semibold text-ink-900">{s?.order_name ?? code}</span> <span className="text-[13px] text-ink-500">{s?.customer_name} · {s?.district}</span></p>
                          <p className="mt-1 flex flex-wrap items-center gap-1.5">
                            <StageChip stage={packageStage(item)} confirmMode={confirmMode} />
                            {confirmMode && m.state === "in_custody" && !item.pickup_checked_at && !item.pickup_declined_at && <Badge tone="warn">por confirmar</Badge>}
                            {s?.order_id && <OrderLink orderId={s.order_id} section="historial" className="text-xs font-medium text-brand-700 hover:underline">Ver actividad</OrderLink>}
                          </p>
                        </div>
                        {checkable && !item.office_checked_at && code && (
                          <OpsButton size="sm" disabled={pending} onClick={() => scan(m.id, code)}>Cotejar</OpsButton>
                        )}
                        {checkable && (
                          <>
                            <MoveSelect riders={riders} currentRiderId={box.riderId} disabled={pending} label={`Mover ${s?.order_name ?? code} a otro motorizado`} onPick={(v) => move(m.id, item.shipment_id, v)} />
                            <OpsButton variant="ghost" size="sm" disabled={pending} onClick={() => remove(m.id, item.shipment_id)} className="text-crit-fg hover:bg-crit-wash hover:text-crit-fg">Quitar</OpsButton>
                          </>
                        )}
                      </li>
                    );
                  })}
                  {!active.length && <li className="px-3 py-6 text-center text-[13px] text-ink-500">{filter === "todos" ? "Sin paquetes activos." : "Nada con ese filtro en esta carga."}</li>}
                </ul>
                {removed.length > 0 && (
                  <details className="border-t border-line px-3 py-2 text-[13px] text-ink-600">
                    <summary className="flex cursor-pointer list-none items-center gap-1.5 font-medium [&::-webkit-details-marker]:hidden">Retirados o no recogidos ({removed.length})<IconChevronDown className="size-4" /></summary>
                    <ul className="mt-1 space-y-1 text-ink-500">
                      {removed.map((i) => <li key={i.id}><span className="font-medium text-ink-700">{i.shipment?.order_name ?? i.shipment_id}</span> · {i.removal_reason}</li>)}
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

/** «Mover a…»: el selector de otro motorizado, que se vacía tras elegir. */
function MoveSelect({ riders, currentRiderId, disabled, label, onPick }: { riders: CourierRiderOption[]; currentRiderId: string | null; disabled: boolean; label: string; onPick: (riderId: string) => void }) {
  return (
    <select
      aria-label={label}
      defaultValue=""
      disabled={disabled}
      onChange={(e) => { const v = e.target.value; e.target.value = ""; if (v) onPick(v); }}
      className={cn(FIELD, "h-8 w-auto pr-8 text-[13px]")}
    >
      <option value="">Mover a…</option>
      {riders.filter((r) => r.id !== currentRiderId).map((r) => <option key={r.id} value={r.id}>{r.fullName}</option>)}
    </select>
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
 * Cómo se lee el resultado de un escaneo en su fila: una chapa por gravedad.
 * Verde entró, ámbar hay algo que decidir (mover, autorizar, confirmar, ya
 * estaba), rosa no entró.
 */
function scanRowPresentation(l: ScanAssignLine, riderName: string): { text: string; tone: BadgeTone } {
  switch (l.status) {
    case "procesando":
      return { text: "Asignando…", tone: "neutral" };
    case "asignado":
      // Volvió de la caja de otro día y el mismo escaneo lo recibió en oficina.
      return { text: `En la caja de ${l.riderName ?? riderName}${l.receivedFrom ? ` · volvió de ${l.receivedFrom}` : ""}`, tone: "ok" };
    case "ya_en_caja":
      return { text: "Ya estaba", tone: "warn" };
    case "en_otra_caja":
      return { text: `En la caja de ${l.riderName ?? "otro"}`, tone: "warn" };
    case "bloqueado_efectivo":
      return { text: "Límite de efectivo", tone: "warn" };
    case "programado_otro_dia":
      return { text: `Programado ${l.programmedFor ? programDayLabel(l.programmedFor) : "otro día"}`, tone: "warn" };
    case "no_elegible":
      return { text: l.message ? `No elegible: ${l.message.replace(/\.$/, "")}` : "No elegible", tone: "crit" };
    default:
      return { text: "QR desconocido", tone: "crit" };
  }
}

/**
 * Chapa de la salida programada: «programado hoy», «programado vie 02/10» o,
 * si el día pasó sin que saliera, «programado lun 28/09 · vencido» en ámbar.
 */
function ProgramChip({ day, today, reason }: { day: string; today: string; reason: string | null }) {
  const overdue = day < today;
  const text = day === today ? "programado hoy" : `programado ${programDayLabel(day)}${overdue ? " · vencido" : ""}`;
  return <Badge wrap tone={overdue ? "warn" : "info"} title={reason ? `Motivo: ${reason}` : undefined}><IconCalendar className="size-3 shrink-0" />{text}</Badge>;
}

/** Chapa del estado del paquete en la caja: por armar · armado · cotejado · confirmado · no lo llevó. */
function StageChip({ stage, confirmMode }: { stage: ReturnType<typeof packageStage>; confirmMode: boolean }) {
  const text = stage === "confirmado" && !confirmMode ? "recibido" : PACKAGE_STAGE_LABEL[stage];
  const tone: BadgeTone = stage === "por_armar" ? "warn" : stage === "armado" ? "info" : stage === "no_lo_llevo" ? "crit" : "ok";
  return <Badge tone={tone}>{text}</Badge>;
}

/** «19/09» desde YYYY-MM-DD; vacío si no hay fecha. */
function formatDayNumeric(day: string | null): string {
  if (!day) return "";
  const [, m, d] = day.split("-");
  return `${d}/${m}`;
}

/**
 * Qué hace «superar el límite», con los montos vigentes (MOM §29.9). Va en el
 * `title`: se lee al pasar el ratón sin ocupar sitio en la barra.
 */
function cashOverrideHint(warning: number, limit: number): string {
  const soles = (n: number) => `S/ ${n.toLocaleString("es-PE", { maximumFractionDigits: 0 })}`;
  return `Límite de efectivo de la ruta: cada caja suma la venta de sus pedidos, que es lo que el motorizado cobrará en la calle. Desde ${soles(warning)} se avisa; desde ${soles(limit)} el pedido no entra en la caja. Marca esta casilla para autorizar que entre igual: queda registrado con tu usuario.`;
}
