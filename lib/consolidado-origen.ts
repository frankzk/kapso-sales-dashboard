// Todas las ventas por origen y la conversión de cada fuente (MOM §17.4,
// migración 0265).
//
// Postgres clasifica (`ventas_por_origen`, `conversion_por_fuente`, sobre la
// misma regla del canal que «Canal de cierre»: la vista `pedidos_canal`). Acá
// solo se lee lo que devuelven, se suma por tienda y día, y se arma lo que la
// pantalla pinta. Separado del fetch para probarlo.

import {
  CHANNEL_GROUP,
  CLOSING_CHANNELS,
  CLOSING_GROUPS,
  type ClosingChannelKey,
  type ClosingGroupKey,
} from "@/lib/closing-channel";
import type { WindowPlan } from "@/lib/sales-coverage";
import type { DailyRollupRow } from "@/lib/types";

const finite = (value: unknown): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};
const round2 = (n: number) => Math.round(n * 100) / 100;
const isChannel = (v: unknown): v is ClosingChannelKey =>
  typeof v === "string" && (CLOSING_CHANNELS as readonly string[]).includes(v);

// ── Ventas por origen ───────────────────────────────────────────────────────

/** Lo que devuelve `ventas_por_origen` por tienda, día local y canal. */
export interface OriginDayRow {
  storeId: string;
  date: string;
  channel: ClosingChannelKey;
  orders: number;
  revenue: number;
  cancelled: number;
}

/**
 * Lo que la pantalla recibe: las filas del periodo y, si se puede comparar, las
 * del periodo anterior (null si no: alguna tienda no lo contaba entero). Un
 * error se dice; nunca se vuelve ceros.
 */
export type OriginSalesResult =
  | { status: "ok"; rows: OriginDayRow[]; prevRows: OriginDayRow[] | null; plan: WindowPlan }
  | { status: "sin_cobertura"; plan: WindowPlan }
  | { status: "sin_migracion" }
  | { status: "error"; message: string };

/** El jsonb de `ventas_por_origen` → filas tipadas. Un canal desconocido suma a «otros». */
export function parseOriginRows(data: unknown): OriginDayRow[] {
  const filas = (data as { filas?: unknown } | null)?.filas;
  if (!Array.isArray(filas)) return [];
  return filas.flatMap((raw) => {
    const r = raw as Record<string, unknown>;
    const date = typeof r.dia === "string" ? r.dia.slice(0, 10) : "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return [];
    return [
      {
        storeId: String(r.store_id ?? ""),
        date,
        channel: isChannel(r.canal) ? r.canal : "otros",
        orders: Math.trunc(finite(r.pedidos)),
        revenue: finite(r.ingresos),
        cancelled: Math.trunc(finite(r.cancelados)),
      },
    ];
  });
}

export interface Amount {
  orders: number;
  revenue: number;
}
export type GroupAmounts = Record<ClosingGroupKey, Amount>;

const zeroGroups = (): GroupAmounts =>
  Object.fromEntries(CLOSING_GROUPS.map((g) => [g, { orders: 0, revenue: 0 }])) as GroupAmounts;
const zeroChannels = (): Record<ClosingChannelKey, Amount> =>
  Object.fromEntries(CLOSING_CHANNELS.map((c) => [c, { orders: 0, revenue: 0 }])) as Record<ClosingChannelKey, Amount>;

export interface SalesTotals {
  orders: number;
  revenue: number;
  cancelled: number;
  aov: number;
  byChannel: Record<ClosingChannelKey, Amount>;
  byGroup: GroupAmounts;
}

/** Suma filas de ventas por origen. Σ canales = Σ grupos = total, por construcción. */
export function sumOrigin(rows: readonly OriginDayRow[]): SalesTotals {
  const byChannel = zeroChannels();
  const byGroup = zeroGroups();
  let orders = 0;
  let revenue = 0;
  let cancelled = 0;
  for (const r of rows) {
    byChannel[r.channel].orders += r.orders;
    byChannel[r.channel].revenue += r.revenue;
    const g = byGroup[CHANNEL_GROUP[r.channel]];
    g.orders += r.orders;
    g.revenue += r.revenue;
    orders += r.orders;
    revenue += r.revenue;
    cancelled += r.cancelled;
  }
  for (const c of CLOSING_CHANNELS) byChannel[c].revenue = round2(byChannel[c].revenue);
  for (const g of CLOSING_GROUPS) byGroup[g].revenue = round2(byGroup[g].revenue);
  revenue = round2(revenue);
  return { orders, revenue, cancelled, aov: orders ? round2(revenue / orders) : 0, byChannel, byGroup };
}

