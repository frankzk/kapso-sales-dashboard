// El gesto único (MOM §29.13): escanear o tomar una foto es siempre el mismo
// movimiento; lo que cambia es QUIÉN lo hace y DESDE DÓNDE. La pantalla
// declara el contexto y esta tabla decide la acción y el evento. Puro,
// probado en test/scan-action.test.ts.

export type ScanContext = "oficina_cotejo" | "motorizado_recepcion" | "motorizado_entrega" | "supervisor_retiro";

export interface ScanPlan {
  /** `scan`: lee un código (QR, guía, pedido). `photo`: toma una foto. */
  gesture: "scan" | "photo";
  /** Evento que queda en el pedido (`order_events.kind`). */
  eventKind: string;
  /** Etapa del cotejo cuando el gesto escribe en la caja. */
  stage: "office" | "pickup" | null;
  /** Hace falta un motivo escrito antes de ejecutar. */
  needsReason: boolean;
  /** Quién puede hacerlo, para el texto de ayuda y las guardas de la pantalla. */
  actor: "supervisor" | "motorizado";
  label: string;
  hint: string;
}

export const SCAN_PLANS: Record<ScanContext, ScanPlan> = {
  oficina_cotejo: {
    gesture: "scan",
    eventKind: "office_checked",
    stage: "office",
    needsReason: false,
    actor: "supervisor",
    label: "Cotejar paquete",
    hint: "Escanea el QR de cada paquete que entra en la caja.",
  },
  motorizado_recepcion: {
    gesture: "scan",
    eventKind: "pickup_checked",
    stage: "pickup",
    needsReason: false,
    actor: "motorizado",
    label: "Recibir paquete",
    hint: "Escanea cada paquete que te entregan. Al 100 %, la caja es tuya.",
  },
  motorizado_entrega: {
    gesture: "photo",
    eventKind: "delivered",
    stage: null,
    needsReason: false,
    actor: "motorizado",
    label: "Tomar foto",
    hint: "La foto de la entrega es la evidencia de la parada.",
  },
  supervisor_retiro: {
    gesture: "scan",
    eventKind: "package_removed",
    stage: null,
    needsReason: true,
    actor: "supervisor",
    label: "Retirar paquete",
    hint: "Escanea el paquete que sale de la caja y di por qué.",
  },
};

export function scanActionPlan(context: ScanContext): ScanPlan {
  return SCAN_PLANS[context];
}

/** El evento de recepción cambia si el motorizado rechaza en vez de recibir. */
export function receptionEvent(declined: boolean): "pickup_checked" | "pickup_declined" {
  return declined ? "pickup_declined" : "pickup_checked";
}
