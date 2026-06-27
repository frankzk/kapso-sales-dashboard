"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createServerSupabase, createAdminSupabase } from "@/lib/db";
import { getCustomerHistory, getLeadWithCalls, type CustomerHistory } from "@/lib/leads-access";
import { CLAIM_TTL_MINUTES, categoryOf, isValidStatus, labelOf } from "@/lib/leads";
import type { LeadCallRow, LeadRow } from "@/lib/types";
import { getStoreCreds } from "@/lib/ingest";
import {
  completeDraftOrder,
  createDraftOrder,
  extractNumericId,
  getDraftOrderForEdit,
  resolveOrderDiscount,
  searchProductVariants,
  updateDraftOrder,
  type ProductVariantResult,
} from "@/lib/shopify";
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
): Promise<
  { lead: LeadRow; calls: LeadCallRow[]; customerHistory: CustomerHistory | null } | { error: string }
> {
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
  // Recurrent-customer block: prior purchases for this phone (excl. its own order).
  const customerHistory = await getCustomerHistory(ctx.storeId, detail.lead.phone, detail.lead.order_id);
  return { lead: detail.lead, calls, customerHistory };
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

/**
 * Recover an abandoned cart: complete its Shopify draft order (→ a real COD
 * order with payment pending), then mark the lead won + credit the advisor,
 * exactly like closeSale. Requires the store's Shopify token to have
 * write_draft_orders; without it we return a clear, actionable error.
 */
export async function recoverCart(leadId: string): Promise<LeadActionState> {
  const ctx = await authorizeLead(leadId);
  if (!ctx) return { error: "Sin acceso a este lead." };

  const admin = createAdminSupabase();
  const { data: lead } = await admin
    .from("leads")
    .select("phone, draft_order_gid, draft_order_name, cart_value, cart_summary, district, has_order")
    .eq("id", leadId)
    .maybeSingle();
  if (!lead) return { error: "Lead no encontrado." };
  const l = lead as {
    phone: string | null;
    draft_order_gid: string | null;
    draft_order_name: string | null;
    cart_value: number | null;
    cart_summary: string | null;
    district: string | null;
    has_order: boolean;
  };
  if (l.has_order) return { error: "Este lead ya tiene un pedido registrado." };
  if (!l.draft_order_gid) return { error: "Este lead no tiene un carrito (borrador) de Shopify." };

  const creds = await getStoreCreds(ctx.storeId);
  if (!creds?.shopify_token) return { error: "La tienda no tiene Shopify configurado." };

  // 1) Complete the draft in Shopify (COD ⇒ payment pending). Tolerate "already
  //    completed" (someone closed it in Shopify) → just mark the lead won.
  let completed: Awaited<ReturnType<typeof completeDraftOrder>>;
  try {
    completed = await completeDraftOrder({
      domain: creds.shopify_domain,
      token: creds.shopify_token,
      draftGid: l.draft_order_gid,
      paymentPending: true,
    });
  } catch (e: any) {
    const msg = String(e?.message ?? e).toLowerCase();
    if (/already.*complet|complet.*already|has already|is complete/.test(msg)) {
      completed = { orderGid: null, orderName: null, status: "completed" };
    } else if (/write_draft_orders|access denied|not authorized|access scope|require/.test(msg)) {
      return { error: "Falta el permiso de escritura en Shopify (write_draft_orders). Re-autoriza la tienda en Ajustes." };
    } else {
      return { error: `No se pudo generar el pedido en Shopify: ${e?.message ?? "error desconocido"}` };
    }
  }

  // 2) Pull the draft's amount/products/phone for the order row.
  const { data: draft } = await admin
    .from("draft_orders")
    .select("total_amount, currency, customer_phone, line_items")
    .eq("store_id", ctx.storeId)
    .eq("draft_order_gid", l.draft_order_gid)
    .maybeSingle();
  const d = (draft as {
    total_amount: number | null;
    currency: string | null;
    customer_phone: string | null;
    line_items: unknown;
  } | null) ?? null;
  const amount = Math.round(Number(d?.total_amount ?? l.cart_value ?? 0) * 100) / 100;
  const currency = d?.currency ?? creds.currency ?? "PEN";
  const phone = d?.customer_phone ?? l.phone ?? null;
  const lineItems =
    Array.isArray(d?.line_items) && d.line_items.length
      ? (d.line_items as unknown[])
      : [{ title: l.cart_summary || "Carrito recuperado", quantity: 1, price: amount }];
  const nowIso = new Date().toISOString();

  // 3) Record the resulting order. Tagged `kapso` so recompute_daily_rollups
  //    counts it; `carrito_recuperado` so it's identifiable. Use the real Shopify
  //    id when returned (so a later order sync upserts the same row, no dup);
  //    else a synthetic id. COD ⇒ financial_status 'pending'.
  const realOrderId = completed.orderGid ? extractNumericId(completed.orderGid) : null;
  const shopifyOrderId = realOrderId || `draft-${extractNumericId(l.draft_order_gid)}`;
  const { data: order, error: orderErr } = await admin
    .from("orders")
    .upsert(
      {
        store_id: ctx.storeId,
        shopify_order_id: shopifyOrderId,
        name: completed.orderName ?? l.draft_order_name ?? `REC-${shopifyOrderId.slice(-6).toUpperCase()}`,
        created_at: nowIso,
        processed_at: nowIso,
        total_amount: amount,
        total_refunded: 0,
        currency,
        financial_status: "pending",
        cancelled_at: null,
        customer_phone: phone,
        tags: ["kapso", "carrito_recuperado"],
        promo_applied: false,
        stock_por_validar: false,
        shipping_mode: "cod",
        line_items: lineItems,
        kapso_conversation_id: null,
      },
      { onConflict: "store_id,shopify_order_id" },
    )
    .select("id")
    .maybeSingle();
  if (orderErr || !order) {
    return {
      error: `Pedido generado en Shopify, pero no se pudo registrar localmente: ${orderErr?.message ?? "error"}`,
    };
  }

  // 4) Mark the lead won + link the order; reflect the draft as completed.
  await admin
    .from("leads")
    .update({
      has_order: true,
      order_id: (order as { id: string }).id,
      status: "pedido_generado",
      category: "won",
      needs_attention: false,
      draft_order_status: "completed",
      last_interaction_at: nowIso,
    })
    .eq("id", leadId);
  await admin
    .from("draft_orders")
    .update({ status: "completed", completed_at: nowIso, order_gid: completed.orderGid })
    .eq("store_id", ctx.storeId)
    .eq("draft_order_gid", l.draft_order_gid);

  // 5) Log the recovery — credits the advisor in Productividad (like closeSale).
  const noteParts = [`Carrito recuperado · pedido generado en Shopify · ${currency} ${amount.toFixed(2)} · contraentrega`];
  if (l.cart_summary) noteParts.push(`Productos: ${l.cart_summary}`);
  if (l.district) noteParts.push(`Distrito: ${l.district}`);
  await admin.from("lead_calls").insert({
    lead_id: leadId,
    store_id: ctx.storeId,
    vendedora: ctx.userId,
    kind: "sale",
    new_status: "pedido_generado",
    note: noteParts.join(" · "),
  });

  // 6) Recompute the day's rollups so revenue / COD reflect the recovery now.
  try {
    const day = nowIso.slice(0, 10);
    await admin.rpc("recompute_daily_rollups", { p_store_id: ctx.storeId, p_from: day, p_to: day });
  } catch {
    /* non-fatal: the next sync's rollup recompute will pick it up */
  }

  revalidatePath("/dashboard/leads");
  revalidatePath("/dashboard");
  return { notice: `Pedido generado ✓ · ${currency} ${amount.toFixed(2)} (contraentrega)` };
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

// ===========================================================================
// Unified order form: search catalog · pre-fill from cart · generate the order
// (supersedes closeSale + recoverCart). Cart → update+complete the draft; new
// sale → create+complete a draft. Always a REAL Shopify order, COD pago pendiente.
// ===========================================================================

/** Search the lead's store catalog for the product picker (RLS-authorized). */
export async function searchStoreProducts(
  leadId: string,
  query: string,
): Promise<ProductVariantResult[]> {
  const ctx = await authorizeLead(leadId);
  if (!ctx) return [];
  const creds = await getStoreCreds(ctx.storeId);
  if (!creds?.shopify_token) return [];
  try {
    return await searchProductVariants({
      domain: creds.shopify_domain,
      token: creds.shopify_token,
      query,
      first: 20,
    });
  } catch {
    return []; // e.g. read_products not granted yet → picker degrades to custom items
  }
}

export interface OrderFormPrefill {
  isCart: boolean;
  draftGid: string | null;
  lineItems: { variantId: string | null; title: string; quantity: number; unitPrice: number | null }[];
  customerName: string | null;
  phone: string | null;
  address1: string | null;
  district: string | null;
  province: string | null;
  referencia: string | null;
  windowOpen: boolean; // 24h WhatsApp window (drives the confirmation default)
}

/** Pre-fill the order form: for a cart, read the live draft (variant ids + price
 *  + address); for a new sale, return the lead's defaults blank. */
export async function loadOrderDraft(leadId: string): Promise<OrderFormPrefill | { error: string }> {
  const ctx = await authorizeLead(leadId);
  if (!ctx) return { error: "Sin acceso a este lead." };
  const admin = createAdminSupabase();
  const { data: lead } = await admin
    .from("leads")
    .select("phone, name, draft_order_gid, district, province, referencia, kapso_conversation_id")
    .eq("id", leadId)
    .maybeSingle();
  if (!lead) return { error: "Lead no encontrado." };
  const l = lead as {
    phone: string | null;
    name: string | null;
    draft_order_gid: string | null;
    district: string | null;
    province: string | null;
    referencia: string | null;
    kapso_conversation_id: string | null;
  };

  const out: OrderFormPrefill = {
    isCart: !!l.draft_order_gid,
    draftGid: l.draft_order_gid,
    lineItems: [],
    customerName: l.name,
    phone: l.phone,
    address1: null,
    district: l.district,
    province: l.province,
    referencia: l.referencia,
    windowOpen: false,
  };

  if (l.draft_order_gid) {
    const creds = await getStoreCreds(ctx.storeId);
    let filled = false;
    if (creds?.shopify_token) {
      try {
        const draft = await getDraftOrderForEdit({
          domain: creds.shopify_domain,
          token: creds.shopify_token,
          gid: l.draft_order_gid,
        });
        if (draft) {
          out.lineItems = draft.lineItems;
          out.customerName = draft.address.name ?? l.name;
          out.address1 = draft.address.address1;
          out.district = draft.address.city ?? l.district;
          out.province = draft.address.province ?? l.province;
          out.referencia = draft.address.address2 ?? l.referencia;
          filled = true;
        }
      } catch {
        /* live fetch failed → fall back to stored draft_orders data below */
      }
    }
    if (!filled) {
      const { data: d } = await admin
        .from("draft_orders")
        .select("line_items, address1, district, province, referencia, customer_name")
        .eq("store_id", ctx.storeId)
        .eq("draft_order_gid", l.draft_order_gid)
        .maybeSingle();
      const dd = d as {
        line_items: unknown;
        address1: string | null;
        district: string | null;
        province: string | null;
        referencia: string | null;
        customer_name: string | null;
      } | null;
      if (dd) {
        out.lineItems = (Array.isArray(dd.line_items) ? dd.line_items : []).map((li: any) => ({
          variantId: null,
          title: String(li?.title ?? ""),
          quantity: Number(li?.quantity ?? 1),
          unitPrice: li?.price != null ? Number(li.price) : null,
        }));
        out.address1 = dd.address1 ?? out.address1;
        out.district = dd.district ?? out.district;
        out.province = dd.province ?? out.province;
        out.referencia = dd.referencia ?? out.referencia;
        out.customerName = dd.customer_name ?? out.customerName;
      }
    }
  }

  // 24h window (drives the confirmation checkbox default).
  if (l.kapso_conversation_id) {
    const w = await getLeadWindow(leadId);
    out.windowOpen = w.open;
  }
  return out;
}

export interface GenerateOrderInput {
  lineItems: { variantId?: string | null; title?: string | null; quantity: number; unitPrice: number | null }[];
  customerName?: string;
  phone?: string;
  address1: string;
  district: string;
  province?: string;
  referencia?: string;
  note?: string;
  sendConfirmation?: boolean;
  confirmationText?: string;
  discount?: { kind: "fixed" | "percent"; value: number } | null;
}

function defaultConfirmation(o: {
  name: string | null;
  products: { title: string; quantity: number }[];
  amount: number;
  currency: string;
  district: string;
  address1: string;
}): string {
  const items = o.products.map((p) => `• ${p.quantity}× ${p.title}`).join("\n");
  const hi = o.name ? ` ${o.name.split(/\s+/)[0]}` : "";
  return (
    `¡Hola${hi}! 🎉 Tu pedido quedó confirmado:\n${items}\n` +
    `Total: ${o.currency} ${o.amount.toFixed(2)} (pago contraentrega)\n` +
    `Entrega: ${o.address1}, ${o.district}\n¡Gracias por tu compra! 📦`
  );
}

/**
 * Generate the order from the unified form. Validates required data (≥1 product,
 * address + distrito), then: cart → updateDraftOrder + completeDraftOrder; new →
 * createDraftOrder + completeDraftOrder. Records the order (tag:kapso so it counts),
 * marks the lead won, credits the advisor, recomputes rollups, and — if asked and
 * the 24h window is open — sends a WhatsApp confirmation from the lead's number.
 */
export async function generateOrder(
  leadId: string,
  input: GenerateOrderInput,
): Promise<LeadActionState> {
  const ctx = await authorizeLead(leadId);
  if (!ctx) return { error: "Sin acceso a este lead." };

  const items = (input.lineItems ?? []).filter(
    (li) => (li.variantId || (li.title ?? "").trim()) && Number(li.quantity) > 0,
  );
  if (!items.length) return { error: "Agrega al menos un producto." };
  const address1 = (input.address1 ?? "").trim();
  const district = (input.district ?? "").trim();
  if (!address1) return { error: "La dirección es obligatoria." };
  if (!district) return { error: "El distrito es obligatorio." };

  const admin = createAdminSupabase();
  const { data: lead } = await admin
    .from("leads")
    .select("phone, name, wa_phone_number_id, kapso_conversation_id, draft_order_gid, has_order")
    .eq("id", leadId)
    .maybeSingle();
  if (!lead) return { error: "Lead no encontrado." };
  const l = lead as {
    phone: string | null;
    name: string | null;
    wa_phone_number_id: string | null;
    kapso_conversation_id: string | null;
    draft_order_gid: string | null;
    has_order: boolean;
  };
  if (l.has_order) return { error: "Este lead ya tiene un pedido registrado." };

  const creds = await getStoreCreds(ctx.storeId);
  if (!creds?.shopify_token) return { error: "La tienda no tiene Shopify configurado." };
  const currency = creds.currency ?? "PEN";
  const phone = ((input.phone ?? "").trim() || l.phone) ?? null;

  const lineItemsInput = items.map((li) => ({
    variantId: li.variantId ?? null,
    title: (li.title ?? "").trim() || null,
    quantity: Math.max(1, Math.floor(Number(li.quantity))),
    unitPrice: li.unitPrice != null ? Math.round(Number(li.unitPrice) * 100) / 100 : null,
  }));
  const subtotal = Math.round(lineItemsInput.reduce((s, li) => s + (li.unitPrice ?? 0) * li.quantity, 0) * 100) / 100;
  if (subtotal <= 0) return { error: "El monto del pedido debe ser mayor a 0." };
  // Order-level discount (Monto/Porcentaje) → net total + Shopify appliedDiscount.
  const { total: amount, discountAmount, appliedDiscount } = resolveOrderDiscount(subtotal, input.discount);

  const address = {
    name: (input.customerName ?? l.name ?? "").trim() || null,
    phone,
    address1,
    address2: (input.referencia ?? "").trim() || null,
    city: district,
    province: (input.province ?? "").trim() || null,
    country: "Peru",
  };
  const sclient = { domain: creds.shopify_domain, token: creds.shopify_token };
  const isCart = !!l.draft_order_gid;
  let draftGid = l.draft_order_gid;

  // Build+run the draft (create for a new sale, update for a cart). withPhone=false
  // is the retry path when Shopify rejects the phone ("Phone is invalid") — a bad
  // phone must never block the sale; the lead keeps the number anyway.
  const runDraft = async (withPhone: boolean): Promise<string> => {
    const addr = { ...address, phone: withPhone ? phone : null };
    const ph = withPhone ? phone : null;
    if (isCart && l.draft_order_gid) {
      await updateDraftOrder({
        ...sclient,
        gid: l.draft_order_gid,
        input: { lineItems: lineItemsInput, address: addr, phone: ph, note: input.note ?? null, appliedDiscount },
      });
      return l.draft_order_gid;
    }
    const created = await createDraftOrder({
      ...sclient,
      input: { lineItems: lineItemsInput, address: addr, phone: ph, note: input.note ?? null, tags: ["venta_manual"], appliedDiscount },
    });
    return created.gid;
  };

  // 1) Create/update the draft, then complete it (COD ⇒ payment pending).
  let completed: Awaited<ReturnType<typeof completeDraftOrder>>;
  try {
    try {
      draftGid = await runDraft(true);
    } catch (e: any) {
      if (/phone/i.test(String(e?.message ?? e))) {
        draftGid = await runDraft(false); // bad phone → generate the order without it
      } else {
        throw e;
      }
    }
    completed = await completeDraftOrder({ ...sclient, draftGid: draftGid!, paymentPending: true });
  } catch (e: any) {
    const msg = String(e?.message ?? e).toLowerCase();
    if (/already.*complet|complet.*already|has already|is complete/.test(msg)) {
      completed = { orderGid: null, orderName: null, status: "completed" };
    } else if (/write_draft_orders|access denied|not authorized|access scope|require/.test(msg)) {
      return { error: "Falta el permiso de escritura en Shopify (write_draft_orders). Re-autoriza la tienda en Ajustes." };
    } else {
      return { error: `No se pudo generar el pedido en Shopify: ${e?.message ?? "error desconocido"}` };
    }
  }

  // 2) Record the resulting order (tag:kapso so recompute_daily_rollups counts it).
  const nowIso = new Date().toISOString();
  const realOrderId = completed.orderGid ? extractNumericId(completed.orderGid) : null;
  const shopifyOrderId = realOrderId || `draft-${extractNumericId(draftGid!)}`;
  const products = lineItemsInput.map((li) => ({
    title: li.title || "Producto",
    quantity: li.quantity,
    price: li.unitPrice,
  }));
  const { data: order, error: orderErr } = await admin
    .from("orders")
    .upsert(
      {
        store_id: ctx.storeId,
        shopify_order_id: shopifyOrderId,
        name: completed.orderName ?? `PED-${shopifyOrderId.slice(-6).toUpperCase()}`,
        created_at: nowIso,
        processed_at: nowIso,
        total_amount: amount,
        total_refunded: 0,
        currency,
        financial_status: "pending",
        cancelled_at: null,
        customer_phone: phone,
        tags: isCart ? ["kapso", "carrito_recuperado"] : ["kapso", "venta_manual"],
        promo_applied: false,
        stock_por_validar: false,
        shipping_mode: "cod",
        line_items: products,
        kapso_conversation_id: l.kapso_conversation_id ?? null,
      },
      { onConflict: "store_id,shopify_order_id" },
    )
    .select("id")
    .maybeSingle();
  if (orderErr || !order) {
    return { error: `Pedido generado en Shopify, pero no se pudo registrar localmente: ${orderErr?.message ?? "error"}` };
  }

  // 3) Lead won + draft mirror.
  await admin
    .from("leads")
    .update({
      has_order: true,
      order_id: (order as { id: string }).id,
      status: "pedido_generado",
      category: "won",
      needs_attention: false,
      last_interaction_at: nowIso,
      ...(isCart ? { draft_order_status: "completed" } : {}),
    })
    .eq("id", leadId);
  if (isCart && draftGid) {
    await admin
      .from("draft_orders")
      .update({ status: "completed", completed_at: nowIso, order_gid: completed.orderGid })
      .eq("store_id", ctx.storeId)
      .eq("draft_order_gid", draftGid);
  }

  // 4) Log the sale (credits the advisor in Productividad).
  const discLabel =
    discountAmount > 0
      ? input.discount?.kind === "percent"
        ? ` · desc. ${Math.min(100, input.discount.value)}% (−${currency} ${discountAmount.toFixed(2)})`
        : ` · desc. ${currency} ${discountAmount.toFixed(2)}`
      : "";
  const note = [
    `${isCart ? "Carrito recuperado" : "Venta nueva"} · pedido generado en Shopify · ${currency} ${amount.toFixed(2)}${discLabel} · contraentrega`,
    `Productos: ${products.map((p) => `${p.quantity}× ${p.title}`).join(", ")}`,
    `Entrega: ${district}${address.address2 ? " · " + address.address2 : ""}`,
  ].join(" · ");
  await admin.from("lead_calls").insert({
    lead_id: leadId,
    store_id: ctx.storeId,
    vendedora: ctx.userId,
    kind: "sale",
    new_status: "pedido_generado",
    note,
  });

  // 5) Recompute today's rollups so revenue/COD reflect it now.
  try {
    const day = nowIso.slice(0, 10);
    await admin.rpc("recompute_daily_rollups", { p_store_id: ctx.storeId, p_from: day, p_to: day });
  } catch {
    /* next sync recomputes */
  }

  // 6) Confirmation WhatsApp (best-effort; only if asked + a number is set).
  let confirmNote = "";
  if (input.sendConfirmation && phone) {
    const pnId = l.wa_phone_number_id ?? creds.whatsapp_phone_number_id;
    if (creds.kapso_api_key && pnId) {
      const body =
        (input.confirmationText ?? "").trim() ||
        defaultConfirmation({ name: address.name, products, amount, currency, district, address1 });
      const res = await sendWhatsappText({ apiKey: creds.kapso_api_key }, { phoneNumberId: pnId, to: phone, body });
      if (res.ok) {
        await admin.from("lead_calls").insert({
          lead_id: leadId,
          store_id: ctx.storeId,
          vendedora: ctx.userId,
          kind: "message",
          new_status: null,
          note: body,
        });
        confirmNote = " · confirmación enviada ✓";
      } else {
        confirmNote = " · (no se envió la confirmación: ventana de 24h cerrada o error)";
      }
    }
  }

  revalidatePath("/dashboard/leads");
  revalidatePath("/dashboard");
  return { notice: `Pedido generado ✓ · ${currency} ${amount.toFixed(2)} (contraentrega)${confirmNote}` };
}
