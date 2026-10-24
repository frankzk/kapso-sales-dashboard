// WooCommerce (MOM §38): el mapeador de un pedido de WooCommerce REST v3 a la
// misma fila de `orders` que hoy sale de Shopify, la firma de sus webhooks y su
// cliente REST. Los pedidos de prueba tienen la forma real de la API v3
// (`GET /wp-json/wc/v3/orders/{id}`, que es también el cuerpo de los webhooks
// `order.*`): montos como texto, fechas `*_gmt` sin zona, reembolsos en
// negativo, departamentos con los códigos de WooCommerce para Perú.

import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  WOO_CANCELLED_STATUSES,
  WOO_CHANNEL_TAGS,
  WOO_MAX_PER_PAGE,
  WOO_PREPAID_METHODS,
  WOO_SKIPPED_STATUSES,
  WooError,
  fetchWooOrder,
  fetchWooOrdersPage,
  isWooOrderIngestible,
  mapWooOrder,
  normalizeWooSiteUrl,
  parseWooOrderId,
  parseWooWebhookPing,
  toWooGmtParam,
  toWooPeruState,
  verifyWooSignature,
  wooErrorFromResponse,
  wooGmt,
  wooOrderId,
  wooPaginate,
  wooPeruStateName,
  wooRequest,
  type WooClientOpts,
  type WooOrder,
} from "@/lib/woocommerce";
import { extractNumericId, hasKapsoTag, mapRestOrder, mapGraphqlOrder } from "@/lib/shopify";
import { shopifyDepartamentoElegido, shopifyOrderNote, shopifyShippingAddress } from "@/lib/shopify-address";
import { orderTotals } from "@/lib/order-totals";
import { CHECKOUT_GATEWAYS, paymentGatewayOf } from "@/lib/payment-gateway";
import { salesChannel } from "@/lib/sales-channel";
import { limaRegionKind } from "@/lib/order-coverage";
import { isWebPrepaid } from "@/lib/order-paid";

const KENKU = { id: "dcab8bf5-0000-4000-8000-000000000001", woo_site_key: "kp" };
const AURELA = { id: "4c6522f9-0000-4000-8000-000000000002", woo_site_key: "aur" };

/**
 * Un pedido contraentrega de Lima Metropolitana hecho en el formulario COD de la
 * web, como lo devuelve WooCommerce 9.x con HPOS y el plugin de numeración.
 */
function codLimaOrder(): WooOrder {
  return {
    id: 1532,
    parent_id: 0,
    status: "processing",
    currency: "PEN",
    version: "9.3.3",
    prices_include_tax: true,
    date_created: "2026-10-27T21:14:09",
    date_modified: "2026-10-27T21:14:12",
    discount_total: "10.00",
    discount_tax: "0.00",
    shipping_total: "0.00",
    shipping_tax: "0.00",
    cart_tax: "0.00",
    total: "139.00",
    total_tax: "0.00",
    customer_id: 0,
    order_key: "wc_order_Xa1bC2dE3fG4h",
    billing: {
      first_name: "María",
      last_name: "Quispe Huamán",
      company: "",
      address_1: "Av. Los Próceres 1234",
      address_2: "Frente al parque, puerta verde",
      city: "Santiago de Surco",
      state: "LMA",
      postcode: "",
      country: "PE",
      email: "maria.quispe@example.com",
      phone: "987 654 321",
    },
    shipping: {
      first_name: "María",
      last_name: "Quispe Huamán",
      company: "",
      address_1: "Av. Los Próceres 1234",
      address_2: "Frente al parque, puerta verde",
      city: "Santiago de Surco",
      state: "LMA",
      postcode: "",
      country: "PE",
      phone: "",
    },
    payment_method: "cod",
    payment_method_title: "Pago contra entrega",
    transaction_id: "",
    customer_ip_address: "190.236.10.20",
    customer_user_agent: "Mozilla/5.0 (Linux; Android 14)",
    created_via: "checkout",
    customer_note: "Llamar antes de llegar, trabajo hasta las 6",
    date_completed: null,
    date_paid: "2026-10-27T16:14:12",
    cart_hash: "6f1f4b0b8a5a3e2c1d0e9f8a7b6c5d4e",
    number: "KP200001",
    meta_data: [
      { id: 9001, key: "kapta_channel", value: "web_formulario" },
      { id: 9002, key: "_wc_order_attribution_source_type", value: "utm" },
      { id: 9003, key: "_wc_order_attribution_utm_source", value: "facebook" },
      { id: 9004, key: "_wc_order_attribution_utm_medium", value: "paid" },
      { id: 9005, key: "_wc_order_attribution_utm_campaign", value: "120210000000000001" },
      { id: 9006, key: "_wc_order_attribution_utm_id", value: "120210000000000001" },
      { id: 9007, key: "_wc_order_attribution_user_agent", value: "Mozilla/5.0 (Linux; Android 14)" },
      { id: 9008, key: "is_vat_exempt", value: "no" },
    ],
    line_items: [
      {
        id: 301,
        name: "Zapatilla Urbana Kenku - 38, Negro",
        product_id: 4410,
        variation_id: 4415,
        quantity: 1,
        tax_class: "",
        subtotal: "149.00",
        subtotal_tax: "0.00",
        total: "139.00",
        total_tax: "0.00",
        taxes: [],
        meta_data: [
          { id: 3011, key: "pa_talla", value: "38", display_key: "Talla", display_value: "38" },
          { id: 3012, key: "pa_color", value: "negro", display_key: "Color", display_value: "Negro" },
          { id: 3013, key: "_reduced_stock", value: "1", display_key: "_reduced_stock", display_value: "1" },
        ],
        sku: "65359446",
        price: 139,
        image: { id: 4416, src: "https://kenku.pe/wp-content/uploads/2026/10/zapatilla-negro.jpg" },
        parent_name: "Zapatilla Urbana Kenku",
      },
    ],
    tax_lines: [],
    shipping_lines: [
      {
        id: 302,
        method_title: "Envío gratis",
        method_id: "free_shipping",
        total: "0.00",
        total_tax: "0.00",
      },
    ],
    fee_lines: [],
    coupon_lines: [{ id: 303, code: "kenku10", discount: "10.00", discount_tax: "0.00" }],
    refunds: [],
    payment_url: "https://kenku.pe/finalizar-compra/order-pay/1532/?pay_for_order=true&key=wc_order_Xa1bC2dE3fG4h",
    is_editable: false,
    needs_payment: false,
    needs_processing: true,
    date_created_gmt: "2026-10-28T02:14:09",
    date_modified_gmt: "2026-10-28T02:14:12",
    date_completed_gmt: null,
    date_paid_gmt: "2026-10-28T02:14:12",
    currency_symbol: "S/",
  } as unknown as WooOrder;
}

