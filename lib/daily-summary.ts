// Daily store sales summary for the Telegram cron: total orders + net revenue
// and per-advisor performance (cerrados + ingresos) for a UTC time window.
// Fetches with the service-role admin client (the cron has no user session) and
// reuses the pure productivity aggregation. The formatter renders Telegram HTML.

import type { SupabaseClient } from "@supabase/supabase-js";
import { formatCurrency, tzParts } from "@/lib/metrics";
import {
  computeAdvisorStats,
  resolveEmails,
  type AdvisorCall,
  type AdvisorStat,
} from "@/lib/productivity";

export interface StoreDailySummary {
  totalOrders: number;
  totalRevenue: number; // net (total_amount − refunds) of active orders in the window
  advisors: AdvisorStat[]; // sorted by ingresos desc (computeAdvisorStats order)
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
  // 1) Totals from active orders created in the window.
  const { data: ordersRaw } = await admin
    .from("orders")
    .select("total_amount, total_refunded, cancelled_at, created_at")
    .eq("store_id", storeId)
    .gte("created_at", startIso)
    .lt("created_at", endIso);
  let totalOrders = 0;
  let totalRevenue = 0;
  for (const o of (ordersRaw as any[]) ?? []) {
    if (o.cancelled_at) continue;
    totalOrders += 1;
    totalRevenue += (o.total_amount ?? 0) - (o.total_refunded ?? 0);
  }
  totalRevenue = Math.round(totalRevenue * 100) / 100;

  // 2) Per-advisor: human touches (vendedora) in the window → last-touch wins.
  const { data: callsRaw } = await admin
    .from("lead_calls")
    .select("vendedora, lead_id, kind, occurred_at")
    .eq("store_id", storeId)
    .not("vendedora", "is", null)
    .gte("occurred_at", startIso)
    .lt("occurred_at", endIso);
  const calls = (callsRaw as AdvisorCall[]) ?? [];
  let advisors: AdvisorStat[] = [];
  if (calls.length) {
    const leadIds = [...new Set(calls.map((c) => c.lead_id))];
    const { data: leadsRaw } = await admin.from("leads").select("id, has_order, order_id").in("id", leadIds);
    const touched = (leadsRaw as { id: string; has_order: boolean; order_id: string | null }[]) ?? [];
    const orderIds = touched.filter((l) => l.has_order && l.order_id).map((l) => l.order_id as string);
    const netByOrder = new Map<string, number>();
    if (orderIds.length) {
      const { data: oRaw } = await admin.from("orders").select("id, total_amount, total_refunded").in("id", orderIds);
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

  return { totalOrders, totalRevenue, advisors };
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
