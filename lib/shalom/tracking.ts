// Traducción de los hitos de rastreo de Shalom a los estados del Master.
//
// PURO Y TESTEADO: no toca red ni base. La parte con red vive en el cliente y en
// el cron; acá está la única lógica que puede equivocarse de verdad, que es
// decidir qué significa cada combinación de hitos.
//
// `GET /v1/tracking` devuelve siete hitos y cada uno llega con fecha o en `null`.
// `null` NO es un error: es un hito que todavía no ocurrió, que es lo normal en
// un envío en curso. Por eso se lee como una escalera y gana el más avanzado, en
// vez de tratarlos como banderas independientes.
//
// Un aviso de la propia documentación: desde julio de 2026 los bloques `origen`,
// `destino`, `remitente`, `destinatario` y `comprobante` de `order` llegan
// vacíos. No se construye nada sobre ellos — de `order` solo se leen los flags y
// las fechas, y el estado sale enteramente de `status`.

/** Un hito: `{fecha}` si ocurrió, `null` si todavía no. */
export interface ShalomMilestone {
  fecha?: string | null;
  completo?: boolean | null;
  cargueros?: string[] | null;
  carguero?: string | null;
}

/** El objeto `status` de `GET /v1/tracking` y de cada item del batch. */
export interface ShalomTrackingStatus {
  registrado?: ShalomMilestone | null;
  origen?: ShalomMilestone | null;
  transito?: ShalomMilestone | null;
  demora?: ShalomMilestone | null;
  destino?: ShalomMilestone | null;
  entregado?: ShalomMilestone | null;
  reparto?: ShalomMilestone | null;
}

export interface ShalomTrackingSnapshot {
  /** `shipments.delivery_status` */
  deliveryStatus: "pendiente" | "en_ruta" | "entregado";
  /** `shipments.pickup_state` — el flujo de agencia (§10). */
  pickupState: string;
  /** Fecha del hito que decidió el estado, para fechar el movimiento. */
  at: string | null;
  /** Hay una incidencia de demora declarada por Shalom. */
  delayed: boolean;
}

function hit(m: ShalomMilestone | null | undefined): string | null {
  const fecha = m?.fecha;
  return typeof fecha === "string" && fecha.trim() ? fecha.trim() : null;
}

/**
 * El hito más avanzado manda. El orden es el del viaje físico y no el del objeto:
 * un envío entregado sigue teniendo `registrado` con fecha, así que leer los
 * hitos como banderas sueltas daría el estado más atrasado, no el actual.
 *
 * `reparto` (salió a domicilio) va por encima de `destino` (llegó a la agencia
 * de destino) porque solo puede ocurrir después, aunque para una entrega en
 * agencia sea `null` para siempre.
 */
export function readShalomTracking(status: ShalomTrackingStatus | null | undefined): ShalomTrackingSnapshot {
  const s = status ?? {};
  const delayed = hit(s.demora) != null;

  const entregado = hit(s.entregado);
  if (entregado) {
    // La entrega en agencia es un recojo del cliente, y ese es el estado
    // operativo que el equipo espera ver en el flujo de Shalom (§10).
    return { deliveryStatus: "entregado", pickupState: "recogido", at: entregado, delayed };
  }

  const reparto = hit(s.reparto);
  if (reparto) {
    return { deliveryStatus: "en_ruta", pickupState: "en_reparto", at: reparto, delayed };
  }

  const destino = hit(s.destino);
  if (destino) {
    // Llegó a la agencia de destino: el paquete espera al cliente. La guía sigue
    // VIVA (`pendiente`), no en ruta — es exactamente el criterio que ya usa el
    // adaptador de reportes de agencia para Shalom y Olva.
    return { deliveryStatus: "pendiente", pickupState: "disponible_para_recojo", at: destino, delayed };
  }

  const transito = hit(s.transito);
  if (transito) {
    return { deliveryStatus: "en_ruta", pickupState: "en_transito", at: transito, delayed };
  }

  const origen = hit(s.origen);
  if (origen) {
    return { deliveryStatus: "pendiente", pickupState: "registrado_en_agencia", at: origen, delayed };
  }

  // Solo `registrado` —o ningún hito— significa que la guía existe pero el
  // paquete no ha salido: es el estado con el que nace al crearla.
  return { deliveryStatus: "pendiente", pickupState: "pendiente_de_envio", at: hit(s.registrado), delayed };
}

/**
 * ¿Cambió algo que merezca escribir en la base?
 *
 * El cron corre cada pocos minutos sobre las mismas guías, y la inmensa mayoría
 * de las pasadas no traen novedad. Sin esta comparación cada pasada tocaría cada
 * fila, ensuciaría `updated_at` —que el Master usa para ordenar por movimiento—
 * y llenaría la línea de tiempo de eventos idénticos.
 */
export function shalomTrackingChanged(
  current: { delivery_status: string; pickup_state: string | null },
  next: ShalomTrackingSnapshot,
): boolean {
  return (
    current.delivery_status !== next.deliveryStatus || (current.pickup_state ?? null) !== next.pickupState
  );
}

/** Estados en los que ya no vale la pena volver a preguntar por una guía. */
const TERMINAL = new Set(["entregado", "anulado", "transferido"]);

export function shalomNeedsTracking(delivery_status: string): boolean {
  return !TERMINAL.has(delivery_status);
}
