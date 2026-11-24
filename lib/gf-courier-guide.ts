import "server-only";

// Crear la guía de GF Courier para un pedido (MOM §29.17). Mismo esqueleto que createAliclikGuideFor
// (lib/aliclik-guide.ts), sin "use server": lo llaman la acción del Master (tras `authorize`) y el cron.
//
// Compuertas, en orden:
//   1. Dos interruptores: GF_COURIER_WRITE_ENABLED y stores.gf_courier_enabled, con token guardado.
//   2. Cualquier pedido de la tienda, sin importar su modalidad: lo que decide es la cobertura de GF, que responde
//      DISTRICT_NOT_COVERED con la lista válida. Lo ya pagado por la clienta (adelanto, diferencia o total validados)
//      se descuenta del monto a cobrar, igual que con Aliclik: un pedido pagado completo viaja con cobro cero.
//   3. Ninguna guía GF viva en el pedido, ni una salida activa de otro courier (owner, 23-11-2026, #KP207468:
//      `otherCourierBlocksGf`, lib/gf-other-courier.ts).
//   4. La intención se escribe ANTES del POST; su índice único parcial impide dos intentos vivos.
//   5. Un timeout NO es un fallo: la intención queda 'pending' y el reintento usa la MISMA Idempotency-Key, así que
//      GF devuelve la misma guía. DUPLICATE_ORDER / IDEMPOTENCY_CONFLICT con tracking_id se ADOPTAN (la guía existe).
import { otherCourierBlocksGf } from "@/lib/gf-other-courier";
import { salidaActiva, type SalidaExistente } from "@/lib/shipment-output";
import { SALIDA_ACTIVA_COLUMNS, withLastCourierChange } from "@/lib/salida-activa-server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminSupabase } from "@/lib/db";
import { env } from "@/lib/env";
import { decryptOrNull } from "@/lib/crypto";
import { gfCourier, gfIdempotencyKey, type GfOrder } from "@/lib/gf-courier";
import { gfCancelBlockedByRider, liveGfGuides } from "@/lib/gf-courier-status";
import { buildGfOrderInput, gfGuideConfirmed, gfNotesInSync, gfOrderNote } from "@/lib/gf-courier-order";
import { isWebPrepaid } from "@/lib/order-paid";
import { applyGfSnapshot, GF_COURIER, GF_CREATED_VIA } from "@/lib/gf-courier-track";
import { gfCancelRequestedText } from "@/lib/gf-courier-status";
import { writeCourierGuide } from "@/lib/route-output-fill";
import { categoryOf, limaTodayKey } from "@/lib/shipments";
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

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Día acordado en Repro Lima con GF Courier (owner, 16-11-2026: «ella lo quiere para el 18»). Al guardar el acuerdo,
 * Kapta quita la salida programada de Grupo GF; si la guía no se creó en ese momento, la Mesa de ruta (o la guía
 * automática) la crea después para el día del acuerdo, no para el siguiente día de reparto. Solo un caso abierto, con
 * GF Courier y un día que no pasó.
 */
export async function reproAgreedGfDay(admin: SupabaseClient, orderId: string): Promise<string | null> {
  const today = limaTodayKey();
  const { data } = await admin.from("lima_repro_cases").select("agreed_on,agreed_courier")
    .eq("order_id", orderId).is("closed_at", null).eq("agreed_courier", "gf_courier").not("agreed_on", "is", null)
    .order("agreed_on", { ascending: false }).limit(1);
  const day = (data?.[0]?.agreed_on as string | undefined)?.slice(0, 10) ?? null;
  return day && DAY_RE.test(day) && day >= today ? day : null;
}

