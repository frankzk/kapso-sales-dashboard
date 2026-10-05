"use client";

import { useRouter } from "next/navigation";
import { memo, useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { cn } from "@/components/ui";
import {
  Badge,
  Banner,
  CARD_ZONE,
  CHECKBOX,
  ChoiceChip,
  FIELD,
  FIELD_BOX,
  FilterPill,
  OpsButton,
  OptionTile,
  SECTION_CARD,
  SectionHead,
  Skeleton,
  StatusCard,
  opsButtonClass,
  type BadgeTone,
} from "@/components/ops-ui";
import { ChoicePill, DatePill, FacetPill } from "@/components/facet-pill";
import {
  IconAlert,
  IconArrowUpRight,
  IconCheckCircle,
  IconChevronRight,
  IconDownload,
  IconPackage,
  IconPhone,
  IconPlus,
  IconRepeat,
  IconWhatsApp,
} from "@/components/icons";
import { CopyButton } from "@/components/copy-button";
import { OrderLineItems } from "@/components/order-line-items";
// El mínimo del motivo de descarte lo define el servidor: acá se lee, no se
// repite. Estaba escrito «8» a mano en cuatro sitios contra una constante que
// ya existía, así que subirlo en `lib/` habría dejado la pantalla mintiendo.
import { DISCARD_REASON_MIN } from "@/lib/recovery-discard";
import { esNumeroDeGuiaSwayp } from "@/lib/swayp-guide";
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
  ALICLIK_MAX_INTENTOS,
  CLAIM_TTL_MINUTES,
  MAX_INTENTOS,
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
import { motivoParaMostrar } from "@/lib/aliclik-status";
import { normalizeDepartment } from "@/lib/peru-departamentos";
import {
  REPRO_COVERAGE_OPTIONS,
  reproCoverageDefault,
  reproCoverageKey,
  reproCoverageLabel,
} from "@/lib/order-coverage";
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
  voiceCallsPerConfirma,
  voiceConversion,
  voiceCostPerConfirma,
  type VoiceScoreRow,
} from "@/lib/voice-scoreboard";
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
import { liveElapsed, liveSignature, pinLiveCalls, type LiveVoiceCall } from "@/lib/voice-live";
import {
  REPROGRAM_STALE_DAYS,
  REPROGRAM_UNASSIGNED,
  isVoiceAgentKey,
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
  loadVoiceScore,
  loadLiveVoiceCalls,
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

/**
 * El tono de la chapa de estado (DESIGN.md, mundo de operación): pendiente es
 * trabajo por hacer, en ruta está en camino, entregada terminó bien; cerrada y
 * transferida ya no piden nada.
 */
const CATEGORY_TONE: Record<string, BadgeTone> = {
  pending: "warn",
  in_route: "info",
  delivered: "ok",
  closed: "neutral",
  transferred: "neutral",
};

const DISPOSITIONS: { key: RerouteDisposition; label: string }[] = [
  { key: "confirma", label: "Cliente confirma reprogramación" },
  { key: "programar", label: "Programar próxima llamada" },
  { key: "no_contesta", label: "No contesta" },
  // «Entregado» ya no es un resultado de llamada. Una guía se marca entregada
  // desde «Registrar resultado del courier» (Swayp) o desde la API/Excel
  // (Aliclik): dos puertas al mismo estado terminal eran dos formas de cerrar
  // una guía que el courier no había cerrado.
  { key: "cancela", label: "Cliente cancela / anula" },
];

/**
 * Una fecha corta que NO esconde el año cuando el año importa.
 *
 * Se mostraba siempre «12 sep», así que una guía de septiembre del año pasado
 * se leía igual que una de esta semana — en la comparación que decide si el
 * envío todavía entra por Aliclik o tiene que salir por Swayp. El año aparece
 * solo cuando no es el corriente: dentro del año, estorba.
 */
function fmtShortDate(parsed: Date): string {
  const sameYear = parsed.getUTCFullYear() === new Date().getFullYear();
  return parsed.toLocaleDateString("es-PE", {
    day: "2-digit",
    month: "short",
    ...(sameYear ? {} : { year: "numeric" }),
    timeZone: "UTC",
  });
}

/** Next reprogrammed follow-up date (next_followup_at) as "12 ago", or "—".
 *  Read in UTC: the date is picked from `<input type=date>` and stored as UTC
 *  midnight, so this shows the day the operator chose (and matches the day the
 *  Swayp guide code is stamped with) regardless of the viewer's timezone. */
function fmtReprogram(iso: string | null | undefined): string {
  if (!iso) return "—";
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return "—";
  return fmtShortDate(parsed);
}

function fmtAliclikDate(date: string | null | undefined): string {
  if (!date) return "—";
  const parsed = new Date(`${date}T12:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) return "—";
  return fmtShortDate(parsed);
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
    courier_report: "Reporte Swayp",
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
  if (decision.eligible) {
    return `Disponible: menos de ${ALICLIK_MAX_INTENTOS} intentos y dentro de la semana vigente.`;
  }
  if (decision.reason === "three_attempts") {
    return `Bloqueado: Aliclik registra ${ALICLIK_MAX_INTENTOS} intentos o más.`;
  }
  if (decision.reason === "outside_week") {
    return `Bloqueado: la fecha está fuera de la ventana ${decision.cutoffDate}–${decision.today}.`;
  }
  if (decision.reason === "missing_attempts") return "Bloqueado: el Excel no informó NRO. INTENTOS.";
  if (decision.reason === "missing_service_date") return "Bloqueado: el Excel no informó la Fecha Aliclik.";
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
 * Segunda mitad del estado: «Intento 3» en pendiente, «por Swayp» en
 * entregado, y en una guía cerrada sin entregar, en qué quedó el PEDIDO:
 * «Reproprovincia» mientras se puede reenviar, «Recuperación vencida» o
 * «Descartada» después. La primera mitad sigue siendo la guía —la verdad del
 * courier, que no se falsea—; la segunda es lo que hay que hacer. La tabla la
 * pone bajo la chapa; el cajón y la lista, dentro («Anulado · Reproprovincia»).
 */
function subState(s: {
  status_category: string;
  reroute_attempts: number;
  delivered_source: string | null;
  recovery?: RecoveryKind | null;
}): string {
  if (s.status_category === "pending") return attemptLabel(s.reroute_attempts);
  if (s.status_category === "delivered" && s.delivered_source)
    return `por ${s.delivered_source === "fenix" ? "Swayp" : "Aliclik"}`;
  if (s.recovery) return RECOVERY_LABEL[s.recovery];
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
  /** La segunda mitad (`subState`), dentro de la chapa. */
  suffix?: string;
}) {
  const text = suffix ? `${labelOf(status)} · ${suffix}` : labelOf(status);
  return (
    <Badge tone={CATEGORY_TONE[category] ?? "neutral"} title={text}>
      {text}
    </Badge>
  );
}

/**
 * Teclado de un diálogo: entra el foco, Escape cierra, Tab no se escapa, y al
 * cerrar el foco vuelve a donde estaba.
 *
 * POR QUÉ COMPARTIDO. El cajón de la guía y el modal de reprogramaciones tenían
 * cada uno su copia de Escape y su `panelRef.current?.focus()`, y la trampa de
 * foco faltaba en los dos: el panel tenía rol de diálogo y era modal, pero
 * Tab seguía recorriendo el tablero de atrás. Con teclado se terminaba
 * escribiendo en los filtros de una cola que el cajón estaba tapando.
 */
function useDialogKeys(
  panelRef: React.RefObject<HTMLDivElement | null>,
  onRequestClose: () => void,
) {
  const closeRef = useRef(onRequestClose);
  closeRef.current = onRequestClose;
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panelRef.current?.focus();
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      if (e.key === "Escape") {
        e.preventDefault();
        closeRef.current();
        return;
      }
      if (e.key !== "Tab") return;
      const panel = panelRef.current;
      if (!panel) return;
      const focusables = [
        ...panel.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ].filter((el) => el.offsetParent !== null);
      if (!focusables.length) {
        e.preventDefault();
        panel.focus();
        return;
      }
      const first = focusables[0]!;
      const last = focusables[focusables.length - 1]!;
      const active = document.activeElement;
      if (!e.shiftKey && (active === last || !panel.contains(active))) {
        e.preventDefault();
        first.focus();
      } else if (e.shiftKey && (active === first || active === panel || !panel.contains(active))) {
        e.preventDefault();
        last.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      opener?.focus();
    };
  }, [panelRef]);
}

const SIN_DISTRITO = "(sin distrito)";
const SIN_DEPARTAMENTO = "(sin departamento)";

function sameSet(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

// Departamento del reporte de Aliclik (columna DEPARTAMENTO → region). Se usa el
// departamento, no la provincia, para agrupar el filtro superior.
//
// Se normaliza AL AGRUPAR y no solo al importar, porque las filas viejas ya
// están guardadas con su grafía: medidas el 14-09-2026 había 77 valores
// distintos para 25 departamentos, así que el desplegable ofrecía «Junín» (501
// filas) y «Junin» (125) como si fueran dos sitios, y elegir uno escondía el
// otro. Las tres Limas siguen separadas a propósito: ver `peru-departamentos`.
function shipmentDepartment(shipment: Pick<ShipmentRow, "region">): string {
  return normalizeDepartment(shipment.region) || SIN_DEPARTAMENTO;
}

export function ShipmentsBoard({
  stores,
  view,
  counts,
  shipments,
  reprogram,
  todayByAgent,
  voiceScore,
  initialOpenId,
}: {
  stores: StoreSummary[];
  view: ShipmentView;
  counts: Record<ShipmentView, number>;
  shipments: ShipmentRow[];
  reprogram?: ReprogramStats;
  todayByAgent?: ReproDayAgentNamed[];
  /** «Agentes de voz: comparación» de hoy; los otros rangos se piden al elegirlos. */
  voiceScore?: VoiceScoreRow[] | null;
  initialOpenId?: string | null;
}) {
  const router = useRouter();
  const [openId, setOpenId] = useState<string | null>(initialOpenId ?? null);
  /** La fila señalada por el teclado (`j`/`k`), que `Enter` abre. */
  const [cursorId, setCursorId] = useState<string | null>(null);

  // client-side filters over the loaded view. Empty set = "all".
  const [storeFilter, setStoreFilter] = useState<Set<string>>(new Set());
  const [departmentFilter, setDepartmentFilter] = useState<Set<string>>(new Set());
  // Abre con TODO MENOS LIMA: ver `reproCoverageDefault`.
  const [coverageFilter, setCoverageFilter] = useState<Set<string>>(reproCoverageDefault);
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
  // "En ruta"/"Entregado": distinguir guías reprogramadas con Aliclik vs Swayp.
  const [reprogFilter, setReprogFilter] = useState<"all" | ReprogramCourier>("all");
  const [exportingFenix, setExportingFenix] = useState(false);
  const [fenixExportError, setFenixExportError] = useState<string | null>(null);
  const [directGuideOpen, setDirectGuideOpen] = useState(false);
  const [directGuideCreatedId, setDirectGuideCreatedId] = useState<string | null>(null);
  // En teléfono los diez filtros se pliegan detrás de un botón; en escritorio
  // van siempre a la vista.
  const [filtersOpen, setFiltersOpen] = useState(false);
  /** Aviso de un filtro que tocó a otro, para que el cambio no sea mudo. */
  const [filterNotice, setFilterNotice] = useState<string | null>(null);

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
  // the normalized Swayp coverage key and can intentionally contain a district.
  const departmentOptions = useMemo(
    () => Array.from(new Set(shipments.map(shipmentDepartment))).sort((a, b) => a.localeCompare(b)),
    [shipments],
  );
  const districtOptions = useMemo(
    () => Array.from(new Set(shipments.map((s) => s.district || SIN_DISTRITO))).sort((a, b) => a.localeCompare(b)),
    [shipments],
  );

  // Cada vista abre sin restricciones de provincia ni distrito. La lista de
  // filtros vive en `clientFilters`; acá solo se aplica a la vista nueva.
  useEffect(() => {
    resetClientFilters({ keepAcrossViews: true });
    setFilterNotice(null);
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
      // Sin `catch`, una búsqueda que fallara dejaba «Buscando…» para siempre y
      // la cola detrás, invisible. `handleShipmentUpdated` ya lo hacía bien;
      // este, que es el que corre en cada tecla, no.
      let r: ShipmentRow[] | null = null;
      try {
        r = await searchShipments(term);
      } catch {
        r = null;
      }
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
        (coverageFilter.size === 0 || coverageFilter.has(reproCoverageKey(s.order_coverage))) &&
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
        (!soloPorRecuperar || view !== "pendiente" || esPorRecuperar(s)) &&
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
    coverageFilter,
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

  const searchActive = search.trim().length >= 2;

  // EL ORDEN DE LA COLA VIVE ACÁ, no dentro de la tabla. La pantalla es una
  // cola, pero cada ciclo terminaba en la misma guía: cerrar, buscar la fila,
  // volver a abrir. Para ofrecer «Siguiente» hay que saber cuál es, y eso
  // depende del orden que la persona está viendo — así que el orden sube al
  // tablero y la tabla lo recibe ya resuelto.
  const [sort, setSort] = useState<ShipmentSort>(null);
  const toggleSort = useCallback((key: ShipmentSortKey) => {
    setSort((current) => ({
      key,
      direction: current?.key === key && current.direction === "asc" ? "desc" : "asc",
    }));
  }, []);
  const liveCalls = useLiveVoiceCalls(view === "pendiente");
  const liveByOrder = useMemo(() => new Map(liveCalls.map((c) => [c.orderId, c])), [liveCalls]);
  const liveFor = useCallback(
    (row: ShipmentRow) => (row.order_id ? liveByOrder.get(row.order_id) ?? null : null),
    [liveByOrder],
  );
  // La llamada en curso va primero en cualquier orden (MOM §11.8): es lo que
  // está pasando ahora con la cola, y nadie debería abrir esa guía a la vez.
  const queueOrder = useMemo(
    () =>
      pinLiveCalls(sort ? sortShipmentRows(filtered, sort.key, sort.direction, storeName) : filtered, liveByOrder),
    [filtered, sort, storeName, liveByOrder],
  );
  const searchOrder = useMemo(
    () =>
      results
        ? pinLiveCalls(sort ? sortShipmentRows(results, sort.key, sort.direction, storeName) : results, liveByOrder)
        : results,
    [results, sort, storeName, liveByOrder],
  );
  // Una llamada cuyo pedido no está en la lista visible (otro filtro, otra
  // tienda): se avisa arriba, para que «en vivo» no dependa de los filtros.
  const liveOffscreen = useMemo(
    () => liveCalls.filter((c) => !queueOrder.some((r) => r.order_id === c.orderId)),
    [liveCalls, queueOrder],
  );

  /**
   * La guía siguiente a la abierta, en el orden que se está viendo.
   *
   * Tras registrar, la guía gestionada SALE de la vista —es lo normal— y para
   * cuando se pulsa «Siguiente» ya no está en la lista con la que calcular
   * quién venía detrás. El comentario anterior decía que entonces se ofrecía
   * «la PRIMERA, que es la que ocupó su lugar en la cola»: es falso para toda
   * fila menos la primera. La fila 1 no ocupó el lugar de la fila 80, así que
   * «Siguiente» devolvía al tope una y otra vez. Solo se disimulaba en
   * Pendiente, porque «Sin contactar hoy» arranca encendido y las ya
   * gestionadas también salen; destildándolo, u ordenando por otra columna,
   * la cola se volvía un bucle sobre las mismas cuatro filas.
   *
   * Ahora la sucesora se anota MIENTRAS la guía abierta sigue en la lista, y es
   * esa la que se ofrece cuando desaparece.
   */
  const visibleOrder = searchActive ? (searchOrder ?? []) : queueOrder;
  const openIndex = openId ? visibleOrder.findIndex((r) => r.id === openId) : -1;
  const successorRef = useRef<{ openId: string; nextId: string | null } | null>(null);
  useEffect(() => {
    if (!openId || openIndex === -1) return;
    successorRef.current = { openId, nextId: visibleOrder[openIndex + 1]?.id ?? null };
  }, [openId, openIndex, visibleOrder]);

  const nextInQueue = (() => {
    if (!openId) return null;
    if (openIndex !== -1) return visibleOrder[openIndex + 1]?.id ?? null;
    const remembered = successorRef.current;
    if (
      remembered?.openId === openId &&
      remembered.nextId &&
      visibleOrder.some((r) => r.id === remembered.nextId)
    ) {
      return remembered.nextId;
    }
    // La sucesora también se fue (o nunca hubo): retomar por el principio.
    return visibleOrder[0]?.id ?? null;
  })();

  /**
   * Quién tiene tomada una guía, para no abrirla y descubrirlo recién dentro.
   *
   * Solo el HECHO, no el nombre: la fila trae `claimed_by` (un id) y no el
   * nombre de la asesora. Se respeta el mismo TTL que el servidor, y la guía
   * abierta en este momento no se marca: es la propia.
   */
  const claimedBy = useCallback(
    (row: ShipmentRow) => {
      if (!row.claimed_by || row.id === openId) return null;
      const since = row.claimed_at ? Date.parse(row.claimed_at) : NaN;
      if (Number.isNaN(since) || Date.now() - since > CLAIM_TTL_MINUTES * 60_000) return null;
      return "Tomada";
    },
    [openId],
  );

  /**
   * ATAJOS DE TECLADO PARA LA COLA. Quien trabaja doscientas guías por turno las
   * recorría a ratón: llegar a la fila cincuenta eran cincuenta tabulaciones.
   *
   * `j`/`k` mueven por la cola visible, `Enter` abre, `n` salta a la siguiente
   * con el cajón abierto. No se tocan cuando el foco está escribiendo —un `j` en
   * una nota es una letra, no un atajo— ni con modificadores, que pertenecen al
   * navegador.
   */
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return;
      const el = document.activeElement;
      const writing =
        el instanceof HTMLInputElement ||
        el instanceof HTMLTextAreaElement ||
        el instanceof HTMLSelectElement ||
        (el instanceof HTMLElement && el.isContentEditable);
      if (writing) return;
      // Con el cajón abierto solo vale `n`: el resto del teclado es del diálogo.
      if (openId) {
        if (e.key === "n" && nextInQueue) {
          e.preventDefault();
          setOpenId(nextInQueue);
        }
        return;
      }
      if (e.key === "j" || e.key === "k") {
        e.preventDefault();
        setCursorId((current) => {
          if (!visibleOrder.length) return null;
          const i = current ? visibleOrder.findIndex((r) => r.id === current) : -1;
          const next = e.key === "j" ? i + 1 : i - 1;
          const clamped = Math.max(0, Math.min(visibleOrder.length - 1, next));
          return visibleOrder[clamped]?.id ?? null;
        });
        return;
      }
      if (e.key === "Enter" && cursorId) {
        e.preventDefault();
        setOpenId(cursorId);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [openId, cursorId, nextInQueue, visibleOrder]);

  /**
   * `j`/`k` MUEVEN EL FOCO, no solo un anillo pintado.
   *
   * Antes esto solo hacía `scrollIntoView` y el cursor era un `ring-*` sobre la
   * fila: quien usa lector de pantalla pulsaba `j` y no oía nada, porque el
   * foco del navegador no se había movido. Se mueve al botón del código de guía
   * —que ya existía para poder abrir la cola sin ratón—, así el lector anuncia
   * la guía y `Enter` la abre por el camino nativo.
   */
  useEffect(() => {
    if (!cursorId) return;
    const target = document.getElementById(`shipment-open-${cursorId}`);
    if (target) {
      target.focus({ preventScroll: true });
      target.scrollIntoView({ block: "nearest" });
      return;
    }
    document.getElementById(`shipment-row-${cursorId}`)?.scrollIntoView({ block: "nearest" });
  }, [cursorId]);

  /**
   * La guía abierta, en la URL, sin recargar la página.
   *
   * `initialOpenId` ya existía —la página lee `?open=`— pero abrir una guía no
   * lo escribía: no había forma de compartir «mira esta guía» ni de recuperarla
   * tras un F5. Va por `replaceState` y no por `router.push` a propósito: un
   * push revalida la ruta y el servidor volvería a mandar la vista entera (3 MB
   * en Entregado) por abrir un cajón.
   */
  useEffect(() => {
    const url = new URL(window.location.href);
    if (openId) url.searchParams.set("open", openId);
    else url.searchParams.delete("open");
    window.history.replaceState(window.history.state, "", url);
  }, [openId]);

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

  /**
   * LOS FILTROS DEL CLIENTE, EN UN SOLO SITIO.
   *
   * Estaban escritos cuatro veces: el efecto de cambio de vista, el cierre del
   * modal de guía directa, el handler de «Limpiar filtros» y la condición que
   * decide si ese botón se dibuja siquiera. Cuatro listas a mano, y
   * «Por recuperar» faltaba en las cuatro. El resultado era una trampa sin
   * salida: se marcaba en Pendiente, se cambiaba de pestaña —donde su casilla
   * ni se dibuja—, la bandera seguía encendida, `esPorRecuperar` solo es cierto
   * para guías Aliclik anuladas dentro de ventana, así que la lista quedaba
   * vacía… y «Limpiar filtros» no aparecía porque su condición tampoco lo
   * nombraba. La única salida era recargar la página.
   *
   * `active` es «se aparta del valor por defecto DE ESTA VISTA», no «está
   * encendido»: «Sin contactar hoy» arranca encendido en Pendiente, y ahí no
   * es un filtro puesto sino el estado normal de la cola. Por eso `reset()`
   * devuelve al valor por defecto en vez de apagar: limpiar filtros significa
   * «como se abre la pestaña», y así el contador queda en cero de verdad.
   */
  const uncontactedTodayDefault = view === "pendiente";
  const clientFilters: { active: boolean; reset: () => void; survivesViewChange?: boolean }[] = [
    // La tienda elegida sobrevive al cambio de pestaña: es con quién trabajas,
    // no qué estás mirando.
    { active: storeFilter.size > 0, reset: () => setStoreFilter(new Set()), survivesViewChange: true },
    // Cobertura: «activo» es apartarse de TODO MENOS LIMA, que es como abre.
    // Sobrevive al cambio de pestaña, como la tienda: es qué cola estás
    // trabajando, no qué estás mirando.
    {
      active: !sameSet(coverageFilter, reproCoverageDefault()),
      reset: () => setCoverageFilter(reproCoverageDefault()),
      survivesViewChange: true,
    },
    { active: departmentFilter.size > 0, reset: () => setDepartmentFilter(new Set()) },
    { active: districtFilter.size > 0, reset: () => setDistrictFilter(new Set()) },
    { active: Boolean(dateFilter), reset: () => setDateFilter("") },
    { active: unmatchedOnly, reset: () => setUnmatchedOnly(false) },
    { active: soloPorRecuperar, reset: () => setSoloPorRecuperar(false) },
    { active: uncontactedOnly, reset: () => setUncontactedOnly(false) },
    {
      active: uncontactedTodayOnly !== uncontactedTodayDefault,
      reset: () => setUncontactedTodayOnly(uncontactedTodayDefault),
    },
    { active: fenixFilter !== "all", reset: () => setFenixFilter("all") },
    { active: aliclikRouteFilter !== "all", reset: () => setAliclikRouteFilter("all") },
    { active: reprogFilter !== "all", reset: () => setReprogFilter("all") },
  ];

  /** Cuántos filtros se apartan de cómo abre la vista: lo que limpia «Limpiar filtros». */
  const activeFilters = clientFilters.filter((f) => f.active).length;

  /**
   * Cuántas píldoras están puestas —sólidas— en esta vista, contando las que la
   * vista trae encendidas (Cobertura «Todo menos Lima», «Sin contactar hoy»).
   * Es lo que dice la píldora «Filtros» del teléfono: plegados, esos dos
   * acotaban la cola sin que nada lo dijera. La ruta y «Reprogramado por» no
   * cuentan: están a la vista, sobre los filtros.
   */
  const pillsOn = [
    storeFilter.size > 0,
    coverageFilter.size > 0,
    departmentFilter.size > 0,
    districtFilter.size > 0,
    Boolean(dateFilter),
    fenixFilter !== "all",
    unmatchedOnly,
    view === "pendiente" && uncontactedTodayOnly,
    view === "pendiente" && uncontactedOnly,
    view === "pendiente" && soloPorRecuperar,
  ].filter(Boolean).length;

  /** Devuelve los filtros a como abre la vista. `keepAcrossViews` conserva la tienda. */
  function resetClientFilters(opts?: { keepAcrossViews?: boolean }) {
    for (const f of clientFilters) {
      if (opts?.keepAcrossViews && f.survivesViewChange) continue;
      f.reset();
    }
  }

  function go(params: Record<string, string>) {
    const sp = new URLSearchParams({ view, ...params });
    router.push(`/dashboard/envios?${sp.toString()}`);
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

    resetClientFilters();
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
        throw new Error(payload?.error || "No se pudo generar el Excel de Swayp.");
      }

      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `swayp_programacion_${dateFilter}.xlsx`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (error) {
      setFenixExportError(
        error instanceof Error ? error.message : "No se pudo generar el Excel de Swayp.",
      );
    } finally {
      setExportingFenix(false);
    }
  }

  const scope =
    stores.length === 1 ? `de ${stores[0]!.name}` : stores.length === 2 ? "de las dos tiendas" : `de las ${stores.length} tiendas`;
  // «Todo menos Lima» es como abre la cola: la píldora lo dice con esas
  // palabras y no como «Provincia COD +3», que obliga a abrirla para saberlo.
  const coverageSummary = (selected: Set<string>) =>
    sameSet(selected, reproCoverageDefault()) ? "Todo menos Lima" : null;

  return (
    <div className="space-y-6">
      {/* Título y contexto; debajo, la búsqueda y las cuatro acciones en una
          fila. Al lado del título no caben: con la barra lateral, en 1.440 px
          partían el contexto en una palabra por línea. */}
      <header className="space-y-4">
        <div className="min-w-0">
          <h1 className="text-[28px] font-bold leading-9 tracking-[-0.01em] text-ink-900">Repro Provincia</h1>
          <p className="mt-1 text-sm text-ink-500">
            La cola de reprogramación y las guías Aliclik y Swayp {scope}.
          </p>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
          <ShipmentSearch value={search} onChange={setSearch} />
          {/* En el teléfono, las cuatro acciones en una rejilla de 2 × 2:
              sueltas, dos quedaban solas en su fila. */}
          <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:items-center">
            <a href="/dashboard/envios/import" className={opsButtonClass("primary", "md", "pointer-coarse:h-11")}>
              Importar reporte
            </a>
            <OpsButton onClick={() => setDirectGuideOpen(true)} className="pointer-coarse:h-11">
              <IconPlus className="text-ink-500" />
              Guía Swayp directa
            </OpsButton>
            <a href="/dashboard/envios/stock" className={opsButtonClass("secondary", "md", "pointer-coarse:h-11")}>
              <IconPackage className="text-ink-500" />
              Stock Swayp
            </a>
            <a
              href="/dashboard/envios/automatico"
              aria-label="Automático Aliclik → Swayp"
              className={opsButtonClass("secondary", "md", "pointer-coarse:h-11")}
            >
              <IconRepeat className="text-ink-500" />
              <span className="sm:hidden">Automático</span>
              <span className="hidden items-center gap-1 sm:inline-flex">
                Automático Aliclik
                <IconArrowRight className="text-ink-500" />
                Swayp
              </span>
            </a>
          </div>
        </div>
      </header>

      {/* LA COLA VA PRIMERO. Las métricas de 30 días y el marcador por asesora
          son lectura de dirección, no de quien marca el teléfono: cada apertura
          de Envíos costaba un scroll y una lectura antes de la primera guía.
          Siguen a un clic, plegadas, con los mismos datos. */}
      {(reprogram || todayByAgent || voiceScore) && (
        <details className={cn(CARD, "group")}>
          <summary className="flex min-h-12 cursor-pointer list-none items-center gap-2 rounded-lg px-4 text-sm transition-colors hover:bg-wash group-open:rounded-b-none sm:px-5 [&::-webkit-details-marker]:hidden">
            <IconChevronRight
              aria-hidden
              className="size-4 shrink-0 text-ink-500 transition-transform duration-150 group-open:rotate-90 motion-reduce:transition-none"
            />
            <span className="font-semibold text-ink-900">Resumen</span>
            <span className="min-w-0 truncate text-ink-500">reprogramaciones, gestión de hoy y agentes de voz</span>
          </summary>
          <div className="divide-y divide-line border-t border-line">
            {reprogram && <ReprogramStrip stats={reprogram} stores={stores} />}
            {todayByAgent && <TodayByAgentPanel rows={todayByAgent} />}
            {voiceScore && <VoiceScorePanel initial={voiceScore} />}
          </div>
        </details>
      )}

      {searchActive ? (
        <section aria-label="Resultados de búsqueda" className={CARD}>
          <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-5">
            <p role="status" className="text-sm text-ink-700">
              {searching ? (
                "Buscando…"
              ) : results ? (
                <>
                  <b className="font-semibold tabular-nums text-ink-900">{results.length.toLocaleString("es-PE")}</b>{" "}
                  {results.length === 1 ? "resultado" : "resultados"} de búsqueda
                </>
              ) : (
                "La búsqueda no respondió. Escribe de nuevo para reintentar."
              )}
            </p>
            <OpsButton variant="ghost" size="sm" onClick={() => setSearch("")} className="pointer-coarse:h-11">
              Limpiar búsqueda
            </OpsButton>
          </div>
          {searching ? null : results && results.length > 0 ? (
            <ShipmentTable
              rows={searchOrder ?? results}
              stores={stores}
              storeName={storeName}
              onOpen={setOpenId}
              highlightedId={recentlyUpdatedId}
              cursorId={cursorId}
              claimedBy={claimedBy}
              liveFor={liveFor}
              sort={sort}
              onSort={toggleSort}
              showRoute
            />
          ) : results ? (
            <p className="border-t border-line px-4 py-8 text-sm text-ink-500 sm:px-5">
              Sin coincidencias. Prueba con el número de guía, el pedido, la guía Swayp o el celular.
            </p>
          ) : null}
        </section>
      ) : (
        <>
          {/* Las vistas son la navegación: seis cifras que llevan a su lista,
              como las macroetapas del Master. La elegida lleva el borde azul. */}
          <section aria-label="Estado de las guías" className="space-y-3">
            <div role="group" aria-label="Vista" className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6">
              {SHIPMENT_VIEWS.map((v) => (
                <StatusCard
                  key={v.key}
                  label={v.label}
                  value={counts[v.key]}
                  active={v.key === view}
                  onClick={() => go({ view: v.key })}
                />
              ))}
            </div>

            {/* LA RUTA ES LA PRIMERA PREGUNTA DE LA COLA: ¿todavía entra por
                Aliclik o tiene que salir por Swayp? Era un desplegable con el
                nombre «Gestión»; ahora son las cifras, a la vista, y filtran. */}
            {view === "pendiente" && (
              <div role="group" aria-label="Ruta sugerida" className="flex flex-wrap items-center gap-1.5">
                <span className="mr-1 text-[13px] font-medium text-ink-600">Ruta</span>
                <ChoiceChip
                  label="Todas"
                  count={filteredWithoutAliclikRoute.length}
                  active={aliclikRouteFilter === "all"}
                  onClick={() => setAliclikRouteFilter("all")}
                />
                <ChoiceChip
                  label="Aliclik disponible"
                  count={aliclikRouteCounts.aliclikAvailable}
                  active={aliclikRouteFilter === "aliclik_available"}
                  onClick={() => setAliclikRouteFilter("aliclik_available")}
                />
                <ChoiceChip
                  label="Swayp requerido"
                  count={aliclikRouteCounts.fenixRequired}
                  active={aliclikRouteFilter === "fenix_required"}
                  onClick={() => setAliclikRouteFilter("fenix_required")}
                />
              </div>
            )}
            {/* En ruta y Entregado: de las reprogramadas, por quién salieron. */}
            {showReprogFilter && (
              <div role="group" aria-label="Reprogramado por" className="flex flex-wrap items-center gap-1.5">
                <span className="mr-1 text-[13px] font-medium text-ink-600">Reprogramado por</span>
                <ChoiceChip
                  label="Todas"
                  active={reprogFilter === "all"}
                  onClick={() => setReprogFilter("all")}
                />
                <ChoiceChip
                  label="Aliclik"
                  count={reprogCounts.aliclik}
                  active={reprogFilter === "aliclik"}
                  onClick={() => setReprogFilter("aliclik")}
                />
                <ChoiceChip
                  label="Swayp"
                  count={reprogCounts.fenix}
                  active={reprogFilter === "fenix"}
                  onClick={() => setReprogFilter("fenix")}
                />
              </div>
            )}
          </section>

          {/* Filtros: píldoras discontinuas que se vuelven sólidas con su valor,
              como en el Master. Dos preguntas en una fila: qué guías entran
              (tienda, cobertura, departamento, distrito, programación, Swayp) y
              en qué punto de la gestión están (los interruptores). En teléfono
              esperan detrás de una sola píldora. */}
          {view !== "revision" && (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-2 md:hidden">
                <FilterPill
                  label="Filtros"
                  active={pillsOn > 0}
                  count={pillsOn > 0 ? pillsOn : undefined}
                  expanded={filtersOpen}
                  onClick={() => setFiltersOpen((v) => !v)}
                />
              </div>
              <div
                role="group"
                aria-label="Filtros"
                className={cn("flex-wrap items-center gap-2", filtersOpen ? "flex" : "hidden md:flex")}
              >
                {stores.length > 1 && (
                  <FacetPill
                    label="Tienda"
                    allLabel="Todas las tiendas"
                    options={stores.map((s) => ({ value: s.id, label: s.name }))}
                    selected={storeFilter}
                    onChange={setStoreFilter}
                  />
                )}
                <FacetPill
                  label="Cobertura"
                  allLabel="Todas las coberturas"
                  options={REPRO_COVERAGE_OPTIONS.map((key) => ({ value: key, label: reproCoverageLabel(key) }))}
                  selected={coverageFilter}
                  onChange={setCoverageFilter}
                  summarize={coverageSummary}
                />
                {departmentOptions.length > 1 && (
                  <FacetPill
                    label="Departamento"
                    allLabel="Todos los departamentos"
                    options={departmentOptions.map((d) => ({ value: d, label: d }))}
                    selected={departmentFilter}
                    onChange={setDepartmentFilter}
                  />
                )}
                {districtOptions.length > 1 && (
                  <FacetPill
                    label="Distrito"
                    allLabel="Todos los distritos"
                    options={districtOptions.map((d) => ({ value: d, label: d }))}
                    selected={districtFilter}
                    onChange={setDistrictFilter}
                  />
                )}
                <DatePill
                  label="Programación"
                  value={dateFilter}
                  onChange={setDateFilter}
                  today={localDateInputValue()}
                  tomorrow={tomorrowDateInputValue()}
                />
                <ChoicePill<FenixAvailabilityFilter>
                  label="Swayp"
                  allLabel="Con y sin stock Swayp"
                  allValue="all"
                  value={fenixFilter}
                  options={[
                    { value: "ok", label: "Swayp ok · con stock" },
                    { value: "sin_stock", label: "Sin stock Swayp" },
                    { value: "sin_cobertura", label: "Fuera de cobertura" },
                  ]}
                  onChange={(next) => {
                    setFenixFilter(next);
                    // «Sin stock» y «Fuera de cobertura» son preguntas sobre
                    // TODO el país, así que se quita la provincia. Se hacía en
                    // silencio y la lista cambiaba por dos motivos a la vez.
                    if ((next === "sin_stock" || next === "sin_cobertura") && departmentFilter.size > 0) {
                      setDepartmentFilter(new Set());
                      setFilterNotice("Se quitó el filtro de provincia: esta pregunta es sobre todo el país.");
                    } else {
                      setFilterNotice(null);
                    }
                  }}
                />
                {/* Los interruptores: un toque los enciende y otro los apaga. «Sin
                    contactar hoy» arranca encendido en Pendiente, que es como se
                    trabaja la cola: las que ya se llamaron vuelven mañana. */}
                {view === "pendiente" && (
                  <>
                    <FilterPill
                      label="Sin contactar hoy"
                      active={uncontactedTodayOnly}
                      pressed={uncontactedTodayOnly}
                      onClick={() => setUncontactedTodayOnly((v) => !v)}
                      title="Las guías ya llamadas hoy vuelven a la cola mañana"
                    />
                    <FilterPill
                      label="Nunca contactadas"
                      active={uncontactedOnly}
                      pressed={uncontactedOnly}
                      onClick={() => setUncontactedOnly((v) => !v)}
                      title="Sin una sola llamada registrada"
                    />
                    <FilterPill
                      label="Por recuperar"
                      active={soloPorRecuperar}
                      pressed={soloPorRecuperar}
                      onClick={() => setSoloPorRecuperar((v) => !v)}
                      describedBy="filtro-por-recuperar"
                    />
                  </>
                )}
                <FilterPill
                  label="Sin pedido vinculado"
                  active={unmatchedOnly}
                  pressed={unmatchedOnly}
                  onClick={() => setUnmatchedOnly((v) => !v)}
                  title="Guías que todavía no están unidas a un pedido de Shopify"
                />
                {activeFilters > 0 && (
                  <OpsButton
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      resetClientFilters();
                      setFilterNotice(null);
                    }}
                    className="pointer-coarse:h-11"
                  >
                    Limpiar filtros
                  </OpsButton>
                )}
              </div>
              {/* La regla vivía en un `title`: con teclado o en táctil no
                  existía. La píldora la anuncia con `aria-describedby` y, al
                  encenderla, se lee entera. */}
              {view === "pendiente" && (
                <p
                  id="filtro-por-recuperar"
                  className={cn("max-w-[68ch] text-[13px] leading-5 text-ink-600", !soloPorRecuperar && "sr-only")}
                >
                  Aliclik las cerró sin entregar y el pedido sigue en ventana de recuperación: admite
                  una salida Swayp. Las vencidas y las descartadas ya no están en esta cola.
                </p>
              )}
              {filterNotice && (
                <Banner tone="warn" role="status">
                  {filterNotice}
                </Banner>
              )}
            </div>
          )}

          {view === "revision" ? (
            <section aria-label="Revisión" className={cn(CARD, "px-4 py-4 sm:px-5")}>
              <p className="text-sm text-ink-700">
                Las filas por revisar se gestionan desde{" "}
                <a className="font-medium text-brand-700 underline-offset-2 hover:underline" href="/dashboard/envios/import">
                  Importar reporte
                </a>
                .
              </p>
            </section>
          ) : (
            <section aria-label="Guías" className={CARD}>
              <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-5">
                {/* El tamaño de la cola en una región viva, para que filtrar se
                    anuncie; y los atajos a la vista, que solo existían en los
                    comentarios del código. */}
                <p role="status" className="text-sm text-ink-700">
                  <b className="font-semibold tabular-nums text-ink-900">{filtered.length.toLocaleString("es-PE")}</b>{" "}
                  {filtered.length === shipments.length
                    ? `${filtered.length === 1 ? "guía" : "guías"} en esta vista`
                    : `de ${shipments.length.toLocaleString("es-PE")} guías pasan los filtros`}
                  <span className="hidden text-ink-500 xl:inline">
                    {" · "}
                    <kbd className={KBD}>j</kbd> <kbd className={KBD}>k</kbd> para moverte,{" "}
                    <kbd className={KBD}>Enter</kbd> para abrir, <kbd className={KBD}>n</kbd> para la siguiente
                  </span>
                </p>
                {view === "en_ruta" && (
                  <OpsButton
                    size="sm"
                    onClick={downloadFenixProgrammingWorkbook}
                    disabled={!dateFilter || !fenixRowsForExport.length || exportingFenix}
                    title={
                      !dateFilter
                        ? "Elige primero la fecha de programación"
                        : !fenixRowsForExport.length
                          ? "No hay guías Swayp visibles para esa fecha"
                          : "Descarga las guías Swayp que quedan en la lista"
                    }
                    className="pointer-coarse:h-11"
                  >
                    <IconDownload className="text-ink-500" />
                    {exportingFenix
                      ? "Generando Excel…"
                      : !dateFilter
                        ? "Elige la programación para el Excel"
                        : `Descargar Excel Swayp (${fenixRowsForExport.length})`}
                  </OpsButton>
                )}
              </div>
              {fenixExportError && (
                <Banner tone="crit" role="alert" className="mx-4 mb-3 sm:mx-5">
                  <div className="flex items-start justify-between gap-3">
                    <span className="break-words">{fenixExportError}</span>
                    <OpsButton variant="ghost" size="sm" onClick={() => setFenixExportError(null)} className="-my-1 shrink-0 pointer-coarse:h-11">
                      Cerrar
                    </OpsButton>
                  </div>
                </Banner>
              )}
              {liveOffscreen.length > 0 && (
                <LiveOffscreenNotice calls={liveOffscreen} onFind={(name) => setSearch(name)} />
              )}
              {filtered.length === 0 ? (
                <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-line px-4 py-8 sm:px-5">
                  <p className="text-sm text-ink-500">
                    {shipments.length === 0 ? "Sin guías en esta vista." : "Ninguna guía con esos filtros."}
                  </p>
                  {/* Una lista vacía por los filtros trae su salida al lado. */}
                  {activeFilters > 0 && (
                    <OpsButton
                      size="sm"
                      onClick={() => {
                        resetClientFilters();
                        setFilterNotice(null);
                      }}
                      className="pointer-coarse:h-11"
                    >
                      Limpiar filtros
                    </OpsButton>
                  )}
                </div>
              ) : (
                <ShipmentTable
                  rows={queueOrder}
                  stores={stores}
                  storeName={storeName}
                  onOpen={setOpenId}
                  highlightedId={recentlyUpdatedId}
                  cursorId={cursorId}
                  claimedBy={claimedBy}
                  liveFor={liveFor}
                  sort={sort}
                  onSort={toggleSort}
                  showRoute={view === "pendiente"}
                />
              )}
            </section>
          )}
        </>
      )}

      {openId && (
        <ShipmentDrawer
          /**
           * UNA GUÍA, UN CAJÓN. La `key` no es una optimización: es lo que
           * impide que el expediente de una clienta se cuele en el de la
           * siguiente.
           *
           * Sin ella React reutilizaba la misma instancia al cambiar de guía y
           * los 39 `useState` sobrevivían. `note` y `nextDate` no se limpian en
           * ningún sitio del archivo —nunca se limpiaron, lo confirma
           * `git log -S`— así que la guía B abría con la nota de A en el
           * textarea, la fecha de A en el campo y el botón habilitado: un clic
           * escribía la llamada de A en el expediente de B y la despachaba con
           * la fecha de A. Peor aún, el aviso de «tienes texto sin registrar»
           * saltaba en cada «Siguiente» del camino feliz, enseñando a
           * descartarlo sin leer.
           *
           * Remontar por `key` lo arregla POR CONSTRUCCIÓN: el siguiente estado
           * que alguien añada al cajón no puede filtrarse aunque olvide su
           * reseteo. Recargar la MISMA guía no remonta —la key no cambia—, así
           * que el cajón atenuado de `sameGuide` sigue funcionando igual.
           */
          key={openId}
          shipmentId={openId}
          onClose={() => setOpenId(null)}
          onOpenShipment={setOpenId}
          onShipmentUpdated={handleShipmentUpdated}
          nextShipmentId={nextInQueue}
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

/** Tarjeta blanca del mundo de operación: la de trabajo, la de resultados y el resumen. */
const CARD = "rounded-lg bg-white shadow-control ring-1 ring-line";
/** Una tecla, como la escribe la documentación de Stripe. */
const KBD = "rounded border border-line bg-wash px-1 font-sans text-xs text-ink-700";

/**
 * El buscador de la cola: a todo el ancho en el teléfono, 320 px en escritorio,
 * y «/» lo enfoca desde cualquier parte del tablero, como en el Master.
 */
function ShipmentSearch({ value, onChange }: { value: string; onChange: (next: string) => void }) {
  const input = useRef<HTMLInputElement>(null);
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
  return (
    <div role="search" className="relative w-full sm:w-64">
      <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-500">
        <IconSearch />
      </span>
      <input
        ref={input}
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape" && value) onChange("");
        }}
        enterKeyHint="search"
        aria-keyshortcuts="/"
        title="Atajo: /"
        placeholder="Buscar guía, pedido o celular…"
        aria-label="Buscar guía, pedido, guía Swayp o celular"
        className={cn(FIELD_BOX, "h-9 w-full pl-8 pr-9 pointer-coarse:h-11 [&::-webkit-search-cancel-button]:hidden")}
      />
      {value && (
        <button
          type="button"
          onClick={() => {
            onChange("");
            input.current?.focus();
          }}
          aria-label="Limpiar búsqueda"
          className="absolute right-1 top-1/2 grid size-7 -translate-y-1/2 place-items-center rounded-md text-ink-500 transition-colors hover:bg-wash hover:text-ink-900 pointer-coarse:right-0 pointer-coarse:size-11"
        >
          <IconClose />
        </button>
      )}
    </div>
  );
}

/**
 * Filas que se pintan de una vez. Pendiente trae 3.089 y Entregado 4.042: a
 * ocho celdas y un botón por fila son más de 25.000 nodos, y el navegador los
 * maqueta todos aunque la pantalla muestre veinte. Se pintan las primeras 200
 * —ordenadas y filtradas sobre el conjunto ENTERO, no sobre la ventana— y un
 * botón trae 200 más o todas. Nada se esconde: el contador de arriba sigue
 * diciendo cuántas hay, y la búsqueda global y los filtros ven el total.
 */
const VISIBLE_STEP = 200;

export type ShipmentSort = { key: ShipmentSortKey; direction: ShipmentSortDirection } | null;

/**
 * Encabezado y celda de la cola, los del Master: 12 px semibold entre
 * hairlines, celdas de dos líneas. La tabla va en `border-separate` para que
 * las hairlines del encabezado fijo viajen con él al hacer scroll.
 */
const TH =
  "sticky top-0 z-10 border-y border-line bg-white py-2 text-left align-top text-xs font-semibold text-ink-600";
const TD = "border-b border-line py-2.5 align-top group-last/row:border-b-0";
/**
 * El relleno lateral de las celdas: 8 px hasta 1.440 px y 12 desde ahí; en los
 * bordes de la tarjeta, 20. Va aparte de TH y TD porque `cn` no resuelve
 * conflictos: un `px-*` con variante pisaría el `pl-5` de la primera columna.
 */
const CELL_X = "px-2 min-[1440px]:px-3";
const FIRST_X = "pl-5 pr-2 min-[1440px]:pr-3";
const LAST_X = "pl-2 pr-5 min-[1440px]:pl-3";
/** La segunda línea de una celda: el dato que acompaña al principal. */
const SUBLINE = "text-[13px] leading-5 text-ink-500";
/**
 * « · » con espacio duro delante: el punto se queda con la palabra anterior y,
 * si la línea se parte, ninguna empieza por «·». Los códigos crudos del
 * courier («WRONG_ADDRESS») pueden partirse tras cada «_», para que no haga
 * falta cortarlos por cualquier letra.
 */
const DOT = "\u00a0· ";
const keepDots = (text: string) => text.replace(/ · /g, DOT).replace(/_/g, "_\u200b");

/** Cada cuánto se pregunta por las llamadas del agente en curso. */
const LIVE_POLL_MS = 5_000;
/** Al terminar una llamada se recarga la cola, pero no más de una vez en este lapso. */
const LIVE_REFRESH_MIN_MS = 15_000;

/**
 * «Llamando ahora» (MOM §11.8): las llamadas del agente abiertas, sondeadas
 * mientras la pestaña se ve. Cuando una termina, la cola se recarga para que
 * la fila salga con la gestión que el agente acaba de registrar.
 */
function useLiveVoiceCalls(enabled: boolean): LiveVoiceCall[] {
  const router = useRouter();
  const [calls, setCalls] = useState<LiveVoiceCall[]>([]);
  useEffect(() => {
    if (!enabled) {
      setCalls([]);
      return;
    }
    let alive = true;
    let inFlight = false;
    let signature = "";
    let openOrders = new Set<string>();
    let lastRefresh = 0;
    let pendingRefresh = false;
    const check = async () => {
      if (inFlight || document.hidden) return;
      inFlight = true;
      try {
        const next = await loadLiveVoiceCalls().catch(() => null);
        if (!alive || next === null) return;
        const nextSignature = liveSignature(next);
        const nextOrders = new Set(next.map((c) => c.orderId));
        // Terminó una llamada: su pedido ya no está entre las abiertas.
        const ended = [...openOrders].some((id) => !nextOrders.has(id));
        openOrders = nextOrders;
        if (nextSignature !== signature) {
          signature = nextSignature;
          setCalls(next);
        }
        if (ended) pendingRefresh = true;
        if (pendingRefresh && Date.now() - lastRefresh >= LIVE_REFRESH_MIN_MS) {
          pendingRefresh = false;
          lastRefresh = Date.now();
          router.refresh();
        }
      } finally {
        inFlight = false;
      }
    };
    void check();
    const timer = setInterval(() => void check(), LIVE_POLL_MS);
    const onVisible = () => {
      if (!document.hidden) void check();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      alive = false;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [enabled, router]);
  return calls;
}

/**
 * La nota de la fila en llamada. Lleva su propio reloj: el tiempo corre cada
 * segundo sin repintar la tabla entera. Hablando, el par `ok` con el punto que
 * late (quieto con movimiento reducido); marcando, el par `info`.
 */
function LiveCallChip({ call, className }: { call: LiveVoiceCall; className?: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(id);
  }, []);
  const talking = call.phase === "in_progress";
  return (
    <span
      className={cn(
        "w-fit items-center gap-1.5 whitespace-nowrap rounded px-1.5 py-0.5 font-sans text-xs font-medium",
        talking ? "bg-ok-bg text-ok-fg" : "bg-info-bg text-info-fg",
        className,
      )}
      title={talking ? `${call.agent} está hablando con la clienta` : `${call.agent} está marcando`}
    >
      <span className="relative flex size-2 shrink-0" aria-hidden>
        {talking && (
          <span className="absolute inline-flex size-full rounded-full bg-ok-fg opacity-50 motion-safe:animate-ping" />
        )}
        <span className={cn("relative inline-flex size-2 rounded-full", talking ? "bg-ok-fg" : "bg-info-fg")} />
      </span>
      {talking ? "Llamando" : "Marcando"} · {call.agent}
      <span className="tabular-nums">{liveElapsed(call.since, now)}</span>
    </span>
  );
}

/** Llamadas en curso cuyo pedido no está en la lista: lo dice, con un atajo para buscarlo. */
function LiveOffscreenNotice({ calls, onFind }: { calls: LiveVoiceCall[]; onFind: (orderName: string) => void }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t border-line bg-info-wash px-4 py-2.5 text-sm text-ink-700 sm:px-5">
      {calls.map((c) => (
        <span key={c.orderId} className="flex flex-wrap items-center gap-2">
          <LiveCallChip call={c} className="inline-flex" />
          <span>
            {c.orderName ?? "Un pedido"} no aparece con los filtros actuales.
          </span>
          {c.orderName && (
            <button
              type="button"
              onClick={() => onFind(c.orderName!)}
              className="rounded-sm text-sm font-medium text-brand-700 underline-offset-2 hover:underline pointer-coarse:min-h-11"
            >
              Buscarlo
            </button>
          )}
        </span>
      ))}
    </div>
  );
}

// Memoizada: con `rows` y `storeName` estables, escribir en el buscador, abrir
// el cajón o renovar la reserva ya no repinta la tabla.
const ShipmentTable = memo(function ShipmentTable({
  rows: sortedRows,
  stores,
  storeName,
  onOpen,
  highlightedId,
  cursorId,
  claimedBy,
  liveFor,
  sort,
  onSort,
  showRoute,
}: {
  /** YA ORDENADAS. El orden lo decide el tablero, que es quien sabe cuál es la
   *  «siguiente» guía de la cola (ver `queueOrder`). */
  rows: ShipmentRow[];
  stores: StoreSummary[];
  storeName: (id: string) => string;
  onOpen: (id: string) => void;
  highlightedId?: string | null;
  /** La fila señalada por el teclado (`j`/`k`). */
  cursorId?: string | null;
  /** Quién tiene tomada cada guía, para no abrir una que ya está ocupada. */
  claimedBy: (row: ShipmentRow) => string | null;
  /** La llamada del agente en curso sobre el pedido de la fila, si hay. */
  liveFor: (row: ShipmentRow) => LiveVoiceCall | null;
  sort: ShipmentSort;
  onSort: (key: ShipmentSortKey) => void;
  /** La columna Ruta, solo donde decide algo: Pendiente y la búsqueda. */
  showRoute: boolean;
}) {
  // La ventana vuelve al principio cuando cambian las filas (otro filtro, otra
  // pestaña, una recarga): lo que se pidió ver fue de ESE conjunto.
  const [visibleCount, setVisibleCount] = useState(VISIBLE_STEP);
  const [windowFor, setWindowFor] = useState(sortedRows);
  if (windowFor !== sortedRows) {
    setWindowFor(sortedRows);
    setVisibleCount(VISIBLE_STEP);
  }
  // La fila recién actualizada se ve aunque caiga fuera de la ventana: es la
  // que la persona acaba de tocar.
  const highlightedIndex = highlightedId ? sortedRows.findIndex((r) => r.id === highlightedId) : -1;
  const shownCount = Math.min(sortedRows.length, Math.max(visibleCount, highlightedIndex + 1));
  const shownRows = shownCount < sortedRows.length ? sortedRows.slice(0, shownCount) : sortedRows;
  const hiddenCount = sortedRows.length - shownRows.length;
  const toggleSort = onSort;
  const multiStore = stores.length > 1;

  // Anchos de columna (tabla fija), medidos sobre el texto real para que cada
  // celda quepa en dos renglones: la chapa «Aliclik disponible» (100 px),
  // «Reproprovincia» (87), «Sin gestión» (69) y el encabezado «Programación»
  // (99) mandan en sus columnas; el motivo entra entero en dos renglones desde
  // 1.440 px y el destino conserva la ciudad. El que cede es el cliente, que
  // se recorta con su nombre en el `title`.
  const w = showRoute
    ? { guia: "w-[13.5%]", cliente: "w-[10.5%]", destino: "w-[16%]", motivo: "w-[15%]", estado: "w-[10.5%]", ruta: "w-[13.5%]", gestion: "w-[9%]", prog: "w-[12%]" }
    : { guia: "w-[14%]", cliente: "w-[13%]", destino: "w-[18%]", motivo: "w-[18%]", estado: "w-[14%]", ruta: "", gestion: "w-[10%]", prog: "w-[13%]" };

  return (
    <div>
      {/* ONCE COLUMNAS NO ENTRABAN EN UN PORTÁTIL: la tabla pedía 1.400 px y
          scrolleaba de lado. Ahora son ocho celdas de dos renglones en una
          tabla fija que cabe desde 1.280 px —la guía con su pedido y tienda, el
          cliente con su celular, el destino con la disponibilidad Swayp, la
          programación con la fecha Aliclik—, y por debajo la cola es una lista. */}
      <div className="hidden xl:block">
        <table className="w-full table-fixed border-separate border-spacing-0 text-sm">
          <thead>
            <tr>
              <SortableShipmentHeader label="Guía" sortKey="guide" also={{ label: "Pedido", sortKey: "order" }} sort={sort} onSort={toggleSort} className={cn(w.guia, FIRST_X)} />
              <SortableShipmentHeader label="Cliente" sortKey="customer" sort={sort} onSort={toggleSort} className={cn(w.cliente, CELL_X)} />
              <SortableShipmentHeader label="Destino" sortKey="location" sort={sort} onSort={toggleSort} className={cn(w.destino, CELL_X)} />
              {/* MOTIVO ANTERIOR EN LUGAR DE PRODUCTO. El MOM §11 manda revisar
                  cómo terminó el intento anterior antes de reenviar —«si el
                  cliente vio el producto y aun así lo rechazó, normalmente no
                  reenviar»— y esa etiqueta no se pintaba en ningún sitio. El
                  producto sigue en el cajón, que es donde se confirma. */}
              <SortableShipmentHeader label="Motivo anterior" sortKey="reason" sort={sort} onSort={toggleSort} className={cn(w.motivo, CELL_X)} />
              <SortableShipmentHeader label="Estado" sortKey="status" sort={sort} onSort={toggleSort} className={cn(w.estado, CELL_X)} />
              {showRoute && (
                <SortableShipmentHeader label="Ruta" sortKey="route" sort={sort} onSort={toggleSort} className={cn(w.ruta, CELL_X)} />
              )}
              <SortableShipmentHeader label="Gestión" sortKey="lastGestion" sort={sort} onSort={toggleSort} className={cn(w.gestion, CELL_X)} />
              <SortableShipmentHeader label="Programación" sortKey="reprogramming" also={{ label: "Aliclik", sortKey: "lastDelivery" }} sort={sort} onSort={toggleSort} className={cn(w.prog, LAST_X)} />
            </tr>
          </thead>
          <tbody>
            {shownRows.map((s) => (
              <tr
                key={s.id}
                id={`shipment-row-${s.id}`}
                // SELECCIONAR UN TELÉFONO NO DEBE ABRIR —Y RESERVAR— LA GUÍA. El
                // clic en la fila la abre y la toma diez minutos; arrastrar para
                // copiar un número terminaba el gesto en un clic y bloqueaba la
                // guía para el resto del equipo sin que nadie quisiera abrirla.
                onClick={() => {
                  if (window.getSelection()?.toString()) return;
                  onOpen(s.id);
                }}
                className={cn(
                  "group/row cursor-pointer transition-colors duration-500 motion-reduce:transition-none",
                  highlightedId === s.id
                    ? "bg-ok-wash"
                    : cursorId === s.id
                      ? "bg-brand-50"
                      : liveFor(s)
                        ? "bg-info-wash"
                        : "hover:bg-wash",
                )}
              >
                <td className={cn(TD, FIRST_X)}>
                  {/* La fila entera abre con el ratón; el código es lo que abre
                      con el teclado. Sin este botón la cola no se podía trabajar
                      sin ratón: ninguna guía era alcanzable con Tab. */}
                  <button
                    type="button"
                    id={`shipment-open-${s.id}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      onOpen(s.id);
                    }}
                    className="max-w-full truncate rounded-sm align-middle font-mono text-[13px] font-medium leading-5 text-ink-900 underline-offset-2 hover:underline"
                  >
                    {s.guide_code}
                  </button>
                  {/* La etiqueta de courier abre la segunda línea: junto al
                      código partía la celda en tres renglones. */}
                  <p
                    className={cn(SUBLINE, "flex min-w-0 items-center gap-1.5")}
                    title={multiStore ? storeName(s.store_id) : undefined}
                  >
                    {s.courier === "fenix" && <Badge className="shrink-0">Swayp</Badge>}
                    {s.created_via === "fenix_directo" && <Badge className="shrink-0">Directa</Badge>}
                    {/* El pedido manda: es lo que identifica la fila. Si no
                        cabe, se recorta la tienda, que también filtra arriba. */}
                    <span className="truncate">
                      <OrderNameLabel name={s.order_name} matched={s.matched} />
                      {multiStore && <> · {storeName(s.store_id)}</>}
                    </span>
                  </p>
                  {/* La llamada del agente en curso: la fila va primera y lo dice. */}
                  {(() => {
                    const live = liveFor(s);
                    return live ? <LiveCallChip call={live} className="mt-1 flex" /> : null;
                  })()}
                </td>
                <td className={cn(TD, CELL_X)}>
                  <p className="truncate leading-5 text-ink-900" title={s.customer_name ?? undefined}>
                    {s.customer_name ?? "—"}
                  </p>
                  {s.customer_phone && <p className={cn(SUBLINE, "truncate tabular-nums")}>{s.customer_phone}</p>}
                </td>
                <td className={cn(TD, CELL_X)}>
                  {/* El distrito solo arriba; abajo la ciudad (o el
                      departamento) y la disponibilidad Swayp. Si no cabe, cede
                      primero la ciudad y después la disponibilidad. */}
                  <p className="truncate leading-5 text-ink-900" title={s.district ?? undefined}>
                    {s.district ?? "—"}
                  </p>
                  <p
                    className={cn(SUBLINE, "flex min-w-0")}
                    title={placeLine(s) ? `${placeLine(s)} · ${fenixAvailabilityText(s)}` : fenixAvailabilityText(s)}
                  >
                    {placeLine(s) && (
                      <>
                        <span className="min-w-[4ch] shrink-[999] truncate capitalize">{placeLine(s)}</span>
                        {/* El punto va aparte, para que la ciudad al
                            recortarse no se lo lleve; espacios duros, porque
                            al borde de un hijo de flex el normal se pierde. */}
                        <span className="shrink-0">{"\u00a0·\u00a0"}</span>
                      </>
                    )}
                    <span className="min-w-0 truncate">
                      <FenixAvailabilityInline shipment={s} lead={false} />
                    </span>
                  </p>
                </td>
                <td className={cn(TD, CELL_X)}>
                  {(() => {
                    const m = motivoParaMostrar(s);
                    if (!m) return <span className={SUBLINE}>—</span>;
                    return (
                      <p
                        title={m.texto}
                        className={cn(
                          "line-clamp-2 break-words text-[13px] leading-5",
                          !m.consta ? "text-ink-500" : m.vioElProducto ? "font-medium text-crit-fg" : "text-ink-700",
                        )}
                      >
                        {keepDots(m.texto)}
                      </p>
                    );
                  })()}
                </td>
                <td className={cn(TD, CELL_X)}>
                  <StatusBadge category={s.status_category} status={s.delivery_status} />
                  {/* La segunda mitad del estado (MOM), entera bajo la chapa. */}
                  {subState(s) && <p className={SUBLINE}>{subState(s)}</p>}
                </td>
                {showRoute && (
                  <td className={cn(TD, CELL_X)}>
                    <AliclikRouteCell shipment={s} />
                  </td>
                )}
                <td className={cn(TD, CELL_X)}>
                  {(() => {
                    const g = fmtLastGestion(s.last_gestion_at);
                    return (
                      <>
                        <p
                          className={cn(
                            "whitespace-nowrap leading-5 tabular-nums",
                            g.days == null ? "text-ink-500" : "text-ink-900",
                          )}
                        >
                          {g.label}
                        </p>
                        {/* Quién la tiene, antes de abrirla: se descubría al
                            entrar, con el cajón ya bloqueado. Es la gestión de
                            ahora, así que ocupa el lugar de la antigüedad. */}
                        {claimedBy(s) && (
                          <p className="text-[13px] font-medium leading-5 text-warn-fg">{claimedBy(s)}</p>
                        )}
                        {!claimedBy(s) && g.days != null && (
                          <p className={cn(SUBLINE, "tabular-nums", g.days >= 7 && "font-semibold text-warn-fg")}>
                            {g.days === 0 ? "hoy" : `hace ${g.days} d`}
                          </p>
                        )}
                      </>
                    );
                  })()}
                </td>
                <td className={cn(TD, LAST_X)}>
                  <p className="leading-5 tabular-nums text-ink-900">{fmtReprogram(s.next_followup_at)}</p>
                  {highlightedId === s.id ? (
                    <p className="text-[13px] font-semibold leading-5 text-ok-fg">Actualizado</p>
                  ) : (
                    // El encabezado dice «Aliclik» bajo «Programación»: la
                    // segunda fecha es esa. Con la palabra no cabía en un renglón.
                    s.aliclik_service_date && (
                      <p className={cn(SUBLINE, "tabular-nums")} title="Fecha Aliclik">
                        <span className="sr-only">Fecha Aliclik </span>
                        {fmtAliclikDate(s.aliclik_service_date)}
                      </p>
                    )
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* POR DEBAJO DE 1.280 PX LA COLA ES UNA LISTA, no una tabla apretada.
          Cada fila lleva lo que hace falta para decidir a quién llamar —guía,
          estado, cliente, destino, motivo, programación, ruta— y un botón
          «Llamar» con `tel:` al alcance del pulgar: en el celular la llamada se
          hace desde el mismo aparato. Desde 640 px, en dos columnas: quién y
          adónde a la izquierda; cómo está y qué decide la llamada a la derecha.
          Misma ventana de 200 filas y mismo orden que la tabla. */}
      <ul className="divide-y divide-line border-t border-line xl:hidden">
        {shownRows.map((s) => {
          const gestion = fmtLastGestion(s.last_gestion_at);
          const m = motivoParaMostrar(s);
          return (
            <li
              key={s.id}
              className={cn(
                "flex items-start gap-3 px-4 py-3 sm:px-5",
                highlightedId === s.id ? "bg-ok-wash" : liveFor(s) && "bg-info-wash",
              )}
            >
              <button
                type="button"
                onClick={() => onOpen(s.id)}
                className="grid min-w-0 flex-1 gap-x-6 gap-y-1 rounded-md text-left sm:grid-cols-2"
              >
                <span className="block min-w-0">
                  {/* El N° de pedido y la tienda existían solo en la tabla: en
                      teléfono no había forma de saber de qué pedido se hablaba
                      ni, con varias tiendas, de cuál era. Van junto a la guía. */}
                  <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="font-mono text-[13px] font-medium text-ink-900">{s.guide_code}</span>
                    {s.courier === "fenix" && <Badge>Swayp</Badge>}
                    {s.created_via === "fenix_directo" && <Badge>Directa</Badge>}
                    <span className={SUBLINE}>
                      <OrderNameLabel name={s.order_name} matched={s.matched} />
                      {multiStore && ` · ${storeName(s.store_id)}`}
                    </span>
                  </span>
                  {(() => {
                    const live = liveFor(s);
                    return live ? <LiveCallChip call={live} className="my-1 flex" /> : null;
                  })()}
                  <span className="block text-sm font-medium leading-5 text-ink-900">{s.customer_name ?? "—"}</span>
                  <span className={cn(SUBLINE, "block")}>
                    {s.district ?? "—"}
                    {placeLine(s) && (
                      <>
                        {DOT}
                        <span className="capitalize">{placeLine(s)}</span>
                      </>
                    )}
                    <FenixAvailabilityInline shipment={s} />
                  </span>
                </span>
                <span className="block min-w-0">
                  <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <StatusBadge category={s.status_category} status={s.delivery_status} suffix={subState(s)} />
                    {claimedBy(s) && (
                      <span className="text-[13px] font-medium text-warn-fg">{claimedBy(s)}</span>
                    )}
                  </span>
                  {m && (
                    <span
                      className={cn(
                        "block text-[13px] leading-5",
                        m.vioElProducto ? "font-medium text-crit-fg" : "text-ink-500",
                      )}
                    >
                      {keepDots(m.texto)}
                    </span>
                  )}
                  {s.courier === "aliclik" && s.status_category === "pending" && (
                    <span className="mt-1 block">
                      <AliclikRouteCell shipment={s} inline />
                    </span>
                  )}
                  <span className={cn(SUBLINE, "block tabular-nums")}>
                    Programación {fmtReprogram(s.next_followup_at)}
                    {gestion.days != null && (
                      <span className={gestion.days >= 7 ? "font-semibold text-warn-fg" : ""}>
                        {DOT}última gestión {gestion.days === 0 ? "hoy" : `hace ${gestion.days} d`}
                      </span>
                    )}
                    {highlightedId === s.id && <span className="ml-2 font-semibold text-ok-fg">Actualizado</span>}
                  </span>
                </span>
              </button>
              {s.customer_phone && (
                <a
                  href={`tel:${s.customer_phone.replace(/[^\d+]/g, "")}`}
                  className={opsButtonClass("secondary", "sm", "shrink-0 pointer-coarse:h-11")}
                >
                  <IconPhone className="text-ink-500" />
                  Llamar
                </a>
              )}
            </li>
          );
        })}
      </ul>
      {hiddenCount > 0 && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-line px-4 py-2.5 text-[13px] text-ink-500 sm:px-5">
          {/* Decía «Se muestran X de Y» a una pantalla del otro contador, que
              dice lo mismo con otro denominador: uno cuenta lo que pasa los
              filtros, este cuenta lo que cabe en la ventana. Ahora se distinguen
              por la frase, no por recordar cuál era cuál. */}
          <span className="tabular-nums">
            Cargadas las primeras {shownRows.length} de {sortedRows.length} filas.
          </span>
          <OpsButton variant="ghost" size="sm" onClick={() => setVisibleCount((n) => n + VISIBLE_STEP)} className="pointer-coarse:h-11">
            Mostrar {Math.min(VISIBLE_STEP, hiddenCount)} más
          </OpsButton>
          {hiddenCount > VISIBLE_STEP && (
            <OpsButton variant="ghost" size="sm" onClick={() => setVisibleCount(sortedRows.length)} className="pointer-coarse:h-11">
              Mostrar todas
            </OpsButton>
          )}
        </div>
      )}
    </div>
  );
});