function withOverrides(base: WooOrder, over: Partial<WooOrder>): WooOrder {
  return { ...base, ...over };
}

/** Pagado con tarjeta por el plugin de Flow: llega en «processing» con `date_paid`. */
function flowCardOrder(title = "Flow - Tarjeta de crédito o débito"): WooOrder {
  return withOverrides(codLimaOrder(), {
    id: 1533,
    number: "KP200002",
    payment_method: "flowpayment",
    payment_method_title: title,
    transaction_id: "FLOW-88412211",
    meta_data: [],
    coupon_lines: [],
    discount_total: "0.00",
    total: "149.00",
  });
}

/** Transferencia bancaria: WooCommerce la deja «on-hold» hasta que alguien confirma. */
function bankTransferOrder(status = "on-hold"): WooOrder {
  return withOverrides(codLimaOrder(), {
    id: 1534,
    number: "KP200003",
    status,
    payment_method: "bacs",
    payment_method_title: "Transferencia bancaria directa",
    date_paid_gmt: status === "processing" ? "2026-10-28T03:00:00" : null,
    meta_data: [{ id: 1, key: "kapta_channel", value: "venta_manual" }],
  });
}

describe("id, nombre y fechas (MOM §38)", () => {
  it("el id lleva la clave del sitio: wc-<clave>-<id>", () => {
    expect(wooOrderId("kp", 1532)).toBe("wc-kp-1532");
    expect(wooOrderId("aur", "1532")).toBe("wc-aur-1532");
    // Los dos WordPress numeran desde 1: el mismo número no choca entre tiendas.
    const kp = mapWooOrder(codLimaOrder(), KENKU)!;
    const aur = mapWooOrder(codLimaOrder(), AURELA)!;
    expect(kp.shopify_order_id).toBe("wc-kp-1532");
    expect(aur.shopify_order_id).toBe("wc-aur-1532");
    expect(parseWooOrderId("wc-kp-1532")).toEqual({ siteKey: "kp", wooId: "1532" });
    expect(parseWooOrderId("7549608558887")).toBeNull();
    expect(parseWooOrderId("wc-KP-1532")).toBeNull();
  });

  it("la forma del id no basta para decidir: extractNumericId lo convierte en un número", () => {
    // Por eso se decide con orders.platform, que el mapeador llena.
    expect(extractNumericId("wc-kp-1532")).toBe("1532");
    expect(mapWooOrder(codLimaOrder(), KENKU)!.platform).toBe("woocommerce");
  });

  it("una clave de sitio sin forma o un pedido sin id no se mapean", () => {
    for (const key of ["", "KP", "k", "kp-1", "1kp", "kenkuperutienda"]) {
      expect(() => mapWooOrder(codLimaOrder(), { id: KENKU.id, woo_site_key: key })).toThrow(/woo_site_key/);
    }
    expect(() => mapWooOrder({ ...codLimaOrder(), id: 0 }, KENKU)).toThrow(/id válido/);
  });

  it("nombre = «#» + number del plugin de numeración", () => {
    expect(mapWooOrder(codLimaOrder(), KENKU)!.name).toBe("#KP200001");
    expect(mapWooOrder({ ...codLimaOrder(), number: "#KP200001" }, KENKU)!.name).toBe("#KP200001");
    // Sin plugin, WooCommerce manda el id: se ve, y por eso el plugin va antes del primer pedido.
    expect(mapWooOrder({ ...codLimaOrder(), number: "" }, KENKU)!.name).toBe("#1532");
  });

  it("las fechas son las *_gmt con «Z», nunca la hora local de la tienda", () => {
    const row = mapWooOrder(codLimaOrder(), KENKU)!;
    expect(row.created_at).toBe("2026-10-28T02:14:09Z");
    expect(row.processed_at).toBe("2026-10-28T02:14:09Z");
    expect(row.updated_at).toBe("2026-10-28T02:14:12Z");
    expect(wooGmt("2026-10-28T02:14:09")).toBe("2026-10-28T02:14:09Z");
    expect(wooGmt("2026-10-28T02:14:09Z")).toBe("2026-10-28T02:14:09Z");
    expect(wooGmt(null)).toBeNull();
    expect(wooGmt("ayer")).toBeNull();
  });

  it("los mapeadores de Shopify no ponen plataforma: sus escrituras no cambian", () => {
    expect("platform" in mapRestOrder({ id: 1, name: "#KP1", line_items: [] }, KENKU.id)).toBe(false);
    expect("platform" in mapGraphqlOrder({ id: "gid://shopify/Order/1", name: "#KP1" }, KENKU.id)).toBe(false);
  });
});

