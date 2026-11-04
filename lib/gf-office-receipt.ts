// Lo compartido de «Recibir en oficina» de Grupo GF fuera de los archivos
// "use server" (un archivo de acciones solo exporta acciones; precedente
// lib/gf-active-boxes.ts). Lo usan Almacén → Devoluciones
// (`receiveGrupoGfReturn`), «Recibir en oficina» por salida
// (`returnUndeliveredShipments`) y el manifiesto de devolución (0307).
//
// La recepción la hace SIEMPRE la base (`gf_return_to_office`). Aquí solo se
// lee lo que necesita el escaneo antes y se relee lo que la base hizo después:
//   - la caja reemplazada vuelve a stock (0248);
//   - la de un pedido ANULADO EN LA TIENDA va a inventario (owner, 04-11-2026,
//     0307): Almacén decide stock o merma y no vuelve a «por asignar»;
//   - lo demás vuelve a «por asignar» y pasa por Repro Lima (§29.13).

import type { SupabaseClient } from "@supabase/supabase-js";
import { boxDayShort, replacedReceivedMessage } from "@/lib/gf-scan-return";
import { OUTPUT_REPLACED_KIND, officeReturnOutcome, type OfficeReturnOutcome } from "@/lib/gf-replaced-output";
import { materializeWaitingAgreementsSafe, reproReceptionNotice } from "@/lib/repro-lima-program";
import { recomputeOrderMasterSafe } from "@/lib/order-master";

type Admin = SupabaseClient;

/** El aviso de la caja de un pedido anulado en la tienda que se recibió. PURA. */
export function storeCancelledReceivedMessage(label: string, riderName: string, routeDate: string | null | undefined): string {
  const from = routeDate ? `${riderName} del ${boxDayShort(routeDate)}` : riderName;
  return `${label} recibido en oficina (${from}): el pedido está ANULADO en la tienda, así que va a inventario —Almacén decide stock o merma—. No vuelve a «por asignar».`;
}

/** Varias cajas de pedidos anulados en la tienda recibidas de una vez. PURA. */
export function storeCancelledReceivedNotice(count: number): string {
  return count === 1
    ? "1 era de un pedido anulado en la tienda: va a inventario (Almacén decide stock o merma); no vuelve a «por asignar»."
    : `${count} eran de pedidos anulados en la tienda: van a inventario (Almacén decide stock o merma); no vuelven a «por asignar».`;
}

/**
 * El aviso de una caja recibida, según lo que hizo la base. `cancelledNotice`
 * (lib/scan-cancelled.ts) solo pesa cuando vuelve a «por asignar»: un pedido
 * anulado en Kapta sin anular en la tienda. PURA.
 */
export function gfOfficeReceiptNotice(input: {
  label: string;
  outcome: OfficeReturnOutcome;
  riderName: string;
  routeDate: string;
  cancelledNotice: string | null;
  reproParts: readonly string[];
}): { notice?: string; error?: string } {
  const { label, riderName, routeDate } = input;
  if (input.outcome === "a_stock_reemplazada") return { notice: replacedReceivedMessage(label, riderName, routeDate) };
  if (input.outcome === "a_inventario_anulado") return { notice: storeCancelledReceivedMessage(label, riderName, routeDate) };
  if (input.outcome === "ya_devuelta") {
    return { notice: `${label} ya constaba devuelto: salió de la caja de ${riderName} sin volver a «por asignar».` };
  }
  const reproNote = input.reproParts.map((part) => ` ${part}`).join("");
  return input.cancelledNotice
    ? { error: `${label} recibido en oficina. ${input.cancelledNotice}${reproNote}` }
    : { notice: `${label} recibido en oficina: vuelve a «por asignar» en Grupo GF para reprogramarlo.${reproNote}` };
}

/**
 * ¿La venta terminó? Anulado en la tienda (`orders.cancelled_at`) o venta de
 * WooCommerce terminada a la espera del retorno (0285). Releído después de
 * recibir: un pedido reactivado (`cancelled_at` nulo) no cuenta. Un fallo de
 * lectura dice «no»: el aviso cae al de siempre, la base ya decidió.
 */
export async function readSaleEnded(admin: Admin, orderIds: readonly string[]): Promise<Set<string>> {
  const ids = [...new Set(orderIds.filter(Boolean))];
  const out = new Set<string>();
  if (!ids.length) return out;
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    const [{ data: orders }, { data: ended }] = await Promise.all([
      admin.from("orders").select("id,cancelled_at").in("id", chunk),
      admin.from("woo_sale_returns").select("order_id").in("order_id", chunk),
    ]);
    for (const row of (Array.isArray(orders) ? orders : []) as { id: string; cancelled_at: string | null }[]) if (row.cancelled_at) out.add(row.id);
    for (const row of (Array.isArray(ended) ? ended : []) as { order_id: string }[]) out.add(row.order_id);
  }
  return out;
}

/** La caja de Grupo GF donde está la salida, con su última parada en ESA caja. */
export interface GfBoxFacts {
  item: { id: string; manifestId: string } | null;
  box: { riderId: string | null; riderName: string; routeDate: string; deliveryRouteId: string | null } | null;
  /** La última parada en la caja, sin las que pasaron a otra ruta (0292). */
  stop: {
    id: string;
    status: string;
    outcomeReason: string | null;
    routeId: string;
    orderId: string;
    photoPath: string | null;
    voucherPath: string | null;
  } | null;
  routeStatus: string | null;
  /** Ya se recibió en oficina (`returned_to_office` / `reclaimed_in_office`). */
  receivedInOffice: boolean;
  /** Se reemplazó por otra salida (`output_replaced`, 0248). */
  replaced: boolean;
  /** La venta terminó (anulado en la tienda o Woo terminada): `readSaleEnded`. */
  saleEnded: boolean;
}

