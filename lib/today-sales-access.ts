import "server-only";
import { createServerSupabase } from "@/lib/db";
import {
  buildTodaySales,
  queryBounds,
  todayWindows,
  type TodayOrderRow,
  type TodaySales,
  type TodayStoreInput,
} from "@/lib/today-sales";

const PAGE = 1000;
/** Tope de seguridad: dos días de todas las tiendas no se acercan a esto. */
const MAX_ROWS = 20_000;

/**
 * Los pedidos de ayer y hoy de las tiendas (MOM §17.5), con la sesión de quien
 * mira: las políticas de `orders` deciden qué tiendas ve. Lee la tabla y no
 * `pedidos_canal` porque «Hoy» no parte por canal; son las mismas filas. Un
 * error se dice, no se convierte en ceros: «0 pedidos hoy» engañaría.
 */
export async function getTodaySales(stores: readonly TodayStoreInput[], now = new Date()): Promise<TodaySales> {
  const bounds = queryBounds(todayWindows(stores, now));
  const rows: TodayOrderRow[] = [];
  if (bounds) {
    const sb = await createServerSupabase();
    const ids = stores.map((s) => s.id);
    for (let from = 0; from < MAX_ROWS; from += PAGE) {
      const { data, error } = await sb
        .from("orders")
        .select("store_id,created_at,total_amount,total_refunded,cancelled_at")
        .in("store_id", ids)
        .gte("created_at", bounds.desde)
        .lt("created_at", bounds.hasta)
        .order("created_at")
        .order("id")
        .range(from, from + PAGE - 1);
      if (error) throw new Error(`No se pudieron leer los pedidos de hoy: ${error.message}`);
      const page = (data ?? []) as TodayOrderRow[];
      rows.push(...page);
      if (page.length < PAGE) break;
    }
  }
  return buildTodaySales(stores, rows, now);
}
