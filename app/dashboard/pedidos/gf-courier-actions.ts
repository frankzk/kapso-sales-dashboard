"use server";

// Acciones del Master para GF Courier por API (MOM §29.17). Toda la lógica vive en lib/gf-courier-guide.ts (sin
// "use server"); aquí solo se autoriza: permiso propio y acceso al pedido por RLS (order_master con la sesión).
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createAdminSupabase, createServerSupabase } from "@/lib/db";
import { getMasterPermissions } from "@/lib/permissions-access";
import { env } from "@/lib/env";
import { gfCourier, gfIdempotencyKey } from "@/lib/gf-courier";
import { createGfGuideFor, loadGfStore } from "@/lib/gf-courier-guide";
import { applyGfSnapshot, GF_COURIER } from "@/lib/gf-courier-track";

const MASTER_PATH = "/dashboard/pedidos";
export interface GfPanelState {
  visible: boolean;
  canCreate: boolean;
  canCancel: boolean;
  reason?: string;
  guide?: { trackingId: string; status: string; shippingCost: number | null; labelUrl: string | null } | null;
}
export interface GfActionResult { notice?: string; error?: string; allowed?: unknown[]; pending?: boolean }

async function access(orderId: string) {
  const sb = await createServerSupabase();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) redirect("/login");
  const { data } = await sb.from("order_master").select("order_id,store_id,shipping_mode").eq("order_id", orderId).maybeSingle();
  return data ? { userId: user.id, row: data as { order_id: string; store_id: string; shipping_mode: string | null } } : null;
}

/** Lo que el panel necesita para dibujarse; no escribe nada. */
export async function gfCourierPanelState(orderId: string): Promise<GfPanelState> {
  const perms = await getMasterPermissions();
  const canCreate = perms.can("gf_courier.create_guide"), canCancel = perms.can("gf_courier.cancel_guide");
  if (!canCreate && !canCancel) return { visible: false, canCreate, canCancel };
  const ctx = await access(orderId);
  if (!ctx) return { visible: false, canCreate, canCancel };
  const admin = createAdminSupabase();
  const store = await loadGfStore(admin, ctx.row.store_id);
  const { data } = await admin.from("shipments").select("guide_code,delivery_status,quoted_delivery_cost,label_url,created_at")
    .eq("order_id", orderId).eq("courier", GF_COURIER).order("created_at", { ascending: false }).limit(1);
  const last = data?.[0];
  const guide = last ? { trackingId: last.guide_code, status: last.delivery_status, shippingCost: last.quoted_delivery_cost, labelUrl: last.label_url } : null;
  if (!store?.enabled && !guide) return { visible: false, canCreate, canCancel };
  if (ctx.row.shipping_mode !== "cod" && !guide) return { visible: false, canCreate, canCancel };
  const reason = !env.gfCourierWriteEnabled() ? "GF Courier por API está apagado en el servidor." : !store?.token ? "La tienda no tiene token de GF Courier." : undefined;
  return { visible: true, canCreate, canCancel, reason, guide };
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
  const store = await loadGfStore(admin, ctx.row.store_id);
  if (!store?.token) return { error: "La tienda no tiene token de GF Courier." };
  const { data } = await admin.from("shipments").select("id,guide_code").eq("order_id", orderId).eq("courier", GF_COURIER)
    .in("delivery_status", ["pendiente", "en_ruta"]).limit(1);
  const live = data?.[0];
  if (!live?.guide_code) return { error: "El pedido no tiene una guía de GF Courier viva." };
  const res = await gfCourier.cancelOrder({ apiToken: store.token }, live.guide_code, "MERCHANT_CANCELLED", gfIdempotencyKey(orderId, `cancel-${live.guide_code}`), why);
  if (!res.ok) return { error: res.error.message };
  const current = await gfCourier.getOrder({ apiToken: store.token }, live.guide_code);
  if (current.ok) await applyGfSnapshot(current.data, admin);
  await admin.from("order_events").insert({ store_id: ctx.row.store_id, order_id: orderId, kind: "courier_status", occurred_at: new Date().toISOString(),
    actor: ctx.userId, source: GF_COURIER, courier: GF_COURIER, guide_code: live.guide_code, reason: why, note: "Guía de GF Courier anulada desde Kapta." });
  revalidatePath(MASTER_PATH);
  return { notice: `Guía ${live.guide_code} anulada en GF Courier, sin costo.` };
}
