import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { recordShopifyPrivacyRequest } from "@/lib/shopify-privacy";

// Webhooks obligatorios de privacidad de la app de clientes (MOM §29.15.9).
// La revisión de Shopify comprueba que el endpoint responda y que rechace con
// 401 una firma inválida; aquí también, que nada se escriba en ese caso.

const SECRET = "client_app_secret";

type Row = Record<string, any>;

class FakeAdmin {
  stores: Row[] = [];
  requests: Row[] = [];
  storeUpdates: { patch: Row; filters: Row }[] = [];
  from(table: string) {
    return new FakeQuery(this, table);
  }
}

class FakeQuery {
  op: "select" | "insert" | "update" = "select";
  payload: Row = {};
  filters: Row = {};
  constructor(private db: FakeAdmin, private table: string) {}
  select() {
    return this;
  }
  insert(p: Row) {
    this.op = "insert";
    this.payload = p;
    return this;
  }
  update(p: Row) {
    this.op = "update";
    this.payload = p;
    return this;
  }
  eq(k: string, v: unknown) {
    this.filters[k] = v;
    return this;
  }
  is(k: string, v: unknown) {
    this.filters[`${k}__is`] = v;
    return this;
  }
  maybeSingle() {
    return this;
  }
  then(resolve: (v: any) => any) {
    return Promise.resolve(this.exec()).then(resolve);
  }
  exec(): { data: any; error: any } {
    if (this.table === "stores" && this.op === "select") {
      const row = this.db.stores.find(
        (s) => s.shopify_domain === this.filters.shopify_domain && s.shopify_app === this.filters.shopify_app,
      );
      return { data: row ? { id: row.id } : null, error: null };
    }
    if (this.table === "stores" && this.op === "update") {
      this.db.storeUpdates.push({ patch: this.payload, filters: this.filters });
      const row = this.db.stores.find((s) => s.id === this.filters.id);
      if (row) {
        const guard = this.filters["shopify_uninstalled_at__is"];
        if (guard === undefined || row.shopify_uninstalled_at == null) Object.assign(row, this.payload);
      }
      return { data: null, error: null };
    }
    if (this.table === "shopify_privacy_requests" && this.op === "insert") {
      if (this.db.requests.some((r) => r.webhook_id === this.payload.webhook_id)) {
        return { data: null, error: { code: "23505", message: "duplicate" } };
      }
      this.db.requests.push(this.payload);
      return { data: null, error: null };
    }
    return { data: null, error: null };
  }
}

function sign(body: string, secret = SECRET): string {
  return createHmac("sha256", secret).update(body, "utf8").digest("base64");
}

function adminWithClientStore(): FakeAdmin {
  const db = new FakeAdmin();
  db.stores.push({
    id: "store-c",
    shopify_domain: "tienda-cliente.myshopify.com",
    shopify_app: "clientes",
    status: "active",
    shopify_token_enc: "token-cifrado",
    shopify_uninstalled_at: null,
  });
  return db;
}

const REDACT_BODY = JSON.stringify({
  shop_id: 954889,
  shop_domain: "tienda-cliente.myshopify.com",
  customer: { id: 191167, email: "comprador@example.com", phone: "999999999" },
  orders_to_redact: [299938, 280263],
});
const SHOP_REDACT_BODY = JSON.stringify({ shop_id: 954889, shop_domain: "tienda-cliente.myshopify.com" });

