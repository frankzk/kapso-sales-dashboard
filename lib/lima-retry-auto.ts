// Reintentos Aliclik automáticos en Lima (MOM §9.5, entrega 3, y §40 «Panel de
// automatizaciones», 04-11-2026, pedido del owner).
//
// POR QUÉ. La bandeja «Reintentos Aliclik» (entrega 2) ya decide QUÉ toca con
// cada no entregado de la cadena; faltaba que alguien pulsara «Aprobar». El
// owner pidió que cada variante de la automatización se pueda encender sola,
// desde un panel, y que antes de crear guías de verdad pase por una simulación.
//
// LA REGLA. Una variante es el PASO de la cadena (de qué courier viene y a qué
// transporte va) por el MOTIVO del intento que falló. Cada variante tiene tres
// posiciones:
//   * `apagado`    — la bandeja la sigue mostrando para aprobar a mano.
//   * `simulacion` — la pasada dice qué guía habría creado y no crea nada.
//   * `activo`     — la pasada crea la guía como «Aprobar», sin persona.
// Lo demás no cambia: la cadena, quién entra, cuándo se corta y que el
// reintento salga OTRO día que el intento que falló son los de la entrega 2.
//
// Pura: sin base ni red. La pasada está en `lib/lima-retry-auto-server.ts`.

import { CHAIN_REASONS, type ChainReason, type LimaRetryChain } from "@/lib/lima-retry-chain";

/** Los pasos de la cadena, en el orden del panel. */
export const RETRY_STEPS = [
  {
    key: "alexis_autoecom",
    label: "Alexis (Grupo GF) → AUTOECOM",
    hint: "Segundo intento de una cadena de tres: falló Alexis y sale por Aliclik AUTOECOM.",
  },
  {
    key: "urpi_autoecom",
    label: "Urpi → AUTOECOM",
    hint: "Segundo intento de una cadena de tres: falló Urpi y sale por Aliclik AUTOECOM.",
  },
  {
    key: "autoecom_alidriver_3",
    label: "AUTOECOM → ALIDRIVER (tercer intento)",
    hint: "Último intento de la cadena que empezó con Alexis o Urpi: falló AUTOECOM y sale por ALIDRIVER.",
  },
  {
    key: "autoecom_alidriver_2",
    label: "AUTOECOM → ALIDRIVER (cadena de dos)",
    hint: "AUTOECOM fue el primer intento y falló: el segundo y último sale por ALIDRIVER.",
  },
] as const;

export type RetryStep = (typeof RETRY_STEPS)[number]["key"];

/** Las columnas del panel: los motivos con los que el pedido sigue en la cadena. */
export const RETRY_REASON_LABEL: Record<ChainReason, string> = {
  no_contesta: "No contesta",
  no_estaba: "No estaba",
  otro: "Otro",
};

export const RETRY_MODES = ["apagado", "simulacion", "activo"] as const;
export type RetryMode = (typeof RETRY_MODES)[number];

export const RETRY_MODE_LABEL: Record<RetryMode, string> = {
  apagado: "Apagado",
  simulacion: "Simulación",
  activo: "Activo",
};

/** «alexis_autoecom:no_contesta». */
export type RetryVariant = `${RetryStep}:${ChainReason}`;

/** Las doce variantes: cada paso por cada motivo. */
export const RETRY_VARIANTS: readonly RetryVariant[] = RETRY_STEPS.flatMap((step) =>
  CHAIN_REASONS.map((reason) => `${step.key}:${reason}` as RetryVariant),
);

export function isRetryVariant(value: unknown): value is RetryVariant {
  return typeof value === "string" && (RETRY_VARIANTS as readonly string[]).includes(value);
}

export function isRetryMode(value: unknown): value is RetryMode {
  return typeof value === "string" && (RETRY_MODES as readonly string[]).includes(value);
}

/** Tope de guías automáticas por día de Lima, entre las tiendas de la organización. */
export const RETRY_DAILY_CAP_DEFAULT = 10;
export const RETRY_DAILY_CAP_MIN = 1;
export const RETRY_DAILY_CAP_MAX = 50;

/**
 * Las horas de Lima en que corre la pasada: de 8:00 a 13:59, antes del corte
 * de Aliclik (2:00 p. m.) para que la guía salga ese mismo día. Lo de la tarde
 * espera a la primera pasada del día siguiente.
 */
export const RETRY_FIRST_HOUR_LIMA = 8;
export const RETRY_LAST_HOUR_LIMA = 13;

