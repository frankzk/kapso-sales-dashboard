// La ÚNICA puerta a «entregado» (y a «anulado por rechazo») desde una fuente
// de reparto: cierre de ruta, Liquidaciones 1 y Liquidaciones 2 (MOM §11.4,
// §29.12, §30.8). Antes había tres copias del mismo insert con guardas
// distintas; ahora hay una función y las guardas se unen aquí.
//
// Qué escribe: un `order_events` `status_override` con la fuente que lo pidió
// y recalcula el Master. Qué comprueba, según lo que reciba:
//   * `guard.stop`: la parada debe estar `entregado` para un target entregado
//     (la parada es la verdad, MOM §29.12); con `requireEvidence`, además foto
//     o captura, igual que exige Rutas para las cargas de Grupo GF.
//   * `guard.openObservations`: ninguna observación abierta en la fila ligada
//     (quien liquida acepta el motivo primero, MOM §30.8).
// Lo que no llega con guarda pasa como antes (líneas de Liquidaciones 1 sin
// parada, filas importadas del Excel histórico sin `stop_id`), documentado.

import type { SupabaseClient } from "@supabase/supabase-js";
import { recomputeOrderMasterSafe } from "@/lib/order-master";
import { defaultOperationalFor } from "@/lib/order-status";

export type MasterDoorTarget = "entregado" | "anulado";
export type MasterDoorSource = "ruta" | "liquidacion";

export interface MasterDoorGuard {
  stop?: { status: string; photo_path: string | null; voucher_path: string | null } | null;
  requireEvidence?: boolean;
  openObservations?: number;
}

export interface MasterDoorItem {
  orderId: string;
  storeId: string | null;
  target: MasterDoorTarget;
  source: MasterDoorSource;
  courier?: string | null;
  occurredAt?: string;
  actor: string;
  reason: string;
  payload?: Record<string, unknown>;
  guard?: MasterDoorGuard;
}

export type MasterDoorVerdict = { ok: true } | { ok: false; code: "sin_entrega_en_parada" | "sin_evidencia" | "observacion_abierta"; reason: string };

/** La decisión, pura y testeada (test/master-door.test.ts). */
export function masterDoorVerdict(item: Pick<MasterDoorItem, "target" | "guard">): MasterDoorVerdict {
  const g = item.guard;
  if (!g) return { ok: true };
  if ((g.openObservations ?? 0) > 0) {
    return { ok: false, code: "observacion_abierta", reason: "La fila tiene una observación abierta: alguien debe aceptar el motivo primero." };
  }
  if (g.stop && item.target === "entregado") {
    if (g.stop.status !== "entregado") {
      return { ok: false, code: "sin_entrega_en_parada", reason: "La parada de Rutas no está reportada como entregada." };
    }
    if (g.requireEvidence && !g.stop.photo_path && !g.stop.voucher_path) {
      return { ok: false, code: "sin_evidencia", reason: "La parada no tiene foto de entrega ni captura del pago." };
    }
  }
  return { ok: true };
}

export interface MasterDoorResult {
  applied: string[];
  rejected: { orderId: string; code: string; reason: string }[];
  error?: string;
}

/**
 * Escribe los eventos aceptados y recalcula. Un pedido repetido en la lista
 * se aplica una sola vez. No mira el estado actual del pedido: eso lo decide
 * quien llama (ya entregado, anulado en Shopify…), porque cada fuente lo sabe
 * de forma distinta.
 */
export async function applyDeliveriesToMaster(admin: SupabaseClient, items: readonly MasterDoorItem[]): Promise<MasterDoorResult> {
  const result: MasterDoorResult = { applied: [], rejected: [] };
  const seen = new Set<string>();
  const events: Record<string, unknown>[] = [];
  for (const item of items) {
    if (seen.has(item.orderId)) continue;
    const verdict = masterDoorVerdict(item);
    if (!verdict.ok) {
      result.rejected.push({ orderId: item.orderId, code: verdict.code, reason: verdict.reason });
      continue;
    }
    seen.add(item.orderId);
    events.push({
      store_id: item.storeId,
      order_id: item.orderId,
      kind: "status_override",
      occurred_at: item.occurredAt ?? new Date().toISOString(),
      actor: item.actor,
      source: item.source,
      courier: item.courier ?? null,
      new_status: item.target,
      new_operational: defaultOperationalFor(item.target),
      reason: item.reason,
      payload: item.payload ?? {},
    });
    result.applied.push(item.orderId);
  }
  if (!events.length) return result;
  const { error } = await admin.from("order_events").insert(events);
  if (error) {
    result.error = error.message;
    result.applied = [];
    return result;
  }
  await recomputeOrderMasterSafe(admin, result.applied);
  return result;
}
