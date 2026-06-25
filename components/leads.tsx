"use client";

import Link from "next/link";
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
import { type LeadView } from "@/lib/leads-access";
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
  getLeadWindow,
  loadLeadDetail,
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

/** One pill in the unified leads nav (a queue sub-filter or an outcome tab). */
function NavPill({
  href,
  label,
  count,
  active,
}: {
  href: string;
  label: string;
  count: number;
  active: boolean;
}) {
  return (
    <Link
      href={href}
      className={cn(
        "inline-flex items-center gap-2 rounded-lg border px-3 py-1.5 text-sm",
        active
          ? "border-brand-500 bg-brand-50 text-brand-700"
          : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50",
      )}
    >
      {label}
      <span
        className={cn(
          "rounded-full px-1.5 py-0.5 text-xs font-medium",
          active ? "bg-brand-100 text-brand-700" : "bg-slate-100 text-slate-500",
        )}
      >
        {count}
      </span>
    </Link>
  );
}

/** Client-side filter pill (instant, no navigation) — mirrors NavPill styling. */
function FilterPill({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count?: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-2 rounded-lg border px-3 py-1.5 text-sm",
        active
          ? "border-brand-500 bg-brand-50 text-brand-700"
          : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50",
      )}
    >
      {label}
      {count !== undefined && (
        <span
          className={cn(
            "rounded-full px-1.5 py-0.5 text-xs font-medium",
            active ? "bg-brand-100 text-brand-700" : "bg-slate-100 text-slate-500",
          )}
        >
          {count}
        </span>
      )}
    </button>
  );
}

