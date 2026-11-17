"use client";

// Repro Lima (MOM §9.5): el panel de gestión del equipo de Lima (owner,
// 15-11-2026). El «Flujo del día» —cinco pasos que suman el total— y la
// «Programados» sobre UNA lista: cada tarjeta filtra esa lista (`atencion` en la
// URL; los valores de la pantalla anterior abren lo más cercano) y los
// trabados del equipo (§9.6) van dentro de su paso (`trabado`). Las acciones
// conservan los permisos y guardas del pedido y de cada caso.
//
// «Programar» pone el día sin abrir la ficha y el lote lo pone a varios, por
// la acción que ya existe para cada pedido (`agendarReproLima`). «Atender»
// abre la ficha del pedido en su pestaña «Repro Lima»
// (`?ficha=<pedido>&seccion=reprolima`, 07-11-2026) para llamar y registrar la
// gestión. El tablero publica cuál es el siguiente de esta lista
// (lib/repro-lima-queue.ts) para «Guardar y pasar al siguiente».
//
// Lo de adentro del reparto de Grupo GF —«Sale a reparto» y los trabados de sus
// cajas y motorizados— está en Grupo GF Courier → Despacho del día.
import { useEffect, useMemo, useRef, useState, useTransition, type ReactNode } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { cn } from "@/components/ui";
import { AttentionPill, Badge, Banner, FIELD, FilterPill, OpsButton, StatusCard, ChoiceChip } from "@/components/ops-ui";
import { Sheet } from "@/components/filter-sheet";
import { DateRangePill, FacetPill } from "@/components/facet-pill";
import { IconAlert, IconCheck, IconSearch, IconX } from "@/components/icons";
import { useOpenOrderDrawer } from "@/components/order-link";
import type { ReproLimaData } from "@/lib/repro-lima-access";
import { cutoffNotice } from "@/lib/repro-lima";
import { limaClock } from "@/lib/grupo-gf-courier";
import { programDayLabel } from "@/lib/dispatch-day";
import { LimaPendingFilters, LimaPendingList, type LimaRowSelection } from "@/components/repro-lima-pending";
import { ReproLimaBlocks, STEP_TONE, activeStep } from "@/components/repro-lima-blocks";
import { NoEntregoButton } from "@/components/repro-lima-no-entrego";
import { QuickGuideButtons } from "@/components/repro-lima-quick-guide";
import { OpsToast, type OpsToastData } from "@/components/ops-toast";
import { AgendarButton, ChannelPicker, CourierPicker, DayPicker, agendarOutcome, newAgendarOperationId, type AgendarChannel } from "@/components/repro-lima-agendar";
import { clearReproLimaQueue, setReproLimaQueue, type ReproLimaQueue } from "@/lib/repro-lima-queue";
import { LIMA_STUCK_HOME_LABEL, limaStuckItems, limaStuckRule, stuckFilter, stuckMovedTo, type LimaStuckHome } from "@/lib/lima-stuck";
import { approveAliclikRetry } from "@/app/dashboard/pedidos/repro-lima/retry-actions";
import { agendarReproLima, type AgendarResult } from "@/app/dashboard/pedidos/repro-lima/agenda-actions";
import { retryApproveNoLocation } from "@/lib/lima-retry-auto";
import {
  LIMA_SUB_FILTERS,
  agendaWindow,
  agendarMaxDay,
  agendarPath,
  batchCourierChoices,
  batchCourierRejects,
  boardCard,
  boardFilter,
  callDue,
  classifyLimaRows,
  hoySinGuiaAlert,
  limaBoardCounts,
  limaBoardRows,
  limaOwnRoute,
  limaQuickGuideEligible,
  limaStepPart,
  programarBatchLabel,
  proposalsNoun,
  limaSuggestedDay,
  type LimaBoardKey,
  type LimaStep,
} from "@/lib/repro-lima-blocks";
import { DISPATCH_COURIER_LABEL, DISPATCH_DATE_MAX_DAYS, isDispatchCourier, type DispatchCourier } from "@/lib/dispatch-date";
import { RESCHEDULE_MAX_DAYS } from "@/lib/gf-dispatch-program";
import { NOVELTY_OPTIONS, noveltyKey, createdPresets, emptyRowFilters, groupApprovalFailures, pendingKey, pendingMatches, readRowFilters, retryApprovalTargets, rowFilterOptions, rowFiltersParam, rowFiltersActive, rowFiltersMatch, togglePendingKeys, writeRowFilters, type LimaPendingOrder, type LimaRowFilters } from "@/lib/repro-lima-pending";

const FOCUS_REFRESH_MS = 20_000;
/** Los trabados que se ven en Repro Lima; los de Grupo GF, en Despacho del día. */
const TEAM_HOMES: readonly LimaStuckHome[] = ["gestion", "courier"];

type Feedback = {
  kind: "notice" | "error";
  text: string;
  extra?: string | null;
  /** Una línea por motivo (`groupApprovalFailures`). */
  lines?: string[];
  /** Algún pedido no tuvo Google porque está apagado o Lima no está medida. */
  googleOff?: boolean;
  /** Pedidos cuya guía de GF Courier no se anuló o no se creó al mover su acuerdo: su Mesa de ruta. */
  mesa?: Array<{ orderId: string; orderName: string }>;
  /** También salió como aviso flotante: el lector lo oye una vez. */
  toasted?: boolean;
};

