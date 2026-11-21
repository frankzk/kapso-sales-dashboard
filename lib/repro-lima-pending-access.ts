import type { createAdminSupabase } from "@/lib/db";
import type { ReproScope } from "@/lib/repro-lima-access";
import { allCourierRows, courierRowsByIds } from "@/lib/courier-flow";
import { buildRiderSuggestions, parseGfAssigned, RIDER_SHARE_DAYS, shownRiderSuggestion, type GfAssignedRider, type RiderShareRow } from "@/lib/lima-rider-suggest";
import { districtKey, isLimaPendingStage, LIMA_PENDING_STAGES, limaBoxNeverLeft, type LimaPendingGf, type LimaPendingOps, type LimaPendingOrder, type NeverLeftGuide } from "@/lib/repro-lima-pending";
import { isCurrentBoxDay } from "@/lib/dispatch-plan";
import { outputsBlockingRetry } from "@/lib/gf-retry";
import { gfDistrictBlock } from "@/lib/gf-district-check";
import { pickFillableRouteOutput } from "@/lib/shipment-output";
import { isAlidriver, isAutoecom } from "@/lib/aliclik-lima";
import type { DistrictAvailabilityEventRow, DistrictTariffRow } from "@/lib/grupo-gf-courier";
import { limaClock } from "@/lib/grupo-gf-courier";
import { loadLimaManagement } from "@/lib/lima-management-access";
import { GF_AUTO_GUIDE_REASON } from "@/lib/gf-auto-guide";
import { loadLimaReportedHistory } from "@/lib/lima-route-history-access";
import { gfRescheduleAfterIncident, type GfWebhookTimelineRow } from "@/lib/gf-reschedule";
import { isCustomerNovelty } from "@/lib/lima-stuck";

type Admin = ReturnType<typeof createAdminSupabase>;
interface PendingMasterRow {
  order_id: string; store_id: string; order_name: string | null;
  customer_name: string | null; customer_phone: string | null; district: string | null;
  order_total: number | string | null; order_created_at: string | null; macro_since: string | null;
  macro_stage: string; macro_substage: string | null; coverage: string | null;
  current_courier: string | null; dispatched_at: string | null; attempt_count: number | null;
  sales_channel: string | null; address: string | null; reference: string | null;
  dispatch_scheduled_on?: string | null;
  dispatch_courier?: string | null;
  dispatched_with?: string[] | null;
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
  guide_code?: string | null;
  out_for_delivery_at?: string | null;
}
interface GfItemRow { shipment_id: string; manifest_id: string; office_checked_at: string | null; pickup_checked_at: string | null }
interface GfManifestRow { id: string; route_date: string; driver_name: string | null; courier: string | null; kind: string | null; state: string | null }
interface GfRequestRow { order_id: string; shipment_id: string | null; scheduled_for: string | null; status: string }
type Read<T> = PromiseLike<{ data: T[] | null; error: { message: string } | null }>;

