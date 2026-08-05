// La gestión de confirmación: los siete días de Milagros.
//
// El MOM §6.1 cuenta «siete días distintos de gestión», no siete días desde el
// primer contacto. Si se llamó el 20, el 22, el 25 y el 28 de julio, van CUATRO
// días, no nueve. Los días sin intento no gastan cupo: el cliente conserva sus
// siete oportunidades aunque el equipo tarde en volver a llamarlo.
//
// Dentro de un mismo día puede haber varios contactos y por varios canales —
// llamada, llamada de WhatsApp, mensaje escrito—: todos suman UN día.
//
// Este archivo es puro y no importa nada del resolvedor de macroetapas, que sí
// lo importa a él.

/** Días de gestión antes de llegar a «Último intento». */
export const CONFIRMATION_MAX_DAYS = 7;

/**
 * Eventos que cuentan como un intento de contacto. `contact_attempt` y `call`
 * quedan por compatibilidad con lo que pueda haberse escrito antes.
 */
export const CONFIRMATION_CONTACT_KINDS = [
  "confirmation_contact",
  "contact_attempt",
  "call",
] as const;

/** Eventos que dejan pactado un próximo contacto. */
export const CONFIRMATION_FOLLOWUP_KINDS = [
  "confirmation_followup",
  "followup_scheduled",
  "reschedule_contact",
] as const;

/** Marca explícita de último intento, para casos que no salen del conteo. */
export const CONFIRMATION_LAST_ATTEMPT_KINDS = [
  "confirmation_last_attempt",
  "last_attempt",
] as const;

/**
 * Eventos que dan por confirmado el pedido. `confirmed` es la palabra del
 * asesor; los otros dos son el acto logístico que la da por hecha.
 */
export const CONFIRMATION_SIGNAL_KINDS = [
  "confirmed",
  "guide_registered",
  "label_generated",
] as const;

/**
 * ¿Hay señal de confirmación sobre el pedido? UNA sola definición, como la
 * cobertura tiene la suya en `order_coverage_for`.
 *
 * Vivía copiada en cuatro sitios y ya habían divergido: `order-status` miraba
 * solo el evento `confirmed` y el pago de Shopify, así que decía «sin
 * confirmar» sobre pedidos que el MOM ya había mandado a Preparación por tener
 * guía. Es la misma forma del bug de cobertura —dos implementaciones libres de
 * separarse en silencio—, y por eso la respuesta se da una vez.
 *
 * Responde por la EVIDENCIA, no por la política: que Lima no necesite
 * confirmación (MOM §5, «Lima omite confirmación y entra directamente a
 * Preparación») es una regla de macroetapa y se aplica en su llamador. Meterla
 * aquí haría que el estado operativo legado diera por confirmados a los pedidos
 * de Lima que nadie llamó.
 */
export function hasConfirmationSignal(input: {
  /** Una guía existente es el acto logístico que confirma. */
  hasGuide: boolean;
  events: readonly { kind: string }[];
  financialStatus?: string | null;
}): boolean {
  if (input.hasGuide) return true;
  const kinds: readonly string[] = CONFIRMATION_SIGNAL_KINDS;
  if (input.events.some((event) => kinds.includes(event.kind))) return true;
  // En contraentrega no hay pago previo, así que `paid` es señal de que el
  // pedido se cobró por otra vía y ya nadie espera una llamada.
  return (input.financialStatus ?? "").trim().toLowerCase() === "paid";
}

export const CONFIRMATION_CHANNELS = [
  { code: "llamada", label: "Llamada" },
  { code: "whatsapp", label: "Llamada WhatsApp" },
  { code: "mensaje", label: "Mensaje escrito" },
] as const;

export type ConfirmationChannel = (typeof CONFIRMATION_CHANNELS)[number]["code"];

export interface ConfirmationResultDef {
  code: string;
  label: string;
  /** Pide fecha de próximo contacto y deja el pedido en «Volver a contactar». */
  schedulesFollowup: boolean;
  /** Cierra la confirmación: el pedido pasa a Preparación. */
  confirms: boolean;
  hint: string;
}

/**
 * El catálogo de resultados. El orden es el del desplegable y el primero es el
 * que sale marcado por defecto, así que `sin_respuesta` se queda al frente: es
 * el desenlace más común y el que menos daño hace si alguien no lo cambia.
 *
 * Dos resultados distintos pueden mover el pedido igual y aun así valer la pena
 * por separado: lo que se guarda es el código, no el efecto, y el hecho queda
 * escrito con el nombre que le puso quien llamó.
 */
