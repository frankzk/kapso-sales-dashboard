"use client";

import { Fragment, useState } from "react";
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { CHART } from "@/components/palette";
import {
  attributionDailyTrend,
  formatCurrency,
  formatPct,
  type AttributionSource,
  type ClosingChannel,
  type SalesAttribution,
} from "@/lib/metrics";
import { cn } from "@/components/ui";

// One color per source, reused by the table dot and the stacked chart so the
// legend reads the same in both.
const SOURCE_COLOR: Record<AttributionSource, string> = {
  meta_ad: CHART.brand,
  cod_cart: CHART.orange,
  abandoned_browse: CHART.teal,
  winback: CHART.purple,
  organic: CHART.green,
  sin_atribucion: CHART.slate,
};

const CHANNEL_LABEL: Record<ClosingChannel, string> = {
  asesora: "Asesora",
  bot_asistido: "Bot asistido",
  bot: "Bot",
};
const CHANNEL_COLOR: Record<ClosingChannel, string> = {
  asesora: "bg-brand-500",
  bot_asistido: "bg-violet-500",
  bot: "bg-slate-400",
};

function shortDate(d: string): string {
  // "2026-07-05" → "05/07"
  return `${d.slice(8, 10)}/${d.slice(5, 7)}`;
}

/** Compact per-source channel split as a stacked mini-bar + counts. */
function ChannelSplit({
  byChannel,
  currency,
}: {
  byChannel: Record<ClosingChannel, { orders: number; revenue: number }>;
  currency: string;
}) {
  const order: ClosingChannel[] = ["asesora", "bot_asistido", "bot"];
  const total = order.reduce((s, c) => s + byChannel[c].revenue, 0);
  if (total <= 0) return <span className="text-xs text-slate-400">—</span>;
  return (
    <div className="space-y-1">
      <div className="flex h-1.5 w-28 overflow-hidden rounded-full bg-slate-100">
        {order
          .filter((c) => byChannel[c].revenue > 0)
          .map((c) => (
            <div
              key={c}
              className={CHANNEL_COLOR[c]}
              style={{ width: `${(byChannel[c].revenue / total) * 100}%` }}
              title={`${CHANNEL_LABEL[c]}: ${formatCurrency(byChannel[c].revenue, currency)}`}
            />
          ))}
      </div>
      <p className="text-[10px] leading-tight text-slate-400">
        {order
          .filter((c) => byChannel[c].orders > 0)
          .map((c) => `${CHANNEL_LABEL[c]} ${byChannel[c].orders}`)
          .join(" · ")}
      </p>
    </div>
  );
}

/** The order-centric attribution module: source × closing-channel with a
 *  reconciling total, a per-source drill-down (the audit list), a stacked
 *  daily-revenue chart, the winback halo and ROAS on the Meta row. */
