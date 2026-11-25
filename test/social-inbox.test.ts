// Leads → Redes por Zernio (owner, 25-11-2026; MOM §25.4).
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { dmReplyMode, matchStoreForAccount, normalizeZernioEvent, privateReplyAllowed, threadStatusAfter } from "@/lib/social-inbox";
import { verifyZernioSignature } from "@/lib/zernio-signature";

const read = (p: string) => readFileSync(p, "utf8");

// Los ejemplos de la documentación de Zernio (webhooks/inbox), recortados.
const MESSAGE_RECEIVED = {
  id: "evt-1", event: "message.received", timestamp: "2026-01-15T10:00:00Z",
  message: { id: "507f...15", conversationId: "conv-14", platform: "instagram", platformMessageId: "mid-1", direction: "incoming",
    text: "Hi! Is this still available?", attachments: [], sender: { id: "u-1", name: "Sample Customer", username: "sample_customer" },
    sentAt: "2026-01-15T10:00:00.000Z", sentVia: null },
  conversation: { id: "conv-14", participantId: "u-1", participantName: "Sample Customer", participantUsername: "sample_customer", participantPicture: "https://x/a.jpg", status: "active" },
  account: { id: "acc-11", accountId: "acc-11", platform: "instagram", username: "kenku.peru", displayName: "Kenku Peru" },
  profiles: [{ id: "prof-12", externalId: "kenku" }],
};
const COMMENT_RECEIVED = {
  id: "evt-2", event: "comment.received", timestamp: "2026-01-15T10:00:00Z",
  comment: { id: "c-1", postId: null, platformPostId: "p-1", platform: "instagram", text: "Precio?", author: { id: "u-2", username: "jane", isOwnAccount: false },
    createdAt: "2026-01-15T10:00:00.000Z", isReply: false, parentCommentId: null },
  post: { id: "x", platformPostId: "p-1", content: "Nueva crema", imageUrl: null, permalink: "https://www.instagram.com/p/SAMPLE/" },
  account: { id: "acc-11", accountId: "acc-11", platform: "instagram", username: "kenku.peru" },
};

describe("firma de Zernio", () => {
  const body = JSON.stringify(MESSAGE_RECEIVED);
  const sig = createHmac("sha256", "secreto").update(body).digest("hex");
  it("acepta el HMAC-SHA256 hex del cuerpo crudo y rechaza lo demás", () => {
    expect(verifyZernioSignature(body, sig, "secreto")).toBe(true);
    expect(verifyZernioSignature(body, sig.toUpperCase(), "secreto")).toBe(true);
    expect(verifyZernioSignature(body + " ", sig, "secreto")).toBe(false);
    expect(verifyZernioSignature(body, sig, "otro")).toBe(false);
    expect(verifyZernioSignature(body, "abc", "secreto")).toBe(false);
    expect(verifyZernioSignature(body, sig, undefined)).toBe(false);
  });
});

describe("normalizeZernioEvent", () => {
  it("un mensaje directo entrante", () => {
    const ev = normalizeZernioEvent(MESSAGE_RECEIVED);
    expect(ev).toMatchObject({
      kind: "dm",
      account: { accountId: "acc-11", platform: "instagram", profileId: "prof-12" },
      conversation: { externalId: "conv-14", name: "Sample Customer", username: "sample_customer" },
      message: { externalId: "mid-1", direction: "in", text: "Hi! Is this still available?", via: "cliente" },
    });
  });
  it("lo que mandamos por la API es «kapta»; lo escrito en Meta, «nativo»; una automatización, «auto»", () => {
    const sent = (sentVia: string | null) => normalizeZernioEvent({ ...MESSAGE_RECEIVED, event: "message.sent", message: { ...MESSAGE_RECEIVED.message, direction: "outgoing", sentVia } });
    expect(sent("api")).toMatchObject({ message: { direction: "out", via: "kapta" } });
    expect(sent(null)).toMatchObject({ message: { direction: "out", via: "nativo" } });
    expect(sent("workflow")).toMatchObject({ message: { direction: "out", via: "auto" } });
  });
  it("un comentario y su respuesta van al mismo hilo", () => {
    expect(normalizeZernioEvent(COMMENT_RECEIVED)).toMatchObject({
      kind: "comment", post: { id: "p-1", permalink: "https://www.instagram.com/p/SAMPLE/" },
      comment: { id: "c-1", threadId: "c-1", text: "Precio?", isOwn: false },
    });
    const reply = normalizeZernioEvent({ ...COMMENT_RECEIVED, comment: { ...COMMENT_RECEIVED.comment, id: "c-2", isReply: true, parentCommentId: "c-1", author: { id: "page", isOwnAccount: true } } });
    expect(reply).toMatchObject({ comment: { id: "c-2", threadId: "c-1", isOwn: true } });
  });
  it("ignora pruebas, otras redes y eventos que no guarda", () => {
    expect(normalizeZernioEvent({ ...MESSAGE_RECEIVED, test: true })).toBeNull();
    expect(normalizeZernioEvent({ ...MESSAGE_RECEIVED, message: { ...MESSAGE_RECEIVED.message, platform: "whatsapp" }, account: { ...MESSAGE_RECEIVED.account, platform: "whatsapp" } })).toBeNull();
    expect(normalizeZernioEvent({ ...MESSAGE_RECEIVED, event: "message.read" })).toBeNull();
    expect(normalizeZernioEvent({ event: "message.received" })).toBeNull();
  });
  it("conectar y desconectar una cuenta", () => {
    expect(normalizeZernioEvent({ id: "e", event: "account.connected", account: { accountId: "acc-1", platform: "facebook", displayName: "Kenku Peru" } }))
      .toMatchObject({ kind: "account", active: true, account: { accountId: "acc-1", platform: "facebook" } });
    expect(normalizeZernioEvent({ id: "e", event: "account.disconnected", account: { accountId: "acc-1", platform: "facebook" } })).toMatchObject({ active: false });
  });
});