export function LeadsBoard({
  stores,
  storeId,
  view,
  counts,
  leads,
  adNames,
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
  // Client-side sub-filters (instant, no navigation): source lens + the queue's
  // intención/gestión axes within "Por llamar".
  const [srcFilter, setSrcFilter] = useState<"all" | "meta_ad" | "organic">("all");
  const [segFilter, setSegFilter] = useState<LeadSegment | null>(initialSeg ?? null);
  const [gestFilter, setGestFilter] = useState<LeadGestion | null>(initialGest ?? null);
  const [winFilter, setWinFilter] = useState<"all" | "por_vencer" | "cerrada">("all");
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
    });
  }

  function refreshDetail(leadId: string) {
    startTransition(async () => {
      const d = await loadLeadDetail(leadId);
      if (!("error" in d)) {
        setSelected(d.lead);
        setCalls(d.calls);
      }
      router.refresh(); // reflect status/queue changes in the list + counts
    });
  }

  function closeDrawer() {
    const leadId = selected?.id;
    setSelected(null);
    setCalls(null);
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
  const q = query.trim().toLowerCase();
  const qDigits = q.replace(/\D/g, "");
  const shownLeads = leads.filter((l) => {
    if (q) {
      const name = (l.name ?? "").toLowerCase();
      const phoneDigits = (l.phone ?? "").replace(/\D/g, "");
      if (!(name.includes(q) || (qDigits.length > 0 && phoneDigits.includes(qDigits)))) return false;
    }
    if (srcFilter !== "all" && (l.source === "meta_ad" ? "meta_ad" : "organic") !== srcFilter) return false;
    if (view === "por_llamar") {
      if (segFilter && leadSegment(l) !== segFilter) return false;
      if (gestFilter && gestionOf(l.status) !== gestFilter) return false;
      if (winFilter !== "all") {
        const { state } = leadWindowInfo(l.last_inbound_at ?? l.last_interaction_at, now);
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
        {/* Una sola línea: cola "Por llamar" + sub-filtros de intención (instantáneos
            dentro de la cola) · separador · estados finales (navegan con skeleton). */}
        <nav className="flex flex-wrap items-center gap-1.5">
          {([null, "frio", "converso", "distrito", "carrito"] as (LeadSegment | null)[]).map((seg) => {
            const inQueue = view === "por_llamar";
            return (
              <FilterPill
                key={seg ?? "all"}
                label={seg ? SEG_LABEL[seg] : "Todos"}
                count={inQueue ? (seg ? segCounts[seg] : counts.por_llamar) : undefined}
                active={inQueue && (seg ? segFilter === seg : !segFilter)}
                onClick={() => {
                  if (inQueue) setSegFilter(seg);
                  else
                    router.push(
                      `/dashboard/leads?store=${storeId}&view=por_llamar${seg ? `&seg=${seg}` : ""}`,
                    );
                }}
              />
            );
          })}

          <span className="mx-1 h-6 w-px shrink-0 self-center bg-slate-300" aria-hidden="true" />

          {OUTCOME_VIEWS.map((v) => (
            <NavPill
              key={v.key}
              href={`/dashboard/leads?store=${storeId}&view=${v.key}`}
              label={v.label}
              count={counts[v.key]}
              active={view === v.key}
            />
          ))}
        </nav>

        {/* Línea 2: Gestión (en la cola) + Fuente — client-side e instantáneos.
            En desktop entran en una sola línea; en móvil hacen wrap. */}
        {(view === "por_llamar" || hasCampaign) && (
          <div className="mt-2 flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-slate-100 pt-2">
            {view === "por_llamar" && (
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-xs font-medium text-slate-400">Gestión:</span>
                <FilterPill
                  label="Todos"
                  count={counts.por_llamar}
                  active={!gestFilter}
                  onClick={() => setGestFilter(null)}
                />
                {LEAD_GESTIONES.map((g) => (
                  <FilterPill
                    key={g.key}
                    label={g.label}
                    count={gestCounts[g.key]}
                    active={gestFilter === g.key}
                    onClick={() => setGestFilter((p) => (p === g.key ? null : g.key))}
                  />
                ))}
              </div>
            )}
            {view === "por_llamar" && (
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-xs font-medium text-slate-400">Ventana:</span>
                <FilterPill label="Todos" active={winFilter === "all"} onClick={() => setWinFilter("all")} />
                <FilterPill
                  label="⏳ Por vencer"
                  count={winCounts.por_vencer}
                  active={winFilter === "por_vencer"}
                  onClick={() => setWinFilter("por_vencer")}
                />
                <FilterPill
                  label="⚫ Vencido"
                  count={winCounts.cerrada}
                  active={winFilter === "cerrada"}
                  onClick={() => setWinFilter("cerrada")}
                />
              </div>
            )}
            {hasCampaign && (
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-xs font-medium text-slate-400">Fuente:</span>
                <FilterPill label="Todas" active={srcFilter === "all"} onClick={() => setSrcFilter("all")} />
                <FilterPill
                  label="📣 Campaña"
                  count={campaignCount}
                  active={srcFilter === "meta_ad"}
                  onClick={() => setSrcFilter("meta_ad")}
                />
                <FilterPill
                  label="Orgánico"
                  count={organicCount}
                  active={srcFilter === "organic"}
                  onClick={() => setSrcFilter("organic")}
                />
              </div>
            )}
          </div>
        )}
      </div>

      {banner && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-700">
          {banner}
        </div>
      )}

      <div>
        <div className="relative">
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
            placeholder="Buscar lead por nombre o celular…"
            aria-label="Buscar lead por nombre o celular"
            className="w-full rounded-lg border border-slate-300 py-2 pr-9 pl-9 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
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
        {query.trim().length >= 2 && (
          <p className="mt-1.5 text-xs text-slate-500">
            {searching
              ? "Buscando en todas las etapas…"
              : searchMode
                ? `🔎 ${displayLeads.length} resultado${displayLeads.length === 1 ? "" : "s"} para «${query.trim()}» · en todas las etapas`
                : null}
          </p>
        )}
      </div>

      <Card>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-xs text-slate-500">
                <th className="py-2 text-left font-medium">Nombre</th>
                <th className="py-2 text-left font-medium">Teléfono</th>
                <th className="py-2 text-left font-medium">Última interacción</th>
                <th className="py-2 text-left font-medium">Calificación</th>
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
                      {lead.name || lead.phone}
                      {lead.source === "meta_ad" && (
                        <span
                          className="ml-2 whitespace-nowrap rounded bg-violet-100 px-1.5 py-0.5 text-xs font-medium text-violet-700"
                          title={lead.ad_headline ? `Campaña Meta: ${lead.ad_headline}` : "Llegó por campaña de Meta (Click-to-WhatsApp)"}
                        >
                          📣 Campaña
                        </span>
                      )}
                    </td>
                    <td className="py-2.5">
                      <a
                        href={`https://wa.me/${lead.phone}`}
                        target="_blank"
                        rel="noreferrer"
                        className="text-brand-700 hover:underline"
                      >
                        {lead.phone}
                      </a>
                    </td>
                    <td className="py-2.5 text-slate-600">
                      {fmtDate(lead.last_interaction_at)}
                      {active && <WindowBadge lead={lead} />}
                    </td>
                    <td className="py-2.5">
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
          adMeta={selected.ad_id ? (adNames?.[selected.ad_id] ?? null) : null}
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
  adMeta,
  onClose,
  onRegistered,
  closing,
}: {
  lead: LeadRow;
  calls: LeadCallRow[] | null; // null = still loading
  adMeta: AdMeta | null; // Meta attribution for lead.ad_id (null until resolved)
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

          {(lead.cart_item_count || lead.district) && (
            <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2.5 text-sm text-emerald-900">
              {lead.cart_item_count ? (
                <p>
                  🛒 <span className="font-medium">Carrito:</span>{" "}
                  {lead.cart_summary || `${lead.cart_item_count} producto(s)`}
                  {lead.cart_value != null ? ` · S/ ${Number(lead.cart_value).toFixed(2)}` : ""}
                </p>
              ) : null}
              {lead.district ? (
                <p className={lead.cart_item_count ? "mt-1" : ""}>
                  📍 <span className="font-medium">Distrito:</span> {lead.district}
                </p>
              ) : null}
            </div>
          )}

          {lead.source === "meta_ad" && <MetaAttribution lead={lead} adMeta={adMeta} />}

          {lead.has_order && (
            <p className="text-sm font-medium text-emerald-700">
              ✅ Pedido generado{lead.order_id ? ` · ${lead.order_id}` : ""}
            </p>
          )}

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

          <button
            type="button"
            disabled
            className="w-full rounded-lg border border-slate-200 px-4 py-2 text-sm font-medium text-slate-400"
          >
            Cerrar venta (crear orden) — próximamente
          </button>
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
