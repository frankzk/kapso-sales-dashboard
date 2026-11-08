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
import {
  AGENT_ACTIONS_MIGRATION_MISSING,
  AGENT_GUIDE_CAP_MAX,
  AGENT_WHATSAPP_CAP_MAX,
  isAgentActionsMigrationMissing,
  isAgentMode,
  parseAgentSettings,
} from "@/lib/agent-actions";
import {
  AGENT_GUIDE_CAP_EVENT,
  AGENT_GUIDE_MODE_EVENT,
  AGENT_WHATSAPP_CAP_EVENT,
  AGENT_WHATSAPP_MODE_EVENT,
} from "@/lib/automations-catalog";
import {
  POLICY_IMPORT_MAX_CHARS,
  POLICY_MIGRATION_MISSING,
  isPolicyMigrationMissing,
  parsePoliciesMarkdown,
  parsePolicyInput,
  samePolicyTitle,
  type ImportStore,
  type SkippedPolicy,
} from "@/lib/store-policies";

export interface AgentTokenFormState {
  error?: string;
  notice?: string;
  /** El token recién creado (una vez). */
  token?: string;
}

const PATH = "/dashboard/automatizaciones/conector";

/** Las herramientas que se pueden dar: todas (las de escritura desde la parte 3, MOM §42.9). */
const AVAILABLE_SCOPES = Object.keys(AGENT_SCOPES);

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
 * de los que existen.
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

/**
 * «Cambiar herramientas» de un token activo: por ejemplo, darle a la conexión
 * de Grok las de escritura sin volver a conectarlo. Lo que el token puede hacer
 * sigue limitado por los permisos de quien lo creó (MOM §42.9).
 */
export async function updateAgentTokenScopes(_prev: AgentTokenFormState, formData: FormData): Promise<AgentTokenFormState> {
  const orgId = String(formData.get("org_id") ?? "");
  const tokenId = String(formData.get("token_id") ?? "");
  const ctx = await requireManager(orgId);
  if (!ctx || !tokenId) return { error: "Sin permiso." };
  const scopes = [...new Set(formData.getAll("scopes").map(String))];
  if (!scopes.length) return { error: "Elige al menos una herramienta. Para que no use ninguna, revócalo." };
  if (!scopes.every((s) => isAgentScope(s) && AVAILABLE_SCOPES.includes(s))) return { error: "Hay una herramienta que no existe." };
  const admin = createAdminSupabase();
  const { data, error } = await admin
    .from("agent_tokens")
    .update({ scopes })
    .eq("id", tokenId)
    .eq("org_id", orgId)
    .is("revoked_at", null)
    .select("id");
  if (error) return { error: isAgentMigrationMissing(error) ? AGENT_MIGRATION_MISSING : "No se pudieron guardar las herramientas." };
  if (!(data ?? []).length) return { error: "Ese token está revocado o no existe." };
  console.info(`[agent-tokens] ${JSON.stringify({ org: orgId, step: "scopes", token: tokenId, by: ctx.userId, scopes })}`);
  revalidatePath(PATH);
  return { notice: "Herramientas guardadas: valen desde la próxima llamada del agente." };
}

// ---------------------------------------------------------------------------
// Lo que el agente puede hacer (MOM §42.9, parte 3; 0323)
// ---------------------------------------------------------------------------

/**
 * El interruptor de WhatsApp y el de guías (Apagado / Simulación / Activo) y sus
 * topes del día, por organización. Cada cambio queda en «Últimos cambios» de
 * Automatizaciones, como los demás interruptores (§40).
 */
