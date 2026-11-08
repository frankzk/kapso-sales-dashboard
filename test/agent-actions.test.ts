// Lo que el agente de IA puede hacer (MOM §42.9, parte 3; 0323): las reglas
// puras (lib/agent-actions.ts), los pasos y los frenos (lib/agent-actions-flow.ts)
// y las herramientas que los usan (lib/agent-tools.ts). Lo que se fija:
//   - nota: sola, con el permiso de quien conectó el agente, marcada «Agente de
//     IA», sin persona, sin repetirse;
//   - WhatsApp y guía: vista previa que no hace nada y deja un código de un
//     solo uso; al confirmar se toma la fila una vez y se vuelve a comprobar todo;
//   - el interruptor: Apagado no hace nada; Simulación hace lo del chat y
//     registra lo de la rutina; Activo hace;
//   - una vez y no más (4 h, mismo texto, una guía), topes del día de Lima, la
//     ventana de 24 h y lo incierto que no se reintenta.
// Sin red ni base real: una base en memoria.

import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AgentContext, AgentScope } from "@/lib/agent-auth";
import type { Permission } from "@/lib/permissions";
import {
  AGENT_COMMENT_TYPE,
  agentExecution,
  agentExecutionNote,
  agentGuideReason,
  cleanAgentText,
  comparableBody,
  dailyCapBlock,
  guideOrderBlock,
  isAgentActionsMigrationMissing,
  limaDayStartIso,
  maskPhone,
  parseAgentSettings,
  whatsappOrderBlock,
  whatsappWindow,
  type PriorAgentAction,
} from "@/lib/agent-actions";
import { bodyKey, hashConfirmationCode } from "@/lib/agent-action-codes";
import { createAgentActions, type AgentActionsExternal, type AgentGuideCreated, type AgentGuideQuote, type AgentOrderRef } from "@/lib/agent-actions-flow";
import { AGENT_TOOLS, agentChatbyTranscript, type AgentToolDeps } from "@/lib/agent-tools";
import type { ChatbyConversation } from "@/lib/chatby-conversation";
import { aliclikMotiveAllowed } from "@/lib/aliclik-output-policy";
import { guideCreatorPhrase } from "@/lib/guide-note";

// ---------------------------------------------------------------------------
// Una base en memoria: lo justo de PostgREST que usan las acciones.
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;
type Filter = (row: Row) => boolean;

function memoryDb(seed: Record<string, Row[]> = {}, opts: { missing?: boolean } = {}) {
  const tables: Record<string, Row[]> = { agent_actions: [], agent_action_settings: [], order_events: [], ...seed };
  let seq = 0;
  const missingError = { code: "PGRST205", message: "Could not find the table 'public.agent_actions' in the schema cache" };

  function builder(table: string) {
    const filters: Filter[] = [];
    let mode: "select" | "insert" | "update" = "select";
    let payload: Row | null = null;
    let returning = false;
    let head = false;
    let limit: number | null = null;
    let single: "one" | "maybe" | null = null;

    function run() {
      if (opts.missing && table.startsWith("agent_action")) return { data: null, error: missingError, count: null };
      const rows = (tables[table] ??= []);
      if (mode === "insert") {
        const row: Row = { id: `id-${++seq}`, created_at: new Date(Date.UTC(2026, 10, 8, 15, 0, seq)).toISOString(), resolved_at: null, details: {}, ...payload };
        if (row.code_hash && rows.some((r) => r.code_hash === row.code_hash)) return { data: null, error: { code: "23505", message: "duplicate" } };
        rows.push(row);
        const data = returning ? (single ? row : [row]) : null;
        return { data, error: null };
      }
      const hit = rows.filter((r) => filters.every((f) => f(r)));
      if (mode === "update") {
        for (const r of hit) Object.assign(r, payload);
        return { data: returning ? hit.map((r) => ({ ...r })) : null, error: null };
      }
      if (head) return { data: null, error: null, count: hit.length };
      const out = limit == null ? hit : hit.slice(0, limit);
      if (single === "maybe") return { data: out[0] ? { ...out[0] } : null, error: null };
      if (single === "one") return out[0] ? { data: { ...out[0] }, error: null } : { data: null, error: { code: "PGRST116", message: "no rows" } };
      return { data: out.map((r) => ({ ...r })), error: null, count: out.length };
    }

    const q = {
      select(_cols?: string, o?: { count?: string; head?: boolean }) {
        if (mode !== "select") returning = true;
        if (o?.head) head = true;
        return q;
      },
      insert(row: Row) {
        mode = "insert";
        payload = row;
        return q;
      },
      update(patch: Row) {
        mode = "update";
        payload = patch;
        return q;
      },
      eq(col: string, v: unknown) {
        filters.push((r) => r[col] === v);
        return q;
      },
      neq(col: string, v: unknown) {
        filters.push((r) => r[col] !== v);
        return q;
      },
      in(col: string, vs: unknown[]) {
        filters.push((r) => vs.includes(r[col]));
        return q;
      },
      gte(col: string, v: string) {
        filters.push((r) => typeof r[col] === "string" && (r[col] as string) >= v);
        return q;
      },
      limit(n: number) {
        limit = n;
        return q;
      },
      maybeSingle() {
        single = "maybe";
        return Promise.resolve(run());
      },
      single() {
        single = "one";
        return Promise.resolve(run());
      },
      then(resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) {
        return Promise.resolve(run()).then(resolve, reject);
      },
    };
    return q;
  }
  return { client: { from: (t: string) => builder(t) } as unknown as SupabaseClient, tables };
}

