// La semana de cada asesora contra su meta de horas y su horario (Productividad).
// Módulo PURO: sin base de datos ni red, para probarlo y para importarlo desde
// cualquier lado. La lectura vive en lib/productivity.ts (`getWeekActivity`) y
// en lib/advisor-schedules.ts.
//
// DECISIÓN DEL OWNER (12-10-2026): las horas que cuentan son las ACTIVAS —las
// mismas de la columna «Horas»: bloques entre la primera y la última acción,
// cortados en pausas de más de 45 minutos—; la meta y el horario son de cada
// persona (Equipo › Horarios); y la semana se mira siempre entera, de lunes a
// domingo, aunque el tablero esté en «Hoy».

// Sin imports a propósito: Equipo (cliente) usa las etiquetas y la meta por
// defecto, y este módulo no debe arrastrar nada más al navegador.

const WEEKDAY_EN = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Fecha local (YYYY-MM-DD) y día de la semana (0 = domingo) de un instante en `tz`. */
function tzParts(iso: string, tz: string): { date: string; weekday: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
  }).formatToParts(new Date(iso));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return { date: `${get("year")}-${get("month")}-${get("day")}`, weekday: Math.max(0, WEEKDAY_EN.indexOf(get("weekday"))) };
}

/** Una pausa de más de 45 min corta el bloque de trabajo (almuerzo, descanso). */
export const ACTIVE_GAP_MS = 45 * 60 * 1000;

/** Minutos de gracia antes de marcar una llegada tarde o una salida temprana. */
export const LATE_GRACE_MIN = 10;

/** Cuántas horas puede ir por debajo de lo esperado sin contarse como atrasada. */
export const BEHIND_TOLERANCE_H = 1;

/** Un día con estas horas menos que su parte de la meta todavía cuenta como cumplido. */
const DAY_TOLERANCE_H = 0.5;

/**
 * Horas activas de una lista ORDENADA de instantes (ms): suma los bloques que
 * separan las pausas de más de `ACTIVE_GAP_MS`. Una acción suelta aporta ~0: un
 * solo punto no dice cuánto duró nada.
 */
