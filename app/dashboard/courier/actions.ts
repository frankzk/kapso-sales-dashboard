"use server";

import { cancelledScanNotice } from "@/lib/scan-cancelled";
import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { redirect } from "next/navigation";
import { randomUUID } from "node:crypto";
import { createAdminSupabase, createServerSupabase } from "@/lib/db";
import { getAccessibleStores, getAdminOrgs, getCurrentUser } from "@/lib/access";
import { getDispatchWorkspaceData, type DispatchWorkspaceData } from "@/lib/dispatch-access";
import { getMasterPermissions } from "@/lib/permissions-access";
import {
  resolveDistrictAvailability,
  resolveDistrictTariff,
  type DistrictAvailabilityEventRow,
  type DistrictTariffRow,
  cashLimitVerdict,
} from "@/lib/grupo-gf-courier";
import { loadGroupGfCourierRouteCheck } from "@/lib/grupo-gf-courier-route-access";
import { resolveLimaDistrict } from "@/lib/order-coverage";
import { recomputeOrderMasterSafe } from "@/lib/order-master";
import { writeCourierGuide, type RouteOutputWriteResult } from "@/lib/route-output-fill";
import { MAX_OUTPUTS_PER_ORDER, manualRouteGuideCode, pickFillableRouteOutput, puertaDeSalidaAdicional } from "@/lib/shipment-output";
import {
  REPROGRAM_QUEUE_FILTER,
  isReprogramStage,
  isRetryAdmission,
  lastFailedOutput,
  outputsBlockingRetry,
  ownRetryOutput,
  ownRetryDecision,
  ownRetryDecisionMessage,
  ownRetryTakenNote,
  reprogramBlockReason,
  newOutputLabelNotice,
  retryAdditionalReason,
  retryTakenNote,
  type FailedOutput,
} from "@/lib/gf-retry";
import { courierKey, normalizeDispatchScan } from "@/lib/dispatch";
import { courierReview, tandersReviewQueueFilter, swaypUndispatchedQueueFilter, confirmedTandersReview, tandersReviewReason, type TandersReview, type TandersConfirmations } from "@/lib/gf-tanders-review";
import { lookupDispatchShipment } from "@/app/dashboard/pedidos/despacho/actions";
import { previousLabelNote } from "@/lib/scan-other-box";
import type { RiderRateVersion } from "@/lib/rider-pay";
import { isGroupGfRiderCourier } from "@/lib/couriers/catalog";
import { custodyOnAssign, isRiderPickupMode, type RiderPickupMode } from "@/lib/grupo-gf-courier";
import { BLOCKED_REASON_LABEL, programDayLabel, programNeedsConfirm, takenIsAssignable, type BlockedReason } from "@/lib/dispatch-day";
import { pastBoxDecision, pastBoxMessage, receivedFromLabel } from "@/lib/gf-scan-return";
import { allCourierRows, courierRowsByIds } from "@/lib/courier-flow";
import { riderPickupMode } from "@/lib/grupo-gf-courier-route-access";
import { getRouteDetail, type RouteRow, type StopWithOrder } from "@/lib/routes-access";
import { getRiders, type RiderRow } from "@/lib/settlements-access";
import { routeReportAccess } from "@/lib/route-report-access";
import { loadRouteCloseContext, type RouteCloseContext } from "@/lib/route-close";
import { otherCourierBlockMessage } from "@/lib/gf-admission-message";
import { writeGfDispatchProgram } from "@/lib/gf-dispatch-program";

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
  /** 0185: exigir (verifica su caja antes de la ruta) · confirmar («Lo llevo» por paquete) · ninguno. */
  rider_pickup_mode: RiderPickupMode;
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
  /** Salió a reparto al menos una vez (`gf_order_departures`, 0199). */
  hasPriorDispatch: boolean;
  /** La última salida a reparto, si hubo. */
  lastDispatchedAt: string | null;
  /** Fecha de salida programada sin tomar el pedido (0199); null si no hay. */
  programmedFor: string | null;
  programReason: string | null;
  /** Macroetapa y subetapa del MOM en el Master, para los chips de «Desde la lista». */
  macroStage: string | null;
  macroSubstage: string | null;
  /**
   * Otro courier no lo entregó y espera courier nuevo (`lib/gf-retry.ts`): quién
   * y si su caja ya volvió. Al tomarlo se crea una salida nueva.
   */
  failedOutput?: FailedOutput | null;
  /**
   * Al tomarlo NACE su salida: nadie pidió todavía el rótulo de la nueva (no
   * hay «por definir» que rellenar, §28). Si la hay, la toma la rellena.
   */
  newOutputOnTake?: boolean;
  tandersReview?: TandersReview | null;
  /**
   * Grupo GF no lo entregó con su propia salida y sale con ESA misma salida
   * (06-10-2026, `ownRetryOutput`): mismo QR y rótulo, sin salida nueva.
   */
  ownOutput?: { outputCode: string | null } | null;
}

/**
 * La salida propia de un «Por reprogramar Lima» sigue en una caja de un día
 * anterior, sin solicitud de Grupo GF, y su motorizado la reportó «No
 * entregado» en esa caja: se recibe en oficina y después se toma con ella.
 */
export interface CourierReturnableOrder extends CourierAvailableOrder {
  route: CourierRouteAssignment;
}

export interface CourierAcceptedOrder extends CourierAvailableOrder {
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
  loadNumber: number;
  deliveryRouteId: string | null;
  routeDate: string;
  riderId: string | null;
  riderName: string;
  state: string;
  officeCheckedAt: string | null;
  pickupCheckedAt: string | null;
  /** El motorizado lo reportó «No entregado» y sigue en su caja: motivo del reporte. */
  undeliveredReason?: string | null;
}

export interface CourierRouteSummary {
  manifestId: string;
  loadNumber: number;
  deliveryRouteId: string | null;
  routeDate: string;
  riderId: string | null;
  riderName: string;
  state: string;
  assignedCount: number;
  armedCount: number;
  officeCheckedCount: number;
  pickupCheckedCount: number;
  /** Efectivo previsto de la caja: suma de la venta de sus pedidos (MOM §29.9). */
  codAmount: number;
}

export interface CourierRiderOption {
  id: string;
  fullName: string;
}

/** Pedido de Lima que no entra en la cola de Despacho, con el porqué («sin condiciones»). */
export interface CourierBlockedOrder {
  orderId: string;
  orderName: string;
  storeName: string;
  customerName: string;
  district: string;
  reason: BlockedReason;
}

export interface CourierOperationsSnapshot {
  available: CourierAvailableOrder[];
  /** Salidas propias en una caja anterior, sin solicitud: «Recibir en oficina». */
  returnable: CourierReturnableOrder[];
  accepted: CourierAcceptedOrder[];
  routes: CourierRouteSummary[];
  riders: CourierRiderOption[];
  blockedCount: number;
  /** Los excluidos con su motivo; `blockedCount` es su tamaño. */
  blocked: CourierBlockedOrder[];
  sourceCount: number;
}

