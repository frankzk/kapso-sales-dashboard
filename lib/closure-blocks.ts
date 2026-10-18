// Lo que impide un cierre en la Mesa de cierre, dicho ANTES del clic y repetido
// por el servidor con las mismas palabras (MOM §14, §24, §29.13). Puro, probado
// en test/pedidos-closure-blocks.test.ts. Lo usan `registerClosureAction`
// (app/dashboard/pedidos/actions.ts) y la Mesa (components/order-closure-desk.tsx):
// si la pantalla y el servidor decidieran con dos reglas, la pantalla volvería a
// ofrecer un botón que el servidor rechaza, que es justo lo que se corrige.

import { costConceptLabel, costDay } from "@/lib/costs";
import { costCourier, isKnownCourier } from "@/lib/delivery-courier";
import { courierKey } from "@/lib/dispatch";
import { courierDisplayName } from "@/lib/dispatched-with";
import { COURIER_TBD } from "@/lib/shipment-output";

// ---------------------------------------------------------------------------
// Conciliar liquidación: el costo logístico tiene que existir
// ---------------------------------------------------------------------------

/** Dónde se cargan las tarifas que lee el costo logístico del Master. */
export const COSTS_SCREEN_LABEL = "Costos › Costos logísticos";
export const COSTS_SCREEN_HREF = "/dashboard/costos";

/** Dónde se rellena una caja «por definir» que entregó Urpi (MOM §30.11). */
export const URPI_FILL_PATH_LABEL = "Urpi › Resultados («Pasar a salida de Urpi entregada»)";

export interface LogisticsCostFacts {
  /**
   * `order_master.logistics_cost`. `null` = falta alguna tarifa (desde la
   * auditoría del 14-10-2026 el recálculo ya no guarda S/ 0 cuando falta:
   * lib/order-master.ts `masterLogisticsCost`). `undefined` = quien pregunta no
   * lo sabe, y entonces no se afirma nada.
   */
  cost: number | null | undefined;
  /** Conceptos sin tarifa, cuando se conocen (el servidor los sabe al recalcular). */
  missing?: readonly string[];
  /**
   * El courier con el que se busca la tarifa (`costCourier`,
   * lib/delivery-courier.ts): el vigente, o en una entrega sin courier o «por
   * definir», el de la entrega. Vacío o «por definir» = no se sabe quién la
   * llevó.
   */
  courier: string | null;
  district: string | null;
  /**
   * Día (YYYY-MM-DD) al que se imputa el costo (`costDay`): el del último
   * movimiento del pedido. La tarifa tiene que regir ESE día; una cargada
   * «desde hoy» no le llega a un pedido entregado antes. Sin dato, no se nombra.
   */
  day?: string | null;
  /**
   * ¿Quien lee puede cargar tarifas (`costs.manage`)? Con false se le dice que
   * se la pida a quien administra Costos. Sin dato, como si pudiera.
   */
  canManageCosts?: boolean;
}

/** Lo que la fila del Master sabe del costo: lo usan la Mesa y el respaldo del servidor. */
export interface LogisticsCostRow {
  logistics_cost: number | null;
  general_status: string | null;
  current_courier: string | null;
  last_courier?: string | null;
  delivered_courier?: string | null;
  dispatched_with?: readonly string[] | null;
  district: string | null;
  last_movement_at?: string | null;
  order_created_at?: string | null;
}

/**
 * Los datos del aviso a partir de la fila guardada, con la MISMA regla del
 * courier y del día que el recálculo (lib/order-master.ts): si la Mesa usara
 * el courier vigente tal cual, diría «no se sabe quién lo entregó» a un
 * pedido que el servidor calcula como Grupo GF.
 */
export function logisticsCostFactsFromRow(row: LogisticsCostRow): LogisticsCostFacts {
  const day =
    row.last_movement_at || row.order_created_at
      ? costDay({ last_movement_at: row.last_movement_at ?? null, order_created_at: row.order_created_at ?? null })
      : null;
  return {
    cost: row.logistics_cost,
    courier: costCourier({
      generalStatus: row.general_status,
      currentCourier: row.current_courier,
      lastCourier: row.last_courier ?? null,
      deliveredCourier: row.delivered_courier ?? null,
      dispatchedWith: row.dispatched_with ?? null,
    }),
    district: row.district,
    day,
  };
}

/**
 * ¿El bloqueo se arregla cargando una tarifa? Solo si se sabe el courier: sin
 * él (vacío o «por definir») ninguna tarifa con courier le aplica, y una sin
 * courier se aplicaría a todos los couriers sin tarifa propia.
 */
