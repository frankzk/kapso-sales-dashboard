// Los turnos de almacén y sus cortes.
//
// Un corte único no servía: el almacén trabaja en dos turnos con horarios y
// calendarios distintos, y decir «Lima debe estar en cero» sin decir a qué hora
// y de quién es la responsabilidad no permite exigir nada. Lo que la pantalla
// tiene que responder es «¿mi turno cerró lo suyo?».
//
// Todo se calcula en hora de Lima. Perú no tiene horario de verano —el desfase
// es UTC-5 todo el año—, así que la aritmética en minutos locales es exacta y
// evita construir fechas en otra zona, que es donde se cuelan los errores.

/** El turno, por su hora. */
export type WarehouseShiftId = "manana" | "noche";

export interface WarehouseShift {
  id: WarehouseShiftId;
  label: string;
  /** La hora de corte tal como se dice en el almacén. */
  cutoff: string;
  /** Esa misma hora en minutos desde medianoche de Lima. */
  cutoffMinutes: number;
  /** Días en que ese turno trabaja. 0 es domingo, 6 sábado. */
  days: readonly number[];
}

/**
 * Los dos turnos.
 *
 * El de noche trabaja de domingo a viernes y descansa el sábado; el de mañana,
 * de lunes a viernes. La consecuencia —que el sábado no tiene ningún corte
 * porque no hay nadie a quien exigírselo— sale de aquí, no de un caso especial.
 */
export const WAREHOUSE_SHIFTS: readonly WarehouseShift[] = [
  { id: "manana", label: "Turno mañana", cutoff: "10:20", cutoffMinutes: 10 * 60 + 20, days: [1, 2, 3, 4, 5] },
  { id: "noche", label: "Turno noche", cutoff: "21:20", cutoffMinutes: 21 * 60 + 20, days: [0, 1, 2, 3, 4, 5] },
];

/** Desde cuándo avisar de que el corte se acerca. */
export const SHIFT_WARNING_MINUTES = 90;

/**
 * Cuánto sigue siendo exigible un corte ya vencido.
 *
 * Pasado ese plazo la caja sigue pendiente, pero deja de ser «el turno no
 * cerró» y pasa a ser atraso, que es lo que ya cuenta el contador de detenidas.
 * Sin este tope, el corte del viernes por la noche teñiría de rojo todo el
 * sábado, que es justo el día en que no hay nadie trabajando.
 */
export const SHIFT_MISSED_MINUTES = 240;

export interface ShiftCutoff {
  shift: WarehouseShift;
  /** Minutos que faltan para el corte, o que han pasado desde él. */
  minutes: number;
}

export interface WarehouseShiftStatus {
  /** El corte que viene. `null` solo si no hubiera ningún turno definido. */
  next: ShiftCutoff | null;
  /** El corte recién vencido, mientras siga siendo exigible. */
  missed: ShiftCutoff | null;
}

const MINUTES_PER_DAY = 1440;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Día de la semana y minuto del día, en Lima. */
export function limaClock(now: Date): { weekday: number; minutes: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Lima",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  const weekday = WEEKDAYS.indexOf(get("weekday"));
  return {
    weekday: weekday < 0 ? 0 : weekday,
    minutes: Number(get("hour")) * 60 + Number(get("minute")),
  };
}

/** Los turnos que trabajan ese día de la semana. */
export function shiftsOn(weekday: number): WarehouseShift[] {
  return WAREHOUSE_SHIFTS.filter((shift) => shift.days.includes(weekday));
}

/**
 * En qué punto del calendario de turnos estamos.
 *
 * Se recorre una semana hacia delante y otra hacia atrás en minutos locales, en
 * vez de construir instantes en la zona de Lima: el calendario tiene huecos
 * —el sábado— y el siguiente corte puede caer a dos días vista.
 */
export function warehouseShiftStatus(now: Date = new Date()): WarehouseShiftStatus {
  const { weekday, minutes } = limaClock(now);

  let next: ShiftCutoff | null = null;
  let missed: ShiftCutoff | null = null;

  for (let offset = 0; offset <= 7; offset += 1) {
    // Hacia delante.
    for (const shift of shiftsOn((weekday + offset) % 7)) {
      const delta = offset * MINUTES_PER_DAY + shift.cutoffMinutes - minutes;
      if (delta >= 0 && (!next || delta < next.minutes)) next = { shift, minutes: delta };
    }
    // Hacia atrás. Un corte exactamente ahora cuenta como próximo, no como
    // vencido: todavía se está cumpliendo.
    for (const shift of shiftsOn(((weekday - offset) % 7 + 7) % 7)) {
      const delta = minutes + offset * MINUTES_PER_DAY - shift.cutoffMinutes;
      if (delta > 0 && (!missed || delta < missed.minutes)) missed = { shift, minutes: delta };
    }
  }

  if (missed && missed.minutes > SHIFT_MISSED_MINUTES) missed = null;
  return { next, missed };
}

/** Cómo se lee el estado del corte cuando todavía quedan cajas. */
export type ShiftTone = "vencido" | "cerca" | "normal";

/**
 * El tono del recuadro.
 *
 * `total` es cuántas cajas quedan: sin cajas no hay nada que exigir, y el corte
 * deja de importar aunque haya pasado.
 */
export function shiftTone(status: WarehouseShiftStatus, total: number): ShiftTone {
  if (total <= 0) return "normal";
  if (status.missed) return "vencido";
  if (status.next && status.next.minutes <= SHIFT_WARNING_MINUTES) return "cerca";
  return "normal";
}

/** «45 min», «2 h 10 min» — para no leer 130 minutos y tener que dividir. */
export function formatMinutes(total: number): string {
  const minutes = Math.max(0, Math.round(total));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
}
