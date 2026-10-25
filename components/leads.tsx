"use client";

import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import type { LeadCallRow, LeadRow, StoreSummary } from "@/lib/types";
import type { AdMeta } from "@/lib/meta-ads";
import {
  IconAlert,
  IconCheck,
  IconDownload,
  IconFlash,
  IconLock,
  IconMoney,
  IconPhone,
  IconSearch,
  IconWhatsApp,
  IconX,
} from "@/components/icons";
import { waKindLabel, waLabel, type WaNumber } from "@/lib/wa-numbers";
import {
  ALL_STORES,
  type CustomerHistory,
  type LeadCounts,
  type LeadView,
  type StoreScope,
} from "@/lib/leads-access";
import { facetItems } from "@/lib/leads-facets";
import { LEAD_COVERAGES, countLeadCoverage, leadCoverage, type LeadCoverage } from "@/lib/lead-coverage";
import type { DistrictCoverageRule } from "@/lib/district-coverage";
import { scoringProfileFor, sortLeadsByPriorityScoped } from "@/lib/lead-priority";
import { PENDING_VOUCHER_LABEL, pendingVoucherHref } from "@/lib/pending-voucher";
import {
  countLeadUrgency,
  goldenBreakdown,
  leadUrgency,
  tallyGolden,
  type UrgencyTier,
} from "@/lib/lead-urgency";
import type { LeadsInsights } from "@/lib/leads-insights";
import { FORCED_REFRESH_MS, decideQueueRefresh } from "@/lib/leads-live-refresh";
import { patchLeadRows, patchLeadCounts } from "@/lib/leads-local-update";
import {
  buildMetaAudienceCsv,
  buildMetaAudienceRows,
  metaAudienceFilename,
} from "@/lib/meta-audience";
import {
  LEAD_GESTIONES,
  QUEUE_BUCKETS,
  QUEUE_STATES,
  categoryOf,
  countGestiones,
  countQueueBuckets,
  countLeadWindows,
  countQueueStates,
  gestionOf,
  CLAIM_HEARTBEAT_MS,
  isClaimActive,
  leadAfter,
  shouldRenewClaim,
  isQueueBucket,
  labelOf,
  leadHook,
  leadQueueBucket,
  leadSegment,
  matchesLeadInteractionDate,
  leadWindowInfo,
  matchesQueueState,
  yapeKind,
  type LeadGestion,
  type LeadInteractionDateFilter,
  type LeadHookKind,
  type LeadWindow,
  type QueueBucket,
  type QueueState,
  type YapeKind,
  leadHandle,
  leadCanCall,
  canonicalProductHandles,
  leadProductHandle,
  productLabel,
} from "@/lib/leads";
import {
  loadLeadCustomerHistory,
  loadLeadDetail,
  loadLeadsInsightsPanel,
  pollLeadsQueue,
  searchLeads,
  loadLeadsForAudience,
} from "@/lib/leads-read-client";
import {
  openLeadDrawer,
  releaseLead,
  renewLeadClaim,
  resolveHandoff,
} from "@/app/dashboard/leads/actions";
import { claveAnuncio, handleDeAnuncioPara, type AdDeclaration } from "@/lib/ad-products";
import { cn } from "@/components/ui";
import {
  AttentionPill,
  Badge,
  Banner,
  CHECKBOX,
  ChoiceChip,
  FIELD_BOX,
  FilterPill,
  OpsButton,
  Skeleton,
  choiceChipClass,
  opsButtonClass,
  type BadgeTone,
} from "@/components/ops-ui";
import { ChoicePill } from "@/components/facet-pill";
import { Sheet } from "@/components/filter-sheet";
import { NextLeadCard, SegmentBadge, useNextLead } from "@/components/leads-next";
import { VentaTelefonica } from "@/components/venta-telefonica";
import type { LeadDrawerProps, LeadDrawerUpdate } from "@/components/leads-drawer";
import { reportClientPerformanceMetric } from "@/lib/client-performance";

const LeadsInsightsPanel = dynamic(
  () => import("@/components/leads-insights").then((module) => module.LeadsInsightsPanel),
  {
    ssr: false,
    // La misma forma que el tablero (el equipo a la izquierda, dos tarjetas a
    // la derecha) para que nada salte cuando llega el módulo.
    loading: () => (
      <section aria-busy="true" aria-label="Cargando el tablero">
        <div className="mb-2 h-5 w-32 animate-pulse rounded bg-wash motion-reduce:animate-none" />
        <div className="grid grid-cols-1 gap-3 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
          <div className="min-h-[360px] rounded-lg bg-white shadow-control ring-1 ring-line" />
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-1">
            <div className="min-h-[220px] rounded-lg bg-white shadow-control ring-1 ring-line" />
            <div className="min-h-[220px] rounded-lg bg-white shadow-control ring-1 ring-line" />
          </div>
        </div>
      </section>
    ),
  },
);

const loadLeadDrawerModule = () => import("@/components/leads-drawer");

const LeadDrawer = dynamic<LeadDrawerProps>(
  () => loadLeadDrawerModule().then((module) => module.LeadDrawer),
  {
    ssr: false,
    loading: () => <LeadDrawerLoading />,
  },
);

function LeadDrawerLoading() {
  return (
    <>
      <div className="fixed inset-0 z-40 bg-ink-900/20" aria-hidden="true" />
      <aside
        className="fixed inset-y-0 right-0 z-50 flex h-full w-full max-w-[1040px] flex-col bg-white shadow-popover"
        aria-label="Cargando la ficha del lead"
        aria-busy
      >
        <div className="px-5 py-4 shadow-[inset_0_-1px_0_var(--color-line)]">
          <Skeleton className="h-6 w-52" />
          <Skeleton className="mt-2 h-4 w-80 max-w-full" />
        </div>
        <div className="grid flex-1 place-items-center p-6 text-sm text-ink-500">Abriendo la ficha…</div>
      </aside>
    </>
  );
}
const DRAWER_START_MARK = "kapso:lead-drawer:start";
const DRAWER_END_MARK = "kapso:lead-drawer:ready";
const DRAWER_MEASURE = "kapso:lead-drawer-open";

function markLeadDrawerOpen() {
  if (typeof performance === "undefined") return;
  performance.clearMarks(DRAWER_START_MARK);
  performance.clearMarks(DRAWER_END_MARK);
  performance.clearMeasures(DRAWER_MEASURE);
  performance.mark(DRAWER_START_MARK);
}

function measureLeadDrawerReady() {
  if (typeof performance === "undefined" || !performance.getEntriesByName(DRAWER_START_MARK).length) return;
  performance.mark(DRAWER_END_MARK);
  performance.measure(DRAWER_MEASURE, DRAWER_START_MARK, DRAWER_END_MARK);
  const duration = performance.getEntriesByName(DRAWER_MEASURE).at(-1)?.duration;
  if (duration != null && process.env.NODE_ENV !== "test") {
    console.info(`[Kapso performance] Drawer listo en ${Math.round(duration)} ms`);
    reportClientPerformanceMetric(DRAWER_MEASURE, duration);
  }
}

/** Canonical acquisition-source bucket for a lead's `source` (Fuente filter). */
function leadSourceKey(
  s: string | null | undefined,
): "meta_ad" | "fb_web" | "cod_cart" | "abandoned_browse" | "organic" {
  return s === "meta_ad"
    ? "meta_ad"
    : s === "fb_web"
      ? "fb_web"
      : s === "cod_cart"
        ? "cod_cart"
        : s === "abandoned_browse"
          ? "abandoned_browse"
          : "organic";
}

/** Toggle inmutable de una clave en un Set (para estado de multi-select). */
function withToggled(s: Set<string>, key: string): Set<string> {
  const next = new Set(s);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}

function interactionDateFilterLabel(filter: LeadInteractionDateFilter): string {
  if (filter.kind === "older") return "Más de 7 días";
  return new Date(`${filter.date}T00:00:00.000Z`).toLocaleDateString("es-PE", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** Compact date for the leads table (no seconds, 24h) so the row fits at narrow
 *  widths — e.g. "24/06, 06:17". The drawer keeps the full fmtDate. */
function fmtDateShort(value: string | null | undefined): string {
  if (!value) return "—";
  return new Date(value).toLocaleString("es-PE", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

// Las vistas que no son la cola (DESIGN.md › Leads): chips con su contador en
// la primera fila, siempre a la vista.
const REVIEW_VIEWS: { key: "seguimientos" | "ganados" | "perdidos"; label: string }[] = [
  { key: "seguimientos", label: "Seguimientos" },
  { key: "ganados", label: "Ganados" },
  { key: "perdidos", label: "Perdidos" },
];

const VIEW_TITLE: Record<LeadView, string> = {
  por_llamar: "La cola",
  handoff: "Atender ahora",
  yape: "Yape / Shalom",
  seguimientos: "Seguimientos",
  ganados: "Ganados",
  perdidos: "Perdidos",
};

/** Chip de la cola con su contador y, en «En seguimiento», los que piden atención. */
function QueueChip({
  label,
  count,
  alert,
  active,
  onClick,
}: {
  label: string;
  count: number;
  alert?: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button type="button" aria-pressed={active} onClick={onClick} className={choiceChipClass(active)}>
      {label}
      <span className={cn("tabular-nums", active ? "text-brand-700" : "text-ink-500")}>{count.toLocaleString("es-PE")}</span>
      {/* Reencolados por ola, respuestas nuevas y seguimientos vencidos: la
          deuda se ve sin entrar a la pestaña. */}
      {!!alert && (
        <Badge tone="crit" title="Requieren atención: reencolados, respuestas nuevas o seguimientos vencidos">
          {alert.toLocaleString("es-PE")}
        </Badge>
      )}
    </button>
  );
}

/** Un grupo de chips con su nombre delante («Segmento», «Cobertura»). */
function ChipGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div role="group" aria-label={label} className="flex shrink-0 items-center gap-1.5">
      <span className="mr-1 text-xs font-medium text-ink-500">{label}</span>
      {children}
    </div>
  );
}

const SHEET_ROW =
  "flex min-h-9 cursor-pointer items-center gap-2.5 rounded-md px-2 text-sm text-ink-700 hover:bg-wash pointer-coarse:min-h-11";

/** Lista de casillas con contador para la hoja de «Más filtros» (Fuente, Producto, Número). */
function CheckList({
  label,
  options,
  selected,
  onToggle,
  searchable = false,
}: {
  label: string;
  options: { key: string; label: string; count?: number }[];
  selected: Set<string>;
  onToggle: (key: string) => void;
  searchable?: boolean;
}) {
  const [term, setTerm] = useState("");
  const t = term.trim().toLocaleLowerCase("es");
  const shown = t ? options.filter((o) => o.label.toLocaleLowerCase("es").includes(t)) : options;
  return (
    <div>
      {searchable && (
        <label className="relative mb-1.5 block">
          <span className="sr-only">Buscar en {label.toLocaleLowerCase("es")}</span>
          <IconSearch className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-ink-500" />
          <input
            value={term}
            onChange={(e) => setTerm(e.target.value)}
            placeholder={`Buscar ${label.toLocaleLowerCase("es")}`}
            className={cn(FIELD_BOX, "h-8 w-full pl-8 pr-3")}
          />
        </label>
      )}
      <ul className="-mx-1 grid max-h-56 gap-0.5 overflow-y-auto">
        {shown.map((o) => (
          <li key={o.key}>
            <label className={SHEET_ROW}>
              <input type="checkbox" className={CHECKBOX} checked={selected.has(o.key)} onChange={() => onToggle(o.key)} />
              <span className="min-w-0 flex-1 truncate">{o.label}</span>
              {o.count != null && <span className="shrink-0 text-xs tabular-nums text-ink-500">{o.count.toLocaleString("es-PE")}</span>}
            </label>
          </li>
        ))}
        {!shown.length && <li className="px-2 py-2 text-[13px] text-ink-500">Sin coincidencias.</li>}
      </ul>
    </div>
  );
}

/** Un bloque de la hoja: su nombre y lo que filtra. */
function SheetSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="border-t border-line pt-3 first:border-0 first:pt-0">
      <h3 className="mb-2 text-xs font-semibold text-ink-600">{title}</h3>
      {children}
    </section>
  );
}

// El "anzuelo": con qué abrir la llamada. Sin esto un lead frío es solo un
// nombre y nadie sabe cómo empezar, así que nunca se trabaja. Se muestra el
// producto que miraba, o el anuncio que lo trajo, o sus propias palabras.
const HOOK_DISPLAY: Record<LeadHookKind, { prefix: string; title: string }> = {
  producto: { prefix: "Carrito", title: "Producto que miraba / agregó al carrito" },
  anuncio: { prefix: "Anuncio", title: "Anuncio por el que llegó" },
  mensaje: { prefix: "Escribió", title: "Primer mensaje que escribió el cliente" },
};

function LeadHookLine({ lead }: { lead: LeadRow }) {
  const hook = leadHook(lead);
  if (!hook) return null;
  const d = HOOK_DISPLAY[hook.kind];
  return (
    <p title={`${d.title}: ${hook.text}`} className="mt-0.5 truncate text-[13px] leading-5 text-ink-600">
      <span className="text-ink-500">{d.prefix}:</span> {hook.kind === "mensaje" ? `«${hook.text}»` : hook.text}
    </p>
  );
}

