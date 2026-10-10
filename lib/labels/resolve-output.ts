// Qué hacer con un pedido cuando el almacén pide su rótulo.
//
// El almacén no quiere "crear una salida": quiere el rótulo. La salida es una
// consecuencia interna. Este módulo decide, por pedido, si hay que reusar una
// salida existente, crear una nueva, o parar porque el MOM exige justificación.
//
// Puro y testeado: es la regla de negocio, no puede vivir dentro de un handler.

// LA SALIDA QUE YA NO ENTREGÓ (09-10-2026, decisión del owner). #AUR177756:
// Tanders no entregó su S01 y la caja volvió. Al reprogramar por llamada el
// equipo reimprimió el rótulo de Tanders —«Descargar rótulos» respondía «Tiene
// 1 salida todavía en la calle»—, armó la caja con él y Grupo GF, al tomarlo,
// creó una S02 cuyo rótulo nadie imprimió: en «Verificar caja» el QR de la caja
// era el de la S01 y no cuadraba. Una salida que su courier ya dio por no
// entregada (`guideFailedAfterDispatch`: Tanders RETURNING/RETURNED, Swayp
// Devolución, anulada después de salir) no está «en la calle»: nadie la
// trabaja. Pedir el rótulo crea la salida nueva con su QR, y el motivo lo
// escribe el sistema porque el hecho ya lo reportó el courier. Ese rótulo es el
// que se pega sobre la caja que volvió (MOM §9.3, §28).
//
// SOLO EN LIMA. Fuera de Lima no cambia nada: la Swayp en Devolución de un
// pedido de provincia la gestiona Reproprovincia con «Reenviar por Swayp»
// (§11), y una «por definir» lo sacaría de esa cola con un rótulo para una
// caja que vuelve a la bodega de Swayp, no a la nuestra.

import { guideFailedAfterDispatch } from "@/lib/reproprovincia";

/** Salida vista desde la decisión de rotular. */
export interface OutputForDecision {
  id: string;
  custody_state: string | null;
  delivery_status: string | null;
  created_at: string | null;
  output_number: number | null;
  /** Lo que hace falta para saber si su courier ya la dio por no entregada. */
  courier?: string | null;
  output_code?: string | null;
  reported_status?: string | null;
  swayp_state?: number | null;
  dispatched_at?: string | null;
  returned_at?: string | null;
}

/** Dónde se decide. Sin `lima`, la regla es la de siempre (fuera de Lima, §11). */
export interface LabelDecisionContext {
  lima?: boolean;
}

/** La salida que su courier no entregó y motiva la nueva, para el motivo. */
export interface FailedOutputForLabel {
  shipmentId: string;
  outputCode: string | null;
  courier: string;
  /** La caja ya volvió (recibida, o el courier dice que volvió). */
  returned: boolean;
}

export type LabelDecision =
  /** Ya hay una salida con nosotros: se reimprime esa, no se crea otra. */
  | { kind: "reuse"; shipmentId: string }
  /**
   * No hay nada que estorbe: se crea una salida y se imprime. `afterFailure`
   * nombra la última salida que su courier no entregó: la nueva es su
   * reprogramación y lleva motivo automático.
   */
  | { kind: "create"; afterFailure?: FailedOutputForLabel }
  /**
   * Hay una salida activa fuera de la empresa: crear otra son dos paquetes del
   * mismo pedido circulando a la vez, y el MOM (§23) exige justificación
   * auditada. No se hace en automático.
   */
  | { kind: "needs_justification"; activeOutputs: number };

/** Los estados de una salida que sigue viva. */
const LIVE_STATUSES = ["pendiente", "en_ruta", "por_preparar"];

/** ¿Su courier ya la dio por no entregada? La regla única de lib/reproprovincia.ts. */
export function isFailedOutput(output: OutputForDecision): boolean {
  return guideFailedAfterDispatch({
    courier: output.courier ?? "",
    delivery_status: output.delivery_status ?? "",
    reported_status: output.reported_status ?? null,
    swayp_state: output.swayp_state ?? null,
    dispatched_at: output.dispatched_at ?? null,
    returned_at: output.returned_at ?? null,
  });
}

/**
 * Una salida está ACTIVA mientras el intento de entrega sigue vivo. Una salida
 * devuelta NO cuenta: el paquete ya volvió, y rearmarlo es reprogramación
 * normal (Reproprovincia, reintento en Lima), no una salida simultánea. En
 * Lima tampoco la que su courier ya dio por no entregada aunque siga `en_ruta`:
 * la caja vuelve y nadie la trabaja.
 */
export function isActiveOutput(output: OutputForDecision, ctx: LabelDecisionContext = {}): boolean {
  return (
    output.custody_state !== "devuelto" &&
    LIVE_STATUSES.includes(output.delivery_status ?? "") &&
    !(ctx.lima && isFailedOutput(output))
  );
}

/**
 * Sigue en nuestras manos y viva: es la que se rotula y se arma. La custodia
 * sola no basta: anular una «por definir» la deja en `empresa`, y lo mismo
 * pasa con filas antiguas entregadas o `transferido` (la madre de un reenvío
 * Swayp, #KP134300). Reimprimirlas daba el rótulo de una salida muerta. Tampoco
 * la que no entregó su courier: su rótulo ya no es el de la caja que sale
 * (§9.3).
 */
export function isWithCompany(output: OutputForDecision): boolean {
  return (
    output.custody_state === "empresa" &&
    LIVE_STATUSES.includes(output.delivery_status ?? "") &&
    !isFailedOutput(output)
  );
}

