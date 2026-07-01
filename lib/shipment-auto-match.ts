// Batch auto-match suggestions for the "Revisión" queue: live-search Shopify
// (routed to the right store) for each unmatched shipment's parsed order
// reference, and — only when a candidate's phone cross-validates the
// shipment's own phone — persist a *suggestion* for a human to confirm.
// Mirrors lib/shipment-match.ts's split: decideSuggestion is pure/testable,
// runSuggestionBatch is the I/O orchestration (like aliclik-ingest.ts).

import type { SupabaseClient } from "@supabase/supabase-js";
import { getStoreCreds } from "@/lib/ingest";
import { pickStoresForOrderQuery, searchOrdersLive } from "@/lib/shopify";
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
  suggested: number;
  done: boolean; // true when fewer than `limit` unchecked rows remained
}

interface CandidateRow {
  id: string;
  order_name: string | null;
  customer_phone: string | null;
}

/**
 * Process one chunk of the "Revisión" queue: search Shopify for each
 * unprocessed shipment's order_name and mark it checked (with a suggestion
 * if the phone cross-validates). `suggestion_checked_at is null` doubles as
 * the resumability cursor — no separate cursor table needed, since progress
 * is genuinely per-shipment, not a single linear stream.
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
  if (!rows.length) return { processed: 0, suggested: 0, done: true };

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

  const searchable = rows.filter((r) => r.order_name);
  let suggested = 0;
  for (const row of searchable) {
    const targets = pickStoresForOrderQuery(row.order_name!, stores);
    const perStore = await Promise.all(
      targets.map(async (store) => {
        const creds = await getStoreCreds(store.id, admin);
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
      suggested++;
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

  return { processed: rows.length, suggested, done: rows.length < limit };
}