export interface SalesDay {
  date: string;
  orders: number;
  revenue: number;
  byGroup: GroupAmounts;
  botOrders: number;
  conversations: number;
  /** Pedidos del bot ÷ conversaciones del día; null sin conversaciones. */
  botRate: number | null;
}

export interface SalesStore {
  storeId: string;
  orders: number;
  revenue: number;
  aov: number;
  byGroup: GroupAmounts;
  botOrders: number;
  conversations: number;
  botRate: number | null;
}

export interface BotConversion {
  orders: number;
  conversations: number;
  rate: number | null;
}

export interface SalesPeriod {
  totals: SalesTotals;
  /** El periodo anterior, solo si se puede comparar (cada tienda lo contaba entero). */
  prev: SalesTotals | null;
  /** Cada día desde el primero que cuenta alguna tienda, con los vacíos en cero. */
  days: SalesDay[];
  stores: SalesStore[];
  /** «Conversión del bot»: pedidos del bot (canal bot_kapso) ÷ conversaciones, en la MISMA ventana. */
  bot: BotConversion & { prev: BotConversion | null };
}

const rate = (num: number, den: number): number | null => (den ? num / den : null);

/** Cada día entre dos fechas (YYYY-MM-DD), ambas incluidas. */
export function daysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  const d = new Date(`${from}T12:00:00.000Z`);
  const end = new Date(`${to}T12:00:00.000Z`).getTime();
  while (d.getTime() <= end) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

/**
 * El periodo como lo pinta «Ventas del periodo»: todas las ventas por origen,
 * por día y por tienda, y la conversión del bot con su numerador (canal
 * bot_kapso) y su denominador (las conversaciones de `daily_rollups`) en la
 * misma ventana de cada tienda. Las conversaciones fuera de la ventana de su
 * tienda no cuentan: dividir un numerador recortado por un denominador entero
 * daría una tasa falsa.
 */
export function salesPeriod(
  origin: { rows: readonly OriginDayRow[]; prevRows: readonly OriginDayRow[] | null; plan: WindowPlan },
  rollups: readonly DailyRollupRow[],
  prevRollups: readonly DailyRollupRow[],
  prevRange: { from: string; to: string },
): SalesPeriod {
  const windows = new Map(origin.plan.windows.map((w) => [w.storeId, w]));
  const inWindow = (r: DailyRollupRow) => {
    const w = windows.get(r.store_id);
    return !!w && r.date >= w.from && r.date <= w.to;
  };
  const conv = rollups.filter(inWindow);

  const totals = sumOrigin(origin.rows);
  const prev = origin.prevRows ? sumOrigin(origin.prevRows) : null;

  // Días: desde la primera ventana hasta el final del periodo.
  const first = origin.plan.windows.reduce<string | null>((m, w) => (m == null || w.from < m ? w.from : m), null);
  const last = origin.plan.windows.reduce<string | null>((m, w) => (m == null || w.to > m ? w.to : m), null);
  const dayList = first && last ? daysBetween(first, last) : [];
  const byDay = new Map<string, SalesDay>(
    dayList.map((date) => [date, { date, orders: 0, revenue: 0, byGroup: zeroGroups(), botOrders: 0, conversations: 0, botRate: null }]),
  );
  const byStore = new Map<string, SalesStore>(
    origin.plan.windows.map((w) => [
      w.storeId,
      { storeId: w.storeId, orders: 0, revenue: 0, aov: 0, byGroup: zeroGroups(), botOrders: 0, conversations: 0, botRate: null },
    ]),
  );
  for (const r of origin.rows) {
    const d = byDay.get(r.date);
    const s = byStore.get(r.storeId);
    const g = CHANNEL_GROUP[r.channel];
    for (const t of [d, s]) {
      if (!t) continue;
      t.orders += r.orders;
      t.revenue += r.revenue;
      t.byGroup[g].orders += r.orders;
      t.byGroup[g].revenue += r.revenue;
      if (r.channel === "bot_kapso") t.botOrders += r.orders;
    }
  }
  for (const r of conv) {
    const d = byDay.get(r.date);
    const s = byStore.get(r.store_id);
    if (d) d.conversations += r.conversations_count;
    if (s) s.conversations += r.conversations_count;
  }
  const days = [...byDay.values()].map((d) => ({ ...d, revenue: round2(d.revenue), botRate: rate(d.botOrders, d.conversations) }));
  const stores = [...byStore.values()]
    .map((s) => ({ ...s, revenue: round2(s.revenue), aov: s.orders ? round2(s.revenue / s.orders) : 0, botRate: rate(s.botOrders, s.conversations) }))
    .sort((a, b) => b.revenue - a.revenue);

  const botOrders = totals.byChannel.bot_kapso.orders;
  const conversations = conv.reduce((n, r) => n + r.conversations_count, 0);
  let botPrev: BotConversion | null = null;
  if (prev) {
    const prevConv = prevRollups
      .filter((r) => windows.has(r.store_id) && r.date >= prevRange.from && r.date <= prevRange.to)
      .reduce((n, r) => n + r.conversations_count, 0);
    botPrev = { orders: prev.byChannel.bot_kapso.orders, conversations: prevConv, rate: rate(prev.byChannel.bot_kapso.orders, prevConv) };
  }

  return {
    totals,
    prev,
    days,
    stores,
    bot: { orders: botOrders, conversations, rate: rate(botOrders, conversations), prev: botPrev },
  };
}