const EMPTY_OPERATIONS: CourierOperationsSnapshot = {
  available: [],
  returnable: [],
  accepted: [],
  routes: [],
  riders: [],
  blockedCount: 0,
  blocked: [],
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

type ManagerAuth = { userId: string; canManageDispatch: boolean };

/**
 * Qué hace una acción al terminar. Desde la lista, recalcula el Master y
 * refresca las páginas en el acto. Desde el escáner de asignación
 * (`scanAssignToRider`) nada de eso bloquea la respuesta: refrescar la página
 * de Grupo GF la reconstruía entera (≈1.700 pedidos) DENTRO del escaneo, dos
 * veces, y cada QR tardaba 6-7 s. Ahí el recálculo va a `after()` y el
 * navegador refresca una sola vez, tras el último escaneo.
 */
interface SideEffects {
  recompute: (orderIds: string[]) => Promise<void>;
  revalidate: boolean;
}

const IMMEDIATE_EFFECTS: SideEffects = {
  recompute: async (orderIds) => { await recomputeOrderMasterSafe(createAdminSupabase(), orderIds); },
  revalidate: true,
};

function deferredEffects(): SideEffects & { flush: () => void } {
  const pending = new Set<string>();
  return {
    recompute: async (orderIds) => { for (const id of orderIds) pending.add(id); },
    revalidate: false,
    flush: () => {
      if (!pending.size) return;
      const ids = [...pending];
      after(async () => { await recomputeOrderMasterSafe(createAdminSupabase(), ids); });
    },
  };
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
  /** Solo la cola lo pide: distingue el reintento (`pendiente_nuevo_courier`). */
  operational_status?: string | null;
  coverage?: string | null;
  current_courier?: string | null;
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
  status_category?: string | null;
  /** Estado crudo del courier: dice si la salida anterior falló (Tanders `RETURNING`). */
  reported_status: string | null;
  /** Estado crudo de Swayp: su Devolución también es una salida que falló. */
  swayp_state: number | null;
  returned_at: string | null;
  /** Cuándo se creó la guía en Tanders: decide cuándo se libera una sin recolectar. */
  tanders_created_at?: string | null;
  guide_code?: string | null;
  output_code?: string | null;
  /** Lo que reusar la salida propia sobrescribe: queda en el evento de la toma. */
  assigned_at?: string | null;
  next_followup_at?: string | null;
};

/** Las columnas de salida que la admisión necesita, en la cola y al tomar. */
const ADMISSION_SHIPMENT_COLUMNS =
  "id,order_id,courier,created_via,delivery_status,custody_state,custody_transferred_at,output_number,dispatched_at,status_category,reported_status,swayp_state,returned_at,guide_code,output_code,assigned_at,next_followup_at,tanders_created_at:tanders_raw->>createdAt";

function isCourierAdmissionStage(stage: unknown, substage: unknown, operational?: unknown): boolean {
  return (
    (stage === "preparacion" && ["por_generar_rotulo", "por_armar"].includes(String(substage))) ||
    (stage === "por_despachar" && substage === "listo_para_asignar") ||
    // Otro courier no lo entregó (v1.19): se toma con una salida nueva.
    isRetryAdmission(stage, substage, operational)
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

type Admin = ReturnType<typeof createAdminSupabase>;

/**
 * Última salida a reparto por pedido (`gf_order_departures`, 0199). Si la
 * lectura falla nadie «salió»: la cola se ve entera en «Nunca salieron», que
 * es el lado prudente —se atiende antes, no se esconde—.
 */
async function loadDepartures(admin: Admin, orderIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!orderIds.length) return out;
  const { data, error } = await admin.rpc("gf_order_departures", { p_order_ids: orderIds });
  if (error) {
    console.error("gf_order_departures", error.message);
    return out;
  }
  for (const row of (data ?? []) as Array<{ order_id: string; last_departure_at: string }>) {
    out.set(row.order_id, row.last_departure_at);
  }
  return out;
}

/**
 * La caja activa de cada salida (ítem sin `removed_at`) y, si lo ÚLTIMO que su
 * motorizado reportó en ESA caja es «No entregado», su motivo: exactamente lo
 * que exige `gf_return_to_office` (0206: caja de Grupo GF, última parada por
 * `reported_at`). Para las salidas propias que se reprograman sin solicitud de
 * Grupo GF (`ownRetryOutput`), que no pasan por `accepted`.
 */
async function loadActiveBoxes(admin: Admin, shipmentIds: string[]): Promise<Map<string, CourierRouteAssignment>> {
  const out = new Map<string, CourierRouteAssignment>();
  if (!shipmentIds.length) return out;
  const { data: items } = await courierRowsByIds(shipmentIds, (ids) => admin
    .from("dispatch_manifest_items")
    .select("shipment_id,manifest_id,office_checked_at,pickup_checked_at")
    .in("shipment_id", ids)
    .is("removed_at", null));
  const boxItems = items as Array<{ shipment_id: string; manifest_id: string; office_checked_at: string | null; pickup_checked_at: string | null }>;
  if (!boxItems.length) return out;
  const [{ data: manifests }, { data: stops }] = await Promise.all([
    courierRowsByIds([...new Set(boxItems.map((item) => item.manifest_id))], (ids) => admin
      .from("dispatch_manifests")
      .select("id,courier,route_date,rider_id,driver_name,state,load_number,delivery_route_id")
      .in("id", ids)),
    courierRowsByIds(boxItems.map((item) => item.shipment_id), (ids) => admin
      .from("delivery_stops")
      .select("shipment_id,dispatch_manifest_id,status,outcome_reason,reported_at")
      .in("shipment_id", ids)
      .not("dispatch_manifest_id", "is", null)),
  ]);
  const manifestById = new Map((manifests as Array<{
    id: string;
    courier: string;
    route_date: string;
    rider_id: string | null;
    driver_name: string | null;
    state: string;
    load_number: number;
    delivery_route_id: string | null;
  }>).map((manifest) => [manifest.id, manifest]));
  // La última parada de cada (caja, salida), como la ordena la 0206.
  const lastStop = new Map<string, { status: string; outcome_reason: string | null; reported_at: string | null }>();
  for (const stop of stops as Array<{ shipment_id: string; dispatch_manifest_id: string; status: string; outcome_reason: string | null; reported_at: string | null }>) {
    const key = `${stop.dispatch_manifest_id}:${stop.shipment_id}`;
    const current = lastStop.get(key);
    if (!current || (stop.reported_at ?? "") > (current.reported_at ?? "")) lastStop.set(key, stop);
  }
  for (const item of boxItems) {
    const manifest = manifestById.get(item.manifest_id);
    const stop = lastStop.get(`${item.manifest_id}:${item.shipment_id}`);
    const undelivered = manifest && courierKey(manifest.courier) === "propio" && stop?.status === "no_entregado";
    out.set(item.shipment_id, {
      manifestId: item.manifest_id,
      loadNumber: manifest?.load_number ?? 1,
      deliveryRouteId: manifest?.delivery_route_id ?? null,
      routeDate: manifest?.route_date ?? "",
      riderId: manifest?.rider_id ?? null,
      riderName: manifest?.driver_name ?? "Motorizado sin nombre",
      state: manifest?.state ?? "unknown",
      officeCheckedAt: item.office_checked_at,
      pickupCheckedAt: item.pickup_checked_at,
      undeliveredReason: undelivered ? stop?.outcome_reason ?? "sin motivo" : null,
    });
  }
  return out;
}

/**
 * Toma TAL CUAL la salida propia que Grupo GF no entregó (06-10-2026): no se
 * crea otra ni se «rellena» —ya es de Grupo GF—. Conserva consecutivo, QR,
 * `output_code`, `guide_code` y armado (`preparation_state`): no se envía
 * ninguno. Pasa a ser de la toma (`created_via`, como al rellenar: el botón
 * «Anular salida» del Master deja de ofrecerse sobre una salida que Grupo GF
 * tiene tomada); el anterior queda en el evento de la toma. El UPDATE repite
 * las condiciones: si entre la lectura y la escritura salió, se anuló o se
 * despachó, no la pisa.
 */
async function adoptOwnOutput(
  admin: Admin,
  output: AdmissionShipmentRow,
  at: { acceptedAt: string; scheduledFor: string },
): Promise<RouteOutputWriteResult | { error: string }> {
  const { data, error } = await admin
    .from("shipments")
    .update({
      created_via: "grupo_gf_courier",
      assigned_at: at.acceptedAt,
      next_followup_at: `${at.scheduledFor}T12:00:00-05:00`,
      updated_at: at.acceptedAt,
    })
    .eq("id", output.id)
    .eq("courier", output.courier)
    .eq("delivery_status", "pendiente")
    .eq("custody_state", "empresa")
    .is("custody_transferred_at", null)
    .select("id,output_code")
    .maybeSingle();
  if (error) return { error: error.message };
  if (!data) return { error: `${output.output_code ?? "La salida"} ya no está pendiente en la oficina: vuelve a cargar la lista.` };
  return {
    shipmentId: output.id,
    filled: true,
    outputCode: (data as { output_code: string | null }).output_code ?? output.output_code ?? null,
    droppedColumns: [],
  };
}

interface DispatchProgram {
  order_id: string;
  store_id: string;
  scheduled_for: string;
  reason: string;
}

/** Programaciones de salida sin tomar (0199), por pedido. Una lectura que falla no tumba la pantalla. */
async function loadPrograms(admin: Admin, filter: { storeIds?: string[]; orderIds?: string[] }): Promise<Map<string, DispatchProgram>> {
  const out = new Map<string, DispatchProgram>();
  const ids = filter.orderIds ?? filter.storeIds ?? [];
  if (!ids.length) return out;
  try {
    const { data } = await courierRowsByIds(ids, (batch) => admin
      .from("gf_dispatch_programs")
      .select("order_id,store_id,scheduled_for,reason")
      .in(filter.orderIds ? "order_id" : "store_id", batch));
    for (const row of data as DispatchProgram[]) out.set(row.order_id, row);
  } catch (error) {
    console.error("gf_dispatch_programs", error instanceof Error ? error.message : error);
  }
  return out;
}

/**
 * Los pedidos programados para otro día que no está confirmado sacar en la
 * caja de `boxDay` (§29.6): se devuelven con su fecha para decirlo.
 */
async function programConflicts(admin: Admin, orderIds: string[], boxDay: string): Promise<Map<string, DispatchProgram>> {
  const today = limaClock().day;
  const programs = await loadPrograms(admin, { orderIds });
  return new Map([...programs].filter(([, program]) => programNeedsConfirm(program.scheduled_for, boxDay, today)));
}

function programConflictMessage(program: DispatchProgram, boxDay: string): string {
  const today = limaClock().day;
  const target = boxDay === today ? "hoy" : `el ${programDayLabel(boxDay)}`;
  return `Programado para el ${programDayLabel(program.scheduled_for)} («${program.reason}»): confirma para que salga ${target}.`;
}

/**
 * La programación se cumplió: el pedido entró en una caja. Si fue la de otro
 * día, queda dicho quién lo confirmó y cuándo iba a salir.
 */
async function settlePrograms(admin: Admin, actor: string, entries: Array<{ orderId: string; storeId: string; shipmentId: string | null; routeDate: string; riderName: string }>): Promise<void> {
  if (!entries.length) return;
  const programs = await loadPrograms(admin, { orderIds: entries.map((entry) => entry.orderId) });
  if (!programs.size) return;
  const now = new Date().toISOString();
  const overridden = entries.filter((entry) => {
    const program = programs.get(entry.orderId);
    return program && program.scheduled_for !== entry.routeDate;
  });
  await Promise.all([
    admin.from("gf_dispatch_programs").delete().in("order_id", [...programs.keys()]),
    overridden.length
      ? admin.from("order_events").insert(overridden.map((entry) => {
          const program = programs.get(entry.orderId)!;
          return {
            store_id: entry.storeId,
            order_id: entry.orderId,
            kind: "dispatch_program_overridden",
            occurred_at: now,
            actor,
            source: "grupo_gf_courier",
            courier: "propio",
            shipment_id: entry.shipmentId,
            note: `Estaba programado para el ${programDayLabel(program.scheduled_for)} («${program.reason}»); entró en la caja de ${entry.riderName} del ${programDayLabel(entry.routeDate)}.`,
            payload: { programmedFor: program.scheduled_for, routeDate: entry.routeDate, reason: program.reason },
          };
        }))
      : Promise.resolve(),
  ]);
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
    queueRows,
    requestRows,
    { data: riderRows },
  ] =
    await Promise.all([
      admin.from("stores").select("id,name").in("id", storeIds),
      allCourierRows((from, to) => admin
        .from("order_master")
        .select(
          "order_id,store_id,order_name,customer_name,customer_phone,district,order_total,order_created_at,macro_stage,macro_substage,operational_status,coverage,current_courier",
          { count: "exact" },
        )
        .in("store_id", storeIds)
        // «Por reprogramar Lima» entra por su ETAPA, la misma que cuenta el
        // Master (06-10-2026). Antes solo entraba lo que otro courier no
        // entregó (`pendiente_nuevo_courier`, #KP135035, #KP135161) y lo que
        // Grupo GF no entregó sin solicitud (#KP132798) no aparecía nunca.
        .or(
          `and(macro_stage.eq.preparacion,macro_substage.in.(por_generar_rotulo,por_armar)),and(macro_stage.eq.por_despachar,macro_substage.eq.listo_para_asignar),${REPROGRAM_QUEUE_FILTER},${tandersReviewQueueFilter(day)},${swaypUndispatchedQueueFilter(day)}`,
        )
        .eq("coverage", "lima")
        .order("order_created_at", { ascending: false })
        .order("order_id")
        .range(from, to)),
      allCourierRows((from, to) => admin
        .from("logistics_requests")
        .select(
          "id,agreement_id,store_id,order_id,shipment_id,status,district_key,tariff_id,tariff_amount,currency,scheduled_for,accepted_at,observation",
        )
        .eq("provider_id", config.provider.id)
        .neq("status", "cancelled")
        .order("created_at", { ascending: false })
        .order("id")
        .range(from, to)),
      admin
        .from("riders")
        .select("id,full_name,courier")
        .eq("org_id", config.provider.org_id)
        .eq("active", true)
        .order("full_name"),
    ]);
  const sourceCount = queueRows.length;

  const queueOrderIds = ((queueRows ?? []) as QueueOrderRow[]).map((order) => order.order_id);
  const { data: admissionShipmentRows } = await courierRowsByIds(queueOrderIds, (ids) => admin
        .from("shipments")
        .select(ADMISSION_SHIPMENT_COLUMNS)
        .in("order_id", ids));
  const shipmentsByOrder = new Map<string, AdmissionShipmentRow[]>();
  for (const row of (admissionShipmentRows ?? []) as AdmissionShipmentRow[]) {
    if (!row.order_id) continue;
    shipmentsByOrder.set(row.order_id, [...(shipmentsByOrder.get(row.order_id) ?? []), row]);
  }
  // «Nunca salieron» frente a «Ya salieron», y lo programado sin tomar (0199):
  // para la cola y para lo tomado, en una llamada cada uno.
  const requestOrderIdsAll = ((requestRows ?? []) as { order_id: string }[]).map((request) => request.order_id);
  const [lastDispatchByOrder, programByOrder] = await Promise.all([
    loadDepartures(admin, [...new Set([...queueOrderIds, ...requestOrderIdsAll])]),
    loadPrograms(admin, { storeIds }),
  ]);

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
  // Lo que Grupo GF no entregó con su propia salida y no tiene solicitud
  // (06-10-2026, `ownRetryOutput`): sale con ESA salida. Su caja, si sigue en
  // una de un día anterior, se lee de una vez para toda la cola.
  const ownByOrder = new Map<string, AdmissionShipmentRow>();
  for (const order of (queueRows ?? []) as QueueOrderRow[]) {
    if (activeOrderIds.has(order.order_id) || isRetryAdmission(order.macro_stage, order.macro_substage, order.operational_status)) continue;
    const own = ownRetryOutput(order, shipmentsByOrder.get(order.order_id) ?? []);
    if (own) ownByOrder.set(order.order_id, own);
  }
  const ownIds = [...ownByOrder.values()].map((output) => output.id);
  const [ownBoxes, { data: ownRequestRows }] = await Promise.all([
    loadActiveBoxes(admin, ownIds),
    // Una salida solo puede estar en UNA solicitud, también cancelada
    // (`logistics_requests_shipment_uniq`): lo mismo que se mira al tomar.
    courierRowsByIds(ownIds, (ids) => admin.from("logistics_requests").select("shipment_id").in("shipment_id", ids)),
  ]);
  const ownInRequest = new Set((ownRequestRows as Array<{ shipment_id: string }>).map((request) => request.shipment_id));

  let blockedCount = 0;
  const blocked: CourierBlockedOrder[] = [];
  const available: CourierAvailableOrder[] = [];
  const returnable: CourierReturnableOrder[] = [];
  const block = (order: QueueOrderRow, reason: BlockedReason) => {
    blockedCount += 1;
    blocked.push({
      orderId: order.order_id,
      orderName: order.order_name ?? "Pedido sin código",
      storeName: storeName.get(order.store_id) ?? agreementByStore.get(order.store_id)?.client_label ?? "Tienda",
      customerName: order.customer_name ?? "Cliente sin nombre",
      district: order.district ?? "Sin distrito",
      reason,
    });
  };

  for (const order of (queueRows ?? []) as QueueOrderRow[]) {
    if (activeOrderIds.has(order.order_id)) continue;
    const outputs = shipmentsByOrder.get(order.order_id) ?? [];
    // Un reintento no reutiliza caja —la anterior es de otro courier— y la salida
    // que falló no cuenta como «ya en caja» aunque siga volviendo.
    const retry = isRetryAdmission(order.macro_stage, order.macro_substage, order.operational_status);
    const review = courierReview(order, outputs, day);
    // Grupo GF no lo entregó con su propia salida: sale con ESA (06-10-2026).
    const own = retry || review ? null : ownByOrder.get(order.order_id) ?? null;
    if (!isCourierAdmissionStage(order.macro_stage, order.macro_substage, order.operational_status) && !review && !own) {
      // Un «Por reprogramar Lima» que no se puede tomar dice por qué: otra
      // salida sigue viva (una reprogramación de Aliclik, por ejemplo) y la
      // lleva su courier, o no queda ninguna viva que sacar. Nunca
      // desaparece en silencio de la cola.
      if (isReprogramStage(order.macro_stage, order.macro_substage)) block(order, reprogramBlockReason(outputs));
      continue;
    }
    const fillable = own ? null : pickFillableRouteOutput(outputs);
    // La salida propia que se reprograma es la única viva (`ownRetryOutput`): no estorba.
    // La que su courier no entregó tampoco, tampoco cuando el pedido ya tiene su
    // «por definir» impresa y está en Preparación (09-10-2026, §28).
    const assigned = own ? null : activeAssignedOutput(review ? outputs.filter((o) => !review.shipmentIds.includes(o.id)) : outputsBlockingRetry(outputs), fillable?.id ?? null);
    const needsExistingBox = !review && !retry && !own && order.macro_substage !== "por_generar_rotulo";
    if (assigned || (needsExistingBox && !fillable)) {
      block(order, assigned ? "ya_en_caja" : "sin_salida");
      continue;
    }
    // Si su salida sigue en una caja, primero se recibe en oficina; lo que no
    // se puede sacar (`ownRetryDecision`) va a «Sin condiciones» con su motivo.
    const ownBox = own ? ownBoxes.get(own.id) ?? null : null;
    const decision = own ? ownRetryDecision(own, ownBox, ownInRequest.has(own.id)) : null;
    if (decision?.action === "bloquear") {
      block(order, decision.reason);
      continue;
    }
    const agreement = agreementByStore.get(order.store_id);
    const districtKey = canonicalDistrictKey(order.district);
    if (!agreement || !districtKey) {
      block(order, "distrito_invalido");
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
      block(order, tariff.kind === "missing" ? "tarifa_faltante" : "servicio_pausado");
      continue;
    }
    const program = programByOrder.get(order.order_id) ?? null;
    const row: CourierAvailableOrder = {
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
      // Programado: sale ese día. Si no, hoy o mañana según el corte de las 11:30.
      scheduledFor: program?.scheduled_for ?? scheduledDay(config.provider.same_day_cutoff),
      hasPriorDispatch: lastDispatchByOrder.has(order.order_id),
      lastDispatchedAt: lastDispatchByOrder.get(order.order_id) ?? null,
      programmedFor: program?.scheduled_for ?? null,
      programReason: program?.reason ?? null,
      macroStage: order.macro_stage ?? null,
      macroSubstage: order.macro_substage ?? null,
      failedOutput: retry ? lastFailedOutput(outputs) : null,
      newOutputOnTake: retry && !fillable,
      tandersReview: review,
      ownOutput: own ? { outputCode: own.output_code ?? null } : null,
    };
    if (ownBox && decision?.action === "recibir_en_oficina") returnable.push({ ...row, route: ownBox });
    else available.push(row);
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
    courierRowsByIds(requestOrderIds, (ids) => admin
          .from("order_master")
          .select(
            "order_id,store_id,order_name,customer_name,customer_phone,district,order_total,order_created_at,macro_stage,macro_substage",
          )
          .in("order_id", ids)),
    courierRowsByIds(shipmentIds, (ids) => admin
          .from("shipments")
          .select("id,output_code,preparation_state")
          .in("id", ids)),
    courierRowsByIds(shipmentIds, (ids) => admin
          .from("dispatch_manifest_items")
          .select("shipment_id,manifest_id,office_checked_at,pickup_checked_at")
          .in("shipment_id", ids)
          .is("removed_at", null)),
  ]);
  // Paradas «No entregado» de paquetes que siguen en una caja: se ofrecen para
  // «Recibir en oficina» y así vuelven a la cola (0188).
  const { data: undeliveredStops } = await courierRowsByIds(shipmentIds, (ids) => admin
        .from("delivery_stops")
        .select("shipment_id,dispatch_manifest_id,outcome_reason")
        .in("shipment_id", ids)
        .eq("status", "no_entregado"));
  const undeliveredByBox = new Map(
    ((undeliveredStops ?? []) as Array<{ shipment_id: string; dispatch_manifest_id: string | null; outcome_reason: string | null }>)
      .filter((row) => row.dispatch_manifest_id)
      .map((row) => [`${row.dispatch_manifest_id}:${row.shipment_id}`, row.outcome_reason ?? "sin motivo"]),
  );
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
  const { data: manifestRows } = await courierRowsByIds(manifestIds, (ids) => admin
        .from("dispatch_manifests")
        .select("id,route_date,rider_id,driver_name,state,load_number,delivery_route_id")
        .in("id", ids)
        .neq("state", "cancelled"));
  const manifestById = new Map(
    ((manifestRows ?? []) as Array<{
      id: string;
      route_date: string;
      load_number: number;
      delivery_route_id: string | null;
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
    // En una caja la programación ya se cumplió (se borra al asignar).
    const program = manifest ? null : programByOrder.get(request.order_id) ?? null;
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
      scheduledFor: program?.scheduled_for ?? request.scheduled_for,
      requestId: request.id,
      requestStatus: request.status,
      shipmentId: request.shipment_id,
      outputCode: shipment?.output_code ?? null,
      preparationState: shipment?.preparation_state ?? null,
      acceptedAt: request.accepted_at,
      observation: request.observation,
      hasPriorDispatch: lastDispatchByOrder.has(request.order_id),
      lastDispatchedAt: lastDispatchByOrder.get(request.order_id) ?? null,
      programmedFor: program?.scheduled_for ?? null,
      programReason: program?.reason ?? null,
      macroStage: order.macro_stage ?? null,
      macroSubstage: order.macro_substage ?? null,
      route: manifest
        ? {
            manifestId: manifest.id,
            loadNumber: manifest.load_number,
            deliveryRouteId: manifest.delivery_route_id,
            routeDate: manifest.route_date,
            riderId: manifest.rider_id,
            riderName: manifest.driver_name ?? "Motorizado sin nombre",
            state: manifest.state,
            officeCheckedAt: manifestItem?.office_checked_at ?? null,
            pickupCheckedAt: manifestItem?.pickup_checked_at ?? null,
            undeliveredReason: undeliveredByBox.get(`${manifest.id}:${request.shipment_id}`) ?? null,
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
      loadNumber: order.route.loadNumber,
      deliveryRouteId: order.route.deliveryRouteId,
      routeDate: order.route.routeDate,
      riderId: order.route.riderId,
      riderName: order.route.riderName,
      state: order.route.state,
      assignedCount: 0,
      armedCount: 0,
      officeCheckedCount: 0,
      pickupCheckedCount: 0,
      codAmount: 0,
    };
    current.assignedCount += 1;
    current.codAmount = Math.round((current.codAmount + (order.orderTotal ?? 0)) * 100) / 100;
    if (order.preparationState === "listo_despacho") current.armedCount += 1;
    if (order.route.officeCheckedAt) current.officeCheckedCount += 1;
    if (order.route.pickupCheckedAt) current.pickupCheckedCount += 1;
    routeById.set(order.route.manifestId, current);
  }
  const routes = [...routeById.values()].sort((a, b) =>
    b.routeDate.localeCompare(a.routeDate) || a.riderName.localeCompare(b.riderName, "es"),
  );

  return { available, returnable, accepted, routes, riders, blockedCount, blocked, sourceCount: sourceCount ?? available.length };
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
      .select("id,org_id,code,name,status,same_day_cutoff,cash_warning_amount,cash_limit_amount,rider_pickup_mode")
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
  /** `needsLabel`: la salida nació al tomarlo y su rótulo falta imprimir. */
  accepted: Array<{ orderId: string; shipmentId: string; outputCode: string | null; needsLabel?: boolean }>;
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
  opts: { scheduledFor?: string | null; dispatchDay?: string | null; tandersConfirmations?: TandersConfirmations } = {},
): Promise<TakeCourierOrdersResult> {
  const auth = await requireManager(orgId);
  if ("error" in auth) return { ...auth, accepted: [], alreadyAccepted: [], failed: [] };
  return takeOrdersCore(auth, orgId, orderIds, opts, IMMEDIATE_EFFECTS);
}

async function takeOrdersCore(
  auth: ManagerAuth,
  orgId: string,
  orderIds: string[],
  opts: { scheduledFor?: string | null; dispatchDay?: string | null; tandersConfirmations?: TandersConfirmations },
  fx: SideEffects,
  scanContext?: { gfProvider: { id: string } | null },
): Promise<TakeCourierOrdersResult> {
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
  const gfProvider = scanContext ? scanContext.gfProvider : (await admin
    .from("logistics_providers")
    .select("id")
    .eq("org_id", orgId)
    .eq("code", "grupo-gf-courier")
    .maybeSingle()).data;

  // Secuencial a propósito: cada admisión vuelve a comprobar la configuración
  // vigente y deja su propio resultado. Un pedido inválido no tumba la tanda.
  for (const orderId of uniqueOrderIds) {
    try {
      // Ya tomado por Grupo GF: cuenta como tal ANTES de mirar la salida. La
      // salida que dejó esa toma ya lleva courier, así que las comprobaciones
      // de abajo la leían como «asignada a otro courier» y el escaneo de
      // Despacho del día rechazaba pedidos que el propio Grupo GF tenía
      // aceptados desde hacía días (MOM §29.13: tomar es idempotente).
      if (gfProvider?.id) {
        const { data: existing } = await admin
          .from("logistics_requests")
          .select("id")
          .eq("order_id", orderId)
          .eq("provider_id", gfProvider.id)
          .in("status", ["accepting", "accepted", "scheduled"])
          .limit(1)
          .maybeSingle();
        if (existing) {
          alreadyAccepted.push(orderId);
          continue;
        }
      }
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

      const { data: outputRows, error: outputError } = await admin
        .from("shipments")
        .select(ADMISSION_SHIPMENT_COLUMNS)
        .eq("order_id", orderId);
      if (outputError) {
        failed.push({ orderId, error: outputError.message });
        continue;
      }
      const outputs = (outputRows ?? []) as unknown as AdmissionShipmentRow[];
      const review = courierReview(row, outputs, limaClock().day);
      // Grupo GF no lo entregó con su propia salida (06-10-2026): se toma con
      // ESA salida, sin crear otra. La misma regla que la cola.
      const own = review || isRetryAdmission(row.macro_stage, row.macro_substage, row.operational_status) ? null : ownRetryOutput(row, outputs);
      if (!isCourierAdmissionStage(row.macro_stage, row.macro_substage, row.operational_status) && !review && !own) {
        failed.push({ orderId, error: isReprogramStage(row.macro_stage, row.macro_substage)
          ? `${BLOCKED_REASON_LABEL[reprogramBlockReason(outputs)].label}.`
          // Si lo frena la salida de otro courier, se dice cuál y de quién.
          : otherCourierBlockMessage(outputs) ?? "El pedido ya avanzó y salió de Pedidos disponibles." });
        continue;
      }
      if (own) {
        // La misma decisión que la cola (`ownRetryDecision`). En una caja,
        // recibirlo en oficina es un hecho físico y va a propósito («Recibir en
        // oficina» o su escaneo); aquí solo se dice.
        const [box, { data: priorRequest }] = await Promise.all([
          loadActiveBoxes(admin, [own.id]).then((boxes) => boxes.get(own.id) ?? null),
          admin.from("logistics_requests").select("id").eq("shipment_id", own.id).limit(1).maybeSingle(),
        ]);
        const decision = ownRetryDecision(own, box, Boolean(priorRequest));
        if (decision.action !== "tomar") {
          failed.push({ orderId, error: ownRetryDecisionMessage(decision, box, own.output_code) });
          continue;
        }
      }
      const confirmation = opts.tandersConfirmations?.[orderId];
      if (review && !auth.canManageDispatch) {
        failed.push({ orderId, error: `No tienes permiso para reasignar los paquetes de ${review.courier === "swayp" ? "Swayp" : "Tanders"}.` });
        continue;
      }
      if (review && !confirmedTandersReview(review, confirmation)) {
        failed.push({ orderId, error: review.courier === "swayp"
          ? `${row.order_name ?? "El pedido"}: la bodega de Swayp no lo despachó. Confirma en Desde la lista si el paquete está en el almacén o si saldrá otro.`
          : `${row.order_name ?? "El pedido"}: confirma en Desde la lista si el paquete de Tanders volvió al almacén o si saldrá otro mientras se recupera el anterior.` });
        continue;
      }
      const reviewReason = review && confirmation ? tandersReviewReason(confirmation.packageLocation, review.uncollected === true, review.courier) : null;
      // REINTENTO (v1.19): otro courier no lo entregó. La salida que falló no
      // cuenta como asignada y nunca se rellena: la caja anterior es de ese
      // courier (§9.3). Si ya existe la «por definir» que nació al pedir su
      // rótulo (§28, 09-10-2026), se rellena ESA —su rótulo es el que va pegado
      // en la caja—; si no, se abre una NUEVA.
      const retry = isRetryAdmission(row.macro_stage, row.macro_substage, row.operational_status);
      // Con la salida propia no hay «por definir» que rellenar: es la única viva.
      const fillable = review || own ? null : pickFillableRouteOutput(outputs);
      // La que su courier no entregó no estorba en ningún camino: tampoco
      // cuando el pedido, con su «por definir» ya impresa, está en Preparación.
      const assigned = own ? null : activeAssignedOutput(review ? outputs.filter((o) => !review.shipmentIds.includes(o.id)) : outputsBlockingRetry(outputs), fillable?.id ?? null);
      // Un reintento que rellena no crea: si otra pestaña se lleva la «por
      // definir» entre leer y escribir, no nace una caja sin puerta ni tope.
      const retryCreates = retry && !fillable;
      const mayCreateOutput = Boolean(review) || retryCreates || row.macro_substage === "por_generar_rotulo";
      if (assigned) {
        // Nombrar la salida y su courier (09-10-2026): «asignada a otro
        // courier» a secas dejaba adivinando cuál y qué hacer.
        const blocking = review ? outputs.filter((o) => !review.shipmentIds.includes(o.id)) : retry ? outputsBlockingRetry(outputs) : outputs;
        failed.push({
          orderId,
          error: otherCourierBlockMessage(blocking.filter((o) => o.id !== fillable?.id)) ?? "El pedido ya tiene una salida asignada a otro courier.",
        });
        continue;
      }
      if (!mayCreateOutput && !fillable && !own) {
        failed.push({ orderId, error: "La caja existente ya no está disponible para asignarla." });
        continue;
      }
      // La caja que falló puede seguir volviendo: entonces la salida nueva es
      // ADICIONAL y lleva motivo (§9). Lo escribe el sistema porque el hecho ya
      // lo reportó el courier; el tope de cinco salidas se aplica igual.
      const failedBefore = retry ? lastFailedOutput(outputs) : null;
      // Rellenar no es una salida adicional: su motivo se escribió al nacer.
      const puerta = retryCreates || review
        ? puertaDeSalidaAdicional({
            courier: "propio",
            operation: "lima",
            outputs,
            motivo: reviewReason ?? (failedBefore ? retryAdditionalReason(failedBefore) : null),
          })
        : null;
      if (puerta && !puerta.ok) {
        failed.push({ orderId, error: puerta.error });
        continue;
      }
      if ((retryCreates || review) && outputs.length >= MAX_OUTPUTS_PER_ORDER) {
        failed.push({ orderId, error: `El pedido ya alcanzó el máximo de ${MAX_OUTPUTS_PER_ORDER} salidas.` });
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

      // El corte (11:30) fija el primer día posible; el supervisor puede
      // pedir uno posterior (modo escaneo, §29.13), nunca uno anterior.
      const earliest = scheduledDay(check.sameDayCutoff);
      // `dispatchDay` viene de la mesa de despacho con el paquete en la mano
      // (Despacho del día): ese día manda, también después del corte de las
      // 11:30. El corte solo rige lo que se toma sin despachar todavía.
      const dispatchDay = opts.dispatchDay && DATE_RE.test(opts.dispatchDay) && opts.dispatchDay >= limaClock().day ? opts.dispatchDay : null;
      const scheduledFor = dispatchDay ?? (opts.scheduledFor && DATE_RE.test(opts.scheduledFor) && opts.scheduledFor > earliest ? opts.scheduledFor : earliest);
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
          // Dos pestañas a la vez: la otra ya lo tomó. Pero la clave de
          // idempotencia (`kapta:proveedor:pedido`) también choca con una
          // solicitud CANCELADA, y eso no es «ya estaba tomado».
          const { data: live } = await admin
            .from("logistics_requests")
            .select("id")
            .eq("order_id", orderId)
            .eq("provider_id", check.providerId)
            .neq("status", "cancelled")
            .limit(1)
            .maybeSingle();
          if (live) alreadyAccepted.push(orderId);
          else failed.push({ orderId, error: "Este pedido ya tuvo una solicitud de Grupo GF que se canceló: no se puede volver a tomar desde aquí." });
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
      // Si Almacén ya creó la caja «por definir», su UUID también es la base
      // del código interno. Generar otro aquí producía un código que parecía
      // pertenecer a una caja distinta, aunque el UPDATE conservara la original.
      const newShipmentId = fillable?.id ?? randomUUID();
      // La salida propia conserva su código de guía: el rótulo pegado sigue valiendo.
      const guideCode = own ? own.guide_code ?? null : manualRouteGuideCode(
        row.order_name == null ? null : String(row.order_name),
        newShipmentId,
        "propio",
      );
      const acceptedAt = new Date().toISOString();
      const write = own ? await adoptOwnOutput(admin, own, { acceptedAt, scheduledFor }) : await writeCourierGuide(admin, orderId, {
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
      }, { createIfMissing: mayCreateOutput, forceNew: Boolean(review) });
      if ("error" in write) {
        if (own) {
          // La salida cambió entre la lectura y la escritura (se anuló o
          // salió). La solicitud se creó en esta misma llamada y todavía no
          // tiene salida ni eventos: se deshace para que el pedido no quede
          // tras una «observada» que nadie puede corregir.
          await admin.from("logistics_requests").delete().eq("id", requestId).eq("status", "accepting");
          failed.push({ orderId, error: write.error });
          continue;
        }
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
            ownRetry: own ? { previousCreatedVia: own.created_via, previousAssignedAt: own.assigned_at ?? null, previousNextFollowupAt: own.next_followup_at ?? null } : null,
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
          note: own
            ? ownRetryTakenNote(outputCode)
            : write.filled
            ? "Grupo GF Courier tomó el pedido y conservó el QR de la salida existente."
            : reviewReason ?? (failedBefore
              ? retryTakenNote(failedBefore)
              : "Grupo GF Courier tomó el pedido desde Pedidos disponibles."),
          payload: {
            requestId,
            outputCode,
            reusedOutput: write.filled,
            ownRetry: own ? { previousCreatedVia: own.created_via, previousAssignedAt: own.assigned_at ?? null, previousNextFollowupAt: own.next_followup_at ?? null } : null,
            tariffId: check.tariffId,
            tandersReview: review && confirmation ? { ...review, packageLocation: confirmation.packageLocation } : null,
            tariffAmount: check.tariffAmount,
            districtKey: check.districtKey,
            scheduledFor,
          },
        }),
        // La justificación auditada de la salida adicional (MOM §23), en su
        // propio evento y con las salidas que seguían vivas: igual que Swayp.
        puerta?.motivo
          ? admin.from("order_events").insert({
              store_id: String(row.store_id),
              order_id: orderId,
              kind: "additional_output_reason",
              occurred_at: acceptedAt,
              actor: auth.userId,
              source: "grupo_gf_courier",
              courier: "propio",
              guide_code: guideCode,
              shipment_id: write.shipmentId,
              reason: puerta.motivo,
              note: `Salida adicional por Grupo GF con ${puerta.estorban.length} salida(s) todavía viva(s).`,
              payload: {
                salidas_vivas: puerta.estorban.map((o) => ({
                  codigo: o.output_code ?? o.guide_code ?? null,
                  courier: o.courier,
                  estado: o.delivery_status,
                })),
              },
            })
          : Promise.resolve(),
      ]);
      await fx.recompute([orderId]);
      // Otro courier no lo entregó y nadie había pedido su rótulo: la salida
      // nació aquí y su rótulo todavía no existe en papel. Se dice con su código
      // para que se imprima y se pegue sobre la caja que volvió.
      accepted.push({ orderId, shipmentId: write.shipmentId, outputCode: outputCode ?? null, ...(retry && !write.filled ? { needsLabel: true } : {}) });
    } catch (error) {
      failed.push({ orderId, error: error instanceof Error ? error.message : String(error) });
    }
  }

  if (fx.revalidate) {
    revalidatePath(COURIER_PATH);
    revalidatePath("/dashboard/pedidos");
    revalidatePath("/dashboard/pedidos/almacen");
  }
  const messages: string[] = [];
  if (accepted.length) {
    messages.push(
      `${accepted.length} pedido${accepted.length === 1 ? "" : "s"} tomado${accepted.length === 1 ? "" : "s"}. Almacén ${accepted.length === 1 ? "lo armará" : "los armará"} o conservará el armado que ya tenían.`,
    );
  }
  const toLabel = accepted.filter((item) => item.needsLabel).map((item) => item.outputCode ?? item.orderId);
  if (toLabel.length) messages.push(newOutputLabelNotice(toLabel));
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
  /** Aviso de efectivo (MOM §29.9) cuando la ruta pasa del umbral sin llegar al límite. */
  cashWarning?: string;
}

