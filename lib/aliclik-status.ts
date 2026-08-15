// Traducción de los estados de Aliclik al vocabulario de este sistema.
// Puro + testeado. Sin base de datos, sin red.
//
// Aliclik expone TRES enums ortogonales por pedido:
//   * callStatus     — la llamada de confirmación (CONFIRMED, FAKE, DUPLICATE…)
//   * status         — la entrega (PENDING_DELIVERY, DELIVERED, REFUSED…)
//   * dispatchStatus — el despacho (TO_PREPARE, PICKED, IN_TRANSIT, RETURNED…)
//
// Aquí se resuelven a los dos niveles que ya usa el panel:
//   * `delivery_status` de la guía — lib/shipments.ts (pendiente | en_ruta |
//     entregado | anulado | transferido)
//   * `operational` del pedido — lib/order-status.ts (el catálogo fino)
//
// PRECEDENCIA. `status` manda sobre `dispatchStatus`: es el hecho de la entrega,
// mientras que el despacho es solo dónde está el paquete. `callStatus` solo
// decide los cubos de "anulado" y "aún no empezado" — un pedido marcado FAKE o
// DUPLICATE no llega a repartirse por muy TO_PREPARE que diga el despacho.
//
// LO QUE NO SE HACE: adivinar. Aliclik puede añadir valores a estos enums en
// cualquier momento. Un valor desconocido NO cambia el estado: se devuelve
// `deliveryStatus: null` y el valor se apunta en `unknown[]` para poder verlo en
// los registros. Inventar un estado a partir de un enum que no conocemos sería
// mover un pedido real por una corazonada.

export interface AliclikStatusInput {
  callStatus?: string | null;
  status?: string | null;
  dispatchStatus?: string | null;
  /** Los pedidos por agencia alimentan además `pickup_state`. */
  isAgency?: boolean;
}

export interface AliclikStatusMapping {
  /** null = no se pudo determinar; el llamador debe DEJAR el estado como está. */
  deliveryStatus: "pendiente" | "en_ruta" | "entregado" | "anulado" | null;
  /** Código de OPERATIONAL_STATUSES, o null si no aplica/no se conoce. */
  operational: string | null;
  /** Sub-estado de agencia (§10), solo cuando el pedido es por agencia. */
  pickupState: string | null;
  /** El paquete volvió al origen: hay que sellar `returned_at`. */
  returned: boolean;
  /** El estado no admite más avances. */
  terminal: boolean;
  /** Valores de enum que no reconocimos, para registrar y revisar. */
  unknown: string[];
  /** Estado físico MOM que Aliclik puede acreditar con su propio cotejo. */
  preparationState: "rotulo_generado" | "listo_despacho" | null;
  /** Custodia física MOM acreditada por el estado de despacho de Aliclik. */
  custodyState: "empresa" | "courier" | "devuelto" | null;
  /**
   * El courier SALIÓ y no encontró a la clienta (NO CONTESTA). No es un
   * desenlace —la guía sigue viva— pero consume la reprogramación agendada: si
   * nadie vuelve a llamar, se pierde la ventana de Aliclik y el paquete se
   * devuelve a Lima con flete a cargo nuestro. Lo consumen las DOS vías (Excel
   * y API) para devolver la guía a la cola de llamadas.
   */
  attemptFailed: boolean;
}

const norm = (v: string | null | undefined): string => (v ?? "").trim().toUpperCase();

/** callStatus que cierran el pedido sin llegar a repartirse. */
const CANCELLING_CALL = new Set([
  "ANNULLED",
  "FAKE",
  "DUPLICATE",
  "OUT_OF_STOCK",
  "NO_COVERAGE",
  "TESTING",
]);

/** callStatus que existen y son válidos, pero no cierran nada por sí solos. */
const LIVE_CALL = new Set([
  "CONFIRMED",
  "FOLLOW",
  "CALL_LATER",
  "NOT_RESPOND",
  "CONTACTED",
  "IMPORTED",
]);

