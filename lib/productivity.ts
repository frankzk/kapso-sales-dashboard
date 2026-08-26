// Productividad por asesora en un rango. DOS FUENTES, a propósito:
//
//   • el TRABAJO (llamadas, leads trabajados, horas activas) sale de `lead_calls`;
//   • el CIERRE (cerrados, ingresos) sale de `order_sales`, la venta registrada
//     en el instante en que la asesora apretó el botón.
//
// Antes las dos salían de `lead_calls` y el cierre se DEDUCÍA —"el último que
// tocó un lead ganado"—, que es por lo que las ventas se movían solas: un
// mensaje de cortesía treinta segundos después de la venta se la llevaba, y una
// clienta recurrente arrastraba la compra vieja al mes siguiente. Quién vendió y
// quién trabajó el lead son dos preguntas distintas; ahora tienen dos respuestas.
//
// La agregación pura va separada del fetch para poder probarla.

import { createServerSupabase, createAdminSupabase } from "@/lib/db";
import { tzParts } from "@/lib/metrics";
import { chunk, defaultRange, parseRange, previousRange, type DateRange } from "@/lib/access";
import { onlineVendedoraIds } from "@/lib/presence";
import { leadSegment, type LeadSegment } from "@/lib/leads";

const DB_READ_CONCURRENCY = 4;

/** Keep independent PostgREST reads concurrent without opening an unbounded
 * number of connections on large ranges. */
async function mapInBatches<T, R>(
  items: T[],
  worker: (item: T) => Promise<R>,
  concurrency = DB_READ_CONCURRENCY,
): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += concurrency) {
    out.push(...(await Promise.all(items.slice(i, i + concurrency).map(worker))));
  }
  return out;
}

/** Minutes to ADD to UTC to reach local time in `tz` at `date` (Lima → −300). */
export function tzOffsetMinutes(date: Date, tz: string): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const m: Record<string, string> = {};
  for (const p of dtf.formatToParts(date)) m[p.type] = p.value;
  const asUtc = Date.UTC(+m.year!, +m.month! - 1, +m.day!, +(m.hour === "24" ? "0" : m.hour!), +m.minute!, +m.second!);
  return Math.round((asUtc - date.getTime()) / 60000);
}

/** UTC ISO bounds of the local-day range [from..to] (YYYY-MM-DD) in `tz`. "Today"
 *  must mean the STORE's local day, not a UTC day — otherwise the prior evening's
 *  activity (e.g. Lima 19:00–23:59 = UTC 00:00–04:59) leaks into it. */
export function localRangeBoundsIso(from: string, to: string, tz: string): { startIso: string; endIso: string } {
  const offFrom = tzOffsetMinutes(new Date(`${from}T12:00:00Z`), tz);
  const offTo = tzOffsetMinutes(new Date(`${to}T12:00:00Z`), tz);
  const startMs = new Date(`${from}T00:00:00Z`).getTime() - offFrom * 60_000;
  const endMs = new Date(`${to}T00:00:00Z`).getTime() - offTo * 60_000 + 86_400_000 - 1;
  return { startIso: new Date(startMs).toISOString(), endIso: new Date(endMs).toISOString() };
}

/** One attributed win, for drill-down UIs (tooltip "qué pedidos generó"). */
export interface WonOrderRef {
  name: string | null; // order code, e.g. "#AUR1091" (null = order not ingested/linked yet)
  at: string | null; // order created_at ISO
}

/** The acquisition-source buckets a won order can be attributed to. `meta_ad` =
 *  provable Click-to-WhatsApp ad click (has ad_id); `fb_web` = reached WhatsApp
 *  via a Facebook/IG web link (paid or organic, no ad_id). */
export type SourceBucket = "meta_ad" | "fb_web" | "cod_cart" | "abandoned_browse" | "organic";
export const SOURCE_BUCKETS: SourceBucket[] = ["meta_ad", "fb_web", "cod_cart", "abandoned_browse", "organic"];

/** One advisor×source cell: how many orders closed and their net revenue. */
export interface SourceCell {
  cerrados: number;
  ingresos: number;
}

/** One advisor×store cell: pedidos cerrados DE cuántos leads trabajados en esa
 *  tienda (el "5/30" de los chips) + los ingresos de esos cierres. */
export interface StoreCell {
  leads: number; // leads distintos trabajados de esa tienda
  cerrados: number;
  ingresos: number;
}

/** A zeroed per-source breakdown (all four buckets present, so the matrix table
 *  can render every column without null checks). */
export function emptyPorFuente(): Record<SourceBucket, SourceCell> {
  return {
    meta_ad: { cerrados: 0, ingresos: 0 },
    fb_web: { cerrados: 0, ingresos: 0 },
    cod_cart: { cerrados: 0, ingresos: 0 },
    abandoned_browse: { cerrados: 0, ingresos: 0 },
    organic: { cerrados: 0, ingresos: 0 },
  };
}

export interface AdvisorStat {
  userId: string;
  email: string;
  llamadas: number; // calls of kind="call"
  leadsTrabajados: number; // distinct leads touched
  cerrados: number; // ventas REGISTRADAS por ella en el rango (`order_sales`)
  cerradosDetalle: WonOrderRef[]; // the orders behind `cerrados`, oldest first
  ingresos: number; // net revenue (total - refunded) of those orders
  porFuente: Record<SourceBucket, SourceCell>; // cerrados+ingresos split by acquisition source
  porTienda: Record<string, StoreCell>; // leads trabajados + cerrados + ingresos por tienda
  conversion: number; // cerrados / leadsTrabajados, 0..1
  horas: number; // active hours inferred from action timestamps (idle-gap-split)
  dias: number; // distinct days with logged activity
}

/** Sigla corta de una tienda para chips: "Kenku Peru" → "KP", "Aurela" → "AUR". */
export function storeInitials(name: string | null | undefined): string {
  const words = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (!words.length) return "?";
  if (words.length === 1) return words[0]!.slice(0, 3).toUpperCase();
  return words
    .map((w) => w[0]!.toUpperCase())
    .join("")
    .slice(0, 3);
}

/** `kind`s de `lead_calls` que NO son trabajo de venta: anotaciones de máquina.
 *  Agregar acá cualquier `kind` nuevo que escriba el sistema y no una persona. */
const NON_SALES_KINDS = new Set(["system"]);

/**
 * ¿Este toque es TRABAJO sobre el lead?
 *
 * Decide qué cuenta como "lead trabajado", el denominador del % de cierre. Deja
 * fuera las notas de máquina que lleva firmadas un click humano — en concreto
 * `resolveHandoff` ("✅ Handoff resuelto"), que por su propia definición no es
 * trabajar el lead: no cambia status/category y existe para sacar de la cola
 * handoffs que no llevan a nada. Contarlo inflaba el denominador de quien ordena
 * la cola y le hundía el porcentaje por ser ordenada.
 *
 * La regla se apoya en lo que `kind` YA significa: en 60 días `call`, `message`
 * y `sale` vienen firmados el 100% de las veces (son personas), y de las 25 029
 * filas `system` solo 1 166 llevan firma, todas con el MISMO texto: el click de
 * "Resuelto". O sea `kind` ya es exactamente la frontera persona/máquina.
 *
 * YA NO DECIDE DE QUIÉN ES LA VENTA. Eso lo dice `order_sales`, que guarda quién
 * la registró. Cuando esta función gobernaba la atribución hacía falta para que
 * un click no moviera S/ 250 de una asesora a otra (#KP121762); hoy esa puerta
 * está cerrada por diseño y esto solo mide trabajo.
 *
 * Tampoco gobierna las horas activas: un click de "Resuelto" es prueba legítima
 * de que la asesora estaba conectada, así que `timesByAgentDay` sigue contándolo.
 */
