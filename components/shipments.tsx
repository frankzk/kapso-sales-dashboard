"use client";

import { useRouter } from "next/navigation";
import { memo, useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { cn, Card, STICKY_HEAD, TABLE_WRAP_FROM } from "@/components/ui";
import {
  COURIER_REPORT_RESULTS,
  attemptLabel,
  esPorRecuperar,
  evaluateAliclikReschedule,
  getFenixDeliverySchedule,
  isCallable,
  isShipmentReadyForContact,
  isShipmentReadyForContactToday,
  labelOf,
  matchesAliclikRouteFilter,
  normalizeCity,
  reprogramCourierOf,
  effectiveOrderName,
  rescheduleGuideCode,
  SHIPMENT_CLAIM_HEARTBEAT_MS,
  shipmentRequiresCourierResult,
  statusSince,
  type AliclikRescheduleReason,
  type AliclikRouteFilter,
  type ReprogramCourier,
  type CourierReportResult,
  type RerouteDisposition,
} from "@/lib/shipments";
import type {
  LinkedShipmentSummary,
  ShipmentCallRow,
  ShipmentHistoryGuide,
  ShipmentOrderDetail,
  ShipmentRow,
  StoreSummary,
} from "@/lib/types";
import { SHIPMENT_VIEWS, type ShipmentView, type ReproDayAgentNamed } from "@/lib/shipments-access";
import {
  RECOVERY_CALL_DISPOSITIONS,
  RECOVERY_LABEL,
  type RecoveryCallDisposition,
  type RecoveryKind,
} from "@/lib/reproprovincia";
import {
  sortShipmentRows,
  type ShipmentSortDirection,
  type ShipmentSortKey,
} from "@/lib/shipment-sort";
import {
  REPROGRAM_STALE_DAYS,
  REPROGRAM_UNASSIGNED,
  limaRangeBounds,
  limaTodayKey,
  localityMismatch,
  reprogramRangeStats,
  type ReprogramChildRow,
  type ReprogramCounts,
  type ReprogramStats,
} from "@/lib/shipments";
import {
  claimShipment,
  createFenixGuide,
  loadReprogramData,
  loadShipmentDetail,
  reprogramCancelledShipmentException,
  registerCourierReportResult,
  registerRecoveryCall,
  registerRerouteCall,
  releaseShipment,
  renewShipmentClaim,
  searchShipments,
  updateShipmentCallNote,
  updateShipmentDeliveryAddress,
  type ShipmentAddressInput,
} from "@/app/dashboard/envios/actions";
import { ChecklistFilter } from "@/components/filters";
import { OrderLinkPicker } from "@/components/order-link-picker";
import { DirectFenixGuideModal } from "@/components/direct-fenix-guide-modal";
import { SwaypNoveltyModal } from "@/components/swayp-novelty-modal";
import {
  currentFenixReason,
  matchesFenixAvailability,
  type FenixAvailabilityFilter,
} from "@/lib/fenix";

// Tres iconos, dibujados, del mismo trazo. Antes eran 🔍, ✕ y →: glifos de la
// fuente emoji del sistema, con otro peso en cada máquina y sin control de
// tamaño ni color.
function IconSearch({ className }: { className?: string }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" className={cn("h-4 w-4", className)}>
      <circle cx="7" cy="7" r="4.5" />
      <path d="M10.5 10.5 14 14" />
    </svg>
  );
}
function IconClose({ className }: { className?: string }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" className={cn("h-4 w-4", className)}>
      <path d="M4 4l8 8M12 4l-8 8" />
    </svg>
  );
}
function IconArrowRight({ className }: { className?: string }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className={cn("h-4 w-4", className)}>
      <path d="M3 8h10M9 4l4 4-4 4" />
    </svg>
  );
}

const CATEGORY_BADGE: Record<string, string> = {
  pending: "bg-amber-50 text-amber-700",
  in_route: "bg-violet-50 text-violet-700",
  delivered: "bg-emerald-50 text-emerald-700",
  closed: "bg-slate-100 text-slate-600",
  transferred: "bg-sky-50 text-sky-700",
};

const DISPOSITIONS: { key: RerouteDisposition; label: string }[] = [
  { key: "confirma", label: "Cliente confirma reprogramación" },
  { key: "programar", label: "Programar próxima llamada" },
  { key: "no_contesta", label: "No contesta" },
  { key: "entregado", label: "Entregado (Fenix)" },
  { key: "cancela", label: "Cliente cancela / anula" },
];

/** Next reprogrammed follow-up date (next_followup_at) as "12 ago", or "—".
 *  Read in UTC: the date is picked from `<input type=date>` and stored as UTC
 *  midnight, so this shows the day the operator chose (and matches the day the
 *  Fenix guide code is stamped with) regardless of the viewer's timezone. */
function fmtReprogram(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("es-PE", {
    day: "2-digit",
    month: "short",
    timeZone: "UTC",
  });
}

