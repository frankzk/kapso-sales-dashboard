// Kapta pide la ubicación por WhatsApp para un reintento Aliclik de Lima que no
// tiene ninguna (MOM §9.5; owner, 08-11-2026; 0323). La parte pura: el texto,
// si toca mandarlo y por qué no.
//
// POR QUÉ. Aliclik exige la coordenada. Un reintento de Lima sin pin, sin la
// ubicación que la clienta ya mandó por WhatsApp (`chatbyRetryPin`) y sin el
// edificio en Google queda «Sin ubicación» hasta que una persona la consigue.
// Google da el edificio en ~1 de cada 6 pedidos de Lima. El owner eligió
// «pedirla si la ventana está abierta»: si la clienta escribió en las últimas
// 23 h, Kapta le manda UN mensaje de texto libre pidiéndole su ubicación. Con
// la ventana cerrada WhatsApp solo deja plantillas, y Kapta no manda plantillas.
//
// LA REGLA (en la pasada de los reintentos, lib/lima-retry-auto-server.ts):
//   * Solo cuando la pasada llega a «Sin ubicación» (ni pin, ni WhatsApp, ni
//     Google), con el caso sin tomar en Repro Lima y sin una creación de Aliclik
//     sin guardar. «Aprobar» de Repro Lima no escribe: lo hace una persona.
//   * Una vez por episodio: desde el último intento que falló. Un fallo nuevo
//     abre otro episodio y se le puede volver a pedir.
//   * No si alguien del equipo le escribió desde la ficha en este episodio, ni
//     si alguien del equipo le escribió en Chatby después de su último mensaje.
//   * Solo con la ventana de 24 h abierta desde el ÚLTIMO mensaje de la clienta,
//     con 1 h de margen (`chatbyAutoAskWindowOpen`, la misma de §6.1).
//   * Apagado / Simulación / Activo (`lima_retry_auto_settings.chatby_ask_mode`).
//     En Simulación dice «habría pedido…» y no manda nada.
//
// Cuando la manda, la pasada siguiente la encuentra con `chatbyRetryPin` y
// cotiza con ella. Este archivo es PURO: sin red ni base.

import type { ChatbyMessage } from "@/lib/chatby-conversation";
import { chatbyAutoAskWindowOpen } from "@/lib/chatby-auto-ask";
import { chatbyFirstName } from "@/lib/chatby-location-ask";
import { APPROX_MODE_LABEL, approxModeFrom, isApproxMode, type ApproxMode } from "@/lib/geocode-approx";

/** Apagado / Simulación / Activo (`lima_retry_auto_settings.chatby_ask_mode`, 0323). */
export type RetryAskMode = ApproxMode;
export const RETRY_ASK_MODE_LABEL = APPROX_MODE_LABEL;
export const isRetryAskMode = isApproxMode;
/** Lo que se lee de la fila: sin la columna (antes de la 0323) o con un valor raro, Apagado. */
export function retryAskModeFrom(value: unknown): RetryAskMode {
  return approxModeFrom(value);
}

/** El `payload.purpose` del hecho `chatby_message` que deja el mensaje. */
export const RETRY_ASK_PURPOSE = "reintento_lima_ubicacion";

/** El motivo del hecho `chatby_message`. */
export const RETRY_ASK_REASON = "Kapta (automático) le pidió su ubicación a la clienta por WhatsApp para volver a enviar el pedido (reintento de Lima).";

const PIN_HOW = "(📎 → Ubicación → Enviar tu ubicación actual)";

