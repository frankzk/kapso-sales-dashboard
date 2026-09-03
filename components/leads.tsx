"use client";

import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { type ReactNode, useEffect, useMemo, useRef, useState, useTransition } from "react";
import type { LeadCallRow, LeadRow, StoreSummary } from "@/lib/types";
import type { AdMeta } from "@/lib/meta-ads";
import { waKindLabel, waLabel, type WaNumber } from "@/lib/wa-numbers";
import {
  ALL_STORES,
  type CustomerHistory,
  type LeadCounts,
  type LeadView,
  type StoreScope,
} from "@/lib/leads-access";
import { facetItems } from "@/lib/leads-facets";
import { scoringProfileFor, sortLeadsByPriorityScoped } from "@/lib/lead-priority";
import type { LeadsInsights } from "@/lib/leads-insights";
import {
  buildMetaAudienceCsv,
  buildMetaAudienceRows,
  metaAudienceFilename,
} from "@/lib/meta-audience";
import {
  LEAD_GESTIONES,
  LEAD_SEGMENTS,
  QUEUE_STATES,
  categoryOf,
  countGestiones,
  countLeadSegments,
  countLeadWindows,
  countQueueStates,
  gestionOf,
  isClaimActive,
  labelOf,
  leadHook,
  leadSegment,
  matchesLeadInteractionDate,
  leadWindowInfo,
  matchesQueueState,
  yapeKind,
  type LeadGestion,
  type LeadInteractionDateFilter,
  type LeadHookKind,
  type LeadSegment,
  type LeadWindow,
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
  openLeadDrawer,
  pollLeadsQueueSignature,
  releaseLead,
  resolveHandoff,
  searchLeads,
  loadLeadsForAudience,
} from "@/app/dashboard/leads/actions";
import { claveAnuncio, handleDeAnuncioPara, type AdDeclaration } from "@/lib/ad-products";
import { cn } from "@/components/ui";
import type { LeadDrawerProps, LeadDrawerUpdate } from "@/components/leads-drawer";
import { reportClientPerformanceMetric } from "@/lib/client-performance";

const LeadsInsightsPanel = dynamic(
  () => import("@/components/leads-insights").then((module) => module.LeadsInsightsPanel),
  {
    ssr: false,
    loading: () => (
      <section className="rounded-2xl border border-slate-200 bg-slate-50/60 p-4">
        <div className="mb-4 h-7 w-44 animate-pulse rounded-lg bg-slate-200/70" />
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 4 }).map((_, index) => (
            <div key={index} className="h-56 animate-pulse rounded-xl bg-slate-200/60" />
          ))}
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
      <div className="fixed inset-0 z-10 bg-slate-900/20" aria-hidden="true" />
      <aside
        className="fixed inset-y-0 right-0 z-20 flex h-full w-[min(880px,96%)] flex-col border-l border-slate-200 bg-slate-50 shadow-xl"
        aria-label="Cargando detalle del lead"
      >
        <div className="border-b border-slate-200 bg-white px-5 py-4">
          <div className="h-5 w-44 animate-pulse rounded bg-slate-200" />
          <div className="mt-2 h-4 w-64 animate-pulse rounded bg-slate-100" />
        </div>
        <div className="grid flex-1 place-items-center p-6 text-sm text-slate-500">Cargando atención…</div>
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

// Outcome tabs (right of the separator): distinct buckets, not sub-filters of
// the call queue. "Calientes" was intentionally dropped — casi-cierra leads
// stay reachable in the queue, and paid ones live in Yape/Shalom.
const OUTCOME_VIEWS: { key: LeadView; label: string }[] = [
  { key: "yape", label: "🔥 Yape/Shalom" },
  { key: "seguimientos", label: "Seguimientos" },
  { key: "ganados", label: "Ganados" },
  { key: "perdidos", label: "Perdidos" },
];

const SEGMENT_BADGE: Record<LeadSegment, string> = {
  carrito: "bg-emerald-50 text-emerald-700",
  interes: "bg-amber-50 text-amber-700",
  converso: "bg-blue-50 text-blue-700",
  frio: "bg-slate-100 text-slate-500",
};

// Plain calificación labels (no emoji) for the row/drawer pills, per the redesign.
const SEG_PILL_LABEL: Record<LeadSegment, string> = {
  carrito: "Con carrito",
  interes: "Distrito o producto",
  converso: "Conversó",
  frio: "Frío",
};

// Labels for the segment "accesos directos" row (only Carrito carries an emoji).
const SEG_TAB_LABEL: Record<LeadSegment, string> = {
  carrito: "🛒 Carrito",
  interes: "Distrito o producto",
  converso: "Conversó",
  frio: "Frío",
};

// Terminal outcomes shown in the Calificación column instead of an engagement
// segment — a cancelled lead is "Perdidos", not "🛒 Con carrito".
const OUTCOME_SEG_BADGE: Record<"won" | "lost", { label: string; cls: string }> = {
  won: { label: "Ganados", cls: "bg-emerald-100 text-emerald-700" },
  lost: { label: "Perdidos", cls: "bg-slate-200 text-slate-600" },
};

/** Calificación chip per row. Active leads (open/hot) show their engagement level
 *  (Frío → Conversó → Dio distrito → Con carrito); leads that are already won or
 *  lost show the outcome (Ganados/Perdidos) — the engagement level is meaningless
 *  once the lead is closed, and "Con carrito" on a cancelled lead is misleading.
 *  The specific reason (e.g. "Cancelado por cliente") stays available on hover. */
function SegmentBadge({ lead }: { lead: LeadRow }) {
  const cat = categoryOf(lead.status);
  if (cat === "won" || cat === "lost") {
    const b = OUTCOME_SEG_BADGE[cat];
    return (
      <span
        className={cn("whitespace-nowrap rounded px-1.5 py-0.5 text-xs font-medium", b.cls)}
        title={labelOf(lead.status)}
      >
        {b.label}
      </span>
    );
  }
  const seg = leadSegment(lead);
  // El monto del carrito va en el propio chip: con la cola ordenada por
  // prioridad, entre dos carritos el ticket es lo que decide a cuál llamar
  // primero, y hasta ahora había que abrir el drawer para verlo.
  const cartValue = seg === "carrito" ? Number(lead.cart_value ?? 0) : 0;
  return (
    <span className={cn("whitespace-nowrap rounded px-1.5 py-0.5 text-xs font-medium", SEGMENT_BADGE[seg])}>
      {SEG_PILL_LABEL[seg]}
      {cartValue > 0 && <span className="ml-1 font-semibold">S/ {Math.round(cartValue)}</span>}
    </span>
  );
}

/**
 * Segmented control (single-select): a sunken muted track holding pill options;
 * the active option is a filled brand capsule, the rest are muted text. Used for
 * every leads filter so the toolbar reads as grouped toggles, not loose pills.
 * `onChange` receives the option key — the caller decides whether that sets
 * client state or navigates. value = null (or a key not in the list) → none active.
 */
