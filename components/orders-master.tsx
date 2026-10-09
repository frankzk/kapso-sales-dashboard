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

import { useCallback, useEffect, useId, useMemo, useRef, useState, useTransition, type ReactNode } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { cn } from "@/components/ui";
import {
  AttentionPill,
  Badge,
  Banner,
  CHECKBOX,
  ChoiceChip,
  FIELD,
  FIELD_BOX,
  FilterPill,
  OpsButton,
  StatusCard,
  opsButtonClass,
} from "@/components/ops-ui";
import { Sheet } from "@/components/filter-sheet";
import { FacetPill } from "@/components/facet-pill";
import {
  IconClock,
  IconDownload,
  IconPackage,
  IconSearch,
  IconTruck,
  IconUndo,
  IconX,
} from "@/components/icons";
import { AliclikGuidePanel } from "@/components/aliclik-guide-panel";
import { CopyButton } from "@/components/copy-button";
import { AliclikCoverageProbe } from "@/components/aliclik-coverage-probe";
import { DirectFenixGuideModal } from "@/components/direct-fenix-guide-modal";
import { ManualRouteOutputModal } from "@/components/manual-route-output-modal";
import { OrderClosureDesk } from "@/components/order-closure-desk";
import { OrderRouteDesk } from "@/components/order-route-desk";
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
  MASTER_SEARCH_MIN_CHARS,
  masterSearchTerm,
  PAYMENT_CHECK_OPTIONS,
  SWAYP_AVAILABILITY_OPTIONS,
  type AgencySummary,
  type MasterFilters,
  type MasterSortKey,
} from "@/lib/order-master-filters";
import { buildMasterQuery } from "@/lib/master-query";
import { receiveSearchValue, shouldSendSearch } from "@/lib/search-input-echo";
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

