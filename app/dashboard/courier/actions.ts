"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { randomUUID } from "node:crypto";
import { createAdminSupabase, createServerSupabase } from "@/lib/db";
import { getAdminOrgs, getCurrentUser } from "@/lib/access";
import { getMasterPermissions } from "@/lib/permissions-access";
import {
  resolveDistrictAvailability,
  resolveDistrictTariff,
  type DistrictAvailabilityEventRow,
  type DistrictTariffRow,
} from "@/lib/grupo-gf-courier";
import { loadGroupGfCourierRouteCheck } from "@/lib/grupo-gf-courier-route-access";
import { resolveLimaDistrict } from "@/lib/order-coverage";
import { recomputeOrderMasterSafe } from "@/lib/order-master";
import { writeCourierGuide } from "@/lib/route-output-fill";
import { manualRouteGuideCode, pickFillableRouteOutput } from "@/lib/shipment-output";
import { courierKey } from "@/lib/dispatch";
import { isGroupGfRiderCourier } from "@/lib/couriers/catalog";

const COURIER_PATH = "/dashboard/courier";
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface CourierActionResult {
  error?: string;
  notice?: string;
}

export interface CourierProviderRow {
  id: string;
  org_id: string;
  code: string;
  name: string;
  status: string;
  same_day_cutoff: string;
  cash_warning_amount: number;
  cash_limit_amount: number;
}

export interface CourierAgreementRow {
  id: string;
  store_id: string | null;
  client_label: string;
  status: string;
}

export interface PeruDistrictRow {
  district_key: string;
  district: string;
  province: string;
  department: string | null;
  order_count: number;
}

export interface CourierConfigSnapshot {
  provider: CourierProviderRow | null;
  agreements: CourierAgreementRow[];
  tariffs: DistrictTariffRow[];
  availabilityEvents: DistrictAvailabilityEventRow[];
  districts: PeruDistrictRow[];
  yapePercentage: number;
  canManageDispatch: boolean;
  operations: CourierOperationsSnapshot;
}

export interface CourierAvailableOrder {
  orderId: string;
  storeId: string;
  storeName: string;
  orderName: string;
  customerName: string;
  customerPhone: string | null;
  district: string;
  orderTotal: number;
  orderCreatedAt: string | null;
  agreementId: string;
  districtKey: string;
  tariffId: string;
  tariffAmount: number;
  scheduledFor: string;
  hasPriorDispatch: boolean;
  lastDispatchedAt: string | null;
}

export interface CourierAcceptedOrder extends Omit<
  CourierAvailableOrder,
  "hasPriorDispatch" | "lastDispatchedAt"
> {
  requestId: string;
  requestStatus: string;
  shipmentId: string | null;
  outputCode: string | null;
  preparationState: string | null;
  acceptedAt: string | null;
  observation: string | null;
  route: CourierRouteAssignment | null;
}

export interface CourierRouteAssignment {
  manifestId: string;
  routeDate: string;
  riderId: string | null;
  riderName: string;
  state: string;
  officeCheckedAt: string | null;
  pickupCheckedAt: string | null;
}

export interface CourierRouteSummary {
  manifestId: string;
  routeDate: string;
  riderId: string | null;
  riderName: string;
  state: string;
  assignedCount: number;
  armedCount: number;
  officeCheckedCount: number;
  pickupCheckedCount: number;
}

export interface CourierRiderOption {
  id: string;
  fullName: string;
}

export interface CourierOperationsSnapshot {
  available: CourierAvailableOrder[];
  accepted: CourierAcceptedOrder[];
  routes: CourierRouteSummary[];
  riders: CourierRiderOption[];
  blockedCount: number;
  sourceCount: number;
}

const EMPTY_OPERATIONS: CourierOperationsSnapshot = {
  available: [],
  accepted: [],
  routes: [],
  riders: [],
  blockedCount: 0,
  sourceCount: 0,
};

async function requireManager(
  orgId: string,
): Promise<{ userId: string; canManageDispatch: boolean } | { error: string }> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const [permissions, memberships] = await Promise.all([
    getMasterPermissions(),
    getAdminOrgs(),
  ]);
  if (!permissions.can("logistics.manage")) {
    return { error: "No tienes permiso para administrar Grupo GF Courier." };
  }
  if (!memberships.some((membership) => membership.org_id === orgId)) {
    return { error: "No perteneces a esta organización." };
  }
  return { userId: user.id, canManageDispatch: permissions.can("dispatch.manage") };
}

function amount(raw: unknown): number | null {
  const parsed = Number(String(raw ?? "").replace(",", "."));
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.round((parsed + Number.EPSILON) * 100) / 100;
}

function previousDay(day: string): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
}

