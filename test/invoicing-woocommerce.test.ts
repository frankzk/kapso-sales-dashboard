// La boleta de un pedido de WooCommerce (MOM §35.11): la lectura en la API de
// WooCommerce justo antes de emitir, con las mismas garantías que la de Shopify.
//
// Lo que se fija: los ítems salen al céntimo y suman el total de WooCommerce;
// ante la duda —anulado, reembolsado, otra moneda, impuestos, un regalo a S/ 0,
// un cargo suelto, un detalle que no cuadra, un dato ilegible, otro pedido— no
// hay boleta y queda el motivo; un prepago web de WooCommerce nunca se da por
// cobrado; el pedido se lee con las claves de la tienda y nunca se le pregunta a
// Shopify ni a la foto (§35.10); y un pedido de Shopify se lee exactamente como
// antes. Sin red: `fetch` y la base son dobles. Los pedidos son el del ensayo de
// Aurela del 24-10-2026 (test/woocommerce-cod-core-order.test.ts), con la
// clienta ya cambiada por datos de prueba.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  process.env.ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
  return {};
});
void h;

import { encrypt } from "@/lib/crypto";
import {
  INVOICE_REASON_LABEL,
  WOO_INVOICE_REASON_LABEL,
  invoiceReasonLabel,
  type InvoiceReason,
} from "@/lib/invoicing/rules";
import { fetchOrderForInvoice, webPrepaidConfirmed, type InvoiceOrderRead } from "@/lib/invoicing/shopify-order";
import {
  WOO_INVOICE_MAX_LINES,
  WOO_PREPAID_UNCONFIRMED_DETAIL,
  mapWooOrderForInvoice,
} from "@/lib/invoicing/woocommerce-order";

const AURELA = "4c6522f9-c775-4be3-95b0-160a3c16d27a";
const ID = { siteKey: "aur", wooId: "11075" };
const CK = "ck_0123456789abcdef0123456789abcdef01234567";
const CS = "cs_0123456789abcdef0123456789abcdef01234567";
const SHOPIFY_TOKEN = "shpat_secreto_de_prueba_0000000000";

type Json = Record<string, unknown>;

/** Una línea de WooCommerce sin impuestos, como las de Aurela. */
function linea(over: Json): Json {
  return {
    id: 1,
    name: "Producto",
    product_id: 100,
    variation_id: 0,
    quantity: 1,
    subtotal: "10.00",
    subtotal_tax: "0.00",
    total: "10.00",
    total_tax: "0.00",
    sku: "SKU-1",
    price: 10,
    meta_data: [],
    ...over,
  };
}

/**
 * El pedido #AUR900003 del ensayo (COD Core), sin el regalo a S/ 0: el pack
 * 3 + 2 a 67.40 la unidad y tres ofertas. Suma 484.80, el total del pedido.
 */
function pedido(over: Json = {}): Json {
  return {
    id: 11075,
    parent_id: 0,
    status: "cod-pending",
    currency: "PEN",
    prices_include_tax: false,
    date_created_gmt: "2026-10-24T17:04:16",
    date_modified_gmt: "2026-10-24T17:05:27",
    discount_total: "0.00",
    discount_tax: "0.00",
    shipping_total: "0.00",
    shipping_tax: "0.00",
    cart_tax: "0.00",
    total: "484.80",
    total_tax: "0.00",
    billing: { first_name: "Clienta", last_name: "De Prueba", phone: "+51987654321", email: "" },
    shipping: { first_name: "Clienta", last_name: "De Prueba", phone: "+51987654321" },
    payment_method: "cod",
    payment_method_title: "Pago contra entrega",
    transaction_id: "",
    created_via: "cod-core-form",
    number: "AUR900003",
    line_items: [
      linea({ id: 6, name: "Bividi Camiseta de Alta Compresión", product_id: 10405, variation_id: 10415, quantity: 5, subtotal: "337.00", total: "337.00", sku: "36710849", price: 67.4 }),
      linea({ id: 9, name: "Rodillera X Pro", product_id: 1920, subtotal: "40.00", total: "40.00", sku: "81852859", price: 40 }),
      linea({ id: 10, name: "Guantes de Compresión Suave", product_id: 3811, variation_id: 3820, subtotal: "45.50", total: "45.50", sku: "818532661", price: 45.5 }),
      linea({ id: 11, name: "Pack de 10 Pares de Calcetines Tribal", product_id: 9916, subtotal: "62.30", total: "62.30", sku: "96258884", price: 62.3 }),
    ],
    tax_lines: [],
    shipping_lines: [{ id: 8, method_title: "Envío gratis", method_id: "free_shipping", total: "0.00", total_tax: "0.00" }],
    fee_lines: [],
    coupon_lines: [],
    refunds: [],
    ...over,
  };
}

