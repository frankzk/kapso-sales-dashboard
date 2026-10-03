// Poner el tracking de Olva en una salida (MOM §12). Lo usan el drawer del
// Master —a mano— y «Cotejar Olva» —por cotejo—: tiene que ser UNA regla, o
// el mismo número acabaría en dos salidas según por dónde se escribiera.

import type { SupabaseClient } from "@supabase/supabase-js";
import { formatOlvaTracking, type OlvaTrackingId } from "@/lib/olva/tracking";

/**
 * ¿Otra salida ya tiene este tracking? Es la misma regla que las guías de
 * Shalom vinculadas a mano: un número, una salida. Se excluye la propia para
 * que reenviar el formulario sea idempotente.
 */
export async function olvaTrackingTakenBy(
  admin: SupabaseClient,
  id: OlvaTrackingId,
  exceptShipmentId: string | null,
): Promise<{ error?: string; taken?: { id: string; order_name: string | null } | null }> {
  let query = admin
    .from("shipments")
    .select("id,order_name")
    .eq("olva_tracking", id.tracking)
    .eq("olva_emision", id.emision)
    .limit(1);
  if (exceptShipmentId) query = query.neq("id", exceptShipmentId);
  const { data, error } = await query.maybeSingle();
  if (error) return { error: `No se pudo validar el tracking: ${error.message}` };
  return { taken: (data as { id: string; order_name: string | null } | null) ?? null };
}

/**
 * Vincula el tracking a una salida que NO tiene uno, y lo deja en la ficha
 * del pedido. Solo escribe si la salida sigue sin tracking (`is null` en el
 * mismo update): si alguien lo tecleó mientras tanto, gana lo que tecleó.
 */
export async function linkOlvaTrackingIfEmpty(
  admin: SupabaseClient,
  input: {
    shipmentId: string;
    id: OlvaTrackingId;
    actor: string | null;
    note: string;
    payload?: Record<string, unknown>;
  },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const label = formatOlvaTracking(input.id);
  const dup = await olvaTrackingTakenBy(admin, input.id, input.shipmentId);
  if (dup.error) return { ok: false, error: dup.error };
  if (dup.taken) return { ok: false, error: `El tracking ${label} ya está en ${dup.taken.order_name ?? "otra salida"}.` };

  const now = new Date().toISOString();
  const { data, error } = await admin
    .from("shipments")
    .update({ olva_tracking: input.id.tracking, olva_emision: input.id.emision, olva_status: null, olva_raw: null, updated_at: now })
    .eq("id", input.shipmentId)
    .eq("courier", "olva")
    .is("olva_tracking", null)
    .select("id,store_id,order_id,guide_code")
    .maybeSingle();
  if (error) {
    if (/duplicate key|23505/i.test(error.message)) {
      return { ok: false, error: `El tracking ${label} quedó en otra salida mientras se cotejaba.` };
    }
    return { ok: false, error: `No se pudo guardar el tracking: ${error.message}` };
  }
  const row = data as { id: string; store_id: string; order_id: string | null; guide_code: string | null } | null;
  if (!row) return { ok: false, error: "La salida ya tenía tracking o dejó de ser de Olva." };

  if (row.order_id) {
    await admin.from("order_events").insert({
      store_id: row.store_id,
      order_id: row.order_id,
      kind: "olva_tracking_linked",
      occurred_at: now,
      actor: input.actor,
      source: "olva",
      courier: "olva",
      guide_code: row.guide_code,
      note: input.note,
      shipment_id: row.id,
      payload: { olvaTracking: label, previousOlvaTracking: null, ...(input.payload ?? {}) },
    });
  }
  return { ok: true };
}

/** Una salida del pedido, lo que hace falta para decidir dónde va el tracking. */
export interface OrderOutputForLink {
  id: string;
  courier: string;
  deliveryStatus: string;
  olvaTracking: string | null;
  olvaEmision: string | null;
}

export type OlvaLinkPlan =
  | { kind: "set"; shipmentId: string }
  | { kind: "create" }
  | { kind: "done" }
  | { kind: "error"; error: string };

/**
 * «Vincular a pedido» de Cotejar Olva: alguien eligió A MANO a qué pedido va
 * un envío de Olva. PURA. Si el pedido tiene UNA salida de Olva sin tracking,
 * el tracking va ahí; si no tiene ninguna, se crea; si tiene otro tracking o
 * varias salidas de Olva libres, no se adivina cuál.
 */
export function planOlvaLink(outputs: OrderOutputForLink[], id: OlvaTrackingId): OlvaLinkPlan {
  const olva = outputs.filter((o) => o.courier.trim().toLowerCase() === "olva" && o.deliveryStatus !== "anulado");
  const label = formatOlvaTracking(id);
  if (olva.some((o) => o.olvaTracking === id.tracking && o.olvaEmision === id.emision)) return { kind: "done" };
  const free = olva.filter((o) => !o.olvaTracking);
  const [only] = free;
  if (free.length === 1 && only) return { kind: "set", shipmentId: only.id };
  if (free.length > 1) {
    return { kind: "error", error: `El pedido tiene ${free.length} salidas de Olva sin tracking: elige cuál en el Master.` };
  }
  const other = olva.find((o) => o.olvaTracking);
  if (other?.olvaTracking && other.olvaEmision) {
    return {
      kind: "error",
      error: `El pedido ya tiene el tracking ${formatOlvaTracking({ tracking: other.olvaTracking, emision: other.olvaEmision })}, no ${label}. Si es otro envío, créalo en el Master.`,
    };
  }
  return { kind: "create" };
}
