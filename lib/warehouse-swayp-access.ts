// Almacén: «Swayp por salir · Lima» en el servidor (fase 1, SOLO LECTURA;
// owner 03-11-2026). Las reglas están en lib/warehouse-swayp.ts.
//
// La misma puerta que «Reintentos por salir» (`requireWarehouse`: quien
// prepara paquetes, `warehouse.prepare`, en las tiendas que tiene en Equipo).
// La puerta va dentro del cargador y las lecturas usan el cliente de servicio,
// siempre acotadas a esas tiendas: `shipments` no tiene `org_id`, el alcance es
// `store_id`.
//
// Solo lee: no escribe en la base, no recalcula el Master, no toca
// `loadWarehousePending` ni `warehouseBlocker` (nada de aquí suma en «Por
// armar»). Nunca lanza: si algo falla, la estación de arriba sigue funcionando
// y esta parte dice que no pudo cargar.
//
// Qué guías: courier `fenix` con su fecha de despacho (`next_followup_at`, la
// fecha UTC del día) en uno de los días de las zonas. Es el mismo criterio del
// Excel de programación de Swayp (app/api/export/fenix-programacion/route.ts:
// `courier = 'fenix'`, el día de `next_followup_at.slice(0, 10)`), así que las
// «programadas» de Lima coinciden con ese Excel filtrado a Lima, salvo que aquí
// salen de la cuenta, con su motivo en «Salieron», las de un pedido anulado o
// cancelado en la tienda aunque la guía siga `in_route` (el Excel las lleva), y
// cuentan como vivas las que ya avanzaron en Swayp (transferidas, entregadas,
// devueltas; el Excel solo exporta `in_route`). Las directas anuladas en Kapta
// pierden la fecha: se buscan por la de su emisión (`direct:<pedido>:<día>`).

import { unstable_rethrow } from "next/navigation";
import { createAdminSupabase } from "@/lib/db";
import { allCourierRows, courierRowsByIds } from "@/lib/courier-flow";
import { limaClock, nextDay } from "@/lib/grupo-gf-courier";
import { resolveAgentNames } from "@/lib/agent-names";
import { requireWarehouse } from "@/lib/warehouse-retries-access";
import type { ReproScope } from "@/lib/repro-lima-access";
import { getMasterPermissions } from "@/lib/permissions-access";
import {
  SWAYP_NO_VINO_REASON,
  type SwaypHandoverItemRow,
  type SwaypHandoverManifestRow,
} from "@/lib/swayp-handover";
import {
  buildWarehouseSwayp,
  emptyWarehouseSwayp,
  swaypZoneDays,
  SWAYP_ERROR,
  type SwaypCallRow,
  type SwaypEmissionRow,
  type SwaypOrderRow,
  type SwaypShipmentRow,
  type WarehouseSwaypData,
} from "@/lib/warehouse-swayp";

export const SWAYP_SHIPMENT_COLUMNS =
  "id,store_id,courier,guide_code,swayp_guide,swayp_state,delivery_status,status_category,order_id,order_name," +
  "customer_name,product,district,city,province,next_followup_at,created_at,output_code,output_number," +
  "preparation_state,custody_state,ready_at,ready_by,custody_transferred_at,dispatched_at,returned_at," +
  "reported_status,custody_transferred_by";
export const SWAYP_ORDER_COLUMNS =
  "order_id,store_id,order_name,customer_name,macro_operation,general_status,product_titles,district,province,region";
export const SWAYP_EMISSION_COLUMNS = "id,source_key,order_id,store_id,automatic,state,guide_code,child_id,created_at";
export const SWAYP_CALL_COLUMNS = "shipment_id,agent,kind,note,occurred_at,next_followup_at";
export const SWAYP_HANDOVER_MANIFEST_COLUMNS = "id,state,received_by,custody_completed_at,cancelled_at,cancellation_reason,created_at";
export const SWAYP_HANDOVER_ITEM_COLUMNS = "shipment_id,office_checked_at,office_checked_by,removed_at,removed_by,removal_reason";

type Read<T> = PromiseLike<{ data: T[] | null; error: { message: string } | null }>;
type Admin = ReturnType<typeof createAdminSupabase>;

/**
 * «Swayp por salir»: el lote de hoy (si hoy Swayp despacha) y el del próximo
 * día de despacho. Nunca lanza; sin sesión redirige a /login (la redirección
 * no se traga).
 */
