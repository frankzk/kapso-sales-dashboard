import { describe, it, expect } from "vitest";
import {
  listConversations,
  listAllConversations,
  listApiLogs,
  getPhoneHealth,
  nextCursor,
  mapKapsoConversation,
  conversationToLeadSeed,
  parseHandoffPayload,
  parseOrderSignals,
  detectYapePayment,
  collectVoucherCandidates,
  fetchKapsoImageBase64,
  extractReferral,
  fetchConversationSignals,
  fetchConversationTranscript,
  parseConversationMessages,
  mergeTranscripts,
  templateProductParam,
  findConversationIdByPhone,
  listConversationsByPhone,
  classifyKapsoEvent,
  type KapsoClientOpts,
  type ParsedMsg,
} from "@/lib/kapso";

describe("parseOrderSignals (buyer intent from chat messages)", () => {
  // The real josepradorodriguez flow: bot asks district, customer replies, bot
  // builds an order summary with a total.
  const convo: ParsedMsg[] = [
    { t: 1, dir: "outbound", text: "🔥 Promos: 1 und S/ 99 · 3×2 S/ 198\n\n¿A qué distrito sería el envío?" },
    { t: 2, dir: "inbound", text: "Chosica" },
    { t: 3, dir: "outbound", text: "¡Gracias! Chosica es Lima Metropolitana. ¿Te llevas 1 por S/ 99 o el 3×2?" },
    { t: 4, dir: "inbound", text: "3" },
    {
      t: 5,
      dir: "outbound",
      text:
        "Listo, lo agrego a tu pedido.\n\nTu pedido va así:\n- 3 x Set de Pelador de Verduras + Abridor Premium (2 piezas) (3×2: pagas 2 y llevas 3): S/ 198\nEnvío: gratis\nTotal a pagar: S/ 198\n\n¿Avanzamos con tus datos para el envío?",
    },
  ];

  it("extracts district, cart value, item count and summary", () => {
    const s = parseOrderSignals(convo);
    expect(s.district).toBe("Chosica");
    expect(s.cart_value).toBe(198);
    expect(s.cart_item_count).toBe(3);
    expect(s.cart_summary).toBe("Set de Pelador de Verduras + Abridor Premium");
  });

  it("uses the LAST district prompt's reply, not the first (bot re-asks)", () => {
    const s = parseOrderSignals([
      { t: 1, dir: "outbound", text: "¿A qué distrito sería el envío?" },
      { t: 2, dir: "inbound", text: "Hola Deseo 3x2" }, // qty, not a district
      { t: 3, dir: "outbound", text: "Perfecto. ¿A qué distrito sería el envío?" },
      { t: 4, dir: "inbound", text: "Jesús Maria" }, // the real district
      { t: 5, dir: "outbound", text: "Envío: gratis a Jesús María\nTotal a pagar: S/ 158" },
    ]);
    expect(s.district).toBe("Jesús Maria");
  });

  it("falls back to the district echoed in the bot summary/confirmation", () => {
    expect(
      parseOrderSignals([
        { t: 1, dir: "outbound", text: "Tu pedido va así:\n- 1 x X: S/ 79\nEnvío: gratis a Ate\nTotal a pagar: S/ 79" },
      ]).district,
    ).toBe("Ate");
    expect(
      parseOrderSignals([
        { t: 1, dir: "outbound", text: "Ya tengo tu dirección para la entrega en Surco." },
      ]).district,
    ).toBe("Surco");
  });

  it("ignores a district reply that is itself a question", () => {
    const s = parseOrderSignals([
      { t: 1, dir: "outbound", text: "¿A qué distrito sería el envío?" },
      { t: 2, dir: "inbound", text: "¿cuánto cuesta?" },
    ]);
    expect(s.district).toBeNull();
  });

  it("yields all-null when nothing matches", () => {
    const s = parseOrderSignals([
      { t: 1, dir: "inbound", text: "hola" },
      { t: 2, dir: "outbound", text: "¡Hola! ¿En qué te ayudo?" },
    ]);
    expect(s).toEqual({ district: null, cart_value: null, cart_item_count: null, cart_summary: null });
  });

  // ── Parser ensanchado: variantes de total (otros guiones de bot) ────────────
  it("reconoce variantes del total: 'Total:', 'del pedido', 'Monto', 'un total de', 'soles'", () => {
    const cases: [string, number][] = [
      ["Tu pedido:\n- 2 x Colágeno Premium\nTotal: S/ 138", 138],
      ["Resumen:\n- 1 x Shampoo Anticaída\nTotal del pedido: S/. 79", 79],
      ["Monto a pagar: S/149\nPago contra entrega", 149],
      ["Serían 2 frascos, un total de S/ 138 con envío gratis. ¿Confirmamos?", 138],
      ["Tu pedido queda en un total de 138 soles ¿confirmamos?", 138],
    ];
    for (const [text, value] of cases) {
      const s = parseOrderSignals([{ t: 1, dir: "outbound", text }]);
      expect(s.cart_value).toBe(value);
      expect((s.cart_item_count ?? 0) > 0).toBe(true);
    }
  });

  it("NO confunde el total del ENVÍO (ni menciones de producto sin total) con un pedido", () => {
    expect(
      parseOrderSignals([{ t: 1, dir: "outbound", text: "El total del envío: S/ 10 se paga al recibir" }]).cart_value,
    ).toBeNull();
    expect(
      parseOrderSignals([{ t: 1, dir: "inbound", text: "quiero 2 del colágeno" }]).cart_item_count,
    ).toBeNull();
  });

  it("ítems en formatos nuevos: 'Producto x2' y 'N unidades de'", () => {
    const a = parseOrderSignals([
      { t: 1, dir: "outbound", text: "Tu pedido:\n• Colágeno bebible x2\nTotal: S/ 178" },
    ]);
    expect(a.cart_item_count).toBe(2);
    expect(a.cart_summary).toContain("Colágeno");
    const b = parseOrderSignals([
      { t: 1, dir: "outbound", text: "Resumen:\n- 2 unidades de Faja Reductora\nTotal a pagar: S/ 120" },
    ]);
    expect(b.cart_item_count).toBe(2);
    expect(b.cart_summary).toContain("Faja");
  });

  // ── Parser ensanchado: prompts de ubicación + ubicación espontánea ──────────
  it("prompt de ubicación ampliado (ciudad/provincia) — solo cuando es una pregunta", () => {
    const s = parseOrderSignals([
      { t: 1, dir: "outbound", text: "¿A qué ciudad o provincia hacemos el envío?" },
      { t: 2, dir: "inbound", text: "Arequipa" },
    ]);
    expect(s.district).toBe("Arequipa");
    // texto de marketing con "ciudades" SIN pregunta no captura la respuesta
    const n = parseOrderSignals([
      { t: 1, dir: "outbound", text: "Hacemos envíos a todas las ciudades del Perú, entrega en 24-48h." },
      { t: 2, dir: "inbound", text: "genial" },
    ]);
    expect(n.district).toBeNull();
  });

  it("rechaza respuestas de relleno o cantidades como distrito", () => {
    expect(
      parseOrderSignals([
        { t: 1, dir: "outbound", text: "¿A qué distrito sería el envío?" },
        { t: 2, dir: "inbound", text: "ok gracias" },
      ]).district,
    ).toBeNull();
    expect(
      parseOrderSignals([
        { t: 1, dir: "outbound", text: "¿A qué distrito sería el envío?" },
        { t: 2, dir: "inbound", text: "3x2" },
      ]).district,
    ).toBeNull();
  });

  it("captura la ubicación espontánea del cliente ('soy de X' / 'vivo en X')", () => {
    expect(
      parseOrderSignals([{ t: 1, dir: "inbound", text: "Hola, soy de Arequipa y quiero el pack x2" }]).district,
    ).toBe("Arequipa");
    expect(
      parseOrderSignals([{ t: 1, dir: "inbound", text: "vivo en el departamento de Cusco" }]).district,
    ).toBe("Cusco");
    // "vivo en un departamento" (vivienda) NO es una ubicación
    expect(
      parseOrderSignals([{ t: 1, dir: "inbound", text: "vivo en un departamento en el piso cuatro" }]).district,
    ).toBeNull();
  });

  it("el eco NO captura frases conversacionales como distrito (caso real Cecilio)", () => {
    // El bot dijo "te lo envío para cuando quieras ver más modelos con calma"
    // → el eco viejo guardaba "cuando quieras ver mas modelos con calma".
    expect(
      parseOrderSignals([
        { t: 1, dir: "outbound", text: "Te lo envío para cuando quieras ver más modelos con calma 😊" },
      ]).district,
    ).toBeNull();
    expect(
      parseOrderSignals([{ t: 1, dir: "outbound", text: "Ahora te envío el video para que lo veas" }]).district,
    ).toBeNull();
    // Los ecos reales siguen funcionando, artículo incluido.
    expect(
      parseOrderSignals([
        { t: 1, dir: "outbound", text: "Envío: gratis a La Molina\nTotal a pagar: S/ 79" },
      ]).district,
    ).toBe("La Molina");
    // Y un distrito largo real (4 palabras) pasa el filtro.
    expect(
      parseOrderSignals([{ t: 1, dir: "outbound", text: "Perfecto, entrega en San Juan de Lurigancho" }]).district,
    ).toBe("San Juan de Lurigancho");
  });

  it("el prompt del bot sigue mandando sobre la mención espontánea", () => {
    const s = parseOrderSignals([
      { t: 1, dir: "inbound", text: "soy de Trujillo" },
      { t: 2, dir: "outbound", text: "¿A qué distrito sería el envío?" },
      { t: 3, dir: "inbound", text: "San Isidro" },
    ]);
    expect(s.district).toBe("San Isidro");
  });
});

