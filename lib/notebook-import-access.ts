// Servidor de «Cargar la hoja del motorizado» (MOM §29.7, 08-10-2026): quién
// puede, qué ruta toca y con qué se cruza la hoja. Las reglas viven en
// lib/notebook-import.ts; esto solo lee la base.
//
// Entra quien arma rutas (`routes.manage`), igual que «Reparto y liquidación»:
// la ruta se lee con SU cliente, así que si RLS no se la muestra, no existe.
// Lo demás —cajas anteriores, pedidos de la hoja que no están en la ruta— se
// lee con el service role DESPUÉS de esa comprobación, acotado a su org.

import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminSupabase, createServerSupabase } from "@/lib/db";
import { getCurrentUser } from "@/lib/access";
import { getMasterPermissions } from "@/lib/permissions-access";
import { getRouteDetail } from "@/lib/routes-access";
import { loadRouteCollectionBalances } from "@/lib/route-collection-access";
import { NON_DELIVERY_REASONS } from "@/lib/routes";
import {
  codeCandidates,
  ddmm,
  outcomeLabel,
  type NotebookContext,
  type NotebookLine,
  type PlanCarry,
  type PlanOrderElsewhere,
  type PlanStop,
} from "@/lib/notebook-import";

/** Fotos de la hoja: nombres y montos de clientes. Bucket privado. */
export const NOTEBOOK_BUCKET = "rider-notebooks";
/** Hasta dónde se buscan reprogramados que el motorizado conserva. */
const CARRY_WINDOW_DAYS = 30;

export interface NotebookTarget {
  orgId: string;
  riderId: string;
  riderName: string;
  /** El día de la hoja: el de la ruta abierta, u otro del mismo motorizado. */
  routeDate: string;
  /** Null si ese día todavía no tiene ruta: la abre el primer traspaso. */
  routeId: string | null;
  routeStatus: string | null;
  /** Tienda cuyas credenciales de visión se usan (la de la ruta o la primera de la org). */
  storeId: string | null;
}

export type NotebookAuth =
  | { ok: true; userId: string; target: NotebookTarget }
  | { ok: false; status: number; error: string };

/**
 * ¿Puede quien llama cargar la hoja de la ruta `routeId` (o de otro día del
 * mismo motorizado)? Devuelve el día al que va la hoja.
 */
export async function notebookAccess(routeId: string, sheetDate?: string | null): Promise<NotebookAuth> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, status: 401, error: "No autenticado." };
  const permissions = await getMasterPermissions();
  if (!permissions.can("routes.manage")) {
    return { ok: false, status: 403, error: "Tu rol no arma rutas: la hoja la carga quien liquida en Grupo GF Courier." };
  }
  const sb = await createServerSupabase();
  const { data: route } = await sb
    .from("delivery_routes")
    .select("id,org_id,store_id,rider_id,route_date,status")
    .eq("id", routeId)
    .maybeSingle();
  const r = route as { id: string; org_id: string; store_id: string | null; rider_id: string; route_date: string; status: string } | null;
  if (!r) return { ok: false, status: 404, error: "No encontramos esa ruta." };
  const admin = createAdminSupabase();
  const { data: rider } = await admin.from("riders").select("full_name").eq("id", r.rider_id).maybeSingle();
  const riderName = ((rider as { full_name?: string | null } | null)?.full_name ?? "").trim() || "el motorizado";
  const day = sheetDate && /^\d{4}-\d{2}-\d{2}$/.test(sheetDate) ? sheetDate : r.route_date;
  let routeIdForDay: string | null = r.id;
  let status: string | null = r.status;
  if (day !== r.route_date) {
    const { data: other } = await admin
      .from("delivery_routes")
      .select("id,status")
      .eq("org_id", r.org_id)
      .eq("rider_id", r.rider_id)
      .eq("route_date", day)
      .maybeSingle();
    routeIdForDay = (other as { id: string } | null)?.id ?? null;
    status = (other as { status: string } | null)?.status ?? null;
  }
  let storeId = r.store_id;
  if (!storeId) {
    const { data: store } = await admin.from("stores").select("id").eq("org_id", r.org_id).order("name").limit(1).maybeSingle();
    storeId = (store as { id: string } | null)?.id ?? null;
  }
  return {
    ok: true,
    userId: user.id,
    target: { orgId: r.org_id, riderId: r.rider_id, riderName, routeDate: day, routeId: routeIdForDay, routeStatus: status, storeId },
  };
}

const METHOD_LABEL: Record<string, string> = { efectivo: "Efectivo", pos: "POS", yape: "Yape", sin_cobro: "Sin cobro" };

