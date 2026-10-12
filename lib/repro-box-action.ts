// «Qué hacer con la caja» en Repro Lima (decisión 8 del owner; MOM §9.3, §9.5).
//
// Kapta calcula la acción desde lo que declara quien decide —qué cambió—, el
// courier acordado, dónde está la caja y las salidas que ya usó el pedido.
// Almacén no la elige. Por defecto la caja se mantiene; las reglas van en
// orden y gana la primera que aplica:
//
// 1. «Ya no lo quiere» → Desarmar y cerrar (no anula la venta).
// 2. Otra guía viva de otro courier → problema: la trabaja ese courier.
// 3. Urpi → problema: en 1a no lleva reprogramados (E16).
// 4. «No esperar la caja» con la caja fuera → Caja nueva desde stock. Va antes
//    que el producto: es lo único que se puede hacer con el producto cambiado y
//    la caja lejos.
// 5. Cambió el producto o la caja está dañada → Desarmar y rearmar.
// 6. Sin salida propia viva, o cambia el courier → Salida nueva y rearmado.
// 7. Cambió la dirección o el monto → Reimprimir el rótulo de la misma salida.
// 8. Lo demás → Mantener.
//
// En 4-6 nace una salida: se respeta el tope de cinco y la repetición por
// courier de Lima (`canRepeatCourier`). El tope y la repetición son problemas
// que se le dicen a quien decide: nunca cierran el caso solos.

import { canRepeatCourier, MAX_OUTPUTS_PER_ORDER, sameCourier, isCourierTbd } from "@/lib/shipment-output";
import { outputsBlockingRetry, reprogramBlockReason, replaceDecisionMessage, type OwnReplaceDecision } from "@/lib/gf-retry";
import { NO_REPLACED_OUTPUTS } from "@/lib/gf-replaced-output";
import { courierKey } from "@/lib/dispatch";
import { sameDayCutoffLabel } from "@/lib/grupo-gf-courier";
import {
  BOX_ACTION_LABEL,
  noEsperarCajaAplica,
  reproCourierName,
  REPRO_COURIER_LABEL,
  URPI_DISABLED_REASON,
  type BoxAction,
  type BoxLocation,
  type ReproChanges,
  type ReproCourier,
  type ReproOutcome,
} from "@/lib/repro-lima";

export { BOX_ACTION_LABEL };

export type ReproBoxActionResult =
  | {
      action: BoxAction;
      /** La acción crea una salida nueva (cuenta para las cinco). */
      newSalida: boolean;
      /** La línea «Qué hacer con la caja», dicha con el courier acordado (E17). */
      label: string;
    }
  | { problem: string };

export interface ReproBoxActionInput {
  /** Solo `confirma` y `no_quiere` llevan acción; los otros resultados no la guardan. */
  outcome: ReproOutcome;
  /** El courier acordado; null mientras no se elige. */
  courier: ReproCourier | null;
  changes: Partial<ReproChanges> | null | undefined;
  box: BoxLocation;
  /** El courier de la salida propia que se reusa (`ownRetryOutput`), o null. */
  ownLiveCourier: string | null;
  /** El courier de la última salida que no entregó (`lastFailedOutput`), o null. */
  lastFailedCourier: string | null;
  /** El courier de otra salida viva que se está trabajando (`otherLiveCourierOf`), o null. */
  otherLiveCourier: string | null;
  /** El pedido ya salió con Grupo GF. Sin efecto en 1a: Urpi no se ofrece (E16). */
  hadPropio?: boolean;
  /** Todas las salidas del pedido, vivas o no. */
  totalOutputs: number;
  /** Cuántas salidas ya llevó el courier acordado (`priorOutputsWith`). */
  priorWithCourier: number;
  /**
   * Con la caja de Grupo GF todavía con el motorizado: lo que diría «Sacar con
   * salida nueva» (`ownReplaceDecision`) y el código de esa salida (E18).
   */
  ownReplace?: { decision: OwnReplaceDecision; outputCode: string | null } | null;
}

