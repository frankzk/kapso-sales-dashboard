import type { SupabaseClient } from "@supabase/supabase-js";
import { decryptOrNull } from "./crypto";
import { fetchConversationSignals } from "./kapso";
import { customerProductSignals, type LeadCatalogProduct } from "./lead-products";
import { saveCustomerProducts } from "./lead-products-server";

/** Dedicated frozen-cohort review. No general sync, messages, image fetches,
 * customer exports or operational updates. One existing 100-message page/chat. */
export async function reviewUnknownProductConversations(admin: SupabaseClient, storeId: string,
  catalogue: readonly LeadCatalogProduct[], fetchSignals = fetchConversationSignals) {
  const targets = await admin.from("sync_state").select("cursor").eq("store_id", storeId)
    .eq("source", "lead_product_unknown_chat_targets_20261112").maybeSingle();
  if (targets.error || !targets.data?.cursor) throw new Error("Conversation cohort unavailable");
  const cohort: { ids: string[] } = JSON.parse(targets.data.cursor);
  if (!Array.isArray(cohort.ids) || cohort.ids.length > 20000 || cohort.ids.some(id => !/^[0-9a-f-]{36}$/i.test(id))) throw new Error("Invalid conversation cohort");
  const source = "lead_product_unknown_chat_review_20261112";
  const progress = await admin.from("sync_state").select("cursor").eq("store_id", storeId).eq("source", source).maybeSingle();
  if (progress.error) throw new Error("Conversation progress unavailable");
  const offset = Number(progress.data?.cursor ?? 0);
  if (!Number.isInteger(offset) || offset < 0 || offset > cohort.ids.length) throw new Error("Invalid conversation cursor");
  if (offset === cohort.ids.length) return { checked: 0, identified: 0, unreadable: 0, complete: true };
  const store = await admin.from("stores").select("kapso_api_key_enc").eq("id", storeId).maybeSingle();
  if (store.error) throw new Error("Conversation access unavailable");
  const apiKey = decryptOrNull(store.data?.kapso_api_key_enc);
  if (!apiKey) throw new Error("Conversation access unavailable");
  const ids = cohort.ids.slice(offset, offset + 40);
  const page = await admin.from("leads").select("id,kapso_conversation_id").eq("store_id", storeId).in("id", ids);
  if (page.error || page.data?.length !== ids.length) throw new Error("Conversation cohort read failed");
  let identified = 0, unreadable = 0;
  // Bounded concurrency; failures do not disclose conversation IDs or bodies.
  for (let at = 0; at < page.data.length; at += 4) {
    await Promise.all(page.data.slice(at, at + 4).map(async lead => {
      const signals = lead.kapso_conversation_id && await fetchSignals({ apiKey }, lead.kapso_conversation_id);
      if (!signals) { unreadable++; return; }
      const messages = signals.product_messages ?? [];
      if (!messages.length) return;
      await saveCustomerProducts(admin, storeId, lead.kapso_conversation_id, catalogue, messages);
      if (customerProductSignals(catalogue, messages).some(signal => signal.handle)) identified++;
    }));
  }
  const next = offset + ids.length;
  const saved = await admin.from("sync_state").upsert({ store_id: storeId, source, cursor: String(next),
    status: "ok", last_run_at: new Date().toISOString(), error: null }, { onConflict: "store_id,source" });
  if (saved.error) throw new Error("Conversation progress could not be saved");
  return { checked: ids.length, identified, unreadable, complete: next === cohort.ids.length };
}
