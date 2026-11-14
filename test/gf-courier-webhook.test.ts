// GF Courier por API (MOM §29.17): receptor de webhooks firmado y aplicación del estado a la salida.
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const inserts: { table: string; row: Record<string, unknown> }[] = [];
const updates: { table: string; patch: Record<string, unknown> }[] = [];
let shipment: Record<string, unknown> | null = null;
let duplicateEvent = false;
function admin() {
  return {
    from(table: string) {
      const chain: any = {
        select: () => chain, eq: () => chain, in: () => chain, limit: () => chain, order: () => chain,
        maybeSingle: async () => ({ data: table === "shipments" ? shipment : null, error: null }),
        insert: async (row: Record<string, unknown>) => {
          inserts.push({ table, row });
          return { error: table === "gf_webhook_events" && duplicateEvent ? { code: "23505" } : null };
        },
        update: (patch: Record<string, unknown>) => { updates.push({ table, patch }); return { eq: async () => ({ error: null }) }; },
      };
      return chain;
    },
  };
}
vi.mock("@/lib/db", () => ({ createAdminSupabase: () => admin() }));
vi.mock("@/lib/order-master", () => ({ recomputeOrderMasterSafe: vi.fn(async () => undefined) }));
const store = { enabled: true, token: "tok", webhookSecret: "whsec_test" };
vi.mock("@/lib/gf-courier-guide", () => ({ loadGfStore: async () => store }));
const getOrder = vi.fn();
vi.mock("@/lib/gf-courier", async (orig) => ({ ...(await orig<typeof import("@/lib/gf-courier")>()), gfCourier: { getOrder } }));

const { POST } = await import("@/app/api/webhooks/gf/[storeId]/route");
const { applyGfSnapshot } = await import("@/lib/gf-courier-track");
const STORE = "11111111-1111-4111-8111-111111111111";
const sign = (ts: string, body: string, secret = store.webhookSecret) => `v1=${createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex")}`;
function request(body: string, headers: Record<string, string>) {
  return { text: async () => body, headers: new Headers(headers) } as unknown as import("next/server").NextRequest;
}
const ctx = { params: Promise.resolve({ storeId: STORE }) };
const envelope = (type = "order.status_changed") => JSON.stringify({ id: "evt_" + "a".repeat(32), type, created_at: "2026-11-14T10:00:00-05:00", merchant_id: "m",
  data: { tracking_id: "GF0123456789ABCDEF", status: { code: "DELIVERED" } } });
const gfOrder = (code: string, sub: string | null = null) => ({ tracking_id: "GF0123456789ABCDEF", external_id: "#1001", service: "COD_LIMA",
  status: { code, sub_status: sub, final: false }, shipping_cost: 10, currency: "PEN", estimated_delivery_date: "2026-11-15", label_url: "x", tracking_url: null });

beforeEach(() => { inserts.length = 0; updates.length = 0; duplicateEvent = false; getOrder.mockReset();
  shipment = { id: "s1", store_id: STORE, order_id: "o1", delivery_status: "pendiente", guide_code: "GF0123456789ABCDEF", reported_status: "CREATED",
    preparation_state: null, custody_state: "empresa", returned_at: null, returned_source: null, closed_at: null, dispatched_at: null, next_followup_at: null }; });

describe("webhook de GF", () => {
  it("rechaza firma inválida o vieja sin leer GF", async () => {
    const body = envelope(), ts = String(Math.floor(Date.now() / 1000));
    const bad = await POST(request(body, { "x-gf-signature": sign(ts, body, "otro"), "x-gf-timestamp": ts, "x-gf-event-id": JSON.parse(body).id }), ctx);
    expect(bad.status).toBe(401);
    const old = String(Math.floor(Date.now() / 1000) - 600);
    expect((await POST(request(body, { "x-gf-signature": sign(old, body), "x-gf-timestamp": old, "x-gf-event-id": JSON.parse(body).id }), ctx)).status).toBe(401);
    expect(getOrder).not.toHaveBeenCalled();
  });
  it("con firma válida relee GF, aplica el estado actual y registra el evento", async () => {
    getOrder.mockResolvedValue({ ok: true, data: gfOrder("DELIVERED") });
    const body = envelope(), ts = String(Math.floor(Date.now() / 1000));
    const res = await POST(request(body, { "x-gf-signature": sign(ts, body), "x-gf-timestamp": ts, "x-gf-event-id": JSON.parse(body).id }), ctx);
    expect(res.status).toBe(200);
    expect(getOrder).toHaveBeenCalledWith({ apiToken: "tok" }, "GF0123456789ABCDEF");
    const patch = updates.find((u) => u.table === "shipments")!.patch;
    expect(patch.delivery_status).toBe("entregado");
    expect(patch.delivered_source).toBe("gf_courier_api");
    expect(inserts.find((i) => i.table === "gf_webhook_events")?.row.outcome).toBe("applied");
    expect(inserts.find((i) => i.table === "order_events")?.row.kind).toBe("courier_status");
  });
  it("webhook.test se registra sin tocar guías; el evento repetido responde duplicate", async () => {
    const body = envelope("webhook.test"), ts = String(Math.floor(Date.now() / 1000));
    duplicateEvent = true;
    const res = await POST(request(body, { "x-gf-signature": sign(ts, body), "x-gf-timestamp": ts, "x-gf-event-id": JSON.parse(body).id }), ctx);
    expect(await res.json()).toMatchObject({ ok: true, outcome: "duplicate" });
    expect(getOrder).not.toHaveBeenCalled();
  });
});

describe("aplicar estado GF a la salida", () => {
  it("RETURNED sella la devolución una vez y anula la guía", async () => {
    const r = await applyGfSnapshot(gfOrder("RETURNED") as any, admin() as any);
    expect(r.outcome).toBe("applied");
    const patch = updates.find((u) => u.table === "shipments")!.patch;
    expect(patch).toMatchObject({ delivery_status: "anulado", returned_source: "gf_courier_api", custody_state: "devuelto" });
  });
  it("LOST no toca el estado: queda para revisión", async () => {
    const r = await applyGfSnapshot(gfOrder("LOST") as any, admin() as any);
    expect(r.outcome).toBe("unchanged");
    expect(updates[0]!.patch).toMatchObject({ reported_status: "LOST" });
    expect(updates[0]!.patch.delivery_status).toBeUndefined();
  });
  it("una guía que no es de GF en Kapta responde unknown_order", async () => {
    shipment = null;
    expect((await applyGfSnapshot(gfOrder("DELIVERED") as any, admin() as any)).outcome).toBe("unknown_order");
  });
});

describe("reparto propio frente a GF por API", () => {
  it("«Tomar» de Grupo GF rechaza las tiendas que despachan por la API", () => {
    const src = readFileSync(join(process.cwd(), "app/dashboard/courier/actions.ts"), "utf8");
    expect(src).toContain("storeUsesGfCourierApi(admin, row.store_id as string | null, gfApiStores)");
    expect(src).toContain("esta tienda despacha por GF Courier (API)");
  });
});

describe("despliegue", () => {
  it("DEPLOY.md: arriba de todo, la 0344 antes que el código; el cron de GF existe", () => {
    const deploy = readFileSync(join(process.cwd(), "DEPLOY.md"), "utf8");
    const first = deploy.indexOf("### ");
    const entry = deploy.slice(first, deploy.indexOf("\n### ", first + 4));
    expect(entry).toContain("0344_gf_courier_api");
    expect(entry).toMatch(/antes del código/i);
    expect(readFileSync(join(process.cwd(), "vercel.json"), "utf8")).toContain("/api/cron/gf-reconcile");
  });
});