describe("estados", () => {
  it("pending, failed y checkout-draft no son pedidos: no entran a orders", () => {
    for (const status of ["pending", "failed", "checkout-draft", "draft", "auto-draft"]) {
      expect(WOO_SKIPPED_STATUSES).toContain(status);
      expect(isWooOrderIngestible({ status })).toBe(false);
      expect(mapWooOrder({ ...codLimaOrder(), status }, KENKU)).toBeNull();
    }
    for (const status of ["processing", "on-hold", "completed", "cancelled", "refunded", "trash"]) {
      expect(isWooOrderIngestible({ status })).toBe(true);
    }
    // El cuerpo de `order.deleted` solo trae el id: no es un pedido que mapear.
    expect(mapWooOrder({ id: 1532 } as WooOrder, KENKU)).toBeNull();
  });

  it("«Por confirmar», el estado propio del formulario contraentrega (23-10-2026): entra vivo, cod y pending", () => {
    // `cod-pending` es el slug real de «Por confirmar» en Aurela (COD Core, 24-10-2026).
    for (const status of ["cod-pending", "wc-cod-pending", "por-confirmar", "wc-por-confirmar", "Por-Confirmar"]) {
      expect(isWooOrderIngestible({ status })).toBe(true);
      const row = mapWooOrder({ ...codLimaOrder(), status, date_paid_gmt: null }, KENKU)!;
      expect(row).not.toBeNull();
      expect(row.payment_gateway).toBe("cod");
      expect(row.financial_status).toBe("pending");
      expect(row.cancelled_at).toBeNull();
    }
    // Si fuera `pending` con otra etiqueta, no entraría: por eso se pide el status exacto.
    expect(mapWooOrder({ ...codLimaOrder(), status: "pending" }, KENKU)).toBeNull();
  });

  it("contraentrega: cod y SIEMPRE pending, aunque WooCommerce ponga date_paid", () => {
    for (const status of ["processing", "on-hold", "completed"]) {
      const row = mapWooOrder({ ...codLimaOrder(), status }, KENKU)!;
      expect(row.payment_gateway).toBe("cod");
      expect(row.financial_status).toBe("pending");
      expect(row.cancelled_at).toBeNull();
    }
    // No cuenta como prepago web: el courier cobra en la puerta.
    const row = mapWooOrder(codLimaOrder(), KENKU)!;
    expect(isWebPrepaid({ financialStatus: row.financial_status, paymentGateway: row.payment_gateway, totalRefunded: row.total_refunded })).toBe(false);
  });

  it("anulado: voided y cancelled_at; la fecha que Kapta ya tenía se conserva", () => {
    const cancelled = { ...codLimaOrder(), status: "cancelled", date_modified_gmt: "2026-10-28T15:00:00" };
    const row = mapWooOrder(cancelled, KENKU)!;
    expect(row.financial_status).toBe("voided");
    expect(row.cancelled_at).toBe("2026-10-28T15:00:00Z");
    expect(row.cancel_reason).toBeNull();
    // Un cambio posterior del pedido anulado no mueve la fecha de la anulación.
    const later = { ...cancelled, date_modified_gmt: "2026-10-30T09:00:00" };
    expect(mapWooOrder(later, KENKU, { previousCancelledAt: "2026-10-28T15:00:00Z" })!.cancelled_at).toBe(
      "2026-10-28T15:00:00Z",
    );
    // La papelera también es anulación (el pedido nunca se borra en Kapta).
    expect(WOO_CANCELLED_STATUSES).toEqual(["cancelled", "trash"]);
    const trashed = mapWooOrder({ ...codLimaOrder(), status: "trash" }, KENKU)!;
    expect(trashed.financial_status).toBe("voided");
    expect(trashed.cancelled_at).toBe("2026-10-28T02:14:12Z");
  });

  it("si vuelve a un estado vivo en WooCommerce, deja de estar anulado, como en la tienda", () => {
    const restored = mapWooOrder(codLimaOrder(), KENKU, { previousCancelledAt: "2026-10-28T15:00:00Z" })!;
    expect(restored.cancelled_at).toBeNull();
    expect(restored.financial_status).toBe("pending");
  });
});

describe("el bot de WhatsApp de Aurela crea directo en WooCommerce (owner, 24-10-2026)", () => {
  it("`kapta_channel = whatsapp_bot` es Chatbot WhatsApp: etiquetas kapso y whatsapp, como `kapso`", () => {
    expect(WOO_CHANNEL_TAGS.whatsapp_bot).toEqual(WOO_CHANNEL_TAGS.kapso);
    const row = mapWooOrder(
      { ...codLimaOrder(), status: "cod-pending", meta_data: [{ id: 1, key: "kapta_channel", value: "whatsapp_bot" }, { id: 2, key: "source", value: "whatsapp-bot" }] },
      KENKU,
    )!;
    expect(row.tags).toEqual(expect.arrayContaining(["kapso", "whatsapp"]));
    expect(row.financial_status).toBe("pending");
    expect(row.payment_gateway).toBe("cod");
  });
});

