import { swaypGuiaDeVuelta } from "@/lib/swayp-desde-confirmacion";
import {
  gfNoEntregadaReportada, isFillableRouteOutput, MAX_OUTPUTS_PER_ORDER, puertaDeSalidaAdicional,
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
export const MOTIVE_ORIGIN_KINDS = ["reintento_lima", "dia_programado_lima"] as const;

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

/**
 * Otra caja de Grupo GF en Lima pide motivo; no implica anularla ni recibirla.
 * Si sigue con el motorizado «No entregado», al guardar la guía queda en
 * devolución y vuelve a stock cuando la traiga (0337, `createAliclikGuideFor`).
 */
export function aliclikOutputPolicy(input: {
  outputs: readonly AliclikExistingOutput[];
  operation: "lima" | "provincia_cod" | "agencia" | "desconocida";
  motivo?: string | null;
  manual: boolean;
  /**
   * La crea una PERSONA (no un automático, ni el reintento de Lima). Solo ella
   * hace que Kapta anule la guía GF viva (`gfToCancel`).
   */
  person?: boolean;
}): AliclikOutputPolicyResult {
  const live = input.outputs.filter((output) =>
    !["anulado", "transferido"].includes(output.delivery_status) &&
    !isFillableRouteOutput(output) && !swaypGuiaDeVuelta(output) &&
    // La caja de Grupo GF ya reportada «No entregado» (16-11-2026): no estorba;
    // al crear la guía queda «en devolución» (`gf_replace_output_with_aliclik`).
    !gfNoEntregadaReportada(output),
  );
  // GF Courier por API → Aliclik (owner, 15-11-2026). Si una persona decide
  // mandarlo por Aliclik, Kapta anula sola la guía GF mientras GF todavía no la
  // asignó a un motorizado. Preparada sin asignar todavía se anula. Asignada
  // («en ruta» para Kapta) ya no, y entonces no se crea la de Aliclik. El
  // automático no anula guías de nadie.
  const liveGf = live.filter((output) => isGfCourier(output.courier) && output.delivery_status !== "entregado");
  const assignedGf = liveGf.find((output) => output.delivery_status !== "pendiente");
  if (assignedGf) {
    return {
      ok: false, pideMotivo: false, estorban: [assignedGf],
      error: `GF Courier ya asignó el pedido a un motorizado (guía ${assignedGf.guide_code ?? assignedGf.output_code ?? "sin código"}): no se crea la guía de Aliclik.`,
    };
  }
  if (liveGf.length > 0 && !input.person) {
    return {
      ok: false, pideMotivo: false, estorban: liveGf,
      error: `Tiene una guía de GF Courier viva (${liveGf[0]!.guide_code ?? "sin código"}). El automático no la anula: lo decide una persona.`,
    };
  }
  const gfToCancel = liveGf;
  const candidates = live.filter((output) => !gfToCancel.includes(output));
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
  const gate = puertaDeSalidaAdicional({
    courier: "aliclik", operation: input.operation,
    // La guía GF que se va a anular no pide motivo: deja de estar viva antes del POST.
    outputs: counted.filter((output) => !swaypGuiaDeVuelta(output) && !gfToCancel.includes(output)),
    // El automático no justifica otra salida en nombre de una persona; solo el
    // reintento de Lima, con su propio motivo (`aliclikMotiveAllowed`).
    motivo: input.manual ? input.motivo : null,
  });
  return gate.ok && gfToCancel.length > 0 ? { ...gate, gfToCancel } : gate;
}

/** La puerta de salidas, más las guías GF que Kapta anula antes de crear la de Aliclik. */
export type AliclikOutputPolicyResult =
  | (Extract<PuertaDeSalidaAdicional, { ok: true }> & { gfToCancel?: AliclikExistingOutput[] })
  | Extract<PuertaDeSalidaAdicional, { ok: false }>;

function isGfCourier(courier: string): boolean {
  const key = courier.trim().toLowerCase();
  return key === "gf_courier" || key === "gf courier";
}
