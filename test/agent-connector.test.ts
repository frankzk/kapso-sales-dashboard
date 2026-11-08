// El conector de Kapta para agentes de IA (MOM §42): el token
// (lib/agent-auth.ts), el protocolo MCP (lib/mcp-server.ts), las cuatro
// herramientas de lectura (lib/agent-tools.ts) y la ruta `POST /api/mcp`. Lo que
// se fija:
//   - el token ve solo las tiendas que su creador ve HOY, dentro de su
//     organización; sin token, con otro, revocado o vencido: 401 sin decir cuál;
//   - toda consulta va filtrada por las tiendas del token (la base se lee con
//     service_role, que se salta RLS);
//   - lo que el agente escribe no rompe el filtro de PostgREST;
//   - la conversación sale sin enlaces a archivos, del más antiguo al más nuevo;
//   - el registro de cada llamada, sin argumentos ni respuestas;
//   - el tope por minuto corta antes de tocar la base;
//   - JSON-RPC: un mensaje por POST, notificaciones con 202, lotes no.
// Sin red ni base real.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  AGENT_RATE_PER_MINUTE,
  AGENT_SCOPES,
  agentTokenHint,
  agentVisibleStoreIds,
  authenticateAgent,
  generateAgentToken,
  hashAgentToken,
  isAgentMigrationMissing,
  pickAgentStore,
  recordAgentCall,
  type AgentContext,
  type AgentScope,
} from "@/lib/agent-auth";
import {
  AGENT_TOOLS,
  agentCalculatedPolicies,
  agentToolDescriptor,
  agentToolsFor,
  agentTranscript,
  limaDayOf,
  phoneSearchFragment,
  sanitizeAgentQuery,
} from "@/lib/agent-tools";
import { handleMcpMessage, MCP_PROTOCOL_VERSIONS, type McpDeps } from "@/lib/mcp-server";
import type { ConversationMessage } from "@/lib/kapso";

// ---------------------------------------------------------------------------
// Una base falsa: cada consulta anota sus filtros y contesta lo que diga `reply`.
// ---------------------------------------------------------------------------

type Op = [method: string, ...args: unknown[]];
interface Query {
  table: string;
  ops: Op[];
}
interface Reply {
  data?: unknown;
  error?: unknown;
  count?: number;
}

function fakeAdmin(reply: (q: Query) => Reply = () => ({ data: [] })) {
  const queries: Query[] = [];
  const rpcs: { name: string; args: unknown }[] = [];
  const build = (table: string) => {
    const q: Query = { table, ops: [] };
    queries.push(q);
    const result = (single: boolean) => {
      const r = reply(q);
      const data = single && Array.isArray(r.data) ? (r.data[0] ?? null) : (r.data ?? (single ? null : []));
      return { data, error: r.error ?? null, count: r.count ?? null };
    };
    const builder: Record<string, unknown> = {};
    for (const m of ["select", "eq", "in", "or", "order", "limit", "not", "gte", "lte", "is", "insert", "update"]) {
      builder[m] = (...args: unknown[]) => {
        q.ops.push([m, ...args]);
        return builder;
      };
    }
    builder.maybeSingle = () => Promise.resolve(result(true));
    builder.then = (ok: (v: unknown) => unknown, ko: (e: unknown) => unknown) => Promise.resolve(result(false)).then(ok, ko);
    return builder;
  };
  const client = {
    from: (table: string) => build(table),
    rpc: (name: string, args: unknown) => {
      rpcs.push({ name, args });
      const r = reply({ table: `rpc:${name}`, ops: [["rpc", args]] });
      return Promise.resolve({ data: r.data ?? null, error: r.error ?? null });
    },
  } as unknown as SupabaseClient;
  return { client, queries, rpcs };
}

const has = (q: Query, method: string, ...args: unknown[]) =>
  q.ops.some(([m, ...a]) => m === method && JSON.stringify(a.slice(0, args.length)) === JSON.stringify(args));
const filterValue = (q: Query, method: string, column: string) => q.ops.find(([m, c]) => m === method && c === column)?.[2];

const ORG = "00000000-0000-4000-8000-0000000000aa";
const OTHER_ORG = "00000000-0000-4000-8000-0000000000bb";
const KENKU = { id: "00000000-0000-4000-8000-000000000001", name: "Kenku Peru" };
const AURELA = { id: "00000000-0000-4000-8000-000000000002", name: "Aurela" };
const CREATOR = "00000000-0000-4000-8000-0000000000c1";

function ctxWith(scopes: AgentScope[], stores = [KENKU, AURELA]): AgentContext {
  return { tokenId: "tok-1", orgId: ORG, userId: CREATOR, label: "Grok", scopes: new Set(scopes), stores };
}

const ALL_READ: AgentScope[] = ["pedidos.leer", "conversaciones.leer", "politicas.leer"];

// ---------------------------------------------------------------------------
// El token
// ---------------------------------------------------------------------------

