import { describe, it, expect } from "vitest";
import { parseConversationMessages } from "@/lib/kapso";

// Payload shapes mirror a real Kapso `/whatsapp/messages?fields=kapso(default)`
// page: text bodies under `text.body`, images carry `kapso.media_url` (stable
// app.kapso.ai blob) + `kapso.media_data`, direction under `kapso.direction`,
// timestamps as unix-epoch strings.
describe("parseConversationMessages", () => {
  it("normalizes a mixed transcript (text + image) oldest-first", () => {
    const raw = [
      {
        id: "m3",
        type: "image",
        timestamp: "1700000300",
        image: { id: "img1", url: "https://lookaside.fbsbx.com/expires-soon" },
        kapso: {
          direction: "outbound",
          has_media: true,
          media_url: "https://app.kapso.ai/rails/active_storage/blobs/redirect/abc/voucher.jpeg",
          media_data: { url: "https://app.kapso.ai/.../voucher.jpeg", content_type: "image/jpeg" },
        },
      },
      { id: "m1", type: "text", timestamp: "1700000100", text: { body: "Hola, quiero pedir" }, kapso: { direction: "inbound" } },
      { id: "m2", type: "text", timestamp: "1700000200", text: { body: "¡Claro! ¿A qué distrito?" }, kapso: { direction: "outbound" } },
    ];

    const out = parseConversationMessages(raw);
    expect(out.map((m) => m.id)).toEqual(["m1", "m2", "m3"]); // sorted ascending by time
    expect(out[0]).toMatchObject({ dir: "inbound", text: "Hola, quiero pedir", mediaKind: null, mediaUrl: null });
    expect(out[1]).toMatchObject({ dir: "outbound", text: "¡Claro! ¿A qué distrito?", mediaKind: null });
    // The image bubble: prefers the stable app.kapso.ai media_url over the
    // expiring lookaside link, and classifies as an image.
    expect(out[2]!.dir).toBe("outbound");
    expect(out[2]!.mediaKind).toBe("image");
    expect(out[2]!.mediaUrl).toBe("https://app.kapso.ai/rails/active_storage/blobs/redirect/abc/voucher.jpeg");
  });

  it("falls back to media_data.url when media_url is absent", () => {
    const [m] = parseConversationMessages([
      {
        id: "x",
        type: "image",
        timestamp: "1700000000",
        kapso: { direction: "inbound", has_media: true, media_data: { url: "https://app.kapso.ai/blob/y.jpg", content_type: "image/jpeg" } },
      },
    ]);
    expect(m!.mediaUrl).toBe("https://app.kapso.ai/blob/y.jpg");
    expect(m!.mediaKind).toBe("image");
  });

  it("classifies media kind from content_type when the type field is missing", () => {
    const [m] = parseConversationMessages([
      {
        id: "a",
        timestamp: "1700000000",
        kapso: { direction: "inbound", has_media: true, media_url: "https://app.kapso.ai/blob/a.ogg", media_data: { content_type: "audio/ogg" } },
      },
    ]);
    expect(m!.mediaKind).toBe("audio");
  });

  it("uses an image caption as the bubble text", () => {
    const [m] = parseConversationMessages([
      {
        id: "c",
        type: "image",
        timestamp: "1700000000",
        image: { id: "i", caption: "Mi comprobante de Yape" },
        kapso: { direction: "inbound", has_media: true, media_url: "https://app.kapso.ai/blob/c.jpg" },
      },
    ]);
    expect(m!.text).toBe("Mi comprobante de Yape");
    expect(m!.mediaKind).toBe("image");
  });

  it("drops messages without a usable timestamp and defaults unknown direction to inbound", () => {
    const out = parseConversationMessages([
      { id: "no-time", type: "text", text: { body: "ignored" }, kapso: { direction: "inbound" } },
      { id: "no-dir", type: "text", timestamp: "1700000000", text: { body: "kept" } },
    ]);
    expect(out.map((m) => m.id)).toEqual(["no-dir"]);
    expect(out[0]!.dir).toBe("inbound");
  });
});