export function costBlockNeedsTariff(facts: Pick<LogisticsCostFacts, "cost" | "courier">): boolean {
  return facts.cost === null && isKnownCourier(facts.courier);
}

/**
 * Por qué no se puede conciliar la liquidación por falta de costo; null si el
 * costo existe (también cuando es legítimamente S/ 0: una tarifa en cero o el
 * acompañante que viaja en la caja de otro, MOM §29.8 y §32).
 */
export function liquidationCostBlock(facts: LogisticsCostFacts): string | null {
  if (facts.cost !== null) return null;
  const concepts = (facts.missing ?? []).map((code) => `«${costConceptLabel(code)}»`);
  const what = concepts.length
    ? `la tarifa de ${joinEs(concepts)}`
    : "la tarifa logística";
  const where = facts.district?.trim() ? ` para ${facts.district.trim()}` : "";
  const token = courierKey(facts.courier);
  const zero = "Sin ella el flete quedaría en S/ 0 y la liquidación no cuadra.";
  // «Por definir» no es un courier: pedir una tarifa para él la crearía para
  // todas las cajas sin courier decidido (MOM §14).
  if (token === COURIER_TBD) {
    return (
      `Falta ${what}: la salida sigue «Por definir» y no se sabe qué courier la entregó («Salió con» no lo dice),` +
      ` así que ninguna tarifa le aplica. ${zero} Si la entregó Urpi, pásala en ${URPI_FILL_PATH_LABEL} y` +
      " vuelve a conciliar; para otro courier, Kapta todavía no tiene ese paso."
    );
  }
  if (!token) {
    return (
      `Falta ${what}: no se sabe qué courier entregó el pedido (ni su salida ni «Salió con» lo dicen), así que` +
      ` ninguna tarifa le aplica. ${zero} Kapta todavía no tiene un paso para registrar quién lo entregó, y una tarifa sin` +
      " courier no es la salida: se aplicaría a todos los couriers sin tarifa propia."
    );
  }
  const scope = `${COSTS_SCREEN_LABEL} (courier «${token}»)${facts.day ? `, vigente desde el ${dayEs(facts.day)} o antes,` : ""}`;
  const load =
    facts.canManageCosts === false
      ? `Pídele a quien administra Costos que la cargue en ${scope} y luego vuelve a conciliar.`
      : `Cárgala en ${scope} y vuelve a conciliar.`;
  const why = facts.day
    ? " Una que empiece después de ese día no le llega: el costo se calcula con la del día de su último movimiento."
    : "";
  return `Falta ${what} de ${courierDisplayName(token)}${where}. ${zero} ${load}${why}`;
}

/** YYYY-MM-DD → DD-MM-YYYY, como lo escribe la app. */
function dayEs(day: string): string {
  const [y, m, d] = day.slice(0, 10).split("-");
  return y && m && d ? `${d}-${m}-${y}` : day;
}