/** ¿`output` nació después de `ref`? Por fecha de creación y, sin ella, por consecutivo. */
function bornAfter(output: OutputForDecision, ref: OutputForDecision): boolean {
  if (output.created_at && ref.created_at && output.created_at !== ref.created_at) return output.created_at > ref.created_at;
  return (output.output_number ?? 0) > (ref.output_number ?? 0);
}

function mostRecent(outputs: readonly OutputForDecision[]): OutputForDecision | null {
  if (!outputs.length) return null;
  return [...outputs].sort((a, b) => {
    const ac = a.created_at ?? "";
    const bc = b.created_at ?? "";
    if (ac !== bc) return ac < bc ? 1 : -1;
    return (b.output_number ?? 0) - (a.output_number ?? 0);
  })[0]!;
}

/**
 * Decide qué hacer para poder imprimir el rótulo de un pedido.
 *
 * El orden importa: reusar gana a crear, para que pulsar dos veces el botón no
 * queme el límite de cinco salidas del pedido (§4).
 */
export function decideLabelAction(outputs: readonly OutputForDecision[], ctx: LabelDecisionContext = {}): LabelDecision {
  const withCompany = outputs.filter(isWithCompany);
  const reusable = mostRecent(withCompany);
  if (reusable) return { kind: "reuse", shipmentId: reusable.id };

  const active = outputs.filter((output) => isActiveOutput(output, ctx));
  if (active.length) return { kind: "needs_justification", activeOutputs: active.length };

  // La última que no entregó su courier: un hecho que consta, sea cual sea lo
  // que vino después (una «por definir» anulada, por ejemplo). Si sigue
  // `en_ruta`, crear la nueva sin motivo lo rechazaría la puerta de §23.
  const last = ctx.lima ? mostRecent(outputs.filter(isFailedOutput)) : null;
  if (last) {
    return {
      kind: "create",
      afterFailure: {
        shipmentId: last.id,
        outputCode: last.output_code ?? null,
        courier: last.courier ?? "",
        returned: Boolean(last.returned_at) || last.custody_state === "devuelto",
      },
    };
  }
  return { kind: "create" };
}

/**
 * Las salidas vivas que nacieron después de `failed` y no fallaron: con una de
 * ellas sale la caja que volvió. La comparten la ficha y los escáneres.
 */
export function newerLiveSiblings<T extends OutputForDecision>(outputs: readonly T[], failed: OutputForDecision): T[] {
  return outputs.filter((output) =>
    output.id !== failed.id &&
    !isFailedOutput(output) &&
    LIVE_STATUSES.includes(output.delivery_status ?? "") &&
    output.custody_state !== "devuelto" &&
    bornAfter(output, failed));
}

/** Lo que la ficha del pedido enseña de una salida que su courier no entregó. */
export interface ReprogramLabelState {
  failed: FailedOutputForLabel;
  /**
   * La salida viva con la que sale ahora la caja, si ya existe: su rótulo es el
   * que va encima. Sin ella, la ficha ofrece imprimir el de la salida nueva.
   */
  live: { shipmentId: string; outputCode: string | null } | null;
  /**
   * Sin `live`: una salida viva ANTERIOR a la que falló que sigue abierta
   * (#KP134960, una de Grupo GF del 17-09 sin cerrar). Mientras exista, pedir
   * el rótulo responde «todavía en la calle»: hay que cerrarla o anularla antes.
   */
  open: { shipmentId: string; outputCode: string | null } | null;
}

/**
 * ¿El pedido tiene una salida que su courier no entregó, y con qué sale ahora?
 * null si ninguna falló. La misma regla que `decideLabelAction`, para la ficha.
 * Solo cuenta como «con qué sale» una salida viva NACIDA DESPUÉS de la que
 * falló: una anterior que sigue abierta (#KP134960, una de Grupo GF del 17-09
 * sin cerrar) no es la caja que volvió.
 */
export function reprogramLabelState(outputs: readonly OutputForDecision[]): ReprogramLabelState | null {
  const failed = mostRecent(outputs.filter(isFailedOutput));
  if (!failed) return null;
  const live = mostRecent(newerLiveSiblings(outputs, failed));
  const open = live ? null : mostRecent(outputs.filter((output) =>
    output.id !== failed.id &&
    !isFailedOutput(output) &&
    LIVE_STATUSES.includes(output.delivery_status ?? "") &&
    output.custody_state !== "devuelto"));
  return {
    failed: {
      shipmentId: failed.id,
      outputCode: failed.output_code ?? null,
      courier: failed.courier ?? "",
      returned: Boolean(failed.returned_at) || failed.custody_state === "devuelto",
    },
    live: live ? { shipmentId: live.id, outputCode: live.output_code ?? null } : null,
    open: open ? { shipmentId: open.id, outputCode: open.output_code ?? null } : null,
  };
}

/** Cuántos pedidos se nombran en un aviso antes de resumir. El aviso es un
 *  toast: nombrarlos todos en una tanda de 50 lo volvería ilegible, y no
 *  nombrar ninguno es lo que había — el número sin el "cuáles", que es la
 *  primera pregunta de quien lo lee. */
export const MAX_NAMED = 5;

/**
 * "#A, #B y 3 más" — nombra los primeros y dice cuántos quedan.
 *
 * La cola importa: sin ella una lista recortada se lee como completa, y quien
 * la mira se queda tranquilo creyendo que vio todo. Pura.
 */
export function listNames(names: readonly string[]): string {
  if (names.length <= MAX_NAMED) return names.join(", ");
  return `${names.slice(0, MAX_NAMED).join(", ")} y ${names.length - MAX_NAMED} más`;
}
