// El traspaso del reprogramado que el motorizado conserva, sin su hoja (MOM
// §29.7, 01-11-2026). Las reglas puras están en lib/gf-carry-kept.ts; aquí,
// la base. Lo usan Reparto y liquidación (quien arma rutas) y la app del
// motorizado («Me lo quedo y lo llevo»).

import type { SupabaseClient } from "@supabase/supabase-js";
import { carryKeptProblem } from "@/lib/gf-carry-kept";
import { clearGfDispatchPrograms, type GfProgramRow } from "@/lib/gf-dispatch-program";

/** Hoy en Lima (UTC-5, sin horario de verano), YYYY-MM-DD. */
export function limaTodayIso(now: number = Date.now()): string {
  return new Date(now - 5 * 3_600_000).toISOString().slice(0, 10);
}

export type CarryKeptResult = { ok: true; toDate: string } | { ok: false; error: string };

/**
 * Pasa a la ruta de `toDate` del mismo motorizado el reprogramado de la parada
 * `stopId`, que él conserva. Comprueba lo que se puede decir con palabras
 * claras antes de llamar a `gf_carry_over`, que vuelve a validarlo todo con
 * candado (y dice por qué no, si Despacho está armando la carga de ese día).
 */
export async function carryKeptStop(
  admin: SupabaseClient,
  input: { stopId: string; toDate: string; actor: string; now?: number },
): Promise<CarryKeptResult> {
  const { data: stopRow, error: stopErr } = await admin
    .from("delivery_stops")
    .select("id,order_id,status,outcome_reason,shipment_id,dispatch_manifest_id,route_id")
    .eq("id", input.stopId)
    .maybeSingle();
  if (stopErr) return { ok: false, error: "No se pudo leer la parada. Reintenta." };
  const stop = stopRow as {
    id: string;
    order_id: string;
    status: string;
    outcome_reason: string | null;
    shipment_id: string | null;
    dispatch_manifest_id: string | null;
    route_id: string;
  } | null;
  if (!stop) return { ok: false, error: "Esa parada ya no existe." };
  if (stop.status !== "no_entregado" || stop.outcome_reason !== "reprogramado") {
    return { ok: false, error: "Solo pasa a otra ruta un «No entregado · Reprogramado»." };
  }
  if (!stop.dispatch_manifest_id || !stop.shipment_id) {
    return { ok: false, error: "Esta parada no salió en una caja de Grupo GF: no hay paquete que pasar." };
  }

  const { data: routeRow } = await admin
    .from("delivery_routes")
    .select("rider_id,route_date")
    .eq("id", stop.route_id)
    .maybeSingle();
  const route = routeRow as { rider_id: string | null; route_date: string } | null;
  if (!route?.rider_id) return { ok: false, error: "La ruta no tiene motorizado." };

  const problem = carryKeptProblem(String(route.route_date), input.toDate, limaTodayIso(input.now));
  if (problem) return { ok: false, error: problem };

  const { data: item } = await admin
    .from("dispatch_manifest_items")
    .select("id")
    .eq("manifest_id", stop.dispatch_manifest_id)
    .eq("shipment_id", stop.shipment_id)
    .is("removed_at", null)
    .maybeSingle();
  if (!item) return { ok: false, error: "El paquete ya no está en esa caja: volvió a la oficina o ya pasó a otra ruta." };

  const { error } = await admin.rpc("gf_carry_over", {
    p_rider_id: route.rider_id,
    p_to_date: input.toDate,
    p_shipment_ids: [stop.shipment_id],
    p_actor: input.actor,
  });
  if (error) return { ok: false, error: error.message };
  // Ya está en la caja de su ruta: el programa de salida se cumplió (§29.6,
  // «la programación se borra cuando el pedido entra en la caja»), también el
  // que puso la fecha de la puerta. Best-effort.
  try {
    const { data: program } = await admin
      .from("gf_dispatch_programs")
      .select("order_id,store_id,scheduled_for,reason,set_at")
      .eq("order_id", stop.order_id)
      .maybeSingle();
    if (program) await clearGfDispatchPrograms(admin, [program as GfProgramRow], input.actor, "Pasó a la ruta del motorizado, que conserva el paquete.");
  } catch {
    /* best-effort: el traspaso ya quedó */
  }
  return { ok: true, toDate: input.toDate };
}

export interface KeptReprogrammed {
  stopId: string;
  orderId: string;
  orderName: string | null;
  customerName: string | null;
  district: string | null;
  total: number | null;
  /** Día de la ruta en que se reprogramó. */
  fromDate: string;
  /** Anulado en la tienda: no pasa, vuelve a la oficina. */
  cancelled: boolean;
}

/** Cuántos días atrás se buscan reprogramados que el motorizado conserva. */
export const KEPT_LOOKBACK_DAYS = 30;

