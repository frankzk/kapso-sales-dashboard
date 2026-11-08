// Pedir la ubicación desde la pestaña «Chatby» de la ficha y releer el chat
// cuando la clienta la manda (MOM §6.1, «Confirmó por Chatby», owner
// 08-11-2026).
//
// POR QUÉ. La confirmación por Chatby deja el pedido para la asesora cuando la
// clienta confirmó pero la dirección está incompleta (`direccion_incompleta`) o
// Google no la encuentra y no mandó su ubicación (`sin_ubicacion`,
// `sin_ubicacion_cerrado`). La asesora salía de Kapta para pedírsela, y el
// pedido con `direccion_incompleta` no se volvía a leer aunque la clienta la
// mandara.
//
// QUÉ HACE. La ficha dice por qué se paró la guía y deja pedir la ubicación con
// un mensaje ya escrito, editable, por el mismo envío que «Responder por
// WhatsApp» (las 24 h de WhatsApp, la pausa del bot). Al mandarlo, la marca del
// pedido (`chatby_auto_checks.evidence.asked_at`) dice que se le pidió, y la
// pasada que mira el chat de los que esperan la ubicación lo vuelve a leer —
// solo si la clienta escribió algo después de quedar para la asesora—.
//
// Este archivo es PURO y sin dependencias de servidor: lo usan la ficha (en el
// navegador), las acciones del servidor y la pasada.

/** Los motivos de la confirmación por Chatby por los que se le pide la ubicación. */
export const CHATBY_ASK_REASONS = ["direccion_incompleta", "sin_ubicacion", "sin_ubicacion_cerrado"] as const;
export type ChatbyAskReason = (typeof CHATBY_ASK_REASONS)[number];

export function isChatbyAskReason(reason: string | null | undefined): reason is ChatbyAskReason {
  return (CHATBY_ASK_REASONS as readonly string[]).includes(reason ?? "");
}

/**
 * Qué se le pide (owner, 08-11-2026):
 * - `ubicacion`: SOLO su ubicación actual de WhatsApp. Cuando Google no
 *   encuentra la dirección, y cuando la dirección está incompleta por algo que
 *   no es el número (un mercado, un cruce, una seña, un kilómetro).
 * - `direccion`: la calle, el número y una referencia (o, si prefiere, la
 *   ubicación), solo cuando a la dirección le falta el número de la casa.
 */
export type ChatbyAskKind = "ubicacion" | "direccion";

/** El propósito que lleva el hecho `chatby_message` del mensaje que la pide. */
export const CHATBY_ASK_PURPOSE = "pedir_ubicacion";

/** Las subetapas donde la confirmación por Chatby puede actuar (las de `chatbyOrderSkip`). */
const SUBETAPAS = new Set(["sin_llamar", "por_confirmar"]);

/**
 * ¿La ficha muestra el aviso? Solo si la última marca de la pasada es
 * `para_asesora` por uno de los tres motivos y el pedido sigue en Por
 * confirmar («Sin llamar» o «Por confirmar») y es de Provincia COD.
 */
export function chatbyAskBannerReason(input: {
  check: { outcome?: string | null; reason?: string | null } | null | undefined;
  master: { macro_stage?: string | null; macro_substage?: string | null; coverage?: string | null };
}): ChatbyAskReason | null {
  const { check, master } = input;
  if (!check || check.outcome !== "para_asesora" || !isChatbyAskReason(check.reason)) return null;
  if (master.macro_stage !== "por_confirmar" || !SUBETAPAS.has(master.macro_substage ?? "")) return null;
  if (master.coverage !== "provincia_cod") return null;
  return check.reason;
}

/** Lo que la ficha necesita para el aviso (lo arma el servidor). */
export interface ChatbyLocationHold {
  reason: ChatbyAskReason;
  ask: ChatbyAskKind;
  /** Cuándo quedó para la asesora (ISO), si se sabe. */
  heldAt: string | null;
  /** Cuándo se le pidió desde Kapta (ISO), o null. */
  askedAt: string | null;
  /** ¿El pedido sigue dentro de la ventana de la pasada (72 h desde que se creó)? */
  inWindow: boolean;
  /** ¿La pasada vuelve a leer este chat? (dentro de la ventana y con el motivo vigilado). */
  watching: boolean;
  customerName: string | null;
  orderName: string | null;
}

/** El título del aviso: por qué se paró la guía automática. */
export function chatbyAskTitle(reason: ChatbyAskReason): string {
  return reason === "direccion_incompleta"
    ? "La clienta confirmó, pero la dirección está incompleta"
    : "La clienta confirmó, pero Google no encuentra la dirección";
}

