import type { createAdminSupabase } from "@/lib/db";
import type { ReproScope } from "@/lib/repro-lima-access";
import { allCourierRows, courierRowsByIds } from "@/lib/courier-flow";
import { isLimaPendingStage, LIMA_PENDING_STAGES, type LimaPendingOrder } from "@/lib/repro-lima-pending";

type Admin = ReturnType<typeof createAdminSupabase>;
interface PendingMasterRow {
  order_id: string; store_id: string; order_name: string | null;
  customer_name: string | null; customer_phone: string | null; district: string | null;
  order_total: number | string | null; order_created_at: string | null; macro_since: string | null;
  macro_stage: string; macro_substage: string | null; coverage: string | null;
  current_courier: string | null; dispatched_at: string | null; attempt_count: number | null;
}
interface PendingProgramRow { order_id: string; store_id: string; scheduled_for: string }

/** Solo lectura, después de requireReproLima. Pagina todos los pedidos, sin
 * truncarlos a 1000 y sin cargar expedientes completos por cada fila. */
export async function loadLimaPending(admin: Admin, scope: ReproScope): Promise<LimaPendingOrder[]> {
  const ids = [...scope.storeIds];
  if (!ids.length) return [];
  const [orders, stores, programs] = await Promise.all([
    allCourierRows<PendingMasterRow>((from, to) => admin.from("order_master")
      .select("order_id,store_id,order_name,customer_name,customer_phone,district,order_total,order_created_at,macro_since,macro_stage,macro_substage,coverage,current_courier,dispatched_at,attempt_count")
      .in("store_id", ids).eq("coverage", "lima").in("macro_stage", [...LIMA_PENDING_STAGES])
      .order("order_created_at", { ascending: false, nullsFirst: false }).order("order_id")
      .range(from, to) as unknown as PromiseLike<{ data: PendingMasterRow[] | null; error: { message: string } | null }>),
    courierRowsByIds(ids, (chunk) => admin.from("stores").select("id,name").in("id", chunk)),
    allCourierRows<PendingProgramRow>((from, to) => admin.from("gf_dispatch_programs")
      .select("order_id,store_id,scheduled_for").in("store_id", ids).order("order_id").range(from, to) as unknown as PromiseLike<{ data: PendingProgramRow[] | null; error: { message: string } | null }>),
  ]);
  const names = new Map((stores.data as Array<{ id: string; name: string }>).map((s) => [s.id, s.name]));
  const seen = new Set<string>();
  const safe = orders.filter((row) => {
    if (!scope.storeIds.has(row.store_id) || row.coverage !== "lima" || !isLimaPendingStage(row.macro_stage) || seen.has(row.order_id)) return false;
    seen.add(row.order_id);
    return true;
  });
  const orderStore = new Map(safe.map((row) => [row.order_id, row.store_id]));
  const scheduled = new Map(programs.filter((p) => orderStore.get(p.order_id) === p.store_id).map((p) => [p.order_id, p.scheduled_for]));
  const departures = new Map<string, string>();
  const safeIds = [...orderStore.keys()];
  // La misma fuente de Grupo GF, en lotes de 500: una respuesta jamás puede
  // quedar truncada en 1000 y convertir salidas reales en «Nunca salieron».
  for (let offset = 0; offset < safeIds.length; offset += 500) {
    const { data, error } = await admin.rpc("gf_order_departures", { p_order_ids: safeIds.slice(offset, offset + 500) });
    if (error) throw new Error(`No pudimos leer el historial de salidas: ${error.message}`);
    for (const d of (data ?? []) as Array<{ order_id: string; last_departure_at: string }>) {
      if (orderStore.has(d.order_id) && d.last_departure_at) departures.set(d.order_id, d.last_departure_at);
    }
  }
  return safe.map((row) => {
    // El filtro de arriba valida también la macroetapa de cada fila.
    const stage = row.macro_stage as LimaPendingOrder["stage"];
    return {
      orderId: row.order_id, storeId: row.store_id, storeName: names.get(row.store_id) ?? "Tienda",
      orderName: row.order_name ?? "Sin código", customerName: row.customer_name ?? "Sin nombre",
      customerPhone: row.customer_phone, district: row.district, orderTotal: Number(row.order_total ?? 0),
      createdAt: row.order_created_at, macroSince: row.macro_since, stage,
      substage: row.macro_substage, courier: row.current_courier, dispatchedAt: row.dispatched_at,
      attempts: Number(row.attempt_count ?? 0),
      hasPriorDispatch: departures.has(row.order_id), lastDepartureAt: departures.get(row.order_id) ?? null,
      programmedFor: scheduled.get(row.order_id) ?? null,
    };
  });
}
