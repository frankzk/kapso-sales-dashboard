// La salida de Grupo GF, rellenada sobre la caja «por definir» al aplicar el
// cuaderno de un motorizado (decisión del dueño, 19-10-2026; MOM §30.8, §4).
//
// POR QUÉ. Las entregas del cuaderno —la carga histórica
// (scripts/apply-cuaderno-history-to-master.ts) y «Aplicar al Master» de
// Liquidaciones 2— solo escriben el `status_override` del pedido por la puerta
// única (lib/master-door.ts): no tocan salidas. La caja se había armado y
// rotulado como salida «por definir» y nadie le puso el courier, así que el
// pedido quedaba entregado con su salida pendiente y la mesa de cierre pedía
// «Salida adicional activa»: 581 pedidos medidos el 20-10-2026, 437 de Kenku.
//
// QUÉ HACE. Lo mismo que lib/urpi-salida.ts para Urpi: RELLENA la salida «por
// definir» (lib/route-output-fill.ts) en vez de abrir otra. Consecutivo, QR,
// preparación y custodia se conservan; el courier pasa a `propio` —Alexis
// también es motorizado de Grupo GF (decisión 11)— y la salida queda entregada
// el día del cuaderno, a mediodía de Lima como el evento de la entrega. El
// pedido sale de «Salida adicional activa» hacia Pendiente de liquidación; no se
// cierra ninguna liquidación (decisión 3).
//
// QUÉ NO HACE. No crea salidas: sin una «por definir» no hay caja en Kapta que
// sea la del motorizado. No toca un pedido con otra salida viva —otro courier u
// otra «por definir»—, porque no se sabe qué caja se llevó; ni uno con una
// salida ya entregada; ni uno que Urpi reportó, porque esa caja puede ser de
// Urpi o la entrega está en duda; ni uno que una fila posterior de cualquier
// hoja da por devuelto, anulado o sin salida, porque el paquete pudo volver al
// almacén (lo mismo que excluye la 0270, `cuaderno_contradicho`); ni una caja
// que no estaba lista para salir el día que el cuaderno da por entregado. Si la
// caja ya salió con el motorizado en su ruta, su verdad es la parada (MOM
// §29.13) y tampoco hay nada que rellenar. Una entrega que no es de Grupo GF no
// hace nada.

import type { SupabaseClient } from "@supabase/supabase-js";
import { writeCourierGuide } from "@/lib/route-output-fill";
import { manualRouteGuideCode, pickFillableRouteOutput } from "@/lib/shipment-output";

/** Couriers de los cuadernos de Grupo GF: Reparto propio y la hoja de Alexis
 *  (Courier externo con `config.courier = alexis`, decisión 11). */
export const GF_NOTEBOOK_COURIERS = ["propio", "alexis"] as const;

/** `created_via` y `delivered_source` propios: quien audite distingue la caja
 *  que se rellenó por el cuaderno de la que se rellenó al emitir una guía. */
export const OWN_NOTEBOOK_CREATED_VIA = "cuaderno_gf";
export const OWN_NOTEBOOK_DELIVERED_SOURCE = "cuaderno_gf";

/** El courier de la salida rellenada: Grupo GF Courier, también para Alexis. */
const OWN_COURIER = "propio";

const DAY_MS = 86_400_000;

/** Efectos de una fila de hoja que desmienten una entrega anterior (0270). */
const CONTRADICTING_EFFECTS: ReadonlySet<string> = new Set(["devolucion", "anulacion", "sin_salida"]);

/** ¿La entrega es de un motorizado de Grupo GF? */
export function isGfNotebookCourier(courier: string | null | undefined): boolean {
  return (GF_NOTEBOOK_COURIERS as readonly string[]).includes((courier ?? "").trim().toLowerCase());
}

/** ¿El cuaderno dice el día? Sin día no se sabe cuándo salió la caja y no se
 *  rellena: la entrega se marca igual y la salida queda para revisar a mano. */
