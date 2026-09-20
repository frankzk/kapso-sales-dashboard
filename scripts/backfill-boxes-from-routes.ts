/**
 * Da caja a las rutas que vienen del cuaderno (MOM §29.12 · §29.13).
 *
 * Una ruta importada desde Liquidaciones 2 tiene paradas pero no caja: el
 * paquete nunca pasó por Despacho del día, así que en Rutas salía «sin caja»,
 * con guiones en armados/cotejados/recibidos, y el panel de la caja abría en
 * «Agregar pedidos» vacío. Este script crea (o completa) la caja de cada ruta
 * con un ítem por parada, cotejado por oficina y recibido por el motorizado
 * en la hora del reporte (o el mediodía del día de la ruta), y pasa la
 * custodia de la salida al motorizado. Así la caja cuenta lo mismo que el
 * cuaderno dice que salió.
 *
 *   pnpm tsx scripts/backfill-boxes-from-routes.ts <org_id> --actor <user_id> --desde YYYY-MM-DD [--dry-run] [Roy Yhoni …]
 *
 * Qué NO hace: no toca el Master ni los reportes de las paradas, no emite
 * order_events (la evidencia del cuaderno ya está en la parada y en la hoja).
 * Deja `package_added` en dispatch_events con `backfilled: true`.
 *
 * Idempotente: una parada cuya salida ya está en la caja se salta; una salida
 * activa en OTRA caja se salta con aviso (el índice de «un paquete activo a
 * la vez» manda). Una ruta cerrada recibe su caja igual: la caja nace en
 * custodia, sin pasar por el disparador de recepción.
 */
import { existsSync, readFileSync } from "node:fs";

function loadEnv() {
  for (const file of [".env.local", ".env"]) {
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const m = /^([A-Z_]+)="?([^"]*)"?$/.exec(line);
      if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2];
    }
  }
}

type Route = { id: string; org_id: string; rider_id: string; route_date: string; status: string; started_at: string | null };
type Stop = { id: string; order_id: string; store_id: string | null; shipment_id: string | null; dispatch_manifest_id: string | null; reported_at: string | null; status: string };
type Shipment = { id: string; order_id: string; store_id: string; courier: string; custody_state: string | null; created_at: string; delivery_status: string };

