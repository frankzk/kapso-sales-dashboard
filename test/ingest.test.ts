import { describe, it, expect, beforeAll } from "vitest";
import { createHmac } from "node:crypto";
import { encrypt, generateEncryptionKey } from "@/lib/crypto";

const KEY = generateEncryptionKey();
const WEBHOOK_SECRET = "shpss_store_secret";
const FLOW_SECRET = "flow_recoverops_secret";

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
  selectCols: string | null = null;
  constructor(public table: string, public store: FakeSupabase) {}
  select(cols?: string) {
    this.op = this.op ?? "select";
    if (typeof cols === "string") this.selectCols = cols;
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
  lt(k: string, v: any) {
    this.filters[`${k}__lt`] = v;
    return this;
  }
  gt(k: string, v: any) {
    this.filters[`${k}__gt`] = v;
    return this;
  }
  lte(k: string, v: any) {
    this.filters[`${k}__lte`] = v;
    return this;
  }
  gte(k: string, v: any) {
    this.filters[`${k}__gte`] = v;
    return this;
  }
  or() {
    return this;
  }
  not() {
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
  leadCalls: any[] = [];
  deletedDrafts: any[] = [];
  existingLeadPhones = new Set<string>();
  recomputeCalls: any[] = [];
  processedUpdates = 0;
  webhookUpdates: any[] = [];
  winbackSends: any[] = [];
  dripLeads: any[] = []; // filas que responde el select de candidatos del drip
  dripSends: any[] = [];
  leadPatches: any[] = []; // updates a leads (drip_touches, attention_waves, etc.)
  waveLeads: any[] = []; // filas que responde el select de candidatos de olas
  waveSelectError: string | null = null; // simula la columna 0036 ausente
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
      this.webhookUpdates.push(b.payload);
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
    if (b.table === "leads" && b.op === "select" && b.selectCols?.includes("drip_touches")) {
      // Selector de candidatos del drip (su marcador distintivo es drip_touches;
      // también trae attention_waves, así que esta rama va ANTES que la de olas).
      // Devuelve las filas preparadas tal cual — el filtro fino es
      // dripSkipReason en JS, que es lo que se testea.
      return { data: this.dripLeads, error: null };
    }
    if (b.table === "leads" && b.op === "select" && b.selectCols?.includes("attention_waves")) {
      if (this.waveSelectError) return { data: null, error: { message: this.waveSelectError } };
      return { data: this.waveLeads, error: null };
    }
    if (b.table === "leads" && b.op === "update") {
      this.leadPatches.push({ ...(b.filters as any), ...b.payload });
      return { data: null, error: null };
    }
    if (b.table === "drip_sends" && b.op === "insert") {
      const rows = Array.isArray(b.payload) ? b.payload : [b.payload];
      this.dripSends.push(...rows);
      return { data: null, error: null };
    }
    if (b.table === "leads" && b.op === "select") {
      const ph = (b.filters as any).phone;
      // Browse send-path looks the freshly-created lead up by id (maybeSingle) →
      // a single row with an id (or null), not the array shape the bulk paths use.
      if (b._single && b.selectCols === "id") {
        const exists = typeof ph === "string" && this.existingLeadPhones.has(ph);
        return { data: exists ? { id: `lead-${ph}` } : null, error: null };
      }
      const list = Array.isArray(ph) ? ph : ph != null ? [ph] : [];
      const rows = list.filter((p: string) => this.existingLeadPhones.has(p)).map((p: string) => ({ phone: p }));
      return { data: rows, error: null };
    }
    if (b.table === "leads" && b.op === "upsert") {
      const rows = Array.isArray(b.payload) ? b.payload : [b.payload];
      this.upsertedLeads.push(...rows);
      return { data: null, error: null };
    }
    if (b.table === "leads" && b.op === "insert") {
      // Model the unique (store_id, phone): a clash → 23505 (→ "exists" no-op).
      const rows = Array.isArray(b.payload) ? b.payload : [b.payload];
      for (const r of rows) {
        if (this.existingLeadPhones.has(r.phone)) {
          return { data: null, error: { code: "23505", message: "duplicate phone" } };
        }
      }
      this.upsertedLeads.push(...rows);
      for (const r of rows) if (r.phone) this.existingLeadPhones.add(r.phone);
      return { data: null, error: null };
    }
    if (b.table === "lead_calls" && b.op === "insert") {
      const rows = Array.isArray(b.payload) ? b.payload : [b.payload];
      this.leadCalls.push(...rows);
      return { data: null, error: null };
    }
    if (b.table === "winback_sends" && b.op === "insert") {
      const rows = Array.isArray(b.payload) ? b.payload : [b.payload];
      this.winbackSends.push(...rows);
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
    flow_webhook_secret_enc: encrypt(FLOW_SECRET, KEY),
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
  shipping_address: { name: "María Luna", phone: "+51 980 111 222", city: "Miraflores", province: "Lima", address1: "Av X 123", address2: "Dpto 4" },
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
      // Full shipping address denormalized onto the lead (0032): street + recipient.
      address1: "Av X 123",
      ship_name: "María Luna",
      referencia: "Dpto 4",
      district: "Miraflores",
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
    const { mapRestDraftOrder, DRAFT_GRACE_MINUTES } = await import("@/lib/shopify");
    const fake = new FakeSupabase(makeStoreRow());
    const fresh = JSON.parse(DRAFT_OPEN_BODY);
    // Half the grace ago — robustly "still within grace" whatever the constant is.
    const recent = new Date(Date.now() - (DRAFT_GRACE_MINUTES / 2) * 60 * 1000).toISOString();
    fresh.created_at = recent;
    fresh.updated_at = recent;
    const draft = mapRestDraftOrder(fresh, "store-1");
    await linkDraftOrdersToLeads(fake as any, "store-1", [draft]);
    expect(fake.upsertedLeads).toHaveLength(0); // too fresh — waits for the grace period
  });
});

