// Canal de cierre de TODAS las ventas de la tienda (MOM §17.3).
//
// La clasificación vive en Postgres (`canal_de_cierre`, migración 0258): allí
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
 * Desde cuándo responde el canal y por qué (MOM §17.3, «Desde cuándo
 * responde»). El canal solo es verdad desde que Kapta tiene, a la vez, todos
 * los pedidos de la tienda (`ORDERS_SYNC_FROM`) y las ventas que registran sus
 * asesoras (el inicio de la tienda en Kapta: el día local de su primera fila de
 * `order_sales` o, sin ninguna, de su primer lead). Antes, una venta de asesora
 * no tenía dónde registrarse y caería en «Web» u «Otros»: medido, una tienda
 * tenía 3.898 pedidos en junio de 2026 y su primera venta registrada es del
 * 04-07.
 */
export interface ClosingCoverage {
  /**
   * Día local desde el que cuenta. En `ok`, solo si recortó el periodo (si no,
   * null); en `sin_cobertura`, el día que haría falta, o null si ninguna de las
   * tiendas usa Kapta todavía.
   */
  from: string | null;
  /** Qué fijó ese día: `sync` = ORDERS_SYNC_FROM; `tienda` = el inicio de `storeId` en Kapta. */
  cause: "sync" | "tienda" | null;
  storeId: string | null;
  /** Tiendas pedidas que todavía no usan Kapta (sin ventas registradas ni leads): fuera del conteo. */
  excluded: string[];
  /**
   * Se cuenta más de una tienda (el día es el de la que empezó último); si
   * ninguna usa Kapta, se pidió más de una.
   */
  multiStore: boolean;
}

/**
 * Lo que el panel recibe: el resumen, o por qué no lo hay. Un error se dice;
 * nunca se vuelve ceros. Tampoco un periodo sin cobertura: vuelve la vista
 * anterior con su aviso (`sin_cobertura`).
 */
export type ClosingChannelResult =
  | { status: "ok"; summary: ClosingChannelSummary; coverage: ClosingCoverage }
  | { status: "sin_cobertura"; coverage: ClosingCoverage }
  | { status: "sin_migracion" }
  | { status: "error"; message: string };

/** El plan de cobertura de las tiendas pedidas, antes de mirar el periodo. */
export interface CoveragePlan {
  /** Las tiendas que entran en el conteo: las que ya usan Kapta. */
  counted: string[];
  /** El día desde el que cuentan todas ellas; null si ninguna usa Kapta. */
  from: string | null;
  cause: ClosingCoverage["cause"];
  storeId: string | null;
  excluded: string[];
  multiStore: boolean;
}

/**
 * Decide desde qué día responde el canal para estas tiendas. Cada tienda empieza
 * el día que empezó a usar Kapta (`start`; null = todavía no lo usa, y queda
 * fuera del conteo). El día es el más tardío entre `ORDERS_SYNC_FROM` y el inicio
 * de cada tienda contada: con varias tiendas manda la que empezó último, para
 * que el total sea de un solo periodo.
 */
export function planCoverage(syncFrom: string, stores: readonly { id: string; start: string | null }[]): CoveragePlan {
  const counted = stores.filter((s): s is { id: string; start: string } => s.start != null);
  const excluded = stores.filter((s) => s.start == null).map((s) => s.id);
  if (!counted.length) return { counted: [], from: null, cause: null, storeId: null, excluded, multiStore: stores.length > 1 };
  const multiStore = counted.length > 1;
  const last = counted.reduce((a, b) => (b.start > a.start ? b : a));
  return last.start > syncFrom
    ? { counted: counted.map((s) => s.id), from: last.start, cause: "tienda", storeId: last.id, excluded, multiStore }
    : { counted: counted.map((s) => s.id), from: syncFrom, cause: "sync", storeId: null, excluded, multiStore };
}

