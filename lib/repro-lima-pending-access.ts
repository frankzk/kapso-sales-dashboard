import type { createAdminSupabase } from "@/lib/db";
import type { ReproScope } from "@/lib/repro-lima-access";
import { allCourierRows, courierRowsByIds } from "@/lib/courier-flow";
import { isLimaPendingStage, LIMA_PENDING_STAGES, type LimaPendingGf, type LimaPendingOrder } from "@/lib/repro-lima-pending";
import { isCurrentBoxDay } from "@/lib/dispatch-plan";
import { outputsBlockingRetry } from "@/lib/gf-retry";
import { gfDistrictBlock } from "@/lib/gf-district-check";
import { pickFillableRouteOutput } from "@/lib/shipment-output";
import { isAlidriver, isAutoecom } from "@/lib/aliclik-lima";
import type { DistrictAvailabilityEventRow, DistrictTariffRow } from "@/lib/grupo-gf-courier";
import { limaClock } from "@/lib/grupo-gf-courier";

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
interface GfShipmentRow {
  id: string; order_id: string; courier: string | null; preparation_state: string | null; qr_token: string | null;
  delivery_status: string | null; created_at: string | null;
  // Para decidir, como la cola de Grupo GF, qué salida ya falló o volvió.
  reported_status: string | null; swayp_state: number | null; dispatched_at: string | null; closed_at: string | null;
  returned_at: string | null; updated_at: string | null; custody_state: string | null; output_number: number | null;
  // Para saber, como la cola, si es la «por definir» que Grupo GF rellena (`pickFillableRouteOutput`).
  created_via: string | null; custody_transferred_at: string | null;
}
interface GfItemRow { shipment_id: string; manifest_id: string; office_checked_at: string | null; pickup_checked_at: string | null }
interface GfManifestRow { id: string; route_date: string; driver_name: string | null; courier: string | null; kind: string | null; state: string | null }
interface GfRequestRow { order_id: string; shipment_id: string | null; scheduled_for: string | null; status: string }
type Read<T> = PromiseLike<{ data: T[] | null; error: { message: string } | null }>;

/** Las salidas que son de Grupo GF: la «por definir» que rellena y la propia. */
const GF_OUTPUT_COURIERS = new Set(["por_definir", "propio"]);
const LIVE_OUTPUT = new Set(["pendiente", "en_ruta"]);
const GF_SHIPMENT_COLUMNS = "id,order_id,courier,preparation_state,qr_token,delivery_status,created_at,reported_status,swayp_state,dispatched_at,closed_at,returned_at,updated_at,custody_state,output_number,created_via,custody_transferred_at";
const TARIFF_COLUMNS = "id,provider_id,agreement_id,district_key,zone,delivery_amount,rejection_amount,includes_igv,currency,effective_from,effective_to,status";
const AVAILABILITY_COLUMNS = "id,provider_id,agreement_id,district_key,action,reason,paused_until,created_by,created_at";

/** Una caja de reparto de Grupo GF que no se anuló. */
function isGfReparto(m: Pick<GfManifestRow, "courier" | "kind" | "state">): boolean {
  return m.courier === "propio" && (m.kind ?? "reparto") === "reparto" && m.state !== "cancelled";
}

/**
 * Los pedidos (de `orderIds`) que están en una caja de Grupo GF de hoy o de un
 * día que viene. Al recogerla, el motorizado deja el pedido En curso · En
 * reparto: sin esto, Repro Lima los perdía de «Hoy» y nunca contaba los
 * recibidos (revisión, 07-11-2026). Las cajas van por fecha, no por tienda: la
 * caja es de Grupo GF y los pedidos se cruzan con los nuestros.
 */