describe("shouldReopenWonCart (open cart vs a sticky `won` lead)", () => {
  it("reopens a won lead with NO active order (cancelled/gone) + a fresh cart", async () => {
    const { shouldReopenWonCart } = await import("@/lib/leads-ingest");
    // The reported bug: won from an order that's no longer active → lastOrderAt null.
    expect(
      shouldReopenWonCart({
        category: "won",
        draftCreatedAt: "2026-06-30T18:33:41Z",
        lastOrderAt: null, // no non-cancelled order anchoring the win
        lastDispositionAt: null,
      }),
    ).toBe(true);
  });

  it("reopens on a recompra (cart newer than the active order)", async () => {
    const { shouldReopenWonCart } = await import("@/lib/leads-ingest");
    expect(
      shouldReopenWonCart({
        category: "won",
        draftCreatedAt: "2026-06-30T10:00:00Z",
        lastOrderAt: "2026-06-01T10:00:00Z", // older order → the new cart is a re-purchase
        lastDispositionAt: null,
      }),
    ).toBe(true);
  });

  it("does NOT reopen when the active order is newer than the cart (real, fresh win)", async () => {
    const { shouldReopenWonCart } = await import("@/lib/leads-ingest");
    expect(
      shouldReopenWonCart({
        category: "won",
        draftCreatedAt: "2026-06-30T10:00:00Z",
        lastOrderAt: "2026-06-30T12:00:00Z", // order after the cart → keep the win
        lastDispositionAt: null,
      }),
    ).toBe(false);
  });

  it("does NOT reopen when an agent's disposition post-dates the cart", async () => {
    const { shouldReopenWonCart } = await import("@/lib/leads-ingest");
    expect(
      shouldReopenWonCart({
        category: "won",
        draftCreatedAt: "2026-06-30T10:00:00Z",
        lastOrderAt: null,
        lastDispositionAt: "2026-06-30T11:00:00Z", // worked after the cart → respect it
      }),
    ).toBe(false);
  });

  it("never touches a lead that isn't won", async () => {
    const { shouldReopenWonCart } = await import("@/lib/leads-ingest");
    expect(
      shouldReopenWonCart({
        category: "open",
        draftCreatedAt: "2026-06-30T10:00:00Z",
        lastOrderAt: null,
        lastDispositionAt: null,
      }),
    ).toBe(false);
  });
});

describe("shouldReopenLostCart (fresh cart on an auto-archived lead)", () => {
  const staleCutoff = "2026-06-28T00:00:00Z"; // now − 7d

  it("reopens a lost lead when a FRESH cart (after the cutoff) arrives, no disposition", async () => {
    const { shouldReopenLostCart } = await import("@/lib/leads-ingest");
    // The reported bug: a lead auto-archived by inactivity gets a brand-new cart.
    expect(
      shouldReopenLostCart({
        category: "lost",
        draftCreatedAt: "2026-07-05T13:00:00Z",
        lastDispositionAt: null, // auto-archive is a SYSTEM row, not a manual result
        staleCutoff,
      }),
    ).toBe(true);
  });

  it("reopens when the fresh cart post-dates an older manual disposition", async () => {
    const { shouldReopenLostCart } = await import("@/lib/leads-ingest");
    expect(
      shouldReopenLostCart({
        category: "lost",
        draftCreatedAt: "2026-07-05T13:00:00Z",
        lastDispositionAt: "2026-06-29T10:00:00Z", // marked lost earlier, cart is newer
        staleCutoff,
      }),
    ).toBe(true);
  });

  it("does NOT reopen when the agent's manual result post-dates the cart", async () => {
    const { shouldReopenLostCart } = await import("@/lib/leads-ingest");
    expect(
      shouldReopenLostCart({
        category: "lost",
        draftCreatedAt: "2026-07-05T13:00:00Z",
        lastDispositionAt: "2026-07-06T09:00:00Z", // "ya compró en otro lado" after the cart
        staleCutoff,
      }),
    ).toBe(false);
  });

  it("does NOT reopen a DEAD cart (created before the stale window) — no ping-pong", async () => {
    const { shouldReopenLostCart } = await import("@/lib/leads-ingest");
    expect(
      shouldReopenLostCart({
        category: "lost",
        draftCreatedAt: "2026-06-20T13:00:00Z", // the same old cart that caused the archive
        lastDispositionAt: null,
        staleCutoff,
      }),
    ).toBe(false);
  });

  it("never touches a lead that isn't lost", async () => {
    const { shouldReopenLostCart } = await import("@/lib/leads-ingest");
    expect(
      shouldReopenLostCart({ category: "open", draftCreatedAt: "2026-07-05T13:00:00Z", lastDispositionAt: null, staleCutoff }),
    ).toBe(false);
    expect(
      shouldReopenLostCart({ category: "won", draftCreatedAt: "2026-07-05T13:00:00Z", lastDispositionAt: null, staleCutoff }),
    ).toBe(false);
  });
});

const BROWSE_BODY = JSON.stringify({
  source: "abandoned_browse",
  sourceLabel: "Búsqueda",
  event: "customer_left_online_store",
  sentAt: "2026-06-26T15:00:00Z",
  shop: { domain: "kenkuperu.myshopify.com" },
  abandonment: { id: "gid://shopify/Abandonment/abc123" },
  customer: {
    name: "Sol",
    email: "sol@example.com",
    phone: "+51 953 249 192",
    defaultAddress: { city: "Aplao", province: "Arequipa", address1: "Calle 8" },
  },
  productsAddedToCart: [],
  productsViewed: [{ productTitle: "TravelersBackpack™", variantTitle: "Negro", quantity: 1 }],
});

describe("browseLeadSeed (abandoned-browse payload → lead fields)", () => {
  it("normalizes phone, summarizes the viewed product, and maps the address → district", async () => {
    const { browseLeadSeed } = await import("@/lib/leads-ingest");
    const seed = browseLeadSeed(JSON.parse(BROWSE_BODY))!;
    expect(seed.phone).toBe("51953249192");
    expect(seed.name).toBe("Sol");
    expect(seed.cart_summary).toContain("TravelersBackpack");
    expect(seed.cart_item_count).toBeNull(); // only viewed → NOT a cart → "frío"/"distrito"
    expect(seed.district).toBe("Aplao");
    expect(seed.province).toBe("Arequipa");
  });

  it("treats productsAddedToCart as a cart (cart_item_count set → 'Con carrito')", async () => {
    const { browseLeadSeed } = await import("@/lib/leads-ingest");
    const body = JSON.parse(BROWSE_BODY);
    body.productsAddedToCart = [{ productTitle: "Mochila", quantity: 2 }];
    const seed = browseLeadSeed(body)!;
    expect(seed.cart_item_count).toBe(2);
    expect(seed.cart_summary).toContain("Mochila");
  });

  it("returns null when there's no usable phone (anonymous browse can't be a lead)", async () => {
    const { browseLeadSeed } = await import("@/lib/leads-ingest");
    const body = JSON.parse(BROWSE_BODY);
    body.customer.phone = null;
    expect(browseLeadSeed(body)).toBeNull();
  });
});

