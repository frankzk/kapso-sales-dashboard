import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  chatbyCustomerCount,
  chatbyDayLabel,
  chatbyInboxUrl,
  chatbyLimaDay,
  chatbyLimaTime,
  chatbyMentionsOrder,
  chatbyPhone,
  mapChatbyMessages,
  pickChatbySubscriber,
} from "@/lib/chatby-conversation";
import { CHATBY_CACHE_MS, clearChatbyCache, fetchChatbyConversation } from "@/lib/chatby-api";
import { workspaceForDrawerSection } from "@/lib/order-drawer-href";

/**
 * La conversación de Chatby en la ficha del pedido (MOM §25, «Chatby»,
 * 26-10-2026). El contrato es docs/kapta/chatby-conversaciones.md; lo marcado
 * «verificado» ahí se probó el 25-10-2026 contra la API real.
 */

// El ejemplo del documento, como llega: del más nuevo al más viejo.
const EXAMPLE = {
  data: [
    {
      id: 905,
      type: "in",
      msg_type: "postback",
      content: "Confirmar Dirección",
      payload: { title: "Confirmar Dirección" },
      ts: 1792952580,
      user_ns: "f99885u1000000001",
    },
    {
      id: 904,
      type: "note",
      msg_type: "text",
      content: "PEDIDO CONFIRMADO",
      payload: { text: "PEDIDO CONFIRMADO" },
      ts: 1792952574,
      user_ns: "f99885u1000000001",
    },
    {
      id: 903,
      type: "out",
      msg_type: "wa_template",
      content: "ES nuevo_pedido_cobertura_lima",
      payload: {
        name: "nuevo_pedido_cobertura_lima",
        category: "MARKETING",
        language: "es",
        body: "¡Hola Ana Pérez! Te saluda … de Kenku. Hemos recibido tu pedido #KP200123. …",
      },
      ts: 1792951020,
      user_ns: "f99885u1000000001",
    },
  ],
};

// Lo que no debe salir nunca de la lectura: los campos del contacto traen la
// clave de pedidos de una tienda («[chatby] ConexionTienda», verificado).
const STORE_KEY_IN_USER_FIELDS = "ck_clave_de_la_tienda_que_no_debe_salir";
const SUBSCRIBERS = {
  data: [
    {
      user_ns: "f99885u1000000001",
      name: "Ana Pérez",
      phone: "+51987654321",
      last_message_at: "2026-10-25T18:23:00Z",
      user_fields: [{ name: "[chatby] ConexionTienda", value: STORE_KEY_IN_USER_FIELDS }],
    },
  ],
};

describe("chatbyPhone: el celular como lo busca Chatby", () => {
  it("con el + delante: «51…» o los 9 dígitos solos devuelven 0 resultados (verificado)", () => {
    expect(chatbyPhone("51987654321")).toBe("+51987654321");
    expect(chatbyPhone("987654321")).toBe("+51987654321");
    expect(chatbyPhone("+51 987 654 321")).toBe("+51987654321");
    expect(chatbyPhone("+34612345678")).toBe("+34612345678");
  });

  it("lo que no es un celular no se busca", () => {
    expect(chatbyPhone(null)).toBeNull();
    expect(chatbyPhone("")).toBeNull();
    expect(chatbyPhone("012345678")).toBeNull();
    expect(chatbyPhone("4567")).toBeNull();
  });
});

describe("pickChatbySubscriber: de la clienta, solo el user_ns y el nombre", () => {
  it("no copia los campos del contacto (user_fields)", () => {
    const sub = pickChatbySubscriber(SUBSCRIBERS);
    expect(sub).toEqual({ userNs: "f99885u1000000001", name: "Ana Pérez" });
    expect(JSON.stringify(sub)).not.toContain(STORE_KEY_IN_USER_FIELDS);
  });

  it("con más de una, la del mensaje más reciente; sin ninguna, null", () => {
    const sub = pickChatbySubscriber({
      data: [
        { user_ns: "viejo", last_message_at: "2026-09-01T00:00:00Z" },
        { user_ns: "nuevo", last_message_at: "2026-10-25T00:00:00Z" },
      ],
    });
    expect(sub?.userNs).toBe("nuevo");
    expect(pickChatbySubscriber({ data: [] })).toBeNull();
    expect(pickChatbySubscriber(null)).toBeNull();
  });

  it("un user_ns que no es seguro para la dirección de Chatby no se usa", () => {
    expect(pickChatbySubscriber({ data: [{ user_ns: "../otra?x=1" }] })).toBeNull();
    expect(chatbyInboxUrl("f99885u1000000001")).toBe("https://app.chatby.io/inbox/f99885u1000000001");
  });
});