function fmtAliclikDate(date: string | null | undefined): string {
  if (!date) return "—";
  const parsed = new Date(`${date}T12:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) return "—";
  return parsed.toLocaleDateString("es-PE", {
    day: "2-digit",
    month: "short",
    timeZone: "UTC",
  });
}

/** Última gestión de nuestro equipo: fecha (Lima) + cuántos días lleva sin
 *  tocarse. days=null cuando nunca se gestionó. */
function fmtLastGestion(iso: string | null | undefined): { label: string; days: number | null } {
  if (!iso) return { label: "Sin gestión", days: null };
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return { label: "—", days: null };
  const label = new Date(t).toLocaleDateString("es-PE", {
    day: "2-digit",
    month: "short",
    timeZone: "America/Lima",
  });
  const days = Math.max(0, Math.floor((Date.now() - t) / 86_400_000));
  return { label, days };
}

function shipmentHistoryLabel(call: ShipmentCallRow): string {
  if (call.kind === "call" && !call.new_status && call.next_followup_at) {
    return "Llamada programada";
  }
  const labels: Record<string, string> = {
    call: "Gestión de llamada",
    courier_report: "Reporte Fenix",
    state_change: "Corrección administrativa",
    reroute: "Reprogramación",
    address_change: "Cambio de dirección",
    system: "Actualización del sistema",
  };
  return labels[call.kind] ?? call.kind;
}

function aliclikDecisionCopy(
  decision: ReturnType<typeof evaluateAliclikReschedule>,
): string {
  if (decision.eligible) return "Disponible: menos de 3 intentos y dentro de la semana vigente.";
  if (decision.reason === "three_attempts") return "Bloqueado: Aliclik registra 3 intentos o más.";
  if (decision.reason === "outside_week") {
    return `Bloqueado: la fecha está fuera de la ventana ${decision.cutoffDate}–${decision.today}.`;
  }
  if (decision.reason === "missing_attempts") return "Bloqueado: el Excel no informó NRO. INTENTOS.";
  if (decision.reason === "missing_service_date") return "Bloqueado: el Excel no informó la fecha operativa.";
  return "No aplica: esta ya no es una guía Aliclik.";
}

function localDateInputValue(date: Date = new Date()): string {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

function tomorrowDateInputValue(): string {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  return localDateInputValue(tomorrow);
}

/**
 * Segunda mitad del badge: «· Intento 3» en pendiente, «· por Fenix» en
 * entregado, y en una guía cerrada sin entregar, en qué quedó el PEDIDO:
 * «Anulado · Reproprovincia» mientras se puede reenviar, «· Recuperación
 * vencida» o «· Descartada» después. La primera mitad sigue siendo la guía —la
 * verdad del courier, que no se falsea—; la segunda es lo que hay que hacer.
 */
function subState(s: {
  status_category: string;
  reroute_attempts: number;
  delivered_source: string | null;
  recovery?: RecoveryKind | null;
}): string {
  if (s.status_category === "pending") return ` · ${attemptLabel(s.reroute_attempts)}`;
  if (s.status_category === "delivered" && s.delivered_source)
    return ` · por ${s.delivered_source === "fenix" ? "Fenix" : "Aliclik"}`;
  if (s.recovery) return ` · ${RECOVERY_LABEL[s.recovery]}`;
  return "";
}

/** "05 jul, 3:20 p. m." in the store's local time — when the shipment entered its
 *  current status (from `statusSince`). Null when the time is unknown/invalid. */
function fmtStatusSince(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString("es-PE", {
    timeZone: "America/Lima",
    day: "2-digit",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

function StatusBadge({
  category,
  status,
  suffix,
}: {
  category: string;
  status: string;
  suffix?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex rounded-full px-2 py-0.5 text-xs font-medium",
        CATEGORY_BADGE[category] ?? "bg-slate-100 text-slate-600",
      )}
    >
      {labelOf(status)}
      {suffix}
    </span>
  );
}

const SIN_DISTRITO = "(sin distrito)";
const SIN_DEPARTAMENTO = "(sin departamento)";

// Departamento del reporte de Aliclik (columna DEPARTAMENTO → region). Se usa el
// departamento, no la provincia, para agrupar el filtro superior.
function shipmentDepartment(shipment: Pick<ShipmentRow, "region">): string {
  return shipment.region?.trim() || SIN_DEPARTAMENTO;
}

export function ShipmentsBoard({
  stores,
  view,
  counts,
  shipments,
  reprogram,
  todayByAgent,
  initialOpenId,
}: {
  stores: StoreSummary[];
  view: ShipmentView;
  counts: Record<ShipmentView, number>;
  shipments: ShipmentRow[];
  reprogram?: ReprogramStats;
  todayByAgent?: ReproDayAgentNamed[];
  initialOpenId?: string | null;
}) {
  const router = useRouter();
  const [openId, setOpenId] = useState<string | null>(initialOpenId ?? null);

  // client-side filters over the loaded view. Empty set = "all".
  const [storeFilter, setStoreFilter] = useState<Set<string>>(new Set());
  const [departmentFilter, setDepartmentFilter] = useState<Set<string>>(new Set());
  const [districtFilter, setDistrictFilter] = useState<Set<string>>(new Set());
  const [dateFilter, setDateFilter] = useState(""); // YYYY-MM-DD on next_followup_at
  const [unmatchedOnly, setUnmatchedOnly] = useState(false);
  const [uncontactedTodayOnly, setUncontactedTodayOnly] = useState(view === "pendiente");
  // «Por recuperar»: las que Aliclik cerró sin entregar y el pedido todavía puede
  // reintentar con Swayp (MOM §11). Van en la MISMA cola —son la misma pregunta,
  // a quién hay que llamar— y este chip solo las acota dentro de Pendiente.
  const [soloPorRecuperar, setSoloPorRecuperar] = useState(false);
  const [uncontactedOnly, setUncontactedOnly] = useState(false);
  const [fenixFilter, setFenixFilter] = useState<FenixAvailabilityFilter>("all");
  const [aliclikRouteFilter, setAliclikRouteFilter] = useState<AliclikRouteFilter>("all");
  // "En ruta"/"Entregado": distinguir guías reprogramadas con Aliclik vs Fénix.
  const [reprogFilter, setReprogFilter] = useState<"all" | ReprogramCourier>("all");
  const [exportingFenix, setExportingFenix] = useState(false);
  const [fenixExportError, setFenixExportError] = useState<string | null>(null);
  const [directGuideOpen, setDirectGuideOpen] = useState(false);
  const [directGuideCreatedId, setDirectGuideCreatedId] = useState<string | null>(null);
  // En teléfono los diez filtros se pliegan detrás de un botón; en escritorio
  // van siempre a la vista.
  const [filtersOpen, setFiltersOpen] = useState(false);

  // global search (across all tabs, server-side)
  const [search, setSearch] = useState("");
  const [results, setResults] = useState<ShipmentRow[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [recentlyUpdatedId, setRecentlyUpdatedId] = useState<string | null>(null);
  const updatedRowTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Estable entre renders: es prop de la tabla memoizada. Si cambiara de
  // identidad en cada tecla del buscador, la tabla se repintaría entera.
  const storeName = useCallback(
    (id: string) => stores.find((s) => s.id === id)?.name ?? "—",
    [stores],
  );

  // Province is imported from Aliclik. Keep it separate from `city`, which is
  // the normalized Fenix coverage key and can intentionally contain a district.
  const departmentOptions = useMemo(
    () => Array.from(new Set(shipments.map(shipmentDepartment))).sort((a, b) => a.localeCompare(b)),
    [shipments],
  );
  const districtOptions = useMemo(
    () => Array.from(new Set(shipments.map((s) => s.district || SIN_DISTRITO))).sort((a, b) => a.localeCompare(b)),
    [shipments],
  );

  // Every view opens without province or district restrictions.
  useEffect(() => {
    setDepartmentFilter(new Set());
    setDistrictFilter(new Set());
    setDateFilter("");
    setUnmatchedOnly(false);
    setUncontactedTodayOnly(view === "pendiente");
    setUncontactedOnly(false);
    setFenixFilter("all");
    setAliclikRouteFilter("all");
    setReprogFilter("all");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);

  // debounced global search
  useEffect(() => {
    const term = search.trim();
    if (term.length < 2) {
      setResults(null);
      setSearching(false);
      return;
    }
    setSearching(true);
    let alive = true;
    const t = setTimeout(async () => {
      const r = await searchShipments(term);
      if (alive) {
        setResults(r);
        setSearching(false);
      }
    }, 280);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [search]);

  useEffect(() => () => {
    if (updatedRowTimerRef.current) clearTimeout(updatedRowTimerRef.current);
  }, []);

  // LA CADENA DE FILTROS SE RECALCULA SOLO CUANDO CAMBIA UN FILTRO. Medido el
  // 12-09-2026: Pendiente carga 3.089 filas y Entregado 4.042. Antes esto corría
  // en cada render del tablero —cada tecla del buscador, abrir o cerrar el
  // cajón, cada latido de la reserva— y, como devolvía un array nuevo, la
  // tabla entera se repintaba detrás. Con `useMemo` la identidad de `filtered`
  // se conserva y la tabla memoizada no se entera.
  const { filteredWithoutAliclikRoute, aliclikRouteCounts, filtered, fenixRowsForExport } = useMemo(() => {
    const base = shipments.filter(
      (s) =>
        (storeFilter.size === 0 || storeFilter.has(s.store_id)) &&
        (departmentFilter.size === 0 || departmentFilter.has(shipmentDepartment(s))) &&
        (districtFilter.size === 0 || districtFilter.has(s.district || SIN_DISTRITO)) &&
        (!dateFilter || (s.next_followup_at ? s.next_followup_at.slice(0, 10) === dateFilter : false)) &&
        (!unmatchedOnly || !s.matched) &&
        (!uncontactedTodayOnly ||
          view !== "pendiente" ||
          isShipmentReadyForContactToday(s.today_contact_count, s.next_followup_at)) &&
        (!uncontactedOnly ||
          view !== "pendiente" ||
          isShipmentReadyForContact(s.contact_count, s.next_followup_at)) &&
        (!soloPorRecuperar || esPorRecuperar(s)) &&
        (reprogFilter === "all" || reprogramCourierOf(s) === reprogFilter) &&
        matchesFenixAvailability(s, fenixFilter),
    );
    const routeCounts = base.reduce(
      (acc, shipment) => {
        const input = {
          courier: shipment.courier,
          statusCategory: shipment.status_category,
          attempts: shipment.aliclik_attempts,
          serviceDate: shipment.aliclik_service_date,
        };
        if (matchesAliclikRouteFilter(input, "aliclik_available")) {
          acc.aliclikAvailable += 1;
        } else if (matchesAliclikRouteFilter(input, "fenix_required")) {
          acc.fenixRequired += 1;
        }
        return acc;
      },
      { aliclikAvailable: 0, fenixRequired: 0 },
    );
    const byRoute = base.filter((shipment) =>
      matchesAliclikRouteFilter({
        courier: shipment.courier,
        statusCategory: shipment.status_category,
        attempts: shipment.aliclik_attempts,
        serviceDate: shipment.aliclik_service_date,
      }, aliclikRouteFilter),
    );
    return {
      filteredWithoutAliclikRoute: base,
      aliclikRouteCounts: routeCounts,
      filtered: byRoute,
      fenixRowsForExport: byRoute.filter(
        (shipment) => shipment.courier === "fenix" && shipment.status_category === "in_route",
      ),
    };
  }, [
    shipments,
    view,
    storeFilter,
    departmentFilter,
    districtFilter,
    dateFilter,
    unmatchedOnly,
    uncontactedTodayOnly,
    uncontactedOnly,
    soloPorRecuperar,
    reprogFilter,
    fenixFilter,
    aliclikRouteFilter,
  ]);

  // "Reprogramado por": conteos sobre la vista cargada (independiente de los
  // demás filtros) para etiquetar las opciones. Solo tiene sentido donde
  // conviven guías reprogramadas (En ruta y Entregado).
  const showReprogFilter = view === "en_ruta" || view === "entregado";
  const reprogCounts = shipments.reduce(
    (acc, s) => {
      const courier = reprogramCourierOf(s);
      if (courier === "aliclik") acc.aliclik += 1;
      else if (courier === "fenix") acc.fenix += 1;
      return acc;
    },
    { aliclik: 0, fenix: 0 },
  );

  const searchActive = search.trim().length >= 2;
  // Cuántos filtros se apartan del valor por defecto: es lo que el botón de
  // filtros muestra en teléfono para que no se olvide uno puesto.
  const activeFilters =
    (storeFilter.size > 0 ? 1 : 0) +
    (departmentFilter.size > 0 ? 1 : 0) +
    (districtFilter.size > 0 ? 1 : 0) +
    (dateFilter ? 1 : 0) +
    (unmatchedOnly ? 1 : 0) +
    (soloPorRecuperar ? 1 : 0) +
    (uncontactedOnly ? 1 : 0) +
    (uncontactedTodayOnly !== (view === "pendiente") ? 1 : 0) +
    (fenixFilter !== "all" ? 1 : 0) +
    (aliclikRouteFilter !== "all" ? 1 : 0) +
    (reprogFilter !== "all" ? 1 : 0);

  function go(params: Record<string, string>) {
    const sp = new URLSearchParams({ view, ...params });
    router.push(`/dashboard/envios?${sp.toString()}`);
  }

  function toggleStore(id: string) {
    setStoreFilter((prev) => {
      const next = new Set(prev);
      if (next.size === 0) stores.forEach((s) => next.add(s.id)); // "all" → start from all
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function handleShipmentUpdated(id: string) {
    // The server-rendered queue refreshes in the background. Global search is
    // client-side state, so refresh it explicitly to avoid leaving a stale row.
    router.refresh();
    const term = search.trim();
    if (term.length >= 2) {
      try {
        setResults(await searchShipments(term));
      } catch {
        // The drawer still reloads the saved record; a later search can retry.
      }
    }

    setRecentlyUpdatedId(id);
    if (updatedRowTimerRef.current) clearTimeout(updatedRowTimerRef.current);
    updatedRowTimerRef.current = setTimeout(() => {
      setRecentlyUpdatedId((current) => current === id ? null : current);
    }, 2400);
  }

  /**
   * Al cerrar el modal de guía directa, lleva a la pestaña donde la guía
   * realmente nació (En ruta) y la resalta. Sin esto, crearla desde Pendiente
   * parece no hacer nada: el refresco ocurre, pero la guía nueva no pertenece a
   * esa lista. Limpia además los filtros del cliente (fecha, tienda, distrito…)
   * que podrían esconderla.
   */
  function handleDirectGuideModalClosed() {
    setDirectGuideOpen(false);
    const createdId = directGuideCreatedId;
    if (!createdId) return;
    setDirectGuideCreatedId(null);

    setStoreFilter(new Set());
    setDepartmentFilter(new Set());
    setDistrictFilter(new Set());
    setDateFilter("");
    setUnmatchedOnly(false);
    setUncontactedTodayOnly(false);
    setUncontactedOnly(false);
    setFenixFilter("all");
    setAliclikRouteFilter("all");
    setReprogFilter("all");
    setSearch("");

    if (view !== "en_ruta") go({ view: "en_ruta" });
    router.refresh();

    setRecentlyUpdatedId(createdId);
    if (updatedRowTimerRef.current) clearTimeout(updatedRowTimerRef.current);
    updatedRowTimerRef.current = setTimeout(() => {
      setRecentlyUpdatedId((current) => (current === createdId ? null : current));
    }, 6000);
  }

  async function downloadFenixProgrammingWorkbook() {
    if (!dateFilter || !fenixRowsForExport.length || exportingFenix) return;
    setExportingFenix(true);
    setFenixExportError(null);
    try {
      const response = await fetch("/api/export/fenix-programacion", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          date: dateFilter,
          shipmentIds: fenixRowsForExport.map((shipment) => shipment.id),
        }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => null) as { error?: string } | null;
        throw new Error(payload?.error || "No se pudo generar el Excel de Fenix.");
      }

      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `fenix_programacion_${dateFilter}.xlsx`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (error) {
      setFenixExportError(
        error instanceof Error ? error.message : "No se pudo generar el Excel de Fenix.",
      );
    } finally {
      setExportingFenix(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-lg font-semibold text-slate-900">Repro Provincia</h1>
        {/* En teléfono la búsqueda ocupa el ancho entero y las acciones bajan a
            su propia fila; en escritorio todo cabe en una línea. */}
        <div className="flex w-full flex-wrap items-center gap-2 md:w-auto">
          {/* global search */}
          <div className="relative w-full md:w-auto">
            <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500">
              <IconSearch />
            </span>
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Buscar guía, pedido, guía Fenix, celular…"
              aria-label="Buscar guía, pedido, guía Fenix o celular"
              className="w-full rounded-lg border border-slate-200 py-1.5 pl-8 pr-7 text-sm md:w-64"
            />
            {search && (
              <button
                type="button"
                onClick={() => setSearch("")}
                aria-label="Limpiar búsqueda"
                className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-800"
              >
                <IconClose />
              </button>
            )}
          </div>
          <a
            href="/dashboard/envios/import"
            className="rounded-lg bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700"
          >
            Importar reporte
          </a>
          <button
            onClick={() => setDirectGuideOpen(true)}
            className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            Guía Fenix directa
          </button>
          <a
            href="/dashboard/envios/stock"
            className="rounded-lg border border-slate-200 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            Stock Fenix
          </a>
        </div>
      </div>

      {reprogram && <ReprogramStrip stats={reprogram} stores={stores} />}

      {todayByAgent && <TodayByAgentPanel rows={todayByAgent} />}

      {searchActive ? (
        <Card className="p-0">
          <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3">
            <p className="text-sm font-medium text-slate-800">
              Resultados de búsqueda {results ? `(${results.length})` : ""}
            </p>
            <button onClick={() => setSearch("")} className="text-xs text-slate-500 hover:underline">
              Limpiar búsqueda
            </button>
          </div>
          {searching ? (
            <p className="p-5 text-sm text-slate-500">Buscando…</p>
          ) : results && results.length > 0 ? (
            <ShipmentTable
              rows={results}
              stores={stores}
              storeName={storeName}
              onOpen={setOpenId}
              highlightedId={recentlyUpdatedId}
            />
          ) : (
            <p className="p-5 text-sm text-slate-500">Sin coincidencias.</p>
          )}
        </Card>
      ) : (
        <>
          {/* tabs: en teléfono una tira que se desliza con el pulgar (seis
              pestañas no caben en 360 px sin partirse en tres filas). */}
          <div className="-mx-4 flex gap-1.5 overflow-x-auto px-4 md:mx-0 md:flex-wrap md:overflow-visible md:px-0">
            {SHIPMENT_VIEWS.map((v) => (
              <button
                key={v.key}
                onClick={() => go({ view: v.key })}
                className={cn(
                  "shrink-0 whitespace-nowrap rounded-lg px-3 py-1.5 text-sm font-medium transition",
                  v.key === view ? "bg-brand-50 text-brand-700" : "text-slate-600 hover:bg-slate-50",
                )}
              >
                {v.label}
                <span className="ml-1.5 text-xs text-slate-500">{counts[v.key]}</span>
              </button>
            ))}
          </div>

          {/* filters: store chips + district multi-select + programación date */}
          {view !== "revision" && (
            <button
              type="button"
              onClick={() => setFiltersOpen((v) => !v)}
              aria-expanded={filtersOpen}
              className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 md:hidden"
            >
              {filtersOpen ? "Ocultar filtros" : "Filtros"}
              {activeFilters > 0 && (
                <span className="ml-1.5 rounded-full bg-brand-50 px-1.5 text-xs font-semibold text-brand-700">
                  {activeFilters}
                </span>
              )}
            </button>
          )}
          {view !== "revision" && (
            <div className={cn("flex-wrap items-center gap-2", filtersOpen ? "flex" : "hidden md:flex")}>
              {stores.length > 1 && (
                <div className="flex items-center gap-1.5">
                  <span className="text-xs text-slate-500">Tienda:</span>
                  {stores.map((s) => {
                    const active = storeFilter.size === 0 || storeFilter.has(s.id);
                    return (
                      <button
                        key={s.id}
                        onClick={() => toggleStore(s.id)}
                        className={cn(
                          "rounded-full border px-2.5 py-1 text-xs font-medium transition",
                          active
                            ? "border-brand-200 bg-brand-50 text-brand-700"
                            : "border-slate-200 bg-white text-slate-500",
                        )}
                      >
                        {s.name}
                      </button>
                    );
                  })}
                </div>
              )}
              {departmentOptions.length > 1 && (
                <ChecklistFilter
                  label="Departamento"
                  options={departmentOptions}
                  selected={departmentFilter}
                  onChange={setDepartmentFilter}
                />
              )}
              {districtOptions.length > 1 && (
                <ChecklistFilter
                  label="Distrito"
                  options={districtOptions}
                  selected={districtFilter}
                  onChange={setDistrictFilter}
                />
              )}
              <label className="flex items-center gap-1.5 text-xs text-slate-500">
                Programación:
                <input
                  type="date"
                  value={dateFilter}
                  onChange={(e) => setDateFilter(e.target.value)}
                  className="rounded-lg border border-slate-200 px-2 py-1 text-xs text-slate-700"
                />
              </label>
              {view === "en_ruta" && (
                <button
                  type="button"
                  onClick={downloadFenixProgrammingWorkbook}
                  disabled={!dateFilter || !fenixRowsForExport.length || exportingFenix}
                  title={
                    !dateFilter
                      ? "Elige primero la fecha de programación"
                      : !fenixRowsForExport.length
                        ? "No hay guías Fenix visibles para esa fecha"
                        : "Descarga las guías Fenix que quedan en la lista"
                  }
                  className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {exportingFenix
                    ? "Generando Excel…"
                    : !dateFilter
                      ? "Elige fecha para Excel"
                      : `Descargar Excel Fenix (${fenixRowsForExport.length})`}
                </button>
              )}
              {view === "pendiente" && (
                <label className="flex items-center gap-1.5 text-xs text-slate-500">
                  Gestión:
                  <select
                    value={aliclikRouteFilter}
                    onChange={(e) => setAliclikRouteFilter(e.target.value as AliclikRouteFilter)}
                    className={cn(
                      "rounded-lg border px-2 py-1 text-xs font-medium",
                      aliclikRouteFilter === "aliclik_available"
                        ? "border-brand-200 bg-brand-50 text-brand-700"
                        : aliclikRouteFilter === "fenix_required"
                          ? "border-brand-200 bg-brand-50 text-brand-700"
                          : "border-slate-200 bg-white text-slate-700",
                    )}
                  >
                    <option value="all">Todas las rutas</option>
                    <option value="aliclik_available">
                      Aliclik disponible ({aliclikRouteCounts.aliclikAvailable})
                    </option>
                    <option value="fenix_required">
                      Fenix requerido ({aliclikRouteCounts.fenixRequired})
                    </option>
                  </select>
                </label>
              )}
              <label className="flex items-center gap-1.5 text-xs text-slate-500">
                Fenix:
                <select
                  value={fenixFilter}
                  onChange={(e) => {
                    const next = e.target.value as FenixAvailabilityFilter;
                    setFenixFilter(next);
                    if (next === "sin_stock" || next === "sin_cobertura") {
                      setDepartmentFilter(new Set());
                    }
                  }}
                  className="rounded-lg border border-slate-200 px-2 py-1 text-xs text-slate-700"
                >
                  <option value="all">Todos</option>
                  <option value="ok">Fenix ok · con stock</option>
                  <option value="sin_stock">Sin stock Fenix</option>
                  <option value="sin_cobertura">Fuera de cobertura</option>
                </select>
              </label>
              {showReprogFilter && (
                <label className="flex items-center gap-1.5 text-xs text-slate-500">
                  Reprogramado por:
                  <select
                    value={reprogFilter}
                    onChange={(e) => setReprogFilter(e.target.value as "all" | ReprogramCourier)}
                    className={cn(
                      "rounded-lg border px-2 py-1 text-xs font-medium",
                      reprogFilter === "aliclik"
                        ? "border-brand-200 bg-brand-50 text-brand-700"
                        : reprogFilter === "fenix"
                          ? "border-brand-200 bg-brand-50 text-brand-700"
                          : "border-slate-200 bg-white text-slate-700",
                    )}
                  >
                    <option value="all">Aliclik y Fénix</option>
                    <option value="aliclik">Aliclik ({reprogCounts.aliclik})</option>
                    <option value="fenix">Fénix ({reprogCounts.fenix})</option>
                  </select>
                </label>
              )}
              <label className="flex items-center gap-1.5 text-xs text-slate-600">
                <input
                  type="checkbox"
                  checked={unmatchedOnly}
                  onChange={(e) => setUnmatchedOnly(e.target.checked)}
                  className="rounded border-slate-300"
                />
                Solo sin pedido
              </label>
              {view === "pendiente" && (
                <>
                  <label
                    className="flex items-center gap-1.5 text-xs text-slate-600"
                    title="Aliclik las cerró sin entregar y el pedido sigue en ventana de recuperación: admite una salida Swayp. Las vencidas y las descartadas ya no están en esta cola."
                  >
                    <input
                      type="checkbox"
                      checked={soloPorRecuperar}
                      onChange={(e) => setSoloPorRecuperar(e.target.checked)}
                      className="rounded border-slate-300"
                    />
                    Por recuperar
                  </label>
                  <label className="flex items-center gap-1.5 text-xs text-slate-600">
                    <input
                      type="checkbox"
                      checked={uncontactedTodayOnly}
                      onChange={(e) => setUncontactedTodayOnly(e.target.checked)}
                      className="rounded border-slate-300"
                    />
                    Solo sin contactar hoy
                  </label>
                  <label className="flex items-center gap-1.5 text-xs text-slate-600">
                    <input
                      type="checkbox"
                      checked={uncontactedOnly}
                      onChange={(e) => setUncontactedOnly(e.target.checked)}
                      className="rounded border-slate-300"
                    />
                    Solo sin contactar
                  </label>
                </>
              )}
              {(storeFilter.size > 0 ||
                departmentFilter.size > 0 ||
                districtFilter.size > 0 ||
                dateFilter ||
                unmatchedOnly ||
                uncontactedTodayOnly ||
                uncontactedOnly ||
                aliclikRouteFilter !== "all" ||
                reprogFilter !== "all" ||
                fenixFilter !== "all") && (
                <button
                  onClick={() => {
                    setStoreFilter(new Set());
                    setDepartmentFilter(new Set());
                    setDistrictFilter(new Set());
                    setDateFilter("");
                    setUnmatchedOnly(false);
                    setUncontactedTodayOnly(false);
                    setUncontactedOnly(false);
                    setAliclikRouteFilter("all");
                    setReprogFilter("all");
                    setFenixFilter("all");
                  }}
                  className="text-xs text-slate-500 hover:underline"
                >
                  Limpiar filtros
                </button>
              )}
              <span className="ml-auto text-xs text-slate-500">
                Mostrando {filtered.length} de {shipments.length}
              </span>
            </div>
          )}
          {fenixExportError && (
            <div
              role="alert"
              className="flex items-start justify-between gap-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-800"
            >
              <span className="break-words">{fenixExportError}</span>
              <button
                type="button"
                onClick={() => setFenixExportError(null)}
                className="shrink-0 font-semibold text-rose-700 hover:underline"
              >
                Cerrar
              </button>
            </div>
          )}

          {view === "revision" ? (
            <Card>
              <p className="text-sm text-slate-500">
                Las filas por revisar se gestionan desde{" "}
                <a className="text-brand-700 underline" href="/dashboard/envios/import">
                  Importar reporte
                </a>
                .
              </p>
            </Card>
          ) : (
            <Card className="p-0">
              {filtered.length === 0 ? (
                <p className="p-5 text-sm text-slate-500">
                  {shipments.length === 0 ? "Sin envíos en esta vista." : "Ningún envío con esos filtros."}
                </p>
              ) : (
                <ShipmentTable
                  rows={filtered}
                  stores={stores}
                  storeName={storeName}
                  onOpen={setOpenId}
                  highlightedId={recentlyUpdatedId}
                />
              )}
            </Card>
          )}
        </>
      )}

      {openId && (
        <ShipmentDrawer
          shipmentId={openId}
          onClose={() => setOpenId(null)}
          onOpenShipment={setOpenId}
          onShipmentUpdated={handleShipmentUpdated}
        />
      )}

      {directGuideOpen && (
        <DirectFenixGuideModal
          onClose={handleDirectGuideModalClosed}
          onCreated={(shipmentId) => {
            // Refresca ya (contadores/pestañas) y recuerda la guía para saltar a
            // "En ruta" y resaltarla cuando se cierre el modal.
            setDirectGuideCreatedId(shipmentId ?? null);
            router.refresh();
          }}
        />
      )}
    </div>
  );
}

/**
 * Filas que se pintan de una vez. Pendiente trae 3.089 y Entregado 4.042: a
 * once celdas y un botón por fila son más de 30.000 nodos, y el navegador los
 * maqueta todos aunque la pantalla muestre veinte. Se pintan las primeras 200
 * —ordenadas y filtradas sobre el conjunto ENTERO, no sobre la ventana— y un
 * botón trae 200 más o todas. Nada se esconde: el contador de arriba sigue
 * diciendo cuántas hay, y la búsqueda global y los filtros ven el total.
 */
const VISIBLE_STEP = 200;

// Memoizada: con `rows` y `storeName` estables, escribir en el buscador, abrir
// el cajón o renovar la reserva ya no repinta la tabla.
const ShipmentTable = memo(function ShipmentTable({
  rows,
  stores,
  storeName,
  onOpen,
  highlightedId,
}: {
  rows: ShipmentRow[];
  stores: StoreSummary[];
  storeName: (id: string) => string;
  onOpen: (id: string) => void;
  highlightedId?: string | null;
}) {
  const [sort, setSort] = useState<{
    key: ShipmentSortKey;
    direction: ShipmentSortDirection;
  } | null>(null);
  const sortedRows = useMemo(
    () => sort ? sortShipmentRows(rows, sort.key, sort.direction, storeName) : rows,
    [rows, sort, storeName],
  );

  // La ventana vuelve al principio cuando cambian las filas (otro filtro, otra
  // pestaña, una recarga): lo que se pidió ver fue de ESE conjunto.
  const [visibleCount, setVisibleCount] = useState(VISIBLE_STEP);
  const [windowFor, setWindowFor] = useState(rows);
  if (windowFor !== rows) {
    setWindowFor(rows);
    setVisibleCount(VISIBLE_STEP);
  }
  // La fila recién actualizada se ve aunque caiga fuera de la ventana: es la
  // que la persona acaba de tocar.
  const highlightedIndex = highlightedId ? sortedRows.findIndex((r) => r.id === highlightedId) : -1;
  const shownCount = Math.min(sortedRows.length, Math.max(visibleCount, highlightedIndex + 1));
  const shownRows = shownCount < sortedRows.length ? sortedRows.slice(0, shownCount) : sortedRows;
  const hiddenCount = sortedRows.length - shownRows.length;

  function toggleSort(key: ShipmentSortKey) {
    setSort((current) => ({
      key,
      direction: current?.key === key && current.direction === "asc" ? "desc" : "asc",
    }));
  }

  return (
    // ONCE COLUMNAS NO ENTRAN EN UN PORTÁTIL. Con la barra lateral y el cajón
    // de 34 rem abierto, en 1.280–1.600 px las columnas de la derecha quedaban
    // bajo el cajón o la página entera scrolleaba en horizontal (la barra
    // lateral se iba de lado). Ahora la tabla tiene ancho propio y el
    // contenedor scrollea hasta que entra de verdad; por encima de 1.800 px
    // vuelve el encabezado fijo (ver TABLE_WRAP_FROM en ui.tsx). Y por debajo
    // de `xl`, Producto y Última entrega Aliclik —que el cajón muestra enteras—
    // se esconden para que la cola quepa con menos scroll.
    <div>
    <div className={cn("hidden md:block", TABLE_WRAP_FROM[1800])}>
      <table className="w-full min-w-[1100px] text-sm xl:min-w-[1400px]">
        <thead>
          <tr className={cn(STICKY_HEAD, "text-xs text-slate-500")}>
            <SortableShipmentHeader label="Guía" sortKey="guide" sort={sort} onSort={toggleSort} />
            {stores.length > 1 && (
              <SortableShipmentHeader label="Tienda" sortKey="store" sort={sort} onSort={toggleSort} />
            )}
            <SortableShipmentHeader label="Pedido" sortKey="order" sort={sort} onSort={toggleSort} />
            <SortableShipmentHeader label="Cliente" sortKey="customer" sort={sort} onSort={toggleSort} />
            <SortableShipmentHeader label="Producto" sortKey="product" sort={sort} onSort={toggleSort} className={SECONDARY_COLUMN} />
            <SortableShipmentHeader label="Distrito / Ciudad" sortKey="location" sort={sort} onSort={toggleSort} />
            <SortableShipmentHeader label="Estado" sortKey="status" sort={sort} onSort={toggleSort} />
            <SortableShipmentHeader label="Última entrega Aliclik" sortKey="lastDelivery" sort={sort} onSort={toggleSort} className={SECONDARY_COLUMN} />
            <SortableShipmentHeader label="Última gestión" sortKey="lastGestion" sort={sort} onSort={toggleSort} />
            <SortableShipmentHeader label="Reprogramación" sortKey="reprogramming" sort={sort} onSort={toggleSort} />
            <SortableShipmentHeader label="Ruta sugerida" sortKey="route" sort={sort} onSort={toggleSort} />
          </tr>
        </thead>
        <tbody>
          {shownRows.map((s) => (
            <tr
              key={s.id}
              onClick={() => onOpen(s.id)}
              className={cn(
                "cursor-pointer border-b border-slate-100 transition-colors duration-500 last:border-0",
                highlightedId === s.id ? "bg-emerald-50" : "hover:bg-slate-50",
              )}
            >
              <td className="px-4 py-2.5 font-mono text-xs text-slate-700">
                {/* La fila entera abre con el ratón; el código es lo que abre
                    con el teclado. Sin este botón la cola no se podía trabajar
                    sin ratón: ninguna guía era alcanzable con Tab. */}
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onOpen(s.id);
                  }}
                  className="rounded-sm font-mono text-slate-800 underline-offset-2 hover:underline"
                >
                  {s.guide_code}
                </button>
                {s.courier === "fenix" && (
                  <span className="ml-1 rounded bg-orange-50 px-1 text-xs text-orange-700">Fenix</span>
                )}
                {s.created_via === "fenix_directo" && (
                  <span className="ml-1 rounded bg-indigo-50 px-1 text-xs text-indigo-700">Directa</span>
                )}
              </td>
              {stores.length > 1 && (
                <td className="px-4 py-2.5 text-slate-600">{storeName(s.store_id)}</td>
              )}
              <td className="px-4 py-2.5 text-slate-700">
                <OrderNameLabel name={s.order_name} matched={s.matched} />
              </td>
              <td className="px-4 py-2.5 text-slate-700">
                {s.customer_name ?? "—"}
                <span className="block text-xs text-slate-500">{s.customer_phone ?? ""}</span>
              </td>
              <td className={cn(SECONDARY_COLUMN, "w-44 max-w-44 px-3 py-2.5 align-middle")}>
                <span
                  className="line-clamp-2 text-xs leading-4 text-slate-600"
                  title={s.product ?? undefined}
                >
                  {s.product ?? "—"}
                </span>
              </td>
              <td className="px-4 py-2.5 text-slate-700">
                {s.district ?? "—"}
                <span className="block text-xs capitalize text-slate-500">
                  {s.city ?? ""}
                  <FenixAvailabilityInline shipment={s} />
                </span>
              </td>
              <td className="px-4 py-2.5">
                <StatusBadge category={s.status_category} status={s.delivery_status} suffix={subState(s)} />
              </td>
              <td className={cn(SECONDARY_COLUMN, "px-4 py-2.5 whitespace-nowrap text-slate-700 tabular-nums")}>
                {fmtAliclikDate(s.aliclik_service_date)}
              </td>
              <td className="px-4 py-2.5 whitespace-nowrap tabular-nums">
                {(() => {
                  const g = fmtLastGestion(s.last_gestion_at);
                  return (
                    <>
                      <span className={g.days == null ? "text-slate-500" : "text-slate-700"}>
                        {g.label}
                      </span>
                      {g.days != null && (
                        <span
                          className={cn(
                            "block text-xs",
                            g.days >= 7 ? "font-semibold text-amber-700" : "text-slate-500",
                          )}
                        >
                          {g.days === 0 ? "hoy" : `hace ${g.days} d`}
                        </span>
                      )}
                    </>
                  );
                })()}
              </td>
              <td className="px-4 py-2.5 tabular-nums text-slate-600">
                {fmtReprogram(s.next_followup_at)}
                {highlightedId === s.id && (
                  <span className="block text-xs font-semibold text-emerald-700">Actualizado</span>
                )}
              </td>
              <td className="px-4 py-2.5"><AliclikRouteCell shipment={s} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>

      {/* EN TELÉFONO LA COLA SON TARJETAS, no una tabla de once columnas
          apretada. Cada tarjeta lleva lo que hace falta para decidir a quién
          llamar —guía, estado, cliente, destino, reprogramación, ruta— y un
          botón «Llamar» con `tel:` al alcance del pulgar: en el celular la
          llamada se hace desde el mismo aparato. Misma ventana de 200 filas y
          mismo orden que la tabla; solo cambia la forma. */}
      <ul className="divide-y divide-slate-100 md:hidden">
        {shownRows.map((s) => {
          const gestion = fmtLastGestion(s.last_gestion_at);
          return (
            <li
              key={s.id}
              className={cn(
                "flex items-start gap-3 px-4 py-3",
                highlightedId === s.id ? "bg-emerald-50" : "",
              )}
            >
              <button
                type="button"
                onClick={() => onOpen(s.id)}
                className="min-w-0 flex-1 rounded-md text-left"
              >
                <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="font-mono text-sm text-slate-800">{s.guide_code}</span>
                  {s.courier === "fenix" && (
                    <span className="rounded bg-orange-50 px-1 text-xs text-orange-700">Fenix</span>
                  )}
                  {s.created_via === "fenix_directo" && (
                    <span className="rounded bg-indigo-50 px-1 text-xs text-indigo-700">Directa</span>
                  )}
                  <StatusBadge category={s.status_category} status={s.delivery_status} suffix={subState(s)} />
                </span>
                <span className="mt-1 block text-sm text-slate-800">{s.customer_name ?? "—"}</span>
                <span className="block text-xs text-slate-500">
                  {[s.district, s.city].filter(Boolean).join(" · ") || "—"}
                  <FenixAvailabilityInline shipment={s} />
                </span>
                <span className="mt-1 block text-xs tabular-nums text-slate-500">
                  Reprogramación {fmtReprogram(s.next_followup_at)}
                  {gestion.days != null && (
                    <span className={gestion.days >= 7 ? "font-semibold text-amber-700" : ""}>
                      {" · "}última gestión {gestion.days === 0 ? "hoy" : `hace ${gestion.days} d`}
                    </span>
                  )}
                  {highlightedId === s.id && (
                    <span className="ml-2 font-semibold text-emerald-700">Actualizado</span>
                  )}
                </span>
                <span className="mt-1 block text-xs">
                  <AliclikRouteCell shipment={s} />
                </span>
              </button>
              {s.customer_phone && (
                <a
                  href={`tel:${s.customer_phone.replace(/[^\d+]/g, "")}`}
                  className="inline-flex shrink-0 items-center rounded-lg border border-slate-200 px-3 py-2 text-xs font-medium text-slate-700"
                >
                  Llamar
                </a>
              )}
            </li>
          );
        })}
      </ul>
      {hiddenCount > 0 && (
        <div className="flex flex-wrap items-center gap-3 border-t border-slate-100 px-4 py-2.5 text-xs text-slate-500">
          <span>
            Se muestran {shownRows.length} de {sortedRows.length}.
          </span>
          <button
            type="button"
            onClick={() => setVisibleCount((n) => n + VISIBLE_STEP)}
            className="font-medium text-brand-700 hover:underline"
          >
            Mostrar {Math.min(VISIBLE_STEP, hiddenCount)} más
          </button>
          {hiddenCount > VISIBLE_STEP && (
            <button
              type="button"
              onClick={() => setVisibleCount(sortedRows.length)}
              className="font-medium text-brand-700 hover:underline"
            >
              Mostrar todas
            </button>
          )}
        </div>
      )}
    </div>
  );
});

/** Columnas que el cajón ya muestra enteras: solo a partir de `xl`. */
const SECONDARY_COLUMN = "hidden xl:table-cell";

function SortableShipmentHeader({
  label,
  sortKey,
  sort,
  onSort,
  className,
}: {
  label: string;
  sortKey: ShipmentSortKey;
  sort: { key: ShipmentSortKey; direction: ShipmentSortDirection } | null;
  onSort: (key: ShipmentSortKey) => void;
  className?: string;
}) {
  const active = sort?.key === sortKey;
  const ariaSort = active ? (sort.direction === "asc" ? "ascending" : "descending") : "none";
  return (
    // El fondo/sticky/separador los pone STICKY_HEAD desde el <tr> (ver ui.tsx).
    <th
      scope="col"
      aria-sort={ariaSort}
      className={cn("px-2 py-1 text-left font-medium first:pl-4 last:pr-4", className)}
    >
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        title={`Ordenar por ${label}`}
        className={cn(
          // hover un tono por encima del fondo del encabezado (slate-100), que
          // si no el estado no se notaría.
          "group inline-flex min-h-8 w-full items-center gap-1 rounded-md px-2 text-left transition hover:bg-slate-100 hover:text-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400",
          active && "bg-brand-50 text-brand-700",
        )}
      >
        <span>{label}</span>
        <span
          aria-hidden="true"
          className={cn(
            "text-xs transition",
            active ? "text-brand-600" : "text-slate-300 group-hover:text-slate-500",
          )}
        >
          {active ? (sort.direction === "asc" ? "↑" : "↓") : "↕"}
        </span>
      </button>
    </th>
  );
}

function AliclikRouteCell({ shipment }: { shipment: ShipmentRow }) {
  if (shipment.courier !== "aliclik" || shipment.status_category !== "pending") {
    return <span className="text-slate-500">—</span>;
  }
  const decision = evaluateAliclikReschedule({
    courier: shipment.courier,
    attempts: shipment.aliclik_attempts,
    serviceDate: shipment.aliclik_service_date,
  });
  if (decision.eligible) {
    return (
      <div className="min-w-32">
        <span className="inline-flex rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-semibold text-emerald-800">
          Aliclik disponible
        </span>
        <span className="mt-0.5 block text-xs leading-4 text-emerald-700">
          Dentro de ventana · {shipment.aliclik_attempts ?? 0}/3 intentos
        </span>
      </div>
    );
  }

  const reasonLabels: Partial<Record<AliclikRescheduleReason, string>> = {
    three_attempts: "3 intentos alcanzados",
    outside_week: "Fuera de la ventana operativa",
    missing_attempts: "Sin NRO. INTENTOS en Excel",
    missing_service_date: "Sin fecha Aliclik en Excel",
  };
  return (
    <div className="min-w-32">
      <span className="inline-flex rounded-full bg-orange-100 px-2 py-0.5 text-xs font-semibold text-orange-800">
        Fenix requerido
      </span>
      <span className="mt-0.5 block text-xs leading-4 text-orange-700">
        {reasonLabels[decision.reason] ?? "Aliclik no disponible"}
      </span>
    </div>
  );
}

function FenixAvailabilityInline({ shipment }: { shipment: ShipmentRow }) {
  const reason = currentFenixReason(shipment);
  if (reason === "ok") {
    return <span className="ml-1 font-medium text-emerald-700">· Fenix ok</span>;
  }
  if (reason === "sin_stock") {
    return <span className="ml-1 font-medium text-amber-700">· Sin stock Fenix</span>;
  }
  return <span className="ml-1 font-medium text-rose-600">· Fuera de cobertura</span>;
}

function ShipmentDrawer({
  shipmentId,
  onClose,
  onOpenShipment,
  onShipmentUpdated,
}: {
  shipmentId: string;
  onClose: () => void;
  onOpenShipment: (id: string) => void;
  onShipmentUpdated: (id: string) => void | Promise<void>;
}) {
  // Se DERIVA de la acción del servidor en vez de reescribirla a mano. Estaba
  // copiada campo por campo, así que un dato nuevo en `loadShipmentDetail`
  // llegaba al cliente y el tipo no lo dejaba usar hasta acordarse de añadirlo
  // en los dos sitios. Es el mismo hecho escrito dos veces, que es lo que este
  // repo repite.
  const [detail, setDetail] = useState<Awaited<ReturnType<typeof loadShipmentDetail>> | null>(null);
  const [noveltyOpen, setNoveltyOpen] = useState(false);
  // Lo que respondió la última acción, CON su naturaleza. Un error y un aviso
  // se pintaban con el mismo gris («Vincula el pedido antes de descartar» se
  // leía como una nota), y el aviso se borraba solo: cada acción recarga el
  // detalle y la recarga lo limpiaba. Ahora solo se limpia al cambiar de guía.
  const [feedback, setFeedback] = useState<{ kind: "error" | "notice"; text: string } | null>(null);
  const [pending, start] = useTransition();
  const [claimState, setClaimState] = useState<"claiming" | "mine" | "blocked">("claiming");
  const [claimMessage, setClaimMessage] = useState<string | null>(null);
  const claimSessionRef = useRef<{
    shipmentId: string;
    shouldRelease: boolean;
  } | null>(null);
  // Semántica de diálogo: el foco entra al abrir, Escape cierra y el foco
  // vuelve a donde estaba (la fila) al cerrar. Sin esto, con teclado el panel
  // se abría detrás del foco y no había forma de salir.
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<() => void>(() => undefined);

  // form state
  const [disposition, setDisposition] = useState<RerouteDisposition>("confirma");
  const [note, setNote] = useState("");
  const [nextDate, setNextDate] = useState("");
  const [courierResult, setCourierResult] = useState<CourierReportResult | "">("");
  const [courierDate, setCourierDate] = useState("");
  const [courierNote, setCourierNote] = useState("");
  const [showCourierCorrection, setShowCourierCorrection] = useState(false);
  const [fenixGuide, setFenixGuide] = useState("");
  const [showOrderPicker, setShowOrderPicker] = useState(false);
  const [showAddressEditor, setShowAddressEditor] = useState(false);
  const [address, setAddress] = useState("");
  const [addressReference, setAddressReference] = useState("");
  const [addressDistrict, setAddressDistrict] = useState("");
  const [addressCity, setAddressCity] = useState("");
  const [addressRegion, setAddressRegion] = useState("");
  const [addressLatitude, setAddressLatitude] = useState("");
  const [addressLongitude, setAddressLongitude] = useState("");
  const [reprogramProvider, setReprogramProvider] = useState<"aliclik" | "fenix">("fenix");
  const [forceAliclik, setForceAliclik] = useState(false);
  const [showCancelledException, setShowCancelledException] = useState(false);
  const [cancelledExceptionDate, setCancelledExceptionDate] = useState("");
  const [cancelledExceptionNote, setCancelledExceptionNote] = useState("");
  // Llamadas sobre la guía anulada cuando el PEDIDO sigue en recuperación.
  const [recoveryDisposition, setRecoveryDisposition] = useState<RecoveryCallDisposition>("programar");
  const [recoveryDate, setRecoveryDate] = useState("");
  const [recoveryNote, setRecoveryNote] = useState("");

  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let active = true;
    let heartbeat: ReturnType<typeof setInterval> | null = null;
    const session = { shipmentId, shouldRelease: false };
    claimSessionRef.current = session;
    setClaimState("claiming");
    setClaimMessage(null);

    // Si la pestaña se cierra o se recarga con el panel abierto, el cierre
    // normal nunca corre y la reserva bloqueaba a los demás hasta agotar el TTL
    // (10 minutos). `sendBeacon` sobrevive a la descarga de la página; una
    // acción de servidor, no.
    const onPageHide = () => {
      if (session.shouldRelease) return;
      session.shouldRelease = true;
      navigator.sendBeacon?.(
        "/api/envios/release-claim",
        new Blob([JSON.stringify({ shipmentId })], { type: "application/json" }),
      );
    };

    void claimShipment(shipmentId)
      .then((result) => {
        if (session.shouldRelease) {
          if (!result.error) void releaseShipment(shipmentId).catch(() => undefined);
          return;
        }
        if (!active) return;
        if (result.error) {
          setClaimState("blocked");
          setClaimMessage(result.error);
          return;
        }

        setClaimState("mine");
        window.addEventListener("pagehide", onPageHide);
        heartbeat = setInterval(() => {
          void renewShipmentClaim(shipmentId)
            .then((renewal) => {
              if (!active || session.shouldRelease || !renewal.error) return;
              setClaimState("blocked");
              setClaimMessage(renewal.error);
              if (heartbeat) clearInterval(heartbeat);
              heartbeat = null;
            })
            .catch(() => {
              if (!active || session.shouldRelease) return;
              setClaimState("blocked");
              setClaimMessage("No pudimos renovar la reserva. Cierra y vuelve a abrir este envío.");
              if (heartbeat) clearInterval(heartbeat);
              heartbeat = null;
            });
        }, SHIPMENT_CLAIM_HEARTBEAT_MS);
      })
      .catch(() => {
        if (!active || session.shouldRelease) return;
        setClaimState("blocked");
        setClaimMessage("No pudimos reservar este envío. Cierra y vuelve a intentarlo.");
      });

    return () => {
      active = false;
      window.removeEventListener("pagehide", onPageHide);
      if (heartbeat) clearInterval(heartbeat);
    };
  }, [shipmentId]);

  // La respuesta de una acción pertenece a la guía en la que se hizo.
  useEffect(() => {
    setFeedback(null);
  }, [shipmentId]);

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panelRef.current?.focus();
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      e.preventDefault();
      closeRef.current();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      opener?.focus();
    };
  }, []);

  useEffect(() => {
    let alive = true;
    setDetail(null);
    setShowAddressEditor(false);
    loadShipmentDetail(shipmentId)
      .catch(() => ({
        error: "No pudimos cargar este envío. Revisa la conexión e inténtalo de nuevo.",
      }))
      .then((d) => {
      if (!alive) return;
      setDetail(d);
      if (d && !("error" in d)) {
        setCourierResult("");
        setCourierDate("");
        setCourierNote("");
        setShowCourierCorrection(false);
        setShowCancelledException(false);
        setCancelledExceptionDate("");
        setCancelledExceptionNote("");
        const decision = evaluateAliclikReschedule({
          courier: d.shipment.courier,
          attempts: d.shipment.aliclik_attempts,
          serviceDate: d.shipment.aliclik_service_date,
        });
        setReprogramProvider(decision.eligible ? "aliclik" : "fenix");
        setForceAliclik(false);
        const shopifyAddress = d.order?.shipping_address;
        setAddress(d.shipment.delivery_address ?? shopifyAddress?.address1 ?? "");
        setAddressReference(d.shipment.delivery_reference ?? shopifyAddress?.address2 ?? "");
        setAddressDistrict(d.shipment.district ?? shopifyAddress?.city ?? "");
        setAddressCity(d.shipment.province ?? d.shipment.city ?? shopifyAddress?.city ?? "");
        setAddressRegion(d.shipment.region ?? shopifyAddress?.province ?? "");
        setAddressLatitude(d.shipment.latitude == null ? "" : String(d.shipment.latitude));
        setAddressLongitude(d.shipment.longitude == null ? "" : String(d.shipment.longitude));
      }
    });
    return () => {
      alive = false;
    };
  }, [shipmentId, reloadKey]);

  function refresh() {
    setDetail(null);
    setReloadKey((k) => k + 1);
  }

  function releaseCurrentClaim() {
    const session = claimSessionRef.current;
    if (!session) return;
    session.shouldRelease = true;
    void releaseShipment(session.shipmentId).catch(() => undefined);
  }

  function handleClose() {
    releaseCurrentClaim();
    onClose();
  }
  closeRef.current = handleClose;

  function handleOpenShipment(id: string) {
    releaseCurrentClaim();
    onOpenShipment(id);
  }

  function run(
    fn: () => Promise<{ error?: string; notice?: string }>,
    onSuccess?: () => void | Promise<void>,
  ) {
    start(async () => {
      let r: { error?: string; notice?: string };
      try {
        r = await fn();
      } catch {
        // Una acción de servidor que no llega (red caída, sesión vencida) lanza
        // en vez de devolver `{ error }`. Sin esto el botón volvía a su estado
        // normal y no pasaba nada: el peor error es el que no se ve.
        r = { error: "No se pudo completar la acción. Revisa la conexión e inténtalo de nuevo." };
      }
      if (r.error) {
        setFeedback({ kind: "error", text: r.error });
        return;
      }
      setFeedback(r.notice ? { kind: "notice", text: r.notice } : null);
      await onSuccess?.();
      await onShipmentUpdated(shipmentId);
      refresh();
    });
  }

  const programDateInvalid =
    disposition === "programar" && (!nextDate || nextDate <= localDateInputValue());
  const shipment = detail && !("error" in detail) ? detail.shipment : null;
  const fenixReason = shipment ? currentFenixReason(shipment) : null;
  const fenixDeliverySchedule = shipment
    ? getFenixDeliverySchedule(shipment.city, shipment.district)
    : null;
  // 6 Novedad y 8 Revisión: los dos estados en los que Swayp todavía acepta una
  // instrucción. Sin guía de Swayp no hay nada que responder — una guía manual
  // se gestiona por teléfono, como siempre.
  const swaypNovelty = Boolean(
    shipment?.swayp_guide && (shipment.swayp_state === 6 || shipment.swayp_state === 8),
  );
  const shopifyAddress = detail && !("error" in detail) ? detail.order?.shipping_address ?? null : null;
  const deliveryAddress = shipment?.delivery_address ?? shopifyAddress?.address1 ?? null;
  const deliveryReference = shipment?.delivery_reference ?? shopifyAddress?.address2 ?? null;
  const deliveryLocality = !shipment?.delivery_address
    ? [shopifyAddress?.city, shopifyAddress?.province].filter(Boolean).join(" · ") || null
    : null;
  // El Excel del courier manda sobre city/district, pero a dónde va el paquete lo
  // decide la dirección de Shopify. Cuando se contradicen (courier "cusco" vs
  // Shopify "Juliaca · Puno") el envío sale a la ciudad equivocada y la cobertura
  // Fenix se evalúa con el dato malo — antes solo se cazaba a ojo. Si ya se
  // corrigió a mano (address_override) no hay nada que avisar.
  const localityConflict =
    !!shipment &&
    !shipment.address_override &&
    localityMismatch(shipment.city, shopifyAddress?.city, shopifyAddress?.province);
  const deliverySource = shipment?.address_override
    ? "Modificado en Kapta · protegido frente al siguiente Excel"
    : shipment?.delivery_address
      ? "Importado desde Aliclik"
      : shopifyAddress?.address1
        ? "Obtenido de Shopify"
        : "Sin dirección disponible";
  const aliclikDecision = shipment
    ? evaluateAliclikReschedule({
        courier: shipment.courier,
        attempts: shipment.aliclik_attempts,
        serviceDate: shipment.aliclik_service_date,
      })
    : null;
  const overrideNoteMissing =
    disposition === "confirma" && reprogramProvider === "aliclik" && forceAliclik && !note.trim();
  const fenixAutoUnavailable =
    disposition === "confirma" &&
    reprogramProvider === "fenix" &&
    shipment?.courier === "aliclik" &&
    !shipment.fenix_eligible;
  const fenixRouteAvailable =
    !!shipment && (shipment.courier !== "aliclik" || shipment.fenix_eligible);
  const requiredDateMissing =
    (disposition === "confirma" && !nextDate) ||
    programDateInvalid ||
    overrideNoteMissing ||
    fenixAutoUnavailable;
  const parsedLatitude = Number(addressLatitude.replace(",", "."));
  const parsedLongitude = Number(addressLongitude.replace(",", "."));
  const addressFormValid =
    !!address.trim() &&
    !!addressDistrict.trim() &&
    !!addressCity.trim() &&
    !!addressRegion.trim() &&
    addressLatitude.trim() !== "" &&
    addressLongitude.trim() !== "" &&
    Number.isFinite(parsedLatitude) &&
    parsedLatitude >= -90 &&
    parsedLatitude <= 90 &&
    Number.isFinite(parsedLongitude) &&
    parsedLongitude >= -180 &&
    parsedLongitude <= 180;
  const courierResultDefinition = courierResult
    ? COURIER_REPORT_RESULTS.find((item) => item.code === courierResult) ?? null
    : null;
  const courierFormValid =
    !!courierResultDefinition &&
    (!courierResultDefinition.requiresDate || !!courierDate) &&
    (!courierResultDefinition.requiresNote || !!courierNote.trim());
  const reopensClosedGuide =
    !!courierResultDefinition &&
    (shipment?.delivery_status === "anulado" || shipment?.delivery_status === "entregado") &&
    courierResultDefinition.resultingStatus !== "anulado" &&
    courierResultDefinition.resultingStatus !== "entregado";
  const fenixAwaitingCourierResult =
    shipmentRequiresCourierResult(shipment?.courier, shipment?.delivery_status);
  // La segunda mitad del badge decide qué se ofrece: solo «activa» admite
  // llamadas y reenvío como acción normal. La puerta de verdad está en el
  // servidor, con la misma función que puso esa mitad.
  const enRecuperacion = shipment?.delivery_status === "anulado" && shipment.recovery === "activa";
  const fenixReadyForCustomerManagement =
    shipment?.courier === "fenix" && shipment.delivery_status === "pendiente";
  // Una sola resolución para todo el cajón: los dos botones que autogeneran una
  // guía Fenix leían `shipment.order_name` por su cuenta, y arreglar uno solo
  // habría dejado el otro deshabilitado sobre el mismo envío.
  const drawerOrderName = effectiveOrderName(
    shipment?.order_name,
    detail && !("error" in detail) ? detail.order?.name : null,
  );
  const cancelledExceptionGuide = shipment
    ? rescheduleGuideCode(
        drawerOrderName,
        cancelledExceptionDate ? new Date(cancelledExceptionDate).toISOString() : null,
      )
    : "";
  const cancelledExceptionDateInvalid =
    !cancelledExceptionDate || cancelledExceptionDate <= localDateInputValue();
  const cancelledExceptionUnavailable = fenixReason !== "ok";
  const cancelledExceptionReady =
    !!cancelledExceptionGuide &&
    !cancelledExceptionDateInvalid &&
    !!cancelledExceptionNote.trim() &&
    !cancelledExceptionUnavailable;

  return (
    <div className="fixed inset-0 z-20 flex justify-end bg-slate-900/30" onClick={handleClose}>
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="shipment-drawer-title"
        tabIndex={-1}
        className="h-full w-full max-w-[34rem] overflow-y-auto bg-white p-3.5 pb-[max(1rem,env(safe-area-inset-bottom))] shadow-xl outline-none sm:p-4 sm:pb-[max(1rem,env(safe-area-inset-bottom))]"
        onClick={(e) => e.stopPropagation()}
      >
        {detail && "error" in detail ? (
          <div role="alert" className="space-y-2.5">
            <p className="break-words text-sm text-rose-700">{detail.error}</p>
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={refresh}
                className="rounded-lg bg-brand-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-brand-700"
              >
                Reintentar
              </button>
              <button type="button" onClick={handleClose} className="text-xs text-slate-500 hover:underline">
                Cerrar
              </button>
            </div>
          </div>
        ) : !detail ? (
          <p className="text-sm text-slate-500">Cargando…</p>
        ) : (
          <div className="space-y-2.5">
            {/* La cabecera queda fija: en teléfono el cajón es la pantalla entera
                y «Cerrar» no puede irse con el scroll. */}
            <div className="sticky top-0 z-10 -mx-3.5 -mt-3.5 flex items-start justify-between gap-3 border-b border-slate-100 bg-white px-3.5 pb-2.5 pt-3.5 sm:-mx-4 sm:-mt-4 sm:px-4 sm:pt-4">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 id="shipment-drawer-title" className="font-mono text-base font-semibold text-slate-900">
                    {detail.shipment.guide_code}
                  </h2>
                  {detail.shipment.created_via === "fenix_directo" && (
                    <span
                      className="rounded bg-indigo-50 px-1.5 py-0.5 text-xs font-medium text-indigo-700"
                      title="Guía Fenix directa: creada desde el pedido, sin guía Aliclik previa"
                    >
                      Directa
                    </span>
                  )}
                  <StatusBadge
                    category={detail.shipment.status_category}
                    status={detail.shipment.delivery_status}
                    suffix={subState(detail.shipment)}
                  />
                </div>
                {/* Since when it's in this status (e.g. the day it went "En ruta"),
                    derived from the transition in its history. */}
                {(() => {
                  const since = fmtStatusSince(
                    statusSince(detail.calls, detail.shipment.delivery_status),
                  );
                  return since ? <p className="mt-0.5 text-xs text-slate-500">Desde {since}</p> : null;
                })()}
              </div>
              <button onClick={handleClose} className="text-sm text-slate-500 hover:text-slate-700">
                Cerrar
              </button>
            </div>

            <div
              role="status"
              className={cn(
                "flex items-start gap-2 rounded-lg border px-2.5 py-2 text-xs",
                claimState === "mine"
                  ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                  : claimState === "blocked"
                    ? "border-amber-200 bg-amber-50 text-amber-900"
                    : "border-slate-200 bg-slate-50 text-slate-600",
              )}
            >
              <span
                className={cn(
                  "mt-1 h-2 w-2 shrink-0 rounded-full",
                  claimState === "mine"
                    ? "bg-emerald-500"
                    : claimState === "blocked"
                      ? "bg-amber-500"
                      : "animate-pulse bg-slate-400 motion-reduce:animate-none",
                )}
              />
              <span>
                {claimState === "mine" ? (
                  <><b>Reservado para ti.</b> Se liberará automáticamente al cerrar este panel.</>
                ) : claimState === "blocked" ? (
                  <><b>{claimMessage ?? "Otro asesor está atendiendo este envío."}</b> Puedes consultar la información, pero no modificarla.</>
                ) : (
                  "Reservando este envío…"
                )}
              </span>
            </div>

            <fieldset disabled={claimState !== "mine"} className="contents">

            <section className="overflow-hidden rounded-xl border border-slate-200 bg-white">
              <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 px-3 py-2.5 text-sm">
                <Field label="Cliente" value={detail.shipment.customer_name} />
                <Field label="Teléfono" value={detail.shipment.customer_phone} />
                <Field label="Ciudad" value={detail.shipment.city} />
                <Field label="Distrito" value={detail.shipment.district} />
                {localityConflict && (
                  <p className="col-span-2 rounded-lg border border-amber-300 bg-amber-50 px-2.5 py-2 text-xs leading-snug text-amber-900">
                    <span className="font-semibold">Revisa el destino antes de despachar.</span> El
                    courier dice <span className="font-semibold">{detail.shipment.city}</span>, pero la
                    dirección de Shopify es{" "}
                    <span className="font-semibold">
                      {[shopifyAddress?.city, shopifyAddress?.province].filter(Boolean).join(" · ")}
                    </span>
                    . Corrígelo con “Modificar destino” para que quede fijo.
                  </p>
                )}
                <div className="col-span-2 border-t border-slate-100 pt-1.5">
                  <Field label="Producto declarado" value={detail.shipment.product} />
                </div>
              </dl>
              <dl className="grid grid-cols-2 border-t border-slate-100 bg-slate-50 sm:grid-cols-4">
                <CompactMetric
                  label="Intentos Aliclik"
                  value={
                    detail.shipment.aliclik_attempts == null
                      ? "Sin dato"
                      : `${detail.shipment.aliclik_attempts} / 3`
                  }
                />
                <CompactMetric label="Fecha Aliclik" value={fmtAliclikDate(detail.shipment.aliclik_service_date)} />
                <CompactMetric label="Llamadas" value={`${detail.shipment.reroute_attempts} / 7`} />
                <CompactMetric
                  label="Fenix"
                  value={
                    fenixReason === "ok"
                      ? "Fenix ok"
                      : fenixReason === "sin_stock"
                        ? "Sin stock"
                        : "Fuera de cobertura"
                  }
                  tone={fenixReason === "ok" ? "positive" : fenixReason === "sin_stock" ? "warning" : "negative"}
                />
              </dl>
              {fenixDeliverySchedule && (
                <div className="flex items-center gap-1.5 border-t border-slate-100 bg-slate-50 px-3 py-1.5 text-xs text-slate-700">
                  <span>
                    <strong>Horario Fenix: {fenixDeliverySchedule.hours}</strong>
                    {fenixDeliverySchedule.note && (
                      <span className="text-slate-500"> · {fenixDeliverySchedule.note}</span>
                    )}
                  </span>
                </div>
              )}
              {swaypNovelty && (
                // El estado crudo de Swayp es lo único que distingue «el
                // mensajero está esperando una instrucción» de «todavía no
                // salió»: los dos caen en `pendiente` al mapearse.
                <div className="flex flex-wrap items-center justify-between gap-2 border-t border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-950">
                  <span>
                    <strong>
                      {detail.shipment.swayp_state === 8
                        ? "Swayp marcó devolución"
                        : "Swayp reportó una novedad"}
                    </strong>
                    <span className="text-rose-800">
                      {" "}
                      · el mensajero espera una instrucción
                    </span>
                  </span>
                  {detail.can.solveNovelty && (
                    <button
                      onClick={() => setNoveltyOpen(true)}
                      className="rounded-lg bg-rose-700 px-2.5 py-1 font-medium text-white"
                    >
                      Resolver novedad
                    </button>
                  )}
                </div>
              )}
            </section>

            <section className="overflow-hidden rounded-xl border border-slate-200 bg-white">
              <div className="space-y-2 p-3">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <h3 className="text-sm font-semibold text-slate-900">Destino de entrega</h3>
                    {detail.shipment.address_override && (
                      <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-xs font-medium text-slate-600">
                        Modificado
                      </span>
                    )}
                    <span className="text-xs text-slate-500">
                      · {deliverySource}
                    </span>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setShowAddressEditor((value) => !value)}
                  className="shrink-0 text-xs font-semibold text-brand-700 hover:text-brand-800 hover:underline"
                >
                  {showAddressEditor ? "Cerrar edición" : "Modificar destino"}
                </button>
              </div>

              {!showAddressEditor ? (
                <div className="space-y-2">
                  <div>
                    <p className="text-xs text-slate-500">Dirección completa</p>
                    <p className="text-sm leading-snug text-slate-800">
                      {deliveryAddress ?? "No informada en Aliclik ni Shopify."}
                    </p>
                    {deliveryLocality && (
                      <p className="mt-0.5 text-xs font-medium text-slate-600">{deliveryLocality}</p>
                    )}
                    {deliveryReference && (
                      <p className="mt-0.5 text-xs text-slate-500">
                        Ref.: {deliveryReference}
                      </p>
                    )}
                  </div>
                  <div className="grid grid-cols-2 gap-3 border-t border-slate-200 pt-2">
                    <div>
                      <p className="text-xs uppercase tracking-[0.12em] text-slate-500">Latitud</p>
                      <p className="select-all font-mono text-xs text-slate-700">
                        {detail.shipment.latitude ?? "—"}
                      </p>
                    </div>
                    <div>
                      <p className="text-xs uppercase tracking-[0.12em] text-slate-500">Longitud</p>
                      <p className="select-all font-mono text-xs text-slate-700">
                        {detail.shipment.longitude ?? "—"}
                      </p>
                    </div>
                  </div>
                  {detail.shipment.latitude != null && detail.shipment.longitude != null && (
                    <a
                      href={`https://www.google.com/maps?q=${detail.shipment.latitude},${detail.shipment.longitude}`}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex text-xs font-medium text-brand-700 hover:underline"
                    >
                      Abrir ubicación en Google Maps ↗
                    </a>
                  )}
                </div>
              ) : (
                <div className="space-y-2 border-t border-slate-200 pt-2">
                  <label className="block text-xs font-medium text-slate-600">
                    Dirección completa
                    <textarea
                      value={address}
                      onChange={(e) => setAddress(e.target.value)}
                      rows={2}
                      placeholder="Calle, número, urbanización…"
                      className="mt-0.5 w-full rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-sm text-slate-800"
                    />
                  </label>
                  <label className="block text-xs font-medium text-slate-600">
                    Referencia
                    <input
                      value={addressReference}
                      onChange={(e) => setAddressReference(e.target.value)}
                      placeholder="Frente a…, puerta color…"
                      className="mt-0.5 w-full rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-sm text-slate-800"
                    />
                  </label>
                  <div className="grid grid-cols-2 gap-2">
                    <label className="block text-xs font-medium text-slate-600">
                      Distrito
                      <input
                        value={addressDistrict}
                        onChange={(e) => setAddressDistrict(e.target.value)}
                        className="mt-0.5 w-full rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-sm"
                      />
                    </label>
                    <label className="block text-xs font-medium text-slate-600">
                      Ciudad / provincia
                      <input
                        value={addressCity}
                        onChange={(e) => setAddressCity(e.target.value)}
                        className="mt-0.5 w-full rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-sm"
                      />
                    </label>
                  </div>
                  <label className="block text-xs font-medium text-slate-600">
                    Departamento
                    <input
                      value={addressRegion}
                      onChange={(e) => setAddressRegion(e.target.value)}
                      className="mt-0.5 w-full rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-sm"
                    />
                  </label>
                  <div className="grid grid-cols-2 gap-2">
                    <label className="block text-xs font-medium text-slate-600">
                      Latitud
                      <input
                        value={addressLatitude}
                        onChange={(e) => setAddressLatitude(e.target.value)}
                        inputMode="decimal"
                        placeholder="-16.409…"
                        className="mt-0.5 w-full rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 font-mono text-xs"
                      />
                    </label>
                    <label className="block text-xs font-medium text-slate-600">
                      Longitud
                      <input
                        value={addressLongitude}
                        onChange={(e) => setAddressLongitude(e.target.value)}
                        inputMode="decimal"
                        placeholder="-71.556…"
                        className="mt-0.5 w-full rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 font-mono text-xs"
                      />
                    </label>
                  </div>
                  <p className="rounded-lg bg-slate-50 px-2 py-1.5 text-xs leading-relaxed text-slate-600">
                    Al guardar se actualizará el pedido de Shopify y esta dirección no será reemplazada por futuros Excel.
                  </p>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => setShowAddressEditor(false)}
                      className="flex-1 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-50"
                    >
                      Cancelar
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        const payload: ShipmentAddressInput = {
                          address,
                          reference: addressReference,
                          district: addressDistrict,
                          city: addressCity,
                          region: addressRegion,
                          latitude: parsedLatitude,
                          longitude: parsedLongitude,
                        };
                        run(
                          () => updateShipmentDeliveryAddress(shipmentId, payload),
                          () => setShowAddressEditor(false),
                        );
                      }}
                      disabled={pending || !addressFormValid}
                      className="flex-1 rounded-lg bg-brand-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-brand-700 disabled:opacity-50"
                    >
                      {pending ? "Guardando…" : "Guardar nuevo destino"}
                    </button>
                  </div>
                </div>
              )}
              </div>

            {/* order link — search+link (not just a raw UUID) for any shipment,
                so a wrong auto-match can also be corrected here */}
              <div className="space-y-1.5 border-t border-slate-100 bg-slate-50 p-3">
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm font-medium text-slate-900">
                  <span className="text-xs font-normal text-slate-500">Pedido </span>
                  <OrderNameLabel name={detail.shipment.order_name} matched={detail.shipment.matched} />
                </p>
                {detail.shipment.matched && (
                  <button
                    onClick={() => setShowOrderPicker((v) => !v)}
                    className="shrink-0 text-xs font-semibold text-brand-700 hover:text-brand-800 hover:underline"
                  >
                    {showOrderPicker ? "Cancelar" : "Cambiar"}
                  </button>
                )}
              </div>
              {(!detail.shipment.matched || showOrderPicker) && (
                <OrderLinkPicker
                  shipmentId={shipmentId}
                  prefill={detail.shipment.order_name}
                  customerPhone={detail.shipment.customer_phone}
                  onLinked={() => {
                    setShowOrderPicker(false);
                    refresh();
                  }}
                />
              )}
              {detail.shipment.matched && !showOrderPicker &&
                (detail.order ? (
                  <ShipmentOrderItems order={detail.order} />
                ) : (
                  <p className="border-t border-slate-100 pt-2 text-xs text-slate-500">
                    No se encontró el detalle sincronizado de Shopify.
                  </p>
                ))}
              </div>
            </section>

            {feedback && (
              <p
                role={feedback.kind === "error" ? "alert" : "status"}
                className={cn(
                  "break-words rounded-lg border px-2.5 py-1.5 text-sm",
                  feedback.kind === "error"
                    ? "border-rose-200 bg-rose-50 text-rose-800"
                    : "border-emerald-200 bg-emerald-50 text-emerald-800",
                )}
              >
                {feedback.text}
              </p>
            )}

            {detail.shipment.delivery_status === "anulado" && (
              <section className="space-y-2.5 rounded-xl border border-rose-200 bg-white p-3">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    {/* En recuperación, reenviar es la acción NORMAL (MOM §11), no
                        una excepción: la guía sí terminó, el pedido no. El flujo
                        de abajo es el mismo; cambia lo que se le dice a quien llama. */}
                    <p className="text-xs font-semibold uppercase tracking-[0.12em] text-rose-700">
                      {enRecuperacion ? "Reproprovincia" : "Excepción auditada"}
                    </p>
                    <h3 className="mt-0.5 text-sm font-semibold text-slate-900">
                      {enRecuperacion ? "Reenviar por Fenix / Swayp" : "Reprogramar un pedido anulado"}
                    </h3>
                  </div>
                  {!showCancelledException && (
                    <button
                      type="button"
                      onClick={() => setShowCancelledException(true)}
                      className="shrink-0 rounded-lg border border-rose-300 bg-white px-2.5 py-1.5 text-xs font-semibold text-rose-700 hover:bg-rose-100"
                    >
                      {enRecuperacion ? "Reenviar" : "Crear excepción"}
                    </button>
                  )}
                </div>
                <p className="text-xs leading-relaxed text-slate-600">
                  {enRecuperacion
                    ? "La guía Aliclik ya terminó y no se toca: queda como madre transferida y se crea una guía Fenix con la fecha acordada con la clienta."
                    : "No se borrará la anulación. Esta guía quedará como madre transferida y se creará una nueva guía Fenix con la fecha acordada."}
                </p>

                {showCancelledException && (
                  <div className="space-y-2 rounded-lg border border-slate-200 bg-white p-2.5">
                    <label className="block text-xs font-medium text-slate-600">
                      Nueva fecha de entrega
                      <input
                        type="date"
                        value={cancelledExceptionDate}
                        min={tomorrowDateInputValue()}
                        onChange={(e) => setCancelledExceptionDate(e.target.value)}
                        className="mt-1 w-full rounded-lg border border-slate-200 px-2.5 py-2 text-sm"
                      />
                    </label>
                    <label className="block text-xs font-medium text-slate-600">
                      {enRecuperacion ? "Nota de la llamada" : "Motivo de la excepción"}
                      <textarea
                        value={cancelledExceptionNote}
                        onChange={(e) => setCancelledExceptionNote(e.target.value)}
                        rows={2}
                        placeholder="Ej.: cliente confirmó hoy entrega para el lunes con Marianny…"
                        className="mt-1 w-full rounded-lg border border-slate-200 px-2.5 py-2 text-sm"
                      />
                    </label>

                    {cancelledExceptionGuide ? (
                      <p className="rounded-md bg-slate-50 px-2 py-1.5 text-xs text-slate-600">
                        Nueva guía: <b className="font-mono text-slate-800">{cancelledExceptionGuide}</b>
                      </p>
                    ) : (
                      <p className="rounded-md bg-amber-50 px-2 py-1.5 text-xs text-amber-800">
                        Falta vincular un N° de pedido para autogenerar la guía Fenix.
                      </p>
                    )}

                    {cancelledExceptionUnavailable && (
                      <p className="rounded-md bg-amber-50 px-2 py-1.5 text-xs text-amber-800">
                        {fenixReason === "sin_stock"
                          ? `Fenix no tiene stock para este pedido en ${detail.shipment.city ?? "la ciudad indicada"}.`
                          : `Fenix no tiene cobertura en ${detail.shipment.city ?? "la ciudad indicada"}.`}
                      </p>
                    )}

                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={() => {
                          setShowCancelledException(false);
                          setCancelledExceptionDate("");
                          setCancelledExceptionNote("");
                        }}
                        className="rounded-lg border border-slate-200 px-3 py-2 text-xs text-slate-600 hover:bg-slate-50"
                      >
                        Cancelar
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          run(
                            () => reprogramCancelledShipmentException(shipmentId, {
                              nextFollowupAt: new Date(cancelledExceptionDate).toISOString(),
                              note: cancelledExceptionNote,
                            }),
                            () => {
                              setShowCancelledException(false);
                              setCancelledExceptionDate("");
                              setCancelledExceptionNote("");
                            },
                          )
                        }
                        disabled={pending || !cancelledExceptionReady}
                        className="flex-1 rounded-lg bg-rose-600 px-3 py-2 text-sm font-semibold text-white hover:bg-rose-700 disabled:opacity-50"
                      >
                        {pending ? "Creando…" : "Crear nueva guía Fenix"}
                      </button>
                    </div>
                  </div>
                )}
              </section>
            )}

            {/* Llamadas sobre la guía anulada mientras el PEDIDO sigue en
                recuperación. La guía no admite gestión —está cerrada de verdad—,
                así que esto no pasa por `registerRerouteCall` ni la mueve: anota
                lo que pasó con la clienta y, si no quiere, cierra la recuperación
                con motivo. Es lo que faltaba: 0 llamadas sobre 920 pedidos. */}
            {enRecuperacion && (
              <section className="space-y-1.5 rounded-xl border border-slate-200 bg-white p-2.5">
                <h3 className="text-sm font-semibold text-slate-900">Registrar o programar llamada</h3>
                <p className="text-xs leading-relaxed text-slate-500">
                  Sobre el pedido, no sobre la guía: sigue «Anulado · Reproprovincia» hasta que se reenvíe, se descarte o venza la ventana.
                </p>
                <label className="block text-xs font-medium text-slate-600">
                  Resultado de la llamada
                  <select
                    value={recoveryDisposition}
                    onChange={(e) => setRecoveryDisposition(e.target.value as RecoveryCallDisposition)}
                    className="mt-0.5 w-full rounded-lg border border-slate-200 px-2.5 py-1.5 text-sm text-slate-800"
                  >
                    {RECOVERY_CALL_DISPOSITIONS.map((d) => (
                      <option key={d.key} value={d.key}>
                        {d.label}
                      </option>
                    ))}
                  </select>
                </label>
                {recoveryDisposition === "no_quiere" && (
                  <p className="rounded-lg bg-rose-50 px-2.5 py-1.5 text-xs text-rose-800">
                    El pedido pasa a cierre con el motivo escrito y la guía sale de la cola. No se toca la guía de Aliclik ni el inventario.
                  </p>
                )}
                {recoveryDisposition !== "no_quiere" && (
                  <label className="block text-xs font-medium text-slate-600">
                    {recoveryDisposition === "programar" ? "Fecha de próxima llamada" : "Próximo intento (opcional)"}
                    <input
                      type="date"
                      value={recoveryDate}
                      onChange={(e) => setRecoveryDate(e.target.value)}
                      min={tomorrowDateInputValue()}
                      className="mt-0.5 w-full rounded-lg border border-slate-200 px-2.5 py-1.5 text-sm text-slate-800"
                    />
                  </label>
                )}
                <label className="block text-xs font-medium text-slate-600">
                  {recoveryDisposition === "no_quiere" ? "Motivo (obligatorio)" : "Nota de la llamada"}
                  <textarea
                    value={recoveryNote}
                    onChange={(e) => setRecoveryNote(e.target.value)}
                    placeholder={
                      recoveryDisposition === "no_quiere"
                        ? "P. ej. la clienta ya no quiere el producto"
                        : "Qué dijo la clienta…"
                    }
                    className="mt-0.5 w-full rounded-lg border border-slate-200 px-2.5 py-1.5 text-sm text-slate-800"
                    rows={2}
                  />
                </label>
                <button
                  onClick={() =>
                    run(
                      () =>
                        registerRecoveryCall(shipmentId, {
                          disposition: recoveryDisposition,
                          note: recoveryNote,
                          nextFollowupAt: recoveryDate ? new Date(recoveryDate).toISOString() : null,
                        }),
                      () => {
                        setRecoveryNote("");
                        setRecoveryDate("");
                      },
                    )
                  }
                  disabled={
                    pending ||
                    (recoveryDisposition === "programar" && !recoveryDate) ||
                    (recoveryDisposition === "no_quiere" && recoveryNote.trim().length < 8)
                  }
                  className={cn(
                    "w-full rounded-lg px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50",
                    recoveryDisposition === "no_quiere"
                      ? "bg-rose-600 hover:bg-rose-700"
                      : "bg-brand-600 hover:bg-brand-700",
                  )}
                >
                  {pending
                    ? "Registrando…"
                    : recoveryDisposition === "no_quiere"
                      ? "Descartar la recuperación"
                      : "Registrar"}
                </button>
              </section>
            )}

            {/* Step 1 for active Fenix deliveries: process the courier outcome
                before any customer call or reprogramming can be registered. */}
            {detail.shipment.courier === "fenix" && detail.shipment.delivery_status !== "anulado" && (
              detail.shipment.delivery_status === "transferido" ? (
                <section className="space-y-2 rounded-xl border border-slate-200 bg-slate-50 p-3">
                  <p className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-500">Guía reemplazada</p>
                  <h3 className="text-sm font-semibold text-slate-900">Continúa en la guía Fenix activa</h3>
                  <p className="text-xs leading-relaxed text-slate-600">
                    “Transferido” lo asigna Kapta automáticamente; no es un resultado del motorizado.
                  </p>
                  {detail.linkedFenixShipment && (
                    <button
                      type="button"
                      onClick={() => handleOpenShipment(detail.linkedFenixShipment!.id)}
                      className="flex w-full items-center justify-between rounded-lg border border-slate-200 bg-white px-3 py-2 text-left hover:bg-slate-50"
                    >
                      <span>
                        <span className="block text-xs uppercase tracking-[0.12em] text-slate-500">Abrir guía activa</span>
                        <span className="font-mono text-xs font-semibold text-slate-800">
                          {detail.linkedFenixShipment.guide_code}
                        </span>
                      </span>
                      <IconArrowRight className="text-slate-500" />
                    </button>
                  )}
                </section>
              ) : fenixReadyForCustomerManagement && !showCourierCorrection ? (
                <section className="flex items-start justify-between gap-3 rounded-xl border border-emerald-200 bg-emerald-50 p-3">
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-[0.12em] text-emerald-700">Etapa 1 completada</p>
                    <p className="mt-0.5 text-sm font-semibold text-emerald-900">Pendiente de gestión con el cliente</p>
                    <p className="mt-0.5 text-xs leading-relaxed text-emerald-800">
                      Continúa abajo con la llamada. Si confirma, recién se generará la nueva reprogramación.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setShowCourierCorrection(true)}
                    className="shrink-0 text-xs font-medium text-emerald-800 hover:underline"
                  >
                    Corregir resultado
                  </button>
                </section>
              ) : (
                <section className="space-y-2.5 rounded-xl border border-slate-200 bg-white p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-[0.12em] text-orange-700">
                        {fenixAwaitingCourierResult ? "Etapa 1 · obligatoria" : "Corrección del reporte"}
                      </p>
                      <h3 className="mt-0.5 text-sm font-semibold text-slate-900">Registrar resultado del courier</h3>
                      <p className="mt-0.5 font-mono text-xs font-semibold text-slate-800">
                        {detail.shipment.guide_code}
                      </p>
                    </div>
                    <div className="text-right">
                      <p className="text-xs uppercase tracking-[0.12em] text-slate-500">Estado actual</p>
                      <StatusBadge
                        category={detail.shipment.status_category}
                        status={detail.shipment.delivery_status}
                      />
                    </div>
                  </div>

                  {fenixAwaitingCourierResult && (
                    <p className="rounded-lg bg-slate-50 px-2.5 py-2 text-xs leading-relaxed text-slate-600">
                      Esta guía está En ruta. Primero registra lo informado por el motorizado; la llamada y la reprogramación se habilitarán solo si vuelve a Pendiente.
                    </p>
                  )}

                  <label className="block text-xs font-medium text-slate-600">
                    ¿Qué informó Fenix?
                    <select
                      value={courierResult}
                      onChange={(e) => {
                        setCourierResult(e.target.value as CourierReportResult | "");
                        setCourierDate("");
                      }}
                      className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-2.5 py-2 text-sm text-slate-800"
                    >
                      <option value="">Selecciona el resultado…</option>
                      {COURIER_REPORT_RESULTS.map((result) => (
                        <option key={result.code} value={result.code}>{result.optionLabel}</option>
                      ))}
                    </select>
                  </label>

                  {courierResultDefinition && (
                    <div className="rounded-lg border border-slate-200 bg-white p-2.5">
                      <p className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-500">Qué sucederá</p>
                      <p className="mt-0.5 text-xs leading-relaxed text-slate-700">
                        {courierResultDefinition.effect}
                      </p>
                      {reopensClosedGuide && (
                        <p className="mt-1.5 rounded-md bg-amber-50 px-2 py-1 text-xs font-medium text-amber-800">
                          Esta corrección reabrirá una guía que actualmente está cerrada.
                        </p>
                      )}
                    </div>
                  )}

                  {courierResultDefinition?.requiresDate && (
                    <label className="block text-xs font-medium text-slate-600">
                      Nueva fecha de entrega informada por Fenix
                      <input
                        type="date"
                        value={courierDate}
                        onChange={(e) => setCourierDate(e.target.value)}
                        className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-2.5 py-2 text-sm"
                      />
                    </label>
                  )}

                  {courierResultDefinition && (
                    <label className="block text-xs font-medium text-slate-600">
                      {courierResult === "no_contesta"
                        ? "Comentario para el historial (opcional)"
                        : courierResultDefinition.requiresNote
                          ? "Motivo informado por Fenix"
                          : "Detalle del reporte (opcional)"}
                      <textarea
                        value={courierNote}
                        onChange={(e) => setCourierNote(e.target.value)}
                        rows={2}
                        placeholder={
                          courierResult === "no_contesta"
                            ? "Ej.: motorizado llamó dos veces; cliente no respondió…"
                            : courierResultDefinition.requiresNote
                              ? "Ej.: cliente rechazó el pedido…"
                              : "Detalle informado por el courier…"
                        }
                        className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-2.5 py-2 text-sm"
                      />
                      {courierResult === "no_contesta" && (
                        <span className="mt-1 block text-xs font-normal leading-relaxed text-slate-500">
                          Se guardará en el historial junto al cambio No contesta → Pendiente.
                        </span>
                      )}
                    </label>
                  )}

                  <div className="flex gap-2">
                    {showCourierCorrection && (
                      <button
                        type="button"
                        onClick={() => setShowCourierCorrection(false)}
                        className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-600 hover:bg-slate-50"
                      >
                        Cancelar
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => {
                        if (!courierResult) return;
                        run(
                          () => registerCourierReportResult(shipmentId, {
                            result: courierResult,
                            deliveryDate: courierDate ? new Date(courierDate).toISOString() : null,
                            note: courierNote,
                          }),
                          () => {
                            setCourierResult("");
                            setCourierDate("");
                            setCourierNote("");
                            setShowCourierCorrection(false);
                          },
                        );
                      }}
                      disabled={pending || !courierFormValid}
                      className="flex-1 rounded-lg bg-brand-600 px-3 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50"
                    >
                      {pending ? "Registrando…" : "Registrar resultado y continuar"}
                    </button>
                  </div>
                </section>
              )
            )}

            {/* claim + re-route call — hidden once the shipment is terminal (entregado/
                anulado/transferido) so a stray "no contesta" can't reopen a closed guide */}
            {isCallable(detail.shipment.delivery_status) && !fenixAwaitingCourierResult && (
              <section className="space-y-1.5 rounded-xl border border-slate-200 bg-white p-2.5">
                <h3 className="text-sm font-semibold text-slate-900">Registrar o programar llamada</h3>
                <label className="block text-xs font-medium text-slate-600">
                  Resultado de la llamada
                  <select
                    value={disposition}
                    onChange={(e) => setDisposition(e.target.value as RerouteDisposition)}
                    className="mt-0.5 w-full rounded-lg border border-slate-200 px-2.5 py-1.5 text-sm text-slate-800"
                  >
                    {DISPOSITIONS.map((d) => (
                      <option key={d.key} value={d.key}>
                        {d.label}
                      </option>
                    ))}
                  </select>
                </label>
                {disposition === "confirma" && aliclikDecision && (
                  <div className="space-y-2 rounded-xl border border-slate-200 bg-slate-50/70 p-2.5">
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-500">
                        Paso 1 · elegir ruta
                      </p>
                      <p className="mt-0.5 text-xs text-slate-600">{aliclikDecisionCopy(aliclikDecision)}</p>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <button
                        type="button"
                        onClick={() => {
                          setReprogramProvider("aliclik");
                          setForceAliclik(false);
                        }}
                        disabled={!aliclikDecision.eligible}
                        className={cn(
                          "rounded-lg border px-2.5 py-2 text-left text-xs transition",
                          reprogramProvider === "aliclik" && !forceAliclik
                            ? "border-brand-500 bg-brand-50 text-brand-800"
                            : "border-slate-200 bg-white text-slate-600",
                          !aliclikDecision.eligible && "cursor-not-allowed opacity-45",
                        )}
                      >
                        <span className="block font-semibold">Aliclik</span>
                        <span>Misma guía</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setReprogramProvider("fenix");
                          setForceAliclik(false);
                        }}
                        disabled={!fenixRouteAvailable}
                        className={cn(
                          "rounded-lg border px-2.5 py-2 text-left text-xs transition",
                          reprogramProvider === "fenix"
                            ? "border-brand-500 bg-brand-50 text-brand-800"
                            : "border-slate-200 bg-white text-slate-600",
                          !fenixRouteAvailable && "cursor-not-allowed opacity-45",
                        )}
                      >
                        <span className="block font-semibold">Fenix</span>
                        <span>{fenixRouteAvailable ? "Nueva guía" : "Sin stock/cobertura"}</span>
                      </button>
                    </div>
                    {!aliclikDecision.eligible &&
                      aliclikDecision.reason !== "not_aliclik" &&
                      aliclikDecision.reason !== "three_attempts" && (
                      <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-dashed border-slate-300 bg-white p-2 text-xs text-slate-600">
                        <input
                          type="checkbox"
                          checked={forceAliclik}
                          onChange={(e) => {
                            setForceAliclik(e.target.checked);
                            setReprogramProvider(e.target.checked ? "aliclik" : "fenix");
                          }}
                          className="mt-0.5"
                        />
                        <span>
                          <b>Excepción manual Aliclik.</b> Requiere explicar el motivo en la nota y quedará auditada.
                        </span>
                      </label>
                    )}
                    {reprogramProvider === "aliclik" ? (
                      <p className="rounded-lg bg-slate-50 px-2.5 py-1.5 text-xs leading-relaxed text-slate-600">
                        Primero realiza la reprogramación en Aliclik. Luego confírmala aquí: se conservará la guía actual.
                      </p>
                    ) : detail.shipment.order_name ? (
                      // Antes decía sólo «se generará una nueva guía Fenix», sin
                      // distinguir los DOS caminos que hay detrás del mismo botón.
                      // La operadora apretaba sin saber si el número lo pondría
                      // Swayp o si tendría que cargar la guía a mano en el Excel,
                      // y se enteraba recién en el aviso posterior. El destino ya
                      // decide cuál es; decirlo antes es gratis.
                      detail.swaypApiCity ? (
                        <p className="rounded-lg bg-slate-50 px-2.5 py-1.5 text-xs leading-relaxed text-slate-600">
                          Se generará una <b>nueva guía Fenix</b> con la fecha elegida y{" "}
                          <b>el número lo emite Swayp</b>: quedará creada en su sistema, sin
                          cargarla al Excel. Si Swayp no responde, queda con código local y el
                          aviso te dice por qué.
                        </p>
                      ) : (
                        <p className="rounded-lg bg-slate-50 px-2.5 py-1.5 text-xs leading-relaxed text-slate-600">
                          Se generará una <b>nueva guía Fenix</b> con la fecha elegida{" "}
                          <b>con código local</b>: este destino todavía no emite por API, así que
                          hay que cargarla en el Excel de programación.
                        </p>
                      )
                    ) : (
                      <p className="rounded-lg bg-amber-50 px-2.5 py-1.5 text-xs leading-relaxed text-amber-800">
                        Sin N° de pedido no se puede autogenerar. Usa <b>Generar guía Fenix (manual)</b> abajo.
                      </p>
                    )}
                  </div>
                )}
                {disposition === "programar" && (
                  <p className="rounded-lg bg-slate-50 px-2.5 py-1.5 text-xs leading-relaxed text-slate-600">
                    La guía se ocultará hasta la fecha elegida y volverá a la cola ese día.
                    No aumenta los intentos ni cambia el estado del envío.
                  </p>
                )}
                <label className="block text-xs font-medium text-slate-600">
                  {disposition === "confirma"
                    ? reprogramProvider === "aliclik"
                      ? "Fecha de reprogramación en Aliclik"
                      : "Fecha de reprogramación (va en la nueva guía Fenix)"
                    : disposition === "programar"
                      ? "Fecha de próxima llamada"
                      : "Próximo intento"}
                  <input
                    type="date"
                    value={nextDate}
                    onChange={(e) => setNextDate(e.target.value)}
                    min={disposition === "programar" ? tomorrowDateInputValue() : undefined}
                    className="mt-0.5 w-full rounded-lg border border-slate-200 px-2.5 py-1.5 text-sm text-slate-800"
                  />
                </label>
                <label className="block text-xs font-medium text-slate-600">
                  Nota de la llamada
                  <textarea
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    placeholder="Qué dijo la clienta…"
                    className="mt-0.5 w-full rounded-lg border border-slate-200 px-2.5 py-1.5 text-sm text-slate-800"
                    rows={2}
                  />
                </label>
                <button
                  onClick={() =>
                    run(() =>
                      registerRerouteCall(shipmentId, {
                        disposition,
                        note,
                        nextFollowupAt: nextDate ? new Date(nextDate).toISOString() : null,
                        reprogramProvider,
                        forceAliclik,
                      }),
                    )
                  }
                  disabled={pending || requiredDateMissing}
                  className="w-full rounded-lg bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50"
                >
                  {disposition === "confirma" && !nextDate
                    ? "Elige la fecha para confirmar"
                    : fenixAutoUnavailable
                      ? "Fenix no disponible; usa una excepción manual"
                    : overrideNoteMissing
                      ? "Explica el motivo de la excepción"
                    : programDateInvalid
                      ? "Elige una fecha futura"
                      : disposition === "programar"
                        ? "Programar llamada"
                        : disposition === "confirma" && reprogramProvider === "aliclik"
                          ? "Confirmar reprogramación Aliclik"
                          : disposition === "confirma"
                            ? "Crear guía Fenix y confirmar"
                            : "Registrar llamada"}
                </button>
              </section>
            )}

            {/* Fenix guide — manual fallback. The common path auto-generates the
                guide from "Cliente confirma" above; this stays for shipments
                without an order name, or to type a specific Fenix code. */}
            {detail.shipment.delivery_status === "pendiente" && (
              <section className="space-y-1.5 rounded-xl border border-slate-200 bg-white p-2.5">
              <h3 className="text-sm font-semibold text-slate-900">Generar guía Fenix (manual)</h3>
              {detail.shipment.fenix_shipment_id ? (
                <p className="text-xs text-emerald-700">Ya tiene guía Fenix vinculada.</p>
              ) : (
                <>
                  <label className="block text-xs font-medium text-slate-600">
                    Fecha de reprogramación (va en la guía)
                  </label>
                  <input
                    type="date"
                    value={nextDate}
                    onChange={(e) => setNextDate(e.target.value)}
                    className="w-full rounded-lg border border-slate-200 px-2.5 py-1.5 text-sm"
                  />
                  <div className="flex gap-2">
                    <input
                      value={fenixGuide}
                      onChange={(e) => setFenixGuide(e.target.value)}
                      placeholder="N° de guía Fenix"
                      className="flex-1 rounded-lg border border-slate-200 px-2.5 py-1.5 text-sm"
                    />
                    <button
                      type="button"
                      onClick={() =>
                        setFenixGuide(
                          rescheduleGuideCode(
                            drawerOrderName,
                            nextDate ? new Date(nextDate).toISOString() : null,
                          ),
                        )
                      }
                      disabled={!drawerOrderName}
                      title={
                        drawerOrderName
                          ? undefined
                          : "Este envío no tiene N° de pedido para generar la guía"
                      }
                      className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs text-slate-600 hover:bg-slate-50 disabled:opacity-50"
                    >
                      Autogenerar
                    </button>
                  </div>
                  <button
                    onClick={() =>
                      run(() =>
                        createFenixGuide(shipmentId, {
                          guideCode: fenixGuide,
                          nextFollowupAt: nextDate ? new Date(nextDate).toISOString() : null,
                        }),
                      )
                    }
                    disabled={pending || !fenixGuide.trim()}
                    className="w-full rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                  >
                    Crear guía Fenix
                  </button>
                </>
              )}
              </section>
            )}

            {/* El historial va DENTRO del bloqueo: con la guía reservada por otra
                persona, «no modificarla» incluye sus notas. */}
            <ShipmentGuideHistory guides={detail.guideHistory} onSaved={refresh} />

            </fieldset>
          </div>
        )}
      </div>
      {noveltyOpen && shipment && detail && !("error" in detail) && (
        <SwaypNoveltyModal
          shipmentId={shipment.id}
          guideCode={shipment.guide_code}
          swaypGuide={shipment.swayp_guide ?? null}
          swaypState={shipment.swayp_state ?? null}
          canReturn={detail.can.return}
          onClose={() => setNoveltyOpen(false)}
          onSolved={() => {
            void refresh();
            void onShipmentUpdated(shipment.id);
          }}
        />
      )}
    </div>
  );
}