describe("processFlowWebhook · abandoned browse", () => {
  it("creates a browse lead for a new phone", async () => {
    const { processFlowWebhook } = await import("@/lib/ingest");
    const fake = new FakeSupabase(makeStoreRow());
    const res = await processFlowWebhook(
      { storeId: "store-1", secretHeader: FLOW_SECRET, rawBody: BROWSE_BODY },
      fake as any,
    );
    expect(res.status).toBe("ok");
    expect(fake.upsertedLeads).toHaveLength(1);
    expect(fake.upsertedLeads[0]).toMatchObject({
      phone: "51953249192",
      source: "abandoned_browse",
      status: "nuevo",
      category: "open",
      district: "Aplao",
    });
  });

  it("does NOT create a lead when the phone already has one (lowest precedence)", async () => {
    const { processFlowWebhook } = await import("@/lib/ingest");
    const fake = new FakeSupabase(makeStoreRow());
    fake.existingLeadPhones.add("51953249192"); // an existing WhatsApp/cart/ad lead
    const res = await processFlowWebhook(
      { storeId: "store-1", secretHeader: FLOW_SECRET, rawBody: BROWSE_BODY },
      fake as any,
    );
    expect(res.status).toBe("ok");
    expect(fake.upsertedLeads).toHaveLength(0); // never downgrades an existing lead
  });

  it("rejects a wrong secret (unauthorized, no lead) but logs the rejection", async () => {
    const { processFlowWebhook } = await import("@/lib/ingest");
    const fake = new FakeSupabase(makeStoreRow());
    const res = await processFlowWebhook(
      { storeId: "store-1", secretHeader: "wrong-secret", rawBody: BROWSE_BODY },
      fake as any,
    );
    expect(res.status).toBe("unauthorized");
    expect(fake.upsertedLeads).toHaveLength(0); // no lead created
    expect(fake.insertedWebhookIds.size).toBe(1); // the rejection IS recorded for the webhook log
  });

  it("is idempotent on the abandonment id (re-delivery → duplicate)", async () => {
    const { processFlowWebhook } = await import("@/lib/ingest");
    const fake = new FakeSupabase(makeStoreRow());
    const p = { storeId: "store-1", secretHeader: FLOW_SECRET, rawBody: BROWSE_BODY };
    expect((await processFlowWebhook(p, fake as any)).status).toBe("ok");
    expect((await processFlowWebhook(p, fake as any)).status).toBe("duplicate");
    expect(fake.upsertedLeads).toHaveLength(1);
  });

  it("ignores an unknown Flow source (ok, no lead)", async () => {
    const { processFlowWebhook } = await import("@/lib/ingest");
    const fake = new FakeSupabase(makeStoreRow());
    const body = JSON.stringify({ source: "something_else", abandonment: { id: "zzz" } });
    const res = await processFlowWebhook(
      { storeId: "store-1", secretHeader: FLOW_SECRET, rawBody: body },
      fake as any,
    );
    expect(res.status).toBe("ok");
    expect(fake.upsertedLeads).toHaveLength(0);
  });
});

// A full StoreCreds-shaped object with the browse template ENABLED (the Settings
// toggle on). Cast to any at call sites — only the send-path fields are read.
function browseCreds(over: Record<string, any> = {}): any {
  return {
    id: "store-1",
    org_id: "org-1",
    name: "Aurela",
    shopify_domain: "aurela.myshopify.com",
    shopify_token: null,
    shopify_webhook_secret: null,
    kapso_project_id: null,
    kapso_api_key: "kapso-key",
    flow_webhook_secret: FLOW_SECRET,
    whatsapp_phone_number_id: "PN-1241790819006805",
    currency: "PEN",
    timezone: "America/Lima",
    status: "active",
    browse_template_enabled: true,
    browse_template_name: "busqueda_abandonada_1",
    browse_template_language: "es",
    ...over,
  };
}

function spyTemplate(result: any = { ok: true, id: "wamid.sent" }) {
  const calls: Array<{ opts: any; params: any }> = [];
  const fn = (async (opts: any, params: any) => {
    calls.push({ opts, params });
    return result;
  }) as any;
  return { fn, calls };
}

describe("processBrowseAbandonment · WhatsApp template send", () => {
  it("sends the approved template for a fresh lead and logs it", async () => {
    const { processBrowseAbandonment } = await import("@/lib/leads-ingest");
    const fake = new FakeSupabase(makeStoreRow());
    const { fn, calls } = spyTemplate();
    const res = await processBrowseAbandonment(fake as any, "store-1", JSON.parse(BROWSE_BODY), browseCreds(), fn);
    expect(res.status).toBe("ok");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.opts).toEqual({ apiKey: "kapso-key" });
    expect(calls[0]!.params).toMatchObject({
      phoneNumberId: "PN-1241790819006805",
      to: "51953249192",
      templateName: "busqueda_abandonada_1",
      language: "es",
    });
    expect(calls[0]!.params.bodyParams[0]).toBe("Sol"); // {{1}} = name
    expect(calls[0]!.params.bodyParams[1]).toContain("TravelersBackpack"); // {{2}} = viewed product
    expect(fake.leadCalls).toHaveLength(1);
    expect(fake.leadCalls[0]).toMatchObject({ store_id: "store-1", kind: "system", vendedora: null });
    expect(fake.leadCalls[0].note).toContain("busqueda_abandonada_1");
  });

  it("does NOT send when the template is disabled (lead still created)", async () => {
    const { processBrowseAbandonment } = await import("@/lib/leads-ingest");
    const fake = new FakeSupabase(makeStoreRow());
    const { fn, calls } = spyTemplate();
    await processBrowseAbandonment(
      fake as any,
      "store-1",
      JSON.parse(BROWSE_BODY),
      browseCreds({ browse_template_enabled: false }),
      fn,
    );
    expect(calls).toHaveLength(0);
    expect(fake.upsertedLeads).toHaveLength(1);
    expect(fake.leadCalls).toHaveLength(0);
  });

  it("does NOT send when the phone already has a lead (no spam)", async () => {
    const { processBrowseAbandonment } = await import("@/lib/leads-ingest");
    const fake = new FakeSupabase(makeStoreRow());
    fake.existingLeadPhones.add("51953249192");
    const { fn, calls } = spyTemplate();
    await processBrowseAbandonment(fake as any, "store-1", JSON.parse(BROWSE_BODY), browseCreds(), fn);
    expect(calls).toHaveLength(0);
  });

  it("does NOT send when no product was captured (empty {{2}})", async () => {
    const { processBrowseAbandonment } = await import("@/lib/leads-ingest");
    const fake = new FakeSupabase(makeStoreRow());
    const body = JSON.parse(BROWSE_BODY);
    body.productsViewed = [];
    body.productsAddedToCart = [];
    const { fn, calls } = spyTemplate();
    await processBrowseAbandonment(fake as any, "store-1", body, browseCreds(), fn);
    expect(calls).toHaveLength(0);
    expect(fake.upsertedLeads).toHaveLength(1); // lead still created, just no auto-message
  });

  it("logs a failure note but never throws when the send is rejected", async () => {
    const { processBrowseAbandonment } = await import("@/lib/leads-ingest");
    const fake = new FakeSupabase(makeStoreRow());
    const { fn } = spyTemplate({ ok: false, error: "Template paused", code: 132015 });
    const res = await processBrowseAbandonment(fake as any, "store-1", JSON.parse(BROWSE_BODY), browseCreds(), fn);
    expect(res.status).toBe("ok");
    expect(fake.upsertedLeads).toHaveLength(1);
    expect(fake.leadCalls).toHaveLength(1);
    expect(fake.leadCalls[0].note).toContain("falló");
  });
});

