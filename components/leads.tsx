"use client";

import { useRouter } from "next/navigation";
import { type ReactNode, useActionState, useCallback, useEffect, useRef, useState, useTransition } from "react";
import type { LeadCallRow, LeadRow, StoreSummary } from "@/lib/types";
import {
  adObjectiveLabel,
  adStatusLabel,
  adsManagerUrl,
  prettyAdName,
  type AdMeta,
} from "@/lib/meta-ads";
import { waKindLabel, waLabel, type WaNumber } from "@/lib/wa-numbers";
import { type CustomerHistory, type LeadView } from "@/lib/leads-access";
import { LeadsInsightsPanel } from "@/components/leads-insights";
import type { LeadsInsights } from "@/lib/leads-insights";
import {
  LEAD_GESTIONES,
  MANUAL_STATUSES,
  categoryOf,
  countGestiones,
  countLeadSegments,
  countLeadWindows,
  gestionOf,
  isClaimActive,
  labelOf,
  leadSegment,
  leadWindowInfo,
  type LeadGestion,
  type LeadSegment,
  type LeadWindow,
} from "@/lib/leads";
import {
  claimLead,
  createQuickReply,
  deleteQuickReply,
  generateOrder,
  getLeadWindow,
  listQuickReplies,
  loadLeadConversation,
  loadLeadDetail,
  loadOrderDraft,
  registerCall,
  releaseLead,
  createWaMediaUpload,
  searchLeads,
  searchStoreProducts,
  sendLeadMedia,
  sendLeadMessage,
  type LeadActionState,
  type LeadConversationMessage,
  type LeadThread,
  type QuickReply,
} from "@/app/dashboard/leads/actions";
import { createBrowserSupabase } from "@/lib/supabase-browser";
import { cn } from "@/components/ui";
import { YapeAssign } from "@/components/yape-alerts";

const inputCls =
  "mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100";
const labelCls = "block text-sm font-medium text-slate-700";

/** Canonical acquisition-source bucket for a lead's `source` (Fuente filter). */
function leadSourceKey(s: string | null | undefined): "meta_ad" | "cod_cart" | "abandoned_browse" | "organic" {
  return s === "meta_ad"
    ? "meta_ad"
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

function fmtDate(value: string | null | undefined): string {
  if (!value) return "—";
  return new Date(value).toLocaleString("es-PE");
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

/** "12 may" — compact day+month for the previous-orders list. */
function orderDateShort(value: string | null | undefined): string {
  if (!value) return "—";
  return new Date(value).toLocaleDateString("es-PE", { day: "numeric", month: "short" });
}

/** One label/value line inside the Meta attribution block (drawer). */
function MetaField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex gap-2">
      <dt className="w-20 shrink-0 text-xs font-medium text-violet-700/70">{label}</dt>
      <dd className="min-w-0 flex-1 break-words text-violet-900">{children}</dd>
    </div>
  );
}

/** Full Meta ad attribution for the lead drawer: the real creative plus the
 *  campaign / adset / objective / status chain behind the Click-to-WhatsApp
 *  lead. Falls back to a one-liner when the ad_id hasn't been resolved into the
 *  `meta_ads` lookup yet (only headline + id are then known). */
function MetaAttribution({ lead, adMeta }: { lead: LeadRow; adMeta: AdMeta | null }) {
  const [open, setOpen] = useState(false);
  const name = adMeta?.adName ? prettyAdName(adMeta.adName) : null;
  const href = adsManagerUrl(adMeta?.accountId ?? null, lead.ad_id ?? "");
  const objective = adObjectiveLabel(adMeta?.objective ?? null);
  const status = adStatusLabel(adMeta?.status ?? null);
  return (
    <div className="rounded-xl border border-violet-200 bg-violet-50 px-3 py-2 text-sm text-violet-900">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-2"
      >
        <span className="text-xs font-semibold tracking-wide uppercase opacity-80">📣 Campaña Meta</span>
        <span className="shrink-0 text-xs text-violet-700">{open ? "ocultar ▲" : "ver más ▼"}</span>
      </button>
      {!open ? (
        <p className="mt-1 truncate text-xs text-violet-800">
          {lead.ad_headline || name || "Llegó por un anuncio de Meta"}
        </p>
      ) : (
        <dl className="mt-1.5 space-y-1">
        {lead.ad_headline && <MetaField label="Titular">{lead.ad_headline}</MetaField>}
        {name ? (
          <MetaField label="Anuncio">
            {href ? (
              <a
                href={href}
                target="_blank"
                rel="noreferrer"
                className="font-medium text-violet-800 underline decoration-violet-300 hover:decoration-violet-600"
              >
                {name}
              </a>
            ) : (
              <span className="font-medium">{name}</span>
            )}
          </MetaField>
        ) : (
          <p className="text-violet-800">📣 Llegó por un anuncio de Meta (Click-to-WhatsApp)</p>
        )}
        {adMeta?.adsetName && <MetaField label="Conjunto">{adMeta.adsetName}</MetaField>}
        {adMeta?.campaignName && <MetaField label="Campaña">{adMeta.campaignName}</MetaField>}
        {objective && <MetaField label="Objetivo">{objective}</MetaField>}
        {status && (
          <MetaField label="Estado">
            {status.label}
            {adMeta?.fetchedAt
              ? ` · al ${new Date(adMeta.fetchedAt).toLocaleDateString("es-PE")}`
              : ""}
          </MetaField>
        )}
        {lead.ad_id && (
          <p className="pt-0.5 text-xs break-all text-violet-700/70">
            id {lead.ad_id}
            {lead.ctwa_clid ? ` · clic ${lead.ctwa_clid}` : ""}
          </p>
        )}
        </dl>
      )}
    </div>
  );
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
  distrito: "bg-red-50 text-red-600",
  converso: "bg-blue-50 text-blue-700",
  frio: "bg-slate-100 text-slate-500",
};

// Plain calificación labels (no emoji) for the row/drawer pills, per the redesign.
const SEG_PILL_LABEL: Record<LeadSegment, string> = {
  carrito: "Con carrito",
  distrito: "Dio distrito",
  converso: "Conversó",
  frio: "Frío",
};