function ShipmentGuideHistory({
  guides,
  onSaved,
}: {
  guides: ShipmentHistoryGuide[];
  onSaved: () => void;
}) {
  return (
    <section className="space-y-2.5 rounded-xl border border-slate-200 bg-white p-2.5">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-slate-900">Historial desde el origen</h3>
          <p className="text-xs text-slate-500">Todas las guías de esta reprogramación</p>
        </div>
        <span className="rounded-full border border-slate-200 bg-white px-2 py-0.5 text-xs font-medium text-slate-600">
          {guides.length} {guides.length === 1 ? "guía" : "guías"}
        </span>
      </div>

      <div>
        {guides.map((guide, guideIndex) => (
          <div key={guide.id}>
            {guideIndex > 0 && (
              <div className="flex items-center gap-2 py-1.5" aria-label="Transferencia a una nueva guía">
                <span className="h-px flex-1 bg-slate-200" />
                <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-semibold uppercase tracking-[0.12em] text-slate-600">
                  Transferida → nueva guía Fenix
                </span>
                <span className="h-px flex-1 bg-slate-200" />
              </div>
            )}

            <article
              className={cn(
                "overflow-hidden rounded-xl border bg-white",
                guide.is_current
                  ? "border-brand-300"
                  : "border-slate-200",
              )}
            >
              <header
                className={cn(
                  "flex items-start justify-between gap-3 border-b px-3 py-2",
                  guide.is_current
                    ? "border-brand-100 bg-brand-50/80"
                    : "border-slate-100 bg-slate-50",
                )}
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-500">
                      {guideIndex === 0 ? "Guía original" : `Reprogramación ${guideIndex}`}
                    </span>
                    <span
                      className={cn(
                        "rounded-full px-1.5 py-0.5 text-xs font-medium",
                        guide.courier === "fenix"
                          ? "bg-orange-100 text-orange-700"
                          : "bg-sky-100 text-sky-700",
                      )}
                    >
                      {guide.courier === "fenix"
                        ? guide.created_via === "fenix_directo"
                          ? "Fenix directa"
                          : "Fenix"
                        : "Aliclik"}
                    </span>
                    {guide.is_current && (
                      <span className="rounded-full bg-brand-600 px-1.5 py-0.5 text-xs font-medium text-white">
                        Vista actual
                      </span>
                    )}
                  </div>
                  <p className="mt-0.5 whitespace-nowrap font-mono text-xs font-semibold text-slate-800">
                    {guide.guide_code}
                  </p>
                </div>
                <StatusBadge category={guide.status_category} status={guide.delivery_status} />
              </header>

              {guide.calls.length === 0 ? (
                <p className="px-3 py-2.5 text-xs text-slate-500">Sin gestiones registradas en esta guía.</p>
              ) : (
                <ul className="divide-y divide-slate-100">
                  {guide.calls.map((call, callIndex) => (
                    <HistoryCallItem
                      key={call.id ?? `${guide.id}-${callIndex}`}
                      call={call}
                      onSaved={onSaved}
                    />
                  ))}
                </ul>
              )}
            </article>
          </div>
        ))}
      </div>
    </section>
  );
}

