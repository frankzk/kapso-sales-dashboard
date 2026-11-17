import "server-only";

// Simulación de GF Courier (MOM §29.17, owner 16-11-2026): cada pedido de Lima y Callao de los últimos 90 días se
// manda a POST /v1/orders/validate con el MISMO cuerpo con el que `createGfGuideFor` (lib/gf-courier-guide.ts) crearía
// la guía: las mismas lecturas, el mismo `buildGfOrderInput` y el mismo día programado (si cambian allí, cambian aquí;
// test/gf-courier-simulation.test.ts lo vigila). Dos cambios, los de una simulación: el external_id lleva «-SIM» si el
// pedido ya tuvo guía en GF, y un `scheduled_date` pasado no se manda. Solo lee: ni guías, ni intenciones, ni hechos.
import type { SupabaseClient } from "@supabase/supabase-js";
import { gfCourier } from "@/lib/gf-courier";
import { buildGfOrderInput } from "@/lib/gf-courier-order";
import { isWebPrepaid } from "@/lib/order-paid";
import { reproAgreedGfDay } from "@/lib/gf-courier-guide";
import { GF_COURIER } from "@/lib/gf-courier-track";
import { wooTerritorio } from "@/lib/woo-territorio";
import { CUSTOMER_PAYMENT_KINDS } from "@/lib/pending-voucher";
import {
  createPacer,
  GF_SIM_DAYS,
  GF_SIM_GATEWAYS,
  GF_SIM_INTERVAL_MS,
  GF_SIM_KAPTA_CODE,
  sentValue,
  simExternalId,
  withoutPastSchedule,
  type GfSimOutcome,
} from "@/lib/gf-courier-simulation";

export interface GfSimStore { id: string; name: string; token: string }

/**
 * Los pedidos a simular: de esas tiendas, creados en los últimos 90 días, de Lima o Callao (la región del pedido),
 * sin anular y en contraentrega (modo «cod», o pasarela «cod» o «manual»). Devuelve solo los ids.
 */
export async function listGfSimulationTargets(admin: SupabaseClient, storeIds: string[], now: Date = new Date()): Promise<{ orderId: string; storeId: string }[]> {
  if (!storeIds.length) return [];
  const since = new Date(now.getTime() - GF_SIM_DAYS * 86_400_000).toISOString();
  const rows: { order_id: string; store_id: string; shipping_mode: string | null }[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await admin.from("order_master").select("order_id,store_id,shipping_mode")
      .in("store_id", storeIds).gte("order_created_at", since).or("region.ilike.*lima*,region.ilike.*callao*")
      .order("order_created_at", { ascending: true }).order("order_id", { ascending: true }).range(from, from + 999);
    if (error) throw new Error(`No se pudieron leer los pedidos: ${error.message}`);
    rows.push(...((data ?? []) as typeof rows));
    if ((data ?? []).length < 1000) break;
  }
  const gateways = new Set<string>(GF_SIM_GATEWAYS);
  const keep = new Set<string>();
  for (let i = 0; i < rows.length; i += 200) {
    const ids = rows.slice(i, i + 200).map((r) => r.order_id);
    const { data, error } = await admin.from("orders").select("id,cancelled_at,payment_gateway").in("id", ids);
    if (error) throw new Error(`No se pudieron leer los pedidos: ${error.message}`);
    const mode = new Map(rows.slice(i, i + 200).map((r) => [r.order_id, r.shipping_mode]));
    for (const o of (data ?? []) as { id: string; cancelled_at: string | null; payment_gateway: string | null }[]) {
      if (o.cancelled_at) continue;
      if (mode.get(o.id) === "cod" || (o.payment_gateway && gateways.has(o.payment_gateway))) keep.add(o.id);
    }
  }
  return rows.filter((r) => keep.has(r.order_id)).map((r) => ({ orderId: r.order_id, storeId: r.store_id }));
}

