// La semana de cada asesora contra su meta y su horario (12-10-2026): con
// asesoras en remoto, el owner necesita saber que cumplen sus 48 h y su horario.
// Las horas son las ACTIVAS (las de la columna «Horas»), en el calendario LOCAL.

import { describe, expect, it } from "vitest";
import {
  activeHoursFromTimes,
  computeWeekActivity,
  daysLabel,
  DEFAULT_SCHEDULE,
  evaluateWeek,
  graceTimes,
  minutesOf,
  parseScheduleInput,
  scheduleFromRow,
  weekWindow,
  type AdvisorSchedule,
  type DayActivity,
} from "@/lib/productivity-week";

const TZ = "America/Lima";
// Jueves 08-10-2026 a las 15:00 de Lima (20:00 UTC).
const THURSDAY_3PM = "2026-10-08T20:00:00.000Z";

describe("weekWindow", () => {
  it("va de lunes a domingo en el calendario local, con hoy y la hora de ahora", () => {
    const w = weekWindow(TZ, THURSDAY_3PM);
    expect(w.days.map((d) => d.date)).toEqual([
      "2026-10-05",
      "2026-10-06",
      "2026-10-07",
      "2026-10-08",
      "2026-10-09",
      "2026-10-10",
      "2026-10-11",
    ]);
    expect(w.days.map((d) => d.isoDow)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(w.today).toBe("2026-10-08");
    expect(w.nowMinutes).toBe(15 * 60);
  });

  it("el domingo por la noche en Lima sigue siendo la misma semana (no el lunes UTC)", () => {
    // Domingo 11-10 a las 21:00 de Lima = lunes 12-10 02:00 UTC.
    const w = weekWindow(TZ, "2026-10-12T02:00:00.000Z");
    expect(w.today).toBe("2026-10-11");
    expect(w.days[0]!.date).toBe("2026-10-05");
  });
});

describe("activeHoursFromTimes", () => {
  it("suma los bloques y corta en pausas de más de 45 minutos", () => {
    const at = (h: number, m = 0) => Date.UTC(2026, 9, 8, h, m);
    // 9:00–12:00 (con acciones cada 30 min), almuerzo, 13:30–15:00.
    const times = [at(9), at(9, 30), at(10), at(10, 30), at(11), at(11, 30), at(12), at(13, 30), at(14), at(14, 30), at(15)];
    expect(activeHoursFromTimes(times)).toBeCloseTo(4.5);
  });

  it("una acción suelta no suma horas", () => {
    expect(activeHoursFromTimes([Date.UTC(2026, 9, 8, 9)])).toBe(0);
  });
});

describe("computeWeekActivity", () => {
  it("cuenta cada día aparte, con la primera y la última actividad en hora local", () => {
    const { days } = weekWindow(TZ, THURSDAY_3PM);
    const events = [
      // Lunes 05-10: 09:05 a 13:05 Lima (14:05–18:05 UTC), cada 20 min.
      ...Array.from({ length: 13 }, (_, i) => ({ agent: "ana", occurred_at: new Date(Date.UTC(2026, 9, 5, 14, 5 + i * 20)).toISOString() })),
      // Martes 06-10 de noche en Lima (22:30) = miércoles UTC: es martes.
      { agent: "ana", occurred_at: "2026-10-07T03:30:00.000Z" },
      // Fuera de la semana: no cuenta.
      { agent: "ana", occurred_at: "2026-10-01T15:00:00.000Z" },
      { agent: null, occurred_at: "2026-10-05T15:00:00.000Z" },
    ];
    const out = computeWeekActivity(events, TZ, days);
    expect(Object.keys(out)).toEqual(["ana"]);
    const lunes = out.ana![0]!;
    expect(lunes).toEqual({ date: "2026-10-05", horas: 4, first: "09:05", last: "13:05" });
    const martes = out.ana![1]!;
    expect(martes.first).toBe("22:30");
    expect(martes.horas).toBe(0);
    expect(out.ana![3]).toEqual({ date: "2026-10-08", horas: 0, first: null, last: null });
  });
});

function act(date: string, horas: number, first: string | null, last: string | null): DayActivity {
  return { date, horas, first, last };
}

describe("evaluateWeek", () => {
  const { days, today, nowMinutes } = weekWindow(TZ, THURSDAY_3PM);
  const schedule: AdvisorSchedule = { weeklyHours: 48, days: [1, 2, 3, 4, 5, 6], start: "09:00", end: "18:00" };

  it("espera la parte de cada día pasado y, hoy, la fracción del horario ya transcurrida", () => {
    const activity = [act("2026-10-05", 8, "09:00", "18:00"), act("2026-10-06", 8, "09:05", "18:00"), act("2026-10-07", 8, "08:55", "17:59")];
    const w = evaluateWeek({ activity, days, schedule, porDefecto: false, today, nowMinutes });
    // 3 días × 8 h + hoy 6 de 9 horas del horario × 8 h.
    expect(w.esperado).toBeCloseTo(24 + (6 / 9) * 8, 1);
    expect(w.horas).toBe(24);
    expect(w.estado).toBe("atrasada"); // 24 contra ~29.3: más de 1 h por debajo
    expect(w.cerrada).toBe(false);
    expect(w.dias.map((d) => d.estado)).toEqual(["cumplido", "cumplido", "cumplido", "en_curso", "futuro", "futuro", "libre"]);
  });

  it("marca la llegada tarde y la salida temprana pasados 10 minutos de gracia", () => {
    const activity = [act("2026-10-05", 7, "09:25", "17:40"), act("2026-10-06", 8, "09:10", "17:52")];
    const w = evaluateWeek({ activity, days, schedule, porDefecto: false, today, nowMinutes });
    expect(w.dias[0]).toMatchObject({ tardeMin: 25, antesMin: 20, estado: "corto" });
    // 10 minutos justos y 8 antes: dentro de la gracia.
    expect(w.dias[1]).toMatchObject({ tardeMin: null, antesMin: null, estado: "cumplido" });
    // Un día de trabajo ya pasado sin nada registrado.
    expect(w.dias[2]).toMatchObject({ estado: "sin_actividad", tardeMin: null });
  });

  it("hoy se juzga la llegada, no la salida", () => {
    const activity = [act("2026-10-08", 5, "09:40", "14:58")];
    const w = evaluateWeek({ activity, days, schedule, porDefecto: false, today, nowMinutes });
    expect(w.dias[3]).toMatchObject({ estado: "en_curso", tardeMin: 40, antesMin: null });
  });

  it("sin horario solo compara horas: hoy no cuenta en lo esperado hasta que termina", () => {
    const activity = [act("2026-10-05", 8, "07:00", "15:00"), act("2026-10-06", 8, "07:00", "15:00"), act("2026-10-07", 7.5, "07:00", "14:30")];
    const w = evaluateWeek({ activity, days, schedule: DEFAULT_SCHEDULE, porDefecto: true, today, nowMinutes });
    expect(w.esperado).toBe(24);
    expect(w.horas).toBe(23.5);
    expect(w.estado).toBe("al_dia"); // media hora por debajo: dentro de la tolerancia
    expect(w.dias.every((d) => d.tardeMin == null && d.antesMin == null)).toBe(true);
    expect(w.porDefecto).toBe(true);
  });

  it("sin días de trabajo por delante, la semana se cierra: cumplida o no cumplida", () => {
    const sunday = weekWindow(TZ, "2026-10-11T20:00:00.000Z");
    const full = sunday.days.slice(0, 6).map((d) => act(d.date, 8, "09:00", "18:00"));
    const done = evaluateWeek({ activity: full, days: sunday.days, schedule, porDefecto: false, today: sunday.today, nowMinutes: sunday.nowMinutes });
    expect(done).toMatchObject({ cerrada: true, estado: "cumplida", horas: 48 });
    const short = full.map((d, i) => (i === 5 ? { ...d, horas: 4 } : d));
    const notDone = evaluateWeek({ activity: short, days: sunday.days, schedule, porDefecto: false, today: sunday.today, nowMinutes: sunday.nowMinutes });
    expect(notDone.estado).toBe("no_cumplida");
  });

  it("las horas de un día libre suman a la semana, pero el día no se juzga", () => {
    const sunday = weekWindow(TZ, "2026-10-11T20:00:00.000Z");
    const activity = [act("2026-10-11", 3, "10:00", "13:00")];
    const w = evaluateWeek({ activity, days: sunday.days, schedule, porDefecto: false, today: sunday.today, nowMinutes: sunday.nowMinutes });
    expect(w.horas).toBe(3);
    expect(w.dias[6]).toMatchObject({ estado: "libre", programado: false, tardeMin: null });
  });

  it("reparte la meta entre sus días: 40 h de lunes a viernes son 8 por día", () => {
    const w = evaluateWeek({
      activity: undefined,
      days,
      schedule: { weeklyHours: 40, days: [1, 2, 3, 4, 5], start: null, end: null },
      porDefecto: false,
      today,
      nowMinutes,
    });
    expect(w.dias[0]!.meta).toBe(8);
    expect(w.dias[5]!.estado).toBe("libre");
    expect(w.esperado).toBe(24);
    expect(w.estado).toBe("atrasada");
  });
});

describe("horarios guardados y del formulario", () => {
  it("lee la fila de la base: horas «09:00:00», días ordenados y sin repetir", () => {
    expect(
      scheduleFromRow({ user_id: "u", weekly_hours: "45.5", days: [6, 1, 2, 2], start_time: "08:30:00", end_time: "17:30:00" }),
    ).toEqual({ weeklyHours: 45.5, days: [1, 2, 6], start: "08:30", end: "17:30" });
    expect(scheduleFromRow({ user_id: "u", weekly_hours: 48, days: null, start_time: "08:30:00", end_time: null })).toMatchObject({
      start: null,
      end: null,
      days: [],
    });
  });

  it("valida el formulario y explica qué falta", () => {
    expect(parseScheduleInput({ weeklyHours: "48", days: [1, 2, 3, 4, 5, 6], start: "09:00", end: "18:00" })).toEqual({
      schedule: { weeklyHours: 48, days: [1, 2, 3, 4, 5, 6], start: "09:00", end: "18:00" },
    });
    expect(parseScheduleInput({ weeklyHours: "44,5", days: [1], start: "", end: "" })).toEqual({
      schedule: { weeklyHours: 44.5, days: [1], start: null, end: null },
    });
    expect(parseScheduleInput({ weeklyHours: "90", days: [1], start: null, end: null })).toHaveProperty("error");
    expect(parseScheduleInput({ weeklyHours: "48", days: [], start: null, end: null })).toHaveProperty("error");
    expect(parseScheduleInput({ weeklyHours: "48", days: [1], start: "09:00", end: "" })).toHaveProperty("error");
    expect(parseScheduleInput({ weeklyHours: "48", days: [1], start: "18:00", end: "09:00" })).toHaveProperty("error");
  });

  it("dice desde qué hora es tarde y antes de cuál salió antes, con la gracia sumada", () => {
    expect(graceTimes({ start: "09:00", end: "18:00" })).toEqual({ tarde: "09:10", antes: "17:50" });
    expect(graceTimes({ start: "10:00:00", end: "19:05:00" })).toEqual({ tarde: "10:10", antes: "18:55" });
    expect(graceTimes({ start: null, end: null })).toBeNull();
    expect(graceTimes({ start: "18:00", end: "08:00" })).toBeNull();
  });

  it("lee «HH:MM» y rechaza lo que no es una hora", () => {
    expect(minutesOf("09:30")).toBe(570);
    expect(minutesOf("09:30:00")).toBe(570);
    expect(minutesOf("25:00")).toBeNull();
    expect(minutesOf(null)).toBeNull();
  });
});

describe("daysLabel", () => {
  it("junta los días seguidos y enumera los sueltos", () => {
    expect(daysLabel([1, 2, 3, 4, 5, 6])).toBe("lun a sáb");
    expect(daysLabel([5, 1, 3])).toBe("lun, mié, vie");
    expect(daysLabel([6, 7])).toBe("sáb, dom");
    expect(daysLabel([])).toBe("sin días");
  });
});
