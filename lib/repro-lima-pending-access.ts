import type { createAdminSupabase } from "@/lib/db";
import type { ReproScope } from "@/lib/repro-lima-access";
import { allCourierRows, courierRowsByIds } from "@/lib/courier-flow";
import { isLimaPendingStage, LIMA_PENDING_STAGES, type LimaPendingGf, type LimaPendingOrder } from "@/lib/repro-lima-pending";

type Admin = ReturnType<typeof createAdminSupabase>;
interface PendingMasterRow {
  order_id: string; store_id: string; order_name: string | null;
  customer_name: string | null; customer_phone: string | null; district: string | null;
  order_total: number | string | null; order_created_at: string | null; macro_since: string | null;
  macro_stage: string; macro_substage: string | null; coverage: string | null;
  current_courier: string | null; dispatched_at: string | null; attempt_count: number | null;
  sales_channel: string | null; address: string | null; reference: string | null;
}
interface PendingProgramRow { order_id: string; store_id: string; scheduled_for: string }
interface GfShipmentRow { id: string; order_id: string; courier: string | null; preparation_state: string | null; qr_token: string | null; delivery_status: string | null; created_at: string | null }
interface GfItemRow { shipment_id: string; manifest_id: string; office_checked_at: string | null; pickup_checked_at: string | null }
interface GfManifestRow { id: string; route_date: string; driver_name: string | null; courier: string | null; kind: string | null; state: string | null }
interface GfRequestRow { order_id: string; shipment_id: string | null; scheduled_for: string | null; status: string }

/** Las salidas que son de Grupo GF: la «por definir» que rellena y la propia. */
const GF_OUTPUT_COURIERS = new Set(["por_definir", "propio"]);
const LIVE_OUTPUT = new Set(["pendiente", "en_ruta"]);

/**
 * «Sale a reparto» (§29.16): por cada pedido que puede salir con Grupo GF, su
 * caja activa de Grupo GF, la solicitud que tomó y si su salida tiene rótulo y
 * está armada. Los candidatos: Preparación y Por despachar, y un «Por
 * reprogramar Lima» con programa (sin acuerdo no sale, §29.13). Un pedido con
 * una salida viva de otro courier sale con ese courier: no es de Grupo GF.
 */
async function loadGfPlanFacts(admin: Admin, rows: PendingMasterRow[], programmed: ReadonlyMap<string, string>): Promise<Map<string, LimaPendingGf>> {
  const out = new Map<string, LimaPendingGf>();
  const candidates = rows.filter((r) => r.macro_stage === "preparacion" || r.macro_stage === "por_despachar" || (r.macro_substage === "por_reprogramar_lima" && programmed.has(r.order_id)));
  if (!candidates.length) return out;
  const orderIds = candidates.map((r) => r.order_id);
  const [{ data: provider }, shipments] = await Promise.all([
    admin.from("logistics_providers").select("id").eq("code", "grupo-gf-courier").maybeSingle(),
    courierRowsByIds<GfShipmentRow>(orderIds, (chunk) => admin.from("shipments")
      .select("id,order_id,courier,preparation_state,qr_token,delivery_status,created_at").in("order_id", chunk) as unknown as PromiseLike<{ data: GfShipmentRow[] | null; error: { message: string } | null }>),
  ]);
  const providerId = (provider as { id: string } | null)?.id ?? null;
  const [requests, items] = await Promise.all([
    providerId
      ? courierRowsByIds<GfRequestRow>(orderIds, (chunk) => admin.from("logistics_requests")
        .select("order_id,shipment_id,scheduled_for,status").eq("provider_id", providerId).in("status", ["accepted", "scheduled"]).in("order_id", chunk) as unknown as PromiseLike<{ data: GfRequestRow[] | null; error: { message: string } | null }>)
      : Promise.resolve({ data: [] as GfRequestRow[] }),
    courierRowsByIds<GfItemRow>(shipments.data.map((s) => s.id), (chunk) => admin.from("dispatch_manifest_items")
      .select("shipment_id,manifest_id,office_checked_at,pickup_checked_at").in("shipment_id", chunk).is("removed_at", null) as unknown as PromiseLike<{ data: GfItemRow[] | null; error: { message: string } | null }>),
  ]);
  const manifests = await courierRowsByIds<GfManifestRow>([...new Set(items.data.map((i) => i.manifest_id))], (chunk) => admin.from("dispatch_manifests")
    .select("id,route_date,driver_name,courier,kind,state").in("id", chunk) as unknown as PromiseLike<{ data: GfManifestRow[] | null; error: { message: string } | null }>);
  // La caja de reparto de Grupo GF que sigue viva (no anulada).
  const gfManifest = new Map(manifests.data.filter((m) => m.courier === "propio" && (m.kind ?? "reparto") === "reparto" && m.state !== "cancelled").map((m) => [m.id, m]));
  const boxByShipment = new Map<string, LimaPendingGf["box"]>();
  for (const item of items.data) {
    const m = gfManifest.get(item.manifest_id);
    if (!m) continue;
    boxByShipment.set(item.shipment_id, { day: m.route_date.slice(0, 10), riderName: m.driver_name, officeChecked: Boolean(item.office_checked_at), pickedUp: Boolean(item.pickup_checked_at) });
  }
  const requestByOrder = new Map(requests.data.map((r) => [r.order_id, r]));
  const outputsByOrder = new Map<string, GfShipmentRow[]>();
  for (const s of shipments.data) outputsByOrder.set(s.order_id, [...(outputsByOrder.get(s.order_id) ?? []), s]);
  for (const row of candidates) {
    const outputs = outputsByOrder.get(row.order_id) ?? [];
    const live = outputs.filter((s) => LIVE_OUTPUT.has(s.delivery_status ?? ""));
    // Sale con otro courier (Aliclik, Swayp…): es de su lista, no de Grupo GF.
    if (live.some((s) => !GF_OUTPUT_COURIERS.has(s.courier ?? ""))) continue;
    const request = requestByOrder.get(row.order_id) ?? null;
    const gfLive = live.filter((s) => GF_OUTPUT_COURIERS.has(s.courier ?? "")).sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""));
    // La salida de la solicitud manda; si no, la más nueva que sigue viva.
    const output = (request?.shipment_id ? gfLive.find((s) => s.id === request.shipment_id) : null) ?? gfLive[0] ?? null;
    const box = gfLive.map((s) => boxByShipment.get(s.id)).find(Boolean) ?? null;
    out.set(row.order_id, {
      box,
      requestDay: request?.scheduled_for?.slice(0, 10) ?? null,
      labeled: Boolean(output?.qr_token),
      armed: output?.preparation_state === "listo_despacho",
    });
  }
  return out;
}

