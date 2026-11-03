"use client";

// Los gráficos de los paneles de Consolidado (DESIGN.md › Consolidado). Un eje
// por gráfico: dos medidas de escala distinta van en dos gráficos uno debajo
// del otro, nunca en un eje doble. Rejilla de hairlines sólidas, barras de 24
// px como mucho con el extremo de datos redondeado, tooltip con el valor
// primero y la serie en el color de la paleta validada (components/palette.ts).
// Cada gráfico lleva su tabla al lado en el panel.

import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { trendColor, VIZ } from "@/components/palette";

export type ValueKind = "money" | "count" | "pct";

export function formatValue(v: number, kind: ValueKind, currency = "PEN"): string {
  if (kind === "money") {
    return new Intl.NumberFormat("es-PE", { style: "currency", currency, maximumFractionDigits: 0 }).format(v);
  }
  if (kind === "pct") return `${(v * 100).toLocaleString("es-PE", { maximumFractionDigits: 1 })}\u00a0%`;
  return v.toLocaleString("es-PE");
}

const compact = new Intl.NumberFormat("es-PE", { notation: "compact", maximumFractionDigits: 1 });

function axisValue(v: number, kind: ValueKind): string {
  if (kind === "pct") return `${Math.round(v * 100)}\u00a0%`;
  return compact.format(v);
}

