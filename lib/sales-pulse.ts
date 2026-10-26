// «Cómo van las ventas» del Consolidado (MOM §17.5): hoy, esta semana o este
// mes de las tiendas, contra el periodo anterior a esta misma altura, y la
// curva acumulada de los dos.
//
// Módulo PURO, como lib/today-sales.ts: sin base de datos ni red, para
// probarlo y para que el componente del navegador importe sus tipos. La
// lectura vive en lib/sales-pulse-access.ts y la ruta en app/api/dashboard/pulso.
//
// Los tres periodos dan la MISMA forma (`SalesPulse`), que es lo que dibuja el
// bloque:
//   - Hoy: los pedidos de ayer y hoy, por cuarto de hora (lib/today-sales.ts).
//   - Esta semana (de lunes a ahora) contra la semana pasada hasta el mismo día
//     y la misma hora; este mes (del 1 a ahora) contra el mes anterior hasta el
//     mismo día del mes y la misma hora. Si el mes anterior no llega a ese día
//     (el 30 de marzo contra febrero), se compara contra el mes anterior
//     entero. Los días cerrados salen de `ventas_por_origen` (0268, un total por
//     tienda y día local) y el día del corte, de sus pedidos, para cortar al
//     minuto.
// Una venta es la de la cabecera (MOM §17.4): todos los pedidos, los activos
// cuentan, el ingreso es total − reembolsado y los cancelados van aparte.

import { addDays, localClock } from "@/lib/local-day";
import {
  BUCKET_MINUTES,
  CURVE_POINTS,
  DAY_MINUTES,
  buildTodaySales,
  type SalesFigure,
  type TodayOrderRow,
  type TodayStoreInput,
} from "@/lib/today-sales";

export type PulsePeriod = "hoy" | "semana" | "mes";
export const PULSE_PERIODS: readonly PulsePeriod[] = ["hoy", "semana", "mes"];

/** `?periodo=` de la ruta: cualquier otra cosa es hoy. */
export function parsePulsePeriod(value: unknown): PulsePeriod {
  return value === "semana" || value === "mes" ? value : "hoy";
}

export interface PulseTotals {
  /** Lo del periodo, hasta ahora. */
  actual: SalesFigure;
  /** Lo que el periodo anterior llevaba a esta misma altura. */
  anterior: SalesFigure;
  /** El periodo anterior entero: para ver en la curva lo que le faltaba. */
  anteriorCompleto: SalesFigure;
  /**
   * Los pedidos del periodo que ya están cancelados: fuera de las cifras. El
   * monto solo se sabe en hoy (`ventas_por_origen` cuenta los cancelados, no
   * los suma).
   */
  cancelados: { pedidos: number; ingresos: number | null };
}

export interface PulseStore extends PulseTotals {
  storeId: string;
  name: string;
  /** Kapta tiene todas sus ventas del periodo anterior entero. */
  comparable: boolean;
  /** Desde qué día local Kapta tiene todas sus ventas; null si no tiene ningún pedido. */
  piso: string | null;
}

export interface PulsePoint {
  /** Minutos desde la medianoche (hoy) o días desde el inicio del periodo. */
  x: number;
  pedidos: number;
  ingresos: number;
}

/** Un punto que el cursor recorre: la raya va en `x`, con las dos cifras de ahí. */
export interface PulseSlot {
  x: number;
  /** El cuarto de hora (hoy) o el día del periodo (0 = el primero). */
  indice: number;
  /** Null después de ahora. */
  actual: SalesFigure | null;
  /** Null si el anterior no tiene ese día o no se puede comparar. */
  anterior: SalesFigure | null;
}

