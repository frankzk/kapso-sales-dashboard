"use client";

// Una cola, una tabla y «Atender» en todos los pedidos. Las tarjetas solo
// filtran esa cola; `vista=listas|todos|resumen` ya no selecciona otra pantalla.
// Las acciones conservan los permisos y guardas del pedido y de cada caso.
import { useEffect, useMemo, useRef, useState, useTransition, type ReactNode } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { cn } from "@/components/ui";
import { Badge, Banner, FIELD, FilterPill, OpsButton, StatusCard, ChoiceChip } from "@/components/ops-ui";
import { Sheet } from "@/components/filter-sheet";
import { DateRangePill, FacetPill } from "@/components/facet-pill";
import { IconCheck, IconSearch, IconX } from "@/components/icons";
import { OrderLink } from "@/components/order-link";
import type { ReproLimaData, ReproRow } from "@/lib/repro-lima-access";
import { cutoffNotice } from "@/lib/repro-lima";
import { limaClock } from "@/lib/grupo-gf-courier";
import { ReproLimaSheet, type ReproSaved } from "@/components/repro-lima-sheet";
import { LimaPendingFilters, LimaPendingList, type LimaRowSelection } from "@/components/repro-lima-pending";
import { loadReproRow } from "@/app/dashboard/pedidos/repro-lima/actions";
import { approveAliclikRetry } from "@/app/dashboard/pedidos/repro-lima/retry-actions";
import { LIMA_QUEUE_CARDS, LIMA_FOLLOWUP_FILTERS, attentionCounts, attentionFilter, attentionRows, createdPresets, emptyRowFilters, pendingKey, pendingMatches, readRowFilters, retryApprovalTargets, rowFilterOptions, rowFiltersParam, rowFiltersActive, rowFiltersMatch, togglePendingKeys, writeRowFilters, type LimaAttentionFilter, type LimaPendingOrder, type LimaRowFilters } from "@/lib/repro-lima-pending";

const FOCUS_REFRESH_MS = 20_000;

type OpenSheet = {
  row: ReproRow;
  mode: "edit" | "read";
  askReopen?: boolean;
  key: number;
  /** El aviso del pedido anterior, arriba de la hoja siguiente. */
  previous?: { orderName: string; text: string } | null;
};
type Feedback = { kind: "notice" | "error"; text: string; orderId?: string; orderName?: string; mesa?: boolean; extra?: string | null };

