import { cn } from "@/components/ui";
import { Figure, FIGURE_FRAME, pctText } from "@/components/figures";
import { CHANNEL_SHADE } from "@/components/palette";
import { formatCurrency, type ClosingChannel } from "@/lib/metrics";

/** Una cifra por canal de cierre. Misma forma que `SalesAttribution.channels`. */
export interface ChannelTotals {
  orders: number;
  revenue: number;
}

/** Etiquetas, colores y ORDEN idénticos a components/sales-attribution.tsx. Que
 *  el mismo canal se llame y se pinte igual en las dos pantallas no es estética:
 *  es lo que permite comparar una con otra sin traducir. */
export const CHANNEL_COLS: { key: ClosingChannel; title: string; sub: string }[] = [
  { key: "bot", title: "Bot", sub: "sin toque humano previo" },
  { key: "bot_asistido", title: "Bot asistido", sub: "una asesora gestionó el lead antes" },
  { key: "asesora", title: "Asesora", sub: "cerró desde el dashboard" },
];

/**
 * Ventas por canal de cierre: cuánto generó cada lado.
 *
 * Son TRES canales y no dos. La versión anterior repartía por la etiqueta del
 * pedido (`venta_manual` / `carrito_recuperado`) y mandaba a BOT todo lo demás,
 * así que una asesora que convencía al cliente por teléfono y dejaba que el
 * checkout lo hiciera el bot contaba como venta del bot. Con 12.667 gestiones en
 * 30 días, eso daba «los asesores generaron el 0.2 % de los ingresos», que no
 * describía nada real — y contradecía al módulo «Ventas por fuente y cierre» de
 * la misma aplicación, que ya usaba estos tres canales.
 *
 * `bot_asistido` es deliberadamente su propia columna y no se suma a la asesora:
 * asistir no es cerrar, y fundirlos exageraría en el sentido contrario.
 */
export function BotVsAdvisor({
  channels,
  currency,
}: {
  channels: Record<ClosingChannel, ChannelTotals>;
  currency: string;
}) {
  const totalRevenue = CHANNEL_COLS.reduce((s, c) => s + channels[c.key].revenue, 0);
  const totalOrders = CHANNEL_COLS.reduce((s, c) => s + channels[c.key].orders, 0);
  const share = (c: ClosingChannel) => (totalRevenue ? channels[c].revenue / totalRevenue : 0);
  const shown = CHANNEL_COLS.filter((c) => channels[c.key].revenue > 0);
  return (
    <div className="flex flex-col gap-5">
      <dl className={cn(FIGURE_FRAME, "grid-cols-1 sm:grid-cols-3")}>
        {CHANNEL_COLS.map((c) => {
          const f = channels[c.key];
          const aov = f.orders ? f.revenue / f.orders : 0;
          return (
            <Figure
              key={c.key}
              label={
                <span className="inline-flex items-center gap-1.5">
                  <span aria-hidden className="size-2.5 shrink-0 rounded-[2px]" style={{ background: CHANNEL_SHADE[c.key] }} />
                  {c.title}
                </span>
              }
              value={formatCurrency(f.revenue, currency)}
              sub={
                <>
                  {pctText(share(c.key))} de los ingresos{"\u00a0· "}
                  {f.orders.toLocaleString("es-PE")} {f.orders === 1 ? "pedido" : "pedidos"}
                  {"\u00a0· "}ticket {formatCurrency(aov, currency)}
                  <span className="mt-1 block text-ink-500">{c.sub}</span>
                </>
              }
            />
          );
        })}
      </dl>
      <div>
        <div
          role="img"
          aria-label={shown.map((c) => `${c.title} ${pctText(share(c.key))}`).join(", ") || "Sin ingresos"}
          className="flex h-3 w-full gap-0.5 overflow-hidden rounded-full bg-line"
        >
          {shown.map((c) => (
            <span
              key={c.key}
              className="h-full first:rounded-l-full last:rounded-r-full"
              style={{ flex: `${channels[c.key].revenue} 0 0`, background: CHANNEL_SHADE[c.key] }}
            />
          ))}
        </div>
        <p className="mt-2 flex flex-wrap items-baseline justify-between gap-x-4 text-sm text-ink-600">
          <span>Ingresos generados{"\u00a0· "}{totalOrders.toLocaleString("es-PE")} pedidos</span>
          <span className="text-base font-semibold tabular-nums text-ink-900">{formatCurrency(totalRevenue, currency)}</span>
        </p>
      </div>
    </div>
  );
}