/** El texto que sale por WhatsApp. */
export function retryAskMessage(input: { customerName?: string | null; orderName?: string | null }): string {
  const name = chatbyFirstName(input.customerName);
  const n = (input.orderName ?? "").trim().replace(/^#+/, "");
  const pedido = n ? `tu pedido #${n}` : "tu pedido";
  return `${name ? `Hola ${name} 😊` : "Hola 😊"} Para volver a enviarte ${pedido}, ¿nos compartes tu ubicación actual de WhatsApp? ${PIN_HOW}`;
}

export type RetryAskSkip =
  /** El interruptor está en Apagado. */
  | "apagado"
  /** Ya se le pidió en este episodio. */
  | "ya_pedida"
  /** Alguien del equipo le escribió desde la ficha en este episodio. */
  | "asesora_escribio"
  /** Alguien del equipo le escribió en Chatby después de su último mensaje. */
  | "equipo_atendiendo"
  /** La ventana de 24 h de WhatsApp está cerrada. */
  | "ventana_cerrada"
  /** Chatby no tiene su conversación (o sin celular, o no respondió). */
  | "sin_conversacion";

export const RETRY_ASK_SKIP_LABEL: Record<RetryAskSkip, string> = {
  apagado: "pedir la ubicación por WhatsApp está apagado",
  ya_pedida: "ya se le pidió en este reintento",
  asesora_escribio: "alguien del equipo ya le escribió desde la ficha",
  equipo_atendiendo: "alguien del equipo le escribió en Chatby después de su último mensaje",
  ventana_cerrada: "la ventana de 24 h de WhatsApp está cerrada (su último mensaje tiene más de 23 h)",
  sin_conversacion: "Chatby no tiene su conversación",
};

/** Un hecho `chatby_message` del pedido. */
export interface RetryAskEvent {
  actor: string | null;
  note: string | null;
  payload: Record<string, unknown> | null;
  occurred_at: string | null;
}

/** ¿El hecho es un mensaje que mandó Kapta sola para un reintento de Lima? */
export function isRetryAskEvent(e: RetryAskEvent): boolean {
  return e.actor == null && e.payload?.auto === true && e.payload?.purpose === RETRY_ASK_PURPOSE;
}

export type RetryAskDecision = { send: true; simulate: boolean } | { send: false; skip: RetryAskSkip };

/**
 * ¿Kapta le pide la ubicación? En este orden: el interruptor; una vez por
 * episodio (desde `episodeStart`, el último intento que falló); que nadie del
 * equipo le haya escrito (desde la ficha en este episodio, o en Chatby después
 * de su último mensaje); y la ventana de 24 h desde el último mensaje de la
 * clienta, con 1 h de margen. Sin fecha de episodio, cuenta todo lo que hay.
 */
export function retryAskDecision(input: {
  mode: RetryAskMode;
  episodeStart: string | null | undefined;
  messages: readonly Pick<ChatbyMessage, "kind" | "at" | "text">[];
  events: readonly RetryAskEvent[];
  now: Date;
}): RetryAskDecision {
  if (input.mode === "apagado") return { send: false, skip: "apagado" };
  const since = Date.parse(input.episodeStart ?? "");
  const inEpisode = input.events.filter((e) => {
    if (!Number.isFinite(since)) return true;
    const at = Date.parse(e.occurred_at ?? "");
    // Sin fecha no se sabe de cuándo es: cuenta (ante la duda, no se escribe).
    return !Number.isFinite(at) || at >= since;
  });
  if (inEpisode.some(isRetryAskEvent)) return { send: false, skip: "ya_pedida" };
  if (inEpisode.some((e) => e.actor != null)) return { send: false, skip: "asesora_escribio" };

  // Un mensaje del equipo en Chatby después del último de la clienta, que no
  // sea uno que mandó Kapta sola: hay una persona atendiendo.
  const ours = new Set(input.events.filter((e) => e.actor == null && e.payload?.auto === true).map((e) => (e.note ?? "").trim()).filter(Boolean));
  let lastCustomer = -Infinity;
  for (const m of input.messages) {
    const at = Date.parse(m.at ?? "");
    if (m.kind === "cliente" && Number.isFinite(at) && at > lastCustomer) lastCustomer = at;
  }
  const attending = input.messages.some((m) => {
    if (m.kind !== "equipo") return false;
    const at = Date.parse(m.at ?? "");
    return Number.isFinite(at) && at > lastCustomer && !ours.has(m.text.trim());
  });
  if (attending) return { send: false, skip: "equipo_atendiendo" };

  if (!chatbyAutoAskWindowOpen(input.messages, input.now)) return { send: false, skip: "ventana_cerrada" };
  return { send: true, simulate: input.mode === "simulacion" };
}

/** Lo que dice el log de la pasada. */
export const RETRY_ASK_DETAIL = {
  sent: "Kapta le pidió su ubicación por WhatsApp.",
  simulated: "Habría pedido su ubicación por WhatsApp.",
  skipped: (why: string) => `No se le pidió la ubicación por WhatsApp: ${why}.`,
} as const;
