"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createServerSupabase, createAdminSupabase } from "@/lib/db";
import { getLeadWithCalls } from "@/lib/leads-access";
import { CLAIM_TTL_MINUTES, categoryOf, isValidStatus, labelOf } from "@/lib/leads";
import type { LeadCallRow, LeadRow } from "@/lib/types";
import { getStoreCreds } from "@/lib/ingest";
import { fetchLastInboundAt, sendWhatsappText } from "@/lib/kapso";

// Process-level cache of vendedora id → display name (emails ~never change).
const agentNameCache = new Map<string, string>();

export interface LeadActionState {
  error?: string;
  notice?: string;
}

/** Fetch a lead + its call history (RLS-scoped). Drives the drawer client-side. */
export async function loadLeadDetail(
  leadId: string,
): Promise<{ lead: LeadRow; calls: LeadCallRow[] } | { error: string }> {
  const ctx = await authorizeLead(leadId);
  if (!ctx) return { error: "Sin acceso a este lead." };
  const detail = await getLeadWithCalls(leadId);
  if (!detail) return { error: "No encontrado." };

  // Resolve who logged each entry (vendedora id → display name) for the history.
  const ids = [...new Set(detail.calls.map((c) => c.vendedora).filter(Boolean))] as string[];
  const missing = ids.filter((id) => !agentNameCache.has(id));
  if (missing.length) {
    const admin = createAdminSupabase();
    await Promise.all(
      missing.map(async (id) => {
        try {
          const { data } = await admin.auth.admin.getUserById(id);
          const email = data?.user?.email ?? null;
          agentNameCache.set(id, email ? email.split("@")[0]! : id.slice(0, 8));
        } catch {
          /* leave unresolved */
        }
      }),
    );
  }
  const calls = detail.calls.map((c) => ({
    ...c,
    vendedora_name: c.vendedora ? (agentNameCache.get(c.vendedora) ?? null) : null,
  }));
  return { lead: detail.lead, calls };
}

/**
 * Search leads in a store by name OR phone, across ALL stages (RLS-scoped, so a
 * user only ever matches rows in stores they may access). Powers the leads
 * search box. Two ILIKE passes (name + phone digits) merged + deduped, most
 * recent first, capped. Returns [] for queries shorter than 2 chars.
 */
export async function searchLeads(storeId: string, query: string): Promise<LeadRow[]> {
  const q = query.trim();
  if (q.length < 2) return [];
  const sb = await createServerSupabase();
  const nameLike = `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`; // escape LIKE wildcards
  const digits = q.replace(/\D/g, "");
  const passes = [
    sb
      .from("leads")
      .select("*")
      .eq("store_id", storeId)
      .ilike("name", nameLike)
      .order("last_interaction_at", { ascending: false })
      .limit(40),
  ];
  if (digits.length >= 2) {
    passes.push(
      sb
        .from("leads")
        .select("*")
        .eq("store_id", storeId)
        .ilike("phone", `%${digits}%`)
        .order("last_interaction_at", { ascending: false })
        .limit(40),
    );
  }
  const settled = await Promise.all(passes);
  const byId = new Map<string, LeadRow>();
  for (const { data } of settled) {
    for (const r of (data as LeadRow[] | null) ?? []) byId.set(r.id!, r);
  }
  return [...byId.values()]
    .sort((a, b) => (b.last_interaction_at ?? "").localeCompare(a.last_interaction_at ?? ""))
    .slice(0, 40);
}

/** Authorize: the caller must be able to SEE the lead under RLS. Returns its store. */
async function authorizeLead(leadId: string): Promise<{ userId: string; storeId: string } | null> {
  const sb = await createServerSupabase();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) redirect("/login");
  const { data } = await sb.from("leads").select("store_id").eq("id", leadId).maybeSingle();
  if (!data) return null;
  return { userId: user.id, storeId: data.store_id as string };
}

/** Claim a lead (one at a time). Succeeds if free, stale, or already mine. */
export async function claimLead(leadId: string): Promise<LeadActionState> {
  const ctx = await authorizeLead(leadId);
  if (!ctx) return { error: "Sin acceso a este lead." };

  const admin = createAdminSupabase();
  const cutoff = new Date(Date.now() - CLAIM_TTL_MINUTES * 60_000).toISOString();
  const { data, error } = await admin
    .from("leads")
    .update({ claimed_by: ctx.userId, claimed_at: new Date().toISOString() })
    .eq("id", leadId)
    .or(`claimed_by.is.null,claimed_by.eq.${ctx.userId},claimed_at.lt.${cutoff}`)
    .select("id")
    .maybeSingle();
  if (error) return { error: error.message };
  if (!data) return { error: "Otro vendedor está atendiendo este lead." };
  revalidatePath("/dashboard/leads");
  return { notice: "Lead tomado." };
}