const KNOWN_STATUS = new Set([
  "PENDING_DELIVERY",
  "DELIVERED",
  "RESCHEDULED",
  "REFUSED",
  "NOT_RESPOND",
  "CANCEL",
  "ANNULLED",
]);

const KNOWN_DISPATCH = new Set([
  "TO_PREPARE",
  "PREPARED",
  "PICKED",
  "TO_RETURN",
  "RETURNED",
  "IN_TRANSIT",
  "IN_AGENCY",
  "LEFT_IN_WAREHOUSE",
  "STORE_CENTRAL",
  "REMAINING_IN_TRANSIT",
]);

type AliclikMomState = Pick<AliclikStatusMapping, "preparationState" | "custodyState">;

/**
 * Equivalencia entre el cotejo de Aliclik y el MOM.
 *
 * PREPARED no es solo una guía creada: en la operación de Aliclik es el
 * resultado del escaneo/cotejo físico. PICKED acredita además que el courier ya
 * recibió el paquete. Los estados posteriores conservan ambas verdades.
 */
function momStateFromDispatch(dispatch: string): AliclikMomState {
  switch (dispatch) {
    case "TO_PREPARE":
      return { preparationState: "rotulo_generado", custodyState: "empresa" };
    case "PREPARED":
      return { preparationState: "listo_despacho", custodyState: "empresa" };
    case "PICKED":
    case "IN_TRANSIT":
    case "REMAINING_IN_TRANSIT":
    case "STORE_CENTRAL":
    case "TO_RETURN":
    case "IN_AGENCY":
      return { preparationState: "listo_despacho", custodyState: "courier" };
    case "RETURNED":
      return { preparationState: "listo_despacho", custodyState: "devuelto" };
    default:
      return { preparationState: null, custodyState: null };
  }
}

const PREPARATION_RANK: Record<string, number> = {
  no_iniciado: 0,
  rotulo_generado: 1,
  en_armado: 2,
  listo_despacho: 3,
};

/** Aliclik puede hacer avanzar la preparación, nunca borrar un avance local. */
export function reconcileAliclikPreparationState(
  current: string | null | undefined,
  incoming: AliclikStatusMapping["preparationState"],
): string | null {
  if (!incoming) return current ?? null;
  if (current === "incidencia") return current;
  const currentRank = PREPARATION_RANK[current ?? "no_iniciado"] ?? 0;
  const incomingRank = PREPARATION_RANK[incoming] ?? 0;
  return currentRank >= incomingRank ? (current ?? incoming) : incoming;
}

const CUSTODY_RANK: Record<string, number> = {
  empresa: 0,
  courier: 1,
  retorno: 2,
  devuelto: 3,
};

/** Un snapshot antiguo no puede devolver ficticiamente el paquete a la empresa. */
export function reconcileAliclikCustodyState(
  current: string | null | undefined,
  incoming: AliclikStatusMapping["custodyState"],
): string | null {
  if (!incoming) return current ?? null;
  const currentRank = CUSTODY_RANK[current ?? "empresa"] ?? 0;
  const incomingRank = CUSTODY_RANK[incoming] ?? 0;
  return currentRank >= incomingRank ? (current ?? incoming) : incoming;
}

/**
 * `LEFT_IN_WAREHOUSE` significa DOS cosas opuestas, y solo el intento de entrega
 * las distingue.
 *
 * Aliclik usa "DEJADO EN ALMACÉN" tanto para el paquete que todavía no ha salido
 * como para el que ya volvió. Antes se leía siempre como lo primero
 * —`nunca_salio_a_reparto`—, así que una guía despachada, intentada dos veces y
 * devuelta al almacén se quedaba en `pendiente` y nunca sellaba `returned_at`.
 * Ese es el hecho que abre la recuperación (MOM §11.1), así que perderlo dejaba
 * la cola vacía mientras las cajas estaban físicamente en el almacén.
 *
 * Lo que desambigua es el `status`: si hay un RESULTADO de entrega —cancelada,
 * rechazada, no contesta, reprogramada— el paquete salió y volvió. Si dice
 * PENDING_DELIVERY, o no dice nada, nunca se movió y sigue siendo lo de antes.
 *
 * El lado barato del error está de este lado: con la exigencia del intento, como
 * mucho se pierde una recuperación dudosa. Sin ella se le pediría un adelanto de
 * S/30 a una clienta cuyo paquete jamás salió.
 */
