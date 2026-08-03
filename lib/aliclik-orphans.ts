// Reenganche de guías Aliclik huérfanas a su pedido.
//
// EL PROBLEMA. Miles de guías AUR5X entraron por reportes Excel y el importador
// no logró casarlas con su pedido: quedaron con `order_id` nulo y `matched` en
// false. La guía existe, tiene su estado (muchas ya ENTREGADO), pero el Master
// muestra el pedido como si nunca hubiera salido, porque el pedido y la guía
// nunca se juntaron. Y el botón de vincular a mano chocaba contra el índice
// único al intentar insertar una guía que ya existía.
//
// LA CLAVE QUE LO HACE SEGURO. `order_master.order_name` es único de forma
// global —los prefijos son por tienda (#KP Kenku, #AUR Aurela)— así que casar
// por nombre no confunde pedidos de dos tiendas. El desajuste de tienda que
// dejó el importador (la guía quedó tagueada con la tienda de la subida, no la
// del pedido) se corrige aquí de paso: se adopta la tienda del pedido.
//
// LO QUE NO SE TOCA. El `delivery_status` de la guía se conserva —el reporte ya
// lo venía mateniendo— así que un "entregado" no se pisa. Solo se escribe el
// vínculo. Los pedidos que no están en el Master (nunca se sincronizaron desde
// Shopify) NO se pueden enganchar: quedan fuera, no se inventan.

/**
 * ¿Se puede ADOPTAR una guía que ya existe en `shipments`, en vez de insertar
 * una nueva y chocar contra el índice único de `guide_code`?
 *
 * Sí cuando la fila existe y o bien está libre (`order_id` nulo, una huérfana de
 * reporte) o bien ya es de ESTE pedido (reintento inocuo). Si está vinculada a
 * OTRO pedido no se adopta: eso lo resuelve la guarda previa de la resolución,
 * que devuelve "ya está vinculada a otro pedido" antes de llegar aquí.
 */
export function canAdoptExistingGuide(
  existing: { order_id: string | null } | null | undefined,
  orderId: string,
): boolean {
  if (!existing) return false;
  return existing.order_id === null || existing.order_id === orderId;
}

/** Una guía huérfana candidata a reenganche. */
export interface OrphanShipment {
  id: string;
  order_name: string;
  store_id: string | null;
}

/** El pedido del Master con el que se casaría, por nombre. */
export interface MasterOrder {
  order_id: string;
  order_name: string;
  store_id: string;
  guide_code: string | null;
}

export interface OrphanLink {
  shipmentId: string;
  orderId: string;
  storeId: string;
}

export interface OrphanLinkPlan {
  link: OrphanLink[];
  skipped: {
    /** Un mismo nombre con más de una guía huérfana: ambiguo, se deja a mano. */
    multiOrphan: number;
    /** El pedido no está en el Master (nunca se sincronizó): no hay a qué enganchar. */
    noOrder: number;
    /** El pedido ya tiene una guía: no se toca para no duplicar el vínculo. */
    orderHasGuide: number;
  };
}

/**
 * Decide qué enganchar. PURA: recibe las huérfanas y los pedidos, devuelve el
 * plan. Solo entra al plan una guía cuando es la ÚNICA huérfana de su nombre y
 * su pedido existe en el Master y aún no tiene guía.
 */
export function planOrphanLinks(
  orphans: readonly OrphanShipment[],
  masters: readonly MasterOrder[],
): OrphanLinkPlan {
  const masterByName = new Map<string, MasterOrder>();
  for (const m of masters) masterByName.set(m.order_name, m);

  const countByName = new Map<string, number>();
  for (const o of orphans) {
    countByName.set(o.order_name, (countByName.get(o.order_name) ?? 0) + 1);
  }

  const plan: OrphanLinkPlan = {
    link: [],
    skipped: { multiOrphan: 0, noOrder: 0, orderHasGuide: 0 },
  };

  for (const o of orphans) {
    if ((countByName.get(o.order_name) ?? 0) > 1) {
      plan.skipped.multiOrphan += 1;
      continue;
    }
    const master = masterByName.get(o.order_name);
    if (!master) {
      plan.skipped.noOrder += 1;
      continue;
    }
    if (master.guide_code) {
      plan.skipped.orderHasGuide += 1;
      continue;
    }
    plan.link.push({ shipmentId: o.id, orderId: master.order_id, storeId: master.store_id });
  }
  return plan;
}