// Shopify Flow "winback" payload: order created → wait 60 days → no new order.
const WINBACK_BODY = JSON.stringify({
  source: "winback",
  event: "winback_60d",
  order: { id: 7001 },
  customer: { id: 9001, name: "Fanny", phone: "+51 953 249 192" },
  sentAt: "2026-07-06T12:00:00Z",
});

function winbackCreds(over: Record<string, any> = {}): any {
  return browseCreds({
    winback_template_enabled: true,
    winback_template_name: "recuperacion_60d_1",
    winback_template_language: "es",
    ...over,
  });
}

describe("processWinback · recuperación de clientes (60 días)", () => {
  it("winbackSeed extracts phone/name/ids (null without a usable phone)", async () => {
    const { winbackSeed } = await import("@/lib/leads-ingest");
    const seed = winbackSeed(JSON.parse(WINBACK_BODY))!;
    expect(seed).toEqual({ phone: "51953249192", name: "Fanny", customerId: "9001", orderId: "7001" });
    // firstName fallback when Flow sends it instead of name
    expect(winbackSeed({ customer: { firstName: "Sol", phone: "+51999888777" } })!.name).toBe("Sol");
    expect(winbackSeed({ customer: { name: "Ana" } })).toBeNull(); // no phone → nothing to send
  });

  it("routes source=winback via processFlowWebhook, dedupes by order cycle, creates NO lead", async () => {
    const { processFlowWebhook } = await import("@/lib/ingest");
    const fake = new FakeSupabase(makeStoreRow());
    const p = { storeId: "store-1", secretHeader: FLOW_SECRET, rawBody: WINBACK_BODY };
    expect((await processFlowWebhook(p, fake as any)).status).toBe("ok");
    expect((await processFlowWebhook(p, fake as any)).status).toBe("duplicate"); // Flow retry
    expect(fake.insertedWebhookIds.has("winback-7001")).toBe(true);
    expect(fake.upsertedLeads).toHaveLength(0); // winback never creates leads
  });

  it("sends the template with {{1}} = name; no lead → no lead_calls log", async () => {
    const { processWinback } = await import("@/lib/leads-ingest");
    const fake = new FakeSupabase(makeStoreRow());
    const { fn, calls } = spyTemplate();
    const res = await processWinback(fake as any, "store-1", JSON.parse(WINBACK_BODY), winbackCreds(), fn);
    expect(res.status).toBe("ok");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.opts).toEqual({ apiKey: "kapso-key" });
    expect(calls[0]!.params).toMatchObject({
      phoneNumberId: "PN-1241790819006805",
      to: "51953249192",
      templateName: "recuperacion_60d_1",
      language: "es",
      bodyParams: ["Fanny"],
    });
    expect(fake.upsertedLeads).toHaveLength(0);
    expect(fake.leadCalls).toHaveLength(0); // no existing lead to log on
    expect(fake.webhookUpdates.at(-1)).toMatchObject({ processed: true, error: null }); // sent → clean log
    // A successful send is recorded so a later coupon order can be attributed.
    expect(fake.winbackSends).toHaveLength(1);
    expect(fake.winbackSends[0]).toMatchObject({
      store_id: "store-1",
      phone: "51953249192",
      template_name: "recuperacion_60d_1",
      order_gid: "gid://shopify/Order/7001",
    });
  });

  it("does NOT record a winback_send when the template send fails", async () => {
    const { processWinback } = await import("@/lib/leads-ingest");
    const fake = new FakeSupabase(makeStoreRow());
    const bad = spyTemplate({ ok: false, error: "Template paused", code: 132015 });
    await processWinback(fake as any, "store-1", JSON.parse(WINBACK_BODY), winbackCreds(), bad.fn);
    expect(fake.winbackSends).toHaveLength(0); // only successful sends count
  });

  it("logs on the phone's existing lead (send ok and send failed)", async () => {
    const { processWinback } = await import("@/lib/leads-ingest");
    const fake = new FakeSupabase(makeStoreRow());
    fake.existingLeadPhones.add("51953249192");
    const { fn } = spyTemplate();
    await processWinback(fake as any, "store-1", JSON.parse(WINBACK_BODY), winbackCreds(), fn);
    expect(fake.leadCalls).toHaveLength(1);
    expect(fake.leadCalls[0]).toMatchObject({ kind: "system", vendedora: null });
    expect(fake.leadCalls[0].note).toContain("recuperacion_60d_1");

    const fake2 = new FakeSupabase(makeStoreRow());
    fake2.existingLeadPhones.add("51953249192");
    const bad = spyTemplate({ ok: false, error: "Template paused", code: 132015 });
    const body2 = JSON.parse(WINBACK_BODY);
    body2.order.id = 7002; // new cycle → not a duplicate
    const res = await processWinback(fake2 as any, "store-1", body2, winbackCreds(), bad.fn);
    expect(res.status).toBe("ok"); // never throws
    expect(fake2.leadCalls[0].note).toContain("falló");
    expect(fake2.webhookUpdates.at(-1).error).toContain("Falló el envío"); // reason visible in webhook log
  });

  it("does NOT send when disabled or when the name for {{1}} is missing", async () => {
    const { processWinback } = await import("@/lib/leads-ingest");
    const fake = new FakeSupabase(makeStoreRow());
    const { fn, calls } = spyTemplate();
    await processWinback(
      fake as any,
      "store-1",
      JSON.parse(WINBACK_BODY),
      winbackCreds({ winback_template_enabled: false }),
      fn,
    );
    expect(calls).toHaveLength(0);
    expect(fake.webhookUpdates.at(-1).error).toContain("deshabilitado"); // skip reason recorded

    const body = JSON.parse(WINBACK_BODY);
    body.order.id = 7003;
    delete body.customer.name;
    await processWinback(fake as any, "store-1", body, winbackCreds(), fn);
    expect(calls).toHaveLength(0); // {{1}} would be empty → Meta rejects; skip
    expect(fake.insertedWebhookIds.has("winback-7003")).toBe(true); // event still recorded
    expect(fake.webhookUpdates.at(-1).error).toContain("no tiene nombre"); // skip reason recorded
  });
});

