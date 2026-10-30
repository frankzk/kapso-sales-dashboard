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

// ---------------------------------------------------------------------------
// Programar sin ubicación (owner, 30-10-2026; MOM §6.2)
//
// #KP142558 (Kenku) llegó sin dirección: «Por revisar», sin región ni
// distrito. El 22-10 se confirmó y se programó para el 27-10 desde la
// confirmación; sin destino no había courier ni guía posible, y la fecha se
// venció sin que nadie se enterara. Confirmar sigue permitido (la clienta
// puede dar la dirección después); lo que no se puede es PROGRAMAR la salida
// de un pedido que no tiene a dónde ir.
// ---------------------------------------------------------------------------

/** Lo que la acción del servidor responde al intentar programar sin ubicación. */
export const DISPATCH_NEEDS_LOCATION_ERROR = "Falta la ubicación: corrígela antes de programar el envío.";

/** La chapa de la fila y la píldora del Master. */
export const SCHEDULED_NO_LOCATION_LABEL = "Programado sin ubicación";

/** Lo que la regla mira del pedido (una fila de `order_master`). */
export interface DispatchLocationRow {
  coverage?: string | null;
  region?: string | null;
  district?: string | null;
  address?: string | null;
}

const blank = (v: string | null | undefined): boolean => !(v ?? "").trim();

/**
 * ¿Le falta la ubicación para programar su envío? La misma regla que pide
 * «Último destino conocido» (§37.8, `needsDestinationSuggestion`): cobertura
 * «Por revisar» (o sin calcular) y sin región, distrito o dirección. Un pedido
 * con su ubicación completa se programa como siempre. Pura.
 */
export function dispatchLocationMissing(row: DispatchLocationRow): boolean {
  if ((row.coverage ?? "por_revisar") !== "por_revisar") return false;
  return blank(row.region) || blank(row.district) || blank(row.address);
}

/**
 * La alerta del Master: tiene envío programado (hoy, vencido o a futuro) y le
 * sigue faltando la ubicación. `dispatch_scheduled_on` solo se llena en
 * Preparación · Por generar rótulo, así que además no tiene salida. Pura.
 */
export function scheduledWithoutLocation(
  row: DispatchLocationRow & { dispatch_scheduled_on?: string | null },
): boolean {
  return Boolean(row.dispatch_scheduled_on) && dispatchLocationMissing(row);
}

/**
 * Marca las filas de la página con la alerta, desde los ids que leyó el
 * servidor. Sin lectura (`null`) las deja como estaban: no afirma nada. Pura.
 */
export function withScheduledNoLocation<T extends { order_id: string }>(
  rows: T[],
  ids: ReadonlySet<string> | null,
): (T & { scheduled_no_location?: boolean })[] {
  if (!ids) return rows;
  return rows.map((r) => ({ ...r, scheduled_no_location: ids.has(r.order_id) }));
}
