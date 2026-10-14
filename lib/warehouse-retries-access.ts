// Almacén: «Reintentos por salir» en el servidor (fase 1, entrega 1c; MOM §9.5).
//
// Entra quien prepara paquetes (`warehouse.prepare`) en las tiendas que tiene
// en Equipo (`getAccessibleStores`): el rol «Almacén» no abre Despacho del día
// ni Repro Lima, y aquí ve sus fechas. La puerta va dentro del cargador
// (`requireWarehouse`): la acción del servidor es un endpoint público y las
// lecturas usan el cliente de servicio, siempre acotadas a esas tiendas.
//
// Solo lee: no programa, no toma, no cierra casos, no escribe eventos ni
// recalcula el Master. Las filas salen del mismo motor que Repro Lima
// (`loadReproLima`, sin cerrar casos: `closeStale: false`) y se proyectan en
// lib/warehouse-retries.ts. Nunca lanza: si algo falla, la estación de arriba
// sigue funcionando y esta parte dice que no pudo cargar.

import { redirect, unstable_rethrow } from "next/navigation";
import { createAdminSupabase } from "@/lib/db";
import { getAccessibleStores, getCurrentUser } from "@/lib/access";
import { getMasterPermissions } from "@/lib/permissions-access";
import { courierRowsByIds } from "@/lib/courier-flow";
import { limaClock, nextDay, sameDayCutoffLabel, sameDayCutoffMinute } from "@/lib/grupo-gf-courier";
import { loadReproLima, REPRO_NO_STORES, type ReproScope } from "@/lib/repro-lima-access";
import { REPRO_CASE_COLUMNS, type ReproCaseRow } from "@/lib/repro-lima-program";
import { guideFailedAfterDispatch } from "@/lib/reproprovincia";
import { sameCourier } from "@/lib/shipment-output";
import {
  emptyWarehouseRetries,
  retryCounts,
  sortHandoffs,
  warehouseHandoffRow,
  warehouseRetryRows,
  HANDOFF_BOX_ACTIONS,
  RETRY_ERROR,
  type HandoffShipment,
  type WarehouseHandoffRow,
  type WarehouseRetriesData,
} from "@/lib/warehouse-retries";

/** Sin `warehouse.prepare`. */
export const WAREHOUSE_NO_PERMISSION = "No tienes acceso al almacén.";

/** Cuántos pedidos de la etapa se leen como mucho; el resto va en `omitted`. */
export const RETRY_CANDIDATES_MAX = 300;
/** De cuántos en cuántos se leen con el motor de Repro Lima. */
const RETRY_CHUNK = 100;
/** Hasta cuándo se mira un acuerdo cerrado por dejar la etapa («Ya en «Por armar»»); el abierto, siempre. */
const HANDOFF_DAYS = 14;
const DAY_MS = 86_400_000;

type Read<T> = PromiseLike<{ data: T[] | null; error: { message: string } | null }>;

/**
 * La puerta: sin sesión, a /login; sin `warehouse.prepare` o sin tiendas, el
 * motivo. Devuelve el mismo alcance que Repro Lima. No reusa `requireReproLima`:
 * el rol «Almacén» no tiene `repro_lima.manage`.
 */
export async function requireWarehouse(): Promise<ReproScope | { error: string }> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const permissions = await getMasterPermissions();
  if (!permissions.can("warehouse.prepare")) return { error: WAREHOUSE_NO_PERMISSION };
  const stores = await getAccessibleStores();
  if (!stores.length) return { error: REPRO_NO_STORES };
  return { userId: user.id, storeIds: new Set(stores.map((store) => store.id)) };
}

/**
 * «Reintentos por salir»: las cajas de la etapa que salen hoy (con lo vencido)
 * o mañana y los acuerdos que ya están en «Por armar». Nunca lanza.
 */
export async function getWarehouseRetries(now: Date = new Date()): Promise<WarehouseRetriesData> {
  const today = limaClock(now).day;
  const nowIso = now.toISOString();
  try {
    const scope = await requireWarehouse();
    if ("error" in scope) return emptyWarehouseRetries({ today, nowIso, error: scope.error });
    return await loadRetries(createAdminSupabase(), scope, now);
  } catch (error) {
    // La redirección a /login (y lo demás de Next) no es un fallo: sigue su camino.
    unstable_rethrow(error);
    console.error("almacen: reintentos por salir", error instanceof Error ? error.message : error);
    return emptyWarehouseRetries({ today, nowIso, error: RETRY_ERROR });
  }
}

