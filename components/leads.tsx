"use client";

import { useRouter } from "next/navigation";
import { type ReactNode, useActionState, useEffect, useState, useTransition } from "react";
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
  closeSale,
  getLeadWindow,
  loadLeadDetail,
  recoverCart,
  registerCall,
  releaseLead,
  searchLeads,
  sendLeadMessage,
  type LeadActionState,
} from "@/app/dashboard/leads/actions";
import { Card, cn } from "@/components/ui";

const inputCls =
  "mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100";
const labelCls = "block text-sm font-medium text-slate-700";

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
  const name = adMeta?.adName ? prettyAdName(adMeta.adName) : null;
  const href = adsManagerUrl(adMeta?.accountId ?? null, lead.ad_id ?? "");
  const objective = adObjectiveLabel(adMeta?.objective ?? null);
  const status = adStatusLabel(adMeta?.status ?? null);
  return (
    <div className="rounded-xl border border-violet-200 bg-violet-50 px-3 py-2.5 text-sm text-violet-900">
      <p className="text-xs font-semibold tracking-wide uppercase opacity-80">Fuente · Campaña Meta</p>
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

/** Engagement-level chip (Frío → Conversó → Dio distrito → Con carrito) per row. */
function SegmentBadge({ lead }: { lead: LeadRow }) {
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
  const [pending, startTransition] = useTransition();
  const [banner, setBanner] = useState<string | null>(null);
  // Drawer is client-state driven: it opens instantly from the row we already
  // have; the claim + call history load in the background (no page navigation).
  const [selected, setSelected] = useState<LeadRow | null>(null);
  const [calls, setCalls] = useState<LeadCallRow[] | null>(null);
  const [history, setHistory] = useState<CustomerHistory | null>(null); // recurrent-customer block
  // Client-side sub-filters (instant, no navigation): source lens + the queue's
  // intención/gestión axes within "Por llamar".
  const [srcFilter, setSrcFilter] = useState<"all" | "meta_ad" | "organic">("all");
  const [segFilter, setSegFilter] = useState<LeadSegment | null>(initialSeg ?? null);
  const [gestFilter, setGestFilter] = useState<LeadGestion | null>(initialGest ?? null);
  const [winFilter, setWinFilter] = useState<"all" | "fresca" | "por_vencer" | "cerrada">("all");
  const [numFilter, setNumFilter] = useState<string | null>(null); // WhatsApp number (phone_number_id)
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
    startTransition(async () => {
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
    });
  }

  function refreshDetail(leadId: string) {
    startTransition(async () => {
      const d = await loadLeadDetail(leadId);
      if (!("error" in d)) {
        setSelected(d.lead);
        setCalls(d.calls);
        setHistory(d.customerHistory);
      }
      router.refresh(); // reflect status/queue changes in the list + counts
    });
  }

  function closeDrawer() {
    const leadId = selected?.id;
    setSelected(null);
    setCalls(null);
    setHistory(null);
    if (leadId) {
      // Release the claim in the background. No full-list refresh on close —
      // status changes already refresh via refreshDetail, so this avoids an
      // unnecessary refetch of the whole queue every time the drawer closes.
      startTransition(async () => {
        await releaseLead(leadId);
      });
    }
  }

  const campaignCount = leads.filter((l) => l.source === "meta_ad").length;
  const organicCount = leads.length - campaignCount;
  const hasCampaign = campaignCount > 0;
  const now = Date.now();
  const segCounts = countLeadSegments(leads);
  const gestCounts = countGestiones(leads);
  const winCounts = countLeadWindows(leads, now);
  // WhatsApp numbers present in this view (to split the queue by number).
  const waCounts = new Map<string, number>();
  for (const l of leads) {
    if (l.wa_phone_number_id) waCounts.set(l.wa_phone_number_id, (waCounts.get(l.wa_phone_number_id) ?? 0) + 1);
  }
  const waIds = [...waCounts.keys()];
  const hasMultiNumbers = waIds.length >= 2;
  const q = query.trim().toLowerCase();
  const qDigits = q.replace(/\D/g, "");
  const shownLeads = leads.filter((l) => {
    if (q) {
      const name = (l.name ?? "").toLowerCase();
      const phoneDigits = (l.phone ?? "").replace(/\D/g, "");
      if (!(name.includes(q) || (qDigits.length > 0 && phoneDigits.includes(qDigits)))) return false;
    }
    if (srcFilter !== "all" && (l.source === "meta_ad" ? "meta_ad" : "organic") !== srcFilter) return false;
    if (numFilter && l.wa_phone_number_id !== numFilter) return false;
    if (view === "por_llamar") {
      if (segFilter && leadSegment(l) !== segFilter) return false;
      if (gestFilter && gestionOf(l.status) !== gestFilter) return false;
      if (winFilter !== "all") {
        const { state } = leadWindowInfo(l.last_inbound_at ?? l.last_interaction_at, now);
        if (winFilter === "fresca" && state !== "fresca") return false;
        if (winFilter === "por_vencer" && !(state === "por_vencer" || state === "critica")) return false;
        if (winFilter === "cerrada" && state !== "cerrada") return false;
      }
    }
    return true;
  });
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
              { key: "all", label: "Todos", count: view === "por_llamar" ? counts.por_llamar : undefined },
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
                onChange={(key) => setGestFilter(key === "all" ? null : (key as LeadGestion))}
                options={[
                  { key: "all", label: "Todos", count: counts.por_llamar },
                  ...LEAD_GESTIONES.map((g) => ({ key: g.key, label: g.label, count: gestCounts[g.key] })),
                ]}
              />
            )}
            {view === "por_llamar" && (
              <SegControl
                label="Ventana"
                value={winFilter}
                onChange={(key) => setWinFilter(key as "all" | "fresca" | "por_vencer" | "cerrada")}
                options={[
                  { key: "all", label: "Todos" },
                  { key: "fresca", label: "🟢 A tiempo", count: winCounts.a_tiempo },
                  { key: "por_vencer", label: "⏳ Por vencer", count: winCounts.por_vencer },
                  { key: "cerrada", label: "⚫ Vencido", count: winCounts.cerrada },
                ]}
              />
            )}
            {hasCampaign && (
              <SegControl
                label="Fuente"
                value={srcFilter}
                onChange={(key) => setSrcFilter(key as "all" | "meta_ad" | "organic")}
                options={[
                  { key: "all", label: "Todas" },
                  { key: "meta_ad", label: "📣 Campaña", count: campaignCount },
                  { key: "organic", label: "Orgánico", count: organicCount },
                ]}
              />
            )}
            {hasMultiNumbers && (
              <SegControl
                label="Número"
                value={numFilter ?? "all"}
                onChange={(key) => setNumFilter(key === "all" ? null : key)}
                options={[
                  { key: "all", label: "Todos" },
                  ...waIds.map((id) => {
                    const n = waNumbers?.[id];
                    const kind = waKindLabel(n?.kind ?? null);
                    return {
                      key: id,
                      label: `📱 ${waLabel(n, id)}${kind ? ` · ${kind}` : ""}`,
                      count: waCounts.get(id) ?? 0,
                    };
                  }),
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
                        disabled={pending}
                        className="inline-flex items-center gap-1 rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-60"
                      >
                        {locked && <span title="Tomado por otro vendedor">🔒 tomado</span>}
                        Tomar / Ver
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
          closing={pending}
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
  closing,
}: {
  lead: LeadRow;
  calls: LeadCallRow[] | null; // null = still loading
  history: CustomerHistory | null; // prior purchases (recurrent-customer block)
  adMeta: AdMeta | null; // Meta attribution for lead.ad_id (null until resolved)
  waNumber: WaNumber | null; // resolved label for lead.wa_phone_number_id (null = unresolved)
  currency: string;
  onClose: () => void;
  onRegistered: () => void;
  closing: boolean;
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
          <div className="space-y-1">
            <p className="text-base font-semibold text-slate-900">{lead.name || lead.phone}</p>
            <a
              href={`https://wa.me/${lead.phone}`}
              target="_blank"
              rel="noreferrer"
              className="text-sm text-brand-700 hover:underline"
            >
              {lead.phone}
            </a>
            <div>
              <StatusBadge status={lead.status} needsAttention={lead.needs_attention} />
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={closing}
            aria-label="Cerrar"
            className="rounded-lg p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700 disabled:opacity-60"
          >
            ✕
          </button>
        </div>

        <div className="space-y-4 px-5 py-4">
          {lead.handoff_context && (
            <div
              className={cn(
                "rounded-xl border px-3 py-2.5 text-sm",
                handoffTone === "red"
                  ? "border-red-200 bg-red-50 text-red-800"
                  : "border-amber-200 bg-amber-50 text-amber-800",
              )}
            >
              <p className="text-xs font-semibold tracking-wide uppercase opacity-80">
                Resumen del bot
              </p>
              <p className="mt-1 whitespace-pre-wrap">{lead.handoff_context}</p>
            </div>
          )}

          {(lead.cart_item_count || lead.district || lead.draft_order_gid) && (
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
              ) : null}
              {(lead.district || lead.province || lead.referencia) && (
                <p className={lead.cart_item_count ? "mt-1" : ""}>
                  📍 <span className="font-medium">Entrega:</span>{" "}
                  {[lead.district, lead.province, lead.referencia].filter(Boolean).join(" · ")}
                </p>
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

          {lead.draft_order_gid && lead.draft_order_status !== "completed" && !lead.has_order && (
            <RecoverCartButton
              leadId={lead.id}
              currency={currency}
              cartValue={lead.cart_value}
              onRecovered={onRegistered}
            />
          )}

          <RecurrentCustomer history={history} />

          {lead.source === "meta_ad" && <MetaAttribution lead={lead} adMeta={adMeta} />}

          {lead.wa_phone_number_id && (
            <div className="rounded-xl border border-sky-200 bg-sky-50 px-3 py-2.5 text-sm text-sky-900">
              <p className="text-xs font-semibold tracking-wide uppercase opacity-80">
                Número de WhatsApp
              </p>
              <p className="mt-1">
                📱 <span className="font-medium">{waLabel(waNumber, lead.wa_phone_number_id)}</span>
                {waKindLabel(waNumber?.kind ?? null) ? ` · ${waKindLabel(waNumber?.kind ?? null)}` : ""}
                {waNumber?.displayPhone ? ` · ${waNumber.displayPhone}` : ""}
              </p>
            </div>
          )}

          {lead.has_order && (
            <p className="text-sm font-medium text-emerald-700">
              ✅ Pedido generado{lead.order_id ? ` · ${lead.order_id}` : ""}
            </p>
          )}

          {!lead.kapso_conversation_id && lead.draft_order_gid && <CallAffordance phone={lead.phone} />}

          <WhatsappComposer
            leadId={lead.id}
            lastInteractionAt={lead.last_interaction_at}
            onSent={onRegistered}
          />

          <section className="space-y-2">
            <h3 className="text-sm font-semibold tracking-wide text-slate-700 uppercase">
              Historial
            </h3>
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
                        <span className="text-xs font-medium text-slate-600">
                          {labelOf(c.new_status)}
                        </span>
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

          <CallForm leadId={lead.id} onRegistered={onRegistered} />

          {!lead.has_order && (
            <CloseSaleForm lead={lead} currency={currency} onRegistered={onRegistered} />
          )}
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

/** Close a sale by phone (contraentrega / COD). Records a lightweight manual
 *  order, marks the lead Ganado and credits the advisor. Collapsed by default to
 *  keep the drawer tidy; expands into the amount / products / district form. */
function CloseSaleForm({
  lead,
  currency,
  onRegistered,
}: {
  lead: LeadRow;
  currency: string;
  onRegistered: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState("");
  const [products, setProducts] = useState(lead.cart_summary ?? "");
  const [district, setDistrict] = useState(lead.district ?? "");
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);

  function submit() {
    const amt = Number(amount.replace(",", ".").trim());
    if (!Number.isFinite(amt) || amt <= 0) {
      setMsg("Ingresa un monto válido (mayor a 0).");
      return;
    }
    setMsg(null);
    startTransition(async () => {
      const res = await closeSale(lead.id, {
        amount: amt,
        products: products.trim(),
        district: district.trim(),
      });
      if (res.error) {
        setMsg(res.error);
        return;
      }
      setMsg(res.notice ?? "Venta registrada.");
      onRegistered();
    });
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="w-full rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700"
      >
        💰 Cerrar venta (contraentrega)
      </button>
    );
  }

  return (
    <section className="space-y-2.5 rounded-xl border border-emerald-200 bg-emerald-50/60 p-3">
      <h3 className="text-sm font-semibold tracking-wide text-emerald-800 uppercase">
        Cerrar venta · contraentrega
      </h3>
      <div>
        <label className={labelCls} htmlFor="sale_amount">
          Monto total ({currency})
        </label>
        <input
          id="sale_amount"
          inputMode="decimal"
          value={amount}
          onChange={(e) => setAmount(e.currentTarget.value)}
          placeholder="0.00"
          className={inputCls}
          disabled={pending}
          autoFocus
        />
      </div>
      <div>
        <label className={labelCls} htmlFor="sale_products">
          Productos
        </label>
        <input
          id="sale_products"
          value={products}
          onChange={(e) => setProducts(e.currentTarget.value)}
          placeholder="Ej. Mochila viral x1"
          className={inputCls}
          disabled={pending}
        />
      </div>
      <div>
        <label className={labelCls} htmlFor="sale_district">
          Distrito (entrega)
        </label>
        <input
          id="sale_district"
          value={district}
          onChange={(e) => setDistrict(e.currentTarget.value)}
          placeholder="Distrito del cliente"
          className={inputCls}
          disabled={pending}
        />
      </div>
      <p className="text-xs text-emerald-700/80">
        Pago contraentrega → queda como <span className="font-medium">pago pendiente</span>. Marca el
        lead como <span className="font-medium">Ganado</span> y suma a tu productividad.
      </p>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={submit}
          disabled={pending}
          className="rounded-lg bg-emerald-600 px-3 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-60"
        >
          {pending ? "Registrando…" : "Registrar venta"}
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          disabled={pending}
          className="text-sm text-slate-500 hover:underline disabled:opacity-60"
        >
          Cancelar
        </button>
        {msg && <span className="text-xs text-slate-600">{msg}</span>}
      </div>
    </section>
  );
}

/** Recover an abandoned cart → complete its Shopify draft into a real COD order
 *  (recoverCart). The primary CTA for an open cart lead. */
function RecoverCartButton({
  leadId,
  currency,
  cartValue,
  onRecovered,
}: {
  leadId: string;
  currency: string;
  cartValue?: number | null;
  onRecovered: () => void;
}) {
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  function run() {
    if (
      !confirm(
        "¿Generar el pedido en Shopify? El borrador se completará como contraentrega (pago pendiente).",
      )
    )
      return;
    setMsg(null);
    startTransition(async () => {
      const res = await recoverCart(leadId);
      setMsg(res.error ?? res.notice ?? null);
      if (!res.error) onRecovered();
    });
  }
  return (
    <div className="space-y-1.5">
      <button
        type="button"
        onClick={run}
        disabled={pending}
        className="w-full rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-60"
      >
        {pending
          ? "Generando pedido…"
          : `✅ Generar pedido${cartValue != null ? ` · ${currency} ${Number(cartValue).toFixed(2)}` : ""} (contraentrega)`}
      </button>
      {msg && <p className="text-xs text-slate-600">{msg}</p>}
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
