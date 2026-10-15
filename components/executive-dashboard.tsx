import type { ReactNode } from "react";
import Link from "next/link";
import type {
  ConversationRow,
  DailyRollupRow,
  LeadRow,
  OrderRow,
  StoreSummary,
} from "@/lib/types";
import { defaultRange, previousRange, type DateRange } from "@/lib/access";
import {
  ATTRIBUTION_SOURCE_ORDER,
  aggregateRollups,
  businessBreakdown,
  campaignBreakdown,
  campaignDailyTrend,
  cartRecovery,
  comparePeriods,
  conversationalFunnel,
  dateHourPattern,
  formatCurrency,
  formatDuration,
  funnelFineLink,
  funnelHealth,
  leadsByWaNumber,
  lossReasons,
  lostRevenueByReason,
  rollupSeries,
  topProducts,
  tzParts,
  webNoAtribuido,
  type CampaignStat,
  type SalesAttribution,
} from "@/lib/metrics";
import { prettyAdName, type AdMeta } from "@/lib/meta-ads";
import { fullMonthRange, monthView, recentMonths } from "@/lib/productivity-month";
import { waKindLabel, waLabel, type WaNumber } from "@/lib/wa-numbers";
import { cn } from "@/components/ui";
import { Badge, Banner, type BadgeTone } from "@/components/ops-ui";
import { opsButtonClass } from "@/components/ops-styles";
import { Change, Figure, FIGURE_FRAME, pctText as pct } from "@/components/figures";
import { ConsolidadoFilters, ConsolidadoNav, PendingDim, type PeriodLink } from "@/components/consolidado-filters";
import { ModuleBoard, type ModuleCell, type ModuleGroup } from "@/components/module-board";
import { BarsGlyph, ColumnsGlyph, DotsGlyph, LineGlyph, StackGlyph, type DotTone } from "@/components/dashboard-viz";
import { CHANNEL_SHADE, CLOSING_GROUP_SHADE, SOURCE_SERIES, VIZ, trendColor } from "@/components/palette";
import { DailyBars, DailyLine, SalesAttributionModule, StackedDailyBars, TrendLines } from "@/components/lazy-dashboard-modules";
import { CampaignTable } from "@/components/campaign-table";
import { BotVsAdvisor, CHANNEL_COLS } from "@/components/bot-vs-advisor";
import { ClosingChannels } from "@/components/closing-channels";
import { CLOSING_GROUPS, GROUP_LABEL, type ClosingChannelResult, type ClosingGroupKey } from "@/lib/closing-channel";
import { coverageCopy, noCoverageCopy, type WindowPlan } from "@/lib/sales-coverage";
import {
  CONVERSION_DAYS,
  SOURCE_LABEL,
  salesPeriod,
  sourceNoRateCause,
  type OriginSalesResult,
  type SalesDay,
  type SourceConversionResult,
} from "@/lib/consolidado-origen";
import { SourceConversion } from "@/components/source-conversion";
import { HorizontalFunnel } from "@/components/funnel-horizontal";
import { LossReasonBars, LostRevenueCards, sharePct } from "@/components/loss-reasons";
import { FunnelHealth, HEALTH } from "@/components/funnel-health";
import { HourPattern, WEEKDAYS } from "@/components/hour-pattern";
import { IconDownload } from "@/components/icons";

// Consolidado (DESIGN.md › Consolidado): una pantalla de mando. Arriba la
// operación del MOM (la pone la página, porque es de la organización y no del
// periodo); debajo, el periodo de ventas con sus cifras contra el anterior y
// una rejilla con cada análisis reducido a su cifra y un gráfico de bolsillo.
// El módulo entero se abre en un panel lateral. Los cálculos son los de
// lib/metrics y lib/consolidado-origen: aquí solo se decide cómo se leen.
//
// Qué cuenta qué (MOM §17.4): la cabecera, «Ventas por día», «Por tienda»,
// «Canal de cierre» y «Conversión por fuente» cuentan TODAS las ventas de la
// tienda, por quién las cerró. «Conversión del bot» y los módulos que leen los
// pedidos del bot (`orders`, `daily_rollups`) siguen siendo solo del bot, y lo
// dicen. Sin la migración 0268 la cabecera vuelve a la vista anterior —solo el
// bot— con un aviso, nunca en silencio.

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

const nf = new Intl.NumberFormat("es-PE");
/** El separador de tramos: el «·» va pegado a la palabra de antes con un espacio duro. */
const SEP = "\u00a0· ";

function money(n: number, currency: string): string {
  try {
    return new Intl.NumberFormat("es-PE", { style: "currency", currency, maximumFractionDigits: 0 }).format(n);
  } catch {
    return `${currency} ${Math.round(n)}`;
  }
}

function pctDelta(cur: number, prev: number): number | null {
  if (prev === 0) return cur === 0 ? 0 : null;
  return Math.round(((cur - prev) / prev) * 1000) / 10;
}

// ── Fechas («6 – 12 oct», «lunes 12 de octubre») ─────────────────────────────

function asDate(iso: string): Date {
  return new Date(`${iso}T12:00:00.000Z`);
}

function longDay(iso: string): string {
  const d = asDate(iso);
  const part = (o: Intl.DateTimeFormatOptions) => d.toLocaleDateString("es-PE", { ...o, timeZone: "UTC" }).toLowerCase();
  return `${part({ weekday: "long" })} ${part({ day: "numeric" })} de ${part({ month: "long" })}`;
}

function shortDay(iso: string, withMonth = true): string {
  return asDate(iso)
    .toLocaleDateString("es-PE", withMonth ? { day: "numeric", month: "short", timeZone: "UTC" } : { day: "numeric", timeZone: "UTC" })
    .replace(/\./g, "");
}

function rangeLabel(r: DateRange): string {
  if (r.from === r.to) return longDay(r.from);
  const sameMonth = r.from.slice(0, 7) === r.to.slice(0, 7);
  const sameYear = r.from.slice(0, 4) === r.to.slice(0, 4);
  const to = sameYear ? shortDay(r.to) : `${shortDay(r.to)} ${r.to.slice(0, 4)}`;
  const from = sameYear ? shortDay(r.from, !sameMonth) : `${shortDay(r.from)} ${r.from.slice(0, 4)}`;
  return `${from} – ${to}`;
}