describe("mapChatbyMessages: lo que se muestra de cada mensaje", () => {
  it("el ejemplo del documento, del más viejo al más nuevo, en hora de Lima", () => {
    const messages = mapChatbyMessages(EXAMPLE);
    expect(messages.map((m) => m.id)).toEqual(["903", "904", "905"]);
    const [template, note, button] = messages;
    expect(template).toMatchObject({ kind: "bot", template: "nuevo_pedido_cobertura_lima", button: false });
    expect(template!.text).toContain("Hemos recibido tu pedido #KP200123");
    expect(chatbyLimaTime(template!.at)).toBe("12:57");
    expect(note).toMatchObject({ kind: "nota", text: "PEDIDO CONFIRMADO" });
    expect(chatbyLimaTime(note!.at)).toBe("13:22");
    expect(button).toMatchObject({ kind: "cliente", button: true, text: "Confirmar Dirección" });
    expect(chatbyLimaTime(button!.at)).toBe("13:23");
    expect(chatbyLimaDay(button!.at)).toBe("2026-10-25");
  });

  it("la plantilla sin `payload.body` muestra `content`", () => {
    const [m] = mapChatbyMessages({ data: [{ id: 1, type: "out", msg_type: "wa_template", content: "ES plantilla_x", payload: { name: "plantilla_x" }, ts: 1 }] });
    expect(m).toMatchObject({ template: "plantilla_x", text: "ES plantilla_x" });
  });

  it("el equipo con su nombre, el error de WhatsApp marcado y los eventos internos fuera", () => {
    const messages = mapChatbyMessages({
      data: [
        { id: 3, type: "system", msg_type: "text", content: "Tag added CONFIRMADO", ts: 30 },
        { id: 2, type: "out", msg_type: "error", content: "This message was not delivered", ts: 20 },
        { id: 1, type: "agent", msg_type: "text", content: "Hola, te escribo del equipo", username: "Lucía", ts: 10 },
      ],
    });
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({ kind: "equipo", agent: "Lucía" });
    expect(messages[1]).toMatchObject({ error: true, text: "This message was not delivered" });
  });

  it("un archivo solo enlaza a https", () => {
    const messages = mapChatbyMessages({
      data: [
        { id: 2, type: "in", msg_type: "image", content: "", payload: { url: "javascript:alert(1)" }, ts: 20 },
        { id: 1, type: "in", msg_type: "image", content: "", payload: { url: "https://cdn.chatby.io/a.jpg" }, ts: 10 },
      ],
    });
    expect(messages.map((m) => m.mediaUrl)).toEqual(["https://cdn.chatby.io/a.jpg", null]);
    expect(messages.every((m) => m.media === "imagen")).toBe(true);
  });
});

describe("chatbyCustomerCount: la cifra de la pestaña", () => {
  it("cuenta solo lo que mandó la clienta (texto, botón o archivo), no al bot, al equipo ni las notas", () => {
    expect(chatbyCustomerCount(mapChatbyMessages(EXAMPLE))).toBe(1);
    expect(chatbyCustomerCount([{ kind: "nota" }, { kind: "bot" }, { kind: "equipo" }])).toBe(0);
    expect(chatbyCustomerCount([{ kind: "cliente" }, { kind: "cliente" }, { kind: "bot" }])).toBe(2);
  });
});

describe("chatbyMentionsOrder: el mensaje que nombra este pedido", () => {
  it("con o sin #, sin confundir un número con otro más largo", () => {
    expect(chatbyMentionsOrder({ text: "Hemos recibido tu pedido #KP200123. Gracias" }, "#KP200123")).toBe(true);
    expect(chatbyMentionsOrder({ text: "pedido kp200123" }, "#KP200123")).toBe(true);
    expect(chatbyMentionsOrder({ text: "pedido #KP2001234" }, "#KP200123")).toBe(false);
    expect(chatbyMentionsOrder({ text: "pedido #AUR178618" }, "#KP200123")).toBe(false);
    expect(chatbyMentionsOrder({ text: "algo" }, null)).toBe(false);
  });
});

describe("chatbyDayLabel: el día en Lima", () => {
  it("Hoy, Ayer o la fecha", () => {
    const now = new Date("2026-10-26T15:00:00Z"); // 10:00 en Lima
    expect(chatbyDayLabel("2026-10-26", now)).toBe("Hoy");
    expect(chatbyDayLabel("2026-10-25", now)).toBe("Ayer");
    expect(chatbyDayLabel("2026-10-20", now)).toBe("20-10-2026");
  });
});

