"use client";

// Repro Lima (MOM §9.5): el panel de gestión del equipo de Lima (owner,
// 15-11-2026). Tres bloques —«Por gestionar hoy», «Agenda» y «En manos del
// courier»— sobre UNA lista: cada tarjeta filtra esa lista (`atencion` en la
// URL; los valores de la pantalla anterior abren lo más cercano) y los
// trabados del equipo (§9.6) son chips de su bloque (`trabado`). Las acciones
// conservan los permisos y guardas del pedido y de cada caso.
//
// «Agendar» pone el día sin abrir la ficha y «Mover a…» lo pone a varios, por
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
import { Badge, Banner, FIELD, FilterPill, OpsButton, StatusCard, ChoiceChip } from "@/components/ops-ui";
import { Sheet } from "@/components/filter-sheet";
import { DateRangePill, FacetPill } from "@/components/facet-pill";
import { IconCheck, IconSearch, IconX } from "@/components/icons";
import { useOpenOrderDrawer } from "@/components/order-link";
import type { ReproLimaData } from "@/lib/repro-lima-access";
import { cutoffNotice } from "@/lib/repro-lima";
import { limaClock } from "@/lib/grupo-gf-courier";
import { programDayLabel } from "@/lib/dispatch-day";
import { LimaPendingFilters, LimaPendingList, type LimaRowSelection } from "@/components/repro-lima-pending";
import { ReproLimaBlocks, type LimaStuckChip } from "@/components/repro-lima-blocks";
import { AgendarButton, ChannelPicker, DayPicker, agendarOutcome, newAgendarOperationId, type AgendarChannel } from "@/components/repro-lima-agendar";
import { clearReproLimaQueue, setReproLimaQueue, type ReproLimaQueue } from "@/lib/repro-lima-queue";
import { LIMA_STUCK_HOME_LABEL, limaStuckItems, limaStuckRule, stuckFilter, stuckMovedTo, stuckReasonsOf, type LimaStuckHome, type LimaStuckReason } from "@/lib/lima-stuck";
import { approveAliclikRetry } from "@/app/dashboard/pedidos/repro-lima/retry-actions";
import { agendarReproLima, type AgendarResult } from "@/app/dashboard/pedidos/repro-lima/agenda-actions";
import { retryApproveNoLocation } from "@/lib/lima-retry-auto";
import {
  LIMA_SUB_FILTERS,
  agendaWindow,
  agendarMaxDay,
  agendarPath,
  boardCard,
  boardFilter,
  classifyLimaRows,
  limaBoardCounts,
  limaBoardRows,
  type LimaBoardKey,
} from "@/lib/repro-lima-blocks";
import { DISPATCH_DATE_MAX_DAYS } from "@/lib/dispatch-date";
import { RESCHEDULE_MAX_DAYS } from "@/lib/gf-dispatch-program";
import { createdPresets, emptyRowFilters, groupApprovalFailures, pendingKey, pendingMatches, readRowFilters, retryApprovalTargets, rowFilterOptions, rowFiltersParam, rowFiltersActive, rowFiltersMatch, togglePendingKeys, writeRowFilters, type LimaPendingOrder, type LimaRowFilters } from "@/lib/repro-lima-pending";

const FOCUS_REFRESH_MS = 20_000;
/** Los trabados que se ven en Repro Lima; los de Grupo GF, en Despacho del día. */
const TEAM_HOMES: readonly LimaStuckHome[] = ["gestion", "courier"];
const GESTION_STUCK = stuckReasonsOf("gestion");
const COURIER_STUCK = stuckReasonsOf("courier");

type Feedback = {
  kind: "notice" | "error";
  text: string;
  extra?: string | null;
  /** Una línea por motivo (`groupApprovalFailures`). */
  lines?: string[];
  /** Algún pedido no tuvo Google porque está apagado o Lima no está medida. */
  googleOff?: boolean;
};

