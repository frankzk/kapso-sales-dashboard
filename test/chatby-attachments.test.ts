import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import {
  chatbyAttachmentDisplayName,
  chatbyAttachmentKind,
  chatbyAttachmentNote,
  chatbyAttachmentSizeProblem,
  chatbyAttachmentTypeOfPath,
  isChatbyAttachmentPath,
  shalomTicketShipment,
} from "@/lib/chatby-attachments";
import { chatbyReplyMessages, sendChatbyReply } from "@/lib/chatby-api";

describe("archivos por Chatby desde la ficha (MOM §25, 10-11-2026)", () => {
  it("solo fotos JPG/PNG y PDF, con los topes de WhatsApp", () => {
    expect(chatbyAttachmentKind("image/jpeg")).toEqual({ ext: "jpg", type: "image" });
    expect(chatbyAttachmentKind("image/png")).toEqual({ ext: "png", type: "image" });
    expect(chatbyAttachmentKind("application/pdf")).toEqual({ ext: "pdf", type: "file" });
    expect(chatbyAttachmentKind("image/webp")).toBeNull();
    expect(chatbyAttachmentSizeProblem("image/jpeg", 6 * 1024 * 1024)).toMatch(/5 MB/);
    expect(chatbyAttachmentSizeProblem("application/pdf", 6 * 1024 * 1024)).toBeNull();
    expect(chatbyAttachmentSizeProblem("application/pdf", 17 * 1024 * 1024)).toMatch(/16 MB/);
    expect(chatbyAttachmentSizeProblem("text/plain", 10)).toMatch(/JPG o PNG/);
    expect(chatbyAttachmentSizeProblem("image/png", 0)).toMatch(/vacío/);
  });

  it("solo rutas de ESE pedido", () => {
    expect(isChatbyAttachmentPath("s1/o1/chatby-1-ab.pdf", "s1", "o1")).toBe(true);
    expect(isChatbyAttachmentPath("s1/o2/chatby-1-ab.pdf", "s1", "o1")).toBe(false);
    expect(isChatbyAttachmentPath("s1/o1/comment-1.jpg", "s1", "o1")).toBe(false);
    expect(isChatbyAttachmentPath("s1/o1/chatby-../x.pdf", "s1", "o1")).toBe(false);
    expect(chatbyAttachmentTypeOfPath("s1/o1/chatby-1.PDF")).toBe("file");
    expect(chatbyAttachmentTypeOfPath("s1/o1/chatby-1.jpg")).toBe("image");
  });

  it("el ticket: la guía Shalom por API, no anulada, la más nueva", () => {
    const guides = [
      { id: "a", courier: "shalom", shalom_ose_id: 11, delivery_status: "anulado", created_at: "2026-11-09" },
      { id: "b", courier: "shalom", shalom_ose_id: 12, delivery_status: "pendiente", created_at: "2026-11-05" },
      { id: "c", courier: "shalom", shalom_ose_id: null, delivery_status: "pendiente", created_at: "2026-11-08" },
      { id: "d", courier: "olva", shalom_ose_id: null, delivery_status: "pendiente", created_at: "2026-11-10" },
      { id: "e", courier: "shalom", shalom_ose_id: 13, delivery_status: "en_ruta", created_at: "2026-11-07" },
    ];
    expect(shalomTicketShipment(guides)?.id).toBe("e");
    expect(shalomTicketShipment(guides.filter((g) => g.id !== "e" && g.id !== "b"))).toBeNull();
  });

  it("la nota de la Actividad y el nombre limpio", () => {
    expect(chatbyAttachmentNote({ kind: "shalom_ticket", guideCode: "102371814" })).toBe(
      "Envió el ticket Shalom en PDF (guía 102371814).",
    );
    expect(chatbyAttachmentNote({ kind: "upload", filename: "voucher.pdf" })).toBe("Envió un archivo: voucher.pdf.");
    expect(chatbyAttachmentDisplayName("C:\\fakepath\\Guía <1>.pdf", "x")).toBe("Guía 1.pdf");
    expect(chatbyAttachmentDisplayName("", "foto")).toBe("foto");
  });

  it("send-content lleva el archivo primero y el texto como pie; sin texto, solo el archivo", () => {
    expect(chatbyReplyMessages("Tu ticket", { type: "file", url: "https://x/t.pdf" })).toEqual([
      { type: "file", url: "https://x/t.pdf" },
      { type: "text", text: "Tu ticket" },
    ]);
    expect(chatbyReplyMessages("  ", { type: "image", url: "https://x/a.jpg" })).toEqual([{ type: "image", url: "https://x/a.jpg" }]);
    expect(chatbyReplyMessages("Hola", null)).toEqual([{ type: "text", text: "Hola" }]);
  });

  it("sendChatbyReply manda el adjunto a Chatby", async () => {
    const calls: { url: string; body: unknown }[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) });
      return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await sendChatbyReply({
      userNs: "f1",
      text: "",
      attachment: { type: "file", url: "https://x/t.pdf" },
      apiKey: "k",
      pauseMinutes: 60,
      fetchImpl,
    });
    expect(result).toEqual({ status: "ok", paused: true });
    expect(calls[0]!.body).toEqual({
      user_ns: "f1",
      send_as_agent: 1,
      data: { version: "v1", content: { messages: [{ type: "file", url: "https://x/t.pdf" }] } },
    });
  });

  it("la ficha ofrece el ticket y el adjunto; la acción valida antes de mandar", () => {
    const panel = readFileSync("components/order-chatby-panel.tsx", "utf8");
    expect(panel).toContain("Enviar ticket Shalom (PDF)");
    expect(panel).toContain("Adjuntar foto o PDF");
    const actions = readFileSync("app/dashboard/pedidos/actions.ts", "utf8");
    expect(actions).toMatch(/const attachment = opts\.attachment \? await resolveChatbyAttachment/);
    const mom = readFileSync("docs/mom/master-pedidos-v1.md", "utf8");
    expect(mom).toContain("Archivos y el ticket Shalom en PDF (10-11-2026");
  });
});