import { fmtDate, fmtDateTime, fmtAge, CoverageBadge, MacroStageBadge, MacroStageDot } from "@/components/order-master-shared";
import { DRAWER_SECTION_IDS, OrderDrawer, type DrawerSectionId, type DrawerWorkspaceView } from "@/components/order-drawer";
import { workspaceForDrawerSection } from "@/lib/order-drawer-href";
import { hasCombinedGuide, type CombinedGuideCourier } from "@/lib/labels/guia-combinada-select";

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
  canExport = false,
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
  /** Descargar el Excel (`data.export`, 08-10-2026): owner, admin o concedido en Equipo. */
  canExport?: boolean;
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
  // En el teléfono las píldoras viven detrás de una sola («Filtros»): diez
  // píldoras en cuatro renglones empujaban el primer pedido dos pantallas abajo.
  const [phoneFilters, setPhoneFilters] = useState(false);
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
  const [exportNote, setExportNote] = useState<{ tone: "warn" | "crit"; text: string } | null>(null);

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
        setExportNote({
          tone: "warn",
          text: `El listado supera el máximo por descarga: se exportaron las primeras ${rows.toLocaleString("es-PE")} filas. Acota los filtros para bajar el resto.`,
        });
      }
    } catch {
      setExportNote({ tone: "crit", text: "No se pudo generar el Excel. Vuelve a intentarlo." });
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


  // La MISMA regla que usa el servidor para decidir que se está buscando: si
  // cada lado midiera por su cuenta, la pantalla enseñaría pestañas mientras el
  // servidor ya las ignora (o al revés).
  const searchActive = masterSearchTerm(filters) !== "";
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
  // El courier de cada pedido visto, para saber si la selección tiene guía
  // combinada (Tanders o Shalom). Sobrevive a cambiar de página, como los nombres.
  const [seenCouriers, setSeenCouriers] = useState<Map<string, string>>(new Map());
  useEffect(() => {
    setSeenCouriers((prev) => {
      const next = new Map(prev);
      let changed = false;
      for (const row of rows) {
        const courier = row.current_courier ?? row.last_courier ?? "";
        if (next.get(row.order_id) !== courier) {
          next.set(row.order_id, courier);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [rows]);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  const multiStore = stores.length > 1;
  const filtering = hasActiveFilters(filters);
  const moreCount = moreFilterCount(filters);
  const pillCount = pillFilterCount(filters, view === "por_confirmar") + (moreCount > 0 ? 1 : 0);
  const scope =
    stores.length === 1
      ? "de la tienda"
      : stores.length === 2
        ? "de las dos tiendas"
        : `de las ${stores.length.toLocaleString("es-PE")} tiendas`;
  const goToPage = (p: number) => navigate({ page: p });

  return (
    <div className="space-y-6">
      {/* Título y contexto a la izquierda; búsqueda y estaciones a la derecha.
          En pantallas más angostas las acciones bajan bajo el título. */}
      <header className="grid items-start gap-x-6 gap-y-3 min-[1400px]:grid-cols-[minmax(0,1fr)_auto]">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
            <h1 className="text-[28px] font-bold leading-9 tracking-[-0.01em] text-ink-900">Master de Pedidos</h1>
            {!canEdit && <Badge>Solo lectura</Badge>}
          </div>
          <p className="mt-1 text-sm text-ink-500">Estado real de cada pedido {scope}, con su historial completo.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2 min-[1400px]:pt-0.5">
          <MasterSearchInput value={filters.search} onCommit={commitSearch} />
          {canWarehouse && (
            <Link href="/dashboard/pedidos/almacen" className={opsButtonClass("secondary", "md", "pointer-coarse:h-11")}>
              <IconPackage className="text-ink-500" />
              Almacén
            </Link>
          )}
          {canDispatch && (
            <Link href="/dashboard/pedidos/despacho" className={opsButtonClass("secondary", "md", "pointer-coarse:h-11")}>
              <IconTruck className="text-ink-500" />
              Almacén · Entregas a couriers
            </Link>
          )}
          {/* El registro del botón «Enviar por Swayp» (MOM §11.11), donde nace. */}
          {view === "por_confirmar" && (
            <Link href="/dashboard/pedidos/swayp-desde-confirmar" className={opsButtonClass("ghost", "md", "pointer-coarse:h-11")}>
              Swayp desde Por confirmar
            </Link>
          )}
        </div>
      </header>

      {searchActive ? (
        <section aria-label="Resultados de búsqueda" aria-busy={navigating || undefined} className={CARD}>
          <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-5">
            <p className="text-sm text-ink-700">
              <b className="font-semibold tabular-nums text-ink-900">{total.toLocaleString("es-PE")}</b>{" "}
              {total === 1 ? "resultado" : "resultados"} de búsqueda
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <PagerControls page={page} totalPages={totalPages} busy={navigating} onPage={goToPage} />
              <OpsButton variant="ghost" size="sm" onClick={() => commitSearch("")} className="pointer-coarse:h-11">
                Limpiar búsqueda
              </OpsButton>
            </div>
          </div>
          {searching ? (
            <p className="border-t border-line px-4 py-8 text-sm text-ink-500 sm:px-5">Buscando…</p>
          ) : listed.length ? (
            <>
              <MasterTable
                rows={shown}
                storeName={storeName}
                multiStore={multiStore}
                showConfirmation={view === "por_confirmar"}
                onOpen={setOpenId}
                openId={openId}
                selected={selectedIds}
                onToggleRow={toggleRow}
                onToggleAll={toggleAll}
                busy={navigating}
              />
              <Pager
                page={page}
                pageSize={pageSize}
                totalPages={totalPages}
                total={total}
                shown={shown.length}
                busy={navigating}
                onPage={goToPage}
              />
            </>
          ) : (
            <p className="border-t border-line px-4 py-8 text-sm text-ink-500 sm:px-5">
              Sin coincidencias. Prueba con el código del pedido, el teléfono o la guía.
            </p>
          )}
        </section>
      ) : (
        <>
          {agencyHasActivity(agency) && (
            <AgencyLine summary={agency} filters={filters} onFilter={(next) => patch(next)} />
          )}

          {/* Las macroetapas son la navegación: siete cifras que filtran, con
              el tono del MOM (§25) en un cuadro que sirve de leyenda de las
              chapas de la tabla. Debajo, las subetapas de la abierta. */}
          <section aria-label="Macroetapas del pedido" className="space-y-3">
            <div role="group" aria-label="Macroetapa" className="grid grid-cols-2 gap-2 sm:grid-cols-4 xl:grid-cols-7">
              {MASTER_VIEWS.map((stage) => (
                <StatusCard
                  key={stage.key}
                  label={stage.label}
                  value={counts[stage.key]}
                  active={stage.key === view}
                  onClick={() => navigateStage(stage.key)}
                  marker={stage.key === "todos" ? undefined : <MacroStageDot stage={stage.key} />}
                />
              ))}
            </div>

            {view !== "todos" && (
              <div role="group" aria-label="Subetapa" className="flex flex-wrap items-center gap-1.5">
                <span className="mr-1 text-[13px] font-medium text-ink-600">Subetapa</span>
                <ChoiceChip
                  label="Todas"
                  count={counts[view]}
                  active={substage === null}
                  onClick={() => navigateStage(view)}
                />
                {stageSubstages.map((stageSubstage) => (
                  <ChoiceChip
                    key={stageSubstage}
                    label={macroSubstageLabel(stageSubstage)}
                    count={substageCounts[stageSubstage] ?? 0}
                    active={substage === stageSubstage}
                    onClick={() => navigateStage(view, stageSubstage)}
                  />
                ))}
              </div>
            )}
            {view === "por_confirmar" &&
              (substage === null || substage === "volver_a_contactar") && (
                <div role="group" aria-label="Fecha pactada" className="flex flex-wrap items-center gap-1.5">
                  <span className="mr-1 text-[13px] font-medium text-ink-600">Fecha pactada</span>
                  {([
                    ["", "Todos los plazos", confirmationDueCounts.all],
                    ["vencido", "Vencidos", confirmationDueCounts.vencido],
                    ["hoy", "Hoy", confirmationDueCounts.hoy],
                    ["proximo", "Próximos", confirmationDueCounts.proximo],
                  ] as const).map(([value, label, count]) => (
                    <ChoiceChip
                      key={value || "todos"}
                      label={label}
                      count={count}
                      active={filters.confirmationDue === value}
                      onClick={() => patch({ confirmationDue: value })}
                    />
                  ))}
                </div>
              )}
          </section>

          {/* Filtros: píldoras discontinuas que se vuelven sólidas con su valor. */}
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2 sm:hidden">
              <FilterPill
                label="Filtros"
                active={pillCount > 0}
                count={pillCount > 0 ? pillCount : undefined}
                expanded={phoneFilters}
                onClick={() => setPhoneFilters((v) => !v)}
                onClear={pillCount > 0 ? () => patch(CLEARED_PILL_FILTERS) : undefined}
              />
            </div>
            <div
              role="group"
              aria-label="Filtros"
              className={cn("flex flex-wrap items-center gap-2", !phoneFilters && "max-sm:hidden")}
            >
              {multiStore && (
                <FacetPill
                  label="Tienda"
                  allLabel="Todas las tiendas"
                  options={stores.map((s) => ({ value: s.id, label: s.name }))}
                  selected={filters.stores}
                  onChange={(next) => patch({ stores: next })}
                />
              )}
              <FacetPill
                label="Estado operativo"
                allLabel="Todos los estados"
                options={facets.operational.map((v) => ({ value: v, label: v }))}
                selected={filters.operationalStatuses}
                onChange={(operationalStatuses) => patch({ operationalStatuses })}
              />
              <FacetPill
                label="Courier"
                allLabel="Todos los couriers"
                options={facets.courier.map((v) => ({ value: v, label: cap(v) }))}
                selected={filters.couriers}
                onChange={(couriers) => patch({ couriers })}
              />
              {/* Las opciones son fijas, no una faceta: «rechazado» tiene que
                  poder pedirse aunque hoy no haya ninguno, que es justo cuando
                  interesa comprobar que no hay ninguno. */}
              <FacetPill
                label="Cobro del courier"
                allLabel="Todos los cobros"
                options={PAYMENT_CHECK_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
                selected={filters.paymentChecks}
                onChange={(paymentChecks) => patch({ paymentChecks })}
              />
              <FacetPill
                label="Región"
                allLabel="Todas las regiones"
                options={facets.region.map((v) => ({ value: v, label: cap(v) }))}
                selected={filters.regions}
                onChange={(regions) => patch({ regions })}
              />
              <FacetPill
                label="Provincia"
                allLabel="Todas las provincias"
                options={facets.province.map((v) => ({ value: v, label: cap(v) }))}
                selected={filters.provinces}
                onChange={(provinces) => patch({ provinces })}
              />
              <FacetPill
                label="Distrito"
                allLabel="Todos los distritos"
                options={facets.district.map((v) => ({ value: v, label: cap(v) }))}
                selected={filters.districts}
                onChange={(districts) => patch({ districts })}
              />
              <FacetPill
                label="Cobertura"
                allLabel="Todas las coberturas"
                options={facets.coverage.map((v) => ({
                  value: v,
                  label: ORDER_COVERAGE_LABEL[v as OrderCoverage] ?? v,
                }))}
                selected={filters.coverages}
                onChange={(coverages) => patch({ coverages })}
              />
              {/* La misma pregunta que el filtro «Swayp» de Repro Provincia, sobre
                  el pedido: ¿lo puede llevar Swayp hoy? Opciones fijas, como el
                  cobro del courier: «Sin stock» tiene que poder pedirse aunque
                  hoy no haya ninguno. Se calcula cada hora (0235). */}
              <FacetPill
                label="Swayp"
                allLabel="Con y sin stock Swayp"
                options={SWAYP_AVAILABILITY_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
                selected={filters.swaypAvailability}
                onChange={(swaypAvailability) => patch({ swaypAvailability })}
              />
              {facets.pickup.length > 0 && (
                <FacetPill
                  label="Agencia"
                  allLabel="Todos los estados de agencia"
                  options={facets.pickup.map((v) => ({ value: v, label: v }))}
                  selected={filters.pickupStates}
                  onChange={(pickupStates) => patch({ pickupStates })}
                />
              )}
              {/* Solo donde la columna Gestión se ve. Un filtro por una columna
                  que no está en pantalla filtraría a ciegas: el usuario vería la
                  lista encogerse sin nada que se lo explique. El cero se enseña:
                  saber que nadie está en un paso es información. */}
              {view === "por_confirmar" && (
                <FacetPill
                  label="Gestión"
                  allLabel="Todos los días de gestión"
                  options={MANAGEMENT_DAY_STEPS.map((step) => ({
                    value: String(step),
                    label: managementDayLabel(String(step)),
                    count: managementDayCounts[step] ?? 0,
                  }))}
                  selected={filters.managementDays}
                  onChange={(managementDays) => patch({ managementDays })}
                />
              )}
              <FilterPill
                label="Más filtros"
                active={moreCount > 0}
                count={moreCount > 0 ? moreCount : undefined}
                expanded={showMore}
                onClick={() => setShowMore((v) => !v)}
                onClear={moreCount > 0 ? () => patch(CLEARED_MORE_FILTERS) : undefined}
                title="Fechas, modalidad, señales y antigüedad sin movimientos"
              />
              {filtering && (
                <OpsButton variant="ghost" size="sm" onClick={() => navigate({ filters: emptyFilters() })} className="pointer-coarse:h-11">
                  Quitar filtros
                </OpsButton>
              )}
            </div>

            {showMore && (
              <MoreFilters
                filters={filters}
                onPatch={patch}
                cycles={view === "por_confirmar" ? cyclesInScope : []}
              />
            )}
          </div>

          <section aria-label="Pedidos" aria-busy={navigating || undefined} className={CARD}>
            <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-5">
              {/* El contador dice el TOTAL de la macroetapa, no las 100 de la
                  página: "100 pedidos" a secas hacía creer que no había más. */}
              <p className="text-sm text-ink-700">
                <b className="font-semibold tabular-nums text-ink-900">{total.toLocaleString("es-PE")}</b>{" "}
                {total === 1 ? "pedido" : "pedidos"}
                {total > listed.length && (
                  <span className="text-ink-500"> · se muestran {listed.length.toLocaleString("es-PE")}</span>
                )}
                <span className="hidden text-ink-500 sm:inline"> · los más recientes primero</span>
              </p>
              <div className="flex flex-wrap items-center gap-2">
                {canExport && (
                  <ExportButton
                    busy={exporting}
                    total={total}
                    selected={selectedIds.size}
                    onClick={() => void downloadExcel()}
                  />
                )}
                <PagerControls page={page} totalPages={totalPages} busy={navigating} onPage={goToPage} />
              </div>
            </div>
            {exportNote && (
              <Banner tone={exportNote.tone} role="status" className="mx-4 mb-3 sm:mx-5">
                {exportNote.text}
              </Banner>
            )}
            {listed.length ? (
              <>
                <MasterTable
                  rows={listed}
                  storeName={storeName}
                  multiStore={multiStore}
                  showConfirmation={view === "por_confirmar"}
                  onOpen={setOpenId}
                  openId={openId}
                  selected={selectedIds}
                  onToggleRow={toggleRow}
                  onToggleAll={toggleAll}
                  busy={navigating}
                />
                {/* Las vistas por macroetapa nunca tuvieron paginador: se veían
                    las primeras 100 de miles y no había forma de llegar al
                    resto. El paginador solo existía en la vista de búsqueda. */}
                <Pager
                  page={page}
                  pageSize={pageSize}
                  totalPages={totalPages}
                  total={total}
                  shown={listed.length}
                  busy={navigating}
                  onPage={goToPage}
                />
              </>
            ) : (
              <div className="flex flex-col items-start gap-3 border-t border-line px-4 py-8 sm:px-5">
                <p className="text-sm text-ink-700">
                  {filtering || substage
                    ? "Ningún pedido cumple los filtros."
                    : "Todavía no hay pedidos aquí."}
                </p>
                {filtering && (
                  <OpsButton size="sm" onClick={() => navigate({ filters: emptyFilters() })} className="pointer-coarse:h-11">
                    Quitar filtros
                  </OpsButton>
                )}
              </div>
            )}
          </section>
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
        orderCouriers={seenCouriers}
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

/** Tarjeta blanca del mundo de operación (DESIGN.md). Sin `overflow-hidden`:
 *  recortaría el encabezado pegajoso de la tabla. */
const CARD = "rounded-lg bg-white shadow-control ring-1 ring-line";

/** Los datos de lugar y courier llegan en minúsculas; se enseñan con mayúscula
 *  inicial sin tocar el valor que viaja en la URL. */
const LOWER_WORDS = new Set(["de", "del", "la", "las", "los", "el", "y"]);
function cap(value: string): string {
  return value.replace(/(^|[\s(/-])(\p{L}+)/gu, (match, sep: string, word: string, offset: number) =>
    offset > 0 && LOWER_WORDS.has(word) ? match : sep + word.charAt(0).toUpperCase() + word.slice(1),
  );
}

/** Lo que vive en «Más filtros». Cuenta los que están puestos, para que la
 *  píldora diga que hay filtros aunque el panel esté cerrado. */
function moreFilterCount(f: MasterFilters): number {
  return [
    f.createdFrom || f.createdTo,
    f.dispatchedFrom || f.dispatchedTo,
    f.movementFrom || f.movementTo,
    f.deliveredFrom || f.deliveredTo,
    f.shippingModes.size > 0,
    f.withComments,
    f.multiCourier,
    f.multiAttempt,
    f.staleDays > 0,
  ].filter(Boolean).length;
}

/** Cuántas píldoras de filtro están puestas (la de Gestión solo cuenta donde se ve). */
function pillFilterCount(f: MasterFilters, withManagement: boolean): number {
  return [
    f.stores,
    f.operationalStatuses,
    f.couriers,
    f.paymentChecks,
    f.regions,
    f.provinces,
    f.districts,
    f.coverages,
    f.swaypAvailability,
    f.pickupStates,
    ...(withManagement ? [f.managementDays] : []),
  ].filter((set) => set.size > 0).length;
}

const CLEARED_MORE_FILTERS: Partial<MasterFilters> = {
  createdFrom: "",
  createdTo: "",
  dispatchedFrom: "",
  dispatchedTo: "",
  movementFrom: "",
  movementTo: "",
  deliveredFrom: "",
  deliveredTo: "",
  shippingModes: new Set(),
  withComments: false,
  multiCourier: false,
  multiAttempt: false,
  staleDays: 0,
};

/** Lo que quita la píldora «Filtros» del teléfono: las píldoras y «Más filtros». */
const CLEARED_PILL_FILTERS: Partial<MasterFilters> = {
  stores: new Set(),
  operationalStatuses: new Set(),
  couriers: new Set(),
  paymentChecks: new Set(),
  regions: new Set(),
  provinces: new Set(),
  districts: new Set(),
  coverages: new Set(),
  swaypAvailability: new Set(),
  pickupStates: new Set(),
  managementDays: new Set(),
  ...CLEARED_MORE_FILTERS,
};

/**
 * Seguimiento de agencia (§10). Es lo que evita la devolución: entre el 5 % y
 * el 6 % de estos pedidos termina devuelto por no recogerse a tiempo, así que
 * lo accionable es ver cuántos están disponibles y cuántos van a vencer.
 *
 * EL RECORRIDO EN CURSO, EN ORDEN FÍSICO, EN UNA SOLA LÍNEA: sale, viaja,
 * llega, se acerca a vencer, se devuelve. Sin total ni estados terminales
 * («Entregados», «Devueltos» ya no piden nada). Las dos primeras cifras se
 * leen; las tres últimas son filtros de un toque.
 */
function AgencyLine({
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
  const num = (n: number) => <b className="font-semibold tabular-nums text-ink-900">{n.toLocaleString("es-PE")}</b>;

  return (
    // `justify-between`: en una línea, cifras a la izquierda y píldoras a la
    // derecha; si no caben, cada parte empieza a la izquierda en su renglón.
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
      <p className="min-w-0 text-[13px] leading-5 text-ink-500">
        <span className="font-semibold text-ink-700">Envíos por agencia</span> · Shalom y Olva ·{" "}
        {num(summary.pendienteDeEnvio)} {summary.pendienteDeEnvio === 1 ? "pendiente" : "pendientes"} de envío ·{" "}
        {num(summary.enTransito)} en tránsito
      </p>
      <div role="group" aria-label="Recojo en agencia" className="flex flex-wrap items-center gap-2">
        <AttentionPill
          icon={IconPackage}
          label="Disponibles para recojo"
          count={summary.disponibles}
          active={disponiblesActive}
          hint="Ya llegaron a la agencia y esperan al cliente. Toca para listarlos."
          onClick={() =>
            onFilter({
              pickupStates: disponiblesActive
                ? new Set()
                : new Set(["disponible_para_recojo", "pendiente_de_recojo"]),
              expiringSoon: false,
            })
          }
        />
        <AttentionPill
          icon={IconClock}
          label="Próximos a vencer"
          count={summary.proximosAVencer}
          active={filters.expiringSoon}
          hint="El plazo de recojo está por vencer: si nadie recoge, la agencia lo devuelve."
          onClick={() => onFilter({ expiringSoon: !filters.expiringSoon, pickupStates: new Set() })}
        />
        <AttentionPill
          icon={IconUndo}
          label="Retorno iniciado"
          count={summary.retornoIniciado}
          active={retornoActive}
          hint="La agencia ya inició la devolución."
          onClick={() =>
            onFilter({
              pickupStates: retornoActive ? new Set() : new Set(["retorno_iniciado"]),
              expiringSoon: false,
            })
          }
        />
      </div>
    </div>
  );
}

/** El panel de «Más filtros»: fechas, modalidad, señales y el ciclo de recontacto. */
function MoreFilters({
  filters,
  onPatch,
  cycles,
}: {
  filters: MasterFilters;
  onPatch: (next: Partial<MasterFilters>) => void;
  cycles: ConfirmationCycleOption[];
}) {
  return (
    <div className={cn(CARD, "space-y-5 p-4 sm:p-5")}>
      <div className="grid min-w-0 gap-4 md:grid-cols-2 2xl:grid-cols-4">
        <DateRange
          label="Creación"
          from={filters.createdFrom}
          to={filters.createdTo}
          onChange={(createdFrom, createdTo) => onPatch({ createdFrom, createdTo })}
        />
        <DateRange
          label="Despacho"
          from={filters.dispatchedFrom}
          to={filters.dispatchedTo}
          onChange={(dispatchedFrom, dispatchedTo) => onPatch({ dispatchedFrom, dispatchedTo })}
        />
        <DateRange
          label="Último movimiento"
          from={filters.movementFrom}
          to={filters.movementTo}
          onChange={(movementFrom, movementTo) => onPatch({ movementFrom, movementTo })}
        />
        <DateRange
          label="Entrega"
          from={filters.deliveredFrom}
          to={filters.deliveredTo}
          onChange={(deliveredFrom, deliveredTo) => onPatch({ deliveredFrom, deliveredTo })}
        />
      </div>
      <div className="flex flex-wrap items-end gap-x-6 gap-y-4">
        <label className="grid gap-1.5">
          <span className="text-[13px] font-medium text-ink-700">Modalidad</span>
          <select
            value={[...filters.shippingModes][0] ?? ""}
            onChange={(e) =>
              onPatch({ shippingModes: e.target.value ? new Set([e.target.value]) : new Set() })
            }
            className={cn(FIELD_BOX, "h-9 w-44 px-3 pointer-coarse:h-11")}
          >
            <option value="">Todas</option>
            <option value="cod">Contraentrega</option>
            <option value="agency">Agencia</option>
          </select>
        </label>
        <label className="grid gap-1.5">
          <span className="text-[13px] font-medium text-ink-700">Sin movimientos hace</span>
          <select
            value={filters.staleDays}
            onChange={(e) => onPatch({ staleDays: Number(e.target.value) })}
            className={cn(FIELD_BOX, "h-9 w-36 px-3 pointer-coarse:h-11")}
          >
            <option value={0}>Sin filtro</option>
            <option value={3}>3 días</option>
            <option value={7}>7 días</option>
            <option value={15}>15 días</option>
            <option value={30}>30 días</option>
          </select>
        </label>
        <fieldset className="flex flex-wrap items-center gap-x-5">
          <legend className="sr-only">Señales del pedido</legend>
          <Toggle
            label="Con comentarios"
            checked={filters.withComments}
            onChange={(withComments) => onPatch({ withComments })}
          />
          <Toggle
            label="Más de un courier"
            checked={filters.multiCourier}
            onChange={(multiCourier) => onPatch({ multiCourier })}
          />
          <Toggle
            label="Más de un intento"
            checked={filters.multiAttempt}
            onChange={(multiAttempt) => onPatch({ multiAttempt })}
          />
        </fieldset>
      </div>
      {/* El ciclo de recontacto vive acá y no en la fila de los chips: se toca
          una vez cada mucho —es un ajuste de tienda, no un filtro del día— y
          arriba le robaba un renglón entero a la cola, que es lo que sí se mira
          todo el rato. */}
      {cycles.length > 0 && (
        <div className="border-t border-line pt-4">
          <ConfirmationCycleControl cycles={cycles} />
        </div>
      )}
    </div>
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
    <label className="flex min-h-9 cursor-pointer items-center gap-2 text-sm text-ink-700 pointer-coarse:min-h-11">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className={CHECKBOX}
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
    <fieldset className="min-w-0">
      <legend className="mb-1.5 text-[13px] font-medium text-ink-700">{label}</legend>
      <div className="flex min-w-0 items-center gap-2">
        <input
          type="date"
          value={from}
          aria-label={`${label}: desde`}
          onChange={(e) => onChange(e.target.value, to)}
          className={cn(FIELD_BOX, "h-9 flex-1 px-2.5 tabular-nums pointer-coarse:h-11")}
        />
        <span aria-hidden className="text-ink-500">–</span>
        <input
          type="date"
          value={to}
          aria-label={`${label}: hasta`}
          onChange={(e) => onChange(from, e.target.value)}
          className={cn(FIELD_BOX, "h-9 flex-1 px-2.5 tabular-nums pointer-coarse:h-11")}
        />
      </div>
    </fieldset>
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
  { key: "axel", label: "Axel Courier" },
  { key: "urpi", label: "Urpi" },
  { key: "olva", label: "Olva (agencia)" },
];

/** Descarga el PDF que devuelve el endpoint, o el mensaje de error si no hay rótulos. */
async function downloadRotulos(query: string): Promise<{ error?: string; missing: number }> {
  return downloadPdf(`/api/pedidos/rotulos?${query}`, "x-rotulos-missing", "rotulos.pdf");
}

/**
 * Guías combinadas (el rótulo del courier arriba y el interno abajo) de los
 * pedidos elegidos, un PDF por courier porque el papel es distinto: Tanders en
 * A4, Shalom en etiqueta de 100×150 mm. Solo lee: imprime la salida vigente de
 * cada pedido y cuenta las que no tiene (lib/labels/guia-combinada-select.ts).
 */
const COMBINED_ENDPOINT: Record<CombinedGuideCourier, { url: string; file: string; label: string }> = {
  tanders: { url: "/api/pedidos/guia-combinada", file: "guias-combinadas-tanders.pdf", label: "Tanders (A4)" },
  shalom: { url: "/api/shalom/rotulos", file: "rotulos-shalom.pdf", label: "Shalom (etiqueta)" },
};

async function downloadCombinadas(
  courier: CombinedGuideCourier,
  orderIds: string[],
): Promise<{ error?: string; missing: number; failed: number }> {
  const target = COMBINED_ENDPOINT[courier];
  return downloadPdf(`${target.url}?orders=${orderIds.join(",")}`, "x-combinadas-omitidas", target.file);
}

async function downloadPdf(
  url: string,
  missingHeader: string,
  fallbackName: string,
): Promise<{ error?: string; missing: number; failed: number }> {
  const response = await fetch(url);
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    return { error: body?.error ?? "No se pudieron generar los rótulos.", missing: 0, failed: 0 };
  }
  const missing = Number(response.headers.get(missingHeader) ?? "0");
  const failed = Number(response.headers.get("x-combinadas-fallidas") ?? "0");
  const blob = await response.blob();
  const href = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = href;
  anchor.download =
    response.headers.get("content-disposition")?.match(/filename="([^"]+)"/)?.[1] ?? fallbackName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(href);
  return { missing, failed };
}

function BulkBar({
  selectedIds,
  orderNames,
  orderCouriers,
  visibleIds,
  canEdit,
  onClear,
  onToggleRow,
  onCreated,
}: {
  selectedIds: Set<string>;
  orderNames: Map<string, string>;
  /** Courier de cada pedido visto: decide si hay guías combinadas que bajar. */
  orderCouriers: Map<string, string>;
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
  const combinedGroups = new Map<CombinedGuideCourier, string[]>();
  for (const orderId of selectedIds) {
    const courier = (orderCouriers.get(orderId) ?? "").trim().toLowerCase();
    if (!hasCombinedGuide(courier)) continue;
    combinedGroups.set(courier, [...(combinedGroups.get(courier) ?? []), orderId]);
  }
  const combinedCount = Array.from(combinedGroups.values()).reduce((n, ids) => n + ids.length, 0);
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

  const downloadCombined = async () => {
    setBusy(true);
    reset();
    try {
      const parts: string[] = [];
      const errors: string[] = [];
      let notPrinted = count - combinedCount;
      let failed = 0;
      for (const [courier, ids] of combinedGroups) {
        const target = COMBINED_ENDPOINT[courier];
        const pdf = await downloadCombinadas(courier, ids);
        if (pdf.error) {
          errors.push(`${target.label}: ${pdf.error}`);
          notPrinted += ids.length;
          continue;
        }
        const printed = ids.length - pdf.missing - pdf.failed;
        notPrinted += pdf.missing;
        failed += pdf.failed;
        parts.push(`${printed} ${target.label}`);
      }
      if (!parts.length) {
        setError(errors.join(" · ") || "Ninguno de los pedidos tiene guía combinada.");
        return;
      }
      setNotice(
        [
          `Guías combinadas descargadas: ${parts.join(" · ")}.`,
          notPrinted ? `${notPrinted} sin guía combinada (solo Tanders y Shalom creada desde Kapta la tienen).` : "",
          failed
            ? failed === 1
              ? "1 de Shalom no se pudo componer: imprímela desde el pedido."
              : `${failed} de Shalom no se pudieron componer: imprímelas desde el pedido.`
            : "",
          ...errors,
        ]
          .filter(Boolean)
          .join(" "),
      );
    } catch {
      setError("No se pudieron generar las guías combinadas.");
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

  const LABEL = "grid gap-1 text-xs font-medium text-ink-600";

  return (
    <div
      role="region"
      aria-label="Acciones en lote"
      className="sticky bottom-4 z-30 mx-auto flex w-full max-w-5xl flex-col gap-3 rounded-lg bg-white p-3 shadow-pop ring-1 ring-line sm:w-fit sm:px-4"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="mr-1 text-sm font-semibold text-ink-900">
          <span className="tabular-nums">{count.toLocaleString("es-PE")}</span>{" "}
          {count === 1 ? "pedido seleccionado" : "pedidos seleccionados"}
        </span>
        <OpsButton variant="primary" size="sm" onClick={download} disabled={busy} className="pointer-coarse:h-11">
          {busy ? "Trabajando…" : "Descargar rótulos (PDF)"}
        </OpsButton>
        {/* Solo con algún pedido de Tanders o Shalom: los demás couriers no
            tienen guía combinada, y el botón no debe prometer lo que no hay. */}
        {combinedCount > 0 && (
          <OpsButton
            size="sm"
            onClick={downloadCombined}
            disabled={busy}
            title="El rótulo del courier y el interno en un papel: Tanders en A4, Shalom en etiqueta. Un PDF por courier."
            className="pointer-coarse:h-11"
          >
            Guías combinadas (PDF){combinedCount < count ? ` · ${combinedCount}` : ""}
          </OpsButton>
        )}
        {canEdit && (
          <OpsButton
            size="sm"
            aria-expanded={showCreate}
            onClick={() => {
              reset();
              setShowStatus(false);
              setShowCreate((v) => !v);
            }}
            disabled={busy}
            className="pointer-coarse:h-11"
          >
            {showCreate ? "Cancelar" : "Forzar courier…"}
          </OpsButton>
        )}
        {canEdit && (
          <OpsButton
            size="sm"
            aria-expanded={showStatus}
            onClick={() => {
              reset();
              setShowCreate(false);
              setShowStatus((v) => !v);
            }}
            disabled={busy}
            className="pointer-coarse:h-11"
          >
            {showStatus ? "Cancelar" : "Registrar estado…"}
          </OpsButton>
        )}
        <OpsButton
          variant="ghost"
          size="sm"
          aria-expanded={showPicked}
          onClick={() => setShowPicked((v) => !v)}
          className="pointer-coarse:h-11"
        >
          {showPicked ? "Ocultar" : "Ver"} selección
        </OpsButton>
        <OpsButton variant="ghost" size="sm" onClick={onClear} className="pointer-coarse:h-11">
          Limpiar
        </OpsButton>
      </div>

      {/* La selección sobrevive a las búsquedas, así que casi siempre habrá
          pedidos elegidos que no están en pantalla. Poder verlos y sacar
          cualquiera es lo que impide imprimir una tanda a ciegas. */}
      {offscreen > 0 && !showPicked && (
        <p className="text-[13px] text-ink-500">
          {offscreen} de los seleccionados {offscreen === 1 ? "no está" : "no están"} en esta
          búsqueda. Siguen contando para el PDF.
        </p>
      )}
      {showPicked && (
        <ul aria-label="Pedidos seleccionados" className="flex max-h-40 flex-wrap gap-1.5 overflow-y-auto border-t border-line pt-3">
          {Array.from(selectedIds).map((orderId) => (
            <li key={orderId}>
              <button
                type="button"
                onClick={() => onToggleRow(orderId)}
                aria-label={`Quitar ${orderNames.get(orderId) ?? orderId} de la selección`}
                className="inline-flex h-7 items-center gap-1 rounded-full bg-wash pl-2.5 pr-1.5 text-xs font-medium text-ink-700 ring-1 ring-inset ring-line-strong transition-colors hover:text-ink-900 pointer-coarse:h-11"
              >
                {orderNames.get(orderId) ?? orderId}
                <IconX aria-hidden className="size-3.5 text-ink-500" />
              </button>
            </li>
          ))}
        </ul>
      )}

      {showCreate && (
        <div className="flex flex-wrap items-end gap-3 border-t border-line pt-3">
          <p className="max-w-2xl basis-full text-[13px] leading-5 text-ink-500">
            Normalmente no hace falta: «Descargar rótulos» ya crea la salida y el courier se fija
            en despacho. Usa esto para forzar un courier concreto (Olva valida su adelanto) o para
            crear una salida adicional con motivo.
          </p>
          <label className={LABEL}>
            Courier
            <select
              value={courier}
              onChange={(e) => setCourier(e.target.value as ManualRouteCourier)}
              className={cn(FIELD_BOX, "h-8 w-auto px-3 pointer-coarse:h-11")}
            >
              {BULK_COURIERS.map((c) => (
                <option key={c.key} value={c.key}>
                  {c.label}
                </option>
              ))}
            </select>
          </label>
          <label className={LABEL}>
            Sale el
            <input
              type="date"
              value={dispatchDate}
              onChange={(e) => setDispatchDate(e.target.value)}
              className={cn(FIELD_BOX, "h-8 w-auto px-3 tabular-nums pointer-coarse:h-11")}
            />
          </label>
          <label className={LABEL}>
            Motivo (si el pedido ya tiene una salida activa)
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Opcional"
              className={cn(FIELD_BOX, "h-8 w-56 px-3 pointer-coarse:h-11")}
            />
          </label>
          <OpsButton variant="primary" size="sm" onClick={createOutputs} disabled={busy} className="pointer-coarse:h-11">
            {busy ? "Creando…" : `Crear ${count} salida${count === 1 ? "" : "s"} e imprimir`}
          </OpsButton>
        </div>
      )}

      {showStatus && (
        <div className="flex flex-wrap items-end gap-3 border-t border-line pt-3">
          {/* El aviso no es decorativo: un override CONGELA el pedido frente al
              recálculo. Aplicado a cincuenta de golpe, cincuenta pedidos dejan
              de seguir a su guía, y quien lo hace tiene que saberlo ANTES. */}
          <div className="basis-full">
            <Banner tone="warn" className="max-w-2xl">
              Queda como cambio manual y <strong className="font-semibold">congela</strong> el pedido: deja de
              seguir a su guía hasta que alguien lo vuelva a mover a mano. Úsalo en pedidos ya cerrados, no en
              los que siguen en movimiento.
            </Banner>
          </div>
          <label className={LABEL}>
            Estado
            <select
              value={bulkGeneral}
              onChange={(e) => setBulkGeneral(e.target.value as GeneralStatus)}
              className={cn(FIELD_BOX, "h-8 w-auto px-3 pointer-coarse:h-11")}
            >
              {GENERAL_STATUSES.map((s) => (
                <option key={s.code} value={s.code}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>
          <label className={LABEL}>
            Detalle
            <select
              value={bulkOperational}
              onChange={(e) => setBulkOperational(e.target.value)}
              className={cn(FIELD_BOX, "h-8 w-auto px-3 pointer-coarse:h-11")}
            >
              {bulkOperationalOptions.map((o) => (
                <option key={o.code} value={o.code}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <label className={LABEL}>
            Motivo (obligatorio si el pedido ya estaba cerrado)
            <input
              value={bulkReason}
              onChange={(e) => setBulkReason(e.target.value)}
              placeholder="Opcional"
              className={cn(FIELD_BOX, "h-8 w-56 px-3 pointer-coarse:h-11")}
            />
          </label>
          <label className={LABEL}>
            Comentario
            <input
              value={bulkComment}
              onChange={(e) => setBulkComment(e.target.value)}
              placeholder="PAGADO"
              className={cn(FIELD_BOX, "h-8 w-44 px-3 pointer-coarse:h-11")}
            />
          </label>
          <OpsButton variant="primary" size="sm" onClick={applyStatus} disabled={busy} className="pointer-coarse:h-11">
            {busy
              ? "Aplicando…"
              : `Aplicar a ${count} pedido${count === 1 ? "" : "s"}`}
          </OpsButton>
        </div>
      )}

      {error && <p role="alert" className="max-w-2xl text-[13px] leading-5 text-crit-fg">{error}</p>}
      {notice && <p role="status" className="max-w-2xl text-[13px] leading-5 text-ok-fg">{notice}</p>}
      {failures.length > 0 && (
        <details className="max-w-2xl text-[13px] leading-5 text-ink-700">
          <summary className="cursor-pointer font-medium text-warn-fg">
            {failures.length} pedido{failures.length === 1 ? "" : "s"} con problemas — ver por qué
          </summary>
          <ul className="mt-1.5 space-y-0.5">
            {failures.map((f) => (
              <li key={f.orderId}>
                <span className="font-medium text-ink-900">{orderNames.get(f.orderId) ?? f.orderId}</span>:{" "}
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
    <span className="shrink-0 text-[13px] font-medium text-ink-700">Ciclo sin fecha pactada</span>
  );

  if (cycles.length > 1) {
    return (
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-ink-500">
        {label}
        <span className="tabular-nums text-ink-700">{cycles.map((c) => `${c.storeName} ${c.days} d`).join(" · ")}</span>
        <span>— filtra por tienda para cambiarlo</span>
      </div>
    );
  }

  const cycle = cycles[0]!;
  if (!cycle.canEdit) {
    return (
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-ink-500">
        {label}
        <span className="font-medium text-ink-900">{cycleLabel(cycle.days)}</span>
        <span>— lo cambia un owner o admin de la tienda</span>
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
    <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 text-[13px] text-ink-500">
      <label className="flex items-center gap-2.5">
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
          className={cn(FIELD_BOX, "h-8 w-auto px-3 pointer-coarse:h-11")}
        >
          {choices.map((option) => (
            <option key={option} value={option}>
              {cycleLabel(option)}
            </option>
          ))}
        </select>
      </label>
      {feedback?.error ? (
        <span role="alert" className="text-crit-fg">{feedback.error}</span>
      ) : feedback?.notice ? (
        <span role="status" className="text-ok-fg">{feedback.notice}</span>
      ) : (
        <span>Sin fecha pactada, el pedido vuelve a «Hoy» cada {cycleLabel(days)}.</span>
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
    return <ContactLines main={fmtDate(`${row.confirmation_next_contact_on}T12:00:00.000Z`)} />;
  }
  const reminder = row.confirmation_reminder_due_at;
  // El recordatorio manda siempre que exista, también uno de días atrás: ese es
  // un reintento que nadie hizo y su hora, ya pasada, es justo lo que hay que
  // ver. La celda tiene que decir lo mismo que la cola (`confirmationQueueBucket`).
  if (reminder) return <ContactLines main={fmtDateTime(reminder)} />;
  const cycle = row.confirmation_cycle_due_on;
  if (!cycle) {
    // Sin fecha, sin recordatorio y sin ciclo: nunca se le ha llamado, y la
    // primera llamada toca hoy. La celda dice lo mismo que la cola.
    return <ContactLines main="Hoy" note="primera llamada" />;
  }
  return (
    <ContactLines
      main={cycle <= today ? "Hoy" : fmtDate(`${cycle}T12:00:00.000Z`)}
      note="ciclo automático"
    />
  );
}

/** Dos renglones en escritorio; uno, con su punto, en el teléfono. */
function ContactLines({ main, note }: { main: string; note?: string }) {
  return (
    <span className="inline-flex min-w-0 flex-wrap items-baseline gap-x-1.5 xl:flex-col xl:items-start xl:gap-0">
      <span className="tabular-nums text-ink-900">{main}</span>
      {note && (
        <>
          <span aria-hidden className="text-ink-300 xl:hidden">·</span>
          <span className="text-[13px] text-ink-500">{note}</span>
        </>
      )}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Tabla (§14, §25)
// ---------------------------------------------------------------------------

/**
 * La tabla del Master es para BARRER (MOM §25): quién, dónde, en qué macroetapa
 * y desde cuándo. Celdas de dos renglones en vez de diecisiete columnas: la
 * tabla entra entera en la pantalla y ya no hay columnas congeladas ni scroll
 * horizontal. Ningún dato se fue: tienda y creación van bajo el pedido, el
 * teléfono bajo el cliente, provincia, región y cobertura con el distrito, los
 * couriers e intentos con el courier, y la antigüedad junto a su macroetapa.
 *
 * Por debajo de 1280 px cada fila se vuelve una ficha corta (sin cabecera de
 * tabla): las mismas celdas, colocadas en una rejilla.
 */
const TH =
  "sticky top-0 z-10 bg-white px-3 py-2.5 text-left text-xs font-semibold text-ink-600 shadow-[inset_0_1px_0_var(--color-line),inset_0_-1px_0_var(--color-line)]";
const TD = "px-3 py-2.5 align-top max-xl:p-0";
/** Separador que solo existe cuando la celda va en una línea (teléfono). */
const DOT = "text-ink-300 xl:hidden";

function MasterTable({
  rows,
  storeName,
  multiStore,
  showConfirmation,
  onOpen,
  openId,
  selected,
  onToggleRow,
  onToggleAll,
  busy,
}: {
  rows: OrderMasterRow[];
  storeName: (id: string) => string;
  multiStore: boolean;
  showConfirmation: boolean;
  onOpen: (orderId: string) => void;
  /** El pedido cuyo drawer está abierto: su fila se resalta detrás del panel. */
  openId: string | null;
  selected: Set<string>;
  onToggleRow: (orderId: string) => void;
  onToggleAll: (orderIds: string[], checked: boolean) => void;
  /** Llega otra página: la actual se atenúa en vez de parpadear a vacío. */
  busy: boolean;
}) {
  const pageIds = rows.map((r) => r.order_id);
  const allChecked = pageIds.length > 0 && pageIds.every((id) => selected.has(id));
  const someChecked = !allChecked && pageIds.some((id) => selected.has(id));
  const headCheck = useRef<HTMLInputElement>(null);
  const listCheck = useRef<HTMLInputElement>(null);
  useEffect(() => {
    for (const box of [headCheck.current, listCheck.current]) if (box) box.indeterminate = someChecked;
  }, [someChecked]);
  const toggleAllBox = (ref: typeof headCheck, label: string) => (
    <input
      ref={ref}
      type="checkbox"
      className={CHECKBOX}
      checked={allChecked}
      onChange={(e) => onToggleAll(pageIds, e.target.checked)}
      aria-label={label}
    />
  );

  // Anchos de columna (tabla fija): Por confirmar suma Gestión y Próximo
  // contacto, y el resto cede sitio. «Últ. movimiento» se queda con lo que sobra.
  const w = showConfirmation
    ? { check: "w-[4%]", pedido: "w-[13%]", cliente: "w-[14%]", destino: "w-[15%]", courier: "w-[8.5%]", etapa: "w-[15%]", gestion: "w-[8%]", proximo: "w-[12%]" }
    : { check: "w-[4%]", pedido: "w-[15%]", cliente: "w-[17%]", destino: "w-[21%]", courier: "w-[13%]", etapa: "w-[19%]", gestion: "", proximo: "" };

  return (
    <>
      {/* Sin cabecera de tabla (teléfono y tableta), la casilla de la página va aquí. */}
      <label className="flex min-h-11 cursor-pointer items-center gap-2.5 border-t border-line px-4 text-[13px] text-ink-600 xl:hidden">
        {toggleAllBox(listCheck, "Seleccionar todos los pedidos de esta página")}
        Seleccionar los {rows.length.toLocaleString("es-PE")} de esta página
      </label>
      <table className="w-full text-sm max-xl:block xl:table-fixed">
        <thead className="max-xl:hidden">
          <tr>
            <th className={cn(TH, w.check, "pl-5")}>
              {toggleAllBox(headCheck, "Seleccionar todos los pedidos de esta página")}
            </th>
            <th className={cn(TH, w.pedido)}>Pedido</th>
            <th className={cn(TH, w.cliente)}>Cliente</th>
            <th className={cn(TH, w.destino)}>Destino</th>
            <th className={cn(TH, w.courier)}>Courier</th>
            <th className={cn(TH, w.etapa)}>Etapa</th>
            {showConfirmation && (
              <>
                <th className={cn(TH, w.gestion)}>Gestión</th>
                <th className={cn(TH, w.proximo)}>Próximo contacto</th>
              </>
            )}
            <th className={cn(TH, "pr-5")} title="Último movimiento">Movimiento</th>
          </tr>
        </thead>
        <tbody
          className={cn(
            "divide-y divide-line transition-opacity duration-150 motion-reduce:transition-none max-xl:block max-xl:border-t max-xl:border-line",
            busy && "opacity-60",
          )}
        >
          {rows.map((r) => {
            // La fila del drawer abierto: con el panel encima se perdía de vista
            // de qué pedido era. Un azul más firme que el de la casilla marcada,
            // para que «lo que estoy mirando» no se confunda con «lo que elegí».
            const isOpen = openId === r.order_id;
            const isSelected = selected.has(r.order_id);
            const since = r.macro_since ?? r.status_since;
            const showCourierCounts = Boolean(r.last_courier) || r.attempt_count > 0 || r.courier_count > 1;
            return (
              <tr
                key={r.id}
                onClick={() => onOpen(r.order_id)}
                aria-current={isOpen ? "true" : undefined}
                className={cn(
                  "cursor-pointer transition-colors duration-100 max-xl:grid max-xl:grid-cols-[1.75rem_minmax(0,1fr)_auto] max-xl:gap-x-2 max-xl:gap-y-1 max-xl:px-4 max-xl:py-3",
                  // Sobre el azul firme, el texto de apoyo sube a ink-600: en
                  // ink-500 quedaba en 4,2:1. Marcada, el velo al 60 % lo deja en 4,6:1.
                  isOpen
                    ? "bg-brand-100/70 [&_.text-ink-500]:text-ink-600"
                    : isSelected
                      ? "bg-brand-50/60"
                      : "bg-white hover:bg-wash",
                )}
              >
                {/* stopPropagation: marcar la fila no debe abrir el drawer. */}
                <td
                  className={cn(TD, "pl-5 max-xl:col-start-1 max-xl:row-start-1")}
                  onClick={(e) => e.stopPropagation()}
                >
                  <label className="-m-2 grid size-9 cursor-pointer place-items-center pointer-coarse:size-11">
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={() => onToggleRow(r.order_id)}
                      aria-label={`Seleccionar ${r.order_name ?? "pedido"}`}
                      className={CHECKBOX}
                    />
                  </label>
                </td>
                <td className={cn(TD, "max-xl:col-start-2 max-xl:row-start-1")}>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onOpen(r.order_id);
                    }}
                    title="Abrir la ficha del pedido"
                    className={cn(
                      "block max-w-full truncate text-left leading-5 underline-offset-2 hover:underline",
                      isOpen ? "font-semibold text-brand-700" : "font-medium text-ink-900",
                    )}
                  >
                    {r.order_name ?? "—"}
                  </button>
                  <p
                    className="truncate text-[13px] leading-5 text-ink-500"
                    title={[
                      r.order_created_at ? `Creado el ${fmtDateTime(r.order_created_at)}` : "",
                      multiStore ? storeName(r.store_id) : "",
                    ].filter(Boolean).join(" · ") || undefined}
                  >
                    {/* La fecha primero: si algo se corta, que sea el nombre de la tienda. */}
                    <span className="tabular-nums">{fmtDate(r.order_created_at)}</span>
                    {multiStore && <> · {storeName(r.store_id)}</>}
                  </p>
                </td>
                <td className={cn(TD, "max-xl:col-span-2 max-xl:col-start-2 max-xl:row-start-2")}>
                  <div className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 xl:block">
                    <p className="max-w-full truncate leading-5 text-ink-900" title={r.customer_name ?? undefined}>
                      {r.customer_name ?? "—"}
                    </p>
                    {r.customer_phone && (
                      <p className="flex min-w-0 gap-x-1.5 text-[13px] leading-5 tabular-nums text-ink-500 xl:block xl:truncate">
                        <span aria-hidden className={DOT}>·</span>
                        <span className="truncate">{r.customer_phone}</span>
                      </p>
                    )}
                  </div>
                </td>
                <td className={cn(TD, "max-xl:col-span-2 max-xl:col-start-2 max-xl:row-start-3")}>
                  {/* El distrito tiene el renglón entero; la cobertura va con
                      provincia y región, que ceden primero si falta sitio. */}
                  <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 xl:block">
                    <p className="max-w-full truncate leading-5 text-ink-900" title={r.district ?? undefined}>
                      {r.district ?? "—"}
                    </p>
                    <div className="flex min-w-0 items-center gap-1.5 xl:mt-0.5">
                      <span aria-hidden className={DOT}>·</span>
                      <CoverageBadge coverage={r.coverage} />
                      <span
                        className="truncate text-[13px] leading-5 text-ink-500"
                        title={[r.province, r.region].filter(Boolean).join(" · ") || undefined}
                      >
                        {[r.province, r.region].filter(Boolean).join(" · ") || "—"}
                      </span>
                    </div>
                  </div>
                </td>
                <td
                  className={cn(
                    TD,
                    "max-xl:col-span-2 max-xl:col-start-2 max-xl:row-start-5",
                    // En la ficha del teléfono, un renglón con solo «—» sobra.
                    !r.last_courier && !showCourierCounts && "max-xl:hidden",
                  )}
                  title={`${r.courier_count} ${r.courier_count === 1 ? "courier" : "couriers"} · ${r.attempt_count} ${r.attempt_count === 1 ? "intento" : "intentos"} de entrega`}
                >
                  <div className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 xl:block">
                    <p className="truncate capitalize leading-5 text-ink-900">{r.last_courier ?? "—"}</p>
                    {showCourierCounts && (
                      <>
                        <p className="text-[13px] leading-5 tabular-nums text-ink-500">
                          <span aria-hidden className={cn(DOT, "mr-1.5")}>·</span>
                          <span className={cn("whitespace-nowrap", r.attempt_count > 1 && "font-semibold text-warn-fg")}>
                            {r.attempt_count} {r.attempt_count === 1 ? "intento" : "intentos"}
                          </span>
                          {r.courier_count > 1 && (
                            <>
                              {" · "}
                              <span className="whitespace-nowrap font-semibold text-warn-fg">{r.courier_count} couriers</span>
                            </>
                          )}
                        </p>
                      </>
                    )}
                  </div>
                </td>
                <td className={cn(TD, "max-xl:col-span-2 max-xl:col-start-2 max-xl:row-start-4")}>
                  <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 xl:block">
                    <div className="flex min-w-0 items-center gap-1.5">
                      <MacroStageBadge stage={r.macro_stage} />
                      <span
                        className="shrink-0 text-[13px] tabular-nums text-ink-500"
                        title={since ? `En esta macroetapa desde el ${fmtDate(since)}` : undefined}
                      >
                        {fmtAge(since)}
                      </span>
                    </div>
                    <p className="flex min-w-0 gap-x-1.5 text-[13px] leading-5 text-ink-600 xl:mt-0.5 xl:block xl:truncate">
                      <span aria-hidden className={DOT}>·</span>
                      <span className="truncate">{macroSubstageLabel(r.macro_substage)}</span>
                    </p>
                  </div>
                </td>
                {showConfirmation && (
                  <>
                    <td className={cn(TD, "max-xl:col-span-2 max-xl:col-start-2 max-xl:row-start-6")}>
                      <span className="text-[13px] text-ink-500 xl:hidden">Gestión </span>
                      <span className="whitespace-nowrap tabular-nums text-ink-900 xl:text-[13px]">
                        {r.macro_substage === "historico_sin_gestion"
                          ? "Fuera del corte"
                          : `${r.confirmation_day_count ?? 0}/7 días`}
                      </span>
                    </td>
                    <td className={cn(TD, "max-xl:col-span-2 max-xl:col-start-2 max-xl:row-start-7")}>
                      <span className="text-[13px] text-ink-500 xl:hidden">Próximo contacto </span>
                      <NextContactCell row={r} />
                    </td>
                  </>
                )}
                <td className={cn(TD, "pr-5 max-xl:col-start-3 max-xl:row-start-1 max-xl:text-right")}>
                  <span className="text-[13px] text-ink-500 xl:hidden">Mov. </span>
                  <span className="text-[13px] tabular-nums text-ink-700 xl:text-sm">{fmtDate(r.last_movement_at)}</span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </>
  );
}

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
    <OpsButton
      size="sm"
      onClick={onClick}
      disabled={busy}
      title={
        selected
          ? `Descargar en Excel los ${count.toLocaleString("es-PE")} pedidos seleccionados`
          : `Descargar ${count.toLocaleString("es-PE")} ${count === 1 ? "pedido" : "pedidos"} en Excel, con los filtros aplicados`
      }
      className="pointer-coarse:h-11"
    >
      <IconDownload className="text-ink-500" />
      {busy ? "Generando…" : label}
    </OpsButton>
  );
}

/**
 * El buscador del Master, con su propio estado.
 *
 * POR QUÉ VIVE APARTE. El estado del texto estaba en `OrdersMasterBoard`, que es
 * el mismo componente que pinta la tabla: 100 filas con varias líneas, chapas y
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
  // Lo que este input mandó a la URL y todavía no ha vuelto como `value`.
  const pending = useRef<string[]>([]);
  const input = useRef<HTMLInputElement>(null);
  const hintId = useId();

  // La URL manda cuando el cambio viene de FUERA (atrás/adelante, «Limpiar
  // búsqueda»). Cuando es el eco de lo que mandó este mismo input, NO se copia:
  // llega tarde, y pisaba lo que la persona había seguido escribiendo mientras
  // tanto — «tipeas y se borra la mitad». Ver lib/search-input-echo.ts.
  useEffect(() => {
    const next = receiveSearchValue(pending.current, value);
    pending.current = next.pending;
    if (next.adopt) setText(value);
  }, [value]);

  // Uno o dos caracteres no se mandan: no alcanzan para usar el índice de la
  // búsqueda y devolverían miles de filas. Se espera al tercero —o a que el
  // campo quede vacío, que es «limpiar la búsqueda»— y se deja el aviso.
  // «/» lleva a la búsqueda desde cualquier parte del tablero, como en Stripe.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable='true'], [role='dialog']")) return;
      e.preventDefault();
      input.current?.focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const typed = text.trim().replace(/^#/, "").trim();
  const tooShort = typed.length > 0 && typed.length < MASTER_SEARCH_MIN_CHARS;

  useEffect(() => {
    const next = text.trim();
    if (!shouldSendSearch(next, value, pending.current)) return;
    if (tooShort) return;
    const timer = setTimeout(() => {
      pending.current = [...pending.current, next];
      commit.current(next);
    }, 400);
    return () => clearTimeout(timer);
  }, [text, value, tooShort]);

  return (
    <div role="search" className="relative w-full sm:w-80">
      <IconSearch className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-ink-500" />
      <input
        ref={input}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape" && text) setText("");
        }}
        enterKeyHint="search"
        aria-keyshortcuts="/"
        title="Atajo: /"
        aria-label="Buscar pedido, cliente, teléfono o guía"
        aria-describedby={tooShort ? hintId : undefined}
        placeholder="Buscar pedido, cliente, teléfono o guía…"
        className={cn(FIELD_BOX, "h-9 w-full pl-8 pr-9 pointer-coarse:h-11")}
      />
      {text && (
        <button
          type="button"
          onClick={() => {
            setText("");
            input.current?.focus();
          }}
          aria-label="Borrar la búsqueda"
          className="absolute right-1 top-1/2 grid size-7 -translate-y-1/2 place-items-center rounded-md text-ink-500 transition-colors hover:bg-wash hover:text-ink-900 pointer-coarse:right-0 pointer-coarse:size-11"
        >
          <IconX className="size-4" />
        </button>
      )}
      {tooShort && (
        <p id={hintId} className="absolute left-0 top-full mt-1 whitespace-nowrap text-xs text-ink-500">
          Escribe al menos {MASTER_SEARCH_MIN_CHARS} caracteres
        </p>
      )}
    </div>
  );
}

/**
 * Anterior / Siguiente. Va arriba Y abajo de la tabla: con 100 filas, tener los
 * controles solo al pie obliga a recorrer la página entera para cambiarla.
 */
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
    <div role="group" aria-label="Cambiar de página" className="flex shrink-0 items-center gap-1.5">
      <OpsButton size="sm" disabled={busy || page <= 1} onClick={() => onPage(page - 1)} className="pointer-coarse:h-11">
        Anterior
      </OpsButton>
      <span className="px-1 text-[13px] tabular-nums text-ink-500">
        {page.toLocaleString("es-PE")} / {totalPages.toLocaleString("es-PE")}
      </span>
      <OpsButton size="sm" disabled={busy || page >= totalPages} onClick={() => onPage(page + 1)} className="pointer-coarse:h-11">
        Siguiente
      </OpsButton>
    </div>
  );
}

/**
 * Paginación. Existe porque el listado dejó de traerse entero: antes eran ~10.000
 * filas y 9,5 MB por carga, ahora son 100 filas por página. Enseña el total real
 * (contado en la base, no las visibles) para que nadie confunda "hay 100" con
 * "hay 100 en total".
 */
function Pager({
  page,
  pageSize,
  totalPages,
  total,
  shown,
  busy,
  onPage,
}: {
  page: number;
  pageSize: number;
  totalPages: number;
  total: number;
  shown: number;
  busy: boolean;
  onPage: (page: number) => void;
}) {
  if (total === 0) return null;
  const from = (page - 1) * pageSize + 1;
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line px-4 py-3 sm:px-5">
      <p className="text-[13px] tabular-nums text-ink-500">
        {from.toLocaleString("es-PE")}–{(from + shown - 1).toLocaleString("es-PE")} de {total.toLocaleString("es-PE")}
        {busy && <span> · actualizando…</span>}
      </p>
      <PagerControls page={page} totalPages={totalPages} busy={busy} onPage={onPage} />
    </div>
  );
}
