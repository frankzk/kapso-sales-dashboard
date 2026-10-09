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
// pasa a Urpi y la salida queda entregada, porque eso es lo que reportó Urpi.
//
// QUÉ NO HACE. No crea salidas: sin una «por definir» no hay caja en Kapta que
// sea la de Urpi. Y no toca nada si el pedido tiene otra salida viva —otro
// courier, u otra «por definir»—: no se puede saber cuál caja se llevó Urpi.

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
  | { kind: "ya_es_urpi" }
  | { kind: "sin_salida" }
  | { kind: "otra_salida_viva" };

const isLive = (s: UrpiSalidaCandidate) => ["pendiente", "en_ruta"].includes(s.delivery_status) && s.custody_state !== "devuelto" && !s.returned_at;

/** Qué hacer con las salidas de un pedido que Urpi entregó. PURA. */
export function planUrpiSalida(salidas: readonly UrpiSalidaCandidate[]): UrpiSalidaPlan {
  if (salidas.some((s) => s.courier === "urpi" && s.delivery_status === "entregado")) return { kind: "ya_es_urpi" };
  const live = salidas.filter(isLive);
  const fillable = pickFillableRouteOutput(live);
  if (!fillable) return live.length ? { kind: "otra_salida_viva" } : { kind: "sin_salida" };
  // Una sola caja viva, y es la «por definir»: es la que se llevó Urpi.
  if (live.length > 1) return { kind: "otra_salida_viva" };
  return { kind: "rellenar", salida: fillable };
}

/** La fila que se escribe encima. PURA. `dispatchedOn` es el día del primer
 *  intento de Urpi: el reporte lo dice; la hora no, y se usa mediodía de Lima. */
export function urpiSalidaRow(orderName: string | null, shipmentId: string, dispatchedOn: string | null) {
  return {
    courier: "urpi",
    created_via: URPI_REPORT_CREATED_VIA,
    guide_code: manualRouteGuideCode(orderName, shipmentId, "urpi"),
    delivery_status: "entregado",
    status_category: "delivered",
    delivered_source: URPI_REPORT_DELIVERED_SOURCE,
    ...(dispatchedOn ? { dispatched_at: `${dispatchedOn}T17:00:00.000Z` } : {}),
  };
}

export interface UrpiSalidaResult {
  filled: string[];
  sinSalida: string[];
  otraSalidaViva: string[];
  errors: string[];
}

/** Rellena la salida de cada pedido. No falla en bloque: lo que no se puede se
 *  cuenta y queda para revisar a mano. */
export async function fillUrpiSalidas(
  admin: SupabaseClient,
  orders: readonly { orderId: string; orderName: string | null; dispatchedOn: string | null }[],
): Promise<UrpiSalidaResult> {
  const result: UrpiSalidaResult = { filled: [], sinSalida: [], otraSalidaViva: [], errors: [] };
  const ids = orders.map((order) => order.orderId);
  const byOrder = new Map<string, UrpiSalidaCandidate[]>();
  for (let i = 0; i < ids.length; i += 200) {
    const { data, error } = await admin.from("shipments")
      .select("id,order_id,courier,created_via,delivery_status,custody_state,custody_transferred_at,returned_at,output_number")
      .in("order_id", ids.slice(i, i + 200));
    if (error) throw new Error("No se pudieron leer las salidas de los pedidos.");
    for (const row of (data ?? []) as (UrpiSalidaCandidate & { order_id: string })[]) {
      byOrder.set(row.order_id, [...(byOrder.get(row.order_id) ?? []), row]);
    }
  }
  for (const order of orders) {
    const plan = planUrpiSalida(byOrder.get(order.orderId) ?? []);
    if (plan.kind === "ya_es_urpi") continue;
    if (plan.kind === "sin_salida") { result.sinSalida.push(order.orderId); continue; }
    if (plan.kind === "otra_salida_viva") { result.otraSalidaViva.push(order.orderId); continue; }
    const written = await writeCourierGuide(admin, order.orderId, urpiSalidaRow(order.orderName, plan.salida.id, order.dispatchedOn), { createIfMissing: false });
    if ("error" in written) result.errors.push(order.orderId);
    else result.filled.push(order.orderId);
  }
  return result;
}