function reportedLabel(stop: { status: string; payment_method?: string | null; collected_amount?: number | null; outcome_reason: string | null }): string | null {
  if (stop.status === "entregado") {
    const method = stop.payment_method ?? "";
    if (method === "efectivo" || method === "pos" || method === "yape" || method === "sin_cobro") {
      return outcomeLabel({ status: "entregado", method, amount: Number(stop.collected_amount ?? 0) });
    }
    return `Entregado${method ? ` · ${METHOD_LABEL[method] ?? method}` : ""}`;
  }
  if (stop.status === "no_entregado") {
    return `No entregado · ${NON_DELIVERY_REASONS.find((r) => r.code === stop.outcome_reason)?.label ?? stop.outcome_reason ?? "sin motivo"}`;
  }
  return null;
}

export interface NotebookStopRef {
  id: string;
  order_id: string;
  route_id: string;
  photo_path: string | null;
  voucher_path: string | null;
  status: string;
}

/** Lo que la hoja necesita para cruzarse, más las paradas para aplicar. */
export async function loadNotebookContext(
  target: NotebookTarget,
  lines: readonly NotebookLine[],
  admin: SupabaseClient = createAdminSupabase(),
): Promise<{ ctx: NotebookContext; stops: Map<string, NotebookStopRef> }> {
  const stopRefs = new Map<string, NotebookStopRef>();
  const stops: PlanStop[] = [];
  if (target.routeId) {
    const detail = await getRouteDetail(target.routeId);
    for (const s of detail?.stops ?? []) {
      stopRefs.set(s.id, { id: s.id, order_id: s.order_id, route_id: target.routeId, photo_path: s.photo_path, voucher_path: s.voucher_path, status: s.status });
      stops.push({
        stopId: s.id,
        orderId: s.order_id,
        orderName: s.order?.name ?? null,
        customerName: s.order?.customer_name ?? null,
        status: s.status,
        reportedLabel: reportedLabel(s),
        total: s.order?.total ?? null,
        remaining: s.collection?.remaining ?? null,
      });
    }
  }

  const carry = await loadCarryCandidates(admin, target, new Set(stops.map((s) => s.orderId)));

  const known = new Set<string>([...stops, ...carry].map((x) => (x.orderName ?? "").toUpperCase()).filter(Boolean));
  const asked = [...new Set(lines.flatMap((l) => codeCandidates(l.order)))].filter((n) => !known.has(n));
  const elsewhere = await loadOrdersElsewhere(admin, target, asked);

  return {
    ctx: { routeDate: target.routeDate, riderName: target.riderName, stops, carry, elsewhere },
    stops: stopRefs,
  };
}

function shiftDay(day: string, days: number): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Los reprogramados que el motorizado sigue teniendo: parada «Reprogramado» en
 * una caja suya de un día anterior, todavía en custodia y con el paquete
 * activo en ella (no volvió a la oficina ni pasó ya a otra ruta). Es la misma
 * condición que valida `gf_carry_over` (0234).
 */
async function loadCarryCandidates(admin: SupabaseClient, target: NotebookTarget, onRoute: Set<string>): Promise<PlanCarry[]> {
  const { data: routes } = await admin
    .from("delivery_routes")
    .select("id,route_date")
    .eq("org_id", target.orgId)
    .eq("rider_id", target.riderId)
    .lt("route_date", target.routeDate)
    .gte("route_date", shiftDay(target.routeDate, -CARRY_WINDOW_DAYS));
  const routeDates = new Map(((routes ?? []) as { id: string; route_date: string }[]).map((r) => [r.id, r.route_date]));
  if (!routeDates.size) return [];
  const { data: stopRows } = await admin
    .from("delivery_stops")
    .select("id,order_id,shipment_id,dispatch_manifest_id,route_id")
    .in("route_id", [...routeDates.keys()])
    .eq("status", "no_entregado")
    .eq("outcome_reason", "reprogramado")
    .not("dispatch_manifest_id", "is", null)
    .not("shipment_id", "is", null);
  const reprogrammed = ((stopRows ?? []) as { id: string; order_id: string; shipment_id: string; dispatch_manifest_id: string; route_id: string }[])
    .filter((s) => !onRoute.has(s.order_id));
  if (!reprogrammed.length) return [];
  const { data: items } = await admin
    .from("dispatch_manifest_items")
    .select("shipment_id,manifest_id,dispatch_manifests!inner(state,rider_id,courier)")
    .in("manifest_id", [...new Set(reprogrammed.map((s) => s.dispatch_manifest_id))])
    .in("shipment_id", [...new Set(reprogrammed.map((s) => s.shipment_id))])
    .is("removed_at", null)
    .eq("dispatch_manifests.state", "in_custody")
    .eq("dispatch_manifests.rider_id", target.riderId)
    .eq("dispatch_manifests.courier", "propio");
  const active = new Set(((items ?? []) as { shipment_id: string; manifest_id: string }[]).map((i) => `${i.manifest_id}:${i.shipment_id}`));
  const live = reprogrammed.filter((s) => active.has(`${s.dispatch_manifest_id}:${s.shipment_id}`));
  if (!live.length) return [];
  const orderIds = [...new Set(live.map((s) => s.order_id))];
  const [{ data: orders }, { data: master }, balances] = await Promise.all([
    admin.from("orders").select("id,name,cancelled_at").in("id", orderIds),
    admin.from("order_master").select("order_id,customer_name,order_total").in("order_id", orderIds),
    loadRouteCollectionBalances(orderIds),
  ]);
  const orderById = new Map(((orders ?? []) as { id: string; name: string | null; cancelled_at: string | null }[]).map((o) => [o.id, o]));
  const masterById = new Map(((master ?? []) as { order_id: string; customer_name: string | null; order_total: number | null }[]).map((m) => [m.order_id, m]));
  const seen = new Set<string>();
  const out: PlanCarry[] = [];
  // El reporte más reciente manda si el mismo paquete se reprogramó dos veces.
  for (const s of [...live].sort((a, b) => (routeDates.get(b.route_id) ?? "").localeCompare(routeDates.get(a.route_id) ?? ""))) {
    const order = orderById.get(s.order_id);
    if (!order || order.cancelled_at || seen.has(s.shipment_id)) continue;
    seen.add(s.shipment_id);
    out.push({
      shipmentId: s.shipment_id,
      orderId: s.order_id,
      orderName: order.name,
      customerName: masterById.get(s.order_id)?.customer_name ?? null,
      fromDate: routeDates.get(s.route_id) ?? target.routeDate,
      total: masterById.get(s.order_id)?.order_total ?? null,
      remaining: balances.get(s.order_id)?.remaining ?? null,
    });
  }
  return out;
}

