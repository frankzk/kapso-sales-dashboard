// La ÚNICA puerta a «entregado» desde una fuente de reparto: cierre de ruta,
// Liquidaciones 1 y Liquidaciones 2 (MOM §11.4, §29.12, §30.8). Hasta la v1.22
// también anulaba por rechazo; desde la v1.23 solo Shopify anula (owner).
// Antes había tres copias del mismo insert con guardas distintas; ahora hay
// una función y las guardas se unen aquí.
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
import { companionDoorFollowers } from "@/lib/order-companion";
import { loadCompanionRides, loadOrderTotals } from "@/lib/order-companion-access";

export type MasterDoorTarget = "entregado";
export type MasterDoorSource = "ruta" | "liquidacion";

export interface MasterDoorGuard {
  /** `reported_by` null = parada de backfill histórico (sin foto posible):
   *  la evidencia no se le exige (MOM §29.12). */
  stop?: { status: string; photo_path: string | null; voucher_path: string | null; reported_by?: string | null } | null;
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
    const realReport = g.stop.reported_by === undefined || Boolean(g.stop.reported_by);
    if (g.requireEvidence && realReport && !g.stop.photo_path && !g.stop.voucher_path) {
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
  await followCompanions(admin, items, result);
  await recomputeOrderMasterSafe(admin, result.applied);
  return result;
}

/**
 * PEDIDO ACOMPAÑANTE (MOM §32 regla 12): lo que viaja en la caja de un pedido
 * que esta puerta acaba de entregar, se entrega con él. Mismo hecho, misma
 * fuente, y un motivo que nombra al principal y la guía. Best-effort: si falla,
 * el principal ya quedó bien y el acompañante se arregla a mano desde su ficha;
 * no se deshace una entrega por no poder escribir la de su acompañante.
 */
async function followCompanions(
  admin: SupabaseClient,
  items: readonly MasterDoorItem[],
  result: MasterDoorResult,
): Promise<void> {
  try {
    const rides = await loadCompanionRides(admin, result.applied);
    const followers = companionDoorFollowers(result.applied, rides, result.applied);
    if (!followers.length) return;
    const byOrder = new Map(items.map((item) => [item.orderId, item]));
    const stores = await loadOrderTotals(admin, followers.map((ride) => ride.link.companionOrderId));
    const events = followers.flatMap((ride) => {
      const host = byOrder.get(ride.link.hostOrderId);
      const storeId = stores.get(ride.link.companionOrderId)?.storeId ?? null;
      if (!host || !storeId) return [];
      return [
        {
          store_id: storeId,
          order_id: ride.link.companionOrderId,
          kind: "status_override",
          occurred_at: host.occurredAt ?? new Date().toISOString(),
          actor: host.actor,
          source: host.source,
          courier: host.courier ?? null,
          new_status: host.target,
          new_operational: defaultOperationalFor(host.target),
          reason:
            `Entregado con ${ride.link.hostOrderName ?? "su pedido principal"}: viajaba en su caja` +
            (ride.link.hostGuideCode ? ` (guía ${ride.link.hostGuideCode})` : "") +
            ". " +
            host.reason,
          // Sin `shipment_id`: la salida es del principal, y los flujos que
          // leen hechos por salida (retorno, inventario) no deben ver aquí uno
          // del acompañante. La caja va en el payload.
          payload: {
            ...(host.payload ?? {}),
            companion_of: ride.link.hostOrderId,
            host_shipment_id: ride.link.hostShipmentId,
          },
        },
      ];
    });
    if (!events.length) return;
    const { error } = await admin.from("order_events").insert(events);
    if (error) {
      console.error("[master-door] acompañantes", error.message);
      return;
    }
    result.applied.push(...events.map((event) => event.order_id));
  } catch (cause) {
    console.error("[master-door] acompañantes", cause);
  }
}
