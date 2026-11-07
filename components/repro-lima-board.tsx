"use client";

// Una cola, una tabla y «Atender» en todos los pedidos. Las tarjetas solo
// filtran esa cola; `vista=listas|todos|resumen` ya no selecciona otra pantalla.
// Las acciones conservan los permisos y guardas del pedido y de cada caso.
//
// «Atender» abre la ficha del pedido en su pestaña «Repro Lima»
// (`?ficha=<pedido>&seccion=reprolima`, 07-11-2026): ya no hay una hoja aparte
// encima de la ficha. El tablero publica cuál es el siguiente de esta lista
// (lib/repro-lima-queue.ts) para «Guardar y pasar al siguiente».
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
import { LimaPendingFilters, LimaPendingList } from "@/components/repro-lima-pending";
import { clearReproLimaQueue, setReproLimaQueue, type ReproLimaQueue } from "@/lib/repro-lima-queue";
import { approveAliclikRetry } from "@/app/dashboard/pedidos/repro-lima/retry-actions";
import { LIMA_QUEUE_CARDS, LIMA_FOLLOWUP_FILTERS, attentionCounts, attentionFilter, attentionRows, createdPresets, emptyRowFilters, pendingKey, pendingMatches, readRowFilters, rowFilterOptions, rowFiltersParam, rowFiltersActive, rowFiltersMatch, togglePendingKeys, writeRowFilters, type LimaAttentionFilter, type LimaPendingOrder, type LimaRowFilters } from "@/lib/repro-lima-pending";

const FOCUS_REFRESH_MS = 20_000;

type Feedback = { kind: "notice" | "error"; text: string; extra?: string | null };

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
  const openDrawer = useOpenOrderDrawer();
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

  /** Una sola entrada de atención: la ficha del pedido en su pestaña «Repro
   * Lima». Las acciones específicas viven dentro de ella; un acuerdo
   * programado o un cierre se abren para leer, sin tomar ni reabrir el caso. */
  function rowActions(row: LimaPendingOrder, stacked = false): ReactNode {
    // Sin `repro_lima.manage` no se llama ni se acuerda: la guía se crea desde la ficha.
    if (retriesOnly) return null;
    const size = stacked ? "sm" : "md";
    return <OpsButton size={size} className="pointer-coarse:h-11" onClick={() => openDrawer(row.orderId, "reprolima")}>Atender</OpsButton>;
  }

  // «Aprobar todos» (entrega 2): los de la bandeja que ya se pueden aprobar
  // (fallaron un día anterior; no esperan la devolución, owner 03-11-2026),
  // uno por uno por el mismo camino que «Aprobar»; al final, el resumen.
  const [bulk, setBulk] = useState<{ done: number; total: number } | null>(null);
  const readyToApprove = list === "reintentos_aliclik"
    ? inQueue.filter((row) => caseById.get(row.orderId)?.retryChain?.ready)
    : [];
  async function approveAll() {
    const rows = readyToApprove;
    if (!rows.length || bulk) return;
    if (!window.confirm(`Se crearán ${rows.length} guías de Aliclik. ¿Seguir?`)) return;
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
              <p>{feedback.text}</p>
              {feedback.extra && <p>{feedback.extra}</p>}
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
            <OpsButton size="sm" variant="primary" disabled={!readyToApprove.length || Boolean(bulk)} onClick={() => void approveAll()} className="pointer-coarse:h-11">
              {bulk ? `Creando ${bulk.done} de ${bulk.total}…` : `Aprobar todos los listos (${readyToApprove.length})`}
            </OpsButton>
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
        <LimaPendingList key={`${list}:${store}:${query}:${hiddenParam}:${rowFiltersKey}`} rows={inQueue} reproRows={data.rows} today={today} renderActions={rowActions} emptyText={emptyText} />
      </section>

    </div>
  );
}
