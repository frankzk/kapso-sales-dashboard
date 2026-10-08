// Pedido acompañante (MOM §32): un pedido que viaja DENTRO de la caja —la
// salida y su guía— de otro pedido, el principal.
//
// POR QUÉ EXISTE. El modelo era una salida = un pedido (§3), y el código de guía
// es único por courier, así que «una guía de Aliclik para dos pedidos» no tenía
// dónde escribirse. Se anotaba con «Cambiar estado», que CONGELA el pedido
// (§6.1). Medido el 05-10-2026: 4 casos y 8 pedidos entre el 15-09 y el 02-10,
// siempre la misma clienta comprando en Kenku y en Aurela. Los 4 acompañantes
// (S/ 398) seguían en «Preparación · Por generar rótulo» con su caja ya en la
// calle o entregada; el candado del principal escondía la entrega de Aliclik
// (#AUR177622, entregado el 03-10 y «En curso»); y la guía cobra la suma de los
// dos pedidos pero la liquidación la atribuye solo al principal (#AUR176985:
// S/ 364 = 215 + 149 de #KP134433).
//
// QUÉ HAY AQUÍ. Solo reglas puras. Los hechos viven en `order_events`
// (`companion_linked` / `companion_unlinked`), escritos A LA VEZ en los dos
// pedidos: el del lado acompañante es el que manda, el del principal es su
// espejo para la línea de tiempo y para descubrir a quién recalcular. No hay
// tabla ni migración: el vínculo vigente es el último hecho del lado
// acompañante, como todo lo demás que el Master deriva de eventos.

export const COMPANION_LINKED = "companion_linked";
export const COMPANION_UNLINKED = "companion_unlinked";
export const COMPANION_EVENT_KINDS: readonly string[] = [COMPANION_LINKED, COMPANION_UNLINKED];

/**
 * Couriers cuya salida puede llevar acompañantes. v1: solo Aliclik (§32 regla
 * 2), que es donde pasa —Kenku y Aurela comparten cuenta— y donde la
 * liquidación es una fila por guía. Sumar otro courier es decisión del owner y
 * se escribe en el MOM antes de tocar esta lista.
 */
export const COMPANION_COURIERS: ReadonlySet<string> = new Set(["aliclik"]);

/** Mínimo del motivo, el mismo que el resto de decisiones auditadas. */
export const COMPANION_REASON_MIN = 8;

export type CompanionRole = "companion" | "host";

/** Lo que llevan los dos hechos en `payload`. */
export interface CompanionPayload {
  role: CompanionRole;
  /** El mismo id en los dos pedidos: une el hecho con su espejo. */
  link_id: string;
  companion_order_id: string;
  companion_order_name: string | null;
  host_order_id: string;
  host_order_name: string | null;
  host_shipment_id: string;
  host_guide_code: string | null;
}

export interface CompanionEventLike {
  order_id: string;
  kind: string;
  occurred_at: string;
  shipment_id?: string | null;
  payload?: Record<string, unknown> | null;
}

