// Lead ingestion: build/maintain leads from Kapso conversations, link them to
// Shopify orders, and apply bot handoffs (Yape/hot). Service-role only.

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  conversationToLeadSeed,
  fetchAllConversationsRich,
  parseHandoffPayload,
  type HandoffInfo,
  type KapsoClientOpts,
} from "@/lib/kapso";
import { deriveAutoState, nextLeadState } from "@/lib/leads";

/* eslint-disable @typescript-eslint/no-explicit-any */

interface ExistingLead {
  phone: string;
  status: string;
  handoff_reason: string | null;
  has_order: boolean;
}

async function getCursor(admin: SupabaseClient, storeId: string): Promise<string | null> {
  const { data } = await admin
    .from("sync_state")
    .select("cursor")
    .match({ store_id: storeId, source: "leads" })
    .maybeSingle();
  return data?.cursor ?? null;
}

async function setCursor(admin: SupabaseClient, storeId: string, cursor: string | null, status: string, error?: string) {
  await admin.from("sync_state").upsert(
    { store_id: storeId, source: "leads", cursor, last_run_at: new Date().toISOString(), status, error: error ?? null },
    { onConflict: "store_id,source" },
  );
}

/**
 * Pull Kapso conversations (since the cursor), upsert one lead per phone, link
 * orders by phone, and set the auto state without clobbering an agent's manual
 * status. Returns the number of leads touched.
 */
export async function syncStoreLeads(
  admin: SupabaseClient,
  storeId: string,
  creds: { kapso_api_key: string | null; whatsapp_phone_number_id: string | null },
): Promise<number> {
  if (!creds.kapso_api_key) return 0;
  const k: KapsoClientOpts = { apiKey: creds.kapso_api_key };
  const cursor = await getCursor(admin, storeId);

  let convs;
  try {
    convs = await fetchAllConversationsRich(
      k,
      { phoneNumberId: creds.whatsapp_phone_number_id ?? undefined, lastActiveAfter: cursor ?? undefined },
      cursor,
    );
  } catch (e: any) {
    await setCursor(admin, storeId, cursor, "error", e?.message);
    return 0;
  }

  // Dedup by phone, keeping the most recent conversation.
  const seeds = new Map<string, ReturnType<typeof conversationToLeadSeed>>();
  for (const c of convs) {
    const s = conversationToLeadSeed(c);
    if (!s) continue;
    const prev = seeds.get(s.phone);
    if (!prev || (s.last_interaction_at ?? "") > (prev.last_interaction_at ?? "")) {
      seeds.set(s.phone, s);
    }
  }
  const phones = [...seeds.keys()];
  if (!phones.length) {
    await setCursor(admin, storeId, cursor, "ok");
    return 0;
  }

  // Orders by phone (non-cancelled) → won linkage.
  const orderIdByPhone = new Map<string, string>();
  {
    const { data } = await admin
      .from("orders")
      .select("id, customer_phone")
      .eq("store_id", storeId)
      .in("customer_phone", phones)
      .is("cancelled_at", null);
    for (const o of (data as { id: string; customer_phone: string }[]) ?? []) {
      if (o.customer_phone) orderIdByPhone.set(o.customer_phone, o.id);
    }
  }

  // Existing leads for these phones.
  const existingByPhone = new Map<string, ExistingLead>();
  {
    const { data } = await admin
      .from("leads")
      .select("phone, status, handoff_reason, has_order")
      .eq("store_id", storeId)
      .in("phone", phones);
    for (const l of (data as ExistingLead[]) ?? []) existingByPhone.set(l.phone, l);
  }

  let maxTs = cursor;
  for (const phone of phones) {
    const seed = seeds.get(phone)!;
    const existing = existingByPhone.get(phone) ?? null;
    const hasOrder = orderIdByPhone.has(phone);
    const ns = nextLeadState(existing ? { status: existing.status, handoff_reason: existing.handoff_reason } : null, { hasOrder });

    const row: any = {
      store_id: storeId,
      phone,
      kapso_conversation_id: seed.kapso_conversation_id,
    };
    if (seed.name) row.name = seed.name;
    if (seed.wa_id) row.wa_id = seed.wa_id;
    if (seed.last_interaction_at) row.last_interaction_at = seed.last_interaction_at;
    if (!existing && seed.first_seen_at) row.first_seen_at = seed.first_seen_at;
    if (ns) {
      row.status = ns.status;
      row.category = ns.category;
      row.needs_attention = ns.needsAttention;
    }
    if (hasOrder) {
      row.has_order = true;
      row.order_id = orderIdByPhone.get(phone) ?? null;
    }
    await admin.from("leads").upsert(row, { onConflict: "store_id,phone" });

    if (seed.last_interaction_at && (!maxTs || seed.last_interaction_at > maxTs)) {
      maxTs = seed.last_interaction_at;
    }
  }

  await setCursor(admin, storeId, maxTs, "ok");
  return phones.length;
}

/** Mark the lead for an order's customer as won (sticky), creating it if new. */
export async function linkOrderToLead(
  admin: SupabaseClient,
  params: { storeId: string; phone: string | null; orderId: string | null },
): Promise<void> {
  if (!params.phone) return;
  await admin.from("leads").upsert(
    {
      store_id: params.storeId,
      phone: params.phone,
      has_order: true,
      order_id: params.orderId,
      status: "pedido_generado",
      category: "won",
      needs_attention: false,
      last_interaction_at: new Date().toISOString(),
    },
    { onConflict: "store_id,phone" },
  );
}

/** Apply a Kapso handoff webhook → hot lead with the bot's reason/context. */
export async function applyHandoff(
  admin: SupabaseClient,
  storeId: string,
  body: any,
): Promise<{ ok: boolean; reason?: string }> {
  const info: HandoffInfo = parseHandoffPayload(body);
  if (!info.phone) return { ok: false, reason: "no-phone" };

  const { data: existing } = await admin
    .from("leads")
    .select("status, has_order")
    .eq("store_id", storeId)
    .eq("phone", info.phone)
    .maybeSingle();

  const handoffFields = {
    handoff_reason: info.reason,
    handoff_context: info.context,
    handoff_at: new Date().toISOString(),
  };

  if (existing?.has_order) {
    // Already won — keep state, just record the context.
    await admin.from("leads").update(handoffFields).eq("store_id", storeId).eq("phone", info.phone);
    return { ok: true };
  }

  const auto = deriveAutoState({ handoffReason: info.reason ?? undefined });
  const row: any = {
    store_id: storeId,
    phone: info.phone,
    kapso_conversation_id: info.conversationId,
    ...handoffFields,
    status: auto.status,
    category: auto.category,
    needs_attention: auto.needsAttention,
    last_interaction_at: new Date().toISOString(),
  };
  if (info.name) row.name = info.name;
  await admin.from("leads").upsert(row, { onConflict: "store_id,phone" });

  // Activity log entry (system).
  const { data: lead } = await admin
    .from("leads")
    .select("id")
    .eq("store_id", storeId)
    .eq("phone", info.phone)
    .maybeSingle();
  if (lead?.id) {
    await admin.from("lead_calls").insert({
      lead_id: lead.id,
      store_id: storeId,
      kind: "system",
      new_status: auto.status,
      note: info.context,
    });
  }
  return { ok: true };
}