// ── Conversión por fuente ───────────────────────────────────────────────────

/** Días de vida que necesita un lead para entrar a la tasa, y ventana de compra. Igual que la 0265. */
export const CONVERSION_DAYS = 7;

/** Las fuentes con tasa, en el orden de la tabla. */
export const SOURCE_KEYS = ["meta_ad", "cod_cart", "organico", "fb_web", "abandoned_browse"] as const;
export type SourceKey = (typeof SOURCE_KEYS)[number];

export const SOURCE_LABEL: Record<SourceKey, { title: string; sub: string }> = {
  meta_ad: { title: "Anuncios de Meta", sub: "escribieron desde un anuncio de WhatsApp" },
  cod_cart: { title: "Carritos COD abandonados", sub: "dejaron el formulario contraentrega a medias" },
  organico: { title: "Orgánico de WhatsApp", sub: "escribieron sin anuncio ni carrito" },
  fb_web: { title: "Web de Facebook", sub: "llegaron por un enlace de Facebook o Instagram" },
  abandoned_browse: { title: "Búsquedas abandonadas", sub: "miraron productos en la web y no compraron" },
};

const isSource = (v: unknown): v is SourceKey => typeof v === "string" && (SOURCE_KEYS as readonly string[]).includes(v);

export interface SourceRow {
  storeId: string;
  source: SourceKey | "sin_tasa";
  born: number;
  maturing: number;
  alreadyCustomers: number;
  prospects: number;
  converted: number;
}

export interface SourceCloseRow {
  storeId: string;
  source: SourceKey | "sin_tasa";
  channel: ClosingChannelKey;
  converted: number;
}

export interface AdvisorRow {
  storeId: string;
  worked: number;
  sales: number;
  cancelledSales: number;
}

export interface ParsedSourceConversion {
  sources: SourceRow[];
  closes: SourceCloseRow[];
  advisors: AdvisorRow[];
}

/** El jsonb de `conversion_por_fuente` → filas tipadas. Una fuente desconocida va a «sin tasa». */
export function parseSourceConversion(data: unknown): ParsedSourceConversion {
  const d = (data ?? {}) as { fuentes?: unknown; cierres?: unknown; asesoras?: unknown };
  const arr = (v: unknown) => (Array.isArray(v) ? (v as Record<string, unknown>[]) : []);
  return {
    sources: arr(d.fuentes).map((r) => ({
      storeId: String(r.store_id ?? ""),
      source: isSource(r.fuente) ? r.fuente : "sin_tasa",
      born: Math.trunc(finite(r.nacidos)),
      maturing: Math.trunc(finite(r.por_madurar)),
      alreadyCustomers: Math.trunc(finite(r.ya_clientas)),
      prospects: Math.trunc(finite(r.prospectos)),
      converted: Math.trunc(finite(r.convertidos)),
    })),
    closes: arr(d.cierres).map((r) => ({
      storeId: String(r.store_id ?? ""),
      source: isSource(r.fuente) ? r.fuente : "sin_tasa",
      channel: isChannel(r.canal) ? r.canal : "otros",
      converted: Math.trunc(finite(r.convertidos)),
    })),
    advisors: arr(d.asesoras).map((r) => ({
      storeId: String(r.store_id ?? ""),
      worked: Math.trunc(finite(r.leads_trabajados)),
      sales: Math.trunc(finite(r.ventas)),
      cancelledSales: Math.trunc(finite(r.canceladas)),
    })),
  };
}

