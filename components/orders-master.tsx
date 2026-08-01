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
import { Card, cn, EmptyState } from "@/components/ui";
import { AliclikGuidePanel } from "@/components/aliclik-guide-panel";
import { DirectFenixGuideModal } from "@/components/direct-fenix-guide-modal";
import { ManualRouteOutputModal } from "@/components/manual-route-output-modal";
import { OrderClosureDesk } from "@/components/order-closure-desk";
import { OrderRouteDesk } from "@/components/order-route-desk";
import { ChecklistFilter } from "@/components/filters";
import { PickupKeyPanel } from "@/components/pickup-key-panel";
import { TandersGuideModal } from "@/components/tanders-guide-modal";
import { markTandersLabelGenerated } from "@/app/dashboard/pedidos/tanders-actions";
import { ShalomGuideModal } from "@/components/shalom-guide-modal";
import { cancelShalomGuide } from "@/app/dashboard/pedidos/shalom-actions";
import { shalomGuideIsCancelable } from "@/lib/shalom/draft";
import {
  addOrderComment,
  clearOrderGeo,
  loadOrderDetail,
  loadOrderGeo,
  registerReturn,
  registerClosureAction,
  relinkGuide,
  setOrderStatus,
  updateOrderGeo,
  type OrderGeoInput,
} from "@/app/dashboard/pedidos/actions";
import {
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
  type MacroSubstage,
} from "@/lib/order-macro-stage";
import { KEY_STATE_LABEL, PAYMENT_STATE_LABEL, usesPickupKeyFlow, type KeyState, type PaymentState } from "@/lib/pickup-key";
import { MASTER_VIEWS, type MasterCounts, type MasterView, type OrderMasterDetail } from "@/lib/orders-master-access";
import { outputDisplayCode } from "@/lib/shipment-output";
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

  /**
   * Cambiar un filtro es reescribir la URL y dejar que el servidor traiga la
   * página. Suena a más trabajo que filtrar en memoria, pero baja ~100 KB en vez
   * de 9,5 MB, así que en la práctica es lo que hace que la pantalla responda.
   *
   * `useTransition` mantiene visible el listado anterior mientras llega el
   * nuevo, en vez de parpadear a vacío en cada clic.
   */
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

  // La búsqueda es un filtro más y la resuelve la base. El input mantiene su
  // propio estado para que escribir sea instantáneo, y solo al parar de teclear
  // se reescribe la URL — si no, cada letra sería un viaje al servidor.
  const [search, setSearch] = useState(filters.search);
  const searching = navigating;

  useEffect(() => {
    setSearch(filters.search);
  }, [filters.search]);

  useEffect(() => {
    if (search.trim() === filters.search.trim()) return;
    const timer = setTimeout(() => navigate({ filters: { search: search.trim() } }), 350);
    return () => clearTimeout(timer);
    // `navigate` se rehace en cada render; depender de él relanzaría el temporizador.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, filters.search]);

  const storeName = useMemo(() => {
    const map = new Map(stores.map((s) => [s.id, s.name]));
    return (id: string) => map.get(id) ?? "—";
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
          {canDispatch && (
            <Link
              href="/dashboard/pedidos/despacho"
              className="inline-flex min-h-9 items-center gap-2 rounded-lg bg-slate-900 px-3 text-sm font-medium text-white transition hover:bg-slate-700"
            >
              <span aria-hidden="true">▦</span>
              Mesa de despacho
            </Link>
          )}
          <div className="relative">
            <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400">
              🔍
            </span>
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Buscar pedido, cliente, teléfono o guía…"
              className="w-72 rounded-lg border border-slate-200 py-1.5 pl-8 pr-7 text-sm"
            />
            {search && (
              <button
                onClick={() => setSearch("")}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
              >
                ✕
              </button>
            )}
          </div>
          {!canEdit && (
            <span className="rounded-lg border border-slate-200 px-2.5 py-1 text-xs text-slate-500">
              Solo lectura
            </span>
          )}
        </div>
      </div>

      {searchActive ? (
        <Card className="p-0">
          <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3">
            <p className="text-sm font-medium text-slate-800">
              Resultados de búsqueda ({total})
            </p>
            <button onClick={() => setSearch("")} className="text-xs text-slate-500 hover:underline">
              Limpiar búsqueda
            </button>
          </div>
          {searching ? (
            <p className="p-5 text-sm text-slate-400">Buscando…</p>
          ) : listed.length ? (
            <>
              <MasterTable rows={shown} storeName={storeName} multiStore={stores.length > 1} onOpen={setOpenId} />
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
          {agency.total > 0 && (
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

          <Card className="p-0">
            <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3">
              <p className="text-sm font-medium text-slate-800">
                {listed.length} {listed.length === 1 ? "pedido" : "pedidos"}
                {listed.length !== rows.length && (
                  <span className="ml-1 text-xs font-normal text-slate-400">de {rows.length}</span>
                )}
              </p>
            </div>
            {listed.length ? (
              <MasterTable
                rows={listed}
                storeName={storeName}
                multiStore={stores.length > 1}
                onOpen={setOpenId}
              />
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
          onClose={() => setOpenId(null)}
          onSaved={() => router.refresh()}
        />
      )}
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
      <AgencyStat label="En agencia" value={summary.total} />
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
      <AgencyStat label="Devueltos" value={summary.devueltos} tone={summary.devueltos > 0 ? "danger" : undefined} />
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

function MasterTable({
  rows,
  storeName,
  multiStore,
  onOpen,
}: {
  rows: OrderMasterRow[];
  storeName: (id: string) => string;
  multiStore: boolean;
  onOpen: (orderId: string) => void;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[1600px] text-sm">
        <thead>
          <tr className="border-b border-slate-200 text-left text-xs text-slate-500">
            <th className="px-4 py-2 font-medium">Pedido</th>
            {multiStore && <th className="px-2 py-2 font-medium">Tienda</th>}
            <th className="px-2 py-2 font-medium">Creado</th>
            <th className="px-2 py-2 font-medium">Cliente</th>
            <th className="px-2 py-2 font-medium">Teléfono</th>
            <th className="px-2 py-2 font-medium">Región</th>
            <th className="px-2 py-2 font-medium">Provincia</th>
            <th className="px-2 py-2 font-medium">Distrito</th>
            <th className="px-2 py-2 font-medium">Cobertura</th>
            <th className="px-2 py-2 font-medium">Modalidad</th>
            <th className="px-2 py-2 font-medium">Courier</th>
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
            <th className="px-2 py-2 font-medium">Antigüedad</th>
            <th className="px-2 py-2 font-medium">Guía</th>
            <th className="px-2 py-2 font-medium">Agencia</th>
            <th className="px-2 py-2 font-medium" title="Días disponible en agencia">
              Días ag.
            </th>
            <th className="px-2 py-2 font-medium">Pago / clave</th>
            <th className="px-2 py-2 text-center font-medium">💬</th>
            <th className="px-4 py-2 text-right font-medium">Costo</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr
              key={r.id}
              onClick={() => onOpen(r.order_id)}
              className="cursor-pointer border-b border-slate-100 last:border-0 hover:bg-slate-50"
            >
              <td className="px-4 py-2.5 font-medium text-slate-900">{r.order_name ?? "—"}</td>
              {multiStore && <td className="px-2 py-2.5 text-slate-600">{storeName(r.store_id)}</td>}
              <td className="px-2 py-2.5 text-slate-600">{fmtDate(r.order_created_at)}</td>
              <td className="max-w-[180px] truncate px-2 py-2.5 text-slate-700" title={r.customer_name ?? ""}>
                {r.customer_name ?? "—"}
              </td>
              <td className="px-2 py-2.5 text-slate-600">{r.customer_phone ?? "—"}</td>
              <td className="px-2 py-2.5 text-slate-600">{r.region ?? "—"}</td>
              <td className="px-2 py-2.5 text-slate-600">{r.province ?? "—"}</td>
              <td className="px-2 py-2.5 text-slate-600">{r.district ?? "—"}</td>
              <td className="px-2 py-2.5"><CoverageBadge coverage={r.coverage} /></td>
              <td className="px-2 py-2.5 text-slate-600">
                {r.shipping_mode ? (MODE_LABEL[r.shipping_mode] ?? r.shipping_mode) : "—"}
              </td>
              <td className="px-2 py-2.5 capitalize text-slate-700">{r.current_courier ?? "—"}</td>
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
              <td className="px-2 py-2.5 text-slate-600">{fmtAge(r.macro_since ?? r.status_since)}</td>
              <td className="px-2 py-2.5 font-mono text-xs text-slate-600">{r.guide_code ?? "—"}</td>
              <td className="px-2 py-2.5 text-slate-600" title={r.agency_branch ?? undefined}>
                {r.pickup_state ? operationalLabel(r.pickup_state) : "—"}
              </td>
              <td className="px-2 py-2.5 text-slate-600">
                <AgencyDays arrivedAt={r.agency_arrived_at} expiresAt={r.agency_expires_at} />
              </td>
              <td className="px-2 py-2.5 text-slate-600">
                <PaymentIndicator paymentState={r.payment_state} keyState={r.key_state} />
              </td>
              <td className="px-2 py-2.5 text-center text-slate-500">
                {r.comment_count > 0 ? r.comment_count : ""}
              </td>
              <td className="px-4 py-2.5 text-right text-slate-600">{fmtMoney(r.logistics_cost)}</td>
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

/** Secciones a las que se puede saltar desde la cabecera del drawer. El orden
 *  es el de la pantalla, para que la fila de atajos y el contenido cuenten la
 *  misma historia. */
const DRAWER_SECTIONS = [
  { id: "productos", label: "Productos" },
  { id: "rutas", label: "Rutas" },
  { id: "guias", label: "Guías" },
  { id: "pagos", label: "Pagos y clave" },
  { id: "ubicacion", label: "Ubicación" },
  { id: "cierre", label: "Cierre" },
  { id: "acciones", label: "Acciones" },
  { id: "historial", label: "Historial" },
] as const;

function OrderDrawer({
  orderId,
  canEdit,
  canOverride,
  canCreateGuide,
  canCreateTandersGuide,
  canCreateShalomGuide,
  closurePermissions,
  storeName,
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
  onClose: () => void;
  onSaved: () => void;
}) {
  const [detail, setDetail] = useState<OrderMasterDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLElement>(null);

  /** Lleva el panel a una sección. `scrollIntoView` dentro del propio panel, que
   *  es el que scrollea — no la página de detrás. */
  const jumpTo = (id: string) => {
    scrollRef.current
      ?.querySelector(`[data-drawer-section="${id}"]`)
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

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
        className="h-full w-full max-w-3xl overflow-y-auto bg-white shadow-2xl"
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

          {/* Saltar a una sección en vez de rodar el dedo por todo el panel. */}
          {detail && (
            <div className="flex gap-1 overflow-x-auto px-4 pb-2">
              {DRAWER_SECTIONS.map((sec) => (
                <button
                  key={sec.id}
                  onClick={() => jumpTo(sec.id)}
                  className="whitespace-nowrap rounded-lg px-2.5 py-1 text-xs font-medium text-slate-500 hover:bg-slate-100 hover:text-slate-800"
                >
                  {sec.label}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Pegados bajo la cabecera: un error que se pierde al scrollear es un
            error que nadie lee, y estas acciones mueven dinero y estados. */}
        {error && (
          <div className="sticky top-[104px] z-10 mx-5 mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </div>
        )}
        {notice && (
          <div className="sticky top-[104px] z-10 mx-5 mt-3 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
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
          <div className="space-y-5 p-5">
            <section className="space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <MacroStageBadge stage={detail.row.macro_stage} />
                <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600">
                  {macroSubstageLabel(detail.row.macro_substage)}
                </span>
                <span className="text-xs text-slate-400">
                  {fmtAge(detail.row.macro_since ?? detail.row.status_since)} en esta macroetapa · fuente:{" "}
                  {detail.row.status_source ?? "—"}
                </span>
              </div>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-3">
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
              </dl>
            </section>

            <GeoSection
              orderId={orderId}
              row={detail.row}
              canEdit={canEdit}
              onSaved={() => {
                void reload();
                onSaved();
              }}
            />

            {detail.lineItems.length > 0 && (
              <section>
                <h3 data-drawer-section="productos" className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500">
                  Productos
                </h3>
                <ul className="space-y-1 text-sm text-slate-700">
                  {detail.lineItems.map((li, i) => (
                    <li key={i} className="flex justify-between gap-3">
                      <span className="truncate">{li.title}</span>
                      <span className="shrink-0 text-slate-500">×{li.quantity}</span>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            <div data-drawer-section="rutas">
              <OrderRouteDesk
                plan={detail.routePlan}
                closed={detail.row.macro_stage === "finalizado"}
                actionEnabled={routeEnabled}
                onSelect={selectRoute}
              />
            </div>

            <section>
              <div className="mb-1.5 flex items-center gap-2">
                <h3
                  data-drawer-section="guias"
                  className="text-xs font-semibold uppercase tracking-wide text-slate-500"
                >
                  Couriers y guías ({detail.guides.length})
                </h3>
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
                      className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 text-sm"
                    >
                      <span className="font-medium capitalize text-slate-800">{g.courier}</span>
                      <span className="font-mono text-xs text-slate-500">
                        {outputDisplayCode(g.output_code, g.courier) || g.guide_code}
                      </span>
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
                          href={`/api/pedidos/rotulo/${g.id}`}
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
            </section>

            <div data-drawer-section="cierre">
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

            <section>
              <h3 data-drawer-section="historial" className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500">
                Línea de tiempo ({detail.timeline.length})
              </h3>
              {detail.timeline.length === 0 ? (
                <p className="text-sm text-slate-400">Sin movimientos registrados.</p>
              ) : (
                <ol className="space-y-2 border-l border-slate-200 pl-4">
                  {detail.timeline.map((t) => (
                    <li key={t.id} className="relative">
                      <span className="absolute -left-[21px] top-1.5 h-2 w-2 rounded-full bg-slate-300" />
                      <p className="text-sm text-slate-800">
                        {TIMELINE_LABEL[t.kind] ?? t.kind}
                        {t.newStatus && (
                          <span className="ml-1 text-slate-500">
                            → {generalLabel(t.newStatus)}
                          </span>
                        )}
                      </p>
                      {(t.note || t.reason) && (
                        <p className="text-sm text-slate-600">{t.note ?? t.reason}</p>
                      )}
                      <p className="text-xs text-slate-400">
                        {fmtDateTime(t.occurredAt)}
                        {t.actorName ? ` · ${t.actorName}` : ""}
                        {t.courier ? ` · ${t.courier}` : ""}
                        {t.guideCode ? ` · ${t.guideCode}` : ""}
                        {` · ${t.origin === "gestion" ? "Repro Provincia" : t.source}`}
                      </p>
                    </li>
                  ))}
                </ol>
              )}
            </section>

            {/* El panel de pagos aparece cuando el pedido YA va por agencia
                (`usesPickupKeyFlow`) y también cuando TODAVÍA PUEDE ir: si desde
                acá se ofrece «+ Guía Shalom», desde acá tiene que poder
                registrarse su adelanto.

                Sin la segunda condición había un callejón sin salida: el panel
                solo salía con `courier='shalom'`, que no existe hasta que la
                guía está creada, y crear la guía exige el adelanto. Para
                registrar el pago hacía falta la guía, y para la guía el pago. */}
            {(usesPickupKeyFlow(detail.row.current_courier, detail.row.shipping_mode) ||
              (canCreateShalomGuide && detail.routePlan.candidates.some((candidate) =>
                candidate.key === "shalom" || candidate.key === "olva"))) && (
              <div data-drawer-section="pagos">
                <PickupKeyPanel orderId={orderId} onChanged={onSaved} />
              </div>
            )}

            {/* Crear guía: solo tiene sentido en un pedido que todavía no tiene
                una. En cuanto existe, el seguimiento vive en Envíos. */}
            {canCreateGuide && (
              <div data-drawer-section="aliclik">
                <AliclikGuidePanel
                  orderId={orderId}
                  hasCoordinate={detail.row.latitude != null && detail.row.longitude != null}
                  onCreated={() => {
                    void reload();
                    onSaved();
                  }}
                />
              </div>
            )}

            {canEdit ? (
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
            ) : (
              <EmptyState title="Solo lectura">
                Tu rol permite consultar el pedido, sus comentarios y su historial, pero no modificarlo.
              </EmptyState>
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
    <section className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <h3 data-drawer-section="ubicacion" className="text-xs font-semibold uppercase tracking-wide text-slate-500">Ubicación</h3>
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
    <section className="space-y-4 border-t border-slate-200 pt-4">
      <div className="space-y-2">
        <h3 data-drawer-section="acciones" className="text-xs font-semibold uppercase tracking-wide text-slate-500">
          Registrar estado
        </h3>
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

      <div className="space-y-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
          Registrar devolución
        </h3>
        <p className="text-xs text-slate-400">
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
            className="flex-1 rounded-lg border border-slate-200 px-2 py-1.5 text-sm"
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

      <div className="space-y-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
          Corregir vínculo de guía
        </h3>
        <div className="flex gap-2">
          <input
            value={relinkCode}
            onChange={(e) => setRelinkCode(e.target.value)}
            placeholder="Código de guía a vincular a este pedido"
            className="flex-1 rounded-lg border border-slate-200 px-2 py-1.5 text-sm"
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
    </section>
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
      {totalPages > 1 && (
        <div className="flex items-center gap-1.5">
          <button
            disabled={busy || page <= 1}
            onClick={() => onPage(page - 1)}
            className="rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-40"
          >
            Anterior
          </button>
          <span className="px-1 text-xs text-slate-500">
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
      )}
    </div>
  );
}
