// Escritura de las excepciones de cobertura por distrito (0121).
//
// POR QUÉ NO ES UN `upsert`. La unicidad de la tabla la garantiza un índice por
// EXPRESIÓN:
//
//   create unique index district_coverage_scope_uniq
//     on district_coverage (coalesce(store_id, '000…'::uuid), district);
//
// El `coalesce` está ahí por una buena razón —mete la fila global en el mismo
// índice que las de tienda, que es lo que impide dos globales del mismo distrito
// contradiciéndose— pero tiene una consecuencia que costó cara: `ON CONFLICT
// (store_id, district)` exige un índice cuyas COLUMNAS sean exactamente esas, y
// un índice por expresión no casa. Postgres responde «there is no unique or
// exclusion constraint matching the ON CONFLICT specification».
//
// Así que el upsert de la pantalla de Ajustes falló SIEMPRE, desde el primer
// despliegue: la tabla existía, la interfaz estaba, y no se llegó a guardar ni
// una excepción. Nadie se enteró porque nada ejercitaba la escritura.
//
// Se lee y se escribe en dos pasos. El índice sigue protegiendo de duplicados,
// así que una carrera —dos administradores guardando el mismo distrito a la vez—
// choca contra él y se reintenta como actualización en vez de perderse.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { DistrictCoverageValue } from "@/lib/district-coverage";

/** Código de Postgres para violación de unicidad. */
const UNIQUE_VIOLATION = "23505";

export interface DistrictCoverageInput {
  /** `null` = vale para todas las tiendas. */
  storeId: string | null;
  /** Ya normalizado con `normalizeDistrictKey`. */
  district: string;
  coverage: DistrictCoverageValue;
  note: string | null;
  updatedBy: string | null;
}

/**
 * Crea o actualiza la excepción de un distrito. Devuelve el mensaje de error de
 * la base, o nada si fue bien.
 */
export async function saveDistrictCoverageRow(
  admin: SupabaseClient,
  input: DistrictCoverageInput,
): Promise<{ error?: string }> {
  // `store_id` nulo no se compara con `eq`: en SQL nada es igual a NULL, así que
  // la fila global solo aparece con `is`.
  const find = async () => {
    const base = admin.from("district_coverage").select("id").eq("district", input.district);
    const { data, error } =
      input.storeId === null ? await base.is("store_id", null) : await base.eq("store_id", input.storeId);
    return { rows: (data ?? []) as { id: string }[], error };
  };

  const patch = {
    coverage: input.coverage,
    note: input.note,
    updated_at: new Date().toISOString(),
    updated_by: input.updatedBy,
  };

  const found = await find();
  if (found.error) return { error: found.error.message };

  const existing = found.rows[0];
  if (existing) {
    const { error } = await admin
      .from("district_coverage")
      .update(patch)
      .eq("id", existing.id);
    return error ? { error: error.message } : {};
  }

  const { error } = await admin.from("district_coverage").insert({
    store_id: input.storeId,
    district: input.district,
    ...patch,
  });
  if (!error) return {};

  // Otra escritura ganó la carrera entre el SELECT y el INSERT. La fila que hay
  // ahora es la buena para actualizar: no se pierde lo que el operador escribió.
  if ((error as { code?: string }).code === UNIQUE_VIOLATION) {
    const retry = await find();
    const row = retry.rows[0];
    if (row) {
      const { error: updateError } = await admin
        .from("district_coverage")
        .update(patch)
        .eq("id", row.id);
      return updateError ? { error: updateError.message } : {};
    }
  }
  return { error: error.message };
}
