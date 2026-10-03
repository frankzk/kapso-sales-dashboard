// Recuperación de provincia: cuando Aliclik no entregó, el PEDIDO sigue vivo.
//
// EL CASO. Aliclik anula una guía porque no pudo entregar —«no contesta»,
// «rechazado», «cancelado por el courier»— y el paquete vuelve al almacén. La
// guía sí terminó, y eso el MOM lo protege: no se falsea. Pero el pedido NO
// terminó: hay stock en provincia y una clienta a la que se puede reenviar por
// Swayp. Medido sobre 60 días: 920 pedidos así, 561 de los últimos 15 días —
// cuando el paquete sigue cerca—, 570 en ciudad con bodega Swayp. Salidas Swayp
// posteriores: 3. Llamadas registradas: 0.
//
// POR QUÉ NO PASABA. Tres decisiones encadenadas, cada una razonable sola:
//   1. la guía queda `anulado` (correcto);
//   2. «todas las guías anuladas» ⇒ el PEDIDO pasa a `anulado`, borrando la
//      diferencia entre «nos cancelaron la venta» y «el courier no pudo»;
//   3. el resolvedor manda los anulados a Por cerrar antes de mirar si merecen
//      otro intento, así que «En gestión Reproprovincia» nunca encendía.
// Y de propina: la gestión de llamadas es por GUÍA, y una guía anulada no admite
// gestión, así que tampoco se podía llamar.
//
// LA REGLA, que el MOM §11 ya decía con otras palabras: «Una guía cerrada NO
// cierra el pedido», y «lo que distingue a un pedido cerrado que merece otro
// intento no es el estado del pedido sino la etiqueta que Aliclik puso en su
// guía». Este módulo es esa regla, en un solo sitio, para que el estado del
// pedido y la macroetapa la lean igual.
//
// QUÉ ES «MERECE OTRO INTENTO». Tres cosas a la vez:
//   - la etiqueta cruda de Aliclik dice intento fallido y el paquete SALIÓ
//     (`etiquetaDiceTerminoSinEntregar`, la misma regla del chip «Por
//     recuperar» de Envíos — no se reimplementa);
//   - nadie descartó la recuperación a mano (evento `recovery_discarded`);
//   - estamos dentro de la ventana, contada desde que el courier cerró la guía
//     —no desde que el paquete volvió, porque los 207 que todavía viajan de
//     vuelta son justo los más calientes—.
//
// LO QUE NO CAMBIA. Un pedido anulado en Shopify sigue anulado: eso lo decide
// una persona y gana. El paquete que vuelve sigue siendo inventario por
// conciliar: ese motivo convive con la gestión, no la tapa.

// TANDERS EN LIMA (29-09-2026). Lo mismo le pasa a Tanders: `RETURNING` y
// `RETURNED` son «no pudo entregar», y su propio adaptador ya lo decía —«de
// vuelta en el almacén, y disponible para volver a salir con otro courier»
// (lib/tanders/status.ts)—, pero esta regla solo sabía de Aliclik. El pedido
// caía en «En curso · En retorno» mientras volvía y en «Devuelto · Por cerrar»
// al llegar (#KP135035, #KP135161), fuera de la lista de Grupo GF. Medido: 24
// volviendo y 62 ya devueltos sin anular en Shopify. Decisión del owner: entra
// desde «En retorno», sin esperar la caja, y la ventana es de 65 días.

// SWAYP (29-09-2026). Lo mismo, una tercera vez: Swayp «Devolución» (8) es su
// `RETURNING` y «Devolución confirmada» (9, y 12 con cobro) su `RETURNED`. Nunca
// había pasado por acá porque su webhook solo manda entregas y Kapta tenía las
// 147 guías vivas en el estado 1; leídas de su API, 112 resultaron devoluciones
// que el Master enseñaba «En tránsito» (#KP135009). La decisión del owner para
// Tanders aplica igual —entra desde que vuelve, sin esperar la caja—, pero con la
// ventana de la tienda: los 65 días eran por la antigüedad de Tanders. El §9.3
// ya decía qué sigue: en Lima Swayp va una sola vez, así que el reintento es de
// Grupo GF; en Reproprovincia Swayp se repite.

