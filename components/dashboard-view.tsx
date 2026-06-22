import type {
  ConversationRow,
  DailyRollupRow,
  OrderRow,
  StoreSummary,
} from "@/lib/types";
import Link from "next/link";
import type { DateRange } from "@/lib/access";
import {
  aggregateRollups,
  businessBreakdown,
  comparePeriods,
  dateHourPattern,
  formatCurrency,
  formatPct,
  funnelFineLink,
  rollupSeries,
  topProducts,
} from "@/lib/metrics";
import {
  BarList,
  Card,
  EmptyState,
  Section,
  SimpleTable,
  StatCard,
  type BarItem,
} from "@/components/ui";
import { ConversionChart, RevenueOrdersChart } from "@/components/charts";
import { DashboardControls } from "@/components/controls";

const WEEKDAYS = ["Dom", "Lun", "Mar", "Mié", "Jue", "Vie", "Sáb"];

function pctDelta(cur: number, prev: number): number | null {
  if (prev === 0) return cur === 0 ? 0 : null;
  return Math.round(((cur - prev) / prev) * 10000) / 100;
}

interface OpsPayload {
  capturedAt?: string;
  health?: { status?: string; error?: string | null } | null;
  apiLogs?: {
    total?: number;
    errors?: number;
    errorRate?: number;
    avgLatencyMs?: number | null;
    p95LatencyMs?: number | null;
  } | null;
  activity24h?: { conversations?: number; activeConversations?: number } | null;
}

