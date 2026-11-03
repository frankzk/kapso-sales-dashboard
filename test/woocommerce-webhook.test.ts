// Webhooks de pedidos de WooCommerce (MOM §38.11): la ruta
// `/api/webhooks/woocommerce/[storeId]` y `processWooWebhook` (lib/ingest.ts).
//
// Lo que se fija, con una base falsa que aplica los filtros y las claves únicas:
//   - El ping de alta (`webhook_id=N`, sin firma) recibe 200 ANTES de mirar la
//     firma; el de una tienda que no existe, 404.
//   - Una firma mala es 401 y no toca nada.
//   - Los repetidos se descartan por el sha256 del cuerpo, nunca por
//     X-WC-Webhook-Delivery-ID (que se repite dentro del mismo segundo).
//   - order.created / order.updated / order.restored entran a `orders` con el
//     mapeador (`wc-kp-…`, platform woocommerce) y con los mismos efectos que un
//     pedido de Shopify (rollups y lead si es del bot, carrito si no, Master).
//   - order.deleted marca anulado y nunca borra.
//   - Lo que nunca va a poder procesarse contesta 2xx (WooCommerce desactiva el
//     webhook tras 5 fallos y no reintenta).
//   - El camino de Shopify no cambió.
// Sin red ni base real.

import { createHash, createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeDb, type Row } from "./woocommerce-fake-db";

const h = vi.hoisted(() => {
  process.env.ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
  return { db: null as unknown as import("./woocommerce-fake-db").FakeDb };
});

vi.mock("@/lib/db", () => ({
  createAdminSupabase: () => h.db.client(),
  createServerSupabase: async () => {
    throw new Error("no se usa en estas pruebas");
  },
}));

const spies = vi.hoisted(() => ({
  recompute: vi.fn(async (_admin: unknown, ids: readonly string[]) => ({ requested: ids.length, written: ids.length, error: null })),
  linkOrderToLead: vi.fn(async () => {}),
  linkOrdersToLeads: vi.fn(async () => {}),
  closeCart: vi.fn(async () => 0),
}));

vi.mock("@/lib/order-master", async (orig) => ({
  ...(await orig<typeof import("@/lib/order-master")>()),
  recomputeOrderMasterSafe: spies.recompute,
  reconcileOrderMaster: vi.fn(async () => ({ written: 0, failed: 0 })),
}));

vi.mock("@/lib/leads-ingest", async (orig) => ({
  ...(await orig<typeof import("@/lib/leads-ingest")>()),
  linkOrderToLead: spies.linkOrderToLead,
  linkOrdersToLeads: spies.linkOrdersToLeads,
  closeCartLeadsWithOrders: spies.closeCart,
  lastDispositionAtByPhone: vi.fn(async () => new Map()),
}));

import { encrypt } from "@/lib/crypto";
import { processWooWebhook, type WooWebhookParams } from "@/lib/ingest";
import { wooWebhookEventKey, wooWebhookHttpStatus } from "@/lib/woocommerce-intake";
import { POST } from "@/app/api/webhooks/woocommerce/[storeId]/route";

const STORE_ID = "11111111-1111-4111-8111-111111111111";
const SECRET = "3f9a1c0d5e7b2a4c6d8e0f1a3b5c7d9e1f2a3b4c5d6e7f80";
const SITE = "https://kenku.pe";

function storeRow(over: Row = {}): Row {
  return {
    id: STORE_ID,
    status: "active",
    timezone: "America/Lima",
    platform: "shopify",
    woo_site_url: SITE,
    woo_site_key: "kp",
    woo_consumer_key_enc: encrypt("ck_0123456789abcdef0123456789abcdef01234567"),
    woo_consumer_secret_enc: encrypt("cs_0123456789abcdef0123456789abcdef01234567"),
    woo_webhook_secret_enc: encrypt(SECRET),
    woo_last_error: null,
    ...over,
  };
}

