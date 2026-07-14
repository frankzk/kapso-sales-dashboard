// Daily store sales summary for the Telegram cron: total orders + net revenue
// and per-advisor performance (cerrados + ingresos) for a UTC time window.
// Fetches with the service-role admin client (the cron has no user session) and
// reuses the pure productivity aggregation. The formatter renders Telegram HTML.

import type { SupabaseClient } from "@supabase/supabase-js";
import { chunk } from "@/lib/access";
import { formatCurrency, salesAttribution, tzParts, type AttributionInputs, type AttributionSource } from "@/lib/metrics";
import type { OrderRow } from "@/lib/types";
import {
  computeAdvisorStats,
  resolveEmails,
  type AdvisorCall,
  type AdvisorStat,
} from "@/lib/productivity";

export interface DailySourceRow {
  key: AttributionSource;
  label: string;
  orders: number;
  revenue: number;
}

export interface StoreDailySummary {
  totalOrders: number;
  totalRevenue: number; // net (total_amount − refunds) of active orders in the window
  advisors: AdvisorStat[]; // sorted by ingresos desc (computeAdvisorStats order)
  bySource: DailySourceRow[]; // net revenue by acquisition source (order-centric)
}

/** Build the per-phone attribution signals for a window with the ADMIN client
 *  (the cron has no user session). Mirrors access.getAttributionInputs; resilient
 *  to a missing `source` column / `winback_sends` table. */
async function attributionInputsAdmin(
  admin: SupabaseClient,
  storeId: string,
  orders: OrderRow[],
): Promise<AttributionInputs> {
  const sourceByPhone = new Map<string, AttributionSource>();
  const advisorTouchesByPhone = new Map<string, string[]>();
  const winbackByPhone = new Map<string, string[]>();
  const phones = [...new Set(orders.map((o) => o.customer_phone).filter((p): p is string => !!p))];
  if (!phones.length) return { sourceByPhone, advisorTouchesByPhone, winbackByPhone };

  const norm = (s: string | null | undefined): AttributionSource =>
    s === "meta_ad" || s === "fb_web" || s === "cod_cart" || s === "abandoned_browse" ? s : "organic";
  // Chunk every .in(...) by 300 (shared helper, parity with
  // access.getAttributionInputs) so a high-volume store's day doesn't blow the
  // PostgREST/proxy URL length limit.
  const leadIdToPhone = new Map<string, string>();
  for (const part of chunk(phones, 300)) {
    let leadsRes = await admin.from("leads").select("id,phone,source").eq("store_id", storeId).in("phone", part);
    if (leadsRes.error) {
      leadsRes = (await admin.from("leads").select("id,phone").eq("store_id", storeId).in("phone", part)) as typeof leadsRes;
    }
    for (const r of (leadsRes.data as { id: string; phone: string; source?: string | null }[]) ?? []) {
      leadIdToPhone.set(r.id, r.phone);
      sourceByPhone.set(r.phone, norm(r.source));
    }
  }
  const leadIds = [...leadIdToPhone.keys()];
  for (const part of chunk(leadIds, 300)) {
    const { data } = await admin
      .from("lead_calls")
      .select("lead_id,occurred_at")
      .eq("store_id", storeId)
      .in("lead_id", part)
      .not("vendedora", "is", null);
    for (const r of (data as { lead_id: string; occurred_at: string | null }[]) ?? []) {
      const phone = leadIdToPhone.get(r.lead_id);
      if (phone && r.occurred_at) (advisorTouchesByPhone.get(phone) ?? advisorTouchesByPhone.set(phone, []).get(phone)!).push(r.occurred_at);
    }
  }
  for (const arr of advisorTouchesByPhone.values()) arr.sort();
  for (const part of chunk(phones, 300)) {
    const { data: wb, error: wbErr } = await admin
      .from("winback_sends")
      .select("phone,sent_at")
      .eq("store_id", storeId)
      .in("phone", part)
      .eq("ok", true);
    if (wbErr) break; // table absent pre-0030 → leave winback map empty
    for (const r of (wb as { phone: string; sent_at: string | null }[]) ?? []) {
      if (r.sent_at) (winbackByPhone.get(r.phone) ?? winbackByPhone.set(r.phone, []).get(r.phone)!).push(r.sent_at);
    }
  }
  for (const arr of winbackByPhone.values()) arr.sort();
  return { sourceByPhone, advisorTouchesByPhone, winbackByPhone };
}

