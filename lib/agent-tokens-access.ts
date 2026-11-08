// Lo que lee la pantalla Automatizaciones › Conector de IA (MOM §42): las
// organizaciones donde la persona tiene `automations.manage`, sus tiendas
// visibles y los tokens del conector, sin su hash.

import { createAdminSupabase, createServerSupabase } from "@/lib/db";
import { orgsWithPermission } from "@/lib/permissions-access";
import { isAgentMigrationMissing } from "@/lib/agent-auth";
import { env } from "@/lib/env";
import { resolveAgentNames } from "@/lib/agent-names";
import { limaDayOf } from "@/lib/agent-tools";
import { isPolicyMigrationMissing, policyStatus, type PolicyStatus } from "@/lib/store-policies";

export interface AgentTokenView {
  id: string;
  label: string;
  hint: string;
  storeNames: string[];
  scopes: string[];
  createdAt: string;
  revokedAt: string | null;
  lastUsedAt: string | null;
  lastTool: string | null;
  callsToday: number;
}

/** Una política escrita, como la ve la pantalla (MOM §42.6). */
export interface StorePolicyView {
  id: string;
  storeId: string;
  title: string;
  body: string;
  validFrom: string;
  validUntil: string | null;
  source: string | null;
  version: number;
  status: PolicyStatus;
  updatedAt: string;
  /** Quién la guardó por última vez (o la retiró). */
  editor: string;
  retiredAt: string | null;
}

export interface AgentConnectorOrg {
  id: string;
  name: string;
  stores: { id: string; name: string }[];
  tokens: AgentTokenView[];
  policies: StorePolicyView[];
}

export interface AgentConnectorData {
  denied: boolean;
  migrationMissing: boolean;
  /** Sin la 0315: los tokens funcionan; las políticas escritas, no. */
  policiesMissing: boolean;
  /** El día de Lima con que se calculó el estado de cada política. */
  today: string;
  endpointUrl: string;
  orgs: AgentConnectorOrg[];
}

/** La dirección del servidor MCP que se pega en Grok Bot. */
export function agentEndpointUrl(siteUrl: string): string {
  return `${siteUrl.replace(/\/$/, "")}/api/mcp`;
}

export async function loadAgentConnector(now: Date = new Date()): Promise<AgentConnectorData> {
  const endpointUrl = agentEndpointUrl(env.siteUrl());
  const today = limaDayOf(now);
  const empty = { policiesMissing: false, today, endpointUrl, orgs: [] };
  const memberships = await orgsWithPermission("automations.manage");
  if (!memberships.length) return { denied: true, migrationMissing: false, ...empty };
  const orgIds = [...new Set(memberships.map((m) => m.org_id))];
  const sb = await createServerSupabase();
  const admin = createAdminSupabase();
  const since = new Date(now.getTime() - 24 * 3600_000).toISOString();
  const [{ data: orgRows }, { data: storeRows }, tokens] = await Promise.all([
    admin.from("organizations").select("id, name").in("id", orgIds),
    // RLS: solo las tiendas que la persona ve, que son las que puede dar a un token.
    sb.from("stores").select("id, name, org_id").in("org_id", orgIds).order("name"),
    admin
      .from("agent_tokens")
      .select("id, org_id, label, token_hint, store_ids, scopes, created_at, revoked_at, last_used_at, last_tool")
      .in("org_id", orgIds)
      .order("created_at", { ascending: false }),
  ]);
  if (tokens.error) {
    if (isAgentMigrationMissing(tokens.error)) return { denied: false, migrationMissing: true, ...empty };
    throw new Error("No se pudieron leer los tokens del conector.");
  }
  const tokenRows = (tokens.data ?? []) as {
    id: string; org_id: string; label: string; token_hint: string; store_ids: string[]; scopes: string[];
    created_at: string; revoked_at: string | null; last_used_at: string | null; last_tool: string | null;
  }[];
  const activeIds = tokenRows.filter((t) => !t.revoked_at).map((t) => t.id);
  const counts = new Map<string, number>();
  if (activeIds.length) {
    const { data: calls } = await admin.from("agent_tool_calls").select("token_id").in("token_id", activeIds).gte("created_at", since).limit(5000);
    for (const c of (calls ?? []) as { token_id: string }[]) counts.set(c.token_id, (counts.get(c.token_id) ?? 0) + 1);
  }
  const stores = (storeRows ?? []) as { id: string; name: string; org_id: string }[];
  const storeName = new Map(stores.map((s) => [s.id, s.name]));

  // Las políticas de las tiendas que la persona ve (solo esas: se leen con
  // service_role, así que el filtro es este).
  let policiesMissing = false;
  let policyRows: {
    id: string; org_id: string; store_id: string; title: string; body: string; valid_from: string; valid_until: string | null;
    source: string | null; version: number; updated_at: string; updated_by: string; retired_at: string | null; retired_by: string | null;
  }[] = [];
  if (stores.length) {
    const { data, error } = await admin
      .from("store_policies")
      .select("id, org_id, store_id, title, body, valid_from, valid_until, source, version, updated_at, updated_by, retired_at, retired_by")
      .in("store_id", stores.map((st) => st.id))
      .order("valid_from", { ascending: false })
      .limit(500);
    if (error) {
      if (!isPolicyMigrationMissing(error)) throw new Error("No se pudieron leer las políticas escritas.");
      policiesMissing = true;
    } else {
      policyRows = (data ?? []) as typeof policyRows;
    }
  }
  const editors = await resolveAgentNames(policyRows.map((p) => p.retired_by ?? p.updated_by), admin);
  return {
    denied: false,
    migrationMissing: false,
    policiesMissing,
    today,
    endpointUrl,
    orgs: ((orgRows ?? []) as { id: string; name: string }[]).map((org) => ({
      id: org.id,
      name: org.name,
      stores: stores.filter((s) => s.org_id === org.id).map(({ id, name }) => ({ id, name })),
      tokens: tokenRows
        .filter((t) => t.org_id === org.id)
        .map((t) => ({
          id: t.id,
          label: t.label,
          hint: t.token_hint,
          storeNames: t.store_ids.map((id) => storeName.get(id) ?? "Tienda que ya no ves"),
          scopes: t.scopes,
          createdAt: t.created_at,
          revokedAt: t.revoked_at,
          lastUsedAt: t.last_used_at,
          lastTool: t.last_tool,
          callsToday: counts.get(t.id) ?? 0,
        })),
      policies: policyRows
        .filter((p) => p.org_id === org.id)
        .map((p) => ({
          id: p.id,
          storeId: p.store_id,
          title: p.title,
          body: p.body,
          validFrom: p.valid_from,
          validUntil: p.valid_until,
          source: p.source,
          version: p.version,
          status: policyStatus(p, today),
          updatedAt: p.retired_at ?? p.updated_at,
          editor: editors[p.retired_by ?? p.updated_by] ?? "Alguien del equipo",
          retiredAt: p.retired_at,
        })),
    })),
  };
}
