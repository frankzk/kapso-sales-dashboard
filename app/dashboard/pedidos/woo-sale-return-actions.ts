"use server";
import { revalidatePath } from "next/cache";
import { createAdminSupabase, createServerSupabase } from "@/lib/db";
import { hasOrgPermission } from "@/lib/permissions-access";
import { WOO_CANCEL_PERMISSION } from "@/lib/woo-cancel";
import { cancelHistoricalShopifySale } from "@/lib/legacy-sale-cancel-server";

export async function endWooSalePendingReturn(orderId: string, input: { reasonCode: string; reasonText: string; requestId: string }) {
  const sb = await createServerSupabase();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return { error: "Inicia sesión antes de terminar la venta." };
  const { data: order, error } = await sb.from("order_master").select("store_id").eq("order_id", orderId).maybeSingle();
  if (error || !order) return { error: "Sin acceso al pedido." };
  const { data: store, error: storeError } = await sb.from("stores").select("org_id").eq("id", order.store_id).maybeSingle();
  if (storeError || !store?.org_id || !(await hasOrgPermission(store.org_id, WOO_CANCEL_PERMISSION))) return { error: "No tienes el permiso «Anular pedidos» en esta organización." };
  const result = await cancelHistoricalShopifySale({ admin: createAdminSupabase(), orderId, userId: user.id,
    reasonCode:input?.reasonCode,reasonText:input?.reasonText,requestId:input?.requestId,wooReturn: true });
  for (const path of ["/dashboard/pedidos", "/dashboard/pedidos/despacho", "/dashboard/courier"]) revalidatePath(path);
  return result;
}
