// `listar_pedidos` (MOM §42.10) y el botón «Confirmar pedido» de Chatby
// (`chatbyConfirmButtonAt`, MOM §6.1). Lo que se fija:
//   - la etapa entera por páginas, con el total, solo en las tiendas del token;
//   - lo que dijo Chatby sale de `chatby_auto_checks`, sin leer Chatby;
//   - «confirmó con mensaje» es el mensaje completo; el botón solo no confirma;
//   - el botón cuenta solo si es de este pedido.
// Sin red ni base real.

import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AgentContext, AgentScope } from "@/lib/agent-auth";
import { AGENT_TOOLS, LIST_SCAN_MAX, agentChatbyState, type AgentToolDeps } from "@/lib/agent-tools";
import { chatbyConfirmButtonAt, evaluateChatbyConfirmation } from "@/lib/chatby-autoconfirm";
import type { ChatbyMessage } from "@/lib/chatby-conversation";

// ---------------------------------------------------------------------------
// Una base en memoria con orden, rango y conteo.
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

function memoryDb(tables: Record<string, Row[]>) {
  const calls: { table: string; ops: unknown[][] }[] = [];
  function builder(table: string) {
    const ops: unknown[][] = [];
    calls.push({ table, ops });
    const filters: ((r: Row) => boolean)[] = [];
    const orders: { col: string; asc: boolean }[] = [];
    let count = false;
    let range: [number, number] | null = null;
    let limit: number | null = null;
    function run() {
      let rows = (tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
      for (const o of [...orders].reverse()) {
        rows = [...rows].sort((a, b) => String(a[o.col] ?? "").localeCompare(String(b[o.col] ?? "")) * (o.asc ? 1 : -1));
      }
      const total = rows.length;
      if (range) rows = rows.slice(range[0], range[1] + 1);
      if (limit != null) rows = rows.slice(0, limit);
      return { data: rows.map((r) => ({ ...r })), error: null, count: count ? total : null };
    }
    const q = {
      select(_cols: string, o?: { count?: string }) {
        ops.push(["select", _cols]);
        if (o?.count) count = true;
        return q;
      },
      eq(col: string, v: unknown) {
        ops.push(["eq", col, v]);
        filters.push((r) => r[col] === v);
        return q;
      },
      in(col: string, vs: unknown[]) {
        ops.push(["in", col, vs]);
        filters.push((r) => vs.includes(r[col]));
        return q;
      },
      order(col: string, o?: { ascending?: boolean }) {
        orders.push({ col, asc: o?.ascending !== false });
        return q;
      },
      range(a: number, b: number) {
        range = [a, b];
        return q;
      },
      limit(n: number) {
        limit = n;
        return q;
      },
      then(resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) {
        return Promise.resolve(run()).then(resolve, reject);
      },
    };
    return q;
  }
  return { client: { from: (t: string) => builder(t) } as unknown as SupabaseClient, calls };
}

const KENKU = { id: "00000000-0000-4000-8000-000000000001", name: "Kenku Peru" };
const AURELA = { id: "00000000-0000-4000-8000-000000000002", name: "Aurela" };
const OTHER = "00000000-0000-4000-8000-0000000000ff";

const ctx: AgentContext = {
  tokenId: "tok-1",
  orgId: "org-1",
  userId: "user-1",
  label: "Grok",
  scopes: new Set<AgentScope>(["pedidos.leer"]),
  stores: [KENKU, AURELA],
};

function order(n: number, over: Row = {}): Row {
  return {
    order_id: `o${n}`,
    store_id: KENKU.id,
    order_name: `#KP2040${String(n).padStart(2, "0")}`,
    order_created_at: `2026-11-0${(n % 8) + 1}T12:00:00Z`,
    customer_name: `Clienta ${n}`,
    customer_phone: "51987654321",
    district: "Arequipa",
    province: "Arequipa",
    region: "Arequipa",
    order_total: 149,
    macro_stage: "por_confirmar",
    macro_substage: "por_confirmar",
    macro_operation: "provincia_cod",
    guide_code: null,
    last_movement_at: null,
    ...over,
  };
}

const check = (orderId: string, outcome: string, reason: string | null, evidence: Row = {}) => ({
  order_id: orderId,
  outcome,
  reason,
  evidence,
  checked_at: "2026-11-08T17:00:00Z",
});

function deps(tables: Record<string, Row[]>) {
  const db = memoryDb(tables);
  const d: AgentToolDeps = {
    admin: db.client,
    now: new Date("2026-11-08T18:00:00Z"),
    kapsoKey: async () => null,
    transcript: async () => [],
    conversationByPhone: async () => null,
  };
  return { d, calls: db.calls };
}

const tool = AGENT_TOOLS.find((t) => t.name === "listar_pedidos")!;
const run = (args: Record<string, unknown>, d: AgentToolDeps) => tool.run(ctx, tool.input.parse(args), d);

// ---------------------------------------------------------------------------

describe("lo que dijo Chatby", () => {
  it("el mensaje completo es «confirmó con mensaje», con el motivo si quedó para una persona", () => {
    expect(agentChatbyState(check("o1", "confirmado", null))).toMatchObject({ estado: "confirmo_con_mensaje", motivo: null });
    const held = agentChatbyState(check("o1", "para_asesora", "direccion_incompleta"));
    expect(held).toMatchObject({ estado: "confirmo_con_mensaje", motivo: "direccion_incompleta" });
    expect(held.que_dijo).toContain("quedó para una persona: La dirección no tiene el nombre de la calle");
    expect(agentChatbyState(check("o1", "para_asesora", "sin_ubicacion_cerrado")).que_dijo).toContain("Kapta dejó de mirar el chat");
  });

  it("el botón solo no confirma; un rechazo es un rechazo", () => {
    const button = agentChatbyState(check("o1", "sin_confirmacion", "sin_confirmacion", { boton_confirmar_at: "2026-11-08T16:27:00Z" }));
    expect(button).toMatchObject({ estado: "pulso_confirmar", pulso_confirmar: "2026-11-08T16:27:00Z" });
    expect(button.que_dijo).toContain("el botón solo no confirma");
    expect(agentChatbyState(check("o1", "sin_confirmacion", "sin_confirmacion"))).toMatchObject({ estado: "sin_respuesta" });
    expect(agentChatbyState(check("o1", "sin_conversacion", "sin_conversacion"))).toMatchObject({ estado: "sin_respuesta" });
    expect(agentChatbyState(check("o1", "para_asesora", "rechazo"))).toMatchObject({ estado: "rechazo", que_dijo: "La clienta escribió que no quiere el pedido." });
    expect(agentChatbyState(check("o1", "para_asesora", "anulado_en_chat"))).toMatchObject({ estado: "rechazo" });
  });

  it("sin lectura o con la lectura fallida: «no_leido»", () => {
    expect(agentChatbyState(null)).toMatchObject({ estado: "no_leido", leido: null });
    expect(agentChatbyState(check("o1", "error", "chatby"))).toMatchObject({ estado: "no_leido" });
  });
});

describe("listar_pedidos", () => {
  it("la etapa por páginas, con el total y solo en las tiendas del token", async () => {
    const orders = [...Array.from({ length: 7 }, (_, i) => order(i + 1)), order(90, { store_id: OTHER }), order(91, { macro_stage: "preparacion" })];
    const { d, calls } = deps({ order_master: orders, chatby_auto_checks: [check("o1", "para_asesora", "sin_ubicacion")] });
    const out = await run({ etapa: "por_confirmar", por_pagina: 3, pagina: 2 }, d);
    expect(out).toMatchObject({ ok: true, data: { total: 7, pagina: 2, por_pagina: 3, paginas: 3 } });
    const data = (out as { data: { pedidos: { pedido: string; cobertura: string; destino: string; chatby: { estado: string } }[] } }).data;
    expect(data.pedidos).toHaveLength(3);
    expect(data.pedidos[0]).toMatchObject({ cobertura: "Provincia contra entrega", destino: "Arequipa" });
    const master = calls.find((c) => c.table === "order_master")!;
    expect(master.ops).toContainEqual(["in", "store_id", [KENKU.id, AURELA.id]]);
    expect(master.ops).toContainEqual(["eq", "macro_stage", "por_confirmar"]);
    // Lo de Chatby se lee solo para los pedidos de la página.
    const checks = calls.find((c) => c.table === "chatby_auto_checks")!;
    expect((checks.ops.find((o) => o[0] === "in")![2] as string[]).length).toBe(3);
  });

  it("filtra por lo que dijo Chatby: la confirmación expresa, el botón, el rechazo", async () => {
    const tables = {
      order_master: [order(1), order(2), order(3), order(4), order(5), order(6, { macro_operation: "agencia" })],
      chatby_auto_checks: [
        check("o1", "para_asesora", "direccion_incompleta"),
        check("o2", "para_asesora", "mensaje_posterior"),
        check("o3", "sin_confirmacion", "sin_confirmacion", { boton_confirmar_at: "2026-11-08T16:27:00Z" }),
        check("o4", "para_asesora", "rechazo"),
        check("o5", "sin_confirmacion", "sin_confirmacion"),
      ],
    };
    const names = async (args: Record<string, unknown>) => {
      const out = await run({ etapa: "por_confirmar", ...args }, deps(tables).d);
      return ((out as { data: { pedidos: { pedido: string }[] } }).data.pedidos).map((p) => p.pedido).sort();
    };
    expect(await names({ chatby: "confirmo_con_mensaje" })).toEqual(["#KP204001", "#KP204002"]);
    expect(await names({ chatby: "pulso_confirmar" })).toEqual(["#KP204003"]);
    expect(await names({ chatby: "rechazo" })).toEqual(["#KP204004"]);
    expect(await names({ chatby: "sin_respuesta" })).toEqual(["#KP204005"]);
    expect(await names({ chatby: "no_leido" })).toEqual(["#KP204006"]);
    expect(await names({ chatby: "no_leido", cobertura: "provincia_cod" })).toEqual([]);
    const out = await run({ etapa: "por_confirmar", chatby: "confirmo_con_mensaje", por_pagina: 1, pagina: 2 }, deps(tables).d);
    expect(out).toMatchObject({ ok: true, data: { total: 2, paginas: 2, pedidos: [{ chatby: { motivo: expect.any(String) } }] } });
  });

  it("la subetapa tiene que ser de la etapa; la tienda, del token", async () => {
    const { d } = deps({ order_master: [], chatby_auto_checks: [] });
    expect(await run({ etapa: "por_confirmar", subetapa: "en_transito" }, d)).toMatchObject({ ok: false, code: "subetapa_invalida", message: expect.stringContaining("sin_llamar") });
    expect(await run({ etapa: "por_confirmar", tienda: "Biru" }, d)).toMatchObject({ ok: false, code: "tienda_desconocida" });
    expect(await run({ etapa: "por_confirmar", subetapa: "sin_llamar" }, d)).toMatchObject({ ok: true, data: { total: 0, nota: expect.stringContaining("Ningún pedido") } });
  });

  it("con filtro de Chatby y una etapa enorme, pide acotar", async () => {
    const many = Array.from({ length: LIST_SCAN_MAX + 1 }, (_, i) => order(i, { order_id: `x${i}`, macro_stage: "finalizado" }));
    const { d } = deps({ order_master: many, chatby_auto_checks: [] });
    expect(await run({ etapa: "finalizado", chatby: "rechazo" }, d)).toMatchObject({ ok: false, code: "lista_muy_grande" });
  });

  it("hasta 50 por página", () => {
    expect(tool.input.safeParse({ etapa: "por_confirmar", por_pagina: 51 }).success).toBe(false);
    expect(tool.input.safeParse({ etapa: "por_confirmar", estado: "confirmado" }).success).toBe(false);
    expect(tool.input.safeParse({ chatby: "pulso_confirmar" }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// El botón «Confirmar pedido»
// ---------------------------------------------------------------------------

const msg = (over: Partial<ChatbyMessage>): ChatbyMessage => ({
  id: Math.random().toString(36).slice(2),
  kind: "cliente",
  at: "2026-11-08T16:30:00.000Z",
  text: "",
  template: null,
  button: false,
  media: null,
  mediaUrl: null,
  error: false,
  agent: null,
  location: null,
  ...over,
});

describe("chatbyConfirmButtonAt", () => {
  const created = "2026-11-08T16:00:00Z";

  it("el último botón «Confirmar pedido» de la clienta, después del pedido", () => {
    const messages = [
      msg({ kind: "bot", at: "2026-11-08T16:05:00Z", text: "Hola, tu pedido #KP204286 por S/ 149. ¿Confirmas?", template: "confirmacion" }),
      msg({ at: "2026-11-08T16:27:00Z", text: "Confirmar pedido", button: true }),
    ];
    expect(chatbyConfirmButtonAt(messages, "#KP204286", created)).toBe("2026-11-08T16:27:00Z");
  });

  it("no cuenta: antes del pedido, otro botón, lo escrito o la plantilla de otro pedido", () => {
    expect(chatbyConfirmButtonAt([msg({ at: "2026-11-08T15:00:00Z", text: "Confirmar pedido", button: true })], "#KP204286", created)).toBeNull();
    expect(chatbyConfirmButtonAt([msg({ text: "Hablar con un asesor", button: true })], "#KP204286", created)).toBeNull();
    expect(chatbyConfirmButtonAt([msg({ text: "confirmo", button: false })], "#KP204286", created)).toBeNull();
    const other = [
      msg({ kind: "bot", at: "2026-11-08T16:05:00Z", text: "Tu pedido #KP204300 por S/ 89. ¿Confirmas?" }),
      msg({ at: "2026-11-08T16:27:00Z", text: "Confirmar pedido", button: true }),
    ];
    expect(chatbyConfirmButtonAt(other, "#KP204286", created)).toBeNull();
  });

  it("y el botón sigue sin confirmar el pedido", () => {
    const messages = [msg({ at: "2026-11-08T16:27:00Z", text: "Confirmar pedido", button: true })];
    expect(
      evaluateChatbyConfirmation({ messages, orderName: "#KP204286", orderCreatedAt: created, totalAmount: 149, order: { address: "Calle Lima 123" } }),
    ).toEqual({ confirm: false, final: false, reason: "sin_confirmacion" });
  });
});