/** «5 oct» o, en el tooltip, «dom 5 oct» de un `YYYY-MM-DD` (día de calendario, sin zona). */
export function dayLabel(iso: string, withWeekday = false): string {
  const d = new Date(`${iso}T12:00:00.000Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return d
    .toLocaleDateString("es-PE", {
      ...(withWeekday ? { weekday: "short" } : {}),
      day: "numeric",
      month: "short",
      timeZone: "UTC",
    })
    .replace(/\./g, "")
    .replace(",", "");
}

type TipItem = { name?: string | number; value?: unknown; color?: string; dataKey?: unknown };

function Tip({
  active,
  payload,
  label,
  kind,
  currency,
  sorted = false,
}: {
  active?: boolean;
  payload?: readonly TipItem[];
  label?: unknown;
  kind: ValueKind;
  currency?: string;
  sorted?: boolean;
}) {
  if (!active || !payload?.length) return null;
  const items = sorted ? [...payload].sort((a, b) => Number(b.value) - Number(a.value)) : payload;
  const many = payload.length > 1;
  return (
    <div className="min-w-36 max-w-72 rounded-md bg-white px-3 py-2 text-xs leading-5 shadow-pop">
      <p className="text-ink-500">{dayLabel(String(label), true)}</p>
      {items.map((it) => (
        <p key={String(it.dataKey)} className="flex min-w-0 items-center gap-2">
          {many && <span aria-hidden className="size-2 shrink-0 rounded-[2px]" style={{ background: it.color }} />}
          <span className="shrink-0 font-semibold tabular-nums text-ink-900">
            {formatValue(Number(it.value) || 0, kind, currency)}
          </span>
          <span className="truncate text-ink-600">{String(it.name ?? "")}</span>
        </p>
      ))}
    </div>
  );
}

const TICK = { fontSize: 12, fill: VIZ.ink500 };

function Frame({ height, children }: { height: number; children: React.ReactElement }) {
  return (
    <div className="w-full" style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        {children}
      </ResponsiveContainer>
    </div>
  );
}

/** Una medida por día en columnas (ingresos, pedidos, conversaciones). */
export function DailyBars({
  data,
  kind,
  currency,
  name,
  height = 200,
}: {
  data: { date: string; value: number }[];
  kind: ValueKind;
  currency?: string;
  name: string;
  height?: number;
}) {
  return (
    <Frame height={height}>
      <BarChart data={data} margin={{ top: 8, right: 4, left: 0, bottom: 0 }} barCategoryGap={data.length > 40 ? 1 : 2}>
        <CartesianGrid vertical={false} stroke={VIZ.line} />
        <XAxis
          dataKey="date"
          tickFormatter={(d: string) => dayLabel(d)}
          tick={TICK}
          tickLine={false}
          axisLine={{ stroke: VIZ.lineStrong }}
          minTickGap={24}
        />
        <YAxis
          tickFormatter={(v: number) => axisValue(v, kind)}
          tick={TICK}
          tickLine={false}
          axisLine={false}
          width={52}
          allowDecimals={kind !== "count"}
        />
        <Tooltip cursor={{ fill: VIZ.line, fillOpacity: 0.7 }} content={(p) => <Tip {...p} kind={kind} currency={currency} />} />
        <Bar dataKey="value" name={name} fill={VIZ.brand} radius={[4, 4, 0, 0]} maxBarSize={24} isAnimationActive={false} />
      </BarChart>
    </Frame>
  );
}

/** Una tasa por día (la conversión) en línea, con la cruz del tooltip. */
export function DailyLine({
  data,
  kind,
  name,
  height = 200,
}: {
  data: { date: string; value: number }[];
  kind: ValueKind;
  name: string;
  height?: number;
}) {
  return (
    <Frame height={height}>
      <LineChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
        <CartesianGrid vertical={false} stroke={VIZ.line} />
        <XAxis
          dataKey="date"
          tickFormatter={(d: string) => dayLabel(d)}
          tick={TICK}
          tickLine={false}
          axisLine={{ stroke: VIZ.lineStrong }}
          minTickGap={24}
        />
        <YAxis tickFormatter={(v: number) => axisValue(v, kind)} tick={TICK} tickLine={false} axisLine={false} width={52} />
        <Tooltip cursor={{ stroke: VIZ.ink300, strokeWidth: 1 }} content={(p) => <Tip {...p} kind={kind} />} />
        <Line
          type="linear"
          dataKey="value"
          name={name}
          stroke={VIZ.brand}
          strokeWidth={2}
          dot={data.length <= 14 ? { r: 4, fill: VIZ.brand, stroke: "#fff", strokeWidth: 2 } : false}
          activeDot={{ r: 4, fill: VIZ.brand, stroke: "#fff", strokeWidth: 2 }}
          isAnimationActive={false}
        />
      </LineChart>
    </Frame>
  );
}

/** Leads por día, una línea por anuncio (los cinco primeros y «Otros»). */
export function TrendLines({
  rows,
  series,
  height = 240,
}: {
  rows: Array<Record<string, string | number>>;
  series: { key: string; label: string }[];
  height?: number;
}) {
  return (
    <Frame height={height}>
      <LineChart data={rows} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
        <CartesianGrid vertical={false} stroke={VIZ.line} />
        <XAxis
          dataKey="date"
          tickFormatter={(d: string) => dayLabel(d)}
          tick={TICK}
          tickLine={false}
          axisLine={{ stroke: VIZ.lineStrong }}
          minTickGap={24}
        />
        <YAxis tick={TICK} tickLine={false} axisLine={false} width={36} allowDecimals={false} />
        <Tooltip cursor={{ stroke: VIZ.ink300, strokeWidth: 1 }} content={(p) => <Tip {...p} kind="count" sorted />} />
        {series.map((s, i) => (
          <Line
            key={s.key}
            type="linear"
            dataKey={s.key}
            name={s.label}
            stroke={trendColor(s.key, i)}
            strokeWidth={2}
            dot={false}
            activeDot={{ r: 4, stroke: "#fff", strokeWidth: 2 }}
            isAnimationActive={false}
          />
        ))}
      </LineChart>
    </Frame>
  );
}

/** Una medida por día apilada por serie (fuente, quién cerró…), con aire entre segmentos. */
export function StackedDailyBars({
  rows,
  series,
  currency,
  kind = "money",
  height = 240,
}: {
  rows: Array<Record<string, string | number>>;
  series: { key: string; label: string; color: string }[];
  currency?: string;
  /** Dinero por defecto; «count» para pedidos. */
  kind?: "money" | "count";
  height?: number;
}) {
  return (
    <Frame height={height}>
      <BarChart data={rows} margin={{ top: 8, right: 4, left: 0, bottom: 0 }} barCategoryGap={rows.length > 40 ? 1 : 2}>
        <CartesianGrid vertical={false} stroke={VIZ.line} />
        <XAxis
          dataKey="date"
          tickFormatter={(d: string) => dayLabel(d)}
          tick={TICK}
          tickLine={false}
          axisLine={{ stroke: VIZ.lineStrong }}
          minTickGap={24}
        />
        <YAxis
          tickFormatter={(v: number) => axisValue(v, kind)}
          allowDecimals={kind !== "count"}
          tick={TICK}
          tickLine={false}
          axisLine={false}
          width={52}
        />
        <Tooltip cursor={{ fill: VIZ.line, fillOpacity: 0.7 }} content={(p) => <Tip {...p} kind={kind} currency={currency} sorted />} />
        {series.map((s, i) => (
          <Bar
            key={s.key}
            dataKey={s.key}
            name={s.label}
            stackId="pila"
            fill={s.color}
            stroke="#fff"
            strokeWidth={1}
            maxBarSize={24}
            radius={i === series.length - 1 ? [4, 4, 0, 0] : 0}
            isAnimationActive={false}
          />
        ))}
      </BarChart>
    </Frame>
  );
}