/**
 * El motivo de la fila cuando espera la validación de su comprobante (MOM
 * §16.1): ocupa el renglón del anzuelo, porque lo que la asesora necesita
 * saber ya no es qué pidió sino que pagó y espera.
 */
function PendingVoucherLine({ voucher }: { voucher: NonNullable<LeadRow["pending_voucher"]> }) {
  const detalle = [
    voucher.orderName,
    voucher.amount > 0 ? `S/ ${voucher.amount.toFixed(2)}` : null,
  ].filter(Boolean).join(" · ");
  return (
    <p title={`${voucher.reason}${detalle ? ` · ${detalle}` : ""}`} className="mt-0.5 truncate text-[13px] leading-5 text-ink-600">
      <span className="text-ink-500">Motivo:</span> <span className="font-medium text-warn-fg">{voucher.reason}</span>
      {detalle && <span className="tabular-nums text-ink-500"> · {detalle}</span>}
    </p>
  );
}

// Gestión (estado de la llamada) → etiqueta y punto de la columna «Última gestión».
const GESTION_DISPLAY: Record<LeadGestion, { label: string; dot: string }> = {
  sin_llamar: { label: "Sin llamar", dot: "bg-white ring-1 ring-inset ring-warn-fg" },
  nr: { label: "No responde", dot: "bg-ink-500" },
  buzon_cuelga: { label: "Buzón / cuelga", dot: "bg-ink-500" },
  contactados: { label: "Contactado", dot: "bg-ok-fg" },
  sin_stock: { label: "Sin stock", dot: "bg-info-fg" },
};

// La edad manda el punto de la fila; la ventana de WhatsApp es un permiso de
// mensajería, no una probabilidad de cierre, y si pintara la fila un lead de
// doce minutos y uno de 67 días llevarían el mismo verde.
//
// El salto de color está donde está el acantilado medido: `dorada` es el único
// tramo con color fuerte, porque es el único donde llamar YA vale el doble. Los
// de abajo bajan de intensidad a propósito: si «tibia» compitiera con
// «dorada», volveríamos a tener cientos de filas gritando lo mismo.
const URGENCY_DISPLAY: Record<UrgencyTier, { dot: string; fg: string }> = {
  dorada: { dot: "bg-ok-fg", fg: "text-ok-fg" },
  tibia: { dot: "bg-warn-fg", fg: "text-ink-900" },
  enfriando: { dot: "bg-ink-500", fg: "text-ink-900" },
  fria: { dot: "bg-ink-300", fg: "text-ink-600" },
};
/** Sin edad calculable no se afirma urgencia: gris neutro y una raya. */
const URGENCY_UNKNOWN = { dot: "bg-line-strong", fg: "text-ink-500" };

// Yape/Shalom: si el handoff fue por pago (verificar Yape) o por agencia
// (coordinar Shalom/Olva). Se deriva del motivo del handoff.
const YAPE_KIND_BADGE: Record<YapeKind, { label: string; tone: BadgeTone; title: string }> = {
  pago: { label: "Pago", tone: "warn", title: "Verificar el pago (Yape / comprobante)" },
  agencia: { label: "Agencia", tone: "info", title: "Coordinar el envío por agencia (Shalom / Olva)" },
};

/** «Pago» / «Agencia» — solo para leads en Yape/Shalom (`yape_por_verificar`). */
function YapeKindBadge({ lead }: { lead: LeadRow }) {
  if (lead.status !== "yape_por_verificar") return null;
  const k = YAPE_KIND_BADGE[yapeKind(lead.handoff_reason, lead.handoff_context)];
  return (
    <Badge tone={k.tone} title={k.title}>
      {k.label}
    </Badge>
  );
}

/** Una fila de chips: cabe entera en 1280 px; si no, se desplaza por dentro sin barra a la vista. */
const CHIP_ROW =
  "flex min-w-0 items-center gap-1.5 overflow-x-auto py-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden";

const ROW_ACTION =
  "inline-grid size-8 place-items-center rounded-md bg-white text-ink-600 shadow-control ring-1 ring-inset ring-line-strong hover:text-ink-900";

const EDAD_LABEL: Record<UrgencyTier, string> = {
  dorada: "Hora dorada",
  tibia: "1–6 h",
  enfriando: "6–24 h",
  fria: "Más de un día",
};
const WIN_LABEL = { fresca: "A tiempo", por_vencer: "Por vencer", cerrada: "Vencida" } as const;

// Cada cuánto se revalida la página en vivo (soft-refresh de datos del servidor).
// Mismo espíritu que ONLINE_POLL_MS de Productividad, un poco más ágil porque
// "Atender ahora" es una cola que se trabaja al momento.
const LEADS_LIVE_POLL_MS = 30_000;
// Cuándo recargar de verdad —urgente, tranquila cada dos minutos, o forzada
// cada cinco— lo decide lib/leads-live-refresh.ts, que es puro y está probado.
// El panel de gráficos se recarga con la misma calma: ve una semana entera, y
// bajarlo en cada refresco era la segunda partida del egress.
const INSIGHTS_MIN_REFRESH_MS = 5 * 60_000;
// Filas que se pintan de entrada. La cola completa puede traer miles de leads y
// montarlas TODAS de golpe era el segundo motivo de que el panel se sintiera
// pesado: miles de nodos por render, y un render por cada tecla del buscador.
// Se pintan por tramos según se baja; los conteos siguen saliendo del universo
// completo, así que ningún número cambia.
const LEADS_RENDER_STEP = 60;

