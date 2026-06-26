import type {
  ConversationRow,
  DailyRollupRow,
  LeadRow,
  OrderRow,
  StoreSummary,
} from "@/lib/types";
import type { DateRange } from "@/lib/access";
import {
  aggregateRollups,
  botVsAdvisor,
  businessBreakdown,
  campaignBreakdown,
  campaignDailyTrend,
  cartRecovery,
  comparePeriods,
  conversationalFunnel,
  dateHourPattern,
  formatCurrency,
  formatDuration,
  formatPct,
  funnelFineLink,
  funnelHealth,
  leadsByWaNumber,
  lossReasons,
  lostRevenueByReason,
  rollupSeries,
  sourceBreakdown,
  topProducts,
  type CartRecoveryStats,
} from "@/lib/metrics";
import type { AdMeta } from "@/lib/meta-ads";
import { waKindLabel, waLabel, type WaNumber } from "@/lib/wa-numbers";
import { BarList, Card, EmptyState, SimpleTable, StatCard, cn, type BarItem } from "@/components/ui";
import { CampaignTable } from "@/components/campaign-table";
import { CampaignTrendChart, ConversionOrdersTrend, RevenueOrdersChart } from "@/components/charts";
import { DashboardControls } from "@/components/controls";
import { HourPattern } from "@/components/hour-pattern";
import { KpiCard } from "@/components/kpi-cards";
import { HorizontalFunnel } from "@/components/funnel-horizontal";
import { LossReasonBars, LostRevenueCards } from "@/components/loss-reasons";
import { FunnelHealth } from "@/components/funnel-health";
import { BotVsAdvisor } from "@/components/bot-vs-advisor";
import {
  IconCart,
  IconClock,
  IconInfo,
  IconMoney,
  IconTrendingUp,
} from "@/components/icons";
import Link from "next/link";
import type { ReactNode } from "react";

function pctDelta(cur: number, prev: number): number | null {
  if (prev === 0) return cur === 0 ? 0 : null;
  return Math.round(((cur - prev) / prev) * 10000) / 100;
}