export function SalesAttributionModule({
  attribution,
  metaSpend,
  currency,
  timezone,
}: {
  attribution: SalesAttribution;
  metaSpend: number | null;
  currency: string;
  timezone: string;
}) {
  const [open, setOpen] = useState<AttributionSource | null>(null);
  const { sources, channels, total, halo, orders } = attribution;
  const trend = attributionDailyTrend(orders, timezone);

  if (!total.orders) {
    return <p className="text-sm text-slate-400">Sin pedidos en el rango para atribuir.</p>;
  }

  const channelOrder: ClosingChannel[] = ["bot", "bot_asistido", "asesora"];

  return (
    <div className="space-y-5">
      {/* Closing-channel summary strip (marginal totals). */}
      <div className="grid grid-cols-3 gap-3">
        {channelOrder.map((c) => (
          <div key={c} className="rounded-xl border border-slate-200 bg-white p-3">
            <div className="flex items-center gap-1.5">
              <span className={cn("h-2.5 w-2.5 rounded-full", CHANNEL_COLOR[c])} />
              <p className="text-xs font-medium text-slate-500">{CHANNEL_LABEL[c]}</p>
            </div>
            <p className="mt-1 text-lg font-semibold text-slate-900">
              {formatCurrency(channels[c].revenue, currency)}
            </p>
            <p className="text-xs text-slate-400">
              {channels[c].orders} pedido{channels[c].orders === 1 ? "" : "s"} ·{" "}
              {formatPct(total.revenue ? channels[c].revenue / total.revenue : 0)}
            </p>
          </div>
        ))}
      </div>

      {/* Source table with drill-down. */}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-200 text-left text-xs text-slate-400">
              <th className="pb-2 font-medium">Fuente</th>
              <th className="pb-2 text-right font-medium">Pedidos</th>
              <th className="pb-2 text-right font-medium">Ingresos</th>
              <th className="pb-2 text-right font-medium">% del total</th>
              <th className="pb-2 pl-4 font-medium">Cierre</th>
            </tr>
          </thead>
          <tbody>
            {sources.map((s) => {
              const isOpen = open === s.key;
              const drill = isOpen ? orders.filter((o) => o.source === s.key) : [];
              return (
                <Fragment key={s.key}>
                  <tr
                    onClick={() => setOpen(isOpen ? null : s.key)}
                    className="cursor-pointer border-b border-slate-100 hover:bg-slate-50"
                  >
                    <td className="py-2">
                      <div className="flex items-center gap-2">
                        <span className="text-slate-300">{isOpen ? "▾" : "▸"}</span>
                        <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: SOURCE_COLOR[s.key] }} />
                        <span className="font-medium text-slate-800">{s.label}</span>
                        {s.key === "meta_ad" && metaSpend != null && (
                          <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-500">
                            inv. {formatCurrency(metaSpend, currency)} · ROAS{" "}
                            {metaSpend > 0 ? `${(s.revenue / metaSpend).toFixed(1)}x` : "—"}
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="py-2 text-right tabular-nums text-slate-700">{s.orders}</td>
                    <td className="py-2 text-right font-semibold tabular-nums text-emerald-700">
                      {formatCurrency(s.revenue, currency)}
                    </td>
                    <td className="py-2 text-right tabular-nums text-slate-600">{s.pct.toFixed(1)}%</td>
                    <td className="py-2 pl-4">
                      <ChannelSplit byChannel={s.byChannel} currency={currency} />
                    </td>
                  </tr>
                  {isOpen && (
                    <tr className="bg-slate-50/60">
                      <td colSpan={5} className="px-3 py-2">
                        <div className="max-h-60 overflow-y-auto rounded-lg border border-slate-200 bg-white">
                          <table className="w-full text-xs">
                            <thead className="sticky top-0 bg-slate-50 text-left text-[10px] uppercase text-slate-400">
                              <tr>
                                <th className="px-2 py-1 font-medium">Pedido</th>
                                <th className="px-2 py-1 font-medium">Fecha</th>
                                <th className="px-2 py-1 text-right font-medium">Neto</th>
                                <th className="px-2 py-1 font-medium">Cierre</th>
                                <th className="px-2 py-1 font-medium">Cupón</th>
                              </tr>
                            </thead>
                            <tbody>
                              {drill.map((o, i) => (
                                <tr key={i} className="border-t border-slate-100">
                                  <td className="px-2 py-1 font-medium text-slate-700">{o.name ?? "—"}</td>
                                  <td className="px-2 py-1 text-slate-500">
                                    {o.createdAt ? shortDate(o.createdAt.slice(0, 10)) : "—"}
                                  </td>
                                  <td className="px-2 py-1 text-right tabular-nums text-slate-700">
                                    {formatCurrency(o.net, currency)}
                                  </td>
                                  <td className="px-2 py-1 text-slate-500">{CHANNEL_LABEL[o.channel]}</td>
                                  <td className="px-2 py-1 text-slate-400">{o.coupons.join(", ") || "—"}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-slate-200 font-semibold text-slate-800">
              <td className="py-2">Total</td>
              <td className="py-2 text-right tabular-nums">{total.orders}</td>
              <td className="py-2 text-right tabular-nums text-emerald-800">
                {formatCurrency(total.revenue, currency)}
              </td>
              <td className="py-2 text-right tabular-nums">100%</td>
              <td className="py-2" />
            </tr>
          </tfoot>
        </table>
      </div>

      {/* Winback halo — informational, not added to the winback bucket. */}
      {halo.orders > 0 && (
        <p className="rounded-lg bg-violet-50 px-3 py-2 text-xs text-violet-700">
          🔁 Efecto halo del winback: <strong>{halo.orders}</strong> pedido
          {halo.orders === 1 ? "" : "s"} más ({formatCurrency(halo.revenue, currency)}) de clientes que recibieron la
          plantilla de recuperación ≤30 días antes pero compraron <strong>sin cupón</strong> — se atribuyen a su fuente
          original, no a recuperación.
        </p>
      )}

      {/* Stacked daily revenue by source. */}
      {trend.rows.length > 1 && (
        <div>
          <p className="mb-1 text-xs font-medium text-slate-500">Ingresos por día y fuente</p>
          <div className="h-56 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={trend.rows} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke={CHART.grid} vertical={false} />
                <XAxis dataKey="date" tickFormatter={shortDate} tick={{ fontSize: 11, fill: CHART.slate }} />
                <YAxis tick={{ fontSize: 11, fill: CHART.slate }} width={44} />
                <Tooltip
                  labelFormatter={(l) => shortDate(String(l))}
                  formatter={(v, name) => [formatCurrency(Number(v) || 0, currency), name]}
                  contentStyle={{ borderRadius: 12, border: "1px solid #e2e8f0", fontSize: 12 }}
                />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                {trend.series.map((s) => (
                  <Bar key={s.key} dataKey={s.key} name={s.label} stackId="rev" fill={SOURCE_COLOR[s.key]} />
                ))}
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      <p className="text-[11px] text-slate-400">
        Cada pedido activo se asigna a <strong>una</strong> fuente y <strong>un</strong> canal de cierre, así que las
        columnas suman exactamente los {formatCurrency(total.revenue, currency)} de ventas del período (neto de
        reembolsos). Clic en una fuente para ver sus pedidos.
      </p>
    </div>
  );
}
