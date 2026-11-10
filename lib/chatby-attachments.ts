// Mandar un archivo a la clienta por Chatby desde la ficha (MOM §25 «Chatby»,
// owner 10-11-2026: «actívame para poder enviar desde ahí la guía en PDF al
// responder por Chatby»).
//
// Dos caminos, los dos dentro de las 24 h de WhatsApp como el texto:
//   - «Enviar ticket Shalom (PDF)»: el ticket de la guía Shalom creada por API
//     (`shipments.shalom_ose_id`), el que la clienta muestra en la agencia
//     para recoger («envíame el baucher para recogerlo»). Sale del caché de
//     tickets (lib/shalom/label-cache.ts) con una URL firmada de 7 días, como
//     el aviso de tránsito por Kapso.
//   - «Adjuntar»: una imagen (JPG o PNG) o un PDF que elige o pega la persona.
//     El navegador lo sube directo a Storage (bucket privado
//     `CHATBY_ATTACHMENT_BUCKET`, `<tienda>/<pedido>/chatby-…`) y Chatby lo
//     baja de una URL firmada de 7 días.
//
// Chatby recibe el archivo como un mensaje más de `send-content`:
// `{ type: "image" | "file", url }`. Puro.

export const CHATBY_ATTACHMENT_BUCKET = "chatby-attachments";

/** WhatsApp corta las imágenes en 5 MB; un PDF, mucho más arriba. */
export const CHATBY_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
export const CHATBY_FILE_MAX_BYTES = 16 * 1024 * 1024;

/** Cuánto vive el enlace firmado que Chatby descarga. */
export const CHATBY_ATTACHMENT_URL_SECONDS = 7 * 24 * 60 * 60;

export type ChatbyAttachmentType = "image" | "file";

const TYPES: Record<string, { ext: string; type: ChatbyAttachmentType }> = {
  "image/jpeg": { ext: "jpg", type: "image" },
  "image/jpg": { ext: "jpg", type: "image" },
  "image/png": { ext: "png", type: "image" },
  "application/pdf": { ext: "pdf", type: "file" },
};

/** Lo que WhatsApp acepta desde aquí; null si no. */
export function chatbyAttachmentKind(contentType: string): { ext: string; type: ChatbyAttachmentType } | null {
  return TYPES[contentType.trim().toLowerCase()] ?? null;
}

/** El problema con el tamaño, dicho para la persona; null si cabe. */
export function chatbyAttachmentSizeProblem(contentType: string, size: number): string | null {
  const kind = chatbyAttachmentKind(contentType);
  if (!kind) return "Solo se pueden mandar fotos (JPG o PNG) o PDF.";
  if (!(size > 0)) return "El archivo está vacío.";
  if (kind.type === "image" && size > CHATBY_IMAGE_MAX_BYTES) return "La foto pesa más de 5 MB: WhatsApp no la acepta.";
  if (kind.type === "file" && size > CHATBY_FILE_MAX_BYTES) return "El PDF pesa más de 16 MB.";
  return null;
}

export function chatbyAttachmentFolder(storeId: string, orderId: string): string {
  return `${storeId}/${orderId}`;
}

/** ¿Es esta ruta un adjunto de Chatby de ESE pedido? */
export function isChatbyAttachmentPath(path: string, storeId: string, orderId: string): boolean {
  const prefix = `${chatbyAttachmentFolder(storeId, orderId)}/chatby-`;
  return typeof path === "string" && path.startsWith(prefix) && /^[A-Za-z0-9._-]+$/.test(path.slice(prefix.length)) && !path.includes("..");
}

/** El tipo de mensaje de Chatby que corresponde a una ruta guardada. */
export function chatbyAttachmentTypeOfPath(path: string): ChatbyAttachmentType {
  return /\.pdf$/i.test(path) ? "file" : "image";
}

/** Un nombre de archivo limpio para mostrar (sin rutas ni caracteres raros). */
export function chatbyAttachmentDisplayName(name: string | null | undefined, fallback: string): string {
  const base = (name ?? "").split(/[\\/]/).pop()?.replace(/[^\p{L}\p{N} ._()-]/gu, "").trim() ?? "";
  return (base || fallback).slice(0, 80);
}

/** Lo que pide la ficha: el ticket Shalom o un adjunto ya subido. */
export type ChatbyAttachmentRequest =
  | { kind: "shalom_ticket" }
  | { kind: "upload"; path: string; filename?: string | null };

/** La nota que queda en la Actividad cuando el mensaje no llevaba texto. */
export function chatbyAttachmentNote(input: { kind: "shalom_ticket"; guideCode: string | null } | { kind: "upload"; filename: string }): string {
  return input.kind === "shalom_ticket"
    ? `Envió el ticket Shalom en PDF${input.guideCode ? ` (guía ${input.guideCode})` : ""}.`
    : `Envió un archivo: ${input.filename}.`;
}

/** La guía Shalom cuyo ticket se puede mandar: creada por API y no anulada. La más nueva. */
export function shalomTicketShipment<T extends { courier: string | null; shalom_ose_id?: number | null; delivery_status?: string | null; created_at?: string | null }>(
  guides: readonly T[],
): T | null {
  const candidates = guides.filter(
    (g) => g.courier === "shalom" && typeof g.shalom_ose_id === "number" && g.shalom_ose_id > 0 && g.delivery_status !== "anulado",
  );
  return candidates.sort((a, b) => ((a.created_at ?? "") < (b.created_at ?? "") ? 1 : -1))[0] ?? null;
}
