// Lectura de los vínculos de pedido acompañante (MOM §32) para quien no pasa
// por el recálculo del Master: la liquidación, la puerta a «entregado» y la
// ficha. Las reglas son las de `lib/order-companion.ts`; aquí solo se traen los
// hechos y las salidas.
//
// SERVER-ONLY: recibe el cliente que toque (el del usuario respeta sus tiendas;
// el de servicio, en las escrituras que ya autorizaron a su manera).

import type { SupabaseClient } from "@supabase/supabase-js";
import { chunk } from "@/lib/access";
import {
  COMPANION_EVENT_KINDS,
  activeCompanionLinks,
  companionPartnerIds,
  lentShipment,
  type CompanionEventLike,
  type CompanionLink,
  type CompanionShipmentFacts,
} from "@/lib/order-companion";

const COMPANION_SHIPMENT_COLUMNS =
  "id,order_id,courier,guide_code,delivery_status,dispatched_at,out_for_delivery_at,custody_transferred_at,returned_at,reported_collect_amount,created_via";

export interface CompanionShipment extends CompanionShipmentFacts {
  /** Lo que el courier dijo que cobra (`shipments.reported_collect_amount`). */
  reported_collect_amount?: number | string | null;
  created_via?: string | null;
}

export interface CompanionRide {
  link: CompanionLink;
  /** La caja del principal si todavía presta su estado (`lentShipment`); null si no. */
  shipment: CompanionShipment | null;
  /** La fila de la salida tal como está, preste o no: la ficha la nombra igual. */
  rawShipment: CompanionShipment | null;
}

async function companionEvents(
  sb: SupabaseClient,
  orderIds: readonly string[],
): Promise<CompanionEventLike[]> {
  const out: CompanionEventLike[] = [];
  for (const batch of chunk([...orderIds], 200)) {
    const { data, error } = await sb
      .from("order_events")
      .select("order_id,kind,occurred_at,shipment_id,payload")
      .in("order_id", batch)
      .in("kind", [...COMPANION_EVENT_KINDS]);
    if (error) throw new Error(`No se pudieron leer los vínculos de pedido acompañante — ${error.message}`);
    out.push(...((data ?? []) as unknown as CompanionEventLike[]));
  }
  return out;
}

/**
 * Los vínculos vigentes en los que participa alguno de estos pedidos, como
 * acompañante o como principal, con la salida del principal.
 *
 * Dos vueltas: los hechos de estos pedidos nombran al otro lado, y el vínculo
 * vigente lo decide el lado ACOMPAÑANTE, que hay que leer aunque no estuviera
 * en la lista.
 */
export async function loadCompanionRides(
  sb: SupabaseClient,
  orderIds: readonly string[],
): Promise<CompanionRide[]> {
  const ids = [...new Set(orderIds.filter(Boolean))];
  if (!ids.length) return [];
  const first = await companionEvents(sb, ids);
  if (!first.length) return [];
  const known = new Set(ids);
  const partners = companionPartnerIds(first).filter((id) => !known.has(id));
  const all = partners.length ? first.concat(await companionEvents(sb, partners)) : first;
  const links = activeCompanionLinks(all).filter(
    (link) => known.has(link.companionOrderId) || known.has(link.hostOrderId),
  );
  if (!links.length) return [];

  const shipmentsById = new Map<string, CompanionShipment>();
  for (const batch of chunk([...new Set(links.map((link) => link.hostShipmentId))], 200)) {
    const { data, error } = await sb.from("shipments").select(COMPANION_SHIPMENT_COLUMNS).in("id", batch);
    if (error) throw new Error(`No se pudo leer la salida del pedido principal — ${error.message}`);
    for (const row of (data ?? []) as unknown as CompanionShipment[]) shipmentsById.set(row.id, row);
  }
  return links.map((link) => ({
    link,
    shipment: lentShipment(link, shipmentsById),
    rawShipment: shipmentsById.get(link.hostShipmentId) ?? null,
  }));
}

/** Total de cada pedido según el Master, para sumar lo que cobra la caja. */
export async function loadOrderTotals(
  sb: SupabaseClient,
  orderIds: readonly string[],
): Promise<Map<string, { total: number | null; name: string | null; storeId: string | null }>> {
  const out = new Map<string, { total: number | null; name: string | null; storeId: string | null }>();
  for (const batch of chunk([...new Set(orderIds.filter(Boolean))], 200)) {
    const { data, error } = await sb
      .from("order_master")
      .select("order_id,order_total,order_name,store_id")
      .in("order_id", batch);
    if (error) throw new Error(`No se pudieron leer los totales de los pedidos — ${error.message}`);
    for (const row of (data ?? []) as {
      order_id: string;
      order_total: number | string | null;
      order_name: string | null;
      store_id: string | null;
    }[]) {
      const total = row.order_total == null ? null : Number(row.order_total);
      out.set(row.order_id, {
        total: total != null && Number.isFinite(total) ? total : null,
        name: row.order_name,
        storeId: row.store_id,
      });
    }
  }
  return out;
}
