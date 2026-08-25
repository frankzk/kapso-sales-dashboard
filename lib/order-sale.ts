// Registrar de quién es una venta, en el instante en que ocurre.
//
// POR QUÉ VIVE ACÁ Y NO REPETIDO EN CADA ACCIÓN. Hay TRES caminos por los que
// una asesora genera un pedido —venta por llamada, carrito recuperado y venta
// nueva desde el drawer— y los tres tienen que dejar el mismo rastro. Repartir
// el insert entre los tres es cómo se acaba con uno que se olvidó: esa venta no
// tendría dueña y nadie se enteraría hasta que alguien reclamara su comisión.
//
// Es el mismo problema que ya nos costó dos arreglos esta semana: una regla con
// varias implementaciones acaba divergiendo. Una definición, tres llamadas.

import type { SupabaseClient } from "@supabase/supabase-js";

export interface OrderSaleInput {
  /** `orders.id` NUESTRO, no el de Shopify. Los tres sitios ya lo tienen. */
  orderId: string;
  storeId: string;
  /** La asesora que apretó el botón (`ctx.userId`). */
  vendedora: string;
  leadId: string;
  /** ISO. El instante de la venta, no el de la ingesta del pedido. */
  occurredAt: string;
}

/**
 * Deja la fila que fija la atribución del cierre.
 *
 * NO REVIENTA LA VENTA SI FALLA, y es una decisión deliberada. Cuando esto
 * corre, el pedido YA existe en Shopify y ya se le confirmó a la clienta:
 * abortar acá no desharía nada, solo dejaría a la asesora con un error rojo
 * delante de una venta que sí se hizo.
 *
 * Y no se pierde en silencio, que es la otra mitad de la decisión: la fila
 * `sale` de `lead_calls` se escribe igual, así que el backfill de la 0132
 * —mismo emparejamiento por teléfono y ventana de ±2 min— la recupera después.
 * Hay una vía de recuperación real, no un encogimiento de hombros.
 *
 * Un choque de PK tampoco es error: significa que el pedido ya tiene dueña, y
 * la primera gana por diseño (la tabla es append-only).
 */
export async function recordOrderSale(
  admin: SupabaseClient,
  input: OrderSaleInput,
): Promise<void> {
  const { error } = await admin.from("order_sales").insert({
    order_id: input.orderId,
    store_id: input.storeId,
    vendedora: input.vendedora,
    lead_id: input.leadId,
    occurred_at: input.occurredAt,
    source: "sale_action",
  });
  // 23505 = unique_violation: ya estaba registrada. No es un fallo.
  if (error && error.code !== "23505") {
    console.error(
      `recordOrderSale: no se pudo fijar la atribución del pedido ${input.orderId}: ${error.message}`,
    );
  }
}
