import { createServerSupabase } from "@/lib/db";
import { limaDateKey } from "@/lib/aliclik-geo";
import { limaDayBounds } from "@/lib/daily-summary";
import type { DispatchManifestState, DispatchRouteKind } from "@/lib/dispatch";

export interface DispatchShipment {
  id: string;
  store_id: string;
  courier: string;
  guide_code: string;
  output_number: number | null;
  output_code: string | null;
  qr_token: string | null;
  preparation_state: string;
  custody_state: string;
  ready_at: string | null;
  order_id: string | null;
  order_name: string | null;
  customer_name: string | null;
  customer_phone: string | null;
  district: string | null;
  province: string | null;
  product: string | null;
}

export interface DispatchManifestItem {
  id: string;
  manifest_id: string;
  shipment_id: string;
  store_id: string;
  added_by: string | null;
  added_at: string;
  office_checked_by: string | null;
  office_checked_at: string | null;
  pickup_checked_by: string | null;
  pickup_checked_at: string | null;
  removed_by: string | null;
  removed_at: string | null;
  removal_reason: string | null;
  shipment: DispatchShipment | null;
}

export interface DispatchManifest {
  id: string;
  org_id: string;
  courier: string;
  /** `reparto` (motorizado, doble cotejo) o `entrega_courier` (Aliclik/agencia). */
  kind: DispatchRouteKind;
  route_date: string;
  route_label: string;
  driver_name: string | null;
  /** Quién recogió, en las rutas sin motorizado que coteje. */
  received_by: string | null;
  state: DispatchManifestState;
  created_by: string | null;
  office_completed_at: string | null;
  custody_completed_at: string | null;
  cancellation_reason: string | null;
  created_at: string;
  items: DispatchManifestItem[];
}

export interface DispatchWorkspaceData {
  manifests: DispatchManifest[];
  /**
   * Paquetes en custodia de la empresa que no están en ninguna ruta activa.
   * Incluye los que almacén todavía no escaneó: la ruta se ARMA antes de que la
   * caja esté cerrada, y el escaneo se muestra como indicador.
   */
  assignableShipments: DispatchShipment[];
}

export const DISPATCH_SHIPMENT_COLUMNS =
  "id,store_id,courier,guide_code,output_number,output_code,qr_token," +
  "preparation_state,custody_state,ready_at,order_id,order_name,customer_name," +
  "customer_phone,district,province,product";

const MANIFEST_COLUMNS =
  "id,org_id,courier,kind,route_date,route_label,driver_name,received_by,state,created_by," +
  "office_completed_at,custody_completed_at,cancellation_reason,created_at";

const ITEM_COLUMNS =
  "id,manifest_id,shipment_id,store_id,added_by,added_at,office_checked_by," +
  "office_checked_at,pickup_checked_by,pickup_checked_at,removed_by,removed_at,removal_reason";

