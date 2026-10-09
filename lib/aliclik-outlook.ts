// Entrega estimada de Aliclik según los días que lleva el pedido (09-10-2026).
//
// Antes de crear la guía, la ficha dice cuántas de cada 10 guías parecidas
// entregó Aliclik: «Pedido de 5 días · Aliclik entrega ~27 %». Medido por guía
// (la primera del pedido, que salió del almacén y ya tiene resultado, de los
// últimos ~2 meses): en Kenku, 61 % el mismo día, 55 % al día siguiente, 40 %
// a los dos días y 27 % desde el tercero.
//
// Es un aviso, no una regla: no bloquea ni cambia la ruta sugerida. Puro y sin
// imports, para que lo usen la ficha (cliente) y su carga (servidor).

/** Una fila de `aliclik_delivery_by_order_age()` (migración 0236). */
export interface AliclikAgeRateRow {
  store_id: string;
  /** 0, 1, 2 días; 3 = tres o más. */
  age_bucket: number;
  settled: number;
  delivered: number;
  window_from: string;
  window_to: string;
}

export type OutlookBucket = 0 | 1 | 2 | 3;
export const OUTLOOK_BUCKETS: readonly OutlookBucket[] = [0, 1, 2, 3];

/** Guías con resultado que hacen falta para dar un porcentaje. */
export const OUTLOOK_MIN_SAMPLE = 30;

/**
 * Desde cuánto se avisa. Con 50 % o más el pedido sale como cualquiera; bajo
 * 35 % se entregan menos de 4 de cada 10.
 */
export const OUTLOOK_LOW = 0.5;
export const OUTLOOK_VERY_LOW = 0.35;

export type OutlookLevel = "normal" | "baja" | "muy_baja";

export interface OutlookStep {
  bucket: OutlookBucket;
  /** Null: muy pocas guías para decirlo. */
  rate: number | null;
  settled: number;
  delivered: number;
}

export interface AliclikOutlook {
  /** Días de calendario en Lima desde que entró el pedido. */
  ageDays: number;
  bucket: OutlookBucket;
  rate: number;
  level: OutlookLevel;
  settled: number;
  delivered: number;
  /** Lo que se entregaría si la guía se crea mañana; null en el último tramo. */
  tomorrowRate: number | null;
  steps: OutlookStep[];
  /** Algún tramo usó las guías de todas las tiendas por falta de muestra en esta. */
  pooled: boolean;
  windowFrom: string;
  windowTo: string;
}

