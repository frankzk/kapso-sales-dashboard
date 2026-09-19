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
import type { StopStatus } from "@/lib/routes";
import { writeStopReport } from "@/lib/stop-report";
import { explainStopAmount, riderSheetFor, syncStopsToSheet } from "@/lib/sheets/stop-sync";
import { getMyRider } from "@/lib/routes-access";
import { getRiderSheet, loadRiderOrders, searchRiderOrders, type RiderOrderCandidate } from "@/lib/sheets/rider-access";
import { buildNewPoint, montoDiffers } from "@/lib/sheets/rider-cuaderno";
import { normalizeAlias } from "@/lib/sheets/statuses";

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
  /** Lo que el motorizado escribió tal cual y su equivalente en el dominio
   *  Reparto propio (0172, MOM §29.12). Opcionales: la pantalla vieja no los manda. */
  writtenStatus?: string | null;
  writtenStatusCode?: string | null;
  writtenPayment?: string | null;
  /** Obligatorios cuando la entrega cobró distinto al total del pedido en más
   *  de S/ 0,50 (MOM §30.9): abren la observación de monto con su motivo. */
  reasonCode?: string | null;
  reasonNote?: string | null;
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

  // Motivo obligatorio: entrega cobrada distinto al total del pedido (MOM §30.9).
  let orderTotal: number | null = null;
  if (input.status === "entregado") {
    // Total del pedido: si no se puede leer, no se inventa la exigencia.
    try {
      const { data: order } = await createAdminSupabase().from("orders").select("total_amount").eq("id", stop.order_id).maybeSingle();
      const total = (order as { total_amount: number | string | null } | null)?.total_amount;
      orderTotal = total === null || total === undefined ? null : Number(total);
    } catch {
      orderTotal = null;
    }
    const collectedForReason = input.paymentMethod === "sin_cobro" ? 0 : input.collectedAmount;
    const reasonCode = input.reasonCode?.trim() || null;
    if (montoDiffers(collectedForReason ?? null, orderTotal) && !reasonCode) {
      return {
        ok: false,
        error: `Cobraste S/ ${(collectedForReason ?? 0).toFixed(2)} y el pedido es de S/ ${(orderTotal ?? 0).toFixed(2)}. Explica por qué antes de guardar.`,
      };
    }
    if (reasonCode === "otro" && (input.reasonNote?.trim().length ?? 0) < 3) {
      return { ok: false, error: "Con motivo «Otro», escribe una nota." };
    }
  }

  // La escritura va por el ÚNICO camino (lib/stop-report.ts): ruta en curso,
  // saldo real, evidencia y catálogo se comprueban ahí, para /reparto y para
  // Liquidaciones 2 por igual. El service role controla qué columnas se tocan.
  const admin = createAdminSupabase();
  const written = await writeStopReport(admin, {
    stopId: input.stopId,
    status: input.status,
    paymentMethod: input.paymentMethod,
    collectedAmount: input.collectedAmount,
    outcomeReason: input.outcomeReason,
    note: reportNote,
    photoPath: input.photoPath,
    voucherPath: input.voucherPath,
    actor: user.id,
    writtenStatus: input.writtenStatus ?? null,
    writtenStatusCode: input.writtenStatusCode ?? null,
    writtenPayment: input.writtenPayment ?? null,
    delegated: access.delegated,
  }, { stop, routeStatus });
  if (!written.ok) return { ok: false, error: written.error };

  // La hoja de Reparto propio del motorizado refleja la parada (MOM §29.12).
  // Best-effort: si la hoja no existe o falla el cuadre, el reporte ya quedó.
  await syncStopForRoute(admin, stop.route_id, input.stopId, user.id);
  const reasonCode = input.reasonCode?.trim() || null;
  if (input.status === "entregado" && reasonCode) {
    try {
      await explainStopAmount(admin, {
        stopId: input.stopId,
        reasonCode,
        note: input.reasonNote?.trim() || null,
        actor: user.id,
        riderName: access.riderName,
        collected: input.paymentMethod === "sin_cobro" ? 0 : (input.collectedAmount ?? null),
        total: orderTotal,
      });
    } catch (e) {
      console.error("[reparto] no se pudo guardar la explicación del monto", e instanceof Error ? e.message : e);
    }
  }
  // Un estado escrito sin equivalente queda registrado como alias de la hoja
  // para que alguien lo asigne una vez (MOM §30.3).
  if (input.writtenStatus?.trim() && !input.writtenStatusCode) {
    try {
      const { data: route } = await admin.from("delivery_routes").select("org_id,rider_id").eq("id", stop.route_id).maybeSingle();
      const sheet = route ? await riderSheetFor(admin, route.org_id as string, route.rider_id as string) : null;
      if (sheet) {
        await admin
          .from("sheet_status_aliases")
          .upsert({ sheet_id: sheet.id, alias: normalizeAlias(input.writtenStatus), status_code: null, seen_count: 1 }, { onConflict: "sheet_id,alias", ignoreDuplicates: true });
      }
    } catch {
      /* best-effort */
    }
  }

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

// ---------------------------------------------------------------------------
// Puntos que no vienen de una carga (MOM §30.9 · §29.12)
// ---------------------------------------------------------------------------

async function riderGuard() {
  const user = await getCurrentUser();
  if (!user) return { error: "No autenticado." as const };
  const perms = await getMasterPermissions();
  if (!perms.can("routes.deliver")) return { error: "Tu rol no permite reportar entregas." as const };
  const rider = await getMyRider();
  if (!rider) return { error: "Tu usuario no tiene ficha de motorizado." as const };
  const sheet = await getRiderSheet(rider.id);
  if (!sheet) return { error: "Todavía no tienes hoja de reparto. Pide que la creen desde Liquidaciones 2." as const };
  return { user, rider, sheet, admin: createAdminSupabase() };
}