export async function getWarehouseSwayp(now: Date = new Date()): Promise<WarehouseSwaypData> {
  const nowIso = now.toISOString();
  try {
    const scope = await requireWarehouse();
    if ("error" in scope) return emptyWarehouseSwayp({ nowIso, error: scope.error });
    const canHandover = (await getMasterPermissions()).can("dispatch.manage");
    return { ...(await loadSwayp(createAdminSupabase(), scope, now)), canHandover };
  } catch (error) {
    // La redirección a /login (y lo demás de Next) no es un fallo: sigue su camino.
    unstable_rethrow(error);
    console.error("almacen: swayp por salir", error instanceof Error ? error.message : error);
    return emptyWarehouseSwayp({ nowIso, error: SWAYP_ERROR });
  }
}

async function loadSwayp(admin: Admin, scope: ReproScope, now: Date): Promise<WarehouseSwaypData> {
  const storeIds = [...scope.storeIds];
  if (!storeIds.length) return emptyWarehouseSwayp({ nowIso: now.toISOString() });
  const today = limaClock(now).day;
  const days = swaypZoneDays(today);
  const zoneDays = [days.hoy, days.proximo].filter((day): day is string => Boolean(day)).sort();
  // Cada lectura va por las tiendas de quien mira, de 100 en 100.
  const byStores = <T>(read: (chunk: string[]) => Read<T>): Promise<T[]> =>
    courierRowsByIds(storeIds, read).then((result) => result.data);
  // Y, dentro de cada lote, por páginas: el tope de PostgREST es de 1.000 filas.
  const paged = <T>(page: (from: number, to: number) => Read<T>): Read<T> =>
    allCourierRows(page).then((data) => ({ data, error: null }));

  // Oleada 1: las guías Swayp de los días de las zonas (rango UTC: la fecha se
  // guarda a medianoche UTC del día; el sábado y el lunes dejan el domingo en
  // medio, que se descarta al proyectar), las directas cuya fecha ORIGINAL es
  // uno de esos días (para «Fecha cambiada») y los nombres de las tiendas.
  const from = `${zoneDays[0]}T00:00:00.000Z`;
  const until = `${nextDay(zoneDays[zoneDays.length - 1]!)}T00:00:00.000Z`;
  const [zoneShipments, movedEmissions, stores] = await Promise.all([
    byStores<SwaypShipmentRow>((chunk) => paged((a, b) => admin
      .from("shipments")
      .select(SWAYP_SHIPMENT_COLUMNS)
      .in("store_id", chunk)
      .eq("courier", "fenix")
      .gte("next_followup_at", from)
      .lt("next_followup_at", until)
      .order("id", { ascending: true })
      .range(a, b) as unknown as Read<SwaypShipmentRow>)),
    Promise.all(zoneDays.map((day) => byStores<SwaypEmissionRow>((chunk) => admin
      .from("swayp_guide_emissions")
      .select(SWAYP_EMISSION_COLUMNS)
      .in("store_id", chunk)
      .like("source_key", `direct:%:${day}T%`) as unknown as Read<SwaypEmissionRow>))).then((pages) => pages.flat()),
    byStores<{ id: string; name: string; org_id: string | null }>((chunk) => admin
      .from("stores")
      .select("id,name,org_id")
      .in("id", chunk) as unknown as Read<{ id: string; name: string; org_id: string | null }>),
  ]);
  const storeNames: Record<string, string> = {};
  for (const store of stores) if (scope.storeIds.has(store.id)) storeNames[store.id] = store.name;
  const orgIds = [...new Set(stores.map((store) => store.org_id).filter((id): id is string => Boolean(id)))];
  // La entrega a Swayp de «Hoy» (fase 3): una por organización y día. Se lee
  // aunque no haya guías, para que «Swayp no vino» y el cierre se sigan viendo.
  const handover = days.hoy ? await loadSwaypHandover(admin, orgIds, days.hoy) : null;

  const orderIds = [...new Set([...zoneShipments, ...movedEmissions].map((row) => row.order_id).filter((id): id is string => Boolean(id)))];
  if (!orderIds.length) {
    const names = handover ? await handoverNames(admin, handover.items) : {};
    return buildWarehouseSwayp({ shipments: [], orders: [], emissions: [], calls: [], names, storeNames, handover }, now);
  }

  // Oleada 2: los pedidos (quién arma, si está anulado, la cancelación en la
  // tienda), TODAS sus salidas (las hermanas dicen dónde está la caja, y la
  // guía de una directa que cambió de fecha está entre ellas) y sus emisiones
  // (la hora real de creación).
  const byOrders = <T>(read: (chunk: string[]) => Read<T>): Promise<T[]> =>
    courierRowsByIds(orderIds, read).then((result) => result.data);
  const [masters, cancellations, siblings, emissions] = await Promise.all([
    byOrders<SwaypOrderRow>((chunk) => admin
      .from("order_master")
      .select(SWAYP_ORDER_COLUMNS)
      .in("store_id", storeIds)
      .in("order_id", chunk) as unknown as Read<SwaypOrderRow>),
    byOrders<{ id: string; cancelled_at: string | null }>((chunk) => admin
      .from("orders")
      .select("id,cancelled_at")
      .in("store_id", storeIds)
      .in("id", chunk)
      .not("cancelled_at", "is", null) as unknown as Read<{ id: string; cancelled_at: string | null }>),
    byOrders<SwaypShipmentRow>((chunk) => admin
      .from("shipments")
      .select(SWAYP_SHIPMENT_COLUMNS)
      .in("store_id", storeIds)
      .in("order_id", chunk) as unknown as Read<SwaypShipmentRow>),
    byOrders<SwaypEmissionRow>((chunk) => admin
      .from("swayp_guide_emissions")
      .select(SWAYP_EMISSION_COLUMNS)
      .in("store_id", storeIds)
      .in("order_id", chunk) as unknown as Read<SwaypEmissionRow>),
  ]);
  const cancelledAt = new Map(cancellations.map((row) => [row.id, row.cancelled_at]));
  const orders = masters.map((row) => ({ ...row, cancelled_at: cancelledAt.get(row.order_id) ?? null }));
  const shipments = [...new Map([...siblings, ...zoneShipments].map((row) => [row.id, row])).values()];

  // Oleada 3: las gestiones de las guías Swayp (quién creó la guía y cuándo
  // cambió su fecha), por páginas: el agente de voz deja varias por guía. El
  // orden desempata por `id`: con solo `occurred_at`, dos gestiones de la misma
  // hora en el borde de una página podían repetirse o perderse.
  const fenixIds = shipments.filter((row) => row.courier === "fenix").map((row) => row.id);
  const calls = (await courierRowsByIds(fenixIds, (chunk) => paged((a, b) => admin
    .from("shipment_calls")
    .select(SWAYP_CALL_COLUMNS)
    .in("store_id", storeIds)
    .in("shipment_id", chunk)
    .order("occurred_at", { ascending: true })
    .order("id", { ascending: true })
    .range(a, b) as unknown as Read<SwaypCallRow>))).data;

  // Los nombres: quien creó la guía y quien la armó. Uno que no se resuelve no rompe la lista.
  const userIds = new Set<string>();
  for (const call of calls) if (call.agent) userIds.add(call.agent);
  for (const row of shipments) if (row.ready_by) userIds.add(row.ready_by);
  for (const item of handover?.items ?? []) {
    if (item.office_checked_by) userIds.add(item.office_checked_by);
    if (item.removed_by) userIds.add(item.removed_by);
  }
  const names = userIds.size ? await resolveAgentNames(userIds, admin) : {};

  return buildWarehouseSwayp({
    shipments,
    orders,
    emissions: [...new Map([...emissions, ...movedEmissions].map((row) => [row.id, row])).values()],
    calls,
    names,
    storeNames,
    handover,
  }, now);
}

