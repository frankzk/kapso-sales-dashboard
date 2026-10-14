// Canal de cierre de TODAS las ventas de la tienda (MOM §17.3).
//
// La clasificación vive en Postgres (`canal_de_cierre`, migración 0257): allí
// cada pedido cae en UN canal por hechos que la sincronización con Shopify no
// borra —la venta registrada de la asesora en `order_sales`, la prueba de
// recompra, las etiquetas que pone el propio Shopify—. Acá solo se lee lo que
// devuelve y se resume para la pantalla. Separado del fetch para probarlo.
//
// Antes «Canal de cierre» solo veía los pedidos con etiqueta `kapso` y decidía
// «asesora» por etiquetas que la sincronización reescribe: medido del 14-09 al
// 13-10-2026, 1 de 2.916 ventas de asesoras conservaba `kapso`, y el panel decía
// «0 % lo cerró una asesora» mientras Productividad les contaba S/ 484.645.

/** El canal, en el ORDEN de precedencia del MOM §17.3 (gana el primero). */
export const CLOSING_CHANNELS = ["asesora", "recompra_auto", "bot_kapso", "bot_externo", "web", "otros"] as const;
export type ClosingChannelKey = (typeof CLOSING_CHANNELS)[number];

/** Los cuatro grupos de «quién cerró», de más a menos mano humana. */
export const CLOSING_GROUPS = ["humano", "automatizacion", "web", "otros"] as const;
export type ClosingGroupKey = (typeof CLOSING_GROUPS)[number];

export const CHANNEL_GROUP: Record<ClosingChannelKey, ClosingGroupKey> = {
  asesora: "humano",
  recompra_auto: "automatizacion",
  bot_kapso: "automatizacion",
  bot_externo: "automatizacion",
  web: "web",
  otros: "otros",
};

export const CHANNEL_LABEL: Record<ClosingChannelKey, { title: string; sub: string }> = {
  asesora: { title: "Asesora", sub: "registró la venta en el dashboard" },
  recompra_auto: { title: "Recompra automática", sub: "pedido de la prueba de recompra; nadie lo cerró" },
  bot_kapso: { title: "Bot de Kapso", sub: "lo cerró el bot de WhatsApp (etiqueta kapso)" },
  bot_externo: { title: "Bot de carritos externo", sub: "etiquetas BOT / CARRITO RECUPERADO" },
  web: { title: "Web, la clienta sola", sub: "formulario contraentrega de EasySell" },
  otros: { title: "Otros", sub: "catálogo de WhatsApp, pedidos hechos a mano en Shopify…" },
};

export const GROUP_LABEL: Record<ClosingGroupKey, string> = {
  humano: "Asesora",
  automatizacion: "Bot o automatización",
  web: "La clienta sola en la web",
  otros: "Otros",
};

/** Lo que devuelve la función por tienda y canal. */
export interface ClosingChannelRow {
  storeId: string;
  channel: ClosingChannelKey;
  orders: number;
  revenue: number;
  cancelled: number;
  /** De los activos que NO cerró una asesora: una asesora gestionó a la clienta en los 7 días previos. */
  assisted: number;
  assistedRevenue: number;
}

export interface ChannelFigures {
  orders: number;
  revenue: number;
  cancelled: number;
  assisted: number;
  assistedRevenue: number;
}

export interface ClosingChannelSummary {
  byChannel: Record<ClosingChannelKey, ChannelFigures>;
  byGroup: Record<ClosingGroupKey, ChannelFigures>;
  total: ChannelFigures;
}

/**
 * Lo que el panel recibe: el resumen, o por qué no lo hay. Un error se dice;
 * nunca se vuelve ceros.
 *
 * `coverageFrom`: Kapta guarda TODOS los pedidos de la tienda solo desde
 * `ORDERS_SYNC_FROM` (2026-06-01); antes solo los del bot y las ventas que
 * registraron las asesoras. Si el rango empieza antes, se cuenta desde esa fecha
 * y el panel lo dice; si termina antes, no hay con qué responder
 * (`sin_cobertura`) y vuelve la vista anterior.
 */
export type ClosingChannelResult =
  | { status: "ok"; summary: ClosingChannelSummary; coverageFrom: string | null }
  | { status: "sin_cobertura"; coverageFrom: string }
  | { status: "sin_migracion" }
  | { status: "error"; message: string };

