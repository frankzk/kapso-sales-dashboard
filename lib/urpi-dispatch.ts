// El despacho a Urpi, registrado desde la programación enviada (MOM §30.10).
//
// POR QUÉ (decisión del owner, 03-11-2026). Los pedidos salen con Urpi desde el
// Google Sheet de programación, no desde una ruta de Kapta, y en Kapta no quedaba
// rastro del despacho: del 26/10 al 02/11 se programaron 101 pedidos y 85 no
// tenían salida de Urpi. 50 seguían «Listo para asignar» con su caja «por
// definir» en el almacén, y 31 parecían en manos de otro courier (casi todos un
// motorizado de Grupo GF que falló antes). La ficha decía otra cosa que la calle.
//
// QUÉ HACE. Al cargar la programación, por cada pedido vinculado por código cuya
// fecha programada ya llegó, RELLENA la caja «por definir» como salida de Urpi
// en ruta, despachada el día programado a mediodía de Lima: lo mismo que hacen
// Tanders, Aliclik y el reporte de Urpi sobre esa caja (lib/route-output-fill.ts,
// MOM §4). Consecutivo, QR, preparación y custodia se conservan y queda el evento
// `route_output_filled`. El pedido pasa a «En curso · En tránsito». Cuando Urpi
// reporta la entrega, lib/urpi-salida.ts cierra esa misma salida.
//
// QUÉ NO HACE. No crea salidas: sin caja «por definir» no hay caja en Kapta que
// sea la de Urpi. No toca un pedido con otra salida viva —otro courier u otra
// «por definir»—: no se sabe qué caja se llevó Urpi, y queda para revisar a mano.
// Tampoco una caja creada después del día programado, ni un pedido cerrado
// (entregado, anulado, devuelto o anulado en Shopify), ni una fecha que todavía
// no llega. Si el pedido ya tiene salida de Urpi, no la toca: una programación
// posterior es un reintento de la misma caja.
//
// CANCELADOS (03-11-2026). Si el reporte de Urpi ya dice que canceló ese
// despacho, la salida recién rellenada se anula en el acto como intento
// fallido (lib/urpi-report-apply.ts): da igual cargar antes el reporte o la
// programación. Y un pedido que Urpi ya canceló y se vuelve a programar a Urpi
// no se toca y se nombra: Urpi solo lleva primeros despachos (§9.1); el
// reprogramado va por Repro Lima.

import type { SupabaseClient } from "@supabase/supabase-js";
import { limaDayKey } from "@/lib/order-confirmation";
import { recomputeOrderMasterSafe } from "@/lib/order-master";
import { writeCourierGuide } from "@/lib/route-output-fill";
import { manualRouteGuideCode, pickFillableRouteOutput } from "@/lib/shipment-output";
import { limaTodayKey } from "@/lib/shipments";
import { applyUrpiCancellationsFor } from "@/lib/urpi-report-apply";
import { isFailedUrpiSalida, isLiveUrpiCandidate, type UrpiSalidaCandidate } from "@/lib/urpi-salida";

/** `created_via` propio: quien audite distingue la caja que pasó a Urpi por la
 *  programación de la que se rellenó con el reporte de resultados. */
export const URPI_PROGRAMMING_CREATED_VIA = "urpi_programacion";

export interface UrpiDispatchCandidate extends UrpiSalidaCandidate {
  created_at: string | null;
}

export interface UrpiDispatchOrder {
  general_status: string;
  cancelled_at: string | null;
}

export type UrpiDispatchPlan =
  | { kind: "rellenar"; salida: UrpiDispatchCandidate }
  | { kind: "ya_es_urpi" }
  | { kind: "reenvio_tras_cancelado" }
  | { kind: "cerrado" }
  | { kind: "sin_salida" }
  | { kind: "otra_salida_viva" };

const CLOSED = new Set(["entregado", "anulado", "devuelto"]);

/** Qué hacer con un pedido que la programación da por enviado a Urpi el día
 *  `programmedOn` (AAAA-MM-DD). PURA. */