// ---------------------------------------------------------------------------
// Datos
// ---------------------------------------------------------------------------

const ORG = "00000000-0000-4000-8000-0000000000aa";
const KENKU = { id: "00000000-0000-4000-8000-000000000001", name: "Kenku Peru" };
const CREATOR = "00000000-0000-4000-8000-0000000000c1";
const NOW = new Date("2026-11-08T15:00:00Z");

const ctx: AgentContext = {
  tokenId: "tok-1",
  orgId: ORG,
  userId: CREATOR,
  label: "Grok",
  scopes: new Set<AgentScope>(["pedidos.leer", "pedidos.nota", "whatsapp.enviar", "aliclik.crear_guia"]),
  stores: [KENKU],
};

const order: AgentOrderRef = { orderId: "ord-1", storeId: KENKU.id, storeName: KENKU.name, orderName: "#KP204280", customerPhone: "987654321" };

const QUOTE: AgentGuideQuote = {
  ok: true,
  transportId: 7,
  transportName: "Urbano",
  deliveryCost: 12,
  collectTotal: 89.9,
  orderTotal: 89.9,
  warnings: [],
  pickupDate: "2026-11-09",
};

function setup(over: {
  perms?: Permission[] | null;
  settings?: Row | null;
  lastInbound?: number | null;
  send?: AgentActionsExternal["kapso"]["sendText"];
  quote?: AgentGuideQuote;
  created?: AgentGuideCreated;
  seed?: Record<string, Row[]>;
  missing?: boolean;
  now?: () => Date;
} = {}) {
  const seed = { ...(over.seed ?? {}) };
  if (over.settings !== null) seed.agent_action_settings = [{ org_id: ORG, whatsapp_mode: "activo", guide_mode: "activo", whatsapp_daily_cap: 20, guide_daily_cap: 10, ...(over.settings ?? {}) }];
  const db = memoryDb(seed, { missing: over.missing });
  let clock = over.now ?? (() => NOW);
  const send = vi.fn(over.send ?? (async () => ({ ok: true as const, id: "wamid.1" })));
  const create = vi.fn(async () => over.created ?? { status: "hecha" as const, code: null, orderNumber: "ALI-555", message: "Guía creada." });
  const quote = vi.fn(async () => over.quote ?? QUOTE);
  const recompute = vi.fn(async () => undefined);
  const ext: AgentActionsExternal = {
    admin: db.client,
    now: () => clock(),
    permissions: async () => (over.perms === null ? null : new Set(over.perms ?? (["master.edit", "aliclik.create_guide"] as Permission[]))),
    kapso: {
      creds: async () => ({ apiKey: "kk", phoneNumberId: "pn-store" }),
      conversations: async () => [{ id: "conv-1", phone_number_id: "pn-conv" }],
      lastInboundAt: async () => (over.lastInbound === undefined ? NOW.getTime() - 3600_000 : over.lastInbound),
      sendText: send,
    },
    aliclik: { quote, create },
    recompute,
  };
  return { actions: createAgentActions(ext), db, send, create, quote, recompute, setNow: (d: Date) => (clock = () => d) };
}

const codeOf = (out: { ok: boolean; data?: unknown }) => (out as { data: { codigo_confirmacion: string } }).data.codigo_confirmacion;

// ---------------------------------------------------------------------------
// Reglas puras
// ---------------------------------------------------------------------------

