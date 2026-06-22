import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import {
  verifyShopifyHmac,
  parseTags,
  noteAttributesToMap,
  extractNumericId,
  deriveOrderFlags,
  mapRestOrder,
  mapGraphqlOrder,
  buildKapsoOrdersSearchQuery,
  shopifyGraphQL,
  fetchOrdersPage,
  sumRestRefunds,
} from "@/lib/shopify";

const SECRET = "shpss_test_secret_key";

function sign(body: string, secret = SECRET): string {
  return createHmac("sha256", secret).update(body, "utf8").digest("base64");
}

describe("verifyShopifyHmac", () => {
  const body = JSON.stringify({ id: 123, name: "#1001" });

  it("accepts a correctly signed body", () => {
    expect(verifyShopifyHmac(body, sign(body), SECRET)).toBe(true);
  });

  it("rejects a tampered body", () => {
    const tampered = body + " ";
    expect(verifyShopifyHmac(tampered, sign(body), SECRET)).toBe(false);
  });

  it("rejects a wrong secret", () => {
    expect(verifyShopifyHmac(body, sign(body), "other-secret")).toBe(false);
  });

  it("rejects missing header or secret", () => {
    expect(verifyShopifyHmac(body, null, SECRET)).toBe(false);
    expect(verifyShopifyHmac(body, sign(body), null)).toBe(false);
  });

  it("works on Buffer bodies (raw request body)", () => {
    const buf = Buffer.from(body, "utf8");
    expect(verifyShopifyHmac(buf, sign(body), SECRET)).toBe(true);
  });
});

describe("small helpers", () => {
  it("parseTags handles comma strings and arrays", () => {
    expect(parseTags("kapso, whatsapp , promo-whatsapp")).toEqual([
      "kapso",
      "whatsapp",
      "promo-whatsapp",
    ]);
    expect(parseTags(["a", " b "])).toEqual(["a", "b"]);
    expect(parseTags(null)).toEqual([]);
  });

  it("noteAttributesToMap supports REST {name} and GraphQL {key}", () => {
    expect(
      noteAttributesToMap([
        { name: "kapso_conversation_id", value: "conv_1" },
        { key: "Source", value: "whatsapp-bot" },
      ]),
    ).toEqual({ kapso_conversation_id: "conv_1", source: "whatsapp-bot" });
  });

  it("extractNumericId pulls the id from a GID", () => {
    expect(extractNumericId("gid://shopify/Order/820982911946154508")).toBe(
      "820982911946154508",
    );
    expect(extractNumericId(12345)).toBe("12345");
    expect(extractNumericId(null)).toBe("");
  });

  it("deriveOrderFlags reads promo/stock/shipping/conversation", () => {
    const flags = deriveOrderFlags(
      ["kapso", "whatsapp", "promo-whatsapp", "stock-por-validar"],
      { shipping_mode: "agencia", kapso_conversation_id: "conv_9" },
    );
    expect(flags).toEqual({
      promo_applied: true,
      stock_por_validar: true,
      shipping_mode: "agency",
      kapso_conversation_id: "conv_9",
    });
  });
});

describe("mapRestOrder", () => {
  const payload = {
    id: 5678901234567, // realistic 13-digit Shopify order id (within 2^53)
    name: "#1001",
    created_at: "2026-06-20T10:00:00-05:00",
    processed_at: "2026-06-20T10:01:00-05:00",
    updated_at: "2026-06-20T10:05:00-05:00",
    total_price: "199.90",
    currency: "PEN",
    financial_status: "paid",
    tags: "kapso, whatsapp, promo-whatsapp",
    note_attributes: [
      { name: "kapso_conversation_id", value: "conv_abc" },
      { name: "kapso_phone_number_id", value: "pn_1" },
      { name: "source", value: "whatsapp-bot" },
    ],
    line_items: [
      { title: "Polo Aurela", quantity: 2, sku: "POLO-1", product_id: 1, variant_id: 11, price: "59.95" },
      { title: "Gorro", quantity: 1, sku: "GORRO", product_id: 2, variant_id: 22, price: "80.00" },
    ],
  };

  it("maps core + derived fields", () => {
    const row = mapRestOrder(payload, "store-1");
    expect(row.store_id).toBe("store-1");
    expect(row.shopify_order_id).toBe("5678901234567");
    expect(row.name).toBe("#1001");
    expect(row.total_amount).toBe(199.9);
    expect(row.currency).toBe("PEN");
    expect(row.financial_status).toBe("paid");
    expect(row.tags).toContain("promo-whatsapp");
    expect(row.promo_applied).toBe(true);
    expect(row.stock_por_validar).toBe(false);
    expect(row.kapso_conversation_id).toBe("conv_abc");
    expect(row.line_items).toHaveLength(2);
    expect(row.line_items[0]).toMatchObject({ title: "Polo Aurela", quantity: 2, price: 59.95 });
  });
});

describe("mapGraphqlOrder", () => {
  const node = {
    id: "gid://shopify/Order/55",
    name: "#2002",
    createdAt: "2026-06-21T12:00:00Z",
    updatedAt: "2026-06-21T12:30:00Z",
    displayFinancialStatus: "PAID",
    currentTotalPriceSet: { shopMoney: { amount: "250.00", currencyCode: "PEN" } },
    tags: ["kapso", "stock-por-validar", "contraentrega"],
    customAttributes: [{ key: "kapso_conversation_id", value: "conv_77" }],
    lineItems: {
      edges: [
        {
          node: {
            title: "Zapatos",
            quantity: 1,
            sku: "ZAP-1",
            product: { id: "gid://shopify/Product/9" },
            variant: { id: "gid://shopify/ProductVariant/99" },
            originalUnitPriceSet: { shopMoney: { amount: "250.00" } },
          },
        },
      ],
    },
  };

  it("maps GID, financial status, money set and line items", () => {
    const row = mapGraphqlOrder(node, "store-2");
    expect(row.shopify_order_id).toBe("55");
    expect(row.financial_status).toBe("paid");
    expect(row.total_amount).toBe(250);
    expect(row.currency).toBe("PEN");
    expect(row.stock_por_validar).toBe(true);
    expect(row.shipping_mode).toBe("cod");
    expect(row.kapso_conversation_id).toBe("conv_77");
    expect(row.line_items[0]).toMatchObject({
      title: "Zapatos",
      product_id: "9",
      variant_id: "99",
      price: 250,
    });
  });
});