const MAX_OUTPUTS_PROBLEM = `Ya usó las ${MAX_OUTPUTS_PER_ORDER} salidas: solo queda «Desarmar y cerrar».`;

/** El problema de una salida nueva con ese courier, o null si se puede. */
function newOutputProblem(input: ReproBoxActionInput, courier: ReproCourier): string | null {
  const repeat = canRepeatCourier({
    courier,
    operation: "lima",
    priorOutputsWithCourier: input.priorWithCourier,
    totalOutputs: input.totalOutputs,
  });
  if (repeat.allowed) return null;
  return repeat.reason === "max_outputs"
    ? MAX_OUTPUTS_PROBLEM
    : `${REPRO_COURIER_LABEL[courier]} ya llevó este pedido: en Lima va una sola vez.`;
}

/** Quién hace la salida del courier acordado, para la etiqueta. */
function newOutputBy(courier: ReproCourier): string {
  return courier === "propio"
    ? "salida nueva de Grupo GF (la crea al tomarlo en Despacho del día)"
    : `salida de ${REPRO_COURIER_LABEL[courier]} desde la Mesa de ruta`;
}

/** Qué hacer con la caja. La primera regla que aplica gana (ver la cabecera). */
export function reproBoxAction(input: ReproBoxActionInput): ReproBoxActionResult {
  const changes = input.changes ?? {};

  // 1. Ya no lo quiere.
  if (input.outcome === "no_quiere") {
    return {
      action: "desarmar_cerrar",
      newSalida: false,
      label: "Almacén la desarma cuando esté en oficina (cuaderno «DESARMAR»). No anula la venta.",
    };
  }

  const courier = input.courier;
  if (!courier) return { problem: "Elige con qué courier sale." };

  // 2. Otra guía viva: la trabaja ese courier.
  if (input.otherLiveCourier) {
    return { problem: `La guía de ${reproCourierName(input.otherLiveCourier)} sigue viva: la trabaja ese courier. Revísala en la ficha.` };
  }

  // 3. Urpi no lleva reprogramados en 1a.
  if (courier === "urpi") return { problem: URPI_DISABLED_REASON };

  const box = input.box;

  // 4. No esperar la caja: se arma otra desde stock.
  if (changes.no_esperar_caja && noEsperarCajaAplica(box)) {
    const problem = newOutputProblem(input, courier);
    if (problem) return { problem };
    if (box.kind === "con_motorizado") {
      if (courier === "propio") {
        // «Sacar con salida nueva» solo se promete si de verdad se puede (E18).
        const decision = input.ownReplace?.decision;
        if (decision && decision.action !== "sacar") {
          return { problem: replaceDecisionMessage(decision, { riderName: box.riderName, routeDate: box.since ?? "" }, input.ownReplace?.outputCode ?? null) };
        }
        return {
          action: "caja_nueva_stock",
          newSalida: true,
          label: `Caja nueva desde stock con «Sacar con salida nueva» en Despacho del día; la de ${box.riderName} se desarma al recibirla.`,
        };
      }
      return {
        action: "caja_nueva_stock",
        newSalida: true,
        label: `Caja nueva desde stock y ${newOutputBy(courier)}; la de ${box.riderName} se desarma al recibirla.`,
      };
    }
    if (box.kind === "volviendo_courier") {
      return {
        action: "caja_nueva_stock",
        newSalida: true,
        label: `Caja nueva desde stock y ${newOutputBy(courier)}; la que vuelve con ${reproCourierName(box.courier)} se desarma al recibirla.`,
      };
    }
    return {
      action: "caja_nueva_stock",
      newSalida: true,
      label: `Caja nueva desde stock y ${newOutputBy(courier)}; si aparece la anterior, se desarma.`,
    };
  }

  // 5. Cambió el producto o la caja está dañada.
  if (changes.producto || changes.caja_danada) {
    const problem = newOutputProblem(input, courier);
    if (problem) return { problem };
    return {
      action: "desarmar_rearmar",
      newSalida: true,
      label: courier === "propio"
        ? "Desarmar y rearmar: salida, QR y rótulo nuevos (§9.3)."
        : `Desarmar y rearmar con salida, QR y rótulo nuevos de ${REPRO_COURIER_LABEL[courier]} desde la Mesa de ruta (§9.3).`,
    };
  }

  // 6. Sin salida propia viva, o cambia el courier.
  if (!input.ownLiveCourier || !sameCourier(courier, input.ownLiveCourier)) {
    const problem = newOutputProblem(input, courier);
    if (problem) return { problem };
    return {
      action: "salida_nueva_rearmar",
      newSalida: true,
      label: courier === "propio"
        ? "Salida nueva de Grupo GF: el rótulo nuevo va encima del anterior, tapando su QR (§9.3)."
        : `Salida nueva de ${REPRO_COURIER_LABEL[courier]} desde la Mesa de ruta: se rearma y se retira la etiqueta vieja.`,
    };
  }

  // 7. Misma salida con la dirección o el monto cambiados.
  if (changes.direccion || changes.monto) {
    const address = changes.direccion ? " Corrige antes la dirección en el editor de destino de la salida." : "";
    return {
      action: "reimprimir_misma_salida",
      newSalida: false,
      label: `Reimprimir el rótulo de la misma salida: se retira el rótulo viejo (o se tacha el monto), se marca «REIMPRESO dd-mm» y el despachador compara el monto.${address}`,
    };
  }

  // 8. Mantener.
  const phone = changes.telefono ? " El teléfono nuevo se anota en la ficha y se le pasa al motorizado (§9.5, paso 4)." : "";
  return { action: "mantener", newSalida: false, label: `Mantener la caja: misma salida, QR y rótulo.${phone}` };
}

