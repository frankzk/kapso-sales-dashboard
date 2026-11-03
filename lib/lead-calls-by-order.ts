// A qué pedido pertenece cada gestión del lead (MOM §25, 16-10-2026).
//
// POR QUÉ. Un cliente tiene UN lead por tienda, y el lead apunta a su ÚLTIMO
// pedido (`leads.order_id`): cada venta nueva —de la asesora, del chatbot, de la
// recompra— lo vuelve a apuntar. La Actividad del pedido leía todo el historial
// de los leads que apuntan a él, así que el pedido nuevo heredaba el ciclo
// entero del anterior —«Venta cerrada», «Guía de Aliclik creada · pedido
// #KP134581»— y el anterior se quedaba sin el suyo. Fue #KP141951 (16-10-2026):
// mostraba la guía de #KP134581 de septiembre como si fuera suya. Medido ese
// día: 155 pedidos así.
//
// LA REGLA. Cada gestión pertenece a UN pedido del cliente:
//   1. si su nota nombra un pedido del cliente («pedido #KP134581»), a ese;
//   2. si no, al primer pedido creado después de ella —con unos minutos de
//      margen, porque la nota de la venta se escribe segundos después de que
//      Shopify crea el pedido—: el trabajo de venta es de la venta que cerró;
//   3. lo que pasó después del último pedido, a ese último.
// Con un solo pedido, todo es suyo: nada cambia para el cliente de una compra.
//
// EL TOPE DE LA REGLA 2 (24-10-2026). Una gestión de MÁS de 14 días antes del
// pedido que le tocaría no es de ningún pedido: es un interés anterior que no
// compró, y se queda solo en Leads. Fue #AUR900004 (24-10-2026, prueba del
// owner): su número tenía dos «Handoff resuelto» de septiembre, de cuando probó
// el bot, y sin otro pedido anterior la regla 2 los ponía en la Actividad del
// pedido de octubre. Medido ese día en los pedidos de Shopify de 30 días: 63 %
// de esas gestiones son de los 7 días previos y 30 % de hace más de 14.
//
// Pura.

/** El margen de la regla 2: la nota «Venta cerrada» llega segundos después del pedido. */
export const LEAD_CALL_GRACE_MS = 10 * 60_000;

/** El tope de la regla 2: una gestión de más de 14 días antes del pedido no es suya. */
export const LEAD_CALL_MAX_BEFORE_MS = 14 * 24 * 60 * 60_000;

/** Una gestión que no es de ningún pedido del cliente (anterior al tope): solo en Leads. */
export const LEAD_CALL_NO_ORDER = "sin-pedido";

export interface CustomerOrderRef {
  order_id: string;
  order_name: string | null;
  order_created_at: string | null;
}

type CallLike = { note: string | null; occurred_at: string | null };

const ORDER_NAME = /#[A-Z]{2,6}\d{3,}/gi;

/**
 * El pedido del cliente al que pertenece una gestión; `LEAD_CALL_NO_ORDER` si
 * es de más de 14 días antes del pedido que le tocaría; null si no hay pedidos
 * con fecha.
 */
export function leadCallOrderId(call: CallLike, orders: readonly CustomerOrderRef[]): string | null {
  const byName = new Map(
    orders
      .filter((o) => o.order_name)
      .map((o) => [o.order_name!.trim().toUpperCase(), o.order_id] as const),
  );
  for (const match of (call.note ?? "").matchAll(ORDER_NAME)) {
    const id = byName.get(match[0].toUpperCase());
    if (id) return id;
  }

  const dated = orders
    .map((o) => ({ id: o.order_id, at: Date.parse(o.order_created_at ?? "") }))
    .filter((o) => Number.isFinite(o.at))
    .sort((a, b) => a.at - b.at);
  if (!dated.length) return null;
  const at = Date.parse(call.occurred_at ?? "");
  if (!Number.isFinite(at)) return dated[dated.length - 1]!.id;
  const next = dated.find((o) => o.at >= at - LEAD_CALL_GRACE_MS);
  if (!next) return dated[dated.length - 1]!.id;
  return next.at - at > LEAD_CALL_MAX_BEFORE_MS ? LEAD_CALL_NO_ORDER : next.id;
}

/** Las gestiones que pertenecen a este pedido. Sin pedidos con fecha, todas (como antes). */
export function leadCallsForOrder<T extends CallLike>(
  calls: readonly T[],
  orders: readonly CustomerOrderRef[],
  orderId: string,
): T[] {
  return calls.filter((call) => {
    const owner = leadCallOrderId(call, orders);
    return owner === null || owner === orderId;
  });
}