/**
 * Los pedidos que la hoja nombra y no están ni en la ruta ni para pasar: dónde
 * están, para decírselo a quien liquida en vez de cargarlos.
 */
async function loadOrdersElsewhere(admin: SupabaseClient, target: NotebookTarget, names: string[]): Promise<Map<string, PlanOrderElsewhere>> {
  const out = new Map<string, PlanOrderElsewhere>();
  if (!names.length) return out;
  const { data: stores } = await admin.from("stores").select("id").eq("org_id", target.orgId);
  const storeIds = ((stores ?? []) as { id: string }[]).map((s) => s.id);
  if (!storeIds.length) return out;
  const { data: orders } = await admin.from("orders").select("id,name,cancelled_at").in("name", names.slice(0, 300)).in("store_id", storeIds);
  const found = ((orders ?? []) as { id: string; name: string; cancelled_at: string | null }[]);
  if (!found.length) return out;
  const { data: shipments } = await admin.from("shipments").select("id,order_id").in("order_id", found.map((o) => o.id));
  const orderByShipment = new Map(((shipments ?? []) as { id: string; order_id: string }[]).map((s) => [s.id, s.order_id]));
  const boxes = new Map<string, { rider_id: string | null; driver_name: string | null; route_date: string; state: string }>();
  if (orderByShipment.size) {
    const { data: items } = await admin
      .from("dispatch_manifest_items")
      .select("shipment_id,dispatch_manifests!inner(rider_id,driver_name,route_date,state,courier)")
      .in("shipment_id", [...orderByShipment.keys()])
      .is("removed_at", null)
      .neq("dispatch_manifests.state", "cancelled");
    for (const item of (items ?? []) as unknown as { shipment_id: string; dispatch_manifests: { rider_id: string | null; driver_name: string | null; route_date: string; state: string } }[]) {
      const orderId = orderByShipment.get(item.shipment_id);
      const box = item.dispatch_manifests;
      if (!orderId || !box) continue;
      const prev = boxes.get(orderId);
      if (!prev || box.route_date > prev.route_date) boxes.set(orderId, box);
    }
  }
  for (const o of found) {
    const box = boxes.get(o.id);
    let where: string;
    if (!box) where = "no está en ninguna caja de Grupo GF";
    else if (box.rider_id === target.riderId && box.state !== "in_custody") where = `está en su carga del ${ddmm(box.route_date)}, que todavía no recibió`;
    else if (box.rider_id === target.riderId && box.route_date < target.routeDate) where = `sigue en su caja del ${ddmm(box.route_date)} sin reprogramar ni devolver; solo pasa de ruta un «Reprogramado»`;
    else if (box.rider_id === target.riderId) where = `está en su caja del ${ddmm(box.route_date)}`;
    else where = `está en la caja de ${box.driver_name ?? "otro motorizado"} del ${ddmm(box.route_date)}`;
    out.set(o.name.toUpperCase(), { orderId: o.id, orderName: o.name, cancelled: Boolean(o.cancelled_at), where });
  }
  return out;
}
