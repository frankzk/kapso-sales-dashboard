import { describe, expect, it } from "vitest";
import {
  formatMinutes,
  limaClock,
  shiftsOn,
  shiftTone,
  warehouseShiftStatus,
  SHIFT_MISSED_MINUTES,
  SHIFT_WARNING_MINUTES,
} from "@/lib/warehouse-shift";

/** Un instante de Lima, dicho en Lima. Perú es UTC-5 todo el año. */
function lima(day: string, hhmm: string): Date {
  return new Date(`${day}T${hhmm}:00-05:00`);
}

// Anclas de calendario: 2026-08-10 es lunes.
const LUNES = "2026-08-10";
const VIERNES = "2026-08-14";
const SABADO = "2026-08-15";
const DOMINGO = "2026-08-16";

describe("limaClock", () => {
  it("lee el día y la hora en Lima, no en UTC", () => {
    // 03:00Z del lunes son las 22:00 del domingo en Lima: el día cambia.
    const clock = limaClock(new Date("2026-08-10T03:00:00Z"));
    expect(clock.weekday).toBe(0);
    expect(clock.minutes).toBe(22 * 60);
  });

  it("la medianoche de Lima es el minuto cero, no el 1440", () => {
    expect(limaClock(lima(LUNES, "00:00")).minutes).toBe(0);
  });
});

describe("shiftsOn", () => {
  it("el sábado no trabaja nadie", () => {
    // Mañana es lunes a viernes y noche descansa el sábado: el hueco sale del
    // calendario de cada turno, no de un caso especial.
    expect(shiftsOn(6)).toEqual([]);
  });

  it("el domingo solo trabaja el turno noche", () => {
    expect(shiftsOn(0).map((shift) => shift.id)).toEqual(["noche"]);
  });

  it("de lunes a viernes trabajan los dos", () => {
    expect(shiftsOn(3).map((shift) => shift.id)).toEqual(["manana", "noche"]);
  });
});

describe("warehouseShiftStatus", () => {
  it("antes del corte de la mañana, el próximo es el de las 10:20", () => {
    const { next, missed } = warehouseShiftStatus(lima(LUNES, "09:20"));
    expect(next?.shift.id).toBe("manana");
    expect(next?.minutes).toBe(60);
    expect(missed).toBeNull();
  });

  it("pasado el corte de la mañana lo marca vencido y apunta al de la noche", () => {
    const { next, missed } = warehouseShiftStatus(lima(LUNES, "10:50"));
    expect(missed?.shift.id).toBe("manana");
    expect(missed?.minutes).toBe(30);
    expect(next?.shift.id).toBe("noche");
    expect(next?.minutes).toBe(10 * 60 + 30);
  });

  it("un corte vencido deja de ser exigible pasado el plazo", () => {
    // A las 15:20 han pasado 5 h del corte de la mañana: sigue pendiente, pero
    // ya no es «el turno no cerró», es atraso.
    const { missed } = warehouseShiftStatus(lima(LUNES, "15:20"));
    expect(missed).toBeNull();
    expect(SHIFT_MISSED_MINUTES).toBe(240);
  });

  it("el sábado no hereda el rojo del viernes por la noche", () => {
    // Es el caso que justifica el tope: sin él, el corte del viernes teñiría
    // todo el sábado, que es justo el día sin nadie a quien exigírselo.
    const { missed, next } = warehouseShiftStatus(lima(SABADO, "11:00"));
    expect(missed).toBeNull();
    // Y el siguiente corte es ya el del turno noche del domingo.
    expect(next?.shift.id).toBe("noche");
    expect(next?.minutes).toBe(34 * 60 + 20);
  });

  it("el sábado de madrugada todavía arrastra el corte del viernes", () => {
    const { missed } = warehouseShiftStatus(lima(SABADO, "00:20"));
    expect(missed?.shift.id).toBe("noche");
    expect(missed?.minutes).toBe(3 * 60);
  });

  it("el domingo por la mañana no exige un corte que no existe", () => {
    // El turno mañana no trabaja el domingo: el próximo corte es el de la noche.
    const { next, missed } = warehouseShiftStatus(lima(DOMINGO, "10:00"));
    expect(next?.shift.id).toBe("noche");
    expect(missed).toBeNull();
  });

  it("justo en el corte todavía se está cumpliendo, no incumpliendo", () => {
    const { next, missed } = warehouseShiftStatus(lima(VIERNES, "10:20"));
    expect(next?.shift.id).toBe("manana");
    expect(next?.minutes).toBe(0);
    expect(missed).toBeNull();
  });
});

describe("shiftTone", () => {
  const vencido = warehouseShiftStatus(lima(LUNES, "10:50"));
  const cerca = warehouseShiftStatus(lima(LUNES, "09:20"));
  const lejos = warehouseShiftStatus(lima(LUNES, "06:00"));

  it("sin cajas no hay nada que exigir, aunque el corte haya pasado", () => {
    expect(shiftTone(vencido, 0)).toBe("normal");
  });

  it("con cajas y el corte pasado, vencido", () => {
    expect(shiftTone(vencido, 3)).toBe("vencido");
  });

  it("con cajas y el corte encima, cerca", () => {
    expect(cerca.next?.minutes).toBeLessThanOrEqual(SHIFT_WARNING_MINUTES);
    expect(shiftTone(cerca, 3)).toBe("cerca");
  });

  it("con cajas y el corte lejos, normal", () => {
    expect(shiftTone(lejos, 3)).toBe("normal");
  });
});

describe("formatMinutes", () => {
  it("no obliga a dividir mentalmente", () => {
    expect(formatMinutes(45)).toBe("45 min");
    expect(formatMinutes(130)).toBe("2 h 10 min");
    expect(formatMinutes(120)).toBe("2 h");
    expect(formatMinutes(-5)).toBe("0 min");
  });
});