describe("refunds & cancellations", () => {
  it("mapRestOrder reads cancelled_at and sums refund transactions (ignores voids)", () => {
    const row = mapRestOrder(
      {
        id: 5,
        total_price: "300.00",
        cancelled_at: "2026-06-21T00:00:00Z",
        refunds: [
          { transactions: [{ kind: "refund", amount: "30.00" }, { kind: "refund", amount: "20.00" }] },
          { transactions: [{ kind: "void", amount: "999" }] },
        ],
      },
      "s1",
    );
    expect(row.cancelled_at).toBe("2026-06-21T00:00:00Z");
    expect(row.total_amount).toBe(300);
    expect(row.total_refunded).toBe(50);
  });

  it("mapGraphqlOrder reads cancelledAt, gross total (totalPriceSet) and totalRefundedSet", () => {
    const row = mapGraphqlOrder(
      {
        id: "gid://shopify/Order/9",
        totalPriceSet: { shopMoney: { amount: "300.00", currencyCode: "PEN" } },
        currentTotalPriceSet: { shopMoney: { amount: "250.00", currencyCode: "PEN" } },
        totalRefundedSet: { shopMoney: { amount: "50.00" } },
        cancelledAt: "2026-06-21T00:00:00Z",
        tags: ["kapso"],
        lineItems: { edges: [] },
      },
      "s2",
    );
    expect(row.total_amount).toBe(300); // gross, not the current (post-refund) total
    expect(row.total_refunded).toBe(50);
    expect(row.cancelled_at).toBe("2026-06-21T00:00:00Z");
  });

  it("sumRestRefunds handles missing/empty inputs", () => {
    expect(sumRestRefunds(undefined)).toBe(0);
    expect(sumRestRefunds([])).toBe(0);
    expect(sumRestRefunds([{ transactions: [{ kind: "refund", amount: "12.50" }] }])).toBe(12.5);
  });
});

describe("buildKapsoOrdersSearchQuery", () => {
  it("base query without cursor", () => {
    expect(buildKapsoOrdersSearchQuery()).toBe("tag:kapso");
  });
  it("bounded by updated_at cursor", () => {
    expect(buildKapsoOrdersSearchQuery("2026-06-01T00:00:00Z")).toBe(
      "tag:kapso updated_at:>=2026-06-01T00:00:00Z",
    );
  });
});

describe("shopifyGraphQL client (injected fetch)", () => {
  function fakeFetch(payload: unknown, ok = true, status = 200): typeof fetch {
    return (async () =>
      ({
        ok,
        status,
        json: async () => payload,
        text: async () => JSON.stringify(payload),
      }) as Response) as unknown as typeof fetch;
  }

  it("returns data on success", async () => {
    const data = await shopifyGraphQL({
      domain: "aurela.myshopify.com",
      token: "t",
      query: "{ shop { name } }",
      fetchImpl: fakeFetch({ data: { shop: { name: "Aurela" } } }),
    });
    expect(data).toEqual({ shop: { name: "Aurela" } });
  });

  it("throws on GraphQL errors", async () => {
    await expect(
      shopifyGraphQL({
        domain: "aurela.myshopify.com",
        token: "t",
        query: "{ bad }",
        fetchImpl: fakeFetch({ errors: [{ message: "boom" }] }),
      }),
    ).rejects.toThrow(/boom/);
  });

  it("throws on HTTP error", async () => {
    await expect(
      shopifyGraphQL({
        domain: "aurela.myshopify.com",
        token: "t",
        query: "{ x }",
        fetchImpl: fakeFetch({ error: "nope" }, false, 401),
      }),
    ).rejects.toThrow(/HTTP 401/);
  });

  it("fetchOrdersPage maps nodes + paging + maxUpdatedAt", async () => {
    const resp = {
      data: {
        orders: {
          edges: [
            {
              cursor: "c1",
              node: {
                id: "gid://shopify/Order/1",
                name: "#1",
                updatedAt: "2026-06-10T00:00:00Z",
                currentTotalPriceSet: { shopMoney: { amount: "10.00", currencyCode: "PEN" } },
                tags: ["kapso"],
                lineItems: { edges: [] },
              },
            },
            {
              cursor: "c2",
              node: {
                id: "gid://shopify/Order/2",
                name: "#2",
                updatedAt: "2026-06-12T00:00:00Z",
                currentTotalPriceSet: { shopMoney: { amount: "20.00", currencyCode: "PEN" } },
                tags: ["kapso"],
                lineItems: { edges: [] },
              },
            },
          ],
          pageInfo: { hasNextPage: true, endCursor: "c2" },
        },
      },
    };
    const page = await fetchOrdersPage({
      domain: "aurela.myshopify.com",
      token: "t",
      storeId: "store-1",
      searchQuery: "tag:kapso",
      fetchImpl: fakeFetch(resp),
    });
    expect(page.orders).toHaveLength(2);
    expect(page.hasNextPage).toBe(true);
    expect(page.endCursor).toBe("c2");
    expect(page.maxUpdatedAt).toBe("2026-06-12T00:00:00Z");
  });
});