export async function getDispatchWorkspaceData(): Promise<DispatchWorkspaceData> {
  const sb = await createServerSupabase();
  const [activeManifestRes, historyManifestRes, readyRes] = await Promise.all([
    sb
      .from("dispatch_manifests")
      .select(MANIFEST_COLUMNS)
      .not("state", "in", "(in_custody,cancelled)")
      .order("route_date", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(100),
    sb
      .from("dispatch_manifests")
      .select(MANIFEST_COLUMNS)
      .in("state", ["in_custody", "cancelled"])
      .order("route_date", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(20),
    // Todo lo que sigue en la empresa y no está en una ruta: para ARMAR la ruta
    // hace falta ver también lo que almacén todavía no escaneó, porque la ruta
    // se decide antes de que la caja esté cerrada. El escaneo de almacén se
    // muestra como indicador (`preparation_state`), no como filtro.
    sb
      .from("shipments")
      .select(DISPATCH_SHIPMENT_COLUMNS)
      .eq("custody_state", "empresa")
      // `rotulo_generado` ya es un paquete planificable: existe la salida y su
      // rótulo. Se excluye `no_iniciado` (todavía no hay nada físico) e
      // `incidencia` (está detenido, no se despacha).
      .in("preparation_state", ["rotulo_generado", "en_armado", "listo_despacho"])
      .order("ready_at", { ascending: false, nullsFirst: false })
      .limit(400),
  ]);

  const rawManifests = [
    ...((activeManifestRes.data ?? []) as unknown as Omit<DispatchManifest, "items">[]),
    ...((historyManifestRes.data ?? []) as unknown as Omit<DispatchManifest, "items">[]),
  ];
  const manifestIds = rawManifests.map((manifest) => manifest.id);
  let rawItems: Omit<DispatchManifestItem, "shipment">[] = [];
  if (manifestIds.length) {
    const { data } = await sb
      .from("dispatch_manifest_items")
      .select(ITEM_COLUMNS)
      .in("manifest_id", manifestIds)
      .order("added_at", { ascending: true });
    rawItems = (data ?? []) as unknown as Omit<DispatchManifestItem, "shipment">[];
  }

  const shipmentIds = [...new Set(rawItems.map((item) => item.shipment_id))];
  const shipmentMap = new Map<string, DispatchShipment>();
  for (let start = 0; start < shipmentIds.length; start += 200) {
    const { data } = await sb
      .from("shipments")
      .select(DISPATCH_SHIPMENT_COLUMNS)
      .in("id", shipmentIds.slice(start, start + 200));
    for (const row of (data ?? []) as unknown as DispatchShipment[]) shipmentMap.set(row.id, row);
  }

  const itemsByManifest = new Map<string, DispatchManifestItem[]>();
  for (const item of rawItems) {
    const hydrated: DispatchManifestItem = {
      ...item,
      shipment: shipmentMap.get(item.shipment_id) ?? null,
    };
    const list = itemsByManifest.get(item.manifest_id) ?? [];
    list.push(hydrated);
    itemsByManifest.set(item.manifest_id, list);
  }

  const activeShipmentIds = new Set(
    rawItems.filter((item) => !item.removed_at).map((item) => item.shipment_id),
  );
  return {
    manifests: rawManifests.map((manifest) => ({
      ...manifest,
      items: itemsByManifest.get(manifest.id) ?? [],
    })),
    assignableShipments: ((readyRes.data ?? []) as unknown as DispatchShipment[]).filter(
      (shipment) => !activeShipmentIds.has(shipment.id),
    ),
  };
}

/** Una salida pendiente de armar, con la operación que decide su ruta. */
export interface WarehouseShipment extends DispatchShipment {
  operation: string | null;
}

export interface WarehouseStationData {
  /**
   * Lo que al almacén le falta armar HOY: salidas en custodia de la empresa sin
   * escanear, cuyo pedido el Master todavía cuenta en `Preparación · Por armar`.
   * Filtrar por el pedido y no solo por la salida es lo que deja fuera las
   * salidas huérfanas —pedidos cancelados o ya despachados por otra caja— que
   * de otro modo engordarían la cola con trabajo que nadie va a hacer.
   */
  pending: WarehouseShipment[];
  /** Armados de hoy: el acuse de que el escaneo entró. */
  armedToday: DispatchShipment[];
  /** Cuántas quedaron fuera del corte, para no fingir que la cola está completa. */
  pendingOmitted: number;
}

const WAREHOUSE_PENDING_LIMIT = 300;

export async function getWarehouseStationData(): Promise<WarehouseStationData> {
  const sb = await createServerSupabase();
  const today = limaDayBounds(limaDateKey());
  const [pendingRes, armedRes] = await Promise.all([
    sb
      .from("shipments")
      .select(DISPATCH_SHIPMENT_COLUMNS)
      .eq("custody_state", "empresa")
      .in("preparation_state", ["rotulo_generado", "en_armado"])
      .order("created_at", { ascending: false })
      .limit(WAREHOUSE_PENDING_LIMIT + 1),
    sb
      .from("shipments")
      .select(DISPATCH_SHIPMENT_COLUMNS)
      .eq("custody_state", "empresa")
      .eq("preparation_state", "listo_despacho")
      .gte("ready_at", today.startIso)
      .order("ready_at", { ascending: false })
      .limit(200),
  ]);

  const rows = (pendingRes.data ?? []) as unknown as DispatchShipment[];
  const orderIds = [...new Set(rows.map((row) => row.order_id).filter((id): id is string => !!id))];
  const operationByOrder = new Map<string, string | null>();
  for (let start = 0; start < orderIds.length; start += 200) {
    const { data } = await sb
      .from("order_master")
      .select("order_id,macro_operation")
      .eq("macro_substage", "por_armar")
      .in("order_id", orderIds.slice(start, start + 200));
    for (const row of (data ?? []) as { order_id: string; macro_operation: string | null }[]) {
      operationByOrder.set(row.order_id, row.macro_operation);
    }
  }

  const pending = rows
    .filter((row) => !!row.order_id && operationByOrder.has(row.order_id))
    .map((row) => ({ ...row, operation: operationByOrder.get(row.order_id ?? "") ?? null }));

  return {
    pending: pending.slice(0, WAREHOUSE_PENDING_LIMIT),
    armedToday: (armedRes.data ?? []) as unknown as DispatchShipment[],
    pendingOmitted: Math.max(0, pending.length - WAREHOUSE_PENDING_LIMIT),
  };
}

// Motorizados activos visibles para el usuario (RLS acota por organización).
// Alimenta el desplegable de motorizado en "Nueva ruta" de la Mesa de despacho.
export interface DispatchRider {
  id: string;
  full_name: string;
  courier: string | null;
  store_id: string | null;
}

export async function getDispatchRiders(): Promise<DispatchRider[]> {
  const sb = await createServerSupabase();
  const { data } = await sb
    .from("riders")
    .select("id, full_name, courier, store_id")
    .eq("active", true)
    .order("full_name");
  return (data as DispatchRider[]) ?? [];
}
