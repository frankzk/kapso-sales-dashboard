// `POST /api/mcp`: el servidor MCP de Kapta para agentes de IA (Grok Bot), MOM
// §42. El protocolo vive en lib/mcp-server.ts; aquí la red: el token, el tope
// del cuerpo, el JSON y las cabeceras.
//
// El token va en `Authorization: Bearer kagt_…` (se crea en Automatizaciones ›
// Conector de IA). Sin él o con uno que no sirve: 401 antes de leer el cuerpo.
// GET y DELETE contestan 405: no hay flujo SSE ni sesiones que cerrar.

import { NextRequest, NextResponse } from "next/server";
import { createAdminSupabase } from "@/lib/db";
import { readBodyCapped } from "@/lib/bot-orders";
import { agentRateLimited, authenticateAgent, recordAgentCall } from "@/lib/agent-auth";
import { handleMcpMessage, jsonRpcError, JSONRPC, type JsonRpcResponse } from "@/lib/mcp-server";
import { getStoreCreds } from "@/lib/ingest";
import { protectedResourceMetadataUrl } from "@/lib/agent-oauth";
import { fetchConversationTranscript, findConversationIdByPhone } from "@/lib/kapso";
import { fetchChatbyConversation } from "@/lib/chatby-api";
import { env } from "@/lib/env";
import { agentActionsFor } from "@/lib/agent-actions-server";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Un mensaje MCP es chico; lo que pase de 64 KB no es una consulta. */
const MCP_MAX_BODY_BYTES = 65_536;

function respond(body: JsonRpcResponse | null, status: number, extra: Record<string, string> = {}): NextResponse {
  const headers = { "cache-control": "no-store", ...extra };
  return body === null
    ? new NextResponse(null, { status, headers })
    : NextResponse.json(body, { status, headers });
}

/**
 * Un navegador que llama desde otra página trae `Origin`; los agentes no. Se
 * acepta solo el propio origen, para que una página ajena no use un token que
 * alguien tenga guardado (recomendación de MCP contra el «DNS rebinding»).
 */
function originAllowed(req: NextRequest): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return true;
  try {
    return new URL(origin).host === req.nextUrl.host;
  } catch {
    return false;
  }
}

export async function POST(req: NextRequest) {
  if (!originAllowed(req)) return respond(jsonRpcError(null, JSONRPC.invalidRequest, "Origen no permitido."), 403);
  const admin = createAdminSupabase();
  const auth = await authenticateAgent(admin, req.headers.get("authorization"));
  if (!auth.ok) {
    return respond(
      jsonRpcError(null, JSONRPC.invalidRequest, auth.message),
      auth.status,
      // MCP (2025-06-18): el 401 dice dónde están los metadatos OAuth, para que
      // el agente pida permiso por su cuenta (MOM §42.8).
      auth.status === 401
        ? { "www-authenticate": `Bearer realm="kapta", resource_metadata="${protectedResourceMetadataUrl(req.nextUrl.origin)}"` }
        : {},
    );
  }
  const text = await readBodyCapped(req.body, MCP_MAX_BODY_BYTES);
  if (text === null) return respond(jsonRpcError(null, JSONRPC.invalidRequest, "El mensaje es demasiado grande."), 413);
  let message: unknown;
  try {
    message = JSON.parse(text);
  } catch {
    return respond(jsonRpcError(null, JSONRPC.parseError, "El cuerpo no es JSON."), 400);
  }
  if (Array.isArray(message)) {
    return respond(jsonRpcError(null, JSONRPC.invalidRequest, "Se acepta un mensaje por llamada, no lotes."), 400);
  }
  const ctx = auth.ctx;
  const response = await handleMcpMessage(ctx, message, {
    admin,
    now: new Date(),
    clock: () => Date.now(),
    kapsoKey: async (storeId) => (await getStoreCreds(storeId, admin))?.kapso_api_key ?? null,
    transcript: fetchConversationTranscript,
    conversationByPhone: findConversationIdByPhone,
    chatby: (phone) => fetchChatbyConversation({ phone, apiKey: env.chatbyApiKey() }),
    // Las de escritura (MOM §42.9): solo las usa un token con esos permisos.
    actions: agentActionsFor(admin),
    rateLimited: () => agentRateLimited(admin, ctx.tokenId),
    record: (call) => recordAgentCall(admin, { tokenId: ctx.tokenId, ...call }),
  });
  // Una notificación no lleva respuesta: 202 sin cuerpo, como pide MCP.
  return response === null ? respond(null, 202) : respond(response, 200);
}

function notAllowed() {
  return new NextResponse(null, { status: 405, headers: { allow: "POST", "cache-control": "no-store" } });
}

export const GET = notAllowed;
export const DELETE = notAllowed;