/** Un pedido contraentrega del formulario web, con la forma real de REST v3. */
function wooOrder(over: Row = {}): Row {
  return {
    id: 1532,
    number: "KP200001",
    status: "processing",
    currency: "PEN",
    prices_include_tax: true,
    date_created_gmt: "2026-10-27T21:14:09",
    date_modified_gmt: "2026-10-27T21:14:12",
    discount_total: "0.00",
    shipping_total: "0.00",
    total: "139.00",
    billing: { first_name: "María", last_name: "Quispe", address_1: "Av. Los Próceres 1234", city: "Santiago de Surco", state: "LMA", country: "PE", phone: "987 654 321" },
    shipping: { first_name: "María", last_name: "Quispe", address_1: "Av. Los Próceres 1234", city: "Santiago de Surco", state: "LMA", country: "PE", phone: "" },
    payment_method: "cod",
    payment_method_title: "Pago contra entrega",
    customer_note: "",
    meta_data: [{ id: 1, key: "kapta_channel", value: "web_formulario" }],
    line_items: [{ id: 1, name: "Zapatilla", product_id: 10, variation_id: 0, quantity: 1, subtotal: "139.00", subtotal_tax: "0.00", total: "139.00", sku: "ZAP-38" }],
    shipping_lines: [],
    fee_lines: [],
    coupon_lines: [],
    refunds: [],
    ...over,
  };
}

function sign(body: string, secret = SECRET): string {
  return createHmac("sha256", secret).update(body, "utf8").digest("base64");
}

function params(body: string, over: Partial<WooWebhookParams> = {}): WooWebhookParams {
  return {
    storeId: STORE_ID,
    rawBody: body,
    topic: "order.created",
    signature: sign(body),
    deliveryId: "d41d8cd98f00b204e9800998ecf8427e",
    source: `${SITE}/`,
    ...over,
  };
}

function request(body: string, headers: Record<string, string> = {}, storeId = STORE_ID): [NextRequest, { params: Promise<{ storeId: string }> }] {
  return [
    new NextRequest(`https://kapta.test/api/webhooks/woocommerce/${storeId}`, { method: "POST", body, headers }),
    { params: Promise.resolve({ storeId }) },
  ];
}

beforeEach(() => {
  h.db = new FakeDb({ stores: [storeRow()] });
  // Sin red: lo que no pasa un `fetchImpl` (las notas de una anulación, MOM
  // §38.3) falla al instante y queda sin autor, como con WooCommerce caído.
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new TypeError("sin red en las pruebas");
    }),
  );
  spies.recompute.mockClear();
  spies.linkOrderToLead.mockClear();
  spies.linkOrdersToLeads.mockClear();
  spies.closeCart.mockClear();
});