/** Stacked composition bar for cart outcomes: recuperados / por trabajar / perdidos. */
function CartRecoveryBar({ stats }: { stats: CartRecoveryStats }) {
  const total = Math.max(1, stats.total);
  const seg = [
    { label: "Recuperados", n: stats.recuperados, cls: "bg-emerald-500" },
    { label: "Por trabajar", n: stats.pendientes, cls: "bg-amber-400" },
    { label: "Perdidos", n: stats.perdidos, cls: "bg-slate-300" },
  ];
  return (
    <div className="space-y-1.5">
      <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-slate-100">
        {seg
          .filter((s) => s.n > 0)
          .map((s) => (
            <div
              key={s.label}
              className={s.cls}
              style={{ width: `${(s.n / total) * 100}%` }}
              title={`${s.label}: ${s.n}`}
            />
          ))}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500">
        {seg.map((s) => (
          <span key={s.label} className="inline-flex items-center gap-1.5">
            <span className={cn("inline-block h-2 w-2 rounded-full", s.cls)} />
            {s.label} <span className="font-medium text-slate-700">{s.n}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

interface OpsPayload {
  health?: { status?: string } | null;
  apiLogs?: {
    total?: number;
    errors?: number;
    errorRate?: number;
    avgLatencyMs?: number | null;
    p95LatencyMs?: number | null;
  } | null;
  activity24h?: { conversations?: number; activeConversations?: number } | null;
}

/** Module shell — consistent premium header (title + optional info icon). */
function Module({
  title,
  subtitle,
  info,
  right,
  children,
  className,
}: {
  title: string;
  subtitle?: string;
  info?: boolean;
  right?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Card className={cn("flex flex-col", className)}>
      <div className="mb-3 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="flex items-center gap-1.5 text-sm font-semibold text-slate-800">
            {title}
            {info && <IconInfo className="h-3.5 w-3.5 text-slate-300" />}
          </h3>
          {subtitle && <p className="text-xs text-slate-400">{subtitle}</p>}
        </div>
        {right}
      </div>
      <div className="flex-1">{children}</div>
    </Card>
  );
}

export function ExecutiveDashboard({
  stores,
  scope,
  range,
  rollups,
  prevRollups,
  orders,
  conversations,
  ops,
  currency,
  timezone,
  singleStore,
  leads,
  adNames,
  waNumbers,
}: {
  stores: StoreSummary[];
  scope: "all" | string;
  range: DateRange;
  rollups: DailyRollupRow[];
  prevRollups: DailyRollupRow[];
  orders: OrderRow[];
  conversations: ConversationRow[];
  ops: Record<string, unknown>;
  currency: string;
  timezone: string;
  singleStore?: StoreSummary;
  leads?: LeadRow[];
  adNames?: Record<string, AdMeta>;
  waNumbers?: Record<string, WaNumber>;
}) {
  const names: Record<string, string> = Object.fromEntries(stores.map((s) => [s.id, s.name]));
  const totals = aggregateRollups(rollups);
  const prev = aggregateRollups(prevRollups);
  const cmp = comparePeriods(
    { ordersCount: totals.ordersCount, revenue: totals.revenue, aov: totals.aov },
    { ordersCount: prev.ordersCount, revenue: prev.revenue, aov: prev.aov },
  );
  const series = rollupSeries(rollups);

  // by-store totals (from rollups, authoritative beyond the order cap)
  const storeAgg = new Map<string, { orders: number; revenue: number; conversations: number }>();
  for (const r of rollups) {
    const t = storeAgg.get(r.store_id) ?? { orders: 0, revenue: 0, conversations: 0 };
    t.orders += r.orders_count;
    t.revenue += Number(r.revenue);
    t.conversations += r.conversations_count;
    storeAgg.set(r.store_id, t);
  }
  const byStore = [...storeAgg.entries()]
    .map(([id, t]) => ({
      id,
      name: names[id] ?? id,
      orders: t.orders,
      revenue: t.revenue,
      aov: t.orders ? t.revenue / t.orders : 0,
      conv: t.conversations ? t.orders / t.conversations : 0,
    }))
    .sort((a, b) => b.revenue - a.revenue);

  const fine = funnelFineLink(orders, conversations);
  const breakdown = businessBreakdown(orders);
  const products = topProducts(orders, 6);
  const pattern = singleStore ? dateHourPattern(orders, timezone) : null;

  // Leads-derived (Phase B)
  const leadList = leads ?? [];
  const loss = lossReasons(leadList);
  const lostRev = lostRevenueByReason(loss, totals.aov);
  const channels = botVsAdvisor(leadList);
  const sourceStats = sourceBreakdown(leadList, orders);
  const cartStats = cartRecovery(leadList, orders);
  const campaignStats = campaignBreakdown(leadList, orders, adNames ?? {});
  const campaignTrend = campaignDailyTrend(leadList, adNames ?? {}, timezone);
  const waStats = leadsByWaNumber(leadList, orders);
  const funnelStages = conversationalFunnel({
    conversations,
    leads: leadList,
    orders,
    inboundMessages: totals.inboundMessages || null,
  });
  const health = funnelHealth(funnelStages);

  const hasRt = totals.avgFirstResponseSeconds != null;

  const productItems: BarItem[] = products.map((p) => ({
    label: p.title,
    value: p.quantity,
    valueLabel: `${p.quantity} u · ${formatCurrency(p.revenue, currency)}`,
    sublabel: `${p.orders} órden${p.orders === 1 ? "" : "es"}`,
  }));
  const shippingItems: BarItem[] = [
    { label: "Contraentrega (COD)", value: breakdown.codOrders },
    { label: "Agencia", value: breakdown.agencyOrders },
    { label: "Otro / sin definir", value: breakdown.otherShippingOrders },
  ];

  const opsStores = singleStore ? [singleStore] : stores;
  const exportQs = new URLSearchParams({ from: range.from, to: range.to });
  if (scope !== "all") exportQs.set("storeId", scope);
  const exportBase = exportQs.toString();

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-slate-900">
            {singleStore ? singleStore.name : "Dashboard"}
          </h1>
          <p className="text-sm text-slate-500">
            Resumen ejecutivo de ventas por WhatsApp · {range.from} → {range.to}
            {singleStore ? ` · ${singleStore.shopify_domain}` : ` · ${stores.length} tienda(s)`}
          </p>
          {singleStore && (
            <Link
              href={`/dashboard/${singleStore.id}/settings`}
              className="mt-1 inline-block text-sm font-medium text-brand-700 hover:underline"
            >
              Ajustes de la tienda →
            </Link>
          )}
        </div>
        <DashboardControls stores={stores} scope={scope} from={range.from} to={range.to} />
      </div>

      {/* Row 1 — KPIs */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <KpiCard
          label="Ingresos generados"
          value={formatCurrency(totals.revenue, currency)}
          icon={<IconMoney className="h-5 w-5" />}
          accent="green"
          delta={cmp.revenueDeltaPct}
          sub={`${totals.ordersCount} órdenes`}
        />
        <KpiCard
          label="Conversión general"
          value={formatPct(totals.conversionRate)}
          icon={<IconTrendingUp className="h-5 w-5" />}
          accent="purple"
          delta={pctDelta(totals.conversionRate, prev.conversionRate)}
          sub={`${totals.conversationsCount} conv.`}
        />
        <KpiCard
          label="Ticket promedio"
          value={formatCurrency(totals.aov, currency)}
          icon={<IconCart className="h-5 w-5" />}
          accent="blue"
          delta={cmp.aovDeltaPct}
        />
        <KpiCard
          label="Tiempo de respuesta"
          value={hasRt ? formatDuration(totals.avgFirstResponseSeconds) : "—"}
          icon={<IconClock className="h-5 w-5" />}
          accent="amber"
          muted={!hasRt}
          sub={hasRt ? "primera respuesta promedio" : "se activa con la próxima ingesta"}
        />
      </div>

      {/* Row 2 — Embudo · ¿Por qué no compraron? · Impacto económico */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
        <Module
          title="Embudo de conversión conversacional"
          info
          className="lg:col-span-5"
        >
          <HorizontalFunnel stages={funnelStages} />
        </Module>
        <Module title="¿Por qué NO compraron?" info className="lg:col-span-4">
          <LossReasonBars items={loss.reasons} total={loss.total} />
        </Module>
        <Module
          title="Impacto económico perdido"
          subtitle="estimado: leads sin comprar × ticket promedio"
          info
          className="lg:col-span-3"
        >
          <LostRevenueCards items={lostRev.items} total={lostRev.total} currency={currency} />
        </Module>
      </div>

      {/* Row 2b — Conversión por fuente (campañas Meta vs orgánico). Hidden until
          at least one lead carries an attributed source. */}
      {sourceStats.length > 0 && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
          <Module
            title="Conversión por fuente"
            subtitle="Meta (Click-to-WhatsApp) vs carritos abandonados vs orgánico — atribución separada por canal"
            info
            className="lg:col-span-12"
          >
            <SimpleTable
              rows={sourceStats}
              columns={[
                {
                  key: "label",
                  header: "Fuente",
                  render: (r) => (
                    <span className="font-medium text-slate-800">
                      {r.key === "meta_ad" ? "📣 " : ""}
                      {r.label}
                    </span>
                  ),
                },
                { key: "leads", header: "Leads", align: "right", render: (r) => r.leads },
                { key: "pedidos", header: "Pedidos", align: "right", render: (r) => r.pedidos },
                {
                  key: "conversion",
                  header: "Conversión",
                  align: "right",
                  render: (r) => (
                    <span className="font-semibold text-slate-900">{formatPct(r.conversion)}</span>
                  ),
                },
                {
                  key: "ingresos",
                  header: "Ingresos",
                  align: "right",
                  render: (r) => (
                    <span className="font-semibold text-emerald-700">
                      {formatCurrency(r.ingresos, currency)}
                    </span>
                  ),
                },
              ]}
            />
          </Module>
        </div>
      )}

      {/* Row 2b-bis — Recuperación de carritos abandonados. Hidden until carts exist. */}
      {cartStats && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
          <Module
            title="🛒 Recuperación de carritos"
            subtitle="Carritos abandonados (formulario COD / borradores de Shopify) que se convirtieron en pedido real"
            info
            className="lg:col-span-12"
          >
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                <StatCard
                  label="Carritos del período"
                  value={String(cartStats.total)}
                  sub={`${cartStats.pendientes} por trabajar`}
                />
                <StatCard
                  label="Recuperados"
                  value={`${cartStats.recuperados} · ${formatPct(cartStats.tasaRecuperacion)}`}
                  sub="se volvieron pedido"
                />
                <StatCard
                  label="Ingresos recuperados"
                  value={formatCurrency(cartStats.ingresosRecuperados, currency)}
                  sub={
                    cartStats.recuperados
                      ? `ticket prom. ${formatCurrency(cartStats.ticketPromedio, currency)}`
                      : undefined
                  }
                />
                <StatCard
                  label="Valor en riesgo"
                  value={formatCurrency(cartStats.valorEnRiesgo, currency)}
                  sub="carritos abiertos sin cerrar"
                />
              </div>
              <CartRecoveryBar stats={cartStats} />
            </div>
          </Module>
        </div>
      )}

      {/* Row 2c — Rendimiento por campaña (revenue half of ROAS). Hidden until
          campaign-attributed leads exist. */}
      {campaignStats.length > 0 && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
          <Module
            title="Rendimiento por campaña (Meta)"
            subtitle="Clic en una columna para ordenar · el nombre del anuncio abre Meta Ads Manager · el ROAS se completa al sumar el gasto"
            info
            className="lg:col-span-12"
          >
            <CampaignTable rows={campaignStats} currency={currency} />
          </Module>
        </div>
      )}

      {/* Row 2c-bis — Tendencia por anuncio (leads/día). Hidden until ≥2 días con datos. */}
      {campaignTrend.rows.length > 1 && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
          <Module
            title="Tendencia por anuncio (Meta)"
            subtitle="Leads por día, una línea por anuncio (top 5 + Otros)"
            info
            className="lg:col-span-12"
          >
            <CampaignTrendChart rows={campaignTrend.rows} series={campaignTrend.series} />
          </Module>
        </div>
      )}

      {/* Row 2d — Por número de WhatsApp (API vs Business). Hidden until ≥2 buckets. */}
      {waStats.length > 1 && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
          <Module
            title="Por número de WhatsApp"
            subtitle="Leads, conversión e ingresos según el número por el que escribió el cliente"
            info
            className="lg:col-span-12"
          >
            <SimpleTable
              rows={waStats}
              empty="Sin números atribuidos todavía."
              columns={[
                {
                  key: "label",
                  header: "Número",
                  render: (r) => {
                    if (!r.phoneNumberId)
                      return <span className="text-slate-500">📱 Sin asignar</span>;
                    const n = waNumbers?.[r.phoneNumberId];
                    const kind = waKindLabel(n?.kind ?? null);
                    return (
                      <span className="font-medium text-slate-800">
                        📱 {waLabel(n, r.phoneNumberId)}
                        {kind && <span className="ml-1 font-normal text-slate-400">· {kind}</span>}
                        {n?.displayPhone && (
                          <span className="ml-1 font-normal text-slate-400">· {n.displayPhone}</span>
                        )}
                      </span>
                    );
                  },
                },
                { key: "leads", header: "Leads", align: "right", render: (r) => r.leads },
                { key: "pedidos", header: "Pedidos", align: "right", render: (r) => r.pedidos },
                {
                  key: "conversion",
                  header: "Conversión",
                  align: "right",
                  render: (r) => formatPct(r.conversion),
                },
                {
                  key: "ingresos",
                  header: "Ingresos",
                  align: "right",
                  render: (r) => (
                    <span className="font-semibold text-emerald-700">
                      {formatCurrency(r.ingresos, currency)}
                    </span>
                  ),
                },
              ]}
            />
          </Module>
        </div>
      )}

      {/* Row 3 — Ventas · Resumen por tienda · Integridad de conversión */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
        <Module title="Ventas" subtitle="Ingresos por día" className="lg:col-span-5">
          {series.length ? (
            <RevenueOrdersChart
              data={series.map((s) => ({ date: s.date, revenue: s.revenue, orders: s.orders }))}
            />
          ) : (
            <p className="text-sm text-slate-400">Sin datos en el rango.</p>
          )}
        </Module>
        {singleStore && pattern ? (
          <Module title="Patrón fecha / hora" subtitle={timezone} info className="lg:col-span-4">
            <HourPattern pattern={pattern} />
          </Module>
        ) : (
        <Module
          title="Resumen por tienda"
          className="lg:col-span-4"
          right={
            <a
              href={`/api/export?kind=rollups&${exportBase}`}
              className="text-xs font-medium text-brand-700 hover:underline"
            >
              CSV
            </a>
          }
        >
          <SimpleTable
            rows={byStore}
            empty="Aún no hay tiendas con datos."
            columns={[
              {
                key: "name",
                header: "Tienda",
                render: (r) => <span className="font-medium text-slate-800">{r.name}</span>,
              },
              { key: "orders", header: "Órdenes", align: "right", render: (r) => r.orders },
              {
                key: "revenue",
                header: "Ingresos",
                align: "right",
                render: (r) => formatCurrency(r.revenue, currency),
              },
              {
                key: "aov",
                header: "AOV",
                align: "right",
                render: (r) => formatCurrency(r.aov, currency),
              },
              { key: "conv", header: "Conv.", align: "right", render: (r) => formatPct(r.conv) },
            ]}
          />
        </Module>
        )}
        <Module title="Integridad de conversión" info className="lg:col-span-3">
          <dl className="space-y-2 text-sm">
            <Row k="Órdenes con conversación" v={fine.ordersWithConversationId} />
            <Row k="Emparejadas" v={fine.matchedOrders} accent="emerald" />
            <Row k="Conversación no encontrada" v={fine.unmatchedOrders} accent="amber" />
            <Row k="Sin id de conversación" v={fine.orphanOrders} accent="slate" />
          </dl>
        </Module>
      </div>

      {/* Row 4 — BOT vs Asesores · Tendencia · Salud del embudo */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
        <Module title="Rendimiento: BOT vs Asesores" info className="lg:col-span-5">
          <BotVsAdvisor bot={channels.bot} advisor={channels.advisor} />
        </Module>
        <Module
          title="Tendencia de conversión y pedidos"
          subtitle={`${series.length} día(s)`}
          info
          className="lg:col-span-4"
        >
          {series.length ? (
            <ConversionOrdersTrend
              data={series.map((s) => ({
                date: s.date,
                conversionRate: s.conversionRate,
                orders: s.orders,
              }))}
            />
          ) : (
            <p className="text-sm text-slate-400">Sin datos en el rango.</p>
          )}
        </Module>
        <Module title="Salud del embudo" info className="lg:col-span-3">
          <FunnelHealth stages={health.stages} critical={health.critical} />
        </Module>
      </div>

      {/* Row 5 — Desglose de negocio · Top productos · Salud operativa */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
        <Module title="Desglose de negocio" className="lg:col-span-5">
          <div className="grid grid-cols-2 gap-4">
            <Mini
              label="% con promo"
              value={formatPct(breakdown.promoPct / 100)}
              sub={`${breakdown.promoOrders} órdenes · tag promo-whatsapp`}
            />
            <Mini
              label="Stock por validar"
              value={String(breakdown.stockValidarOrders)}
              sub="órdenes marcadas"
            />
            <Mini
              label="Canceladas"
              value={String(totals.cancelledOrders)}
              sub="excluidas de ingresos"
            />
            <Mini
              label="Reembolsado"
              value={formatCurrency(totals.refundedAmount, currency)}
              sub="en órdenes activas"
            />
          </div>
          <div className="mt-5">
            <p className="mb-2 text-xs font-medium text-slate-500">Modo de envío</p>
            <BarList items={shippingItems} />
          </div>
        </Module>
        <Module title="Top productos (por unidades)" className="lg:col-span-4">
          <BarList items={productItems} empty="Sin líneas de producto en el rango." />
        </Module>
        <Module
          title="Salud operativa"
          subtitle="Kapso · best-effort"
          info
          className="lg:col-span-3"
        >
          {opsStores.length ? (
            <div className="space-y-3">
              {opsStores.map((s) => {
                const p = ops[s.id] as OpsPayload | undefined;
                return (
                  <div key={s.id} className="rounded-xl border border-slate-100 px-3 py-2">
                    <div className="flex items-center justify-between">
                      <span className="truncate text-sm font-medium text-slate-800">{s.name}</span>
                      <HealthDot status={p?.health?.status} />
                    </div>
                    {p ? (
                      <dl className="mt-1.5 space-y-1 text-xs">
                        <Row
                          k="Errores API 24h"
                          v={
                            p.apiLogs
                              ? `${p.apiLogs.errors ?? 0}/${p.apiLogs.total ?? 0}`
                              : "—"
                          }
                          small
                        />
                        <Row
                          k="Latencia avg/p95"
                          v={
                            p.apiLogs?.avgLatencyMs != null
                              ? `${Math.round(p.apiLogs.avgLatencyMs)}/${p.apiLogs.p95LatencyMs ?? "—"} ms`
                              : "—"
                          }
                          small
                        />
                        <Row
                          k="Conversaciones 24h"
                          v={
                            p.activity24h
                              ? `${p.activity24h.conversations ?? 0} (${p.activity24h.activeConversations ?? 0} act.)`
                              : "—"
                          }
                          small
                        />
                      </dl>
                    ) : (
                      <p className="mt-1 text-xs text-slate-400">Sin snapshot aún.</p>
                    )}
                  </div>
                );
              })}
            </div>
          ) : (
            <EmptyState title="Sin tiendas para mostrar." />
          )}
        </Module>
      </div>

      {/* Footer — export */}
      <div className="flex items-center gap-2 pt-1 text-xs text-slate-400">
        <span>Exportar CSV:</span>
        <a href={`/api/export?kind=orders&${exportBase}`} className="text-brand-700 hover:underline">
          órdenes
        </a>
        <span>·</span>
        <a href={`/api/export?kind=rollups&${exportBase}`} className="text-brand-700 hover:underline">
          rollups
        </a>
      </div>
    </div>
  );
}

function Row({
  k,
  v,
  accent,
  small,
}: {
  k: string;
  v: string | number;
  accent?: "emerald" | "amber" | "slate";
  small?: boolean;
}) {
  const color =
    accent === "emerald" ? "text-emerald-600" : accent === "amber" ? "text-amber-600" : "text-slate-900";
  return (
    <div className="flex items-center justify-between gap-2">
      <dt className={cn("text-slate-500", small && "text-xs")}>{k}</dt>
      <dd className={cn("font-medium", color, small && "text-xs")}>{v}</dd>
    </div>
  );
}

function Mini({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div>
      <p className="text-xs font-medium text-slate-500">{label}</p>
      <p className="mt-1 text-xl font-semibold text-slate-900">{value}</p>
      {sub && <p className="text-xs text-slate-400">{sub}</p>}
    </div>
  );
}

function HealthDot({ status }: { status?: string }) {
  const ok = status === "healthy" || status === "ok" || status === "active";
  const warn = status === "degraded" || status === "warning";
  const color = ok ? "bg-emerald-500" : warn ? "bg-amber-500" : status ? "bg-red-500" : "bg-slate-300";
  return (
    <span
      className={cn("inline-block h-2.5 w-2.5 shrink-0 rounded-full", color)}
      title={status ?? "desconocido"}
    />
  );
}
