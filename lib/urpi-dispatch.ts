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
// LA CAJA QUE GRUPO GF NO ENTREGÓ (03-11-2026, decisión del owner, §9.1). Si la
// única salida viva es la propia de Grupo GF y su motorizado la reportó «No
// entregado» en una ruta anterior al día programado, esa caja es la que se llevó
// Urpi: la base la recibe en oficina, cancela la solicitud de Grupo GF y la pasa
// a Urpi en ruta en una sola transacción (`urpi_take_gf_output`, 0305). Vale
// también para un pedido que Urpi ya entregó: así su caja se puede cerrar como
// entrega de Urpi. #KP200665: Yordani falló el 29/10, Urpi la llevó el 31/10 y
// la canceló el 02/11; sin esto no entraba a «Reintentos Aliclik».
//
// QUÉ NO HACE. No crea salidas: sin caja «por definir» (o de Grupo GF que no
// entregó) no hay caja en Kapta que sea la de Urpi. No toca un pedido con otra
// salida viva —otro courier, otra «por definir», o una de Grupo GF sin su «No
// entregado»—: no se sabe qué caja se llevó Urpi, y queda para revisar a mano.
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
  /** La caja de Grupo GF; la base decide si su «No entregado» la deja pasar. */
  | { kind: "tomar_caja_gf"; salida: UrpiDispatchCandidate }
  | { kind: "ya_es_urpi" }
  | { kind: "reenvio_tras_cancelado" }
  | { kind: "cerrado" }
  | { kind: "sin_salida" }
  | { kind: "otra_salida_viva" };

const CLOSED = new Set(["entregado", "anulado", "devuelto"]);

/** Qué hacer con un pedido que la programación da por enviado a Urpi el día
 *  `programmedOn` (AAAA-MM-DD). PURA. */
export function planUrpiDispatch(order: UrpiDispatchOrder, salidas: readonly UrpiDispatchCandidate[], programmedOn: string): UrpiDispatchPlan {
  if (order.cancelled_at || CLOSED.has(order.general_status)) {
    // Un entregado por Urpi cuya caja sigue siendo la de Grupo GF: se toma para
    // poder cerrarla como entrega de Urpi. Cualquier otro cerrado no se toca.
    const gf = !order.cancelled_at && order.general_status === "entregado" ? gfBoxFor(salidas, programmedOn) : null;
    return gf ? { kind: "tomar_caja_gf", salida: gf } : { kind: "cerrado" };
  }
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
  if (!fillable) {
    const gf = gfBoxFor(salidas, programmedOn);
    if (gf) return { kind: "tomar_caja_gf", salida: gf };
    return live.length ? { kind: "otra_salida_viva" } : { kind: "sin_salida" };
  }
  // Una sola caja viva, y es la «por definir»: es la que se llevó Urpi.
  if (live.length > 1) return { kind: "otra_salida_viva" };
  // La caja tenía que existir ese día: una «por definir» creada después no es
  // la que salió (las cajas del barrido del 19/08 se crearon semanas después).
  if (fillable.created_at && limaDayKey(fillable.created_at) > programmedOn) return { kind: "sin_salida" };
  return { kind: "rellenar", salida: fillable };
}

/** La caja propia de Grupo GF, si es la ÚNICA salida viva, sigue pendiente,
 *  nada se entregó con otra salida y ya existía el día programado. Si su
 *  motorizado la reportó «No entregado» antes de ese día lo decide la base
 *  (`urpi_take_gf_output`), que ve paradas, cajas y solicitudes. PURA. */
export function gfBoxFor(salidas: readonly UrpiDispatchCandidate[], programmedOn: string): UrpiDispatchCandidate | null {
  if (salidas.some((s) => s.delivery_status === "entregado")) return null;
  const live = salidas.filter(isLiveUrpiCandidate);
  if (live.length !== 1) return null;
  const box = live[0]!;
  if (box.courier !== "propio" || box.delivery_status !== "pendiente") return null;
  if (box.created_at && limaDayKey(box.created_at) > programmedOn) return null;
  return box;
}

/** Lo que devuelve `urpi_take_gf_output` cuando la caja pasó a Urpi. */
export const GF_BOX_TAKEN = "tomada";

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
  /** De esos, los que eran la caja de Grupo GF que no entregó (0305). */
  fromGf: string[];
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
  const result: UrpiDispatchResult = { filled: [], fromGf: [], alreadyUrpi: 0, closed: 0, sinSalida: [], otraSalidaViva: [], reenvioTrasCancelado: [], cancelled: [], errors: [] };
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
    if (plan.kind === "tomar_caja_gf") {
      const { data, error } = await admin.rpc("urpi_take_gf_output", {
        p_shipment_id: plan.salida.id,
        p_programmed_on: programmedOn,
        p_guide_code: manualRouteGuideCode(fact.order_name, plan.salida.id, "urpi"),
      });
      // Sin la 0305 aplicada, como antes: otra salida viva, para revisar a mano.
      if (error && error.code !== "PGRST202") result.errors.push(code);
      else if (data === GF_BOX_TAKEN) { result.filled.push(code); result.fromGf.push(code); filledIds.push(orderId); }
      else result.otraSalidaViva.push(code);
      continue;
    }
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
  const porDefinir = result.filled.length - result.fromGf.length;
  if (porDefinir) parts.push(`${porDefinir} salida(s) «Por definir» pasaron a Urpi en ruta`);
  if (result.fromGf.length) parts.push(`${result.fromGf.length} caja(s) que Grupo GF no entregó pasaron a Urpi en ruta (${listOf(result.fromGf)})`);
  if (result.otraSalidaViva.length) parts.push(`${result.otraSalidaViva.length} con otra salida viva, revísalos a mano (${listOf(result.otraSalidaViva)})`);
  if (result.cancelled.length) parts.push(`${result.cancelled.length} ya cancelado(s) por Urpi pasaron a «Por reprogramar Lima»`);
  if (result.reenvioTrasCancelado.length) parts.push(`${result.reenvioTrasCancelado.length} que Urpi ya canceló se volvieron a programar a Urpi; Urpi solo lleva primeros despachos (§9.1), revísalos (${listOf(result.reenvioTrasCancelado)})`);
  if (result.sinSalida.length) parts.push(`${result.sinSalida.length} sin caja «Por definir» del día que pasar a Urpi (${listOf(result.sinSalida)})`);
  if (result.errors.length) parts.push(`${result.errors.length} no se pudieron actualizar (${listOf(result.errors)})`);
  return parts.length ? `Despachos a Urpi: ${parts.join("; ")}.` : "";
}
