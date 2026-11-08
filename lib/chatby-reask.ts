// La relectura del pedido que quedó para la asesora por la dirección o la
// ubicación, después de que se le pidió la ubicación desde la ficha (MOM §6.1,
// «Confirmó por Chatby», owner 08-11-2026). Las reglas de siempre están en
// lib/chatby-autoconfirm.ts; el aviso y el mensaje, en lib/chatby-location-ask.ts.
//
// PURO: sin red ni base. Lo usan la pasada (lib/chatby-autoconfirm-server.ts) y
// la acción de la ficha (qué se le pide).

import {
  addressMatchesOrder,
  chatbyGuidePin,
  chatbyLocationWatch,
  direccionCompleta,
  direccionSinNumeroDeCasa,
  evaluateChatbyConfirmation,
  isCourtesy,
  messageAddress,
  type ChatbyHoldReason,
} from "@/lib/chatby-autoconfirm";
import type { ChatbyAskKind, ChatbyAskReason } from "@/lib/chatby-location-ask";

/**
 * Qué se le pide a la clienta (owner, 08-11-2026). Cuando Google no encuentra
 * la dirección, solo su ubicación actual. Con la dirección incompleta, la
 * calle y el número solo si lo que falta es el número de la casa
 * (`direccionSinNumeroDeCasa`); si no, también solo la ubicación. Se mira la
 * dirección que quedó incompleta: la del mensaje de confirmación o, si esa
 * está completa (o no se encuentra el mensaje), la del pedido.
 */
export function chatbyAskKindFor(input: {
  reason: ChatbyAskReason;
  messageText: string | null | undefined;
  orderAddress: string | null | undefined;
}): ChatbyAskKind {
  if (input.reason !== "direccion_incompleta") return "ubicacion";
  const fromMessage = input.messageText ? messageAddress(input.messageText) : null;
  const incomplete = [fromMessage, input.orderAddress].find((a) => a && !direccionCompleta(a)) ?? input.orderAddress;
  return direccionSinNumeroDeCasa(incomplete) ? "direccion" : "ubicacion";
}

export type ChatbyReaskVerdict =
  /**
   * La confirmación vale. `pin`: la dirección escrita estaba incompleta y la
   * guía va con la ubicación de WhatsApp que mandó después (nunca con la del
   * pedido ni con Google).
   */
  | { kind: "confirm"; messageId: string; at: string | null; amountCents: number; pin: boolean }
  /** Algo cambió (un «no lo quiero», otra dirección…): para la asesora, con ese motivo. */
  | { kind: "hold"; reason: ChatbyHoldReason }
  /** Todavía nada que alcance: se vuelve a mirar en la pasada siguiente. */
  | { kind: "wait" };

const FINAL_AGAIN = new Set<ChatbyHoldReason>(["rechazo", "anulado_en_chat"]);

/**
 * La confirmación del pedido que quedó para la asesora por la dirección o la
 * ubicación, otra vez, con lo que la clienta mandó después:
 *
 * 1. **Lo que manda es su ubicación** (owner, 08-11-2026). Si la dirección
 *    escrita estaba incompleta y lo ÚLTIMO que mandó la clienta es su ubicación
 *    de WhatsApp de esta compra (`chatbyGuidePin`), la confirmación vale con
 *    esa ubicación como coordenada, siempre que lo demás cuadre como hoy (el
 *    pedido, el monto, pagar en casa, que la dirección del mensaje sea la del
 *    pedido). La ubicación pasa después por las mismas puertas de la guía (el
 *    pin respaldado de Aliclik).
 * 2. **Una dirección escrita** es lo segundo: el último mensaje de texto de la
 *    clienta, con «Dirección:» o sin ella, tiene que ser una dirección completa
 *    (`direccionCompleta`), la del pedido también, y ser la del pedido
 *    (`addressMatchesOrder`), como hoy. Si no, se espera (puede mandar la
 *    ubicación todavía).
 * 3. Si la dirección ya estaba completa (`sin_ubicacion…`), la evaluación de
 *    la pasada de la ubicación (`chatbyLocationWatch`), igual que siempre.
 *
 * Un «no lo quiero» o una nota de anulación lo deja para la asesora.
 */
export function chatbyReaskWatch(input: Parameters<typeof evaluateChatbyConfirmation>[0]): ChatbyReaskVerdict {
  const base = evaluateChatbyConfirmation(input);
  if (!base.confirm && base.final && base.reason === "direccion_incompleta") {
    const original = base.messageId ? input.messages.find((m) => m.id === base.messageId) : undefined;
    if (!original || base.amountCents == null) return { kind: "wait" };
    const fromClient = input.messages.filter((m) => m.kind === "cliente");
    const after = fromClient.slice(fromClient.indexOf(original) + 1);
    const last = after[after.length - 1];

    // 1. Su ubicación.
    if (last?.location && chatbyGuidePin(input.messages, input.orderCreatedAt)) {
      const addr = messageAddress(original.text);
      const match = addr ? addressMatchesOrder(addr, input.order) : ({ ok: false, reason: "direccion_distinta" } as const);
      if (!match.ok) return { kind: "hold", reason: match.reason };
      return { kind: "confirm", messageId: original.id, at: original.at, amountCents: base.amountCents, pin: true };
    }

    // 2. Una dirección escrita: el último texto que no es cortesía.
    const written = [...after].reverse().find((m) => !m.button && !m.media && !m.location && m.text && !isCourtesy(m.text));
    const tail = written ? after.slice(after.indexOf(written) + 1) : [];
    const onlyCourtesyAfter = tail.every((m) => !m.button && !m.media && !m.location && isCourtesy(m.text));
    if (written && onlyCourtesyAfter) {
      const addr = messageAddress(written.text) ?? written.text.trim();
      if (direccionCompleta(addr) && direccionCompleta(input.order.address) && addressMatchesOrder(addr, input.order).ok) {
        return { kind: "confirm", messageId: original.id, at: original.at, amountCents: base.amountCents, pin: false };
      }
    }
    return { kind: "wait" };
  }

  const v = chatbyLocationWatch(input);
  if (v.kind === "confirm") return { ...v, pin: false };
  if (v.kind === "wait") return v;
  if (FINAL_AGAIN.has(v.reason)) return v;
  // Lo demás (otro monto, otra dirección…) lo decide la confirmación como
  // siempre; «escribió algo después» espera a que mande la ubicación.
  return v.reason === "mensaje_posterior" ? { kind: "wait" } : v;
}