export async function createGfGuideFor(
  orderId: string,
  /**
   * `reason`: lo que dice el hecho `guide_registered`; la guía automática dice que lo es.
   * `scheduledFor` (YYYY-MM-DD de Lima): el día que se le pide a GF (`scheduled_date`). Manda sobre el «Programar
   * envío» del pedido (`dispatch_scheduled_on`): Repro Lima crea la guía para el día acordado con la clienta
   * (owner, 15-11-2026; MOM §9.5). Un día que ya pasó no se manda.
   */
  ctx: { userId: string | null; reason?: string | null; scheduledFor?: string | null },
  admin: SupabaseClient = createAdminSupabase(),
): Promise<GfGuideResult> {
  if (!env.gfCourierWriteEnabled()) return { ok: false, error: "GF Courier por API está apagado (GF_COURIER_WRITE_ENABLED)." };
  const scheduledFor = ctx.scheduledFor?.trim() || null;
  if (scheduledFor && (!DAY_RE.test(scheduledFor) || scheduledFor < limaTodayKey())) {
    return { ok: false, error: "El día pedido para la guía de GF Courier no es válido o ya pasó." };
  }
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
  // Con una salida activa de otro courier no se crea la de GF (owner, 23-11-2026, #KP207468): salían las dos.
  const others = await admin.from("shipments").select(`courier,guide_code,delivery_status,${SALIDA_ACTIVA_COLUMNS}`).eq("order_id", orderId).neq("courier", GF_COURIER);
  if (others.error) return { ok: false, error: others.error.message };
  const otherBlock = otherCourierBlocksGf(await withLastCourierChange(admin, orderId, (others.data ?? []) as any[]));
  if (otherBlock) return { ok: false, error: otherBlock };

  const order = await admin.from("orders").select("name,line_items,raw,financial_status,payment_gateway,total_refunded").eq("id", orderId).maybeSingle();
  if (order.error || !order.data) return { ok: false, error: "No se pudo leer el pedido." };
  const payments = await admin.from("order_payments").select("amount").eq("order_id", orderId).in("kind", [...CUSTOMER_PAYMENT_KINDS]).eq("validation_status", "validado");
  const advance = (payments.data ?? []).reduce((s, p) => s + Number(p.amount ?? 0), 0);
  const sequence = (shipments.data ?? []).length + 1;
  const externalId = `${row.order_name ?? order.data.name}${sequence > 1 ? `-S${sequence}` : ""}`.slice(0, 100);
  const lines = ((order.data.line_items ?? []) as any[]).map((l) => ({ sku: l.sku ?? null, title: l.title ?? null, quantity: Number(l.quantity), price: Number(l.price) }));
  const day = scheduledFor ?? (row.dispatch_scheduled_on && row.dispatch_scheduled_on >= new Date().toISOString().slice(0, 10) ? row.dispatch_scheduled_on : null)
    ?? await reproAgreedGfDay(admin, orderId);
  const built = buildGfOrderInput({
    externalId, customerName: row.customer_name, customerPhone: row.customer_phone, district: row.district,
    ubigeo: wooTerritorio(order.data.raw)?.code ?? null, address: row.address, reference: row.reference,
    latitude: row.latitude, longitude: row.longitude, orderTotal: Number(row.order_total), advancePaid: advance,
    webPrepaid: isWebPrepaid({ financialStatus: order.data.financial_status, totalRefunded: Number(order.data.total_refunded ?? 0), paymentGateway: order.data.payment_gateway }),
    scheduledFor: day,
    // «Confirmado» en GF: la creó una persona o tiene un día acordado (owner, 20-11-2026).
    confirmed: gfGuideConfirmed({ actor: ctx.userId, scheduledDate: day }),
    // La nota del pedido sale en el rótulo de GF (owner, 20-11-2026).
    observations: gfOrderNote(order.data.raw),
    lines,
  });
  if (!built.ok) return { ok: false, error: built.reason };

  const key = gfIdempotencyKey(orderId, externalId);
  // Si ya hay una intención con esta misma clave, se reintenta con ella: pendiente (timeout anterior) o fallida (GF la
  // rechazó, p. ej. sin cobertura, y ya se corrigió). Un rechazo de GF no queda guardado en su idempotencia, así que la
  // misma clave vuelve a evaluarse. Antes, un intento fallido bloqueaba el reintento con «creación en curso».
  const prior = await admin.from("gf_order_requests").select("id,status").eq("idempotency_key", key).maybeSingle();
  let intentId = prior.data && ["pending", "failed"].includes(prior.data.status) ? prior.data.id as string : null;
  if (intentId && prior.data?.status === "failed") {
    const reset = await admin.from("gf_order_requests").update({ status: "pending", request: built.input, http_status: null, error_code: null,
      response: null, created_by: ctx.userId, updated_at: new Date().toISOString() }).eq("id", intentId).eq("status", "failed").select("id");
    if (reset.error) return { ok: false, error: reset.error.code === "23505" ? "Ya hay una creación de guía GF en curso para este pedido." : reset.error.message };
    if (!reset.data?.length) return { ok: false, error: "Ya hay una creación de guía GF en curso para este pedido." };
  }
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
    source: GF_COURIER, courier: GF_COURIER, guide_code: gf.tracking_id, ...(ctx.reason ? { reason: ctx.reason } : {}),
    payload: { shipping_cost: gf.shipping_cost, estimated_delivery_date: gf.estimated_delivery_date, external_id: externalId, adopted,
      ...(built.input.scheduled_date ? { scheduled_date: built.input.scheduled_date } : {}) },
  });
  await recomputeOrderMasterSafe(admin, [orderId]);
  return { ok: true, trackingId: gf.tracking_id, shippingCost: gf.shipping_cost, estimatedDeliveryDate: gf.estimated_delivery_date, adopted };
}