describe("los plazos de Meta", () => {
  const now = new Date("2026-11-25T12:00:00Z");
  it("mensajes directos: 24 h libre, hasta 7 días solo una persona, después cerrado", () => {
    expect(dmReplyMode("2026-11-25T01:00:00Z", now)).toBe("libre");
    expect(dmReplyMode("2026-11-22T12:00:00Z", now)).toBe("humano");
    expect(dmReplyMode("2026-11-17T12:00:00Z", now)).toBe("cerrado");
    expect(dmReplyMode(null, now)).toBe("cerrado");
  });
  it("por privado: una vez y dentro de 7 días del comentario", () => {
    const t = { kind: "comment" as const, private_reply_at: null };
    expect(privateReplyAllowed(t, "2026-11-20T12:00:00Z", now)).toBe(true);
    expect(privateReplyAllowed(t, "2026-11-10T12:00:00Z", now)).toBe(false);
    expect(privateReplyAllowed({ ...t, private_reply_at: "2026-11-24T00:00:00Z" }, "2026-11-20T12:00:00Z", now)).toBe(false);
    expect(privateReplyAllowed({ kind: "dm" as const }, "2026-11-20T12:00:00Z", now)).toBe(false);
  });
});

describe("la tienda de una cuenta por su nombre", () => {
  const stores = [{ id: "k", name: "Kenku Peru" }, { id: "a", name: "Aurela" }];
  it("calza con una sola tienda o con ninguna", () => {
    expect(matchStoreForAccount({ displayName: "Kenku Peru", username: null }, stores)).toBe("k");
    expect(matchStoreForAccount({ displayName: null, username: "aurela.pe" }, stores)).toBe("a");
    expect(matchStoreForAccount({ displayName: "Tiendas Kenku Aurela", username: null }, stores)).toBeNull();
    expect(matchStoreForAccount({ displayName: "Otra marca", username: null }, stores)).toBeNull();
  });
});

describe("el receptor y la pantalla", () => {
  it("el webhook verifica la firma antes de leer y no responde 4xx a un aviso válido", () => {
    const route = read("app/api/webhooks/zernio/route.ts");
    expect(route.indexOf("verifyZernioSignature")).toBeLessThan(route.indexOf("JSON.parse(raw)"));
    expect(route).toContain('if (insertError.code === "23505") return NextResponse.json({ ok: true, outcome: "duplicate" });');
    // El único 4xx es la firma mala (401).
    expect([...route.matchAll(/status: (4\d\d)/g)].map((m) => m[1])).toEqual(["401"]);
  });
  it("los envíos llevan llave de idempotencia y el menú tiene Redes", () => {
    expect(read("lib/zernio.ts")).toContain('headers["Idempotency-Key"] = opts.idempotencyKey;');
    expect(read("components/sidebar.tsx")).toContain('href: "/dashboard/leads/redes"');
  });
});

import { autoTexts, fillAutoText, hasBuyingIntent, whatsappLink, DEFAULT_PRIVATE_TEXT } from "@/lib/social-auto";

