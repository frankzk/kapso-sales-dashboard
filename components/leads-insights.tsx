"use client";

import { useState, type ReactNode } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  LabelList,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { CHART } from "@/components/palette";
import { cn } from "@/components/ui";
import type { LeadsInsights } from "@/lib/leads-insights";
import type { LeadInteractionDateFilter } from "@/lib/leads";

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

/** "Sin llamar · últimos 7 días" — leads en cola sin gestionar (status `nuevo`),
 *  agrupados por la fecha de su última interacción. Una barra por día, con el
 *  número encima — para ver qué día se está quedando gente sin llamar. */
function sameInteractionFilter(
  a: LeadInteractionDateFilter | null,
  b: LeadInteractionDateFilter | null,
): boolean {
  if (!a || !b || a.kind !== b.kind) return a === b;
  if (a.kind === "day" && b.kind === "day") return a.date === b.date;
  return a.kind === "older" && b.kind === "older" && a.before === b.before;
}

function SinLlamarChart({
  data,
  older,
  olderBefore,
  selected,
  onSelect,
}: {
  data: LeadsInsights["sinLlamar"];
  older: number;
  olderBefore: string;
  selected: LeadInteractionDateFilter | null;
  onSelect: (filter: LeadInteractionDateFilter | null) => void;
}) {
  // El bucket "+7d" (más viejos que la ventana, sumados) va primero y en rojo: es
  // la alarma — gente que escribió hace +7 días y sigue sin que nadie la llame.
  const bars = [
    {
      date: null,
      dia: "+7d",
      count: older,
      filter: { kind: "older", before: olderBefore } as LeadInteractionDateFilter,
    },
    ...data.map((d) => ({
      ...d,
      filter: { kind: "day", date: d.date } as LeadInteractionDateFilter,
    })),
  ];

  function activate(bar: (typeof bars)[number]) {
    if (bar.count <= 0) return;
    onSelect(sameInteractionFilter(selected, bar.filter) ? null : bar.filter);
  }
  const selectedInChart = bars.some((bar) => sameInteractionFilter(selected, bar.filter));
  return (
    <div className="h-44 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={bars} margin={{ top: 16, right: 6, left: -8, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={CHART.grid} vertical={false} />
          <XAxis dataKey="dia" interval={0} tick={AXIS_TICK} />
          <YAxis tick={AXIS_TICK} width={28} allowDecimals={false} />
          <Tooltip contentStyle={TOOLTIP_STYLE} cursor={{ fill: "#f8fafc" }} formatter={(v) => [v, "Sin llamar"]} />
          <Bar dataKey="count" name="Sin llamar" radius={[3, 3, 0, 0]} isAnimationActive={false}>
            {bars.map((b) => {
              const active = sameInteractionFilter(selected, b.filter);
              return (
                <Cell
                  key={b.dia}
                  fill={b.dia === "+7d" ? CHART.red : CHART.amber}
                  opacity={selectedInChart && !active ? 0.35 : 1}
                  stroke={active ? CHART.brand : "transparent"}
                  strokeWidth={active ? 2 : 0}
                  cursor={b.count > 0 ? "pointer" : "default"}
                  role={b.count > 0 ? "button" : undefined}
                  tabIndex={b.count > 0 ? 0 : -1}
                  aria-pressed={b.count > 0 ? active : undefined}
                  aria-label={
                    b.count > 0
                      ? `Filtrar ${b.count} leads sin llamar de ${b.dia === "+7d" ? "hace más de 7 días" : b.date}`
                      : undefined
                  }
                  onClick={() => activate(b)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      activate(b);
                    }
                  }}
                />
              );
            })}
            <LabelList dataKey="count" position="top" fontSize={10} fill={CHART.slate} />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

/** "Conversión · últimos 7 días" (equipo) — una barra por día = contactos, con la
 *  parte de abajo rellena = pedidos (cierres) y el % de conversión encima. Muestra
 *  VOLUMEN + TASA juntos: un día de "100% pero 1 contacto" sale como barra chiquita
 *  y no engaña con un % inflado. */