describe("detectYapePayment (Yape/Shalom advance from chat — TEXT/caption only)", () => {
  it("detects an explicit agent confirmation (pago recibido)", () => {
    expect(detectYapePayment([{ t: 1, dir: "outbound", text: "Pago recibido" }])).toBe(true);
  });

  it("detects the customer stating they paid (text, no image)", () => {
    expect(detectYapePayment([
      { t: 1, dir: "outbound", text: "Realiza el adelanto al Yape y envíame el voucher" },
      { t: 2, dir: "inbound", text: "Listo, ya yapeé. Número de operación 21691317" },
    ])).toBe(true);
  });

  it("detects a voucher image whose CAPTION states payment (caption folded into text upstream)", () => {
    expect(detectYapePayment([
      { t: 1, dir: "outbound", text: "Envíame el voucher del adelanto al Yape" },
      { t: 2, dir: "inbound", text: "Ya pagué, aquí está mi comprobante", image: true },
    ])).toBe(true);
  });

  it("does NOT fire on a BARE voucher image with no words — precision over recall", () => {
    // The reported false positive: after a Yape request the customer sends a
    // screenshot with no text. We can't tell a real receipt from a conversation
    // screenshot without reading the image, so a bare image must NOT auto-fire.
    expect(detectYapePayment([
      { t: 1, dir: "outbound", text: "Para separarlo, realiza el adelanto al Yape y envíame el voucher ✅" },
      { t: 2, dir: "inbound", text: "", image: true },
    ])).toBe(false);
  });

  it("does NOT fire when the advance was requested but no proof was sent", () => {
    expect(detectYapePayment([
      { t: 1, dir: "outbound", text: "Para separarlo, realiza el adelanto de S/30 al Yape y envíame el voucher." },
      { t: 2, dir: "inbound", text: "Ok, ahorita lo hago" },
    ])).toBe(false);
  });

  it("does NOT fire on a customer merely asking about Yape (a question, no proof)", () => {
    expect(detectYapePayment([
      { t: 1, dir: "inbound", text: "¿Puedo pagar con Yape?" },
      { t: 2, dir: "outbound", text: "Sí, aceptamos Yape 😊" },
    ])).toBe(false);
  });

  it("does NOT treat a non-payment image (conversation/product screenshot) as an advance", () => {
    expect(detectYapePayment([
      { t: 1, dir: "outbound", text: "¿Te gustaría avanzar con tu pedido?" },
      { t: 2, dir: "inbound", text: "", image: true }, // random screenshot, no Yape words
    ])).toBe(false);
  });
});