/**
 * «Recibir en oficina» (0188, MOM §29.13): el paquete que el motorizado
 * reportó «No entregado» sale de su caja con rastro, la custodia vuelve a la
 * empresa y la solicitud a «por asignar». El pedido queda en «Por reprogramar
 * Lima» hasta que se asigne otra vez.
 */
export async function returnUndeliveredToOffice(orgId: string, orderIds: string[]): Promise<CourierActionResult> {
  const auth = await requireManager(orgId);
  if ("error" in auth) return auth;
  if (!auth.canManageDispatch) return { error: "No tienes permiso para organizar rutas." };
  const ids = [...new Set(orderIds.filter(Boolean))];
  if (!ids.length) return { error: "Marca al menos un pedido." };
  const admin = createAdminSupabase();
  const { data: shipments } = await admin.from("shipments").select("id,order_id").in("order_id", ids).eq("courier", "propio");
  const shipmentIds = ((shipments ?? []) as { id: string }[]).map((row) => row.id);
  if (!shipmentIds.length) return { error: "Esos pedidos no tienen salida de Grupo GF." };
  const { data: items } = await admin.from("dispatch_manifest_items").select("id,shipment_id").in("shipment_id", shipmentIds).is("removed_at", null);
  const changed: string[] = [];
  const errors: string[] = [];
  for (const item of (items ?? []) as { id: string }[]) {
    const { data, error } = await admin.rpc("gf_return_to_office", { p_item_id: item.id, p_actor: auth.userId });
    if (error) errors.push(error.message);
    else if (data) changed.push(data as string);
  }
  if (changed.length) await recomputeOrderMasterSafe(admin, changed);
  revalidatePath(COURIER_PATH);
  revalidatePath("/dashboard/pedidos");
  if (!changed.length) return { error: [...new Set(errors)].join(" ") || "Ninguno de esos pedidos está «No entregado» dentro de una caja." };
  const done = `${changed.length} ${changed.length === 1 ? "pedido recibido" : "pedidos recibidos"} en oficina. Vuelven a «por asignar» (Por reprogramar Lima), también los rechazados.`;
  return errors.length ? { error: `${done} ${[...new Set(errors)].join(" ")}` } : { notice: done };
}