/**
 * `requested`: GF recibió la anulación pero no la confirmó (CANCEL_REQUESTED: ya había preparado el paquete). La guía
 * sigue viva hasta que GF la anule; quien llama no puede tratarla como anulada (17-11-2026, #AUR901039).
 */
export type GfCancelResult =
  | { ok: true; trackingId: string; cancelCost: number; requested: boolean }
  | { ok: false; error: string };

/**
 * Anula UNA guía GF viva y aplica el estado que GF devuelve (MOM §29.17). La usan «Anular guía» de la Mesa de ruta y
 * la creación de la guía de Aliclik, que anula sola la de GF cuando una persona decide mandar el pedido por Aliclik
 * (owner, 15-11-2026). GF decide si todavía se puede: sin costo antes de preparar; después responde con el estado o
 * con el costo de anular. Lo que GF responda se devuelve tal cual.
 */
export type GfDateResult = { ok: true; trackingId: string; newDate: string } | { ok: false; error: string; code?: string };

/**
 * Cambia el día de una guía GF viva que todavía no tiene motorizado (owner, 17-11-2026): la caja sigue armada con la
 * misma guía, sin anular ni volver a crear. GF responde ASSIGNED_TO_RIDER si ya está asignada.
 */
export async function changeGfGuideDateFor(
  orderId: string,
  trackingId: string,
  ctx: { userId: string | null; day: string; reason: string },
  admin: SupabaseClient = createAdminSupabase(),
): Promise<GfDateResult> {
  const { data: row } = await admin.from("order_master").select("store_id").eq("order_id", orderId).maybeSingle();
  const storeId = (row as { store_id?: string } | null)?.store_id;
  if (!storeId) return { ok: false, error: "No se pudo leer el pedido." };
  const store = await loadGfStore(admin, storeId);
  if (!store?.token) return { ok: false, error: "La tienda no tiene token de GF Courier." };
  const res = await gfCourier.changeDeliveryDate({ apiToken: store.token }, trackingId, ctx.day, ctx.reason,
    gfIdempotencyKey(orderId, `date-${trackingId}-${ctx.day}`));
  if (!res.ok) return { ok: false, error: res.error.message, code: res.error.code };
  await applyGfSnapshot(res.data, admin);
  await admin.from("order_events").insert({ store_id: storeId, order_id: orderId, kind: "courier_status", occurred_at: new Date().toISOString(),
    actor: ctx.userId, source: GF_COURIER, courier: GF_COURIER, guide_code: trackingId, reason: ctx.reason,
    note: `Fecha de la guía ${trackingId} cambiada al ${ctx.day} en GF Courier, con la misma guía y la caja armada.`,
    payload: { new_date: ctx.day, label_kept: true } });
  return { ok: true, trackingId, newDate: ctx.day };
}

/**
 * La clienta confirmó en Kapta (gestión de confirmación, «Confirmó el pedido»): si el pedido tiene una guía GF viva, se le
 * avisa a GF para que salga «Confirmado» y no pase por «Por llamar» (owner, 20-11-2026: «desde los dos lados»). Sin guía GF
 * viva no hace nada (`skipped`).
 */
