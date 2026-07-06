import { describe, it, expect } from "vitest";
import {
  analyzeYapeVoucher,
  isVoucherVerdict,
  normalizeMediaType,
} from "@/lib/vision";

/** Mock the Anthropic Messages API: return `text` as the model's only content
 *  block, and capture the request (URL, headers, parsed body) for assertions. */
function mockAnthropic(
  text: string,
  capture?: { url?: string; headers?: Record<string, string>; body?: any },
  init?: { ok?: boolean; status?: number },
): typeof fetch {
  return (async (input: RequestInfo | URL, req?: RequestInit) => {
    if (capture) {
      capture.url = String(input);
      capture.headers = (req?.headers ?? {}) as Record<string, string>;
      capture.body = req?.body ? JSON.parse(String(req.body)) : undefined;
    }
    return {
      ok: init?.ok ?? true,
      status: init?.status ?? 200,
      json: async () => ({ content: [{ type: "text", text }] }),
    } as Response;
  }) as unknown as typeof fetch;
}

const KEY = "sk-ant-test";

describe("normalizeMediaType", () => {
  it("passes through supported types and coerces jpg → jpeg", () => {
    expect(normalizeMediaType("image/png")).toBe("image/png");
    expect(normalizeMediaType("image/jpeg")).toBe("image/jpeg");
    expect(normalizeMediaType("image/webp")).toBe("image/webp");
    expect(normalizeMediaType("image/jpg")).toBe("image/jpeg");
  });
  it("strips parameters and defaults unknown/empty to jpeg", () => {
    expect(normalizeMediaType("image/png; charset=binary")).toBe("image/png");
    expect(normalizeMediaType("application/pdf")).toBe("image/jpeg");
    expect(normalizeMediaType(null)).toBe("image/jpeg");
    expect(normalizeMediaType("")).toBe("image/jpeg");
  });
});

describe("isVoucherVerdict (decision threshold)", () => {
  it("false when the model says it is not a voucher", () => {
    expect(isVoucherVerdict({ is_voucher: false, indicators: { logo: true, monto: true } })).toBe(false);
  });
  it("false when the Yape interface/logo is absent (chat/product screenshot)", () => {
    expect(isVoucherVerdict({ is_voucher: true, indicators: { logo: false, monto: true } })).toBe(false);
  });
  it("true when the model confirms and the logo is present (or unspecified)", () => {
    expect(isVoucherVerdict({ is_voucher: true, indicators: { logo: true } })).toBe(true);
    expect(isVoucherVerdict({ is_voucher: true, indicators: {} })).toBe(true); // logo not contradicted
  });
});

describe("analyzeYapeVoucher", () => {
  it("returns a voucher verdict and sends a correct vision request", async () => {
    const cap: { url?: string; headers?: Record<string, string>; body?: any } = {};
    const f = mockAnthropic(
      '{"is_voucher": true, "indicators": {"logo": true, "monto": true, "fecha_hora": true, "destinatario": true, "estado": true, "operacion": true}}',
      cap,
    );
    const res = await analyzeYapeVoucher("BASE64DATA", "image/png", {
      apiKey: KEY,
      model: "claude-opus-4-8",
      fetchImpl: f,
    });
    expect(res.isVoucher).toBe(true);
    expect(res.indicators.destinatario).toBe(true);
    expect(res.model).toBe("claude-opus-4-8");
    // Request shape: endpoint, auth headers, model, and an image block.
    expect(cap.url).toBe("https://api.anthropic.com/v1/messages");
    expect(cap.headers!["x-api-key"]).toBe(KEY);
    expect(cap.headers!["anthropic-version"]).toBe("2023-06-01");
    expect(cap.body.model).toBe("claude-opus-4-8");
    const img = cap.body.messages[0].content.find((b: any) => b.type === "image");
    expect(img.source).toEqual({ type: "base64", media_type: "image/png", data: "BASE64DATA" });
  });

  it("returns NOT a voucher when the model declines (holistic)", async () => {
    const f = mockAnthropic('{"is_voucher": false, "indicators": {"logo": false}}');
    const res = await analyzeYapeVoucher("x", "image/jpeg", { apiKey: KEY, model: "m", fetchImpl: f });
    expect(res.isVoucher).toBe(false);
  });

  it("overrides an over-eager is_voucher when the Yape logo is absent", async () => {
    const f = mockAnthropic('{"is_voucher": true, "indicators": {"logo": false, "monto": true}}');
    const res = await analyzeYapeVoucher("x", "image/jpeg", { apiKey: KEY, model: "m", fetchImpl: f });
    expect(res.isVoucher).toBe(false);
  });

  it("tolerates markdown fences / surrounding prose around the JSON", async () => {
    const f = mockAnthropic('Claro:\n```json\n{"is_voucher": true, "indicators": {"logo": true}}\n```');
    const res = await analyzeYapeVoucher("x", "image/jpeg", { apiKey: KEY, model: "m", fetchImpl: f });
    expect(res.isVoucher).toBe(true);
  });

  it("is conservative (not a voucher) on unparseable output", async () => {
    const f = mockAnthropic("no puedo determinarlo");
    const res = await analyzeYapeVoucher("x", "image/jpeg", { apiKey: KEY, model: "m", fetchImpl: f });
    expect(res.isVoucher).toBe(false);
  });

  it("is conservative on a non-2xx response", async () => {
    const f = mockAnthropic("{}", undefined, { ok: false, status: 429 });
    const res = await analyzeYapeVoucher("x", "image/jpeg", { apiKey: KEY, model: "m", fetchImpl: f });
    expect(res.isVoucher).toBe(false);
  });

  it("never throws on a network error", async () => {
    const f = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const res = await analyzeYapeVoucher("x", "image/jpeg", { apiKey: KEY, model: "m", fetchImpl: f });
    expect(res.isVoucher).toBe(false);
  });

  it("short-circuits (no call) when no API key is configured", async () => {
    let called = false;
    const f = (async () => {
      called = true;
      return { ok: true, status: 200, json: async () => ({}) } as Response;
    }) as unknown as typeof fetch;
    const res = await analyzeYapeVoucher("x", "image/jpeg", { apiKey: "", model: "m", fetchImpl: f });
    expect(res.isVoucher).toBe(false);
    expect(called).toBe(false);
  });
});