async function ordersInCurrentGfBoxes(admin: Admin, orderIds: ReadonlySet<string>, today: string): Promise<Set<string>> {
  const out = new Set<string>();
  if (!orderIds.size) return out;
  const { data: manifests, error } = await admin.from("dispatch_manifests")
    .select("id,courier,kind,state").eq("courier", "propio").gte("route_date", today).neq("state", "cancelled");
  if (error) throw new Error(`No pudimos leer las cajas de Grupo GF: ${error.message}`);
  const ids = ((manifests ?? []) as Array<Pick<GfManifestRow, "id" | "courier" | "kind" | "state">>).filter(isGfReparto).map((m) => m.id);
  if (!ids.length) return out;
  // Paginado: una caja por motorizado y carga, hoy y mañana, pasa de mil ítems en un pico.
  const items = await allCourierRows<{ shipment_id: string }>((from, to) => admin.from("dispatch_manifest_items")
    .select("shipment_id").in("manifest_id", ids).is("removed_at", null).order("id").range(from, to) as unknown as Read<{ shipment_id: string }>);
  const shipments = await courierRowsByIds<{ order_id: string }>([...new Set(items.map((i) => i.shipment_id))], (chunk) => admin.from("shipments")
    .select("order_id").in("id", chunk) as unknown as Read<{ order_id: string }>);
  for (const s of shipments.data) if (orderIds.has(s.order_id)) out.add(s.order_id);
  return out;
}

/**
 * «Sale a reparto» (§29.16): por cada pedido que puede salir con Grupo GF, su
 * caja de Grupo GF, la solicitud que tomó y si su salida tiene rótulo y está
 * armada. Los candidatos: Preparación, Por despachar, todo «Por reprogramar
 * Lima» (sin acuerdo ni programa no tiene día, `limaPlanCandidate`, §29.13) y
 * lo En curso que está en una caja de hoy o de un día que viene (ya lo
 * recogió el motorizado). El acuerdo vive en el caso de Repro Lima, no aquí:
 * un acuerdo con Grupo GF que aún no es programa también cuenta.
 * - Lo que Grupo GF todavía no tomó y no está en una caja vigente entra solo
 *   si la cola de Despacho del día lo admitiría (revisión, 08-11-2026): un
 *   distrito con convenio, tarifa y sin pausa (`gfDistrictBlock`), y una
 *   salida que Grupo GF pueda rellenar. Lo demás está en «Sin condiciones» de
 *   Grupo GF (Santa Rosa, Ancón… en pausa) y no sale con Grupo GF.
 * - Las salidas que cuentan son las de la cola de Grupo GF (`outputsBlockingRetry`):
 *   ni la guía de otro courier que ya falló (la de Tanders que vuelve sigue
 *   `en_ruta`) ni la salida devuelta. Con otra salida viva de otro courier, el
 *   pedido sale con ese courier: no es de Grupo GF.
 * - Solo una caja de hoy o de un día que viene es su caja. La de un día que
 *   pasó no fija el día (`pastBox`: ni la solicitud vieja ni el corte, solo el
 *   acuerdo o el programa); si el motorizado se la llevó, se dice «por recibir
 *   en oficina».
 */
