import { ADELANTO_MINIMO, ADELANTO_MINIMO_LABEL } from "@/lib/adelanto-minimo";

export type DuplicateDecision = "keep_existing" | "both" | "replacement" | "exception";
export const DUPLICATE_DECISIONS: Record<DuplicateDecision, string> = {
  keep_existing: "Solo quiere el pedido anterior",
  both: "Confirmó expresamente que quiere ambos",
  replacement: "El nuevo reemplaza al anterior",
  exception: "Excepción autorizada por responsable",
};
export interface DuplicateItem { variant: string; sku: string; quantity: number }
export interface DuplicateShipment {
  id: string; order_id: string; guide_code: string; courier: string;
  dispatched_at: string | null; custody_transferred_at: string | null;
  out_for_delivery_at: string | null; aliclik_reported_dispatch_date: string | null;
  returned_at: string | null; delivery_status: string; custody_state: string | null;
  pickup_state: string | null;
}
export interface DuplicateConflict {
  orderId: string; orderName: string; shipmentId: string; guideCode: string;
  courier: string; dispatchedAt: string | null;
}
export interface DuplicateResolution {
  fingerprint: string; decision: DuplicateDecision; reason: string;
  actor: string; occurredAt: string;
}
export interface DuplicateHold {
  allowed: boolean; message: string | null; conflicts: DuplicateConflict[];
  fingerprint: string | null; resolution: DuplicateResolution | null;
  validatedAmount: number; canResolve: boolean; canOverride: boolean;
}

/** Missing item identities are unknown, not evidence of different products. */
export function duplicateItems(raw: unknown): DuplicateItem[] | null {
  if (!Array.isArray(raw) || !raw.length) return null;
  const items: DuplicateItem[] = [];
  for (const value of raw) {
    if (!value || typeof value !== "object") return null;
    const item = value as Record<string, unknown>;
    const quantity = Number(item.quantity);
    if (!Number.isFinite(quantity) || quantity < 0) return null;
    if (!quantity) continue;
    const variant = String(item.variant_id ?? "").trim();
    const sku = String(item.sku ?? "").trim().toLowerCase();
    if (!variant && !sku) return null;
    items.push({ variant, sku, quantity });
  }
  return items.length ? items : null;
}

export function sharesDuplicateItem(a: DuplicateItem[], b: DuplicateItem[], sameStore: boolean): boolean | null {
  let unknown = false;
  const matches = a.some((left) => b.some((right) => {
    if (sameStore && left.variant && right.variant) return left.variant === right.variant;
    if (left.sku && right.sku) return left.sku === right.sku;
    unknown = true;
    return false;
  }));
  return matches ? true : unknown ? null : false;
}

/**
 * QUÉ PASÓ CON EL ENVÍO ANTERIOR, DICHO POR UNA PERSONA (MOM §8.3, 10-10-2026).
 *
 * «Reemplaza al anterior» esperaba una constancia de entrega o retorno que, en
 * los casos reales, el seguimiento ya no iba a traer: una guía `transferido`
 * deja de leerse, una anulada se lee solo tres semanas y un paquete perdido no
 * vuelve nunca. Del 02 al 10-10-2026 hubo 4 pedidos y 15 intentos con
 * «reemplaza», y los 4 terminaron en la excepción de un responsable.
 *
 * Ahora quien resuelve declara el destino de cada salida anterior y cada
 * declaración pasa por la puerta que ya le corresponde:
 *
 *   - `devuelto`   → la recepción de devolución del pedido anterior
 *                    (`return_receive`, permiso `closure.return`).
 *   - `extraviado` → hecho `courier_loss_declared`: abre la indemnización del
 *                    pedido anterior. Solo Aliclik tiene indemnización formal.
 *   - `entregado`  → hecho `delivery_declared`: el pedido anterior pasa a Por
 *                    cerrar · Entrega declarada hasta que el courier la reporte
 *                    o un responsable fije el estado. La guía NO se marca
 *                    entregada: esa puerta es del courier.
 */
export type PriorShipmentOutcome = "devuelto" | "entregado" | "extraviado";

export const PRIOR_SHIPMENT_OUTCOMES: Record<PriorShipmentOutcome, { label: string; hint: string }> = {
  devuelto: {
    label: "Volvió al almacén",
    hint: "Registra la recepción de la devolución en el pedido anterior.",
  },
  entregado: {
    label: "Lo recibió el cliente",
    hint: "El pedido anterior pasa a Por cerrar · Entrega declarada para confirmar el cobro.",
  },
  extraviado: {
    label: "El courier lo perdió",
    hint: "Abre la indemnización del pedido anterior.",
  },
};

/** Hechos que, sobre una salida, la sacan de la retención sin `returned_at`. */
export const DECLARED_OUTCOME_KIND: Record<Exclude<PriorShipmentOutcome, "devuelto">, string> = {
  entregado: "delivery_declared",
  extraviado: "courier_loss_declared",
};
export const DECLARED_OUTCOME_KINDS: readonly string[] = Object.values(DECLARED_OUTCOME_KIND);

