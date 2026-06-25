// RLS-scoped reads for the leads module (queue views, lead detail, counts).

import { createServerSupabase } from "@/lib/db";
import type { LeadCallRow, LeadRow } from "@/lib/types";

export type LeadView = "por_llamar" | "yape" | "seguimientos" | "ganados" | "perdidos";

export const LEAD_VIEWS: { key: LeadView; label: string }[] = [
  { key: "por_llamar", label: "Por llamar" },
  { key: "yape", label: "🔥 Yape/Shalom" },
  { key: "seguimientos", label: "Seguimientos" },
  { key: "ganados", label: "Ganados" },
  { key: "perdidos", label: "Perdidos" },
];

export async function getStoreLeads(
  storeId: string,
  view: LeadView,
  limit = 200,
): Promise<LeadRow[]> {
  const sb = await createServerSupabase();
  let q = sb.from("leads").select("*").eq("store_id", storeId);
  switch (view) {
    case "por_llamar":
      q = q
        .in("category", ["open", "hot"])
        .neq("status", "yape_por_verificar") // payment-pending leads live in the Yape/Shalom tab
        .order("needs_attention", { ascending: false })
        .order("last_interaction_at", { ascending: false });
      break;
    case "yape":
      q = q.eq("status", "yape_por_verificar").order("last_interaction_at", { ascending: false });
      break;
    case "seguimientos":
      q = q
        .not("next_followup_at", "is", null)
        .lte("next_followup_at", new Date().toISOString())
        .order("next_followup_at", { ascending: true });
      break;
    case "ganados":
      q = q.eq("category", "won").order("updated_at", { ascending: false });
      break;
    case "perdidos":
      q = q.eq("category", "lost").order("updated_at", { ascending: false });
      break;
  }
  const { data } = await q.limit(limit);
  return (data as LeadRow[]) ?? [];
}

export async function getLeadWithCalls(
  leadId: string,
): Promise<{ lead: LeadRow; calls: LeadCallRow[] } | null> {
  const sb = await createServerSupabase();
  const { data: lead } = await sb.from("leads").select("*").eq("id", leadId).maybeSingle();
  if (!lead) return null;
  const { data: calls } = await sb
    .from("lead_calls")
    .select("*")
    .eq("lead_id", leadId)
    .order("occurred_at", { ascending: false });
  return { lead: lead as LeadRow, calls: (calls as LeadCallRow[]) ?? [] };
}

export interface CustomerHistory {
  orderCount: number; // prior non-cancelled orders for this phone (excl. the lead's own)
  lastOrderName: string | null;
  lastOrderAt: string | null;
  lastProduct: string | null;
}

/**
 * Prior purchase history for a phone — powers the "cliente recurrente" block in
 * the lead drawer (último pedido / cuándo / qué compró). RLS-scoped, so it only
 * sees orders in stores the caller may access. Excludes the lead's own order.
 */
export async function getCustomerHistory(
  storeId: string,
  phone: string | null,
  excludeOrderId?: string | null,
): Promise<CustomerHistory | null> {
  if (!phone) return null;
  const sb = await createServerSupabase();
  const { data } = await sb
    .from("orders")
    .select("id, name, created_at, line_items")
    .eq("store_id", storeId)
    .eq("customer_phone", phone)
    .is("cancelled_at", null)
    .order("created_at", { ascending: false })
    .limit(10);
  let rows =
    (data as { id: string; name: string | null; created_at: string | null; line_items: unknown }[]) ?? [];
  if (excludeOrderId) rows = rows.filter((r) => r.id !== excludeOrderId);
  if (!rows.length) return { orderCount: 0, lastOrderName: null, lastOrderAt: null, lastProduct: null };
  const last = rows[0]!;
  const items = Array.isArray(last.line_items) ? (last.line_items as { title?: string }[]) : [];
  const lastProduct = items.length ? String(items[0]?.title ?? "").trim() || null : null;
  return { orderCount: rows.length, lastOrderName: last.name, lastOrderAt: last.created_at, lastProduct };
}

export async function getLeadCounts(storeId: string): Promise<Record<LeadView, number>> {
  const sb = await createServerSupabase();
  const head = () => sb.from("leads").select("*", { count: "exact", head: true }).eq("store_id", storeId);
  const nowIso = new Date().toISOString();
  const [porLlamar, yape, seguimientos, ganados, perdidos] = await Promise.all([
    head().in("category", ["open", "hot"]).neq("status", "yape_por_verificar"),
    head().eq("status", "yape_por_verificar"),
    head().not("next_followup_at", "is", null).lte("next_followup_at", nowIso),
    head().eq("category", "won"),
    head().eq("category", "lost"),
  ]);
  return {
    por_llamar: porLlamar.count ?? 0,
    yape: yape.count ?? 0,
    seguimientos: seguimientos.count ?? 0,
    ganados: ganados.count ?? 0,
    perdidos: perdidos.count ?? 0,
  };
}