describe("fetchChatbyConversation: las dos lecturas, y nada más", () => {
  afterEach(() => {
    clearChatbyCache();
    vi.restoreAllMocks();
  });

  function okFetch() {
    return vi.fn(async (url: string | URL | Request, _init?: RequestInit) => {
      const u = String(url);
      const body = u.includes("/subscribers?") ? SUBSCRIBERS : EXAMPLE;
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    });
  }

  it("busca con +51 codificado, pide 20 con el bot y las notas, solo GET, con la clave en la cabecera", async () => {
    const fetchImpl = okFetch();
    const out = await fetchChatbyConversation({ phone: "51987654321", apiKey: " clave-kapta ", fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(out.status).toBe("ok");
    const calls = fetchImpl.mock.calls.map(([url, init]) => ({ url: String(url), init: init ?? {} }));
    expect(calls.map((c) => c.url)).toEqual([
      "https://app.chatby.io/api/subscribers?phone=%2B51987654321&limit=5",
      "https://app.chatby.io/api/subscriber/chat-messages?user_ns=f99885u1000000001&limit=20&include_bot=1&include_note=1",
    ]);
    for (const { init } of calls) {
      expect(init.method).toBe("GET");
      expect((init.headers as Record<string, string>).Authorization).toBe("Bearer clave-kapta");
    }
    if (out.status !== "ok") throw new Error("esperaba ok");
    expect(out.inboxUrl).toBe("https://app.chatby.io/inbox/f99885u1000000001");
    expect(out.messages).toHaveLength(3);
    expect(JSON.stringify(out)).not.toContain(STORE_KEY_IN_USER_FIELDS);
  });

  it("un minuto de caché: abrir otra vez la pestaña no vuelve a llamar", async () => {
    const fetchImpl = okFetch();
    let t = 1_000_000;
    const run = () => fetchChatbyConversation({ phone: "987654321", apiKey: "k", fetchImpl: fetchImpl as unknown as typeof fetch, now: () => t });
    await run();
    await run();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    t += CHATBY_CACHE_MS + 1;
    await run();
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it("sin clave o sin celular, no llama", async () => {
    const fetchImpl = okFetch();
    expect(await fetchChatbyConversation({ phone: "51987654321", apiKey: "", fetchImpl: fetchImpl as unknown as typeof fetch })).toEqual({ status: "sin_clave" });
    expect(await fetchChatbyConversation({ phone: null, apiKey: "k", fetchImpl: fetchImpl as unknown as typeof fetch })).toEqual({ status: "sin_celular" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("0 resultados: la clienta no tiene conversación", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 }));
    expect(await fetchChatbyConversation({ phone: "51987654321", apiKey: "k", fetchImpl: fetchImpl as unknown as typeof fetch })).toEqual({
      status: "sin_conversacion",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("401: la clave está mal o la revocaron; el registro no lleva ni la clave ni el celular", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ message: "Unauthenticated." }), { status: 401 }));
    const out = await fetchChatbyConversation({ phone: "51987654321", apiKey: "clave-secreta", fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(out).toMatchObject({ status: "error", inboxUrl: null });
    if (out.status === "error") expect(out.message).toContain("rechazó la clave");
    const logged = log.mock.calls.flat().join(" ");
    expect(logged).not.toContain("clave-secreta");
    expect(logged).not.toContain("987654321");
  });

  it("si fallan los mensajes, el botón «Abrir en Chatby» sigue", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchImpl = vi.fn(async (url: string | URL | Request) =>
      String(url).includes("/subscribers?")
        ? new Response(JSON.stringify(SUBSCRIBERS), { status: 200 })
        : new Response(JSON.stringify({ message: "start_time fuera de rango" }), { status: 400 }),
    );
    const out = await fetchChatbyConversation({ phone: "51987654321", apiKey: "k", fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(out).toEqual({
      status: "error",
      message: "Chatby respondió 400: start_time fuera de rango.",
      inboxUrl: "https://app.chatby.io/inbox/f99885u1000000001",
    });
  });

  it("si Chatby no contesta, corta y lo dice", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchImpl = vi.fn(async () => {
      const error = new Error("aborted");
      error.name = "AbortError";
      throw error;
    });
    const out = await fetchChatbyConversation({ phone: "51987654321", apiKey: "k", fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(out).toMatchObject({ status: "error", message: "Chatby no respondió en 5 segundos." });
  });
});

describe("la ficha y el MOM", () => {
  it("?seccion=chatby abre la pestaña", () => {
    expect(workspaceForDrawerSection("chatby")).toBe("chatby");
  });

  it("la clave solo en el servidor: la ficha llama a la acción, nunca a Chatby", () => {
    const panel = readFileSync(resolve(__dirname, "../components/order-chatby-panel.tsx"), "utf8");
    expect(panel).not.toContain("chatby-api");
    expect(panel).not.toContain("process.env");
    expect(panel).toContain("loadOrderChatby");
    const drawer = readFileSync(resolve(__dirname, "../components/order-drawer.tsx"), "utf8");
    expect(drawer).toContain('label: "Chatby"');
    expect(drawer).toContain("count: chatbyCustomerMessages || undefined");
  });

  it("el MOM lo cuenta", () => {
    const mom = readFileSync(resolve(__dirname, "../docs/mom/master-pedidos-v1.md"), "utf8");
    expect(mom).toContain("5. **Chatby (26-10-2026, pedido del owner):**");
    expect(mom).toContain("`CHATBY_API_KEY`");
  });
});