describe("el ping de alta", () => {
  it("contesta 200 sin firma, antes de revisar nada más, y no escribe", async () => {
    const res = await POST(...request("webhook_id=17", { "content-type": "application/x-www-form-urlencoded" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, ping: true });
    expect(h.db.ops.filter((o) => o.op !== "select")).toEqual([]);
  });

  it("contesta 200 aunque la tienda todavía no tenga el secreto de los webhooks", async () => {
    h.db = new FakeDb({ stores: [storeRow({ woo_webhook_secret_enc: null })] });
    const res = await POST(...request("webhook_id=17"));
    expect(res.status).toBe(200);
  });

  it("a una tienda que no existe le contesta 404: la dirección está mal pegada", async () => {
    const res = await POST(...request("webhook_id=17", {}, "22222222-2222-4222-8222-222222222222"));
    expect(res.status).toBe(404);
    const bad = await POST(...request("webhook_id=17", {}, "no-es-un-uuid"));
    expect(bad.status).toBe(404);
  });
});

describe("la firma", () => {
  it("una firma mala es 401 y no toca nada", async () => {
    const body = JSON.stringify(wooOrder());
    const res = await POST(
      ...request(body, {
        "x-wc-webhook-topic": "order.created",
        "x-wc-webhook-signature": sign(body, "otro-secreto-cualquiera-123456"),
        "x-wc-webhook-source": `${SITE}/`,
      }),
    );
    expect(res.status).toBe(401);
    expect(h.db.ops.filter((o) => o.op !== "select")).toEqual([]);
    expect(h.db.rows("orders")).toEqual([]);
  });

  it("sin firma también es 401", async () => {
    const body = JSON.stringify(wooOrder());
    const r = await processWooWebhook(params(body, { signature: null }), h.db.client());
    expect(r.status).toBe("unauthorized");
    expect(wooWebhookHttpStatus(r)).toBe(401);
  });

  it("un pedido importado (creado antes del piso de la tienda) que llega por order.created no entra", async () => {
    h.db = new FakeDb({ stores: [storeRow({ woo_intake_from: "2026-10-27T14:00:00+00:00" })] });
    const old = JSON.stringify(wooOrder({ id: 77, date_created_gmt: "2026-09-12T18:00:00", date_modified_gmt: "2026-10-27T15:00:00" }));
    const r = await processWooWebhook(params(old), h.db.client());
    expect(r.status).toBe("ok");
    expect(r.message).toContain("woo_intake_from");
    expect(h.db.rows("orders")).toEqual([]);
    // Uno nuevo de verdad, sí.
    const fresh = JSON.stringify(wooOrder({ id: 78, date_created_gmt: "2026-10-27T15:00:00", date_modified_gmt: "2026-10-27T15:00:05" }));
    expect((await processWooWebhook(params(fresh), h.db.client())).status).toBe("ok");
    expect(h.db.rows("orders").map((o) => o.shopify_order_id)).toEqual(["wc-kp-78"]);
  });

  it("una tienda solo de Shopify (sin sitio WooCommerce): un POST sin firma no escribe nada en la tienda", async () => {
    // Kenku y Aurela hoy: ningún woo_*. Antes de la firma no hay a quién creerle.
    h.db = new FakeDb({
      stores: [
        storeRow({
          woo_site_url: null,
          woo_site_key: null,
          woo_consumer_key_enc: null,
          woo_consumer_secret_enc: null,
          woo_webhook_secret_enc: null,
        }),
      ],
    });
    const body = JSON.stringify(wooOrder());
    const r = await processWooWebhook(params(body, { signature: null }), h.db.client());
    expect(r.status).toBe("ignored");
    expect(wooWebhookHttpStatus(r)).toBe(200);
    expect(h.db.ops.filter((o) => o.op !== "select")).toEqual([]);
    expect(h.db.rows("stores")[0]!.woo_last_error).toBeNull();
  });

  it("una tienda sin secreto no procesa (200) y Ajustes lo dice en woo_last_error", async () => {
    h.db = new FakeDb({ stores: [storeRow({ woo_webhook_secret_enc: null })] });
    const body = JSON.stringify(wooOrder());
    const r = await processWooWebhook(params(body), h.db.client());
    expect(r.status).toBe("ignored");
    expect(wooWebhookHttpStatus(r)).toBe(200);
    expect(h.db.rows("orders")).toEqual([]);
    expect(h.db.rows("stores")[0]!.woo_last_error).toMatch(/^Webhook: .*secreto de los webhooks/);
  });

  it("firmado desde otro sitio (uno de prueba con el mismo secreto): no entra al Master", async () => {
    const body = JSON.stringify(wooOrder());
    const r = await processWooWebhook(params(body, { source: "https://staging.kenku.pe/" }), h.db.client());
    expect(r.status).toBe("ignored");
    expect(h.db.rows("orders")).toEqual([]);
    expect(h.db.rows("stores")[0]!.woo_last_error).toContain("staging.kenku.pe");
  });

  it("con www. o sin él, y con barra final, es el mismo sitio", async () => {
    const body = JSON.stringify(wooOrder());
    const r = await processWooWebhook(params(body, { source: "https://www.kenku.pe/" }), h.db.client());
    expect(r.status).toBe("ok");
  });
});

describe("pedido creado o actualizado", () => {
  it("entra a orders con el mapeador y los mismos efectos que un pedido de Shopify", async () => {
    const body = JSON.stringify(wooOrder());
    const res = await POST(
      ...request(body, {
        "x-wc-webhook-topic": "order.created",
        "x-wc-webhook-signature": sign(body),
        "x-wc-webhook-source": `${SITE}/`,
        "x-wc-webhook-delivery-id": "abc",
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    const orders = h.db.rows("orders");
    expect(orders).toHaveLength(1);
    expect(orders[0]).toMatchObject({
      store_id: STORE_ID,
      shopify_order_id: "wc-kp-1532",
      name: "#KP200001",
      platform: "woocommerce",
      financial_status: "pending",
      payment_gateway: "cod",
      cancelled_at: null,
      created_at: "2026-10-27T21:14:09Z",
      tags: ["easysell_cod_form"],
    });

    // El aviso queda registrado con el sha256 del cuerpo y procesado.
    const ev = h.db.rows("webhook_events");
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({
      store_id: STORE_ID,
      topic: "order.created",
      shopify_id: "wc-kp-1532",
      webhook_id: `wc:${createHash("sha256").update(body, "utf8").digest("hex")}`,
      processed: true,
    });

    // No es del bot: no gana lead ni recalcula rollups, pero saca el carrito
    // del mismo teléfono de la cola y refresca su fila del Master.
    expect(spies.linkOrderToLead).not.toHaveBeenCalled();
    expect(h.db.rpcCalls).toEqual([]);
    expect(spies.closeCart).toHaveBeenCalledWith(expect.anything(), STORE_ID, { phones: [orders[0]!.customer_phone] });
    expect(spies.recompute).toHaveBeenCalledWith(expect.anything(), [orders[0]!.id]);
  });

  it("un pedido del bot (kapso_conversation_id) gana el lead y recalcula el día", async () => {
    const body = JSON.stringify(
      wooOrder({
        meta_data: [
          { key: "kapta_channel", value: "kapso" },
          { key: "kapso_conversation_id", value: "conv_123" },
        ],
      }),
    );
    const r = await processWooWebhook(params(body), h.db.client());
    expect(r.status).toBe("ok");
    const row = h.db.rows("orders")[0]!;
    expect(row.tags).toEqual(expect.arrayContaining(["kapso", "whatsapp"]));
    expect(spies.linkOrderToLead).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ storeId: STORE_ID, phone: row.customer_phone, orderId: row.id, orderCreatedAt: row.created_at }),
    );
    expect(h.db.rpcCalls).toEqual([
      { name: "recompute_daily_rollups", args: { p_store_id: STORE_ID, p_from: "2026-10-27", p_to: "2026-10-27" } },
    ]);
    expect(spies.closeCart).not.toHaveBeenCalled();
  });

  it("order.updated a anulado conserva la fecha en que Kapta lo vio anulado la primera vez", async () => {
    h.db.rows("orders").push({
      id: "ord-1",
      store_id: STORE_ID,
      shopify_order_id: "wc-kp-1532",
      cancelled_at: "2026-10-28T10:00:00.000Z",
    });
    const body = JSON.stringify(wooOrder({ status: "cancelled", date_modified_gmt: "2026-10-29T08:00:00" }));
    const r = await processWooWebhook(params(body, { topic: "order.updated" }), h.db.client());
    expect(r.status).toBe("ok");
    expect(h.db.rows("orders")[0]).toMatchObject({
      cancelled_at: "2026-10-28T10:00:00.000Z",
      financial_status: "voided",
    });
    expect(spies.closeCart).not.toHaveBeenCalled();
  });

  it("order.restored deja el pedido vivo otra vez", async () => {
    h.db.rows("orders").push({
      id: "ord-1",
      store_id: STORE_ID,
      shopify_order_id: "wc-kp-1532",
      cancelled_at: "2026-10-28T10:00:00.000Z",
      financial_status: "voided",
    });
    const body = JSON.stringify(wooOrder({ date_modified_gmt: "2026-10-29T09:00:00" }));
    const r = await processWooWebhook(params(body, { topic: "order.restored" }), h.db.client());
    expect(r.status).toBe("ok");
    expect(h.db.rows("orders")[0]).toMatchObject({ cancelled_at: null, financial_status: "pending" });
  });

  it("un pedido pendiente de pago (o fallido, o borrador del checkout) no entra al Master", async () => {
    for (const status of ["pending", "failed", "checkout-draft"]) {
      const body = JSON.stringify(wooOrder({ status, date_modified_gmt: `2026-10-27T21:1${status.length % 10}:00` }));
      const r = await processWooWebhook(params(body), h.db.client());
      expect(r.status).toBe("ok");
      expect(r.message).toContain("no entra al Master");
    }
    expect(h.db.rows("orders")).toEqual([]);
  });

  it("un pendiente sin pagar que WooCommerce anula solo no entra como Anulado (nunca fue pedido)", async () => {
    const body = JSON.stringify(wooOrder({ status: "cancelled", payment_method: "flow", date_paid_gmt: null }));
    const r = await processWooWebhook(params(body, { topic: "order.updated" }), h.db.client());
    expect(r).toMatchObject({ status: "ok", message: expect.stringContaining("no entra al Master") });
    expect(h.db.rows("orders")).toEqual([]);
  });

  it("uno anulado que sí llegó a «processing» (date_paid) entra aunque Kapta no lo hubiera visto vivo", async () => {
    const body = JSON.stringify(wooOrder({ status: "cancelled", date_paid_gmt: "2026-10-27T21:14:12" }));
    const r = await processWooWebhook(params(body, { topic: "order.updated" }), h.db.client());
    expect(r).toEqual({ status: "ok" });
    expect(h.db.rows("orders")[0]).toMatchObject({ shopify_order_id: "wc-kp-1532", financial_status: "voided" });
  });

  it("el tema sale de Resource + Event si falta X-WC-Webhook-Topic", async () => {
    const body = JSON.stringify(wooOrder());
    const r = await processWooWebhook(params(body, { topic: null, resource: "order", event: "updated" }), h.db.client());
    expect(r.status).toBe("ok");
    expect(h.db.rows("webhook_events")[0]!.topic).toBe("order.updated");
  });
});

describe("repetidos: el sha256 del cuerpo, no el Delivery-ID", () => {
  it("el mismo cuerpo dos veces se procesa una (aunque cambie el Delivery-ID)", async () => {
    const body = JSON.stringify(wooOrder());
    const first = await processWooWebhook(params(body, { deliveryId: "aaa" }), h.db.client());
    const second = await processWooWebhook(params(body, { deliveryId: "bbb" }), h.db.client());
    expect(first.status).toBe("ok");
    expect(second.status).toBe("duplicate");
    expect(h.db.opsOn("orders", "upsert")).toHaveLength(1);

    const res = await POST(
      ...request(body, {
        "x-wc-webhook-topic": "order.created",
        "x-wc-webhook-signature": sign(body),
        "x-wc-webhook-source": `${SITE}/`,
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, duplicate: true });
  });

  it("dos pedidos distintos con el MISMO Delivery-ID (mismo segundo) entran los dos", async () => {
    const a = JSON.stringify(wooOrder({ id: 1532, number: "KP200001" }));
    const b = JSON.stringify(wooOrder({ id: 1533, number: "KP200002" }));
    expect((await processWooWebhook(params(a, { deliveryId: "same" }), h.db.client())).status).toBe("ok");
    expect((await processWooWebhook(params(b, { deliveryId: "same" }), h.db.client())).status).toBe("ok");
    expect(h.db.rows("orders").map((o) => o.shopify_order_id).sort()).toEqual(["wc-kp-1532", "wc-kp-1533"]);
  });

  it("la clave de order.deleted lleva además el Delivery-ID: su cuerpo es solo {id}", () => {
    const body = JSON.stringify({ id: 1532 });
    expect(wooWebhookEventKey("order.deleted", body, "x")).not.toBe(wooWebhookEventKey("order.deleted", body, "y"));
    expect(wooWebhookEventKey("order.updated", body, "x")).toBe(wooWebhookEventKey("order.updated", body, "y"));
  });
});

describe("order.deleted (papelera)", () => {
  /** La API de WooCommerce falsa: `GET /orders/{id}` devuelve `live` (o el código que se pida). */
  function wooApi(live: Row | number) {
    const calls: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      if (typeof live === "number") return new Response(JSON.stringify({ code: "woocommerce_rest_shop_order_invalid_id" }), { status: live });
      return new Response(JSON.stringify(live), { status: 200 });
    }) as typeof fetch;
    return { calls, fetchImpl };
  }
  const existing = (over: Row = {}) => ({
    id: "ord-1",
    store_id: STORE_ID,
    shopify_order_id: "wc-kp-1532",
    cancelled_at: null,
    financial_status: "pending",
    updated_at: "2026-10-27T21:14:12Z",
    ...over,
  });
  const del = (deliveryId = "d1") => params(JSON.stringify({ id: 1532 }), { topic: "order.deleted", deliveryId });

  it("relee el pedido por la API: entra anulado con su fecha de WooCommerce, y nunca se borra", async () => {
    h.db.rows("orders").push(existing());
    const api = wooApi(wooOrder({ status: "trash", date_modified_gmt: "2026-10-28T12:00:00" }));
    const r = await processWooWebhook(del(), h.db.client(), { fetchImpl: api.fetchImpl });
    expect(r.status).toBe("ok");
    expect(api.calls[0]).toContain("https://kenku.pe/wp-json/wc/v3/orders/1532");
    expect(h.db.opsOn("orders", "delete")).toEqual([]);
    expect(h.db.rows("orders")).toHaveLength(1);
    expect(h.db.rows("orders")[0]).toMatchObject({
      cancelled_at: "2026-10-28T12:00:00Z",
      financial_status: "voided",
      updated_at: "2026-10-28T12:00:00Z",
    });
    expect(spies.recompute).toHaveBeenCalledWith(expect.anything(), ["ord-1"]);
  });

  it("un aviso de papelera que llega tarde (el pedido ya volvió) no lo anula", async () => {
    h.db.rows("orders").push(existing());
    const api = wooApi(wooOrder({ status: "processing", date_modified_gmt: "2026-10-28T12:05:00" }));
    const r = await processWooWebhook(del(), h.db.client(), { fetchImpl: api.fetchImpl });
    expect(r.status).toBe("ok");
    expect(h.db.rows("orders")[0]).toMatchObject({ cancelled_at: null, financial_status: "pending" });
  });

  it("sin API (WooCommerce no contesta, o ya no existe): lo marca anulado igual", async () => {
    for (const status of [404, 500]) {
      h.db = new FakeDb({ stores: [storeRow()], orders: [existing()] });
      const r = await processWooWebhook(del(), h.db.client(), { fetchImpl: wooApi(status).fetchImpl });
      expect(r.status, String(status)).toBe("ok");
      expect(h.db.rows("orders")[0]!.cancelled_at).toEqual(expect.any(String));
      expect(h.db.rows("orders")[0]!.financial_status).toBe("voided");
      expect(h.db.opsOn("orders", "delete")).toEqual([]);
    }
  });

  it("una tienda sin claves de la API lo marca sin llamar a nadie", async () => {
    h.db = new FakeDb({ stores: [storeRow({ woo_consumer_key_enc: null })], orders: [existing()] });
    const api = wooApi(500);
    await processWooWebhook(del(), h.db.client(), { fetchImpl: api.fetchImpl });
    expect(api.calls).toEqual([]);
    expect(h.db.rows("orders")[0]!.financial_status).toBe("voided");
  });

  it("no mueve la fecha de un pedido que ya estaba anulado", async () => {
    h.db.rows("orders").push(existing({ cancelled_at: "2026-10-28T10:00:00.000Z", financial_status: "voided" }));
    await processWooWebhook(del(), h.db.client(), {
      fetchImpl: wooApi(wooOrder({ status: "trash", date_modified_gmt: "2026-10-29T12:00:00" })).fetchImpl,
    });
    expect(h.db.rows("orders")[0]!.cancelled_at).toBe("2026-10-28T10:00:00.000Z");
    h.db.rows("orders")[0]!.cancelled_at = "2026-10-28T10:00:00.000Z";
    await processWooWebhook(del("d9"), h.db.client(), { fetchImpl: wooApi(500).fetchImpl });
    expect(h.db.rows("orders")[0]!.cancelled_at).toBe("2026-10-28T10:00:00.000Z");
  });

  it("a la papelera, de vuelta, y a la papelera otra vez: la segunda también se procesa", async () => {
    h.db.rows("orders").push(existing());
    const down = wooApi(500).fetchImpl;
    await processWooWebhook(del("d1"), h.db.client(), { fetchImpl: down });
    await processWooWebhook(
      params(JSON.stringify(wooOrder({ date_modified_gmt: "2026-10-29T09:00:00" })), { topic: "order.restored" }),
      h.db.client(),
    );
    expect(h.db.rows("orders")[0]!.cancelled_at).toBeNull();
    const again = await processWooWebhook(del("d2"), h.db.client(), { fetchImpl: down });
    expect(again.status).toBe("ok");
    expect(h.db.rows("orders")[0]!.cancelled_at).toEqual(expect.any(String));
  });

  it("un pedido que Kapta no tiene: 200, nada que marcar, y ni siquiera se consulta", async () => {
    const api = wooApi(wooOrder({ id: 999, status: "trash" }));
    const r = await processWooWebhook(params(JSON.stringify({ id: 999 }), { topic: "order.deleted" }), h.db.client(), {
      fetchImpl: api.fetchImpl,
    });
    expect(r).toMatchObject({ status: "ok", message: "el pedido no estaba en Kapta" });
    expect(api.calls).toEqual([]);
    expect(h.db.rows("orders")).toEqual([]);
  });
});

