// Cargar a mano la constancia de cobro de una guía Tanders (03-11-2026).
//
// EL CASO. El barrido lee la constancia que el motorizado sube a Tanders y la
// manda a «Validar pagos». Cuando Tanders no la tiene —33 pedidos entregados
// sin constancia el 03-11-2026, S/ 3.069 solo en los que Tanders no tenía
// ninguna— la imagen suele existir igual: el motorizado o la clienta la mandó
// por WhatsApp a alguien del equipo. Y en un pedido de Lima contra entrega el
// drawer no ofrece «Registrar un pago», así que no había dónde subirla.
//
// Se busca de las dos maneras en que se tiene a mano: por NUESTRO código de
// pedido (#KP124940) o por la guía de Tanders (TANDER17852702234184882). La
// imagen entra por el mismo puente que la del barrido
// (`registerCourierCollection`): huella sha256, nº de operación único y la
// alerta de comprobante repetido. La firma la sigue poniendo una persona en
// «Validar pagos».
//
// Este módulo es PURO: lo usan la acción y las pruebas.

export type CollectionQuery =
  | { kind: "guia"; guideCode: string }
  | { kind: "pedido"; orderName: string };

/**
 * Qué escribió la persona. La guía de Tanders es «TANDER» + dígitos; un pedido
 * es un prefijo de letras + dígitos, con o sin «#» y en cualquier caja
 * («kp124940», «#KP124940», «AUR174710»). Lo demás no se adivina.
 */
export function parseCollectionQuery(raw: string): CollectionQuery | null {
  const q = raw.replace(/\s+/g, "").trim();
  if (!q) return null;
  const guide = q.match(/^tander(\d{6,})$/i);
  if (guide) return { kind: "guia", guideCode: `TANDER${guide[1]}` };
  const order = q.match(/^#?([a-z]{1,6})(\d{3,})$/i);
  if (order) return { kind: "pedido", orderName: `#${order[1]!.toUpperCase()}${order[2]}` };
  return null;
}

/** Una guía Tanders candidata a recibir la constancia, ya leída de la base. */
export interface CollectionTarget {
  shipmentId: string;
  orderId: string | null;
  orderName: string | null;
  storeName: string | null;
  guideCode: string;
  deliveryStatus: string;
  /** Lo que Tanders dice de la guía («DELIVERED», «RETURNED»…). */
  reportedStatus: string | null;
  /** Lo que la guía decía que había que cobrar. */
  expectedAmount: number | null;
  /** Fecha de anulación en Shopify, si el pedido está anulado allí. */
  cancelledAt: string | null;
  /** El cobro de courier vivo que ya tiene el pedido, si lo tiene. */
  livePayment: { status: string; amount: number | null } | null;
}

export interface CollectionGate {
  /** Motivos que impiden cargarla. */
  blockers: string[];
  /** Cosas que mirar antes de cargarla. */
  warnings: string[];
  /** Pedido anulado en Shopify: hay que confirmarlo expresamente. */
  needsCancelConfirmation: boolean;
}

/**
 * Qué frena la carga y qué solo avisa.
 *
 * - Guía anulada, o pedido sin vincular: no hay cobro que registrar.
 * - El pedido ya tiene un cobro de courier vivo: está en «Validar pagos»;
 *   otro sería el mismo dinero dos veces.
 * - Tanders no la da por entregada: se avisa, no se frena. El dinero puede
 *   haber llegado antes que su reporte, y quien valida lo ve.
 * - Pedido anulado en Shopify: el barrido NO le crea ficha, porque firmar su
 *   cobro lo cierra como venta cobrada (MOM §9.4, §30.3 regla 3). Cargarla a
 *   mano es justo la decisión de una persona que esa regla pide, así que se
 *   permite, pero solo marcándolo expresamente.
 */
export function collectionGate(t: CollectionTarget): CollectionGate {
  const blockers: string[] = [];
  const warnings: string[] = [];
  if (!t.orderId) blockers.push("La guía no está vinculada a ningún pedido.");
  if (t.deliveryStatus === "anulado") blockers.push("La guía está anulada: no salió a la calle.");
  if (t.livePayment) {
    blockers.push(
      `El pedido ya tiene una constancia de cobro en «Validar pagos» (${t.livePayment.status.replace(/_/g, " ")}).`,
    );
  }
  const reported = (t.reportedStatus ?? "").trim().toUpperCase();
  if (!blockers.length && reported !== "DELIVERED") {
    warnings.push(
      reported
        ? `Tanders todavía no la da por entregada (dice «${reported}»).`
        : "Tanders todavía no informó que la entregó.",
    );
  }
  return { blockers, warnings, needsCancelConfirmation: Boolean(t.cancelledAt) && !blockers.length };
}