export function isSalesTouch(kind: string | null | undefined): boolean {
  return !NON_SALES_KINDS.has((kind ?? "").trim());
}

/** Canonical acquisition-source bucket for a lead's `source`. */
function sourceKey(s: string | null | undefined): SourceBucket {
  return s === "meta_ad"
    ? "meta_ad"
    : s === "fb_web"
      ? "fb_web"
      : s === "cod_cart"
        ? "cod_cart"
        : s === "abandoned_browse"
          ? "abandoned_browse"
          : "organic";
}

export interface AdvisorCall {
  vendedora: string;
  lead_id: string;
  kind: string;
  occurred_at: string;
}

/** Advisor lead_calls in [startIso..endIso], PAGED past PostgREST's silent
 *  max-rows cap. A bare `.select()` tops out at ~1000 rows, so a busy store's
 *  30d window lost most of its calls — and the follow-up `.in("id", leadIds)`
 *  lookup then failed outright on the oversized URL, which is how the board
 *  once showed 830 llamadas · 0 cerrados · S/ 0. Stable (occurred_at, id)
 *  ordering keeps pages from overlapping or skipping. Best-effort: stops at
 *  the first page error, returning what it has. */
async function fetchAdvisorLeadCallsPaged(
  sb: Awaited<ReturnType<typeof createServerSupabase>>,
  storeIds: string[],
  startIso: string,
  endIso: string,
  vendedoraId?: string,
): Promise<AdvisorCall[]> {
  const PAGE = 1000;
  const CAP = 40000; // safety bound: ~40 pages even on a runaway store
  const PAGE_WINDOW = 4;
  const calls: AdvisorCall[] = [];
  for (let from = 0; from < CAP; from += PAGE * PAGE_WINDOW) {
    const offsets = Array.from(
      { length: Math.min(PAGE_WINDOW, Math.ceil((CAP - from) / PAGE)) },
      (_, index) => from + index * PAGE,
    );
    const pages = await Promise.all(
      offsets.map((offset) => {
        const base = sb
          .from("lead_calls")
          .select("vendedora, lead_id, kind, occurred_at")
          .in("store_id", storeIds)
          .gte("occurred_at", startIso)
          .lte("occurred_at", endIso);
        return (vendedoraId
          ? base.eq("vendedora", vendedoraId)
          : base.not("vendedora", "is", null))
          .order("occurred_at", { ascending: false })
          .order("id", { ascending: false })
          .range(offset, offset + PAGE - 1);
      }),
    );
    for (const { data, error } of pages) {
      if (error) return calls;
      const batch = (data as AdvisorCall[]) ?? [];
      calls.push(...batch);
      if (batch.length < PAGE) return calls;
    }
  }
  return calls;
}

// ── Presets de rango en día LOCAL de la tienda ────────────────────────────────
// Un preset con fecha UTC se corre de día a las 19:00 de Lima (UTC−5): "Hoy"
// apuntaba al día local siguiente y el tablero salía vacío por la noche.

/** Single-day range `offset` days back, in the STORE's local calendar (0 = hoy). */
export function localDayPreset(offset: number, tz: string, nowIso = new Date().toISOString()): DateRange {
  const d = tzParts(new Date(Date.parse(nowIso) - offset * 86_400_000).toISOString(), tz).date;
  return { from: d, to: d };
}

/** Productividad opens on the store-local current day unless the URL carries
 * an explicit range. Preset links always include both dates, so navigating
 * between stores/sources keeps the range the user selected. */
export function productivityInitialRange(
  sp: { from?: string; to?: string },
  tz: string,
  nowIso = new Date().toISOString(),
): DateRange {
  if (!sp.from && !sp.to) return localDayPreset(0, tz, nowIso);
  return parseRange(sp);
}

/** Last `days` local days ending today (inclusive), in the store's tz.
 * Delegates to `defaultRange` so each multi-day preset remains anchored to the
 * same local calendar used by the single-day presets. */
export function localPresetRange(days: number, tz: string, nowIso = new Date().toISOString()): DateRange {
  return defaultRange(days, tz, nowIso);
}

// ── Actividad por hora (heatmap "¿está conectada trabajando?") ────────────────

export const HEAT_START = 7; // business shift, aligned with the leads burndown
export const HEAT_END = 21; // inclusive → 15 cells

export interface HourlyActivity {
  /** userId → 15 celdas (horas locales 07..21) con LEADS/ENVÍOS DISTINTOS gestionados. */
  byAgent: Record<string, number[]>;
  /** Máximo global (≥ 1) para que todas las filas compartan la escala de color. */
  max: number;
  /** "day" = distintos de un solo día; "avg" = promedio de distintos/día (multi-día). */
  mode: "day" | "avg";
}

/** Hourly DISTINCT leads (or shipments) each advisor worked, from any registered
 *  human event (calls, sales, WhatsApp messages, shipment gestiones). `ref` is
 *  the unit of gestión (lead_id / shipment_id): 3 messages to the same lead in
 *  one hour count as 1 — raw action counts reward busywork, distinct leads
 *  don't. Dedupe is per (hour, LOCAL DAY), so in avg mode the same lead worked
 *  at 10h on 7 different days contributes 1 per day (avg 1), not 1/7. Hours
 *  outside the 07–21 shift are DROPPED — folding them to the edges would
 *  fabricate fake 07h/21h peaks. Pure. */
export function computeHourlyActivity(opts: {
  events: { agent: string | null; occurred_at: string | null; ref: string }[];
  tz: string;
  rangeDays: number;
}): HourlyActivity {
  const cells = HEAT_END - HEAT_START + 1;
  const setsByAgent: Record<string, Set<string>[]> = {};
  for (const e of opts.events) {
    if (!e.agent || !e.occurred_at) continue;
    const p = tzParts(e.occurred_at, opts.tz);
    if (p.hour < HEAT_START || p.hour > HEAT_END) continue;
    const sets = (setsByAgent[e.agent] ??= Array.from({ length: cells }, () => new Set<string>()));
    sets[p.hour - HEAT_START]!.add(`${p.date}|${e.ref}`);
  }
  const mode: HourlyActivity["mode"] = opts.rangeDays > 1 ? "avg" : "day";
  const div = mode === "avg" ? Math.max(1, opts.rangeDays) : 1;
  const byAgent: Record<string, number[]> = {};
  let max = 1;
  for (const [agent, sets] of Object.entries(setsByAgent)) {
    const arr = sets.map((s) => (mode === "avg" ? Math.round((s.size / div) * 10) / 10 : s.size));
    byAgent[agent] = arr;
    for (const v of arr) if (v > max) max = v;
  }
  return { byAgent, max, mode };
}

// ── Tendencia diaria por asesora (sparkline de % cierre) ──────────────────────

