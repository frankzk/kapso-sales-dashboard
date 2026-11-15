import "server-only";

// Crear la guía de GF Courier para un pedido (MOM §29.17). Mismo esqueleto que createAliclikGuideFor
// (lib/aliclik-guide.ts), sin "use server": lo llaman la acción del Master (tras `authorize`) y el cron.
//
// Compuertas, en orden:
//   1. Dos interruptores: GF_COURIER_WRITE_ENABLED y stores.gf_courier_enabled, con token guardado.
//   2. Cualquier pedido de la tienda, sin importar su modalidad: lo que decide es la cobertura de GF, que responde
//      DISTRICT_NOT_COVERED con la lista válida. Lo ya pagado por la clienta (adelanto, diferencia o total validados)
//      se descuenta del monto a cobrar, igual que con Aliclik: un pedido pagado completo viaja con cobro cero.
//   3. Ninguna guía GF viva en el pedido.
//   4. La intención se escribe ANTES del POST; su índice único parcial impide dos intentos vivos.
//   5. Un timeout NO es un fallo: la intención queda 'pending' y el reintento usa la MISMA Idempotency-Key, así que
//      GF devuelve la misma guía. DUPLICATE_ORDER / IDEMPOTENCY_CONFLICT con tracking_id se ADOPTAN (la guía existe).
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminSupabase } from "@/lib/db";
import { env } from "@/lib/env";
import { decryptOrNull } from "@/lib/crypto";
import { gfCourier, gfIdempotencyKey, type GfOrder } from "@/lib/gf-courier";
import { buildGfOrderInput } from "@/lib/gf-courier-order";
import { GF_COURIER, GF_CREATED_VIA } from "@/lib/gf-courier-track";
import { writeCourierGuide } from "@/lib/route-output-fill";
import { categoryOf } from "@/lib/shipments";
import { recomputeOrderMasterSafe } from "@/lib/order-master";
import { wooTerritorio } from "@/lib/woo-territorio";

import { CUSTOMER_PAYMENT_KINDS } from "@/lib/pending-voucher";

export type GfGuideResult =
  | { ok: true; trackingId: string; shippingCost: number; estimatedDeliveryDate: string; adopted: boolean }
  | { ok: false; pending?: boolean; error: string; allowed?: unknown[] };

export async function loadGfStore(admin: SupabaseClient, storeId: string) {
  const { data } = await admin.from("stores").select("id,gf_courier_enabled,gf_courier_api_token_enc,gf_courier_webhook_secret_enc").eq("id", storeId).maybeSingle();
  if (!data) return null;
  return { enabled: Boolean(data.gf_courier_enabled), token: decryptOrNull(data.gf_courier_api_token_enc), webhookSecret: decryptOrNull(data.gf_courier_webhook_secret_enc) };
}