export function hasNotebookDate(fecha: unknown): fecha is string {
  return typeof fecha === "string" && /^\d{4}-\d{2}-\d{2}$/.test(fecha);
}

export interface OwnSalidaCandidate {
  id: string;
  courier: string;
  created_via: string | null;
  delivery_status: string;
  custody_state: string | null;
  custody_transferred_at: string | null;
  returned_at: string | null;
  output_number: number | null;
  preparation_state: string | null;
  ready_at: string | null;
  created_at: string | null;
}

export type OwnSalidaPlan =
  | { kind: "rellenar"; salida: OwnSalidaCandidate }
  | { kind: "ya_entregada" }
  | { kind: "salida_propia" }
  | { kind: "reportado_por_urpi" }
  | { kind: "contradicho" }
  | { kind: "sin_salida" }
  | { kind: "otra_salida_viva" }
  | { kind: "caja_dudosa" };

const isLive = (s: OwnSalidaCandidate) => ["pendiente", "en_ruta"].includes(s.delivery_status) && s.custody_state !== "devuelto" && !s.returned_at;

/**
 * Qué hacer con las salidas de un pedido que el cuaderno de Grupo GF da por
 * entregado el `deliveredAt`. PURA. `contradicted`: una fila posterior de alguna
 * hoja lo da por devuelto, anulado o sin salida (`notebookContradicts`).
 *
 * La caja tiene que haber estado lista cuando dice el cuaderno: escaneada como
 * «listo despacho» y no lista más de un día después de la entrega. Si no, la
 * «por definir» es otra caja —la de un reenvío armado después— y rellenarla
 * daría por entregado un paquete que sigue en el almacén. Es la misma regla con
 * la que la auditoría del 14-10-2026 separó las «cajas dudosas».
 */
export function planOwnSalida(
  salidas: readonly OwnSalidaCandidate[],
  facts: { deliveredAt: string; urpiReported?: boolean; contradicted?: boolean },
): OwnSalidaPlan {
  // Ya hay una salida entregada, de Grupo GF o de otro courier: esa es la que
  // entregó, y la «por definir» que sobre la decide una persona.
  if (salidas.some((s) => s.delivery_status === "entregado")) return { kind: "ya_entregada" };
  const live = salidas.filter(isLive);
  // La caja ya es del motorizado: salió en su ruta y su verdad es la parada
  // (MOM §29.13). Nada que rellenar ni que revisar.
  if (live.length && live.every((s) => s.courier.trim().toLowerCase() === OWN_COURIER)) return { kind: "salida_propia" };
  if (facts.urpiReported) return { kind: "reportado_por_urpi" };
  // Después de esa entrega alguien anotó que volvió, se anuló o no salió: la
  // caja pudo volver al almacén y la decide una persona.
  if (facts.contradicted) return { kind: "contradicho" };
  const fillable = pickFillableRouteOutput(live);
  if (!fillable) return live.length ? { kind: "otra_salida_viva" } : { kind: "sin_salida" };
  // Una sola caja viva, y es la «por definir»: es la que se llevó el motorizado.
  if (live.length > 1) return { kind: "otra_salida_viva" };
  if (fillable.preparation_state !== "listo_despacho") return { kind: "caja_dudosa" };
  const since = Date.parse(fillable.ready_at ?? fillable.created_at ?? "");
  if (Number.isFinite(since) && Date.parse(facts.deliveredAt) < since - DAY_MS) return { kind: "caja_dudosa" };
  return { kind: "rellenar", salida: fillable };
}

/** Una fila de hoja de un pedido, con el efecto de su estado en el dominio de su hoja. */
export interface NotebookRowEffect {
  /** `values.fecha`: YYYY-MM-DD, o vacío. */
  fecha: string | null;
  effect: string | null;
}

/**
 * ¿Alguna fila de un día posterior al de la entrega lo da por devuelto,
 * anulado o sin salida? La misma guarda que `cuaderno_contradicho` en la 0270:
 * cuenta cualquier hoja, no solo la que se aplica. PURA.
 */