/**
 * Qué destinos se pueden declarar para una salida. Aliclik admite los tres. El
 * resto de couriers, solo la devolución: su entrega tiene su propia puerta (el
 * resultado del courier en Envíos) y la indemnización formal es solo de
 * Aliclik, así que una pérdida declarada no tendría quién la cierre.
 */
export function allowedPriorOutcomes(courier: string): PriorShipmentOutcome[] {
  return courier.trim().toLowerCase() === "aliclik" ? ["devuelto", "entregado", "extraviado"] : ["devuelto"];
}

/** Cada salida en conflicto con un destino válido para su courier; ni más ni menos. */
export function replacementOutcomesProblem(
  conflicts: readonly Pick<DuplicateConflict, "shipmentId" | "guideCode" | "courier">[],
  outcomes: unknown,
): string | null {
  if (!outcomes || typeof outcomes !== "object" || Array.isArray(outcomes)) {
    return "Indica qué pasó con cada envío anterior.";
  }
  const given = outcomes as Record<string, unknown>;
  const ids = new Set(conflicts.map((c) => c.shipmentId));
  if (Object.keys(given).some((key) => !ids.has(key))) {
    return "Los envíos cambiaron. Actualiza la revisión antes de resolver.";
  }
  for (const conflict of conflicts) {
    const outcome = given[conflict.shipmentId];
    if (typeof outcome !== "string") return `Indica qué pasó con la guía ${conflict.guideCode}.`;
    if (!(allowedPriorOutcomes(conflict.courier) as string[]).includes(outcome)) {
      return `La guía ${conflict.guideCode} (${conflict.courier}) solo admite declarar que volvió al almacén.`;
    }
  }
  return null;
}

const AGENCY_IN_CUSTODY = new Set([
  "registrado_en_agencia", "en_transito", "disponible_para_recojo", "cliente_notificado",
  "pendiente_de_recojo", "proximo_a_vencer", "en_reparto", "retorno_iniciado", "devuelto_al_origen",
]);
/**
 * Commercial cancellation and a closed courier status don't recover a box. A
 * declared outcome does (`declaredIds`): a person signed what happened to it.
 */
export function unresolvedDuplicateShipment(
  guide: DuplicateShipment,
  declaredIds?: ReadonlySet<string>,
): boolean {
  if (declaredIds?.has(guide.id)) return false;
  if (guide.returned_at || guide.custody_state === "devuelto" ||
      guide.delivery_status === "entregado" || guide.pickup_state === "recogido") return false;
  return Boolean(guide.dispatched_at || guide.custody_transferred_at || guide.out_for_delivery_at ||
    guide.aliclik_reported_dispatch_date || ["courier", "retorno"].includes(guide.custody_state ?? "") ||
    ["en_ruta", "transferido"].includes(guide.delivery_status) || AGENCY_IN_CUSTODY.has(guide.pickup_state ?? ""));
}

export function duplicateGate(
  conflicts: DuplicateConflict[], fingerprint: string | null,
  resolution: DuplicateResolution | null, validatedAmount: number,
): Pick<DuplicateHold, "allowed" | "message" | "resolution"> {
  if (!conflicts.length) return { allowed: true, message: null, resolution: null };
  const current = resolution?.fingerprint === fingerprint ? resolution : null;
  if (current?.decision === "exception") {
    return { allowed: true, message: "Excepción autorizada y registrada para estas salidas.", resolution: current };
  }
  if (current?.decision === "both" && Math.round(validatedAmount * 100) >= ADELANTO_MINIMO * 100) {
    return { allowed: true, message: "Quiere ambos: confirmación y adelanto validados.", resolution: current };
  }
  const message = current?.decision === "both"
    ? `Falta validar al menos ${ADELANTO_MINIMO_LABEL} en este pedido. Un comprobante pendiente no libera la guía.`
    : current?.decision === "replacement"
      ? "Declara qué pasó con cada envío anterior —volvió, lo recibió el cliente o se perdió— para liberar esta guía. Solicitar su retorno o anularlo no basta."
      : current?.decision === "keep_existing"
        ? "Conserva el envío anterior y tramita la cancelación del nuevo por el procedimiento habitual."
        : "Otro pedido del mismo teléfono y producto sigue despachado. Registra una resolución antes de crear otra guía Aliclik.";
  return { allowed: false, message, resolution: current };
}

export function duplicateResolutionProblem(decision: unknown, reason: string, canOverride: boolean): string | null {
  if (typeof decision !== "string" || !Object.hasOwn(DUPLICATE_DECISIONS, decision)) return "Selecciona una resolución válida.";
  if (decision === "exception" && !canOverride) return "Solo un responsable autorizado puede exceptuar esta retención.";
  if (reason.trim().length < 12 || reason.trim().length > 1000) return "Describe la confirmación o el motivo (entre 12 y 1000 caracteres).";
  return null;
}
