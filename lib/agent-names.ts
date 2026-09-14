import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminSupabase } from "@/lib/db";

/**
 * Id de asesora → nombre para mostrar.
 *
 * El nombre es la parte local del correo (`rosa.perez@…` → `rosa.perez`): no
 * hay tabla de perfiles y es lo que el historial de llamadas ha enseñado
 * siempre, así que Leads, Envíos y la lista de vendedoras lo resuelven igual.
 * Antes cada uno tenía su propia copia y su propia caché; ahora es una sola.
 *
 * La caché es por proceso y no caduca: un correo no cambia. Una consulta que
 * falla NO se cachea, para que el siguiente intento vuelva a preguntar.
 */
const agentNameCache = new Map<string, string>();

export async function resolveAgentName(
  userId: string,
  admin: SupabaseClient = createAdminSupabase(),
): Promise<string | null> {
  const cached = agentNameCache.get(userId);
  if (cached) return cached;
  try {
    const { data } = await admin.auth.admin.getUserById(userId);
    const email = data?.user?.email ?? null;
    const name = email ? email.split("@")[0]! : userId.slice(0, 8);
    agentNameCache.set(userId, name);
    return name;
  } catch {
    return null;
  }
}

/**
 * Varios ids de una vez, en paralelo. Los que no se pudieron resolver no
 * aparecen en el resultado: quien lo consume decide qué mostrar en su lugar.
 */
export async function resolveAgentNames(
  userIds: Iterable<string>,
  admin: SupabaseClient = createAdminSupabase(),
): Promise<Record<string, string>> {
  const ids = [...new Set(userIds)].filter(Boolean);
  const names = await Promise.all(ids.map((id) => resolveAgentName(id, admin)));
  const out: Record<string, string> = {};
  ids.forEach((id, i) => {
    const name = names[i];
    if (name) out[id] = name;
  });
  return out;
}