const BASE = "https://api.kapso.ai/platform/v1";

interface Capture {
  url: string;
  headers: Record<string, string>;
}

/** Build a fetch mock that records requests and returns `responder(url)`. */
function mockFetch(
  responder: (url: URL) => unknown,
  captures: Capture[],
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const urlStr = String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    captures.push({ url: urlStr, headers });
    const payload = responder(new URL(urlStr));
    return {
      ok: true,
      status: 200,
      json: async () => payload,
      text: async () => JSON.stringify(payload),
    } as Response;
  }) as unknown as typeof fetch;
}

function opts(fetchImpl: typeof fetch): KapsoClientOpts {
  return { apiKey: "kapso_secret_key", baseUrl: BASE, fetchImpl };
}

describe("fetchConversationSignals (real Kapso message shape)", () => {
  it("parses string unix timestamps, direction, district and cart", async () => {
    const caps: Capture[] = [];
    // Newest-first, like the real API; timestamps are unix-seconds STRINGS,
    // direction lives under kapso.direction, text under text.body.
    const messages = [
      {
        id: "m4",
        timestamp: "1782249300",
        type: "text",
        text: {
          body:
            "Listo, lo agrego a tu pedido.\n\nTu pedido va así:\n- 3 x Set de Pelador de Verduras + Abridor Premium (2 piezas) (3x2: pagas 2 y llevas 3): S/ 198\nEnvío: gratis\nTotal a pagar: S/ 198\n\n¿Avanzamos con tus datos?",
        },
        kapso: { direction: "outbound" },
      },
      { id: "m3", timestamp: "1782249200", type: "text", text: { body: "3" }, kapso: { direction: "inbound" } },
      { id: "m2", timestamp: "1782249100", type: "text", text: { body: "Chosica" }, kapso: { direction: "inbound" } },
      {
        id: "m1",
        timestamp: "1782249000",
        type: "text",
        text: { body: "¿A qué distrito sería el envío?" },
        kapso: { direction: "outbound" },
      },
    ];
    const f = mockFetch(() => ({ data: messages, meta: { page: 1 } }), caps);
    const sig = await fetchConversationSignals(opts(f), "conv-123");
    expect(sig).not.toBeNull();
    expect(sig!.inbound_count).toBe(2);
    expect(sig!.district).toBe("Chosica");
    expect(sig!.cart_value).toBe(198);
    expect(sig!.cart_item_count).toBe(3);
    expect(sig!.cart_summary).toBe("Set de Pelador de Verduras + Abridor Premium");
    expect(sig!.first_response_seconds).not.toBeNull();
    expect(new URL(caps[0]!.url).searchParams.get("conversation_id")).toBe("conv-123");
  });

  it("flags yape from an inbound image voucher whose CAPTION states payment", async () => {
    // Real Kapso shapes: an inbound image with a payment caption. The caption is
    // folded into the scanned text, so the Yape detector trips on it.
    const messages = [
      {
        id: "img",
        timestamp: "1782260858",
        type: "image",
        image: { id: "1", mime_type: "image/jpeg", caption: "Ya yapeé, aquí mi comprobante" },
        kapso: { direction: "inbound", has_media: true },
      },
      {
        id: "req",
        timestamp: "1782255723",
        type: "text",
        text: { body: "Realiza el adelanto de S/30 al Yape y envíame el voucher para pasarlo a validación logística ✅" },
        kapso: { direction: "outbound" },
      },
    ];
    const f = mockFetch(() => ({ data: messages }), []);
    const sig = await fetchConversationSignals(opts(f), "c");
    expect(sig).not.toBeNull();
    expect(sig!.yape).toBe(true);
  });

  it("does NOT flag yape from a BARE inbound image (no caption) after a Yape request", async () => {
    // The reported false positive: a customer sends a conversation/product
    // screenshot (no words) after the bot asked for the voucher. Without reading
    // the image we can't call it a receipt, so it must NOT fire the alert.
    const messages = [
      {
        id: "img",
        timestamp: "1782260858",
        type: "image",
        image: { id: "1", mime_type: "image/jpeg" },
        kapso: { direction: "inbound", has_media: true },
      },
      {
        id: "req",
        timestamp: "1782255723",
        type: "text",
        text: { body: "Realiza el adelanto de S/30 al Yape y envíame el voucher ✅" },
        kapso: { direction: "outbound" },
      },
    ];
    const f = mockFetch(() => ({ data: messages }), []);
    const sig = await fetchConversationSignals(opts(f), "c");
    expect(sig).not.toBeNull();
    expect(sig!.yape).toBe(false);
  });

  it("surfaces a bare inbound image (with media URL) after a request as a voucher candidate", async () => {
    // Same false-positive shape, but the image has a stored media_url — so it can
    // be fetched + read by the vision layer. Text stays yape=false; the image is
    // handed off as a candidate.
    const messages = [
      {
        id: "img",
        timestamp: "1782260858",
        type: "image",
        image: { id: "1", mime_type: "image/jpeg" },
        kapso: { direction: "inbound", has_media: true, media_url: "https://app.kapso.ai/media/img.jpg" },
      },
      {
        id: "req",
        timestamp: "1782255723",
        type: "text",
        text: { body: "Realiza el adelanto de S/30 al Yape y envíame el voucher ✅" },
        kapso: { direction: "outbound" },
      },
    ];
    const f = mockFetch(() => ({ data: messages }), []);
    const sig = await fetchConversationSignals(opts(f), "c");
    expect(sig).not.toBeNull();
    expect(sig!.yape).toBe(false);
    expect(sig!.voucherCandidates).toEqual([
      { messageId: "img", mediaUrl: "https://app.kapso.ai/media/img.jpg" },
    ]);
  });

  it("returns null when no messages are readable", async () => {
    const f = mockFetch(() => ({ data: [] }), []);
    expect(await fetchConversationSignals(opts(f), "c")).toBeNull();
  });
});

