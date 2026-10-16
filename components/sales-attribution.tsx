"use client";

import { Fragment, useState } from "react";
import {
  attributionDailyTrend,
  formatCurrency,
  type AttributionSource,
  type ClosingChannel,
  type SalesAttribution,
} from "@/lib/metrics";
import { cn } from "@/components/ui";
import { Badge, Banner } from "@/components/ops-ui";
import { Figure, FIGURE_FRAME, pctText } from "@/components/figures";
import { CHANNEL_SHADE, SOURCE_SERIES } from "@/components/palette";
import { StackedDailyBars, dayLabel } from "@/components/charts";
import { IconChevronRight } from "@/components/icons";

// Ventas por fuente y canal de cierre, en el panel de Consolidado: el reparto
// por canal en un marco de cifras, la tabla de fuentes que se abre para auditar
// sus pedidos, el halo del winback y los ingresos por día apilados por fuente.
// Una fuente lleva el mismo color en la tabla, la leyenda y el gráfico.

const CHANNEL_LABEL: Record<ClosingChannel, string> = {
  asesora: "Asesora",
  bot_asistido: "Bot asistido",
  bot: "Bot",
};

/** De menos a más mano humana, el orden de la escala de tinta. */
const CHANNEL_ORDER: ClosingChannel[] = ["bot", "bot_asistido", "asesora"];

function Swatch({ color, round = false }: { color: string; round?: boolean }) {
  return <span aria-hidden className={cn("inline-block size-2.5 shrink-0", round ? "rounded-full" : "rounded-[2px]")} style={{ background: color }} />;
}

