"use server";

// Manifiesto de devolución (0307, MOM §9.4, §13 y §29.13; owner 04-11-2026):
// abrir, escanear, editar la cabecera, descartar o anotar una línea, cerrar y
// anular. Permiso de Almacén (`warehouse.prepare`) en la organización del
// manifiesto, y solo las tiendas de quien escanea.
//
// Cada caja se recibe con la recepción de siempre (`gf_return_to_office`,
// dentro de `return_manifest_receive`): el manifiesto no cambia estados de
// pedido por su cuenta. Una caja que llega con su parada todavía pendiente se
// reporta «No entregado · Llegó a oficina sin reporte» por la vía única de
// reporte (`writeStopReport`) y se recibe.

import { revalidatePath } from "next/cache";
import { createAdminSupabase, createServerSupabase } from "@/lib/db";
import { getCurrentUser } from "@/lib/access";
import { courierKey, dispatchScanLabel, normalizeDispatchScan, pickDispatchScanTarget } from "@/lib/dispatch";
import { isCourierTbd } from "@/lib/shipment-output";
import { isGroupGfRiderCourier } from "@/lib/couriers/catalog";
import { limaDateKey } from "@/lib/aliclik-geo";
import { cancelledScanNotice } from "@/lib/scan-cancelled";
import { writeStopReport } from "@/lib/stop-report";
import { REPRO_LIMA_PATH } from "@/lib/repro-lima-program";
import { ambiguousScanError, findScanCandidatesWith, SCAN_NOT_FOUND } from "@/lib/dispatch-scan-lookup";
import { afterGfOfficeReceipt, loadGfBoxFacts } from "@/lib/gf-office-receipt";
import {
  ARRIVED_WITHOUT_REPORT_NOTE,
  ARRIVED_WITHOUT_REPORT_REASON,
  classifyManifestScan,
  receivedLineMessage,
  returnCadenceFor,
  type ReceiptOutcome,
  type ReturnLineFlag,
} from "@/lib/return-manifest";
import { RETURN_MANIFESTS_PATH, returnManifestAccess, returnManifestPath } from "@/lib/return-manifest-access";

export interface ReturnManifestActionResult {
  ok: boolean;
  error?: string;
  notice?: string;
  manifestId?: string;
}

/** Lo que responde un escaneo, en el tono del escáner de Devoluciones. */
export interface ReturnManifestScanResult extends ReturnManifestActionResult {
  /** recibido (verde), observacion (ámbar/rojo, no se recibió), informativa (gris), error (no se anotó). */
  kind: "recibido" | "observacion" | "informativa" | "error";
  lineId?: string;
  flags?: ReturnLineFlag[];
  receiptOutcome?: ReceiptOutcome;
  /** La línea pide una nota (no identificada) antes de cerrar. */
  needsNote?: boolean;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function revalidate(manifestId?: string) {
  revalidatePath(RETURN_MANIFESTS_PATH);
  if (manifestId) revalidatePath(returnManifestPath(manifestId));
}

type HeaderLite = { id: string; org_id: string; courier: string; rider_id: string | null; state: string; label: string };

/** La cabecera (service role) y el acceso de quien la usa en ESA organización. */
async function manifestFor(manifestId: string) {
  if (!manifestId) return { error: "Falta el manifiesto." } as const;
  const admin = createAdminSupabase();
  const { data } = await admin.from("return_manifests").select("id,org_id,courier,rider_id,state,label").eq("id", manifestId).maybeSingle();
  const header = data as HeaderLite | null;
  if (!header) return { error: "No encontramos ese manifiesto de devolución." } as const;
  const access = await returnManifestAccess(header.org_id);
  if (!access.ok) return { error: access.error } as const;
  return { admin, header, access } as const;
}

function rpcError(message: string | undefined): string {
  return (message ?? "No se pudo completar.").replace(/^.*?ERROR:\s*/, "");
}

/**
 * «Nuevo manifiesto de devolución»: uno abierto por motorizado. Si ya hay uno,
 * se vuelve a ese. El plazo para «falta» se congela al abrir.
 */
export async function openReturnManifest(input: { riderId: string; arrivedOn?: string | null }): Promise<ReturnManifestActionResult> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: "No autenticado." };
  const admin = createAdminSupabase();
  const { data } = await admin.from("riders").select("id,org_id,full_name,courier,active").eq("id", input.riderId ?? "").maybeSingle();
  const rider = data as { id: string; org_id: string; full_name: string; courier: string | null; active: boolean } | null;
  if (!rider || !rider.active || !isGroupGfRiderCourier(rider.courier)) return { ok: false, error: "Elige un motorizado activo de Grupo GF." };
  const access = await returnManifestAccess(rider.org_id);
  if (!access.ok) return { ok: false, error: access.error };
  const today = limaDateKey();
  const arrivedOn = input.arrivedOn && DATE_RE.test(input.arrivedOn) && input.arrivedOn <= today ? input.arrivedOn : today;
  const { data: id, error } = await admin.rpc("return_manifest_open", {
    p_org_id: rider.org_id,
    p_courier: "propio",
    p_rider_id: rider.id,
    p_actor: access.userId,
    p_arrived_on: arrivedOn,
    p_cadence_days: returnCadenceFor("propio", rider.full_name),
  });
  if (error || !id) return { ok: false, error: rpcError(error?.message) };
  revalidate(id as string);
  return { ok: true, manifestId: id as string };
}