/** Yesterday's Lima-day UTC bounds (UTC-5, no DST): a Lima day [D 00:00, D+1
 *  00:00) is [D 05:00Z, D+1 05:00Z). `dateOverride` (YYYY-MM-DD) forces a day.
 *  Returns the date, the window, and a human label ("jue 26 jun"). */
export function limaDayBounds(dateOverride: string | null = null): {
  date: string;
  startIso: string;
  endIso: string;
  label: string;
} {
  const date =
    dateOverride ?? tzParts(new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(), "America/Lima").date;
  const startIso = `${date}T05:00:00.000Z`;
  const endIso = new Date(new Date(startIso).getTime() + 24 * 60 * 60 * 1000).toISOString();
  const label = new Date(`${date}T12:00:00Z`).toLocaleDateString("es-PE", {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: "America/Lima",
  });
  return { date, startIso, endIso, label };
}

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Build a store's daily summary for [startIso, endIso): total active orders +
 * net revenue (by created_at), and per-advisor cerrados/ingresos (last-touch on
 * lead_calls in the window). Service-role; never throws on empty data.
 */
export async function buildStoreDailySummary(
  admin: SupabaseClient,
  storeId: string,
  startIso: string,
  endIso: string,
  tz = "America/Lima",
): Promise<StoreDailySummary> {
  // 1) Active orders in the window (extended fields for source attribution).
  //    `discount_codes` is 0030 — select resilient so the cron survives pre-migration.
  const OCOLS = "name, total_amount, total_refunded, cancelled_at, created_at, customer_phone, tags";
  let ordersRes = await admin
    .from("orders")
    .select(`${OCOLS}, discount_codes`)
    .eq("store_id", storeId)
    .gte("created_at", startIso)
    .lt("created_at", endIso);
  if (ordersRes.error) {
    ordersRes = (await admin
      .from("orders")
      .select(OCOLS)
      .eq("store_id", storeId)
      .gte("created_at", startIso)
      .lt("created_at", endIso)) as typeof ordersRes;
  }
  const orderRows = ((ordersRes.data as any[]) ?? []).map(
    (o) =>
      ({
        store_id: storeId,
        shopify_order_id: "",
        name: o.name ?? null,
        created_at: o.created_at ?? null,
        processed_at: null,
        updated_at: null,
        total_amount: o.total_amount ?? null,
        currency: null,
        financial_status: null,
        cancelled_at: o.cancelled_at ?? null,
        total_refunded: o.total_refunded ?? 0,
        customer_phone: o.customer_phone ?? null,
        tags: o.tags ?? [],
        discount_codes: o.discount_codes ?? [],
        promo_applied: false,
        stock_por_validar: false,
        shipping_mode: null,
        kapso_conversation_id: null,
        line_items: [],
      }) as OrderRow,
  );
  let totalOrders = 0;
  let totalRevenue = 0;
  for (const o of orderRows) {
    if (o.cancelled_at) continue;
    totalOrders += 1;
    totalRevenue += (o.total_amount ?? 0) - (o.total_refunded ?? 0);
  }
  totalRevenue = Math.round(totalRevenue * 100) / 100;

  // Source attribution (order-centric, same engine as the dashboard).
  const attrInputs = await attributionInputsAdmin(admin, storeId, orderRows);
  const attribution = salesAttribution(orderRows, attrInputs);
  const bySource: DailySourceRow[] = attribution.sources.map((s) => ({
    key: s.key,
    label: s.label,
    orders: s.orders,
    revenue: s.revenue,
  }));

  // 2) Per-advisor: human touches (vendedora) in the window → last-touch wins.
  //    Paged: PostgREST responde ~1000 filas como máximo por llamada, y un día
  //    movido supera eso — el recorte silencioso descontaba gestiones (y con
  //    ellas cierres last-touch) del resumen.
  const calls: AdvisorCall[] = [];
  for (let from = 0; from < 20_000; from += 1000) {
    const { data, error } = await admin
      .from("lead_calls")
      .select("vendedora, lead_id, kind, occurred_at")
      .eq("store_id", storeId)
      .not("vendedora", "is", null)
      .gte("occurred_at", startIso)
      .lt("occurred_at", endIso)
      .order("occurred_at", { ascending: true })
      .order("id", { ascending: true })
      .range(from, from + 999);
    if (error) break;
    const batch = (data as AdvisorCall[]) ?? [];
    calls.push(...batch);
    if (batch.length < 1000) break;
  }
  let advisors: AdvisorStat[] = [];
  if (calls.length) {
    const leadIds = [...new Set(calls.map((c) => c.lead_id))];
    const touched: { id: string; has_order: boolean; order_id: string | null }[] = [];
    for (const part of chunk(leadIds, 300)) {
      const { data: leadsRaw } = await admin.from("leads").select("id, has_order, order_id").in("id", part);
      touched.push(...((leadsRaw as typeof touched | null) ?? []));
    }
    const orderIds = touched.filter((l) => l.has_order && l.order_id).map((l) => l.order_id as string);
    const netByOrder = new Map<string, number>();
    for (const part of chunk(orderIds, 300)) {
      const { data: oRaw } = await admin.from("orders").select("id, total_amount, total_refunded").in("id", part);
      for (const o of (oRaw as { id: string; total_amount: number | null; total_refunded: number | null }[]) ?? []) {
        netByOrder.set(o.id, (o.total_amount ?? 0) - (o.total_refunded ?? 0));
      }
    }
    const leadOutcome = new Map<string, { won: boolean; net: number }>();
    for (const l of touched) {
      leadOutcome.set(l.id, { won: !!l.has_order, net: l.order_id ? (netByOrder.get(l.order_id) ?? 0) : 0 });
    }
    const emailById = await resolveEmails([...new Set(calls.map((c) => c.vendedora))]);
    advisors = computeAdvisorStats({ calls, leadOutcome, emailById }, tz);
  }

  return { totalOrders, totalRevenue, advisors, bySource };
}

