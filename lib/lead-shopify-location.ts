// La dirección que Shopify tiene del cliente, para los leads de la cola que no
// dicen dónde viven (0228). La busca la sincronización, por celular, con la
// conexión de la tienda; la lee el filtro de cobertura (lib/lead-coverage.ts).

import type { SupabaseClient } from "@supabase/supabase-js";
import { getCustomerAddressByPhone, type ShopifyClientOpts } from "@/lib/shopify";

/**
 * Cuántos leads se buscan por tienda y corrida. La sincronización corre cada 5
 * minutos: 30 por corrida son ~360 por hora, así que el atraso del día en que
 * se activa (~1.900 en las dos tiendas) se vacía en unas horas y después solo
 * quedan los leads nuevos. Cada búsqueda es una consulta chica de GraphQL.
 */
export const SHOPIFY_LOCATION_RUN_CAP = 30;

export interface ShopifyLocationStats {
  checked: number;
  found: number;
  /** La llamada que cortó la corrida, si alguna falló. */
  error?: string;
}

export interface ShopifyLocationRow {
  lead_id: string;
  province: string | null;
  city: string | null;
}

/**
 * Busca en Shopify a los leads sin ubicación de esta tienda y guarda lo que
 * encuentre. Cada lead se consulta UNA vez: se guarda la fila haya o no
 * dirección.
 *
 * A la primera llamada que falla se corta la corrida sin marcar ese lead: si es
 * un fallo pasajero se reintenta en 5 minutos, y si falta el permiso
 * `read_customers` no se gastan 30 llamadas por corrida en descubrirlo.
 */
export async function enrichLeadLocationsFromShopify(
  admin: SupabaseClient,
  storeId: string,
  shopify: ShopifyClientOpts,
  cap: number = SHOPIFY_LOCATION_RUN_CAP,
  lookup: typeof getCustomerAddressByPhone = getCustomerAddressByPhone,
): Promise<ShopifyLocationStats> {
  const stats: ShopifyLocationStats = { checked: 0, found: 0 };
  const { data, error } = await admin.rpc("lead_shopify_location_candidates", {
    p_store_id: storeId,
    p_limit: cap,
  });
  // Sin la migración 0228 la función no existe: no hay nada que hacer todavía.
  if (error || !data) return stats;

  for (const c of data as { lead_id: string; phone: string }[]) {
    let res: Awaited<ReturnType<typeof getCustomerAddressByPhone>>;
    try {
      res = await lookup(shopify, c.phone);
    } catch (e) {
      stats.error = e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200);
      break;
    }
    const row = {
      lead_id: c.lead_id,
      store_id: storeId,
      province: res.found ? res.province : null,
      city: res.found ? res.city : null,
      checked_at: new Date().toISOString(),
    };
    const { error: upErr } = await admin.from("lead_shopify_locations").upsert(row);
    if (upErr) throw new Error(`lead_shopify_locations: ${upErr.message}`);
    stats.checked += 1;
    if (res.found) stats.found += 1;
  }
  return stats;
}