/** El reparto de una fuente entre canales: una barra corta con aire entre partes y la cuenta debajo. */
function ChannelSplit({
  byChannel,
  currency,
}: {
  byChannel: Record<ClosingChannel, { orders: number; revenue: number }>;
  currency: string;
}) {
  const total = CHANNEL_ORDER.reduce((s, c) => s + byChannel[c].revenue, 0);
  if (total <= 0) return <span className="text-xs text-ink-500">—</span>;
  const shown = CHANNEL_ORDER.filter((c) => byChannel[c].revenue > 0);
  return (
    <span className="block">
      <span
        role="img"
        aria-label={shown.map((c) => `${CHANNEL_LABEL[c]} ${formatCurrency(byChannel[c].revenue, currency)}`).join(", ")}
        className="flex h-1.5 w-28 gap-0.5 overflow-hidden rounded-full"
      >
        {shown.map((c) => (
          <span key={c} className="h-full first:rounded-l-full last:rounded-r-full" style={{ flex: `${byChannel[c].revenue} 0 0`, background: CHANNEL_SHADE[c] }} />
        ))}
      </span>
      <span className="mt-1 block text-xs leading-4 text-ink-500">
        {CHANNEL_ORDER.filter((c) => byChannel[c].orders > 0)
          .map((c) => `${CHANNEL_LABEL[c]} ${byChannel[c].orders}`)
          .join(" · ")}
      </span>
    </span>
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
    return <p className="text-sm text-ink-500">Sin pedidos en el periodo para atribuir.</p>;
  }

  return (
    <div className="flex flex-col gap-6">
      <section aria-labelledby="atrib-canal">
        <h3 id="atrib-canal" className="text-sm font-semibold text-ink-900">
          Cierre de los pedidos del bot, por etiquetas
        </h3>
        <p className="mt-0.5 text-[13px] text-ink-500">
          Solo los pedidos del bot de Kapso, de menos a más mano humana. No ve las ventas que registran las asesoras: quién cerró
          todas las ventas de la tienda está en «Canal de cierre».
        </p>
        <dl className={cn(FIGURE_FRAME, "mt-3 grid-cols-1 sm:grid-cols-3")}>
          {CHANNEL_ORDER.map((c) => (
            <Figure
              key={c}
              label={
                <span className="inline-flex items-center gap-1.5">
                  <Swatch color={CHANNEL_SHADE[c]} />
                  {CHANNEL_LABEL[c]}
                </span>
              }
              value={formatCurrency(channels[c].revenue, currency)}
              sub={`${channels[c].orders.toLocaleString("es-PE")} ${channels[c].orders === 1 ? "pedido" : "pedidos"}\u00a0· ${pctText(total.revenue ? channels[c].revenue / total.revenue : 0)} de las ventas`}
            />
          ))}
        </dl>
      </section>

      <section aria-labelledby="atrib-fuente">
        <h3 id="atrib-fuente" className="text-sm font-semibold text-ink-900">
          Por fuente
        </h3>
        <p className="mt-0.5 text-[13px] text-ink-500">De dónde vino el cliente. Abre una fuente para ver sus pedidos.</p>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[620px] text-sm">
            <thead>
              <tr className="border-b border-line text-left text-xs font-semibold text-ink-600">
                <th scope="col" className="py-2 pr-3 font-semibold">Fuente</th>
                <th scope="col" className="px-3 py-2 text-right font-semibold">Pedidos</th>
                <th scope="col" className="px-3 py-2 text-right font-semibold">Ingresos</th>
                <th scope="col" className="px-3 py-2 text-right font-semibold">Del total</th>
                <th scope="col" className="py-2 pl-4 font-semibold">Cierre</th>
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
                      className={cn("cursor-pointer border-b border-line align-top transition-colors hover:bg-wash", isOpen && "bg-wash")}
                    >
                      <td className="py-2.5 pr-3">
                        <button
                          type="button"
                          aria-expanded={isOpen}
                          onClick={(e) => {
                            e.stopPropagation();
                            setOpen(isOpen ? null : s.key);
                          }}
                          className="inline-flex min-w-0 items-center gap-2 text-left font-medium text-ink-900"
                        >
                          <IconChevronRight aria-hidden className={cn("size-3.5 shrink-0 text-ink-500 transition-transform", isOpen && "rotate-90")} />
                          <Swatch color={SOURCE_SERIES[s.key] ?? SOURCE_SERIES.sin_atribucion!} round />
                          {s.label}
                        </button>
                        {s.key === "meta_ad" && metaSpend != null && (
                          <span className="mt-1 block pl-[38px]">
                            <Badge>
                              Inversión {formatCurrency(metaSpend, currency)}
                              {"\u00a0· "}ROAS {metaSpend > 0 ? `${(s.revenue / metaSpend).toFixed(1)}×` : "—"}
                            </Badge>
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-ink-700">{s.orders.toLocaleString("es-PE")}</td>
                      <td className="px-3 py-2.5 text-right font-semibold tabular-nums text-ink-900">{formatCurrency(s.revenue, currency)}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-ink-600">{s.pct.toFixed(1)}&nbsp;%</td>
                      <td className="py-2.5 pl-4">
                        <ChannelSplit byChannel={s.byChannel} currency={currency} />
                      </td>
                    </tr>
                    {isOpen && (
                      <tr className="border-b border-line bg-wash">
                        <td colSpan={5} className="px-3 pb-3 pt-1">
                          <div className="max-h-64 overflow-y-auto rounded-md bg-white ring-1 ring-line">
                            <table className="w-full text-xs">
                              <thead className="sticky top-0 bg-white text-left text-ink-600 shadow-[inset_0_-1px_0_var(--color-line)]">
                                <tr>
                                  <th scope="col" className="px-3 py-1.5 font-semibold">Pedido</th>
                                  <th scope="col" className="px-3 py-1.5 font-semibold">Fecha</th>
                                  <th scope="col" className="px-3 py-1.5 text-right font-semibold">Neto</th>
                                  <th scope="col" className="px-3 py-1.5 font-semibold">Cierre</th>
                                  <th scope="col" className="px-3 py-1.5 font-semibold">Cupón</th>
                                </tr>
                              </thead>
                              <tbody>
                                {drill.map((o, i) => (
                                  <tr key={i} className="border-t border-line">
                                    <td className="px-3 py-1.5 font-medium text-ink-900">{o.name ?? "—"}</td>
                                    <td className="px-3 py-1.5 tabular-nums text-ink-600">{o.createdAt ? dayLabel(o.createdAt.slice(0, 10)) : "—"}</td>
                                    <td className="px-3 py-1.5 text-right tabular-nums text-ink-900">{formatCurrency(o.net, currency)}</td>
                                    <td className="px-3 py-1.5 text-ink-600">{CHANNEL_LABEL[o.channel]}</td>
                                    <td className="px-3 py-1.5 text-ink-500">{o.coupons.join(", ") || "—"}</td>
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
              <tr className="font-semibold text-ink-900">
                <td className="py-2.5 pr-3">Total</td>
                <td className="px-3 py-2.5 text-right tabular-nums">{total.orders.toLocaleString("es-PE")}</td>
                <td className="px-3 py-2.5 text-right tabular-nums">{formatCurrency(total.revenue, currency)}</td>
                <td className="px-3 py-2.5 text-right tabular-nums">100&nbsp;%</td>
                <td className="py-2.5 pl-4" />
              </tr>
            </tfoot>
          </table>
        </div>
      </section>

      {/* Winback halo — informational, not added to the winback bucket. */}
      {halo.orders > 0 && (
        <Banner tone="info" title="Efecto halo del winback">
          {halo.orders.toLocaleString("es-PE")} {halo.orders === 1 ? "pedido más" : "pedidos más"} (
          {formatCurrency(halo.revenue, currency)}) de clientes que recibieron la plantilla de recuperación hasta 30 días
          antes pero compraron sin cupón. Se atribuyen a su fuente original, no a recuperación.
        </Banner>
      )}

      {trend.rows.length > 1 && (
        <section aria-labelledby="atrib-dia">
          <h3 id="atrib-dia" className="text-sm font-semibold text-ink-900">
            Ingresos por día y fuente
          </h3>
          <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-600">
            {trend.series.map((s) => (
              <li key={s.key} className="inline-flex items-center gap-1.5">
                <Swatch color={SOURCE_SERIES[s.key] ?? SOURCE_SERIES.sin_atribucion!} />
                {s.label}
              </li>
            ))}
          </ul>
          <div className="mt-3">
            <StackedDailyBars
              rows={trend.rows}
              series={trend.series.map((s) => ({ ...s, color: SOURCE_SERIES[s.key] ?? SOURCE_SERIES.sin_atribucion! }))}
              currency={currency}
            />
          </div>
        </section>
      )}

      <p className="text-xs leading-4 text-ink-500">
        Cada pedido activo se asigna a una fuente y un canal de cierre, así que las columnas suman exactamente los{" "}
        {formatCurrency(total.revenue, currency)} de ventas del periodo, neto de reembolsos.
      </p>
    </div>
  );
}
