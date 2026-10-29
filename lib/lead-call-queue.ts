// Operational queue membership is separate from the last call result.
// A retry must never erase «No responde» or its history to look like a new lead.
export const CALL_RETRY_STATUSES = [
  "nuevo", "no_responde", "buzon", "cuelga", "casi_cierra", "volver_a_llamar",
  "contactado_dejo_wsp", "otros_productos",
] as const;

export interface CallQueueLead {
  status: string;
  category?: string;
  call_queue_ready?: boolean | null;
  call_attempt_count?: number | null;
  contact_opt_out_at?: string | null;
  has_order?: boolean | null;
  order_id?: string | null;
  next_followup_at?: string | null;
}

export function isInCallQueue(lead: CallQueueLead): boolean {
  if (lead.contact_opt_out_at) return false;
  if (lead.category && lead.category !== "open" && lead.category !== "hot") return false;
  return (lead.status === "nuevo" && !lead.next_followup_at) || (
    lead.call_queue_ready === true &&
    !lead.has_order && !lead.order_id &&
    (CALL_RETRY_STATUSES as readonly string[]).includes(lead.status)
  );
}

// Same predicate as the SQL rollups; category is scoped by each read as before.
export const CALL_QUEUE_FILTER = `and(status.eq.nuevo,next_followup_at.is.null),and(call_queue_ready.eq.true,has_order.eq.false,order_id.is.null,status.in.(${CALL_RETRY_STATUSES.join(",")}))`;

export function callAttemptLabel(lead: Pick<CallQueueLead, "call_attempt_count">): string {
  const count = Math.max(0, Math.trunc(lead.call_attempt_count ?? 0));
  return ["Primer intento", "Segundo intento", "Tercer intento"][count] ?? `${count + 1}.º intento`;
}

/** Agreed appointments come first; the measured intent ranking stays intact
 * within the rest of the queue. Does not mutate the input or fake its score. */
export function prioritizeDueAppointments<T extends { call_queue_ready?: boolean | null; next_followup_at?: string | null }>(
  leads: readonly T[], nowMs = Date.now(),
): T[] {
  const dueAt = (lead: T) => {
    const at = lead.next_followup_at ? Date.parse(lead.next_followup_at) : NaN;
    return lead.call_queue_ready && at <= nowMs ? at : Infinity;
  };
  return [...leads].sort((a, b) => {
    const left = dueAt(a), right = dueAt(b);
    return left === right ? 0 : left < right ? -1 : 1;
  });
}
