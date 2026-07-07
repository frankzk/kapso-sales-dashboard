// Batch auto-match for the "Revisión" queue: live-search Shopify (routed to
// the right store) for each unmatched shipment's parsed order reference, and —
// only when exactly one candidate's phone cross-validates the shipment's own
// phone (the 2-variable gate: NOTA reference + same phone) — LINK it directly,
// no human click needed. If the link's Shopify fetch/upsert fails, we fall back
// to persisting a *suggestion* so a human can still confirm it manually.
// Mirrors lib/shipment-match.ts's split: decideSuggestion is pure/testable,
// runSuggestionBatch is the I/O orchestration (like aliclik-ingest.ts).

import type { SupabaseClient } from "@supabase/supabase-js";
import { getStoreCreds, type StoreCreds } from "@/lib/ingest";
import { fetchOrderById, pickStoresForOrderQuery, searchOrdersLive } from "@/lib/shopify";
import type { StoreSummary } from "@/lib/types";

/** Shopify order-search round-trips run ~200–500ms; 25 shipments (each 1–2
 *  calls) comfortably finishes well under any serverless timeout, so a
 *  client-side loop of chunks never risks a request timing out. */
export const SUGGESTION_BATCH_SIZE = 25;

export interface SuggestInput {
  orderName: string | null; // shipments.order_name (NOTA-parsed guess)
  customerPhone: string | null; // shipments.customer_phone
}

export interface SuggestCandidate {
  gid: string;
  storeId: string;
  name: string | null;
  customer_phone: string | null;
}

export interface SuggestDecision {
  suggest: boolean;
  candidate: SuggestCandidate | null;
}

/**
 * Given a shipment's NOTA-guessed reference + phone, and the Shopify search
 * results for that reference, decide whether to suggest a link. Mirrors the
 * interactive PhoneBadge/sortByPhoneMatch logic in order-link-picker.tsx —
 * never trust a bare digits/name coincidence alone; only exactly one
 * phone-cross-validated candidate earns a suggestion.
 */
export function decideSuggestion(
  input: SuggestInput,
  candidates: SuggestCandidate[],
): SuggestDecision {
  if (!input.customerPhone) return { suggest: false, candidate: null };
  const phoneMatches = candidates.filter((c) => c.customer_phone === input.customerPhone);
  if (phoneMatches.length === 1) return { suggest: true, candidate: phoneMatches[0]! };
  return { suggest: false, candidate: null };
}

export interface BatchResult {
  processed: number;
  linked: number; // confidently auto-linked to a Shopify order this round
  done: boolean; // true when fewer than `limit` unchecked rows remained
}

interface CandidateRow {
  id: string;
  order_name: string | null;
  customer_phone: string | null;
}

/**
 * Link a shipment to a confidently-matched Shopify order using the admin
 * client — mirrors linkShipmentToShopifyOrder's fetch→upsert→resolve, but in
 * the batch context (no per-request auth). Returns false on any Shopify/DB
 * failure so the caller can fall back to saving a suggestion instead. Re-homes
 * the shipment to the candidate's store (a `#KP…` guide imported under Aurela's
 * default lands in Kenku), same as a manual link.
 */
async function autoLinkShipment(
  admin: SupabaseClient,
  shipmentId: string,
  candidate: SuggestCandidate,
  credsByStore: Map<string, StoreCreds>,
  now: string,
): Promise<boolean> {
  const creds = credsByStore.get(candidate.storeId);
  if (!creds?.shopify_token) return false;
  let order;
  try {
    order = await fetchOrderById({
      domain: creds.shopify_domain,
      token: creds.shopify_token,
      storeId: candidate.storeId,
      orderGid: candidate.gid,
    });
  } catch {
    return false;
  }
  if (!order) return false;
  const { error: upErr } = await admin
    .from("orders")
    .upsert([order], { onConflict: "store_id,shopify_order_id" });
  if (upErr) return false;
  const { data: row } = await admin
    .from("orders")
    .select("id")
    .eq("store_id", candidate.storeId)
    .eq("shopify_order_id", order.shopify_order_id)
    .maybeSingle();
  const orderId = (row as { id: string } | null)?.id ?? null;
  if (!orderId) return false;
  const { error } = await admin
    .from("shipments")
    .update({
      order_id: orderId,
      store_id: candidate.storeId,
      order_name: order.name,
      matched: true,
      match_method: "auto",
      suggested_order_gid: null,
      suggested_store_id: null,
      suggested_order_name: null,
      suggestion_checked_at: now,
    })
    .eq("id", shipmentId);
  return !error;
}

