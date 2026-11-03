// La salida de Urpi, rellenada sobre la caja «por definir» (MOM §30.11, §4).
//
// POR QUÉ. Los despachos a Urpi salen del Google Sheet de programación, no de la
// mesa de ruta: la caja se arma y se rotula como salida «por definir» y nadie le
// pone el courier en Kapta. Al marcar entregado desde el reporte de Urpi, el
// pedido quedaba entregado pero su salida seguía «pendiente», y la mesa de cierre
// pedía «Salida adicional activa» (37 de los primeros 40, 05-10-2026).
//
// QUÉ HACE. Lo mismo que hacen Tanders, Aliclik, Shalom y Swayp al emitir su
// guía: RELLENA la salida «por definir» (lib/route-output-fill.ts) en vez de
// abrir otra. Consecutivo, QR, preparación y custodia se conservan; el courier
// pasa a Urpi y la salida queda entregada el día que Urpi la dio por entregada,
// porque eso es lo que reportó Urpi.
//
// QUÉ NO HACE. No crea salidas: sin una «por definir» no hay caja en Kapta que
// sea la de Urpi. Y no toca nada si el pedido tiene otra salida viva —otro
// courier, u otra «por definir»—: no se puede saber cuál caja se llevó Urpi.
//
// LA SALIDA QUE YA ES DE URPI (03-11-2026). Desde que la programación registra
// el despacho (lib/urpi-dispatch.ts), la caja suele estar ya como salida de Urpi
// en ruta cuando Urpi reporta la entrega. Entonces no se rellena nada: se CIERRA
// esa salida como entregada el día del reporte, con su evento `courier_status`,
// aunque el pedido tenga otra salida viva —esa es la caja de Urpi, sin duda—.

import type { SupabaseClient } from "@supabase/supabase-js";
import { writeCourierGuide } from "@/lib/route-output-fill";
import { manualRouteGuideCode, pickFillableRouteOutput } from "@/lib/shipment-output";

/** `created_via` propio: quien audite distingue la salida que se rellenó por el
 *  reporte de Urpi de la que se rellenó al emitir una guía. */
export const URPI_REPORT_CREATED_VIA = "urpi_report";
export const URPI_REPORT_DELIVERED_SOURCE = "urpi_report";

export interface UrpiSalidaCandidate {
  id: string;
  courier: string;
  created_via: string | null;
  delivery_status: string;
  custody_state: string | null;
  custody_transferred_at: string | null;
  returned_at: string | null;
  output_number: number | null;
}

export type UrpiSalidaPlan =
  | { kind: "rellenar"; salida: UrpiSalidaCandidate }
  | { kind: "cerrar"; salida: UrpiSalidaCandidate }
  | { kind: "ya_es_urpi" }
  | { kind: "sin_salida" }
  | { kind: "otra_salida_viva" };

/** Viva: pendiente o en ruta, y no devuelta. */
export const isLiveUrpiCandidate = (s: Pick<UrpiSalidaCandidate, "delivery_status" | "custody_state" | "returned_at">) =>
  ["pendiente", "en_ruta"].includes(s.delivery_status) && s.custody_state !== "devuelto" && !s.returned_at;

/** Qué hacer con las salidas de un pedido que Urpi entregó. PURA. */
export function planUrpiSalida(salidas: readonly UrpiSalidaCandidate[]): UrpiSalidaPlan {
  if (salidas.some((s) => s.courier === "urpi" && s.delivery_status === "entregado")) return { kind: "ya_es_urpi" };
  const live = salidas.filter(isLiveUrpiCandidate);
  // La caja ya salió como de Urpi (la programación registró el despacho): se
  // cierra esa. Si hubiera más de una, la de consecutivo más alto.
  const urpi = live.filter((s) => s.courier === "urpi").sort((a, b) => (b.output_number ?? 0) - (a.output_number ?? 0))[0];
  if (urpi) return { kind: "cerrar", salida: urpi };
  const fillable = pickFillableRouteOutput(live);
  if (!fillable) return live.length ? { kind: "otra_salida_viva" } : { kind: "sin_salida" };
  // Una sola caja viva, y es la «por definir»: es la que se llevó Urpi.
  if (live.length > 1) return { kind: "otra_salida_viva" };
  return { kind: "rellenar", salida: fillable };
}

/** La fila que se escribe encima. PURA. `dispatchedOn` es el día del primer
 *  intento de Urpi y `deliveredOn` el de la fila más reciente, la «Entregado»
 *  de la que sale también la entrega del Master: el reporte dice el día; la
 *  hora no, y se usa mediodía de Lima, como en el evento de la entrega.
 *  `deliveredOn` va a `closed_at`, que es de donde el Master saca el día de la
 *  entrega: sin él tomaba el día del relleno (MOM §30.11). El día que el
 *  reporte no trae no se escribe: no se inventa una fecha. */
