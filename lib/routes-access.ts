// Lecturas de las rutas de reparto, con RLS.
//
// Las mismas funciones sirven al coordinador y al motorizado: lo que cambia es
// lo que la BASE les devuelve, no lo que pide el código. Las políticas de 0056
// filtran por `riders.user_id = auth.uid()`, así que un motorizado que llame a
// `getRouteDetail` con el id de la ruta de otro recibe null. La seguridad no
// depende de que la interfaz recuerde filtrar.

import { createServerSupabase } from "@/lib/db";
import { chunk } from "@/lib/access";
import type { RouteStop } from "@/lib/routes";
import type { CostTariff } from "@/lib/costs";

export interface RouteRow {
  id: string;
  store_id: string;
  rider_id: string;
  route_date: string;
  status: string;
  settlement_id: string | null;
  note: string | null;
  started_at: string | null;
  closed_at: string | null;
}

/** Una parada con lo que el motorizado necesita ver para tocar el timbre. */
export interface StopWithOrder extends RouteStop {
  seq: number;
  /** Tienda del pedido (0057). Es lo que agrupa las liquidaciones cuando una
   *  ruta mezcla tiendas en el mismo viaje. */
  store_id: string | null;
  outcome_reason: string | null;
  note: string | null;
  photo_path: string | null;
  voucher_path: string | null;
  reported_at: string | null;
  order: {
    name: string | null;
    customer_name: string | null;
    customer_phone: string | null;
    address: string | null;
    reference: string | null;
    district: string | null;
    province: string | null;
    total: number | null;
    latitude: number | null;
    longitude: number | null;
  } | null;
}

const ROUTE_COLUMNS =
  "id,store_id,rider_id,route_date,status,settlement_id,note,started_at,closed_at";
const STOP_COLUMNS =
  "id,order_id,store_id,seq,status,payment_method,collected_amount,outcome_reason,note," +
  "photo_path,voucher_path,reported_at";

/** La ficha del motorizado que corresponde al usuario de la petición, si la hay. */
export async function getMyRider(): Promise<{ id: string; full_name: string } | null> {
  const sb = await createServerSupabase();
  const { data: user } = await sb.auth.getUser();
  const uid = user?.user?.id;
  if (!uid) return null;
  const { data } = await sb
    .from("riders")
    .select("id,full_name")
    .eq("user_id", uid)
    .maybeSingle();
  return (data as { id: string; full_name: string } | null) ?? null;
}

/** Rutas visibles. Para el motorizado, RLS las acota a las suyas ya entregadas. */
export async function getRoutes(opts: { riderId?: string; limit?: number } = {}): Promise<RouteRow[]> {
  const sb = await createServerSupabase();
  let q = sb.from("delivery_routes").select(ROUTE_COLUMNS);
  if (opts.riderId) q = q.eq("rider_id", opts.riderId);
  const { data, error } = await q
    .order("route_date", { ascending: false })
    .limit(opts.limit ?? 60);
  if (error) return [];
  return (data ?? []) as unknown as RouteRow[];
}

/**
 * Una ruta con sus paradas y los datos del pedido de cada una. Devuelve null
 * cuando RLS no deja verla — que es lo que ocurre si un motorizado pide la ruta
 * de otro, o la suya antes de que se la entreguen.
 */
export async function getRouteDetail(
  routeId: string,
): Promise<{ route: RouteRow; stops: StopWithOrder[] } | null> {
  const sb = await createServerSupabase();
  const { data: head } = await sb
    .from("delivery_routes")
    .select(ROUTE_COLUMNS)
    .eq("id", routeId)
    .maybeSingle();
  if (!head) return null;
  const route = head as unknown as RouteRow;

  const { data: stopRows } = await sb
    .from("delivery_stops")
    .select(STOP_COLUMNS)
    .eq("route_id", routeId)
    .order("seq");
  const stops = (stopRows ?? []) as unknown as StopWithOrder[];

  const orderIds = [...new Set(stops.map((s) => s.order_id))];
  const byOrder = new Map<string, StopWithOrder["order"]>();
  for (const batch of chunk(orderIds, 200)) {
    const { data } = await sb
      .from("order_master")
      .select(
        "order_id,order_name,customer_name,customer_phone,address,reference," +
          "district,province,order_total,latitude,longitude",
      )
      .in("order_id", batch);
    for (const row of (data ?? []) as unknown as Record<string, unknown>[]) {
      byOrder.set(String(row.order_id), {
        name: (row.order_name as string) ?? null,
        customer_name: (row.customer_name as string) ?? null,
        customer_phone: (row.customer_phone as string) ?? null,
        address: (row.address as string) ?? null,
        reference: (row.reference as string) ?? null,
        district: (row.district as string) ?? null,
        province: (row.province as string) ?? null,
        total: (row.order_total as number) ?? null,
        latitude: (row.latitude as number) ?? null,
        longitude: (row.longitude as number) ?? null,
      });
    }
  }

  return {
    route,
    stops: stops.map((s) => ({ ...s, order: byOrder.get(s.order_id) ?? null })),
  };
}