function returnedFromWarehouse(status: string, dispatch: string): boolean {
  return dispatch === "LEFT_IN_WAREHOUSE" && ATTEMPTED_DELIVERY.has(status);
}

/** `status` que acreditan que el paquete SALIÓ y el intento falló. DELIVERED no
 *  entra: esa guía terminó bien y se resuelve antes. */
const ATTEMPTED_DELIVERY = new Set(["CANCEL", "ANNULLED", "REFUSED", "NOT_RESPOND", "RESCHEDULED"]);

/**
 * Detalle operativo dentro de "todavía por entregar", según dónde está el
 * paquete. Devuelve [deliveryStatus, operational].
 */
function fromDispatch(
  dispatch: string,
  isAgency: boolean,
): ["pendiente" | "en_ruta", string] | null {
  switch (dispatch) {
    // Aún en el almacén: el pedido no ha salido, sigue siendo "pendiente".
    case "TO_PREPARE":
      return ["pendiente", "confirmado_sin_preparar"];
    case "PREPARED":
      return ["pendiente", "preparado_sin_despachar"];
    case "LEFT_IN_WAREHOUSE":
      return ["pendiente", "nunca_salio_a_reparto"];
    // Ya salió: el pedido está en movimiento.
    case "PICKED":
      return ["en_ruta", "despachado"];
    case "IN_TRANSIT":
    case "REMAINING_IN_TRANSIT":
      return ["en_ruta", "en_ruta"];
    case "STORE_CENTRAL":
      return ["en_ruta", "en_traslado"];
    case "TO_RETURN":
      return ["en_ruta", "en_proceso_de_retorno"];
    case "IN_AGENCY":
      // OJO: "agency" aquí NO es Shalom. Es el HUB LOCAL de Aliclik, donde el
      // paquete espera para salir hacia la provincia y entrar en su reparto.
      // Etiquetarlo "Registrado en agencia" —que en este sistema pertenece al
      // flujo de recojo en Shalom— haría que el equipo leyera un pedido a
      // domicilio como si se hubiera desviado a una agencia, y llamara a la
      // clienta para que fuera a recogerlo. En un envío que SÍ va por agencia,
      // en cambio, la etiqueta es la correcta.
      return isAgency
        ? ["en_ruta", "registrado_en_agencia"]
        : ["en_ruta", "en_traslado"];
    default:
      return null;
  }
}

/**
 * Traduce el trío de estados de Aliclik. Puro.
 *
 * El resultado NO se escribe directamente: pasa por `reconcileDeliveryStatus`
 * de lib/shipments.ts, que es quien garantiza que un `entregado` no retroceda y
 * que un terminal no se reabra. Aquí solo se interpreta lo que dice Aliclik.
 */
