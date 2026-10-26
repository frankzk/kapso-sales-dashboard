// «Anular pedido» desde Kapta para los pedidos de WooCommerce (MOM §38.15):
// las reglas que lo frenan, la llamada a WooCommerce (PUT a «cancelled», nunca
// la papelera, con el tope y el reintento de autenticación de «Generar
// pedido») y lo que queda en Kapta: la fila anulada al instante con
// `mapWooOrder` sobre la respuesta y UN solo «Anulado en WooCommerce» en la
// Actividad, con quién y el motivo, aunque después llegue el webhook o se
// pulse dos veces. Si WooCommerce no contesta, nada queda anulado. Sin red ni
// base: WooCommerce y la base son falsos.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
});

const h = vi.hoisted(() => ({
  recompute: vi.fn(async () => ({ requested: 1, written: 1, error: null })),
}));

vi.mock("@/lib/order-master", async (orig) => ({
  ...(await orig<typeof import("@/lib/order-master")>()),
  recomputeOrderMasterSafe: h.recompute,
}));

import { readFileSync } from "node:fs";
import { encrypt } from "@/lib/crypto";
import { applyWooOrderResponse } from "@/lib/ingest";
import { wooCredsFromRow, type WooStoreCreds } from "@/lib/woocommerce-intake";
import {
  WOO_CANCEL_PERMISSION,
  WOO_CANCEL_REASONS,
  validateWooCancelReason,
  wooCancelBlocks,
  wooCancelEventNote,
  type WooCancelFacts,
} from "@/lib/woo-cancel";
import {
  WOO_CANCEL_SOURCE,
  WOO_CANCEL_TIMEOUTS,
  cancelWooOrderFromKapta,
  cancelWooOrderInStore,
  wooKaptaCancelOperationId,
} from "@/lib/woo-cancel-server";
import { WOO_SALE_TIMEOUTS } from "@/lib/woocommerce-orders";
import { FUNCTIONAL_ROLES, permissionsFor } from "@/lib/permissions";
import { FakeDb, type Row } from "./woocommerce-fake-db";
import { fakeWooShop } from "./woocommerce-fake-shop";

const STORE = "11111111-1111-4111-8111-111111111111";
const ORDER = "22222222-2222-4222-8222-222222222222";
const USER = "33333333-3333-4333-8333-333333333333";
const CK = "ck_0123456789abcdef0123456789abcdef01234567";
const CS = "cs_0123456789abcdef0123456789abcdef01234567";
const REQ = "5d1c2f7e-0b1a-4c3d-9e8f-123456789abc";
const WOO_ID = 510;

function storeRow(): Row {
  return {
    id: STORE,
    status: "active",
    timezone: "America/Lima",
    platform: "woocommerce",
    platform_switched_at: "2026-10-25T21:11:00Z",
    woo_intake_from: "2026-10-24T15:00:00Z",
    woo_site_url: "https://kenku.pe",
    woo_site_key: "kp",
    woo_consumer_key_enc: encrypt(CK),
    woo_consumer_secret_enc: encrypt(CS),
    woo_webhook_secret_enc: null,
    woo_last_error: null,
  };
}

function wooOrder(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: WOO_ID,
    number: "KP200010",
    status: "processing",
    currency: "PEN",
    date_created_gmt: "2026-10-26T14:00:00",
    date_modified_gmt: "2026-10-26T14:05:00",
    date_paid_gmt: "2026-10-26T14:05:00",
    prices_include_tax: false,
    customer_note: "",
    billing: {
      first_name: "Ana",
      last_name: "Torres",
      address_1: "Av. Primavera 123",
      city: "Santiago de Surco",
      state: "LMA",
      country: "PE",
      phone: "+51988805509",
      email: "",
    },
    shipping: {
      first_name: "Ana",
      last_name: "Torres",
      address_1: "Av. Primavera 123",
      city: "Santiago de Surco",
      state: "LMA",
      country: "PE",
    },
    payment_method: "cod",
    payment_method_title: "Cash on delivery",
    meta_data: [{ id: 1, key: "kapta_channel", value: "venta_manual" }],
    line_items: [{ id: 1, name: "EggMixer", product_id: 10, variation_id: 0, quantity: 1, subtotal: "89.00", total: "89.00", sku: "EGG-1" }],
    shipping_lines: [],
    fee_lines: [],
    coupon_lines: [],
    refunds: [],
    total: "89.00",
    ...over,
  };
}