/** Tarifas de pago al motorizado. Se traen todas y `resolveTariff` elige. */
export async function getRouteTariffs(): Promise<CostTariff[]> {
  const sb = await createServerSupabase();
  const { data, error } = await sb
    .from("cost_tariffs")
    .select("id,store_id,courier,region,province,district,concept,amount,effective_from,effective_to")
    .in("concept", ["motorizado_entrega", "motorizado_visita"]);
  if (error) return [];
  return (data ?? []) as unknown as CostTariff[];
}

/**
 * Pedidos candidatos para armar una ruta: los que están vivos y sin repartir.
 * Se excluyen los que ya están en otra ruta del mismo día para que dos
 * motorizados no salgan con el mismo paquete.
 */
export async function getAssignableOrders(
  storeIds: string[],
  day: string,
  opts: { district?: string | null; limit?: number } = {},
): Promise<
  {
    order_id: string;
    store_id: string;
    order_name: string | null;
    customer_name: string | null;
    district: string | null;
    address: string | null;
    order_total: number | null;
  }[]
> {
  if (!storeIds.length) return [];
  const sb = await createServerSupabase();

  let q = sb
    .from("order_master")
    .select("order_id,store_id,order_name,customer_name,district,address,order_total")
    .in("store_id", storeIds)
    .in("general_status", ["pendiente", "en_proceso"]);
  if (opts.district) q = q.eq("district", opts.district);

  const { data, error } = await q
    .order("order_created_at", { ascending: false })
    .limit(opts.limit ?? 300);
  if (error) return [];
  const candidates = (data ?? []) as unknown as {
    order_id: string;
    store_id: string;
    order_name: string | null;
    customer_name: string | null;
    district: string | null;
    address: string | null;
    order_total: number | null;
  }[];
  if (!candidates.length) return [];

  // Los que ya están asignados ese día, en cualquier ruta que el usuario vea.
  // NO se filtra por la tienda de la RUTA: desde 0057 una ruta mezcla tiendas y
  // su `store_id` es meramente informativo. Filtrar por él dejaría reaparecer
  // como asignable un pedido que ya va en la ruta de otro motorizado, y dos
  // saldrían con el mismo paquete. RLS ya acota las rutas a la organización.
  const { data: routeRows } = await sb
    .from("delivery_routes")
    .select("id")
    .eq("route_date", day);
  const routeIds = ((routeRows ?? []) as { id: string }[]).map((r) => r.id);
  if (!routeIds.length) return candidates;

  const taken = new Set<string>();
  for (const batch of chunk(routeIds, 100)) {
    const { data: stopRows } = await sb
      .from("delivery_stops")
      .select("order_id")
      .in("route_id", batch);
    for (const r of (stopRows ?? []) as { order_id: string }[]) taken.add(r.order_id);
  }
  return candidates.filter((c) => !taken.has(c.order_id));
}

/**
 * Candidatos a reintento: pedidos que un motorizado ya intentó y no pudo
 * entregar, que siguen vivos y no están ya en una ruta.
 *
 * Es lo que ataca la tasa de entrega, que es el dolor real: sin esto, un pedido
 * que ayer no contestó se queda esperando a que alguien se acuerde de él, y
 * nadie se acuerda. Cada candidato viene con lo que hace falta para decidir sin
 * abrir el pedido: cuántas veces falló, por qué la última vez, y si ESE CLIENTE
 * ha recibido alguna vez algo.
 */
export interface RetryCandidate {
  order_id: string;
  store_id: string;
  order_name: string | null;
  customer_name: string | null;
  customer_phone: string | null;
  district: string | null;
  address: string | null;
  order_total: number | null;
  attempts: number;
  lastReason: string | null;
  lastTriedAt: string | null;
  customerFailed: number;
  customerDelivered: number;
}