describe("detectYapeByVision · vision gate for silent voucher images", () => {
  // Minimal admin: serves prior checks for the dedup query and records upserts.
  // `selectError` simulates a missing table / DB failure on the dedup query.
  function visionAdmin(existing: { message_id: string; is_voucher: boolean }[] = [], selectError = false) {
    const upserts: any[] = [];
    const admin = {
      from(_t: string) {
        const b: any = {
          select: () => b,
          eq: () => b,
          in: () => Promise.resolve(selectError ? { data: null, error: { message: "relation missing" } } : { data: existing }),
          upsert: (row: any) => {
            upserts.push(row);
            return Promise.resolve({ data: null, error: null });
          },
        };
        return b;
      },
    };
    return { admin, upserts };
  }

  const K = { apiKey: "k" } as any;
  const CANDS = [{ messageId: "m1", mediaUrl: "https://app.kapso.ai/a.jpg" }];
  const okImage = async () => ({ base64: "AAAA", contentType: "image/jpeg" });
  // A decided verdict (ok:true) vs a transient failure (ok:false).
  const verdict = (isVoucher: boolean, extra: any = {}) => ({ isVoucher, indicators: { logo: true, monto: true }, model: "m", ok: true, ...extra });
  const failed = () => ({ isVoucher: false, indicators: {}, model: "m", ok: false });

  async function run(admin: any, candidates: any[], analyze: any, opts: any = {}) {
    const { detectYapeByVision } = await import("@/lib/leads-ingest");
    return detectYapeByVision(admin, "store-1", K, candidates, analyze, { fetchImage: okImage, ...opts });
  }

  it("confirms a voucher and records the verdict", async () => {
    const { admin, upserts } = visionAdmin();
    let calls = 0;
    const out = await run(admin, CANDS, async () => {
      calls++;
      return verdict(true);
    });
    expect(out).toEqual({ voucher: true, analyzed: 1 });
    expect(calls).toBe(1);
    expect(upserts).toHaveLength(1);
    expect(upserts[0]).toMatchObject({ store_id: "store-1", message_id: "m1", is_voucher: true, model: "m" });
  });

  it("records a non-voucher verdict (so it is not re-analyzed) and stays negative", async () => {
    const { admin, upserts } = visionAdmin();
    const out = await run(admin, CANDS, async () => verdict(false));
    expect(out).toEqual({ voucher: false, analyzed: 1 });
    expect(upserts[0]).toMatchObject({ message_id: "m1", is_voucher: false });
  });

  it("does NOT record a transient failure (ok:false) — retries next run, no poison", async () => {
    const { admin, upserts } = visionAdmin();
    const out = await run(admin, CANDS, async () => failed());
    expect(out).toEqual({ voucher: false, analyzed: 1 }); // counted toward cap…
    expect(upserts).toHaveLength(0); // …but NOT persisted → re-analyzed next run
  });

  it("skips entirely when the dedup query errors (table absent → no re-billing)", async () => {
    const { admin, upserts } = visionAdmin([], true);
    let calls = 0;
    const out = await run(admin, CANDS, async () => {
      calls++;
      return verdict(true);
    });
    expect(out).toEqual({ voucher: false, analyzed: 0 });
    expect(calls).toBe(0); // no model call, no fetch — nothing until the migration lands
    expect(upserts).toHaveLength(0);
  });

  it("short-circuits on a prior positive check (no new model call)", async () => {
    const { admin } = visionAdmin([{ message_id: "m1", is_voucher: true }]);
    let calls = 0;
    const out = await run(admin, CANDS, async () => {
      calls++;
      return verdict(true);
    });
    expect(out).toEqual({ voucher: true, analyzed: 0 });
    expect(calls).toBe(0);
  });

  it("skips an image already decided negative (no re-analysis)", async () => {
    const { admin } = visionAdmin([{ message_id: "m1", is_voucher: false }]);
    let calls = 0;
    const out = await run(admin, CANDS, async () => {
      calls++;
      return verdict(true);
    });
    expect(out).toEqual({ voucher: false, analyzed: 0 });
    expect(calls).toBe(0);
  });

  it("honors the per-run cap (a provider outage can't storm)", async () => {
    const { admin } = visionAdmin();
    let calls = 0;
    const cands = [
      { messageId: "m1", mediaUrl: "https://app.kapso.ai/a.jpg" },
      { messageId: "m2", mediaUrl: "https://app.kapso.ai/b.jpg" },
    ];
    const out = await run(admin, cands, async () => {
      calls++;
      return failed(); // even failures count toward the cap
    }, { cap: 1 });
    expect(out.analyzed).toBe(1);
    expect(calls).toBe(1);
  });

  it("does not record or count when the image cannot be fetched (retryable)", async () => {
    const { admin, upserts } = visionAdmin();
    let calls = 0;
    const out = await run(admin, CANDS, async () => {
      calls++;
      return verdict(true);
    }, { fetchImage: async () => null });
    expect(out).toEqual({ voucher: false, analyzed: 0 });
    expect(calls).toBe(0);
    expect(upserts).toHaveLength(0);
  });

  it("returns negative for an empty candidate list without touching the model", async () => {
    const { admin } = visionAdmin();
    let calls = 0;
    const out = await run(admin, [], async () => {
      calls++;
      return verdict(true);
    });
    expect(out).toEqual({ voucher: false, analyzed: 0 });
    expect(calls).toBe(0);
  });
});

describe("resolveMetaAdNames · populate meta_ads with real ad names", () => {
  // Minimal admin: leads.select(...).limit() → the store's ad_ids; meta_ads
  // .select(...).in() → cached rows; meta_ads.upsert() → recorded.
  function fakeAdmin(leadIds: string[], cached: { ad_id: string; fetched_at: string | null }[]) {
    const upserts: any[] = [];
    const admin = {
      from(_t: string) {
        const b: any = {
          select: () => b,
          eq: () => b,
          not: () => b,
          in: () => Promise.resolve({ data: cached }), // meta_ads cached lookup
          limit: () => Promise.resolve({ data: leadIds.map((ad_id) => ({ ad_id })) }), // leads
          upsert: (rows: any[]) => {
            upserts.push(...rows);
            return Promise.resolve({ data: null, error: null });
          },
        };
        return b;
      },
    };
    return { admin, upserts };
  }

  const okFetch = (async (url: string) => {
    const id = new URL(url).pathname.split("/").filter(Boolean).pop();
    return {
      ok: true,
      status: 200,
      json: async () => ({ name: `Ad ${id}`, account_id: "9", campaign: { id: "c", name: "Camp" } }),
    };
  }) as unknown as typeof fetch;

  it("resolves only uncached/stale ad_ids and upserts them with a timestamp", async () => {
    const { resolveMetaAdNames } = await import("@/lib/ingest");
    const fresh = new Date().toISOString();
    const { admin, upserts } = fakeAdmin(["111", "222", "222", "333"], [{ ad_id: "111", fetched_at: fresh }]);
    const n = await resolveMetaAdNames(admin as any, "store-1", "TOK", { fetchImpl: okFetch });
    expect(n).toBe(2); // 111 is fresh-cached → skipped; 222 (deduped) + 333 resolved
    expect(upserts.map((r) => r.ad_id).sort()).toEqual(["222", "333"]);
    expect(upserts.every((r) => r.fetched_at && r.ad_name)).toBe(true);
  });

  it("re-resolves a STALE cached ad (keeps status fresh)", async () => {
    const { resolveMetaAdNames } = await import("@/lib/ingest");
    const old = "2020-01-01T00:00:00Z";
    const { admin, upserts } = fakeAdmin(["111"], [{ ad_id: "111", fetched_at: old }]);
    const n = await resolveMetaAdNames(admin as any, "store-1", "TOK", { fetchImpl: okFetch });
    expect(n).toBe(1);
    expect(upserts[0].ad_id).toBe("111");
  });

  it("no-ops without a token or with no campaign leads", async () => {
    const { resolveMetaAdNames } = await import("@/lib/ingest");
    const { admin } = fakeAdmin([], []);
    expect(await resolveMetaAdNames(admin as any, "s", "")).toBe(0); // no token
    expect(await resolveMetaAdNames(admin as any, "s", "TOK", { fetchImpl: okFetch })).toBe(0); // no ad_ids
  });
});

