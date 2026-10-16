// El ÚNICO camino para escribir el reporte de una parada (`delivery_stops`):
// lo usan la pantalla del motorizado (/reparto), coordinación y las ediciones
// de una fila de cuaderno atada a su parada en Liquidaciones 2 (MOM §29.12).
// Trae toda la validación de Rutas: ruta en curso, saldo real del pedido,
// evidencia, y el enum + motivo del catálogo. Sin permisos: los comprueba
// quien llama (routeReportAccess en /reparto; sheets.edit en Liquidaciones 2).

import type { SupabaseClient } from "@supabase/supabase-js";
import { NON_DELIVERY_REASONS } from "@/lib/routes";
import { recomputeOrderMasterSafe } from "@/lib/order-master";
import { isReturningOwnOutput, OUTPUT_REPLACED_KIND, replacedOutputIds, type ReturningOutputLike } from "@/lib/gf-replaced-output";
import { reportedCollection } from "@/lib/route-collection";
import { loadRouteCollectionBalances } from "@/lib/route-collection-access";
import { rescheduleDateProblem } from "@/lib/gf-dispatch-program";
import { programDayLabel } from "@/lib/dispatch-day";
import { limaTodayKey } from "@/lib/shipments";
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
  /** Lo escrito literal y su código del dominio Reparto propio (0180). */
  writtenStatus?: string | null;
  writtenStatusCode?: string | null;
  writtenPayment?: string | null;
  /** Coordinación o Liquidaciones 2 escribiendo por el motorizado. */
  delegated?: boolean;
  /**
   * Cargado desde la hoja del motorizado sin app (MOM §29.7, 08-10-2026):
   * `reported_by` queda null —la marca de «desde el cuaderno», que lo exime de
   * foto al cerrar y al pagar— y no se pide foto ni captura del Yape, porque
   * nadie estuvo en la puerta con el teléfono. Quién lo cargó queda en
   * `actor` y en la actividad del pedido.
   */
  notebook?: { riderName: string; importId: string } | null;
  /**
   * Fecha que pidió el cliente (YYYY-MM-DD, Lima; MOM §9.5, 12-10-2026).
   * undefined conserva; null borra; solo con no_entregado·reprogramado. Es
   * informativa: nunca programa la salida; la tienda la confirma en Repro Lima.
   */
  requestedDate?: string | null;
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

  // La caja reemplazada por otra salida (0248, «Sacar con salida nueva») ya no
  // se entrega ni se reporta: vuelve a la oficina. La guarda de verdad es el
  // trigger `delivery_stops_guard_replaced`; esto da el mensaje claro antes.
  if (await stopIsFrozenByReplacement(admin, stop.id, input.status)) return { ok: false, error: REPLACED_STOP_ERROR };

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
  // La fecha que pidió el cliente solo vive con «Reprogramado por el cliente»
  // (CHECK delivery_stops_requested_date_ck); con otro resultado se borra. Se
  // valida ANTES de escribir: una fecha mala no deja el reporte a medias.
  const keeps = input.status === "no_entregado" && reason === "reprogramado";
  const requestedDate = input.requestedDate === undefined ? undefined : input.requestedDate?.trim() || null;
  if (keeps && requestedDate) {
    const problem = rescheduleDateProblem(requestedDate, limaTodayKey());
    if (problem) return { ok: false, error: problem };
  }
  const photoPath = input.photoPath ?? stop.photo_path;
  const voucherPath = input.voucherPath ?? stop.voucher_path;
  const notebook = input.notebook ?? null;
  if (notebook && input.delegated) return { ok: false, error: "Un reporte desde el cuaderno no es delegado." };
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
    // Desde el cuaderno no hay foto ni captura que pedir; lo demás vale igual.
    const errors = validation.errors.filter((_, i) => !notebook || (validation.fields[i] !== "foto" && validation.fields[i] !== "yape"));
    if (errors.length) return { ok: false, error: errors.join(" ") };
  }

  const now = new Date().toISOString();
  const delivered = input.status === "entregado";
  // Modo «confirmar» (0185): al entregar se congela si el motorizado había
  // dicho «Lo llevo». Null cuando la parada no salió de una caja de despacho.
  const pickup = delivered ? await pickupConfirmationFor(admin, stop.id).catch(() => null) : null;
  const unconfirmed = delivered && pickup?.confirmed === false;
  const { error } = await admin
    .from("delivery_stops")
    .update({
      status: input.status,
      pickup_confirmed: delivered ? (pickup?.confirmed ?? null) : null,
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
      reported_by: input.status === "pendiente" || notebook ? null : input.actor,
      ...(keeps ? (requestedDate === undefined ? {} : { requested_date: requestedDate }) : { requested_date: null }),
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
      note: unconfirmed ? [input.note, UNCONFIRMED_PICKUP_NOTE].filter(Boolean).join(" · ") : input.note,
      actor: input.actor,
    })
    .then(
      () => undefined,
      () => undefined,
    );
  // Rastro en el pedido (pestaña Actividad) de cada reporte: quién, qué
  // resultado, cómo cobró y qué evidencia dejó. Desde mom-v1.14 este evento
  // mueve la etapa del pedido (§29.13), así que se recalcula el Master abajo.
  if (input.status === "pendiente") {
    // Deshacer un reporte también deja rastro: sin él, el resolver seguiría
    // leyendo el «entregado» anterior como la última palabra del motorizado.
    await writeStopUndoEvent(admin, stop.id, stop.route_id, stop.order_id, input.actor).catch(() => undefined);
  } else {
    await writeStopReportedEvent(admin, {
      stopId: stop.id,
      routeId: stop.route_id,
      orderId: stop.order_id,
      actor: input.actor,
      status: input.status,
      method: delivered ? method : null,
      collected: delivered ? collected : null,
      reason: input.status === "no_entregado" ? reason : null,
      note: input.note ?? null,
      photoPath,
      voucherPath,
      delegated: Boolean(input.delegated),
      notebook,
      requestedDate: keeps && requestedDate ? requestedDate : null,
    }).catch(() => undefined);
  }
  if (unconfirmed && pickup) {
    // Rastro en el pedido (pestaña Actividad): entregado sin haber confirmado
    // el recojo. No mueve el Master; es información.
    await admin
      .from("order_events")
      .insert({
        store_id: pickup.storeId,
        order_id: stop.order_id,
        kind: "delivered_unconfirmed_pickup",
        actor: input.actor,
        source: "reparto",
        courier: "propio",
        shipment_id: pickup.shipmentId,
        note: UNCONFIRMED_PICKUP_NOTE,
        payload: { stop_id: stop.id, route_id: stop.route_id, manifest_id: pickup.manifestId },
      })
      .then(
        () => undefined,
        () => undefined,
      );
  }
  // La etapa sigue al motorizado (mom-v1.14): entregado → Por cerrar,
  // postergado → Por reprogramar Lima, etc. Sin esto el pedido esperaba al
  // cron y seguía «En curso» después de entregado.
  await recomputeOrderMasterSafe(admin, [stop.order_id]).catch(() => undefined);
  return { ok: true, orderId: stop.order_id, routeId: stop.route_id };
}