/**
 * El rango que se le pide a la función, recortado a la cobertura. `clipped`
 * dice si se recortó; `null` si el rango entero cae antes de la cobertura.
 */
export function clampToCoverage(
  range: { from: string; to: string },
  coverageFrom: string,
): { from: string; to: string; clipped: boolean } | null {
  if (range.to < coverageFrom) return null;
  return range.from < coverageFrom
    ? { from: coverageFrom, to: range.to, clipped: true }
    : { from: range.from, to: range.to, clipped: false };
}

const zero = (): ChannelFigures => ({ orders: 0, revenue: 0, cancelled: 0, assisted: 0, assistedRevenue: 0 });
const round2 = (n: number) => Math.round(n * 100) / 100;

const finite = (value: unknown): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const isChannel = (v: unknown): v is ClosingChannelKey =>
  typeof v === "string" && (CLOSING_CHANNELS as readonly string[]).includes(v);

/**
 * El jsonb de `canal_de_cierre` → filas tipadas. Una fila con un canal que no
 * conocemos (una versión nueva de la función con un canal más) se suma a
 * «otros» en vez de perderse: el total tiene que seguir cuadrando.
 */
export function parseClosingChannels(data: unknown): ClosingChannelRow[] {
  const filas = (data as { filas?: unknown } | null)?.filas;
  if (!Array.isArray(filas)) return [];
  return filas.map((raw) => {
    const r = raw as Record<string, unknown>;
    return {
      storeId: String(r.store_id ?? ""),
      channel: isChannel(r.canal) ? r.canal : "otros",
      orders: Math.trunc(finite(r.pedidos)),
      revenue: finite(r.ingresos),
      cancelled: Math.trunc(finite(r.cancelados)),
      assisted: Math.trunc(finite(r.ayudados)),
      assistedRevenue: finite(r.ingresos_ayudados),
    };
  });
}

function add(into: ChannelFigures, r: ChannelFigures) {
  into.orders += r.orders;
  into.revenue += r.revenue;
  into.cancelled += r.cancelled;
  into.assisted += r.assisted;
  into.assistedRevenue += r.assistedRevenue;
}

function rounded(f: ChannelFigures): ChannelFigures {
  return { ...f, revenue: round2(f.revenue), assistedRevenue: round2(f.assistedRevenue) };
}

/**
 * Suma las tiendas. Cada pedido está en UN canal, así que Σ canales = Σ grupos =
 * total, por construcción; la asesora nunca trae «ayudados» (ayudar a su propia
 * venta no es ayudar), y si la función los mandara se ignoran.
 */
export function summarizeClosingChannels(rows: readonly ClosingChannelRow[]): ClosingChannelSummary {
  const byChannel = Object.fromEntries(CLOSING_CHANNELS.map((c) => [c, zero()])) as Record<ClosingChannelKey, ChannelFigures>;
  for (const r of rows) {
    const assisted = r.channel === "asesora" ? 0 : r.assisted;
    const assistedRevenue = r.channel === "asesora" ? 0 : r.assistedRevenue;
    add(byChannel[r.channel], { ...r, assisted, assistedRevenue });
  }
  const byGroup = Object.fromEntries(CLOSING_GROUPS.map((g) => [g, zero()])) as Record<ClosingGroupKey, ChannelFigures>;
  const total = zero();
  for (const c of CLOSING_CHANNELS) {
    add(byGroup[CHANNEL_GROUP[c]], byChannel[c]);
    add(total, byChannel[c]);
  }
  return {
    byChannel: Object.fromEntries(CLOSING_CHANNELS.map((c) => [c, rounded(byChannel[c])])) as Record<ClosingChannelKey, ChannelFigures>,
    byGroup: Object.fromEntries(CLOSING_GROUPS.map((g) => [g, rounded(byGroup[g])])) as Record<ClosingGroupKey, ChannelFigures>,
    total: rounded(total),
  };
}

/**
 * ¿El error de PostgREST dice que la función todavía no existe? Deploy no
 * aplica migraciones (AGENTS.md): si el código sale antes que la 0257, el panel
 * muestra la vista anterior con un aviso, no un error ni ceros.
 */
export function isMissingFunctionError(error: { code?: string | null; message?: string | null } | null | undefined): boolean {
  if (!error) return false;
  if (error.code === "PGRST202" || error.code === "42883") return true;
  return /could not find the function|function .* does not exist/i.test(error.message ?? "");
}