async function loadRetries(admin: ReturnType<typeof createAdminSupabase>, scope: ReproScope, now: Date): Promise<WarehouseRetriesData> {
  const today = limaClock(now).day;
  const tomorrow = nextDay(today);
  const nowIso = now.toISOString();
  const storeIds = [...scope.storeIds];
  if (!storeIds.length) return emptyWarehouseRetries({ today, nowIso });
  // Cada lectura va por las tiendas de quien mira, de 100 en 100.
  const byStores = <T>(read: (chunk: string[]) => Read<T>): Promise<T[]> =>
    courierRowsByIds(storeIds, read).then((result) => result.data);

  // Los acuerdos con salida nueva, sea cual sea su día acordado: los candidatos
  // de «Ya en «Por armar»». Su pedido y su día se filtran después
  // (`loadHandoffs`): manda el programa vigente o la caja, y Grupo GF pudo
  // adelantarlo a hoy o mañana aunque el acuerdo sea para después.
  const handoffAgreements = (chunk: string[]) => admin
    .from("lima_repro_cases")
    .select(REPRO_CASE_COLUMNS)
    .in("store_id", chunk)
    .not("agreed_on", "is", null)
    .in("box_action", [...HANDOFF_BOX_ACTIONS]);

  // Oleada 1: programas hasta mañana (lo vencido incluido), acuerdos abiertos
  // para hoy o mañana, acuerdos que pudieron dejar la etapa (con el caso
  // abierto o cerrado por eso), tiendas y el corte.
  // El corte es el del proveedor de la primera tienda, como Repro Lima, y nunca
  // fijo (D6): se lee solo para las organizaciones de esas tiendas.
  const [programs, openCases, openHandoffCases, closedHandoffCases, { visibleStores, headerCutoff }] = await Promise.all([
    byStores<{ order_id: string; scheduled_for: string }>((chunk) => admin
      .from("gf_dispatch_programs")
      .select("order_id,scheduled_for")
      .in("store_id", chunk)
      .lte("scheduled_for", tomorrow) as unknown as Read<{ order_id: string; scheduled_for: string }>),
    byStores<{ order_id: string; agreed_on: string }>((chunk) => admin
      .from("lima_repro_cases")
      .select("order_id,agreed_on")
      .in("store_id", chunk)
      .is("closed_at", null)
      .gte("agreed_on", today)
      .lte("agreed_on", tomorrow) as unknown as Read<{ order_id: string; agreed_on: string }>),
    // Abiertos: Almacén lee sin cerrar casos (`closeStale: false`), así que el
    // caso de un pedido que su salida nueva ya llevó a «Por armar» sigue abierto
    // hasta que alguien abra Repro Lima.
    byStores<ReproCaseRow>((chunk) => handoffAgreements(chunk)
      .is("closed_at", null) as unknown as Read<ReproCaseRow>),
    // Cerrados por dejar la etapa, en los últimos 14 días.
    byStores<ReproCaseRow>((chunk) => handoffAgreements(chunk)
      .eq("close_reason", "fuera_de_etapa")
      .gte("closed_at", new Date(now.getTime() - HANDOFF_DAYS * DAY_MS).toISOString()) as unknown as Read<ReproCaseRow>),
    courierRowsByIds(storeIds, (chunk) => admin.from("stores").select("id,name,org_id").in("id", chunk) as unknown as Read<{ id: string; name: string; org_id: string }>)
      .then(async ({ data }) => {
        const visible = data
          .filter((store) => scope.storeIds.has(store.id))
          .sort((a, b) => a.name.localeCompare(b.name, "es"));
        const orgs = [...new Set(visible.map((store) => store.org_id))];
        const { data: providers } = await courierRowsByIds(orgs, (chunk) => admin
          .from("logistics_providers")
          .select("id,org_id,status,same_day_cutoff")
          .eq("code", "grupo-gf-courier")
          .in("org_id", chunk) as unknown as Read<{ id: string; org_id: string; same_day_cutoff: string | null }>);
        const firstOrg = visible[0]?.org_id ?? null;
        return {
          visibleStores: visible,
          headerCutoff: providers.find((provider) => provider.org_id === firstOrg)?.same_day_cutoff ?? null,
        };
      }),
  ]);
  const storeName = new Map(visibleStores.map((store) => [store.id, store.name]));
  const orgIds = [...new Set(visibleStores.map((store) => store.org_id))];
  // Los candidatos de «Ya en «Por armar»», una vez cada caso.
  const handoffCases = [...new Map([...openHandoffCases, ...closedHandoffCases].map((row) => [row.id, row])).values()];

  // Los pedidos de la etapa: los de un programa y los de un acuerdo, una vez
  // cada uno, lo más antiguo primero, con tope.
  const dayOf = new Map<string, string>();
  for (const program of programs) dayOf.set(program.order_id, program.scheduled_for.slice(0, 10));
  for (const row of openCases) if (!dayOf.has(row.order_id)) dayOf.set(row.order_id, row.agreed_on.slice(0, 10));
  const candidates = [...dayOf.entries()]
    .sort(([a, dayA], [b, dayB]) => (dayA < dayB ? -1 : dayA > dayB ? 1 : a < b ? -1 : a > b ? 1 : 0))
    .map(([orderId]) => orderId);
  const kept = candidates.slice(0, RETRY_CANDIDATES_MAX);
  const omitted = candidates.length - kept.length;
  const chunks: string[][] = [];
  for (let offset = 0; offset < kept.length; offset += RETRY_CHUNK) chunks.push(kept.slice(offset, offset + RETRY_CHUNK));

  // Oleada 2: el motor de Repro Lima por lotes, solo lectura (su filtro de etapa
  // deja fuera los programas de pedidos que ya salieron), y en paralelo los
  // datos de los acuerdos que ya están en «Por armar».
  const [reproRows, handoffs] = await Promise.all([
    Promise.all(chunks.map((orderIds) => loadReproLima(admin, scope, now, { orderIds, closeStale: false })))
      .then((pages) => pages.flatMap((page) => page.rows)),
    loadHandoffs(admin, storeIds, handoffCases, { storeName, orgIds, today }),
  ]);

  // Oleada 3: la dirección y el armado de la salida propia, para su chapa.
  const ownIds = [...new Set(reproRows.map((row) => row.ownOutput?.id).filter((id): id is string => Boolean(id)))];
  const { data: ownRows } = await courierRowsByIds(ownIds, (chunk) => admin
    .from("shipments")
    .select("id,address_updated_at,ready_at")
    .in("store_id", storeIds)
    .in("id", chunk) as unknown as Read<{ id: string; address_updated_at: string | null; ready_at: string | null }>);
  const ownShipments = new Map(ownRows.map((row) => [row.id, { addressUpdatedAt: row.address_updated_at, readyAt: row.ready_at }]));

  const rows = warehouseRetryRows(reproRows, {
    today,
    cutoffMinute: sameDayCutoffMinute(headerCutoff),
    ownShipments,
  });
  // Un pedido tiene una sola subetapa: no puede estar en las dos listas.
  const listed = new Set(rows.map((row) => row.orderId));
  return {
    today,
    nowIso,
    cutoffLabel: sameDayCutoffLabel(headerCutoff),
    rows,
    handoffs: handoffs.filter((row) => !listed.has(row.orderId)),
    counts: retryCounts(rows),
    omitted,
    showStore: visibleStores.length > 1,
  };
}