describe("reglas puras", () => {
  it("el interruptor y el origen", () => {
    expect(agentExecution("apagado", "chat")).toBe("rechazar");
    expect(agentExecution("simulacion", "rutina")).toBe("simular");
    expect(agentExecution("simulacion", "chat")).toBe("ejecutar");
    expect(agentExecution("activo", "rutina")).toBe("ejecutar");
    expect(agentExecutionNote("simulacion", "chat")).toContain("DE VERDAD");
    expect(agentExecutionNote("simulacion", "rutina")).toContain("sin hacerlo");
  });

  it("el mismo texto es el mismo aunque cambien tildes, mayúsculas, espacios o la puntuación final", () => {
    expect(comparableBody("  Hola,  MARÍA!! ")).toBe("hola, maria");
    expect(bodyKey("Hola, María!")).toBe(bodyKey("hola, maria"));
    expect(bodyKey("Hola, María")).not.toBe(bodyKey("Hola, Mario"));
    expect(bodyKey("x")).toMatch(/^[0-9a-f]{64}$/);
    expect(hashConfirmationCode("abc")).toBe(createHash("sha256").update("abc").digest("hex"));
  });

  it("limpia el texto sin juntar los párrafos", () => {
    expect(cleanAgentText("  Hola\r\n\r\n\r\n  ¿Todo   bien? \n")).toBe("Hola\n\n¿Todo bien?");
  });

  it("la ventana de 24 h", () => {
    const now = NOW.getTime();
    expect(whatsappWindow(now - 23 * 3600_000, now).open).toBe(true);
    expect(whatsappWindow(now - 24 * 3600_000, now).open).toBe(false);
    expect(whatsappWindow(null, now)).toEqual({ open: false, until: null });
  });

  it("el día de Lima empieza a las 05:00 UTC", () => {
    expect(limaDayStartIso(new Date("2026-11-09T03:00:00Z"))).toBe("2026-11-08T05:00:00.000Z");
    expect(limaDayStartIso(new Date("2026-11-09T06:00:00Z"))).toBe("2026-11-09T05:00:00.000Z");
  });

  it("una vez y no más: lo simulado no cuenta, lo que está saliendo sí", () => {
    const key = bodyKey("Hola");
    const now = NOW.getTime();
    const at = (h: number) => new Date(now - h * 3600_000).toISOString();
    const w = (status: PriorAgentAction["status"], hoursAgo: number, k = "otro"): PriorAgentAction => ({ action: "whatsapp", status, body_key: k, resolved_at: status === "en_curso" ? null : at(hoursAgo) });
    expect(whatsappOrderBlock([w("hecha", 30, key)], key, now)).toContain("mismo texto");
    expect(whatsappOrderBlock([w("hecha", 3)], key, now)).toContain("menos de 4 horas");
    expect(whatsappOrderBlock([w("hecha", 5)], key, now)).toBeNull();
    expect(whatsappOrderBlock([w("simulada", 1, key)], key, now)).toBeNull();
    expect(whatsappOrderBlock([w("en_curso", 0)], key, now)).toContain("menos de 4 horas");
    // Una en curso que quedó colgada hace 5 horas ya no frena.
    expect(whatsappOrderBlock([{ ...w("en_curso", 0), created_at: at(5) }], key, now)).toBeNull();
    expect(whatsappOrderBlock([{ ...w("en_curso", 0), created_at: at(1) }], key, now)).toContain("menos de 4 horas");
    expect(whatsappOrderBlock([w("incierta", 1)], key, now)).toContain("menos de 4 horas");
    const g = (status: PriorAgentAction["status"]): PriorAgentAction => ({ action: "guia_aliclik", status, body_key: null, resolved_at: at(1) });
    expect(guideOrderBlock([g("simulada"), g("rechazada"), g("error")])).toBeNull();
    expect(guideOrderBlock([g("incierta")])).toContain("una guía por pedido");
    expect(dailyCapBlock(9, 10, "guías")).toBeNull();
    expect(dailyCapBlock(10, 10, "guías")).toContain("tope de 10 guías");
  });

  it("el celular sale con sus 3 últimos dígitos", () => {
    expect(maskPhone("51987654321")).toBe("••••••••321");
    expect(maskPhone("123")).toBeNull();
  });

  it("la configuración: sin fila o con algo raro, Simulación con 20 y 10", () => {
    expect(parseAgentSettings(null)).toEqual({ whatsappMode: "simulacion", guideMode: "simulacion", whatsappDailyCap: 20, guideDailyCap: 10 });
    expect(parseAgentSettings({ whatsapp_mode: "encendido", guide_mode: "activo", whatsapp_daily_cap: 500, guide_daily_cap: 3 })).toEqual({
      whatsappMode: "simulacion",
      guideMode: "activo",
      whatsappDailyCap: 20,
      guideDailyCap: 3,
    });
  });

  it("reconoce la migración que falta solo en sus tablas", () => {
    expect(isAgentActionsMigrationMissing({ code: "PGRST205", message: "Could not find the table 'public.agent_actions'" })).toBe(true);
    expect(isAgentActionsMigrationMissing({ code: "42P01", message: 'relation "agent_action_settings" does not exist' })).toBe(true);
    expect(isAgentActionsMigrationMissing({ code: "42P01", message: 'relation "agent_tokens" does not exist' })).toBe(false);
  });

  it("la guía del agente no tiene persona: no justifica otra salida y la nota del lead lo dice", () => {
    expect(aliclikMotiveAllowed(null, "agente_ia")).toBe(false);
    expect(guideCreatorPhrase(null, "agente_ia")).toBe("por el agente de IA");
  });

  it("el motivo de la guía dice quién y desde dónde", () => {
    expect(agentGuideReason("Grok", "chat")).toBe("Creada por el agente de IA «Grok»: se la pidieron y la aprobaron en el chat.");
    expect(agentGuideReason("", "rutina")).toBe("Creada por el agente de IA «Agente de IA» por su cuenta (rutina).");
  });
});

