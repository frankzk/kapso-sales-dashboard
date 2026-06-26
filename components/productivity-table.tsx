"use client";

import { Fragment, useState } from "react";
import { cn } from "@/components/ui";
import { categoryOf, labelOf } from "@/lib/leads";
import { loadAgentLeads } from "@/app/dashboard/productividad/actions";
import type { AdvisorStatWithDelta, AgentLeadRow } from "@/lib/productivity";

function money(n: number, currency: string): string {
  return new Intl.NumberFormat("es-PE", { style: "currency", currency, maximumFractionDigits: 0 }).format(n);
}

function pct(x: number): string {
  return `${Math.round(x * 100)}%`;
}

/** Tiny ↑/↓ change vs the previous period, rendered after a metric value. */
function DeltaInline({ value, fmt }: { value: number; fmt: (n: number) => string }) {
  if (value === 0) return <span className="ml-1 align-middle text-[11px] text-slate-300">→</span>;
  const up = value > 0;
  return (
    <span className={cn("ml-1 align-middle text-[11px] font-medium", up ? "text-emerald-600" : "text-rose-500")}>
      {up ? "↑" : "↓"}
      {fmt(Math.abs(value))}
    </span>
  );
}

/** Show the name part of the email (before @) as a friendlier label. */
function advisorName(email: string): string {
  return email.includes("@") ? email.split("@")[0]! : email;
}

function shortWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("es-PE", { day: "2-digit", month: "short" });
}

const SOURCE_CHIP: Record<AgentLeadRow["source"], { label: string; cls: string }> = {
  meta_ad: { label: "📣 Campaña", cls: "bg-sky-50 text-sky-700" },
  cod_cart: { label: "🛒 Carrito", cls: "bg-amber-50 text-amber-700" },
  organic: { label: "Orgánico", cls: "bg-slate-100 text-slate-600" },
};

function statusClass(status: string): string {
  const cat = categoryOf(status);
  if (cat === "won") return "text-emerald-700";
  if (cat === "lost") return "text-slate-400";
  return "text-slate-700";
}

type DrillContext = {
  from: string;
  to: string;
  store: string | null;
  source: "meta_ad" | "cod_cart" | "organic" | null;
};

type LoadState = AgentLeadRow[] | "loading" | "error" | undefined;

