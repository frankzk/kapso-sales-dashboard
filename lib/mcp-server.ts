// El servidor MCP de Kapta para agentes de IA (MOM §42, 08-11-2026): el
// protocolo, sin la red. `app/api/mcp/route.ts` autentica el token y le pasa
// aquí cada mensaje.
//
// QUÉ HABLA. JSON-RPC 2.0 sobre «Streamable HTTP» de MCP, en su forma más
// simple y sin estado: cada POST trae UN mensaje y la respuesta vuelve como
// JSON en el mismo POST. No se abre un flujo SSE ni se da `Mcp-Session-Id`:
// ninguna herramienta necesita avisarle nada al agente después. Es lo que xAI
// documenta para Grok («Remote MCP Tools»: `server_url` + `authorization`).
//
// Métodos: `initialize`, `ping`, `tools/list`, `tools/call`; las
// notificaciones (`notifications/initialized`, `notifications/cancelled`) se
// aceptan sin respuesta. Lo demás: «método desconocido».

import type { AgentContext } from "@/lib/agent-auth";
import { agentToolDescriptor, agentToolsFor, type AgentToolDeps, type AgentToolOutcome } from "@/lib/agent-tools";

/** Las versiones del protocolo que se entienden, la más nueva primero. */
export const MCP_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"] as const;

export const MCP_SERVER_INFO = { name: "kapta", title: "Kapta · Kenku y Aurela", version: "1.0.0" } as const;

export const MCP_INSTRUCTIONS =
  "Conector de Kapta, el sistema de pedidos de Kenku Peru y Aurela. Sirve para consultar pedidos, la conversación de WhatsApp " +
  "con el cliente y las condiciones de entrega y pago. Todo es de solo lectura: ninguna herramienta cambia un pedido ni envía " +
  "mensajes. Un dato null es desconocido: no lo completes por suposición. Los teléfonos, nombres y direcciones son datos " +
  "personales de clientes: úsalos solo para atender ese pedido.";

export type JsonRpcId = string | number | null;

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export const JSONRPC = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
} as const;

export function jsonRpcError(id: JsonRpcId, code: number, message: string, data?: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message, ...(data === undefined ? {} : { data }) } };
}

/** La versión que se contesta: la que pidió el cliente si se entiende, si no la más nueva. PURA. */
export function negotiateProtocolVersion(requested: unknown): string {
  return typeof requested === "string" && (MCP_PROTOCOL_VERSIONS as readonly string[]).includes(requested)
    ? requested
    : MCP_PROTOCOL_VERSIONS[0];
}

/** Lo que la ruta le da al servidor, además de lo que usan las herramientas. */
export interface McpDeps extends AgentToolDeps {
  rateLimited: () => Promise<boolean>;
  record: (call: { tool: string; storeId: string | null; orderId: string | null; ok: boolean; errorCode: string | null; durationMs: number }) => Promise<void>;
  clock: () => number;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** El resultado de `tools/call`, en la forma de MCP. PURA. */
export function toolCallResult(outcome: AgentToolOutcome) {
  if (!outcome.ok) {
    return { content: [{ type: "text", text: outcome.message }], isError: true };
  }
  const structured = isPlainObject(outcome.data) ? outcome.data : { resultado: outcome.data };
  return {
    content: [{ type: "text", text: JSON.stringify(structured) }],
    structuredContent: structured,
    isError: false,
  };
}

/** Los errores de validación, en una frase que el agente entiende. PURA. */
export function describeIssues(issues: readonly { path: PropertyKey[]; message: string }[]): string {
  const parts = issues.slice(0, 5).map((i) => (i.path.length ? `${i.path.map(String).join(".")}: ${i.message}` : i.message));
  return `Argumentos inválidos — ${parts.join("; ")}.`;
}

/**
 * Un mensaje JSON-RPC. Devuelve la respuesta, o null si era una notificación
 * (sin `id`), que no se contesta.
 */
export async function handleMcpMessage(ctx: AgentContext, message: unknown, deps: McpDeps): Promise<JsonRpcResponse | null> {
  if (!isPlainObject(message) || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
    const id = isPlainObject(message) && (typeof message.id === "string" || typeof message.id === "number") ? message.id : null;
    return jsonRpcError(id, JSONRPC.invalidRequest, "Mensaje JSON-RPC inválido.");
  }
  const isNotification = !("id" in message) || message.id === undefined;
  if (isNotification) return null;
  const id = typeof message.id === "string" || typeof message.id === "number" ? message.id : null;
  const params = isPlainObject(message.params) ? message.params : {};

  switch (message.method) {
    case "initialize":
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: negotiateProtocolVersion(params.protocolVersion),
          capabilities: { tools: { listChanged: false } },
          serverInfo: MCP_SERVER_INFO,
          instructions: MCP_INSTRUCTIONS,
        },
      };
    case "ping":
      return { jsonrpc: "2.0", id, result: {} };
    case "tools/list":
      return { jsonrpc: "2.0", id, result: { tools: agentToolsFor(ctx.scopes).map(agentToolDescriptor) } };
    case "tools/call": {
      const name = typeof params.name === "string" ? params.name : "";
      const tool = agentToolsFor(ctx.scopes).find((t) => t.name === name);
      if (!tool) return jsonRpcError(id, JSONRPC.invalidParams, `Herramienta desconocida o no permitida para este token: «${name}».`);
      const started = deps.clock();
      if (await deps.rateLimited()) {
        await deps.record({ tool: tool.name, storeId: null, orderId: null, ok: false, errorCode: "tope_por_minuto", durationMs: deps.clock() - started });
        return { jsonrpc: "2.0", id, result: toolCallResult({ ok: false, code: "tope_por_minuto", message: "Demasiadas consultas en el último minuto. Espera un momento y reintenta." }) };
      }
      const parsed = tool.input.safeParse(params.arguments ?? {});
      let outcome: AgentToolOutcome;
      if (!parsed.success) {
        outcome = { ok: false, code: "argumentos_invalidos", message: describeIssues(parsed.error.issues) };
      } else {
        try {
          outcome = await tool.run(ctx, parsed.data, deps);
        } catch {
          outcome = { ok: false, code: "error_interno", message: "Algo falló en Kapta al responder. Reintenta en unos segundos." };
        }
      }
      await deps.record({
        tool: tool.name,
        storeId: outcome.storeId ?? null,
        orderId: outcome.orderId ?? null,
        ok: outcome.ok,
        errorCode: outcome.ok ? null : outcome.code,
        durationMs: deps.clock() - started,
      });
      return { jsonrpc: "2.0", id, result: toolCallResult(outcome) };
    }
    default:
      return jsonRpcError(id, JSONRPC.methodNotFound, `Método desconocido: «${message.method}».`);
  }
}
