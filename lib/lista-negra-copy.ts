// Lo que Kapta DICE de la «Lista negra», en un solo sitio (owner, 09-11-2026;
// MOM §41.11 «Cómo se dice», DESIGN.md › Estados › «Lista negra»).
//
// Las dos listas —la automática (internamente «pago solo online») y la
// agregada a mano— se leen IGUAL en todas partes: la chapa del Master y de
// Leads, los avisos de la ficha del pedido y del lead, los frenos al confirmar
// y al crear guías, el motivo de Chatby, el 422 del bot, el aviso de «Generar
// pedido», la página «Lista negra» y el panel de Automatizaciones. Solo cambian
// la línea del motivo y «pago total» cuando es lo que se pide.
//
// Glosario: siempre «Lista negra» (L mayúscula, n minúscula); en una frase,
// «la Lista negra». Nunca «pago solo online», «lista de pago adelantado» ni
// «lista de pago completo» en pantalla: esas son llaves internas.
//
// Puro y sin dependencias de Kapta salvo el número del adelanto, para que lo
// importe cualquier módulo sin arriesgar un ciclo.

import { ADELANTO_MINIMO_LABEL } from "@/lib/adelanto-minimo";

/** El nombre. */
export const LN_NAME = "Lista negra";
/** La página (MOM §41); la de antes, `/dashboard/clientes/pago-adelantado`, redirige aquí. */
export const LN_PATH = "/dashboard/clientes/lista-negra";
/** En una frase: «la Lista negra». */
export const LN_IN_PROSE = "la Lista negra";

/** Lo que se le pide a quien está en la lista. Mismos valores que `pago_online_settings.requirement` y `prepay_list_entries.requirement`. */
export type LnRequirement = "adelanto" | "pago_completo";

// ── El motivo ───────────────────────────────────────────────────────────────

/** Por qué está: la automática (devolvió, o anula casi todo) o un alta a mano. */
export type LnMotivoSource =
  | { kind: "devuelto"; n: number | null | undefined }
  | { kind: "anulador"; n: number | null | undefined; m: number | null | undefined }
  | { kind: "rechazo"; n: number | null | undefined }
  | { kind: "manual"; reason?: string | null };

/**
 * El motivo, con las cuentas del propio cliente y nada de otros:
 *   * «Devolvió 1 pedido y nunca recibió» / «Devolvió 2 pedidos y nunca recibió»;
 *   * «Anuló 6 de 7 pedidos y nunca recibió»;
 *   * «Rechazó 1 pedido en la puerta y nunca recibió» (12-11-2026);
 *   * «Agregada a mano: <lo que escribió el equipo>» (o «Agregada a mano»).
 * Pura.
 */
export function lnMotivo(src: LnMotivoSource): string {
  if (src.kind === "manual") {
    const r = String(src.reason ?? "").trim();
    return r ? `Agregada a mano: ${r.replace(/[.\s]+$/, "")}` : "Agregada a mano";
  }
  if (src.kind === "anulador") {
    if (src.n && src.m) return `Anuló ${src.n} de ${src.m} pedidos y nunca recibió`;
    return "Anuló casi todos sus pedidos y nunca recibió";
  }
  const n = src.n && src.n > 0 ? src.n : 1;
  if (src.kind === "rechazo") return `Rechazó ${n} ${n === 1 ? "pedido" : "pedidos"} en la puerta y nunca recibió`;
  return `Devolvió ${n} ${n === 1 ? "pedido" : "pedidos"} y nunca recibió`;
}

/** El motivo dentro de una frase, entre paréntesis: la primera letra en minúscula. Pura. */
export function lnMotivoInline(motivo: string): string {
  return motivo ? motivo.charAt(0).toLowerCase() + motivo.slice(1) : motivo;
}

// ── El requisito ────────────────────────────────────────────────────────────

/** Lo que se le pide, en una línea. Pura. */
export function lnRequisito(requirement: LnRequirement): string {
  return requirement === "pago_completo"
    ? "Solo con pago total por adelantado."
    : `Para contra entrega: adelanto de ${ADELANTO_MINIMO_LABEL} validado o pago online completo.`;
}

