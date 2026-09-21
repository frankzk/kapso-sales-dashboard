// Traducción del rastreo público de Olva a los estados del Master (§12).
//
// PURO Y TESTEADO: no toca red ni base. La red vive en `client.ts` y en el cron;
// acá está la única lógica que puede equivocarse de verdad: qué significa cada
// estado que Olva escribe.
//
// DE DÓNDE SALE. Olva no tiene API para clientes. Su página de seguimiento
// (tracking.olvaexpress.pe) llama a `getTrackingInformation?details=1` y pinta
// el resultado; la respuesta trae un bloque `general` con el estado vigente
// (`nombre_estado_tracking`) y un `details[]` con el historial, más reciente
// primero. Las formas de abajo son las de dos respuestas reales del 20-09-2026:
// un envío en camino y uno entregado.
//
// GANA EL ESTADO QUE OLVA DICE QUE ES EL VIGENTE, no el "más avanzado" como en
// Shalom. La diferencia no es de gusto: en el caso entregado, el paquete se
// ASIGNÓ a un operador el 09/09, se CONFIRMÓ EN TIENDA el 10/09 y se volvió a
// ASIGNAR el 12/09. Con una escalera de hitos, «asignado» ganaría a «en tienda»
// desde el 09/09 y el Master diría «en reparto» tres días mientras el paquete
// esperaba en el mostrador. Olva sí sabe cuál es el vigente: es el que enseña.

/** Una fila de `details[]`: un movimiento, con su fecha (solo día) y su sede. */
export interface OlvaTrackingDetail {
  fecha_creacion?: string | null;
  id_rpt_envio_ruta?: string | number | null;
  nombre_sede?: string | null;
  estado_tracking?: string | null;
  obs?: string | null;
}

/** El bloque `general`: el estado vigente y la ficha del envío. */
export interface OlvaTrackingGeneral {
  nombre_estado_tracking?: string | null;
  nombre_estado?: string | null;
  fecha_envio?: string | null;
  fecha_emision_fresh?: string | null;
  emision?: string | null;
  remito?: string | null;
  origen?: string | null;
  destino?: string | null;
  consignado?: string | null;
  nombre_oficina?: string | null;
  flg_devolucion?: unknown;
}

export interface OlvaTrackingPayload {
  success?: boolean;
  msg?: string;
  data?: {
    general?: OlvaTrackingGeneral | null;
    details?: OlvaTrackingDetail[] | null;
  } | null;
}

export interface OlvaTrackingSnapshot {
  /** `shipments.delivery_status` */
  deliveryStatus: "pendiente" | "en_ruta" | "entregado";
  /** `shipments.pickup_state` — el flujo de agencia (§12). */
  pickupState: string;
  /** Fecha del movimiento que decidió el estado (ISO, mediodía de Lima). */
  at: string | null;
  /** El estado tal como lo escribió Olva, para guardarlo crudo. */
  rawStatus: string | null;
  /**
   * Falso cuando Olva dice un estado que Kapta no conoce. Entonces NO se toca
   * `pickup_state`: se anota el crudo y el cron lo reporta para añadirlo aquí.
   * Inventar una traducción es peor que no tener ninguna.
   */
  known: boolean;
  /** Olva marcó el envío como devolución (`flg_devolucion`). */
  returnFlagged: boolean;
  /** «NUEVO PROGRESO - HUAYRANGA S/N», si el movimiento en tienda lo trajo. */
  agencyBranch: string | null;
}

/**
 * Días que Olva guarda el paquete en la oficina de destino antes de devolverlo
 * (MOM §12: «Plazo: 6 días desde disponibilidad en agencia destino»). Shalom
 * da 28; con Olva la ventana es cuatro veces más corta, y por eso el rastreo
 * automático importa más aquí que allá.
 */
export const OLVA_PICKUP_WINDOW_DAYS = 6;

/** Enlace público al seguimiento, para el drawer. */
export const OLVA_TRACKING_URL = "https://tracking.olvaexpress.pe/";

export interface OlvaTrackingId {
  /** Solo dígitos: «2552504». */
  tracking: string;
  /** Los dos dígitos del año de emisión: «26». */
  emision: string;
}

/** «2552504-26», como lo enseña la página de Olva y lo trae el correo. */
export function formatOlvaTracking(id: OlvaTrackingId): string {
  return `${id.tracking}-${id.emision}`;
}

/**
 * Lee el tracking tal como llega, que es de tres formas distintas: la página
 * de Olva enseña «2552504 - 26», el correo de confirmación escribe
 * «26-2552504», y quien teclea a mano pone cualquiera de las dos o el número a
 * secas con el año aparte. Se acepta todo eso y se normaliza a UNA forma.
 *
 * Distinguir el año del número no es adivinar: el año son SIEMPRE dos dígitos
 * y el número siempre más. Sin año en el texto se usa `defaultEmision` (el año
 * actual a dos dígitos), que es lo que la página de Olva preselecciona.
 */