export function planUrpiDispatch(order: UrpiDispatchOrder, salidas: readonly UrpiDispatchCandidate[], programmedOn: string): UrpiDispatchPlan {
  if (order.cancelled_at || CLOSED.has(order.general_status)) return { kind: "cerrado" };
  if (salidas.some((s) => s.courier === "urpi" && (isLiveUrpiCandidate(s) || s.delivery_status === "entregado"))) return { kind: "ya_es_urpi" };
  // Urpi ya canceló una salida de este pedido. La programación de ese día o de
  // antes es la que canceló; una posterior es un reenvío a Urpi tras el
  // cancelado, que §9.1 no admite: se nombra y no se toca.
  const failed = salidas.filter(isFailedUrpiSalida);
  if (failed.length) {
    const lastDay = failed.map((s) => limaDayKey(s.closed_at ?? s.dispatched_at!)).sort().at(-1)!;
    return programmedOn > lastDay ? { kind: "reenvio_tras_cancelado" } : { kind: "ya_es_urpi" };
  }
  const live = salidas.filter(isLiveUrpiCandidate);
  const fillable = pickFillableRouteOutput(live);
  if (!fillable) return live.length ? { kind: "otra_salida_viva" } : { kind: "sin_salida" };
  // Una sola caja viva, y es la «por definir»: es la que se llevó Urpi.
  if (live.length > 1) return { kind: "otra_salida_viva" };
  // La caja tenía que existir ese día: una «por definir» creada después no es
  // la que salió (las cajas del barrido del 19/08 se crearon semanas después).
  if (fillable.created_at && limaDayKey(fillable.created_at) > programmedOn) return { kind: "sin_salida" };
  return { kind: "rellenar", salida: fillable };
}

/** La fila que se escribe encima. El Sheet dice el día; la hora no, y se usa
 *  mediodía de Lima, como en las demás salidas de Urpi. PURA. */
export function urpiDispatchRow(orderName: string | null, shipmentId: string, programmedOn: string) {
  return {
    courier: "urpi",
    created_via: URPI_PROGRAMMING_CREATED_VIA,
    guide_code: manualRouteGuideCode(orderName, shipmentId, "urpi"),
    delivery_status: "en_ruta",
    status_category: "in_route",
    dispatched_at: `${programmedOn}T17:00:00.000Z`,
  };
}

/** Por pedido, el día programado más reciente que ya llegó. Un pedido que se
 *  programa varios días es la misma caja reintentada; la última fecha es la de
 *  la salida vigente. PURA. */
export function dueUrpiDispatches(
  rows: readonly { orderId: string | null; date: string }[],
  today: string,
): Map<string, string> {
  const due = new Map<string, string>();
  for (const row of rows) {
    if (!row.orderId || !/^\d{4}-\d{2}-\d{2}$/.test(row.date) || row.date > today) continue;
    if ((due.get(row.orderId) ?? "") < row.date) due.set(row.orderId, row.date);
  }
  return due;
}

export interface UrpiDispatchResult {
  /** Códigos de pedido cuya caja pasó a salida de Urpi en ruta. */
  filled: string[];
  alreadyUrpi: number;
  closed: number;
  /** Sin caja «por definir» que pasar a Urpi (o creada después del día). */
  sinSalida: string[];
  /** Con otra salida viva: no se sabe qué caja se llevó Urpi. */
  otraSalidaViva: string[];
  /** Urpi ya lo canceló y se volvió a programar a Urpi (§9.1). */
  reenvioTrasCancelado: string[];
  /** Rellenados que el reporte ya daba por cancelados: pasaron a reprogramar. */
  cancelled: string[];
  errors: string[];
}

/**
 * Registra los despachos de las filas programadas. No falla en bloque: lo que
 * no se puede se cuenta y queda para revisar a mano. `today` es el día de Lima.
 */