/** El regalo del pack «3 + 2 gratis», tal como lo guarda COD Core: a S/ 0. */
const REGALO = linea({ id: 7, name: "Tobillera X Pro", product_id: 1386, quantity: 2, subtotal: "0.00", total: "0.00", sku: "25652067", price: 0 });

function ok(read: InvoiceOrderRead): Extract<InvoiceOrderRead, { ok: true }> {
  if (!read.ok) throw new Error(`se esperaba una lectura buena, vino ${read.reason}: ${read.detail ?? ""}`);
  return read;
}

const sum = (read: Extract<InvoiceOrderRead, { ok: true }>) => read.items.reduce((s, i) => s + i.priceCents * i.qty, 0);

describe("mapWooOrderForInvoice: los ítems al céntimo (MOM §35.11)", () => {
  it("el pedido del ensayo sin el regalo: un ítem por línea, con su SKU, y suma el total", () => {
    const read = ok(mapWooOrderForInvoice(pedido(), ID));
    expect(read).toMatchObject({ orderGid: "wc-aur-11075", name: "#AUR900003", totalCents: 48_480 });
    expect(read.items).toEqual([
      { code: "36710849", name: "Bividi Camiseta de Alta Compresión", qty: 5, priceCents: 6_740 },
      { code: "81852859", name: "Rodillera X Pro", qty: 1, priceCents: 4_000 },
      { code: "818532661", name: "Guantes de Compresión Suave", qty: 1, priceCents: 4_550 },
      { code: "96258884", name: "Pack de 10 Pares de Calcetines Tribal", qty: 1, priceCents: 6_230 },
    ]);
    expect(sum(read)).toBe(48_480);
    // Nada de la clienta en lo que sale de aquí.
    expect(JSON.stringify(read)).not.toMatch(/Clienta|987654321/);
  });

  it("con el regalo a S/ 0 del pack «3 + 2 gratis», como lo manda COD Core: `linea_gratuita`", () => {
    const lines = [...(pedido().line_items as Json[])];
    lines.splice(1, 0, REGALO);
    expect(mapWooOrderForInvoice(pedido({ line_items: lines }), ID)).toEqual({
      ok: false,
      reason: "linea_gratuita",
      detail: "Línea «Tobillera X Pro».",
    });
  });

  it("un cupón ya está dentro de `total`: la neta que no se divide exacto se parte en dos ítems de un céntimo de diferencia", () => {
    const read = ok(
      mapWooOrderForInvoice(
        pedido({
          total: "100.00",
          discount_total: "20.00",
          line_items: [linea({ quantity: 3, subtotal: "120.00", total: "100.00", sku: "FAJA" })],
          coupon_lines: [{ id: 1, code: "promo", discount: "20.00", discount_tax: "0.00" }],
        }),
        ID,
      ),
    );
    expect(read.items).toEqual([
      { code: "FAJA", name: "Producto", qty: 2, priceCents: 3_333 },
      { code: "FAJA", name: "Producto", qty: 1, priceCents: 3_334 },
    ]);
    expect(sum(read)).toBe(10_000);
  });

  it("el envío cobrado es un ítem «Servicio de envío»; el gratis no va", () => {
    const read = ok(
      mapWooOrderForInvoice(
        pedido({
          total: "494.80",
          shipping_total: "10.00",
          shipping_lines: [
            { id: 8, method_title: "Envío a provincia", method_id: "flat_rate", total: "10.00", total_tax: "0.00" },
            { id: 9, method_title: "Envío gratis", method_id: "free_shipping", total: "0.00", total_tax: "0.00" },
          ],
        }),
        ID,
      ),
    );
    expect(read.items.at(-1)).toEqual({ code: "ENVIO", name: "Servicio de envío - Envío a provincia", qty: 1, priceCents: 1_000 });
    expect(read.items.filter((i) => i.code === "ENVIO")).toHaveLength(1);
    expect(sum(read)).toBe(49_480);
  });

  it("sin SKU, el código es la variación, el producto o la línea", () => {
    const read = ok(
      mapWooOrderForInvoice(
        pedido({
          total: "30.00",
          line_items: [
            linea({ id: 1, sku: "", product_id: 5, variation_id: 6 }),
            linea({ id: 2, sku: "", product_id: 5, variation_id: 0 }),
            linea({ id: 3, sku: null, product_id: 0, variation_id: 0 }),
          ],
        }),
        ID,
      ),
    );
    expect(read.items.map((i) => i.code)).toEqual(["V6", "P5", "L3"]);
  });

  it("«processing» y «completed» se emiten igual: el estado de WooCommerce no dice si se cobró", () => {
    for (const status of ["processing", "completed", "on-hold", "wc-cod-pending"]) {
      expect(mapWooOrderForInvoice(pedido({ status }), ID).ok, status).toBe(true);
    }
  });
});

