// Kapta pide sola la dirección o la ubicación (Confirmación por Chatby, MOM
// §6.1; owner, 08-11-2026; 0318). La parte pura: qué se le pide, con qué texto,
// si toca mandarlo y lo que queda escrito en la marca.
//
// POR QUÉ. La clienta confirmó por Chatby, pero la guía no sale porque Google
// no encuentra la dirección (`sin_ubicacion`) o porque la dirección está
// incompleta (`direccion_incompleta`). Hasta hoy una asesora abría la ficha y
// se la pedía con el botón (lib/chatby-location-ask.ts). El owner: «va a pedir
// ubicación en automático… si la dirección está incompleta, va a pedir la
// dirección completa, y con eso Google Maps se va a volver a ejecutar».
//
// LA MÁQUINA (en la pasada de siempre, lib/chatby-autoconfirm-server.ts):
//   A. `sin_ubicacion` → le pide su ubicación actual. Cuando la manda, la guía
//      va con ESA ubicación (la relectura de siempre).
//   B. `direccion_incompleta` → le pide la dirección completa (o la ubicación).
//      Si manda su ubicación, como A. Si escribe una dirección completa, se
//      guarda como la dirección corregida del pedido, Google la vuelve a
//      buscar y, si la encuentra, sale la guía; si no, le pide la ubicación
//      (A). Si lo que escribe sigue incompleto, queda para la asesora.
//   C. Como mucho UN mensaje automático de cada clase por pedido (dirección
//      una vez, ubicación una vez), solo con la ventana de 24 h de WhatsApp
//      abierta desde el ÚLTIMO mensaje de la clienta (con 1 h de margen: lo
//      que manda es Meta, no la edad del pedido), solo si nadie del equipo le
//      escribió, y nunca fuera de Por confirmar de Provincia COD.
//
// Este archivo es PURO: sin red ni base.

import type { ChatbyMessage } from "@/lib/chatby-conversation";
import { chatbyAskMessage, chatbyFirstName, chatbyLastCustomerAt, type ChatbyAskKind } from "@/lib/chatby-location-ask";
import type { ApproxMode } from "@/lib/geocode-approx";

/** Apagado / Simulación / Activo (`chatby_auto_settings.ask_mode`, 0318): las tres posiciones de siempre. */
export type ChatbyAskMode = ApproxMode;

/**
 * Qué le pide Kapta sola:
 * - `direccion`: a la dirección le falta el número de la casa
 *   (`direccionSinNumeroDeCasa`): la calle, el número y una referencia, o la
 *   ubicación. El mismo texto del botón de la ficha.
 * - `direccion_o_ubicacion`: la dirección está incompleta por otra cosa (un
 *   mercado, un cruce, un kilómetro, una seña): la ubicación primero y, si no
 *   puede, la calle y el número.
 * - `ubicacion`: Google no encuentra la dirección: solo su ubicación actual.
 *   El mismo texto del botón de la ficha.
 * - `ubicacion_tras_direccion`: escribió una dirección completa y Google
 *   tampoco la encontró: su ubicación actual, diciéndole por qué.
 */
export type ChatbyAutoAskKind = "direccion" | "direccion_o_ubicacion" | "ubicacion" | "ubicacion_tras_direccion";

/** Las dos clases del límite: un mensaje de dirección y uno de ubicación, como mucho, por pedido. */
export type ChatbyAutoAskGroup = "direccion" | "ubicacion";

export function chatbyAutoAskGroup(kind: ChatbyAutoAskKind): ChatbyAutoAskGroup {
  return kind === "direccion" || kind === "direccion_o_ubicacion" ? "direccion" : "ubicacion";
}

/** El `payload.purpose` del hecho `chatby_message`. La ubicación usa el de la ficha. */
export const CHATBY_ASK_ADDRESS_PURPOSE = "pedir_direccion";
export function chatbyAutoAskPurpose(kind: ChatbyAutoAskKind): "pedir_direccion" | "pedir_ubicacion" {
  return chatbyAutoAskGroup(kind) === "direccion" ? CHATBY_ASK_ADDRESS_PURPOSE : "pedir_ubicacion";
}

/** Qué se le pide, con el motivo con que quedó para la asesora. */
export function chatbyAutoAskKindFor(input: {
  reason: "direccion_incompleta" | "sin_ubicacion";
  /** Lo que pide la ficha para ese pedido (`chatbyAskKindFor`). */
  ask: ChatbyAskKind;
  /** La clienta ya escribió la dirección y Kapta la guardó (`evidence.corrected_at`). */
  corrected?: boolean;
}): ChatbyAutoAskKind {
  if (input.reason === "sin_ubicacion") return input.corrected ? "ubicacion_tras_direccion" : "ubicacion";
  return input.ask === "direccion" ? "direccion" : "direccion_o_ubicacion";
}