/**
 * Process one chunk of the "Revisión" queue: search Shopify for each
 * unprocessed shipment's order_name and — when the phone cross-validates a
 * single candidate — LINK it directly (falling back to a saved suggestion only
 * if the link's Shopify fetch/upsert fails). `suggestion_checked_at is null`
 * doubles as the resumability cursor — no separate cursor table needed, since
 * progress is genuinely per-shipment, not a single linear stream.
 */
export async function runSuggestionBatch(
  admin: SupabaseClient,
  storeIds: string[],
  stores: StoreSummary[],
  limit: number = SUGGESTION_BATCH_SIZE,
): Promise<BatchResult> {
  const { data } = await admin
    .from("shipments")
    .select("id,order_name,customer_phone")
    .in("store_id", storeIds)
    .eq("matched", false)
    .is("suggestion_checked_at", null)
    .in("status_category", ["pending", "in_route"])
    .order("created_at")
    .limit(limit);
  const rows = (data as CandidateRow[]) ?? [];
  if (!rows.length) return { processed: 0, linked: 0, done: true };

  const now = new Date().toISOString();
  const noReference = rows.filter((r) => !r.order_name);
  if (noReference.length) {
    await admin
      .from("shipments")
      .update({ suggestion_checked_at: now })
      .in(
        "id",
        noReference.map((r) => r.id),
      );
  }

  // Decrypt each store's Shopify creds once — reused for both the live search
  // and the follow-up order fetch when a match links.
  const credsByStore = new Map<string, StoreCreds>();
  await Promise.all(
    stores.map(async (s) => {
      const c = await getStoreCreds(s.id, admin);
      if (c?.shopify_token) credsByStore.set(s.id, c);
    }),
  );

  const searchable = rows.filter((r) => r.order_name);
  let linked = 0;
  for (const row of searchable) {
    const targets = pickStoresForOrderQuery(row.order_name!, stores);
    const perStore = await Promise.all(
      targets.map(async (store) => {
        const creds = credsByStore.get(store.id);
        if (!creds?.shopify_token) return [] as SuggestCandidate[];
        try {
          const orders = await searchOrdersLive({
            domain: creds.shopify_domain,
            token: creds.shopify_token,
            storeId: store.id,
            query: row.order_name!,
            first: 5,
          });
          return orders.map((o) => ({
            gid: (o.raw as { id?: string } | undefined)?.id ?? `gid://shopify/Order/${o.shopify_order_id}`,
            storeId: store.id,
            name: o.name,
            customer_phone: o.customer_phone ?? null,
          }));
        } catch {
          return [] as SuggestCandidate[]; // missing scope / API error on this store — skip it
        }
      }),
    );
    const decision = decideSuggestion(
      { orderName: row.order_name, customerPhone: row.customer_phone },
      perStore.flat(),
    );
    if (decision.suggest && decision.candidate) {
      const ok = await autoLinkShipment(admin, row.id, decision.candidate, credsByStore, now);
      if (ok) {
        linked++;
        continue;
      }
      // link failed (Shopify fetch/upsert error) → leave a suggestion to confirm by hand
      await admin
        .from("shipments")
        .update({
          suggested_order_gid: decision.candidate.gid,
          suggested_store_id: decision.candidate.storeId,
          suggested_order_name: decision.candidate.name,
          suggestion_checked_at: now,
        })
        .eq("id", row.id);
    } else {
      await admin.from("shipments").update({ suggestion_checked_at: now }).eq("id", row.id);
    }
  }

  return { processed: rows.length, linked, done: rows.length < limit };
}
