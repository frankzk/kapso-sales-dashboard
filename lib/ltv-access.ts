import "server-only";
import { createServerSupabase } from "@/lib/db";
import { HORIZONS, LTV_SINCE, type CohortRow, type SpendRow } from "@/lib/ltv";

const finite = (value: unknown): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

/**
 * Las clientas nuevas por tienda y mes de primera entrega, y el gasto de Meta
 * por mes (migración 0252). Con la sesión de quien mira: las políticas de cada
 * tabla deciden qué tiendas ve. Un error se dice, no se convierte en ceros: un
 * ratio calculado sobre datos que faltan engaña.
 */
export async function getLtvInputs(storeIds: string[]): Promise<{ cohorts: CohortRow[]; spend: SpendRow[] }> {
  if (!storeIds.length) return { cohorts: [], spend: [] };
  const sb = await createServerSupabase();
  const [cohortsRes, spendRes] = await Promise.all([
    sb.rpc("ltv_cohorts", { p_store_ids: storeIds, p_since: LTV_SINCE }),
    sb.rpc("meta_spend_by_month", { p_store_ids: storeIds, p_since: LTV_SINCE }),
  ]);
  if (cohortsRes.error) throw new Error(`No se pudieron cargar las clientas por mes: ${cohortsRes.error.message}`);
  if (spendRes.error) throw new Error(`No se pudo cargar el gasto de Meta por mes: ${spendRes.error.message}`);
  const cohorts = ((cohortsRes.data ?? []) as Array<Record<string, unknown>>).map((row) => ({
    storeId: String(row.store_id),
    month: String(row.cohort_month).slice(0, 10),
    newCustomers: Math.trunc(finite(row.new_customers)),
    lastFirstAt: String(row.last_first_at),
    values: Object.fromEntries(HORIZONS.map((h) => [h, finite(row[`value_${h}`])])) as CohortRow["values"],
    repeat90: Math.trunc(finite(row.repeat_90)),
  }));
  const spend = ((spendRes.data ?? []) as Array<Record<string, unknown>>).map((row) => ({
    storeId: String(row.store_id),
    month: String(row.month).slice(0, 10),
    currency: String(row.currency ?? "?"),
    spend: finite(row.spend),
  }));
  return { cohorts, spend };
}