describe("collectVoucherCandidates (bare voucher images after a request)", () => {
  const req: ParsedMsg = { t: 100, dir: "outbound", text: "Yapea el adelanto y envíame el voucher" };
  const img = (over: Partial<ParsedMsg>): ParsedMsg => ({
    t: 200,
    dir: "inbound",
    text: "",
    image: true,
    id: "m1",
    mediaUrl: "https://app.kapso.ai/media/a.jpg",
    ...over,
  });

  it("returns nothing when the bot never requested a voucher/adelanto", () => {
    expect(collectVoucherCandidates([{ t: 1, dir: "outbound", text: "hola" }, img({})])).toEqual([]);
  });
  it("does NOT open the window on a bare payment-method mention ('aceptamos Yape')", () => {
    expect(collectVoucherCandidates([{ t: 1, dir: "outbound", text: "Sí, aceptamos Yape 😊" }, img({})])).toEqual([]);
  });
  it("collects an inbound image sent after the request", () => {
    expect(collectVoucherCandidates([req, img({})])).toEqual([
      { messageId: "m1", mediaUrl: "https://app.kapso.ai/media/a.jpg" },
    ]);
  });
  it("excludes an image sent BEFORE the request", () => {
    expect(collectVoucherCandidates([img({ t: 50 }), req])).toEqual([]);
  });
  it("excludes images without a fetchable media URL or id", () => {
    expect(collectVoucherCandidates([req, img({ mediaUrl: null })])).toEqual([]);
    expect(collectVoucherCandidates([req, img({ id: null })])).toEqual([]);
  });
  it("excludes non-image and outbound messages", () => {
    expect(collectVoucherCandidates([req, img({ image: false })])).toEqual([]);
    expect(collectVoucherCandidates([req, img({ dir: "outbound" })])).toEqual([]);
  });
  it("dedups by message id", () => {
    const out = collectVoucherCandidates([req, img({ t: 200 }), img({ t: 300 })]);
    expect(out).toHaveLength(1);
  });
});

