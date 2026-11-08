// Una sola pestaña por tienda avanza la rotación de Yapes en cada vuelta (0312).
//
// `listYapeAlerts` corre cada 15 s en cada pestaña visible de cada usuaria, y
// cada una reconciliaba las ofertas de todas sus tiendas: con N pestañas, N
// veces la misma lectura de Yapes y N veces la comprobación de bloques de la
// asesora con la oferta; y cuando una oferta vencía, todas a la vez leían los
// bloques de cada asesora en línea. Ahora la primera pestaña que llega se queda
// la vuelta (`claim_yape_reconcile_tick`, una fila por tienda con la hora de la
// última) y las demás, durante `YAPE_RECONCILE_MIN_MS`, no reconcilian: su
// pop-up sigue leyendo lo que esa vuelta dejó ofrecido.
//
// Con una sola pestaña nada cambia (15 s > 10 s). Ninguna regla cambia: a quién
// se ofrece, cuánto dura la oferta (90 s) y cuándo se pasa son los mismos; solo
// deja de repetirse el mismo trabajo en paralelo.
//
// Sin la 0312 (la función no existe) o ante cualquier error, se reconcilia como
// antes: la rotación nunca se queda parada por esta optimización.
import type { SupabaseClient } from "@supabase/supabase-js";

/** Entre dos reconciliaciones de la misma tienda, venga de la pestaña que venga. */
export const YAPE_RECONCILE_MIN_MS = 10_000;

export async function claimYapeReconcileTick(admin: Pick<SupabaseClient, "rpc">, storeId: string): Promise<boolean> {
  try {
    const { data, error } = await admin.rpc("claim_yape_reconcile_tick", {
      p_store: storeId,
      p_min_seconds: YAPE_RECONCILE_MIN_MS / 1000,
    });
    if (error) return true;
    return data !== false;
  } catch {
    return true;
  }
}