const joinNames = (names: string[]) =>
  names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} y ${names[names.length - 1]}`;

function excludedLine(cov: ClosingCoverage, name: (id: string) => string): string | null {
  if (!cov.excluded.length) return null;
  const n = cov.excluded.length;
  return `${joinNames(cov.excluded.map(name))} todavía no ${n > 1 ? "usan" : "usa"} Kapta (sin ventas registradas ni leads): sus pedidos no entran en este total.`;
}

/**
 * Los textos de la cobertura cuando hay resumen: el aviso del panel (título y
 * cuerpo) y las coletillas de la tarjeta («desde el …», «sin …»). Nada si se
 * contó el periodo entero con todas las tiendas.
 */
export function coverageCopy(
  cov: ClosingCoverage,
  name: (id: string) => string,
  day: (iso: string) => string,
): { title: string | null; body: string | null; sub: string[] } {
  const excl = excludedLine(cov, name);
  const sinTiendas = cov.excluded.length ? [`sin ${joinNames(cov.excluded.map(name))}`] : [];
  if (!cov.from) {
    return excl ? { title: "No entran todas las tiendas", body: excl, sub: sinTiendas } : { title: null, body: null, sub: [] };
  }
  const reason =
    cov.cause === "tienda" && cov.storeId
      ? cov.multiStore
        ? `Ese día empezó a usar Kapta ${name(cov.storeId)}, la última de las tiendas. Antes, sus ventas de asesora no tenían dónde registrarse y caerían en «Web» u «Otros»; para que el total sea de un solo periodo, todas las tiendas cuentan desde ese día. La página de cada tienda cuenta desde su propio inicio.`
        : `Ese día ${name(cov.storeId)} empezó a usar Kapta. Antes, una venta de asesora no tenía dónde registrarse y caería en «Web» u «Otros», así que los días anteriores del periodo no entran aquí.`
      : "Antes de ese día Kapta no tiene los pedidos que no son del bot, así que los días anteriores del periodo no entran aquí.";
  return {
    title: `Cuenta desde el ${day(cov.from)}`,
    body: excl ? `${reason} ${excl}` : reason,
    sub: [`desde el ${day(cov.from)}`, ...sinTiendas],
  };
}

/** El aviso de la vista de respaldo cuando el periodo no tiene cobertura, y la coletilla de la tarjeta. */
export function noCoverageCopy(
  cov: ClosingCoverage,
  name: (id: string) => string,
  day: (iso: string) => string,
): { note: string; sub: string } {
  const back = " Esto es la vista anterior: solo los pedidos del bot de Kapso.";
  if (!cov.from) {
    return cov.multiStore
      ? {
          note: `Ninguna de estas tiendas usa Kapta todavía (sin ventas registradas ni leads): no hay con qué decir quién cerró cada venta.${back}`,
          sub: "Las tiendas todavía no usan Kapta",
        }
      : {
          note: `Esta tienda todavía no usa Kapta (sin ventas registradas ni leads): no hay con qué decir quién cerró cada venta.${back}`,
          sub: "La tienda todavía no usa Kapta",
        };
  }
  const desde = `El canal de todas las ventas cuenta desde el ${day(cov.from)}`;
  const why =
    cov.cause === "tienda" && cov.storeId
      ? cov.multiStore
        ? `${desde}, el día en que empezó a usar Kapta ${name(cov.storeId)}, la última de las tiendas; la página de cada tienda cuenta desde su propio inicio.`
        : `${desde}, el día en que ${name(cov.storeId)} empezó a usar Kapta: antes, una venta de asesora no tenía dónde registrarse.`
      : `${desde}: antes Kapta no tiene los pedidos que no son del bot.`;
  return { note: `${why} Para este periodo no hay con qué decir quién cerró cada venta.${back}`, sub: "Periodo anterior a que Kapta tuviera todas las ventas" };
}

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
 * aplica migraciones (AGENTS.md): si el código sale antes que la 0258, el panel
 * muestra la vista anterior con un aviso, no un error ni ceros.
 */
export function isMissingFunctionError(error: { code?: string | null; message?: string | null } | null | undefined): boolean {
  if (!error) return false;
  if (error.code === "PGRST202" || error.code === "42883") return true;
  return /could not find the function|function .* does not exist/i.test(error.message ?? "");
}
