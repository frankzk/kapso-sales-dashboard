import "server-only";

// El catálogo de «Agregar producto → De las tiendas» (MOM §45.1): el catálogo
// VIVO de cada tienda de la organización —el publicado de WooCommerce o el
// activo de Shopify, la misma fuente de Envíos → «Catálogo de productos»
// (`loadSkuCatalogSource` + `loadShopifySkuDetails`, lib/aliclik-catalog.ts)—
// más lo conocido por el historial (Costos de productos y los SKU vistos en
// pedidos, `loadSkuCatalog`) para los SKU que ya no están en ningún catálogo.
//
// Antes salía SOLO del historial: un producto que todavía no se vendió (el caso
// del owner: «Bóxer Confort – … (Pack de 4)», tallas 4XL/5XL/6XL, de Aurela en
// WooCommerce) no aparecía, aunque sí en el Catálogo de productos.
//
//   - Cada producto del catálogo vivo trae la tienda de donde salió y el nombre
//     «título – variante»; las variantes sin SKU también («Sin SKU»).
//   - Los pedidos de cada SKU salen de `org_shopify_products` (0 si nunca).
//   - Si el catálogo de una tienda no se puede leer, quedan los vendidos y el
//     selector lo dice («No se pudo leer el catálogo de <tienda>; se muestran
//     los productos vendidos»).
//   - El historial de pedidos de `loadShopifySkuDetails` NO se vuelve a leer
//     aquí (0 días): ya llega por `org_shopify_products`, con sus pedidos, y
//     leer `orders` de un año por tienda en cada «Agregar producto» es lento.
//   - Cada tienda se guarda 5 minutos en memoria (como el catálogo de
//     WooCommerce); una lectura con problemas no se guarda.
//   - Solo SKU, nombres, variantes e ids: ningún precio ni costo.

import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminSupabase } from "@/lib/db";
import { getStoreCreds } from "@/lib/ingest";
import { loadShopifySkuDetails, loadSkuCatalogSource, type ShopifySkuDetails } from "@/lib/aliclik-catalog";
import { loadSkuCatalog } from "@/lib/compras-server";
import { PICKER_LIMIT, buildProductPicker, capProductPicker, type LiveCatalogEntry, type PickerProduct } from "@/lib/compras-ia";

/** Cuánto se guarda en memoria el catálogo de una tienda. */
export const PICKER_CACHE_MS = 5 * 60_000;
/** Días de `orders` que relee `loadShopifySkuDetails`: ninguno (el historial llega por `org_shopify_products`). */
const PICKER_ORDER_DAYS = 0;

export interface PickerStore {
  id: string;
  name: string;
  /** Solo se lee el catálogo de las tiendas activas. */
  status?: string | null;
}

export interface PickerCatalog {
  products: PickerProduct[];
  /** Lo que el selector tiene que decir: tiendas que no se pudieron leer, o el tope. */
  notices: string[];
  /** Cuántos quedaron fuera por el tope (`PICKER_LIMIT`). */
  omitted: number;
}

type StoreCatalog = { entries: LiveCatalogEntry[]; notice: string | null };

const storeCache = new Map<string, { at: number; value: Promise<StoreCatalog> }>();

/** Solo pruebas. */
export function clearPickerCatalogCache(): void {
  storeCache.clear();
}

async function readStoreCatalog(admin: SupabaseClient, store: PickerStore): Promise<StoreCatalog> {
  const problems: string[] = [];
  let details = new Map<string, ShopifySkuDetails>();
  try {
    const creds = await getStoreCreds(store.id, admin);
    const source = await loadSkuCatalogSource(admin, store.id, creds);
    // Shopify sin token: no hay catálogo que leer, solo el historial.
    if (source.platform === "shopify" && !source.shopify) problems.push("Sin el token de Shopify.");
    details = await loadShopifySkuDetails(store.id, admin, PICKER_ORDER_DAYS, source, { onSourceError: (d) => problems.push(d) });
  } catch {
    problems.push("No se pudo leer.");
  }
  const entries: LiveCatalogEntry[] = [...details.values()].map((d) => ({
    storeId: store.id,
    sku: d.shopifySku,
    title: d.title,
    variantTitle: d.variantTitle,
    productId: d.productId,
    variantId: d.variantId,
  }));
  if (!problems.length) return { entries, notice: null };
  return {
    entries,
    notice: entries.length
      ? `El catálogo de ${store.name} se leyó en parte; se completa con los productos vendidos.`
      : `No se pudo leer el catálogo de ${store.name}; se muestran los productos vendidos.`,
  };
}

function storeCatalog(admin: SupabaseClient, store: PickerStore): Promise<StoreCatalog> {
  const hit = storeCache.get(store.id);
  if (hit && Date.now() - hit.at < PICKER_CACHE_MS) return hit.value;
  const value = readStoreCatalog(admin, store);
  const entry = { at: Date.now(), value };
  storeCache.set(store.id, entry);
  // Con problemas no se guarda: la próxima vez se vuelve a intentar.
  void value.then(
    (r) => {
      if (r.notice && storeCache.get(store.id) === entry) storeCache.delete(store.id);
    },
    () => {
      if (storeCache.get(store.id) === entry) storeCache.delete(store.id);
    },
  );
  return value;
}

/**
 * El selector de «Agregar producto» de la organización, con las tiendas que la
 * persona ve en ella. Quien llama ya pidió «Compras» en la organización.
 */
export async function loadPickerCatalog(
  orgId: string,
  stores: readonly PickerStore[],
  admin: SupabaseClient = createAdminSupabase(),
): Promise<PickerCatalog> {
  const active = stores.filter((s) => !s.status || s.status === "active");
  const [history, perStore] = await Promise.all([
    loadSkuCatalog(orgId, admin).catch(() => []),
    Promise.all(active.map((s) => storeCatalog(admin, s))),
  ]);
  const all = buildProductPicker(
    history,
    perStore.flatMap((p) => p.entries),
  );
  const { products, omitted } = capProductPicker(all);
  const notices = perStore.map((p) => p.notice).filter((n): n is string => Boolean(n));
  if (omitted) {
    console.warn(`[compras] selector de productos: ${all.length} productos, se mandan ${PICKER_LIMIT} (org ${orgId})`);
    notices.push(
      `Se cargaron los ${PICKER_LIMIT.toLocaleString("es-PE")} productos más pedidos de ${all.length.toLocaleString("es-PE")}: si no encuentras uno, elige «Producto nuevo» y escribe su SKU.`,
    );
  }
  return { products, notices, omitted };
}