describe("el token", () => {
  it("nace con su prefijo, al azar, y se guarda solo su sha256", () => {
    const a = generateAgentToken();
    const b = generateAgentToken();
    expect(a).toMatch(/^kagt_[A-Za-z0-9_-]{43}$/);
    expect(a).not.toBe(b);
    expect(hashAgentToken(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashAgentToken(a)).not.toContain(a.slice(5, 15));
    expect(agentTokenHint(a)).toBe(a.slice(0, 9));
    expect(agentTokenHint(a)).toMatch(/^kagt_[A-Za-z0-9_-]{4}$/);
  });

  it("ve solo las tiendas del token que su creador ve, dentro de su organización", () => {
    const org = [KENKU.id, AURELA.id];
    const outside = "00000000-0000-4000-8000-0000000000ff";
    // El owner y el admin ven toda la organización.
    expect(agentVisibleStoreIds({ tokenStoreIds: [KENKU.id, AURELA.id], orgStoreIds: org, creatorRole: "owner", creatorGrantedStoreIds: [] })).toEqual([KENKU.id, AURELA.id]);
    expect(agentVisibleStoreIds({ tokenStoreIds: [AURELA.id], orgStoreIds: org, creatorRole: "admin", creatorGrantedStoreIds: [] })).toEqual([AURELA.id]);
    // Los demás, solo las que tienen dadas.
    expect(agentVisibleStoreIds({ tokenStoreIds: [KENKU.id, AURELA.id], orgStoreIds: org, creatorRole: "vendedora", creatorGrantedStoreIds: [KENKU.id] })).toEqual([KENKU.id]);
    // Una tienda de otra organización no entra aunque el token la nombre o la persona la tenga dada.
    expect(agentVisibleStoreIds({ tokenStoreIds: [KENKU.id, outside], orgStoreIds: org, creatorRole: "owner", creatorGrantedStoreIds: [outside] })).toEqual([KENKU.id]);
    // Fuera de la organización, nada.
    expect(agentVisibleStoreIds({ tokenStoreIds: [KENKU.id], orgStoreIds: org, creatorRole: null, creatorGrantedStoreIds: [KENKU.id] })).toEqual([]);
    // Sin repetidos.
    expect(agentVisibleStoreIds({ tokenStoreIds: [KENKU.id, KENKU.id], orgStoreIds: org, creatorRole: "owner", creatorGrantedStoreIds: [] })).toEqual([KENKU.id]);
  });

  it("los permisos de escritura existen, marcados, y ninguna herramienta los usa todavía", () => {
    expect(Object.entries(AGENT_SCOPES).filter(([, s]) => s.write).map(([k]) => k)).toEqual(["pedidos.nota", "whatsapp.enviar", "aliclik.crear_guia"]);
    expect(AGENT_TOOLS.every((t) => !AGENT_SCOPES[t.scope].write)).toBe(true);
  });

  it("reconoce la migración que falta solo en sus tablas", () => {
    expect(isAgentMigrationMissing({ code: "PGRST205", message: "Could not find the table 'public.agent_tokens'" })).toBe(true);
    expect(isAgentMigrationMissing({ code: "42P01", message: 'relation "agent_tool_calls" does not exist' })).toBe(true);
    expect(isAgentMigrationMissing({ code: "42P01", message: 'relation "orders" does not exist' })).toBe(false);
    expect(isAgentMigrationMissing({ code: "23505", message: "agent_tokens" })).toBe(false);
  });
});

describe("authenticateAgent", () => {
  const token = "kagt_" + "A".repeat(43);
  const row = { id: "tok-1", org_id: ORG, created_by: CREATOR, label: "Grok", store_ids: [KENKU.id, AURELA.id], scopes: ["pedidos.leer", "inventado"], expires_at: null, revoked_at: null };
  const now = new Date("2026-11-08T15:00:00Z");

  function db(over: { token?: unknown; tokenError?: unknown; role?: string | null; grants?: string[] } = {}) {
    return fakeAdmin((q) => {
      if (q.table === "agent_tokens") return over.tokenError ? { error: over.tokenError } : { data: over.token === undefined ? [row] : over.token === null ? [] : [over.token] };
      if (q.table === "memberships") return { data: over.role === null ? [] : [{ role: over.role ?? "owner" }] };
      if (q.table === "stores") return { data: [KENKU, AURELA] };
      if (q.table === "user_store_access") return { data: (over.grants ?? []).map((store_id) => ({ store_id })) };
      return { data: [] };
    });
  }

  it("sin token, con otro prefijo o con uno que no existe: 401 sin detalles", async () => {
    const { client, queries } = db();
    expect(await authenticateAgent(client, null, now)).toMatchObject({ ok: false, status: 401, message: "No autorizado." });
    expect(await authenticateAgent(client, "Bearer sk_live_123", now)).toMatchObject({ ok: false, status: 401 });
    expect(queries).toHaveLength(0);
    const missing = db({ token: null });
    expect(await authenticateAgent(missing.client, `Bearer ${token}`, now)).toMatchObject({ ok: false, status: 401, message: "No autorizado." });
    // Se busca por el hash, nunca por el token.
    expect(filterValue(missing.queries[0]!, "eq", "token_hash")).toBe(hashAgentToken(token));
  });

  it("revocado o vencido: el mismo 401", async () => {
    const revoked = db({ token: { ...row, revoked_at: "2026-11-01T00:00:00Z" } });
    expect(await authenticateAgent(revoked.client, `Bearer ${token}`, now)).toMatchObject({ ok: false, status: 401, message: "No autorizado." });
    const expired = db({ token: { ...row, expires_at: "2026-11-08T14:59:59Z" } });
    expect(await authenticateAgent(expired.client, `Bearer ${token}`, now)).toMatchObject({ ok: false, status: 401, message: "No autorizado." });
  });

  it("sin la 0314: 503 que lo dice", async () => {
    const { client } = db({ tokenError: { code: "PGRST205", message: "Could not find the table 'public.agent_tokens'" } });
    expect(await authenticateAgent(client, `Bearer ${token}`, now)).toMatchObject({ ok: false, status: 503, code: "migracion_pendiente" });
  });

  it("si su creador ya no ve ninguna de sus tiendas: 403 sin_tiendas", async () => {
    const left = db({ role: null });
    expect(await authenticateAgent(left.client, `Bearer ${token}`, now)).toMatchObject({ ok: false, status: 403, code: "sin_tiendas" });
    const seller = db({ role: "vendedora", grants: [] });
    expect(await authenticateAgent(seller.client, `Bearer ${token}`, now)).toMatchObject({ ok: false, status: 403, code: "sin_tiendas" });
  });

  it("válido: las tiendas que hoy ve su creador y solo los permisos que existen", async () => {
    const { client } = db({ role: "vendedora", grants: [AURELA.id] });
    const out = await authenticateAgent(client, `Bearer ${token}`, now);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.ctx.stores).toEqual([AURELA]);
    expect([...out.ctx.scopes]).toEqual(["pedidos.leer"]);
    expect(out.ctx).toMatchObject({ tokenId: "tok-1", orgId: ORG, userId: CREATOR });
  });

  it("no cruza a otra organización: las tiendas se leen de la del token", async () => {
    const { client, queries } = db();
    await authenticateAgent(client, `Bearer ${token}`, now);
    const stores = queries.find((q) => q.table === "stores")!;
    expect(filterValue(stores, "eq", "org_id")).toBe(ORG);
    expect(filterValue(stores, "eq", "org_id")).not.toBe(OTHER_ORG);
    const membership = queries.find((q) => q.table === "memberships")!;
    expect(filterValue(membership, "eq", "user_id")).toBe(CREATOR);
  });
});

