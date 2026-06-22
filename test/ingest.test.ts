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
