"use server";

// «Anular pedido» de la ficha, para los pedidos de WooCommerce (MOM §38.15).
//
// Autoriza como las demás acciones del Master: el pedido se lee con el cliente
// del usuario (RLS: si no lo ve, no existe) y el permiso es el de la
// organización de SU tienda. El permiso es «Anular pedidos de WooCommerce»
// (`orders.cancel_woo`, MOM §16): owner y admin por su acceso, y quien el dueño
// marque en Equipo (26-10-2026). Lo demás —reglas, WooCommerce, la
// Actividad y la fila— está en lib/woo-cancel-server.ts.

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createAdminSupabase, createServerSupabase } from "@/lib/db";
import { hasOrgPermission } from "@/lib/permissions-access";
import { cancelWooOrderFromKapta } from "@/lib/woo-cancel-server";
import { WOO_CANCEL_DENIED, WOO_CANCEL_PERMISSION } from "@/lib/woo-cancel";

export interface WooCancelActionState {
  error?: string;
  notice?: string;
}

export async function cancelWooOrder(
  orderId: string,
  input: { reasonCode: string; reasonText: string; requestId: string },
): Promise<WooCancelActionState> {
  const sb = await createServerSupabase();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) redirect("/login");

  const { data: row, error } = await sb
    .from("order_master")
    .select("order_id,store_id")
    .eq("order_id", orderId)
    .maybeSingle();
  if (error) return { error: `No se pudo leer el pedido (${error.message}). No se anuló nada.` };
  if (!row) return { error: "Sin acceso a este pedido." };
  const storeId = (row as { store_id: string }).store_id;

  const { data: store, error: storeErr } = await sb.from("stores").select("org_id").eq("id", storeId).maybeSingle();
  const orgId = (store as { org_id?: string | null } | null)?.org_id;
  if (storeErr || !orgId || !(await hasOrgPermission(orgId, WOO_CANCEL_PERMISSION))) {
    return { error: WOO_CANCEL_DENIED };
  }

  const res = await cancelWooOrderFromKapta({
    admin: createAdminSupabase(),
    orderId,
    userId: user.id,
    reasonCode: input?.reasonCode,
    reasonText: input?.reasonText,
    requestId: input?.requestId,
  });
  revalidatePath("/dashboard/pedidos");
  return res.ok ? { notice: res.notice } : { error: res.error };
}