export async function saveAgentActionSettings(_prev: AgentTokenFormState, formData: FormData): Promise<AgentTokenFormState> {
  const orgId = String(formData.get("org_id") ?? "");
  const ctx = await requireManager(orgId);
  if (!ctx) return { error: "Sin permiso." };
  const whatsappMode = String(formData.get("whatsapp_mode") ?? "");
  const guideMode = String(formData.get("guide_mode") ?? "");
  if (!isAgentMode(whatsappMode) || !isAgentMode(guideMode)) return { error: "Esa posición no existe." };
  const whatsappCap = Number(formData.get("whatsapp_daily_cap"));
  const guideCap = Number(formData.get("guide_daily_cap"));
  if (!Number.isInteger(whatsappCap) || whatsappCap < 1 || whatsappCap > AGENT_WHATSAPP_CAP_MAX) {
    return { error: `El tope de WhatsApp va de 1 a ${AGENT_WHATSAPP_CAP_MAX} por día.` };
  }
  if (!Number.isInteger(guideCap) || guideCap < 1 || guideCap > AGENT_GUIDE_CAP_MAX) {
    return { error: `El tope de guías va de 1 a ${AGENT_GUIDE_CAP_MAX} por día.` };
  }
  const admin = createAdminSupabase();
  const { data: current, error: readError } = await admin.from("agent_action_settings").select("*").eq("org_id", orgId).maybeSingle();
  if (readError) return { error: isAgentActionsMigrationMissing(readError) ? AGENT_ACTIONS_MIGRATION_MISSING : "No se pudo leer la configuración." };
  const before = parseAgentSettings(current as Record<string, unknown> | null);
  const now = new Date().toISOString();
  const { error } = await admin.from("agent_action_settings").upsert(
    {
      org_id: orgId,
      whatsapp_mode: whatsappMode,
      guide_mode: guideMode,
      whatsapp_daily_cap: whatsappCap,
      guide_daily_cap: guideCap,
      updated_at: now,
      updated_by: ctx.userId,
    },
    { onConflict: "org_id" },
  );
  if (error) return { error: isAgentActionsMigrationMissing(error) ? AGENT_ACTIONS_MIGRATION_MISSING : "No se pudo guardar." };
  // Sin fila, el historial dice «Sin configurar» como valor anterior.
  const had = Boolean(current);
  const changes = [
    { automation: AGENT_WHATSAPP_MODE_EVENT, previous: had ? before.whatsappMode : null, next: whatsappMode },
    { automation: AGENT_GUIDE_MODE_EVENT, previous: had ? before.guideMode : null, next: guideMode },
    { automation: AGENT_WHATSAPP_CAP_EVENT, previous: had ? String(before.whatsappDailyCap) : null, next: String(whatsappCap) },
    { automation: AGENT_GUIDE_CAP_EVENT, previous: had ? String(before.guideDailyCap) : null, next: String(guideCap) },
  ].filter((c) => c.previous !== c.next);
  let historyNote = "";
  if (changes.length) {
    const { error: historyError } = await admin
      .from("automation_switch_events")
      .insert(changes.map((c) => ({ org_id: orgId, store_id: null, actor: ctx.userId, ...c })));
    if (historyError) historyNote = " No quedó en «Últimos cambios».";
  }
  console.info(`[agent-actions] ${JSON.stringify({ org: orgId, step: "settings", by: ctx.userId, whatsappMode, guideMode, whatsappCap, guideCap })}`);
  revalidatePath(PATH);
  revalidatePath("/dashboard/automatizaciones");
  return { notice: `Guardado.${historyNote}` };
}

// ---------------------------------------------------------------------------
// Políticas escritas por tienda (MOM §42.6, parte 2; 0315)
// ---------------------------------------------------------------------------

export interface PolicyFormState {
  error?: string;
  notice?: string;
  /** La política recién guardada (para cerrar el formulario). */
  savedId?: string;
}

/** ¿La persona ve esta tienda, y es de esta organización? Por RLS, como al crear un token. */
async function storeVisible(orgId: string, storeId: string): Promise<boolean> {
  if (!storeId) return false;
  const sb = await createServerSupabase();
  const { data } = await sb.from("stores").select("id").eq("org_id", orgId).eq("id", storeId).maybeSingle();
  return Boolean(data);
}

function policyWriteError(error: { code?: string } | null | undefined): string {
  if (isPolicyMigrationMissing(error)) return POLICY_MIGRATION_MISSING;
  if (error?.code === "23514") return "La base rechazó la política: revisa el título, el texto y las fechas.";
  return "No se pudo guardar la política.";
}

/**
 * «Guardar» una política escrita: nueva (sin `policy_id`) o la edición de una
 * que no está retirada. La versión y la hora las pone la base, que además
 * guarda cada versión en `store_policy_versions`. Guardar sin cambios no crea
 * una versión.
 */
