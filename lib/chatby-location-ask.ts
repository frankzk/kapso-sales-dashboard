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
  /** ¿Kapta sigue mirando este pedido? 72 h desde que se creó o, pasadas, si la clienta escribió hace menos de 24 h. */
  inWindow: boolean;
  /** ¿La pasada vuelve a leer este chat? (dentro de la ventana y con el motivo vigilado). */
  watching: boolean;
  customerName: string | null;
  orderName: string | null;
  /**
   * (0318) Lo último que Kapta le pidió SOLA por WhatsApp, si salió: la
   * dirección completa o la ubicación, y cuándo. La ficha lo dice para que la
   * asesora no se la vuelva a pedir.
   */
  autoAsk?: { what: "direccion" | "ubicacion"; at: string } | null;
  /** (0318) La clienta completó la dirección por Chatby y Kapta la guardó. */
  corrected?: boolean;
  /** (0318) Respondió a la pedida de la dirección, pero lo que escribió sigue incompleto. */
  replyIncomplete?: boolean;
  /**
   * (0325) Lo que Google encontró para la dirección actual y por qué no se usó
   * (la caché `order_geocodes`). Null: no se buscó, o se buscó otra dirección.
   */
  google?: ChatbyGoogleFinding | null;
}

/** Lo que la caché de Google guarda de la dirección del pedido (`order_geocodes`, 0301/0316/0325). */
export interface ChatbyGoogleFinding {
  /** ¿Pasó como edificio (lo que usa la guía automática)? */
  ok: boolean;
  /** ROOFTOP / RANGE_INTERPOLATED cuando pasó el candado; null si no. */
  precision: string | null;
  /** Por qué no se usó: los del candado (`impreciso`, `coincidencia_parcial`, `distrito_distinto`…) o `no_es_edificio`. */
  reason: string | null;
  /** (0316) El veredicto de la calle para el punto de la cuadra. */
  approxKind: string | null;
  approxMode: string | null;
  /** (0325) `formatted_address`, la calle (`route`) y el número de Google. Null en las filas de antes. */
  label: string | null;
  route: string | null;
  number: string | null;
}