describe("mapWooOrderForInvoice: ante la duda, no hay boleta", () => {
  const casos: Array<[string, Json, InvoiceReason, RegExp | null]> = [
    ["anulado", { status: "cancelled" }, "anulado", null],
    ["en la papelera", { status: "trash" }, "anulado", null],
    ["reembolsado", { status: "refunded" }, "reembolsado", null],
    ["con un reembolso parcial", { status: "processing", refunds: [{ id: 3, reason: "", total: "-10.00" }] }, "reembolsado", null],
    ["pendiente de pago", { status: "pending" }, "no_encontrado", /«pending».*no es un pedido vivo/],
    ["fallido", { status: "failed" }, "no_encontrado", /«failed»/],
    ["en otra moneda", { currency: "USD" }, "moneda", /WooCommerce lo cobra en USD/],
    ["sin moneda", { currency: null }, "moneda", null],
    ["con impuesto en el pedido", { total_tax: "87.27" }, "impuesto_encima", /calculó impuestos/],
    ["con una línea de impuesto", { tax_lines: [{ id: 1, rate_code: "PE-IGV-1", tax_total: "0.00" }] }, "impuesto_encima", null],
    ["con impuesto en una línea", { line_items: [linea({ total: "484.80", subtotal: "484.80", total_tax: "1.00" })] }, "impuesto_encima", null],
    ["con impuesto en el envío", { shipping_lines: [{ id: 8, method_title: "x", total: "0.00", total_tax: "1.80" }] }, "impuesto_encima", null],
    ["con un cargo suelto", { total: "494.80", fee_lines: [{ id: 1, name: "Cargo contraentrega", total: "10.00", total_tax: "0.00" }] }, "no_cuadra", /cargo suelto.*Cargo contraentrega/],
    ["con un descuento como cargo negativo", { total: "474.80", fee_lines: [{ id: 1, name: "Descuento", total: "-10.00", total_tax: "0.00" }] }, "no_cuadra", /cargo suelto/],
    ["sin líneas", { line_items: [] }, "no_cuadra", /ninguna línea/],
    ["con más de 100 líneas", { line_items: Array.from({ length: WOO_INVOICE_MAX_LINES + 1 }, (_, i) => linea({ id: i + 1 })) }, "demasiadas_lineas", null],
    ["cuyo detalle no suma el total", { total: "500.00" }, "no_cuadra", /suma S\/ 484\.80; WooCommerce dice S\/ 500\.00/],
    ["con una línea que cuesta más que su precio", { line_items: [linea({ subtotal: "10.00", total: "484.80" })] }, "no_cuadra", /Cuesta más/],
    ["con una línea sin nombre", { total: "10.00", line_items: [linea({ name: "" })] }, "sin_boleta", /no tiene nombre/],
    ["con un monto ilegible", { total: "484,80" }, "lectura_fallida", /dato ilegible: total/],
    ["con fracción de céntimo", { total: "484.805" }, "lectura_fallida", /dato ilegible: total/],
    ["sin la lista de reembolsos", { refunds: undefined }, "lectura_fallida", /refunds/],
    ["sin el impuesto del pedido", { total_tax: null }, "lectura_fallida", /total_tax/],
    ["con una cantidad en cero", { line_items: [linea({ quantity: 0 })] }, "lectura_fallida", /quantity/],
    ["sin estado", { status: "" }, "lectura_fallida", /status/],
    ["de otro pedido", { id: 11076 }, "lectura_fallida", /otro pedido/],
  ];

  it.each(casos)("%s", (_caso, over, reason, detail) => {
    const read = mapWooOrderForInvoice(pedido(over), ID);
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.reason).toBe(reason);
    if (detail) expect(read.detail ?? "").toMatch(detail);
  });

  it("sin pedido, `no_encontrado`; con algo que no es un pedido, `lectura_fallida`", () => {
    expect(mapWooOrderForInvoice(null, ID)).toMatchObject({ ok: false, reason: "no_encontrado" });
    expect(mapWooOrderForInvoice("hola", ID)).toMatchObject({ ok: false, reason: "lectura_fallida" });
    expect(mapWooOrderForInvoice([], ID)).toMatchObject({ ok: false, reason: "lectura_fallida" });
  });
});

