"use server";

// Lo que el motorizado hace desde su teléfono. Poco y muy acotado: reportar una
// parada suya. Nada más.
//
// Tres barreras, a propósito redundantes:
//
//   1. El permiso `routes.deliver` (rol motorizado).
//   2. La comprobación explícita de que la parada es de SU ruta en curso.
//   3. Las políticas RLS de 0056, que filtran por `riders.user_id = auth.uid()`.
//
// La tercera es la que de verdad manda: si mañana alguien añade otra ruta de
// entrada a estos datos y se olvida de comprobar, la base sigue diciendo que no.
// Las dos primeras están para dar un error claro en vez de un silencio.

import { revalidatePath } from "next/cache";
import { createAdminSupabase, createServerSupabase } from "@/lib/db";
import { getCurrentUser } from "@/lib/access";
import { getMasterPermissions } from "@/lib/permissions-access";
import {
  isNonDeliveryReason,
  isPaymentMethod,
  validateStopReport,
  type PaymentMethod,
  type StopStatus,
} from "@/lib/routes";

export interface ReportResult {
  ok: boolean;
  error?: string;
  message?: string;
}

export interface ReportStopInput {
  stopId: string;
  status: StopStatus;
  paymentMethod: string | null;
  collectedAmount: number | null;
  outcomeReason: string | null;
  note: string | null;
  /** Rutas en el bucket privado, ya subidas por /api/reparto/foto. */
  photoPath: string | null;
  voucherPath: string | null;
}

/**
 * Reporta (o corrige) una parada.
 *
 * Escribe SOLO en la parada: el Master no se toca. Que el motorizado marque
 * "entregado" no cierra el pedido — eso lo siguen haciendo el courier y el
 * equipo, y la liquidación compara ambas versiones. Es la misma regla que con
 * la hoja de un courier: lo declarado nunca pisa lo real.
 */
export async function reportStop(input: ReportStopInput): Promise<ReportResult> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: "No autenticado." };

  const perms = await getMasterPermissions();
  if (!perms.can("routes.deliver") && !perms.can("routes.manage")) {
    return { ok: false, error: "Tu rol no permite reportar entregas." };
  }

  // La lectura va con el cliente del USUARIO: si RLS no le deja ver la parada,
  // aquí ya no existe, y no hace falta comprobar de quién es a mano.
  const sb = await createServerSupabase();
  const { data: stopRow } = await sb
    .from("delivery_stops")
    .select("id,route_id,photo_path,voucher_path")
    .eq("id", input.stopId)
    .maybeSingle();
  if (!stopRow) return { ok: false, error: "Esa parada no es tuya o ya no está disponible." };

  const stop = stopRow as { id: string; route_id: string; photo_path: string | null; voucher_path: string | null };

  const { data: routeRow } = await sb
    .from("delivery_routes")
    .select("id,status")
    .eq("id", stop.route_id)
    .maybeSingle();
  const routeStatus = (routeRow as { status?: string } | null)?.status;
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
  const reason = isNonDeliveryReason(input.outcomeReason) ? input.outcomeReason : null;
  // Se conservan las fotos ya subidas cuando el reporte es una corrección que no
  // vuelve a adjuntarlas.
  const photoPath = input.photoPath ?? stop.photo_path;
  const voucherPath = input.voucherPath ?? stop.voucher_path;

  const validation = validateStopReport({
    status: input.status,
    paymentMethod: method,
    collectedAmount: input.collectedAmount,
    outcomeReason: reason,
    note: input.note,
    hasPhoto: Boolean(photoPath),
    hasVoucher: Boolean(voucherPath),
  });
  if (!validation.ok) return { ok: false, error: validation.errors.join(" ") };

  const now = new Date().toISOString();
  // La escritura va por el service role: la parada tiene columnas que el
  // motorizado no debe poder mover (la ruta a la que pertenece, el pedido), y
  // así se controla exactamente qué se escribe.
  const admin = createAdminSupabase();
  const { error } = await admin
    .from("delivery_stops")
    .update({
      status: input.status,
      payment_method: input.status === "entregado" ? method : null,
      collected_amount: input.status === "entregado" ? input.collectedAmount : null,
      outcome_reason: input.status === "no_entregado" ? reason : null,
      note: input.note?.trim() || null,
      photo_path: photoPath,
      voucher_path: voucherPath,
      reported_at: now,
      reported_by: user.id,
      updated_at: now,
    })
    .eq("id", input.stopId);
  if (error) return { ok: false, error: error.message };

  // El rastro de quién dijo qué. Best-effort: perder la bitácora no debe costar
  // el reporte, pero se registra siempre que se pueda.
  await admin
    .from("delivery_stop_events")
    .insert({
      stop_id: input.stopId,
      status: input.status,
      payment_method: input.status === "entregado" ? method : null,
      collected_amount: input.status === "entregado" ? input.collectedAmount : null,
      outcome_reason: input.status === "no_entregado" ? reason : null,
      note: input.note?.trim() || null,
      actor: user.id,
    })
    .then(
      () => undefined,
      () => undefined,
    );

  revalidatePath("/reparto");
  return {
    ok: true,
    message: input.status === "entregado" ? "Entrega registrada." : "Reportado como no entregado.",
  };
}