function SegControl({
  label,
  options,
  value,
  onChange,
}: {
  label?: string;
  options: { key: string; label: string; count?: number; alert?: number }[];
  value: string | null;
  onChange: (key: string) => void;
}) {
  return (
    <div className="flex items-center gap-1.5">
      {label && <span className="shrink-0 text-xs font-medium text-slate-400">{label}</span>}
      <div className="inline-flex items-center gap-0.5 rounded-lg border border-slate-200 bg-slate-100 p-0.5">
        {options.map((o) => {
          const active = o.key === value;
          return (
            <button
              key={o.key}
              type="button"
              aria-pressed={active}
              onClick={() => onChange(o.key)}
              className={cn(
                "inline-flex items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 py-1 text-xs font-medium transition",
                active ? "bg-brand-600 text-white shadow-sm" : "text-slate-500 hover:text-slate-800",
              )}
            >
              {o.label}
              {o.count !== undefined && (
                <span
                  className={cn(
                    "rounded-full px-1.5 text-[11px] font-semibold tabular-nums",
                    active ? "bg-white/25 text-white" : "bg-slate-200 text-slate-500",
                  )}
                >
                  {o.count}
                </span>
              )}
              {/* Semáforo: leads con atención pendiente dentro de este estado
                  (reencolados por ola, respuestas nuevas, seguimientos vencidos).
                  Rojo fuerte a propósito: la deuda debe verse sin abrir el tab. */}
              {!!o.alert && (
                <span
                  title="Requieren atención: reencolados, respuestas nuevas o seguimientos vencidos"
                  className={cn(
                    "rounded-full px-1.5 text-[11px] font-bold tabular-nums",
                    active ? "bg-white text-red-600" : "bg-red-600 text-white",
                  )}
                >
                  {o.alert}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** Multi-select dropdown for filter groups with many options (Fuente, Número).
 *  A compact trigger that opens a checkbox panel; selecting several = OR within
 *  the group. `selected` empty = sin filtro ("Todas/Todos"). Cierra con
 *  click-outside (mismo patrón que el drawer). Los counts por opción vienen
 *  faceteados desde el padre (independientes de la selección del propio grupo). */
function MultiSelect({
  label,
  options,
  selected,
  onToggle,
  onClear,
  summaryAll,
}: {
  label: string;
  options: { key: string; label: string; count?: number }[];
  selected: Set<string>;
  onToggle: (key: string) => void;
  onClear: () => void;
  summaryAll: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const n = selected.size;
  const selectedLabels = options.filter((o) => selected.has(o.key)).map((o) => o.label);
  const summary =
    n === 0
      ? summaryAll
      : selectedLabels.length <= 3
        ? selectedLabels.join(", ") // muestra los nombres elegidos
        : `${selectedLabels.slice(0, 2).join(", ")} +${selectedLabels.length - 2}`; // compacto si son muchos

  return (
    <div className="relative flex items-center gap-1.5" ref={ref}>
      <span className="shrink-0 text-xs font-medium text-slate-400">{label}</span>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg border px-2.5 py-1 text-xs font-medium transition",
          n > 0
            ? "border-brand-300 bg-brand-50 text-brand-700"
            : "border-slate-300 text-slate-600 hover:bg-slate-100 hover:text-slate-900",
        )}
      >
        {summary}
        {n > 0 && (
          <span className="rounded-full bg-brand-600 px-1.5 text-[11px] font-semibold tabular-nums text-white">{n}</span>
        )}
        <span className="text-slate-400" aria-hidden="true">
          ▾
        </span>
      </button>
      {open && (
        <div className="absolute top-full left-0 z-20 mt-1 max-h-72 w-56 overflow-y-auto rounded-lg border border-slate-200 bg-white p-1 shadow-lg">
          <button
            type="button"
            onClick={onClear}
            className="flex w-full items-center rounded-md px-2 py-1.5 text-xs hover:bg-slate-50"
          >
            <span className={cn(n === 0 ? "font-semibold text-brand-700" : "text-slate-600")}>{summaryAll}</span>
          </button>
          {options.map((o) => {
            const on = selected.has(o.key);
            return (
              <button
                key={o.key}
                type="button"
                onClick={() => onToggle(o.key)}
                className="flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-xs hover:bg-slate-50"
              >
                <span className="flex items-center gap-2">
                  <input type="checkbox" readOnly checked={on} className="h-3.5 w-3.5 accent-brand-600" />
                  <span className={cn(on ? "font-medium text-slate-900" : "text-slate-600")}>{o.label}</span>
                </span>
                {o.count !== undefined && <span className="tabular-nums text-slate-400">{o.count}</span>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Presentational helpers for the redesigned board (pixel-perfect with the design
// handoff). Pure styling — all data comes from the existing lib/leads helpers.
// ---------------------------------------------------------------------------

// Avatar tints rotate across 6 soft palettes, keyed by a stable hash of the
// (UUID) id so a lead always gets the same colour.
const AVATAR_TINTS = [
  "bg-brand-50 text-brand-700",
  "bg-violet-50 text-violet-700",
  "bg-emerald-50 text-emerald-700",
  "bg-amber-50 text-amber-700",
  "bg-sky-50 text-sky-700",
  "bg-orange-50 text-orange-700",
];
function avatarTint(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h + id.charCodeAt(i)) % AVATAR_TINTS.length;
  return AVATAR_TINTS[h]!;
}

// Square source chip (📣 Campaña / 🌐 Meta/Web / 🛒 Carrito / 🔎 Búsqueda / "Directo").
const SOURCE_CHIP: Record<
  "meta_ad" | "fb_web" | "cod_cart" | "abandoned_browse" | "organic",
  { glyph: string; label: string; cls: string; title: string; isText?: boolean }
> = {
  meta_ad: { glyph: "📣", label: "Campaña", cls: "bg-violet-100 text-violet-700", title: "Campaña Meta (Click-to-WhatsApp, con anuncio)" },
  fb_web: { glyph: "🌐", label: "Meta/Web", cls: "bg-sky-100 text-sky-700", title: "Llegó por un link de Meta (Facebook/Instagram) en la web (sin anuncio confirmado)" },
  cod_cart: { glyph: "🛒", label: "Carrito", cls: "bg-emerald-100 text-emerald-700", title: "Carrito abandonado (formulario COD)" },
  abandoned_browse: { glyph: "🔎", label: "Búsqueda", cls: "bg-orange-100 text-orange-700", title: "Búsqueda abandonada" },
  organic: { glyph: "Directo", label: "Directo", cls: "bg-slate-100 text-slate-500", title: "Orgánico / directo", isText: true },
};
function SourceChip({ source }: { source: string | null | undefined }) {
  const s = SOURCE_CHIP[leadSourceKey(source)];
  return (
    <span
      title={s.title}
      className={cn(
        "inline-flex h-5 min-w-[22px] shrink-0 items-center justify-center rounded-md px-1.5 font-semibold leading-none",
        s.isText ? "text-[10px]" : "text-[11px]",
        s.cls,
      )}
    >
      {s.glyph}
    </span>
  );
}

// El "anzuelo": con qué abrir la llamada. Sin esto un lead frío es solo un
// nombre y nadie sabe cómo empezar, así que nunca se trabaja. Se muestra el
// producto que miraba, o el anuncio que lo trajo, o sus propias palabras.
const HOOK_DISPLAY: Record<LeadHookKind, { icon: string; title: string; cls: string }> = {
  producto: { icon: "🛒", title: "Producto que miraba / agregó al carrito", cls: "text-emerald-700" },
  anuncio: { icon: "📣", title: "Anuncio por el que llegó", cls: "text-violet-700" },
  mensaje: { icon: "💬", title: "Primer mensaje que escribió el cliente", cls: "text-slate-500" },
};

function LeadHookLine({ lead }: { lead: LeadRow }) {
  const hook = leadHook(lead);
  if (!hook) return null;
  const d = HOOK_DISPLAY[hook.kind];
  return (
    <p
      title={`${d.title}: ${hook.text}`}
      className={cn("mt-0.5 truncate text-[11px] leading-tight", d.cls)}
    >
      <span aria-hidden="true">{d.icon}</span>{" "}
      {hook.kind === "mensaje" ? `“${hook.text}”` : hook.text}
    </p>
  );
}

// Gestión (advisor call-state) → label + dot for the "Última gestión" column.
const GESTION_DISPLAY: Record<LeadGestion, { label: string; dot: string; fg: string; hollow?: boolean }> = {
  sin_llamar: { label: "Sin llamar", dot: "border-[1.5px] border-amber-500", fg: "text-amber-700", hollow: true },
  nr: { label: "No responde", dot: "bg-slate-400", fg: "text-slate-600" },
  buzon_cuelga: { label: "Buzón/Cuelga", dot: "bg-slate-400", fg: "text-slate-600" },
  contactados: { label: "Contactado", dot: "bg-emerald-500", fg: "text-emerald-700" },
  sin_stock: { label: "Sin stock", dot: "bg-blue-500", fg: "text-blue-700" },
};

// 24h window state → dot/text colour + the inset urgency accent (left border).
const WIN_DISPLAY: Record<"fresca" | "por_vencer" | "cerrada", { dot: string; fg: string; accent: string }> = {
  fresca: { dot: "bg-emerald-500", fg: "text-emerald-700", accent: "#34d399" },
  por_vencer: { dot: "bg-amber-500", fg: "text-amber-700", accent: "#fbbf24" },
  cerrada: { dot: "bg-slate-400", fg: "text-slate-500", accent: "#cbd5e1" },
};
function winKey(state: LeadWindow | null): "fresca" | "por_vencer" | "cerrada" {
  if (state === "por_vencer" || state === "critica") return "por_vencer";
  if (state === "cerrada") return "cerrada";
  return "fresca"; // fresca or null (no inbound yet) → neutral-fresh accent
}

/** Small rounded pill (header/drawer chips). */
function Pill({ children, className, title }: { children: ReactNode; className?: string; title?: string }) {
  return (
    <span
      title={title}
      className={cn(
        "inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium",
        className,
      )}
    >
      {children}
    </span>
  );
}

// Chip para leads Yape/Shalom: distingue si el handoff fue por 💰 pago (verificar
// Yape) o 📦 agencia (coordinar el envío por Shalom/Olva). Se deriva del motivo del
// handoff — no parte la pestaña, solo aclara de un vistazo qué media es.
const YAPE_KIND_CHIP: Record<YapeKind, { glyph: string; label: string; cls: string; title: string }> = {
  pago: { glyph: "💰", label: "Pago", cls: "bg-amber-100 text-amber-800", title: "Verificar el pago (Yape / comprobante)" },
  agencia: { glyph: "📦", label: "Agencia", cls: "bg-indigo-100 text-indigo-700", title: "Coordinar el envío por agencia (Shalom / Olva)" },
};

/** Chip 💰 Pago / 📦 Agencia — solo para leads en Yape/Shalom (`yape_por_verificar`). */
function YapeKindChip({ lead }: { lead: LeadRow }) {
  if (lead.status !== "yape_por_verificar") return null;
  const k = YAPE_KIND_CHIP[yapeKind(lead.handoff_reason, lead.handoff_context)];
  return (
    <Pill className={k.cls} title={k.title}>
      {`${k.glyph} ${k.label}`}
    </Pill>
  );
}

/** Single-path stroke icon (Lucide/Feather style) used across the board. */
function StrokeIcon({ d, size = 15 }: { d: string; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={d} />
    </svg>
  );
}
const ICON_PHONE =
  "M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6 19.8 19.8 0 0 1-3.1-8.7A2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L8.1 9.8a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.7 2z";
const ICON_CHAT = "M21 15a2 2 0 0 1-2 2H8l-4 4V5a2 2 0 0 1 2-2h13a2 2 0 0 1 2 2z";

// Cada cuánto se revalida la página en vivo (soft-refresh de datos del servidor).
// Mismo espíritu que ONLINE_POLL_MS de Productividad, un poco más ágil porque
// "Atender ahora" es una cola que se trabaja al momento.
const LEADS_LIVE_POLL_MS = 30_000;
// Red de seguridad del refresco por firma: aunque la firma diga que nada cambió,
// se recarga igualmente de vez en cuando. Cubre lo que la firma no ve (una base
// sin el trigger `leads_touch`, un despliegue sin la migración 0059).
const LEADS_FORCED_REFRESH_MS = 5 * 60_000;
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
  counts,
  queueSignature,
  leads,
  adNames,
  adDeclarations,
  waNumbers,
  currency,
  timezone,
  insights,
  initialState,
  initialSeg,
  initialGest,
  initialInteractionDate,
  initialOpenId,
  currentUserId,
  leadsComplete = true,
  scope,
  allStoresAvailable = false,
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
  currency: string;
  timezone: string;
  insights: LeadsInsights | null;
  initialState?: QueueState | null;
  initialSeg?: LeadSegment | null;
  initialGest?: LeadGestion | null;
  initialInteractionDate?: LeadInteractionDateFilter | null;
  initialOpenId?: string | null; // ?open=<id> → auto-abre ese lead (desde el pop-up de Yapes)
  currentUserId: string;
  /** false = la página cargó solo un tope de filas para esta vista, así que un
   *  export debe repedir el universo completo al servidor. */
  leadsComplete?: boolean;
}) {
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
  const [segFilter, setSegFilter] = useState<LeadSegment | null>(initialSeg ?? null);
  const [gestFilter, setGestFilter] = useState<LeadGestion | "otros" | null>(initialGest ?? null);
  const [winFilter, setWinFilter] = useState<"all" | "fresca" | "por_vencer" | "cerrada">("all");
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
  // Outcome views other than the queue/Yape (Seguimientos/Ganados/Perdidos) live
  // inside the collapsible "Filtros" panel; open it by default when we land on
  // one so the active view is never hidden.
  const isReviewView = view === "seguimientos" || view === "ganados" || view === "perdidos";
  const [more, setMore] = useState<boolean>(isReviewView);
  // Orden de la cola. "prioridad" (por defecto) pone arriba lo que más cierra;
  // "reciente" es el orden viejo, por si alguien quiere barrer por hora de llegada.
  const [sortMode, setSortMode] = useState<"prioridad" | "reciente">("prioridad");
  const [exportingAudience, setExportingAudience] = useState(false);

  // Panel de gráficos (burndown, sin-llamar 7d, conversión, productividad). Se
  // recarga cuando cambia el conteo de la cola — y con el auto-refresco en vivo
  // eso pasa muy seguido. IMPORTANTE: NO se vacía insightsData antes de recargar;
  // si se vaciara, los cuatro gráficos parpadearían a esqueleto varios segundos
  // en CADA recarga. Se deja el panel anterior a la vista y se reemplaza recién
  // cuando llegan los datos nuevos (el usuario no ve el refetch). Cambiar de
  // tienda no arrastra datos viejos: la página remonta el board con
  // key={storeId}:{view}.
  useEffect(() => {
    let alive = true;
    if (insights) {
      setInsightsData(insights);
      return () => {
        alive = false;
      };
    }
    void loadLeadsInsightsPanel(scope, timezone, counts.sin_llamar).then((result) => {
      if (alive && !("error" in result)) setInsightsData(result);
    });
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
    const t = setTimeout(async () => {
      const res = await searchLeads(scope, q);
      if (alive) {
        setResults(res);
        setSearching(false);
      }
    }, 220);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [query, storeId]);

  // Auto-abrir un lead cuando llega ?open=<id> (p. ej. al tocar "Tomar" en el
  // pop-up de Yapes). Solo una vez por id; si no está en la vista cargada, se ignora.
  const openedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!initialOpenId || openedRef.current === initialOpenId) return;
    const lead = leads.find((l) => l.id === initialOpenId);
    if (lead) {
      openedRef.current = initialOpenId;
      openLead(lead);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialOpenId, leads]);

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
  useEffect(() => {
    let alive = true;
    let lastRefreshAt = Date.now();
    const check = async () => {
      if (document.hidden) return;
      if (Date.now() - lastRefreshAt >= LEADS_FORCED_REFRESH_MS) {
        lastRefreshAt = Date.now();
        router.refresh();
        return;
      }
      // Sin firma previa (o sin firma del servidor) no hay nada que comparar:
      // se comporta como antes y recarga.
      const next = await pollLeadsQueueSignature(scope).catch(() => null);
      if (!alive || document.hidden) return;
      if (next === null) return; // fallo puntual: se reintenta al siguiente tick
      if (signatureRef.current !== null && next === signatureRef.current) return;
      signatureRef.current = next;
      lastRefreshAt = Date.now();
      router.refresh();
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
    markLeadDrawerOpen();
    activeLeadIdRef.current = lead.id;
    setBanner(null);
    setSelected(lead); // instant — render from the data we already have
    setCalls(null);
    setHistory(null);
    setOpeningId(lead.id); // disable only this row's button while the claim loads
    void (async () => {
      const historyPromise = loadLeadCustomerHistory(lead.id).catch(() => null);
      try {
        const d = await openLeadDrawer(lead.id);
        if (activeLeadIdRef.current !== lead.id) return;
        if ("error" in d) {
          setBanner(d.error);
          setSelected(null);
          activeLeadIdRef.current = null;
          return;
        }
        setSelected(d.lead);
        setCalls(d.calls);
        void historyPromise.then((extra) => {
          if (!extra || "error" in extra || activeLeadIdRef.current !== lead.id) return;
          setHistory(extra.customerHistory);
          if (extra.cartSummary) {
            setSelected((current) =>
              current?.id === lead.id ? { ...current, cart_summary: extra.cartSummary } : current,
            );
          }
        });
      } finally {
        setOpeningId((current) => (current === lead.id ? null : current));
      }
    })();
  }

  function refreshDetail(leadId: string, update?: LeadDrawerUpdate) {
    if (update) {
      if (activeLeadIdRef.current === leadId) {
        if (update.leadPatch) {
          setSelected((current) => (current?.id === leadId ? { ...current, ...update.leadPatch } : current));
        }
        if (update.savedCall) {
          setCalls((current) => [update.savedCall!, ...(current ?? []).filter((call) => call.id !== update.savedCall!.id)]);
        }
      }
      // The drawer is already current. Only refresh the queue/counts when the
      // mutation can change its membership (a call disposition), and do it in
      // the background without reloading Shopify history or the drawer detail.
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
    })();
  }

  function closeDrawer() {
    const leadId = selected?.id;
    activeLeadIdRef.current = null;
    setSelected(null);
    setCalls(null);
    setHistory(null);
    // Release the claim in the background (fire-and-forget). No full-list refresh
    // on close, and no shared transition that would freeze the row buttons.
    if (leadId) void releaseLead(leadId);
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
      // 2) Si no lo hay —lead antiguo, todavía sin resincronizar— el link del
      //    primer mensaje, que es de donde salía todo antes.
      // 3) Y si tampoco, lo que su anuncio vendía EL DÍA QUE ESTE LEAD ENTRÓ.
      //    No lo que vende hoy: un creativo reutilizado cambia de producto, y
      //    tomar la declaración nueva reescribiría el pasado de los viejos.
      //    Nunca una conjetura: sin declaración vigente el lead se queda en
      //    «Sin producto», que es la verdad.
      const h =
        (l.last_product_handle ?? "").trim() ||
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
    stateCounts,
    seguimientoAlert,
    gestCounts,
    gestTotal,
    gestOtros,
    winCounts,
    winTotal,
    numTotal,
    waCounts,
    numOtros,
    waIds,
    hasMultiNumbers,
    prodOptions,
    prodSin,
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
    const matchSeg = (l: LeadRow) => !inQueue || !segFilter || leadSegment(l) === segFilter;
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
    const facets = facetItems(leads, {
      query: matchQuery,
      src: matchSrc,
      num: matchNum,
      prod: matchProd,
      state: matchState,
      seg: matchSeg,
      gest: matchGest,
      win: matchWin,
      interactionDate: matchInteractionDate,
    });

    const srcBase = facets.except("src");
    const srcCountsAcc = { meta_ad: 0, fb_web: 0, cod_cart: 0, abandoned_browse: 0, organic: 0 };
    for (const l of srcBase) srcCountsAcc[leadSourceKey(l.source)] += 1;

    // Eje 2 (segmento): conteos SCOPEADOS al estado activo. `except("seg")` pasa
    // el facet de estado, así que los segmentos suman el total del estado (p.ej. 237
    // en Sin llamar), no los 429. "Todos" = ese total.
    const segBase = facets.except("seg");
    // Eje 1 (estado): tabs primarios con totales estables (237 / 192). Su base salta
    // el propio estado Y el segmento, para no encogerse al elegir un segmento.
    const stateBase = facets.except("state", "seg");
    const gestBase = facets.except("gest");
    const winBase = facets.except("win");
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
      segCounts: countLeadSegments(segBase),
      segTotal: segBase.length,
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
      numTotal: numBase.length,
      waCounts: waCountsAcc,
      // Leads sin número de WhatsApp asignado (ej. carrito/Shopify): el resto para
      // que Número "Todos" cuadre con la suma de sus chips.
      numOtros: numBase.length - [...waCountsAcc.values()].reduce((a, b) => a + b, 0),
      waIds: waIdsAcc,
      hasMultiNumbers: waIdsAcc.length >= 2,
      prodOptions: prodOptionsAcc,
      prodSin: prodSinAcc,
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
    gestFilter,
    winFilter,
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
    (inQueue && winFilter !== "all") ||
    (inQueue && queueState === "sin_llamar" && !!interactionDateFilter) ||
    srcFilter.size > 0 ||
    numFilter.size > 0 ||
    prodFilter.size > 0;
  // Badge on the "Filtros" button: count the active refinement groups (la pestaña
  // primaria de la cola no cuenta aquí).
  const refinementCount =
    (gestActive ? 1 : 0) +
    (inQueue && winFilter !== "all" ? 1 : 0) +
    (inQueue && queueState === "sin_llamar" && interactionDateFilter ? 1 : 0) +
    (srcFilter.size > 0 ? 1 : 0) +
    (numFilter.size > 0 ? 1 : 0) +
    (prodFilter.size > 0 ? 1 : 0) +
    (isReviewView ? 1 : 0);
  function clearFilters() {
    setSegFilter(null);
    setGestFilter(null);
    setWinFilter("all");
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
  }, [view, queueState, segFilter, gestFilter, winFilter, srcFilter, numFilter, prodFilter, interactionDateFilter, q, searchMode]);
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
      const segment = [view, inQueue ? queueState : null, segFilter].filter(Boolean).join(" ");
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

  return (
    <div className="space-y-4" aria-busy={routePending}>
      {/* Título "Leads" + tablero de hoy (burndown · sin llamar · productividad). */}
      <LeadsInsightsPanel
        data={insightsData}
        allStores={allStores}
        interactionDateFilter={interactionDateFilter}
        onInteractionDateFilterChange={changeInteractionDateFilter}
        titleSlot={
          <div>
            <h1 className="text-xl font-semibold text-slate-900">Leads</h1>
            <p className="mt-0.5 text-sm text-slate-500">
              <span className="font-semibold text-slate-800">{counts.sin_llamar} sin llamar</span>
              {" · "}
              <span className="text-slate-600">{counts.por_llamar - counts.sin_llamar} en seguimiento</span>
              {counts.handoff > 0 && (
                <>
                  {" · "}
                  <button
                    type="button"
                    onClick={() => navigateToView("handoff")}
                    className="font-semibold text-amber-600 hover:underline"
                  >
                    ⚡ {counts.handoff} atender ahora
                  </button>
                </>
              )}
              {counts.yape > 0 && (
                <>
                  {" · "}
                  <button
                    type="button"
                    onClick={() => navigateToView("yape")}
                    className="font-semibold text-red-600 hover:underline"
                  >
                    🔥 {counts.yape} en Yape/Shalom
                  </button>
                </>
              )}
            </p>
          </div>
        }
        actionsSlot={
          stores.length > 1 ? (
            <select
              value={storeId}
              onChange={(e) => changeStore(e.currentTarget.value)}
              onFocus={prefetchOtherStores}
              onPointerDown={prefetchOtherStores}
              disabled={routePending}
              aria-label="Tienda"
              className="rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand-500"
            >
              {allStoresAvailable && (
                <option value={ALL_STORES}>Todas las tiendas</option>
              )}
              {stores.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          ) : null
        }
      />

      <div className="sticky top-0 z-10 space-y-2 bg-slate-50 pt-1 pb-2">
        {/* Toolbar: pestañas de la cola (Sin llamar/En seguimiento/segmento) · píldora Yape/Shalom · Filtros. */}
        <div className="flex items-center gap-2">
          {/* Tira de pestañas: en móvil scrollea sola (no empuja el ancho de la página). */}
          <div className="flex min-w-0 flex-1 items-center gap-2 overflow-x-auto">
          <SegControl
            value={inQueue ? queueState : ""}
            onChange={(key) => {
              // Cambio de tab instantáneo (client-side, sin refetch); desde una vista
              // de revisión, navega de vuelta a la cola en ese estado.
              if (inQueue) {
                const nextState = key as QueueState;
                setQueueState(nextState);
                if (nextState !== "sin_llamar") setInteractionDateFilter(null);
              } else {
                startRouteTransition(() => {
                  router.push(`/dashboard/leads?store=${storeId}&view=por_llamar&state=${key}`);
                });
              }
            }}
            options={QUEUE_STATES.map((s) => ({
              key: s.key,
              label: s.label,
              count: inQueue ? stateCounts[s.key] : undefined,
              alert: inQueue && s.key === "seguimiento" ? seguimientoAlert || undefined : undefined,
            }))}
          />
          {counts.yape > 0 && (
            <button
              type="button"
              aria-pressed={view === "yape"}
              onClick={() => navigateToView(view === "yape" ? "por_llamar" : "yape")}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-semibold transition",
                view === "yape"
                  ? "border-red-600 bg-red-600 text-white"
                  : "border-red-200 bg-red-50 text-red-700 hover:bg-red-100",
              )}
            >
              🔥 Yape/Shalom
              <span
                className={cn(
                  "rounded-full px-1.5 tabular-nums",
                  view === "yape" ? "bg-white/25 text-white" : "bg-white text-red-700",
                )}
              >
                {counts.yape}
              </span>
            </button>
          )}
          </div>
          <div className="relative w-40 shrink-0 sm:w-52">
            <svg
              aria-hidden="true"
              viewBox="0 0 20 20"
              fill="none"
              className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-slate-400"
            >
              <circle cx="9" cy="9" r="6" stroke="currentColor" strokeWidth="2" />
              <path d="m14 14 4 4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.currentTarget.value)}
              placeholder="Buscar lead…"
              aria-label="Buscar lead por nombre o celular"
              className="w-full rounded-lg border border-slate-300 py-1.5 pr-8 pl-9 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery("")}
                aria-label="Limpiar búsqueda"
                className="absolute top-1/2 right-2 -translate-y-1/2 rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
              >
                ✕
              </button>
            )}
          </div>
          <button
            type="button"
            aria-expanded={more}
            onClick={() => setMore((v) => !v)}
            className={cn(
              "inline-flex shrink-0 items-center gap-2 rounded-lg border px-3 py-1.5 text-sm font-medium transition",
              more
                ? "border-brand-300 bg-brand-50 text-brand-700"
                : "border-slate-300 text-slate-600 hover:bg-slate-100",
            )}
          >
            <StrokeIcon d="M3 5h18M6 12h12M10 19h4" />
            Filtros
            {refinementCount > 0 && (
              <span className="rounded-full bg-brand-600 px-1.5 text-[11px] font-semibold tabular-nums text-white">
                {refinementCount}
              </span>
            )}
          </button>
          <button
            type="button"
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
            className="inline-flex shrink-0 items-center gap-2 rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-600 transition hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <StrokeIcon d="M12 4v10m0 0-4-4m4 4 4-4M5 19h14" />
            {exportingAudience ? "Preparando…" : "Audiencia Meta"}
            {/* El contador solo se muestra cuando lo cargado ES el universo
                completo; si no, un "200" haría creer que el público es de 200
                cuando el export trae todos. */}
            {!exportingAudience && leadsComplete && audienceRows.length > 0 && (
              <span className="rounded-full bg-slate-200 px-1.5 text-[11px] font-semibold tabular-nums text-slate-700">
                {audienceRows.length}
              </span>
            )}
          </button>
        </div>

        {/* Fila 2 — accesos directos por segmento, scopeados al tab de estado activo
            (en "Sin llamar" suman los 237, no los 429; en "En seguimiento", los 192). */}
        {inQueue && (
          <div className="flex min-w-0 items-center gap-2 overflow-x-auto">
            <SegControl
              label="Segmento"
              value={segFilter ?? "all"}
              onChange={(key) => setSegFilter(key === "all" ? null : (key as LeadSegment))}
              options={[
                { key: "all", label: "Todos", count: segTotal },
                // Sale de LEAD_SEGMENTS, no de una lista escrita acá. Estaba a
                // mano y con un `as LeadSegment[]` que silenciaba al compilador:
                // al fusionar `distrito` en `interes`, esta fila siguió pidiendo
                // «distrito» —una clave que ya no existe— y el chip del balde
                // nuevo, con 490 leads dentro, no se dibujó. Los segmentos
                // dejaron de sumar el total y nadie podía filtrarlos.
                // Invertida porque la fila se lee de menor a mayor intención.
                ...[...LEAD_SEGMENTS].reverse().map(({ key }) => ({
                  key,
                  label: SEG_TAB_LABEL[key],
                  count: segCounts[key],
                })),
              ]}
            />
            {interactionDateFilter && queueState === "sin_llamar" && (
              <button
                type="button"
                onClick={() => changeInteractionDateFilter(null)}
                aria-label="Quitar filtro de última interacción"
                className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-brand-200 bg-brand-50 px-2.5 py-1 text-xs font-medium text-brand-700 hover:bg-brand-100"
              >
                Última interacción: {interactionDateFilterLabel(interactionDateFilter)}
                <span aria-hidden="true">×</span>
              </button>
            )}
          </div>
        )}

        {/* Panel "Más filtros" (colapsable): refinos de la cola · Fuente · Número · Vista. */}
        {more && (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-3 rounded-xl border border-slate-200 bg-white px-3.5 py-3 shadow-sm">
            {view === "por_llamar" && queueState !== "sin_llamar" && (
              <SegControl
                label="Gestión"
                value={gestFilter ?? "all"}
                onChange={(key) => setGestFilter(key === "all" ? null : (key as LeadGestion | "otros"))}
                options={[
                  { key: "all", label: "Todos", count: gestTotal },
                  ...LEAD_GESTIONES.map((g) => ({ key: g.key, label: g.label, count: gestCounts[g.key] })),
                  // Mantener el chip "Otros" mientras sea el filtro activo aunque su
                  // count caiga a 0, para que siga deseleccionable (no quede huérfano).
                  ...(gestOtros > 0 || gestFilter === "otros"
                    ? [{ key: "otros", label: "Otros", count: gestOtros }]
                    : []),
                ]}
              />
            )}
            {view === "por_llamar" && queueState === "sin_llamar" && !searchMode && (
              <label className="flex items-center gap-2 text-xs text-slate-500">
                Orden
                <select
                  value={sortMode}
                  onChange={(event) => setSortMode(event.currentTarget.value as typeof sortMode)}
                  className="rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs text-slate-700 outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
                >
                  <option value="prioridad">Prioridad (lo que más cierra)</option>
                  <option value="reciente">Más recientes</option>
                </select>
              </label>
            )}
            {view === "por_llamar" && queueState === "sin_llamar" && (
              <label className="flex items-center gap-2 text-xs text-slate-500">
                Última interacción
                <input
                  type="date"
                  value={interactionDateFilter?.kind === "day" ? interactionDateFilter.date : ""}
                  max={insightsData?.sinLlamar.at(-1)?.date}
                  onChange={(event) =>
                    changeInteractionDateFilter(
                      event.currentTarget.value
                        ? { kind: "day", date: event.currentTarget.value }
                        : null,
                    )
                  }
                  className="rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs text-slate-700 outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
                />
              </label>
            )}
            {view === "por_llamar" && (
              <SegControl
                label="Ventana"
                value={winFilter}
                onChange={(key) => setWinFilter(key as "all" | "fresca" | "por_vencer" | "cerrada")}
                options={[
                  { key: "all", label: "Todos", count: winTotal },
                  { key: "fresca", label: "🟢 A tiempo", count: winCounts.a_tiempo },
                  { key: "por_vencer", label: "⏳ Por vencer", count: winCounts.por_vencer },
                  { key: "cerrada", label: "⚫ Vencido", count: winCounts.cerrada },
                ]}
              />
            )}
            {(hasCampaign || hasFbWeb || hasCart || hasBrowse) && (
              <MultiSelect
                label="Fuente"
                summaryAll="Todas"
                selected={srcFilter}
                onToggle={(key) => setSrcFilter((s) => withToggled(s, key))}
                onClear={() => setSrcFilter(new Set())}
                options={[
                  ...(hasCampaign ? [{ key: "meta_ad", label: "📣 Campaña", count: srcCounts.meta_ad }] : []),
                  ...(hasFbWeb ? [{ key: "fb_web", label: "🌐 Meta/Web", count: srcCounts.fb_web }] : []),
                  ...(hasCart ? [{ key: "cod_cart", label: "🛒 Carrito", count: srcCounts.cod_cart }] : []),
                  ...(hasBrowse
                    ? [{ key: "abandoned_browse", label: "🔎 Búsqueda", count: srcCounts.abandoned_browse }]
                    : []),
                  { key: "organic", label: "Orgánico", count: srcCounts.organic },
                ]}
              />
            )}
            {(prodOptions.length > 0 || prodFilter.size > 0) && (
              <MultiSelect
                label="Producto"
                summaryAll="Todos"
                selected={prodFilter}
                onToggle={(key) => setProdFilter((s) => withToggled(s, key))}
                onClear={() => setProdFilter(new Set())}
                options={[
                  ...prodOptions,
                  // «Sin producto» son los que no llegaron desde una ficha: los
                  // que dieron su distrito, los del carrito, los que solo
                  // saludaron. No es un producto más, es el resto — y tiene que
                  // estar para que la suma cuadre con «Todos».
                  ...(prodSin > 0 || prodFilter.has("__none__")
                    ? [{ key: "__none__", label: "Sin producto", count: prodSin }]
                    : []),
                ]}
              />
            )}
            {hasMultiNumbers && (
              <MultiSelect
                label="Número"
                summaryAll="Todos"
                selected={numFilter}
                onToggle={(key) => setNumFilter((s) => withToggled(s, key))}
                onClear={() => setNumFilter(new Set())}
                options={[
                  ...waIds.map((id) => {
                    const n = waNumbers?.[id];
                    const kind = waKindLabel(n?.kind ?? null);
                    return {
                      key: id,
                      label: `📱 ${waLabel(n, id)}${kind ? ` · ${kind}` : ""}`,
                      count: waCounts.get(id) ?? 0,
                    };
                  }),
                  // El chip "Sin número" persiste mientras sea el filtro activo aunque
                  // su count sea 0, para poder deseleccionarlo desde el panel.
                  ...(numOtros > 0 || numFilter.has("__none__")
                    ? [{ key: "__none__", label: "Sin número", count: numOtros }]
                    : []),
                ]}
              />
            )}
            {/* Vista: la cola + las vistas de revisión (Yape tiene su píldora aparte). */}
            <SegControl
              label="Vista"
              value={isReviewView ? view : view === "por_llamar" ? "por_llamar" : ""}
              onChange={navigateToView}
              options={[
                { key: "por_llamar", label: "Cola", count: counts.por_llamar },
                ...OUTCOME_VIEWS.filter((v) => v.key !== "yape").map((v) => ({
                  key: v.key,
                  label: v.label,
                  count: counts[v.key],
                })),
              ]}
            />
            {hasActiveFilters && (
              <button
                type="button"
                onClick={clearFilters}
                className="inline-flex items-center gap-1 rounded-lg border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-600 hover:bg-slate-100 hover:text-slate-900"
              >
                ✕ Limpiar
              </button>
            )}
          </div>
        )}
      </div>

      {banner && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-700">
          {banner}
        </div>
      )}

      {/* El 14–20% del carrito está bien medido: un carrito que cierra SIGUE
          teniendo carrito, así que el éxito no cambia su etiqueta. En frío no se
          puede afirmar lo mismo: si la llamada funciona, el cliente da su
          distrito o se genera el pedido y el lead DEJA de ser frío. O sea que el
          balde "frío" es, por construcción, el de los casos donde la llamada NO
          funcionó, y medir su tasa de cierre es casi una tautología.
          Por eso acá se informa el costo de oportunidad (dato sólido) y NO se
          recomienda dejar de llamarlos (eso no lo sabemos). Medirlo bien necesita
          el segmento AL MOMENTO de la llamada, no el de hoy. */}
      {view === "por_llamar" && queueState === "sin_llamar" && segFilter === "frio" && (
        <div className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-2.5 text-sm text-amber-900">
          ⚠️ <span className="font-semibold">Ojo con el costo de oportunidad.</span> Un lead con
          carrito cierra <span className="font-semibold">14–20%</span> de las veces que se llama; si
          quedan carritos sin llamar, rinde más ir por ellos primero. Cuánto rinde llamar a un frío
          todavía no lo sabemos: cuando la llamada funciona, el lead da distrito o genera pedido y{" "}
          <span className="font-semibold">deja de contarse como frío</span>.
        </div>
      )}

      {query.trim().length >= 2 && (
        <p className="text-xs text-slate-500">
          {searching
            ? "Buscando en todas las etapas…"
            : searchMode
              ? `🔎 ${displayLeads.length} resultado${displayLeads.length === 1 ? "" : "s"} para «${query.trim()}» · en todas las etapas`
              : null}
        </p>
      )}

      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="overflow-x-auto">
          <div className="min-w-0">
            {/* Cabecera de columnas — solo md+; en móvil cada fila se apila. */}
            <div className="hidden grid-cols-[42px_minmax(0,1fr)_184px_78px_78px] items-center gap-[14px] border-b border-slate-200 bg-slate-50 px-[18px] py-2.5 text-[11px] font-semibold tracking-wide text-slate-400 uppercase md:grid">
              <span />
              <span>Lead</span>
              <span>Última gestión</span>
              <span>Ventana</span>
              <span />
            </div>
            {visibleLeads.map((lead) => {
              const locked =
                !!lead.claimed_by && isClaimActive(lead.claimed_at) && lead.claimed_by !== currentUserId;
              const g = gestionOf(lead.status);
              const gd = g
                ? GESTION_DISPLAY[g]
                : { label: labelOf(lead.status), dot: "bg-slate-400", fg: "text-slate-600", hollow: false };
              const metaLine = g === "sin_llamar" ? "nadie aún" : fmtDateShort(lead.last_interaction_at);
              const { state, msLeft } = leadWindowInfo(lead.last_inbound_at ?? lead.last_interaction_at, now);
              const wd = WIN_DISPLAY[winKey(state)];
              const windowLabel =
                state === null
                  ? "—"
                  : state === "cerrada"
                    ? "venc."
                    : `${Math.max(1, Math.ceil((msLeft ?? 0) / 3_600_000))}h`;
              const handle = leadHandle(lead);
              const initial = (lead.name || handle).trim()[0]?.toUpperCase() || "?";
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
                  className={cn(
                    // Móvil: tarjeta apilada (flex-wrap). md+: el grid de columnas.
                    "group flex cursor-pointer flex-wrap items-center gap-x-3 gap-y-2 border-b border-slate-100 px-4 py-3 transition [contain-intrinsic-size:auto_54px] [content-visibility:auto] last:border-0 md:grid md:grid-cols-[42px_minmax(0,1fr)_184px_78px_78px] md:gap-x-[14px] md:gap-y-0 md:px-[18px] md:py-2.5",
                    locked ? "bg-brand-50" : isYape ? "bg-red-50" : "hover:bg-slate-50",
                    openingId === lead.id && "opacity-60",
                  )}
                  style={{ boxShadow: `inset 3px 0 0 ${wd.accent}` }}
                >
                  {/* Col 1 · avatar */}
                  <span
                    className={cn(
                      "flex h-8 w-8 items-center justify-center rounded-full text-sm font-semibold",
                      avatarTint(lead.id),
                    )}
                  >
                    {initial}
                  </span>

                  {/* Col 2 · lead (en móvil ocupa la 1ª línea; gestión/ventana bajan) */}
                  <div className="min-w-0 flex-1 md:flex-none">
                  <div className="flex min-w-0 items-center gap-1.5">
                    <span className="truncate text-sm font-semibold text-slate-900">{lead.name || handle}</span>
                    {/* De qué tienda es esta fila. Solo en vista combinada: con una
                        sola tienda seleccionada repetiría el mismo texto en cada
                        fila y no informa nada. Es lo único que hace legible la
                        cola mezclada — sin esto no se sabe a nombre de qué marca
                        se está llamando. */}
                    {allStores && lead.store_id && (
                      <span className="shrink-0 rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold text-slate-600">
                        {storeNameById.get(lead.store_id) ?? "—"}
                      </span>
                    )}
                    {isYape && <span aria-hidden="true">🔥</span>}
                    <SourceChip source={lead.source} />
                    <span className="shrink-0">
                      <SegmentBadge lead={lead} />
                    </span>
                    <span className="shrink-0">
                      <YapeKindChip lead={lead} />
                    </span>
                    {/* Marcador de atención: sin esto un reencolado (ola 🔁),
                        una respuesta nueva o un seguimiento vencido eran
                        invisibles en la fila — solo cambiaban el orden. */}
                    {lead.needs_attention && !isYape && (
                      <span
                        title="Requiere atención: reencolado por carrito sin contacto, respuesta nueva o seguimiento vencido"
                        className="inline-flex shrink-0 items-center gap-1 rounded-full bg-red-50 px-1.5 py-0.5 text-[11px] font-semibold text-red-600"
                      >
                        <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-red-600" />
                        atención
                      </span>
                    )}
                    {locked && (
                      <span
                        title="Tomado por otro vendedor"
                        className="inline-flex shrink-0 items-center gap-1 rounded-full bg-brand-100 px-2 py-0.5 text-[11px] font-semibold text-brand-700"
                      >
                        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
                          <rect x="5" y="11" width="14" height="9" rx="2" />
                          <path d="M8 11V8a4 4 0 0 1 8 0v3" />
                        </svg>
                        Tomado
                      </span>
                    )}
                    {hasMultiNumbers && lead.wa_phone_number_id && (
                      <span
                        className="shrink-0 rounded bg-sky-100 px-1.5 py-0.5 text-[11px] font-medium text-sky-700"
                        title={`WhatsApp: ${waLabel(waNumbers?.[lead.wa_phone_number_id], lead.wa_phone_number_id)}${waNumbers?.[lead.wa_phone_number_id]?.displayPhone ? ` · ${waNumbers[lead.wa_phone_number_id]!.displayPhone}` : ""}`}
                      >
                        📱{" "}
                        {waKindLabel(waNumbers?.[lead.wa_phone_number_id]?.kind ?? null) ??
                          waLabel(waNumbers?.[lead.wa_phone_number_id], lead.wa_phone_number_id)}
                      </span>
                    )}
                  </div>
                  <LeadHookLine lead={lead} />
                  </div>

                  {/* Col 3 · última gestión */}
                  <div className="min-w-0">
                    {locked ? (
                      <div className="flex items-center gap-1.5 text-xs font-semibold text-brand-700">
                        <span className="h-[7px] w-[7px] shrink-0 animate-pulse-dot rounded-full bg-brand-500 motion-reduce:animate-none" />
                        Atendiendo ahora
                      </div>
                    ) : (
                      <>
                        <div className={cn("flex min-w-0 items-center gap-1.5 text-xs font-semibold", gd.fg)}>
                          <span
                            className={cn(
                              "h-[7px] w-[7px] shrink-0 rounded-full",
                              gd.hollow ? "border-[1.5px] border-amber-500" : gd.dot,
                            )}
                          />
                          <span className="truncate">{gd.label}</span>
                        </div>
                        <div className="mt-0.5 truncate text-[11px] text-slate-400">{metaLine}</div>
                      </>
                    )}
                  </div>

                  {/* Col 4 · ventana */}
                  <span className={cn("inline-flex items-center gap-1.5 text-sm font-semibold", wd.fg)}>
                    <span className={cn("h-[7px] w-[7px] shrink-0 rounded-full", wd.dot)} />
                    {windowLabel}
                  </span>

                  {/* Col 5 · acciones rápidas (hover en desktop; ocultas en móvil, ahí se abre tocando la fila) */}
                  <div className="ml-auto hidden items-center justify-end gap-1.5 md:flex">
                    {locked ? (
                      <span className="text-[11px] whitespace-nowrap text-slate-400">en curso</span>
                    ) : (
                      <div className="flex items-center gap-1.5 opacity-0 transition group-hover:opacity-100 focus-within:opacity-100">
                        {view === "handoff" && (
                          <button
                            type="button"
                            title="Sacar de Atender ahora (handoff resuelto)"
                            onClick={(e) => {
                              e.stopPropagation();
                              startRouteTransition(async () => {
                                await resolveHandoff(lead.id);
                                router.refresh();
                              });
                            }}
                            className="inline-flex h-[30px] items-center rounded-md border border-emerald-300 bg-emerald-50 px-2 text-[11px] font-semibold text-emerald-700 hover:bg-emerald-100"
                          >
                            ✓ Resuelto
                          </button>
                        )}
                        {/* Sin número no se ofrece «Llamar»: un `tel:` vacío abre el
                            marcador en blanco y la asesora cree que falló el equipo.
                            Y `wa.me` también necesita número — a estos leads se les
                            escribe desde el drawer, que los alcanza por BSUID. */}
                        {leadCanCall(lead) && (
                          <>
                            <a
                              title="Llamar"
                              href={`tel:+${lead.phone}`}
                              onClick={(e) => e.stopPropagation()}
                              className="inline-flex h-[30px] w-[30px] items-center justify-center rounded-md border border-slate-300 bg-white text-slate-600 hover:bg-slate-50"
                            >
                              <StrokeIcon d={ICON_PHONE} />
                            </a>
                            <a
                              title="WhatsApp"
                              href={`https://wa.me/${lead.phone}`}
                              target="_blank"
                              rel="noreferrer"
                              onClick={(e) => e.stopPropagation()}
                              className="inline-flex h-[30px] w-[30px] items-center justify-center rounded-md border border-slate-300 bg-white text-slate-600 hover:bg-slate-50"
                            >
                              <StrokeIcon d={ICON_CHAT} />
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
              <div ref={moreSentinelRef} className="px-[18px] py-4 text-center text-xs text-slate-400">
                Cargando más leads… ({visibleLeads.length} de {displayLeads.length})
              </div>
            )}
            {!displayLeads.length && (
              <div className="px-[18px] py-6 text-sm text-slate-400">
                {query.trim()
                  ? searching
                    ? "Buscando…"
                    : `Sin resultados para «${query.trim()}».`
                  : view === "handoff" && !leads.length
                    ? "🎉 Cola en cero — no hay handoffs esperando. Buen trabajo."
                    : leads.length
                      ? "No hay leads de esta fuente en la vista."
                      : "No hay leads en esta vista."}
              </div>
            )}
          </div>
        </div>
      </div>

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
        />
      )}
    </div>
  );
}