/** Flecha de orden, dibujada: arriba, abajo, o las dos cuando la columna no ordena. */
function SortGlyph({ direction }: { direction: ShipmentSortDirection | null }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="size-3.5 shrink-0">
      {direction === "asc" ? (
        <path d="M5 9.5 8 6.5l3 3" />
      ) : direction === "desc" ? (
        <path d="M5 6.5 8 9.5l3-3" />
      ) : (
        <path d="M5.5 6 8 3.5 10.5 6M5.5 10 8 12.5 10.5 10" />
      )}
    </svg>
  );
}

function SortButton({
  label,
  sortKey,
  sort,
  onSort,
  secondary,
}: {
  label: string;
  sortKey: ShipmentSortKey;
  sort: ShipmentSort;
  onSort: (key: ShipmentSortKey) => void;
  /** El orden de la segunda línea: más quieto que el de la primera. */
  secondary?: boolean;
}) {
  const direction = sort?.key === sortKey ? sort.direction : null;
  return (
    <button
      type="button"
      onClick={() => onSort(sortKey)}
      className={cn(
        "group -mx-1 inline-flex h-5 items-center gap-1 whitespace-nowrap rounded px-1 transition-colors hover:bg-wash hover:text-ink-900 pointer-coarse:h-11",
        direction ? "text-brand-700" : secondary && "font-medium text-ink-500",
      )}
    >
      {label}
      <span className={direction ? "text-brand-600" : "text-ink-300 group-hover:text-ink-500"}>
        <SortGlyph direction={direction} />
      </span>
    </button>
  );
}