function orderRow(over: Row = {}): Row {
  return {
    id: ORDER,
    store_id: STORE,
    shopify_order_id: `wc-kp-${WOO_ID}`,
    name: "#KP200010",
    platform: "woocommerce",
    cancelled_at: null,
    updated_at: "2026-10-26T14:05:00Z",
    created_at: "2026-10-26T14:00:00Z",
    financial_status: "pending",
    tags: ["venta_manual"],
    customer_phone: "51988805509",
    ...over,
  };
}

function setup(opts: { order?: Row; master?: Row; extra?: Record<string, Row[]>; shop?: Parameters<typeof fakeWooShop>[0] } = {}) {
  const db = new FakeDb({
    stores: [storeRow()],
    orders: [opts.order ?? orderRow()],
    order_master: [{ order_id: ORDER, store_id: STORE, general_status: "pendiente", ...(opts.master ?? {}) }],
    ...(opts.extra ?? {}),
  });
  const shop = fakeWooShop({ now: () => new Date("2026-10-26T15:00:00Z"), ...(opts.shop ?? {}) });
  shop.orders.set(WOO_ID, wooOrder());
  return { db, shop };
}

const motivo = { reasonCode: "cliente_desiste", reasonText: "Llamó y ya no lo quiere", requestId: REQ };

function run(db: FakeDb, shop: ReturnType<typeof fakeWooShop>, over: Partial<typeof motivo> = {}) {
  return cancelWooOrderFromKapta({
    admin: db.client(),
    orderId: ORDER,
    userId: USER,
    ...motivo,
    ...over,
    fetchImpl: shop.fetchImpl,
    now: () => "2026-10-26T15:00:00.000Z",
  });
}

function cancelEvents(db: FakeDb): Row[] {
  return db.rows("order_events").filter((e) => e.kind === "cancelled_woocommerce");
}

