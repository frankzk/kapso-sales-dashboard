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
import { tzParts } from "@/lib/metrics";

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

/**
 * Registra la fila local de un pedido que acabamos de crear o completar en
 * Shopify SIN pisar la que ya trajo Shopify (MOM §17.3).
 *
 * POR QUÉ NO UN UPSERT. El webhook `orders/create` suele llegar antes que el
 * final de la acción: la fila ya existe con la fecha real de Shopify, los
 * productos con su id y SKU, y sus etiquetas. Un upsert la reescribía con
 * nuestra versión simplificada —hora del servidor, líneas sin id, y una
 * etiqueta `kapso` que en Shopify no existe— hasta que la siguiente pasada de
 * la sincronización la volvía a pisar con la de Shopify. La etiqueta falsa
 * duraba minutos y metía y sacaba la venta del Consolidado; los productos sin id
 * rompían la regla que cierra carritos por producto compartido. Aquí solo se
 * inserta si falta (ON CONFLICT DO NOTHING) y, si ya estaba, se devuelve su id.
 *
 * Quién cerró la venta no sale de las etiquetas: lo dice `order_sales`
 * (`recordOrderSale`), que nada sobrescribe.
 */
export async function insertOrderIfAbsent(
  admin: SupabaseClient,
  row: Record<string, unknown> & { store_id: string; shopify_order_id: string },
): Promise<{ id: string | null; error: string | null }> {
  const ins = await admin
    .from("orders")
    .upsert(row, { onConflict: "store_id,shopify_order_id", ignoreDuplicates: true })
    .select("id")
    .maybeSingle();
  if (ins.error) return { id: null, error: ins.error.message };
  const inserted = (ins.data as { id: string } | null)?.id ?? null;
  if (inserted) return { id: inserted, error: null };
  // Ya estaba (lo trajo el webhook): con DO NOTHING no vuelve fila, se busca.
  const got = await admin
    .from("orders")
    .select("id")
    .eq("store_id", row.store_id)
    .eq("shopify_order_id", row.shopify_order_id)
    .maybeSingle();
  if (got.error) return { id: null, error: got.error.message };
  const found = (got.data as { id: string } | null)?.id ?? null;
  return found ? { id: found, error: null } : { id: null, error: "el pedido no quedó registrado" };
}

/**
 * Recalcula el rollup del día LOCAL de la tienda en que ocurrió `iso`. Los
 * rollups se agrupan por día local (0212); recalcular `iso.slice(0, 10)` —el
 * día UTC— después de las 19:00 de Lima refrescaba el día siguiente y dejaba el
 * de la venta como estaba.
 */
export async function recomputeRollupsForLocalDay(admin: SupabaseClient, storeId: string, iso: string): Promise<void> {
  const { data } = await admin.from("stores").select("timezone").eq("id", storeId).maybeSingle();
  const tz = (data as { timezone: string | null } | null)?.timezone || "America/Lima";
  const day = tzParts(iso, tz).date;
  await admin.rpc("recompute_daily_rollups", { p_store_id: storeId, p_from: day, p_to: day });
}