/** Una gestión del historial con su nota editable (cualquiera con acceso puede
 *  corregirla; queda marcada como "editada" con quién y cuándo). */
function HistoryCallItem({ call, onSaved }: { call: ShipmentCallRow; onSaved: () => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(call.note ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const occurredAt = fmtStatusSince(call.occurred_at ?? null);
  const editedAt = fmtStatusSince(call.note_edited_at ?? null);

  async function save() {
    if (!call.id) return;
    setSaving(true);
    setError(null);
    const res = await updateShipmentCallNote(call.id, draft);
    setSaving(false);
    if (res.error) {
      setError(res.error);
      return;
    }
    setEditing(false);
    onSaved();
  }

  return (
    <li className="px-3 py-2 text-xs text-slate-600">
      <div className="flex items-start justify-between gap-3">
        <span className="font-medium text-slate-700">
          {shipmentHistoryLabel(call)}
          {call.new_status ? ` → ${labelOf(call.new_status)}` : ""}
        </span>
        <span className="shrink-0 text-right text-xs tabular-nums text-slate-500">
          {occurredAt && <span className="block">{occurredAt}</span>}
          {call.agent_name && <span className="block">{call.agent_name}</span>}
        </span>
      </div>

      {editing ? (
        <div className="mt-1 space-y-1">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={2}
            autoFocus
            aria-label="Nota de la gestión"
            className="w-full rounded-md border border-slate-300 px-2 py-1 text-xs text-slate-700 focus:border-brand-400 focus:outline-none"
            placeholder="Nota de la gestión…"
          />
          {error && <p className="text-xs text-red-600">{error}</p>}
          <div className="flex items-center gap-2">
            <button
              onClick={save}
              disabled={saving}
              className="rounded-md bg-brand-600 px-2 py-1 text-xs font-semibold text-white hover:bg-brand-700 disabled:opacity-50"
            >
              {saving ? "Guardando…" : "Guardar"}
            </button>
            <button
              onClick={() => {
                setEditing(false);
                setDraft(call.note ?? "");
                setError(null);
              }}
              disabled={saving}
              className="text-xs text-slate-500 hover:underline"
            >
              Cancelar
            </button>
          </div>
        </div>
      ) : (
        <div className="mt-0.5 flex items-start justify-between gap-2">
          <p className="leading-relaxed text-slate-600">
            {call.note || <span className="italic text-slate-500">Sin nota</span>}
          </p>
          {call.id && (
            <button
              onClick={() => {
                setDraft(call.note ?? "");
                setEditing(true);
              }}
              className="shrink-0 text-xs font-medium text-brand-700 hover:underline"
              title="Editar nota"
            >
              Editar
            </button>
          )}
        </div>
      )}

      {call.note_edited_at && !editing && (
        <p className="mt-0.5 text-xs text-slate-500">
          editada
          {call.note_editor_name ? ` por ${call.note_editor_name}` : ""}
          {editedAt ? ` · ${editedAt}` : ""}
        </p>
      )}

      {call.next_followup_at && (
        <p className="mt-0.5 text-slate-500">
          {call.new_status === "en_ruta"
            ? "Fecha de reprogramación"
            : call.new_status
              ? "Próximo intento"
              : "Próxima llamada"}
          : {fmtReprogram(call.next_followup_at)}
        </p>
      )}
    </li>
  );
}

/** Generic checklist filter. Empty selection means no restriction. */
function Field({
  label,
  value,
  clamp,
}: {
  label: string;
  value: string | null | undefined;
  /** Truncate long values (e.g. a product name) to 2 lines instead of
   *  eating the drawer's vertical space — full text still on hover. */
  clamp?: boolean;
}) {
  return (
    <div>
      <dt className="text-xs text-slate-500">{label}</dt>
      <dd className={cn("text-slate-700", clamp && "line-clamp-2")} title={clamp ? (value ?? undefined) : undefined}>
        {value || "—"}
      </dd>
    </div>
  );
}

function CompactMetric({
  label,
  value,
  tone = "neutral",
}: {
  label: string;
  value: string | null | undefined;
  tone?: "neutral" | "positive" | "warning" | "negative";
}) {
  return (
    <div className="min-w-0 px-2.5 py-2">
      <dt className="text-xs font-medium uppercase tracking-[0.12em] text-slate-500">
        {label}
      </dt>
      <dd
        className={cn(
          "mt-0.5 text-xs font-semibold tabular-nums",
          tone === "positive"
            ? "text-emerald-700"
            : tone === "warning"
              ? "text-amber-700"
              : tone === "negative"
                ? "text-rose-600"
                : "text-slate-700",
        )}
      >
        {value || "—"}
      </dd>
    </div>
  );
}

/**
 * The Aliclik NOTA parse can guess an order reference before it's actually
 * linked (matched=false) — but that guess is unverified (no phone check), so
 * it's never shown as if it were a real pedido. Only a confirmed vínculo
 * renders here; the guess still prefills the search box in OrderLinkPicker,
 * where it's verified against the phone before linking.
 */
function OrderNameLabel({ name, matched }: { name: string | null; matched: boolean }) {
  if (matched && name) return <>{name}</>;
  return <span className="text-slate-500">—</span>;
}

function ShipmentOrderItems({ order }: { order: ShipmentOrderDetail }) {
  const units = order.line_items.reduce(
    (total, item) => total + Math.max(0, item.quantity || 0),
    0,
  );

  return (
    <div className="border-t border-slate-100 pt-2.5">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs font-medium text-slate-600">Productos de Shopify</p>
        {order.line_items.length > 0 && (
          <p className="shrink-0 text-xs tabular-nums text-slate-500">
            {order.line_items.length} {order.line_items.length === 1 ? "producto" : "productos"}
            {" · "}
            {units} {units === 1 ? "unidad" : "unidades"}
          </p>
        )}
      </div>

      {order.line_items.length === 0 ? (
        <p className="mt-1.5 text-xs text-slate-500">Shopify no devolvió productos para este pedido.</p>
      ) : (
        <ul className="mt-1.5 divide-y divide-slate-100">
          {order.line_items.map((item, index) => (
            <li
              key={`${item.variant_id ?? item.sku ?? item.title}-${index}`}
              className="flex items-start gap-2.5 py-2 first:pt-1 last:pb-0"
            >
              <span className="inline-flex h-6 min-w-8 shrink-0 items-center justify-center rounded-md bg-slate-100 px-1.5 text-xs font-semibold tabular-nums text-slate-700">
                {item.quantity}×
              </span>
              <div className="min-w-0">
                <p className="text-sm leading-5 text-slate-700">
                  {item.title || "Producto sin nombre"}
                </p>
                {item.sku && <p className="mt-0.5 text-xs text-slate-500">SKU {item.sku}</p>}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}


// ── Métricas de reprogramación Kapso→Fénix ───────────────────────────────────

function pctLabel(tasa: number | null): string | null {
  return tasa == null ? null : `${Math.round(tasa * 100)}%`;
}

/** Snapshot SIEMPRE visible: productividad de hoy por asesora en Repro Provincia
 *  (gestiones + resultados del día), para que cada persona mande una "foto" de su
 *  trabajo al final del día. */
function TodayByAgentPanel({ rows }: { rows: ReproDayAgentNamed[] }) {
  const hoy = new Date().toLocaleDateString("es-PE", {
    weekday: "long",
    day: "2-digit",
    month: "short",
    timeZone: "America/Lima",
  });
  const totals = rows.reduce(
    (acc, r) => {
      acc.gestiones += r.gestiones;
      acc.reprogramadas += r.reprogramadas;
      acc.anuladas += r.anuladas;
      acc.entregadas += r.entregadas;
      acc.guias += r.guias;
      return acc;
    },
    { gestiones: 0, reprogramadas: 0, anuladas: 0, entregadas: 0, guias: 0 },
  );
  const label = (name: string) => name.split("@")[0] || name;

  return (
    <div className="rounded-xl border border-slate-200 bg-white">
      <div className="flex items-center gap-2 px-3 py-2 text-xs">
        <span className="text-sm font-semibold text-slate-800">Hoy por asesora</span>
        <span className="capitalize text-slate-500">{hoy}</span>
        <span className="ml-auto text-slate-500">Gestión de hoy en Repro Provincia</span>
      </div>
      {rows.length === 0 ? (
        <p className="px-3 pb-3 text-xs text-slate-500">Aún no hay gestión registrada hoy.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-t border-slate-100 text-xs text-slate-500">
                <th className="px-3 py-1.5 text-left font-medium">Asesora</th>
                <th className="px-3 py-1.5 text-right font-medium" title="Acciones de gestión hoy (llamadas + reprogramaciones)">
                  Gestiones
                </th>
                <th className="px-3 py-1.5 text-right font-medium" title="Confirmadas → En ruta">
                  Reprogram.
                </th>
                <th className="px-3 py-1.5 text-right font-medium" title="Cliente canceló → Anulado">
                  Anuladas
                </th>
                <th className="px-3 py-1.5 text-right font-medium" title="Marcadas Entregado en la gestión">
                  Entregadas
                </th>
                <th className="px-3 py-1.5 text-right font-medium" title="Guías distintas tocadas hoy">
                  Guías
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.agent} className="border-t border-slate-100">
                  <td className="px-3 py-1.5 text-slate-700">{label(r.name)}</td>
                  <td className="px-3 py-1.5 text-right font-semibold text-slate-800 tabular-nums">
                    {r.gestiones}
                  </td>
                  <td className="px-3 py-1.5 text-right text-violet-700 tabular-nums">{r.reprogramadas}</td>
                  <td className="px-3 py-1.5 text-right text-slate-500 tabular-nums">{r.anuladas}</td>
                  <td className="px-3 py-1.5 text-right text-emerald-700 tabular-nums">{r.entregadas}</td>
                  <td className="px-3 py-1.5 text-right text-slate-600 tabular-nums">{r.guias}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t border-slate-200 text-slate-600">
                <td className="px-3 py-1.5 text-left font-medium">Total equipo</td>
                <td className="px-3 py-1.5 text-right font-semibold tabular-nums">{totals.gestiones}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">{totals.reprogramadas}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">{totals.anuladas}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">{totals.entregadas}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">{totals.guias}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
  );
}

/** Franja compacta bajo el encabezado: la tasa de entrega de lo reprogramado en
 *  Kapso (guías Fénix hijas), visible sin clics. "Ver detalle" abre el popup. */
function ReprogramStrip({ stats, stores }: { stats: ReprogramStats; stores: StoreSummary[] }) {
  const [open, setOpen] = useState(false);
  if (!stats.historico.total) return null;
  const c = stats.last30;
  const pct = pctLabel(c.tasa);
  return (
    <>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs tabular-nums text-slate-600">
        <span className="text-sm font-semibold text-slate-800">Reprogramados en Kapso</span>
        <span className="text-slate-500">últimos 30 días:</span>
        <span className="font-semibold text-slate-800" title="Reprogramaciones confirmadas (Aliclik + Fénix)">
          {c.total}
        </span>
        <span>
          {c.entregados} entregados
          {pct && (
            <>
              {" "}
              (<b>{pct}</b> de los cerrados)
            </>
          )}
        </span>
        <span className="text-sky-700">{c.entregadosFenix} por Fénix</span>
        <span>{c.anulados} anulados</span>
        <span>
          {c.enCurso} en curso
          {c.enCursoViejos > 0 && (
            <span className="font-medium text-amber-700"> · {c.enCursoViejos} varados +{REPROGRAM_STALE_DAYS}d</span>
          )}
        </span>
        <button type="button" onClick={() => setOpen(true)} className="ml-auto font-medium text-brand-700 hover:underline">
          Ver detalle
        </button>
      </div>
      {open && <ReprogramModal stats={stats} stores={stores} onClose={() => setOpen(false)} />}
    </>
  );
}

function ReprogramCountsRow({ label, c }: { label: string; c: ReprogramCounts }) {
  const pct = pctLabel(c.tasa);
  return (
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-sm">
      <span className="w-28 shrink-0 truncate font-medium text-slate-700">{label}</span>
      <span className="tabular-nums text-slate-800" title="Reprogramaciones (Aliclik + Fénix)">{c.total}</span>
      <span className="tabular-nums text-emerald-700" title="Entregados (ambos couriers)">{c.entregados} entregados</span>
      {c.entregadosFenix > 0 && (
        <span className="tabular-nums text-sky-700" title="De los entregados, los que salieron por Fénix">
          {c.entregadosFenix} por Fénix
        </span>
      )}
      <span className="tabular-nums text-slate-500">{c.anulados} anulados</span>
      <span className="tabular-nums text-slate-500">{c.enCurso} en curso</span>
      {c.enCursoViejos > 0 && <span className="tabular-nums text-amber-700">{c.enCursoViejos} varados</span>}
      <span className="ml-auto font-semibold tabular-nums text-slate-800">{pct ?? "—"}</span>
    </div>
  );
}

type ReprogramPreset = "hoy" | "ayer" | "7d" | "mes" | "rango";
const REPROGRAM_PRESETS: { key: ReprogramPreset; label: string }[] = [
  { key: "hoy", label: "Hoy" },
  { key: "ayer", label: "Ayer" },
  { key: "7d", label: "Últimos 7 días" },
  { key: "mes", label: "Mes" },
  { key: "rango", label: "Rango" },
];

/** Rango de fechas-calendario Lima (YYYY-MM-DD) para un chip. */
function reprogramPresetRange(
  preset: ReprogramPreset,
  custom: { from: string; to: string },
): { from: string; to: string } {
  const today = limaTodayKey();
  const shift = (base: string, days: number) =>
    new Date(Date.parse(`${base}T12:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
  switch (preset) {
    case "hoy":
      return { from: today, to: today };
    case "ayer": {
      const y = shift(today, -1);
      return { from: y, to: y };
    }
    case "7d":
      return { from: shift(today, -6), to: today };
    case "mes":
      return { from: `${today.slice(0, 7)}-01`, to: today };
    case "rango":
      return { from: custom.from || today, to: custom.to || today };
  }
}

/** Popup de análisis: cortes por rango (chips), tendencia semanal y splits por
 *  tienda/asesor. La tasa siempre es sobre CERRADOS (entregado+anulado) — lo en
 *  curso se lista aparte. Las filas crudas se cargan una vez y los chips
 *  recomputan al instante en el cliente. */
function ReprogramModal({
  stats,
  stores,
  onClose,
}: {
  stats: ReprogramStats;
  stores: StoreSummary[];
  onClose: () => void;
}) {
  const storeName = (id: string) => stores.find((s) => s.id === id)?.name ?? "Otra";
  const maxWeek = Math.max(1, ...stats.semanas.map((w) => w.total));
  const weekLabel = (start: string) => `${start.slice(8, 10)}/${start.slice(5, 7)}`;

  const [data, setData] = useState<{ rows: ReprogramChildRow[]; asesorNames: Record<string, string> } | null>(null);
  const [preset, setPreset] = useState<ReprogramPreset>("hoy");
  const today = limaTodayKey();
  const [custom, setCustom] = useState({ from: today, to: today });

  useEffect(() => {
    let alive = true;
    loadReprogramData().then((d) => {
      if (alive) setData(d);
    });
    return () => {
      alive = false;
    };
  }, []);

  // Diálogo de verdad: el foco entra, Escape cierra, el foco vuelve al botón
  // que lo abrió. Misma regla que el cajón de la guía.
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panelRef.current?.focus();
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      e.preventDefault();
      closeRef.current();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      opener?.focus();
    };
  }, []);

  const { from, to } = reprogramPresetRange(preset, custom);
  const asesorNames = data?.asesorNames ?? stats.asesorNames;
  const ranged = data
    ? (() => {
        const { startMs, endMs } = limaRangeBounds(from, to);
        return reprogramRangeStats(data.rows, startMs, endMs, Date.now());
      })()
    : null;

  return (
    <div className="fixed inset-0 z-30 grid place-items-center bg-slate-900/30 p-4" onClick={onClose}>
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="reprogram-modal-title"
        tabIndex={-1}
        className="max-h-[85vh] w-full max-w-lg overflow-auto rounded-2xl bg-white p-5 shadow-xl outline-none"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 id="reprogram-modal-title" className="text-base font-semibold text-slate-900">
            Reprogramaciones (Aliclik + Fénix)
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Cerrar"
            className="text-slate-500 hover:text-slate-800"
          >
            <IconClose />
          </button>
        </div>

        {/* Chips de rango — para monitorear qué se está gestionando. */}
        <div className="flex flex-wrap items-center gap-1.5">
          {REPROGRAM_PRESETS.map((p) => (
            <button
              key={p.key}
              type="button"
              onClick={() => setPreset(p.key)}
              className={cn(
                "rounded-full border px-2.5 py-1 text-xs font-medium transition",
                preset === p.key
                  ? "border-brand-200 bg-brand-50 text-brand-700"
                  : "border-slate-200 bg-white text-slate-500 hover:bg-slate-50",
              )}
            >
              {p.label}
            </button>
          ))}
        </div>
        {preset === "rango" && (
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-slate-500">
            <span>Del</span>
            <input
              type="date"
              value={custom.from}
              max={custom.to}
              onChange={(e) => setCustom((s) => ({ ...s, from: e.target.value || s.from }))}
              className="rounded-lg border border-slate-200 px-2 py-1 text-xs text-slate-700"
            />
            <span>al</span>
            <input
              type="date"
              value={custom.to}
              min={custom.from}
              max={today}
              onChange={(e) => setCustom((s) => ({ ...s, to: e.target.value || s.to }))}
              className="rounded-lg border border-slate-200 px-2 py-1 text-xs text-slate-700"
            />
          </div>
        )}

        <div className="mt-3 space-y-1.5 rounded-xl border border-slate-100 bg-slate-50/60 p-3">
          {ranged ? (
            <ReprogramCountsRow
              label={from === to ? from.slice(5) : `${from.slice(5)}–${to.slice(5)}`}
              c={ranged.counts}
            />
          ) : (
            <p className="text-sm text-slate-500">Cargando…</p>
          )}
          <ReprogramCountsRow label="Histórico" c={stats.historico} />
        </div>

        {/* Tendencia semanal (semana = lunes local). Barra = reprogramados; el
            segmento verde son los que YA terminaron entregados. */}
        <p className="mt-4 mb-1 text-xs font-semibold tracking-[0.12em] text-slate-500 uppercase">Últimas 8 semanas</p>
        <div className="flex items-end gap-1.5">
          {stats.semanas.map((w) => {
            const h = Math.round((w.total / maxWeek) * 64);
            const hOk = w.total ? Math.round((w.entregados / w.total) * h) : 0;
            return (
              <div key={w.start} className="flex flex-1 flex-col items-center gap-0.5">
                <span className="text-xs tabular-nums text-slate-500">{w.total || ""}</span>
                <div
                  className="flex w-full flex-col justify-end overflow-hidden rounded-sm bg-slate-100"
                  style={{ height: 64 }}
                  title={`Semana del ${weekLabel(w.start)}: ${w.total} reprogramados · ${w.entregados} entregados · ${w.anulados} anulados`}
                >
                  <div className="w-full bg-slate-300" style={{ height: Math.max(0, h - hOk) }} />
                  <div className="w-full bg-emerald-500" style={{ height: hOk }} />
                </div>
                <span className="text-xs text-slate-500">{weekLabel(w.start)}</span>
              </div>
            );
          })}
        </div>

        <p className="mt-4 mb-1 text-xs font-semibold tracking-[0.12em] text-slate-500 uppercase">
          Por tienda ({presetLabel(preset)})
        </p>
        <div className="space-y-1.5">
          {ranged ? (
            Object.entries(ranged.porTienda).length ? (
              Object.entries(ranged.porTienda)
                .sort((a, b) => b[1].total - a[1].total)
                .map(([sid, c]) => <ReprogramCountsRow key={sid} label={storeName(sid)} c={c} />)
            ) : (
              <p className="text-xs text-slate-500">Sin reprogramaciones en este rango.</p>
            )
          ) : (
            <p className="text-xs text-slate-500">Cargando…</p>
          )}
        </div>

        <p className="mt-4 mb-1 text-xs font-semibold tracking-[0.12em] text-slate-500 uppercase">
          Por asesor ({presetLabel(preset)})
        </p>
        <div className="space-y-1.5">
          {ranged ? (
            Object.entries(ranged.porAsesor).length ? (
              Object.entries(ranged.porAsesor)
                .sort((a, b) => b[1].total - a[1].total)
                .map(([uid, c]) => (
                  <ReprogramCountsRow
                    key={uid}
                    label={uid === REPROGRAM_UNASSIGNED ? "Sin asignar" : asesorNames[uid] ?? uid}
                    c={c}
                  />
                ))
            ) : (
              <p className="text-xs text-slate-500">Sin reprogramaciones en este rango.</p>
            )
          ) : (
            <p className="text-xs text-slate-500">Cargando…</p>
          )}
        </div>

        <p className="mt-4 text-xs leading-relaxed text-slate-500">
          Universo: reprogramaciones confirmadas en el dashboard — <b>Aliclik</b> (la guía sigue en Aliclik) y{" "}
          <b>Fénix</b> (se creó una guía Fénix); las entregas de primer intento no entran. <b>Por Fénix</b> es el
          subconjunto de entregados que salió por una guía Fénix. Los cortes por rango usan la fecha en que se confirmó
          la reprogramación. La <b>tasa</b> es entregados ÷ cerrados (entregados + anulados) — lo en curso no la afecta.{" "}
          <b>Varados</b>: en curso hace más de {REPROGRAM_STALE_DAYS} días, probables anulados sin confirmar.
        </p>
      </div>
    </div>
  );
}

function presetLabel(preset: ReprogramPreset): string {
  return REPROGRAM_PRESETS.find((p) => p.key === preset)?.label.toLowerCase() ?? "rango";
}