export interface TrendCell {
  date: string; // YYYY-MM-DD local
  label: string; // "Lun"… / "Hoy"
  contactos: number; // kind="call" de la asesora ese día
  pedidos: number; // leads ganados acreditados a la asesora ese día
}

/** Daily contactos/pedidos series PER ADVISOR. Misma fuente que
 *  computeAdvisorStats para que el sparkline cuadre con "Cerrados": el pedido va
 *  a la asesora que REGISTRÓ la venta, el día en que la registró; contactos
 *  cuenta solo los kind="call" propios. Pura. */
export function computeAdvisorConversionByDay(opts: {
  calls: AdvisorCall[];
  sales: AdvisorSale[];
  days: { date: string; label: string }[];
  tz: string;
}): Record<string, TrendCell[]> {
  const idx = new Map(opts.days.map((d, i) => [d.date, i]));
  const series: Record<string, TrendCell[]> = {};
  const rowOf = (agent: string) =>
    (series[agent] ??= opts.days.map((d) => ({ date: d.date, label: d.label, contactos: 0, pedidos: 0 })));
  for (const c of opts.calls) {
    if (!c.vendedora || !c.occurred_at) continue;
    if (c.kind === "call") {
      const i = idx.get(tzParts(c.occurred_at, opts.tz).date);
      if (i != null) rowOf(c.vendedora)[i]!.contactos += 1;
    }
  }
  for (const s of opts.sales) {
    if (!s.vendedora || !s.occurredAt) continue;
    const i = idx.get(tzParts(s.occurredAt, opts.tz).date);
    if (i != null) rowOf(s.vendedora)[i]!.pedidos += 1;
  }
  return series;
}

// ── Velocidad de 1ª gestión (speed-to-lead) ──────────────────────────────────
// Cuánto tarda un lead recién llegado en recibir su PRIMERA gestión humana. Es
// la palanca clásica de conversión en COD: la probabilidad de contacto se
// desploma con cada hora sin llamada, y un carrito (formulario lleno) que se
// enfría es plata de ads perdida. Mediana — no promedio: un lead olvidado 3
// días no debe esconder al equipo rápido — más el % dentro de los 30 min.

export const FIRST_TOUCH_FAST_MIN = 30;

export interface FirstTouchLeadInput {
  id: string;
  created_at: string;
  category: string; // open | hot | won | lost | …
  cart: boolean; // cart_item_count > 0 o draft_order_gid presente
}

export interface FirstTouchCell {
  n: number; // leads del rango que YA recibieron su 1ª gestión humana
  medianMin: number | null; // mediana de minutos hasta esa 1ª gestión
  under30Pct: number | null; // % de gestionados dentro de FIRST_TOUCH_FAST_MIN
  sinGestionar: number; // creados en el rango AÚN en cola (open/hot) sin gestión
}

export interface FirstTouchStats {
  carritos: FirstTouchCell;
  resto: FirstTouchCell;
  /** Mediana por asesora sobre los leads que ELLA tocó primero — la mediana del
   *  equipo esconde a quien deja enfriar los leads frescos. */
  byAgent: Record<string, { medianMin: number | null; n: number }>;
}

export function emptyFirstTouchStats(): FirstTouchStats {
  const cell = (): FirstTouchCell => ({ n: 0, medianMin: null, under30Pct: null, sinGestionar: 0 });
  return { carritos: cell(), resto: cell(), byAgent: {} };
}

function medianOf(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  const m = s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
  return Math.round(m * 10) / 10;
}

/** "38 min" · "2.1 h" · "1.3 d" · "—" — formato compartido tarjeta/tabla. */
export function formatMinutes(min: number | null): string {
  if (min == null) return "—";
  if (min < 60) return `${Math.round(min)} min`;
  if (min < 1440) return `${(min / 60).toFixed(1)} h`;
  return `${(min / 1440).toFixed(1)} d`;
}

/**
 * Pure. `leads` = creados en el rango; `calls` = TODAS las gestiones humanas del
 * rango (SIN lente de fuente — mide disciplina operativa, como el heatmap). Un
 * lead ya cerrado (won/lost) sin gestión humana no cuenta en ningún lado: lo
 * cerró el bot o llegó por importación y no tiene historia de SLA. En rangos
 * históricos un lead cuya 1ª gestión cayó DESPUÉS del fin del rango aparece
 * como sinGestionar si sigue en cola; en las vistas vivas (Hoy/7d/30d hasta
 * hoy — el uso real del tablero) el corte es exacto. Un reloj desfasado
 * (gestión "antes" de la creación) se fija en 0.
 */
export function computeFirstTouchStats(opts: {
  leads: FirstTouchLeadInput[];
  calls: Pick<AdvisorCall, "vendedora" | "lead_id" | "occurred_at">[];
}): FirstTouchStats {
  const first = new Map<string, { at: number; vendedora: string }>();
  for (const c of opts.calls) {
    const t = Date.parse(c.occurred_at);
    if (!Number.isFinite(t)) continue;
    const cur = first.get(c.lead_id);
    if (!cur || t < cur.at) first.set(c.lead_id, { at: t, vendedora: c.vendedora });
  }
  const mins = { carritos: [] as number[], resto: [] as number[] };
  const pend = { carritos: 0, resto: 0 };
  const byAgentMins = new Map<string, number[]>();
  for (const l of opts.leads) {
    const key = l.cart ? ("carritos" as const) : ("resto" as const);
    const f = first.get(l.id);
    if (!f) {
      if (l.category === "open" || l.category === "hot") pend[key] += 1;
      continue;
    }
    const created = Date.parse(l.created_at);
    if (!Number.isFinite(created)) continue;
    const min = Math.max(0, (f.at - created) / 60_000);
    mins[key].push(min);
    (byAgentMins.get(f.vendedora) ?? byAgentMins.set(f.vendedora, []).get(f.vendedora)!).push(min);
  }
  const cell = (xs: number[], sinGestionar: number): FirstTouchCell => ({
    n: xs.length,
    medianMin: medianOf(xs),
    under30Pct: xs.length
      ? Math.round((100 * xs.filter((m) => m <= FIRST_TOUCH_FAST_MIN).length) / xs.length)
      : null,
    sinGestionar,
  });
  const byAgent: FirstTouchStats["byAgent"] = {};
  for (const [id, xs] of byAgentMins) byAgent[id] = { medianMin: medianOf(xs), n: xs.length };
  return { carritos: cell(mins.carritos, pend.carritos), resto: cell(mins.resto, pend.resto), byAgent };
}

/**
 * Una venta REGISTRADA (`order_sales`), que es de dónde sale ahora el cierre.
 *
 * Antes el cierre se deducía —"el último que tocó un lead ganado"— y por eso se
 * movía solo. Esto es un hecho guardado en el instante de la venta: quién,
 * cuándo, qué pedido y cuánto. No se recalcula, así que no se mueve.
 */
export interface AdvisorSale {
  vendedora: string;
  orderId: string;
  /** ISO del instante de la venta (`order_sales.occurred_at`). */
  occurredAt: string;
  storeId: string | null;
  /** Neto del pedido: total − reembolsado. */
  net: number;
  orderName: string | null;
  orderAt: string | null;
  source: SourceBucket;
}

