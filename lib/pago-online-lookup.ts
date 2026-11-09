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
import { isPagoOnlineRequirement, pagoOnlinePhoneKey, type PagoOnlineRequirement, PAGO_ONLINE_DEFAULT_REQUIREMENT } from "@/lib/pago-online";

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
  | { state: "listed"; phone: string; failed: number | null; requirement: PagoOnlineRequirement }
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
    const row = (Array.isArray(data) ? data[0] : data) as { listed?: boolean; failed?: number | null; requirement?: string } | null | undefined;
    if (!row?.listed) return { state: "not_listed" };
    return {
      state: "listed",
      phone,
      failed: typeof row.failed === "number" ? row.failed : null,
      requirement: isPagoOnlineRequirement(row.requirement) ? row.requirement : PAGO_ONLINE_DEFAULT_REQUIREMENT,
    };
  } catch (e) {
    return { state: "unread", error: e instanceof Error ? e.message : String(e) };
  }
}