export function retryPassOpen(limaHour: number): boolean {
  return limaHour >= RETRY_FIRST_HOUR_LIMA && limaHour <= RETRY_LAST_HOUR_LIMA;
}

/**
 * El paso de la cadena que toca, o null si la cadena no sigue. Lo decide el
 * intento que falló: Alexis o Urpi → AUTOECOM; AUTOECOM → ALIDRIVER, de tres si
 * la cadena empezó antes de AUTOECOM y de dos si empezó en AUTOECOM. Pura.
 */
export function retryStepOf(chain: LimaRetryChain): RetryStep | null {
  if (chain.state !== "siguiente") return null;
  const carrier = chain.failed.carrier;
  if (chain.next === "autoecom") {
    if (carrier === "alexis") return "alexis_autoecom";
    if (carrier === "urpi") return "urpi_autoecom";
    return null;
  }
  if (carrier !== "autoecom") return null;
  return chain.of === 3 ? "autoecom_alidriver_3" : "autoecom_alidriver_2";
}

/** La variante de una cadena que sigue: el paso y el motivo del intento que falló. Pura. */
export function retryVariantOf(chain: LimaRetryChain): RetryVariant | null {
  const step = retryStepOf(chain);
  if (!step || chain.state !== "siguiente") return null;
  const reason = chain.failed.reason;
  if (!(CHAIN_REASONS as readonly string[]).includes(reason ?? "")) return null;
  return `${step}:${reason as ChainReason}`;
}

/** La posición de cada variante; lo que no está guardado está apagado. Pura. */
export function retryModes(rows: readonly { variant: string; mode: string }[]): Record<RetryVariant, RetryMode> {
  const modes = Object.fromEntries(RETRY_VARIANTS.map((v) => [v, "apagado"])) as Record<RetryVariant, RetryMode>;
  for (const row of rows) {
    if (isRetryVariant(row.variant) && isRetryMode(row.mode)) modes[row.variant] = row.mode;
  }
  return modes;
}

/** ¿Alguna variante hace algo (simula o crea)? Si no, la pasada ni lee pedidos. Pura. */
export function anyRetryVariantOn(modes: Record<RetryVariant, RetryMode>): boolean {
  return RETRY_VARIANTS.some((v) => modes[v] !== "apagado");
}

/** «Alexis (Grupo GF) → AUTOECOM · no contesta». Pura. */
export function retryVariantLabel(variant: RetryVariant): string {
  const [step, reason] = variant.split(":") as [RetryStep, ChainReason];
  const stepLabel = RETRY_STEPS.find((s) => s.key === step)?.label ?? step;
  return `${stepLabel} · ${RETRY_REASON_LABEL[reason].toLowerCase()}`;
}

/**
 * Lo que pasó con un pedido en una pasada (`lima_retry_auto_log.outcome`).
 *   * `simulada`         — en simulación: habría creado la guía.
 *   * `creada`           — guía creada.
 *   * `fallo`            — Aliclik o Kapta rechazaron la creación (avisa por Telegram).
 *                          En simulación: «Activo no la crearía» (una compuerta
 *                          de Kapta). Si el «no» es una regla de Kapta, Activo
 *                          además lo pasa a Repro Lima (no se reintenta).
 *   * `incierto`         — Aliclik no respondió a tiempo (pudo haberse creado), o
 *                          la creó y Kapta no pudo guardarla (lleva su código).
 *   * `sin_transporte`   — Aliclik no ofrece ese transporte: pasa a Repro Lima.
 *   * `no_seleccionable` — lo ofrece pero hoy no se puede agendar: se reintenta.
 *   * `en_curso`         — esta pasada (u otra) la está creando; o el candado lo tiene otra creación.
 *   * `tope`             — se llegó al tope del día: se reintenta mañana.
 *   * `atendiendo`       — una persona tiene el caso tomado en Repro Lima: se reintenta.
 *   * `esperando_aliclik`— Aliclik está fallando: se reintenta en la pasada siguiente.
 *   * `sin_ubicacion`    — el pedido no tiene coordenada usable y Aliclik la exige
 *                          (05-11-2026). Se reintenta, no cuenta para el tope, no
 *                          avisa por Telegram, no deja hecho de fallo y no saca
 *                          el pedido de la cadena: sigue en la bandeja hasta
 *                          que una persona pone la ubicación en la ficha del
 *                          pedido («Corregir ubicación»).
 */
export const RETRY_OUTCOMES = [
  "simulada",
  "creada",
  "fallo",
  "incierto",
  "sin_transporte",
  "no_seleccionable",
  "en_curso",
  "tope",
  "atendiendo",
  "esperando_aliclik",
  "sin_ubicacion",
] as const;
export type RetryOutcome = (typeof RETRY_OUTCOMES)[number];