export interface ProductivityInput {
  calls: AdvisorCall[];
  /** Las ventas registradas en el rango. El cierre y los ingresos salen de acá. */
  sales: AdvisorSale[];
  /** Tienda de cada lead tocado — el DENOMINADOR de los chips por tienda. Ya no
   *  lleva el resultado del lead: quién cerró qué lo dice `sales`. */
  leadStore: Map<string, string | null | undefined>;
  emailById: Map<string, string>;
}

const ACTIVE_GAP_MS = 45 * 60 * 1000; // a gap >45 min splits work blocks (lunch/break)

/** Active hours from sorted action timestamps (ms), summing blocks split on idle
 *  gaps. A lone action contributes ~0 (can't infer a span from one point). */
function activeHoursFromTimes(sorted: number[]): number {
  if (sorted.length < 2) return 0;
  let total = 0;
  let blockStart = sorted[0]!;
  let prev = sorted[0]!;
  for (let i = 1; i < sorted.length; i++) {
    const t = sorted[i]!;
    if (t - prev > ACTIVE_GAP_MS) {
      total += prev - blockStart;
      blockStart = t;
    }
    prev = t;
  }
  total += prev - blockStart;
  return total / 3_600_000;
}

/**
 * Actividad por asesora + sus ventas REGISTRADAS + horas activas inferidas del
 * reparto de sus marcas de tiempo por día local. Pura.
 *
 * El cierre ya no se deduce de los toques: viene de `order_sales`, escrito en el
 * instante de la venta. Lo que sale de `calls` es lo que de verdad son toques
 * —llamadas, leads trabajados y presencia—, y nada más.
 *
 * Las dos mitades no se mezclan A PROPÓSITO. Antes el numerador (cierres) y el
 * denominador (leads trabajados) salían de la misma fuente, y por eso un mensaje
 * de cortesía movía los dos a la vez. Ahora el cierre lo decide quién apretó el
 * botón y el trabajo lo decide quién tocó el lead, que son dos preguntas
 * distintas y merecen dos respuestas distintas.
 */
export function computeAdvisorStats(
  { calls, sales, leadStore, emailById }: ProductivityInput,
  tz = "America/Lima",
): AdvisorStat[] {
  const agg = new Map<string, { llamadas: number; leads: Set<string> }>();
  const timesByAgentDay = new Map<string, number[]>(); // `${agent}|${localDate}` → ms[]

  for (const c of calls) {
    if (!c.vendedora) continue;
    const a = agg.get(c.vendedora) ?? { llamadas: 0, leads: new Set<string>() };
    if (c.kind === "call") a.llamadas += 1;
    // Solo el trabajo de venta cuenta como "lead trabajado": ordenar la cola con
    // "Resuelto" no es trabajar el lead, y si contara inflaría el denominador del
    // % cierre de quien ordena. La asesora sigue apareciendo en el tablero por
    // sus horas activas aunque su único registro del día sea ese click.
    if (isSalesTouch(c.kind)) a.leads.add(c.lead_id);
    agg.set(c.vendedora, a);

    const ms = new Date(c.occurred_at).getTime();
    if (Number.isFinite(ms)) {
      const k = `${c.vendedora}|${tzParts(c.occurred_at, tz).date}`;
      const arr = timesByAgentDay.get(k) ?? [];
      arr.push(ms);
      timesByAgentDay.set(k, arr);
    }
  }

  const hoursByAgent = new Map<string, { horas: number; dias: Set<string> }>();
  for (const [k, times] of timesByAgentDay) {
    const sep = k.indexOf("|");
    const agent = k.slice(0, sep);
    const day = k.slice(sep + 1);
    times.sort((x, y) => x - y);
    const e = hoursByAgent.get(agent) ?? { horas: 0, dias: new Set<string>() };
    e.horas += activeHoursFromTimes(times);
    e.dias.add(day);
    hoursByAgent.set(agent, e);
  }

  type WonAgg = {
    cerrados: number;
    ingresos: number;
    detalle: WonOrderRef[];
    porFuente: Record<SourceBucket, SourceCell>;
    porTienda: Record<string, SourceCell>;
  };
  const emptyWon = (): WonAgg => ({ cerrados: 0, ingresos: 0, detalle: [], porFuente: emptyPorFuente(), porTienda: {} });
  const won = new Map<string, WonAgg>();
  // Una fila de `order_sales` = un cierre. Ni se busca a quién tocó el lead ni
  // se pregunta si sigue `won`: la venta ocurrió y tiene dueña.
  for (const s of sales) {
    if (!s.vendedora) continue;
    const w = won.get(s.vendedora) ?? emptyWon();
    w.cerrados += 1;
    w.ingresos += s.net;
    w.porFuente[s.source].cerrados += 1;
    w.porFuente[s.source].ingresos += s.net;
    const t = (w.porTienda[s.storeId ?? "otras"] ??= { cerrados: 0, ingresos: 0 });
    t.cerrados += 1;
    t.ingresos += s.net;
    w.detalle.push({ name: s.orderName, at: s.orderAt });
    won.set(s.vendedora, w);
  }

  // Una asesora que SOLO vendió en el rango —sin registrar toques— tiene que
  // salir igual: si el tablero se armara solo desde `calls`, su venta
  // desaparecería de la vista sin dejar de existir en la base.
  for (const userId of won.keys()) {
    if (!agg.has(userId)) agg.set(userId, { llamadas: 0, leads: new Set<string>() });
  }

  const rows: AdvisorStat[] = [];
  for (const [userId, a] of agg) {
    const w = won.get(userId) ?? emptyWon();
    const h = hoursByAgent.get(userId);
    const leadsTrabajados = a.leads.size;
    // Por tienda: el DENOMINADOR son los leads distintos que la asesora trabajó
    // de esa tienda (`leadStore` trae el store de cada lead tocado — sin fetch
    // extra); encima se montan los cierres/ingresos de las ventas registradas.
    // Así los chips pueden decir "AUR 5/30" y no solo "AUR 5".
    const porTienda: Record<string, StoreCell> = {};
    for (const leadId of a.leads) {
      const sid = leadStore.get(leadId) ?? "otras";
      (porTienda[sid] ??= { leads: 0, cerrados: 0, ingresos: 0 }).leads += 1;
    }
    for (const [sid, cell] of Object.entries(w.porTienda)) {
      const t = (porTienda[sid] ??= { leads: 0, cerrados: 0, ingresos: 0 });
      t.cerrados = cell.cerrados;
      t.ingresos = cell.ingresos;
    }
    // Oldest first; wins without an ingested order (no date yet) go last.
    w.detalle.sort((x, y) => ((x.at ?? "9999") < (y.at ?? "9999") ? -1 : 1));
    rows.push({
      userId,
      email: emailById.get(userId) ?? userId,
      llamadas: a.llamadas,
      leadsTrabajados,
      cerrados: w.cerrados,
      cerradosDetalle: w.detalle,
      ingresos: w.ingresos,
      porFuente: w.porFuente,
      porTienda,
      conversion: leadsTrabajados ? w.cerrados / leadsTrabajados : 0,
      horas: Math.round((h?.horas ?? 0) * 10) / 10,
      dias: h?.dias.size ?? 0,
    });
  }
  rows.sort((x, y) => y.ingresos - x.ingresos || y.cerrados - x.cerrados || y.llamadas - x.llamadas);
  return rows;
}

// Process-level cache of user_id → email. Emails essentially never change, so a
// warm instance reuses it across requests (cold start just repopulates).
const emailCache = new Map<string, string>();

