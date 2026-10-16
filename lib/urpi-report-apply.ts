// Marcar en el Master lo que Urpi reporta entregado (MOM §30.11).
//
// DESDE EL 15-10-2026 ES AUTOMÁTICO (decisión del owner). Al cargar el reporte
// —y al vincular a mano un envío que Urpi entregó— Kapta marca entregados los
// pedidos cuyo último intento es «Entregado», sin esperar a que alguien los
// seleccione. Urpi ya liquida y paga la recaudación de esas entregas: dejarlas
// «Por despachar · Listo para asignar» era mostrar un pedido pendiente que ya
// está cobrado (#KP138847, entregado el 06/10 y todavía «en proceso» el 15/10).
//
// Lo que NO cambia: va por la única puerta (lib/master-door.ts) con fuente
// `liquidacion` y courier `urpi`; el actor es quien cargó o vinculó, y debe
// tener `master.edit` (sin él, quedan en «Entregados por marcar» para quien sí
// lo tenga); un pedido anulado en Shopify o devuelto nunca se marca
// (observación); y la caja «por definir» pasa a ser la salida de Urpi entregada
// (lib/urpi-salida.ts), también en los ya entregados que la tenían pendiente.

import type { SupabaseClient } from "@supabase/supabase-js";
import { applyDeliveriesToMaster, type MasterDoorItem } from "@/lib/master-door";
import { recomputeOrderMasterSafe } from "@/lib/order-master";
import { fillUrpiSalidas, type UrpiSalidaResult } from "@/lib/urpi-salida";
import type { UrpiResultCode } from "@/lib/urpi-report";

/** Lo que muestra la pantalla y lo que se marca solo: los últimos 60 días. */
export const URPI_RESULTS_DAYS = 60;

export interface UrpiApplyResult {
  /** Los pedidos que esta vez pasaron a entregado. */
  applied: string[];
  already: number;
  observed: number;
  notDelivered: number;
  salidas: UrpiSalidaResult;
}

const dateLabel = (iso: string) => iso.split("-").reverse().join("/");
const AUTO_REASON = { manual: "", carga: ", marcado al cargar el reporte", vinculo: ", marcado al vincular el envío" } as const;

/**
 * Marca entregados los pedidos de `orderIds` cuyo último intento de Urpi es
 * «Entregado» y que Kapta tiene abiertos, y rellena su salida «por definir».
 * `auto` deja dicho en el evento que nadie lo seleccionó: se marcó al cargar el
 * reporte o al vincular el envío a mano.
 */
export async function applyUrpiDeliveriesFor(admin: SupabaseClient, input: {
  orgId: string; actor: string; visibleStoreIds: ReadonlySet<string>; orderIds: readonly string[]; auto?: "carga" | "vinculo";
}): Promise<UrpiApplyResult> {
  const ids = [...new Set(input.orderIds)];
  type Row = { urpi_row: number; order_id: string; result_code: UrpiResultCode; report_date: string | null; last_import_id: string };
  const rows: Row[] = [];
  for (let i = 0; i < ids.length; i += 200) {
    const { data, error } = await admin.from("urpi_report_rows").select("urpi_row,order_id,result_code,report_date,last_import_id")
      .eq("org_id", input.orgId).in("order_id", ids.slice(i, i + 200));
    if (error) throw new Error("No se pudieron leer los resultados de Urpi.");
    rows.push(...((data ?? []) as Row[]));
  }
  const latest = new Map<string, Row>();
  const firstDate = new Map<string, string>();
  for (const row of rows) {
    if ((latest.get(row.order_id)?.urpi_row ?? 0) < row.urpi_row) latest.set(row.order_id, row);
    const first = firstDate.get(row.order_id);
    if (row.report_date && (!first || row.report_date < first)) firstDate.set(row.order_id, row.report_date);
  }
  type Fact = { order_id: string; store_id: string; order_name: string | null; general_status: string; orders: { cancelled_at: string | null } | null };
  const facts = new Map<string, Fact>();
  for (let i = 0; i < ids.length; i += 200) {
    const { data, error } = await admin.from("order_master").select("order_id,store_id,order_name,general_status,orders(cancelled_at)").in("order_id", ids.slice(i, i + 200));
    if (error) throw new Error("No se pudo leer el estado de los pedidos.");
    for (const fact of (data ?? []) as unknown as Fact[]) facts.set(fact.order_id, fact);
  }
  let already = 0, observed = 0, notDelivered = 0;
  const items: MasterDoorItem[] = [];
  const delivered: string[] = [];
  for (const id of ids) {
    const row = latest.get(id);
    const fact = facts.get(id);
    if (!row || !fact || !input.visibleStoreIds.has(fact.store_id) || row.result_code !== "entregado") { notDelivered++; continue; }
    if (fact.general_status === "devuelto" || fact.orders?.cancelled_at) { observed++; continue; }
    delivered.push(id);
    if (fact.general_status === "entregado") { already++; continue; }
    const when = row.report_date ? ` del ${dateLabel(row.report_date)}` : "";
    items.push({
      orderId: id, storeId: fact.store_id, target: "entregado", source: "liquidacion", courier: "urpi",
      // Mediodía de Lima del día del reporte: Urpi no da la hora de entrega.
      occurredAt: row.report_date ? `${row.report_date}T17:00:00.000Z` : new Date().toISOString(),
      actor: input.actor,
      reason: `Entregado según el reporte de Urpi${when} (fila ${row.urpi_row})${AUTO_REASON[input.auto ?? "manual"]}.`,
      payload: { urpi_report: true, urpi_row: row.urpi_row, urpi_import_id: row.last_import_id, ...(input.auto ? { auto: input.auto } : {}) },
    });
  }
  let applied: string[] = [];
  if (items.length) {
    const door = await applyDeliveriesToMaster(admin, items);
    if (door.error) throw new Error(`No se pudo registrar la entrega: ${door.error}`);
    applied = door.applied;
  }
  const salidas = await fillUrpiSalidas(admin, delivered.map((id) => ({ orderId: id, orderName: facts.get(id)!.order_name, dispatchedOn: firstDate.get(id) ?? null })));
  if (salidas.filled.length) await recomputeOrderMasterSafe(admin, salidas.filled);
  return { applied, already, observed, notDelivered, salidas };
}