// ───────────────────── Drip de seguimiento (no contesta) ─────────────────────

function dripCreds(over: Record<string, any> = {}): any {
  return browseCreds({
    drip_template_enabled: true,
    drip_template_name: "seguimiento_nr_1",
    drip_template_language: "es",
    ...over,
  });
}

// 15:00Z = 10:00 en Lima (UTC−5) → dentro del horario 9–20.
const DRIP_NOW = "2026-07-13T15:00:00Z";

function dripLead(over: Record<string, any> = {}): any {
  return {
    id: "L1",
    phone: "51999888777",
    name: "Ana",
    status: "no_responde",
    needs_attention: false,
    next_followup_at: null,
    last_interaction_at: "2026-07-13T05:00:00Z", // hace 10h → silencio suficiente
    last_inbound_at: null,
    drip_touches: 0,
    last_drip_at: null,
    ...over,
  };
}

describe("dripSkipReason · la regla del drip (pura)", () => {
  it("acepta un nr silencioso y en orden", async () => {
    const { dripSkipReason } = await import("@/lib/leads-ingest");
    expect(dripSkipReason(dripLead(), Date.parse(DRIP_NOW))).toBeNull();
    expect(dripSkipReason(dripLead({ status: "buzon" }), Date.parse(DRIP_NOW))).toBeNull();
    expect(dripSkipReason(dripLead({ status: "cuelga" }), Date.parse(DRIP_NOW))).toBeNull();
  });

  it("rechaza estados fuera de nr/buzón/cuelga y las guardas de la asesora", async () => {
    const { dripSkipReason } = await import("@/lib/leads-ingest");
    const now = Date.parse(DRIP_NOW);
    expect(dripSkipReason(dripLead({ status: "contactado_dejo_wsp" }), now)).toBe("status");
    expect(dripSkipReason(dripLead({ status: "nuevo" }), now)).toBe("status");
    expect(dripSkipReason(dripLead({ needs_attention: true }), now)).toBe("atencion");
    expect(dripSkipReason(dripLead({ next_followup_at: "2026-07-14T15:00:00Z" }), now)).toBe("agendado");
  });

  it("la atención de una OLA no frena el drip (paralelo) — salvo respuesta reciente del cliente", async () => {
    const { dripSkipReason } = await import("@/lib/leads-ingest");
    const now = Date.parse(DRIP_NOW);
    // Reencolado por ola, cliente callado → drip dispara en paralelo a la llamada.
    expect(dripSkipReason(dripLead({ needs_attention: true, attention_waves: 1 }), now)).toBeNull();
    // Reencolado por ola PERO el cliente escribió hace 2h → lo ve la asesora.
    expect(
      dripSkipReason(
        dripLead({ needs_attention: true, attention_waves: 1, last_inbound_at: "2026-07-13T13:00:00Z" }),
        now,
      ),
    ).toBe("atencion");
    // Escribió hace 3 días → silencio suficiente, el drip vuelve a poder.
    expect(
      dripSkipReason(
        dripLead({ needs_attention: true, attention_waves: 1, last_inbound_at: "2026-07-10T10:00:00Z" }),
        now,
      ),
    ).toBeNull();
  });

  it("cede los carritos a la secuencia cuando cart_seq está activa (evita doble mensaje)", async () => {
    const { dripSkipReason } = await import("@/lib/leads-ingest");
    const now = Date.parse(DRIP_NOW);
    // cart_seq activa: un carrito NR cede su turno a carrito_abandonado_1/2.
    expect(dripSkipReason(dripLead({ cart_item_count: 2 }), now, true)).toBe("carrito_secuencia");
    expect(
      dripSkipReason(dripLead({ draft_order_gid: "gid://shopify/DraftOrder/9" }), now, true),
    ).toBe("carrito_secuencia");
    // Sin carrito → el genérico lo cubre igual, aunque cart_seq esté activa.
    expect(dripSkipReason(dripLead(), now, true)).toBeNull();
    // cart_seq apagada (default) → el carrito sigue recibiendo el genérico.
    expect(dripSkipReason(dripLead({ cart_item_count: 2 }), now)).toBeNull();
  });

  it("respeta tope de toques, nombre para {{1}} y el silencio mínimo de 6h", async () => {
    const { dripSkipReason, DRIP_MAX_TOUCHES } = await import("@/lib/leads-ingest");
    const now = Date.parse(DRIP_NOW);
    expect(dripSkipReason(dripLead({ drip_touches: DRIP_MAX_TOUCHES }), now)).toBe("tope");
    expect(dripSkipReason(dripLead({ name: null }), now)).toBe("sin_nombre");
    expect(dripSkipReason(dripLead({ last_interaction_at: "2026-07-13T13:30:00Z" }), now)).toBe("reciente"); // hace 1.5h
    expect(dripSkipReason(dripLead({ last_interaction_at: null }), now)).toBe("reciente"); // sin señal → conservador
  });

  it("toque 2: espera 24h del toque 1 y se corta si el cliente respondió", async () => {
    const { dripSkipReason } = await import("@/lib/leads-ingest");
    const now = Date.parse(DRIP_NOW);
    const t1 = dripLead({ drip_touches: 1, last_drip_at: "2026-07-13T02:00:00Z" }); // hace 13h
    expect(dripSkipReason(t1, now)).toBe("espera_toque2");
    const t2 = dripLead({ drip_touches: 1, last_drip_at: "2026-07-12T10:00:00Z" }); // hace 29h
    expect(dripSkipReason(t2, now)).toBeNull();
    const respondio = dripLead({
      drip_touches: 1,
      last_drip_at: "2026-07-12T10:00:00Z",
      last_inbound_at: "2026-07-12T18:00:00Z", // escribió DESPUÉS del drip
    });
    expect(dripSkipReason(respondio, now)).toBe("respondio");
  });
});