function joinEs(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} y ${items[items.length - 1]}`;
}

// ---------------------------------------------------------------------------
// Finalizar expediente: salidas activas y la ruta de Grupo GF abierta
// ---------------------------------------------------------------------------

export interface ClosureShipment {
  id: string;
  courier: string | null;
  delivery_status: string;
  custody_state?: string | null;
}

/** La parada vigente de una salida propia (la que elige `pickLatestStop`). */
export interface ClosureGfStop {
  status: string;
  /** planificada · en_curso · cerrada; null si no se pudo leer la ruta. */
  routeStatus: string | null;
  routeId?: string | null;
}

/** Lo mínimo de `GfDelivery` (lib/gf-delivery.ts) que mira el cierre. */
export interface ClosureGfDelivery {
  shipmentId: string;
  stop: ClosureGfStop | null;
}

const ACTIVE_DELIVERY_STATUSES = new Set(["pendiente", "en_ruta", "por_preparar"]);

/** Salidas que todavía viven: las mismas que impiden finalizar en el servidor. */
export function activeOutputs<T extends ClosureShipment>(shipments: readonly T[]): T[] {
  return shipments.filter(
    (shipment) => shipment.custody_state !== "devuelto" && ACTIVE_DELIVERY_STATUSES.has(shipment.delivery_status),
  );
}

export const ACTIVE_OUTPUTS_ERROR =
  "Todavía existen salidas activas. Cancélalas o recibe su retorno antes de finalizar.";

/** Dónde se termina la ruta: el mismo texto en la Mesa y en el servidor. */
export const GF_ROUTE_PATH_LABEL = "Grupo GF Courier › Rutas › «Reparto y liquidación»";

export const GF_OPEN_ROUTE_ERROR =
  `El motorizado de Grupo GF ya reportó la entrega, pero su ruta sigue abierta. Termina la ruta en ${GF_ROUTE_PATH_LABEL}:` +
  " al cerrarla, el pedido pasa a entregado y sigue a su liquidación.";

/** Quién puede cambiar a mano un pedido anulado (`master.override_status`). */
export const OVERRIDE_PERMISSION_LABEL = "Corregir pedidos cerrados";

/**
 * El mismo caso con el pedido anulado en Shopify (#KP137541, auditoría del
 * 14-10-2026). La puerta a «entregado» no escribe sobre esa anulación (MOM
 * §11.4): cerrar la ruta NO lo pasa a entregado, así que prometerlo mandaba a
 * un bucle (cerrar la ruta → la Mesa ofrece Finalizar → «salidas activas»).
 */
export const GF_OPEN_ROUTE_CANCELLED_ERROR =
  "El motorizado de Grupo GF reportó la entrega y su ruta sigue abierta, pero el pedido está anulado en Shopify:" +
  ` terminar la ruta en ${GF_ROUTE_PATH_LABEL} no lo marca entregado. Si la entrega vale, la cambia desde esta ficha` +
  ` («Gestión manual»), con motivo, quien tenga «${OVERRIDE_PERMISSION_LABEL}».`;

export interface GfOpenRouteBlock {
  /**
   * `ruta_abierta`: al cerrar la ruta el pedido pasa a entregado.
   * `anulado_shopify`: está anulado en Shopify y la puerta no lo marca
   * entregado; decide una persona desde la ficha.
   */
  kind: "ruta_abierta" | "anulado_shopify";
  /** Rutas abiertas de esas paradas, sin repetir, en el orden de las salidas. */
  routeIds: string[];
}

/**
 * ¿La única salida viva es propia, con su parada ENTREGADA en una ruta que
 * sigue abierta? Es el pedido que el resolver ya pone en «Por cerrar ·
 * Validación de cierre pendiente» con lo que reportó el motorizado (v1.14,
 * MOM §29.13), y que no se finaliza: lo cierra la ruta, que escribe la entrega
 * por la puerta del Master y lo manda a su liquidación.
 *
 * Con el pedido anulado en Shopify (`cancelledInShopify`, de
 * `orders.cancelled_at`, lo mismo que lee la puerta) el bloqueo sigue —la
 * salida sigue viva y Finalizar no cabe—, pero es de otra clase: cerrar la
 * ruta no lo marca entregado (MOM §11.4).
 *
 * null si no aplica: sin salidas vivas, con alguna salida viva de otro courier,
 * o con una salida propia cuya parada no está entregada o cuya ruta está
 * cerrada (o no se sabe). En esos casos manda el mensaje de siempre.
 */
export function gfOpenRouteBlock(
  shipments: readonly ClosureShipment[],
  deliveries: readonly ClosureGfDelivery[],
  opts: { cancelledInShopify?: boolean } = {},
): GfOpenRouteBlock | null {
  const active = activeOutputs(shipments);
  if (!active.length) return null;
  const routeIds: string[] = [];
  for (const shipment of active) {
    if (courierKey(shipment.courier) !== "propio") return null;
    const stop = deliveries.find((delivery) => delivery.shipmentId === shipment.id)?.stop ?? null;
    if (!stop || stop.status !== "entregado") return null;
    if (!stop.routeStatus || stop.routeStatus === "cerrada") return null;
    if (stop.routeId && !routeIds.includes(stop.routeId)) routeIds.push(stop.routeId);
  }
  return { kind: opts.cancelledInShopify ? "anulado_shopify" : "ruta_abierta", routeIds };
}

/** Lo que responde el servidor a «Finalizar» con ese bloqueo. */
export function gfOpenRouteError(block: GfOpenRouteBlock): string {
  return block.kind === "anulado_shopify" ? GF_OPEN_ROUTE_CANCELLED_ERROR : GF_OPEN_ROUTE_ERROR;
}

/**
 * Enlace al reparto y liquidación de la ruta. Va por la redirección de
 * /dashboard/courier/reparto, que decide con los permisos de quien entra si lo
 * abre en la pestaña Rutas de Grupo GF o en /dashboard/courier/rutas.
 */
export function gfRouteReportHref(routeId: string): string {
  return `/dashboard/courier/reparto?id=${encodeURIComponent(routeId)}`;
}