describe("un aviso más viejo que lo guardado no lo pisa", () => {
  it("un order.updated que llega tarde (la sincronización ya leyó un cambio posterior) no se aplica", async () => {
    h.db.rows("orders").push({
      id: "ord-1",
      store_id: STORE_ID,
      shopify_order_id: "wc-kp-1532",
      cancelled_at: "2026-10-28T10:00:00Z",
      financial_status: "voided",
      updated_at: "2026-10-28T10:00:00Z",
    });
    const stale = JSON.stringify(wooOrder({ status: "processing", date_modified_gmt: "2026-10-28T09:59:00" }));
    const r = await processWooWebhook(params(stale, { topic: "order.updated" }), h.db.client());
    expect(r).toMatchObject({ status: "ok", message: expect.stringContaining("más viejo") });
    expect(h.db.rows("orders")[0]).toMatchObject({ cancelled_at: "2026-10-28T10:00:00Z", financial_status: "voided" });
    expect(h.db.opsOn("orders", "upsert")).toEqual([]);
    // El aviso igual queda procesado: no se vuelve a mirar.
    expect(h.db.rows("webhook_events")[0]!.processed).toBe(true);
  });

  it("uno de la misma fecha sí se aplica (es idempotente)", async () => {
    h.db.rows("orders").push({ id: "ord-1", store_id: STORE_ID, shopify_order_id: "wc-kp-1532", updated_at: "2026-10-27T21:14:12Z" });
    const r = await processWooWebhook(params(JSON.stringify(wooOrder()), { topic: "order.updated" }), h.db.client());
    expect(r).toEqual({ status: "ok" });
    expect(h.db.opsOn("orders", "upsert")).toHaveLength(1);
  });
});