function limaDayKey(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Lima",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const part = (type: "year" | "month" | "day") => parts.find((p) => p.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

/**
 * Días de calendario en Lima entre la creación del pedido y `now`: un pedido
 * de las 23:00 ya es «de ayer» a la mañana siguiente, como lo cuenta la tabla.
 */
export function orderAgeDays(orderCreatedAt: string, now: Date): number | null {
  const created = new Date(orderCreatedAt);
  if (Number.isNaN(created.getTime())) return null;
  const days = Math.round((Date.parse(limaDayKey(now)) - Date.parse(limaDayKey(created))) / 86_400_000);
  return Math.max(0, days);
}

export function outlookBucket(ageDays: number): OutlookBucket {
  return Math.min(3, Math.max(0, Math.floor(ageDays))) as OutlookBucket;
}

export function outlookLevel(rate: number): OutlookLevel {
  if (rate < OUTLOOK_VERY_LOW) return "muy_baja";
  if (rate < OUTLOOK_LOW) return "baja";
  return "normal";
}

/**
 * La entrega estimada de un pedido de `ageDays` días de la tienda `storeId`.
 * Cada tramo usa las guías de la tienda; si esa tienda tiene menos de
 * `OUTLOOK_MIN_SAMPLE`, las de todas las tiendas que el usuario ve (y lo dice).
 * Null si ni así hay muestra para el tramo del pedido: no se inventa un número.
 */
export function buildAliclikOutlook(
  rows: readonly AliclikAgeRateRow[],
  storeId: string,
  ageDays: number,
): AliclikOutlook | null {
  if (rows.length === 0) return null;
  let pooled = false;
  const steps: OutlookStep[] = OUTLOOK_BUCKETS.map((bucket) => {
    const inBucket = rows.filter((r) => Number(r.age_bucket) === bucket);
    const own = inBucket.filter((r) => r.store_id === storeId);
    let settled = own.reduce((n, r) => n + Number(r.settled), 0);
    let delivered = own.reduce((n, r) => n + Number(r.delivered), 0);
    if (settled < OUTLOOK_MIN_SAMPLE) {
      const allSettled = inBucket.reduce((n, r) => n + Number(r.settled), 0);
      if (allSettled > settled) {
        settled = allSettled;
        delivered = inBucket.reduce((n, r) => n + Number(r.delivered), 0);
        pooled = true;
      }
    }
    return { bucket, settled, delivered, rate: settled >= OUTLOOK_MIN_SAMPLE ? delivered / settled : null };
  });
  const bucket = outlookBucket(ageDays);
  const current = steps[bucket]!;
  if (current.rate == null) return null;
  return {
    ageDays,
    bucket,
    rate: current.rate,
    level: outlookLevel(current.rate),
    settled: current.settled,
    delivered: current.delivered,
    tomorrowRate: bucket < 3 ? steps[bucket + 1]!.rate : null,
    steps,
    pooled,
    windowFrom: rows[0]!.window_from,
    windowTo: rows[0]!.window_to,
  };
}

/** «27 %», con el espacio fino que no se parte. */
export function outlookPercent(rate: number): string {
  return `${Math.round(rate * 100)} %`;
}

/** «Pedido de hoy», «Pedido de ayer», «Pedido de 5 días». */
export function outlookAgeLabel(ageDays: number): string {
  if (ageDays <= 0) return "Pedido de hoy";
  if (ageDays === 1) return "Pedido de ayer";
  return `Pedido de ${ageDays} días`;
}

/** La etiqueta de cada tramo en la escalera. */
export function outlookStepLabel(bucket: OutlookBucket): string {
  return bucket === 0 ? "Hoy" : bucket === 3 ? "3+ d" : `${bucket} d`;
}

/** «Pedido de 5 días · Aliclik entrega ~27 %». */
export function outlookTitle(outlook: AliclikOutlook): string {
  // «entrega ~40 %» no se parte: en el teléfono el «~» quedaba solo al final.
  return `${outlookAgeLabel(outlook.ageDays)} · Aliclik entrega\u00a0~${outlookPercent(outlook.rate)}`;
}

/** Los pedidos de un tramo, dicho para la frase. */
export function outlookBucketPhrase(bucket: OutlookBucket): string {
  return ["del mismo día", "de un día", "de dos días", "de 3 días o más"][bucket]!;
}

/**
 * «De cada 10 guías de pedidos de 3 días o más, Aliclik entregó 3.»: «3 de
 * cada 10» se entiende mejor en la mesa que un porcentaje.
 */
export function outlookFact(outlook: AliclikOutlook): string {
  return `De cada 10 guías de pedidos ${outlookBucketPhrase(outlook.bucket)}, Aliclik entregó ${Math.round(outlook.rate * 10)}.`;
}

/** Qué hacer con lo que dice la cifra. */
export function outlookAdvice(outlook: AliclikOutlook): string {
  if (outlook.level === "muy_baja") return "Créala solo si el cliente contesta hoy y vuelve a confirmar, o con adelanto.";
  if (outlook.level === "baja") return "Antes de crear la guía, confirma con el cliente que lo sigue esperando.";
  if (outlook.tomorrowRate != null && outlook.tomorrowRate < outlook.rate) {
    return `Que salga hoy: mañana bajaría a ${outlookPercent(outlook.tomorrowRate)}.`;
  }
  return "Sale como cualquier pedido.";
}

function shortDate(ymd: string): string {
  const d = new Date(`${ymd}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return ymd;
  return d.toLocaleDateString("es-PE", { day: "numeric", month: "short", timeZone: "UTC" }).replace(".", "");
}

/** De dónde sale la cifra, para que se pueda creer: «292 primeras guías de Kenku Peru, 31 jul – 25 set». */
export function outlookSource(outlook: AliclikOutlook, storeName?: string | null): string {
  const who = outlook.pooled ? "todas tus tiendas" : storeName?.trim() || "esta tienda";
  return `${outlook.settled.toLocaleString("es-PE")} primeras guías de ${who}, ${shortDate(outlook.windowFrom)} – ${shortDate(outlook.windowTo)}`;
}
