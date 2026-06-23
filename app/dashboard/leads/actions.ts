"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createServerSupabase, createAdminSupabase } from "@/lib/db";
import { CLAIM_TTL_MINUTES, categoryOf, isValidStatus, labelOf } from "@/lib/leads";

export interface LeadActionState {
  error?: string;
  notice?: string;
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
