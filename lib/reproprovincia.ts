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

import { etiquetaDiceTerminoSinEntregar } from "@/lib/aliclik-status";
import { RECOVERY_DEFAULT_MAX_DAYS } from "@/lib/return-recovery";

/** Evento que cierra la recuperación a mano, con motivo. */
export const RECOVERY_DISCARDED_KIND = "recovery_discarded";

/** Lo mínimo que hace falta saber de una guía para decidir. */
export interface RecoveryGuideLike {
  courier: string;
  delivery_status: string;
  reported_status?: string | null;
  closed_at?: string | null;
  returned_at?: string | null;
  updated_at?: string | null;
}

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
 * Cuándo el courier cerró la guía. `closed_at` es el sello correcto (el barrido de
 * Aliclik lo escribe al anular, ver `aliclik-track.ts`); las guías anteriores no lo tienen, así que se cae al
 * retorno o, en último caso, al último movimiento — nunca a «ahora», que
 * haría que un pedido viejo pareciera recién cerrado.
 */
export function guideClosedAt(guide: RecoveryGuideLike): string | null {
  return guide.closed_at ?? guide.returned_at ?? guide.updated_at ?? null;
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
  // Si hay alguna guía VIVA, la gestión la lleva ella: esto es solo para cuando
  // todas las de verdad ya terminaron.
  if (guides.some((g) => g.delivery_status === "pendiente" || g.delivery_status === "en_ruta")) {
    return null;
  }
  const failed = guides.filter(aliclikGuideFailedAfterDispatch);
  if (!failed.length) return null;
  // La más reciente: si hubo dos intentos con Aliclik, la ventana corre desde
  // el último cierre, no desde el primero.
  let guide = failed[0]!;
  let closedAt = guideClosedAt(guide);
  for (const g of failed) {
    const at = guideClosedAt(g);
    if (at && (!closedAt || at > closedAt)) {
      guide = g;
      closedAt = at;
    }
  }
  if (!closedAt) return null;
  const deadline = addDays(closedAt, windowDays);
  return { guide, closedAt, deadline, expired: nowIso > deadline };
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
export type RecoveryKind = "activa" | "vencida" | "descartada";

/** Segunda mitad del badge. UN texto por estado, para Envíos y para el Master. */
export const RECOVERY_LABEL: Record<RecoveryKind, string> = {
  activa: "Reproprovincia",
  vencida: "Recuperación vencida",
  descartada: "Descartada",
};

export function recoveryOutcome(
  guides: readonly RecoveryGuideLike[],
  events: readonly RecoveryEventLike[],
  nowIso: string,
  windowDays?: number,
): RecoveryKind | null {
  if (guides.some((g) => g.delivery_status === "pendiente" || g.delivery_status === "en_ruta")) {
    return null;
  }
  if (!guides.some(aliclikGuideFailedAfterDispatch)) return null;
  // El descarte se mira DESPUÉS de saber que era recuperable: un evento suelto
  // sobre un pedido que nunca lo fue no convierte una guía cualquiera en
  // «descartada».
  if (events.some((e) => e.kind === RECOVERY_DISCARDED_KIND)) return "descartada";
  const w = recoveryWindow(guides, events, nowIso, windowDays);
  if (!w) return null;
  return w.expired ? "vencida" : "activa";
}