export interface SalesPulse {
  periodo: PulsePeriod;
  /** El instante del corte (ISO). */
  generatedAt: string;
  /** La zona del reloj del corte y del eje: la de la primera tienda. */
  timezone: string;
  /** Hoy, YYYY-MM-DD en esa zona. */
  fecha: string;
  /** Minutos desde la medianoche local. */
  ahora: number;
  /** El primer día del periodo y el último (el domingo, el fin de mes). */
  desde: string;
  hasta: string;
  anteriorDesde: string;
  anteriorHasta: string;
  /** El día del anterior donde corta «a esta altura»; null = el anterior entero. */
  corte: string | null;
  /** Todas las tiendas se pueden comparar: si no, no hay cambio ni curva anterior. */
  comparable: boolean;
  total: PulseTotals;
  /** Una por tienda, en el orden en que llegaron. */
  stores: PulseStore[];
  curva: {
    unidad: "minuto" | "dia";
    /** El largo del eje: 1440 minutos, 7 días o los días del más largo de los dos meses. */
    largo: number;
    /** La x de ahora y la del corte en la curva anterior. */
    ahora: number;
    corte: number;
    /** De 0 a ahora, con el punto de ahora al final. */
    actual: PulsePoint[];
    /** El anterior entero, con el punto del corte dentro. */
    anterior: PulsePoint[];
    slots: PulseSlot[];
    /** El slot de ahora: donde arranca el teclado. */
    slotAhora: number;
  };
}

/** Lo que `ventas_por_origen` deja por tienda y día local (los canales ya sumados o no: da igual). */
export interface PulseDayRow {
  storeId: string;
  date: string;
  orders: number;
  revenue: number;
  cancelled: number;
}

/** El periodo de una tienda, en su día local. */
export interface PeriodWindow {
  storeId: string;
  timezone: string;
  hoy: string;
  ahora: number;
  desde: string;
  hasta: string;
  anteriorDesde: string;
  anteriorHasta: string;
  corte: string | null;
  /** El día de hoy dentro del periodo (0 = el primero). */
  indice: number;
  /** Los días del periodo actual y del anterior. */
  dias: number;
  diasAnterior: number;
}

const tzOf = (tz: string | null | undefined) => (tz && tz.trim() ? tz : "UTC");
const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

function num(v: number | string | null | undefined): number {
  const n = typeof v === "number" ? v : Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function parts(date: string): [number, number, number] {
  const [y, m, d] = date.split("-").map(Number);
  return [y!, m!, d!];
}

/** Días de `a` a `b` (YYYY-MM-DD). */
function diffDays(a: string, b: string): number {
  const [ay, am, ad] = parts(a);
  const [by, bm, bd] = parts(b);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86_400_000);
}

/** Los días del mes `m` (1–12). */
function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/**
 * El periodo de la tienda: la semana va de lunes a domingo y el mes, del 1 al
 * último. El corte del anterior es el mismo día de la semana o del mes; si el
 * mes anterior no lo tiene, null (se compara entero).
 */