/**
 * «Recibir devoluciones» desde Rutas: el QR, la guía o el número de pedido de
 * un paquete «No entregado» que el motorizado trae de vuelta. Misma regla que
 * `returnUndeliveredToOffice` (0188/0189).
 */
export async function returnUndeliveredByCode(orgId: string, rawCode: string): Promise<CourierActionResult & { orderName?: string | null }> {
  const code = normalizeDispatchScan(rawCode).slice(0, 200);
  if (!code) return { error: "Escanea el QR o escribe el código del paquete." };
  const auth = await requireManager(orgId);
  if ("error" in auth) return auth;
  const admin = createAdminSupabase();
  let orderId: string | null = null;
  const found = await lookupDispatchShipment(code);
  if (found.shipment) orderId = found.shipment.order_id;
  else {
    const name = code.replace(/^#/, "");
    const { data: stores } = await admin.from("stores").select("id").eq("org_id", orgId);
    const storeIds = ((stores ?? []) as { id: string }[]).map((st) => st.id);
    const { data: orders } = await admin.from("orders").select("id").in("store_id", storeIds).or(`name.ilike.${name},name.ilike.#${name}`).limit(2);
    if (orders?.length === 1) orderId = orders[0]!.id as string;
  }
  if (!orderId) return { error: found.error ?? "No encontramos un pedido con ese QR, guía o número." };
  const { data: om } = await admin.from("order_master").select("order_name").eq("order_id", orderId).maybeSingle();
  const res = await returnUndeliveredToOffice(orgId, [orderId]);
  return { ...res, orderName: (om?.order_name as string | null) ?? null };
}

/**
 * Tarifario · pago por motorizado (0162, MOM §29.9): las versiones de la
 * tarifa personal de un motorizado, generales y por distrito. El navegador
 * resuelve cuál rige en cada distrito y día (`resolveRiderRate`).
 */
export async function loadRiderPayRates(orgId: string, riderId: string): Promise<{ rates: RiderRateVersion[]; error?: string }> {
  const auth = await requireManager(orgId);
  if ("error" in auth) return { rates: [], error: auth.error };
  const admin = createAdminSupabase();
  const { data: rider } = await admin.from("riders").select("id").eq("id", riderId).eq("org_id", orgId).maybeSingle();
  if (!rider) return { rates: [], error: "Motorizado no encontrado." };
  const { data, error } = await admin
    .from("rider_pay_rates")
    .select("district_key,amount,effective_from,created_at")
    .eq("rider_id", riderId)
    .order("effective_from", { ascending: false });
  if (error) return { rates: [], error: error.message };
  return { rates: ((data ?? []) as RiderRateVersion[]).map((r) => ({ ...r, amount: Number(r.amount) })) };
}

/**
 * Registra una versión nueva de la tarifa personal del motorizado en un
 * distrito, desde la fecha elegida. No sobrescribe: el historial es
 * inmutable (0162) y la liquidación usa la vigente de cada día. El permiso
 * lo decide la base (`costs.manage`).
 */
export async function saveRiderDistrictPay(orgId: string, input: { riderId: string; districtKey: string; amount: number; from: string }): Promise<CourierActionResult> {
  const auth = await requireManager(orgId);
  if ("error" in auth) return auth;
  if (!DATE_RE.test(input.from)) return { error: "Elige la fecha desde la que rige." };
  const value = amount(input.amount);
  if (value == null) return { error: "Escribe un importe válido." };
  const admin = createAdminSupabase();
  const { data: rider } = await admin.from("riders").select("id,full_name").eq("id", input.riderId).eq("org_id", orgId).maybeSingle();
  if (!rider) return { error: "Motorizado no encontrado." };
  const { error } = await admin.rpc("rider_pay_save_rate", {
    p_rider: input.riderId,
    p_district: input.districtKey,
    p_amount: value,
    p_from: input.from,
    p_reason: "Tarifario de Grupo GF: pago por distrito",
    p_actor: auth.userId,
  });
  if (error) return { error: error.message };
  revalidatePath(COURIER_PATH);
  return { notice: `Pago de ${rider.full_name as string} guardado: S/ ${value.toFixed(2)} desde el ${input.from}.` };
}

/** Los pedidos de la org entre los marcados, con su tienda: nada de programar pedidos ajenos. */
async function ordersOfOrg(admin: Admin, orgId: string, orderIds: string[]): Promise<Map<string, string>> {
  const { data: stores } = await admin.from("stores").select("id").eq("org_id", orgId);
  const storeIds = new Set(((stores ?? []) as { id: string }[]).map((store) => store.id));
  const { data: orders } = await courierRowsByIds(orderIds, (ids) => admin.from("orders").select("id,store_id").in("id", ids));
  return new Map((orders as Array<{ id: string; store_id: string }>)
    .filter((order) => storeIds.has(order.store_id))
    .map((order) => [order.id, order.store_id]));
}

/**
 * Programar la salida (29-09-2026, MOM §29.6 y §29.13): guarda la fecha en
 * que debe salir cada pedido marcado en «Desde la lista», con actor y motivo,
 * SIN tomarlo. Ese día aparece en «Programados hoy». Uno ya tomado mueve
 * también su fecha prevista (`logistics_requests.scheduled_for`) para que las
 * dos digan lo mismo. Uno que ya está en la caja de un motorizado no se toca:
 * primero se quita de la caja. La fecha no puede ser anterior a hoy.
 */
export async function rescheduleGroupGfCourierOrders(
  orgId: string,
  orderIds: string[],
  day: string,
  rawReason = "",
): Promise<CourierActionResult> {
  const auth = await requireManager(orgId);
  if ("error" in auth) return auth;
  if (!auth.canManageDispatch) return { error: "No tienes permiso para organizar rutas." };
  if (!DATE_RE.test(day)) return { error: "Elige una fecha válida." };
  const today = limaClock().day;
  if (day < today) return { error: "La fecha no puede ser anterior a hoy." };
  const reason = rawReason.trim().replace(/\s+/g, " ").slice(0, 200);
  if (reason.length < 3) return { error: "Escribe el motivo: queda en el historial del pedido." };
  const ids = [...new Set(orderIds.filter(Boolean))];
  if (!ids.length) return { error: "Marca al menos un pedido." };
  const admin = createAdminSupabase();
  const { data: provider } = await admin.from("logistics_providers").select("id").eq("org_id", orgId).eq("code", "grupo-gf-courier").maybeSingle();
  if (!provider) return { error: "Grupo GF Courier no está activado." };
  const storeByOrder = await ordersOfOrg(admin, orgId, ids);
  const { data: requestRows, error: readError } = await admin
    .from("logistics_requests")
    .select("id,order_id,store_id,shipment_id,status,scheduled_for")
    .eq("provider_id", provider.id)
    .in("order_id", ids)
    .neq("status", "cancelled");
  if (readError) return { error: readError.message };
  const requests = (requestRows ?? []) as Array<{ id: string; order_id: string; store_id: string; shipment_id: string | null; status: string; scheduled_for: string }>;
  const byOrder = new Map(requests.map((r) => [r.order_id, r]));
  // En caja es tener un paquete activo en una caja, no el estado de la
  // solicitud: una retirada de la caja puede seguir «scheduled».
  const shipmentIds = requests.map((r) => r.shipment_id).filter((id): id is string => Boolean(id));
  const { data: boxed } = shipmentIds.length
    ? await admin.from("dispatch_manifest_items").select("shipment_id").in("shipment_id", shipmentIds).is("removed_at", null)
    : { data: [] };
  const inBoxShipments = new Set(((boxed ?? []) as { shipment_id: string }[]).map((row) => row.shipment_id));
  const previous = await loadPrograms(admin, { orderIds: ids });
  const label = programDayLabel(day);
  const now = new Date().toISOString();
  const inBox: string[] = [];
  const errors: string[] = [];
  const programmed: string[] = [];
  for (const orderId of ids) {
    const storeId = storeByOrder.get(orderId);
    if (!storeId) { errors.push("Un pedido no es de esta organización."); continue; }
    const request = byOrder.get(orderId);
    if (request?.shipment_id && inBoxShipments.has(request.shipment_id)) { inBox.push(orderId); continue; }
    // El mismo camino que el reporte de la parada con fecha (lib/gf-dispatch-program).
    const result = await writeGfDispatchProgram(admin, {
      orderId,
      storeId,
      day,
      reason,
      actor: auth.userId,
      request: request ?? null,
      from: previous.get(orderId)?.scheduled_for ?? null,
      now,
    });
    if (result.error) errors.push(result.error);
    if (!result.written) continue;
    programmed.push(orderId);
  }
  revalidatePath(COURIER_PATH);
  const parts: string[] = [];
  if (programmed.length) {
    parts.push(`${programmed.length} ${programmed.length === 1 ? "pedido programado" : "pedidos programados"} para el ${label}. ${day === today ? "Están en «Programados hoy»." : "Ese día aparecen en «Programados hoy»."}`);
  }
  if (inBox.length) parts.push(`${inBox.length} ya ${inBox.length === 1 ? "está" : "están"} en la caja de un motorizado: quítalos de la caja para programarlos.`);
  const unique = [...new Set(errors)];
  if (!programmed.length) return { error: [...parts, ...unique].join(" ") || "No se programó ningún pedido." };
  return unique.length || inBox.length ? { error: [...parts, ...unique].join(" ") } : { notice: parts.join(" ") };
}

/** «Quitar la fecha»: el pedido vuelve a su apartado de siempre. Queda en el historial. */
export async function clearGroupGfCourierPrograms(orgId: string, orderIds: string[]): Promise<CourierActionResult> {
  const auth = await requireManager(orgId);
  if ("error" in auth) return auth;
  if (!auth.canManageDispatch) return { error: "No tienes permiso para organizar rutas." };
  const ids = [...new Set(orderIds.filter(Boolean))];
  if (!ids.length) return { error: "Marca al menos un pedido." };
  const admin = createAdminSupabase();
  const storeByOrder = await ordersOfOrg(admin, orgId, ids);
  const programs = [...(await loadPrograms(admin, { orderIds: [...storeByOrder.keys()] })).values()];
  if (!programs.length) return { error: "Ninguno de esos pedidos tiene fecha programada." };
  const { error } = await admin.from("gf_dispatch_programs").delete().in("order_id", programs.map((p) => p.order_id));
  if (error) return { error: error.message };
  const now = new Date().toISOString();
  await admin.from("order_events").insert(programs.map((program) => ({
    store_id: program.store_id,
    order_id: program.order_id,
    kind: "dispatch_program_cleared",
    occurred_at: now,
    actor: auth.userId,
    source: "grupo_gf_courier",
    courier: "propio",
    note: `Se quitó la salida programada para el ${programDayLabel(program.scheduled_for)} («${program.reason}»).`,
    payload: { from: program.scheduled_for, reason: program.reason },
  })));
  revalidatePath(COURIER_PATH);
  return { notice: `${programs.length} ${programs.length === 1 ? "pedido vuelve" : "pedidos vuelven"} a la cola sin fecha programada.` };
}

export async function takeAndAssignGroupGfCourierOrders(orgId: string, riderId: string, orderIds: string[], opts: { overrideCash?: boolean; scheduledFor?: string | null; day?: string | null; confirmProgrammed?: boolean; tandersConfirmations?: TandersConfirmations } = {}): Promise<CourierActionResult> {
  const auth = await requireManager(orgId);
  if ("error" in auth) return auth;
  if (!auth.canManageDispatch) return { error: "No tienes permiso para organizar rutas." };
  const admin = createAdminSupabase();
  const { data: rider } = await admin.from("riders").select("id,courier").eq("id", riderId).eq("org_id", orgId).eq("active", true).maybeSingle();
  if (!rider || !isGroupGfRiderCourier(rider.courier)) return { error: "Elige un motorizado activo de Grupo GF." };
  // Programado para otro día: ni se toma sin confirmar (§29.6). Se mira antes
  // de tomar, para no dejar tomado lo que no se va a asignar.
  const boxDay = opts.day && DATE_RE.test(opts.day) ? opts.day : limaClock().day;
  const conflicts = opts.confirmProgrammed ? new Map<string, DispatchProgram>() : await programConflicts(admin, orderIds, boxDay);
  const held = [...conflicts.values()].map((program) => programConflictMessage(program, boxDay));
  const toTake = orderIds.filter((id) => !conflicts.has(id));
  if (!toTake.length) return { error: held.join(" ") || "Selecciona al menos un pedido." };
  const taken = await takeGroupGfCourierOrders(orgId, toTake, { scheduledFor: opts.scheduledFor ?? null, dispatchDay: opts.day ?? null, tandersConfirmations: opts.tandersConfirmations });
  const acceptedIds = [...taken.accepted.map((item) => item.orderId), ...taken.alreadyAccepted];
  if (!acceptedIds.length) return { error: [taken.error ?? "No se pudieron tomar los pedidos.", ...held].join(" ") };
  const { data: requests, error } = await admin.from("logistics_requests")
    .select("id,logistics_providers!inner(org_id)").in("order_id", acceptedIds)
    .eq("logistics_providers.org_id", orgId).in("status", ["accepted", "scheduled"]);
  if (error) return { notice: taken.notice, error: "Se tomaron los pedidos, pero no se pudieron asignar. Continúa desde Pedidos tomados." };
  const assigned = await assignGroupGfCourierRoute(orgId, riderId, (requests ?? []).map((request) => request.id), { ...opts, confirmProgrammed: true });
  const details = [...taken.failed.map((item) => `${item.orderId}: ${item.error}`), ...assigned.failed.map((item) => item.error), ...held];
  return { notice: [taken.notice, assigned.notice, assigned.cashWarning, assigned.error, ...details].filter(Boolean).join(" ") };
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
  opts: { overrideCash?: boolean; day?: string | null; confirmProgrammed?: boolean } = {},
): Promise<AssignCourierRouteResult> {
  const auth = await requireManager(orgId);
  if ("error" in auth) return { ...auth, assigned: 0, manifestIds: [], failed: [] };
  return assignRouteCore(auth, orgId, riderId, requestIds, opts, IMMEDIATE_EFFECTS);
}

async function assignRouteCore(
  auth: ManagerAuth,
  orgId: string,
  riderId: string,
  requestIds: string[],
  opts: { overrideCash?: boolean; day?: string | null; confirmProgrammed?: boolean },
  fx: SideEffects,
): Promise<AssignCourierRouteResult> {
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
      .select("id,cash_warning_amount,cash_limit_amount,rider_pickup_mode")
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
          .select("id,courier,custody_state,delivery_status")
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
    ((shipments ?? []) as Array<{ id: string; courier: string; custody_state: string | null; delivery_status: string | null }>)
      .map((shipment) => [shipment.id, shipment]),
  );
  const activeManifestByShipment = new Map(
    ((activeItems ?? []) as Array<{ shipment_id: string; manifest_id: string }>)
      .map((item) => [item.shipment_id, item.manifest_id]),
  );

  const today = limaClock().day;
  // Con `day` explícito (la mesa de despacho eligió el día de la caja), la
  // caja es ese día para todos, aunque la solicitud estuviera prevista para
  // otro; sin él, la caja es hoy o la fecha prevista si es posterior.
  const explicitDay = opts.day && DATE_RE.test(opts.day) && opts.day >= today ? opts.day : null;
  const boxDay = explicitDay ?? today;
  const programs = opts.confirmProgrammed
    ? new Map<string, DispatchProgram>()
    : await loadPrograms(admin, { orderIds: requests.map((request) => request.order_id) });
  // Un pedido en Por cerrar o Finalizado no entra en una caja (29-09-2026).
  const { data: stageRows } = await courierRowsByIds([...new Set(requests.map((request) => request.order_id))], (ids) => admin
    .from("order_master")
    .select("order_id,macro_stage")
    .in("order_id", ids));
  const stageByOrder = new Map((stageRows as Array<{ order_id: string; macro_stage: string | null }>).map((row) => [row.order_id, row.macro_stage]));
  const groups = new Map<string, AssignableRequest[]>();
  for (const request of requests) {
    if (!takenIsAssignable(stageByOrder.get(request.order_id))) {
      failed.push({ requestId: request.id, error: "El pedido ya está cerrado o cerrándose: no se asigna a una caja." });
      continue;
    }
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
    // Una salida anulada o entregada no entra en una caja: la toma pudo
    // reusar una salida que alguien anuló o cerró después (06-10-2026).
    if (shipment.delivery_status === "anulado" || shipment.delivery_status === "entregado") {
      failed.push({ requestId: request.id, error: `La salida está ${shipment.delivery_status}: no entra en una caja.` });
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
    // La caja es de hoy o del día que eligió el supervisor, nunca de un día
    // que ya pasó. Una solicitud tomada semanas atrás guarda su fecha prevista
    // de entonces; agrupar por ella abría la carga de ese día, cuya ruta ya
    // está liquidada, y el escaneo moría con «La ruta diaria ya está
    // liquidada». La fecha se mueve al día de la caja y queda en el historial.
    const routeDate = explicitDay ?? (request.scheduled_for < boxDay ? boxDay : request.scheduled_for);
    // Programado para otro día: se avisa y se pide confirmar (§29.6).
    const program = programs.get(request.order_id);
    if (program && programNeedsConfirm(program.scheduled_for, routeDate, today)) {
      failed.push({ requestId: request.id, error: programConflictMessage(program, routeDate) });
      continue;
    }
    if (routeDate !== request.scheduled_for) {
      const { error: moveError } = await admin
        .from("logistics_requests")
        .update({ scheduled_for: routeDate })
        .eq("id", request.id);
      if (moveError) {
        failed.push({ requestId: request.id, error: moveError.message });
        continue;
      }
      await admin.from("order_events").insert({
        store_id: request.store_id,
        order_id: request.order_id,
        kind: "logistics_request_rescheduled",
        occurred_at: new Date().toISOString(),
        actor: auth.userId,
        source: "grupo_gf_courier",
        courier: "propio",
        shipment_id: request.shipment_id,
        note: `Salida prevista movida del ${request.scheduled_for} al ${routeDate}: el paquete entra en la caja de ${rider.full_name} de ese día.`,
        payload: { requestId: request.id, from: request.scheduled_for, to: routeDate },
      });
      request.scheduled_for = routeDate;
    }
    groups.set(routeDate, [...(groups.get(routeDate) ?? []), request]);
  }

  let assigned = 0;
  const manifestIds: string[] = [];
  const changedOrderIds = new Set<string>();
  const cashWarnings: string[] = [];
  /** Lo que entró en una caja: su programación, si tenía, ya se cumplió. */
  const settled: Parameters<typeof settlePrograms>[2] = [];
  for (const [routeDate, group] of groups) {
    // Límites de efectivo de la ruta del día (MOM §29.9): lo que ya lleva el
    // motorizado ese día más lo que se le añade. Solo cuenta lo que se cobra
    // contra entrega (pedidos no pagados en Shopify).
    const cash = await routeCashForecast(admin, orgId, rider.id, routeDate, group.map((request) => request.order_id));
    const verdict = cashLimitVerdict({
      currentCod: cash.current,
      addingCod: cash.adding,
      warningAmount: amount((provider as { cash_warning_amount?: unknown }).cash_warning_amount),
      limitAmount: amount((provider as { cash_limit_amount?: unknown }).cash_limit_amount),
    });
    if (verdict.status === "blocked" && !opts.overrideCash) {
      for (const request of group) failed.push({ requestId: request.id, error: verdict.message ?? "Límite de efectivo superado." });
      continue;
    }
    if (verdict.message) cashWarnings.push(verdict.status === "blocked" ? `${verdict.message} Autorizado por ${auth.userId}.` : verdict.message);
    // Una carga por motorizado y día cuando la verificación está apagada
    // (0184): gf_dispatch_load_open devuelve la del día aunque ya esté en
    // custodia; con el flag encendido es gf_dispatch_load, sin cambios.
    const providerMode = (provider as { rider_pickup_mode?: string | null }).rider_pickup_mode;
    const custodyAtAssign = custodyOnAssign(isRiderPickupMode(providerMode) ? providerMode : "exigir");
    const { data: manifestId, error: loadError } = await admin.rpc("gf_dispatch_load_open", {
      p_org_id: orgId, p_rider_id: rider.id, p_day: routeDate, p_actor: auth.userId,
    });
    if (loadError || !manifestId) {
      for (const request of group) failed.push({ requestId: request.id, error: loadError?.message ?? "No se pudo abrir la carga." });
      continue;
    }
    const manifest = { id: manifestId as string };
    manifestIds.push(manifest.id);
    const { data: manifestRow } = await admin.from("dispatch_manifests").select("state").eq("id", manifest.id).maybeSingle();
    const loadInCustody = manifestRow?.state === "in_custody";
    let insertedAny = false;
    for (const request of group) {
      const shipmentId = request.shipment_id as string;
      const inserted = custodyAtAssign && loadInCustody
        // La caja ya salió: el paquete entra cotejado, en custodia y con su parada.
        ? await admin.rpc("gf_add_item_in_custody", { p_manifest_id: manifest.id, p_shipment_id: shipmentId, p_store_id: request.store_id, p_actor: auth.userId })
        // Caja aún sin custodia: fila nueva, o la que el motorizado rechazó
        // en esta misma caja y revive (0187), como al mover de caja.
        : await admin.from("dispatch_manifest_items").upsert({
            manifest_id: manifest.id,
            shipment_id: shipmentId,
            store_id: request.store_id,
            added_by: auth.userId,
            added_at: new Date().toISOString(),
            removed_at: null,
            removed_by: null,
            removal_reason: null,
            pickup_declined_at: null,
            pickup_declined_by: null,
            pickup_declined_reason: null,
          }, { onConflict: "manifest_id,shipment_id" });
      if (inserted.error) {
        failed.push({
          requestId: request.id,
          // Solo queda el índice de «un paquete activo a la vez»: está en otra caja.
          error: inserted.error.code === "23505"
            ? "El paquete ya está en otra caja activa."
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
      settled.push({ orderId: request.order_id, storeId: request.store_id, shipmentId, routeDate, riderName: rider.full_name });
      assigned += 1;
      insertedAny = true;
    }
    // Verificación del motorizado desactivada (0183): la custodia pasa al
    // asignar, el trigger crea las paradas y el motorizado ve su ruta.
    if (insertedAny && custodyAtAssign && !loadInCustody) {
      const { data: custodyOrders, error: custodyError } = await admin.rpc("gf_assign_custody", { p_manifest_id: manifest.id, p_actor: auth.userId });
      if (custodyError) {
        cashWarnings.push(`Asignados, pero la custodia no pasó sola: ${custodyError.message}`);
      } else {
        for (const id of (custodyOrders ?? []) as string[]) changedOrderIds.add(id);
        cashWarnings.push(`Custodia entregada a ${rider.full_name}: sus paquetes ya están en su ruta.`);
      }
    } else if (insertedAny && custodyAtAssign && loadInCustody) {
      cashWarnings.push(`Sumados a la ruta de hoy de ${rider.full_name}: ya están en su reparto.`);
    }
  }

  await settlePrograms(admin, auth.userId, settled);
  if (changedOrderIds.size) await fx.recompute([...changedOrderIds]);
  if (fx.revalidate) {
    revalidatePath(COURIER_PATH);
    revalidatePath("/dashboard/pedidos/despacho");
    revalidatePath("/dashboard/pedidos");
  }
  return {
    notice: assigned
      ? `${assigned} pedido${assigned === 1 ? "" : "s"} asignado${assigned === 1 ? "" : "s"} a la ruta diaria de ${rider.full_name}. Almacén puede terminar el armado en paralelo.`
      : undefined,
    error: assigned ? undefined : failed[0]?.error ?? "No se pudo asignar ningún pedido.",
    assigned,
    manifestIds: [...new Set(manifestIds)],
    failed,
    cashWarning: cashWarnings.length ? [...new Set(cashWarnings)].join(" ") : undefined,
  };
}

/**
 * Efectivo previsto de la ruta del motorizado en una fecha: suma del total de
 * los pedidos contra entrega que ya están en sus cargas ese día, y de los que
 * se quieren añadir. Un pedido pagado en Shopify no se cobra en la puerta.
 */
async function routeCashForecast(
  admin: ReturnType<typeof createAdminSupabase>,
  orgId: string,
  riderId: string,
  routeDate: string,
  addingOrderIds: string[],
): Promise<{ current: number; adding: number }> {
  const { data: manifests } = await admin
    .from("dispatch_manifests")
    .select("id")
    .eq("org_id", orgId)
    .eq("rider_id", riderId)
    .eq("route_date", routeDate)
    .neq("state", "cancelled");
  const manifestIds = ((manifests ?? []) as { id: string }[]).map((m) => m.id);
  let currentIds: string[] = [];
  if (manifestIds.length) {
    const { data: items } = await admin
      .from("dispatch_manifest_items")
      .select("shipments(order_id)")
      .in("manifest_id", manifestIds)
      .is("removed_at", null);
    currentIds = ((items ?? []) as unknown as { shipments: { order_id: string | null } | null }[])
      .map((i) => i.shipments?.order_id)
      .filter((id): id is string => Boolean(id));
  }
  const adding = new Set(addingOrderIds);
  const ids = [...new Set([...currentIds, ...adding])];
  if (!ids.length) return { current: 0, adding: 0 };
  const { data: orders } = await admin.from("orders").select("id,total_amount,financial_status").in("id", ids);
  let current = 0;
  let add = 0;
  for (const o of (orders ?? []) as { id: string; total_amount: number | string | null; financial_status: string | null }[]) {
    if (o.financial_status === "paid") continue;
    const total = amount(o.total_amount) ?? 0;
    if (adding.has(o.id)) add += total;
    else if (currentIds.includes(o.id)) current += total;
  }
  return { current: Math.round(current * 100) / 100, adding: Math.round(add * 100) / 100 };
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

// ---------------------------------------------------------------------------
// Despacho del día (MOM §29.13): mover un paquete entre cajas del mismo día.
// ---------------------------------------------------------------------------

export interface MoveManifestItemResult extends CourierActionResult {
  manifestId?: string;
}

/**
 * Mueve un paquete de la caja de un motorizado a la de otro, el mismo día.
 *
 * Antes era: retirar desde la mesa (con motivo) → volver a «Tomados» →
 * asignar al otro. Tres pantallas y ningún evento que dijera «pasó de Roy a
 * Yhoni». Ahora es una acción: retira del manifiesto origen (queda el rastro
 * con motivo), abre o reutiliza la carga del destino con `gf_dispatch_load`
 * (misma regla que asignar: desde 0196 la caja del destino admite paquetes
 * mientras no haya salido, aunque se esté cotejando), inserta el paquete y deja un
 * `dispatch_route_reassigned` en el pedido con origen y destino.
 */
export async function moveManifestItem(
  orgId: string,
  manifestId: string,
  shipmentId: string,
  targetRiderId: string,
  reason: string,
  /**
   * El paquete se acaba de escanear en la oficina: está en la mano, no en la
   * calle. Permite sacarlo de una caja ya en poder del motorizado aunque él lo
   * haya confirmado (`gf_office_reclaim`, 0230).
   */
  opts: { inHand?: boolean } = {},
): Promise<MoveManifestItemResult> {
  const auth = await requireManager(orgId);
  if ("error" in auth) return auth;
  if (!auth.canManageDispatch) return { error: "No tienes permiso para organizar rutas." };
  const cleanReason = reason.trim();
  if (cleanReason.length < 3) return { error: "Escribe por qué cambia de motorizado." };
  const admin = createAdminSupabase();
  const [{ data: manifest }, { data: rider }, { data: item }] = await Promise.all([
    admin.from("dispatch_manifests").select("id,org_id,courier,route_date,rider_id,driver_name,state").eq("id", manifestId).maybeSingle(),
    admin.from("riders").select("id,full_name,courier").eq("id", targetRiderId).eq("org_id", orgId).eq("active", true).maybeSingle(),
    admin.from("dispatch_manifest_items").select("id,shipment_id,store_id,removed_at").eq("manifest_id", manifestId).eq("shipment_id", shipmentId).is("removed_at", null).maybeSingle(),
  ]);
  if (!manifest || manifest.org_id !== orgId) return { error: "Caja no encontrada." };
  if (manifest.courier !== "propio") return { error: "Solo se mueven paquetes entre motorizados de Grupo GF." };
  if (manifest.state === "cancelled") return { error: "Esa caja ya está cerrada." };
  // Caja ya en custodia: solo en modo «confirmar» (0185) y solo lo que el
  // motorizado no confirmó; el RPC retira, borra la parada y libera el paquete.
  const sourceInCustody = manifest.state === "in_custody";
  // Escaneado en oficina: la prueba de que el paquete no salió. Se recupera de
  // la caja del motorizado aunque él lo haya confirmado (0230).
  const reclaimInOffice = sourceInCustody && opts.inHand === true;
  if (sourceInCustody && !reclaimInOffice && (await riderPickupMode(admin, orgId)) !== "confirmar") {
    return { error: `Esa caja ya está en poder de ${manifest.driver_name ?? "el motorizado"}. Si el paquete está en la oficina, escanéalo aquí y pulsa «Mover».` };
  }
  if (!rider || !isGroupGfRiderCourier(rider.courier)) return { error: "Elige un motorizado activo de Grupo GF." };
  if (manifest.rider_id === rider.id) return { error: "El paquete ya está en la caja de ese motorizado." };
  if (!item) return { error: "El paquete ya no está en esa caja." };
  const { data: shipment } = await admin
    .from("shipments")
    .select("id,store_id,order_id,order_name,courier,guide_code,custody_state")
    .eq("id", shipmentId)
    .maybeSingle();
  if (!shipment) return { error: "Paquete no encontrado." };
  if (shipment.custody_state !== (sourceInCustody ? "courier" : "empresa")) return { error: "El paquete ya no está en custodia de Grupo GF." };

  // 1) abrir (o reutilizar) la carga del destino ANTES de retirar: si el
  // destino no admite paquetes, el origen no se toca.
  const { data: targetManifestId, error: loadError } = await admin.rpc("gf_dispatch_load_open", {
    p_org_id: orgId, p_rider_id: rider.id, p_day: manifest.route_date, p_actor: auth.userId,
  });
  if (loadError || !targetManifestId) {
    return { error: loadError?.message ?? "No se pudo abrir la caja del otro motorizado." };
  }
  const { data: targetRow } = await admin.from("dispatch_manifests").select("state").eq("id", targetManifestId as string).maybeSingle();
  const targetInCustody = targetRow?.state === "in_custody";
  const now = new Date().toISOString();
  const fromName = manifest.driver_name ?? "otro motorizado";
  // 2) retirar del origen con el rastro (en custodia, por el RPC que además
  // borra la parada pendiente y devuelve la custodia a la empresa)
  const { error: removeError } = reclaimInOffice
    ? await admin.rpc("gf_office_reclaim", { p_manifest_id: manifestId, p_shipment_id: shipmentId, p_reason: cleanReason, p_actor: auth.userId, p_moved_to_rider: rider.id })
    : sourceInCustody
    ? await admin.rpc("gf_supervisor_withdraw", { p_manifest_id: manifestId, p_shipment_id: shipmentId, p_reason: cleanReason, p_actor: auth.userId, p_moved_to_rider: rider.id })
    : await admin
        .from("dispatch_manifest_items")
        .update({ removed_at: now, removed_by: auth.userId, removal_reason: `Movido a ${rider.full_name}: ${cleanReason}` })
        .eq("id", item.id)
        .is("removed_at", null);
  if (removeError) return { error: removeError.message };
  // 3) meter en el destino (si ya salió y la verificación está apagada, entra en custodia con su parada)
  const { error: insertError } = targetInCustody
    ? await admin.rpc("gf_add_item_in_custody", { p_manifest_id: targetManifestId as string, p_shipment_id: shipmentId, p_store_id: item.store_id, p_actor: auth.userId })
    : await admin.from("dispatch_manifest_items").insert({
        manifest_id: targetManifestId as string,
        shipment_id: shipmentId,
        store_id: item.store_id,
        added_by: auth.userId,
      });
  if (insertError) {
    if (sourceInCustody) {
      // El retiro ya quedó hecho por el RPC: el paquete está en «por asignar».
      return { error: `${insertError.code === "23505" ? "El paquete ya está en otra caja activa." : insertError.message} Quedó fuera de la caja de ${fromName}, en «por asignar».` };
    }
    // Deshacer el retiro para no dejar el paquete en el limbo.
    await admin.from("dispatch_manifest_items").update({ removed_at: null, removed_by: null, removal_reason: null }).eq("id", item.id);
    return { error: insertError.code === "23505" ? "El paquete ya está en otra caja activa." : insertError.message };
  }
  if (!sourceInCustody) {
    await recalculateManifestState(admin, manifestId, auth.userId);
    // 0196: sacar el último pendiente puede dejar la caja de origen completa;
    // entonces la custodia pasa y la ruta de ese motorizado aparece.
    const { data: finalized, error: finalizeError } = await admin.rpc("gf_finalize_if_complete", { p_manifest_id: manifestId, p_actor: auth.userId });
    if (finalizeError) console.error("[courier] no se pudo cerrar la caja de origen completa", finalizeError.message);
    else if ((finalized ?? []).length) await recomputeOrderMasterSafe(admin, finalized as string[]);
  }
  await Promise.all([
    admin.from("dispatch_events").insert([
      { org_id: orgId, manifest_id: manifestId, shipment_id: shipmentId, actor: auth.userId, kind: "package_removed", payload: { reason: cleanReason, moved_to: rider.id, moved_to_manifest: targetManifestId } },
      { org_id: orgId, manifest_id: targetManifestId as string, shipment_id: shipmentId, actor: auth.userId, kind: "package_added", payload: { source: "grupo_gf_courier", moved_from: manifest.rider_id, moved_from_manifest: manifestId } },
    ]),
    shipment.order_id
      ? admin.from("order_events").insert({
          store_id: shipment.store_id,
          order_id: shipment.order_id,
          kind: "dispatch_route_reassigned",
          occurred_at: now,
          actor: auth.userId,
          source: "grupo_gf_courier",
          courier: "propio",
          guide_code: shipment.guide_code,
          shipment_id: shipment.id,
          reason: cleanReason,
          note: `Pasó de la caja de ${fromName} a la de ${rider.full_name}.`,
          payload: { from_rider_id: manifest.rider_id, from_manifest_id: manifestId, to_rider_id: rider.id, to_manifest_id: targetManifestId, route_date: manifest.route_date },
        })
      : Promise.resolve(),
    // Está en otra caja: «scheduled». En custodia, el retiro (0185) la había
    // devuelto a «accepted» y quedaba así dentro de la caja nueva.
    admin
      .from("logistics_requests")
      .update({ observation: null, status: "scheduled" })
      .in("status", ["accepted", "scheduled"])
      .eq("shipment_id", shipmentId)
      .eq("provider_id", (await admin.from("logistics_providers").select("id").eq("org_id", orgId).eq("code", "grupo-gf-courier").maybeSingle()).data?.id ?? "00000000-0000-0000-0000-000000000000"),
  ]);
  if (shipment.order_id) await recomputeOrderMasterSafe(admin, [shipment.order_id]);
  for (const path of ["/dashboard/courier", "/dashboard/courier/rutas", "/dashboard/pedidos"]) revalidatePath(path);
  return { notice: `${shipment.order_name ?? "Paquete"} pasó a la caja de ${rider.full_name}.`, manifestId: targetManifestId as string };
}

/** Estado derivado del manifiesto tras tocar sus paquetes (misma regla que la mesa). */
async function recalculateManifestState(admin: ReturnType<typeof createAdminSupabase>, manifestId: string, actor: string) {
  const [{ data: manifest }, { data: items }] = await Promise.all([
    admin.from("dispatch_manifests").select("state,kind").eq("id", manifestId).single(),
    admin.from("dispatch_manifest_items").select("removed_at,office_checked_at,pickup_checked_at").eq("manifest_id", manifestId),
  ]);
  const { deriveDispatchManifestState } = await import("@/lib/dispatch");
  const next = deriveDispatchManifestState(items ?? [], (manifest?.state ?? "draft") as never, (manifest?.kind ?? "reparto") as never);
  const active = (items ?? []).filter((item) => !item.removed_at);
  const officeComplete = active.length > 0 && active.every((item) => !!item.office_checked_at);
  await admin
    .from("dispatch_manifests")
    .update({ state: next, office_completed_at: officeComplete ? new Date().toISOString() : null, office_completed_by: officeComplete ? actor : null })
    .eq("id", manifestId);
}

// ---------------------------------------------------------------------------
// Modo escaneo (MOM §29.13): un QR = tomar + asignar. La verificación de
// oficina es un paso aparte y obligatorio en «Verificar caja» (22-09-2026).
// ---------------------------------------------------------------------------

export type ScanAssignStatus =
  /** Solo en el navegador: el QR se leyó y espera respuesta del servidor. */
  | "procesando"
  | "asignado"
  | "ya_en_caja"
  | "en_otra_caja"
  | "no_elegible"
  | "bloqueado_efectivo"
  /** Programado para otro día (0199): se asigna solo si se confirma. */
  | "programado_otro_dia"
  | "desconocido";

export interface ScanAssignLine {
  /** Solo en el navegador: por qué falló «Mover» en esta fila. */
  moveError?: string | null;
  code: string;
  status: ScanAssignStatus;
  orderId: string | null;
  orderName: string | null;
  shipmentId: string | null;
  /** Caja donde quedó (o donde ya estaba). */
  manifestId: string | null;
  riderName: string | null;
  amount: number | null;
  message: string;
  cashWarning?: string | null;
  /** Con `programado_otro_dia`: el día para el que estaba programado. */
  programmedFor?: string | null;
  /**
   * El paquete volvió de la caja de un día anterior y este escaneo lo recibió
   * en oficina antes de asignarlo: «Yhoni del 26/09».
   */
  receivedFrom?: string | null;
  /**
   * Se leyó el rótulo de otra salida del pedido (la de Tanders que no entregó)
   * y la caja entró como esta: su rótulo es el que hay que imprimir y pegar.
   */
  relabel?: { outputCode: string | null; labelUrl: string } | null;
}

/**
 * El supervisor escanea el paquete: ese gesto toma el pedido (si hace falta)
 * y lo pone en la caja del motorizado del día. NO lo coteja: desde el
 * 22-09-2026 asignar por QR y desde la lista es lo mismo, y alguien en
 * oficina verifica después, en «Verificar caja», que el paquete está de verdad
 * en la caja física del motorizado. Antes el mismo escaneo dejaba el cotejo
 * hecho y la caja se saltaba ese control. Devuelve una línea para la lista viva.
 */
export async function scanAssignToRider(
  orgId: string,
  riderId: string,
  rawCode: string,
  opts: { overrideCash?: boolean; scheduledFor?: string | null; confirmProgrammed?: boolean } = {},
): Promise<ScanAssignLine> {
  const code = normalizeDispatchScan(rawCode).slice(0, 200);
  const base: ScanAssignLine = { code, status: "desconocido", orderId: null, orderName: null, shipmentId: null, manifestId: null, riderName: null, amount: null, message: "" };
  if (!code) return { ...base, message: "Escanea el QR o el código del paquete." };
  const auth = await requireManager(orgId);
  if ("error" in auth) return { ...base, status: "no_elegible", message: auth.error };
  if (!auth.canManageDispatch) return { ...base, status: "no_elegible", message: "No tienes permiso para organizar rutas." };
  const admin = createAdminSupabase();
  // Lecturas independientes, después de comprobar permisos. El proveedor se
  // reutiliza durante esta toma; asignar vuelve a validar su configuración activa.
  const [{ data: rider }, found, { data: gfProvider }] = await Promise.all([
    admin.from("riders").select("id,full_name,courier").eq("id", riderId).eq("org_id", orgId).eq("active", true).maybeSingle(),
    lookupDispatchShipment(code),
    admin.from("logistics_providers").select("id").eq("org_id", orgId).eq("code", "grupo-gf-courier").maybeSingle(),
  ]);
  if (!rider || !isGroupGfRiderCourier(rider.courier)) return { ...base, status: "no_elegible", message: "Elige un motorizado activo de Grupo GF." };

  // 1) ¿A qué pedido apunta el código? Primero como salida (QR, código de
  // salida, guía); si no, como número de pedido de las tiendas de la org.
  let orderId: string | null = null;
  let shipmentId: string | null = null;
  if (found.shipment) {
    orderId = found.shipment.order_id;
    shipmentId = found.shipment.id;
  } else if (!found.error?.includes("salidas")) {
    const name = code.replace(/^#/, "");
    const { data: stores } = await admin.from("stores").select("id").eq("org_id", orgId);
    const storeIds = ((stores ?? []) as { id: string }[]).map((s) => s.id);
    const { data: orders } = await admin.from("orders").select("id,name").in("store_id", storeIds).or(`name.ilike.${name},name.ilike.#${name}`).limit(2);
    if (orders?.length === 1) orderId = orders[0]!.id;
  } else {
    return { ...base, message: found.error ?? "Ese pedido tiene varias salidas: escanea el QR de la caja." };
  }
  if (!orderId) return { ...base, message: "No encontramos un pedido con ese QR, guía o número." };
  // Un pedido anulado no entra a ninguna caja: se dice eso y nada más (lib/scan-cancelled.ts).
  const cancelled = await cancelledScanNotice(admin, orderId);
  if (cancelled) return { ...base, orderId, shipmentId, status: "no_elegible", message: cancelled };
  const [{ data: om }, { data: active }] = await Promise.all([
    admin.from("order_master").select("order_name,order_total,store_id").eq("order_id", orderId).maybeSingle(),
    shipmentId ? admin
      .from("dispatch_manifest_items")
      .select("id,manifest_id,office_checked_at,dispatch_manifests!inner(id,rider_id,driver_name,route_date,state)")
      .eq("shipment_id", shipmentId)
      .is("removed_at", null)
      .maybeSingle() : Promise.resolve({ data: null }),
  ]);
  const line: ScanAssignLine = { ...base, orderId, shipmentId, orderName: (om?.order_name as string | null) ?? null, amount: om?.order_total == null ? null : Number(om.order_total), riderName: rider.full_name };

  // El día de la caja que se arma: hoy, o el que eligió el supervisor.
  const boxDay = opts.scheduledFor && DATE_RE.test(opts.scheduledFor) ? opts.scheduledFor : limaClock().day;
  let receivedFrom: string | null = null;

  // 2) ¿Ya está en una caja activa?
  if (shipmentId) {
    const box = (active as { id: string; manifest_id: string; office_checked_at: string | null; dispatch_manifests: { rider_id: string | null; driver_name: string | null; route_date: string; state: string } } | null) ?? null;
    // Una caja de un día ANTERIOR (lib/gf-scan-return.ts): escanearlo en
    // oficina prueba que volvió. Un «No entregado» se recibe y se asigna en el
    // mismo gesto; antes respondía «Ya estaba» y no entraba en la ruta de hoy.
    if (box && box.dispatch_manifests.route_date < boxDay) {
      const fromName = box.dispatch_manifests.driver_name ?? "otro motorizado";
      const { data: stop } = await admin
        .from("delivery_stops")
        .select("status,outcome_reason")
        .eq("shipment_id", shipmentId)
        .eq("dispatch_manifest_id", box.manifest_id)
        .order("reported_at", { ascending: false, nullsFirst: false })
        .limit(1)
        .maybeSingle();
      const decision = pastBoxDecision({
        boxRouteDate: box.dispatch_manifests.route_date,
        targetDay: boxDay,
        stopStatus: (stop?.status as string | null) ?? null,
        outcomeReason: (stop?.outcome_reason as string | null) ?? null,
      });
      if (decision === "entregado" || decision === "sin_reporte") {
        return { ...line, status: "no_elegible", manifestId: box.manifest_id, message: pastBoxMessage(decision, fromName, box.dispatch_manifests.route_date) };
      }
      const { error: returnError } = await admin.rpc("gf_return_to_office", { p_item_id: box.id, p_actor: auth.userId });
      if (returnError) return { ...line, status: "no_elegible", manifestId: box.manifest_id, message: returnError.message };
      receivedFrom = receivedFromLabel(fromName, box.dispatch_manifests.route_date);
    } else if (box) {
      if (box.dispatch_manifests.rider_id === rider.id) {
        return {
          ...line,
          status: "ya_en_caja",
          manifestId: box.manifest_id,
          message: box.office_checked_at
            ? `Ya estaba en la caja de ${rider.full_name}, verificado en oficina.`
            : `Ya estaba en la caja de ${rider.full_name}; falta verificarlo en oficina.`,
        };
      }
      return { ...line, status: "en_otra_caja", manifestId: box.manifest_id, riderName: box.dispatch_manifests.driver_name ?? "otro motorizado", message: `Está en la caja de ${box.dispatch_manifests.driver_name ?? "otro motorizado"} del ${box.dispatch_manifests.route_date}.` };
    }
  }

  // Lo que se diga de aquí en adelante sobre un paquete recibido lo cuenta:
  // salió de la caja vieja aunque no llegue a entrar en la nueva.
  const receivedNote = receivedFrom ? `Recibido en oficina (salió de la caja de ${receivedFrom}). ` : "";
  if (receivedFrom) line.receivedFrom = receivedFrom;

  // 3) ¿Programado para otro día? Se avisa antes de tomar nada (§29.6); la
  // línea ofrece «Asignar igual», que vuelve aquí con `confirmProgrammed`.
  if (!opts.confirmProgrammed) {
    const conflict = (await programConflicts(admin, [orderId], boxDay)).get(orderId);
    if (conflict) {
      if (receivedFrom) await recomputeOrderMasterSafe(admin, [orderId]);
      return { ...line, status: "programado_otro_dia", programmedFor: conflict.scheduled_for, message: receivedNote + programConflictMessage(conflict, boxDay) };
    }
  }

  // 4) Tomar (idempotente) y asignar.
  // Un solo control de permisos (arriba) y efectos diferidos: ver `SideEffects`.
  const fx = deferredEffects();
  try {
  // Recibido de una caja vieja: el Master se entera al final, con lo demás.
  if (receivedFrom) await fx.recompute([orderId]);
  const taken = await takeOrdersCore(auth, orgId, [orderId], { dispatchDay: opts.scheduledFor ?? limaClock().day }, fx, { gfProvider });
  if (taken.failed.length) return { ...line, status: "no_elegible", message: receivedNote + taken.failed[0]!.error };
  if (!taken.accepted.length && !taken.alreadyAccepted.length) return { ...line, status: "no_elegible", message: receivedNote + (taken.error ?? "No se pudo tomar el pedido.") };
  const { data: requests } = await admin.from("logistics_requests").select("id,shipment_id").eq("order_id", orderId).eq("provider_id", gfProvider?.id ?? "").in("status", ["accepted", "scheduled"]);
  const requestIds = ((requests ?? []) as { id: string }[]).map((r) => r.id);
  if (!requestIds.length) return { ...line, status: "no_elegible", message: receivedNote + "El pedido se tomó pero no se pudo asignar. Continúa desde la lista." };
  // La programación ya se miró arriba (o se confirmó): no se vuelve a leer.
  const assigned = await assignRouteCore(auth, orgId, rider.id, requestIds, { overrideCash: opts.overrideCash, day: opts.scheduledFor ?? null, confirmProgrammed: true }, fx);
  if (!assigned.assigned) {
    const why = assigned.failed[0]?.error ?? assigned.error ?? "No se pudo asignar.";
    return { ...line, status: /efectivo|límite/i.test(why) ? "bloqueado_efectivo" : "no_elegible", message: receivedNote + why };
  }
  const manifestId = assigned.manifestIds[0] ?? null;
  // Se leyó el rótulo de OTRA salida del pedido —el de Tanders que no entregó,
  // típicamente— y la caja entró como la salida que se rellenó o nació al
  // tomarlo. Su rótulo es el que tiene que llevar: se nombra y se ofrece.
  // La salida que entró es la de la solicitud: la que se rellenó o nació en
  // esta toma, o la de una toma anterior («Desde la lista», sin rótulo impreso
  // todavía), que es justo el caso en que la caja aún lleva el rótulo viejo.
  const took = taken.accepted[0] ?? null;
  const requestShipmentId = took?.shipmentId
    ?? ((requests ?? []) as { shipment_id: string | null }[]).find((request) => request.shipment_id)?.shipment_id
    ?? null;
  let relabel: ScanAssignLine["relabel"] = null;
  if (requestShipmentId && found.shipment && requestShipmentId !== found.shipment.id) {
    const outputCode = took?.outputCode ?? ((await admin.from("shipments").select("output_code").eq("id", requestShipmentId).maybeSingle())
      .data as { output_code?: string | null } | null)?.output_code ?? null;
    relabel = { outputCode, labelUrl: `/api/pedidos/rotulos?ids=${requestShipmentId}` };
  }
  const relabelNote = relabel && found.shipment
    ? ` ${previousLabelNote({ outputCode: found.shipment.output_code, courier: found.shipment.courier }, relabel.outputCode)}`
    : "";
  return {
    ...line,
    status: "asignado",
    manifestId,
    shipmentId: requestShipmentId ?? shipmentId,
    message: `${receivedNote}Asignado a ${rider.full_name}.${relabelNote} Falta verificarlo en oficina («Verificar caja»).`,
    cashWarning: assigned.cashWarning ?? null,
    relabel,
  };
  } finally {
    fx.flush();
  }
}

/** Lo que el panel lateral de Rutas necesita para enseñar una caja (MOM §29.14). */
export interface CourierBoxDetail {
  data: DispatchWorkspaceData;
  /** Caja elegida; null cuando la ruta no tiene caja (vino del cuaderno). */
  manifestId: string | null;
  route: {
    id: string;
    routeDate: string;
    status: string;
    riderName: string;
    settlementStatus: string | null;
  } | null;
  stores: { id: string; name: string }[];
  canManage: boolean;
  canPickup: boolean;
}

/**
 * Detalle de una caja o de una ruta para el panel lateral. Entra quien coteja
 * (dispatch.manage), quien recibe (dispatch.pickup) o quien administra el
 * courier; RLS acota lo demás.
 */
export async function loadCourierBox(request: { manifestId?: string | null; routeId?: string | null }): Promise<CourierBoxDetail | { error: string }> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const [permissions, stores] = await Promise.all([getMasterPermissions(), getAccessibleStores()]);
  const canManage = permissions.can("dispatch.manage");
  const canPickup = permissions.can("dispatch.pickup");
  if (!canManage && !canPickup && !permissions.can("logistics.manage") && !permissions.can("routes.manage")) {
    return { error: "Tu rol no abre cajas de despacho." };
  }
  const sb = await createServerSupabase();
  let manifestId = request.manifestId?.trim() || null;
  let routeId = request.routeId?.trim() || null;
  if (manifestId && !routeId) {
    const { data } = await sb.from("dispatch_manifests").select("delivery_route_id").eq("id", manifestId).maybeSingle();
    routeId = (data?.delivery_route_id as string | null) ?? null;
  }
  if (!manifestId && routeId) {
    // La última carga de la ruta: es la que se está trabajando.
    const { data } = await sb
      .from("dispatch_manifests")
      .select("id")
      .eq("delivery_route_id", routeId)
      .eq("courier", "propio")
      .neq("state", "cancelled")
      .order("load_number", { ascending: false })
      .limit(1)
      .maybeSingle();
    manifestId = (data?.id as string | undefined) ?? null;
  }
  if (!manifestId && !routeId) return { error: "No encontramos esa caja." };

  let route: CourierBoxDetail["route"] = null;
  if (routeId) {
    const { data: routeRow } = await sb
      .from("delivery_routes")
      .select("id,route_date,status,rider_id,settlement_id")
      .eq("id", routeId)
      .maybeSingle();
    if (routeRow) {
      const r = routeRow as { id: string; route_date: string; status: string; rider_id: string; settlement_id: string | null };
      const [{ data: rider }, { data: settlement }] = await Promise.all([
        sb.from("riders").select("full_name").eq("id", r.rider_id).maybeSingle(),
        r.settlement_id ? sb.from("rider_settlements").select("status").eq("id", r.settlement_id).maybeSingle() : Promise.resolve({ data: null as { status: string } | null }),
      ]);
      route = {
        id: r.id,
        routeDate: r.route_date,
        status: r.status,
        riderName: (rider?.full_name as string | undefined) ?? "Motorizado",
        settlementStatus: (settlement?.status as string | undefined) ?? (r.settlement_id ? "borrador" : null),
      };
    }
  }
  const data = await getDispatchWorkspaceData(manifestId);
  if (manifestId && !data.manifests.some((m) => m.id === manifestId)) return { error: "No encontramos esa caja." };
  if (!manifestId && !route) return { error: "No encontramos esa ruta." };
  return {
    data,
    manifestId,
    route,
    stores: stores.map((s) => ({ id: s.id, name: s.name })),
    canManage,
    canPickup,
  };
}

export interface CourierRouteReport {
  stores: { id: string; name: string }[];
  riders: RiderRow[];
  detail: { route: RouteRow; stops: StopWithOrder[] };
  day: string;
  canReport: boolean;
  /** Cargas de Grupo GF de la ruta, para decir qué impide terminarla ANTES de
   *  pulsar. Null si no se pudo leer: el panel lo dice en vez de callarlo. */
  closeContext: RouteCloseContext | null;
  /** Cancela aquí mismo una carga abierta y vacía (dispatch.manage). */
  canCancelLoads: boolean;
}

/**
 * Reparto y liquidación de una ruta para el panel lateral de Rutas (MOM
 * §29.14): lo que antes cargaba la página /dashboard/courier/reparto. Entra
 * quien arma rutas (routes.manage); RLS acota lo demás.
 *
 * El panel no añade paradas —eso es de la caja y de Despacho del día—, así que
 * no carga la muestra de pedidos asignables (~1.800) ni la cola de reintentos:
 * se pedían en cada apertura y no se enseñaban nunca.
 */
export async function loadCourierRouteReport(routeId: string): Promise<CourierRouteReport | { error: string }> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const [permissions, stores] = await Promise.all([getMasterPermissions(), getAccessibleStores()]);
  if (!stores.length) return { error: "No tienes tiendas asignadas." };
  if (!permissions.can("routes.manage")) return { error: "Tu rol no arma rutas: el reparto se reporta desde /reparto." };
  const id = routeId.trim();
  if (!id) return { error: "No encontramos esa ruta." };
  const detail = await getRouteDetail(id);
  if (!detail) return { error: "No encontramos esa ruta." };
  const day = detail.route.route_date;
  const [riders, access, closeContext] = await Promise.all([
    getRiders(),
    routeReportAccess(id),
    loadRouteCloseContext(createAdminSupabase(), id),
  ]);
  return {
    stores: stores.map((s) => ({ id: s.id, name: s.name })),
    riders,
    detail,
    day,
    canReport: Boolean(access),
    closeContext,
    canCancelLoads: permissions.can("dispatch.manage"),
  };
}