/** Solo lectura, después de requireReproLima. Pagina todos los pedidos, sin
 * truncarlos a 1000 y sin cargar expedientes completos por cada fila. */
export async function loadLimaPending(admin: Admin, scope: ReproScope): Promise<LimaPendingOrder[]> {
  const ids = [...scope.storeIds];
  if (!ids.length) return [];
  const [orders, stores, programs] = await Promise.all([
    allCourierRows<PendingMasterRow>((from, to) => admin.from("order_master")
      .select("order_id,store_id,order_name,customer_name,customer_phone,district,order_total,order_created_at,macro_since,macro_stage,macro_substage,coverage,current_courier,dispatched_at,attempt_count,sales_channel,address,reference")
      .in("store_id", ids).eq("coverage", "lima").in("macro_stage", [...LIMA_PENDING_STAGES])
      .order("order_created_at", { ascending: false, nullsFirst: false }).order("order_id")
      .range(from, to) as unknown as PromiseLike<{ data: PendingMasterRow[] | null; error: { message: string } | null }>),
    courierRowsByIds(ids, (chunk) => admin.from("stores").select("id,name").in("id", chunk)),
    allCourierRows<PendingProgramRow>((from, to) => admin.from("gf_dispatch_programs")
      .select("order_id,store_id,scheduled_for").in("store_id", ids).order("order_id").range(from, to) as unknown as PromiseLike<{ data: PendingProgramRow[] | null; error: { message: string } | null }>),
  ]);
  const names = new Map((stores.data as Array<{ id: string; name: string }>).map((s) => [s.id, s.name]));
  const seen = new Set<string>();
  const safe = orders.filter((row) => {
    if (!scope.storeIds.has(row.store_id) || row.coverage !== "lima" || !isLimaPendingStage(row.macro_stage) || seen.has(row.order_id)) return false;
    seen.add(row.order_id);
    return true;
  });
  const orderStore = new Map(safe.map((row) => [row.order_id, row.store_id]));
  const scheduled = new Map(programs.filter((p) => orderStore.get(p.order_id) === p.store_id).map((p) => [p.order_id, p.scheduled_for]));
  const departures = new Map<string, string>();
  const safeIds = [...orderStore.keys()];
  const gfFacts = await loadGfPlanFacts(admin, safe, scheduled);
  // La misma fuente de Grupo GF, en lotes de 500: una respuesta jamás puede
  // quedar truncada en 1000 y convertir salidas reales en «Nunca salieron».
  for (let offset = 0; offset < safeIds.length; offset += 500) {
    const { data, error } = await admin.rpc("gf_order_departures", { p_order_ids: safeIds.slice(offset, offset + 500) });
    if (error) throw new Error(`No pudimos leer el historial de salidas: ${error.message}`);
    for (const d of (data ?? []) as Array<{ order_id: string; last_departure_at: string }>) {
      if (orderStore.has(d.order_id) && d.last_departure_at) departures.set(d.order_id, d.last_departure_at);
    }
  }
  return safe.map((row) => {
    // El filtro de arriba valida también la macroetapa de cada fila.
    const stage = row.macro_stage as LimaPendingOrder["stage"];
    return {
      orderId: row.order_id, storeId: row.store_id, storeName: names.get(row.store_id) ?? "Tienda",
      orderName: row.order_name ?? "Sin código", customerName: row.customer_name ?? "Sin nombre",
      customerPhone: row.customer_phone, district: row.district, orderTotal: Number(row.order_total ?? 0),
      createdAt: row.order_created_at, macroSince: row.macro_since, stage,
      substage: row.macro_substage, courier: row.current_courier, dispatchedAt: row.dispatched_at,
      attempts: Number(row.attempt_count ?? 0),
      hasPriorDispatch: departures.has(row.order_id), lastDepartureAt: departures.get(row.order_id) ?? null,
      programmedFor: scheduled.get(row.order_id) ?? null,
      salesChannel: row.sales_channel ?? null,
      address: row.address?.trim() || null, reference: row.reference?.trim() || null,
      gf: gfFacts.get(row.order_id) ?? null,
    };
  });
}
