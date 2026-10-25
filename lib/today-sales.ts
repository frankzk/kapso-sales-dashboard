// «Hoy» del Consolidado (MOM §17.5): cómo van las ventas del día de las
// tiendas, contra ayer a esta misma hora, y la curva acumulada de los dos días.
//
// Módulo PURO a propósito, como lib/leads-team-today.ts: sin base de datos ni
// red, para probarlo y para que el componente del navegador importe sus tipos
// sin arrastrar el cliente de servidor. La lectura vive en
// lib/today-sales-access.ts y la ruta del refresco en app/api/dashboard/hoy.
//
// Una venta es la de la cabecera del Consolidado (MOM §17.4): todos los
// pedidos de la tienda, por quien sea que los cerró; los activos cuentan y el
// ingreso es total − reembolsado; los cancelados de hoy van aparte. Cada
// tienda se mide en su día local, y «ayer a esta hora» es lo que ayer ya se
// había creado a la misma hora local, con el estado que ese pedido tiene hoy.

import { addDays, localClock, localMidnightUtc } from "@/lib/local-day";

/** Paso de la curva: un punto por cuarto de hora. */
export const BUCKET_MINUTES = 15;
export const DAY_MINUTES = 24 * 60;
/** 0:00, 0:15, … 24:00. */
export const CURVE_POINTS = DAY_MINUTES / BUCKET_MINUTES + 1;

export interface TodayStoreInput {
  id: string;
  name: string;
  timezone: string | null;
}

/** La fila de `orders` que hace falta, tal como llega de PostgREST. */
export interface TodayOrderRow {
  store_id: string;
  created_at: string;
  total_amount: number | string | null;
  total_refunded: number | string | null;
  cancelled_at: string | null;
}

export interface SalesFigure {
  pedidos: number;
  /** Total − reembolsado, en la moneda de la tienda. */
  ingresos: number;
}

export interface TodayTotals {
  hoy: SalesFigure;
  /** Lo que ayer ya se había vendido a esta misma hora local. */
  ayerAEstaHora: SalesFigure;
  /** Ayer completo: para ver en la curva lo que le faltaba a ayer. */
  ayerDia: SalesFigure;
  /** Los pedidos de hoy que ya están cancelados: fuera de las cifras. */
  cancelados: SalesFigure;
}

export interface TodayStoreSales extends TodayTotals {
  storeId: string;
  name: string;
}

export interface CurvePair {
  pedidos: number[];
  ingresos: number[];
}

export interface TodaySales {
  /** El instante del corte (ISO). */
  generatedAt: string;
  /** La zona del reloj de la curva y del corte: la de la primera tienda. */
  timezone: string;
  /** Hoy, YYYY-MM-DD en esa zona. */
  fecha: string;
  /** Minutos desde la medianoche local en esa zona. */
  ahora: number;
  total: TodayTotals;
  /** Una por tienda, en el orden en que llegaron. */
  stores: TodayStoreSales[];
  /**
   * Lo acumulado al INICIO de cada cuarto de hora: el índice i es el minuto
   * i·15 (de 0:00 a 24:00). En `hoy`, solo vale hasta `ahora`; lo de después
   * se repite plano y la curva no lo dibuja.
   */
  curva: { hoy: CurvePair; ayer: CurvePair };
}

export interface StoreWindow {
  storeId: string;
  timezone: string;
  /** Hoy y ayer, YYYY-MM-DD en la zona de la tienda. */
  hoy: string;
  ayer: string;
  /** Minutos desde la medianoche local de la tienda. */
  ahora: number;
  /** De la medianoche de ayer a la de mañana, en la zona de la tienda. */
  desde: string;
  hasta: string;
}

const tzOf = (tz: string | null | undefined) => (tz && tz.trim() ? tz : "UTC");

/** El día local de cada tienda: hoy, ayer, la hora local y el rango que hay que leer. */
export function todayWindows(stores: readonly TodayStoreInput[], now: Date): StoreWindow[] {
  return stores.map((store) => {
    const timezone = tzOf(store.timezone);
    const clock = localClock(now, timezone);
    const ayer = addDays(clock.date, -1);
    return {
      storeId: store.id,
      timezone,
      hoy: clock.date,
      ayer,
      ahora: clock.minute,
      desde: localMidnightUtc(ayer, timezone),
      hasta: localMidnightUtc(addDays(clock.date, 1), timezone),
    };
  });
}

/** El rango que cubre a todas las tiendas: una sola lectura de `orders`. */
export function queryBounds(windows: readonly StoreWindow[]): { desde: string; hasta: string } | null {
  if (!windows.length) return null;
  return {
    desde: windows.reduce((min, w) => (w.desde < min ? w.desde : min), windows[0]!.desde),
    hasta: windows.reduce((max, w) => (w.hasta > max ? w.hasta : max), windows[0]!.hasta),
  };
}