export async function registerUrpiDispatches(
  admin: SupabaseClient,
  rows: readonly { orderId: string | null; orderCode: string; date: string }[],
  today: string = limaTodayKey(),
): Promise<UrpiDispatchResult> {
  const result: UrpiDispatchResult = { filled: [], alreadyUrpi: 0, closed: 0, sinSalida: [], otraSalidaViva: [], reenvioTrasCancelado: [], cancelled: [], errors: [] };
  const due = dueUrpiDispatches(rows, today);
  const ids = [...due.keys()];
  if (!ids.length) return result;
  const codeOf = new Map(rows.filter((row) => row.orderId).map((row) => [row.orderId!, `#${row.orderCode}`]));
  type Fact = { order_id: string; order_name: string | null; general_status: string; orders: { cancelled_at: string | null } | null };
  const facts = new Map<string, Fact>();
  const salidas = new Map<string, UrpiDispatchCandidate[]>();
  for (let i = 0; i < ids.length; i += 200) {
    const slice = ids.slice(i, i + 200);
    const [master, shipments] = await Promise.all([
      admin.from("order_master").select("order_id,order_name,general_status,orders(cancelled_at)").in("order_id", slice),
      admin.from("shipments")
        .select("id,order_id,courier,created_via,delivery_status,custody_state,custody_transferred_at,returned_at,output_number,created_at,dispatched_at,closed_at")
        .in("order_id", slice),
    ]);
    if (master.error || shipments.error) throw new Error("No se pudieron leer los pedidos y salidas programados a Urpi.");
    for (const fact of (master.data ?? []) as unknown as Fact[]) facts.set(fact.order_id, fact);
    for (const row of (shipments.data ?? []) as (UrpiDispatchCandidate & { order_id: string })[]) {
      salidas.set(row.order_id, [...(salidas.get(row.order_id) ?? []), row]);
    }
  }
  const filledIds: string[] = [];
  for (const [orderId, programmedOn] of due) {
    const fact = facts.get(orderId);
    const code = fact?.order_name ?? codeOf.get(orderId) ?? orderId;
    if (!fact) { result.errors.push(code); continue; }
    const plan = planUrpiDispatch({ general_status: fact.general_status, cancelled_at: fact.orders?.cancelled_at ?? null }, salidas.get(orderId) ?? [], programmedOn);
    if (plan.kind === "ya_es_urpi") { result.alreadyUrpi++; continue; }
    if (plan.kind === "cerrado") { result.closed++; continue; }
    if (plan.kind === "sin_salida") { result.sinSalida.push(code); continue; }
    if (plan.kind === "otra_salida_viva") { result.otraSalidaViva.push(code); continue; }
    if (plan.kind === "reenvio_tras_cancelado") { result.reenvioTrasCancelado.push(code); continue; }
    const written = await writeCourierGuide(admin, orderId, urpiDispatchRow(fact.order_name, plan.salida.id, programmedOn), { createIfMissing: false });
    if ("error" in written) result.errors.push(code);
    else { result.filled.push(code); filledIds.push(orderId); }
  }
  if (filledIds.length) {
    // Si Urpi ya canceló ese despacho, la salida pasa a intento fallido ahora.
    // `applyUrpiCancellationsFor` recalcula los que toca.
    const cancelled = await applyUrpiCancellationsFor(admin, { visibleStoreIds: null, orderIds: filledIds }).catch(() => null);
    const nameOf = new Map(filledIds.map((id) => [id, facts.get(id)?.order_name ?? codeOf.get(id) ?? id]));
    result.cancelled = (cancelled?.cancelled ?? []).map((id) => nameOf.get(id)!);
    await recomputeOrderMasterSafe(admin, filledIds.filter((id) => !cancelled?.cancelled.includes(id)));
  }
  return result;
}

const listOf = (codes: readonly string[], max = 10) =>
  codes.length > max ? `${codes.slice(0, max).join(", ")} y ${codes.length - max} más` : codes.join(", ");

/** El resumen para quien cargó la programación: lo que cambió y lo que hay que
 *  mirar a mano. Lo que ya estaba al día no se repite en cada carga: sin nada
 *  que decir, cadena vacía. PURA. */
export function urpiDispatchMessage(result: UrpiDispatchResult): string {
  const parts: string[] = [];
  if (result.filled.length) parts.push(`${result.filled.length} salida(s) «Por definir» pasaron a Urpi en ruta`);
  if (result.otraSalidaViva.length) parts.push(`${result.otraSalidaViva.length} con otra salida viva, revísalos a mano (${listOf(result.otraSalidaViva)})`);
  if (result.cancelled.length) parts.push(`${result.cancelled.length} ya cancelado(s) por Urpi pasaron a «Por reprogramar Lima»`);
  if (result.reenvioTrasCancelado.length) parts.push(`${result.reenvioTrasCancelado.length} que Urpi ya canceló se volvieron a programar a Urpi; Urpi solo lleva primeros despachos (§9.1), revísalos (${listOf(result.reenvioTrasCancelado)})`);
  if (result.sinSalida.length) parts.push(`${result.sinSalida.length} sin caja «Por definir» del día que pasar a Urpi (${listOf(result.sinSalida)})`);
  if (result.errors.length) parts.push(`${result.errors.length} no se pudieron actualizar (${listOf(result.errors)})`);
  return parts.length ? `Despachos a Urpi: ${parts.join("; ")}.` : "";
}
