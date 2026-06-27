import { cn } from "@/components/ui";
import { IconBot, IconHeadset } from "@/components/icons";
import { formatCurrency, formatPct, type ChannelFunnel } from "@/lib/metrics";

function ChannelCol({
  title,
  icon,
  accent,
  f,
  share,
  currency,
}: {
  title: string;
  icon: React.ReactNode;
  accent: "brand" | "purple";
  f: ChannelFunnel;
  share: number; // 0..1 of total revenue
  currency: string;
}) {
  const box = accent === "brand" ? "bg-brand-50 text-brand-700" : "bg-violet-50 text-violet-700";
  const aov = f.orders ? f.revenue / f.orders : 0;
  return (
    <div className="flex-1">
      <div className="flex items-center gap-2 text-sm font-semibold text-slate-700">
        <span className={cn("flex h-7 w-7 items-center justify-center rounded-lg", box)}>{icon}</span>
        {title}
      </div>
      <div className={cn("mt-3 rounded-xl px-3 py-2 text-center", box)}>
        <p className="text-lg font-semibold">{formatCurrency(f.revenue, currency)}</p>
        <p className="text-[11px] opacity-80">{formatPct(share)} de los ingresos</p>
      </div>
      <dl className="mt-3 space-y-1.5 text-sm">
        <div className="flex items-center justify-between gap-2">
          <dt className="text-slate-500">Pedidos cerrados</dt>
          <dd className="font-medium text-slate-900">{f.orders.toLocaleString("es-PE")}</dd>
        </div>
        <div className="flex items-center justify-between gap-2">
          <dt className="text-slate-500">Ticket promedio</dt>
          <dd className="font-medium text-slate-900">{formatCurrency(aov, currency)}</dd>
        </div>
      </dl>
    </div>
  );
}

/**
 * Bot-closed vs advisor-closed sales: how much revenue each side generated. A
 * sale is "advisor" when a human closed it through the dashboard; the rest came
 * through the bot / Shopify. Each side shows its revenue, share, order count and
 * average ticket, with a split bar for the revenue mix.
 */
export function BotVsAdvisor({
  bot,
  advisor,
  currency,
}: {
  bot: ChannelFunnel;
  advisor: ChannelFunnel;
  currency: string;
}) {
  const totalRevenue = bot.revenue + advisor.revenue;
  const totalOrders = bot.orders + advisor.orders;
  const botShare = totalRevenue ? bot.revenue / totalRevenue : 0;
  const advisorShare = totalRevenue ? advisor.revenue / totalRevenue : 0;
  return (
    <div>
      <div className="relative flex items-stretch gap-3">
        <ChannelCol
          title="Cerró el BOT"
          icon={<IconBot className="h-4 w-4" />}
          accent="brand"
          f={bot}
          share={botShare}
          currency={currency}
        />
        <div className="flex items-center">
          <span className="flex h-8 w-8 items-center justify-center rounded-full border border-slate-200 bg-white text-[11px] font-semibold text-slate-500 shadow-sm">
            VS
          </span>
        </div>
        <ChannelCol
          title="Cerró un Asesor"
          icon={<IconHeadset className="h-4 w-4" />}
          accent="purple"
          f={advisor}
          share={advisorShare}
          currency={currency}
        />
      </div>
      <div className="mt-4">
        <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-slate-100">
          <div className="h-full bg-brand-500" style={{ width: `${Math.round(botShare * 100)}%` }} />
          <div className="h-full bg-violet-500" style={{ width: `${Math.round(advisorShare * 100)}%` }} />
        </div>
        <div className="mt-2 rounded-xl bg-slate-50 px-4 py-3 text-center">
          <p className="text-xs font-medium text-slate-500">
            Ingresos generados · {totalOrders.toLocaleString("es-PE")} pedidos
          </p>
          <p className="text-2xl font-semibold text-slate-900">{formatCurrency(totalRevenue, currency)}</p>
        </div>
      </div>
    </div>
  );
}