describe("dripWithinHours · horario 9–20 en la zona de la tienda", () => {
  it("dentro/fuera de la ventana en Lima (UTC−5)", async () => {
    const { dripWithinHours } = await import("@/lib/leads-ingest");
    expect(dripWithinHours("2026-07-13T14:00:00Z", "America/Lima")).toBe(true); // 09:00
    expect(dripWithinHours("2026-07-13T13:59:00Z", "America/Lima")).toBe(false); // 08:59
    expect(dripWithinHours("2026-07-13T23:00:00Z", "America/Lima")).toBe(true); // 18:00
    expect(dripWithinHours("2026-07-14T01:00:00Z", "America/Lima")).toBe(false); // 20:00
  });
});

describe("sendSeguimientoDrip · envío y registro", () => {
  it("no hace nada deshabilitado, sin plantilla o fuera de horario", async () => {
    const { sendSeguimientoDrip } = await import("@/lib/leads-ingest");
    const fake = new FakeSupabase(makeStoreRow());
    fake.dripLeads = [dripLead()];
    const { fn, calls } = spyTemplate();

    let r = await sendSeguimientoDrip(fake as any, "store-1", dripCreds({ drip_template_enabled: false }), fn, DRIP_NOW);
    expect(r).toEqual({ sent: 0, failed: 0, skipped: 0 });
    r = await sendSeguimientoDrip(fake as any, "store-1", dripCreds({ drip_template_name: null }), fn, DRIP_NOW);
    expect(r).toEqual({ sent: 0, failed: 0, skipped: 0 });
    r = await sendSeguimientoDrip(fake as any, "store-1", dripCreds(), fn, "2026-07-14T01:30:00Z"); // 20:30 Lima
    expect(r).toEqual({ sent: 0, failed: 0, skipped: 0 });
    expect(calls).toHaveLength(0);
  });

  it("envía la plantilla, consume el toque y registra en drip_sends + timeline", async () => {
    const { sendSeguimientoDrip } = await import("@/lib/leads-ingest");
    const fake = new FakeSupabase(makeStoreRow());
    fake.dripLeads = [dripLead(), dripLead({ id: "L2", phone: "51911222333", name: null })]; // L2 sin nombre → skip
    const { fn, calls } = spyTemplate();

    const r = await sendSeguimientoDrip(fake as any, "store-1", dripCreds(), fn, DRIP_NOW);
    expect(r).toEqual({ sent: 1, failed: 0, skipped: 1 });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.params).toMatchObject({
      phoneNumberId: "PN-1241790819006805",
      to: "51999888777",
      templateName: "seguimiento_nr_1",
      language: "es",
      bodyParams: ["Ana"],
    });
    expect(fake.leadPatches).toHaveLength(1);
    expect(fake.leadPatches[0]).toMatchObject({ id: "L1", drip_touches: 1, last_drip_at: DRIP_NOW });
    expect(fake.dripSends).toHaveLength(1);
    expect(fake.dripSends[0]).toMatchObject({
      store_id: "store-1",
      lead_id: "L1",
      phone: "51999888777",
      template_name: "seguimiento_nr_1",
      touch: 1,
      ok: true,
      error: null,
    });
    expect(fake.leadCalls).toHaveLength(1);
    expect(fake.leadCalls[0]).toMatchObject({ lead_id: "L1", kind: "system", vendedora: null });
    expect(fake.leadCalls[0].note).toContain("toque 1/2");
  });

  it("un envío rechazado consume el toque igual (no re-martilla) y deja el motivo", async () => {
    const { sendSeguimientoDrip } = await import("@/lib/leads-ingest");
    const fake = new FakeSupabase(makeStoreRow());
    fake.dripLeads = [dripLead()];
    const bad = spyTemplate({ ok: false, error: "Template paused", code: 132015 });

    const r = await sendSeguimientoDrip(fake as any, "store-1", dripCreds(), bad.fn, DRIP_NOW);
    expect(r).toEqual({ sent: 0, failed: 1, skipped: 0 });
    expect(fake.leadPatches[0]).toMatchObject({ drip_touches: 1 }); // toque consumido
    expect(fake.dripSends[0]).toMatchObject({ ok: false, error: "Template paused" });
    expect(fake.leadCalls[0].note).toContain("falló");
  });

  it("multinúmero: envía por el número del LEAD y cae al default de la tienda", async () => {
    const { sendSeguimientoDrip } = await import("@/lib/leads-ingest");
    const fake = new FakeSupabase(makeStoreRow());
    fake.dripLeads = [
      dripLead({ id: "L1", phone: "51900000001", wa_phone_number_id: "PN-LEAD-77" }),
      dripLead({ id: "L2", phone: "51900000002" }), // sin número propio → default de tienda
    ];
    const { fn, calls } = spyTemplate();
    const r = await sendSeguimientoDrip(fake as any, "store-1", dripCreds(), fn, DRIP_NOW);
    expect(r).toEqual({ sent: 2, failed: 0, skipped: 0 });
    expect(calls.map((c) => c.params.phoneNumberId)).toEqual(["PN-LEAD-77", "PN-1241790819006805"]);
  });

  it("tienda SIN default (Kenku): envía por el número del lead; sin ninguno no consume toque", async () => {
    const { sendSeguimientoDrip } = await import("@/lib/leads-ingest");
    const fake = new FakeSupabase(makeStoreRow());
    fake.dripLeads = [
      dripLead({ id: "L1", phone: "51900000001", wa_phone_number_id: "PN-LEAD-77" }),
      dripLead({ id: "L2", phone: "51900000002" }), // sin número resoluble → skip
    ];
    const { fn, calls } = spyTemplate();
    const r = await sendSeguimientoDrip(
      fake as any,
      "store-1",
      dripCreds({ whatsapp_phone_number_id: null }),
      fn,
      DRIP_NOW,
    );
    expect(r).toEqual({ sent: 1, failed: 0, skipped: 1 });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.params.phoneNumberId).toBe("PN-LEAD-77");
    expect(fake.leadPatches).toHaveLength(1); // solo L1 consumió toque
    expect(fake.dripSends).toHaveLength(1);
  });

  it("tope de mensajería (tier): corta el lote, registra el intento y NO quema toques", async () => {
    const { sendSeguimientoDrip } = await import("@/lib/leads-ingest");
    const fake = new FakeSupabase(makeStoreRow());
    fake.dripLeads = [
      dripLead(),
      dripLead({ id: "L2", phone: "51911222333" }),
      dripLead({ id: "L3", phone: "51911222444" }),
    ];
    const bad = spyTemplate({ ok: false, error: "Spam rate limit hit", code: 131048 });
    const r = await sendSeguimientoDrip(fake as any, "store-1", dripCreds(), bad.fn, DRIP_NOW);
    expect(r).toEqual({ sent: 0, failed: 1, skipped: 0 });
    expect(bad.calls).toHaveLength(1); // cortó tras el primer rechazo (el tope es de la tienda)
    expect(fake.leadPatches).toHaveLength(0); // ningún toque consumido
    expect(fake.dripSends).toHaveLength(1);
    expect(fake.dripSends[0]).toMatchObject({ ok: false, error: "Spam rate limit hit", touch: 1 });
    expect(fake.leadCalls).toHaveLength(0); // sin nota ⚠️ en el timeline (no es culpa del lead)
  });

  it("isTierLimitError clasifica códigos y mensajes de tope", async () => {
    const { isTierLimitError } = await import("@/lib/leads-ingest");
    expect(isTierLimitError(131048, "Spam rate limit hit")).toBe(true);
    expect(isTierLimitError(130429, null)).toBe(true);
    expect(isTierLimitError(undefined, "Messaging limit reached")).toBe(true);
    expect(isTierLimitError(132015, "Template paused")).toBe(false);
    expect(isTierLimitError(undefined, "Template paused")).toBe(false);
    expect(isTierLimitError(undefined, null)).toBe(false);
  });

  it("con la secuencia de carritos activa, el drip cede los carritos (solo envía a no-carrito)", async () => {
    const { sendSeguimientoDrip } = await import("@/lib/leads-ingest");
    const fake = new FakeSupabase(makeStoreRow());
    fake.dripLeads = [
      dripLead({ id: "C1", phone: "51900000001", cart_item_count: 2 }), // carrito → lo toma carrito_abandonado
      dripLead({ id: "F1", phone: "51900000002" }), // frío → genérico
    ];
    const { fn, calls } = spyTemplate();
    const r = await sendSeguimientoDrip(fake as any, "store-1", dripCreds({ cart_seq_enabled: true }), fn, DRIP_NOW);
    expect(r.sent).toBe(1);
    expect(calls.map((c) => c.params.to)).toEqual(["51900000002"]); // solo el no-carrito
    expect(fake.dripSends).toHaveLength(1);
  });

  it("despacha CARRITOS primero (Meta raciona y vigila la plantilla nueva)", async () => {
    const { sendSeguimientoDrip } = await import("@/lib/leads-ingest");
    const fake = new FakeSupabase(makeStoreRow());
    fake.dripLeads = [
      dripLead({ id: "F1", phone: "51900000001" }), // frio, sin carrito
      dripLead({ id: "C1", phone: "51900000002", cart_item_count: 2 }),
      dripLead({ id: "C2", phone: "51900000003", cart_item_count: null, draft_order_gid: "gid://shopify/DraftOrder/9" }),
    ];
    const { fn, calls } = spyTemplate();
    await sendSeguimientoDrip(fake as any, "store-1", dripCreds(), fn, DRIP_NOW);
    // Los dos carritos (por count y por draft) salen antes que el frío.
    expect(calls.map((c) => c.params.to)).toEqual(["51900000002", "51900000003", "51900000001"]);
  });

  it("respeta el cap por corrida (DRIP_BATCH_CAP)", async () => {
    const { sendSeguimientoDrip, DRIP_BATCH_CAP } = await import("@/lib/leads-ingest");
    const fake = new FakeSupabase(makeStoreRow());
    fake.dripLeads = Array.from({ length: DRIP_BATCH_CAP + 5 }, (_, i) =>
      dripLead({ id: `L${i}`, phone: `5199900${String(i).padStart(4, "0")}` }),
    );
    const { fn, calls } = spyTemplate();
    const r = await sendSeguimientoDrip(fake as any, "store-1", dripCreds(), fn, DRIP_NOW);
    expect(r.sent).toBe(DRIP_BATCH_CAP);
    expect(calls).toHaveLength(DRIP_BATCH_CAP);
  });
});


