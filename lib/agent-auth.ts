// El token de un agente de IA (Grok Bot) para el conector MCP de Kapta (MOM §42,
// 08-11-2026; db/migrations/0314_agent_tokens.sql).
//
// QUÉ DECIDE ESTE ARCHIVO. Quién llama, qué tiendas ve y qué herramientas puede
// usar. La respuesta sale de tres cosas, y gana la más estrecha:
//   1. el token: activo (ni revocado ni vencido), con sus `store_ids` y `scopes`;
//   2. quien lo creó (`created_by`): el token ve SOLO las tiendas que esa persona
//      ve hoy (la misma regla que `auth_store_ids()` en la base: las de
//      `user_store_access` más todas las de la organización si es owner/admin).
//      Si deja de ver una tienda o sale de la organización, el token también;
//   3. la organización del token: nunca se cruza a otra.
//
// EL TOKEN NO SE GUARDA. Se genera una vez (`kagt_` + 32 bytes al azar en
// base64url), se muestra una vez y se guarda solo su sha256, como el secreto del
// bot de Kapso (lib/bot-orders.ts). Buscarlo por su hash no filtra nada: quien no
// tiene el token no tiene su hash.

import { randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { bearerToken, hashBotSecret } from "@/lib/bot-orders";
import { roleSeesAllStores } from "@/lib/permissions";

export const AGENT_TOKEN_PREFIX = "kagt_";

/** Llamadas por minuto por token. Una conversación normal hace unas pocas. */
export const AGENT_RATE_PER_MINUTE = 60;

/**
 * Lo que un token puede hacer. Las de lectura son de la parte 1; las de
 * escritura, de la parte 3 (MOM §42.9, 0323): cada una con su herramienta
 * (`agregar_nota`, `enviar_whatsapp`, `crear_guia_aliclik`) y sus frenos.
 */
export const AGENT_SCOPES = {
  "pedidos.leer": { label: "Buscar y ver pedidos", write: false },
  "conversaciones.leer": { label: "Leer la conversación de WhatsApp", write: false },
  "politicas.leer": { label: "Consultar políticas de la tienda (calculadas y escritas)", write: false },
  "pedidos.nota": { label: "Dejar notas en el pedido", write: true },
  "whatsapp.enviar": { label: "Enviar WhatsApp al cliente", write: true },
  "aliclik.crear_guia": { label: "Crear guías de Aliclik", write: true },
} as const;

export type AgentScope = keyof typeof AGENT_SCOPES;

export function isAgentScope(value: unknown): value is AgentScope {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(AGENT_SCOPES, value);
}

/** Un token nuevo: `kagt_` + 32 bytes al azar en base64url. */
export function generateAgentToken(): string {
  return `${AGENT_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
}

/** Los primeros caracteres, para reconocerlo en la lista («kagt_AbCd»). PURA. */
export function agentTokenHint(token: string): string {
  return token.slice(0, AGENT_TOKEN_PREFIX.length + 4);
}

/** sha256 hexadecimal: lo único que se guarda (`agent_tokens.token_hash`). */
export const hashAgentToken = hashBotSecret;

export interface AgentStore {
  id: string;
  name: string;
}

/** Quién llama, ya resuelto. */
export interface AgentContext {
  tokenId: string;
  orgId: string;
  userId: string;
  label: string;
  scopes: ReadonlySet<AgentScope>;
  /** Las tiendas que el token ve HOY: las suyas ∩ las de quien lo creó. */
  stores: AgentStore[];
}

export type AgentAuthOutcome =
  | { ok: true; ctx: AgentContext }
  | { ok: false; status: 401 | 403 | 503; code: string; message: string };

export const AGENT_MIGRATION_MISSING = "Falta aplicar la migración 0314 (conector de IA) en la base.";

/** «No existe» de Postgres (42P01) y de PostgREST (PGRST205), solo para estas tablas. */
export function isAgentMigrationMissing(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const e = error as { code?: unknown; message?: unknown; details?: unknown; hint?: unknown };
  if (e.code !== "42P01" && e.code !== "PGRST205") return false;
  return [e.message, e.details, e.hint].some((t) => typeof t === "string" && /\bagent_(?:tokens|tool_calls)\b/.test(t));
}

interface TokenRow {
  id: string;
  org_id: string;
  created_by: string;
  label: string;
  store_ids: string[] | null;
  scopes: string[] | null;
  expires_at: string | null;
  revoked_at: string | null;
}

/**
 * Las tiendas que el token ve: las del token que quien lo creó ve hoy, dentro de
 * la organización del token. Owner/admin ve todas las de la organización; los
 * demás, las de `user_store_access`. PURA.
 */
export function agentVisibleStoreIds(args: {
  tokenStoreIds: readonly string[];
  orgStoreIds: readonly string[];
  creatorRole: string | null;
  creatorGrantedStoreIds: readonly string[];
}): string[] {
  if (!args.creatorRole) return [];
  const org = new Set(args.orgStoreIds);
  const creator = roleSeesAllStores(args.creatorRole)
    ? org
    : new Set(args.creatorGrantedStoreIds.filter((id) => org.has(id)));
  return [...new Set(args.tokenStoreIds)].filter((id) => org.has(id) && creator.has(id));
}

const DENIED: AgentAuthOutcome = { ok: false, status: 401, code: "no_autorizado", message: "No autorizado." };

/**
 * La puerta de `/api/mcp`. Sin token, con uno que no existe, revocado o
 * vencido: 401 «No autorizado.», sin decir cuál. Un token válido cuyo creador ya
 * no ve ninguna de sus tiendas: 403, para que quien lo configuró sepa que hay que
 * crear otro.
 */
export async function authenticateAgent(
  admin: SupabaseClient,
  authorization: string | null | undefined,
  now: Date = new Date(),
): Promise<AgentAuthOutcome> {
  const token = bearerToken(authorization);
  if (!token || !token.startsWith(AGENT_TOKEN_PREFIX) || token.length > 200) return DENIED;

  const { data, error } = await admin
    .from("agent_tokens")
    .select("id, org_id, created_by, label, store_ids, scopes, expires_at, revoked_at")
    .eq("token_hash", hashAgentToken(token))
    .maybeSingle();
  if (error) {
    return isAgentMigrationMissing(error)
      ? { ok: false, status: 503, code: "migracion_pendiente", message: AGENT_MIGRATION_MISSING }
      : { ok: false, status: 503, code: "base_no_disponible", message: "No se pudo leer el token. Reintenta en unos segundos." };
  }
  const row = data as TokenRow | null;
  if (!row || row.revoked_at) return DENIED;
  if (row.expires_at && new Date(row.expires_at).getTime() <= now.getTime()) return DENIED;

  const [membership, orgStores, grants] = await Promise.all([
    admin.from("memberships").select("role").eq("org_id", row.org_id).eq("user_id", row.created_by).maybeSingle(),
    admin.from("stores").select("id, name").eq("org_id", row.org_id),
    admin.from("user_store_access").select("store_id").eq("user_id", row.created_by),
  ]);
  if (membership.error || orgStores.error || grants.error) {
    return { ok: false, status: 503, code: "base_no_disponible", message: "No se pudo leer el acceso del token. Reintenta en unos segundos." };
  }
  const storesById = new Map(((orgStores.data ?? []) as AgentStore[]).map((s) => [s.id, s]));
  const visible = agentVisibleStoreIds({
    tokenStoreIds: row.store_ids ?? [],
    orgStoreIds: [...storesById.keys()],
    creatorRole: (membership.data as { role?: string } | null)?.role ?? null,
    creatorGrantedStoreIds: ((grants.data ?? []) as { store_id: string }[]).map((g) => g.store_id),
  });
  if (!visible.length) {
    return {
      ok: false,
      status: 403,
      code: "sin_tiendas",
      message: "Quien creó este token ya no tiene acceso a sus tiendas. Crea otro en Automatizaciones › Conector de IA.",
    };
  }
  return {
    ok: true,
    ctx: {
      tokenId: row.id,
      orgId: row.org_id,
      userId: row.created_by,
      label: row.label,
      scopes: new Set((row.scopes ?? []).filter(isAgentScope)),
      stores: visible.map((id) => storesById.get(id)!),
    },
  };
}

/** Texto comparable: sin tildes, minúsculas, sin espacios repetidos. PURA. */
function comparable(text: string): string {
  return text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
}

export type StorePick = { ok: true; store: AgentStore } | { ok: false; message: string };

/**
 * La tienda que nombró el agente: por id, por nombre exacto o por una parte del
 * nombre («kenku» → «Kenku Peru»). Sin nombre, la única que ve el token si es
 * una sola. Ambigua o desconocida: un mensaje que dice cuáles hay. PURA.
 */
export function pickAgentStore(stores: readonly AgentStore[], wanted: string | null | undefined): StorePick {
  const list = stores.map((s) => s.name).join(", ");
  const w = typeof wanted === "string" ? comparable(wanted) : "";
  if (!w) {
    return stores.length === 1
      ? { ok: true, store: stores[0]! }
      : { ok: false, message: `Indica la tienda: ${list}.` };
  }
  const byId = stores.find((s) => s.id === wanted);
  if (byId) return { ok: true, store: byId };
  const exact = stores.filter((s) => comparable(s.name) === w);
  if (exact.length === 1) return { ok: true, store: exact[0]! };
  const partial = stores.filter((s) => comparable(s.name).includes(w));
  if (partial.length === 1) return { ok: true, store: partial[0]! };
  return { ok: false, message: partial.length > 1 ? `«${wanted}» coincide con varias tiendas: ${list}.` : `No conozco la tienda «${wanted}». Tiendas disponibles: ${list}.` };
}

/** ¿Pasó el tope por minuto? Si no se puede contar, se deja pasar (el registro es lo que falla, no el agente). */
export async function agentRateLimited(admin: SupabaseClient, tokenId: string, now: Date = new Date()): Promise<boolean> {
  const since = new Date(now.getTime() - 60_000).toISOString();
  const { count, error } = await admin
    .from("agent_tool_calls")
    .select("id", { count: "exact", head: true })
    .eq("token_id", tokenId)
    .gte("created_at", since);
  if (error) return false;
  return (count ?? 0) >= AGENT_RATE_PER_MINUTE;
}

/** Una línea en `agent_tool_calls` y el «último uso» del token. Nunca falla hacia el agente. */
export async function recordAgentCall(
  admin: SupabaseClient,
  call: {
    tokenId: string;
    tool: string;
    storeId?: string | null;
    orderId?: string | null;
    ok: boolean;
    errorCode?: string | null;
    durationMs: number;
  },
  now: Date = new Date(),
): Promise<void> {
  const tool = /^[a-z_]{2,40}$/.test(call.tool) ? call.tool : "desconocida";
  const errorCode = call.errorCode && /^[a-z_]{2,40}$/.test(call.errorCode) ? call.errorCode : call.ok ? null : "error";
  try {
    await Promise.all([
      admin.from("agent_tool_calls").insert({
        token_id: call.tokenId,
        tool,
        store_id: call.storeId ?? null,
        order_id: call.orderId ?? null,
        ok: call.ok,
        error_code: errorCode,
        duration_ms: Math.max(0, Math.round(call.durationMs)),
      }),
      admin.from("agent_tokens").update({ last_used_at: now.toISOString(), last_tool: tool }).eq("id", call.tokenId),
    ]);
  } catch {
    // El registro es de ayuda; una falla aquí no le cambia la respuesta al agente.
  }
}
