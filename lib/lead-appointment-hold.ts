/**
 * La reserva de un lead por cita (MOM «Bloques por asesora»; decisión del
 * owner del 08-11-2026, opción c; migración 0319).
 *
 * Con el reparto por bloques activo, la asesora que agendó «volver a llamar» se
 * queda el lead: las demás lo ven como «Sin acceso». Esa reserva se suelta en
 * CUALQUIERA de estos dos casos:
 *
 *   1. `vencida`: pasaron {@link APPOINTMENT_HOLD_GRACE_HOURS} horas desde la
 *      hora de la cita, se haya llamado o no (si la asesora ya llamó después de
 *      esa hora, se suelta igual).
 *   2. `volvio_sola`: la clienta escribió por WhatsApp DESPUÉS de que se agendó
 *      la cita (`leads.last_inbound_at` posterior al `occurred_at` de la llamada
 *      que la agendó). Una fecha futura no cuenta.
 *
 * Suelta, el lead sigue el reparto normal. La cita no se borra: solo deja de
 * reservar. Esta función es el espejo puro de `appointment_released` en
 * `lead_routing_scope` (db/migrations/0319_lead_appointment_release.sql), que
 * es quien decide de verdad en el servidor.
 *
 * No cuentan como «volvió sola»: lo que manda una asesora (toca
 * `last_interaction_at`), `handoff_at` (también lo escribe el agente de voz) ni
 * las llamadas entrantes, que hoy ninguna tabla ata a un lead.
 */

/** Horas después de la hora de la cita en las que la reserva se suelta sola. */
export const APPOINTMENT_HOLD_GRACE_HOURS = 2;

export type AppointmentHoldRelease = "vencida" | "volvio_sola";

export interface AppointmentHoldInput {
  /** Hora de la cita: `leads.next_followup_at`. */
  followupAt: string | null;
  /** Cuándo se agendó: `occurred_at` de la llamada de la asesora que la pactó. */
  bookedAt: string | null;
  /** Último mensaje entrante de la clienta: `leads.last_inbound_at`. */
  lastInboundAt: string | null;
}

export type AppointmentHoldState =
  | { held: false; reason: "sin_cita" }
  | { held: false; reason: AppointmentHoldRelease }
  | { held: true; releasesAt: string };

const ms = (iso: string | null): number | null => {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
};

/**
 * ¿La cita sigue reservando el lead a su asesora en `nowMs`? Sin cita (sin hora
 * o sin la llamada que la agendó) no hay reserva. El orden de los motivos es
 * el del MOM: primero el vencimiento, después la clienta que volvió sola.
 */
export function appointmentHoldState(input: AppointmentHoldInput, nowMs: number): AppointmentHoldState {
  const followup = ms(input.followupAt);
  const booked = ms(input.bookedAt);
  if (followup === null || booked === null) return { held: false, reason: "sin_cita" };
  const releasesAtMs = followup + APPOINTMENT_HOLD_GRACE_HOURS * 3_600_000;
  if (releasesAtMs <= nowMs) return { held: false, reason: "vencida" };
  const inbound = ms(input.lastInboundAt);
  if (inbound !== null && inbound <= nowMs && inbound > booked) return { held: false, reason: "volvio_sola" };
  return { held: true, releasesAt: new Date(releasesAtMs).toISOString() };
}

/** Atajo: `true` si la cita sigue reservando el lead. */
export function appointmentHolds(input: AppointmentHoldInput, nowMs: number): boolean {
  return appointmentHoldState(input, nowMs).held;
}