// CUALQUIER COURIER DE LIMA (v1.23, 30-09-2026). #AUR177276 salió con Tanders
// el 23-09 y volvió: su caja se escaneó en Devoluciones el 29-09. Pero Tanders
// no dijo `RETURNED` sino `CANCELLED`, y esa palabra quedaba fuera porque «no
// dice que saliera». La salida sí lo decía (`dispatched_at`), así que el pedido,
// vivo en Shopify, cayó en «Por cerrar · Devolución pendiente de inventario».
// Regla del owner: en Lima, lo que un courier no entrega pasa a «Por reprogramar
// Lima»; solo la entrega lleva a cerrar y solo la anulación en Shopify termina
// la venta. Así que una guía ANULADA DESPUÉS DE SALIR es un intento fallido,
// diga lo que diga el vocabulario de su courier. Lo que se anuló sin salir sigue
// siendo lo que era: una corrección, no un intento.

import { etiquetaDiceRechazoEnPuerta, etiquetaDiceTerminoSinEntregar } from "@/lib/aliclik-status";
import { RECOVERY_DEFAULT_MAX_DAYS } from "@/lib/return-recovery";
import { SWAYP_RETURN_STATES, swaypLabelSaysRejection } from "@/lib/swayp";
import { tandersStatusCode } from "@/lib/tanders/status";

/** Evento que cierra la recuperación a mano, con motivo. */
export const RECOVERY_DISCARDED_KIND = "recovery_discarded";

/** Lo mínimo que hace falta saber de una guía para decidir. */
export interface RecoveryGuideLike {
  courier: string;
  delivery_status: string;
  reported_status?: string | null;
  /** El estado crudo de Swayp (1..12): dice si su guía no entregó. */
  swayp_state?: number | null;
  /** Ancla de la ventana de Tanders y Swayp: la salida del intento fallido. */
  dispatched_at?: string | null;
  closed_at?: string | null;
  returned_at?: string | null;
  updated_at?: string | null;
}

/**
 * Días de la ventana cuando quien no entregó fue Tanders (owner, 29-09-2026).
 * Es la antigüedad de Tanders en la operación: su primera guía es del 27-07.
 */
export const TANDERS_RECOVERY_DAYS = 65;

export interface RecoveryEventLike {
  kind: string;
  occurred_at: string;
}

export interface RecoveryWindow {
  /** La guía que motiva la recuperación. */
  guide: RecoveryGuideLike;
  /** Cuándo el courier cerró la guía sin entregar. Ancla de la ventana. */
  closedAt: string;
  /** Hasta cuándo el pedido sigue en gestión. */
  deadline: string;
  /** Si ya pasó: se enseña como vencida en Por cerrar, con la razón escrita. */
  expired: boolean;
  /**
   * Si el intento que abrió la ventana terminó en un RECHAZO EN LA PUERTA.
   *
   * No cambia nada mientras la ventana está abierta: el pedido sigue en gestión,
   * porque de los reenvíos que siguieron a un rechazo un tercio se entregó
   * (4 de 12, medido el 25-09-2026). Cambia cómo se CIERRA: ver
   * `recoveryOutcome`.
   */
  doorRejection: boolean;
}

/**
 * ¿La guía de Aliclik terminó sin entregar, con el paquete ya fuera?
 *
 * Delega en `etiquetaDiceTerminoSinEntregar` a propósito: es la definición
 * única del vocabulario de Aliclik y vive junto al código que escribe esa
 * etiqueta. Tener otra lista aquí es cómo se separan en silencio.
 */