export async function confirmGfGuideFor(
  orderId: string,
  ctx: { userId: string | null; note?: string | null },
  admin: SupabaseClient = createAdminSupabase(),
): Promise<{ ok: true; trackingId: string } | { ok: false; skipped?: boolean; error: string }> {
  const live = await admin.from("shipments").select("guide_code,store_id,delivery_status,returned_at").eq("order_id", orderId).eq("courier", GF_COURIER);
  if (live.error) return { ok: false, error: live.error.message };
  const guide = (live.data ?? []).find((s) => s.delivery_status === "pendiente" && !s.returned_at && s.guide_code);
  if (!guide) return { ok: false, skipped: true, error: "Sin guía GF viva." };
  const store = await loadGfStore(admin, guide.store_id as string);
  if (!store?.token) return { ok: false, error: "La tienda no tiene token de GF Courier." };
  const trackingId = String(guide.guide_code);
  const res = await gfCourier.confirmOrder({ apiToken: store.token }, trackingId, gfIdempotencyKey(orderId, `confirm-${trackingId}-${limaTodayKey()}`), ctx.note ?? undefined);
  if (!res.ok) return { ok: false, error: res.error.message };
  await admin.from("order_events").insert({ store_id: guide.store_id, order_id: orderId, kind: "courier_status", occurred_at: new Date().toISOString(),
    actor: ctx.userId, source: GF_COURIER, courier: GF_COURIER, guide_code: trackingId,
    note: `Confirmado en GF Courier (${trackingId}): sale sin volver a llamar a la clienta.`, payload: { gf_confirmed: true } });
  return { ok: true, trackingId };
}

/**
 * La nota del pedido cambió con la guía GF ya creada (owner, 20-11-2026): la guía automática nace a los minutos del pedido y la
 * nota («CNF - ALEXIS», «entrega después de las 5 pm») a veces se escribe después. `current` es lo que GF devolvió al releer la
 * guía (gf-reconcile): si GF todavía no informa `observations` (versión anterior), no se toca. Una misma nota no se reenvía.
 */
export async function syncGfNoteFor(
  input: { token: string; orderId: string; current: GfOrder; raw: unknown },
): Promise<"same" | "unknown" | "sent" | { error: string }> {
  if (!("observations" in input.current)) return "unknown";
  const note = gfOrderNote(input.raw);
  if (gfNotesInSync(note, input.current.observations)) return "same";
  const tracking = input.current.tracking_id;
  // Sin estado guardado en Kapta: la clave cambia en cada envío y GF no duplica (la misma nota no es un cambio).
  const res = await gfCourier.updateNotes({ apiToken: input.token }, tracking, note ?? "",
    gfIdempotencyKey(input.orderId, `notes-${tracking}-${Date.now().toString(36)}`));
  return res.ok ? "sent" : { error: `${res.error.code}: ${res.error.message}` };
}

export async function cancelGfGuideFor(
  orderId: string,
  trackingId: string,
  ctx: { userId: string | null; reason: string; note: string },
  admin: SupabaseClient = createAdminSupabase(),
): Promise<GfCancelResult> {
  const { data: row } = await admin.from("order_master").select("store_id").eq("order_id", orderId).maybeSingle();
  const storeId = (row as { store_id?: string } | null)?.store_id;
  if (!storeId) return { ok: false, error: "No se pudo leer el pedido." };
  const store = await loadGfStore(admin, storeId);
  if (!store?.token) return { ok: false, error: "La tienda no tiene token de GF Courier." };
  // Con motorizado no se anula desde Kapta (owner, 17-11-2026): asignado en una carga, esperando salir o ya en la calle.
  const before = await gfCourier.getOrder({ apiToken: store.token }, trackingId);
  if (before.ok) {
    const blocked = gfCancelBlockedByRider(before.data);
    if (blocked) return { ok: false, error: blocked };
  }
  const res = await gfCourier.cancelOrder({ apiToken: store.token }, trackingId, "MERCHANT_CANCELLED",
    gfIdempotencyKey(orderId, `cancel-${trackingId}`), ctx.reason);
  if (!res.ok) return { ok: false, error: res.error.message };
  const current = await gfCourier.getOrder({ apiToken: store.token }, trackingId);
  if (current.ok) await applyGfSnapshot(current.data, admin);
  // CANCELLED o CANCEL_REQUESTED: para Kapta la guía queda anulada (owner, 17-11-2026, #KP206881). Con la caja ya
  // armada, GF solo tiene pendiente desarmarla; ya no la asigna ni la hace salir. `requested` = otro estado inesperado.
  const code = String((current.ok ? current.data.status?.code : res.data.status?.code) ?? "");
  const requested = code !== "CANCELLED" && code !== "CANCEL_REQUESTED";
  await admin.from("order_events").insert({ store_id: storeId, order_id: orderId, kind: "courier_status", occurred_at: new Date().toISOString(),
    actor: ctx.userId, source: GF_COURIER, courier: GF_COURIER, guide_code: trackingId, reason: ctx.reason,
    note: requested ? `Anulación pedida a GF Courier: ${gfCancelRequestedText(trackingId)}` : ctx.note,
    payload: { cancel_cost: res.data.cancel_cost ?? 0, ...(requested ? { cancel_requested: true, gf_status: code || null } : {}) } });
  return { ok: true, trackingId, cancelCost: Number(res.data.cancel_cost ?? 0), requested };
}