describe("cobro: Flow, transferencia y reembolsos", () => {
  it("Flow con tarjeta: paid y checkout solo con el nombre CONFIRMADO de la pasarela", () => {
    const unconfirmed = mapWooOrder(flowCardOrder(), KENKU)!;
    // Hasta que la operación confirme el nombre, sigue el camino de las
    // constancias: ni pagado ni prepago web.
    expect(unconfirmed.financial_status).toBe("pending");
    expect(unconfirmed.payment_gateway).toBeNull();
    expect(isWebPrepaid({ financialStatus: unconfirmed.financial_status, paymentGateway: unconfirmed.payment_gateway })).toBe(false);
    expect(paymentGatewayOf(unconfirmed.raw)).toBeNull();

    const confirmed = mapWooOrder(flowCardOrder(CHECKOUT_GATEWAYS[0]!), KENKU)!;
    expect(confirmed.financial_status).toBe("paid");
    expect(confirmed.payment_gateway).toBe("checkout");
    expect(isWebPrepaid({ financialStatus: confirmed.financial_status, paymentGateway: confirmed.payment_gateway })).toBe(true);
  });

  it("Flow Payment de WooCommerce (Aurela, 24-10-2026): `flowpayment` «Tarjeta o Yape» pagado solo en processing/completed", () => {
    const flow = (status: string) =>
      mapWooOrder({ ...flowCardOrder("Tarjeta o Yape"), payment_method: "flowpayment", status }, KENKU);
    for (const status of ["processing", "completed"]) {
      const row = flow(status)!;
      expect(row.financial_status).toBe("paid");
      expect(row.payment_gateway).toBe("checkout");
    }
    // Esperando el pago: `pending`/`failed` no entran; si un plugin lo dejara
    // en `on-hold`, entra pero NO pagado.
    expect(flow("pending")).toBeNull();
    expect(flow("failed")).toBeNull();
    expect(flow("on-hold")!.financial_status).toBe("pending");
    // Otro título (si lo cambian en WooCommerce): camino de las constancias.
    const renamed = mapWooOrder({ ...flowCardOrder("Pago con tarjeta"), payment_method: "flowpayment" }, KENKU)!;
    expect(renamed.financial_status).toBe("pending");
    expect(renamed.payment_gateway).toBeNull();
  });

  it("una pasarela vacía (el «Añadir pedido» de wp-admin) o desconocida en processing NO es pagado", () => {
    // En wp-admin «processing» es «en preparación»: un pedido de contraentrega
    // cargado a mano no se salta la confirmación ni cuenta como cobrado.
    for (const [payment_method, payment_method_title] of [
      ["", ""],
      [null, null],
      ["cod_form_plugin", "Pago al recibir"],
      ["yape_qr", "Yape"],
    ] as const) {
      for (const status of ["processing", "completed"]) {
        const row = mapWooOrder(withOverrides(codLimaOrder(), { status, payment_method, payment_method_title } as Partial<WooOrder>), KENKU)!;
        expect(row.financial_status, `${String(payment_method)} ${status}`).toBe("pending");
        expect(row.payment_gateway).toBeNull();
      }
    }
    expect(WOO_PREPAID_METHODS).toEqual(["bacs"]);
  });

  it("transferencia: pending mientras está on-hold, paid cuando alguien la pasa a processing; nunca checkout", () => {
    const onHold = mapWooOrder(bankTransferOrder("on-hold"), KENKU)!;
    expect(onHold.financial_status).toBe("pending");
    expect(onHold.payment_gateway).toBeNull();
    const confirmed = mapWooOrder(bankTransferOrder("processing"), KENKU)!;
    expect(confirmed.financial_status).toBe("paid");
    expect(confirmed.payment_gateway).toBeNull();
  });

  it("reembolso parcial: suma en positivo; partially_refunded si estaba pagado", () => {
    const refunds = [
      { id: 801, reason: "Talla cambiada", total: "-30.00", total_tax: "0.00" },
      { id: 802, reason: "", total: "-9.50", total_tax: "0.00" },
    ];
    const paid = mapWooOrder({ ...flowCardOrder(CHECKOUT_GATEWAYS[0]!), refunds }, KENKU)!;
    expect(paid.total_refunded).toBe(39.5);
    expect(paid.financial_status).toBe("partially_refunded");
    // El total del pedido no baja: el reembolso va aparte, como en Shopify.
    expect(paid.total_amount).toBe(149);
    // Un reembolso deshace el prepago.
    expect(isWebPrepaid({ financialStatus: paid.financial_status, paymentGateway: "checkout", totalRefunded: paid.total_refunded })).toBe(false);

    const cod = mapWooOrder({ ...codLimaOrder(), refunds }, KENKU)!;
    expect(cod.total_refunded).toBe(39.5);
    expect(cod.financial_status).toBe("pending");

    const full = mapWooOrder({ ...flowCardOrder(), status: "refunded", refunds: [{ id: 803, total: "-149.00" }] }, KENKU)!;
    expect(full.financial_status).toBe("refunded");
    expect(full.total_refunded).toBe(149);
    expect(full.cancelled_at).toBeNull();
  });
});

describe("dirección y departamento", () => {
  it("Lima Metropolitana (LMA) → «Lima (provincia)», como Shopify", () => {
    const row = mapWooOrder(codLimaOrder(), KENKU)!;
    const address = shopifyShippingAddress(row.raw)!;
    expect(address).toEqual({
      address1: "Av. Los Próceres 1234",
      address2: "Frente al parque, puerta verde",
      city: "Santiago de Surco",
      province: "Lima (provincia)",
      name: "María Quispe Huamán",
      phone: "987 654 321",
      latitude: null,
      longitude: null,
    });
    expect(limaRegionKind(address.province)).toBe("metropolitana");
    expect(shopifyDepartamentoElegido(row.raw)).toBe("PE-LMA");
  });

  it("el resto del departamento de Lima (LIM) → «Lima (departamento)», nunca cobertura Lima", () => {
    const huaral = withOverrides(codLimaOrder(), {
      shipping: { ...codLimaOrder().shipping, city: "Huaral", state: "LIM", address_1: "Jr. Derecha 220" },
    });
    const row = mapWooOrder(huaral, KENKU)!;
    const address = shopifyShippingAddress(row.raw)!;
    expect(address.province).toBe("Lima (departamento)");
    expect(limaRegionKind(address.province)).toBe("departamento");
    expect(shopifyDepartamentoElegido(row.raw)).toBe("PE-LIM");
    expect(wooPeruStateName("LIM")).toBe("Lima (departamento)");
    expect(wooPeruStateName("LMA")).toBe("Lima (provincia)");
    expect(wooPeruStateName("CAL")).toBe("Callao");
    expect(wooPeruStateName("ARE")).toBe("Arequipa");
    expect(wooPeruStateName("HUC")).toBe("Huánuco");
    expect(wooPeruStateName("XYZ")).toBeNull();
  });

  it("y al revés, para crear el pedido en WooCommerce: LIM existe aunque resolvePeruProvinceCode no lo conozca", () => {
    expect(toWooPeruState("Lima (departamento)")).toBe("LIM");
    expect(toWooPeruState("Región Lima")).toBe("LIM");
    expect(toWooPeruState("LIM")).toBe("LIM");
    expect(toWooPeruState("PE-LIM")).toBe("LIM");
    expect(toWooPeruState("Lima (provincia)")).toBe("LMA");
    expect(toWooPeruState("Lima")).toBe("LMA");
    expect(toWooPeruState("Callao")).toBe("CAL");
    expect(toWooPeruState("Arequipa")).toBe("ARE");
    expect(toWooPeruState("PE-PUN")).toBe("PUN");
    expect(toWooPeruState("")).toBeNull();
    expect(toWooPeruState("Narnia")).toBeNull();
  });

  it("sin dirección de envío, la de facturación; y fuera del Perú no se inventa departamento", () => {
    const onlyBilling = withOverrides(codLimaOrder(), {
      shipping: { first_name: "", last_name: "", address_1: "", address_2: "", city: "", state: "", country: "" },
    });
    const address = shopifyShippingAddress(mapWooOrder(onlyBilling, KENKU)!.raw)!;
    expect(address.address1).toBe("Av. Los Próceres 1234");
    expect(address.province).toBe("Lima (provincia)");

    const abroad = withOverrides(codLimaOrder(), {
      shipping: { ...codLimaOrder().shipping, state: "CA", country: "US" },
    });
    const row = mapWooOrder(abroad, KENKU)!;
    expect(shopifyShippingAddress(row.raw)!.province).toBe("CA");
    expect(shopifyDepartamentoElegido(row.raw)).toBeNull();
  });

  it("teléfono: el de facturación y, si falta, el de envío", () => {
    expect(mapWooOrder(codLimaOrder(), KENKU)!.customer_phone).toBe("51987654321");
    const sinBilling = withOverrides(codLimaOrder(), {
      billing: { ...codLimaOrder().billing, phone: "" },
      shipping: { ...codLimaOrder().shipping, phone: "+51 912 345 678" },
    });
    const row = mapWooOrder(sinBilling, KENKU)!;
    expect(row.customer_phone).toBe("51912345678");
    expect(shopifyShippingAddress(row.raw)!.phone).toBe("+51 912 345 678");
    const sinNinguno = withOverrides(codLimaOrder(), {
      billing: { ...codLimaOrder().billing, phone: "" },
      shipping: { ...codLimaOrder().shipping, phone: "" },
    });
    expect(mapWooOrder(sinNinguno, KENKU)!.customer_phone).toBeNull();
  });
});

