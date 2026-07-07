import { describe, it, expect, beforeAll } from "vitest";
import { encrypt, generateEncryptionKey } from "@/lib/crypto";
import { authorizeKapsoWebhook, processKapsoWebhook } from "@/lib/ingest";

// Regression guard for cross-tenant isolation on the Kapso lead webhook. The
// webhook used to authenticate with the GLOBAL CRON_SECRET, so any store owner
// who knew it could inject leads/conversations into ANY other store. It now
// authenticates against each store's OWN secret; these tests prove one store's
// secret can't write into another store.

const KEY = generateEncryptionKey();
const STORE_A_SECRET = "kapso_secret_store_A";
const STORE_B_SECRET = "kapso_secret_store_B";
const CRON = "global_cron_secret";

beforeAll(() => {
  process.env.ENCRYPTION_KEY = KEY;
  process.env.CRON_SECRET = CRON;
});

// A handoff payload — classifyKapsoEvent → "handoff" (dispatches to a lead write).
const HANDOFF_BODY = {
  event: "workflow.execution.handoff",
  conversation: { phone_number: "51999888777" },
  reason: "cliente quiere comprar",
  context_summary: "pidió precio",
};

type Row = Record<string, any>;

/** Minimal thenable fake of the Supabase client, enough for getStoreCreds +
 *  applyHandoff. Records every write to `leads` so tests can assert isolation. */
class FakeSupabase {
  leadWrites: any[] = [];
  constructor(private stores: Record<string, Row>) {}
  from(table: string) {
    return new FakeBuilder(table, this);
  }
  async rpc() {
    return { error: null };
  }
  exec(b: FakeBuilder): { data: any; error: any } {
    if (b.table === "stores" && b.op === "select") {
      return { data: this.stores[b.filters.id] ?? null, error: null };
    }
    if (b.table === "leads" && (b.op === "upsert" || b.op === "update" || b.op === "insert")) {
      const rows = Array.isArray(b.payload) ? b.payload : [b.payload];
      this.leadWrites.push(...rows);
      return { data: null, error: null };
    }
    if (b.table === "leads" && b.op === "select") {
      return { data: null, error: null }; // no existing lead
    }
    return { data: null, error: null }; // lead_calls insert, etc.
  }
}

class FakeBuilder {
  op: string | null = null;
  payload: any;
  filters: Row = {};
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
  is(k: string, v: any) {
    this.filters[k] = v;
    return this;
  }
  limit() {
    return this;
  }
  maybeSingle() {
    return this;
  }
  single() {
    return this;
  }
  then(resolve: (v: any) => any, reject?: (e: any) => any) {
    return Promise.resolve(this.store.exec(this)).then(resolve, reject);
  }
}

function storeRow(id: string, secretPlain: string | null): Row {
  return {
    id,
    org_id: `org-${id}`,
    name: id,
    shopify_domain: `${id}.myshopify.com`,
    shopify_token_enc: null,
    shopify_webhook_secret_enc: null,
    kapso_project_id: null,
    kapso_api_key_enc: null,
    flow_webhook_secret_enc: null,
    kapso_webhook_secret_enc: secretPlain ? encrypt(secretPlain, KEY) : null,
    whatsapp_phone_number_id: null,
    currency: "PEN",
    timezone: "America/Lima",
    status: "active",
  };
}

describe("authorizeKapsoWebhook (pure)", () => {
  it("with a per-store secret set, ONLY that secret is accepted", () => {
    expect(authorizeKapsoWebhook(STORE_A_SECRET, STORE_A_SECRET, CRON)).toBe(true);
    // another store's secret must be rejected...
    expect(authorizeKapsoWebhook(STORE_B_SECRET, STORE_A_SECRET, CRON)).toBe(false);
    // ...and so must the shared CRON_SECRET (the whole point of per-store auth).
    expect(authorizeKapsoWebhook(CRON, STORE_A_SECRET, CRON)).toBe(false);
  });

  it("without a per-store secret, falls back to CRON_SECRET (legacy)", () => {
    expect(authorizeKapsoWebhook(CRON, null, CRON)).toBe(true);
    expect(authorizeKapsoWebhook("nope", null, CRON)).toBe(false);
  });

  it("rejects a missing secret and a missing expected", () => {
    expect(authorizeKapsoWebhook(null, STORE_A_SECRET, CRON)).toBe(false);
    expect(authorizeKapsoWebhook(STORE_A_SECRET, null, null)).toBe(false);
  });
});

describe("processKapsoWebhook (tenant isolation)", () => {
  it("rejects store B's secret against store A and writes NOTHING", async () => {
    const fake = new FakeSupabase({
      "store-A": storeRow("store-A", STORE_A_SECRET),
      "store-B": storeRow("store-B", STORE_B_SECRET),
    });
    const res = await processKapsoWebhook(
      { storeId: "store-A", providedSecret: STORE_B_SECRET, eventHeader: null, body: HANDOFF_BODY },
      fake as any,
    );
    expect(res.status).toBe("unauthorized");
    expect(fake.leadWrites).toHaveLength(0);
  });

  it("rejects the shared CRON_SECRET once store A has its own secret", async () => {
    const fake = new FakeSupabase({ "store-A": storeRow("store-A", STORE_A_SECRET) });
    const res = await processKapsoWebhook(
      { storeId: "store-A", providedSecret: CRON, eventHeader: null, body: HANDOFF_BODY },
      fake as any,
    );
    expect(res.status).toBe("unauthorized");
    expect(fake.leadWrites).toHaveLength(0);
  });

  it("accepts store A's own secret and dispatches the handoff into store A", async () => {
    const fake = new FakeSupabase({ "store-A": storeRow("store-A", STORE_A_SECRET) });
    const res = await processKapsoWebhook(
      { storeId: "store-A", providedSecret: STORE_A_SECRET, eventHeader: null, body: HANDOFF_BODY },
      fake as any,
    );
    expect(res.status).toBe("ok");
    expect(res.kind).toBe("handoff");
    expect(fake.leadWrites.length).toBeGreaterThan(0);
    // Every write is scoped to store A.
    for (const w of fake.leadWrites) expect(w.store_id).toBe("store-A");
  });

  it("still accepts CRON_SECRET for a store without its own secret (legacy)", async () => {
    const fake = new FakeSupabase({ "store-legacy": storeRow("store-legacy", null) });
    const res = await processKapsoWebhook(
      { storeId: "store-legacy", providedSecret: CRON, eventHeader: null, body: HANDOFF_BODY },
      fake as any,
    );
    expect(res.status).toBe("ok");
    expect(fake.leadWrites.length).toBeGreaterThan(0);
  });

  it("treats an unknown store as unauthorized (no enumeration)", async () => {
    const fake = new FakeSupabase({ "store-A": storeRow("store-A", STORE_A_SECRET) });
    const res = await processKapsoWebhook(
      { storeId: "does-not-exist", providedSecret: STORE_A_SECRET, eventHeader: null, body: HANDOFF_BODY },
      fake as any,
    );
    expect(res.status).toBe("unauthorized");
    expect(fake.leadWrites).toHaveLength(0);
  });
});
