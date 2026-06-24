import { describe, it, expect } from "vitest";
import { sendWhatsappText, fetchLastInboundAt } from "@/lib/kapso";

function fakeFetch(status: number, json: unknown, capture?: (url: string, init: any) => void) {
  return (async (url: string, init: any) => {
    capture?.(url, init);
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => json,
      text: async () => JSON.stringify(json),
    };
  }) as unknown as typeof fetch;
}

const base = "https://api.kapso.ai/platform/v1";

describe("sendWhatsappText", () => {
  it("POSTs to the Meta proxy and returns the message id on success", async () => {
    let seen: { url: string; init: any } | null = null;
    const res = await sendWhatsappText(
      {
        apiKey: "k",
        baseUrl: base,
        fetchImpl: fakeFetch(200, { messages: [{ id: "wamid.X" }] }, (url, init) => {
          seen = { url, init };
        }),
      },
      { phoneNumberId: "123", to: "51999", body: "Hola" },
    );
    expect(res).toEqual({ ok: true, id: "wamid.X" });
    expect(seen!.url).toBe("https://api.kapso.ai/meta/whatsapp/v24.0/123/messages");
    expect(seen!.init.method).toBe("POST");
    expect(seen!.init.headers["X-API-Key"]).toBe("k");
    const body = JSON.parse(seen!.init.body);
    expect(body).toMatchObject({ messaging_product: "whatsapp", to: "51999", type: "text", text: { body: "Hola" } });
  });

  it("surfaces the 24h-window error (131047) as a non-ok result", async () => {
    const res = await sendWhatsappText(
      { apiKey: "k", baseUrl: base, fetchImpl: fakeFetch(400, { error: { code: 131047, message: "Re-engagement message" } }) },
      { phoneNumberId: "123", to: "51999", body: "Hola" },
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe(131047);
  });
});

describe("fetchLastInboundAt", () => {
  it("returns the most recent inbound timestamp in ms", async () => {
    const page = {
      data: [
        { kapso: { direction: "inbound" }, timestamp: "1782275045" },
        { kapso: { direction: "inbound" }, timestamp: "1782275000" },
      ],
    };
    const ms = await fetchLastInboundAt({ apiKey: "k", baseUrl: base, fetchImpl: fakeFetch(200, page) }, "conv1");
    expect(ms).toBe(1782275045 * 1000);
  });
});
