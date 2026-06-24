"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useActionState, useEffect, useState, useTransition } from "react";
import type { LeadCallRow, LeadRow, StoreSummary } from "@/lib/types";
import { type LeadView } from "@/lib/leads-access";
import {
  LEAD_GESTIONES,
  LEAD_SEGMENTS,
  MANUAL_STATUSES,
  categoryOf,
  isClaimActive,
  labelOf,
  type LeadCategory,
  type LeadGestion,
  type LeadSegment,
} from "@/lib/leads";
import {
  claimLead,
  loadLeadDetail,
  registerCall,
  releaseLead,
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

/** Aging chip for active leads — flags the ones going cold (anti-fuga). */
function AgingBadge({ at }: { at: string | null | undefined }) {
  const d = daysSince(at);
  if (d == null || d < 1) return null;
  const cls =
    d >= 7 ? "bg-red-100 text-red-700" : d >= 3 ? "bg-amber-100 text-amber-700" : "bg-slate-100 text-slate-500";
  return (
    <span className={cn("ml-2 whitespace-nowrap rounded px-1.5 py-0.5 text-xs font-medium", cls)}>
      hace {d} día{d === 1 ? "" : "s"}
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

export function LeadsBoard({
  stores,
  storeId,
  view,
  counts,
  leads,
  segCounts,
  segment,
  gestCounts,
  gestion,
  currentUserId,
}: {
  stores: StoreSummary[];
  storeId: string;
  view: LeadView;
  counts: Record<LeadView, number>;
  leads: LeadRow[];
  segCounts?: Record<LeadSegment, number> | null;
  segment?: LeadSegment | null;
  gestCounts?: Record<LeadGestion, number> | null;
  gestion?: LeadGestion | null;
  currentUserId: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [banner, setBanner] = useState<string | null>(null);
  // Drawer is client-state driven: it opens instantly from the row we already
  // have; the claim + call history load in the background (no page navigation).
  const [selected, setSelected] = useState<LeadRow | null>(null);
  const [calls, setCalls] = useState<LeadCallRow[] | null>(null);

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
      startTransition(async () => {
        await releaseLead(leadId);
        router.refresh();
      });
    }
  }

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
        <nav className="flex flex-wrap items-center gap-1.5">
          {/* Cola "Por llamar": Todos + sub-filtros por intención (frío → con carrito).
              Los hrefs preservan el eje de gestión (&gest) para que el combo sobreviva. */}
          <NavPill
            href={`/dashboard/leads?store=${storeId}&view=por_llamar${gestion ? `&gest=${gestion}` : ""}`}
            label="Todos"
            count={counts.por_llamar}
            active={view === "por_llamar" && !segment}
          />
          {(["frio", "converso", "distrito", "carrito"] as LeadSegment[]).map((k) => (
            <NavPill
              key={k}
              href={`/dashboard/leads?store=${storeId}&view=por_llamar&seg=${k}${gestion ? `&gest=${gestion}` : ""}`}
              label={SEG_LABEL[k]}
              count={segCounts?.[k] ?? 0}
              active={view === "por_llamar" && segment === k}
            />
          ))}

          {/* separador: izquierda = filtros de la cola · derecha = estados finales */}
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

        {/* 2da línea — Gestión (estado de llamada del asesor); solo en la cola.
            Combina con el eje de intención: los hrefs preservan &seg. */}
        {view === "por_llamar" && (
          <nav className="mt-2 flex flex-wrap items-center gap-1.5 border-t border-slate-100 pt-2">
            <span className="text-xs font-medium text-slate-400">Gestión:</span>
            <NavPill
              href={`/dashboard/leads?store=${storeId}&view=por_llamar${segment ? `&seg=${segment}` : ""}`}
              label="Todos"
              count={counts.por_llamar}
              active={!gestion}
            />
            {LEAD_GESTIONES.map((g) => (
              <NavPill
                key={g.key}
                href={`/dashboard/leads?store=${storeId}&view=por_llamar${segment ? `&seg=${segment}` : ""}&gest=${g.key}`}
                label={g.label}
                count={gestCounts?.[g.key] ?? 0}
                active={gestion === g.key}
              />
            ))}
          </nav>
        )}
      </div>

      {banner && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-700">
          {banner}
        </div>
      )}

      <Card>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-xs text-slate-500">
                <th className="py-2 text-left font-medium">Nombre</th>
                <th className="py-2 text-left font-medium">Teléfono</th>
                <th className="py-2 text-left font-medium">Última interacción</th>
                <th className="py-2 text-left font-medium">Estado</th>
                <th className="py-2 text-right font-medium">Acción</th>
              </tr>
            </thead>
            <tbody>
              {leads.map((lead) => {
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
                      {active && <AgingBadge at={lead.last_interaction_at} />}
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
              {!leads.length && (
                <tr>
                  <td colSpan={5} className="py-4 text-sm text-slate-400">
                    No hay leads en esta vista.
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
  onClose,
  onRegistered,
  closing,
}: {
  lead: LeadRow;
  calls: LeadCallRow[] | null; // null = still loading
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
        <div className="flex items-start justify-between gap-3 border-b border-slate-200 px-5 py-4">
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

        <div className="space-y-5 px-5 py-5">
          {lead.handoff_context && (
            <div
              className={cn(
                "rounded-xl border px-4 py-3 text-sm",
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
            <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900">
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

          {lead.has_order && (
            <p className="text-sm font-medium text-emerald-700">
              ✅ Pedido generado{lead.order_id ? ` · ${lead.order_id}` : ""}
            </p>
          )}

          <CallForm leadId={lead.id} onRegistered={onRegistered} />

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
                      <span className="text-xs text-slate-400">{fmtDate(c.occurred_at)}</span>
                      {c.new_status && (
                        <span className="text-xs font-medium text-slate-600">
                          {labelOf(c.new_status)}
                        </span>
                      )}
                    </div>
                    {c.note && <p className="mt-1 text-slate-700">{c.note}</p>}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-slate-400">Sin actividad todavía.</p>
            )}
          </section>

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

function CallForm({ leadId, onRegistered }: { leadId: string; onRegistered: () => void }) {
  const [state, action, pending] = useActionState<LeadActionState, FormData>(registerCall, {});
  useEffect(() => {
    if (state.notice) onRegistered();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.notice]);
  return (
    <section className="space-y-3 rounded-xl border border-slate-200 p-4">
      <h3 className="text-sm font-semibold tracking-wide text-slate-700 uppercase">
        Registrar llamada
      </h3>
      <form action={action} className="space-y-3">
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
            rows={3}
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