export function aliclikGuideFailedAfterDispatch(guide: RecoveryGuideLike): boolean {
  if ((guide.courier ?? "").trim().toLowerCase() !== "aliclik") return false;
  if (guide.delivery_status !== "anulado") return false;
  return etiquetaDiceTerminoSinEntregar(guide.reported_status);
}

/**
 * ¿Tanders no pudo entregar? `RETURNING` (vuelve) o `RETURNED` (volvió).
 *
 * Se lee el estado ACTUAL de Tanders y no la custodia, que solo avanza: Tanders
 * a veces pasa de `RETURNING` a `PICKED` y reintenta, y entonces la guía vuelve
 * a estar viva. `CANCELLED` solo no dice que saliera: si la guía llegó a salir,
 * lo cubre `guideAnnulledAfterDispatch`.
 */
export function tandersGuideFailed(guide: RecoveryGuideLike): boolean {
  if ((guide.courier ?? "").trim().toLowerCase() !== "tanders") return false;
  const code = tandersStatusCode(guide.reported_status);
  return code === "RETURNING" || code === "RETURNED";
}

/**
 * ¿Swayp no pudo entregar? Devolución (8), Devolución confirmada (9) o con
 * cobro (12). Se lee el estado ACTUAL: una novedad resuelta vuelve de 8 a
 * Reparto (5, «Solucionado») y la guía vuelve a estar viva, como el `PICKED` de
 * Tanders. Cancelada (10) sola no dice que saliera: si salió, la cubre
 * `guideAnnulledAfterDispatch`.
 */
export function swaypGuideFailed(guide: RecoveryGuideLike): boolean {
  const courier = (guide.courier ?? "").trim().toLowerCase();
  if (courier !== "fenix" && courier !== "swayp") return false;
  return guide.swayp_state != null && SWAYP_RETURN_STATES.has(Number(guide.swayp_state));
}

/**
 * ¿La caja de una guía de Tanders o Swayp ya está en NUESTRO almacén aunque el
 * courier la siga dando por viva? (03-10-2026)
 *
 * #AUR176862: la caja se escaneó en Devoluciones el 29-09 (`returned_at`,
 * custodia `devuelto`), y cuatro días después Tanders seguía diciendo `PICKED`.
 * Leyendo sólo al courier, la guía estaba «viva»: el pedido, vivo en Shopify,
 * quedaba en Por cerrar en vez de «Por reprogramar Lima» (v1.23). El escaneo
 * es un hecho físico y gana al estado atrasado del courier.
 *
 * Sólo Tanders y Swayp: son los que reportan su estado por API y pueden quedar
 * atrasados. Grupo GF y el motorizado propio tienen su propio «Recibir en
 * oficina», que devuelve la salida a «por asignar».
 */
export function apiGuideReceivedBack(guide: RecoveryGuideLike): boolean {
  const courier = (guide.courier ?? "").trim().toLowerCase();
  if (courier !== "tanders" && courier !== "fenix" && courier !== "swayp") return false;
  if (guide.delivery_status !== "pendiente" && guide.delivery_status !== "en_ruta") return false;
  return Boolean(guide.returned_at);
}

/**
 * La guía no entregó y su paquete todavía vuelve —o ya volvió y el courier no
 * se enteró—, así que sigue `en_ruta` sin que nadie la trabaje: el `RETURNING`
 * de Tanders, la Devolución de Swayp, o la caja ya escaneada en el almacén.
 */
function liveGuideFailed(guide: RecoveryGuideLike): boolean {
  return tandersGuideFailed(guide) || swaypGuideFailed(guide) || apiGuideReceivedBack(guide);
}

/**
 * ¿La guía terminó en un RECHAZO EN LA PUERTA? El `REFUSED` de Aliclik, o la
 * novedad 15/16 de Swayp («ya no desea el producto», «no ha comprado ningún
 * producto»), que el barrido guarda como etiqueta (`swaypLabelSaysRejection`).
 */
