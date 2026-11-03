// Cuándo una guía de Aliclik ya cerrada suelta el candado de creación (MOM
// §10.2, «Una guía anulada suelta el candado», 03-11-2026). Pura + testeada.
//
// EL CANDADO (0056). Cada creación deja su intención en
// `aliclik_order_requests` ANTES del POST, y un único parcial impide dos
// intenciones vivas por pedido. Se pensó para el doble clic, dos operadoras o
// un reintento tras timeout: todos son la MISMA guía creada dos veces.
//
// EL AGUJERO. Una intención `sent` se quedaba viva para siempre, aunque su guía
// hubiera terminado: Aliclik no entregó, el paquete volvió y la guía quedó
// anulada. El pedido ya no podía salir otra vez por Aliclik, y eso es justo lo
// que piden la cadena de reintentos (AUTOECOM → ALIDRIVER, §9.5) y «después de
// AUTOECOM, ALIDRIVER» (§9). Pasó con #KP200108: guía AUTOECOM
// AUR5X510805505383 anulada el 02-11, y «Aprobar · ALIDRIVER» chocó con
// «Este pedido ya tiene una guía en Aliclik».
//
// LA REGLA. Una intención `sent` o `duplicate` se suelta (`released_at`) solo si
// su guía está en las salidas del pedido —por el número que devolvió Aliclik— y
// TODAS las salidas con ese número están anuladas o transferidas. Es la misma
// línea que ya usa la regla de salidas (`aliclikOutputPolicy`): una guía de
// Aliclik anulada o transferida no estorba; cualquier otra, sí.
//
// LO QUE NO SUELTA, porque soltar de más duplica una escritura irreversible:
//   * `pending`: Aliclik pudo haberla creado (timeout). La resuelven el barrido
//     y la caducidad de huérfanas (`aliclik-orphan-expiry.ts`).
//   * una intención sin número, o cuyo número no aparece en las salidas: no hay
//     forma de saber cómo terminó su guía.
//   * una guía viva, devuelta sin anular, entregada o por definir.
//
// Soltar no borra nada: la fila sigue `sent`, con su número, su cuerpo y su
// respuesta, y la salud de Aliclik la sigue contando como un éxito.

/** Los estados de una guía de Aliclik que ya no es una salida viva. */
export const RELEASABLE_GUIDE_STATUSES = ["anulado", "transferido"] as const;

export interface CreationIntent {
  id: string;
  status: string;
  order_number: string | null;
  released_at?: string | null;
}

export interface IntentGuide {
  courier: string | null;
  guide_code: string | null;
  external_order_number?: string | null;
  delivery_status: string | null;
}

function guideNumber(value: string | null | undefined): string {
  return (value ?? "").trim().replace(/^#+/, "").replace(/\s+/g, "").toUpperCase();
}

/** Por qué se suelta, para el historial de la intención. */
export function releaseReason(orderNumber: string, status: string): string {
  return `La guía ${orderNumber} quedó ${status} en Aliclik: ya no es una salida viva y el pedido puede volver a salir por Aliclik.`;
}

/**
 * Qué intenciones vivas de un pedido se pueden soltar, con su motivo. Pura.
 * `guides` son las salidas del pedido (`shipments`).
 */
export function releasableIntents(
  intents: readonly CreationIntent[],
  guides: readonly IntentGuide[],
): { release: { id: string; reason: string }[]; held: CreationIntent[] } {
  const release: { id: string; reason: string }[] = [];
  const held: CreationIntent[] = [];
  for (const intent of intents) {
    if (intent.released_at || intent.status === "failed") continue;
    const number = guideNumber(intent.order_number);
    if ((intent.status !== "sent" && intent.status !== "duplicate") || !number) {
      held.push(intent);
      continue;
    }
    const matching = guides.filter(
      (g) =>
        (g.courier ?? "").trim().toLowerCase() === "aliclik" &&
        (guideNumber(g.guide_code) === number || guideNumber(g.external_order_number) === number),
    );
    const closed = matching.length > 0 && matching.every((g) =>
      (RELEASABLE_GUIDE_STATUSES as readonly string[]).includes(g.delivery_status ?? ""),
    );
    if (!closed) {
      held.push(intent);
      continue;
    }
    release.push({ id: intent.id, reason: releaseReason((intent.order_number ?? "").trim(), matching[0]?.delivery_status ?? "anulado") });
  }
  return { release, held };
}