/**
 * Encabezado que ordena. `also` es un segundo orden en la misma columna, para
 * el dato de la segunda línea, y va debajo como en la celda: «Guía» sobre
 * «Pedido», «Programación» sobre «Aliclik».
 */
function SortableShipmentHeader({
  label,
  sortKey,
  sort,
  onSort,
  className,
  also,
}: {
  label: string;
  sortKey: ShipmentSortKey;
  sort: ShipmentSort;
  onSort: (key: ShipmentSortKey) => void;
  className?: string;
  also?: { label: string; sortKey: ShipmentSortKey };
}) {
  const active = sort != null && (sort.key === sortKey || sort.key === also?.sortKey);
  const ariaSort = active ? (sort.direction === "asc" ? "ascending" : "descending") : "none";
  return (
    <th scope="col" aria-sort={ariaSort} className={cn(TH, className)}>
      <span className="flex flex-col items-start">
        <SortButton label={label} sortKey={sortKey} sort={sort} onSort={onSort} />
        {also && <SortButton label={also.label} sortKey={also.sortKey} sort={sort} onSort={onSort} secondary />}
      </span>
    </th>
  );
}

const ROUTE_BLOCKED: Partial<Record<AliclikRescheduleReason, string>> = {
  three_attempts: `${ALICLIK_MAX_INTENTOS} intentos alcanzados`,
  outside_week: "Fuera de la ventana operativa",
  missing_attempts: "Sin NRO. INTENTOS en Excel",
  missing_service_date: "Sin Fecha Aliclik en el Excel",
};

