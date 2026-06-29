"use client";

import { useState } from "react";
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { CHART } from "@/components/palette";
import type { LeadsInsights } from "@/lib/leads-insights";

const TOOLTIP_STYLE = { borderRadius: 12, border: "1px solid #e2e8f0", fontSize: 12 } as const;
const AXIS_TICK = { fontSize: 11, fill: CHART.slate } as const;

/** "¿Cerramos hoy?" — backlog burndown: real (solid) vs needed pace vs projection. */
function BurndownChart({ data, nowHourLabel }: { data: LeadsInsights["burndown"]; nowHourLabel: string }) {
  return (
    <div className="h-44 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 8, right: 10, left: -8, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={CHART.grid} vertical={false} />
          <XAxis dataKey="h" interval="preserveStartEnd" minTickGap={4} tick={AXIS_TICK} />
          <YAxis tick={AXIS_TICK} width={34} allowDecimals={false} />
          <Tooltip
            contentStyle={TOOLTIP_STYLE}
            formatter={(v, name) => [
              v == null ? "—" : v,
              name === "real" ? "Real" : name === "ritmo" ? "Necesario" : "Proyección",
            ]}
          />
          <ReferenceLine x={nowHourLabel} stroke={CHART.slate} strokeDasharray="4 4" label={{ value: "ahora", fontSize: 10, fill: CHART.slate }} />
          <ReferenceLine y={0} stroke={CHART.green} strokeDasharray="2 2" />
          <Line dataKey="ritmo" stroke={CHART.slate} strokeDasharray="5 4" dot={false} connectNulls isAnimationActive={false} />
          <Line dataKey="proy" stroke={CHART.red} strokeDasharray="5 4" dot={false} connectNulls isAnimationActive={false} />
          <Line dataKey="real" stroke={CHART.brand} strokeWidth={3} dot={false} connectNulls isAnimationActive={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

/** "Flujo y saldo" — bars (entran vs cierran, left axis) + saldo line (right axis). */
function FlowSaldoChart({ data, saldoInicio }: { data: LeadsInsights["trend"]; saldoInicio: number }) {
  return (
    <div className="h-44 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={data} margin={{ top: 8, right: 4, left: -8, bottom: 0 }} barGap={2}>
          <CartesianGrid strokeDasharray="3 3" stroke={CHART.grid} vertical={false} />
          <XAxis dataKey="dia" tick={AXIS_TICK} />
          <YAxis yAxisId="flujo" tick={AXIS_TICK} width={28} allowDecimals={false} />
          <YAxis yAxisId="saldo" orientation="right" tick={{ ...AXIS_TICK, fill: CHART.red }} width={32} allowDecimals={false} />
          <Tooltip
            contentStyle={TOOLTIP_STYLE}
            formatter={(v, name) => [v, name === "entran" ? "Entran" : name === "cierran" ? "Cierran" : "Saldo"]}
          />
          <Legend wrapperStyle={{ fontSize: 11 }} iconSize={9} />
          <ReferenceLine yAxisId="saldo" y={saldoInicio} stroke={CHART.red} strokeDasharray="4 4" strokeOpacity={0.5} />
          <Bar yAxisId="flujo" dataKey="entran" name="Entran" fill="#cbd5e1" radius={[3, 3, 0, 0]} isAnimationActive={false} />
          <Bar yAxisId="flujo" dataKey="cierran" name="Cierran" fill={CHART.brand} radius={[3, 3, 0, 0]} isAnimationActive={false} />
          <Line yAxisId="saldo" dataKey="saldo" name="Saldo" stroke={CHART.red} strokeWidth={2.5} dot={{ r: 3 }} isAnimationActive={false} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

function avatarInitial(name: string): string {
  return (name.trim()[0] ?? "?").toUpperCase();
}

/** Today's per-advisor productivity: contactos (llamadas) + pedidos (cierres). */
function ProductivityToday({ rows }: { rows: LeadsInsights["productivity"] }) {
  if (!rows.length) {
    return <p className="text-xs text-slate-400">Sin actividad de asesoras registrada hoy todavía.</p>;
  }
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
      {rows.map((r) => (
        <div key={r.name} className="flex items-center gap-2.5 rounded-lg border border-slate-200 bg-white px-3 py-2">
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-brand-100 text-xs font-semibold text-brand-700">
            {avatarInitial(r.name)}
          </span>
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-slate-800" title={r.name}>
              {r.name}
            </p>
            <p className="text-xs text-slate-500">
              <span className="font-semibold text-slate-700">{r.contactos}</span> contactos ·{" "}
              <span className="font-semibold text-emerald-700">{r.pedidos}</span> pedidos
            </p>
          </div>
        </div>
      ))}
    </div>
  );
}

function trendInsight(trend: LeadsInsights["trend"]): { text: string; tone: "red" | "green" | "slate" } {
  if (trend.length < 2) return { text: "", tone: "slate" };
  const entran = trend.reduce((s, d) => s + d.entran, 0);
  const cierran = trend.reduce((s, d) => s + d.cierran, 0);
  const gap = Math.round((entran - cierran) / trend.length);
  if (gap >= 1)
    return { text: `Entran ~${gap}/día más de lo que cierras → el backlog crece.`, tone: "red" };
  if (gap <= -1)
    return { text: `Cierras ~${-gap}/día más de lo que entra → el backlog baja.`, tone: "green" };
  return { text: "Entradas y cierres van parejos.", tone: "slate" };
}

const INSIGHT_TONE = { red: "text-red-600", green: "text-emerald-600", slate: "text-slate-400" } as const;

/** Card panel above the Leads filters: burndown + flujo/saldo + productividad. */
export function LeadsInsightsPanel({ data }: { data: LeadsInsights }) {
  const [open, setOpen] = useState(true);
  const landing = [...data.burndown].reverse().find((p) => p.proy != null)?.proy ?? null;
  const insight = trendInsight(data.trend);

  return (
    <section className="rounded-xl border border-slate-200 bg-slate-50/60 p-3 sm:p-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-slate-700">Tablero de hoy</h2>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="rounded-md px-2 py-1 text-xs font-medium text-slate-500 hover:bg-slate-200/60 hover:text-slate-700"
        >
          {open ? "Ocultar" : "Mostrar"}
        </button>
      </div>

      {open && (
        <div className="mt-3 space-y-3">
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            <div className="rounded-xl border border-slate-200 bg-white p-3">
              <p className="text-sm font-semibold text-slate-800">¿Cerramos hoy?</p>
              <p className="mb-1 text-xs text-slate-500">
                Pendientes vs. ritmo para tocar 0 a las {String(data.burndown.at(-1)?.h ?? "20h")}
                {landing != null && landing > 0 ? (
                  <>
                    {" · "}
                    <span className="font-medium text-red-600">al ritmo actual cierras con ~{landing}</span>
                  </>
                ) : (
                  <>
                    {" · "}
                    <span className="font-medium text-emerald-600">vas a ritmo de cerrar a 0</span>
                  </>
                )}
              </p>
              <BurndownChart data={data.burndown} nowHourLabel={data.nowHourLabel} />
            </div>

            <div className="rounded-xl border border-slate-200 bg-white p-3">
              <p className="text-sm font-semibold text-slate-800">Flujo y saldo · 7 días</p>
              <p className={`mb-1 text-xs ${INSIGHT_TONE[insight.tone]}`}>{insight.text || " "}</p>
              <FlowSaldoChart data={data.trend} saldoInicio={data.saldoInicio} />
            </div>
          </div>

          <div className="rounded-xl border border-slate-200 bg-white p-3">
            <p className="mb-2 text-sm font-semibold text-slate-800">
              Productividad de hoy <span className="font-normal text-slate-400">· contactos y pedidos por persona</span>
            </p>
            <ProductivityToday rows={data.productivity} />
          </div>
        </div>
      )}
    </section>
  );
}
