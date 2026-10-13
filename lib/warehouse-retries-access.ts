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
/** Hasta cuándo se mira un acuerdo que ya dejó la etapa («Ya en «Por armar»»). */
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

  // Oleada 1: programas hasta mañana (lo vencido incluido), acuerdos abiertos
  // para hoy o mañana, acuerdos que ya dejaron la etapa, tiendas y el corte.
  // El corte es el del proveedor de la primera tienda, como Repro Lima, y nunca
  // fijo (D6): se lee solo para las organizaciones de esas tiendas.
  const [programs, openCases, handoffCases, { visibleStores, headerCutoff }] = await Promise.all([
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
    byStores<ReproCaseRow>((chunk) => admin
      .from("lima_repro_cases")
      .select(REPRO_CASE_COLUMNS)
      .in("store_id", chunk)
      .eq("close_reason", "fuera_de_etapa")
      .not("agreed_on", "is", null)
      .lte("agreed_on", tomorrow)
      .in("box_action", [...HANDOFF_BOX_ACTIONS])
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
    loadHandoffs(admin, storeIds, handoffCases, { programs, storeName, today }),
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

/**
 * Los acuerdos que ya dejaron la etapa porque nació su salida nueva y el pedido
 * está en «Preparación · Por armar». Solo el último caso del pedido (por
 * apertura, como las chapas de la cola de Despacho del día) y solo con su
 * salida nueva, si se encuentra. No se cuentan: los cuenta «Por armar».
 */
async function loadHandoffs(
  admin: ReturnType<typeof createAdminSupabase>,
  storeIds: string[],
  candidates: readonly ReproCaseRow[],
  ctx: { programs: ReadonlyArray<{ order_id: string; scheduled_for: string }>; storeName: ReadonlyMap<string, string>; today: string },
): Promise<WarehouseHandoffRow[]> {
  const orderIds = [...new Set(candidates.map((row) => row.order_id))];
  if (!orderIds.length) return [];
  type HandoffOrder = { order_id: string; store_id: string; order_name: string | null; customer_name: string | null; district: string | null; macro_stage: string | null; macro_substage: string | null };
  type CaseStamp = { order_id: string; id: string; opened_at: string };
  const [orders, cases, shipments] = await Promise.all([
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
      .select("id,order_id,courier,output_code,output_number,preparation_state,ready_at,created_at,delivery_status")
      .in("store_id", storeIds)
      .in("order_id", chunk) as unknown as Read<HandoffShipment>).then((result) => result.data),
  ]);
  const orderById = new Map(orders
    .filter((row) => row.macro_stage === "preparacion" && row.macro_substage === "por_armar")
    .map((row) => [row.order_id, row]));
  const latestCase = new Map<string, CaseStamp>();
  for (const row of cases) {
    const current = latestCase.get(row.order_id);
    if (!current || (row.opened_at ?? "") > (current.opened_at ?? "")) latestCase.set(row.order_id, row);
  }
  const shipmentsByOrder = new Map<string, HandoffShipment[]>();
  for (const row of shipments) {
    if (!row.order_id) continue;
    shipmentsByOrder.set(row.order_id, [...(shipmentsByOrder.get(row.order_id) ?? []), row]);
  }
  const programDay = new Map(ctx.programs.map((row) => [row.order_id, row.scheduled_for.slice(0, 10)]));

  const out: WarehouseHandoffRow[] = [];
  for (const c of candidates) {
    const order = orderById.get(c.order_id);
    if (!order || latestCase.get(c.order_id)?.id !== c.id) continue;
    const row = warehouseHandoffRow({
      caseRow: c,
      order,
      storeName: ctx.storeName.get(order.store_id) ?? "Tienda",
      programDay: programDay.get(c.order_id) ?? null,
      shipments: shipmentsByOrder.get(c.order_id) ?? [],
      today: ctx.today,
    });
    if (row) out.push(row);
  }
  return sortHandoffs(out);
}