// ---------------------------------------------------------------------------
// Nota
// ---------------------------------------------------------------------------

describe("nota", () => {
  it("con el permiso de quien conectó el agente: queda como comentario «Agente de IA», sin persona", async () => {
    const { actions, db, recompute } = setup();
    const out = await actions.note(ctx, order, { text: "  La clienta confirmó por Chatby.  ", origin: "rutina" });
    expect(out).toMatchObject({ ok: true, data: { accion: "nota", estado: "hecha", texto: "La clienta confirmó por Chatby." } });
    expect(db.tables.order_events!).toEqual([
      expect.objectContaining({ order_id: "ord-1", kind: "comment", source: "agente_ia", actor: null, comment_type: AGENT_COMMENT_TYPE, note: "La clienta confirmó por Chatby." }),
    ]);
    expect(db.tables.agent_actions!).toEqual([expect.objectContaining({ action: "nota", status: "hecha", origin: "rutina", acting_user: CREATOR, token_id: "tok-1" })]);
    expect(recompute).toHaveBeenCalledWith(["ord-1"]);
  });

  it("sin «Gestionar pedidos», o si no se pueden leer los permisos: no deja nada", async () => {
    const denied = setup({ perms: ["aliclik.create_guide"] });
    expect(await denied.actions.note(ctx, order, { text: "Hola equipo", origin: "chat" })).toMatchObject({ ok: false, code: "sin_permiso" });
    expect(denied.db.tables.order_events!).toEqual([]);
    const unknown = setup({ perms: null });
    expect(await unknown.actions.note(ctx, order, { text: "Hola equipo", origin: "chat" })).toMatchObject({ ok: false, code: "permisos_no_disponibles" });
  });

  it("la misma nota en el mismo pedido no se repite", async () => {
    const { actions, db } = setup();
    await actions.note(ctx, order, { text: "Revisar dirección.", origin: "chat" });
    expect(await actions.note(ctx, order, { text: "revisar direccion", origin: "chat" })).toMatchObject({ ok: false, code: "repetida" });
    expect(db.tables.order_events!).toHaveLength(1);
  });

  it("sin la 0323: lo dice", async () => {
    const { actions } = setup({ missing: true });
    expect(await actions.note(ctx, order, { text: "Hola equipo", origin: "chat" })).toMatchObject({ ok: false, code: "migracion_pendiente" });
  });
});

// ---------------------------------------------------------------------------
// WhatsApp
// ---------------------------------------------------------------------------

