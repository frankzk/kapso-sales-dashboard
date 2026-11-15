import "server-only";

// Aplica el estado de una guía de GF Courier a su salida (MOM §29.17). Es el análogo de applyAliclikSnapshot
// (lib/aliclik-track.ts) y reutiliza sus mismas guardas: precedencia de estados (reconcileDeliveryStatus), intento
// fallido (statusAfterFailedAttempt), sello único de devolución (sealReturn), preparación y custodia monotónicas, y
// "sin cambios, sin recálculo". El webhook de GF es solo un aviso: siempre se relee GET /v1/orders/{tracking}, así que
// lo aplicado es el estado ACTUAL de GF y un evento atrasado no puede retroceder la guía.
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminSupabase } from "@/lib/db";
import type { GfOrder } from "@/lib/gf-courier";
import { gfReportedStatus, mapGfStatus } from "@/lib/gf-courier-status";
import { reconcileAliclikCustodyState, reconcileAliclikPreparationState } from "@/lib/aliclik-status";
import { categoryOf, reconcileDeliveryStatus, statusAfterFailedAttempt } from "@/lib/shipments";
import { sealReturn } from "@/lib/returned-source";
import { recomputeOrderMasterSafe } from "@/lib/order-master";
import { cambiosMateriales, soloSellos } from "@/lib/aliclik-snapshot-diff";

export const GF_COURIER = "gf_courier";
export const GF_CREATED_VIA = "gf_courier_api";

export interface GfApplyResult {
  ok: boolean;
  outcome: "applied" | "unchanged" | "unknown_order" | "error";
  shipmentId?: string;
  orderId?: string | null;
  error?: string;
}

const COLUMNS =
  "id,store_id,order_id,delivery_status,guide_code,preparation_state,custody_state,ready_at,custody_transferred_at," +
  "next_followup_at,returned_at,returned_source,closed_at,status_category,reported_status,delivered_source,dispatched_at,quoted_delivery_cost";

export async function applyGfSnapshot(order: GfOrder, admin: SupabaseClient = createAdminSupabase()): Promise<GfApplyResult> {
  const tracking = (order.tracking_id ?? "").trim();
  if (!tracking) return { ok: false, outcome: "error", error: "Snapshot sin tracking_id." };
  const found = await admin.from("shipments").select(COLUMNS).eq("courier", GF_COURIER).eq("external_order_number", tracking).limit(1).maybeSingle();
  if (found.error) return { ok: false, outcome: "error", error: found.error.message };
  const shipment = found.data as Record<string, any> | null;
  if (!shipment) return { ok: false, outcome: "unknown_order" };

  const nowIso = new Date().toISOString();
  const mapped = mapGfStatus(order.status?.code ?? "", order.status?.sub_status ?? null);
  const reported = gfReportedStatus(order.status?.code ?? "", order.status?.sub_status ?? null);
  // Un estado que no traducimos (LOST, o uno nuevo) NO toca la guía: se registra para revisarlo.
  if (!mapped.deliveryStatus) {
    await admin.from("shipments").update({ reported_status: reported, last_report_at: nowIso, api_report_at: nowIso }).eq("id", shipment.id);
    return { ok: true, outcome: "unchanged", shipmentId: shipment.id, orderId: shipment.order_id };
  }

  const next = statusAfterFailedAttempt({
    existingStatus: shipment.delivery_status,
    incoming: reconcileDeliveryStatus(shipment.delivery_status, mapped.deliveryStatus),
    attemptFailed: mapped.attemptFailed,
    attemptDate: nowIso.slice(0, 10),
    scheduledFor: shipment.next_followup_at,
  });
  const patch: Record<string, unknown> = {
    delivery_status: next, status_category: categoryOf(next), reported_status: reported,
    last_report_at: nowIso, api_report_at: nowIso,
    ...(typeof order.shipping_cost === "number" ? { quoted_delivery_cost: order.shipping_cost } : {}),
  };
  const seal = sealReturn(shipment as any, { returned: mapped.returned, at: nowIso, source: GF_CREATED_VIA });
  if (seal.returned_at && seal.returned_at !== shipment.returned_at) {
    patch.returned_at = seal.returned_at; patch.returned_source = seal.returned_source; patch.returned_by = null;
  }
  if (next === "entregado") { patch.closed_at = shipment.closed_at ?? nowIso; patch.delivered_source = GF_CREATED_VIA; }
  if (next === "anulado" && !shipment.closed_at) patch.closed_at = nowIso;
  if (next === "en_ruta" && shipment.delivery_status === "pendiente" && !shipment.dispatched_at) patch.dispatched_at = nowIso;
  const nextPreparation = reconcileAliclikPreparationState(shipment.preparation_state, mapped.preparationState);
  if (nextPreparation && nextPreparation !== shipment.preparation_state) {
    patch.preparation_state = nextPreparation;
    if (nextPreparation === "listo_despacho" && !shipment.ready_at) patch.ready_at = nowIso;
  }
  const nextCustody = reconcileAliclikCustodyState(shipment.custody_state, mapped.custodyState);
  if (nextCustody && nextCustody !== shipment.custody_state) {
    patch.custody_state = nextCustody;
    if (nextCustody === "courier" && !shipment.custody_transferred_at) patch.custody_transferred_at = nowIso;
  }

  if (!cambiosMateriales(patch, shipment).length) {
    const { error } = await admin.from("shipments").update(soloSellos(patch)).eq("id", shipment.id);
    if (error) return { ok: false, outcome: "error", error: error.message };
    return { ok: true, outcome: "unchanged", shipmentId: shipment.id, orderId: shipment.order_id };
  }
  const { error: upErr } = await admin.from("shipments").update(patch).eq("id", shipment.id);
  if (upErr) return { ok: false, outcome: "error", error: upErr.message };

  // Constancia en el pedido, solo en la transición (de estado o de etiqueta de GF).
  if (shipment.order_id && (next !== shipment.delivery_status || reported !== (shipment.reported_status ?? ""))) {
    await admin.from("order_events").insert({
      store_id: shipment.store_id, order_id: shipment.order_id, kind: "courier_status", occurred_at: nowIso, actor: null,
      source: GF_COURIER, courier: GF_COURIER, guide_code: shipment.guide_code,
      previous_status: shipment.delivery_status, new_status: next, new_operational: mapped.operational ?? null,
      note: `GF Courier: ${next} · ${order.status?.name ?? reported}.`,
    });
  }
  if (shipment.order_id) await recomputeOrderMasterSafe(admin, [shipment.order_id]);
  return { ok: true, outcome: "applied", shipmentId: shipment.id, orderId: shipment.order_id };
}