export async function getRetryCandidates(
  storeIds: string[],
  opts: { limit?: number } = {},
): Promise<RetryCandidate[]> {
  if (!storeIds.length) return [];
  const sb = await createServerSupabase();

  // 1) Paradas no entregadas, de más reciente a más antigua.
  const { data: stopRows } = await sb
    .from("delivery_stops")
    .select("order_id,store_id,outcome_reason,reported_at,status")
    .in("store_id", storeIds)
    .eq("status", "no_entregado")
    .order("reported_at", { ascending: false })
    .limit(2000);
  const stops = (stopRows ?? []) as unknown as {
    order_id: string;
    store_id: string;
    outcome_reason: string | null;
    reported_at: string | null;
  }[];
  if (!stops.length) return [];

  // Intentos por pedido, conservando el motivo del MÁS RECIENTE (vienen
  // ordenados, así que el primero que se ve de cada pedido es el último).
  const byOrder = new Map<string, { attempts: number; lastReason: string | null; lastTriedAt: string | null }>();
  for (const s of stops) {
    const prev = byOrder.get(s.order_id);
    if (prev) prev.attempts++;
    else
      byOrder.set(s.order_id, {
        attempts: 1,
        lastReason: s.outcome_reason,
        lastTriedAt: s.reported_at,
      });
  }

  // 2) Los que ya están en una ruta abierta no vuelven a ofrecerse: ya van.
  const { data: openRoutes } = await sb
    .from("delivery_routes")
    .select("id")
    .in("status", ["planificada", "en_curso"]);
  const openIds = ((openRoutes ?? []) as { id: string }[]).map((r) => r.id);
  const alreadyRouted = new Set<string>();
  for (const batch of chunk(openIds, 100)) {
    const { data } = await sb.from("delivery_stops").select("order_id").in("route_id", batch);
    for (const r of (data ?? []) as { order_id: string }[]) alreadyRouted.add(r.order_id);
  }

  // 3) Solo los que siguen VIVOS: un pedido ya entregado o anulado no se
  //    reintenta, por más veces que fallara antes.
  const ids = [...byOrder.keys()].filter((id) => !alreadyRouted.has(id));
  if (!ids.length) return [];
  const rows: RetryCandidate[] = [];
  const phones = new Set<string>();

  for (const batch of chunk(ids, 200)) {
    const { data } = await sb
      .from("order_master")
      .select(
        "order_id,store_id,order_name,customer_name,customer_phone,district,address,order_total,general_status",
      )
      .in("order_id", batch)
      .in("general_status", ["pendiente", "en_proceso"]);
    for (const r of (data ?? []) as unknown as Record<string, unknown>[]) {
      const agg = byOrder.get(String(r.order_id))!;
      const phone = (r.customer_phone as string) ?? null;
      if (phone) phones.add(phone);
      rows.push({
        order_id: String(r.order_id),
        store_id: String(r.store_id),
        order_name: (r.order_name as string) ?? null,
        customer_name: (r.customer_name as string) ?? null,
        customer_phone: phone,
        district: (r.district as string) ?? null,
        address: (r.address as string) ?? null,
        order_total: (r.order_total as number) ?? null,
        attempts: agg.attempts,
        lastReason: agg.lastReason,
        lastTriedAt: agg.lastTriedAt,
        customerFailed: 0,
        customerDelivered: 0,
      });
    }
  }
  if (!rows.length) return rows;

  // 4) El historial del CLIENTE, por teléfono y a través de TODOS sus pedidos.
  //    Es lo que distingue "mala suerte" de "este cliente nunca recibe".
  const history = new Map<string, { failed: number; delivered: number }>();
  for (const batch of chunk([...phones], 200)) {
    const { data } = await sb
      .from("order_master")
      .select("customer_phone,general_status")
      .in("store_id", storeIds)
      .in("customer_phone", batch);
    for (const r of (data ?? []) as { customer_phone: string | null; general_status: string }[]) {
      if (!r.customer_phone) continue;
      const h = history.get(r.customer_phone) ?? { failed: 0, delivered: 0 };
      if (r.general_status === "entregado") h.delivered++;
      else if (r.general_status === "anulado" || r.general_status === "devuelto") h.failed++;
      history.set(r.customer_phone, h);
    }
  }
  for (const row of rows) {
    const h = row.customer_phone ? history.get(row.customer_phone) : null;
    if (h) {
      row.customerFailed = h.failed;
      row.customerDelivered = h.delivered;
    }
  }

  return rows.slice(0, opts.limit ?? 200);
}