/** Una salida del pedido, con lo que dice si ya salió y falló o volvió. */
type HandoffShipmentRow = HandoffShipment & {
  custody_state: string | null;
  reported_status: string | null;
  swayp_state: number | null;
  dispatched_at: string | null;
  closed_at: string | null;
  returned_at: string | null;
  updated_at: string | null;
};
const HANDOFF_SHIPMENT_COLUMNS =
  "id,order_id,courier,output_code,output_number,preparation_state,ready_at,created_at,delivery_status," +
  "custody_state,reported_status,swayp_state,dispatched_at,closed_at,returned_at,updated_at";

/**
 * Los acuerdos que ya dejaron la etapa porque nació su salida nueva y el pedido
 * está en «Preparación · Por armar», con el caso aún abierto o cerrado por
 * dejar la etapa. Solo el último caso del pedido (por apertura, como las
 * chapas de la cola de Despacho del día), solo mientras ninguna salida nacida
 * después de decidir falló o volvió (`failedSinceAgreement`), y solo con su
 * salida nueva, si se encuentra.
 *
 * El día es el del programa vigente, leído aquí sin filtro de fecha; sin
 * programa, el de la caja de Grupo GF donde ya entró la salida nueva (al
 * asignarla, el programa se da por cumplido y se borra); sin caja, el
 * acordado. Si cae después de mañana, no se lista.
 *
 * Al armar la salida nueva, el pedido pasa a «Por despachar» y la fila sale
 * de la lista: aquí no llega una salida nueva armada. No se cuentan: los
 * cuenta «Por armar».
 */
