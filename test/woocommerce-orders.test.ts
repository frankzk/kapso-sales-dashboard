// «Generar pedido» y el buscador en WooCommerce (MOM §38.12): el cuerpo del
// pedido, la comparación con lo pactado, la creación pending → processing con
// su limpieza, el reintento que no crea otro pedido, el buscador con la forma
// de Shopify y dónde manda `stores.platform`. Sin red: WooCommerce es falso
// (test/woocommerce-fake-shop.ts).

import { describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
});

import { encrypt } from "@/lib/crypto";
import { priceMismatchRejection } from "@/lib/shopify";
import { WooError, mapWooOrder, wooErrorFromResponse, type WooOrder } from "@/lib/woocommerce";
import {
  WOO_COD_TITLE,
  WOO_SALE_BUDGET_MS,
  WOO_SALE_LOOKBACK_MS,
  WOO_SALE_TIMEOUTS,
  buildWooSaleOrder,
  createWooSaleOrder,
  findWooOrderByRequestId,
  flattenCatalog,
  loadStoreOrderPlatform,
  normalizeWooRequestId,
  parseWooVariantRef,
  searchWooCatalog,
  wooCleanupText,
  wooConflictRejection,
  wooLineCents,
  wooLineRejection,
  wooOrderAdminUrl,
  wooLinesToVerify,
  wooSaleFingerprint,
  wooSaleLinesProblem,
  wooSaleMismatches,
  wooVariantRef,
  type WooSaleInput,
  type WooSaleLine,
} from "@/lib/woocommerce-orders";
import { CATALOG, fakeWooShop } from "./woocommerce-fake-shop";
import { FakeDb } from "./woocommerce-fake-db";

const CK = "ck_0123456789abcdef0123456789abcdef01234567";
const CS = "cs_0123456789abcdef0123456789abcdef01234567";
const SITE = "https://kenku.pe";
const NOW = new Date("2026-10-27T20:00:00Z");
const REQ = "5d1c2f7e-0b1a-4c3d-9e8f-123456789abc";

const LEAD = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";

const VENTA: WooSaleLine[] = [
  { title: "EggMixer", quantity: 1, unitPrice: 89, sku: "EGG-1", variantId: wooVariantRef(10) },
  { title: "Papel Freidora", quantity: 1, unitPrice: 0, sku: "PAPEL-1", variantId: wooVariantRef(11) },
  { title: "Polo · M", quantity: 2, unitPrice: 59.9, sku: "POLO-M", variantId: wooVariantRef(21) },
];

function saleInput(over: Partial<WooSaleInput> = {}): WooSaleInput {
  return {
    leadId: LEAD,
    requestId: REQ,
    lines: VENTA,
    discountAmount: 0,
    address: {
      name: "Ana María Torres",
      phone: "51988805509",
      address1: "Av. Primavera 123",
      address2: "Frente al parque",
      city: "Santiago de Surco",
      province: "Lima",
    },
    note: "Llamar antes",
    ...over,
  };
}

function client(fetchImpl: typeof fetch) {
  return { siteUrl: SITE, consumerKey: CK, consumerSecret: CS, fetchImpl };
}

const silent = () => {};

