// Reparación de vínculos hechos SOLO por teléfono (0119).
//
// EL PROBLEMA. `matchShipment` vincula por teléfono cuando hay exactamente un
// pedido con ese número. La regla es correcta en el instante en que se aplica,
// pero la respuesta caduca: el 10-07 la guía AUR5X121336 entró cuando #KP121336
// (creado el 06-07) todavía no estaba en la base, así que el único pedido con
// ese teléfono era el ANTERIOR del mismo cliente — anulado desde junio— y ahí se
// quedó. Un vínculo por teléfono es PROVISIONAL, y nadie lo volvía a mirar.
//
// El resultado se acumula: 15 guías colgando de pedidos ajenos, todas de
// clientes con más de un pedido, y 15 pedidos legítimos sin ninguna guía —
// mostrando «Por confirmar» con el paquete ya entregado.
//
// LA EVIDENCIA QUE FALTABA estaba a la vista: Aliclik numera sus guías `AUR5X` +
// el número del pedido. AUR5X121336 dice #KP121336 en su propio nombre. Con
// `stores.order_prefix` (0115) ese número se convierte en un nombre de pedido
// real, y contrastarlo contra el teléfono da dos señales independientes donde
// antes había una.
//
// QUÉ NO HACE. No inventa: si el pedido derivado no existe, o su teléfono no
// coincide, o el destino ya tiene guías propias, no se toca nada. Mover una guía
// es reescribir a qué venta pertenece un paquete —y de ahí salen el cierre, el
// costo y la liquidación—, así que ante la duda se deja como está y se informa.

/** La guía tal como la necesita el planificador. */
export interface PhoneLinkedGuide {
  id: string;
  guide_code: string | null;
  store_id: string;
  order_id: string | null;
  customer_phone: string | null;
  /** El nombre del pedido que lleva escrito el código de guía, ya derivado con
   *  el prefijo de la tienda (`orderNameFromGuideCode`). */
  derived_order_name: string | null;
}

/** El pedido candidato, tal como está en el Master. */
export interface RepairOrderCandidate {
  id: string;
  store_id: string;
  name: string | null;
  customer_phone: string | null;
  /** Cuántas guías cuelgan hoy de este pedido. */
  guide_count: number;
}

export interface PhoneLinkMove {
  shipmentId: string;
  guideCode: string;
  fromOrderId: string;
  toOrderId: string;
  toOrderName: string;
}

export interface PhoneLinkSkip {
  guideCode: string;
  reason:
    | "sin_nombre_derivado"
    | "pedido_derivado_no_existe"
    | "telefono_no_coincide"
    | "ya_esta_en_su_pedido"
    | "destino_ya_tiene_guias";
}

export interface PhoneLinkPlan {
  move: PhoneLinkMove[];
  skipped: PhoneLinkSkip[];
}

const key = (storeId: string, name: string) => `${storeId}::${name.trim().toUpperCase()}`;

/**
 * Qué guías vinculadas por teléfono hay que mover, y a dónde. Pura.
 *
 * Las cinco razones de descarte se informan una por una en vez de agruparse en
 * «no se pudo»: cada una manda a un sitio distinto —falta el prefijo de la
 * tienda, el pedido no llegó a importarse, el teléfono cambió, el destino ya
 * tiene su propia guía— y sin distinguirlas no hay forma de saber si el número
 * que no baja es un problema o es lo normal.
 */
export function planPhoneLinkRepairs(
  guides: readonly PhoneLinkedGuide[],
  orders: readonly RepairOrderCandidate[],
): PhoneLinkPlan {
  const byName = new Map<string, RepairOrderCandidate>();
  for (const o of orders) {
    if (!o.name) continue;
    byName.set(key(o.store_id, o.name), o);
  }

  const move: PhoneLinkMove[] = [];
  const skipped: PhoneLinkSkip[] = [];

  for (const g of guides) {
    const code = (g.guide_code ?? "").trim();
    if (!code) continue;

    if (!g.derived_order_name) {
      skipped.push({ guideCode: code, reason: "sin_nombre_derivado" });
      continue;
    }
    const target = byName.get(key(g.store_id, g.derived_order_name));
    if (!target) {
      skipped.push({ guideCode: code, reason: "pedido_derivado_no_existe" });
      continue;
    }
    if (target.id === g.order_id) {
      skipped.push({ guideCode: code, reason: "ya_esta_en_su_pedido" });
      continue;
    }
    // El teléfono es la segunda señal, y es lo que impide que una coincidencia
    // de numeración mueva la guía de otra persona.
    if (!g.customer_phone || target.customer_phone !== g.customer_phone) {
      skipped.push({ guideCode: code, reason: "telefono_no_coincide" });
      continue;
    }
    // Un destino que YA tiene guías no es el caso que esto arregla: el patrón es
    // «pedido legítimo sin ninguna guía mientras la suya cuelga de otro». Con
    // guías propias, mover una encima es una decisión de persona, no de barrido.
    if (target.guide_count > 0) {
      skipped.push({ guideCode: code, reason: "destino_ya_tiene_guias" });
      continue;
    }
    if (!g.order_id) {
      skipped.push({ guideCode: code, reason: "ya_esta_en_su_pedido" });
      continue;
    }

    move.push({
      shipmentId: g.id,
      guideCode: code,
      fromOrderId: g.order_id,
      toOrderId: target.id,
      toOrderName: target.name ?? g.derived_order_name,
    });
  }

  return { move, skipped };
}
