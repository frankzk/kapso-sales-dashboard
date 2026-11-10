import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CHATBY_REPLY_MAX,
  CHATBY_REPLY_PAUSE_MINUTES,
  chatbyReplyText,
  chatbyReplyWindow,
  type ChatbyMessage,
} from "@/lib/chatby-conversation";
import { clearChatbyCache, fetchChatbyConversation, forgetChatbyConversation, sendChatbyReply } from "@/lib/chatby-api";

/**
 * Responder a la clienta por Chatby desde la ficha del pedido (MOM §25,
 * «Chatby», decisión del owner del 02-11-2026): texto, como persona del equipo,
 * solo con la ventana de 24 h de WhatsApp abierta, y con el bot de esa clienta
 * en pausa 60 minutos.
 */

const NOW = new Date("2026-11-02T18:00:00.000Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();
const msg = (kind: ChatbyMessage["kind"], at: string | null): Pick<ChatbyMessage, "kind" | "at"> => ({ kind, at });

describe("chatbyReplyWindow: la ventana de 24 h de WhatsApp", () => {
  it("abierta si la clienta escribió hace menos de 24 h, y dice hasta cuándo", () => {
    const out = chatbyReplyWindow([msg("bot", hoursAgo(30)), msg("cliente", hoursAgo(2)), msg("bot", hoursAgo(1))], NOW);
    expect(out).toEqual({ open: true, closesAt: "2026-11-03T16:00:00.000Z" });
  });

  it("cuenta el último mensaje de la clienta, no el primero", () => {
    const out = chatbyReplyWindow([msg("cliente", hoursAgo(40)), msg("cliente", hoursAgo(23))], NOW);
    expect(out.open).toBe(true);
  });

  it("cerrada si su último mensaje es de hace 24 h o más", () => {
    expect(chatbyReplyWindow([msg("cliente", hoursAgo(24))], NOW)).toEqual({ open: false, lastCustomerAt: hoursAgo(24) });
    expect(chatbyReplyWindow([msg("cliente", hoursAgo(25)), msg("bot", hoursAgo(1))], NOW).open).toBe(false);
  });

  it("cerrada si la clienta no escribió: los del bot, del equipo y las notas no la abren", () => {
    expect(chatbyReplyWindow([msg("bot", hoursAgo(1)), msg("equipo", hoursAgo(1)), msg("nota", hoursAgo(1))], NOW)).toEqual({
      open: false,
      lastCustomerAt: null,
    });
    expect(chatbyReplyWindow([], NOW).open).toBe(false);
    expect(chatbyReplyWindow([msg("cliente", null), msg("cliente", "no es fecha")], NOW).open).toBe(false);
  });
});

describe("chatbyReplyText: lo que se manda", () => {
  it("sin espacios de más y con saltos de línea normales", () => {
    expect(chatbyReplyText("  Hola Rosa,\r\nte escribo de Kenku.  ")).toEqual({ text: "Hola Rosa,\nte escribo de Kenku." });
  });

  it("vacío o demasiado largo: no", () => {
    expect(chatbyReplyText("   ")).toEqual({ error: "El mensaje está vacío." });
    expect("error" in chatbyReplyText("x".repeat(CHATBY_REPLY_MAX + 1))).toBe(true);
    expect(chatbyReplyText("x".repeat(CHATBY_REPLY_MAX))).toEqual({ text: "x".repeat(CHATBY_REPLY_MAX) });
  });
});

describe("sendChatbyReply: el mensaje como persona del equipo y la pausa del bot", () => {
  afterEach(() => {
    clearChatbyCache();
    vi.restoreAllMocks();
  });

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  it("manda el texto con send_as_agent y pausa el bot 60 minutos, con la clave en la cabecera", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => json({ status: "ok" }));
    const out = await sendChatbyReply({
      userNs: "f99885u1000000001",
      text: "Hola, ¿a qué hora te encontramos?",
      apiKey: " clave-kapta ",
      pauseMinutes: CHATBY_REPLY_PAUSE_MINUTES,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(out).toEqual({ status: "ok", paused: true });
    const calls = fetchImpl.mock.calls.map(([url, init]) => ({ url: String(url), init: init ?? {} }));
    expect(calls.map((c) => c.url)).toEqual([
      "https://app.chatby.io/api/subscriber/send-content",
      "https://app.chatby.io/api/subscriber/pause-bot",
    ]);
    for (const { init } of calls) {
      expect(init.method).toBe("POST");
      expect((init.headers as Record<string, string>).Authorization).toBe("Bearer clave-kapta");
    }
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      user_ns: "f99885u1000000001",
      send_as_agent: 1,
      data: { version: "v1", content: { messages: [{ type: "text", text: "Hola, ¿a qué hora te encontramos?" }] } },
    });
    expect(JSON.parse(String(calls[1]?.init.body))).toEqual({ user_ns: "f99885u1000000001", minutes: 60 });
  });

  it("si Chatby rechaza el envío, dice qué respondió y no pausa nada", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchImpl = vi.fn(async () => json({ message: "Outside of the 24 hours window" }, 400));
    const out = await sendChatbyReply({ userNs: "u", text: "hola", apiKey: "k", pauseMinutes: 60, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(out).toEqual({ status: "error", message: "Chatby respondió 400: Outside of the 24 hours window." });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("un 200 con status de error también es error", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchImpl = vi.fn(async () => json({ status: "error", message: "subscriber not found" }));
    const out = await sendChatbyReply({ userNs: "u", text: "hola", apiKey: "k", pauseMinutes: 60, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(out).toEqual({ status: "error", message: "Chatby respondió 200: subscriber not found." });
  });

  it("si la pausa falla, el mensaje igual salió", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchImpl = vi.fn(async (url: string | URL | Request) => (String(url).endsWith("/pause-bot") ? json({}, 500) : json({ status: "ok" })));
    const out = await sendChatbyReply({ userNs: "u", text: "hola", apiKey: "k", pauseMinutes: 60, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(out).toEqual({ status: "ok", paused: false });
  });

  it("la clave rechazada se explica, y sin clave no se llama", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const denied = vi.fn(async () => json({ message: "Unauthenticated." }, 401));
    expect(await sendChatbyReply({ userNs: "u", text: "hola", apiKey: "k", pauseMinutes: 60, fetchImpl: denied as unknown as typeof fetch })).toEqual({
      status: "error",
      message: "Chatby rechazó la clave de Kapta: está mal copiada o la revocaron. Avísale al owner.",
    });
    const unused = vi.fn();
    const out = await sendChatbyReply({ userNs: "u", text: "hola", apiKey: " ", pauseMinutes: 60, fetchImpl: unused as unknown as typeof fetch });
    expect(out.status).toBe("error");
    expect(unused).not.toHaveBeenCalled();
  });

  it("el registro lleva el paso y el código, nunca el texto ni la clave", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchImpl = vi.fn(async () => json({ message: "x" }, 422));
    await sendChatbyReply({ userNs: "u", text: "mi dirección es Jr. Secreto 123", apiKey: "clave-secreta", pauseMinutes: 60, fetchImpl: fetchImpl as unknown as typeof fetch });
    const line = log.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(line).toContain('"paso":"send-content"');
    expect(line).toContain('"status":422');
    expect(line).not.toContain("Secreto");
    expect(line).not.toContain("clave-secreta");
  });
});

describe("forgetChatbyConversation: después de responder se vuelve a leer", () => {
  afterEach(() => clearChatbyCache());

  it("olvida la conversación guardada de ese celular", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) =>
      new Response(JSON.stringify(String(url).includes("/subscribers?") ? { data: [{ user_ns: "u1", name: "Rosa" }] } : { data: [] }), { status: 200 }),
    );
    const run = () => fetchChatbyConversation({ phone: "987654321", apiKey: "k", fetchImpl: fetchImpl as unknown as typeof fetch });
    await run();
    await run();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    forgetChatbyConversation("51987654321");
    await run();
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });
});

