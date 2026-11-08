// La guía Shalom muerta y la que la reemplaza (MOM §12, «La guía muerta y la
// que se creó a mano en su lugar», 08-11-2026; 0321). PURO: ni red ni base. La
// escritura está en lib/shalom/register-guide.ts, el camino único del drawer y
// de Cotejar Shalom.
//
// EL CASO. #KP201035 tiene en Kapta la guía 102321353 (código HWND), creada por
// API el 01-11-2026, y el rastreo de Shalom contesta `not_found` por ella. En
// Shalom Pro hay OTRA guía para la misma clienta (mismo DNI): 102371814, código
// W9NH, creada a mano el 04-11 y ya «En destino». En Kapta no está en ningún
// sitio: la caja sí salió, pero con una guía que Kapta no rastrea ni avisa.
// Pasa con las 38 guías recreadas el 03-11 tras el corte de luz de Shalom Breña
// y con otras que vencieron antes.
//
// Cotejar Shalom no la vinculaba nunca: solo busca pedidos sin salida viva, y
// la guía muerta sigue `pendiente`. Y el drawer pedía anularla primero, con una
// llamada a Shalom que no puede borrar lo que Shalom ya no tiene.
//
// LA REGLA. Una guía viva de Shalom cuyo rastreo confirmó que Shalom no la
// conoce («Guía Shalom no reconocida», lib/shalom/check-queue.ts: 6 consultas
// `not_found` seguidas y 24 h) cuenta como MUERTA:
//   * deja de impedir que se registre la guía que de verdad lleva la caja;
//   * al registrar esa guía, la muerta se anula en Kapta con la misma forma
//     que «Anular guía Shalom» (y sin llamar a Shalom), en el mismo paso;
//   * si no hay una guía que la reemplace sin duda, no se toca: solo se ve.

import { isFillableRouteOutput, restoredRouteOutputPatch } from "@/lib/shipment-output";
import { shalomUnrecognized, type ShalomNotFoundState } from "@/lib/shalom/check-queue";

/** Guías que ya cubren el pedido: crear otra encima duplica el despacho. */
export const ACTIVE_GUIDE_STATUSES = new Set(["pendiente", "en_ruta", "por_preparar"]);

/** Lo que hace falta de una salida para saber si es una guía muerta y retirarla. */
export interface DeadGuideCandidate extends ShalomNotFoundState {
  id: string;
  courier: string;
  guide_code: string | null;
  delivery_status: string;
  created_via: string | null;
  custody_state: string | null;
  custody_transferred_at: string | null;
}

/** Las columnas que se leen para retirarla y, si algo falla, devolverla como estaba. */
export const DEAD_GUIDE_COLUMNS =
  "id,order_id,courier,guide_code,delivery_status,status_category,pickup_state,created_via,custody_state," +
  "custody_transferred_at,agency_branch,shalom_codigo,shalom_serie,shalom_ose_id,shalom_order_id,shalom_raw," +
  "last_report_at,shalom_checked_at,shalom_not_found_since,shalom_not_found_count,created_at";

/** Una salida tal como se leyó: lo que se retira y lo que se restaura. */
export interface DeadGuideRow extends DeadGuideCandidate {
  order_id: string | null;
  status_category: string | null;
  pickup_state: string | null;
  agency_branch: string | null;
  shalom_codigo: string | null;
  shalom_serie: string | null;
  shalom_ose_id: number | null;
  shalom_order_id: number | null;
  shalom_raw: Record<string, unknown> | null;
  last_report_at: string | null;
  shalom_checked_at: string | null;
  created_at: string | null;
}

/**
 * ¿Es una guía de Shalom viva que Shalom confirmó que no conoce? La salida «por
 * definir» nunca: es la caja esperando courier, no una guía.
 */
export function isConfirmedDeadShalomGuide(g: DeadGuideCandidate, now: number = Date.now()): boolean {
  if ((g.courier ?? "").trim().toLowerCase() !== "shalom") return false;
  if (!ACTIVE_GUIDE_STATUSES.has(g.delivery_status)) return false;
  if (isFillableRouteOutput(g)) return false;
  return shalomUnrecognized(g, now);
}

export interface DeadGuidePlan<T> {
  /** Las guías muertas que se anulan al registrar la nueva. */
  retire: T[];
  /** Otra salida viva que impide registrar la guía: se dice y no se hace nada. */
  blocking: T | null;
}

/**
 * Qué hacer con las salidas vivas del pedido al registrar `newGuideCode`.
 *
 * La propia guía no cuenta (reenviar el formulario es idempotente). Una muerta
 * se retira solo si quien llama lo pide (`replaceDead`) y, si dice cuál
 * (`only`), solo esa: el cron reemplaza la guía que cotejó, no otra. Cualquier
 * otra salida viva bloquea, como siempre.
 */