export function notebookContradicts(rows: readonly NotebookRowEffect[], deliveredAt: string): boolean {
  const day = deliveredAt.slice(0, 10);
  return rows.some((row) => Boolean(row.fecha) && row.fecha! > day && CONTRADICTING_EFFECTS.has(row.effect ?? ""));
}

/** La fila que se escribe encima. PURA. `deliveredAt` es el instante del evento
 *  de la entrega: el día del cuaderno a mediodía de Lima (17:00Z). Va a
 *  `closed_at`, que es de donde el Master saca el día de la entrega, y a
 *  `dispatched_at`: el cuaderno no dice otra salida que la del día de reparto. */
export function ownSalidaRow(orderName: string | null, shipmentId: string, deliveredAt: string) {
  return {
    courier: OWN_COURIER,
    created_via: OWN_NOTEBOOK_CREATED_VIA,
    guide_code: manualRouteGuideCode(orderName, shipmentId, OWN_COURIER),
    delivery_status: "entregado",
    status_category: "delivered",
    delivered_source: OWN_NOTEBOOK_DELIVERED_SOURCE,
    dispatched_at: deliveredAt,
    closed_at: deliveredAt,
  };
}

export interface OwnSalidaResult {
  filled: string[];
  sinSalida: string[];
  otraSalidaViva: string[];
  /** Caja no lista el día de la entrega, pedido que Urpi reportó o que una fila posterior contradice. */
  porRevisar: string[];
  errors: string[];
}

export interface OwnSalidaOrder {
  orderId: string;
  orderName: string | null;
  /** El courier de la entrega: si no es de Grupo GF, el pedido no se mira. */
  courier: string | null;
  /** El `occurredAt` que recibió la puerta: el día del cuaderno a las 17:00Z. */
  deliveredAt: string;
}

/** Rellena la salida de cada pedido entregado por Grupo GF. No falla en bloque:
 *  lo que no se puede se cuenta y queda para revisar a mano. Quien llama
 *  recalcula los `filled`. */
export async function fillOwnSalidas(admin: SupabaseClient, orders: readonly OwnSalidaOrder[]): Promise<OwnSalidaResult> {
  const result: OwnSalidaResult = { filled: [], sinSalida: [], otraSalidaViva: [], porRevisar: [], errors: [] };
  const gf = orders.filter((order) => isGfNotebookCourier(order.courier));
  if (!gf.length) return result;
  const ids = [...new Set(gf.map((order) => order.orderId))];
  const byOrder = new Map<string, OwnSalidaCandidate[]>();
  const urpi = new Set<string>();
  const sheetRows = new Map<string, { sheetId: string; fecha: string | null; estado: string | null }[]>();
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    const { data, error } = await admin.from("shipments")
      .select("id,order_id,courier,created_via,delivery_status,custody_state,custody_transferred_at,returned_at,output_number,preparation_state,ready_at,created_at")
      .in("order_id", chunk);
    if (error) throw new Error("No se pudieron leer las salidas de los pedidos.");
    for (const row of (data ?? []) as (OwnSalidaCandidate & { order_id: string })[]) {
      byOrder.set(row.order_id, [...(byOrder.get(row.order_id) ?? []), row]);
    }
    const { data: reported, error: urpiError } = await admin.from("urpi_report_rows").select("order_id").in("order_id", chunk);
    if (urpiError) throw new Error("No se pudo comprobar si Urpi reportó los pedidos.");
    for (const row of (reported ?? []) as { order_id: string | null }[]) if (row.order_id) urpi.add(row.order_id);
    // Las filas de todas las hojas del pedido: una posterior puede desmentir la
    // entrega. Solo la fecha y el estado, no la fila entera.
    const { data: rows, error: rowsError } = await admin
      .from("sheet_rows")
      .select("order_id,sheet_id,fecha:values->>fecha,estado:values->>estado")
      .in("order_id", chunk);
    if (rowsError) throw new Error("No se pudo comprobar si el cuaderno contradice la entrega.");
    for (const row of (rows ?? []) as { order_id: string | null; sheet_id: string; fecha: string | null; estado: string | null }[]) {
      if (!row.order_id) continue;
      sheetRows.set(row.order_id, [...(sheetRows.get(row.order_id) ?? []), { sheetId: row.sheet_id, fecha: row.fecha, estado: row.estado }]);
    }
  }
  // El efecto de cada estado sale del dominio de su hoja (`sheet_domain_statuses`).
  const effectOf = await notebookEffects(admin, [...sheetRows.values()].flat().map((row) => row.sheetId));
  const done = new Set<string>();
  for (const order of gf) {
    if (done.has(order.orderId)) continue;
    done.add(order.orderId);
    const contradicted = notebookContradicts(
      (sheetRows.get(order.orderId) ?? []).map((row) => ({ fecha: row.fecha, effect: effectOf(row.sheetId, row.estado) })),
      order.deliveredAt,
    );
    const plan = planOwnSalida(byOrder.get(order.orderId) ?? [], {
      deliveredAt: order.deliveredAt,
      urpiReported: urpi.has(order.orderId),
      contradicted,
    });
    if (plan.kind === "ya_entregada" || plan.kind === "salida_propia") continue;
    if (plan.kind === "sin_salida") { result.sinSalida.push(order.orderId); continue; }
    if (plan.kind === "otra_salida_viva") { result.otraSalidaViva.push(order.orderId); continue; }
    if (plan.kind !== "rellenar") { result.porRevisar.push(order.orderId); continue; }
    const written = await writeCourierGuide(admin, order.orderId, ownSalidaRow(order.orderName, plan.salida.id, order.deliveredAt), { createIfMissing: false });
    if ("error" in written) result.errors.push(order.orderId);
    else result.filled.push(order.orderId);
  }
  return result;
}