/**
 * La entrega a Swayp de un día: la abierta o cerrada; si no hay, la que se
 * canceló por «Swayp no vino». Una cancelada por otro motivo no cuenta.
 */
async function loadSwaypHandover(
  admin: Admin,
  orgIds: string[],
  day: string,
): Promise<{ manifest: SwaypHandoverManifestRow; items: SwaypHandoverItemRow[] } | null> {
  if (!orgIds.length) return null;
  const { data, error } = await admin
    .from("dispatch_manifests")
    .select(SWAYP_HANDOVER_MANIFEST_COLUMNS)
    .in("org_id", orgIds)
    .eq("route_date", day)
    .is("rider_id", null)
    .ilike("courier", "fenix")
    .order("created_at", { ascending: false });
  if (error) throw new Error(error.message);
  const manifests = (data ?? []) as unknown as (SwaypHandoverManifestRow & { created_at: string })[];
  const manifest = manifests.find((m) => m.state !== "cancelled")
    ?? manifests.find((m) => m.state === "cancelled" && m.cancellation_reason === SWAYP_NO_VINO_REASON)
    ?? null;
  if (!manifest) return null;
  const { data: items, error: itemsError } = await admin
    .from("dispatch_manifest_items")
    .select(SWAYP_HANDOVER_ITEM_COLUMNS)
    .eq("manifest_id", manifest.id);
  if (itemsError) throw new Error(itemsError.message);
  return { manifest, items: (items ?? []) as unknown as SwaypHandoverItemRow[] };
}

async function handoverNames(admin: Admin, items: readonly SwaypHandoverItemRow[]): Promise<Record<string, string>> {
  const ids = new Set<string>();
  for (const item of items) {
    if (item.office_checked_by) ids.add(item.office_checked_by);
    if (item.removed_by) ids.add(item.removed_by);
  }
  return ids.size ? resolveAgentNames(ids, admin) : {};
}