/**
 * Escanea una caja dentro del manifiesto. Resuelve el código con el MISMO
 * buscador que Almacén → Devoluciones y clasifica con `gfReturnDecision`
 * (`classifyManifestScan`). Nunca recibe por número de pedido si el pedido
 * tiene dos cajas: pide el QR. Un escaneo repetido actualiza su línea.
 */
export async function scanReturnManifest(manifestId: string, rawCode: string, opts: { note?: string | null } = {}): Promise<ReturnManifestScanResult> {
  const code = normalizeDispatchScan(rawCode).slice(0, 200);
  if (!code) return { ok: false, kind: "error", error: "Escanea el QR o escribe el código de la salida." };
  const ctx = await manifestFor(manifestId);
  if ("error" in ctx) return { ok: false, kind: "error", error: ctx.error };
  const { admin, header, access } = ctx;
  if (header.state !== "open") return { ok: false, kind: "error", error: "El manifiesto ya no está abierto." };
  if (header.courier !== "propio" || !header.rider_id) return { ok: false, kind: "error", error: "Este manifiesto no recibe cajas de Grupo GF." };
  const note = opts.note?.trim() ? opts.note.trim().slice(0, 600) : null;

  // El buscador de siempre, con el cliente del usuario (RLS): una salida de
  // otra tienda no aparece.
  const sb = await createServerSupabase();
  const scan = await findScanCandidatesWith(sb, code);
  if (scan.hold) return { ok: false, kind: "error", error: scan.hold };
  const isGf = (courier: string) => courierKey(courier) === "propio" || isCourierTbd(courier);
  const pick = pickDispatchScanTarget(scan.candidates, (candidate) => isGf(candidate.courier));
  if (pick.kind === "ambigua") return { ok: false, kind: "error", error: ambiguousScanError(pick.options) };
  if (pick.kind === "ninguna") {
    const { data: lineId, error } = await admin.rpc("return_manifest_note", {
      p_manifest_id: header.id, p_actor: access.userId, p_scanned_code: code, p_outcome: "held",
      p_flags: ["no_identificada"], p_message: SCAN_NOT_FOUND, p_note: note,
    });
    if (error) return { ok: false, kind: "error", error: rpcError(error.message) };
    revalidate(header.id);
    return { ok: true, kind: "observacion", lineId: lineId as string, flags: ["no_identificada"], needsNote: !note, notice: `${code}: ${SCAN_NOT_FOUND} Anota qué es o descártala.` };
  }
  const shipment = pick.shipment;
  // Fuera de sus tiendas u organización: ni el número del pedido.
  if (!access.storeIds.has(shipment.store_id)) return { ok: false, kind: "error", error: "No tienes acceso a la tienda de esa salida." };
  const label = dispatchScanLabel(shipment);
  const courier = isGf(shipment.courier) ? "propio" : courierKey(shipment.courier);
  const facts = courier === "propio" ? await loadGfBoxFacts(admin, shipment.id, shipment.order_id) : null;
  const plan = classifyManifestScan({
    label,
    headerRiderId: header.rider_id,
    courier,
    box: facts?.item && facts.box
      ? {
          itemId: facts.item.id,
          manifestId: facts.item.manifestId,
          riderId: facts.box.riderId,
          riderName: facts.box.riderName,
          routeDate: facts.box.routeDate,
          stop: facts.stop ? { id: facts.stop.id, status: facts.stop.status, outcomeReason: facts.stop.outcomeReason, routeId: facts.stop.routeId, routeStatus: facts.routeStatus } : null,
        }
      : null,
    custodyState: shipment.custody_state,
    receivedInOffice: facts?.receivedInOffice ?? false,
    replaced: facts?.replaced ?? false,
    saleEnded: facts?.saleEnded ?? false,
  });

  const note_ = async (outcome: "held" | "info", flags: ReturnLineFlag[], message: string): Promise<ReturnManifestScanResult> => {
    const { data: lineId, error } = await admin.rpc("return_manifest_note", {
      p_manifest_id: header.id, p_actor: access.userId, p_scanned_code: code, p_outcome: outcome, p_flags: flags,
      p_shipment_id: shipment.id, p_item_id: facts?.item?.id ?? null, p_message: message, p_note: note,
    });
    if (error) return { ok: false, kind: "error", error: rpcError(error.message) };
    revalidate(header.id);
    return {
      ok: true,
      kind: outcome === "held" ? "observacion" : "informativa",
      lineId: lineId as string,
      flags,
      needsNote: flags.includes("no_identificada") && !note,
      notice: message,
    };
  };

  if (plan.kind === "anotar") return note_(plan.outcome, plan.flags, plan.message);

  // Regla 4: llegó sin reporte. Lo lógico es que no se entregó: se reporta por
  // la vía única de reporte (cobro nulo, sin foto: quien escanea no estuvo en la
  // puerta) y después se recibe. Si el reporte no se puede escribir, queda como
  // observación con el motivo.
  let flags: ("sin_reporte")[] = [];
  if (plan.kind === "reportar_y_recibir") {
    const stop = facts!.stop!;
    const report = await writeStopReport(
      admin,
      {
        stopId: stop.id,
        status: "no_entregado",
        paymentMethod: null,
        collectedAmount: null,
        outcomeReason: ARRIVED_WITHOUT_REPORT_REASON,
        note: `${ARRIVED_WITHOUT_REPORT_NOTE} · ${header.label}`,
        actor: access.userId,
      },
      { stop: { id: stop.id, order_id: stop.orderId, route_id: stop.routeId, photo_path: stop.photoPath, voucher_path: stop.voucherPath }, routeStatus: facts!.routeStatus },
    );
    if (!report.ok) {
      return note_("held", plan.otraCaja ? ["sin_reporte", "otra_caja"] : ["sin_reporte"], `${label} llegó sin reporte y no se pudo reportar: ${report.error}`);
    }
    flags = ["sin_reporte"];
  }

  const cancelled = await cancelledScanNotice(admin, shipment.order_id);
  const { data: received, error } = await admin.rpc("return_manifest_receive", {
    p_manifest_id: header.id,
    p_item_id: facts!.item!.id,
    p_actor: access.userId,
    p_scanned_code: code,
    p_flags: flags,
  });
  if (error) return { ok: false, kind: "error", error: `${label}: ${rpcError(error.message)}` };
  const res = received as { line_id: string; order_id: string | null; receipt_outcome: ReceiptOutcome; flags: ReturnLineFlag[] };
  // Lo de siempre después de recibir: Repro Lima para lo que vuelve a «por
  // asignar» y el Master al día. El aviso dice lo que la base hizo.
  const after = await afterGfOfficeReceipt(admin, {
    shipmentId: shipment.id,
    orderId: res.order_id,
    actor: access.userId,
    label,
    riderName: facts!.box!.riderName,
    routeDate: facts!.box!.routeDate,
    cancelledNotice: cancelled,
  });
  const message = receivedLineMessage({
    label,
    receiptOutcome: res.receipt_outcome,
    otraCaja: res.flags.includes("otra_caja"),
    sinReporte: res.flags.includes("sin_reporte"),
    boxRiderName: facts!.box!.riderName,
    boxRouteDate: facts!.box!.routeDate,
  });
  revalidate(header.id);
  revalidatePath("/dashboard/pedidos");
  revalidatePath("/dashboard/courier");
  revalidatePath(REPRO_LIMA_PATH);
  return {
    ok: true,
    kind: "recibido",
    lineId: res.line_id,
    flags: res.flags,
    receiptOutcome: res.receipt_outcome,
    // Un anulado solo en Kapta (no en la tienda) vuelve a «por asignar»: se dice.
    notice: [message, ...after.reproParts, after.outcome === "por_asignar" ? cancelled : null].filter(Boolean).join(" "),
  };
}

