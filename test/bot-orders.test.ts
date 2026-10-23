// Los pedidos del bot de Kapso por Kapta (MOM §38.13): `POST
// /api/internal/orders/[storeId]` y `handleBotOrder` (lib/bot-orders.ts), de
// punta a punta con una base y un WooCommerce falsos que aplican las claves
// únicas (`bot_order_requests (store_id, request_id)`) y resuelven las líneas
// por SKU. Lo que se fija:
//   - el secreto: sin él o con otro, 401 sin detalles; se compara su sha256 en
//     tiempo constante; nunca CRON_SECRET;
//   - una tienda en Shopify (o pausada) es 409 sin NINGUNA llamada a
//     WooCommerce ni a Shopify;
//   - el cuerpo, estricto y en castellano;
//   - el pedido: exactamente lo que se manda a WooCommerce (canal `kapso`,
//     `kapso_conversation_id`, el id del intento con su prefijo), la fila de la
//     entrada y los pasos de la entrada para un pedido del bot, sin
//     `order_sales`;
//   - el candado: dos llamadas a la vez con el mismo id → un solo POST; el
//     mismo id con lo mismo → el mismo pedido; con otra cosa → conflicto sin
//     crear; un candado vencido se retoma y adopta el pedido del intento;
//   - precio que no cuadra → el pedido se borra y el código lo dice;
//   - sin la 0277 → 503 claro, sin crear nada;
//   - una línea de registro por llamada, sin teléfono, nombre ni dirección.
// Sin red ni base real.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  process.env.ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");
  return {
    db: null as unknown as import("./woocommerce-fake-db").FakeDb,
    deferred: [] as Promise<void>[],
  };
});

const spies = vi.hoisted(() => ({
  recompute: vi.fn(async (_admin: unknown, ids: readonly string[]) => ({ requested: ids.length, written: ids.length, error: null })),
  linkOrderToLead: vi.fn(async () => {}),
  closeCart: vi.fn(async () => 0),
}));

// El candado y el secreto se comparan con timingSafeEqual: se espía sin cambiarlo.
vi.mock("node:crypto", async (orig) => {
  const real = await orig<typeof import("node:crypto")>();
  return { ...real, default: real, timingSafeEqual: vi.fn(real.timingSafeEqual) };
});
vi.mock("@/lib/db", () => ({
  createAdminSupabase: () => h.db.client(),
  createServerSupabase: async () => {
    throw new Error("no se usa en estas pruebas");
  },
}));
vi.mock("next/server", async (orig) => ({
  ...(await orig<typeof import("next/server")>()),
  after: (work: () => Promise<void>) => {
    h.deferred.push(work());
  },
}));
vi.mock("@/lib/order-master", async (orig) => ({
  ...(await orig<typeof import("@/lib/order-master")>()),
  recomputeOrderMasterSafe: spies.recompute,
}));
vi.mock("@/lib/leads-ingest", async (orig) => ({
  ...(await orig<typeof import("@/lib/leads-ingest")>()),
  linkOrderToLead: spies.linkOrderToLead,
  closeCartLeadsWithOrders: spies.closeCart,
  lastDispositionAtByPhone: vi.fn(async () => new Map()),
}));

import { timingSafeEqual } from "node:crypto";
import { NextRequest } from "next/server";
import { encrypt } from "@/lib/crypto";
import {
  BOT_ORDER_CLAIM_TTL_MS,
  BOT_ORDER_MAX_BODY_BYTES,
  BOT_ORDER_RATE_PER_MINUTE,
  BOT_ORDER_RETAKE_MAX_AGE_MS,
  BOT_ORDER_SAME_BODY_WINDOW_MS,
  botOrderBodyHash,
  botOrderRetryAfter,
  botSecretMatches,
  handleBotOrder,
  hashBotSecret,
  parseBotOrderBody,
  readBodyCapped,
  type BotOrderDeps,
  type BotOrderRequest,
} from "@/lib/bot-orders";
import { POST } from "@/app/api/internal/orders/[storeId]/route";
import { FakeDb, type Row } from "./woocommerce-fake-db";
import { CATALOG, fakeWooShop } from "./woocommerce-fake-shop";

const STORE = "11111111-1111-4111-8111-111111111111";
const CK = "ck_0123456789abcdef0123456789abcdef01234567";
const CS = "cs_0123456789abcdef0123456789abcdef01234567";
const SECRET = "kbot_secreto-de-prueba-0123456789abcdefghijklmnop";
const REQ = "6f1c2d3e-4b5a-4c6d-8e9f-0a1b2c3d4e5f";
const CONV = "conv-7c1e2f";
const T0 = Date.parse("2026-10-28T15:00:00Z");

let t = T0;
let logs: { line: string; level: string }[] = [];
let shop: ReturnType<typeof fakeWooShop>;

function storeRow(over: Row = {}): Row {
  return {
    id: STORE,
    status: "active",
    timezone: "America/Lima",
    platform: "woocommerce",
    platform_switched_at: "2026-10-27T23:00:00Z",
    woo_intake_from: "2026-10-27T15:00:00Z",
    woo_site_url: "https://kenku.pe",
    woo_site_key: "kp",
    woo_consumer_key_enc: encrypt(CK),
    woo_consumer_secret_enc: encrypt(CS),
    woo_webhook_secret_enc: null,
    woo_last_error: null,
    ...over,
  };
}

function setup(opts: { store?: Row; secret?: boolean; extra?: Record<string, Row[]>; shop?: Parameters<typeof fakeWooShop>[0] } = {}) {
  h.db = new FakeDb({
    stores: [opts.store ?? storeRow()],
    bot_order_secrets: opts.secret === false ? [] : [{ store_id: STORE, secret_hash: hashBotSecret(SECRET) }],
    leads: [],
    ...(opts.extra ?? {}),
  });
  shop = fakeWooShop({ products: CATALOG, now: () => new Date(t), ...(opts.shop ?? {}) });
}

function pedido(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    request_id: REQ,
    conversation_id: CONV,
    phone: "988805509",
    customer_name: "Ana Torres",
    address1: "Av. Primavera 123",
    reference: "Frente al parque",
    district: "Santiago de Surco",
    department: "Lima",
    items: [
      { sku: "EGG-1", quantity: 1, unit_price: 89, name: "EggMixer" },
      { sku: "PAPEL-1", quantity: 1, unit_price: 0, name: "Papel Freidora (regalo)" },
    ],
    note: "Llamar antes",
    ...over,
  };
}

function deps(over: Partial<BotOrderDeps> = {}): BotOrderDeps {
  return {
    admin: h.db.client(),
    defer: (work) => {
      h.deferred.push(work());
    },
    log: (line, level) => logs.push({ line, level }),
    now: () => t,
    fetchImpl: shop.fetchImpl,
    ...over,
  };
}

function call(body: unknown = pedido(), auth: string | null = `Bearer ${SECRET}`, over: Partial<BotOrderDeps> = {}, storeId = STORE) {
  return handleBotOrder({ storeId, authorization: auth, rawBody: typeof body === "string" ? body : JSON.stringify(body) }, deps(over));
}

async function flush() {
  await Promise.all(h.deferred.splice(0));
}

const forbiddenFetch = vi.fn(async () => {
  throw new Error("no debía llamar a la red");
});