function nextDay(day: string): string {
  return new Date(Date.parse(`${day}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
}

function limaClock(now = new Date()): { day: string; minute: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Lima",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    day: `${value.year}-${value.month}-${value.day}`,
    minute: Number(value.hour) * 60 + Number(value.minute),
  };
}

function cutoffMinute(value: string | null | undefined): number {
  const match = /^(\d{1,2}):(\d{2})/.exec(value ?? "");
  return match ? Number(match[1]) * 60 + Number(match[2]) : 11 * 60 + 30;
}

function scheduledDay(cutoff: string | null | undefined, now = new Date()): string {
  const current = limaClock(now);
  return current.minute <= cutoffMinute(cutoff) ? current.day : nextDay(current.day);
}

type OperationsConfig = {
  provider: CourierProviderRow;
  agreements: CourierAgreementRow[];
  tariffs: DistrictTariffRow[];
  availabilityEvents: DistrictAvailabilityEventRow[];
};

type QueueOrderRow = {
  order_id: string;
  store_id: string;
  order_name: string | null;
  customer_name: string | null;
  customer_phone: string | null;
  district: string | null;
  order_total: number | string | null;
  order_created_at: string | null;
  macro_stage: string;
  macro_substage: string;
};

type AdmissionShipmentRow = {
  id: string;
  order_id: string | null;
  courier: string;
  created_via: string | null;
  delivery_status: string;
  custody_state: string | null;
  custody_transferred_at: string | null;
  output_number: number | null;
  dispatched_at: string | null;
};

function isCourierAdmissionStage(stage: unknown, substage: unknown): boolean {
  return (
    (stage === "preparacion" && ["por_generar_rotulo", "por_armar"].includes(String(substage))) ||
    (stage === "por_despachar" && substage === "listo_para_asignar")
  );
}

function activeAssignedOutput(
  outputs: AdmissionShipmentRow[],
  fillableId: string | null,
): AdmissionShipmentRow | null {
  return outputs.find((output) =>
    output.id !== fillableId && ["pendiente", "en_ruta"].includes(output.delivery_status),
  ) ?? null;
}

function canonicalDistrictKey(value: string | null): string | null {
  let key = resolveLimaDistrict(value, { searchInText: true });
  if (key === "lurigancho chosica") key = "lurigancho";
  return key;
}

async function loadCourierOperations(
  admin: ReturnType<typeof createAdminSupabase>,
  config: OperationsConfig,
): Promise<CourierOperationsSnapshot> {
  const storeIds = config.agreements
    .map((agreement) => agreement.store_id)
    .filter((storeId): storeId is string => Boolean(storeId));
  if (!storeIds.length) return EMPTY_OPERATIONS;

  const day = limaClock().day;
  const [
    { data: stores },
    { data: queueRows, error: queueError, count: sourceCount },
    { data: requestRows, error: requestError },
    { data: riderRows },
  ] =
    await Promise.all([
      admin.from("stores").select("id,name").in("id", storeIds),
      admin
        .from("order_master")
        .select(
          "order_id,store_id,order_name,customer_name,customer_phone,district,order_total,order_created_at,macro_stage,macro_substage",
          { count: "exact" },
        )
        .in("store_id", storeIds)
        .or(
          "and(macro_stage.eq.preparacion,macro_substage.in.(por_generar_rotulo,por_armar)),and(macro_stage.eq.por_despachar,macro_substage.eq.listo_para_asignar)",
        )
        .eq("coverage", "lima")
        .order("order_created_at", { ascending: false })
        .limit(300),
      admin
        .from("logistics_requests")
        .select(
          "id,agreement_id,store_id,order_id,shipment_id,status,district_key,tariff_id,tariff_amount,currency,scheduled_for,accepted_at,observation",
        )
        .eq("provider_id", config.provider.id)
        .neq("status", "cancelled")
        .order("created_at", { ascending: false })
        .limit(300),
      admin
        .from("riders")
        .select("id,full_name,courier")
        .eq("org_id", config.provider.org_id)
        .eq("active", true)
        .order("full_name"),
    ]);
  if (queueError) throw new Error(`No se pudo cargar Pedidos disponibles: ${queueError.message}`);
  if (requestError) {
    // Permite desplegar el código antes de aplicar 0138 sin convertir todo el
    // tarifario en una página 500. La bandeja queda vacía con una causa clara en
    // despliegue; tras la migración la lectura vuelve automáticamente.
    if (/logistics_requests/i.test(requestError.message)) return EMPTY_OPERATIONS;
    throw new Error(`No se pudieron cargar las solicitudes logísticas: ${requestError.message}`);
  }

  const queueOrderIds = ((queueRows ?? []) as QueueOrderRow[]).map((order) => order.order_id);
  const { data: admissionShipmentRows, error: admissionShipmentError } = queueOrderIds.length
    ? await admin
        .from("shipments")
        .select(
          "id,order_id,courier,created_via,delivery_status,custody_state,custody_transferred_at,output_number,dispatched_at",
        )
        .in("order_id", queueOrderIds)
        .limit(2_000)
    : { data: [], error: null };
  if (admissionShipmentError) {
    throw new Error(`No se pudo validar el historial de salidas: ${admissionShipmentError.message}`);
  }
  const shipmentsByOrder = new Map<string, AdmissionShipmentRow[]>();
  const lastDispatchByOrder = new Map<string, string>();
  for (const row of (admissionShipmentRows ?? []) as AdmissionShipmentRow[]) {
    if (!row.order_id) continue;
    shipmentsByOrder.set(row.order_id, [...(shipmentsByOrder.get(row.order_id) ?? []), row]);
    if (row.dispatched_at) {
      const current = lastDispatchByOrder.get(row.order_id);
      if (!current || row.dispatched_at > current) lastDispatchByOrder.set(row.order_id, row.dispatched_at);
    }
  }

  const storeName = new Map(
    ((stores ?? []) as { id: string; name: string }[]).map((store) => [store.id, store.name]),
  );
  const agreementByStore = new Map(
    config.agreements
      .filter((agreement) => agreement.store_id)
      .map((agreement) => [agreement.store_id as string, agreement]),
  );
  const activeOrderIds = new Set(
    ((requestRows ?? []) as { order_id: string }[]).map((request) => request.order_id),
  );
  let blockedCount = 0;
  const available: CourierAvailableOrder[] = [];

  for (const order of (queueRows ?? []) as QueueOrderRow[]) {
    if (activeOrderIds.has(order.order_id)) continue;
    const outputs = shipmentsByOrder.get(order.order_id) ?? [];
    const fillable = pickFillableRouteOutput(outputs);
    const assigned = activeAssignedOutput(outputs, fillable?.id ?? null);
    const needsExistingBox = order.macro_substage !== "por_generar_rotulo";
    if (assigned || (needsExistingBox && !fillable)) {
      blockedCount += 1;
      continue;
    }
    const agreement = agreementByStore.get(order.store_id);
    const districtKey = canonicalDistrictKey(order.district);
    if (!agreement || !districtKey) {
      blockedCount += 1;
      continue;
    }
    const tariff = resolveDistrictTariff(config.tariffs, {
      providerId: config.provider.id,
      agreementId: agreement.id,
      districtKey,
      day,
    });
    const availability = resolveDistrictAvailability(config.availabilityEvents, {
      providerId: config.provider.id,
      agreementId: agreement.id,
      districtKey,
      day,
    });
    if (tariff.kind === "missing" || availability.status === "paused") {
      blockedCount += 1;
      continue;
    }
    available.push({
      orderId: order.order_id,
      storeId: order.store_id,
      storeName: storeName.get(order.store_id) ?? agreement.client_label,
      orderName: order.order_name ?? "Pedido sin código",
      customerName: order.customer_name ?? "Cliente sin nombre",
      customerPhone: order.customer_phone,
      district: order.district ?? districtKey,
      orderTotal: Number(order.order_total ?? 0),
      orderCreatedAt: order.order_created_at,
      agreementId: agreement.id,
      districtKey,
      tariffId: tariff.tariff.id,
      tariffAmount: tariff.tariff.delivery_amount,
      scheduledFor: scheduledDay(config.provider.same_day_cutoff),
      hasPriorDispatch: lastDispatchByOrder.has(order.order_id),
      lastDispatchedAt: lastDispatchByOrder.get(order.order_id) ?? null,
    });
  }

  const requests = (requestRows ?? []) as Array<{
    id: string;
    agreement_id: string;
    store_id: string;
    order_id: string;
    shipment_id: string | null;
    status: string;
    district_key: string;
    tariff_id: string;
    tariff_amount: number | string;
    currency: string;
    scheduled_for: string;
    accepted_at: string | null;
    observation: string | null;
  }>;
  const requestOrderIds = [...new Set(requests.map((request) => request.order_id))];
  const shipmentIds = requests
    .map((request) => request.shipment_id)
    .filter((shipmentId): shipmentId is string => Boolean(shipmentId));
  const [{ data: acceptedOrders }, { data: shipments }, { data: manifestItems }] = await Promise.all([
    requestOrderIds.length
      ? admin
          .from("order_master")
          .select(
            "order_id,store_id,order_name,customer_name,customer_phone,district,order_total,order_created_at",
          )
          .in("order_id", requestOrderIds)
      : Promise.resolve({ data: [] }),
    shipmentIds.length
      ? admin
          .from("shipments")
          .select("id,output_code,preparation_state")
          .in("id", shipmentIds)
      : Promise.resolve({ data: [] }),
    shipmentIds.length
      ? admin
          .from("dispatch_manifest_items")
          .select("shipment_id,manifest_id,office_checked_at,pickup_checked_at")
          .in("shipment_id", shipmentIds)
          .is("removed_at", null)
      : Promise.resolve({ data: [] }),
  ]);
  const orderById = new Map(
    ((acceptedOrders ?? []) as QueueOrderRow[]).map((order) => [order.order_id, order]),
  );
  const shipmentById = new Map(
    ((shipments ?? []) as { id: string; output_code: string | null; preparation_state: string | null }[])
      .map((shipment) => [shipment.id, shipment]),
  );
  const manifestItemByShipment = new Map(
    ((manifestItems ?? []) as Array<{
      shipment_id: string;
      manifest_id: string;
      office_checked_at: string | null;
      pickup_checked_at: string | null;
    }>).map((item) => [item.shipment_id, item]),
  );
  const manifestIds = [...new Set([...manifestItemByShipment.values()].map((item) => item.manifest_id))];
  const { data: manifestRows } = manifestIds.length
    ? await admin
        .from("dispatch_manifests")
        .select("id,route_date,rider_id,driver_name,state")
        .in("id", manifestIds)
        .neq("state", "cancelled")
    : { data: [] };
  const manifestById = new Map(
    ((manifestRows ?? []) as Array<{
      id: string;
      route_date: string;
      rider_id: string | null;
      driver_name: string | null;
      state: string;
    }>).map((manifest) => [manifest.id, manifest]),
  );
  const accepted: CourierAcceptedOrder[] = requests.flatMap((request) => {
    const order = orderById.get(request.order_id);
    const agreement = config.agreements.find((item) => item.id === request.agreement_id);
    if (!order || !agreement) return [];
    const shipment = request.shipment_id ? shipmentById.get(request.shipment_id) : null;
    const manifestItem = request.shipment_id
      ? manifestItemByShipment.get(request.shipment_id) ?? null
      : null;
    const manifestId = manifestItem?.manifest_id ?? null;
    const manifest = manifestId ? manifestById.get(manifestId) ?? null : null;
    return [{
      orderId: request.order_id,
      storeId: request.store_id,
      storeName: storeName.get(request.store_id) ?? agreement.client_label,
      orderName: order.order_name ?? "Pedido sin código",
      customerName: order.customer_name ?? "Cliente sin nombre",
      customerPhone: order.customer_phone,
      district: order.district ?? request.district_key,
      orderTotal: Number(order.order_total ?? 0),
      orderCreatedAt: order.order_created_at,
      agreementId: request.agreement_id,
      districtKey: request.district_key,
      tariffId: request.tariff_id,
      tariffAmount: Number(request.tariff_amount),
      scheduledFor: request.scheduled_for,
      requestId: request.id,
      requestStatus: request.status,
      shipmentId: request.shipment_id,
      outputCode: shipment?.output_code ?? null,
      preparationState: shipment?.preparation_state ?? null,
      acceptedAt: request.accepted_at,
      observation: request.observation,
      route: manifest
        ? {
            manifestId: manifest.id,
            routeDate: manifest.route_date,
            riderId: manifest.rider_id,
            riderName: manifest.driver_name ?? "Motorizado sin nombre",
            state: manifest.state,
            officeCheckedAt: manifestItem?.office_checked_at ?? null,
            pickupCheckedAt: manifestItem?.pickup_checked_at ?? null,
          }
        : null,
    }];
  });

  const riders = ((riderRows ?? []) as Array<{
    id: string;
    full_name: string;
    courier: string | null;
  }>).filter((rider) => isGroupGfRiderCourier(rider.courier))
    .map((rider) => ({ id: rider.id, fullName: rider.full_name }));

  const routeById = new Map<string, CourierRouteSummary>();
  for (const order of accepted) {
    if (!order.route) continue;
    const current = routeById.get(order.route.manifestId) ?? {
      manifestId: order.route.manifestId,
      routeDate: order.route.routeDate,
      riderId: order.route.riderId,
      riderName: order.route.riderName,
      state: order.route.state,
      assignedCount: 0,
      armedCount: 0,
      officeCheckedCount: 0,
      pickupCheckedCount: 0,
    };
    current.assignedCount += 1;
    if (order.preparationState === "listo_despacho") current.armedCount += 1;
    if (order.route.officeCheckedAt) current.officeCheckedCount += 1;
    if (order.route.pickupCheckedAt) current.pickupCheckedCount += 1;
    routeById.set(order.route.manifestId, current);
  }
  const routes = [...routeById.values()].sort((a, b) =>
    b.routeDate.localeCompare(a.routeDate) || a.riderName.localeCompare(b.riderName, "es"),
  );

  return { available, accepted, routes, riders, blockedCount, sourceCount: sourceCount ?? available.length };
}

export async function loadCourierConfig(orgId: string): Promise<CourierConfigSnapshot> {
  const auth = await requireManager(orgId);
  if ("error" in auth) {
    return {
      provider: null,
      agreements: [],
      tariffs: [],
      availabilityEvents: [],
      districts: [],
      yapePercentage: 3.5,
      canManageDispatch: false,
      operations: EMPTY_OPERATIONS,
    };
  }
  const sb = await createServerSupabase();
  const admin = createAdminSupabase();
  const [{ data: providerData }, districtsResult] = await Promise.all([
    sb
      .from("logistics_providers")
      .select("id,org_id,code,name,status,same_day_cutoff,cash_warning_amount,cash_limit_amount")
      .eq("org_id", orgId)
      .eq("code", "grupo-gf-courier")
      .maybeSingle(),
    admin.rpc("courier_lima_districts", { p_org_id: orgId }),
  ]);
  if (districtsResult.error) {
    throw new Error(`No se pudo cargar el universo de distritos Lima: ${districtsResult.error.message}`);
  }
  const districtsData = districtsResult.data;
  const districts = ((districtsData ?? []) as Record<string, unknown>[]).map((row) => ({
    district_key: String(row.district_key),
    district: String(row.district),
    province: String(row.province),
    department: row.department == null ? null : String(row.department),
    order_count: Number(row.order_count ?? 0),
  })) satisfies PeruDistrictRow[];
  const provider = providerData as CourierProviderRow | null;
  if (!provider) {
    return {
      provider: null,
      agreements: [],
      tariffs: [],
      availabilityEvents: [],
      districts,
      yapePercentage: 3.5,
      canManageDispatch: auth.canManageDispatch,
      operations: EMPTY_OPERATIONS,
    };
  }

  const [
    { data: agreements },
    { data: tariffs },
    { data: availabilityEvents },
    { data: fee },
  ] = await Promise.all([
    sb
      .from("logistics_service_agreements")
      .select("id,store_id,client_label,status")
      .eq("provider_id", provider.id)
      .eq("status", "active")
      .order("client_label"),
    sb
      .from("logistics_district_tariffs")
      .select(
        "id,provider_id,agreement_id,district_key,zone,delivery_amount,rejection_amount,includes_igv,currency,effective_from,effective_to,status",
      )
      .eq("provider_id", provider.id)
      .order("effective_from", { ascending: false }),
    sb
      .from("logistics_district_availability_events")
      .select(
        "id,provider_id,agreement_id,district_key,action,reason,paused_until,created_by,created_at",
      )
      .eq("provider_id", provider.id)
      .order("created_at", { ascending: false }),
    sb
      .from("logistics_fee_rules")
      .select("percentage")
      .eq("provider_id", provider.id)
      .eq("kind", "yape_commission")
      .eq("status", "active")
      .is("agreement_id", null)
      .lte("effective_from", new Date().toISOString().slice(0, 10))
      .or(`effective_to.is.null,effective_to.gte.${new Date().toISOString().slice(0, 10)}`)
      .order("effective_from", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  const normalizedTariffs = ((tariffs ?? []) as Record<string, unknown>[]).map((row) => ({
    ...row,
    delivery_amount: Number(row.delivery_amount),
    rejection_amount: Number(row.rejection_amount),
  })) as DistrictTariffRow[];
  const normalizedAvailability = (availabilityEvents ?? []) as DistrictAvailabilityEventRow[];
  const normalizedAgreements = (agreements ?? []) as CourierAgreementRow[];
  const operations = await loadCourierOperations(admin, {
    provider,
    agreements: normalizedAgreements,
    tariffs: normalizedTariffs,
    availabilityEvents: normalizedAvailability,
  });

  return {
    provider,
    agreements: normalizedAgreements,
    tariffs: normalizedTariffs,
    availabilityEvents: normalizedAvailability,
    districts,
    yapePercentage: Number(fee?.percentage ?? 3.5),
    canManageDispatch: auth.canManageDispatch,
    operations,
  };
}

export interface TakeCourierOrdersResult extends CourierActionResult {
  accepted: Array<{ orderId: string; shipmentId: string; outputCode: string | null }>;
  alreadyAccepted: string[];
  failed: Array<{ orderId: string; error: string }>;
}

const MAX_TAKE_ORDERS = 50;

/**
 * Admite pedidos desde la bandeja del operador. Reservar primero la solicitud
 * hace de candado idempotente: un segundo clic ve la misma solicitud y no llega
 * a crear otra caja. La tarifa y la disponibilidad se vuelven a leer aquí.
 */
export async function takeGroupGfCourierOrders(
  orgId: string,
  orderIds: string[],
): Promise<TakeCourierOrdersResult> {
  const auth = await requireManager(orgId);
  if ("error" in auth) return { ...auth, accepted: [], alreadyAccepted: [], failed: [] };
  const uniqueOrderIds = [...new Set(orderIds.filter(Boolean))];
  if (!uniqueOrderIds.length) {
    return { error: "Selecciona al menos un pedido.", accepted: [], alreadyAccepted: [], failed: [] };
  }
  if (uniqueOrderIds.length > MAX_TAKE_ORDERS) {
    return {
      error: `Puedes tomar hasta ${MAX_TAKE_ORDERS} pedidos por tanda.`,
      accepted: [],
      alreadyAccepted: [],
      failed: [],
    };
  }

  const admin = createAdminSupabase();
  const accepted: TakeCourierOrdersResult["accepted"] = [];
  const alreadyAccepted: string[] = [];
  const failed: TakeCourierOrdersResult["failed"] = [];

  // Secuencial a propósito: cada admisión vuelve a comprobar la configuración
  // vigente y deja su propio resultado. Un pedido inválido no tumba la tanda.
  for (const orderId of uniqueOrderIds) {
    try {
      const { data: orderMaster, error: orderError } = await admin
        .from("order_master")
        .select("*")
        .eq("order_id", orderId)
        .maybeSingle();
      if (orderError || !orderMaster) {
        failed.push({ orderId, error: orderError?.message ?? "El pedido ya no está disponible." });
        continue;
      }
      const row = orderMaster as Record<string, unknown>;
      if (!isCourierAdmissionStage(row.macro_stage, row.macro_substage)) {
        failed.push({ orderId, error: "El pedido ya avanzó y salió de Pedidos disponibles." });
        continue;
      }

      const { data: outputRows, error: outputError } = await admin
        .from("shipments")
        .select(
          "id,order_id,courier,created_via,delivery_status,custody_state,custody_transferred_at,output_number,dispatched_at",
        )
        .eq("order_id", orderId);
      if (outputError) {
        failed.push({ orderId, error: outputError.message });
        continue;
      }
      const outputs = (outputRows ?? []) as AdmissionShipmentRow[];
      const fillable = pickFillableRouteOutput(outputs);
      const assigned = activeAssignedOutput(outputs, fillable?.id ?? null);
      const mayCreateOutput = row.macro_substage === "por_generar_rotulo";
      if (assigned) {
        failed.push({ orderId, error: "El pedido ya tiene una salida asignada a otro courier." });
        continue;
      }
      if (!mayCreateOutput && !fillable) {
        failed.push({ orderId, error: "La caja existente ya no está disponible para asignarla." });
        continue;
      }

      const check = await loadGroupGfCourierRouteCheck(admin, {
        store_id: String(row.store_id),
        region: row.region == null ? null : String(row.region),
        province: row.province == null ? null : String(row.province),
        district: row.district == null ? null : String(row.district),
      });
      if (
        !check.eligible ||
        !check.providerId ||
        !check.agreementId ||
        !check.districtKey ||
        !check.tariffId ||
        check.tariffAmount == null
      ) {
        failed.push({ orderId, error: check.reason });
        continue;
      }

      const scheduledFor = scheduledDay(check.sameDayCutoff);
      const requestId = randomUUID();
      const idempotencyKey = `kapta:${check.providerId}:${orderId}`;
      const requestInsert = await admin
        .from("logistics_requests")
        .insert({
          id: requestId,
          provider_id: check.providerId,
          agreement_id: check.agreementId,
          store_id: String(row.store_id),
          order_id: orderId,
          source: "kapta",
          external_reference: row.order_name == null ? null : String(row.order_name),
          idempotency_key: idempotencyKey,
          status: "accepting",
          district_key: check.districtKey,
          tariff_id: check.tariffId,
          tariff_amount: check.tariffAmount,
          currency: check.currency,
          includes_igv: true,
          scheduled_for: scheduledFor,
          requested_by: auth.userId,
          accepted_by: auth.userId,
        })
        .select("id")
        .single();
      if (requestInsert.error) {
        if (requestInsert.error.code === "23505") {
          alreadyAccepted.push(orderId);
          continue;
        }
        failed.push({ orderId, error: requestInsert.error.message });
        continue;
      }

      const { data: sourceOrder } = await admin
        .from("orders")
        .select("line_items")
        .eq("id", orderId)
        .maybeSingle();
      const lineItems = ((sourceOrder as {
        line_items?: Array<{ title?: string | null; quantity?: number | null }>;
      } | null)?.line_items ?? []);
      const product = lineItems
        .map((item) => `${item.title ?? "Producto"}${(item.quantity ?? 1) > 1 ? ` ×${item.quantity}` : ""}`)
        .join(" | ") || null;
      const newShipmentId = randomUUID();
      const guideCode = manualRouteGuideCode(
        row.order_name == null ? null : String(row.order_name),
        newShipmentId,
        "propio",
      );
      const acceptedAt = new Date().toISOString();
      const write = await writeCourierGuide(admin, orderId, {
        id: newShipmentId,
        store_id: String(row.store_id),
        courier: "propio",
        guide_code: guideCode,
        delivery_status: "pendiente",
        status_category: "pending",
        order_id: orderId,
        matched: true,
        match_method: "grupo_gf_courier",
        order_name: row.order_name ?? null,
        customer_name: row.customer_name ?? null,
        customer_phone: row.customer_phone ?? null,
        product,
        district: row.district ?? null,
        province: row.province ?? null,
        city: row.district ?? null,
        region: row.region ?? null,
        delivery_address: row.address ?? null,
        delivery_reference: row.reference ?? null,
        latitude: row.latitude ?? null,
        longitude: row.longitude ?? null,
        assigned_at: acceptedAt,
        next_followup_at: `${scheduledFor}T12:00:00-05:00`,
        preparation_state: "rotulo_generado",
        custody_state: "empresa",
        created_via: "grupo_gf_courier",
      }, { createIfMissing: mayCreateOutput });
      if ("error" in write) {
        await admin
          .from("logistics_requests")
          .update({ status: "observed", observation: write.error })
          .eq("id", requestId);
        await admin.from("logistics_request_events").insert({
          request_id: requestId,
          kind: "acceptance_failed",
          status: "observed",
          actor: auth.userId,
          note: write.error,
        });
        failed.push({ orderId, error: write.error });
        continue;
      }

      const labelUrl = `/api/pedidos/rotulos?ids=${write.shipmentId}`;
      const [{ data: shipment }, requestUpdate] = await Promise.all([
        admin
          .from("shipments")
          .update({ label_url: labelUrl })
          .eq("id", write.shipmentId)
          .select("output_code")
          .single(),
        admin
          .from("logistics_requests")
          .update({
            shipment_id: write.shipmentId,
            status: "accepted",
            accepted_at: acceptedAt,
            observation: null,
          })
          .eq("id", requestId),
      ]);
      if (requestUpdate.error) {
        await admin
          .from("logistics_requests")
          .update({ status: "observed", observation: requestUpdate.error.message })
          .eq("id", requestId);
        failed.push({ orderId, error: requestUpdate.error.message });
        continue;
      }

      const outputCode = (shipment as { output_code?: string | null } | null)?.output_code ?? write.outputCode;
      await Promise.all([
        admin.from("logistics_request_events").insert({
          request_id: requestId,
          kind: "accepted",
          status: "accepted",
          actor: auth.userId,
          note: write.filled
            ? "Se reutilizó la salida existente y su QR."
            : "Se creó la salida física de la solicitud.",
          payload: {
            shipmentId: write.shipmentId,
            outputCode,
            reusedOutput: write.filled,
            tariffAmount: check.tariffAmount,
            scheduledFor,
          },
        }),
        admin.from("order_events").insert({
          store_id: String(row.store_id),
          order_id: orderId,
          kind: "logistics_request_accepted",
          occurred_at: acceptedAt,
          actor: auth.userId,
          source: "grupo_gf_courier",
          courier: "propio",
          guide_code: guideCode,
          shipment_id: write.shipmentId,
          note: write.filled
            ? "Grupo GF Courier tomó el pedido y conservó el QR de la salida existente."
            : "Grupo GF Courier tomó el pedido desde Pedidos disponibles.",
          payload: {
            requestId,
            outputCode,
            reusedOutput: write.filled,
            tariffId: check.tariffId,
            tariffAmount: check.tariffAmount,
            districtKey: check.districtKey,
            scheduledFor,
          },
        }),
      ]);
      await recomputeOrderMasterSafe(admin, [orderId]);
      accepted.push({ orderId, shipmentId: write.shipmentId, outputCode: outputCode ?? null });
    } catch (error) {
      failed.push({ orderId, error: error instanceof Error ? error.message : String(error) });
    }
  }

  revalidatePath(COURIER_PATH);
  revalidatePath("/dashboard/pedidos");
  revalidatePath("/dashboard/pedidos/almacen");
  const messages: string[] = [];
  if (accepted.length) {
    messages.push(
      `${accepted.length} pedido${accepted.length === 1 ? "" : "s"} tomado${accepted.length === 1 ? "" : "s"}. Almacén ${accepted.length === 1 ? "lo armará" : "los armará"} o conservará el armado que ya tenían.`,
    );
  }
  if (alreadyAccepted.length) {
    messages.push(`${alreadyAccepted.length} ya ${alreadyAccepted.length === 1 ? "estaba" : "estaban"} tomado${alreadyAccepted.length === 1 ? "" : "s"}; no se duplicó nada.`);
  }
  if (failed.length) messages.push(`${failed.length} no ${failed.length === 1 ? "pudo" : "pudieron"} tomarse.`);
  const error = !accepted.length && !alreadyAccepted.length && failed.length
    ? failed.length === 1
      ? failed[0]!.error
      : `No se pudieron tomar ${failed.length} pedidos. Revisa tarifa, distrito o estado.`
    : undefined;
  return { notice: messages.join(" ") || undefined, error, accepted, alreadyAccepted, failed };
}

export interface AssignCourierRouteResult extends CourierActionResult {
  assigned: number;
  manifestIds: string[];
  failed: Array<{ requestId: string; error: string }>;
}

const MAX_ASSIGN_ORDERS = 100;

/**
 * Coloca solicitudes ya tomadas en la caja/ruta diaria del motorizado.
 *
 * Planificar no certifica el armado: el paquete puede seguir en la cola de
 * Almacén. La evidencia física nace después, cuando oficina coteja uno por uno
 * los QR que efectivamente entraron en la caja del motorizado (MOM §18 y §29.2).
 */
export async function assignGroupGfCourierRoute(
  orgId: string,
  riderId: string,
  requestIds: string[],
): Promise<AssignCourierRouteResult> {
  const auth = await requireManager(orgId);
  if ("error" in auth) return { ...auth, assigned: 0, manifestIds: [], failed: [] };
  if (!auth.canManageDispatch) {
    return {
      error: "No tienes permiso para organizar rutas.",
      assigned: 0,
      manifestIds: [],
      failed: [],
    };
  }
  const unique = [...new Set(requestIds.filter(Boolean))];
  if (!unique.length) {
    return { error: "Selecciona al menos un pedido.", assigned: 0, manifestIds: [], failed: [] };
  }
  if (unique.length > MAX_ASSIGN_ORDERS) {
    return {
      error: `Puedes asignar hasta ${MAX_ASSIGN_ORDERS} pedidos por tanda.`,
      assigned: 0,
      manifestIds: [],
      failed: [],
    };
  }

  const admin = createAdminSupabase();
  const [{ data: provider }, { data: rider }] = await Promise.all([
    admin
      .from("logistics_providers")
      .select("id")
      .eq("org_id", orgId)
      .eq("code", "grupo-gf-courier")
      .eq("status", "active")
      .maybeSingle(),
    admin
      .from("riders")
      .select("id,full_name,courier")
      .eq("id", riderId)
      .eq("org_id", orgId)
      .eq("active", true)
      .maybeSingle(),
  ]);
  if (!provider) {
    return { error: "Grupo GF Courier no está activo.", assigned: 0, manifestIds: [], failed: [] };
  }
  if (!rider) {
    return { error: "El motorizado ya no está disponible.", assigned: 0, manifestIds: [], failed: [] };
  }
  if (!isGroupGfRiderCourier(rider.courier)) {
    return {
      error: `${rider.full_name} pertenece a otro courier.`,
      assigned: 0,
      manifestIds: [],
      failed: [],
    };
  }

  const { data: requestRows, error: requestError } = await admin
    .from("logistics_requests")
    .select("id,order_id,store_id,shipment_id,status,scheduled_for")
    .eq("provider_id", provider.id)
    .in("id", unique)
    .neq("status", "cancelled");
  if (requestError) {
    return { error: requestError.message, assigned: 0, manifestIds: [], failed: [] };
  }
  type AssignableRequest = {
    id: string;
    order_id: string;
    store_id: string;
    shipment_id: string | null;
    status: string;
    scheduled_for: string;
  };
  const requests = (requestRows ?? []) as AssignableRequest[];
  const requestById = new Map(requests.map((request) => [request.id, request]));
  const failed: AssignCourierRouteResult["failed"] = unique
    .filter((id) => !requestById.has(id))
    .map((requestId) => ({ requestId, error: "La solicitud ya no está disponible." }));
  const shipmentIds = requests
    .map((request) => request.shipment_id)
    .filter((shipmentId): shipmentId is string => Boolean(shipmentId));
  const [{ data: shipments }, { data: activeItems }] = await Promise.all([
    shipmentIds.length
      ? admin
          .from("shipments")
          .select("id,courier,custody_state")
          .in("id", shipmentIds)
      : Promise.resolve({ data: [] }),
    shipmentIds.length
      ? admin
          .from("dispatch_manifest_items")
          .select("shipment_id,manifest_id")
          .in("shipment_id", shipmentIds)
          .is("removed_at", null)
      : Promise.resolve({ data: [] }),
  ]);
  const shipmentById = new Map(
    ((shipments ?? []) as Array<{ id: string; courier: string; custody_state: string | null }>)
      .map((shipment) => [shipment.id, shipment]),
  );
  const activeManifestByShipment = new Map(
    ((activeItems ?? []) as Array<{ shipment_id: string; manifest_id: string }>)
      .map((item) => [item.shipment_id, item.manifest_id]),
  );

  const groups = new Map<string, AssignableRequest[]>();
  for (const request of requests) {
    if (!request.shipment_id) {
      failed.push({ requestId: request.id, error: "La solicitud todavía no tiene salida física." });
      continue;
    }
    const shipment = shipmentById.get(request.shipment_id);
    if (!shipment) {
      failed.push({ requestId: request.id, error: "No se encontró la salida física." });
      continue;
    }
    if (shipment.custody_state !== "empresa") {
      failed.push({ requestId: request.id, error: "El paquete ya no está en custodia de Grupo GF." });
      continue;
    }
    if (courierKey(shipment.courier) !== "propio") {
      failed.push({ requestId: request.id, error: "La salida pertenece a otro courier." });
      continue;
    }
    if (activeManifestByShipment.has(request.shipment_id)) {
      failed.push({ requestId: request.id, error: "El paquete ya está asignado a una ruta." });
      continue;
    }
    if (!DATE_RE.test(request.scheduled_for)) {
      failed.push({ requestId: request.id, error: "La fecha prevista no es válida." });
      continue;
    }
    groups.set(request.scheduled_for, [...(groups.get(request.scheduled_for) ?? []), request]);
  }

  let assigned = 0;
  const manifestIds: string[] = [];
  const changedOrderIds = new Set<string>();
  for (const [routeDate, group] of groups) {
    let { data: manifest } = await admin
      .from("dispatch_manifests")
      .select("id,state")
      .eq("org_id", orgId)
      .eq("route_date", routeDate)
      .eq("rider_id", rider.id)
      .neq("state", "cancelled")
      .maybeSingle();
    if (!manifest) {
      const created = await admin
        .from("dispatch_manifests")
        .insert({
          org_id: orgId,
          courier: "propio",
          kind: "reparto",
          route_date: routeDate,
          route_label: rider.full_name,
          rider_id: rider.id,
          driver_name: rider.full_name,
          created_by: auth.userId,
        })
        .select("id,state")
        .single();
      if (created.error) {
        for (const request of group) failed.push({ requestId: request.id, error: created.error.message });
        continue;
      }
      manifest = created.data;
      await admin.from("dispatch_events").insert({
        org_id: orgId,
        manifest_id: manifest.id,
        actor: auth.userId,
        kind: "manifest_created",
        payload: { source: "grupo_gf_courier", riderId: rider.id, routeDate },
      });
    }
    if (manifest.state !== "draft") {
      const message = "La caja de esa ruta ya inició el cotejo. No se pueden mezclar paquetes nuevos en este manifiesto.";
      for (const request of group) failed.push({ requestId: request.id, error: message });
      continue;
    }
    manifestIds.push(manifest.id);

    for (const request of group) {
      const shipmentId = request.shipment_id as string;
      const inserted = await admin.from("dispatch_manifest_items").insert({
        manifest_id: manifest.id,
        shipment_id: shipmentId,
        store_id: request.store_id,
        added_by: auth.userId,
      });
      if (inserted.error) {
        failed.push({
          requestId: request.id,
          error: inserted.error.code === "23505"
            ? "El paquete ya fue asignado a otra ruta."
            : inserted.error.message,
        });
        continue;
      }
      const occurredAt = new Date().toISOString();
      await Promise.all([
        admin
          .from("logistics_requests")
          .update({ status: "scheduled", observation: null })
          .eq("id", request.id),
        admin.from("dispatch_events").insert({
          org_id: orgId,
          manifest_id: manifest.id,
          shipment_id: shipmentId,
          actor: auth.userId,
          kind: "package_added",
          payload: { source: "grupo_gf_courier", requestId: request.id, riderId: rider.id },
        }),
        admin.from("logistics_request_events").insert({
          request_id: request.id,
          kind: "route_scheduled",
          status: "scheduled",
          actor: auth.userId,
          note: `Asignado a la ruta diaria de ${rider.full_name}.`,
          payload: { manifestId: manifest.id, riderId: rider.id, routeDate },
        }),
        admin.from("order_events").insert({
          store_id: request.store_id,
          order_id: request.order_id,
          kind: "dispatch_route_assigned",
          occurred_at: occurredAt,
          actor: auth.userId,
          source: "grupo_gf_courier",
          courier: "propio",
          shipment_id: shipmentId,
          note: `Paquete asignado a la ruta diaria de ${rider.full_name}; el armado de Almacén continúa de forma independiente.`,
          payload: { manifestId: manifest.id, riderId: rider.id, routeDate, requestId: request.id },
        }),
      ]);
      changedOrderIds.add(request.order_id);
      assigned += 1;
    }
  }

  if (changedOrderIds.size) await recomputeOrderMasterSafe(admin, [...changedOrderIds]);
  revalidatePath(COURIER_PATH);
  revalidatePath("/dashboard/pedidos/despacho");
  revalidatePath("/dashboard/pedidos");
  return {
    notice: assigned
      ? `${assigned} pedido${assigned === 1 ? "" : "s"} asignado${assigned === 1 ? "" : "s"} a la ruta diaria de ${rider.full_name}. Almacén puede terminar el armado en paralelo.`
      : undefined,
    error: assigned ? undefined : failed[0]?.error ?? "No se pudo asignar ningún pedido.",
    assigned,
    manifestIds: [...new Set(manifestIds)],
    failed,
  };
}

export async function activateGroupGfCourier(orgId: string): Promise<CourierActionResult> {
  const auth = await requireManager(orgId);
  if ("error" in auth) return auth;
  const admin = createAdminSupabase();

  let { data: provider } = await admin
    .from("logistics_providers")
    .select("id")
    .eq("org_id", orgId)
    .eq("code", "grupo-gf-courier")
    .maybeSingle();
  if (!provider) {
    const created = await admin
      .from("logistics_providers")
      .insert({
        org_id: orgId,
        code: "grupo-gf-courier",
        name: "Grupo GF Courier",
        legal_name: "Grupo GF",
        coverage_note: "Lima Metropolitana y Callao",
        same_day_cutoff: "11:30",
        cash_warning_amount: 4000,
        cash_limit_amount: 5000,
        created_by: auth.userId,
      })
      .select("id")
      .single();
    if (created.error) return { error: created.error.message };
    provider = created.data;
  }

  const { data: stores, error: storesError } = await admin
    .from("stores")
    .select("id,name")
    .eq("org_id", orgId)
    .eq("status", "active");
  if (storesError) return { error: storesError.message };
  for (const store of stores ?? []) {
    const { data: existing, error: agreementLookupError } = await admin
      .from("logistics_service_agreements")
      .select("id")
      .eq("provider_id", provider.id)
      .eq("store_id", store.id)
      .eq("status", "active")
      .maybeSingle();
    if (agreementLookupError) return { error: agreementLookupError.message };
    if (!existing) {
      const { error: agreementError } = await admin.from("logistics_service_agreements").insert({
        provider_id: provider.id,
        client_org_id: orgId,
        store_id: store.id,
        client_label: store.name,
        assignment_mode: "direct",
        settlement_frequency: "daily",
        same_day_cutoff: "11:30",
        coverage_note: "Lima Metropolitana y Callao",
        created_by: auth.userId,
      });
      if (agreementError) return { error: agreementError.message };
    }
  }

  const { data: fee, error: feeLookupError } = await admin
    .from("logistics_fee_rules")
    .select("id")
    .eq("provider_id", provider.id)
    .eq("kind", "yape_commission")
    .eq("status", "active")
    .is("agreement_id", null)
    .maybeSingle();
  if (feeLookupError) return { error: feeLookupError.message };
  if (!fee) {
    const { error: feeError } = await admin.from("logistics_fee_rules").insert({
      provider_id: provider.id,
      kind: "yape_commission",
      percentage: 3.5,
      created_by: auth.userId,
      note: "Comisión general de Grupo GF sobre el importe efectivamente recibido por Yape.",
    });
    if (feeError) return { error: feeError.message };
  }

  const { data: pool, error: poolLookupError } = await admin
    .from("inventory_pools")
    .select("id")
    .eq("custodian_provider_id", provider.id)
    .eq("code", "proveeduria-grupo-gf")
    .maybeSingle();
  if (poolLookupError) return { error: poolLookupError.message };
  let poolId = pool?.id as string | undefined;
  if (!poolId) {
    const createdPool = await admin
      .from("inventory_pools")
      .insert({
        custodian_provider_id: provider.id,
        owner_org_id: orgId,
        code: "proveeduria-grupo-gf",
        name: "Proveeduría Grupo GF",
        owner_label: "Grupo GF",
        strict_control: false,
        created_by: auth.userId,
      })
      .select("id")
      .single();
    if (createdPool.error) return { error: createdPool.error.message };
    poolId = createdPool.data?.id as string | undefined;
  }
  if (poolId && stores?.length) {
    const { error: accessError } = await admin.from("inventory_pool_store_access").upsert(
      stores.map((store) => ({
        pool_id: poolId,
        store_id: store.id,
        active: true,
        created_by: auth.userId,
      })),
      { onConflict: "pool_id,store_id" },
    );
    if (accessError) return { error: accessError.message };
  }

  revalidatePath(COURIER_PATH);
  return { notice: "Grupo GF Courier quedó activado con Yape 3.5 % y contratos para las tiendas activas." };
}

export interface DistrictTariffInput {
  orgId: string;
  providerId: string;
  agreementId?: string | null;
  districtKey: string;
  zone?: string | null;
  deliveryAmount: number | string;
  effectiveFrom: string;
}

export async function saveDistrictTariff(
  input: DistrictTariffInput,
): Promise<CourierActionResult> {
  const auth = await requireManager(input.orgId);
  if ("error" in auth) return auth;
  const delivery = amount(input.deliveryAmount);
  if (delivery == null) return { error: "Completa la tarifa." };
  if (!DATE_RE.test(input.effectiveFrom)) return { error: "Fecha de vigencia inválida." };
  const admin = createAdminSupabase();

  const { data: provider } = await admin
    .from("logistics_providers")
    .select("id")
    .eq("id", input.providerId)
    .eq("org_id", input.orgId)
    .maybeSingle();
  if (!provider) return { error: "Operador no válido." };
  if (input.agreementId) {
    const { data: agreement } = await admin
      .from("logistics_service_agreements")
      .select("id")
      .eq("id", input.agreementId)
      .eq("provider_id", input.providerId)
      .maybeSingle();
    if (!agreement) return { error: "Contrato de tienda no válido." };
  }
  // La misma fuente que dibuja la matriz debe autorizar el guardado. El
  // catálogo histórico peru_districts conserva variantes como `LIMA`,
  // `Lima (Metropolitana)` y `Lima (departamento)`; compararlas literalmente
  // hacía que filas visibles como San Miguel no pudieran guardarse.
  const { data: courierDistricts, error: districtError } = await admin.rpc(
    "courier_lima_districts",
    { p_org_id: input.orgId },
  );
  if (districtError) return { error: `No se pudo validar el distrito: ${districtError.message}` };
  const districtExists = ((courierDistricts ?? []) as Record<string, unknown>[]).some(
    (row) => String(row.district_key) === input.districtKey,
  );
  if (!districtExists) {
    return { error: "El distrito no pertenece a la matriz Lima Metropolitana y Callao." };
  }

  let currentQuery = admin
    .from("logistics_district_tariffs")
    .select("id,effective_from")
    .eq("provider_id", input.providerId)
    .eq("district_key", input.districtKey)
    .eq("status", "active")
    .is("effective_to", null);
  currentQuery = input.agreementId
    ? currentQuery.eq("agreement_id", input.agreementId)
    : currentQuery.is("agreement_id", null);
  const { data: current } = await currentQuery.maybeSingle();
  if (current && current.effective_from >= input.effectiveFrom) {
    return {
      error: `La tarifa vigente comenzó el ${current.effective_from}. El cambio debe iniciar después para conservar el historial.`,
    };
  }
  if (current) {
    const { error } = await admin
      .from("logistics_district_tariffs")
      .update({ effective_to: previousDay(input.effectiveFrom) })
      .eq("id", current.id);
    if (error) return { error: error.message };
  }

  const { error } = await admin.from("logistics_district_tariffs").insert({
    provider_id: input.providerId,
    agreement_id: input.agreementId || null,
    district_key: input.districtKey,
    zone: input.zone?.trim() || null,
    delivery_amount: delivery,
    rejection_amount: delivery,
    includes_igv: true,
    effective_from: input.effectiveFrom,
    created_by: auth.userId,
  });
  if (error) return { error: error.message };

  revalidatePath(COURIER_PATH);
  return { notice: "Tarifa guardada. La vigencia anterior quedó conservada." };
}

export interface DistrictAvailabilityInput {
  orgId: string;
  providerId: string;
  agreementId?: string | null;
  districtKey: string;
  status: "available" | "paused";
  reason?: string | null;
  pausedUntil?: string | null;
}

function todayInLima(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Lima",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

export async function setDistrictAvailability(
  input: DistrictAvailabilityInput,
): Promise<CourierActionResult> {
  const auth = await requireManager(input.orgId);
  if ("error" in auth) return auth;
  const reason = input.reason?.trim() || null;
  const pausedUntil = input.pausedUntil?.trim() || null;
  const day = todayInLima();
  if (input.status === "paused" && (!reason || reason.length < 4)) {
    return { error: "Escribe un motivo de al menos 4 caracteres para pausar el distrito." };
  }
  if (pausedUntil && (!DATE_RE.test(pausedUntil) || pausedUntil < day)) {
    return { error: "La reactivación debe ser hoy o una fecha posterior." };
  }

  const admin = createAdminSupabase();
  const { data: provider } = await admin
    .from("logistics_providers")
    .select("id")
    .eq("id", input.providerId)
    .eq("org_id", input.orgId)
    .maybeSingle();
  if (!provider) return { error: "Operador no válido." };
  if (input.agreementId) {
    const { data: agreement } = await admin
      .from("logistics_service_agreements")
      .select("id")
      .eq("id", input.agreementId)
      .eq("provider_id", input.providerId)
      .eq("status", "active")
      .maybeSingle();
    if (!agreement) return { error: "Contrato de tienda no válido." };
  }

  const [{ data: courierDistricts, error: districtError }, eventsResult] = await Promise.all([
    admin.rpc("courier_lima_districts", { p_org_id: input.orgId }),
    admin
      .from("logistics_district_availability_events")
      .select(
        "id,provider_id,agreement_id,district_key,action,reason,paused_until,created_by,created_at",
      )
      .eq("provider_id", input.providerId)
      .eq("district_key", input.districtKey)
      .order("created_at", { ascending: false }),
  ]);
  if (districtError) return { error: `No se pudo validar el distrito: ${districtError.message}` };
  if (eventsResult.error) return { error: eventsResult.error.message };
  const districtExists = ((courierDistricts ?? []) as Record<string, unknown>[]).some(
    (row) => String(row.district_key) === input.districtKey,
  );
  if (!districtExists) {
    return { error: "El distrito no pertenece a la matriz Lima Metropolitana y Callao." };
  }

  const agreementId = input.agreementId || null;
  const resolution = resolveDistrictAvailability(
    (eventsResult.data ?? []) as DistrictAvailabilityEventRow[],
    {
      providerId: input.providerId,
      agreementId,
      districtKey: input.districtKey,
      day,
    },
  );
  if (input.status === "paused" && resolution.status === "paused") {
    return {
      error:
        resolution.source === "general" && agreementId != null
          ? "El distrito ya está pausado en el tarifario general. Reactívalo desde ese ámbito."
          : "El distrito ya está pausado.",
    };
  }
  if (input.status === "available") {
    if (resolution.status === "available") return { error: "El distrito ya está disponible." };
    if (resolution.source === "general" && agreementId != null) {
      return { error: "La pausa es general. Reactívala desde el tarifario General de Grupo GF." };
    }
  }

  const { error } = await admin.from("logistics_district_availability_events").insert({
    provider_id: input.providerId,
    agreement_id: agreementId,
    district_key: input.districtKey,
    action: input.status === "paused" ? "paused" : "reactivated",
    reason: input.status === "paused" ? reason : null,
    paused_until: input.status === "paused" ? pausedUntil : null,
    created_by: auth.userId,
  });
  if (error) return { error: error.message };

  revalidatePath(COURIER_PATH);
  return {
    notice:
      input.status === "paused"
        ? `Distrito pausado${pausedUntil ? ` hasta el ${pausedUntil}` : " hasta reactivación manual"}. Las rutas activas no cambian.`
        : "Distrito reactivado. Conserva la tarifa configurada.",
  };
}