/** Resolve advisor user_ids → emails. One getUserById per *uncached* id, in
 *  parallel — far cheaper than paging the whole user list on every load. */
export async function resolveEmails(userIds: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (!userIds.length) return map;
  const missing = userIds.filter((id) => !emailCache.has(id));
  if (missing.length) {
    const admin = createAdminSupabase();
    await Promise.all(
      missing.map(async (id) => {
        try {
          const { data } = await admin.auth.admin.getUserById(id);
          emailCache.set(id, data?.user?.email ?? id);
        } catch {
          emailCache.set(id, id);
        }
      }),
    );
  }
  for (const id of userIds) map.set(id, emailCache.get(id) ?? id);
  return map;
}

/**
 * Las ventas REGISTRADAS del rango, con su pedido y su fuente de captación.
 *
 * Se pagina como todo lo demás: un `.select()` pelado tope a ~1000 filas en
 * silencio, y un mes movido pasa de eso. El rango se mide por `occurred_at` —el
 * instante en que la asesora apretó el botón—, no por la fecha del pedido: son
 * la misma hasta el segundo cuando la venta la genera el sistema, pero la que
 * responde "¿cuánto cerró esta asesora hoy?" es la del click.
 */
async function fetchAdvisorSalesPaged(
  sb: Awaited<ReturnType<typeof createServerSupabase>>,
  storeIds: string[],
  startIso: string,
  endIso: string,
): Promise<AdvisorSale[]> {
  const PAGE = 1000;
  const CAP = 40000;
  type Row = {
    order_id: string;
    store_id: string | null;
    vendedora: string;
    lead_id: string | null;
    occurred_at: string;
    orders: {
      name: string | null;
      created_at: string | null;
      total_amount: number | null;
      total_refunded: number | null;
    } | null;
  };
  const raw: Row[] = [];
  for (let from = 0; from < CAP; from += PAGE) {
    const { data, error } = await sb
      .from("order_sales")
      .select("order_id, store_id, vendedora, lead_id, occurred_at, orders(name, created_at, total_amount, total_refunded)")
      .in("store_id", storeIds)
      .gte("occurred_at", startIso)
      .lte("occurred_at", endIso)
      .order("occurred_at", { ascending: true })
      .order("order_id", { ascending: true }) // desempate estable: sin él las páginas se solapan
      .range(from, from + PAGE - 1);
    if (error) break; // best-effort, igual que el resto de los fetchers del tablero
    const batch = (data as unknown as Row[]) ?? [];
    raw.push(...batch);
    if (batch.length < PAGE) break;
  }
  if (!raw.length) return [];

  // La fuente de captación vive en el lead, y `order_sales.lead_id` no lleva FK
  // (es contexto, no integridad), así que no se puede embeber: se busca aparte.
  const leadIds = [...new Set(raw.map((r) => r.lead_id).filter((id): id is string => !!id))];
  const sourceByLead = new Map<string, string | null>();
  if (leadIds.length) {
    const pages = await mapInBatches(chunk(leadIds, 300), async (part) =>
      await sb.from("leads").select("id, source").in("id", part),
    );
    for (const { data } of pages) {
      for (const l of (data as { id: string; source: string | null }[]) ?? []) {
        sourceByLead.set(l.id, l.source);
      }
    }
  }

  return raw.map((r) => ({
    vendedora: r.vendedora,
    orderId: r.order_id,
    occurredAt: r.occurred_at,
    storeId: r.store_id,
    net: (r.orders?.total_amount ?? 0) - (r.orders?.total_refunded ?? 0),
    orderName: r.orders?.name ?? null,
    orderAt: r.orders?.created_at ?? null,
    source: sourceKey(r.lead_id ? sourceByLead.get(r.lead_id) : null),
  }));
}

/** From the range's advisor calls, resolve each touched lead's store and apply
 *  the optional source lens (to the calls AND to the registered sales). Shared by
 *  getAdvisorProductivity and getProductivityBoard so the board reuses the same
 *  (already paged) calls for metrics AND heatmap without a second fetch. */
async function buildAdvisorInputs(
  sb: Awaited<ReturnType<typeof createServerSupabase>>,
  calls: AdvisorCall[],
  source: SourceBucket | null,
  sales: AdvisorSale[] = [],
): Promise<{
  scopedCalls: AdvisorCall[];
  leadStore: ProductivityInput["leadStore"];
  scopedSales: AdvisorSale[];
}> {
  // Outcome of the touched leads, in chunks of 300 — hundreds of ids in one
  // `.in()` overflow the GET URL. `source` is selected with a fallback so a
  // pending 0008 migration can't break the page; it degrades ONCE and stays
  // degraded for the remaining chunks.
  const leadIds = [...new Set(calls.map((c) => c.lead_id))];
  type TouchedLead = { id: string; store_id: string; source?: string | null };
  let leadsTouched: TouchedLead[] = [];
  let sourceMissing = false;
  let loadedInParallel = false;
  const leadParts = chunk(leadIds, 300);
  const parallelLeadPages = await mapInBatches(leadParts, async (part) =>
    await sb
      .from("leads")
      .select("id, store_id, source")
      .in("id", part),
  );
  if (parallelLeadPages.every((page) => !page.error)) {
    leadsTouched = parallelLeadPages.flatMap(
      (page) => (page.data as unknown as TouchedLead[]) ?? [],
    );
    loadedInParallel = true;
  }
  if (!loadedInParallel) {
    for (const part of leadParts) {
      if (!sourceMissing) {
        const withSource = await sb
          .from("leads")
          .select("id, store_id, source")
          .in("id", part);
        if (!withSource.error) {
          leadsTouched.push(...((withSource.data as unknown as TouchedLead[]) ?? []));
          continue;
        }
        sourceMissing = true; // source column not present yet (migration 0008 pending) — degrade.
      }
      const base = await sb
        .from("leads")
        .select("id, store_id")
        .in("id", part);
      leadsTouched.push(...((base.data as unknown as TouchedLead[]) ?? []));
    }
  }

  // Lente de fuente: deja solo los toques Y las ventas de la fuente elegida. Las
  // ventas se filtran por SU PROPIA fuente (la del lead desde el que se vendió),
  // no por la de los leads tocados en el rango: una venta puede venir de un lead
  // que hoy nadie tocó, y seguir siendo de campaña.
  let scopedCalls = calls;
  let scopedSales = sales;
  if (source) {
    const allowed = new Set(leadsTouched.filter((l) => sourceKey(l.source) === source).map((l) => l.id));
    scopedCalls = calls.filter((c) => allowed.has(c.lead_id));
    leadsTouched = leadsTouched.filter((l) => allowed.has(l.id));
    scopedSales = sales.filter((s) => s.source === source);
  }

  const leadStore: ProductivityInput["leadStore"] = new Map();
  for (const l of leadsTouched) leadStore.set(l.id, l.store_id);
  return { scopedCalls, leadStore, scopedSales };
}

/** Fetch + aggregate per-advisor productivity for the stores/range (RLS-scoped).
 *  `source` optionally restricts to one acquisition source (campaña vs orgánico). */