export const REPLACED_STOP_ERROR = "Este paquete ya salió con otra salida: no se entrega ni se reporta. Tráelo a la oficina.";

/**
 * ¿El reporte cambiaría el estado de la parada de una salida reemplazada que el
 * motorizado todavía tiene? Lo mismo que el trigger: propia en devolución
 * (`isReturningOwnOutput`) con el evento `output_replaced`. Corregir la nota o
 * el motivo sin cambiar el estado sí se puede, y una salida en `retorno` por
 * «Solicitar devolución» (§13) se sigue reportando.
 */
async function stopIsFrozenByReplacement(admin: SupabaseClient, stopId: string, nextStatus: string): Promise<boolean> {
  const { data: stopRow } = await admin.from("delivery_stops").select("shipment_id,status").eq("id", stopId).maybeSingle();
  const row = stopRow as { shipment_id: string | null; status: string } | null;
  if (!row?.shipment_id || row.status === nextStatus) return false;
  const { data: shipment } = await admin.from("shipments").select("courier,delivery_status,custody_state,returned_at").eq("id", row.shipment_id).maybeSingle();
  // El evento solo se busca para la que está en devolución: lo normal es una lectura.
  if (!shipment || !isReturningOwnOutput(shipment as ReturningOutputLike)) return false;
  const { data: replaced } = await admin.from("order_events").select("id").eq("shipment_id", row.shipment_id).eq("kind", OUTPUT_REPLACED_KIND).limit(1).maybeSingle();
  return Boolean(replaced);
}