describe("el prepago web de WooCommerce no se da por cobrado (§35.11)", () => {
  const flow = pedido({
    status: "processing",
    payment_method: "flowpayment",
    payment_method_title: "Tarjeta o Yape",
    transaction_id: "FLOW-0001",
    date_paid_gmt: "2026-10-24T17:06:00",
  });

  it("pagado, de Flow y sin reembolsos: los ítems salen, pero `webPrepaidConfirmed` dice que no", () => {
    const read = ok(mapWooOrderForInvoice(flow, ID));
    expect(read.payment).toEqual({
      financialStatus: "processing",
      gatewayNames: ["Tarjeta o Yape"],
      paidCents: 0,
      otherPaidCents: 0,
      netPaymentCents: 0,
      outstandingCents: 48_480,
    });
    expect(webPrepaidConfirmed(read)).toBe(false);
    // Aunque alguien le pusiera los montos de Shopify, una lectura de WooCommerce no confirma.
    expect(
      webPrepaidConfirmed({
        ...read,
        woocommerce: { readAt: "2026-10-25T01:00:00.000Z" },
        payment: { financialStatus: "PAID", gatewayNames: ["Tarjeta o Yape"], paidCents: 48_480, otherPaidCents: 0, netPaymentCents: 48_480, outstandingCents: 0 },
      }),
    ).toBe(false);
    expect(WOO_PREPAID_UNCONFIRMED_DETAIL).toContain("no lleva boleta automática");
  });
});

// ── fetchOrderForInvoice con `platform: "woocommerce"` ───────────────────────

interface Answer {
  data: unknown;
  error: unknown;
}

/** La base: la fila de `stores` y lo que se lea de cualquier otra tabla (nada). */
function fakeAdmin(store: Answer) {
  const reads: { table: string; columns: string; filters: [string, unknown][] }[] = [];
  const admin = {
    from(table: string) {
      const read = { table, columns: "", filters: [] as [string, unknown][] };
      reads.push(read);
      const answer = table === "stores" ? store : { data: null, error: null };
      const q = {
        select(columns: string) {
          read.columns = columns;
          return q;
        },
        eq(column: string, value: unknown) {
          read.filters.push([column, value]);
          return q;
        },
        maybeSingle: async () => answer,
        single: async () => answer,
      };
      return q;
    },
  } as unknown as SupabaseClient;
  return { admin, reads };
}

/** Aurela como está guardada: Shopify con token (todavía vivo) y WooCommerce con sus claves. */
function aurela(over: Json = {}): Answer {
  return {
    data: {
      id: AURELA,
      status: "active",
      timezone: "America/Lima",
      platform: "shopify",
      shopify_domain: "aurela-peru.myshopify.com",
      shopify_token_enc: encrypt(SHOPIFY_TOKEN),
      woo_site_url: "https://aurela.pe",
      woo_site_key: "aur",
      woo_consumer_key_enc: encrypt(CK),
      woo_consumer_secret_enc: encrypt(CS),
      woo_webhook_secret_enc: null,
      woo_intake_from: "2026-10-24T17:24:54.000Z",
      platform_switched_at: null,
      woo_last_error: null,
      ...over,
    },
    error: null,
  };
}

interface Call {
  url: string;
  headers: Record<string, string>;
}

function fakeFetch(respond: (url: string, n: number) => { status?: number; body: unknown } | Error) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, headers: Object.fromEntries(new Headers(init?.headers).entries()) });
    const r = respond(url, calls.length);
    if (r instanceof Error) throw r;
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const NOW = Date.parse("2026-10-30T15:00:00.000Z");

