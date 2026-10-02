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
 * El ciclo de barrido en curso: por qué página sigue y con qué ventana.
 *
 * Un recorrido entero (~13 páginas) puede no caber en una pasada. Hasta el
 * 02-10-2026 cada pasada cortada volvía a la página 1 y las últimas no se leían
 * nunca: desde el 29-09 no hubo un solo barrido completo (0217). Ahora una
 * pasada cortada deja aquí dónde seguir y la siguiente continúa.
 */
export interface SweepCursor {
  cycleStartedAt: string;
  cycleFrom: string;
  resumePage: number;
}

/**
 * Cuánto puede durar un ciclo antes de descartarlo y volver a la página 1.
 *
 * Un ciclo que se arrastra horas deja de servir como evidencia (el cierre exige
 * un barrido terminado hace menos de 2 h) y su ventana se queda corta por el
 * lado nuevo. Tres horas son nueve pasadas: de sobra para 13 páginas.
 */
export const SWEEP_CYCLE_MAX_AGE_MS = 3 * 60 * 60_000;

export interface SweepPlan {
  /** Página por la que empieza esta pasada. */
  startPage: number;
  /** Inicio del ciclo: es la marca que vale como evidencia al completarse. */
  cycleStartedAt: Date;
  /** Borde antiguo de la ventana; el mismo en todas las pasadas del ciclo. */
  windowFrom: Date;
  /** ¿Continúa un ciclo anterior? Solo para el informe. */
  resumed: boolean;
}

/**
 * Decide si esta pasada continúa el ciclo anotado o empieza uno nuevo. Pura.
 *
 * Empieza uno nuevo cuando no hay cursor, cuando es ilegible o cuando el ciclo
 * es más viejo que `SWEEP_CYCLE_MAX_AGE_MS`. Ante cualquier duda, página 1: leer
 * de más solo cuesta tiempo, saltarse páginas cuesta guías congeladas.
 */
export function planSweep(
  cursor: SweepCursor | null,
  now: Date,
  lookbackMs: number,
): SweepPlan {
  const fresh: SweepPlan = {
    startPage: 1,
    cycleStartedAt: now,
    windowFrom: new Date(now.getTime() - lookbackMs),
    resumed: false,
  };
  if (!cursor) return fresh;
  const started = new Date(cursor.cycleStartedAt);
  const from = new Date(cursor.cycleFrom);
  const page = Math.floor(Number(cursor.resumePage));
  if (!Number.isFinite(started.getTime()) || !Number.isFinite(from.getTime())) return fresh;
  if (!Number.isFinite(page) || page < 2) return fresh;
  if (now.getTime() - started.getTime() > SWEEP_CYCLE_MAX_AGE_MS) return fresh;
  return { startPage: page, cycleStartedAt: started, windowFrom: from, resumed: true };
}

/** El cursor del ciclo en curso, o `null` si no hay ninguno o no se pudo leer. */
export async function readSweepCursor(
  admin: SupabaseClient,
  storeId: string,
): Promise<SweepCursor | null> {
  const { data, error } = await admin
    .from("aliclik_sweep_state")
    .select("cycle_started_at,cycle_from,resume_page")
    .eq("store_id", storeId)
    .maybeSingle();
  if (error || !data) return null;
  const row = data as { cycle_started_at: string | null; cycle_from: string | null; resume_page: number | null };
  if (!row.cycle_started_at || !row.cycle_from || row.resume_page == null) return null;
  return { cycleStartedAt: row.cycle_started_at, cycleFrom: row.cycle_from, resumePage: row.resume_page };
}

/**
 * Deja anotada la pasada del barrido.
 *
 * `complete: false` NO toca las marcas del último barrido completo —una pasada
 * truncada no es evidencia de nada, y pisar las marcas buenas dejaría al cierre
 * creyendo que se buscó cuando no se llegó a buscar—. Lo que sí anota es dónde
 * seguir (`resumePage`), para que la próxima pasada continúe el mismo ciclo.
 *
 * `complete: true` cierra el ciclo: sus marcas pasan a ser las del último
 * barrido completo, con el inicio del CICLO como inicio (MOM §10.2), y el
 * cursor se vacía para que el próximo empiece por la página 1.
 */
export async function recordSweep(
  admin: SupabaseClient,
  storeId: string,
  sweep: {
    /** Inicio del ciclo, no de esta pasada. */
    startedAt: Date;
    finishedAt: Date;
    windowFrom: Date;
    complete: boolean;
    /** Por qué página sigue el ciclo. `null` lo descarta (próxima pasada: página 1). */
    resumePage?: number | null;
  },
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
    patch.cycle_started_at = null;
    patch.cycle_from = null;
    patch.resume_page = null;
  } else if (sweep.resumePage && sweep.resumePage > 1) {
    patch.cycle_started_at = sweep.startedAt.toISOString();
    patch.cycle_from = sweep.windowFrom.toISOString();
    patch.resume_page = sweep.resumePage;
  } else {
    patch.cycle_started_at = null;
    patch.cycle_from = null;
    patch.resume_page = null;
  }

  const { error } = await admin.from("aliclik_sweep_state").upsert(patch, { onConflict: "store_id" });
  return error ? error.message : null;
}