describe("lo que nunca va a poder procesarse contesta 2xx", () => {
  async function post(body: string, topic = "order.created") {
    return POST(
      ...request(body, {
        "x-wc-webhook-topic": topic,
        "x-wc-webhook-signature": sign(body),
        "x-wc-webhook-source": `${SITE}/`,
      }),
    );
  }

  it("un tema que no es de pedidos", async () => {
    const res = await post(JSON.stringify({ id: 10, name: "Zapatilla" }), "product.updated");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, ignored: true });
    expect(h.db.rows("webhook_events")).toEqual([]);
  });

  it("un cuerpo firmado que no es JSON, o un pedido sin id", async () => {
    expect((await post("esto no es json")).status).toBe(200);
    expect((await post(JSON.stringify({ id: "abc", status: "processing" }))).status).toBe(200);
    expect((await post(JSON.stringify([1, 2]))).status).toBe(200);
    expect(h.db.rows("orders")).toEqual([]);
  });

  it("una tienda sin clave del sitio", async () => {
    h.db = new FakeDb({ stores: [storeRow({ woo_site_key: null })] });
    const res = await post(JSON.stringify(wooOrder()));
    expect(res.status).toBe(200);
    expect(h.db.rows("stores")[0]!.woo_last_error).toContain("clave del sitio");
  });

  it("una tienda que no existe", async () => {
    const body = JSON.stringify(wooOrder());
    const res = await POST(
      ...request(body, { "x-wc-webhook-topic": "order.created", "x-wc-webhook-signature": sign(body) }, "33333333-3333-4333-8333-333333333333"),
    );
    expect(res.status).toBe(200);
  });

  it("una base caída: 200 con ok:false, el motivo en webhook_events.error, y la pasada lo recoge después", async () => {
    h.db.failOn = (table, op) => (table === "orders" && op === "upsert" ? { message: "canceling statement due to statement timeout" } : null);
    const res = await post(JSON.stringify(wooOrder()));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: false });
    const ev = h.db.rows("webhook_events")[0]!;
    expect(ev.processed).toBe(false);
    expect(ev.error).toContain("statement timeout");
  });

  it("si la lectura de la tienda falla en el ping, 503 (se vuelve a guardar el webhook)", async () => {
    h.db.failOn = (table) => (table === "stores" ? { message: "521 origin down" } : null);
    const res = await POST(...request("webhook_id=1"));
    expect(res.status).toBe(503);
  });
});

