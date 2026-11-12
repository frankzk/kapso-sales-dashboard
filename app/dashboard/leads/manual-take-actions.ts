"use server";

import { createAdminSupabase, createServerSupabase } from "@/lib/db";
import { resolveAgentName } from "@/lib/agent-names";

export type ManualTakeOrigin = "busqueda" | "venta_telefonica";
type ManualTakeState = { error?: string; manualException?: boolean };

/** Actor comes from the verified session. Database rechecks store, flag,
 * appointments, live claims and capacity atomically under locks. */
export async function takeLeadManually(leadId: string, origin: ManualTakeOrigin, preview = false): Promise<ManualTakeState> {
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(leadId)
    || !["busqueda", "venta_telefonica"].includes(origin)) return { error: "Solicitud de toma puntual inválida." };
  const sb = await createServerSupabase();
  const { data } = await sb.auth.getClaims();
  const actor = data?.claims?.sub;
  if (!actor) return { error: "Tu sesión terminó. Vuelve a ingresar." };
  // RLS is the first boundary, before any service-role read.
  const visible = await sb.from("leads").select("id").eq("id", leadId).maybeSingle();
  if (visible.error || !visible.data) return { error: "Sin acceso a la tienda de este lead." };
  const admin = createAdminSupabase();
  const result = await admin.rpc(preview ? "lead_manual_take_check" : "claim_manual_lead",
    { p_actor: actor, p_lead: leadId, ...preview ? {} : { p_origin: origin } });
  if (result.error || !result.data) return { error: "No se pudo comprobar la toma puntual. Intenta nuevamente." };
  const status = result.data as { ok: boolean; reason?: string; holder?: string; manualException?: boolean };
  if (status.ok) return { manualException: status.manualException ?? false };
  const who = status.holder ? await resolveAgentName(status.holder, admin).catch(() => null) : null;
  if (status.reason === "claimed") return { error: `${who ?? "Otra asesora"} está atendiendo este lead. Pide a coordinación que lo reasigne si corresponde.` };
  if (status.reason === "appointment") return { error: `Este lead tiene una cita vigente con ${who ?? "otra asesora"}. Pide a coordinación que lo reasigne si corresponde.` };
  if (status.reason === "capacity") return { error: "Ya tienes dos leads abiertos. Cierra uno para tomar este." };
  if (status.reason === "permission") return { error: "Este lead está fuera de tus bloques. Necesitas el permiso «Puede tomar leads fuera de sus bloques» en Equipo → Leads." };
  return { error: "Sin acceso a la tienda de este lead." };
}