export function guideDoorRejection(guide: RecoveryGuideLike): boolean {
  if (etiquetaDiceRechazoEnPuerta(guide.reported_status)) return true;
  const courier = (guide.courier ?? "").trim().toLowerCase();
  return (courier === "fenix" || courier === "swayp") && swaypLabelSaysRejection(guide.reported_status);
}

/**
 * Couriers que esta regla general NO cubre: Aliclik ya tiene la suya —su
 * etiqueta dice si el intento falló o si la anulación fue de la tienda— y las
 * agencias no reparten: la clienta recoge en el terminal (§10).
 */
const OWN_RULE_OR_AGENCY = new Set(["aliclik", "shalom", "olva", "por_definir"]);

/**
 * ¿La guía se anuló DESPUÉS de salir con su courier? Es un intento fallido en
 * Lima con cualquier courier (v1.23): Tanders `CANCELLED`, Swayp Cancelada, una
 * salida de Axel o Urpi anulada con la caja ya en la calle. La prueba de que
 * salió es la de la custodia: `dispatched_at`, o que la caja ya volvió.
 */
export function guideAnnulledAfterDispatch(guide: RecoveryGuideLike): boolean {
  const courier = (guide.courier ?? "").trim().toLowerCase();
  if (!courier || OWN_RULE_OR_AGENCY.has(courier)) return false;
  if (guide.delivery_status !== "anulado") return false;
  return Boolean(guide.dispatched_at || guide.returned_at);
}

/** ¿Esta guía abre la recuperación del pedido? Cualquier courier que no entregó. */
export function guideFailedAfterDispatch(guide: RecoveryGuideLike): boolean {
  return aliclikGuideFailedAfterDispatch(guide) || liveGuideFailed(guide) || guideAnnulledAfterDispatch(guide);
}

/**
 * Cuándo el courier cerró la guía. `closed_at` es el sello correcto (el barrido de
 * Aliclik lo escribe al anular, ver `aliclik-track.ts`); las guías anteriores no lo tienen, así que se cae al
 * retorno o, en último caso, al último movimiento — nunca a «ahora», que
 * haría que un pedido viejo pareciera recién cerrado.
 */
export function guideClosedAt(guide: RecoveryGuideLike): string | null {
  return guide.closed_at ?? guide.returned_at ?? guide.updated_at ?? null;
}

/**
 * Cuándo falló el intento: el ancla de la ventana y el «desde» de la etapa.
 *
 * Aliclik lo sella al anular (`guideClosedAt`). Tanders no dice cuándo empezó a
 * volver: su barrido reescribe `updated_at` cada hora, así que la ventana nunca
 * vencería y los días en la etapa volverían a cero en cada pasada. Se ancla en la
 * SALIDA del intento fallido, que es fija y es anterior al fallo: la ventana se
 * cuenta de más, nunca de menos, y no salta al llegar la caja (`returned_at`).
 */
export function guideFailedAt(guide: RecoveryGuideLike): string | null {
  // Swayp igual: su barrido sella `swayp_synced_at` —y con él `updated_at`— en
  // cada pasada, y la Devolución confirmada llega días después de la Devolución.
  // La anulada después de salir, igual: Tanders no sella `closed_at` y su
  // barrido reescribe `updated_at`; la salida es fija.
  if (liveGuideFailed(guide) || guideAnnulledAfterDispatch(guide)) return guide.dispatched_at ?? guideClosedAt(guide);
  return guideClosedAt(guide);
}

/** Días de la ventana según quién no entregó: Tanders tiene la suya. */
export function recoveryWindowDaysFor(
  guide: RecoveryGuideLike,
  storeWindowDays: number = RECOVERY_DEFAULT_MAX_DAYS,
): number {
  const tanders = (guide.courier ?? "").trim().toLowerCase() === "tanders";
  return tanders && guideFailedAfterDispatch(guide) ? TANDERS_RECOVERY_DAYS : storeWindowDays;
}

