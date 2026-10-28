import { swaypGuiaDeVuelta } from "@/lib/swayp-desde-confirmacion";
import {
  isFillableRouteOutput, MAX_OUTPUTS_PER_ORDER, puertaDeSalidaAdicional,
  type PuertaDeSalidaAdicional, type SalidaExistente,
} from "@/lib/shipment-output";

export interface AliclikExistingOutput extends SalidaExistente {
  id: string;
  swayp_state?: number | null;
  returned_at?: string | null;
}

/** Otra caja de Grupo GF en Lima pide motivo; no implica anularla ni recibirla. */
export function aliclikOutputPolicy(input: {
  outputs: readonly AliclikExistingOutput[];
  operation: "lima" | "provincia_cod" | "agencia" | "desconocida";
  motivo?: string | null;
  manual: boolean;
}): PuertaDeSalidaAdicional {
  const candidates = input.outputs.filter((output) =>
    !["anulado", "transferido"].includes(output.delivery_status) &&
    !isFillableRouteOutput(output) && !swaypGuiaDeVuelta(output),
  );
  // El motivo no permite duplicar Aliclik ni emitir sobre una entrega ya hecha.
  const blocking = candidates.find((output) =>
    output.delivery_status === "entregado" || output.courier.trim().toLowerCase() === "aliclik",
  ) ?? (input.operation !== "lima" ? candidates[0] : null);
  if (blocking) {
    return {
      ok: false, pideMotivo: false, estorban: [blocking],
      error: `Este pedido ya tiene una guía ${blocking.delivery_status === "entregado" ? "entregada" : "activa"} (${blocking.guide_code ?? blocking.output_code ?? "sin código"}).`,
    };
  }

  // Una «por definir» se rellena: no consume una sexta salida. Las cerradas sí
  // cuentan para el presupuesto, aunque ninguna de ellas esté todavía viva.
  const fillable = input.outputs.find(isFillableRouteOutput);
  const counted = input.outputs.filter((output) => output !== fillable);
  if (counted.length >= MAX_OUTPUTS_PER_ORDER) {
    return {
      ok: false, pideMotivo: false, estorban: [],
      error: `El pedido ya alcanzó el máximo de ${MAX_OUTPUTS_PER_ORDER} salidas.`,
    };
  }
  return puertaDeSalidaAdicional({
    courier: "aliclik", operation: input.operation,
    outputs: counted.filter((output) => !swaypGuiaDeVuelta(output)),
    // El automático nunca justifica otra salida en nombre de una persona.
    motivo: input.manual ? input.motivo : null,
  });
}
