import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { gfCourier, gfIdempotencyKey, verifyGfWebhook } from "@/lib/gf-courier";

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

describe("cliente GF Courier", () => {
  it("crea con Bearer e Idempotency-Key y marca el replay", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return json(201, { tracking_id: "GF0123456789ABCDEF", status: { code: "CREATED", sub_status: null, final: false } }, { "idempotent-replayed": "true" });
    }) as unknown as typeof fetch;
    const r = await gfCourier.createOrder({ apiToken: " tok ", baseUrl: "https://gf.test/", fetchImpl },
      { external_id: "KP1", service: "COD_LIMA", recipient: { first_name: "A", last_name: "B", phone: "987654321" },
        destination: { district: "Surco", address: "Av. X 123" }, items: [{ sku: "S1", quantity: 1, unit_price: 10 }],
        payment: { total: 10, advance_paid: 0, amount_to_collect: 10 } }, gfIdempotencyKey("o1", "s1"));
    expect(r.ok && r.data.tracking_id).toBe("GF0123456789ABCDEF");
    expect(r.ok && r.replayed).toBe(true);
    expect(calls[0]!.url).toBe("https://gf.test/v1/orders");
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer tok");
    expect(headers["Idempotency-Key"]).toBe("KP-o1-s1");
  });

  it("propaga el error de GF tal cual, con allowed y tracking_id", async () => {
    const fetchImpl = (async () => json(409, { error: { code: "DUPLICATE_ORDER", message: "Ya existe una guía", field: "external_id", tracking_id: "GFAAAA" }, code: "DUPLICATE_ORDER" })) as unknown as typeof fetch;
    const r = await gfCourier.getOrder({ apiToken: "t", baseUrl: "https://gf.test", fetchImpl }, "GFAAAA");
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.status).toBe(409); expect(r.error.code).toBe("DUPLICATE_ORDER"); expect(r.error.tracking_id).toBe("GFAAAA"); expect(r.timedOut).toBe(false); }
  });

  it("distingue el timeout (el pedido pudo crearse) de otros fallos de red", async () => {
    const slow = (async () => { const e = new Error("t"); e.name = "TimeoutError"; throw e; }) as unknown as typeof fetch;
    const down = (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch;
    const a = await gfCourier.me({ apiToken: "t", baseUrl: "https://gf.test", fetchImpl: slow });
    const b = await gfCourier.me({ apiToken: "t", baseUrl: "https://gf.test", fetchImpl: down });
    expect(!a.ok && a.timedOut && a.error.code).toBe("TIMEOUT");
    expect(!b.ok && !b.timedOut && b.error.code).toBe("NETWORK_ERROR");
  });
});

describe("firma de webhooks GF", () => {
  const secret = "whsec_prueba";
  const sign = (ts: string, body: string) => `v1=${createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex")}`;
  const now = 1_762_720_800_000, ts = String(now / 1000), body = '{"id":"evt_1","type":"order.status_changed"}';
  it("acepta la firma correcta sobre el cuerpo crudo", () => {
    expect(verifyGfWebhook(body, { signature: sign(ts, body), timestamp: ts }, secret, now)).toEqual({ ok: true });
  });
  it("rechaza cuerpo alterado, otro secreto, timestamp viejo y cabeceras ausentes", () => {
    expect(verifyGfWebhook(body + " ", { signature: sign(ts, body), timestamp: ts }, secret, now)).toEqual({ ok: false, reason: "bad_signature" });
    expect(verifyGfWebhook(body, { signature: sign(ts, body), timestamp: ts }, "otro", now)).toEqual({ ok: false, reason: "bad_signature" });
    expect(verifyGfWebhook(body, { signature: sign(ts, body), timestamp: ts }, secret, now + 301_000)).toEqual({ ok: false, reason: "stale_timestamp" });
    expect(verifyGfWebhook(body, { signature: null, timestamp: ts }, secret, now)).toEqual({ ok: false, reason: "missing_headers" });
  });
});