/** Las opciones de «Qué se le pide» (alta a mano) y de «Qué se pide en los pedidos de Kapta» (Automatizaciones). */
export const LN_REQUIREMENT_LABEL: Record<LnRequirement, string> = {
  adelanto: `Adelanto de ${ADELANTO_MINIMO_LABEL}`,
  pago_completo: "Pago total",
};

// ── La chapa ────────────────────────────────────────────────────────────────

/** El tono de la chapa: negra con letras blancas (`Badge tone="blacklist"`). */
export const LN_BADGE_TONE = "blacklist" as const;

/** «Lista negra», o «Lista negra · pago total» cuando es lo que se pide. Pura. */
export function lnBadgeLabel(requirement: LnRequirement): string {
  return requirement === "pago_completo" ? `${LN_NAME} · pago total` : LN_NAME;
}

/** «{motivo}. {requisito}». Pura. */
export function lnBadgeTitle(motivo: string, requirement: LnRequirement): string {
  return `${motivo.replace(/\.$/, "")}. ${lnRequisito(requirement)}`;
}

// ── Los avisos (ficha del pedido y del lead) ────────────────────────────────

/** El título de los dos avisos. */
export const LN_BANNER_TITLE = LN_NAME;

/** La nota al pie de todos los avisos (chica, ink-500). */
export const LN_FOOTNOTE = "Kapta no le escribe a la clienta sobre la Lista negra.";

/** Qué hacer, en la ficha del pedido: sin cumplir (crit) o cumplido (info). Pura. */
export function lnOrderBannerAction(requirement: LnRequirement, met: boolean): string {
  if (met) return requirement === "pago_completo" ? "Pago total validado: el pedido puede seguir." : "Adelanto validado: el pedido puede seguir.";
  return requirement === "pago_completo"
    ? "No se confirma ni sale guía hasta validar el pago total."
    : "No se confirma ni sale guía hasta validar el adelanto. Regístralo en «Cómo sale el pedido».";
}

/** Qué hacer, en la ficha del lead (warn, arriba de «Cómo sale el pedido»). Pura. */
export function lnLeadBannerAction(requirement: LnRequirement): string {
  return requirement === "pago_completo"
    ? "No le ofrezcas contra entrega: solo pago total por adelantado."
    : `Antes de ofrecer contra entrega, pídele el adelanto de ${ADELANTO_MINIMO_LABEL}.`;
}

// ── Mensajes cortos (errores, avisos, la línea de tiempo) ───────────────────

/** El freno al confirmar o al crear una guía (también la confirmación de agencia). Pura. */
export function lnBrakeMessage(motivo: string, requirement: LnRequirement): string {
  const what = requirement === "pago_completo" ? "falta el pago total validado." : `falta el adelanto de ${ADELANTO_MINIMO_LABEL} validado.`;
  return `${LN_NAME} (${lnMotivoInline(motivo)}): ${what}`;
}

/** El motivo de Chatby al dejarlo para la asesora. Sin motivo: el texto del catálogo de motivos. Pura. */
export function lnChatbyHold(motivo: string | null, requirement: LnRequirement = "adelanto"): string {
  const head = motivo ? `${LN_NAME} (${lnMotivoInline(motivo)})` : LN_NAME;
  const cobra = requirement === "pago_completo" ? "Cobra el pago total y confirma tú." : "Cobra el adelanto y confirma tú.";
  return `${head}: Kapta no crea la guía ni le escribe. ${cobra}`;
}

/** El 422 `prepay_required` del bot de Kapso. Pura. */
export function lnBotMessage(motivo: string, requirement: LnRequirement): string {
  const cobrar = requirement === "pago_completo" ? "el pago total" : `el adelanto de ${ADELANTO_MINIMO_LABEL} o el pago online completo`;
  return `Cliente en ${LN_NAME} (${lnMotivoInline(motivo)}). El bot no crea pedidos contra entrega: deriva a una asesora para cobrar ${cobrar}.`;
}

