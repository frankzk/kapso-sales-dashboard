import type { SupabaseClient } from "@supabase/supabase-js";
import { buildProductMatcher, customerProductSignals, mergeLeadProductCatalog, clarifyAmbiguousProduct, type LeadCatalogProduct, type ProductMessage, type LeadProductSignal } from "./lead-products";
import { loadStoreOrderPlatform, wooSaleClient } from "./woocommerce-orders";
import { wooGetPage } from "./woocommerce";
import { withWooAuthFallback } from "./woocommerce-intake";

const cache = new Map<string, { at: number; promise: Promise<LeadCatalogProduct[]> }>();

/** Read-only projection for the whole visible queue while the persisted backfill
 * catches up. Catalogue reads are scoped to stores of already authorized rows. */
export async function withProductOpeners<T extends { store_id: string; first_inbound_text?: string | null;
  first_seen_at: string | null; entry_product?: LeadProductSignal | null; interest_product?: LeadProductSignal | null;
  last_product_handle?: string | null; cart_product_handle?: string | null }>(admin: SupabaseClient, leads: T[]): Promise<T[]> {
  const matchers = new Map<string, ReturnType<typeof buildProductMatcher>>();
  const identities = new Map<string, Map<string, LeadCatalogProduct>>();
  await Promise.all([...new Set(leads.map((l) => l.store_id))].map(async (id) => {
    try {
      const catalogue = await loadLeadProductCatalog(admin, id);
      matchers.set(id, buildProductMatcher(catalogue));
      const handles = new Map<string, LeadCatalogProduct>();
      for (const p of catalogue) for (const h of [p.handle, ...p.handles ?? []]) handles.set(h.toLowerCase(), p);
      identities.set(id, handles);
    } catch { /* retain stored attribution */ }
  }));
  return leads.map((l) => {
    const known = identities.get(l.store_id);
    if (!known) return l;
    const productOf = (handle: string | null | undefined) => {
      if (!handle) return undefined;
      try { handle = decodeURIComponent(handle).toLowerCase(); } catch { handle = handle.toLowerCase(); }
      const direct = known.get(handle.toLowerCase());
      if (direct) return direct;
      // Legacy URL parser stopped at a trademark symbol; repair only when
      // this exact documented truncation identifies one catalogue product.
      const candidates = new Set([...known].filter(([h]) => h.startsWith(`${handle}™`) || h.startsWith(`${handle}®`)).map(([, p]) => p));
      return candidates.size === 1 ? [...candidates][0] : undefined;
    };
    const canonical = (signal: LeadProductSignal | null | undefined) => {
      const p = productOf(signal?.handle);
      return signal && p ? { ...signal, handle: p.handle, title: p.title } : signal;
    };
    const opener = !l.entry_product?.handle ? matchers.get(l.store_id)?.({
      text: l.first_inbound_text ?? "", at: l.first_seen_at ?? "", direction: "inbound",
    }) : null;
    return { ...l, entry_product: canonical(l.entry_product?.handle ? l.entry_product : opener?.handle ? opener : l.entry_product ?? opener),
      interest_product: canonical(clarifyAmbiguousProduct(l.interest_product, matchers.get(l.store_id)!)),
      last_product_handle: productOf(l.last_product_handle)?.handle ?? l.last_product_handle,
      cart_product_handle: productOf(l.cart_product_handle)?.handle ?? l.cart_product_handle };
  });
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
    const live: LeadCatalogProduct[] = [];
    if (!platform.ok) throw new Error("No se pudo leer la plataforma del catálogo.");
    if (platform.platform === "woocommerce") {
      const client = wooSaleClient(platform.creds, { timeoutMs: 10_000 });
      for (let page = 1; page <= 30; page++) {
        const result = await withWooAuthFallback(client, (opts) => wooGetPage<{ slug: string; name: string }>(opts,
          "/products", { status: "publish", per_page: 100, page, _fields: "slug,name", orderby: "id", order: "asc" }));
        for (const p of result.value.items) if (p.slug && p.name) {
          live.push({ handle: p.slug, title: p.name });
        }
        if (result.value.items.length < 100 || (result.value.totalPages != null && page >= result.value.totalPages)) break;
        if (page === 30) throw new Error("El catálogo de atribución está incompleto.");
      }
    }
    return mergeLeadProductCatalog([...products.values()], live);
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
  const { error } = await admin.rpc("record_lead_products_v2", {
    p_store_id: storeId, p_conversation_id: conversationId, p_lead_id: null,
    p_entry: entry, p_signals: signals,
  });
  if (error) throw new Error("No se pudo guardar la atribución del producto.");
}

/** Rotation clock is an attempt, not proof of product evidence. Empty/unreadable
 * chats must yield their place as well, and are retried on the next rotation. */
export async function markProductConversationAttempt(admin: SupabaseClient, storeId: string, conversationId: string) {
  const { error } = await admin.from("leads")
    .update({ product_conversation_checked_at: new Date().toISOString() })
    .eq("store_id", storeId).eq("kapso_conversation_id", conversationId);
  if (error) throw new Error("No se pudo registrar el intento de revisión de productos.");
}

/** Bounded, resumable pass over stored first customer messages, including old
 * leads. No Kapso mass fetch, no calls/messages, never changes queue eligibility. */
export async function backfillLeadProducts(admin: SupabaseClient, storeId: string, catalogue: readonly LeadCatalogProduct[], limit = 1000,
  source: "lead_product_openers_v2" | "lead_product_full_audit_20261111" = "lead_product_openers_v2") {
  if (!catalogue.length) return { checked: 0, identified: 0 };
  const cursorRead = await admin.from("sync_state").select("cursor").eq("store_id", storeId).eq("source", source).maybeSingle();
  if (cursorRead.error) throw new Error("No se pudo leer el progreso histórico de productos.");
  const cursor: string | null = cursorRead.data?.cursor ?? null;
  let query = admin.from("leads").select("id,first_inbound_text,first_seen_at,interest_product").eq("store_id", storeId).order("id").limit(limit);
  if (cursor === "done") query = query.is("product_attribution_checked_at", null);
  else if (cursor) query = query.gt("id", cursor);
  const { data, error } = await query;
  if (error) throw new Error("No se pudo leer el lote histórico de productos.");
  const match = buildProductMatcher(catalogue);
  const entries = (data ?? []).map((l) => ({ id: l.id, entry: match({
    text: l.first_inbound_text ?? "", at: l.first_seen_at, id: `opener:${l.id}`, direction: "inbound",
  }), signals: l.interest_product?.source === "ambiguous"
    ? [clarifyAmbiguousProduct(l.interest_product, match)].filter((s): s is LeadProductSignal => !!s?.handle) : [] }));
  for (let at = 0; at < entries.length; at += 100) {
    const { error: writeError } = await admin.rpc("record_lead_product_openers_v2", { p_store_id: storeId, p_rows: entries.slice(at, at + 100) });
    if (writeError) throw new Error("No se pudo guardar el lote histórico de productos.");
  }
  if (cursor !== "done") {
    const { error: cursorError } = await admin.from("sync_state").upsert({ store_id: storeId, source,
      cursor: entries.length < limit ? "done" : entries[entries.length - 1]!.id,
      last_run_at: new Date().toISOString(), status: "ok", error: null }, { onConflict: "store_id,source" });
    if (cursorError) throw new Error("No se pudo guardar el progreso histórico de productos.");
  }
  return { checked: entries.length, identified: entries.filter((e) => e.entry?.handle).length };
}