beforeEach(() => {
  t = T0;
  logs = [];
  h.deferred = [];
  vi.clearAllMocks();
  vi.stubGlobal("fetch", forbiddenFetch);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("el secreto", () => {
  it("sin Authorization, con otro secreto, o con una tienda que no es un uuid: 401 sin detalles y nada más", async () => {
    setup();
    for (const [auth, storeId] of [
      [null, STORE],
      ["Basic abc", STORE],
      [`Bearer ${SECRET}x`, STORE],
      [`Bearer ${SECRET.slice(0, -1)}`, STORE],
      [`Bearer ${SECRET}`, "kenku"],
    ] as const) {
      const res = await call(pedido(), auth, {}, storeId);
      expect(res).toEqual({ status: 401, body: { ok: false, code: "unauthorized", message: "No autorizado.", retryable: false } });
    }
    expect(shop.calls).toHaveLength(0);
    expect(h.db.rows("bot_order_requests")).toHaveLength(0);
    // Sin autenticar no se escribe ni el último uso.
    await flush();
    expect(h.db.opsOn("bot_order_secrets", "update")).toHaveLength(0);
  });

  it("una tienda sin secreto guardado: 401, aunque el que llega sea el de otra", async () => {
    setup({ secret: false });
    const res = await call();
    expect(res.status).toBe(401);
    expect(shop.calls).toHaveLength(0);
  });

  it("CRON_SECRET no abre la puerta", async () => {
    process.env.CRON_SECRET = "cron-secreto-compartido";
    setup();
    const res = await call(pedido(), "Bearer cron-secreto-compartido");
    expect(res.status).toBe(401);
    delete process.env.CRON_SECRET;
  });

  it("se compara el sha256 en tiempo constante (32 bytes contra 32 bytes), también con otra longitud", () => {
    const stored = hashBotSecret(SECRET);
    vi.mocked(timingSafeEqual).mockClear();
    expect(botSecretMatches(SECRET, stored)).toBe(true);
    expect(botSecretMatches("corto", stored)).toBe(false);
    expect(botSecretMatches(`${SECRET}-mucho-mas-largo-que-el-guardado`, stored)).toBe(false);
    expect(vi.mocked(timingSafeEqual)).toHaveBeenCalledTimes(3);
    for (const [a, b] of vi.mocked(timingSafeEqual).mock.calls) {
      expect((a as Buffer).length).toBe(32);
      expect((b as Buffer).length).toBe(32);
    }
    // Nunca el secreto en claro: lo guardado es su sha256 hexadecimal.
    expect(stored).toMatch(/^[0-9a-f]{64}$/);
    expect(botSecretMatches(SECRET, SECRET)).toBe(false);
    expect(botSecretMatches(SECRET, null)).toBe(false);
  });

  it("con el secreto bueno se pasa (y se usa timingSafeEqual)", async () => {
    setup();
    vi.mocked(timingSafeEqual).mockClear();
    const res = await call();
    expect(res.status).toBe(200);
    expect(vi.mocked(timingSafeEqual)).toHaveBeenCalled();
  });
});

describe("la tienda: activa y en WooCommerce, o 409 sin llamar a nadie", () => {
  it("en Shopify: wrong_platform, sin ninguna llamada a WooCommerce ni a Shopify, y sin candado", async () => {
    setup({ store: storeRow({ platform: "shopify" }) });
    const res = await call();
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ ok: false, code: "wrong_platform", retryable: false });
    expect((res.body as { message: string }).message).toContain("Deriva la conversación a una asesora");
    expect(shop.calls).toHaveLength(0);
    expect(forbiddenFetch).not.toHaveBeenCalled();
    expect(h.db.rows("bot_order_requests")).toHaveLength(0);
  });

  it("sin la 0274 (la tienda no tiene `platform`): es de Shopify, wrong_platform", async () => {
    setup();
    h.db.failOn = (table, op) =>
      table === "stores" && op === "select" ? { code: "42703", message: "column stores.platform does not exist" } : null;
    const res = await call();
    expect(res.body).toMatchObject({ code: "wrong_platform" });
    expect(shop.calls).toHaveLength(0);
  });

  it("en WooCommerce pero pausada: store_inactive, sin llamar a WooCommerce", async () => {
    setup({ store: storeRow({ status: "paused" }) });
    const res = await call();
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: "store_inactive" });
    expect(shop.calls).toHaveLength(0);
  });

  it("un cuerpo bueno contra una tienda todavía en Shopify dice wrong_platform (sirve para probar la acción antes del corte)", async () => {
    setup({ store: storeRow({ platform: "shopify" }) });
    expect((await call(pedido({ phone: "12" }))).body).toMatchObject({ code: "invalid_body" });
    expect((await call()).body).toMatchObject({ code: "wrong_platform" });
  });
});

describe("el cuerpo, estricto", () => {
  it("no es JSON, o no es un objeto: 400", async () => {
    setup();
    expect((await call("{no es json")).body).toMatchObject({ code: "invalid_body", message: "El cuerpo no es JSON." });
    expect((await call("[1,2]")).body).toMatchObject({ code: "invalid_body", errors: ["El cuerpo tiene que ser un objeto JSON."] });
    expect(shop.calls).toHaveLength(0);
  });

  it("cada problema con su mensaje en castellano, y un campo desconocido no se ignora", async () => {
    setup();
    const res = await call(
      pedido({
        referencia: "en castellano",
        request_id: "corto",
        phone: "98880550",
        customer_name: "",
        department: "Narnia",
        items: [{ sku: "", quantity: 0, unit_price: -1 }, { sku: "EGG-1", quantity: 1, unit_price: 89.999 }, { sku: "EGG-1", quantity: 1.5, unit_price: "89" }],
        discount: { kind: "percent", value: 120 },
      }),
    );
    expect(res.status).toBe(400);
    const errors = (res.body as { errors: string[] }).errors;
    expect(errors).toEqual(
      expect.arrayContaining([
        "referencia: campo desconocido.",
        expect.stringMatching(/^request_id: obligatorio/),
        "phone: Faltan 1 dígito: son 9 en total.",
        expect.stringMatching(/^customer_name: obligatorio/),
        expect.stringMatching(/^department: obligatorio; un departamento del Perú/),
        expect.stringMatching(/^items\[0\]\.sku: obligatorio/),
        expect.stringMatching(/^items\[0\]\.quantity: un entero de 1 a 99/),
        expect.stringMatching(/^items\[0\]\.unit_price: obligatorio/),
        expect.stringMatching(/^items\[1\]\.unit_price/),
        expect.stringMatching(/^items\[2\]\.quantity/),
        expect.stringMatching(/^items\[2\]\.unit_price/),
        expect.stringMatching(/^discount:/),
      ]),
    );
    expect(shop.calls).toHaveLength(0);
    expect(h.db.rows("bot_order_requests")).toHaveLength(0);
  });

  it("un regalo a S/ 0 sí; un pedido solo de regalos (total 0) no", async () => {
    setup();
    const solo = await call(pedido({ items: [{ sku: "PAPEL-1", quantity: 1, unit_price: 0 }] }));
    expect(solo.body).toMatchObject({ code: "invalid_body" });
    expect((solo.body as { message: string }).message).toContain("un pedido solo de regalos no se crea");
    expect(shop.calls).toHaveLength(0);
  });

  it("normaliza: el celular con 51 o espacios, y el departamento como lo dice el bot", () => {
    const a = parseBotOrderBody(pedido({ phone: "+51 988 805 509", department: "Callao" }));
    expect(a.ok && a.input.phone).toBe("51988805509");
    expect(a.ok && a.input.state).toBe("CAL");
    const b = parseBotOrderBody(pedido({ department: "Lima (departamento)" }));
    expect(b.ok && b.input.state).toBe("LIM");
    const c = parseBotOrderBody(pedido({ department: "Arequipa", discount: { kind: "fixed", value: 10 } }));
    expect(c.ok && c.input.state).toBe("ARE");
    expect(c.ok && c.input.discount).toEqual({ kind: "fixed", value: 10 });
  });
});