describe("el pedido que se manda (buildWooSaleOrder)", () => {
  it("pending, contraentrega, por SKU con el precio fijado, regalo a S/ 0, envío a S/ 0, dirección completa y metadatos", () => {
    const { body, expected } = buildWooSaleOrder(saleInput());
    const address = {
      first_name: "Ana",
      last_name: "María Torres",
      address_1: "Av. Primavera 123",
      address_2: "Frente al parque",
      city: "Santiago de Surco",
      state: "LMA",
      country: "PE",
      phone: "+51988805509",
    };
    expect(body).toEqual({
      status: "pending",
      set_paid: false,
      created_via: "kapta",
      payment_method: "cod",
      payment_method_title: WOO_COD_TITLE,
      billing: address,
      shipping: address,
      line_items: [
        { sku: "EGG-1", quantity: 1, subtotal: "89.00", total: "89.00" },
        { sku: "PAPEL-1", quantity: 1, subtotal: "0.00", total: "0.00" },
        { sku: "POLO-M", quantity: 2, subtotal: "119.80", total: "119.80" },
      ],
      shipping_lines: [{ method_id: "free_shipping", method_title: "Envío gratis", total: "0.00" }],
      meta_data: [
        { key: "kapta_channel", value: "venta_manual" },
        { key: "kapta_lead_id", value: LEAD },
        { key: "kapta_request_id", value: REQ },
        { key: "kapta_request_hash", value: expected.fingerprint },
      ],
      customer_note: "Llamar antes",
    });
    expect(expected.total).toBe(208.8);
    expect(expected.lines.map((l) => l.wooId)).toEqual([10, 11, 21]);
    expect(expected.leadId).toBe(LEAD);
    expect(expected.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it("la huella: la misma con el mismo formulario; otra con una unidad, un descuento, una dirección o una nota distinta", () => {
    const base = buildWooSaleOrder(saleInput()).expected.fingerprint;
    expect(buildWooSaleOrder(saleInput({ requestId: "otro-intento-0001" })).expected.fingerprint).toBe(base);
    const otras = [
      saleInput({ lines: [{ ...VENTA[0]!, quantity: 3 }, VENTA[1]!, VENTA[2]!] }),
      saleInput({ discountAmount: 5 }),
      saleInput({ address: { ...saleInput().address, address1: "Av. Primavera 125" } }),
      saleInput({ note: "Llamar después" }),
      saleInput({ leadId: "bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb" }),
    ].map((i) => buildWooSaleOrder(i).expected.fingerprint);
    for (const f of otras) expect(f).not.toBe(base);
    // Los metadatos no entran a la huella (si no, cada intento tendría otra).
    const { body } = buildWooSaleOrder(saleInput());
    expect(wooSaleFingerprint({ ...body, meta_data: [] }, LEAD)).toBe(base);
  });

  it("la conversación de Kapso NO viaja: la venta de la asesora no se vuelve «Chatbot» (§17.3)", () => {
    const { body } = buildWooSaleOrder(saleInput());
    const keys = (body.meta_data as { key: string }[]).map((m) => m.key);
    expect(keys).not.toContain("kapso_conversation_id");
    expect(keys).not.toContain("kapso");
    expect(keys).not.toContain("shipping_mode");
  });

  it("el departamento va con el código de WooCommerce: LMA, LIM, CAL; uno desconocido, tal cual", () => {
    const state = (province: string | null) =>
      (buildWooSaleOrder(saleInput({ address: { ...saleInput().address, province } })).body.billing as { state: string }).state;
    expect(state("Lima")).toBe("LMA");
    expect(state("Lima (provincia)")).toBe("LMA");
    expect(state("Lima (departamento)")).toBe("LIM");
    expect(state("Callao")).toBe("CAL");
    expect(state("Arequipa")).toBe("ARE");
    expect(state("Áncash")).toBe("ANC");
    expect(state("Atlántida")).toBe("Atlántida");
    expect(state(null)).toBe("");
  });

  it("sin nota, sin referencia y sin teléfono: campos vacíos, nunca null (la API rechaza null)", () => {
    const { body } = buildWooSaleOrder(
      saleInput({ note: null, address: { ...saleInput().address, address2: null, phone: null, name: null } }),
    );
    expect(body).not.toHaveProperty("customer_note");
    expect(body.billing).toMatchObject({ address_2: "", phone: "", first_name: "", last_name: "" });
    expect(JSON.stringify(body)).not.toContain("null");
  });

  it("una línea sin precio pactado va a precio de catálogo y no hay total esperado", () => {
    const { body, expected } = buildWooSaleOrder(
      saleInput({ lines: [{ title: "EggMixer", quantity: 1, unitPrice: null, sku: "EGG-1", variantId: null }] }),
    );
    expect((body.line_items as unknown[])[0]).toEqual({ sku: "EGG-1", quantity: 1 });
    expect(expected.total).toBeNull();
  });
});

describe("el descuento del pedido se reparte entre las líneas al céntimo (wooLineCents)", () => {
  it("la suma de los totales es el total pactado, y el regalo no lleva descuento", () => {
    const lines = [
      { unitPrice: 89, quantity: 1 },
      { unitPrice: 0, quantity: 1 },
      { unitPrice: 59.9, quantity: 2 },
    ];
    const r = wooLineCents(lines, 20.01);
    expect(r[1]).toEqual({ subtotal: 0, total: 0 });
    expect(r.reduce((s, x) => s + (x.total ?? 0), 0)).toBe(20880 - 2001);
    for (const x of r) expect(x.total!).toBeLessThanOrEqual(x.subtotal!);
  });

  it("un porcentaje que deja céntimos sueltos tampoco pierde ni suma un céntimo", () => {
    const lines = [
      { unitPrice: 33.33, quantity: 1 },
      { unitPrice: 33.33, quantity: 1 },
      { unitPrice: 33.34, quantity: 1 },
    ];
    const r = wooLineCents(lines, 10);
    expect(r.reduce((s, x) => s + (x.total ?? 0), 0)).toBe(9000);
  });

  it("en el body: total < subtotal en las líneas con descuento", () => {
    const { body, expected } = buildWooSaleOrder(saleInput({ discountAmount: 20 }));
    const items = body.line_items as { subtotal: string; total: string }[];
    expect(items[0]).toMatchObject({ subtotal: "89.00" });
    expect(Number(items[0]!.total)).toBeLessThan(89);
    expect(items[1]).toMatchObject({ subtotal: "0.00", total: "0.00" });
    expect(expected.total).toBe(188.8);
    expect(items.reduce((s, i) => s + Number(i.total), 0)).toBeCloseTo(188.8, 2);
  });
});

describe("ítems manuales y líneas sin SKU (wooSaleLinesProblem)", () => {
  it("un ítem manual se frena con un mensaje claro", () => {
    const msg = wooSaleLinesProblem([{ title: "Faja talla M", quantity: 1, unitPrice: 50, sku: null, variantId: null }]);
    expect(msg).toBe(
      "Pedido NO generado: «Faja talla M» es un ítem manual: WooCommerce no crea productos sin SKU. Quítalos y agrégalos desde «Producto del catálogo».",
    );
  });

  it("una línea traída de Shopify sin SKU se nombra aparte", () => {
    const msg = wooSaleLinesProblem([
      { title: "EggMixer", quantity: 1, unitPrice: 89, sku: null, variantId: "gid://shopify/ProductVariant/1" },
      { title: "", quantity: 1, unitPrice: 10, sku: " ", variantId: null },
    ]);
    expect(msg).toContain("«EggMixer» viene del catálogo de Shopify sin SKU.");
    expect(msg).toContain("«Ítem manual» es un ítem manual");
  });

  it("una variación de WooCommerce sin SKU propio tiene su mensaje (no es un ítem manual)", () => {
    const msg = wooSaleLinesProblem([{ title: "Polo · L", quantity: 1, unitPrice: 59.9, sku: null, variantId: wooVariantRef(22) }]);
    expect(msg).toContain("«Polo · L» no tiene SKU propio en WooCommerce");
    expect(msg).toContain("Pide al administrador que le ponga su SKU");
    expect(msg).not.toContain("ítem manual");
    expect(msg).not.toContain("agrégalos desde «Producto del catálogo»");
  });

  it("un producto sin precio (WooCommerce lo permite) se frena: sin precio fijado no hay con qué comparar", () => {
    const msg = wooSaleLinesProblem([
      VENTA[0]!,
      { title: "Faja", quantity: 1, unitPrice: null, sku: "FAJA-1", variantId: wooVariantRef(40) },
    ]);
    expect(msg).toBe(
      "Pedido NO generado: «Faja» no tiene precio: sin uno fijado, WooCommerce cobraría el de su catálogo sin que Kapta lo compruebe. Pide al administrador que le ponga precio en WooCommerce.",
    );
  });

  it("un precio negativo (o que no es un número) se frena; un regalo a S/ 0 no", () => {
    expect(wooSaleLinesProblem([{ ...VENTA[0]!, unitPrice: -10 }])).toContain("«EggMixer» tiene un precio negativo o no válido.");
    expect(wooSaleLinesProblem([{ ...VENTA[0]!, unitPrice: Number.NaN }])).toContain("precio negativo o no válido");
    expect(wooSaleLinesProblem([{ ...VENTA[1]!, unitPrice: 0 }])).toBeNull();
  });

  it("con SKU y precio en todas, nada que frenar", () => {
    expect(wooSaleLinesProblem(VENTA)).toBeNull();
  });
});

describe("crear la venta (createWooSaleOrder)", () => {
  it("camino feliz: busca el intento anterior, POST pending, PUT processing; nada se borra", async () => {
    const shop = fakeWooShop({ products: CATALOG, now: () => NOW });
    const { body, expected } = buildWooSaleOrder(saleInput());
    const out = await createWooSaleOrder({ client: client(shop.fetchImpl), body, expected, requestId: REQ, now: () => NOW.getTime(), log: silent });
    expect(out.kind).toBe("created");
    expect(shop.calls.map((c) => `${c.method} ${c.path}`)).toEqual(["GET /orders", "POST /orders", "PUT /orders/501"]);
    const lookup = shop.calls[0]!.query;
    expect(lookup.get("status")).toBe("any");
    expect(lookup.get("after")).toBe(new Date(NOW.getTime() - WOO_SALE_LOOKBACK_MS).toISOString().slice(0, 19));
    expect(lookup.get("dates_are_gmt")).toBe("true");
    expect(lookup.get("_fields")).toBe("id,status,number,meta_data");
    expect(shop.calls[1]!.body).toEqual(body);
    expect(shop.calls[2]!.body).toEqual({ status: "processing" });
    expect(shop.calls.every((c) => c.auth?.startsWith("Basic "))).toBe(true);
    if (out.kind !== "created") return;
    expect(out.order.status).toBe("processing");
    expect(shop.orders.get(501)!.status).toBe("processing");
  });

  it("la fila local es la de la entrada: mapWooOrder sobre la respuesta, wc-kp-<id>, woocommerce, venta_manual", async () => {
    const shop = fakeWooShop({ products: CATALOG, now: () => NOW });
    const { body, expected } = buildWooSaleOrder(saleInput());
    const out = await createWooSaleOrder({ client: client(shop.fetchImpl), body, expected, requestId: REQ, now: () => NOW.getTime(), log: silent });
    if (out.kind !== "created") throw new Error(out.kind);
    const row = mapWooOrder(out.order, { id: "store-1", woo_site_key: "kp" })!;
    expect(row).toMatchObject({
      store_id: "store-1",
      shopify_order_id: "wc-kp-501",
      name: "#KP200501",
      platform: "woocommerce",
      tags: ["venta_manual"],
      financial_status: "pending",
      payment_gateway: "cod",
      total_amount: 208.8,
      customer_phone: "51988805509",
      kapso_conversation_id: null,
      cancelled_at: null,
    });
    expect(row.line_items.map((l) => [l.sku, l.price])).toEqual([
      ["EGG-1", 89],
      ["PAPEL-1", 0],
      ["POLO-M", 59.9],
    ]);
    expect((row.raw as { shipping_address: { province: string; city: string; address2: string } }).shipping_address).toMatchObject({
      province: "Lima (provincia)",
      city: "Santiago de Surco",
      address2: "Frente al parque",
    });
    // El webhook de ese mismo pedido trae el mismo id y una fecha igual o más
    // nueva: actualiza, no duplica ni se toma por viejo.
    const webhook = mapWooOrder({ ...(shop.orders.get(501) as WooOrder) }, { id: "store-1", woo_site_key: "kp" })!;
    expect(webhook.shopify_order_id).toBe(row.shopify_order_id);
    expect(Date.parse(webhook.updated_at!)).toBeGreaterThanOrEqual(Date.parse(row.updated_at!));
  });

  it("WooCommerce no respeta un precio (el regalo sube a S/ 79): DELETE ?force=true, sin PUT, y el rechazo de siempre", async () => {
    const shop = fakeWooShop({ products: CATALOG, now: () => NOW, repriceSku: { "PAPEL-1": "79.00" } });
    const { body, expected } = buildWooSaleOrder(saleInput());
    const out = await createWooSaleOrder({ client: client(shop.fetchImpl), body, expected, requestId: REQ, now: () => NOW.getTime(), log: silent });
    expect(shop.calls.map((c) => `${c.method} ${c.path}`)).toEqual(["GET /orders", "POST /orders", "DELETE /orders/501"]);
    expect(shop.calls[2]!.query.get("force")).toBe("true");
    expect(shop.orders.size).toBe(0);
    expect(out).toMatchObject({ kind: "price", cleanup: "deleted", orderLabel: "#KP200501" });
    if (out.kind !== "price") return;
    expect(out.desajustes).toEqual([{ title: "Papel Freidora", pedido: 0, aplicado: 79 }]);
    const r = priceMismatchRejection({
      desajustes: out.desajustes,
      currency: "PEN",
      draftName: out.orderLabel,
      tienda: "WooCommerce",
      limpieza: wooCleanupText(out.cleanup, out.orderLabel),
    });
    expect(r.error).toBe(
      "Pedido NO generado: WooCommerce no respetó el precio pactado en «Papel Freidora» (pediste PEN 0.00, WooCommerce guardó PEN 79.00). " +
        "El pedido #KP200501 (pendiente de pago) se eliminó. Elige el producto desde el catálogo o revisa el precio y vuelve a intentarlo; si se repite, avisa al administrador.",
    );
    expect(r.note).toMatch(/^⛔ Venta NO generada · WooCommerce no respetó/);
  });

  it("los textos de Shopify no cambian con el parámetro nuevo", () => {
    const d = [{ title: "X", pedido: 89, aplicado: 0 }];
    expect(priceMismatchRejection({ desajustes: d, currency: "PEN", draftName: "#D1", cleanup: "deleted" })).toEqual(
      priceMismatchRejection({ desajustes: d, currency: "PEN", draftName: "#D1", cleanup: "deleted", tienda: "Shopify" }),
    );
    expect(priceMismatchRejection({ desajustes: d, currency: "PEN", draftName: null, cleanup: "delete_failed" }).error).toContain(
      "No se pudo eliminar el borrador de Shopify: bórralo en Shopify.",
    );
  });

  it("un SKU que no existe deja la línea sin producto: se borra y se dice cuál", async () => {
    const shop = fakeWooShop({ products: CATALOG, now: () => NOW });
    const lines: WooSaleLine[] = [{ title: "Faja", quantity: 1, unitPrice: 50, sku: "NO-EXISTE", variantId: null }];
    const { body, expected } = buildWooSaleOrder(saleInput({ lines }));
    const out = await createWooSaleOrder({ client: client(shop.fetchImpl), body, expected, requestId: REQ, now: () => NOW.getTime(), log: silent });
    expect(out).toMatchObject({ kind: "lines", cleanup: "deleted", problemas: [{ title: "Faja", sku: "NO-EXISTE", motivo: "no_existe" }] });
    expect(shop.calls.some((c) => c.method === "PUT")).toBe(false);
    if (out.kind !== "lines") throw new Error(out.kind);
    const r = wooLineRejection({ problemas: out.problemas, orderLabel: out.orderLabel, cleanup: out.cleanup });
    expect(r.error).toContain("«Faja» (SKU NO-EXISTE): no existe en WooCommerce");
    expect(r.error).toContain("El pedido #KP200501 (pendiente de pago) se eliminó.");
  });

  it("el SKU de otro producto que el elegido en el buscador (SKU repetido o del padre): se borra", async () => {
    const shop = fakeWooShop({ products: CATALOG, now: () => NOW });
    // La talla L no tiene SKU propio: por el SKU del padre se crearía el producto variable.
    const lines: WooSaleLine[] = [{ title: "Polo · L", quantity: 1, unitPrice: 59.9, sku: "POLO", variantId: wooVariantRef(22) }];
    const { body, expected } = buildWooSaleOrder(saleInput({ lines }));
    const out = await createWooSaleOrder({ client: client(shop.fetchImpl), body, expected, requestId: REQ, now: () => NOW.getTime(), log: silent });
    expect(out).toMatchObject({ kind: "lines", problemas: [{ motivo: "otro_producto" }] });
    expect(shop.orders.size).toBe(0);
  });

  it("impuestos o envío que la tienda suma: desajuste y se borra", async () => {
    const shop = fakeWooShop({ products: CATALOG, now: () => NOW, tax: "18.00" });
    const { body, expected } = buildWooSaleOrder(saleInput());
    const out = await createWooSaleOrder({ client: client(shop.fetchImpl), body, expected, requestId: REQ, now: () => NOW.getTime(), log: silent });
    expect(out).toMatchObject({ kind: "price", desajustes: [{ title: "Impuestos", pedido: 0, aplicado: 18 }] });
  });

  it("falla el PUT (500) y el pedido sigue pending: se borra y la venta no se da por hecha", async () => {
    const shop = fakeWooShop({ products: CATALOG, now: () => NOW, failOnce: { "PUT /orders/501": { status: 500 } } });
    const { body, expected } = buildWooSaleOrder(saleInput());
    const out = await createWooSaleOrder({ client: client(shop.fetchImpl), body, expected, requestId: REQ, now: () => NOW.getTime(), log: silent });
    expect(shop.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "GET /orders",
      "POST /orders",
      "PUT /orders/501",
      "GET /orders/501",
      "DELETE /orders/501",
    ]);
    expect(out).toMatchObject({ kind: "error", cleanup: "deleted", orderLabel: "#KP200501" });
    expect((out as { message: string }).message).toContain("WooCommerce no confirmó el paso a «Procesando»");
  });

  it("el PUT llegó pero la respuesta no: se relee, está processing, es la venta (no se borra)", async () => {
    const shop = fakeWooShop({ products: CATALOG, now: () => NOW, putAppliesThenTimesOut: true });
    const { body, expected } = buildWooSaleOrder(saleInput());
    const out = await createWooSaleOrder({ client: client(shop.fetchImpl), body, expected, requestId: REQ, now: () => NOW.getTime(), log: silent });
    expect(out.kind).toBe("created");
    expect(shop.calls.some((c) => c.method === "DELETE")).toBe(false);
  });

  it("el POST se creó pero la respuesta no llegó: lo busca por su id de intento y lo borra", async () => {
    const shop = fakeWooShop({ products: CATALOG, now: () => NOW, postCreatesThenTimesOut: true });
    const { body, expected } = buildWooSaleOrder(saleInput());
    const out = await createWooSaleOrder({ client: client(shop.fetchImpl), body, expected, requestId: REQ, now: () => NOW.getTime(), log: silent });
    expect(out).toMatchObject({ kind: "error", cleanup: "deleted" });
    expect((out as { message: string }).message).toContain("no respondió a tiempo");
    expect(shop.orders.size).toBe(0);
  });

  it("WooCommerce no contesta al buscar el intento anterior: no se crea nada", async () => {
    const shop = fakeWooShop({ products: CATALOG, now: () => NOW, failAlways: { "GET /orders": "timeout" } });
    const { body, expected } = buildWooSaleOrder(saleInput());
    const out = await createWooSaleOrder({ client: client(shop.fetchImpl), body, expected, requestId: REQ, now: () => NOW.getTime(), log: silent });
    expect(out).toMatchObject({ kind: "error", cleanup: null });
    expect((out as { message: string }).message).toContain("No se creó nada.");
    expect(shop.calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("un rechazo de la API (400) no crea nada y no se busca nada que borrar", async () => {
    const shop = fakeWooShop({
      products: CATALOG,
      now: () => NOW,
      failOnce: { "POST /orders": { status: 400, body: { code: "rest_invalid_param", message: "Parámetro(s) no válido(s): billing" } } },
    });
    const { body, expected } = buildWooSaleOrder(saleInput());
    const out = await createWooSaleOrder({ client: client(shop.fetchImpl), body, expected, requestId: REQ, now: () => NOW.getTime(), log: silent });
    expect(out).toMatchObject({ kind: "error", cleanup: null });
    expect(shop.calls.map((c) => `${c.method} ${c.path}`)).toEqual(["GET /orders", "POST /orders"]);
  });

  it("el hosting borra la cabecera Authorization: reintenta por query y sigue así", async () => {
    const shop = fakeWooShop({
      products: CATALOG,
      now: () => NOW,
      failOnce: { "GET /orders": { status: 401, body: { code: "woocommerce_rest_cannot_view", message: "Lo siento, no puedes listar los recursos." } } },
    });
    const { body, expected } = buildWooSaleOrder(saleInput());
    const out = await createWooSaleOrder({ client: client(shop.fetchImpl), body, expected, requestId: REQ, now: () => NOW.getTime(), log: silent });
    expect(out.kind).toBe("created");
    const after = shop.calls.slice(1);
    expect(after.every((c) => c.auth === null && c.query.get("consumer_key") === CK)).toBe(true);
  });

  it("sin precio fijado no se llama a WooCommerce (la red detrás de wooSaleLinesProblem)", async () => {
    const shop = fakeWooShop({ products: CATALOG, now: () => NOW });
    const { body, expected } = buildWooSaleOrder(
      saleInput({ lines: [{ title: "EggMixer", quantity: 1, unitPrice: null, sku: "EGG-1", variantId: wooVariantRef(10) }] }),
    );
    const out = await createWooSaleOrder({ client: client(shop.fetchImpl), body, expected, requestId: REQ, now: () => NOW.getTime(), log: silent });
    expect(out).toMatchObject({ kind: "error", cleanup: null });
    expect(shop.calls).toHaveLength(0);
  });

  it("un plugin deja el pedido vivo al crearlo y el precio no cuadra: se ANULA (devuelve el stock), no se borra", async () => {
    const shop = fakeWooShop({ products: CATALOG, now: () => NOW, createdStatus: "processing", repriceSku: { "PAPEL-1": "79.00" } });
    const { body, expected } = buildWooSaleOrder(saleInput());
    const out = await createWooSaleOrder({ client: client(shop.fetchImpl), body, expected, requestId: REQ, now: () => NOW.getTime(), log: silent });
    expect(out).toMatchObject({ kind: "price", cleanup: "cancelled", orderLabel: "#KP200501" });
    expect(shop.calls.map((c) => `${c.method} ${c.path}`)).toEqual(["GET /orders", "POST /orders", "PUT /orders/501"]);
    expect(shop.calls[2]!.body).toEqual({ status: "cancelled" });
    expect(shop.orders.get(501)!.status).toBe("cancelled");
    expect(wooCleanupText("cancelled", "#KP200501")).toBe(
      "El pedido #KP200501 ya figuraba como vivo en WooCommerce (lo movió un plugin) y se anuló.",
    );
  });

  it("una línea de un carrito (sin elección del buscador) cuyo SKU es el del producto variable: se comprueba el tipo y se borra", async () => {
    const shop = fakeWooShop({ products: CATALOG, now: () => NOW });
    const lines: WooSaleLine[] = [{ title: "Polo", quantity: 1, unitPrice: 59.9, sku: "POLO", variantId: null }];
    const { body, expected } = buildWooSaleOrder(saleInput({ lines }));
    const out = await createWooSaleOrder({ client: client(shop.fetchImpl), body, expected, requestId: REQ, now: () => NOW.getTime(), log: silent });
    expect(out).toMatchObject({ kind: "lines", cleanup: "deleted", problemas: [{ title: "Polo", sku: "POLO", motivo: "variable" }] });
    const verify = shop.calls.find((c) => c.method === "GET" && c.path === "/products")!;
    expect(verify.query.get("include")).toBe("20");
    expect(verify.query.get("_fields")).toBe("id,type");
    expect(shop.calls.some((c) => c.method === "PUT")).toBe(false);
    if (out.kind !== "lines") return;
    expect(wooLineRejection({ problemas: out.problemas, orderLabel: out.orderLabel, cleanup: out.cleanup }).error).toContain(
      "«Polo» (SKU POLO): ese SKU es el del producto con variaciones, no el de una variación",
    );
  });

  it("una línea de un carrito con el SKU de un producto simple: se comprueba y pasa", async () => {
    const shop = fakeWooShop({ products: CATALOG, now: () => NOW });
    const lines: WooSaleLine[] = [{ title: "EggMixer", quantity: 1, unitPrice: 89, sku: "EGG-1", variantId: null }];
    const { body, expected } = buildWooSaleOrder(saleInput({ lines }));
    const out = await createWooSaleOrder({ client: client(shop.fetchImpl), body, expected, requestId: REQ, now: () => NOW.getTime(), log: silent });
    expect(out.kind).toBe("created");
    expect(shop.calls.map((c) => `${c.method} ${c.path}`)).toEqual(["GET /orders", "POST /orders", "GET /products", "PUT /orders/501"]);
  });

  it("wooLinesToVerify: solo las líneas sin id del buscador que quedaron sin variación", () => {
    const { expected } = buildWooSaleOrder(
      saleInput({
        lines: [
          { title: "A", quantity: 1, unitPrice: 1, sku: "A", variantId: null },
          { title: "B", quantity: 1, unitPrice: 1, sku: "B", variantId: wooVariantRef(11) },
          { title: "C", quantity: 1, unitPrice: 1, sku: "C", variantId: null },
        ],
      }),
    );
    const order = {
      line_items: [
        { product_id: 20, variation_id: 0 },
        { product_id: 11, variation_id: 0 },
        { product_id: 20, variation_id: 21 },
      ],
    } as unknown as WooOrder;
    expect(wooLinesToVerify(expected, order)).toEqual([20]);
  });

  it("los registros no llevan datos de la clienta ni claves", async () => {
    const lines: string[] = [];
    const shop = fakeWooShop({ products: CATALOG, now: () => NOW, repriceSku: { "EGG-1": "99.00" } });
    const { body, expected } = buildWooSaleOrder(saleInput());
    await createWooSaleOrder({
      client: client(shop.fetchImpl),
      body,
      expected,
      requestId: REQ,
      now: () => NOW.getTime(),
      log: (event, data) => lines.push(JSON.stringify({ event, ...data })),
    });
    expect(lines).toEqual([JSON.stringify({ event: "woo.sale.deleted", wooId: 501, reason: "precio" })]);
  });
});

describe("cuando el PUT a processing no contesta: nunca se borra a ciegas", () => {
  const run = (shop: ReturnType<typeof fakeWooShop>, over: Partial<WooSaleInput> = {}) => {
    const { body, expected } = buildWooSaleOrder(saleInput(over));
    return createWooSaleOrder({ client: client(shop.fetchImpl), body, expected, requestId: REQ, now: () => NOW.getTime(), log: silent });
  };
  const paths = (shop: ReturnType<typeof fakeWooShop>) => shop.calls.map((c) => `${c.method} ${c.path}`);

  it("el PUT se aplicó, la respuesta se perdió y la relectura también: NO se borra (estaba processing), y el reintento lo adopta", async () => {
    // Lo que reprodujeron las revisiones: antes se mandaba DELETE ?force=true
    // sobre un pedido ya vivo (stock descontado, quizá ya en el Master).
    const shop = fakeWooShop({ products: CATALOG, now: () => NOW, putAppliesThenTimesOut: true, failOnce: { "GET /orders/501": "timeout" } });
    const first = await run(shop);
    expect(first).toMatchObject({ kind: "error", cleanup: "unknown", orderLabel: "#KP200501" });
    expect(paths(shop)).toEqual(["GET /orders", "POST /orders", "PUT /orders/501", "GET /orders/501"]);
    expect(shop.orders.get(501)!.status).toBe("processing");
    const texto = wooCleanupText("unknown", "#KP200501");
    expect(texto).toContain("No cierres este formulario");
    expect(texto).not.toContain("pendiente de pago");

    shop.calls.length = 0;
    const again = await run(shop);
    expect(again.kind).toBe("adopted");
    expect(paths(shop)).toEqual(["GET /orders", "GET /orders/501"]);
    expect(shop.orders.size).toBe(1);
  });

  it("el PUT no contestó y la relectura lo ve pending: se deja así (pudo seguir en camino) y el reintento lo RETOMA, sin otro POST", async () => {
    const shop = fakeWooShop({ products: CATALOG, now: () => NOW, failOnce: { "PUT /orders/501": "timeout" } });
    const first = await run(shop);
    expect(first).toMatchObject({ kind: "error", cleanup: "kept_pending" });
    expect(paths(shop)).toEqual(["GET /orders", "POST /orders", "PUT /orders/501", "GET /orders/501"]);
    expect(shop.orders.get(501)!.status).toBe("pending");

    shop.calls.length = 0;
    const again = await run(shop);
    expect(again.kind).toBe("created");
    expect(paths(shop)).toEqual(["GET /orders", "GET /orders/501", "PUT /orders/501"]);
    expect(shop.orders.size).toBe(1);
    expect(shop.orders.get(501)!.status).toBe("processing");
  });

  it("un 502/503/504 de un proxy tampoco es un «no»: no se borra", async () => {
    const shop = fakeWooShop({ products: CATALOG, now: () => NOW, failOnce: { "PUT /orders/501": { status: 504 } } });
    const out = await run(shop);
    expect(out).toMatchObject({ kind: "error", cleanup: "kept_pending" });
    expect(shop.calls.some((c) => c.method === "DELETE")).toBe(false);
  });

  it("WooCommerce contestó que no (500) y el pedido sigue pending: ese sí se borra", async () => {
    const shop = fakeWooShop({ products: CATALOG, now: () => NOW, failOnce: { "PUT /orders/501": { status: 500 } } });
    const out = await run(shop);
    expect(out).toMatchObject({ kind: "error", cleanup: "deleted" });
    expect(paths(shop)).toEqual(["GET /orders", "POST /orders", "PUT /orders/501", "GET /orders/501", "DELETE /orders/501"]);
  });
});

describe("un reintento no crea otro pedido (kapta_request_id + kapta_request_hash)", () => {
  const run = (shop: ReturnType<typeof fakeWooShop>, over: Partial<WooSaleInput> = {}) => {
    const { body, expected } = buildWooSaleOrder(saleInput(over));
    return createWooSaleOrder({ client: client(shop.fetchImpl), body, expected, requestId: REQ, now: () => NOW.getTime(), log: silent });
  };
  const paths = (shop: ReturnType<typeof fakeWooShop>) => shop.calls.map((c) => `${c.method} ${c.path}`);
  const TRES = [{ ...VENTA[0]!, quantity: 3 }, VENTA[1]!, VENTA[2]!];

  it("el mismo intento después de salir bien: adopta el pedido, sin POST", async () => {
    const shop = fakeWooShop({ products: CATALOG, now: () => NOW });
    expect((await run(shop)).kind).toBe("created");
    shop.calls.length = 0;
    const again = await run(shop);
    expect(again.kind).toBe("adopted");
    expect(paths(shop)).toEqual(["GET /orders", "GET /orders/501"]);
    expect(shop.orders.size).toBe(1);
  });

  it("el pedido del intento anterior está vivo pero la asesora cambió el formulario (1 → 3 unidades): conflicto, ni se adopta ni se crea otro", async () => {
    const shop = fakeWooShop({ products: CATALOG, now: () => NOW });
    expect((await run(shop)).kind).toBe("created");
    shop.calls.length = 0;
    const again = await run(shop, { lines: TRES });
    expect(again).toMatchObject({
      kind: "conflict",
      orderLabel: "#KP200501",
      lineas: [{ title: "EggMixer", sku: "EGG-1", motivo: "cantidad", pedido: 3, guardado: 1 }],
      desajustes: [],
    });
    expect(paths(shop)).toEqual(["GET /orders", "GET /orders/501"]);
    expect(shop.orders.size).toBe(1);
    expect(shop.orders.get(501)!.status).toBe("processing");
    if (again.kind !== "conflict") return;
    const r = wooConflictRejection({ orderLabel: again.orderLabel, lineas: again.lineas, desajustes: again.desajustes, currency: "PEN" });
    expect(r.error).toMatch(/^Pedido NO registrado: Este formulario ya creó el pedido #KP200501 en WooCommerce, y está vivo/);
    expect(r.error).toContain("«EggMixer» (ahora 3 unidades, en WooCommerce 1 unidad)");
    expect(r.error).toContain("anúlalo en WooCommerce");
    expect(r.note).toMatch(/^⛔ Venta NO registrada · /);
  });

  it("cambió solo la dirección: también es conflicto (la huella lo ve aunque los precios cuadren)", async () => {
    const shop = fakeWooShop({ products: CATALOG, now: () => NOW });
    await run(shop);
    const again = await run(shop, { address: { ...saleInput().address, address1: "Jr. Otro 456" } });
    expect(again).toMatchObject({ kind: "conflict", lineas: [], desajustes: [] });
    if (again.kind !== "conflict") return;
    expect(wooConflictRejection({ orderLabel: again.orderLabel, lineas: [], desajustes: [], currency: "PEN" }).error).toContain(
      "(la dirección, la nota, el descuento o los productos)",
    );
  });

  it("quedó pending de un intento con otro formulario: se borra y se crea el nuevo", async () => {
    const shop = fakeWooShop({ products: CATALOG, now: () => NOW, failOnce: { "PUT /orders/501": "timeout" } });
    expect(await run(shop)).toMatchObject({ kind: "error", cleanup: "kept_pending" });
    shop.calls.length = 0;
    const again = await run(shop, { lines: TRES });
    expect(again.kind).toBe("created");
    expect(paths(shop)).toEqual(["GET /orders", "GET /orders/501", "DELETE /orders/501", "POST /orders", "PUT /orders/502"]);
    expect([...shop.orders.keys()]).toEqual([502]);
  });

  it("…y si ese pending no se puede borrar, no se crea otro", async () => {
    const shop = fakeWooShop({
      products: CATALOG,
      now: () => NOW,
      failOnce: { "PUT /orders/501": "timeout" },
      failAlways: { "DELETE /orders/501": { status: 500 } },
    });
    await run(shop);
    shop.calls.length = 0;
    const again = await run(shop, { lines: TRES });
    expect(again).toMatchObject({ kind: "error", cleanup: null, orderLabel: "#KP200501" });
    expect((again as { message: string }).message).toContain("No se creó otro.");
    expect(shop.calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("el del intento anterior está anulado: se crea uno nuevo", async () => {
    const shop = fakeWooShop({ products: CATALOG, now: () => NOW });
    await run(shop);
    shop.orders.get(501)!.status = "cancelled";
    shop.calls.length = 0;
    const again = await run(shop, { lines: TRES });
    expect(again.kind).toBe("created");
    expect(paths(shop)).toEqual(["GET /orders", "POST /orders", "PUT /orders/502"]);
  });

  it("un pedido vivo del mismo intento sin huella (de antes, o de otra mano): no se adopta a ciegas", async () => {
    const shop = fakeWooShop({ products: CATALOG, now: () => NOW });
    await run(shop);
    const o = shop.orders.get(501)!;
    o.meta_data = o.meta_data.filter((m: { key: string }) => m.key !== "kapta_request_hash");
    expect((await run(shop)).kind).toBe("conflict");
  });

  it("otro intento (otro id) sí crea otro pedido", async () => {
    const shop = fakeWooShop({ products: CATALOG, now: () => NOW });
    const a = buildWooSaleOrder(saleInput());
    await createWooSaleOrder({ client: client(shop.fetchImpl), ...a, requestId: REQ, now: () => NOW.getTime(), log: silent });
    const b = buildWooSaleOrder(saleInput({ requestId: "otro-intento-0001" }));
    const out = await createWooSaleOrder({ client: client(shop.fetchImpl), ...b, requestId: "otro-intento-0001", now: () => NOW.getTime(), log: silent });
    expect(out.kind).toBe("created");
    expect(shop.orders.size).toBe(2);
  });

  it("findWooOrderByRequestId lee el metadato también oculto y sin importar mayúsculas", async () => {
    const shop = fakeWooShop({ products: CATALOG, now: () => NOW });
    shop.orders.set(900, { id: 900, status: "processing", number: "KP200900", date_created_gmt: "2026-10-27T19:59:00", meta_data: [{ key: "_Kapta_Request_Id", value: REQ }] });
    const found = await findWooOrderByRequestId(client(shop.fetchImpl), REQ, NOW.getTime());
    expect(found?.id).toBe(900);
    expect(await findWooOrderByRequestId(client(shop.fetchImpl), "no-esta-0000", NOW.getTime())).toBeNull();
  });

  it("el id del intento: solo letras, dígitos y guiones, de 8 a 64", () => {
    expect(normalizeWooRequestId(REQ)).toBe(REQ);
    expect(normalizeWooRequestId("corto")).toBeNull();
    expect(normalizeWooRequestId("x".repeat(65))).toBeNull();
    expect(normalizeWooRequestId("a<script>b123")).toBeNull();
    expect(normalizeWooRequestId(undefined)).toBeNull();
  });
});

describe("el reloj de la venta (WOO_SALE_BUDGET_MS)", () => {
  it("cada llamada espera como mucho lo que queda: si se acaba tras un PUT sin respuesta, no se relee ni se borra", async () => {
    let t = 0;
    // Cada llamada se lleva 20 s del reloj: buscar (0→20), crear (20→40), PUT (40→60).
    const shop = fakeWooShop({ products: CATALOG, now: () => NOW, failOnce: { "PUT /orders/501": "timeout" }, onCall: () => (t += 20_000) });
    const { body, expected } = buildWooSaleOrder(saleInput());
    const out = await createWooSaleOrder({ client: client(shop.fetchImpl), body, expected, requestId: REQ, now: () => NOW.getTime(), clock: () => t, log: silent });
    expect(out).toMatchObject({ kind: "error", cleanup: "unknown" });
    expect(shop.calls.map((c) => `${c.method} ${c.path}`)).toEqual(["GET /orders", "POST /orders", "PUT /orders/501"]);
  });

  it("si no queda el tope entero del POST, no se crea nada (un POST cortado es el que deja pedidos huérfanos)", async () => {
    let t = 0;
    const shop = fakeWooShop({ products: CATALOG, now: () => NOW, onCall: () => (t += WOO_SALE_BUDGET_MS - WOO_SALE_TIMEOUTS.create + 1) });
    const { body, expected } = buildWooSaleOrder(saleInput());
    const out = await createWooSaleOrder({ client: client(shop.fetchImpl), body, expected, requestId: REQ, now: () => NOW.getTime(), clock: () => t, log: silent });
    expect(out).toMatchObject({ kind: "error", cleanup: null });
    expect(shop.calls.some((c) => c.method === "POST")).toBe(false);
  });
});

describe("una clave de solo lectura se dice como tal", () => {
  it("401 «does not have write permissions» → «de solo lectura», no «clave mal copiada»", () => {
    const e = wooErrorFromResponse(401, {
      code: "woocommerce_rest_authentication_error",
      message: "The API key provided does not have write permissions.",
    });
    expect(e).toBeInstanceOf(WooError);
    expect(e.kind).toBe("permisos");
    expect(e.message).toMatch(/^La clave de la API de WooCommerce es de solo lectura \(HTTP 401\)/);
    expect(e.message).toContain("«Lectura/Escritura»");
    // La clave mal copiada sigue diciéndose igual que antes.
    expect(wooErrorFromResponse(401, { code: "woocommerce_rest_authentication_error", message: "Consumer key is invalid." }).message).toMatch(
      /^WooCommerce rechazó la Consumer key o el Consumer secret/,
    );
  });
});

describe("la comparación (wooSaleMismatches)", () => {
  const { expected } = buildWooSaleOrder(saleInput());
  const ok = () => ({
    line_items: [
      { product_id: 10, variation_id: 0, sku: "EGG-1", quantity: 1, subtotal: "89.00", total: "89.00" },
      { product_id: 11, variation_id: 0, sku: "PAPEL-1", quantity: 1, subtotal: "0.00", total: "0.00" },
      { product_id: 20, variation_id: 21, sku: "POLO-M", quantity: 2, subtotal: "119.80", total: "119.80" },
    ],
    shipping_total: "0.00",
    fee_lines: [],
    total: "208.80",
    total_tax: "0.00",
  });

  it("lo pactado: nada", () => {
    expect(wooSaleMismatches(expected, ok())).toEqual({ lineas: [], desajustes: [] });
  });

  it("un cargo (fee) o un envío cobrados: desajuste", () => {
    const o = { ...ok(), shipping_total: "10.00", fee_lines: [{ name: "Recargo contraentrega", total: "5.00" }] };
    expect(wooSaleMismatches(expected, o).desajustes).toEqual([
      { title: "Envío", pedido: 0, aplicado: 10 },
      { title: "Recargo contraentrega", pedido: 0, aplicado: 5 },
    ]);
  });

  it("el total que nada explica: desajuste del total", () => {
    expect(wooSaleMismatches(expected, { ...ok(), total: "210.00" }).desajustes).toEqual([
      { title: "Total del pedido", pedido: 208.8, aplicado: 210 },
    ]);
  });

  it("una línea de menos: problema de línea", () => {
    const o = ok();
    o.line_items.pop();
    expect(wooSaleMismatches(expected, o).lineas).toEqual([{ title: "Polo · M", sku: "POLO-M", motivo: "sin_linea" }]);
  });
});

describe("el buscador (searchWooCatalog)", () => {
  const manyVariations = (count: number) => [
    { id: 20, name: "CloudSlides", sku: "", price: "89", type: "variable" as const },
    ...Array.from({ length: count }, (_, i) => ({
      id: 1_000 + i, name: "", sku: `CLOUD-${i}`, price: "89", stock: i % 3,
      type: "variation" as const, parentId: 20,
      attributes: [{ name: "Talla", option: i >= 55 && i < 66 ? "38-39" : "40-41" }, { name: "Color", option: `Color ${i}` }],
    })),
  ];

  it("CloudSlides: incluye las 66 variantes y los 11 colores38–39 que quedaban detrás del corte50", async () => {
    const shop = fakeWooShop({ products: manyVariations(66) });
    const r = await searchWooCatalog(client(shop.fetchImpl), { query: "CloudSlides" });
    expect(r[0]!.variants).toHaveLength(66);
    expect(r[0]!.variants.filter((v) => v.variantTitle.startsWith("38-39 /"))).toHaveLength(11);
    expect(r[0]!.variants.at(-1)).toMatchObject({ variantId: "woo:1065", sku: "CLOUD-65", price: 89, inventory: 2 });
  });

  it("recorre más de100 variantes sin omitir ni duplicar las páginas siguientes", async () => {
    const shop = fakeWooShop({ products: manyVariations(125) });
    const r = await searchWooCatalog(client(shop.fetchImpl), { query: "CloudSlides" });
    expect(r[0]!.variants).toHaveLength(125);
    expect(new Set(r[0]!.variants.map((v) => v.variantId)).size).toBe(125);
    const pages = shop.calls.filter((c) => c.path === "/products/20/variations");
    expect(pages.map((c) => c.query.get("page"))).toEqual(["1", "2"]);
    expect(pages.every((c) => c.query.get("per_page") === "100")).toBe(true);
  });

  it("si falla una página posterior no ofrece el producto con una lista truncada", async () => {
    const shop = fakeWooShop({ products: manyVariations(125) });
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      const parsed = new URL(String(url));
      if (parsed.pathname.endsWith("/products/20/variations") && parsed.searchParams.get("page") === "2") {
        return new Response(JSON.stringify({ code: "server_error" }), { status: 503 });
      }
      return shop.fetchImpl(url, init);
    }) as typeof fetch;
    expect(await searchWooCatalog(client(fetchImpl), { query: "CloudSlides" })).toEqual([]);
  });

  it("respeta el presupuesto de tiempo sin publicar la primera página como catálogo completo", async () => {
    let clock = 0;
    const shop = fakeWooShop({ products: manyVariations(125), onCall: (c) => { if (c.path === "/products/20/variations") clock = 10_001; } });
    expect(await searchWooCatalog(client(shop.fetchImpl), { query: "CloudSlides", now: () => clock })).toEqual([]);
    expect(shop.calls.filter((c) => c.path.endsWith("/variations"))).toHaveLength(1);
  });

  it("un catálogo por encima del límite seguro no se devuelve recortado", async () => {
    const shop = fakeWooShop({ products: manyVariations(1_001) });
    expect(await searchWooCatalog(client(shop.fetchImpl), { query: "CloudSlides" })).toEqual([]);
  });

  it("devuelve la forma de Shopify: producto, variantes con SKU, precio, stock e imagen; ids woo:", async () => {
    const shop = fakeWooShop({ products: CATALOG });
    const r = await searchWooCatalog(client(shop.fetchImpl), { query: "r" });
    expect(r).toEqual([
      {
        productId: "woo:10",
        title: "EggMixer",
        imageUrl: "https://kenku.pe/wp-content/uploads/egg.jpg",
        variants: [{ variantId: "woo:10", variantTitle: "", price: 89, inventory: 7, sku: "EGG-1" }],
      },
      {
        productId: "woo:11",
        title: "Papel Freidora",
        imageUrl: null,
        variants: [{ variantId: "woo:11", variantTitle: "", price: 79, inventory: null, sku: "PAPEL-1" }],
      },
      {
        productId: "woo:20",
        title: "Polo & Short",
        imageUrl: "https://kenku.pe/wp-content/uploads/polo.jpg",
        variants: [
          { variantId: "woo:21", variantTitle: "M", price: 59.9, inventory: 3, sku: "POLO-M" },
          // Sin SKU propio (WooCommerce muestra el del padre): sin SKU, se frena al generar.
          { variantId: "woo:22", variantTitle: "L", price: 59.9, inventory: null, sku: null },
        ],
      },
    ]);
    // Agrupados fuera; el padre variable no es una variante.
    expect(JSON.stringify(r)).not.toContain("PACK");
    const products = shop.calls.find((c) => c.path === "/products" && c.query.get("search"))!;
    expect(products.query.get("status")).toBe("publish");
    expect(products.query.get("per_page")).toBe("12");
    expect(products.query.get("_fields")).toBe("id,name,type,status,sku,price,stock_quantity,images,parent_id,attributes");
    const variations = shop.calls.find((c) => c.path === "/products/20/variations")!;
    expect(variations.query.get("status")).toBe("publish");
  });

  it("lo escrito sin espacios se busca también como SKU exacto, primero", async () => {
    const shop = fakeWooShop({ products: CATALOG });
    const r = await searchWooCatalog(client(shop.fetchImpl), { query: "PAPEL-1" });
    expect(r.map((p) => p.productId)).toEqual(["woo:11"]);
    expect(shop.calls.some((c) => c.query.get("sku") === "PAPEL-1")).toBe(true);
  });

  it("pegar el SKU de una variación la encuentra (con sku, WooCommerce trae variaciones), con el nombre y la foto de su producto", async () => {
    const shop = fakeWooShop({ products: CATALOG });
    const r = await searchWooCatalog(client(shop.fetchImpl), { query: "POLO-M" });
    expect(r).toEqual([
      {
        productId: "woo:20",
        title: "Polo & Short",
        imageUrl: "https://kenku.pe/wp-content/uploads/polo.jpg",
        variants: [{ variantId: "woo:21", variantTitle: "M", price: 59.9, inventory: 3, sku: "POLO-M" }],
      },
    ]);
    const parent = shop.calls.find((c) => c.path === "/products" && c.query.get("include"))!;
    expect(parent.query.get("include")).toBe("20");
    expect(parent.query.get("_fields")).toBe("id,name,images");
  });

  it("si el producto variable también salió, la variación va con él y no aparte", async () => {
    const shop = fakeWooShop({
      products: [...CATALOG, { id: 23, name: "", sku: "polo", price: "59.90", type: "variation", parentId: 20, attributes: [{ name: "Talla", option: "S" }] }],
    });
    // «polo» es el SKU de la talla S y también está en el nombre del producto 20.
    const r = await searchWooCatalog(client(shop.fetchImpl), { query: "polo" });
    expect(r.map((p) => p.productId)).toEqual(["woo:20"]);
    expect(r[0]!.variants.map((v) => v.variantId)).toEqual(["woo:21", "woo:22", "woo:23"]);
  });

  it("acotado: como mucho WOO_SEARCH_MAX_PRODUCTS productos aunque pidan más", async () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ id: 100 + i, name: `Polo ${i}`, sku: `P${i}`, price: "10", type: "simple" as const }));
    const shop = fakeWooShop({ products: many });
    // El falso no pagina: la tienda devuelve lo que se pidió, y el buscador corta igual.
    const r = await searchWooCatalog(client(shop.fetchImpl), { query: "polo", first: 20 });
    expect(r.length).toBeLessThanOrEqual(12);
  });

  it("WooCommerce caído: lanza (quien llama devuelve [])", async () => {
    const shop = fakeWooShop({ products: CATALOG, failAlways: { "GET /products": { status: 503 } } });
    await expect(searchWooCatalog(client(shop.fetchImpl), { query: "polo largo" })).rejects.toThrow();
  });

  it("la lista plana del selector de stock: «Producto · Variante»", () => {
    expect(
      flattenCatalog([
        { productId: "woo:20", title: "Polo", imageUrl: null, variants: [{ variantId: "woo:21", variantTitle: "M", price: 59.9, inventory: 3, sku: "POLO-M" }] },
      ]),
    ).toEqual([{ variantId: "woo:21", title: "Polo · M", price: 59.9, inventory: 3, sku: "POLO-M", imageUrl: null }]);
  });

  it("los ids de WooCommerce nunca se confunden con los de Shopify", () => {
    expect(parseWooVariantRef("woo:21")).toBe(21);
    expect(parseWooVariantRef("gid://shopify/ProductVariant/21")).toBeNull();
    expect(parseWooVariantRef("21")).toBeNull();
    expect(wooOrderAdminUrl("https://kenku.pe/", 501)).toBe("https://kenku.pe/wp-admin/admin.php?page=wc-orders&action=edit&id=501");
  });
});

describe("dónde manda stores.platform (loadStoreOrderPlatform)", () => {
  const STORE = "11111111-1111-4111-8111-111111111111";
  const row = (over: Record<string, unknown> = {}) => ({
    id: STORE,
    status: "active",
    timezone: "America/Lima",
    platform: "shopify",
    woo_site_url: SITE,
    woo_site_key: "kp",
    woo_consumer_key_enc: encrypt(CK),
    woo_consumer_secret_enc: encrypt(CS),
    woo_webhook_secret_enc: null,
    woo_last_error: null,
    ...over,
  });

  it("shopify (todas hoy): Shopify, aunque tenga las claves de WooCommerce guardadas", async () => {
    const db = new FakeDb({ stores: [row()] });
    expect(await loadStoreOrderPlatform(db.client(), STORE)).toEqual({ ok: true, platform: "shopify" });
  });

  it("woocommerce con las claves: WooCommerce, con las claves descifradas solo en el servidor", async () => {
    const db = new FakeDb({ stores: [row({ platform: "woocommerce" })] });
    const r = await loadStoreOrderPlatform(db.client(), STORE);
    expect(r).toMatchObject({ ok: true, platform: "woocommerce", creds: { siteUrl: SITE, siteKey: "kp", consumerKey: CK } });
  });

  it("woocommerce con una clave que no se descifra: error, nunca Shopify en silencio", async () => {
    const db = new FakeDb({ stores: [row({ platform: "woocommerce", woo_consumer_secret_enc: "basura" })] });
    const r = await loadStoreOrderPlatform(db.client(), STORE);
    expect(r.ok).toBe(false);
  });

  it("sin la 0274 (no existe la columna): Shopify; otra falla de la base: error", async () => {
    const db = new FakeDb({ stores: [row()] });
    db.failOn = () => ({ code: "42703", message: "column stores.platform does not exist" });
    expect(await loadStoreOrderPlatform(db.client(), STORE)).toEqual({ ok: true, platform: "shopify" });
    db.failOn = () => ({ message: "canceling statement due to statement timeout" });
    expect((await loadStoreOrderPlatform(db.client(), STORE)).ok).toBe(false);
  });
});
