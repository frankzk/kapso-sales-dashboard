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

describe("isVoucherVerdict (decision threshold — precision over recall)", () => {
  it("false when the model says it is not a voucher", () => {
    expect(isVoucherVerdict({ is_voucher: false, indicators: { logo: true, monto: true, estado: true } })).toBe(false);
  });
  it("false when no payment interface is visible at all (chat/product screenshot)", () => {
    expect(isVoucherVerdict({ is_voucher: true, indicators: { logo: false, monto: true, estado: true } })).toBe(false);
    expect(isVoucherVerdict({ is_voucher: true, indicators: { monto: true, estado: true } })).toBe(false); // logo unspecified
  });
  it("false when the logo is present but NO concrete payment fact corroborates it", () => {
    expect(isVoucherVerdict({ is_voucher: true, indicators: { logo: true } })).toBe(false);
    expect(isVoucherVerdict({ is_voucher: true, indicators: {} })).toBe(false);
    // only date/time + recipient, no monto/estado/operacion → still not enough
    expect(isVoucherVerdict({ is_voucher: true, indicators: { logo: true, fecha_hora: true, destinatario: true } })).toBe(
      false,
    );
  });
  it("true with a payment interface + at least one payment fact (monto / estado / operación)", () => {
    expect(isVoucherVerdict({ is_voucher: true, indicators: { logo: true, monto: true } })).toBe(true);
    expect(isVoucherVerdict({ is_voucher: true, indicators: { logo: true, estado: true } })).toBe(true);
    expect(isVoucherVerdict({ is_voucher: true, indicators: { logo: true, operacion: true } })).toBe(true);
  });
});

describe("el veredicto pregunta por un pago, no por Yape", () => {
  // La constancia de una transferencia de Interbank o del BCP no tiene el morado
  // de Yape. Mientras el prompt preguntaba "¿es un Yape?", el veredicto salía
  // negativo y payment-actions mandaba el pago a `info_incompleta` aunque el nº
  // de operación y el receptor estuvieran perfectos: leer bien el número no
  // habría destrabado ni uno solo de esos comprobantes.
  it("le pregunta al modelo por cualquier banco o billetera peruana", async () => {
    const cap: { url?: string; headers?: Record<string, string>; body?: any } = {};
    await analyzeYapeVoucher("x", "image/jpeg", {
      apiKey: KEY,
      model: "m",
      fetchImpl: mockAnthropic('{"is_voucher": true, "indicators": {"logo": true, "monto": true}}', cap),
    });
    const system: string = cap.body.system;
    for (const bank of ["Yape", "Plin", "BCP", "Interbank", "BBVA", "Scotiabank"]) {
      expect(system).toContain(bank);
    }
    // Y sigue diciendo qué NO es un comprobante: la precisión no se negocia.
    expect(system).toContain("conversación de chat");
    expect(system).toContain("Ante la duda, NO es comprobante");
  });

  it("una constancia bancaria con interfaz de pago cuenta como comprobante", async () => {
    const res = await analyzeYapeVoucher("x", "image/jpeg", {
      apiKey: KEY,
      model: "m",
      fetchImpl: mockAnthropic(
        '{"is_voucher": true, "indicators": {"logo": true, "monto": true, "operacion": true, "estado": true}}',
      ),
    });
    expect(res.isVoucher).toBe(true);
    expect(res.ok).toBe(true);
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
    expect(res.ok).toBe(true);
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

  it("returns a real NOT-a-voucher verdict (ok:true) when the model declines", async () => {
    const f = mockAnthropic('{"is_voucher": false, "indicators": {"logo": false}}');
    const res = await analyzeYapeVoucher("x", "image/jpeg", { apiKey: KEY, model: "m", fetchImpl: f });
    expect(res.isVoucher).toBe(false);
    expect(res.ok).toBe(true); // decided, not a failure — safe to cache
  });

  it("overrides an over-eager is_voucher when the Yape logo is absent", async () => {
    const f = mockAnthropic('{"is_voucher": true, "indicators": {"logo": false, "monto": true, "estado": true}}');
    const res = await analyzeYapeVoucher("x", "image/jpeg", { apiKey: KEY, model: "m", fetchImpl: f });
    expect(res.isVoucher).toBe(false);
    expect(res.ok).toBe(true);
  });

  it("tolerates markdown fences / surrounding prose around the JSON", async () => {
    const f = mockAnthropic('Claro:\n```json\n{"is_voucher": true, "indicators": {"logo": true, "estado": true}}\n```');
    const res = await analyzeYapeVoucher("x", "image/jpeg", { apiKey: KEY, model: "m", fetchImpl: f });
    expect(res.isVoucher).toBe(true);
  });

  it("marks ok:false (a failure, NOT a decided negative) on unparseable output", async () => {
    const f = mockAnthropic("no puedo determinarlo");
    const res = await analyzeYapeVoucher("x", "image/jpeg", { apiKey: KEY, model: "m", fetchImpl: f });
    expect(res.isVoucher).toBe(false);
    expect(res.ok).toBe(false);
  });

  it("marks ok:false on a non-2xx response", async () => {
    const f = mockAnthropic("{}", undefined, { ok: false, status: 429 });
    const res = await analyzeYapeVoucher("x", "image/jpeg", { apiKey: KEY, model: "m", fetchImpl: f });
    expect(res.isVoucher).toBe(false);
    expect(res.ok).toBe(false);
  });

  it("never throws on a network error (ok:false)", async () => {
    const f = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const res = await analyzeYapeVoucher("x", "image/jpeg", { apiKey: KEY, model: "m", fetchImpl: f });
    expect(res.isVoucher).toBe(false);
    expect(res.ok).toBe(false);
  });

  it("short-circuits (no call, ok:false) when no API key is configured", async () => {
    let called = false;
    const f = (async () => {
      called = true;
      return { ok: true, status: 200, json: async () => ({}) } as Response;
    }) as unknown as typeof fetch;
    const res = await analyzeYapeVoucher("x", "image/jpeg", { apiKey: "", model: "m", fetchImpl: f });
    expect(res.isVoucher).toBe(false);
    expect(res.ok).toBe(false);
    expect(called).toBe(false);
  });
});