export function DashboardView({
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
}) {
  const names: Record<string, string> = Object.fromEntries(stores.map((s) => [s.id, s.name]));
  const totals = aggregateRollups(rollups);
  const prev = aggregateRollups(prevRollups);
  const cmp = comparePeriods(
    { ordersCount: totals.ordersCount, revenue: totals.revenue, aov: totals.aov },
    { ordersCount: prev.ordersCount, revenue: prev.revenue, aov: prev.aov },
  );
  const series = rollupSeries(rollups);

  // by-store totals (from rollups, authoritative even beyond the order cap)
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
  const products = topProducts(orders, 8);
  const pattern = singleStore ? dateHourPattern(orders, timezone) : null;

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
    <div className="space-y-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">
            {singleStore ? singleStore.name : "Consolidado"}
          </h1>
          <p className="text-sm text-slate-500">
            {range.from} → {range.to}
            {singleStore ? ` · ${singleStore.shopify_domain}` : ` · ${stores.length} tienda(s)`}
          </p>
          {singleStore && (
            <Link
              href={`/dashboard/${singleStore.id}/settings`}
              className="mt-1 inline-block text-sm text-brand-700 hover:underline"
            >
              Ajustes de la tienda →
            </Link>
          )}
        </div>
        <DashboardControls stores={stores} scope={scope} from={range.from} to={range.to} />
      </div>

      <div className="flex items-center gap-2 text-xs text-slate-500">
        <span>Exportar CSV:</span>
        <a href={`/api/export?kind=orders&${exportBase}`} className="text-brand-700 hover:underline">
          órdenes
        </a>
        <span>·</span>
        <a href={`/api/export?kind=rollups&${exportBase}`} className="text-brand-700 hover:underline">
          rollups
        </a>
      </div>

      {/* KPIs */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Órdenes" value={String(totals.ordersCount)} delta={cmp.ordersDeltaPct} sub="vs. periodo previo" />
        <StatCard label="Ingresos (neto)" value={formatCurrency(totals.revenue, currency)} delta={cmp.revenueDeltaPct} sub="neto de reembolsos/cancelaciones" />
        <StatCard label="Ticket promedio (AOV)" value={formatCurrency(totals.aov, currency)} delta={cmp.aovDeltaPct} />
        <StatCard
          label="Conversión (órdenes/conv.)"
          value={formatPct(totals.conversionRate)}
          delta={pctDelta(totals.conversionRate, prev.conversionRate)}
          sub={`${totals.conversationsCount} conversaciones`}
        />
      </div>

      {/* Family 1 — Ventas */}
      <Section title="Ventas" subtitle="Ingresos y órdenes por día">
        <Card>
          {series.length ? (
            <RevenueOrdersChart data={series.map((s) => ({ date: s.date, revenue: s.revenue, orders: s.orders }))} />
          ) : (
            <p className="text-sm text-slate-400">Sin datos en el rango.</p>
          )}
        </Card>
        {!singleStore && (
          <Card>
            <SimpleTable
              rows={byStore}
              empty="Aún no hay tiendas con datos."
              columns={[
                { key: "name", header: "Tienda", render: (r) => <span className="font-medium text-slate-800">{r.name}</span> },
                { key: "orders", header: "Órdenes", align: "right", render: (r) => r.orders },
                { key: "revenue", header: "Ingresos", align: "right", render: (r) => formatCurrency(r.revenue, currency) },
                { key: "aov", header: "AOV", align: "right", render: (r) => formatCurrency(r.aov, currency) },
                { key: "conv", header: "Conv.", align: "right", render: (r) => formatPct(r.conv) },
              ]}
            />
          </Card>
        )}
      </Section>

      {/* Family 2 — Embudo / conversión */}
      <Section title="Embudo / conversión" subtitle="Conversaciones de WhatsApp (Kapso) → órdenes (Shopify)">
        <div className="grid gap-4 lg:grid-cols-3">
          <Card className="lg:col-span-2">
            {series.length ? (
              <ConversionChart data={series} />
            ) : (
              <p className="text-sm text-slate-400">Sin datos en el rango.</p>
            )}
          </Card>
          <Card>
            <p className="text-xs font-medium text-slate-500">Enlace fino (por kapso_conversation_id)</p>
            <dl className="mt-3 space-y-2 text-sm">
              <Row k="Órdenes con conversación" v={fine.ordersWithConversationId} />
              <Row k="Emparejadas" v={fine.matchedOrders} accent="emerald" />
              <Row k="Conversación no encontrada" v={fine.unmatchedOrders} accent="amber" />
              <Row k="Sin id de conversación" v={fine.orphanOrders} accent="slate" />
            </dl>
          </Card>
        </div>
      </Section>

      {/* Family 3 — Desglose de negocio */}
      <Section title="Desglose de negocio">
        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <div className="grid grid-cols-2 gap-4">
              <Mini label="% con promo" value={formatPct(breakdown.promoPct / 100)} sub={`${breakdown.promoOrders} órdenes · tag promo-whatsapp`} />
              <Mini label="Stock por validar" value={String(breakdown.stockValidarOrders)} sub="órdenes marcadas" />
              <Mini label="Canceladas" value={String(totals.cancelledOrders)} sub="excluidas de ingresos" />
              <Mini label="Reembolsado" value={formatCurrency(totals.refundedAmount, currency)} sub="en órdenes activas" />
            </div>
            <div className="mt-5">
              <p className="mb-2 text-xs font-medium text-slate-500">Modo de envío</p>
              <BarList items={shippingItems} />
            </div>
          </Card>
          <Card>
            <p className="mb-3 text-xs font-medium text-slate-500">Top productos (por unidades)</p>
            <BarList items={productItems} empty="Sin líneas de producto en el rango." />
          </Card>
        </div>
        {pattern && (
          <Card>
            <p className="text-xs font-medium text-slate-500">Patrón fecha / hora ({timezone})</p>
            {pattern.peak ? (
              <p className="mt-1 text-sm text-slate-700">
                Pico: <strong>{WEEKDAYS[pattern.peak.weekday]}</strong> a las{" "}
                <strong>{String(pattern.peak.hour).padStart(2, "0")}:00</strong> ({pattern.peak.count} órdenes)
              </p>
            ) : (
              <p className="mt-1 text-sm text-slate-400">Sin datos.</p>
            )}
            <div className="mt-4 grid gap-6 sm:grid-cols-2">
              <BarList
                items={topHours(pattern.byHour)}
                empty="—"
              />
              <BarList
                items={pattern.byWeekday.map((v, i) => ({ label: WEEKDAYS[i]!, value: v, valueLabel: String(v) }))}
              />
            </div>
          </Card>
        )}
      </Section>

      {/* Family 4 — Operativo Kapso */}
      <Section title="Operativo Kapso" subtitle="Salud del número, errores/latencia (api_logs) y actividad 24h — best-effort">
        {opsStores.length ? (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {opsStores.map((s) => {
              const p = ops[s.id] as OpsPayload | undefined;
              return (
                <Card key={s.id}>
                  <div className="flex items-center justify-between">
                    <span className="font-medium text-slate-800">{s.name}</span>
                    <HealthDot status={p?.health?.status} />
                  </div>
                  {p ? (
                    <dl className="mt-3 space-y-1.5 text-sm">
                      <Row k="Estado" v={p.health?.status ?? "—"} />
                      <Row
                        k="Errores API (24h)"
                        v={p.apiLogs ? `${p.apiLogs.errors ?? 0}/${p.apiLogs.total ?? 0} (${formatPct(p.apiLogs.errorRate ?? 0)})` : "—"}
                      />
                      <Row
                        k="Latencia (avg/p95)"
                        v={
                          p.apiLogs?.avgLatencyMs != null
                            ? `${p.apiLogs.avgLatencyMs} / ${p.apiLogs.p95LatencyMs ?? "—"} ms`
                            : "—"
                        }
                      />
                      <Row
                        k="Conversaciones 24h"
                        v={p.activity24h ? `${p.activity24h.conversations ?? 0} (${p.activity24h.activeConversations ?? 0} activas)` : "—"}
                      />
                    </dl>
                  ) : (
                    <p className="mt-3 text-sm text-slate-400">Sin snapshot aún. Se captura en cada sync.</p>
                  )}
                </Card>
              );
            })}
          </div>
        ) : (
          <EmptyState title="Sin tiendas para mostrar." />
        )}
      </Section>
    </div>
  );
}

function topHours(byHour: number[]): BarItem[] {
  return byHour
    .map((v, h) => ({ label: `${String(h).padStart(2, "0")}:00`, value: v, valueLabel: String(v) }))
    .filter((i) => i.value > 0)
    .sort((a, b) => b.value - a.value)
    .slice(0, 6);
}

function Row({ k, v, accent }: { k: string; v: string | number; accent?: "emerald" | "amber" | "slate" }) {
  const color =
    accent === "emerald" ? "text-emerald-600" : accent === "amber" ? "text-amber-600" : "text-slate-900";
  return (
    <div className="flex items-center justify-between gap-2">
      <dt className="text-slate-500">{k}</dt>
      <dd className={`font-medium ${color}`}>{v}</dd>
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
  return <span className={`inline-block h-2.5 w-2.5 rounded-full ${color}`} title={status ?? "desconocido"} />;
}
