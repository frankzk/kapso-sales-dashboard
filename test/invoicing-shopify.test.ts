// La lectura del pedido en Shopify para su boleta (MOM §35.3, §35.5).
// Nodos GraphQL falsos con la forma de la Admin API 2025-01; la red se inyecta
// con `fetchImpl` y la base con un cliente falso. Nunca se llama a Shopify.

import { describe, it, expect, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

const h = vi.hoisted(() => ({ token: "shpat_prueba_no_es_real" }));

// El token se descifra con la llave del entorno; aquí no hace falta ninguna.
vi.mock("@/lib/crypto", () => ({
  decryptOrNull: (v: string | null | undefined) => {
    if (!v) return null;
    if (v === "v1:roto") throw new Error("Unsupported state or unable to authenticate data");
    return h.token;
  },
}));

import {
  ORDER_FOR_INVOICE_QUERY,
  fetchOrderForInvoice,
  mapOrderForInvoice,
  webPrepaidConfirmed,
  type InvoiceOrderRead,
} from "@/lib/invoicing/shopify-order";
import { buildSalePayload } from "@/lib/invoicing/rules";
import { SHOPIFY_SHUTDOWN_AT, SNAPSHOT_FALLBACK_FROM, isAfterShopifyShutdown } from "@/lib/invoicing/shopify-cutoff";

const FAKE_TOKEN = h.token;

// ── Nodos de Shopify ─────────────────────────────────────────────────────────

const pen = (amount: string) => ({ shopMoney: { amount, currencyCode: "PEN" } });
const amt = (amount: string) => ({ shopMoney: { amount } });

type Node = Record<string, unknown>;

/** El nombre de la pasarela del checkout tal como sale en `paymentGatewayNames` (lib/payment-gateway.ts). */
const FLOW_CHECKOUT = "Checkout Flow | Tarjeta, Transf., Cuotas débito";

function lineNode(over: Node = {}): Node {
  return {
    id: "gid://shopify/LineItem/16401234567",
    title: "Faja Reductora Colombiana",
    variantTitle: "M / Negro",
    sku: "FAJA-M-NEG",
    quantity: 1,
    currentQuantity: 1,
    isGiftCard: false,
    variant: { id: "gid://shopify/ProductVariant/47012345678" },
    originalUnitPriceSet: amt("89.9"),
    discountAllocations: [],
    ...over,
  };
}

function shippingNode(over: Node = {}): Node {
  return { title: "Envío Lima", isRemoved: false, discountedPriceSet: amt("10.0"), ...over };
}

/** Un pedido COD de S/ 99.90: una faja de S/ 89.90 y S/ 10 de envío. */
function orderNode(over: Node = {}): Node {
  return {
    id: "gid://shopify/Order/6123456789012",
    name: "#KP136181",
    test: false,
    edited: false,
    cancelledAt: null,
    displayFinancialStatus: "PENDING",
    paymentGatewayNames: ["Cash on Delivery (COD)"],
    taxesIncluded: true,
    currencyCode: "PEN",
    totalPriceSet: pen("99.9"),
    currentTotalPriceSet: pen("99.9"),
    totalRefundedSet: amt("0.0"),
    netPaymentSet: amt("0.0"),
    totalOutstandingSet: amt("99.9"),
    totalTaxSet: amt("15.24"),
    totalTipReceivedSet: amt("0.0"),
    transactions: [],
    lineItems: { pageInfo: { hasNextPage: false }, nodes: [lineNode()] },
    shippingLines: { nodes: [shippingNode()] },
    ...over,
  };
}

function withTotal(total: string, over: Node = {}): Node {
  return orderNode({ totalPriceSet: pen(total), currentTotalPriceSet: pen(total), ...over });
}

function ok(read: InvoiceOrderRead): Extract<InvoiceOrderRead, { ok: true }> {
  if (!read.ok) throw new Error(`se esperaba ok, vino ${read.reason}: ${read.detail ?? ""}`);
  return read;
}

function reasonOf(read: InvoiceOrderRead): string {
  return read.ok ? "ok" : read.reason;
}

// ── mapOrderForInvoice ───────────────────────────────────────────────────────

describe("mapOrderForInvoice: ítems al céntimo", () => {
  it("un pedido simple: la línea con su variante y el envío", () => {
    const read = ok(mapOrderForInvoice(orderNode()));
    expect(read.orderGid).toBe("gid://shopify/Order/6123456789012");
    expect(read.name).toBe("#KP136181");
    expect(read.totalCents).toBe(9990);
    expect(read.items).toEqual([
      { code: "FAJA-M-NEG", name: "Faja Reductora Colombiana - M / Negro", qty: 1, priceCents: 8990 },
      { code: "ENVIO", name: "Servicio de envío - Envío Lima", qty: 1, priceCents: 1000 },
    ]);
    expect(read.payment).toEqual({
      financialStatus: "PENDING",
      gatewayNames: ["Cash on Delivery (COD)"],
      paidCents: 0,
      otherPaidCents: 0,
      netPaymentCents: 0,
      outstandingCents: 9990,
    });
    // Lo que sale de aquí es lo que acepta la boleta.
    const payload = buildSalePayload({
      invoiceId: "6f1c2a3b-0000-4000-8000-000000000000",
      orderName: read.name,
      items: read.items,
      totalCents: read.totalCents,
    });
    expect(payload?.total).toBe(99.9);
    expect(payload?.items.map((i) => i.price)).toEqual([89.9, 10]);
  });

  it("el descuento del pedido entero repartido entre las líneas (discountAllocations)", () => {
    // 2 × S/ 50 y 1 × S/ 30 con un PREPAID de S/ 13: Shopify asigna 10 y 3.
    const read = ok(
      mapOrderForInvoice(
        withTotal("117.0", {
          lineItems: {
            pageInfo: { hasNextPage: false },
            nodes: [
              lineNode({
                sku: "BRASIER-34B",
                title: "Brasier Push Up",
                variantTitle: "34B",
                quantity: 2,
                currentQuantity: 2,
                originalUnitPriceSet: amt("50.0"),
                discountAllocations: [{ allocatedAmountSet: amt("10.0") }],
              }),
              lineNode({
                id: "gid://shopify/LineItem/16401234568",
                sku: "MEDIAS-U",
                title: "Medias de compresión",
                variantTitle: null,
                originalUnitPriceSet: amt("30.0"),
                discountAllocations: [{ allocatedAmountSet: amt("3.0") }],
              }),
            ],
          },
          shippingLines: { nodes: [shippingNode({ discountedPriceSet: amt("0.0") })] },
        }),
      ),
    );
    expect(read.items).toEqual([
      { code: "BRASIER-34B", name: "Brasier Push Up - 34B", qty: 2, priceCents: 4500 },
      { code: "MEDIAS-U", name: "Medias de compresión", qty: 1, priceCents: 2700 },
    ]);
    expect(read.totalCents).toBe(11700);
  });

  it("varias asignaciones en la misma línea se suman", () => {
    const read = ok(
      mapOrderForInvoice(
        withTotal("70.0", {
          lineItems: {
            pageInfo: { hasNextPage: false },
            nodes: [
              lineNode({
                originalUnitPriceSet: amt("89.9"),
                discountAllocations: [{ allocatedAmountSet: amt("9.9") }, { allocatedAmountSet: amt("20.0") }],
              }),
            ],
          },
        }),
      ),
    );
    expect(read.items[0]).toMatchObject({ qty: 1, priceCents: 6000 });
  });

  it("S/ 100 entre 3 se parte en dos ítems que difieren en un céntimo", () => {
    const read = ok(
      mapOrderForInvoice(
        withTotal("100.0", {
          lineItems: {
            pageInfo: { hasNextPage: false },
            nodes: [
              lineNode({
                quantity: 3,
                currentQuantity: 3,
                originalUnitPriceSet: amt("40.0"),
                discountAllocations: [{ allocatedAmountSet: amt("20.0") }],
              }),
            ],
          },
          shippingLines: { nodes: [] },
        }),
      ),
    );
    expect(read.items).toEqual([
      { code: "FAJA-M-NEG", name: "Faja Reductora Colombiana - M / Negro", qty: 2, priceCents: 3333 },
      { code: "FAJA-M-NEG", name: "Faja Reductora Colombiana - M / Negro", qty: 1, priceCents: 3334 },
    ]);
  });

  it("S/ 100.01 entre 3: el céntimo de más va a dos unidades", () => {
    const read = ok(
      mapOrderForInvoice(
        withTotal("100.01", {
          lineItems: {
            pageInfo: { hasNextPage: false },
            nodes: [
              lineNode({
                quantity: 3,
                currentQuantity: 3,
                originalUnitPriceSet: amt("40.0"),
                discountAllocations: [{ allocatedAmountSet: amt("19.99") }],
              }),
            ],
          },
          shippingLines: { nodes: [] },
        }),
      ),
    );
    expect(read.items.map((i) => [i.qty, i.priceCents])).toEqual([
      [1, 3333],
      [2, 3334],
    ]);
  });

  it("una cantidad que se divide exacto queda en un solo ítem", () => {
    const read = ok(
      mapOrderForInvoice(
        withTotal("120.0", {
          lineItems: {
            pageInfo: { hasNextPage: false },
            nodes: [lineNode({ quantity: 4, currentQuantity: 4, originalUnitPriceSet: amt("30.0") })],
          },
          shippingLines: { nodes: [] },
        }),
      ),
    );
    expect(read.items).toEqual([
      { code: "FAJA-M-NEG", name: "Faja Reductora Colombiana - M / Negro", qty: 4, priceCents: 3000 },
    ]);
  });

  it("el envío con descuento va por lo cobrado", () => {
    const read = ok(
      mapOrderForInvoice(withTotal("94.9", { shippingLines: { nodes: [shippingNode({ discountedPriceSet: amt("5.0") })] } })),
    );
    expect(read.items[1]).toEqual({ code: "ENVIO", name: "Servicio de envío - Envío Lima", qty: 1, priceCents: 500 });
  });

  it("el envío gratis no es un ítem", () => {
    const read = ok(
      mapOrderForInvoice(withTotal("89.9", { shippingLines: { nodes: [shippingNode({ discountedPriceSet: amt("0.0") })] } })),
    );
    expect(read.items.map((i) => i.code)).toEqual(["FAJA-M-NEG"]);
  });

  it("el envío sin título se llama «Servicio de envío»", () => {
    const read = ok(mapOrderForInvoice(orderNode({ shippingLines: { nodes: [shippingNode({ title: "  " })] } })));
    expect(read.items[1]?.name).toBe("Servicio de envío");
  });

  it("sin SKU: el código es la variante; sin variante, la línea", () => {
    const sinSku = ok(mapOrderForInvoice(orderNode({ lineItems: { pageInfo: { hasNextPage: false }, nodes: [lineNode({ sku: "  " })] } })));
    expect(sinSku.items[0]?.code).toBe("V47012345678");

    const sinVariante = ok(
      mapOrderForInvoice(
        orderNode({ lineItems: { pageInfo: { hasNextPage: false }, nodes: [lineNode({ sku: null, variant: null })] } }),
      ),
    );
    expect(sinVariante.items[0]?.code).toBe("L16401234567");
  });

  it("el SKU se recorta", () => {
    const read = ok(mapOrderForInvoice(orderNode({ lineItems: { pageInfo: { hasNextPage: false }, nodes: [lineNode({ sku: "  FAJA-M  " })] } })));
    expect(read.items[0]?.code).toBe("FAJA-M");
  });

  it("el nombre: con la variante, sin «Default Title», y a lo más 250 caracteres", () => {
    const nameOf = (over: Node) =>
      ok(mapOrderForInvoice(orderNode({ lineItems: { pageInfo: { hasNextPage: false }, nodes: [lineNode(over)] } })))
        .items[0]?.name;
    expect(nameOf({ variantTitle: "L / Beige" })).toBe("Faja Reductora Colombiana - L / Beige");
    expect(nameOf({ variantTitle: "Default Title" })).toBe("Faja Reductora Colombiana");
    expect(nameOf({ variantTitle: null })).toBe("Faja Reductora Colombiana");
    expect(nameOf({ variantTitle: "" })).toBe("Faja Reductora Colombiana");
    expect(nameOf({ title: "  Faja  ", variantTitle: "  S " })).toBe("Faja - S");
    const long = nameOf({ title: "x".repeat(300) });
    expect(long).toHaveLength(250);
  });

  it("lo cobrado: ventas y capturas aprobadas que no son de prueba", () => {
    const tx = (kind: string, status: string, amount: string, test = false) => ({
      kind,
      status,
      gateway: "Checkout Flow | Tarjeta, Transf., Cuotas débito",
      test,
      amountSet: amt(amount),
    });
    const read = ok(
      mapOrderForInvoice(
        orderNode({
          transactions: [
            tx("AUTHORIZATION", "SUCCESS", "99.9"),
            tx("SALE", "FAILURE", "99.9"),
            tx("SALE", "SUCCESS", "50.0", true),
            tx("SALE", "SUCCESS", "40.0"),
            tx("CAPTURE", "SUCCESS", "59.9"),
            tx("CAPTURE", "PENDING", "10.0"),
            tx("REFUND", "SUCCESS", "5.0"),
          ],
        }),
      ),
    );
    expect(read.payment.paidCents).toBe(9990);
    expect(read.payment.otherPaidCents).toBe(0);
  });

  it("lo que cobró otra pasarela va aparte de lo de Flow", () => {
    const tx = (gateway: unknown, status: string, amount: string, over: Node = {}) => ({
      kind: "SALE",
      status,
      gateway,
      test: false,
      amountSet: amt(amount),
      ...over,
    });
    const read = ok(
      mapOrderForInvoice(
        orderNode({
          transactions: [
            tx(FLOW_CHECKOUT, "SUCCESS", "40.0"),
            tx("manual", "SUCCESS", "59.9"),
            tx("gift_card", "SUCCESS", "5.0"),
            tx("manual", "FAILURE", "99.9"),
            tx("manual", "SUCCESS", "7.0", { test: true }),
            // Sin nombre de pasarela no se sabe quién cobró: no es de Flow.
            tx(null, "SUCCESS", "1.0"),
          ],
        }),
      ),
    );
    expect(read.payment.paidCents).toBe(4000);
    expect(read.payment.otherPaidCents).toBe(6590);
  });
});

describe("mapOrderForInvoice: bloqueos", () => {
  it("sin pedido es no_encontrado", () => {
    expect(mapOrderForInvoice(null)).toEqual({ ok: false, reason: "no_encontrado" });
    expect(mapOrderForInvoice(undefined)).toEqual({ ok: false, reason: "no_encontrado" });
  });

  it.each<[string, Node]>([
    ["prueba", { test: true }],
    ["anulado", { cancelledAt: "2026-10-14T15:00:00Z" }],
    ["moneda", { totalPriceSet: { shopMoney: { amount: "99.9", currencyCode: "USD" } } }],
    ["moneda", { currencyCode: "USD" }],
    ["moneda", { currentTotalPriceSet: { shopMoney: { amount: "99.9", currencyCode: "USD" } } }],
    ["moneda", { totalPriceSet: amt("99.9") }],
    ["reembolsado", { totalRefundedSet: amt("10.0") }],
    ["editado", { edited: true }],
    ["propina", { totalTipReceivedSet: amt("5.0") }],
    ["impuesto_encima", { taxesIncluded: false, totalTaxSet: amt("17.98") }],
    ["demasiadas_lineas", { lineItems: { pageInfo: { hasNextPage: true }, nodes: [lineNode()] } }],
  ])("%s", (reason, over) => {
    expect(reasonOf(mapOrderForInvoice(orderNode(over)))).toBe(reason);
  });

  it("los bloqueos van en orden: el primero que falla es el motivo", () => {
    expect(reasonOf(mapOrderForInvoice(orderNode({ test: true, cancelledAt: "2026-10-14T15:00:00Z" })))).toBe("prueba");
    expect(reasonOf(mapOrderForInvoice(orderNode({ cancelledAt: "2026-10-14T15:00:00Z", currencyCode: "USD" })))).toBe("anulado");
    expect(reasonOf(mapOrderForInvoice(orderNode({ currencyCode: "USD", totalRefundedSet: amt("1.0") })))).toBe("moneda");
    expect(reasonOf(mapOrderForInvoice(orderNode({ totalRefundedSet: amt("1.0"), edited: true })))).toBe("reembolsado");
    expect(reasonOf(mapOrderForInvoice(orderNode({ edited: true, totalTipReceivedSet: amt("1.0") })))).toBe("editado");
    expect(
      reasonOf(mapOrderForInvoice(orderNode({ totalTipReceivedSet: amt("1.0"), taxesIncluded: false, totalTaxSet: amt("1.0") }))),
    ).toBe("propina");
    expect(
      reasonOf(
        mapOrderForInvoice(
          orderNode({
            taxesIncluded: false,
            totalTaxSet: amt("1.0"),
            lineItems: { pageInfo: { hasNextPage: true }, nodes: [lineNode({ isGiftCard: true })] },
          }),
        ),
      ),
    ).toBe("impuesto_encima");
  });

  it("sin IGV incluido pero sin impuesto, sí se emite", () => {
    expect(mapOrderForInvoice(orderNode({ taxesIncluded: false, totalTaxSet: amt("0.0") })).ok).toBe(true);
  });

  it("con IGV incluido, el impuesto no se mira", () => {
    expect(mapOrderForInvoice(orderNode({ taxesIncluded: true, totalTaxSet: null })).ok).toBe(true);
  });

  it("una tarjeta de regalo bloquea", () => {
    const read = mapOrderForInvoice(
      orderNode({ lineItems: { pageInfo: { hasNextPage: false }, nodes: [lineNode({ isGiftCard: true })] } }),
    );
    expect(read).toMatchObject({ ok: false, reason: "gift_card" });
  });

  it("una cantidad cambiada después (currentQuantity) bloquea", () => {
    const read = mapOrderForInvoice(
      orderNode({ lineItems: { pageInfo: { hasNextPage: false }, nodes: [lineNode({ quantity: 2, currentQuantity: 1 })] } }),
    );
    expect(read).toMatchObject({ ok: false, reason: "cantidad_editada" });
  });

  it("una línea gratis bloquea y dice cuál, sin datos de la clienta", () => {
    const read = mapOrderForInvoice(
      withTotal("10.0", {
        lineItems: {
          pageInfo: { hasNextPage: false },
          nodes: [lineNode({ discountAllocations: [{ allocatedAmountSet: amt("89.9") }] })],
        },
      }),
    );
    expect(read).toEqual({ ok: false, reason: "linea_gratuita", detail: "Línea «Faja Reductora Colombiana»." });
  });

  it("una línea con descuento mayor que su precio es gratuita, no negativa", () => {
    const read = mapOrderForInvoice(
      withTotal("10.0", {
        lineItems: {
          pageInfo: { hasNextPage: false },
          nodes: [lineNode({ discountAllocations: [{ allocatedAmountSet: amt("95.0") }] })],
        },
      }),
    );
    expect(reasonOf(read)).toBe("linea_gratuita");
  });

  it("una línea de 2 céntimos entre 3 unidades no tiene precio unitario: bloquea", () => {
    const read = mapOrderForInvoice(
      withTotal("0.02", {
        lineItems: {
          pageInfo: { hasNextPage: false },
          nodes: [lineNode({ quantity: 3, currentQuantity: 3, originalUnitPriceSet: amt("0.01"), discountAllocations: [{ allocatedAmountSet: amt("0.01") }] })],
        },
        shippingLines: { nodes: [] },
      }),
    );
    expect(reasonOf(read)).toBe("linea_gratuita");
  });

  it("un envío quitado o cambiado bloquea, aunque fuera gratis", () => {
    const read = mapOrderForInvoice(
      orderNode({
        shippingLines: {
          nodes: [shippingNode(), shippingNode({ title: "Envío Express", isRemoved: true, discountedPriceSet: amt("0.0") })],
        },
      }),
    );
    expect(reasonOf(read)).toBe("envio_editado");
  });

  it("si el detalle no suma el total, no cuadra", () => {
    const read = mapOrderForInvoice(withTotal("120.0"));
    expect(read).toEqual({
      ok: false,
      reason: "no_cuadra",
      detail: "El detalle suma S/ 99.90; Shopify dice S/ 120.00 (al crearse, S/ 120.00).",
    });
  });

  it("el total actual y el original tienen que ser el mismo", () => {
    expect(reasonOf(mapOrderForInvoice(orderNode({ currentTotalPriceSet: pen("89.9") })))).toBe("no_cuadra");
    expect(reasonOf(mapOrderForInvoice(orderNode({ totalPriceSet: pen("89.9") })))).toBe("no_cuadra");
  });

  it("un pedido sin líneas no cuadra", () => {
    expect(reasonOf(mapOrderForInvoice(orderNode({ lineItems: { pageInfo: { hasNextPage: false }, nodes: [] } })))).toBe(
      "no_cuadra",
    );
  });

  it.each<[string, Node]>([
    ["un monto que no es número", { totalPriceSet: { shopMoney: { amount: "abc", currencyCode: "PEN" } } }],
    ["un monto vacío no es cero", { totalRefundedSet: amt("") }],
    ["un monto null no es cero", { totalTipReceivedSet: { shopMoney: { amount: null } } }],
    ["sin propina en la respuesta", { totalTipReceivedSet: undefined }],
    ["sin `test`", { test: undefined }],
    ["sin `cancelledAt`", { cancelledAt: undefined }],
    ["sin impuesto cuando no va incluido", { taxesIncluded: false, totalTaxSet: null }],
    ["sin netPaymentSet", { netPaymentSet: undefined }],
    ["sin transacciones", { transactions: undefined }],
    ["sin paymentGatewayNames", { paymentGatewayNames: undefined }],
    ["una pasarela que no es texto", { paymentGatewayNames: [FLOW_CHECKOUT, null] }],
    ["sin líneas", { lineItems: undefined }],
    ["sin envíos", { shippingLines: undefined }],
    ["una cantidad que no es entera", { lineItems: { pageInfo: { hasNextPage: false }, nodes: [lineNode({ quantity: 1.5, currentQuantity: 1.5 })] } }],
    ["una cantidad cero", { lineItems: { pageInfo: { hasNextPage: false }, nodes: [lineNode({ quantity: 0, currentQuantity: 0 })] } }],
    ["un descuento negativo", { lineItems: { pageInfo: { hasNextPage: false }, nodes: [lineNode({ discountAllocations: [{ allocatedAmountSet: amt("-5.0") }] })] } }],
    ["una línea sin ningún id", { lineItems: { pageInfo: { hasNextPage: false }, nodes: [lineNode({ sku: null, variant: null, id: null })] } }],
  ])("lectura_fallida: %s", (_label, over) => {
    expect(reasonOf(mapOrderForInvoice(orderNode(over)))).toBe("lectura_fallida");
  });

  it("una línea sin nombre no arma boleta", () => {
    const read = mapOrderForInvoice(
      orderNode({ lineItems: { pageInfo: { hasNextPage: false }, nodes: [lineNode({ title: " " })] } }),
    );
    expect(reasonOf(read)).toBe("sin_boleta");
  });

  it("nunca lanza, venga lo que venga", () => {
    for (const raw of ["texto", 42, [], { id: 1 }, { lineItems: "x" }, true]) {
      expect(() => mapOrderForInvoice(raw)).not.toThrow();
      expect(mapOrderForInvoice(raw).ok).toBe(false);
    }
  });
});

// ── webPrepaidConfirmed ──────────────────────────────────────────────────────

describe("webPrepaidConfirmed", () => {
  /** Una venta aprobada de la pasarela que se diga. */
  const sale = (gateway: unknown, amount = "99.9", over: Node = {}): Node => ({
    kind: "SALE",
    status: "SUCCESS",
    gateway,
    formattedGateway: null,
    test: false,
    amountSet: amt(amount),
    ...over,
  });

  const prepaid = (over: Node = {}) =>
    ok(
      mapOrderForInvoice(
        orderNode({
          displayFinancialStatus: "PAID",
          paymentGatewayNames: [FLOW_CHECKOUT],
          netPaymentSet: amt("99.9"),
          totalOutstandingSet: amt("0.0"),
          transactions: [sale(FLOW_CHECKOUT)],
          ...over,
        }),
      ),
    );

  it("pagado, lo que cobró Flow igual al total, neto igual al total y nada pendiente", () => {
    expect(webPrepaidConfirmed(prepaid())).toBe(true);
  });

  it("el estado se compara sin importar mayúsculas", () => {
    const read = prepaid();
    expect(webPrepaidConfirmed({ ...read, payment: { ...read.payment, financialStatus: "paid" } })).toBe(true);
  });

  it.each<[string, Node]>([
    ["no dice pagado", { displayFinancialStatus: "PARTIALLY_PAID" }],
    ["estado vacío", { displayFinancialStatus: null }],
    ["lo aprobado no llega al total", { transactions: [sale(FLOW_CHECKOUT, "50.0")] }],
    ["la transacción es de prueba", { transactions: [sale(FLOW_CHECKOUT, "99.9", { test: true })] }],
    ["solo autorizado", { transactions: [sale(FLOW_CHECKOUT, "99.9", { kind: "AUTHORIZATION" })] }],
    ["lo neto no es el total", { netPaymentSet: amt("89.9") }],
    ["queda algo pendiente", { totalOutstandingSet: amt("10.0") }],
    ["pagado de más", { totalOutstandingSet: amt("-10.0") }],
    ["marcado a mano, sin transacciones", { paymentGatewayNames: ["manual"], transactions: [] }],
  ])("no confirma: %s", (_label, over) => {
    expect(webPrepaidConfirmed(prepaid(over))).toBe(false);
  });

  // La boleta va al RUC de la cuenta de Flow (§35.2): solo cubre lo que cobró
  // Flow. `classifyPaymentGateway` dice «checkout» con que UNA pasarela sea
  // Flow, así que un pedido Flow + «manual» llega hasta aquí como prepago web.
  describe("solo cuenta el dinero que entró por Flow", () => {
    it("Flow falló y alguien lo marcó pagado a mano por el total: no", () => {
      const read = prepaid({
        paymentGatewayNames: [FLOW_CHECKOUT, "manual"],
        transactions: [sale(FLOW_CHECKOUT, "99.9", { status: "FAILURE" }), sale("manual")],
      });
      expect(read.payment).toMatchObject({ paidCents: 0, otherPaidCents: 9990, netPaymentCents: 9990 });
      expect(webPrepaidConfirmed(read)).toBe(false);
    });

    it("Flow cobró una parte y el resto fue «manual»: no", () => {
      const read = prepaid({
        paymentGatewayNames: [FLOW_CHECKOUT, "manual"],
        transactions: [sale(FLOW_CHECKOUT, "40.0"), sale("manual", "59.9")],
      });
      expect(read.payment).toMatchObject({ paidCents: 4000, otherPaidCents: 5990 });
      expect(webPrepaidConfirmed(read)).toBe(false);
    });

    it("aunque las pasarelas del pedido sean solo Flow, una venta aprobada de otra pasarela bloquea", () => {
      // El nombre del pedido no basta: la transacción dice quién cobró.
      const read = prepaid({ transactions: [sale(FLOW_CHECKOUT, "40.0"), sale("manual", "59.9")] });
      expect(webPrepaidConfirmed(read)).toBe(false);
      const otra = prepaid({ transactions: [sale("manual")] });
      expect(otra.payment).toMatchObject({ paidCents: 0, otherPaidCents: 9990 });
      expect(webPrepaidConfirmed(otra)).toBe(false);
    });

    it("Flow cobró el total y además hay una tarjeta de regalo por S/ 0: no, la pasarela no es solo Flow", () => {
      const read = prepaid({
        paymentGatewayNames: [FLOW_CHECKOUT, "gift_card"],
        transactions: [sale(FLOW_CHECKOUT), sale("gift_card", "0.0")],
      });
      expect(read.payment).toMatchObject({ paidCents: 9990, otherPaidCents: 0 });
      expect(webPrepaidConfirmed(read)).toBe(false);
    });

    it.each<[string, string[]]>([
      ["Flow y «manual»", [FLOW_CHECKOUT, "manual"]],
      ["Flow y contraentrega", [FLOW_CHECKOUT, "Cash on Delivery (COD)"]],
      ["Flow y una pasarela sin nombre", [FLOW_CHECKOUT, ""]],
      ["un «Checkout Flow» que no es el confirmado", ["Checkout Flow"]],
      ["solo «manual»", ["manual"]],
      ["ninguna pasarela", []],
    ])("las pasarelas del pedido son %s: no, aunque las transacciones cuadren", (_label, paymentGatewayNames) => {
      const read = prepaid({ paymentGatewayNames });
      expect(read.payment).toMatchObject({ paidCents: 9990, otherPaidCents: 0 });
      expect(webPrepaidConfirmed(read)).toBe(false);
    });

    it("el nombre de la pasarela del pedido se compara sin tildes, mayúsculas ni espacios de más", () => {
      const read = prepaid({ paymentGatewayNames: ["  checkout flow |  tarjeta, transf., CUOTAS DEBITO "] });
      expect(webPrepaidConfirmed(read)).toBe(true);
    });

    // El texto de `gateway` de una transacción de Flow nunca se ha visto en
    // producción: se acepta el nombre del checkout o la palabra «flow».
    it.each<[string, Node]>([
      ["el nombre del checkout, con tilde", sale(FLOW_CHECKOUT)],
      ["el nombre del checkout, sin tilde", sale("Checkout Flow | Tarjeta, Transf., Cuotas debito")],
      ["el nombre del checkout con la tilde descompuesta (NFD)", sale(FLOW_CHECKOUT.normalize("NFD"))],
      ["solo en formattedGateway", sale(null, "99.9", { formattedGateway: FLOW_CHECKOUT })],
      ["un handle «flow_cl»", sale("flow_cl")],
      ["«Flow» a secas", sale("Flow")],
      ["«FLOW» en formattedGateway y un handle raro en gateway", sale("pasarela_123", "99.9", { formattedGateway: "FLOW" })],
      ["«Flow Chile»", sale("Flow Chile")],
    ])("la transacción es de Flow: %s", (_label, transaction) => {
      const read = prepaid({ transactions: [transaction] });
      expect(read.payment).toMatchObject({ paidCents: 9990, otherPaidCents: 0 });
      expect(webPrepaidConfirmed(read)).toBe(true);
    });

    it.each<[string, Node]>([
      ["«manual»", sale("manual")],
      ["contraentrega", sale("Cash on Delivery (COD)")],
      ["tarjeta de regalo", sale("gift_card")],
      ["sin gateway ni formattedGateway", sale(null)],
      ["un texto vacío", sale("   ", "99.9", { formattedGateway: "" })],
      ["«flow» dentro de otra palabra", sale("overflow_payments", "99.9", { formattedGateway: "Cashflow" })],
      ["otra pasarela", sale("mercado_pago")],
    ])("la transacción NO es de Flow: %s", (_label, transaction) => {
      const read = prepaid({ transactions: [transaction] });
      expect(read.payment).toMatchObject({ paidCents: 0, otherPaidCents: 9990 });
      expect(webPrepaidConfirmed(read)).toBe(false);
    });

    it("un `payment` armado sin otherPaidCents no confirma", () => {
      const read = prepaid();
      const { otherPaidCents: _omitido, ...sinOtro } = read.payment;
      expect(webPrepaidConfirmed({ ...read, payment: sinOtro as typeof read.payment })).toBe(false);
    });
  });
});

// ── La consulta ──────────────────────────────────────────────────────────────

describe("ORDER_FOR_INVOICE_QUERY", () => {
  it("no pide datos protegidos de la clienta", () => {
    const q = ORDER_FOR_INVOICE_QUERY.toLowerCase();
    for (const word of ["customer", "email", "phone", "shippingaddress", "billingaddress", "address"]) {
      expect(q).not.toContain(word);
    }
  });

  it("pide lo que el mapeo necesita para bloquear y cuadrar", () => {
    for (const field of [
      "order(id: $id)",
      "test",
      "edited",
      "taxesIncluded",
      "totalTipReceivedSet",
      "netPaymentSet",
      "totalOutstandingSet",
      "lineItems(first: 100)",
      "pageInfo { hasNextPage }",
      "currentQuantity",
      "isGiftCard",
      "discountAllocations",
      "shippingLines(first: 10, includeRemovals: true)",
      "isRemoved",
      "transactions(first: 20)",
      "gateway",
      "formattedGateway",
    ]) {
      expect(ORDER_FOR_INVOICE_QUERY).toContain(field);
    }
  });
});

// ── fetchOrderForInvoice ─────────────────────────────────────────────────────

interface StoreRead {
  data: unknown;
  error: unknown;
}

/**
 * Un cliente de Supabase que sabe leer una fila de `stores` (`result`) y, si se
 * le dan, una de cada otra tabla (`others`: la foto del pedido y su pedido, MOM
 * §35.10). Sin dato, una tabla devuelve que no hay fila.
 */
function fakeAdmin(result: StoreRead, others: Record<string, StoreRead> = {}) {
  const reads: { table: string; columns: string; filters: [string, unknown][] }[] = [];
  const admin = {
    from(table: string) {
      const read = { table, columns: "", filters: [] as [string, unknown][] };
      reads.push(read);
      const answer = table === "stores" ? result : (others[table] ?? { data: null, error: null });
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

const connected = (): StoreRead => ({
  data: { shopify_domain: "kenku.myshopify.com", shopify_token_enc: "v1:cifrado" },
  error: null,
});

interface Captured {
  url: string;
  headers: Record<string, string>;
  body: { query: string; variables: Record<string, unknown> };
  signal: unknown;
}

function fakeFetch(respond: () => { ok?: boolean; status?: number; payload: unknown }) {
  const calls: Captured[] = [];
  const fetchImpl = (async (url: unknown, init: unknown) => {
    const i = init as { headers: Record<string, string>; body: string; signal?: unknown };
    calls.push({ url: String(url), headers: i.headers, body: JSON.parse(i.body), signal: i.signal });
    const { ok = true, status = 200, payload } = respond();
    return {
      ok,
      status,
      json: async () => payload,
      text: async () => JSON.stringify(payload),
    } as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

describe("fetchOrderForInvoice (fetch y base inyectados)", () => {
  it("lee el pedido con el token de la tienda y lo mapea", async () => {
    const { admin, reads } = fakeAdmin(connected());
    const { fetchImpl, calls } = fakeFetch(() => ({ payload: { data: { order: orderNode() } } }));
    const read = await fetchOrderForInvoice({ storeId: "store-kenku", shopifyOrderId: "6123456789012" }, { admin, fetchImpl });

    expect(ok(read).totalCents).toBe(9990);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://kenku.myshopify.com/admin/api/2025-01/graphql.json");
    expect(calls[0]?.headers["X-Shopify-Access-Token"]).toBe(FAKE_TOKEN);
    expect(calls[0]?.body.query).toBe(ORDER_FOR_INVOICE_QUERY);
    expect(calls[0]?.body.variables).toEqual({ id: "gid://shopify/Order/6123456789012" });
    // Con tope de tiempo: un Shopify colgado no se come el barrido.
    expect(calls[0]?.signal).toBeInstanceOf(AbortSignal);
    // Solo el dominio y el token (y con qué app se conectó): no descifra los
    // demás secretos de la tienda. Kenku es 'interna': una sola lectura, sin
    // nada de la app propia (0271).
    expect(reads).toEqual([
      { table: "stores", columns: "shopify_domain,shopify_token_enc,shopify_app", filters: [["id", "store-kenku"]] },
    ]);
  });

  it("acepta el id como gid", async () => {
    const { admin } = fakeAdmin(connected());
    const { fetchImpl, calls } = fakeFetch(() => ({ payload: { data: { order: orderNode() } } }));
    await fetchOrderForInvoice({ storeId: "s", shopifyOrderId: "gid://shopify/Order/6123456789012" }, { admin, fetchImpl });
    expect(calls[0]?.body.variables).toEqual({ id: "gid://shopify/Order/6123456789012" });
  });

  it("un pedido que Shopify no devuelve es no_encontrado", async () => {
    const { admin } = fakeAdmin(connected());
    const { fetchImpl } = fakeFetch(() => ({ payload: { data: { order: null } } }));
    const read = await fetchOrderForInvoice({ storeId: "s", shopifyOrderId: "6123456789012" }, { admin, fetchImpl });
    expect(read).toEqual({ ok: false, reason: "no_encontrado" });
  });

  it.each<[string, unknown]>([
    ["data null", { data: null }],
    ["data sin order", { data: {} }],
    ["sin data", {}],
  ])("una respuesta sin `order` no es «no existe»: es lectura_fallida (%s)", async (_label, payload) => {
    const { admin } = fakeAdmin(connected());
    const { fetchImpl } = fakeFetch(() => ({ payload }));
    const read = await fetchOrderForInvoice({ storeId: "s", shopifyOrderId: "6123456789012" }, { admin, fetchImpl });
    expect(read).toEqual({ ok: false, reason: "lectura_fallida", detail: "Shopify contestó sin el pedido." });
  });


  it("errores de GraphQL son lectura_fallida, con el código y sin el cuerpo", async () => {
    const { admin } = fakeAdmin(connected());
    const { fetchImpl } = fakeFetch(() => ({
      payload: { errors: [{ message: `Throttled ${FAKE_TOKEN}`, extensions: { code: "THROTTLED" } }] },
    }));
    const read = await fetchOrderForInvoice({ storeId: "s", shopifyOrderId: "6123456789012" }, { admin, fetchImpl });
    expect(read).toEqual({ ok: false, reason: "lectura_fallida", detail: "Shopify devolvió un error (THROTTLED)." });
  });

  it("un HTTP de error es lectura_fallida con el código", async () => {
    const { admin } = fakeAdmin(connected());
    const { fetchImpl } = fakeFetch(() => ({ ok: false, status: 401, payload: { errors: "[API] Invalid API key or access token" } }));
    const read = await fetchOrderForInvoice({ storeId: "s", shopifyOrderId: "6123456789012" }, { admin, fetchImpl });
    expect(read).toEqual({ ok: false, reason: "lectura_fallida", detail: "Shopify contestó HTTP 401." });
  });

  it("una red caída es lectura_fallida y no lanza", async () => {
    const { admin } = fakeAdmin(connected());
    const fetchImpl = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const read = await fetchOrderForInvoice({ storeId: "s", shopifyOrderId: "6123456789012" }, { admin, fetchImpl });
    expect(read).toEqual({ ok: false, reason: "lectura_fallida", detail: "No se pudo conectar con Shopify." });
  });

  it("un tiempo agotado es lectura_fallida", async () => {
    const { admin } = fakeAdmin(connected());
    const fetchImpl = (async () => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    }) as unknown as typeof fetch;
    const read = await fetchOrderForInvoice({ storeId: "s", shopifyOrderId: "6123456789012" }, { admin, fetchImpl });
    expect(read).toEqual({ ok: false, reason: "lectura_fallida", detail: "Shopify no respondió a tiempo." });
  });

  it("si Shopify devuelve otro pedido, no se usa", async () => {
    const { admin } = fakeAdmin(connected());
    const { fetchImpl } = fakeFetch(() => ({ payload: { data: { order: orderNode({ id: "gid://shopify/Order/999" }) } } }));
    const read = await fetchOrderForInvoice({ storeId: "s", shopifyOrderId: "6123456789012" }, { admin, fetchImpl });
    expect(read).toEqual({ ok: false, reason: "lectura_fallida", detail: "Shopify devolvió otro pedido." });
  });

  it("los bloqueos del mapeo llegan tal cual", async () => {
    const { admin } = fakeAdmin(connected());
    const { fetchImpl } = fakeFetch(() => ({ payload: { data: { order: orderNode({ edited: true }) } } }));
    const read = await fetchOrderForInvoice({ storeId: "s", shopifyOrderId: "6123456789012" }, { admin, fetchImpl });
    expect(reasonOf(read)).toBe("editado");
  });

  it.each<[string, StoreRead]>([
    ["sin token", { data: { shopify_domain: "kenku.myshopify.com", shopify_token_enc: null }, error: null }],
    ["sin dominio", { data: { shopify_domain: " ", shopify_token_enc: "v1:cifrado" }, error: null }],
    ["la tienda no existe", { data: null, error: null }],
  ])("sin_token_shopify (%s) y no llama a Shopify", async (_label, store) => {
    const { admin } = fakeAdmin(store);
    const { fetchImpl, calls } = fakeFetch(() => ({ payload: { data: { order: orderNode() } } }));
    const read = await fetchOrderForInvoice({ storeId: "s", shopifyOrderId: "6123456789012" }, { admin, fetchImpl });
    expect(read).toEqual({ ok: false, reason: "sin_token_shopify" });
    expect(calls).toHaveLength(0);
  });

  it.each<[string, StoreRead]>([
    ["la base falló", { data: null, error: { message: "connection reset" } }],
    ["el token no se descifra", { data: { shopify_domain: "kenku.myshopify.com", shopify_token_enc: "v1:roto" }, error: null }],
  ])("lectura_fallida si %s, y no llama a Shopify", async (_label, store) => {
    const { admin } = fakeAdmin(store);
    const { fetchImpl, calls } = fakeFetch(() => ({ payload: { data: { order: orderNode() } } }));
    const read = await fetchOrderForInvoice({ storeId: "s", shopifyOrderId: "6123456789012" }, { admin, fetchImpl });
    expect(read).toEqual({
      ok: false,
      reason: "lectura_fallida",
      detail: "No se pudo leer la conexión de la tienda con Shopify.",
    });
    expect(calls).toHaveLength(0);
  });

  it("sin id de Shopify no pregunta nada", async () => {
    const { admin, reads } = fakeAdmin(connected());
    const { fetchImpl, calls } = fakeFetch(() => ({ payload: { data: { order: orderNode() } } }));
    const read = await fetchOrderForInvoice({ storeId: "s", shopifyOrderId: "" }, { admin, fetchImpl });
    expect(reasonOf(read)).toBe("no_encontrado");
    expect(reads).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });

  it("el token nunca aparece en un motivo", async () => {
    const { admin } = fakeAdmin(connected());
    const payloads: Array<{ ok?: boolean; status?: number; payload: unknown }> = [
      { payload: { errors: [{ message: FAKE_TOKEN }] } },
      { ok: false, status: 500, payload: { error: FAKE_TOKEN } },
      { payload: { data: { order: orderNode({ totalPriceSet: { shopMoney: { amount: FAKE_TOKEN, currencyCode: "PEN" } } }) } } },
    ];
    for (const p of payloads) {
      const { fetchImpl } = fakeFetch(() => p);
      const read = await fetchOrderForInvoice({ storeId: "s", shopifyOrderId: "6123456789012" }, { admin, fetchImpl });
      expect(read.ok).toBe(false);
      expect(JSON.stringify(read)).not.toContain(FAKE_TOKEN);
    }
  });
});

// ── La foto del pedido (MOM §35.10, owner 23-10-2026) ────────────────────────
//
// Shopify cierra Kenku Perú y Aurela el 28-10-2026. Si la tienda ya no tiene
// token, o Shopify contesta por ella que ya no está (401, 402, 403, 404, 423),
// la boleta sale de la foto del pedido que se tomó mientras Shopify respondía,
// con el mismo mapeo, y la lectura lo dice. Con Shopify funcionando no se mira
// la foto. Un pedido de WooCommerce nunca sale de una foto.

describe("fetchOrderForInvoice: la foto del pedido", () => {
  const ID = "6123456789012";
  const GID = `gid://shopify/Order/${ID}`;
  const FETCHED_AT = "2026-10-26T20:04:31.000Z";

  /** La foto: el `data` de la respuesta tal cual (`{ order }`), de un pedido de Shopify. */
  const snapshotOf = (order: unknown, over: Record<string, unknown> = {}): Record<string, StoreRead> => ({
    order_invoice_snapshots: {
      data: { order_id: "ord-1", payload: { order }, fetched_at: FETCHED_AT, ...over },
      error: null,
    },
    orders: { data: { platform: "shopify", shopify_order_id: ID }, error: null },
  });

  const sinToken = (): StoreRead => ({
    data: { shopify_domain: "kenku.myshopify.com", shopify_token_enc: null },
    error: null,
  });

  it("sin token: la boleta sale de la foto, lo dice, y no llama a Shopify", async () => {
    const { admin, reads } = fakeAdmin(sinToken(), snapshotOf(orderNode()));
    const { fetchImpl, calls } = fakeFetch(() => ({ payload: { data: { order: orderNode() } } }));

    const read = await fetchOrderForInvoice({ storeId: "store-kenku", shopifyOrderId: ID }, { admin, fetchImpl });

    expect(calls).toHaveLength(0);
    expect(ok(read).totalCents).toBe(9990);
    expect(ok(read).items).toEqual(ok(mapOrderForInvoice(orderNode())).items);
    expect(ok(read).snapshot).toEqual({ fetchedAt: FETCHED_AT });
    // La foto se busca por la tienda y el gid; la plataforma, en el pedido.
    expect(reads.map((r) => [r.table, r.filters])).toEqual([
      ["stores", [["id", "store-kenku"]]],
      ["order_invoice_snapshots", [["store_id", "store-kenku"], ["shopify_order_gid", GID]]],
      ["orders", [["id", "ord-1"], ["store_id", "store-kenku"]]],
    ]);
  });

  it.each([401, 402, 403, 404, 423])("desde el cierre, Shopify contesta HTTP %i por la tienda: sale de la foto", async (status) => {
    const { admin } = fakeAdmin(connected(), snapshotOf(orderNode()));
    const { fetchImpl, calls } = fakeFetch(() => ({ ok: false, status, payload: { errors: "Unavailable Shop" } }));

    const read = await fetchOrderForInvoice(
      { storeId: "store-kenku", shopifyOrderId: ID },
      { admin, fetchImpl, now: () => Date.parse(SHOPIFY_SHUTDOWN_AT) },
    );

    expect(calls).toHaveLength(1);
    expect(ok(read).snapshot).toEqual({ fetchedAt: FETCHED_AT });
  });

  // Con Shopify vivo (antes del 28-10-2026 00:00 UTC), un 401 por un token
  // revocado al reinstalar, un 403 o un 423 son un problema que se arregla: la
  // boleta se queda en `lectura_fallida` como siempre y la foto no se mira,
  // aunque exista. Solo vaciar el token la abre antes del cierre.
  it.each([401, 402, 403, 404, 423])("antes del cierre, un HTTP %i no usa la foto: lectura_fallida como siempre", async (status) => {
    const { admin, reads } = fakeAdmin(connected(), snapshotOf(orderNode()));
    const { fetchImpl } = fakeFetch(() => ({ ok: false, status, payload: { errors: "Unavailable Shop" } }));
    const justBefore = Date.parse(SHOPIFY_SHUTDOWN_AT) - 1;

    const read = await fetchOrderForInvoice(
      { storeId: "store-kenku", shopifyOrderId: ID },
      { admin, fetchImpl, now: () => justBefore },
    );

    expect(read).toEqual({ ok: false, reason: "lectura_fallida", detail: `Shopify contestó HTTP ${status}.` });
    expect(reads.map((r) => r.table)).toEqual(["stores"]);
  });

  it("el cierre de la foto es el de Shopify, sin margen", () => {
    expect(SNAPSHOT_FALLBACK_FROM).toBe(SHOPIFY_SHUTDOWN_AT);
    expect(SHOPIFY_SHUTDOWN_AT).toBe("2026-10-28T00:00:00.000Z");
    expect(isAfterShopifyShutdown(Date.parse("2026-10-27T23:59:59.999Z"))).toBe(false);
    expect(isAfterShopifyShutdown(Date.parse("2026-10-28T00:00:00.000Z"))).toBe(true);
  });

  it.each<[string, () => { fetchImpl: typeof fetch }]>([
    ["un 5xx", () => fakeFetch(() => ({ ok: false, status: 503, payload: {} }))],
    ["un error de GraphQL", () => fakeFetch(() => ({ payload: { errors: [{ extensions: { code: "THROTTLED" } }] } }))],
    [
      "un tiempo agotado",
      () => ({
        fetchImpl: (async () => {
          throw new DOMException("timeout", "TimeoutError");
        }) as unknown as typeof fetch,
      }),
    ],
    [
      "una red caída",
      () => ({
        fetchImpl: (async () => {
          throw new TypeError("fetch failed");
        }) as unknown as typeof fetch,
      }),
    ],
  ])("con %s no se mira la foto: se reintenta como siempre", async (_label, make) => {
    const { admin, reads } = fakeAdmin(connected(), snapshotOf(orderNode()));
    const read = await fetchOrderForInvoice({ storeId: "s", shopifyOrderId: ID }, { admin, fetchImpl: make().fetchImpl });
    expect(reasonOf(read)).toBe("lectura_fallida");
    expect(reads.map((r) => r.table)).toEqual(["stores"]);
  });

  it("con Shopify funcionando se lee en vivo, aunque haya foto", async () => {
    const { admin, reads } = fakeAdmin(connected(), snapshotOf(orderNode({ edited: true })));
    const { fetchImpl } = fakeFetch(() => ({ payload: { data: { order: orderNode() } } }));
    const read = await fetchOrderForInvoice({ storeId: "s", shopifyOrderId: ID }, { admin, fetchImpl });
    expect(ok(read).snapshot).toBeUndefined();
    expect(reads.map((r) => r.table)).toEqual(["stores"]);
  });

  it("sin foto, el motivo es el de siempre", async () => {
    const { admin } = fakeAdmin(sinToken());
    expect(await fetchOrderForInvoice({ storeId: "s", shopifyOrderId: ID }, { admin })).toEqual({
      ok: false,
      reason: "sin_token_shopify",
    });
    const { admin: admin402 } = fakeAdmin(connected());
    const { fetchImpl } = fakeFetch(() => ({ ok: false, status: 402, payload: {} }));
    expect(await fetchOrderForInvoice({ storeId: "s", shopifyOrderId: ID }, { admin: admin402, fetchImpl })).toEqual({
      ok: false,
      reason: "lectura_fallida",
      detail: "Shopify contestó HTTP 402.",
    });
  });

  it("sin la 0275 (la tabla no existe), igual que sin foto", async () => {
    const { admin } = fakeAdmin(sinToken(), {
      order_invoice_snapshots: {
        data: null,
        error: { code: "PGRST205", message: "Could not find the table 'public.order_invoice_snapshots' in the schema cache" },
      },
    });
    expect(await fetchOrderForInvoice({ storeId: "s", shopifyOrderId: ID }, { admin })).toEqual({
      ok: false,
      reason: "sin_token_shopify",
    });
  });

  describe("un pedido de WooCommerce nunca sale de una foto", () => {
    it("lo dice `orders.platform`", async () => {
      const snap = snapshotOf(orderNode());
      snap.orders = { data: { platform: "woocommerce", shopify_order_id: ID }, error: null };
      const { admin } = fakeAdmin(sinToken(), snap);
      expect(await fetchOrderForInvoice({ storeId: "s", shopifyOrderId: ID }, { admin })).toEqual({
        ok: false,
        reason: "sin_token_shopify",
      });
    });

    it("un id de WooCommerce ni siquiera busca foto, aunque `extractNumericId` le saque un número", async () => {
      const { admin, reads } = fakeAdmin(sinToken(), snapshotOf(orderNode()));
      const read = await fetchOrderForInvoice({ storeId: "s", shopifyOrderId: "wc-kp-1532" }, { admin });
      expect(read).toEqual({ ok: false, reason: "sin_token_shopify" });
      expect(reads.map((r) => r.table)).toEqual(["stores"]);
    });

    it("tampoco si el pedido de la foto ya no es el de ese número, o no está", async () => {
      const otro = snapshotOf(orderNode());
      otro.orders = { data: { platform: "shopify", shopify_order_id: "999" }, error: null };
      expect(await fetchOrderForInvoice({ storeId: "s", shopifyOrderId: ID }, { admin: fakeAdmin(sinToken(), otro).admin })).toEqual({
        ok: false,
        reason: "sin_token_shopify",
      });
      const ninguno = snapshotOf(orderNode());
      ninguno.orders = { data: null, error: null };
      expect(
        await fetchOrderForInvoice({ storeId: "s", shopifyOrderId: ID }, { admin: fakeAdmin(sinToken(), ninguno).admin }),
      ).toEqual({ ok: false, reason: "sin_token_shopify" });
    });
  });

  it("los bloqueos salen de la foto con su fecha (hora de Lima)", async () => {
    const editado = await fetchOrderForInvoice(
      { storeId: "s", shopifyOrderId: ID },
      { admin: fakeAdmin(sinToken(), snapshotOf(orderNode({ edited: true }))).admin },
    );
    expect(editado).toEqual({ ok: false, reason: "editado", detail: "Foto del pedido del 26/10/2026 15:04." });

    const noDevuelto = await fetchOrderForInvoice(
      { storeId: "s", shopifyOrderId: ID },
      { admin: fakeAdmin(sinToken(), snapshotOf(null)).admin },
    );
    expect(noDevuelto).toEqual({ ok: false, reason: "no_encontrado", detail: "Foto del pedido del 26/10/2026 15:04." });

    const ilegible = await fetchOrderForInvoice(
      { storeId: "s", shopifyOrderId: ID },
      { admin: fakeAdmin(sinToken(), snapshotOf(orderNode({ test: "no" }))).admin },
    );
    expect(ilegible).toEqual({
      ok: false,
      reason: "lectura_fallida",
      detail: "Foto del pedido del 26/10/2026 15:04: Shopify devolvió un dato ilegible: test.",
    });
  });

  it("una foto de otro pedido no se usa", async () => {
    const { admin } = fakeAdmin(sinToken(), snapshotOf(orderNode({ id: "gid://shopify/Order/999" })));
    expect(await fetchOrderForInvoice({ storeId: "s", shopifyOrderId: ID }, { admin })).toEqual({
      ok: false,
      reason: "lectura_fallida",
      detail: "Foto del pedido del 26/10/2026 15:04: es de otro pedido.",
    });
  });

  it.each<[string, Record<string, StoreRead>, string]>([
    [
      "la foto no se pudo leer",
      { order_invoice_snapshots: { data: null, error: { code: "57014", message: "canceling statement" } } },
      "No se pudo leer la foto del pedido.",
    ],
    [
      "la foto no tiene la forma de la 0275",
      { order_invoice_snapshots: { data: { order_id: "ord-1", payload: [1], fetched_at: FETCHED_AT }, error: null } },
      "La foto del pedido no se entiende.",
    ],
    [
      "el pedido de la foto no se pudo leer",
      {
        ...snapshotOf(orderNode()),
        orders: { data: null, error: { code: "57014", message: "canceling statement" } },
      },
      "No se pudo leer el pedido de la foto.",
    ],
  ])("si %s: lectura_fallida, se reintenta", async (_label, others, detail) => {
    const { admin } = fakeAdmin(sinToken(), others);
    expect(await fetchOrderForInvoice({ storeId: "s", shopifyOrderId: ID }, { admin })).toEqual({
      ok: false,
      reason: "lectura_fallida",
      detail,
    });
  });
});