describe("fetchKapsoImageBase64 (auth'd, host-allowlisted image fetch)", () => {
  function imgFetch(
    bytes: Uint8Array,
    contentType: string,
    capture?: { url?: string; headers?: Record<string, string> },
    init?: { ok?: boolean; status?: number },
  ): typeof fetch {
    return (async (input: RequestInfo | URL, req?: RequestInit) => {
      if (capture) {
        capture.url = String(input);
        capture.headers = (req?.headers ?? {}) as Record<string, string>;
      }
      return {
        ok: init?.ok ?? true,
        status: init?.status ?? 200,
        headers: { get: (h: string) => (h.toLowerCase() === "content-type" ? contentType : null) },
        arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      } as unknown as Response;
    }) as unknown as typeof fetch;
  }

  it("returns base64 + content-type and sends X-API-Key for an allowed host", async () => {
    const cap: { url?: string; headers?: Record<string, string> } = {};
    const f = imgFetch(new Uint8Array([1, 2, 3, 4]), "image/png", cap);
    const res = await fetchKapsoImageBase64(opts(f), "https://app.kapso.ai/media/x.png");
    expect(res).toEqual({ base64: Buffer.from([1, 2, 3, 4]).toString("base64"), contentType: "image/png" });
    expect(cap.headers!["X-API-Key"]).toBe("kapso_secret_key");
  });

  it("follows a redirect to a storage CDN but drops X-API-Key off the Kapso host", async () => {
    // Kapso 3xx's the stored blob to a signed CDN URL. The key must go ONLY to
    // the allowlisted origin, never to the CDN (undici keeps custom headers on
    // cross-origin redirects, so redirect:follow would leak it).
    const calls: { url: string; headers: Record<string, string> }[] = [];
    const f = (async (input: RequestInfo | URL, req?: RequestInit) => {
      const url = String(input);
      calls.push({ url, headers: (req?.headers ?? {}) as Record<string, string> });
      if (url.startsWith("https://app.kapso.ai/")) {
        return {
          status: 302,
          ok: false,
          headers: { get: (h: string) => (h.toLowerCase() === "location" ? "https://cdn.storage.example/signed.jpg?sig=abc" : null) },
        } as unknown as Response;
      }
      return {
        ok: true,
        status: 200,
        headers: { get: (h: string) => (h.toLowerCase() === "content-type" ? "image/jpeg" : null) },
        arrayBuffer: async () => new Uint8Array([9, 9, 9]).buffer,
      } as unknown as Response;
    }) as unknown as typeof fetch;

    const res = await fetchKapsoImageBase64(opts(f), "https://app.kapso.ai/media/x.jpg");
    expect(res).toEqual({ base64: Buffer.from([9, 9, 9]).toString("base64"), contentType: "image/jpeg" });
    expect(calls).toHaveLength(2);
    expect(calls[0]!.headers["X-API-Key"]).toBe("kapso_secret_key"); // Kapso hop: key sent
    expect(calls[1]!.url).toContain("cdn.storage.example");
    expect(calls[1]!.headers["X-API-Key"]).toBeUndefined(); // CDN hop: NO key
  });

  it("refuses a non-allowlisted host (no fetch)", async () => {
    let called = false;
    const f = (async () => {
      called = true;
      return {} as Response;
    }) as unknown as typeof fetch;
    expect(await fetchKapsoImageBase64(opts(f), "https://evil.example.com/x.png")).toBeNull();
    expect(called).toBe(false);
  });

  it("refuses non-https and unparseable URLs", async () => {
    const f = imgFetch(new Uint8Array([1]), "image/png");
    expect(await fetchKapsoImageBase64(opts(f), "http://app.kapso.ai/x.png")).toBeNull();
    expect(await fetchKapsoImageBase64(opts(f), "not a url")).toBeNull();
  });

  it("returns null on a non-2xx response", async () => {
    const f = imgFetch(new Uint8Array([1]), "image/png", undefined, { ok: false, status: 404 });
    expect(await fetchKapsoImageBase64(opts(f), "https://app.kapso.ai/x.png")).toBeNull();
  });

  it("returns null on an empty or oversize body", async () => {
    const empty = imgFetch(new Uint8Array([]), "image/png");
    expect(await fetchKapsoImageBase64(opts(empty), "https://app.kapso.ai/x.png")).toBeNull();
    const huge = imgFetch(new Uint8Array(3_500_001), "image/png");
    expect(await fetchKapsoImageBase64(opts(huge), "https://app.kapso.ai/x.png")).toBeNull();
  });
});

describe("listConversations", () => {
  it("hits /whatsapp/conversations with snake_case params + X-API-Key", async () => {
    const caps: Capture[] = [];
    const f = mockFetch(() => ({ data: [], paging: {} }), caps);
    await listConversations(opts(f), {
      phoneNumberId: "pn_1",
      status: "ended",
      createdAfter: "2026-06-01T00:00:00Z",
      limit: 50,
    });
    const url = new URL(caps[0]!.url);
    expect(url.pathname).toBe("/platform/v1/whatsapp/conversations");
    expect(url.searchParams.get("phone_number_id")).toBe("pn_1");
    expect(url.searchParams.get("status")).toBe("ended");
    expect(url.searchParams.get("created_after")).toBe("2026-06-01T00:00:00Z");
    expect(url.searchParams.get("limit")).toBe("50");
    expect(caps[0]!.headers["X-API-Key"]).toBe("kapso_secret_key");
  });
});

describe("listAllConversations (cursor pagination)", () => {
  it("follows paging.cursors.after until exhausted", async () => {
    const caps: Capture[] = [];
    const f = mockFetch((url) => {
      const after = url.searchParams.get("after");
      if (!after) {
        return { data: [{ id: "a" }], paging: { cursors: { after: "cur1" } } };
      }
      if (after === "cur1") {
        return { data: [{ id: "b" }], paging: { cursors: { after: null } } };
      }
      return { data: [], paging: {} };
    }, caps);

    const all = await listAllConversations(opts(f), { phoneNumberId: "pn_1" });
    expect(all.map((c) => c.id)).toEqual(["a", "b"]);
    expect(caps).toHaveLength(2);
  });
});

describe("getPhoneHealth", () => {
  it("hits the per-number health endpoint", async () => {
    const caps: Capture[] = [];
    const f = mockFetch(() => ({ status: "healthy", timestamp: "t", checks: {} }), caps);
    const health = await getPhoneHealth(opts(f), "pn 1/weird");
    expect(new URL(caps[0]!.url).pathname).toBe(
      "/platform/v1/whatsapp/phone_numbers/pn%201%2Fweird/health",
    );
    expect(health.status).toBe("healthy");
  });
});

describe("listApiLogs", () => {
  it("passes errors_only + period", async () => {
    const caps: Capture[] = [];
    const f = mockFetch(() => ({ data: [], paging: {} }), caps);
    await listApiLogs(opts(f), { errorsOnly: true, period: "24h", statusCode: 500 });
    const url = new URL(caps[0]!.url);
    expect(url.pathname).toBe("/platform/v1/api_logs");
    expect(url.searchParams.get("errors_only")).toBe("true");
    expect(url.searchParams.get("period")).toBe("24h");
    expect(url.searchParams.get("status_code")).toBe("500");
  });
});

