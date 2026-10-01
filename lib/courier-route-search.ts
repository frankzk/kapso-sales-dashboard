import { createServerSupabase } from "@/lib/db";
import { normalizeDispatchScan } from "@/lib/dispatch";
import { allCourierRows } from "@/lib/courier-flow";

export function courierSearchCode(raw: string): string {
  return normalizeDispatchScan(raw).replace(/^#+/, "").trim();
}

export function courierCodePattern(code: string): string {
  return code.replace(/[\\%_]/g, "\\$&");
}

/** Busca identidades primero, sin acotar por las fechas de la lista. Siempre RLS. */
export async function findCourierRouteMatches(raw: string): Promise<{ ordersByRoute: Record<string, string[]>; limited: boolean }> {
  const code = courierSearchCode(raw);
  if (code.length < 3 || code.length > 200) throw new Error("Escribe entre 3 y 200 caracteres del pedido, guía o QR.");
  const sb = await createServerSupabase();
  const pattern = courierCodePattern(code);
  const shipmentColumns = "id,order_id,order_name";
  const results = await Promise.all([
    sb.from("order_master").select("order_id,order_name").ilike("order_name", `%${pattern}%`).order("order_id").limit(31),
    sb.from("shipments").select(shipmentColumns).ilike("output_code", pattern).limit(31),
    sb.from("shipments").select(shipmentColumns).ilike("guide_code", pattern).limit(31),
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(code)
      ? sb.from("shipments").select(shipmentColumns).eq("qr_token", code).limit(31)
      : Promise.resolve({ data: [], error: null }),
  ]);
  for (const result of results) if (result.error) throw new Error(result.error.message);
  const limited = results.some((result) => (result.data?.length ?? 0) > 30);
  // No presentar una muestra como si fueran todas las rutas del código.
  if (limited) return { ordersByRoute: {}, limited: true };
  const orders = new Map<string, string>();
  for (const row of results[0].data ?? []) orders.set(row.order_id, row.order_name ?? code);
  type Shipment = { id: string; order_id: string | null; order_name: string | null };
  const shipments = new Map<string, Shipment>();
  for (const result of results.slice(1)) {
    for (const row of (result.data ?? []) as Shipment[]) {
      shipments.set(row.id, row);
      if (row.order_id) orders.set(row.order_id, row.order_name ?? code);
    }
  }
  // Un pedido puede tener varias salidas; conserva todas sus rutas e intentos.
  if (orders.size) {
    const rows = await allCourierRows<Shipment>((from, to) => sb.from("shipments").select(shipmentColumns).in("order_id", [...orders.keys()]).order("id").range(from, to));
    for (const row of rows) shipments.set(row.id, row);
  }
  const [stops, items] = await Promise.all([
    orders.size ? allCourierRows<{ route_id: string; order_id: string }>((from, to) =>
      sb.from("delivery_stops").select("route_id,order_id").in("order_id", [...orders.keys()]).order("id").range(from, to)) : [],
    shipments.size ? allCourierRows<{ manifest_id: string; shipment_id: string }>((from, to) =>
      sb.from("dispatch_manifest_items").select("manifest_id,shipment_id").in("shipment_id", [...shipments.keys()]).is("removed_at", null).is("pickup_declined_at", null).order("id").range(from, to)) : [],
  ]);
  const found = new Map<string, Set<string>>();
  const add = (routeId: string, orderName: string) => {
    const names = found.get(routeId) ?? new Set<string>();
    names.add(orderName);
    found.set(routeId, names);
  };
  for (const stop of stops) add(stop.route_id, orders.get(stop.order_id) ?? code);
  const manifestIds = [...new Set(items.map((item) => item.manifest_id))];
  if (manifestIds.length) {
    const manifests = await allCourierRows<{ id: string; delivery_route_id: string | null }>((from, to) =>
      sb.from("dispatch_manifests").select("id,delivery_route_id").in("id", manifestIds).eq("courier", "propio").neq("state", "cancelled").order("id").range(from, to));
    const routes = new Map(manifests.map((m) => [m.id, m.delivery_route_id]));
    for (const item of items) {
      const routeId = routes.get(item.manifest_id);
      const shipment = shipments.get(item.shipment_id);
      if (routeId) add(routeId, shipment?.order_name ?? code);
    }
  }
  return { ordersByRoute: Object.fromEntries([...found].map(([id, names]) => [id, [...names]])), limited: false };
}
