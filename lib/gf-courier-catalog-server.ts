import "server-only";

// Lectura del catálogo vivo de una tienda (para GF) y del catálogo de esa tienda en GF. Solo lectura en ambos lados.
import type { SupabaseClient } from "@supabase/supabase-js";
import { getStoreCreds } from "@/lib/ingest";
import { loadShopifySkuDetails, loadSkuCatalogSource } from "@/lib/aliclik-catalog";
import { gfCourier } from "@/lib/gf-courier";
import { buildGfCatalogExport, type GfCatalogExport, type GfCatalogProduct } from "@/lib/gf-courier-catalog";

export async function loadStoreCatalogForGf(admin: SupabaseClient, storeId: string): Promise<GfCatalogExport & { problems: string[] }> {
  const problems: string[] = [];
  const source = await loadSkuCatalogSource(admin, storeId, await getStoreCreds(storeId, admin));
  const details = await loadShopifySkuDetails(storeId, admin, 0, source, { onSourceError: (d) => problems.push(d), fresh: true });
  return { ...buildGfCatalogExport(details.values()), problems };
}

/** Todo el catálogo de la tienda en GF, paginado (tope de 50 páginas de 100). */
export async function loadGfProducts(apiToken: string): Promise<{ ok: true; products: GfCatalogProduct[] } | { ok: false; message: string }> {
  const products: GfCatalogProduct[] = [];
  let after: string | undefined;
  for (let page = 0; page < 50; page++) {
    const r = await gfCourier.products({ apiToken }, after);
    if (!r.ok) return { ok: false, message: r.error.message };
    products.push(...r.data.data);
    if (!r.data.next_cursor) return { ok: true, products };
    after = r.data.next_cursor;
  }
  return { ok: true, products };
}
