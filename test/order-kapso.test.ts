// La pestaña «Kapso» de la ficha del pedido (MOM §25, ítem 6; 08-11-2026): la
// conversación de la clienta con el bot de Kapso, solo para leer. Lo que se
// fija:
//   - los mensajes con la anatomía de Chatby: la clienta a la izquierda, la
//     tienda a la derecha, en orden, los últimos 100, sin enlaces a archivos;
//   - qué conversación: la del pedido, la del lead, o la última del celular;
//   - con la clave de Kapso de la tienda del pedido, y sin acceso no lee nada;
//   - no escribe nada en la base;
//   - el MOM y la URL (`?seccion=kapso`) lo citan.
// Sin red ni base real.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationMessage } from "@/lib/kapso";
import { KAPSO_THREAD_LIMIT, kapsoInboxUrl, kapsoThreadMessages } from "@/lib/order-kapso";
import { isOrderDrawerSection, workspaceForDrawerSection } from "@/lib/order-drawer-href";

const msg = (over: Partial<ConversationMessage>): ConversationMessage => ({
  id: null,
  dir: "inbound",
  t: Date.UTC(2026, 10, 8, 16, 9),
  text: "",
  mediaKind: null,
  mediaUrl: null,
  status: null,
  ...over,
});

describe("kapsoThreadMessages", () => {
  it("la clienta a la izquierda, la tienda a la derecha, del más antiguo al más nuevo, sin enlaces", () => {
    const out = kapsoThreadMessages([
      msg({ id: "b", dir: "outbound", t: Date.UTC(2026, 10, 8, 16, 9, 30), text: "¡Listo Melecio! Tu pedido quedó registrado con éxito. Código de pedido: #KP204280", templateName: null }),
      msg({ id: "a", dir: "inbound", t: Date.UTC(2026, 10, 8, 16, 9), text: "Confirmar pedido" }),
      msg({ id: "c", dir: "inbound", t: Date.UTC(2026, 10, 8, 16, 10), mediaKind: "image", mediaUrl: "https://app.kapso.ai/blob/secret.jpg" }),
    ]);
    expect(out.map((m) => [m.id, m.kind])).toEqual([["a", "cliente"], ["b", "otro"], ["c", "cliente"]]);
    expect(out[0]).toMatchObject({ at: "2026-11-08T16:09:00.000Z", text: "Confirmar pedido", template: null, button: false, media: null, error: false });
    expect(out[2]).toMatchObject({ media: "imagen", mediaUrl: null });
    expect(JSON.stringify(out)).not.toContain("secret.jpg");
  });

  it("plantillas, tipos de adjunto y envíos que WhatsApp no entregó", () => {
    const [tpl, doc, failed, sticker] = kapsoThreadMessages([
      msg({ id: "1", dir: "outbound", t: 1, text: "Hola", templateName: "carrito_abandonado_1" }),
      msg({ id: "2", dir: "inbound", t: 2, mediaKind: "document" }),
      msg({ id: "3", dir: "outbound", t: 3, text: "No llegó", status: "failed" }),
      msg({ id: "4", dir: "inbound", t: 4, mediaKind: "sticker" }),
    ]);
    expect(tpl).toMatchObject({ kind: "otro", template: "carrito_abandonado_1" });
    expect(doc!.media).toBe("archivo");
    expect(failed!.error).toBe(true);
    expect(sticker!.media).toBe("imagen");
  });

  it("los últimos 100, y un mensaje sin id ni hora no rompe nada", () => {
    const many = Array.from({ length: 150 }, (_, i) => msg({ id: `m${i}`, t: Date.UTC(2026, 10, 1) + i * 1000 }));
    const out = kapsoThreadMessages(many);
    expect(KAPSO_THREAD_LIMIT).toBe(100);
    expect(out).toHaveLength(100);
    expect(out[0]!.id).toBe("m50");
    expect(out[99]!.id).toBe("m149");
    const [odd] = kapsoThreadMessages([msg({ id: null, t: 0, text: "x" })]);
    expect(odd).toMatchObject({ at: null, text: "x" });
    expect(odd!.id).toMatch(/^kapso-/);
  });

  it("la bandeja de Kapso, solo con un proyecto que tenga forma de id", () => {
    expect(kapsoInboxUrl("cf65efcf-38ab-475c-85b3-c2b89f304652", "00cbcfee-9d21")).toBe(
      "https://app.kapso.ai/projects/cf65efcf-38ab-475c-85b3-c2b89f304652/inbox?conversation_id=00cbcfee-9d21",
    );
    expect(kapsoInboxUrl(null, "x")).toBeNull();
    expect(kapsoInboxUrl("../../evil", "x")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// loadOrderKapso
// ---------------------------------------------------------------------------

type Op = [method: string, ...args: unknown[]];
interface Query {
  table: string;
  ops: Op[];
}

const h = vi.hoisted(() => ({
  row: null as Record<string, unknown> | null,
  orderConv: null as string | null,
  leadConv: null as string | null,
  creds: { kapso_api_key: "kk", kapso_project_id: "cf65efcf-38ab-475c-85b3-c2b89f304652" } as Record<string, unknown> | null,
  queries: [] as { table: string; ops: unknown[][] }[],
  listed: [] as { id: string; last_active_at: string }[],
  transcript: vi.fn(async () => [] as ConversationMessage[]),
  listByPhone: vi.fn(async () => [] as unknown[]),
}));

function fakeClient() {
  return {
    from(table: string) {
      const q: Query = { table, ops: [] };
      h.queries.push(q);
      const b: Record<string, unknown> = {};
      for (const m of ["select", "eq", "in", "is", "order", "limit", "insert", "update"]) {
        b[m] = (...args: unknown[]) => {
          q.ops.push([m, ...args]);
          return b;
        };
      }
      b.maybeSingle = async () => {
        if (table === "order_master") return { data: h.row, error: null };
        if (table === "orders") return { data: { kapso_conversation_id: h.orderConv }, error: null };
        if (table === "leads") return { data: h.leadConv ? { kapso_conversation_id: h.leadConv } : null, error: null };
        return { data: null, error: null };
      };
      return b;
    },
    auth: { getUser: async () => ({ data: { user: { id: "u1" } } }) },
  };
}

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/db", () => ({
  createAdminSupabase: () => fakeClient(),
  createServerSupabase: async () => fakeClient(),
}));
vi.mock("@/lib/ingest", async (orig) => ({
  ...(await orig<typeof import("@/lib/ingest")>()),
  getStoreCreds: async () => h.creds,
}));
vi.mock("@/lib/kapso", async (orig) => ({
  ...(await orig<typeof import("@/lib/kapso")>()),
  fetchConversationTranscript: h.transcript,
  listConversationsByPhone: h.listByPhone,
}));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`redirect ${to}`);
  },
}));

