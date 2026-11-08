"use server";

// Automatizaciones › Conector de IA (MOM §42): crear y revocar los tokens con los
// que un agente (Grok Bot) consulta Kapta por `POST /api/mcp`. Con
// `automations.manage`, como el resto de Automatizaciones (§40): un agente que
// lee pedidos y conversaciones es una automatización más.
//
// EL TOKEN NO SE GUARDA. Se genera aquí, se guarda su sha256 y vuelve UNA vez en
// la respuesta, para pegarlo en Grok Bot. Kapta no puede volver a mostrarlo: si
// se pierde, se revoca y se crea otro.

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createAdminSupabase, createServerSupabase } from "@/lib/db";
import { hasOrgPermission } from "@/lib/permissions-access";
import {
  AGENT_MIGRATION_MISSING,
  AGENT_SCOPES,
  agentTokenHint,
  generateAgentToken,
  hashAgentToken,
  isAgentMigrationMissing,
  isAgentScope,
} from "@/lib/agent-auth";

export interface AgentTokenFormState {
  error?: string;
  notice?: string;
  /** El token recién creado (una vez). */
  token?: string;
}

const PATH = "/dashboard/automatizaciones/conector";

/** Las herramientas que esta versión ofrece: las de lectura. */
const AVAILABLE_SCOPES = Object.entries(AGENT_SCOPES).filter(([, s]) => !s.write).map(([k]) => k);

async function requireManager(orgId: string): Promise<{ userId: string } | null> {
  if (!orgId) return null;
  const sb = await createServerSupabase();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) redirect("/login");
  if (!(await hasOrgPermission(orgId, "automations.manage"))) return null;
  return { userId: user.id };
}

/**
 * «Crear token». Valida que las tiendas sean de la organización y que quien lo
 * crea las vea (el token nunca ve más que su creador), y que los permisos sean
 * de los que existen hoy (solo lectura).
 */
export async function createAgentToken(_prev: AgentTokenFormState, formData: FormData): Promise<AgentTokenFormState> {
  const orgId = String(formData.get("org_id") ?? "");
  const ctx = await requireManager(orgId);
  if (!ctx) return { error: "Sin permiso." };
  const label = String(formData.get("label") ?? "").trim().replace(/\s+/g, " ");
  if (!label || label.length > 80) return { error: "Ponle un nombre de 1 a 80 caracteres (por ejemplo «Grok Bot · atención»)." };
  const storeIds = [...new Set(formData.getAll("store_ids").map(String))];
  const scopes = [...new Set(formData.getAll("scopes").map(String))];
  if (!storeIds.length) return { error: "Elige al menos una tienda." };
  if (!scopes.length) return { error: "Elige al menos una herramienta." };
  if (!scopes.every((s) => isAgentScope(s) && AVAILABLE_SCOPES.includes(s))) return { error: "Hay una herramienta que todavía no existe." };

  const sb = await createServerSupabase();
  // RLS: las tiendas que quien crea el token ve. Solo esas, y de esta organización.
  const { data: visible } = await sb.from("stores").select("id").eq("org_id", orgId).in("id", storeIds);
  const visibleIds = new Set(((visible ?? []) as { id: string }[]).map((s) => s.id));
  if (storeIds.some((id) => !visibleIds.has(id))) return { error: "Elegiste una tienda que no ves o que no es de esta organización." };

  const token = generateAgentToken();
  const admin = createAdminSupabase();
  const { error } = await admin.from("agent_tokens").insert({
    org_id: orgId,
    created_by: ctx.userId,
    label,
    token_hash: hashAgentToken(token),
    token_hint: agentTokenHint(token),
    store_ids: storeIds,
    scopes,
  });
  if (error) return { error: isAgentMigrationMissing(error) ? AGENT_MIGRATION_MISSING : "No se pudo guardar el token." };
  console.info(`[agent-tokens] ${JSON.stringify({ org: orgId, step: "created", by: ctx.userId, label, stores: storeIds.length, scopes })}`);
  revalidatePath(PATH);
  return {
    notice: "Token creado. Cópialo ahora y guárdalo en Grok Bot como secreto: no se vuelve a mostrar.",
    token,
  };
}

/** «Revocar»: el token deja de servir en el acto. El registro de sus llamadas queda. */
export async function revokeAgentToken(_prev: AgentTokenFormState, formData: FormData): Promise<AgentTokenFormState> {
  const orgId = String(formData.get("org_id") ?? "");
  const tokenId = String(formData.get("token_id") ?? "");
  const ctx = await requireManager(orgId);
  if (!ctx || !tokenId) return { error: "Sin permiso." };
  const admin = createAdminSupabase();
  const { data, error } = await admin
    .from("agent_tokens")
    .update({ revoked_at: new Date().toISOString(), revoked_by: ctx.userId })
    .eq("id", tokenId)
    .eq("org_id", orgId)
    .is("revoked_at", null)
    .select("id");
  if (error) return { error: isAgentMigrationMissing(error) ? AGENT_MIGRATION_MISSING : "No se pudo revocar el token." };
  if (!(data ?? []).length) return { error: "Ese token ya estaba revocado o no existe." };
  console.info(`[agent-tokens] ${JSON.stringify({ org: orgId, step: "revoked", token: tokenId, by: ctx.userId })}`);
  revalidatePath(PATH);
  return { notice: "Token revocado: desde ahora Kapta lo rechaza." };
}
