"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createAdminSupabase, createServerSupabase } from "@/lib/db";
import { hasOrgPermission } from "@/lib/permissions-access";
import { WOO_CANCEL_PERMISSION } from "@/lib/woo-cancel";
import { recomputeOrderMasterSafe } from "@/lib/order-master";

export async function cancelGfOutputBeforeDispatch(orderId: string, shipmentId: string, reason: string): Promise<{ error?: string; notice?: string }> {
  const clean = typeof reason === "string" ? reason.replace(/\s+/g, " ").trim() : "";
  if (clean.length < 5 || clean.length > 500) return { error: "Escribe el motivo del retiro (5 a 500 caracteres)." };
  const sb = await createServerSupabase();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) redirect("/login");
  // Sesión y RLS antes del cliente de servicio, permiso de la organización objetivo.
  const { data: row, error } = await sb.from("order_master").select("store_id").eq("order_id", orderId).maybeSingle();
  if (error || !row) return { error: "Sin acceso a este pedido." };
  const { data: store, error: storeError } = await sb.from("stores").select("org_id").eq("id", row.store_id).maybeSingle();
  if (storeError || !store?.org_id || !(await hasOrgPermission(store.org_id, WOO_CANCEL_PERMISSION)))
    return { error: "No tienes el permiso «Anular pedidos» en la organización de este pedido." };
  const admin = createAdminSupabase();
  const { error: cancelError } = await admin.rpc("gf_cancel_output_before_dispatch", {
    p_order_id: orderId, p_shipment_id: shipmentId, p_actor: user.id, p_reason: clean,
  });
  if (cancelError) return { error: cancelError.message };
  await recomputeOrderMasterSafe(admin, [orderId]);
  for (const path of ["/dashboard/pedidos", "/dashboard/pedidos/despacho", "/dashboard/pedidos/almacen", "/dashboard/courier", "/dashboard/courier/rutas", "/reparto"]) revalidatePath(path);
  return { notice: "Salida retirada y anulada. El pedido sigue vigente; ya puedes revisar «Anular pedido»." };
}