/**
 * Lo que el escaneo de una caja de Grupo GF necesita saber, leído igual que
 * `receiveGrupoGfReturn`: la caja propia activa, su última parada por
 * `reported_at` (lo que exige `gf_return_to_office`), si ya se recibió y si se
 * reemplazó.
 */
export async function loadGfBoxFacts(admin: Admin, shipmentId: string, orderId?: string | null): Promise<GfBoxFacts> {
  const [{ data: items }, { data: received }, { data: replacedEvents }, ended] = await Promise.all([
    admin
      .from("dispatch_manifest_items")
      .select("id,manifest_id,dispatch_manifests!inner(courier,route_date,driver_name,rider_id,delivery_route_id)")
      .eq("shipment_id", shipmentId)
      .is("removed_at", null)
      .eq("dispatch_manifests.courier", "propio")
      .limit(1),
    admin
      .from("order_events")
      .select("id")
      .eq("shipment_id", shipmentId)
      .in("kind", ["returned_to_office", "reclaimed_in_office"])
      .limit(1),
    admin.from("order_events").select("id").eq("shipment_id", shipmentId).eq("kind", OUTPUT_REPLACED_KIND).limit(1),
    readSaleEnded(admin, orderId ? [orderId] : []),
  ]);
  type BoxRow = { route_date: string; driver_name: string | null; rider_id: string | null; delivery_route_id: string | null };
  const row = ((items ?? []) as { id: string; manifest_id: string; dispatch_manifests: BoxRow | BoxRow[] }[])[0];
  const box = row ? (Array.isArray(row.dispatch_manifests) ? row.dispatch_manifests[0] : row.dispatch_manifests) ?? null : null;
  let stop: GfBoxFacts["stop"] = null;
  let routeStatus: string | null = null;
  if (row) {
    const { data: stops } = await admin
      .from("delivery_stops")
      .select("id,status,outcome_reason,route_id,order_id,photo_path,voucher_path,reported_at,notebook_carried_to_route_id")
      .eq("shipment_id", shipmentId)
      .eq("dispatch_manifest_id", row.manifest_id)
      .order("reported_at", { ascending: false, nullsFirst: false })
      .limit(5);
    const s = ((stops ?? []) as {
      id: string; status: string; outcome_reason: string | null; route_id: string; order_id: string;
      photo_path: string | null; voucher_path: string | null; notebook_carried_to_route_id?: string | null;
    }[]).find((candidate) => !candidate.notebook_carried_to_route_id);
    if (s) {
      stop = { id: s.id, status: s.status, outcomeReason: s.outcome_reason, routeId: s.route_id, orderId: s.order_id, photoPath: s.photo_path, voucherPath: s.voucher_path };
      const { data: route } = await admin.from("delivery_routes").select("status").eq("id", s.route_id).maybeSingle();
      routeStatus = (route as { status?: string } | null)?.status ?? null;
    }
  }
  return {
    item: row ? { id: row.id, manifestId: row.manifest_id } : null,
    box: box ? { riderId: box.rider_id, riderName: box.driver_name ?? "el motorizado", routeDate: box.route_date, deliveryRouteId: box.delivery_route_id } : null,
    stop,
    routeStatus,
    receivedInOffice: Boolean(received?.length),
    replaced: Boolean(replacedEvents?.length),
    saleEnded: Boolean(orderId && ended.has(orderId)),
  };
}

/**
 * Después de que la base recibió UNA caja: relee lo que hizo, pasa por Repro
 * Lima solo lo que vuelve a «por asignar», recalcula el Master y arma el
 * aviso. Nunca lanza por Repro Lima (E30).
 */
export async function afterGfOfficeReceipt(admin: Admin, input: {
  shipmentId: string;
  orderId: string | null;
  actor: string;
  label: string;
  riderName: string;
  routeDate: string;
  cancelledNotice: string | null;
}): Promise<{ outcome: OfficeReturnOutcome; reproParts: string[]; notice?: string; error?: string }> {
  const [{ data: after }, { data: replacedAfter }, ended] = await Promise.all([
    admin.from("shipments").select("custody_state").eq("id", input.shipmentId).maybeSingle(),
    admin.from("order_events").select("id").eq("shipment_id", input.shipmentId).eq("kind", OUTPUT_REPLACED_KIND).limit(1),
    readSaleEnded(admin, input.orderId ? [input.orderId] : []),
  ]);
  const outcome = officeReturnOutcome(
    (after as { custody_state?: string | null } | null)?.custody_state,
    Boolean(replacedAfter?.length),
    Boolean(input.orderId && ended.has(input.orderId)),
  );
  const repro = outcome === "por_asignar" && input.orderId
    ? await materializeWaitingAgreementsSafe(admin, [input.orderId], input.actor, { via: "recepcion" })
    : null;
  if (input.orderId) await recomputeOrderMasterSafe(admin, [input.orderId]);
  const reproParts = repro ? reproReceptionNotice(repro, { single: true }) : [];
  const message = gfOfficeReceiptNotice({
    label: input.label,
    outcome,
    riderName: input.riderName,
    routeDate: input.routeDate,
    cancelledNotice: input.cancelledNotice,
    reproParts,
  });
  return { outcome, reproParts, ...message };
}
