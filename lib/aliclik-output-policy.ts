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

/**
 * El origen de guía automática que SÍ puede justificar otra salida en Lima: el
 * reintento Aliclik de la cadena (MOM §9.5, entrega 3, owner 04-11-2026). La
 * caja que falló sigue viva hasta que vuelve, y el reintento sale sin esperarla
 * (owner, 03-11-2026); sin motivo, cada reintento de Alexis se cortaba en
 * «pide motivo». El motivo no lo pone una persona: lo escribe la regla que el
 * owner encendió en Automatizaciones, y el texto lo dice.
 */
export const MOTIVE_ORIGIN_KINDS = ["reintento_lima"] as const;

/**
 * ¿Puede esta creación justificar otra salida con motivo? Una persona, sí; el
 * automático, solo con un origen de `MOTIVE_ORIGIN_KINDS`. El origen nunca
 * viene del navegador (`AliclikGuideOrigin` va aparte de lo que manda la
 * acción). Pura.
 */
export function aliclikMotiveAllowed(userId: string | null | undefined, originKind?: string | null): boolean {
  if (userId) return true;
  return (MOTIVE_ORIGIN_KINDS as readonly string[]).includes(originKind ?? "");
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
    // El automático no justifica otra salida en nombre de una persona; solo el
    // reintento de Lima, con su propio motivo (`aliclikMotiveAllowed`).
    motivo: input.manual ? input.motivo : null,
  });
}