describe("pickAgentStore", () => {
  it("una sola tienda no hace falta nombrarla", () => {
    expect(pickAgentStore([KENKU], undefined)).toEqual({ ok: true, store: KENKU });
  });
  it("por id, por nombre o por una parte, sin tildes ni mayúsculas", () => {
    expect(pickAgentStore([KENKU, AURELA], KENKU.id)).toEqual({ ok: true, store: KENKU });
    expect(pickAgentStore([KENKU, AURELA], "kenku")).toEqual({ ok: true, store: KENKU });
    expect(pickAgentStore([KENKU, AURELA], "ÁURELA")).toEqual({ ok: true, store: AURELA });
  });
  it("con varias y sin nombre, o con una que no ve: dice cuáles hay", () => {
    expect(pickAgentStore([KENKU, AURELA], "")).toEqual({ ok: false, message: "Indica la tienda: Kenku Peru, Aurela." });
    const unknown = pickAgentStore([KENKU, AURELA], "Biru");
    expect(unknown.ok).toBe(false);
    expect(!unknown.ok && unknown.message).toContain("Tiendas disponibles: Kenku Peru, Aurela.");
  });
});

describe("recordAgentCall", () => {
  it("guarda códigos, no texto libre, y el último uso del token", async () => {
    const { client, queries } = fakeAdmin();
    await recordAgentCall(client, { tokenId: "tok-1", tool: "obtener_pedido", storeId: KENKU.id, orderId: "o1", ok: false, errorCode: "No encontré a María 987654321", durationMs: 12.6 }, new Date("2026-11-08T15:00:00Z"));
    const insert = queries.find((q) => q.table === "agent_tool_calls")!.ops.find(([m]) => m === "insert")![1];
    expect(insert).toEqual({ token_id: "tok-1", tool: "obtener_pedido", store_id: KENKU.id, order_id: "o1", ok: false, error_code: "error", duration_ms: 13 });
    const update = queries.find((q) => q.table === "agent_tokens")!.ops.find(([m]) => m === "update")![1];
    expect(update).toEqual({ last_used_at: "2026-11-08T15:00:00.000Z", last_tool: "obtener_pedido" });
  });
});

// ---------------------------------------------------------------------------
// Ayudas puras
// ---------------------------------------------------------------------------

