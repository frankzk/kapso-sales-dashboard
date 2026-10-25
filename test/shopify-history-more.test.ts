import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BULK_KINDS,
  CHECKOUTS_BULK_QUERY,
  CUSTOMERS_BULK_QUERY,
  DRAFTS_BULK_QUERY,
  HISTORY_API_VERSION,
  ORDERS_BULK_QUERY,
  PRODUCTS_BULK_QUERY,
  bulkQueryFor,
  groupBulkCarts,
  groupBulkCustomers,
  groupBulkProducts,
  mapAttribution,
  mapBulkOrder,
  type JsonlLine,
} from "@/lib/shopify-history-bulk";
import { readImportChunk, type HistoryImportRow, type RowWriter } from "@/lib/shopify-history-import";
import { imageExtension, imageStoragePath } from "@/lib/shopify-history-images";
import type { HistoryProduct, HistoryProductImage } from "@/lib/shopify-history";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");
const lines = (values: object[]): JsonlLine[] => values.map((value, i) => ({ start: i, end: i + 1, value: value as Record<string, unknown> }));

describe("las consultas a Shopify (§37.6)", () => {
  it("hay una por cada tipo, en la versión probada, y ninguna escribe", () => {
    expect(HISTORY_API_VERSION).toBe("2026-10");
    for (const kind of BULK_KINDS) {
      const q = bulkQueryFor(kind);
      expect(q).not.toMatch(/mutation/);
      // Shopify acepta hasta 5 conexiones por archivo.
      expect((q.match(/edges/g) ?? []).length).toBeLessThanOrEqual(5);
    }
    expect(PRODUCTS_BULK_QUERY).toContain("descriptionHtml");
    expect(PRODUCTS_BULK_QUERY).toContain("... on MediaImage { id alt image { url width height } }");
    expect(CHECKOUTS_BULK_QUERY).toContain("abandonedCheckouts");
    expect(DRAFTS_BULK_QUERY).toContain("draftOrders");
  });

  it("desde 2026-10 el correo y el celular del cliente van en defaultEmailAddress y defaultPhoneNumber", () => {
    for (const q of [ORDERS_BULK_QUERY, CUSTOMERS_BULK_QUERY, CHECKOUTS_BULK_QUERY, DRAFTS_BULK_QUERY]) {
      expect(q).toMatch(/defaultEmailAddress \{ emailAddress/);
      expect(q).not.toMatch(/customer \{[^}]*\bemail\b/);
    }
    expect(CUSTOMERS_BULK_QUERY).toContain("smsMarketingConsent { state }");
    expect(CUSTOMERS_BULK_QUERY).toContain("whatsAppMarketingConsent { state }");
    expect(ORDERS_BULK_QUERY).toContain("trackingInfo { company number url }");
    expect(ORDERS_BULK_QUERY).toContain("customerJourneySummary");
  });
});

describe("pedidos con más detalle", () => {
  it("método de envío, guías, devoluciones, de dónde vino y el correo del cliente nuevo", () => {
    const o = mapBulkOrder({
      id: "gid://shopify/Order/1",
      name: "#1001",
      createdAt: "2023-04-14T20:21:06Z",
      email: null,
      customer: { id: "gid://shopify/Customer/9", defaultEmailAddress: { emailAddress: "a@b.com" }, defaultPhoneNumber: { phoneNumber: "+51965391481" } },
      shippingLine: { title: "Envío gratis" },
      fulfillments: [
        { createdAt: "2023-04-15T10:00:00Z", deliveredAt: null, displayStatus: "IN_TRANSIT", trackingInfo: [{ company: "Olva", number: "123", url: null }] },
      ],
      refunds: [{ createdAt: "2023-04-22T14:47:21Z", note: null, totalRefundedSet: { shopMoney: { amount: "79.0" } } }],
      customerJourneySummary: {
        customerOrderIndex: 2,
        daysToConversion: 3,
        firstVisit: { occurredAt: "2023-04-11T00:00:00Z", source: "facebook", sourceType: "PAID", utmParameters: { campaign: "CBO", source: "fb", medium: "paid", content: null, term: null } },
        lastVisit: null,
      },
    });
    expect(o.email).toBe("a@b.com");
    expect(o.phone_norm).toBe("51965391481");
    expect(o.shipping_method).toBe("Envío gratis");
    expect(o.fulfillments).toEqual([
      { created_at: "2023-04-15T10:00:00.000Z", delivered_at: null, status: "in_transit", tracking: [{ company: "Olva", number: "123", url: null }] },
    ]);
    expect(o.refunds).toEqual([{ created_at: "2023-04-22T14:47:21.000Z", amount: 79, note: null }]);
    expect(o.attribution?.customer_order_index).toBe(2);
    expect(o.attribution?.first_visit?.utm?.campaign).toBe("CBO");
    expect(o.attribution?.first_visit?.source_type).toBe("paid");
  });

  it("sin visitas ni índice, la atribución queda vacía", () => {
    expect(mapAttribution({ customerOrderIndex: null, daysToConversion: null, firstVisit: null, lastVisit: null })).toBeNull();
    expect(mapAttribution(null)).toBeNull();
  });
});

describe("clientes con permisos y direcciones", () => {
  it("junta sus direcciones y lee los permisos de correo, SMS y WhatsApp", () => {
    const [c] = groupBulkCustomers(
      lines([
        {
          id: "gid://shopify/Customer/7",
          firstName: "Ana",
          createdAt: "2022-01-02T00:00:00Z",
          state: "ENABLED",
          numberOfOrders: "3",
          amountSpent: { amount: "250.5" },
          defaultEmailAddress: { emailAddress: "ana@correo.com", marketingState: "SUBSCRIBED" },
          defaultPhoneNumber: { phoneNumber: "+51987000111", smsMarketingConsent: { state: "NOT_SUBSCRIBED" }, whatsAppMarketingConsent: { state: "SUBSCRIBED" } },
          defaultAddress: { city: "Lima" },
        },
        { id: "gid://shopify/MailingAddress/1", name: "Ana", address1: "Av. 1", city: "Lima", __parentId: "gid://shopify/Customer/7" },
        { id: "gid://shopify/MailingAddress/2", name: "Ana", address1: "Jr. 2", city: "Callao", __parentId: "gid://shopify/Customer/7" },
      ]),
    );
    expect(c!.customer_key).toBe("7");
    expect(c!.email).toBe("ana@correo.com");
    expect(c!.phone_norm).toBe("51987000111");
    expect(c!.accepts_marketing).toBe("subscribed");
    expect(c!.sms_marketing).toBe("not_subscribed");
    expect(c!.whatsapp_marketing).toBe("subscribed");
    expect(c!.customer_since).toBe("2022-01-02T00:00:00.000Z");
    expect(c!.account_state).toBe("enabled");
    expect(c!.addresses!.map((a) => a.address1)).toEqual(["Av. 1", "Jr. 2"]);
  });
});

describe("el catálogo", () => {
  it("una foto que usan dos productos va una sola vez en la tanda (si no, el upsert de la tanda falla)", () => {
    const { products, images } = groupBulkProducts(
      lines([
        { id: "gid://shopify/Product/10", title: "Brasier", options: [] },
        { id: "gid://shopify/MediaImage/200", image: { url: "https://cdn.shopify.com/a.png" }, __parentId: "gid://shopify/Product/10" },
        { id: "gid://shopify/MediaImage/201", image: { url: "https://cdn.shopify.com/b.png" }, __parentId: "gid://shopify/Product/10" },
        { id: "gid://shopify/Product/11", title: "Brasier pack", options: [] },
        { id: "gid://shopify/MediaImage/200", image: { url: "https://cdn.shopify.com/a.png" }, __parentId: "gid://shopify/Product/11" },
        { id: "gid://shopify/MediaImage/202", image: { url: "https://cdn.shopify.com/c.png" }, __parentId: "gid://shopify/Product/11" },
      ]),
    );
    expect(products.map((p) => p.product_id)).toEqual(["10", "11"]);
    expect(images.map((i: HistoryProductImage) => [i.image_id, i.product_id, i.position])).toEqual([
      ["200", "10", 1],
      ["201", "10", 2],
      ["202", "11", 1],
    ]);
    expect(new Set(images.map((i) => i.image_id)).size).toBe(images.length);
  });

  it("cada producto con sus variantes, fotos en orden, colecciones y metacampos", () => {
    const { products, images } = groupBulkProducts(
      lines([
        {
          id: "gid://shopify/Product/10",
          handle: "serum",
          title: "Serum",
          status: "ACTIVE",
          tags: ["piel", "vitamina c"],
          descriptionHtml: "<p>Hola</p>",
          seo: { title: null, description: "desc" },
          options: [{ name: "Title", values: ["Default Title"] }],
        },
        { id: "gid://shopify/ProductVariant/100", title: "Default Title", sku: "SKU1", price: "79.00", compareAtPrice: "120.00", inventoryQuantity: -1, position: 1, selectedOptions: [{ name: "Title", value: "Default Title" }], __parentId: "gid://shopify/Product/10" },
        { id: "gid://shopify/MediaImage/200", alt: "", image: { url: "https://cdn.shopify.com/a.png?v=1", width: 1080, height: 1080 }, __parentId: "gid://shopify/Product/10" },
        { __parentId: "gid://shopify/Product/10" }, // un video: el fragmento solo pide fotos
        { id: "gid://shopify/MediaImage/201", alt: "b", image: { url: "https://cdn.shopify.com/b.jpg", width: 800, height: 600 }, __parentId: "gid://shopify/Product/10" },
        { id: "gid://shopify/Collection/300", handle: "frontpage", title: "Inicio", __parentId: "gid://shopify/Product/10" },
        { id: "gid://shopify/Metafield/400", namespace: "custom", key: "beneficio", type: "single_line_text_field", value: "Ilumina", __parentId: "gid://shopify/Product/10" },
      ]),
    );
    const p = products[0] as HistoryProduct;
    expect(p.product_id).toBe("10");
    expect(p.status).toBe("active");
    expect(p.tags).toBe("piel, vitamina c");
    expect(p.description_html).toBe("<p>Hola</p>");
    expect(p.variants).toEqual([
      { id: "100", title: "Default Title", sku: "SKU1", barcode: null, price: 79, compare_at_price: 120, inventory_quantity: -1, position: 1, options: [{ name: "Title", value: "Default Title" }] },
    ]);
    expect(p.collections).toEqual([{ id: "300", handle: "frontpage", title: "Inicio" }]);
    expect(p.metafields).toEqual([{ namespace: "custom", key: "beneficio", type: "single_line_text_field", value: "Ilumina" }]);
    expect(images.map((i: HistoryProductImage) => [i.image_id, i.position, i.src_url])).toEqual([
      ["200", 1, "https://cdn.shopify.com/a.png?v=1"],
      ["201", 2, "https://cdn.shopify.com/b.jpg"],
    ]);
  });

  it("la copia de cada foto: extensión por su tipo y ruta por tienda y producto", () => {
    expect(imageExtension("https://cdn.shopify.com/a.png?v=1", "image/png")).toBe("png");
    expect(imageExtension("https://cdn.shopify.com/a.jpeg?v=1", null)).toBe("jpg");
    expect(imageExtension("https://cdn.shopify.com/a", "application/octet-stream")).toBe("jpg");
    expect(imageExtension("https://cdn.shopify.com/a.webp", null)).toBe("webp");
    expect(imageStoragePath("s1", "10", "200", "png")).toBe("s1/productos/10/200.png");
  });
});

describe("carritos abandonados y borradores", () => {
  it("un carrito abandonado con su enlace para retomar y sus productos", () => {
    const [c] = groupBulkCarts(
      lines([
        {
          id: "gid://shopify/AbandonedCheckout/439",
          name: "#439",
          createdAt: "2026-10-18T06:09:34Z",
          completedAt: null,
          abandonedCheckoutUrl: "https://kenku.pe/recover?key=1",
          customer: { id: "gid://shopify/Customer/1", defaultEmailAddress: { emailAddress: "x@y.com" }, defaultPhoneNumber: null },
          shippingAddress: null,
          totalPriceSet: { shopMoney: { amount: "149.0", currencyCode: "PEN" } },
          customAttributes: [],
          discountCodes: [],
          note: "",
        },
        { id: "gid://shopify/AbandonedCheckoutLineItem/abc?checkout=1&index=0", title: "UROCONTROL", variantTitle: null, sku: "874", quantity: 1, originalUnitPriceSet: { shopMoney: { amount: "149.0" } }, __parentId: "gid://shopify/AbandonedCheckout/439" },
      ]),
      "carrito",
    );
    expect(c!.cart_key).toBe("carrito:439");
    expect(c!.status).toBe("abandonado");
    expect(c!.email).toBe("x@y.com");
    expect(c!.url).toBe("https://kenku.pe/recover?key=1");
    expect(c!.total).toBe(149);
    expect(c!.currency).toBe("PEN");
    expect(c!.line_items.map((li) => [li.name, li.quantity, li.price])).toEqual([["UROCONTROL", 1, 149]]);
  });

  it("un borrador del formulario guarda sus UTM y el pedido en que terminó", () => {
    const [d] = groupBulkCarts(
      lines([
        {
          id: "gid://shopify/DraftOrder/1355",
          name: "#D105329",
          status: "COMPLETED",
          createdAt: "2026-10-24T03:48:30Z",
          completedAt: "2026-10-24T04:00:00Z",
          invoiceUrl: "https://kenku.pe/invoices/x",
          tags: ["easysell_cod_form"],
          phone: "+51970524625",
          shippingAddress: { name: "Estela", phone: "+51970524625", city: "Callao", province: "Callao" },
          totalPriceSet: { shopMoney: { amount: "298.0", currencyCode: "PEN" } },
          customAttributes: [{ key: "utm_campaign", value: "CBO Ethiopian" }],
          order: { name: "#KP143700" },
        },
        { id: "gid://shopify/DraftOrderLineItem/58", title: "Ethiopian Black Seed Oil", variantTitle: "60 cápsulas", sku: "ETH", quantity: 3, originalUnitPriceSet: { shopMoney: { amount: "149.0" } }, __parentId: "gid://shopify/DraftOrder/1355" },
      ]),
      "borrador",
    );
    expect(d!.cart_key).toBe("borrador:1355");
    expect(d!.status).toBe("completed");
    expect(d!.phone_norm).toBe("51970524625");
    expect(d!.order_name).toBe("#KP143700");
    expect(d!.tags).toBe("easysell_cod_form");
    expect(d!.raw.utm_campaign).toBe("CBO Ethiopian");
    expect(d!.line_items[0]!.name).toBe("Ethiopian Black Seed Oil - 60 cápsulas");
  });
});

describe("la traída por tandas guarda cada tipo con su escritor", () => {
  function fakeAdmin(row: HistoryImportRow) {
    const state = { row: { ...row } };
    const builder = () => {
      let patch: Record<string, unknown> | null = null;
      const b: any = {
        update(p: Record<string, unknown>) {
          patch = p;
          return b;
        },
        eq: () => b,
        or: () => b,
        select: () => b,
        async maybeSingle() {
          if (patch) state.row = { ...state.row, ...(patch as Partial<HistoryImportRow>) };
          return { data: { ...state.row }, error: null };
        },
      };
      return b;
    };
    return { admin: { from: () => builder() } as any, state };
  }
  const file = (text: string) =>
    (async () => new Response(new TextEncoder().encode(text), { status: 200 })) as unknown as typeof fetch;
  const base: HistoryImportRow = {
    id: "imp",
    store_id: "s1",
    kind: "productos",
    bulk_operation_id: "op",
    status: "importando",
    url: "https://x",
    file_size: null,
    object_count: null,
    bytes_done: 0,
    records: 0,
    first_at: null,
    last_at: null,
    error: null,
    lease_until: null,
    created_at: "2026-10-24T00:00:00Z",
    finished_at: null,
  };
  const writer = (seen: Record<string, number>): RowWriter => ({
    orders: async (r) => ((seen.orders = (seen.orders ?? 0) + r.length), r.length),
    customers: async (r) => ((seen.customers = (seen.customers ?? 0) + r.length), r.length),
    orphans: async () => undefined,
    products: async (p, imgs) => ((seen.products = (seen.products ?? 0) + p.length), (seen.images = (seen.images ?? 0) + imgs.length), p.length),
    carts: async (c) => ((seen.carts = (seen.carts ?? 0) + c.length), c.length),
  });

  it("productos y sus fotos", async () => {
    const text = [
      { id: "gid://shopify/Product/1", title: "A" },
      { id: "gid://shopify/MediaImage/11", image: { url: "https://cdn.shopify.com/1.png" }, __parentId: "gid://shopify/Product/1" },
      { id: "gid://shopify/Product/2", title: "B" },
    ].map((o) => JSON.stringify(o)).join("\n");
    const seen: Record<string, number> = {};
    const { admin } = fakeAdmin(base);
    const done = await readImportChunk(admin, base, writer(seen), { fetchImpl: file(text) });
    expect(done.status).toBe("listo");
    expect(seen).toEqual({ products: 2, images: 1 });
    expect(done.records).toBe(2);
  });

  it("borradores, con su rango de fechas", async () => {
    const row = { ...base, kind: "borradores" as const };
    const text = [
      { id: "gid://shopify/DraftOrder/1", createdAt: "2023-04-14T19:11:55Z" },
      { id: "gid://shopify/DraftOrder/2", createdAt: "2026-10-24T03:48:30Z" },
    ].map((o) => JSON.stringify(o)).join("\n");
    const seen: Record<string, number> = {};
    const { admin } = fakeAdmin(row);
    const done = await readImportChunk(admin, row, writer(seen), { fetchImpl: file(text) });
    expect(seen).toEqual({ carts: 2 });
    expect(done.first_at).toBe("2023-04-14T19:11:55.000Z");
    expect(done.last_at).toBe("2026-10-24T03:48:30.000Z");
  });
});

describe("todo va al historial, nunca al Master (§37.1)", () => {
  it("las acciones y el copiador de fotos no tocan orders ni el Master", () => {
    for (const path of ["app/dashboard/stores/historial/actions.ts", "lib/shopify-history-images.ts", "lib/shopify-history-import.ts"]) {
      expect(read(path)).not.toMatch(/from\("orders"\)|from\("order_master"\)|from\("order_events"\)/);
    }
  });

  it("la 0278 deja las tablas nuevas con RLS de lectura y los cinco tipos de traída", () => {
    const sql = read("db/migrations/0278_shopify_history_more.sql");
    for (const t of ["shopify_history_products", "shopify_history_product_images", "shopify_history_carts"]) {
      expect(sql).toContain(`alter table ${t} enable row level security`);
      expect(sql).toContain(`create policy ${t}_select on ${t} for select to authenticated`);
    }
    expect(sql).toContain("check (kind in ('pedidos', 'clientes', 'productos', 'carritos', 'borradores'))");
    expect(sql).not.toMatch(/for (insert|update|delete|all) to authenticated/);
  });
});