export function mapAliclikStatus(input: AliclikStatusInput): AliclikStatusMapping {
  const call = norm(input.callStatus);
  const status = norm(input.status);
  const dispatch = norm(input.dispatchStatus);
  const isAgency = Boolean(input.isAgency);
  const momState = momStateFromDispatch(dispatch);

  const unknown: string[] = [];
  if (call && !CANCELLING_CALL.has(call) && !LIVE_CALL.has(call)) unknown.push(`callStatus=${call}`);
  if (status && !KNOWN_STATUS.has(status)) unknown.push(`status=${status}`);
  if (dispatch && !KNOWN_DISPATCH.has(dispatch)) unknown.push(`dispatchStatus=${dispatch}`);

  const base: AliclikStatusMapping = {
    deliveryStatus: null,
    operational: null,
    pickupState: null,
    returned: false,
    terminal: false,
    unknown,
    attemptFailed: status === "NOT_RESPOND",
    ...momState,
  };

  // 1. Entregado gana sobre todo lo demás. En agencia, "entregado" significa que
  //    la clienta lo recogió.
  if (status === "DELIVERED") {
    return {
      ...base,
      deliveryStatus: "entregado",
      operational: isAgency ? "recogido" : "entregado",
      terminal: true,
      preparationState: "listo_despacho",
      custodyState: "courier",
    };
  }

  // 2. Devuelto: la guía se cierra, pero el PEDIDO pasa a "devuelto" — y ese
  //    matiz vive en resolveOrderState (lib/order-status.ts), no aquí, porque el
  //    vocabulario de guías no tiene un código `devuelto`.
  if (dispatch === "RETURNED" || returnedFromWarehouse(status, dispatch)) {
    return {
      ...base,
      deliveryStatus: "anulado",
      operational: "devuelto_al_origen",
      returned: true,
      terminal: true,
      // El paquete está de vuelta en el almacén: la custodia deja de ser del
      // courier aunque la etiqueta no diga RETURNED.
      custodyState: "devuelto",
      preparationState: momState.preparationState ?? "listo_despacho",
    };
  }

  // 3. Anulaciones. Tanto por estado de entrega como por resultado de la llamada.
  if (status === "CANCEL" || status === "ANNULLED" || CANCELLING_CALL.has(call)) {
    return { ...base, deliveryStatus: "anulado", operational: "anulado", terminal: true };
  }

  // 4. IMPORTED nunca hace avanzar una guía: es un pedido que Aliclik cargó pero
  //    aún no gestionó. El importador de Excel ya descarta las filas IMPORTADO
  //    por la misma razón (lib/aliclik-import.ts).
  if (call === "IMPORTED" && !status && !dispatch) {
    return { ...base, deliveryStatus: "pendiente", operational: "sin_confirmar" };
  }

  // 5. Intentos fallidos y reprogramaciones: el paquete sigue vivo y en calle.
  if (status === "RESCHEDULED") {
    return {
      ...base,
      deliveryStatus: "en_ruta",
      operational: "reprogramado",
      preparationState: "listo_despacho",
      custodyState: "courier",
    };
  }
  if (status === "REFUSED" || status === "NOT_RESPOND") {
    return {
      ...base,
      deliveryStatus: "en_ruta",
      operational: "intento_de_entrega",
      preparationState: "listo_despacho",
      custodyState: "courier",
    };
  }

  // 6. Por entregar: el detalle lo pone el despacho.
  const fromDisp = dispatch ? fromDispatch(dispatch, isAgency) : null;
  if (fromDisp) {
    const [delivery, operational] = fromDisp;
    return {
      ...base,
      deliveryStatus: delivery,
      operational,
      // En agencia, "en agencia" es exactamente el sub-estado que el Master usa
      // para saber que la clienta ya puede ir a recoger.
      pickupState: isAgency && dispatch === "IN_AGENCY" ? "disponible_para_recojo" : null,
    };
  }

  // 7. Sabemos que está por entregar, pero no dónde. Sin dispatch reconocible no
  //    se afina más: es "pendiente" sin sub-estado inventado.
  if (status === "PENDING_DELIVERY") {
    return {
      ...base,
      deliveryStatus: "pendiente",
      operational: isAgency ? "pendiente_de_envio" : null,
    };
  }

  // 8. Un pedido recién confirmado, sin más señales.
  if (call === "CONFIRMED" && !status && !dispatch) {
    return { ...base, deliveryStatus: "pendiente", operational: "confirmado_sin_preparar" };
  }

  // 9. No lo sabemos. No se toca nada.
  return base;
}

/**
 * Etiqueta legible del trío, para mostrarlo tal y como lo dice Aliclik junto a
 * nuestra interpretación. Poder comparar las dos es lo que permite detectar que
 * un mapeo se quedó corto cuando Aliclik añade un estado.
 */
export function aliclikStatusLabel(input: AliclikStatusInput): string {
  return [norm(input.status), norm(input.dispatchStatus), norm(input.callStatus)]
    .filter(Boolean)
    .join(" · ");
}