describe("el camino de Shopify no cambió", () => {
  const ingest = readFileSync(join(process.cwd(), "lib/ingest.ts"), "utf8");
  const between = (from: string, to: string) => ingest.slice(ingest.indexOf(from), ingest.indexOf(to));

  it("processShopifyWebhook, processOrderWebhook y processDraftOrderWebhook no mencionan WooCommerce", () => {
    const shopify = between("export async function processShopifyWebhook(", "export interface FlowWebhookParams");
    const orderWh = between("async function processOrderWebhook(", "async function processDraftOrderWebhook(");
    const draftWh = between("async function processDraftOrderWebhook(", "// WooCommerce: webhooks de pedidos");
    for (const src of [shopify, orderWh, draftWh]) {
      expect(src.length).toBeGreaterThan(200);
      expect(src).not.toMatch(/woo/i);
    }
  });

  it("la ruta de Shopify no importa nada de WooCommerce", () => {
    const route = readFileSync(join(process.cwd(), "app/api/webhooks/shopify/[storeId]/route.ts"), "utf8");
    expect(route).not.toMatch(/woo/i);
    expect(route).toContain("processShopifyWebhook");
  });

  it("getStoreCreds no lee ni descifra columnas de WooCommerce", () => {
    const creds = between("export async function getStoreCreds(", "export async function ownAppCredsForUse(");
    expect(creds).not.toMatch(/woo/i);
  });
});
