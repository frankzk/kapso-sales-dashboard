// Lectura de `advisor_schedules` (migración 0245): la meta de la semana y el
// horario de cada persona. La tabla no tiene policies para el navegador, así que
// se lee con el cliente de servicio: quien llama ya comprobó a quién puede ver.

import type { SupabaseClient } from "@supabase/supabase-js";
import { scheduleFromRow, type AdvisorSchedule, type AdvisorScheduleRow } from "@/lib/productivity-week";

/**
 * Los horarios de las organizaciones dadas, por persona. Si alguien tuviera uno
 * en dos organizaciones, vale el de la primera de la lista. Sin la migración
 * aplicada —o con cualquier error— devuelve un mapa vacío: Productividad sigue
 * con la meta por defecto en vez de caerse.
 */
export async function getAdvisorSchedules(
  admin: SupabaseClient,
  orgIds: string[],
): Promise<Map<string, AdvisorSchedule>> {
  const out = new Map<string, AdvisorSchedule>();
  if (!orgIds.length) return out;
  try {
    const { data, error } = await admin
      .from("advisor_schedules")
      .select("org_id, user_id, weekly_hours, days, start_time, end_time")
      .in("org_id", orgIds);
    if (error || !data) return out;
    const rows = data as (AdvisorScheduleRow & { org_id: string })[];
    for (const orgId of orgIds) {
      for (const row of rows) {
        if (row.org_id === orgId && !out.has(row.user_id)) out.set(row.user_id, scheduleFromRow(row));
      }
    }
  } catch {
    /* sin horarios: la meta por defecto */
  }
  return out;
}