describe("raw: la copia con forma de Shopify REST para los lectores de hoy", () => {
  it("nota, totales, pasarela y el pedido de WooCommerce entero en raw.woo", () => {
    const order = codLimaOrder();
    const row = mapWooOrder(order, KENKU)!;
    const raw = row.raw as Record<string, unknown>;
    expect(shopifyOrderNote(row.raw)).toBe("Llamar antes de llegar, trabajo hasta las 6");
    expect(orderTotals(row.raw, row.total_amount)).toEqual({ subtotal: 149, discounts: 10, shipping: 0, total: 139 });
    expect(raw.payment_gateway_names).toEqual(["Pago contra entrega"]);
    expect(raw.total_shipping_price_set).toEqual({
      shop_money: { amount: "0.00", currency_code: "PEN" },
      presentment_money: { amount: "0.00", currency_code: "PEN" },
    });
    expect(raw.contact_email).toBe("maria.quispe@example.com");
    expect(raw.source).toBe("woocommerce");
    expect(raw.woo).toEqual(order);
    // Sin `id` arriba: nadie confunde el id de WooCommerce con uno de Shopify.
    expect("id" in raw).toBe(false);
  });

  it("la lista de pasarelas siempre está: el relleno de pasarelas de Shopify no toma el pedido", () => {
    // lib/payment-gateway-backfill.ts solo pregunta por los que NO tienen la lista.
    const raw = mapWooOrder({ ...codLimaOrder(), payment_method: "", payment_method_title: "" }, KENKU)!.raw as Record<string, unknown>;
    expect(raw.payment_gateway_names).toEqual([]);
  });

  it("con precios que incluyen impuesto, los totales y el precio de la línea son los que paga la clienta", () => {
    const taxed = withOverrides(codLimaOrder(), {
      prices_include_tax: true,
      shipping_total: "8.47",
      shipping_tax: "1.53",
      discount_total: "8.47",
      discount_tax: "1.53",
      total: "149.00",
      total_tax: "22.73",
      line_items: [{ ...codLimaOrder().line_items![0]!, subtotal: "126.27", subtotal_tax: "22.73", total: "117.80", total_tax: "21.20" }],
      fee_lines: [{ id: 1, name: "Descuento asesora", total: "-5.00", total_tax: "0.00" }],
    });
    const row = mapWooOrder(taxed, KENKU)!;
    expect(orderTotals(row.raw, row.total_amount)).toEqual({ subtotal: 149, discounts: 15, shipping: 10, total: 149 });
    expect(row.line_items[0]!.price).toBe(149);
  });

  it("los utm de la atribución de WooCommerce llegan como note_attributes (orders.utm_meta, 0156)", () => {
    const attrs = (mapWooOrder(codLimaOrder(), KENKU)!.raw as { note_attributes: { name: string; value: string }[] })
      .note_attributes;
    expect(attrs).toContainEqual({ name: "utm_id", value: "120210000000000001" });
    expect(attrs).toContainEqual({ name: "utm_source", value: "facebook" });
    expect(attrs).toContainEqual({ name: "kapta_channel", value: "web_formulario" });
    expect(attrs).toContainEqual({ name: "is_vat_exempt", value: "no" });
    // Los meta ocultos de plugins no ensucian los atributos (siguen en raw.woo).
    expect(attrs.some((a) => a.name.startsWith("_"))).toBe(false);
    expect(attrs.some((a) => a.name === "utm_user_agent")).toBe(false);
  });
});

