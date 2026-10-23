// «Generar pedido» de punta a punta según `stores.platform` (MOM §38.12): con
// `shopify` el camino de Shopify se llama exactamente como antes y no hay
// ninguna llamada a WooCommerce; con `woocommerce` el pedido se crea en
// WooCommerce, la fila local es la de la entrada (`wc-kp-<id>`), el lead queda
// ganado y la venta registrada una sola vez aunque se reintente. También el
// buscador y el prellenado del carrito. Sin red ni base: WooCommerce y la base
// son falsos.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.ENCRYPTION_KEY = Buffer.alloc(32, 5).toString("base64");
});

const h = vi.hoisted(() => ({
  db: null as unknown as import("./woocommerce-fake-db").FakeDb,
  lead: { store_id: "", phone: null as string | null, kapso_conversation_id: null as string | null, wa_phone_number_id: null },
  creds: null as Record<string, unknown> | null,
  shopify: {
    createDraftOrder: vi.fn(),
    completeDraftOrder: vi.fn(),
    updateDraftOrder: vi.fn(),
    deleteDraftOrder: vi.fn(),
    getDraftOrderForEdit: vi.fn(),
    getDraftOrderOrder: vi.fn(),
    searchCatalogProducts: vi.fn(),
  },
  recompute: vi.fn(async () => ({ requested: 1, written: 1, error: null })),
  getStoreCreds: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/server", () => ({ after: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: (p: string) => {
    throw new Error(`redirect:${p}`);
  },
}));
vi.mock("@/lib/agent-names", () => ({ resolveAgentName: vi.fn(), resolveAgentNames: vi.fn() }));
vi.mock("@/lib/db", () => ({
  createServerSupabase: async () => ({
    auth: { getClaims: async () => ({ data: { claims: { sub: "advisor-1" } } }) },
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: h.lead }) }) }) }),
  }),
  createAdminSupabase: () => h.db.client(),
}));
vi.mock("@/lib/permissions-access", async (orig) => ({
  ...(await orig<typeof import("@/lib/permissions-access")>()),
  getMasterPermissions: async () => ({ can: () => true }),
  hasOrgPermission: async () => true,
}));
vi.mock("@/lib/leads-access", async (orig) => ({
  ...(await orig<typeof import("@/lib/leads-access")>()),
  getPedidosRecientesPorTelefono: async () => [],
}));
vi.mock("@/lib/ingest", async (orig) => ({
  ...(await orig<typeof import("@/lib/ingest")>()),
  getStoreCreds: h.getStoreCreds,
}));
vi.mock("@/lib/order-master", async (orig) => ({
  ...(await orig<typeof import("@/lib/order-master")>()),
  recomputeOrderMasterSafe: h.recompute,
}));
vi.mock("@/lib/shopify", async (orig) => ({
  ...(await orig<typeof import("@/lib/shopify")>()),
  ...h.shopify,
}));

import { encrypt } from "@/lib/crypto";
import { generateOrder, loadOrderDraft, searchStoreProducts, type GenerateOrderInput } from "@/app/dashboard/leads/actions";
import { shopifyOrderAdminUrl } from "@/lib/shopify-urls";
import { FakeDb, type Row } from "./woocommerce-fake-db";
import { CATALOG, fakeWooShop } from "./woocommerce-fake-shop";

const STORE = "11111111-1111-4111-8111-111111111111";
const LEAD = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const CK = "ck_0123456789abcdef0123456789abcdef01234567";
const CS = "cs_0123456789abcdef0123456789abcdef01234567";
const REQ = "5d1c2f7e-0b1a-4c3d-9e8f-123456789abc";

function storeRow(platform: "shopify" | "woocommerce"): Row {
  return {
    id: STORE,
    status: "active",
    timezone: "America/Lima",
    platform,
    platform_switched_at: platform === "woocommerce" ? "2026-10-27T23:00:00Z" : null,
    woo_intake_from: "2026-10-27T15:00:00Z",
    woo_site_url: "https://kenku.pe",
    woo_site_key: "kp",
    woo_consumer_key_enc: encrypt(CK),
    woo_consumer_secret_enc: encrypt(CS),
    woo_webhook_secret_enc: null,
    woo_last_error: null,
  };
}

