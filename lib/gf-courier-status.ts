// Estados de GF Courier (especificación §7) → vocabulario de salidas de Kapta (lib/shipments.ts, OPERATIONAL_STATUSES).
// Misma forma que mapAliclikStatus (lib/aliclik-status.ts) para que el aplicador de snapshots sea análogo.
// No se inventan estados (AGENTS.md, MOM): lo que GF todavía no usa en COD Lima (PICKED_UP, IN_WAREHOUSE,
// HANDED_TO_CARRIER) y LOST no se traducen solos; se devuelven como `unknown` para revisión y la salida no se toca.
import type { GfStatusCode } from "@/lib/gf-courier";

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
    default:
      return { ...base, unknown: [`status=${code}${subStatus ? `:${subStatus}` : ""}`] };
  }
}

/** Etiqueta cruda que se guarda en `shipments.reported_status`, para comparar lo que dijo GF con nuestra lectura. */
export function gfReportedStatus(code: string, subStatus: string | null): string {
  return subStatus ? `${code}:${subStatus}` : code;
}