export function ReproLimaBoard({ data, pending, retriesOnly = false, canScheduleDispatch = false, canReportForRider = false, autoGuideStores = [], quickGuide, gfApiStores = [], courierAutoStores = [] }: {
  data: ReproLimaData;
  pending: LimaPendingOrder[];
  /** Despacho sin `repro_lima.manage` (03-11-2026): solo «Reintentos Aliclik», sin Atender ni Agendar. */
  retriesOnly?: boolean;
  /** «Programar envío» (§6.2) pide `master.edit`: sin él, «Agendar» solo cambia acuerdos. */
  canScheduleDispatch?: boolean;
  /** «No se entregó» escribe por el motorizado (`routes.report_others`, como Coordinación). */
  canReportForRider?: boolean;
  /** Las tiendas con la guía GF automática en Activo: su guía de mañana no alarma. */
  autoGuideStores?: readonly string[];
  /**
   * «Guía Aliclik» y «Guía GF» bajo «Atender» (owner, 16-11-2026): con el
   * permiso de cada courier y, para GF, las tiendas con GF Courier habilitado.
   */
  quickGuide?: { aliclik: boolean; gfStores: readonly string[] };
  /** Las tiendas con GF Courier por API: al programar se ofrece GF Courier en vez de Grupo GF (16-11-2026). */
  gfApiStores?: readonly string[];
  /** Las tiendas con «Guía Aliclik y Swayp del día programado» en Activo (0349): Kapta crea esa guía sola. */
  courierAutoStores?: readonly string[];
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [refreshing, startRefresh] = useTransition();
  const [now, setNow] = useState(() => new Date(data.nowIso));
  const today = limaClock(now).day;
  const key: LimaBoardKey = retriesOnly ? "reintentos_aliclik" : boardFilter(searchParams.get("atencion"), today);
  // «Lima trabados» (§9.6): el motivo elegido viaja por `trabado`. Uno que se
  // mudó a Grupo GF Courier no filtra aquí: se dice a dónde se fue.
  const stuckParam = searchParams.get("trabado");
  const stuck = retriesOnly ? null : stuckFilter(stuckParam, TEAM_HOMES);
  const moved = retriesOnly ? null : stuckMovedTo(stuckParam, TEAM_HOMES);
  const [query, setQuery] = useState("");
  const [store, setStore] = useState("");
  const [storeSheet, setStoreSheet] = useState(false);
  const storePill = useRef<HTMLButtonElement>(null);
  const [stageSheet, setStageSheet] = useState(false);
  const stagePill = useRef<HTMLButtonElement>(null);
  const openDrawer = useOpenOrderDrawer();
  const gfStores = useMemo(() => new Set(quickGuide?.gfStores ?? []), [quickGuide?.gfStores]);
  const gfApi = useMemo(() => new Set(gfApiStores), [gfApiStores]);
  const courierAuto = useMemo(() => new Set(courierAutoStores), [courierAutoStores]);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  // El aviso flotante de «Guía Aliclik» / «Guía GF» (owner, 16-11-2026): repite el éxito donde se mira.
  const [toast, setToast] = useState<OpsToastData | null>(null);
  const lastRefresh = useRef(0);
  const hiddenParam = searchParams.getAll("ocultar").join("|");
  const hidden = useMemo(() => new Set(hiddenParam ? hiddenParam.split("|") : []), [hiddenParam]);
  const pendingStore = useMemo(() => pending.filter((row) => !store || row.storeId === store), [pending, store]);
  // Creación, Canal, Distrito y Courier (06-11-2026) recortan como Tienda: los
  // bloques y la lista. Viven en la URL, como las exclusiones.
  // Solo sus parámetros: abrir la ficha cambia la URL y no debe rehacer la lista.
  const rowFiltersKey = rowFiltersParam(searchParams);
  const rowFilters = useMemo(() => readRowFilters(new URLSearchParams(rowFiltersKey)), [rowFiltersKey]);
  const activeRowFilters = rowFiltersActive(rowFilters);
  const narrowed = useMemo(() => activeRowFilters ? pendingStore.filter((row) => rowFiltersMatch(row, rowFilters)) : pendingStore, [pendingStore, rowFilters, activeRowFilters]);
  // Cada píldora cuenta con las DEMÁS puestas: con «Antes de ayer o más», Canal
  // dice cuántos de esos son de cada canal.
  const filterOptions = useMemo(() => {
    const without = (field: "channels" | "districts" | "couriers") => rowFilterOptions(
      activeRowFilters ? pendingStore.filter((row) => rowFiltersMatch(row, { ...rowFilters, [field]: new Set<string>() })) : pendingStore,
    )[field];
    // «Nuevo» (17-11-2026): cuántos nuevos y no nuevos hay con los demás filtros puestos.
    const base = activeRowFilters ? pendingStore.filter((row) => rowFiltersMatch(row, { ...rowFilters, novelty: new Set<string>() })) : pendingStore;
    const novelty = NOVELTY_OPTIONS.map((o) => ({ value: o.value, label: o.label, count: base.filter((row) => noveltyKey(row) === o.value).length }));
    return { channels: without("channels"), districts: without("districts"), couriers: without("couriers"), novelty };
  }, [pendingStore, rowFilters, activeRowFilters]);
  const scoped = useMemo(() => narrowed.filter((row) => !hidden.has(pendingKey(row)) && pendingMatches(row, query)), [narrowed, hidden, query]);
  // El paso, el día y el courier: una clasificación por pedido, para las cifras y la lista.
  const agendaDays = useMemo(() => agendaWindow(today), [today]);
  const autoGuideKey = autoGuideStores.join(",");
  const autoGuide = useMemo(() => new Set(autoGuideKey ? autoGuideKey.split(",") : []), [autoGuideKey]);
  const classes = useMemo(
    () => classifyLimaRows(scoped, data.rows, today, agendaDays, { autoGuideStores: autoGuide, courierAutoStores: courierAuto }),
    [scoped, data.rows, today, agendaDays, autoGuide, courierAuto],
  );
  const counts = useMemo(() => limaBoardCounts(scoped, classes), [scoped, classes]);
  const caseById = useMemo(() => new Map(data.rows.map((row) => [row.orderId, row])), [data.rows]);
  // `loadReproLima` ya ordena los casos (`sortRepro`): No entregados y Llamar después siguen ese orden.
  const caseOrder = useMemo(() => new Map(data.rows.map((row, i) => [row.orderId, i])), [data.rows]);
  const stuckItems = useMemo(
    () => retriesOnly ? [] : limaStuckItems(scoped, today).filter((item) => TEAM_HOMES.includes(limaStuckRule(item.reason).home)),
    [scoped, today, retriesOnly],
  );
  const stuckByOrder = useMemo(() => new Map(stuckItems.map((item) => [item.orderId, item])), [stuckItems]);
  // Los trabados viven dentro de su paso (owner, 15-11-2026): cuántos tiene cada uno.
  const stuckByStep = useMemo(() => {
    const out: Record<LimaStep, number> = { novedad: 0, llamar_despues: 0, no_entregados: 0, por_sacar: 0, programados: 0, con_courier: 0, por_cerrar: 0 };
    for (const item of stuckItems) {
      const step = classes.get(item.orderId)?.step;
      if (step) out[step] = (out[step] ?? 0) + 1;
    }
    return out;
  }, [stuckItems, classes]);
  // «Llamar después» cuya hora ya llegó: la celda del paso lo dice en rojo.
  const callsDue = useMemo(
    () => scoped.filter((row) => classes.get(row.orderId)?.step === "llamar_despues" && callDue(caseById.get(row.orderId), now)).length,
    [scoped, classes, caseById, now],
  );
  const inQueue = useMemo(() => {
    if (stuck) {
      // Los trabados, en su orden: por motivo y lo que más lleva primero; con un
      // paso elegido, solo los de ese paso.
      const byId = new Map(scoped.map((row) => [row.orderId, row]));
      return stuckItems.filter((item) => (stuck === "todos" || item.reason === stuck) && (key === "todos" || classes.get(item.orderId)?.step === key))
        .map((item) => byId.get(item.orderId))
        .filter((row): row is LimaPendingOrder => Boolean(row));
    }
    return limaBoardRows(scoped, classes, key, caseOrder);
  }, [stuck, stuckItems, scoped, classes, key, caseOrder]);
  const storeName = data.stores.find((s) => s.id === store)?.name ?? null;

  // La selección es de una lista: al cambiar de tarjeta se vacía.
  const [picked, setPicked] = useState<Set<string>>(() => new Set());

  function replaceParams(params: URLSearchParams) {
    params.delete("vista");
    const qs = params.toString();
    window.history.replaceState(null, "", qs ? `${pathname}?${qs}` : pathname);
  }

  function changeHidden(next: ReadonlySet<string>) {
    const params = new URLSearchParams(searchParams.toString());
    params.delete("ocultar");
    for (const k of [...next].sort()) params.append("ocultar", k);
    replaceParams(params);
  }

  function patchRowFilters(next: Partial<LimaRowFilters>) {
    const params = new URLSearchParams(searchParams.toString());
    writeRowFilters(params, { ...rowFilters, ...next });
    replaceParams(params);
  }

  /** Una tarjeta o un chip de los bloques: tocar la elegida vuelve a Todos. */
  function chooseKey(next: LimaBoardKey) {
    setPicked(new Set());
    const params = new URLSearchParams(searchParams.toString());
    params.delete("trabado");
    if (next === "todos" || (next === key && !stuck)) params.delete("atencion");
    else params.set("atencion", next);
    replaceParams(params);
  }

  /** «Trabados» dentro de un paso: los trabados de ese paso; tocarlo otra vez vuelve al paso. */
  function chooseStepStuck(step: LimaStep) {
    setPicked(new Set());
    const params = new URLSearchParams(searchParams.toString());
    params.set("atencion", step);
    if (stuck && key === step) params.delete("trabado");
    else params.set("trabado", "todos");
    replaceParams(params);
  }

  // Un enlace guardado de la doble vista siempre abre Todos. Se conservan
  // la ficha y las exclusiones; no se vuelve a pedir la página al servidor.
  useEffect(() => {
    if (searchParams.has("vista")) replaceParams(new URLSearchParams(searchParams.toString()));
  }, [searchParams]);

  // El reloj del corte: empieza en la hora del servidor (sin desajuste al hidratar).
  useEffect(() => {
    setNow(new Date());
    const timer = window.setInterval(() => setNow(new Date()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  const cutoff = cutoffNotice(data.cutoffLabel, now);

  function refresh() {
    lastRefresh.current = Date.now();
    startRefresh(() => router.refresh());
  }

  // Al volver a la pestaña (después de una llamada, por ejemplo), se relee.
  useEffect(() => {
    lastRefresh.current = Date.now();
    const onFocus = () => {
      if (document.visibilityState !== "visible") return;
      if (Date.now() - lastRefresh.current < FOCUS_REFRESH_MS) return;
      lastRefresh.current = Date.now();
      startRefresh(() => router.refresh());
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [router]);

  /** El siguiente de la misma lista, que nadie más esté atendiendo. */
  function nextAfter(orderId: string): LimaPendingOrder | null {
    const rows = inQueue;
    const at = rows.findIndex((row) => row.orderId === orderId);
    const after = at >= 0 ? [...rows.slice(at + 1), ...rows.slice(0, at)] : rows;
    return after.find((row) => row.orderId !== orderId && caseById.get(row.orderId)?.claim.view !== "otro" && caseById.get(row.orderId)?.list !== "cerrados") ?? null;
  }

  // «Guardar y pasar al siguiente» se pulsa en la ficha (pestaña «Repro Lima»),
  // que no ve esta lista: el tablero le dice cuál sigue, con sus filtros.
  useEffect(() => {
    if (retriesOnly) return;
    const queue: ReproLimaQueue = { next: (orderId) => nextAfter(orderId)?.orderId ?? null };
    setReproLimaQueue(queue);
    return () => clearReproLimaQueue(queue);
    // `nextAfter` lee `inQueue` y `caseById`: se publica de nuevo cuando cambian.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inQueue, caseById, retriesOnly]);

  /** Con qué acción existente se agenda cada pedido (`agendarPath`). */
  const pathOf = (row: LimaPendingOrder) => agendarPath(row, caseById.get(row.orderId), { canScheduleDispatch });

  /** «Agendar» pone el día sin abrir la ficha; «Atender» abre la gestión en la pestaña «Repro Lima». */
  function rowActions(row: LimaPendingOrder, stacked = false): ReactNode {
    // Sin `repro_lima.manage` no se llama ni se acuerda: la guía se crea desde la ficha.
    if (retriesOnly) return null;
    const size = stacked ? "sm" : "md";
    const path = pathOf(row);
    const cls = classes.get(row.orderId);
    return (
      <>
        {path.kind && (
          <AgendarButton
            row={row}
            path={path}
            today={today}
            size={size}
            // Sin día, llega elegido el que propone Kapta: el equipo lo confirma (owner, 15-11-2026).
            suggested={classes.get(row.orderId)?.agendaDay ? undefined : limaSuggestedDay(today)}
            hasDay={Boolean(classes.get(row.orderId)?.agendaDay)}
            gfCourierApi={gfApi.has(row.storeId)}
            courierAuto={courierAuto.has(row.storeId)}
            currentCourier={isDispatchCourier(row.scheduledCourier) ? row.scheduledCourier : null}
            onDone={(f) => { setFeedback({ kind: f.kind, text: f.text, mesa: f.mesa ? [f.mesa] : undefined }); refresh(); }}
          />
        )}
        {/* Ruta vencida del reparto propio: la clienta confirma que no lo recibió → se registra por el motorizado (owner, 15-11-2026). */}
        {canReportForRider && classes.get(row.orderId)?.noReport && limaOwnRoute(row) && (
          <NoEntregoButton row={row} size={size} onDone={(f) => { setFeedback(f); refresh(); }} />
        )}
        <OpsButton size={size} className="pointer-coarse:h-11" onClick={() => openDrawer(row.orderId, "reprolima")}>Atender</OpsButton>
        {/* Crear la guía directo, por las mismas acciones de la Mesa de ruta (owner, 16-11-2026: «como un fast forward»). */}
        {quickGuide && cls && limaQuickGuideEligible(row, cls) && (
          <QuickGuideButtons
            row={row}
            aliclik={quickGuide.aliclik}
            gf={gfStores.has(row.storeId)}
            size={size}
            onDone={(f) => {
              setFeedback({ kind: f.kind, text: f.text, toasted: Boolean(f.toast) });
              if (f.toast) {
                setToast({ id: Date.now(), ...f.toast, action: { label: "Abrir la Mesa de ruta", onClick: () => openDrawer(row.orderId, "operar") } });
              }
              refresh();
            }}
            onOpenFicha={() => openDrawer(row.orderId, "operar")}
          />
        )}
      </>
    );
  }

  // «Aprobar todos» (entrega 2): los de la bandeja que ya se pueden aprobar
  // (fallaron un día anterior; no esperan la devolución, owner 03-11-2026),
  // uno por uno por el mismo camino que «Aprobar»; al final, el resumen.
  const [bulk, setBulk] = useState<{ done: number; total: number } | null>(null);
  const inRetries = key === "reintentos_aliclik" && !stuck;
  const readyToApprove = inRetries
    ? inQueue.filter((row) => caseById.get(row.orderId)?.retryChain?.ready)
    : [];
  // Elegir cuáles aprobar (owner, 06-11-2026): con alguno marcado, el botón
  // aprueba esos; sin marcar, todos los listos, como antes. En las demás listas
  // la casilla elige qué se programa en lote (owner, 15-11-2026).
  const targets = retryApprovalTargets(readyToApprove, picked);
  const toggle = (orderId: string) => setPicked((current) => {
    const next = new Set(current);
    if (next.has(orderId)) next.delete(orderId); else next.add(orderId);
    return next;
  });
  const toggleAll = (orderIds: string[], on: boolean) => setPicked((current) => {
    const next = new Set(current);
    for (const id of orderIds) { if (on) next.add(id); else next.delete(id); }
    return next;
  });
  const selection: LimaRowSelection | undefined = inRetries ? {
    selectable: (row) => Boolean(caseById.get(row.orderId)?.retryChain?.ready),
    selected: picked,
    onToggle: toggle,
    onToggleAll: toggleAll,
    purpose: "aprobar",
  } : retriesOnly ? undefined : {
    selectable: (row) => pathOf(row).kind !== null,
    selected: picked,
    onToggle: toggle,
    onToggleAll: toggleAll,
    purpose: "mover",
  };
  async function approveAll() {
    const rows = targets.rows;
    if (!rows.length || bulk) return;
    if (!window.confirm(`Se crearán ${rows.length} ${rows.length === 1 ? "guía" : "guías"} de Aliclik${targets.picked ? " (las elegidas)" : ""}. ¿Seguir?`)) return;
    const failed: Array<{ orderName: string; error: string }> = [];
    let created = 0;
    setBulk({ done: 0, total: rows.length });
    for (const [i, row] of rows.entries()) {
      try {
        const result = await approveAliclikRetry(row.orderId);
        if (result.error) failed.push({ orderName: row.orderName, error: result.error });
        else created += 1;
      } catch {
        failed.push({ orderName: row.orderName, error: "No se pudo crear (error de conexión)." });
      }
      setBulk({ done: i + 1, total: rows.length });
    }
    setBulk(null);
    setPicked(new Set());
    setFeedback({
      kind: failed.length ? "error" : "notice",
      text: `Guías creadas: ${created} de ${rows.length}.`,
      lines: groupApprovalFailures(failed),
      googleOff: failed.some((f) => f.error === retryApproveNoLocation("apagado")),
    });
    refresh();
  }

  // «Programar» en lote (owner, 15-11-2026; antes «Mover»): los elegidos que se pueden agendar, uno
  // por uno por la acción de cada uno; lo que no se movió, una línea por motivo.
  const movable = inRetries ? [] : inQueue.filter((row) => picked.has(row.orderId) && pathOf(row).kind !== null);
  const movableAgreements = movable.filter((row) => pathOf(row).kind === "acuerdo").length;
  // Los que no tienen acuerdo salen con el courier del lote (owner, 16-11-2026): un no
  // entregado sin acuerdo lo necesita; un envío puede quedar sin elegir, como antes.
  const movableNew = movable.filter((row) => pathOf(row).kind === "acuerdo_nuevo").length;
  const movableEnvio = movable.filter((row) => pathOf(row).kind === "envio").length;
  const courierRows = movable.filter((row) => pathOf(row).kind !== "acuerdo");
  const courierFlags = courierRows.map((row) => gfApi.has(row.storeId));
  const moveCourierChoices = batchCourierChoices(courierFlags);
  const [moveCourier, setMoveCourier] = useState<DispatchCourier | null>(null);
  const moveRejects = batchCourierRejects(moveCourier, courierFlags);
  const needsMoveCourier = movableNew > 0 && !moveCourier;
  // «Programar» lo que no tiene día y «Reprogramar» lo que ya lo tiene (owner, 16-11-2026).
  const movableDated = movable.filter((row) => Boolean(classes.get(row.orderId)?.agendaDay)).length;
  const moveMaxDays = movable.some((row) => pathOf(row).kind === "envio") ? DISPATCH_DATE_MAX_DAYS : RESCHEDULE_MAX_DAYS;
  const [moveDay, setMoveDay] = useState("");
  const [moveChannel, setMoveChannel] = useState<AgendarChannel>("llamada");
  const [moving, setMoving] = useState<{ done: number; total: number } | null>(null);
  async function moveAll() {
    const rows = movable;
    if (!rows.length || !moveDay || needsMoveCourier || moving) return;
    const label = programDayLabel(moveDay);
    const withCourier = moveCourier && courierRows.length ? ` con ${DISPATCH_COURIER_LABEL[moveCourier]}` : "";
    if (!window.confirm(`${programarBatchLabel(movableDated, rows.length - movableDated, moveDay)}${withCourier}: ${rows.length} ${rows.length === 1 ? "pedido" : "pedidos"}. ¿Seguir?`)) return;
    const failed: Array<{ orderName: string; error: string }> = [];
    const mesa: Array<{ orderId: string; orderName: string }> = [];
    let done = 0;
    setMoving({ done: 0, total: rows.length });
    for (const [i, row] of rows.entries()) {
      const path = pathOf(row);
      try {
        const result = await agendarReproLima({
          orderId: row.orderId,
          day: moveDay,
          channel: path.kind === "acuerdo" ? moveChannel : null,
          courier: path.kind === "acuerdo" ? null : moveCourier,
          operationId: newAgendarOperationId(),
        }).catch((e: unknown): AgendarResult => ({ error: e instanceof Error ? e.message : String(e) }));
        const outcome = agendarOutcome(row.orderName, result, row.orderId);
        if (outcome.feedback.mesa) mesa.push(outcome.feedback.mesa);
        if (outcome.saved && !result.error) done += 1;
        else failed.push({ orderName: row.orderName, error: result.error ?? outcome.feedback.text });
      } catch {
        failed.push({ orderName: row.orderName, error: "No se pudo programar (error de conexión)." });
      }
      setMoving({ done: i + 1, total: rows.length });
    }
    setMoving(null);
    setPicked(new Set());
    setFeedback({ kind: failed.length ? "error" : "notice", text: `Programados para el ${label}${withCourier}: ${done} de ${rows.length}.`, lines: groupApprovalFailures(failed), ...(mesa.length ? { mesa } : {}) });
    refresh();
  }

  // «Kapta propone, el equipo confirma» (owner, 15-11-2026): en «Sacar a reparto»
  // y, desde el 16-11-2026, en «No entregados» («Sin día y no entregados»), un
  // toque elige los que se pueden programar y deja el próximo día de reparto
  // puesto en el lote. Nada se mueve hasta confirmar.
  const suggestedDay = limaSuggestedDay(today);
  const proposals = stuck || retriesOnly ? []
    : key === "por_sacar" || key === "nunca_salieron" || key === "mas_de_30" || key === "salieron_sin_dia"
      ? inQueue.filter((row) => classes.get(row.orderId)?.agenda === "sin_fecha" && pathOf(row).kind !== null)
      : key === "no_entregados" || key === "por_acordar"
        ? inQueue.filter((row) => {
          const cls = classes.get(row.orderId);
          return cls?.step === "no_entregados" && limaStepPart(cls) === "por_acordar" && pathOf(row).kind === "acuerdo_nuevo";
        })
        : [];
  function pickProposals() {
    setPicked(new Set(proposals.map((row) => row.orderId)));
    setMoveDay(suggestedDay);
  }

  const card = stuck ? null : boardCard(key, today);
  const stepCard = key !== "todos" ? boardCard(key, today) : null;
  const listTitle = stuck
    ? stuck !== "todos" ? `Trabados · ${limaStuckRule(stuck).label}` : stepCard ? `Trabados · ${stepCard.label}` : "Trabados"
    : card?.label ?? "Todos los pendientes";
  const listHelp = stuck
    ? stuck === "todos" ? "Lo del equipo que se quedó quieto más de lo que debería, lo que más lleva primero." : `${limaStuckRule(stuck).hint} Siguiente paso: ${limaStuckRule(stuck).action}`
    : card?.hint ?? "Primero lo que pide al equipo; después lo programado por día y lo que lleva el courier.";
  const emptyText = query.trim()
    ? `Ningún pedido coincide con «${query.trim()}».`
    : stuck ? "No hay pedidos trabados por este motivo con estos filtros."
      : key === "todos" ? "No hay pedidos con estos filtros. Activa otros macroestados o quita la búsqueda." : card?.empty ?? "No hay pedidos con estos filtros.";
  const filtered = Boolean(stuck) || key !== "todos";
  const listStep = activeStep(key);

  return (
    <div className="space-y-7">
      <header className="space-y-3">
        <div className="min-w-0">
          <h1 className="text-[28px] font-bold leading-9 tracking-[-0.01em] text-ink-900">Repro Lima</h1>
          <p className="mt-1 text-sm text-ink-500">
            {retriesOnly
              ? "Los no entregados de Lima que vuelven a salir por Aliclik, sin llamar. Abre el pedido y crea la guía con el transporte indicado."
              : "El panel del equipo de Lima. Trabaja el flujo de izquierda a derecha; «Programar» pone el día y «Atender» abre la llamada."}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {/* El total, arriba y a la vista (owner, 15-11-2026: «el total desapareció»). Es también «Todos». */}
          {!retriesOnly && (
            <button
              type="button"
              onClick={() => chooseKey("todos")}
              aria-pressed={key === "todos" && !stuck}
              title="Todos los pendientes de entrega de Lima, con los filtros de abajo."
              className={cn(
                "inline-flex h-8 items-center gap-1.5 rounded-full bg-white px-3 text-[13px] font-medium shadow-control transition-shadow pointer-coarse:h-11",
                key === "todos" && !stuck ? "text-brand-700 ring-2 ring-inset ring-brand-600" : "text-ink-700 ring-1 ring-inset ring-line-strong hover:ring-ink-300",
              )}
            >
              <span className={cn("font-semibold tabular-nums", key === "todos" && !stuck ? "text-brand-700" : "text-ink-900")}>{pendingStore.length.toLocaleString("es-PE")}</span>
              pedidos de Lima por entregar
            </button>
          )}
          <Badge tone={cutoff.passed ? "warn" : "info"} wrap>{cutoff.text}</Badge>
          <span className="text-[13px] text-ink-500" aria-live="polite">{refreshing ? "Actualizando…" : null}</span>
        </div>
      </header>

      {retriesOnly ? (
        <div role="group" aria-label="Filtros de atención" className="grid grid-cols-2 gap-2 sm:grid-cols-4 [&>button>span:first-child]:whitespace-normal [&>button>span:last-child]:mt-auto">
          <StatusCard label={LIMA_SUB_FILTERS.reintentos_aliclik.label} value={counts.sub.reintentos_aliclik} hint={LIMA_SUB_FILTERS.reintentos_aliclik.hint} active onClick={() => {}} />
        </div>
      ) : (
        <ReproLimaBlocks
          counts={counts}
          today={today}
          active={key}
          onPick={chooseKey}
          guideAlert={hoySinGuiaAlert(now)}
          stuck={{ byStep: stuckByStep, active: Boolean(stuck), onPick: chooseStepStuck }}
          callsDue={callsDue}
        />
      )}

      {moved && (
        <Banner tone="info" role="status" title={`«${limaStuckRule(moved.reason).label}» se ve en ${LIMA_STUCK_HOME_LABEL[moved.home]}`}>
          <p>
            Con GF Courier por API, las cajas y los motorizados de Grupo GF ya no se manejan desde Repro Lima.{" "}
            <a href="/dashboard/courier" className="font-medium underline underline-offset-2">Abrir Despacho del día</a>
          </p>
        </Banner>
      )}

      {feedback && (
        // Con el aviso flotante, ese es el que se anuncia: la página no lo repite al lector.
        <Banner tone={feedback.kind === "error" ? "crit" : "ok"} role={feedback.toasted ? undefined : feedback.kind === "error" ? "alert" : "status"}>
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 space-y-1">
              <p>{feedback.text}</p>
              {feedback.extra && <p>{feedback.extra}</p>}
              {feedback.lines?.map((line) => <p key={line}>{line}</p>)}
              {feedback.mesa?.length ? (
                <div className="flex flex-wrap gap-2 pt-1">
                  {feedback.mesa.map((m) => (
                    <OpsButton key={m.orderId} size="sm" className="pointer-coarse:h-11" onClick={() => openDrawer(m.orderId, "operar")}>
                      {feedback.mesa!.length === 1 ? "Abrir la Mesa de ruta del pedido" : `Mesa de ruta de ${m.orderName}`}
                    </OpsButton>
                  ))}
                </div>
              ) : null}
              {feedback.googleOff && (
                <p><a href="/dashboard/automatizaciones#retry-ubicacion" className="font-medium underline underline-offset-2">Ir a «Ubicación por dirección» en Automatizaciones</a> para medir Lima y encenderla.</p>
              )}
            </div>
            <button type="button" onClick={() => setFeedback(null)} aria-label="Cerrar el aviso" className="grid size-8 shrink-0 place-items-center rounded-md text-ink-500 hover:bg-white/60 hover:text-ink-900">
              <IconX className="size-4" />
            </button>
          </div>
        </Banner>
      )}

      <section aria-label={filtered ? listTitle : "Todos los pendientes de Lima"} className="rounded-lg bg-white shadow-control ring-1 ring-line-strong/70">
        {!retriesOnly && (
          // La cabecera toma el matiz del paso elegido (owner, 16-11-2026: contraste entre secciones): se ve de dónde viene la lista.
          <div className={cn("flex flex-wrap items-start justify-between gap-x-3 gap-y-1 rounded-t-lg border-b border-line px-4 py-3.5", listStep ? STEP_TONE[listStep].band : "bg-wash/70")}>
            <div className="min-w-0">
              <h2 className="flex items-center gap-2 text-base font-semibold tracking-[-0.01em] text-ink-900">
                {listStep && <span aria-hidden className={cn("size-2.5 shrink-0 rounded-full", STEP_TONE[listStep].dot)} />}
                {listTitle}
              </h2>
              <p className="mt-0.5 max-w-[80ch] text-[13px] leading-5 text-ink-500">{listHelp}</p>
            </div>
            {filtered && <OpsButton variant="ghost" size="sm" onClick={() => chooseKey("todos")} className="pointer-coarse:h-11">Ver todos</OpsButton>}
          </div>
        )}
        {proposals.length > 0 && (
          <div role="note" className="mx-4 mt-3 flex flex-col gap-2 rounded-md bg-brand-50 px-3 py-2.5 ring-1 ring-inset ring-brand-100 sm:flex-row sm:items-center sm:gap-3">
            <p className="min-w-0 text-[13px] leading-5 text-ink-700 sm:flex-1">
              Kapta sugiere el <b className="font-semibold text-ink-900">{programDayLabel(suggestedDay)}</b>, el próximo día de reparto, para{" "}
              <b className="font-semibold tabular-nums text-ink-900">{proposals.length.toLocaleString("es-PE")}</b> {proposalsNoun(proposals.length, key === "no_entregados" || key === "por_acordar")}. Revisa la lista, quita los que no y confirma abajo.
            </p>
            <OpsButton size="sm" variant="primary" disabled={Boolean(moving)} onClick={pickProposals} className="w-full shrink-0 sm:w-auto pointer-coarse:h-11">
              Elegirlos para el {programDayLabel(suggestedDay)}
            </OpsButton>
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2 px-4 pb-4 pt-3">
          <label className="relative w-full sm:w-72">
            <span className="sr-only">Buscar pedido, cliente o teléfono</span>
            <IconSearch className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-ink-500" />
            <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Pedido, cliente o teléfono" className={cn(FIELD, "h-8 pl-8 pointer-coarse:h-11")} />
          </label>
          {data.stores.length > 1 && <FilterPill ref={storePill} label="Tienda" value={storeName} expanded={storeSheet} onClick={() => setStoreSheet((v) => !v)} onClear={() => setStore("")} />}
          {/* Macroestado y subetapa del Master: un filtro más de la lista, no una fila de la página (15-11-2026). */}
          <FilterPill
            ref={stagePill}
            label="Etapa"
            value={hidden.size ? `${hidden.size} ${hidden.size === 1 ? "oculta" : "ocultas"}` : null}
            expanded={stageSheet}
            onClick={() => setStageSheet((v) => !v)}
            onClear={() => changeHidden(new Set())}
          />
          <DateRangePill label="Creación" from={rowFilters.createdFrom} to={rowFilters.createdTo} presets={createdPresets(today)} onChange={(createdFrom, createdTo) => patchRowFilters({ createdFrom, createdTo })} />
          <FacetPill label="Canal" allLabel="Todos los canales" options={filterOptions.channels} selected={rowFilters.channels as Set<string>} onChange={(channels) => patchRowFilters({ channels })} />
          <FacetPill label="Distrito" allLabel="Todos los distritos" options={filterOptions.districts} selected={rowFilters.districts as Set<string>} onChange={(districts) => patchRowFilters({ districts })} />
          <FacetPill label="Courier" allLabel="Todos los couriers" options={filterOptions.couriers} selected={rowFilters.couriers as Set<string>} onChange={(couriers) => patchRowFilters({ couriers })} />
          <FacetPill label="Nuevo" allLabel="Todos" options={filterOptions.novelty} selected={rowFilters.novelty as Set<string>} onChange={(novelty) => patchRowFilters({ novelty })} />
          {activeRowFilters > 0 && (
            <OpsButton variant="ghost" size="sm" onClick={() => patchRowFilters(emptyRowFilters())} className="pointer-coarse:h-11">Quitar filtros</OpsButton>
          )}
          {inRetries && (
            <>
              <OpsButton size="sm" variant="primary" disabled={!targets.rows.length || Boolean(bulk)} onClick={() => void approveAll()} className="pointer-coarse:h-11">
                {bulk
                  ? `Creando ${bulk.done} de ${bulk.total}…`
                  : targets.picked ? `Aprobar elegidos (${targets.rows.length})` : `Aprobar todos los listos (${readyToApprove.length})`}
              </OpsButton>
              {targets.picked && !bulk && (
                <OpsButton size="sm" variant="ghost" onClick={() => setPicked(new Set())} className="pointer-coarse:h-11">Quitar elección</OpsButton>
              )}
              {!targets.picked && readyToApprove.length > 0 && !bulk && (
                <span className="text-[13px] text-ink-500">Marca las casillas para aprobar solo algunos.</span>
              )}
            </>
          )}
          <p className="w-full text-[13px] tabular-nums text-ink-500 lg:ml-auto lg:w-auto" aria-live="polite">
            <b className="font-semibold text-ink-900">{inQueue.length.toLocaleString("es-PE")}</b> de {pendingStore.length.toLocaleString("es-PE")} pendientes de entrega
          </p>
        </div>
        {stageSheet && (
          <Sheet look="ops" title="Etapa del Master" onClose={() => setStageSheet(false)} anchored anchorRef={stagePill}>
            <div className="max-h-[60vh] max-w-xl space-y-2 overflow-auto">
              <p className="text-[13px] text-ink-500">Muestra u oculta macroestados y subetapas. Las cifras de arriba cuentan solo lo que se muestra.</p>
              <LimaPendingFilters rows={narrowed} hidden={hidden} onToggle={(keys) => changeHidden(togglePendingKeys(hidden, keys))} onReset={() => changeHidden(new Set())} />
            </div>
          </Sheet>
        )}
        {storeSheet && (
          <Sheet look="ops" title="Tienda" onClose={() => setStoreSheet(false)} anchored anchorRef={storePill}>
            <div role="group" className="-mx-1 grid max-h-72 gap-0.5 overflow-auto">
              {[{ id: "", name: "Todas las tiendas" }, ...data.stores].map((s) => (
                <button key={s.id || "todas"} type="button" aria-pressed={s.id === store} onClick={() => { setStore(s.id); setStoreSheet(false); }} className={cn("flex h-9 items-center justify-between gap-2 rounded-md px-2 text-left text-sm hover:bg-wash pointer-coarse:h-11", s.id === store ? "font-semibold text-ink-900" : "text-ink-700")}>
                  <span className="truncate">{s.name}</span>
                  {s.id === store && <IconCheck className="size-4 shrink-0 text-brand-600" />}
                </button>
              ))}
            </div>
          </Sheet>
        )}
        <LimaPendingList
          key={`${key}:${stuck ?? ""}:${store}:${query}:${hiddenParam}:${rowFiltersKey}`}
          rows={inQueue}
          reproRows={data.rows}
          today={today}
          now={now}
          classes={classes}
          stuck={stuckByOrder}
          renderActions={rowActions}
          emptyText={emptyText}
          selection={selection}
        />
      </section>

      {movable.length > 0 && (
        <div role="region" aria-label="Programar otro día" className="sticky bottom-4 z-30 mx-auto flex w-full max-w-5xl flex-col gap-3 rounded-lg bg-white p-3 shadow-pop ring-1 ring-line sm:w-fit sm:px-4">
          <div className="flex flex-wrap items-center gap-2">
            <span className="mr-1 text-sm font-semibold text-ink-900">
              <span className="tabular-nums">{movable.length.toLocaleString("es-PE")}</span> {movable.length === 1 ? "pedido elegido" : "pedidos elegidos"}
            </span>
            <OpsButton variant="primary" size="sm" disabled={!moveDay || needsMoveCourier || Boolean(moving)} onClick={() => void moveAll()} className="pointer-coarse:h-11">
              {moving ? `Guardando ${moving.done} de ${moving.total}…` : moveDay && needsMoveCourier ? "Elige el courier" : programarBatchLabel(movableDated, movable.length - movableDated, moveDay || null)}
            </OpsButton>
            <OpsButton variant="ghost" size="sm" disabled={Boolean(moving)} onClick={() => setPicked(new Set())} className="pointer-coarse:h-11">Limpiar</OpsButton>
          </div>
          <div className="border-t border-line pt-3">
            <DayPicker today={today} maxDay={agendarMaxDay(today, moveMaxDays)} value={moveDay} onChange={setMoveDay} label="Para el día" />
          </div>
          {courierRows.length > 0 && (
            <div className="space-y-1">
              <CourierPicker value={moveCourier} onChange={setMoveCourier} choices={moveCourierChoices} optional={movableNew === 0} autoActive={courierRows.every((row) => courierAuto.has(row.storeId))} />
              {movableNew > 0 && movableEnvio > 0 && (
                <p className="text-xs text-ink-500">{`${movableNew === 1 ? "Uno es un no entregado" : `${movableNew} son no entregados`}: queda${movableNew === 1 ? "" : "n"} acordado${movableNew === 1 ? "" : "s"} sin llamada. Los demás van por «Programar envío».`}</p>
              )}
              {movableNew > 0 && movableEnvio === 0 && (
                <p className="text-xs text-ink-500">{movableNew === 1 ? "Es un no entregado: queda acordado sin llamada." : "Son no entregados: quedan acordados sin llamada."}</p>
              )}
              {moveRejects > 0 && moveCourier && (
                <p className="text-xs text-warn-fg">{`${moveRejects === 1 ? "Uno no puede" : `${moveRejects} no pueden`} salir con ${DISPATCH_COURIER_LABEL[moveCourier]} por su tienda: ${moveCourier === "gf_courier" ? "no tiene GF Courier por API" : "despacha por GF Courier"}. Se avisa al terminar.`}</p>
              )}
            </div>
          )}
          {movableAgreements > 0 && (
            <div className="space-y-1">
              <ChannelPicker value={moveChannel} onChange={setMoveChannel} />
              <p className="text-xs text-ink-500">{`${movableAgreements === 1 ? "Uno tiene" : `${movableAgreements} tienen`} un acuerdo con la clienta: se reprograma con el mismo courier.`}</p>
            </div>
          )}
        </div>
      )}

      <OpsToast toast={toast} onClose={() => setToast(null)} />
    </div>
  );
}