/** «Av. José Quiñones 546, Chiclayo 14001, Perú» → «Av. José Quiñones 546, Chiclayo». */
export function googleLabelShort(label: string | null | undefined): string {
  return (label ?? "")
    .replace(/,\s*Per[uú]\s*$/i, "")
    .replace(/\s+\d{5}(?=\s*(,|$))/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Qué tan cerca dio Google, entre paréntesis después de lo que encontró. */
function googlePrecisionLabel(f: ChatbyGoogleFinding): string | null {
  if (f.precision === "ROOFTOP") return "el edificio";
  if (f.precision === "RANGE_INTERPOLATED") return "punto de la cuadra";
  if (f.reason === "impreciso") return "solo el centro de la calle o de la zona";
  return null;
}

/** Por qué no se usó, en palabras de la asesora: lo que sigue a «No se usó porque…». Null si sí se podía usar. */
export function googleRejectionText(f: ChatbyGoogleFinding): string | null {
  if (f.ok) return null;
  const route = f.route ? ` («${f.route}»)` : "";
  switch (f.reason) {
    case "impreciso":
      return "Google solo la ubica en el centro de la calle o de la zona, no en la puerta de la casa";
    case "coincidencia_parcial":
      return "Google no reconoce la dirección completa: encontró una parecida, no exactamente esa";
    case "distrito_distinto":
      return "lo que encontró está en otro distrito, no en el del pedido";
    case "departamento_distinto":
      return "lo que encontró está en otro departamento, no en el del pedido";
    case "fuera_del_peru":
      return "lo que encontró está fuera del Perú";
    case "pedido_sin_destino":
      return "el pedido no trae distrito o departamento para comprobarlo";
    case "no_es_edificio":
      switch (f.approxKind) {
        case "calle":
          return f.approxMode === "activo"
            ? "aunque es la misma calle, el mismo número y la misma provincia, la guía no salió con ese punto"
            : "es el punto de la cuadra, no el edificio, y la «ubicación aproximada en la calle correcta» está en Simulación: el punto se guardó, pero la guía automática todavía no lo usa";
        case "otra_calle":
          return `es el punto de la cuadra y el nombre de la calle de Google${route} no es el de la dirección del pedido`;
        case "otro_numero":
          return `es el punto de la cuadra de otro número${f.number ? ` (${f.number})` : ""}, no el de la dirección del pedido`;
        case "otra_provincia":
          return "es el punto de la cuadra, pero en otra provincia";
        case "sin_calle":
          return "es el punto de la cuadra, pero Google no dio la calle y el número para comprobar que es la del pedido";
        default:
          return "es el punto de la cuadra, no el edificio, y la guía automática solo usa el edificio (la «ubicación aproximada en la calle correcta» está apagada)";
      }
    default:
      return null;
  }
}

/** ¿Google encontró algo para esa dirección? (sin resultado, no) */
function googleFoundSomething(f: ChatbyGoogleFinding | null | undefined): f is ChatbyGoogleFinding {
  return !!f && f.reason !== "sin_resultado" && (f.ok || !!f.label || !!f.precision || googleRejectionText(f) !== null);
}

/**
 * «Google encontró: Av. José Quiñones 546, Chiclayo (punto de la cuadra). No
 * se usó porque …» (0325). Sin lo que encontró Google, null. Pura.
 */
export function chatbyGoogleFindingText(f: ChatbyGoogleFinding | null | undefined): string | null {
  if (!googleFoundSomething(f)) return null;
  const label = googleLabelShort(f.label);
  const precision = googlePrecisionLabel(f);
  const why = googleRejectionText(f);
  const found = label
    ? `Google encontró: ${label}${precision ? ` (${precision})` : ""}.`
    : f.precision === "RANGE_INTERPOLATED"
      ? `Google encontró el punto de la cuadra${f.route ? ` de «${f.route}${f.number ? ` ${f.number}` : ""}»` : ""}.`
      : f.ok
        ? "Google encontró el edificio."
        : null;
  if (!found) return why ? `No se usó lo que encontró Google porque ${why}.` : null;
  return why ? `${found} No se usó porque ${why}.` : found;
}

/**
 * El título del aviso: por qué se paró la guía automática. (0325) Si Google
 * sí encontró algo, no dice que no la encuentra.
 */
export function chatbyAskTitle(reason: ChatbyAskReason, google?: ChatbyGoogleFinding | null): string {
  if (reason === "direccion_incompleta") return "La clienta confirmó, pero la dirección está incompleta";
  return googleFoundSomething(google)
    ? "La clienta confirmó, pero no se pudo usar lo que encontró Google"
    : "La clienta confirmó, pero Google no encuentra la dirección";
}

/** Por qué se paró, en una frase, debajo del título. */
export function chatbyAskExplanation(hold: Pick<ChatbyLocationHold, "reason" | "ask" | "corrected" | "google">): string {
  // (0325) Qué encontró Google y por qué no se usó, en vez de «no da el edificio».
  const found = hold.reason !== "direccion_incompleta" ? chatbyGoogleFindingText(hold.google) : null;
  if (found) {
    return hold.corrected
      ? `La clienta completó la dirección por Chatby y Kapta la guardó. ${found} Aliclik exige la ubicación para crear la guía.`
      : `${found} La clienta no mandó su ubicación de WhatsApp en esta compra y Aliclik la exige para crear la guía.`;
  }
  if (hold.corrected && hold.reason !== "direccion_incompleta") {
    return "La clienta completó la dirección por Chatby y Kapta la guardó, pero Google tampoco da el edificio. Aliclik exige la ubicación para crear la guía.";
  }
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
  hold: Pick<ChatbyLocationHold, "reason" | "askedAt" | "inWindow" | "watching" | "autoAsk" | "replyIncomplete">,
  askedWhen: string | null,
): string {
  const after =
    hold.reason === "direccion_incompleta"
      ? "si manda su ubicación, Kapta crea la guía con ella y confirma sola (una dirección escrita pasa por las reglas de siempre)."
      : "si manda su ubicación, Kapta crea la guía con ella y confirma sola.";
  if (!hold.inWindow) {
    return "Pasaron las 72 h del pedido y la clienta no escribió en las últimas 24 h: Kapta ya no vuelve a leer el chat sola. Cuando llegue la ubicación, crea la guía desde el panel de Aliclik y registra la confirmación en la mesa.";
  }
  // (0318) Respondió, pero la dirección sigue incompleta: Kapta no se la pide otra vez.
  if (hold.replyIncomplete && hold.reason === "direccion_incompleta") {
    return "La clienta respondió, pero la dirección que escribió sigue incompleta: Kapta no se la vuelve a pedir. Revisa el chat y pídele tú la ubicación si hace falta; si la manda, Kapta crea la guía con ella.";
  }
  // (0318) La última pedida la mandó Kapta sola: se dice, para no pedírsela otra vez.
  if (chatbyAutoAskIsLatest(hold)) {
    const direccion = hold.autoAsk!.what === "direccion";
    const next = direccion
      ? "si manda su ubicación, crea la guía con ella; si escribe la dirección completa, la guarda en el pedido, la vuelve a buscar en Google y, si tampoco la encuentra, le pide la ubicación."
      : "si manda su ubicación, crea la guía con ella y confirma sola.";
    return `Kapta le pidió ${direccion ? "la dirección completa" : "la ubicación"}${askedWhen ? `: ${askedWhen}` : ""} · esperando respuesta. No hace falta volver a pedírsela: cuando responda, Kapta vuelve a leer el chat (cada 30 minutos, dentro de las 72 h del pedido) y ${next}`;
  }
  if (hold.askedAt) {
    return `Se la pediste${askedWhen ? `: ${askedWhen}` : ""}. Cuando la clienta responda, Kapta vuelve a leer el chat (cada 30 minutos, dentro de las 72 h del pedido): ${after}`;
  }
  if (hold.watching) return `Kapta vuelve a leer el chat cada 30 minutos dentro de las 72 h del pedido: ${after}`;
  return `Pídesela desde aquí: con eso, cuando la clienta responda, Kapta vuelve a leer el chat y, ${after}`;
}

/** ¿La última pedida es la automática? (una persona pudo pedirla después desde aquí) */
export function chatbyAutoAskIsLatest(hold: Pick<ChatbyLocationHold, "askedAt" | "autoAsk">): boolean {
  if (!hold.autoAsk) return false;
  const auto = Date.parse(hold.autoAsk.at);
  const asked = Date.parse(hold.askedAt ?? "");
  return !Number.isFinite(asked) || auto >= asked;
}

/** La hora que dice el estado del aviso: la de la pedida automática, si es la última; si no, la de la persona. */
export function chatbyAskStatusAt(hold: Pick<ChatbyLocationHold, "askedAt" | "autoAsk">): string | null {
  return chatbyAutoAskIsLatest(hold) ? hold.autoAsk!.at : hold.askedAt;
}

/**
 * La última pedida automática que salió (`evidence.auto_asks` con `mode =
 * activo`, 0318). Lo de Simulación no salió: no cuenta.
 */
export function chatbyAutoAskSent(evidence: Record<string, unknown> | null | undefined): { what: "direccion" | "ubicacion"; at: string } | null {
  const raw = evidence?.auto_asks;
  if (!Array.isArray(raw)) return null;
  let best: { what: "direccion" | "ubicacion"; at: string } | null = null;
  for (const x of raw) {
    const m = x as { group?: unknown; at?: unknown; mode?: unknown } | null;
    if (!m || m.mode !== "activo" || (m.group !== "direccion" && m.group !== "ubicacion")) continue;
    const at = isoOf(m.at);
    if (!at) continue;
    if (!best || Date.parse(at) >= Date.parse(best.at)) best = { what: m.group, at };
  }
  return best;
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
  /** Los mensajes leídos: una clienta que escribió hace menos de 24 h se sigue mirando aunque el pedido pase de 72 h. */
  messages?: readonly { kind: string; at: string | null }[];
}): boolean {
  if (!chatbyHeldInWindow(input)) return false;
  return input.reason === "sin_ubicacion" || input.askedAt !== null;
}

/** La hora (ms) del último mensaje de la clienta, o null. */
export function chatbyLastCustomerAt(messages: readonly { kind: string; at: string | null }[]): number | null {
  let last: number | null = null;
  for (const m of messages) {
    if (m.kind !== "cliente" || !m.at) continue;
    const at = Date.parse(m.at);
    if (Number.isFinite(at) && (last === null || at > last)) last = at;
  }
  return last;
}

/** La ventana de atención de WhatsApp (Meta): 24 h desde el último mensaje de la clienta. */
export const CHATBY_CUSTOMER_WINDOW_MS = 24 * 3_600_000;

/**
 * ¿Lo que quedó para la asesora por la dirección o la ubicación se sigue
 * mirando? (owner, 08-11-2026) Dentro de las 72 h del pedido, como siempre, o
 * si la clienta escribió hace menos de 24 h: lo que manda es la ventana de
 * atención de WhatsApp, no la edad del pedido. Sin los mensajes (todavía no
 * se leyó), solo las 72 h.
 */
export function chatbyHeldInWindow(input: {
  orderCreatedAt: string | null | undefined;
  now: Date;
  windowHours?: number;
  messages?: readonly { kind: string; at: string | null }[];
}): boolean {
  if (chatbyAskInWindow(input.orderCreatedAt, input.now, input.windowHours)) return true;
  const last = input.messages ? chatbyLastCustomerAt(input.messages) : null;
  return last !== null && input.now.getTime() - last < CHATBY_CUSTOMER_WINDOW_MS;
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
  /** Los mensajes leídos (la ventana de 24 h de la clienta alarga la de 72 h del pedido). */
  messages?: readonly { kind: string; at: string | null }[];
  /** (0325) Lo que Google encontró para la dirección actual, si se buscó. */
  google?: ChatbyGoogleFinding | null;
}): ChatbyLocationHold {
  const askedAt = chatbyAskedAt(input.check);
  return {
    autoAsk: chatbyAutoAskSent(input.check.evidence),
    corrected: isoOf(input.check.evidence?.corrected_at) !== null,
    replyIncomplete: isoOf(input.check.evidence?.reply_incomplete_at) !== null,
    reason: input.reason,
    ask: input.ask,
    heldAt: chatbyHeldAt(input.check) ?? isoOf(input.check.checked_at),
    askedAt,
    inWindow: chatbyHeldInWindow({ orderCreatedAt: input.master.order_created_at, now: input.now, messages: input.messages }),
    watching: chatbyAskWatching({
      reason: input.reason,
      askedAt,
      orderCreatedAt: input.master.order_created_at,
      now: input.now,
      messages: input.messages,
    }),
    customerName: input.master.customer_name ?? null,
    orderName: input.master.order_name ?? null,
    google: input.google ?? null,
  };
}