async function loadHandoffs(
  admin: ReturnType<typeof createAdminSupabase>,
  storeIds: string[],
  candidates: readonly ReproCaseRow[],
  ctx: { storeName: ReadonlyMap<string, string>; orgIds: readonly string[]; today: string },
): Promise<WarehouseHandoffRow[]> {
  const orderIds = [...new Set(candidates.map((row) => row.order_id))];
  if (!orderIds.length) return [];
  type HandoffOrder = { order_id: string; store_id: string; order_name: string | null; customer_name: string | null; district: string | null; macro_stage: string | null; macro_substage: string | null };
  type CaseStamp = { order_id: string; id: string; opened_at: string };
  type HandoffProgram = { order_id: string; scheduled_for: string };
  const [orders, cases, shipments, programs, failedStops] = await Promise.all([
    courierRowsByIds(orderIds, (chunk) => admin
      .from("order_master")
      .select("order_id,store_id,order_name,customer_name,district,macro_stage,macro_substage")
      .in("store_id", storeIds)
      .in("order_id", chunk)
      .eq("macro_stage", "preparacion")
      .eq("macro_substage", "por_armar") as unknown as Read<HandoffOrder>).then((result) => result.data),
    courierRowsByIds(orderIds, (chunk) => admin
      .from("lima_repro_cases")
      .select("order_id,id,opened_at")
      .in("store_id", storeIds)
      .in("order_id", chunk) as unknown as Read<CaseStamp>).then((result) => result.data),
    courierRowsByIds(orderIds, (chunk) => admin
      .from("shipments")
      .select(HANDOFF_SHIPMENT_COLUMNS)
      .in("store_id", storeIds)
      .in("order_id", chunk) as unknown as Read<HandoffShipmentRow>).then((result) => result.data),
    // El programa vigente, sea cual sea su día (el de la oleada 1 llega hasta mañana).
    courierRowsByIds(orderIds, (chunk) => admin
      .from("gf_dispatch_programs")
      .select("order_id,scheduled_for")
      .in("store_id", storeIds)
      .in("order_id", chunk) as unknown as Read<HandoffProgram>).then((result) => result.data),
    // Las paradas «No entregado» de sus salidas: el fallo con Grupo GF queda
    // aquí aunque la caja ya volviera a la oficina.
    courierRowsByIds(orderIds, (chunk) => admin
      .from("delivery_stops")
      .select("shipment_id")
      .in("store_id", storeIds)
      .in("order_id", chunk)
      .eq("status", "no_entregado")
      .not("shipment_id", "is", null) as unknown as Read<{ shipment_id: string }>).then((result) => result.data),
  ]);
  const orderById = new Map(orders
    .filter((row) => row.macro_stage === "preparacion" && row.macro_substage === "por_armar")
    .map((row) => [row.order_id, row]));
  const latestCase = new Map<string, CaseStamp>();
  for (const row of cases) {
    const current = latestCase.get(row.order_id);
    if (!current || (row.opened_at ?? "") > (current.opened_at ?? "")) latestCase.set(row.order_id, row);
  }
  const shipmentsByOrder = new Map<string, HandoffShipmentRow[]>();
  for (const row of shipments) {
    if (!row.order_id) continue;
    shipmentsByOrder.set(row.order_id, [...(shipmentsByOrder.get(row.order_id) ?? []), row]);
  }
  const programDay = new Map(programs.map((row) => [row.order_id, row.scheduled_for.slice(0, 10)]));
  const failedIds = new Set(failedStops.map((row) => row.shipment_id));

  const kept = candidates.filter((c) =>
    orderById.has(c.order_id) &&
    latestCase.get(c.order_id)?.id === c.id &&
    !failedSinceAgreement(shipmentsByOrder.get(c.order_id) ?? [], c.decided_at, failedIds));

  // Sin programa: la salida nueva de Grupo GF y el día de su caja, si ya entró en una.
  const salidaByOrder = new Map<string, string>();
  for (const c of kept) {
    if (programDay.has(c.order_id)) continue;
    const salida = newSalida(shipmentsByOrder.get(c.order_id) ?? [], c.decided_at);
    if (salida && sameCourier(salida.courier, "propio")) salidaByOrder.set(c.order_id, salida.id);
  }
  const boxDay = await loadBoxDays(admin, storeIds, ctx.orgIds, [...salidaByOrder.values()]);

  const out: WarehouseHandoffRow[] = [];
  for (const c of kept) {
    const order = orderById.get(c.order_id);
    if (!order) continue;
    const salidaId = salidaByOrder.get(c.order_id);
    const row = warehouseHandoffRow({
      caseRow: c,
      order,
      storeName: ctx.storeName.get(order.store_id) ?? "Tienda",
      // El programa vigente; sin él, la caja de la salida nueva; sin caja, el acordado.
      programDay: programDay.get(c.order_id) ?? (salidaId ? boxDay.get(salidaId) : undefined) ?? null,
      shipments: shipmentsByOrder.get(c.order_id) ?? [],
      today: ctx.today,
    });
    if (row) out.push(row);
  }
  return sortHandoffs(out);
}