/**
 * Los pedidos con una caja reemplazada que el motorizado todavía tiene (0248):
 * pedido → código de esa salida. Una parada sin salida (un punto a mano desde
 * el teléfono, una parada añadida en Rutas) no dice de qué caja habla: con dos
 * cajas del pedido en la calle, su «No entregado» devolvería la nueva a «Por
 * reprogramar Lima» y su «Entregado» daría por entregada la que vuelve. La
 * salida nueva va por Despacho del día, con su caja.
 */
export async function ordersWithReplacedOutputOut(admin: SupabaseClient, orderIds: string[]): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  const ids = [...new Set(orderIds.filter(Boolean))];
  if (!ids.length) return out;
  const { data: rows } = await admin
    .from("shipments")
    .select("id,order_id,output_code,courier,delivery_status,custody_state,returned_at")
    .in("order_id", ids)
    .eq("courier", "propio")
    .eq("custody_state", "retorno");
  const returning = ((rows ?? []) as Array<ReturningOutputLike & { id: string; order_id: string; output_code: string | null }>)
    .filter((row) => isReturningOwnOutput(row));
  if (!returning.length) return out;
  const { data: events } = await admin
    .from("order_events")
    .select("kind,shipment_id")
    .eq("kind", OUTPUT_REPLACED_KIND)
    .in("shipment_id", returning.map((row) => row.id));
  const replaced = replacedOutputIds((events ?? []) as { kind: string; shipment_id: string | null }[]);
  for (const row of returning) {
    if (replaced.has(row.id) && !out.has(row.order_id)) out.set(row.order_id, row.output_code);
  }
  return out;
}

export function replacedOutputStopError(orderName: string | null | undefined, outputCode: string | null | undefined): string {
  return `${orderName ?? "Este pedido"} ya salió con otra salida y su caja anterior (${outputCode ?? "la reemplazada"}) vuelve a la oficina: no se añade como punto a mano. La salida nueva va por Despacho del día, con su caja.`;
}

async function writeStopUndoEvent(admin: SupabaseClient, stopId: string, routeId: string, orderId: string, actor: string): Promise<void> {
  const { data: stopRow } = await admin.from("delivery_stops").select("store_id,shipment_id").eq("id", stopId).maybeSingle();
  if (!stopRow?.store_id) return;
  await admin.from("order_events").insert({
    store_id: stopRow.store_id,
    order_id: orderId,
    kind: "stop_reported",
    actor,
    source: "reparto",
    courier: "propio",
    shipment_id: stopRow.shipment_id ?? null,
    note: "Reporte de la parada deshecho: vuelve a pendiente.",
    payload: { stop_id: stopId, route_id: routeId, status: "pendiente" },
  });
}

export const UNCONFIRMED_PICKUP_NOTE = "Entregado sin confirmar recojo";

/**
 * Si el ítem de la caja que originó la parada tiene «Lo llevo»
 * (`pickup_checked_at`). Null cuando la parada no viene de una caja o el ítem
 * ya no está activo: entonces no hay nada que confirmar.
 */
