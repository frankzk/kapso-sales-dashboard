"use client";

// Master de Pedidos — la vista central de control de la operación logística.
//
// FILTRA LA BASE, NO ESTA PANTALLA. Antes se bajaban las ~10.000 filas al
// navegador y se filtraban en memoria: 13 MB por carga, otra vez enteras en cada
// cambio de pestaña, y unos diez segundos mirando el esqueleto. Ahora llega UNA
// página de 100 filas ya filtrada y ordenada (~100 KB).
//
// Los filtros viven en la URL, que es lo que permite que el servidor sepa qué
// traer. De ahí salen gratis dos cosas: una vista filtrada se puede compartir
// por enlace, y atrás/adelante del navegador funcionan.
//
// El coste, para que quede dicho: cada clic en un filtro es un viaje al
// servidor en vez de ser instantáneo. Se disimula con `useTransition`, que
// mantiene el listado anterior en pantalla mientras llega el nuevo en vez de
// parpadear a vacío.

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { usePathname, useRouter } from "next/navigation";
import Link from "next/link";
import { Card, cn, EmptyState, STICKY_HEAD, TABLE_LAYER, TABLE_WRAP_PAGE_X } from "@/components/ui";
import { AliclikGuidePanel } from "@/components/aliclik-guide-panel";
import { DirectFenixGuideModal } from "@/components/direct-fenix-guide-modal";
import { ManualRouteOutputModal } from "@/components/manual-route-output-modal";
import { OrderClosureDesk } from "@/components/order-closure-desk";
import { OrderRouteDesk } from "@/components/order-route-desk";
import { ChecklistFilter } from "@/components/filters";
import { PickupKeyPanel, ShalomPickupKeyPanel } from "@/components/pickup-key-panel";
import { TandersGuideModal } from "@/components/tanders-guide-modal";
import { markTandersLabelGenerated } from "@/app/dashboard/pedidos/tanders-actions";
import { ShalomGuideModal } from "@/components/shalom-guide-modal";
import { cancelShalomGuide } from "@/app/dashboard/pedidos/shalom-actions";
import { shalomGuideIsCancelable } from "@/lib/shalom/draft";
import {
  addOrderComment,
  clearOrderGeo,
  createManualRouteOutputsBulk,
  loadOrderDetail,
  resolveLabelsForOrders,
  loadOrderGeo,
  applyOrderStatusBulk,
  loadConfirmationBrief,
  registerConfirmationAttempt,
  registerReturn,
  registerClosureAction,
  relinkGuide,
  setOrderStatus,
  updateOrderGeo,
  type BulkRouteOutputFailure,
  type ManualRouteCourier,
  type OrderGeoInput,
} from "@/app/dashboard/pedidos/actions";
import { limaTodayKey } from "@/lib/shipments";
import { COURIER_TBD } from "@/lib/shipment-output";
import {
  agencyHasActivity,
  emptyFilters,
  hasActiveFilters,
  type AgencySummary,
  type MasterFilters,
  type MasterSortKey,
} from "@/lib/order-master-filters";
import { buildMasterQuery } from "@/lib/master-query";
import {
  ORDER_COVERAGE_LABEL,
  type OrderCoverage,
} from "@/lib/order-coverage";
import {
  GENERAL_STATUSES,
  daysInAgency,
  daysInStatus,
  generalLabel,
  isGeneralStatus,
  operationalLabel,
  operationalStatusesFor,
  type GeneralStatus,
} from "@/lib/order-status";
import {
  MACRO_SUBSTAGES_BY_STAGE,
  macroStageLabel,
  macroSubstageLabel,
  type OrderMacroStage,
  type MacroSubstage,
} from "@/lib/order-macro-stage";
import { KEY_STATE_LABEL, PAYMENT_STATE_LABEL, type KeyState, type PaymentState } from "@/lib/pickup-key";
import { orderPaymentPanelPresentation } from "@/lib/order-payment-panel";
import {
  CONFIRMATION_CHANNELS,
  CONFIRMATION_MAX_DAYS,
  CONFIRMATION_RESULTS,
  confirmationChannelLabel,
  confirmationDays,
  confirmationResult,
  confirmationResultLabel,
  limaDayKey,
} from "@/lib/order-confirmation";
import {
  MASTER_VIEWS,
  type MasterCounts,
  type MasterView,
  type OrderConfirmationBrief,
  type OrderMasterDetail,
  type TimelineEntry,
} from "@/lib/orders-master-access";
import {
  DISPATCH_STATE_LABEL,
  PAYMENT_REQUIREMENT_LABEL,
  PRIOR_OUTCOME_LABEL,
  countLaterOrders,
  dispatchState,
  priorCourier,
  priorOutcome,
  priorTiming,
  sameProducts,
  type PaymentRequirement,
  type PriorOrderSnapshot,
  type PriorOutcome,
} from "@/lib/order-confirmation-brief";
import { outputDisplayCode } from "@/lib/shipment-output";
import { shopifyOrderAdminUrl } from "@/lib/shopify-urls";
import type { RouteCandidate } from "@/lib/order-route-plan";
import type { OrderMasterRow, StoreSummary } from "@/lib/types";

// ---------------------------------------------------------------------------
// Formato
// ---------------------------------------------------------------------------

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(+d)) return "—";
  return d.toLocaleDateString("es-PE", { day: "2-digit", month: "2-digit", year: "2-digit" });
}

function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(+d)) return "—";
  return d.toLocaleString("es-PE", {
    day: "2-digit",
    month: "2-digit",
    year: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Antigüedad legible: lo que el equipo mira para detectar lo estancado. */
function fmtAge(since: string | null): string {
  const days = daysInStatus(since);
  if (days === null) return "—";
  if (days === 0) return "hoy";
  if (days === 1) return "1 día";
  return `${days} días`;
}

function fmtMoney(value: number | null): string {
  if (value === null || value === undefined) return "—";
  return `S/ ${value.toFixed(2)}`;
}

const MODE_LABEL: Record<string, string> = {
  cod: "Contraentrega",
  agency: "Agencia",
};

const STATUS_TONE: Record<string, string> = {
  pendiente: "bg-slate-100 text-slate-700",
  en_proceso: "bg-amber-100 text-amber-800",
  entregado: "bg-emerald-100 text-emerald-800",
  anulado: "bg-slate-200 text-slate-600",
  devuelto: "bg-red-100 text-red-800",
};

const COVERAGE_TONE: Record<OrderCoverage, string> = {
  lima: "border-sky-200 bg-sky-50 text-sky-700",
  provincia_cod: "border-emerald-200 bg-emerald-50 text-emerald-700",
  agencia: "border-violet-200 bg-violet-50 text-violet-700",
  por_revisar: "border-amber-300 bg-amber-50 text-amber-800",
};

function CoverageBadge({ coverage }: { coverage: OrderMasterRow["coverage"] }) {
  const value = coverage ?? "por_revisar";
  return (
    <span
      className={cn(
        "inline-flex whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-semibold",
        COVERAGE_TONE[value],
      )}
    >
      {ORDER_COVERAGE_LABEL[value]}
    </span>
  );
}

/**
 * Anular una guía de Shalom, en dos pasos.
 *
 * Crear emite una guía real y cobrable de un solo clic, así que deshacer no
 * puede ser otro clic a su lado: un resbalón del ratón en una lista de guías
 * anularía un despacho. El primer clic solo cambia el botón por una pregunta con
 * el número de guía delante; el segundo es el que llama.
 *
 * El botón únicamente aparece mientras Shalom todavía deja borrar (ver
 * `shalomGuideIsCancelable`), pero eso es cortesía de interfaz: el servidor
 * revalida las mismas condiciones, porque un botón que no se pinta no es una
 * autorización.
 */
function ShalomCancelButton({
  shipmentId,
  guideCode,
  codigo,
  onDone,
}: {
  shipmentId: string;
  guideCode: string | null;
  codigo: string | null;
  onDone: (notice: string) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (busy) return <span className="text-xs text-slate-500">Anulando…</span>;

  if (!confirming) {
    return (
      <>
        <button
          type="button"
          onClick={() => {
            setError(null);
            setConfirming(true);
          }}
          className="text-xs font-medium text-red-700 hover:underline"
        >
          Anular
        </button>
        {error && <span className="w-full text-xs text-red-700">{error}</span>}
      </>
    );
  }

  return (
    <span className="flex w-full flex-wrap items-center gap-2 rounded-lg bg-red-50 px-2 py-1.5">
      <span className="text-xs text-red-800">
        ¿Anular la guía <strong>{guideCode ?? "—"}</strong>
        {codigo ? ` (${codigo})` : ""} en Shalom? No se puede deshacer.
      </span>
      <button
        type="button"
        onClick={async () => {
          setBusy(true);
          const res = await cancelShalomGuide(shipmentId);
          setBusy(false);
          setConfirming(false);
          if ("error" in res) setError(res.error);
          else onDone(res.notice);
        }}
        className="rounded bg-red-700 px-2 py-1 text-xs font-medium text-white hover:bg-red-800"
      >
        Sí, anular
      </button>
      <button
        type="button"
        onClick={() => setConfirming(false)}
        className="text-xs font-medium text-slate-600 hover:underline"
      >
        Cancelar
      </button>
    </span>
  );
}

function StatusBadge({ status, locked }: { status: string; locked?: boolean }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium",
        STATUS_TONE[status] ?? "bg-slate-100 text-slate-700",
      )}
      title={locked ? "Estado fijado manualmente: el recálculo automático no lo pisa" : undefined}
    >
      {generalLabel(status)}
      {locked && <span aria-hidden="true">🔒</span>}
    </span>
  );
}

const MACRO_STAGE_TONE: Record<string, string> = {
  por_confirmar: "bg-amber-50 text-amber-800 ring-amber-600/20",
  preparacion: "bg-sky-50 text-sky-800 ring-sky-600/20",
  por_despachar: "bg-indigo-50 text-indigo-800 ring-indigo-600/20",
  en_curso: "bg-cyan-50 text-cyan-800 ring-cyan-600/20",
  por_cerrar: "bg-orange-50 text-orange-800 ring-orange-600/20",
  finalizado: "bg-emerald-50 text-emerald-800 ring-emerald-600/20",
};

function MacroStageBadge({ stage }: { stage: string | null | undefined }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold ring-1 ring-inset",
        MACRO_STAGE_TONE[stage ?? ""] ?? "bg-slate-100 text-slate-700 ring-slate-500/20",
      )}
    >
      {macroStageLabel(stage)}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Board
// ---------------------------------------------------------------------------

