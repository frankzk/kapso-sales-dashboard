// La constancia que el barrido de Aliclik deja de sí mismo, y que el cierre lee.
//
// Es la costura entre los dos crones que antes eran uno solo
// (`aliclik-reconcile` recorre el listado; `aliclik-close` caduca candados y
// persigue rezagadas). El barrido escribe aquí solo cuando se recorrió ENTERO;
// el cierre lo lee y decide si su evidencia sirve. Sin esta tabla, separar los
// crones habría significado caducar a ciegas — ver 0116 y MOM §10.2.
//
// Los dos accesos viven juntos y son lo único que toca la tabla, para que la
// forma del registro no se duplique en dos rutas que ya no comparten nada más.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { SweepEvidence } from "@/lib/aliclik-orphan-expiry";

interface SweepStateRow {
  last_full_sweep_started_at: string | null;
  last_full_sweep_at: string | null;
  last_full_sweep_from: string | null;
}

/**
 * El último barrido completo de esta tienda, o `null` si no consta ninguno.
 *
 * Un fallo de lectura devuelve `null` a propósito: quien llama trata la ausencia
 * de evidencia como "no caduques nada", que es justo lo que corresponde cuando
 * no pudimos comprobar si hubo barrido.
 */
export async function readSweepEvidence(
  admin: SupabaseClient,
  storeId: string,
): Promise<SweepEvidence | null> {
  const { data, error } = await admin
    .from("aliclik_sweep_state")
    .select("last_full_sweep_started_at,last_full_sweep_at,last_full_sweep_from")
    .eq("store_id", storeId)
    .maybeSingle();

  if (error || !data) return null;
  const row = data as SweepStateRow;
  if (!row.last_full_sweep_started_at || !row.last_full_sweep_at) return null;

  return {
    startedAt: row.last_full_sweep_started_at,
    completedAt: row.last_full_sweep_at,
    // Sin borde de ventana la caducidad sigue siendo posible, pero deja de poder
    // llamarse comprobada. El selector lo degrada a "no verificada".
    windowFrom: row.last_full_sweep_from ?? "",
  };
}

/**
 * Deja anotada la pasada del barrido.
 *
 * `complete: false` toca únicamente `last_sweep_attempt_at`: una pasada truncada
 * —por error de la API, por el tope de páginas o por agotar su presupuesto de
 * tiempo— NO es evidencia de nada, y pisar las marcas buenas con las suyas
 * dejaría al cierre creyendo que se buscó cuando no se llegó a buscar.
 */
export async function recordSweep(
  admin: SupabaseClient,
  storeId: string,
  sweep: { startedAt: Date; finishedAt: Date; windowFrom: Date; complete: boolean },
): Promise<string | null> {
  const patch: Record<string, unknown> = {
    store_id: storeId,
    last_sweep_attempt_at: sweep.finishedAt.toISOString(),
    updated_at: sweep.finishedAt.toISOString(),
  };
  if (sweep.complete) {
    patch.last_full_sweep_started_at = sweep.startedAt.toISOString();
    patch.last_full_sweep_at = sweep.finishedAt.toISOString();
    patch.last_full_sweep_from = sweep.windowFrom.toISOString();
  }

  const { error } = await admin.from("aliclik_sweep_state").upsert(patch, { onConflict: "store_id" });
  return error ? error.message : null;
}
