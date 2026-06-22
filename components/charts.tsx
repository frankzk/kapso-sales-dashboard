"use client";

import {
  Area,
  AreaChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

const BRAND = "#2f74ff";
const GREEN = "#10b981";

function shortDate(d: string): string {
  // "2026-06-20" -> "06-20"
  return d.length >= 10 ? d.slice(5) : d;
}

export function RevenueOrdersChart({
  data,
}: {
  data: Array<{ date: string; revenue: number; orders: number }>;
}) {
  return (
    <div className="h-64 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id="rev" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor={BRAND} stopOpacity={0.25} />
              <stop offset="95%" stopColor={BRAND} stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="#eef2f7" />
          <XAxis dataKey="date" tickFormatter={shortDate} tick={{ fontSize: 11, fill: "#94a3b8" }} />
          <YAxis tick={{ fontSize: 11, fill: "#94a3b8" }} width={48} />
          <Tooltip
            labelFormatter={(l) => `Día ${l}`}
            formatter={(value, name) => [
              typeof value === "number" ? value : Number(value),
              name === "revenue" ? "Ingresos" : "Órdenes",
            ]}
            contentStyle={{ borderRadius: 12, border: "1px solid #e2e8f0", fontSize: 12 }}
          />
          <Area
            type="monotone"
            dataKey="revenue"
            stroke={BRAND}
            strokeWidth={2}
            fill="url(#rev)"
            name="revenue"
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

export function ConversionChart({
  data,
}: {
  data: Array<{ date: string; conversionRate: number; conversations: number; orders: number }>;
}) {
  return (
    <div className="h-56 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#eef2f7" />
          <XAxis dataKey="date" tickFormatter={shortDate} tick={{ fontSize: 11, fill: "#94a3b8" }} />
          <YAxis
            tickFormatter={(v: number) => `${Math.round(v * 100)}%`}
            tick={{ fontSize: 11, fill: "#94a3b8" }}
            width={44}
          />
          <Tooltip
            labelFormatter={(l) => `Día ${l}`}
            formatter={(value) => [
              `${((typeof value === "number" ? value : Number(value)) * 100).toFixed(1)}%`,
              "Conversión",
            ]}
            contentStyle={{ borderRadius: 12, border: "1px solid #e2e8f0", fontSize: 12 }}
          />
          <Line type="monotone" dataKey="conversionRate" stroke={GREEN} strokeWidth={2} dot={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
