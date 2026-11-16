/**
 * «Tu cliente respondió» (owner, 16-11-2026; 0351, MOM «Bloques por asesora»).
 *
 * Cuando la clienta escribe por WhatsApp después de que una asesora agendó
 * «Volver a llamar», el lead vuelve a esa asesora durante
 * {@link RETURN_HOLD_MINUTES} minutos desde el mensaje (la regla vive en
 * `lib/lead-appointment-hold.ts` y en la base, 0351). Esta función elige, para
 * una asesora, los leads que debe avisarle el aviso flotante
 * (`components/callback-return-alerts.tsx`). Pura: la lectura la hace
 * `listCallbackReturns` en `app/dashboard/leads/actions.ts`.
 *
 * La dueña de la cita es la misma que usa la base: la última llamada de una
 * asesora con la misma fecha que el lead tiene agendada (`next_followup_at`).
 * Si ya lo abrió después del mensaje (su reserva de 10 minutos es posterior),
 * no hace falta avisarle.
 */

import { appointmentHoldState, RETURN_HOLD_MINUTES } from "@/lib/lead-appointment-hold";

export { RETURN_HOLD_MINUTES };

export interface CallbackReturnLeadRow {
  id: string;
  store_id: string;
  name: string | null;
  phone: string | null;
  status: string | null;
  last_inbound_at: string | null;
  next_followup_at: string | null;
  claimed_by: string | null;
  claimed_at: string | null;
}

export interface CallbackReturnCallRow {
  id: string;
  lead_id: string;
  vendedora: string | null;
  occurred_at: string;
  next_followup_at: string | null;
}

export interface CallbackReturn {
  id: string;
  storeId: string;
  name: string | null;
  phone: string | null;
  /** La pestaña de Leads donde está: los Yapes viven aparte. */
  view: "por_llamar" | "yape";
  /** El mensaje de la clienta que devolvió el lead. */
  repliedAt: string;
  /** Hasta cuándo es solo suyo (mensaje + 10 minutos). */
  reservedUntil: string;
  /** La hora agendada de «Volver a llamar». */
  followupAt: string;
  /** Con el reparto por bloques apagado no hay nada que apartar: solo se avisa. */
  reserved: boolean;
}

const t = (iso: string | null | undefined): number | null => {
  if (!iso) return null;
  const v = Date.parse(iso);
  return Number.isFinite(v) ? v : null;
};

export function callbackReturnsFor(input: {
  userId: string;
  leads: readonly CallbackReturnLeadRow[];
  calls: readonly CallbackReturnCallRow[];
  nowMs: number;
  /** Tiendas con el reparto por bloques encendido. */
  routedStores: ReadonlySet<string>;
}): CallbackReturn[] {
  const { userId, nowMs } = input;
  // La última llamada de asesora de cada lead con la misma fecha agendada.
  const sorted = [...input.calls].sort((a, b) => (t(b.occurred_at) ?? 0) - (t(a.occurred_at) ?? 0) || (a.id < b.id ? 1 : -1));
  const out: CallbackReturn[] = [];
  for (const lead of input.leads) {
    const followup = t(lead.next_followup_at);
    if (followup === null || !lead.last_inbound_at) continue;
    const booking = sorted.find((c) =>
      c.lead_id === lead.id && c.vendedora && t(c.next_followup_at) === followup && (t(c.occurred_at) ?? Infinity) <= nowMs);
    if (!booking || booking.vendedora !== userId) continue;
    const state = appointmentHoldState({ followupAt: lead.next_followup_at, bookedAt: booking.occurred_at, lastInboundAt: lead.last_inbound_at }, nowMs);
    if (!state.held || state.reason !== "respondio") continue;
    // Ya lo abrió después del mensaje: está en eso.
    const claimed = t(lead.claimed_at);
    if (lead.claimed_by === userId && claimed !== null && claimed >= (t(lead.last_inbound_at) ?? Infinity)) continue;
    out.push({
      id: lead.id,
      storeId: lead.store_id,
      name: lead.name?.trim() || null,
      phone: lead.phone,
      view: lead.status === "yape_por_verificar" ? "yape" : "por_llamar",
      repliedAt: lead.last_inbound_at,
      reservedUntil: state.releasesAt,
      followupAt: lead.next_followup_at as string,
      reserved: input.routedStores.has(lead.store_id),
    });
  }
  // El que se suelta antes, primero.
  return out.sort((a, b) => a.reservedUntil.localeCompare(b.reservedUntil));
}
