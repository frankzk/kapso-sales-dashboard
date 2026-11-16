import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { gfCourier, gfIdempotencyKey, gfRetryKey, verifyGfWebhook } from "@/lib/gf-courier";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

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

describe("reintentar después de un rechazo de GF (#KP205759, 16-11-2026)", () => {
  it("la clave del reintento es otra, cabe en 128 y conserva la guía externa", () => {
    const base = gfIdempotencyKey("7c5a2e5c-12e8-4e3b-8f46-fb5c7a876b8d", "#KP205759");
    expect(gfRetryKey(base, 2)).toBe(`${base}~r2`);
    expect(gfRetryKey(base, 2)).not.toBe(base);
    const long = gfIdempotencyKey("o", "x".repeat(200));
    expect(gfRetryKey(long, 12)).toHaveLength(128);
    expect(gfRetryKey(long, 12).endsWith("~r12")).toBe(true);
  });
  it("un intento `failed` no frena: se prueba la clave siguiente; un choque real se dice como es", () => {
    const src = readFileSync(resolve(process.cwd(), "lib/gf-courier-guide.ts"), "utf8").replace(/\s+/g, " ");
    expect(src).toContain('for (let attempt = 2; prior.data?.status === "failed" && attempt <= GF_MAX_RETRY_KEYS; attempt += 1) {');
    expect(src).toContain("key = gfRetryKey(base, attempt);");
    expect(src).toContain('const live = await admin.from("gf_order_requests").select("id").eq("order_id", orderId).eq("status", "pending").limit(1);');
  });
});

describe("el aviso flotante de «Guía Aliclik» / «Guía GF» (16-11-2026)", () => {
  it("el resultado en el título y el pedido con la guía debajo, sin repetir la frase", async () => {
    const { quickGuideToast } = await import("@/lib/repro-lima-blocks");
    expect(quickGuideToast("#AUR900792", "GF Courier", "Guía creada en GF Courier: AURELA-AUR900792 · envío S/ 13.50 · entrega estimada 2026-11-17.")).toEqual({
      title: "Guía creada en GF Courier",
      detail: "#AUR900792 · AURELA-AUR900792 · envío S/ 13.50 · entrega estimada 2026-11-17",
    });
    expect(quickGuideToast("#KP1", "Aliclik", "Guía creada en Aliclik para #KP1: 123456 · cobrar S/ 80.00 · AUTOECOM S/ 9.")).toEqual({
      title: "Guía creada en Aliclik",
      detail: "#KP1 · 123456 · cobrar S/ 80.00 · AUTOECOM S/ 9",
    });
    expect(quickGuideToast("#KP2", "GF Courier", "Guía existente vinculada en GF Courier: GF-1 · envío S/ 10.00 · entrega estimada 2026-11-18.").title).toBe("Guía vinculada en GF Courier");
  });
  it("la página lo repite donde se mira, y el lector lo oye una vez", () => {
    const board = readFileSync(resolve(process.cwd(), "components/repro-lima-board.tsx"), "utf8");
    expect(board).toContain("<OpsToast toast={toast} onClose={() => setToast(null)} />");
    expect(board).toContain('role={feedback.toasted ? undefined : feedback.kind === "error" ? "alert" : "status"}');
    const toast = readFileSync(resolve(process.cwd(), "components/ops-toast.tsx"), "utf8");
    expect(toast).toContain("if (!toast || paused) return;");
    expect(toast).toContain('if (e.key === "Escape") close();');
    expect(toast).toContain("motion-reduce:transition-opacity");
  });
});
