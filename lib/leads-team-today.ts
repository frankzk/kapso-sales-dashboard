// El equipo de hoy del «Tablero de hoy» de Leads, ARMADO: el ranking, el «vs.
// ayer a esta hora», la meta del día, los avisos y la carrera de pedidos.
//
// Módulo PURO a propósito, como lib/productivity-week.ts: sin base de datos ni
// red, para probarlo y para que el componente del navegador pueda importar sus
// tipos y su umbral sin arrastrar el cliente de servicio. La lectura vive en
// lib/productivity.ts (`getTeamToday`) y la carga en lib/leads-insights.ts.

import type { SaleTick, TeamTodayRaw } from "@/lib/productivity";
import {
  ACTIVE_GAP_MS,
  DEFAULT_SCHEDULE,
  LATE_GRACE_MIN,
  localDateOf,
  minutesOf,
  type AdvisorSchedule,
  type DayActivity,
} from "@/lib/productivity-week";

/** Con menos leads trabajados el % de cierre todavía no dice nada: 1 pedido de
 *  1 lead no es un 100 %. Por debajo se ve «—», y sin pedidos va al pie. */
export const CIERRE_MIN_LEADS = 10;

/** El eje de la carrera del día: de 8:00 a 20:00, o hasta la hora de ahora si
 *  ya es más tarde. */
export const RACE_FROM = 8;
export const RACE_TO = 20;

export interface TeamRow {
  userId: string;
  /** La parte del correo antes de la @, como en Productividad. */
  name: string;
  pedidos: number;
  /** Los pedidos que llevaba ayer a esta misma hora. */
  pedidosAyer: number;
  /** Leads distintos trabajados hoy: el denominador del % de cierre. */
  leads: number;
  /** Solo kind="call". */
  llamadas: number;
  /** Los pedidos de hoy, para ver cuáles son («#AUR1091» + «15/10/26»). */
  pedidosDetalle: { code: string | null; fecha: string | null }[];
  /** Horas activas de hoy; null si quien mira no puede ver las de esta persona. */
  horas: number | null;
  /** Su parte de la meta para hoy (la de la semana entre sus días de trabajo);
   *  0 si hoy no le toca; null si quien mira no la puede ver. */
  metaDia: number | null;
  /** Minutos tarde de la primera actividad, pasada la gracia. */
  tardeMin: number | null;
  /** «HH:MM» de la última actividad si, dentro de su horario, lleva más de
   *  45 min sin registrar nada (la pausa que corta las horas activas). */
  inactivaDesde: string | null;
  /** Ya pasada su salida: cuántos minutos antes de ella fue la última actividad. */
  salioAntesMin: number | null;
}

export interface TeamRace {
  from: number;
  to: number;
  /** Hora local de ahora con decimales (18.7 = 18:42). */
  now: number;
  /** El acumulado al empezar cada hora: `hoy` de `from` a la hora en curso,
   *  `ayer` y `semana` de `from` a `to`. */
  hoy: number[];
  ayer: number[];
  semana: number[];
  hoyNow: number;
  ayerNow: number;
  semanaNow: number;
  /** «el martes pasado». */
  semanaLabel: string;
}

export interface TeamToday {
  /** Por pedidos, después por leads trabajados. */
  rows: TeamRow[];
  /** Sin pedidos y con menos de CIERRE_MIN_LEADS leads: van juntas al pie. */
  quiet: TeamRow[];
  totals: { pedidos: number; pedidosAyer: number; leads: number; llamadas: number };
  race: TeamRace;
  /** «18:42». */
  nowLabel: string;
  /** false = quien mira es vendedora: solo recibe sus propias horas y avisos. */
  horasDeTodas: boolean;
  /** De las filas con meta hoy, cuántas ya la cumplen. Null si no se ven. */
  metaCumplida: { cumplen: number; de: number } | null;
}

const WEEKDAYS_LONG = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];
const ACTIVE_GAP_MIN = ACTIVE_GAP_MS / 60_000;

const round1 = (n: number) => Math.round(n * 10) / 10;

/** ISO → "dd/mm/aa" in the store's timezone (null-safe), for the pedidos tooltip. */
export function shortLocalDate(iso: string | null | undefined, tz: string): string | null {
  if (!iso) return null;
  const d = localDateOf(iso, tz); // YYYY-MM-DD
  return `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(2, 4)}`;
}

const clockFormatters = new Map<string, Intl.DateTimeFormat>();

/** Minutos desde la medianoche LOCAL de un instante. */
export function localMinutes(iso: string, tz: string): number {
  let f = clockFormatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false });
    clockFormatters.set(tz, f);
  }
  const parts = f.formatToParts(new Date(iso));
  const h = Number(parts.find((p) => p.type === "hour")?.value ?? 0) % 24;
  const m = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  return h * 60 + m;
}