const PIN_HOW = "(📎 → Ubicación → Enviar tu ubicación actual)";

function orderLabel(orderName: string | null | undefined): string {
  const n = (orderName ?? "").trim().replace(/^#+/, "");
  return n ? `tu pedido #${n}` : "tu pedido";
}

/** El texto que sale por WhatsApp. `direccion` y `ubicacion` son los del botón de la ficha. */
export function chatbyAutoAskMessage(input: {
  kind: ChatbyAutoAskKind;
  customerName?: string | null;
  orderName?: string | null;
}): string {
  if (input.kind === "direccion" || input.kind === "ubicacion") {
    return chatbyAskMessage({ ask: input.kind, customerName: input.customerName, orderName: input.orderName });
  }
  const name = chatbyFirstName(input.customerName);
  const pedido = orderLabel(input.orderName);
  if (input.kind === "direccion_o_ubicacion") {
    return (
      `${name ? `Hola ${name} 😊` : "Hola 😊"} Para enviar ${pedido} necesitamos ubicar bien tu dirección. ` +
      `¿Nos compartes tu ubicación actual de WhatsApp? ${PIN_HOW} ` +
      "Si no puedes, escríbenos la calle y el número de tu casa, con una referencia."
    );
  }
  return (
    `${name ? `Gracias, ${name} 😊` : "Gracias 😊"} No logramos ubicar esa dirección en el mapa. ` +
    `Para enviar ${pedido}, ¿nos compartes tu ubicación actual de WhatsApp? ${PIN_HOW}`
  );
}

/** Qué dice el hecho y la ficha de lo que pidió Kapta. */
export function chatbyAutoAskLabel(kind: ChatbyAutoAskKind): string {
  return chatbyAutoAskGroup(kind) === "direccion" ? "la dirección completa" : "la ubicación";
}

/** El motivo del hecho `chatby_message` que deja el mensaje automático. */
export function chatbyAutoAskReason(kind: ChatbyAutoAskKind): string {
  return `Kapta (automático) le pidió ${chatbyAutoAskLabel(kind)} a la clienta por WhatsApp.`;
}

// ---------------------------------------------------------------------------
// ¿Toca mandarlo?
// ---------------------------------------------------------------------------

/** Lo que quedó escrito de cada pedida automática (`chatby_auto_checks.evidence.auto_asks`). */
export interface ChatbyAutoAskMark {
  kind: ChatbyAutoAskKind;
  group: ChatbyAutoAskGroup;
  at: string;
  /** `activo`: salió por WhatsApp; `simulacion`: «habría pedido…», no salió nada. */
  mode: "activo" | "simulacion";
}

const KINDS = new Set<string>(["direccion", "direccion_o_ubicacion", "ubicacion", "ubicacion_tras_direccion"]);

/** Las pedidas automáticas guardadas en la marca, sin lo que no se entiende. */
export function chatbyAutoAskMarks(evidence: Record<string, unknown> | null | undefined): ChatbyAutoAskMark[] {
  const raw = evidence?.auto_asks;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((x) => {
    const m = x as Partial<ChatbyAutoAskMark> | null;
    if (!m || typeof m.kind !== "string" || !KINDS.has(m.kind)) return [];
    if (typeof m.at !== "string" || !Number.isFinite(Date.parse(m.at))) return [];
    if (m.mode !== "activo" && m.mode !== "simulacion") return [];
    const kind = m.kind as ChatbyAutoAskKind;
    return [{ kind, group: chatbyAutoAskGroup(kind), at: m.at, mode: m.mode }];
  });
}

/** Un hecho `chatby_message` del pedido (lo que se lee para el límite). */
export interface ChatbyMessageEvent {
  actor: string | null;
  note: string | null;
  payload: Record<string, unknown> | null;
}

/** ¿El hecho es un mensaje que mandó Kapta sola? */
export function isAutoAskEvent(e: ChatbyMessageEvent): boolean {
  return e.actor == null && e.payload?.auto === true;
}

export type ChatbyAutoAskSkip =
  /** El interruptor está en Apagado. */
  | "apagado"
  /** Ya salió (o en Simulación ya se simuló) un mensaje automático de esta clase. */
  | "ya_pedida"
  /** Una persona del equipo le escribió desde la ficha: la conversación es suya. */
  | "asesora_escribio"
  /** Alguien del equipo le escribió en Chatby después de su último mensaje. */
  | "equipo_atendiendo"
  /** La ventana de 24 h de WhatsApp está cerrada: solo plantillas, desde Chatby. */
  | "ventana_cerrada"
  /** El pedido ya no está en Por confirmar de Provincia COD. */
  | "fuera"
  /** Chatby no dejó mandarlo (lo dice la pasada; la decisión nunca lo devuelve). */
  | "envio_fallo"
  /**
   * Es de una persona antes de cualquier guía: la lista de pago adelantado
   * (MOM §41), un envío programado, Shalom o un pago registrado (lo mira la
   * pasada; la decisión nunca lo devuelve).
   */
  | "para_persona";

export const CHATBY_AUTO_ASK_SKIP_LABEL: Record<ChatbyAutoAskSkip, string> = {
  apagado: "Pedir sola la dirección o la ubicación está apagado.",
  ya_pedida: "Kapta ya se lo pidió una vez: no se repite.",
  asesora_escribio: "Una persona del equipo ya le escribió desde la ficha: queda para la asesora.",
  equipo_atendiendo: "Alguien del equipo le escribió en Chatby después de su último mensaje: queda para la asesora.",
  ventana_cerrada:
    "La ventana de 24 h de WhatsApp está cerrada (el último mensaje de la clienta tiene más de 23 h): WhatsApp no deja mandarle texto libre. Queda para la asesora (plantilla desde Chatby).",
  fuera: "El pedido ya no está en Por confirmar de Provincia COD.",
  envio_fallo: "Chatby no dejó mandar el mensaje: queda para la asesora.",
  para_persona: "Es de una persona (Lista negra, envío programado, Shalom o un pago): Kapta no le escribe.",
};

/**
 * Lo que se sabe sin leer la base, con la marca: ¿ya se pidió esta clase? (en
 * Activo, solo lo que salió; en Simulación, también lo simulado), y ¿la pidió
 * una persona desde la ficha? (`asked_at` sin ninguna pedida automática que
 * saliera: solo la ficha lo escribe así).
 */
export function chatbyAutoAskMarkedSkip(
  evidence: Record<string, unknown> | null | undefined,
  kind: ChatbyAutoAskKind,
  mode: ChatbyAskMode,
): "ya_pedida" | "asesora_escribio" | null {
  const marks = chatbyAutoAskMarks(evidence);
  const group = chatbyAutoAskGroup(kind);
  if (marks.some((m) => m.group === group && (mode === "simulacion" || m.mode === "activo"))) return "ya_pedida";
  const asked = typeof evidence?.asked_at === "string" && Number.isFinite(Date.parse(evidence.asked_at));
  if (asked && !marks.some((m) => m.mode === "activo")) return "asesora_escribio";
  return null;
}

const SUBETAPAS = new Set(["sin_llamar", "por_confirmar"]);

/**
 * El límite que manda (owner, 08-11-2026): la ventana de atención de 24 h de
 * Meta. El bot solo puede mandar texto libre hasta 24 h después del ÚLTIMO
 * mensaje de la clienta, no según la edad del pedido. Kapta solo manda con
 * una hora de margen (23 h): un mensaje que sale al borde puede llegar con
 * la ventana ya cerrada y WhatsApp no lo entrega.
 */
export const CHATBY_AUTO_ASK_WINDOW_MS = 23 * 3_600_000;

/** ¿El último mensaje de la clienta tiene menos de 23 h? (sin mensajes de ella, no) */
export function chatbyAutoAskWindowOpen(messages: readonly Pick<ChatbyMessage, "kind" | "at">[], now: Date): boolean {
  const last = chatbyLastCustomerAt(messages);
  return last !== null && now.getTime() - last < CHATBY_AUTO_ASK_WINDOW_MS;
}

export type ChatbyAutoAskDecision = { send: true; simulate: boolean } | { send: false; skip: ChatbyAutoAskSkip };

/**
 * ¿Kapta le manda el mensaje? En este orden: el interruptor; el pedido (Por
 * confirmar · «Sin llamar»/«Por confirmar», Provincia COD); el límite (una vez
 * por clase: en Activo cuentan los hechos que salieron, en Simulación también
 * las simulaciones); que nadie del equipo le haya escrito (desde la ficha, o
 * en Chatby después de su último mensaje); y la ventana de 24 h de WhatsApp
 * desde el último mensaje de la clienta, con 1 h de margen
 * (`chatbyAutoAskWindowOpen`). La edad del pedido no cuenta aquí: un pedido de
 * más de 72 h cuya clienta acaba de escribir sí puede recibirlo.
 */
export function chatbyAutoAskDecision(input: {
  mode: ChatbyAskMode;
  kind: ChatbyAutoAskKind;
  master: { macro_stage?: string | null; macro_substage?: string | null; coverage?: string | null };
  messages: readonly Pick<ChatbyMessage, "kind" | "at" | "text">[];
  events: readonly ChatbyMessageEvent[];
  evidence: Record<string, unknown> | null | undefined;
  now: Date;
}): ChatbyAutoAskDecision {
  const { mode, master, now } = input;
  if (mode === "apagado") return { send: false, skip: "apagado" };
  if (master.macro_stage !== "por_confirmar" || !SUBETAPAS.has(master.macro_substage ?? "") || master.coverage !== "provincia_cod") {
    return { send: false, skip: "fuera" };
  }

  const group = chatbyAutoAskGroup(input.kind);
  const autoEvents = input.events.filter(isAutoAskEvent);
  const sentGroup = autoEvents.some((e) => KINDS.has(String(e.payload?.ask)) && chatbyAutoAskGroup(e.payload!.ask as ChatbyAutoAskKind) === group);
  const marked = chatbyAutoAskMarkedSkip(input.evidence, input.kind, mode);
  if (sentGroup || marked === "ya_pedida") return { send: false, skip: "ya_pedida" };

  if (marked === "asesora_escribio" || input.events.some((e) => e.actor != null)) return { send: false, skip: "asesora_escribio" };

  // Alguien del equipo escribió en Chatby después del último mensaje de la
  // clienta (que no sea un mensaje de Kapta): hay una persona atendiendo.
  const ours = new Set(autoEvents.map((e) => (e.note ?? "").trim()).filter(Boolean));
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

  if (!chatbyAutoAskWindowOpen(input.messages, now)) return { send: false, skip: "ventana_cerrada" };
  return { send: true, simulate: mode === "simulacion" };
}

// ---------------------------------------------------------------------------
// Lo que queda en la marca
// ---------------------------------------------------------------------------

function isoOf(value: unknown): string | null {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null;
}

/**
 * La marca después de pedirla (o de simularlo). En Activo también
 * `asked_at` (así la relectura de lo que quedó por la dirección incompleta lo
 * vuelve a leer, como cuando la pide una persona) y `held_at` (desde cuándo es
 * «nuevo» lo que escriba la clienta). Lo demás se conserva.
 */
export function chatbyAutoAskEvidence(
  evidence: Record<string, unknown> | null | undefined,
  mark: { kind: ChatbyAutoAskKind; mode: "activo" | "simulacion" },
  now: Date,
  checkedAt?: string | null,
): Record<string, unknown> {
  const prev = { ...(evidence ?? {}) };
  const at = now.toISOString();
  const marks = [...chatbyAutoAskMarks(prev), { kind: mark.kind, group: chatbyAutoAskGroup(mark.kind), at, mode: mark.mode }];
  const next: Record<string, unknown> = { ...prev, auto_asks: marks };
  delete next.auto_ask_skip;
  if (mark.mode === "activo") {
    next.held_at = isoOf(prev.held_at) ?? isoOf(checkedAt) ?? at;
    next.asked_at = at;
  }
  return next;
}

/** La marca cuando no se mandó: por qué (la ficha y el cron lo dicen). */
export function chatbyAutoAskSkipEvidence(
  evidence: Record<string, unknown> | null | undefined,
  skip: ChatbyAutoAskSkip,
  kind: ChatbyAutoAskKind,
  now: Date,
): Record<string, unknown> {
  return { ...(evidence ?? {}), auto_ask_skip: { kind, reason: skip, at: now.toISOString() } };
}

/** Lo que pasa de la marca a la marca nueva cuando el pedido vuelve a quedar para la asesora. */
const CARRY = ["auto_asks", "asked_at", "held_at", "corrected_at", "auto_ask_skip"] as const;
export function chatbyAutoAskCarry(evidence: Record<string, unknown> | null | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of CARRY) if (evidence && evidence[k] != null) out[k] = evidence[k];
  return out;
}

/** ¿La clienta ya escribió la dirección completa y Kapta la guardó como corregida? */
export function chatbyAddressCorrectedAt(evidence: Record<string, unknown> | null | undefined): string | null {
  return isoOf(evidence?.corrected_at);
}

/** La nota de la corrección de la dirección (`order_geo_overrides.note` y el hecho). */
export const CHATBY_ADDRESS_CORRECTION_NOTE = "Dirección completada por la clienta en Chatby";