export interface SourceSummary {
  key: SourceKey;
  born: number;
  maturing: number;
  alreadyCustomers: number;
  prospects: number;
  converted: number;
  /** converted ÷ prospects; null si no hay leads con 7 días («Sin datos», nunca 0 %). */
  rate: number | null;
  /** Quién cerró las compras que convirtieron. */
  closedBy: Record<ClosingGroupKey, number>;
}

export interface SourceConversionSummary {
  sources: SourceSummary[];
  /** Todas las fuentes con tasa juntas. */
  total: { prospects: number; converted: number; maturing: number; rate: number | null };
  /** Venta telefónica y fuentes desconocidas: nacen pero no tienen tasa. */
  noRate: { born: number };
  /** Como Productividad: ventas registradas ÷ leads distintos trabajados. */
  advisors: { worked: number; sales: number; cancelledSales: number; rate: number | null };
}

/** Suma las tiendas por fuente. Las tasas suman numeradores y denominadores, nunca promedian porcentajes. */
export function summarizeSourceConversion(p: ParsedSourceConversion): SourceConversionSummary {
  const zeroClosed = () => Object.fromEntries(CLOSING_GROUPS.map((g) => [g, 0])) as Record<ClosingGroupKey, number>;
  const acc = new Map<SourceKey, SourceSummary>(
    SOURCE_KEYS.map((k) => [k, { key: k, born: 0, maturing: 0, alreadyCustomers: 0, prospects: 0, converted: 0, rate: null, closedBy: zeroClosed() }]),
  );
  let noRate = 0;
  for (const r of p.sources) {
    if (r.source === "sin_tasa") {
      noRate += r.born;
      continue;
    }
    const s = acc.get(r.source)!;
    s.born += r.born;
    s.maturing += r.maturing;
    s.alreadyCustomers += r.alreadyCustomers;
    s.prospects += r.prospects;
    s.converted += r.converted;
  }
  for (const c of p.closes) {
    if (c.source === "sin_tasa") continue;
    acc.get(c.source)!.closedBy[CHANNEL_GROUP[c.channel]] += c.converted;
  }
  const sources = [...acc.values()].map((s) => ({ ...s, rate: rate(s.converted, s.prospects) }));
  const prospects = sources.reduce((n, s) => n + s.prospects, 0);
  const converted = sources.reduce((n, s) => n + s.converted, 0);
  const maturing = sources.reduce((n, s) => n + s.maturing, 0);
  const worked = p.advisors.reduce((n, a) => n + a.worked, 0);
  const sales = p.advisors.reduce((n, a) => n + a.sales, 0);
  const cancelledSales = p.advisors.reduce((n, a) => n + a.cancelledSales, 0);
  return {
    sources,
    total: { prospects, converted, maturing, rate: rate(converted, prospects) },
    noRate: { born: noRate },
    advisors: { worked, sales, cancelledSales, rate: rate(sales, worked) },
  };
}

/**
 * Por qué no hay tasa, para decirlo con su causa y nunca con un «0 %»: los
 * leads con 7 días ya eran clientas, todavía no cumplieron 7 días, solo
 * llegaron leads sin tasa, o no llegó ninguno. null si hay tasa.
 */
export type SourceNoRateCause = "ya_clientas" | "maduran" | "sin_tasa" | "sin_leads";

export function sourceNoRateCause(s: SourceConversionSummary): SourceNoRateCause | null {
  if (s.total.rate != null) return null;
  const matureRated = s.sources.reduce((n, x) => n + x.prospects + x.alreadyCustomers, 0);
  if (matureRated > 0) return "ya_clientas";
  if (s.total.maturing > 0) return "maduran";
  if (s.noRate.born > 0) return "sin_tasa";
  return "sin_leads";
}

export type SourceConversionResult =
  | { status: "ok"; summary: SourceConversionSummary; plan: WindowPlan }
  | { status: "sin_cobertura"; plan: WindowPlan }
  | { status: "sin_migracion" }
  | { status: "error"; message: string };
