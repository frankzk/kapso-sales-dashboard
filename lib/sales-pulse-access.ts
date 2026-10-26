import "server-only";
import { createServerSupabase } from "@/lib/db";
import { env } from "@/lib/env";
import { addDays, localClock, localMidnightUtc } from "@/lib/local-day";
import { parseOriginRows } from "@/lib/consolidado-origen";
import { queryBounds, todayWindows, type TodayOrderRow, type TodayStoreInput } from "@/lib/today-sales";
import {
  buildDayPulse,
  buildPeriodPulse,
  cutDays,
  periodWindow,
  salesFloor,
  type PulsePeriod,
  type SalesPulse,
} from "@/lib/sales-pulse";

type ServerClient = Awaited<ReturnType<typeof createServerSupabase>>;

const PAGE = 1000;
/** Dos días de todas las tiendas no se acercan a esto; si se llega, se dice en vez de cortar. */
const MAX_ROWS = 20_000;

/** Los pedidos creados en [desde, hasta) de las tiendas, de a mil. */
async function readOrders(sb: ServerClient, ids: string[], desde: string, hasta: string): Promise<TodayOrderRow[]> {
  const rows: TodayOrderRow[] = [];
  for (let from = 0; ; from += PAGE) {
    if (from >= MAX_ROWS) throw new Error(`Más de ${MAX_ROWS} pedidos en el tramo: no se cuentan a medias`);
    const { data, error } = await sb
      .from("orders")
      .select("store_id,created_at,total_amount,total_refunded,cancelled_at")
      .in("store_id", ids)
      .gte("created_at", desde)
      .lt("created_at", hasta)
      .order("created_at")
      .order("id")
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`No se pudieron leer los pedidos: ${error.message}`);
    const page = (data ?? []) as TodayOrderRow[];
    rows.push(...page);
    if (page.length < PAGE) return rows;
  }
}

/**
 * Desde qué día local cada tienda tiene todas sus ventas en Kapta (ver
 * `salesFloor`): su primer pedido, por el índice (store_id, created_at).
 */
async function salesFloors(sb: ServerClient, stores: readonly TodayStoreInput[]): Promise<Map<string, string | null>> {
  const syncFrom = env.ordersSyncFrom();
  const firsts = await Promise.all(
    stores.map((s) =>
      sb.from("orders").select("created_at").eq("store_id", s.id).order("created_at").limit(1),
    ),
  );
  return new Map(
    stores.map((s, i) => {
      const { data, error } = firsts[i]!;
      if (error) throw new Error(`No se pudo leer el primer pedido de la tienda: ${error.message}`);
      const createdAt = (data?.[0] as { created_at?: string } | undefined)?.created_at;
      const day = createdAt ? localClock(createdAt, s.timezone?.trim() || "UTC").date : null;
      return [s.id, salesFloor(syncFrom, day)];
    }),
  );
}

/**
 * «Cómo van las ventas» (MOM §17.5) con la sesión de quien mira: las políticas
 * de `orders` (y de `pedidos_canal` detrás de `ventas_por_origen`) deciden qué
 * tiendas ve. Hoy lee los pedidos de ayer y hoy; la semana y el mes, el total
 * por día de `ventas_por_origen` (0268) y los pedidos del día del corte. Un
 * error se dice, no se convierte en ceros: «0 pedidos» engañaría.
 */
export async function getSalesPulse(stores: readonly TodayStoreInput[], periodo: PulsePeriod, now = new Date()): Promise<SalesPulse> {
  const sb = await createServerSupabase();
  const ids = stores.map((s) => s.id);
  const floorsPromise = salesFloors(sb, stores);

  if (periodo === "hoy") {
    const bounds = queryBounds(todayWindows(stores, now));
    const [rows, floors] = await Promise.all([bounds ? readOrders(sb, ids, bounds.desde, bounds.hasta) : [], floorsPromise]);
    return buildDayPulse(stores, rows, floors, now);
  }

  const windows = stores.map((s) => periodWindow(s, periodo, now));
  const cuts = cutDays(windows);
  const from = windows.reduce((min, w) => (w.anteriorDesde < min ? w.anteriorDesde : min), windows[0]?.anteriorDesde ?? "");
  const to = windows.reduce((max, w) => (w.hoy > max ? w.hoy : max), windows[0]?.hoy ?? "");
  const daysPromise = ids.length
    ? sb.rpc("ventas_por_origen", { p_store_ids: ids, p_from: from, p_to: to }).then(({ data, error }) => {
        if (error) throw new Error(`No se pudieron leer las ventas por día: ${error.message}`);
        return parseOriginRows(data);
      })
    : Promise.resolve([]);
  const cutPromise = cuts.length
    ? readOrders(
        sb,
        cuts.map((c) => c.storeId),
        cuts.map((c) => localMidnightUtc(c.day, c.timezone)).reduce((a, b) => (a < b ? a : b)),
        cuts.map((c) => localMidnightUtc(addDays(c.day, 1), c.timezone)).reduce((a, b) => (a > b ? a : b)),
      )
    : Promise.resolve([]);
  const [days, cutRows, floors] = await Promise.all([daysPromise, cutPromise, floorsPromise]);
  return buildPeriodPulse(stores, periodo, days, cutRows, floors, now);
}
