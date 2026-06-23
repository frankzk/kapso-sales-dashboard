import { cn } from "@/components/ui";
import { IconBot, IconHeadset } from "@/components/icons";
import { formatPct, type ChannelFunnel } from "@/lib/metrics";

function ChannelCol({
  title,
  icon,
  leadsLabel,
  convLabel,
  accent,
  f,
}: {
  title: string;
  icon: React.ReactNode;
  leadsLabel: string;
  convLabel: string;
  accent: "brand" | "purple";
  f: ChannelFunnel;
}) {
  const box =
    accent === "brand"
      ? "bg-brand-50 text-brand-700"
      : "bg-violet-50 text-violet-700";
  return (
    <div className="flex-1">
      <div className="flex items-center gap-2 text-sm font-semibold text-slate-700">
        <span className={cn("flex h-7 w-7 items-center justify-center rounded-lg", box)}>{icon}</span>
        {title}
      </div>
      <dl className="mt-3 space-y-1.5 text-sm">
        <div className="flex items-center justify-between gap-2">
          <dt className="text-slate-500">{leadsLabel}</dt>
          <dd className="font-medium text-slate-900">{f.leads.toLocaleString("es-PE")}</dd>
        </div>
        <div className="flex items-center justify-between gap-2">
          <dt className="text-slate-500">Pedidos creados</dt>
          <dd className="font-medium text-slate-900">{f.orders.toLocaleString("es-PE")}</dd>
        </div>
      </dl>
      <div className={cn("mt-3 rounded-xl px-3 py-2 text-center", box)}>
        <p className="text-lg font-semibold">{formatPct(f.conversionRate)}</p>
        <p className="text-[11px] opacity-80">{convLabel}</p>
      </div>
    </div>
  );
}

export function BotVsAdvisor({ bot, advisor }: { bot: ChannelFunnel; advisor: ChannelFunnel }) {
  const totalLeads = bot.leads + advisor.leads;
  const totalOrders = bot.orders + advisor.orders;
  const totalConv = totalLeads ? totalOrders / totalLeads : 0;
  return (
    <div>
      <div className="relative flex items-stretch gap-3">
        <ChannelCol
          title="Proceso con BOT"
          icon={<IconBot className="h-4 w-4" />}
          leadsLabel="Leads atendidos"
          convLabel="del total de leads"
          accent="brand"
          f={bot}
        />
        <div className="flex items-center">
          <span className="flex h-8 w-8 items-center justify-center rounded-full border border-slate-200 bg-white text-[11px] font-semibold text-slate-500 shadow-sm">
            VS
          </span>
        </div>
        <ChannelCol
          title="Proceso con Asesores"
          icon={<IconHeadset className="h-4 w-4" />}
          leadsLabel="Leads transferidos"
          convLabel="de transferidos"
          accent="purple"
          f={advisor}
        />
      </div>
      <div className="mt-4 rounded-xl bg-slate-50 px-4 py-3 text-center">
        <p className="text-xs font-medium text-slate-500">Conversión total (leads → pedidos)</p>
        <p className="text-2xl font-semibold text-slate-900">{formatPct(totalConv)}</p>
      </div>
    </div>
  );
}