export function planDeadGuideReplacement<T extends DeadGuideCandidate>(
  active: readonly T[],
  newGuideCode: string,
  opts: { replaceDead: boolean; only?: string | null; now?: number },
): DeadGuidePlan<T> {
  const own = newGuideCode.trim().toUpperCase();
  const now = opts.now ?? Date.now();
  const retire: T[] = [];
  let blocking: T | null = null;
  for (const g of active) {
    if ((g.guide_code ?? "").trim().toUpperCase() === own) continue;
    const retirable =
      opts.replaceDead && isConfirmedDeadShalomGuide(g, now) && (!opts.only || g.id === opts.only);
    if (retirable) retire.push(g);
    else if (!blocking) blocking = g;
  }
  // Con una salida que de verdad estorba no se retira nada: no hay reemplazo.
  return blocking ? { retire: [], blocking } : { retire, blocking: null };
}

/** La nota del `guide_cancelled` de la guía muerta. */
export function deadGuideCancelNote(
  dead: { guide_code: string | null; shalom_codigo?: string | null },
  newGuideCode: string,
  via: "cotejo" | "drawer",
): string {
  const codigo = dead.shalom_codigo ? ` (código ${dead.shalom_codigo})` : "";
  return (
    `Guía Shalom ${dead.guide_code ?? "sin número"}${codigo} no existe en Shalom (no encontrada en el rastreo); ` +
    `reemplazada por la guía ${newGuideCode} creada en Shalom Pro` +
    (via === "cotejo" ? " (Cotejar Shalom)." : ".")
  );
}

/**
 * Cómo queda la guía muerta. La misma forma que «Anular guía Shalom»
 * (`cancelShalomGuide`): si se escribió encima de una salida «por definir»,
 * la salida vuelve a «por definir» —la caja sigue siendo esa y la guía nueva se
 * escribe encima—; si no, `anulado`.
 *
 * Además, la racha y los sellos del rastreo vuelven a cero en la salida que se
 * restaura: la guía nueva que se escriba encima no puede heredar la racha de
 * la muerta (saldría «no reconocida» sin haberla preguntado nunca).
 */
export function deadGuideRetirePatch(
  dead: Pick<DeadGuideRow, "id">,
  orderName: string | null,
  wasFilled: boolean,
  nowIso: string,
): Record<string, unknown> {
  if (wasFilled) {
    return {
      ...restoredRouteOutputPatch(orderName, dead.id),
      shalom_codigo: null,
      shalom_serie: null,
      shalom_ose_id: null,
      shalom_order_id: null,
      shalom_raw: null,
      last_report_at: null,
      shalom_checked_at: null,
      shalom_not_found_since: null,
      shalom_not_found_count: 0,
      updated_at: nowIso,
    };
  }
  return { delivery_status: "anulado", status_category: "closed", pickup_state: null, updated_at: nowIso };
}

/**
 * La salida tal como estaba, por si registrar la guía nueva falla después de
 * retirar la muerta: una guía muerta sin reemplazo no se toca.
 */
export function deadGuideRestorePatch(dead: DeadGuideRow, wasFilled: boolean): Record<string, unknown> {
  const base = {
    delivery_status: dead.delivery_status,
    status_category: dead.status_category,
    pickup_state: dead.pickup_state,
  };
  if (!wasFilled) return base;
  return {
    ...base,
    courier: dead.courier,
    created_via: dead.created_via,
    guide_code: dead.guide_code,
    agency_branch: dead.agency_branch,
    shalom_codigo: dead.shalom_codigo,
    shalom_serie: dead.shalom_serie,
    shalom_ose_id: dead.shalom_ose_id,
    shalom_order_id: dead.shalom_order_id,
    shalom_raw: dead.shalom_raw,
    last_report_at: dead.last_report_at,
    shalom_checked_at: dead.shalom_checked_at,
    shalom_not_found_since: dead.shalom_not_found_since,
    shalom_not_found_count: dead.shalom_not_found_count ?? 0,
  };
}

/** El aviso del drawer cuando la guía viva del pedido es una guía muerta. */
export function deadGuideDrawerWarning(dead: { guide_code: string | null }): string {
  const guide = dead.guide_code ? ` ${dead.guide_code}` : "";
  return (
    `La guía Shalom${guide} no existe en Shalom (el rastreo no la encuentra). ` +
    "Si la caja salió con otra guía creada en Shalom Pro, regístrala en «Ya la creé en Shalom Pro»: " +
    "Kapta anula la que no existe y deja la nueva en su lugar, en el mismo paso."
  );
}
