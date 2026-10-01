import "server-only";
import { createHash } from "node:crypto";
import { createServerSupabase } from "@/lib/db";
import { permissionsFor } from "@/lib/permissions";
import { classifyOperation } from "@/lib/order-macro-stage";
import { normalizePhone } from "@/lib/phone";
import { duplicateGate, duplicateItems, sharesDuplicateItem, unresolvedDuplicateShipment,
  type DuplicateConflict, type DuplicateHold, type DuplicateResolution, type DuplicateShipment } from "@/lib/aliclik-duplicate";

export const DUPLICATE_READ_ERROR = "No se pudo verificar si hay otro envío del mismo producto pendiente. Reintenta antes de crear la guía Aliclik.";

async function duplicatePermissions(sb: Awaited<ReturnType<typeof createServerSupabase>>, orgId: string) {
  const { data: { user }, error } = await sb.auth.getUser();
  if (error || !user) throw new Error(DUPLICATE_READ_ERROR);
  const [membership, grants] = await Promise.all([
    sb.from("memberships").select("role").eq("org_id", orgId).eq("user_id", user.id).maybeSingle(),
    sb.from("user_permissions").select("permission,granted").eq("org_id", orgId).eq("user_id", user.id),
  ]);
  // A failed grants read must not erase an explicit revocation.
  if (membership.error || grants.error || !grants.data) throw new Error(DUPLICATE_READ_ERROR);
  return permissionsFor(membership.data ? [membership.data.role] : [], grants.data);
}