/** Lo que se añade al aviso de «Pedido generado» cuando pide el adelanto. */
export const LN_GENERATE_NOTICE = `· ${LN_NAME}: no sale sin el adelanto de ${ADELANTO_MINIMO_LABEL} validado.`;

/** «Generar pedido» no lo crea (pide el pago total). Pura. */
export function lnGenerateRefused(motivo: string): string {
  return `${LN_NAME} (${lnMotivoInline(motivo)}): solo con pago total por adelantado; no se genera contra entrega.`;
}

/** «No se pudo comprobar la Lista negra» (falla cerrado en una guía). Pura. */
export function lnUnreadMessage(detail?: string | null): string {
  return `No se pudo comprobar la Lista negra${detail ? ` (${detail})` : ""}. Vuelve a intentarlo.`;
}

// ── Acciones ────────────────────────────────────────────────────────────────

export const LN_EXCEPT_BUTTON = "Exceptuar de la Lista negra";
export const LN_EXCEPT_REASON_LABEL = "Motivo";
export const LN_EXCEPT_REASON_PLACEHOLDER = "Por qué puede pagar contra entrega (mín. 8 caracteres)";
export const LN_EXCEPT_DONE = "Exceptuada: Kapta ya no la frena; las tiendas, desde el envío de mañana 05:00.";
export const LN_EXCEPTION_REMOVE = "Quitar excepción";
export const LN_MANUAL_ADD_BUTTON = "Agregar a la Lista negra";
export const LN_MANUAL_REQUIREMENT_LABEL = "Qué se le pide";
export const LN_MANUAL_REMOVE = "Sacar de la Lista negra";

// ── La página «Lista negra» ─────────────────────────────────────────────────

export const LN_PAGE_SUBTITLE =
  "Clientes que solo pueden comprar contra entrega con adelanto (o pagando todo online). Kapta la calcula cada día a las 05:00 y la manda a Kenku y Aurela.";
export const LN_SECTION_AUTO = "Automática";
export const LN_SECTION_AUTO_HELP =
  "Entra quien devolvió un pedido, rechazó uno en la puerta o anuló 5 o más con 75 % o más anulados, y nunca recibió. Sale sola cuando recibe un pedido.";
export const LN_SECTION_MANUAL = "Agregados a mano";
export const LN_SECTION_MANUAL_HELP = "Para lo que la regla no ve: fraude, una clienta que avisó que no va a recibir.";
export const LN_SEARCH_LABEL = "Buscar un celular";
export const LN_SEARCH_PLACEHOLDER = "987 654 321";
export const LN_EMPTY_MANUAL = "Nadie agregado a mano todavía.";
export const LN_EMPTY_EXCEPTIONS = "Sin excepciones.";

/** «Está en la Lista negra · {motivo}». Pura. */
export function lnSearchListed(motivo: string): string {
  return `Está en la Lista negra · ${motivo}`;
}
export const LN_SEARCH_NOT_LISTED = "No está en la Lista negra";
/** «Exceptuada · {motivo de la excepción}». Pura. */
export function lnSearchExcepted(reason: string): string {
  return `Exceptuada · ${reason}`;
}

// ── Automatizaciones ────────────────────────────────────────────────────────

export const LN_PANEL_TITLE = LN_NAME;
export const LN_PANEL_REQUIREMENT_LABEL = "Qué se pide en los pedidos de Kapta";
/** Los nombres del historial: «Lista negra · …». Pura. */
export function lnHistoryLabel(suffix: string | null): string {
  return suffix ? `${LN_NAME} · ${suffix}` : LN_NAME;
}

/**
 * Lo que NUNCA se dice en pantalla (la prueba de la copia lo busca en los
 * componentes): los nombres viejos y la fórmula larga del titular.
 */
export const LN_RETIRED_LITERALS: readonly string[] = [
  "Pago solo online",
  "pago solo online",
  "Lista de pago adelantado",
  "lista de pago adelantado",
  "lista de pago completo",
  "Cliente con entrega devuelta y ninguna recibida",
  "solo pago online o adelanto",
];
