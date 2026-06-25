"use client";

import {
  Area,
  AreaChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { CHART } from "@/components/palette";

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
              <stop offset="5%" stopColor={CHART.brand} stopOpacity={0.25} />
              <stop offset="95%" stopColor={CHART.brand} stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke={CHART.grid} />
          <XAxis dataKey="date" tickFormatter={shortDate} tick={{ fontSize: 11, fill: CHART.slate }} />
          <YAxis tick={{ fontSize: 11, fill: CHART.slate }} width={48} />
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
            stroke={CHART.brand}
            strokeWidth={2}
            fill="url(#rev)"
            name="revenue"
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

const TREND_COLORS = [CHART.brand, CHART.green, CHART.orange, CHART.purple, CHART.teal, CHART.slate];

/** Leads per day, one line per Meta ad (top ads + "Otros"). */
export function CampaignTrendChart({
  rows,
  series,
}: {
  rows: Array<Record<string, string | number>>;
  series: { key: string; label: string }[];
}) {
  return (
    <div className="h-64 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={rows} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={CHART.grid} />
          <XAxis dataKey="date" tickFormatter={shortDate} tick={{ fontSize: 11, fill: CHART.slate }} />
          <YAxis tick={{ fontSize: 11, fill: CHART.slate }} width={28} allowDecimals={false} />
          <Tooltip
            labelFormatter={(l) => `Día ${l}`}
            contentStyle={{ borderRadius: 12, border: "1px solid #e2e8f0", fontSize: 12 }}
          />
          <Legend wrapperStyle={{ fontSize: 11 }} iconType="plainline" />
          {series.map((s, i) => (
            <Line
              key={s.key}
              type="monotone"
              dataKey={s.key}
              name={s.label}
              stroke={TREND_COLORS[i % TREND_COLORS.length]}
              strokeWidth={2}
              dot={{ r: 2 }}
            />
          ))}
        </LineChart>
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
          <CartesianGrid strokeDasharray="3 3" stroke={CHART.grid} />
          <XAxis dataKey="date" tickFormatter={shortDate} tick={{ fontSize: 11, fill: CHART.slate }} />
          <YAxis
            tickFormatter={(v: number) => `${Math.round(v * 100)}%`}
            tick={{ fontSize: 11, fill: CHART.slate }}
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
          <Line type="monotone" dataKey="conversionRate" stroke={CHART.green} strokeWidth={2} dot={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

/**
 * Dual-axis trend: conversion % (green, left axis) overlaid with order count
 * (blue, right axis) — the "Tendencia de Conversión y Pedidos" module.
 */
export function ConversionOrdersTrend({
  data,
}: {
  data: Array<{ date: string; conversionRate: number; orders: number }>;
}) {
  return (
    <div className="h-52 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={CHART.grid} />
          <XAxis dataKey="date" tickFormatter={shortDate} tick={{ fontSize: 11, fill: CHART.slate }} />
          <YAxis
            yAxisId="conv"
            tickFormatter={(v: number) => `${Math.round(v * 100)}%`}
            tick={{ fontSize: 11, fill: CHART.slate }}
            width={40}
          />
          <YAxis
            yAxisId="orders"
            orientation="right"
            tick={{ fontSize: 11, fill: CHART.slate }}
            width={32}
            allowDecimals={false}
          />
          <Tooltip
            labelFormatter={(l) => `Día ${l}`}
            formatter={(value, name) =>
              name === "Conversión"
                ? [`${((typeof value === "number" ? value : Number(value)) * 100).toFixed(1)}%`, name]
                : [typeof value === "number" ? value : Number(value), name]
            }
            contentStyle={{ borderRadius: 12, border: "1px solid #e2e8f0", fontSize: 12 }}
          />
          <Legend wrapperStyle={{ fontSize: 12 }} iconType="plainline" />
          <Line
            yAxisId="conv"
            type="monotone"
            dataKey="conversionRate"
            name="Conversión"
            stroke={CHART.green}
            strokeWidth={2}
            dot={false}
          />
          <Line
            yAxisId="orders"
            type="monotone"
            dataKey="orders"
            name="Pedidos"
            stroke={CHART.blue}
            strokeWidth={2}
            dot={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