describe("fetchOrderForInvoice: un pedido de WooCommerce se lee en WooCommerce (§35.11)", () => {
  const input = { storeId: AURELA, shopifyOrderId: "wc-aur-11075", platform: "woocommerce" as const };

  it("GET /wp-json/wc/v3/orders/11075 con las claves de la tienda; nunca Shopify ni la foto", async () => {
    const { admin, reads } = fakeAdmin(aurela());
    const { fetchImpl, calls } = fakeFetch(() => ({ body: pedido() }));
    const read = ok(await fetchOrderForInvoice(input, { admin, fetchImpl, now: () => NOW }));
    expect(read.items).toHaveLength(4);
    expect(read.woocommerce).toEqual({ readAt: "2026-10-30T15:00:00.000Z" });
    expect(read.snapshot).toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://aurela.pe/wp-json/wc/v3/orders/11075");
    expect(calls[0]!.headers.authorization).toBe(`Basic ${Buffer.from(`${CK}:${CS}`).toString("base64")}`);
    // Ni Shopify (su token no se usa) ni la foto del pedido (§35.10).
    expect(calls.some((c) => /shopify/i.test(c.url))).toBe(false);
    expect(reads.map((r) => r.table)).toEqual(["stores"]);
    expect(reads[0]!.columns).not.toContain("shopify_token_enc");
  });

  it("el hosting que borra la cabecera Authorization: se reintenta una vez con las claves en la dirección", async () => {
    const { admin } = fakeAdmin(aurela());
    const { fetchImpl, calls } = fakeFetch((_url, n) =>
      n === 1 ? { status: 401, body: { code: "woocommerce_rest_cannot_view", message: "No puedes ver esto." } } : { body: pedido() },
    );
    expect((await fetchOrderForInvoice(input, { admin, fetchImpl })).ok).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.url).toContain("consumer_key=");
  });

  it.each<[string, Answer, InvoiceReason, RegExp | null]>([
    ["sin las claves de la API", aurela({ woo_consumer_key_enc: null }), "sin_claves_woo", null],
    ["sin la dirección del sitio", aurela({ woo_site_url: null }), "sin_claves_woo", null],
    ["con claves que no se descifran", aurela({ woo_consumer_secret_enc: "v1:basura" }), "sin_claves_woo", /no se pueden descifrar/],
    ["con otra clave del sitio", aurela({ woo_site_key: "kp" }), "no_encontrado", /otro sitio/],
    ["la tienda no se pudo leer", { data: null, error: { message: "caída" } }, "lectura_fallida", /conexión de la tienda con WooCommerce/],
    ["la tienda no existe", { data: null, error: null }, "lectura_fallida", /No se encontró la tienda/],
  ])("%s: %s, sin llamar a nadie", async (_caso, store, reason, detail) => {
    const { admin } = fakeAdmin(store);
    const { fetchImpl, calls } = fakeFetch(() => ({ body: pedido() }));
    const read = await fetchOrderForInvoice(input, { admin, fetchImpl });
    expect(read).toMatchObject({ ok: false, reason });
    if (detail && !read.ok) expect(read.detail ?? "").toMatch(detail);
    expect(calls).toEqual([]);
  });

  it("un id que no es de WooCommerce no se lee en ninguna parte", async () => {
    const { admin, reads } = fakeAdmin(aurela());
    const { fetchImpl, calls } = fakeFetch(() => ({ body: pedido() }));
    for (const id of ["11075", "gid://shopify/Order/11075", "wc-aur-0", "wc-AUR-11075", ""]) {
      expect(await fetchOrderForInvoice({ ...input, shopifyOrderId: id }, { admin, fetchImpl }), id).toMatchObject({
        ok: false,
        reason: "no_encontrado",
      });
    }
    expect(calls).toEqual([]);
    expect(reads).toEqual([]);
  });

  it.each<[string, { status?: number; body: unknown } | Error, InvoiceReason, RegExp]>([
    ["WooCommerce no lo tiene (404)", { status: 404, body: { code: "woocommerce_rest_shop_order_invalid_id", message: "ID no válido." } }, "no_encontrado", /HTTP 404/],
    ["la dirección no tiene la API", { status: 404, body: { code: "rest_no_route", message: "No route" } }, "lectura_fallida", /wp-json/],
    ["WooCommerce falla (500)", { status: 500, body: {} }, "lectura_fallida", /HTTP 500/],
    ["claves rechazadas (401)", { status: 401, body: { code: "woocommerce_rest_authentication_error", message: "Clave no válida." } }, "lectura_fallida", /HTTP 401/],
    ["la red", new TypeError("fetch failed"), "lectura_fallida", /./],
    ["una respuesta que no es un pedido", { body: [1, 2] }, "lectura_fallida", /no devolvió un pedido/],
  ])("%s → %s, y el motivo no lleva las claves", async (_caso, answer, reason, detail) => {
    const { admin } = fakeAdmin(aurela());
    const { fetchImpl } = fakeFetch(() => answer);
    const read = await fetchOrderForInvoice(input, { admin, fetchImpl });
    expect(read).toMatchObject({ ok: false, reason });
    if (!read.ok) expect(read.detail ?? "").toMatch(detail);
    const text = JSON.stringify(read);
    for (const secret of [CK, CS, SHOPIFY_TOKEN]) expect(text).not.toContain(secret);
  });

  it("los bloqueos del pedido llegan igual que del mapeo: anulado, reembolsado, regalo", async () => {
    const { admin } = fakeAdmin(aurela());
    for (const [over, reason] of [
      [{ status: "cancelled" }, "anulado"],
      [{ refunds: [{ id: 1, total: "-484.80" }] }, "reembolsado"],
      [{ line_items: [...(pedido().line_items as Json[]), REGALO] }, "linea_gratuita"],
    ] as const) {
      const { fetchImpl } = fakeFetch(() => ({ body: pedido(over as Json) }));
      expect(await fetchOrderForInvoice(input, { admin, fetchImpl })).toMatchObject({ ok: false, reason });
    }
  });
});