export async function saveStorePolicy(_prev: PolicyFormState, formData: FormData): Promise<PolicyFormState> {
  const orgId = String(formData.get("org_id") ?? "");
  const ctx = await requireManager(orgId);
  if (!ctx) return { error: "Sin permiso." };
  const parsed = parsePolicyInput({
    title: formData.get("title"),
    body: formData.get("body"),
    validFrom: formData.get("valid_from"),
    validUntil: formData.get("valid_until"),
    source: formData.get("source"),
  });
  if (!parsed.ok) return { error: parsed.error };
  const v = parsed.value;
  const fields = { title: v.title, body: v.body, valid_from: v.validFrom, valid_until: v.validUntil, source: v.source };
  const admin = createAdminSupabase();
  const policyId = String(formData.get("policy_id") ?? "");

  if (policyId) {
    const { data: current, error: readError } = await admin
      .from("store_policies")
      .select("id, store_id, title, body, valid_from, valid_until, source, retired_at")
      .eq("id", policyId)
      .eq("org_id", orgId)
      .maybeSingle();
    if (readError) return { error: policyWriteError(readError) };
    const row = current as ({ store_id: string; retired_at: string | null } & typeof fields) | null;
    if (!row || row.retired_at) return { error: "Esa política ya está retirada o no existe." };
    if (!(await storeVisible(orgId, row.store_id))) return { error: "Ya no ves la tienda de esta política." };
    const same = (Object.keys(fields) as (keyof typeof fields)[]).every((k) => (row[k] ?? null) === (fields[k] ?? null));
    if (same) return { notice: "Sin cambios: la política queda como estaba.", savedId: policyId };
    const { data, error } = await admin
      .from("store_policies")
      .update({ ...fields, updated_by: ctx.userId })
      .eq("id", policyId)
      .eq("org_id", orgId)
      .is("retired_at", null)
      .select("id, version");
    if (error) return { error: policyWriteError(error) };
    const saved = ((data ?? []) as { id: string; version: number }[])[0];
    if (!saved) return { error: "Esa política ya está retirada o no existe." };
    console.info(`[store-policies] ${JSON.stringify({ org: orgId, step: "edited", policy: saved.id, version: saved.version, store: row.store_id, by: ctx.userId })}`);
    revalidatePath(PATH);
    return { notice: `Política guardada (versión ${saved.version}). El agente la lee desde ahora.`, savedId: saved.id };
  }

  const storeId = String(formData.get("store_id") ?? "");
  if (!(await storeVisible(orgId, storeId))) return { error: "Elige una tienda que veas, de esta organización." };
  const { data, error } = await admin
    .from("store_policies")
    .insert({ org_id: orgId, store_id: storeId, ...fields, created_by: ctx.userId, updated_by: ctx.userId })
    .select("id")
    .single();
  if (error) return { error: policyWriteError(error) };
  const id = (data as { id: string }).id;
  console.info(`[store-policies] ${JSON.stringify({ org: orgId, step: "created", policy: id, store: storeId, by: ctx.userId })}`);
  revalidatePath(PATH);
  return { notice: "Política creada. El agente la lee desde el día en que empieza a valer.", savedId: id };
}

/** «Retirar»: el agente deja de leerla en el acto. Es final; su historial queda. */
export async function retireStorePolicy(_prev: PolicyFormState, formData: FormData): Promise<PolicyFormState> {
  const orgId = String(formData.get("org_id") ?? "");
  const policyId = String(formData.get("policy_id") ?? "");
  const ctx = await requireManager(orgId);
  if (!ctx || !policyId) return { error: "Sin permiso." };
  const admin = createAdminSupabase();
  const { data: current, error: readError } = await admin
    .from("store_policies")
    .select("store_id")
    .eq("id", policyId)
    .eq("org_id", orgId)
    .maybeSingle();
  if (readError) return { error: policyWriteError(readError) };
  const storeId = (current as { store_id: string } | null)?.store_id;
  if (!storeId || !(await storeVisible(orgId, storeId))) return { error: "Esa política no existe o es de una tienda que ya no ves." };
  const { data, error } = await admin
    .from("store_policies")
    .update({ retired_at: new Date().toISOString(), retired_by: ctx.userId })
    .eq("id", policyId)
    .eq("org_id", orgId)
    .is("retired_at", null)
    .select("id");
  if (error) return { error: policyWriteError(error) };
  if (!(data ?? []).length) return { error: "Esa política ya estaba retirada." };
  console.info(`[store-policies] ${JSON.stringify({ org: orgId, step: "retired", policy: policyId, store: storeId, by: ctx.userId })}`);
  revalidatePath(PATH);
  return { notice: "Política retirada: el agente ya no la lee." };
}