describe("loadOrderKapso", () => {
  const STORE = "00000000-0000-4000-8000-000000000001";
  beforeEach(() => {
    h.row = { order_id: "o1", store_id: STORE, order_name: "#KP204280", customer_phone: "51951536052" };
    h.orderConv = null;
    h.leadConv = null;
    h.creds = { kapso_api_key: "kk", kapso_project_id: "cf65efcf-38ab-475c-85b3-c2b89f304652" };
    h.queries = [];
    h.transcript.mockReset().mockResolvedValue([msg({ id: "a", text: "Confirmar pedido" })]);
    h.listByPhone.mockReset().mockResolvedValue([]);
  });

  it("la conversación que guardó el pedido, con la clave de su tienda, y sin escribir nada", async () => {
    const { loadOrderKapso } = await import("@/app/dashboard/pedidos/actions");
    h.orderConv = "conv-pedido";
    h.leadConv = "conv-lead";
    const out = await loadOrderKapso("o1");
    expect(out).toMatchObject({
      status: "ok",
      conversationId: "conv-pedido",
      source: "pedido",
      inboxUrl: "https://app.kapso.ai/projects/cf65efcf-38ab-475c-85b3-c2b89f304652/inbox?conversation_id=conv-pedido",
      messages: [{ kind: "cliente", text: "Confirmar pedido" }],
    });
    expect(h.transcript).toHaveBeenCalledWith({ apiKey: "kk" }, "conv-pedido", 3);
    expect(h.listByPhone).not.toHaveBeenCalled();
    expect(h.queries.some((q) => q.ops.some(([m]) => m === "insert" || m === "update"))).toBe(false);
    // El lead se busca en la tienda del pedido, con el celular normalizado.
    const lead = h.queries.find((q) => q.table === "leads")!;
    expect(lead.ops).toEqual(expect.arrayContaining([["eq", "store_id", STORE], ["eq", "phone", "51951536052"]]));
  });

  it("sin la del pedido, la del lead; sin ninguna, la más reciente del celular", async () => {
    const { loadOrderKapso } = await import("@/app/dashboard/pedidos/actions");
    h.leadConv = "conv-lead";
    expect(await loadOrderKapso("o1")).toMatchObject({ status: "ok", conversationId: "conv-lead", source: "lead" });
    h.leadConv = null;
    h.listByPhone.mockResolvedValue([
      { id: "vieja", last_active_at: "2026-10-01T00:00:00Z" },
      { id: "nueva", last_active_at: "2026-11-08T16:00:00Z" },
    ]);
    expect(await loadOrderKapso("o1")).toMatchObject({ status: "ok", conversationId: "nueva", source: "celular" });
    expect(h.listByPhone).toHaveBeenCalledWith({ apiKey: "kk" }, "51951536052");
  });

  it("sin Kapso, sin celular, sin conversación, sin acceso o con Kapso caído: lo dice", async () => {
    const { loadOrderKapso } = await import("@/app/dashboard/pedidos/actions");
    h.creds = null;
    expect(await loadOrderKapso("o1")).toEqual({ status: "sin_kapso" });
    h.creds = { kapso_api_key: "kk", kapso_project_id: null };
    h.row = { ...h.row!, customer_phone: null };
    expect(await loadOrderKapso("o1")).toEqual({ status: "sin_celular" });
    h.row = { ...h.row!, customer_phone: "951536052" };
    expect(await loadOrderKapso("o1")).toEqual({ status: "sin_conversacion" });
    h.orderConv = "conv";
    h.transcript.mockRejectedValue(new Error("502"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await loadOrderKapso("o1")).toMatchObject({ status: "error", message: expect.stringContaining("Kapso") });
    h.row = null;
    expect(await loadOrderKapso("o1")).toEqual({ status: "error", message: "Sin acceso a este pedido." });
  });
});

describe("MOM y URL", () => {
  it("`?seccion=kapso` abre la pestaña", () => {
    expect(isOrderDrawerSection("kapso")).toBe(true);
    expect(workspaceForDrawerSection("kapso")).toBe("kapso");
  });
  it("§25 la cita", () => {
    const mom = readFileSync(resolve(process.cwd(), "docs/mom/master-pedidos-v1.md"), "utf8").replace(/\s+/g, " ");
    expect(mom).toContain("6. **Kapso (08-11-2026, pedido del owner):**");
    expect(mom).toContain("**no cambia el estado del pedido**");
    expect(mom).toContain("los últimos 100 mensajes");
    expect(mom).toContain("`?seccion=kapso` abre la pestaña");
  });
});