export async function getAdvisorProductivity(
  storeIds: string[],
  range: DateRange,
  source: SourceBucket | null = null,
  tz = "America/Lima",
): Promise<AdvisorStat[]> {
  if (!storeIds.length) return [];
  const sb = await createServerSupabase();
  const { startIso, endIso } = localRangeBoundsIso(range.from, range.to, tz);

  // 1) Toques del rango (para llamadas/leads/horas) y ventas registradas (para
  //    cierres e ingresos). Son dos preguntas distintas y ahora dos fuentes.
  const [calls, sales] = await Promise.all([
    fetchAdvisorLeadCallsPaged(sb, storeIds, startIso, endIso),
    fetchAdvisorSalesPaged(sb, storeIds, startIso, endIso),
  ]);
  // Sin toques PERO con ventas el tablero sigue teniendo algo que decir: una
  // asesora puede haber vendido sin registrar ni una llamada.
  if (!calls.length && !sales.length) return [];

  // 2) Tienda de cada lead tocado + lente de fuente (helper compartido).
  const { scopedCalls, leadStore, scopedSales } = await buildAdvisorInputs(sb, calls, source, sales);
  if (!scopedCalls.length && !scopedSales.length) return [];

  const emailById = await resolveEmails([
    ...new Set([...scopedCalls.map((c) => c.vendedora), ...scopedSales.map((s) => s.vendedora)]),
  ]);
  return computeAdvisorStats({ calls: scopedCalls, sales: scopedSales, leadStore, emailById }, tz);
}

// ───────────────────────── Comparativo vs período anterior ─────────────────────

export interface ProductivityTotals {
  llamadas: number;
  leadsTrabajados: number;
  cerrados: number;
  ingresos: number;
}

export interface AdvisorDelta {
  llamadas: number; // current − previous (absolute)
  cerrados: number;
  ingresos: number;
  conversionPP: number; // change in % cierre, in percentage POINTS
  isNew: boolean; // no activity in the previous period (no baseline)
}

export interface AdvisorStatWithDelta extends AdvisorStat {
  delta: AdvisorDelta;
}

export interface ProductivityComparison {
  rows: AdvisorStatWithDelta[];
  prevTotals: ProductivityTotals; // team totals of the previous period (for arrows)
  prevRange: DateRange;
  hasPrev: boolean; // the previous period had any advisor activity (a baseline exists)
}

function sumTotals(rows: AdvisorStat[]): ProductivityTotals {
  return rows.reduce(
    (a, r) => ({
      llamadas: a.llamadas + r.llamadas,
      leadsTrabajados: a.leadsTrabajados + r.leadsTrabajados,
      cerrados: a.cerrados + r.cerrados,
      ingresos: Math.round((a.ingresos + r.ingresos) * 100) / 100,
    }),
    { llamadas: 0, leadsTrabajados: 0, cerrados: 0, ingresos: 0 },
  );
}

/** Per-advisor productivity for `range` plus deltas vs the equally-sized period
 *  immediately before it. Only current-active advisors are listed (the board
 *  shows who's working now); `prevTotals` captures team-level movement including
 *  advisors who dropped to zero. */
export async function getAdvisorProductivityCompare(
  storeIds: string[],
  range: DateRange,
  source: SourceBucket | null = null,
  tz = "America/Lima",
): Promise<ProductivityComparison> {
  const prevRange = previousRange(range);
  const [cur, prev] = await Promise.all([
    getAdvisorProductivity(storeIds, range, source, tz),
    getAdvisorProductivity(storeIds, prevRange, source, tz),
  ]);
  const { rows, prevTotals } = attachDeltas(cur, prev);
  return { rows, prevTotals, prevRange, hasPrev: prev.length > 0 };
}

/** Pure: attach per-advisor deltas (current − previous) and roll up the previous
 *  team totals. Advisors absent from `prev` are flagged `isNew` (no baseline). */
export function attachDeltas(
  cur: AdvisorStat[],
  prev: AdvisorStat[],
): { rows: AdvisorStatWithDelta[]; prevTotals: ProductivityTotals } {
  const prevById = new Map(prev.map((r) => [r.userId, r]));
  const rows: AdvisorStatWithDelta[] = cur.map((r) => {
    const p = prevById.get(r.userId);
    return {
      ...r,
      delta: {
        llamadas: r.llamadas - (p?.llamadas ?? 0),
        cerrados: r.cerrados - (p?.cerrados ?? 0),
        ingresos: Math.round((r.ingresos - (p?.ingresos ?? 0)) * 100) / 100,
        conversionPP: Math.round((r.conversion - (p?.conversion ?? 0)) * 1000) / 10,
        isNew: !p,
      },
    };
  });
  return { rows, prevTotals: sumTotals(prev) };
}

// ───────────────────────── Tablero de una pantalla ────────────────────────────

const WEEKDAYS = ["Dom", "Lun", "Mar", "Mié", "Jue", "Vie", "Sáb"];

export interface AdvisorBoardRow extends AdvisorStatWithDelta {
  heat: number[]; // 15 celdas, horas locales 07..21 (actividad, SIN lente de fuente)
  trend: TrendCell[]; // 7 días terminando en range.to (CON lente de fuente)
  online: boolean; // presencia al momento del render
  /** 1ª gestión de los leads del rango que ELLA tocó primero (sin lente). */
  primeraGestion: { medianMin: number | null; n: number };
}

export interface ProductivityBoardData {
  rows: AdvisorBoardRow[];
  prevTotals: ProductivityTotals;
  prevRange: DateRange;
  hasPrev: boolean;
  heatMax: number; // máximo global de la escala del heatmap
  heatMode: "day" | "avg";
  /** En línea AHORA pero sin actividad registrada en el rango — la señal clave
   *  para asesoras remotas ("conectada pero no está registrando nada"). */
  onlineIdle: { userId: string; email: string }[];
  /** Velocidad de 1ª gestión del rango (equipo, carritos vs resto). */
  firstTouch: FirstTouchStats;
}

/** Paged shipment_calls events (agent + occurred_at + shipment ref) for the
 *  heatmap — Envíos gestiones are real work too; each distinct shipment counts
 *  as one gestión. Resilient: an unapplied 0023 migration (or any page error)
 *  just contributes no events. */
async function fetchShipmentEventsPaged(
  sb: Awaited<ReturnType<typeof createServerSupabase>>,
  storeIds: string[],
  startIso: string,
  endIso: string,
): Promise<{ agent: string | null; occurred_at: string | null; ref: string }[]> {
  const PAGE = 1000;
  const CAP = 20000;
  const PAGE_WINDOW = 4;
  const out: { agent: string | null; occurred_at: string | null; ref: string }[] = [];
  for (let from = 0; from < CAP; from += PAGE * PAGE_WINDOW) {
    const offsets = Array.from(
      { length: Math.min(PAGE_WINDOW, Math.ceil((CAP - from) / PAGE)) },
      (_, index) => from + index * PAGE,
    );
    const pages = await Promise.all(
      offsets.map((offset) =>
        sb
          .from("shipment_calls")
          .select("shipment_id, agent, occurred_at")
          .in("store_id", storeIds)
          .not("agent", "is", null)
          .neq("kind", "system")
          .gte("occurred_at", startIso)
          .lte("occurred_at", endIso)
          .order("occurred_at", { ascending: false })
          .order("id", { ascending: false })
          .range(offset, offset + PAGE - 1),
      ),
    );
    for (const { data, error } of pages) {
      if (error) return out;
      const batch =
        (data as { shipment_id: string; agent: string | null; occurred_at: string | null }[]) ?? [];
      out.push(
        ...batch.map((r) => ({
          agent: r.agent,
          occurred_at: r.occurred_at,
          ref: `s:${r.shipment_id}`,
        })),
      );
      if (batch.length < PAGE) return out;
    }
  }
  return out;
}