/** Por qué se paró, en una frase, debajo del título. */
export function chatbyAskExplanation(hold: Pick<ChatbyLocationHold, "reason" | "ask">): string {
  if (hold.reason === "direccion_incompleta") {
    return hold.ask === "direccion"
      ? "A la dirección le falta el número de la casa, así que Kapta no creó la guía ni confirmó el pedido."
      : "La dirección no dice dónde está la puerta (es un mercado, un cruce, una seña o un kilómetro), así que Kapta no creó la guía ni confirmó el pedido.";
  }
  return "Google no da el edificio de esa dirección y la clienta no mandó su ubicación de WhatsApp en esta compra. Aliclik la exige para crear la guía.";
}

/**
 * Qué pasa después, según la marca: si la pasada vuelve a leer el chat, si
 * hace falta pedírsela desde aquí para que lo haga, o si ya pasó la ventana.
 * `askedWhen` es la hora de la pedida ya escrita («Hoy 10:05»).
 */
export function chatbyAskStatus(
  hold: Pick<ChatbyLocationHold, "reason" | "askedAt" | "inWindow" | "watching">,
  askedWhen: string | null,
): string {
  const after =
    hold.reason === "direccion_incompleta"
      ? "si manda su ubicación, Kapta crea la guía con ella y confirma sola (una dirección escrita pasa por las reglas de siempre)."
      : "si manda su ubicación, Kapta crea la guía con ella y confirma sola.";
  if (!hold.inWindow) {
    return "Pasaron las 72 h del pedido: Kapta ya no vuelve a leer el chat sola. Cuando llegue la ubicación, crea la guía desde el panel de Aliclik y registra la confirmación en la mesa.";
  }
  if (hold.askedAt) {
    return `Se la pediste${askedWhen ? `: ${askedWhen}` : ""}. Cuando la clienta responda, Kapta vuelve a leer el chat (cada 30 minutos, dentro de las 72 h del pedido): ${after}`;
  }
  if (hold.watching) return `Kapta vuelve a leer el chat cada 30 minutos dentro de las 72 h del pedido: ${after}`;
  return `Pídesela desde aquí: con eso, cuando la clienta responda, Kapta vuelve a leer el chat y, ${after}`;
}

