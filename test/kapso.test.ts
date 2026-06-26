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
  extractReferral,
  fetchConversationSignals,
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
});

describe("detectYapePayment (Yape/Shalom advance from chat)", () => {
  // The real Marco flow: bot requests a Yape adelanto + voucher, the customer
  // replies with the receipt as an IMAGE (no text), and the agent confirms.
  const marco: ParsedMsg[] = [
    { t: 1, dir: "outbound", text: "Listo, lo enviamos a esa agencia Shalom 🙌\nPara separarlo, realiza el adelanto de S/30 al Yape:\nGrupo GF SAC\n930 555 309\nEnvíame el voucher o captura para pasarlo a validación logística ✅" },
    { t: 2, dir: "inbound", text: "" , image: true }, // the Yape voucher screenshot
    { t: 3, dir: "outbound", text: "¡Gracias! Solo falta que me envíes el DNI del titular que recogerá en Shalom Jr Aguilar." },
    { t: 4, dir: "inbound", text: "45440100" },
  ];

  it("detects an advance when a voucher image follows the bot's Yape request", () => {
    expect(detectYapePayment(marco)).toBe(true);
  });

  it("detects an explicit agent confirmation (pago recibido)", () => {
    expect(detectYapePayment([{ t: 1, dir: "outbound", text: "Pago recibido" }])).toBe(true);
  });

  it("detects the customer stating they paid (text, no image)", () => {
    expect(detectYapePayment([
      { t: 1, dir: "outbound", text: "Realiza el adelanto al Yape y envíame el voucher" },
      { t: 2, dir: "inbound", text: "Listo, ya yapeé. Número de operación 21691317" },
    ])).toBe(true);
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

  it("does NOT treat a non-payment image (product photo) as an advance", () => {
    expect(detectYapePayment([
      { t: 1, dir: "outbound", text: "¿Te gustaría avanzar con tu pedido?" },
      { t: 2, dir: "inbound", text: "", image: true }, // customer sends a random photo, no Yape context
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

  it("flags yape from an inbound image voucher after the bot's Yape request", async () => {
    // Real Kapso shapes: an inbound image (type:"image", no text body, media
    // under kapso) following the bot's adelanto request.
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
        text: { body: "Realiza el adelanto de S/30 al Yape y envíame el voucher para pasarlo a validación logística ✅" },
        kapso: { direction: "outbound" },
      },
    ];
    const f = mockFetch(() => ({ data: messages }), []);
    const sig = await fetchConversationSignals(opts(f), "c");
    expect(sig).not.toBeNull();
    expect(sig!.yape).toBe(true);
  });

  it("returns null when no messages are readable", async () => {
    const f = mockFetch(() => ({ data: [] }), []);
    expect(await fetchConversationSignals(opts(f), "c")).toBeNull();
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
    expect(classifyKapsoEvent("whatsapp.message.delivered", {})).toBe("skip");
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

  it("falls back to a Meta ad link in the customer's opening message (channel, no ad_id)", () => {
    // The real "Sol" case: ad → site → "tengo una consulta" button, UTM in text.
    const msgs = [
      { kapso: { direction: "outbound" }, text: { body: "¡Hola! Soy Akemi de Aurela 😊" } },
      {
        kapso: { direction: "inbound" },
        text: { body: "Tengo una consulta | Aurela https://aurela.pe/products/mochila?utm_content=Facebook_Mobile_Feed" },
      },
    ];
    expect(extractReferral(msgs)).toEqual({ source: "meta_ad", ad_id: null, ad_headline: null, ctwa_clid: null });
  });

  it("detects fbclid / utm_source=facebook too", () => {
    expect(extractReferral([{ kapso: { direction: "inbound" }, text: { body: "vi esto https://x.pe/p?fbclid=AbC" } }])?.source).toBe("meta_ad");
    expect(extractReferral([{ kapso: { direction: "inbound" }, text: { body: "https://x.pe/p?utm_source=facebook&utm_medium=cpc" } }])?.source).toBe("meta_ad");
  });

  it("returns null for an organic message (no referral, no Meta link)", () => {
    expect(extractReferral([{ kapso: { direction: "inbound" }, text: { body: "hola, tienen la mochila negra?" } }])).toBeNull();
  });

  it("ignores a Meta link the BOT sent (outbound) — only customer messages attribute", () => {
    const msgs = [{ kapso: { direction: "outbound" }, text: { body: "míralo aquí https://aurela.pe/p?utm_source=facebook" } }];
    expect(extractReferral(msgs)).toBeNull();
  });
});