const hhmm = (minutes: number) =>
  `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

/**
 * Los avisos del día de una persona contra su horario, con las reglas de
 * Productividad: «Tarde» si la primera actividad pasa la entrada más 10 min de
 * gracia; «Sin actividad desde» si, dentro del horario, lleva más de 45 min
 * sin nada (la pausa que corta las horas activas); y, ya pasada la salida,
 * «Salió antes» si la última fue más de 10 min antes. Sin horario cargado, o
 * un día que no le toca, no se juzga nada.
 */
export function dayWarnings(
  act: DayActivity | undefined,
  schedule: AdvisorSchedule,
  programado: boolean,
  nowMin: number,
): Pick<TeamRow, "tardeMin" | "inactivaDesde" | "salioAntesMin"> {
  const none = { tardeMin: null, inactivaDesde: null, salioAntesMin: null };
  const start = minutesOf(schedule.start);
  const end = minutesOf(schedule.end);
  if (!programado || !act || start == null || end == null || end <= start) return none;
  const first = minutesOf(act.first);
  const last = minutesOf(act.last);
  const late = first != null ? first - start : null;
  let inactivaDesde: string | null = null;
  let salioAntesMin: number | null = null;
  if (last != null) {
    if (nowMin >= end) {
      const early = end - last;
      if (early > LATE_GRACE_MIN) salioAntesMin = early;
    } else if (nowMin >= start && nowMin - last > ACTIVE_GAP_MIN) {
      inactivaDesde = act.last;
    }
  }
  return { tardeMin: late != null && late > LATE_GRACE_MIN ? late : null, inactivaDesde, salioAntesMin };
}

/**
 * El equipo de hoy, armado. Pura.
 *
 * «vs. ayer» compara con lo que cada una llevaba AYER A ESTA MISMA HORA, no
 * con el día entero: a las 11:00 nadie le gana al día completo de ayer. El
 * total del equipo cuenta también a quien vendió ayer y hoy no aparece.
 */
export function buildTeamToday({
  raw,
  schedules,
  tz,
  nowIso,
  viewerId,
  horasDeTodas,
}: {
  raw: TeamTodayRaw;
  schedules: Map<string, AdvisorSchedule>;
  tz: string;
  nowIso: string;
  viewerId: string | null;
  horasDeTodas: boolean;
}): TeamToday {
  const nowMin = localMinutes(nowIso, tz);
  const minutes = (ticks: SaleTick[]) => ticks.map((t) => ({ who: t.vendedora, min: localMinutes(t.occurredAt, tz) }));
  const hoyM = minutes(raw.sales.hoy);
  const ayerM = minutes(raw.sales.ayer);
  const semanaM = minutes(raw.sales.semana);
  const ayerHastaAhora = ayerM.filter((t) => t.min <= nowMin);
  const ayerBy = new Map<string, number>();
  for (const t of ayerHastaAhora) ayerBy.set(t.who, (ayerBy.get(t.who) ?? 0) + 1);

  const all: TeamRow[] = raw.stats
    .map((s): TeamRow => {
      const sees = horasDeTodas || s.userId === viewerId;
      const act = raw.activity[s.userId];
      const schedule = schedules.get(s.userId) ?? DEFAULT_SCHEDULE;
      const programado = schedule.days.includes(raw.days.isoDow);
      const metaDia = programado && schedule.days.length ? round1(schedule.weeklyHours / schedule.days.length) : 0;
      const warnings = sees
        ? dayWarnings(act, schedule, programado, nowMin)
        : { tardeMin: null, inactivaDesde: null, salioAntesMin: null };
      return {
        userId: s.userId,
        name: s.email.includes("@") ? s.email.split("@")[0]! : s.email,
        pedidos: s.cerrados,
        pedidosAyer: ayerBy.get(s.userId) ?? 0,
        leads: s.leadsTrabajados,
        llamadas: s.llamadas,
        pedidosDetalle: s.cerradosDetalle.map((o) => ({ code: o.name, fecha: shortLocalDate(o.at, tz) })),
        horas: sees ? (act?.horas ?? 0) : null,
        metaDia: sees ? metaDia : null,
        ...warnings,
      };
    })
    // Quien solo ordenó la cola («Resuelto») no trabajó leads ni vendió.
    .filter((r) => r.leads > 0 || r.pedidos > 0)
    .sort((a, b) => b.pedidos - a.pedidos || b.leads - a.leads || a.name.localeCompare(b.name));

  const isQuiet = (r: TeamRow) => r.pedidos === 0 && r.leads < CIERRE_MIN_LEADS;
  const rows = all.filter((r) => !isQuiet(r));
  const quiet = all.filter(isQuiet);

  const totals = {
    pedidos: all.reduce((n, r) => n + r.pedidos, 0),
    pedidosAyer: ayerHastaAhora.length,
    leads: all.reduce((n, r) => n + r.leads, 0),
    llamadas: all.reduce((n, r) => n + r.llamadas, 0),
  };

  const withMeta = rows.filter((r) => r.horas != null && r.metaDia != null && r.metaDia > 0);
  const metaCumplida = horasDeTodas
    ? { cumplen: withMeta.filter((r) => r.horas! >= r.metaDia!).length, de: withMeta.length }
    : null;

  // La carrera: el acumulado al empezar cada hora. Lo vendido antes de las 8:00
  // ya cuenta a las 8:00; el eje se estira si ya pasaron las 20:00.
  const to = Math.max(RACE_TO, Math.min(24, Math.ceil(nowMin / 60)));
  const hours: number[] = [];
  for (let h = RACE_FROM; h <= to; h++) hours.push(h);
  const cum = (ticks: { min: number }[], h: number) => ticks.reduce((n, t) => (t.min < h * 60 ? n + 1 : n), 0);
  const semanaDow = new Date(`${raw.days.semana}T12:00:00Z`).getUTCDay();
  const race: TeamRace = {
    from: RACE_FROM,
    to,
    now: round1(nowMin / 60),
    hoy: hours.filter((h) => h * 60 <= nowMin).map((h) => cum(hoyM, h)),
    ayer: hours.map((h) => cum(ayerM, h)),
    semana: hours.map((h) => cum(semanaM, h)),
    hoyNow: hoyM.length,
    ayerNow: ayerHastaAhora.length,
    semanaNow: semanaM.filter((t) => t.min <= nowMin).length,
    semanaLabel: `el ${WEEKDAYS_LONG[semanaDow]} pasado`,
  };

  return { rows, quiet, totals, race, nowLabel: hhmm(nowMin), horasDeTodas, metaCumplida };
}