const zero = (): SalesFigure => ({ pedidos: 0, ingresos: 0 });
const zeroTotals = (): TodayTotals => ({ hoy: zero(), ayerAEstaHora: zero(), ayerDia: zero(), cancelados: zero() });
const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

function num(v: number | string | null | undefined): number {
  const n = typeof v === "number" ? v : Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function add(into: SalesFigure, neto: number) {
  into.pedidos += 1;
  into.ingresos += neto;
}

function roundTotals(t: TodayTotals): TodayTotals {
  return {
    hoy: { pedidos: t.hoy.pedidos, ingresos: round2(t.hoy.ingresos) },
    ayerAEstaHora: { pedidos: t.ayerAEstaHora.pedidos, ingresos: round2(t.ayerAEstaHora.ingresos) },
    ayerDia: { pedidos: t.ayerDia.pedidos, ingresos: round2(t.ayerDia.ingresos) },
    cancelados: { pedidos: t.cancelados.pedidos, ingresos: round2(t.cancelados.ingresos) },
  };
}

/** Lo de cada cuarto de hora, sumado desde la medianoche. */
function cumulative(perBucket: number[], money: boolean): number[] {
  const out = new Array<number>(CURVE_POINTS).fill(0);
  for (let i = 1; i < CURVE_POINTS; i++) {
    const v = out[i - 1]! + (perBucket[i - 1] ?? 0);
    out[i] = money ? round2(v) : v;
  }
  return out;
}

/**
 * Arma «Hoy» con los pedidos de ayer y hoy de las tiendas. Un pedido de otra
 * tienda o de otro día no cuenta; uno de hoy ya cancelado va a `cancelados`.
 */
export function buildTodaySales(
  stores: readonly TodayStoreInput[],
  rows: readonly TodayOrderRow[],
  now: Date,
): TodaySales {
  const windows = todayWindows(stores, now);
  const byStore = new Map(windows.map((w) => [w.storeId, w]));
  const totals = new Map(stores.map((s) => [s.id, zeroTotals()]));
  const buckets = DAY_MINUTES / BUCKET_MINUTES;
  const hoyPedidos = new Array<number>(buckets).fill(0);
  const hoyIngresos = new Array<number>(buckets).fill(0);
  const ayerPedidos = new Array<number>(buckets).fill(0);
  const ayerIngresos = new Array<number>(buckets).fill(0);

  for (const row of rows) {
    const w = byStore.get(row.store_id);
    const t = totals.get(row.store_id);
    if (!w || !t) continue;
    const clock = localClock(row.created_at, w.timezone);
    const esHoy = clock.date === w.hoy;
    if (!esHoy && clock.date !== w.ayer) continue;
    const neto = num(row.total_amount) - num(row.total_refunded);
    if (row.cancelled_at) {
      if (esHoy) add(t.cancelados, neto);
      continue;
    }
    const bucket = Math.min(buckets - 1, Math.floor(clock.minute / BUCKET_MINUTES));
    if (esHoy) {
      add(t.hoy, neto);
      hoyPedidos[bucket]! += 1;
      hoyIngresos[bucket]! += neto;
    } else {
      add(t.ayerDia, neto);
      ayerPedidos[bucket]! += 1;
      ayerIngresos[bucket]! += neto;
      if (clock.minute <= w.ahora) add(t.ayerAEstaHora, neto);
    }
  }

  const storeSales: TodayStoreSales[] = stores.map((s) => ({
    storeId: s.id,
    name: s.name,
    ...roundTotals(totals.get(s.id) ?? zeroTotals()),
  }));
  const sum = zeroTotals();
  for (const s of storeSales) {
    for (const key of ["hoy", "ayerAEstaHora", "ayerDia", "cancelados"] as const) {
      sum[key].pedidos += s[key].pedidos;
      sum[key].ingresos += s[key].ingresos;
    }
  }

  const first = windows[0];
  const timezone = first?.timezone ?? "UTC";
  const clock = localClock(now, timezone);
  return {
    generatedAt: now.toISOString(),
    timezone,
    fecha: clock.date,
    ahora: clock.minute,
    total: roundTotals(sum),
    stores: storeSales,
    curva: {
      hoy: { pedidos: cumulative(hoyPedidos, false), ingresos: cumulative(hoyIngresos, true) },
      ayer: { pedidos: cumulative(ayerPedidos, false), ingresos: cumulative(ayerIngresos, true) },
    },
  };
}

/**
 * El cambio de hoy contra ayer a esta hora, como fracción (0.18 = +18 %).
 * Null si ayer a esta hora no había nada: un porcentaje sobre cero no dice nada.
 */
export function changeRatio(hoy: number, ayer: number): number | null {
  if (!ayer) return null;
  return (hoy - ayer) / ayer;
}