export async function createGfGuideFor(orderId: string, ctx: { userId: string | null }, admin: SupabaseClient = createAdminSupabase()): Promise<GfGuideResult> {
  if (!env.gfCourierWriteEnabled()) return { ok: false, error: "GF Courier por API está apagado (GF_COURIER_WRITE_ENABLED)." };
  const master = await admin.from("order_master").select(
    "store_id,order_id,order_name,customer_name,customer_phone,region,province,district,address,reference,latitude,longitude,order_total,dispatch_scheduled_on,shipping_mode",
  ).eq("order_id", orderId).maybeSingle();
  if (master.error || !master.data) return { ok: false, error: "No se pudo leer el pedido." };
  const row = master.data as Record<string, any>;
  const store = await loadGfStore(admin, row.store_id);
  if (!store?.enabled || !store.token) return { ok: false, error: "La tienda no tiene GF Courier habilitado o falta su token." };

  const shipments = await admin.from("shipments").select("id,delivery_status,returned_at").eq("order_id", orderId).eq("courier", GF_COURIER);
  if (shipments.error) return { ok: false, error: shipments.error.message };
  if ((shipments.data ?? []).some((s) => ["pendiente", "en_ruta"].includes(s.delivery_status) && !s.returned_at))
    return { ok: false, error: "El pedido ya tiene una guía de GF Courier viva." };

  const order = await admin.from("orders").select("name,line_items,raw").eq("id", orderId).maybeSingle();
  if (order.error || !order.data) return { ok: false, error: "No se pudo leer el pedido." };
  const payments = await admin.from("order_payments").select("amount").eq("order_id", orderId).in("kind", [...CUSTOMER_PAYMENT_KINDS]).eq("validation_status", "validado");
  const advance = (payments.data ?? []).reduce((s, p) => s + Number(p.amount ?? 0), 0);
  const sequence = (shipments.data ?? []).length + 1;
  const externalId = `${row.order_name ?? order.data.name}${sequence > 1 ? `-S${sequence}` : ""}`.slice(0, 100);
  const lines = ((order.data.line_items ?? []) as any[]).map((l) => ({ sku: l.sku ?? null, title: l.title ?? null, quantity: Number(l.quantity), price: Number(l.price) }));
  const built = buildGfOrderInput({
    externalId, customerName: row.customer_name, customerPhone: row.customer_phone, district: row.district,
    ubigeo: wooTerritorio(order.data.raw)?.code ?? null, address: row.address, reference: row.reference,
    latitude: row.latitude, longitude: row.longitude, orderTotal: Number(row.order_total), advancePaid: advance,
    scheduledFor: row.dispatch_scheduled_on && row.dispatch_scheduled_on >= new Date().toISOString().slice(0, 10) ? row.dispatch_scheduled_on : null,
    lines,
  });
  if (!built.ok) return { ok: false, error: built.reason };

  const key = gfIdempotencyKey(orderId, externalId);
  // Si ya hay una intención pendiente con esta misma clave (timeout anterior), se reintenta con ella.
  const prior = await admin.from("gf_order_requests").select("id,status").eq("idempotency_key", key).maybeSingle();
  let intentId = prior.data?.status === "pending" ? prior.data.id as string : null;
  if (!intentId) {
    const ins = await admin.from("gf_order_requests").insert({ store_id: row.store_id, order_id: orderId, external_id: externalId,
      idempotency_key: key, request: built.input, created_by: ctx.userId }).select("id").single();
    if (ins.error) return { ok: false, error: ins.error.code === "23505" ? "Ya hay una creación de guía GF en curso para este pedido." : ins.error.message };
    intentId = ins.data.id as string;
  }

  const res = await gfCourier.createOrder({ apiToken: store.token }, built.input, key);
  let gf: GfOrder | null = null, adopted = false;
  if (res.ok) { gf = res.data; adopted = Boolean(res.replayed); }
  else if (res.timedOut) {
    return { ok: false, pending: true, error: res.error.message };
  } else if (res.error.tracking_id && ["DUPLICATE_ORDER", "IDEMPOTENCY_CONFLICT"].includes(res.error.code)) {
    const existing = await gfCourier.getOrder({ apiToken: store.token }, String(res.error.tracking_id));
    if (existing.ok) { gf = existing.data; adopted = true; }
  }
  if (!gf) {
    const error = res.ok ? { code: "UNKNOWN", message: "GF no devolvió la guía." } : res.error;
    await admin.from("gf_order_requests").update({ status: "failed", http_status: res.ok ? null : res.status, error_code: error.code,
      response: res.ok ? res.data : { error }, updated_at: new Date().toISOString() }).eq("id", intentId);
    return { ok: false, error: error.message, ...(!res.ok && res.error.allowed ? { allowed: res.error.allowed } : {}) };
  }
  await admin.from("gf_order_requests").update({ status: "sent", tracking_id: gf.tracking_id, response: gf, http_status: res.ok ? 201 : 409,
    updated_at: new Date().toISOString() }).eq("id", intentId);

  const written = await writeCourierGuide(admin, orderId, {
    store_id: row.store_id, courier: GF_COURIER, guide_code: gf.tracking_id, external_order_number: gf.tracking_id,
    delivery_status: "pendiente", status_category: categoryOf("pendiente"), order_id: orderId, matched: true, match_method: "manual",
    order_name: row.order_name, customer_name: row.customer_name, customer_phone: row.customer_phone,
    district: row.district, province: row.province, region: row.region, delivery_address: row.address, delivery_reference: row.reference,
    latitude: row.latitude, longitude: row.longitude, created_via: GF_CREATED_VIA, quoted_delivery_cost: gf.shipping_cost,
    label_url: gf.label_url, assigned_at: new Date().toISOString(),
  }, { createIfMissing: true });
  if ("error" in written) return { ok: false, error: `La guía se creó en GF (${gf.tracking_id}) pero no se pudo guardar: ${written.error}` };
  await admin.from("order_events").insert({
    store_id: row.store_id, order_id: orderId, kind: "guide_registered", occurred_at: new Date().toISOString(), actor: ctx.userId,
    source: GF_COURIER, courier: GF_COURIER, guide_code: gf.tracking_id,
    payload: { shipping_cost: gf.shipping_cost, estimated_delivery_date: gf.estimated_delivery_date, external_id: externalId, adopted },
  });
  await recomputeOrderMasterSafe(admin, [orderId]);
  return { ok: true, trackingId: gf.tracking_id, shippingCost: gf.shipping_cost, estimatedDeliveryDate: gf.estimated_delivery_date, adopted };
}