describe("el pedido", () => {
  it("crea en WooCommerce lo que pidió el bot, con sus marcas, y contesta el número", async () => {
    setup();
    const res = await call();
    expect(res).toEqual({
      status: 200,
      body: { ok: true, order: { name: "#KP200501", id: "wc-kp-501", total: 89, currency: "PEN" } },
    });
    // Lookup del intento anterior → POST pending → ¿algún producto con
    // variaciones sin variación? (el bot manda solo SKU: se comprueba siempre,
    // `wooLinesToVerify`) → PUT processing. Nada más.
    expect(shop.calls.map((c) => `${c.method} ${c.path}`)).toEqual(["GET /orders", "POST /orders", "GET /products", "PUT /orders/501"]);
    expect(shop.calls[0]!.query.get("after")).toBe("2026-10-28T13:00:00");
    expect(Object.fromEntries(shop.calls[2]!.query)).toMatchObject({ include: "10,11", _fields: "id,type" });
    expect(shop.calls[1]!.body).toEqual({
      status: "pending",
      set_paid: false,
      created_via: "kapta",
      payment_method: "cod",
      payment_method_title: "Cash on delivery",
      billing: {
        first_name: "Ana",
        last_name: "Torres",
        address_1: "Av. Primavera 123",
        address_2: "Frente al parque",
        city: "Santiago de Surco",
        state: "LMA",
        country: "PE",
        phone: "+51988805509",
      },
      shipping: {
        first_name: "Ana",
        last_name: "Torres",
        address_1: "Av. Primavera 123",
        address_2: "Frente al parque",
        city: "Santiago de Surco",
        state: "LMA",
        country: "PE",
        phone: "+51988805509",
      },
      line_items: [
        { sku: "EGG-1", quantity: 1, subtotal: "89.00", total: "89.00" },
        { sku: "PAPEL-1", quantity: 1, subtotal: "0.00", total: "0.00" },
      ],
      shipping_lines: [{ method_id: "free_shipping", method_title: "Envío gratis", total: "0.00" }],
      customer_note: "Llamar antes",
      meta_data: [
        { key: "kapta_channel", value: "kapso" },
        { key: "kapso_conversation_id", value: CONV },
        // Sin decir, contraentrega: como hoy en Shopify (`shipping_mode`).
        { key: "shipping_mode", value: "cod" },
        { key: "kapta_request_id", value: `kapso-${REQ}` },
        { key: "kapta_request_hash", value: expect.stringMatching(/^[0-9a-f]{64}$/) },
      ],
    });
    expect(shop.calls[3]!.body).toEqual({ status: "processing" });
    expect(forbiddenFetch).not.toHaveBeenCalled();

    // La fila de la entrada: wc-kp-501, del bot (kapso + whatsapp, con su conversación).
    const order = h.db.rows("orders")[0]!;
    expect(h.db.rows("orders")).toHaveLength(1);
    expect(order).toMatchObject({
      store_id: STORE,
      shopify_order_id: "wc-kp-501",
      name: "#KP200501",
      platform: "woocommerce",
      tags: ["kapso", "whatsapp"],
      kapso_conversation_id: CONV,
      customer_phone: "51988805509",
      financial_status: "pending",
      payment_gateway: "cod",
      total_amount: 89,
    });
    // Sin asesora: ninguna venta registrada.
    expect(h.db.rows("order_sales")).toHaveLength(0);
    expect(h.db.rows("lead_calls")).toHaveLength(0);
    // El candado, cerrado con el pedido.
    expect(h.db.rows("bot_order_requests")).toEqual([
      expect.objectContaining({
        store_id: STORE,
        request_id: REQ,
        status: "done",
        attempts: 1,
        order_id: "wc-kp-501",
        order_name: "#KP200501",
        order_total: 89,
        currency: "PEN",
      }),
    ]);
  });

  it("después de responder: los pasos de la entrada para un pedido del bot (rollups, lead ganado, Master), y el último uso", async () => {
    setup();
    await call();
    // Nada de eso antes de responder.
    expect(spies.linkOrderToLead).not.toHaveBeenCalled();
    await flush();
    const order = h.db.rows("orders")[0]!;
    expect(h.db.rpcCalls).toEqual([
      { name: "recompute_daily_rollups", args: { p_store_id: STORE, p_from: "2026-10-28", p_to: "2026-10-28" } },
    ]);
    expect(spies.linkOrderToLead).toHaveBeenCalledWith(expect.anything(), {
      storeId: STORE,
      phone: "51988805509",
      orderId: order.id,
      win: true,
      orderCreatedAt: "2026-10-28T15:00:00Z",
    });
    // Un pedido del bot gana el lead; no pasa por la regla del carrito de otra vía.
    expect(spies.closeCart).not.toHaveBeenCalled();
    expect(spies.recompute).toHaveBeenCalledWith(expect.anything(), [order.id]);
    expect(h.db.rows("bot_order_secrets")[0]).toMatchObject({ last_used_at: "2026-10-28T15:00:00.000Z", last_outcome: "ok" });
  });

  it("el lead de la conversación sin celular (nombre de usuario de WhatsApp) recibe el del pedido; uno con celular no se pisa", async () => {
    setup({
      extra: {
        leads: [
          { id: "lead-1", store_id: STORE, phone: null, kapso_conversation_id: CONV },
          { id: "lead-2", store_id: STORE, phone: "51911111111", kapso_conversation_id: "conv-otra" },
        ],
      },
    });
    await call();
    await flush();
    expect(h.db.rows("leads").find((l) => l.id === "lead-1")!.phone).toBe("51988805509");
    await call(pedido({ request_id: "kapso-req-0002", conversation_id: "conv-otra" }));
    await flush();
    expect(h.db.rows("leads").find((l) => l.id === "lead-2")!.phone).toBe("51911111111");
  });

  it("el bot cierra un carrito: el canal sigue siendo `kapso` y el lead deja de verse con el carrito abierto", async () => {
    setup({
      extra: { leads: [{ id: "lead-c", store_id: STORE, phone: "51988805509", draft_order_gid: "gid://shopify/DraftOrder/42", draft_order_status: "open" }] },
    });
    const res = await call(pedido({ cart_draft_gid: "gid://shopify/DraftOrder/42" }));
    expect(res.status).toBe(200);
    expect(shop.calls[1]!.body.meta_data[0]).toEqual({ key: "kapta_channel", value: "kapso" });
    await flush();
    expect(h.db.rows("leads")[0]!.draft_order_status).toBe("completed");
  });

  it("si la fila local no se puede guardar, el pedido igual existe: el bot lo confirma (la entrada lo trae después)", async () => {
    setup();
    h.db.failOn = (table, op) => (table === "orders" && op === "upsert" ? { message: "falló la base" } : null);
    const res = await call();
    expect(res.body).toMatchObject({ ok: true, order: { name: "#KP200501", id: "wc-kp-501" } });
    await flush();
    expect(spies.linkOrderToLead).not.toHaveBeenCalled();
    expect(JSON.parse(logs[0]!.line.replace("[bot-orders] ", ""))).toMatchObject({ outcome: "ok", local: "insert_failed" });
  });
});