async function pickupConfirmationFor(admin: SupabaseClient, stopId: string): Promise<{ confirmed: boolean; storeId: string; shipmentId: string; manifestId: string } | null> {
  const { data: stop } = await admin
    .from("delivery_stops")
    .select("store_id,shipment_id,dispatch_manifest_id")
    .eq("id", stopId)
    .maybeSingle();
  const row = stop as { store_id: string | null; shipment_id: string | null; dispatch_manifest_id: string | null } | null;
  if (!row?.shipment_id || !row.dispatch_manifest_id || !row.store_id) return null;
  const { data: item } = await admin
    .from("dispatch_manifest_items")
    .select("pickup_checked_at")
    .eq("manifest_id", row.dispatch_manifest_id)
    .eq("shipment_id", row.shipment_id)
    .is("removed_at", null)
    .maybeSingle();
  if (!item) return null;
  return {
    confirmed: Boolean((item as { pickup_checked_at: string | null }).pickup_checked_at),
    storeId: row.store_id,
    shipmentId: row.shipment_id,
    manifestId: row.dispatch_manifest_id,
  };
}

const METHOD_LABEL: Record<string, string> = { efectivo: "Efectivo", yape: "Yape", pos: "POS / tarjeta", sin_cobro: "Sin cobro" };

async function writeStopReportedEvent(
  admin: SupabaseClient,
  ev: {
    stopId: string; routeId: string; orderId: string; actor: string; status: string;
    method: string | null; collected: number | null; reason: string | null; note: string | null;
    photoPath: string | null; voucherPath: string | null; delegated: boolean;
    notebook?: { riderName: string; importId: string } | null;
    /** La fecha que pidió el cliente, solo cuando este reporte la trae. */
    requestedDate?: string | null;
  },
): Promise<void> {
  const [{ data: stopRow }, { data: rider }] = await Promise.all([
    admin.from("delivery_stops").select("store_id,shipment_id").eq("id", ev.stopId).maybeSingle(),
    admin.from("riders").select("full_name").eq("user_id", ev.actor).limit(1).maybeSingle(),
  ]);
  if (!stopRow?.store_id) return;
  const who = ev.notebook
    ? `Cuaderno de ${ev.notebook.riderName}`
    : ev.delegated ? "Coordinación reportó por el motorizado" : rider?.full_name ? `${rider.full_name} reportó` : "Reporte";
  const parts: string[] = [];
  if (ev.status === "entregado") {
    parts.push("Entregado");
    if (ev.method) parts.push(`${METHOD_LABEL[ev.method] ?? ev.method}${ev.collected != null && ev.method !== "sin_cobro" ? ` S/ ${ev.collected.toFixed(2)}` : ""}`);
  } else {
    const reason = NON_DELIVERY_REASONS.find((r) => r.code === ev.reason)?.label ?? ev.reason ?? "sin motivo";
    parts.push(`No entregado · ${reason}`);
    // Lo que dijo el cliente en la puerta: nunca programa (MOM §9.5).
    if (ev.requestedDate) parts.push(`pidió el ${programDayLabel(ev.requestedDate)} (sin confirmar)`);
  }
  const evidence = [ev.photoPath ? "foto" : null, ev.voucherPath ? "comprobante" : null].filter(Boolean).join(" y ");
  if (evidence) parts.push(`con ${evidence}`);
  else if (ev.notebook) parts.push("sin foto");
  if (ev.note?.trim()) parts.push(`«${ev.note.trim()}»`);
  await admin.from("order_events").insert({
    store_id: stopRow.store_id,
    order_id: ev.orderId,
    kind: "stop_reported",
    occurred_at: new Date().toISOString(),
    actor: ev.actor,
    source: "reparto",
    courier: "propio",
    shipment_id: stopRow.shipment_id ?? null,
    note: `${who}: ${parts.join(" · ")}.`,
    payload: {
      stop_id: ev.stopId, route_id: ev.routeId, status: ev.status, payment_method: ev.method,
      collected_amount: ev.collected, outcome_reason: ev.reason, photo_path: ev.photoPath, voucher_path: ev.voucherPath,
      ...(ev.notebook ? { origen: "cuaderno", notebook_import_id: ev.notebook.importId } : {}),
      ...(ev.requestedDate ? { requested_date: ev.requestedDate } : {}),
    },
  });
}
