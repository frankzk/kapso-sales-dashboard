"use server";

// La «Lista de pago adelantado» en la ficha del lead (MOM §41): si su celular
// está en la lista, la asesora lo sabe ANTES de ofrecer contra entrega. Solo
// lectura: «Generar pedido» lo vuelve a comprobar en el servidor.

import { redirect } from "next/navigation";
import { createAdminSupabase, createServerSupabase } from "@/lib/db";
import { getLeadRoutingScope } from "@/lib/lead-routing-access";
import { formatLimaDateTime } from "@/lib/automations-catalog";
import { orgOfStore, prepayEntryView, prepayLookup } from "@/lib/prepay-list-server";
import type { PrepayEvidence } from "@/lib/prepay-list";

export interface LeadPrepayStatus {
  listed: boolean;
  source?: "auto" | "manual";
  reason?: string;
  addedAt?: string;
  evidence?: PrepayEvidence;
  error?: string;
}

export async function loadLeadPrepayStatus(leadId: string): Promise<LeadPrepayStatus> {
  const sb = await createServerSupabase();
  const { data: claims } = await sb.auth.getClaims();
  if (!claims?.claims?.sub) redirect("/login");
  // El lead con los permisos de quien mira (RLS) y su reparto por bloques.
  const { data } = await sb.from("leads").select("store_id,phone").eq("id", leadId).maybeSingle();
  const lead = data as { store_id: string; phone: string | null } | null;
  if (!lead) return { listed: false, error: "Sin acceso a este lead." };
  if (!(await getLeadRoutingScope([lead.store_id], leadId)).allowed) return { listed: false, error: "Sin acceso a este lead." };
  const admin = createAdminSupabase();
  try {
    const orgId = await orgOfStore(admin, lead.store_id);
    if (!orgId) return { listed: false };
    const lookup = await prepayLookup(admin, orgId, lead.phone);
    if (lookup.state !== "listed") return { listed: false };
    const view = prepayEntryView(lookup.entry);
    return { listed: true, source: view.source, reason: view.reason, addedAt: formatLimaDateTime(view.addedAt), evidence: view.evidence };
  } catch {
    return { listed: false, error: "No se pudo comprobar la lista de pago adelantado." };
  }
}