/** Las salidas que son de Grupo GF: la «por definir» que rellena y la propia. */
const GF_OUTPUT_COURIERS = new Set(["por_definir", "propio"]);
const LIVE_OUTPUT = new Set(["pendiente", "en_ruta"]);
const GF_SHIPMENT_COLUMNS = "id,order_id,courier,preparation_state,qr_token,delivery_status,created_at,reported_status,swayp_state,dispatched_at,out_for_delivery_at,closed_at,returned_at,updated_at,custody_state,output_number,created_via,custody_transferred_at,guide_code";
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
async function loadGfPlanFacts(admin: Admin, rows: PendingMasterRow[], storeOrg: ReadonlyMap<string, string>, today: string): Promise<{ gf: Map<string, LimaPendingGf>; ops: Map<string, LimaPendingOps>; history: Map<string, string[]> }> {
  const orgIds = [...new Set(storeOrg.values())];
  const out = new Map<string, LimaPendingGf>();
  const ops = new Map<string, LimaPendingOps>();
  const history = new Map<string, string[]>();
  const isRetry = (r: PendingMasterRow) => r.macro_stage === "en_curso" && r.macro_substage === "por_reprogramar_lima";
  const inCurso = new Set(rows.filter((r) => r.macro_stage === "en_curso" && !isRetry(r)).map((r) => r.order_id));
  const boxed = await ordersInCurrentGfBoxes(admin, inCurso, today);
  const candidates = rows.filter((r) => r.macro_stage === "preparacion" || r.macro_stage === "por_despachar" || isRetry(r) || boxed.has(r.order_id));
  // «Lima trabados» (§9.6) mira las salidas de lo que ya pasó Por confirmar:
  // la misma lectura de `shipments`, por `order_id` (índice), ampliada a lo
  // En curso que no está en una caja vigente. Nada por fila: lotes de ids.
  const operational = rows.filter((r) => r.macro_stage === "preparacion" || r.macro_stage === "por_despachar" || r.macro_stage === "en_curso");
  if (!operational.length) return { gf: out, ops, history };
  const orderIds = operational.map((r) => r.order_id);
  const [providers, shipments] = await Promise.all([
    // El proveedor de la organización de cada tienda, como el resto de Repro Lima.
    orgIds.length && candidates.length
      ? courierRowsByIds<{ id: string; org_id: string }>(orgIds, (chunk) => admin.from("logistics_providers")
        .select("id,org_id").eq("code", "grupo-gf-courier").in("org_id", chunk) as unknown as Read<{ id: string; org_id: string }>)
      : Promise.resolve({ data: [] as Array<{ id: string; org_id: string }> }),
    courierRowsByIds<GfShipmentRow>(orderIds, (chunk) => admin.from("shipments")
      .select(GF_SHIPMENT_COLUMNS).in("order_id", chunk) as unknown as Read<GfShipmentRow>),
  ]);
  const candidateIds = new Set(candidates.map((r) => r.order_id));
  const candidateOrderIds = [...candidateIds];
  const providerIds = providers.data.map((p) => p.id);
  const providerByOrg = new Map(providers.data.map((p) => [p.org_id, p.id]));
  const gfOrderIds = [...new Set(shipments.data.filter((s) => s.courier === "gf_courier" && LIVE_OUTPUT.has(s.delivery_status ?? "") && !s.returned_at && s.custody_state !== "devuelto").map((s) => s.order_id))];
  type GuideOrigin = { order_id: string; guide_code: string | null; reason: string | null; occurred_at: string };
  const [requests, items, agreements, tariffs, events, guideOrigins] = await Promise.all([
    providerIds.length
      ? courierRowsByIds<GfRequestRow>(candidateOrderIds, (chunk) => admin.from("logistics_requests")
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
    courierRowsByIds<GuideOrigin>(gfOrderIds, (chunk) => allCourierRows<GuideOrigin>((from, to) => admin.from("order_events")
      .select("order_id,guide_code,reason,occurred_at").in("order_id", chunk).eq("kind", "guide_registered").eq("courier", "gf_courier")
      .order("id").range(from, to) as unknown as Read<GuideOrigin>).then((data) => ({ data, error: null }))),
  ]);
  // Manda el último registro de ESA guía. Una creación manual posterior no
  // hereda el origen automático de una anterior con el mismo código.
  const latestOrigins = new Map<string, { at: number; automatic: boolean }>();
  for (const event of guideOrigins.data) {
    if (!event.guide_code) continue;
    const key = `${event.order_id}:${event.guide_code}`;
    const at = Date.parse(event.occurred_at);
    if (!Number.isFinite(at)) continue;
    const automatic = event.reason === GF_AUTO_GUIDE_REASON;
    const prior = latestOrigins.get(key);
    if (!prior || at > prior.at || (at === prior.at && !automatic)) latestOrigins.set(key, { at, automatic });
  }
  const automaticGuides = new Set([...latestOrigins].filter(([, origin]) => origin.automatic).map(([key]) => key));
  const agreementByStore = new Map(agreements.filter((a) => a.store_id).map((a) => [`${a.provider_id}:${a.store_id}`, a.id]));
  const tariffRows = tariffs.map((t) => ({ ...t, delivery_amount: Number(t.delivery_amount), rejection_amount: Number(t.rejection_amount) }));
  const manifests = await courierRowsByIds<GfManifestRow>([...new Set(items.data.map((i) => i.manifest_id))], (chunk) => admin.from("dispatch_manifests")
    .select("id,route_date,driver_name,courier,kind,state").in("id", chunk) as unknown as Read<GfManifestRow>);
  const gfManifest = new Map(manifests.data.filter(isGfReparto).map((m) => [m.id, m]));
  type Box = NonNullable<LimaPendingGf["box"]> & { current: boolean; withRider: boolean };
  const boxByShipment = new Map<string, Box>();
  const latestBoxByShipment = new Map<string, Box>();
  for (const item of items.data) {
    const m = gfManifest.get(item.manifest_id);
    if (!m) continue;
    const day = m.route_date.slice(0, 10);
    const box: Box = { day, riderName: m.driver_name, officeChecked: Boolean(item.office_checked_at), pickedUp: Boolean(item.pickup_checked_at), current: isCurrentBoxDay(day, today), withRider: m.state === "in_custody" };
    // Una salida en dos cajas: la de hoy o de un día que viene gana.
    const seen = boxByShipment.get(item.shipment_id);
    if (!seen || (!seen.current && box.current)) boxByShipment.set(item.shipment_id, box);
    const latest = latestBoxByShipment.get(item.shipment_id);
    if (!latest || latest.day < box.day) latestBoxByShipment.set(item.shipment_id, box);
  }
  const requestByOrder = new Map(requests.data.map((r) => [r.order_id, r]));
  const outputsByOrder = new Map<string, GfShipmentRow[]>();
  for (const s of shipments.data) outputsByOrder.set(s.order_id, [...(outputsByOrder.get(s.order_id) ?? []), s]);
  const historyIds = operational.filter((r) => {
    const outputs = outputsByOrder.get(r.order_id) ?? [];
    return !r.dispatched_with?.length && r.current_courier === "propio"
      && outputs.length > 0 && outputs.every((s) => s.courier === "propio");
  }).map((r) => r.order_id);
  const reportedHistory = await loadLimaReportedHistory(admin, historyIds);
  for (const [id, codes] of reportedHistory) history.set(id, codes);
  for (const row of operational) {
    const fact = opsFacts(outputsByOrder.get(row.order_id) ?? [], latestBoxByShipment, automaticGuides);
    if (fact) ops.set(row.order_id, fact);
  }
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
  return { gf: out, ops, history };
}

/** `DELIVERED` de Tanders o de Aliclik («DELIVERED · PICKED · CONFIRMED»): el courier dice que entregó. */
const COURIER_SAYS_DELIVERED = /^DELIVERED\b/i;

/**
 * Lo que «Lima trabados» (§9.6) necesita de las salidas de un pedido: las
 * vivas (como la cola de Grupo GF: `pendiente`/`en_ruta`, sin retorno ni
 * devolución), lo último que reportó el courier, si alguna ya la da por
 * entregada y su última caja de Grupo GF. Sin salidas, null.
 */
function opsFacts(outputs: readonly GfShipmentRow[], latestBox: ReadonlyMap<string, { day: string; riderName: string | null }>, automaticGuides: ReadonlySet<string>): LimaPendingOps | null {
  if (!outputs.length) return null;
  const live = outputs
    .filter((s) => LIVE_OUTPUT.has(s.delivery_status ?? "") && !s.returned_at && s.custody_state !== "devuelto")
    .sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""));
  const delivered = outputs.find((s) => !s.returned_at && (s.delivery_status === "entregado" ||
    (LIVE_OUTPUT.has(s.delivery_status ?? "") && COURIER_SAYS_DELIVERED.test((s.reported_status ?? "").trim()))));
  const box = live.map((s) => latestBox.get(s.id)).filter((b): b is { day: string; riderName: string | null } => Boolean(b))
    .sort((a, b) => b.day.localeCompare(a.day))[0] ?? null;
  const latest = [...outputs].sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""))[0]!;
  const current = live[0];
  return {
    pickupPending: Boolean(current && current.courier === "fenix" && current.swayp_state === 1
      && live.every((s) => s.courier === "fenix" && s.custody_state === "empresa"
        && !s.custody_transferred_at && !s.dispatched_at && !s.out_for_delivery_at)),
    returnedToWarehouse: !live.length && Boolean(latest.returned_at || latest.custody_state === "devuelto"),
    autoGfGuide: live.some((s) => s.courier === "gf_courier") && live.filter((s) => s.courier === "gf_courier").every((s) =>
      s.guide_code && automaticGuides.has(`${s.order_id}:${s.guide_code}`) && s.delivery_status === "pendiente"
      && !s.dispatched_at && !s.out_for_delivery_at && (s.custody_state == null || s.custody_state === "empresa")),
    custody: (current ?? latest).custody_state ?? null,
    guides: {
      total: outputs.filter((s) => s.guide_code?.trim() || s.qr_token).length,
      annulled: outputs.filter((s) => (s.guide_code?.trim() || s.qr_token) && s.delivery_status === "anulado").length,
      returned: outputs.filter((s) => (s.guide_code?.trim() || s.qr_token) && (s.returned_at || s.custody_state === "devuelto")).length,
      cancelRequested: outputs.filter((s) => s.courier === "gf_courier" && s.reported_status?.trim().toUpperCase() === "CANCEL_REQUESTED").length,
    },
    liveCouriers: [...new Set(live.map((s) => s.courier ?? "").filter(Boolean))],
    reportedStatus: live[0]?.reported_status?.trim() || null,
    gfGuide: live[0]?.courier === "gf_courier" ? live[0].guide_code?.trim() || null : null,
    courierDelivered: delivered ? { courier: delivered.courier ?? "" } : null,
    lastGfBox: box && { day: box.day, riderName: box.riderName },
  };
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
  order_id: string; courier: string | null; guide_code: string | null; delivery_status: string | null;
  aliclik_expected_dispatch_date: string | null; aliclik_reported_dispatch_date: string | null;
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * El día pedido a GF Courier para cada guía GF que todavía no salió
 * (`guides`: número de guía → pedido), por pedido: el `scheduled_date` de su
 * intención enviada (`gf_order_requests.request`, la misma que creó la guía).
 * Sin día pedido, no entra. Lotes de 500, como las demás lecturas; sin guías
 * GF, no pregunta.
 */