describe("un pedido de Shopify se lee exactamente como antes", () => {
  const SHOPIFY_ORDER = {
    data: {
      order: {
        id: "gid://shopify/Order/6001",
        name: "#KP143000",
        test: false,
        edited: false,
        cancelledAt: null,
        displayFinancialStatus: "PENDING",
        paymentGatewayNames: ["manual"],
        taxesIncluded: true,
        currencyCode: "PEN",
        totalPriceSet: { shopMoney: { amount: "150.00", currencyCode: "PEN" } },
        currentTotalPriceSet: { shopMoney: { amount: "150.00", currencyCode: "PEN" } },
        totalRefundedSet: { shopMoney: { amount: "0.00" } },
        netPaymentSet: { shopMoney: { amount: "0.00" } },
        totalOutstandingSet: { shopMoney: { amount: "150.00" } },
        totalTaxSet: { shopMoney: { amount: "22.88" } },
        totalTipReceivedSet: { shopMoney: { amount: "0.00" } },
        transactions: [],
        lineItems: {
          pageInfo: { hasNextPage: false },
          nodes: [
            {
              id: "gid://shopify/LineItem/1",
              title: "Faja Reductora",
              variantTitle: "M",
              sku: "FAJA-M",
              quantity: 1,
              currentQuantity: 1,
              isGiftCard: false,
              variant: { id: "gid://shopify/ProductVariant/9" },
              originalUnitPriceSet: { shopMoney: { amount: "150.00" } },
              discountAllocations: [],
            },
          ],
        },
        shippingLines: { nodes: [] },
      },
    },
  };

  it("sin `platform` y con `platform: \"shopify\"`: la misma llamada a Shopify y la misma lectura; WooCommerce no se toca", async () => {
    const results: unknown[] = [];
    const urls: string[][] = [];
    for (const platform of [undefined, "shopify" as const]) {
      const { admin, reads } = fakeAdmin({
        data: { shopify_domain: "kenku.myshopify.com", shopify_token_enc: encrypt(SHOPIFY_TOKEN) },
        error: null,
      });
      const { fetchImpl, calls } = fakeFetch(() => ({ body: SHOPIFY_ORDER }));
      results.push(
        await fetchOrderForInvoice(
          { storeId: "11111111-1111-4111-8111-111111111111", shopifyOrderId: "6001", ...(platform ? { platform } : {}) },
          { admin, fetchImpl },
        ),
      );
      urls.push(calls.map((c) => c.url));
      expect(reads.map((r) => r.table)).toEqual(["stores"]);
      expect(reads[0]!.columns).toBe("shopify_domain,shopify_token_enc,shopify_app");
    }
    expect(results[0]).toEqual(results[1]);
    expect(results[0]).toMatchObject({ ok: true, totalCents: 15_000, items: [{ code: "FAJA-M", name: "Faja Reductora - M", qty: 1, priceCents: 15_000 }] });
    expect(results[0]).not.toHaveProperty("woocommerce");
    expect(urls[0]).toEqual(urls[1]);
    expect(urls[0]![0]).toContain("kenku.myshopify.com/admin/api/");
  });
});