describe("líneas y cupones", () => {
  it("una variación: título del producto, variante «38 / Negro», SKU y precio antes del cupón", () => {
    const [item] = mapWooOrder(codLimaOrder(), KENKU)!.line_items;
    expect(item).toEqual({
      title: "Zapatilla Urbana Kenku",
      variant_title: "38 / Negro",
      quantity: 1,
      sku: "65359446",
      product_id: "4410",
      variant_id: "4415",
      price: 149,
    });
  });

  it("un producto simple: sin variante; dos unidades a 59.90", () => {
    const simple = withOverrides(codLimaOrder(), {
      line_items: [
        {
          id: 310,
          name: "Medias deportivas pack x3",
          product_id: 5120,
          variation_id: 0,
          quantity: 2,
          subtotal: "119.80",
          subtotal_tax: "0.00",
          total: "119.80",
          total_tax: "0.00",
          sku: "",
          meta_data: [],
          parent_name: null,
        },
      ],
    });
    const [item] = mapWooOrder(simple, KENKU)!.line_items;
    expect(item).toMatchObject({ title: "Medias deportivas pack x3", variant_title: null, quantity: 2, sku: null, product_id: "5120", variant_id: null, price: 59.9 });
  });

  it("un regalo a S/ 0 tiene precio 0; una línea sin subtotal, ninguno", () => {
    const base = codLimaOrder().line_items![0]!;
    const order = withOverrides(codLimaOrder(), {
      line_items: [
        { ...base, id: 320, subtotal: "0.00", subtotal_tax: "0.00", total: "0.00", total_tax: "0.00" },
        { ...base, id: 321, subtotal: undefined, subtotal_tax: undefined },
      ],
    });
    const [gift, unknown] = mapWooOrder(order, KENKU)!.line_items;
    expect(gift!.price).toBe(0);
    expect(unknown!.price).toBeNull();
  });

  it("los cupones salen en mayúsculas, como los de Shopify", () => {
    expect(mapWooOrder(codLimaOrder(), KENKU)!.discount_codes).toEqual(["KENKU10"]);
  });
});

describe("etiquetas desde los meta: las mismas palabras de hoy (lib/sales-channel.ts)", () => {
  function withMeta(meta: { key: string; value: unknown }[]) {
    return mapWooOrder(withOverrides(codLimaOrder(), { meta_data: meta.map((m, i) => ({ id: i + 1, ...m })) }), KENKU)!;
  }

  it("cada kapta_channel da su canal de venta", () => {
    const expected: Record<string, string> = {
      web_formulario: "web_formulario",
      web_carrito: "web_carrito",
      venta_manual: "asesora",
      asesora: "asesora",
      kapso: "chatbot",
      chatbot: "chatbot",
      whatsapp_bot: "chatbot",
      bot_carritos: "bot_carritos",
      catalogo: "catalogo",
      "catalogo-wsp": "catalogo",
    };
    expect(Object.keys(WOO_CHANNEL_TAGS).sort()).toEqual(Object.keys(expected).sort());
    for (const [channel, salesCh] of Object.entries(expected)) {
      const row = withMeta([{ key: "kapta_channel", value: channel }]);
      expect(row.tags).toEqual([...WOO_CHANNEL_TAGS[channel]!]);
      expect(salesChannel(row.tags, row.kapso_conversation_id)).toBe(salesCh);
    }
    expect(withMeta([{ key: "kapta_channel", value: "web_formulario" }]).tags).toEqual(["easysell_cod_form"]);
    expect(withMeta([{ key: "kapta_channel", value: "venta_manual" }]).tags).toEqual(["venta_manual"]);
  });

  it("un canal desconocido o ningún meta: sin etiquetas, «Sin marca»; no se adivina", () => {
    for (const row of [withMeta([{ key: "kapta_channel", value: "tiktok" }]), withMeta([])]) {
      expect(row.tags).toEqual([]);
      expect(salesChannel(row.tags, row.kapso_conversation_id)).toBe("otro");
      expect(hasKapsoTag(row.tags)).toBe(false);
    }
  });

  it("el bot de Kapso: kapso + la conversación → chatbot, lead ganado y rollups", () => {
    const row = withMeta([
      { key: "kapta_channel", value: "kapso" },
      { key: "kapso_conversation_id", value: "conv_8f2a" },
      { key: "kapso_phone_number_id", value: "1098765432" },
      { key: "kapta_tags", value: '["promo-whatsapp","contraentrega"]' },
    ]);
    expect(row.tags).toEqual(["promo-whatsapp", "contraentrega", "kapso", "whatsapp"]);
    expect(hasKapsoTag(row.tags)).toBe(true);
    expect(row.kapso_conversation_id).toBe("conv_8f2a");
    expect(row.promo_applied).toBe(true);
    expect(row.shipping_mode).toBe("cod");
    expect(salesChannel(row.tags, row.kapso_conversation_id)).toBe("chatbot");
  });

  it("la sola conversación de Kapso (o el meta kapso) ya pone la etiqueta kapso", () => {
    const conv = withMeta([{ key: "_kapso_conversation_id", value: "conv_1" }]);
    expect(conv.tags).toEqual(["kapso"]);
    expect(conv.kapso_conversation_id).toBe("conv_1");
    expect(withMeta([{ key: "kapso", value: "true" }]).tags).toEqual(["kapso"]);
    expect(withMeta([{ key: "kapso", value: "no" }]).tags).toEqual([]);
  });

  it("los meta de Kapta se leen también ocultos (con «_») y en cualquier caja", () => {
    expect(withMeta([{ key: "_kapta_channel", value: "venta_manual" }]).tags).toEqual(["venta_manual"]);
    expect(withMeta([{ key: "Kapta_Channel", value: "Venta_Manual" }]).tags).toEqual(["venta_manual"]);
  });

  it("kapta_tags admite lista con comas; stock-por-validar y shipping_mode como hoy", () => {
    const row = withMeta([
      { key: "kapta_tags", value: "stock-por-validar, agencia" },
      { key: "kapta_channel", value: "venta_manual" },
      { key: "kapta_lead_id", value: "8d3c0b4e-lead" },
    ]);
    expect(row.tags).toEqual(["stock-por-validar", "agencia", "venta_manual"]);
    expect(row.stock_por_validar).toBe(true);
    expect(row.shipping_mode).toBe("agency");
    const viaAttr = withMeta([{ key: "shipping_mode", value: "contraentrega" }, { key: "stock_por_validar", value: "si" }]);
    expect(viaAttr.shipping_mode).toBe("cod");
    expect(viaAttr.stock_por_validar).toBe(true);
    expect(viaAttr.tags).toEqual([]);
  });

  it("sin repetir, sin importar mayúsculas", () => {
    const row = withMeta([
      { key: "kapta_tags", value: ["KAPSO", "venta_manual"] },
      { key: "kapta_channel", value: "venta_manual" },
      { key: "kapso", value: "1" },
    ]);
    expect(row.tags).toEqual(["KAPSO", "venta_manual"]);
  });
});

