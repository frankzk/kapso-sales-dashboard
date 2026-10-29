import { Badge } from "@/components/ops-ui";
import { callAttemptLabel, isInCallQueue, type CallQueueLead } from "@/lib/lead-call-queue";

export function LeadAttemptBadge({ lead }: { lead: CallQueueLead }) {
  if (!isInCallQueue(lead)) return null;
  return (
    <Badge tone={(lead.call_attempt_count ?? 0) > 0 ? "warn" : "neutral"}
      title="Próximo intento de llamada de una asesora. Los intentos registrados y sus resultados se conservan en el historial.">
      {callAttemptLabel(lead)}
    </Badge>
  );
}
