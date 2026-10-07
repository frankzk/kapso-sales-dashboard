// Recepción de las cajas que Shalom devuelve (MOM §9.4 y §12): la decisión.
// Pura y probada en test/shalom-returns.test.ts. El cuadre de la pantalla vive
// aparte (lib/shalom/returns.ts) para que el navegador no cargue esto.
//
// Shalom no tiene un hito de retorno. Cuando saca un paquete de la agencia de
// destino para devolverlo —«cambio de destino», con una guía nueva rumbo a
// Lima—, cierra la guía original como `entregado`. El rastreo ya distingue ese
// caso (`shalomExitReturnDays`) y deja la guía anulada y en `retorno`; esta es la
// otra mitad: la caja llega al almacén, alguien la escanea y queda recibida.
//
// Y cubre lo que el rastreo no pudo ver. Una guía que Shalom dio por recogida
// también se recibe si la clienta nunca tuvo la clave: la caja en la mano es la
// prueba de que aquel «recogido» era el retorno. Si la clave sí se le dio, puede
// que la clienta lo recogiera y lo devolviera: eso es una devolución del
// cliente, que se abre desde el Master, no un retorno del courier.

import { hasExternalCustody } from "@/lib/order-macro-stage";
import type { PickupKeyFacts } from "@/lib/shalom/pickup-facts";

/** Lo que hace falta saber de la guía para decidir si se puede recibir. */
export interface ShalomReturnGuide {
  delivery_status: string;
  custody_state: string | null;
  returned_at: string | null;
  pickup_state: string | null;
  dispatched_at: string | null;
  out_for_delivery_at: string | null;
}

export type ShalomReceptionDecision =
  | {
      ok: true;
      /** Hay que sellar la devolución: nadie la había sellado. */
      seal: boolean;
      /** Shalom la dio por recogida y era el retorno: la guía se corrige. */
      correct: boolean;
      /** La guía seguía viva: se cierra, o el rastreo la seguiría consultando. */
      close: boolean;
    }
  | { ok: false; reason: "ya_recibida" | "entregada" | "sin_clave" | "nunca_salio"; message: string };

export function decideShalomReception(
  guide: ShalomReturnGuide,
  keys: PickupKeyFacts,
  alreadyReceived: boolean,
): ShalomReceptionDecision {
  if (alreadyReceived) {
    return { ok: false, reason: "ya_recibida", message: "Esta caja ya se había recibido en almacén." };
  }
  if (guide.delivery_status === "entregado") {
    if (!keys.hasKey) {
      return {
        ok: false,
        reason: "sin_clave",
        message:
          "Shalom la dio por recogida y esta guía no tiene clave registrada: no hay cómo saber si la recogió la clienta. Avísalo antes de registrarla.",
      };
    }
    if (keys.keyGiven) {
      return {
        ok: false,
        reason: "entregada",
        message:
          "Shalom la dio por recogida y la clave se reveló o se envió: puede que la clienta la recogiera. Si la caja volvió, es una devolución del cliente: regístrala desde el Master.",
      };
    }
    return { ok: true, seal: !guide.returned_at, correct: true, close: true };
  }
  if (!guide.returned_at && !hasExternalCustody(guide)) {
    return {
      ok: false,
      reason: "nunca_salio",
      message: "Esta guía nunca salió del almacén: no hay devolución que recibir.",
    };
  }
  return {
    ok: true,
    seal: !guide.returned_at,
    correct: false,
    close: guide.delivery_status === "pendiente" || guide.delivery_status === "en_ruta",
  };
}

/**
 * Lo que se escribe en la guía al recibirla. El sello es el de una persona con
 * la caja en la mano (0118: `manual`, con su nombre), y la guía queda anulada
 * —un estado terminal— para que el rastreo no la vuelva a dar por recogida.
 */
export function shalomReceptionPatch(
  decision: Extract<ShalomReceptionDecision, { ok: true }>,
  actor: string,
  now: string,
): Record<string, string> {
  return {
    custody_state: "devuelto",
    ...(decision.seal
      ? { returned_at: now, pickup_state: "devuelto", returned_source: "manual", returned_by: actor }
      : {}),
    ...(decision.correct || decision.close ? { delivery_status: "anulado", status_category: "closed" } : {}),
  };
}