export const CONFIRMATION_RESULTS: readonly ConfirmationResultDef[] = [
  {
    code: "sin_respuesta",
    label: "No contestó",
    schedulesFollowup: false,
    confirms: false,
    hint: "Suma un día de gestión y el pedido sigue Por confirmar.",
  },
  {
    // Dejar mensaje no es que no contestaran: al buzón o al WhatsApp le queda
    // una pregunta hecha, y al siguiente que abra el pedido le cambia el guion
    // de la llamada. Gasta el mismo día porque el §6.1 cuenta el día con
    // gestión, no el día con respuesta.
    code: "se_deja_mensaje",
    label: "Se deja mensaje",
    schedulesFollowup: false,
    confirms: false,
    hint: "Suma un día de gestión y el pedido sigue Por confirmar.",
  },
  {
    code: "volver_a_contactar",
    label: "Contestó · volver a contactar",
    schedulesFollowup: true,
    confirms: false,
    hint: "Queda pactada una fecha; el pedido pasa a Volver a contactar.",
  },
  {
    // El caso que el §6.1 ya describía sin poder elegirse: el cliente aceptó y
    // quedó en abonar. Pacta fecha como «volver a contactar» porque es lo que
    // es —hay que volver a llamarlo— y el pedido NO queda confirmado: en
    // Agencia la confirmación exige el pago validado, no la promesa.
    //
    // No enciende el motivo `pago_requerido_pendiente`: ese sale del estado del
    // pago, y hacerlo depender de lo que se marque acá lo volvería un motivo
    // que alguien puede olvidar, que es justo lo que el MOM evita al derivarlo.
    code: "pendiente_de_abono",
    label: "Pendiente de abono",
    schedulesFollowup: true,
    confirms: false,
    hint: "Queda pactada la fecha para verificar el abono; el pedido pasa a Volver a contactar.",
  },
  {
    code: "confirmado",
    label: "Confirmó el pedido",
    schedulesFollowup: false,
    confirms: true,
    hint: "Producto, cantidad, monto, fecha aproximada y dirección validados.",
  },
] as const;

export function confirmationResult(code: string): ConfirmationResultDef | null {
  return CONFIRMATION_RESULTS.find((result) => result.code === code) ?? null;
}

export function isConfirmationChannel(code: string): code is ConfirmationChannel {
  return CONFIRMATION_CHANNELS.some((channel) => channel.code === code);
}

export function confirmationChannelLabel(code: string | null | undefined): string {
  return CONFIRMATION_CHANNELS.find((channel) => channel.code === code)?.label ?? code ?? "—";
}

/**
 * El nombre del resultado. Cae al código crudo si algún día se retira uno del
 * catálogo: los hechos ya escritos no se reescriben (§2.6), así que la línea de
 * tiempo tiene que poder pintar un resultado que ya no se ofrece.
 */
export function confirmationResultLabel(code: string | null | undefined): string | null {
  if (!code) return null;
  return confirmationResult(code)?.label ?? code;
}

/** Canal y resultado tal como se guardaron en el intento. */
export interface ConfirmationAttemptDetail {
  channel: string | null;
  result: string | null;
}

/**
 * Lee del payload de un evento el canal y el resultado del intento.
 *
 * Se guardaban desde el principio y nunca se leyeron: la línea de tiempo
 * mostraba «Intento de confirmación» y la nota, de modo que dos resultados
 * distintos se veían idénticos salvo que alguien escribiera la nota a mano.
 */
export function confirmationAttemptDetail(
  payload: Record<string, unknown> | null | undefined,
): ConfirmationAttemptDetail | null {
  if (!payload) return null;
  const text = (value: unknown) => (typeof value === "string" && value ? value : null);
  const channel = text(payload.channel);
  const result = text(payload.result);
  if (!channel && !result) return null;
  return { channel, result };
}

/**
 * El día calendario de Lima al que pertenece un instante.
 *
 * Contar en UTC partiría mal los días: una llamada de las 20:00 de Lima es el
 * 01:00 UTC del día siguiente, y el mismo intento gastaría dos cupos de los
 * siete. Perú no tiene horario de verano, pero se usa la zona por nombre para
 * no depender de que eso siga siendo cierto.
 */
export function limaDayKey(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Lima",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const part = (type: "year" | "month" | "day") =>
    parts.find((p) => p.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

export interface ConfirmationEventLike {
  kind: string;
  occurred_at: string;
}

/**
 * Los días distintos con al menos un intento, en orden. Es el numerador de
 * «día X de 7»: cada elemento es un día gastado, no un día transcurrido.
 */
export function confirmationDays(
  events: readonly ConfirmationEventLike[],
): string[] {
  const kinds = new Set<string>(CONFIRMATION_CONTACT_KINDS);
  const days = new Set<string>();
  for (const event of events) {
    if (!kinds.has(event.kind)) continue;
    const day = limaDayKey(event.occurred_at);
    if (day) days.add(day);
  }
  return [...days].sort();
}

/** Cuántos días de gestión se han usado. */
export function confirmationDayCount(events: readonly ConfirmationEventLike[]): number {
  return confirmationDays(events).length;
}

/**
 * ¿El pedido llegó al séptimo día? Después de este punto el MOM crea una tarea
 * de anulación MANUAL en Shopify: Kapta nunca anula solo.
 */
export function reachedLastAttempt(events: readonly ConfirmationEventLike[]): boolean {
  if (confirmationDayCount(events) >= CONFIRMATION_MAX_DAYS) return true;
  const explicit = new Set<string>(CONFIRMATION_LAST_ATTEMPT_KINDS);
  return events.some((event) => explicit.has(event.kind));
}