function AgentLeads({ state, currency }: { state: LoadState; currency: string }) {
  if (state === "loading") return <p className="px-3 py-3 text-sm text-slate-400">Cargando leads…</p>;
  if (state === "error")
    return <p className="px-3 py-3 text-sm text-rose-500">No se pudieron cargar los leads.</p>;
  if (!state || !state.length)
    return <p className="px-3 py-3 text-sm text-slate-400">Sin leads trabajados en este período.</p>;

  return (
    <div className="overflow-x-auto px-1 py-1">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-slate-200 text-xs text-slate-500">
            <th className="py-2 pl-2 text-left font-medium">Lead</th>
            <th className="py-2 text-left font-medium">Estado</th>
            <th className="py-2 text-left font-medium">Fuente</th>
            <th className="py-2 text-right font-medium">Llam.</th>
            <th className="py-2 text-right font-medium">Resultado</th>
            <th className="py-2 pr-2 text-right font-medium">Últ. toque</th>
          </tr>
        </thead>
        <tbody>
          {state.map((l) => {
            const chip = SOURCE_CHIP[l.source];
            return (
              <tr key={l.id} className="border-b border-slate-100 last:border-0">
                <td className="py-2 pl-2 text-left">
                  <div className="font-medium text-slate-800">{l.name || "Sin nombre"}</div>
                  {l.phone && <div className="text-xs text-slate-400">{l.phone}</div>}
                </td>
                <td className={cn("py-2 text-left", statusClass(l.status))}>{labelOf(l.status)}</td>
                <td className="py-2 text-left">
                  <span className={cn("rounded-md px-1.5 py-0.5 text-xs font-medium", chip.cls)}>{chip.label}</span>
                </td>
                <td className="py-2 text-right text-slate-600">{l.llamadas}</td>
                <td className="py-2 text-right">
                  {l.won ? (
                    <span className="font-semibold text-emerald-700">{money(l.net, currency)}</span>
                  ) : (
                    <span className="text-slate-300">—</span>
                  )}
                </td>
                <td className="py-2 pr-2 text-right text-xs text-slate-400">{shortWhen(l.lastTouch)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Interactive per-advisor table: each row expands to lazy-load (server action)
 *  the leads that advisor worked in the period. */
export function ProductivityTable({
  rows,
  currency,
  hasPrev,
  ctx,
}: {
  rows: AdvisorStatWithDelta[];
  currency: string;
  hasPrev: boolean;
  ctx: DrillContext;
}) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [cache, setCache] = useState<Record<string, LoadState>>({});

  if (!rows.length) return <p className="text-sm text-slate-400">Sin actividad de asesoras en este período.</p>;

  async function toggle(userId: string) {
    if (expanded === userId) {
      setExpanded(null);
      return;
    }
    setExpanded(userId);
    const cur = cache[userId];
    if (cur && cur !== "error") return; // already loaded or loading
    setCache((c) => ({ ...c, [userId]: "loading" }));
    try {
      const leads = await loadAgentLeads({ vendedoraId: userId, ...ctx });
      setCache((c) => ({ ...c, [userId]: leads }));
    } catch {
      setCache((c) => ({ ...c, [userId]: "error" }));
    }
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-slate-200 text-xs text-slate-500">
            <th className="py-2 text-left font-medium">Asesora</th>
            <th className="py-2 text-right font-medium">Llamadas</th>
            <th className="py-2 text-right font-medium">Leads</th>
            <th className="py-2 text-right font-medium">Cerrados</th>
            <th className="py-2 text-right font-medium">% cierre</th>
            <th className="py-2 text-right font-medium">Horas</th>
            <th className="py-2 text-right font-medium">Ingresos</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const open = expanded === r.userId;
            const showDelta = hasPrev && !r.delta.isNew; // hide arrows when there's no baseline
            return (
              <Fragment key={r.userId}>
                <tr
                  onClick={() => toggle(r.userId)}
                  className={cn(
                    "cursor-pointer border-b border-slate-100 last:border-0 hover:bg-slate-50",
                    open && "bg-slate-50",
                  )}
                >
                  <td className="py-2.5 text-left">
                    <span className="mr-1.5 inline-block text-slate-400 transition-transform" aria-hidden>
                      {open ? "▾" : "▸"}
                    </span>
                    <span className="font-medium text-slate-800">{advisorName(r.email)}</span>
                    {hasPrev && r.delta.isNew && (
                      <span className="ml-2 rounded bg-sky-50 px-1.5 py-0.5 text-[11px] font-medium text-sky-600">
                        nuevo
                      </span>
                    )}
                  </td>
                  <td className="py-2.5 text-right text-slate-700">{r.llamadas}</td>
                  <td className="py-2.5 text-right text-slate-700">{r.leadsTrabajados}</td>
                  <td className="py-2.5 text-right text-slate-700">
                    {r.cerrados}
                    {showDelta && <DeltaInline value={r.delta.cerrados} fmt={(n) => String(n)} />}
                  </td>
                  <td className="py-2.5 text-right text-slate-700">
                    {pct(r.conversion)}
                    {showDelta && <DeltaInline value={r.delta.conversionPP} fmt={(n) => `${n}pp`} />}
                  </td>
                  <td className="py-2.5 text-right">
                    <span className="text-slate-700">{r.horas}h</span>
                    {r.dias > 0 && <span className="ml-1 text-xs text-slate-400">· {r.dias}d</span>}
                  </td>
                  <td className="py-2.5 text-right font-semibold text-emerald-700">
                    {money(r.ingresos, currency)}
                    {showDelta && <DeltaInline value={r.delta.ingresos} fmt={(n) => money(n, currency)} />}
                  </td>
                </tr>
                {open && (
                  <tr>
                    <td colSpan={7} className="bg-slate-50/60 p-0">
                      <AgentLeads state={cache[r.userId]} currency={currency} />
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
      <p className="mt-2 text-xs text-slate-400">Toca una asesora para ver los leads que trabajó.</p>
    </div>
  );
}
