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

import { useEffect, useMemo, useRef, useState, useTransition, type ReactNode } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { Card, cn, EmptyState, STICKY_HEAD, TABLE_LAYER, TABLE_WRAP_PAGE_X } from "@/components/ui";
import {
  frozenCellStyle,
  frozenOffsets,
  frozenTextWidth,
  type FrozenKey,
} from "@/lib/master-table-columns";
import { AliclikGuidePanel } from "@/components/aliclik-guide-panel";
import { CopyButton } from "@/components/copy-button";
import { AliclikCoverageProbe } from "@/components/aliclik-coverage-probe";
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
import { fenixOutputIsCancelable, manualOutputIsCancelable } from "@/lib/shipment-output";
import {
  addOrderComment,
  cancelFenixOutput,
  cancelManualRouteOutput,
  clearOrderGeo,
  createManualRouteOutputsBulk,
  getOrderMasterChangeToken,
  loadOrderDetail,
  resolveLabelsForOrders,
  loadOrderGeo,
  applyOrderStatusBulk,
  loadConfirmationBrief,
  registerConfirmationAttempt,
  descartarRecuperacion,
  registerReturn,
  registerClosureAction,
  relinkGuide,
  setOrderStatus,
  setStoreConfirmationCycle,
  updateOrderGeo,
  type BulkRouteOutputFailure,
  type ManualRouteCourier,
  type MasterActionState,
  type OrderGeoInput,
} from "@/app/dashboard/pedidos/actions";
import { limaTodayKey } from "@/lib/shipments";
import { COURIER_TBD } from "@/lib/shipment-output";
import {
  AGENCY_COURIER_OPTIONS,
  needsAttestedAgencyShipment,
} from "@/lib/agency-attested-shipment";
import {
  agencyHasActivity,
  emptyFilters,
  hasActiveFilters,
  MANAGEMENT_DAY_STEPS,
  managementDayLabel,
  PAYMENT_CHECK_OPTIONS,
  type AgencySummary,
  type MasterFilters,
  type MasterSortKey,
} from "@/lib/order-master-filters";
import { buildMasterQuery } from "@/lib/master-query";
import { OrderLineItems } from "@/components/order-line-items";
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
import { PAYMENT_GATEWAY_LABEL } from "@/lib/payment-gateway";
import {
  CONFIRMATION_CHANNELS,
  CONFIRMATION_MAX_DAYS,
  CONFIRMATION_RESULTS,
  confirmationChannelLabel,
  confirmationDays,
  confirmationDueBucket,
  confirmationResult,
  confirmationResultLabel,
  limaDayKey,
} from "@/lib/order-confirmation";
import {
  MASTER_VIEWS,
  type MasterCounts,
  type MasterView,
  type ConfirmationDueCounts,
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
  needsConfirmationBrief,
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

import { fmtDate, fmtDateTime, fmtAge, CoverageBadge, MacroStageBadge } from "@/components/order-master-shared";
import { DRAWER_SECTION_IDS, OrderDrawer, type DrawerSectionId, type DrawerWorkspaceView } from "@/components/order-drawer";
import { workspaceForDrawerSection } from "@/lib/order-drawer-href";

export function OrdersMasterBoard({
  stores,
  view,
  substage,
  counts,
  substageCounts,
  confirmationDueCounts,
  managementDayCounts,
  confirmationCycles,
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
  confirmationDueCounts: ConfirmationDueCounts;
  /**
   * Pedidos en cada paso de la escalera de gestión, contados sobre la consulta
   * vigente. Vacío fuera de «Por confirmar», que es donde el filtro se ofrece.
   */
  managementDayCounts: Record<number, number>;
  /** Ciclo de recontacto por tienda (§6.1). Vacío fuera de «Por confirmar». */
  confirmationCycles: ConfirmationCycleOption[];
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
  const searchParams = useSearchParams();
  // ABRIR UN PEDIDO DESDE FUERA. La cola de cobranza avisa de un comprobante
  // que espera y tiene que llevar a donde SE HACE ese trabajo: el drawer del
  // pedido, con la sección de Cobro delante. El drawer carga el pedido por su
  // id, así que no hace falta que la fila esté en la página ni tocar filtros.
  const abrir = searchParams.get("abrir");
  const irA = searchParams.get("ir");
  const focusSection = DRAWER_SECTION_IDS.includes(irA as DrawerSectionId)
    ? (irA as DrawerSectionId)
    : undefined;
  useEffect(() => {
    if (abrir) setOpenId(abrir);
  }, [abrir]);
  const [openWorkspace, setOpenWorkspace] = useState<DrawerWorkspaceView>("operar");
  const changeToken = useRef<string | null>(null);
  // `?abrir=<pedido>&seccion=historial` abre el drawer en la pestaña Actividad
  // sin que nadie tenga que buscar el pedido. Es la convención del Master; el
  // resto del panel abre la misma ficha con `?ficha=` (order-drawer-host.tsx).
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const abrir = params.get("abrir");
    if (!abrir) return;
    setOpenWorkspace(workspaceForDrawerSection(params.get("seccion")));
    setOpenId(abrir);
  }, []);
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

  useEffect(() => {
    let stopped = false;
    const check = async () => {
      if (document.visibilityState !== "visible" || navigating) return;
      const next = await getOrderMasterChangeToken();
      if (stopped || !next) return;
      if (changeToken.current === null) {
        changeToken.current = next;
        return;
      }
      if (next !== changeToken.current) {
        changeToken.current = next;
        router.refresh();
      }
    };
    void check();
    const interval = window.setInterval(() => void check(), 45_000);
    const onVisible = () => {
      if (document.visibilityState === "visible") void check();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopped = true;
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [navigating, router]);

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
  // El ciclo es POR TIENDA, así que el control obedece al filtro de tienda: sin
  // filtro se leen todas y con una sola se puede cambiar la suya.
  const cyclesInScope = useMemo(
    () =>
      filters.stores.size === 0
        ? confirmationCycles
        : confirmationCycles.filter((c) => filters.stores.has(c.storeId)),
    [confirmationCycles, filters.stores],
  );

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
              Almacén · Entregas a couriers
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
                showConfirmation={view === "por_confirmar"}
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
            {view === "por_confirmar" &&
              (substage === null || substage === "volver_a_contactar") && (
                <div className="flex items-center gap-2 overflow-x-auto pb-1">
                  <span className="shrink-0 text-[11px] font-bold uppercase tracking-[0.12em] text-slate-400">
                    Fecha pactada
                  </span>
                  {([
                    ["", "Todos los plazos", confirmationDueCounts.all],
                    ["vencido", "Vencidos", confirmationDueCounts.vencido],
                    ["hoy", "Hoy", confirmationDueCounts.hoy],
                    ["proximo", "Próximos", confirmationDueCounts.proximo],
                  ] as const).map(([value, label, count]) => (
                    <button
                      key={value || "todos"}
                      type="button"
                      onClick={() => patch({ confirmationDue: value })}
                      className={cn(
                        "shrink-0 rounded-full border px-3 py-1 text-xs font-medium transition",
                        filters.confirmationDue === value
                          ? "border-indigo-600 bg-indigo-50 text-indigo-800"
                          : "border-slate-200 bg-white text-slate-600 hover:border-slate-300",
                      )}
                    >
                      {label} · {count.toLocaleString("es-PE")}
                    </button>
                  ))}
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
            {/* Las opciones son fijas, no una faceta: «rechazado» tiene que
                poder pedirse aunque hoy no haya ninguno, que es justo cuando
                interesa comprobar que no hay ninguno. */}
            <ChecklistFilter
              label="Cobro del courier"
              options={PAYMENT_CHECK_OPTIONS.map((o) => o.value)}
              selected={filters.paymentChecks}
              onChange={(paymentChecks) => patch({ paymentChecks })}
              capitalize={false}
              optionLabel={(v) =>
                PAYMENT_CHECK_OPTIONS.find((o) => o.value === v)?.label ?? v
              }
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
            {/* Solo donde la columna Gestión se ve. Un filtro por una columna
                que no está en pantalla filtraría a ciegas: el usuario vería la
                lista encogerse sin nada que se lo explique. */}
            {view === "por_confirmar" && (
              <ChecklistFilter
                label="Gestión"
                options={MANAGEMENT_DAY_STEPS.map(String)}
                selected={filters.managementDays}
                onChange={(managementDays) => patch({ managementDays })}
                capitalize={false}
                optionLabel={managementDayLabel}
                counts={managementDayCounts}
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
              {/* El ciclo de recontacto vive acá y no en la fila de los chips:
                  se toca una vez cada mucho —es un ajuste de tienda, no un
                  filtro del día— y arriba le robaba un renglón entero a la cola,
                  que es lo que sí se mira todo el rato. */}
              {view === "por_confirmar" && cyclesInScope.length > 0 && (
                <div className="border-t border-slate-100 pt-3">
                  <ConfirmationCycleControl cycles={cyclesInScope} />
                </div>
              )}
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
                  showConfirmation={view === "por_confirmar"}
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
          focusSection={openId === abrir ? focusSection : undefined}
          onClose={() => {
            setOpenId(null);
            setOpenWorkspace("operar");
            // Se limpia la URL al cerrar: si no, recargar reabriría un pedido
            // que ya se atendió, y el enlace de la alerta quedaría pegado.
            if (abrir) {
              const next = new URLSearchParams(searchParams.toString());
              next.delete("abrir");
              next.delete("ir");
              const qs = next.toString();
              router.replace(qs ? `${pathname}?${qs}` : pathname);
            }
          }}
          onSaved={() => router.refresh()}
          initialWorkspace={openWorkspace}
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

export interface ConfirmationCycleOption {
  storeId: string;
  storeName: string;
  days: number;
  /** Owner o admin de la organización de ESA tienda. */
  canEdit: boolean;
}

/** Los ciclos que se ofrecen. Fuera de la lista se sigue guardando lo que haya. */
const CYCLE_CHOICES = [1, 2, 3, 4, 5, 7, 10, 14, 21, 30] as const;

/**
 * El ciclo de recontacto, junto a los chips de «Fecha pactada».
 *
 * ESTÁ AQUÍ Y NO SOLO EN AJUSTES porque su efecto es el número de al lado: quien
 * lo mueve ve «Hoy» cambiar en el mismo renglón. En Ajustes —una página de
 * tokens y webhooks— sería una perilla a ciegas.
 *
 * CON VARIAS TIENDAS NO SE EDITA, SE LEE. El ajuste es por tienda y el Master es
 * consolidado; ofrecer un solo control con Aurela y Kenku a la vista daría a
 * elegir un valor que no existe. Se listan los dos y se pide filtrar por tienda,
 * que es un clic y deja claro sobre cuál se está mandando.
 */
const cycleLabel = (days: number) => `${days} ${days === 1 ? "día" : "días"}`;

function ConfirmationCycleControl({ cycles }: { cycles: ConfirmationCycleOption[] }) {
  if (!cycles.length) return null;

  const label = (
    <span className="shrink-0 text-[11px] font-bold uppercase tracking-[0.12em] text-slate-400">
      Ciclo sin fecha pactada
    </span>
  );

  if (cycles.length > 1) {
    return (
      <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
        {label}
        <span>{cycles.map((c) => `${c.storeName} ${c.days} d`).join(" · ")}</span>
        <span className="text-slate-400">— filtra por tienda para cambiarlo</span>
      </div>
    );
  }

  const cycle = cycles[0]!;
  if (!cycle.canEdit) {
    return (
      <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
        {label}
        <span className="font-medium text-slate-700">{cycleLabel(cycle.days)}</span>
        <span className="text-slate-400">— lo cambia un owner o admin de la tienda</span>
      </div>
    );
  }

  return <ConfirmationCycleSelect cycle={cycle} label={label} />;
}

function ConfirmationCycleSelect({
  cycle,
  label,
}: {
  cycle: ConfirmationCycleOption;
  label: ReactNode;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [feedback, setFeedback] = useState<MasterActionState | null>(null);
  // El valor elegido se pinta ya, sin esperar al viaje al servidor: con el
  // `value` colgado solo de la prop, el desplegable volvía al número viejo hasta
  // que llegara el refresco y parecía que el cambio no había prendido.
  const [days, setDays] = useState(cycle.days);
  useEffect(() => setDays(cycle.days), [cycle.days]);

  const choices = CYCLE_CHOICES.includes(days as (typeof CYCLE_CHOICES)[number])
    ? [...CYCLE_CHOICES]
    : [...CYCLE_CHOICES, days].sort((a, b) => a - b);

  return (
    <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
      {label}
      <select
        value={days}
        disabled={pending}
        onChange={(e) => {
          const next = Number(e.target.value);
          if (next === days) return;
          const previous = days;
          setDays(next);
          setFeedback(null);
          startTransition(async () => {
            const state = await setStoreConfirmationCycle(cycle.storeId, next);
            setFeedback(state);
            if (state.error) {
              setDays(previous);
              return;
            }
            // Los chips de «Fecha pactada» se cuentan en el servidor: sin
            // refrescar, el ciclo nuevo no se vería en los números de al lado,
            // que es justo lo que este control tiene que dejar ver.
            router.refresh();
          });
        }}
        className="rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs text-slate-700 disabled:opacity-50"
      >
        {choices.map((option) => (
          <option key={option} value={option}>
            {cycleLabel(option)}
          </option>
        ))}
      </select>
      {feedback?.error ? (
        <span className="text-rose-600">{feedback.error}</span>
      ) : feedback?.notice ? (
        <span className="text-emerald-700">{feedback.notice}</span>
      ) : (
        <span className="text-slate-400">
          Sin fecha pactada, el pedido vuelve a «Hoy» cada {cycleLabel(days)}.
        </span>
      )}
    </div>
  );
}

/**
 * La celda «Próximo contacto». Sigue el mismo orden de mando que
 * `confirmationQueueBucket`: fecha pactada, recordatorio de dos horas vigente y
 * ciclo automático.
 *
 * El ciclo se pinta distinto A PROPÓSITO. Una fecha pactada es un compromiso con
 * el cliente y quien la lee tiene que poder decir «esto lo prometí yo»; el ciclo
 * lo puso Kapta para que el pedido no desaparezca. Mostrarlos iguales convertiría
 * una derivación en una promesa que nadie hizo.
 */
function NextContactCell({ row, now }: { row: OrderMasterRow; now?: string }) {
  const today = limaDayKey(now ?? new Date().toISOString());
  if (row.confirmation_next_contact_on) {
    return <>{fmtDate(`${row.confirmation_next_contact_on}T12:00:00.000Z`)}</>;
  }
  const reminder = row.confirmation_reminder_due_at;
  // El recordatorio manda siempre que exista, también uno de días atrás: ese es
  // un reintento que nadie hizo y su hora, ya pasada, es justo lo que hay que
  // ver. La celda tiene que decir lo mismo que la cola (`confirmationQueueBucket`).
  if (reminder) return <>{fmtDateTime(reminder)}</>;
  const cycle = row.confirmation_cycle_due_on;
  if (!cycle) {
    // Sin fecha, sin recordatorio y sin ciclo: nunca se le ha llamado, y la
    // primera llamada toca hoy. La celda dice lo mismo que la cola.
    return (
      <span className="inline-flex flex-col leading-tight">
        <span>Hoy</span>
        <span className="text-[11px] text-slate-400">primera llamada</span>
      </span>
    );
  }
  return (
    <span className="inline-flex flex-col leading-tight">
      <span>{cycle <= today ? "Hoy" : fmtDate(`${cycle}T12:00:00.000Z`)}</span>
      <span className="text-[11px] text-slate-400">ciclo automático</span>
    </span>
  );
}

function MasterTable({
  rows,
  storeName,
  multiStore,
  showConfirmation,
  onOpen,
  selected,
  onToggleRow,
  onToggleAll,
}: {
  rows: OrderMasterRow[];
  storeName: (id: string) => string;
  multiStore: boolean;
  showConfirmation: boolean;
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
  // La geometría vive en lib/master-table-columns.ts, con pruebas: el
  // desplazamiento de cada una es la suma de los anchos de las anteriores, así
  // que esos anchos tienen que ser TECHO y no sugerencia. Sin `maxWidth`, un
  // nombre de cliente largo ensanchaba la columna y cizallaba la tabla entera.
  const left = frozenOffsets(multiStore);
  /** Props de una celda congelada. El fondo se HEREDA de la fila: así sigue el
   *  hover y el resaltado de selección, que en un color fijo se perderían. */
  //
  // Las capas salen de TABLE_LAYER, no de números sueltos: la esquina congelada
  // estaba en 30, empatada con los desplegables de filtro, y los tapaba — pero
  // solo los de la izquierda, que son los que caen encima de ella.
  const frozen = (key: FrozenKey, header = false) => ({
    className: cn("sticky", header ? "bg-slate-50" : "bg-inherit"),
    style: frozenCellStyle(
      key,
      left,
      header ? TABLE_LAYER.frozenHead : TABLE_LAYER.frozenCell,
    ),
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
            {showConfirmation && (
              <>
                <th className="px-2 py-2 font-medium">Gestión</th>
                <th className="px-2 py-2 font-medium">Próximo contacto</th>
              </>
            )}
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
              <td {...frozen("cliente")} className={cn(frozen("cliente").className, "px-2 py-2.5 text-slate-700")}>
                {/* El recorte va en un bloque propio, no en el `<td>`: `max-width`
                    sobre una celda de tabla no es fiable, y sin un techo real
                    `truncate` no tiene contra qué recortar. El nombre entero
                    sigue a un `title` de distancia. */}
                <span
                  className="block truncate"
                  style={{ maxWidth: frozenTextWidth("cliente") }}
                  title={r.customer_name ?? ""}
                >
                  {r.customer_name ?? "—"}
                </span>
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
              {showConfirmation && (
                <>
                  <td className="px-2 py-2.5 text-slate-600">
                    {r.macro_substage === "historico_sin_gestion"
                      ? "Fuera del corte"
                      : `${r.confirmation_day_count ?? 0}/7 días`}
                  </td>
                  <td className="px-2 py-2.5 text-slate-600">
                    <NextContactCell row={r} />
                  </td>
                </>
              )}
              <td className="px-2 py-2.5 text-slate-600">{fmtDate(r.last_movement_at)}</td>
              <td className="px-4 py-2.5 text-slate-600">{fmtAge(r.macro_since ?? r.status_since)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
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

