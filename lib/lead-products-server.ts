import type { SupabaseClient } from "@supabase/supabase-js";
import { buildProductMatcher, customerProductSignals, type LeadCatalogProduct, type ProductMessage } from "./lead-products";
import { loadStoreOrderPlatform, wooSaleClient } from "./woocommerce-orders";
import { wooGetPage } from "./woocommerce";
import { withWooAuthFallback } from "./woocommerce-intake";

const cache = new Map<string, { at: number; promise: Promise<LeadCatalogProduct[]> }>();

/** Read-only projection for the whole visible queue while the persisted backfill
 * catches up. Catalogue reads are scoped to stores of already authorized rows. */
export async function withProductOpeners<T extends { store_id: string; first_inbound_text?: string | null;
  first_seen_at: string | null; entry_product?: import("./lead-products").LeadProductSignal | null }>(admin: SupabaseClient, leads: T[]): Promise<T[]> {
  const matchers = new Map<string, ReturnType<typeof buildProductMatcher>>();
  await Promise.all([...new Set(leads.map((l) => l.store_id))].map(async (id) => {
    try { matchers.set(id, buildProductMatcher(await loadLeadProductCatalog(admin, id))); } catch { /* retain stored attribution */ }
  }));
  return leads.map((l) => l.entry_product ? l : { ...l, entry_product: matchers.get(l.store_id)?.({
    text: l.first_inbound_text ?? "", at: l.first_seen_at ?? "", direction: "inbound",
  }) ?? null });
}
/** Store-scoped catalogue; no order history, bot suggestions or ad headlines. */
export async function loadLeadProductCatalog(admin: SupabaseClient, storeId: string): Promise<LeadCatalogProduct[]> {
  const hit = cache.get(storeId);
  if (hit && Date.now() - hit.at < 300_000) return hit.promise;
  const promise = (async () => {
    const products = new Map<string, LeadCatalogProduct>();
    for (let page = 0; page < 30; page++) {
      const { data, error } = await admin.from("shopify_history_products").select("handle,title")
        .eq("store_id", storeId).eq("status", "active").order("handle").range(page * 1000, page * 1000 + 999);
      if (error) throw new Error("No se pudo leer el catálogo de atribución.");
      for (const p of data ?? []) if (p.handle && p.title) products.set(p.handle, p);
      if ((data ?? []).length < 1000) break;
      if (page === 29) throw new Error("El archivo de productos está incompleto.");
    }
    const platform = await loadStoreOrderPlatform(admin, storeId);
    if (!platform.ok) throw new Error("No se pudo leer la plataforma del catálogo.");
    if (platform.platform === "woocommerce") {
      const client = wooSaleClient(platform.creds, { timeoutMs: 10_000 });
      for (let page = 1; page <= 30; page++) {
        const result = await withWooAuthFallback(client, (opts) => wooGetPage<{ slug: string; name: string }>(opts,
          "/products", { status: "publish", per_page: 100, page, _fields: "slug,name", orderby: "id", order: "asc" }));
        for (const p of result.value.items) if (p.slug && p.name) {
          const previous = products.get(p.slug);
          products.set(p.slug, { handle: p.slug, title: p.name, aliases: previous ? [previous.title] : [] });
        }
        if (result.value.items.length < 100 || (result.value.totalPages != null && page >= result.value.totalPages)) break;
        if (page === 30) throw new Error("El catálogo de atribución está incompleto.");
      }
    }
    return [...products.values()];
  })();
  cache.set(storeId, { at: Date.now(), promise });
  promise.catch(() => { if (cache.get(storeId)?.promise === promise) cache.delete(storeId); });
  return promise;
}

export async function saveCustomerProducts(admin: SupabaseClient, storeId: string, conversationId: string,
  catalogue: readonly LeadCatalogProduct[], messages: readonly ProductMessage[]) {
  const signals = customerProductSignals(catalogue, messages);
  const { data: lead } = await admin.from("leads").select("first_inbound_text,first_seen_at")
    .eq("store_id", storeId).eq("kapso_conversation_id", conversationId).maybeSingle();
  const entry = lead ? buildProductMatcher(catalogue)({ text: lead.first_inbound_text ?? "",
    at: lead.first_seen_at, direction: "inbound" }) : null;
  const { error } = await admin.rpc("record_lead_products", {
    p_store_id: storeId, p_conversation_id: conversationId, p_lead_id: null,
    p_entry: entry, p_signals: signals,
  });
  if (error) throw new Error("No se pudo guardar la atribución del producto.");
}

/** Bounded, resumable pass over stored first customer messages, including old
 * leads. No Kapso mass fetch, no calls/messages, never changes queue eligibility. */
export async function backfillLeadProducts(admin: SupabaseClient, storeId: string, catalogue: readonly LeadCatalogProduct[], limit = 500) {
  if (!catalogue.length) return { checked: 0, identified: 0 };
  const { data, error } = await admin.from("leads").select("id,first_inbound_text,first_seen_at")
    .eq("store_id", storeId).is("product_attribution_checked_at", null).order("id").limit(limit);
  if (error) throw new Error("No se pudo leer el lote histórico de productos.");
  const match = buildProductMatcher(catalogue);
  let identified = 0;
  for (const l of data ?? []) {
    const signal = match({ text: l.first_inbound_text ?? "", at: l.first_seen_at, id: `opener:${l.id}`, direction: "inbound" });
    const { error: writeError } = await admin.rpc("record_lead_products", { p_store_id: storeId,
      p_lead_id: l.id, p_conversation_id: null, p_entry: signal, p_signals: [] });
    if (writeError) throw new Error("No se pudo guardar el lote histórico de productos.");
    if (signal?.handle) identified++;
  }
  return { checked: (data ?? []).length, identified };
}