/** Quién lleva cada distrito de Lima en los últimos 30 días (0353), con la regla de `lib/lima-rider-suggest.ts`. */
async function loadRiderSuggestions(admin: Admin): Promise<Map<string, string[]>> {
  const { data, error } = await admin.rpc("lima_rider_district_share", { p_days: RIDER_SHARE_DAYS });
  if (error) throw new Error(error.message);
  return buildRiderSuggestions((data ?? []) as RiderShareRow[]);
}

/** El día de una guía de GF Courier que no salió: el pedido a GF o, sin él, la fecha estimada que GF devolvió. Pura. */
export function gfGuideDay(scheduled: string | null | undefined, estimated: string | null | undefined): string {
  const asked = (scheduled ?? "").slice(0, 10);
  return ISO_DAY.test(asked) ? asked : (estimated ?? "").slice(0, 10);
}

async function loadGfGuideDays(admin: Admin, guides: ReadonlyMap<string, string>): Promise<Map<string, string>> {
  const days = new Map<string, string>();
  const codes = [...guides.keys()];
  for (let offset = 0; offset < codes.length; offset += 500) {
    const { data, error } = await admin.from("gf_order_requests")
      .select("tracking_id,scheduled_date:request->>scheduled_date,estimated:response->>estimated_delivery_date")
      .in("tracking_id", codes.slice(offset, offset + 500))
      .eq("status", "sent");
    if (error) throw new Error(`No pudimos leer los días pedidos a GF Courier: ${error.message}`);
    for (const r of (data ?? []) as Array<{ tracking_id: string | null; scheduled_date: string | null; estimated: string | null }>) {
      const orderId = r.tracking_id ? guides.get(r.tracking_id) : undefined;
      // Sin día pedido (la guía GF automática de un pedido nuevo), la fecha
      // estimada que GF devolvió al crearla (owner, 17-11-2026): así el pedido
      // queda en Programados (Hoy, Mañana) y no «Con el courier» sin haber salido.
      const day = gfGuideDay(r.scheduled_date, r.estimated);
      if (!orderId || !ISO_DAY.test(day)) continue;
      // Dos guías GF vivas no deberían existir; si existen, manda la más tardía.
      if ((days.get(orderId) ?? "") < day) days.set(orderId, day);
    }
  }
  return days;
}