export function parseOlvaTracking(
  raw: string | null | undefined,
  defaultEmision?: string | null,
): { ok: true; value: OlvaTrackingId } | { ok: false; error: string } {
  const text = (raw ?? "").trim();
  if (!text) return { ok: false, error: "Ingresa el número de tracking de Olva." };

  const parts = text
    .split(/[\s\-/_.]+/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length > 2 || parts.some((p) => !/^\d+$/.test(p))) {
    return {
      ok: false,
      error: "El tracking de Olva son solo dígitos, con el año a dos cifras: «2552504-26» o «26-2552504».",
    };
  }

  let tracking: string | null = null;
  let emision: string | null = null;
  const a = parts[0] ?? "";
  const b = parts[1] ?? "";
  if (parts.length === 2) {
    if (a.length === 2 && b.length > 2) {
      emision = a;
      tracking = b;
    } else if (b.length === 2 && a.length > 2) {
      tracking = a;
      emision = b;
    } else {
      return {
        ok: false,
        error: "No se distingue el año del número: el año de emisión son dos dígitos («26»).",
      };
    }
  } else {
    tracking = a || null;
    emision = (defaultEmision ?? "").trim() || null;
  }

  if (!tracking || tracking.length < 4 || tracking.length > 12) {
    return { ok: false, error: "El número de tracking de Olva tiene entre 4 y 12 dígitos." };
  }
  if (!emision || !/^\d{2}$/.test(emision)) {
    return { ok: false, error: "Falta el año de emisión a dos dígitos («26»)." };
  }
  return { ok: true, value: { tracking, emision } };
}

type Known = {
  deliveryStatus: OlvaTrackingSnapshot["deliveryStatus"];
  pickupState: string;
};

/**
 * Los estados que Olva escribe y lo que significan aquí. Todo lo de Lima antes
 * del despacho es «registrado en agencia»: la caja ya está en manos de Olva y
 * todavía no viaja. Se listan uno a uno en vez de "lo que no sea otra cosa"
 * para que un estado nuevo caiga en `known: false` y no en un cajón.
 */
const KNOWN: Record<string, Known> = {
  // Origen: la caja entró a Olva y se está procesando en Lima.
  REGISTRADO: { deliveryStatus: "pendiente", pickupState: "registrado_en_agencia" },
  "RECEPCION TIENDA": { deliveryStatus: "pendiente", pickupState: "registrado_en_agencia" },
  "TRACKING EN GUIA": { deliveryStatus: "pendiente", pickupState: "registrado_en_agencia" },
  "RECEPCION GUIA": { deliveryStatus: "pendiente", pickupState: "registrado_en_agencia" },
  "PRE VALIJA": { deliveryStatus: "pendiente", pickupState: "registrado_en_agencia" },
  "EN VALIJA": { deliveryStatus: "pendiente", pickupState: "registrado_en_agencia" },
  // Salió de Lima hacia el destino: «En camino» en la página de Olva.
  DESPACHADO: { deliveryStatus: "en_ruta", pickupState: "en_transito" },
  // Llegó a la oficina de destino: el paquete espera. La guía sigue VIVA
  // (`pendiente`), igual que `destino` en Shalom. Desde aquí corren los 6 días.
  "CONFIRMACION EN TIENDA": { deliveryStatus: "pendiente", pickupState: "disponible_para_recojo" },
  // Un operador de Olva salió con el paquete a entregarlo a domicilio.
  ASIGNADO: { deliveryStatus: "en_ruta", pickupState: "en_reparto" },
  // Terminal. `entregado` o `recogido` se decide abajo.
  ENTREGADO: { deliveryStatus: "entregado", pickupState: "entregado" },
};

function clean(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim().replace(/\s+/g, " ") : null;
}

/**
 * Olva fecha los movimientos solo con el día («2026-09-12»). Se ancla al
 * mediodía de Lima: a medianoche UTC el día ya habría cambiado en Perú y el
 * movimiento se fecharía la víspera.
 */
export function olvaDateToIso(fecha: string | null | undefined): string | null {
  const text = (fecha ?? "").trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(text);
  if (m) {
    const [, y, mo, d, hh, mi, ss] = m;
    return `${y}-${mo}-${d}T${hh ?? "12"}:${mi ?? "00"}:${ss ?? "00"}-05:00`;
  }
  m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(text);
  if (m) {
    const [, d, mo, y] = m;
    return `${y}-${mo}-${d}T12:00:00-05:00`;
  }
  return null;
}

