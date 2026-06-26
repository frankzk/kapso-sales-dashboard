import { describe, it, expect, beforeAll } from "vitest";
import { createHmac } from "node:crypto";
import { encrypt, generateEncryptionKey } from "@/lib/crypto";

const KEY = generateEncryptionKey();
const WEBHOOK_SECRET = "shpss_store_secret";

beforeAll(() => {
  process.env.ENCRYPTION_KEY = KEY;
});

// --- Minimal thenable fake of the Supabase client used by lib/ingest --------
type Row = Record<string, any>;
class FakeBuilder {
  op: string | null = null;
  payload: any;
  filters: Row = {};
  _single = false;
  constructor(public table: string, public store: FakeSupabase) {}
  select() {
    this.op = this.op ?? "select";
    return this;
  }
  insert(p: any) {
    this.op = "insert";
    this.payload = p;
    return this;
  }
  upsert(p: any) {
    this.op = "upsert";
    this.payload = p;
    return this;
  }
  update(p: any) {
    this.op = "update";
    this.payload = p;
    return this;
  }
  eq(k: string, v: any) {
    this.filters[k] = v;
    return this;
  }
  match(m: Row) {
    Object.assign(this.filters, m);
    return this;
  }
  in(k: string, v: any[]) {
    this.filters[k] = v;
    return this;
  }
  is(k: string, v: any) {
    this.filters[k] = v;
    return this;
  }
  delete() {
    this.op = "delete";
    return this;
  }
  order() {
    return this;
  }
  limit() {
    return this;
  }
  single() {
    this._single = true;
    return this;
  }
  maybeSingle() {
    this._single = true;
    return this;
  }
  then(resolve: (v: any) => any, reject?: (e: any) => any) {
    return Promise.resolve(this.store.exec(this)).then(resolve, reject);
  }
}

class FakeSupabase {
  storeRow: Row;
  insertedWebhookIds = new Set<string>();
  upsertedOrders: any[] = [];
  upsertedDrafts: any[] = [];
  upsertedLeads: any[] = [];
  deletedDrafts: any[] = [];
  existingLeadPhones = new Set<string>();
  recomputeCalls: any[] = [];
  processedUpdates = 0;
  constructor(storeRow: Row) {
    this.storeRow = storeRow;
  }
  from(table: string) {
    return new FakeBuilder(table, this);
  }
  async rpc(_name: string, args: any) {
    this.recomputeCalls.push(args);
    return { error: null };
  }
  exec(b: FakeBuilder): { data: any; error: any } {
    if (b.table === "stores" && b.op === "select") {
      return { data: this.storeRow, error: null };
    }
    if (b.table === "webhook_events" && b.op === "insert") {
      const id = b.payload.webhook_id as string;
      if (this.insertedWebhookIds.has(id)) {
        return { data: null, error: { code: "23505", message: "duplicate key" } };
      }
      this.insertedWebhookIds.add(id);
      return { data: null, error: null };
    }
    if (b.table === "webhook_events" && b.op === "update") {
      this.processedUpdates += 1;
      return { data: null, error: null };
    }
    if (b.table === "orders" && b.op === "upsert") {
      this.upsertedOrders.push(...(b.payload as any[]));
      return { data: null, error: null };
    }
    if (b.table === "draft_orders" && b.op === "upsert") {
      this.upsertedDrafts.push(...(b.payload as any[]));
      return { data: null, error: null };
    }
    if (b.table === "draft_orders" && b.op === "delete") {
      this.deletedDrafts.push(b.filters);
      return { data: null, error: null };
    }
    if (b.table === "leads" && b.op === "select") {
      const ph = (b.filters as any).phone;
      const list = Array.isArray(ph) ? ph : ph != null ? [ph] : [];
      const rows = list.filter((p: string) => this.existingLeadPhones.has(p)).map((p: string) => ({ phone: p }));
      return { data: rows, error: null };
    }
    if (b.table === "leads" && b.op === "upsert") {
      const rows = Array.isArray(b.payload) ? b.payload : [b.payload];
      this.upsertedLeads.push(...rows);
      return { data: null, error: null };
    }
    return { data: null, error: null };
  }
}

function makeStoreRow(): Row {
  return {
    id: "store-1",
    org_id: "org-1",
    name: "Aurela",
    shopify_domain: "aurela.myshopify.com",
    shopify_token_enc: null,
    shopify_webhook_secret_enc: encrypt(WEBHOOK_SECRET, KEY),
    kapso_project_id: null,
    kapso_api_key_enc: null,
    whatsapp_phone_number_id: null,
    currency: "PEN",
    timezone: "America/Lima",
    status: "active",
  };
}

const ORDER_BODY = JSON.stringify({
  id: 5678901234567,
  name: "#1001",
  created_at: "2026-06-20T15:00:00Z",
  total_price: "199.90",
  currency: "PEN",
  financial_status: "paid",
  tags: "kapso, whatsapp, promo-whatsapp",
  note_attributes: [{ name: "kapso_conversation_id", value: "conv_abc" }],
  line_items: [{ title: "Polo", quantity: 1, price: "199.90" }],
});