/** Un pedido: el cuerpo de la creación, con los dos cambios de la simulación, a POST /v1/orders/validate. */
export async function simulateGfOrder(
  admin: SupabaseClient,
  orderId: string,
  ctx: { stores: Map<string, GfSimStore>; today: string; pace: () => Promise<void> },
): Promise<GfSimOutcome> {
  const fail = (order: string, store: string, message: string, hadGuide = false): GfSimOutcome =>
    ({ kind: "error", order, store, code: GF_SIM_KAPTA_CODE, field: null, message, sent: null, hadGuide });
  const master = await admin.from("order_master").select(
    "store_id,order_id,order_name,customer_name,customer_phone,region,province,district,address,reference,latitude,longitude,order_total,dispatch_scheduled_on,shipping_mode",
  ).eq("order_id", orderId).maybeSingle();
  if (master.error || !master.data) return fail(orderId, "?", "No se pudo leer el pedido.");
  const row = master.data as Record<string, any>;
  const store = ctx.stores.get(row.store_id);
  const label = String(row.order_name ?? orderId);
  if (!store) return fail(label, "?", "La tienda del pedido no está en la simulación.");

  const shipments = await admin.from("shipments").select("id,delivery_status,returned_at").eq("order_id", orderId).eq("courier", GF_COURIER);
  if (shipments.error) return fail(label, store.name, shipments.error.message);
  const hadGuide = (shipments.data ?? []).length > 0;

  const order = await admin.from("orders").select("name,line_items,raw,financial_status,payment_gateway,total_refunded").eq("id", orderId).maybeSingle();
  if (order.error || !order.data) return fail(label, store.name, "No se pudo leer el pedido.", hadGuide);
  const payments = await admin.from("order_payments").select("amount").eq("order_id", orderId).in("kind", [...CUSTOMER_PAYMENT_KINDS]).eq("validation_status", "validado");
  if (payments.error) return fail(label, store.name, `No se pudieron leer los pagos del pedido: ${payments.error.message}`, hadGuide);
  const advance = (payments.data ?? []).reduce((s, p) => s + Number(p.amount ?? 0), 0);
  const sequence = (shipments.data ?? []).length + 1;
  const externalId = `${row.order_name ?? order.data.name}${sequence > 1 ? `-S${sequence}` : ""}`.slice(0, 100);
  const lines = ((order.data.line_items ?? []) as any[]).map((l) => ({ sku: l.sku ?? null, title: l.title ?? null, quantity: Number(l.quantity), price: Number(l.price) }));
  const built = buildGfOrderInput({
    externalId, customerName: row.customer_name, customerPhone: row.customer_phone, district: row.district,
    ubigeo: wooTerritorio(order.data.raw)?.code ?? null, address: row.address, reference: row.reference,
    latitude: row.latitude, longitude: row.longitude, orderTotal: Number(row.order_total), advancePaid: advance,
    webPrepaid: isWebPrepaid({ financialStatus: order.data.financial_status, totalRefunded: Number(order.data.total_refunded ?? 0), paymentGateway: order.data.payment_gateway }),
    scheduledFor: (row.dispatch_scheduled_on && row.dispatch_scheduled_on >= new Date().toISOString().slice(0, 10) ? row.dispatch_scheduled_on : null)
      ?? await reproAgreedGfDay(admin, orderId),
    lines,
  });
  if (!built.ok) return fail(label, store.name, built.reason, hadGuide);

  const input = withoutPastSchedule({ ...built.input, external_id: simExternalId(built.input.external_id, hadGuide) }, ctx.today);
  await ctx.pace();
  const res = await gfCourier.validateOrder({ apiToken: store.token }, input);
  if (res.ok) return { kind: "valid", order: label, store: store.name, takenFromAddress: res.data?.destination?.taken_from_address === true, hadGuide };
  const field = res.error.field ?? null;
  return { kind: "error", order: label, store: store.name, code: res.error.code, field, message: res.error.message, sent: sentValue(input, field), hadGuide };
}

/** Una pasada: hasta 4 pedidos a la vez, y las llamadas a GF de a una cada 250 ms (4 por segundo). */
export async function runGfSimulationChunk(
  admin: SupabaseClient,
  orderIds: string[],
  stores: Map<string, GfSimStore>,
  today: string,
): Promise<GfSimOutcome[]> {
  const pace = createPacer(GF_SIM_INTERVAL_MS);
  const out: GfSimOutcome[] = new Array(orderIds.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, orderIds.length) }, async () => {
    while (next < orderIds.length) {
      const i = next++;
      out[i] = await simulateGfOrder(admin, orderIds[i]!, { stores, today, pace });
    }
  }));
  return out;
}