const forbiddenFetch = vi.fn(async () => {
  throw new Error("no debía llamar a la red");
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.stubGlobal("fetch", forbiddenFetch);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Las reglas
// ---------------------------------------------------------------------------

const BASE: WooCancelFacts = {
  platform: "woocommerce",
  generalStatus: "pendiente",
  financialStatus: "pending",
  shipments: [],
  payments: [],
  companion: { travelsIn: null, carries: [] },
};

describe("wooCancelBlocks: qué impide anular desde Kapta", () => {
  it("un pedido de WooCommerce vivo, sin salidas ni dinero, se puede anular", () => {
    expect(wooCancelBlocks(BASE)).toEqual([]);
  });

  it("un pedido de Shopify no: se anula en Shopify, como siempre", () => {
    const blocks = wooCancelBlocks({ ...BASE, platform: "shopify" });
    expect(blocks.map((b) => b.code)).toEqual(["no_woocommerce"]);
    expect(blocks[0]!.message).toMatch(/Shopify/);
    expect(wooCancelBlocks({ ...BASE, platform: null }).map((b) => b.code)).toEqual(["no_woocommerce"]);
  });

  it("entregado o devuelto no se anula", () => {
    expect(wooCancelBlocks({ ...BASE, generalStatus: "entregado" }).map((b) => b.code)).toEqual(["entregado"]);
    expect(wooCancelBlocks({ ...BASE, generalStatus: "devuelto" }).map((b) => b.code)).toEqual(["devuelto"]);
  });

  it("una salida o guía viva frena; anulada sin salir, no", () => {
    const viva = wooCancelBlocks({
      ...BASE,
      shipments: [{ courier: "aliclik", guide_code: "AUR5X1", delivery_status: "pendiente", custody_state: "empresa" }],
    });
    expect(viva.map((b) => b.code)).toEqual(["salida_activa"]);
    expect(viva[0]!.message).toContain("AUR5X1");
    expect(viva[0]!.message).toContain("Aliclik");
    expect(
      wooCancelBlocks({ ...BASE, shipments: [{ courier: "aliclik", guide_code: "AUR5X1", delivery_status: "anulado", custody_state: "empresa" }] }),
    ).toEqual([]);
  });

  it("la caja que ya salió frena aunque su guía esté anulada; devuelta al almacén, no", () => {
    const afuera = wooCancelBlocks({
      ...BASE,
      shipments: [{ courier: "tanders", guide_code: "T-9", delivery_status: "anulado", custody_state: "retorno" }],
    });
    expect(afuera.map((b) => b.code)).toEqual(["caja_afuera"]);
    const enRuta = wooCancelBlocks({
      ...BASE,
      shipments: [{ courier: "propio", guide_code: null, delivery_status: "en_ruta", custody_state: "courier" }],
    });
    // Una sola razón por salida: la de la caja en la calle.
    expect(enRuta.map((b) => b.code)).toEqual(["caja_afuera"]);
    expect(
      wooCancelBlocks({ ...BASE, shipments: [{ courier: "tanders", guide_code: "T-9", delivery_status: "anulado", custody_state: "devuelto" }] }),
    ).toEqual([]);
  });

  it("una salida entregada frena", () => {
    const b = wooCancelBlocks({ ...BASE, shipments: [{ courier: "shalom", guide_code: "S1", delivery_status: "entregado", custody_state: "courier" }] });
    expect(b.map((x) => x.code)).toEqual(["salida_entregada"]);
  });

  it("dinero en la mano frena: cobrado en la tienda, un pago validado o un comprobante sin resolver", () => {
    expect(wooCancelBlocks({ ...BASE, financialStatus: "paid" }).map((b) => b.code)).toEqual(["cobrado_tienda"]);
    expect(wooCancelBlocks({ ...BASE, payments: [{ validation_status: "validado" }] }).map((b) => b.code)).toEqual(["pago_validado"]);
    expect(wooCancelBlocks({ ...BASE, payments: [{ validation_status: "pendiente_revision" }] }).map((b) => b.code)).toEqual([
      "comprobante_en_revision",
    ]);
    // Un comprobante rechazado no es dinero.
    expect(wooCancelBlocks({ ...BASE, payments: [{ validation_status: "rechazado" }] })).toEqual([]);
    // La ficha no tiene los comprobantes: null no frena allí (el servidor los lee).
    expect(wooCancelBlocks({ ...BASE, payments: null })).toEqual([]);
  });

  it("compartir caja con otro pedido (§32) frena", () => {
    expect(wooCancelBlocks({ ...BASE, companion: { travelsIn: "#KP200001", carries: [] } })[0]!.message).toContain("#KP200001");
    expect(wooCancelBlocks({ ...BASE, companion: { travelsIn: null, carries: ["#KP200002"] } })[0]!.message).toContain("#KP200002");
  });
});

describe("el motivo es obligatorio: de la lista y con texto", () => {
  it("valida el código y el texto", () => {
    expect(validateWooCancelReason("", "algo largo")).toMatchObject({ ok: false });
    expect(validateWooCancelReason("inventado", "algo largo")).toMatchObject({ ok: false });
    expect(validateWooCancelReason("duplicado", "  no ")).toMatchObject({ ok: false });
    expect(validateWooCancelReason("duplicado", "x".repeat(501))).toMatchObject({ ok: false });
    expect(validateWooCancelReason("duplicado", "  Se creó dos   veces ")).toEqual({
      ok: true,
      code: "duplicado",
      label: "Pedido duplicado",
      text: "Se creó dos veces",
    });
  });

  it("quién puede: «Registrar estado a mano», solo owner y admin", () => {
    expect(WOO_CANCEL_PERMISSION).toBe("master.set_status");
    expect(permissionsFor(["owner"]).has(WOO_CANCEL_PERMISSION)).toBe(true);
    expect(permissionsFor(["admin"]).has(WOO_CANCEL_PERMISSION)).toBe(true);
    expect(permissionsFor(["vendedora"]).has(WOO_CANCEL_PERMISSION)).toBe(false);
    expect(permissionsFor(["viewer"]).has(WOO_CANCEL_PERMISSION)).toBe(false);
    // Ningún rol por función lo trae (tampoco Supervisión ni Administración).
    const allRoles = FUNCTIONAL_ROLES.map((r) => r.role);
    expect(permissionsFor(["vendedora"], [], allRoles).has(WOO_CANCEL_PERMISSION)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// La llamada a WooCommerce
// ---------------------------------------------------------------------------

function clientFor(shop: ReturnType<typeof fakeWooShop>) {
  return { siteUrl: "https://kenku.pe", consumerKey: CK, consumerSecret: CS, fetchImpl: shop.fetchImpl };
}

describe("cancelWooOrderInStore: PUT a «cancelled», nunca la papelera", () => {
  it("usa los topes de «Generar pedido»", () => {
    expect(WOO_CANCEL_TIMEOUTS.update).toBe(WOO_SALE_TIMEOUTS.update);
    expect(WOO_CANCEL_TIMEOUTS.reread).toBe(WOO_SALE_TIMEOUTS.cleanup);
  });

  it("anula con un PUT {status: cancelled}, sin DELETE ni trash", async () => {
    const { shop } = setup();
    const out = await cancelWooOrderInStore({ client: clientFor(shop), wooId: WOO_ID });
    expect(out).toMatchObject({ kind: "cancelled", confirmedBy: "put" });
    expect(shop.calls.map((c) => `${c.method} ${c.path}`)).toEqual([`PUT /orders/${WOO_ID}`]);
    expect(shop.calls[0]!.body).toEqual({ status: "cancelled" });
    expect(shop.calls.some((c) => c.method === "DELETE" || JSON.stringify(c.body ?? {}).includes("trash"))).toBe(false);
  });

  it("el hosting que borra la cabecera Authorization: reintenta una vez con la query string", async () => {
    const { shop } = setup({
      shop: { failOnce: { [`PUT /orders/${WOO_ID}`]: { status: 401, body: { code: "woocommerce_rest_cannot_edit", message: "no" } } } },
    });
    const out = await cancelWooOrderInStore({ client: clientFor(shop), wooId: WOO_ID });
    expect(out.kind).toBe("cancelled");
    expect(shop.calls).toHaveLength(2);
    expect(shop.calls[0]!.auth).toMatch(/^Basic /);
    expect(shop.calls[1]!.auth).toBeNull();
    expect(shop.calls[1]!.query.get("consumer_key")).toBe(CK);
  });

  it("si el PUT se corta pero se aplicó, lo confirma releyendo", async () => {
    const { shop } = setup({ shop: { putAppliesThenTimesOut: true } });
    const out = await cancelWooOrderInStore({ client: clientFor(shop), wooId: WOO_ID });
    expect(out).toMatchObject({ kind: "cancelled", confirmedBy: "reread" });
    expect(shop.calls.map((c) => c.method)).toEqual(["PUT", "GET"]);
  });

  it("si no contesta y no se puede releer, no se sabe: error", async () => {
    const { shop } = setup({
      shop: { failAlways: { [`PUT /orders/${WOO_ID}`]: "timeout", [`GET /orders/${WOO_ID}`]: "timeout" } },
    });
    const out = await cancelWooOrderInStore({ client: clientFor(shop), wooId: WOO_ID });
    expect(out).toMatchObject({ kind: "error", unknown: true });
  });

  it("un rechazo (4xx) es un no: no relee", async () => {
    const { shop } = setup({
      shop: { failAlways: { [`PUT /orders/${WOO_ID}`]: { status: 400, body: { code: "woocommerce_rest_invalid", message: "No." } } } },
    });
    const out = await cancelWooOrderInStore({ client: clientFor(shop), wooId: WOO_ID });
    expect(out).toMatchObject({ kind: "error", unknown: false });
    expect(shop.calls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// De punta a punta
// ---------------------------------------------------------------------------

describe("cancelWooOrderFromKapta", () => {
  it("anula en WooCommerce, deja la fila anulada al instante y un hecho con quién y el motivo", async () => {
    const { db, shop } = setup();
    const res = await run(db, shop);
    expect(res).toEqual({ ok: true, notice: "#KP200010 quedó anulado en WooCommerce." });

    const order = db.rows("orders").find((o) => o.id === ORDER)!;
    expect(order.cancelled_at).toBeTruthy();
    expect(order.financial_status).toBe("voided");
    expect(order.raw.woo.status).toBe("cancelled");
    expect(h.recompute).toHaveBeenCalledWith(expect.anything(), [ORDER]);

    const events = cancelEvents(db);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      store_id: STORE,
      order_id: ORDER,
      actor: USER,
      source: WOO_CANCEL_SOURCE,
      note: wooCancelEventNote("La clienta ya no lo quiere", "Llamó y ya no lo quiere"),
      operation_id: wooKaptaCancelOperationId(ORDER, REQ),
    });
    expect(events[0]!.payload).toMatchObject({ woo_order_id: String(WOO_ID), woo_status: "cancelled", reason_code: "cliente_desiste" });
    // Solo el PUT: ni notas de WooCommerce (el hecho ya dice quién) ni la papelera.
    expect(shop.calls.map((c) => `${c.method} ${c.path}`)).toEqual([`PUT /orders/${WOO_ID}`]);
  });

  it("el webhook que llega después no deja otro «Anulado en WooCommerce»", async () => {
    const { db, shop } = setup();
    await run(db, shop);
    const creds = wooCredsFromRow(db.rows("stores")[0]!) as WooStoreCreds & { siteKey: string };
    // El mismo pedido, ya anulado, como lo manda el webhook (y una versión posterior).
    const later = { ...shop.orders.get(WOO_ID), date_modified_gmt: "2026-10-26T15:10:00" };
    const applied = await applyWooOrderResponse(db.client(), creds, later as never, shop.fetchImpl);
    expect(applied.applied).toBe(true);
    expect(cancelEvents(db)).toHaveLength(1);
  });

  it("en la carrera con el webhook (lo aplica entre la respuesta y la escritura de Kapta), el motivo no se pierde", async () => {
    const { db, shop } = setup();
    const creds = wooCredsFromRow(db.rows("stores")[0]!) as WooStoreCreds & { siteKey: string };
    const fetchImpl: typeof fetch = async (input, init) => {
      const res = await shop.fetchImpl(input, init);
      if ((init?.method ?? "GET") === "PUT") {
        // El webhook de esa anulación entra antes de que Kapta escriba.
        await applyWooOrderResponse(db.client(), creds, (await res.clone().json()) as never, shop.fetchImpl);
      }
      return res;
    };
    const res = await cancelWooOrderFromKapta({ admin: db.client(), orderId: ORDER, userId: USER, ...motivo, fetchImpl });
    expect(res.ok).toBe(true);
    // El de la entrada (sin motivo) y el de Kapta (con quién y el motivo): el
    // único caso con dos, documentado en §38.15.
    expect(cancelEvents(db).map((e) => e.source).sort()).toEqual([WOO_CANCEL_SOURCE, "woocommerce"]);
    expect(cancelEvents(db).find((e) => e.source === WOO_CANCEL_SOURCE)!.actor).toBe(USER);
  });

  it("doble clic o reintento: una sola llamada que anula y un solo hecho", async () => {
    const { db, shop } = setup();
    const [a, b] = await Promise.all([run(db, shop), run(db, shop)]);
    expect(a.ok && b.ok).toBe(true);
    expect(cancelEvents(db)).toHaveLength(1);
    const again = await run(db, shop);
    expect(again).toEqual({ ok: true, already: true, notice: "#KP200010 ya está anulado en la tienda." });
    // El tercero ni llama a WooCommerce.
    expect(shop.calls.filter((c) => c.method === "PUT").length).toBeLessThanOrEqual(2);
    expect(shop.calls.every((c) => c.method !== "DELETE")).toBe(true);
  });

  it("si WooCommerce no contesta, nada queda anulado en Kapta", async () => {
    const { db, shop } = setup({
      shop: { failAlways: { [`PUT /orders/${WOO_ID}`]: "timeout", [`GET /orders/${WOO_ID}`]: "network" } },
    });
    const res = await run(db, shop);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/No se marcó nada en Kapta/);
    expect(db.rows("orders")[0]!.cancelled_at).toBeNull();
    expect(db.rows("order_events")).toHaveLength(0);
    expect(h.recompute).not.toHaveBeenCalled();
  });

  it("si un plugin lo deja en otro estado, no se marca nada", async () => {
    const { db, shop } = setup();
    // WooCommerce contesta el PUT pero el pedido sigue «processing».
    const fetchImpl: typeof fetch = async (input, init) => {
      if ((init?.method ?? "GET") === "PUT") {
        return new Response(JSON.stringify(wooOrder()), { status: 200, headers: { "content-type": "application/json" } });
      }
      return shop.fetchImpl(input, init);
    };
    const res = await cancelWooOrderFromKapta({ admin: db.client(), orderId: ORDER, userId: USER, ...motivo, fetchImpl });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/«processing»/);
    expect(db.rows("orders")[0]!.cancelled_at).toBeNull();
    expect(db.rows("order_events")).toHaveLength(0);
  });

  it("un pedido de Shopify: no cambia nada, ni una llamada", async () => {
    const { db, shop } = setup({ order: orderRow({ platform: "shopify", shopify_order_id: "6100000000001", name: "#KP143000" }) });
    const res = await run(db, shop);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.blocks?.[0]?.code).toBe("no_woocommerce");
    expect(shop.calls).toHaveLength(0);
    expect(db.opsOn("orders", "upsert")).toHaveLength(0);
    expect(db.rows("order_events")).toHaveLength(0);
  });

  it("con una guía viva o un pago validado no se llama a WooCommerce", async () => {
    for (const extra of <Record<string, Row[]>[]>[
      { shipments: [{ id: "s1", order_id: ORDER, courier: "aliclik", guide_code: "AUR1", delivery_status: "pendiente", custody_state: "empresa" }] },
      { order_payments: [{ id: "p1", order_id: ORDER, validation_status: "validado" }] },
    ]) {
      const { db, shop } = setup({ extra });
      const res = await run(db, shop);
      expect(res.ok).toBe(false);
      expect(shop.calls).toHaveLength(0);
      expect(db.rows("orders")[0]!.cancelled_at).toBeNull();
    }
  });

  it("entregado en el Master no se anula", async () => {
    const { db, shop } = setup({ master: { general_status: "entregado" } });
    const res = await run(db, shop);
    expect(res.ok).toBe(false);
    expect(shop.calls).toHaveLength(0);
  });

  it("si no se pueden leer los pagos, no se anula: «no lo sé» no es «no hay»", async () => {
    const { db, shop } = setup();
    db.failOn = (table) => (table === "order_payments" ? { message: "timeout" } : null);
    const res = await run(db, shop);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/comprobantes/);
    expect(shop.calls).toHaveLength(0);
  });

  it("sin motivo no se anula", async () => {
    const { db, shop } = setup();
    expect((await run(db, shop, { reasonCode: "" })).ok).toBe(false);
    expect((await run(db, shop, { reasonText: "" })).ok).toBe(false);
    expect((await run(db, shop, { requestId: "x" })).ok).toBe(false);
    expect(shop.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// El MOM dice lo mismo que el código
// ---------------------------------------------------------------------------

describe("MOM §38.15", () => {
  it("documenta el permiso, la papelera, los topes, las reglas y el hecho", () => {
    const mom = readFileSync("docs/mom/master-pedidos-v1.md", "utf8");
    const start = mom.indexOf("### 38.15 ");
    const end = mom.indexOf("\n## 39.", start);
    expect(start).toBeGreaterThan(0);
    const s = mom.slice(start, end).replace(/\s+/g, " ");
    expect(s).toContain(`\`${WOO_CANCEL_PERMISSION}\``);
    expect(s).toContain('{"status": "cancelled"}');
    expect(s).toContain("Ni `DELETE` ni `trash`");
    expect(s).toContain("`WOO_SALE_TIMEOUTS.update`");
    expect(s).toContain("`WOO_SALE_TIMEOUTS.cleanup`");
    expect(s).toContain("`source = 'kapta'`");
    expect(s).toContain("`wooCancelBlocks`");
    for (const r of WOO_CANCEL_REASONS) expect(s).toContain(r.label);
  });
});