function sign(body: string, secret = WEBHOOK_SECRET) {
  return createHmac("sha256", secret).update(body, "utf8").digest("base64");
}

describe("processShopifyWebhook", () => {
  it("rejects an invalid HMAC and writes nothing", async () => {
    const { processShopifyWebhook } = await import("@/lib/ingest");
    const fake = new FakeSupabase(makeStoreRow());
    const res = await processShopifyWebhook(
      { storeId: "store-1", topic: "orders/create", rawBody: ORDER_BODY, hmacHeader: sign(ORDER_BODY, "wrong") },
      fake as any,
    );
    expect(res.status).toBe("unauthorized");
    expect(fake.upsertedOrders).toHaveLength(0);
    expect(fake.insertedWebhookIds.size).toBe(0);
  });

  it("processes a valid webhook: upserts the order and recomputes the rollup", async () => {
    const { processShopifyWebhook } = await import("@/lib/ingest");
    const fake = new FakeSupabase(makeStoreRow());
    const res = await processShopifyWebhook(
      {
        storeId: "store-1",
        topic: "orders/create",
        rawBody: ORDER_BODY,
        hmacHeader: sign(ORDER_BODY),
        webhookIdHeader: "wh_1",
      },
      fake as any,
    );
    expect(res.status).toBe("ok");
    expect(fake.upsertedOrders).toHaveLength(1);
    expect(fake.upsertedOrders[0]).toMatchObject({
      store_id: "store-1",
      shopify_order_id: "5678901234567",
      promo_applied: true,
      total_amount: 199.9,
      kapso_conversation_id: "conv_abc",
    });
    // Rollup recomputed for the Lima-date of created_at (15:00Z → 10:00 Lima).
    expect(fake.recomputeCalls[0]).toMatchObject({ p_store_id: "store-1", p_from: "2026-06-20", p_to: "2026-06-20" });
    expect(fake.processedUpdates).toBe(1);
  });

  it("ignores a non-Kapso order: status ok, nothing recorded", async () => {
    const { processShopifyWebhook } = await import("@/lib/ingest");
    const fake = new FakeSupabase(makeStoreRow());
    // Shopify delivers order webhooks shop-wide; an order without the kapso tag
    // must not be ingested (parity with the tag:kapso data model).
    const body = JSON.stringify({
      id: 9001,
      name: "#2002",
      created_at: "2026-06-20T15:00:00Z",
      total_price: "59.90",
      currency: "PEN",
      financial_status: "paid",
      tags: "whatsapp, promo-whatsapp", // no "kapso"
      line_items: [{ title: "Gorra", quantity: 1, price: "59.90" }],
    });
    const res = await processShopifyWebhook(
      {
        storeId: "store-1",
        topic: "orders/create",
        rawBody: body,
        hmacHeader: sign(body),
        webhookIdHeader: "wh_nonkapso",
      },
      fake as any,
    );
    expect(res.status).toBe("ok");
    expect(fake.upsertedOrders).toHaveLength(0); // not ingested
    expect(fake.insertedWebhookIds.size).toBe(0); // not even recorded
    expect(fake.recomputeCalls).toHaveLength(0); // no rollup recompute
  });

  it("is idempotent: re-delivering the same body does not duplicate the order", async () => {
    const { processShopifyWebhook } = await import("@/lib/ingest");
    const fake = new FakeSupabase(makeStoreRow());
    // No webhook-id header → idempotency key is a hash of the raw body.
    const first = await processShopifyWebhook(
      { storeId: "store-1", topic: "orders/create", rawBody: ORDER_BODY, hmacHeader: sign(ORDER_BODY) },
      fake as any,
    );
    const second = await processShopifyWebhook(
      { storeId: "store-1", topic: "orders/create", rawBody: ORDER_BODY, hmacHeader: sign(ORDER_BODY) },
      fake as any,
    );
    expect(first.status).toBe("ok");
    expect(second.status).toBe("duplicate");
    expect(fake.upsertedOrders).toHaveLength(1); // not 2
  });

  it("returns error for an unknown store", async () => {
    const { processShopifyWebhook } = await import("@/lib/ingest");
    const fake = new FakeSupabase(makeStoreRow());
    fake.storeRow = null as any; // simulate not found
    // override exec for stores to mimic .single() error
    const origExec = fake.exec.bind(fake);
    fake.exec = (b: FakeBuilder) => {
      if (b.table === "stores") return { data: null, error: { message: "no rows" } };
      return origExec(b);
    };
    const res = await processShopifyWebhook(
      { storeId: "nope", topic: "orders/create", rawBody: ORDER_BODY, hmacHeader: sign(ORDER_BODY) },
      fake as any,
    );
    expect(res.status).toBe("error");
  });
});