describe("WhatsApp", () => {
  it("la vista previa no envía nada y guarda solo el sha256 del código", async () => {
    const { actions, db, send } = setup();
    const out = await actions.previewWhatsapp(ctx, order, { text: "Hola, ¿confirmamos tu pedido?", origin: "chat" });
    expect(out).toMatchObject({ ok: true, data: { paso: "vista_previa", para: "••••••••321", interruptor: "Activo", texto: "Hola, ¿confirmamos tu pedido?" } });
    expect(send).not.toHaveBeenCalled();
    const code = codeOf(out);
    expect(db.tables.agent_actions!).toEqual([expect.objectContaining({ status: "prevista", code_hash: hashConfirmationCode(code), mode: "activo" })]);
    expect(JSON.stringify(db.tables.agent_actions!)).not.toContain(code);
  });

  it("Apagado no deja ni pedir la vista previa", async () => {
    const { actions, db } = setup({ settings: { whatsapp_mode: "apagado" } });
    expect(await actions.previewWhatsapp(ctx, order, { text: "Hola", origin: "chat" })).toMatchObject({ ok: false, code: "apagado" });
    expect(db.tables.agent_actions!).toEqual([]);
  });

  it("fuera de las 24 h no se escribe", async () => {
    const { actions } = setup({ lastInbound: NOW.getTime() - 25 * 3600_000 });
    expect(await actions.previewWhatsapp(ctx, order, { text: "Hola", origin: "chat" })).toMatchObject({ ok: false, code: "ventana_cerrada" });
    const never = setup({ lastInbound: null });
    expect(await never.actions.previewWhatsapp(ctx, order, { text: "Hola", origin: "chat" })).toMatchObject({ ok: false, code: "ventana_cerrada" });
  });

  it("Activo: al confirmar se envía desde el número de la conversación y queda en la Actividad", async () => {
    const { actions, db, send } = setup();
    const preview = await actions.previewWhatsapp(ctx, order, { text: "Hola, ¿confirmamos?", origin: "rutina" });
    const out = await actions.confirm(ctx, order, "whatsapp", codeOf(preview));
    expect(out).toMatchObject({ ok: true, data: { estado: "hecha" } });
    expect(send).toHaveBeenCalledWith({ apiKey: "kk" }, { phoneNumberId: "pn-conv", to: "51987654321", body: "Hola, ¿confirmamos?" });
    expect(db.tables.agent_actions![0]).toMatchObject({ status: "hecha", mode: "activo", details: expect.objectContaining({ message_id: "wamid.1" }) });
    expect(db.tables.order_events!).toEqual([expect.objectContaining({ kind: "agent_whatsapp", source: "agente_ia", actor: null, note: "Hola, ¿confirmamos?" })]);
  });

  it("Simulación: lo de la rutina se registra sin enviarse; lo del chat se envía", async () => {
    const { actions, db, send } = setup({ settings: { whatsapp_mode: "simulacion" } });
    const routine = await actions.previewWhatsapp(ctx, order, { text: "Hola, ¿confirmamos?", origin: "rutina" });
    expect(await actions.confirm(ctx, order, "whatsapp", codeOf(routine))).toMatchObject({ ok: true, data: { estado: "simulada" } });
    expect(send).not.toHaveBeenCalled();
    expect(db.tables.order_events!).toEqual([]);
    // Lo simulado no frena lo que el owner aprueba en el chat, ni con el mismo texto.
    const chat = await actions.previewWhatsapp(ctx, order, { text: "Hola, ¿confirmamos?", origin: "chat" });
    expect(await actions.confirm(ctx, order, "whatsapp", codeOf(chat))).toMatchObject({ ok: true, data: { estado: "hecha" } });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("el código sirve una vez, para esa acción y ese pedido, y por 10 minutos", async () => {
    const { actions, send, setNow, db } = setup();
    const preview = await actions.previewWhatsapp(ctx, order, { text: "Hola", origin: "chat" });
    const code = codeOf(preview);
    expect(await actions.confirm(ctx, { ...order, orderId: "ord-2" }, "whatsapp", code)).toMatchObject({ ok: false, code: "codigo_invalido" });
    expect(await actions.confirm(ctx, order, "guia_aliclik", code)).toMatchObject({ ok: false, code: "codigo_invalido" });
    expect(await actions.confirm({ ...ctx, tokenId: "otro-token" }, order, "whatsapp", code)).toMatchObject({ ok: false, code: "codigo_invalido" });
    await actions.confirm(ctx, order, "whatsapp", code);
    expect(await actions.confirm(ctx, order, "whatsapp", code)).toMatchObject({ ok: false, code: "codigo_usado" });
    expect(send).toHaveBeenCalledTimes(1);

    const late = await actions.previewWhatsapp(ctx, { ...order, orderId: "ord-3" }, { text: "Otro", origin: "chat" });
    setNow(new Date(NOW.getTime() + 11 * 60_000));
    expect(await actions.confirm(ctx, { ...order, orderId: "ord-3" }, "whatsapp", codeOf(late))).toMatchObject({ ok: false, code: "codigo_vencido" });
    expect(db.tables.agent_actions!.find((a) => a.order_id === "ord-3")).toMatchObject({ status: "rechazada", error_code: "codigo_vencido" });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("si lo apagan entre la vista previa y la confirmación, no se envía", async () => {
    const { actions, db, send } = setup();
    const preview = await actions.previewWhatsapp(ctx, order, { text: "Hola", origin: "chat" });
    db.tables.agent_action_settings![0]!.whatsapp_mode = "apagado";
    expect(await actions.confirm(ctx, order, "whatsapp", codeOf(preview))).toMatchObject({ ok: false, code: "apagado" });
    expect(send).not.toHaveBeenCalled();
    expect(db.tables.agent_actions![0]).toMatchObject({ status: "rechazada", error_code: "apagado" });
  });

  it("un mensaje por pedido cada 4 horas y nunca el mismo texto", async () => {
    const { actions, setNow } = setup();
    const first = await actions.previewWhatsapp(ctx, order, { text: "Hola, ¿confirmamos?", origin: "chat" });
    await actions.confirm(ctx, order, "whatsapp", codeOf(first));
    expect(await actions.previewWhatsapp(ctx, order, { text: "Otro texto", origin: "chat" })).toMatchObject({ ok: false, code: "una_vez" });
    setNow(new Date(NOW.getTime() + 5 * 3600_000));
    expect(await actions.previewWhatsapp(ctx, order, { text: "hola, ¿confirmamos", origin: "chat" })).toMatchObject({ ok: false, code: "una_vez", message: expect.stringContaining("mismo texto") });
  });

  it("dos vistas previas a la vez: la segunda confirmación frena por la primera", async () => {
    const { actions, send } = setup();
    const a = await actions.previewWhatsapp(ctx, order, { text: "Uno", origin: "chat" });
    const b = await actions.previewWhatsapp(ctx, order, { text: "Dos", origin: "chat" });
    await actions.confirm(ctx, order, "whatsapp", codeOf(a));
    expect(await actions.confirm(ctx, order, "whatsapp", codeOf(b))).toMatchObject({ ok: false, code: "una_vez" });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("el tope del día cuenta la organización entera", async () => {
    const seed = { agent_actions: [{ id: "x", org_id: ORG, order_id: "otro", action: "whatsapp", status: "hecha", created_at: "2026-11-08T13:00:00.000Z", resolved_at: "2026-11-08T13:00:00.000Z" }] };
    const { actions } = setup({ settings: { whatsapp_daily_cap: 1 }, seed });
    expect(await actions.previewWhatsapp(ctx, order, { text: "Hola", origin: "chat" })).toMatchObject({ ok: false, code: "tope_diario" });
    // Lo de ayer (día de Lima) no cuenta.
    const yesterday = { agent_actions: [{ ...seed.agent_actions[0], created_at: "2026-11-08T04:59:00.000Z" }] };
    const fresh = setup({ settings: { whatsapp_daily_cap: 1 }, seed: yesterday });
    expect(await fresh.actions.previewWhatsapp(ctx, order, { text: "Hola", origin: "chat" })).toMatchObject({ ok: true });
  });

  it("si Kapso no confirma, queda incierto, en la Actividad, y frena el siguiente", async () => {
    const { actions, db, setNow } = setup({ send: async () => ({ ok: false, error: "timeout", ambiguous: true }) });
    const preview = await actions.previewWhatsapp(ctx, order, { text: "Hola", origin: "chat" });
    expect(await actions.confirm(ctx, order, "whatsapp", codeOf(preview))).toMatchObject({ ok: false, code: "incierto", message: expect.stringContaining("NO lo reintentes") });
    expect(db.tables.agent_actions![0]).toMatchObject({ status: "incierta" });
    expect(db.tables.order_events![0]).toMatchObject({ kind: "agent_whatsapp", reason: expect.stringContaining("puede haber salido") });
    setNow(new Date(NOW.getTime() + 60_000));
    expect(await actions.previewWhatsapp(ctx, order, { text: "Otro", origin: "chat" })).toMatchObject({ ok: false, code: "una_vez" });
  });

  it("si algo se cae a mitad de la confirmación, queda incierta y no se reintenta", async () => {
    const { actions, db } = setup({ send: async () => { throw new Error("boom"); } });
    const preview = await actions.previewWhatsapp(ctx, order, { text: "Hola", origin: "chat" });
    // `sendText` que lanza se toma como «sin respuesta»: incierto.
    expect(await actions.confirm(ctx, order, "whatsapp", codeOf(preview))).toMatchObject({ ok: false, code: "incierto" });
    expect(db.tables.agent_actions![0]).toMatchObject({ status: "incierta" });
  });

  it("si WhatsApp dice que se cerró la ventana: error, sin reintentar", async () => {
    const { actions, db } = setup({ send: async () => ({ ok: false, error: "Re-engagement message", code: 131047 }) });
    const preview = await actions.previewWhatsapp(ctx, order, { text: "Hola", origin: "chat" });
    expect(await actions.confirm(ctx, order, "whatsapp", codeOf(preview))).toMatchObject({ ok: false, code: "ventana_cerrada" });
    expect(db.tables.agent_actions![0]).toMatchObject({ status: "error", error_code: "ventana_cerrada" });
    expect(db.tables.order_events!).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Guía de Aliclik
// ---------------------------------------------------------------------------

describe("guía de Aliclik", () => {
  it("sin «Crear guías de Aliclik» no cotiza", async () => {
    const { actions, quote } = setup({ perms: ["master.edit"] });
    expect(await actions.previewGuide(ctx, order, { origin: "chat" })).toMatchObject({ ok: false, code: "sin_permiso", message: expect.stringContaining("Crear guías de Aliclik") });
    expect(quote).not.toHaveBeenCalled();
  });

  it("lo que dicen las compuertas de Kapta llega tal cual, y no deja vista previa", async () => {
    const { actions, db } = setup({ quote: { ok: false, code: "regla_kapta", message: "Este cliente tiene rechazos en la puerta." } });
    expect(await actions.previewGuide(ctx, order, { origin: "chat" })).toMatchObject({ ok: false, code: "regla_kapta", message: "Este cliente tiene rechazos en la puerta." });
    expect(db.tables.agent_actions!).toEqual([]);
  });

  it("vista previa y creación con el courier y el cobro que se vieron, firmada por el agente", async () => {
    const { actions, db, create } = setup();
    const preview = await actions.previewGuide(ctx, order, { origin: "chat" });
    expect(preview).toMatchObject({ ok: true, data: { paso: "vista_previa", courier: "Urbano", costo_envio: 12, cobrar_en_la_puerta: 89.9 } });
    expect(create).not.toHaveBeenCalled();
    const out = await actions.confirm(ctx, order, "guia_aliclik", codeOf(preview));
    expect(out).toMatchObject({ ok: true, data: { estado: "hecha", guia: "ALI-555" } });
    expect(create).toHaveBeenCalledWith(order, { transportId: 7, collectTotal: 89.9 }, { reason: agentGuideReason("Grok", "chat"), scheduledOn: "2026-11-08" });
    expect(db.tables.agent_actions![0]).toMatchObject({ status: "hecha", details: expect.objectContaining({ guia: "ALI-555" }) });
    // Una guía por pedido.
    expect(await actions.previewGuide(ctx, order, { origin: "chat" })).toMatchObject({ ok: false, code: "una_vez" });
  });

  it("Simulación con rutina: vuelve a cotizar y registra, sin crear", async () => {
    const { actions, create, quote, db } = setup({ settings: { guide_mode: "simulacion" } });
    const preview = await actions.previewGuide(ctx, order, { origin: "rutina" });
    expect(preview).toMatchObject({ ok: true, data: { interruptor: "Simulación" } });
    expect(await actions.confirm(ctx, order, "guia_aliclik", codeOf(preview))).toMatchObject({ ok: true, data: { estado: "simulada" } });
    expect(create).not.toHaveBeenCalled();
    expect(quote).toHaveBeenCalledTimes(2);
    expect(db.tables.agent_actions![0]).toMatchObject({ status: "simulada", mode: "simulacion" });
    // Lo simulado no frena la guía que se pide en el chat.
    expect(await actions.previewGuide(ctx, order, { origin: "chat" })).toMatchObject({ ok: true });
  });

  it("si Aliclik no respondió, queda incierta y no se vuelve a pedir", async () => {
    const { actions } = setup({ created: { status: "incierta", code: "sin_respuesta_aliclik", orderNumber: null, message: "Aliclik no respondió a tiempo y pudo haberla creado." } });
    const preview = await actions.previewGuide(ctx, order, { origin: "chat" });
    expect(await actions.confirm(ctx, order, "guia_aliclik", codeOf(preview))).toMatchObject({ ok: false, code: "incierto", message: expect.stringContaining("NO la vuelvas a pedir") });
    expect(await actions.previewGuide(ctx, order, { origin: "chat" })).toMatchObject({ ok: false, code: "una_vez" });
  });

  it("el tope del día de guías", async () => {
    const seed = { agent_actions: [{ id: "x", org_id: ORG, order_id: "otro", action: "guia_aliclik", status: "hecha", created_at: "2026-11-08T14:00:00.000Z", resolved_at: "2026-11-08T14:00:00.000Z" }] };
    const { actions, quote } = setup({ settings: { guide_daily_cap: 1 }, seed });
    expect(await actions.previewGuide(ctx, order, { origin: "chat" })).toMatchObject({ ok: false, code: "tope_diario" });
    expect(quote).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Las herramientas
// ---------------------------------------------------------------------------

describe("las herramientas de escritura", () => {
  const tool = (name: string) => AGENT_TOOLS.find((t) => t.name === name)!;

  function deps(actions: AgentToolDeps["actions"]): AgentToolDeps {
    const db = memoryDb({ order_master: [{ order_id: "ord-1", store_id: KENKU.id, order_name: "#KP204280", customer_phone: "987654321" }] });
    return {
      admin: db.client,
      now: NOW,
      kapsoKey: async () => null,
      transcript: async () => [],
      conversationByPhone: async () => null,
      actions,
    };
  }

  it("buscan el pedido en las tiendas del token y llaman a la acción que toca", async () => {
    const fake = {
      note: vi.fn(async () => ({ ok: true as const, data: { estado: "hecha" } })),
      previewWhatsapp: vi.fn(async () => ({ ok: true as const, data: {} })),
      previewGuide: vi.fn(async () => ({ ok: true as const, data: {} })),
      confirm: vi.fn(async () => ({ ok: true as const, data: {} })),
    };
    const d = deps(fake);
    await tool("agregar_nota").run(ctx, { pedido: "KP204280", texto: "Hola", origen: "chat" }, d);
    expect(fake.note).toHaveBeenCalledWith(ctx, order, { text: "Hola", origin: "chat" });
    await tool("enviar_whatsapp").run(ctx, { pedido: "#KP204280", texto: "Hola", origen: "rutina" }, d);
    expect(fake.previewWhatsapp).toHaveBeenCalledWith(ctx, order, { text: "Hola", origin: "rutina" });
    await tool("enviar_whatsapp").run(ctx, { pedido: "#KP204280", codigo: "abcdefghij" }, d);
    expect(fake.confirm).toHaveBeenCalledWith(ctx, order, "whatsapp", "abcdefghij");
    await tool("crear_guia_aliclik").run(ctx, { pedido: "#KP204280", origen: "chat" }, d);
    expect(fake.previewGuide).toHaveBeenCalledWith(ctx, order, { origin: "chat" });
    await tool("crear_guia_aliclik").run(ctx, { pedido: "#KP204280", codigo: "abcdefghij" }, d);
    expect(fake.confirm).toHaveBeenCalledWith(ctx, order, "guia_aliclik", "abcdefghij");
    expect(await tool("enviar_whatsapp").run(ctx, { pedido: "#KP204280", texto: "Hola" }, d)).toMatchObject({ ok: false, code: "faltan_datos" });
    expect(await tool("crear_guia_aliclik").run(ctx, { pedido: "#KP204280" }, d)).toMatchObject({ ok: false, code: "faltan_datos" });
    expect(await tool("agregar_nota").run(ctx, { pedido: "#KP999999", texto: "Hola", origen: "chat" }, d)).toMatchObject({ ok: false, code: "no_encontrado" });
  });

  it("sin acciones en el conector, no responden", async () => {
    expect(await tool("agregar_nota").run(ctx, { pedido: "KP204280", texto: "Hola", origen: "chat" }, deps(undefined))).toMatchObject({ ok: false, code: "no_disponible" });
  });

  it("el origen es obligatorio en la nota y solo «chat» o «rutina»", () => {
    expect(tool("agregar_nota").input.safeParse({ pedido: "KP1", texto: "Hola" }).success).toBe(false);
    expect(tool("enviar_whatsapp").input.safeParse({ pedido: "KP1", texto: "Hola", origen: "owner" }).success).toBe(false);
    expect(tool("crear_guia_aliclik").input.safeParse({ pedido: "KP1", origen: "chat", estado: "entregado" }).success).toBe(false);
  });
});

describe("leer_conversacion con Chatby", () => {
  const read = AGENT_TOOLS.find((t) => t.name === "leer_conversacion")!;
  const db = () =>
    memoryDb({
      order_master: [{ order_id: "ord-1", store_id: KENKU.id, order_name: "#KP204280", customer_phone: "987654321" }],
      orders: [{ id: "ord-1", kapso_conversation_id: null, customer_phone: "987654321" }],
    });

  it("trae lo de Chatby aparte, sin enlaces a archivos", async () => {
    const chatby = vi.fn(async (_phone: string): Promise<ChatbyConversation> => ({
      status: "ok" as const,
      userNs: "u1",
      name: null,
      inboxUrl: "https://app.chatby.io/inbox/u1",
      messages: [
        { id: "2", kind: "cliente" as const, at: "2026-11-08T14:05:00.000Z", text: "Sí, confirmo", template: null, button: true, media: null, mediaUrl: null, error: false, agent: null, location: { lat: -12.1, lng: -77.03 } },
        { id: "1", kind: "bot" as const, at: "2026-11-08T14:00:00.000Z", text: "¿Confirmas tu pedido?", template: "confirmacion", button: false, media: "imagen" as const, mediaUrl: "https://cdn.example/x.jpg", error: false, agent: null, location: null },
      ],
    }));
    const out = await read.run(ctx, { pedido: "KP204280" }, { admin: db().client, now: NOW, kapsoKey: async () => "kk", transcript: async () => [], conversationByPhone: async () => null, chatby });
    expect(chatby).toHaveBeenCalledWith("51987654321");
    expect(out).toMatchObject({
      ok: true,
      data: {
        mensajes: [],
        chatby: {
          mensajes: [
            { fecha: "2026-11-08T14:00:00.000Z", autor: "bot", texto: "¿Confirmas tu pedido?", adjunto: "imagen", plantilla: "confirmacion" },
            { fecha: "2026-11-08T14:05:00.000Z", autor: "cliente", texto: "Sí, confirmo", boton: true, ubicacion_enviada: true },
          ],
        },
      },
    });
    expect(JSON.stringify(out)).not.toContain("cdn.example");
    expect(JSON.stringify(out)).not.toContain("-77.03");
  });

  it("si Kapso no está pero Chatby sí, devuelve lo de Chatby; si ninguno, el error de Kapso", async () => {
    const ok = async (): Promise<ChatbyConversation> => ({ status: "sin_conversacion" });
    const out = await read.run(ctx, { pedido: "KP204280" }, { admin: db().client, now: NOW, kapsoKey: async () => null, transcript: async () => [], conversationByPhone: async () => null, chatby: ok });
    expect(out).toMatchObject({ ok: true, data: { nota: "Kenku Peru no tiene Kapso configurado.", chatby: { mensajes: [] } } });
    const none = await read.run(ctx, { pedido: "KP204280" }, { admin: db().client, now: NOW, kapsoKey: async () => null, transcript: async () => [], conversationByPhone: async () => null });
    expect(none).toMatchObject({ ok: false, code: "sin_kapso" });
  });

  it("las notas internas de Chatby se nombran como tales", () => {
    expect(agentChatbyTranscript([{ id: "1", kind: "nota", at: null, text: "Llamar mañana", template: null, button: false, media: null, mediaUrl: null, error: false, agent: "Ana", location: null }])).toEqual([
      { fecha: null, autor: "nota_interna", texto: "Llamar mañana" },
    ]);
  });
});
