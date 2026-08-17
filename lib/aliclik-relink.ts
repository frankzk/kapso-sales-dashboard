// Devolver a su pedido las guías que el teléfono enlazó al pedido equivocado.
//
// EL DAÑO. El importador empareja por teléfono cuando la fila del reporte no
// trae referencia de pedido, y exige que un único pedido lleve ese número. Ese
// «uno» significaba *solo he ingerido uno*: si el pedido de la guía aún no había
// llegado desde Shopify, el teléfono señalaba a un pedido ANTERIOR del mismo
// cliente. El veto de `matchShipment` cierra la puerta hacia adelante; esto
// repara lo que entró antes de cerrarla.
//
// LO QUE LO HACE REPARABLE SIN ADIVINAR. El código impreso de seis dígitos ES el
// número del pedido —medido: 1.162 de 1.179, y ninguna de las 2.853 guías de 7 y
// 12 dígitos lo cumple—, así que el propio paquete dice de quién era.
//
// NO HAY DATOS CONTAMINADOS QUE ARREGLAR. La fila siempre describió al mismo
// paquete: lo único que estaba mal era a qué pedido apuntaba. Se reescribe el
// vínculo y nada más.

import { orderRefInGuideCode } from "@/lib/shipment-match";
import { normalizePhone } from "@/lib/phone";

export interface RelinkShipment {
  id: string;
  guide_code: string;
  order_id: string;
}

export interface RelinkOrder {
  id: string;
  name: string;
  store_id: string;
  customer_phone: string | null;
}

export interface Relink {
  shipmentId: string;
  guideCode: string;
  fromOrderId: string;
  fromOrderName: string;
  toOrderId: string;
  toOrderName: string;
  toStoreId: string;
}

export interface RelinkReview {
  shipmentId: string;
  guideCode: string;
  reason: string;
}

export interface RelinkPlan {
  relink: Relink[];
  review: RelinkReview[];
}

const digits = (value: string | null | undefined) => (value ?? "").replace(/\D/g, "");

/**
 * Decide qué reenlazar. PURA: recibe las guías y los pedidos, devuelve el plan.
 *
 * Solo entra al plan la guía cuyo código nombra a UN pedido que existe, distinto
 * de aquel del que cuelga, y que **comparte teléfono** con él. Ese teléfono
 * compartido es la firma del caso —el mismo cliente con dos pedidos—: sin él, la
 * guía llegó ahí por otro camino y repararla con esta regla sería aplicar el
 * arreglo de un problema a otro distinto.
 */
export function planRelinkByGuideCode(
  shipments: readonly RelinkShipment[],
  orders: readonly RelinkOrder[],
): RelinkPlan {
  const byId = new Map(orders.map((o) => [o.id, o]));
  const byNumber = new Map<string, RelinkOrder[]>();
  for (const o of orders) {
    const num = digits(o.name);
    if (!num) continue;
    byNumber.set(num, [...(byNumber.get(num) ?? []), o]);
  }

  const plan: RelinkPlan = { relink: [], review: [] };

  for (const ship of shipments) {
    const ref = orderRefInGuideCode(ship.guide_code);
    // El código no nombra ningún pedido (familias de 7 y 12 dígitos): esta
    // reparación no tiene nada que decir sobre esa guía.
    if (!ref) continue;

    const linked = byId.get(ship.order_id);
    if (!linked) continue;
    if (digits(linked.name) === ref) continue; // ya cuelga del suyo

    const owners = byNumber.get(ref) ?? [];
    if (owners.length !== 1) {
      plan.review.push({
        shipmentId: ship.id,
        guideCode: ship.guide_code,
        reason: owners.length
          ? `${owners.length} pedidos con el nº ${ref}`
          : `no existe el pedido ${ref}`,
      });
      continue;
    }

    const owner = owners[0]!;
    if (normalizePhone(owner.customer_phone) !== normalizePhone(linked.customer_phone)) {
      plan.review.push({
        shipmentId: ship.id,
        guideCode: ship.guide_code,
        reason: `${owner.name} tiene otro teléfono que ${linked.name}`,
      });
      continue;
    }

    plan.relink.push({
      shipmentId: ship.id,
      guideCode: ship.guide_code,
      fromOrderId: linked.id,
      fromOrderName: linked.name,
      toOrderId: owner.id,
      toOrderName: owner.name,
      toStoreId: owner.store_id,
    });
  }

  return plan;
}

/** Los pedidos que hay que recalcular: los DOS lados de cada mudanza. */
export function ordersTouchedBy(relinks: readonly Relink[]): string[] {
  return [...new Set(relinks.flatMap((r) => [r.fromOrderId, r.toOrderId]))];
}
