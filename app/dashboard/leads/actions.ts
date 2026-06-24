"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createServerSupabase, createAdminSupabase } from "@/lib/db";
import { getLeadWithCalls } from "@/lib/leads-access";
import { CLAIM_TTL_MINUTES, categoryOf, isValidStatus, labelOf } from "@/lib/leads";
import type { LeadCallRow, LeadRow } from "@/lib/types";
import { getStoreCreds } from "@/lib/ingest";
import { fetchLastInboundAt, sendWhatsappText } from "@/lib/kapso";

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
  return detail ?? { error: "No encontrado." };
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
