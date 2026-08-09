import { cn } from "@/components/ui";
import { IconBot, IconHeadset } from "@/components/icons";
import { formatCurrency, formatPct, type ClosingChannel } from "@/lib/metrics";

/** Una cifra por canal de cierre. Misma forma que `SalesAttribution.channels`. */
export interface ChannelTotals {
  orders: number;
  revenue: number;
}

/** Etiquetas, colores y ORDEN idénticos a components/sales-attribution.tsx. Que
 *  el mismo canal se llame y se pinte igual en las dos pantallas no es estética:
 *  es lo que permite comparar una con otra sin traducir. */
const COLS: {
  key: ClosingChannel;
  title: string;
  sub: string;
  box: string;
  bar: string;
  icon: "bot" | "headset";
}[] = [
  {
    key: "bot",
    title: "Bot",
    sub: "sin toque humano previo",
    box: "bg-slate-100 text-slate-700",
    bar: "bg-slate-400",
    icon: "bot",
  },
  {
    key: "bot_asistido",
    title: "Bot asistido",
    sub: "una asesora gestionó el lead antes",
    box: "bg-violet-50 text-violet-700",
    bar: "bg-violet-500",
    icon: "headset",
  },
  {
    key: "asesora",
    title: "Asesora",
    sub: "cerró desde el dashboard",
    box: "bg-brand-50 text-brand-700",
    bar: "bg-brand-500",
    icon: "headset",
  },
];

function ChannelCol({
  title,
  sub,
  icon,
  box,
  f,
  share,
  currency,
}: {
  title: string;
  sub: string;
  icon: React.ReactNode;
  box: string;
  f: ChannelTotals;
  share: number; // 0..1 de los ingresos
  currency: string;
}) {
  const aov = f.orders ? f.revenue / f.orders : 0;
  return (
    <div className="flex-1">
      <div className="flex items-center gap-2 text-sm font-semibold text-slate-700">
        <span className={cn("flex h-7 w-7 shrink-0 items-center justify-center rounded-lg", box)}>
          {icon}
        </span>
        {title}
      </div>
      <p className="mt-1 text-[11px] leading-tight text-slate-400">{sub}</p>
      <div className={cn("mt-2 rounded-xl px-2 py-2 text-center", box)}>
        <p className="text-base font-semibold">{formatCurrency(f.revenue, currency)}</p>
        <p className="text-[11px] opacity-80">{formatPct(share)} de los ingresos</p>
      </div>
      <dl className="mt-3 space-y-1.5 text-sm">
        <div className="flex items-center justify-between gap-2">
          <dt className="text-slate-500">Pedidos</dt>
          <dd className="font-medium text-slate-900">{f.orders.toLocaleString("es-PE")}</dd>
        </div>
        <div className="flex items-center justify-between gap-2">
          <dt className="text-slate-500">Ticket prom.</dt>
          <dd className="font-medium text-slate-900">{formatCurrency(aov, currency)}</dd>
        </div>
      </dl>
    </div>
  );
}

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
  const totalRevenue = COLS.reduce((s, c) => s + channels[c.key].revenue, 0);
  const totalOrders = COLS.reduce((s, c) => s + channels[c.key].orders, 0);
  const share = (c: ClosingChannel) => (totalRevenue ? channels[c].revenue / totalRevenue : 0);
  return (
    <div>
      <div className="flex items-stretch gap-3">
        {COLS.map((c) => (
          <ChannelCol
            key={c.key}
            title={c.title}
            sub={c.sub}
            icon={
              c.icon === "bot" ? (
                <IconBot className="h-4 w-4" />
              ) : (
                <IconHeadset className="h-4 w-4" />
              )
            }
            box={c.box}
            f={channels[c.key]}
            share={share(c.key)}
            currency={currency}
          />
        ))}
      </div>
      <div className="mt-4">
        <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-slate-100">
          {COLS.map((c) => (
            <div
              key={c.key}
              className={cn("h-full", c.bar)}
              style={{ width: `${Math.round(share(c.key) * 100)}%` }}
            />
          ))}
        </div>
        <div className="mt-2 rounded-xl bg-slate-50 px-4 py-3 text-center">
          <p className="text-xs font-medium text-slate-500">
            Ingresos generados · {totalOrders.toLocaleString("es-PE")} pedidos
          </p>
          <p className="text-2xl font-semibold text-slate-900">
            {formatCurrency(totalRevenue, currency)}
          </p>
        </div>
      </div>
    </div>
  );
}
