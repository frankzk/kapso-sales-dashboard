// El ÚNICO camino para escribir el reporte de una parada (`delivery_stops`):
// lo usan la pantalla del motorizado (/reparto), coordinación y las ediciones
// de una fila de cuaderno atada a su parada en Liquidaciones 2 (MOM §29.12).
// Trae toda la validación de Rutas: ruta en curso, saldo real del pedido,
// evidencia, y el enum + motivo del catálogo. Sin permisos: los comprueba
// quien llama (routeReportAccess en /reparto; sheets.edit en Liquidaciones 2).

import type { SupabaseClient } from "@supabase/supabase-js";
import { reportedCollection } from "@/lib/route-collection";
import { loadRouteCollectionBalances } from "@/lib/route-collection-access";
import {
  isNonDeliveryReason,
  isPaymentMethod,
  validateStopReport,
  type PaymentMethod,
  type StopStatus,
} from "@/lib/routes";

export interface WriteStopReportInput {
  stopId: string;
  status: StopStatus;
  paymentMethod: string | null;
  collectedAmount: number | null;
  outcomeReason: string | null;
  note: string | null;
  /** Rutas del bucket privado; null conserva lo que la parada ya tenía. */
  photoPath?: string | null;
  voucherPath?: string | null;
  actor: string;
  /** Lo escrito literal y su código del dominio Reparto propio (0172). */
  writtenStatus?: string | null;
  writtenStatusCode?: string | null;
  writtenPayment?: string | null;
  /** Coordinación o Liquidaciones 2 escribiendo por el motorizado. */
  delegated?: boolean;
}

export type WriteStopReportResult =
  | { ok: true; orderId: string; routeId: string }
  | { ok: false; error: string };

/** Lo que quien llama ya leyó con SU cliente: en /reparto bajo RLS (si no la
 *  ve, no existe); en Liquidaciones 2 con el service role tras sus guardas. */
export interface StopReportContext {
  stop: { id: string; order_id: string; route_id: string; photo_path: string | null; voucher_path: string | null };
  routeStatus: string | null | undefined;
}

export async function writeStopReport(admin: SupabaseClient, input: WriteStopReportInput, ctx: StopReportContext): Promise<WriteStopReportResult> {
  const { stop, routeStatus } = ctx;
  if (routeStatus !== "en_curso") {
    return {
      ok: false,
      error:
        routeStatus === "cerrada"
          ? "La ruta ya está cerrada. Avisa al coordinador si hay que corregir algo."
          : "La ruta todavía no está en curso.",
    };
  }

  const method = isPaymentMethod(input.paymentMethod) ? input.paymentMethod : null;
  const collected = reportedCollection(method, input.collectedAmount);
  if (input.status === "entregado") {
    const balance = (await loadRouteCollectionBalances([stop.order_id])).get(stop.order_id);
    if (balance?.remaining == null) return { ok: false, error: "No se pudo comprobar el saldo. Actualiza antes de reportar." };
    if (method !== "sin_cobro" && collected !== null && collected > balance.remaining) {
      return { ok: false, error: `El saldo actual es S/ ${balance.remaining.toFixed(2)}. Revisa los pagos antes de registrar un cobro mayor.` };
    }
    if (method === "sin_cobro" && balance.remaining > 0 && !input.note?.trim()) {
      return { ok: false, error: "Explica por qué no se cobró el saldo pendiente. Esto no lo marcará como pagado." };
    }
  }
  const reason = isNonDeliveryReason(input.outcomeReason) ? input.outcomeReason : null;
  const photoPath = input.photoPath ?? stop.photo_path;
  const voucherPath = input.voucherPath ?? stop.voucher_path;
  if (input.delegated && !photoPath) {
    return { ok: false, error: "Adjunta la evidencia del reporte por el motorizado." };
  }

  if (input.status !== "pendiente") {
    const validation = validateStopReport({
      status: input.status,
      paymentMethod: method,
      collectedAmount: collected,
      outcomeReason: reason,
      note: input.note,
      hasPhoto: Boolean(photoPath),
      hasVoucher: Boolean(voucherPath),
    });
    if (!validation.ok) return { ok: false, error: validation.errors.join(" ") };
  }

  const now = new Date().toISOString();
  const delivered = input.status === "entregado";
  const { error } = await admin
    .from("delivery_stops")
    .update({
      status: input.status,
      payment_method: delivered ? (method as PaymentMethod | null) : null,
      collected_amount: delivered ? collected : null,
      outcome_reason: input.status === "no_entregado" ? reason : null,
      note: input.note,
      photo_path: photoPath,
      voucher_path: voucherPath,
      written_status: input.writtenStatus ?? null,
      written_status_code: input.writtenStatusCode ?? null,
      written_payment: input.writtenPayment ?? null,
      reported_at: input.status === "pendiente" ? null : now,
      reported_by: input.status === "pendiente" ? null : input.actor,
      updated_at: now,
    })
    .eq("id", input.stopId);
  if (error) return { ok: false, error: error.message };

  // Bitácora de quién dijo qué. Best-effort.
  await admin
    .from("delivery_stop_events")
    .insert({
      stop_id: input.stopId,
      status: input.status,
      payment_method: delivered ? method : null,
      collected_amount: delivered ? collected : null,
      outcome_reason: input.status === "no_entregado" ? reason : null,
      note: input.note,
      actor: input.actor,
    })
    .then(
      () => undefined,
      () => undefined,
    );
  return { ok: true, orderId: stop.order_id, routeId: stop.route_id };
}