/**
 * ¿Tiene sentido hablar de recuperación con estas guías?
 *
 * No si hay una guía VIVA —la gestión la lleva ella— ni si alguna ya ENTREGÓ:
 * ese es justo el reenvío que funcionó, y la venta terminó bien. Medido al
 * cuadrar Envíos con el Master (10-09-2026): 3 pedidos con la Aliclik anulada y
 * una Fenix entregada que Envíos listaba como «Anulado · Reproprovincia»
 * mientras el Master, con razón, los daba por entregados.
 */
function recoveryApplies(guides: readonly RecoveryGuideLike[]): boolean {
  // Una guía de Tanders o de Swayp que VUELVE sigue `en_ruta` —el paquete no ha
  // llegado—, pero ya no lleva ninguna gestión: es justo la que abre la
  // recuperación.
  return !guides.some(
    (g) =>
      g.delivery_status === "entregado" ||
      ((g.delivery_status === "pendiente" || g.delivery_status === "en_ruta") && !liveGuideFailed(g)),
  );
}

function addDays(iso: string, days: number): string {
  return new Date(Date.parse(iso) + days * 86_400_000).toISOString();
}

/**
 * La ventana de recuperación de este pedido, o null si no aplica.
 *
 * Devuelve la ventana también cuando YA VENCIÓ (`expired: true`): quien resuelve
 * la macroetapa necesita distinguir «nunca fue recuperable» de «lo fue y nadie
 * lo trabajó», porque el segundo caso se enseña con su razón.
 *
 * `windowDays` es el mismo número que la recuperación por WhatsApp
 * (`return_recovery_max_days`, 30 por defecto): dos ventanas para la misma
 * pregunta acabarían diciendo cosas distintas.
 */
export function recoveryWindow(
  guides: readonly RecoveryGuideLike[],
  events: readonly RecoveryEventLike[],
  nowIso: string,
  windowDays: number = RECOVERY_DEFAULT_MAX_DAYS,
): RecoveryWindow | null {
  if (events.some((e) => e.kind === RECOVERY_DISCARDED_KIND)) return null;
  if (!recoveryApplies(guides)) return null;
  const failed = guides.filter(guideFailedAfterDispatch);
  if (!failed.length) return null;
  // La más reciente: si hubo dos intentos con Aliclik, la ventana corre desde
  // el último cierre, no desde el primero. Y con la ventana de SU courier.
  let guide = failed[0]!;
  let closedAt = guideFailedAt(guide);
  for (const g of failed) {
    const at = guideFailedAt(g);
    if (at && (!closedAt || at > closedAt)) {
      guide = g;
      closedAt = at;
    }
  }
  if (!closedAt) return null;
  const deadline = addDays(closedAt, recoveryWindowDaysFor(guide, windowDays));
  return {
    guide,
    closedAt,
    deadline,
    expired: nowIso > deadline,
    // Decide la MISMA guía que ancla la ventana, la del último intento: si el
    // cliente primero no contestó y después lo rechazó en la puerta, lo que
    // cuenta es cómo terminó la última vez.
    doorRejection: guideDoorRejection(guide),
  };
}

/** ¿Está en gestión ahora mismo? Azúcar para los dos resolvedores. */
export function recoveryActive(
  guides: readonly RecoveryGuideLike[],
  events: readonly RecoveryEventLike[],
  nowIso: string,
  windowDays?: number,
): RecoveryWindow | null {
  const w = recoveryWindow(guides, events, nowIso, windowDays);
  return w && !w.expired ? w : null;
}

/**
 * En qué quedó la recuperación de un pedido, para ENSEÑARLO.
 *
 * Los resolvedores solo necesitan saber si está activa (`recoveryActive`).
 * Envíos necesita más: la guía anulada se lista igual, y lo que cambia es la
 * segunda mitad del badge —«Anulado · Reproprovincia», «· Recuperación
 * vencida», «· Descartada»—. Sin esa mitad, una guía viva para Swayp se ve
 * igual que una muerta, que es exactamente lo que mareaba.
 *
 * `null` es «no aplica»: no hubo intento fallido tras salir, o hay una guía
 * viva que ya lleva la gestión. En ese caso el badge se queda en una mitad.
 */
