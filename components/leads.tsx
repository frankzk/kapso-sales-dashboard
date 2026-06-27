"use client";

import { useRouter } from "next/navigation";
import { type ReactNode, useActionState, useEffect, useRef, useState, useTransition } from "react";
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
import {
  LEAD_GESTIONES,
  LEAD_SEGMENTS,
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
  type LeadCategory,
  type LeadGestion,
  type LeadSegment,
} from "@/lib/leads";
import {
  claimLead,
  createQuickReply,
  deleteQuickReply,
  generateOrder,
  getLeadWindow,
  listQuickReplies,
  loadLeadDetail,
  loadOrderDraft,
  registerCall,
  releaseLead,
  searchLeads,
  searchStoreProducts,
  sendLeadImage,
  sendLeadMessage,
  type LeadActionState,
  type QuickReply,
} from "@/app/dashboard/leads/actions";
import { Card, cn } from "@/components/ui";

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

const CATEGORY_BADGE: Record<LeadCategory, string> = {
  won: "border-emerald-200 bg-emerald-50 text-emerald-700",
  hot: "border-red-200 bg-red-50 text-red-700",
  open: "border-amber-200 bg-amber-50 text-amber-700",
  lost: "border-slate-200 bg-slate-50 text-slate-600",
};

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

/** Whole days since a timestamp (null if absent). */
function daysSince(value: string | null | undefined): number | null {
  if (!value) return null;
  return Math.floor((Date.now() - new Date(value).getTime()) / 86_400_000);
}

/** 24h-window chip for active leads — time left (🟢/🟡/🔴) or ⚫ cerrada, so the
 *  team attends the chat before the WhatsApp session window closes. */
function WindowBadge({ lead }: { lead: LeadRow }) {
  const at = lead.last_inbound_at ?? lead.last_interaction_at;
  const { state, msLeft } = leadWindowInfo(at, Date.now());
  if (!state) return null;
  if (state === "cerrada") {
    const d = daysSince(at);
    return (
      <span className="ml-2 whitespace-nowrap rounded bg-slate-100 px-1.5 py-0.5 text-xs font-medium text-slate-500">
        ⚫ vencido{d != null && d >= 1 ? ` · hace ${d}d` : ""}
      </span>
    );
  }
  const hours = Math.max(1, Math.ceil((msLeft ?? 0) / 3_600_000));
  const cls =
    state === "critica"
      ? "bg-red-100 text-red-700"
      : state === "por_vencer"
        ? "bg-amber-100 text-amber-700"
        : "bg-emerald-100 text-emerald-700";
  const dot = state === "critica" ? "🔴" : state === "por_vencer" ? "🟡" : "🟢";
  return (
    <span
      className={cn("ml-2 whitespace-nowrap rounded px-1.5 py-0.5 text-xs font-medium", cls)}
      title="Tiempo restante de la ventana de 24h (desde el último mensaje del cliente)"
    >
      {dot} {hours}h
    </span>
  );
}

function StatusBadge({ status, needsAttention }: { status: string; needsAttention?: boolean }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium",
        CATEGORY_BADGE[categoryOf(status)],
      )}
    >
      {needsAttention ? "🔥 " : ""}
      {labelOf(status)}
    </span>
  );
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

const SEG_LABEL = Object.fromEntries(
  LEAD_SEGMENTS.map((s) => [s.key, s.label] as [LeadSegment, string]),
) as Record<LeadSegment, string>;

