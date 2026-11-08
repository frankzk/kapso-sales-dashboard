// `POST /api/oauth/register`: registro dinámico de un agente (RFC 7591, MOM
// §42.8). Es público por norma y no da acceso a nada: guarda el nombre y las
// redirect_uri del cliente y le da un `client_id` sin secreto. El acceso lo da
// una persona en `/oauth/authorize`. Tope: 30 registros nuevos por hora entre
// todos.

import { NextRequest, NextResponse } from "next/server";
import { createAdminSupabase } from "@/lib/db";
import { readBodyCapped } from "@/lib/bot-orders";
import {
  OAUTH_HEADERS,
  OAUTH_MIGRATION_MISSING,
  OAUTH_REGISTRATIONS_PER_HOUR,
  generateClientId,
  isOAuthMigrationMissing,
  oauthError,
  parseRegistration,
} from "@/lib/agent-oauth";

export const dynamic = "force-dynamic";

const MAX_BODY = 16_384;

function reply(body: unknown, status: number) {
  return NextResponse.json(body, { status, headers: OAUTH_HEADERS });
}

export async function POST(req: NextRequest) {
  const text = await readBodyCapped(req.body, MAX_BODY);
  if (text === null) return reply(oauthError("invalid_client_metadata", "El cuerpo es demasiado grande."), 413);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return reply(oauthError("invalid_client_metadata", "El cuerpo no es JSON."), 400);
  }
  const parsed = parseRegistration(body);
  if (!parsed.ok) return reply(oauthError(parsed.error, parsed.description), 400);

  const admin = createAdminSupabase();
  const since = new Date(Date.now() - 3600_000).toISOString();
  const recent = await admin.from("agent_oauth_clients").select("client_id", { count: "exact", head: true }).gte("created_at", since);
  if (recent.error) {
    return reply(oauthError("temporarily_unavailable", isOAuthMigrationMissing(recent.error) ? OAUTH_MIGRATION_MISSING : "No se pudo registrar ahora."), 503);
  }
  if ((recent.count ?? 0) >= OAUTH_REGISTRATIONS_PER_HOUR) {
    return reply(oauthError("temporarily_unavailable", "Demasiados registros en la última hora. Reintenta más tarde."), 429);
  }
  const clientId = generateClientId();
  const createdAt = new Date();
  const { error } = await admin.from("agent_oauth_clients").insert({
    client_id: clientId,
    client_name: parsed.clientName,
    redirect_uris: parsed.redirectUris,
    created_at: createdAt.toISOString(),
  });
  if (error) {
    return reply(oauthError("temporarily_unavailable", isOAuthMigrationMissing(error) ? OAUTH_MIGRATION_MISSING : "No se pudo registrar ahora."), 503);
  }
  console.info(`[agent-oauth] ${JSON.stringify({ step: "registered", client: clientId, name: parsed.clientName, redirect_hosts: parsed.redirectUris.map((u) => new URL(u).host) })}`);
  return reply(
    {
      client_id: clientId,
      client_id_issued_at: Math.floor(createdAt.getTime() / 1000),
      client_name: parsed.clientName,
      redirect_uris: parsed.redirectUris,
      grant_types: ["authorization_code"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    },
    201,
  );
}

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: OAUTH_HEADERS });
}