/**
 * Los pedidos que Urpi entregó en los últimos 60 días: lo que se marca solo al
 * cargar el reporte. `applyUrpiDeliveriesFor` decide con el ÚLTIMO intento de
 * cada uno; aquí basta con que alguno sea «Entregado».
 */
export async function urpiDeliveredOrderIds(admin: SupabaseClient, orgId: string, now = new Date()): Promise<string[]> {
  const cutoff = new Date(now.getTime() - URPI_RESULTS_DAYS * 86400000).toISOString().slice(0, 10);
  const ids = new Set<string>();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await admin.from("urpi_report_rows").select("order_id")
      .eq("org_id", orgId).eq("result_code", "entregado").gte("report_date", cutoff).order("urpi_row").range(from, from + 999);
    if (error) throw new Error("No se pudieron leer las entregas de Urpi.");
    for (const row of (data ?? []) as { order_id: string | null }[]) if (row.order_id) ids.add(row.order_id);
    if ((data ?? []).length < 1000) break;
  }
  return [...ids];
}

/** El resumen de quien marca a mano: cuenta todo lo que pidió. PURA. */
export function urpiApplyMessage(result: UrpiApplyResult): string {
  const { salidas } = result;
  const parts = [`${result.applied.length} pedido(s) marcados como entregados`];
  if (result.already) parts.push(`${result.already} ya estaban entregados`);
  if (salidas.filled.length) parts.push(`${salidas.filled.length} salida(s) «Por definir» pasaron a Urpi entregada`);
  if (salidas.sinSalida.length) parts.push(`${salidas.sinSalida.length} sin salida «Por definir» que pasar a Urpi`);
  if (salidas.otraSalidaViva.length) parts.push(`${salidas.otraSalidaViva.length} con otra salida viva: revisa su salida a mano`);
  if (salidas.errors.length) parts.push(`${salidas.errors.length} salida(s) no se pudieron actualizar`);
  if (result.observed) parts.push(`${result.observed} anulados en Shopify o devueltos no se tocaron`);
  if (result.notDelivered) parts.push(`${result.notDelivered} sin entrega de Urpi como último intento`);
  return `${parts.join("; ")}.`;
}

/**
 * El resumen de lo que se hizo solo. Recorre todos los entregados de 60 días,
 * así que no cuenta lo que ya estaba al día (entregados, sin caja, cancelados
 * después) ni repite en cada carga la «otra salida viva» de los que ya estaban
 * entregados: solo lo que cambió y lo que alguien tiene que mirar ahora. PURA.
 */
export function urpiAutoApplyMessage(result: UrpiApplyResult): string {
  const { salidas } = result;
  const marked = new Set(result.applied);
  const otherLive = salidas.otraSalidaViva.filter((id) => marked.has(id)).length;
  const parts: string[] = [];
  if (marked.size) parts.push(`${marked.size} pedido(s) marcados entregados en el Master`);
  if (salidas.filled.length) parts.push(`${salidas.filled.length} salida(s) «Por definir» pasaron a Urpi entregada`);
  if (otherLive) parts.push(`${otherLive} con otra salida viva: revisa su salida a mano`);
  if (salidas.errors.length) parts.push(`${salidas.errors.length} salida(s) no se pudieron actualizar`);
  return parts.length ? `Entregados según Urpi: ${parts.join("; ")}.` : "Entregados según Urpi: nada nuevo que marcar.";
}