/** Cada día del rango, para que un día sin ventas sea una columna en cero y no un hueco. */
function daysOf(r: DateRange): string[] {
  const out: string[] = [];
  const d = asDate(r.from);
  const end = asDate(r.to).getTime();
  while (d.getTime() <= end && out.length < 400) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

function sameCurrency(a: string | null | undefined, b: string | null | undefined): boolean {
  return !!a && !!b && a.trim().toUpperCase() === b.trim().toUpperCase();
}

/** El ROAS entregado del conjunto, con la misma regla que la tabla de anuncios: solo gasto y ventas en la misma moneda. */
function deliveredRoas(rows: CampaignStat[], currency: string): number | null {
  const matching = rows.filter((r) => sameCurrency(r.metaCurrency, currency) && r.spend > 0 && !r.currencyConflict);
  const spend = matching.reduce((s, r) => s + r.spend, 0);
  if (!spend) return null;
  return matching.reduce((s, r) => s + r.deliveredRevenue, 0) / spend;
}

function healthTone(status?: string): { tone: BadgeTone; dot: DotTone; label: string } {
  if (status === "healthy" || status === "ok" || status === "active") return { tone: "ok", dot: "ok", label: "Sana" };
  if (status === "degraded" || status === "warning") return { tone: "warn", dot: "warn", label: "Degradada" };
  if (status) return { tone: "crit", dot: "crit", label: "Con fallas" };
  return { tone: "neutral", dot: "none", label: "Sin datos" };
}

// ── Piezas de los paneles ────────────────────────────────────────────────────

function PanelSection({ title, help, aside, children }: { title: string; help?: ReactNode; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold leading-5 text-ink-900">{title}</h3>
          {help && <p className="mt-0.5 max-w-[68ch] text-[13px] leading-5 text-ink-500">{help}</p>}
        </div>
        {aside}
      </div>
      {children}
    </section>
  );
}

const TH = "px-3 py-2 text-xs font-semibold text-ink-600";

interface DayPoint {
  date: string;
  orders: number;
  revenue: number;
  conversations: number;
  /** null sin conversaciones ese día. */
  conversionRate: number | null;
}

/**
 * La tabla gemela de los gráficos por día del bot: el más reciente arriba. Sin
 * `currency` no lleva ingresos (la conversión del bot por día no los tiene).
 */
function DayTable({ days, currency, ordersLabel = "Pedidos" }: { days: DayPoint[]; currency?: string; ordersLabel?: string }) {
  return (
    <div className="max-h-80 overflow-y-auto rounded-lg ring-1 ring-line">
      <table className="w-full text-sm">
        <thead className="sticky top-0 bg-white text-left shadow-[inset_0_-1px_0_var(--color-line)]">
          <tr>
            <th scope="col" className={TH}>Día</th>
            <th scope="col" className={cn(TH, "text-right")}>Conversaciones</th>
            <th scope="col" className={cn(TH, "text-right")}>{ordersLabel}</th>
            <th scope="col" className={cn(TH, "text-right")}>Conversión</th>
            {currency && <th scope="col" className={cn(TH, "text-right")}>Ingresos</th>}
          </tr>
        </thead>
        <tbody>
          {[...days].reverse().map((d) => (
            <tr key={d.date} className="border-t border-line first:border-0">
              <td className="whitespace-nowrap px-3 py-2 text-ink-700">{shortDay(d.date)}</td>
              <td className="px-3 py-2 text-right tabular-nums text-ink-600">{nf.format(d.conversations)}</td>
              <td className="px-3 py-2 text-right tabular-nums text-ink-900">{nf.format(d.orders)}</td>
              <td className="px-3 py-2 text-right tabular-nums text-ink-600">{d.conversations && d.conversionRate != null ? pct(d.conversionRate) : "—"}</td>
              {currency && <td className="px-3 py-2 text-right font-semibold tabular-nums text-ink-900">{money(d.revenue, currency)}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** «Día por día» de todas las ventas: los ingresos de cada grupo de cierre en su columna. */
function OriginDayTable({ days, groups, currency }: { days: SalesDay[]; groups: ClosingGroupKey[]; currency: string }) {
  return (
    <div className="max-h-80 overflow-auto rounded-lg ring-1 ring-line">
      <table className="w-full min-w-[560px] text-sm">
        <thead className="sticky top-0 bg-white text-left shadow-[inset_0_-1px_0_var(--color-line)]">
          <tr>
            <th scope="col" className={TH}>Día</th>
            <th scope="col" className={cn(TH, "text-right")}>Pedidos</th>
            {groups.map((g) => (
              <th key={g} scope="col" className={cn(TH, "text-right")}>{GROUP_LABEL[g]}</th>
            ))}
            <th scope="col" className={cn(TH, "text-right")}>Ingresos</th>
          </tr>
        </thead>
        <tbody>
          {[...days].reverse().map((d) => (
            <tr key={d.date} className="border-t border-line first:border-0">
              <td className="whitespace-nowrap px-3 py-2 text-ink-700">{shortDay(d.date)}</td>
              <td className="px-3 py-2 text-right tabular-nums text-ink-900">{nf.format(d.orders)}</td>
              {groups.map((g) => (
                <td key={g} className="px-3 py-2 text-right tabular-nums text-ink-600">{money(d.byGroup[g].revenue, currency)}</td>
              ))}
              <td className="px-3 py-2 text-right font-semibold tabular-nums text-ink-900">{money(d.revenue, currency)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Legend({ items }: { items: { label: string; color: string }[] }) {
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-600">
      {items.map((it) => (
        <li key={it.label} className="inline-flex min-w-0 items-center gap-1.5">
          <span aria-hidden className="size-2.5 shrink-0 rounded-[2px]" style={{ background: it.color }} />
          <span className="truncate">{it.label}</span>
        </li>
      ))}
    </ul>
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
  attribution,
  closing,
  origin,
  sourceConversion,
  metaSpend,
  campaignDeliveries,
  campaignLeads,
  campaignOrders,
  metaAdPerformance,
  webAdOrders,
  metaAdCatalog,
  operations,
  nowIso,
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
  /** OBLIGATORIA a propósito. Era opcional, y el Consolidado simplemente no la
   *  pasaba: caía a un reparto binario por etiqueta que contaba como BOT todo lo
   *  que una asesora había trabajado, y encima se quedaba sin el módulo de
   *  fuente y cierre. Que el tipo lo exija impide que vuelva a pasar en silencio. */
  attribution: SalesAttribution;
  /** Quién cerró TODAS las ventas de la tienda (MOM §17.3, función 0259). Sin
   *  él —o sin la migración— «Canal de cierre» vuelve a la vista anterior, que
   *  solo ve los pedidos del bot, y lo dice. */
  closing?: ClosingChannelResult;
  /** TODAS las ventas por tienda, día y canal (MOM §17.4, función 0268): la
   *  cabecera, «Ventas por día» y «Por tienda». Obligatoria por la misma razón
   *  que `attribution`: sin ella la cabecera volvería a contar solo el bot en
   *  silencio. Sin la migración, la vista anterior con un aviso. */
  origin: OriginSalesResult;
  /** Conversión de cada fuente de leads, cohorte de 7 días (MOM §17.4). */
  sourceConversion: SourceConversionResult;
  metaSpend?: number | null;
  campaignDeliveries?: import("@/lib/types").CampaignDeliveryOutcome[];
  campaignLeads?: LeadRow[];
  campaignOrders?: OrderRow[];
  metaAdPerformance?: import("@/lib/types").MetaAdPerformance[];
  /** Los pedidos del carrito COD de la web, que no llegan por ningún lead.
   *  Sin esto, el panel enseñaba en cero a 32 campañas que sí venden. */
  webAdOrders?: import("@/lib/cod-cart-attribution").WebAdOrder[];
  metaAdCatalog?: import("@/lib/cod-cart-attribution").AnuncioMeta[];
  /** La operación del MOM (excepciones e indicadores), entre la cabecera y el periodo. */
  operations?: ReactNode;
  /** Para la vista previa; por defecto, ahora. */
  nowIso?: string;
}) {
  const names: Record<string, string> = Object.fromEntries(stores.map((s) => [s.id, s.name]));
  // Los cierres diarios del bot (`daily_rollups`): la conversión del bot, la
  // primera respuesta, el embudo y, sin la 0268, la vista anterior de cabecera.
  const totals = aggregateRollups(rollups);
  const prev = aggregateRollups(prevRollups);
  const hasPrev = prevRollups.length > 0;
  const series = rollupSeries(rollups);
  const prevRange = previousRange(range);
  const now = nowIso ?? new Date().toISOString();

  // ── Todas las ventas por origen (MOM §17.4) ────────────────────────────────
  // `period` es null si la 0268 no responde (sin migración, sin cobertura o con
  // error): la cabecera vuelve a los cierres diarios del bot y lo dice.
  const period = origin.status === "ok" ? salesPeriod(origin, rollups, prevRollups, prevRange) : null;
  const fullDay = (iso: string) => `${shortDay(iso)} ${iso.slice(0, 4)}`;
  const storeName = (id: string) => stores.find((s) => s.id === id)?.name ?? "una de las tiendas";
  const subOf = (copy: { sub: string[] } | null) => (copy?.sub.length ? `${SEP}${copy.sub.join(SEP)}` : "");
  const originCopy = origin.status === "ok" ? coverageCopy(origin.plan, storeName, fullDay) : null;
  const originNote =
    origin.status === "sin_migracion"
      ? `Falta aplicar la migración 0268 en la base: mientras tanto ${singleStore ? "estas cifras y «Ventas por día»" : "estas cifras, «Ventas por día» y «Por tienda»"} cuentan solo los pedidos del bot de Kapso.`
      : origin.status === "sin_cobertura"
        ? noCoverageCopy(origin.plan, storeName, fullDay).note
        : origin.status === "error"
          ? `No se pudieron contar todas las ventas (${origin.message}). Mientras tanto estas cifras cuentan solo los pedidos del bot de Kapso.`
          : null;
  // La cabecera: todas las ventas o, en la vista anterior, las del bot. El
  // anterior solo existe si se puede comparar (cada tienda lo contaba entero).
  const head = period
    ? {
        revenue: period.totals.revenue,
        orders: period.totals.orders,
        aov: period.totals.aov,
        cancelled: period.totals.cancelled,
        prev: period.prev ? { revenue: period.prev.revenue, orders: period.prev.orders, aov: period.prev.aov } : null,
      }
    : {
        revenue: totals.revenue,
        orders: totals.ordersCount,
        aov: totals.aov,
        cancelled: totals.cancelledOrders,
        prev: hasPrev ? { revenue: prev.revenue, orders: prev.ordersCount, aov: prev.aov } : null,
      };
  const headCmp = head.prev
    ? comparePeriods(
        { ordersCount: head.orders, revenue: head.revenue, aov: head.aov },
        { ordersCount: head.prev.orders, revenue: head.prev.revenue, aov: head.prev.aov },
      )
    : null;
  /** «del bot» en las etiquetas de la vista anterior; nada cuando cuentan todas las ventas. */
  const of = period ? "" : " del bot";
  // «Conversión del bot»: pedidos que cerró el bot ÷ conversaciones, los dos en
  // la ventana de cada tienda. En la vista anterior, los cierres diarios.
  const bot = period
    ? period.bot
    : {
        orders: totals.ordersCount,
        conversations: totals.conversationsCount,
        rate: totals.conversationsCount ? totals.conversionRate : null,
        prev: hasPrev
          ? { orders: prev.ordersCount, conversations: prev.conversationsCount, rate: prev.conversationsCount ? prev.conversionRate : null }
          : null,
      };
  const botDelta = bot.prev && bot.rate != null && bot.prev.rate != null ? (bot.rate - bot.prev.rate) * 100 : null;
  /** El rango que de verdad cuenta: en una sola tienda recortada, desde su primer día. */
  const countedMeta = (plan: WindowPlan | null) => {
    const w = plan && !plan.multiStore ? plan.windows[0] : undefined;
    return w?.clipped ? `${rangeLabel({ from: w.from, to: w.to })}${SEP}${scopeLabel}` : periodMeta;
  };

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
      conv: t.conversations ? t.orders / t.conversations : null,
    }))
    .sort((a, b) => b.revenue - a.revenue);

  const fine = funnelFineLink(orders, conversations);
  const breakdown = businessBreakdown(orders);
  const products = topProducts(orders, 10);
  const pattern = singleStore ? dateHourPattern(orders, timezone) : null;

  // Leads-derived (Phase B)
  const leadList = leads ?? [];
  const loss = lossReasons(leadList);
  // El ticket de todas las ventas: lo que vale, en promedio, una compra.
  const lostRev = lostRevenueByReason(loss, head.aov);
  // Los canales por etiquetas de los pedidos del bot salen de la MISMA
  // atribución que alimenta el panel de «Fuente». Ya no son el «Canal de
  // cierre» de la tienda (MOM §17.3): solo los usa la vista de respaldo cuando
  // la función 0259 no responde.
  const channels = attribution.channels;
  const cartStats = cartRecovery(leadList, orders);
  const campaignStats = campaignBreakdown(
    campaignLeads ?? leadList,
    campaignOrders ?? orders,
    adNames ?? {},
    campaignDeliveries ?? [],
    metaAdPerformance ?? [],
    webAdOrders ?? [],
    metaAdCatalog ?? [],
  );
  // Lo que el carrito COD vendió y no se pudo colgar de un anuncio concreto. Se
  // enseña para que ese dinero no desaparezca de la tabla sin decir nada.
  const webSuelto = webNoAtribuido(campaignLeads ?? leadList, webAdOrders ?? [], metaAdCatalog ?? []);
  const campaignTrend = campaignDailyTrend(campaignLeads ?? leadList, adNames ?? {}, timezone);
  const waStats = leadsByWaNumber(leadList, orders);
  const funnelStages = conversationalFunnel({
    conversations,
    leads: leadList,
    orders,
    inboundMessages: totals.inboundMessages || null,
  });
  const health = funnelHealth(funnelStages);
  const hasRt = totals.avgFirstResponseSeconds != null;

  const opsStores = singleStore ? [singleStore] : stores;
  const exportQs = new URLSearchParams({ from: range.from, to: range.to });
  if (scope !== "all") exportQs.set("storeId", scope);
  const exportBase = exportQs.toString();

  // ── Periodo: chips, meses y enlaces de tienda ──────────────────────────────
  const basePath = scope === "all" ? "/dashboard" : `/dashboard/${scope}`;
  const hrefFor = (r: DateRange, path = basePath) => `${path}?${new URLSearchParams({ from: r.from, to: r.to })}`;
  const sameRange = (r: DateRange) => r.from === range.from && r.to === range.to;
  // Presets en el día LOCAL de la tienda, como los de Productividad.
  const localDay = (offset: number): DateRange => {
    const d = tzParts(new Date(Date.parse(now) - offset * 86_400_000).toISOString(), timezone).date;
    return { from: d, to: d };
  };
  const presets: { label: string; r: DateRange }[] = [
    { label: "Hoy", r: localDay(0) },
    { label: "Ayer", r: localDay(1) },
    ...[7, 30, 90].map((d) => ({ label: `${d} días`, r: defaultRange(d, timezone, now) })),
  ];
  const periods: PeriodLink[] = presets.map(({ label, r }) => ({ label, href: hrefFor(r), active: sameRange(r) }));
  const months = recentMonths(timezone, now, "2025-01", 12);
  const monthRange = (m: string, i: number) => (i === 0 ? (monthView(m, timezone, now)?.range ?? fullMonthRange(m)) : fullMonthRange(m));
  const monthChips: PeriodLink[] = months.slice(0, 2).map((m, i) => {
    const r = monthRange(m.month, i);
    return { label: i === 0 ? "Este mes" : m.label.split(" ")[0]!, href: hrefFor(r), active: sameRange(r) };
  });
  const otherMonths = months.slice(2).map((m) => ({ month: m.month, label: m.label, href: hrefFor(fullMonthRange(m.month)) }));
  const otherMonth = months.slice(2).find((m) => sameRange(fullMonthRange(m.month)))?.month ?? null;
  const storeLinks = stores.map((s) => ({ value: s.id, label: s.name, href: hrefFor(range, `/dashboard/${s.id}`) }));

  const scopeLabel = singleStore ? singleStore.name : stores.length > 1 ? "todas las tiendas" : (stores[0]?.name ?? "");
  const periodMeta = `${rangeLabel(range)}${SEP}${scopeLabel}`;
  const context = [rangeLabel(range), head.prev ? `comparado con ${prevRange.from === prevRange.to ? "el " : ""}${rangeLabel(prevRange)}` : null]
    .filter(Boolean)
    .join(SEP);
  const storeList = new Intl.ListFormat("es", { type: "conjunction" }).format(stores.map((s) => s.name));

  // ── Los días del periodo (con los vacíos en cero) ──────────────────────────
  // Los del bot salen de los cierres diarios; los de todas las ventas, desde el
  // primer día que cuenta alguna tienda.
  const byDate = new Map(series.map((s) => [s.date, s]));
  const legacyDays: DayPoint[] = daysOf(range).map(
    (date) => byDate.get(date) ?? { date, orders: 0, revenue: 0, conversations: 0, conversionRate: 0 },
  );
  const saleDays: { date: string; orders: number; revenue: number }[] = period ? period.days : legacyDays;
  const botDays: DayPoint[] = period
    ? period.days.map((d) => ({ date: d.date, orders: d.botOrders, revenue: 0, conversations: d.conversations, conversionRate: d.botRate }))
    : legacyDays;
  const nDays = saleDays.length;
  const soldDays = saleDays.filter((d) => d.orders > 0 || d.revenue !== 0);
  const sold = soldDays.length > 0;
  const best = sold ? soldDays.reduce((a, b) => (b.revenue > a.revenue ? b : a)) : null;
  // Los grupos de cierre que vendieron en el periodo, en su orden canónico.
  const shownGroups = period ? CLOSING_GROUPS.filter((g) => period.totals.byGroup[g].orders > 0) : [];
  const groupSeries = shownGroups.map((g) => ({ key: g, label: GROUP_LABEL[g], color: CLOSING_GROUP_SHADE[g] }));
  const groupRows = (pick: (a: { orders: number; revenue: number }) => number) =>
    (period?.days ?? []).map((d) => ({ date: d.date, ...Object.fromEntries(shownGroups.map((g) => [g, pick(d.byGroup[g])])) }));
  const originBanner = originCopy?.title ? (
    <Banner tone="info" role="status" title={originCopy.title}>
      {originCopy.body}
    </Banner>
  ) : null;

  // ── Celdas ─────────────────────────────────────────────────────────────────
  const salesFigures = (
    <dl className={cn(FIGURE_FRAME, "grid-cols-1 shadow-none sm:grid-cols-3")}>
      <Figure label={`Ingresos${of}`} value={money(head.revenue, currency)} delta={headCmp ? <Change pct={headCmp.revenueDeltaPct} /> : undefined} />
      <Figure label={`Pedidos${of}`} value={nf.format(head.orders)} delta={headCmp ? <Change pct={headCmp.ordersDeltaPct} /> : undefined} />
      <Figure label={`Ticket promedio${of}`} value={money(head.aov, currency)} delta={headCmp ? <Change pct={headCmp.aovDeltaPct} /> : undefined} />
    </dl>
  );
  const ventasDia: ModuleCell = {
    id: "ventas-dia",
    title: "Ventas por día",
    figure: money(nDays ? head.revenue / nDays : 0, currency),
    sub: sold
      ? `promedio por día${best && nDays > 1 ? `${SEP}mejor día ${shortDay(best.date)}, ${money(best.revenue, currency)}` : ""}${period ? subOf(originCopy) : `${SEP}solo el bot`}`
      : subOf(originCopy)
        ? `Sin ventas en lo contado${subOf(originCopy)}`
        : `Sin ventas${of} en el periodo`,
    tone: sold ? undefined : "muted",
    glyph:
      nDays > 1 && sold ? (
        <ColumnsGlyph
          values={saleDays.map((d) => d.revenue)}
          highlight={best ? saleDays.findIndex((d) => d.date === best.date) : undefined}
          label={`Ingresos por día; resaltado el mejor día${best ? `, ${shortDay(best.date)}` : ""}`}
        />
      ) : undefined,
    panel: sold
      ? {
          meta: period ? `Todas las ventas${SEP}${countedMeta(origin.status === "ok" ? origin.plan : null)}` : `Pedidos del bot${SEP}${periodMeta}`,
          width: "max-w-[760px]",
          body: (
            <div className="flex flex-col gap-6">
              {originBanner}
              {salesFigures}
              {period ? (
                <>
                  <PanelSection title="Ingresos por día" help="Cada día partido por quién cerró la venta, con la regla de «Canal de cierre».">
                    <Legend items={groupSeries.map((g) => ({ label: g.label, color: g.color }))} />
                    <StackedDailyBars rows={groupRows((a) => a.revenue)} series={groupSeries} currency={currency} kind="money" />
                  </PanelSection>
                  <PanelSection title="Pedidos por día" help="El mismo eje de días; cada medida en su propio gráfico.">
                    <StackedDailyBars rows={groupRows((a) => a.orders)} series={groupSeries} kind="count" height={180} />
                  </PanelSection>
                  <PanelSection title="Día por día">
                    <OriginDayTable days={period.days} groups={shownGroups} currency={currency} />
                  </PanelSection>
                </>
              ) : (
                <>
                  <PanelSection title="Ingresos por día">
                    <DailyBars data={legacyDays.map((d) => ({ date: d.date, value: d.revenue }))} kind="money" currency={currency} name="Ingresos" />
                  </PanelSection>
                  <PanelSection title="Pedidos por día" help="El mismo eje de días; cada medida en su propio gráfico.">
                    <DailyBars data={legacyDays.map((d) => ({ date: d.date, value: d.orders }))} kind="count" name="Pedidos" height={160} />
                  </PanelSection>
                  <PanelSection title="Día por día">
                    <DayTable days={legacyDays} currency={currency} />
                  </PanelSection>
                </>
              )}
            </div>
          ),
        }
      : null,
  };

  const conversion: ModuleCell = {
    id: "conversion",
    title: "Conversión del bot",
    figure: bot.rate != null ? pct(bot.rate) : "—",
    tone: bot.conversations ? undefined : "muted",
    // Numerador y denominador solo de lo que cuenta: si alguna tienda queda
    // fuera o recortada, se dice aquí también.
    sub: bot.conversations
      ? `${nf.format(bot.orders)} pedidos del bot de ${nf.format(bot.conversations)} conversaciones${subOf(originCopy)}`
      : subOf(originCopy)
        ? `Sin conversaciones en lo contado${subOf(originCopy)}`
        : "Sin conversaciones en el periodo",
    glyph:
      botDays.length > 1 && bot.conversations ? (
        <LineGlyph values={botDays.map((d) => d.conversionRate ?? 0)} label="Conversión del bot por día" />
      ) : undefined,
    panel: bot.conversations
      ? {
          meta: period ? countedMeta(origin.status === "ok" ? origin.plan : null) : periodMeta,
          width: "max-w-[760px]",
          body: (
            <div className="flex flex-col gap-6">
              {originBanner}
              <p className="max-w-[68ch] text-[13px] leading-5 text-ink-600">
                {period
                  ? "Los pedidos que cerró el bot de Kapso sobre las conversaciones de los mismos días y tiendas. Lo que cerró una asesora, la web u otro canal no entra: eso está en «Canal de cierre» y, por fuente del lead, en «Conversión por fuente»."
                  : "Los pedidos con la etiqueta de Kapso sobre las conversaciones de cada día, de los cierres diarios: la vista anterior, que también cuenta como del bot la venta que cerró una asesora sobre un pedido del bot."}
              </p>
              <dl className={cn(FIGURE_FRAME, "grid-cols-1 shadow-none sm:grid-cols-3")}>
                <Figure
                  label="Conversión del bot"
                  value={bot.rate != null ? pct(bot.rate) : "—"}
                  delta={bot.prev ? <Change pct={botDelta} unit="pts" /> : undefined}
                />
                <Figure
                  label="Conversaciones"
                  value={nf.format(bot.conversations)}
                  delta={bot.prev ? <Change pct={pctDelta(bot.conversations, bot.prev.conversations)} /> : undefined}
                />
                <Figure
                  label="Pedidos del bot"
                  value={nf.format(bot.orders)}
                  delta={bot.prev ? <Change pct={pctDelta(bot.orders, bot.prev.orders)} /> : undefined}
                />
              </dl>
              <PanelSection title="Conversión por día" help="Pedidos del bot sobre conversaciones de cada día.">
                <DailyLine data={botDays.map((d) => ({ date: d.date, value: d.conversionRate ?? 0 }))} kind="pct" name="Conversión del bot" />
              </PanelSection>
              <PanelSection title="Conversaciones por día">
                <DailyBars data={botDays.map((d) => ({ date: d.date, value: d.conversations }))} kind="count" name="Conversaciones" height={160} />
              </PanelSection>
              <PanelSection title="Día por día">
                <DayTable days={botDays} ordersLabel="Pedidos del bot" currency={period ? undefined : currency} />
              </PanelSection>
            </div>
          ),
        }
      : null,
  };

  // «Por tienda»: todas las ventas de cada tienda en su ventana o, en la vista
  // anterior, los cierres diarios del bot.
  const storeRows = period
    ? period.stores.map((r) => ({
        id: r.storeId,
        name: names[r.storeId] ?? r.storeId,
        orders: r.orders,
        revenue: r.revenue,
        aov: r.aov,
        conv: r.botRate,
        advisorShare: r.revenue ? r.byGroup.humano.revenue / r.revenue : null,
      }))
    : byStore.map((r) => ({ ...r, advisorShare: null as number | null }));
  const topStore = storeRows[0];
  const storeCell: ModuleCell =
    singleStore && pattern
      ? {
          id: "horas",
          title: "Patrón de horas",
          figure: pattern.peak ? `${WEEKDAYS[pattern.peak.weekday]} ${String(pattern.peak.hour).padStart(2, "0")}:00` : "—",
          tone: pattern.peak ? undefined : "muted",
          sub: pattern.peak ? `el pico, con ${nf.format(pattern.peak.count)} órdenes del bot${SEP}${timezone}` : "Sin órdenes del bot en el periodo",
          glyph: pattern.peak ? (
            <ColumnsGlyph
              values={pattern.byHour}
              highlight={pattern.byHour.indexOf(Math.max(...pattern.byHour))}
              label="Órdenes del bot por hora del día; la hora con más resaltada"
            />
          ) : undefined,
          panel: pattern.peak
            ? { meta: `Pedidos del bot${SEP}${periodMeta}${SEP}${timezone}`, width: "max-w-[640px]", body: <HourPattern pattern={pattern} /> }
            : null,
        }
      : {
          id: "tiendas",
          title: "Por tienda",
          figure: sold && topStore && head.revenue ? pct(topStore.revenue / head.revenue, 0) : "—",
          tone: sold && topStore ? undefined : "muted",
          sub:
            sold && topStore
              ? `de los ingresos${of} son de ${topStore.name}${subOf(originCopy)}`
              : subOf(originCopy)
                ? `Sin ventas en lo contado${subOf(originCopy)}`
                : storeRows.length
                  ? `Sin ventas${of} en el periodo`
                  : "Aún no hay tiendas con datos",
          glyph:
            sold && storeRows.length ? (
              <BarsGlyph rows={storeRows.slice(0, 3).map((r) => ({ label: r.name, value: r.revenue, display: money(r.revenue, currency) }))} />
            ) : undefined,
          // Sin ventas, el panel se abre igual si hay algo que decir de la
          // cobertura, como en «Canal de cierre».
          panel: (sold && storeRows.length) || originCopy?.title
            ? {
                meta: period ? `Todas las ventas${SEP}${rangeLabel(range)}` : `Pedidos del bot${SEP}${rangeLabel(range)}`,
                width: "max-w-[760px]",
                body: (
                  <div className="flex flex-col gap-4">
                    {originBanner}
                    <PanelSection
                      title="Resumen por tienda"
                      help={
                        period
                          ? "Todas las ventas de cada tienda desde el día en que cuenta. «De asesora» es la parte de los ingresos que cerró una asesora; la conversión del bot, los pedidos del bot sobre las conversaciones."
                          : "De los cierres diarios del bot de cada tienda; la conversión es pedidos sobre conversaciones."
                      }
                      aside={
                        period ? undefined : (
                          <a href={`/api/export?kind=rollups&${exportBase}`} className={opsButtonClass("secondary", "sm", "pointer-coarse:h-11")}>
                            <IconDownload />
                            CSV
                          </a>
                        )
                      }
                    >
                      <div className="overflow-x-auto">
                        <table className="w-full min-w-[600px] text-sm">
                          <thead>
                            <tr className="border-b border-line text-left">
                              <th scope="col" className={cn(TH, "pl-0")}>Tienda</th>
                              <th scope="col" className={cn(TH, "text-right")}>Pedidos</th>
                              <th scope="col" className={cn(TH, "text-right")}>Ingresos</th>
                              <th scope="col" className={cn(TH, "text-right")}>Ticket</th>
                              {period && <th scope="col" className={cn(TH, "text-right")}>De asesora</th>}
                              <th scope="col" className={cn(TH, "pr-0 text-right")}>{period ? "Conversión del bot" : "Conversión"}</th>
                            </tr>
                          </thead>
                          <tbody>
                            {storeRows.map((r) => (
                              <tr key={r.id} className="border-b border-line">
                                <td className="py-2.5 pr-3">
                                  <span className="block font-medium text-ink-900">{r.name}</span>
                                  <span className="mt-1.5 block h-1 w-full max-w-48 rounded-full bg-line">
                                    <span className="block h-full rounded-full bg-ink-500" style={{ width: `${head.revenue ? Math.max(2, (r.revenue / head.revenue) * 100) : 0}%` }} />
                                  </span>
                                </td>
                                <td className="px-3 py-2.5 text-right tabular-nums text-ink-700">{nf.format(r.orders)}</td>
                                <td className="px-3 py-2.5 text-right font-semibold tabular-nums text-ink-900">{formatCurrency(r.revenue, currency)}</td>
                                <td className="px-3 py-2.5 text-right tabular-nums text-ink-700">{formatCurrency(r.aov, currency)}</td>
                                {period && (
                                  <td className="px-3 py-2.5 text-right tabular-nums text-ink-700">{r.advisorShare != null ? pct(r.advisorShare, 0) : "—"}</td>
                                )}
                                <td className="py-2.5 pl-3 text-right tabular-nums text-ink-700">{r.conv != null ? pct(r.conv) : "—"}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </PanelSection>
                  </div>
                ),
              }
            : null,
        };

  const topProduct = products[0];
  const productos: ModuleCell = {
    id: "productos",
    title: "Productos",
    figure: topProduct ? `${nf.format(topProduct.quantity)} u` : "—",
    tone: topProduct ? undefined : "muted",
    sub: topProduct ? `${topProduct.title}, el más vendido por el bot` : "Sin líneas de producto del bot en el periodo",
    glyph: products.length ? (
      <BarsGlyph rows={products.slice(0, 3).map((p) => ({ label: p.title, value: p.quantity, display: `${nf.format(p.quantity)} u` }))} />
    ) : undefined,
    panel: products.length
      ? {
          meta: `Pedidos del bot${SEP}${periodMeta}`,
          width: "max-w-[720px]",
          body: (
            <PanelSection title={`Los ${products.length} con más unidades`} help="Por SKU, o por título cuando no hay SKU. Las órdenes canceladas no cuentan.">
              <div className="overflow-x-auto">
                <table className="w-full min-w-[520px] text-sm">
                  <thead>
                    <tr className="border-b border-line text-left">
                      <th scope="col" className={cn(TH, "pl-0")}>Producto</th>
                      <th scope="col" className={cn(TH, "text-right")}>Unidades</th>
                      <th scope="col" className={cn(TH, "text-right")}>Órdenes</th>
                      <th scope="col" className={cn(TH, "pr-0 text-right")}>Ingresos</th>
                    </tr>
                  </thead>
                  <tbody>
                    {products.map((p) => (
                      <tr key={p.key} className="border-b border-line">
                        <td className="py-2.5 pr-3">
                          <span className="block text-ink-900">{p.title}</span>
                          <span className="mt-1.5 block h-1 w-full max-w-64 rounded-full bg-line">
                            <span className="block h-full rounded-full bg-ink-500" style={{ width: `${Math.max(2, (p.quantity / (topProduct?.quantity || 1)) * 100)}%` }} />
                          </span>
                        </td>
                        <td className="px-3 py-2.5 text-right font-semibold tabular-nums text-ink-900">{nf.format(p.quantity)}</td>
                        <td className="px-3 py-2.5 text-right tabular-nums text-ink-700">{nf.format(p.orders)}</td>
                        <td className="py-2.5 pl-3 text-right tabular-nums text-ink-700">{formatCurrency(p.revenue, currency)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </PanelSection>
          ),
        }
      : null,
  };

  const topSource = attribution.sources[0];
  const fuente: ModuleCell = {
    id: "fuente",
    title: "Fuente de las ventas",
    figure: topSource ? pct(topSource.pct / 100, 0) : "—",
    tone: topSource ? undefined : "muted",
    sub: topSource ? `de las ventas del bot vienen de ${topSource.label}` : "Sin pedidos del bot en el periodo para atribuir",
    glyph: attribution.total.orders ? (
      <StackGlyph
        parts={[...attribution.sources]
          .sort((a, b) => ATTRIBUTION_SOURCE_ORDER.indexOf(a.key) - ATTRIBUTION_SOURCE_ORDER.indexOf(b.key))
          .map((s) => ({ label: s.label, value: s.revenue, color: SOURCE_SERIES[s.key] ?? VIZ.ink300 }))}
      />
    ) : undefined,
    panel: attribution.total.orders
      ? {
          meta: `Pedidos del bot por fuente y cierre${SEP}${periodMeta}`,
          width: "max-w-[880px]",
          body: <SalesAttributionModule attribution={attribution} metaSpend={metaSpend ?? null} currency={currency} timezone={timezone} />,
        }
      : null,
  };

  // «Canal de cierre» (MOM §17.3): quién cerró TODAS las ventas de la tienda,
  // por la venta registrada de la asesora y no por etiquetas que la
  // sincronización con Shopify borra. Es LA tarjeta por origen (MOM §17.4): la
  // cabecera cuenta las mismas ventas. Si la función 0259 no está (deploy no
  // aplica migraciones), falla, o ninguna tienda cuenta en el periodo, vuelve la
  // vista anterior —solo pedidos del bot— con un aviso y sin cifra de cabecera:
  // su porcentaje sería el número equivocado.
  const closingSummary = closing?.status === "ok" ? closing.summary : null;
  const closingCopy = closing?.status === "ok" ? coverageCopy(closing.plan, storeName, fullDay) : null;
  const noCoverage = closing?.status === "sin_cobertura" ? noCoverageCopy(closing.plan, storeName, fullDay) : null;
  // El periodo anterior de cada canal sale de las mismas ventas por origen, y
  // solo si se puede comparar.
  const closingPrev = period?.prev ?? null;
  // Lo que cuenta qué, con los módulos que hay en ESTA página (en la de una
  // tienda «Por tienda» es «Patrón de horas»).
  const listFmt = new Intl.ListFormat("es", { type: "conjunction" });
  const allSalesModules = ["Las cifras de cabecera", "«Ventas por día»", ...(singleStore ? [] : ["«Por tienda»"]), "esta tarjeta", "«Conversión por fuente»"];
  const botOnlyModules = [
    "«Conversión del bot»",
    "Productos",
    "Fuente",
    "Embudo y su salud",
    "los ingresos de Carritos",
    "los ingresos de Números de WhatsApp",
    "Desglose de negocio",
    "Integridad",
    ...(singleStore ? ["Patrón de horas"] : []),
  ];
  const channelTotal = CHANNEL_COLS.reduce((s, c) => s + channels[c.key].revenue, 0);
  const legacyCanalNote =
    closing?.status === "sin_migracion"
      ? "Falta aplicar la migración 0259 en la base: mientras tanto este panel solo ve los pedidos del bot de Kapso y no puede contar las ventas de las asesoras."
      : noCoverage
        ? noCoverage.note
        : closing?.status === "error"
          ? `No se pudo calcular el canal de todas las ventas (${closing.message}). Esto es la vista anterior: solo los pedidos del bot de Kapso.`
          : null;
  const coverageSub = subOf(closingCopy);
  const closingSold = closingSummary ? closingSummary.total.revenue > 0 : false;
  const canal: ModuleCell = closingSummary
    ? {
        id: "canal",
        title: "Canal de cierre",
        figure: closingSold ? pct(closingSummary.byGroup.humano.revenue / closingSummary.total.revenue, 0) : "—",
        tone: closingSold ? undefined : "muted",
        sub: closingSold
          ? `de todas las ventas lo cerró una asesora${SEP}${money(closingSummary.byGroup.humano.revenue, currency)} de ${money(closingSummary.total.revenue, currency)}${coverageSub}`
          : coverageSub
            ? `Sin ventas en lo contado${coverageSub}`
            : "Sin ventas en el periodo",
        glyph: closingSold ? (
          <StackGlyph
            parts={CLOSING_GROUPS.map((g) => ({ label: GROUP_LABEL[g], value: closingSummary.byGroup[g].revenue, color: CLOSING_GROUP_SHADE[g] }))}
          />
        ) : undefined,
        // Sin ventas en lo contado, el panel se abre igual si hay algo que decir de
        // la cobertura: «Sin ventas» con una tienda fuera o un periodo recortado no
        // es lo mismo que una tienda sin ventas.
        panel:
          closingSold || closingCopy?.title
            ? {
                meta: `Todas las ventas de la tienda${SEP}${countedMeta(closing?.status === "ok" ? closing.plan : null)}`,
                width: "max-w-[880px]",
                body: (
                  <div className="flex flex-col gap-4">
                    {closingCopy?.title && (
                      <Banner tone="info" role="status" title={closingCopy.title}>
                        {closingCopy.body}
                      </Banner>
                    )}
                    {closingSold ? (
                      <>
                        <p className="max-w-[72ch] text-[13px] leading-5 text-ink-600">
                          Cada venta cae en un solo canal, así que los canales suman el total de la tienda: la venta que una asesora
                          registró en el dashboard es suya aunque el pedido lleve otra etiqueta. «Ayudados por asesora» marca lo que
                          cerró otro canal después de que una asesora gestionara a la clienta en los 7 días previos: ayudar no es cerrar,
                          por eso no se suma a la asesora.
                        </p>
                        <p className="max-w-[72ch] text-[13px] leading-5 text-ink-600">
                          {period
                            ? `${listFmt.format(allSalesModules)} cuentan todas las ventas${closingPrev ? ", y el cambio contra el periodo anterior sale de las mismas ventas" : "; no hay cambio contra el periodo anterior porque alguna tienda no lo contaba entero"}. ${listFmt.format(botOnlyModules)} siguen contando solo los pedidos del bot de Kapso.`
                            : "Esta tarjeta cuenta todas las ventas. Las cifras de cabecera y los demás módulos de «Ventas del periodo», salvo «Anuncios de Meta», cuentan por ahora solo los pedidos del bot de Kapso: lo dice el aviso de arriba."}
                        </p>
                        <p className="max-w-[72ch] text-[13px] leading-5 text-ink-600">
                          Un carrito de EasySell que completa el bot de Kapso por WhatsApp hoy cuenta como «Web»: Shopify no le pone
                          ninguna marca que lo distinga de uno que la clienta terminó sola.
                        </p>
                        <ClosingChannels summary={closingSummary} currency={currency} prev={closingPrev} />
                      </>
                    ) : (
                      <p className="text-[13px] leading-5 text-ink-600">Sin ventas en lo contado.</p>
                    )}
                  </div>
                ),
              }
            : null,
      }
    : {
        id: "canal",
        title: "Canal de cierre",
        figure: !legacyCanalNote && channelTotal ? pct(channels.asesora.revenue / channelTotal, 0) : "—",
        tone: !legacyCanalNote && channelTotal ? undefined : "muted",
        sub: legacyCanalNote
          ? noCoverage
            ? noCoverage.sub
            : "Falta calcular todas las ventas"
          : channelTotal
            ? `lo cerró una asesora${SEP}${money(channels.asesora.revenue, currency)} de ${money(channelTotal, currency)}`
            : "Sin ventas en el periodo",
        glyph:
          !legacyCanalNote && channelTotal ? (
            <StackGlyph parts={CHANNEL_COLS.map((c) => ({ label: c.title, value: channels[c.key].revenue, color: CHANNEL_SHADE[c.key] }))} />
          ) : undefined,
        panel:
          channelTotal || legacyCanalNote
            ? {
                meta: periodMeta,
                width: "max-w-[760px]",
                body: (
                  <div className="flex flex-col gap-4">
                    {legacyCanalNote && (
                      <Banner tone="warn" role="status" title="Este panel no ve todas las ventas">
                        {legacyCanalNote}
                      </Banner>
                    )}
                    <p className="max-w-[68ch] text-[13px] leading-5 text-ink-600">
                      Tres canales y no dos: el bot asistido es una venta que cerró el bot después de que una asesora gestionara el lead. Asistir no
                      es cerrar, así que no se suma a la asesora.
                    </p>
                    <BotVsAdvisor channels={channels} currency={currency} />
                  </div>
                ),
              }
            : null,
      };

  // «Conversión por fuente» (MOM §17.4): una cohorte —los leads que llegaron
  // en el periodo y ya cumplieron 7 días— y si compraron en esos 7 días por
  // cualquier canal. No se compara con el periodo anterior: los últimos leads
  // de cualquier periodo todavía están madurando.
  const sc = sourceConversion;
  const scSummary = sc.status === "ok" ? sc.summary : null;
  const scPlan = sc.status === "ok" ? sc.plan : null;
  const scCopy = scPlan ? coverageCopy(scPlan, storeName, fullDay) : null;
  const scBorn = scSummary ? scSummary.sources.reduce((n, x) => n + x.born, 0) + scSummary.noRate.born : 0;
  const scCause = scSummary ? sourceNoRateCause(scSummary) : null;
  const scTop = scSummary ? scSummary.sources.filter((x) => x.rate != null).sort((a, b) => b.prospects - a.prospects).slice(0, 3) : [];
  const conversionFuente: ModuleCell = scSummary
    ? {
        id: "conversion-fuente",
        title: "Conversión por fuente",
        figure: scSummary.total.rate != null ? pct(scSummary.total.rate) : "—",
        tone: scSummary.total.rate != null ? undefined : "muted",
        sub:
          scSummary.total.rate != null
            ? `de ${nf.format(scSummary.total.prospects)} leads nuevos compraron en ${CONVERSION_DAYS} días${subOf(scCopy)}`
            : scCause === "ya_clientas"
              ? `Los leads con ${CONVERSION_DAYS} días ya eran clientas${subOf(scCopy)}`
              : scCause === "maduran"
                ? `${nf.format(scSummary.total.maturing)} leads todavía no cumplen ${CONVERSION_DAYS} días`
                : scCause === "sin_tasa"
                  ? "Solo leads sin tasa: venta telefónica o fuente no reconocida"
                  : `Sin leads nuevos en el periodo${subOf(scCopy)}`,
        glyph: scTop.length ? (
          <BarsGlyph rows={scTop.map((x) => ({ label: SOURCE_LABEL[x.key].title, value: x.rate ?? 0, display: pct(x.rate ?? 0) }))} />
        ) : undefined,
        panel: scBorn
          ? {
              meta: `Leads del periodo, por fuente${SEP}${countedMeta(scPlan)}`,
              width: "max-w-[880px]",
              body: (
                <div className="flex flex-col gap-4">
                  {scCopy?.title && (
                    <Banner tone="info" role="status" title={scCopy.title}>
                      {scCopy.body}
                    </Banner>
                  )}
                  <p className="max-w-[72ch] text-[13px] leading-5 text-ink-600">
                    De los leads que llegaron en el periodo y ya cumplieron {CONVERSION_DAYS} días, cuántos compraron en sus primeros{" "}
                    {CONVERSION_DAYS} días por cualquier canal: el bot, una asesora o la web. Las que ya eran clientas antes de escribir van
                    aparte: comprar otra vez no es convertir. Es una cohorte, así que no se compara con el periodo anterior.
                  </p>
                  <SourceConversion summary={scSummary} />
                  <p className="max-w-[72ch] text-[13px] leading-5 text-ink-600">
                    «Cierre de las asesoras» son las ventas que registraron en el periodo, también las que después se anularon, sobre los
                    leads distintos que trabajaron, de cualquier fuente y de cualquier fecha. Productividad suma esos leads por asesora, así
                    que allí un lead que trabajaron dos cuenta dos veces.
                  </p>
                </div>
              ),
            }
          : null,
      }
    : {
        id: "conversion-fuente",
        title: "Conversión por fuente",
        figure: "—",
        tone: "muted",
        sub:
          sc.status === "sin_migracion"
            ? "Falta aplicar la migración 0268"
            : sc.status === "sin_cobertura"
              ? noCoverageCopy(sc.plan, storeName, fullDay).sub
              : "No se pudo calcular",
        panel:
          sc.status === "error"
            ? {
                meta: periodMeta,
                width: "max-w-[560px]",
                body: (
                  <Banner tone="warn" role="status" title="No se pudo calcular la conversión por fuente">
                    {sc.message}
                  </Banner>
                ),
              }
            : null,
      };

  const roas = deliveredRoas(campaignStats, currency);
  const adSpend = campaignStats.filter((r) => sameCurrency(r.metaCurrency, currency) && !r.currencyConflict).reduce((s, r) => s + r.spend, 0);
  const adOrders = campaignStats.reduce((s, r) => s + r.pedidos, 0);
  const topAds = [...campaignStats].sort((a, b) => b.pedidos - a.pedidos || b.leads - a.leads).slice(0, 3);
  const anuncios: ModuleCell = {
    id: "anuncios",
    title: "Anuncios de Meta",
    figure: campaignStats.length ? (roas != null ? `${roas.toFixed(2)}×` : `${nf.format(adOrders)} pedidos`) : "—",
    tone: campaignStats.length ? undefined : "muted",
    sub: campaignStats.length
      ? roas != null
        ? `ROAS entregado${SEP}gasto ${money(adSpend, currency)}${SEP}${nf.format(adOrders)} pedidos`
        : `de ${nf.format(campaignStats.length)} anuncios${SEP}sin gasto comparable en ${currency}`
      : "Sin anuncios con leads o gasto en el periodo",
    glyph: topAds.length ? (
      <BarsGlyph rows={topAds.map((r) => ({ label: prettyAdName(r.label), value: r.pedidos, display: `${nf.format(r.pedidos)} ped.` }))} />
    ) : undefined,
    panel: campaignStats.length
      ? {
          meta: `${nf.format(campaignStats.length)} anuncios${SEP}${periodMeta}${SEP}gasto de Meta, ventas y entregas de Shopify y logística`,
          width: "max-w-[1320px]",
          body: (
            <div className="flex flex-col gap-4">
              {webSuelto.pedidos > 0 && (
                <Banner tone="warn" title={`${nf.format(webSuelto.pedidos)} pedidos de la web fuera de la tabla`}>
                  Llegaron por el carrito COD ({formatCurrency(webSuelto.ingresos, currency)}) sin decir de qué anuncio salieron. Se sabe la
                  campaña, no la creatividad, y repartirlos entre sus anuncios sería inventar cuál vendió. Se arregla en Meta: la plantilla de
                  URL de esas cuentas manda el nombre del anuncio donde debería mandar <code className="font-mono text-xs">{"{{ad.id}}"}</code>.
                </Banner>
              )}
              <CampaignTable
                rows={campaignStats}
                currency={currency}
                catalogStoreIds={scope === "all" ? stores.map((store) => store.id) : [scope]}
              />
            </div>
          ),
        }
      : null,
  };

  const trendDays = campaignTrend.rows.map((row) => campaignTrend.series.reduce((s, x) => s + Number(row[x.key] ?? 0), 0));
  const trendTotal = trendDays.reduce((s, v) => s + v, 0);
  const trendBySeries = campaignTrend.series.map((x, i) => ({
    ...x,
    color: trendColor(x.key, i),
    total: campaignTrend.rows.reduce((s, row) => s + Number(row[x.key] ?? 0), 0),
  }));
  const tendencia: ModuleCell = {
    id: "tendencia",
    title: "Leads por anuncio",
    figure: trendTotal ? `${nf.format(trendTotal)} leads` : "—",
    tone: trendTotal ? undefined : "muted",
    sub:
      campaignTrend.rows.length > 1
        ? `de anuncios, por día${SEP}los ${Math.min(5, campaignTrend.series.filter((s) => s.key !== "otros").length)} principales y otros`
        : trendTotal
          ? "Hace falta más de un día con leads de anuncios"
          : "Sin leads de anuncios en el periodo",
    glyph: campaignTrend.rows.length > 1 ? <LineGlyph values={trendDays} label="Leads de anuncios por día" /> : undefined,
    panel:
      campaignTrend.rows.length > 1
        ? {
            meta: periodMeta,
            width: "max-w-[880px]",
            body: (
              <div className="flex flex-col gap-6">
                <PanelSection title="Leads por día" help="Una línea por anuncio: los cinco con más leads y el resto en «Otros».">
                  <Legend items={trendBySeries.map((s) => ({ label: s.label, color: s.color }))} />
                  <TrendLines rows={campaignTrend.rows} series={campaignTrend.series} />
                </PanelSection>
                <PanelSection title="Por anuncio">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-line text-left">
                        <th scope="col" className={cn(TH, "pl-0")}>Anuncio</th>
                        <th scope="col" className={cn(TH, "text-right")}>Leads</th>
                        <th scope="col" className={cn(TH, "pr-0 text-right")}>Del total</th>
                      </tr>
                    </thead>
                    <tbody>
                      {trendBySeries.map((s) => (
                        <tr key={s.key} className="border-b border-line">
                          <td className="py-2.5 pr-3">
                            <span className="inline-flex min-w-0 items-center gap-2 text-ink-900">
                              <span aria-hidden className="size-2.5 shrink-0 rounded-[2px]" style={{ background: s.color }} />
                              {s.label}
                            </span>
                          </td>
                          <td className="px-3 py-2.5 text-right font-semibold tabular-nums text-ink-900">{nf.format(s.total)}</td>
                          <td className="py-2.5 pl-3 text-right tabular-nums text-ink-600">{trendTotal ? pct(s.total / trendTotal) : "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </PanelSection>
              </div>
            ),
          }
        : null,
  };

  const firstStage = funnelStages[0];
  const lastStage = funnelStages[funnelStages.length - 1];
  const embudo: ModuleCell = {
    id: "embudo",
    title: "Embudo conversacional",
    figure: firstStage?.value && lastStage ? pct(lastStage.value / firstStage.value) : "—",
    tone: firstStage?.value ? undefined : "muted",
    sub:
      firstStage?.value && lastStage
        ? `${nf.format(lastStage.value)} ${lastStage.label.toLowerCase()}${lastStage.key === "pedidos" ? " por el bot" : ""} de ${nf.format(firstStage.value)} ${firstStage.label.toLowerCase()}`
        : "Sin mensajes en el periodo",
    // Tres etapas con su cifra, desde la conversación: los mensajes son otra
    // unidad (varios por conversación) y con ellos el resto quedaba en puntos.
    glyph: firstStage?.value ? (
      <BarsGlyph
        rows={funnelStages
          .filter((s) => s.key === "conversaciones" || s.key === "interesados" || s.key === "pedidos")
          .map((s) => ({ label: s.label, value: s.value, display: nf.format(s.value) }))}
      />
    ) : undefined,
    panel: firstStage?.value
      ? { meta: `Pedidos del bot${SEP}${periodMeta}`, width: "max-w-[640px]", body: <HorizontalFunnel stages={funnelStages} /> }
      : null,
  };

  const critical = health.critical;
  const saludEmbudo: ModuleCell = {
    id: "salud-embudo",
    title: "Salud del embudo",
    figure: critical?.stepPct != null ? pct(critical.stepPct, 0) : "—",
    tone: critical ? (critical.status === "red" ? "crit" : critical.status === "amber" ? "warn" : undefined) : "muted",
    sub: critical ? `llega a ${critical.label.toLowerCase()}, el paso más débil` : "Sin datos para medir los pasos",
    glyph: critical ? (
      <DotsGlyph
        items={health.stages
          .filter((s) => s.stepPct != null)
          .map((s) => ({
            label: `${s.label.split(" ")[0]} ${s.stepPct != null ? Math.round(s.stepPct * 100) : 0}\u00a0%`,
            tone: HEALTH[s.status].tone as DotTone,
            state: HEALTH[s.status].label,
          }))}
      />
    ) : undefined,
    panel: critical ? { meta: `Pedidos del bot${SEP}${periodMeta}`, width: "max-w-[640px]", body: <FunnelHealth stages={health.stages} critical={critical} /> } : null,
  };

  const topReason = loss.reasons[0];
  const motivos: ModuleCell = {
    id: "motivos",
    title: "Por qué no compraron",
    figure: topReason ? sharePct(topReason.pct) : "—",
    tone: topReason ? undefined : "muted",
    sub: topReason ? `${topReason.label}${SEP}de ${nf.format(loss.total)} que no compraron` : "Sin leads sin convertir en el periodo",
    glyph: loss.reasons.length ? (
      <BarsGlyph rows={loss.reasons.slice(0, 3).map((r) => ({ label: r.label, value: r.count, display: sharePct(r.pct) }))} />
    ) : undefined,
    panel: loss.reasons.length
      ? { meta: periodMeta, width: "max-w-[640px]", body: <LossReasonBars items={loss.reasons} total={loss.total} /> }
      : null,
  };

  const impacto: ModuleCell = {
    id: "impacto",
    title: "Venta perdida estimada",
    figure: lostRev.items.length ? money(lostRev.total, currency) : "—",
    tone: lostRev.items.length ? undefined : "muted",
    sub: lostRev.items.length ? `leads sin comprar × ticket de ${money(head.aov, currency)}` : "Sin pérdidas estimadas en el periodo",
    glyph: lostRev.items.length ? (
      <BarsGlyph rows={[...lostRev.items].sort((a, b) => b.estRevenue - a.estRevenue).slice(0, 3).map((r) => ({ label: r.label, value: r.estRevenue, display: money(r.estRevenue, currency) }))} />
    ) : undefined,
    panel: lostRev.items.length
      ? {
          meta: periodMeta,
          width: "max-w-[640px]",
          body: (
            <div className="flex flex-col gap-4">
              <p className="max-w-[68ch] text-[13px] leading-5 text-ink-600">
                Una estimación gruesa: cuántos leads no compraron por cada motivo, por el ticket promedio{of} del periodo ({formatCurrency(head.aov, currency)}).
              </p>
              <LostRevenueCards items={lostRev.items} total={lostRev.total} currency={currency} />
            </div>
          ),
        }
      : null,
  };

  const carritos: ModuleCell = cartStats
    ? {
        id: "carritos",
        title: "Carritos abandonados",
        figure: pct(cartStats.tasaRecuperacion),
        sub: `${nf.format(cartStats.recuperados)} de ${nf.format(cartStats.total)} recuperados${SEP}${money(cartStats.valorEnRiesgo, currency)} por trabajar`,
        glyph: (
          <StackGlyph
            parts={[
              { label: "Recuperados", value: cartStats.recuperados, color: VIZ.ok },
              { label: "Por trabajar", value: cartStats.pendientes, color: VIZ.warn },
              { label: "Perdidos", value: cartStats.perdidos, color: VIZ.ink300 },
            ]}
          />
        ),
        panel: {
          meta: periodMeta,
          width: "max-w-[720px]",
          body: (
            <div className="flex flex-col gap-5">
              <p className="max-w-[68ch] text-[13px] leading-5 text-ink-600">
                Carritos abandonados (formulario COD o borradores de Shopify) que se convirtieron en pedido real. Los ingresos
                recuperados solo suman los pedidos del bot de Kapso; la compra de un carrito por cualquier canal está en
                «Conversión por fuente».
              </p>
              <dl className={cn(FIGURE_FRAME, "grid-cols-2 shadow-none")}>
                <Figure label="Carritos del periodo" value={nf.format(cartStats.total)} sub={`${nf.format(cartStats.pendientes)} por trabajar`} />
                <Figure label="Recuperados" value={nf.format(cartStats.recuperados)} delta={<span className="text-[13px] font-semibold tabular-nums text-ink-600">{pct(cartStats.tasaRecuperacion)}</span>} sub="se volvieron pedido" />
                <Figure
                  label="Ingresos recuperados del bot"
                  value={formatCurrency(cartStats.ingresosRecuperados, currency)}
                  sub={
                    cartStats.recuperadosBot
                      ? `ticket promedio ${formatCurrency(cartStats.ticketPromedio, currency)} en ${nf.format(cartStats.recuperadosBot)} con pedido del bot`
                      : undefined
                  }
                />
                <Figure label="Valor en riesgo" value={formatCurrency(cartStats.valorEnRiesgo, currency)} sub="carritos abiertos sin cerrar" />
              </dl>
              <StackGlyph
                parts={[
                  { label: "Recuperados", value: cartStats.recuperados, color: VIZ.ok },
                  { label: "Por trabajar", value: cartStats.pendientes, color: VIZ.warn },
                  { label: "Perdidos", value: cartStats.perdidos, color: VIZ.ink300 },
                ]}
              />
            </div>
          ),
        },
      }
    : {
        id: "carritos",
        title: "Carritos abandonados",
        figure: "—",
        tone: "muted",
        sub: "Sin carritos en el periodo",
      };

  const waLabelOf = (id: string) => (id ? waLabel(waNumbers?.[id], id) : "Sin asignar");
  const topWa = [...waStats].sort((a, b) => b.ingresos - a.ingresos)[0];
  const whatsapp: ModuleCell = {
    id: "whatsapp",
    title: "Números de WhatsApp",
    figure: waStats.length ? `${nf.format(waStats.length)} ${waStats.length === 1 ? "número" : "números"}` : "—",
    tone: waStats.length ? undefined : "muted",
    sub: topWa ? `${waLabelOf(topWa.phoneNumberId)} vende más por el bot${SEP}${money(topWa.ingresos, currency)}` : "Sin leads en el periodo",
    glyph: waStats.length ? (
      <BarsGlyph rows={[...waStats].sort((a, b) => b.leads - a.leads).slice(0, 3).map((r) => ({ label: waLabelOf(r.phoneNumberId), value: r.leads, display: `${nf.format(r.leads)} leads` }))} />
    ) : undefined,
    panel: waStats.length
      ? {
          meta: `Ingresos del bot${SEP}${periodMeta}`,
          width: "max-w-[760px]",
          body: (
            <PanelSection
              title="Leads, conversión e ingresos"
              help="Según el número por el que escribió el cliente. Los pedidos son los leads que compraron por cualquier vía; los ingresos, solo los de los pedidos del bot de Kapso."
            >
              <div className="overflow-x-auto">
                <table className="w-full min-w-[560px] text-sm">
                  <thead>
                    <tr className="border-b border-line text-left">
                      <th scope="col" className={cn(TH, "pl-0")}>Número</th>
                      <th scope="col" className={cn(TH, "text-right")}>Leads</th>
                      <th scope="col" className={cn(TH, "text-right")}>Pedidos</th>
                      <th scope="col" className={cn(TH, "text-right")}>Conversión</th>
                      <th scope="col" className={cn(TH, "pr-0 text-right")}>Ingresos del bot</th>
                    </tr>
                  </thead>
                  <tbody>
                    {waStats.map((r) => {
                      const n = r.phoneNumberId ? waNumbers?.[r.phoneNumberId] : undefined;
                      const kind = waKindLabel(n?.kind ?? null);
                      return (
                        <tr key={r.phoneNumberId || "sin-asignar"} className="border-b border-line">
                          <td className="py-2.5 pr-3">
                            <span className={cn("block font-medium", r.phoneNumberId ? "text-ink-900" : "text-ink-500")}>{waLabelOf(r.phoneNumberId)}</span>
                            {(kind || n?.displayPhone) && (
                              <span className="mt-0.5 block text-xs tabular-nums text-ink-500">{[kind, n?.displayPhone].filter(Boolean).join(SEP)}</span>
                            )}
                          </td>
                          <td className="px-3 py-2.5 text-right tabular-nums text-ink-700">{nf.format(r.leads)}</td>
                          <td className="px-3 py-2.5 text-right tabular-nums text-ink-700">{nf.format(r.pedidos)}</td>
                          <td className="px-3 py-2.5 text-right tabular-nums text-ink-700">{pct(r.conversion)}</td>
                          <td className="py-2.5 pl-3 text-right font-semibold tabular-nums text-ink-900">{formatCurrency(r.ingresos, currency)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </PanelSection>
          ),
        }
      : null,
  };

  const shipping = [
    { label: "Contraentrega", value: breakdown.codOrders, color: VIZ.ink900 },
    { label: "Agencia", value: breakdown.agencyOrders, color: VIZ.ink500 },
    { label: "Otro", value: breakdown.otherShippingOrders, color: VIZ.ink300 },
  ];
  const negocio: ModuleCell = {
    id: "negocio",
    title: "Desglose de negocio",
    figure: breakdown.total ? pct(breakdown.promoPct / 100) : "—",
    tone: breakdown.total ? undefined : "muted",
    sub: breakdown.total
      ? `con promo${SEP}${nf.format(breakdown.stockValidarOrders)} con stock por validar`
      : "Sin órdenes del bot en el periodo",
    glyph: breakdown.total ? <StackGlyph parts={shipping} /> : undefined,
    panel: breakdown.total
      ? {
          meta: `Pedidos del bot${SEP}${periodMeta}`,
          width: "max-w-[640px]",
          body: (
            <div className="flex flex-col gap-6">
              <dl className={cn(FIGURE_FRAME, "grid-cols-2 shadow-none")}>
                <Figure label="Con promo" value={pct(breakdown.promoPct / 100)} sub={`${nf.format(breakdown.promoOrders)} órdenes con la etiqueta promo-whatsapp`} />
                <Figure label="Stock por validar" value={nf.format(breakdown.stockValidarOrders)} sub="órdenes marcadas" />
                <Figure label="Canceladas" value={nf.format(totals.cancelledOrders)} sub="fuera de los ingresos" />
                <Figure label="Reembolsado" value={formatCurrency(totals.refundedAmount, currency)} sub="en órdenes activas" />
              </dl>
              <PanelSection title="Modo de envío">
                <ul className="flex flex-col gap-3">
                  {shipping.map((s) => (
                    <li key={s.label}>
                      <div className="flex items-baseline justify-between gap-3 text-sm">
                        <span className="inline-flex items-center gap-2 text-ink-900">
                          <span aria-hidden className="size-2.5 rounded-[2px]" style={{ background: s.color }} />
                          {s.label}
                        </span>
                        <span className="tabular-nums text-ink-600">
                          <span className="font-semibold text-ink-900">{nf.format(s.value)}</span>
                          {SEP}
                          {pct(breakdown.total ? s.value / breakdown.total : 0, 0)}
                        </span>
                      </div>
                      <div className="mt-1.5 h-2 rounded-full bg-line">
                        <div className="h-full rounded-full" style={{ width: `${breakdown.total ? Math.max(s.value ? 2 : 0, (s.value / breakdown.total) * 100) : 0}%`, background: s.color }} />
                      </div>
                    </li>
                  ))}
                </ul>
              </PanelSection>
            </div>
          ),
        }
      : null,
  };

  const integridad: ModuleCell = {
    id: "integridad",
    title: "Integridad de conversión",
    figure: fine.ordersWithConversationId ? pct(fine.matchedOrders / fine.ordersWithConversationId) : "—",
    tone: fine.ordersWithConversationId ? (fine.unmatchedOrders > 0 ? "warn" : undefined) : "muted",
    sub: fine.ordersWithConversationId
      ? `de las órdenes con conversación se emparejaron${fine.unmatchedOrders ? `${SEP}${nf.format(fine.unmatchedOrders)} sin encontrar` : ""}`
      : "Ninguna orden trae id de conversación",
    glyph:
      fine.ordersWithConversationId || fine.orphanOrders ? (
        <StackGlyph
          parts={[
            { label: "Emparejadas", value: fine.matchedOrders, color: VIZ.ok },
            { label: "No encontrada", value: fine.unmatchedOrders, color: VIZ.warn },
            { label: "Sin id", value: fine.orphanOrders, color: VIZ.ink300 },
          ]}
        />
      ) : undefined,
    panel: !(fine.ordersWithConversationId || fine.orphanOrders) ? null : {
      meta: `Pedidos del bot${SEP}${periodMeta}`,
      width: "max-w-[560px]",
      body: (
        <div className="flex flex-col gap-4">
          <p className="max-w-[68ch] text-[13px] leading-5 text-ink-600">
            Cuántas órdenes se pueden unir con su conversación de Kapso por el id de conversación. Una que trae id y no se encuentra es un
            hueco de la ingesta.
          </p>
          <table className="w-full text-sm">
            <tbody>
              {[
                { k: "Órdenes con conversación", v: fine.ordersWithConversationId, tone: "text-ink-900" },
                { k: "Emparejadas", v: fine.matchedOrders, tone: "text-ok-fg" },
                { k: "Conversación no encontrada", v: fine.unmatchedOrders, tone: fine.unmatchedOrders ? "text-warn-fg" : "text-ink-900" },
                { k: "Sin id de conversación", v: fine.orphanOrders, tone: "text-ink-600" },
              ].map((r) => (
                <tr key={r.k} className="border-b border-line last:border-0">
                  <th scope="row" className="py-2.5 pr-3 text-left font-normal text-ink-700">{r.k}</th>
                  <td className={cn("py-2.5 pl-3 text-right font-semibold tabular-nums", r.tone)}>{nf.format(r.v)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ),
    },
  };

  const opsRows = opsStores.map((s) => ({ store: s, p: ops[s.id] as OpsPayload | undefined }));
  const healthy = opsRows.filter((r) => healthTone(r.p?.health?.status).tone === "ok").length;
  const apiErrors = opsRows.reduce((sum, r) => sum + (r.p?.apiLogs?.errors ?? 0), 0);
  const saludOp: ModuleCell = {
    id: "salud-operativa",
    title: "Salud operativa (Kapso)",
    figure: opsRows.length ? `${healthy} de ${opsRows.length}` : "—",
    tone: !opsRows.length ? "muted" : healthy < opsRows.length ? "warn" : undefined,
    sub: opsRows.length ? `${opsRows.length === 1 ? "tienda sana" : "tiendas sanas"}${SEP}${nf.format(apiErrors)} errores de API en 24 h` : "Sin tiendas para mostrar",
    glyph: opsRows.length ? (
      <DotsGlyph
        items={opsRows.map((r) => {
          const h = healthTone(r.p?.health?.status);
          return { label: r.store.name, tone: h.dot, state: r.p ? h.label : "Sin datos" };
        })}
      />
    ) : undefined,
    panel: opsRows.length
      ? {
          meta: "Kapso, últimas 24 h, con la mejor información disponible",
          width: "max-w-[760px]",
          body: (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[600px] text-sm">
                <thead>
                  <tr className="border-b border-line text-left">
                    <th scope="col" className={cn(TH, "pl-0")}>Tienda</th>
                    <th scope="col" className={TH}>Estado</th>
                    <th scope="col" className={cn(TH, "text-right")}>Errores API</th>
                    <th scope="col" className={cn(TH, "text-right")}>Latencia prom. / p95</th>
                    <th scope="col" className={cn(TH, "pr-0 text-right")}>Conversaciones</th>
                  </tr>
                </thead>
                <tbody>
                  {opsRows.map(({ store, p }) => {
                    const h = healthTone(p?.health?.status);
                    return (
                      <tr key={store.id} className="border-b border-line">
                        <td className="py-2.5 pr-3 font-medium text-ink-900">{store.name}</td>
                        <td className="px-3 py-2.5">
                          <Badge tone={h.tone}>{p ? h.label : "Sin datos aún"}</Badge>
                        </td>
                        <td className="px-3 py-2.5 text-right tabular-nums text-ink-700">
                          {p?.apiLogs ? `${nf.format(p.apiLogs.errors ?? 0)} de ${nf.format(p.apiLogs.total ?? 0)}` : "—"}
                        </td>
                        <td className="px-3 py-2.5 text-right tabular-nums text-ink-700">
                          {p?.apiLogs?.avgLatencyMs != null ? `${Math.round(p.apiLogs.avgLatencyMs)} / ${p.apiLogs.p95LatencyMs ?? "—"} ms` : "—"}
                        </td>
                        <td className="py-2.5 pl-3 text-right tabular-nums text-ink-700">
                          {p?.activity24h ? `${nf.format(p.activity24h.conversations ?? 0)} (${nf.format(p.activity24h.activeConversations ?? 0)} activas)` : "—"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ),
        }
      : null,
  };

  const groups: ModuleGroup[] = [
    { id: "ventas", label: "Ventas", cells: [ventasDia, conversion, storeCell, productos] },
    { id: "origen", label: "Origen y cierre", cells: [canal, conversionFuente, fuente, anuncios, tendencia] },
    { id: "perdida", label: "Lo que se pierde", cells: [embudo, saludEmbudo, motivos, impacto, carritos] },
    { id: "sistema", label: "Números, negocio y sistema", cells: [whatsapp, negocio, integridad, saludOp] },
  ];

  return (
    <ConsolidadoNav>
      <div className="flex flex-col gap-6">
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-[28px] font-bold leading-9 tracking-[-0.01em] text-ink-900">
              {singleStore ? singleStore.name : "Consolidado"}
            </h1>
            <p className="mt-0.5 text-sm text-ink-500">
              {singleStore ? singleStore.shopify_domain : stores.length > 1 ? `${stores.length} tiendas: ${storeList}` : storeList}
            </p>
          </div>
          {singleStore && (
            <Link href={`/dashboard/${singleStore.id}/settings`} className={opsButtonClass("secondary", "md", "pointer-coarse:h-11")}>
              Ajustes de la tienda
            </Link>
          )}
        </header>

        {operations}

        <section aria-labelledby="ventas-periodo" className="flex flex-col gap-4">
          <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
            <div className="min-w-0">
              <h2 id="ventas-periodo" className="text-xl font-semibold leading-7 text-ink-900">
                Ventas del periodo
              </h2>
              <p className="mt-0.5 text-sm text-ink-500 first-letter:uppercase">{context}</p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <a href={`/api/export?kind=orders&${exportBase}`} className={opsButtonClass("ghost", "sm", "pointer-coarse:h-11")}>
                <IconDownload />
                Órdenes CSV
              </a>
              <a href={`/api/export?kind=rollups&${exportBase}`} className={opsButtonClass("ghost", "sm", "pointer-coarse:h-11")}>
                <IconDownload />
                Resumen diario del bot CSV
              </a>
            </div>
          </div>

          <ConsolidadoFilters
            basePath={basePath}
            range={range}
            periods={periods}
            months={monthChips}
            otherMonths={otherMonths}
            otherMonth={otherMonth}
            stores={storeLinks}
            store={{ value: scope === "all" ? "" : scope, allHref: hrefFor(range, "/dashboard") }}
          />

          <PendingDim className="flex flex-col gap-6">
            {originNote && (
              <Banner tone="warn" role="status" title="Estas cifras solo ven los pedidos del bot">
                {originNote}
              </Banner>
            )}
            {originBanner}
            <dl className={cn(FIGURE_FRAME, "grid-cols-2 lg:grid-cols-5")}>
              <Figure
                label={`Ingresos${of}`}
                value={money(head.revenue, currency)}
                delta={headCmp ? <Change pct={headCmp.revenueDeltaPct} /> : undefined}
                sub={
                  head.prev
                    ? `antes ${money(head.prev.revenue, currency)}`
                    : period
                      ? "sin comparar: el anterior no tiene todas las ventas"
                      : "sin periodo anterior con datos"
                }
              />
              <Figure
                label={`Pedidos${of}`}
                value={nf.format(head.orders)}
                delta={headCmp ? <Change pct={headCmp.ordersDeltaPct} /> : undefined}
                sub={head.cancelled ? `${nf.format(head.cancelled)} cancelados aparte` : undefined}
              />
              <Figure
                label={`Ticket promedio${of}`}
                value={money(head.aov, currency)}
                delta={headCmp ? <Change pct={headCmp.aovDeltaPct} /> : undefined}
              />
              <Figure
                label="Conversión del bot"
                value={bot.rate != null ? pct(bot.rate) : "—"}
                delta={bot.prev && bot.conversations ? <Change pct={botDelta} unit="pts" /> : undefined}
                sub={`${nf.format(bot.orders)} pedidos del bot de ${nf.format(bot.conversations)} conversaciones`}
              />
              <Figure
                label="Primera respuesta"
                value={hasRt ? formatDuration(totals.avgFirstResponseSeconds) : "—"}
                sub={hasRt ? "promedio del periodo" : "se activa con la próxima ingesta"}
                className="col-span-2 lg:col-span-1"
              />
            </dl>

            <ModuleBoard groups={groups} />
          </PendingDim>
        </section>
      </div>
    </ConsolidadoNav>
  );
}
