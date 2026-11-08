// La pestaña «Kapso» de la ficha del pedido (MOM §25, 08-11-2026): la
// conversación de WhatsApp de la clienta con el bot de Kapso. El owner vio que
// #KP204280 seguía «Pendiente» en Kapta aunque la clienta lo había confirmado
// con el bot de Kapso («Confirmar pedido» → «Tu pedido quedó registrado»), y el
// equipo solo veía Chatby en la ficha. Esta pestaña muestra esa conversación,
// solo para leer, para que el equipo termine de validar.
//
// PURO: cómo se ven los mensajes de Kapso con la misma anatomía que Chatby
// (la clienta a la izquierda, la tienda a la derecha, por día de Lima) y la
// dirección de la conversación en Kapso.

import type { ConversationMessage, MediaKind } from "@/lib/kapso";
import type { ChatbyMediaKind, ChatbyMessage } from "@/lib/chatby-conversation";

/** Cuántos mensajes se muestran, los más recientes. */
export const KAPSO_THREAD_LIMIT = 100;

export type OrderKapsoConversation =
  | {
      status: "ok";
      conversationId: string;
      /** Abrir la conversación en Kapso, si la tienda tiene su proyecto. */
      inboxUrl: string | null;
      messages: ChatbyMessage[];
      /** De dónde salió: la del pedido, la del lead o la última de ese celular. */
      source: "pedido" | "lead" | "celular";
    }
  /** La tienda no tiene Kapso configurado. */
  | { status: "sin_kapso" }
  /** El pedido no trae un celular y no tiene conversación guardada. */
  | { status: "sin_celular" }
  /** Kapso no tiene conversación con ese celular. */
  | { status: "sin_conversacion" }
  | { status: "error"; message: string };

const MEDIA: Record<MediaKind, ChatbyMediaKind> = {
  image: "imagen",
  sticker: "imagen",
  audio: "audio",
  video: "video",
  document: "archivo",
};

/**
 * Los mensajes de Kapso con la forma del hilo de Chatby: la clienta («cliente»)
 * o la tienda («otro»: el bot o una persona, Kapso no los distingue), del más
 * antiguo al más nuevo, los últimos `limit`. Sin enlaces a los archivos: se ven
 * en Kapso. Un envío que WhatsApp no entregó sale en rojo. PURA.
 */
export function kapsoThreadMessages(messages: readonly ConversationMessage[], limit = KAPSO_THREAD_LIMIT): ChatbyMessage[] {
  return [...messages]
    .sort((a, b) => a.t - b.t)
    .slice(-limit)
    .map((m, i) => ({
      id: m.id ?? `kapso-${m.t}-${i}`,
      kind: m.dir === "inbound" ? "cliente" : "otro",
      at: Number.isFinite(m.t) && m.t > 0 ? new Date(m.t).toISOString() : null,
      text: m.text ?? "",
      template: m.templateName ?? null,
      button: false,
      media: m.mediaKind ? MEDIA[m.mediaKind] : null,
      mediaUrl: null,
      error: m.dir === "outbound" && m.status === "failed",
      agent: null,
      location: null,
    }));
}

/** La conversación en la bandeja de Kapso. PURA. */
export function kapsoInboxUrl(projectId: string | null | undefined, conversationId: string): string | null {
  if (!projectId || !/^[0-9a-f-]{36}$/i.test(projectId)) return null;
  return `https://app.kapso.ai/projects/${projectId}/inbox?conversation_id=${encodeURIComponent(conversationId)}`;
}
