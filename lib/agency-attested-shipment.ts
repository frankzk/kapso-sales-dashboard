// La salida de agencia que nadie registró, reconstruida al marcar el estado.
//
// POR QUÉ EXISTE. Un pedido de Agencia puede llegar a «recogido» sin que exista
// ninguna fila en `shipments`: alguien lleva la caja a Shalom u Olva, la guía se
// crea en el mostrador, y en el Master se marca el estado a mano. El pedido
// queda entonces sin salida, y una salida es lo único por lo que el tablero sabe
// que un pedido se despachó — así que desaparece de todos los indicadores de
// envío, del seguimiento de vencimiento en agencia y del cotejo de liquidación.
//
// MEDIDO (09-09-2026, desde agosto):
//
//                          con guía   sin guía
//   estado desde Shalom      107         0
//   estado marcado a mano    185        42   (18,5%)
//
// Los que vienen del rastreo del courier tienen salida SIEMPRE; el agujero está
// entero en el marcado manual. Son 43 pedidos y S/6.140 desde agosto, y ocho de
// ellos siguen HOY en la agencia sin fecha de vencimiento —el más viejo de hace
// 62 días— justo cuando entre el 5% y el 6% de los envíos de agencia acaba
// devuelto por no recogerse a tiempo.
//
// El camino bueno ya existía (`createManualRouteOutput` admite Olva) y no se usó
// NI UNA VEZ en 40 días, contra 866 salidas de Shalom. Pedirlo aparte no
// funciona; hay que pedirlo donde la persona ya está.
//
// LA FIRMA DEL OPERADOR ES LO QUE AUTORIZA, y eso ya es doctrina del MOM para el
// caso gemelo de las guías creadas en el portal de Aliclik: «lo que autoriza el
// vínculo es la confirmación auditada». Por eso la salida nace con su propio
// `match_method`, y no con el `manual` de las demás: quien audite tiene que poder
// distinguir la salida que trajo el courier de la que afirmó una persona.

/** Los dos couriers de agencia. Mismo par que `AGENCY_COURIERS` en
 *  lib/order-status.ts; aquí se repite porque esto define lo que se puede
 *  ELEGIR en un desplegable, que es una decisión de producto y no la misma cosa
 *  que reconocer un courier ya escrito. */
export const AGENCY_COURIER_OPTIONS = [
  { value: "shalom", label: "Shalom" },
  { value: "olva", label: "Olva" },
] as const;

export type AgencyCourier = (typeof AGENCY_COURIER_OPTIONS)[number]["value"];

export function isAgencyCourierChoice(value: string | null | undefined): value is AgencyCourier {
  return AGENCY_COURIER_OPTIONS.some((option) => option.value === value);
}

/**
 * `match_method` propio. NO se reutiliza `portal_operator_attested` —el del caso
 * de Aliclik— porque un solo valor para los dos borraría de qué flujo vino la
 * salida justo en la columna que existe para auditarlo.
 */
export const AGENCY_ATTESTED_MATCH = "agency_operator_attested";
export const AGENCY_ATTESTED_CREATED_VIA = "status_attested";

/**
 * Estados operativos que significan que LA CAJA YA SALIÓ del almacén.
 *
 * Marcar cualquiera de estos sin salida registrada es la contradicción que este
 * módulo cierra: el pedido afirma haber llegado a la agencia y a la vez no
 * consta que se despachara.
 *
 * `pendiente_de_envio` NO está, y es la distinción que hace útil a la lista: es
 * el estado de la caja preparada que todavía no ha salido. Meterlo obligaría a
 * inventar una salida antes de que exista.
 */
export const AGENCY_DISPATCHED_STATUSES = new Set([
  "enviado_a_agencia",
  "registrado_en_agencia",
  "en_transito",
  "disponible_para_recojo",
  "cliente_notificado",
  "pendiente_de_recojo",
  "proximo_a_vencer",
  "retorno_iniciado",
  "recogido",
  "entregado",
  "devuelto_al_origen",
]);

/**
 * ¿Hay que pedir el courier antes de aceptar este marcado? PURA.
 *
 * Solo en Agencia (decidido con las cifras delante: es donde está medido el
 * agujero y donde la guía sostiene el aviso de vencimiento). Lima sale por la
 * mesa de despacho, que ya crea la salida sola, y añadir fricción a un flujo que
 * funciona por simetría sería pagar un coste cierto sin problema demostrado.
 */
export function needsAttestedAgencyShipment(input: {
  coverage: string | null | undefined;
  operational: string | null | undefined;
  shipmentCount: number;
}): boolean {
  if (input.coverage !== "agencia") return false;
  if (input.shipmentCount > 0) return false;
  return AGENCY_DISPATCHED_STATUSES.has(input.operational ?? "");
}

export interface AttestedShipmentState {
  delivery_status: string;
  status_category: string;
  pickup_state: string;
}

/**
 * Cómo nace la salida según el estado que se está marcando. PURA.
 *
 * El pedido ya recorrió su camino, así que la salida no empieza en «pendiente»:
 * empieza donde el pedido dice que está. Si naciera pendiente, el recálculo la
 * leería y tiraría el estado del pedido HACIA ATRÁS — el marcado se desharía
 * solo, que es peor que no registrar nada.
 */
export function attestedShipmentState(operational: string): AttestedShipmentState {
  if (operational === "recogido" || operational === "entregado") {
    return { delivery_status: "entregado", status_category: "delivered", pickup_state: "recogido" };
  }
  if (operational === "devuelto_al_origen") {
    return { delivery_status: "devuelto", status_category: "closed", pickup_state: "devuelto_al_origen" };
  }
  if (operational === "retorno_iniciado") {
    return { delivery_status: "en_ruta", status_category: "pending", pickup_state: "retorno_iniciado" };
  }
  if (operational === "en_transito" || operational === "enviado_a_agencia") {
    return { delivery_status: "en_ruta", status_category: "pending", pickup_state: "en_transito" };
  }
  // El resto son estados de caja ya en la sucursal esperando al cliente.
  return { delivery_status: "pendiente", status_category: "pending", pickup_state: operational };
}

/**
 * El texto que se guarda en el evento. PURO.
 *
 * Dice que la FECHA es la del registro y no la del envío, y esto no es un
 * detalle de redacción: la cohorte de los indicadores de despacho se arma con
 * esa fecha, así que quien lea el dato tiene que saber que un pedido salido en
 * julio y atestiguado hoy cuenta como despacho de hoy. No se pide la fecha real
 * porque nadie la recuerda con precisión, y una fecha inventada contamina peor
 * que una declarada.
 */
export function attestedShipmentNote(courier: AgencyCourier, operational: string): string {
  const label = AGENCY_COURIER_OPTIONS.find((option) => option.value === courier)?.label ?? courier;
  return (
    `Salida de agencia (${label}) registrada al marcar «${operational}»: no constaba ninguna. ` +
    `La fecha de despacho es la de este registro, no la del envío real.`
  );
}