// ─────────────── Olas de reencolado de carritos (no contestan) ───────────────

describe("flagCartAttentionWaves · olas de reencolado con tope", () => {
  const waveLead = (over: Record<string, any> = {}): any => ({
    id: "W1",
    cart_item_count: 2,
    draft_order_gid: null,
    attention_waves: 0,
    ...over,
  });

  it("sube con atención, suma la ola y deja la nota 🔁 (ola 1/2 y 2/2)", async () => {
    const { flagCartAttentionWaves } = await import("@/lib/leads-ingest");
    const fake = new FakeSupabase(makeStoreRow());
    fake.waveLeads = [waveLead(), waveLead({ id: "W2", attention_waves: 1 })];
    const n = await flagCartAttentionWaves(fake as any, "store-1");
    expect(n).toBe(2);
    expect(fake.leadPatches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ needs_attention: true, attention_waves: 1 }),
        expect.objectContaining({ needs_attention: true, attention_waves: 2 }),
      ]),
    );
    const notes = fake.leadCalls.map((c) => c.note).join("\n");
    expect(notes).toContain("ola 1/2");
    expect(notes).toContain("ola 2/2");
    expect(fake.leadCalls.every((c) => c.kind === "system" && c.vendedora === null)).toBe(true);
  });

  it("descarta filas sin señal de carrito (re-chequeo fino)", async () => {
    const { flagCartAttentionWaves } = await import("@/lib/leads-ingest");
    const fake = new FakeSupabase(makeStoreRow());
    fake.waveLeads = [waveLead({ cart_item_count: 0, draft_order_gid: null }), waveLead({ id: "W2" })];
    const n = await flagCartAttentionWaves(fake as any, "store-1");
    expect(n).toBe(1);
    expect(fake.leadPatches).toHaveLength(1);
  });

  it("con draft_order_gid (sin count) también es carrito", async () => {
    const { flagCartAttentionWaves } = await import("@/lib/leads-ingest");
    const fake = new FakeSupabase(makeStoreRow());
    fake.waveLeads = [waveLead({ cart_item_count: null, draft_order_gid: "gid://shopify/DraftOrder/1" })];
    expect(await flagCartAttentionWaves(fake as any, "store-1")).toBe(1);
  });

  it("pre-0036 (columna ausente) es un no-op silencioso", async () => {
    const { flagCartAttentionWaves } = await import("@/lib/leads-ingest");
    const fake = new FakeSupabase(makeStoreRow());
    fake.waveSelectError = 'column leads.attention_waves does not exist';
    fake.waveLeads = [waveLead()];
    expect(await flagCartAttentionWaves(fake as any, "store-1")).toBe(0);
    expect(fake.leadPatches).toHaveLength(0);
  });
});