export interface CompanionLink {
  linkId: string | null;
  companionOrderId: string;
  companionOrderName: string | null;
  hostOrderId: string;
  hostOrderName: string | null;
  hostShipmentId: string;
  hostGuideCode: string | null;
  linkedAt: string;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isCompanionKind(kind: string): boolean {
  return kind === COMPANION_LINKED || kind === COMPANION_UNLINKED;
}

/**
 * Los vínculos VIGENTES, uno por acompañante como mucho.
 *
 * Se leen solo los hechos del lado acompañante (`role = companion` escrito en
 * el propio pedido acompañante). El espejo del principal no decide nada: si un
 * día los dos lados discreparan, manda el pedido que viaja, que es el que tiene
 * algo que heredar.
 */
export function activeCompanionLinks(events: readonly CompanionEventLike[]): CompanionLink[] {
  const latest = new Map<string, CompanionEventLike>();
  for (const event of events) {
    if (!isCompanionKind(event.kind)) continue;
    const payload = event.payload ?? {};
    if (payload.role !== "companion" || payload.companion_order_id !== event.order_id) continue;
    const previous = latest.get(event.order_id);
    if (!previous || event.occurred_at >= previous.occurred_at) latest.set(event.order_id, event);
  }
  const links: CompanionLink[] = [];
  for (const event of latest.values()) {
    if (event.kind !== COMPANION_LINKED) continue;
    const payload = event.payload ?? {};
    const hostOrderId = text(payload.host_order_id);
    const hostShipmentId = text(payload.host_shipment_id) ?? text(event.shipment_id);
    if (!hostOrderId || !hostShipmentId || hostOrderId === event.order_id) continue;
    links.push({
      linkId: text(payload.link_id),
      companionOrderId: event.order_id,
      companionOrderName: text(payload.companion_order_name),
      hostOrderId,
      hostOrderName: text(payload.host_order_name),
      hostShipmentId,
      hostGuideCode: text(payload.host_guide_code),
      linkedAt: event.occurred_at,
    });
  }
  return links;
}

/**
 * Los pedidos del OTRO lado que nombran estos hechos. Recalcular uno de los dos
 * sin el otro deja al acompañante sin la caja que hereda —o al principal sin
 * enterarse de lo que lleva—, así que el recálculo los junta siempre.
 */
export function companionPartnerIds(events: readonly CompanionEventLike[]): string[] {
  const out = new Set<string>();
  for (const event of events) {
    if (!isCompanionKind(event.kind)) continue;
    const payload = event.payload ?? {};
    for (const id of [text(payload.companion_order_id), text(payload.host_order_id)]) {
      if (id && id !== event.order_id) out.add(id);
    }
  }
  return [...out];
}

/** Lo que hace falta saber de la salida del principal. */
export interface CompanionShipmentFacts {
  id: string;
  order_id: string | null;
  courier: string;
  guide_code: string | null;
  delivery_status: string;
  dispatched_at?: string | null;
  out_for_delivery_at?: string | null;
  custody_transferred_at?: string | null;
  returned_at?: string | null;
}

/**
 * ¿La caja presta su estado al acompañante? (§32 regla 9)
 *
 * Una salida anulada SIN HABER SALIDO de la empresa ya no existe como caja:
 * prestarla mandaría al acompañante a «anulado» por un error de registro o un
 * cambio de courier del principal. Anulada DESPUÉS de salir sí presta: es un
 * «no entregó», y el acompañante entra a Reproprovincia con su caja.
 */
export function shipmentLendsState(
  shipment: Pick<
    CompanionShipmentFacts,
    "delivery_status" | "dispatched_at" | "out_for_delivery_at" | "custody_transferred_at" | "returned_at"
  >,
): boolean {
  if (shipment.delivery_status !== "anulado") return true;
  return Boolean(
    shipment.dispatched_at ||
      shipment.out_for_delivery_at ||
      shipment.custody_transferred_at ||
      shipment.returned_at,
  );
}

/**
 * La caja que el acompañante hereda, o null.
 *
 * Además de prestar, la salida tiene que seguir siendo del principal: si alguien
 * la revinculó a otro pedido (corregir vínculo de guía), el vínculo se queda sin
 * caja en vez de seguir a una guía que ya es de otro.
 */
export function lentShipment<S extends CompanionShipmentFacts>(
  link: Pick<CompanionLink, "hostOrderId" | "hostShipmentId"> | null | undefined,
  shipmentsById: ReadonlyMap<string, S>,
): S | null {
  if (!link) return null;
  const shipment = shipmentsById.get(link.hostShipmentId);
  if (!shipment || shipment.order_id !== link.hostOrderId) return null;
  return shipmentLendsState(shipment) ? shipment : null;
}

/** Hechos del principal que NUNCA pasan al acompañante (§32 regla 5). */
const NEVER_BORROWED = new Set([
  // Las decisiones manuales del principal son del principal.
  "status_override",
  "comment",
  // Registrar una guía suelta el candado (§6.1): heredarla soltaría el del
  // acompañante por una decisión que nadie tomó sobre él.
  "guide_registered",
  "guide_created",
  COMPANION_LINKED,
  COMPANION_UNLINKED,
  // El expediente se cierra o reabre pedido por pedido.
  "order_finalized",
  "order_reopened",
]);

/** Hechos de PEDIDO del principal que sí se heredan: la liquidación (regla 11). */
const ORDER_LEVEL_BORROWED = new Set(["liquidation_closed", "liquidation_observed"]);

/**
 * Los hechos del principal que el acompañante hereda: los de ESA salida
 * (retorno, inventario, merma, custodia…) y la liquidación del pedido, porque el
 * dinero del acompañante llega en la misma fila que el del principal.
 */
export function borrowedHostEvents<T extends { kind: string; shipment_id?: string | null }>(
  hostEvents: readonly T[],
  shipmentId: string,
): T[] {
  return hostEvents.filter((event) => {
    if (NEVER_BORROWED.has(event.kind)) return false;
    if (ORDER_LEVEL_BORROWED.has(event.kind)) return true;
    return event.shipment_id === shipmentId;
  });
}

/**
 * El nombre del pedido como lo guarda el Master («#AUR177622»), escriba como
 * escriba la operadora: con o sin «#», en minúsculas, con espacios.
 */
export function normalizeOrderNameInput(value: string): string | null {
  const compact = value.replace(/\s+/g, "").replace(/^#+/, "").toUpperCase();
  return /^[A-Z]*\d+$/.test(compact) ? `#${compact}` : null;
}

/** Los nueve dígitos del celular, con o sin 51 delante. */
export function phoneKey(phone: string | null | undefined): string | null {
  const digits = (phone ?? "").replace(/\D/g, "");
  return digits.length >= 9 ? digits.slice(-9) : null;
}

const LIVE_STATUSES = new Set(["pendiente", "en_ruta"]);

/** ¿Una salida propia del pedido sigue viva? (`por definir` incluida) */
export function isLiveOwnOutput(shipment: { delivery_status: string; returned_at?: string | null }): boolean {
  return LIVE_STATUSES.has(shipment.delivery_status) && !shipment.returned_at;
}

export interface CompanionLinkCheck {
  companion: {
    orderId: string;
    orderName: string | null;
    phone: string | null;
    /** `orders.cancelled_at`: anulado en Shopify. */
    cancelledAt: string | null;
    macroStage: string | null;
    /** Salidas propias vivas (`pendiente`/`en_ruta`, sin retorno). */
    liveOwnOutputs: number;
    /** ¿Lleva ya acompañantes en alguna de sus cajas? */
    hostsCompanions: boolean;
    /** Su vínculo vigente, si ya viaja en alguna caja. */
    activeLink: CompanionLink | null;
  };
  host: {
    orderId: string;
    orderName: string | null;
    phone: string | null;
    /** ¿Viaja a su vez en la caja de otro? */
    isCompanion: boolean;
  };
  shipment: CompanionShipmentFacts;
  /** El motivo escrito. `null` = todavía no se pide (vista previa de la caja). */
  reason: string | null;
}

/**
 * Por qué NO se puede vincular, o null si se puede (§32 reglas 2 y 3). Pura: la
 * acción del servidor junta los hechos y pregunta aquí, y la ficha enseña la
 * misma frase antes de pedir el clic.
 */
export function companionLinkProblem(check: CompanionLinkCheck): string | null {
  const { companion, host, shipment } = check;
  const hostName = host.orderName ?? "el pedido principal";
  if (companion.orderId === host.orderId) {
    return "Un pedido no puede viajar en su propia caja.";
  }
  if (shipment.order_id !== host.orderId) {
    return `Esa salida ya no es de ${hostName}.`;
  }
  if (!COMPANION_COURIERS.has(shipment.courier.trim().toLowerCase())) {
    return "Por ahora solo una guía de Aliclik puede llevar un pedido acompañante.";
  }
  if (!shipment.guide_code) {
    return (
      `La salida de ${hostName} todavía no tiene guía. Crea primero la guía combinada en el portal de ` +
      "Aliclik —con los productos y el cobro de los dos pedidos— y vincúlala al principal."
    );
  }
  if (!shipmentLendsState(shipment)) {
    return `La guía ${shipment.guide_code} se anuló sin salir de la empresa: esa caja ya no existe.`;
  }
  if (host.isCompanion) {
    return `${hostName} viaja a su vez en la caja de otro pedido. Vincula al pedido que lleva la guía.`;
  }
  if (companion.cancelledAt) {
    return "Este pedido está anulado en Shopify: no viaja en ninguna caja.";
  }
  if (companion.macroStage === "finalizado") {
    return "El expediente de este pedido está finalizado. Reábrelo en la Mesa de cierre antes de vincularlo.";
  }
  if (companion.liveOwnOutputs > 0) {
    return (
      "Este pedido tiene una salida propia viva. Si sus productos van en la caja de " +
      `${hostName}, anula antes esa salida.`
    );
  }
  if (companion.hostsCompanions) {
    return "Este pedido ya lleva otros pedidos en su caja: no puede viajar a su vez en otra.";
  }
  if (companion.activeLink) {
    return companion.activeLink.hostShipmentId === shipment.id
      ? `Ya viaja en esta caja de ${companion.activeLink.hostOrderName ?? hostName}.`
      : `Ya viaja en la caja de ${companion.activeLink.hostOrderName ?? "otro pedido"}. Desvincúlalo primero.`;
  }
  const a = phoneKey(companion.phone);
  const b = phoneKey(host.phone);
  if (!a || !b) {
    return "Falta el teléfono de uno de los dos pedidos: una caja va a una sola clienta y no se puede comprobar.";
  }
  if (a !== b) {
    return `Los teléfonos no coinciden (${a} y ${b}): una caja va a una sola clienta.`;
  }
  if (check.reason !== null && check.reason.trim().length < COMPANION_REASON_MIN) {
    return `Escribe por qué viajan juntos (${COMPANION_REASON_MIN} caracteres como mínimo): queda en el historial de los dos pedidos.`;
  }
  return null;
}

/**
 * Los acompañantes que se entregan con su principal cuando una ruta o una
 * liquidación lo marca entregado por la puerta del Master (§11.4, §32 regla 12).
 *
 * Esas fuentes no escriben en la salida —escriben el estado del pedido—, así
 * que la caja prestada no se entera y el acompañante se quedaría «En curso» con
 * su principal entregado. Solo con la caja todavía viva o entregada: una
 * anulada no llevó nada a ninguna puerta. Y una sola vez por pedido.
 */
export function companionDoorFollowers<
  R extends { link: Pick<CompanionLink, "companionOrderId" | "hostOrderId">; shipment: { delivery_status: string } | null },
>(appliedHostIds: readonly string[], rides: readonly R[], alreadyApplied: readonly string[] = []): R[] {
  const hosts = new Set(appliedHostIds);
  const seen = new Set(alreadyApplied);
  const out: R[] = [];
  for (const ride of rides) {
    if (!ride.shipment || ride.shipment.delivery_status === "anulado") continue;
    if (!hosts.has(ride.link.hostOrderId) || seen.has(ride.link.companionOrderId)) continue;
    seen.add(ride.link.companionOrderId);
    out.push(ride);
  }
  return out;
}

/** Una línea del rótulo (cantidad, producto, variante). */
export interface CompanionLabelItem {
  quantity: number;
  name: string;
  variant: string | null;
}

export interface CompanionLabelPart {
  items: readonly CompanionLabelItem[];
  total: number | null;
  /** ¿Ya cobrado (checkout o Yape completo)? Entonces la puerta no lo cobra. */
  paid: boolean;
}

/**
 * Lo que dice el rótulo interno de una caja que lleva acompañantes (§32): los
 * productos de todos —los ajenos con el pedido al lado, para que quien arma
 * sepa de dónde sale cada uno— y lo que se cobra en la puerta, que es la suma
 * de lo que cada pedido aún debe. Es el dato más caro de equivocar del rótulo:
 * con el total del principal solo, el motorizado cobraría de menos.
 */
export function companionLabelContent(
  host: CompanionLabelPart,
  companions: readonly (CompanionLabelPart & { orderName: string | null })[],
): { items: CompanionLabelItem[]; collectAmount: number | null; paid: boolean } {
  if (!companions.length) {
    return { items: [...host.items], collectAmount: host.total, paid: host.paid };
  }
  const due = (part: CompanionLabelPart) =>
    part.paid ? 0 : part.total != null && Number.isFinite(Number(part.total)) ? Number(part.total) : 0;
  const collect = round2(due(host) + companions.reduce((sum, part) => sum + due(part), 0));
  return {
    items: [
      ...host.items,
      ...companions.flatMap((part) =>
        part.items.map((item) => ({
          ...item,
          name: part.orderName ? `${item.name} (${part.orderName})` : item.name,
        })),
      ),
    ],
    collectAmount: collect,
    paid: collect === 0 && host.paid && companions.every((part) => part.paid),
  };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Cuánto cobra la guía en la puerta: el principal MÁS sus acompañantes (§32
 * regla 11). Un total que falta cuenta como cero, y por eso la ficha lo dice
 * aparte en vez de esconderlo en la suma.
 */
export function companionCollectTotal(
  hostTotal: number | null | undefined,
  companionTotals: readonly (number | null | undefined)[],
): number {
  const sum = [hostTotal, ...companionTotals].reduce<number>(
    (acc, value) => acc + (value != null && Number.isFinite(Number(value)) ? Number(value) : 0),
    0,
  );
  return round2(sum);
}

/**
 * Lo que suman los acompañantes de cada principal, para la liquidación: la fila
 * del courier trae el cobro de la guía entera y se cuadra contra eso.
 */
export function companionTotalsByHost(
  links: readonly Pick<CompanionLink, "companionOrderId" | "hostOrderId">[],
  orderTotals: ReadonlyMap<string, number | null | undefined>,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const link of links) {
    const total = orderTotals.get(link.companionOrderId);
    const value = total != null && Number.isFinite(Number(total)) ? Number(total) : 0;
    out.set(link.hostOrderId, round2((out.get(link.hostOrderId) ?? 0) + value));
  }
  return out;
}