/**
 * El veredicto de la ruta: ¿todavía entra por Aliclik o tiene que salir por
 * Swayp? La chapa y su porqué en un renglón cada uno (tabla) o los dos en uno
 * (`inline`, la lista); el porqué se recorta y el `title` lo dice entero.
 */
function AliclikRouteCell({ shipment, inline = false }: { shipment: ShipmentRow; inline?: boolean }) {
  if (shipment.courier !== "aliclik" || shipment.status_category !== "pending") {
    return <span className={SUBLINE}>—</span>;
  }
  const decision = evaluateAliclikReschedule({
    courier: shipment.courier,
    attempts: shipment.aliclik_attempts,
    serviceDate: shipment.aliclik_service_date,
  });
  const reason = decision.eligible
    ? `${shipment.aliclik_attempts ?? 0}/${ALICLIK_MAX_INTENTOS} intentos · dentro de ventana`
    : (ROUTE_BLOCKED[decision.reason] ?? "Aliclik no disponible");
  return (
    <span className={inline ? "flex min-w-0 items-center gap-2" : "block min-w-0"}>
      {decision.eligible ? (
        <Badge tone="ok" className="shrink-0">Aliclik disponible</Badge>
      ) : (
        <Badge tone="warn" className="shrink-0">Swayp requerido</Badge>
      )}
      <span className={cn(SUBLINE, "truncate", !inline && "block")} title={reason}>
        {keepDots(reason)}
      </span>
    </span>
  );
}

/**
 * Lo que acompaña al distrito: la ciudad de cobertura Swayp o, si repite el
 * distrito («Juliaca · juliaca»), el departamento; nada si también lo repite
 * («Ica · Ica»).
 */
function placeLine(s: Pick<ShipmentRow, "district" | "city" | "region">): string {
  const repeats = (v: string) =>
    Boolean(s.district) && v.localeCompare(s.district ?? "", "es", { sensitivity: "base" }) === 0;
  if (s.city && !repeats(s.city)) return s.city;
  const department = normalizeDepartment(s.region) || "";
  return department && !repeats(department) ? department : "";
}

/**
 * Si Swayp puede llevarla: con stock, sin stock o fuera de cobertura. El texto
 * no se parte entre líneas; con `lead`, va tras « · » pegado a lo anterior.
 */
function fenixAvailabilityText(shipment: ShipmentRow): string {
  const reason = currentFenixReason(shipment);
  return reason === "ok" ? "Swayp ok" : reason === "sin_stock" ? "Sin stock Swayp" : "Fuera de cobertura";
}

function FenixAvailabilityInline({ shipment, lead = true }: { shipment: ShipmentRow; lead?: boolean }) {
  const reason = currentFenixReason(shipment);
  const text = fenixAvailabilityText(shipment);
  const tone = reason === "ok" ? "text-ok-fg" : reason === "sin_stock" ? "text-warn-fg" : "text-crit-fg";
  return (
    <>
      {lead && DOT}
      <span className={cn("whitespace-nowrap font-medium", tone)}>{text}</span>
    </>
  );
}