describe("recordShopifyPrivacyRequest", () => {
  it("una firma inválida → 401 y no escribe nada", async () => {
    const db = adminWithClientStore();
    const res = await recordShopifyPrivacyRequest(db as any, {
      topic: "customers/redact",
      rawBody: REDACT_BODY,
      hmacHeader: sign(REDACT_BODY, "otro_secreto"),
      webhookIdHeader: "wh-1",
      secret: SECRET,
    });
    expect(res.status).toBe("unauthorized");
    expect(db.requests).toHaveLength(0);
    expect(db.storeUpdates).toHaveLength(0);
  });

  it("sin la app configurada, todo se rechaza", async () => {
    const db = adminWithClientStore();
    const res = await recordShopifyPrivacyRequest(db as any, {
      topic: "customers/redact",
      rawBody: REDACT_BODY,
      hmacHeader: sign(REDACT_BODY),
      webhookIdHeader: "wh-1",
      secret: "",
    });
    expect(res.status).toBe("unauthorized");
    expect(db.requests).toHaveLength(0);
  });

  it("customers/redact queda registrado y pendiente, con su tienda", async () => {
    const db = adminWithClientStore();
    const res = await recordShopifyPrivacyRequest(db as any, {
      topic: "customers/redact",
      rawBody: REDACT_BODY,
      hmacHeader: sign(REDACT_BODY),
      webhookIdHeader: "wh-1",
      secret: SECRET,
    });
    expect(res.status).toBe("ok");
    expect(db.requests).toEqual([
      expect.objectContaining({
        topic: "customers/redact",
        shop_domain: "tienda-cliente.myshopify.com",
        shop_id: "954889",
        store_id: "store-c",
        webhook_id: "wh-1",
      }),
    ]);
    // Un aviso de comprador no toca la tienda.
    expect(db.storeUpdates).toHaveLength(0);
  });

  it("el mismo aviso dos veces → duplicado, una sola fila", async () => {
    const db = adminWithClientStore();
    const params = {
      topic: "customers/data_request",
      rawBody: REDACT_BODY,
      hmacHeader: sign(REDACT_BODY),
      webhookIdHeader: "wh-2",
      secret: SECRET,
    };
    expect((await recordShopifyPrivacyRequest(db as any, params)).status).toBe("ok");
    expect((await recordShopifyPrivacyRequest(db as any, params)).status).toBe("duplicate");
    expect(db.requests).toHaveLength(1);
  });

  it("shop/redact corta el acceso de la tienda y fecha la desinstalación si faltaba", async () => {
    const db = adminWithClientStore();
    const res = await recordShopifyPrivacyRequest(db as any, {
      topic: "shop/redact",
      rawBody: SHOP_REDACT_BODY,
      hmacHeader: sign(SHOP_REDACT_BODY),
      webhookIdHeader: "wh-3",
      secret: SECRET,
      now: new Date("2026-10-10T12:00:00Z"),
    });
    expect(res.status).toBe("ok");
    expect(db.stores[0]!).toEqual(
      expect.objectContaining({
        shopify_token_enc: null,
        status: "disabled",
        shopify_uninstalled_at: "2026-10-10T12:00:00.000Z",
      }),
    );
  });

  it("shop/redact no pisa la fecha de una desinstalación ya registrada", async () => {
    const db = adminWithClientStore();
    db.stores[0]!.shopify_uninstalled_at = "2026-10-08T09:00:00.000Z";
    await recordShopifyPrivacyRequest(db as any, {
      topic: "shop/redact",
      rawBody: SHOP_REDACT_BODY,
      hmacHeader: sign(SHOP_REDACT_BODY),
      webhookIdHeader: "wh-4",
      secret: SECRET,
    });
    expect(db.stores[0]!.shopify_uninstalled_at).toBe("2026-10-08T09:00:00.000Z");
  });

  it("un aviso de una tienda que no está en Kapta se guarda igual, sin tienda", async () => {
    const db = new FakeAdmin();
    const res = await recordShopifyPrivacyRequest(db as any, {
      topic: "shop/redact",
      rawBody: SHOP_REDACT_BODY,
      hmacHeader: sign(SHOP_REDACT_BODY),
      webhookIdHeader: "wh-5",
      secret: SECRET,
    });
    expect(res.status).toBe("ok");
    expect(db.requests[0]!.store_id).toBeNull();
  });

  it("un tema que no es de privacidad se ignora sin escribir", async () => {
    const db = adminWithClientStore();
    const res = await recordShopifyPrivacyRequest(db as any, {
      topic: "orders/create",
      rawBody: REDACT_BODY,
      hmacHeader: sign(REDACT_BODY),
      webhookIdHeader: "wh-6",
      secret: SECRET,
    });
    expect(res.status).toBe("ignored");
    expect(db.requests).toHaveLength(0);
  });

  it("un aviso firmado pero sin tienda válida → inválido", async () => {
    const body = JSON.stringify({ shop_domain: "evil.com" });
    const db = adminWithClientStore();
    const res = await recordShopifyPrivacyRequest(db as any, {
      topic: "shop/redact",
      rawBody: body,
      hmacHeader: sign(body),
      webhookIdHeader: "wh-7",
      secret: SECRET,
    });
    expect(res.status).toBe("invalid");
    expect(db.requests).toHaveLength(0);
  });
});
