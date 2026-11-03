/** Datos del carrito original para la asesora; no se guardan en la fila del lead. */
export interface LeadCartDetail {
  createdAt: string | null;
  lines: { title: string; variant: string | null; quantity: number }[];
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function leadCartDetailOf(draft: {
  created_at?: unknown;
  line_items?: unknown;
} | null): LeadCartDetail | null {
  if (!draft) return null;
  const created = text(draft.created_at);
  const createdAt = created && Number.isFinite(Date.parse(created)) ? created : null;
  const lines: LeadCartDetail["lines"] = [];
  for (const item of Array.isArray(draft.line_items) ? draft.line_items : []) {
    if (!item || typeof item !== "object") continue;
    const title = text(item.title);
    if (!title) continue;
    const variant = text(item.variant_title);
    const quantity = Math.trunc(Number(item.quantity));
    lines.push({
      title,
      variant: variant && variant.toLowerCase() !== "default title" ? variant : null,
      quantity: Number.isFinite(quantity) && quantity > 0 ? quantity : 1,
    });
  }
  return { createdAt, lines };
}

/** Fecha absoluta del carrito, siempre en Lima aunque el navegador esté en otra zona. */
export function cartCreatedAtLabel(value: string | null | undefined): string | null {
  if (!value || !Number.isFinite(Date.parse(value))) return null;
  return new Date(value).toLocaleString("es-PE", {
    timeZone: "America/Lima", day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit", hour12: false,
  });
}