/** El efecto de un estado en la hoja donde se anotó: hoja → dominio → estado. */
async function notebookEffects(
  admin: SupabaseClient,
  sheetIds: readonly string[],
): Promise<(sheetId: string, estado: string | null) => string | null> {
  const unique = [...new Set(sheetIds)];
  const domainBySheet = new Map<string, string>();
  const effects = new Map<string, string>();
  if (unique.length) {
    const { data: sheets, error } = await admin.from("sheets").select("id,domain_id").in("id", unique);
    if (error) throw new Error("No se pudieron leer las hojas del cuaderno.");
    for (const sheet of (sheets ?? []) as { id: string; domain_id: string | null }[]) {
      if (sheet.domain_id) domainBySheet.set(sheet.id, sheet.domain_id);
    }
    const domains = [...new Set(domainBySheet.values())];
    if (domains.length) {
      const { data: statuses, error: statusError } = await admin
        .from("sheet_domain_statuses")
        .select("domain_id,code,effect")
        .in("domain_id", domains);
      if (statusError) throw new Error("No se pudieron leer los estados del cuaderno.");
      for (const status of (statuses ?? []) as { domain_id: string; code: string; effect: string | null }[]) {
        if (status.effect) effects.set(`${status.domain_id}:${status.code}`, status.effect);
      }
    }
  }
  return (sheetId, estado) => {
    const domain = domainBySheet.get(sheetId);
    return domain && estado ? effects.get(`${domain}:${estado}`) ?? null : null;
  };
}

/** Lo que se dice de las cajas en el aviso de quien aplicó. Sin cajas que
 *  mirar, nada. PURA. */
export function ownSalidaNotice(result: OwnSalidaResult): string[] {
  const parts: string[] = [];
  if (result.filled.length) parts.push(`${result.filled.length} caja(s) «Por definir» pasaron a Grupo GF entregada`);
  const review = result.otraSalidaViva.length + result.porRevisar.length;
  if (review) parts.push(`${review} con su caja «Por definir» sin rellenar: revisa su salida a mano`);
  // Volver a aplicar no las reintenta: el pedido ya quedó entregado (MOM §30.8).
  if (result.errors.length) parts.push(`${result.errors.length} salida(s) no se pudieron actualizar: revísalas a mano`);
  return parts;
}
