// Leads → Redes por Zernio (owner, 25-11-2026; MOM §25.4).
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { dmReplyMode, matchStoreForAccount, normalizeZernioEvent, privateReplyAllowed } from "@/lib/social-inbox";
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