const SEGMENT_BADGE: Record<LeadSegment, string> = {
  carrito: "bg-emerald-100 text-emerald-700",
  distrito: "bg-blue-100 text-blue-700",
  converso: "bg-violet-100 text-violet-700",
  frio: "bg-slate-100 text-slate-500",
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
      {SEG_LABEL[seg]}
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

export function LeadsBoard({
  stores,
  storeId,
  view,
  counts,
  leads,
  adNames,
  waNumbers,
  currency,
  initialSeg,
  initialGest,
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
  initialSeg?: LeadSegment | null;
  initialGest?: LeadGestion | null;
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
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold text-slate-900">Leads</h1>
        {stores.length > 1 && (
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
        )}
      </div>

      <div className="sticky top-0 z-10 bg-slate-50 pt-1 pb-2">
        {/* Fila 1: etapa/segmento (filtra dentro de la cola; navega fuera de ella) ·
            vistas finales · buscador. Cada grupo es un segmented control. */}
        <nav className="flex flex-wrap items-center gap-2">
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
              { key: "all", label: "Todos", count: view === "por_llamar" ? segTotal : undefined },
              ...(["frio", "converso", "distrito", "carrito"] as LeadSegment[]).map((s) => ({
                key: s,
                label: SEG_LABEL[s],
                count: view === "por_llamar" ? segCounts[s] : undefined,
              })),
            ]}
          />
          <SegControl
            value={OUTCOME_VIEWS.some((v) => v.key === view) ? view : ""}
            onChange={(key) => router.push(`/dashboard/leads?store=${storeId}&view=${key}`)}
            options={OUTCOME_VIEWS.map((v) => ({ key: v.key, label: v.label, count: counts[v.key] }))}
          />
          {hasActiveFilters && (
            <button
              type="button"
              onClick={clearFilters}
              className="inline-flex items-center gap-1 rounded-lg border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-600 hover:bg-slate-100 hover:text-slate-900"
            >
              ✕ Limpiar filtros
            </button>
          )}

          <div className="relative ml-auto w-full sm:w-64">
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
              placeholder="Buscar por nombre o celular…"
              aria-label="Buscar lead por nombre o celular"
              className="w-full rounded-lg border border-slate-300 py-1.5 pr-9 pl-9 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
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
        </nav>

        {/* Fila 2: refinos de la cola (Gestión/Ventana) + Fuente + Número, cada uno
            como segmented control. Solo aparece lo que aplica a la vista. */}
        {(view === "por_llamar" || hasCampaign || hasMultiNumbers) && (
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-slate-100 pt-2">
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

      <Card>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-xs text-slate-500">
                <th className="py-2 text-left font-medium">Nombre</th>
                <th className="py-2 text-left font-medium">Teléfono</th>
                <th className="py-2 text-left font-medium">Última interacción</th>
                <th className="hidden py-2 text-left font-medium md:table-cell">Calificación</th>
                <th className="py-2 text-left font-medium">Estado</th>
                <th className="py-2 text-right font-medium">Acción</th>
              </tr>
            </thead>
            <tbody>
              {displayLeads.map((lead) => {
                const locked =
                  !!lead.claimed_by &&
                  isClaimActive(lead.claimed_at) &&
                  lead.claimed_by !== currentUserId;
                const active = categoryOf(lead.status) === "open" || categoryOf(lead.status) === "hot";
                const overdue =
                  active &&
                  !!lead.next_followup_at &&
                  new Date(lead.next_followup_at).getTime() <= Date.now();
                return (
                  <tr key={lead.id} className="border-b border-slate-100 last:border-0">
                    <td className="py-2.5 text-slate-800">
                      <div className="flex flex-col gap-1">
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                          <span>{lead.name || lead.phone}</span>
                          {lead.source === "meta_ad" && (
                            <span
                              className="whitespace-nowrap rounded bg-violet-100 px-1.5 py-0.5 text-xs font-medium text-violet-700"
                              title={lead.ad_headline ? `Campaña Meta: ${lead.ad_headline}` : "Llegó por campaña de Meta (Click-to-WhatsApp)"}
                            >
                              📣 Campaña
                            </span>
                          )}
                          {lead.source === "cod_cart" && (
                            <span
                              className="whitespace-nowrap rounded bg-emerald-100 px-1.5 py-0.5 text-xs font-medium text-emerald-700"
                              title="Carrito abandonado del formulario COD (sin WhatsApp)"
                            >
                              🛒 Carrito
                            </span>
                          )}
                          {lead.source === "abandoned_browse" && (
                            <span
                              className="whitespace-nowrap rounded bg-orange-100 px-1.5 py-0.5 text-xs font-medium text-orange-700"
                              title="Búsqueda abandonada: vio un producto en la tienda y se fue (sin WhatsApp)"
                            >
                              🔎 Búsqueda
                            </span>
                          )}
                          {hasMultiNumbers && lead.wa_phone_number_id && (
                            <span
                              className="whitespace-nowrap rounded bg-sky-100 px-1.5 py-0.5 text-xs font-medium text-sky-700"
                              title={`WhatsApp: ${waLabel(waNumbers?.[lead.wa_phone_number_id], lead.wa_phone_number_id)}${waNumbers?.[lead.wa_phone_number_id]?.displayPhone ? ` · ${waNumbers[lead.wa_phone_number_id]!.displayPhone}` : ""}`}
                            >
                              📱{" "}
                              {waKindLabel(waNumbers?.[lead.wa_phone_number_id]?.kind ?? null) ??
                                waLabel(waNumbers?.[lead.wa_phone_number_id], lead.wa_phone_number_id)}
                            </span>
                          )}
                        </div>
                        {/* Calificación column is hidden on narrow screens — surface it here. */}
                        <span className="md:hidden">
                          <SegmentBadge lead={lead} />
                        </span>
                      </div>
                    </td>
                    <td className="py-2.5">
                      <a
                        href={`https://wa.me/${lead.phone}`}
                        target="_blank"
                        rel="noreferrer"
                        className="whitespace-nowrap text-brand-700 hover:underline"
                      >
                        {lead.phone}
                      </a>
                    </td>
                    <td className="py-2.5 text-slate-600">
                      <span className="whitespace-nowrap">{fmtDateShort(lead.last_interaction_at)}</span>
                      {active && <WindowBadge lead={lead} />}
                    </td>
                    <td className="hidden py-2.5 md:table-cell">
                      <SegmentBadge lead={lead} />
                    </td>
                    <td className="py-2.5">
                      <StatusBadge status={lead.status} needsAttention={lead.needs_attention} />
                      {overdue && (
                        <span
                          className="ml-1 whitespace-nowrap rounded bg-red-100 px-1.5 py-0.5 text-xs font-medium text-red-700"
                          title="Seguimiento vencido"
                        >
                          ⏰ vencido
                        </span>
                      )}
                    </td>
                    <td className="py-2.5 text-right">
                      <button
                        type="button"
                        onClick={() => openLead(lead)}
                        disabled={openingId === lead.id}
                        className="inline-flex items-center gap-1 rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-60"
                      >
                        {locked && <span title="Tomado por otro vendedor">🔒 tomado</span>}
                        {openingId === lead.id ? "Abriendo…" : "Tomar / Ver"}
                      </button>
                    </td>
                  </tr>
                );
              })}
              {!displayLeads.length && (
                <tr>
                  <td colSpan={6} className="py-4 text-sm text-slate-400">
                    {query.trim()
                      ? searching
                        ? "Buscando…"
                        : `Sin resultados para «${query.trim()}».`
                      : leads.length
                        ? "No hay leads de esta fuente en la vista."
                        : "No hay leads en esta vista."}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>

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
  return (
    <>
      <div
        className="fixed inset-0 z-10 bg-slate-900/30"
        onClick={onClose}
        aria-hidden="true"
      />
      <aside className="fixed inset-y-0 right-0 z-20 w-full max-w-md overflow-y-auto border-l bg-white shadow-xl">
        <div className="flex items-start justify-between gap-3 border-b border-slate-200 px-5 py-3">
          <div className="min-w-0 space-y-1">
            <div className="flex items-center gap-2">
              <p className="truncate text-base font-semibold text-slate-900">{lead.name || lead.phone}</p>
              {lead.source === "cod_cart" && (
                <span className="shrink-0 rounded bg-emerald-100 px-1.5 py-0.5 text-xs font-medium text-emerald-700">🛒</span>
              )}
              {lead.source === "abandoned_browse" && (
                <span className="shrink-0 rounded bg-orange-100 px-1.5 py-0.5 text-xs font-medium text-orange-700">🔎</span>
              )}
              {lead.source === "meta_ad" && (
                <span className="shrink-0 rounded bg-violet-100 px-1.5 py-0.5 text-xs font-medium text-violet-700">📣</span>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <a
                href={`https://wa.me/${lead.phone}`}
                target="_blank"
                rel="noreferrer"
                className="text-sm text-brand-700 hover:underline"
              >
                {lead.phone}
              </a>
              <a href={`tel:${lead.phone}`} className="text-xs text-slate-400 hover:text-slate-600">
                · llamar
              </a>
              <StatusBadge status={lead.status} needsAttention={lead.needs_attention} />
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

        <div className="space-y-4 px-5 py-4">
          {/* Contexto: carrito/producto visto + entrega (lo que miras antes de llamar/cerrar) */}
          {(lead.cart_item_count || lead.district || lead.draft_order_gid || lead.cart_summary) && (
            <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2.5 text-sm text-emerald-900">
              {lead.draft_order_gid && (
                <p className="mb-1 text-xs font-semibold tracking-wide uppercase text-emerald-700/80">
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

          {/* Acción principal: generar / registrar el pedido */}
          {lead.has_order ? (
            <p className="text-sm font-medium text-emerald-700">
              ✅ Pedido generado{lead.order_id ? ` · ${lead.order_id}` : ""}
            </p>
          ) : (
            <OrderForm
              leadId={lead.id}
              currency={currency}
              hasCart={!!lead.draft_order_gid && lead.draft_order_status !== "completed"}
              onRegistered={onRegistered}
            />
          )}

          {/* Registrar llamada (lo más usado al trabajar) */}
          <CallForm leadId={lead.id} onRegistered={onRegistered} />

          {/* Historial */}
          <section className="space-y-2">
            <h3 className="text-sm font-semibold tracking-wide text-slate-700 uppercase">Historial</h3>
            {calls === null ? (
              <p className="text-sm text-slate-400">Cargando historial…</p>
            ) : calls.length ? (
              <ul className="space-y-2">
                {calls.map((c, i) => (
                  <li key={c.id ?? i} className="rounded-lg border border-slate-200 px-3 py-2 text-sm">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs text-slate-400">
                        {fmtDate(c.occurred_at)}
                        {c.vendedora_name ? ` · ${c.vendedora_name}` : ""}
                      </span>
                      {c.kind === "message" ? (
                        <span className="text-xs font-medium text-brand-700">📤 WhatsApp</span>
                      ) : c.new_status ? (
                        <span className="text-xs font-medium text-slate-600">{labelOf(c.new_status)}</span>
                      ) : null}
                    </div>
                    {c.note && <p className="mt-1 text-slate-700">{c.note}</p>}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-slate-400">Sin actividad todavía.</p>
            )}
          </section>

          {/* Enviar WhatsApp / llamar */}
          {!lead.kapso_conversation_id && lead.draft_order_gid && <CallAffordance phone={lead.phone} />}
          <WhatsappComposer
            leadId={lead.id}
            lastInteractionAt={lead.last_interaction_at}
            onSent={onRegistered}
          />

          {/* Contexto secundario (abajo: se consulta menos) */}
          <RecurrentCustomer history={history} />

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

          {lead.wa_phone_number_id && (
            <p className="text-xs text-slate-500">
              📱 WhatsApp:{" "}
              <span className="font-medium text-slate-700">
                {waNumber?.name ?? waNumber?.displayPhone ?? "número sin nombre"}
              </span>
              {waKindLabel(waNumber?.kind ?? null) ? ` · ${waKindLabel(waNumber?.kind ?? null)}` : ""}
            </p>
          )}

          {lead.source === "meta_ad" && <MetaAttribution lead={lead} adMeta={adMeta} />}
        </div>
      </aside>
    </>
  );
}

/** Free-text WhatsApp composer — enabled only inside the 24h session window. */
function WhatsappComposer({
  leadId,
  lastInteractionAt,
  onSent,
}: {
  leadId: string;
  lastInteractionAt?: string | null;
  onSent: () => void;
}) {
  const [win, setWin] = useState<{ loading: boolean; open: boolean; reason?: string }>({
    loading: true,
    open: false,
  });
  const [text, setText] = useState("");
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setText("");
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
    getLeadWindow(leadId).then((w) => {
      if (alive) setWin({ loading: false, open: w.open, reason: w.reason });
    });
    return () => {
      alive = false;
    };
  }, [leadId, lastInteractionAt]);

  function send() {
    const body = text.trim();
    if (!body) return;
    setMsg(null);
    startTransition(async () => {
      const res = await sendLeadMessage(leadId, body);
      if (res.error) {
        setMsg(res.error);
        return;
      }
      setText("");
      setMsg(res.notice ?? "Enviado.");
      onSent();
    });
  }

  return (
    <section className="space-y-2 rounded-xl border border-slate-200 p-3">
      <h3 className="text-sm font-semibold tracking-wide text-slate-700 uppercase">Enviar WhatsApp</h3>
      {win.loading ? (
        <p className="text-sm text-slate-400">Verificando ventana de 24h…</p>
      ) : win.open ? (
        <>
          <QuickReplyBar leadId={leadId} onInsert={(b) => setText(b)} />
          <textarea
            value={text}
            onChange={(e) => setText(e.currentTarget.value)}
            rows={2}
            placeholder="Escribe un mensaje…"
            className={inputCls}
            disabled={pending}
          />
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={send}
              disabled={pending || !text.trim()}
              className="rounded-lg bg-brand-600 px-3 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-60"
            >
              {pending ? "Enviando…" : "Enviar"}
            </button>
            {msg && <span className="text-xs text-slate-500">{msg}</span>}
          </div>
          <ImageAttach leadId={leadId} disabled={pending} onSent={onSent} />
        </>
      ) : (
        <p className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-500">
          ⏳ {win.reason ?? "El cliente debe escribirte primero."} Solo puedes enviar texto libre dentro
          de las 24h desde su último mensaje.
        </p>
      )}
    </section>
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

/** Pick an image, resize it client-side, and send it over WhatsApp as an image. */
function ImageAttach({ leadId, disabled, onSent }: { leadId: string; disabled: boolean; onSent: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [caption, setCaption] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const inputRef = useRef<HTMLInputElement>(null);

  function pick(f: File | null) {
    setPreview((p) => {
      if (p) URL.revokeObjectURL(p);
      return f ? URL.createObjectURL(f) : null;
    });
    setFile(f);
    setMsg(null);
  }

  function send() {
    if (!file) return;
    setMsg(null);
    startTransition(async () => {
      const blob = await resizeImageToBlob(file);
      const fd = new FormData();
      fd.append("image", blob, "image.jpg");
      fd.append("caption", caption.trim());
      const res = await sendLeadImage(leadId, fd);
      if (res.error) {
        setMsg(res.error);
        return;
      }
      pick(null);
      setCaption("");
      setMsg(res.notice ?? "Imagen enviada.");
      onSent();
    });
  }

  return (
    <div>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => pick(e.currentTarget.files?.[0] ?? null)}
      />
      {!file ? (
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={disabled || pending}
          className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100 disabled:opacity-60"
        >
          📷 Enviar imagen
        </button>
      ) : (
        <div className="space-y-2 rounded-lg border border-slate-200 bg-white p-2">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={preview ?? ""} alt="Vista previa" className="max-h-40 rounded" />
          <input
            value={caption}
            onChange={(e) => setCaption(e.currentTarget.value)}
            placeholder="Texto de la imagen (opcional)"
            disabled={pending}
            className="w-full rounded border border-slate-200 px-2 py-1 text-sm"
          />
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={send}
              disabled={pending}
              className="rounded-lg bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-60"
            >
              {pending ? "Enviando…" : "Enviar imagen"}
            </button>
            <button type="button" onClick={() => pick(null)} disabled={pending} className="text-xs text-slate-500 hover:underline">
              Quitar
            </button>
            {msg && <span className="text-xs text-slate-500">{msg}</span>}
          </div>
        </div>
      )}
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

function OrderForm({
  leadId,
  currency,
  hasCart,
  onRegistered,
}: {
  leadId: string;
  currency: string;
  hasCart: boolean;
  onRegistered: () => void;
}) {
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="w-full rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700"
      >
        {hasCart ? "✅ Generar pedido (contraentrega)" : "🧾 Registrar pedido (contraentrega)"}
      </button>
    );
  }
  return (
    <OrderFormPanel
      leadId={leadId}
      currency={currency}
      hasCart={hasCart}
      onRegistered={onRegistered}
      onClose={() => setOpen(false)}
    />
  );
}

function OrderFormPanel({
  leadId,
  currency,
  hasCart,
  onRegistered,
  onClose,
}: {
  leadId: string;
  currency: string;
  hasCart: boolean;
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
        sendConfirmation: sendConfirm,
        confirmationText: confirmText.trim() || undefined,
        discount:
          discountKind === "none" || discountValue == null || discountValue <= 0
            ? null
            : { kind: discountKind, value: discountValue },
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

/** Prior-purchase summary for a recurrent customer (último pedido / cuándo / qué). */
function RecurrentCustomer({ history }: { history: CustomerHistory | null }) {
  if (!history || !history.lastOrderAt) return null;
  const days = Math.max(0, Math.floor((Date.now() - new Date(history.lastOrderAt).getTime()) / 86_400_000));
  const ago = days === 0 ? "hoy" : days === 1 ? "hace 1 día" : `hace ${days} días`;
  return (
    <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5 text-sm text-amber-900">
      <p className="text-xs font-semibold tracking-wide uppercase opacity-80">Cliente recurrente</p>
      <p className="mt-1">
        🔁 Último pedido{history.lastOrderName ? ` ${history.lastOrderName}` : ""} · {ago}
        {history.orderCount > 1 ? ` · ${history.orderCount} pedidos previos` : ""}
      </p>
      {history.lastProduct && <p className="mt-0.5 text-amber-800/90">Compró: {history.lastProduct}</p>}
    </div>
  );
}

/** Call affordance for a web cart with no WhatsApp chat: tel: link + copy number. */
function CallAffordance({ phone }: { phone: string }) {
  const [copied, setCopied] = useState(false);
  function copy() {
    navigator.clipboard?.writeText(phone).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      () => {},
    );
  }
  return (
    <div className="rounded-xl border border-indigo-200 bg-indigo-50 px-3 py-2.5 text-sm text-indigo-900">
      <p className="text-xs font-semibold tracking-wide uppercase opacity-80">Carrito web — sin WhatsApp</p>
      <p className="mt-1 mb-2 text-indigo-800/90">
        El cliente no escribió por WhatsApp. Llámalo para recuperar el carrito.
      </p>
      <div className="flex items-center gap-2">
        <a
          href={`tel:${phone}`}
          className="rounded-lg bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700"
        >
          📞 Llamar {phone}
        </a>
        <button
          type="button"
          onClick={copy}
          className="rounded-lg border border-indigo-300 px-2.5 py-1.5 text-xs font-medium text-indigo-700 hover:bg-indigo-100"
        >
          {copied ? "Copiado ✓" : "Copiar número"}
        </button>
      </div>
    </div>
  );
}

function CallForm({ leadId, onRegistered }: { leadId: string; onRegistered: () => void }) {
  const [state, action, pending] = useActionState<LeadActionState, FormData>(registerCall, {});
  useEffect(() => {
    if (state.notice) onRegistered();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.notice]);
  return (
    <section className="space-y-2.5 rounded-xl border border-slate-200 p-3">
      <h3 className="text-sm font-semibold tracking-wide text-slate-700 uppercase">
        Registrar llamada
      </h3>
      <form action={action} className="space-y-2.5">
        <input type="hidden" name="lead_id" value={leadId} />
        <div>
          <label className={labelCls} htmlFor="status">
            Estado
          </label>
          <select id="status" name="status" defaultValue="" className={inputCls}>
            <option value="">(mantener estado)</option>
            {MANUAL_STATUSES.map((s) => (
              <option key={s.code} value={s.code}>
                {s.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className={labelCls} htmlFor="note">
            Nota
          </label>
          <textarea
            id="note"
            name="note"
            rows={2}
            placeholder="Nota de la llamada"
            className={inputCls}
          />
        </div>
        <div>
          <label className={labelCls} htmlFor="next_followup_at">
            Próximo seguimiento
          </label>
          <input
            id="next_followup_at"
            name="next_followup_at"
            type="datetime-local"
            className={inputCls}
          />
        </div>
        <button
          type="submit"
          disabled={pending}
          className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-60"
        >
          {pending ? "Guardando…" : "Guardar llamada"}
        </button>
        {state.error && <p className="text-sm text-red-600">{state.error}</p>}
        {state.notice && <p className="text-sm text-emerald-600">{state.notice}</p>}
      </form>
    </section>
  );
}