describe("helpers", () => {
  it("nextCursor reads cursors.after or next", () => {
    expect(nextCursor({ data: [], paging: { cursors: { after: "x" } } })).toBe("x");
    expect(nextCursor({ data: [], paging: { next: "y" } })).toBe("y");
    expect(nextCursor({ data: [], paging: {} })).toBeNull();
  });

  it("conversationToLeadSeed extracts phone/name/conversation id", () => {
    const seed = conversationToLeadSeed({
      id: "c1",
      phone_number: "51980694766",
      contact_name: "GLORIA",
      last_active_at: "2026-06-22T20:46:56-04:00",
      created_at: "2026-06-22T20:31:26-04:00",
    } as any);
    expect(seed).toMatchObject({ phone: "51980694766", name: "GLORIA", kapso_conversation_id: "c1" });
  });

  it("conversationToLeadSeed returns null without a phone", () => {
    expect(conversationToLeadSeed({ id: "c2" } as any)).toBeNull();
  });

  it("conversationToLeadSeed reads the v2 webhook shape (kapso.contact_name + bsuid)", () => {
    // Shape of `conversation` inside a whatsapp.conversation.ended webhook.
    const seed = conversationToLeadSeed({
      id: "conv_789",
      phone_number: "51980694766",
      phone_number_id: "1241790819006805",
      business_scoped_user_id: "US.13491208655302741918",
      status: "ended",
      last_active_at: "2026-06-22T15:10:45Z",
      created_at: "2026-06-22T14:00:00Z",
      kapso: { contact_name: "GLORIA", last_message_timestamp: "2026-06-22T15:10:45Z" },
    } as any);
    expect(seed).toMatchObject({
      phone: "51980694766",
      name: "GLORIA",
      wa_id: "US.13491208655302741918",
      kapso_conversation_id: "conv_789",
      phone_number_id: "1241790819006805",
      last_interaction_at: "2026-06-22T15:10:45Z",
    });
  });
});

describe("classifyKapsoEvent (webhook routing)", () => {
  it("routes the platform handoff event", () => {
    expect(classifyKapsoEvent("workflow.execution.handoff", {})).toBe("handoff");
  });

  it("routes WhatsApp conversation events (ended/inactive/created)", () => {
    expect(classifyKapsoEvent("whatsapp.conversation.ended", {})).toBe("conversation");
    expect(classifyKapsoEvent("whatsapp.conversation.inactive", {})).toBe("conversation");
    expect(classifyKapsoEvent("whatsapp.conversation.created", {})).toBe("conversation");
  });

  it("skips message events", () => {
    expect(classifyKapsoEvent("whatsapp.message.received", {})).toBe("skip");
    expect(classifyKapsoEvent("whatsapp.message.delivered", {})).toBe("message_status");
  });

  it("falls back to payload shape when no event header", () => {
    expect(classifyKapsoEvent(null, { reason: "validacion_logistica", context_summary: "..." })).toBe("handoff");
    expect(classifyKapsoEvent(undefined, { conversation: { id: "c", phone_number: "51980694766" } })).toBe("conversation");
    expect(classifyKapsoEvent("", {})).toBe("skip");
  });

  it("reads the event from the payload body when present", () => {
    expect(classifyKapsoEvent(null, { event: "whatsapp.conversation.ended" })).toBe("conversation");
    expect(classifyKapsoEvent(null, { type: "whatsapp.message.received", batch: true, data: [] })).toBe("skip");
  });

  it("parseHandoffPayload pulls reason/context/phone (validacion_logistica)", () => {
    const info = parseHandoffPayload({
      conversation: { id: "c3", phone_number: "+51 932 011 088", contact_name: "Berna" },
      reason: "validacion_logistica",
      context_summary: "Cliente envió voucher de adelanto S/30 ... Shalom ...",
    });
    expect(info).toMatchObject({
      conversationId: "c3",
      phone: "51932011088",
      reason: "validacion_logistica",
      name: "Berna",
    });
    expect(info.context).toContain("voucher");
  });

  it("mapKapsoConversation maps platform + kapso-extension shapes", () => {
    const row = mapKapsoConversation(
      {
        id: "conv_1",
        phone_number_id: "pn_1",
        status: "ended",
        created_at: "2026-06-20T10:00:00Z",
        last_active_at: "2026-06-20T11:00:00Z",
        kapso: { messages_count: 12, last_message_timestamp: "2026-06-20T11:00:00Z" },
      },
      "store-1",
    );
    expect(row).toMatchObject({
      store_id: "store-1",
      kapso_conversation_id: "conv_1",
      phone_number_id: "pn_1",
      started_at: "2026-06-20T10:00:00Z",
      status: "ended",
      message_count: 12,
      last_message_at: "2026-06-20T11:00:00Z",
    });
  });
});