/** Leads CREADOS en el rango (paged past PostgREST's max-rows cap) — insumo de
 *  la velocidad de 1ª gestión. Solo las columnas del cálculo. Best-effort: un
 *  error de página devuelve lo acumulado, igual que los demás fetchers. */
async function fetchLeadsCreatedPaged(
  sb: Awaited<ReturnType<typeof createServerSupabase>>,
  storeIds: string[],
  startIso: string,
  endIso: string,
): Promise<FirstTouchLeadInput[]> {
  const PAGE = 1000;
  const CAP = 20000;
  const PAGE_WINDOW = 4;
  const out: FirstTouchLeadInput[] = [];
  for (let from = 0; from < CAP; from += PAGE * PAGE_WINDOW) {
    const offsets = Array.from(
      { length: Math.min(PAGE_WINDOW, Math.ceil((CAP - from) / PAGE)) },
      (_, index) => from + index * PAGE,
    );
    const pages = await Promise.all(
      offsets.map((offset) =>
        sb
          .from("leads")
          .select("id, created_at, category, cart_item_count, draft_order_gid")
          .in("store_id", storeIds)
          .gte("created_at", startIso)
          .lte("created_at", endIso)
          .order("created_at", { ascending: false })
          .order("id", { ascending: false })
          .range(offset, offset + PAGE - 1),
      ),
    );
    for (const { data, error } of pages) {
      if (error) return out;
      const batch =
        (data as {
          id: string;
          created_at: string;
          category: string | null;
          cart_item_count: number | null;
          draft_order_gid: string | null;
        }[]) ?? [];
      out.push(
        ...batch.map((r) => ({
          id: r.id,
          created_at: r.created_at,
          category: r.category ?? "open",
          cart: (r.cart_item_count ?? 0) > 0 || (r.draft_order_gid ?? "").length > 0,
        })),
      );
      if (batch.length < PAGE) return out;
    }
  }
  return out;
}

/**
 * Everything the one-screen productivity board needs, in one call:
 * per-advisor stats + deltas (like getAdvisorProductivityCompare), PLUS the
 * hourly activity heatmap (all human events, source lens NOT applied — it
 * measures "is she connected working", not efficiency), the 7-day trend series
 * per advisor (source lens applied, consistent with % cierre), and the live
 * presence snapshot. The range's lead_calls are fetched ONCE and feed both
 * metrics and heatmap. All returned structures are JSON-serializable.
 */
export async function getProductivityBoard(
  storeIds: string[],
  range: DateRange,
  source: SourceBucket | null = null,
  tz = "America/Lima",
): Promise<ProductivityBoardData> {
  const prevRange = previousRange(range);
  const empty: ProductivityBoardData = {
    rows: [],
    prevTotals: { llamadas: 0, leadsTrabajados: 0, cerrados: 0, ingresos: 0 },
    prevRange,
    hasPrev: false,
    heatMax: 1,
    heatMode: "day",
    onlineIdle: [],
    firstTouch: emptyFirstTouchStats(),
  };
  if (!storeIds.length) return empty;
  const sb = await createServerSupabase();
  const { startIso, endIso } = localRangeBoundsIso(range.from, range.to, tz);
  const rangeDays = Math.max(1, Math.round((Date.parse(range.to) - Date.parse(range.from)) / 86_400_000) + 1);
  const nowMs = Date.now();

  // Trend window: the 7 calendar days ending at range.to (labels "Lun"…/"Hoy").
  const todayLocal = tzParts(new Date(nowMs).toISOString(), tz).date;
  const toMs = Date.parse(`${range.to}T12:00:00Z`); // noon anchor → date math is DST-proof
  const trendDays: { date: string; label: string }[] = [];
  for (let i = 6; i >= 0; i--) {
    const date = new Date(toMs - i * 86_400_000).toISOString().slice(0, 10);
    const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
    trendDays.push({ date, label: date === todayLocal ? "Hoy" : (WEEKDAYS[weekday] ?? date.slice(5)) });
  }
  const { startIso: trendStartIso } = localRangeBoundsIso(trendDays[0]!.date, range.to, tz);
  const needPrefix = trendStartIso < startIso; // rango corto (Hoy/Ayer) → faltan días previos
  const prefixEndIso = new Date(Date.parse(startIso) - 1).toISOString();

  // El sparkline abarca 7 días, que en un rango corto (Hoy/Ayer) empiezan ANTES
  // del rango: las ventas se piden por la ventana completa y luego se recorta.
  const salesFromIso = trendStartIso < startIso ? trendStartIso : startIso;
  const [calls, prevRows, shipEvents, onlineIds, prefixCalls, createdLeads, salesWindow] = await Promise.all([
    fetchAdvisorLeadCallsPaged(sb, storeIds, startIso, endIso),
    getAdvisorProductivity(storeIds, prevRange, source, tz),
    fetchShipmentEventsPaged(sb, storeIds, startIso, endIso),
    (async () => {
      try {
        return await onlineVendedoraIds(createAdminSupabase(), storeIds, nowMs);
      } catch {
        return new Set<string>(); // best-effort: sin presencia el tablero igual carga
      }
    })(),
    needPrefix
      ? fetchAdvisorLeadCallsPaged(sb, storeIds, trendStartIso, prefixEndIso)
      : Promise.resolve([] as AdvisorCall[]),
    fetchLeadsCreatedPaged(sb, storeIds, startIso, endIso),
    fetchAdvisorSalesPaged(sb, storeIds, salesFromIso, endIso),
  ]);

  // Metrics from the SAME calls (source lens inside), same as getAdvisorProductivity.
  const salesInRange = salesWindow.filter((s) => s.occurredAt >= startIso);
  const { scopedCalls, leadStore, scopedSales } = await buildAdvisorInputs(sb, calls, source, salesInRange);
  const emailById = await resolveEmails([
    ...new Set([...scopedCalls.map((c) => c.vendedora), ...scopedSales.map((s) => s.vendedora)]),
  ]);
  const cur =
    scopedCalls.length || scopedSales.length
      ? computeAdvisorStats({ calls: scopedCalls, sales: scopedSales, leadStore, emailById }, tz)
      : [];
  const { rows: withDeltas, prevTotals } = attachDeltas(cur, prevRows);

  // Trend series: window calls (range slice + prefix) with the SAME source lens.
  let trendCalls = scopedCalls.filter((c) => c.occurred_at >= trendStartIso);
  // La lente de fuente vive en la venta, así que se aplica igual fuera del rango.
  const trendSales = source ? salesWindow.filter((s) => s.source === source) : salesWindow;
  if (prefixCalls.length) {
    const prefix = await buildAdvisorInputs(sb, prefixCalls, source);
    trendCalls = trendCalls.concat(prefix.scopedCalls);
  }
  const trendSeries = computeAdvisorConversionByDay({ calls: trendCalls, sales: trendSales, days: trendDays, tz });

  // Heatmap: ALL human events in range (no source lens) + Envíos gestiones,
  // counted as DISTINCT leads/shipments per hour.
  const heat = computeHourlyActivity({
    events: [
      ...calls.map((c) => ({ agent: c.vendedora, occurred_at: c.occurred_at, ref: c.lead_id })),
      ...shipEvents,
    ],
    tz,
    rangeDays,
  });

  // Velocidad de 1ª gestión: leads creados en el rango × primer toque humano
  // (calls SIN lente de fuente, igual que el heatmap — mide disciplina).
  const firstTouch = computeFirstTouchStats({ leads: createdLeads, calls });

  const zeroHeat = () => new Array<number>(HEAT_END - HEAT_START + 1).fill(0);
  const emptyTrend = () => trendDays.map((d) => ({ date: d.date, label: d.label, contactos: 0, pedidos: 0 }));
  const rows: AdvisorBoardRow[] = withDeltas.map((r) => ({
    ...r,
    heat: heat.byAgent[r.userId] ?? zeroHeat(),
    trend: trendSeries[r.userId] ?? emptyTrend(),
    online: onlineIds.has(r.userId),
    primeraGestion: firstTouch.byAgent[r.userId] ?? { medianMin: null, n: 0 },
  }));

  // Online RIGHT NOW but absent from the board (no registered activity in range).
  const activeIds = new Set(rows.map((r) => r.userId));
  const idleIds = [...onlineIds].filter((id) => !activeIds.has(id));
  const idleEmails = idleIds.length ? await resolveEmails(idleIds) : new Map<string, string>();
  const onlineIdle = idleIds.map((id) => ({ userId: id, email: idleEmails.get(id) ?? id }));

  return {
    rows,
    prevTotals,
    prevRange,
    hasPrev: prevRows.length > 0,
    heatMax: heat.max,
    heatMode: heat.mode,
    onlineIdle,
    firstTouch,
  };
}