/** «Entregó», «Declara N paquetes» y la nota, mientras está abierto. */
export async function updateReturnManifestHeader(
  manifestId: string,
  patch: { handedOverBy?: string | null; declaredCount?: number | null; note?: string | null },
): Promise<ReturnManifestActionResult> {
  const ctx = await manifestFor(manifestId);
  if ("error" in ctx) return { ok: false, error: ctx.error };
  if (ctx.header.state !== "open") return { ok: false, error: "El manifiesto ya no está abierto." };
  const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (patch.handedOverBy !== undefined) update.handed_over_by = patch.handedOverBy?.trim().slice(0, 120) || null;
  if (patch.declaredCount !== undefined) {
    const n = patch.declaredCount;
    if (n != null && (!Number.isInteger(n) || n < 0 || n > 5000)) return { ok: false, error: "La cifra declarada no es válida." };
    update.declared_count = n;
  }
  if (patch.note !== undefined) update.note = patch.note?.trim().slice(0, 1000) || null;
  const { error } = await ctx.admin.from("return_manifests").update(update).eq("id", manifestId).eq("state", "open");
  if (error) return { ok: false, error: rpcError(error.message) };
  revalidate(manifestId);
  return { ok: true, manifestId };
}

async function lineFor(lineId: string) {
  const admin = createAdminSupabase();
  const { data } = await admin.from("return_manifest_lines").select("id,manifest_id,store_id,outcome,flags,removed_at").eq("id", lineId ?? "").maybeSingle();
  const line = data as { id: string; manifest_id: string; store_id: string | null; outcome: string; flags: string[]; removed_at: string | null } | null;
  if (!line) return { error: "No encontramos esa línea." } as const;
  const ctx = await manifestFor(line.manifest_id);
  if ("error" in ctx) return { error: ctx.error } as const;
  if (line.store_id && !ctx.access.storeIds.has(line.store_id)) return { error: "No tienes acceso a la tienda de esa salida." } as const;
  if (ctx.header.state !== "open") return { error: "El manifiesto ya no está abierto." } as const;
  return { ...ctx, line } as const;
}