describe("el candado: un request_id es un pedido", () => {
  it("dos llamadas A LA VEZ con el mismo request_id: un solo POST a WooCommerce", async () => {
    setup();
    const [a, b] = await Promise.all([call(), call()]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 409]);
    const busy = [a, b].find((r) => r.status === 409)!;
    // El candado acaba de tomarse: le faltan 120 s, se sugiere el máximo (15 s), no los 120.
    expect(busy.body).toMatchObject({ ok: false, code: "duplicate_in_progress", retryable: true, retry_after_seconds: 15 });
    expect(shop.calls.filter((c) => c.method === "POST")).toHaveLength(1);
    expect(shop.orders.size).toBe(1);
    expect(h.db.rows("bot_order_requests")).toHaveLength(1);
    // Y el reintento de la que esperó recibe el mismo pedido.
    const again = await call();
    expect(again).toEqual({
      status: 200,
      body: { ok: true, order: { name: "#KP200501", id: "wc-kp-501", total: 89, currency: "PEN" }, replay: true },
    });
    expect(shop.calls.filter((c) => c.method === "POST")).toHaveLength(1);
  });

  it("el mismo request_id con lo mismo (otro orden de campos, otros espacios): el mismo pedido, sin llamar a WooCommerce", async () => {
    setup();
    await call();
    const calls = shop.calls.length;
    const { items, ...rest } = pedido();
    const replay = await call({ items, ...rest, customer_name: "  Ana   Torres ", phone: "+51 988-805-509" });
    expect(replay.body).toEqual({ ok: true, order: { name: "#KP200501", id: "wc-kp-501", total: 89, currency: "PEN" }, replay: true });
    expect(shop.calls.length).toBe(calls);
    expect(h.db.rows("orders")).toHaveLength(1);
  });

  it("el mismo request_id con otra cosa: conflict, sin crear otro pedido ni llamar a WooCommerce", async () => {
    setup();
    await call();
    const calls = shop.calls.length;
    const res = await call(pedido({ items: [{ sku: "EGG-1", quantity: 3, unit_price: 89 }] }));
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ ok: false, code: "conflict", retryable: false, order: { name: "#KP200501", id: "wc-kp-501" } });
    expect(shop.calls.length).toBe(calls);
    expect(shop.orders.size).toBe(1);
  });

  it("un candado vigente de otra llamada: duplicate_in_progress; vencido, se retoma y se ADOPTA el pedido de ese intento (no se crea otro)", async () => {
    setup();
    await call();
    // La función que lo creó murió antes de cerrar el candado.
    const row = h.db.rows("bot_order_requests")[0]!;
    Object.assign(row, { status: "processing", order_id: null, order_name: null, claimed_at: new Date(t).toISOString() });
    t += 30_000;
    expect((await call()).body).toMatchObject({ code: "duplicate_in_progress" });
    t += BOT_ORDER_CLAIM_TTL_MS;
    const res = await call();
    expect(res.body).toEqual({ ok: true, order: { name: "#KP200501", id: "wc-kp-501", total: 89, currency: "PEN" } });
    expect(shop.calls.filter((c) => c.method === "POST")).toHaveLength(1);
    expect(h.db.rows("bot_order_requests")[0]).toMatchObject({ status: "done", attempts: 2, order_id: "wc-kp-501" });
    expect(JSON.parse(logs.at(-1)!.line.replace("[bot-orders] ", "")).events).toContain("woo.sale.adopted");
  });

  it("si WooCommerce no contesta: 503 reintentable, sin POST; el reintento con el mismo id vuelve a intentar", async () => {
    setup({ shop: { failOnce: { "GET /orders": "network" } } });
    const res = await call();
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ code: "woocommerce_unavailable", retryable: true });
    expect(shop.calls.filter((c) => c.method === "POST")).toHaveLength(0);
    expect(h.db.rows("bot_order_requests")[0]).toMatchObject({ status: "failed", error_code: "woocommerce_unavailable" });
    const again = await call();
    expect(again.status).toBe(200);
    expect(h.db.rows("bot_order_requests")[0]).toMatchObject({ status: "done", attempts: 2 });
  });

  it("tope por minuto: más de los permitidos frena (429); un reintento de uno ya pedido no cuenta", async () => {
    setup();
    await call();
    for (let i = 0; i < BOT_ORDER_RATE_PER_MINUTE; i++) {
      h.db.rows("bot_order_requests").push({
        id: `r-${i}`,
        store_id: STORE,
        request_id: `kapso-burst-${String(i).padStart(4, "0")}`,
        body_hash: "0".repeat(64),
        status: "done",
        claim_token: `tok-${i}`,
        claimed_at: new Date(t).toISOString(),
        created_at: new Date(t).toISOString(),
      });
    }
    const calls = shop.calls.length;
    // Otro pedido (otra nota): con lo mismo sería el mismo pedido pedido dos veces.
    const res = await call(pedido({ request_id: "kapso-nuevo-0001", note: "Otro pedido" }));
    expect(res.status).toBe(429);
    expect(res.body).toMatchObject({ code: "rate_limited", retryable: true });
    expect(shop.calls.length).toBe(calls);
    expect((await call()).body).toMatchObject({ ok: true, replay: true });
  });
});

describe("lo que WooCommerce guarda distinto: se borra y el código lo dice", () => {
  it("otro precio: price_mismatch, el pedido pendiente se borra, sin fila local", async () => {
    setup({ shop: { products: CATALOG, repriceSku: { "EGG-1": "99.00" } } });
    const res = await call();
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ ok: false, code: "price_mismatch", retryable: false });
    expect((res.body as { message: string }).message).toContain("WooCommerce no respetó el precio pactado en «EggMixer»");
    expect((res.body as { message: string }).message).toContain("(pendiente de pago) se eliminó");
    expect(shop.calls.map((c) => `${c.method} ${c.path}`)).toEqual(["GET /orders", "POST /orders", "GET /products", "DELETE /orders/501"]);
    expect(shop.orders.size).toBe(0);
    expect(h.db.rows("orders")).toHaveLength(0);
    expect(h.db.rows("bot_order_requests")[0]).toMatchObject({ status: "failed", error_code: "price_mismatch" });
  });

  it("un SKU que no existe: sku_not_found, el pedido pendiente se borra", async () => {
    setup();
    const res = await call(pedido({ items: [{ sku: "NO-EXISTE", quantity: 1, unit_price: 50, name: "Algo" }] }));
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ code: "sku_not_found" });
    expect((res.body as { message: string }).message).toContain("«Algo» (SKU NO-EXISTE): no existe en WooCommerce");
    expect(shop.calls.map((c) => `${c.method} ${c.path}`)).toEqual(["GET /orders", "POST /orders", "DELETE /orders/501"]);
    expect(h.db.rows("orders")).toHaveLength(0);
  });

  it("el SKU del producto con variaciones (no el de una talla): sku_not_found, borrado", async () => {
    setup();
    const res = await call(pedido({ items: [{ sku: "POLO", quantity: 1, unit_price: 59.9, name: "Polo" }] }));
    expect(res.body).toMatchObject({ code: "sku_not_found" });
    expect((res.body as { message: string }).message).toContain("ese SKU es el del producto con variaciones");
    expect(shop.calls.at(-1)).toMatchObject({ method: "DELETE", path: "/orders/501" });
    // Con el SKU de la talla, sí.
    const ok = await call(pedido({ request_id: "kapso-talla-0001", items: [{ sku: "POLO-M", quantity: 1, unit_price: 59.9 }] }));
    expect(ok.body).toMatchObject({ ok: true, order: { total: 59.9 } });
  });
});