/**
 * El día en que GF Courier vuelve a sacar cada guía GF en novedad (`guides`:
 * número de guía → pedido), por pedido (owner, 21-11-2026, #KP207270): su último
 * cambio de fecha recibido después del último cambio de estado
 * (`gfRescheduleAfterIncident`). Lee solo los avisos de esas guías
 * (`gf_webhook_events_tracking_idx`), en lotes de 500 a la vez; sin guías, no pregunta.
 */
async function loadGfReschedules(admin: Admin, guides: ReadonlyMap<string, string>): Promise<Map<string, string>> {
  const rows = await inBatchesOf500([...guides.keys()], async (batch) => {
    const { data, error } = await admin.from("gf_webhook_events")
      .select("tracking_id,type,received_at,new_date:payload->data->>new_date")
      .in("tracking_id", batch)
      .in("type", ["order.status_changed", "order.delivery_date_changed"]);
    if (error) throw new Error(`No pudimos leer los avisos de GF Courier: ${error.message}`);
    return (data ?? []) as Array<GfWebhookTimelineRow & { tracking_id: string | null }>;
  });
  const byGuide = new Map<string, GfWebhookTimelineRow[]>();
  for (const r of rows) {
    if (!r.tracking_id) continue;
    byGuide.set(r.tracking_id, [...(byGuide.get(r.tracking_id) ?? []), r]);
  }
  const out = new Map<string, string>();
  for (const [guide, events] of byGuide) {
    const orderId = guides.get(guide);
    const reschedule = gfRescheduleAfterIncident(events);
    if (orderId && reschedule) out.set(orderId, reschedule.date);
  }
  return out;
}

