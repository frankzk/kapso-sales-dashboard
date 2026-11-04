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
 *   * `incierto`         — Aliclik no respondió a tiempo: pudo haberse creado.
 *   * `sin_transporte`   — Aliclik no ofrece ese transporte: pasa a Repro Lima.
 *   * `no_seleccionable` — lo ofrece pero hoy no se puede agendar: se reintenta.
 *   * `en_curso`         — esta pasada (u otra) la está creando; o el candado lo tiene otra creación.
 *   * `tope`             — se llegó al tope del día: se reintenta mañana.
 *   * `atendiendo`       — una persona tiene el caso tomado en Repro Lima: se reintenta.
 *   * `esperando_aliclik`— Aliclik está fallando: se reintenta en la pasada siguiente.
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
] as const;
export type RetryOutcome = (typeof RETRY_OUTCOMES)[number];

/** Lo que se vuelve a intentar en la siguiente pasada del mismo día. */
export const RETRY_OUTCOMES_RETRYABLE: readonly RetryOutcome[] = ["no_seleccionable", "tope", "atendiendo", "esperando_aliclik"];

/** Lo que cuenta para el tope del día: lo creado y lo que pudo crearse. */
export const RETRY_OUTCOMES_COUNTED: readonly RetryOutcome[] = ["creada", "incierto", "en_curso"];

export const RETRY_OUTCOME_LABEL: Record<RetryOutcome, string> = {
  simulada: "Habría creado la guía",
  creada: "Guía creada",
  fallo: "No se pudo crear",
  incierto: "Aliclik no respondió: revisar",
  sin_transporte: "Sin ese transporte: pasó a Repro Lima",
  no_seleccionable: "No se puede agendar ahora",
  en_curso: "Creándose",
  tope: "Tope del día alcanzado",
  atendiendo: "Una persona lo está atendiendo",
  esperando_aliclik: "Esperando a que Aliclik responda",
};

/** Quedan guías para hoy. Pura. */
export function retryCapLeft(countedToday: number, cap: number): number {
  return Math.max(0, cap - countedToday);
}

/** El motivo de la salida adicional de Lima que lleva la guía automática. Pura. */
export function autoRetryMotive(chain: Extract<LimaRetryChain, { state: "siguiente" }>, failedText: string): string {
  return `Reintento Aliclik ${chain.attempt} de ${chain.of} automático (regla encendida en Automatizaciones). ${failedText}.`;
}