export type RecoveryKind = "activa" | "vencida" | "rechazo_no_reenviado" | "descartada";

/** Segunda mitad del badge. UN texto por estado, para Envíos y para el Master. */
export const RECOVERY_LABEL: Record<RecoveryKind, string> = {
  activa: "Reproprovincia",
  vencida: "Recuperación vencida",
  rechazo_no_reenviado: "Rechazo no reenviado",
  descartada: "Descartada",
};

/**
 * Lo que puede registrar Envíos sobre una guía anulada en recuperación.
 *
 * La guía no admite las disposiciones normales —«confirma» la reabriría y
 * «cancela» intentaría anularla otra vez—. Lo que se gestiona es el PEDIDO:
 * programar la siguiente llamada, dejar constancia de que no contestó, o
 * cerrar la recuperación porque la clienta no quiere. Reenviar por Fenix/Swayp
 * tiene su propio botón, porque crea una guía.
 */
export type RecoveryCallDisposition = "programar" | "no_contesta" | "no_quiere";

export const RECOVERY_CALL_DISPOSITIONS: { key: RecoveryCallDisposition; label: string }[] = [
  { key: "programar", label: "Programar próxima llamada" },
  { key: "no_contesta", label: "No contesta" },
  { key: "no_quiere", label: "Cliente no quiere · descartar la recuperación" },
];

export function recoveryOutcome(
  guides: readonly RecoveryGuideLike[],
  events: readonly RecoveryEventLike[],
  nowIso: string,
  windowDays?: number,
): RecoveryKind | null {
  if (!recoveryApplies(guides)) return null;
  if (!guides.some(guideFailedAfterDispatch)) return null;
  // El descarte se mira DESPUÉS de saber que era recuperable: un evento suelto
  // sobre un pedido que nunca lo fue no convierte una guía cualquiera en
  // «descartada».
  if (events.some((e) => e.kind === RECOVERY_DISCARDED_KIND)) return "descartada";
  const w = recoveryWindow(guides, events, nowIso, windowDays);
  if (!w) return null;
  if (!w.expired) return "activa";
  return expiredRecoveryKind(w);
}

/**
 * CÓMO SE LLAMA UNA VENTANA QUE VENCIÓ.
 *
 * «Recuperación vencida» se definió como «fue recuperable y nadie lo trabajó»:
 * la única forma de medir cuánto se pierde por no llamar (§11). Un rechazo en la
 * puerta no encaja en esa definición. Lo recuperable en teoría lo es, pero los
 * dos canales automáticos lo excluyen a propósito —el agente de voz
 * (`rechazo_en_puerta`, lib/voice-recovery-queue.ts) y la plantilla de WhatsApp
 * (lib/return-recovery.ts)— y la cola le dice a la vendedora «normalmente no se
 * reenvía». Que venza sin gestión es la regla funcionando, no una pérdida.
 *
 * Medido el 26-09-2026: 36 de los 483 pedidos con `recuperacion_vencida` eran
 * rechazos en la puerta, y 59 más estaban en camino, todos sin una sola llamada,
 * plantilla ni descarte. Con la misma razón, la métrica los contaba como
 * recuperaciones perdidas por no llamar.
 *
 * Un solo sitio para el nombre: el Master (`resolveMacroStage`) y Envíos
 * (`recoveryOutcome`) lo leen de acá, así que no pueden separarse.
 */
export function expiredRecoveryKind(w: RecoveryWindow): "vencida" | "rechazo_no_reenviado" {
  return w.doorRejection ? "rechazo_no_reenviado" : "vencida";
}
