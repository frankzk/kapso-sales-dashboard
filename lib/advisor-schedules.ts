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

/**
 * Las vendedoras de las organizaciones dadas. Productividad mide la semana de
 * todas, tengan horario o no: la que no hizo nada en el periodo (con la meta
 * por defecto, el primer día son todas) es justo la que hay que ver. Con
 * cualquier error, ninguna: la tabla sigue con quienes trabajaron.
 */
export async function getOrgVendedoraIds(admin: SupabaseClient, orgIds: string[]): Promise<string[]> {
  if (!orgIds.length) return [];
  try {
    const { data, error } = await admin.from("memberships").select("user_id").in("org_id", orgIds).eq("role", "vendedora");
    if (error || !data) return [];
    return [...new Set((data as { user_id: string }[]).map((m) => m.user_id))];
  } catch {
    return [];
  }
}

/**
 * Desde cuándo está cada persona en las organizaciones dadas (la primera
 * membresía): en un periodo largo, los días antes de su alta no se le piden.
 * Con cualquier error, ninguna fecha: se juzga el periodo entero.
 */
export async function getMemberSince(admin: SupabaseClient, orgIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!orgIds.length) return out;
  try {
    const { data, error } = await admin.from("memberships").select("user_id, created_at").in("org_id", orgIds);
    if (error || !data) return out;
    for (const m of data as { user_id: string; created_at: string | null }[]) {
      if (!m.created_at) continue;
      const prev = out.get(m.user_id);
      if (!prev || m.created_at < prev) out.set(m.user_id, m.created_at);
    }
  } catch {
    /* sin fechas de alta: el periodo entero */
  }
  return out;
}