export function LeadsBoard({
  stores,
  storeId,
  view,
  counts: serverCounts,
  queueSignature,
  leads: serverLeads,
  adNames,
  adDeclarations,
  waNumbers,
  agentNames,
  priorCoverage,
  shopifyLocations,
  coverageRules,
  currency,
  timezone,
  insights,
  initialState,
  initialSeg,
  initialGest,
  initialInteractionDate,
  initialOpenId,
  initialOpenNonce,
  currentUserId,
  leadsComplete = true,
  scope,
  allStoresAvailable = false,
  canHoldNext = false,
}: {
  stores: StoreSummary[];
  /** Id de la tienda activa, o ALL_STORES cuando la vista es combinada. */
  storeId: string;
  /** Tiendas que la vista está mirando de verdad. Con una sola es `[storeId]`.
   *  Todo lo que consulta al servidor usa esto, nunca `storeId`. */
  scope: StoreScope;
  /** ¿Se puede ofrecer "Todas"? Falso si las tiendas no comparten moneda/zona. */
  allStoresAvailable?: boolean;
  view: LeadView;
  counts: LeadCounts;
  /** Resumen del estado de la cola en el servidor. El refresco en vivo solo
   *  recarga cuando esta cadena cambia (ver `getLeadQueueSnapshot`). */
  queueSignature?: string;
  leads: LeadRow[];
  adNames?: Record<string, AdMeta>;
  /** `tienda::anuncio → declaraciones con fecha` (ver lib/ad-products.ts). */
  adDeclarations?: Record<string, AdDeclaration[]>;
  waNumbers?: Record<string, WaNumber>;
  /** Id de asesora → nombre, solo para quienes tienen una reserva viva en la
   *  lista. Con esto la etiqueta «Tomado» dice por quién. */
  agentNames?: Record<string, string>;
  /** Id de lead → cobertura de su último pedido con el mismo teléfono (0225).
   *  Pista del filtro de cobertura cuando el lead no dejó dirección. */
  priorCoverage?: Record<string, string>;
  /** Id de lead → dirección del cliente en Shopify (0228), para los que no
   *  dicen dónde viven ni compraron antes. */
  shopifyLocations?: Record<string, { province: string | null; city: string | null }>;
  /** Excepciones de cobertura por distrito (0121), las mismas del pedido. */
  coverageRules?: DistrictCoverageRule[];
  currency: string;
  timezone: string;
  insights: LeadsInsights | null;
  initialState?: QueueState | null;
  initialSeg?: QueueBucket | null;
  initialGest?: LeadGestion | null;
  initialInteractionDate?: LeadInteractionDateFilter | null;
  initialOpenId?: string | null; // ?open=<id> → auto-abre ese lead (desde el pop-up de Yapes)
  initialOpenNonce?: string | null; // ?oid=<sello> → identifica ESA orden, no el lead
  currentUserId: string;
  /** false = la página cargó solo un tope de filas para esta vista, así que un
   *  export debe repedir el universo completo al servidor. */
  leadsComplete?: boolean;
  /** Tiene el rol `vendedora`: se le reserva su siguiente lead (MOM §11). */
  canHoldNext?: boolean;
}) {
  const [board, setBoard] = useState({ sourceLeads: serverLeads, sourceCounts: serverCounts, leads: serverLeads, counts: serverCounts });
  // A route/periodic refresh replaces the local confirmed writes atomically.
  if (board.sourceLeads !== serverLeads || board.sourceCounts !== serverCounts) {
    setBoard({ sourceLeads: serverLeads, sourceCounts: serverCounts, leads: serverLeads, counts: serverCounts });
  }
  const { leads, counts } = board;
  const countRequestRef = useRef(0);
  useEffect(() => {
    // Invalidate an older count request on refresh or unmount.
    countRequestRef.current += 1;
    return () => { countRequestRef.current += 1; };
  }, [serverLeads, serverCounts]);
  const router = useRouter();
  // El alcance es un array y cambia de identidad en cada render, así que no
  // sirve como dependencia de efectos: usarlo directo relanzaría la carga de
  // gráficos en bucle. La clave estable es su contenido.
  const scopeKey = scope.join(",");
  /** ¿Vista combinada? Decide la insignia de tienda, el perfil de puntaje por
   *  fila y el bloqueo de la audiencia de Meta. */
  const allStores = scope.length > 1;
  const [routePending, startRouteTransition] = useTransition();
  const [insightsData, setInsightsData] = useState<LeadsInsights | null>(insights);
  // Only the row being opened is disabled (its claim is in flight) — never the
  // whole list. Background work (post-save refresh, claim release) must NOT
  // freeze every "Tomar / Ver" button, which is why it's not a shared transition.
  const [openingId, setOpeningId] = useState<string | null>(null);
  const [banner, setBanner] = useState<string | null>(null);
  // Drawer is client-state driven: it opens instantly from the row we already
  // have; the claim + call history load in the background (no page navigation).
  const [selected, setSelected] = useState<LeadRow | null>(null);
  const [calls, setCalls] = useState<LeadCallRow[] | null>(null);
  const [history, setHistory] = useState<CustomerHistory | null>(null); // recurrent-customer block
  const activeLeadIdRef = useRef<string | null>(null);
  // Client-side sub-filters (instant, no navigation): source lens + the queue's
  // intención/gestión axes within "Por llamar".
  // Fuente y Número: multi-select (OR dentro del grupo). Set vacío = sin filtro.
  const [srcFilter, setSrcFilter] = useState<Set<string>>(new Set());
  // Cola de DOS ejes que se combinan. Eje 1 (estado, tabs primarios): "Sin llamar"
  // (default) = nadie lo tocó (status nuevo); "En seguimiento" = ya gestionado pero
  // pendiente. Eje 2 (segmento, "accesos directos" debajo): frío…carrito, scopeado
  // al estado activo. La Gestión es un refino que vive en Filtros (sin default).
  const [queueState, setQueueState] = useState<QueueState>(initialState ?? "sin_llamar");
  const [segFilter, setSegFilter] = useState<QueueBucket | null>(initialSeg ?? null);
  // Eje 3 (cobertura): Lima / Provincia / Sin identificar, al lado del segmento.
  // Es una pista para repartir llamadas, no la cobertura del pedido (ver
  // lib/lead-coverage.ts).
  const [covFilter, setCovFilter] = useState<LeadCoverage | null>(null);
  const [gestFilter, setGestFilter] = useState<LeadGestion | "otros" | null>(initialGest ?? null);
  const [winFilter, setWinFilter] = useState<"all" | "fresca" | "por_vencer" | "cerrada">("all");
  // Edad del lead. EJE PROPIO, no un desglose de "Ventana": son dos relojes
  // distintos y mezclarlos daría un chip que miente. Medido sobre la cola real,
  // de los 7 leads con mensaje entrante hace menos de una hora solo 4 tenían
  // menos de una hora de vida — uno llevaba 16,2 h esperando y su cliente acababa
  // de volver a escribir, lo que reinicia la ventana sin rejuvenecer el lead.
  const [edadFilter, setEdadFilter] = useState<"all" | UrgencyTier>("all");
  const [numFilter, setNumFilter] = useState<Set<string>>(new Set()); // WhatsApp phone_number_id(s) + "__none__"
  // Producto: el handle de la ficha que el cliente abrió antes de escribir, más
  // "__none__" para los que llegaron sin link. Es lo que permite trabajar la
  // cola por producto —la misma pregunta, el mismo argumentario, una tanda de
  // llamadas— en vez de saltar de un producto a otro fila por fila.
  const [prodFilter, setProdFilter] = useState<Set<string>>(new Set());
  const [interactionDateFilter, setInteractionDateFilter] = useState<LeadInteractionDateFilter | null>(
    initialInteractionDate ?? null,
  );
  // Search box: instant client-side narrowing of the current view PLUS a
  // debounced global lookup (all stages) so you can find any customer, not just
  // those loaded in the active tab.
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<LeadRow[] | null>(null);
  const [searching, setSearching] = useState(false);
  // Orden de la cola. "prioridad" (por defecto) pone arriba lo que más cierra;
  // "reciente" es el orden viejo, por si alguien quiere barrer por hora de llegada.
  const [sortMode, setSortMode] = useState<"prioridad" | "reciente">("prioridad");
  const [exportingAudience, setExportingAudience] = useState(false);

  // «Tablero de hoy» (el equipo, sin llamar 7d y la carrera de pedidos). Se
  // recarga cuando cambia el conteo de la cola — y con el auto-refresco en vivo
  // eso pasa muy seguido. IMPORTANTE: NO se vacía insightsData antes de recargar;
  // si se vaciara, el tablero parpadearía a esqueleto varios segundos en CADA
  // recarga. Se deja el panel anterior a la vista y se reemplaza recién
  // cuando llegan los datos nuevos (el usuario no ve el refetch). Cambiar de
  // tienda no arrastra datos viejos: la página remonta el board con
  // key={storeId}:{view}.
  const insightsLoadedAtRef = useRef<{ scopeKey: string; at: number } | null>(null);
  useEffect(() => {
    let alive = true;
    if (insights) {
      setInsightsData(insights);
      return () => {
        alive = false;
      };
    }
    // Como mucho cada INSIGHTS_MIN_REFRESH_MS por alcance: el panel ve una
    // semana y no cambia de forma con un lead más. El primer montaje siempre
    // carga; un cambio de tienda también.
    const last = insightsLoadedAtRef.current;
    if (last && last.scopeKey === scopeKey && Date.now() - last.at < INSIGHTS_MIN_REFRESH_MS) {
      return () => {
        alive = false;
      };
    }
    insightsLoadedAtRef.current = { scopeKey, at: Date.now() };
    void loadLeadsInsightsPanel(scope, timezone).then((result) => {
      if (alive && !("error" in result)) setInsightsData(result);
    }).catch(() => { /* retain the last analytical snapshot on a network failure */ });
    return () => {
      alive = false;
    };
  }, [counts.sin_llamar, insights, scopeKey, timezone]);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setResults(null);
      setSearching(false);
      return;
    }
    setSearching(true);
    let alive = true;
    const controller = new AbortController();
    const t = setTimeout(async () => {
      try {
        const res = await searchLeads(scope, q, controller.signal);
        if (alive) setResults(res);
      } catch {
        if (alive) {
          setResults(null);
          setBanner("No se pudo completar la búsqueda. Intenta nuevamente.");
        }
      } finally {
        if (alive) setSearching(false);
      }
    }, 220);
    return () => {
      alive = false;
      controller.abort();
      clearTimeout(t);
    };
  }, [query, scopeKey]);

  // Auto-abrir un lead cuando llega ?open=<id> (p. ej. al tocar "Tomar" en el
  // pop-up de Yapes).
  //
  // `?open=` ES UNA ORDEN, NO UN ESTADO. Se cumple una vez y se borra de la URL.
  // Mientras se quedaba puesto, cada recarga —y cada enlace guardado, y cada
  // vuelta atrás del navegador— reabría un lead que ya se había cerrado a
  // propósito. Y no era solo molesto: abrir la gaveta RECLAMA el lead, así que
  // recargar la página se lo volvía a adjudicar a quien miraba.
  //
  // Se borra con `history.replaceState` y no con `router.replace` porque este
  // último es una navegación: rehacer la página entera —los ~2.500 leads, los
  // siete conteos y los gráficos— para quitar un parámetro de la barra sería
  // pagar segundos por nada.
  // LO QUE SE LLEVA LA CUENTA ES LA ORDEN, NO EL LEAD. Limpiar la barra de
  // direcciones no bastó: la orden seguía volviendo. Esta pantalla se refresca
  // sola cada pocos segundos (`router.refresh()`), y ese refresco vuelve a
  // renderizar desde la URL que el router considera suya, que no es siempre la
  // que enseña el navegador. Así que `initialOpenId` iba y venía —X, null, X— y
  // cada vuelta reabría la ficha. Recordar "ya cumplí ESTA orden" corta el ciclo
  // sea cual sea el camino por el que reaparezca.
  //
  // El sello `?oid=` es lo que permite las dos cosas a la vez: "Tomar" dos veces
  // el mismo Yape son dos órdenes distintas y las dos se obedecen; una orden que
  // reaparece sola trae el sello viejo y se ignora. Una URL sin sello —escrita a
  // mano o guardada de antes— se obedece una sola vez por pestaña, que es
  // exactamente lo que se quiere de una URL vieja.
  const cumplidasRef = useRef<Set<string>>(new Set());
  const [pendienteDeAbrir, setPendienteDeAbrir] = useState<string | null>(null);
  useEffect(() => {
    if (!initialOpenId) return;
    const orden = `${initialOpenId}:${initialOpenNonce ?? ""}`;
    if (cumplidasRef.current.has(orden)) return;
    cumplidasRef.current.add(orden);
    // Se guarda en estado ANTES de limpiar: si el lead todavía no está en la
    // lista cargada, el intento se reintenta desde aquí y no desde la URL, que
    // para entonces ya no lo lleva.
    setPendienteDeAbrir(initialOpenId);
    // Limpiar la barra sigue valiendo la pena aunque no sea suficiente: sin esto,
    // recargar o compartir el enlace arrastra la orden a otra sesión.
    const sp = new URLSearchParams(window.location.search);
    if (sp.has("open") || sp.has("oid")) {
      sp.delete("open");
      sp.delete("oid");
      const qs = sp.toString();
      window.history.replaceState(
        null,
        "",
        qs ? `${window.location.pathname}?${qs}` : window.location.pathname,
      );
    }
  }, [initialOpenId, initialOpenNonce]);

  // La orden se cumple UNA vez: al abrirla se consume. Si el lead todavía no
  // está en la lista cargada se queda pendiente y se reintenta cuando llegue.
  useEffect(() => {
    if (!pendienteDeAbrir) return;
    const lead = leads.find((l) => l.id === pendienteDeAbrir);
    if (lead) {
      setPendienteDeAbrir(null);
      openLead(lead);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendienteDeAbrir, leads]);

  // Refresco en vivo: revalida los datos del servidor (lista + contadores, incl.
  // "⚡ Atender ahora") mientras la pestaña está visible, y al instante al volver
  // a ella. Así un handoff nuevo aparece solo, sin recargar la página.
  // router.refresh() es un soft-refresh: conserva filtros, scroll, búsqueda y el
  // drawer abierto (no remonta el componente).
  //
  // PERO recargar cuesta caro —los ~2.500 leads de la cola, los siete conteos y
  // el panel de gráficos— y hasta ahora se pagaba cada 30 s aunque no hubiera
  // cambiado nada. Ahora primero se pregunta por la FIRMA de la cola (una
  // consulta barata) y solo se recarga si de verdad hay algo nuevo. Cada tanto
  // se recarga igual, por si la firma se quedara ciega a algún cambio.
  const signatureRef = useRef<string | null>(queueSignature ?? null);
  useEffect(() => {
    if (queueSignature) signatureRef.current = queueSignature;
  }, [queueSignature]);
  // Los contadores con los que se comparó la última vez: «Atender ahora» y
  // Yapes son los que hacen urgente una recarga (lib/leads-live-refresh.ts).
  const countsRef = useRef(serverCounts);
  useEffect(() => {
    countsRef.current = serverCounts;
  }, [serverCounts]);
  useEffect(() => {
    let alive = true;
    let lastRefreshAt = Date.now();
    let inFlight = false;
    const check = async () => {
      if (!alive || document.hidden || inFlight) return;
      inFlight = true;
      try {
        const now = Date.now();
        if (now - lastRefreshAt >= FORCED_REFRESH_MS) {
          lastRefreshAt = now;
          router.refresh();
          return;
        }
        const next = await pollLeadsQueue(scope).catch(() => null);
        if (!alive || document.hidden) return;
        if (next === null) return; // fallo puntual: se reintenta al siguiente tick
        const decision = decideQueueRefresh({
          prevSignature: signatureRef.current,
          nextSignature: next.signature,
          prevCounts: countsRef.current,
          nextCounts: next.counts,
          lastRefreshAt,
          now: Date.now(),
        });
        // «skip» por calma NO adelanta la firma: el siguiente sondeo vuelve a
        // ver el cambio y recarga cuando toque.
        if (decision === "skip") return;
        signatureRef.current = next.signature;
        countsRef.current = next.counts;
        lastRefreshAt = Date.now();
        router.refresh();
      } finally {
        inFlight = false;
      }
    };
    const timer = setInterval(() => void check(), LEADS_LIVE_POLL_MS);
    const onVisible = () => {
      if (!document.hidden) void check();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      alive = false;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [router, storeId]);

  function changeStore(nextStore: string) {
    startRouteTransition(() => {
      router.push(`/dashboard/leads?store=${nextStore}&view=${view}`);
    });
  }

  function prefetchOtherStores() {
    for (const store of stores) {
      if (store.id !== storeId) router.prefetch(`/dashboard/leads?store=${store.id}&view=${view}`);
    }
    // La combinada también: es la que más tarda (consulta las dos tiendas), así
    // que es justo la que más gana con precargarse al abrir el selector.
    if (allStoresAvailable && storeId !== ALL_STORES) {
      router.prefetch(`/dashboard/leads?store=${ALL_STORES}&view=${view}`);
    }
  }

  function navigateToView(nextView: string) {
    startRouteTransition(() => {
      router.push(`/dashboard/leads?store=${storeId}&view=${nextView}`);
    });
  }

  function changeInteractionDateFilter(next: LeadInteractionDateFilter | null) {
    setQuery("");
    if (!inQueue && next) {
      const params = new URLSearchParams({
        store: storeId,
        view: "por_llamar",
        state: "sin_llamar",
      });
      if (next.kind === "day") params.set("last_date", next.date);
      else params.set("last_before", next.before);
      startRouteTransition(() => {
        router.push(`/dashboard/leads?${params.toString()}`);
      });
      return;
    }
    setQueueState("sin_llamar");
    setInteractionDateFilter(next);
  }

  function openLead(lead: LeadRow) {
    void (async () => {
      // El siguiente cuenta como una de sus dos reservas: abrir otro lead de la
      // cola lo suelta ANTES de reservar el otro, y pasa a otra vendedora.
      if (nextLead.heldId && nextLead.heldId !== lead.id) await nextLead.release();
      await abrirLeadPorId(lead.id, lead);
    })();
  }

  /**
   * Abrir la gaveta de un lead, tengamos su fila cargada o no.
   *
   * `previa` es solo pintado instantáneo: cuando el lead viene de la lista ya
   * sabemos su nombre y teléfono, y enseñarlos de una hace que la gaveta no
   * parezca vacía mientras llega el detalle. Sin ella la gaveta espera, y por eso
   * esto DEVUELVE una promesa: quien abrió el lead sin tener la fila —la venta
   * por teléfono, que acaba de crearlo— necesita saber cuándo dejar de decir
   * «abriendo». Un botón que no dice nada mientras trabaja se acaba pulsando
   * cuatro veces.
   */
  async function abrirLeadPorId(leadId: string, previa?: LeadRow | null): Promise<boolean> {
    markLeadDrawerOpen();
    activeLeadIdRef.current = leadId;
    setBanner(null);
    setSelected(previa ?? null);
    setCalls(null);
    setHistory(null);
    setOpeningId(leadId); // disable only this row's button while the claim loads
    const historyPromise = loadLeadCustomerHistory(leadId).catch(() => null);
    try {
      const d = await openLeadDrawer(leadId);
      if (activeLeadIdRef.current !== leadId) return false;
      if ("error" in d) {
        setBanner(d.error);
        setSelected(null);
        activeLeadIdRef.current = null;
        return false;
      }
      setSelected(d.lead);
      setCalls(d.calls);
      void historyPromise.then((extra) => {
        if (!extra || "error" in extra || activeLeadIdRef.current !== leadId) return;
        setHistory(extra.customerHistory);
        if (extra.cartSummary) {
          setSelected((current) =>
            current?.id === leadId ? { ...current, cart_summary: extra.cartSummary } : current,
          );
        }
      });
      return true;
    } catch {
      if (activeLeadIdRef.current === leadId) {
        setBanner("No se pudo cargar el lead. Intenta nuevamente.");
      }
      return false;
    } finally {
      setOpeningId((current) => (current === leadId ? null : current));
    }
  }

  function refreshDetail(leadId: string, update?: LeadDrawerUpdate) {
    if (update) {
      // Identify the saved row even if the user opened another drawer meanwhile.
      leadId = update.savedCall?.lead_id ?? leadId;
      if (update.savedCall && update.leadPatch) {
        const patch = update.leadPatch;
        const before = leads.find((row) => row.id === leadId)
          ?? results?.find((row) => row.id === leadId)
          ?? (selected?.id === leadId ? selected : null);
        setBoard((current) => ({
          ...current,
          leads: patchLeadRows(current.leads, leadId, patch, view, before),
          counts: before ? patchLeadCounts(current.counts, before, patch) : current.counts,
        }));
        setResults((current) => current ? patchLeadRows(current, leadId, patch) : current);
        // Account for our own urgent-count delta. Keep the old signature so a
        // concurrent change by another advisor is still detected by polling.
        if (before) countsRef.current = patchLeadCounts(countsRef.current, before, patch);
        const request = ++countRequestRef.current;
        void pollLeadsQueue(scope).then((next) => {
          if (next && request === countRequestRef.current) {
            setBoard((current) => ({ ...current, counts: next.counts }));
          }
        }).catch(() => undefined); // periodic polling retries on network failure
      }
      if (activeLeadIdRef.current === leadId) {
        if (update.leadPatch) {
          setSelected((current) => (current?.id === leadId ? { ...current, ...update.leadPatch } : current));
        }
        if (update.savedCall) {
          setCalls((current) => [update.savedCall!, ...(current ?? []).filter((call) => call.id !== update.savedCall!.id)]);
        }
      }
      // Other mutations can still request a full background refresh. Calls
      // above update their row, facets and counts without requesting one.
      if (update.refreshList) router.refresh();
      return;
    }

    // Refresh the drawer + the list/counts in the background. Deliberately NOT a
    // transition tied to the row buttons: a call save shouldn't disable every
    // "Tomar / Ver" while the (heavier) list refetch runs.
    void (async () => {
      const historyPromise = loadLeadCustomerHistory(leadId).catch(() => null);
      const d = await loadLeadDetail(leadId);
      if (!("error" in d) && activeLeadIdRef.current === leadId) {
        setSelected(d.lead);
        setCalls(d.calls);
      }
      void historyPromise.then((extra) => {
        if (!extra || "error" in extra || activeLeadIdRef.current !== leadId) return;
        setHistory(extra.customerHistory);
        if (extra.cartSummary) {
          setSelected((current) =>
            current?.id === leadId ? { ...current, cart_summary: extra.cartSummary } : current,
          );
        }
      });
      router.refresh(); // reflect status/queue changes in the list + counts
    })().catch(() => setBanner("No se pudo actualizar el lead. Intenta nuevamente."));
  }

  // El popup del aviso de reserva: al aparecer, el foco va a su botón —así un
  // lector de pantalla lo lee y Enter lo cierra— y Escape lo descarta.
  const bannerDismissRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (!banner) return;
    bannerDismissRef.current?.focus();
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setBanner(null);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [banner]);

  // Si la pestaña se cierra o se recarga con el cajón abierto, `closeDrawer`
  // nunca corre y la reserva quedaba viva hasta agotar el TTL (459 vencidas sin
  // soltar contra 11 vivas, medido el 14-09-2026). Con el tope de
  // MAX_OPEN_LEADS eso ya no es inofensivo: dos pestañas cerradas a lo bruto
  // bloquearían a la asesora diez minutos. `sendBeacon` sobrevive a la
  // descarga; una acción de servidor, no. Mismo mecanismo que Envíos.
  useEffect(() => {
    const onPageHide = () => {
      const leadId = activeLeadIdRef.current;
      if (!leadId) return;
      navigator.sendBeacon?.(
        "/api/leads/release-claim",
        new Blob([JSON.stringify({ leadId })], { type: "application/json" }),
      );
    };
    window.addEventListener("pagehide", onPageHide);
    return () => window.removeEventListener("pagehide", onPageHide);
  }, []);

  // LA RESERVA SE RENUEVA MIENTRAS LA FICHA ESTÁ ABIERTA (14-10-2026). Antes
  // vencía a los 10 minutos de abrirla aunque la asesora siguiera con la
  // clienta, y otra podía tomar el mismo lead encima (Daphne y Ross). Solo se
  // renueva si la asesora tocó la página hace menos de 10 minutos: una ficha
  // olvidada abierta suelta el lead sola, como siempre. Si al renovar resulta
  // que otra lo tomó, se le dice quién —no se le quita a nadie—.
  const openLeadId = selected?.id ?? null;
  const lastActivityRef = useRef(Date.now());
  useEffect(() => {
    const mark = () => {
      lastActivityRef.current = Date.now();
    };
    const opts = { passive: true } as const;
    window.addEventListener("pointerdown", mark, opts);
    window.addEventListener("keydown", mark, opts);
    window.addEventListener("pointermove", mark, opts);
    return () => {
      window.removeEventListener("pointerdown", mark);
      window.removeEventListener("keydown", mark);
      window.removeEventListener("pointermove", mark);
    };
  }, []);
  useEffect(() => {
    if (!openLeadId) return;
    const timer = setInterval(() => {
      if (activeLeadIdRef.current !== openLeadId) return;
      if (!shouldRenewClaim(lastActivityRef.current, Date.now())) return;
      void renewLeadClaim(openLeadId)
        .then((res) => {
          if (res.error && activeLeadIdRef.current === openLeadId) setBanner(res.error);
        })
        .catch(() => undefined); // un fallo de red se reintenta en el siguiente latido
    }, CLAIM_HEARTBEAT_MS);
    return () => clearInterval(timer);
  }, [openLeadId]);

  /** El lead al que se está pasando con «Siguiente lead»; cerrar lo cancela. */
  const jumpingToRef = useRef<string | null>(null);

  function closeDrawer() {
    jumpingToRef.current = null;
    const leadId = selected?.id;
    activeLeadIdRef.current = null;
    setSelected(null);
    setCalls(null);
    setHistory(null);
    // Release the claim in the background (fire-and-forget). No full-list refresh
    // on close, and no shared transition that would freeze the row buttons.
    // La ficha de su siguiente se cierra sin soltarlo: sigue siendo suyo.
    if (leadId && leadId !== nextLead.heldId) void releaseLead(leadId);
  }

  // `now` alimenta el estado de la ventana de 24h (y sus contadores). Antes se
  // leía el reloj en CADA render, así que ningún cálculo derivado se podía
  // memoizar: cambiaba el input siempre. Ahora avanza a saltos de un minuto —
  // la ventana se muestra en horas, así que se ve exactamente igual — y todo lo
  // que depende de él sí se puede cachear entre renders.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  const q = query.trim().toLowerCase();
  const qDigits = q.replace(/\D/g, "");
  const inQueue = view === "por_llamar";
  const isYape = view === "yape"; // tinta las filas en rojo + 🔥 en la vista Yape/Shalom

  // El producto de cada lead, resuelto UNA vez sobre la cola entera. Tiene que
  // ser sobre la cola entera y no lead a lead: plegar los links cortados a media
  // palabra exige ver todos los handles para saber cuál es el completo.
  const handleOf = useMemo(() => {
    const crudo = new Map<string, string>();
    for (const l of leads) {
      // 1) Lo ÚLTIMO que enlazó, que es lo que está consultando ahora (0140).
      //    Cubre a quien vuelve por otro producto y a quien abrió con un «hola»
      //    y mandó la ficha después.
      // 2) El carrito o lo que estaba mirando (0143).
      // 3) El link del primer mensaje —lead antiguo, sin resincronizar—, que es
      //    de donde salía todo antes.
      // 4) Y si tampoco, lo que su anuncio vendía EL DÍA QUE ESTE LEAD ENTRÓ.
      //    No lo que vende hoy: un creativo reutilizado cambia de producto, y
      //    tomar la declaración nueva reescribiría el pasado de los viejos.
      //    Nunca una conjetura: sin declaración vigente el lead se queda en
      //    «Sin producto», que es la verdad.
      const h =
        (l.last_product_handle ?? "").trim() ||
        // 2) Lo que tiene en el carrito, o lo que estaba mirando. Va antes que
        //    el primer mensaje porque es más reciente que la apertura, y llega
        //    ya como handle desde Shopify — no como título, que no se puede
        //    emparejar con el del link sin adivinar.
        (l.cart_product_handle ?? "").trim() ||
        leadProductHandle(l.first_inbound_text) ||
        (l.ad_id
          ? handleDeAnuncioPara(
              adDeclarations?.[claveAnuncio(l.store_id, l.ad_id)],
              l.first_seen_at,
            )
          : null);
      if (h) crudo.set(l.id, h);
    }
    const canon = canonicalProductHandles(crudo.values());
    const porLead = new Map<string, string>();
    for (const [id, h] of crudo) porLead.set(id, canon.get(h) ?? h);
    return (l: LeadRow) => porLead.get(l.id) ?? null;
  }, [leads, adDeclarations]);

  // La cobertura de cada lead, resuelta UNA vez por cola: el predicado del
  // filtro y sus contadores la piden varias veces por lead y por render. Las
  // filas que no son de la cola (la audiencia completa) se resuelven al vuelo.
  const coverageOf = useMemo(() => {
    const rules = coverageRules ?? [];
    const resolve = (l: LeadRow) =>
      leadCoverage(l, {
        priorCoverage: priorCoverage?.[l.id] ?? null,
        shopifyAddress: shopifyLocations?.[l.id] ?? null,
        overrides: rules,
      });
    const porLead = new Map<string, LeadCoverage>();
    for (const l of leads) porLead.set(l.id, resolve(l));
    return (l: LeadRow): LeadCoverage => porLead.get(l.id) ?? resolve(l);
  }, [leads, priorCoverage, shopifyLocations, coverageRules]);

  // Jerarquía de filtros (faceted counts): los contadores de cada grupo se
  // calculan sobre los leads que pasan TODOS los demás filtros activos, pero NO
  // el propio. Así, al elegir "Con carrito" (18), Gestión/Ventana/Fuente/Número
  // muestran su "Todos" = 18 y sus sub-botones suman ese subconjunto, mientras
  // que cada grupo conserva sus opciones para poder cambiar dentro de él.
  //
  // Todo el bloque se calcula de una vez y se memoiza: son ocho predicados sobre
  // la cola entera (que en "Por llamar" son miles de leads) y siete bases
  // distintas. Rehacerlo en cada render era lo que hacía que escribir en el
  // buscador se sintiera pegajoso. `facetItems` evalúa los predicados UNA vez
  // por lead y deriva las bases con máscaras de bits (ver lib/leads-facets.ts).
  const {
    facetsMatchAll,
    srcCounts,
    hasCampaign,
    hasFbWeb,
    hasCart,
    hasBrowse,
    segCounts,
    segTotal,
    covCounts,
    covTotal,
    stateCounts,
    seguimientoAlert,
    gestCounts,
    gestTotal,
    gestOtros,
    winCounts,
    winTotal,
    edadCounts,
    edadTotal,
    numTotal,
    waCounts,
    numOtros,
    waIds,
    hasMultiNumbers,
    prodOptions,
    prodSin,
    goldenTally,
    shownLeads,
  } = useMemo(() => {
    const matchQuery = (l: LeadRow) => {
      if (!q) return true;
      const name = (l.name ?? "").toLowerCase();
      const phoneDigits = (l.phone ?? "").replace(/\D/g, "");
      return name.includes(q) || (qDigits.length > 0 && phoneDigits.includes(qDigits));
    };
    const matchSrc = (l: LeadRow) => srcFilter.size === 0 || srcFilter.has(leadSourceKey(l.source));
    const matchNum = (l: LeadRow) => {
      if (numFilter.size === 0) return true;
      if (!l.wa_phone_number_id) return numFilter.has("__none__");
      return numFilter.has(l.wa_phone_number_id);
    };
    const matchProd = (l: LeadRow) => {
      if (prodFilter.size === 0) return true;
      const handle = handleOf(l);
      return handle ? prodFilter.has(handle) : prodFilter.has("__none__");
    };
    // Eje 1 (estado) y eje 2 (segmento) son facets independientes que combinan por
    // AND: el segmento se filtra DENTRO del estado activo (no lo reemplaza).
    const matchState = (l: LeadRow) => !inQueue || matchesQueueState(l, queueState);
    const matchSeg = (l: LeadRow) => !inQueue || !segFilter || leadQueueBucket(l) === segFilter;
    const matchCov = (l: LeadRow) => !inQueue || !covFilter || coverageOf(l) === covFilter;
    const matchGest = (l: LeadRow) => {
      // En "Sin llamar" todos son nuevos → la gestión no aplica (su panel se oculta).
      if (!inQueue || queueState === "sin_llamar" || !gestFilter) return true;
      if (gestFilter === "otros") return gestionOf(l.status) === null; // casi_cierra, repetido, volver_a_llamar…
      return gestionOf(l.status) === gestFilter;
    };
    const matchWin = (l: LeadRow) => {
      if (!inQueue || winFilter === "all") return true;
      const { state } = leadWindowInfo(l.last_inbound_at ?? l.last_interaction_at, now);
      if (winFilter === "fresca") return state === "fresca";
      if (winFilter === "por_vencer") return state === "por_vencer" || state === "critica";
      return state === "cerrada";
    };
    const matchInteractionDate = (l: LeadRow) =>
      !inQueue ||
      queueState !== "sin_llamar" ||
      matchesLeadInteractionDate(l, interactionDateFilter, timezone);
    // Filtro puro por edad: NO restringe segmentos. El aviso de arriba sí cuenta
    // solo carrito e interés (es una alarma sobre lo caro), pero el chip es un
    // corte de reloj y tiene que devolver todo lo que cae en él, o su número no
    // cuadraría con la lista.
    const matchEdad = (l: LeadRow) =>
      !inQueue || edadFilter === "all" || leadUrgency(l.first_seen_at, now)?.tier === edadFilter;
    const facets = facetItems(leads, {
      query: matchQuery,
      src: matchSrc,
      num: matchNum,
      prod: matchProd,
      state: matchState,
      seg: matchSeg,
      cov: matchCov,
      gest: matchGest,
      win: matchWin,
      edad: matchEdad,
      interactionDate: matchInteractionDate,
    });

    const srcBase = facets.except("src");
    const srcCountsAcc = { meta_ad: 0, fb_web: 0, cod_cart: 0, abandoned_browse: 0, organic: 0 };
    for (const l of srcBase) srcCountsAcc[leadSourceKey(l.source)] += 1;

    // Eje 2 (segmento): conteos SCOPEADOS al estado activo. `except("seg")` pasa
    // el facet de estado, así que los segmentos suman el total del estado (p.ej. 237
    // en Sin llamar), no los 429. "Todos" = ese total.
    const segBase = facets.except("seg");
    // Cobertura: mismo trato que el segmento — sus chips suman el total del
    // estado activo con los demás filtros puestos, menos el suyo.
    const covBase = facets.except("cov");
    // Eje 1 (estado): tabs primarios con totales estables (237 / 192). Su base salta
    // el propio estado, el segmento y la cobertura, para no encogerse al elegir uno.
    const stateBase = facets.except("state", "seg", "cov");
    const gestBase = facets.except("gest");
    const winBase = facets.except("win");
    const edadBase = facets.except("edad");
    // WhatsApp numbers present in this view (to split the queue by number). The
    // chip list comes from the full view so picking a number never hides the
    // others; the counts come from the faceted base.
    const numBase = facets.except("num");
    // Producto: la lista se ordena por volumen, que es como se decide a quién
    // llamar primero — 190 esperando por el mismo producto es una tanda, 1 no.
    const prodBase = facets.except("prod");
    const prodCountsAcc = new Map<string, number>();
    let prodSinAcc = 0;
    for (const l of prodBase) {
      const h = handleOf(l);
      if (h) prodCountsAcc.set(h, (prodCountsAcc.get(h) ?? 0) + 1);
      else prodSinAcc += 1;
    }
    const prodOptionsAcc = [...prodCountsAcc.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([handle, count]) => ({ key: handle, label: productLabel(handle), count }));

    const gestCountsAcc = countGestiones(gestBase);
    const waCountsAcc = new Map<string, number>();
    for (const l of numBase) {
      if (l.wa_phone_number_id)
        waCountsAcc.set(l.wa_phone_number_id, (waCountsAcc.get(l.wa_phone_number_id) ?? 0) + 1);
    }
    const waIdsAcc = [...new Set(leads.map((l) => l.wa_phone_number_id).filter((id): id is string => !!id))];

    return {
      facetsMatchAll: facets.matchesAll,
      srcCounts: srcCountsAcc,
      hasCampaign: leads.some((l) => l.source === "meta_ad"),
      hasFbWeb: leads.some((l) => l.source === "fb_web"),
      hasCart: leads.some((l) => l.source === "cod_cart"),
      hasBrowse: leads.some((l) => l.source === "abandoned_browse"),
      segCounts: countQueueBuckets(segBase),
      segTotal: segBase.length,
      covCounts: countLeadCoverage(covBase.map(coverageOf)),
      covTotal: covBase.length,
      stateCounts: countQueueStates(stateBase),
      // Semáforo del tab "En seguimiento": cuántos piden atención (olas de carrito,
      // respuestas nuevas, seguimientos vencidos) — visible sin entrar al tab.
      seguimientoAlert: stateBase.filter((l) => matchesQueueState(l, "seguimiento") && l.needs_attention)
        .length,
      gestCounts: gestCountsAcc,
      gestTotal: gestBase.length,
      // Leads sin bucket de gestión (casi_cierra/repetido/volver_a_llamar): el resto
      // para que Gestión "Todos" cuadre con la suma de sus chips.
      gestOtros: gestBase.length - Object.values(gestCountsAcc).reduce((a, b) => a + b, 0),
      winCounts: countLeadWindows(winBase, now),
      winTotal: winBase.length,
      edadCounts: countLeadUrgency(edadBase, now),
      edadTotal: edadBase.length,
      numTotal: numBase.length,
      waCounts: waCountsAcc,
      // Leads sin número de WhatsApp asignado (ej. carrito/Shopify): el resto para
      // que Número "Todos" cuadre con la suma de sus chips.
      numOtros: numBase.length - [...waCountsAcc.values()].reduce((a, b) => a + b, 0),
      waIds: waIdsAcc,
      hasMultiNumbers: waIdsAcc.length >= 2,
      prodOptions: prodOptionsAcc,
      prodSin: prodSinAcc,
      // Hora dorada: se cuenta sin los filtros de segmento ni de cobertura para
      // que elegir un chip no apague el aviso. Es una alarma sobre
      // la cola, no un resumen de lo que se está mirando.
      goldenTally: tallyGolden(facets.except("seg", "cov", "edad"), leadSegment, now),
      shownLeads: facets.all,
    };
  }, [
    leads,
    handleOf,
    q,
    qDigits,
    srcFilter,
    numFilter,
    prodFilter,
    inQueue,
    queueState,
    segFilter,
    covFilter,
    coverageOf,
    gestFilter,
    winFilter,
    edadFilter,
    interactionDateFilter,
    timezone,
    now,
  ]);

  // Gestión solo cuenta como filtro activo donde es visible (no en "Sin llamar",
  // donde su panel se oculta y matchGest la ignora) — así el badge no miente.
  const gestActive = inQueue && queueState !== "sin_llamar" && !!gestFilter;
  // Filtros de refinamiento activos (excluye el buscador, que tiene su propia ✕).
  const hasActiveFilters =
    gestActive ||
    (inQueue && edadFilter !== "all") ||
    (inQueue && winFilter !== "all") ||
    (inQueue && queueState === "sin_llamar" && !!interactionDateFilter) ||
    srcFilter.size > 0 ||
    numFilter.size > 0 ||
    prodFilter.size > 0;
  // «Más filtros» quita solo lo suyo: el segmento y la cobertura tienen sus
  // propios chips a la vista.
  function clearRefinements() {
    setGestFilter(null);
    setWinFilter("all");
    setEdadFilter("all");
    setInteractionDateFilter(null);
    setSrcFilter(new Set());
    setNumFilter(new Set());
    setProdFilter(new Set());
  }

  // In search mode show the global results (all stages); otherwise the filtered
  // view (already narrowed client-side by the query for instant feedback).
  const searchMode = results !== null;
  const baseLeads = results ?? shownLeads;
  // Orden de la cola "Sin llamar" por probabilidad de cierre (ver lib/lead-priority).
  // Solo ahí: en "En seguimiento" la llamada tiene fecha comprometida con el
  // cliente y eso manda sobre cualquier puntaje; en una búsqueda el orden lo pone
  // la búsqueda. Se ordena en cliente porque esta vista ya trae el universo
  // completo paginado (getStoreLeads con limit null), así que no hace falta que
  // Postgres sepa del puntaje.
  const priorityOn =
    sortMode === "prioridad" && !searchMode && view === "por_llamar" && queueState === "sin_llamar";
  // El perfil de puntaje sale de la tienda DE CADA FILA, no del selector: en la
  // vista combinada aplicarle a todo el perfil de una sola tienda ordenaría mal
  // justo la mitad de la cola.
  const profileByStore = useMemo(
    () => new Map(stores.map((s) => [s.id, scoringProfileFor(s.name)])),
    [stores],
  );
  const storeNameById = useMemo(
    () => new Map(stores.map((s) => [s.id, s.name])),
    [stores],
  );
  // ESTA PANTALLA NO SABE NADA DEL EXPERIMENTO, y es el resultado de haberlo
  // intentado dos veces. Se probó empujar el brazo de tratamiento al principio
  // de la cola: se llamaba a los 47 minutos de mediana contra 14 del control, y
  // 1 de 19 dentro de los primeros 30 minutos contra 15 de 59. Se probó luego
  // marcarlo con un chip sin moverlo: se llamó al 23,5% contra el 34,3% del
  // control (p ≈ 0,04). Los dos mecanismos, el mismo signo — la etiqueta hace
  // que el lead se salte, porque se lee como "esto no es un pedido de verdad".
  //
  // Además ninguna señal en pantalla sobrevive a cómo se trabaja la cola de
  // verdad —a veces de arriba abajo, a veces filtrando por segmento, a veces en
  // handoffs—: al elegir un chip, el lead del tratamiento desaparece de la
  // vista, empujado o marcado o ninguna de las dos.
  //
  // v2 entrega el tratamiento fuera de la cola: una lista por Telegram con
  // enlace a la ficha, sin decir que es una prueba (lib/coverage-push.ts).
  const displayLeads = useMemo(
    () =>
      priorityOn
        ? sortLeadsByPriorityScoped(baseLeads, (lead) =>
            profileByStore.get(lead.store_id) ?? scoringProfileFor(null),
          )
        : baseLeads,
    [priorityOn, baseLeads, profileByStore],
  );

  // Render por tramos. La cola completa puede traer miles de filas y montarlas
  // todas de golpe cuesta decenas de miles de nodos en el primer pintado (y otra
  // vez en cada refresco). Se pintan LEADS_RENDER_STEP y el resto entra sola al
  // bajar, antes de llegar al final. Los contadores, el gráfico y el export
  // siguen usando el universo completo: esto es solo lo que se dibuja.
  const [visibleCount, setVisibleCount] = useState(LEADS_RENDER_STEP);
  // Al cambiar de filtro/búsqueda se empieza de nuevo por arriba. Un refresco en
  // vivo NO reinicia el tramo: si alguien ha bajado 300 filas, la lista no se le
  // encoge bajo el dedo.
  useEffect(() => {
    setVisibleCount(LEADS_RENDER_STEP);
  }, [view, queueState, segFilter, gestFilter, winFilter, edadFilter, srcFilter, numFilter, prodFilter, interactionDateFilter, q, searchMode]);
  const moreSentinelRef = useRef<HTMLDivElement | null>(null);
  const hasMoreRows = displayLeads.length > visibleCount;
  useEffect(() => {
    const node = moreSentinelRef.current;
    if (!node || !hasMoreRows) return;
    if (typeof IntersectionObserver === "undefined") {
      setVisibleCount(Number.MAX_SAFE_INTEGER); // sin observer, se pinta todo (comportamiento previo)
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setVisibleCount((n) => n + LEADS_RENDER_STEP);
      },
      { rootMargin: "800px 0px" }, // se adelanta al scroll: nunca se ve el final de la lista
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [hasMoreRows, visibleCount]);
  const visibleLeads = useMemo(
    () => (hasMoreRows ? displayLeads.slice(0, visibleCount) : displayLeads),
    [displayLeads, hasMoreRows, visibleCount],
  );

  // Exportar la audiencia que estás viendo para subirla a Meta (Custom Audience).
  // El CSV se arma en el navegador a propósito: los facets viven en cliente, así
  // que un endpoint no sabría qué conjunto exportar. Pero la página carga solo un
  // tope de filas en las vistas que no son la cola, y exportar 200 de 1125 daría
  // un público incompleto sin avisar — por eso, cuando lo cargado está truncado,
  // se pide el universo completo al servidor y se le aplican LOS MISMOS facets.
  // Solo se usa para el contador y el `disabled` del botón, pero recorría (y
  // deduplicaba) toda la lista filtrada en cada render aunque nadie fuera a
  // exportar nada. Memoizado cuesta lo mismo una vez que ninguna.
  const audienceRows = useMemo(() => buildMetaAudienceRows(shownLeads), [shownLeads]);
  async function downloadMetaAudience() {
    if (exportingAudience) return;
    setExportingAudience(true);
    try {
      let rows = shownLeads;
      if (!leadsComplete) {
        const all = await loadLeadsForAudience(scope, view);
        if (all.length) rows = all.filter(facetsMatchAll);
      }
      const segment = [view, inQueue ? queueState : null, segFilter, inQueue ? covFilter : null]
        .filter(Boolean)
        .join(" ");
      const today = new Date().toLocaleDateString("en-CA", { timeZone: timezone });
      const url = URL.createObjectURL(
        new Blob([buildMetaAudienceCsv(rows)], { type: "text/csv;charset=utf-8" }),
      );
      const link = document.createElement("a");
      link.href = url;
      link.download = metaAudienceFilename(segment, today);
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } finally {
      setExportingAudience(false);
    }
  }

  // El siguiente lead (MOM §11): solo a quien vende, en «Sin llamar», sin
  // búsqueda. La cola que mira es la que se le pasa: con sus chips y su orden.
  const nextEnabled =
    canHoldNext && !!currentUserId && view === "por_llamar" && queueState === "sin_llamar" && !searchMode;
  const nextLead = useNextLead({
    enabled: nextEnabled,
    queue: displayLeads,
    userId: currentUserId,
    drawerLeadId: selected?.id ?? null,
  });
  const nextHandle = nextLead.lead ? handleOf(nextLead.lead) : null;

  // «SIGUIENTE LEAD» DE LA FICHA (25-10-2026): el de debajo en la lista que
  // está mirando, sin cerrar la ficha. El que venía detrás se anota MIENTRAS
  // la ficha sigue en la lista: guardar la gestión la saca de «Sin llamar», y
  // es justo entonces cuando se pide el siguiente (`leadAfter`).
  const openIndex = selected ? displayLeads.findIndex((l) => l.id === selected.id) : -1;
  const successorRef = useRef<{ openId: string; nextId: string | null } | null>(null);
  useEffect(() => {
    if (!selected || openIndex === -1) return;
    successorRef.current = { openId: selected.id, nextId: displayLeads[openIndex + 1]?.id ?? null };
  }, [selected, openIndex, displayLeads]);
  const followingLead = selected
    ? leadAfter(displayLeads, {
        openId: selected.id,
        userId: currentUserId,
        rememberedNextId: successorRef.current?.openId === selected.id ? successorRef.current.nextId : null,
      })
    : null;

  /**
   * Pasar de la ficha abierta a `next` sin cerrarla. La reserva de la que se
   * deja se suelta ANTES de tomar la otra, como al cerrar: con el tope de dos
   * leads abiertos, tomar primero podía dejarla sin cupo. Si la que se deja es
   * su siguiente reservado, lo suelta `nextLead.release`.
   */
  function openFollowingLead(next: LeadRow) {
    const leaving = selected?.id ?? null;
    // Apagado desde el clic (un doble clic no abre dos), y la ficha que se
    // deja ya no es «la abierta»: su latido no la vuelve a reservar mientras
    // se suelta.
    setOpeningId(next.id);
    activeLeadIdRef.current = null;
    jumpingToRef.current = next.id;
    void (async () => {
      if (nextLead.heldId && nextLead.heldId !== next.id) await nextLead.release();
      if (leaving && leaving !== next.id && leaving !== nextLead.heldId) {
        await releaseLead(leaving).catch(() => undefined);
      }
      // Cerró la ficha mientras se soltaba la otra: no se le vuelve a abrir.
      if (jumpingToRef.current !== next.id) {
        setOpeningId((current) => (current === next.id ? null : current));
        return;
      }
      jumpingToRef.current = null;
      await abrirLeadPorId(next.id, next);
    })();
  }

  // «Más filtros»: lo que no entra en las dos filas de chips.
  const filtersPillRef = useRef<HTMLButtonElement>(null);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const refinementLabels = [
    gestActive && gestFilter ? (gestFilter === "otros" ? "Otros estados" : GESTION_DISPLAY[gestFilter].label) : null,
    inQueue && edadFilter !== "all" ? EDAD_LABEL[edadFilter] : null,
    inQueue && winFilter !== "all" ? `Ventana ${WIN_LABEL[winFilter].toLocaleLowerCase("es")}` : null,
    inQueue && queueState === "sin_llamar" && interactionDateFilter
      ? `Última interacción ${interactionDateFilterLabel(interactionDateFilter)}`
      : null,
    srcFilter.size ? `Fuente (${srcFilter.size})` : null,
    prodFilter.size ? `Producto (${prodFilter.size})` : null,
    numFilter.size ? `Número (${numFilter.size})` : null,
  ].filter((v): v is string => !!v);

  function pickQueueState(nextState: QueueState) {
    // Cambio instantáneo dentro de la cola; desde otra vista, vuelve a ella.
    if (inQueue) {
      setQueueState(nextState);
      if (nextState !== "sin_llamar") setInteractionDateFilter(null);
    } else {
      startRouteTransition(() => {
        router.push(`/dashboard/leads?store=${storeId}&view=por_llamar&state=${nextState}`);
      });
    }
  }

  const storeLabel =
    allStores ? stores.map((s) => s.name).join(" y ") : (storeNameById.get(storeId) ?? stores[0]?.name ?? "");
  const queueTitle = searchMode
    ? "Resultados"
    : view === "por_llamar"
      ? queueState === "sin_llamar"
        ? "Sin llamar"
        : "En seguimiento"
      : VIEW_TITLE[view];

  return (
    <div className="flex flex-col gap-4" aria-busy={routePending}>
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-[28px] font-bold leading-9 tracking-[-0.01em] text-ink-900">Leads</h1>
          <p className="mt-0.5 text-sm text-ink-500">
            {storeLabel}
            {" · "}
            {counts.sin_llamar.toLocaleString("es-PE")} sin llamar
            {" · "}
            {(counts.por_llamar - counts.sin_llamar).toLocaleString("es-PE")} en seguimiento
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {stores.length > 1 &&
            (allStoresAvailable ? (
              <span onPointerEnter={prefetchOtherStores} onFocusCapture={prefetchOtherStores}>
                <ChoicePill
                  label="Tienda"
                  allLabel="Todas las tiendas"
                  allValue={ALL_STORES}
                  options={stores.map((s) => ({ value: s.id, label: s.name }))}
                  value={storeId}
                  onChange={changeStore}
                />
              </span>
            ) : (
              <select
                value={storeId}
                onChange={(e) => changeStore(e.currentTarget.value)}
                onFocus={prefetchOtherStores}
                onPointerDown={prefetchOtherStores}
                disabled={routePending}
                aria-label="Tienda"
                className={cn(FIELD_BOX, "h-9 w-auto pl-3 pr-8")}
              >
                {stores.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            ))}
          <VentaTelefonica
            stores={stores.map((s) => ({ id: s.id, name: s.name }))}
            defaultStoreId={storeId === "all" ? null : storeId}
            onAbrir={(leadId) => abrirLeadPorId(leadId)}
          />
          {/* En la vista combinada no se exporta: un público se sube a UNA
              cuenta publicitaria. Se dice a la vista, no solo en el título. */}
          {allStores ? (
            <span className="inline-flex h-9 items-center gap-2 text-[13px] text-ink-500">
              <IconDownload className="size-4" />
              Audiencia Meta: elige una tienda
            </span>
          ) : (
            <OpsButton
              variant="ghost"
              onClick={downloadMetaAudience}
              disabled={allStores || !audienceRows.length || exportingAudience}
              title={
                allStores
                  ? "Elige una tienda para exportar. Un público personalizado se sube a UNA cuenta publicitaria, así que mezclar las dos marcas da un público más grande que rinde peor."
                  : !audienceRows.length
                    ? "No hay celulares válidos en el filtro actual"
                    : leadsComplete
                      ? `Descarga ${audienceRows.length} celular(es) con el formato de Meta (Públicos personalizados → Lista de clientes). Exporta exactamente los leads filtrados en pantalla.`
                      : "Descarga TODOS los leads del filtro actual (no solo los visibles) con el formato de Meta (Públicos personalizados → Lista de clientes)."
              }
            >
              <IconDownload />
              {exportingAudience ? "Preparando…" : "Audiencia Meta"}
              {/* El contador solo se muestra cuando lo cargado ES el universo
                  completo; si no, un "200" haría creer que el público es de 200
                  cuando el export trae todos. */}
              {!exportingAudience && leadsComplete && audienceRows.length > 0 && (
                <span className="font-normal tabular-nums text-ink-500">{audienceRows.length.toLocaleString("es-PE")}</span>
              )}
            </OpsButton>
          )}
        </div>
      </header>

      {/* El tablero de hoy (opción K): el equipo como ranking contra ayer, sin
          llamar por día y la carrera de pedidos (DESIGN.md › Leads). */}
      <LeadsInsightsPanel
        data={insightsData}
        productividadHref={allStores ? "/dashboard/productividad" : `/dashboard/productividad?store=${storeId}`}
        interactionDateFilter={interactionDateFilter}
        onInteractionDateFilterChange={changeInteractionDateFilter}
      />

      {/* LOS CHIPS, EN DOS FILAS COMO MUCHO Y SIEMPRE A LA VISTA (DESIGN.md ›
          Leads). Arriba, qué lista; abajo, qué leads dentro de ella. Lo que no
          entra va a «Más filtros». */}
      <div className="flex flex-col gap-2">
        {/* La búsqueda y «Más filtros» cierran la primera fila a la derecha:
            «Más filtros» como en la imagen aprobada (J; en la cabecera de la
            cola nadie lo encontraba) y la búsqueda a su lado, bajada de la
            cabecera de la página (Frankz, 14-10-2026). Donde no caben al lado
            de los chips, bajan juntas a su propia línea antes que tapar un
            chip; si los chips solos tampoco caben (un teléfono), se desplazan
            por dentro sin barra. */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <div className={CHIP_ROW}>
            <QueueChip
              label="Sin llamar"
              count={inQueue ? stateCounts.sin_llamar : counts.sin_llamar}
              active={inQueue && queueState === "sin_llamar"}
              onClick={() => pickQueueState("sin_llamar")}
            />
            <QueueChip
              label="En seguimiento"
              count={inQueue ? stateCounts.seguimiento : counts.por_llamar - counts.sin_llamar}
              alert={inQueue ? seguimientoAlert : undefined}
              active={inQueue && queueState === "seguimiento"}
              onClick={() => pickQueueState("seguimiento")}
            />
            <span aria-hidden className="mx-0.5 h-5 w-px shrink-0 bg-line-strong" />
            <AttentionPill
              icon={IconFlash}
              label="Atender ahora"
              count={counts.handoff}
              active={view === "handoff"}
              onClick={() => navigateToView(view === "handoff" ? "por_llamar" : "handoff")}
              hint="Clientes que pidieron hablar con una persona, y los que ya pagaron y esperan que se valide su comprobante"
            />
            <AttentionPill
              icon={IconMoney}
              label="Yape / Shalom"
              count={counts.yape}
              active={view === "yape"}
              onClick={() => navigateToView(view === "yape" ? "por_llamar" : "yape")}
              hint="Pagos por verificar y envíos por agencia"
            />
            <span aria-hidden className="mx-0.5 h-5 w-px shrink-0 bg-line-strong" />
            {REVIEW_VIEWS.map((v) => (
              <ChoiceChip
                key={v.key}
                label={v.label}
                count={counts[v.key]}
                active={view === v.key}
                onClick={() => navigateToView(view === v.key ? "por_llamar" : v.key)}
              />
            ))}
          </div>
          <div className="ml-auto flex w-full items-center gap-2 sm:w-auto">
            <label className="relative block min-w-0 flex-1 sm:w-64 sm:flex-none">
              <span className="sr-only">Buscar lead por nombre o celular</span>
              <IconSearch className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-ink-500" />
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.currentTarget.value)}
                placeholder="Buscar por nombre o celular"
                aria-label="Buscar lead por nombre o celular"
                className={cn(FIELD_BOX, "h-8 w-full pl-8 pr-8 pointer-coarse:h-11 [&::-webkit-search-cancel-button]:hidden")}
              />
              {query && (
                <button
                  type="button"
                  onClick={() => setQuery("")}
                  aria-label="Limpiar búsqueda"
                  className="absolute right-1.5 top-1/2 grid size-6 -translate-y-1/2 place-items-center rounded text-ink-500 hover:text-ink-900"
                >
                  <IconX className="size-3.5" />
                </button>
              )}
            </label>
            <FilterPill
              ref={filtersPillRef}
              label="Más filtros"
              value={refinementLabels.length ? refinementLabels.join(", ") : null}
              expanded={filtersOpen}
              onClick={() => setFiltersOpen((o) => !o)}
              onClear={hasActiveFilters ? clearRefinements : undefined}
            />
          </div>
        </div>

        {/* Segmento y cobertura, scopeados al estado activo (en «Sin llamar»
            suman lo que hay sin llamar, no la cola entera). Sin «Todos»: volver
            a tocar el chip elegido lo quita. */}
        {inQueue && (
          <div className={cn(CHIP_ROW, "gap-x-5")}>
            <ChipGroup label="Segmento">
              {/* Sale de QUEUE_BUCKETS, no de una lista escrita acá: al fusionar
                  `distrito` en `interes`, una lista a mano siguió pidiendo una
                  clave que ya no existía y el chip del balde nuevo, con 490
                  leads, no se dibujó. Invertida porque la fila se lee de menor
                  a mayor intención. */}
              {[...QUEUE_BUCKETS].reverse().map(({ key, label }) => (
                <ChoiceChip
                  key={key}
                  label={label}
                  count={segCounts[key]}
                  active={segFilter === key}
                  onClick={() => setSegFilter(segFilter === key ? null : isQueueBucket(key) ? key : null)}
                />
              ))}
            </ChipGroup>
            <ChipGroup label="Cobertura">
              {LEAD_COVERAGES.map(({ key, label }) => (
                <ChoiceChip
                  key={key}
                  label={label}
                  count={covCounts[key]}
                  active={covFilter === key}
                  onClick={() => setCovFilter(covFilter === key ? null : key)}
                />
              ))}
            </ChipGroup>
          </div>
        )}
      </div>

      {filtersOpen && (
        <Sheet look="ops" title="Más filtros" onClose={() => setFiltersOpen(false)} anchored anchorRef={filtersPillRef} wide>
          <div className="flex flex-col gap-3">
            {view === "por_llamar" && queueState !== "sin_llamar" && (
              <SheetSection title="Gestión">
                <div className="flex flex-wrap gap-1.5">
                  {LEAD_GESTIONES.map((g) => (
                    <ChoiceChip
                      key={g.key}
                      label={GESTION_DISPLAY[g.key].label}
                      count={gestCounts[g.key]}
                      active={gestFilter === g.key}
                      onClick={() => setGestFilter(gestFilter === g.key ? null : g.key)}
                    />
                  ))}
                  {/* «Otros» se queda mientras sea el filtro activo aunque su
                      cuenta caiga a 0, para que siga deseleccionable. */}
                  {(gestOtros > 0 || gestFilter === "otros") && (
                    <ChoiceChip
                      label="Otros estados"
                      count={gestOtros}
                      active={gestFilter === "otros"}
                      onClick={() => setGestFilter(gestFilter === "otros" ? null : "otros")}
                    />
                  )}
                </div>
                <p className="mt-1.5 text-xs text-ink-500">De {gestTotal.toLocaleString("es-PE")} en seguimiento con los demás filtros.</p>
              </SheetSection>
            )}
            {inQueue && (
              <SheetSection title="Edad del lead">
                <div className="flex flex-wrap gap-1.5">
                  {(["dorada", "tibia", "enfriando", "fria"] as const).map((key) => (
                    <ChoiceChip
                      key={key}
                      label={EDAD_LABEL[key]}
                      count={edadCounts[key]}
                      active={edadFilter === key}
                      onClick={() => setEdadFilter(edadFilter === key ? "all" : key)}
                    />
                  ))}
                </div>
                <p className="mt-1.5 text-xs text-ink-500">
                  Desde que entró. Dentro de la primera hora el cierre es el doble. De {edadTotal.toLocaleString("es-PE")}.
                </p>
              </SheetSection>
            )}
            {inQueue && (
              <SheetSection title="Ventana de WhatsApp">
                <div className="flex flex-wrap gap-1.5">
                  <ChoiceChip label="A tiempo" count={winCounts.a_tiempo} active={winFilter === "fresca"} onClick={() => setWinFilter(winFilter === "fresca" ? "all" : "fresca")} />
                  <ChoiceChip label="Por vencer" count={winCounts.por_vencer} active={winFilter === "por_vencer"} onClick={() => setWinFilter(winFilter === "por_vencer" ? "all" : "por_vencer")} />
                  <ChoiceChip label="Vencida" count={winCounts.cerrada} active={winFilter === "cerrada"} onClick={() => setWinFilter(winFilter === "cerrada" ? "all" : "cerrada")} />
                </div>
                <p className="mt-1.5 text-xs text-ink-500">24 horas desde su último mensaje. De {winTotal.toLocaleString("es-PE")}.</p>
              </SheetSection>
            )}
            {inQueue && queueState === "sin_llamar" && (
              <SheetSection title="Última interacción">
                <span className="flex items-center gap-2">
                  <input
                    type="date"
                    aria-label="Día de la última interacción"
                    value={interactionDateFilter?.kind === "day" ? interactionDateFilter.date : ""}
                    max={insightsData?.sinLlamar.at(-1)?.date}
                    onChange={(event) =>
                      changeInteractionDateFilter(
                        event.currentTarget.value ? { kind: "day", date: event.currentTarget.value } : null,
                      )
                    }
                    className={cn(FIELD_BOX, "h-9 w-44 px-3")}
                  />
                  {interactionDateFilter && (
                    <OpsButton size="sm" variant="ghost" onClick={() => changeInteractionDateFilter(null)}>
                      Quitar
                    </OpsButton>
                  )}
                </span>
                {interactionDateFilter?.kind === "older" && (
                  <p className="mt-1.5 text-xs text-ink-500">Mostrando: {interactionDateFilterLabel(interactionDateFilter)}.</p>
                )}
              </SheetSection>
            )}
            {(hasCampaign || hasFbWeb || hasCart || hasBrowse) && (
              <SheetSection title="Fuente">
                <CheckList
                  label="Fuente"
                  selected={srcFilter}
                  onToggle={(key) => setSrcFilter((s) => withToggled(s, key))}
                  options={[
                    ...(hasCampaign ? [{ key: "meta_ad", label: "Campaña", count: srcCounts.meta_ad }] : []),
                    ...(hasFbWeb ? [{ key: "fb_web", label: "Meta / web", count: srcCounts.fb_web }] : []),
                    ...(hasCart ? [{ key: "cod_cart", label: "Carrito", count: srcCounts.cod_cart }] : []),
                    ...(hasBrowse ? [{ key: "abandoned_browse", label: "Búsqueda", count: srcCounts.abandoned_browse }] : []),
                    { key: "organic", label: "Orgánico", count: srcCounts.organic },
                  ]}
                />
              </SheetSection>
            )}
            {(prodOptions.length > 0 || prodFilter.size > 0) && (
              <SheetSection title="Producto">
                <CheckList
                  label="Producto"
                  searchable={prodOptions.length > 8}
                  selected={prodFilter}
                  onToggle={(key) => setProdFilter((s) => withToggled(s, key))}
                  options={[
                    ...prodOptions,
                    // «Sin producto» son los que no llegaron desde una ficha: no
                    // es un producto más, es el resto, y tiene que estar para que
                    // la suma cuadre.
                    ...(prodSin > 0 || prodFilter.has("__none__")
                      ? [{ key: "__none__", label: "Sin producto", count: prodSin }]
                      : []),
                  ]}
                />
              </SheetSection>
            )}
            {hasMultiNumbers && (
              <SheetSection title="Número de WhatsApp">
                <CheckList
                  label="Número"
                  selected={numFilter}
                  onToggle={(key) => setNumFilter((s) => withToggled(s, key))}
                  options={[
                    ...waIds.map((id) => {
                      const n = waNumbers?.[id];
                      const kind = waKindLabel(n?.kind ?? null);
                      return { key: id, label: `${waLabel(n, id)}${kind ? ` · ${kind}` : ""}`, count: waCounts.get(id) ?? 0 };
                    }),
                    // «Sin número» persiste mientras sea el filtro activo.
                    ...(numOtros > 0 || numFilter.has("__none__")
                      ? [{ key: "__none__", label: "Sin número", count: numOtros }]
                      : []),
                  ]}
                />
              </SheetSection>
            )}
            {hasActiveFilters && (
              <div className="border-t border-line pt-3">
                <OpsButton size="sm" onClick={clearRefinements}>
                  Quitar estos filtros
                </OpsButton>
              </div>
            )}
          </div>
        </Sheet>
      )}

      {banner && (
        <Banner tone="crit" role="alert" title="No se pudo tomar el lead">
          {banner}
        </Banner>
      )}

      {/* EL MISMO AVISO, FLOTANDO. El de arriba es el registro, pero vive en la
          cabecera: quien pincha una fila cincuenta más abajo no lo ve, y solo
          nota que la ficha no se abrió. El tope de MAX_OPEN_LEADS lo hizo
          evidente —«¿ya funciona?»— y vale igual para «X está atendiendo este
          lead». Misma cáscara que el aviso de Yape, para que sean el mismo
          objeto a la vista. Se va con «Entendido», con Escape, o al abrir el
          siguiente lead. */}
      {banner && (
        <div
          className="pointer-events-none fixed inset-x-0 top-0 z-50 flex justify-center p-4"
          role="alertdialog"
          aria-live="assertive"
          aria-labelledby="lead-claim-refused-title"
          aria-describedby="lead-claim-refused-text"
        >
          <div className="pointer-events-auto w-full max-w-md overflow-hidden rounded-2xl border-2 border-red-300 bg-white shadow-2xl ring-4 ring-red-500/10">
            <div className="flex items-center gap-2 bg-red-600 px-4 py-2 text-white">
              <IconAlert className="h-5 w-5 shrink-0" aria-hidden="true" />
              <span id="lead-claim-refused-title" className="text-sm font-semibold">
                No se pudo tomar el lead
              </span>
            </div>
            <div className="px-4 py-3">
              <p id="lead-claim-refused-text" className="text-sm text-slate-800">
                {banner}
              </p>
              <button
                ref={bannerDismissRef}
                type="button"
                onClick={() => setBanner(null)}
                className="mt-3 w-full rounded-lg bg-red-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-red-700"
              >
                Entendido
              </button>
            </div>
          </div>
        </div>
      )}

      {/* AQUÍ NO VA NINGUNA MARCA DEL EXPERIMENTO, y es a propósito.
          Se probaron las dos formas de señalarlo en la cola y las dos salieron
          al revés: el empujón (mediana 47 min hasta la llamada contra 14 del
          control) y el aviso con chip (23,5% de leads llamados alguna vez
          contra 34,3% del control, p ≈ 0,04). Marcar un lead como "de la
          prueba" hace que se salte: se lee como "esto no es un pedido de
          verdad". v2 entrega el tratamiento por Telegram, como trabajo normal,
          sin decir que hay una prueba (lib/coverage-push.ts). */}

      {nextEnabled && (
        <NextLeadCard
          state={nextLead}
          now={now}
          product={nextHandle ? productLabel(nextHandle) : null}
          adName={nextLead.lead?.ad_id ? (adNames?.[nextLead.lead.ad_id]?.adName ?? nextLead.lead.ad_headline ?? null) : null}
          storeName={allStores && nextLead.lead ? (storeNameById.get(nextLead.lead.store_id) ?? null) : null}
          coverage={nextLead.lead ? coverageOf(nextLead.lead) : null}
          onOpen={openLead}
          onRegistered={refreshDetail}
          filters={refinementLabels}
          onClearFilters={clearRefinements}
        />
      )}

      {/* Aviso de hora dorada.
          Con la cola real (1.966 sin llamar) esto muestra un puñado de leads, no
          una lista: 21 estaban dentro de la hora y solo 3 eran carrito o interés.
          Ese es justamente el punto — son pocos, valen el doble, y hasta ahora
          iban pintados igual que los 1.945 restantes.

          UN SOLO NÚMERO: el aviso y el botón cuentan lo mismo, la hora entera, y
          el desglose dice qué hay dentro. NO se muestra vacío: una banda
          permanente en cero enseña a ignorarla. La excepción es tenerla
          activada como filtro, donde hay que poder salir. */}
      {view === "por_llamar" && queueState === "sin_llamar" && !searchMode &&
        (goldenTally.total > 0 || edadFilter === "dorada") && (
          <div
            className={cn(
              "flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg px-4 py-2.5 text-sm",
              goldenTally.total > 0 ? "bg-ok-wash text-ink-700" : "bg-wash text-ink-600",
            )}
          >
            {goldenTally.total > 0 ? (
              <>
                <span className="font-semibold text-ok-fg">
                  {goldenTally.total} {goldenTally.total === 1 ? "lead" : "leads"} en hora dorada
                </span>
                <span>
                  {goldenBreakdown(goldenTally)
                    .map((b) => `${b.count} ${b.label}`)
                    .join(" · ")}
                  {" · "}llamados dentro de la primera hora cierran <span className="font-semibold">el doble</span>
                </span>
              </>
            ) : (
              <span>Ya no queda ninguno dentro de la primera hora.</span>
            )}
            <OpsButton
              size="sm"
              className="ml-auto"
              // Limpia también el segmento y la cobertura: el aviso cuenta la
              // hora entera sin mirar esos chips, así que si quedara uno puesto
              // la lista mostraría menos filas que el número del botón.
              onClick={() => {
                if (edadFilter === "dorada") {
                  setEdadFilter("all");
                } else {
                  setEdadFilter("dorada");
                  setSegFilter(null);
                  setCovFilter(null);
                }
              }}
            >
              {edadFilter === "dorada" ? "Ver toda la cola" : `Ver estos ${goldenTally.total}`}
            </OpsButton>
          </div>
        )}

      {/* El 14–20% del carrito está bien medido: un carrito que cierra SIGUE
          teniendo carrito. En frío no: si la llamada funciona, el cliente da su
          distrito o se genera el pedido y el lead DEJA de ser frío. Por eso acá
          se informa el costo de oportunidad (dato sólido) y NO se recomienda
          dejar de llamarlos (eso no lo sabemos). */}
      {view === "por_llamar" && queueState === "sin_llamar" && segFilter === "frio" && (
        <Banner tone="warn" title="Ojo con el costo de oportunidad.">
          Un lead con carrito cierra <span className="font-semibold">14–20 %</span> de las veces que se llama; si
          quedan carritos sin llamar, rinde más ir por ellos primero. Cuánto rinde llamar a un frío todavía no lo
          sabemos: cuando la llamada funciona, el lead da distrito o genera pedido y{" "}
          <span className="font-semibold">deja de contarse como frío</span>.
        </Banner>
      )}

      <section aria-labelledby="cola-titulo" className="overflow-hidden rounded-lg bg-white shadow-control ring-1 ring-line">
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 px-4 py-2.5 shadow-[inset_0_-1px_0_var(--color-line)]">
          <h2 id="cola-titulo" className="text-sm font-semibold text-ink-900">
            {queueTitle}
            <span className="ml-1.5 font-normal tabular-nums text-ink-500">{displayLeads.length.toLocaleString("es-PE")}</span>
            {query.trim().length >= 2 && (
              <span className="ml-2 text-[13px] font-normal text-ink-500">
                {searching ? "Buscando en todas las etapas…" : searchMode ? `para «${query.trim()}» en todas las etapas` : null}
              </span>
            )}
          </h2>
          <div className="flex items-center gap-3">
            {view === "por_llamar" && queueState === "sin_llamar" && !searchMode && (
              <label className="flex items-center gap-2 text-[13px] text-ink-600">
                Orden
                <select
                  value={sortMode}
                  onChange={(event) => setSortMode(event.currentTarget.value as typeof sortMode)}
                  className={cn(FIELD_BOX, "h-8 w-auto py-0 pl-2.5 pr-8 text-[13px] font-medium")}
                >
                  <option value="prioridad">Lo que más cierra</option>
                  <option value="reciente">Más recientes</option>
                </select>
              </label>
            )}
          </div>
        </div>
        {/* Cabecera de columnas — solo md+; en el teléfono cada fila se apila. */}
        <div className="hidden grid-cols-[minmax(0,1fr)_184px_112px_80px] items-center gap-4 px-4 py-2 text-xs font-semibold text-ink-600 shadow-[inset_0_-1px_0_var(--color-line)] md:grid">
          <span>Lead y lo que pidió</span>
          <span>Última gestión</span>
          <span className="text-right" title="Tiempo desde que entró el lead. Dentro de la primera hora el cierre es el doble.">
            Edad
          </span>
          <span />
        </div>
        {visibleLeads.map((lead) => {
          const locked =
            !!lead.claimed_by && isClaimActive(lead.claimed_at) && lead.claimed_by !== currentUserId;
          // Quién la tiene. Puede faltar (la reserva nació después de que
          // cargó la página, o el correo no se pudo leer): entonces la
          // etiqueta vuelve a decir solo «Tomado», nunca un id a medias.
          const lockedBy = locked ? (agentNames?.[lead.claimed_by!] ?? null) : null;
          const mine = lead.id === nextLead.heldId;
          const g = gestionOf(lead.status);
          const gd = g ? GESTION_DISPLAY[g] : { label: labelOf(lead.status), dot: "bg-ink-500" };
          const metaLine = g === "sin_llamar" ? "nadie aún" : fmtDateShort(lead.last_interaction_at);
          const { state } = leadWindowInfo(lead.last_inbound_at ?? lead.last_interaction_at, now);
          const urgency = leadUrgency(lead.first_seen_at, now);
          const ud = urgency ? URGENCY_DISPLAY[urgency.tier] : URGENCY_UNKNOWN;
          // La ventana de 24h solo se nombra cuando limita algo: si está
          // abierta, saberlo no cambia ninguna decisión, y ponerlo en las
          // ~2.000 filas de la cola es el ruido que tapaba la señal.
          const windowNote =
            state === "cerrada" ? "sin ventana" : state === "por_vencer" || state === "critica" ? "ventana por vencer" : null;
          const handle = leadHandle(lead);
          return (
            <div
              key={lead.id}
              role="button"
              tabIndex={0}
              onClick={() => openLead(lead)}
              onPointerEnter={() => void loadLeadDrawerModule()}
              onFocus={() => void loadLeadDrawerModule()}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  openLead(lead);
                }
              }}
              // El anillo va por dentro: la tarjeta recorta lo de fuera.
              style={{ outline: "none" }}
              className={cn(
                "group flex cursor-pointer flex-wrap items-center gap-x-4 gap-y-1.5 border-t border-line px-4 py-2.5 transition-colors [contain-intrinsic-size:auto_58px] [content-visibility:auto] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-500 md:grid md:grid-cols-[minmax(0,1fr)_184px_112px_80px]",
                locked ? "bg-info-wash/60" : "hover:bg-wash",
                openingId === lead.id && "opacity-60",
              )}
            >
              <div className="min-w-0 basis-full md:basis-auto">
                <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="min-w-0 truncate text-sm font-semibold text-ink-900">{lead.name || handle}</span>
                  {/* De qué tienda es esta fila: solo en la vista combinada, que
                      sin esto no dice a nombre de qué marca se llama. */}
                  {allStores && lead.store_id && (
                    <span className="shrink-0 text-xs font-medium text-ink-500">{storeNameById.get(lead.store_id) ?? "—"}</span>
                  )}
                  <SegmentBadge lead={lead} />
                  <YapeKindBadge lead={lead} />
                  {/* Ya pagó y espera (MOM §16.1): es el motivo de la fila, así
                      que la marca genérica «Atención» sobra. */}
                  {lead.pending_voucher && (
                    <Badge tone="warn" title={`${lead.pending_voucher.reason}. Se valida en la ficha del pedido, en Cobro.`}>
                      <IconMoney aria-hidden className="size-3 shrink-0" />
                      {PENDING_VOUCHER_LABEL}
                    </Badge>
                  )}
                  {/* Un reencolado, una respuesta nueva o un seguimiento vencido:
                      sin la marca solo cambiaban el orden. */}
                  {lead.needs_attention && !isYape && !lead.pending_voucher && (
                    <Badge tone="warn" title="Requiere atención: reencolado por carrito sin contacto, respuesta nueva o seguimiento vencido">
                      Atención
                    </Badge>
                  )}
                  {mine && <Badge tone="brand">Tu siguiente</Badge>}
                  {locked && (
                    <Badge tone="info" title={lockedBy ? `${lockedBy} está atendiendo este lead` : "Tomado por otra vendedora"}>
                      <IconLock className="mr-1 size-3" aria-hidden />
                      Tomado
                      {lockedBy && (
                        <>
                          <span aria-hidden="true" className="mx-1">
                            ·
                          </span>
                          <span className="truncate font-medium">{lockedBy}</span>
                        </>
                      )}
                    </Badge>
                  )}
                  {hasMultiNumbers && lead.wa_phone_number_id && (
                    <Badge
                      tone="emerald"
                      title={`WhatsApp: ${waLabel(waNumbers?.[lead.wa_phone_number_id], lead.wa_phone_number_id)}${waNumbers?.[lead.wa_phone_number_id]?.displayPhone ? ` · ${waNumbers[lead.wa_phone_number_id]!.displayPhone}` : ""}`}
                    >
                      {waKindLabel(waNumbers?.[lead.wa_phone_number_id]?.kind ?? null) ??
                        waLabel(waNumbers?.[lead.wa_phone_number_id], lead.wa_phone_number_id)}
                    </Badge>
                  )}
                </div>
                {lead.pending_voucher ? <PendingVoucherLine voucher={lead.pending_voucher} /> : <LeadHookLine lead={lead} />}
              </div>

              <div className="min-w-0">
                {locked ? (
                  <span className="flex items-center gap-1.5 text-[13px] font-medium text-info-fg">
                    <span aria-hidden className="size-2 shrink-0 animate-pulse-dot rounded-full bg-info-fg motion-reduce:animate-none" />
                    Atendiendo ahora
                  </span>
                ) : (
                  <>
                    <span className="flex min-w-0 items-center gap-1.5 text-[13px] text-ink-900">
                      <span aria-hidden className={cn("size-2 shrink-0 rounded-full", gd.dot)} />
                      <span className="truncate">{gd.label}</span>
                    </span>
                    <span className="mt-0.5 block truncate text-xs tabular-nums text-ink-500">{metaLine}</span>
                  </>
                )}
              </div>

              <div className="min-w-0 md:text-right">
                <span
                  title={
                    urgency?.tier === "dorada"
                      ? `Entró hace ${Math.round(urgency.ageMinutes)} min: dentro de la hora dorada, donde el cierre es el doble`
                      : "Tiempo desde que entró el lead"
                  }
                  className={cn("inline-flex items-center gap-1.5 text-[13px] font-medium tabular-nums", ud.fg)}
                >
                  <span
                    aria-hidden
                    className={cn(
                      "size-2 shrink-0 rounded-full",
                      ud.dot,
                      // Solo la hora dorada late: un pulso en cada fila no
                      // llamaría la atención sobre ninguna.
                      urgency?.tier === "dorada" && "animate-pulse-dot motion-reduce:animate-none",
                    )}
                  />
                  {urgency?.tier === "dorada" ? `quedan ${urgency.label}` : (urgency?.label ?? "—")}
                </span>
                {windowNote && (
                  <span className={cn("mt-0.5 block truncate text-xs", state === "cerrada" ? "text-crit-fg" : "text-warn-fg")}>
                    {windowNote}
                  </span>
                )}
              </div>

              {/* Acciones rápidas: al pasar el puntero en escritorio; en el
                  teléfono se abre la ficha tocando la fila. */}
              <div className="ml-auto hidden items-center justify-end gap-1 md:flex">
                {locked ? (
                  <span className="whitespace-nowrap text-xs text-ink-500">en curso</span>
                ) : (
                  <div className="flex items-center gap-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
                    {/* Quien espera la validación no sale con «Resuelto»: sale
                        sola cuando se valida o se rechaza el pago. Lo que sí
                        hace falta es llegar a donde se valida. */}
                    {view === "handoff" && lead.pending_voucher && (
                      <a
                        href={pendingVoucherHref(lead.pending_voucher.orderId)}
                        onClick={(e) => e.stopPropagation()}
                        className={opsButtonClass("primary", "sm")}
                      >
                        Ir a validar
                      </a>
                    )}
                    {view === "handoff" && !lead.pending_voucher && (
                      <OpsButton
                        size="sm"
                        title="Sacar de Atender ahora (handoff resuelto)"
                        onClick={(e) => {
                          e.stopPropagation();
                          startRouteTransition(async () => {
                            await resolveHandoff(lead.id);
                            router.refresh();
                          });
                        }}
                      >
                        <IconCheck />
                        Resuelto
                      </OpsButton>
                    )}
                    {/* Sin número no se ofrece «Llamar»: un `tel:` vacío abre el
                        marcador en blanco y la vendedora cree que falló el equipo.
                        `wa.me` también necesita número: a estos leads se les
                        escribe desde la ficha, que los alcanza por BSUID. */}
                    {leadCanCall(lead) && (
                      <>
                        <a
                          title="Llamar"
                          aria-label={`Llamar a ${lead.name || handle}`}
                          href={`tel:+${lead.phone}`}
                          onClick={(e) => e.stopPropagation()}
                          className={ROW_ACTION}
                        >
                          <IconPhone className="size-4" />
                        </a>
                        <a
                          title="WhatsApp"
                          aria-label={`Abrir WhatsApp con ${lead.name || handle}`}
                          href={`https://wa.me/${lead.phone}`}
                          target="_blank"
                          rel="noreferrer"
                          onClick={(e) => e.stopPropagation()}
                          className={ROW_ACTION}
                        >
                          <IconWhatsApp className="size-4" />
                        </a>
                      </>
                    )}
                  </div>
                )}
              </div>
            </div>
          );
        })}
        {hasMoreRows && (
          // Centinela: al asomarse (con 800px de adelanto) pinta el siguiente
          // tramo. Se ve como una lista normal que nunca acaba de cargar.
          <div ref={moreSentinelRef} className="border-t border-line px-4 py-3 text-center text-xs tabular-nums text-ink-500">
            Cargando más leads… ({visibleLeads.length.toLocaleString("es-PE")} de {displayLeads.length.toLocaleString("es-PE")})
          </div>
        )}
        {!displayLeads.length && (
          <p className="border-t border-line px-4 py-6 text-sm text-ink-500">
            {query.trim()
              ? searching
                ? "Buscando…"
                : `Sin resultados para «${query.trim()}».`
              : view === "handoff" && !leads.length
                ? "Nadie esperando en Atender ahora."
                : leads.length
                  ? "No hay leads con estos filtros."
                  : "No hay leads en esta vista."}
          </p>
        )}
      </section>

      {selected && (
        <LeadDrawer
          lead={selected}
          calls={calls}
          history={history}
          adMeta={selected.ad_id ? (adNames?.[selected.ad_id] ?? null) : null}
          waNumber={selected.wa_phone_number_id ? (waNumbers?.[selected.wa_phone_number_id] ?? null) : null}
          shopifyDomain={stores.find((s) => s.id === selected.store_id)?.shopify_domain ?? null}
          currency={currency}
          onClose={closeDrawer}
          onRegistered={(update) => refreshDetail(selected.id, update)}
          onReady={measureLeadDrawerReady}
          next={{
            lead: followingLead,
            opening: openingId !== null,
            onOpen: () => {
              if (followingLead) openFollowingLead(followingLead);
            },
          }}
        />
      )}
    </div>
  );
}
