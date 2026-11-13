import type { LeadCatalogProduct } from "./lead-products";

/** Exact references only. The caller supplies ONE store's catalogue. */
export function productReferenceResolver(catalogue: readonly LeadCatalogProduct[]) {
  const handles = new Map<string, Set<string>>(), skus = new Map<string, Set<string>>(), ids = new Map<string, Set<string>>();
  const add = (map: Map<string, Set<string>>, key: string, handle: string) => {
    if (!key) return;
    const owners = map.get(key) ?? new Set<string>(); owners.add(handle); map.set(key, owners);
  };
  for (const p of catalogue) {
    for (const h of [p.handle, ...p.handles ?? []]) add(handles, h.toLowerCase(), p.handle);
    for (const sku of p.skus ?? []) add(skus, sku.trim().toUpperCase(), p.handle);
    for (const id of p.wooProductIds ?? []) add(ids, id, p.handle);
  }
  const one = (set: Set<string> | undefined) => set?.size === 1 ? [...set][0]! : null;
  return {
    sku: (sku: string) => one(skus.get(sku.trim().toUpperCase())),
    cart(items: readonly { product_handle?: string | null; product_id?: string | number | null; sku?: string | null }[], platform?: string | null) {
      if (!items.length) return null;
      const products = new Set<string>();
      for (const item of items) {
        const refs: Set<string>[] = [];
        if (item.product_handle) refs.push(handles.get(item.product_handle.toLowerCase()) ?? new Set());
        if (platform === "woocommerce" && item.product_id) refs.push(ids.get(String(item.product_id)) ?? new Set());
        const sku = item.sku && skus.get(item.sku.trim().toUpperCase());
        if (sku) refs.push(sku);
        // Unknown/custom lines and conflicting or duplicated identities block
        // the WHOLE cart. Never silently discard an unresolved second product.
        if (!refs.length || refs.some(r => r.size !== 1)) return null;
        const resolved = new Set(refs.map(r => one(r)!));
        if (resolved.size !== 1) return null;
        products.add([...resolved][0]!);
      }
      return products.size === 1 ? [...products][0]! : null;
    },
    promoted(productSkus: readonly string[]) {
      if (!productSkus.length) return null;
      const resolved = productSkus.map(sku => one(skus.get(sku.trim().toUpperCase())));
      return resolved.every(Boolean) && new Set(resolved).size === 1 ? resolved[0]! : null;
    },
  };
}