// ───────────────────────── Drill-down: leads an advisor worked ─────────────────

export interface AgentLeadRow {
  id: string;
  name: string | null;
  phone: string | null;
  status: string;
  category: string | null;
  source: SourceBucket;
  segment: LeadSegment; // calidad del lead (carrito/distrito/conversó/frío)
  won: boolean; // ELLA registró la venta de este lead en el rango
  net: number; // neto de esa venta; 0 si no la cerró ella
  llamadas: number; // calls this advisor logged on the lead
  lastTouch: string; // ISO of this advisor's last action on the lead
}

/** Leads a single advisor (vendedora) worked in the range, for the drill-down.
 *  Mirrors `getAdvisorProductivity`'s fetch/scoping but keyed to one vendedora,
 *  returning one row per touched lead (newest activity first). RLS-scoped. */
export async function getAgentLeadsWorked(
  storeIds: string[],
  range: DateRange,
  vendedoraId: string,
  source: SourceBucket | null = null,
  tz = "America/Lima",
): Promise<AgentLeadRow[]> {
  if (!storeIds.length || !vendedoraId) return [];
  const sb = await createServerSupabase();
  const { startIso, endIso } = localRangeBoundsIso(range.from, range.to, tz);

  // 1) This advisor's calls in range, paged past PostgREST's max-rows cap.
  const calls = await fetchAdvisorLeadCallsPaged(sb, storeIds, startIso, endIso, vendedoraId);
  if (!calls.length) return [];

  const llamadasByLead = new Map<string, number>();
  const lastTouchByLead = new Map<string, string>();
  for (const c of calls) {
    if (c.kind === "call") llamadasByLead.set(c.lead_id, (llamadasByLead.get(c.lead_id) ?? 0) + 1);
    const prev = lastTouchByLead.get(c.lead_id);
    if (!prev || c.occurred_at > prev) lastTouchByLead.set(c.lead_id, c.occurred_at);
  }

  // 2) The touched leads (source + segment signals selected with a degrade
  //    fallback, as elsewhere).
  const leadIds = [...lastTouchByLead.keys()];
  type TouchedLead = {
    id: string;
    name: string | null;
    phone: string | null;
    status: string;
    category: string | null;
    has_order: boolean;
    order_id: string | null;
    source?: string | null;
    cart_item_count?: number | null;
    district?: string | null;
    inbound_count?: number | null;
    draft_order_gid?: string | null;
  };
  let leads: TouchedLead[] = [];
  {
    const cols =
      "id, name, phone, status, category, has_order, order_id, source, cart_item_count, district, inbound_count, draft_order_gid";
    // Chunked .in() + one-time degrade (missing 0007/0008 columns), same as
    // getAdvisorProductivity.
    let colsMissing = false;
    for (const part of chunk(leadIds, 300)) {
      if (!colsMissing) {
        const withCols = await sb.from("leads").select(cols).in("id", part);
        if (!withCols.error) {
          leads.push(...((withCols.data as unknown as TouchedLead[]) ?? []));
          continue;
        }
        colsMissing = true;
      }
      const base = await sb.from("leads").select("id, name, phone, status, category, has_order, order_id").in("id", part);
      leads.push(...((base.data as unknown as TouchedLead[]) ?? []));
    }
  }
  if (source) leads = leads.filter((l) => sourceKey(l.source) === source);
  if (!leads.length) return [];

  // 3) ¿Cuáles de estos leads cerró ELLA, en este rango?
  //
  // Antes esto era `isWonLead(l.category)`: la bandera del LEAD, que no sabe de
  // quién es la venta ni de cuándo. Con ella el desglose contradecía a la fila de
  // arriba — el lead de #KP130367 salía como cierre para quien mandó el mensaje
  // de cortesía, mientras el tablero ya se lo daba a quien lo vendió.
  //
  // Va acotado al rango a propósito: el chip dice "de los leads que trabajaste en
  // este período, estos cerraste". Mezclar una venta de otra semana devolvería
  // justo la confusión de períodos que acabamos de sacar del tablero.
  const saleByLead = new Map<string, number>();
  for (const part of chunk(leads.map((l) => l.id), 300)) {
    const { data } = await sb
      .from("order_sales")
      .select("lead_id, orders(total_amount, total_refunded)")
      .in("lead_id", part)
      .eq("vendedora", vendedoraId)
      .gte("occurred_at", startIso)
      .lte("occurred_at", endIso);
    type Row = {
      lead_id: string | null;
      orders: { total_amount: number | null; total_refunded: number | null } | null;
    };
    for (const r of (data as unknown as Row[]) ?? []) {
      if (r.lead_id) saleByLead.set(r.lead_id, (r.orders?.total_amount ?? 0) - (r.orders?.total_refunded ?? 0));
    }
  }

  const rows: AgentLeadRow[] = leads.map((l) => ({
    id: l.id,
    name: l.name,
    phone: l.phone,
    status: l.status,
    category: l.category,
    source: sourceKey(l.source),
    segment: leadSegment(l),
    won: saleByLead.has(l.id),
    net: saleByLead.get(l.id) ?? 0,
    llamadas: llamadasByLead.get(l.id) ?? 0,
    lastTouch: lastTouchByLead.get(l.id) ?? startIso,
  }));
  rows.sort((a, b) => (a.lastTouch < b.lastTouch ? 1 : a.lastTouch > b.lastTouch ? -1 : 0));
  return rows;
}