describe("extractReferral (Meta ad attribution)", () => {
  it("reads a structured CTWA referral (real ad_id wins)", () => {
    const msgs = [
      { kapso: { direction: "inbound" }, text: { body: "hola" }, referral: { source_type: "ad", source_id: "120800", headline: "✈️ Viaja", ctwa_clid: "clid123" } },
    ];
    expect(extractReferral(msgs)).toEqual({
      source: "meta_ad",
      ad_id: "120800",
      ad_headline: "✈️ Viaja",
      ctwa_clid: "clid123",
    });
  });

  it("falls back to fb_web (NOT meta_ad) for a Facebook/IG web link in the opening message", () => {
    // The real "Sol"/"Carmen" case: ad OR organic post → site → "tengo una consulta"
    // button, UTM in text. No CTWA referral, no ad_id → the weaker fb_web source,
    // kept out of the provable "Meta Ads (campañas)" bucket.
    const msgs = [
      { kapso: { direction: "outbound" }, text: { body: "¡Hola! Soy Akemi de Aurela 😊" } },
      {
        kapso: { direction: "inbound" },
        text: { body: "Tengo una consulta | Aurela https://aurela.pe/products/mochila?utm_content=Facebook_Mobile_Feed" },
      },
    ];
    expect(extractReferral(msgs)).toEqual({ source: "fb_web", ad_id: null, ad_headline: null, ctwa_clid: null });
  });

  it("classifies fbclid / utm_source=facebook web links as fb_web", () => {
    expect(extractReferral([{ kapso: { direction: "inbound" }, text: { body: "vi esto https://x.pe/p?fbclid=AbC" } }])?.source).toBe("fb_web");
    expect(extractReferral([{ kapso: { direction: "inbound" }, text: { body: "https://x.pe/p?utm_source=facebook&utm_medium=cpc" } }])?.source).toBe("fb_web");
  });

  it("still uses meta_ad (not fb_web) when a structured CTWA referral is present", () => {
    // structured referral wins even if the same message also carries a fb link
    const msgs = [
      {
        kapso: { direction: "inbound" },
        text: { body: "hola https://aurela.pe/p?utm_source=facebook" },
        referral: { source_id: "999", headline: "Anuncio" },
      },
    ];
    expect(extractReferral(msgs)?.source).toBe("meta_ad");
  });

  it("returns null for an organic message (no referral, no Meta link)", () => {
    expect(extractReferral([{ kapso: { direction: "inbound" }, text: { body: "hola, tienen la mochila negra?" } }])).toBeNull();
  });

  it("ignores a Meta link the BOT sent (outbound) — only customer messages attribute", () => {
    const msgs = [{ kapso: { direction: "outbound" }, text: { body: "míralo aquí https://aurela.pe/p?utm_source=facebook" } }];
    expect(extractReferral(msgs)).toBeNull();
  });
});

describe("findConversationIdByPhone", () => {
  it("requests /whatsapp/conversations by phone and returns the newest conv id", async () => {
    const caps: Capture[] = [];
    const f = mockFetch(
      () => ({
        data: [
          { id: "old", phone_number: "51999", last_active_at: "2026-06-20T10:00:00Z" },
          { id: "new", phone_number: "51999", last_active_at: "2026-06-27T19:38:59Z" },
        ],
      }),
      caps,
    );
    const id = await findConversationIdByPhone(opts(f), "51999", "PNID-1");
    expect(id).toBe("new"); // newest by last_active_at, regardless of order
    const u = new URL(caps[0]!.url);
    expect(u.pathname).toContain("/whatsapp/conversations");
    expect(u.searchParams.get("phone_number")).toBe("51999");
    expect(u.searchParams.get("phone_number_id")).toBe("PNID-1");
  });

  it("returns null when no conversation matches the phone", async () => {
    const f = mockFetch(() => ({ data: [] }), []);
    expect(await findConversationIdByPhone(opts(f), "51000")).toBeNull();
  });

  it("returns null (never throws) for an empty phone", async () => {
    const f = mockFetch(() => ({ data: [{ id: "x" }] }), []);
    expect(await findConversationIdByPhone(opts(f), "")).toBeNull();
  });
});

describe("fetchConversationTranscript", () => {
  it("uses limit=100 (Kapso's cap) + fields=kapso(default) and returns oldest-first", async () => {
    const caps: Capture[] = [];
    // Newest-first from the API; the helper sorts ascending for display.
    const msgs = [
      { id: "b", timestamp: "1782249200", type: "text", text: { body: "segundo" }, kapso: { direction: "outbound" } },
      { id: "a", timestamp: "1782249100", type: "text", text: { body: "primero" }, kapso: { direction: "inbound" } },
    ];
    const f = mockFetch(() => ({ data: msgs, paging: { cursors: { after: "CUR" }, next: null } }), caps);
    const out = await fetchConversationTranscript(opts(f), "conv-1");
    expect(out.map((m) => m.id)).toEqual(["a", "b"]); // oldest-first
    const u = new URL(caps[0]!.url);
    expect(u.searchParams.get("limit")).toBe("100"); // never 200 (would 400)
    expect(u.searchParams.get("fields")).toBe("kapso(default)");
    expect(caps).toHaveLength(1); // a short page (<100) ⇒ no extra request despite the cursor
  });

  it("pages through the cursor when a full page (100) comes back", async () => {
    const caps: Capture[] = [];
    const fullPage = Array.from({ length: 100 }, (_, i) => ({
      id: `p1-${i}`,
      timestamp: String(1782249000 + i),
      type: "text",
      text: { body: String(i) },
      kapso: { direction: "inbound" },
    }));
    const lastPage = [
      { id: "p2-0", timestamp: "1782250000", type: "text", text: { body: "fin" }, kapso: { direction: "outbound" } },
    ];
    const f = mockFetch((url) => {
      const after = url.searchParams.get("after");
      return after
        ? { data: lastPage, paging: { cursors: {}, next: null } }
        : { data: fullPage, paging: { cursors: { after: "NEXT" }, next: null } };
    }, caps);
    const out = await fetchConversationTranscript(opts(f), "conv-2");
    expect(caps).toHaveLength(2); // followed the cursor for a second page
    expect(new URL(caps[1]!.url).searchParams.get("after")).toBe("NEXT");
    expect(out).toHaveLength(101);
  });
});