/** El primer nombre, con mayúscula («MARIA ELENA quispe» → «Maria»). Sin nombre, null. */
export function chatbyFirstName(name: string | null | undefined): string | null {
  const first = (name ?? "").trim().split(/\s+/)[0] ?? "";
  if (!/^\p{L}[\p{L}'-]*$/u.test(first) || first.length < 2) return null;
  return first.charAt(0).toLocaleUpperCase("es-PE") + first.slice(1).toLocaleLowerCase("es-PE");
}

/** «#AUR900226», con un solo «#». */
function orderLabel(orderName: string | null | undefined): string {
  const n = (orderName ?? "").trim().replace(/^#+/, "");
  return n ? `#${n}` : "";
}

/**
 * El mensaje ya escrito (la asesora lo puede editar antes de mandarlo). Con
 * `ubicacion` pide SOLO la ubicación actual de WhatsApp; con `direccion`, la
 * calle, el número y una referencia, con la ubicación como alternativa.
 */
export function chatbyAskMessage(input: {
  ask: ChatbyAskKind;
  customerName?: string | null;
  orderName?: string | null;
}): string {
  const name = chatbyFirstName(input.customerName);
  const hola = name ? `Hola ${name} 😊` : "Hola 😊";
  const order = orderLabel(input.orderName);
  const pedido = order ? `tu pedido ${order}` : "tu pedido";
  if (input.ask === "direccion") {
    return (
      `${hola} Para enviar ${pedido} nos falta el número de tu casa. ` +
      "¿Nos escribes la calle, el número y una referencia? " +
      "Si prefieres, compártenos tu ubicación actual de WhatsApp (📎 → Ubicación → Enviar tu ubicación actual)."
    );
  }
  return `${hola} Para enviar ${pedido}, ¿nos compartes tu ubicación actual de WhatsApp? (📎 → Ubicación → Enviar tu ubicación actual)`;
}

// ---------------------------------------------------------------------------
// Releer el chat cuando la clienta responde
// ---------------------------------------------------------------------------

/** La parte de la marca (`chatby_auto_checks`) que decide si se relee. */
export interface ChatbyHeldCheck {
  outcome: string;
  reason: string | null;
  checked_at: string;
  evidence?: Record<string, unknown> | null;
}

function isoOf(value: unknown): string | null {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null;
}

/** Cuándo se le pidió la ubicación desde Kapta, o null. */
export function chatbyAskedAt(check: Pick<ChatbyHeldCheck, "evidence"> | null | undefined): string | null {
  return isoOf(check?.evidence?.asked_at);
}

/** Cuándo quedó para la asesora: `evidence.held_at` (se guarda al pedirla) o, si no, la hora de la pedida. */
export function chatbyHeldAt(check: Pick<ChatbyHeldCheck, "evidence"> | null | undefined): string | null {
  return isoOf(check?.evidence?.held_at) ?? chatbyAskedAt(check);
}

/**
 * La marca al pedir la ubicación: `asked_at` ahora y `held_at` la hora en que
 * quedó para la asesora (la que ya tenía o, la primera vez, `checked_at`: una
 * marca `para_asesora` no se toca hasta que se pide). Lo demás de la evidencia
 * (el monto, la política) se conserva.
 */
export function chatbyAskEvidence(check: ChatbyHeldCheck, now: Date): Record<string, unknown> {
  const evidence = { ...(check.evidence ?? {}) };
  return { ...evidence, held_at: isoOf(evidence.held_at) ?? check.checked_at, asked_at: now.toISOString() };
}

/**
 * ¿Toca volver a leer este pedido que quedó para la asesora? Es lo que
 * `chatbyCheckDue` decide para los pendientes, para estos dos motivos que eran
 * finales: `direccion_incompleta` y `sin_ubicacion_cerrado`, solo después de
 * que una persona le pidió la ubicación desde Kapta, cada `recheck_minutes`.
 * (`sin_ubicacion` ya se relee siempre: lo mira la pasada de la ubicación desde
 * el 02-11-2026.) Lo demás de `para_asesora` sigue siendo final.
 */
export function chatbyHeldWatchDue(
  check: ChatbyHeldCheck | null | undefined,
  now: Date,
  s: { recheck_minutes: number },
): boolean {
  if (!check || check.outcome !== "para_asesora") return false;
  if (check.reason !== "direccion_incompleta" && check.reason !== "sin_ubicacion_cerrado") return false;
  if (!chatbyAskedAt(check)) return false;
  const at = Date.parse(check.checked_at);
  return !Number.isFinite(at) || now.getTime() - at >= s.recheck_minutes * 60_000;
}

/**
 * ¿La clienta escribió algo (texto, botón, archivo o su ubicación) después de
 * quedar para la asesora? Sin eso no hay nada nuevo que evaluar. Sin hora de
 * referencia, no: no se sabe qué es nuevo.
 */
export function chatbyNewCustomerMessage(
  messages: readonly { kind: string; at: string | null }[],
  sinceIso: string | null | undefined,
): boolean {
  const since = Date.parse(sinceIso ?? "");
  if (!Number.isFinite(since)) return false;
  return messages.some((m) => {
    if (m.kind !== "cliente" || !m.at) return false;
    const at = Date.parse(m.at);
    return Number.isFinite(at) && at > since;
  });
}

/** La ventana de la confirmación por Chatby (`chatby_auto_settings.window_hours`, nace en 72). */
export const CHATBY_ASK_WINDOW_HOURS = 72;

/**
 * ¿La pasada vuelve a leer este chat? Dentro de la ventana del pedido: el de
 * `sin_ubicacion` siempre (lo mira la pasada de la ubicación); el de
 * `direccion_incompleta` o `sin_ubicacion_cerrado`, solo si ya se le pidió.
 */
export function chatbyAskWatching(input: {
  reason: ChatbyAskReason;
  askedAt: string | null;
  orderCreatedAt: string | null | undefined;
  now: Date;
  windowHours?: number;
}): boolean {
  if (!chatbyAskInWindow(input.orderCreatedAt, input.now, input.windowHours)) return false;
  return input.reason === "sin_ubicacion" || input.askedAt !== null;
}

/** ¿El pedido sigue en la ventana de la pasada? */
export function chatbyAskInWindow(orderCreatedAt: string | null | undefined, now: Date, windowHours = CHATBY_ASK_WINDOW_HOURS): boolean {
  const created = Date.parse(orderCreatedAt ?? "");
  return Number.isFinite(created) && now.getTime() - created <= windowHours * 3_600_000;
}

/** El aviso de la ficha, con la marca de la pasada y el pedido. */
export function chatbyLocationHoldFrom(input: {
  reason: ChatbyAskReason;
  ask: ChatbyAskKind;
  check: ChatbyHeldCheck;
  master: { order_created_at?: string | null; customer_name?: string | null; order_name?: string | null };
  now: Date;
}): ChatbyLocationHold {
  const askedAt = chatbyAskedAt(input.check);
  return {
    reason: input.reason,
    ask: input.ask,
    heldAt: chatbyHeldAt(input.check) ?? isoOf(input.check.checked_at),
    askedAt,
    inWindow: chatbyAskInWindow(input.master.order_created_at, input.now),
    watching: chatbyAskWatching({ reason: input.reason, askedAt, orderCreatedAt: input.master.order_created_at, now: input.now }),
    customerName: input.master.customer_name ?? null,
    orderName: input.master.order_name ?? null,
  };
}