/** Lo que se vuelve a intentar en la siguiente pasada del mismo día. */
export const RETRY_OUTCOMES_RETRYABLE: readonly RetryOutcome[] = ["no_seleccionable", "tope", "atendiendo", "esperando_aliclik", "sin_ubicacion"];

/** Lo que cuenta para el tope del día: lo creado y lo que pudo crearse. */
export const RETRY_OUTCOMES_COUNTED: readonly RetryOutcome[] = ["creada", "incierto", "en_curso"];

export const RETRY_OUTCOME_LABEL: Record<RetryOutcome, string> = {
  simulada: "Habría creado la guía",
  creada: "Guía creada",
  fallo: "No se pudo crear",
  incierto: "Puede estar creada: revisar en Aliclik",
  sin_transporte: "Sin ese transporte: pasó a Repro Lima",
  no_seleccionable: "No se puede agendar ahora",
  en_curso: "Creándose",
  tope: "Tope del día alcanzado",
  atendiendo: "Una persona lo está atendiendo",
  esperando_aliclik: "Esperando a que Aliclik responda",
  sin_ubicacion: "Sin ubicación: falta la coordenada",
};

/** Quedan guías para hoy. Pura. */
export function retryCapLeft(countedToday: number, cap: number): number {
  return Math.max(0, cap - countedToday);
}

/**
 * Lo que decide la pasada justo antes de crear, con el pedido y la posición
 * de la variante leídos OTRA VEZ (04-11-2026). La lista de candidatos se lee
 * al empezar y la pasada puede durar cuatro minutos: entretanto la tienda pudo
 * pasarlo «A Repro Lima», acordar otra cosa, tomar el caso, o el owner apagar
 * la variante. Pura.
 *   * `crear`      — todo sigue igual: se crea.
 *   * `atendiendo` — una persona tomó el caso: es suyo, se reintenta después.
 *   * `soltar`     — ya no toca (o no en Activo): no se crea y se suelta el
 *                    candado del log, como si esta pasada no lo hubiera tomado.
 */
export type RetryRecheck = { action: "crear" } | { action: "atendiendo" } | { action: "soltar"; reason: string };

export function retryRecheck(input: {
  /** `retryChainOf` con los hechos de ahora (null: la cadena no sigue). */
  chain: { ready: boolean } | null;
  /** La cadena cruda de ahora (`facts.retryChain`). */
  raw: LimaRetryChain | null;
  /** La variante con la que se tomó el pedido. */
  variant: RetryVariant;
  /** La posición guardada AHORA de esa variante. */
  mode: RetryMode;
  /** Una persona tiene el caso tomado ahora. */
  claimed: boolean;
}): RetryRecheck {
  if (!input.chain || !input.raw || input.raw.state !== "siguiente") {
    return { action: "soltar", reason: "Ya no está en la cadena: pasó a Repro Lima, se acordó otra cosa, salió de la etapa o venció." };
  }
  if (!input.chain.ready) return { action: "soltar", reason: "El intento falló hoy: el reintento sale otro día." };
  if (retryVariantOf(input.raw) !== input.variant) {
    return { action: "soltar", reason: "Cambió el paso o el motivo de la cadena: lo decide la pasada siguiente." };
  }
  if (input.mode !== "activo") {
    return { action: "soltar", reason: `La variante pasó a ${RETRY_MODE_LABEL[input.mode]} durante la pasada.` };
  }
  if (input.claimed) return { action: "atendiendo" };
  return { action: "crear" };
}

/**
 * El motivo con el que la pasada saca de la cadena un pedido que una regla de
 * Kapta no deja crear (`kaptaBlock`): repetir mañana daría el mismo «no», así
 * que pasa a Repro Lima en vez de fallar y avisar cada día. Pura.
 */
export function retryKaptaBlockReason(error: string): string {
  const why = error.trim().replace(/\.$/, "");
  return `Kapta no deja crear el reintento automático (${why}). Pasa a Repro Lima.`;
}

/**
 * Qué decir de un pedido con una creación de Aliclik sin su guía en Kapta
 * (`unsavedAliclikIntent`): la pasada no lo cotiza ni lo toma, es de una
 * persona. Pura.
 */