const DRAFT_OPEN_BODY = JSON.stringify({
  id: 1122334455,
  admin_graphql_api_id: "gid://shopify/DraftOrder/1122334455",
  name: "#D12",
  status: "open",
  created_at: "2026-06-24T12:00:00Z",
  updated_at: "2026-06-24T12:30:00Z",
  invoice_url: "https://aurela.myshopify.com/invoice/abc",
  total_price: "120.00",
  currency: "PEN",
  shipping_address: { phone: "+51 980 111 222", city: "Miraflores", province: "Lima", address1: "Av X 123", address2: "Dpto 4" },
  line_items: [{ title: "Mochila", quantity: 2, price: "60.00" }],
  tags: "",
  note: "Releasit COD form",
});

const DRAFT_COMPLETED_BODY = JSON.stringify({
  id: 1122334455,
  admin_graphql_api_id: "gid://shopify/DraftOrder/1122334455",
  name: "#D12",
  status: "completed",
  created_at: "2026-06-24T12:00:00Z",
  updated_at: "2026-06-24T13:00:00Z",
  completed_at: "2026-06-24T13:00:00Z",
  total_price: "120.00",
  currency: "PEN",
  shipping_address: { phone: "+51 980 111 222", city: "Miraflores" },
  line_items: [{ title: "Mochila", quantity: 2, price: "60.00" }],
  order_id: 99887766,
  note: "Releasit COD form",
});

describe("processShopifyWebhook · draft orders", () => {
  it("draft_orders/create: upserts the draft and creates a cart lead", async () => {
    const { processShopifyWebhook } = await import("@/lib/ingest");
    const fake = new FakeSupabase(makeStoreRow());
    const res = await processShopifyWebhook(
      { storeId: "store-1", topic: "draft_orders/create", rawBody: DRAFT_OPEN_BODY, hmacHeader: sign(DRAFT_OPEN_BODY), webhookIdHeader: "wh_d1" },
      fake as any,
    );
    expect(res.status).toBe("ok");
    expect(fake.upsertedDrafts).toHaveLength(1);
    expect(fake.upsertedDrafts[0]).toMatchObject({
      store_id: "store-1",
      shopify_draft_order_id: "1122334455",
      status: "open",
      district: "Miraflores",
      customer_phone: "51980111222",
    });
    expect(fake.upsertedLeads).toHaveLength(1);
    expect(fake.upsertedLeads[0]).toMatchObject({
      phone: "51980111222",
      status: "nuevo",
      category: "open",
      source: "cod_cart",
      cart_item_count: 2,
    });
    expect(fake.upsertedLeads[0].draft_order_gid).toBe("gid://shopify/DraftOrder/1122334455");
  });

  it("draft_orders/update completed: marks the lead won (recovered)", async () => {
    const { processShopifyWebhook } = await import("@/lib/ingest");
    const fake = new FakeSupabase(makeStoreRow());
    const res = await processShopifyWebhook(
      { storeId: "store-1", topic: "draft_orders/update", rawBody: DRAFT_COMPLETED_BODY, hmacHeader: sign(DRAFT_COMPLETED_BODY), webhookIdHeader: "wh_d2" },
      fake as any,
    );
    expect(res.status).toBe("ok");
    expect(fake.upsertedLeads).toHaveLength(1);
    expect(fake.upsertedLeads[0]).toMatchObject({
      phone: "51980111222",
      status: "pedido_generado",
      category: "won",
      has_order: true,
    });
  });
});

describe("linkDraftOrdersToLeads precedence", () => {
  it("enriches an existing lead's cart but never overwrites its manual status", async () => {
    const { linkDraftOrdersToLeads } = await import("@/lib/leads-ingest");
    const { mapRestDraftOrder } = await import("@/lib/shopify");
    const fake = new FakeSupabase(makeStoreRow());
    fake.existingLeadPhones.add("51980111222"); // a lead the agent already dispositioned
    const draft = mapRestDraftOrder(JSON.parse(DRAFT_OPEN_BODY), "store-1");
    await linkDraftOrdersToLeads(fake as any, "store-1", [draft]);
    expect(fake.upsertedLeads).toHaveLength(1);
    const row = fake.upsertedLeads[0];
    expect(row.cart_item_count).toBe(2); // cart enriched
    expect(row.draft_order_gid).toBeTruthy();
    expect(row.status).toBeUndefined(); // manual disposition preserved
    expect(row.source).toBeUndefined();
  });

  it("holds a brand-new open cart within the grace period (no lead yet)", async () => {
    const { linkDraftOrdersToLeads } = await import("@/lib/leads-ingest");
    const { mapRestDraftOrder } = await import("@/lib/shopify");
    const fake = new FakeSupabase(makeStoreRow());
    const fresh = JSON.parse(DRAFT_OPEN_BODY);
    const recent = new Date(Date.now() - 5 * 60 * 1000).toISOString(); // 5 min ago
    fresh.created_at = recent;
    fresh.updated_at = recent;
    const draft = mapRestDraftOrder(fresh, "store-1");
    await linkDraftOrdersToLeads(fake as any, "store-1", [draft]);
    expect(fake.upsertedLeads).toHaveLength(0); // too fresh — waits for the grace period
  });
});
