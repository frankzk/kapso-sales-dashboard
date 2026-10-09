// ¿El paquete escaneado es de un pedido anulado? Lo primero que hay que decir.
//
// El escaneo respondía cualquier otra cosa —«Ese paquete no pertenece a esta
// ruta», «El pedido ya avanzó…»— y quien tenía la caja en la mano no sabía que
// la respuesta era simplemente «no sale»: #AUR177767, cancelado por la clienta
// en Shopify la noche anterior, se intentó meter en el cotejo de una ruta el
// 05-10-2026. Con el motivo a la vista la decisión es inmediata.
//
// Va ANTES que cualquier otra comprobación del escaneo: no importa si está o
// no en la ruta, en qué caja está o si estaba programado; un pedido anulado no
// sale.

import type { SupabaseClient } from "@supabase/supabase-js";

/** Cómo lo dice Shopify (`cancel_reason`) → cómo lo dice la operación. */
const CANCEL_REASON: Record<string, string> = {
  customer: "lo canceló el cliente",
  fraud: "por fraude",
  inventory: "por falta de stock",
  declined: "pago rechazado",
  staff: "lo canceló la tienda",
  other: "otro motivo",
};

export interface CancelledOrderFacts {
  orderName: string | null;
  /** `orders.cancelled_at`: la cancelación en Shopify. */
  cancelledAt: string | null;
  cancelReason: string | null;
  /** `order_master.general_status`: también puede anularse desde Kapta. */
  generalStatus: string | null;
}

function limaShortDate(iso: string): string | null {
  const at = new Date(iso);
  if (!Number.isFinite(at.getTime())) return null;
  // `en-CA` da YYYY-MM-DD en cualquier entorno; el dd/mm se arma a mano para no
  // depender de cómo cada runtime escribe el día.
  const [, month, day] = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Lima" }).format(at).split("-");
  return month && day ? `${day}/${month}` : null;
}

/**
 * El aviso para quien escanea, o `null` si el pedido sigue vivo. Pura.
 *
 * Dice qué pasó (anulado, dónde, cuándo y por qué cuando se sabe) y qué hacer
 * (no sale; separarlo para devolverlo al stock).
 */
export function cancelledScanMessage(facts: CancelledOrderFacts): string | null {
  const name = facts.orderName ?? "Este pedido";
  if (facts.cancelledAt) {
    const day = limaShortDate(facts.cancelledAt);
    const reason = facts.cancelReason ? CANCEL_REASON[facts.cancelReason] ?? null : null;
    const detail = [day ? `el ${day}` : null, reason].filter(Boolean).join(", ");
    return `${name} está ANULADO en Shopify${detail ? ` (${detail})` : ""}: no sale. Sepáralo para devolverlo al stock.`;
  }
  if (facts.generalStatus === "anulado") {
    return `${name} está ANULADO: no sale. Sepáralo para devolverlo al stock.`;
  }
  return null;
}

/** Lee el pedido y devuelve el aviso si está anulado. Un fallo de lectura no bloquea. */
export async function cancelledScanNotice(
  admin: SupabaseClient,
  orderId: string | null | undefined,
): Promise<string | null> {
  if (!orderId) return null;
  const [{ data: order }, { data: master }] = await Promise.all([
    admin.from("orders").select("name,cancelled_at,cancel_reason").eq("id", orderId).maybeSingle(),
    admin.from("order_master").select("order_name,general_status").eq("order_id", orderId).maybeSingle(),
  ]);
  const o = order as { name?: string | null; cancelled_at?: string | null; cancel_reason?: string | null } | null;
  const m = master as { order_name?: string | null; general_status?: string | null } | null;
  return cancelledScanMessage({
    orderName: o?.name ?? m?.order_name ?? null,
    cancelledAt: o?.cancelled_at ?? null,
    cancelReason: o?.cancel_reason ?? null,
    generalStatus: m?.general_status ?? null,
  });
}