/**
 * Cuándo está lista la caja (columna «Lista para» de la tabla aprobada, E14).
 * La misma regla que `firstAllowedDay`.
 */
export function boxActionReadyLabel(action: BoxAction, courier: ReproCourier | null, cutoff: string | null | undefined): string {
  const cut = sameDayCutoffLabel(cutoff);
  switch (action) {
    case "mantener":
      return `Lista para hoy si se confirma hasta las ${cut}.`;
    case "reimprimir_misma_salida":
    case "salida_nueva_rearmar":
    case "desarmar_rearmar":
      return "Lista desde mañana: se prepara la noche anterior.";
    case "caja_nueva_stock":
      if (courier === "fenix") return "Lista desde mañana: Swayp arma su ruta el día anterior.";
      if (courier === "propio") return `Lista para hoy si se confirma hasta las ${cut} (en el anaquel antes de las 12:30).`;
      return "Lista para hoy, antes del recojo del courier.";
    case "desarmar_cerrar":
      return "Se desarma en el día en que la caja está en oficina.";
  }
}

/** Cuántas salidas del pedido llevó ese courier (comparación canónica, E20). */
export function priorOutputsWith(outputs: readonly { courier: string }[], courier: string): number {
  return outputs.filter((output) => sameCourier(output.courier, courier)).length;
}

type LiveOutputLike = Parameters<typeof outputsBlockingRetry>[0][number];

/**
 * El courier de otra salida viva que se está trabajando, o null. Es el caso
 * `otra_salida_viva` de `reprogramBlockReason`: la lleva ese courier (una
 * reprogramación de Aliclik, por ejemplo), no Repro Lima.
 */
export function otherLiveCourierOf<T extends LiveOutputLike>(
  outputs: readonly T[],
  replaced: ReadonlySet<string> = NO_REPLACED_OUTPUTS,
): string | null {
  if (reprogramBlockReason(outputs, replaced) !== "otra_salida_viva") return null;
  const other = outputsBlockingRetry(outputs, replaced).find((output) =>
    (output.delivery_status === "pendiente" || output.delivery_status === "en_ruta") &&
    !output.returned_at &&
    output.custody_state !== "devuelto" &&
    courierKey(output.courier) !== "propio" &&
    !isCourierTbd(output.courier));
  return other?.courier ?? null;
}
