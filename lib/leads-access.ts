// RLS-scoped reads for the leads module (queue views, lead detail, counts).

import { createServerSupabase } from "@/lib/db";
import { shopifyOrderAdminUrl } from "@/lib/shopify";
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

/** One prior Shopify order, for the drawer's "Pedidos anteriores" list. */
export interface PriorOrder {
  name: string | null; // Shopify order name, e.g. "#AUR1234"
  createdAt: string | null;
  amount: number; // net (total_amount − refunds)
  adminUrl: string | null; // deep-link to the order in Shopify admin (new tab)
}

export interface CustomerHistory {
  orderCount: number; // prior non-cancelled orders for this phone (excl. the lead's own)
  lastOrderName: string | null;
  lastOrderAt: string | null;
  lastProduct: string | null;
  currentOrderName: string | null; // Shopify name (#AUR…) of the lead's OWN current order
  recentOrders: PriorOrder[]; // last 3 prior orders (excl. own), newest first
}

/**
 * Prior purchase history for a phone — powers the "cliente recurrente" pill, the
 * "Pedidos anteriores" list, and the current order's Shopify name in the drawer.
 * RLS-scoped (only stores the caller may access). Excludes the lead's own order
 * from the prior list, but resolves its name separately for the footer.
 */
export async function getCustomerHistory(
  storeId: string,
  phone: string | null,
  excludeOrderId?: string | null,
  shopDomain?: string | null,
): Promise<CustomerHistory | null> {
  if (!phone) return null;
  const sb = await createServerSupabase();

  // The lead's own current order name (#AUR…) — resolved by id so it's reliable
  // regardless of phone formatting.
  let currentOrderName: string | null = null;
  if (excludeOrderId) {
    const { data: cur } = await sb.from("orders").select("name").eq("id", excludeOrderId).maybeSingle();
    currentOrderName = (cur as { name: string | null } | null)?.name ?? null;
  }

  const { data } = await sb
    .from("orders")
    .select("id, shopify_order_id, name, created_at, total_amount, total_refunded, line_items")
    .eq("store_id", storeId)
    .eq("customer_phone", phone)
    .is("cancelled_at", null)
    .order("created_at", { ascending: false })
    .limit(10);
  let rows =
    (data as {
      id: string;
      shopify_order_id: string | null;
      name: string | null;
      created_at: string | null;
      total_amount: number | null;
      total_refunded: number | null;
      line_items: unknown;
    }[]) ?? [];
  if (excludeOrderId) rows = rows.filter((r) => r.id !== excludeOrderId);
  const empty = { orderCount: 0, lastOrderName: null, lastOrderAt: null, lastProduct: null };
  if (!rows.length) return { ...empty, currentOrderName, recentOrders: [] };
  const last = rows[0]!;
  const items = Array.isArray(last.line_items) ? (last.line_items as { title?: string }[]) : [];
  const lastProduct = items.length ? String(items[0]?.title ?? "").trim() || null : null;
  const recentOrders: PriorOrder[] = rows.slice(0, 3).map((r) => ({
    name: r.name,
    createdAt: r.created_at,
    amount: Math.round(((r.total_amount ?? 0) - (r.total_refunded ?? 0)) * 100) / 100,
    adminUrl: shopifyOrderAdminUrl(shopDomain, r.shopify_order_id),
  }));
  return {
    orderCount: rows.length,
    lastOrderName: last.name,
    lastOrderAt: last.created_at,
    lastProduct,
    currentOrderName,
    recentOrders,
  };
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