export function ReproLimaBoard({ data, pending, retriesOnly = false }: {
  data: ReproLimaData;
  pending: LimaPendingOrder[];
  /** Despacho sin `repro_lima.manage` (03-11-2026): solo «Reintentos Aliclik», sin Atender. */
  retriesOnly?: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [refreshing, startRefresh] = useTransition();
  const list = retriesOnly ? "reintentos_aliclik" : attentionFilter(searchParams.get("atencion"));
  const [query, setQuery] = useState("");
  const [store, setStore] = useState("");
  const [storeSheet, setStoreSheet] = useState(false);
  const storePill = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState<OpenSheet | null>(null);
  const [loadingOrder, setLoadingOrder] = useState<string | null>(null);
  const opening = useRef(0);
  useEffect(() => () => { opening.current += 1; }, []);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const lastRefresh = useRef(0);
  const [now, setNow] = useState(() => new Date(data.nowIso));
  const today = limaClock(now).day;
  const hiddenParam = searchParams.getAll("ocultar").join("|");
  const hidden = useMemo(() => new Set(hiddenParam ? hiddenParam.split("|") : []), [hiddenParam]);
  const pendingStore = useMemo(() => pending.filter((row) => !store || row.storeId === store), [pending, store]);
  // Creación, Canal, Distrito y Courier (06-11-2026) recortan como Tienda: los
  // chips, las tarjetas y la tabla. Viven en la URL, como las exclusiones.
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
  const counts = useMemo(() => attentionCounts(scoped, data.rows, today), [scoped, data.rows, today]);
  const inQueue = useMemo(() => attentionRows(scoped, data.rows, list, today), [scoped, data.rows, list, today]);
  const caseById = useMemo(() => new Map(data.rows.map((row) => [row.orderId, row])), [data.rows]);
  const storeName = data.stores.find((s) => s.id === store)?.name ?? null;

  function replaceParams(params: URLSearchParams) {
    params.delete("vista");
    const qs = params.toString();
    window.history.replaceState(null, "", qs ? `${pathname}?${qs}` : pathname);
  }

  function changeHidden(next: ReadonlySet<string>) {
    const params = new URLSearchParams(searchParams.toString());
    params.delete("ocultar");
    for (const key of [...next].sort()) params.append("ocultar", key);
    replaceParams(params);
  }

  function patchRowFilters(next: Partial<LimaRowFilters>) {
    const params = new URLSearchParams(searchParams.toString());
    writeRowFilters(params, { ...rowFilters, ...next });
    replaceParams(params);
  }

  function chooseList(next: LimaAttentionFilter) {
    const params = new URLSearchParams(searchParams.toString());
    if (next === "todos") params.delete("atencion");
    else params.set("atencion", next);
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

  // La fila viva de la hoja abierta: tras releer, la del servidor; si salió de
  // la etapa, la última que se vio.
  const sheetRow = open ? data.rows.find((row) => row.orderId === open.row.orderId) ?? open.row : null;

  /** El siguiente de la misma lista, que nadie más esté atendiendo. */
  function nextAfter(orderId: string): LimaPendingOrder | null {
    const rows = inQueue;
    const at = rows.findIndex((row) => row.orderId === orderId);
    const after = at >= 0 ? [...rows.slice(at + 1), ...rows.slice(0, at)] : rows;
    return after.find((row) => row.orderId !== orderId && caseById.get(row.orderId)?.claim.view !== "otro" && caseById.get(row.orderId)?.list !== "cerrados") ?? null;
  }

  function openRow(row: ReproRow, mode: "edit" | "read", askReopen = false, previous: OpenSheet["previous"] = null) {
    opening.current += 1;
    setLoadingOrder(null);
    setOpen({ row, mode, askReopen, key: Date.now(), previous });
  }

  async function attend(row: LimaPendingOrder, previous: OpenSheet["previous"] = null) {
    const request = ++opening.current;
    setLoadingOrder(row.orderId);
    setFeedback((current) => current?.kind === "error" && current.orderId === row.orderId ? null : current);
    try {
      const known = caseById.get(row.orderId);
      const result = known ? { row: known } : await loadReproRow(row.orderId);
      if (opening.current !== request) return;
      if ("error" in result || !result.row) {
        setFeedback({ kind: "error", text: "error" in result ? result.error : "El pedido ya no está pendiente de entrega en Lima. Actualiza la lista.", orderId: row.orderId, orderName: row.orderName });
        return;
      }
      const current = result.row;
      const read = current.list === "cerrados" || current.list === "programados" && Boolean(current.agreement);
      openRow(current, read ? "read" : "edit", false, previous);
    } catch {
      if (opening.current === request) setFeedback({ kind: "error", text: "No pudimos abrir la gestión del pedido. Vuelve a intentarlo.", orderId: row.orderId, orderName: row.orderName });
    } finally {
      if (opening.current === request) setLoadingOrder(null);
    }
  }

  function onSaved(saved: ReproSaved, advance: boolean) {
    // Lo que pide algo (un error, como «no se pudo programar», o crear la
    // salida en la Mesa de ruta) no pasa al siguiente: la hoja se cierra y el
    // aviso queda a la vista en el tablero. Lo demás («Avisa a Almacén…») pasa
    // al siguiente y va arriba de su hoja, que si no lo taparía.
    const next = advance && !saved.error && !saved.mesa ? nextAfter(saved.orderId) : null;
    const text = saved.error ?? saved.notice ?? "Guardado.";
    setFeedback({
      kind: saved.error ? "error" : "notice",
      text,
      extra: saved.error ? saved.notice : null,
      orderId: saved.orderId,
      orderName: saved.orderName,
      mesa: saved.mesa,
    });
    refresh();
    setOpen(null);
    if (next) void attend(next, { orderName: saved.orderName, text });
  }

  /** Una sola entrada de atención. Las acciones específicas ya viven dentro
   * de la hoja; abrir acuerdos o cierres no toma ni reabre el caso. */
  function rowActions(row: LimaPendingOrder, stacked = false): ReactNode {
    // Sin `repro_lima.manage` no se llama ni se acuerda: la guía se crea desde la ficha.
    if (retriesOnly) return null;
    const size = stacked ? "sm" : "md";
    return <OpsButton size={size} className="pointer-coarse:h-11" disabled={loadingOrder !== null} onClick={() => void attend(row)}>{loadingOrder === row.orderId ? "Abriendo…" : "Atender"}</OpsButton>;
  }

  // «Aprobar todos» (entrega 2): los de la bandeja que ya se pueden aprobar
  // (fallaron un día anterior; no esperan la devolución, owner 03-11-2026),
  // uno por uno por el mismo camino que «Aprobar»; al final, el resumen.
  const [bulk, setBulk] = useState<{ done: number; total: number } | null>(null);
  const readyToApprove = list === "reintentos_aliclik"
    ? inQueue.filter((row) => caseById.get(row.orderId)?.retryChain?.ready)
    : [];
  // Elegir cuáles aprobar (owner, 06-11-2026): con alguno marcado, el botón
  // aprueba esos; sin marcar, todos los listos, como antes.
  const [picked, setPicked] = useState<Set<string>>(() => new Set());
  const targets = retryApprovalTargets(readyToApprove, picked);
  const selection: LimaRowSelection | undefined = list === "reintentos_aliclik" ? {
    selectable: (row) => Boolean(caseById.get(row.orderId)?.retryChain?.ready),
    selected: picked,
    onToggle: (orderId) => setPicked((current) => {
      const next = new Set(current);
      if (next.has(orderId)) next.delete(orderId); else next.add(orderId);
      return next;
    }),
    onToggleAll: (orderIds, on) => setPicked((current) => {
      const next = new Set(current);
      for (const id of orderIds) { if (on) next.add(id); else next.delete(id); }
      return next;
    }),
  } : undefined;
  async function approveAll() {
    const rows = targets.rows;
    if (!rows.length || bulk) return;
    if (!window.confirm(`Se crearán ${rows.length} ${rows.length === 1 ? "guía" : "guías"} de Aliclik${targets.picked ? " (las elegidas)" : ""}. ¿Seguir?`)) return;
    const failed: string[] = [];
    let created = 0;
    setBulk({ done: 0, total: rows.length });
    for (const [i, row] of rows.entries()) {
      try {
        const result = await approveAliclikRetry(row.orderId);
        if (result.error) failed.push(`${row.orderName}: ${result.error}`);
        else created += 1;
      } catch {
        failed.push(`${row.orderName}: no se pudo crear (error de conexión).`);
      }
      setBulk({ done: i + 1, total: rows.length });
    }
    setBulk(null);
    setPicked(new Set());
    setFeedback({
      kind: failed.length ? "error" : "notice",
      text: `Guías creadas: ${created} de ${rows.length}.`,
      extra: failed.length ? failed.join(" · ") : null,
    });
    refresh();
  }

  const selectedGroup = [...LIMA_QUEUE_CARDS, ...LIMA_FOLLOWUP_FILTERS].find((c) => c.key === list);
  const emptyText = query.trim()
    ? `Ningún pedido coincide con «${query.trim()}».`
    : list === "todos" ? "No hay pedidos con estos filtros. Activa otros macroestados o quita la búsqueda." : selectedGroup?.empty ?? "No hay pedidos con estos filtros.";

  return (
    <div className="space-y-4">
      <header className="space-y-3">
        <div className="min-w-0">
          <h1 className="text-[28px] font-bold leading-9 tracking-[-0.01em] text-ink-900">Repro Lima</h1>
          <p className="mt-1 text-sm text-ink-500">
            {retriesOnly
              ? "Los no entregados de Lima que vuelven a salir por Aliclik, sin llamar. Abre el pedido y crea la guía con el transporte indicado."
              : "Todos los pendientes de Lima en una sola lista. Abre «Atender» para continuar con cada pedido."}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={cutoff.passed ? "warn" : "info"} wrap>{cutoff.text}</Badge>
          <span className="text-[13px] text-ink-500" aria-live="polite">{refreshing ? "Actualizando…" : null}</span>
        </div>
      </header>

      <div role="group" aria-label="Filtros de atención" className="grid grid-cols-2 gap-2 sm:grid-cols-4 2xl:grid-cols-8 [&>button>span:first-child]:whitespace-normal [&>button>span:last-child]:mt-auto">
        {!retriesOnly && <StatusCard label="Todos · por entregar" value={counts.todos} hint="Todos los pendientes de entrega de Lima, con Atender en cada fila." active={list === "todos"} onClick={() => chooseList("todos")} />}
        {LIMA_QUEUE_CARDS.filter((card) => !retriesOnly || card.key === "reintentos_aliclik").map((card) => (
          <StatusCard key={card.key} label={card.label} value={counts[card.key]} hint={card.hint} active={list === card.key} onClick={() => chooseList(list === card.key ? "todos" : card.key)} />
        ))}
      </div>

      <LimaPendingFilters rows={narrowed} hidden={hidden} onToggle={(keys) => changeHidden(togglePendingKeys(hidden, keys))} onReset={() => changeHidden(new Set())} />

      {feedback && (
        <Banner tone={feedback.kind === "error" ? "crit" : "ok"} role={feedback.kind === "error" ? "alert" : "status"}>
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 space-y-1">
              {feedback.orderName && <p className="font-semibold text-ink-900">{feedback.orderName}</p>}
              <p>{feedback.text}</p>
              {feedback.extra && <p>{feedback.extra}</p>}
              {feedback.mesa && feedback.orderId && (
                <OrderLink orderId={feedback.orderId} section="operar" className="inline-flex min-h-8 items-center font-medium text-brand-700 hover:underline">
                  Abrir la Mesa de ruta del pedido
                </OrderLink>
              )}
            </div>
            <button type="button" onClick={() => setFeedback(null)} aria-label="Cerrar el aviso" className="grid size-8 shrink-0 place-items-center rounded-md text-ink-500 hover:bg-white/60 hover:text-ink-900">
              <IconX className="size-4" />
            </button>
          </div>
        </Banner>
      )}

      <section aria-label={list === "todos" ? "Todos los pendientes de Lima" : selectedGroup?.label ?? "Todos los pendientes de Lima"} className="rounded-lg bg-white shadow-control ring-1 ring-line">
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
          <div role="group" aria-label="Seguimiento de llamadas y cierres" className="flex flex-wrap items-center gap-1.5">
            {LIMA_FOLLOWUP_FILTERS.filter((f) => !retriesOnly && (counts[f.key] > 0 || list === f.key)).map((f) => (
              <ChoiceChip key={f.key} label={f.label} count={counts[f.key]} title={f.hint} active={list === f.key} onClick={() => chooseList(list === f.key ? "todos" : f.key)} />
            ))}
          </div>
          {list === "reintentos_aliclik" && (
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
        <LimaPendingList key={`${list}:${store}:${query}:${hiddenParam}:${rowFiltersKey}`} rows={inQueue} reproRows={data.rows} today={today} renderActions={rowActions} emptyText={emptyText} selection={selection} />
      </section>

      {open && sheetRow && (
        <ReproLimaSheet
          key={`${open.row.orderId}:${open.key}`}
          row={sheetRow}
          initialMode={open.mode}
          askReopen={open.askReopen}
          hasNext={Boolean(nextAfter(open.row.orderId))}
          onClose={() => { setOpen(null); refresh(); }}
          onSaved={onSaved}
          onChanged={refresh}
          previous={open.previous}
        />
      )}
    </div>
  );
}