/** Render a store's daily summary as a Telegram HTML message. `dateLabel` is the
 *  human label of the day being reported (e.g. "jue 26 jun"). */
export function formatDailySummary(
  storeName: string,
  dateLabel: string,
  s: StoreDailySummary,
  currency = "PEN",
): string {
  const esc = (x: string) => x.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const money = (n: number) => formatCurrency(n, currency);
  const lines: string[] = [
    `📊 <b>${esc(storeName)}</b> · ${esc(dateLabel)}`,
    "",
    `💰 <b>${s.totalOrders}</b> pedidos · <b>${money(s.totalRevenue)}</b>`,
    "",
  ];
  if (s.bySource?.length) {
    lines.push("📌 <b>Por fuente</b>");
    for (const src of s.bySource) {
      lines.push(`• ${esc(src.label)} — ${src.orders} ${src.orders === 1 ? "pedido" : "pedidos"} · ${money(src.revenue)}`);
    }
    lines.push("");
  }
  if (s.advisors.length) {
    lines.push("👥 <b>Por asesor</b>");
    s.advisors.forEach((a, i) => {
      const name = esc((a.email.split("@")[0] || a.email).trim());
      lines.push(`${i + 1}. ${name} — ${a.cerrados} ${a.cerrados === 1 ? "venta" : "ventas"} · ${money(a.ingresos)}`);
    });
  } else {
    lines.push("👥 Sin ventas registradas por asesores.");
  }

  // Bot share = the residual not attributed to any advisor (orders the Kapso bot
  // closed directly). Shown so the breakdown reconciles to the total.
  const advisorOrders = s.advisors.reduce((sum, a) => sum + a.cerrados, 0);
  const advisorRevenue = s.advisors.reduce((sum, a) => sum + a.ingresos, 0);
  const botOrders = Math.max(0, s.totalOrders - advisorOrders);
  const botRevenue = Math.round(Math.max(0, s.totalRevenue - advisorRevenue) * 100) / 100;
  if (botOrders > 0) {
    lines.push("");
    lines.push(`🤖 <b>Bot</b> — ${botOrders} ${botOrders === 1 ? "venta" : "ventas"} · ${money(botRevenue)}`);
  }
  return lines.join("\n");
}
