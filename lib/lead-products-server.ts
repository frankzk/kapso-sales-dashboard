import type { SupabaseClient } from "@supabase/supabase-js";
import { buildProductMatcher, customerProductSignals, mergeLeadProductCatalog, clarifyAmbiguousProduct, type LeadCatalogProduct, type ProductMessage, type LeadProductSignal } from "./lead-products";
import { loadStoreOrderPlatform, wooSaleClient } from "./woocommerce-orders";
import { wooGetPage } from "./woocommerce";
import { withWooAuthFallback } from "./woocommerce-intake";
import { SEVEN_PRODUCT_REPAIR_QUERIES } from "./lead-products";
import { productReferenceResolver } from "./lead-product-references";

const cache = new Map<string, { at: number; promise: Promise<LeadCatalogProduct[]> }>();

const MANUAL_AD_IMPORT = "Importación de producto asignado manualmente en Consolidado; SKU exacto; vigente desde su guardado.";

/** Reuse an existing HUMAN decision, never a title or purchase suggestion.
 * Legacy mappings have no actor ID: do not fabricate a signature. */
export async function syncManualAdProductReferences(admin: SupabaseClient, storeId: string,
  catalogue: readonly LeadCatalogProduct[], adIds: readonly string[]) {
  const resolve = productReferenceResolver(catalogue);
  let imported = 0;
  const ids = [...new Set(adIds.filter(Boolean))];
  for (let offset = 0; offset < ids.length; offset += 200) {
    const batch = ids.slice(offset, offset + 200);
    const [meta, existing] = await Promise.all([
      admin.from("meta_ads").select("ad_id,promoted_skus,promoted_product_name,promoted_product_updated_at").in("ad_id", batch),
      admin.from("ad_product_declarations").select("ad_id,valid_from,note").eq("store_id", storeId).in("ad_id", batch),
    ]);
    if (meta.error || existing.error) throw new Error("Manual product references unavailable");
    const rows = (meta.data ?? []).flatMap(ad => {
      const at = ad.promoted_product_updated_at;
      const handle = ad.promoted_product_name && resolve.promoted(ad.promoted_skus ?? []);
      if (!handle || !Number.isFinite(Date.parse(at ?? ""))) return [];
      const declarations = (existing.data ?? []).filter(d => d.ad_id === ad.ad_id);
      // An explicit Leads declaration wins. Imported facts retain old periods.
      if (declarations.some(d => d.note !== MANUAL_AD_IMPORT || Date.parse(d.valid_from) >= Date.parse(at))) return [];
      return [{ store_id: storeId, ad_id: ad.ad_id, product_handle: handle, valid_from: at,
        note: MANUAL_AD_IMPORT, declared_by: null, declared_at: at }];
    });
    if (!rows.length) continue;
    const saved = await admin.from("ad_product_declarations").upsert(rows, { onConflict: "store_id,ad_id,valid_from", ignoreDuplicates: true });
    if (saved.error) throw new Error("Manual product references could not be saved");
    imported += rows.length;
  }
  return imported;
}

/** Resumable exact-reference repair. Reads private cart lines on the server;
 * returns only counts. Does not touch customer evidence or operational fields. */
export async function repairLeadProductReferences(admin: SupabaseClient, storeId: string, catalogue: readonly LeadCatalogProduct[]) {
  const source = "lead_product_exact_references_20261112";
  const progress = await admin.from("sync_state").select("cursor").eq("store_id", storeId).eq("source", source).maybeSingle();
  if (progress.error) throw new Error("Reference progress unavailable");
  if (progress.data?.cursor === "done") return { checked: 0, carts: 0, ads: 0, complete: true };
  let query = admin.from("leads").select("id,ad_id,draft_order_gid,cart_product_handle,call_queue_ready,next_followup_at,call_attempt_count,category,contact_opt_out_at,has_order,order_id,status").eq("store_id", storeId).order("id").limit(1000);
  if (progress.data?.cursor) query = query.gt("id", progress.data.cursor);
  const page = await query;
  if (page.error) throw new Error("Reference cohort unavailable");
  const rows = page.data ?? [];
  const ads = await syncManualAdProductReferences(admin, storeId, catalogue, rows.map(l => l.ad_id).filter((id): id is string => !!id));
  const resolve = productReferenceResolver(catalogue);
  let carts = 0;
  const candidates = rows.filter(l => !l.cart_product_handle && l.draft_order_gid && (!l.call_queue_ready || (
    !(Date.parse(l.next_followup_at ?? "") > Date.now()) && !(l.call_attempt_count >= 3)
    && ["open", "hot"].includes(l.category) && !l.contact_opt_out_at && !l.has_order && !l.order_id
    && ["nuevo", "no_responde", "buzon", "cuelga", "casi_cierra", "volver_a_llamar", "contactado_dejo_wsp", "otros_productos"].includes(l.status)
  )));
  for (let offset = 0; offset < candidates.length; offset += 100) {
    const batch = candidates.slice(offset, offset + 100);
    const drafts = await admin.from("draft_orders").select("draft_order_gid,line_items,platform")
      .eq("store_id", storeId).in("draft_order_gid", batch.map(l => l.draft_order_gid));
    if (drafts.error) throw new Error("Cart references unavailable");
    for (const lead of batch) {
      const draft = drafts.data?.find(d => d.draft_order_gid === lead.draft_order_gid);
      const handle = draft && resolve.cart(draft.line_items ?? [], draft.platform);
      if (!handle) continue;
      const saved = await admin.from("leads").update({ cart_product_handle: handle }).eq("store_id", storeId)
        .eq("id", lead.id).eq("draft_order_gid", lead.draft_order_gid).is("cart_product_handle", null).select("id");
      if (saved.error) throw new Error("Cart reference could not be saved");
      carts += saved.data?.length ?? 0;
    }
  }
  const complete = rows.length < 1000;
  const saved = await admin.from("sync_state").upsert({ store_id: storeId, source, cursor: complete ? "done" : rows[rows.length - 1]!.id,
    status: "ok", last_run_at: new Date().toISOString(), error: null }, { onConflict: "store_id,source" });
  if (saved.error) throw new Error("Reference progress could not be saved");
  return { checked: rows.length, carts, ads, complete };
}