/** «… _|_ Nombre Oficina : NUEVO PROGRESO - HUAYRANGA S/N _|_ …» → la oficina. */
export function olvaBranchFromObs(obs: string | null | undefined): string | null {
  const text = obs ?? "";
  const m = /Nombre Oficina\s*:\s*([^_|]+?)\s*(?:_\|_|$)/i.exec(text);
  return m ? clean(m[1]) : null;
}

/**
 * El estado vigente según Olva y el movimiento que lo produjo.
 *
 * El vigente es `general.nombre_estado_tracking`; si faltara, el primer
 * `details` (Olva los manda del más reciente al más antiguo). La fecha sale del
 * movimiento más reciente con ese mismo estado — y ahí sí se mira el orden
 * real, `id_rpt_envio_ruta` descendente, por si algún día llegaran mezclados.
 */
export function readOlvaTracking(payload: OlvaTrackingPayload | null | undefined): OlvaTrackingSnapshot {
  const general = payload?.data?.general ?? null;
  const details = Array.isArray(payload?.data?.details) ? payload!.data!.details! : [];

  const sorted = [...details].sort((a, b) => Number(b.id_rpt_envio_ruta ?? 0) - Number(a.id_rpt_envio_ruta ?? 0));
  const rawStatus = clean(general?.nombre_estado_tracking)?.toUpperCase() ?? clean(sorted[0]?.estado_tracking)?.toUpperCase() ?? null;
  const flag = general?.flg_devolucion;
  const returnFlagged = flag != null && flag !== "" && flag !== 0 && flag !== "0" && flag !== false;

  const movement = rawStatus ? sorted.find((d) => clean(d.estado_tracking)?.toUpperCase() === rawStatus) ?? null : null;
  const at = olvaDateToIso(movement?.fecha_creacion) ?? olvaDateToIso(general?.fecha_emision_fresh);

  const inStore = sorted.find((d) => clean(d.estado_tracking)?.toUpperCase() === "CONFIRMACION EN TIENDA");
  const agencyBranch = olvaBranchFromObs(inStore?.obs);

  const known = rawStatus ? KNOWN[rawStatus] : undefined;
  if (!known) {
    // Sin estado, o con uno que no se conoce: la guía existe y no se sabe más.
    // El cron deja `pickup_state` como está y reporta el crudo.
    return {
      deliveryStatus: "pendiente",
      pickupState: "pendiente_de_envio",
      at,
      rawStatus,
      known: false,
      returnFlagged,
      agencyBranch,
    };
  }

  let pickupState = known.pickupState;
  if (rawStatus === "ENTREGADO") {
    // Olva entrega de dos maneras: en el mostrador de su oficina —la clienta
    // RECOGE— o a domicilio por un operador. Si en el historial hubo un
    // operador ASIGNADO, fue a domicilio; si no, lo recogió. Es la misma
    // distinción que el Master hace entre `entregado` y `recogido`.
    const wentOut = sorted.some((d) => clean(d.estado_tracking)?.toUpperCase() === "ASIGNADO");
    pickupState = wentOut ? "entregado" : "recogido";
  }

  return {
    deliveryStatus: known.deliveryStatus,
    pickupState,
    at,
    rawStatus,
    known: true,
    returnFlagged,
    agencyBranch,
  };
}

/**
 * ¿Cambió algo que merezca escribir en la base? Mismo criterio que Shalom: el
 * cron pasa cada media hora por las mismas guías y casi nunca hay novedad; sin
 * esto cada pasada tocaría cada fila y llenaría la línea de tiempo de eventos
 * idénticos. El estado crudo cuenta: «PRE VALIJA» → «EN VALIJA» no mueve el
 * `pickup_state`, pero sí es un movimiento nuevo que vale guardar.
 */
export function olvaTrackingChanged(
  current: { delivery_status: string; pickup_state: string | null; olva_status: string | null },
  next: OlvaTrackingSnapshot,
): boolean {
  if ((current.olva_status ?? null) !== next.rawStatus) return true;
  if (!next.known) return false;
  return (
    current.delivery_status !== next.deliveryStatus || (current.pickup_state ?? null) !== next.pickupState
  );
}

/** Estados en los que ya no vale la pena volver a preguntar por una guía. */
const TERMINAL = new Set(["entregado", "anulado", "transferido"]);

export function olvaNeedsTracking(delivery_status: string): boolean {
  return !TERMINAL.has(delivery_status);
}

/** Hasta cuándo Olva guarda el paquete, contando desde que llegó a destino. */
export function olvaPickupDeadline(arrivedAtIso: string, days: number = OLVA_PICKUP_WINDOW_DAYS): string | null {
  const t = Date.parse(arrivedAtIso);
  if (!Number.isFinite(t)) return null;
  return new Date(t + days * 24 * 3600 * 1000).toISOString();
}