export function activeHoursFromTimes(sorted: number[]): number {
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

/** Meta y horario de una persona. Sin horario (`start`/`end` null) solo se comparan horas. */
export interface AdvisorSchedule {
  weeklyHours: number;
  /** Días que trabaja, ISO: 1 = lunes … 7 = domingo. */
  days: number[];
  /** «09:00» o null. */
  start: string | null;
  end: string | null;
}

/** Lo que se usa con quien no tiene horario cargado: 48 h de lunes a sábado. */
export const DEFAULT_SCHEDULE: AdvisorSchedule = { weeklyHours: 48, days: [1, 2, 3, 4, 5, 6], start: null, end: null };

export interface WeekDay {
  date: string; // YYYY-MM-DD local
  /** 1 = lunes … 7 = domingo. */
  isoDow: number;
}

/** «HH:MM» → minutos desde la medianoche; null si no se puede leer. */
export function minutesOf(hhmm: string | null | undefined): number | null {
  const m = /^(\d{1,2}):(\d{2})/.exec(hhmm ?? "");
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

const hhmmOf = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

/**
 * Desde qué hora la primera actividad es «Tarde» y antes de cuál la última es
 * «Salió antes», con la gracia ya sumada: 09:00–18:00 → 09:10 y 17:50. Null
 * sin horario (o con uno que no se puede leer o al revés).
 */
export function graceTimes(schedule: Pick<AdvisorSchedule, "start" | "end">): { tarde: string; antes: string } | null {
  const start = minutesOf(schedule.start);
  const end = minutesOf(schedule.end);
  if (start == null || end == null || end <= start) return null;
  return { tarde: hhmmOf(Math.min(start + LATE_GRACE_MIN, 23 * 60 + 59)), antes: hhmmOf(Math.max(end - LATE_GRACE_MIN, 0)) };
}

function localClock(iso: string, tz: string): { hhmm: string; minutes: number } {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(
    new Date(iso),
  );
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  const h = get("hour") === "24" ? "00" : get("hour");
  const hhmm = `${h}:${get("minute")}`;
  return { hhmm, minutes: Number(h) * 60 + Number(get("minute")) };
}

/**
 * La semana en curso, de lunes a domingo en el calendario LOCAL de la tienda,
 * con hoy y la hora local de ahora (para lo que se esperaba a esta hora).
 */
export function weekWindow(
  tz: string,
  nowIso = new Date().toISOString(),
): { days: WeekDay[]; today: string; nowMinutes: number } {
  const { date: today, weekday } = tzParts(nowIso, tz);
  const isoToday = weekday === 0 ? 7 : weekday;
  const todayNoon = Date.parse(`${today}T12:00:00Z`); // ancla al mediodía: la suma de días no salta
  const days: WeekDay[] = [];
  for (let i = 1; i <= 7; i++) {
    const date = new Date(todayNoon + (i - isoToday) * 86_400_000).toISOString().slice(0, 10);
    days.push({ date, isoDow: i });
  }
  return { days, today, nowMinutes: localClock(nowIso, tz).minutes };
}

/** Los días de un rango local «YYYY-MM-DD» (ambos incluidos), con su día ISO. */
export function daysBetween(from: string, to: string): WeekDay[] {
  const out: WeekDay[] = [];
  const start = Date.parse(`${from}T12:00:00Z`); // mediodía: la suma de días no salta
  const end = Date.parse(`${to}T12:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return out;
  for (let ms = start; ms <= end; ms += 86_400_000) {
    const d = new Date(ms);
    out.push({ date: d.toISOString().slice(0, 10), isoDow: d.getUTCDay() === 0 ? 7 : d.getUTCDay() });
  }
  return out;
}

/** Las horas activas de un día, con la primera y la última actividad («HH:MM»). */
export interface DayActivity {
  date: string;
  horas: number;
  first: string | null;
  last: string | null;
}

/**
 * Horas activas por persona y día de la semana, desde todo su trabajo
 * registrado (gestiones de leads y de envíos). Cada día se cuenta aparte, como
 * la columna «Horas»: una pausa de la noche no une dos días.
 */
export function computeWeekActivity(
  events: { agent: string | null; occurred_at: string | null }[],
  tz: string,
  days: WeekDay[],
): Record<string, DayActivity[]> {
  const inWeek = new Set(days.map((d) => d.date));
  const byAgentDay = new Map<string, Map<string, number[]>>();
  for (const e of events) {
    if (!e.agent || !e.occurred_at) continue;
    const ms = Date.parse(e.occurred_at);
    if (!Number.isFinite(ms)) continue;
    const date = tzParts(e.occurred_at, tz).date;
    if (!inWeek.has(date)) continue;
    const perDay = byAgentDay.get(e.agent) ?? new Map<string, number[]>();
    const times = perDay.get(date) ?? [];
    times.push(ms);
    perDay.set(date, times);
    byAgentDay.set(e.agent, perDay);
  }
  const out: Record<string, DayActivity[]> = {};
  for (const [agent, perDay] of byAgentDay) {
    out[agent] = days.map((d) => {
      const times = (perDay.get(d.date) ?? []).sort((a, b) => a - b);
      if (!times.length) return { date: d.date, horas: 0, first: null, last: null };
      return {
        date: d.date,
        horas: Math.round(activeHoursFromTimes(times) * 10) / 10,
        first: localClock(new Date(times[0]!).toISOString(), tz).hhmm,
        last: localClock(new Date(times[times.length - 1]!).toISOString(), tz).hhmm,
      };
    });
  }
  return out;
}

/**
 * Cómo va un día: `cumplido` (llegó a su parte de la meta, con media hora de
 * margen), `corto`, `sin_actividad` (un día de trabajo ya pasado sin nada
 * registrado), `en_curso` (hoy), `futuro` y `libre` (no es día de trabajo).
 */
export type DayState = "cumplido" | "corto" | "sin_actividad" | "en_curso" | "futuro" | "libre";

export interface WeekDayStatus extends DayActivity {
  isoDow: number;
  programado: boolean;
  /** Su parte de la meta (la meta repartida entre los días de trabajo). */
  meta: number;
  /** Minutos tarde de la primera actividad, pasada la gracia; null si llegó a tiempo o no aplica. */
  tardeMin: number | null;
  /** Minutos antes de la salida de la última actividad, pasada la gracia (solo días ya cerrados). */
  antesMin: number | null;
  estado: DayState;
  /** Un día anterior a su alta en el equipo: no se le pedía nada. */
  antesDeAlta?: boolean;
}

/**
 * `al_dia` / `atrasada` mientras quedan días de trabajo (contra lo esperado a
 * esta hora); `cumplida` / `no_cumplida` cuando ya no queda ninguno.
 */
export type WeekState = "al_dia" | "atrasada" | "cumplida" | "no_cumplida";

export interface WeekStatus {
  horas: number;
  meta: number;
  /** Lo que debería llevar a esta hora: su parte de cada día de trabajo ya
   *  pasado y, hoy, la fracción de su horario ya transcurrida. */
  esperado: number;
  estado: WeekState;
  /** No le queda ningún día de trabajo en la semana. */
  cerrada: boolean;
  schedule: AdvisorSchedule;
  /** Sin horario cargado: usa la meta por defecto. */
  porDefecto: boolean;
  dias: WeekDayStatus[];
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/** La semana de una persona contra su meta y su horario. Pura. */
export function evaluateWeek({
  activity,
  days,
  schedule,
  porDefecto,
  today,
  nowMinutes,
}: {
  activity: DayActivity[] | undefined;
  days: WeekDay[];
  schedule: AdvisorSchedule;
  porDefecto: boolean;
  today: string;
  nowMinutes: number;
}): WeekStatus {
  const workDays = new Set(schedule.days);
  const daily = workDays.size ? schedule.weeklyHours / workDays.size : 0;
  const start = minutesOf(schedule.start);
  const end = minutesOf(schedule.end);
  const hasWindow = start != null && end != null && end > start;

  let horas = 0;
  let esperado = 0;
  let cerrada = true;
  const dias: WeekDayStatus[] = days.map((d) => {
    const act = activity?.find((a) => a.date === d.date) ?? { date: d.date, horas: 0, first: null, last: null };
    horas += act.horas;
    const programado = workDays.has(d.isoDow);
    const past = d.date < today;
    const isToday = d.date === today;
    if (programado && !past) cerrada = false;

    if (programado && past) esperado += daily;
    if (programado && isToday && hasWindow) {
      esperado += daily * Math.min(1, Math.max(0, (nowMinutes - start!) / (end! - start!)));
    }

    const first = minutesOf(act.first);
    const last = minutesOf(act.last);
    const late = programado && hasWindow && first != null && (past || isToday) ? first - start! : null;
    const early = programado && hasWindow && last != null && past ? end! - last : null;

    let estado: DayState;
    if (!programado) estado = "libre";
    else if (d.date > today) estado = "futuro";
    else if (isToday) estado = "en_curso";
    else if (act.first == null) estado = "sin_actividad";
    else estado = act.horas >= daily - DAY_TOLERANCE_H ? "cumplido" : "corto";

    return {
      ...act,
      isoDow: d.isoDow,
      programado,
      meta: round1(daily),
      tardeMin: late != null && late > LATE_GRACE_MIN ? late : null,
      antesMin: early != null && early > LATE_GRACE_MIN ? early : null,
      estado,
    };
  });

  horas = round1(horas);
  esperado = round1(esperado);
  const meta = schedule.weeklyHours;
  const estado: WeekState = cerrada
    ? horas >= meta - 0.05
      ? "cumplida"
      : "no_cumplida"
    : horas >= esperado - BEHIND_TOLERANCE_H
      ? "al_dia"
      : "atrasada";
  return { horas, meta, esperado, estado, cerrada, schedule, porDefecto, dias };
}

/**
 * Hasta cuántos días la franja de un periodo va día por día; más largo, por
 * semana (con 30 cuadritos no se lee ninguno).
 */
export const PERIOD_DAYS_MAX = 14;

/** Una semana (lunes a domingo) del periodo, recortada a sus bordes. */
export interface PeriodWeek {
  from: string;
  to: string;
  horas: number;
  /** Lo que tocaba en los días de trabajo de ese tramo. */
  meta: number;
  estado: DayState;
}

/**
 * Junta los días de un periodo en semanas de lunes a domingo. Una semana con
 * días por venir va `en_curso` (o `futuro` si todavía no empezó); cerrada, se
 * juzga entera contra su meta con 1 h de margen, como la semana en curso.
 */
export function groupWeeks(dias: WeekDayStatus[]): PeriodWeek[] {
  const out: PeriodWeek[] = [];
  let cur: WeekDayStatus[] = [];
  const flush = () => {
    if (!cur.length) return;
    const horas = round1(cur.reduce((n, d) => n + d.horas, 0));
    const meta = round1(cur.reduce((n, d) => n + (d.programado ? d.meta : 0), 0));
    const work = cur.filter((d) => d.programado);
    let estado: DayState;
    if (work.length && work.every((d) => d.estado === "futuro")) estado = "futuro";
    else if (work.some((d) => d.estado === "futuro" || d.estado === "en_curso")) estado = "en_curso";
    else if (meta <= 0) estado = "libre";
    else if (horas <= 0) estado = "sin_actividad";
    else estado = horas >= meta - BEHIND_TOLERANCE_H ? "cumplido" : "corto";
    out.push({ from: cur[0]!.date, to: cur[cur.length - 1]!.date, horas, meta, estado });
    cur = [];
  };
  for (const d of dias) {
    if (d.isoDow === 1) flush();
    cur.push(d);
  }
  flush();
  return out;
}

/** La fecha local «YYYY-MM-DD» de un instante. */
export function localDateOf(iso: string, tz: string): string {
  return tzParts(iso, tz).date;
}

/**
 * Un periodo de varios días de una persona: cada día como en la semana, y lo
 * que le tocaba hasta ahora. Los días antes de su alta (`desde`) no se le
 * piden: van libres y lo dicen, y no suman a lo que tocaba.
 */
export function evaluatePeriod(
  opts: Parameters<typeof evaluateWeek>[0] & { desde?: string | null },
): { dias: WeekDayStatus[]; horas: number; esperado: number } {
  const { desde, ...week } = opts;
  const { dias } = evaluateWeek(week);
  const counted = desde ? week.days.filter((d) => d.date >= desde) : week.days;
  const esperado = counted.length ? evaluateWeek({ ...week, days: counted }).esperado : 0;
  const out = desde
    ? dias.map((d): WeekDayStatus =>
        d.date < desde && !d.first
          ? { ...d, programado: false, meta: 0, estado: "libre", tardeMin: null, antesMin: null, antesDeAlta: true }
          : d,
      )
    : dias;
  return { dias: out, horas: round1(out.reduce((n, d) => n + d.horas, 0)), esperado };
}

/** Una fila de `advisor_schedules` (las horas vienen como «09:00:00»). */
export interface AdvisorScheduleRow {
  user_id: string;
  weekly_hours: number | string;
  days: number[] | null;
  start_time: string | null;
  end_time: string | null;
}

export function scheduleFromRow(row: AdvisorScheduleRow): AdvisorSchedule {
  const hhmm = (t: string | null) => (t && minutesOf(t) != null ? t.slice(0, 5) : null);
  const start = hhmm(row.start_time);
  const end = hhmm(row.end_time);
  const days = [...new Set((row.days ?? []).map(Number).filter((d) => d >= 1 && d <= 7))].sort((a, b) => a - b);
  return {
    weeklyHours: Number(row.weekly_hours) || 0,
    days,
    start: start && end ? start : null,
    end: start && end ? end : null,
  };
}

/**
 * Lo que llega del formulario de Equipo, validado. Devuelve el horario listo
 * para guardar o el motivo, en la lengua de la pantalla.
 */
export function parseScheduleInput(input: {
  weeklyHours: unknown;
  days: unknown;
  start: unknown;
  end: unknown;
}): { schedule: AdvisorSchedule } | { error: string } {
  const weeklyHours = Number(String(input.weeklyHours ?? "").replace(",", "."));
  if (!Number.isFinite(weeklyHours) || weeklyHours < 0 || weeklyHours > 84) {
    return { error: "La meta de la semana tiene que ser un número de horas entre 0 y 84." };
  }
  const rawDays = Array.isArray(input.days) ? input.days : [];
  const days = [...new Set(rawDays.map(Number).filter((d) => Number.isInteger(d) && d >= 1 && d <= 7))].sort((a, b) => a - b);
  if (!days.length) return { error: "Elige al menos un día de trabajo." };
  const start = typeof input.start === "string" && input.start ? input.start.slice(0, 5) : null;
  const end = typeof input.end === "string" && input.end ? input.end.slice(0, 5) : null;
  if ((start == null) !== (end == null)) return { error: "El horario necesita la entrada y la salida, o ninguna de las dos." };
  if (start != null && end != null) {
    const s = minutesOf(start);
    const e = minutesOf(end);
    if (s == null || e == null) return { error: "La hora de entrada o de salida no se entiende." };
    if (e <= s) return { error: "La salida tiene que ser después de la entrada." };
  }
  return { schedule: { weeklyHours: Math.round(weeklyHours * 10) / 10, days, start, end } };
}

const DOW_SHORT = ["lun", "mar", "mié", "jue", "vie", "sáb", "dom"];

/** «lun a sáb» si los días van seguidos (tres o más); si no, «lun, mié, vie». */
export function daysLabel(days: number[]): string {
  const sorted = [...new Set(days)].filter((d) => d >= 1 && d <= 7).sort((a, b) => a - b);
  if (!sorted.length) return "sin días";
  const consecutive = sorted.every((d, i) => i === 0 || d === sorted[i - 1]! + 1);
  if (sorted.length >= 3 && consecutive) return `${DOW_SHORT[sorted[0]! - 1]} a ${DOW_SHORT[sorted[sorted.length - 1]! - 1]}`;
  return sorted.map((d) => DOW_SHORT[d - 1]).join(", ");
}

/** El nombre corto de un día ISO: 1 → «lun». */
export function dowShort(isoDow: number): string {
  return DOW_SHORT[isoDow - 1] ?? "";
}
