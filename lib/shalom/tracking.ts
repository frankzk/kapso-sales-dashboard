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
  /**
   * Fecha del hito `destino`: cuándo llegó a la agencia donde se recoge. Ojo:
   * Shalom la mueve mientras el paquete sigue ahí, así que no dice desde cuándo
   * está. Para contar días en la agencia, ver `shalomFirstArrival`.
   */
  arrivedAt: string | null;
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
  const arrivedAt = hit(s.destino);

  const entregado = hit(s.entregado);
  if (entregado) {
    // La entrega en agencia es un recojo del cliente, y ese es el estado
    // operativo que el equipo espera ver en el flujo de Shalom (§10). Salvo
    // cuando no pudo serlo: ver `shalomExitReturnDays`.
    return { deliveryStatus: "entregado", pickupState: "recogido", at: entregado, delayed, arrivedAt };
  }

  const reparto = hit(s.reparto);
  if (reparto) {
    return { deliveryStatus: "en_ruta", pickupState: "en_reparto", at: reparto, delayed, arrivedAt };
  }

  if (arrivedAt) {
    // Llegó a la agencia de destino: el paquete espera al cliente. La guía sigue
    // VIVA (`pendiente`), no en ruta — es exactamente el criterio que ya usa el
    // adaptador de reportes de agencia para Shalom y Olva.
    return { deliveryStatus: "pendiente", pickupState: "disponible_para_recojo", at: arrivedAt, delayed, arrivedAt };
  }

  const transito = hit(s.transito);
  if (transito) {
    return { deliveryStatus: "en_ruta", pickupState: "en_transito", at: transito, delayed, arrivedAt };
  }

  const origen = hit(s.origen);
  if (origen) {
    return { deliveryStatus: "pendiente", pickupState: "registrado_en_agencia", at: origen, delayed, arrivedAt };
  }

  // Solo `registrado` —o ningún hito— significa que la guía existe pero el
  // paquete no ha salido: es el estado con el que nace al crearla.
  return { deliveryStatus: "pendiente", pickupState: "pendiente_de_envio", at: hit(s.registrado), delayed, arrivedAt };
}

// ---------------------------------------------------------------------------
// «Entregado» que no fue un recojo: el retorno por cambio de destino (MOM §12).
//
// EL CASO (03-10-2026). Llegó al almacén la caja de #KP128064 con una etiqueta
// de Shalom «CAMBIO DE DESTINO» rumbo a Lima, y el Master la tenía como
// «Recogido sin pago completo». Shalom no tiene un hito de retorno: cuando saca
// el paquete de la agencia de destino para devolverlo, cierra la guía original
// con fecha en `entregado`, y aquí eso se leía como el recojo de la clienta.
//
// Medido sobre los «recogido» de Shalom de 75 días: 48 salieron de la agencia
// sin que la clave se revelara ni se enviara nunca, sin el saldo pagado y tras
// 15 a 41 días en ella, en tandas de minuto a minuto (22/09 a las 15:25, 15:26
// y 15:27, por ejemplo). Sin clave la clienta no puede recoger, así que eran
// retornos. Los recojos reales sin pago completo salieron a los 1-7 días.
//
// LA LLEGADA QUE CUENTA ES LA PRIMERA (05-10-2026). Shalom mueve la fecha de
// `destino` mientras el paquete sigue en la agencia: la de la última respuesta
// no dice desde cuándo está ahí. Contando con ella, la regla dejó pasar 7
// retornos el 03/10 y el 05/10 —llevaban 36 a 40 días y Shalom decía menos de
// 8—, y los dos que sí detectó los contó en 10 y 8 días cuando llevaban 37 y
// 38. La primera llegada ya está en la línea de tiempo: es el
// `disponible_para_recojo` que el rastreo escribió ese día.
// ---------------------------------------------------------------------------

/**
 * Días en la agencia desde los que una salida sin clave ni cobro es el retorno.
 * Entre los recojos reales (1-7 días) y los retornos (15 o más) queda margen a
 * los dos lados; por debajo, el «recogido» se respeta y la alerta de cobro
 * sigue encendida para que una persona lo mire.
 */
export const SHALOM_RETURN_MIN_DAYS = 8;

/** Lo que el rastreo no dice y hace falta para leer un `entregado`. */
export interface ShalomExitFacts {
  /** El pedido tiene clave de recojo registrada. */
  hasKey: boolean;
  /** La clave se reveló en pantalla o se le envió a la clienta, alguna vez. */
  keyGiven: boolean;
  /** Hay rastro de cobro: el mismo criterio que la alerta de cobro del Master. */
  collected: boolean;
  /**
   * La primera vez que esta guía quedó en la agencia según la línea de tiempo,
   * o null si el rastreo nunca la vio llegar.
   */
  firstArrivalAt: string | null;
}