function ShipmentDrawer({
  shipmentId,
  onClose,
  onOpenShipment,
  onShipmentUpdated,
  nextShipmentId,
}: {
  shipmentId: string;
  onClose: () => void;
  onOpenShipment: (id: string) => void;
  onShipmentUpdated: (id: string) => void | Promise<void>;
  /** La siguiente guía en el orden que se está viendo, para no volver a la tabla. */
  nextShipmentId?: string | null;
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
  const [claimState, setClaimState] = useState<"idle" | "claiming" | "mine" | "blocked">("idle");
  const [claimMessage, setClaimMessage] = useState<string | null>(null);
  /** Reserva pedida por la persona al tocar un control, no por el hecho de mirar. */
  const [claimRequested, setClaimRequested] = useState(false);
  const claimSessionRef = useRef<{
    shipmentId: string;
    shouldRelease: boolean;
  } | null>(null);
  // Semántica de diálogo: el foco entra al abrir, Escape cierra y el foco
  // vuelve a donde estaba (la fila) al cerrar. Sin esto, con teclado el panel
  // se abría detrás del foco y no había forma de salir.
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<() => void>(() => undefined);
  /** La guía cuyo detalle está pintado: distingue «otra guía» de «la misma, recargada». */
  const loadedIdRef = useRef<string | null>(null);
  const [reloading, setReloading] = useState(false);
  /** El aviso de la última acción, para llevarle el foco cuando aparece. */
  const feedbackRef = useRef<HTMLParagraphElement>(null);

  // form state
  const [disposition, setDisposition] = useState<RerouteDisposition>("confirma");
  const [note, setNote] = useState("");
  const [nextDate, setNextDate] = useState("");
  const [courierResult, setCourierResult] = useState<CourierReportResult | "">("");
  const [courierDate, setCourierDate] = useState("");
  const [courierNote, setCourierNote] = useState("");
  const [showCourierCorrection, setShowCourierCorrection] = useState(false);
  const [fenixGuide, setFenixGuide] = useState("");
  // Fecha PROPIA del formulario manual: no comparte estado con la llamada.
  const [manualGuideDate, setManualGuideDate] = useState("");
  const [showManualGuide, setShowManualGuide] = useState(false);
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
  // Segundo paso del descarte: nombra el pedido antes de cerrarlo.
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  // Segundo paso de «Cliente cancela / anula»: cierra la venta.
  const [confirmCancel, setConfirmCancel] = useState(false);
  // Segundo paso del resultado del courier que ANULA la guía: también cierra la
  // venta, y pedía un solo clic.
  const [confirmCourierClose, setConfirmCourierClose] = useState(false);
  // Salida pedida (cerrar o saltar a otra guía) que espera confirmación porque
  // hay texto sin registrar.
  const [pendingExit, setPendingExit] = useState<{ kind: "close" } | { kind: "open"; id: string } | null>(null);

  const [reloadKey, setReloadKey] = useState(0);

  /**
   * MIRAR NO ES TRABAJAR: la reserva se pide cuando el cajón puede actuar.
   *
   * Se pedía al abrir, sin mirar el estado ni la pestaña, y dura diez minutos
   * (`CLAIM_TTL_MINUTES`). Auditar veinte guías Entregado a las cinco de la
   * tarde las bloqueaba para quien sí estaba trabajando la cola —en un cajón
   * que para esas guías se reduce a la ficha del cliente y el historial—, y el
   * resto del equipo veía «Tomada» en guías que nadie estaba atendiendo.
   *
   * Con una guía sobre la que hay algo que registrar se reserva al abrir, igual
   * que antes. Con una terminal se entra en solo lectura y la reserva se pide
   * sola en cuanto la persona toca un control: el historial sigue editable, sin
   * cobrarle diez minutos al equipo por leerlo.
   */
  const drawerStatus = detail && !("error" in detail) ? detail.shipment.delivery_status : null;
  const eagerClaim = drawerStatus != null && (isCallable(drawerStatus) || drawerStatus === "anulado");
  const shouldClaim = eagerClaim || claimRequested;

  useEffect(() => {
    if (!shouldClaim) return;
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
  }, [shipmentId, shouldClaim]);

  // La respuesta de una acción —y la reserva pedida a mano— pertenecen a la
  // guía en la que se hicieron.
  useEffect(() => {
    setFeedback(null);
    setClaimRequested(false);
    setClaimState("idle");
  }, [shipmentId]);

  // Al aparecer un aviso, el foco va a él: se ve esté donde esté el scroll y un
  // lector de pantalla lo lee sin que la persona lo busque.
  useEffect(() => {
    if (!feedback) return;
    feedbackRef.current?.focus();
  }, [feedback]);

  useDialogKeys(panelRef, () => closeRef.current());

  useEffect(() => {
    let alive = true;
    // RECARGAR NO ES VOLVER A EMPEZAR. Tras cada acción, `refresh()` ponía
    // `detail` en null y el cajón entero se reemplazaba por «Cargando…»: el
    // formulario que la asesora acababa de enviar desaparecía y volvía vacío,
    // sin decir si se había guardado. Al recargar la MISMA guía se conserva lo
    // que hay, atenuado, hasta que llega el dato nuevo.
    const sameGuide = loadedIdRef.current === shipmentId;
    if (sameGuide) {
      setReloading(true);
    } else {
      setDetail(null);
      setShowAddressEditor(false);
    }
    setPendingExit(null);
    setConfirmCancel(false);
    setConfirmDiscard(false);
    setConfirmCourierClose(false);
    loadShipmentDetail(shipmentId)
      .catch(() => ({
        error: "No pudimos cargar este envío. Revisa la conexión e inténtalo de nuevo.",
      }))
      .then((d) => {
      if (!alive) return;
      loadedIdRef.current = shipmentId;
      setDetail(d);
      setReloading(false);
      if (d && !("error" in d)) {
        setCourierResult("");
        setCourierDate("");
        setCourierNote("");
        setShowCourierCorrection(false);
        setConfirmCourierClose(false);
        setShowCancelledException(false);
        setCancelledExceptionDate("");
        setCancelledExceptionNote("");
        // Sin número de pedido no hay autogeneración: el formulario manual es
        // el camino obligado y se abre solo. Con pedido, queda plegado.
        setManualGuideDate("");
        setShowManualGuide(!effectiveOrderName(d.shipment.order_name, d.order?.name));
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
    setReloadKey((k) => k + 1);
  }

  function releaseCurrentClaim() {
    const session = claimSessionRef.current;
    if (!session) return;
    session.shouldRelease = true;
    void releaseShipment(session.shipmentId).catch(() => undefined);
  }

  /**
   * Lo que se perdería al cerrar: texto escrito que todavía no se registró.
   *
   * El cajón se cerraba con un clic en el fondo o con Escape y se llevaba la
   * nota a medio escribir sin preguntar. En una cola de llamadas eso es lo que
   * la asesora acaba de oír por teléfono.
   */
  const draftFields = [note, courierNote, recoveryNote, cancelledExceptionNote, fenixGuide];
  const hasDraft = draftFields.some((v) => v.trim().length > 0) || showAddressEditor;

  /** Salir del cajón: cerrarlo, o saltar a otra guía. Las dos pierden el borrador. */
  function requestExit(exit: { kind: "close" } | { kind: "open"; id: string }) {
    if (hasDraft) {
      setPendingExit(exit);
      panelRef.current?.focus();
      return;
    }
    doExit(exit);
  }
  function doExit(exit: { kind: "close" } | { kind: "open"; id: string }) {
    releaseCurrentClaim();
    if (exit.kind === "open") onOpenShipment(exit.id);
    else onClose();
  }

  function handleClose() {
    requestExit({ kind: "close" });
  }
  closeRef.current = handleClose;

  function handleOpenShipment(id: string) {
    requestExit({ kind: "open", id });
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

  // Tanto «programar» como «confirma» necesitan una fecha FUTURA: la primera
  // agenda una llamada, la segunda estampa la fecha en el número de la guía
  // nueva y programa el despacho. Un `<input type=date>` con `min` no basta:
  // se puede teclear la fecha a mano y el atributo no lo impide.
  const dateNeedsFuture = disposition === "programar" || disposition === "confirma";
  const programDateInvalid = dateNeedsFuture && (!nextDate || nextDate <= localDateInputValue());
  // La guía a mano acuña por la MISMA `rescheduleGuideCode` que «confirma», así
  // que tiene la misma exigencia. Estaba sin `min`, sin entrar en el `disabled`
  // y sin guarda en el servidor: era la segunda puerta de la regla del MOM
  // §11.6, y era la que el cajón abre a la fuerza cuando el envío no tiene N° de
  // pedido —justo cuando nadie mira con cuidado.
  const manualGuideDateInvalid = !manualGuideDate || manualGuideDate <= localDateInputValue();
  // MISMA función que la reja del servidor, para que el botón no invite a algo
  // que la acción va a rechazar.
  const numeroManualNoEsDeSwayp = !!fenixGuide.trim() && !esNumeroDeGuiaSwayp(fenixGuide);
  // «Cliente cancela / anula» cierra la venta: pide un segundo clic que la
  // nombre, igual que el descarte de la recuperación.
  const cancelNeedsConfirm = disposition === "cancela";
  const shipment = detail && !("error" in detail) ? detail.shipment : null;
  // Con los intentos agotados, un «No contesta» más anula la guía
  // (`nextShipmentTransition`). El cajón lo dice antes de registrarlo.
  const lastAttemptWillCancel =
    disposition === "no_contesta" &&
    shipment?.delivery_status === "pendiente" &&
    (shipment.reroute_attempts ?? 0) >= MAX_INTENTOS;
  const fenixReason = shipment ? currentFenixReason(shipment) : null;
  const fenixDeliverySchedule = shipment
    ? getFenixDeliverySchedule(shipment.city, shipment.district)
    : null;
  // 6 Novedad y 8 Devolución: los dos estados en los que Swayp todavía acepta
  // una instrucción. Sin guía de Swayp no hay nada que responder — una guía
  // manual se gestiona por teléfono, como siempre.
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
  // Swayp se evalúa con el dato malo — antes solo se cazaba a ojo. Si ya se
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
  /**
   * Productos sin vínculo de codbar con Swayp. Sin vínculo no hay guía (regla de
   * la operación, 16-09-2026), así que apagan TODOS los botones que paren una:
   * la reprogramación confirmada, el reenvío de una guía anulada y el alta con
   * número escrito a mano. El servidor vuelve a comprobarlo en
   * `spinOffFenixGuide`; esto es para que nadie lo descubra con la clienta al
   * teléfono.
   */
  const swaypUnlinked = detail && !("error" in detail) ? detail.swaypUnlinked : [];
  const swaypSinCodbar = swaypUnlinked.length > 0;
  const swaypSinCodbarAviso = swaypSinCodbar
    ? `Swayp no tiene ${swaypUnlinked.length === 1 ? "este producto" : "estos productos"} en su catálogo: ${swaypUnlinked.join(", ")}. ${swaypUnlinked.length === 1 ? "Vincúlalo" : "Vincúlalos"} en Catálogo de productos para poder emitir la guía.`
    : null;
  const fenixRouteAvailable =
    !!shipment && (shipment.courier !== "aliclik" || shipment.fenix_eligible) && !swaypSinCodbar;
  const requiredDateMissing =
    (disposition === "confirma" && !nextDate) ||
    programDateInvalid ||
    overrideNoteMissing ||
    fenixAutoUnavailable;
  /**
   * POR QUÉ NO SE PUEDE REGISTRAR, EN TEXTO VISIBLE.
   *
   * Vivía como etiqueta del botón deshabilitado («Elige la fecha para
   * confirmar»), y un `<button disabled>` está fuera del orden de tabulación:
   * quien navega con lector de pantalla recorría el formulario entero, llegaba
   * al final y nada le decía qué faltaba. Ahora es un párrafo al lado del botón
   * y el botón lo nombra con `aria-describedby`; la etiqueta vuelve a decir la
   * acción, que es lo que un botón debe decir.
   */
  const gestionBlockReason = swaypSinCodbarAviso && reprogramProvider === "fenix"
    ? swaypSinCodbarAviso
    : fenixAutoUnavailable
    ? "Swayp no tiene cobertura o stock para este envío: registra la reprogramación como excepción manual."
    : overrideNoteMissing
      ? "Explica el motivo de la excepción antes de registrarla."
      : disposition === "confirma" && !nextDate
        ? "Elige la fecha de despacho para confirmar."
        : programDateInvalid
          ? "La fecha tiene que ser futura: va estampada en el número de la guía nueva."
          : null;
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
  /** El resultado elegido ANULA la guía, o sea cierra la venta. */
  const courierResultClosesSale =
    courierResultDefinition?.resultingStatus === "anulado" &&
    shipment?.delivery_status !== "anulado";
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
  // guía Swayp leían `shipment.order_name` por su cuenta, y arreglar uno solo
  // habría dejado el otro deshabilitado sobre el mismo envío.
  const drawerOrderName = effectiveOrderName(
    shipment?.order_name,
    detail && !("error" in detail) ? detail.order?.name : null,
  );
  // El reenvío exige N° de pedido porque el servidor lo necesita para pedirle la
  // guía a Swayp. Ya no se acuña ningún código con él —eso lo hacía
  // `rescheduleGuideCode`, y el número que salía Swayp no lo conocía— pero su
  // ausencia sigue siendo un bloqueo.
  const cancelledExceptionTienePedido = !!shipment && !!drawerOrderName;
  const cancelledExceptionDateInvalid =
    !cancelledExceptionDate || cancelledExceptionDate <= localDateInputValue();
  // Sin vínculo de codbar no hay guía, así que el reenvío tampoco: si no, el
  // botón invita y el servidor rechaza.
  const cancelledExceptionUnavailable = fenixReason !== "ok" || swaypSinCodbar;
  // ¿Hay de verdad dos rutas entre las que elegir? La excepción manual de
  // Aliclik cuenta como elección: hay que tomarla a sabiendas.
  const canForceAliclik =
    !!aliclikDecision &&
    !aliclikDecision.eligible &&
    aliclikDecision.reason !== "not_aliclik" &&
    aliclikDecision.reason !== "three_attempts";
  const showRouteChooser =
    canForceAliclik || (!!aliclikDecision?.eligible && fenixRouteAvailable);
  const cancelledExceptionReady =
    cancelledExceptionTienePedido &&
    !cancelledExceptionDateInvalid &&
    !!cancelledExceptionNote.trim() &&
    !cancelledExceptionUnavailable;

  // «No contesta» con los intentos agotados anula la guía: la opción lo dice
  // antes de elegirla, no solo el aviso de después.
  const noAnswerCancels =
    shipment?.delivery_status === "pendiente" && (shipment.reroute_attempts ?? 0) >= MAX_INTENTOS;
  /** La consecuencia de cada resultado, escrita bajo su opción. */
  const dispositionHint = (key: RerouteDisposition): string => {
    switch (key) {
      case "confirma":
        return "Vuelve a salir: eliges la ruta y la fecha.";
      case "programar":
        return "Vuelve a la cola el día que elijas. No suma intento.";
      case "no_contesta":
        return noAnswerCancels
          ? "Es el último intento: anula la guía."
          : shipment?.delivery_status === "en_ruta"
            ? "Vuelve a Pendiente con el mismo intento."
            : `Suma un intento: van ${shipment?.reroute_attempts ?? 0} de ${MAX_INTENTOS}.`;
      case "cancela":
        return "Anula la guía y el pedido pasa a cierre.";
    }
  };
  const recoveryHint: Record<RecoveryCallDisposition, string> = {
    programar: "Vuelves a llamar el día que elijas.",
    no_contesta: "Queda anotada; la recuperación sigue abierta.",
    no_quiere: "El pedido pasa a cierre con el motivo escrito.",
  };
  const statusSinceLabel =
    detail && !("error" in detail)
      ? fmtStatusSince(statusSince(detail.calls, detail.shipment.delivery_status))
      : null;
  const phone = shipment?.customer_phone ?? null;

  return (
    <div className="fixed inset-0 z-20 flex justify-end bg-ink-900/20" onClick={handleClose}>
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="shipment-drawer-title"
        tabIndex={-1}
        // La hoja recibe el foco solo para que Tab y el lector empiecen dentro;
        // no es un control, así que sin anillo (el global de globals.css va
        // fuera de capa y ganaría a una clase `outline-none`).
        style={{ outline: "none" }}
        className="h-full w-full max-w-[40rem] overflow-y-auto overscroll-contain bg-slate-50 shadow-pop"
        onClick={(e) => e.stopPropagation()}
      >
        {detail && "error" in detail ? (
          <div className="p-4 sm:p-6">
            <Banner tone="crit" role="alert" title="No se pudo abrir la guía">
              <p className="break-words">{detail.error}</p>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <OpsButton size="sm" variant="primary" onClick={refresh} className="pointer-coarse:h-11">
                  Reintentar
                </OpsButton>
                <OpsButton size="sm" variant="ghost" onClick={handleClose} className="pointer-coarse:h-11">
                  Cerrar
                </OpsButton>
              </div>
            </Banner>
          </div>
        ) : !detail ? (
          <div className="space-y-4 p-4 sm:p-6" aria-busy="true">
            <p className="sr-only">Cargando…</p>
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-40 w-full" />
            <Skeleton className="h-64 w-full" />
          </div>
        ) : (
          /* LA TAREA DEL MOMENTO VA ARRIBA. Las secciones estaban en el orden en
             que se escribieron —datos, destino con lat/long, ítems de Shopify y
             recién entonces el formulario de llamada— así que cada guía costaba
             un scroll antes de poder trabajar.

             Se arregló primero con `order-*`, dejando el JSX quieto, y el
             comentario de acá presentaba eso como la virtud: «el orden del DOM,
             y con él el recorrido de Tab, sigue siendo el de siempre». Era el
             defecto. Quien navega con teclado tenía que tabular los siete campos
             del editor de dirección y el buscador de pedidos ANTES de llegar al
             formulario de llamada que veía pegado a la cabecera (WCAG 2.4.3).
             Ahora el JSX está en el orden en que se ve: ficha, acción, destino y
             pedido, guía a mano, historial. */
          <div
            aria-busy={reloading}
            className={cn("transition-opacity motion-reduce:transition-none", reloading && "opacity-60")}
          >
            {/* La cabecera queda fija: qué guía es, en qué estado está, a quién
                se llama y cómo, y la salida —«Siguiente» o cerrar—. En teléfono
                el cajón es la pantalla entera y nada de esto puede irse con el
                scroll. Como la cabecera de la ficha del pedido. */}
            <header className="sticky top-0 z-10 border-b border-line bg-white">
              {/* Rejilla y no `order-*`: en el teléfono la «x» queda arriba a la
                  derecha y las acciones bajan a su fila; desde `sm` van en una. */}
              <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3 gap-y-2 px-4 pt-4 sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:px-6">
                <div className="col-start-1 row-start-1 min-w-0">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <h2 id="shipment-drawer-title" className="font-mono text-lg font-semibold leading-7 text-ink-900">
                      <span className="sr-only">Envío · </span>
                      {detail.shipment.guide_code}
                      <span className="sr-only"> · {labelOf(detail.shipment.delivery_status)}</span>
                    </h2>
                    <Badge
                      title={
                        detail.shipment.created_via === "fenix_directo"
                          ? "Guía Swayp directa: creada desde el pedido, sin guía Aliclik previa"
                          : undefined
                      }
                    >
                      {detail.shipment.courier === "fenix"
                        ? detail.shipment.created_via === "fenix_directo"
                          ? "Swayp · Directa"
                          : "Swayp"
                        : "Aliclik"}
                    </Badge>
                    <StatusBadge
                      category={detail.shipment.status_category}
                      status={detail.shipment.delivery_status}
                      suffix={subState(detail.shipment)}
                    />
                    {statusSinceLabel && (
                      <span className="whitespace-nowrap text-[13px] leading-5 tabular-nums text-ink-500">
                        desde {statusSinceLabel}
                      </span>
                    )}
                  </div>
                  {/* A quién se llama, con el número que se marca a un toque y
                      su «Copiar»; y desde cuándo está en este estado. El «·», el
                      número y «Copiar» parten juntos. */}
                  <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-1.5 text-[13px] leading-5 text-ink-500">
                    <span className="min-w-0 text-ink-700">{detail.shipment.customer_name ?? "Sin nombre"}</span>
                    {phone && (
                      <span className="inline-flex shrink-0 items-center gap-x-1.5 whitespace-nowrap">
                        <span aria-hidden="true">·</span>
                        <a
                          href={`tel:${phone.replace(/[^\d+]/g, "")}`}
                          className="tabular-nums text-ink-700 underline-offset-2 hover:text-brand-700 hover:underline"
                        >
                          {phone}
                        </a>
                        <CopyButton value={phone} label="el teléfono" className="justify-center pointer-coarse:size-11" />
                      </span>
                    )}
                  </div>
                </div>
                {/* EL CICLO TERMINA EN LA SIGUIENTE GUÍA, no en esta. La pantalla
                    es una cola y cada vuelta acababa en «Cerrar» y buscar otra vez
                    la fila. «Siguiente» libera la reserva de esta y toma la que
                    viene, sin pasar por la tabla. */}
                <div className="col-span-2 row-start-2 flex items-center gap-1.5 sm:col-span-1 sm:col-start-2 sm:row-start-1">
                  {phone && (
                    <>
                      <a
                        href={`tel:${phone.replace(/[^\d+]/g, "")}`}
                        title="Llamar al cliente"
                        aria-label="Llamar al cliente"
                        className={opsButtonClass("secondary", "sm", "pointer-coarse:h-11 pointer-coarse:min-w-11")}
                      >
                        <IconPhone aria-hidden className="text-ink-500" />
                        <span className="hidden sm:inline">Llamar</span>
                      </a>
                      <a
                        href={`https://wa.me/${phone.replace(/\D/g, "")}`}
                        target="_blank"
                        rel="noreferrer"
                        title="Abrir WhatsApp"
                        aria-label="Abrir WhatsApp con el cliente"
                        className={opsButtonClass("secondary", "sm", "pointer-coarse:h-11 pointer-coarse:min-w-11")}
                      >
                        <IconWhatsApp aria-hidden className="text-ink-500" />
                      </a>
                    </>
                  )}
                  {nextShipmentId && (
                    <OpsButton
                      size="sm"
                      onClick={() => handleOpenShipment(nextShipmentId)}
                      aria-keyshortcuts="n"
                      title="Atajo: n"
                      className="pointer-coarse:h-11"
                    >
                      Siguiente
                      <IconArrowRight className="text-ink-500" />
                    </OpsButton>
                  )}
                </div>
                <button
                  type="button"
                  onClick={handleClose}
                  aria-label="Cerrar"
                  className="col-start-2 row-start-1 -mr-1.5 grid size-8 shrink-0 place-items-center rounded-md text-ink-500 transition-colors hover:bg-wash hover:text-ink-900 sm:col-start-3 pointer-coarse:size-11"
                >
                  <IconClose />
                </button>
              </div>

              {/* LA RESERVA, EN UNA LÍNEA. Quién puede escribir en esta guía: tú,
                  nadie todavía (solo lectura) u otra persona. */}
              <div
                role="status"
                className={cn(
                  "flex items-start gap-2 px-4 pb-3 pt-2 text-[13px] leading-5 sm:px-6",
                  claimState === "blocked" ? "text-warn-fg" : "text-ink-600",
                )}
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    "mt-1.5 size-2 shrink-0 rounded-full",
                    claimState === "mine"
                      ? "bg-ok-fg"
                      : claimState === "blocked"
                        ? "bg-warn-fg"
                        : "animate-pulse bg-ink-300 motion-reduce:animate-none",
                  )}
                />
                <span className="min-w-0">
                  {claimState === "idle" ? (
                    <>
                      <b className="font-semibold text-ink-900">Solo lectura.</b> Nadie la tiene tomada y tú
                      tampoco: se reservará sola en cuanto escribas algo, para no bloquearla mientras la consultas.
                    </>
                  ) : claimState === "mine" ? (
                    <>
                      <b className="font-semibold text-ink-900">Reservado para ti.</b> Se liberará
                      automáticamente al cerrar este panel.
                    </>
                  ) : claimState === "blocked" ? (
                    <>
                      <b className="font-semibold">{claimMessage ?? "Otro asesor está atendiendo este envío."}</b>{" "}
                      Puedes consultar la información, pero no modificarla.
                      {/* LA NOTA NO SE ENTIERRA VIVA. Cuando la reserva vence o la
                          toma otra persona, el `fieldset` se deshabilita y el texto
                          recién escrito queda atrapado en un textarea inerte: antes
                          el aviso solo decía «cierra y vuelve a abrir», y al cerrar
                          se perdía. Ahora se ofrece copiarlo primero. */}
                      {hasDraft && (
                        <>
                          {" "}
                          <b className="font-semibold">Tienes texto sin registrar.</b>{" "}
                          <CopyButton
                            value={draftFields.filter((v) => v.trim()).join("\n\n")}
                            label="lo que escribiste"
                          />{" "}
                          antes de cerrar.
                        </>
                      )}
                    </>
                  ) : (
                    "Reservando este envío…"
                  )}
                </span>
              </div>

              {/* Cerrar con texto sin registrar: se avisa en vez de perderlo. Va
                  en la cabecera fija, donde la persona está mirando. */}
              {pendingExit && (
                <div className="px-4 pb-3 sm:px-6">
                  <Banner tone="warn" role="alert">
                    <p>
                      Escribiste algo que todavía no se registró. Si{" "}
                      {pendingExit.kind === "open" ? "pasas a la siguiente" : "cierras"}, se descarta.
                    </p>
                    <div className="mt-2 flex flex-wrap gap-2">
                      <OpsButton size="sm" onClick={() => setPendingExit(null)} className="pointer-coarse:h-11">
                        Seguir aquí
                      </OpsButton>
                      <OpsButton
                        size="sm"
                        variant="danger"
                        onClick={() => doExit(pendingExit)}
                        className="pointer-coarse:h-11"
                      >
                        {pendingExit.kind === "open" ? "Descartar y seguir" : "Descartar y cerrar"}
                      </OpsButton>
                    </div>
                  </Banner>
                </div>
              )}
            </header>

            <div className="space-y-4 p-4 pb-[max(1rem,env(safe-area-inset-bottom))] sm:space-y-5 sm:p-6">
            {/* En solo lectura el bloque sigue habilitado a propósito: es lo que
                permite que tocar un control pida la reserva. Si vuelve
                «tomada», se deshabilita y el borrador se puede copiar. */}
            <fieldset
              disabled={claimState === "blocked" || (eagerClaim && claimState !== "mine")}
              className="contents"
              // Tabular por el panel es leer; escribir o pulsar un control es
              // trabajar. Solo lo segundo pide la reserva.
              onInputCapture={() => {
                if (!shouldClaim) setClaimRequested(true);
              }}
              onPointerDownCapture={(e) => {
                if (shouldClaim) return;
                if ((e.target as HTMLElement | null)?.closest("input, select, textarea, button")) {
                  setClaimRequested(true);
                }
              }}
            >

            {/* A quién se llama: lo que se lee mientras se marca. El motivo
                anterior primero, porque decide si vale la pena reenviar; después
                adónde va, qué se declaró y las cuatro cifras de la guía. */}
            <section aria-labelledby="guia-cliente" className={SECTION_CARD}>
              <SectionHead id="guia-cliente" title="Cliente y destino" />
              <div className="space-y-4 pt-4">
                {/* MOM §11: «Revisar el motivo anterior. Si el cliente vio el
                    producto y aun así lo rechazó, normalmente no reenviar.»
                    Va en la ficha que se lee mientras suena el teléfono. */}
                {(() => {
                  const m = motivoParaMostrar(detail.shipment);
                  if (!m) return null;
                  return (
                    <div>
                      <p className={DRAWER_KEY}>Cómo terminó el intento anterior</p>
                      <p
                        className={cn(
                          "text-sm leading-5 [overflow-wrap:anywhere]",
                          m.vioElProducto ? "font-semibold text-crit-fg" : m.consta ? "text-ink-900" : "text-ink-500",
                        )}
                      >
                        {keepDots(m.texto)}
                      </p>
                      {m.vioElProducto && (
                        <p className="mt-0.5 text-[13px] leading-5 text-crit-fg">
                          Vio el producto y no quedó: normalmente no se reenvía.
                        </p>
                      )}
                    </div>
                  );
                })()}
                <dl className="grid grid-cols-2 gap-x-6 gap-y-3">
                  <Field label="Distrito" value={detail.shipment.district} />
                  <Field label="Departamento" value={normalizeDepartment(detail.shipment.region) || null} />
                  {/* La ciudad de cobertura Swayp, solo si no repite el distrito
                      («Juliaca · juliaca»): es con la que se evalúa Swayp. */}
                  {detail.shipment.city &&
                    detail.shipment.city.localeCompare(detail.shipment.district ?? "", "es", { sensitivity: "base" }) !== 0 && (
                      <Field label="Ciudad Swayp" value={detail.shipment.city} capitalize />
                    )}
                  <div className="col-span-2">
                    <Field label="Producto declarado" value={detail.shipment.product} />
                  </div>
                </dl>
                {localityConflict && (
                  <Banner tone="warn" title="Revisa el destino antes de despachar.">
                    El courier dice <b className="font-semibold text-ink-900">{detail.shipment.city}</b>, pero la
                    dirección de Shopify es{" "}
                    <b className="font-semibold text-ink-900">
                      {[shopifyAddress?.city, shopifyAddress?.province].filter(Boolean).join(" · ")}
                    </b>
                    . Corrígelo con «Modificar destino» para que quede fijo.
                  </Banner>
                )}
                {/* Las cuatro cifras de la guía en el marco de cifras: lo que
                    decide la ruta (intentos y fecha Aliclik, cobertura Swayp) y
                    cuántas llamadas van. */}
                <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-md bg-line ring-1 ring-line sm:grid-cols-4">
                  <CompactMetric
                    label="Intentos Aliclik"
                    value={
                      detail.shipment.aliclik_attempts == null
                        ? "Sin dato"
                        : `${detail.shipment.aliclik_attempts} / ${ALICLIK_MAX_INTENTOS}`
                    }
                  />
                  <CompactMetric label="Fecha Aliclik" value={fmtAliclikDate(detail.shipment.aliclik_service_date)} />
                  <CompactMetric label="Llamadas" value={`${detail.shipment.reroute_attempts} / ${MAX_INTENTOS}`} />
                  <CompactMetric
                    label="Swayp"
                    value={
                      fenixReason === "ok"
                        ? "Swayp ok"
                        : fenixReason === "sin_stock"
                          ? "Sin stock"
                          : "Fuera de cobertura"
                    }
                    tone={fenixReason === "ok" ? "positive" : fenixReason === "sin_stock" ? "warning" : "negative"}
                  />
                </dl>
                {fenixDeliverySchedule && (
                  <p className="text-[13px] leading-5 text-ink-600">
                    <span className="font-semibold text-ink-900">Horario Swayp: {fenixDeliverySchedule.hours}</span>
                    {fenixDeliverySchedule.note && <> · {fenixDeliverySchedule.note}</>}
                  </p>
                )}
                {swaypNovelty && (
                  // El estado crudo de Swayp es lo único que distingue «el
                  // mensajero está esperando una instrucción» de «va en
                  // reparto»: los dos son `en_ruta` al mapearse.
                  <Banner
                    tone="crit"
                    title={
                      detail.shipment.swayp_state === 8 ? "Swayp marcó devolución" : "Swayp reportó una novedad"
                    }
                  >
                    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
                      <p>El mensajero espera una instrucción.</p>
                      {detail.can.solveNovelty && (
                        <OpsButton
                          size="sm"
                          variant="primary"
                          onClick={() => setNoveltyOpen(true)}
                          className="pointer-coarse:h-11"
                        >
                          Resolver novedad
                        </OpsButton>
                      )}
                    </div>
                  </Banner>
                )}
              </div>
            </section>

            {detail.shipment.delivery_status === "anulado" && (
              <section aria-labelledby="guia-reenvio" className={SECTION_CARD}>
                {/* En recuperación, reenviar es la acción NORMAL (MOM §11), no
                    una excepción: la guía sí terminó, el pedido no. El flujo de
                    abajo es el mismo; cambia lo que se le dice a quien llama. */}
                <SectionHead
                  id="guia-reenvio"
                  title={enRecuperacion ? "Reenviar por Swayp" : "Reprogramar un pedido anulado"}
                  badge={
                    <Badge tone={enRecuperacion ? "info" : "warn"}>
                      {enRecuperacion ? "Reproprovincia" : "Excepción auditada"}
                    </Badge>
                  }
                  help={
                    enRecuperacion
                      ? "La guía Aliclik ya terminó y no se toca: queda como madre transferida y se crea una guía Swayp con la fecha acordada con la clienta."
                      : "No se borrará la anulación. Esta guía quedará como madre transferida y se creará una nueva guía Swayp con la fecha acordada."
                  }
                  aside={
                    !showCancelledException && (
                      <OpsButton size="sm" onClick={() => setShowCancelledException(true)} className="pointer-coarse:h-11">
                        {enRecuperacion ? "Reenviar" : "Crear excepción"}
                      </OpsButton>
                    )
                  }
                />

                {showCancelledException && (
                  <div className="space-y-4 pt-4">
                    <label className={DRAWER_LABEL}>
                      Nueva fecha de entrega
                      <input
                        type="date"
                        value={cancelledExceptionDate}
                        min={tomorrowDateInputValue()}
                        onChange={(e) => setCancelledExceptionDate(e.target.value)}
                        className={DRAWER_INPUT}
                      />
                    </label>
                    <label className={DRAWER_LABEL}>
                      {enRecuperacion ? "Nota de la llamada" : "Motivo de la excepción"}
                      <textarea
                        value={cancelledExceptionNote}
                        onChange={(e) => setCancelledExceptionNote(e.target.value)}
                        rows={2}
                        placeholder="Ej.: cliente confirmó hoy entrega para el lunes con Marianny…"
                        className={DRAWER_TEXTAREA}
                      />
                    </label>

                    {/* Antes se prometía aquí el número que la app iba a acuñar
                        (`#KP…`). Ya no lo acuña nadie: el número lo emite Swayp
                        al registrar el reenvío, así que prometer uno concreto
                        sería enseñar un número que no va a existir. */}
                    <p className={DRAWER_NOTE}>
                      El número de la nueva guía <b className="font-semibold text-ink-900">lo emite Swayp</b> al
                      registrar el reenvío. Si Swayp no responde, el reenvío no se registra y el aviso dice por qué.
                    </p>

                    {swaypSinCodbarAviso && (
                      <Banner tone="crit">{swaypSinCodbarAviso}</Banner>
                    )}
                    {cancelledExceptionUnavailable && !swaypSinCodbar && (
                      <Banner tone="warn">
                        {fenixReason === "sin_stock"
                          ? `Swayp no tiene stock para este pedido en ${detail.shipment.city ?? "la ciudad indicada"}.`
                          : `Swayp no tiene cobertura en ${detail.shipment.city ?? "la ciudad indicada"}.`}
                      </Banner>
                    )}

                    <div className="flex flex-wrap justify-end gap-2">
                      <OpsButton
                        onClick={() => {
                          setShowCancelledException(false);
                          setCancelledExceptionDate("");
                          setCancelledExceptionNote("");
                        }}
                        className="pointer-coarse:h-11"
                      >
                        Cancelar
                      </OpsButton>
                      <OpsButton
                        variant={enRecuperacion ? "primary" : "danger"}
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
                        className="pointer-coarse:h-11"
                      >
                        {pending ? "Creando…" : "Crear nueva guía Swayp"}
                      </OpsButton>
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
              <section aria-labelledby="guia-recuperacion" className={ACTION_CARD}>
                <SectionHead
                  id="guia-recuperacion"
                  title="Registrar o programar llamada"
                  help="Sobre el pedido, no sobre la guía: sigue «Anulado · Reproprovincia» hasta que se reenvíe, se descarte o venza la ventana."
                />
                <div className="space-y-4 pt-4">
                  <div role="group" aria-label="Resultado de la llamada" className="grid gap-2 sm:grid-cols-3">
                    {RECOVERY_CALL_DISPOSITIONS.map((d) => (
                      <OptionTile
                        key={d.key}
                        label={d.label}
                        description={recoveryHint[d.key]}
                        active={recoveryDisposition === d.key}
                        danger={d.key === "no_quiere"}
                        onClick={() => {
                          setRecoveryDisposition(d.key);
                          setConfirmDiscard(false);
                        }}
                      />
                    ))}
                  </div>
                  {recoveryDisposition === "no_quiere" && (
                    <Banner tone="crit">
                      El pedido pasa a cierre con el motivo escrito y la guía sale de la cola. No se toca la guía de
                      Aliclik ni el inventario.
                    </Banner>
                  )}
                  {recoveryDisposition !== "no_quiere" && (
                    <label className={DRAWER_LABEL}>
                      {recoveryDisposition === "programar" ? "Fecha de próxima llamada" : "Fecha de próxima llamada (opcional)"}
                      <input
                        type="date"
                        value={recoveryDate}
                        onChange={(e) => setRecoveryDate(e.target.value)}
                        min={tomorrowDateInputValue()}
                        className={DRAWER_INPUT}
                      />
                    </label>
                  )}
                  <label className={DRAWER_LABEL}>
                    {recoveryDisposition === "no_quiere" ? "Motivo del descarte" : "Nota de la llamada"}
                    <textarea
                      value={recoveryNote}
                      onChange={(e) => setRecoveryNote(e.target.value)}
                      placeholder={
                        recoveryDisposition === "no_quiere"
                          ? "P. ej. la clienta ya no quiere el producto"
                          : "Qué dijo la clienta…"
                      }
                      className={DRAWER_TEXTAREA}
                      rows={2}
                    />
                    {/* La regla estaba en el servidor y el botón solo se apagaba: la
                        persona escribía «no quiere» y no sabía por qué no podía
                        seguir. Se dice antes, junto al campo. */}
                    {recoveryDisposition === "no_quiere" && (
                      <span className="text-[13px] font-normal leading-5 text-ink-500">
                        {recoveryNote.trim().length < DISCARD_REASON_MIN
                          ? `Mínimo ${DISCARD_REASON_MIN} caracteres · faltan ${DISCARD_REASON_MIN - recoveryNote.trim().length}`
                          : "Queda escrito en el pedido como motivo del descarte."}
                      </span>
                    )}
                  </label>
                  {/* DESCARTAR ES TERMINAL: el pedido pasa a cierre y sale de la
                      cola. Un solo clic no basta; el segundo nombra el pedido y la
                      consecuencia, y se puede cancelar. */}
                  {recoveryDisposition === "no_quiere" && confirmDiscard ? (
                    <div className="flex flex-wrap justify-end gap-2">
                      <OpsButton onClick={() => setConfirmDiscard(false)} className="pointer-coarse:h-11">
                        Cancelar
                      </OpsButton>
                      <OpsButton
                        variant="danger"
                        onClick={() =>
                          run(
                            () =>
                              registerRecoveryCall(shipmentId, {
                                disposition: recoveryDisposition,
                                note: recoveryNote,
                                nextFollowupAt: null,
                              }),
                            () => {
                              setRecoveryNote("");
                              setRecoveryDate("");
                              setConfirmDiscard(false);
                            },
                          )
                        }
                        disabled={pending || recoveryNote.trim().length < DISCARD_REASON_MIN}
                        className="pointer-coarse:h-11"
                      >
                        {pending
                          ? "Descartando…"
                          : `Sí, descartar ${detail.shipment.order_name ? `el pedido ${detail.shipment.order_name}` : "este pedido"}`}
                      </OpsButton>
                    </div>
                  ) : (
                    <div className="flex justify-end">
                      <OpsButton
                        variant={recoveryDisposition === "no_quiere" ? "danger" : "primary"}
                        onClick={() => {
                          if (recoveryDisposition === "no_quiere") {
                            setConfirmDiscard(true);
                            return;
                          }
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
                          );
                        }}
                        disabled={
                          pending ||
                          (recoveryDisposition === "programar" && !recoveryDate) ||
                          (recoveryDisposition === "no_quiere" && recoveryNote.trim().length < DISCARD_REASON_MIN)
                        }
                        className="pointer-coarse:h-11"
                      >
                        {pending
                          ? "Registrando…"
                          : recoveryDisposition === "no_quiere"
                            ? "Descartar la recuperación…"
                            : recoveryDisposition === "programar"
                              ? "Programar llamada"
                              : "Registrar llamada"}
                      </OpsButton>
                    </div>
                  )}
                </div>
              </section>
            )}

            {/* Step 1 for active Swayp deliveries: process the courier outcome
                before any customer call or reprogramming can be registered. */}
            {detail.shipment.courier === "fenix" && detail.shipment.delivery_status !== "anulado" && (
              detail.shipment.delivery_status === "transferido" ? (
                <section aria-labelledby="guia-transferida" className={SECTION_CARD}>
                  <SectionHead
                    id="guia-transferida"
                    title="Continúa en la guía Swayp activa"
                    badge={<Badge>Guía reemplazada</Badge>}
                    help="«Transferido» lo asigna Kapta automáticamente; no es un resultado del motorizado."
                  />
                  {detail.linkedFenixShipment && (
                    <div className="pt-4">
                      <button
                        type="button"
                        onClick={() => handleOpenShipment(detail.linkedFenixShipment!.id)}
                        className="flex w-full items-center justify-between gap-3 rounded-md bg-white px-3 py-2.5 text-left shadow-control ring-1 ring-inset ring-line-strong transition-colors hover:bg-wash pointer-coarse:min-h-11"
                      >
                        <span className="min-w-0">
                          <span className="block text-[13px] leading-5 text-ink-500">Abrir guía activa</span>
                          <span className="block font-mono text-sm font-semibold text-ink-900">
                            {detail.linkedFenixShipment.guide_code}
                          </span>
                        </span>
                        <IconArrowRight className="text-ink-500" />
                      </button>
                    </div>
                  )}
                </section>
              ) : fenixReadyForCustomerManagement && !showCourierCorrection ? (
                <section className="flex items-start justify-between gap-3 rounded-lg bg-ok-wash px-4 py-3 sm:px-5">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-ok-fg">Resultado del courier registrado</p>
                    <p className="mt-0.5 text-[13px] leading-5 text-ink-700">
                      Pendiente de gestión con el cliente. Continúa abajo con la llamada: si confirma, recién se generará
                      la nueva reprogramación.
                    </p>
                  </div>
                  <OpsButton
                    size="sm"
                    variant="ghost"
                    onClick={() => setShowCourierCorrection(true)}
                    className="-my-1 shrink-0 pointer-coarse:h-11"
                  >
                    Corregir resultado
                  </OpsButton>
                </section>
              ) : (
                <section aria-labelledby="guia-courier" className={fenixAwaitingCourierResult ? ACTION_CARD : SECTION_CARD}>
                  <SectionHead
                    id="guia-courier"
                    title="Registrar resultado del courier"
                    badge={
                      fenixAwaitingCourierResult ? (
                        <Badge tone="warn">Obligatorio</Badge>
                      ) : (
                        <Badge>Corrección del reporte</Badge>
                      )
                    }
                    help={
                      fenixAwaitingCourierResult
                        ? "Esta guía está En ruta. Primero registra lo informado por el motorizado; la llamada y la reprogramación se habilitarán solo si vuelve a Pendiente."
                        : "Corrige lo que se registró del motorizado. El historial guarda los dos reportes."
                    }
                  />
                  <div className="space-y-4 pt-4">
                    <label className={DRAWER_LABEL}>
                      ¿Qué informó Swayp?
                      <select
                        value={courierResult}
                        onChange={(e) => {
                          setCourierResult(e.target.value as CourierReportResult | "");
                          setCourierDate("");
                          // Cambiar de resultado desarma el segundo clic: un botón
                          // rojo cebado no puede sobrevivir a un cambio de opinión.
                          setConfirmCourierClose(false);
                        }}
                        className={DRAWER_INPUT}
                      >
                        <option value="">Selecciona el resultado…</option>
                        {COURIER_REPORT_RESULTS.map((result) => (
                          <option key={result.code} value={result.code}>{result.optionLabel}</option>
                        ))}
                      </select>
                    </label>

                    {courierResultDefinition && (
                      <div className={DRAWER_NOTE}>
                        <p className="font-semibold text-ink-900">Qué sucederá</p>
                        <p className="mt-0.5">{courierResultDefinition.effect}</p>
                        {reopensClosedGuide && (
                          <p className="mt-1 font-medium text-warn-fg">
                            Esta corrección reabrirá una guía que actualmente está cerrada.
                          </p>
                        )}
                      </div>
                    )}

                    {courierResultDefinition?.requiresDate && (
                      <label className={DRAWER_LABEL}>
                        Nueva fecha de entrega informada por Swayp
                        <input
                          type="date"
                          value={courierDate}
                          onChange={(e) => setCourierDate(e.target.value)}
                          // Hoy vale, ayer no: el servidor aplica la misma regla.
                          min={localDateInputValue()}
                          className={DRAWER_INPUT}
                        />
                      </label>
                    )}

                    {courierResultDefinition && (
                      <label className={DRAWER_LABEL}>
                        {courierResult === "no_contesta"
                          ? "Comentario para el historial (opcional)"
                          : courierResultDefinition.requiresNote
                            ? "Motivo informado por Swayp"
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
                          className={DRAWER_TEXTAREA}
                        />
                        {courierResult === "no_contesta" && (
                          <span className="text-[13px] font-normal leading-5 text-ink-500">
                            Se guardará en el historial junto al cambio No contesta → Pendiente.
                          </span>
                        )}
                      </label>
                    )}

                    {/* LA CUARTA SALIDA TAMBIÉN CIERRA UNA VENTA. MOM §11.5 pide
                        la misma ceremonia a las tres salidas del cajón «porque el
                        coste de equivocarse es el mismo», y esta —el courier
                        informa cancelado o rechazado— cerraba con un solo clic,
                        sin nombrar la guía ni el pedido, mientras «Cliente
                        cancela», que hace exactamente lo mismo, pedía dos. */}
                    {courierResultClosesSale && (
                      <Banner tone="crit" role="alert">
                        <span className="font-semibold">Esto termina la venta.</span> La guía queda Anulada y sale de la
                        gestión activa.
                      </Banner>
                    )}
                    <div className="flex flex-wrap justify-end gap-2">
                      {(showCourierCorrection || confirmCourierClose) && (
                        <OpsButton
                          onClick={() => {
                            setConfirmCourierClose(false);
                            setShowCourierCorrection(false);
                          }}
                          className="pointer-coarse:h-11"
                        >
                          Cancelar
                        </OpsButton>
                      )}
                      <OpsButton
                        variant={courierResultClosesSale ? "danger" : "primary"}
                        onClick={() => {
                          if (!courierResult) return;
                          if (courierResultClosesSale && !confirmCourierClose) {
                            setConfirmCourierClose(true);
                            return;
                          }
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
                              setConfirmCourierClose(false);
                            },
                          );
                        }}
                        disabled={pending || !courierFormValid}
                        className="pointer-coarse:h-11"
                      >
                        {pending
                          ? "Registrando…"
                          : confirmCourierClose
                            ? `Sí, anular la guía ${detail.shipment.guide_code}${
                                detail.shipment.order_name ? ` del pedido ${detail.shipment.order_name}` : ""
                              }`
                            : courierResultClosesSale
                              ? "Anular la guía…"
                              : "Registrar resultado y continuar"}
                      </OpsButton>
                    </div>
                  </div>
                </section>
              )
            )}

            {/* claim + re-route call — hidden once the shipment is terminal (entregado/
                anulado/transferido) so a stray "no contesta" can't reopen a closed guide */}
            {isCallable(detail.shipment.delivery_status) && !fenixAwaitingCourierResult && (
              <section aria-labelledby="guia-llamada" className={ACTION_CARD}>
                <SectionHead id="guia-llamada" title="Registrar o programar llamada" />
                <div className="space-y-4 pt-4">
                  {/* LOS CUATRO RESULTADOS A LA VISTA, con su consecuencia. Eran un
                      desplegable: elegir costaba abrirlo, y lo que pasaba después
                      se leía recién debajo. Lo que cierra la venta va en rojo. */}
                  <div role="group" aria-label="Resultado de la llamada" className="grid gap-2 sm:grid-cols-2">
                    {DISPOSITIONS.map((d) => (
                      <OptionTile
                        key={d.key}
                        label={d.label}
                        description={dispositionHint(d.key)}
                        active={disposition === d.key}
                        danger={d.key === "cancela" || (d.key === "no_contesta" && noAnswerCancels)}
                        onClick={() => {
                          setDisposition(d.key);
                          setConfirmCancel(false);
                        }}
                      />
                    ))}
                  </div>
                  {disposition === "confirma" && aliclikDecision && (
                    <div className={cn(CARD_ZONE, "space-y-3")}>
                      <div>
                        <p className="text-sm font-semibold text-ink-900">Ruta</p>
                        <p className="mt-0.5 text-[13px] leading-5 text-ink-500">{aliclikDecisionCopy(aliclikDecision)}</p>
                      </div>
                      {/* Si solo hay una ruta posible no se pregunta: «Ruta
                          sugerida» ya lo decidió en la fila. El selector aparece
                          solo cuando de verdad hay dos caminos (o la excepción
                          manual de Aliclik, que es una decisión que hay que
                          tomar a sabiendas). */}
                      {!showRouteChooser && (
                        <p className={DRAWER_NOTE}>
                          <span className="font-semibold text-ink-900">
                            {reprogramProvider === "aliclik" ? "Ruta: Aliclik · misma guía" : "Ruta: Swayp · nueva guía"}
                          </span>
                          {reprogramProvider === "aliclik"
                            ? " · Swayp sin stock o cobertura para este destino."
                            : " · Aliclik no disponible para esta guía."}
                        </p>
                      )}
                      {showRouteChooser && (
                        <div role="group" aria-label="Ruta de la reprogramación" className="grid grid-cols-2 gap-2">
                          <OptionTile
                            label="Aliclik"
                            description="Misma guía"
                            active={reprogramProvider === "aliclik" && !forceAliclik}
                            disabled={!aliclikDecision.eligible}
                            onClick={() => {
                              setReprogramProvider("aliclik");
                              setForceAliclik(false);
                            }}
                          />
                          <OptionTile
                            label="Swayp"
                            description={
                              fenixRouteAvailable
                                ? "Nueva guía"
                                : swaypSinCodbar
                                  ? "Sin vínculo de codbar"
                                  : "Sin stock/cobertura"
                            }
                            active={reprogramProvider === "fenix"}
                            disabled={!fenixRouteAvailable}
                            onClick={() => {
                              setReprogramProvider("fenix");
                              setForceAliclik(false);
                            }}
                          />
                        </div>
                      )}
                      {canForceAliclik && (
                        <label className="flex cursor-pointer items-start gap-2.5 rounded-md bg-wash px-3 py-2.5 text-[13px] leading-5 text-ink-700 pointer-coarse:min-h-11">
                          <input
                            type="checkbox"
                            checked={forceAliclik}
                            onChange={(e) => {
                              setForceAliclik(e.target.checked);
                              setReprogramProvider(e.target.checked ? "aliclik" : "fenix");
                            }}
                            className={cn(CHECKBOX, "mt-0.5")}
                          />
                          <span>
                            <b className="font-semibold text-ink-900">Excepción manual Aliclik.</b> Requiere explicar el
                            motivo en la nota y quedará auditada.
                          </span>
                        </label>
                      )}
                      {reprogramProvider === "aliclik" ? (
                        <p className="rounded-md bg-wash px-3 py-2 text-[13px] leading-relaxed text-ink-600">
                          Primero realiza la reprogramación en Aliclik. Luego confírmala aquí: se conservará la guía actual.
                        </p>
                      ) : detail.shipment.order_name ? (
                        // Antes decía sólo «se generará una nueva guía Swayp», sin
                        // distinguir los DOS caminos que hay detrás del mismo botón.
                        // La operadora apretaba sin saber si el número lo pondría
                        // Swayp o si tendría que cargar la guía a mano en el Excel,
                        // y se enteraba recién en el aviso posterior. El destino ya
                        // decide cuál es; decirlo antes es gratis.
                        detail.swaypApiCity ? (
                          <p className={DRAWER_NOTE}>
                            Se generará una <b className="font-semibold text-ink-900">nueva guía Swayp</b> con la fecha
                            elegida y <b className="font-semibold text-ink-900">el número lo emite Swayp</b>: quedará
                            creada en su sistema, sin cargarla al Excel. Si Swayp no responde, la reprogramación{" "}
                            <b className="font-semibold text-ink-900">no se registra</b> y el aviso te dice por qué.
                          </p>
                        ) : (
                          <Banner tone="warn">
                            Este destino <b className="font-semibold">no tiene bodega Swayp configurada</b>, así que Swayp
                            no puede emitir el número y la guía no se creará. Configúrala en Ajustes o elige otro courier.
                          </Banner>
                        )
                      ) : (
                        <p className="rounded-md bg-warn-wash px-3 py-2 text-[13px] leading-relaxed text-ink-700">
                          Sin N° de pedido no se puede autogenerar. Usa <b className="font-semibold">Ingresar una guía Swayp a mano</b>, abajo.
                        </p>
                      )}
                    </div>
                  )}
                  {disposition === "programar" && (
                    <p className={DRAWER_NOTE}>
                      La guía se ocultará hasta la fecha elegida y volverá a la cola ese día.
                      No aumenta los intentos ni cambia el estado del envío.
                    </p>
                  )}
                  <div className={cn(disposition === "confirma" && aliclikDecision && CARD_ZONE, "grid gap-4 sm:grid-cols-[minmax(0,14rem)_minmax(0,1fr)]")}>
                    <label className={DRAWER_LABEL}>
                      {disposition === "confirma"
                        ? reprogramProvider === "aliclik"
                          ? "Fecha de reprogramación en Aliclik"
                          : "Fecha de reprogramación (va en la nueva guía Swayp)"
                        : disposition === "programar"
                          ? "Fecha de próxima llamada"
                          : "Próximo intento (opcional)"}
                      <input
                        type="date"
                        value={nextDate}
                        onChange={(e) => setNextDate(e.target.value)}
                        // UNA REPROGRAMACIÓN CONFIRMADA NO PUEDE SER DE AYER. El
                        // `min` solo cubría «programar», y ni el botón ni el
                        // servidor exigían futuro para «confirma»: se emitía una
                        // guía Swayp con la fecha pasada ESTAMPADA EN SU NÚMERO
                        // (`rescheduleGuideCode`) y un despacho imposible agendado.
                        min={
                          disposition === "programar" || disposition === "confirma"
                            ? tomorrowDateInputValue()
                            : undefined
                        }
                        className={DRAWER_INPUT}
                      />
                    </label>
                    <label className={DRAWER_LABEL}>
                      Nota de la llamada
                      <textarea
                        value={note}
                        onChange={(e) => setNote(e.target.value)}
                        placeholder="Qué dijo la clienta…"
                        className={DRAWER_TEXTAREA}
                        rows={2}
                      />
                    </label>
                  </div>
                  {/* EL ÚLTIMO INTENTO CIERRA LA VENTA, Y ANTES NO LO DECÍA. Con
                      los intentos agotados, un «No contesta» más anula la guía
                      (`nextShipmentTransition`): el cajón mostraba «Llamadas 7 / 7»
                      y nada más, y la guía se cerraba sin que nadie lo hubiera
                      pedido. */}
                  {lastAttemptWillCancel && (
                    <Banner tone="warn">
                      <b className="font-semibold">Es el último intento.</b> Con {MAX_INTENTOS} llamadas sin respuesta,
                      registrar este «No contesta» <b className="font-semibold">anula la guía</b> y el pedido pasa a cierre.
                    </Banner>
                  )}
                  {/* ANULAR LA VENTA SE CONFIRMA, COMO EL DESCARTE. «Cliente
                      cancela» cerraba el pedido con el mismo botón genérico que un
                      «No contesta». */}
                  {cancelNeedsConfirm && confirmCancel ? (
                    <div className="flex flex-wrap justify-end gap-2">
                      <OpsButton onClick={() => setConfirmCancel(false)} className="pointer-coarse:h-11">
                        Cancelar
                      </OpsButton>
                      <OpsButton
                        variant="danger"
                        onClick={() =>
                          run(
                            () =>
                              registerRerouteCall(shipmentId, {
                                disposition,
                                note,
                                nextFollowupAt: null,
                                reprogramProvider,
                                forceAliclik,
                              }),
                            // El confirmar de «Cliente cancela» es la SEGUNDA
                            // llamada a esta acción y también se olvidaba de
                            // limpiar. Anular es terminal: la guía sale de la
                            // vista, pero la nota se quedaba viva en el cajón.
                            () => {
                              setNote("");
                              setNextDate("");
                              setConfirmCancel(false);
                            },
                          )
                        }
                        disabled={pending}
                        className="pointer-coarse:h-11"
                      >
                        {pending
                          ? "Anulando…"
                          : `Sí, anular la guía ${detail.shipment.guide_code}${
                              detail.shipment.order_name ? ` del pedido ${detail.shipment.order_name}` : ""
                            }`}
                      </OpsButton>
                    </div>
                  ) : (
                    <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-2">
                      {gestionBlockReason && (
                        <p id="gestion-motivo" role="status" className="mr-auto text-[13px] leading-5 text-warn-fg">
                          {gestionBlockReason}
                        </p>
                      )}
                      <OpsButton
                        variant={cancelNeedsConfirm || lastAttemptWillCancel ? "danger" : "primary"}
                        onClick={() => {
                          if (cancelNeedsConfirm) {
                            setConfirmCancel(true);
                            return;
                          }
                          run(
                            () =>
                              registerRerouteCall(shipmentId, {
                                disposition,
                                note,
                                nextFollowupAt: nextDate ? new Date(nextDate).toISOString() : null,
                                reprogramProvider,
                                forceAliclik,
                              }),
                            // Era la ÚNICA acción del cajón sin reseteo —las otras
                            // cuatro sí lo tenían—, así que un segundo «Registrar
                            // llamada» en la misma guía reenviaba la nota anterior,
                            // y el aviso de borrador sin registrar saltaba después
                            // de haber registrado.
                            () => {
                              setNote("");
                              setNextDate("");
                            },
                          );
                        }}
                        disabled={pending || requiredDateMissing}
                        aria-describedby={gestionBlockReason ? "gestion-motivo" : undefined}
                        className="pointer-coarse:h-11"
                      >
                        {disposition === "programar"
                          ? "Programar llamada"
                          : disposition === "confirma" && reprogramProvider === "aliclik"
                            ? "Confirmar reprogramación Aliclik"
                            : disposition === "confirma"
                              ? "Crear guía Swayp y confirmar"
                              : cancelNeedsConfirm
                                ? "Anular la guía…"
                                : lastAttemptWillCancel
                                  ? "Registrar y anular la guía"
                                  : "Registrar llamada"}
                      </OpsButton>
                    </div>
                  )}
                </div>
              </section>
            )}

            {/* Destino y pedido: consulta, no acción. Van debajo de la acción del
                momento y cada uno en su tarjeta; antes iban plegados porque
                empujaban el formulario de llamada fuera de la pantalla, y ahora
                están detrás de él. */}
            <section aria-labelledby="guia-destino" className={SECTION_CARD}>
              <SectionHead
                id="guia-destino"
                title="Destino de entrega"
                badge={detail.shipment.address_override ? <Badge>Modificado</Badge> : undefined}
                help={deliverySource}
                aside={
                  <OpsButton
                    size="sm"
                    variant="ghost"
                    onClick={() => setShowAddressEditor((value) => !value)}
                    className="pointer-coarse:h-11"
                  >
                    {showAddressEditor ? "Cerrar edición" : "Modificar destino"}
                  </OpsButton>
                }
              />

              {!showAddressEditor ? (
                <div className="space-y-4 pt-4">
                  <div>
                    <p className={DRAWER_KEY}>Dirección completa</p>
                    <p className="text-sm leading-5 text-ink-900">
                      {deliveryAddress ?? "No informada en Aliclik ni Shopify."}
                    </p>
                    {deliveryLocality && (
                      <p className="mt-0.5 text-[13px] leading-5 text-ink-700">{deliveryLocality}</p>
                    )}
                    {deliveryReference && (
                      <p className="mt-0.5 text-[13px] leading-5 text-ink-500">Ref.: {deliveryReference}</p>
                    )}
                  </div>
                  <div className={cn(CARD_ZONE, "flex flex-wrap items-end justify-between gap-x-6 gap-y-3")}>
                    <dl className="flex gap-x-8">
                      <div>
                        <dt className={DRAWER_KEY}>Latitud</dt>
                        <dd className="select-all font-mono text-[13px] leading-5 text-ink-900">
                          {detail.shipment.latitude ?? "—"}
                        </dd>
                      </div>
                      <div>
                        <dt className={DRAWER_KEY}>Longitud</dt>
                        <dd className="select-all font-mono text-[13px] leading-5 text-ink-900">
                          {detail.shipment.longitude ?? "—"}
                        </dd>
                      </div>
                    </dl>
                    {detail.shipment.latitude != null && detail.shipment.longitude != null && (
                      <a
                        href={`https://www.google.com/maps?q=${detail.shipment.latitude},${detail.shipment.longitude}`}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 text-[13px] font-medium text-brand-700 underline-offset-2 hover:underline pointer-coarse:min-h-11"
                      >
                        Abrir ubicación en Google Maps
                        <IconArrowUpRight aria-hidden className="size-3.5" />
                      </a>
                    )}
                  </div>
                </div>
              ) : (
                <div className="space-y-4 pt-4">
                  <label className={DRAWER_LABEL}>
                    Dirección completa
                    <textarea
                      value={address}
                      onChange={(e) => setAddress(e.target.value)}
                      rows={2}
                      placeholder="Calle, número, urbanización…"
                      className={DRAWER_TEXTAREA}
                    />
                  </label>
                  <label className={DRAWER_LABEL}>
                    Referencia
                    <input
                      value={addressReference}
                      onChange={(e) => setAddressReference(e.target.value)}
                      placeholder="Frente a…, puerta color…"
                      className={DRAWER_INPUT}
                    />
                  </label>
                  <div className="grid gap-4 sm:grid-cols-3">
                    <label className={DRAWER_LABEL}>
                      Distrito
                      <input
                        value={addressDistrict}
                        onChange={(e) => setAddressDistrict(e.target.value)}
                        className={DRAWER_INPUT}
                      />
                    </label>
                    <label className={DRAWER_LABEL}>
                      Ciudad / provincia
                      <input
                        value={addressCity}
                        onChange={(e) => setAddressCity(e.target.value)}
                        className={DRAWER_INPUT}
                      />
                    </label>
                    <label className={DRAWER_LABEL}>
                      Departamento
                      <input
                        value={addressRegion}
                        onChange={(e) => setAddressRegion(e.target.value)}
                        className={DRAWER_INPUT}
                      />
                    </label>
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <label className={DRAWER_LABEL}>
                      Latitud
                      <input
                        value={addressLatitude}
                        onChange={(e) => setAddressLatitude(e.target.value)}
                        inputMode="decimal"
                        placeholder="-16.409…"
                        className={cn(DRAWER_INPUT, "font-mono text-[13px]")}
                      />
                    </label>
                    <label className={DRAWER_LABEL}>
                      Longitud
                      <input
                        value={addressLongitude}
                        onChange={(e) => setAddressLongitude(e.target.value)}
                        inputMode="decimal"
                        placeholder="-71.556…"
                        className={cn(DRAWER_INPUT, "font-mono text-[13px]")}
                      />
                    </label>
                  </div>
                  <p className={DRAWER_NOTE}>
                    Al guardar se actualizará el pedido de Shopify y esta dirección no será reemplazada por futuros Excel.
                  </p>
                  <div className="flex flex-wrap justify-end gap-2">
                    <OpsButton onClick={() => setShowAddressEditor(false)} className="pointer-coarse:h-11">
                      Cancelar
                    </OpsButton>
                    <OpsButton
                      variant="primary"
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
                      className="pointer-coarse:h-11"
                    >
                      {pending ? "Guardando…" : "Guardar nuevo destino"}
                    </OpsButton>
                  </div>
                </div>
              )}
            </section>

            {/* order link — search+link (not just a raw UUID) for any shipment,
                so a wrong auto-match can also be corrected here */}
            <section aria-labelledby="guia-pedido" className={SECTION_CARD}>
              <SectionHead
                id="guia-pedido"
                title={
                  <>
                    Pedido{" "}
                    <span className="font-semibold tabular-nums text-ink-900">
                      <OrderNameLabel name={detail.shipment.order_name} matched={detail.shipment.matched} />
                    </span>
                  </>
                }
                badge={!detail.shipment.matched ? <Badge tone="warn">Sin vincular</Badge> : undefined}
                aside={
                  detail.shipment.matched && (
                    <OpsButton
                      size="sm"
                      variant="ghost"
                      onClick={() => setShowOrderPicker((v) => !v)}
                      className="pointer-coarse:h-11"
                    >
                      {showOrderPicker ? "Cancelar" : "Cambiar"}
                    </OpsButton>
                  )
                }
              />
              <div className="pt-4">
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
                    <p className="text-[13px] leading-5 text-ink-500">
                      No se encontró el detalle sincronizado de Shopify.
                    </p>
                  ))}
              </div>
            </section>

            {/* Swayp guide — manual fallback. The common path auto-generates the
                guide from "Cliente confirma" above; this stays for shipments
                without an order name, or to type a specific Swayp code. */}
            {/* Plegado por defecto: el camino normal es «Cliente confirma», que
                autogenera la guía. Este formulario compartía la fecha con el de
                la llamada (`nextDate`): teclear una fecha arriba rellenaba en
                silencio la de aquí. Ahora tiene la suya y solo se despliega si se
                pide, o solo si el envío no tiene N° de pedido (único caso en que
                es el camino obligado). */}
            {detail.shipment.delivery_status === "pendiente" && !detail.shipment.fenix_shipment_id && !showManualGuide && (
              <OpsButton variant="ghost" size="sm" onClick={() => setShowManualGuide(true)} className="pointer-coarse:h-11">
                <IconPlus className="text-ink-500" />
                Ingresar una guía Swayp a mano
              </OpsButton>
            )}
            {detail.shipment.delivery_status === "pendiente" && (showManualGuide || !!detail.shipment.fenix_shipment_id) && (
              <section aria-labelledby="guia-manual" className={SECTION_CARD}>
                <SectionHead
                  id="guia-manual"
                  title="Guía Swayp a mano"
                  aside={
                    !detail.shipment.fenix_shipment_id && (
                      <OpsButton size="sm" variant="ghost" onClick={() => setShowManualGuide(false)} className="pointer-coarse:h-11">
                        Ocultar
                      </OpsButton>
                    )
                  }
                />
                {detail.shipment.fenix_shipment_id ? (
                  <p className="pt-4 text-[13px] font-medium leading-5 text-ok-fg">Ya tiene guía Swayp vinculada.</p>
                ) : (
                  <div className="space-y-4 pt-4">
                    <div className="grid gap-4 sm:grid-cols-[minmax(0,14rem)_minmax(0,1fr)]">
                      <label className={DRAWER_LABEL}>
                        Fecha de reprogramación (va en la guía)
                        <input
                          type="date"
                          value={manualGuideDate}
                          min={tomorrowDateInputValue()}
                          aria-invalid={manualGuideDateInvalid || undefined}
                          onChange={(e) => setManualGuideDate(e.target.value)}
                          className={DRAWER_INPUT}
                        />
                      </label>
                      {/* «Autogenerar» estaba aquí y se quitó el 16-09-2026: armaba
                          el número con el pedido y la fecha —`#KP13166415092026`—, o
                          sea acuñaba un código que Swayp no conoce. Esta puerta es
                          para REGISTRAR el número que Swayp ya dio, no para
                          inventarlo. */}
                      <label className={DRAWER_LABEL}>
                        N° de guía Swayp
                        <input
                          value={fenixGuide}
                          onChange={(e) => setFenixGuide(e.target.value)}
                          inputMode="numeric"
                          aria-label="N° de guía Swayp"
                          placeholder="P. ej. 50000132589"
                          className={cn(DRAWER_INPUT, "font-mono")}
                        />
                      </label>
                    </div>
                    {/* El motivo del bloqueo se dice acá, en texto visible y
                        enlazado al botón. Dentro de un botón `disabled` no lo
                        alcanza ni el tabulador ni el lector de pantalla. */}
                    <p
                      id="guia-manual-motivo"
                      className={cn("text-[13px] leading-5", swaypSinCodbar ? "text-crit-fg" : "text-ink-500")}
                    >
                      {/* El codbar manda: sin vínculo la guía no sale ni escrita a
                          mano, porque Swayp no sabría qué descontar. */}
                      {swaypSinCodbarAviso
                        ? swaypSinCodbarAviso
                        : manualGuideDateInvalid
                          ? "Elige la fecha de despacho, de mañana en adelante."
                          : numeroManualNoEsDeSwayp
                            ? "Ese número no es de Swayp: los suyos son solo dígitos, como 50000132589. Cópialo de su panel."
                            : "Pega aquí el número que te dio el panel de Swayp. Si aún no la creaste allá, ciérralo y confirma la reprogramación: Swayp la emite sola."}
                    </p>
                    <div className="flex justify-end">
                      <OpsButton
                        onClick={() =>
                          run(
                            () =>
                              createFenixGuide(shipmentId, {
                                guideCode: fenixGuide,
                                nextFollowupAt: manualGuideDate ? new Date(manualGuideDate).toISOString() : null,
                              }),
                            // Un número de guía ya usado no se puede volver a
                            // enviar: si se queda en el campo, el segundo intento
                            // choca contra el duplicado en la base.
                            () => {
                              setFenixGuide("");
                              setManualGuideDate("");
                            },
                          )
                        }
                        disabled={
                          pending ||
                          !fenixGuide.trim() ||
                          manualGuideDateInvalid ||
                          swaypSinCodbar ||
                          numeroManualNoEsDeSwayp
                        }
                        aria-describedby="guia-manual-motivo"
                        className="pointer-coarse:h-11"
                      >
                        Crear guía Swayp
                      </OpsButton>
                    </div>
                  </div>
                )}
              </section>
            )}

            {/* El historial va DENTRO del bloqueo: con la guía reservada por otra
                persona, «no modificarla» incluye sus notas. */}
            <ShipmentGuideHistory guides={detail.guideHistory} onSaved={refresh} />

            </fieldset>
            </div>

            {/* EL AVISO VA AL PIE Y SE QUEDA PEGADO. Estaba arriba, encima de
                todos los formularios: al registrar algo desde el formulario de
                llamada —abajo, en el cajón— el error aparecía fuera de la
                pantalla y parecía que no había pasado nada. Pegado al pie se ve
                desde cualquier punto del scroll, y al aparecer se lleva el foco
                para que un lector de pantalla lo anuncie. */}
            {feedback && (
              <div className="sticky bottom-0 z-10 border-t border-line bg-white px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-6">
                <p
                  ref={feedbackRef}
                  tabIndex={-1}
                  role={feedback.kind === "error" ? "alert" : "status"}
                  className={cn(
                    "flex items-start gap-2.5 break-words rounded-lg px-3 py-2.5 text-sm text-ink-700 outline-none",
                    feedback.kind === "error" ? "bg-crit-wash" : "bg-ok-wash",
                  )}
                >
                  {feedback.kind === "error" ? (
                    <IconAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-crit-fg" />
                  ) : (
                    <IconCheckCircle aria-hidden className="mt-0.5 size-4 shrink-0 text-ok-fg" />
                  )}
                  <span className="min-w-0 flex-1">{feedback.text}</span>
                </p>
              </div>
            )}
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


/** «Cargando…» o el error con reintento, para los tres bloques del modal. */
function ReprogramLoadState({
  error,
  onRetry,
  small,
}: {
  error: string | null;
  onRetry: () => void;
  small?: boolean;
}) {
  const size = small ? "text-[13px]" : "text-sm";
  if (!error) return <p className={cn(size, "text-ink-500")}>Cargando…</p>;
  return (
    <p role="alert" className={cn(size, "text-crit-fg")}>
      {error}{" "}
      <button type="button" onClick={onRetry} className="font-semibold text-brand-700 underline underline-offset-2">
        Reintentar
      </button>
    </p>
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
    <section aria-labelledby="guia-historial" className={SECTION_CARD}>
      <SectionHead
        id="guia-historial"
        title="Historial desde el origen"
        help="Todas las guías de esta reprogramación, de la primera a la actual."
        aside={
          <Badge>
            {guides.length} {guides.length === 1 ? "guía" : "guías"}
          </Badge>
        }
      />

      {/* Una guía por zona, de borde a borde; entre una y la siguiente, la
          transferencia dicha en palabras. */}
      {guides.map((guide, guideIndex) => (
        <div key={guide.id} className={cn(guideIndex === 0 ? "pt-4" : CARD_ZONE, "pb-1")}>
          {guideIndex > 0 && (
            <p className="mb-3 flex items-center gap-1.5 text-[13px] leading-5 text-ink-500">
              <IconArrowRight aria-hidden className="size-3.5 text-ink-500" />
              Transferida a una nueva guía Swayp
            </p>
          )}
          <article aria-label={`${guideIndex === 0 ? "Guía original" : `Reprogramación ${guideIndex}`} ${guide.guide_code}`}>
            <header className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-sm font-semibold text-ink-900">
                    {guideIndex === 0 ? "Guía original" : `Reprogramación ${guideIndex}`}
                  </span>
                  <Badge>
                    {guide.courier === "fenix"
                      ? guide.created_via === "fenix_directo"
                        ? "Swayp directa"
                        : "Swayp"
                      : "Aliclik"}
                  </Badge>
                  {guide.is_current && <Badge tone="brand">Vista actual</Badge>}
                </div>
                <p className="mt-0.5 whitespace-nowrap font-mono text-[13px] font-medium leading-5 text-ink-700">
                  {guide.guide_code}
                </p>
              </div>
              <StatusBadge category={guide.status_category} status={guide.delivery_status} />
            </header>

            {guide.calls.length === 0 ? (
              <p className="mt-2 text-[13px] leading-5 text-ink-500">Sin gestiones registradas en esta guía.</p>
            ) : (
              <ul className="-mx-4 mt-2 divide-y divide-line border-t border-line sm:-mx-5">
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
    // Sin `catch`, una acción que LANZA (red caída, sesión vencida) dejaba
    // «Guardando…» puesto para siempre y la nota sin avisar de nada.
    const res = await updateShipmentCallNote(call.id, draft).catch(() => ({
      error: "No se pudo guardar la nota. Revisa la conexión e inténtalo de nuevo.",
    }));
    setSaving(false);
    if (res.error) {
      setError(res.error);
      return;
    }
    setEditing(false);
    onSaved();
  }

  return (
    <li className="px-4 py-3 sm:px-5">
      <div className="flex items-start justify-between gap-3">
        <span className="text-sm font-medium leading-5 text-ink-900">
          {shipmentHistoryLabel(call)}
          {call.new_status ? <span className="font-normal text-ink-600"> → {labelOf(call.new_status)}</span> : ""}
        </span>
        <span className="shrink-0 text-right text-[13px] leading-5 tabular-nums text-ink-500">
          {occurredAt && <span className="block">{occurredAt}</span>}
          {call.agent_name && <span className="block">{call.agent_name}</span>}
        </span>
      </div>

      {editing ? (
        <div className="mt-2 space-y-2">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={2}
            autoFocus
            aria-label="Nota de la gestión"
            className={DRAWER_TEXTAREA}
            placeholder="Nota de la gestión…"
          />
          {error && <p role="alert" className="text-[13px] leading-5 text-crit-fg">{error}</p>}
          <div className="flex items-center gap-2">
            <OpsButton size="sm" variant="primary" onClick={save} disabled={saving} className="pointer-coarse:h-11">
              {saving ? "Guardando…" : "Guardar"}
            </OpsButton>
            <OpsButton
              size="sm"
              variant="ghost"
              onClick={() => {
                setEditing(false);
                setDraft(call.note ?? "");
                setError(null);
              }}
              disabled={saving}
              className="pointer-coarse:h-11"
            >
              Cancelar
            </OpsButton>
          </div>
        </div>
      ) : (
        <div className="mt-0.5 flex items-start justify-between gap-3">
          <p className="max-w-[68ch] text-[13px] leading-5 text-ink-700">
            {call.note || <span className="text-ink-500">Sin nota</span>}
          </p>
          {call.id && (
            <OpsButton
              size="sm"
              variant="ghost"
              onClick={() => {
                setDraft(call.note ?? "");
                setEditing(true);
              }}
              className="-my-1 shrink-0 pointer-coarse:h-11"
            >
              Editar
            </OpsButton>
          )}
        </div>
      )}

      {call.note_edited_at && !editing && (
        <p className="mt-0.5 text-[13px] leading-5 text-ink-500">
          editada
          {call.note_editor_name ? ` por ${call.note_editor_name}` : ""}
          {editedAt ? ` · ${editedAt}` : ""}
        </p>
      )}

      {call.next_followup_at && (
        <p className="mt-0.5 text-[13px] leading-5 tabular-nums text-ink-500">
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

/** El par etiqueta / valor de la ficha del cajón: 13 px `ink-500` sobre 14 px `ink-900`. */
function Field({
  label,
  value,
  clamp,
  capitalize,
}: {
  label: string;
  value: string | null | undefined;
  /** Truncate long values (e.g. a product name) to 2 lines instead of
   *  eating the drawer's vertical space — full text still on hover. */
  clamp?: boolean;
  /** La ciudad llega como clave de cobertura en minúsculas («arequipa»). */
  capitalize?: boolean;
}) {
  return (
    <div className="min-w-0">
      <dt className={DRAWER_KEY}>{label}</dt>
      <dd
        className={cn("text-sm leading-5 text-ink-900", clamp && "line-clamp-2", capitalize && "capitalize")}
        title={clamp ? (value ?? undefined) : undefined}
      >
        {value || <span className="text-ink-500">—</span>}
      </dd>
    </div>
  );
}

/** Una celda del marco de cifras del cajón, sobre `wash`. */
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
    <div className="min-w-0 bg-wash px-3 py-2.5">
      <dt className="truncate text-[13px] leading-5 text-ink-600">{label}</dt>
      <dd
        className={cn(
          "text-sm font-semibold leading-5 tabular-nums",
          tone === "positive"
            ? "text-ok-fg"
            : tone === "warning"
              ? "text-warn-fg"
              : tone === "negative"
                ? "text-crit-fg"
                : "text-ink-900",
        )}
      >
        {value || "—"}
      </dd>
    </div>
  );
}

/** La etiqueta de un dato de solo lectura del cajón. */
const DRAWER_KEY = "text-[13px] leading-5 text-ink-500";
/** Etiqueta de campo del cajón: 13 px peso 500 sobre el control. */
const DRAWER_LABEL = "grid gap-1.5 text-[13px] font-medium text-ink-700";
const DRAWER_INPUT = cn(FIELD, "font-normal pointer-coarse:h-11");
const DRAWER_TEXTAREA = cn(FIELD_BOX, "w-full px-3 py-2 font-normal leading-5");
/** Una nota de apoyo dentro de una tarjeta, sobre `wash`. */
const DRAWER_NOTE = "rounded-md bg-wash px-3 py-2 text-[13px] leading-relaxed text-ink-600";
/**
 * La tarjeta de la acción del momento: la de sección con el anillo azul de 2 px,
 * como la próxima acción de la ficha del pedido.
 */
const ACTION_CARD = "rounded-lg bg-white p-4 shadow-control ring-2 ring-brand-600 sm:p-5";

/**
 * The Aliclik NOTA parse can guess an order reference before it's actually
 * linked (matched=false) — but that guess is unverified (no phone check), so
 * it's never shown as if it were a real pedido. Only a confirmed vínculo
 * renders here; the guess still prefills the search box in OrderLinkPicker,
 * where it's verified against the phone before linking.
 */
function OrderNameLabel({ name, matched }: { name: string | null; matched: boolean }) {
  if (matched && name) return <>{name}</>;
  return <span className="text-ink-500">—</span>;
}

function ShipmentOrderItems({ order }: { order: ShipmentOrderDetail }) {
  const units = order.line_items.reduce(
    (total, item) => total + Math.max(0, item.quantity || 0),
    0,
  );

  return (
    <div>
      <div className="flex items-center justify-between gap-3">
        <p className="text-[13px] font-medium leading-5 text-ink-700">Productos de Shopify</p>
        {order.line_items.length > 0 && (
          <p className="shrink-0 text-[13px] leading-5 tabular-nums text-ink-500">
            {order.line_items.length} {order.line_items.length === 1 ? "producto" : "productos"}
            {" · "}
            {units} {units === 1 ? "unidad" : "unidades"}
          </p>
        )}
      </div>

      {/* Mismo bloque que el Master de Pedidos. Estaba escrito dos veces, las
          dos sin variante ni precio, y divergiendo: acá se mostraba el SKU y
          allá no. Uno solo, o vuelven a separarse. */}
      <OrderLineItems items={order.line_items} className="mt-2" />
    </div>
  );
}


// ── Métricas de reprogramación Kapta→Swayp ───────────────────────────────────

/** Una cifra entera en es-PE («1,984»), como las tarjetas de vista. */
function fmtCount(n: number): string {
  return n.toLocaleString("es-PE");
}

function pctLabel(tasa: number | null): string | null {
  return tasa == null ? null : `${Math.round(tasa * 100)}%`;
}

/**
 * Las tablas del resumen: cifras a la derecha, hairlines de borde a borde del
 * panel (los márgenes negativos son su relleno) y la primera columna con el
 * nombre.
 */
const MINI_TH =
  "border-y border-line px-3 py-2 text-right text-xs font-semibold text-ink-600 first:pl-4 first:text-left last:pr-4 sm:first:pl-5 sm:last:pr-5";
const MINI_TD =
  "border-b border-line px-3 py-2 text-right tabular-nums first:pl-4 first:text-left last:pr-4 sm:first:pl-5 sm:last:pr-5";
/** Un panel del resumen plegable: título de 14 px y su contenido, sin marco propio. */
const SUMMARY_PANEL = "px-4 py-4 sm:px-5";

/** Una cifra del resumen: etiqueta, número y, si hace falta, su nota. */
function SummaryFigure({
  label,
  value,
  note,
  warn,
}: {
  label: string;
  value: number;
  note?: string;
  warn?: boolean;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-[13px] text-ink-500">{label}</dt>
      <dd className="text-xl font-semibold leading-7 tabular-nums text-ink-900">{value.toLocaleString("es-PE")}</dd>
      {note && (
        <dd className={cn("text-[13px] leading-5 tabular-nums", warn ? "font-medium text-warn-fg" : "text-ink-500")}>
          {note}
        </dd>
      )}
    </div>
  );
}

/** «Del … al …»: los dos días de un rango a medida. */
function RangeFields({
  value,
  max,
  onChange,
}: {
  value: { from: string; to: string };
  max: string;
  onChange: (next: { from: string; to: string }) => void;
}) {
  const field = cn(FIELD_BOX, "h-8 w-auto px-2 tabular-nums pointer-coarse:h-11");
  return (
    <div className="flex flex-wrap items-center gap-2 text-[13px] text-ink-600">
      <span aria-hidden="true">Del</span>
      <input
        type="date"
        aria-label="Desde"
        value={value.from}
        max={value.to}
        onChange={(e) => onChange({ ...value, from: e.target.value || value.from })}
        className={field}
      />
      <span aria-hidden="true">al</span>
      <input
        type="date"
        aria-label="Hasta"
        value={value.to}
        min={value.from}
        max={max}
        onChange={(e) => onChange({ ...value, to: e.target.value || value.to })}
        className={field}
      />
    </div>
  );
}

/** Snapshot de hoy: productividad por asesora en Repro Provincia (gestiones +
 *  resultados del día), para que cada persona mande una "foto" de su trabajo al
 *  final del día. */
function TodayByAgentPanel({ rows }: { rows: ReproDayAgentNamed[] }) {
  const day = new Date().toLocaleDateString("es-PE", {
    weekday: "long",
    day: "2-digit",
    month: "short",
    timeZone: "America/Lima",
  });
  const hoy = day.charAt(0).toUpperCase() + day.slice(1);
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
  /**
   * El correo se acorta SOLO si lo que llegó es un correo. Cortando por «@» a
   * ciegas, una fila decía «mariannys» y la de al lado «Mariannys Pérez» según
   * si la capa de acceso había resuelto el nombre — en la tabla que se comparte
   * al cierre del día.
   */
  const label = (name: string) => {
    if (!name.includes("@")) return name;
    const user = name.split("@")[0] || name;
    return user.replace(/[._-]+/g, " ").replace(/\b\p{Ll}/gu, (c) => c.toUpperCase());
  };

  return (
    <div className={SUMMARY_PANEL}>
      <h3 className="text-sm font-semibold text-ink-900">
        Hoy por asesora <span className="font-normal text-ink-500">· {hoy}</span>
      </h3>
      {rows.length === 0 ? (
        <p className="mt-1 text-[13px] text-ink-500">Aún no hay gestión registrada hoy.</p>
      ) : (
        <>
          <div className="-mx-4 mt-3 overflow-x-auto sm:-mx-5">
            <table className="w-full border-separate border-spacing-0 text-sm">
              <thead>
                <tr>
                  <th className={MINI_TH}>Asesora</th>
                  <th className={MINI_TH}>Gestiones</th>
                  <th className={MINI_TH}>Reprogramadas</th>
                  <th className={MINI_TH}>Anuladas</th>
                  <th className={MINI_TH}>Entregadas</th>
                  <th className={MINI_TH}>Guías</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.agent}>
                    <td className={cn(MINI_TD, "text-ink-900")}>
                      {label(r.name)}
                      {isVoiceAgentKey(r.agent) && (
                        <Badge tone="info" className="ml-1.5 align-middle">
                          IA
                        </Badge>
                      )}
                    </td>
                    <td className={cn(MINI_TD, "font-semibold text-ink-900")}>{fmtCount(r.gestiones)}</td>
                    <td className={cn(MINI_TD, "text-info-fg")}>{fmtCount(r.reprogramadas)}</td>
                    <td className={cn(MINI_TD, "text-ink-500")}>{fmtCount(r.anuladas)}</td>
                    <td className={cn(MINI_TD, "text-ok-fg")}>{fmtCount(r.entregadas)}</td>
                    <td className={cn(MINI_TD, "text-ink-700")}>{fmtCount(r.guias)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="font-medium text-ink-700">
                  <td className={MINI_TD}>Total equipo</td>
                  <td className={cn(MINI_TD, "font-semibold text-ink-900")}>{fmtCount(totals.gestiones)}</td>
                  <td className={MINI_TD}>{fmtCount(totals.reprogramadas)}</td>
                  <td className={MINI_TD}>{fmtCount(totals.anuladas)}</td>
                  <td className={MINI_TD}>{fmtCount(totals.entregadas)}</td>
                  <td className={MINI_TD}>{fmtCount(totals.guias)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
          {/* Lo que antes solo decía un tooltip: con teclado o en táctil no
              existía. Una línea, visible, y las cabeceras sin abreviar. */}
          <p className="mt-3 max-w-[110ch] text-[13px] leading-5 text-ink-500">
            Gestiones: llamadas y reprogramaciones registradas hoy · Reprogramadas: confirmadas y en ruta ·
            Anuladas: la clienta canceló · Entregadas: cerradas por el resultado del courier · Guías: distintas
            tocadas hoy · Agente Daaph, Agente Telnyx y Agente ElevenLabs: el agente de voz IA por distintas líneas y
            motores; cada llamada suya es una gestión.
          </p>
        </>
      )}
    </div>
  );
}

/** «Agentes de voz: comparación» (MOM §11.8): los agentes que compiten, uno al
 *  lado del otro, solo con llamadas reales. Los mismos chips de rango que el
 *  popup de reprogramaciones; hoy llega con la página y el resto se pide. */
function VoiceScorePanel({ initial }: { initial: VoiceScoreRow[] }) {
  const today = limaTodayKey();
  const [preset, setPreset] = useState<ReprogramPreset>("hoy");
  const [custom, setCustom] = useState({ from: today, to: today });
  const { from, to } = reprogramPresetRange(preset, custom);
  const key = `${from}|${to}`;
  const [loaded, setLoaded] = useState<Record<string, VoiceScoreRow[] | "error">>({ [`${today}|${today}`]: initial });
  const result = loaded[key];

  useEffect(() => {
    if (result) return;
    let alive = true;
    loadVoiceScore(from, to)
      .then((rows) => alive && setLoaded((m) => ({ ...m, [key]: rows ?? "error" })))
      .catch(() => alive && setLoaded((m) => ({ ...m, [key]: "error" })));
    return () => {
      alive = false;
    };
  }, [key, from, to, result]);

  const rows = Array.isArray(result) ? result : null;
  // Cifras en es-PE, como el resto del panel: coma de miles y punto decimal.
  // Se escribía «5,5» y «$6,42» al lado de «3,089».
  const pct = (n: number | null) => (n == null ? "—" : `${Math.round(n * 100)}%`);
  const per = (n: number | null) =>
    n == null ? "—" : n.toLocaleString("es-PE", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const usd = (n: number | null) =>
    n == null ? "—" : `US$ ${n.toLocaleString("es-PE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  return (
    <div className={SUMMARY_PANEL}>
      <h3 className="text-sm font-semibold text-ink-900">
        Agentes de voz: comparación{" "}
        <span className="font-normal tabular-nums text-ink-500">· {from === to ? from : `${from} al ${to}`}</span>
      </h3>
      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
        <div role="group" aria-label="Rango" className="flex flex-wrap items-center gap-1.5">
          {REPROGRAM_PRESETS.map((p) => (
            <ChoiceChip key={p.key} label={p.label} active={preset === p.key} onClick={() => setPreset(p.key)} />
          ))}
        </div>
        {preset === "rango" && <RangeFields value={custom} max={today} onChange={setCustom} />}
      </div>
      <div className="-mx-4 mt-3 overflow-x-auto sm:-mx-5">
        <table className="w-full border-separate border-spacing-0 text-sm">
          <thead>
            <tr>
              <th className={MINI_TH}>Agente</th>
              <th className={MINI_TH}>Llamadas</th>
              <th className={MINI_TH}>Atendidas</th>
              <th className={MINI_TH}>Sin gestión</th>
              <th className={MINI_TH}>Confirma</th>
              <th className={MINI_TH}>Programa</th>
              <th className={MINI_TH}>Cancela</th>
              <th className={MINI_TH}>Guías Swayp</th>
              <th className={MINI_TH}>Confirma / atendidas</th>
              <th className={MINI_TH}>Llamadas por confirma</th>
              <th className={MINI_TH}>Costo línea</th>
              <th className={MINI_TH}>Costo por confirma</th>
            </tr>
          </thead>
          <tbody>
            {!rows && (
              <tr>
                <td colSpan={12} className="px-4 py-3 text-[13px] text-ink-500 sm:px-5">
                  {result === "error" ? "No se pudo leer este rango." : "Cargando…"}
                </td>
              </tr>
            )}
            {rows?.map((r) => (
              <tr key={r.agent} className={r.llamadas ? "text-ink-700" : "text-ink-500"}>
                <td className={cn(MINI_TD, r.llamadas > 0 && "text-ink-900")}>{r.name}</td>
                <td className={cn(MINI_TD, "font-semibold", r.llamadas > 0 && "text-ink-900")}>{fmtCount(r.llamadas)}</td>
                <td className={MINI_TD}>{fmtCount(r.atendidas)}</td>
                <td className={cn(MINI_TD, r.sinGestion > 0 && "text-warn-fg")}>{fmtCount(r.sinGestion)}</td>
                <td className={cn(MINI_TD, r.confirma > 0 && "text-ok-fg")}>{fmtCount(r.confirma)}</td>
                <td className={MINI_TD}>{fmtCount(r.programar)}</td>
                <td className={cn(MINI_TD, "text-ink-500")}>{fmtCount(r.cancela)}</td>
                <td className={MINI_TD}>{fmtCount(r.guias)}</td>
                <td className={cn(MINI_TD, "font-semibold")}>{pct(voiceConversion(r))}</td>
                <td className={MINI_TD}>{per(voiceCallsPerConfirma(r))}</td>
                <td className={cn(MINI_TD, "whitespace-nowrap")}>
                  {r.conCosto ? usd(r.costo) : "—"}
                  {r.conCosto > 0 && r.conCosto < r.llamadas && (
                    <span className="ml-1 text-xs text-ink-500">
                      ({fmtCount(r.conCosto)} de {fmtCount(r.llamadas)})
                    </span>
                  )}
                </td>
                <td className={MINI_TD}>{usd(voiceCostPerConfirma(r))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-3 max-w-[110ch] text-[13px] leading-5 text-ink-500">
        Solo llamadas reales (no las de prueba) · Atendidas: la clienta habló con el agente · Sin gestión: atendió
        pero se cortó sin que el agente registrara un resultado · Guías Swayp: salidas creadas por sus «confirma» ·
        Costo línea: lo que Telnyx avisó que cobró (los dos tramos; sin el minuto de xAI ni de ElevenLabs).
        Zadarma no lo avisa, por eso Daaph sale con guion · Agente Daaph: Zadarma + Grok · Agente Telnyx:
        Telnyx + Grok · Agente ElevenLabs: Telnyx + ElevenLabs.
      </p>
    </div>
  );
}

/** La tasa de entrega de lo reprogramado en Kapta (guías Swayp hijas) en los
 *  últimos 30 días, en cinco cifras. «Ver detalle» abre el análisis por rango. */
function ReprogramStrip({ stats, stores }: { stats: ReprogramStats; stores: StoreSummary[] }) {
  const [open, setOpen] = useState(false);
  if (!stats.historico.total) {
    return (
      <div className={SUMMARY_PANEL}>
        <h3 className="text-sm font-semibold text-ink-900">Reprogramados en Kapta</h3>
        <p className="mt-1 text-[13px] text-ink-500">
          Todavía ninguna. Aparecerá en cuanto se confirme la primera reprogramación.
        </p>
      </div>
    );
  }
  const c = stats.last30;
  const pct = pctLabel(c.tasa);
  return (
    <>
      <div className={SUMMARY_PANEL}>
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
          <h3 className="text-sm font-semibold text-ink-900">
            Reprogramados en Kapta <span className="font-normal text-ink-500">· últimos 30 días</span>
          </h3>
          <OpsButton variant="ghost" size="sm" onClick={() => setOpen(true)} className="-my-1 pointer-coarse:h-11">
            Ver detalle
            <IconArrowRight className="text-ink-500" />
          </OpsButton>
        </div>
        <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3 lg:flex lg:flex-wrap lg:gap-x-12">
          <SummaryFigure label="Reprogramaciones" value={c.total} />
          <SummaryFigure label="Entregados" value={c.entregados} note={pct ? `${pct} de los cerrados` : undefined} />
          <SummaryFigure label="Por Swayp" value={c.entregadosFenix} />
          <SummaryFigure label="Anulados" value={c.anulados} />
          <SummaryFigure
            label="En curso"
            value={c.enCurso}
            note={c.enCursoViejos > 0 ? `${c.enCursoViejos} varados +${REPROGRAM_STALE_DAYS} d` : undefined}
            warn
          />
        </dl>
      </div>
      {open && <ReprogramModal stats={stats} stores={stores} onClose={() => setOpen(false)} />}
    </>
  );
}

function ReprogramCountsRow({ label, c }: { label: string; c: ReprogramCounts }) {
  const pct = pctLabel(c.tasa);
  return (
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-[13px] tabular-nums">
      <span className="w-28 shrink-0 truncate text-sm font-medium text-ink-900">{label}</span>
      <span className="text-ink-900">{fmtCount(c.total)} reprogramadas</span>
      <span className="text-ok-fg">{fmtCount(c.entregados)} entregados</span>
      {c.entregadosFenix > 0 && <span className="text-ink-700">{fmtCount(c.entregadosFenix)} por Swayp</span>}
      <span className="text-ink-500">{fmtCount(c.anulados)} anulados</span>
      <span className="text-ink-500">{fmtCount(c.enCurso)} en curso</span>
      {c.enCursoViejos > 0 && <span className="font-medium text-warn-fg">{fmtCount(c.enCursoViejos)} varados</span>}
      <span className="ml-auto text-sm font-semibold text-ink-900">{pct ?? "—"}</span>
    </div>
  );
}

type ReprogramPreset = "hoy" | "ayer" | "7d" | "mes" | "rango";
const REPROGRAM_PRESETS: { key: ReprogramPreset; label: string }[] = [
  { key: "hoy", label: "Hoy" },
  { key: "ayer", label: "Ayer" },
  { key: "7d", label: "Últimos 7 días" },
  { key: "mes", label: "Este mes" },
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
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retryKey, setRetryKey] = useState(0);
  const [preset, setPreset] = useState<ReprogramPreset>("hoy");
  const today = limaTodayKey();
  const [custom, setCustom] = useState({ from: today, to: today });

  useEffect(() => {
    let alive = true;
    setLoadError(null);
    // Sin `catch`, una carga fallida dejaba «Cargando…» para siempre en los tres
    // bloques del modal, sin decir qué pasó ni permitir reintentar.
    loadReprogramData()
      .then((d) => {
        if (alive) setData(d);
      })
      .catch(() => {
        if (alive) setLoadError("No pudimos cargar el detalle. Revisa la conexión e inténtalo de nuevo.");
      });
    return () => {
      alive = false;
    };
  }, [retryKey]);

  function retry() {
    setData(null);
    setRetryKey((k) => k + 1);
  }

  // Mismo teclado que el cajón de la guía: una sola función (`useDialogKeys`).
  const panelRef = useRef<HTMLDivElement>(null);
  useDialogKeys(panelRef, onClose);

  const { from, to } = reprogramPresetRange(preset, custom);
  const asesorNames = data?.asesorNames ?? stats.asesorNames;
  const ranged = data
    ? (() => {
        const { startMs, endMs } = limaRangeBounds(from, to);
        return reprogramRangeStats(data.rows, startMs, endMs, Date.now());
      })()
    : null;
  const range = presetLabel(preset);

  return (
    <div className="fixed inset-0 z-30 grid place-items-center bg-ink-900/30 p-4" onClick={onClose}>
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="reprogram-modal-title"
        tabIndex={-1}
        className="max-h-[85vh] w-full max-w-xl overflow-y-auto overscroll-contain rounded-lg bg-white shadow-pop outline-none"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="sticky top-0 z-10 flex items-start justify-between gap-3 border-b border-line bg-white px-5 pb-3 pt-4">
          <h2 id="reprogram-modal-title" className="text-lg font-semibold leading-7 text-ink-900">
            Reprogramaciones (Aliclik + Swayp)
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Cerrar"
            className="-mr-1.5 grid size-8 shrink-0 place-items-center rounded-md text-ink-500 transition-colors hover:bg-wash hover:text-ink-900 pointer-coarse:size-11"
          >
            <IconClose />
          </button>
        </header>

        <div className="space-y-6 px-5 py-4">
          {/* Chips de rango — para monitorear qué se está gestionando. */}
          <div className="space-y-2">
            <div role="group" aria-label="Rango" className="flex flex-wrap items-center gap-1.5">
              {REPROGRAM_PRESETS.map((p) => (
                <ChoiceChip key={p.key} label={p.label} active={preset === p.key} onClick={() => setPreset(p.key)} />
              ))}
            </div>
            {preset === "rango" && <RangeFields value={custom} max={today} onChange={setCustom} />}
            <div className="divide-y divide-line rounded-md ring-1 ring-line">
              <div className="px-3 py-2.5">
                {ranged ? (
                  <ReprogramCountsRow
                    label={from === to ? from.slice(5) : `${from.slice(5)}–${to.slice(5)}`}
                    c={ranged.counts}
                  />
                ) : (
                  <ReprogramLoadState error={loadError} onRetry={retry} />
                )}
              </div>
              <div className="px-3 py-2.5">
                <ReprogramCountsRow label="Histórico" c={stats.historico} />
              </div>
            </div>
          </div>

          {/* Tendencia semanal (semana = lunes local). Barra = reprogramados; el
              tramo verde son los que YA terminaron entregados.

              DOS DE LAS TRES CIFRAS VIVÍAN SOLO EN EL `title`: entregados y
              anulados no se podían leer sin ratón ni con lector de pantalla, y en
              teléfono no existe el hover. Ahora la tabla equivalente está debajo,
              plegada, y las barras son decoración anunciada como tal. */}
          <div>
            <h3 className="text-sm font-semibold text-ink-900">Últimas 8 semanas</h3>
            <p className="text-[13px] text-ink-500">La barra son las reprogramaciones; el tramo verde, las ya entregadas.</p>
            <div className="mt-2 flex items-end gap-1.5" aria-hidden="true">
              {stats.semanas.map((w) => {
                const h = Math.round((w.total / maxWeek) * 64);
                const hOk = w.total ? Math.round((w.entregados / w.total) * h) : 0;
                return (
                  <div key={w.start} className="flex flex-1 flex-col items-center gap-0.5">
                    <span className="text-xs tabular-nums text-ink-500">{w.total ? fmtCount(w.total) : ""}</span>
                    <div className="flex w-full flex-col justify-end overflow-hidden rounded-sm bg-wash" style={{ height: 64 }}>
                      <div className="w-full bg-line-strong" style={{ height: Math.max(0, h - hOk) }} />
                      <div className="w-full bg-ok-fg" style={{ height: hOk }} />
                    </div>
                    <span className="text-xs tabular-nums text-ink-500">{weekLabel(w.start)}</span>
                  </div>
                );
              })}
            </div>
            {/* Grupo con nombre: el modal vive dentro del resumen plegable, que
                también es un <details> abierto. */}
            <details className="group/weeks mt-2">
              <summary className="inline-flex cursor-pointer list-none items-center gap-1 text-[13px] font-medium text-brand-700 [&::-webkit-details-marker]:hidden">
                <IconChevronRight
                  aria-hidden
                  className="size-3.5 transition-transform duration-150 group-open/weeks:rotate-90 motion-reduce:transition-none"
                />
                Ver las 8 semanas en números
              </summary>
              <table className="mt-1.5 w-full text-[13px]">
                <thead>
                  <tr className="text-left text-ink-600">
                    <th className="py-1 pr-2 font-semibold">Semana</th>
                    <th className="py-1 pr-2 text-right font-semibold">Reprogramados</th>
                    <th className="py-1 pr-2 text-right font-semibold">Entregados</th>
                    <th className="py-1 text-right font-semibold">Anulados</th>
                  </tr>
                </thead>
                <tbody className="tabular-nums text-ink-700">
                  {stats.semanas.map((w) => (
                    <tr key={w.start} className="border-t border-line">
                      <td className="py-1 pr-2">{weekLabel(w.start)}</td>
                      <td className="py-1 pr-2 text-right">{fmtCount(w.total)}</td>
                      <td className="py-1 pr-2 text-right text-ok-fg">{fmtCount(w.entregados)}</td>
                      <td className="py-1 text-right">{fmtCount(w.anulados)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </details>
          </div>

          <div>
            <h3 className="text-sm font-semibold text-ink-900">
              Por tienda <span className="font-normal text-ink-500">· {range}</span>
            </h3>
            <div className="mt-2 divide-y divide-line">
              {ranged ? (
                Object.entries(ranged.porTienda).length ? (
                  Object.entries(ranged.porTienda)
                    .sort((a, b) => b[1].total - a[1].total)
                    .map(([sid, c]) => (
                      <div key={sid} className="py-2">
                        <ReprogramCountsRow label={storeName(sid)} c={c} />
                      </div>
                    ))
                ) : (
                  <p className="text-[13px] text-ink-500">Sin reprogramaciones en este rango.</p>
                )
              ) : (
                <ReprogramLoadState error={loadError} onRetry={retry} small />
              )}
            </div>
          </div>

          <div>
            <h3 className="text-sm font-semibold text-ink-900">
              Por asesor <span className="font-normal text-ink-500">· {range}</span>
            </h3>
            <div className="mt-2 divide-y divide-line">
              {ranged ? (
                Object.entries(ranged.porAsesor).length ? (
                  Object.entries(ranged.porAsesor)
                    .sort((a, b) => b[1].total - a[1].total)
                    .map(([uid, c]) => (
                      <div key={uid} className="py-2">
                        <ReprogramCountsRow
                          label={uid === REPROGRAM_UNASSIGNED ? "Sin asignar" : asesorNames[uid] ?? uid}
                          c={c}
                        />
                      </div>
                    ))
                ) : (
                  <p className="text-[13px] text-ink-500">Sin reprogramaciones en este rango.</p>
                )
              ) : (
                <ReprogramLoadState error={loadError} onRetry={retry} small />
              )}
            </div>
          </div>

          <p className="border-t border-line pt-4 text-[13px] leading-5 text-ink-500">
            Universo: reprogramaciones confirmadas en el dashboard — <b className="font-semibold text-ink-700">Aliclik</b> (la
            guía sigue en Aliclik) y <b className="font-semibold text-ink-700">Swayp</b> (antes Fénix; se creó una guía Swayp); las
            entregas de primer intento no entran. <b className="font-semibold text-ink-700">Por Swayp</b> es el subconjunto de
            entregados que salió por una guía Swayp. Los cortes por rango usan la fecha en que se confirmó la
            reprogramación. La <b className="font-semibold text-ink-700">tasa</b> es entregados ÷ cerrados (entregados +
            anulados) — lo en curso no la afecta. <b className="font-semibold text-ink-700">Varados</b>: en curso hace más de{" "}
            {REPROGRAM_STALE_DAYS} días, probables anulados sin confirmar.
          </p>
        </div>
      </div>
    </div>
  );
}

function presetLabel(preset: ReprogramPreset): string {
  return REPROGRAM_PRESETS.find((p) => p.key === preset)?.label.toLowerCase() ?? "rango";
}
