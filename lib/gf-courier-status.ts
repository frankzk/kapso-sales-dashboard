// Estados de GF Courier (especificación §7) → vocabulario de salidas de Kapta (lib/shipments.ts, OPERATIONAL_STATUSES).
// Misma forma que mapAliclikStatus (lib/aliclik-status.ts) para que el aplicador de snapshots sea análogo.
// No se inventan estados (AGENTS.md, MOM): lo que GF todavía no usa en COD Lima (PICKED_UP, IN_WAREHOUSE,
// HANDED_TO_CARRIER) y LOST no se traducen solos; se devuelven como `unknown` para revisión y la salida no se toca.
import type { GfOrder, GfStatusCode } from "@/lib/gf-courier";

export interface GfStatusMapping {
  /** null = no se pudo determinar; el llamador DEJA el estado como está. */
  deliveryStatus: "pendiente" | "en_ruta" | "entregado" | "anulado" | null;
  operational: string | null;
  returned: boolean;
  terminal: boolean;
  attemptFailed: boolean;
  unknown: string[];
  preparationState: "rotulo_generado" | "listo_despacho" | null;
  custodyState: "empresa" | "courier" | "devuelto" | null;
}

export function mapGfStatus(code: GfStatusCode | string, subStatus: string | null = null): GfStatusMapping {
  const base: GfStatusMapping = { deliveryStatus: null, operational: null, returned: false, terminal: false, attemptFailed: false,
    unknown: [], preparationState: null, custodyState: null };
  switch (code) {
    case "CREATED":
      return { ...base, deliveryStatus: "pendiente", operational: "confirmado_sin_preparar" };
    case "READY_FOR_PICKUP":
      return { ...base, deliveryStatus: "pendiente", operational: "preparado_sin_despachar", preparationState: "listo_despacho" };
    case "OUT_FOR_DELIVERY":
      return { ...base, deliveryStatus: "en_ruta", operational: "en_ruta", preparationState: "listo_despacho", custodyState: "courier" };
    case "INCIDENT":
      // Una visita fallida sigue viva en la calle; nunca es devolución (especificación §7).
      return subStatus === "RESCHEDULE_REQUESTED"
        ? { ...base, deliveryStatus: "en_ruta", operational: "reprogramado", preparationState: "listo_despacho", custodyState: "courier" }
        : { ...base, deliveryStatus: "en_ruta", operational: "intento_de_entrega", attemptFailed: true, preparationState: "listo_despacho", custodyState: "courier" };
    case "REFUSED":
      return { ...base, deliveryStatus: "en_ruta", operational: "intento_de_entrega", attemptFailed: true, preparationState: "listo_despacho", custodyState: "courier" };
    case "RETURNING":
      return { ...base, deliveryStatus: "en_ruta", operational: "en_proceso_de_retorno", preparationState: "listo_despacho", custodyState: "courier" };
    case "RETURNED":
      // GF informa RETURNED cuando su almacén recibe la devolución.
      return { ...base, deliveryStatus: "anulado", operational: "devuelto_al_origen", returned: true, terminal: true, custodyState: "devuelto", preparationState: "listo_despacho" };
    case "DELIVERED":
      return { ...base, deliveryStatus: "entregado", operational: "entregado", terminal: true, preparationState: "listo_despacho", custodyState: "courier" };
    case "CANCELLED":
      return { ...base, deliveryStatus: "anulado", operational: "anulado", terminal: true };
    case "CANCEL_REQUESTED":
      // GF aceptó anular una guía que ya preparó (owner, 17-11-2026, #KP206881: «no tengo que esperar a GF»): para
      // Kapta queda anulada ya. GF no la puede asignar ni hacer salir con un motorizado; solo le falta desarmar la caja.
      // No es terminal: el CANCELLED posterior de GF también se aplica.
      return { ...base, deliveryStatus: "anulado", operational: "anulado" };
    default:
      return { ...base, unknown: [`status=${code}${subStatus ? `:${subStatus}` : ""}`] };
  }
}

/** ¿GF tiene la anulación de esta guía pedida y todavía sin confirmar? (`shipments.reported_status`). */
export function gfCancelRequested(reportedStatus: string | null | undefined): boolean {
  return /^CANCEL_REQUESTED\b/i.test((reportedStatus ?? "").trim());
}

/** Lo que se dice cuando GF recibió la anulación de una guía ya preparada y falta que la confirme. */
export function gfCancelRequestedText(trackingId: string): string {
  return `Guía ${trackingId} anulada. GF ya no la asigna a ningún motorizado; su almacén solo desarma la caja.`;
}

/** Etiqueta cruda que se guarda en `shipments.reported_status`, para comparar lo que dijo GF con nuestra lectura. */
export function gfReportedStatus(code: string, subStatus: string | null): string {
  return subStatus ? `${code}:${subStatus}` : code;
}

/**
 * Etapa de GF para la caja con novedad que ya volvió a su almacén (GF, owner 24-11-2026, #KP206970): el estado sigue
 * INCIDENT, pero ningún motorizado la tiene y GF la anula (la desarma y devuelve el producto al estante).
 */
export const GF_STAGE_BACK_IN_WAREHOUSE = "BACK_IN_WAREHOUSE";

/** Etapas de GF con el pedido asignado a un motorizado que todavía no sale (su carga se está armando). */
const GF_STAGES_ASSIGNED = ["AWAITING_OFFICE_CHECK", "AWAITING_RIDER"];

/**
 * ¿La caja ya está en reparto con el motorizado? Devuelve el motivo para no anularla desde Kapta, o null.
 *
 * Es lo único que frena (owner, 25-11-2026: «la única limitante que deberíamos de poner es si la guía ya está en reparto
 * con el motorizado»). Asignada a un motorizado pero sin salir (etapas `AWAITING_OFFICE_CHECK` / `AWAITING_RIDER`) ya no
 * frena: GF la retira sola de la carga y la anula en el acto. Antes (17-11-2026) había que pedirle a GF que la retirara.
 */
export function gfCancelBlockedByRider(order: Pick<GfOrder, "status" | "stage">): string | null {
  const code = order.status?.code ?? "";
  const stage = order.stage?.code ?? "";
  // Volvió por «no contestó» y está en el almacén de GF, guardada o asignada a una carga nueva que todavía no sale
  // (owner, 24-11-2026, #KP206846, #KP206937, #KP206970): se anula.
  if (code === "INCIDENT" && (stage === GF_STAGE_BACK_IN_WAREHOUSE || GF_STAGES_ASSIGNED.includes(stage))) return null;
  if (["OUT_FOR_DELIVERY", "INCIDENT", "REFUSED", "RETURNING"].includes(code))
    return "La guía ya está en reparto con un motorizado: no se anula desde Kapta. Coordina el retorno con GF Courier.";
  return null;
}

/** Guías de GF Courier vivas (pendiente o en ruta) con número. */
export function liveGfGuides<T extends { courier: string | null; delivery_status: string; guide_code: string | null }>(outputs: readonly T[]): T[] {
  return outputs.filter((o) => (o.courier ?? "").trim().toLowerCase().replace(" ", "_") === "gf_courier"
    && ["pendiente", "en_ruta"].includes(o.delivery_status) && Boolean(o.guide_code));
}