describe("las frases de un motivo según la plataforma del pedido", () => {
  it("de WooCommerce nombran a WooCommerce; de Shopify (o sin plataforma), las de siempre", () => {
    for (const reason of Object.keys(WOO_INVOICE_REASON_LABEL) as InvoiceReason[]) {
      expect(INVOICE_REASON_LABEL[reason], reason).toContain("Shopify");
      expect(invoiceReasonLabel(reason, "woocommerce"), reason).toContain("WooCommerce");
      expect(invoiceReasonLabel(reason, "woocommerce"), reason).not.toContain("Shopify");
      expect(invoiceReasonLabel(reason, "shopify")).toBe(INVOICE_REASON_LABEL[reason]);
      expect(invoiceReasonLabel(reason)).toBe(INVOICE_REASON_LABEL[reason]);
    }
    // Los que no nombran una plataforma se dicen igual.
    expect(invoiceReasonLabel("anulado", "woocommerce")).toBe(INVOICE_REASON_LABEL.anulado);
    expect(invoiceReasonLabel("sin_claves_woo")).toBe("La tienda no tiene las claves de la API de WooCommerce.");
  });
});

describe("MOM §35.11: la regla está escrita", () => {
  const mom = readFileSync(resolve(process.cwd(), "docs/mom/master-pedidos-v1.md"), "utf8");
  const desde = mom.indexOf("### 35.11 La boleta de un pedido de WooCommerce (25-10-2026)");
  const s = mom.slice(desde, mom.indexOf("\n## 36.", desde)).replace(/\s+/g, " ");

  it("existe, dentro de §35, y dice de dónde lee y por qué no de `raw`", () => {
    expect(desde).toBeGreaterThan(mom.indexOf("### 35.10 "));
    expect(desde).toBeLessThan(mom.indexOf("## 36. "));
    expect(s).toContain("`GET /wp-json/wc/v3/orders/<id>`");
    expect(s).toContain("**No de `orders.raw.woo`:**");
    expect(s).toContain("`orders.platform` (§38.1), nunca la forma del id");
  });

  it("cada motivo de la tabla es un motivo del código, y `sin_claves_woo` va en la lista de 6 horas", () => {
    const tabla = s.slice(s.indexOf("**Lo que bloquea**"), s.indexOf("**Lo que WooCommerce no dice"));
    const codigos = [...tabla.matchAll(/\| `([a-z_]+)` \|/g)].map((m) => m[1]!);
    expect(codigos.length).toBeGreaterThanOrEqual(10);
    for (const c of codigos) expect(INVOICE_REASON_LABEL, c).toHaveProperty(c);
    expect(s).toContain("`sin_claves_woo` es el `sin_token_shopify` de WooCommerce");
  });

  it("lo que no se emite solo está en 35.9, como decisión pendiente", () => {
    const s9 = mom.slice(mom.indexOf("### 35.9 "), mom.indexOf("### 35.10 ")).replace(/\s+/g, " ");
    expect(s9).toContain("**Lo que la boleta de WooCommerce no emite sola (35.11). Decisiones pendientes del owner y del contador:**");
    expect(s).toContain("queda en `pago_web_no_confirmado`, con el porqué, y se emite a mano. Decisión pendiente del owner (35.9).");
  });

  it("las frases del MOM son las del código", () => {
    expect(s).toContain(`«${WOO_INVOICE_REASON_LABEL.total_distinto}»`);
    expect(s).toContain("«Espera a WooCommerce»");
    expect(s).toContain("«Se vuelve a revisar en unas horas, cuando la tienda tenga guardadas sus claves de la API de WooCommerce.»");
    expect(s).toContain("«Antes de emitir, el barrido vuelve a leer el pedido en WooCommerce.»");
    expect(s).toContain("`plataforma: \"woocommerce\"`");
    expect(s).toContain("(`lectura_woocommerce`)");
  });
});