describe("firma y ping de los webhooks", () => {
  const SECRET = "0f3c9a51d2b84e7f0a6c1d2e3f4a5b6c";
  const body = JSON.stringify(codLimaOrder());
  const sign = (payload: string, secret = SECRET) => createHmac("sha256", secret).update(payload, "utf8").digest("base64");

  it("HMAC-SHA256 del cuerpo crudo en base64, como Shopify", () => {
    expect(verifyWooSignature(body, sign(body), SECRET)).toBe(true);
    expect(verifyWooSignature(Buffer.from(body, "utf8"), sign(body), SECRET)).toBe(true);
    expect(verifyWooSignature(body + " ", sign(body), SECRET)).toBe(false);
    expect(verifyWooSignature(body, sign(body, "otro"), SECRET)).toBe(false);
    expect(verifyWooSignature(body, null, SECRET)).toBe(false);
    expect(verifyWooSignature(body, sign(body), null)).toBe(false);
  });

  it("el ping de alta (`webhook_id=N`, sin firma) se reconoce para responderle 200", () => {
    expect(parseWooWebhookPing("webhook_id=12")).toBe(12);
    expect(parseWooWebhookPing(Buffer.from("webhook_id=7\n"))).toBe(7);
    expect(parseWooWebhookPing(body)).toBeNull();
    expect(parseWooWebhookPing("webhook_id=12&x=1")).toBeNull();
    expect(parseWooWebhookPing("")).toBeNull();
  });
});

// ── Cliente REST ─────────────────────────────────────────────────────────────

const CK = "ck_5e2f0d9b8a7c6e5d4c3b2a1f0e9d8c7b6a5f4e3d";
const CS = "cs_1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b";

interface Call {
  url: string;
  init: RequestInit;
}

function fakeFetch(respond: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(url), init: init ?? {} };
    calls.push(call);
    return respond(call);
  }) as typeof fetch;
  return { impl, calls };
}

function json(data: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...headers } });
}

function client(fetchImpl: typeof fetch, extra: Partial<WooClientOpts> = {}): WooClientOpts {
  return { siteUrl: "https://kenku.pe", consumerKey: CK, consumerSecret: CS, fetchImpl, ...extra };
}

/** Ningún mensaje de error lleva las claves ni la URL. */
function expectNoSecrets(e: unknown) {
  const message = e instanceof Error ? e.message : String(e);
  expect(message).not.toContain(CK);
  expect(message).not.toContain(CS);
  expect(message).not.toContain("consumer_secret");
  expect(message).not.toContain("https://kenku.pe/wp-json");
}

async function caught(p: Promise<unknown>): Promise<WooError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(WooError);
    expectNoSecrets(e);
    return e as WooError;
  }
  throw new Error("se esperaba un WooError");
}