/**
 * Descartar una línea que no se recibió (escaneo equivocado, otra cosa), con
 * motivo. Lo recibido no se deshace desde aquí: reclamarlo sigue su camino.
 */
export async function discardReturnManifestLine(lineId: string, reason: string): Promise<ReturnManifestActionResult> {
  const why = (reason ?? "").trim();
  if (why.length < 5) return { ok: false, error: "Escribe el motivo (al menos 5 letras)." };
  const ctx = await lineFor(lineId);
  if ("error" in ctx) return { ok: false, error: ctx.error };
  if (ctx.line.removed_at) return { ok: true, manifestId: ctx.header.id, notice: "Ya estaba descartada." };
  if (ctx.line.outcome === "received") return { ok: false, error: "Esa caja ya se recibió: no se descarta desde el manifiesto." };
  const { error } = await ctx.admin
    .from("return_manifest_lines")
    .update({ removed_at: new Date().toISOString(), removed_by: ctx.access.userId, removal_reason: why.slice(0, 300) })
    .eq("id", lineId)
    .is("removed_at", null);
  if (error) return { ok: false, error: rpcError(error.message) };
  revalidate(ctx.header.id);
  return { ok: true, manifestId: ctx.header.id, notice: "Línea descartada." };
}

/** La nota de una línea (obligatoria en una no identificada antes de cerrar). */
export async function setReturnManifestLineNote(lineId: string, note: string): Promise<ReturnManifestActionResult> {
  const text = (note ?? "").trim();
  if (text.length < 3) return { ok: false, error: "Escribe la nota (al menos 3 letras)." };
  const ctx = await lineFor(lineId);
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const { error } = await ctx.admin.from("return_manifest_lines").update({ note: text.slice(0, 600) }).eq("id", lineId).is("removed_at", null);
  if (error) return { ok: false, error: rpcError(error.message) };
  revalidate(ctx.header.id);
  return { ok: true, manifestId: ctx.header.id };
}

/**
 * Cerrar: pide «Entregó» (≥3 letras), anota como «Falta» lo esperado fuera de
 * plazo que no llegó y congela el manifiesto. No cambia ningún pedido.
 */
export async function closeReturnManifest(manifestId: string, handedOverBy: string): Promise<ReturnManifestActionResult & { missing?: number }> {
  const who = (handedOverBy ?? "").trim();
  if (who.length < 3) return { ok: false, error: "Escribe quién entregó las cajas (al menos 3 letras)." };
  const ctx = await manifestFor(manifestId);
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const { data, error } = await ctx.admin.rpc("return_manifest_close", { p_manifest_id: manifestId, p_actor: ctx.access.userId, p_handed_over_by: who });
  if (error) return { ok: false, error: rpcError(error.message) };
  const missing = Number((data as { missing?: number } | null)?.missing ?? 0);
  revalidate(manifestId);
  return {
    ok: true,
    manifestId,
    missing,
    notice: missing
      ? `Manifiesto cerrado. ${missing} ${missing === 1 ? "caja esperada faltó" : "cajas esperadas faltaron"}: siguen «No entregado» a nombre del motorizado.`
      : "Manifiesto cerrado.",
  };
}

/** Anular: solo sin cajas recibidas, con motivo. */
export async function cancelReturnManifest(manifestId: string, reason: string): Promise<ReturnManifestActionResult> {
  const why = (reason ?? "").trim();
  if (why.length < 5) return { ok: false, error: "Escribe el motivo de la anulación (al menos 5 letras)." };
  const ctx = await manifestFor(manifestId);
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const { error } = await ctx.admin.rpc("return_manifest_cancel", { p_manifest_id: manifestId, p_actor: ctx.access.userId, p_reason: why });
  if (error) return { ok: false, error: rpcError(error.message) };
  revalidate(manifestId);
  return { ok: true, manifestId, notice: "Manifiesto anulado." };
}