/** Explicit review cohort stored by the operator in sync_state. Texts stay on
 * the server. Only the seven uniquely catalogue-backed products may be written. */
export async function repairSevenProductNames(admin: SupabaseClient, storeId: string, catalogue: readonly LeadCatalogProduct[]) {
  const cohort = await admin.from("sync_state").select("cursor").eq("store_id", storeId)
    .eq("source", "lead_product_seven_alias_targets_20261111").maybeSingle();
  if (cohort.error || !cohort.data?.cursor) throw new Error("Repair cohort unavailable");
  const frozen: { ids: string[] } = JSON.parse(cohort.data.cursor);
  if (!Array.isArray(frozen.ids) || frozen.ids.length > 2000 || frozen.ids.some(id => !/^[0-9a-f-]{36}$/i.test(id))) throw new Error("Invalid repair cohort");
  const match = buildProductMatcher(catalogue);
  const allowed = new Set(SEVEN_PRODUCT_REPAIR_QUERIES.map(text => match({ text, direction: "inbound", at: "2026-11-11T00:00:00Z" })?.handle).filter(Boolean));
  let repaired = 0, alreadyIdentified = 0, unresolved = 0;
  const byProduct: Record<string, number> = {};
  for (let offset = 0; offset < frozen.ids.length; offset += 100) {
    const ids = frozen.ids.slice(offset, offset + 100);
    const { data, error } = await admin.from("leads").select("id,first_inbound_text,first_seen_at,entry_product")
      .eq("store_id", storeId).in("id", ids);
    if (error || data?.length !== ids.length) throw new Error("Repair cohort read failed");
    const entries: { id: string; entry: LeadProductSignal; signals: never[] }[] = [];
    for (const lead of data) {
      if (lead.entry_product?.handle) { alreadyIdentified++; continue; }
      const entry = match({ text: lead.first_inbound_text ?? "", at: lead.first_seen_at, id: `opener:${lead.id}`, direction: "inbound" });
      if (!entry?.handle || !allowed.has(entry.handle)) { unresolved++; continue; }
      entries.push({ id: lead.id, entry, signals: [] });
    }
    if (!entries.length) continue;
    const saved = await admin.rpc("record_lead_product_openers_v2", { p_store_id: storeId, p_rows: entries });
    if (saved.error) throw new Error("Repair batch failed");
    repaired += entries.length;
    for (const entry of entries) byProduct[entry.entry.handle!] = (byProduct[entry.entry.handle!] ?? 0) + 1;
  }
  return { targeted: frozen.ids.length, repaired, already_identified: alreadyIdentified, unresolved, by_product: byProduct, complete: unresolved === 0 };
}

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
      const { data, error } = await admin.from("shopify_history_products").select("handle,title,variants")
        .eq("store_id", storeId).eq("status", "active").order("handle").range(page * 1000, page * 1000 + 999);
      if (error) throw new Error("No se pudo leer el catálogo de atribución.");
      for (const p of data ?? []) if (p.handle && p.title) products.set(p.handle, {
        handle: p.handle, title: p.title,
        skus: Array.isArray(p.variants) ? p.variants.map((v: { sku?: string }) => v.sku?.trim().toUpperCase() ?? "").filter(Boolean) : [],
      });
      if ((data ?? []).length < 1000) break;
      if (page === 29) throw new Error("El archivo de productos está incompleto.");
    }
    const platform = await loadStoreOrderPlatform(admin, storeId);
    const live: LeadCatalogProduct[] = [];
    if (!platform.ok) throw new Error("No se pudo leer la plataforma del catálogo.");
    if (platform.platform === "woocommerce") {
      const client = wooSaleClient(platform.creds, { timeoutMs: 10_000 });
      for (let page = 1; page <= 30; page++) {
        const result = await withWooAuthFallback(client, (opts) => wooGetPage<{ id: number; slug: string; name: string; sku: string }>(opts,
          "/products", { status: "publish", per_page: 100, page, _fields: "id,slug,name,sku", orderby: "id", order: "asc" }));
        for (const p of result.value.items) if (p.slug && p.name) {
          live.push({ handle: p.slug, title: p.name, wooProductIds: [String(p.id)], skus: p.sku ? [p.sku.trim().toUpperCase()] : [] });
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
  let query = admin.from("leads").select("id,ad_id,first_inbound_text,first_seen_at,interest_product").eq("store_id", storeId).order("id").limit(limit);
  if (cursor === "done") query = query.is("product_attribution_checked_at", null);
  else if (cursor) query = query.gt("id", cursor);
  const { data, error } = await query;
  if (error) throw new Error("No se pudo leer el lote histórico de productos.");
  const adIds = (data ?? []).map(l => l.ad_id).filter((id): id is string => !!id);
  if (adIds.length) await syncManualAdProductReferences(admin, storeId, catalogue, adIds);
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
