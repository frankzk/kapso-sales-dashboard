// La línea del historial del pedido que deja un aviso de GF Courier con motivo (owner, 15-11-2026: «la tienda recibe
// todas las actualizaciones de sus guías»). Puro: la ruta del webhook la escribe como `courier_report`, igual que el
// resultado de Swayp, para que se lea «Resultado informado por el courier» sin mover el estado del pedido.
//   - order.delivery_date_changed con motivo: «No respondió antes de salir (1 de 2)» → nueva fecha de salida.
//   - order.status_changed con motivo: el de la anulación («No respondió 3 veces antes de salir: guía anulada»).
// Sin motivo no hay línea: el cambio de estado ya deja la suya (`courier_status`).

export interface GfWebhookLike {
  type: string;
  data?: Record<string, unknown> | null;
}

const ddmm = (iso: unknown): string | null =>
  typeof iso === "string" && /^\d{4}-\d{2}-\d{2}/.test(iso) ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}` : null;

export function gfWebhookNote(envelope: GfWebhookLike): string | null {
  const data = envelope.data ?? {};
  // Etapa en GF (owner, 17-11-2026): al asignarse a un motorizado queda la línea «asignado a Alexis».
  const stage = data.stage && typeof data.stage === "object" ? data.stage as Record<string, unknown> : null;
  if (envelope.type === "order.status_changed" && stage?.code === "AWAITING_OFFICE_CHECK" && typeof stage.rider_name === "string") {
    const day = ddmm(stage.route_date);
    return `GF Courier: asignado a ${stage.rider_name}${day ? ` para la ruta del ${day}` : ""}.`;
  }
  const reason = typeof data.reason === "string" ? data.reason.trim() : "";
  if (!reason) return null;
  if (envelope.type === "order.delivery_date_changed") {
    const date = ddmm(data.new_date);
    if (data.changed_by) return `GF Courier: fecha de entrega cambiada${date ? ` al ${date}` : ""} (${reason}), con la misma guía.`;
    return `GF Courier: ${reason}.${date ? ` Vuelve a salir el ${date}, con la misma guía.` : ""}`;
  }
  if (envelope.type === "order.status_changed") return `GF Courier: ${reason}.`;
  return null;
}