/** RLS throughout. Never limit customer history to the 50 rows shown in the brief. */
export async function loadAliclikDuplicateHold(orderId: string): Promise<DuplicateHold> {
  const sb = await createServerSupabase();
  const { data: row, error } = await sb.from("order_master")
    .select("order_id,store_id,customer_phone,shipping_mode,coverage,region,province,district")
    .eq("order_id", orderId).single();
  if (error || !row) throw new Error(DUPLICATE_READ_ERROR);
  const clear: DuplicateHold = { allowed: true, message: null, conflicts: [], fingerprint: null,
    resolution: null, validatedAmount: 0, canResolve: false, canOverride: false };
  if (classifyOperation(row) !== "provincia_cod") return clear;
  const phone = normalizePhone(row.customer_phone);
  if (!phone) throw new Error("Falta el teléfono para verificar duplicados y crear la guía.");
  const { data: store, error: storeError } = await sb.from("stores").select("org_id").eq("id", row.store_id).single();
  if (storeError || !store?.org_id) throw new Error(DUPLICATE_READ_ERROR);
  const { data: stores, error: storesError } = await sb.from("stores").select("id").eq("org_id", store.org_id);
  if (storesError || !stores?.length) throw new Error(DUPLICATE_READ_ERROR);
  const storeIds = stores.map((s) => s.id);
  // Ingestion normalizes phones. Include legacy national/+country forms as well.
  const phones = [...new Set([phone, `+${phone}`, row.customer_phone,
    ...(phone.startsWith("51") && phone.length === 11 ? [phone.slice(2)] : [])])];
  const priors: { order_id: string; order_name: string; store_id: string }[] = [];
  for (let offset = 0; ; offset += 100) {
    const { data, error: priorError } = await sb.from("order_master")
      .select("order_id,order_name,store_id").in("store_id", storeIds)
      .in("customer_phone", phones).neq("order_id", orderId)
      .order("order_id").range(offset, offset + 99);
    if (priorError || !data) throw new Error(DUPLICATE_READ_ERROR);
    priors.push(...data);
    if (data.length < 100) break;
  }
  if (!priors.length) return clear;
  const active: DuplicateShipment[] = [];
  for (let start = 0; start < priors.length; start += 100) {
    const ids = priors.slice(start, start + 100).map((p) => p.order_id);
    for (let offset = 0; ; offset += 100) {
      const { data, error: guidesError } = await sb.from("shipments")
        .select("id,order_id,guide_code,courier,dispatched_at,custody_transferred_at,out_for_delivery_at,aliclik_reported_dispatch_date,returned_at,delivery_status,custody_state,pickup_state")
        .in("order_id", ids).in("store_id", storeIds).order("id").range(offset, offset + 99);
      if (guidesError || !data) throw new Error(DUPLICATE_READ_ERROR);
      active.push(...(data as DuplicateShipment[]).filter(unresolvedDuplicateShipment));
      if (data.length < 100) break;
    }
  }
  if (!active.length) return clear;
  const itemsById = new Map<string, NonNullable<ReturnType<typeof duplicateItems>>>();
  const ids = [...new Set([orderId, ...active.map((g) => g.order_id)])];
  for (let start = 0; start < ids.length; start += 100) {
    const { data, error: itemsError } = await sb.from("orders").select("id,line_items")
      .in("id", ids.slice(start, start + 100));
    if (itemsError || !data) throw new Error(DUPLICATE_READ_ERROR);
    for (const order of data) {
      const items = duplicateItems(order.line_items);
      if (!items) throw new Error("Faltan productos identificables para descartar un duplicado. Revisa los pedidos antes de crear la guía.");
      itemsById.set(order.id, items);
    }
  }
  if (ids.some((id) => !itemsById.has(id))) throw new Error(DUPLICATE_READ_ERROR);
  const currentItems = itemsById.get(orderId)!;
  const priorById = new Map(priors.map((p) => [p.order_id, p]));
  const matching = active.filter((g) => {
    const same = sharesDuplicateItem(currentItems, itemsById.get(g.order_id)!, priorById.get(g.order_id)!.store_id === row.store_id);
    if (same === null) throw new Error("Faltan identificadores comparables para descartar un duplicado entre los pedidos. Revisa sus productos.");
    return same;
  });
  if (!matching.length) return clear;
  const conflicts: DuplicateConflict[] = matching.map((g) => ({ orderId: g.order_id,
    orderName: priorById.get(g.order_id)!.order_name ?? g.order_id, shipmentId: g.id,
    guideCode: g.guide_code, courier: g.courier,
    dispatchedAt: g.dispatched_at ?? g.custody_transferred_at ?? g.out_for_delivery_at ?? g.aliclik_reported_dispatch_date,
  })).sort((a, b) => a.shipmentId.localeCompare(b.shipmentId));
  // Bind approval to customer, full current basket and every conflicting physical output.
  const canonicalItems = (id: string) => itemsById.get(id)!.map((i) => `${i.variant}:${i.sku}:${i.quantity}`).sort();
  const fingerprint = createHash("sha256").update(JSON.stringify({ orderId, phone,
    items: canonicalItems(orderId), conflicts: conflicts.map((c) => [c.shipmentId, c.orderId, c.dispatchedAt, canonicalItems(c.orderId)]),
  })).digest("hex");
  const [events, payments, permissions] = await Promise.all([
    sb.from("order_events").select("payload,actor,reason,occurred_at").eq("order_id", orderId)
      .eq("kind", "aliclik_duplicate_resolution").order("occurred_at", { ascending: false }).order("id", { ascending: false }).limit(1),
    sb.from("order_payments").select("kind,amount,validation_status").eq("order_id", orderId)
      .eq("store_id", row.store_id).eq("validation_status", "validado").in("kind", ["adelanto", "diferencia", "total"]),
    duplicatePermissions(sb, store.org_id),
  ]);
  if (events.error || payments.error || !events.data || !payments.data) throw new Error(DUPLICATE_READ_ERROR);
  const event = events.data[0];
  const resolution: DuplicateResolution | null = event?.actor && event.reason && event.payload?.fingerprint &&
    (event.payload.decision !== "exception" || event.payload.exception_authorized === true)
    ? { fingerprint: event.payload.fingerprint, decision: event.payload.decision, reason: event.reason,
      actor: event.actor, occurredAt: event.occurred_at } : null;
  const validatedAmount = payments.data.reduce((sum, p) => {
    const amount = Number(p.amount);
    return sum + (Number.isFinite(amount) && amount > 0 ? Math.round(amount * 100) : 0);
  }, 0) / 100;
  return { ...duplicateGate(conflicts, fingerprint, resolution, validatedAmount), conflicts, fingerprint,
    validatedAmount, canResolve: permissions.has("master.edit"), canOverride: permissions.has("master.override_status") };
}