export function OrdersMasterBoard({
  stores,
  view,
  substage,
  counts,
  substageCounts,
  rows,
  total,
  page,
  pageSize,
  filters,
  sortKey,
  facets,
  agency,
  canEdit,
  canOverride,
  canCreateGuide,
  canCreateTandersGuide,
  canCreateShalomGuide,
  canDispatch,
  canWarehouse,
  closurePermissions,
}: {
  stores: StoreSummary[];
  view: MasterView;
  substage: MacroSubstage | null;
  counts: MasterCounts;
  substageCounts: Partial<Record<MacroSubstage, number>>;
  /** UNA página ya filtrada y ordenada por la base. Antes llegaban las ~10.000
   *  filas y se filtraba aquí: eran 13 MB por carga y ~10 s de espera. */
  rows: OrderMasterRow[];
  total: number;
  page: number;
  pageSize: number;
  /** Filtros vigentes, leídos de la URL en el servidor. Aquí solo se pintan y
   *  se reescriben; quien filtra es la base. */
  filters: MasterFilters;
  sortKey: MasterSortKey;
  facets: {
    operational: string[];
    courier: string[];
    region: string[];
    province: string[];
    district: string[];
    coverage: string[];
    pickup: string[];
  };
  /** Contado en la base: sobre una página daría números falsos sin avisar. */
  agency: AgencySummary;
  canEdit: boolean;
  canOverride: boolean;
  canCreateGuide: boolean;
  canCreateTandersGuide: boolean;
  canCreateShalomGuide: boolean;
  canDispatch: boolean;
  canWarehouse: boolean;
  closurePermissions: {
    canReturn: boolean;
    canInventory: boolean;
    canFinance: boolean;
    canFinalize: boolean;
    canRefund: boolean;
    canReopen: boolean;
  };
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [navigating, startNav] = useTransition();
  const [showMore, setShowMore] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  // Selección para acciones en lote (hoy: imprimir rótulos).
  //
  // SOBREVIVE A LAS BÚSQUEDAS. La tanda de rótulos del día se arma buscando
  // pedido por pedido, así que vaciarla en cada búsqueda obligaba a imprimir de
  // a uno. Lo que no puede pasar es imprimir a ciegas, y para eso la barra lista
  // los pedidos elegidos con su nombre y permite sacar cualquiera.
  //
  // "Seleccionar todos" sigue alcanzando solo la página visible: el Master
  // pagina en servidor y no expone los ids del filtro completo, así que prometer
  // "todos los 4.000" sería mentir.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const toggleRow = (orderId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(orderId)) next.delete(orderId);
      else next.add(orderId);
      return next;
    });
  };
  const toggleAll = (orderIds: string[], checked: boolean) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      for (const id of orderIds) {
        if (checked) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  };

  /**
   * Cambiar un filtro es reescribir la URL y dejar que el servidor traiga la
   * página. Suena a más trabajo que filtrar en memoria, pero baja ~100 KB en vez
   * de 9,5 MB, así que en la práctica es lo que hace que la pantalla responda.
   *
   * `useTransition` mantiene visible el listado anterior mientras llega el
   * nuevo, en vez de parpadear a vacío en cada clic.
   */
  // Descarga del listado tal y como está filtrado. La URL se arma con el mismo
  // `buildMasterQuery` que usa la navegación, así que el fichero no puede salir
  // con un conjunto distinto del que se está viendo. Sin `page`: se exporta
  // todo lo filtrado, no la página abierta.
  const [exporting, setExporting] = useState(false);
  const [exportNote, setExportNote] = useState<string | null>(null);

  const downloadExcel = async () => {
    if (exporting) return;
    setExporting(true);
    setExportNote(null);
    let objectUrl: string | null = null;
    try {
      // Con casillas marcadas manda la SELECCIÓN, no el filtro: quien marca ya
      // eligió, y bajarle el listado entero sería ignorar lo que acaba de
      // hacer. Va por POST porque la selección se conserva entre páginas y los
      // ids no caben en una URL.
      const qs = buildMasterQuery({ filters, sortKey, page: 1 });
      if (view !== "todos") qs.set("view", view);
      if (substage) qs.set("substage", substage);

      const res = selectedIds.size
        ? await fetch("/api/export/pedidos", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ids: Array.from(selectedIds) }),
          })
        : await fetch(`/api/export/pedidos?${qs.toString()}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const blob = await res.blob();
      objectUrl = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = objectUrl;
      link.download = filenameFromDisposition(res.headers.get("Content-Disposition"));
      document.body.appendChild(link);
      link.click();
      link.remove();

      // El servidor corta por encima de su tope. Callarlo dejaría un fichero
      // incompleto con pinta de completo, que es el peor resultado posible.
      if (res.headers.get("X-Export-Truncated") === "1") {
        const rows = Number(res.headers.get("X-Export-Rows") ?? 0);
        setExportNote(
          `El listado supera el máximo por descarga: se exportaron las primeras ${rows.toLocaleString("es-PE")} filas. Acota los filtros para bajar el resto.`,
        );
      }
    } catch {
      setExportNote("No se pudo generar el Excel. Vuelve a intentarlo.");
    } finally {
      // Revocar de inmediato cancelaría la descarga en Safari, que lee la URL
      // después del click.
      const created = objectUrl;
      if (created) setTimeout(() => URL.revokeObjectURL(created), 60_000);
      setExporting(false);
    }
  };

  const navigate = (next: { filters?: Partial<MasterFilters>; sortKey?: MasterSortKey; page?: number }) => {
    const merged: MasterFilters = { ...filters, ...(next.filters ?? {}) };
    const qs = buildMasterQuery({
      filters: merged,
      sortKey: next.sortKey ?? sortKey,
      // Cualquier cambio de filtro u orden vuelve a la página 1: quedarse en la
      // 7 del resultado anterior es una pantalla en blanco sin explicación.
      page: next.page ?? (next.filters || next.sortKey ? 1 : page),
    });
    if (view !== "todos") qs.set("view", view);
    if (substage) qs.set("substage", substage);
    startNav(() => router.replace(`${pathname}?${qs.toString()}`, { scroll: false }));
  };

  const navigateStage = (stage: MasterView, nextSubstage: MacroSubstage | null = null) => {
    const qs = buildMasterQuery({ filters, sortKey: "created", page: 1 });
    if (stage !== "todos") qs.set("view", stage);
    if (nextSubstage) qs.set("substage", nextSubstage);
    startNav(() => router.replace(`${pathname}?${qs.toString()}`, { scroll: false }));
  };

  const setFilters = (updater: (f: MasterFilters) => MasterFilters) =>
    navigate({ filters: updater(filters) });

  // La búsqueda es un filtro más y la resuelve la base. El estado del input NO
  // vive aquí: está en `MasterSearchInput`, y el motivo es de rendimiento, no
  // de orden. Ver el comentario de ese componente.
  const searching = navigating;
  const commitSearch = (next: string) => navigate({ filters: { search: next } });

  const storeName = useMemo(() => {
    const map = new Map(stores.map((s) => [s.id, s.name]));
    return (id: string) => map.get(id) ?? "—";
  }, [stores]);
  const storeDomain = useMemo(() => {
    const map = new Map(stores.map((s) => [s.id, s.shopify_domain]));
    return (id: string) => map.get(id) ?? null;
  }, [stores]);
  const stageSubstages = view === "todos" ? [] : MACRO_SUBSTAGES_BY_STAGE[view];

  function patch(next: Partial<MasterFilters>) {
    navigate({ filters: next });
  }

  function toggleStore(id: string) {
    const next = new Set(filters.stores);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    navigate({ filters: { stores: next } });
  }

  const searchActive = filters.search.trim().length >= 2;
  // La página llega filtrada y ordenada; aquí ya no se recorta nada.
  const listed = rows;
  const shown = rows;
  // Para poder nombrar los pedidos en el reporte de una acción en lote: la
  // acción devuelve ids, y "#KP125756 falló" es accionable, "un uuid" no.
  // Se acumulan entre páginas: un pedido elegido en otra búsqueda ya no está en
  // `rows`, y la barra tiene que poder nombrarlo. "#KP125756 falló" es
  // accionable; un uuid no.
  const [seenNames, setSeenNames] = useState<Map<string, string>>(new Map());
  useEffect(() => {
    setSeenNames((prev) => {
      const next = new Map(prev);
      let changed = false;
      for (const row of rows) {
        const name = row.order_name ?? row.order_id;
        if (next.get(row.order_id) !== name) {
          next.set(row.order_id, name);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [rows]);
  const orderNames = useMemo(() => {
    const map = new Map(seenNames);
    for (const row of rows) map.set(row.order_id, row.order_name ?? row.order_id);
    return map;
  }, [seenNames, rows]);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-slate-900">Master de Pedidos</h1>
          <p className="text-xs text-slate-500">
            Estado real de cada pedido de las dos tiendas, con su historial completo.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {canWarehouse && (
            <Link
              href="/dashboard/pedidos/almacen"
              className="inline-flex min-h-9 items-center gap-2 rounded-lg border border-slate-300 px-3 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
            >
              <span aria-hidden="true">▣</span>
              Almacén
            </Link>
          )}
          {canDispatch && (
            <Link
              href="/dashboard/pedidos/despacho"
              className="inline-flex min-h-9 items-center gap-2 rounded-lg bg-slate-900 px-3 text-sm font-medium text-white transition hover:bg-slate-700"
            >
              <span aria-hidden="true">▦</span>
              Mesa de despacho
            </Link>
          )}
          <MasterSearchInput value={filters.search} onCommit={commitSearch} />
          {!canEdit && (
            <span className="rounded-lg border border-slate-200 px-2.5 py-1 text-xs text-slate-500">
              Solo lectura
            </span>
          )}
        </div>
      </div>

      {searchActive ? (
        <Card className="w-fit min-w-full p-0">
          <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3">
            <p className="text-sm font-medium text-slate-800">
              Resultados de búsqueda ({total.toLocaleString("es-PE")})
            </p>
            <div className="flex items-center gap-3">
              <PagerControls
                page={page}
                totalPages={totalPages}
                busy={navigating}
                onPage={(p) => navigate({ page: p })}
              />
              <button onClick={() => commitSearch("")} className="text-xs text-slate-500 hover:underline">
                Limpiar búsqueda
              </button>
            </div>
          </div>
          {searching ? (
            <p className="p-5 text-sm text-slate-400">Buscando…</p>
          ) : listed.length ? (
            <>
              <MasterTable
                rows={shown}
                storeName={storeName}
                multiStore={stores.length > 1}
                onOpen={setOpenId}
                selected={selectedIds}
                onToggleRow={toggleRow}
                onToggleAll={toggleAll}
              />
              <Pager
                page={page}
                totalPages={totalPages}
                total={total}
                shown={shown.length}
                busy={navigating}
                onPage={(p) => navigate({ page: p })}
              />
            </>
          ) : (
            <p className="p-5 text-sm text-slate-400">Sin coincidencias.</p>
          )}
        </Card>
      ) : (
        <>
          {agencyHasActivity(agency) && (
            <AgencyStrip
              summary={agency}
              filters={filters}
              onFilter={(next) => patch(next)}
            />
          )}

          <section aria-label="Macroetapas del pedido" className="space-y-2">
            <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white p-1.5 shadow-sm">
              <div className="grid min-w-[1040px] grid-cols-[112px_repeat(6,minmax(148px,1fr))] gap-1">
                {MASTER_VIEWS.map((stage, index) => {
                  const active = stage.key === view;
                  const isAll = stage.key === "todos";
                  return (
                    <button
                      key={stage.key}
                      type="button"
                      aria-current={active ? "page" : undefined}
                      onClick={() => navigateStage(stage.key)}
                      className={cn(
                        "group flex min-h-14 items-center gap-2 rounded-lg px-3 text-left transition",
                        active
                          ? "bg-slate-950 text-white shadow-sm"
                          : "text-slate-600 hover:bg-slate-50 hover:text-slate-950",
                        navigating && "opacity-60",
                      )}
                    >
                      {!isAll && (
                        <span className={cn(
                          "grid h-6 w-6 shrink-0 place-items-center rounded-full text-[10px] font-bold",
                          active ? "bg-white/15 text-white" : "bg-slate-100 text-slate-500",
                        )}>
                          {String(index).padStart(2, "0")}
                        </span>
                      )}
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-semibold">{stage.label}</span>
                        <span className={cn("block text-xs", active ? "text-slate-300" : "text-slate-400")}>
                          {counts[stage.key].toLocaleString("es-PE")} pedidos
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>

            {view !== "todos" && (
              <div className="flex items-center gap-2 overflow-x-auto pb-1">
                <span className="shrink-0 text-[11px] font-bold uppercase tracking-[0.12em] text-slate-400">
                  Subetapas
                </span>
                <button
                  type="button"
                  onClick={() => navigateStage(view)}
                  className={cn(
                    "shrink-0 rounded-full border px-3 py-1 text-xs font-medium transition",
                    substage === null
                      ? "border-slate-950 bg-slate-950 text-white"
                      : "border-slate-200 bg-white text-slate-600 hover:border-slate-300",
                  )}
                >
                  Todas · {counts[view].toLocaleString("es-PE")}
                </button>
                {stageSubstages.map((stageSubstage) => {
                  const count = substageCounts[stageSubstage] ?? 0;
                  return (
                    <button
                      key={stageSubstage}
                      type="button"
                      disabled={count === 0}
                      onClick={() => navigateStage(view, stageSubstage)}
                      className={cn(
                        "shrink-0 rounded-full border px-3 py-1 text-xs font-medium transition",
                        substage === stageSubstage
                          ? "border-brand-600 bg-brand-50 text-brand-700"
                          : "border-slate-200 bg-white text-slate-600 hover:border-slate-300",
                        count === 0 && "cursor-not-allowed opacity-40",
                      )}
                    >
                      {macroSubstageLabel(stageSubstage)} · {count.toLocaleString("es-PE")}
                    </button>
                  );
                })}
              </div>
            )}
          </section>

          {/* Filtros */}
          <div className="flex flex-wrap items-center gap-2">
            {stores.length > 1 && (
              <div className="flex items-center gap-1.5">
                <span className="text-xs text-slate-400">Tienda:</span>
                {stores.map((s) => {
                  const active = filters.stores.size === 0 || filters.stores.has(s.id);
                  return (
                    <button
                      key={s.id}
                      onClick={() => toggleStore(s.id)}
                      className={cn(
                        "rounded-full border px-2.5 py-1 text-xs font-medium transition",
                        active
                          ? "border-brand-200 bg-brand-50 text-brand-700"
                          : "border-slate-200 bg-white text-slate-400",
                      )}
                    >
                      {s.name}
                    </button>
                  );
                })}
              </div>
            )}

            <ChecklistFilter
              label="Estado operativo"
              options={facets.operational}
              selected={filters.operationalStatuses}
              onChange={(operationalStatuses) => patch({ operationalStatuses })}
              capitalize={false}
            />
            <ChecklistFilter
              label="Courier"
              options={facets.courier}
              selected={filters.couriers}
              onChange={(couriers) => patch({ couriers })}
            />
            <ChecklistFilter
              label="Región"
              options={facets.region}
              selected={filters.regions}
              onChange={(regions) => patch({ regions })}
            />
            <ChecklistFilter
              label="Provincia"
              options={facets.province}
              selected={filters.provinces}
              onChange={(provinces) => patch({ provinces })}
            />
            <ChecklistFilter
              label="Distrito"
              options={facets.district}
              selected={filters.districts}
              onChange={(districts) => patch({ districts })}
            />
            <ChecklistFilter
              label="Cobertura"
              options={facets.coverage}
              selected={filters.coverages}
              onChange={(coverages) => patch({ coverages })}
              optionLabel={(value) =>
                ORDER_COVERAGE_LABEL[value as OrderCoverage] ?? value
              }
            />
            {facets.pickup.length > 0 && (
              <ChecklistFilter
                label="Agencia"
                options={facets.pickup}
                selected={filters.pickupStates}
                onChange={(pickupStates) => patch({ pickupStates })}
                capitalize={false}
              />
            )}

            <button
              onClick={() => setShowMore((v) => !v)}
              className="rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50"
            >
              {showMore ? "Menos filtros" : "Más filtros"} ▾
            </button>

            {hasActiveFilters(filters) && (
              <button
                onClick={() => navigate({ filters: emptyFilters() })}
                className="text-xs text-slate-500 hover:underline"
              >
                Limpiar filtros
              </button>
            )}

            <span className="ml-auto text-xs text-slate-400">
              Orden: Fecha de creación · más recientes primero
            </span>
          </div>

          {showMore && (
            <Card className="space-y-3 p-4">
              <div className="grid min-w-0 gap-3 md:grid-cols-2 2xl:grid-cols-4">
                <DateRange
                  label="Creación"
                  from={filters.createdFrom}
                  to={filters.createdTo}
                  onChange={(createdFrom, createdTo) => patch({ createdFrom, createdTo })}
                />
                <DateRange
                  label="Despacho"
                  from={filters.dispatchedFrom}
                  to={filters.dispatchedTo}
                  onChange={(dispatchedFrom, dispatchedTo) => patch({ dispatchedFrom, dispatchedTo })}
                />
                <DateRange
                  label="Último movimiento"
                  from={filters.movementFrom}
                  to={filters.movementTo}
                  onChange={(movementFrom, movementTo) => patch({ movementFrom, movementTo })}
                />
                <DateRange
                  label="Entrega"
                  from={filters.deliveredFrom}
                  to={filters.deliveredTo}
                  onChange={(deliveredFrom, deliveredTo) => patch({ deliveredFrom, deliveredTo })}
                />
              </div>
              <div className="flex flex-wrap items-center gap-3 text-xs text-slate-600">
                <label className="flex items-center gap-1.5">
                  Modalidad:
                  <select
                    value={[...filters.shippingModes][0] ?? ""}
                    onChange={(e) =>
                      patch({ shippingModes: e.target.value ? new Set([e.target.value]) : new Set() })
                    }
                    className="rounded-lg border border-slate-200 px-2 py-1 text-xs"
                  >
                    <option value="">Todas</option>
                    <option value="cod">Contraentrega</option>
                    <option value="agency">Agencia</option>
                  </select>
                </label>
                <Toggle
                  label="Con comentarios"
                  checked={filters.withComments}
                  onChange={(withComments) => patch({ withComments })}
                />
                <Toggle
                  label="Más de un courier"
                  checked={filters.multiCourier}
                  onChange={(multiCourier) => patch({ multiCourier })}
                />
                <Toggle
                  label="Más de un intento"
                  checked={filters.multiAttempt}
                  onChange={(multiAttempt) => patch({ multiAttempt })}
                />
                <label className="flex items-center gap-1.5">
                  Sin movimientos hace:
                  <select
                    value={filters.staleDays}
                    onChange={(e) => patch({ staleDays: Number(e.target.value) })}
                    className="rounded-lg border border-slate-200 px-2 py-1 text-xs"
                  >
                    <option value={0}>—</option>
                    <option value={3}>3 días</option>
                    <option value={7}>7 días</option>
                    <option value={15}>15 días</option>
                    <option value={30}>30 días</option>
                  </select>
                </label>
              </div>
            </Card>
          )}

          <Card className="w-fit min-w-full p-0">
            <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3">
              {/* El contador dice el TOTAL de la macroetapa, no las 100 de la
                  página: "100 pedidos" a secas hacía creer que no había más. */}
              <p className="text-sm font-medium text-slate-800">
                {total.toLocaleString("es-PE")} {total === 1 ? "pedido" : "pedidos"}
                {total > listed.length && (
                  <span className="ml-1 text-xs font-normal text-slate-400">
                    · se muestran {listed.length}
                  </span>
                )}
              </p>
              <div className="flex shrink-0 items-center gap-3">
                <ExportButton
                  busy={exporting}
                  total={total}
                  selected={selectedIds.size}
                  onClick={() => void downloadExcel()}
                />
                <PagerControls
                  page={page}
                  totalPages={totalPages}
                  busy={navigating}
                  onPage={(p) => navigate({ page: p })}
                />
              </div>
            </div>
            {exportNote && (
              <p className="border-b border-amber-200 bg-amber-50 px-5 py-2 text-xs text-amber-800">
                {exportNote}
              </p>
            )}
            {listed.length ? (
              <>
                <MasterTable
                  rows={listed}
                  storeName={storeName}
                  multiStore={stores.length > 1}
                  onOpen={setOpenId}
                  selected={selectedIds}
                  onToggleRow={toggleRow}
                  onToggleAll={toggleAll}
                />
                {/* Las vistas por macroetapa nunca tuvieron paginador: se veían
                    las primeras 100 de miles y no había forma de llegar al
                    resto. El paginador solo existía en la vista de búsqueda. */}
                <Pager
                  page={page}
                  totalPages={totalPages}
                  total={total}
                  shown={listed.length}
                  busy={navigating}
                  onPage={(p) => navigate({ page: p })}
                />
              </>
            ) : (
              <p className="p-5 text-sm text-slate-400">
                {rows.length ? "Ningún pedido cumple los filtros." : "Todavía no hay pedidos aquí."}
              </p>
            )}
          </Card>
        </>
      )}

      {openId && (
        <OrderDrawer
          orderId={openId}
          canEdit={canEdit}
          canOverride={canOverride}
          canCreateGuide={canCreateGuide}
          canCreateTandersGuide={canCreateTandersGuide}
          canCreateShalomGuide={canCreateShalomGuide}
          closurePermissions={closurePermissions}
          storeName={storeName}
          storeDomain={storeDomain}
          onClose={() => setOpenId(null)}
          onSaved={() => router.refresh()}
        />
      )}

      <BulkBar
        selectedIds={selectedIds}
        orderNames={orderNames}
        visibleIds={rows.map((r) => r.order_id)}
        onToggleRow={toggleRow}
        canEdit={canEdit}
        onClear={() => setSelectedIds(new Set())}
        // Solo refresca: limpiar la selección desmontaría la barra y con ella el
        // resumen de lo que acaba de pasar (incluidos los pedidos bloqueados).
        onCreated={() => router.refresh()}
      />
    </div>
  );
}

/**
 * Tira de seguimiento de agencia (§10). Es lo que evita la devolución: entre el
 * 5 % y el 6 % de estos pedidos termina devuelto por no recogerse a tiempo, así
 * que lo accionable es ver cuántos están disponibles y cuántos van a vencer.
 * Cada bloque es un filtro de un clic.
 */
function AgencyStrip({
  summary,
  filters,
  onFilter,
}: {
  summary: AgencySummary;
  filters: MasterFilters;
  onFilter: (next: Partial<MasterFilters>) => void;
}) {
  const disponiblesActive =
    filters.pickupStates.has("disponible_para_recojo") ||
    filters.pickupStates.has("pendiente_de_recojo");
  const retornoActive = filters.pickupStates.has("retorno_iniciado");

  return (
    <Card className="flex flex-wrap items-center gap-4 p-4">
      <div>
        <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
          Envíos por agencia
        </p>
        <p className="text-xs text-slate-400">Shalom · Olva — seguimiento del recojo</p>
      </div>
      {/* EL RECORRIDO EN CURSO, EN ORDEN FÍSICO, EN UNA SOLA LÍNEA.
          Este panel existe para ver lo que está EN CURSO, así que no lleva
          total ni estados terminales: «Entregados» y «Devueltos» son pedidos
          que ya no piden nada y solo diluyen los que sí. El orden es el del
          paquete —sale, viaja, llega, se acerca a vencer, se devuelve— para que
          se lea como un embudo y no como cinco cifras sueltas. */}
      <AgencyStat label="Pendiente de envío" value={summary.pendienteDeEnvio} />
      <AgencyStat label="En tránsito" value={summary.enTransito} />
      <AgencyStat
        label="Disponibles para recojo"
        value={summary.disponibles}
        active={disponiblesActive}
        onClick={() =>
          onFilter({
            pickupStates: disponiblesActive
              ? new Set()
              : new Set(["disponible_para_recojo", "pendiente_de_recojo"]),
            expiringSoon: false,
          })
        }
      />
      <AgencyStat
        label="Próximos a vencer"
        value={summary.proximosAVencer}
        tone={summary.proximosAVencer > 0 ? "warning" : undefined}
        active={filters.expiringSoon}
        onClick={() => onFilter({ expiringSoon: !filters.expiringSoon, pickupStates: new Set() })}
      />
      <AgencyStat
        label="Retorno iniciado"
        value={summary.retornoIniciado}
        tone={summary.retornoIniciado > 0 ? "warning" : undefined}
        active={retornoActive}
        onClick={() =>
          onFilter({
            pickupStates: retornoActive ? new Set() : new Set(["retorno_iniciado"]),
            expiringSoon: false,
          })
        }
      />
    </Card>
  );
}

function AgencyStat({
  label,
  value,
  tone,
  active,
  onClick,
}: {
  label: string;
  value: number;
  tone?: "warning" | "danger";
  active?: boolean;
  onClick?: () => void;
}) {
  const body = (
    <>
      <p
        className={cn(
          "text-xl font-semibold",
          tone === "danger" ? "text-red-700" : tone === "warning" ? "text-amber-700" : "text-slate-900",
        )}
      >
        {value}
      </p>
      <p className="text-xs text-slate-500">{label}</p>
    </>
  );
  if (!onClick) return <div className="min-w-[7rem]">{body}</div>;
  return (
    <button
      onClick={onClick}
      className={cn(
        "min-w-[7rem] rounded-lg px-2 py-1 text-left transition hover:bg-slate-50",
        active && "bg-brand-50 ring-1 ring-brand-200",
      )}
    >
      {body}
    </button>
  );
}

function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-center gap-1.5">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="h-3.5 w-3.5"
      />
      {label}
    </label>
  );
}

function DateRange({
  label,
  from,
  to,
  onChange,
}: {
  label: string;
  from: string;
  to: string;
  onChange: (from: string, to: string) => void;
}) {
  return (
    <fieldset className="min-w-0 space-y-1.5">
      <legend className="text-xs text-slate-500">{label}</legend>
      <div className="grid min-w-0 grid-cols-2 gap-2">
        <label className="min-w-0 space-y-1">
          <span className="block text-[11px] text-slate-400">Desde</span>
          <input
            type="date"
            value={from}
            onChange={(e) => onChange(e.target.value, to)}
            className="block min-w-0 w-full max-w-full rounded-lg border border-slate-200 px-2 py-1.5 text-xs text-slate-700"
          />
        </label>
        <label className="min-w-0 space-y-1">
          <span className="block text-[11px] text-slate-400">Hasta</span>
          <input
            type="date"
            value={to}
            onChange={(e) => onChange(from, e.target.value)}
            className="block min-w-0 w-full max-w-full rounded-lg border border-slate-200 px-2 py-1.5 text-xs text-slate-700"
          />
        </label>
      </div>
    </fieldset>
  );
}

// ---------------------------------------------------------------------------
// Tabla (§14)
// ---------------------------------------------------------------------------

/**
 * Indicador de cobro y clave (§"Información visible en el Master"). La clave EN
 * SÍ nunca aparece en la tabla: solo su estado.
 */
function PaymentIndicator({
  paymentState,
  keyState,
}: {
  paymentState: string | null;
  keyState: string | null;
}) {
  if (!paymentState && !keyState) return <>—</>;
  const pay = paymentState ? (PAYMENT_STATE_LABEL[paymentState as PaymentState] ?? paymentState) : null;
  const key = keyState ? (KEY_STATE_LABEL[keyState as KeyState] ?? keyState) : null;
  const alert = paymentState === "posible_duplicado";
  return (
    <span className={cn("text-xs", alert && "font-semibold text-red-700")} title={key ?? undefined}>
      {pay}
      {key && key !== "Sin clave" ? ` · ${key}` : ""}
    </span>
  );
}

/** Días en agencia, resaltando el vencimiento cercano — el dato accionable. */
function AgencyDays({
  arrivedAt,
  expiresAt,
}: {
  arrivedAt: string | null;
  expiresAt: string | null;
}) {
  const days = daysInAgency(arrivedAt);
  if (days === null && !expiresAt) return <>—</>;
  const left = expiresAt ? Date.parse(expiresAt) - Date.now() : null;
  const soon = left !== null && Number.isFinite(left) && left <= 3 * 86_400_000;
  return (
    <span
      className={cn(soon && "font-semibold text-amber-700")}
      title={expiresAt ? `Vence el ${fmtDate(expiresAt)}` : undefined}
    >
      {days === null ? "—" : days}
    </span>
  );
}

/**
 * Barra de acciones en lote. Aparece solo cuando hay pedidos marcados.
 *
 * Descargar rótulos es una NAVEGACIÓN, no un fetch: el navegador recibe el PDF
 * con `content-disposition: attachment` y lo guarda. Si el endpoint responde un
 * error (por ejemplo, pedidos que aún no tienen salida), esa respuesta es JSON y
 * no se descarga, así que se comprueba antes con una petición corta.
 */
// «Sin definir» va primero y es lo predeterminado: el almacén arma y rotula
// antes de saber con quién sale, y el courier se fija al entrar a la ruta (§4).
const BULK_COURIERS: { key: ManualRouteCourier; label: string }[] = [
  { key: COURIER_TBD, label: "Sin definir (se decide en despacho)" },
  { key: "propio", label: "Motorizado propio" },
  { key: "axel", label: "Axel Courier" },
  { key: "urpi", label: "Urpi" },
  { key: "olva", label: "Olva (agencia)" },
];

/** Descarga el PDF que devuelve el endpoint, o el mensaje de error si no hay rótulos. */
async function downloadRotulos(query: string): Promise<{ error?: string; missing: number }> {
  const response = await fetch(`/api/pedidos/rotulos?${query}`);
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    return { error: body?.error ?? "No se pudieron generar los rótulos.", missing: 0 };
  }
  const missing = Number(response.headers.get("x-rotulos-missing") ?? "0");
  const blob = await response.blob();
  const href = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = href;
  anchor.download =
    response.headers.get("content-disposition")?.match(/filename="([^"]+)"/)?.[1] ?? "rotulos.pdf";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(href);
  return { missing };
}

function BulkBar({
  selectedIds,
  orderNames,
  visibleIds,
  canEdit,
  onClear,
  onToggleRow,
  onCreated,
}: {
  selectedIds: Set<string>;
  orderNames: Map<string, string>;
  /** Ids de la página visible, para avisar de lo elegido que no se ve. */
  visibleIds: string[];
  canEdit: boolean;
  onClear: () => void;
  onToggleRow: (orderId: string) => void;
  onCreated: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [failures, setFailures] = useState<BulkRouteOutputFailure[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [courier, setCourier] = useState<ManualRouteCourier>(COURIER_TBD);
  const [dispatchDate, setDispatchDate] = useState(limaTodayKey());
  const [note, setNote] = useState("");

  const [showPicked, setShowPicked] = useState(false);

  const [showStatus, setShowStatus] = useState(false);
  const [bulkGeneral, setBulkGeneral] = useState<GeneralStatus>("entregado");
  const [bulkOperational, setBulkOperational] = useState("entregado");
  const [bulkReason, setBulkReason] = useState("");
  const [bulkComment, setBulkComment] = useState("");
  const bulkOperationalOptions = operationalStatusesFor(bulkGeneral);
  useEffect(() => {
    // Al cambiar el estado general, el operativo elegido puede dejar de aplicar.
    if (!bulkOperationalOptions.some((o) => o.code === bulkOperational)) {
      setBulkOperational(bulkOperationalOptions[0]?.code ?? "");
    }
  }, [bulkOperationalOptions, bulkOperational]);

  const count = selectedIds.size;
  const onPage = new Set(visibleIds);
  const offscreen = Array.from(selectedIds).filter((id) => !onPage.has(id)).length;
  if (!count) return null;

  const reset = () => {
    setError(null);
    setNotice(null);
    setFailures([]);
  };

  // Pedir el rótulo ES el gesto: si el pedido todavía no tiene salida, se crea
  // aquí (sin courier, se decide en despacho) y si ya tiene una con nosotros, se
  // reimprime esa. El operador no tiene que saber que existe el concepto
  // "salida" para imprimir la tanda del día.
  const download = async () => {
    setBusy(true);
    reset();
    try {
      const resolved = await resolveLabelsForOrders(Array.from(selectedIds));
      setFailures(resolved.blocked.map((b) => ({ orderId: b.orderId, error: b.error })));
      if (!resolved.shipmentIds.length) {
        setError(resolved.error ?? "No hay rótulos que imprimir.");
        return;
      }
      const pdf = await downloadRotulos(`ids=${resolved.shipmentIds.join(",")}`);
      if (pdf.error) {
        setError(pdf.error);
        return;
      }
      setNotice(
        [resolved.notice, "Rótulos descargados."].filter(Boolean).join(" · "),
      );
      if (resolved.created > 0) onCreated();
    } catch {
      setError("No se pudieron generar los rótulos.");
    } finally {
      setBusy(false);
    }
  };

  // Crear salidas y, si salió alguna, bajar sus rótulos en el mismo gesto: es el
  // flujo real del almacén (elegir la tanda, generarla, imprimirla).
  const createOutputs = async () => {
    setBusy(true);
    reset();
    try {
      const result = await createManualRouteOutputsBulk(Array.from(selectedIds), {
        courier,
        dispatchDate,
        note: note.trim() || undefined,
      });
      setFailures(result.failed);
      if (result.error && !result.created.length) {
        setError(result.error);
        return;
      }
      let message = result.notice ?? "";
      if (result.created.length) {
        const pdf = await downloadRotulos(
          `ids=${result.created.map((c) => c.shipmentId).join(",")}`,
        );
        message += pdf.error ? ` No se pudo bajar el PDF: ${pdf.error}` : " Rótulos descargados.";
      }
      setNotice(message.trim());
      setShowCreate(false);
      onCreated();
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudieron crear las salidas.");
    } finally {
      setBusy(false);
    }
  };

  // Cerrar de una tanda lo que ya se entregó y cobró. El gesto es el mismo de
  // «Gestión manual» del drawer; lo único que cambia es que se aplica a la
  // selección en vez de a un pedido.
  const applyStatus = async () => {
    setBusy(true);
    reset();
    try {
      const result = await applyOrderStatusBulk(Array.from(selectedIds), {
        general: bulkGeneral,
        operational: bulkOperational,
        reason: bulkReason.trim() || undefined,
        comment: bulkComment.trim() || undefined,
      });
      setFailures(result.failed);
      if (result.error && !result.applied.length) {
        setError(result.error);
        return;
      }
      setNotice(result.notice ?? "");
      setShowStatus(false);
      setBulkReason("");
      setBulkComment("");
      onCreated();
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo aplicar el estado.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="sticky bottom-4 z-30 mx-auto flex w-fit max-w-full flex-col gap-2 rounded-2xl border border-slate-700 bg-slate-950 px-4 py-3 text-white shadow-xl">
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-sm font-semibold">
          {count} {count === 1 ? "pedido seleccionado" : "pedidos seleccionados"}
        </span>
        <button
          onClick={download}
          disabled={busy}
          className="rounded-lg bg-white px-3 py-1.5 text-sm font-semibold text-slate-950 hover:bg-slate-100 disabled:opacity-50"
        >
          {busy ? "Trabajando…" : "Descargar rótulos (PDF)"}
        </button>
        {canEdit && (
          <button
            onClick={() => {
              reset();
              setShowCreate((v) => !v);
            }}
            disabled={busy}
            className="rounded-lg border border-slate-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-slate-800 disabled:opacity-50"
          >
            {showCreate ? "Cancelar" : "Forzar courier…"}
          </button>
        )}
        {canEdit && (
          <button
            onClick={() => {
              reset();
              setShowStatus((v) => !v);
            }}
            disabled={busy}
            className="rounded-lg border border-slate-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-slate-800 disabled:opacity-50"
          >
            {showStatus ? "Cancelar" : "Registrar estado…"}
          </button>
        )}
        <button
          onClick={() => setShowPicked((v) => !v)}
          className="text-xs text-slate-300 hover:underline"
        >
          {showPicked ? "Ocultar" : "Ver"} selección
        </button>
        <button onClick={onClear} className="text-xs text-slate-300 hover:underline">
          Limpiar
        </button>
      </div>

      {/* La selección sobrevive a las búsquedas, así que casi siempre habrá
          pedidos elegidos que no están en pantalla. Poder verlos y sacar
          cualquiera es lo que impide imprimir una tanda a ciegas. */}
      {offscreen > 0 && !showPicked && (
        <p className="text-[11px] text-slate-400">
          {offscreen} de los seleccionados {offscreen === 1 ? "no está" : "no están"} en esta
          búsqueda. Siguen contando para el PDF.
        </p>
      )}
      {showPicked && (
        <div className="flex flex-wrap gap-1.5 border-t border-slate-700 pt-2">
          {Array.from(selectedIds).map((orderId) => (
            <button
              key={orderId}
              onClick={() => onToggleRow(orderId)}
              title="Quitar de la selección"
              className="inline-flex items-center gap-1.5 rounded-full bg-slate-800 px-2.5 py-1 text-[11px] font-medium text-white hover:bg-slate-700"
            >
              {orderNames.get(orderId) ?? orderId}
              <span aria-hidden className="text-slate-400">×</span>
            </button>
          ))}
        </div>
      )}

      {showCreate && (
        <div className="flex flex-wrap items-end gap-2 border-t border-slate-700 pt-2">
          <p className="w-full text-[11px] text-slate-400">
            Normalmente no hace falta: «Descargar rótulos» ya crea la salida y el courier se fija
            en despacho. Usa esto para forzar un courier concreto (Olva valida su adelanto) o para
            crear una salida adicional con motivo.
          </p>
          <label className="text-[11px] text-slate-300">
            Courier
            <select
              value={courier}
              onChange={(e) => setCourier(e.target.value as ManualRouteCourier)}
              className="mt-0.5 block rounded-lg border border-slate-600 bg-slate-900 px-2 py-1.5 text-sm text-white"
            >
              {BULK_COURIERS.map((c) => (
                <option key={c.key} value={c.key}>
                  {c.label}
                </option>
              ))}
            </select>
          </label>
          <label className="text-[11px] text-slate-300">
            Sale el
            <input
              type="date"
              value={dispatchDate}
              onChange={(e) => setDispatchDate(e.target.value)}
              className="mt-0.5 block rounded-lg border border-slate-600 bg-slate-900 px-2 py-1.5 text-sm text-white"
            />
          </label>
          <label className="text-[11px] text-slate-300">
            Motivo (si el pedido ya tiene una salida activa)
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Opcional"
              className="mt-0.5 block w-56 rounded-lg border border-slate-600 bg-slate-900 px-2 py-1.5 text-sm text-white"
            />
          </label>
          <button
            onClick={createOutputs}
            disabled={busy}
            className="rounded-lg bg-white px-3 py-1.5 text-sm font-semibold text-slate-950 hover:bg-slate-100 disabled:opacity-50"
          >
            {busy ? "Creando…" : `Crear ${count} salida${count === 1 ? "" : "s"} e imprimir`}
          </button>
        </div>
      )}

      {showStatus && (
        <div className="flex flex-wrap items-end gap-2 border-t border-slate-700 pt-2">
          {/* El aviso no es decorativo: un override CONGELA el pedido frente al
              recálculo. Aplicado a cincuenta de golpe, cincuenta pedidos dejan
              de seguir a su guía, y quien lo hace tiene que saberlo ANTES. */}
          <p className="w-full max-w-xl text-[11px] leading-4 text-amber-300">
            Queda como cambio manual y <strong>congela</strong> el pedido: deja de seguir a su guía
            hasta que alguien lo vuelva a mover a mano. Úsalo en pedidos ya cerrados, no en los que
            siguen en movimiento.
          </p>
          <label className="text-[11px] text-slate-300">
            Estado
            <select
              value={bulkGeneral}
              onChange={(e) => setBulkGeneral(e.target.value as GeneralStatus)}
              className="mt-0.5 block rounded-lg border border-slate-600 bg-slate-900 px-2 py-1.5 text-sm text-white"
            >
              {GENERAL_STATUSES.map((s) => (
                <option key={s.code} value={s.code}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>
          <label className="text-[11px] text-slate-300">
            Detalle
            <select
              value={bulkOperational}
              onChange={(e) => setBulkOperational(e.target.value)}
              className="mt-0.5 block rounded-lg border border-slate-600 bg-slate-900 px-2 py-1.5 text-sm text-white"
            >
              {bulkOperationalOptions.map((o) => (
                <option key={o.code} value={o.code}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <label className="text-[11px] text-slate-300">
            Motivo (obligatorio si el pedido ya estaba cerrado)
            <input
              value={bulkReason}
              onChange={(e) => setBulkReason(e.target.value)}
              placeholder="Opcional"
              className="mt-0.5 block w-56 rounded-lg border border-slate-600 bg-slate-900 px-2 py-1.5 text-sm text-white"
            />
          </label>
          <label className="text-[11px] text-slate-300">
            Comentario
            <input
              value={bulkComment}
              onChange={(e) => setBulkComment(e.target.value)}
              placeholder="PAGADO"
              className="mt-0.5 block w-44 rounded-lg border border-slate-600 bg-slate-900 px-2 py-1.5 text-sm text-white"
            />
          </label>
          <button
            onClick={applyStatus}
            disabled={busy}
            className="rounded-lg bg-white px-3 py-1.5 text-sm font-semibold text-slate-950 hover:bg-slate-100 disabled:opacity-50"
          >
            {busy
              ? "Aplicando…"
              : `Aplicar a ${count} pedido${count === 1 ? "" : "s"}`}
          </button>
        </div>
      )}

      {error && <p className="max-w-lg text-xs text-red-300">{error}</p>}
      {notice && <p className="max-w-lg text-xs text-emerald-300">{notice}</p>}
      {failures.length > 0 && (
        <details className="max-w-lg text-xs text-amber-300">
          <summary className="cursor-pointer">
            {failures.length} pedido{failures.length === 1 ? "" : "s"} con problemas — ver por qué
          </summary>
          <ul className="mt-1 space-y-0.5">
            {failures.map((f) => (
              <li key={f.orderId}>
                <span className="font-medium">{orderNames.get(f.orderId) ?? f.orderId}</span>:{" "}
                {f.error}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function MasterTable({
  rows,
  storeName,
  multiStore,
  onOpen,
  selected,
  onToggleRow,
  onToggleAll,
}: {
  rows: OrderMasterRow[];
  storeName: (id: string) => string;
  multiStore: boolean;
  onOpen: (orderId: string) => void;
  selected: Set<string>;
  onToggleRow: (orderId: string) => void;
  onToggleAll: (orderIds: string[], checked: boolean) => void;
}) {
  const pageIds = rows.map((r) => r.order_id);
  const allChecked = pageIds.length > 0 && pageIds.every((id) => selected.has(id));

  // Columnas congeladas: la tabla sigue siendo más ancha que la pantalla,
  // así que al ir a la derecha se perdía de vista de QUÉ pedido es cada fila.
  // Estas se quedan pegadas a la izquierda.
  //
  // Necesitan ancho fijo porque el desplazamiento de cada una es la suma de las
  // anteriores: con anchos automáticos los offsets no cuadrarían y las columnas
  // se superpondrían. Se calculan acá (y no como clases) porque "Tienda" solo
  // existe en multitienda y correría todo lo que viene después.
  const FROZEN_W = { check: 40, pedido: 132, tienda: 96, creado: 88, cliente: 190 };
  const left: Record<string, number> = {};
  {
    let x = 0;
    for (const k of ["check", "pedido", ...(multiStore ? ["tienda"] : []), "creado", "cliente"]) {
      left[k] = x;
      x += FROZEN_W[k as keyof typeof FROZEN_W];
    }
  }
  /** Props de una celda congelada. El fondo se HEREDA de la fila: así sigue el
   *  hover y el resaltado de selección, que en un color fijo se perderían. */
  //
  // Las capas salen de TABLE_LAYER, no de números sueltos: la esquina congelada
  // estaba en 30, empatada con los desplegables de filtro, y los tapaba — pero
  // solo los de la izquierda, que son los que caen encima de ella.
  const frozen = (key: keyof typeof FROZEN_W, header = false) => ({
    className: cn("sticky", header ? "bg-slate-50" : "bg-inherit"),
    style: {
      left: left[key],
      width: FROZEN_W[key],
      minWidth: FROZEN_W[key],
      zIndex: header ? TABLE_LAYER.frozenHead : TABLE_LAYER.frozenCell,
    },
  });

  return (
    <div className={TABLE_WRAP_PAGE_X}>
      <table className="w-full min-w-[1180px] text-sm">
        <thead className={STICKY_HEAD}>
          <tr className="text-left text-xs text-slate-500">
            <th {...frozen("check", true)} className={cn(frozen("check", true).className, "px-2 py-2")}>
              <input
                type="checkbox"
                checked={allChecked}
                onChange={(e) => onToggleAll(pageIds, e.target.checked)}
                aria-label="Seleccionar todos los pedidos de esta página"
                className="h-4 w-4 cursor-pointer align-middle"
              />
            </th>
            <th {...frozen("pedido", true)} className={cn(frozen("pedido", true).className, "px-4 py-2 font-medium")}>Pedido</th>
            {multiStore && <th {...frozen("tienda", true)} className={cn(frozen("tienda", true).className, "px-2 py-2 font-medium")}>Tienda</th>}
            <th {...frozen("creado", true)} className={cn(frozen("creado", true).className, "px-2 py-2 font-medium")}>Creado</th>
            <th {...frozen("cliente", true)} className={cn(frozen("cliente", true).className, "px-2 py-2 font-medium")}>Cliente</th>
            <th className="px-2 py-2 font-medium">Teléfono</th>
            <th className="px-2 py-2 font-medium">Región</th>
            <th className="px-2 py-2 font-medium">Provincia</th>
            <th className="px-2 py-2 font-medium">Distrito</th>
            <th className="px-2 py-2 font-medium">Cobertura</th>
            <th className="px-2 py-2 font-medium">Último courier</th>
            <th className="px-2 py-2 text-right font-medium" title="Couriers que gestionaron el pedido">
              Cour.
            </th>
            <th className="px-2 py-2 text-right font-medium" title="Intentos de entrega">
              Int.
            </th>
            <th className="px-2 py-2 font-medium">Macroetapa</th>
            <th className="px-2 py-2 font-medium">Subetapa</th>
            <th className="px-2 py-2 font-medium">Últ. movimiento</th>
            <th className="px-4 py-2 font-medium">Antigüedad</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr
              key={r.id}
              onClick={() => onOpen(r.order_id)}
              className={cn(
                "cursor-pointer border-b border-slate-100 last:border-0 hover:bg-slate-50",
                // La fila necesita fondo propio: las celdas congeladas lo
                // HEREDAN, y sin él se transparentarían dejando ver el
                // contenido que pasa por debajo. Excluyente con el resaltado de
                // selección: dos clases de fondo a la vez y no manda el orden
                // del atributo sino el del CSS, así que el resaltado podría
                // perder contra el blanco.
                selected.has(r.order_id) ? "bg-brand-50/60" : "bg-white",
              )}
            >
              {/* stopPropagation: marcar la fila no debe abrir el drawer. */}
              <td {...frozen("check")} className={cn(frozen("check").className, "px-2 py-2.5")} onClick={(e) => e.stopPropagation()}>
                <input
                  type="checkbox"
                  checked={selected.has(r.order_id)}
                  onChange={() => onToggleRow(r.order_id)}
                  aria-label={`Seleccionar ${r.order_name ?? "pedido"}`}
                  className="h-4 w-4 cursor-pointer align-middle"
                />
              </td>
              <td {...frozen("pedido")} className={cn(frozen("pedido").className, "px-4 py-2.5 font-medium text-slate-900")}>{r.order_name ?? "—"}</td>
              {multiStore && <td {...frozen("tienda")} className={cn(frozen("tienda").className, "px-2 py-2.5 text-slate-600")}>{storeName(r.store_id)}</td>}
              <td {...frozen("creado")} className={cn(frozen("creado").className, "px-2 py-2.5 text-slate-600")}>{fmtDate(r.order_created_at)}</td>
              <td {...frozen("cliente")} className={cn(frozen("cliente").className, "truncate px-2 py-2.5 text-slate-700")} title={r.customer_name ?? ""}>
                {r.customer_name ?? "—"}
              </td>
              <td className="px-2 py-2.5 text-slate-600">{r.customer_phone ?? "—"}</td>
              <td className="px-2 py-2.5 text-slate-600">{r.region ?? "—"}</td>
              <td className="px-2 py-2.5 text-slate-600">{r.province ?? "—"}</td>
              <td className="px-2 py-2.5 text-slate-600">{r.district ?? "—"}</td>
              <td className="px-2 py-2.5"><CoverageBadge coverage={r.coverage} /></td>
              <td className="px-2 py-2.5 capitalize text-slate-500">{r.last_courier ?? "—"}</td>
              <td className="px-2 py-2.5 text-right text-slate-700">
                <span className={cn(r.courier_count > 1 && "font-semibold text-amber-700")}>
                  {r.courier_count}
                </span>
              </td>
              <td className="px-2 py-2.5 text-right text-slate-700">
                <span className={cn(r.attempt_count > 1 && "font-semibold text-amber-700")}>
                  {r.attempt_count}
                </span>
              </td>
              <td className="px-2 py-2.5">
                <MacroStageBadge stage={r.macro_stage} />
              </td>
              <td className="px-2 py-2.5 text-slate-600">{macroSubstageLabel(r.macro_substage)}</td>
              <td className="px-2 py-2.5 text-slate-600">{fmtDate(r.last_movement_at)}</td>
              <td className="px-4 py-2.5 text-slate-600">{fmtAge(r.macro_since ?? r.status_since)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Detalle + línea de tiempo (§15)
// ---------------------------------------------------------------------------

const TIMELINE_LABEL: Record<string, string> = {
  created: "Pedido creado",
  confirmed: "Pedido confirmado",
  cancelled_shopify: "Anulado en Shopify",
  courier_assigned: "Courier asignado",
  guide_registered: "Guía registrada",
  route_output_created: "Salida y rótulo creados",
  dispatched: "Pedido despachado",
  out_for_delivery: "Salida a reparto",
  attempt_failed: "Intento fallido",
  comment: "Comentario",
  confirmation_contact: "Intento de confirmación",
  confirmation_followup: "Próximo contacto pactado",
  reschedule: "Reprogramación",
  reroute: "Reprogramación",
  courier_change: "Cambio de courier",
  delivered: "Entrega confirmada",
  return_started: "Retorno iniciado",
  return_requested: "Retorno solicitado",
  return_received: "Devolución recibida en almacén",
  returned: "Pedido devuelto",
  inventory_reconciled: "Producto reingresado a inventario",
  merma_closed: "Merma cerrada",
  liquidation_observed: "Liquidación observada",
  liquidation_closed: "Liquidación conciliada",
  indemnity_requested: "Indemnización solicitada",
  indemnity_resolved: "Indemnización resuelta",
  refund_requested: "Reembolso solicitado",
  refund_completed: "Reembolso confirmado",
  customer_return_started: "Devolución del cliente abierta",
  customer_return_resolved: "Devolución del cliente resuelta",
  order_finalized: "Expediente finalizado",
  order_reopened: "Expediente reabierto",
  status_override: "Estado cambiado manualmente",
  import: "Reporte importado",
  call: "Gestión con el cliente",
  state_change: "Cambio de estado",
  note: "Nota",
  system: "Automático",
};

type DrawerSectionId =
  | "resumen"
  | "confirmacion"
  | "ubicacion"
  | "productos"
  | "pagos"
  | "rutas"
  | "aliclik"
  | "guias"
  | "cierre"
  | "acciones"
  | "historial";

type DrawerWorkspaceView = "operar" | "informacion" | "actividad";

interface DrawerNextAction {
  eyebrow: string;
  title: string;
  description: string;
  cta: string;
  target?: DrawerSectionId;
  href?: string;
  tone: "indigo" | "amber" | "emerald" | "slate";
}

const DRAWER_STAGE_ORDER = MASTER_VIEWS.filter(
  (view): view is { key: OrderMacroStage; label: string } => view.key !== "todos",
);

const DRAWER_STAGE_ACCENT: Record<string, string> = {
  por_confirmar: "border-amber-500 bg-amber-500 text-white",
  preparacion: "border-sky-600 bg-sky-600 text-white",
  por_despachar: "border-indigo-600 bg-indigo-600 text-white",
  en_curso: "border-cyan-700 bg-cyan-700 text-white",
  por_cerrar: "border-orange-600 bg-orange-600 text-white",
  finalizado: "border-emerald-700 bg-emerald-700 text-white",
};

function workspaceForSection(section: DrawerSectionId): DrawerWorkspaceView {
  if (section === "ubicacion" || section === "productos") return "informacion";
  if (section === "historial") return "actividad";
  return "operar";
}

const NEXT_ACTION_TONE: Record<DrawerNextAction["tone"], string> = {
  indigo: "border-indigo-200 bg-indigo-50 text-indigo-950",
  amber: "border-amber-200 bg-amber-50 text-amber-950",
  emerald: "border-emerald-200 bg-emerald-50 text-emerald-950",
  slate: "border-slate-200 bg-slate-50 text-slate-950",
};

/**
 * La acción dominante del drawer sigue el MOM, no el orden accidental de los
 * formularios. Debe responder una sola pregunta: «¿qué hago ahora con este
 * pedido?». Las herramientas secundarias quedan más abajo como evidencia o
 * corrección.
 */
function drawerNextAction(row: OrderMasterRow, showPayments: boolean): DrawerNextAction {
  const stage = row.macro_stage as OrderMacroStage | null | undefined;
  const substage = row.macro_substage as MacroSubstage | null | undefined;

  if (stage === "por_confirmar") {
    // El abono pendiente ya no es una subetapa sino un motivo: manda sobre la
    // llamada porque sin él la confirmación no vale, pero deja al pedido
    // visible en la subetapa que de verdad describe su gestión.
    if ((row.macro_reasons ?? []).includes("pago_requerido_pendiente") && showPayments) {
      return {
        eyebrow: "Confirmación · pago requerido",
        title: "Validar el pago solicitado",
        description: "Registra y valida el comprobante antes de liberar la preparación del pedido.",
        cta: "Ir a pagos",
        target: "pagos",
        tone: "amber",
      };
    }
    if (substage === "ultimo_intento") {
      return {
        eyebrow: "Confirmación · último intento",
        title: "Se agotaron los siete días de gestión",
        description:
          "Resuelve el pedido: si no hay confirmación, la anulación se crea a mano en Shopify. Kapta nunca anula por su cuenta.",
        cta: "Ver la gestión",
        target: "confirmacion",
        tone: "amber",
      };
    }
    return {
      eyebrow: "Confirmación",
      title:
        substage === "volver_a_contactar"
          ? "Retomar el contacto pactado"
          : "Contactar y registrar el intento",
      description: "Llama o escribe al cliente y deja el resultado en la gestión de confirmación.",
      cta: "Registrar intento",
      target: "confirmacion",
      tone: "indigo",
    };
  }

  if (stage === "preparacion") {
    if (substage === "incidencia_preparacion") {
      return {
        eyebrow: "Preparación · incidencia",
        title: "Resolver el bloqueo de almacén",
        description: "Corrige el dato o documenta la incidencia antes de volver a imprimir y armar.",
        cta: "Registrar resolución",
        target: "acciones",
        tone: "amber",
      };
    }
    return {
      eyebrow: "Preparación",
      title: substage === "por_armar" ? "Completar el armado y escanear el rótulo" : "Elegir ruta y generar el rótulo",
      description:
        substage === "por_armar"
          ? "El paquete debe quedar completo y listo antes de incorporarlo a una ruta."
          : "La ruta define qué rótulo se genera y qué validaciones debe cumplir el pedido.",
      cta: substage === "por_armar" ? "Ir al Almacén" : "Revisar rutas",
      ...(substage === "por_armar"
        ? { href: "/dashboard/pedidos/almacen" }
        : { target: "rutas" as const }),
      tone: "indigo",
    };
  }

  if (stage === "por_despachar") {
    return {
      eyebrow: "Despacho",
      title: "Cotejar la ruta y transferir la custodia",
      description: "Oficina y motorizado deben escanear el 100 % de los paquetes antes de salir.",
      cta: "Abrir Mesa de despacho",
      href: "/dashboard/pedidos/despacho",
      tone: "indigo",
    };
  }

  if (stage === "en_curso") {
    if (substage === "pendiente_pago_diferencia" && showPayments) {
      return {
        eyebrow: "Agencia · pago pendiente",
        title: "Completar el pago antes de liberar la clave",
        description: "La clave de recojo permanece bloqueada hasta validar el monto total acumulado.",
        cta: "Revisar pagos",
        target: "pagos",
        tone: "amber",
      };
    }
    if (substage === "por_reprogramar_lima" || substage === "gestion_reproprovincia") {
      return {
        eyebrow: "Seguimiento",
        title: "Volver a confirmar con el cliente",
        description: "Registra el contacto antes de crear una salida nueva con su propio QR.",
        cta: "Registrar seguimiento",
        target: "acciones",
        tone: "amber",
      };
    }
    return {
      eyebrow: "Seguimiento",
      title: "Revisar la salida activa",
      description: "Confirma el último estado del courier y atiende cualquier intento o retorno pendiente.",
      cta: "Ver salidas y guías",
      target: "guias",
      tone: "emerald",
    };
  }

  if (stage === "por_cerrar") {
    return {
      eyebrow: "Cierre",
      title: "Resolver las obligaciones abiertas",
      description: "Liquidación, devolución, inventario y reembolso se cierran como hechos independientes.",
      cta: "Abrir Mesa de cierre",
      target: "cierre",
      tone: "amber",
    };
  }

  return {
    eyebrow: "Expediente finalizado",
    title: "Pedido cerrado sin acciones pendientes",
    description: "Consulta la trazabilidad completa o reabre únicamente si aparece una incidencia nueva.",
    cta: "Ver historial",
    target: "historial",
    tone: "slate",
  };
}

function DrawerJourneyRail({ current }: { current: string | null | undefined }) {
  const currentIndex = DRAWER_STAGE_ORDER.findIndex((stage) => stage.key === current);
  return (
    <ol className="grid grid-cols-6" aria-label="Avance del pedido en el MOM">
      {DRAWER_STAGE_ORDER.map((stage, index) => {
        const isCurrent = index === currentIndex;
        const isDone = currentIndex >= 0 && index < currentIndex;
        return (
          <li key={stage.key} className="relative min-w-0 px-1 first:pl-0 last:pr-0">
            {index > 0 && (
              <span
                aria-hidden="true"
                className={cn(
                  "absolute left-0 right-1/2 top-3 h-px -translate-y-1/2",
                  isDone || isCurrent ? "bg-emerald-300" : "bg-slate-200",
                )}
              />
            )}
            {index < DRAWER_STAGE_ORDER.length - 1 && (
              <span
                aria-hidden="true"
                className={cn(
                  "absolute left-1/2 right-0 top-3 h-px -translate-y-1/2",
                  isDone ? "bg-emerald-300" : "bg-slate-200",
                )}
              />
            )}
            <div className="relative flex min-w-0 flex-col items-center text-center" aria-current={isCurrent ? "step" : undefined}>
              <span
                className={cn(
                  "relative z-[1] grid h-6 w-6 place-items-center rounded-full border text-[10px] font-bold tabular-nums",
                  isCurrent && (DRAWER_STAGE_ACCENT[stage.key] ?? "border-slate-700 bg-slate-700 text-white"),
                  isDone && "border-emerald-500 bg-emerald-500 text-white",
                  !isCurrent && !isDone && "border-slate-200 bg-white text-slate-400",
                )}
              >
                {isDone ? "✓" : index + 1}
              </span>
              <span
                className={cn(
                  "mt-1.5 max-w-[6.5rem] text-[10px] font-semibold leading-tight",
                  isCurrent ? "text-slate-900" : isDone ? "text-emerald-700" : "text-slate-400",
                )}
              >
                {stage.label}
              </span>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function DrawerNextActionCard({
  action,
  onJump,
}: {
  action: DrawerNextAction;
  onJump: (target: DrawerSectionId) => void;
}) {
  const buttonClass = cn(
    "inline-flex min-h-9 items-center justify-center rounded-lg px-3 py-2 text-xs font-bold transition focus:outline-none focus:ring-2 focus:ring-offset-2",
    action.tone === "indigo" && "bg-indigo-700 text-white hover:bg-indigo-800 focus:ring-indigo-600",
    action.tone === "amber" && "bg-amber-800 text-white hover:bg-amber-900 focus:ring-amber-700",
    action.tone === "emerald" && "bg-emerald-800 text-white hover:bg-emerald-900 focus:ring-emerald-700",
    action.tone === "slate" && "bg-slate-900 text-white hover:bg-slate-800 focus:ring-slate-700",
  );

  return (
    <section className={cn("rounded-xl border p-4", NEXT_ACTION_TONE[action.tone])}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <p className="text-[11px] font-bold uppercase tracking-[0.14em] opacity-65">
            Próxima acción · {action.eyebrow}
          </p>
          <h3 className="mt-1 text-base font-semibold leading-tight">{action.title}</h3>
          <p className="mt-1 max-w-xl text-sm leading-5 opacity-75">{action.description}</p>
        </div>
        {action.href ? (
          <Link href={action.href} className={cn(buttonClass, "shrink-0")}>
            {action.cta} →
          </Link>
        ) : action.target ? (
          <button
            type="button"
            onClick={() => onJump(action.target!)}
            className={cn(buttonClass, "shrink-0")}
          >
            {action.cta} ↓
          </button>
        ) : null}
      </div>
    </section>
  );
}

function OrderDrawer({
  orderId,
  canEdit,
  canOverride,
  canCreateGuide,
  canCreateTandersGuide,
  canCreateShalomGuide,
  closurePermissions,
  storeName,
  storeDomain,
  onClose,
  onSaved,
}: {
  orderId: string;
  canEdit: boolean;
  canOverride: boolean;
  canCreateGuide: boolean;
  canCreateTandersGuide: boolean;
  canCreateShalomGuide: boolean;
  closurePermissions: {
    canReturn: boolean;
    canInventory: boolean;
    canFinance: boolean;
    canFinalize: boolean;
    canRefund: boolean;
    canReopen: boolean;
  };
  storeName: (id: string) => string;
  storeDomain: (id: string) => string | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [detail, setDetail] = useState<OrderMasterDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [workspace, setWorkspace] = useState<DrawerWorkspaceView>("operar");
  const scrollRef = useRef<HTMLElement>(null);

  /**
   * Cambia primero al espacio que contiene la herramienta y después la enfoca.
   * Antes todos los formularios vivían en una sola columna y los atajos solo
   * desplazaban cientos de píxeles: técnicamente funcionaba, pero el equipo no
   * sabía en qué "modo" del pedido estaba trabajando.
   */
  const jumpTo = (id: DrawerSectionId) => {
    setWorkspace(workspaceForSection(id));
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        scrollRef.current
          ?.querySelector(`[data-drawer-section="${id}"]`)
          ?.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    });
  };

  function openWorkspace(next: DrawerWorkspaceView) {
    setWorkspace(next);
    requestAnimationFrame(() => scrollRef.current?.scrollTo({ top: 0, behavior: "smooth" }));
  }

  // Escape cierra, y el fondo deja de scrollear mientras el panel está abierto:
  // sin esto, rodar dentro del drawer arrastraba el listado de atrás y al cerrar
  // habías perdido tu sitio en la tabla.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previous;
    };
  }, [onClose]);
  const [notice, setNotice] = useState<string | null>(null);
  const [tandersOpen, setTandersOpen] = useState(false);
  const [shalomOpen, setShalomOpen] = useState(false);
  const [swaypOpen, setSwaypOpen] = useState(false);
  const [manualRoute, setManualRoute] = useState<RouteCandidate | null>(null);
  const [pending, startTransition] = useTransition();

  const reload = useMemo(
    () => async () => {
      const res = await loadOrderDetail(orderId);
      if ("error" in res) setError(res.error);
      else {
        setDetail(res.detail);
        setError(null);
      }
    },
    [orderId],
  );

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    setWorkspace("operar");
    scrollRef.current?.scrollTo({ top: 0 });
  }, [orderId]);

  function run(action: () => Promise<{ error?: string; notice?: string }>): Promise<boolean> {
    return new Promise((resolve) => {
      startTransition(async () => {
        try {
          const res = await action();
          setError(res.error ?? null);
          setNotice(res.notice ?? null);
          if (!res.error) {
            await reload();
            onSaved();
            resolve(true);
            return;
          }
          resolve(false);
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : "No se pudo completar la acción.");
          setNotice(null);
          resolve(false);
        }
      });
    });
  }

  function routeEnabled(route: RouteCandidate): boolean {
    if (route.action === "aliclik") return canCreateGuide;
    if (route.action === "shalom") return canCreateShalomGuide;
    if (route.action === "tanders") return canCreateTandersGuide;
    return canEdit;
  }

  function selectRoute(route: RouteCandidate) {
    if (route.action === "aliclik") {
      jumpTo("aliclik");
      return;
    }
    if (route.action === "shalom") {
      setShalomOpen(true);
      return;
    }
    if (route.action === "tanders") {
      setTandersOpen(true);
      return;
    }
    if (route.action === "swayp") {
      setSwaypOpen(true);
      return;
    }
    setManualRoute(route);
  }

  const row = detail?.row;
  const shopifyUrl = row
    ? shopifyOrderAdminUrl(storeDomain(row.store_id), row.shopify_order_id)
    : null;

  // La ficha del §8 se carga aparte del detalle —recorre el historial del
  // teléfono y la matriz de tarifas— y SOLO en confirmación, que es donde la
  // sección se aplica. Cargarla en cada apertura pondría una consulta más sobre
  // pedidos ya entregados, donde no cambia ninguna decisión.
  const inConfirmation = detail?.row.macro_stage === "por_confirmar";
  const [brief, setBrief] = useState<OrderConfirmationBrief | null>(null);
  useEffect(() => {
    if (!inConfirmation) {
      setBrief(null);
      return;
    }
    let alive = true;
    void loadConfirmationBrief(orderId).then((res) => {
      if (alive && "brief" in res) setBrief(res.brief);
    });
    return () => {
      alive = false;
    };
  }, [orderId, inConfirmation]);
  // El plan de rutas es quien sabe si Aliclik atiende a este pedido. Se lee de
  // ahí, no se vuelve a decidir: una segunda regla equivalente es una regla que
  // tarde o temprano deja de coincidir con la primera. `blocked` también cuenta:
  // si la ruta está frenada (por ejemplo, tope de salidas), crear la guía por el
  // panel sería saltarse el mismo límite por la puerta de atrás.
  const aliclikOffered = Boolean(
    detail?.routePlan.candidates.some(
      (candidate) => candidate.action === "aliclik" && candidate.availability !== "blocked",
    ),
  );
  const paymentPanel = detail
    ? orderPaymentPanelPresentation({
        operation: detail.routePlan.operation,
        currentCourier: detail.row.current_courier,
        shippingMode: detail.row.shipping_mode,
        macroSubstage: detail.row.macro_substage,
        macroReasons: detail.row.macro_reasons,
        riskRequirement: brief?.risk.requirement ?? null,
        paymentState: detail.row.payment_state,
        hasAgencyCandidate:
          canCreateShalomGuide &&
          detail.routePlan.candidates.some(
            (candidate) => candidate.key === "shalom" || candidate.key === "olva",
          ),
      })
    : null;
  const showPaymentPanel = paymentPanel?.show ?? false;
  const nextAction = detail ? drawerNextAction(detail.row, showPaymentPanel) : null;

  return (
    <div
      className="fixed inset-0 z-30 flex justify-end bg-slate-900/40 backdrop-blur-[1px]"
      onClick={onClose}
    >
      <aside
        ref={scrollRef}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={`Pedido ${row?.order_name ?? ""}`}
        className="h-full w-full max-w-[880px] overflow-y-auto bg-white shadow-2xl"
      >
        {/* La cabecera lleva lo que hay que tener SIEMPRE a la vista: qué pedido
            es, en qué estado está y cuánto vale. Antes había que subir hasta
            arriba para recordar el estado, y el monto quedaba enterrado entre
            los datos del cliente. */}
        <div className="sticky top-0 z-10 border-b border-slate-200 bg-white/95 backdrop-blur">
          <div className="flex items-start justify-between gap-3 px-5 py-3">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-base font-semibold text-slate-900">
                  {row?.order_name ?? "Pedido"}
                </p>
                {shopifyUrl && (
                  <a
                    href={shopifyUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    title="Abrir en Shopify"
                    aria-label={`Abrir ${row?.order_name ?? "pedido"} en Shopify (nueva pestaña)`}
                    className="inline-flex shrink-0 items-center justify-center rounded-md p-1 text-slate-400 transition-colors hover:bg-slate-100 hover:text-brand-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1"
                  >
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <path d="M7 17 17 7" />
                      <path d="M8 7h9v9" />
                    </svg>
                  </a>
                )}
                {detail && (
                  <StatusBadge
                    status={detail.row.general_status}
                    locked={detail.row.status_locked}
                  />
                )}
                {detail && (
                  <span className="text-sm font-semibold text-slate-700">
                    {fmtMoney(detail.row.order_total)}
                  </span>
                )}
                {/* La cobertura decide TODO lo que sigue —si se confirma, quién
                    lo lleva, si hay que exigir pago— así que va en la cabecera
                    fija y no dentro de una pestaña: cualquier decisión que se
                    tome en Operar la necesita a la vista. */}
                {detail && <CoverageBadge coverage={detail.row.coverage} />}
              </div>
              {row && (
                <p className="truncate text-xs text-slate-500">
                  {storeName(row.store_id)} · creado el {fmtDate(row.order_created_at)}
                  {detail?.row.customer_name ? ` · ${detail.row.customer_name}` : ""}
                </p>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-1">
              {detail?.row.customer_phone && (
                <>
                  <a
                    href={`tel:${detail.row.customer_phone}`}
                    className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
                    title="Llamar al cliente"
                  >
                    Llamar
                  </a>
                  <a
                    href={`https://wa.me/${detail.row.customer_phone.replace(/\D/g, "")}`}
                    target="_blank"
                    rel="noreferrer"
                    className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
                    title="Abrir WhatsApp"
                  >
                    WhatsApp
                  </a>
                </>
              )}
              <button
                onClick={onClose}
                aria-label="Cerrar"
                className="rounded-lg p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
              >
                <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
                  <path
                    d="M4 4l8 8M12 4l-8 8"
                    stroke="currentColor"
                    strokeWidth="1.75"
                    strokeLinecap="round"
                  />
                </svg>
              </button>
            </div>
          </div>

          {/* Tres espacios estables, como en Shopify: hacer el trabajo, consultar
              el pedido y auditar lo ocurrido. El equipo deja de navegar una
              lista accidental de formularios. */}
          {detail && (
            <div className="flex items-center gap-5 px-5" role="tablist" aria-label="Espacios del pedido">
              {(
                [
                  { id: "operar", label: "Operar", meta: "Siguiente acción" },
                  { id: "informacion", label: "Información", meta: "Cliente y pedido" },
                  {
                    id: "actividad",
                    label: "Actividad",
                    meta: `${detail.timeline.length} movimiento${detail.timeline.length === 1 ? "" : "s"}`,
                  },
                ] as const
              ).map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  role="tab"
                  aria-selected={workspace === tab.id}
                  aria-controls={`pedido-panel-${tab.id}`}
                  onClick={() => openWorkspace(tab.id)}
                  className={cn(
                    "relative flex min-h-11 items-center gap-2 border-b-2 px-0.5 text-sm font-semibold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2",
                    workspace === tab.id
                      ? "border-brand-600 text-slate-950"
                      : "border-transparent text-slate-500 hover:border-slate-300 hover:text-slate-800",
                  )}
                >
                  <span>{tab.label}</span>
                  <span
                    className={cn(
                      "hidden rounded-full px-2 py-0.5 text-[10px] font-medium lg:inline",
                      workspace === tab.id ? "bg-brand-50 text-brand-700" : "bg-slate-100 text-slate-500",
                    )}
                  >
                    {tab.meta}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Pegados bajo la cabecera: un error que se pierde al scrollear es un
            error que nadie lee, y estas acciones mueven dinero y estados. */}
        {error && (
          <div className="sticky top-[112px] z-10 mx-5 mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </div>
        )}
        {notice && (
          <div className="sticky top-[112px] z-10 mx-5 mt-3 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
            {notice}
          </div>
        )}

        {!detail ? (
          // Un "Cargando…" suelto no dice nada; un esqueleto con la forma del
          // contenido evita que la pantalla salte cuando llega.
          <div className="space-y-4 p-5" aria-busy="true">
            <div className="h-6 w-2/3 animate-pulse rounded bg-slate-100" />
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              {[0, 1, 2, 3, 4, 5].map((i) => (
                <div key={i} className="h-10 animate-pulse rounded bg-slate-100" />
              ))}
            </div>
            <div className="h-24 animate-pulse rounded bg-slate-100" />
            <div className="h-40 animate-pulse rounded bg-slate-100" />
          </div>
        ) : (
          <div className="flex flex-col gap-5 p-5">
            <section
              id="pedido-panel-operar"
              role="tabpanel"
              aria-label="Operar pedido"
              hidden={workspace !== "operar"}
              data-drawer-section="resumen"
              className="order-1 scroll-mt-28 space-y-4 rounded-xl border border-slate-200 bg-slate-50/70 p-4"
            >
              <div>
                <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-slate-500">
                  Situación del pedido
                </p>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <MacroStageBadge stage={detail.row.macro_stage} />
                  <span className="rounded-full bg-white px-2 py-0.5 text-xs text-slate-600 ring-1 ring-slate-200">
                    {macroSubstageLabel(detail.row.macro_substage)}
                  </span>
                  {/* Un motivo dice qué falta, la subetapa dice en qué punto va la
                      gestión: el pedido se ve entero sin abrir nada. En Por cerrar
                      los motivos son el trabajo mismo y los lista la mesa de cierre,
                      así que no se repiten aquí. */}
                  {detail.row.macro_stage !== "por_cerrar" &&
                    (detail.row.macro_reasons ?? []).map((reason) => (
                      <span
                        key={reason}
                        className="rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-900 ring-1 ring-amber-200"
                      >
                        {macroSubstageLabel(reason)}
                      </span>
                    ))}
                  <span className="text-xs text-slate-400">
                    {fmtAge(detail.row.macro_since ?? detail.row.status_since)} en esta macroetapa · fuente:{" "}
                    {detail.row.status_source ?? "—"}
                  </span>
                </div>
              </div>

              <DrawerJourneyRail current={detail.row.macro_stage} />
            </section>

            {nextAction && workspace === "operar" && (
              <div className="order-2">
                <DrawerNextActionCard action={nextAction} onJump={jumpTo} />
              </div>
            )}

            {/* La gestión de confirmación va arriba porque en Por confirmar ES
                el trabajo. Se muestra antes que el panel de pago para que el
                empate de `order-3` lo resuelva el orden del DOM: en Agencia el
                abono se pide DURANTE la llamada, no en vez de ella. */}
            {detail.row.macro_stage === "por_confirmar" && canEdit && (
              <div
                hidden={workspace !== "operar"}
                data-drawer-section="confirmacion"
                className="order-3 scroll-mt-28"
              >
                <ConfirmationDesk
                  brief={brief}
                  timeline={detail.timeline}
                  pending={pending}
                  onAttempt={(payload) =>
                    run(() => registerConfirmationAttempt(orderId, payload))
                  }
                />
              </div>
            )}

            <section
              id="pedido-panel-informacion"
              role="tabpanel"
              aria-label="Información del pedido"
              hidden={workspace !== "informacion"}
              className="order-1 rounded-xl border border-slate-200 bg-slate-50/70 p-4"
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-slate-500">
                    Pedido y cliente
                  </p>
                  <p className="mt-1 text-sm text-slate-500">
                    Datos comerciales sincronizados desde Shopify y contexto operativo de Kapta.
                  </p>
                </div>
                {/* La cobertura vive en la cabecera fija. Repetirla aquí, a dos
                    dedos y en la misma pantalla, sugería que eran dos datos
                    distintos. La de «Ubicación y cobertura» sí se queda: ahí es
                    el sujeto de la sección y lo que se corrige. */}
              </div>
              <dl className="mt-4 grid grid-cols-2 gap-x-5 gap-y-3 text-sm sm:grid-cols-4">
                <Field label="Cliente" value={detail.row.customer_name} />
                <Field label="Teléfono" value={detail.row.customer_phone} />
                <Field
                  label="Modalidad"
                  value={
                    detail.row.shipping_mode
                      ? (MODE_LABEL[detail.row.shipping_mode] ?? detail.row.shipping_mode)
                      : null
                  }
                />
                <Field label="Monto" value={fmtMoney(detail.row.order_total)} />
                <Field label="Tienda" value={storeName(detail.row.store_id)} />
                <Field label="Creado" value={fmtDateTime(detail.row.order_created_at)} />
                <Field label="Courier actual" value={detail.row.current_courier} />
                <Field label="Guía actual" value={detail.row.guide_code} />
                {/* Estos cuatro vivían solo en la tabla. Al sacar sus columnas
                    del Master —para que quepa lo que se mira todos los días—
                    tienen que estar aquí, o el dato desaparecería del sistema. */}
                {detail.row.pickup_state && (
                  <>
                    <Field
                      label="Agencia"
                      value={
                        [operationalLabel(detail.row.pickup_state), detail.row.agency_branch]
                          .filter(Boolean)
                          .join(" · ") || null
                      }
                    />
                    <div>
                      <dt className="text-xs text-slate-400">Días en agencia</dt>
                      <dd className="text-slate-700">
                        <AgencyDays
                          arrivedAt={detail.row.agency_arrived_at}
                          expiresAt={detail.row.agency_expires_at}
                        />
                      </dd>
                    </div>
                  </>
                )}
                <div>
                  <dt className="text-xs text-slate-400">Pago / clave</dt>
                  <dd className="text-slate-700">
                    <PaymentIndicator
                      paymentState={detail.row.payment_state}
                      keyState={detail.row.key_state}
                    />
                  </dd>
                </div>
                <Field label="Costo logístico" value={fmtMoney(detail.row.logistics_cost)} />
              </dl>
            </section>

            <div hidden={workspace !== "informacion"} className="order-2 scroll-mt-28">
              <GeoSection
                orderId={orderId}
                row={detail.row}
                canEdit={canEdit}
                onSaved={() => {
                  void reload();
                  onSaved();
                }}
              />
            </div>

            {detail.lineItems.length > 0 && (
              <section
                hidden={workspace !== "informacion"}
                data-drawer-section="productos"
                className="order-3 scroll-mt-28 rounded-xl border border-slate-200 bg-white p-4"
              >
                <h3 className="mb-2 text-xs font-bold uppercase tracking-[0.12em] text-slate-500">
                  Productos
                </h3>
                <ul className="divide-y divide-slate-100 text-sm text-slate-700">
                  {detail.lineItems.map((li, i) => (
                    <li key={i} className="flex justify-between gap-3 py-2 first:pt-0 last:pb-0">
                      <span className="min-w-0">{li.title}</span>
                      <span className="shrink-0 rounded-md bg-slate-100 px-2 py-0.5 font-medium text-slate-600">
                        ×{li.quantity}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            <div
              hidden={workspace !== "operar"}
              data-drawer-section="rutas"
              className="order-4 scroll-mt-28"
            >
              <OrderRouteDesk
                plan={detail.routePlan}
                closed={detail.row.macro_stage === "finalizado"}
                actionEnabled={routeEnabled}
                onSelect={selectRoute}
              />
            </div>

            <section
              hidden={workspace !== "operar"}
              data-drawer-section="guias"
              className="order-6 scroll-mt-28 rounded-xl border border-sky-200 bg-sky-50/40 p-4"
            >
              <div className="mb-2 flex items-center justify-between gap-2">
                <div>
                  <h3 className="text-xs font-bold uppercase tracking-[0.12em] text-sky-900">
                    Salidas y guías
                  </h3>
                  <p className="mt-0.5 text-xs text-slate-500">
                    Cada salida conserva su courier, rótulo, QR y resultado independiente.
                  </p>
                </div>
                <span className="rounded-full bg-white px-2.5 py-1 text-xs font-semibold text-sky-800 ring-1 ring-sky-200">
                  {detail.guides.length}
                </span>
              </div>
              {detail.guides.length === 0 ? (
                <p className="text-sm text-slate-400">
                  Sin gestión logística registrada todavía.
                </p>
              ) : (
                <ul className="space-y-1.5">
                  {detail.guides.map((g) => (
                    <li
                      key={g.id}
                      className="flex flex-wrap items-center gap-2 rounded-lg border border-sky-100 bg-white px-3 py-2 text-sm shadow-sm"
                    >
                      <span className="font-medium capitalize text-slate-800">{g.courier}</span>
                      <span className="font-mono text-xs text-slate-500">
                        {outputDisplayCode(g.output_code, g.courier) || g.guide_code}
                      </span>
                      {/* El número con el que el COURIER conoce el envío.
                          Estaba escondido: en cuanto la salida tenía código
                          interno, `outputDisplayCode` ganaba y el `guide_code`
                          no se pintaba nunca. Es justo el dato que hay que
                          teclear en el panel del courier para buscarla, y el
                          que el rótulo de Shalom titula «N° de Orden». */}
                      {g.guide_code && outputDisplayCode(g.output_code, g.courier) && (
                        <span className="font-mono text-xs font-semibold text-slate-700">
                          N° {g.guide_code}
                        </span>
                      )}
                      {/* Shalom muestra en su panel el nº de orden Y un código
                          corto. Sin el corto hay que abrir cada envío allá para
                          saber cuál es cuál. */}
                      {g.shalom_codigo && (
                        <span className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-xs font-medium text-slate-700">
                          {g.shalom_codigo}
                        </span>
                      )}
                      <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600">
                        {g.delivery_status}
                      </span>
                      {(g.aliclik_attempts ?? g.reroute_attempts) > 0 && (
                        <span className="text-xs text-amber-700">
                          {g.aliclik_attempts ?? g.reroute_attempts} intento(s)
                        </span>
                      )}
                      {g.courier === "tanders" && (
                        // Navegación real (no window.open tras un await): así el
                        // bloqueador de ventanas emergentes no se la come. El
                        // marcado en Tanders sale en paralelo, sin frenar la
                        // impresión — el rótulo ya está compuesto de nuestro lado.
                        <a
                          href={`/dashboard/pedidos/rotulos?ids=${g.id}`}
                          target="_blank"
                          rel="noreferrer"
                          onClick={() => void markTandersLabelGenerated([g.id])}
                          className="text-xs font-medium text-brand-700 hover:underline"
                        >
                          Rótulo ↗
                        </a>
                      )}
                      {/* El rótulo de Shalom lo compone ELLOS, no nosotros: se
                          pide a su API y se sirve como PDF. Solo existe para las
                          guías creadas por API — las que llegaron por el Excel
                          no tienen `ose_id` y hay que bajarlas de su panel. */}
                      {g.courier === "shalom" && g.shalom_ose_id && (
                        <a
                          href={`/api/shalom/label/${g.id}`}
                          target="_blank"
                          rel="noreferrer"
                          className="text-xs font-medium text-brand-700 hover:underline"
                        >
                          Rótulo ↗
                        </a>
                      )}
                      {canCreateShalomGuide && shalomGuideIsCancelable(g) && (
                        <ShalomCancelButton
                          shipmentId={g.id}
                          guideCode={g.guide_code}
                          codigo={g.shalom_codigo ?? null}
                          onDone={(msg) => {
                            setNotice(msg);
                            void reload();
                            onSaved();
                          }}
                        />
                      )}
                      {g.qr_token && (
                        <a
                          href={`/api/pedidos/rotulos?ids=${g.id}`}
                          target="_blank"
                          rel="noreferrer"
                          className="rounded-md border border-slate-300 px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
                        >
                          Rótulo interno
                        </a>
                      )}
                      {g.guide_code === detail.row.guide_code && (
                        <span className="ml-auto text-xs text-slate-400">actual</span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              {detail.guides.some((guide) => guide.courier === "shalom") && (
                <ShalomPickupKeyPanel orderId={orderId} onChanged={onSaved} />
              )}
            </section>

            {["por_cerrar", "finalizado"].includes(detail.row.macro_stage ?? "") && (
              <div
                hidden={workspace !== "operar"}
                data-drawer-section="cierre"
                className="order-7 scroll-mt-28"
              >
                <OrderClosureDesk
                  stage={detail.row.macro_stage}
                  reasons={(detail.row.macro_reasons ?? []) as MacroSubstage[]}
                  generalStatus={detail.row.general_status}
                  guides={detail.guides}
                  permissions={closurePermissions}
                  pending={pending}
                  onAction={(input) => run(() => registerClosureAction(orderId, input))}
                />
              </div>
            )}

            <section
              id="pedido-panel-actividad"
              role="tabpanel"
              aria-label="Actividad del pedido"
              hidden={workspace !== "actividad"}
              data-drawer-section="historial"
              className="order-1 scroll-mt-28 overflow-hidden rounded-xl border border-slate-200 bg-white"
            >
              <div className="flex items-center justify-between gap-3 border-b border-slate-100 bg-slate-50/70 px-4 py-3">
                <div>
                  <h3 className="text-xs font-bold uppercase tracking-[0.12em] text-slate-600">
                    Actividad y auditoría
                  </h3>
                  <p className="mt-0.5 text-xs text-slate-400">
                    {detail.timeline.length} movimiento{detail.timeline.length === 1 ? "" : "s"} · se conserva indefinidamente
                  </p>
                </div>
                <span className="rounded-full bg-white px-2.5 py-1 text-xs font-semibold text-slate-600 ring-1 ring-slate-200">
                  Solo lectura
                </span>
              </div>
              <div className="px-4 py-4">
                {detail.timeline.length === 0 ? (
                  <p className="text-sm text-slate-400">Sin movimientos registrados.</p>
                ) : (
                  <ol className="space-y-3 border-l border-slate-200 pl-4">
                    {detail.timeline.map((t) => (
                      <li key={t.id} className="relative">
                        <span
                          className={cn(
                            "absolute -left-[21px] top-1.5 h-2 w-2 rounded-full",
                            /payment|liquidation|entregado/.test(t.kind)
                              ? "bg-emerald-500"
                              : /return|refund|merma|anulado/.test(t.kind)
                                ? "bg-orange-500"
                                : /guide|dispatch|route|custody/.test(t.kind)
                                  ? "bg-indigo-500"
                                  : "bg-slate-400",
                          )}
                        />
                        <p className="text-sm font-medium text-slate-800">
                          {TIMELINE_LABEL[t.kind] ?? t.kind}
                          {/* El resultado va pegado al título, no en la línea de
                              la nota: la nota es opcional y sin esto dos
                              resultados distintos se leían idénticos. */}
                          {t.confirmation?.result && (
                            <span className="ml-1 font-normal text-slate-500">
                              · {confirmationResultLabel(t.confirmation.result)}
                            </span>
                          )}
                          {t.newStatus && (
                            <span className="ml-1 font-normal text-slate-500">
                              → {generalLabel(t.newStatus)}
                            </span>
                          )}
                        </p>
                        {(t.note || t.reason) && (
                          <p className="mt-0.5 text-sm leading-5 text-slate-600">{t.note ?? t.reason}</p>
                        )}
                        <p className="mt-0.5 text-xs text-slate-400">
                          {fmtDateTime(t.occurredAt)}
                          {t.actorName ? ` · ${t.actorName}` : ""}
                          {t.confirmation?.channel
                            ? ` · ${confirmationChannelLabel(t.confirmation.channel)}`
                            : ""}
                          {t.courier ? ` · ${t.courier}` : ""}
                          {t.guideCode ? ` · ${t.guideCode}` : ""}
                          {` · ${t.origin === "gestion" ? "Repro Provincia" : t.source}`}
                        </p>
                      </li>
                    ))}
                  </ol>
                )}
              </div>
            </section>

            {/* Agencia o una regla de riesgo ponen el pago antes que la ruta.
                Provincia COD puede salir contra entrega, así que conserva la
                Mesa de ruta primero y deja el pago anticipado como herramienta
                opcional debajo. Sigue disponible antes de crear Shalom para no
                reconstruir el antiguo callejón circular guía ↔ adelanto. */}
            {showPaymentPanel && paymentPanel && (
              <div
                hidden={workspace !== "operar"}
                data-drawer-section="pagos"
                className={cn(
                  "scroll-mt-28 rounded-xl border p-4",
                  paymentPanel.mode === "required"
                    ? "order-3 border-amber-200 bg-amber-50/30"
                    : "order-5 border-slate-200 bg-white",
                )}
              >
                <PickupKeyPanel
                  orderId={orderId}
                  mode={paymentPanel.mode}
                  onChanged={onSaved}
                />
              </div>
            )}

            {/* Crear guía: solo tiene sentido en un pedido que todavía no tiene
                una. En cuanto existe, el seguimiento vive en Envíos.

                Y solo donde Aliclik atiende. El plan de rutas ya no lo ofrece
                en Agencia —ahí van Shalom u Olva—, pero este panel se dibujaba
                igual con solo tener el permiso: la pantalla mostraba las dos
                tarjetas de agencia y, debajo, un formulario para crear una guía
                de una ruta que ese pedido no puede tomar. Se lee el plan en vez
                de repetir la regla aquí, que es como se vuelven a separar. */}
            {canCreateGuide && aliclikOffered && (
              <div
                hidden={workspace !== "operar"}
                data-drawer-section="aliclik"
                className="order-5 scroll-mt-28"
              >
                <AliclikGuidePanel
                  orderId={orderId}
                  hasCoordinate={detail.row.latitude != null && detail.row.longitude != null}
                  health={detail.aliclikHealth}
                  onCreated={() => {
                    void reload();
                    onSaved();
                  }}
                />
              </div>
            )}

            {/* Esconderlo sin más dejaría buscando a quien esperaba encontrarlo.
                La salida es corregir la dirección: la cobertura se recalcula a
                partir de ella y, si el pedido era Provincia COD mal clasificada,
                Aliclik vuelve solo.

                Pero eso vale mientras la ruta se está DECIDIENDO. Con una salida
                ya activa la pregunta está contestada: corregir la dirección no va
                a traer Aliclik de vuelta a un paquete que ya viaja, y el bloque
                se lee como una opción disponible cuando no lo es. */}
            {canCreateGuide &&
              !aliclikOffered &&
              detail.routePlan.operation === "agencia" &&
              detail.routePlan.activeOutputCount === 0 && (
              <div
                hidden={workspace !== "operar"}
                data-drawer-section="aliclik"
                className="order-5 scroll-mt-28 rounded-xl border border-slate-200 bg-white p-4"
              >
                <h3 className="text-xs font-bold uppercase tracking-[0.12em] text-slate-500">
                  Aliclik
                </h3>
                <p className="mt-1 text-sm leading-5 text-slate-600">
                  Aliclik no atiende pedidos de Agencia; este va con Shalom u Olva. Si la dirección
                  está mal clasificada, corrígela y la cobertura se recalcula sola.
                </p>
                <button
                  type="button"
                  onClick={() => jumpTo("ubicacion")}
                  className="mt-3 rounded-lg border border-slate-200 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
                >
                  Revisar ubicación y cobertura ↓
                </button>
              </div>
            )}

            {canEdit ? (
              <div hidden={workspace !== "operar"} className="order-8">
                <OrderActions
                  row={detail.row}
                  canOverride={canOverride}
                  pending={pending}
                  onStatus={(general, operational, reason) =>
                    run(() => setOrderStatus(orderId, { general, operational, reason }))
                  }
                  onComment={(text, type) => run(() => addOrderComment(orderId, { text, type }))}
                  onReturn={(reason, guideCode) => run(() => registerReturn(orderId, { reason, guideCode }))}
                  onRelink={(guideCode) => run(() => relinkGuide(guideCode, orderId))}
                />
              </div>
            ) : (
              <div hidden={workspace !== "operar"} className="order-8">
                <EmptyState title="Solo lectura">
                  Tu rol permite consultar el pedido, sus comentarios y su historial, pero no modificarlo.
                </EmptyState>
              </div>
            )}
          </div>
        )}
      </aside>

      {tandersOpen && (
        <TandersGuideModal
          orderId={orderId}
          onClose={() => setTandersOpen(false)}
          onCreated={() => {
            void reload();
            onSaved();
          }}
        />
      )}

      {shalomOpen && (
        <ShalomGuideModal
          orderId={orderId}
          onClose={() => setShalomOpen(false)}
          onCreated={() => {
            void reload();
            onSaved();
          }}
        />
      )}
      {swaypOpen && (
        <DirectFenixGuideModal
          initialOrderId={orderId}
          onClose={() => setSwaypOpen(false)}
          onCreated={() => {
            void reload();
            onSaved();
          }}
        />
      )}
      {manualRoute && ["axel", "urpi", "propio", "olva"].includes(manualRoute.key) && (
        <ManualRouteOutputModal
          orderId={orderId}
          route={manualRoute as RouteCandidate & { key: "axel" | "urpi" | "propio" | "olva" }}
          activeOutputs={detail?.routePlan.activeOutputCount ?? 0}
          onClose={() => setManualRoute(null)}
          onCreated={() => {
            void reload();
            onSaved();
          }}
        />
      )}
    </div>
  );
}


/** Enlace al mapa: por coordenadas si las hay, si no por la dirección escrita. */
function mapUrl(row: OrderMasterRow): string | null {
  if (row.latitude != null && row.longitude != null) {
    return `https://www.google.com/maps/search/?api=1&query=${row.latitude},${row.longitude}`;
  }
  const parts = [row.address, row.district, row.province, row.region, "Perú"].filter(Boolean);
  if (parts.length <= 1) return null;
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(parts.join(", "))}`;
}

const GEO_SOURCE_LABEL: Record<string, string> = {
  manual: "corregida por el equipo",
  courier: "según el reporte del courier",
  ubigeo: "provincia inferida del distrito",
  shopify: "según Shopify",
  draft: "según el formulario COD",
  history: "historial confiable del cliente",
};

/**
 * Ubicación del pedido, editable. La dirección de Shopify sale del formulario que
 * llenó el cliente —Shopify mismo la marca como problemática a menudo— y su punto
 * del mapa suele estar desplazado. Corregirla aquí no toca `orders`: la
 * corrección vive aparte y sobrevive a la siguiente sincronización.
 */
function GeoSection({
  orderId,
  row,
  canEdit,
  onSaved,
}: {
  orderId: string;
  row: OrderMasterRow;
  canEdit: boolean;
  onSaved: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<OrderGeoInput>({});
  const [hasOverride, setHasOverride] = useState(row.geo_source === "manual");
  const [remember, setRemember] = useState(true);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  async function open() {
    const current = await loadOrderGeo(orderId);
    setHasOverride(current.hasOverride);
    setForm({
      region: current.region ?? row.region ?? "",
      province: current.province ?? row.province ?? "",
      district: current.district ?? row.district ?? "",
      address: current.address ?? row.address ?? "",
      reference: current.reference ?? row.reference ?? "",
      latitude: current.latitude ?? row.latitude ?? "",
      longitude: current.longitude ?? row.longitude ?? "",
      note: "",
    });
    setEditing(true);
  }

  function save() {
    startTransition(async () => {
      const res = await updateOrderGeo(orderId, { ...form, rememberDistrict: remember });
      setMessage(res.error ?? res.notice ?? null);
      if (!res.error) {
        setEditing(false);
        onSaved();
      }
    });
  }

  function clear() {
    startTransition(async () => {
      const res = await clearOrderGeo(orderId);
      setMessage(res.error ?? res.notice ?? null);
      if (!res.error) {
        setEditing(false);
        setHasOverride(false);
        onSaved();
      }
    });
  }

  const url = mapUrl(row);
  const set = (patch: Partial<OrderGeoInput>) => setForm((f) => ({ ...f, ...patch }));

  return (
    <section
      data-drawer-section="ubicacion"
      className="scroll-mt-28 space-y-3 rounded-xl border border-slate-200 bg-white p-4"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-xs font-bold uppercase tracking-[0.12em] text-slate-500">Ubicación y cobertura</h3>
        <CoverageBadge coverage={row.coverage} />
        {row.geo_source && (
          <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600">
            {GEO_SOURCE_LABEL[row.geo_source] ?? row.geo_source}
          </span>
        )}
        {url && (
          <a
            href={url}
            target="_blank"
            rel="noreferrer"
            className="text-xs text-brand-700 hover:underline"
          >
            Ver mapa ↗
          </a>
        )}
        {canEdit && !editing && (
          <button onClick={open} className="ml-auto text-xs text-slate-500 hover:underline">
            {hasOverride ? "Editar corrección" : "Corregir ubicación"}
          </button>
        )}
      </div>

      {message && <p className="rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-700">{message}</p>}

      {(row.coverage ?? "por_revisar") === "por_revisar" && !editing && (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2">
          <p className="text-xs text-amber-900">
            Completa la región y el distrito para asignar el flujo correcto.
          </p>
          {canEdit && (
            <button
              type="button"
              onClick={open}
              className="shrink-0 rounded-md bg-amber-700 px-2.5 py-1 text-xs font-semibold text-white hover:bg-amber-800"
            >
              Completar
            </button>
          )}
        </div>
      )}

      {!editing ? (
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-3">
          <Field label="Región" value={row.region} />
          <Field label="Provincia" value={row.province} />
          <Field label="Distrito" value={row.district} />
          <Field label="Dirección" value={row.address} />
          <Field label="Referencia" value={row.reference} />
          <Field
            label="Coordenadas"
            value={
              row.latitude != null && row.longitude != null
                ? `${row.latitude}, ${row.longitude}`
                : null
            }
          />
        </dl>
      ) : (
        <div className="space-y-2 rounded-lg border border-slate-200 p-3">
          <p className="text-xs text-slate-500">
            Deja en blanco lo que no quieras cambiar. Esta corrección gana sobre Shopify, sobre los
            reportes de los couriers y sobre el ubigeo, y no se pierde al sincronizar.
          </p>
          <div className="grid gap-2 sm:grid-cols-3">
            <LabeledInput label="Región" value={form.region} onChange={(region) => set({ region })} />
            <LabeledInput
              label="Provincia"
              value={form.province}
              onChange={(province) => set({ province })}
            />
            <LabeledInput
              label="Distrito"
              value={form.district}
              onChange={(district) => set({ district })}
            />
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            <LabeledInput
              label="Dirección"
              value={form.address}
              onChange={(address) => set({ address })}
            />
            <LabeledInput
              label="Referencia"
              value={form.reference}
              onChange={(reference) => set({ reference })}
            />
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            <LabeledInput
              label="Latitud"
              value={form.latitude}
              placeholder="-12.0464"
              onChange={(latitude) => set({ latitude })}
            />
            <LabeledInput
              label="Longitud"
              value={form.longitude}
              placeholder="-77.0428"
              onChange={(longitude) => set({ longitude })}
            />
          </div>
          <LabeledInput
            label="Motivo / nota"
            value={form.note}
            onChange={(note) => set({ note })}
          />
          <label className="flex items-center gap-1.5 text-xs text-slate-600">
            <input
              type="checkbox"
              checked={remember}
              onChange={(e) => setRemember(e.target.checked)}
              className="h-3.5 w-3.5"
            />
            Recordar esta provincia para los próximos pedidos del mismo distrito
          </label>
          <div className="flex flex-wrap gap-2">
            <button
              disabled={pending}
              onClick={save}
              className="rounded-lg bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50"
            >
              Guardar ubicación
            </button>
            <button
              disabled={pending}
              onClick={() => setEditing(false)}
              className="rounded-lg border border-slate-200 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              Cancelar
            </button>
            {hasOverride && (
              <button
                disabled={pending}
                onClick={clear}
                className="ml-auto text-xs text-slate-500 hover:underline"
              >
                Quitar corrección y volver al origen
              </button>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

function LabeledInput({
  label,
  value,
  placeholder,
  onChange,
}: {
  label: string;
  value: string | number | null | undefined;
  placeholder?: string;
  onChange: (next: string) => void;
}) {
  return (
    <label className="block">
      <span className="text-xs text-slate-400">{label}</span>
      <input
        value={value ?? ""}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="mt-0.5 w-full rounded-lg border border-slate-200 px-2 py-1.5 text-sm"
      />
    </label>
  );
}

function Field({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div>
      <dt className="text-xs text-slate-400">{label}</dt>
      <dd className="text-slate-700">{value || "—"}</dd>
    </div>
  );
}

/**
 * Mesa de confirmación: donde se registra cada intento de contacto.
 *
 * Un solo gesto por intento. Antes esto no existía —el resolvedor leía eventos
 * que nadie escribía— y los 2.994 pedidos Por confirmar vivían en «Sin llamar»
 * por más llamadas que hiciera el equipo.
 *
 * El contador cuenta DÍAS DISTINTOS con gestión, no días transcurridos: llamar
 * el 20, el 22, el 25 y el 28 de julio son cuatro días de siete, no nueve. Los
 * días en que nadie llamó no gastan cupo.
 */
const REQUIREMENT_TONE: Record<PaymentRequirement, string> = {
  ninguno: "border-slate-200 bg-white text-slate-700",
  sugerir_adelanto: "border-amber-200 bg-amber-50 text-amber-900",
  exigir_adelanto: "border-orange-300 bg-orange-50 text-orange-900",
  pago_completo: "border-rose-300 bg-rose-50 text-rose-900",
};

/**
 * Lo que el MOM §8 manda revisar ANTES de llamar: historial del cliente,
 * duplicados y cobertura.
 *
 * Hasta ahora esto vivía en tres columnas del Excel —«Métricas», «Duplicado?» y
 * «Cobertura Aliclick o Dropi?»— resumidas a mano. Sin ellas, la tabla de riesgo
 * del §8 no se podía aplicar desde Kapta: la regla existe desde siempre en el
 * papel, pero nadie tenía el número de antecedentes delante al marcar.
 */
/**
 * Una línea del historial del cliente.
 *
 * Cada fila responde cuatro cosas que antes no se veían: cuándo fue, si es
 * POSTERIOR al pedido que se está mirando, si llegó a costar flete y qué llevaba.
 * La última importa más de lo que parece: cuatro pedidos del mismo producto y la
 * misma cantidad no son un historial de compras, son el mismo pedido repetido.
 */
function PriorOrderRow({
  row,
  referenceCreatedAt,
  currentProducts,
}: {
  row: PriorOrderSnapshot;
  referenceCreatedAt: string | null;
  currentProducts: string | null;
}) {
  const outcome = priorOutcome(row);
  const dispatch = dispatchState(row);
  const courier = priorCourier(row);
  const later = priorTiming(row, referenceCreatedAt) === "posterior";
  const repeats = sameProducts(row.products, currentProducts);
  const attempts = row.attempt_count ?? 0;

  return (
    <li className="rounded-md border border-slate-200 bg-slate-50/60 px-2 py-1.5">
      <div className="flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5">
        <span className="font-mono text-[11px] font-medium text-slate-800">
          {row.order_name ?? row.order_id}
        </span>
        <span className="text-[11px] text-slate-500">
          {fmtDate(row.order_created_at)} · {fmtAge(row.order_created_at)}
        </span>
        {/* El pedido abierto que se mira puede ser el MÁS VIEJO del teléfono: sin
            esta marca, un re-pedido posterior se lee como antecedente previo. */}
        {later && (
          <span className="rounded bg-indigo-100 px-1 text-[10px] font-semibold text-indigo-800">
            posterior a este
          </span>
        )}
        <span
          className={cn(
            "ml-auto rounded px-1.5 text-[10px] font-semibold",
            outcome === "entregado"
              ? "bg-emerald-100 text-emerald-800"
              : outcome === "anulado" || outcome === "devuelto"
                ? "bg-rose-100 text-rose-800"
                : "bg-slate-200 text-slate-700",
          )}
        >
          {row.operational_status ? operationalLabel(row.operational_status) : PRIOR_OUTCOME_LABEL[outcome]}
        </span>
      </div>

      {row.products && (
        <p
          className={cn(
            "mt-0.5 truncate text-[11px]",
            repeats ? "font-semibold text-amber-800" : "text-slate-600",
          )}
          title={row.products}
        >
          {row.products}
          {repeats && " · lo mismo que este pedido"}
        </p>
      )}

      {/* Nueve de cada diez anulados nunca llegaron a despacharse. Decirlo evita
          exigir pago completo por antecedentes que no costaron un solo flete. */}
      <p className="mt-0.5 text-[10px] text-slate-500">
        {dispatch === "nunca_despachado" ? (
          <span className="font-medium text-slate-600">{DISPATCH_STATE_LABEL.nunca_despachado}</span>
        ) : (
          <>
            {courier ?? "courier sin registrar"}
            {row.guide_code ? ` · guía ${row.guide_code}` : ""}
            {attempts > 0 ? ` · ${attempts} intento${attempts === 1 ? "" : "s"}` : ""}
          </>
        )}
        {row.order_total != null ? ` · ${fmtMoney(row.order_total)}` : ""}
      </p>
    </li>
  );
}

function ConfirmationBrief({ brief }: { brief: OrderConfirmationBrief }) {
  const { counts, risk, duplicates, codCouriers, priors, orderCreatedAt, products } = brief;
  const known = priors.length;
  const later = countLaterOrders(priors, orderCreatedAt);
  const outcomes = (Object.keys(PRIOR_OUTCOME_LABEL) as PriorOutcome[]).filter(
    (key) => counts[key] > 0,
  );

  return (
    <div className="space-y-2.5 rounded-lg border border-slate-200 bg-white p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-[11px] font-bold uppercase tracking-[0.12em] text-slate-500">
          Antes de llamar
        </h4>
        <span className="text-[11px] text-slate-500">
          {known === 0
            ? "Sin otros pedidos con este teléfono"
            : `${known} pedido${known === 1 ? "" : "s"} más con este teléfono` +
              (later > 0 ? ` · ${later} posterior${later === 1 ? "" : "es"} a este` : "")}
        </span>
      </div>

      {/* El desglose por desenlace, que es lo que la columna «Métricas» resume a
          mano. Los entregados van primero y bien visibles: son el argumento de
          quien decida saltarse la regla del §8 con justificación. */}
      {outcomes.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {outcomes.map((key) => (
            <span
              key={key}
              className={cn(
                "rounded-full px-2 py-0.5 text-xs font-medium ring-1",
                key === "entregado"
                  ? "bg-emerald-50 text-emerald-800 ring-emerald-200"
                  : key === "anulado" || key === "devuelto"
                    ? "bg-rose-50 text-rose-800 ring-rose-200"
                    : "bg-slate-50 text-slate-700 ring-slate-200",
              )}
            >
              {PRIOR_OUTCOME_LABEL[key]}: {counts[key]}
            </span>
          ))}
        </div>
      )}

      <div className={cn("rounded-md border px-2.5 py-2", REQUIREMENT_TONE[risk.requirement])}>
        <p className="text-xs font-bold">
          {PAYMENT_REQUIREMENT_LABEL[risk.requirement]}
          {risk.antecedents > 0 && (
            <span className="font-medium">
              {" "}
              · {risk.antecedents} antecedente{risk.antecedents === 1 ? "" : "s"} de rechazo o
              devolución
            </span>
          )}
        </p>
        {risk.reasons.length > 0 && (
          <p className="mt-0.5 text-[11px] leading-4 opacity-90">{risk.reasons.join(" ")}</p>
        )}
      </div>

      {/* Un duplicado no visto termina en dos paquetes al mismo destino, y el
          flete de uno se pierde. Se listan con nombre y fecha: la decisión es
          humana, la herramienta solo se asegura de que los vea. */}
      {duplicates.length > 0 && (
        <div className="rounded-md border border-amber-300 bg-amber-50 px-2.5 py-2">
          <p className="text-xs font-bold text-amber-900">
            ⚠ {duplicates.length} pedido{duplicates.length === 1 ? "" : "s"} abierto
            {duplicates.length === 1 ? "" : "s"} del mismo teléfono
          </p>
          <ul className="mt-1 space-y-0.5">
            {duplicates.slice(0, 5).map((row) => (
              <li key={row.order_id} className="text-[11px] text-amber-900">
                <span className="font-mono font-medium">{row.order_name ?? row.order_id}</span>
                {row.order_created_at ? ` · ${fmtDate(row.order_created_at)}` : ""}
                {row.order_total != null ? ` · ${fmtMoney(row.order_total)}` : ""}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* El historial pedido a pedido. El desglose de arriba dice CUÁNTOS; esto
          dice cuáles, cuándo y si alguno llegó a salir — que es de donde sale la
          decisión real, y lo que antes había que ir a buscar a Shopify y a
          Aliclik por separado. */}
      {priors.length > 0 && (
        <details className="group" open={priors.length <= 4}>
          <summary className="cursor-pointer list-none text-[11px] font-semibold text-slate-500 hover:text-slate-700">
            Historial del cliente
            <span className="ml-1 font-normal text-slate-400 group-open:hidden">
              (ver los {priors.length})
            </span>
          </summary>
          <ul className="mt-1.5 space-y-1">
            {priors.slice(0, 10).map((row) => (
              <PriorOrderRow
                key={row.order_id}
                row={row}
                referenceCreatedAt={orderCreatedAt}
                currentProducts={products}
              />
            ))}
          </ul>
          {priors.length > 10 && (
            <p className="mt-1 text-[10px] text-slate-400">
              y {priors.length - 10} más, no mostrados
            </p>
          )}
        </details>
      )}

      {/* La pregunta de la llamada es «¿sale por Aliclik o va a agencia?». Sale
          de la misma matriz de tarifas que ya clasifica la cobertura, así que no
          puede contradecir lo que dice la cabecera del pedido. */}
      <p className="text-[11px] text-slate-600">
        <span className="font-semibold text-slate-500">Cobertura COD:</span>{" "}
        {codCouriers.length > 0 ? (
          <span className="font-medium text-slate-800">{codCouriers.join(" · ")}</span>
        ) : (
          <span className="text-slate-500">
            sin courier COD con tarifa para este destino; va por agencia
          </span>
        )}
      </p>
    </div>
  );
}

function ConfirmationDesk({
  brief,
  timeline,
  pending,
  onAttempt,
}: {
  brief: OrderConfirmationBrief | null;
  timeline: TimelineEntry[];
  pending: boolean;
  onAttempt: (input: {
    result: string;
    channel: string;
    note?: string;
    nextContactOn?: string;
  }) => void;
}) {
  const [result, setResult] = useState(CONFIRMATION_RESULTS[0]!.code);
  const [channel, setChannel] = useState<string>(CONFIRMATION_CHANNELS[0].code);
  const [nextContactOn, setNextContactOn] = useState("");
  const [note, setNote] = useState("");

  const events = useMemo(
    () => timeline.map((entry) => ({ kind: entry.kind, occurred_at: entry.occurredAt })),
    [timeline],
  );
  const days = useMemo(() => confirmationDays(events), [events]);
  const used = days.length;
  const today = limaDayKey(new Date().toISOString());
  // Si ya se llamó hoy, este intento NO abre día nuevo: el MOM cuenta el día,
  // no la llamada, y decirle al operador que gasta un cupo que no gasta lo
  // empujaría a no registrar los intentos siguientes.
  const opensNewDay = !days.includes(today);
  const projected = Math.min(used + (opensNewDay ? 1 : 0), CONFIRMATION_MAX_DAYS);
  const lastAttempt = used >= CONFIRMATION_MAX_DAYS;

  const selected = confirmationResult(result);
  const needsDate = Boolean(selected?.schedulesFollowup);
  const blocked = pending || (needsDate && !nextContactOn);


  return (
    <section
      className={cn(
        "space-y-4 rounded-xl border p-4",
        lastAttempt ? "border-amber-300 bg-amber-50/50" : "border-indigo-200 bg-indigo-50/40",
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="text-xs font-bold uppercase tracking-[0.12em] text-indigo-900">
            Gestión de confirmación
          </h3>
          <p className="mt-1 text-xs leading-5 text-slate-600">
            Un registro por intento. Llamada, WhatsApp y mensaje del mismo día cuentan como un
            solo día de gestión.
          </p>
        </div>
        <span
          className={cn(
            "rounded-full px-2.5 py-1 text-xs font-bold ring-1",
            lastAttempt
              ? "bg-white text-amber-900 ring-amber-300"
              : "bg-white text-indigo-900 ring-indigo-200",
          )}
        >
          Día {used} de {CONFIRMATION_MAX_DAYS}
        </span>
      </div>

      {used > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {days.map((day) => (
            <span
              key={day}
              className="rounded-full bg-white px-2 py-0.5 text-xs text-slate-700 ring-1 ring-slate-200"
            >
              {day.slice(5).split("-").reverse().join("/")}
            </span>
          ))}
        </div>
      )}

      {lastAttempt && (
        <p className="rounded-lg bg-white/70 px-3 py-2 text-xs leading-5 text-amber-900 ring-1 ring-amber-200">
          <strong>Último intento.</strong> Se agotaron los {CONFIRMATION_MAX_DAYS} días de gestión.
          La anulación se crea a mano en Shopify — Kapta nunca anula por su cuenta.
        </p>
      )}

      {brief && <ConfirmationBrief brief={brief} />}

      <div className="grid gap-2 sm:grid-cols-2">
        <label className="block">
          <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            Canal
          </span>
          <select
            value={channel}
            onChange={(e) => setChannel(e.target.value)}
            className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-sm"
          >
            {CONFIRMATION_CHANNELS.map((option) => (
              <option key={option.code} value={option.code}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            Resultado
          </span>
          <select
            value={result}
            onChange={(e) => setResult(e.target.value)}
            className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-sm"
          >
            {CONFIRMATION_RESULTS.map((option) => (
              <option key={option.code} value={option.code}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      {selected && <p className="text-xs text-slate-500">{selected.hint}</p>}

      {needsDate && (
        <label className="block">
          <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            Próximo contacto
          </span>
          <input
            type="date"
            value={nextContactOn}
            min={today}
            onChange={(e) => setNextContactOn(e.target.value)}
            className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-sm sm:w-52"
          />
        </label>
      )}

      <textarea
        value={note}
        onChange={(e) => setNote(e.target.value)}
        rows={2}
        placeholder="Qué dijo el cliente (opcional)"
        className="w-full rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-sm"
      />

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled={blocked}
          onClick={() => {
            onAttempt({ result, channel, note, nextContactOn });
            setNote("");
            setNextContactOn("");
          }}
          className="rounded-lg bg-indigo-700 px-3 py-2 text-sm font-bold text-white hover:bg-indigo-800 disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-500"
        >
          Registrar intento
        </button>
        <span className="text-xs text-slate-500">
          {opensNewDay
            ? `Abre el día ${projected} de ${CONFIRMATION_MAX_DAYS}.`
            : "Ya hay gestión de hoy: no consume otro día."}
        </span>
      </div>
    </section>
  );
}

function OrderActions({
  row,
  canOverride,
  pending,
  onStatus,
  onComment,
  onReturn,
  onRelink,
}: {
  row: OrderMasterRow;
  canOverride: boolean;
  pending: boolean;
  onStatus: (general: string, operational: string, reason: string) => void;
  onComment: (text: string, type: string) => void;
  onReturn: (reason: string, guideCode: string) => void;
  onRelink: (guideCode: string) => void;
}) {
  const [general, setGeneral] = useState<GeneralStatus>(
    isGeneralStatus(row.general_status) ? row.general_status : "pendiente",
  );
  const [operational, setOperational] = useState(row.operational_status);
  const [reason, setReason] = useState("");
  const [comment, setComment] = useState("");
  const [commentType, setCommentType] = useState("");
  const [returnReason, setReturnReason] = useState("");
  const [returnGuide, setReturnGuide] = useState(row.guide_code ?? "");
  const [relinkCode, setRelinkCode] = useState("");

  const options = operationalStatusesFor(general);
  const closed = ["entregado", "anulado", "devuelto"].includes(row.general_status);
  const changingClosed = closed && general !== row.general_status;

  useEffect(() => {
    // Al cambiar el estado general, el operativo elegido puede dejar de aplicar.
    if (!options.some((o) => o.code === operational)) {
      setOperational(options[0]?.code ?? "");
    }
  }, [general, options, operational]);

  return (
    <section
      data-drawer-section="acciones"
      className="order-9 scroll-mt-28 space-y-4 rounded-xl border border-slate-200 bg-slate-50/70 p-4"
    >
      <div>
        <h3 className="text-xs font-bold uppercase tracking-[0.12em] text-slate-600">
          Gestión manual
        </h3>
        <p className="mt-1 text-xs leading-5 text-slate-500">
          Registra el resultado operativo o deja una nota. Las correcciones excepcionales están separadas al final.
        </p>
      </div>
      <div className="space-y-2">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
          Registrar estado
        </h4>
        <div className="flex flex-wrap gap-2">
          <select
            value={general}
            onChange={(e) => setGeneral(e.target.value as GeneralStatus)}
            className="rounded-lg border border-slate-200 px-2 py-1.5 text-sm"
          >
            {GENERAL_STATUSES.map((s) => (
              <option key={s.code} value={s.code}>
                {s.label}
              </option>
            ))}
          </select>
          <select
            value={operational}
            onChange={(e) => setOperational(e.target.value)}
            className="rounded-lg border border-slate-200 px-2 py-1.5 text-sm"
          >
            {options.map((o) => (
              <option key={o.code} value={o.code}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
        {changingClosed && (
          <p className="text-xs text-amber-700">
            Este pedido ya está {generalLabel(row.general_status).toLowerCase()}. Cambiarlo exige un
            motivo y queda registrado en el historial
            {!canOverride && "; tu rol no lo permite"}.
          </p>
        )}
        <input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder={changingClosed ? "Motivo (obligatorio)" : "Motivo u observación (opcional)"}
          className="w-full rounded-lg border border-slate-200 px-2 py-1.5 text-sm"
        />
        <button
          disabled={pending || (changingClosed && (!canOverride || !reason.trim()))}
          onClick={() => onStatus(general, operational, reason)}
          className="rounded-lg bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700 disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-500"
        >
          Guardar estado
        </button>
      </div>

      <div className="space-y-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Comentario</h3>
        <textarea
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          rows={2}
          placeholder="Cliente no responde, dirección incorrecta, pendiente de reasignación…"
          className="w-full rounded-lg border border-slate-200 px-2 py-1.5 text-sm"
        />
        <div className="flex gap-2">
          <input
            value={commentType}
            onChange={(e) => setCommentType(e.target.value)}
            placeholder="Tipo (opcional)"
            className="w-40 rounded-lg border border-slate-200 px-2 py-1.5 text-sm"
          />
          <button
            disabled={pending || !comment.trim()}
            onClick={() => {
              onComment(comment, commentType);
              setComment("");
              setCommentType("");
            }}
            className="rounded-lg border border-slate-200 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:text-slate-400"
          >
            Añadir comentario
          </button>
        </div>
      </div>

      <details className="group overflow-hidden rounded-lg border border-slate-200 bg-white">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-50">
          Devoluciones y correcciones avanzadas
          <span className="text-slate-400 transition-transform group-open:rotate-180">⌄</span>
        </summary>
        <div className="space-y-4 border-t border-slate-100 p-3">
          <div className="space-y-2">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-rose-700">
              Registrar devolución
            </h4>
            <p className="text-xs text-slate-500">
              Solo se marca como devuelto si consta el despacho y la guía; si no, queda como retorno en
              curso.
            </p>
            <div className="flex flex-wrap gap-2">
              <input
                value={returnGuide}
                onChange={(e) => setReturnGuide(e.target.value)}
                placeholder="Guía"
                className="w-40 rounded-lg border border-slate-200 px-2 py-1.5 text-sm"
              />
              <input
                value={returnReason}
                onChange={(e) => setReturnReason(e.target.value)}
                placeholder="Motivo de la devolución"
                className="min-w-44 flex-1 rounded-lg border border-slate-200 px-2 py-1.5 text-sm"
              />
              <button
                disabled={pending || !returnReason.trim()}
                onClick={() => onReturn(returnReason, returnGuide)}
                className="rounded-lg border border-red-200 bg-red-50 px-3 py-1.5 text-sm font-medium text-red-700 hover:bg-red-100 disabled:cursor-not-allowed disabled:border-slate-200 disabled:bg-white disabled:text-slate-400"
              >
                Registrar
              </button>
            </div>
          </div>

          <div className="space-y-2 border-t border-slate-100 pt-4">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
              Corregir vínculo de guía
            </h4>
            <div className="flex flex-col gap-2 sm:flex-row">
              <input
                value={relinkCode}
                onChange={(e) => setRelinkCode(e.target.value)}
                placeholder="Código de guía a vincular a este pedido"
                className="min-w-0 flex-1 rounded-lg border border-slate-200 px-2 py-1.5 text-sm"
              />
              <button
                disabled={pending || !relinkCode.trim()}
                onClick={() => {
                  onRelink(relinkCode);
                  setRelinkCode("");
                }}
                className="rounded-lg border border-slate-200 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:text-slate-400"
              >
                Vincular
              </button>
            </div>
          </div>
        </div>
      </details>
    </section>
  );
}

/**
 * Paginación. Existe porque el listado dejó de traerse entero: antes eran ~10.000
 * filas y 9,5 MB por carga, ahora son 100 filas por página. Enseña el total real
 * (contado en la base, no las visibles) para que nadie confunda "hay 100" con
 * "hay 100 en total".
 */
/**
 * Anterior / Siguiente. Va arriba Y abajo de la tabla: con 100 filas, tener los
 * controles solo al pie obliga a recorrer la página entera para cambiarla.
 */
/**
 * El nombre que propone el servidor en `Content-Disposition`. Sin él, el
 * navegador bautiza el fichero con el nombre de la ruta ("pedidos") y sin
 * extensión, y Excel no lo abre de doble clic.
 */
function filenameFromDisposition(header: string | null): string {
  const match = header?.match(/filename="([^"]+)"/);
  return match?.[1] ?? "pedidos.xlsx";
}

/**
 * Descargar. Un solo botón con dos alcances: si hay casillas marcadas baja la
 * SELECCIÓN, y si no, todo lo filtrado.
 *
 * El número siempre está a la vista porque en los dos casos difiere de lo que
 * se ve en pantalla: sin selección la tabla enseña 100 y el fichero trae las
 * 128 del filtro; con selección las marcadas pueden estar en otra página. Y
 * cuando hay selección se dice la palabra, no solo la cifra: «(100)» a secas se
 * confundiría con el total del filtro justo cuando ambos valen lo mismo.
 */
function ExportButton({
  busy,
  total,
  selected,
  onClick,
}: {
  busy: boolean;
  total: number;
  selected: number;
  onClick: () => void;
}) {
  if (!total && !selected) return null;
  const count = selected || total;
  const label = selected
    ? `Descargar Excel (${selected.toLocaleString("es-PE")} seleccionados)`
    : `Descargar Excel (${total.toLocaleString("es-PE")})`;
  return (
    <button
      onClick={onClick}
      disabled={busy}
      title={
        selected
          ? `Descargar en Excel los ${count.toLocaleString("es-PE")} pedidos seleccionados`
          : `Descargar ${count.toLocaleString("es-PE")} ${count === 1 ? "pedido" : "pedidos"} en Excel, con los filtros aplicados`
      }
      className="rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-40"
    >
      {busy ? "Generando…" : label}
    </button>
  );
}

/**
 * El buscador del Master, con su propio estado.
 *
 * POR QUÉ VIVE APARTE. El estado del texto estaba en `OrdersMasterBoard`, que es
 * el mismo componente que pinta la tabla: 100 filas × 17 columnas, más badges y
 * botones por celda. Cada pulsación disparaba un render del board entero —unos
 * dos mil elementos— antes de que la letra llegara a la pantalla, y eso se nota
 * como que el input se atasca y se come teclas. El debounce no lo arreglaba
 * porque el coste no estaba en el viaje al servidor sino en el render local.
 *
 * Aislado aquí, teclear solo re-renderiza este input. El board se entera una
 * sola vez, cuando el texto se asienta y `onCommit` reescribe la URL.
 */
function MasterSearchInput({
  value,
  onCommit,
}: {
  value: string;
  onCommit: (next: string) => void;
}) {
  const [text, setText] = useState(value);
  // `onCommit` se rehace en cada render del padre. Guardarlo en una ref evita
  // que el temporizador se reinicie por eso y nunca llegue a disparar.
  const commit = useRef(onCommit);
  commit.current = onCommit;

  // La URL manda: atrás/adelante del navegador o «limpiar filtros» tienen que
  // verse reflejados en el input.
  useEffect(() => {
    setText(value);
  }, [value]);

  useEffect(() => {
    if (text.trim() === value.trim()) return;
    const timer = setTimeout(() => commit.current(text.trim()), 350);
    return () => clearTimeout(timer);
  }, [text, value]);

  return (
    <div className="relative">
      <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400">
        🔍
      </span>
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Buscar pedido, cliente, teléfono o guía…"
        className="w-72 rounded-lg border border-slate-200 py-1.5 pl-8 pr-7 text-sm"
      />
      {text && (
        <button
          onClick={() => setText("")}
          className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
        >
          ✕
        </button>
      )}
    </div>
  );
}

function PagerControls({
  page,
  totalPages,
  busy,
  onPage,
}: {
  page: number;
  totalPages: number;
  busy: boolean;
  onPage: (page: number) => void;
}) {
  if (totalPages <= 1) return null;
  return (
    <div className="flex shrink-0 items-center gap-1.5">
      <button
        disabled={busy || page <= 1}
        onClick={() => onPage(page - 1)}
        className="rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-40"
      >
        Anterior
      </button>
      <span className="px-1 text-xs tabular-nums text-slate-500">
        {page} / {totalPages}
      </span>
      <button
        disabled={busy || page >= totalPages}
        onClick={() => onPage(page + 1)}
        className="rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-40"
      >
        Siguiente
      </button>
    </div>
  );
}

function Pager({
  page,
  totalPages,
  total,
  shown,
  busy,
  onPage,
}: {
  page: number;
  totalPages: number;
  total: number;
  shown: number;
  busy: boolean;
  onPage: (page: number) => void;
}) {
  if (total === 0) return null;
  const from = (page - 1) * 100 + 1;
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 px-4 py-3">
      <p className="text-xs text-slate-500">
        {from}–{from + shown - 1} de {total.toLocaleString("es-PE")}
        {busy && <span className="ml-2 text-slate-400">actualizando…</span>}
      </p>
      <PagerControls page={page} totalPages={totalPages} busy={busy} onPage={onPage} />
    </div>
  );
}
