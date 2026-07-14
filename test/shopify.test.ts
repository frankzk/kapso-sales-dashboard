import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import {
  verifyShopifyHmac,
  parseTags,
  parseDiscountCodes,
  hasKapsoTag,
  noteAttributesToMap,
  extractNumericId,
  shopifyOrderAdminUrl,
  shopifyDraftOrderAdminUrl,
  deriveOrderFlags,
  mapRestOrder,
  mapGraphqlOrder,
  mapGraphqlDraftOrder,
  mapRestDraftOrder,
  isCodFormDraft,
  isRecoveredDraft,
  buildDraftOrdersSearchQuery,
  buildKapsoOrdersSearchQuery,
  buildLiveOrderSearchQuery,
  buildExactOrderQuery,
  pickStoresForOrderQuery,
  searchOrdersLive,
  shopifyGraphQL,
  fetchOrdersPage,
  searchProductVariants,
  searchCatalogProducts,
  createDraftOrder,
  getDraftOrderForEdit,
  resolveOrderDiscount,
  resolvePeruProvinceCode,
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

  it("shopifyOrderAdminUrl builds an admin deep-link from domain + gid", () => {
    expect(
      shopifyOrderAdminUrl("aurela.myshopify.com", "gid://shopify/Order/123"),
    ).toBe("https://admin.shopify.com/store/aurela/orders/123");
    // bare numeric id + uppercase domain
    expect(shopifyOrderAdminUrl("AURELA.MYSHOPIFY.COM", 456)).toBe(
      "https://admin.shopify.com/store/aurela/orders/456",
    );
    // missing pieces → null (no link rendered)
    expect(shopifyOrderAdminUrl(null, "123")).toBeNull();
    expect(shopifyOrderAdminUrl("aurela.myshopify.com", null)).toBeNull();
    expect(shopifyOrderAdminUrl("aurela.myshopify.com", "")).toBeNull();
  });

  it("shopifyDraftOrderAdminUrl deep-links the draft in the admin, not the checkout", () => {
    expect(
      shopifyDraftOrderAdminUrl("kenkuperu.myshopify.com", "gid://shopify/DraftOrder/1315710075175"),
    ).toBe("https://admin.shopify.com/store/kenkuperu/draft_orders/1315710075175");
    // missing pieces → null (the UI falls back to the stored invoiceUrl)
    expect(shopifyDraftOrderAdminUrl(null, "gid://shopify/DraftOrder/123")).toBeNull();
    expect(shopifyDraftOrderAdminUrl("kenkuperu.myshopify.com", null)).toBeNull();
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
    discount_codes: [{ code: "aurela10", amount: "19.99", type: "percentage" }],
    note_attributes: [
      { name: "kapso_conversation_id", value: "conv_abc" },
      { name: "kapso_phone_number_id", value: "pn_1" },
      { name: "source", value: "whatsapp-bot" },
    ],
    customer: { phone: "+51 980 694 766" },
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
    expect(row.customer_phone).toBe("51980694766");
    expect(row.line_items).toHaveLength(2);
    expect(row.line_items[0]).toMatchObject({ title: "Polo Aurela", quantity: 2, price: 59.95 });
    expect(row.discount_codes).toEqual(["AURELA10"]); // REST [{code}] → upper-cased
  });

  it("parseDiscountCodes normalizes REST objects and GraphQL strings, deduped", () => {
    expect(parseDiscountCodes([{ code: "aurela10" }, { code: "AURELA10" }])).toEqual(["AURELA10"]);
    expect(parseDiscountCodes(["Promo5", " promo5 "])).toEqual(["PROMO5"]);
    expect(parseDiscountCodes(null)).toEqual([]);
    expect(parseDiscountCodes([{ amount: "5" }])).toEqual([]); // no code field → dropped
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
    discountCodes: ["AURELA10"],
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
    expect(row.discount_codes).toEqual(["AURELA10"]); // GraphQL [String] passthrough
    expect(row.line_items[0]).toMatchObject({
      title: "Zapatos",
      product_id: "9",
      variant_id: "99",
      price: 250,
    });
  });

  it("captures customer_phone (normalized) from order/shipping/billing phone", () => {
    expect(mapGraphqlOrder({ ...node, phone: "+51 980 694 766" }, "s").customer_phone).toBe(
      "51980694766",
    );
    expect(
      mapGraphqlOrder({ ...node, shippingAddress: { phone: "980694766" } }, "s").customer_phone,
    ).toBe("51980694766");
    expect(
      mapGraphqlOrder({ ...node, billingAddress: { phone: "51980694766" } }, "s").customer_phone,
    ).toBe("51980694766");
    expect(mapGraphqlOrder(node, "s").customer_phone).toBeNull(); // no phone fetched → null
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

describe("hasKapsoTag", () => {
  it("true when the kapso tag is present (case-insensitive)", () => {
    expect(hasKapsoTag(["kapso"])).toBe(true);
    expect(hasKapsoTag(["whatsapp", "Kapso", "promo-whatsapp"])).toBe(true);
    expect(hasKapsoTag(["KAPSO"])).toBe(true);
  });
  it("false when absent or empty", () => {
    expect(hasKapsoTag([])).toBe(false);
    expect(hasKapsoTag(["whatsapp", "contraentrega"])).toBe(false);
    expect(hasKapsoTag(["kapso-promo"])).toBe(false); // substring, not the tag
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

describe("buildLiveOrderSearchQuery", () => {
  it("wraps a bare number in name wildcards + a phone fallback (6+ digits)", () => {
    expect(buildLiveOrderSearchQuery("119603")).toBe("name:*119603* OR phone:*119603*");
  });
  it("strips a leading # and adds a digits-only fallback for a prefixed name", () => {
    expect(buildLiveOrderSearchQuery("#KP119603")).toBe(
      "name:*KP119603* OR name:*119603* OR phone:*119603*",
    );
  });
  it("is case-preserving (Shopify text search is case-insensitive)", () => {
    expect(buildLiveOrderSearchQuery("kp119603")).toBe(
      "name:*kp119603* OR name:*119603* OR phone:*119603*",
    );
  });
  it("adds a phone clause only once digits reach 6+", () => {
    expect(buildLiveOrderSearchQuery("51999")).toBe("name:*51999*");
    expect(buildLiveOrderSearchQuery("519990")).toBe("name:*519990* OR phone:*519990*");
  });
});

describe("buildExactOrderQuery", () => {
  it("prefixes the term with # unscoped — mirrors the Shopify admin search box", () => {
    expect(buildExactOrderQuery("KP118200")).toBe("#KP118200");
    expect(buildExactOrderQuery("#KP118200")).toBe("#KP118200");
    expect(buildExactOrderQuery("119603")).toBe("#119603");
  });
});

describe("pickStoresForOrderQuery", () => {
  const aurela = { id: "s1", name: "Aurela" };
  const kenku = { id: "s2", name: "Kenku Peru" };
  const stores = [aurela, kenku];

  it("routes a #KP order to the Kenku store only", () => {
    expect(pickStoresForOrderQuery("#KP118200", stores)).toEqual([kenku]);
    expect(pickStoresForOrderQuery("kp118200", stores)).toEqual([kenku]);
  });
  it("routes a #AUR order to the Aurela store only", () => {
    expect(pickStoresForOrderQuery("#AUR173123", stores)).toEqual([aurela]);
  });
  it("searches every store for a bare number or phone", () => {
    expect(pickStoresForOrderQuery("118200", stores)).toEqual(stores);
    expect(pickStoresForOrderQuery("51930295803", stores)).toEqual(stores);
  });
  it("falls back to every store if the matching store isn't connected", () => {
    expect(pickStoresForOrderQuery("#KP118200", [aurela])).toEqual([aurela]);
  });
});

describe("searchOrdersLive (injected fetch)", () => {
  function fakeFetchByQuery(handler: (query: string) => unknown): typeof fetch {
    return (async (_url: unknown, init: unknown) => {
      const body = JSON.parse(String((init as { body?: string })?.body ?? "{}"));
      const query = String(body?.variables?.query ?? "");
      const payload = handler(query);
      return {
        ok: true,
        status: 200,
        json: async () => payload,
        text: async () => JSON.stringify(payload),
      } as Response;
    }) as unknown as typeof fetch;
  }

  function ordersPage(names: string[]): unknown {
    return {
      data: {
        orders: {
          edges: names.map((name, i) => ({
            cursor: `c${i}`,
            node: {
              id: `gid://shopify/Order/${i}`,
              name,
              tags: [],
              lineItems: { edges: [] },
            },
          })),
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    };
  }

  it("returns the exact # match without falling back to the loose search", async () => {
    let calls = 0;
    const fetchImpl = fakeFetchByQuery((query) => {
      calls++;
      expect(query).toBe("#kp118200");
      return ordersPage(["#KP118200"]);
    });
    const orders = await searchOrdersLive({
      domain: "kenku.myshopify.com",
      token: "t",
      storeId: "store1",
      query: "kp118200",
      fetchImpl,
    });
    expect(calls).toBe(1);
    expect(orders.map((o) => o.name)).toEqual(["#KP118200"]);
  });

  it("falls back to the loose digits/phone search when the exact search finds nothing", async () => {
    const seenQueries: string[] = [];
    const fetchImpl = fakeFetchByQuery((query) => {
      seenQueries.push(query);
      if (query.startsWith("#")) return ordersPage([]);
      return ordersPage(["#118200"]);
    });
    const orders = await searchOrdersLive({
      domain: "kenku.myshopify.com",
      token: "t",
      storeId: "store1",
      query: "118200",
      fetchImpl,
    });
    expect(seenQueries).toEqual(["#118200", "name:*118200* OR phone:*118200*"]);
    expect(orders.map((o) => o.name)).toEqual(["#118200"]);
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

describe("draft orders (Releasit COD)", () => {
  const node = {
    id: "gid://shopify/DraftOrder/777",
    name: "#D7",
    status: "OPEN",
    createdAt: "2026-06-24T10:00:00Z",
    updatedAt: "2026-06-24T10:30:00Z",
    invoiceUrl: "https://aurela.myshopify.com/invoice/x",
    note2: "Releasit COD form",
    tags: ["releasit"],
    totalPriceSet: { shopMoney: { amount: "150.00", currencyCode: "PEN" } },
    customer: { displayName: "Ana P" },
    shippingAddress: { city: "Surco", province: "Lima", address1: "Av Y 1", address2: "Ref: óvalo", name: "Ana P", phone: "+51 980 694 766" },
    order: null,
    lineItems: {
      edges: [{ node: { title: "Polo", quantity: 2, sku: "P1", originalUnitPriceSet: { shopMoney: { amount: "75.00" } } } }],
    },
  };

  it("mapGraphqlDraftOrder maps gid, status, address, money, phone, line items", () => {
    const row = mapGraphqlDraftOrder(node, "s1");
    expect(row.shopify_draft_order_id).toBe("777");
    expect(row.draft_order_gid).toBe("gid://shopify/DraftOrder/777");
    expect(row.status).toBe("open"); // OPEN → lowercased
    expect(row.total_amount).toBe(150);
    expect(row.currency).toBe("PEN");
    expect(row.invoice_url).toBe("https://aurela.myshopify.com/invoice/x");
    expect(row.district).toBe("Surco");
    expect(row.province).toBe("Lima");
    expect(row.region).toBe("Lima");
    expect(row.referencia).toBe("Ref: óvalo");
    expect(row.customer_phone).toBe("51980694766");
    expect(row.customer_name).toBe("Ana P");
    expect(row.line_items[0]).toMatchObject({ title: "Polo", quantity: 2, price: 75 });
  });

  it("mapRestDraftOrder maps a webhook payload (status, address, order_gid)", () => {
    const row = mapRestDraftOrder(
      {
        id: 888,
        admin_graphql_api_id: "gid://shopify/DraftOrder/888",
        name: "#D8",
        status: "completed",
        total_price: "99.00",
        currency: "PEN",
        completed_at: "2026-06-24T11:00:00Z",
        shipping_address: { city: "Lince", province: "Lima", address2: "casa azul", phone: "980694766" },
        line_items: [{ title: "Gorra", quantity: 1, price: "99.00" }],
        order_id: 543,
        note: "Releasit",
      },
      "s2",
    );
    expect(row.shopify_draft_order_id).toBe("888");
    expect(row.status).toBe("completed");
    expect(row.district).toBe("Lince");
    expect(row.referencia).toBe("casa azul");
    expect(row.customer_phone).toBe("51980694766");
    expect(row.order_gid).toBe("gid://shopify/Order/543");
  });

  it("isCodFormDraft: requires a Releasit/EasySell marker (tag or note)", () => {
    const base = mapGraphqlDraftOrder(node, "s"); // has the 'releasit' tag
    expect(isCodFormDraft(base)).toBe(true);
    expect(isCodFormDraft({ ...base, tags: ["easysell_cod_form"], note: null })).toBe(true);
    expect(isCodFormDraft({ ...base, tags: ["easysell-abandoned-checkout"], note: null })).toBe(true);
    expect(isCodFormDraft({ ...base, tags: [], note: null })).toBe(false); // manual/test draft → excluded
  });

  it("buildDraftOrdersSearchQuery bounds open carts by updated_at", () => {
    expect(buildDraftOrdersSearchQuery("open", "2026-06-01T00:00:00Z")).toBe(
      "status:open updated_at:>=2026-06-01T00:00:00Z",
    );
    expect(buildDraftOrdersSearchQuery("completed")).toBe("status:completed");
  });
});

describe("order form (catalog search + draft create/read)", () => {
  function fakeFetch(payload: unknown, ok = true, status = 200): typeof fetch {
    return (async () =>
      ({
        ok,
        status,
        json: async () => payload,
        text: async () => JSON.stringify(payload),
      }) as Response) as unknown as typeof fetch;
  }

  it("searchProductVariants flattens variants with price + stock", async () => {
    const resp = {
      data: {
        products: {
          edges: [
            {
              node: {
                id: "gid://shopify/Product/1",
                title: "Mochila",
                featuredImage: { url: "u" },
                variants: {
                  edges: [
                    { node: { id: "gid://shopify/ProductVariant/11", title: "Default Title", price: "129.90", inventoryQuantity: 5, sku: "M1" } },
                  ],
                },
              },
            },
            {
              node: {
                id: "gid://shopify/Product/2",
                title: "Polo",
                featuredImage: null,
                variants: {
                  edges: [
                    { node: { id: "gid://shopify/ProductVariant/21", title: "Rojo", price: "59.00", inventoryQuantity: 0, sku: "P-R" } },
                  ],
                },
              },
            },
          ],
        },
      },
    };
    const out = await searchProductVariants({ domain: "x.myshopify.com", token: "t", query: "m", fetchImpl: fakeFetch(resp) });
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ variantId: "gid://shopify/ProductVariant/11", title: "Mochila", price: 129.9, inventory: 5 });
    expect(out[1]).toMatchObject({ title: "Polo · Rojo", price: 59, inventory: 0 }); // non-default variant title appended
  });

  it("searchCatalogProducts groups variants under their product", async () => {
    const resp = {
      data: {
        products: {
          edges: [
            {
              node: {
                id: "gid://shopify/Product/1",
                title: "TravelersBackpack",
                featuredImage: { url: "u" },
                variants: {
                  edges: [
                    { node: { id: "gid://shopify/ProductVariant/11", title: "Plomo", price: "219.00", inventoryQuantity: 2, sku: "TB-P" } },
                    { node: { id: "gid://shopify/ProductVariant/12", title: "Negro", price: "219.00", inventoryQuantity: 25, sku: "TB-N" } },
                  ],
                },
              },
            },
            {
              node: {
                id: "gid://shopify/Product/2",
                title: "Polo",
                featuredImage: null,
                variants: {
                  edges: [{ node: { id: "gid://shopify/ProductVariant/21", title: "Default Title", price: "59.00", inventoryQuantity: 3, sku: "P" } }],
                },
              },
            },
          ],
        },
      },
    };
    const out = await searchCatalogProducts({ domain: "x.myshopify.com", token: "t", query: "m", fetchImpl: fakeFetch(resp) });
    expect(out).toHaveLength(2);
    // Product 1: two real variants grouped, titles preserved (no product prefix here).
    expect(out[0]).toMatchObject({ productId: "gid://shopify/Product/1", title: "TravelersBackpack" });
    expect(out[0]!.variants).toHaveLength(2);
    expect(out[0]!.variants[0]).toMatchObject({ variantTitle: "Plomo", price: 219, inventory: 2 });
    expect(out[0]!.variants[1]).toMatchObject({ variantTitle: "Negro", inventory: 25 });
    // Product 2: single default variant → variantTitle normalized to "" (added directly, no second step).
    expect(out[1]!.variants).toHaveLength(1);
    expect(out[1]!.variants[0]!.variantTitle).toBe("");
  });

  it("createDraftOrder returns the gid; throws on userErrors", async () => {
    const ok = { data: { draftOrderCreate: { draftOrder: { id: "gid://shopify/DraftOrder/5", name: "#D5" }, userErrors: [] } } };
    const r = await createDraftOrder({
      domain: "x.myshopify.com",
      token: "t",
      input: { lineItems: [{ variantId: "gid://shopify/ProductVariant/1", quantity: 2, unitPrice: 10 }] },
      fetchImpl: fakeFetch(ok),
    });
    expect(r.gid).toBe("gid://shopify/DraftOrder/5");

    const bad = { data: { draftOrderCreate: { draftOrder: null, userErrors: [{ message: "boom" }] } } };
    await expect(
      createDraftOrder({ domain: "x.myshopify.com", token: "t", input: { lineItems: [] }, fetchImpl: fakeFetch(bad) }),
    ).rejects.toThrow(/boom/);
  });

  it("getDraftOrderForEdit maps line items (variant id + price) and address", async () => {
    const resp = {
      data: {
        draftOrder: {
          id: "gid://shopify/DraftOrder/7",
          name: "#D7",
          shippingAddress: { address1: "Av X 1", address2: "ref", city: "Surco", province: "Lima", name: "Ana" },
          lineItems: {
            edges: [
              { node: { title: "Mochila", quantity: 2, originalUnitPriceSet: { shopMoney: { amount: "60.00" } }, variant: { id: "gid://shopify/ProductVariant/11" } } },
            ],
          },
        },
      },
    };
    const d = await getDraftOrderForEdit({ domain: "x.myshopify.com", token: "t", gid: "gid://shopify/DraftOrder/7", fetchImpl: fakeFetch(resp) });
    expect(d?.lineItems[0]).toMatchObject({ variantId: "gid://shopify/ProductVariant/11", title: "Mochila", quantity: 2, unitPrice: 60 });
    expect(d?.address).toMatchObject({ address1: "Av X 1", city: "Surco", province: "Lima", address2: "ref", name: "Ana" });
  });

  it("createDraftOrder forwards the order-level appliedDiscount into the GraphQL input", async () => {
    let seenBody: any = null;
    const capture = (async (_url: string, init: any) => {
      seenBody = JSON.parse(init.body);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: { draftOrderCreate: { draftOrder: { id: "gid://shopify/DraftOrder/9", name: "#D9" }, userErrors: [] } },
        }),
        text: async () => "",
      } as Response;
    }) as unknown as typeof fetch;
    await createDraftOrder({
      domain: "x.myshopify.com",
      token: "t",
      input: {
        lineItems: [{ variantId: "gid://shopify/ProductVariant/1", quantity: 1, unitPrice: 100 }],
        appliedDiscount: { value: 10, valueType: "PERCENTAGE", title: "Descuento" },
      },
      fetchImpl: capture,
    });
    expect(seenBody.variables.input.appliedDiscount).toEqual({ title: "Descuento", value: 10, valueType: "PERCENTAGE" });
  });

  it("clears the order-level discount (appliedDiscount:null) when none is given — so a recovered cart never inherits a promo that zeroes the total", async () => {
    let seenBody: any = null;
    const capture = (async (_url: string, init: any) => {
      seenBody = JSON.parse(init.body);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: { draftOrderCreate: { draftOrder: { id: "gid://shopify/DraftOrder/9", name: "#D9" }, userErrors: [] } },
        }),
        text: async () => "",
      } as Response;
    }) as unknown as typeof fetch;
    await createDraftOrder({
      domain: "x.myshopify.com",
      token: "t",
      input: { lineItems: [{ variantId: "gid://shopify/ProductVariant/1", quantity: 1, unitPrice: 100 }] },
      fetchImpl: capture,
    });
    expect(seenBody.variables.input.appliedDiscount).toBeNull();
  });
});

describe("resolveOrderDiscount", () => {
  it("leaves the subtotal untouched when there is no (or zero) discount", () => {
    expect(resolveOrderDiscount(120, null)).toEqual({ total: 120, discountAmount: 0, appliedDiscount: null });
    expect(resolveOrderDiscount(120, { kind: "fixed", value: 0 }).appliedDiscount).toBeNull();
  });

  it("applies a percentage discount and maps it to PERCENTAGE (clamped to 100)", () => {
    const r = resolveOrderDiscount(120, { kind: "percent", value: 10 });
    expect(r).toMatchObject({ total: 108, discountAmount: 12 });
    expect(r.appliedDiscount).toEqual({ value: 10, valueType: "PERCENTAGE", title: "Descuento" });
    // > 100% clamps to a full discount → total floors at 0, never negative.
    expect(resolveOrderDiscount(50, { kind: "percent", value: 150 }).total).toBe(0);
  });

  it("applies a fixed-amount discount and maps it to FIXED_AMOUNT (clamped to subtotal)", () => {
    const r = resolveOrderDiscount(120, { kind: "fixed", value: 30 });
    expect(r).toMatchObject({ total: 90, discountAmount: 30 });
    expect(r.appliedDiscount).toEqual({ value: 30, valueType: "FIXED_AMOUNT", title: "Descuento" });
    // A discount bigger than the subtotal floors the total at 0.
    expect(resolveOrderDiscount(40, { kind: "fixed", value: 100 })).toMatchObject({ total: 0, discountAmount: 40 });
  });
});

describe("resolvePeruProvinceCode (province → ISO code so Shopify keeps it)", () => {
  it("maps departamento names to their ISO 3166-2:PE code", () => {
    expect(resolvePeruProvinceCode("Lima")).toBe("LMA");
    expect(resolvePeruProvinceCode("lima")).toBe("LMA");
    expect(resolvePeruProvinceCode("Arequipa")).toBe("ARE");
    expect(resolvePeruProvinceCode("Callao")).toBe("CAL");
    expect(resolvePeruProvinceCode("Cusco")).toBe("CUS");
  });
  it("handles accents and multi-word names", () => {
    expect(resolvePeruProvinceCode("Áncash")).toBe("ANC");
    expect(resolvePeruProvinceCode("Ancash")).toBe("ANC");
    expect(resolvePeruProvinceCode("La Libertad")).toBe("LAL");
    expect(resolvePeruProvinceCode("San Martín")).toBe("SAM");
    expect(resolvePeruProvinceCode("Madre de Dios")).toBe("MDD");
  });
  it("accepts an already-valid code or an ISO 'PE-XXX' form", () => {
    expect(resolvePeruProvinceCode("LMA")).toBe("LMA");
    expect(resolvePeruProvinceCode("PE-LMA")).toBe("LMA");
    expect(resolvePeruProvinceCode("pe-are")).toBe("ARE");
  });
  it("resolves free text that embeds the departamento name", () => {
    expect(resolvePeruProvinceCode("Lima (provincia)")).toBe("LMA");
    expect(resolvePeruProvinceCode("Departamento de Piura")).toBe("PIU");
  });
  it("returns null for empty or unrecognized input (caller keeps the raw value)", () => {
    expect(resolvePeruProvinceCode(null)).toBeNull();
    expect(resolvePeruProvinceCode("")).toBeNull();
    expect(resolvePeruProvinceCode("Provincia Inventada")).toBeNull();
  });
});

describe("isRecoveredDraft (un draft completado solo es recuperación si estuvo abandonado)", () => {
  it("compra COD normal (EasySell completa el draft al instante) → NO es recuperación", () => {
    expect(
      isRecoveredDraft({ createdAt: "2026-07-14T10:00:00Z", completedAt: "2026-07-14T10:02:00Z" }),
    ).toBe(false);
    // 29 min tampoco alcanza (el umbral es 30)
    expect(
      isRecoveredDraft({ createdAt: "2026-07-14T10:00:00Z", completedAt: "2026-07-14T10:29:00Z" }),
    ).toBe(false);
  });

  it("≥30 min abandonado antes de completarse → SÍ es recuperación", () => {
    expect(
      isRecoveredDraft({ createdAt: "2026-07-14T10:00:00Z", completedAt: "2026-07-14T10:30:00Z" }),
    ).toBe(true);
    expect(
      isRecoveredDraft({ createdAt: "2026-07-14T10:00:00Z", completedAt: "2026-07-15T09:00:00Z" }),
    ).toBe(true);
  });

  it("un tag de abandono prueba la recuperación aunque haya completado al instante", () => {
    expect(
      isRecoveredDraft({
        createdAt: "2026-07-14T10:00:00Z",
        completedAt: "2026-07-14T10:01:00Z",
        orderTags: ["easysell-abandoned-checkout", "cod"],
      }),
    ).toBe(true);
  });

  it("sin timestamps no se puede probar el abandono → false (conservador: no inflar ingresos)", () => {
    expect(isRecoveredDraft({ createdAt: null, completedAt: "2026-07-14T10:30:00Z" })).toBe(false);
    expect(isRecoveredDraft({ createdAt: "2026-07-14T10:00:00Z", completedAt: null })).toBe(false);
    expect(isRecoveredDraft({ createdAt: null, completedAt: null, orderTags: ["cod"] })).toBe(false);
  });
});