function leadRow(over: Row = {}): Row {
  return {
    id: LEAD,
    store_id: STORE,
    phone: "51988805509",
    name: "Ana Torres",
    wa_phone_number_id: null,
    kapso_conversation_id: "conv-123",
    draft_order_gid: null,
    has_order: false,
    address1: null,
    district: null,
    province: null,
    referencia: null,
    ...over,
  };
}

function venta(over: Partial<GenerateOrderInput> = {}): GenerateOrderInput {
  return {
    lineItems: [
      { variantId: "woo:10", title: "EggMixer", quantity: 1, unitPrice: 89, sku: "EGG-1" },
      { variantId: "woo:11", title: "Papel Freidora", quantity: 1, unitPrice: 0, sku: "PAPEL-1" },
    ],
    customerName: "Ana Torres",
    phone: "988805509",
    address1: "Av. Primavera 123",
    district: "Santiago de Surco",
    province: "Lima",
    referencia: "Frente al parque",
    note: "Llamar antes",
    sendConfirmation: false,
    requestId: REQ,
    ...over,
  };
}

const forbiddenFetch = vi.fn(async () => {
  throw new Error("no debía llamar a la red");
});

function setup(platform: "shopify" | "woocommerce", lead: Row = leadRow(), extra: Record<string, Row[]> = {}) {
  h.db = new FakeDb({ stores: [storeRow(platform)], leads: [lead], ...extra });
  h.lead = { store_id: STORE, phone: lead.phone, kapso_conversation_id: lead.kapso_conversation_id, wa_phone_number_id: null };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  h.getStoreCreds.mockImplementation(async () => ({
    id: STORE,
    shopify_domain: "kenku.myshopify.com",
    shopify_token: "shpat_x",
    currency: "PEN",
    kapso_api_key: null,
    whatsapp_phone_number_id: null,
  }));
  vi.stubGlobal("fetch", forbiddenFetch);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("stores.platform = 'shopify': el camino de siempre, sin WooCommerce", () => {
  it("crea y completa el borrador de Shopify con los mismos argumentos, y ninguna llamada a WooCommerce", async () => {
    setup("shopify");
    h.shopify.createDraftOrder.mockResolvedValue({ gid: "gid://shopify/DraftOrder/5", name: "#D5", priceMismatches: [] });
    h.shopify.completeDraftOrder.mockResolvedValue({ orderGid: "gid://shopify/Order/777", orderName: "#KP143999", status: "completed" });
    const res = await generateOrder(
      LEAD,
      venta({
        lineItems: [{ variantId: "gid://shopify/ProductVariant/1", title: "EggMixer", quantity: 1, unitPrice: 89, sku: "EGG-1" }],
      }),
    );
    expect(res.error).toBeUndefined();
    expect(h.shopify.createDraftOrder).toHaveBeenCalledTimes(1);
    expect(h.shopify.createDraftOrder).toHaveBeenCalledWith({
      domain: "kenku.myshopify.com",
      token: "shpat_x",
      input: {
        note: "Llamar antes",
        appliedDiscount: null,
        currencyCode: "PEN",
        // Sin `sku`: Shopify va por la variante, como siempre.
        lineItems: [{ variantId: "gid://shopify/ProductVariant/1", title: "EggMixer", quantity: 1, unitPrice: 89 }],
        address: {
          name: "Ana Torres",
          phone: "51988805509",
          address1: "Av. Primavera 123",
          address2: "Frente al parque",
          city: "Santiago de Surco",
          province: "Lima",
          country: "Peru",
        },
        phone: "51988805509",
        tags: ["venta_manual"],
      },
    });
    expect(h.shopify.completeDraftOrder).toHaveBeenCalledWith({
      domain: "kenku.myshopify.com",
      token: "shpat_x",
      draftGid: "gid://shopify/DraftOrder/5",
      paymentPending: true,
    });
    expect(forbiddenFetch).not.toHaveBeenCalled();
    const order = h.db.rows("orders")[0]!;
    expect(order).toMatchObject({ shopify_order_id: "777", name: "#KP143999", tags: ["venta_manual"], kapso_conversation_id: null });
    expect(order).not.toHaveProperty("platform");
    expect(h.db.rows("lead_calls").find((c) => c.kind === "sale")!.note).toContain("Venta nueva · pedido generado en Shopify · PEN 89.00");
    expect(res.generatedOrder).toEqual({
      id: "777",
      orderId: order.id,
      name: "#KP143999",
      total: 89,
      currency: "PEN",
      adminUrl: shopifyOrderAdminUrl("kenku.myshopify.com", "777"),
      confirmationSent: false,
    });
    expect(h.db.rows("leads")[0]).toMatchObject({ has_order: true, status: "pedido_generado", category: "won", order_id: order.id });
    expect(h.db.rows("order_sales")).toHaveLength(1);
  });

  it("un producto del catálogo de WooCommerce (`woo:`) nunca viaja a Shopify", async () => {
    setup("shopify");
    const res = await generateOrder(LEAD, venta());
    expect(res.error).toContain("productos del catálogo de WooCommerce");
    expect(h.shopify.createDraftOrder).not.toHaveBeenCalled();
    expect(forbiddenFetch).not.toHaveBeenCalled();
  });

  it("el buscador sigue en Shopify", async () => {
    setup("shopify");
    h.shopify.searchCatalogProducts.mockResolvedValue([]);
    await searchStoreProducts(LEAD, "polo");
    expect(h.shopify.searchCatalogProducts).toHaveBeenCalledWith({ domain: "kenku.myshopify.com", token: "shpat_x", query: "polo", first: 20 });
    expect(forbiddenFetch).not.toHaveBeenCalled();
  });
});

describe("stores.platform = 'woocommerce'", () => {
  it("crea el pedido en WooCommerce y deja la fila de la entrada, el lead ganado y la venta", async () => {
    setup("woocommerce");
    const shop = fakeWooShop({ products: CATALOG });
    vi.stubGlobal("fetch", shop.fetchImpl);
    const res = await generateOrder(LEAD, venta());
    expect(res.error).toBeUndefined();
    expect(shop.calls.map((c) => `${c.method} ${c.path}`)).toEqual(["GET /orders", "POST /orders", "PUT /orders/501"]);
    const post = shop.calls[1]!.body;
    expect(post).toMatchObject({
      status: "pending",
      payment_method: "cod",
      set_paid: false,
      line_items: [
        { sku: "EGG-1", quantity: 1, subtotal: "89.00", total: "89.00" },
        { sku: "PAPEL-1", quantity: 1, subtotal: "0.00", total: "0.00" },
      ],
      billing: { phone: "+51988805509", state: "LMA", city: "Santiago de Surco", address_2: "Frente al parque" },
      meta_data: [
        { key: "kapta_channel", value: "venta_manual" },
        { key: "kapta_lead_id", value: LEAD },
        { key: "kapta_request_id", value: REQ },
        { key: "kapta_request_hash", value: expect.stringMatching(/^[0-9a-f]{64}$/) },
      ],
    });
    // Nada de Shopify.
    for (const fn of Object.values(h.shopify)) expect(fn).not.toHaveBeenCalled();
    expect(h.getStoreCreds).toHaveBeenCalledWith(STORE, expect.anything(), { renewOwnApp: false });

    const order = h.db.rows("orders")[0]!;
    expect(order).toMatchObject({
      store_id: STORE,
      shopify_order_id: "wc-kp-501",
      name: "#KP200501",
      platform: "woocommerce",
      tags: ["venta_manual"],
      financial_status: "pending",
      payment_gateway: "cod",
      total_amount: 89,
      kapso_conversation_id: null,
    });
    expect(h.recompute).toHaveBeenCalledWith(expect.anything(), [order.id]);
    expect(h.db.rows("leads")[0]).toMatchObject({ has_order: true, status: "pedido_generado", category: "won", order_id: order.id });
    const sale = h.db.rows("lead_calls").filter((c) => c.kind === "sale");
    expect(sale).toHaveLength(1);
    expect(sale[0]!.note).toContain("Venta nueva · pedido generado en WooCommerce · PEN 89.00");
    expect(h.db.rows("order_sales")).toEqual([expect.objectContaining({ order_id: order.id, vendedora: "advisor-1", lead_id: LEAD })]);
    expect(res.notice).toBe("Pedido generado ✓ · PEN 89.00 (contraentrega)");
    expect(res.generatedOrder).toEqual({
      id: "wc-kp-501",
      platform: "woocommerce",
      orderId: order.id,
      name: "#KP200501",
      total: 89,
      currency: "PEN",
      adminUrl: "https://kenku.pe/wp-admin/admin.php?page=wc-orders&action=edit&id=501",
      confirmationSent: false,
    });
  });

  it("el webhook que ya trajo el pedido no se pisa: la fila se inserta solo si falta", async () => {
    setup("woocommerce", leadRow(), {
      orders: [{ id: "ord-webhook", store_id: STORE, shopify_order_id: "wc-kp-501", name: "#KP200501", updated_at: "2099-01-01T00:00:00Z", platform: "woocommerce" }],
    });
    const shop = fakeWooShop({ products: CATALOG });
    vi.stubGlobal("fetch", shop.fetchImpl);
    const res = await generateOrder(LEAD, venta());
    expect(res.generatedOrder?.orderId).toBe("ord-webhook");
    expect(h.db.rows("orders")).toHaveLength(1);
    expect(h.db.rows("orders")[0]!.updated_at).toBe("2099-01-01T00:00:00Z");
  });

  it("un reintento del mismo intento no crea otro pedido ni registra la venta dos veces", async () => {
    setup("woocommerce");
    const shop = fakeWooShop({ products: CATALOG });
    vi.stubGlobal("fetch", shop.fetchImpl);
    const first = await generateOrder(LEAD, venta());
    expect(first.error).toBeUndefined();
    const again = await generateOrder(LEAD, venta());
    expect(again.error).toBeUndefined();
    expect(again.notice).toContain("Pedido ya generado ✓ · #KP200501");
    expect(again.generatedOrder?.id).toBe("wc-kp-501");
    expect(shop.calls.filter((c) => c.method === "POST")).toHaveLength(1);
    expect(shop.orders.size).toBe(1);
    expect(h.db.rows("orders")).toHaveLength(1);
    expect(h.db.rows("lead_calls").filter((c) => c.kind === "sale")).toHaveLength(1);
    expect(h.db.rows("order_sales")).toHaveLength(1);
  });

  it("reintento con el formulario cambiado (1 → 3) y el pedido anterior vivo: no se registra con lo de antes ni se crea otro", async () => {
    // Lo que reprodujo la revisión: el primer intento dejó el pedido vivo pero
    // la asesora vio un error (aquí, la fila local que no se pudo guardar),
    // subió a 3 unidades y reintentó. Antes se registraba «Pedido generado ✓ ·
    // PEN 89.00» con 1 unidad y el lead ganado.
    setup("woocommerce");
    const shop = fakeWooShop({ products: CATALOG });
    vi.stubGlobal("fetch", shop.fetchImpl);
    h.db.failOn = (table, op) => (table === "orders" && op === "upsert" ? { message: "falló la base" } : null);
    const first = await generateOrder(LEAD, venta());
    expect(first.error).toContain("Pedido #KP200501 generado en WooCommerce, pero no se pudo registrar localmente");
    h.db.failOn = null;
    const again = await generateOrder(
      LEAD,
      venta({
        lineItems: [
          { variantId: "woo:10", title: "EggMixer", quantity: 3, unitPrice: 89, sku: "EGG-1" },
          { variantId: "woo:11", title: "Papel Freidora", quantity: 1, unitPrice: 0, sku: "PAPEL-1" },
        ],
      }),
    );
    expect(again.error).toMatch(/^Pedido NO registrado: Este formulario ya creó el pedido #KP200501 en WooCommerce, y está vivo/);
    expect(again.error).toContain("«EggMixer» (ahora 3 unidades, en WooCommerce 1 unidad)");
    expect(again.generatedOrder).toBeUndefined();
    expect(shop.calls.filter((c) => c.method === "POST")).toHaveLength(1);
    expect(shop.orders.get(501)!.status).toBe("processing");
    expect(h.db.rows("order_sales")).toHaveLength(0);
    expect(h.db.rows("leads")[0]).toMatchObject({ has_order: false });
    const system = h.db.rows("lead_calls").filter((c) => c.kind === "system");
    expect(system).toHaveLength(1);
    expect(system[0]!.note).toMatch(/^⛔ Venta NO registrada · Este formulario ya creó el pedido #KP200501/);
  });

  it("un producto sin precio en WooCommerce (el formulario lo muestra a 0.00) se frena antes de llamar a la tienda", async () => {
    setup("woocommerce");
    const shop = fakeWooShop({ products: CATALOG });
    vi.stubGlobal("fetch", shop.fetchImpl);
    const res = await generateOrder(
      LEAD,
      venta({
        lineItems: [
          { variantId: "woo:10", title: "EggMixer", quantity: 1, unitPrice: 89, sku: "EGG-1" },
          { variantId: "woo:40", title: "Faja", quantity: 1, unitPrice: null, sku: "FAJA-1" },
        ],
      }),
    );
    expect(res.error).toContain("«Faja» no tiene precio");
    expect(shop.calls).toHaveLength(0);
  });

  it("el carrito abierto del lead se da por recuperado (como en Shopify), sin tocar su borrador ni llamar a Shopify", async () => {
    const GID = "gid://shopify/DraftOrder/9";
    setup("woocommerce", leadRow({ draft_order_gid: GID, draft_order_status: "open", kapso_conversation_id: null }), {
      draft_orders: [{ store_id: STORE, draft_order_gid: GID, status: "open", line_items: [] }],
    });
    const shop = fakeWooShop({ products: CATALOG });
    vi.stubGlobal("fetch", shop.fetchImpl);
    const res = await generateOrder(LEAD, venta());
    expect(res.error).toBeUndefined();
    expect(h.db.rows("leads")[0]).toMatchObject({ draft_order_status: "completed", category: "won" });
    expect(h.db.rows("draft_orders")[0]).toMatchObject({ status: "open" });
    expect(h.db.rows("lead_calls").find((c) => c.kind === "sale")!.note).toMatch(/^Carrito recuperado · pedido generado en WooCommerce/);
    for (const fn of Object.values(h.shopify)) expect(fn).not.toHaveBeenCalled();
    // Canal «Web · carrito completado», como el borrador reusado de Shopify
    // (owner, 23-10-2026); la venta de la asesora queda en order_sales igual.
    const post = shop.calls.find((c) => c.method === "POST" && c.path === "/orders")!.body as { meta_data: { key: string; value: string }[] };
    expect(post.meta_data).toContainEqual({ key: "kapta_channel", value: "web_carrito" });
    expect(h.db.rows("orders")[0]!.tags).toEqual(["easysell-abandoned-checkout"]);
    expect(h.db.rows("order_sales")).toHaveLength(1);
  });

  it("un carrito ya cerrado, o «pedido nuevo», no se cuenta como recuperado", async () => {
    const GID = "gid://shopify/DraftOrder/9";
    for (const [estado, nuevo] of [
      ["completed", false],
      ["open", true],
    ] as const) {
      setup("woocommerce", leadRow({ draft_order_gid: GID, draft_order_status: estado, kapso_conversation_id: null }), {
        draft_orders: [{ store_id: STORE, draft_order_gid: GID, status: estado, line_items: [] }],
      });
      const shop = fakeWooShop({ products: CATALOG });
      vi.stubGlobal("fetch", shop.fetchImpl);
      const res = await generateOrder(LEAD, venta({ noReutilizarBorrador: nuevo }));
      expect(res.error).toBeUndefined();
      expect(h.db.rows("leads")[0]!.draft_order_status).toBe(estado);
      expect(h.db.rows("lead_calls").find((c) => c.kind === "sale")!.note).toMatch(/^Venta nueva · /);
      const post = shop.calls.find((c) => c.method === "POST" && c.path === "/orders")!.body as { meta_data: { key: string; value: string }[] };
      expect(post.meta_data).toContainEqual({ key: "kapta_channel", value: "venta_manual" });
    }
  });

  it("precio no respetado: el pedido pendiente se borra, la venta se rechaza y queda constancia en el lead", async () => {
    setup("woocommerce");
    const shop = fakeWooShop({ products: CATALOG, repriceSku: { "PAPEL-1": "79.00" } });
    vi.stubGlobal("fetch", shop.fetchImpl);
    const res = await generateOrder(LEAD, venta());
    expect(res.error).toMatch(/^Pedido NO generado: WooCommerce no respetó el precio pactado en «Papel Freidora»/);
    expect(res.error).toContain("El pedido #KP200501 (pendiente de pago) se eliminó.");
    expect(shop.orders.size).toBe(0);
    expect(h.db.rows("orders")).toHaveLength(0);
    expect(h.db.rows("order_sales")).toHaveLength(0);
    const system = h.db.rows("lead_calls").filter((c) => c.kind === "system");
    expect(system).toHaveLength(1);
    expect(system[0]!.note).toMatch(/^⛔ Venta NO generada · WooCommerce no respetó/);
    expect(h.db.rows("leads")[0]).toMatchObject({ has_order: false });
  });

  it("un ítem manual se frena antes de llamar a WooCommerce", async () => {
    setup("woocommerce");
    const shop = fakeWooShop({ products: CATALOG });
    vi.stubGlobal("fetch", shop.fetchImpl);
    const res = await generateOrder(
      LEAD,
      venta({ lineItems: [{ variantId: null, title: "Faja talla M", quantity: 1, unitPrice: 50 }] }),
    );
    expect(res.error).toContain("«Faja talla M» es un ítem manual: WooCommerce no crea productos sin SKU.");
    expect(shop.calls).toHaveLength(0);
  });

  it("WooCommerce no contesta: error claro, nada creado y nada en Kapta", async () => {
    setup("woocommerce");
    const shop = fakeWooShop({ products: CATALOG, failAlways: { "GET /orders": "timeout" } });
    vi.stubGlobal("fetch", shop.fetchImpl);
    const res = await generateOrder(LEAD, venta());
    expect(res.error).toContain("No se pudo consultar WooCommerce antes de crear el pedido");
    expect(res.error).not.toContain(CK);
    expect(h.db.rows("orders")).toHaveLength(0);
  });

  it("el buscador usa el catálogo de WooCommerce, con la forma de siempre", async () => {
    setup("woocommerce");
    const shop = fakeWooShop({ products: CATALOG });
    vi.stubGlobal("fetch", shop.fetchImpl);
    const r = await searchStoreProducts(LEAD, "EggMixer");
    expect(r).toEqual([
      {
        productId: "woo:10",
        title: "EggMixer",
        imageUrl: "https://kenku.pe/wp-content/uploads/egg.jpg",
        variants: [{ variantId: "woo:10", variantTitle: "", price: 89, inventory: 7, sku: "EGG-1" }],
      },
    ]);
    expect(h.shopify.searchCatalogProducts).not.toHaveBeenCalled();
  });

  it("el carrito de Shopify prellena por SKU desde la copia local, sin preguntarle a Shopify", async () => {
    setup("woocommerce", leadRow({ draft_order_gid: "gid://shopify/DraftOrder/9", kapso_conversation_id: null }), {
      draft_orders: [
        {
          store_id: STORE,
          draft_order_gid: "gid://shopify/DraftOrder/9",
          line_items: [
            { title: "EggMixer", quantity: 1, price: 89, sku: "EGG-1" },
            { title: "Algo sin SKU", quantity: 1, price: 10, sku: null },
          ],
          address1: "Jr. Uno 1",
          district: "Lince",
          province: "Lima",
          referencia: null,
          customer_name: "Ana",
        },
      ],
    });
    const res = await loadOrderDraft(LEAD);
    if ("error" in res) throw new Error(res.error);
    expect(res.platform).toBe("woocommerce");
    expect(res.lineItems).toEqual([
      { variantId: null, title: "EggMixer", quantity: 1, unitPrice: 89, sku: "EGG-1" },
      { variantId: null, title: "Algo sin SKU", quantity: 1, unitPrice: 10, sku: null },
    ]);
    expect(h.shopify.getDraftOrderForEdit).not.toHaveBeenCalled();
    expect(h.getStoreCreds).not.toHaveBeenCalled();
  });

  it("si la tienda no se pudo leer, el formulario no se abre como de Shopify: error", async () => {
    setup("woocommerce");
    h.db.failOn = (table, op) => (table === "stores" && op === "select" ? { message: "canceling statement due to statement timeout" } : null);
    const res = await loadOrderDraft(LEAD);
    expect(res).toEqual({ error: "No se pudo leer la tienda. Intenta de nuevo en unos segundos." });
  });
});
