"use server";

import { revalidatePath } from "next/cache";
import { createServerSupabase } from "@/lib/db";
import { applyUrpiDeliveriesFor, urpiApplyMessage, urpiAutoApplyMessage } from "@/lib/urpi-report-apply";
import { URPI_OBSERVATION_RESOLVED } from "@/lib/urpi-report-view";
import { normalizeUrpiOrder } from "@/lib/urpi-programming";
import { canMarkUrpiDeliveries, requireUrpiReportOrg } from "@/lib/urpi-report-access";
import type { UrpiReportRow, UrpiResultCode } from "@/lib/urpi-report";

export interface UrpiReportActionResult { ok: boolean; message: string }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Vínculo elegido a mano para un envío de Urpi: un candidato de la lista o un
 * código de pedido (KP12345, #AUR123). Toda la cadena de intentos pasa a ese
 * pedido y ninguna lectura posterior lo cambia. Si Urpi lo entregó y quien
 * vincula puede editar el Master, queda marcado entregado ahí mismo (§30.11).
 */
export async function linkUrpiReportRow(orgId: string, urpiRow: number, orderRef: string): Promise<UrpiReportActionResult> {
  try {
    const { user, admin, stores, visibleStoreIds } = await requireUrpiReportOrg(orgId, "sheets.edit");
    if (!Number.isInteger(urpiRow) || urpiRow <= 0) throw new Error("Fila de Urpi inválida.");
    const ref = orderRef.trim();
    if (!ref) throw new Error("Indica el pedido.");
    const storeIds = stores.map((store) => store.id).filter((id) => visibleStoreIds.has(id));
    let query = admin.from("order_master").select("order_id,store_id,order_name").in("store_id", storeIds);
    if (UUID.test(ref)) query = query.eq("order_id", ref);
    else {
      const code = normalizeUrpiOrder(ref);
      if (!/^[A-Z]{1,12}\d+$/.test(code)) throw new Error("Escribe el código del pedido, por ejemplo KP12345.");
      query = query.in("order_name", [`#${code}`, code]);
    }
    const { data, error } = await query.limit(2);
    if (error) throw new Error("No se pudo buscar el pedido.");
    if (!data?.length) throw new Error("No existe ese pedido en las tiendas a las que tienes acceso.");
    if (data.length > 1) throw new Error("Hay más de un pedido con ese código. Elige uno de la lista.");
    const order = data[0] as { order_id: string; store_id: string; order_name: string | null };
    const { data: touched, error: linkError } = await admin.rpc("link_urpi_report_chain", {
      p_org_id: orgId, p_urpi_row: urpiRow, p_order_id: order.order_id, p_store_id: order.store_id, p_actor: user.id,
    });
    if (linkError) throw new Error(linkError.message.includes("row_not_found") ? "Esa fila de Urpi no existe." : "No se pudo guardar el vínculo.");
    revalidatePath("/dashboard/urpi");
    const linked = `Vinculado a ${order.order_name ?? "el pedido"}: ${Number(touched) || 1} intento(s) de Urpi.`;
    if (!(await canMarkUrpiDeliveries(orgId))) return { ok: true, message: linked };
    try {
      const applied = await applyUrpiDeliveriesFor(admin, { orgId, actor: user.id, visibleStoreIds, orderIds: [order.order_id], auto: "vinculo" });
      if (!applied.applied.length && !applied.salidas.filled.length) return { ok: true, message: linked };
      revalidatePath("/dashboard/pedidos");
      return { ok: true, message: `${linked} ${urpiAutoApplyMessage(applied)}` };
    } catch (error) {
      return { ok: true, message: `${linked} No se pudo marcar la entrega: ${error instanceof Error ? error.message : "error desconocido"}. Márcalo desde «Entregados por marcar».` };
    }
  } catch (error) { return { ok: false, message: error instanceof Error ? error.message : "No se pudo vincular." }; }
}

/**
 * Marca entregados en el Master los pedidos que Urpi reportó entregados. Va por
 * la única puerta (lib/master-door.ts), como el cuaderno de Liquidaciones 2
 * (§30.8): `status_override` con fuente `liquidacion` y courier `urpi`. Solo si
 * el último intento del pedido es «Entregado».
 *
 * Desde el 15-10-2026 la carga del reporte ya los marca sola (MOM §30.11); este
 * botón queda para lo que la carga no pudo marcar: quien cargó no tenía
 * `master.edit`, o algo falló.
 *
 * Un pedido anulado en SHOPIFY o devuelto no se toca: queda como observación.
 * Uno anulado solo en Kapta sí se marca: solo Shopify termina una venta (v1.23).
 *
 * Después rellena la salida «por definir» del pedido como salida de Urpi
 * entregada (lib/urpi-salida.ts), también en los que ya estaban entregados: así
 * se completan los marcados antes de que existiera el relleno (MOM §30.11).
 */
export async function applyUrpiDeliveries(orgId: string, orderIds: string[]): Promise<UrpiReportActionResult> {
  try {
    const { user, admin, visibleStoreIds } = await requireUrpiReportOrg(orgId, "master.edit");
    const ids = [...new Set(orderIds.filter((id) => UUID.test(id)))];
    if (!ids.length) throw new Error("No hay pedidos que marcar.");
    if (ids.length > 500) throw new Error("Marca como máximo 500 pedidos a la vez.");
    const result = await applyUrpiDeliveriesFor(admin, { orgId, actor: user.id, visibleStoreIds, orderIds: ids });
    revalidatePath("/dashboard/urpi");
    revalidatePath("/dashboard/pedidos");
    return { ok: true, message: urpiApplyMessage(result) };
  } catch (error) { return { ok: false, message: error instanceof Error ? error.message : "No se pudo marcar la entrega." }; }
}

/**
 * Cierra con motivo una observación: Urpi entregó y cobró, pero el pedido está
 * anulado en Shopify o devuelto. El pedido sigue como está —solo Shopify
 * termina una venta—; queda escrito por qué y quién lo revisó, y sale de la
 * lista. Un intento posterior de Urpi la reabre (MOM §30.11).
 */
export async function resolveUrpiObservation(orgId: string, orderId: string, note: string): Promise<UrpiReportActionResult> {
  try {
    const { user, admin, visibleStoreIds } = await requireUrpiReportOrg(orgId, "sheets.edit");
    if (!UUID.test(orderId)) throw new Error("Pedido inválido.");
    const reason = note.trim();
    if (reason.length < 5) throw new Error("Escribe el motivo: qué se revisó y qué se decidió.");
    if (reason.length > 500) throw new Error("El motivo admite hasta 500 caracteres.");
    const { data: rows, error } = await admin.from("urpi_report_rows").select("urpi_row,result_code")
      .eq("org_id", orgId).eq("order_id", orderId).order("urpi_row", { ascending: false }).limit(1);
    if (error) throw new Error("No se pudieron leer los resultados de Urpi.");
    const latest = (rows ?? [])[0] as { urpi_row: number; result_code: UrpiResultCode } | undefined;
    if (!latest || latest.result_code !== "entregado") throw new Error("El último intento de Urpi para este pedido no es una entrega.");
    const { data: fact, error: factError } = await admin.from("order_master").select("order_id,store_id,general_status,orders(cancelled_at)").eq("order_id", orderId).maybeSingle();
    if (factError || !fact) throw new Error("No se pudo leer el pedido.");
    const order = fact as unknown as { store_id: string; general_status: string; orders: { cancelled_at: string | null } | null };
    if (!visibleStoreIds.has(order.store_id)) throw new Error("No tienes acceso a la tienda de este pedido.");
    if (!order.orders?.cancelled_at && order.general_status !== "devuelto") throw new Error("Este pedido ya no es una observación: márcalo entregado desde «Entregados por marcar».");
    const { error: insertError } = await admin.from("order_events").insert({
      store_id: order.store_id, order_id: orderId, kind: URPI_OBSERVATION_RESOLVED, occurred_at: new Date().toISOString(),
      actor: user.id, source: "manual", courier: "urpi", reason,
      payload: { urpi_report: true, urpi_row: latest.urpi_row },
    });
    if (insertError) throw new Error("No se pudo guardar el motivo.");
    revalidatePath("/dashboard/urpi");
    return { ok: true, message: "Observación cerrada. El motivo queda en la actividad del pedido." };
  } catch (error) { return { ok: false, message: error instanceof Error ? error.message : "No se pudo cerrar la observación." }; }
}

export interface UrpiAttempt {
  urpiRow: number;
  reportDate: string | null;
  resultCode: UrpiResultCode;
  resultWritten: string;
  reason: string | null;
  detail: string | null;
  evidence: string[];
  paymentMethod: string | null;
  amountCollected: number | null;
  serviceFee: number | null;
  linkMethod: string | null;
}

/** Los intentos de Urpi de un pedido, para su ficha. Lee con RLS: quien no ve
 * la tienda del pedido no ve sus intentos. */
export async function loadUrpiAttempts(orderId: string): Promise<UrpiAttempt[]> {
  if (!UUID.test(orderId)) return [];
  const sb = await createServerSupabase();
  const { data, error } = await sb.from("urpi_report_rows").select("urpi_row,report_date,result_code,data,link_method")
    .eq("order_id", orderId).order("urpi_row").limit(50);
  if (error || !data) return [];
  return (data as { urpi_row: number; report_date: string | null; result_code: UrpiResultCode; data: UrpiReportRow; link_method: string | null }[]).map((row) => ({
    urpiRow: row.urpi_row, reportDate: row.report_date, resultCode: row.result_code, resultWritten: row.data.resultWritten,
    reason: row.data.reason, detail: row.data.detail, evidence: row.data.evidence ?? [], paymentMethod: row.data.paymentMethod,
    amountCollected: row.data.amountCollected, serviceFee: row.data.serviceFee, linkMethod: row.link_method,
  }));
}