describe("lo que escribe el agente", () => {
  it("no rompe el filtro de PostgREST", () => {
    expect(sanitizeAgentQuery("#KP140122")).toBe("KP140122");
    expect(sanitizeAgentQuery("ana,order_name.eq.x)")).toBe("ana order_name.eq.x");
    expect(sanitizeAgentQuery('María "López" (Lima)*')).toBe("María López Lima");
    expect(sanitizeAgentQuery("x".repeat(100))).toHaveLength(60);
    expect(sanitizeAgentQuery("   ")).toBe("");
  });
  it("un teléfono se busca por sus últimos 9 dígitos; un pedido o un nombre no es teléfono", () => {
    expect(phoneSearchFragment("+51 987 654 321")).toBe("987654321");
    expect(phoneSearchFragment("987-654-321")).toBe("987654321");
    expect(phoneSearchFragment("KP140122")).toBeNull();
    expect(phoneSearchFragment("12345")).toBeNull();
  });
  it("el día de la cobertura es el de Lima", () => {
    expect(limaDayOf(new Date("2026-11-09T03:00:00Z"))).toBe("2026-11-08");
    expect(limaDayOf(new Date("2026-11-09T05:00:00Z"))).toBe("2026-11-09");
  });
});

describe("agentTranscript", () => {
  const msg = (over: Partial<ConversationMessage>): ConversationMessage => ({ id: null, dir: "inbound", t: 0, text: "", mediaKind: null, mediaUrl: null, status: null, ...over });
  it("del más antiguo al más nuevo, los últimos N, sin enlaces a archivos", () => {
    const out = agentTranscript(
      [
        msg({ t: Date.UTC(2026, 10, 8, 15, 2), dir: "outbound", text: "Hola, ¿confirmamos?", templateName: "confirmacion" }),
        msg({ t: Date.UTC(2026, 10, 8, 15, 0), text: "Quiero mi pedido" }),
        msg({ t: Date.UTC(2026, 10, 8, 15, 5), text: "", mediaKind: "image", mediaUrl: "https://kapso.example/secret.jpg" }),
      ],
      2,
    );
    expect(out).toEqual([
      { fecha: "2026-11-08T15:02:00.000Z", autor: "tienda", texto: "Hola, ¿confirmamos?", plantilla: "confirmacion" },
      { fecha: "2026-11-08T15:05:00.000Z", autor: "cliente", texto: null, adjunto: "image" },
    ]);
    expect(JSON.stringify(out)).not.toContain("kapso.example");
  });
});

describe("agentCalculatedPolicies", () => {
  it("el adelanto mínimo siempre; el destino solo si se dijo, y sin cobertura no afirma una", () => {
    expect(agentCalculatedPolicies(null, null)).toMatchObject({ adelanto_minimo: { monto: 20, moneda: "PEN" } });
    expect(agentCalculatedPolicies(null, null)).not.toHaveProperty("destino");
    expect(agentCalculatedPolicies("agencia", { distrito: "Arequipa" })).toMatchObject({ destino: { distrito: "Arequipa", cobertura: "agencia", pago: "adelanto" } });
    expect(agentCalculatedPolicies("lima", { distrito: "Surco" })).toMatchObject({ destino: { cobertura: "lima", pago: "contraentrega" } });
    expect(agentCalculatedPolicies(null, { distrito: "Nowhere" }).destino).not.toMatchObject({ pago: "contraentrega" });
  });
});

// ---------------------------------------------------------------------------
// El protocolo
// ---------------------------------------------------------------------------

function mcpDeps(admin: SupabaseClient, over: Partial<McpDeps> = {}): McpDeps & { recorded: unknown[] } {
  const recorded: unknown[] = [];
  let tick = 1000;
  return {
    admin,
    now: new Date("2026-11-08T15:00:00Z"),
    clock: () => (tick += 5),
    kapsoKey: async () => "kapso-key",
    transcript: async () => [],
    conversationByPhone: async () => null,
    rateLimited: async () => false,
    record: async (call) => {
      recorded.push(call);
    },
    recorded,
    ...over,
  };
}

const rpc = (method: string, params?: unknown, id: number | string = 1) => ({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });

describe("handleMcpMessage", () => {
  it("initialize: la versión pedida si se entiende, si no la más nueva", async () => {
    const deps = mcpDeps(fakeAdmin().client);
    const a = await handleMcpMessage(ctxWith(ALL_READ), rpc("initialize", { protocolVersion: "2025-03-26" }), deps);
    expect(a).toMatchObject({ id: 1, result: { protocolVersion: "2025-03-26", serverInfo: { name: "kapta" }, capabilities: { tools: {} } } });
    const b = await handleMcpMessage(ctxWith(ALL_READ), rpc("initialize", { protocolVersion: "1999-01-01" }), deps);
    expect(b).toMatchObject({ result: { protocolVersion: MCP_PROTOCOL_VERSIONS[0] } });
  });

  it("una notificación no se contesta; un mensaje roto o un método que no existe, sí", async () => {
    const deps = mcpDeps(fakeAdmin().client);
    expect(await handleMcpMessage(ctxWith(ALL_READ), { jsonrpc: "2.0", method: "notifications/initialized" }, deps)).toBeNull();
    expect(await handleMcpMessage(ctxWith(ALL_READ), { method: "ping", id: 3 }, deps)).toMatchObject({ id: 3, error: { code: -32600 } });
    expect(await handleMcpMessage(ctxWith(ALL_READ), rpc("resources/list"), deps)).toMatchObject({ error: { code: -32601 } });
    expect(await handleMcpMessage(ctxWith(ALL_READ), rpc("ping", undefined, "p"), deps)).toEqual({ jsonrpc: "2.0", id: "p", result: {} });
  });

  it("tools/list: solo las herramientas de los permisos del token, con su JSON Schema estricto", async () => {
    const deps = mcpDeps(fakeAdmin().client);
    const out = (await handleMcpMessage(ctxWith(["pedidos.leer"]), rpc("tools/list"), deps)) as { result: { tools: Record<string, unknown>[] } };
    expect(out.result.tools.map((t) => t.name)).toEqual(["buscar_pedidos", "obtener_pedido"]);
    const all = (await handleMcpMessage(ctxWith(ALL_READ), rpc("tools/list"), deps)) as { result: { tools: Record<string, unknown>[] } };
    expect(all.result.tools.map((t) => t.name)).toEqual(["buscar_pedidos", "obtener_pedido", "leer_conversacion", "consultar_politicas"]);
    for (const t of all.result.tools) {
      const schema = t.inputSchema as Record<string, unknown>;
      expect(schema.type).toBe("object");
      expect(schema.additionalProperties).toBe(false);
      expect(schema).not.toHaveProperty("$schema");
      expect(t.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    }
    expect(agentToolsFor(new Set())).toEqual([]);
    expect(agentToolDescriptor(AGENT_TOOLS[0]!).inputSchema).toMatchObject({ required: ["consulta"] });
  });

  it("tools/call: una herramienta que el token no tiene es como una que no existe", async () => {
    const { client, queries } = fakeAdmin();
    const deps = mcpDeps(client);
    const out = await handleMcpMessage(ctxWith(["politicas.leer"]), rpc("tools/call", { name: "obtener_pedido", arguments: { pedido: "#KP1" } }), deps);
    expect(out).toMatchObject({ error: { code: -32602 } });
    expect(queries).toHaveLength(0);
    expect(deps.recorded).toEqual([]);
  });

  it("argumentos que no van: error de la herramienta, registrado, sin tocar la base", async () => {
    const { client, queries } = fakeAdmin();
    const deps = mcpDeps(client);
    const out = (await handleMcpMessage(ctxWith(ALL_READ), rpc("tools/call", { name: "buscar_pedidos", arguments: { consulta: "x", extra: 1 } }), deps)) as { result: { isError: boolean; content: { text: string }[] } };
    expect(out.result.isError).toBe(true);
    expect(out.result.content[0]!.text).toMatch(/^Argumentos inválidos/);
    expect(queries).toHaveLength(0);
    expect(deps.recorded).toEqual([{ tool: "buscar_pedidos", storeId: null, orderId: null, ok: false, errorCode: "argumentos_invalidos", durationMs: 5 }]);
  });

  it(`pasado el tope de ${AGENT_RATE_PER_MINUTE} por minuto: corta antes de leer nada`, async () => {
    const { client, queries } = fakeAdmin();
    const deps = mcpDeps(client, { rateLimited: async () => true });
    const out = (await handleMcpMessage(ctxWith(ALL_READ), rpc("tools/call", { name: "buscar_pedidos", arguments: { consulta: "KP1" } }), deps)) as { result: { isError: boolean } };
    expect(out.result.isError).toBe(true);
    expect(queries).toHaveLength(0);
    expect(deps.recorded).toMatchObject([{ tool: "buscar_pedidos", ok: false, errorCode: "tope_por_minuto" }]);
  });

  it("una herramienta que revienta: mensaje genérico, sin el error por dentro", async () => {
    const client = { from: () => { throw new Error("password=secreto"); }, rpc: () => { throw new Error("x"); } } as unknown as SupabaseClient;
    const deps = mcpDeps(client);
    const out = await handleMcpMessage(ctxWith(ALL_READ), rpc("tools/call", { name: "buscar_pedidos", arguments: { consulta: "KP1" } }), deps);
    expect(JSON.stringify(out)).not.toContain("secreto");
    expect(out).toMatchObject({ result: { isError: true } });
    expect(deps.recorded).toMatchObject([{ ok: false, errorCode: "error_interno" }]);
  });
});

// ---------------------------------------------------------------------------
// Las herramientas
// ---------------------------------------------------------------------------

async function call(ctx: AgentContext, name: string, args: unknown, deps: McpDeps) {
  const out = (await handleMcpMessage(ctx, rpc("tools/call", { name, arguments: args }), deps)) as {
    result: { isError: boolean; content: { text: string }[]; structuredContent?: Record<string, unknown> };
  };
  return out.result;
}

describe("buscar_pedidos", () => {
  it("busca solo en las tiendas del token, con lo escrito ya limpio", async () => {
    const { client, queries } = fakeAdmin((q) =>
      q.table === "order_master"
        ? { data: [{ order_id: "o1", store_id: KENKU.id, order_name: "#KP140122", customer_name: " Ana  Pérez ", order_total: "149.9", macro_stage: null, macro_substage: null, current_courier: "aliclik" }] }
        : { data: [] },
    );
    const deps = mcpDeps(client);
    const out = await call(ctxWith(ALL_READ, [KENKU]), "buscar_pedidos", { consulta: "#KP140122),x" }, deps);
    expect(out.isError).toBe(false);
    const master = queries.find((q) => q.table === "order_master")!;
    expect(has(master, "in", "store_id", [KENKU.id])).toBe(true);
    const or = master.ops.find(([m]) => m === "or")![1] as string;
    expect(or).toContain("order_name.ilike.%KP140122 x%");
    expect(or).not.toContain(")");
    const guides = queries.find((q) => q.table === "shipments")!;
    expect(has(guides, "in", "store_id", [KENKU.id])).toBe(true);
    expect(out.structuredContent).toMatchObject({ cantidad: 1, resultados: [{ pedido: "#KP140122", tienda: "Kenku Peru", cliente: "Ana Pérez", total: 149.9 }] });
    expect(deps.recorded).toMatchObject([{ tool: "buscar_pedidos", storeId: KENKU.id, ok: true }]);
  });

  it("un teléfono busca solo por teléfono, por sus últimos 9 dígitos", async () => {
    const { client, queries } = fakeAdmin();
    const deps = mcpDeps(client);
    const out = await call(ctxWith(ALL_READ), "buscar_pedidos", { consulta: "+51 987 654 321" }, deps);
    expect(out.structuredContent).toMatchObject({ cantidad: 0, nota: "Ningún pedido coincide en las tiendas que ve este conector." });
    const master = queries.find((q) => q.table === "order_master")!;
    expect(master.ops.find(([m]) => m === "or")![1]).toBe("customer_phone.ilike.%987654321%");
    expect(has(master, "in", "store_id", [KENKU.id, AURELA.id])).toBe(true);
    expect(queries.some((q) => q.table === "shipments")).toBe(false);
  });

  it("una tienda que el token no ve no se busca", async () => {
    const { client, queries } = fakeAdmin();
    const out = await call(ctxWith(ALL_READ, [KENKU]), "buscar_pedidos", { consulta: "Ana", tienda: "Aurela" }, mcpDeps(client));
    expect(out.isError).toBe(true);
    expect(out.content[0]!.text).toContain("No conozco la tienda «Aurela»");
    expect(queries).toHaveLength(0);
  });
});

describe("obtener_pedido", () => {
  const master = {
    order_id: "o1", store_id: AURELA.id, order_name: "#AUR176161", customer_name: "Ana", customer_phone: "51987654321",
    district: "Surco", address: "Av. 1", coverage: "lima", shipping_mode: "delivery", order_total: 99, general_status: "en_ruta",
    macro_stage: null, macro_substage: null, macro_reasons: [], payment_state: null, current_courier: null,
  };

  it("lo busca en las tiendas del token; el de otra tienda contesta como uno que no existe", async () => {
    const { client, queries } = fakeAdmin(() => ({ data: [] }));
    const out = await call(ctxWith(ALL_READ, [KENKU]), "obtener_pedido", { pedido: "aur176161" }, mcpDeps(client));
    expect(out.isError).toBe(true);
    expect(out.content[0]!.text).toBe("No encontré el pedido #AUR176161 en las tiendas que ve este conector.");
    expect(has(queries[0]!, "in", "store_id", [KENKU.id])).toBe(true);
    expect(has(queries[0]!, "eq", "order_name", "#AUR176161")).toBe(true);
  });

  it("devuelve el detalle, con lo que no se sabe en null", async () => {
    const { client, queries } = fakeAdmin((q) => {
      if (q.table === "order_master") return { data: [master] };
      if (q.table === "orders") return { data: [{ id: "o1", currency: "PEN", total_amount: 99, line_items: [{ title: "Crema", quantity: 2 }], raw: null }] };
      if (q.table === "shipments") return { data: [{ courier: "aliclik", guide_code: "G-1", delivery_status: "en_ruta" }] };
      if (q.table === "order_events") return { data: [{ kind: "shipment_status", occurred_at: "2026-11-08T10:00:00Z", reason: "  Salió  a ruta " }] };
      return { data: [] };
    });
    const deps = mcpDeps(client);
    const out = await call(ctxWith(ALL_READ), "obtener_pedido", { pedido: "#AUR176161" }, deps);
    expect(out.isError).toBe(false);
    const d = out.structuredContent!;
    expect(d).toMatchObject({
      pedido: "#AUR176161",
      tienda: "Aurela",
      cliente: { nombre: "Ana", telefono: "51987654321" },
      importes: { moneda: "PEN", total: 99 },
      entrega: { cobertura: "lima", distrito: "Surco", direccion: "Av. 1", referencia: null },
      estado: { general: "en_ruta", etapa: null, entregado: null },
      guias: [{ guia: "G-1", estado: "en_ruta" }],
      movimientos_recientes: [{ tipo: "shipment_status", detalle: "Salió a ruta" }],
    });
    expect((d.productos as unknown[]).length).toBe(1);
    for (const table of ["orders", "shipments", "order_events"]) {
      expect(has(queries.find((q) => q.table === table)!, table === "orders" ? "eq" : "eq", table === "orders" ? "id" : "order_id", "o1")).toBe(true);
    }
    expect(deps.recorded).toMatchObject([{ tool: "obtener_pedido", storeId: AURELA.id, orderId: "o1", ok: true }]);
  });

  it("un número que no es pedido no consulta la base", async () => {
    const { client, queries } = fakeAdmin();
    const out = await call(ctxWith(ALL_READ), "obtener_pedido", { pedido: "hola mundo" }, mcpDeps(client));
    expect(out.isError).toBe(true);
    expect(queries).toHaveLength(0);
  });
});

describe("leer_conversacion", () => {
  const messages: ConversationMessage[] = [
    { id: "m1", dir: "inbound", t: Date.UTC(2026, 10, 8, 14), text: "¿Ya salió?", mediaKind: null, mediaUrl: null, status: null },
    { id: "m2", dir: "outbound", t: Date.UTC(2026, 10, 8, 15), text: "", mediaKind: "document", mediaUrl: "https://kapso.example/f.pdf", status: "read" },
  ];

  it("por pedido: la conversación guardada en el pedido, con la clave de Kapso de su tienda", async () => {
    const { client } = fakeAdmin((q) => {
      if (q.table === "order_master") return { data: [{ order_id: "o1", store_id: KENKU.id, customer_phone: "987654321" }] };
      if (q.table === "orders") return { data: [{ kapso_conversation_id: "conv-1", customer_phone: null }] };
      return { data: [] };
    });
    const transcript = vi.fn(async () => messages);
    const kapsoKey = vi.fn(async () => "kk");
    const conversationByPhone = vi.fn(async () => "conv-x");
    const out = await call(ctxWith(ALL_READ), "leer_conversacion", { pedido: "KP140122" }, mcpDeps(client, { transcript, kapsoKey, conversationByPhone }));
    expect(out.isError).toBe(false);
    expect(kapsoKey).toHaveBeenCalledWith(KENKU.id);
    expect(transcript).toHaveBeenCalledWith({ apiKey: "kk" }, "conv-1", 2);
    expect(conversationByPhone).not.toHaveBeenCalled();
    expect(out.structuredContent).toMatchObject({ tienda: "Kenku Peru", telefono: "51987654321", mensajes: [{ autor: "cliente", texto: "¿Ya salió?" }, { autor: "tienda", adjunto: "document" }] });
    expect(JSON.stringify(out)).not.toContain("kapso.example");
  });

  it("por teléfono: el lead de esa tienda, y si no, la conversación más reciente en Kapso", async () => {
    const { client, queries } = fakeAdmin(() => ({ data: [] }));
    const conversationByPhone = vi.fn(async () => "conv-2");
    const transcript = vi.fn(async () => messages);
    const out = await call(ctxWith(ALL_READ), "leer_conversacion", { telefono: "987 654 321", tienda: "aurela", limite: 1 }, mcpDeps(client, { conversationByPhone, transcript }));
    const lead = queries.find((q) => q.table === "leads")!;
    expect(has(lead, "eq", "store_id", AURELA.id)).toBe(true);
    expect(has(lead, "eq", "phone", "51987654321")).toBe(true);
    expect(conversationByPhone).toHaveBeenCalledWith({ apiKey: "kapso-key" }, "51987654321");
    expect((out.structuredContent!.mensajes as unknown[]).length).toBe(1);
  });

  it("sin Kapso en la tienda, o con Kapso caído: lo dice", async () => {
    const { client } = fakeAdmin(() => ({ data: [] }));
    const noKey = await call(ctxWith(ALL_READ, [KENKU]), "leer_conversacion", { telefono: "987654321" }, mcpDeps(client, { kapsoKey: async () => null }));
    expect(noKey.content[0]!.text).toBe("Kenku Peru no tiene Kapso configurado.");
    const down = await call(
      ctxWith(ALL_READ, [KENKU]),
      "leer_conversacion",
      { telefono: "987654321" },
      mcpDeps(client, { conversationByPhone: async () => { throw new Error("502"); } }),
    );
    expect(down.isError).toBe(true);
    expect(down.content[0]!.text).toContain("No se pudo leer la conversación en Kapso");
  });

  it("sin pedido ni teléfono no hace nada", async () => {
    const { client, queries } = fakeAdmin();
    const out = await call(ctxWith(ALL_READ), "leer_conversacion", {}, mcpDeps(client));
    expect(out.content[0]!.text).toBe("Indica el pedido o el teléfono.");
    expect(queries).toHaveLength(0);
  });
});

describe("consultar_politicas", () => {
  it("la cobertura del distrito la calcula la base, con el día de Lima", async () => {
    const { client, rpcs } = fakeAdmin((q) => (q.table === "rpc:order_coverage_for" ? { data: "agencia" } : { data: [] }));
    const deps = mcpDeps(client, { now: new Date("2026-11-09T02:00:00Z") });
    const out = await call(ctxWith(ALL_READ), "consultar_politicas", { tienda: "Kenku", distrito: "Arequipa", departamento: "Arequipa" }, deps);
    expect(rpcs).toEqual([{ name: "order_coverage_for", args: { p_store_id: KENKU.id, p_region: "Arequipa", p_province: null, p_district: "Arequipa", p_day: "2026-11-08" } }]);
    expect(out.structuredContent).toMatchObject({ tienda: "Kenku Peru", calculadas: { adelanto_minimo: { monto: 20 }, destino: { cobertura: "agencia", pago: "adelanto" } } });
  });

  it("sin distrito no consulta la cobertura", async () => {
    const { client, rpcs } = fakeAdmin();
    const out = await call(ctxWith(ALL_READ, [AURELA]), "consultar_politicas", {}, mcpDeps(client));
    expect(rpcs).toEqual([]);
    expect(out.structuredContent).toMatchObject({ tienda: "Aurela" });
  });
});

// ---------------------------------------------------------------------------
// La ruta
// ---------------------------------------------------------------------------

const route = vi.hoisted(() => ({ admin: null as unknown as SupabaseClient }));
vi.mock("@/lib/db", () => ({
  createAdminSupabase: () => route.admin,
  createServerSupabase: async () => {
    throw new Error("no se usa en estas pruebas");
  },
}));
vi.mock("@/lib/ingest", () => ({ getStoreCreds: async () => null }));

describe("POST /api/mcp", () => {
  const token = "kagt_" + "B".repeat(43);
  const tokenRow = { id: "tok-9", org_id: ORG, created_by: CREATOR, label: "Grok", store_ids: [KENKU.id], scopes: ["pedidos.leer"], expires_at: null, revoked_at: null };
  let queries: Query[];

  beforeEach(() => {
    const fake = fakeAdmin((q) => {
      if (q.table === "agent_tokens") return { data: filterValue(q, "eq", "token_hash") === hashAgentToken(token) ? [tokenRow] : [] };
      if (q.table === "memberships") return { data: [{ role: "owner" }] };
      if (q.table === "stores") return { data: [KENKU, AURELA] };
      if (q.table === "agent_tool_calls") return { count: 0 };
      return { data: [] };
    });
    route.admin = fake.client;
    queries = fake.queries;
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function post(body: unknown, headers: Record<string, string> = { authorization: `Bearer ${token}` }) {
    const { NextRequest } = await import("next/server");
    const { POST } = await import("@/app/api/mcp/route");
    const req = new NextRequest("https://kapta.example/api/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
    return POST(req);
  }

  it("sin token: 401 con WWW-Authenticate y sin leer el cuerpo", async () => {
    const res = await post(rpc("tools/list"), {});
    expect(res.status).toBe(401);
    // Con dónde pedir permiso por OAuth (MOM §42.8).
    expect(res.headers.get("www-authenticate")).toBe('Bearer realm="kapta", resource_metadata="https://kapta.example/.well-known/oauth-protected-resource/api/mcp"');
    expect(await res.json()).toMatchObject({ error: { message: "No autorizado." } });
    expect(queries).toHaveLength(0);
  });

  it("desde la página de otro sitio: 403", async () => {
    const res = await post(rpc("tools/list"), { authorization: `Bearer ${token}`, origin: "https://malicioso.example" });
    expect(res.status).toBe(403);
    expect(queries).toHaveLength(0);
  });

  it("con token: tools/list de sus permisos, sin caché", async () => {
    const res = await post(rpc("tools/list"));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json();
    expect(body.result.tools.map((t: { name: string }) => t.name)).toEqual(["buscar_pedidos", "obtener_pedido"]);
  });

  it("una notificación: 202 sin cuerpo; un lote o algo que no es JSON: 400", async () => {
    const note = await post({ jsonrpc: "2.0", method: "notifications/initialized" });
    expect(note.status).toBe(202);
    expect(await note.text()).toBe("");
    const batch = await post([rpc("ping"), rpc("ping", undefined, 2)]);
    expect(batch.status).toBe(400);
    const broken = await post("{nope");
    expect(broken.status).toBe(400);
    expect(await broken.json()).toMatchObject({ error: { code: -32700 } });
  });

  it("GET y DELETE: 405, no hay flujo ni sesión", async () => {
    const { GET, DELETE } = await import("@/app/api/mcp/route");
    expect(GET().status).toBe(405);
    expect(DELETE().headers.get("allow")).toBe("POST");
  });
});