/** Release a claim (called when closing the drawer). Only releases your own. */
export async function releaseLead(leadId: string): Promise<LeadActionState> {
  const ctx = await authorizeLead(leadId);
  if (!ctx) return { error: "Sin acceso." };
  const admin = createAdminSupabase();
  await admin
    .from("leads")
    .update({ claimed_by: null, claimed_at: null })
    .eq("id", leadId)
    .eq("claimed_by", ctx.userId);
  revalidatePath("/dashboard/leads");
  return { notice: "Liberado." };
}

/** Register a call: log it, apply the new status, set the next follow-up. */
export async function registerCall(
  _prev: LeadActionState,
  formData: FormData,
): Promise<LeadActionState> {
  const leadId = String(formData.get("lead_id") ?? "");
  const ctx = await authorizeLead(leadId);
  if (!ctx) return { error: "Sin acceso a este lead." };

  const status = String(formData.get("status") ?? "").trim();
  const note = String(formData.get("note") ?? "").trim() || null;
  const followupRaw = String(formData.get("next_followup_at") ?? "").trim();
  const nextFollowup = followupRaw ? new Date(followupRaw).toISOString() : null;

  if (status && !isValidStatus(status)) return { error: "Estado inválido." };

  const admin = createAdminSupabase();

  await admin.from("lead_calls").insert({
    lead_id: leadId,
    store_id: ctx.storeId,
    vendedora: ctx.userId,
    kind: "call",
    new_status: status || null,
    note,
    next_followup_at: nextFollowup,
  });

  const patch: Record<string, unknown> = { last_interaction_at: new Date().toISOString() };
  if (status) {
    patch.status = status;
    patch.category = categoryOf(status);
    patch.needs_attention = false;
  }
  if (nextFollowup) patch.next_followup_at = nextFollowup;
  await admin.from("leads").update(patch).eq("id", leadId);

  revalidatePath("/dashboard/leads");
  return {
    notice: status ? `Llamada registrada · ${labelOf(status)}` : "Llamada registrada.",
  };
}

/**
 * Close a sale by phone (contraentrega / COD). Records a lightweight manual
 * order, marks the lead as Ganado and credits the advisor — so a sale closed on
 * a call counts in revenue, COD totals and productividad just like a bot order.
 *
 * The order is a real `orders` row tagged `kapso` (so recompute_daily_rollups
 * counts it) + `venta_manual` (so it's identifiable), with a synthetic
 * `shopify_order_id` ("manual-…") that never collides with or is touched by the
 * Shopify sync (which only upserts by numeric id). COD ⇒ financial_status
 * 'pending'. Day rollups are recomputed inline so the dashboard updates now.
 */
export async function closeSale(
  leadId: string,
  input: { amount: number; products?: string; district?: string },
): Promise<LeadActionState> {
  const ctx = await authorizeLead(leadId);
  if (!ctx) return { error: "Sin acceso a este lead." };

  const amount = Math.round(Number(input.amount) * 100) / 100;
  if (!Number.isFinite(amount) || amount <= 0) return { error: "Ingresa un monto válido (mayor a 0)." };
  if (amount > 1_000_000) return { error: "Monto demasiado alto." };

  const admin = createAdminSupabase();
  const { data: lead } = await admin
    .from("leads")
    .select("phone, kapso_conversation_id, has_order")
    .eq("id", leadId)
    .maybeSingle();
  if (!lead) return { error: "Lead no encontrado." };
  const l = lead as { phone: string | null; kapso_conversation_id: string | null; has_order: boolean };
  if (l.has_order) return { error: "Este lead ya tiene un pedido registrado." };

  const { data: store } = await admin
    .from("stores")
    .select("currency")
    .eq("id", ctx.storeId)
    .maybeSingle();
  const currency = (store as { currency: string } | null)?.currency ?? "PEN";

  const products = (input.products ?? "").trim();
  const district = (input.district ?? "").trim();
  const nowIso = new Date().toISOString();
  const syntheticId = `manual-${crypto.randomUUID()}`;

  // 1) Manual COD order. Tagged `kapso` so it counts in the rollups; `venta_manual`
  //    so it can be told apart from bot/Shopify orders.
  const { data: order, error: orderErr } = await admin
    .from("orders")
    .insert({
      store_id: ctx.storeId,
      shopify_order_id: syntheticId,
      name: `LLAM-${syntheticId.slice(7, 13).toUpperCase()}`,
      created_at: nowIso,
      processed_at: nowIso,
      total_amount: amount,
      total_refunded: 0,
      currency,
      financial_status: "pending", // contraentrega = pago pendiente
      cancelled_at: null,
      customer_phone: l.phone,
      tags: ["kapso", "venta_manual"],
      promo_applied: false,
      stock_por_validar: false,
      shipping_mode: "cod",
      line_items: [{ title: products || "Venta por llamada", quantity: 1, price: amount }],
      kapso_conversation_id: l.kapso_conversation_id ?? null,
    })
    .select("id")
    .maybeSingle();
  if (orderErr || !order) {
    return { error: `No se pudo registrar la venta: ${orderErr?.message ?? "error desconocido"}` };
  }

  // 2) Mark the lead won + link the order (sticky).
  await admin
    .from("leads")
    .update({
      has_order: true,
      order_id: (order as { id: string }).id,
      status: "pedido_generado",
      category: "won",
      needs_attention: false,
      last_interaction_at: nowIso,
    })
    .eq("id", leadId);

  // 3) Log the sale in the lead history — this is what credits the advisor in
  //    Productividad (last caller of a won lead, with the order's net).
  const noteParts = [`Venta cerrada por llamada · ${currency} ${amount.toFixed(2)} · contraentrega (pago pendiente)`];
  if (products) noteParts.push(`Productos: ${products}`);
  if (district) noteParts.push(`Distrito: ${district}`);
  await admin.from("lead_calls").insert({
    lead_id: leadId,
    store_id: ctx.storeId,
    vendedora: ctx.userId,
    kind: "sale",
    new_status: "pedido_generado",
    note: noteParts.join(" · "),
  });

  // 4) Recompute the day's rollups so revenue / COD / AOV reflect the sale now
  //    (otherwise it would only appear on the next 15-min cron).
  try {
    const day = nowIso.slice(0, 10);
    await admin.rpc("recompute_daily_rollups", { p_store_id: ctx.storeId, p_from: day, p_to: day });
  } catch {
    /* non-fatal: the next sync's rollup recompute will pick it up */
  }

  revalidatePath("/dashboard/leads");
  revalidatePath("/dashboard");
  return { notice: `Venta registrada ✓ · ${currency} ${amount.toFixed(2)} (contraentrega)` };
}

const WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Is the lead's WhatsApp 24h session window open? (i.e. the customer sent a
 * message within the last 24h, so we may reply with free text). Reads the last
 * inbound message time live from Kapso.
 */
export async function getLeadWindow(
  leadId: string,
): Promise<{ open: boolean; lastInboundAt: string | null; reason?: string }> {
  const ctx = await authorizeLead(leadId);
  if (!ctx) return { open: false, lastInboundAt: null, reason: "Sin acceso." };
  const admin = createAdminSupabase();
  const { data } = await admin
    .from("leads")
    .select("kapso_conversation_id")
    .eq("id", leadId)
    .maybeSingle();
  const convId = (data as { kapso_conversation_id: string | null } | null)?.kapso_conversation_id ?? null;
  if (!convId) return { open: false, lastInboundAt: null, reason: "Sin conversación de WhatsApp." };
  const creds = await getStoreCreds(ctx.storeId);
  if (!creds?.kapso_api_key) return { open: false, lastInboundAt: null, reason: "Tienda sin Kapso configurado." };
  const lastMs = await fetchLastInboundAt({ apiKey: creds.kapso_api_key }, convId);
  if (lastMs == null) return { open: false, lastInboundAt: null, reason: "El cliente aún no ha escrito." };
  return { open: Date.now() - lastMs < WINDOW_MS, lastInboundAt: new Date(lastMs).toISOString() };
}

/**
 * Send a free-text WhatsApp message to the lead. Only works inside the 24h
 * session window; outside it WhatsApp rejects the send and we say so. The sent
 * message is logged to the lead history (kind="message").
 */
export async function sendLeadMessage(leadId: string, text: string): Promise<LeadActionState> {
  const body = text.trim();
  if (!body) return { error: "Escribe un mensaje." };
  if (body.length > 4000) return { error: "Mensaje demasiado largo (máx. 4000 caracteres)." };
  const ctx = await authorizeLead(leadId);
  if (!ctx) return { error: "Sin acceso a este lead." };

  const admin = createAdminSupabase();
  const { data } = await admin.from("leads").select("phone").eq("id", leadId).maybeSingle();
  const phone = (data as { phone: string | null } | null)?.phone ?? null;
  if (!phone) return { error: "El lead no tiene teléfono." };

  const creds = await getStoreCreds(ctx.storeId);
  if (!creds?.kapso_api_key || !creds.whatsapp_phone_number_id) {
    return { error: "La tienda no tiene WhatsApp/Kapso configurado." };
  }

  const res = await sendWhatsappText(
    { apiKey: creds.kapso_api_key },
    { phoneNumberId: creds.whatsapp_phone_number_id, to: phone, body },
  );
  if (!res.ok) {
    const closed = res.code === 131047 || /24\s*h|re-?engag|outside|window/i.test(res.error);
    return {
      error: closed
        ? "Ventana de 24h cerrada: el cliente debe escribirte primero (o se necesita una plantilla)."
        : `No se pudo enviar: ${res.error}`,
    };
  }

  await admin.from("lead_calls").insert({
    lead_id: leadId,
    store_id: ctx.storeId,
    vendedora: ctx.userId,
    kind: "message",
    new_status: null,
    note: body,
  });
  await admin.from("leads").update({ last_interaction_at: new Date().toISOString() }).eq("id", leadId);

  revalidatePath("/dashboard/leads");
  return { notice: "Mensaje enviado por WhatsApp ✓" };
}