/**
 * El motorizado que GF Courier ya asignó a cada guía GF que todavía no salió
 * (`guides`: número de guía → pedido), por pedido (owner, 17-11-2026: «agrega
 * el asignado»). Sale de la línea «GF Courier: asignado a …» que deja su
 * webhook (`parseGfAssigned`), solo la de ESA guía (una guía anterior no
 * cuenta) y la más reciente. Por pedido (índice `order_events_order_idx`), en
 * lotes de 200.
 */
async function loadGfAssigned(admin: Admin, guides: ReadonlyMap<string, string>): Promise<Map<string, GfAssignedRider>> {
  const out = new Map<string, GfAssignedRider>();
  const orderIds = [...new Set(guides.values())];
  for (let offset = 0; offset < orderIds.length; offset += 200) {
    const { data, error } = await admin.from("order_events")
      .select("order_id,guide_code,note,occurred_at")
      .in("order_id", orderIds.slice(offset, offset + 200))
      .eq("kind", "courier_report").eq("courier", "gf_courier")
      .ilike("note", "GF Courier: asignado a %")
      .order("occurred_at", { ascending: false });
    if (error) throw new Error(`No pudimos leer los motorizados asignados por GF Courier: ${error.message}`);
    for (const e of (data ?? []) as Array<{ order_id: string; guide_code: string | null; note: string | null }>) {
      if (out.has(e.order_id) || !e.guide_code || guides.get(e.guide_code) !== e.order_id) continue;
      const assigned = parseGfAssigned(e.note);
      if (assigned) out.set(e.order_id, assigned);
    }
  }
  return out;
}

/** Lotes de 500 a la vez (los pendientes de Lima son ~1.500: tres o cuatro
 *  lotes). Las filas salen en el orden de los lotes; el primer error corta. */
async function inBatchesOf500<T>(ids: readonly string[], read: (batch: string[]) => Promise<T[]>): Promise<T[]> {
  const batches: string[][] = [];
  for (let offset = 0; offset < ids.length; offset += 500) batches.push(ids.slice(offset, offset + 500));
  return (await Promise.all(batches.map(read))).flat();
}

/** Solo lectura, después de requireReproLima. Pagina todos los pedidos, sin
 * truncarlos a 1000 y sin cargar expedientes completos por cada fila. */