// Primary-tab labels for the segment queue (only Carrito carries an emoji).
const SEG_TAB_LABEL: Record<LeadSegment, string> = {
  carrito: "🛒 Carrito",
  distrito: "Dio distrito",
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
  return (
    <span className={cn("whitespace-nowrap rounded px-1.5 py-0.5 text-xs font-medium", SEGMENT_BADGE[seg])}>
      {SEG_PILL_LABEL[seg]}
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
  options: { key: string; label: string; count?: number }[];
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

// Square source chip (📣 Campaña / 🛒 Carrito / 🔎 Búsqueda / "Directo").
const SOURCE_CHIP: Record<
  "meta_ad" | "cod_cart" | "abandoned_browse" | "organic",
  { glyph: string; label: string; cls: string; title: string; isText?: boolean }
> = {
  meta_ad: { glyph: "📣", label: "Campaña", cls: "bg-violet-100 text-violet-700", title: "Campaña Meta (Click-to-WhatsApp)" },
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
function Pill({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium",
        className,
      )}
    >
      {children}
    </span>
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

export function LeadsBoard({
  stores,
  storeId,
  view,
  counts,
  leads,
  adNames,
  waNumbers,
  currency,
  insights,
  initialSeg,
  initialGest,
  initialOpenId,
  currentUserId,
}: {
  stores: StoreSummary[];
  storeId: string;
  view: LeadView;
  counts: Record<LeadView, number>;
  leads: LeadRow[];
  adNames?: Record<string, AdMeta>;
  waNumbers?: Record<string, WaNumber>;
  currency: string;
  insights: LeadsInsights;
  initialSeg?: LeadSegment | null;
  initialGest?: LeadGestion | null;
  initialOpenId?: string | null; // ?open=<id> → auto-abre ese lead (desde el pop-up de Yapes)
  currentUserId: string;
}) {
  const router = useRouter();
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
  // Client-side sub-filters (instant, no navigation): source lens + the queue's
  // intención/gestión axes within "Por llamar".
  // Fuente y Número: multi-select (OR dentro del grupo). Set vacío = sin filtro.
  const [srcFilter, setSrcFilter] = useState<Set<string>>(new Set());
  const [segFilter, setSegFilter] = useState<LeadSegment | null>(initialSeg ?? null);
  // Por defecto la cola arranca en "Sin llamar" (los leads que nadie tomó). Un
  // ?gest= explícito gana; un ?seg= (drill-down) no fuerza el default.
  const [gestFilter, setGestFilter] = useState<LeadGestion | "otros" | null>(
    initialGest ?? (view === "por_llamar" && !initialSeg ? "sin_llamar" : null),
  );
  const [winFilter, setWinFilter] = useState<"all" | "fresca" | "por_vencer" | "cerrada">("all");
  const [numFilter, setNumFilter] = useState<Set<string>>(new Set()); // WhatsApp phone_number_id(s) + "__none__"
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
      const res = await searchLeads(storeId, q);
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

  function changeStore(nextStore: string) {
    router.push(`/dashboard/leads?store=${nextStore}&view=${view}`);
  }

  function openLead(lead: LeadRow) {
    setBanner(null);
    setSelected(lead); // instant — render from the data we already have
    setCalls(null);
    setHistory(null);
    setOpeningId(lead.id); // disable only this row's button while the claim loads
    void (async () => {
      try {
        const res = await claimLead(lead.id);
        if (res.error) {
          setBanner(res.error);
          setSelected(null);
          return;
        }
        const d = await loadLeadDetail(lead.id);
        if ("error" in d) {
          setBanner(d.error);
          setSelected(null);
          return;
        }
        setSelected(d.lead);
        setCalls(d.calls);
        setHistory(d.customerHistory);
      } finally {
        setOpeningId(null);
      }
    })();
  }

  function refreshDetail(leadId: string) {
    // Refresh the drawer + the list/counts in the background. Deliberately NOT a
    // transition tied to the row buttons: a call save shouldn't disable every
    // "Tomar / Ver" while the (heavier) list refetch runs.
    void (async () => {
      const d = await loadLeadDetail(leadId);
      if (!("error" in d)) {
        setSelected(d.lead);
        setCalls(d.calls);
        setHistory(d.customerHistory);
      }
      router.refresh(); // reflect status/queue changes in the list + counts
    })();
  }

  function closeDrawer() {
    const leadId = selected?.id;
    setSelected(null);
    setCalls(null);
    setHistory(null);
    // Release the claim in the background (fire-and-forget). No full-list refresh
    // on close, and no shared transition that would freeze the row buttons.
    if (leadId) void releaseLead(leadId);
  }

  const now = Date.now();
  const q = query.trim().toLowerCase();
  const qDigits = q.replace(/\D/g, "");
  const inQueue = view === "por_llamar";
  const isYape = view === "yape"; // tinta las filas en rojo + 🔥 en la vista Yape/Shalom

  // Jerarquía de filtros (faceted counts): los contadores de cada grupo se
  // calculan sobre los leads que pasan TODOS los demás filtros activos, pero NO
  // el propio. Así, al elegir "Con carrito" (18), Gestión/Ventana/Fuente/Número
  // muestran su "Todos" = 18 y sus sub-botones suman ese subconjunto, mientras
  // que cada grupo conserva sus opciones para poder cambiar dentro de él.
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
  const matchSeg = (l: LeadRow) => !inQueue || !segFilter || leadSegment(l) === segFilter;
  const matchGest = (l: LeadRow) => {
    if (!inQueue || !gestFilter) return true;
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
  const FACETS = { query: matchQuery, src: matchSrc, num: matchNum, seg: matchSeg, gest: matchGest, win: matchWin };
  type Facet = keyof typeof FACETS;
  const facetKeys = Object.keys(FACETS) as Facet[];
  // Leads que pasan todos los filtros activos salvo el indicado: la base sobre
  // la que un grupo cuenta sus badges (un grupo nunca se filtra a sí mismo).
  const leadsExcept = (skip: Facet) => leads.filter((l) => facetKeys.every((k) => k === skip || FACETS[k](l)));

  const srcBase = leadsExcept("src");
  const srcCounts = { meta_ad: 0, cod_cart: 0, abandoned_browse: 0, organic: 0 };
  for (const l of srcBase) srcCounts[leadSourceKey(l.source)] += 1;
  const hasCampaign = leads.some((l) => l.source === "meta_ad");
  const hasCart = leads.some((l) => l.source === "cod_cart");
  const hasBrowse = leads.some((l) => l.source === "abandoned_browse");

  const segBase = leadsExcept("seg");
  const segCounts = countLeadSegments(segBase);
  const segTotal = segBase.length;

  const gestBase = leadsExcept("gest");
  const gestCounts = countGestiones(gestBase);
  const gestTotal = gestBase.length;
  // Leads sin bucket de gestión (casi_cierra/repetido/volver_a_llamar): el resto
  // para que Gestión "Todos" cuadre con la suma de sus chips.
  const gestOtros = gestTotal - Object.values(gestCounts).reduce((a, b) => a + b, 0);

  const winBase = leadsExcept("win");
  const winCounts = countLeadWindows(winBase, now);
  const winTotal = winBase.length;

  // WhatsApp numbers present in this view (to split the queue by number). The
  // chip list comes from the full view so picking a number never hides the
  // others; the counts come from the faceted base.
  const numBase = leadsExcept("num");
  const numTotal = numBase.length;
  const waCounts = new Map<string, number>();
  for (const l of numBase) {
    if (l.wa_phone_number_id) waCounts.set(l.wa_phone_number_id, (waCounts.get(l.wa_phone_number_id) ?? 0) + 1);
  }
  // Leads sin número de WhatsApp asignado (ej. carrito/Shopify): el resto para
  // que Número "Todos" cuadre con la suma de sus chips.
  const numOtros = numTotal - [...waCounts.values()].reduce((a, b) => a + b, 0);
  const waIds = [...new Set(leads.map((l) => l.wa_phone_number_id).filter((id): id is string => !!id))];
  const hasMultiNumbers = waIds.length >= 2;

  // Filtros de refinamiento activos (excluye el buscador, que tiene su propia ✕).
  const hasActiveFilters =
    (inQueue && (!!segFilter || !!gestFilter || winFilter !== "all")) || srcFilter.size > 0 || numFilter.size > 0;
  // Badge on the "Filtros" button: count the active refinement groups (segmento
  // ya es una pestaña principal, así que no cuenta aquí).
  const refinementCount =
    (inQueue && !!gestFilter ? 1 : 0) +
    (inQueue && winFilter !== "all" ? 1 : 0) +
    (srcFilter.size > 0 ? 1 : 0) +
    (numFilter.size > 0 ? 1 : 0) +
    (isReviewView ? 1 : 0);
  function clearFilters() {
    setSegFilter(null);
    setGestFilter(null);
    setWinFilter("all");
    setSrcFilter(new Set());
    setNumFilter(new Set());
  }

  const shownLeads = leads.filter((l) => facetKeys.every((k) => FACETS[k](l)));
  // In search mode show the global results (all stages); otherwise the filtered
  // view (already narrowed client-side by the query for instant feedback).
  const searchMode = results !== null;
  const displayLeads = results ?? shownLeads;

  return (
    <div className="space-y-4">
      {/* Título "Leads" + tablero de hoy (burndown · flujo/saldo · productividad). */}
      <LeadsInsightsPanel
        data={insights}
        titleSlot={
          <div>
            <h1 className="text-xl font-semibold text-slate-900">Leads</h1>
            <p className="mt-0.5 text-sm text-slate-500">
              <span className="font-semibold text-slate-800">{counts.por_llamar} por llamar</span> hoy
              {counts.yape > 0 && (
                <>
                  {" · "}
                  <button
                    type="button"
                    onClick={() => router.push(`/dashboard/leads?store=${storeId}&view=yape`)}
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
              className="rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand-500"
            >
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
        {/* Toolbar: pestañas de la cola por segmento · píldora Yape/Shalom · Filtros. */}
        <div className="flex items-center gap-2">
          {/* Tira de pestañas: en móvil scrollea sola (no empuja el ancho de la página). */}
          <div className="flex min-w-0 flex-1 items-center gap-2 overflow-x-auto">
          <SegControl
            value={view === "por_llamar" ? (segFilter ?? "all") : ""}
            onChange={(key) => {
              if (view === "por_llamar") setSegFilter(key === "all" ? null : (key as LeadSegment));
              else
                router.push(
                  `/dashboard/leads?store=${storeId}&view=por_llamar${key !== "all" ? `&seg=${key}` : ""}`,
                );
            }}
            options={[
              { key: "all", label: "Por llamar", count: counts.por_llamar },
              ...(["frio", "converso", "distrito", "carrito"] as LeadSegment[]).map((s) => ({
                key: s,
                label: SEG_TAB_LABEL[s],
                count: view === "por_llamar" ? segCounts[s] : undefined,
              })),
            ]}
          />
          {counts.yape > 0 && (
            <button
              type="button"
              aria-pressed={view === "yape"}
              onClick={() =>
                router.push(`/dashboard/leads?store=${storeId}&view=${view === "yape" ? "por_llamar" : "yape"}`)
              }
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
        </div>

        {/* Panel "Más filtros" (colapsable): refinos de la cola · Fuente · Número · Vista. */}
        {more && (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-3 rounded-xl border border-slate-200 bg-white px-3.5 py-3 shadow-sm">
            {view === "por_llamar" && (
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
            {(hasCampaign || hasCart || hasBrowse) && (
              <MultiSelect
                label="Fuente"
                summaryAll="Todas"
                selected={srcFilter}
                onToggle={(key) => setSrcFilter((s) => withToggled(s, key))}
                onClear={() => setSrcFilter(new Set())}
                options={[
                  ...(hasCampaign ? [{ key: "meta_ad", label: "📣 Campaña", count: srcCounts.meta_ad }] : []),
                  ...(hasCart ? [{ key: "cod_cart", label: "🛒 Carrito", count: srcCounts.cod_cart }] : []),
                  ...(hasBrowse
                    ? [{ key: "abandoned_browse", label: "🔎 Búsqueda", count: srcCounts.abandoned_browse }]
                    : []),
                  { key: "organic", label: "Orgánico", count: srcCounts.organic },
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
              onChange={(key) => router.push(`/dashboard/leads?store=${storeId}&view=${key}`)}
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
            {displayLeads.map((lead) => {
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
              const initial = (lead.name || lead.phone).trim()[0]?.toUpperCase() || "?";
              return (
                <div
                  key={lead.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => openLead(lead)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      openLead(lead);
                    }
                  }}
                  className={cn(
                    // Móvil: tarjeta apilada (flex-wrap). md+: el grid de columnas.
                    "group flex cursor-pointer flex-wrap items-center gap-x-3 gap-y-2 border-b border-slate-100 px-4 py-3 transition last:border-0 md:grid md:grid-cols-[42px_minmax(0,1fr)_184px_78px_78px] md:gap-x-[14px] md:gap-y-0 md:px-[18px] md:py-2.5",
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
                  <div className="flex min-w-0 flex-1 items-center gap-1.5 md:flex-none">
                    <span className="truncate text-sm font-semibold text-slate-900">{lead.name || lead.phone}</span>
                    {isYape && <span aria-hidden="true">🔥</span>}
                    <SourceChip source={lead.source} />
                    <span className="shrink-0">
                      <SegmentBadge lead={lead} />
                    </span>
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
                      <div className="flex gap-1.5 opacity-0 transition group-hover:opacity-100 focus-within:opacity-100">
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
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
            {!displayLeads.length && (
              <div className="px-[18px] py-6 text-sm text-slate-400">
                {query.trim()
                  ? searching
                    ? "Buscando…"
                    : `Sin resultados para «${query.trim()}».`
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
          currency={currency}
          onClose={closeDrawer}
          onRegistered={() => refreshDetail(selected.id)}
        />
      )}
    </div>
  );
}

function LeadDrawer({
  lead,
  calls,
  history,
  adMeta,
  waNumber,
  currency,
  onClose,
  onRegistered,
}: {
  lead: LeadRow;
  calls: LeadCallRow[] | null; // null = still loading
  history: CustomerHistory | null; // prior purchases (recurrent-customer block)
  adMeta: AdMeta | null; // Meta attribution for lead.ad_id (null until resolved)
  waNumber: WaNumber | null; // resolved label for lead.wa_phone_number_id (null = unresolved)
  currency: string;
  onClose: () => void;
  onRegistered: () => void;
}) {
  const handoffTone = categoryOf(lead.status) === "hot" ? "red" : "amber";
  const [orderOpen, setOrderOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  // cod_cart sin conversación → empty-state; el resto muestra el chat (que se
  // resuelve por teléfono si no hay conversation_id guardado).
  const hasWa = lead.source !== "cod_cart" || !!lead.kapso_conversation_id;
  const hasCart = !!lead.draft_order_gid && lead.draft_order_status !== "completed";
  // Recurrent if there are prior purchases — either the local last-order signal or
  // the (authoritative) Shopify "Pedidos anteriores" list, which catches customers
  // whose past orders were placed outside the bot (not in the kapso-only table).
  const isRecurrent = !!history?.lastOrderAt || (history?.recentOrders?.length ?? 0) > 0;
  const { state: winState, msLeft } = leadWindowInfo(lead.last_inbound_at ?? lead.last_interaction_at, Date.now());
  const wd = WIN_DISPLAY[winKey(winState)];
  const winLabel =
    winState === null
      ? "Sin ventana"
      : winState === "cerrada"
        ? "Ventana vencida"
        : `${Math.max(1, Math.ceil((msLeft ?? 0) / 3_600_000))}h restantes`;
  const src = SOURCE_CHIP[leadSourceKey(lead.source)];
  const initial = (lead.name || lead.phone).trim()[0]?.toUpperCase() || "?";

  async function copyPhone() {
    try {
      await navigator.clipboard.writeText(`+${lead.phone}`);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard no disponible */
    }
  }

  return (
    <>
      <div className="fixed inset-0 z-10 bg-slate-900/30" onClick={onClose} aria-hidden="true" />
      <aside className="@container fixed inset-y-0 right-0 z-20 flex h-full w-[min(880px,96%)] flex-col border-l border-slate-200 bg-slate-50 shadow-xl">
        {/* Header */}
        <div className="border-b border-slate-200 bg-white px-5 py-4">
          <div className="flex items-start gap-3">
            <span
              className={cn(
                "flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-base font-semibold",
                avatarTint(lead.id),
              )}
            >
              {initial}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-lg font-semibold text-slate-900">{lead.name || lead.phone}</h2>
                {isRecurrent && <Pill className="bg-amber-50 text-amber-700">★ Recurrente</Pill>}
              </div>
              <div className="mt-0.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-sm">
                <span className="tabular-nums text-slate-700">+{lead.phone}</span>
                <button
                  type="button"
                  onClick={copyPhone}
                  className="inline-flex items-center gap-1 text-xs font-medium text-brand-700 hover:underline"
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="9" y="9" width="11" height="11" rx="2" />
                    <path d="M5 15V5a2 2 0 0 1 2-2h10" />
                  </svg>
                  {copied ? "copiado" : "copiar"}
                </button>
                <a href={`tel:+${lead.phone}`} className="text-xs text-slate-400 hover:text-slate-600">
                  · llamar
                </a>
              </div>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Cerrar"
              className="shrink-0 rounded-lg p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
            >
              ✕
            </button>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            <Pill className="bg-slate-100">
              <span className={cn("h-1.5 w-1.5 rounded-full", wd.dot)} />
              <span className={wd.fg}>{winLabel}</span>
            </Pill>
            <SegmentBadge lead={lead} />
            <Pill className={src.cls}>{src.isText ? src.label : `${src.glyph} ${src.label}`}</Pill>
          </div>
        </div>

        {/* Body: conversación (izq) · acción (der). Se apila ≤720px de ancho del panel. */}
        <div className="flex min-h-0 flex-1 flex-col @min-[720px]:flex-row">
          {/* Izquierda · conversación de WhatsApp */}
          <div className="flex max-h-[55vh] min-h-0 flex-col border-b border-slate-200 @min-[720px]:max-h-none @min-[720px]:w-1/2 @min-[720px]:border-r @min-[720px]:border-b-0">
            {hasWa ? (
              <WhatsappChat
                leadId={lead.id}
                lastInteractionAt={lead.last_interaction_at}
                hasConversation={!!(lead.kapso_conversation_id || lead.phone)}
                onSent={onRegistered}
              />
            ) : (
              <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
                <span className="flex h-12 w-12 items-center justify-center rounded-full bg-violet-100 text-violet-700">
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M21 15a2 2 0 0 1-2 2H8l-4 4V5a2 2 0 0 1 2-2h13a2 2 0 0 1 2 2z" />
                    <path d="m4 4 16 16" />
                  </svg>
                </span>
                <div>
                  <p className="text-sm font-semibold text-slate-800">Sin conversación de WhatsApp</p>
                  <p className="mt-1 text-sm text-slate-500">
                    El cliente abandonó un carrito web sin escribir. Llámalo para recuperar la venta.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={copyPhone}
                  className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-brand-700 hover:bg-slate-50"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="9" y="9" width="11" height="11" rx="2" />
                    <path d="M5 15V5a2 2 0 0 1 2-2h10" />
                  </svg>
                  {copied ? "Copiado" : `Copiar +${lead.phone}`}
                </button>
              </div>
            )}
          </div>

          {/* Derecha · acción (scroll propio; el formulario de pedido la cubre al abrirse) */}
          <div className="relative min-h-0 flex-1 @min-[720px]:w-1/2">
            <div className="h-full space-y-4 overflow-y-auto p-5">
              {/* Contexto: carrito/producto visto + entrega */}
              {(lead.cart_item_count || lead.district || lead.draft_order_gid || lead.cart_summary) && (
                <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2.5 text-sm text-emerald-900">
                  {lead.draft_order_gid && (
                    <p className="mb-1 text-xs font-semibold tracking-wide text-emerald-700/80 uppercase">
                      {lead.draft_order_status === "completed" ? "✅ Carrito recuperado" : "🛒 Carrito abandonado"}
                      {lead.draft_order_name ? ` · ${lead.draft_order_name}` : ""}
                    </p>
                  )}
                  {lead.cart_item_count ? (
                    <p>
                      🛒 <span className="font-medium">Carrito:</span>{" "}
                      {lead.cart_summary || `${lead.cart_item_count} producto(s)`}
                      {lead.cart_value != null ? ` · ${currency} ${Number(lead.cart_value).toFixed(2)}` : ""}
                    </p>
                  ) : lead.cart_summary ? (
                    <p>
                      🔎 <span className="font-medium">Vio:</span> {lead.cart_summary}
                    </p>
                  ) : null}
                  {(lead.district || lead.referencia) && (
                    <div className={lead.cart_item_count ? "mt-1 space-y-0.5" : "space-y-0.5"}>
                      {lead.district && (
                        <p>
                          📍 <span className="font-medium">Distrito:</span> {lead.district}
                          {lead.province ? <span className="text-emerald-800/70"> · {lead.province}</span> : null}
                        </p>
                      )}
                      {lead.referencia && <p className="text-emerald-800/90">Ref: {lead.referencia}</p>}
                    </div>
                  )}
                  {lead.draft_order_url && (
                    <a
                      href={lead.draft_order_url}
                      target="_blank"
                      rel="noreferrer"
                      className="mt-1.5 inline-block text-xs font-medium text-emerald-700 underline hover:text-emerald-900"
                    >
                      Ver borrador en Shopify ↗
                    </a>
                  )}
                </div>
              )}

              {/* Resumen del bot */}
              {lead.handoff_context && (
                <div
                  className={cn(
                    "rounded-xl border px-3 py-2.5 text-sm",
                    handoffTone === "red"
                      ? "border-red-200 bg-red-50 text-red-800"
                      : "border-amber-200 bg-amber-50 text-amber-800",
                  )}
                >
                  <p className="text-xs font-semibold tracking-wide uppercase opacity-80">Resumen del bot</p>
                  <p className="mt-1 whitespace-pre-wrap">{lead.handoff_context}</p>
                </div>
              )}

              {/* Asignar Yape (solo admins; se auto-oculta para vendedoras) */}
              {lead.status === "yape_por_verificar" && (
                <YapeAssign leadId={lead.id} storeId={lead.store_id} onAssigned={onRegistered} />
              )}

              {/* Pedidos anteriores: últimos 3 pedidos de Shopify de este cliente */}
              {history && history.recentOrders.length > 0 && (
                <div>
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <p className="text-xs font-semibold tracking-wide text-slate-400 uppercase">
                      Pedidos anteriores · {history.recentOrders.length}
                    </p>
                    <span className="shrink-0 text-xs font-semibold text-emerald-700">
                      {currency} {history.recentOrders.reduce((s, o) => s + o.amount, 0).toFixed(2)} en total
                    </span>
                  </div>
                  <div className="space-y-1.5">
                    {history.recentOrders.map((o, i) => (
                      <div
                        key={o.name ?? i}
                        className="flex items-center justify-between gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2"
                      >
                        <span className="truncate text-sm font-medium text-slate-800">Pedido {o.name ?? "—"}</span>
                        <span className="flex shrink-0 items-center gap-2.5">
                          <span className="text-xs text-slate-400">{orderDateShort(o.createdAt)}</span>
                          <span className="text-sm font-semibold text-emerald-700">
                            {currency} {o.amount.toFixed(2)}
                          </span>
                          {o.adminUrl && (
                            <a
                              href={o.adminUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              title="Abrir en Shopify"
                              aria-label={`Abrir ${o.name ?? "pedido"} en Shopify (nueva pestaña)`}
                              className="inline-flex shrink-0 items-center justify-center rounded-md p-1 text-slate-400 transition hover:bg-slate-100 hover:text-brand-600"
                            >
                              <svg
                                width="13"
                                height="13"
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
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Resultado de la llamada */}
              <CallForm leadId={lead.id} onRegistered={onRegistered} />

              {/* Historial (timeline) */}
              <section>
                <p className="mb-2 text-xs font-semibold tracking-wide text-slate-400 uppercase">Historial</p>
                {calls === null ? (
                  <p className="text-sm text-slate-400">Cargando historial…</p>
                ) : calls.length ? (
                  <div>
                    {calls.map((c, i) => {
                      const last = i === calls.length - 1;
                      return (
                        <div key={c.id ?? i} className="flex gap-2.5">
                          <div className="flex flex-col items-center">
                            <span
                              className={cn(
                                "mt-1 h-2.5 w-2.5 shrink-0 rounded-full border-2 bg-white",
                                c.kind === "message"
                                  ? "border-emerald-500"
                                  : c.new_status
                                    ? "border-brand-500"
                                    : "border-slate-300",
                              )}
                            />
                            {!last && <span className="my-0.5 w-0.5 flex-1 bg-slate-200" />}
                          </div>
                          <div className={cn("min-w-0", last ? "pb-0" : "pb-3")}>
                            <p className="text-sm text-slate-800">
                              {c.kind === "message" ? (
                                <span className="font-medium text-brand-700">📤 WhatsApp</span>
                              ) : c.new_status ? (
                                <span className="font-medium">{labelOf(c.new_status)}</span>
                              ) : (
                                <span className="text-slate-500">Nota</span>
                              )}
                            </p>
                            {c.note && <p className="mt-0.5 text-sm text-slate-600">{c.note}</p>}
                            <p className="mt-0.5 text-[11px] text-slate-400">
                              {fmtDate(c.occurred_at)}
                              {c.vendedora_name ? ` · ${c.vendedora_name}` : ""}
                            </p>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <p className="text-sm text-slate-400">Sin actividad todavía.</p>
                )}
              </section>

              {/* Número de WhatsApp */}
              {lead.wa_phone_number_id && (
                <p className="text-xs text-slate-500">
                  📱 WhatsApp:{" "}
                  <span className="font-medium text-slate-700">
                    {waNumber?.name ?? waNumber?.displayPhone ?? "número sin nombre"}
                  </span>
                  {waKindLabel(waNumber?.kind ?? null) ? ` · ${waKindLabel(waNumber?.kind ?? null)}` : ""}
                </p>
              )}

              {/* Campaña Meta */}
              {lead.source === "meta_ad" && <MetaAttribution lead={lead} adMeta={adMeta} />}
            </div>

            {/* Formulario de pedido: lo abre el CTA del footer; cubre la columna de acción.
                allowExisting permite generar OTRO pedido aunque el lead ya tenga uno. */}
            {orderOpen && (
              <div className="absolute inset-0 overflow-y-auto bg-slate-50 p-4">
                <OrderFormPanel
                  leadId={lead.id}
                  currency={currency}
                  hasCart={hasCart}
                  allowExisting={lead.has_order}
                  onRegistered={onRegistered}
                  onClose={() => setOrderOpen(false)}
                />
              </div>
            )}
          </div>
        </div>

        {/* Footer CTA: cierre de venta (oculto mientras el formulario está abierto) */}
        {!orderOpen && (
          <div className="border-t border-slate-200 bg-white p-3.5">
            {lead.has_order ? (
              <div className="flex items-center justify-between gap-3">
                <p className="min-w-0 truncate text-sm font-medium text-emerald-700">
                  ✅ Pedido generado{history?.currentOrderName ? ` · ${history.currentOrderName}` : ""}
                </p>
                <button
                  type="button"
                  onClick={() => setOrderOpen(true)}
                  className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-2 text-sm font-semibold text-white shadow-sm hover:bg-emerald-700"
                >
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 5v14M5 12h14" />
                  </svg>
                  Generar nuevo pedido
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setOrderOpen(true)}
                className="flex w-full items-center justify-center gap-2 rounded-lg bg-emerald-600 px-4 py-3 text-sm font-semibold text-white shadow-sm hover:bg-emerald-700"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M9 11l3 3 8-8" />
                  <path d="M20 12v6a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h9" />
                </svg>
                {hasCart ? "Generar pedido (contraentrega)" : "Registrar pedido (contraentrega)"}
              </button>
            )}
          </div>
        )}
      </aside>
    </>
  );
}

const MEDIA_KIND_META: Record<NonNullable<LeadConversationMessage["mediaKind"]>, { icon: string; label: string }> = {
  image: { icon: "🖼️", label: "Imagen" },
  audio: { icon: "🎧", label: "Audio" },
  video: { icon: "🎬", label: "Video" },
  document: { icon: "📄", label: "Documento" },
  sticker: { icon: "🩷", label: "Sticker" },
};

/** yyyy-mm-dd key (local) for grouping chat messages by day. */
function dayKeyOf(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

/** WhatsApp-style day separator label: Hoy / Ayer / "26 jun". */
function chatDayLabel(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  if (sameDay(d, now)) return "Hoy";
  const yest = new Date(now);
  yest.setDate(now.getDate() - 1);
  if (sameDay(d, yest)) return "Ayer";
  return d.toLocaleDateString("es-PE", { day: "2-digit", month: "short" });
}

/** Time-only (HH:mm) shown inside a chat bubble. */
function chatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("es-PE", { hour: "2-digit", minute: "2-digit", hour12: false });
}

/**
 * The lead's WhatsApp chat as a self-contained widget — the full conversation
 * (text + inline images like Yape vouchers) with the composer attached at the
 * bottom, styled like WhatsApp. Loads when the drawer opens (resolving the
 * conversation by phone if no id was stored) and refreshes after each send.
 */
function WhatsappChat({
  leadId,
  lastInteractionAt,
  hasConversation,
  onSent,
}: {
  leadId: string;
  lastInteractionAt?: string | null;
  hasConversation: boolean;
  onSent: () => void;
}) {
  const [state, setState] = useState<
    | { status: "loading" }
    | {
        status: "ready";
        messages: LeadConversationMessage[];
        reason?: string;
        threads: LeadThread[];
        activeId: string | null;
        activePhoneNumberId: string | null;
      }
  >({ status: "loading" });
  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true); // is the user near the bottom of the thread?
  const countRef = useRef(0); // previous message count, to detect new arrivals
  const activeIdRef = useRef<string | null>(null); // active thread (for silent polls)
  const [showJump, setShowJump] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [search, setSearch] = useState("");

  const load = useCallback(
    (opts?: { silent?: boolean; conversationId?: string }) => {
      if (!opts?.silent) setState({ status: "loading" });
      loadLeadConversation(leadId, opts?.conversationId).then((res) => {
        activeIdRef.current = res.activeConversationId;
        setState({
          status: "ready",
          messages: res.messages,
          reason: res.reason,
          threads: res.threads,
          activeId: res.activeConversationId,
          activePhoneNumberId: res.activePhoneNumberId,
        });
      });
    },
    [leadId],
  );

  // Load on open; reset scroll/thread tracking when switching leads.
  useEffect(() => {
    atBottomRef.current = true;
    countRef.current = 0;
    activeIdRef.current = null;
    setShowJump(false);
    setSearch("");
    if (hasConversation) load();
  }, [hasConversation, load]);

  // Live updates: refresh the ACTIVE thread quietly every 20s while open + visible.
  useEffect(() => {
    if (!hasConversation) return;
    const id = setInterval(() => {
      if (typeof document === "undefined" || document.visibilityState === "visible") {
        load({ silent: true, conversationId: activeIdRef.current ?? undefined });
      }
    }, 20000);
    return () => clearInterval(id);
  }, [hasConversation, load]);

  // Smart scroll: stick to the bottom only if the user is already there; otherwise
  // surface a "nuevos mensajes" button when new messages arrive while scrolled up.
  useEffect(() => {
    if (state.status !== "ready") return;
    const el = scrollRef.current;
    const grew = state.messages.length > countRef.current;
    countRef.current = state.messages.length;
    if (!el) return;
    if (atBottomRef.current) {
      el.scrollTop = el.scrollHeight;
      // Re-anchor after layout settles (bubbles/players expanding).
      requestAnimationFrame(() => {
        const e = scrollRef.current;
        if (e && atBottomRef.current) e.scrollTop = e.scrollHeight;
      });
      setShowJump(false);
    } else if (grew) {
      setShowJump(true);
    }
  }, [state]);

  // Imágenes/audio/video cargan async y crecen el hilo, empujando el contenido;
  // re-anclamos al fondo cuando cada uno carga (solo si ya estabas abajo). El
  // evento `load` no burbujea → se escucha en fase de captura.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onMediaLoad = () => {
      if (atBottomRef.current) el.scrollTop = el.scrollHeight;
    };
    el.addEventListener("load", onMediaLoad, true);
    return () => el.removeEventListener("load", onMediaLoad, true);
  }, [hasConversation]);

  function onThreadScroll() {
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    atBottomRef.current = nearBottom;
    if (nearBottom) setShowJump(false);
  }

  function jumpToBottom() {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    atBottomRef.current = true;
    setShowJump(false);
  }

  // Switch to another number's thread (multi-number lead).
  function switchThread(convId: string) {
    if (convId === activeIdRef.current) return;
    atBottomRef.current = true;
    setShowJump(false);
    setSearch("");
    load({ conversationId: convId });
  }

  if (!hasConversation) return null;

  const threads = state.status === "ready" ? state.threads : [];
  const activeId = state.status === "ready" ? state.activeId : null;
  const activePhoneNumberId = state.status === "ready" ? state.activePhoneNumberId : null;
  const allMessages = state.status === "ready" ? state.messages : [];
  const activeThread = threads.find((t) => t.conversationId === activeId) ?? null;
  // Clarify which number you reply FROM — only when the lead has more than one.
  const numberHint =
    threads.length > 1 && activeThread
      ? activeThread.displayPhone
        ? `${activeThread.label} · ${activeThread.displayPhone}`
        : activeThread.label
      : null;
  const q = search.trim().toLowerCase();
  const messages = q ? allMessages.filter((m) => m.text.toLowerCase().includes(q)) : allMessages;
  // Interleave day separators ("Hoy", "Ayer", "26 jun") into the (filtered) thread.
  const rows: ReactNode[] = [];
  let lastDay = "";
  messages.forEach((m, i) => {
    const day = dayKeyOf(m.at);
    if (day !== lastDay) {
      rows.push(
        <div key={`day-${i}`} className="flex justify-center py-1.5">
          <span className="rounded-full bg-white/80 px-2.5 py-0.5 text-[11px] font-medium text-slate-500 shadow-sm">
            {chatDayLabel(m.at)}
          </span>
        </div>,
      );
      lastDay = day;
    }
    rows.push(<ChatBubble key={m.id ?? `m-${i}`} leadId={leadId} msg={m} highlight={q} />);
  });

  return (
    <section className="flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-white">
      {/* Cabecera estilo WhatsApp */}
      <div className="flex items-center justify-between gap-2 bg-emerald-600 px-3 py-2 text-white">
        <div className="flex min-w-0 items-center gap-2">
          <span aria-hidden>💬</span>
          <span className="truncate text-sm font-semibold">Conversación de WhatsApp</span>
          {state.status === "ready" && state.messages.length > 0 && (
            <span className="shrink-0 text-xs text-emerald-100">· {state.messages.length}</span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={() => setSearchOpen((s) => !s)}
            title="Buscar en la conversación"
            aria-label="Buscar"
            className={cn(
              "rounded-full px-1.5 text-base leading-none hover:bg-white/15 hover:text-white",
              searchOpen ? "text-white" : "text-emerald-100",
            )}
          >
            🔍
          </button>
          <button
            type="button"
            onClick={() => load()}
            title="Actualizar"
            aria-label="Actualizar conversación"
            className="rounded-full px-1.5 text-lg leading-none text-emerald-100 hover:bg-white/15 hover:text-white"
          >
            ↻
          </button>
        </div>
      </div>

      {/* Selector de número: solo si el cliente escribió a más de un número */}
      {threads.length > 1 && (
        <div className="flex gap-1 overflow-x-auto border-b border-slate-200 bg-slate-50 px-2 py-1.5">
          {threads.map((t) => (
            <button
              key={t.conversationId}
              type="button"
              onClick={() => switchThread(t.conversationId)}
              title={t.displayPhone ?? undefined}
              className={cn(
                "shrink-0 rounded-full px-2.5 py-1 text-xs font-medium",
                t.conversationId === activeId
                  ? "bg-emerald-600 text-white"
                  : "border border-slate-300 bg-white text-slate-600 hover:bg-slate-100",
              )}
            >
              {t.label}
            </button>
          ))}
        </div>
      )}

      {/* Buscar dentro de la conversación */}
      {searchOpen && (
        <div className="flex items-center gap-2 border-b border-slate-200 bg-white px-3 py-2">
          <input
            autoFocus
            value={search}
            onChange={(e) => setSearch(e.currentTarget.value)}
            placeholder="Buscar en la conversación…"
            className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100"
          />
          {q && (
            <span className="shrink-0 text-xs text-slate-500">
              {messages.length} {messages.length === 1 ? "coincidencia" : "coincidencias"}
            </span>
          )}
          <button
            type="button"
            onClick={() => {
              setSearch("");
              setSearchOpen(false);
            }}
            className="shrink-0 text-sm text-slate-400 hover:text-slate-700"
            aria-label="Cerrar búsqueda"
          >
            ✕
          </button>
        </div>
      )}

      {/* Hilo de mensajes */}
      <div className="relative min-h-0 flex-1">
        <div
          ref={scrollRef}
          onScroll={onThreadScroll}
          className="absolute inset-0 space-y-1 overflow-y-auto bg-[#efeae2] px-3 py-3"
        >
          {state.status === "loading" ? (
            <p className="py-10 text-center text-sm text-slate-500">Cargando conversación…</p>
          ) : messages.length ? (
            rows
          ) : (
            <p className="py-10 text-center text-sm text-slate-500">
              {state.status !== "ready"
                ? ""
                : q
                  ? `Sin coincidencias para «${search.trim()}»`
                  : (state.reason ?? "Sin mensajes todavía.")}
            </p>
          )}
        </div>
        {showJump && (
          <button
            type="button"
            onClick={jumpToBottom}
            className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full bg-emerald-600 px-3 py-1 text-xs font-medium text-white shadow-md hover:bg-emerald-700"
          >
            ↓ Nuevos mensajes
          </button>
        )}
      </div>

      {/* Composer pegado abajo */}
      <WhatsappComposer
        leadId={leadId}
        lastInteractionAt={lastInteractionAt}
        conversationId={activeId}
        phoneNumberId={activePhoneNumberId}
        numberHint={numberHint}
        onSent={() => {
          onSent();
          load({ silent: true, conversationId: activeIdRef.current ?? undefined });
        }}
      />
    </section>
  );
}

/** Render message text with clickable http(s) links. */
function linkify(text: string): ReactNode[] {
  return text.split(/(https?:\/\/[^\s]+)/g).map((part, i) =>
    /^https?:\/\//.test(part) ? (
      <a key={i} href={part} target="_blank" rel="noreferrer" className="underline">
        {part}
      </a>
    ) : (
      <span key={i}>{part}</span>
    ),
  );
}

/** Render text with case-insensitive <mark> highlights of `term` (already lowercased). */
function highlightText(text: string, term: string): ReactNode[] {
  const out: ReactNode[] = [];
  let rest = text;
  let k = 0;
  let pos = rest.toLowerCase().indexOf(term);
  while (pos >= 0 && term) {
    if (pos > 0) out.push(<span key={`t${k}`}>{rest.slice(0, pos)}</span>);
    out.push(
      <mark key={`h${k}`} className="rounded bg-yellow-200 px-0.5">
        {rest.slice(pos, pos + term.length)}
      </mark>,
    );
    rest = rest.slice(pos + term.length);
    k++;
    pos = rest.toLowerCase().indexOf(term);
  }
  if (rest) out.push(<span key={`t${k}`}>{rest}</span>);
  return out;
}

/** WhatsApp delivery ticks for an outbound message (null = no indicator). */
function statusTicks(status: string | null): { marks: string; cls: string; label: string } | null {
  switch (status) {
    case "read":
      return { marks: "✓✓", cls: "text-sky-500", label: "Leído" };
    case "delivered":
      return { marks: "✓✓", cls: "text-emerald-800/50", label: "Entregado" };
    case "sent":
      return { marks: "✓", cls: "text-emerald-800/50", label: "Enviado" };
    case "failed":
    case "error":
      return { marks: "⚠", cls: "text-red-500", label: "No se envió" };
    default:
      return null;
  }
}

/** One WhatsApp bubble: customer (left/white) vs. business (right/WA green), with
 *  inline image/audio/video players, delivery ticks (outbound) and clickable links. */
function ChatBubble({
  leadId,
  msg,
  highlight,
}: {
  leadId: string;
  msg: LeadConversationMessage;
  highlight?: string;
}) {
  const outbound = msg.direction === "outbound";
  const mediaSrc = msg.mediaUrl ? `/api/leads/${leadId}/media?u=${encodeURIComponent(msg.mediaUrl)}` : null;
  const meta = msg.mediaKind ? MEDIA_KIND_META[msg.mediaKind] : null;
  const ticks = outbound ? statusTicks(msg.status) : null;
  return (
    <div className={cn("flex", outbound ? "justify-end" : "justify-start")}>
      <div
        className={cn(
          "max-w-[85%] rounded-2xl px-2.5 py-1.5 text-sm shadow-sm",
          outbound ? "rounded-tr-sm bg-[#d9fdd3] text-slate-900" : "rounded-tl-sm bg-white text-slate-800",
        )}
      >
        {mediaSrc && (msg.mediaKind === "image" || msg.mediaKind === "sticker") ? (
          <a href={mediaSrc} target="_blank" rel="noreferrer" className="block">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={mediaSrc}
              alt={msg.text || "Imagen"}
              loading="lazy"
              className={cn(
                "rounded-lg object-cover",
                msg.mediaKind === "sticker" ? "max-h-28" : "mb-1 max-h-64 w-full",
              )}
            />
          </a>
        ) : mediaSrc && msg.mediaKind === "audio" ? (
          <audio controls preload="none" src={mediaSrc} className="mb-1 h-9 w-56 max-w-full" />
        ) : mediaSrc && msg.mediaKind === "video" ? (
          // eslint-disable-next-line jsx-a11y/media-has-caption
          <video controls preload="none" src={mediaSrc} className="mb-1 max-h-64 w-full rounded-lg" />
        ) : mediaSrc && meta ? (
          <a
            href={mediaSrc}
            target="_blank"
            rel="noreferrer"
            className="mb-0.5 flex items-center gap-1.5 font-medium text-emerald-700 hover:underline"
          >
            <span>{meta.icon}</span> {meta.label}
          </a>
        ) : null}
        {msg.text && (
          <p className="break-words whitespace-pre-wrap">
            {highlight ? highlightText(msg.text, highlight) : linkify(msg.text)}
          </p>
        )}
        <p
          className={cn(
            "mt-0.5 flex items-center justify-end gap-1 text-[10px]",
            outbound ? "text-emerald-800/60" : "text-slate-400",
          )}
        >
          <span>{chatTime(msg.at)}</span>
          {ticks && (
            <span className={ticks.cls} title={ticks.label} aria-label={ticks.label}>
              {ticks.marks}
            </span>
          )}
        </p>
      </div>
    </div>
  );
}

/** WhatsApp-style composer bar, attached under the conversation: quick replies,
 *  inline attach (📎), Ctrl+V-to-attach, Enter-to-send. Enabled only inside the
 *  24h session window; otherwise shows why the customer must write first. */
function WhatsappComposer({
  leadId,
  lastInteractionAt,
  conversationId,
  phoneNumberId,
  numberHint,
  onSent,
}: {
  leadId: string;
  lastInteractionAt?: string | null;
  conversationId?: string | null;
  phoneNumberId?: string | null;
  numberHint?: string | null;
  onSent: () => void;
}) {
  const [win, setWin] = useState<{ loading: boolean; open: boolean; reason?: string }>({
    loading: true,
    open: false,
  });
  const [text, setText] = useState("");
  const [attachFile, setAttachFile] = useState<File | null>(null);
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  // Auto-grow the input as the advisor types (capped), like a real chat box.
  useEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
  }, [text]);

  useEffect(() => {
    let alive = true;
    setText("");
    setAttachFile(null);
    setMsg(null);
    // Fast path: the customer hasn't interacted in >24h → the session window is
    // definitely closed (last inbound ≤ last_interaction_at). Skip the live Kapso
    // check so the drawer doesn't wait on a network round-trip.
    const last = lastInteractionAt ? new Date(lastInteractionAt).getTime() : 0;
    if (!last || Date.now() - last > 24 * 60 * 60 * 1000) {
      setWin({ loading: false, open: false, reason: "El cliente debe escribirte primero." });
      return;
    }
    setWin({ loading: true, open: false });
    getLeadWindow(leadId, conversationId ?? undefined).then((w) => {
      if (alive) setWin({ loading: false, open: w.open, reason: w.reason });
    });
    return () => {
      alive = false;
    };
  }, [leadId, lastInteractionAt, conversationId]);

  function send() {
    const body = text.trim();
    if (!body) return;
    setMsg(null);
    startTransition(async () => {
      const res = await sendLeadMessage(leadId, body, phoneNumberId ?? undefined);
      if (res.error) {
        // Window closed mid-send → flip to the closed state with a clear reason
        // (retry is futile). Other errors keep the text so "Reintentar" can resend.
        if (res.windowClosed) {
          setWin({ loading: false, open: false, reason: "Se cerró la ventana de 24h." });
          return;
        }
        setMsg(res.error);
        return;
      }
      setText("");
      setMsg(null);
      onSent(); // refresh the thread so the sent message appears
    });
  }

  if (win.loading) {
    return (
      <div className="border-t border-slate-200 bg-white px-3 py-2.5 text-xs text-slate-400">
        Verificando ventana de 24h…
      </div>
    );
  }
  if (!win.open) {
    return (
      <div className="border-t border-slate-200 bg-white px-3 py-2.5 text-xs text-slate-500">
        ⏳ {win.reason ?? "El cliente debe escribirte primero."} Solo puedes escribir dentro de las 24h
        desde su último mensaje.
      </div>
    );
  }

  return (
    <div className="border-t border-slate-200 bg-white">
      <div className="px-2 pt-2">
        <QuickReplyBar leadId={leadId} onInsert={(b) => setText(b)} />
      </div>
      {numberHint && (
        <p className="px-3 pt-1 text-[11px] text-slate-500">
          Respondes desde <span className="font-medium text-slate-700">{numberHint}</span>
        </p>
      )}
      {attachFile && (
        <div className="px-2 pt-2">
          <MediaAttach
            leadId={leadId}
            file={attachFile}
            setFile={setAttachFile}
            disabled={pending}
            phoneNumberId={phoneNumberId}
            onSent={onSent}
            onWindowClosed={() => setWin({ loading: false, open: false, reason: "Se cerró la ventana de 24h." })}
          />
        </div>
      )}
      <div className="flex items-end gap-1.5 px-2 py-2">
        <input
          ref={fileRef}
          type="file"
          accept="image/*,application/pdf,video/mp4,video/3gpp"
          className="hidden"
          onChange={(e) => {
            setAttachFile(e.currentTarget.files?.[0] ?? null);
            setMsg(null);
          }}
        />
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          disabled={pending}
          title="Adjuntar imagen, PDF o video"
          aria-label="Adjuntar"
          className="shrink-0 rounded-full p-2 text-lg leading-none text-slate-500 hover:bg-slate-100 disabled:opacity-60"
        >
          📎
        </button>
        <textarea
          ref={taRef}
          value={text}
          onChange={(e) => setText(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          onPaste={(e) => {
            // Ctrl+V de una imagen → la adjunta (reusa MediaAttach).
            const img = Array.from(e.clipboardData?.files ?? []).find((f) => f.type.startsWith("image/"));
            if (img) {
              e.preventDefault();
              setAttachFile(img);
            }
          }}
          rows={1}
          placeholder="Escribe un mensaje…"
          disabled={pending}
          className="grow resize-none overflow-y-auto rounded-2xl border border-slate-300 px-3 py-2 text-sm outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100"
        />
        <button
          type="button"
          onClick={send}
          disabled={pending || !text.trim()}
          title="Enviar"
          aria-label="Enviar"
          className="shrink-0 rounded-full bg-emerald-600 p-2.5 text-sm leading-none text-white hover:bg-emerald-700 disabled:opacity-50"
        >
          {pending ? "…" : "➤"}
        </button>
      </div>
      {msg && (
        <div className="flex items-center gap-2 px-3 pb-2 text-xs">
          <span className="text-red-600">{msg}</span>
          <button
            type="button"
            onClick={send}
            disabled={pending}
            className="shrink-0 font-medium text-emerald-700 hover:underline disabled:opacity-60"
          >
            ↻ Reintentar
          </button>
        </div>
      )}
    </div>
  );
}

/** Downscale + re-encode an image so WhatsApp sends stay fast and under the
 *  server-action body limit. Falls back to the original file on any failure. */
async function resizeImageToBlob(file: File, maxDim = 1600, quality = 0.8): Promise<Blob> {
  try {
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result as string);
      r.onerror = () => reject(new Error("read"));
      r.readAsDataURL(file);
    });
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error("decode"));
      i.src = dataUrl;
    });
    const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
    const w = Math.max(1, Math.round(img.width * scale));
    const h = Math.max(1, Math.round(img.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const cx = canvas.getContext("2d");
    if (!cx) return file;
    cx.drawImage(img, 0, 0, w, h);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
    return blob ?? file;
  } catch {
    return file;
  }
}

/** Per-store canned messages: chips that fill the composer + an inline manager. */
function QuickReplyBar({ leadId, onInsert }: { leadId: string; onInsert: (body: string) => void }) {
  const [replies, setReplies] = useState<QuickReply[]>([]);
  const [manage, setManage] = useState(false);
  const [label, setLabel] = useState("");
  const [body, setBody] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    let alive = true;
    listQuickReplies(leadId).then((r) => {
      if (alive) setReplies(r);
    });
    return () => {
      alive = false;
    };
  }, [leadId]);

  function add() {
    if (!label.trim() || !body.trim()) return;
    startTransition(async () => {
      const res = await createQuickReply(leadId, label, body);
      if ("error" in res) {
        setMsg(res.error);
        return;
      }
      setReplies(res.replies);
      setLabel("");
      setBody("");
      setMsg(null);
    });
  }
  function remove(id: string) {
    startTransition(async () => {
      const res = await deleteQuickReply(leadId, id);
      if (!("error" in res)) setReplies(res.replies);
    });
  }

  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-1.5">
        {replies.map((r) => (
          <button
            key={r.id}
            type="button"
            onClick={() => onInsert(r.body)}
            title={r.body}
            className="rounded-full border border-brand-200 bg-brand-50 px-2.5 py-0.5 text-xs text-brand-700 hover:bg-brand-100"
          >
            {r.label}
          </button>
        ))}
        <button
          type="button"
          onClick={() => setManage((m) => !m)}
          className="rounded-full border border-slate-200 px-2 py-0.5 text-xs text-slate-500 hover:bg-slate-100"
        >
          {manage ? "✕ cerrar" : "✎ respuestas"}
        </button>
      </div>
      {manage && (
        <div className="space-y-2 rounded-lg border border-slate-200 bg-slate-50 p-2">
          {replies.length === 0 && <p className="text-xs text-slate-400">Aún no hay respuestas rápidas.</p>}
          {replies.map((r) => (
            <div key={r.id} className="flex items-center gap-2 text-xs">
              <span className="min-w-[90px] font-medium text-slate-700">{r.label}</span>
              <span className="flex-1 truncate text-slate-500">{r.body}</span>
              <button
                type="button"
                onClick={() => remove(r.id)}
                disabled={pending}
                className="text-slate-400 hover:text-red-600"
                aria-label="Eliminar"
              >
                ✕
              </button>
            </div>
          ))}
          <div className="grid gap-1.5 border-t border-slate-200 pt-2">
            <input
              value={label}
              onChange={(e) => setLabel(e.currentTarget.value)}
              placeholder="Título (ej. Datos de pago)"
              className="rounded border border-slate-200 px-2 py-1 text-xs"
              disabled={pending}
            />
            <textarea
              value={body}
              onChange={(e) => setBody(e.currentTarget.value)}
              rows={2}
              placeholder="Mensaje…"
              className="rounded border border-slate-200 px-2 py-1 text-xs"
              disabled={pending}
            />
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={add}
                disabled={pending || !label.trim() || !body.trim()}
                className="rounded border border-brand-300 px-2 py-1 text-xs font-medium text-brand-700 hover:bg-brand-50 disabled:opacity-60"
              >
                + Agregar
              </button>
              {msg && <span className="text-xs text-red-600">{msg}</span>}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** Staged-attachment preview + send (image, PDF/boleta or video). The file is
 *  chosen/pasted by the composer; here we preview it, take an optional caption,
 *  upload it DIRECTLY to Storage via a signed URL (bypassing the Server-Action
 *  body limit) and send it to Meta by public link. Images are downscaled first. */
function MediaAttach({
  leadId,
  file,
  setFile,
  disabled,
  phoneNumberId,
  onSent,
  onWindowClosed,
}: {
  leadId: string;
  file: File | null;
  setFile: (f: File | null) => void;
  disabled: boolean;
  phoneNumberId?: string | null;
  onSent: () => void;
  onWindowClosed?: () => void;
}) {
  const [caption, setCaption] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  // Object-URL preview for image/video (revoked on change/unmount).
  useEffect(() => {
    if (file && (file.type.startsWith("image/") || file.type.startsWith("video/"))) {
      const url = URL.createObjectURL(file);
      setPreview(url);
      return () => URL.revokeObjectURL(url);
    }
    setPreview(null);
  }, [file]);

  function clear() {
    setFile(null);
    setCaption("");
    setMsg(null);
  }

  function send() {
    if (!file) return;
    setMsg(null);
    startTransition(async () => {
      try {
        const isImage = file.type.startsWith("image/");
        const blob: Blob = isImage ? await resizeImageToBlob(file) : file;
        const contentType = isImage ? "image/jpeg" : file.type;
        const filename = file.name || (isImage ? "imagen.jpg" : "archivo");
        const prep = await createWaMediaUpload(leadId, contentType, filename);
        if ("error" in prep) {
          setMsg(prep.error);
          return;
        }
        const sb = createBrowserSupabase();
        const up = await sb.storage
          .from("whatsapp-media")
          .uploadToSignedUrl(prep.path, prep.token, blob, { contentType });
        if (up.error) {
          setMsg(`No se pudo subir: ${up.error.message}`);
          return;
        }
        const res = await sendLeadMedia(
          leadId,
          { path: prep.path, kind: prep.kind, filename, caption: caption.trim() },
          phoneNumberId ?? undefined,
        );
        if (res.error) {
          if (res.windowClosed) {
            clear();
            onWindowClosed?.(); // flip the composer to the closed state with a clear reason
            return;
          }
          setMsg(res.error);
          return;
        }
        clear();
        onSent(); // refresh the thread so the sent media appears
      } catch (e) {
        setMsg(`Error: ${(e as Error)?.message ?? "no se pudo enviar"}`);
      }
    });
  }

  if (!file) return null;
  const kindLabel = file.type.startsWith("image/")
    ? "imagen"
    : file.type.startsWith("video/")
      ? "video"
      : "documento";

  return (
    <div className="space-y-2 rounded-lg border border-slate-200 bg-slate-50 p-2">
      {file.type.startsWith("image/") ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={preview ?? ""} alt="Vista previa" className="max-h-40 rounded" />
      ) : file.type.startsWith("video/") ? (
        // eslint-disable-next-line jsx-a11y/media-has-caption
        <video src={preview ?? ""} controls className="max-h-40 rounded" />
      ) : (
        <div className="flex items-center gap-2 text-sm text-slate-600">
          📄 <span className="truncate">{file.name || "Documento"}</span>
        </div>
      )}
      <input
        value={caption}
        onChange={(e) => setCaption(e.currentTarget.value)}
        placeholder="Texto (opcional)"
        disabled={pending}
        className="w-full rounded border border-slate-200 px-2 py-1 text-sm"
      />
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={send}
          disabled={disabled || pending}
          className="rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-60"
        >
          {pending ? "Enviando…" : `Enviar ${kindLabel}`}
        </button>
        <button type="button" onClick={clear} disabled={pending} className="text-xs text-slate-500 hover:underline">
          Quitar
        </button>
        {msg && <span className="text-xs text-red-600">{msg}</span>}
      </div>
    </div>
  );
}

/** Close a sale by phone (contraentrega / COD). Records a lightweight manual
 *  order, marks the lead Ganado and credits the advisor. Collapsed by default to
 *  keep the drawer tidy; expands into the amount / products / district form. */
// ---------------------------------------------------------------------------
// Unified order form (supersedes Cerrar venta + Generar pedido). Pre-fills from
// the cart's draft (or blank for a new sale), products from the real catalog
// (or a custom item), required address, then generates a REAL Shopify order.
// ---------------------------------------------------------------------------

type OrderItem = {
  key: string;
  variantId: string | null;
  title: string;
  quantity: number;
  unitPrice: number | null;
};
type ProductResult = Awaited<ReturnType<typeof searchStoreProducts>>[number];

const rid = () => Math.random().toString(36).slice(2);

const PERU_REGIONS = [
  "Amazonas", "Áncash", "Apurímac", "Arequipa", "Ayacucho", "Cajamarca", "Callao", "Cusco",
  "Huancavelica", "Huánuco", "Ica", "Junín", "La Libertad", "Lambayeque", "Lima", "Loreto",
  "Madre de Dios", "Moquegua", "Pasco", "Piura", "Puno", "San Martín", "Tacna", "Tumbes", "Ucayali",
];
/** Map a free-text province (e.g. "Lima (provincia)") to a canonical Peru region. */
function matchPeruRegion(v: string | null | undefined): string {
  if (!v) return "";
  const norm = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  const nv = norm(v);
  return PERU_REGIONS.find((r) => nv.includes(norm(r))) ?? v;
}

function OrderFormPanel({
  leadId,
  currency,
  hasCart,
  allowExisting,
  onRegistered,
  onClose,
}: {
  leadId: string;
  currency: string;
  hasCart: boolean;
  allowExisting?: boolean; // permitir generar OTRO pedido aunque el lead ya tenga uno
  onRegistered: () => void;
  onClose: () => void;
}) {
  const [loading, setLoading] = useState(true);
  const [items, setItems] = useState<OrderItem[]>([]);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [address1, setAddress1] = useState("");
  const [district, setDistrict] = useState("");
  const [province, setProvince] = useState("");
  const [referencia, setReferencia] = useState("");
  const [orderNote, setOrderNote] = useState(""); // → Notas del pedido en Shopify
  const [windowOpen, setWindowOpen] = useState(false);
  const [sendConfirm, setSendConfirm] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [showPicker, setShowPicker] = useState(false);
  const [discountKind, setDiscountKind] = useState<"none" | "fixed" | "percent">("none");
  const [discountValue, setDiscountValue] = useState<number | null>(null);
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    loadOrderDraft(leadId).then((res) => {
      if (!alive) return;
      if ("error" in res) {
        setMsg(res.error);
      } else {
        setItems(res.lineItems.map((li) => ({ ...li, key: rid() })));
        setName(res.customerName ?? "");
        setPhone(res.phone ?? "");
        setAddress1(res.address1 ?? "");
        setDistrict(res.district ?? "");
        setProvince(matchPeruRegion(res.province));
        setReferencia(res.referencia ?? "");
        setWindowOpen(res.windowOpen);
        setSendConfirm(res.windowOpen);
      }
      setLoading(false);
    });
    return () => {
      alive = false;
    };
  }, [leadId]);

  const subtotal = items.reduce((s, it) => s + (it.unitPrice ?? 0) * (Number(it.quantity) || 0), 0);
  const discountAmount =
    discountKind !== "none" && discountValue != null && discountValue > 0
      ? discountKind === "percent"
        ? (subtotal * Math.min(100, discountValue)) / 100
        : Math.min(subtotal, discountValue)
      : 0;
  const total = Math.max(0, subtotal - discountAmount);
  const valid = items.length > 0 && address1.trim().length > 0 && district.trim().length > 0 && subtotal > 0;

  function patchItem(key: string, patch: Partial<OrderItem>) {
    setItems((x) => x.map((it) => (it.key === key ? { ...it, ...patch } : it)));
  }
  function removeItem(key: string) {
    setItems((x) => x.filter((it) => it.key !== key));
  }

  function submit() {
    if (!valid) {
      setMsg("Completa productos, dirección y distrito antes de generar.");
      return;
    }
    setMsg(null);
    startTransition(async () => {
      const res = await generateOrder(leadId, {
        lineItems: items.map((it) => ({
          variantId: it.variantId,
          title: it.title,
          quantity: it.quantity,
          unitPrice: it.unitPrice,
        })),
        customerName: name.trim(),
        phone: phone.trim(),
        address1: address1.trim(),
        district: district.trim(),
        province: province.trim(),
        referencia: referencia.trim(),
        note: orderNote.trim() || undefined,
        sendConfirmation: sendConfirm,
        confirmationText: confirmText.trim() || undefined,
        discount:
          discountKind === "none" || discountValue == null || discountValue <= 0
            ? null
            : { kind: discountKind, value: discountValue },
        allowExisting,
      });
      if (res.error) {
        setMsg(res.error);
        return;
      }
      setMsg(res.notice ?? "Pedido generado.");
      onRegistered();
    });
  }

  return (
    <section className="space-y-3 rounded-xl border border-emerald-300 bg-emerald-50/50 p-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold tracking-wide text-emerald-800 uppercase">
          {hasCart ? "Generar pedido · contraentrega" : "Registrar pedido · contraentrega"}
        </h3>
        <button type="button" onClick={onClose} disabled={pending} className="text-xs text-slate-500 hover:underline">
          Cerrar
        </button>
      </div>

      {loading ? (
        <p className="text-sm text-slate-400">Cargando datos del pedido…</p>
      ) : (
        <>
          <div className="space-y-1.5">
            <p className={labelCls}>Productos</p>
            {items.length === 0 && (
              <p className="text-xs text-slate-400">Sin productos. Agrega del catálogo o un ítem manual.</p>
            )}
            {items.map((it) => (
              <div key={it.key} className="rounded-lg border border-slate-200 bg-white px-2 py-1.5">
                <div className="flex items-start gap-2">
                  {it.variantId ? (
                    <span className="flex-1 text-sm text-slate-800">{it.title}</span>
                  ) : (
                    <input
                      value={it.title}
                      onChange={(e) => patchItem(it.key, { title: e.currentTarget.value })}
                      placeholder="Producto (ítem manual)"
                      className="flex-1 rounded border border-slate-200 px-2 py-1 text-sm"
                      disabled={pending}
                    />
                  )}
                  <button
                    type="button"
                    onClick={() => removeItem(it.key)}
                    disabled={pending}
                    className="text-slate-400 hover:text-red-600"
                    aria-label="Quitar"
                  >
                    ✕
                  </button>
                </div>
                <div className="mt-1 flex items-center gap-2 text-xs text-slate-500">
                  <label className="flex items-center gap-1">
                    Cant.
                    <input
                      type="number"
                      min={1}
                      value={it.quantity}
                      onChange={(e) => patchItem(it.key, { quantity: Math.max(1, Number(e.currentTarget.value) || 1) })}
                      className="w-14 rounded border border-slate-200 px-1.5 py-0.5 text-sm"
                      disabled={pending}
                    />
                  </label>
                  {it.variantId ? (
                    // Catalog product: unit price is fixed to the catalog (read-only).
                    // Any reduction is handled via the order-level "Descuento" field.
                    <span className="flex items-center gap-1 text-slate-500">
                      {currency} {(it.unitPrice ?? 0).toFixed(2)}
                      <span className="text-[10px] text-slate-400">c/u</span>
                    </span>
                  ) : (
                    // Manual item: no catalog price to pull from, so it stays editable.
                    <label className="flex items-center gap-1">
                      {currency}
                      <input
                        type="number"
                        min={0}
                        step="0.01"
                        value={it.unitPrice ?? ""}
                        onChange={(e) =>
                          patchItem(it.key, {
                            unitPrice: e.currentTarget.value === "" ? null : Number(e.currentTarget.value),
                          })
                        }
                        className="w-20 rounded border border-slate-200 px-1.5 py-0.5 text-sm"
                        disabled={pending}
                      />
                    </label>
                  )}
                  <span className="ml-auto font-medium text-slate-700">
                    {currency} {((it.unitPrice ?? 0) * (Number(it.quantity) || 0)).toFixed(2)}
                  </span>
                </div>
              </div>
            ))}
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setShowPicker(true)}
                disabled={pending}
                className="rounded-lg border border-emerald-300 px-2.5 py-1 text-xs font-medium text-emerald-700 hover:bg-emerald-100"
              >
                + Producto del catálogo
              </button>
              <button
                type="button"
                onClick={() => setItems((x) => [...x, { key: rid(), variantId: null, title: "", quantity: 1, unitPrice: null }])}
                disabled={pending}
                className="rounded-lg border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-600 hover:bg-slate-100"
              >
                + Ítem manual
              </button>
            </div>

            <div className="rounded-lg border border-slate-200 bg-white px-2 py-2">
              <div className="flex items-center gap-2">
                <span className="text-xs font-medium text-slate-600">Descuento</span>
                <select
                  value={discountKind}
                  onChange={(e) => {
                    const k = e.currentTarget.value as "none" | "fixed" | "percent";
                    setDiscountKind(k);
                    if (k === "none") setDiscountValue(null);
                  }}
                  disabled={pending}
                  className="rounded border border-slate-200 px-1.5 py-0.5 text-xs"
                >
                  <option value="none">Sin descuento</option>
                  <option value="fixed">Monto ({currency})</option>
                  <option value="percent">Porcentaje (%)</option>
                </select>
                {discountKind !== "none" && (
                  <input
                    type="number"
                    min={0}
                    step={discountKind === "percent" ? "1" : "0.01"}
                    max={discountKind === "percent" ? 100 : undefined}
                    value={discountValue ?? ""}
                    onChange={(e) =>
                      setDiscountValue(e.currentTarget.value === "" ? null : Math.max(0, Number(e.currentTarget.value)))
                    }
                    placeholder={discountKind === "percent" ? "%" : currency}
                    disabled={pending}
                    className="w-24 rounded border border-slate-200 px-1.5 py-0.5 text-sm"
                  />
                )}
              </div>
              {discountAmount > 0 && (
                <div className="mt-2 space-y-0.5">
                  <div className="flex justify-between text-xs text-slate-500">
                    <span>Subtotal</span>
                    <span>
                      {currency} {subtotal.toFixed(2)}
                    </span>
                  </div>
                  <div className="flex justify-between text-xs text-rose-600">
                    <span>
                      Descuento
                      {discountKind === "percent" && discountValue ? ` (${Math.min(100, discountValue)}%)` : ""}
                    </span>
                    <span>
                      −{currency} {discountAmount.toFixed(2)}
                    </span>
                  </div>
                </div>
              )}
              <div className="mt-1 flex justify-between text-sm font-semibold text-emerald-800">
                <span>Total</span>
                <span>
                  {currency} {total.toFixed(2)}
                </span>
              </div>
            </div>
            {showPicker && (
              <ProductPicker
                leadId={leadId}
                currency={currency}
                onPick={(p) => {
                  setItems((x) => [
                    ...x,
                    { key: rid(), variantId: p.variantId, title: p.title, quantity: 1, unitPrice: p.price },
                  ]);
                  setShowPicker(false);
                }}
                onClose={() => setShowPicker(false)}
              />
            )}
          </div>

          <div className="grid grid-cols-2 gap-2">
            <Field label="Cliente" value={name} onChange={setName} disabled={pending} placeholder="Nombre" />
            <Field label="Teléfono" value={phone} onChange={setPhone} disabled={pending} placeholder="519…" />
          </div>
          <Field label="Dirección *" value={address1} onChange={setAddress1} disabled={pending} placeholder="Av. / Calle y número" />
          <div className="grid grid-cols-2 gap-2">
            <Field label="Distrito *" value={district} onChange={setDistrict} disabled={pending} placeholder="Distrito de entrega" />
            <div>
              <label className={labelCls}>Provincia / Región</label>
              <select
                value={province}
                onChange={(e) => setProvince(e.currentTarget.value)}
                className={inputCls}
                disabled={pending}
              >
                <option value="">—</option>
                {province && !PERU_REGIONS.includes(province) && <option value={province}>{province}</option>}
                {PERU_REGIONS.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <Field label="Referencia" value={referencia} onChange={setReferencia} disabled={pending} placeholder="Frente a…, color de puerta…" />

          <div>
            <label className={labelCls}>Notas del pedido</label>
            <textarea
              value={orderNote}
              onChange={(e) => setOrderNote(e.currentTarget.value)}
              rows={2}
              placeholder="Ej: enviar con Alexis (opcional)"
              className={inputCls}
              disabled={pending}
            />
            <p className="mt-1 text-xs text-slate-400">
              Se guarda en las Notas del pedido en Shopify (no se envía al cliente).
            </p>
          </div>

          <div className="rounded-lg border border-slate-200 bg-white p-2">
            <label className="flex items-center gap-2 text-sm text-slate-700">
              <input
                type="checkbox"
                checked={sendConfirm}
                onChange={(e) => setSendConfirm(e.currentTarget.checked)}
                disabled={pending || !windowOpen}
              />
              Enviar confirmación por WhatsApp al cliente
            </label>
            {windowOpen ? (
              sendConfirm && (
                <textarea
                  value={confirmText}
                  onChange={(e) => setConfirmText(e.currentTarget.value)}
                  rows={3}
                  placeholder="(Se usa un mensaje de confirmación por defecto si lo dejas vacío)"
                  className="mt-1.5 w-full rounded border border-slate-200 px-2 py-1 text-sm"
                  disabled={pending}
                />
              )
            ) : (
              <p className="mt-1 text-xs text-slate-400">
                Ventana de 24h cerrada — no se puede enviar texto libre (se necesitaría una plantilla).
              </p>
            )}
          </div>

          <p className="text-xs text-emerald-700/80">
            Pago contraentrega → queda como <span className="font-medium">pago pendiente</span> y sube como pedido
            real a Shopify. Marca el lead <span className="font-medium">Ganado</span> y suma a tu productividad.
          </p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={submit}
              disabled={pending || !valid}
              className="rounded-lg bg-emerald-600 px-3 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
            >
              {pending ? "Generando…" : "Generar pedido"}
            </button>
            <button
              type="button"
              onClick={onClose}
              disabled={pending}
              className="text-sm text-slate-500 hover:underline disabled:opacity-60"
            >
              Cancelar
            </button>
            {msg && <span className="text-xs text-slate-600">{msg}</span>}
          </div>
        </>
      )}
    </section>
  );
}

function Field({
  label,
  value,
  onChange,
  disabled,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
  placeholder?: string;
}) {
  return (
    <div>
      <label className={labelCls}>{label}</label>
      <input
        value={value}
        onChange={(e) => onChange(e.currentTarget.value)}
        placeholder={placeholder}
        className={inputCls}
        disabled={disabled}
      />
    </div>
  );
}

function ProductPicker({
  leadId,
  currency,
  onPick,
  onClose,
}: {
  leadId: string;
  currency: string;
  onPick: (p: ProductResult) => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<ProductResult[] | null>(null);
  const [searching, setSearching] = useState(false);
  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) {
      setResults(null);
      setSearching(false);
      return;
    }
    setSearching(true);
    let alive = true;
    const t = setTimeout(async () => {
      const r = await searchStoreProducts(leadId, term);
      if (alive) {
        setResults(r);
        setSearching(false);
      }
    }, 280);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [q, leadId]);
  return (
    <div className="rounded-lg border border-emerald-200 bg-white p-2">
      <div className="flex items-center gap-2">
        <input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.currentTarget.value)}
          placeholder="Buscar producto…"
          className="flex-1 rounded border border-slate-200 px-2 py-1 text-sm"
        />
        <button type="button" onClick={onClose} className="text-xs text-slate-500 hover:underline">
          Cerrar
        </button>
      </div>
      {searching && <p className="mt-1 text-xs text-slate-400">Buscando…</p>}
      {results && results.length === 0 && !searching && (
        <p className="mt-1 text-xs text-slate-400">Sin resultados (o falta el permiso read_products).</p>
      )}
      {results && results.length > 0 && (
        <ul className="mt-1 max-h-56 overflow-y-auto">
          {results.map((p) => (
            <li key={p.variantId}>
              <button
                type="button"
                onClick={() => onPick(p)}
                className="flex w-full items-center gap-2 rounded px-1.5 py-1 text-left hover:bg-emerald-50"
              >
                <span className="flex-1 text-sm text-slate-800">{p.title}</span>
                <span className={cn("text-xs", (p.inventory ?? 0) > 0 ? "text-slate-500" : "text-amber-600")}>
                  {p.inventory != null ? `stock ${p.inventory}` : ""}
                </span>
                <span className="text-sm font-medium text-slate-700">
                  {currency} {(p.price ?? 0).toFixed(2)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function CallForm({ leadId, onRegistered }: { leadId: string; onRegistered: () => void }) {
  const [state, action, pending] = useActionState<LeadActionState, FormData>(registerCall, {});
  const [status, setStatus] = useState("");
  useEffect(() => {
    if (state.notice) {
      onRegistered();
      setStatus("");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.notice]);
  // Disposiciones más usadas como chips; el resto en el <select> "Otros estados"
  // (registerCall acepta cualquier estado válido, así que no se pierde ninguno).
  const CHIPS: [string, string][] = [
    ["casi_cierra", "🔥 Casi cierra"],
    ["no_responde", "🚫 No contestó"],
    ["volver_a_llamar", "📞 Volver a llamar"],
    ["contactado_dejo_wsp", "💬 Contactado"],
    ["buzon", "📭 Buzón"],
    ["sin_stock", "📦 Sin stock"],
  ];
  const chipKeys = new Set(CHIPS.map(([k]) => k));
  // El desplegable lista TODOS los estados (los de los chips primero, con su
  // etiqueta canónica) y muestra siempre el seleccionado, así chips y desplegable
  // quedan sincronizados en ambos sentidos.
  const STATUS_OPTIONS = [
    ...CHIPS.map(([code]) => ({ code, label: labelOf(code) })),
    ...MANUAL_STATUSES.filter((s) => !chipKeys.has(s.code)).map((s) => ({ code: s.code, label: s.label })),
  ];
  return (
    <section>
      <p className="mb-2 text-xs font-semibold tracking-wide text-slate-400 uppercase">Resultado de la llamada</p>
      <form action={action} className="space-y-2.5">
        <input type="hidden" name="lead_id" value={leadId} />
        <input type="hidden" name="status" value={status} />
        <div className="flex flex-wrap gap-1.5">
          {CHIPS.map(([k, label]) => {
            const on = status === k;
            return (
              <button
                key={k}
                type="button"
                onClick={() => setStatus(on ? "" : k)}
                className={cn(
                  "rounded-full border px-3 py-1.5 text-xs font-semibold transition",
                  on
                    ? "border-brand-600 bg-brand-600 text-white"
                    : "border-slate-300 bg-white text-slate-600 hover:bg-slate-50",
                )}
              >
                {label}
              </button>
            );
          })}
        </div>
        <select
          value={status}
          onChange={(e) => setStatus(e.currentTarget.value)}
          className={inputCls}
          aria-label="Estado de la llamada"
        >
          <option value="">(mantener estado)</option>
          {STATUS_OPTIONS.map((s) => (
            <option key={s.code} value={s.code}>
              {s.label}
            </option>
          ))}
        </select>
        <textarea name="note" rows={2} placeholder="Nota rápida…" className={inputCls} />
        <div className="flex gap-2">
          <input
            name="next_followup_at"
            type="datetime-local"
            aria-label="Reprogramar seguimiento"
            className={cn(inputCls, "flex-1")}
          />
          <button
            type="submit"
            disabled={pending}
            className="shrink-0 rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-60"
          >
            {pending ? "Guardando…" : "Guardar"}
          </button>
        </div>
        {state.error && <p className="text-sm text-red-600">{state.error}</p>}
        {state.notice && <p className="text-sm text-emerald-600">{state.notice}</p>}
      </form>
    </section>
  );
}