describe("cliente REST", () => {
  it("la dirección del sitio: solo https a un dominio público, limpia", () => {
    expect(normalizeWooSiteUrl("https://kenku.pe/")).toBe("https://kenku.pe");
    expect(normalizeWooSiteUrl(" https://Tienda.Aurela.pe/shop/ ")).toBe("https://tienda.aurela.pe/shop");
    expect(normalizeWooSiteUrl("https://kenku.pe:443")).toBe("https://kenku.pe");
    for (const bad of [
      "http://kenku.pe",
      "kenku.pe",
      "https://user:pass@kenku.pe",
      "https://kenku.pe/?x=1",
      "https://kenku.pe:8443",
      "https://127.0.0.1",
      "https://10.0.0.5",
      "https://[::1]",
      "https://localhost",
      "https://wp.internal",
      "https://kenku.pe/wp-json/wc/v3",
      "",
      null,
    ]) {
      expect(normalizeWooSiteUrl(bad)).toBeNull();
    }
  });

  it("Basic auth por cabecera, sin seguir redirecciones y con tiempo límite", async () => {
    const { impl, calls } = fakeFetch(() => json({ id: 1532 }));
    const res = await wooRequest(client(impl), { path: "/orders/1532" });
    expect(res.data).toEqual({ id: 1532 });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://kenku.pe/wp-json/wc/v3/orders/1532");
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Basic ${Buffer.from(`${CK}:${CS}`).toString("base64")}`);
    expect(calls[0]!.init.redirect).toBe("manual");
    expect(calls[0]!.init.signal).toBeInstanceOf(AbortSignal);
    expect(calls[0]!.url).not.toContain(CS);
  });

  it("respaldo por query string cuando el hosting borra la cabecera", async () => {
    const { impl, calls } = fakeFetch(() => json([]));
    await wooRequest(client(impl, { auth: "query" }), { path: "/orders", query: { per_page: 5 } });
    const url = new URL(calls[0]!.url);
    expect(url.searchParams.get("consumer_key")).toBe(CK);
    expect(url.searchParams.get("consumer_secret")).toBe(CS);
    expect(url.searchParams.get("per_page")).toBe("5");
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it("las credenciales malas se dicen sin repetirlas", async () => {
    const { impl } = fakeFetch(() =>
      json({ code: "woocommerce_rest_authentication_error", message: `Consumer key is invalid: ${CK}`, data: { status: 401 } }, 401),
    );
    const err = await caught(wooRequest(client(impl), { path: "/orders" }));
    expect(err.kind).toBe("credenciales");
    expect(err.status).toBe(401);
    expect(err.code).toBe("woocommerce_rest_authentication_error");
    expect(err.message).toContain("[oculto]");
  });

  it("un 401 de permisos con Basic sugiere el modo por query string", async () => {
    const { impl } = fakeFetch(() =>
      json({ code: "woocommerce_rest_cannot_view", message: "Lo siento, no puedes listar los recursos.", data: { status: 401 } }, 401),
    );
    const err = await caught(wooRequest(client(impl), { path: "/orders" }));
    expect(err.kind).toBe("permisos");
    expect(err.message).toContain("query string");
    // En modo query ya no tiene sentido sugerirlo.
    const q = wooErrorFromResponse(401, { code: "woocommerce_rest_cannot_view" }, "query");
    expect(q.message).not.toContain("query string");
  });

  it("404, 429, 5xx, una redirección y una respuesta que no es JSON", async () => {
    expect((await caught(wooRequest(client(fakeFetch(() => json({ code: "woocommerce_rest_shop_order_invalid_id", message: "ID inválido." }, 404)).impl), { path: "/orders/9" }))).kind).toBe("no_encontrado");
    expect((await caught(wooRequest(client(fakeFetch(() => json({ code: "rest_no_route", message: "No route" }, 404)).impl), { path: "/orders" }))).message).toContain("wp-json/wc/v3");
    expect((await caught(wooRequest(client(fakeFetch(() => json({}, 429)).impl), { path: "/orders" }))).kind).toBe("limite");
    expect((await caught(wooRequest(client(fakeFetch(() => new Response("<html>502</html>", { status: 502 })).impl), { path: "/orders" }))).kind).toBe("servidor");
    const redirect = await caught(
      wooRequest(client(fakeFetch(() => new Response(null, { status: 301, headers: { Location: "https://otro.example/wp-json/wc/v3/orders" } })).impl), { path: "/orders" }),
    );
    expect(redirect.kind).toBe("redireccion");
    expect(redirect.message).toContain("HTTP 301");
    expect((await caught(wooRequest(client(fakeFetch(() => new Response("<!doctype html><p>Mantenimiento</p>", { status: 200 })).impl), { path: "/orders" }))).kind).toBe("respuesta_invalida");
    expect((await caught(wooRequest(client(fakeFetch(() => json({ code: "woocommerce_rest_invalid_param", message: "Parámetro inválido: <b>status</b>" }, 400)).impl), { path: "/orders" }))).message).toContain("«Parámetro inválido: status»");
  });

  it("tiempo agotado y red caída: mensajes propios, sin la URL", async () => {
    const timeout = fakeFetch(() => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    });
    const err = await caught(wooRequest(client(timeout.impl, { timeoutMs: 15_000 }), { path: "/orders" }));
    expect(err.kind).toBe("tiempo");
    expect(err.message).toContain("15 s");
    const down = fakeFetch(() => {
      throw new TypeError(`fetch failed https://kenku.pe/wp-json/wc/v3/orders?consumer_secret=${CS}`);
    });
    expect((await caught(wooRequest(client(down.impl, { auth: "query" }), { path: "/orders" }))).kind).toBe("red");
  });

  it("sin llamar: dirección mala, faltan claves o una ruta rara", async () => {
    const { impl, calls } = fakeFetch(() => json({}));
    expect((await caught(wooRequest(client(impl, { siteUrl: "http://kenku.pe" }), { path: "/orders" }))).kind).toBe("config");
    expect((await caught(wooRequest(client(impl, { consumerSecret: "" }), { path: "/orders" }))).kind).toBe("config");
    expect((await caught(wooRequest(client(impl), { path: "/orders/../../users" }))).kind).toBe("config");
    expect((await caught(wooRequest(client(impl), { path: "orders" }))).kind).toBe("config");
    expect(calls).toHaveLength(0);
  });

  it("pedidos modificados desde el cursor: GMT sin zona, del más viejo al más nuevo, 100 como máximo", async () => {
    const { impl, calls } = fakeFetch(() => json([codLimaOrder()], 200, { "X-WP-Total": "1", "X-WP-TotalPages": "1" }));
    const page = await fetchWooOrdersPage(client(impl), { modifiedAfter: "2026-10-28T02:00:00.000Z", perPage: 500 });
    expect(page.items).toHaveLength(1);
    expect(page.total).toBe(1);
    expect(page.totalPages).toBe(1);
    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe("/wp-json/wc/v3/orders");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      status: "any",
      orderby: "modified",
      order: "asc",
      dates_are_gmt: "true",
      modified_after: "2026-10-28T02:00:00",
      per_page: String(WOO_MAX_PER_PAGE),
      page: "1",
    });
    expect(toWooGmtParam("2026-10-27T21:00:00-05:00")).toBe("2026-10-28T02:00:00");
    expect(toWooGmtParam("no es fecha")).toBeNull();
  });

  it("wooPaginate sigue X-WP-TotalPages y para en el tope", async () => {
    const { impl, calls } = fakeFetch(({ url }) => {
      const page = Number(new URL(url).searchParams.get("page"));
      return json([{ id: page }], 200, { "X-WP-Total": "3", "X-WP-TotalPages": "3" });
    });
    const pages: number[] = [];
    for await (const p of wooPaginate<{ id: number }>(client(impl), "/orders", { per_page: 1 })) pages.push(p.items[0]!.id);
    expect(pages).toEqual([1, 2, 3]);
    expect(calls).toHaveLength(3);

    const capped: number[] = [];
    for await (const p of wooPaginate<{ id: number }>(client(impl), "/orders", { per_page: 1 }, { maxPages: 2 })) capped.push(p.page);
    expect(capped).toEqual([1, 2]);

    // Sin cabeceras de totales, para en la primera página vacía.
    const noHeaders = fakeFetch(({ url }) => json(Number(new URL(url).searchParams.get("page")) < 3 ? [{ id: 1 }] : []));
    const seen: number[] = [];
    for await (const p of wooPaginate(client(noHeaders.impl), "/orders")) seen.push(p.items.length);
    expect(seen).toEqual([1, 1, 0]);
  });

  it("un pedido por id, y el que vuelve se mapea igual que el del webhook", async () => {
    const { impl, calls } = fakeFetch(() => json(codLimaOrder()));
    const order = await fetchWooOrder(client(impl), "1532");
    expect(calls[0]!.url).toBe("https://kenku.pe/wp-json/wc/v3/orders/1532");
    expect(mapWooOrder(order, KENKU)).toEqual(mapWooOrder(codLimaOrder(), KENKU));
    expect((await caught(fetchWooOrder(client(impl), "wc-kp-1532"))).kind).toBe("config");
  });
});
