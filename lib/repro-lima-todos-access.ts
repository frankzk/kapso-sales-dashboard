// «Todos» de Repro Lima (MOM §9.5, 14-10-2026): la lectura. Una sola llamada a
// `order_master_lima_open_counts` (migración 0256) con el cliente de servicio,
// después de `requireReproLima`: los pedidos de Lima (cobertura) sin
// «Finalizado» de las tiendas a su alcance, por tienda, macroetapa y subetapa,
// con cuántos llevan más de 7 y de 30 días de Lima en la etapa. Las reglas del
// resumen viven en lib/repro-lima-todos.ts (puras).
//
// Va aparte de lib/repro-lima-access.ts a propósito: `loadReproLima` no cambia
// (Almacén lo llama, entrega 1c) y esta lectura no relee los hechos de cada
// pedido ni escribe nada. Solo lee.
//
// Nunca lanza: sin la migración 0256 (PGRST202 si el código sale antes), con
// error o con un fallo de red, deja una línea en el log y devuelve null, y la
// tarjeta «Todos» no aparece. El resto de Repro Lima sigue igual.

import type { createAdminSupabase } from "@/lib/db";
import { limaClock } from "@/lib/grupo-gf-courier";
import type { ReproScope } from "@/lib/repro-lima-access";
import { parseLimaOpenCounts, type LimaOpenCounts } from "@/lib/repro-lima-todos";

type Admin = ReturnType<typeof createAdminSupabase>;

/** Nunca lanza: sin la migración 0256 o con error, null y la tarjeta no aparece. */
export async function loadLimaOpenCounts(admin: Admin, scope: ReproScope, now: Date = new Date()): Promise<LimaOpenCounts | null> {
  // Los días se cuentan en días de Lima: el día de hoy es el de Lima, no el UTC.
  const today = limaClock(now).day;
  try {
    const { data, error } = await admin.rpc("order_master_lima_open_counts", {
      p_store_ids: [...scope.storeIds],
      p_today: today,
    });
    if (error) {
      console.error("repro-lima: conteo de Todos", error.code, error.message);
      return null;
    }
    // La RPC ya filtra por tienda; esto lo vuelve a cerrar en el alcance.
    return { today, rows: parseLimaOpenCounts(data).filter((r) => scope.storeIds.has(r.storeId)) };
  } catch (error) {
    console.error("repro-lima: conteo de Todos", error instanceof Error ? error.message : String(error));
    return null;
  }
}