/**
 * Una persona manda el pedido por otro courier (owner, 17-11-2026, #KP206994: se creó la guía de Swayp y la de GF
 * seguía viva en «Por asignar»). Las guías GF vivas sin motorizado se anulan en GF, con el mismo `cancelGfGuideFor`
 * que «Anular guía GF»; si GF no la anula (ya tiene motorizado), no se crea la otra. El automático no anula guías.
 */
export async function cancelLiveGfForOtherCourier(
  admin: SupabaseClient, orderId: string,
  outputs: readonly { courier: string | null; delivery_status: string; guide_code: string | null }[],
  ctx: { userId: string; courier: string },
): Promise<{ ok: true; cancelled: string[]; notice: string | null } | { ok: false; error: string }> {
  const cancelled: string[] = [];
  const inactive: (typeof outputs)[number][] = [];
  for (const gf of liveGfGuides(outputs)) {
    // La guía GF que ya no es una salida activa (§4, owner 23-11-2026: «no contesta», o sin reporte pasado el día de su
    // ruta) no frena al otro courier (owner, 24-11-2026, #KP206970): se intenta anular, sin frenar (abajo).
    if (!salidaActiva(gf as unknown as SalidaExistente)) { inactive.push(gf); continue; }
    const res = await cancelGfGuideFor(orderId, gf.guide_code!, {
      userId: ctx.userId, reason: `Pasa a ${ctx.courier}`, note: `Guía de GF Courier anulada por Kapta al crear la guía de ${ctx.courier}.`,
    }, admin);
    if (!res.ok) return { ok: false, error: `GF Courier no anuló la guía ${gf.guide_code}: ${res.error} No se creó la guía de ${ctx.courier}.` };
    if (res.requested) return { ok: false, error: `GF todavía no confirma la anulación de ${gf.guide_code}. No se creó la guía de ${ctx.courier}.` };
    cancelled.push(gf.guide_code!);
  }
  const tried = await cancelInactiveGfGuides(admin, orderId, inactive, ctx.userId, ctx.courier);
  return { ok: true, cancelled: [...cancelled, ...tried.cancelled], notice: tried.leftOpenNotice };
}

/**
 * Guías GF que ya no son una salida activa pero siguen abiertas en GF (owner, 24-11-2026, #KP206846, #KP206937,
 * #KP206970: volvieron por «no contestó» y quedaron guardadas en el almacén de GF). Al sacar el pedido por otro courier,
 * Kapta las anula en GF para que desarme la caja y devuelva el producto al estante. Nunca frena: si GF no la anula (la
 * caja sigue con el motorizado), queda abierta y se dice para anularla cuando vuelva.
 */
export async function cancelInactiveGfGuides(
  admin: SupabaseClient, orderId: string,
  guides: readonly { guide_code?: string | null }[],
  userId: string | null, courier: string,
): Promise<{ cancelled: string[]; leftOpen: string[]; notice: string | null; leftOpenNotice: string | null }> {
  const cancelled: string[] = [], leftOpen: string[] = [];
  for (const gf of guides) {
    if (!gf.guide_code) continue;
    try {
      const res = await cancelGfGuideFor(orderId, gf.guide_code, {
        userId, reason: `Pasa a ${courier}`, note: `Guía de GF Courier anulada por Kapta al crear la guía de ${courier}.`,
      }, admin);
      (res.ok && !res.requested ? cancelled : leftOpen).push(gf.guide_code);
    } catch {
      leftOpen.push(gf.guide_code);
    }
  }
  const leftOpenNotice = leftOpen.length
    ? `La guía de GF Courier ${leftOpen.join(", ")} sigue abierta en GF (la caja no ha vuelto a su almacén): anúlala en «Salidas y guías» cuando vuelva.`
    : null;
  const parts = [cancelled.length ? `La guía de GF Courier ${cancelled.join(", ")} quedó anulada.` : null, leftOpenNotice].filter(Boolean);
  return { cancelled, leftOpen, notice: parts.length ? parts.join(" ") : null, leftOpenNotice };
}