describe("respuestas automáticas (fase 3)", () => {
  it("detecta las preguntas de compra por palabra, sin tildes, y no los reclamos", () => {
    expect(hasBuyingIntent("Precio?")).toBe(true);
    expect(hasBuyingIntent("cuánto cuesta y envían a provincia")).toBe(true);
    expect(hasBuyingIntent("Info por interno porfa 🙏")).toBe(true);
    expect(hasBuyingIntent("Me interesa")).toBe(true);
    expect(hasBuyingIntent("Nunca llegó mi pedido, quiero mi dinero")).toBe(false);
    expect(hasBuyingIntent("Hermoso 😍")).toBe(false);
    expect(hasBuyingIntent("preciosa")).toBe(false);
    expect(hasBuyingIntent("", ["precio"])).toBe(false);
  });
  it("llena los datos y, si falta uno, no inventa: cae al texto sin él", () => {
    const wa = "https://wa.me/51989256981?text=Hola";
    expect(fillAutoText(DEFAULT_PRIVATE_TEXT, { producto: "Nattokinase", precio: 89, whatsapp: wa }))
      .toBe(`Hola 👋 Nattokinase está a S/ 89. Escríbenos por WhatsApp y te lo enviamos: ${wa}`);
    expect(fillAutoText(DEFAULT_PRIVATE_TEXT, { producto: "Nattokinase", precio: null, whatsapp: wa })).toBeNull();
    expect(autoTexts({ public_text: null, private_text: null, dm_text: null }, { producto: "Nattokinase", precio: null, whatsapp: wa }).privateText)
      .toBe(`Hola 👋 Escríbenos por WhatsApp y te contamos el precio y el envío: ${wa}`);
    expect(autoTexts({ public_text: null, private_text: null, dm_text: null }, { whatsapp: wa, nombre: "María Torres" }).dmText)
      .toBe(`¡Hola María! 👋 Gracias por escribirnos. Para atenderte más rápido escríbenos por WhatsApp: ${wa}`);
    expect(autoTexts({ public_text: null, private_text: null, dm_text: null }, { whatsapp: wa }).dmText).toMatch(/^¡Hola! 👋/);
    expect(fillAutoText("S/ {precio}", { precio: 89.9 })).toBe("S/ 89.90");
  });
  it("el enlace de WhatsApp de la tienda", () => {
    expect(whatsappLink("+51 989 256 981", "Hola, quiero Nattokinase")).toBe("https://wa.me/51989256981?text=Hola%2C%20quiero%20Nattokinase");
    expect(whatsappLink("989256981", "x")).toBe("https://wa.me/51989256981?text=x");
    expect(whatsappLink(null, "x")).toBeNull();
  });
  it("lo automático corre después de responder a Zernio, una vez por comentario o conversación", () => {
    const route = read("app/api/webhooks/zernio/route.ts");
    expect(route).toContain("after(async () => {");
    const auto = read("lib/social-auto-server.ts");
    expect(auto).toContain("idempotencyKey: `auto:pub:${ev.comment.id}`");
    expect(auto).toContain("idempotencyKey: `auto:priv:${ev.comment.id}`");
    expect(auto).toContain("idempotencyKey: `auto:dm:${thread.id}`");
    expect(auto).toContain("if (!settings?.enabled) return [];");
    expect(read("db/migrations/0354_social_inbox.sql")).toContain("enabled           boolean not null default false");
  });
  it("abrir un hilo lo reserva 10 minutos y responder lo pide libre (fase 2)", () => {
    const actions = read("app/dashboard/leads/redes/actions.ts");
    expect(actions).toContain("const CLAIM_MS = 10 * 60_000;");
    expect(actions).toContain("if (heldByOther(thread, userId)) return { ok: false, error: `La está atendiendo");
  });
});

describe("lo antiguo entra resuelto (owner, 25-11-2026)", () => {
  const now = new Date("2026-11-25T12:00:00Z");
  it("lo de la clienta de los últimos 7 días espera respuesta", () => {
    expect(threadStatusAfter("abierto", { direction: "in", occurredAt: "2026-11-20T12:00:00Z" }, now)).toBe("abierto");
    expect(threadStatusAfter("cerrado", { direction: "in", occurredAt: "2026-11-25T11:00:00Z" }, now)).toBe("abierto");
  });
  it("lo de la clienta de más de 7 días queda resuelto", () => {
    expect(threadStatusAfter("abierto", { direction: "in", occurredAt: "2026-11-17T11:00:00Z" }, now)).toBe("cerrado");
    expect(threadStatusAfter("abierto", { direction: "in", occurredAt: "2026-03-23T14:10:27Z" }, now)).toBe("cerrado");
  });
  it("lo nuestro lo deja respondido, o resuelto si ya lo estaba", () => {
    expect(threadStatusAfter("abierto", { direction: "out", occurredAt: "2026-11-25T11:00:00Z" }, now)).toBe("respondido");
    expect(threadStatusAfter("cerrado", { direction: "out", occurredAt: "2026-11-25T11:00:00Z" }, now)).toBe("cerrado");
  });
  it("el MOM lo cuenta", () => {
    expect(read("docs/mom/master-pedidos-v1.md")).toContain("más de 7 días entra resuelto");
  });
});