describe("sin la 0277", () => {
  it("sin bot_order_secrets: 503 con el motivo, sin crear nada", async () => {
    setup();
    h.db.failOn = (table) =>
      table === "bot_order_secrets" ? { code: "PGRST205", message: "Could not find the table 'public.bot_order_secrets' in the schema cache" } : null;
    const res = await call();
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ ok: false, code: "migration_missing", message: "Falta aplicar la migración 0277 (pedidos del bot) en la base: no se creó nada." });
    expect(shop.calls).toHaveLength(0);
  });

  it("con el secreto pero sin bot_order_requests: 503, sin llamar a WooCommerce", async () => {
    setup();
    h.db.failOn = (table) =>
      table === "bot_order_requests" ? { code: "42P01", message: 'relation "bot_order_requests" does not exist' } : null;
    const res = await call();
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ code: "migration_missing" });
    expect(shop.calls).toHaveLength(0);
  });

  it("otra tabla que falta no se toma por la 0277", async () => {
    setup();
    h.db.failOn = (table) => (table === "bot_order_secrets" ? { code: "42P01", message: 'relation "stores" does not exist' } : null);
    expect((await call()).body).toMatchObject({ code: "store_unavailable" });
  });
});

describe("el registro: una línea por llamada, sin datos de la clienta", () => {
  it("tienda, el comienzo del sha256 del id, el resultado, el código y los ms; nunca teléfono, nombre, dirección ni el id entero", async () => {
    setup();
    await call();
    await call(pedido({ phone: "12" }));
    await call(pedido(), "Bearer otro");
    await flush();
    expect(logs).toHaveLength(3);
    for (const { line } of logs) {
      expect(line.startsWith("[bot-orders] {")).toBe(true);
      for (const pii of ["988805509", "Ana", "Torres", "Primavera", "Surco", "parque", REQ, SECRET, CK, CS]) {
        expect(line).not.toContain(pii);
      }
    }
    const ok = JSON.parse(logs[0]!.line.replace("[bot-orders] ", ""));
    expect(ok).toMatchObject({ store: STORE, req: expect.stringMatching(/^[0-9a-f]{12}$/), outcome: "ok", status: 200, ms: 0, woo: 501, attempt: 1 });
    expect(logs[0]!.level).toBe("info");
    expect(JSON.parse(logs[1]!.line.replace("[bot-orders] ", ""))).toMatchObject({ outcome: "invalid_body", status: 400 });
    expect(logs[1]!.level).toBe("warn");
    expect(JSON.parse(logs[2]!.line.replace("[bot-orders] ", ""))).toMatchObject({ outcome: "unauthorized", status: 401, req: null });
  });

  it("el último fallo queda para Ajustes, sin datos de la clienta", async () => {
    setup({ shop: { products: CATALOG, repriceSku: { "EGG-1": "99.00" } } });
    await call();
    await flush();
    const s = h.db.rows("bot_order_secrets")[0]!;
    expect(s.last_outcome).toBe("price_mismatch");
    expect(s.last_error).toMatch(/^price_mismatch: Pedido NO generado: WooCommerce no respetó el precio/);
    expect(s.last_error.length).toBeLessThanOrEqual(300);
    for (const pii of ["988805509", "Ana", "Primavera"]) expect(s.last_error).not.toContain(pii);
  });
});

describe("scrubForLog", () => {
  it("tapa un celular peruano suelto (con o sin 51), y deja los SKU y los números de pedido", async () => {
    const { scrubForLog } = await import("@/lib/bot-orders");
    expect(scrubForLog("billing phone 51988805509 inválido; +51 no; 988805509.", 300)).toBe("billing phone … inválido; +51 no; ….");
    expect(scrubForLog("SKU 7751234567890 y #KP200501", 300)).toBe("SKU 7751234567890 y #KP200501");
    expect(scrubForLog("x".repeat(400), 300)).toHaveLength(300);
  });
});

describe("la ruta", () => {
  it("POST con Bearer: el JSON y el código de handleBotOrder, sin caché; lo de después corre con after()", async () => {
    setup();
    vi.stubGlobal("fetch", shop.fetchImpl);
    const req = new NextRequest(`https://kapta.app/api/internal/orders/${STORE}`, {
      method: "POST",
      headers: { authorization: `Bearer ${SECRET}`, "content-type": "application/json" },
      body: JSON.stringify(pedido()),
    });
    const res = await POST(req, { params: Promise.resolve({ storeId: STORE }) });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ ok: true, order: { name: "#KP200501", id: "wc-kp-501", total: 89, currency: "PEN" } });
    expect(h.deferred.length).toBeGreaterThan(0);
    await flush();
    expect(spies.linkOrderToLead).toHaveBeenCalled();
  });

  it("401 con WWW-Authenticate; 409 en curso con Retry-After", async () => {
    setup();
    const unauth = await POST(
      new NextRequest(`https://kapta.app/api/internal/orders/${STORE}`, { method: "POST", body: "{}" }),
      { params: Promise.resolve({ storeId: STORE }) },
    );
    expect(unauth.status).toBe(401);
    expect(unauth.headers.get("www-authenticate")).toContain("Bearer");
    h.db.rows("bot_order_requests").push({
      id: "r-busy",
      store_id: STORE,
      request_id: REQ,
      body_hash: "",
      status: "processing",
      claim_token: "tok",
      claimed_at: new Date().toISOString(),
    });
    // Misma huella que el pedido: se calcula con el parser.
    const parsed = parseBotOrderBody(pedido());
    const { botOrderBodyHash } = await import("@/lib/bot-orders");
    h.db.rows("bot_order_requests")[0]!.body_hash = parsed.ok ? botOrderBodyHash(parsed.input) : "";
    const busy = await POST(
      new NextRequest(`https://kapta.app/api/internal/orders/${STORE}`, {
        method: "POST",
        headers: { authorization: `Bearer ${SECRET}` },
        body: JSON.stringify(pedido()),
      }),
      { params: Promise.resolve({ storeId: STORE }) },
    );
    expect(busy.status).toBe(409);
    expect(busy.headers.get("retry-after")).toBe("15");
  });
});

