// Vista por mes de Productividad (05-10-2026). Dos preguntas distintas:
//
//   • «¿Cómo quedó septiembre?» — el mes EXACTO, del 1 al último día en el
//     calendario local de la tienda, comparado con el mes anterior completo.
//   • «¿Cómo vamos este mes?» — del 1 a hoy, comparado con los MISMOS días del
//     mes anterior. Cinco días contra un mes entero no dicen nada, y contra los
//     cinco días previos (26-30 sep) mezclan dos meses. Y además, a qué ritmo va:
//     lo que dejaron los días ya cerrados, repartido en el mes entero.
//
// Puro y probado en test/productivity-month.test.ts. Solo lo usa el servidor:
// el navegador recibe los meses ya armados.

import type { DateRange } from "@/lib/access";
import { tzParts } from "@/lib/metrics";

/** El primer mes con ventas registradas (`order_sales` empieza en junio de 2026). */
export const PRODUCTIVITY_FIRST_MONTH = "2026-06";

const MONTH_NAMES = [
  "enero", "febrero", "marzo", "abril", "mayo", "junio",
  "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
];
const MONTH_ABBR = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/** `?mes=2026-09` → "2026-09"; cualquier otra cosa, null. */
export function parseMonthParam(raw: string | null | undefined): string | null {
  return raw && MONTH_RE.test(raw) ? raw : null;
}

function parts(month: string): { y: number; m: number } {
  return { y: Number(month.slice(0, 4)), m: Number(month.slice(5, 7)) };
}

export function daysInMonth(month: string): number {
  const { y, m } = parts(month);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

export function shiftMonth(month: string, delta: number): string {
  const { y, m } = parts(month);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

const dayOf = (month: string, n: number) => `${month}-${String(n).padStart(2, "0")}`;

/** "septiembre" */
export function monthName(month: string): string {
  return MONTH_NAMES[parts(month).m - 1] ?? month;
}

/** "Septiembre 2026" */
export function monthLabel(month: string): string {
  const name = monthName(month);
  return `${name.charAt(0).toUpperCase()}${name.slice(1)} ${parts(month).y}`;
}

/** El mes entero, del 1 al último día. */
export function fullMonthRange(month: string): DateRange {
  return { from: dayOf(month, 1), to: dayOf(month, daysInMonth(month)) };
}

export interface MonthView {
  month: string;
  /** "Octubre 2026" */
  label: string;
  /** El mes de hoy: se lee del 1 a hoy y tiene ritmo. */
  current: boolean;
  range: DateRange;
  /** Día del mes que se mira: hoy en el mes en curso, el último en uno cerrado. */
  day: number;
  daysInMonth: number;
  /** Con qué se comparan las cifras (las flechas). */
  prevRange: DateRange;
  /** Cómo se nombra esa comparación: "agosto" o "1–5 sep". */
  prevLabel: string;
  /** El mes anterior, entero: «septiembre cerró en …». */
  prevMonth: string;
}

/**
 * El mes a mirar, en el calendario local de la tienda. Un mes que todavía no
 * empezó no existe: devuelve null y la pantalla vuelve a su rango por omisión.
 */
export function monthView(month: string, tz: string, nowIso = new Date().toISOString()): MonthView | null {
  if (!parseMonthParam(month)) return null;
  const today = tzParts(nowIso, tz).date;
  const currentMonth = today.slice(0, 7);
  if (month > currentMonth) return null;
  const total = daysInMonth(month);
  const prevMonth = shiftMonth(month, -1);
  const base = { month, label: monthLabel(month), daysInMonth: total, prevMonth };
  if (month < currentMonth) {
    return {
      ...base,
      current: false,
      range: fullMonthRange(month),
      day: total,
      prevRange: fullMonthRange(prevMonth),
      prevLabel: monthName(prevMonth),
    };
  }
  const day = Number(today.slice(8, 10));
  // El 31 de marzo se compara con el 1-28 de febrero: no hay más días que comparar.
  const prevTo = Math.min(day, daysInMonth(prevMonth));
  const abbr = MONTH_ABBR[parts(prevMonth).m - 1];
  return {
    ...base,
    current: true,
    range: { from: dayOf(month, 1), to: today },
    day,
    prevRange: { from: dayOf(prevMonth, 1), to: dayOf(prevMonth, prevTo) },
    prevLabel: prevTo === 1 ? `1 ${abbr}` : `1–${prevTo} ${abbr}`,
  };
}

/** Los meses que se pueden elegir, del actual hacia atrás, hasta el primero con datos. */
export function recentMonths(
  tz: string,
  nowIso = new Date().toISOString(),
  first = PRODUCTIVITY_FIRST_MONTH,
  max = 12,
): { month: string; label: string }[] {
  const out: { month: string; label: string }[] = [];
  let month = tzParts(nowIso, tz).date.slice(0, 7);
  while (month >= first && out.length < max) {
    out.push({ month, label: monthLabel(month) });
    month = shiftMonth(month, -1);
  }
  return out;
}

/** Ventas de un día local: cuántos pedidos se cerraron y por cuánto. */
export interface DayTotals {
  date: string;
  cerrados: number;
  ingresos: number;
}

export interface MonthPace {
  /** Días del mes ya terminados (hasta ayer). */
  completedDays: number;
  /** Cómo cerraría el mes a este ritmo; null mientras no haya un día terminado. */
  projected: { cerrados: number; ingresos: number } | null;
}

/**
 * A qué ritmo va el mes en curso. El ritmo sale de los días YA TERMINADOS
 * —hoy todavía no cerró, y contarlo a medias lo bajaría cada mañana—, y se
 * reparte en el mes entero. Un mes cerrado no tiene ritmo: ya tiene resultado.
 */
export function monthPace(daily: readonly DayTotals[], view: MonthView): MonthPace {
  if (!view.current) return { completedDays: view.daysInMonth, projected: null };
  const completedDays = view.day - 1;
  if (completedDays < 1) return { completedDays: 0, projected: null };
  const lastDone = dayOf(view.month, completedDays);
  let cerrados = 0;
  let ingresos = 0;
  for (const d of daily) {
    if (d.date < view.range.from || d.date > lastDone) continue;
    cerrados += d.cerrados;
    ingresos += d.ingresos;
  }
  const factor = view.daysInMonth / completedDays;
  return {
    completedDays,
    projected: { cerrados: Math.round(cerrados * factor), ingresos: Math.round(ingresos * factor) },
  };
}
