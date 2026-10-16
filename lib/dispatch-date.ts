// «Programar envío»: la fecha acordada con la clienta para despachar un pedido
// confirmado que todavía no tiene guía (MOM §6.2, 15-10-2026).
//
// POR QUÉ. En Preparación · Por generar rótulo, un pedido confirmado sin guía
// parecía olvidado aunque el equipo lo tuviera programado en su Excel («enviar
// lunes 26-10, recibe en su trabajo»): #KP140347. La fecha vivía fuera de Kapta,
// así que nadie podía distinguir lo programado de lo que se pasó.
//
// QUÉ ES. Un hecho del historial (`dispatch_date_set`, con actor, fecha y
// nota) que se puede cambiar o quitar (`dispatch_date_cleared`, con motivo);
// manda el último. Solo vale mientras el pedido sigue sin guía: una salida o
// guía creada después lo deja sin efecto, y si esa guía se anula el pedido no
// hereda una fecha vieja. El Master la guarda en `dispatch_scheduled_on`
// (0267) solo en Por generar rótulo.
//
// No es la «salida programada» de Grupo GF (`dispatch_programmed`, Lima): esa
// ya tiene caja y motorizado. Esta es anterior a la guía.
//
// Pura.

export const DISPATCH_DATE_SET = "dispatch_date_set";
export const DISPATCH_DATE_CLEARED = "dispatch_date_cleared";
/** Hasta cuántos días adelante se puede programar. Más que eso no es una fecha, es un «algún día». */
export const DISPATCH_DATE_MAX_DAYS = 45;

export interface DispatchDate {
  date: string;
  note: string | null;
  at: string;
}

type EventLike = { kind: string; occurred_at: string; reason?: string | null; payload?: unknown };

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * La fecha vigente, o null: el último `dispatch_date_set` sin un
 * `dispatch_date_cleared` posterior ni una guía creada después.
 */
export function currentDispatchDate(
  events: readonly EventLike[],
  guideCreatedAt: readonly (string | null | undefined)[] = [],
): DispatchDate | null {
  let latest: EventLike | null = null;
  for (const event of events) {
    if (event.kind !== DISPATCH_DATE_SET && event.kind !== DISPATCH_DATE_CLEARED) continue;
    if (!latest || event.occurred_at >= latest.occurred_at) latest = event;
  }
  if (!latest || latest.kind !== DISPATCH_DATE_SET) return null;
  const date = (latest.payload as { date?: unknown } | null | undefined)?.date;
  if (typeof date !== "string" || !ISO_DAY.test(date)) return null;
  if (guideCreatedAt.some((created) => created && created > latest!.occurred_at)) return null;
  return { date, note: latest.reason?.trim() || null, at: latest.occurred_at };
}

export type DispatchDateState = "programado" | "hoy" | "vencido";

/** Programado a futuro, sale hoy, o su día pasó sin guía. */
export function dispatchDateState(date: string | null | undefined, todayLima: string): DispatchDateState | null {
  if (!date) return null;
  if (date > todayLima) return "programado";
  return date === todayLima ? "hoy" : "vencido";
}

function addDays(day: string, days: number): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** El último día que se puede programar desde hoy. */
export function dispatchDateMax(todayLima: string): string {
  return addDays(todayLima, DISPATCH_DATE_MAX_DAYS);
}

/** Por qué no se puede programar esa fecha, o null si se puede. */
export function dispatchDateError(date: string, todayLima: string): string | null {
  if (!ISO_DAY.test(date) || Number.isNaN(Date.parse(`${date}T12:00:00Z`))) return "Elige una fecha válida.";
  if (date < todayLima) return "La fecha ya pasó: elige hoy o un día siguiente.";
  if (date > addDays(todayLima, DISPATCH_DATE_MAX_DAYS)) return `Programa hasta ${DISPATCH_DATE_MAX_DAYS} días adelante.`;
  return null;
}

const WEEKDAYS = ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"];

/** «lun 26/10». */
export function dispatchDateLabel(date: string): string {
  const d = new Date(`${date}T12:00:00Z`);
  return `${WEEKDAYS[d.getUTCDay()]} ${date.slice(8, 10)}/${date.slice(5, 7)}`;
}

/** El texto de la chapa del Master y de la ficha. */
export function dispatchDateBadge(date: string, todayLima: string): { text: string; tone: "info" | "warn" | "danger" } {
  const state = dispatchDateState(date, todayLima);
  if (state === "hoy") return { text: "Programado · sale hoy", tone: "warn" };
  if (state === "vencido") return { text: `Programado para el ${dispatchDateLabel(date)} y no salió`, tone: "danger" };
  return { text: `Programado · sale ${dispatchDateLabel(date)}`, tone: "info" };
}