async function main() {
  loadEnv();
  const args = process.argv.slice(2);
  const orgId = args.find((a) => !a.startsWith("--") && /^[0-9a-f-]{36}$/.test(a));
  const dryRun = args.includes("--dry-run");
  const actor = args[args.indexOf("--actor") + 1];
  const since = args[args.indexOf("--desde") + 1];
  const names = args.filter((a, i) => !a.startsWith("--") && a !== orgId && args[i - 1] !== "--actor" && args[i - 1] !== "--desde");
  if (!orgId || !actor || !/^[0-9a-f-]{36}$/.test(actor) || !since || !/^\d{4}-\d{2}-\d{2}$/.test(since)) {
    console.error("uso: tsx scripts/backfill-boxes-from-routes.ts <org_id> --actor <user_id> --desde YYYY-MM-DD [--dry-run] [Roy Yhoni …]");
    process.exit(1);
  }
  const { createAdminSupabase } = await import("@/lib/db");
  const admin = createAdminSupabase();

  let ridersQuery = admin.from("riders").select("id,full_name,user_id").eq("org_id", orgId);
  if (names.length) ridersQuery = ridersQuery.in("full_name", names);
  const { data: riders, error: ridersError } = await ridersQuery;
  if (ridersError) throw new Error(ridersError.message);
  const riderById = new Map((riders ?? []).map((r) => [r.id as string, r as { id: string; full_name: string; user_id: string | null }]));
  if (!riderById.size) throw new Error("No hay motorizados con esos nombres.");

  const { data: routeRows, error: routesError } = await admin
    .from("delivery_routes")
    .select("id,org_id,rider_id,route_date,status,started_at")
    .eq("org_id", orgId)
    .in("rider_id", [...riderById.keys()])
    .gte("route_date", since)
    .order("route_date");
  if (routesError) throw new Error(routesError.message);
  const routes = (routeRows ?? []) as Route[];
  console.log(`${dryRun ? "[dry-run] " : ""}${routes.length} rutas desde ${since}`);

  let boxesCreated = 0, itemsCreated = 0, skippedInBox = 0, skippedElsewhere = 0, skippedNoShipment = 0;
  for (const route of routes) {
    const rider = riderById.get(route.rider_id)!;
    const { data: stopRows } = await admin
      .from("delivery_stops")
      .select("id,order_id,store_id,shipment_id,dispatch_manifest_id,reported_at,status")
      .eq("route_id", route.id)
      .order("seq");
    const stops = (stopRows ?? []) as Stop[];
    if (!stops.length) continue;

    const { data: manifests } = await admin
      .from("dispatch_manifests")
      .select("id,state,load_number")
      .eq("delivery_route_id", route.id)
      .eq("courier", "propio")
      .neq("state", "cancelled")
      .order("load_number", { ascending: false })
      .limit(1);
    let manifestId = (manifests?.[0]?.id as string | undefined) ?? null;
    const custodyAt = route.started_at ?? `${route.route_date}T17:00:00.000Z`;
    if (!manifestId) {
      boxesCreated += 1;
      if (dryRun) manifestId = "dry-run";
      else {
        const { data: created, error } = await admin
          .from("dispatch_manifests")
          .insert({
            org_id: orgId, courier: "propio", route_date: route.route_date, route_label: rider.full_name, driver_name: rider.full_name,
            state: "in_custody", created_by: actor, custody_completed_at: custodyAt, custody_completed_by: actor,
            rider_id: rider.id, kind: "reparto", delivery_route_id: route.id, load_number: 1,
          })
          .select("id")
          .single();
        if (error || !created) throw new Error(`${rider.full_name} ${route.route_date}: no se pudo crear la caja (${error?.message})`);
        manifestId = created.id as string;
      }
    }

    const { data: activeRows } = manifestId === "dry-run"
      ? { data: [] as { shipment_id: string }[] }
      : await admin.from("dispatch_manifest_items").select("shipment_id").eq("manifest_id", manifestId).is("removed_at", null);
    const inBox = new Set((activeRows ?? []).map((r) => r.shipment_id as string));

    const orderIds = [...new Set(stops.map((s) => s.order_id))];
    const { data: shipmentRows } = await admin
      .from("shipments")
      .select("id,order_id,store_id,courier,custody_state,created_at,delivery_status")
      .in("order_id", orderIds)
      .order("created_at", { ascending: false });
    const shipmentsByOrder = new Map<string, Shipment[]>();
    for (const sh of (shipmentRows ?? []) as Shipment[]) {
      const list = shipmentsByOrder.get(sh.order_id) ?? [];
      list.push(sh);
      shipmentsByOrder.set(sh.order_id, list);
    }
    const shipmentIds = ((shipmentRows ?? []) as Shipment[]).map((s) => s.id);
    const { data: elsewhereRows } = shipmentIds.length
      ? await admin.from("dispatch_manifest_items").select("shipment_id,manifest_id").in("shipment_id", shipmentIds).is("removed_at", null)
      : { data: [] as { shipment_id: string; manifest_id: string }[] };
    const elsewhere = new Map((elsewhereRows ?? []).map((r) => [r.shipment_id as string, r.manifest_id as string]));

    let added = 0;
    for (const stop of stops) {
      const candidates = shipmentsByOrder.get(stop.order_id) ?? [];
      const shipment = stop.shipment_id
        ? candidates.find((s) => s.id === stop.shipment_id) ?? null
        : candidates.find((s) => s.courier === "propio") ?? candidates.find((s) => s.courier === "por_definir") ?? candidates[0] ?? null;
      if (!shipment) { skippedNoShipment += 1; continue; }
      if (inBox.has(shipment.id)) { skippedInBox += 1; continue; }
      const other = elsewhere.get(shipment.id);
      if (other && other !== manifestId) {
        skippedElsewhere += 1;
        console.warn(`  ! ${rider.full_name} ${route.route_date}: salida ${shipment.id} activa en otra caja ${other}; se salta`);
        continue;
      }
      const at = stop.reported_at ?? custodyAt;
      added += 1;
      if (dryRun) continue;
      const { error: itemError } = await admin.from("dispatch_manifest_items").insert({
        manifest_id: manifestId, shipment_id: shipment.id, store_id: stop.store_id ?? shipment.store_id,
        added_by: actor, added_at: at, office_checked_by: actor, office_checked_at: at,
        pickup_checked_by: rider.user_id ?? actor, pickup_checked_at: at,
      });
      if (itemError) { console.warn(`  ! ${rider.full_name} ${route.route_date} ${stop.order_id}: ${itemError.message}`); continue; }
      inBox.add(shipment.id);
      if (shipment.custody_state === "empresa" || shipment.custody_state == null) {
        await admin.from("shipments").update({ custody_state: "courier", custody_transferred_at: at, custody_transferred_by: actor, dispatched_at: at }).eq("id", shipment.id).is("dispatched_at", null);
        await admin.from("shipments").update({ custody_state: "courier", custody_transferred_at: at, custody_transferred_by: actor }).eq("id", shipment.id).not("dispatched_at", "is", null);
      }
      const patch: Record<string, unknown> = {};
      if (!stop.shipment_id) patch.shipment_id = shipment.id;
      if (!stop.dispatch_manifest_id) patch.dispatch_manifest_id = manifestId;
      if (Object.keys(patch).length) await admin.from("delivery_stops").update(patch).eq("id", stop.id);
      await admin.from("dispatch_events").insert({
        org_id: orgId, manifest_id: manifestId, shipment_id: shipment.id, actor, kind: "package_added",
        payload: { source: "cuaderno", backfilled: true, stop_id: stop.id, at },
      });
    }
    itemsCreated += added;
    console.log(`- ${rider.full_name} ${route.route_date} (${route.status}): ${stops.length} paradas · caja ${manifests?.[0] ? "existente" : "nueva"} · ítems nuevos ${added}`);
  }
  console.log(`${dryRun ? "[dry-run] " : ""}TOTAL: cajas nuevas ${boxesCreated}, ítems ${itemsCreated}, ya en caja ${skippedInBox}, en otra caja ${skippedElsewhere}, sin salida ${skippedNoShipment}`);
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