export async function searchOrdersForRider(query: string): Promise<{ ok: boolean; error?: string; results: RiderOrderCandidate[] }> {
  const g = await riderGuard();
  if ("error" in g) return { ok: false, error: g.error, results: [] };
  try {
    return { ok: true, results: await searchRiderOrders(g.sheet.org_id, query) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e), results: [] };
  }
}

/**
 * Un pedido de Kapta que el motorizado lleva sin que haya pasado por la Mesa
 * de despacho: se crea como PARADA dentro de su ruta del día (creada al vuelo
 * si no existe, ya en curso), para que sea tan canónica como las demás. La
 * hoja se sincroniza sola.
 */
export async function addManualStop(input: { orderId: string; fecha: string }): Promise<ReportResult> {
  const g = await riderGuard();
  if ("error" in g) return { ok: false, error: g.error };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.fecha)) return { ok: false, error: "Fecha no válida." };
  const info = (await loadRiderOrders([input.orderId]))[input.orderId];
  if (!info) return { ok: false, error: "Ese pedido no existe." };
  const { data: order } = await g.admin.from("orders").select("id,store_id,stores(org_id)").eq("id", input.orderId).maybeSingle();
  const o = order as unknown as { id: string; store_id: string; stores: { org_id: string } | null } | null;
  if (!o || o.stores?.org_id !== g.sheet.org_id) return { ok: false, error: "Ese pedido no es de tu organización." };

  const { data: existingRoute } = await g.admin
    .from("delivery_routes")
    .select("id,status")
    .eq("org_id", g.sheet.org_id)
    .eq("rider_id", g.rider.id)
    .eq("route_date", input.fecha)
    .maybeSingle();
  let routeId = existingRoute?.id as string | undefined;
  if (existingRoute && existingRoute.status === "cerrada") {
    return { ok: false, error: "Tu ruta de ese día ya está cerrada. Avisa al coordinador." };
  }
  if (!routeId) {
    const now = new Date().toISOString();
    const { data: created, error } = await g.admin
      .from("delivery_routes")
      .insert({ org_id: g.sheet.org_id, store_id: o.store_id, rider_id: g.rider.id, route_date: input.fecha, status: "en_curso", started_at: now, created_by: g.user.id, note: "Creada desde el teléfono del motorizado (punto a mano)." })
      .select("id")
      .single();
    if (error || !created) return { ok: false, error: error?.message ?? "No se pudo abrir tu ruta del día." };
    routeId = created.id as string;
  } else if (existingRoute?.status === "planificada") {
    await g.admin.from("delivery_routes").update({ status: "en_curso", started_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("id", routeId);
  }
  const { data: stops } = await g.admin.from("delivery_stops").select("order_id,seq").eq("route_id", routeId);
  const list = (stops ?? []) as { order_id: string; seq: number }[];
  if (list.some((st) => st.order_id === o.id)) return { ok: false, error: "Ese pedido ya está en tu ruta de ese día." };
  const seq = Math.max(0, ...list.map((st) => st.seq)) + 1;
  const { error: stopErr } = await g.admin.from("delivery_stops").insert({ route_id: routeId, order_id: o.id, store_id: o.store_id, seq });
  if (stopErr) return { ok: false, error: stopErr.message };
  try {
    await syncStopsToSheet(g.admin, { orgId: g.sheet.org_id, riderId: g.rider.id, date: input.fecha, actor: g.user.id });
  } catch (e) {
    console.error("[reparto] sincronización tras punto a mano", e instanceof Error ? e.message : e);
  }
  revalidatePath("/reparto");
  revalidatePath("/dashboard/courier/reparto");
  revalidatePath("/dashboard/liquidaciones-2");
  return { ok: true, message: `${info.order_name ?? "Pedido"} añadido a tu ruta.` };
}

/**
 * Punto SIN pedido Shopify (Kast, encargos): no puede ser parada (la parada
 * exige un pedido de Kapta), así que vive solo en la hoja del motorizado.
 */
export async function addSheetOnlyPoint(input: { fecha: string; cliente: string; tienda?: string | null }): Promise<ReportResult> {
  const g = await riderGuard();
  if ("error" in g) return { ok: false, error: g.error };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.fecha)) return { ok: false, error: "Fecha no válida." };
  const cliente = input.cliente.trim();
  if (!cliente) return { ok: false, error: "Escribe el nombre del cliente." };
  const { data: existing } = await g.admin
    .from("sheet_rows")
    .select("row_key,values")
    .eq("sheet_id", g.sheet.id)
    .filter("values->>fecha", "eq", input.fecha)
    .limit(500);
  const rows = (existing ?? []) as { row_key: string; values: Record<string, unknown> }[];
  const built = buildNewPoint({
    fecha: input.fecha,
    pedido: null,
    cliente,
    tienda: input.tienda?.trim() || "Kast",
    a_cobrar: null,
    existingPuntos: rows.map((r) => (typeof r.values.punto === "string" ? r.values.punto : null)),
    existingKeys: new Set(rows.map((r) => r.row_key)),
  });
  const { error } = await g.admin.from("sheet_rows").insert({ sheet_id: g.sheet.id, row_key: built.row_key, order_id: null, values: built.values, source: "manual", created_by: g.user.id });
  if (error) return { ok: false, error: error.message };
  revalidatePath("/reparto");
  revalidatePath("/dashboard/liquidaciones-2");
  return { ok: true, message: `${built.values.punto} añadido a tu cuaderno (sin pedido de Kapta).` };
}