/**
 * ¿Una salida nacida después de decidir ya falló o volvió? Entonces el pedido
 * está en «Por armar» por otro intento, sin caso nuevo («Sacar con salida
 * nueva», o Grupo GF lo tomó tras el fallo de otro courier), y no por este
 * acuerdo: su caja del estante ya no es la de la instrucción. Falló: una
 * parada «No entregado» suya o el fallo de otro courier
 * (`guideFailedAfterDispatch`). Volvió o vuelve: `returned_at`, o la custodia
 * en `retorno` o `devuelto`.
 */
function failedSinceAgreement(
  shipments: readonly HandoffShipmentRow[],
  decidedAt: string | null,
  failedIds: ReadonlySet<string>,
): boolean {
  const since = Date.parse(decidedAt ?? "");
  if (!Number.isFinite(since)) return false;
  return shipments.some((s) => {
    const born = Date.parse(s.created_at ?? "");
    if (!Number.isFinite(born) || born <= since) return false;
    return failedIds.has(s.id) ||
      Boolean(s.returned_at) ||
      s.custody_state === "retorno" ||
      s.custody_state === "devuelto" ||
      guideFailedAfterDispatch({ ...s, courier: s.courier ?? "", delivery_status: s.delivery_status ?? "" });
  });
}

/**
 * La salida nueva del acuerdo, con la regla de `handoffSalida`: la de
 * consecutivo más alto que nació después de decidir y no se entregó.
 */
function newSalida(shipments: readonly HandoffShipmentRow[], decidedAt: string | null): HandoffShipmentRow | null {
  const since = Date.parse(decidedAt ?? "");
  if (!Number.isFinite(since)) return null;
  let best: HandoffShipmentRow | null = null;
  for (const s of shipments) {
    if (s.delivery_status === "entregado") continue;
    const born = Date.parse(s.created_at ?? "");
    if (!Number.isFinite(born) || born <= since) continue;
    if (!best || (s.output_number ?? 0) > (best.output_number ?? 0)) best = s;
  }
  return best;
}

/**
 * El día de la caja activa de Grupo GF de cada salida (el ítem sin
 * `removed_at`, en una caja no anulada), por las tiendas y las organizaciones
 * de quien mira. Si estuviera en dos, la más tardía.
 */
async function loadBoxDays(
  admin: ReturnType<typeof createAdminSupabase>,
  storeIds: string[],
  orgIds: readonly string[],
  shipmentIds: string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!shipmentIds.length || !orgIds.length) return out;
  const { data: items } = await courierRowsByIds(shipmentIds, (chunk) => admin
    .from("dispatch_manifest_items")
    .select("shipment_id,manifest_id")
    .in("store_id", storeIds)
    .in("shipment_id", chunk)
    .is("removed_at", null) as unknown as Read<{ shipment_id: string; manifest_id: string }>);
  if (!items.length) return out;
  const { data: manifests } = await courierRowsByIds([...new Set(items.map((item) => item.manifest_id))], (chunk) => admin
    .from("dispatch_manifests")
    .select("id,courier,route_date,state")
    .in("org_id", [...orgIds])
    .in("id", chunk) as unknown as Read<{ id: string; courier: string | null; route_date: string | null; state: string | null }>);
  const dayOf = new Map<string, string>();
  for (const manifest of manifests) {
    if (manifest.state === "cancelled" || !manifest.route_date || !sameCourier(manifest.courier, "propio")) continue;
    dayOf.set(manifest.id, manifest.route_date.slice(0, 10));
  }
  for (const item of items) {
    const day = dayOf.get(item.manifest_id);
    if (day && day > (out.get(item.shipment_id) ?? "")) out.set(item.shipment_id, day);
  }
  return out;
}
