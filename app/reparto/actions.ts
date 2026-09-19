"use server";

// Reportes del motorizado o de coordinación autorizada. El actor es siempre
// quien inició sesión, nunca el usuario del motorizado responsable.
//
// Tres barreras, a propósito redundantes:
//
//   1. routes.deliver para la ruta propia; routes.report_others para terceros.
//   2. Propiedad o concesión en la organización exacta de la ruta en curso.
//   3. Las políticas RLS de 0056, que filtran por `riders.user_id = auth.uid()`.
//
// La tercera es la que de verdad manda: si mañana alguien añade otra ruta de
// entrada a estos datos y se olvida de comprobar, la base sigue diciendo que no.
// Las dos primeras están para dar un error claro en vez de un silencio.

import { revalidatePath } from "next/cache";
import { createAdminSupabase, createServerSupabase } from "@/lib/db";
import { getCurrentUser } from "@/lib/access";
import { getMasterPermissions } from "@/lib/permissions-access";
import { routeReportAccess } from "@/lib/route-report-access";
import { reportedCollection } from "@/lib/route-collection";
import { loadRouteCollectionBalances } from "@/lib/route-collection-access";
import {
  isNonDeliveryReason,
  isPaymentMethod,
  validateStopReport,
  type PaymentMethod,
  type StopStatus,
} from "@/lib/routes";
import { syncStopsToSheet } from "@/lib/sheets/stop-sync";

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
  reportReason?: string | null;
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
  if (!perms.can("routes.deliver") && !perms.can("routes.report_others")) {
    return { ok: false, error: "Tu rol no permite reportar entregas." };
  }

  // La lectura va con el cliente del USUARIO: si RLS no le deja ver la parada,
  // aquí ya no existe, y no hace falta comprobar de quién es a mano.
  const sb = await createServerSupabase();
  const { data: stopRow } = await sb
    .from("delivery_stops")
    .select("id,order_id,route_id,photo_path,voucher_path")
    .eq("id", input.stopId)
    .maybeSingle();
  if (!stopRow) return { ok: false, error: "Esa parada no es tuya o ya no está disponible." };

  const stop = stopRow as { id: string; order_id: string; route_id: string; photo_path: string | null; voucher_path: string | null };
  const access = await routeReportAccess(stop.route_id);
  if (!access) return { ok: false, error: "No tienes permiso para reportar esta ruta o ya no está en curso." };
  const reasonForReport = input.reportReason?.trim();
  if (access.delegated && !reasonForReport) {
    return { ok: false, error: "Indica por qué reportas por el motorizado." };
  }
  const reportNote = access.delegated
    ? `Registrado por ${access.actorLabel} en nombre de ${access.riderName}. Motivo: ${reasonForReport}. ${input.note?.trim() ?? ""}`.trim()
    : input.note?.trim() || null;
  // Only proofs uploaded for this exact stop may be attached to its report.
  for (const path of [input.photoPath, input.voucherPath]) {
    if (path && (!path.startsWith(`${stop.route_id}/${stop.id}/`) || path.includes(".."))) {
      return { ok: false, error: "La evidencia no pertenece a esta parada." };
    }
  }

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
  // Se conservan las fotos ya subidas cuando el reporte es una corrección que no
  // vuelve a adjuntarlas.
  const photoPath = input.photoPath ?? stop.photo_path;
  const voucherPath = input.voucherPath ?? stop.voucher_path;
  if (access.delegated && !photoPath) {
    return { ok: false, error: "Adjunta la evidencia del reporte por el motorizado." };
  }

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
      collected_amount: input.status === "entregado" ? collected : null,
      outcome_reason: input.status === "no_entregado" ? reason : null,
      note: reportNote,
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
      collected_amount: input.status === "entregado" ? collected : null,
      outcome_reason: input.status === "no_entregado" ? reason : null,
      note: reportNote,
      actor: user.id,
    })
    .then(
      () => undefined,
      () => undefined,
    );

  // La hoja de Reparto propio del motorizado refleja la parada (MOM §29.12).
  // Best-effort: si la hoja no existe o falla el cuadre, el reporte ya quedó.
  await syncStopForRoute(admin, stop.route_id, input.stopId, user.id);

  revalidatePath("/reparto");
  revalidatePath("/dashboard/courier/reparto");
  revalidatePath("/dashboard/courier");
  revalidatePath("/dashboard/liquidaciones-2");
  return {
    ok: true,
    message: input.status === "entregado" ? "Entrega registrada." : "Reportado como no entregado.",
  };
}

/** Lleva UNA parada a la hoja del motorizado de esa ruta. No lanza. */
async function syncStopForRoute(
  admin: ReturnType<typeof createAdminSupabase>,
  routeId: string,
  stopId: string,
  actor: string,
): Promise<void> {
  try {
    const { data: route } = await admin
      .from("delivery_routes")
      .select("org_id,rider_id,route_date")
      .eq("id", routeId)
      .maybeSingle();
    if (!route) return;
    await syncStopsToSheet(admin, {
      orgId: route.org_id as string,
      riderId: route.rider_id as string,
      date: String(route.route_date),
      stopIds: [stopId],
      actor,
    });
  } catch (e) {
    console.error("[reparto] no se pudo sincronizar la hoja del motorizado", e instanceof Error ? e.message : e);
  }
}
