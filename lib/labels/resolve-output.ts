// Qué hacer con un pedido cuando el almacén pide su rótulo.
//
// El almacén no quiere "crear una salida": quiere el rótulo. La salida es una
// consecuencia interna. Este módulo decide, por pedido, si hay que reusar una
// salida existente, crear una nueva, o parar porque el MOM exige justificación.
//
// Puro y testeado: es la regla de negocio, no puede vivir dentro de un handler.

/** Salida vista desde la decisión de rotular. */
export interface OutputForDecision {
  id: string;
  custody_state: string | null;
  delivery_status: string | null;
  created_at: string | null;
  output_number: number | null;
}

export type LabelDecision =
  /** Ya hay una salida con nosotros: se reimprime esa, no se crea otra. */
  | { kind: "reuse"; shipmentId: string }
  /** No hay nada que estorbe: se crea una salida y se imprime. */
  | { kind: "create" }
  /**
   * Hay una salida activa fuera de la empresa: crear otra son dos paquetes del
   * mismo pedido circulando a la vez, y el MOM (§23) exige justificación
   * auditada. No se hace en automático.
   */
  | { kind: "needs_justification"; activeOutputs: number };

/**
 * Una salida está ACTIVA mientras el intento de entrega sigue vivo. Una salida
 * devuelta NO cuenta: el paquete ya volvió, y rearmarlo es reprogramación
 * normal (Reproprovincia, reintento en Lima), no una salida simultánea.
 */
export function isActiveOutput(output: OutputForDecision): boolean {
  return (
    output.custody_state !== "devuelto" &&
    ["pendiente", "en_ruta", "por_preparar"].includes(output.delivery_status ?? "")
  );
}

/** Sigue en nuestras manos: es la que se rotula y se arma. */
export function isWithCompany(output: OutputForDecision): boolean {
  return output.custody_state === "empresa";
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
export function decideLabelAction(outputs: readonly OutputForDecision[]): LabelDecision {
  const withCompany = outputs.filter(isWithCompany);
  const reusable = mostRecent(withCompany);
  if (reusable) return { kind: "reuse", shipmentId: reusable.id };

  const active = outputs.filter(isActiveOutput);
  if (active.length) return { kind: "needs_justification", activeOutputs: active.length };

  return { kind: "create" };
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
