"use client";

// «Repro Lima» · el tablero (fase 1, entrega 1a; MOM §9.5).
//
// Los clientes de Lima con entrega fallida, en cuatro listas que son ETIQUETAS
// de esta pantalla, no subetapas del Master (D2): «Por decidir», «Llamar
// después», «Programados» y «Cerrados». Las cuatro tarjetas filtran y dicen
// cuántos hay (DESIGN.md, «Las cifras navegan»). La lista viene ordenada del
// servidor (`sortRepro`); aquí solo se filtra por tienda y búsqueda.
//
// Desde 1280 px la lista es una tabla; más angosta, filas con líneas finas
// (sin tarjeta dentro de tarjeta, E33). Funciona a 360 px.
//
// «Atender» abre la hoja y toma el caso; «Ver acuerdo» y «Cerrados» la abren
// en solo lectura (E29). Tras cada acción, y al volver a la pestaña, se relee
// con `router.refresh()`.

import { useEffect, useMemo, useRef, useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { cn } from "@/components/ui";
import { Badge, Banner, FIELD, FilterPill, OpsButton, StatusCard, opsButtonClass } from "@/components/ops-ui";
import { Sheet } from "@/components/filter-sheet";
import { IconCheck, IconSearch, IconX } from "@/components/icons";
import { OrderLink } from "@/components/order-link";
import type { ReproLimaData, ReproRow } from "@/lib/repro-lima-access";
import { programReproAgreement, type ReproActionResult } from "@/app/dashboard/pedidos/repro-lima/actions";
import { cutoffNotice, isProblemState, REPRO_LISTS, type ReproList } from "@/lib/repro-lima";
import { soles, telHref } from "@/lib/rider-contact";
import { MAX_OUTPUTS_PER_ORDER } from "@/lib/shipment-output";
import {
  CallButton,
  ClaimBadge,
  FailureLine,
  outputsLine,
  phoneLabel,
  ReproLimaSheet,
  ReproRowChips,
  stageAgeLabel,
  type ReproSaved,
} from "@/components/repro-lima-sheet";

/** Las cuatro tarjetas: etiqueta y lo que dice su lista vacía (§6). */
const LIST_CARD: Record<ReproList, { label: string; hint: string; empty: string }> = {
  por_decidir: {
    label: "Por decidir",
    hint: "Primero los fallos del último día de reparto, después lo vencido y lo que lleva más de 7 días.",
    empty: "Nada por decidir. Los «No entregado» nuevos aparecen aquí.",
  },
  llamar_despues: {
    label: "Llamar después",
    hint: "El cliente pidió que lo llamen a otra hora. Por la hora de la llamada.",
    empty: "Nadie pidió que lo llamen después.",
  },
  programados: {
    label: "Programados",
    hint: "Con acuerdo vigente o programados en Grupo GF. Primero los que hay que revisar.",
    empty: "Todavía no hay acuerdos.",
  },
  cerrados: {
    label: "Cerrados · esperan anulación",
    hint: "«Desarmar y cerrar» del intento vigente: el pedido sigue en la etapa hasta que Shopify anule la venta.",
    empty: "Ningún caso cerrado espera la anulación.",
  },
};

const PAGE = 100;
/** Al volver a la pestaña se relee, como mucho una vez cada 20 segundos. */
const FOCUS_REFRESH_MS = 20_000;

/** Minúsculas sin tildes ni «#», para buscar. */
function norm(value: string | null | undefined): string {
  return (value ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/#/g, "").toLowerCase().trim();
}

function matches(row: ReproRow, query: string): boolean {
  const q = norm(query);
  if (!q) return true;
  if (norm(row.orderName).includes(q) || norm(row.customerName).includes(q)) return true;
  const digits = query.replace(/\D/g, "");
  return digits.length >= 3 && (row.customerPhone ?? "").replace(/\D/g, "").includes(digits);
}

type OpenSheet = { row: ReproRow; mode: "edit" | "read"; askReopen?: boolean; key: number };
type Feedback = { kind: "notice" | "error"; text: string; orderId?: string; orderName?: string; mesa?: boolean; extra?: string | null };

export function ReproLimaBoard({ data }: { data: ReproLimaData }) {
  const router = useRouter();
  const [refreshing, startRefresh] = useTransition();
  const [acting, startAction] = useTransition();
  const [list, setList] = useState<ReproList>("por_decidir");
  const [query, setQuery] = useState("");
  const [store, setStore] = useState("");
  const [storeSheet, setStoreSheet] = useState(false);
  const storePill = useRef<HTMLButtonElement>(null);
  const [limit, setLimit] = useState(PAGE);
  const [open, setOpen] = useState<OpenSheet | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [confirmFound, setConfirmFound] = useState<string | null>(null);
  const lastRefresh = useRef(0);

  // El reloj del corte: empieza en la hora del servidor (sin desajuste al hidratar).
  const [now, setNow] = useState(() => new Date(data.nowIso));
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

  useEffect(() => { setLimit(PAGE); }, [list, query, store]);

  const scoped = useMemo(
    () => data.rows.filter((row) => (!store || row.storeId === store) && matches(row, query)),
    [data.rows, store, query],
  );
  const counts = useMemo(() => {
    const out: Record<ReproList, number> = { por_decidir: 0, llamar_despues: 0, programados: 0, cerrados: 0 };
    for (const row of scoped) out[row.list] += 1;
    return out;
  }, [scoped]);
  const toReview = useMemo(
    () => scoped.filter((row) => row.list === "programados" && isProblemState(row.state.kind)).length,
    [scoped],
  );
  const inList = useMemo(() => scoped.filter((row) => row.list === list), [scoped, list]);
  const visible = inList.slice(0, limit);
  const storeName = data.stores.find((s) => s.id === store)?.name ?? null;

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

  function openRow(row: ReproRow, mode: "edit" | "read", askReopen = false) {
    setConfirmFound(null);
    setOpen({ row, mode, askReopen, key: Date.now() });
  }

  function onSaved(saved: ReproSaved, advance: boolean) {
    const next = advance ? nextAfter(saved.orderId) : null;
    setFeedback({
      kind: saved.error ? "error" : "notice",
      text: saved.error ?? saved.notice ?? "Guardado.",
      extra: saved.error ? saved.notice : null,
      orderId: saved.orderId,
      orderName: saved.orderName,
      mesa: saved.mesa,
    });
    refresh();
    if (next) openRow(next, "edit");
    else setOpen(null);
  }

  function program(row: ReproRow, found: boolean) {
    if (!row.caseId) return;
    if (found && confirmFound !== row.orderId) { setConfirmFound(row.orderId); return; }
    setConfirmFound(null);
    const caseId = row.caseId;
    startAction(async () => {
      const result: ReproActionResult = await programReproAgreement({ caseId, ...(found ? { found: true } : {}) })
        .catch((error: unknown) => ({ error: error instanceof Error ? error.message : String(error) }));
      setFeedback({
        kind: result.error ? "error" : "notice",
        text: result.error ?? result.notice ?? "Programado.",
        orderId: row.orderId,
        orderName: row.orderName,
      });
      refresh();
    });
  }

  /**
   * Los botones de la fila, según su lista y el estado del acuerdo. Una
   * función y no un componente: así no se vuelven a montar en cada render (el
   * foco se quedaba sin botón al pedir el segundo clic).
   */
  function rowActions(row: ReproRow, stacked = false): ReactNode {
    const size = stacked ? "sm" : "md";
    const tap = "pointer-coarse:h-11";
    const buttons: ReactNode[] = [];
    if (row.list === "cerrados") {
      buttons.push(<OpsButton key="ver" size={size} className={tap} onClick={() => openRow(row, "read")}>Ver</OpsButton>);
      buttons.push(<OpsButton key="reabrir" size={size} className={tap} onClick={() => openRow(row, "read", true)}>Volver a atender</OpsButton>);
    } else if (row.list === "programados" && row.agreement) {
      buttons.push(<OpsButton key="ver" size={size} className={tap} onClick={() => openRow(row, "read")}>Ver acuerdo</OpsButton>);
      if (row.state.kind === "por_programar") {
        buttons.push(
          <OpsButton key="programar" size={size} disabled={acting} className={tap} onClick={() => program(row, false)}>
            Programar ahora
          </OpsButton>,
        );
      }
      if (row.state.kind === "falta_ubicar") {
        buttons.push(
          confirmFound === row.orderId ? (
            <OpsButton key="encontrada" size={size} variant="primary" disabled={acting} className={cn(tap, "h-auto min-h-8 whitespace-normal py-1")} onClick={() => program(row, true)}>
              La caja está en la oficina
            </OpsButton>
          ) : (
            <OpsButton key="encontre" size={size} disabled={acting} className={cn(tap, "h-auto min-h-8 whitespace-normal py-1")} onClick={() => program(row, true)}>
              Ya la encontré: programar
            </OpsButton>
          ),
        );
        if (confirmFound === row.orderId) {
          buttons.push(<OpsButton key="cancelar" size={size} variant="ghost" className={tap} onClick={() => setConfirmFound(null)}>Cancelar</OpsButton>);
        }
      }
      if (row.state.kind === "otro_courier") {
        buttons.push(
          <OrderLink key="mesa" orderId={row.orderId} section="operar" className={opsButtonClass("secondary", size, cn(tap, "h-auto min-h-8 whitespace-normal py-1"))}>
            Crear la salida
          </OrderLink>,
        );
      }
    } else {
      buttons.push(
        <OpsButton key="atender" size={size} className={tap} onClick={() => openRow(row, "edit")}>
          Atender
        </OpsButton>,
      );
    }
    return buttons;
  }

  const emptyText = query.trim()
    ? `Ningún pedido coincide con «${query.trim()}».`
    : LIST_CARD[list].empty;
  // La búsqueda encuentra en otra lista: se dice dónde.
  const elsewhere = query.trim() && !inList.length
    ? REPRO_LISTS.filter((l) => l !== list && counts[l] > 0)
    : [];

  return (
    <div className="space-y-4">
      <header className="space-y-3">
        <div className="min-w-0">
          <h1 className="text-[28px] font-bold leading-9 tracking-[-0.01em] text-ink-900">Repro Lima</h1>
          <p className="mt-1 text-sm text-ink-500">Clientes de Lima con entrega fallida: llama, confirma fecha y courier.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={cutoff.passed ? "warn" : "info"} wrap>{cutoff.text}</Badge>
          <span className="text-[13px] text-ink-500" aria-live="polite">{refreshing ? "Actualizando…" : null}</span>
        </div>
      </header>

      <div
        role="group"
        aria-label="Listas de Repro Lima"
        className="grid grid-cols-2 gap-2 sm:grid-cols-4 [&>button>span:first-child]:whitespace-normal [&>button>span:last-child]:mt-auto"
      >
        {REPRO_LISTS.map((l) => (
          <StatusCard
            key={l}
            label={l === "programados" && toReview > 0 ? `Programados · ${toReview} a revisar` : LIST_CARD[l].label}
            value={counts[l]}
            hint={LIST_CARD[l].hint}
            active={list === l}
            onClick={() => setList(l)}
          />
        ))}
      </div>

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

      <section aria-label={LIST_CARD[list].label} className="rounded-lg bg-white shadow-control ring-1 ring-line">
        {/* Búsqueda y tienda, como en Stripe: la píldora es discontinua hasta que filtra. */}
        <div className="flex flex-wrap items-center gap-2 px-4 py-3">
          <label className="relative w-full sm:w-72">
            <span className="sr-only">Buscar pedido, cliente o teléfono</span>
            <IconSearch className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-ink-500" />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Pedido, cliente o teléfono"
              className={cn(FIELD, "h-8 pl-8 pointer-coarse:h-11")}
            />
          </label>
          {data.stores.length > 1 && (
            <FilterPill
              ref={storePill}
              label="Tienda"
              value={storeName}
              expanded={storeSheet}
              onClick={() => setStoreSheet((v) => !v)}
              onClear={() => setStore("")}
            />
          )}
          <p className="w-full text-[13px] tabular-nums text-ink-500 lg:ml-auto lg:w-auto">
            <b className="font-semibold text-ink-900">{inList.length.toLocaleString("es-PE")}</b> en {LIST_CARD[list].label.split(" · ")[0]!.toLocaleLowerCase("es")}
          </p>
        </div>
        {storeSheet && (
          <Sheet look="ops" title="Tienda" onClose={() => setStoreSheet(false)} anchored anchorRef={storePill}>
            <div role="group" className="-mx-1 grid max-h-72 gap-0.5 overflow-auto">
              {[{ id: "", name: "Todas las tiendas" }, ...data.stores].map((s) => (
                <button
                  key={s.id || "todas"}
                  type="button"
                  aria-pressed={s.id === store}
                  onClick={() => { setStore(s.id); setStoreSheet(false); }}
                  className={cn("flex h-9 items-center justify-between gap-2 rounded-md px-2 text-left text-sm hover:bg-wash pointer-coarse:h-11", s.id === store ? "font-semibold text-ink-900" : "text-ink-700")}
                >
                  <span className="truncate">{s.name}</span>
                  {s.id === store && <IconCheck className="size-4 shrink-0 text-brand-600" />}
                </button>
              ))}
            </div>
          </Sheet>
        )}

        {!inList.length ? (
          <div className="border-t border-line px-4 py-12 text-center">
            <p className="text-sm text-ink-500">{emptyText}</p>
            {elsewhere.length > 0 && (
              <div className="mt-3 flex flex-wrap justify-center gap-2">
                {elsewhere.map((l) => (
                  <OpsButton key={l} size="sm" onClick={() => setList(l)}>
                    {`Ver en ${LIST_CARD[l].label.split(" · ")[0]} (${counts[l]})`}
                  </OpsButton>
                ))}
              </div>
            )}
            {query.trim() && (
              <OpsButton size="sm" variant="ghost" className="mt-2" onClick={() => setQuery("")}>Quitar la búsqueda</OpsButton>
            )}
          </div>
        ) : (
          <>
            {/* Escritorio (desde 1280 px): tabla de anchos fijos para lo corto y
                flexibles para cliente, fallo y situación. */}
            <div className="hidden max-h-[70vh] overflow-auto border-t border-line xl:block">
              <table className="w-full table-fixed border-collapse text-sm [&_th]:sticky [&_th]:top-0 [&_th]:z-10 [&_th]:bg-white [&_th]:shadow-[inset_0_-1px_0_var(--color-line)]">
                <colgroup>
                  <col className="w-[10.5rem]" />
                  <col />
                  <col />
                  <col />
                  <col className="w-[8.5rem]" />
                  <col className="w-[10rem]" />
                </colgroup>
                <thead>
                  <tr className="text-left text-xs font-semibold text-ink-600">
                    <th className="px-4 py-2.5">Pedido</th>
                    <th className="px-3 py-2.5">Cliente</th>
                    <th className="px-3 py-2.5">Fallo</th>
                    <th className="px-3 py-2.5">Situación</th>
                    <th className="px-3 py-2.5 text-right">Venta</th>
                    <th className="px-4 py-2.5"><span className="sr-only">Acciones</span></th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((row) => (
                    <tr key={row.orderId} className={cn("border-b border-line align-top transition-colors", open?.row.orderId === row.orderId ? "bg-brand-100/70" : "hover:bg-wash")}>
                      <td className="px-4 py-3">
                        <OrderLink orderId={row.orderId} className="block truncate font-semibold text-ink-900 hover:text-brand-700" title={row.orderName}>{row.orderName}</OrderLink>
                        <p className="truncate text-xs text-ink-500" title={row.storeName}>{row.storeName}</p>
                        {stageAgeLabel(row.daysInStage) && <p className="text-xs tabular-nums text-ink-500">{stageAgeLabel(row.daysInStage)}</p>}
                        <div className="mt-1"><ClaimBadge row={row} /></div>
                      </td>
                      <td className="px-3 py-3">
                        <p className="truncate text-ink-900" title={row.customerName}>{row.customerName}</p>
                        {telHref(row.customerPhone) ? (
                          <a href={telHref(row.customerPhone)!} className="text-xs font-medium tabular-nums text-brand-700 hover:underline">
                            {phoneLabel(row.customerPhone)}
                          </a>
                        ) : (
                          <p className="text-xs text-ink-500">sin teléfono</p>
                        )}
                        <p className="truncate text-xs text-ink-500" title={row.district ?? undefined}>{row.district ?? "sin distrito"}</p>
                      </td>
                      <td className="px-3 py-3">
                        <FailureLine row={row} className="line-clamp-3" />
                      </td>
                      <td className="px-3 py-3">
                        <div className="flex flex-wrap gap-1"><ReproRowChips row={row} today={data.today} /></div>
                      </td>
                      <td className="px-3 py-3 text-right">
                        <p className="font-semibold tabular-nums text-ink-900">{soles(row.orderTotal)}</p>
                        <p className="text-xs text-ink-500" title={outputsLine(row)}>{`Salidas ${row.outputsUsed} de ${MAX_OUTPUTS_PER_ORDER}`}</p>
                        {row.lastOutput && <p className="truncate text-xs text-ink-500" title={outputsLine(row)}>{row.lastOutput.courierName}</p>}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex flex-col items-stretch gap-1.5">{rowActions(row, true)}</div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Más angosto: filas con líneas finas, sin desplazamiento lateral. */}
            <ul className="divide-y divide-line border-t border-line xl:hidden">
              {visible.map((row) => (
                <li key={row.orderId} className={cn("px-4 py-3 sm:flex sm:gap-4", open?.row.orderId === row.orderId && "bg-brand-100/70")}>
                  <div className="min-w-0 flex-1 space-y-1.5">
                    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                      <OrderLink orderId={row.orderId} className="font-semibold text-ink-900 hover:text-brand-700" title={row.orderName}>{row.orderName}</OrderLink>
                      <span className="text-[13px] text-ink-500">
                        {[row.storeName, stageAgeLabel(row.daysInStage)].filter(Boolean).join(" · ")}
                      </span>
                      <ClaimBadge row={row} />
                    </div>
                    <p className="text-sm text-ink-900">
                      {row.customerName}
                      <span className="text-ink-500">{` · ${row.district ?? "sin distrito"} · `}</span>
                      <span className="tabular-nums">{soles(row.orderTotal)}</span>
                    </p>
                    <FailureLine row={row} />
                    <div className="flex flex-wrap gap-1"><ReproRowChips row={row} today={data.today} /></div>
                    <p className="text-xs text-ink-500">{outputsLine(row)}</p>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2 sm:mt-0 sm:w-48 sm:flex-col sm:flex-nowrap [&>*]:grow sm:[&>*]:grow-0">
                    <CallButton phone={row.customerPhone} size="md" />
                    {rowActions(row)}
                  </div>
                </li>
              ))}
            </ul>

            {inList.length > PAGE && (
              <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line px-4 py-3 text-[13px] tabular-nums text-ink-500">
                <span>Mostrando <b className="font-semibold text-ink-900">{visible.length.toLocaleString("es-PE")}</b> de {inList.length.toLocaleString("es-PE")}</span>
                {inList.length > visible.length && <OpsButton size="sm" onClick={() => setLimit((n) => n + PAGE)}>{`Mostrar ${PAGE} más`}</OpsButton>}
              </div>
            )}
          </>
        )}
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
        />
      )}
    </div>
  );
}