export function ReproLimaBoard({ data, pending, retriesOnly = false, canScheduleDispatch = false }: {
  data: ReproLimaData;
  pending: LimaPendingOrder[];
  /** Despacho sin `repro_lima.manage` (03-11-2026): solo «Reintentos Aliclik», sin Atender ni Agendar. */
  retriesOnly?: boolean;
  /** «Programar envío» (§6.2) pide `master.edit`: sin él, «Agendar» solo cambia acuerdos. */
  canScheduleDispatch?: boolean;
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
  const openDrawer = useOpenOrderDrawer();
  const [feedback, setFeedback] = useState<Feedback | null>(null);
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
    return { channels: without("channels"), districts: without("districts"), couriers: without("couriers") };
  }, [pendingStore, rowFilters, activeRowFilters]);
  const scoped = useMemo(() => narrowed.filter((row) => !hidden.has(pendingKey(row)) && pendingMatches(row, query)), [narrowed, hidden, query]);
  // Los tres bloques: una clasificación por pedido, para las cifras y la lista.
  const agendaDays = useMemo(() => agendaWindow(today), [today]);
  const classes = useMemo(() => classifyLimaRows(scoped, data.rows, today, agendaDays), [scoped, data.rows, today, agendaDays]);
  const counts = useMemo(() => limaBoardCounts(scoped, classes), [scoped, classes]);
  const caseById = useMemo(() => new Map(data.rows.map((row) => [row.orderId, row])), [data.rows]);
  // `loadReproLima` ya ordena los casos (`sortRepro`): No entregados y Llamar después siguen ese orden.
  const caseOrder = useMemo(() => new Map(data.rows.map((row, i) => [row.orderId, i])), [data.rows]);
  const stuckItems = useMemo(
    () => retriesOnly ? [] : limaStuckItems(scoped, today).filter((item) => TEAM_HOMES.includes(limaStuckRule(item.reason).home)),
    [scoped, today, retriesOnly],
  );
  const stuckByOrder = useMemo(() => new Map(stuckItems.map((item) => [item.orderId, item])), [stuckItems]);
  const stuckChips = useMemo(() => {
    const count = new Map<LimaStuckReason, number>();
    for (const item of stuckItems) count.set(item.reason, (count.get(item.reason) ?? 0) + 1);
    const chips = (reasons: readonly LimaStuckReason[]): LimaStuckChip[] => reasons.map((reason) => ({ reason, count: count.get(reason) ?? 0 }));
    return { gestion: chips(GESTION_STUCK), courier: chips(COURIER_STUCK) };
  }, [stuckItems]);
  const inQueue = useMemo(() => {
    if (stuck) {
      // Los trabados, en su orden: por motivo y lo que más lleva primero.
      const byId = new Map(scoped.map((row) => [row.orderId, row]));
      return stuckItems.filter((item) => stuck === "todos" || item.reason === stuck)
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

  function chooseStuck(next: LimaStuckReason | "todos" | null) {
    setPicked(new Set());
    const params = new URLSearchParams(searchParams.toString());
    params.delete("atencion");
    if (next && next !== stuck) params.set("trabado", next);
    else params.delete("trabado");
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
    return (
      <>
        {path.kind && <AgendarButton row={row} path={path} today={today} size={size} onDone={(f) => { setFeedback(f); refresh(); }} />}
        <OpsButton size={size} className="pointer-coarse:h-11" onClick={() => openDrawer(row.orderId, "reprolima")}>Atender</OpsButton>
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
  // la casilla elige qué «Mover a…» otro día (owner, 15-11-2026).
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

  // «Mover a…» (owner, 15-11-2026): los elegidos que se pueden agendar, uno
  // por uno por la acción de cada uno; lo que no se movió, una línea por motivo.
  const movable = inRetries ? [] : inQueue.filter((row) => picked.has(row.orderId) && pathOf(row).kind !== null);
  const movableAgreements = movable.filter((row) => pathOf(row).kind === "acuerdo").length;
  const moveMaxDays = movable.some((row) => pathOf(row).kind === "envio") ? DISPATCH_DATE_MAX_DAYS : RESCHEDULE_MAX_DAYS;
  const [moveDay, setMoveDay] = useState("");
  const [moveChannel, setMoveChannel] = useState<AgendarChannel>("llamada");
  const [moving, setMoving] = useState<{ done: number; total: number } | null>(null);
  async function moveAll() {
    const rows = movable;
    if (!rows.length || !moveDay || moving) return;
    const label = programDayLabel(moveDay);
    if (!window.confirm(`Se moverán ${rows.length} ${rows.length === 1 ? "pedido" : "pedidos"} al ${label}. ¿Seguir?`)) return;
    const failed: Array<{ orderName: string; error: string }> = [];
    let done = 0;
    setMoving({ done: 0, total: rows.length });
    for (const [i, row] of rows.entries()) {
      const path = pathOf(row);
      try {
        const result = await agendarReproLima({
          orderId: row.orderId,
          day: moveDay,
          channel: path.kind === "acuerdo" ? moveChannel : null,
          operationId: newAgendarOperationId(),
        }).catch((e: unknown): AgendarResult => ({ error: e instanceof Error ? e.message : String(e) }));
        const outcome = agendarOutcome(row.orderName, result);
        if (outcome.saved && !result.error) done += 1;
        else failed.push({ orderName: row.orderName, error: result.error ?? outcome.feedback.text });
      } catch {
        failed.push({ orderName: row.orderName, error: "No se pudo agendar (error de conexión)." });
      }
      setMoving({ done: i + 1, total: rows.length });
    }
    setMoving(null);
    setPicked(new Set());
    setFeedback({ kind: failed.length ? "error" : "notice", text: `Movidos al ${label}: ${done} de ${rows.length}.`, lines: groupApprovalFailures(failed) });
    refresh();
  }

  const card = stuck ? null : boardCard(key, today);
  const listTitle = stuck
    ? stuck === "todos" ? "Trabados" : `Trabados · ${limaStuckRule(stuck).label}`
    : card?.label ?? "Todos los pendientes";
  const listHelp = stuck
    ? stuck === "todos" ? "Lo del equipo que se quedó quieto más de lo que debería, lo que más lleva primero." : `${limaStuckRule(stuck).hint} Siguiente paso: ${limaStuckRule(stuck).action}`
    : card?.hint ?? "Primero lo que pide al equipo; después la Agenda por día y lo que lleva el courier.";
  const emptyText = query.trim()
    ? `Ningún pedido coincide con «${query.trim()}».`
    : stuck ? "No hay pedidos trabados por este motivo con estos filtros."
      : key === "todos" ? "No hay pedidos con estos filtros. Activa otros macroestados o quita la búsqueda." : card?.empty ?? "No hay pedidos con estos filtros.";
  const filtered = Boolean(stuck) || key !== "todos";

  return (
    <div className="space-y-4">
      <header className="space-y-3">
        <div className="min-w-0">
          <h1 className="text-[28px] font-bold leading-9 tracking-[-0.01em] text-ink-900">Repro Lima</h1>
          <p className="mt-1 text-sm text-ink-500">
            {retriesOnly
              ? "Los no entregados de Lima que vuelven a salir por Aliclik, sin llamar. Abre el pedido y crea la guía con el transporte indicado."
              : "El panel del equipo de Lima: lo que toca hoy, la agenda de salidas y lo que lleva el courier. «Agendar» pone el día; «Atender» abre la llamada y la gestión."}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
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
          active={stuck ? "todos" : key}
          onPick={chooseKey}
          stuck={stuckChips}
          activeStuck={stuck}
          onStuck={chooseStuck}
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

      <LimaPendingFilters rows={narrowed} hidden={hidden} onToggle={(keys) => changeHidden(togglePendingKeys(hidden, keys))} onReset={() => changeHidden(new Set())} />

      {feedback && (
        <Banner tone={feedback.kind === "error" ? "crit" : "ok"} role={feedback.kind === "error" ? "alert" : "status"}>
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 space-y-1">
              <p>{feedback.text}</p>
              {feedback.extra && <p>{feedback.extra}</p>}
              {feedback.lines?.map((line) => <p key={line}>{line}</p>)}
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

      <section aria-label={filtered ? listTitle : "Todos los pendientes de Lima"} className="rounded-lg bg-white shadow-control ring-1 ring-line">
        {!retriesOnly && (
          <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1 px-4 pt-3">
            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-ink-900">{listTitle}</h2>
              <p className="max-w-[80ch] text-[13px] text-ink-500">{listHelp}</p>
            </div>
            {filtered && <OpsButton variant="ghost" size="sm" onClick={() => chooseKey("todos")} className="pointer-coarse:h-11">Ver todos</OpsButton>}
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2 px-4 py-3">
          <label className="relative w-full sm:w-72">
            <span className="sr-only">Buscar pedido, cliente o teléfono</span>
            <IconSearch className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-ink-500" />
            <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Pedido, cliente o teléfono" className={cn(FIELD, "h-8 pl-8 pointer-coarse:h-11")} />
          </label>
          {data.stores.length > 1 && <FilterPill ref={storePill} label="Tienda" value={storeName} expanded={storeSheet} onClick={() => setStoreSheet((v) => !v)} onClear={() => setStore("")} />}
          <DateRangePill label="Creación" from={rowFilters.createdFrom} to={rowFilters.createdTo} presets={createdPresets(today)} onChange={(createdFrom, createdTo) => patchRowFilters({ createdFrom, createdTo })} />
          <FacetPill label="Canal" allLabel="Todos los canales" options={filterOptions.channels} selected={rowFilters.channels as Set<string>} onChange={(channels) => patchRowFilters({ channels })} />
          <FacetPill label="Distrito" allLabel="Todos los distritos" options={filterOptions.districts} selected={rowFilters.districts as Set<string>} onChange={(districts) => patchRowFilters({ districts })} />
          <FacetPill label="Courier" allLabel="Todos los couriers" options={filterOptions.couriers} selected={rowFilters.couriers as Set<string>} onChange={(couriers) => patchRowFilters({ couriers })} />
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
          {!retriesOnly && !inRetries && !picked.size && (
            <ChoiceChip label="Solo trabados" count={stuckItems.length} active={stuck === "todos"} title="Los trabados del equipo (§9.6), lo que más lleva primero." onClick={() => chooseStuck(stuck === "todos" ? null : "todos")} />
          )}
          <p className="w-full text-[13px] tabular-nums text-ink-500 lg:ml-auto lg:w-auto" aria-live="polite">
            <b className="font-semibold text-ink-900">{inQueue.length.toLocaleString("es-PE")}</b> de {pendingStore.length.toLocaleString("es-PE")} pendientes de entrega
          </p>
        </div>
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
        <div role="region" aria-label="Mover a otro día" className="sticky bottom-4 z-30 mx-auto flex w-full max-w-5xl flex-col gap-3 rounded-lg bg-white p-3 shadow-pop ring-1 ring-line sm:w-fit sm:px-4">
          <div className="flex flex-wrap items-center gap-2">
            <span className="mr-1 text-sm font-semibold text-ink-900">
              <span className="tabular-nums">{movable.length.toLocaleString("es-PE")}</span> {movable.length === 1 ? "pedido elegido" : "pedidos elegidos"}
            </span>
            <OpsButton variant="primary" size="sm" disabled={!moveDay || Boolean(moving)} onClick={() => void moveAll()} className="pointer-coarse:h-11">
              {moving ? `Moviendo ${moving.done} de ${moving.total}…` : moveDay ? `Mover al ${programDayLabel(moveDay)}` : "Mover a…"}
            </OpsButton>
            <OpsButton variant="ghost" size="sm" disabled={Boolean(moving)} onClick={() => setPicked(new Set())} className="pointer-coarse:h-11">Limpiar</OpsButton>
          </div>
          <div className="border-t border-line pt-3">
            <DayPicker today={today} maxDay={agendarMaxDay(today, moveMaxDays)} value={moveDay} onChange={setMoveDay} label="Mover a" />
          </div>
          {movableAgreements > 0 && (
            <div className="space-y-1">
              <ChannelPicker value={moveChannel} onChange={setMoveChannel} />
              <p className="text-xs text-ink-500">{`${movableAgreements === 1 ? "Uno tiene" : `${movableAgreements} tienen`} un acuerdo con la clienta: se cambia su día con el mismo courier. Los demás van por «Programar envío».`}</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