export async function loadLimaPending(admin: Admin, scope: ReproScope, now: Date = new Date()): Promise<LimaPendingOrder[]> {
  const ids = [...scope.storeIds];
  if (!ids.length) return [];
  const [orders, stores, programs] = await Promise.all([
    allCourierRows<PendingMasterRow>((from, to) => admin.from("order_master")
      .select("order_id,store_id,order_name,customer_name,customer_phone,district,order_total,order_created_at,macro_since,macro_stage,macro_substage,coverage,current_courier,dispatched_at,attempt_count,dispatched_with,sales_channel,address,reference,dispatch_scheduled_on,dispatch_courier")
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
  // UNA SOLA ESPERA para lo que no depende entre sí (owner, 21-11-2026: «anda
  // cargando súper lento»). Las salidas de Grupo GF y las guías por recoger
  // solo necesitan los ids, así que van junto a los hechos del plan, el detalle
  // del courier y la gestión, en vez de esperar a que terminen. Sus lotes de
  // 500 también van a la vez.
  const [{ gf: gfFacts, ops: stuckFacts, history }, courierDetails, riderSuggestions, management, departureRows, pickupRows] = await Promise.all([
    loadGfPlanFacts(admin, safe, storeOrg, limaClock(now).day),
    loadCourierDetails(admin, safe),
    // Best-effort (17-11-2026): sin la lectura, la fila no sugiere motorizado.
    loadRiderSuggestions(admin).catch(() => new Map<string, string[]>()),
    loadLimaManagement(admin, safeIds, new Map(safe.map((row) => [row.order_id, row.order_created_at]))),
    // La misma fuente de Grupo GF, en lotes de 500: una respuesta jamás puede
    // quedar truncada en 1000 y convertir salidas reales en «Nunca salieron».
    inBatchesOf500(safeIds, async (batch) => {
      const { data, error } = await admin.rpc("gf_order_departures", { p_order_ids: batch });
      if (error) throw new Error(`No pudimos leer el historial de salidas: ${error.message}`);
      return (data ?? []) as Array<{ order_id: string; last_departure_at: string }>;
    }),
    // Las guías Aliclik que esperan su recojo (owner, 07-11-2026): viva, sin
    // salida, sin reparto y sin retorno. Su día de recojo programa el pedido en
    // Repro Lima; sin esto caía en «Nunca salieron» como si nadie lo hubiera
    // gestionado. Un error se muestra, no se adivina. En la misma lectura, las
    // guías de GF Courier que todavía no salieron (15-11-2026).
    inBatchesOf500(safeIds, async (batch) => {
      const { data, error } = await admin.from("shipments")
        .select("order_id,courier,guide_code,delivery_status,aliclik_expected_dispatch_date,aliclik_reported_dispatch_date")
        .in("order_id", batch)
        .in("courier", ["aliclik", "gf_courier"]).eq("status_category", "pending")
        .not("delivery_status", "in", "(anulado,transferido)")
        .is("dispatched_at", null).is("out_for_delivery_at", null).is("returned_at", null);
      if (error) throw new Error(`No pudimos leer las guías de Aliclik y GF Courier: ${error.message}`);
      return (data ?? []) as PendingPickupRow[];
    }),
  ]);
  for (const d of departureRows) {
    if (orderStore.has(d.order_id) && d.last_departure_at) departures.set(d.order_id, d.last_departure_at);
  }
  const pickups = new Map<string, string>();
  const gfGuides = new Map<string, string>();
  for (const g of pickupRows) {
    if (g.courier === "gf_courier") {
      if (g.delivery_status === "pendiente" && g.guide_code && orderStore.has(g.order_id)) gfGuides.set(g.guide_code, g.order_id);
      continue;
    }
    const day = (g.aliclik_reported_dispatch_date ?? g.aliclik_expected_dispatch_date ?? "").slice(0, 10);
    if (!orderStore.has(g.order_id) || !day) continue;
    // Dos guías vivas a la vez no deberían existir; si existen, manda la más tardía.
    if ((pickups.get(g.order_id) ?? "") < day) pickups.set(g.order_id, day);
  }
  // «Por reprogramar Lima» cuya caja nunca salió (owner, 18-11-2026, #KP206971):
  // el courier anuló la guía antes de recogerla. Solo se miran los que no tienen
  // ninguna salida ni intento; un error se muestra, no se adivina. Va junto a
  // los días de las guías de GF Courier: ninguno depende del otro.
  const neverLeftCandidates = safe
    .filter((row) => row.macro_stage === "en_curso" && row.macro_substage === "por_reprogramar_lima"
      && !departures.has(row.order_id) && !row.dispatched_at && Number(row.attempt_count ?? 0) === 0)
    .map((row) => row.order_id);
  // La guía GF en novedad que GF volvió a programar (owner, 21-11-2026,
  // #KP207270): En curso, con la guía de GF Courier como salida viva más nueva y
  // una novedad con la clienta.
  const incidentGuides = new Map<string, string>();
  for (const row of safe) {
    const ops = stuckFacts.get(row.order_id);
    if (row.macro_stage === "en_curso" && ops?.gfGuide && isCustomerNovelty(ops.reportedStatus)) incidentGuides.set(ops.gfGuide, row.order_id);
  }
  const [gfPickups, gfAssigned, neverLeftRows, gfReschedules] = await Promise.all([
    loadGfGuideDays(admin, gfGuides),
    // Best-effort: sin la lectura, la fila no dice el asignado (y sigue sugiriendo).
    loadGfAssigned(admin, gfGuides).catch(() => new Map<string, GfAssignedRider>()),
    inBatchesOf500(neverLeftCandidates, async (batch) => {
      const { data, error } = await admin.from("shipments")
        .select("order_id,courier,delivery_status,custody_state,dispatched_at,out_for_delivery_at,returned_at")
        .in("order_id", batch);
      if (error) throw new Error(`No pudimos leer las guías de los pedidos que nunca salieron: ${error.message}`);
      return (data ?? []) as Array<NeverLeftGuide & { order_id: string }>;
    }),
    // Best-effort: sin la lectura, sigue como novedad del courier (lo de antes).
    loadGfReschedules(admin, incidentGuides).catch(() => new Map<string, string>()),
  ]);
  const neverLeftGuides = new Map<string, NeverLeftGuide[]>();
  for (const g of neverLeftRows) neverLeftGuides.set(g.order_id, [...(neverLeftGuides.get(g.order_id) ?? []), g]);
  const neverLeft = new Set(neverLeftCandidates.filter((id) => limaBoxNeverLeft(neverLeftGuides.get(id) ?? [])));
  return safe.map((row) => {
    // El filtro de arriba valida también la macroetapa de cada fila.
    const stage = row.macro_stage as LimaPendingOrder["stage"];
    const ops = stuckFacts.get(row.order_id) ?? null;
    const rescheduled = gfReschedules.get(row.order_id) ?? null;
    const courierPickup: LimaPendingOrder["courierPickup"] = pickups.has(row.order_id)
      ? { courier: "aliclik", date: pickups.get(row.order_id)! }
      : gfPickups.has(row.order_id) ? { courier: "gf_courier", date: gfPickups.get(row.order_id)! }
        // GF la vuelve a sacar con la misma guía el día que acordó: la guía espera ese día.
        : rescheduled ? { courier: "gf_courier", date: rescheduled } : null;
    return {
      orderId: row.order_id, storeId: row.store_id, storeName: names.get(row.store_id) ?? "Tienda",
      orderName: row.order_name ?? "Sin código", customerName: row.customer_name ?? "Sin nombre",
      customerPhone: row.customer_phone, district: row.district, orderTotal: Number(row.order_total ?? 0),
      createdAt: row.order_created_at, macroSince: row.macro_since, stage,
      substage: row.macro_substage, courier: row.current_courier, dispatchedAt: row.dispatched_at,
      attempts: Number(row.attempt_count ?? 0),
      dispatchedWith: history.get(row.order_id) ?? row.dispatched_with ?? [],
      ...(history.has(row.order_id) ? { historyFromRoutes: true } : {}),
      management: management.get(row.order_id),
      hasPriorDispatch: departures.has(row.order_id), lastDepartureAt: departures.get(row.order_id) ?? null,
      ...(neverLeft.has(row.order_id) ? { neverLeft: true } : {}),
      programmedFor: scheduled.get(row.order_id) ?? null,
      salesChannel: row.sales_channel ?? null,
      address: row.address?.trim() || null, reference: row.reference?.trim() || null,
      courierDetail: courierDetails.get(row.order_id) ?? null,
      gf: gfFacts.get(row.order_id) ?? null,
      scheduledOn: row.dispatch_scheduled_on?.slice(0, 10) ?? null,
      scheduledCourier: row.dispatch_courier ?? null,
      ops,
      courierPickup,
      gfRescheduled: rescheduled ? { date: rescheduled } : null,
      // El que GF ya asignó a su guía viva (17-11-2026). Con asignado, ya no se sugiere.
      gfAssigned: gfAssigned.get(row.order_id) ?? null,
      // Solo con guía de GF Courier sin motorizado (17-11-2026): la fila lee esto; el filtro «Motorizado», esto o el asignado.
      suggestedRiders: gfAssigned.has(row.order_id) ? null : shownRiderSuggestion({ ops, courierPickup }, riderSuggestions.get(districtKey(row.district))),
    };
  });
}
