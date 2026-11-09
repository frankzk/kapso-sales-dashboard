"use server";

// La «Lista negra» en la ficha del lead (MOM §25.3 y §41): si su celular está
// en la lista —un alta a mano o la automática vigente—, la asesora lo sabe
// ANTES de ofrecer contra entrega, con el motivo (las cuentas del propio
// cliente) y lo que se le pide. Solo lectura: «Generar pedido» lo vuelve a
// comprobar en el servidor.

import { redirect } from "next/navigation";
import { createAdminSupabase, createServerSupabase } from "@/lib/db";
import { getLeadRoutingScope } from "@/lib/lead-routing-access";
import { orgOfStore, prepayLookup } from "@/lib/prepay-list-server";
import { pagoOnlineLookup } from "@/lib/pago-online-lookup";
import { listaNegraAutoMark, listaNegraManualMark, listaNegraMergeMarks, type ListaNegraMark } from "@/lib/lista-negra";
import { lnUnreadMessage } from "@/lib/lista-negra-copy";

export interface LeadPrepayStatus {
  listed: boolean;
  /** Por qué está y qué se le pide (la que pide más, si está en las dos). */
  mark?: ListaNegraMark;
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
    const [manual, auto] = await Promise.all([prepayLookup(admin, orgId, lead.phone), pagoOnlineLookup(admin, orgId, lead.phone)]);
    const mark = listaNegraMergeMarks(
      manual.state === "listed" ? listaNegraManualMark(manual.entry) : null,
      auto.state === "listed" ? listaNegraAutoMark(auto.who, auto.requirement) : null,
    );
    if (mark) return { listed: true, mark };
    if (manual.state === "unread" || auto.state === "unread") return { listed: false, error: lnUnreadMessage() };
    return { listed: false };
  } catch {
    return { listed: false, error: lnUnreadMessage() };
  }
}