export function urpiSalidaRow(orderName: string | null, shipmentId: string, dispatchedOn: string | null, deliveredOn: string | null) {
  return {
    courier: "urpi",
    created_via: URPI_REPORT_CREATED_VIA,
    guide_code: manualRouteGuideCode(orderName, shipmentId, "urpi"),
    delivery_status: "entregado",
    status_category: "delivered",
    delivered_source: URPI_REPORT_DELIVERED_SOURCE,
    ...(dispatchedOn ? { dispatched_at: `${dispatchedOn}T17:00:00.000Z` } : {}),
    ...(deliveredOn ? { closed_at: `${deliveredOn}T17:00:00.000Z` } : {}),
  };
}

/** Lo que se escribe al cerrar la salida de Urpi que ya estaba en ruta: la
 *  misma entrega que `urpiSalidaRow`, sin tocar courier, guía ni despacho. PURA. */
export function urpiSalidaCloseRow(deliveredOn: string | null) {
  return {
    delivery_status: "entregado",
    status_category: "delivered",
    delivered_source: URPI_REPORT_DELIVERED_SOURCE,
    ...(deliveredOn ? { closed_at: `${deliveredOn}T17:00:00.000Z` } : {}),
  };
}

/** Cuándo la salida de Urpi de un pedido entregado todavía pide algo: rellenar
 *  la «por definir» o cerrar la que está en ruta. PURA. */
export function urpiSalidaPending(plan: UrpiSalidaPlan): boolean {
  return plan.kind === "rellenar" || plan.kind === "cerrar";
}

export interface UrpiSalidaResult {
  filled: string[];
  /** Salidas de Urpi que estaban en ruta y quedaron entregadas. */
  closed: string[];
  sinSalida: string[];
  otraSalidaViva: string[];
  errors: string[];
}

/** Rellena la salida de cada pedido. No falla en bloque: lo que no se puede se
 *  cuenta y queda para revisar a mano. */
export async function fillUrpiSalidas(
  admin: SupabaseClient,
  orders: readonly { orderId: string; orderName: string | null; dispatchedOn: string | null; deliveredOn: string | null }[],
): Promise<UrpiSalidaResult> {
  const result: UrpiSalidaResult = { filled: [], closed: [], sinSalida: [], otraSalidaViva: [], errors: [] };
  const ids = orders.map((order) => order.orderId);
  const byOrder = new Map<string, UrpiSalidaCandidate[]>();
  for (let i = 0; i < ids.length; i += 200) {
    const { data, error } = await admin.from("shipments")
      .select("id,order_id,store_id,guide_code,courier,created_via,delivery_status,custody_state,custody_transferred_at,returned_at,output_number")
      .in("order_id", ids.slice(i, i + 200));
    if (error) throw new Error("No se pudieron leer las salidas de los pedidos.");
    for (const row of (data ?? []) as (UrpiSalidaCandidate & { order_id: string; store_id: string; guide_code: string | null })[]) {
      byOrder.set(row.order_id, [...(byOrder.get(row.order_id) ?? []), row]);
    }
  }
  for (const order of orders) {
    const plan = planUrpiSalida(byOrder.get(order.orderId) ?? []);
    if (plan.kind === "ya_es_urpi") continue;
    if (plan.kind === "sin_salida") { result.sinSalida.push(order.orderId); continue; }
    if (plan.kind === "otra_salida_viva") { result.otraSalidaViva.push(order.orderId); continue; }
    if (plan.kind === "cerrar") {
      const salida = plan.salida as UrpiSalidaCandidate & { store_id?: string; guide_code?: string | null };
      const previous = salida.delivery_status;
      // Condicionado: si entre la lectura y la escritura alguien la cambió, no
      // se pisa.
      const { data: updated, error } = await admin.from("shipments")
        .update({ ...urpiSalidaCloseRow(order.deliveredOn), updated_at: new Date().toISOString() })
        .eq("id", salida.id).eq("courier", "urpi").eq("delivery_status", previous)
        .select("id").maybeSingle();
      if (error || !updated) { result.errors.push(order.orderId); continue; }
      await admin.from("order_events").insert({
        store_id: salida.store_id, order_id: order.orderId, kind: "courier_status",
        occurred_at: order.deliveredOn ? `${order.deliveredOn}T17:00:00.000Z` : new Date().toISOString(),
        actor: null, source: URPI_REPORT_DELIVERED_SOURCE, courier: "urpi", guide_code: salida.guide_code ?? null,
        shipment_id: salida.id, previous_status: previous, new_status: "entregado",
        note: "Urpi: entregado según su reporte de resultados.",
      });
      result.closed.push(order.orderId);
      continue;
    }
    const written = await writeCourierGuide(admin, order.orderId, urpiSalidaRow(order.orderName, plan.salida.id, order.dispatchedOn, order.deliveredOn), { createIfMissing: false });
    if ("error" in written) result.errors.push(order.orderId);
    else result.filled.push(order.orderId);
  }
  return result;
}

