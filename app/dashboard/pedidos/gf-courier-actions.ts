"use server";

// Acciones del Master para GF Courier por API (MOM §29.17). Toda la lógica vive en lib/gf-courier-guide.ts (sin
// "use server"); aquí solo se autoriza: permiso propio y acceso al pedido por RLS (order_master con la sesión).
// Las llama la tarjeta «GF Courier» de la Mesa de ruta (components/order-route-desk.tsx); cuándo se ofrece lo decide
// el plan de rutas (lib/order-route-plan.ts), no un panel aparte.
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createAdminSupabase, createServerSupabase } from "@/lib/db";
import { getMasterPermissions } from "@/lib/permissions-access";
import { cancelGfGuideFor, createGfGuideFor } from "@/lib/gf-courier-guide";
import { GF_COURIER } from "@/lib/gf-courier-track";
import { gfCancelRequested, gfCancelRequestedText } from "@/lib/gf-courier-status";

const MASTER_PATH = "/dashboard/pedidos";
export interface GfActionResult { notice?: string; error?: string; allowed?: unknown[]; pending?: boolean }

async function access(orderId: string) {
  const sb = await createServerSupabase();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) redirect("/login");
  const { data } = await sb.from("order_master").select("order_id,store_id,shipping_mode").eq("order_id", orderId).maybeSingle();
  return data ? { userId: user.id, row: data as { order_id: string; store_id: string; shipping_mode: string | null } } : null;
}

export async function createGfCourierGuide(orderId: string): Promise<GfActionResult> {
  const perms = await getMasterPermissions();
  if (!perms.can("gf_courier.create_guide")) return { error: "Tu rol no permite crear guías de GF Courier." };
  const ctx = await access(orderId);
  if (!ctx) return { error: "Sin acceso a este pedido." };
  const result = await createGfGuideFor(orderId, { userId: ctx.userId });
  revalidatePath(MASTER_PATH);
  if (!result.ok) return { error: result.error, ...(result.allowed ? { allowed: result.allowed } : {}), ...(result.pending ? { pending: true } : {}) };
  return { notice: `${result.adopted ? "Guía existente vinculada" : "Guía creada"} en GF Courier: ${result.trackingId} · envío S/ ${result.shippingCost.toFixed(2)} · entrega estimada ${result.estimatedDeliveryDate}.` };
}

/** Anula la guía GF viva (GF solo lo permite antes de la preparación, sin costo) y aplica el estado devuelto. */
export async function cancelGfCourierGuide(orderId: string, reason: string): Promise<GfActionResult> {
  const perms = await getMasterPermissions();
  if (!perms.can("gf_courier.cancel_guide")) return { error: "Tu rol no permite anular guías de GF Courier." };
  const ctx = await access(orderId);
  if (!ctx) return { error: "Sin acceso a este pedido." };
  const why = reason.trim();
  if (why.length < 5) return { error: "Escribe el motivo de la anulación." };
  const admin = createAdminSupabase();
  const { data } = await admin.from("shipments").select("id,guide_code,reported_status").eq("order_id", orderId).eq("courier", GF_COURIER)
    .in("delivery_status", ["pendiente", "en_ruta"]).limit(1);
  const live = data?.[0] as { id: string; guide_code: string | null; reported_status: string | null } | undefined;
  if (!live?.guide_code) return { error: "El pedido no tiene una guía de GF Courier viva." };
  // Ya pedida: otra vez no la acelera, solo repite el pedido en GF.
  if (gfCancelRequested(live.reported_status)) return { notice: `Ya pediste anular ${live.guide_code}. ${gfCancelRequestedText(live.guide_code)}`, pending: true };
  const res = await cancelGfGuideFor(orderId, live.guide_code, { userId: ctx.userId, reason: why, note: "Guía de GF Courier anulada desde Kapta." }, admin);
  if (!res.ok) return { error: res.error };
  revalidatePath(MASTER_PATH);
  const cost = res.cancelCost > 0 ? ` Costo de anular: S/ ${res.cancelCost.toFixed(2)}.` : "";
  if (res.requested) return { notice: `${gfCancelRequestedText(res.trackingId)}${cost}`, pending: true };
  return { notice: `Guía ${res.trackingId} anulada en GF Courier${res.cancelCost > 0 ? ` (costo de anular S/ ${res.cancelCost.toFixed(2)})` : ", sin costo"}.` };
}
