"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createAdminSupabase, createServerSupabase } from "@/lib/db";
import { hasOrgPermission } from "@/lib/permissions-access";
import { WOO_CANCEL_PERMISSION } from "@/lib/woo-cancel";
import { cancelHistoricalShopifySale } from "@/lib/legacy-sale-cancel-server";

export async function cancelLegacyShopifySale(orderId: string,
  input: { reasonCode: string; reasonText: string; requestId: string },
): Promise<{ error?: string; notice?: string }> {
  const sb = await createServerSupabase();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) redirect("/login");
  // Siempre sesión + RLS ANTES del cliente de servicio.
  const { data: row, error } = await sb.from("order_master").select("store_id").eq("order_id", orderId).maybeSingle();
  if (error || !row) return { error: "Sin acceso a este pedido." };
  const { data: store, error: storeError } = await sb.from("stores").select("org_id").eq("id", row.store_id).maybeSingle();
  if (storeError || !store?.org_id || !(await hasOrgPermission(store.org_id, WOO_CANCEL_PERMISSION)))
    return { error: "No tienes el permiso «Anular pedidos» en la organización de este pedido." };
  const result = await cancelHistoricalShopifySale({
    admin: createAdminSupabase(), orderId, userId: user.id,
    reasonCode: input?.reasonCode, reasonText: input?.reasonText, requestId: input?.requestId,
  });
  revalidatePath("/dashboard/pedidos");
  revalidatePath("/dashboard/pedidos/despacho");
  revalidatePath("/dashboard/pedidos/almacen");
  revalidatePath("/dashboard/courier");
  return result;
}