export function periodWindow(store: TodayStoreInput, periodo: PulsePeriod, now: Date): PeriodWindow {
  const timezone = tzOf(store.timezone);
  const clock = localClock(now, timezone);
  const hoy = clock.date;
  const base = { storeId: store.id, timezone, hoy, ahora: clock.minute };
  if (periodo === "hoy") {
    const ayer = addDays(hoy, -1);
    return { ...base, desde: hoy, hasta: hoy, anteriorDesde: ayer, anteriorHasta: ayer, corte: ayer, indice: 0, dias: 1, diasAnterior: 1 };
  }
  const [y, m, d] = parts(hoy);
  if (periodo === "semana") {
    const lunes = addDays(hoy, -((new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7));
    const anteriorDesde = addDays(lunes, -7);
    return {
      ...base,
      desde: lunes,
      hasta: addDays(lunes, 6),
      anteriorDesde,
      anteriorHasta: addDays(lunes, -1),
      corte: addDays(hoy, -7),
      indice: diffDays(lunes, hoy),
      dias: 7,
      diasAnterior: 7,
    };
  }
  const desde = `${hoy.slice(0, 7)}-01`;
  const anteriorDesde = addDays(desde, -1).slice(0, 7) + "-01";
  const [py, pm] = parts(anteriorDesde);
  const diasAnterior = daysInMonth(py, pm);
  const dias = daysInMonth(y, m);
  return {
    ...base,
    desde,
    hasta: addDays(desde, dias - 1),
    anteriorDesde,
    anteriorHasta: addDays(anteriorDesde, diasAnterior - 1),
    corte: d <= diasAnterior ? addDays(anteriorDesde, d - 1) : null,
    indice: d - 1,
    dias,
    diasAnterior,
  };
}

/** Solo se compara si Kapta tiene todas las ventas de la tienda desde el inicio del anterior. */
export const isComparable = (piso: string | null, w: Pick<PeriodWindow, "anteriorDesde">) =>
  piso != null && piso <= w.anteriorDesde;

/**
 * Desde qué día la tienda tiene todas sus ventas en Kapta: el más tardío entre
 * `ORDERS_SYNC_FROM` (antes, solo los pedidos del bot) y el día de su primer
 * pedido. Null si no tiene ninguno.
 */
export function salesFloor(syncFrom: string, firstOrderDay: string | null): string | null {
  if (!firstOrderDay) return null;
  return firstOrderDay > syncFrom ? firstOrderDay : syncFrom;
}

/** El tramo de `orders` que hay que leer para el día del corte de cada tienda, o null si ninguna corta. */
export function cutDays(windows: readonly PeriodWindow[]): { storeId: string; timezone: string; day: string }[] {
  return windows.flatMap((w) => (w.corte ? [{ storeId: w.storeId, timezone: w.timezone, day: w.corte }] : []));
}

const zero = (): SalesFigure => ({ pedidos: 0, ingresos: 0 });
const zeroTotals = (): PulseTotals => ({
  actual: zero(),
  anterior: zero(),
  anteriorCompleto: zero(),
  cancelados: { pedidos: 0, ingresos: 0 },
});
const roundFig = (f: SalesFigure): SalesFigure => ({ pedidos: f.pedidos, ingresos: round2(f.ingresos) });
const roundTotals = (t: PulseTotals): PulseTotals => ({
  actual: roundFig(t.actual),
  anterior: roundFig(t.anterior),
  anteriorCompleto: roundFig(t.anteriorCompleto),
  cancelados: { pedidos: t.cancelados.pedidos, ingresos: t.cancelados.ingresos == null ? null : round2(t.cancelados.ingresos) },
});

function sumTotals(stores: readonly PulseTotals[], montoCancelado: boolean): PulseTotals {
  const sum = zeroTotals();
  for (const s of stores) {
    for (const key of ["actual", "anterior", "anteriorCompleto"] as const) {
      sum[key].pedidos += s[key].pedidos;
      sum[key].ingresos += s[key].ingresos;
    }
    sum.cancelados.pedidos += s.cancelados.pedidos;
    sum.cancelados.ingresos = (sum.cancelados.ingresos ?? 0) + (s.cancelados.ingresos ?? 0);
  }
  if (!montoCancelado) sum.cancelados.ingresos = null;
  return roundTotals(sum);
}

const fig = (pedidos: number, ingresos: number): SalesFigure => ({ pedidos, ingresos: round2(ingresos) });

/** Lo acumulado al terminar cada día: [0] = 0, [k] = los días 0…k−1. */
function cumulativeDays(pedidos: number[], ingresos: number[]): SalesFigure[] {
  const out: SalesFigure[] = [zero()];
  for (let k = 0; k < pedidos.length; k++) {
    const prev = out[k]!;
    out.push(fig(prev.pedidos + pedidos[k]!, prev.ingresos + ingresos[k]!));
  }
  return out;
}

const point = (x: number, f: SalesFigure): PulsePoint => ({ x, pedidos: f.pedidos, ingresos: f.ingresos });

function storeShell(s: TodayStoreInput, w: Pick<PeriodWindow, "anteriorDesde">, floors: ReadonlyMap<string, string | null>) {
  const piso = floors.get(s.id) ?? null;
  return { storeId: s.id, name: s.name, piso, comparable: isComparable(piso, w) };
}

/**
 * Hoy: los pedidos de ayer y hoy (lib/today-sales.ts) en la forma del bloque.
 * La curva va por cuarto de hora; la de ayer lleva dentro el punto de «ayer a
 * esta hora», para que el punto quede sobre su línea.
 */
export function buildDayPulse(
  stores: readonly TodayStoreInput[],
  rows: readonly TodayOrderRow[],
  floors: ReadonlyMap<string, string | null>,
  now: Date,
): SalesPulse {
  const day = buildTodaySales(stores, rows, now);
  const windows = stores.map((s) => periodWindow(s, "hoy", now));
  const pulseStores: PulseStore[] = day.stores.map((s, i) => ({
    ...storeShell(stores[i]!, windows[i]!, floors),
    actual: s.hoy,
    anterior: s.ayerAEstaHora,
    anteriorCompleto: s.ayerDia,
    cancelados: s.cancelados,
  }));
  const comparable = pulseStores.length > 0 && pulseStores.every((s) => s.comparable);
  const total = sumTotals(pulseStores, true);
  const ahora = Math.min(DAY_MINUTES, Math.max(0, day.ahora));
  const nowIdx = Math.floor(ahora / BUCKET_MINUTES);
  const hoy = day.curva.hoy;
  const ayer = day.curva.ayer;

  const actual: PulsePoint[] = [];
  for (let i = 0; i <= nowIdx && i < CURVE_POINTS; i++) actual.push({ x: i * BUCKET_MINUTES, pedidos: hoy.pedidos[i]!, ingresos: hoy.ingresos[i]! });
  actual.push(point(ahora, total.actual));
  const anterior: PulsePoint[] = [];
  for (let i = 0; i < CURVE_POINTS; i++) {
    const x = i * BUCKET_MINUTES;
    const last = anterior[anterior.length - 1];
    if (x >= ahora && (!last || last.x < ahora)) {
      // «Ayer a esta hora» cuenta hasta el minuto de ahora inclusive: en el
      // borde del cuarto de hora reemplaza al punto del borde.
      anterior.push(point(ahora, total.anterior));
      if (x === ahora) continue;
    }
    anterior.push({ x, pedidos: ayer.pedidos[i]!, ingresos: ayer.ingresos[i]! });
  }
  const slots: PulseSlot[] = Array.from({ length: CURVE_POINTS }, (_, i) => ({
    x: i * BUCKET_MINUTES,
    indice: i,
    actual: i * BUCKET_MINUTES <= ahora ? { pedidos: hoy.pedidos[i]!, ingresos: hoy.ingresos[i]! } : null,
    anterior: comparable ? { pedidos: ayer.pedidos[i]!, ingresos: ayer.ingresos[i]! } : null,
  }));
  const first = windows[0];

  return {
    periodo: "hoy",
    generatedAt: day.generatedAt,
    timezone: day.timezone,
    fecha: day.fecha,
    ahora: day.ahora,
    desde: day.fecha,
    hasta: day.fecha,
    anteriorDesde: first?.anteriorDesde ?? addDays(day.fecha, -1),
    anteriorHasta: first?.anteriorHasta ?? addDays(day.fecha, -1),
    corte: first?.corte ?? addDays(day.fecha, -1),
    comparable,
    total,
    stores: pulseStores,
    curva: { unidad: "minuto", largo: DAY_MINUTES, ahora, corte: ahora, actual, anterior, slots, slotAhora: nowIdx },
  };
}

/**
 * Esta semana o este mes. `dias` son los totales por tienda y día local del
 * anterior y del actual (de `ventas_por_origen`); `corteRows`, los pedidos del
 * día del corte, para contar lo que el anterior llevaba hasta el minuto de
 * ahora con el estado que cada pedido tiene hoy. La curva va por día.
 */
export function buildPeriodPulse(
  stores: readonly TodayStoreInput[],
  periodo: "semana" | "mes",
  dias: readonly PulseDayRow[],
  corteRows: readonly TodayOrderRow[],
  floors: ReadonlyMap<string, string | null>,
  now: Date,
): SalesPulse {
  const windows = stores.map((s) => periodWindow(s, periodo, now));
  const byStore = new Map(windows.map((w) => [w.storeId, w]));
  const totals = new Map(stores.map((s) => [s.id, zeroTotals()]));
  const first = windows[0] ?? periodWindow({ id: "", name: "", timezone: "UTC" }, periodo, now);
  const largo = Math.max(first.dias, first.diasAnterior);
  const curPedidos = new Array<number>(largo).fill(0);
  const curIngresos = new Array<number>(largo).fill(0);
  const antPedidos = new Array<number>(largo).fill(0);
  const antIngresos = new Array<number>(largo).fill(0);

  for (const row of dias) {
    const w = byStore.get(row.storeId);
    const t = totals.get(row.storeId);
    if (!w || !t) continue;
    if (row.date >= w.desde && row.date <= w.hoy) {
      const k = diffDays(w.desde, row.date);
      t.actual.pedidos += row.orders;
      t.actual.ingresos += row.revenue;
      t.cancelados.pedidos += row.cancelled;
      if (k < largo) {
        curPedidos[k]! += row.orders;
        curIngresos[k]! += row.revenue;
      }
    } else if (row.date >= w.anteriorDesde && row.date <= w.anteriorHasta) {
      const k = diffDays(w.anteriorDesde, row.date);
      t.anteriorCompleto.pedidos += row.orders;
      t.anteriorCompleto.ingresos += row.revenue;
      if (k < largo) {
        antPedidos[k]! += row.orders;
        antIngresos[k]! += row.revenue;
      }
      // El día del corte no se toma del total del día: se cuenta al minuto abajo.
      if (w.corte == null || row.date < w.corte) {
        t.anterior.pedidos += row.orders;
        t.anterior.ingresos += row.revenue;
      }
    }
  }
  for (const row of corteRows) {
    const w = byStore.get(row.store_id);
    const t = totals.get(row.store_id);
    if (!w?.corte || !t || row.cancelled_at) continue;
    const clock = localClock(row.created_at, w.timezone);
    if (clock.date !== w.corte || clock.minute > w.ahora) continue;
    t.anterior.pedidos += 1;
    t.anterior.ingresos += num(row.total_amount) - num(row.total_refunded);
  }

  const pulseStores: PulseStore[] = stores.map((s, i) => {
    const t = totals.get(s.id) ?? zeroTotals();
    return { ...storeShell(s, windows[i]!, floors), ...roundTotals({ ...t, cancelados: { pedidos: t.cancelados.pedidos, ingresos: null } }) };
  });
  const comparable = pulseStores.length > 0 && pulseStores.every((s) => s.comparable);
  const total = sumTotals(pulseStores, false);

  const indice = Math.min(first.indice, largo - 1);
  const ahora = indice + first.ahora / DAY_MINUTES;
  const corte = first.corte ? ahora : first.diasAnterior;
  const cur = cumulativeDays(curPedidos, curIngresos);
  const ant = cumulativeDays(antPedidos.slice(0, first.diasAnterior), antIngresos.slice(0, first.diasAnterior));

  const actual: PulsePoint[] = [];
  for (let k = 0; k <= indice; k++) actual.push(point(k, cur[k]!));
  actual.push(point(ahora, total.actual));
  const anterior: PulsePoint[] = [];
  for (let k = 0; k <= first.diasAnterior; k++) {
    if (first.corte && k === indice + 1) anterior.push(point(corte, total.anterior));
    anterior.push(point(k, ant[k]!));
  }
  const slots: PulseSlot[] = Array.from({ length: largo }, (_, k) => {
    const esHoy = k === indice;
    let ant_: SalesFigure | null = null;
    if (comparable) {
      if (esHoy) ant_ = first.corte ? total.anterior : null;
      else if (k < first.diasAnterior) ant_ = ant[k + 1]!;
    }
    return {
      x: esHoy ? ahora : k + 1,
      indice: k,
      actual: k < indice ? cur[k + 1]! : esHoy ? total.actual : null,
      anterior: ant_,
    };
  });

  return {
    periodo,
    generatedAt: now.toISOString(),
    timezone: first.timezone,
    fecha: first.hoy,
    ahora: first.ahora,
    desde: first.desde,
    hasta: first.hasta,
    anteriorDesde: first.anteriorDesde,
    anteriorHasta: first.anteriorHasta,
    corte: first.corte,
    comparable,
    total,
    stores: pulseStores,
    curva: { unidad: "dia", largo, ahora, corte, actual, anterior, slots, slotAhora: indice },
  };
}