export function retryHeldDetail(unsaved: { status: string; orderNumber: string | null }): string {
  if (unsaved.status !== "pending" && unsaved.orderNumber) {
    return `Aliclik ya tiene la guía ${unsaved.orderNumber} de este pedido y Kapta no la guardó: vincúlala o revísala a mano. No se crea otra.`;
  }
  return "Hay una creación en Aliclik sin respuesta o en curso: revisa en Aliclik antes de crear otra. No se crea otra.";
}

/** El motivo de la salida adicional de Lima que lleva la guía automática. Pura. */
export function autoRetryMotive(chain: Extract<LimaRetryChain, { state: "siguiente" }>, failedText: string): string {
  return `Reintento Aliclik ${chain.attempt} de ${chain.of} automático (regla encendida en Automatizaciones). ${failedText}.`;
}

// ---------------------------------------------------------------------------
// Sin ubicación (owner, 05-11-2026)
//
// Desde WooCommerce, en Lima solo un 10–20 % de los pedidos trae coordenada (en
// Shopify, el 99 %), y Aliclik no cotiza sin ella: la simulación del 05-11-2026
// dio 1 de 19 «Habría creado» y 18 «Este pedido no tiene coordenada». No es un
// fallo de Aliclik ni una regla de Kapta: falta un dato que una persona puede
// poner (el enlace de Maps de la clienta) o que la ubicación por dirección
// (Google, edificio) puede dar si el owner la encendió. Por eso es su propio
// resultado: se reintenta, no cuenta para el tope, no avisa por Telegram, no
// deja `lima_retry_auto_failed` y no saca el pedido de la cadena.

/** De dónde salió la coordenada con la que se cotiza el reintento. */
export type RetryCoordinateSource = "pedido" | "google";

/** Lo que queda en el detalle del log cuando la coordenada vino de Google (como Chatby). */
export const RETRY_GOOGLE_COORDINATE_NOTE = "ubicación por dirección (Google, edificio)";

/** Por qué no se buscó o no sirvió la ubicación por dirección. */
export type RetryGeocodeMiss =
  /** El interruptor apagado, sin clave o la última medición de Lima no cumple B. */
  | "apagado"
  /** Google no dio el edificio, o el candado no lo dejó pasar. */
  | "sin_edificio"
  /** El pedido no trae calle que mandar. */
  | "sin_direccion"
  /** Se agotó el cupo diario de Google en esta pasada. */
  | "sin_cupo"
  /** Google o la caché fallaron: se vuelve a probar en la pasada siguiente. */
  | "error";

/** El detalle de un `sin_ubicacion` según por qué no hubo coordenada. Pura. */
export function retryNoLocationDetail(miss: RetryGeocodeMiss): string {
  // «Aprobar» en Repro Lima no tiene dónde pegar la ubicación: se pone en la
  // ficha del pedido («Corregir ubicación»), que la guarda en el pedido.
  const base =
    "El pedido no tiene coordenada y Aliclik la exige. Pon la ubicación de la clienta en la ficha del pedido («Corregir ubicación», con el enlace de Maps) y apruébalo en Repro Lima";
  switch (miss) {
    case "sin_edificio":
      return `${base}: Google no dio el edificio para esta dirección.`;
    case "sin_direccion":
      return `${base}: la dirección no trae calle para buscarla en Google.`;
    case "sin_cupo":
      return `${base}: se acabó el cupo diario de Google; se vuelve a buscar mañana.`;
    case "error":
      return `${base}: Google no respondió; se vuelve a buscar en la pasada siguiente.`;
    default:
      return `${base}.`;
  }
}

/**
 * ¿La cotización dice que falta la ubicación? Para la pasada automática, sí
 * cuando Aliclik pide la coordenada (`needsCoordinate`), y cuando el pin que
 * dio GOOGLE no lo respalda el pedido (`pinSinCorroborar`): es un punto que
 * puso Kapta, no la clienta, así que hace falta que una persona lo mire. Un pin
 * del propio pedido que no se respalda sigue siendo un fallo, como hoy.
 * Devuelve el detalle, o null si no es falta de ubicación. Pura.
 */
export function retryLocationMissing(
  preview: { ok: boolean; needsCoordinate?: boolean; pinSinCorroborar?: string },
  source: RetryCoordinateSource,
): string | null {
  if (preview.ok) return null;
  if (preview.needsCoordinate) return retryNoLocationDetail("apagado");
  if (preview.pinSinCorroborar && source === "google") {
    const why = preview.pinSinCorroborar.trim().replace(/\.$/, "");
    return `La ubicación por dirección (Google) no la respalda el pedido: ${why}. Pon la ubicación de la clienta en la ficha del pedido («Corregir ubicación») y apruébalo en Repro Lima.`;
  }
  return null;
}