// ---------------------------------------------------------------------------
// Lo que pidió la revisión del 23-10-2026 (seguridad, dinero, integración)
// ---------------------------------------------------------------------------

function lastLog(): Record<string, unknown> {
  return JSON.parse(logs.at(-1)!.line.replace("[bot-orders] ", ""));
}

function streamOf(chunks: number, size: number): { stream: ReadableStream<Uint8Array>; pulled: () => number } {
  let n = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (n >= chunks) return controller.close();
      n += 1;
      controller.enqueue(new Uint8Array(size).fill(0x61));
    },
  });
  return { stream, pulled: () => n };
}

describe("el tamaño del cuerpo: nunca se lee entero uno de más, y nunca antes del secreto", () => {
  it("Content-Length de más: 413 sin leer el cuerpo ni tocar la base", async () => {
    setup();
    const readBody = vi.fn(async () => "{}");
    const req: BotOrderRequest = { storeId: STORE, authorization: null, contentLength: String(5 * 1024 * 1024), readBody };
    const res = await handleBotOrder(req, deps());
    expect(res.status).toBe(413);
    expect(res.body).toMatchObject({ ok: false, code: "body_too_large", retryable: false });
    expect(readBody).not.toHaveBeenCalled();
    expect(h.db.ops).toHaveLength(0);
    expect(shop.calls).toHaveLength(0);
  });

  it("sin el secreto, el cuerpo ni se lee", async () => {
    setup();
    const readBody = vi.fn(async () => JSON.stringify(pedido()));
    const res = await handleBotOrder({ storeId: STORE, authorization: "Bearer otro", readBody }, deps());
    expect(res.status).toBe(401);
    expect(readBody).not.toHaveBeenCalled();
  });

  it("sin Content-Length (chunked): con el secreto se lee con tope y se corta al pasarlo", async () => {
    setup();
    const { stream, pulled } = streamOf(1000, 4096);
    const res = await handleBotOrder(
      { storeId: STORE, authorization: `Bearer ${SECRET}`, readBody: (max) => readBodyCapped(stream, max) },
      deps(),
    );
    expect(res.status).toBe(413);
    expect(res.body).toMatchObject({ code: "body_too_large" });
    // Se dejó de leer apenas pasó los 16 KB: unos 5 trozos de 4 KB, no 1000.
    expect(pulled()).toBeLessThan(10);
    expect(shop.calls).toHaveLength(0);
  });

  it("readBodyCapped: el texto hasta el tope, null si lo pasa, vacío sin cuerpo", async () => {
    expect(await readBodyCapped(new Response("hola").body, 4)).toBe("hola");
    expect(await readBodyCapped(new Response("hola!").body, 4)).toBeNull();
    expect(await readBodyCapped(null, 4)).toBe("");
    expect(await readBodyCapped(new Response("ñandú").body, BOT_ORDER_MAX_BODY_BYTES)).toBe("ñandú");
  });

  it("la ruta: un Content-Length de más es 413 aunque no traiga secreto", async () => {
    setup();
    const res = await POST(
      new NextRequest(`https://kapta.app/api/internal/orders/${STORE}`, {
        method: "POST",
        headers: { "content-length": "999999", "content-type": "application/json" },
        body: "{}",
      }),
      { params: Promise.resolve({ storeId: STORE }) },
    );
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ code: "body_too_large" });
    expect(h.db.ops).toHaveLength(0);
  });
});

describe("el carrito: solo el de esta clienta", () => {
  it("un gid que también tiene otro lead (otro celular, otra conversación) no le cierra el carrito a ese", async () => {
    const GID = "gid://shopify/DraftOrder/42";
    setup({
      extra: {
        leads: [
          { id: "lead-mia", store_id: STORE, phone: "51988805509", draft_order_gid: GID, draft_order_status: "open" },
          { id: "lead-otra", store_id: STORE, phone: "51911111111", kapso_conversation_id: "conv-otra", draft_order_gid: GID, draft_order_status: "open" },
        ],
      },
    });
    expect((await call(pedido({ cart_draft_gid: GID }))).status).toBe(200);
    await flush();
    expect(h.db.rows("leads").find((l) => l.id === "lead-mia")!.draft_order_status).toBe("completed");
    expect(h.db.rows("leads").find((l) => l.id === "lead-otra")!.draft_order_status).toBe("open");
  });

  it("por la conversación también (el lead sin celular)", async () => {
    const GID = "gid://shopify/DraftOrder/43";
    setup({ extra: { leads: [{ id: "lead-c", store_id: STORE, phone: null, kapso_conversation_id: CONV, draft_order_gid: GID, draft_order_status: "open" }] } });
    await call(pedido({ cart_draft_gid: GID }));
    await flush();
    expect(h.db.rows("leads")[0]!.draft_order_status).toBe("completed");
  });

  it("un gid que no es de esta clienta no cierra nada: queda en el registro", async () => {
    const GID = "gid://shopify/DraftOrder/44";
    setup({ extra: { leads: [{ id: "lead-otra", store_id: STORE, phone: "51911111111", draft_order_gid: GID, draft_order_status: "open" }] } });
    expect((await call(pedido({ cart_draft_gid: GID }))).status).toBe(200);
    await flush();
    expect(h.db.rows("leads")[0]!.draft_order_status).toBe("open");
    expect(logs.some((l) => l.line.includes('"step":"cart"'))).toBe(true);
  });
});

describe("el candado se cierra apenas el pedido está vivo, y todo tiene tope", () => {
  it("la fila local no contesta: el candado ya quedó `done`, el bot recibe su pedido y un reintento el mismo", async () => {
    setup();
    h.db.hangOn = (table, op) => table === "orders" && op === "upsert";
    const res = await call(pedido(), `Bearer ${SECRET}`, { dbTimeoutMs: 20 });
    expect(res).toEqual({ status: 200, body: { ok: true, order: { name: "#KP200501", id: "wc-kp-501", total: 89, currency: "PEN" } } });
    expect(h.db.rows("bot_order_requests")[0]).toMatchObject({ status: "done", woo_order_id: 501, order_id: "wc-kp-501" });
    // El candado antes que la fila local.
    const doneAt = h.db.ops.findIndex((o) => o.table === "bot_order_requests" && o.op === "update" && o.payload?.status === "done");
    const localAt = h.db.ops.findIndex((o) => o.table === "orders" && o.op === "upsert");
    expect(doneAt).toBeGreaterThan(-1);
    expect(doneAt).toBeLessThan(localAt);
    expect(lastLog()).toMatchObject({ outcome: "ok", local: "insert_timeout" });
    h.db.hangOn = null;
    expect((await call()).body).toMatchObject({ ok: true, replay: true, order: { name: "#KP200501" } });
    expect(shop.calls.filter((c) => c.method === "POST")).toHaveLength(1);
  });

  it("la base no contesta antes del candado: 503 reintentable al momento, sin llamar a WooCommerce", async () => {
    setup();
    h.db.hangOn = (table) => table === "bot_order_secrets";
    const res = await call(pedido(), `Bearer ${SECRET}`, { dbTimeoutMs: 20 });
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ code: "store_unavailable", retryable: true });
    expect(shop.calls).toHaveLength(0);
  });

  it("lo que tardó la base se le descuenta a la venta: sin tiempo para un POST entero, no se crea nada", async () => {
    setup();
    let clk = 1_000_000;
    // La lectura de la tienda tardó 30 s: a la venta le quedan 12 de los 42.
    h.db.failOn = (table, op) => {
      if (table === "stores" && op === "select") clk += 30_000;
      return null;
    };
    const res = await call(pedido(), `Bearer ${SECRET}`, { clock: () => clk });
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ code: "woocommerce_unavailable", retryable: true });
    expect((res.body as { message: string }).message).toContain("no se alcanzó a crear el pedido");
    expect(shop.calls.filter((c) => c.method === "POST")).toHaveLength(0);
    expect(h.db.rows("bot_order_requests")[0]).toMatchObject({ status: "failed" });
  });

  it("el id de WooCommerce queda en el candado apenas existe el pedido, también si después no cuadra", async () => {
    setup({ shop: { products: CATALOG, repriceSku: { "EGG-1": "99.00" } } });
    await call();
    expect(h.db.rows("bot_order_requests")[0]).toMatchObject({ status: "failed", woo_order_id: 501 });
  });
});