describe("parseConversationMessages (template body)", () => {
  it("reads a TEMPLATE (HSM) message's rendered text from kapso.content", () => {
    // Shape mirrors a real Kapso `fields=kapso(default)` template message: no
    // `text.body`; the rendered body lives in `kapso.content` (+ `template`).
    const out = parseConversationMessages([
      {
        id: "wamid.X",
        timestamp: "1782735944",
        type: "template",
        template: { name: "busqueda_abandonada_1", language: { code: "es" } },
        kapso: {
          direction: "outbound",
          status: "delivered",
          content:
            "🎀 ¡Hola Martina! Vi que elegiste *Estante Giratorio Multifuncional* en nuestra tienda 😊",
        },
      },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.dir).toBe("outbound");
    expect(out[0]!.text).toContain("Estante Giratorio Multifuncional");
    expect(out[0]!.status).toBe("delivered");
  });

  it("still prefers an explicit text.body over kapso.content", () => {
    const out = parseConversationMessages([
      {
        id: "m1",
        timestamp: "1782735000",
        type: "text",
        text: { body: "hola" },
        kapso: { direction: "inbound", content: "IGNORAR" },
      },
    ]);
    expect(out[0]!.text).toBe("hola");
  });

  it("exposes template name + body params, and templateProductParam pulls the product", () => {
    const out = parseConversationMessages([
      {
        id: "wamid.X",
        timestamp: "1782735944",
        type: "template",
        template: {
          name: "busqueda_abandonada_1",
          components: [
            {
              type: "body",
              parameters: [
                { type: "text", text: "Martina Perez" },
                { type: "text", text: "Estante Giratorio Multifuncional" },
              ],
            },
          ],
        },
        kapso: { direction: "outbound", content: "🎀 …" },
      },
    ]);
    expect(out[0]!.templateName).toBe("busqueda_abandonada_1");
    expect(out[0]!.templateParams).toEqual(["Martina Perez", "Estante Giratorio Multifuncional"]);
    // The product is the LAST body param of the matching outbound template.
    expect(templateProductParam(out, "busqueda_abandonada_1")).toBe("Estante Giratorio Multifuncional");
    // No match → null (wrong name, or no template name given).
    expect(templateProductParam(out, "otra_plantilla")).toBeNull();
    expect(templateProductParam(out, null)).toBeNull();
  });
});

describe("listConversationsByPhone (multi-number)", () => {
  it("returns all of a phone's conversations newest-first (across numbers)", async () => {
    const caps: Capture[] = [];
    const f = mockFetch(
      () => ({
        data: [
          { id: "older", phone_number: "51999", phone_number_id: "NUM_A", last_active_at: "2026-06-20T10:00:00Z" },
          { id: "newer", phone_number: "51999", phone_number_id: "NUM_B", last_active_at: "2026-06-27T19:00:00Z" },
        ],
      }),
      caps,
    );
    const convs = await listConversationsByPhone(opts(f), "51999");
    expect(convs.map((c) => c.id)).toEqual(["newer", "older"]); // newest first
    expect(convs.map((c) => c.phone_number_id)).toEqual(["NUM_B", "NUM_A"]);
    expect(new URL(caps[0]!.url).searchParams.get("phone_number")).toBe("51999");
  });

  it("returns [] for an empty phone (no request)", async () => {
    const caps: Capture[] = [];
    expect(await listConversationsByPhone(opts(mockFetch(() => ({ data: [] }), caps)), "")).toEqual([]);
    expect(caps).toHaveLength(0);
  });
});

describe("mergeTranscripts (full history across Kapso session-conversations)", () => {
  const msg = (id: string, t: number, text = ""): any => ({
    id,
    dir: "inbound",
    t,
    text,
    mediaKind: null,
    mediaUrl: null,
    status: null,
  });

  it("concatenates several conversations into ONE oldest-first stream", () => {
    const older = [msg("a", 1000), msg("b", 2000)]; // a prior session
    const newer = [msg("c", 5000), msg("d", 6000)]; // the current session
    const merged = mergeTranscripts([newer, older]); // caller may pass newest-first
    expect(merged.map((m) => m.id)).toEqual(["a", "b", "c", "d"]); // re-sorted by t
  });

  it("interleaves by timestamp, not by conversation", () => {
    const convA = [msg("a1", 1000), msg("a2", 4000)];
    const convB = [msg("b1", 2000), msg("b2", 3000)];
    expect(mergeTranscripts([convA, convB]).map((m) => m.id)).toEqual(["a1", "b1", "b2", "a2"]);
  });

  it("dedupes by id across conversations (overlapping window)", () => {
    const a = [msg("x", 1000), msg("y", 2000)];
    const b = [msg("y", 2000), msg("z", 3000)]; // y repeated
    const merged = mergeTranscripts([a, b]);
    expect(merged.map((m) => m.id)).toEqual(["x", "y", "z"]);
  });

  it("keeps messages without an id (can't dedupe them) and handles empty input", () => {
    expect(mergeTranscripts([])).toEqual([]);
    const withNulls = mergeTranscripts([[{ ...msg("", 1000), id: null }, { ...msg("", 1000), id: null }]]);
    expect(withNulls).toHaveLength(2);
  });
});