/**
 * Los reprogramados que el motorizado todavía tiene en una caja de una ruta
 * anterior a `beforeDate`: ni devueltos a la oficina ni pasados a otra ruta.
 * Sin los pedidos que ya tienen parada en la ruta de `beforeDate`.
 */
export async function loadKeptReprogrammed(
  admin: SupabaseClient,
  riderId: string,
  beforeDate: string,
): Promise<KeptReprogrammed[]> {
  const since = new Date(Date.parse(`${beforeDate}T12:00:00Z`) - KEPT_LOOKBACK_DAYS * 86_400_000).toISOString().slice(0, 10);
  const { data: routes, error: routesErr } = await admin
    .from("delivery_routes")
    .select("id,route_date")
    .eq("rider_id", riderId)
    .gte("route_date", since)
    .lte("route_date", beforeDate);
  if (routesErr) throw new Error(`rutas del motorizado: ${routesErr.message}`);
  const routeRows = (routes ?? []) as { id: string; route_date: string }[];
  const before = routeRows.filter((r) => String(r.route_date) < beforeDate);
  if (!before.length) return [];
  const dateOf = new Map(before.map((r) => [r.id, String(r.route_date)]));

  const { data: stops, error: stopsErr } = await admin
    .from("delivery_stops")
    .select("id,order_id,route_id,shipment_id,dispatch_manifest_id")
    .in("route_id", before.map((r) => r.id))
    .eq("status", "no_entregado")
    .eq("outcome_reason", "reprogramado")
    .not("dispatch_manifest_id", "is", null);
  if (stopsErr) throw new Error(`reprogramados: ${stopsErr.message}`);
  const candidates = ((stops ?? []) as { id: string; order_id: string; route_id: string; shipment_id: string | null; dispatch_manifest_id: string }[])
    .filter((s) => s.shipment_id);
  if (!candidates.length) return [];

  // Siguen en su caja: el ítem activo (ni devuelto ni pasado a otra ruta).
  const { data: items } = await admin
    .from("dispatch_manifest_items")
    .select("manifest_id,shipment_id")
    .in("manifest_id", [...new Set(candidates.map((s) => s.dispatch_manifest_id))])
    .in("shipment_id", candidates.map((s) => s.shipment_id as string))
    .is("removed_at", null);
  const active = new Set(((items ?? []) as { manifest_id: string; shipment_id: string }[]).map((i) => `${i.manifest_id}:${i.shipment_id}`));
  const inBox = candidates.filter((s) => active.has(`${s.dispatch_manifest_id}:${s.shipment_id}`));
  if (!inBox.length) return [];

  // Los que ya tienen parada en la ruta del día no se ofrecen otra vez.
  const target = routeRows.find((r) => String(r.route_date) === beforeDate);
  const already = new Set<string>();
  if (target) {
    const { data: own } = await admin.from("delivery_stops").select("order_id").eq("route_id", target.id);
    for (const r of (own ?? []) as { order_id: string }[]) already.add(r.order_id);
  }

  // El más reciente por pedido: el mismo pedido puede reprogramarse dos veces.
  const latest = new Map<string, (typeof inBox)[number]>();
  for (const s of inBox) {
    if (already.has(s.order_id)) continue;
    const prev = latest.get(s.order_id);
    if (!prev || (dateOf.get(s.route_id) ?? "") > (dateOf.get(prev.route_id) ?? "")) latest.set(s.order_id, s);
  }
  if (!latest.size) return [];

  const orderIds = [...latest.keys()];
  const [{ data: master }, { data: orders }] = await Promise.all([
    admin.from("order_master").select("order_id,order_name,customer_name,district,order_total").in("order_id", orderIds),
    admin.from("orders").select("id,cancelled_at").in("id", orderIds),
  ]);
  const byOrder = new Map(((master ?? []) as Record<string, unknown>[]).map((m) => [String(m.order_id), m]));
  const cancelled = new Set(((orders ?? []) as { id: string; cancelled_at: string | null }[]).filter((o) => o.cancelled_at).map((o) => o.id));

  return [...latest.values()]
    .map((s) => {
      const m = byOrder.get(s.order_id);
      return {
        stopId: s.id,
        orderId: s.order_id,
        orderName: (m?.order_name as string | undefined) ?? null,
        customerName: (m?.customer_name as string | undefined) ?? null,
        district: (m?.district as string | undefined) ?? null,
        total: m?.order_total == null ? null : Number(m.order_total),
        fromDate: dateOf.get(s.route_id) ?? "",
        cancelled: cancelled.has(s.order_id),
      };
    })
    .sort((a, b) => a.fromDate.localeCompare(b.fromDate) || (a.orderName ?? "").localeCompare(b.orderName ?? ""));
}