describe("duplicate_in_progress: cuánto esperar, según lo que le falta al candado", () => {
  it("entre 5 y 15 s", () => {
    const t0 = 1_000_000;
    expect(botOrderRetryAfter(t0, t0)).toBe(15);
    expect(botOrderRetryAfter(t0, t0 + 110_000)).toBe(10);
    expect(botOrderRetryAfter(t0, t0 + 118_000)).toBe(5);
    expect(botOrderRetryAfter(Number.NaN, t0)).toBe(15);
  });

  it("un candado de hace 110 s: retry_after_seconds 10", async () => {
    setup();
    const parsed = parseBotOrderBody(pedido());
    h.db.rows("bot_order_requests").push({
      id: "r-1",
      store_id: STORE,
      request_id: REQ,
      body_hash: parsed.ok ? botOrderBodyHash(parsed.input) : "",
      status: "processing",
      claim_token: "tok",
      attempts: 1,
      claimed_at: new Date(t - 110_000).toISOString(),
      created_at: new Date(t - 110_000).toISOString(),
    });
    expect((await call()).body).toMatchObject({ code: "duplicate_in_progress", retry_after_seconds: 10 });
    expect(shop.calls).toHaveLength(0);
  });
});

describe("retomar: el pedido de ese intento por su id, y nunca a ciegas", () => {
  function guardRow(over: Row): Row {
    const parsed = parseBotOrderBody(pedido());
    return {
      id: "r-old",
      store_id: STORE,
      request_id: REQ,
      body_hash: parsed.ok ? botOrderBodyHash(parsed.input) : "",
      status: "failed",
      claim_token: "tok-old",
      attempts: 1,
      woo_order_id: null,
      claimed_at: new Date(t).toISOString(),
      created_at: new Date(t).toISOString(),
      ...over,
    };
  }

  it("sin saber qué pedido creó y con más de 90 min: expired, sin llamar a WooCommerce", async () => {
    setup();
    const old = new Date(t - BOT_ORDER_RETAKE_MAX_AGE_MS - 60_000).toISOString();
    h.db.rows("bot_order_requests").push(guardRow({ claimed_at: old, created_at: old }));
    const res = await call();
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ ok: false, code: "expired", retryable: false });
    expect(shop.calls).toHaveLength(0);
    expect(h.db.rows("bot_order_requests")[0]).toMatchObject({ status: "failed", claim_token: "tok-old" });
  });

  it("con su pedido anotado, a cualquier edad: lo lee por su id (no por la búsqueda de 2 horas) y lo adopta", async () => {
    setup();
    await call();
    // El candado no llegó a cerrarse (se cortó la función después del PUT).
    Object.assign(h.db.rows("bot_order_requests")[0]!, { status: "failed", order_id: null, order_name: null });
    t += 3 * 60 * 60_000;
    const before = shop.calls.length;
    const res = await call();
    expect(res.body).toEqual({ ok: true, order: { name: "#KP200501", id: "wc-kp-501", total: 89, currency: "PEN" } });
    const after = shop.calls.slice(before).map((c) => `${c.method} ${c.path}`);
    expect(after[0]).toBe("GET /orders/501");
    expect(after).not.toContain("GET /orders");
    expect(after).not.toContain("POST /orders");
    expect(shop.orders.size).toBe(1);
    expect(lastLog().events).toContain("woo.sale.adopted");
  });

  it("su pedido anotado está anulado: también se busca, y se adopta el vivo de otro intento en vez de crear otro", async () => {
    setup();
    await call();
    Object.assign(h.db.rows("bot_order_requests")[0]!, { status: "failed", order_id: null, order_name: null });
    const o501 = shop.orders.get(501)!;
    shop.orders.set(502, { ...structuredClone(o501), id: 502, number: "KP200502", status: "processing" });
    o501.status = "cancelled";
    const res = await call();
    expect(res.body).toMatchObject({ ok: true, order: { name: "#KP200502", id: "wc-kp-502" } });
    expect(shop.calls.filter((c) => c.method === "POST")).toHaveLength(1);
    expect(h.db.rows("bot_order_requests")[0]).toMatchObject({ status: "done", woo_order_id: 502 });
  });

  it("su pedido anotado ya no existe (se borró): se busca como siempre y se crea uno", async () => {
    setup({ shop: { products: CATALOG, repriceSku: { "EGG-1": "99.00" } } });
    await call();
    expect(shop.orders.size).toBe(0);
    // El precio se arregló en WooCommerce; el bot reintenta con lo mismo.
    shop = fakeWooShop({ products: CATALOG, now: () => new Date(t), firstId: 502 });
    const res = await call();
    expect(res.body).toMatchObject({ ok: true, order: { name: "#KP200502" } });
    expect(shop.calls.map((c) => `${c.method} ${c.path}`).slice(0, 3)).toEqual(["GET /orders/501", "GET /orders", "POST /orders"]);
  });
});

describe("un POST sin respuesta no suelta el candado: WordPress puede guardarlo después", () => {
  it("el reintento espera al candado, y después retoma el pedido que apareció: un solo pedido", async () => {
    setup({ shop: { products: CATALOG, now: () => new Date(t), postCommitsLate: true } });
    const first = await call();
    expect(first.status).toBe(503);
    expect(first.body).toMatchObject({ code: "woocommerce_unavailable", retryable: true, retry_after_seconds: 15 });
    expect((first.body as { message: string }).message).toContain("pudo haberlo creado igual");
    expect((first.body as { message: string }).message).not.toContain("No se creó");
    expect(h.db.rows("bot_order_requests")[0]).toMatchObject({ status: "processing", claimed_at: new Date(t).toISOString() });
    expect(lastLog().events).toContain("woo.sale.post_unanswered");

    t += 10_000;
    expect((await call()).body).toMatchObject({ code: "duplicate_in_progress" });
    // WordPress termina de guardar el pedido del primer POST.
    shop.commitLate();
    t += BOT_ORDER_CLAIM_TTL_MS;
    const res = await call();
    expect(res.body).toMatchObject({ ok: true, order: { name: "#KP200501", id: "wc-kp-501" } });
    expect(shop.calls.filter((c) => c.method === "POST")).toHaveLength(1);
    expect(shop.orders.size).toBe(1);
    expect([...shop.orders.values()][0]!.status).toBe("processing");
  });

  it("con un plugin que lo deja vivo al crearlo, se adopta", async () => {
    setup({ shop: { products: CATALOG, now: () => new Date(t), postCommitsLate: true, createdStatus: "processing" } });
    await call();
    shop.commitLate();
    t += BOT_ORDER_CLAIM_TTL_MS + 1_000;
    const res = await call();
    expect(res.body).toMatchObject({ ok: true, order: { name: "#KP200501" } });
    expect(shop.orders.size).toBe(1);
    expect(lastLog().events).toContain("woo.sale.adopted");
  });
});

