"use client";

// Una cola, una tabla y «Atender» en todos los pedidos. Las tarjetas solo
// filtran esa cola; `vista=listas|todos|resumen` ya no selecciona otra pantalla.
// Las acciones conservan los permisos y guardas del pedido y de cada caso.
import { useEffect, useMemo, useRef, useState, useTransition, type ReactNode } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { cn } from "@/components/ui";
import { Badge, Banner, FIELD, FilterPill, OpsButton, StatusCard, ChoiceChip } from "@/components/ops-ui";
import { Sheet } from "@/components/filter-sheet";
import { IconCheck, IconSearch, IconX } from "@/components/icons";
import { OrderLink } from "@/components/order-link";
import type { ReproLimaData, ReproRow } from "@/lib/repro-lima-access";
import { cutoffNotice } from "@/lib/repro-lima";
import { limaClock } from "@/lib/grupo-gf-courier";
import { ReproLimaSheet, type ReproSaved } from "@/components/repro-lima-sheet";
import { LimaPendingFilters, LimaPendingList } from "@/components/repro-lima-pending";
import { LIMA_QUEUE_CARDS, LIMA_FOLLOWUP_FILTERS, attentionCounts, attentionFilter, attentionRows, pendingKey, pendingMatches, togglePendingKeys, type LimaAttentionFilter, type LimaPendingOrder } from "@/lib/repro-lima-pending";

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

export function ReproLimaBoard({ data, pending }: { data: ReproLimaData; pending: LimaPendingOrder[] }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [refreshing, startRefresh] = useTransition();
  const list = attentionFilter(searchParams.get("atencion"));
  const [query, setQuery] = useState("");
  const [store, setStore] = useState("");
  const [storeSheet, setStoreSheet] = useState(false);
  const storePill = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState<OpenSheet | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const lastRefresh = useRef(0);
  const [now, setNow] = useState(() => new Date(data.nowIso));
  const today = limaClock(now).day;
  const hiddenParam = searchParams.getAll("ocultar").join("|");
  const hidden = useMemo(() => new Set(hiddenParam ? hiddenParam.split("|") : []), [hiddenParam]);
  const pendingStore = useMemo(() => pending.filter((row) => !store || row.storeId === store), [pending, store]);
  const scoped = useMemo(() => pendingStore.filter((row) => !hidden.has(pendingKey(row)) && pendingMatches(row, query)), [pendingStore, hidden, query]);
  const counts = useMemo(() => attentionCounts(scoped, data.rows, today), [scoped, data.rows, today]);
  const inQueue = useMemo(() => attentionRows(scoped, data.rows, list, today), [scoped, data.rows, list, today]);
  const caseById = useMemo(() => new Map(data.rows.map((row) => [row.orderId, row])), [data.rows]);
  const inList = useMemo(() => inQueue.flatMap((row) => {
    const c = caseById.get(row.orderId);
    return c ? [c] : [];
  }), [inQueue, caseById]);
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
  function nextAfter(orderId: string): ReproRow | null {
    const rows = inList;
    const at = rows.findIndex((row) => row.orderId === orderId);
    const after = at >= 0 ? [...rows.slice(at + 1), ...rows.slice(0, at)] : rows;
    return after.find((row) => row.orderId !== orderId && row.claim.view !== "otro" && row.list !== "cerrados") ?? null;
  }

  function openRow(row: ReproRow, mode: "edit" | "read", askReopen = false, previous: OpenSheet["previous"] = null) {
    setOpen({ row, mode, askReopen, key: Date.now(), previous });
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
    if (next) openRow(next, "edit", false, { orderName: saved.orderName, text });
    else setOpen(null);
  }

  /** Una sola entrada de atención. Las acciones específicas ya viven dentro
   * de la hoja; abrir acuerdos o cierres no toma ni reabre el caso. */
  function rowActions(row: ReproRow, stacked = false): ReactNode {
    const size = stacked ? "sm" : "md";
    if (row.list === "cerrados" || (row.list === "programados" && row.agreement)) {
      return <OpsButton size={size} className="pointer-coarse:h-11" onClick={() => openRow(row, "read")}>Atender</OpsButton>;
    }
    return <OpsButton size={size} className="pointer-coarse:h-11" onClick={() => openRow(row, "edit")}>Atender</OpsButton>;
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
          <p className="mt-1 text-sm text-ink-500">Todos los pendientes de Lima en una sola lista. Abre «Atender» para continuar con cada pedido.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={cutoff.passed ? "warn" : "info"} wrap>{cutoff.text}</Badge>
          <span className="text-[13px] text-ink-500" aria-live="polite">{refreshing ? "Actualizando…" : null}</span>
        </div>
      </header>

      <div role="group" aria-label="Filtros de atención" className="grid grid-cols-2 gap-2 sm:grid-cols-4 2xl:grid-cols-8 [&>button>span:first-child]:whitespace-normal [&>button>span:last-child]:mt-auto">
        <StatusCard label="Todos · por entregar" value={counts.todos} hint="Todos los pendientes de entrega de Lima, con Atender en cada fila." active={list === "todos"} onClick={() => chooseList("todos")} />
        {LIMA_QUEUE_CARDS.map((card) => (
          <StatusCard key={card.key} label={card.label} value={counts[card.key]} hint={card.hint} active={list === card.key} onClick={() => chooseList(list === card.key ? "todos" : card.key)} />
        ))}
      </div>

      <LimaPendingFilters rows={pendingStore} hidden={hidden} onToggle={(keys) => changeHidden(togglePendingKeys(hidden, keys))} onReset={() => changeHidden(new Set())} />

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
          <div role="group" aria-label="Seguimiento de llamadas y cierres" className="flex flex-wrap items-center gap-1.5">
            {LIMA_FOLLOWUP_FILTERS.filter((f) => counts[f.key] > 0 || list === f.key).map((f) => (
              <ChoiceChip key={f.key} label={f.label} count={counts[f.key]} active={list === f.key} onClick={() => chooseList(list === f.key ? "todos" : f.key)} />
            ))}
          </div>
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
        <LimaPendingList key={`${list}:${store}:${query}:${hiddenParam}`} rows={inQueue} reproRows={data.rows} today={today} renderActions={rowActions} emptyText={emptyText} />
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