async function loadGfPlanFacts(admin: Admin, rows: PendingMasterRow[], storeOrg: ReadonlyMap<string, string>, today: string): Promise<Map<string, LimaPendingGf>> {
  const orgIds = [...new Set(storeOrg.values())];
  const out = new Map<string, LimaPendingGf>();
  const isRetry = (r: PendingMasterRow) => r.macro_stage === "en_curso" && r.macro_substage === "por_reprogramar_lima";
  const inCurso = new Set(rows.filter((r) => r.macro_stage === "en_curso" && !isRetry(r)).map((r) => r.order_id));
  const boxed = await ordersInCurrentGfBoxes(admin, inCurso, today);
  const candidates = rows.filter((r) => r.macro_stage === "preparacion" || r.macro_stage === "por_despachar" || isRetry(r) || boxed.has(r.order_id));
  if (!candidates.length) return out;
  const orderIds = candidates.map((r) => r.order_id);
  const [providers, shipments] = await Promise.all([
    // El proveedor de la organización de cada tienda, como el resto de Repro Lima.
    orgIds.length
      ? courierRowsByIds<{ id: string; org_id: string }>(orgIds, (chunk) => admin.from("logistics_providers")
        .select("id,org_id").eq("code", "grupo-gf-courier").in("org_id", chunk) as unknown as Read<{ id: string; org_id: string }>)
      : Promise.resolve({ data: [] as Array<{ id: string; org_id: string }> }),
    courierRowsByIds<GfShipmentRow>(orderIds, (chunk) => admin.from("shipments")
      .select(GF_SHIPMENT_COLUMNS).in("order_id", chunk) as unknown as Read<GfShipmentRow>),
  ]);
  const providerIds = providers.data.map((p) => p.id);
  const providerByOrg = new Map(providers.data.map((p) => [p.org_id, p.id]));
  const [requests, items, agreements, tariffs, events] = await Promise.all([
    providerIds.length
      ? courierRowsByIds<GfRequestRow>(orderIds, (chunk) => admin.from("logistics_requests")
        .select("order_id,shipment_id,scheduled_for,status").in("provider_id", providerIds).in("status", ["accepted", "scheduled"]).in("order_id", chunk) as unknown as Read<GfRequestRow>)
      : Promise.resolve({ data: [] as GfRequestRow[] }),
    courierRowsByIds<GfItemRow>(shipments.data.map((s) => s.id), (chunk) => admin.from("dispatch_manifest_items")
      .select("shipment_id,manifest_id,office_checked_at,pickup_checked_at").in("shipment_id", chunk).is("removed_at", null) as unknown as Read<GfItemRow>),
    // El convenio, el Tarifario y las pausas del proveedor: lo que la cola mira para «Sin condiciones».
    providerIds.length
      ? allCourierRows<{ id: string; store_id: string | null; provider_id: string }>((from, to) => admin.from("logistics_service_agreements")
        .select("id,store_id,provider_id").in("provider_id", providerIds).eq("status", "active").order("id").range(from, to) as unknown as Read<{ id: string; store_id: string | null; provider_id: string }>)
      : Promise.resolve([] as Array<{ id: string; store_id: string | null; provider_id: string }>),
    providerIds.length
      ? allCourierRows<DistrictTariffRow>((from, to) => admin.from("logistics_district_tariffs")
        .select(TARIFF_COLUMNS).in("provider_id", providerIds).order("id").range(from, to) as unknown as Read<DistrictTariffRow>)
      : Promise.resolve([] as DistrictTariffRow[]),
    providerIds.length
      ? allCourierRows<DistrictAvailabilityEventRow>((from, to) => admin.from("logistics_district_availability_events")
        .select(AVAILABILITY_COLUMNS).in("provider_id", providerIds).order("id").range(from, to) as unknown as Read<DistrictAvailabilityEventRow>)
      : Promise.resolve([] as DistrictAvailabilityEventRow[]),
  ]);
  const agreementByStore = new Map(agreements.filter((a) => a.store_id).map((a) => [`${a.provider_id}:${a.store_id}`, a.id]));
  const tariffRows = tariffs.map((t) => ({ ...t, delivery_amount: Number(t.delivery_amount), rejection_amount: Number(t.rejection_amount) }));
  const manifests = await courierRowsByIds<GfManifestRow>([...new Set(items.data.map((i) => i.manifest_id))], (chunk) => admin.from("dispatch_manifests")
    .select("id,route_date,driver_name,courier,kind,state").in("id", chunk) as unknown as Read<GfManifestRow>);
  const gfManifest = new Map(manifests.data.filter(isGfReparto).map((m) => [m.id, m]));
  type Box = NonNullable<LimaPendingGf["box"]> & { current: boolean; withRider: boolean };
  const boxByShipment = new Map<string, Box>();
  for (const item of items.data) {
    const m = gfManifest.get(item.manifest_id);
    if (!m) continue;
    const day = m.route_date.slice(0, 10);
    const box: Box = { day, riderName: m.driver_name, officeChecked: Boolean(item.office_checked_at), pickedUp: Boolean(item.pickup_checked_at), current: isCurrentBoxDay(day, today), withRider: m.state === "in_custody" };
    // Una salida en dos cajas: la de hoy o de un día que viene gana.
    const seen = boxByShipment.get(item.shipment_id);
    if (!seen || (!seen.current && box.current)) boxByShipment.set(item.shipment_id, box);
  }
  const requestByOrder = new Map(requests.data.map((r) => [r.order_id, r]));
  const outputsByOrder = new Map<string, GfShipmentRow[]>();
  for (const s of shipments.data) outputsByOrder.set(s.order_id, [...(outputsByOrder.get(s.order_id) ?? []), s]);
  for (const row of candidates) {
    const outputs = (outputsByOrder.get(row.order_id) ?? [])
      .filter((s) => LIVE_OUTPUT.has(s.delivery_status ?? "") && !s.returned_at && s.custody_state !== "devuelto")
      .map((s) => ({ ...s, courier: s.courier ?? "", delivery_status: s.delivery_status ?? "" }));
    const live = outputsBlockingRetry(outputs);
    // Sale con otro courier (Aliclik, Swayp…): es de su lista, no de Grupo GF.
    if (live.some((s) => !GF_OUTPUT_COURIERS.has(s.courier))) continue;
    const request = requestByOrder.get(row.order_id) ?? null;
    const gfLive = live.filter((s) => GF_OUTPUT_COURIERS.has(s.courier)).sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""));
    // La salida de la solicitud manda; si no, la más nueva que sigue viva.
    const output = (request?.shipment_id ? gfLive.find((s) => s.id === request.shipment_id) : null) ?? gfLive[0] ?? null;
    const boxes = (output ? [output, ...gfLive] : gfLive).map((s) => boxByShipment.get(s.id)).filter((b): b is Box => Boolean(b));
    const current = boxes.find((b) => b.current) ?? null;
    if (!request && !current) {
      // Lo que la cola de Grupo GF manda a «Sin condiciones» no sale con Grupo GF.
      const orgId = storeOrg.get(row.store_id);
      const providerId = orgId ? providerByOrg.get(orgId) ?? null : null;
      if (!providerId) continue;
      const agreementId = agreementByStore.get(`${providerId}:${row.store_id}`) ?? null;
      if (gfDistrictBlock({ providerId, agreementId, district: row.district, day: today, tariffs: tariffRows, events })) continue;
      if (!isRetry(row)) {
        // Sin la «por definir» que rellena («sin salida»), o con otra salida ya
        // asignada («ya en caja»), la cola tampoco lo admite.
        const fillable = pickFillableRouteOutput(gfLive);
        const assigned = gfLive.find((s) => s.id !== fillable?.id);
        if (assigned || (row.macro_substage !== "por_generar_rotulo" && !fillable)) continue;
      }
    }
    out.set(row.order_id, {
      box: current && { day: current.day, riderName: current.riderName, officeChecked: current.officeChecked, pickedUp: current.pickedUp },
      requestDay: request?.scheduled_for?.slice(0, 10) ?? null,
      labeled: Boolean(output?.qr_token),
      armed: output?.preparation_state === "listo_despacho",
      ...(!current && boxes.length ? { pastBox: true } : {}),
      ...(!current && boxes.some((b) => b.withRider) ? { awaitingOffice: true } : {}),
    });
  }
  return out;
}