describe("un pedido que quedó en WooCommerce sin confirmar se avisa a una persona", () => {
  it("vivo con otro precio y sin poder anularlo: order_left_open en la respuesta y la constancia en el lead, que sube a Atender ahora", async () => {
    setup({
      shop: { products: CATALOG, repriceSku: { "EGG-1": "99.00" }, createdStatus: "processing", failAlways: { "PUT /orders/501": { status: 500 } } },
      extra: { leads: [{ id: "lead-1", store_id: STORE, phone: "51988805509", kapso_conversation_id: CONV, needs_attention: false }] },
    });
    const res = await call();
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ ok: false, code: "price_mismatch", order_left_open: "#KP200501" });
    expect(lastLog()).toMatchObject({ outcome: "price_mismatch", left_open: true });
    await flush();
    const notes = h.db.rows("lead_calls");
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ lead_id: "lead-1", store_id: STORE, kind: "system", vendedora: null });
    expect(notes[0]!.note).toContain("#KP200501");
    expect(notes[0]!.note).toContain("Anúlalo en WooCommerce antes de generar otro pedido");
    expect(h.db.rows("leads")[0]!.needs_attention).toBe(true);
    // Sigue sin venta registrada ni fila local.
    expect(h.db.rows("orders")).toHaveLength(0);
  });

  it("si se borró, no hay nada que avisar", async () => {
    setup({
      shop: { products: CATALOG, repriceSku: { "EGG-1": "99.00" } },
      extra: { leads: [{ id: "lead-1", store_id: STORE, phone: "51988805509", kapso_conversation_id: CONV }] },
    });
    const res = await call();
    expect(res.body).not.toHaveProperty("order_left_open");
    await flush();
    expect(h.db.rows("lead_calls")).toHaveLength(0);
  });
});

describe("el mismo pedido pedido dos veces con otro request_id", () => {
  it("dentro de 10 minutos: el primero de vuelta, sin crear otro", async () => {
    setup();
    await call();
    t += 60_000;
    const res = await call(pedido({ request_id: "kapso-otra-llamada-01" }));
    expect(res.body).toEqual({ ok: true, order: { name: "#KP200501", id: "wc-kp-501", total: 89, currency: "PEN" }, replay: true });
    expect(shop.calls.filter((c) => c.method === "POST")).toHaveLength(1);
    expect(lastLog()).toMatchObject({ twin: true, replay: true });
  });

  it("mientras el primero se está creando: duplicate_in_progress", async () => {
    setup();
    await call();
    Object.assign(h.db.rows("bot_order_requests")[0]!, { status: "processing", claimed_at: new Date(t).toISOString() });
    const res = await call(pedido({ request_id: "kapso-otra-llamada-02" }));
    expect(res.body).toMatchObject({ code: "duplicate_in_progress", retryable: true });
    expect(shop.calls.filter((c) => c.method === "POST")).toHaveLength(1);
  });

  it("pasados los 10 minutos, u otra cosa (otra cantidad): es otro pedido", async () => {
    setup();
    await call();
    const other = await call(pedido({ request_id: "kapso-otra-cosa-0001", items: [{ sku: "EGG-1", quantity: 2, unit_price: 89 }] }));
    expect(other.body).toMatchObject({ ok: true, order: { name: "#KP200502" } });
    t += BOT_ORDER_SAME_BODY_WINDOW_MS + 1_000;
    const later = await call(pedido({ request_id: "kapso-mas-tarde-0001" }));
    expect(later.body).toMatchObject({ ok: true, order: { name: "#KP200503" } });
  });
});

describe("el modo de entrega y las etiquetas del bot, como hoy en Shopify", () => {
  it("agencia, promo y stock por validar: viajan en los meta y la fila los lleva", async () => {
    setup();
    const res = await call(pedido({ shipping_mode: "agencia", tags: ["promo-whatsapp", "stock-por-validar"] }));
    expect(res.status).toBe(200);
    const meta = shop.calls[1]!.body.meta_data as { key: string; value: string }[];
    expect(meta).toEqual(
      expect.arrayContaining([
        { key: "shipping_mode", value: "agency" },
        { key: "kapta_tags", value: "promo-whatsapp,stock-por-validar" },
        { key: "kapta_channel", value: "kapso" },
      ]),
    );
    expect(h.db.rows("orders")[0]).toMatchObject({
      shipping_mode: "agency",
      promo_applied: true,
      stock_por_validar: true,
      tags: expect.arrayContaining(["kapso", "whatsapp", "promo-whatsapp", "stock-por-validar"]),
    });
  });

  it("contraentrega sin decir; «cod»/«agency» también valen", () => {
    const a = parseBotOrderBody(pedido());
    expect(a.ok && [a.input.shippingMode, a.input.tags]).toEqual(["cod", []]);
    const b = parseBotOrderBody(pedido({ shipping_mode: "agency", tags: ["Stock-Por-Validar"] }));
    expect(b.ok && [b.input.shippingMode, b.input.tags]).toEqual(["agency", ["stock-por-validar"]]);
  });

  it("un modo o una etiqueta que no está en la lista es un error", async () => {
    setup();
    const res = await call(pedido({ shipping_mode: "delivery", tags: ["vip"] }));
    expect(res.status).toBe(400);
    expect((res.body as { errors: string[] }).errors).toEqual(
      expect.arrayContaining([expect.stringMatching(/^shipping_mode: /), expect.stringMatching(/^tags: /)]),
    );
  });

  it("el mismo request_id con otro modo de entrega es otro pedido: conflict", async () => {
    setup();
    await call();
    const res = await call(pedido({ shipping_mode: "agencia" }));
    expect(res.body).toMatchObject({ code: "conflict" });
    expect(shop.calls.filter((c) => c.method === "POST")).toHaveLength(1);
  });
});

describe("el tope por minuto cuenta solo el último minuto", () => {
  it("20 pedidos de hace más de un minuto no frenan el siguiente", async () => {
    setup();
    for (let i = 0; i < BOT_ORDER_RATE_PER_MINUTE; i++) {
      const at = new Date(t - 61_000 - i * 1_000).toISOString();
      h.db.rows("bot_order_requests").push({
        id: `r-${i}`,
        store_id: STORE,
        request_id: `kapso-viejo-${String(i).padStart(4, "0")}`,
        body_hash: "0".repeat(64),
        status: "done",
        claim_token: `tok-${i}`,
        claimed_at: at,
        created_at: at,
      });
    }
    expect((await call()).status).toBe(200);
  });
});
