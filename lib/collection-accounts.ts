// Las cuentas a las que cada tienda puede cobrar (migración 0126).
//
// La lista existe porque hasta ahora había UNA cuenta escrita a mano dentro de
// la regla, y el negocio cobra por varias. Ver lib/yape-recipient.ts.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { CollectionAccount } from "@/lib/yape-recipient";

interface Row {
  store_id: string;
  label: string;
  aliases: string[] | null;
  phone_last_digits: string;
}

/**
 * Las cuentas activas de las tiendas pedidas, agrupadas por tienda.
 *
 * Ante un fallo de lectura devuelve el mapa VACÍO, y eso es deliberado: sin
 * cuentas la verificación cae en «no se puede contrastar» (`partial`), nunca en
 * «el dinero se desvió». Una caída de la consulta no puede acusar a nadie.
 */
export async function loadCollectionAccounts(
  admin: SupabaseClient,
  storeIds: string[],
): Promise<Map<string, CollectionAccount[]>> {
  const byStore = new Map<string, CollectionAccount[]>();
  if (!storeIds.length) return byStore;

  const { data, error } = await admin
    .from("store_collection_accounts")
    .select("store_id,label,aliases,phone_last_digits")
    .in("store_id", storeIds)
    .eq("active", true);
  if (error) {
    console.error(`cuentas de cobro: no se pudieron leer — ${error.message}`);
    return byStore;
  }

  for (const row of (data ?? []) as Row[]) {
    const list = byStore.get(row.store_id) ?? [];
    list.push({
      name: row.label,
      aliases: row.aliases ?? undefined,
      phoneLastDigits: row.phone_last_digits,
    });
    byStore.set(row.store_id, list);
  }
  return byStore;
}

/** Atajo para una sola tienda. */
export async function loadStoreCollectionAccounts(
  admin: SupabaseClient,
  storeId: string,
): Promise<CollectionAccount[]> {
  return (await loadCollectionAccounts(admin, [storeId])).get(storeId) ?? [];
}