/** «AUTOECOM», «ALIDRIVER» o el nombre que dio Aliclik. */
export function aliclikTransportLabel(name: string | null | undefined): string | null {
  if (isAutoecom(name)) return "AUTOECOM";
  if (isAlidriver(name)) return "ALIDRIVER";
  return name?.trim() || null;
}

/**
 * El detalle del courier vigente de cada pedido, para el filtro «Courier» y la
 * fila (owner, 08-11-2026): con Aliclik, el transporte de su última guía
 * Aliclik; con Grupo GF, el motorizado de la última caja de su última salida
 * propia (la de un día posterior gana; en el mismo día, la que sigue activa).
 * Solo lee esos dos couriers; un error se muestra, no se adivina.
 */
async function loadCourierDetails(admin: Admin, rows: PendingMasterRow[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const ids = rows.filter((r) => r.current_courier === "aliclik" || r.current_courier === "propio").map((r) => r.order_id);
  if (!ids.length) return out;
  type DetailShipment = { id: string; order_id: string; courier: string | null; aliclik_transport_name: string | null; output_number: number | null; created_at: string | null };
  const shipments = await courierRowsByIds<DetailShipment>(ids, (chunk) => admin.from("shipments")
    .select("id,order_id,courier,aliclik_transport_name,output_number,created_at").in("order_id", chunk).in("courier", ["aliclik", "propio"]) as unknown as Read<DetailShipment>);
  const courierOf = new Map(rows.map((r) => [r.order_id, r.current_courier]));
  // La última salida del courier vigente: el consecutivo más alto, y si no, la más nueva.
  const latest = new Map<string, DetailShipment>();
  for (const s of shipments.data) {
    if (s.courier !== courierOf.get(s.order_id)) continue;
    const seen = latest.get(s.order_id);
    const newer = !seen || (s.output_number ?? 0) > (seen.output_number ?? 0)
      || ((s.output_number ?? 0) === (seen.output_number ?? 0) && (s.created_at ?? "") > (seen.created_at ?? ""));
    if (newer) latest.set(s.order_id, s);
  }
  const ownIds: string[] = [];
  for (const [orderId, s] of latest) {
    if (s.courier === "aliclik") {
      const label = aliclikTransportLabel(s.aliclik_transport_name);
      if (label) out.set(orderId, label);
    } else ownIds.push(s.id);
  }
  if (!ownIds.length) return out;
  type DetailItem = { shipment_id: string; manifest_id: string; removed_at: string | null };
  const items = await courierRowsByIds<DetailItem>(ownIds, (chunk) => admin.from("dispatch_manifest_items")
    .select("shipment_id,manifest_id,removed_at").in("shipment_id", chunk) as unknown as Read<DetailItem>);
  type DetailManifest = { id: string; route_date: string; driver_name: string | null; state: string | null };
  const manifests = await courierRowsByIds<DetailManifest>([...new Set(items.data.map((i) => i.manifest_id))], (chunk) => admin.from("dispatch_manifests")
    .select("id,route_date,driver_name,state").in("id", chunk) as unknown as Read<DetailManifest>);
  const manifestById = new Map(manifests.data.filter((m) => m.state !== "cancelled").map((m) => [m.id, m]));
  const orderOfShipment = new Map([...latest.values()].map((s) => [s.id, s.order_id]));
  const best = new Map<string, { day: string; active: boolean; rider: string }>();
  for (const item of items.data) {
    const m = manifestById.get(item.manifest_id);
    const orderId = orderOfShipment.get(item.shipment_id);
    const rider = m?.driver_name?.trim();
    if (!m || !orderId || !rider) continue;
    const day = m.route_date.slice(0, 10);
    const active = !item.removed_at;
    const seen = best.get(orderId);
    if (!seen || day > seen.day || (day === seen.day && active && !seen.active)) best.set(orderId, { day, active, rider });
  }
  for (const [orderId, b] of best) out.set(orderId, b.rider);
  return out;
}

interface PendingPickupRow {
  order_id: string; aliclik_expected_dispatch_date: string | null; aliclik_reported_dispatch_date: string | null;
}

/** Solo lectura, después de requireReproLima. Pagina todos los pedidos, sin
 * truncarlos a 1000 y sin cargar expedientes completos por cada fila. */
export async function loadLimaPending(admin: Admin, scope: ReproScope, now: Date = new Date()): Promise<LimaPendingOrder[]> {
  const ids = [...scope.storeIds];
  if (!ids.length) return [];
  const [orders, stores, programs] = await Promise.all([
    allCourierRows<PendingMasterRow>((from, to) => admin.from("order_master")
      .select("order_id,store_id,order_name,customer_name,customer_phone,district,order_total,order_created_at,macro_since,macro_stage,macro_substage,coverage,current_courier,dispatched_at,attempt_count,sales_channel,address,reference")
      .in("store_id", ids).eq("coverage", "lima").in("macro_stage", [...LIMA_PENDING_STAGES])
      .order("order_created_at", { ascending: false, nullsFirst: false }).order("order_id")
      .range(from, to) as unknown as PromiseLike<{ data: PendingMasterRow[] | null; error: { message: string } | null }>),
    courierRowsByIds(ids, (chunk) => admin.from("stores").select("id,name,org_id").in("id", chunk)),
    allCourierRows<PendingProgramRow>((from, to) => admin.from("gf_dispatch_programs")
      .select("order_id,store_id,scheduled_for").in("store_id", ids).order("order_id").range(from, to) as unknown as PromiseLike<{ data: PendingProgramRow[] | null; error: { message: string } | null }>),
  ]);
  const storeRows = stores.data as Array<{ id: string; name: string; org_id?: string | null }>;
  const names = new Map(storeRows.map((s) => [s.id, s.name]));
  const storeOrg = new Map(storeRows.filter((s) => s.org_id).map((s) => [s.id, s.org_id as string]));
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
  const [gfFacts, courierDetails] = await Promise.all([
    loadGfPlanFacts(admin, safe, storeOrg, limaClock(now).day),
    loadCourierDetails(admin, safe),
  ]);
  // La misma fuente de Grupo GF, en lotes de 500: una respuesta jamás puede
  // quedar truncada en 1000 y convertir salidas reales en «Nunca salieron».
  for (let offset = 0; offset < safeIds.length; offset += 500) {
    const { data, error } = await admin.rpc("gf_order_departures", { p_order_ids: safeIds.slice(offset, offset + 500) });
    if (error) throw new Error(`No pudimos leer el historial de salidas: ${error.message}`);
    for (const d of (data ?? []) as Array<{ order_id: string; last_departure_at: string }>) {
      if (orderStore.has(d.order_id) && d.last_departure_at) departures.set(d.order_id, d.last_departure_at);
    }
  }
  // Las guías Aliclik que esperan su recojo (owner, 07-11-2026): viva, sin
  // salida, sin reparto y sin retorno. Su día de recojo programa el pedido en
  // Repro Lima; sin esto caía en «Nunca salieron» como si nadie lo hubiera
  // gestionado. Mismos lotes de 500; un error se muestra, no se adivina.
  const pickups = new Map<string, string>();
  for (let offset = 0; offset < safeIds.length; offset += 500) {
    const { data, error } = await admin.from("shipments")
      .select("order_id,aliclik_expected_dispatch_date,aliclik_reported_dispatch_date")
      .in("order_id", safeIds.slice(offset, offset + 500))
      .eq("courier", "aliclik").eq("status_category", "pending")
      .not("delivery_status", "in", "(anulado,transferido)")
      .is("dispatched_at", null).is("out_for_delivery_at", null).is("returned_at", null);
    if (error) throw new Error(`No pudimos leer las guías de Aliclik: ${error.message}`);
    for (const g of (data ?? []) as PendingPickupRow[]) {
      const day = (g.aliclik_reported_dispatch_date ?? g.aliclik_expected_dispatch_date ?? "").slice(0, 10);
      if (!orderStore.has(g.order_id) || !day) continue;
      // Dos guías vivas a la vez no deberían existir; si existen, manda la más tardía.
      if ((pickups.get(g.order_id) ?? "") < day) pickups.set(g.order_id, day);
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
      courierDetail: courierDetails.get(row.order_id) ?? null,
      gf: gfFacts.get(row.order_id) ?? null,
      courierPickup: pickups.has(row.order_id) ? { courier: "aliclik", date: pickups.get(row.order_id)! } : null,
    };
  });
}