describe("la ficha: quién responde y qué queda", () => {
  const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");

  it("la acción pide editar el pedido, la ventana abierta, y anota el mensaje en la Actividad", () => {
    const actions = read("app/dashboard/pedidos/actions.ts");
    const body = actions.slice(actions.indexOf("export async function sendOrderChatbyReply"));
    expect(body).toContain('perms.can("master.edit")');
    expect(body).toContain("authorizeOrder(orderId)");
    expect(body).toContain("chatbyReplyWindow(conversation.messages).open");
    expect(body).toContain("pauseMinutes: CHATBY_REPLY_PAUSE_MINUTES");
    expect(body).toContain('kind: "chatby_message"');
  });

  it("la caja solo sale para quien puede editar, y el drawer le pasa ese permiso", () => {
    const panel = read("components/order-chatby-panel.tsx");
    expect(panel).toMatch(/\{canEdit && \(?\s*<ReplyBox/);
    expect(panel).toContain("badge={canEdit ? undefined : <Badge>Solo lectura</Badge>}");
    expect(read("components/order-drawer.tsx")).toMatch(/<OrderChatbyPanel[\s\S]*?canEdit=\{canEdit\}/);
  });

  it("el mensaje enviado tiene etiqueta e icono en la Actividad", () => {
    expect(read("components/order-master-shared.tsx")).toContain('chatby_message: "Mensaje por WhatsApp (Chatby)"');
    expect(read("lib/order-timeline-fact.ts")).toContain('chatby_message: consulta("mensaje")');
  });
});
