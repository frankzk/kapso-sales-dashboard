"use server";

// «Permitir» y «Cancelar» de `/oauth/authorize` (MOM §42.8). Todo se vuelve a
// validar aquí, con lo que manda el formulario: el cliente, la redirect_uri
// registrada, el desafío PKCE, que quien aprueba tenga `automations.manage` en
// la organización de las tiendas elegidas y que las vea. Recién entonces se
// crea el código (10 minutos, un solo uso, se guarda su sha256) y se vuelve al
// agente.

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { createAdminSupabase, createServerSupabase } from "@/lib/db";
import { hasOrgPermission } from "@/lib/permissions-access";
import {
  OAUTH_CODE_TTL_MS,
  OAUTH_MIGRATION_MISSING,
  OAUTH_SCOPES,
  clientRedirect,
  generateAuthCode,
  hashAuthCode,
  isOAuthMigrationMissing,
  parseAuthorizeRequest,
} from "@/lib/agent-oauth";
import type { AgentScope } from "@/lib/agent-auth";

export interface ConsentState {
  error?: string;
}

const PARAMS = ["response_type", "client_id", "redirect_uri", "code_challenge", "code_challenge_method", "state", "scope", "resource"] as const;

async function requestOrigin(): Promise<string> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  return `${proto}://${host}`;
}

/** El pedido del agente, otra vez desde cero, con lo que trae el formulario. */
async function reparse(formData: FormData) {
  const params: Record<string, string | undefined> = {};
  for (const k of PARAMS) {
    const v = formData.get(k);
    if (typeof v === "string" && v) params[k] = v;
  }
  const admin = createAdminSupabase();
  const { data, error } = await admin
    .from("agent_oauth_clients")
    .select("client_id, client_name, redirect_uris")
    .eq("client_id", params.client_id ?? "")
    .maybeSingle();
  if (error) return { admin, parsed: { ok: false as const, fatal: true as const, message: isOAuthMigrationMissing(error) ? OAUTH_MIGRATION_MISSING : "No se pudo leer el agente." } };
  const client = data as { client_name: string; redirect_uris: string[] } | null;
  return { admin, parsed: parseAuthorizeRequest(params, client?.redirect_uris ?? null, await requestOrigin()) };
}

export async function approveAgentAuthorization(_prev: ConsentState, formData: FormData): Promise<ConsentState> {
  const { admin, parsed } = await reparse(formData);
  if (!parsed.ok) {
    if (parsed.fatal) return { error: parsed.message };
    redirect(clientRedirect(parsed.redirectUri, { error: parsed.error, error_description: parsed.description, state: parsed.state }));
  }
  const request = parsed.request;

  const sb = await createServerSupabase();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) redirect("/login");

  const storeIds = [...new Set(formData.getAll("store_ids").map(String))];
  if (!storeIds.length) return { error: "Elige al menos una tienda." };
  // RLS: solo las tiendas que la persona ve.
  const { data: storeRows } = await sb.from("stores").select("id, org_id").in("id", storeIds);
  const stores = (storeRows ?? []) as { id: string; org_id: string }[];
  if (stores.length !== storeIds.length) return { error: "Elegiste una tienda que no ves." };
  const orgIds = [...new Set(stores.map((s) => s.org_id))];
  if (orgIds.length !== 1) return { error: "Elige tiendas de una sola organización." };
  const orgId = orgIds[0]!;
  if (!(await hasOrgPermission(orgId, "automations.manage"))) {
    return { error: "Conectar agentes de IA es del dueño, o de quien él autorice en Equipo («Automatizaciones»)." };
  }

  const scopes = [...new Set(formData.getAll("scopes").map(String))];
  if (!scopes.length) return { error: "Elige al menos una herramienta." };
  if (!scopes.every((s) => (OAUTH_SCOPES as string[]).includes(s))) return { error: "Hay una herramienta que no existe." };
  const label = String(formData.get("label") ?? "").replace(/\s+/g, " ").trim();
  if (!label || label.length > 80) return { error: "Ponle un nombre de 1 a 80 caracteres." };

  const code = generateAuthCode();
  const now = Date.now();
  const { error } = await admin.from("agent_oauth_codes").insert({
    code_hash: hashAuthCode(code),
    client_id: request.clientId,
    redirect_uri: request.redirectUri,
    code_challenge: request.codeChallenge,
    user_id: user.id,
    org_id: orgId,
    store_ids: storeIds,
    scopes: scopes as AgentScope[],
    label,
    created_at: new Date(now).toISOString(),
    expires_at: new Date(now + OAUTH_CODE_TTL_MS).toISOString(),
  });
  if (error) return { error: isOAuthMigrationMissing(error) ? OAUTH_MIGRATION_MISSING : "No se pudo autorizar. Reintenta." };
  console.info(`[agent-oauth] ${JSON.stringify({ step: "approved", org: orgId, client: request.clientId, by: user.id, stores: storeIds.length, scopes })}`);
  redirect(clientRedirect(request.redirectUri, { code, state: request.state }));
}

export async function denyAgentAuthorization(_prev: ConsentState, formData: FormData): Promise<ConsentState> {
  const { parsed } = await reparse(formData);
  if (!parsed.ok && parsed.fatal) return { error: parsed.message };
  const redirectUri = parsed.ok ? parsed.request.redirectUri : parsed.redirectUri;
  const state = parsed.ok ? parsed.request.state : parsed.state;
  redirect(clientRedirect(redirectUri, { error: "access_denied", error_description: "La persona no dio permiso.", state }));
}
