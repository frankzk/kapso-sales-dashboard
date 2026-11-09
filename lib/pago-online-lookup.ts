// El freno de «Pago solo online (lista automática)» para UN celular (MOM
// §41.11): ¿está en la lista vigente de la organización? Una sola llamada a
// `pago_online_lookup` (0326), que ya mira la posición (solo Activo), la
// corrida vigente y las excepciones de Kapta.
//
// Aparte de lib/pago-online-server.ts a propósito: lo importa la compuerta de
// la lista de pago adelantado (`prepayOrderCheck`, lib/prepay-list-server.ts),
// que corre también en las pruebas, y aquí no hay nada que descifre claves ni
// hable con las tiendas.
//
// Sin la 0326 la lista está vacía: nada se frena (como la 0309 en §41.5).

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  isPagoOnlineReason,
  isPagoOnlineRequirement,
  pagoOnlineListedKey,
  pagoOnlinePhoneKey,
  type PagoOnlineRequirement,
  type PagoOnlineWho,
  PAGO_ONLINE_DEFAULT_REQUIREMENT,
} from "@/lib/pago-online";

type DbError = { code?: string; message?: string } | null | undefined;

/** La tabla o la función todavía no existen (0326 sin aplicar). */
export function isMissingPagoOnline(error: DbError): boolean {
  if (!error) return false;
  return (
    error.code === "42P01" ||
    error.code === "42883" ||
    error.code === "PGRST202" ||
    error.code === "PGRST205" ||
    /does not exist|could not find the (table|function)/i.test(error.message ?? "")
  );
}

export type PagoOnlineLookup =
  | { state: "listed"; phone: string; failed: number | null; who: PagoOnlineWho; requirement: PagoOnlineRequirement }
  | { state: "not_listed" }
  | { state: "unread"; error: string };

/** ¿El celular está en la lista automática vigente de la organización? Nunca lanza. */
export async function pagoOnlineLookup(admin: SupabaseClient, orgId: string, rawPhone: string | null | undefined): Promise<PagoOnlineLookup> {
  const phone = pagoOnlinePhoneKey(rawPhone);
  if (!phone || !orgId) return { state: "not_listed" };
  try {
    const { data, error } = await admin.rpc("pago_online_lookup", { p_org: orgId, p_phone: phone });
    if (error) {
      if (isMissingPagoOnline(error)) return { state: "not_listed" };
      return { state: "unread", error: error.message ?? "error de la base" };
    }
    const row = (Array.isArray(data) ? data[0] : data) as
      | { listed?: boolean; failed?: number | null; reason?: string | null; orders?: number | null; requirement?: string }
      | null
      | undefined;
    if (!row?.listed) return { state: "not_listed" };
    const failed = typeof row.failed === "number" ? row.failed : null;
    return {
      state: "listed",
      phone,
      failed,
      who: {
        reason: isPagoOnlineReason(row.reason) ? row.reason : "devuelto",
        failed,
        orders: typeof row.orders === "number" ? row.orders : null,
      },
      requirement: isPagoOnlineRequirement(row.requirement) ? row.requirement : PAGO_ONLINE_DEFAULT_REQUIREMENT,
    };
  } catch (e) {
    return { state: "unread", error: e instanceof Error ? e.message : String(e) };
  }
}

/** El primero de estos celulares que esté en la lista vigente (el del pedido y el del lead). Nunca lanza. */
export async function pagoOnlineLookupAny(admin: SupabaseClient, orgId: string, rawPhones: readonly (string | null | undefined)[]): Promise<PagoOnlineLookup> {
  let unread: PagoOnlineLookup | null = null;
  const seen = new Set<string>();
  for (const raw of rawPhones) {
    const phone = pagoOnlinePhoneKey(raw);
    if (!phone || seen.has(phone)) continue;
    seen.add(phone);
    const res = await pagoOnlineLookup(admin, orgId, phone);
    if (res.state === "listed") return res;
    if (res.state === "unread") unread = res;
  }
  return unread ?? { state: "not_listed" };
}

/**
 * Los celulares de la lista vigente entre los de una página del Master, como
 * llaves `pagoOnlineListedKey(org, celular)`: solo de organizaciones en
 * Activo, de su corrida vigente y sin las excepciones de Kapta. Lee con el
 * cliente de servicio (`pago_online_phones` no se lee desde el navegador) y
 * devuelve solo SÍ/NO de los celulares que la página ya muestra. Lanza si la
 * base falla; sin la 0326, vacío.
 */
export async function pagoOnlineListedAmong(
  admin: SupabaseClient,
  orgIds: readonly string[],
  rawPhones: readonly (string | null | undefined)[],
): Promise<Set<string>> {
  const out = new Set<string>();
  const phones = [...new Set(rawPhones.map(pagoOnlinePhoneKey).filter((p): p is string => !!p))];
  const orgs = [...new Set(orgIds.filter(Boolean))];
  if (!phones.length || !orgs.length) return out;
  const { data: settings, error } = await admin.from("pago_online_settings").select("org_id,current_run_id").in("org_id", orgs).eq("mode", "activo");
  if (error) {
    if (isMissingPagoOnline(error)) return out;
    throw new Error(error.message);
  }
  const runs = ((settings ?? []) as { org_id: string; current_run_id: string | null }[]).filter((r) => r.current_run_id);
  if (!runs.length) return out;
  const runOrg = new Map(runs.map((r) => [r.current_run_id!, r.org_id]));
  for (let i = 0; i < phones.length; i += 200) {
    const chunk = phones.slice(i, i + 200);
    const [hits, exc] = await Promise.all([
      admin.from("pago_online_phones").select("run_id,phone").in("run_id", [...runOrg.keys()]).in("phone", chunk),
      admin
        .from("pago_online_exceptions")
        .select("org_id,phone")
        .in("org_id", [...new Set(runs.map((r) => r.org_id))])
        .in("phone", chunk)
        .is("removed_at", null),
    ]);
    if (hits.error) throw new Error(hits.error.message);
    if (exc.error) throw new Error(exc.error.message);
    const excepted = new Set(((exc.data ?? []) as { org_id: string; phone: string }[]).map((e) => pagoOnlineListedKey(e.org_id, e.phone)));
    for (const h of (hits.data ?? []) as { run_id: string; phone: string }[]) {
      const org = runOrg.get(h.run_id);
      if (!org) continue;
      const key = pagoOnlineListedKey(org, h.phone);
      if (!excepted.has(key)) out.add(key);
    }
  }
  return out;
}
