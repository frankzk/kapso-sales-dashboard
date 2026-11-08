// `POST /api/oauth/token`: canjear el código de `/oauth/authorize` por un token
// del conector (RFC 6749 §4.1.3 con PKCE S256, MOM §42.8). El token es uno de
// `agent_tokens` (0314), como el que se crea a mano: ve las tiendas y usa las
// herramientas que la persona aprobó, mientras ella las siga viendo, y se
// revoca en Automatizaciones › Conector de IA.
//
// El código es de un solo uso y se marca usado ANTES de comprobar el resto: un
// código robado sin su verificador PKCE se quema sin dar nada. Si un código ya
// usado se vuelve a presentar, se revoca el token que se dio con él (RFC 6749
// §4.1.2).

import { NextRequest, NextResponse } from "next/server";
import { createAdminSupabase } from "@/lib/db";
import { readBodyCapped } from "@/lib/bot-orders";
import { agentTokenHint, generateAgentToken, hashAgentToken } from "@/lib/agent-auth";
import {
  OAUTH_HEADERS,
  OAUTH_MIGRATION_MISSING,
  hashAuthCode,
  isOAuthMigrationMissing,
  oauthError,
  pkceMatches,
  resourceBelongsHere,
} from "@/lib/agent-oauth";

export const dynamic = "force-dynamic";

const MAX_BODY = 16_384;

function reply(body: unknown, status: number) {
  return NextResponse.json(body, { status, headers: OAUTH_HEADERS });
}

interface CodeRow {
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  user_id: string;
  org_id: string;
  store_ids: string[];
  scopes: string[];
  label: string;
  used_at: string | null;
  token_id: string | null;
}

/** El cuerpo, en form-urlencoded (lo que manda la norma) o JSON. */
function readParams(text: string, contentType: string | null): Record<string, string> {
  if (contentType?.includes("application/json")) {
    try {
      const body = JSON.parse(text) as Record<string, unknown>;
      return Object.fromEntries(Object.entries(body).filter(([, v]) => typeof v === "string")) as Record<string, string>;
    } catch {
      return {};
    }
  }
  return Object.fromEntries(new URLSearchParams(text));
}

export async function POST(req: NextRequest) {
  const text = await readBodyCapped(req.body, MAX_BODY);
  if (text === null) return reply(oauthError("invalid_request", "El cuerpo es demasiado grande."), 413);
  const p = readParams(text, req.headers.get("content-type"));
  if (p.grant_type !== "authorization_code") {
    return reply(oauthError("unsupported_grant_type", "Solo grant_type=authorization_code."), 400);
  }
  if (!p.code || !p.code_verifier || !p.client_id) {
    return reply(oauthError("invalid_request", "Faltan code, code_verifier o client_id."), 400);
  }
  if (p.resource && !resourceBelongsHere(p.resource, req.nextUrl.origin)) {
    return reply(oauthError("invalid_target", "El recurso pedido no es este servidor."), 400);
  }

  const admin = createAdminSupabase();
  const now = new Date().toISOString();
  const codeHash = hashAuthCode(p.code);
  const consumed = await admin
    .from("agent_oauth_codes")
    .update({ used_at: now })
    .eq("code_hash", codeHash)
    .is("used_at", null)
    .gt("expires_at", now)
    .select("client_id, redirect_uri, code_challenge, user_id, org_id, store_ids, scopes, label, used_at, token_id");
  if (consumed.error) {
    return reply(oauthError("temporarily_unavailable", isOAuthMigrationMissing(consumed.error) ? OAUTH_MIGRATION_MISSING : "No se pudo canjear ahora."), 503);
  }
  const row = ((consumed.data ?? []) as CodeRow[])[0];
  if (!row) {
    // ¿Ya usado? Entonces alguien lo está repitiendo: se revoca lo que se dio con él.
    const { data: used } = await admin.from("agent_oauth_codes").select("token_id, used_at").eq("code_hash", codeHash).maybeSingle();
    const prior = used as { token_id: string | null; used_at: string | null } | null;
    if (prior?.used_at && prior.token_id) {
      await admin.from("agent_tokens").update({ revoked_at: now }).eq("id", prior.token_id).is("revoked_at", null);
      console.info(`[agent-oauth] ${JSON.stringify({ step: "code_replayed", token: prior.token_id })}`);
    }
    return reply(oauthError("invalid_grant", "El código no existe, venció o ya se usó."), 400);
  }
  if (row.client_id !== p.client_id) return reply(oauthError("invalid_grant", "El código es de otro cliente."), 400);
  if (p.redirect_uri !== undefined && p.redirect_uri !== row.redirect_uri) {
    return reply(oauthError("invalid_grant", "La redirect_uri no es la del código."), 400);
  }
  if (!pkceMatches(p.code_verifier, row.code_challenge)) {
    return reply(oauthError("invalid_grant", "El code_verifier no corresponde al desafío PKCE."), 400);
  }

  const token = generateAgentToken();
  const { data: created, error } = await admin
    .from("agent_tokens")
    .insert({
      org_id: row.org_id,
      created_by: row.user_id,
      label: row.label,
      token_hash: hashAgentToken(token),
      token_hint: agentTokenHint(token),
      store_ids: row.store_ids,
      scopes: row.scopes,
      oauth_client_id: row.client_id,
    })
    .select("id")
    .single();
  if (error || !created) return reply(oauthError("server_error", "No se pudo crear el token."), 500);
  const tokenId = (created as { id: string }).id;
  await Promise.all([
    admin.from("agent_oauth_codes").update({ token_id: tokenId }).eq("code_hash", codeHash),
    admin.from("agent_oauth_clients").update({ last_used_at: now }).eq("client_id", row.client_id),
  ]);
  console.info(`[agent-oauth] ${JSON.stringify({ step: "token_issued", org: row.org_id, client: row.client_id, token: tokenId, by: row.user_id, stores: row.store_ids.length, scopes: row.scopes })}`);
  return reply({ access_token: token, token_type: "Bearer", scope: row.scopes.join(" ") }, 200);
}

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: OAUTH_HEADERS });
}