function ConversionChart({ data }: { data: LeadsInsights["conversion"] }) {
  const rows = data.map((d) => {
    const fill = Math.min(d.pedidos, d.contactos); // el verde nunca desborda la barra de contactos
    return {
      dia: d.dia,
      pedidos: fill, // segmento verde (recortado al alto de la barra)
      pedidosReal: d.pedidos, // conteo real (honesto) para el tooltip
      resto: Math.max(0, d.contactos - fill), // relleno gris encima del verde → total = contactos
      contactos: d.contactos,
      pct: d.contactos > 0 ? Math.min(100, Math.round((d.pedidos / d.contactos) * 100)) : null,
    };
  });
  return (
    <div className="h-44 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={rows} margin={{ top: 16, right: 6, left: -8, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={CHART.grid} vertical={false} />
          <XAxis dataKey="dia" interval={0} tick={AXIS_TICK} />
          <YAxis tick={AXIS_TICK} width={28} allowDecimals={false} />
          <Tooltip
            cursor={{ fill: "#f8fafc" }}
            content={({ active, payload, label }) => {
              if (!active || !payload?.length) return null;
              const p = payload[0]!.payload as (typeof rows)[number];
              return (
                <div style={{ ...TOOLTIP_STYLE, background: "#fff", padding: "6px 9px" }}>
                  <div className="font-medium text-slate-700">{label}</div>
                  <div className="text-slate-500">
                    {p.contactos} contactos · <span className="text-emerald-700">{p.pedidosReal} pedidos</span>
                    {p.pct != null ? ` · ${p.pct}%` : ""}
                  </div>
                </div>
              );
            }}
          />
          <Bar dataKey="pedidos" stackId="c" fill={CHART.green} isAnimationActive={false} />
          <Bar dataKey="resto" stackId="c" fill="#e2e8f0" radius={[3, 3, 0, 0]} isAnimationActive={false}>
            <LabelList
              dataKey="pct"
              position="top"
              fontSize={10}
              fill={CHART.slate}
              formatter={(v: unknown) => (v == null || v === "" ? "" : `${v}%`)}
            />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

function avatarInitial(name: string): string {
  return (name.trim()[0] ?? "?").toUpperCase();
}

/** Today's per-advisor productivity: contactos (llamadas) + pedidos (cierres).
 *  El ⓘ junto a "pedidos" lista QUÉ pedidos generó (código #… + fecha): se abre
 *  con hover en desktop y con tap/click se fija (otro tap o clic afuera cierra). */
function ProductivityToday({ rows }: { rows: LeadsInsights["productivity"] }) {
  const [pinned, setPinned] = useState<string | null>(null); // asesora con el detalle fijado
  if (!rows.length) {
    return <p className="text-xs text-slate-400">Sin actividad de asesoras registrada hoy todavía.</p>;
  }
  return (
    <div className="space-y-2.5">
      {rows.map((r) => {
        const conv = r.contactos > 0 ? Math.round((r.pedidos / r.contactos) * 100) : null;
        return (
          <div key={r.name} className="flex items-center gap-2">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand-100 text-[10px] font-semibold text-brand-700">
              {avatarInitial(r.name)}
            </span>
            <div className="min-w-0 flex-1 leading-tight">
              <div className="flex items-baseline justify-between gap-2">
                <span className="truncate text-xs font-medium text-slate-800" title={r.name}>
                  {r.name}
                </span>
                <span
                  className="shrink-0 text-xs font-semibold text-slate-700"
                  title={conv != null ? `${r.pedidos} pedidos / ${r.contactos} contactos` : undefined}
                >
                  {conv != null ? `${conv}%` : "—"}
                </span>
              </div>
              {/* barra horizontal de conversión (0–100%) */}
              <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
                <div className="h-full rounded-full bg-emerald-500" style={{ width: `${conv ?? 0}%` }} />
              </div>
              <p className="mt-0.5 text-[10px] text-slate-400">
                <span className="text-slate-500">{r.contactos}</span> contactos ·{" "}
                <span className="text-emerald-700">{r.pedidos}</span> pedidos
                {r.pedidosDetalle.length > 0 && (
                  <span className="group relative inline-block">
                    <button
                      type="button"
                      aria-label={`Ver los pedidos de ${r.name}`}
                      onClick={() => setPinned((v) => (v === r.name ? null : r.name))}
                      onBlur={() => setPinned((v) => (v === r.name ? null : v))}
                      className="ml-1 inline-flex h-3.5 w-3.5 -translate-y-px items-center justify-center rounded-full border border-slate-300 text-[9px] font-semibold text-slate-400 hover:border-slate-400 hover:text-slate-600"
                    >
                      i
                    </button>
                    <span
                      className={cn(
                        "absolute right-0 top-full z-20 mt-1 max-h-44 w-max min-w-[9rem] overflow-y-auto rounded-lg border border-slate-200 bg-white p-2 text-left shadow-lg",
                        pinned === r.name ? "block" : "hidden group-hover:block",
                      )}
                    >
                      {r.pedidosDetalle.map((o, i) => (
                        <span key={i} className="flex items-baseline justify-between gap-3 py-px">
                          <span className="text-[11px] font-medium text-slate-800">{o.code ?? "Sin código aún"}</span>
                          {o.fecha && <span className="text-[10px] text-slate-400">{o.fecha}</span>}
                        </span>
                      ))}
                    </span>
                  </span>
                )}
              </p>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** Card panel above the Leads filters: burndown + sin llamar + productividad.
 *  `titleSlot` (the page "Leads" title) heads the panel; `actionsSlot` (e.g. the
 *  store selector) sits with the show/hide toggle. */
export function LeadsInsightsPanel({
  data,
  titleSlot,
  actionsSlot,
  interactionDateFilter,
  onInteractionDateFilterChange,
}: {
  data: LeadsInsights | null;
  titleSlot?: ReactNode;
  actionsSlot?: ReactNode;
  interactionDateFilter: LeadInteractionDateFilter | null;
  onInteractionDateFilterChange: (filter: LeadInteractionDateFilter | null) => void;
}) {
  const [open, setOpen] = useState(true);
  const landing = data ? ([...data.burndown].reverse().find((p) => p.proy != null)?.proy ?? null) : null;

  return (
    <section className="rounded-xl border border-slate-200 bg-slate-50/60 p-3 sm:p-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          {titleSlot ?? <h2 className="text-sm font-semibold text-slate-700">Tablero de hoy</h2>}
        </div>
        <div className="flex items-center gap-2">
          {actionsSlot}
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="shrink-0 rounded-md px-2 py-1 text-xs font-medium text-slate-500 hover:bg-slate-200/60 hover:text-slate-700"
          >
            {open ? "Ocultar tablero" : "Mostrar tablero"}
          </button>
        </div>
      </div>

      {open && !data && (
        <div
          className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4"
          aria-label="Cargando tablero"
          aria-busy="true"
        >
          {Array.from({ length: 4 }, (_, index) => (
            <div key={index} className="h-[250px] rounded-xl border border-slate-200 bg-white p-3">
              <div className="h-4 w-32 animate-pulse rounded bg-slate-200 motion-reduce:animate-none" />
              <div className="mt-2 h-3 w-4/5 animate-pulse rounded bg-slate-100 motion-reduce:animate-none" />
              <div className="mt-8 h-36 animate-pulse rounded-lg bg-slate-100 motion-reduce:animate-none" />
            </div>
          ))}
        </div>
      )}

      {open && data && (
        <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
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
              <p className="text-sm font-semibold text-slate-800">Sin llamar · últimos 7 días</p>
              <p className="mb-1 text-xs text-slate-500">
                Por última interacción ·{" "}
                <span className="font-medium text-slate-700">{data.sinLlamarTotal} en total</span> ·{" "}
                <span className="text-red-600">barra roja = +7 días</span> · toca una barra para filtrar
              </p>
              <SinLlamarChart
                data={data.sinLlamar}
                older={data.sinLlamarOlder}
                olderBefore={data.sinLlamarOlderBefore}
                selected={interactionDateFilter}
                onSelect={onInteractionDateFilterChange}
              />
            </div>

            <div className="rounded-xl border border-slate-200 bg-white p-3">
              <p className="text-sm font-semibold text-slate-800">Conversión · últimos 7 días</p>
              <p className="mb-1 text-xs text-slate-500">
                Del equipo · barra = <span className="font-medium text-slate-700">contactos</span>, relleno ={" "}
                <span className="font-medium text-emerald-700">pedidos</span> · % encima
              </p>
              <ConversionChart data={data.conversion} />
            </div>

          <div className="rounded-xl border border-slate-200 bg-white p-3">
            <p className="mb-2 text-sm font-semibold text-slate-800">
              Productividad de hoy <span className="font-normal text-slate-400">· por persona</span>
            </p>
            <ProductivityToday rows={data.productivity} />
          </div>
        </div>
      )}
    </section>
  );
}