function shalomInstant(fecha: string | null): number | null {
  if (!fecha) return null;
  // Shalom fecha como «2026-04-16 11:40:45», sin zona. Las fechas que se restan
  // salen todas de Shalom: de la misma respuesta, o la llegada que el rastreo
  // guardó tal cual en la línea de tiempo y que la base devuelve con `+00:00`.
  // Basta leerlas igual: sin zona, como UTC.
  let iso = fecha.trim().replace(" ", "T");
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) iso += "T00:00:00";
  const zoned = /(?:[zZ]|[+-]\d{2}:?\d{2})$/.test(iso);
  const ms = Date.parse(zoned ? iso : `${iso}Z`);
  return Number.isFinite(ms) ? ms : null;
}

/** Días enteros entre la llegada a la agencia y el hito que decidió el estado. */
export function shalomDaysAtAgency(snapshot: Pick<ShalomTrackingSnapshot, "arrivedAt" | "at">): number | null {
  const from = shalomInstant(snapshot.arrivedAt);
  const to = shalomInstant(snapshot.at);
  if (from == null || to == null || to < from) return null;
  return Math.floor((to - from) / 86_400_000);
}

/**
 * Desde cuándo está el paquete en la agencia: la más antigua entre la llegada
 * que quedó en la línea de tiempo y la que manda Shalom ahora. Una fecha que no
 * se puede leer no cuenta.
 */
export function shalomFirstArrival(shalomSays: string | null, timeline: string | null): string | null {
  const said = shalomInstant(shalomSays);
  const seen = shalomInstant(timeline);
  if (seen == null) return said == null ? null : shalomSays;
  if (said == null) return timeline;
  return seen < said ? timeline : shalomSays;
}

/**
 * ¿Este `entregado` es el retorno y no un recojo? Si lo es, devuelve los días
 * que el paquete pasó en la agencia —la prueba que queda en la línea de
 * tiempo—; si no, null.
 *
 * Todas a la vez, y cada una cierra una puerta distinta:
 *   - Tiene clave y nunca se dio: sin ella no se recoge en el mostrador. Sin
 *     clave registrada no hay nada que lo pruebe, y se respeta lo que dice Shalom.
 *   - No está cobrado: a quien pagó se le libera la clave.
 *   - Pasó `SHALOM_RETURN_MIN_DAYS` o más en la agencia, contados desde la
 *     PRIMERA llegada. Si ninguna llegada consta, no se adivina.
 */
export function shalomExitReturnDays(snapshot: ShalomTrackingSnapshot, facts: ShalomExitFacts): number | null {
  if (snapshot.deliveryStatus !== "entregado") return null;
  if (!facts.hasKey || facts.keyGiven || facts.collected) return null;
  const days = shalomDaysAtAgency({
    arrivedAt: shalomFirstArrival(snapshot.arrivedAt, facts.firstArrivalAt),
    at: snapshot.at,
  });
  return days != null && days >= SHALOM_RETURN_MIN_DAYS ? days : null;
}

/** Lo que el cron escribe en la guía y en la línea de tiempo por un hito. */
export interface ShalomGuideWrite {
  patch: {
    delivery_status: string;
    status_category: string;
    pickup_state: string;
    custody_state?: string;
    closed_at?: string | null;
  };
  event: {
    new_status: string;
    new_operational: string;
    note: string;
    payload: Record<string, unknown>;
  };
}

/**
 * La escritura de un hito. `returnDays` son los días en la agencia cuando el
 * `entregado` es el retorno (`shalomExitReturnDays`), y null en cualquier otro
 * caso.
 *
 * Un retorno no es un recojo: la guía original muere (`anulado`, y el cron deja
 * de preguntar por ella) y la caja viene de vuelta (`retorno`), así que el
 * pedido pasa a «Por cerrar · Devolución física pendiente» y se espera en
 * Devoluciones hasta que alguien la escanee.
 */
export function shalomGuideWrite(snapshot: ShalomTrackingSnapshot, returnDays: number | null): ShalomGuideWrite {
  const demora = snapshot.delayed ? " (con demora declarada)" : "";
  if (returnDays == null) {
    return {
      patch: {
        delivery_status: snapshot.deliveryStatus,
        status_category: snapshot.deliveryStatus === "entregado" ? "delivered" : "pending",
        pickup_state: snapshot.pickupState,
      },
      event: {
        new_status: snapshot.deliveryStatus,
        new_operational: snapshot.pickupState,
        note: `Shalom: ${snapshot.pickupState}${demora}.`,
        payload: {},
      },
    };
  }
  return {
    patch: {
      delivery_status: "anulado",
      status_category: "closed",
      pickup_state: "retorno_iniciado",
      custody_state: "retorno",
      closed_at: snapshot.at,
    },
    event: {
      new_status: "anulado",
      new_operational: "retorno_iniciado",
      note:
        `Shalom: retorno_iniciado${demora}. Lo dio por «entregado» tras ${returnDays} días en la agencia, ` +
        "sin que la clienta tuviera la clave ni pagara el saldo: es el retorno (cambio de destino), no un recojo.",
      payload: { shalom_dice: "entregado", dias_en_agencia: returnDays, regla: "retorno_sin_clave" },
    },
  };
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
  next: { deliveryStatus: string; pickupState: string },
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