export interface PolicyImportState {
  error?: string;
  notice?: string;
  /** Cuántas se crearon. */
  created?: number;
  /** Las que no se importaron, con su motivo (las de [CONFIRMAR], las que ya existían…). */
  skipped?: SkippedPolicy[];
}

/**
 * «Importar desde Markdown» (MOM §42.6): varias políticas de una vez, desde el
 * documento exportado o un texto pegado. El servidor vuelve a leer el Markdown
 * con el mismo `parsePoliciesMarkdown` de la vista previa, contra las tiendas
 * que la persona ve en esta organización (por RLS). Una política con el mismo
 * título que una que no está retirada en esa tienda no se importa: se edita.
 * Todas se crean en un solo `insert`, con su versión 1 en el historial.
 */
export async function importStorePolicies(_prev: PolicyImportState, formData: FormData): Promise<PolicyImportState> {
  const orgId = String(formData.get("org_id") ?? "");
  const ctx = await requireManager(orgId);
  if (!ctx) return { error: "Sin permiso." };
  const markdown = String(formData.get("markdown") ?? "");
  if (!markdown.trim()) return { error: "Sube el archivo .md o pega el texto." };
  if (markdown.length > POLICY_IMPORT_MAX_CHARS) return { error: "El archivo es demasiado grande: divídelo en dos." };
  const validFrom = String(formData.get("valid_from") ?? "");
  const fallbackStoreId = String(formData.get("store_id") ?? "") || null;

  const sb = await createServerSupabase();
  const { data: storeRows } = await sb.from("stores").select("id, name").eq("org_id", orgId);
  const stores = (storeRows ?? []) as ImportStore[];
  if (!stores.length) return { error: "No ves ninguna tienda de esta organización." };
  const { policies, skipped } = parsePoliciesMarkdown(markdown, stores, fallbackStoreId, validFrom);
  if (!policies.length) {
    return { error: "No hay ninguna política lista para importar.", skipped };
  }

  const admin = createAdminSupabase();
  const { data: existing, error: readError } = await admin
    .from("store_policies")
    .select("store_id, title")
    .eq("org_id", orgId)
    .in("store_id", [...new Set(policies.map((p) => p.storeId))])
    .is("retired_at", null);
  if (readError) return { error: policyWriteError(readError) };
  const current = (existing ?? []) as { store_id: string; title: string }[];
  const fresh = policies.filter((p) => {
    const taken = current.some((c) => c.store_id === p.storeId && samePolicyTitle(c.title, p.title));
    if (taken) skipped.push({ storeName: p.storeName, title: p.title, reason: "Ya hay una con ese título en la tienda: edítala en la lista." });
    return !taken;
  });
  if (!fresh.length) return { error: "Todas las políticas del archivo ya existen en sus tiendas.", skipped };

  const { error } = await admin.from("store_policies").insert(
    fresh.map((p) => ({
      org_id: orgId,
      store_id: p.storeId,
      title: p.input.title,
      body: p.input.body,
      valid_from: p.input.validFrom,
      valid_until: p.input.validUntil,
      source: p.input.source,
      created_by: ctx.userId,
      updated_by: ctx.userId,
    })),
  );
  if (error) return { error: policyWriteError(error), skipped };
  console.info(
    `[store-policies] ${JSON.stringify({ org: orgId, step: "imported", created: fresh.length, skipped: skipped.length, stores: [...new Set(fresh.map((p) => p.storeId))], by: ctx.userId })}`,
  );
  revalidatePath(PATH);
  const byStore = [...new Set(fresh.map((p) => p.storeName))].map((name) => `${name}: ${fresh.filter((p) => p.storeName === name).length}`).join(", ");
  return {
    notice: `Se crearon ${fresh.length} política(s) (${byStore}).${skipped.length ? ` Se saltaron ${skipped.length}: abajo, cada una con su motivo.` : ""}`,
    created: fresh.length,
    skipped,
  };
}
