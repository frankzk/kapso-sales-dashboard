import { describe, it, expect, beforeAll } from "vitest";
import { createHmac } from "node:crypto";
import { encrypt, generateEncryptionKey } from "@/lib/crypto";
import {
  closeCartLeadsWithOrders,
  orderClosesCart,
  sameCartProduct,
  type CartProductRef,
} from "@/lib/leads-ingest";

// «Carrito que ya es pedido» (MOM): un carrito sale de la cola cuando llega un
// pedido del mismo teléfono, no anulado, posterior al carrito y con al menos un
// producto en común. Sin ventana de horas.

const ETIOPE: CartProductRef = {
  product_id: "10134191243559",
  sku: "PRUEBA-ETHIOPIAN",
  title: "SUPER HUMAN Ethiopian Black Seed Oil (60 Cápsulas)",
};
const CAYENNE: CartProductRef = {
  product_id: "9671570030887",
  sku: "63603555",
  title: "Cayenne Pepper – Suplemento Botánico (60 Cápsulas)",
};

describe("sameCartProduct", () => {
  it("reconoce el producto por su id", () => {
    expect(sameCartProduct(ETIOPE, { product_id: ETIOPE.product_id, sku: null, title: "otro nombre" })).toBe(true);
  });

  it("reconoce por SKU un ítem de EasySell que llegó sin product_id", () => {
    expect(sameCartProduct({ ...ETIOPE, product_id: null }, { ...ETIOPE, title: "renombrado" })).toBe(true);
  });

  it("reconoce por nombre, sin importar mayúsculas ni espacios", () => {
    expect(
      sameCartProduct(
        { product_id: null, sku: null, title: "  Nails  Repairing – Sérum " },
        { product_id: "8327642284327", sku: null, title: "nails repairing – sérum" },
      ),
    ).toBe(true);
  });

  it("distingue productos distintos", () => {
    expect(sameCartProduct(ETIOPE, CAYENNE)).toBe(false);
  });

  it("dos ítems vacíos no son el mismo producto", () => {
    expect(sameCartProduct({ product_id: null, sku: "", title: "" }, { product_id: null, sku: "", title: "" })).toBe(false);
  });
});

describe("orderClosesCart (las variables fijas)", () => {
  const cart = { createdAt: "2026-09-13T12:20:33+00:00", items: [ETIOPE] };
  const order = { created_at: "2026-09-29T10:10:56+00:00", cancelled_at: null, line_items: [ETIOPE] };

  it("pedido posterior, no anulado y con el mismo producto → cierra el carrito", () => {
    expect(orderClosesCart(cart, order)).toBe(true);
  });

  it("no hay ventana de horas: 16 días después sigue cerrando", () => {
    expect(orderClosesCart(cart, { ...order, created_at: "2026-09-29T12:00:00+00:00" })).toBe(true);
  });

  it("un pedido anulado no cierra nada", () => {
    expect(orderClosesCart(cart, { ...order, cancelled_at: "2026-09-29T11:00:00+00:00" })).toBe(false);
  });

  it("un pedido ANTERIOR al carrito no lo cierra (el carrito es una compra nueva)", () => {
    expect(orderClosesCart(cart, { ...order, created_at: "2026-09-01T14:02:56+00:00" })).toBe(false);
  });

  it("el mismo instante no cuenta como posterior", () => {
    expect(orderClosesCart(cart, { ...order, created_at: cart.createdAt })).toBe(false);
  });

  it("otro producto no cierra el carrito", () => {
    expect(orderClosesCart(cart, { ...order, line_items: [CAYENNE] })).toBe(false);
  });

  it("basta UN producto en común en un pedido con varios", () => {
    expect(orderClosesCart(cart, { ...order, line_items: [CAYENNE, ETIOPE] })).toBe(true);
  });

  it("compara instantes, no texto: el webhook trae -05:00 y la base +00:00", () => {
    // 23:30 del 12 en Lima = 04:30Z del 13: POSTERIOR al carrito de las 04:00Z,
    // aunque como texto "2026-09-12T23" sea menor que "2026-09-13T04".
    const c = { createdAt: "2026-09-13T04:00:00+00:00", items: [ETIOPE] };
    expect(orderClosesCart(c, { ...order, created_at: "2026-09-12T23:30:00-05:00" })).toBe(true);
  });

  it("sin fechas o sin ítems no cierra", () => {
    expect(orderClosesCart({ createdAt: null, items: [ETIOPE] }, order)).toBe(false);
    expect(orderClosesCart(cart, { ...order, created_at: null })).toBe(false);
    expect(orderClosesCart(cart, { ...order, line_items: null })).toBe(false);
    expect(orderClosesCart({ createdAt: cart.createdAt, items: [] }, order)).toBe(false);
  });
});

// --- Base en memoria que SÍ aplica los filtros -------------------------------
// La regla se decide en las consultas (open/hot, no anulado, teléfono), así que
// el fake tiene que filtrar de verdad para que la prueba diga algo.
type Row = Record<string, any>;

function instant(v: unknown): number {
  return typeof v === "string" ? Date.parse(v) : NaN;
}

class MemQuery {
  private op: "select" | "insert" | "upsert" | "update" | "delete" | null = null;
  private payload: any;
  private conflict: string[] = [];
  private preds: ((r: Row) => boolean)[] = [];
  private returning = false;
  private wantOne = false;
  private sorts: { col: string; asc: boolean }[] = [];
  private from_ = 0;
  private to_: number | null = null;

  constructor(private db: MemDb, private table: string) {}

  select(_cols?: string) {
    if (this.op) this.returning = true;
    else this.op = "select";
    return this;
  }
  insert(p: any) {
    this.op = "insert";
    this.payload = p;
    return this;
  }
  upsert(p: any, o?: { onConflict?: string }) {
    this.op = "upsert";
    this.payload = p;
    this.conflict = (o?.onConflict ?? "id").split(",").map((s) => s.trim());
    return this;
  }
  update(p: any) {
    this.op = "update";
    this.payload = p;
    return this;
  }
  delete() {
    this.op = "delete";
    return this;
  }
  eq(k: string, v: any) {
    this.preds.push((r) => r[k] === v);
    return this;
  }
  neq(k: string, v: any) {
    this.preds.push((r) => r[k] !== v);
    return this;
  }
  in(k: string, vs: any[]) {
    this.preds.push((r) => vs.includes(r[k]));
    return this;
  }
  is(k: string, v: any) {
    this.preds.push((r) => (r[k] ?? null) === v);
    return this;
  }
  not(k: string, op: string, v: any) {
    if (op === "is") this.preds.push((r) => (r[k] ?? null) !== v);
    return this;
  }
  gte(k: string, v: any) {
    this.preds.push((r) => instant(r[k]) >= instant(v));
    return this;
  }
  lte(k: string, v: any) {
    this.preds.push((r) => instant(r[k]) <= instant(v));
    return this;
  }
  gt(k: string, v: any) {
    this.preds.push((r) => instant(r[k]) > instant(v));
    return this;
  }
  lt(k: string, v: any) {
    this.preds.push((r) => instant(r[k]) < instant(v));
    return this;
  }
  or() {
    return this;
  }
  match(m: Row) {
    for (const [k, v] of Object.entries(m)) this.eq(k, v);
    return this;
  }
  order(col: string, o?: { ascending?: boolean }) {
    this.sorts.push({ col, asc: o?.ascending ?? true });
    return this;
  }
  range(a: number, b: number) {
    this.from_ = a;
    this.to_ = b;
    return this;
  }
  limit(n: number) {
    this.to_ = this.from_ + n - 1;
    return this;
  }
  maybeSingle() {
    this.wantOne = true;
    return this;
  }
  single() {
    this.wantOne = true;
    return this;
  }
  then(ok: (v: { data: any; error: any }) => any, ko?: (e: any) => any) {
    return Promise.resolve(this.run()).then(ok, ko);
  }

  private run(): { data: any; error: any } {
    const rows = this.db.table(this.table);
    const hit = (r: Row) => this.preds.every((p) => p(r));
    if (this.op === "insert") {
      for (const r of [].concat(this.payload)) rows.push({ id: this.db.nextId(this.table), ...(r as Row) });
      return { data: null, error: null };
    }
    if (this.op === "upsert") {
      for (const r of [].concat(this.payload) as Row[]) {
        const prev = rows.find((x) => this.conflict.every((c) => x[c] === r[c]));
        if (prev) Object.assign(prev, r);
        else rows.push({ id: this.db.nextId(this.table), ...r });
      }
      return { data: null, error: null };
    }
    if (this.op === "update") {
      const touched = rows.filter(hit);
      for (const r of touched) Object.assign(r, this.payload);
      return { data: this.returning ? touched.map((r) => ({ ...r })) : null, error: null };
    }
    if (this.op === "delete") {
      this.db.tables.set(this.table, rows.filter((r) => !hit(r)));
      return { data: null, error: null };
    }
    let out = rows.filter(hit).map((r) => ({ ...r }));
    out.sort((a, b) => {
      for (const { col, asc } of this.sorts) {
        const d = a[col] > b[col] ? 1 : a[col] < b[col] ? -1 : 0;
        if (d) return asc ? d : -d;
      }
      return 0;
    });
    out = out.slice(this.from_, this.to_ == null ? undefined : this.to_ + 1);
    if (this.wantOne) return { data: out[0] ?? null, error: out[0] ? null : { message: "no rows" } };
    return { data: out, error: null };
  }
}

class MemDb {
  tables = new Map<string, Row[]>();
  private seq = 0;
  table(name: string): Row[] {
    if (!this.tables.has(name)) this.tables.set(name, []);
    return this.tables.get(name)!;
  }
  nextId(table: string) {
    this.seq += 1;
    return `${table}-${this.seq}`;
  }
  from(name: string) {
    return new MemQuery(this, name);
  }
  async rpc() {
    return { data: null, error: null };
  }
}

const STORE = "store-1";
const PHONE = "51956228785";

function seed(): MemDb {
  const db = new MemDb();
  db.table("draft_orders").push({
    store_id: STORE,
    draft_order_gid: "gid://shopify/DraftOrder/94856",
    created_at: "2026-09-13T12:20:33+00:00",
    line_items: [{ ...ETIOPE, product_id: null }], // EasySell: sin product_id
  });
  db.table("leads").push({
    id: "lead-1",
    store_id: STORE,
    phone: PHONE,
    status: "nuevo",
    category: "open",
    needs_attention: true,
    has_order: false,
    order_id: null,
    next_followup_at: null,
    draft_order_gid: "gid://shopify/DraftOrder/94856",
  });
  db.table("orders").push({
    id: "order-1",
    store_id: STORE,
    name: "#KP137631",
    customer_phone: PHONE,
    created_at: "2026-09-29T10:10:56+00:00",
    cancelled_at: null,
    tags: ["CONFIRMADO", "easysell_cod_form"],
    line_items: [ETIOPE],
  });
  return db;
}

const lead = (db: MemDb) => db.table("leads").find((l) => l.id === "lead-1")!;

describe("closeCartLeadsWithOrders", () => {
  it("saca el carrito de la cola como «Ya tiene pedido» y lo deja en el historial", async () => {
    const db = seed();
    const n = await closeCartLeadsWithOrders(db as any, STORE, { phones: [PHONE] });
    expect(n).toBe(1);
    expect(lead(db)).toMatchObject({
      status: "ya_tiene_pedido",
      category: "won",
      needs_attention: false,
      has_order: true,
      order_id: "order-1",
    });
    expect(db.table("lead_calls")).toEqual([
      expect.objectContaining({
        lead_id: "lead-1",
        kind: "system",
        vendedora: null,
        new_status: "ya_tiene_pedido",
        note: expect.stringContaining("#KP137631"),
      }),
    ]);
  });

  it("cualquier estado de la cola: también un «volver a llamar» con seguimiento agendado", async () => {
    const db = seed();
    Object.assign(lead(db), { status: "volver_a_llamar", next_followup_at: "2026-09-30T15:00:00+00:00" });
    await closeCartLeadsWithOrders(db as any, STORE, { phones: [PHONE] });
    // Seguimientos lista por fecha sin mirar la categoría: la fecha se limpia.
    expect(lead(db)).toMatchObject({ status: "ya_tiene_pedido", next_followup_at: null });
  });

  it("es idempotente: una segunda pasada no vuelve a escribir", async () => {
    const db = seed();
    await closeCartLeadsWithOrders(db as any, STORE, { phones: [PHONE] });
    const n = await closeCartLeadsWithOrders(db as any, STORE, { phones: [PHONE] });
    expect(n).toBe(0);
    expect(db.table("lead_calls")).toHaveLength(1);
  });

  it("no toca un pedido de otro producto", async () => {
    const db = seed();
    db.table("orders")[0]!.line_items = [CAYENNE];
    expect(await closeCartLeadsWithOrders(db as any, STORE, { phones: [PHONE] })).toBe(0);
    expect(lead(db).status).toBe("nuevo");
  });

  it("no toca un pedido anulado", async () => {
    const db = seed();
    db.table("orders")[0]!.cancelled_at = "2026-09-29T12:00:00+00:00";
    expect(await closeCartLeadsWithOrders(db as any, STORE, { phones: [PHONE] })).toBe(0);
  });

  it("no toca un pedido anterior al carrito (recompra en curso)", async () => {
    const db = seed();
    db.table("orders")[0]!.created_at = "2026-09-01T14:02:56+00:00";
    expect(await closeCartLeadsWithOrders(db as any, STORE, { phones: [PHONE] })).toBe(0);
  });

  it("no reescribe un lead que ya salió de la cola (perdido o ganado)", async () => {
    const db = seed();
    Object.assign(lead(db), { status: "ya_compro_otro_lado", category: "lost" });
    expect(await closeCartLeadsWithOrders(db as any, STORE, { phones: [PHONE] })).toBe(0);
    expect(lead(db).status).toBe("ya_compro_otro_lado");
  });

  it("respeta una gestión de la asesora registrada DESPUÉS del pedido", async () => {
    const db = seed();
    Object.assign(lead(db), { status: "casi_cierra", category: "hot" });
    db.table("lead_calls").push({
      lead_id: "lead-1",
      store_id: STORE,
      kind: "call",
      new_status: "casi_cierra",
      occurred_at: "2026-09-29T11:00:00+00:00",
    });
    expect(await closeCartLeadsWithOrders(db as any, STORE, { phones: [PHONE] })).toBe(0);
    expect(lead(db).status).toBe("casi_cierra");
  });

  it("una gestión ANTERIOR al pedido no lo frena: la compra es el hecho nuevo", async () => {
    const db = seed();
    Object.assign(lead(db), { status: "no_responde" });
    db.table("lead_calls").push({
      lead_id: "lead-1",
      store_id: STORE,
      kind: "call",
      new_status: "no_responde",
      occurred_at: "2026-09-20T15:00:00+00:00",
    });
    expect(await closeCartLeadsWithOrders(db as any, STORE, { phones: [PHONE] })).toBe(1);
  });

  it("el barrido sin teléfonos mira solo los pedidos recientes", async () => {
    const db = seed();
    expect(
      await closeCartLeadsWithOrders(db as any, STORE, { sinceIso: "2026-09-30T00:00:00+00:00" }),
    ).toBe(0); // el pedido es del 29: fuera de la ventana
    expect(
      await closeCartLeadsWithOrders(db as any, STORE, { sinceIso: "2026-09-27T00:00:00+00:00" }),
    ).toBe(1);
  });
});

// --- El webhook de pedidos lo aplica al instante -----------------------------
const KEY = generateEncryptionKey();
const WEBHOOK_SECRET = "shpss_store_secret";

beforeAll(() => {
  process.env.ENCRYPTION_KEY = KEY;
});

function sign(body: string) {
  return createHmac("sha256", WEBHOOK_SECRET).update(body, "utf8").digest("base64");
}

function withStore(db: MemDb): MemDb {
  db.table("stores").push({
    id: STORE,
    org_id: "org-1",
    name: "Kenku Peru",
    shopify_domain: "kenku.myshopify.com",
    shopify_token_enc: null,
    shopify_webhook_secret_enc: encrypt(WEBHOOK_SECRET, KEY),
    currency: "PEN",
    timezone: "America/Lima",
    status: "active",
  });
  // El pedido todavía no está en la base: lo trae el webhook.
  db.tables.set("orders", []);
  return db;
}

function orderBody(tags: string) {
  return JSON.stringify({
    id: 7406190100775,
    name: "#KP137631",
    created_at: "2026-09-29T05:10:56-05:00",
    total_price: "89.00",
    currency: "PEN",
    financial_status: "pending",
    tags,
    phone: "+51 956 228 785",
    line_items: [{ title: ETIOPE.title, sku: ETIOPE.sku, product_id: 10134191243559, quantity: 1, price: "89.00" }],
  });
}

describe("processShopifyWebhook · pedido sin tag kapso", () => {
  it("saca de la cola el carrito del mismo teléfono con el mismo producto", async () => {
    const { processShopifyWebhook } = await import("@/lib/ingest");
    const db = withStore(seed());
    const body = orderBody("CONFIRMADO, easysell_cod_form");
    const res = await processShopifyWebhook(
      { storeId: STORE, topic: "orders/create", rawBody: body, hmacHeader: sign(body), webhookIdHeader: "wh_1" },
      db as any,
    );
    expect(res.status).toBe("ok");
    expect(lead(db)).toMatchObject({ status: "ya_tiene_pedido", category: "won", has_order: true });
  });

  it("un pedido anulado que llega por webhook no toca el carrito", async () => {
    const { processShopifyWebhook } = await import("@/lib/ingest");
    const db = withStore(seed());
    const body = JSON.stringify({ ...JSON.parse(orderBody("easysell_cod_form")), cancelled_at: "2026-09-29T06:00:00-05:00" });
    await processShopifyWebhook(
      { storeId: STORE, topic: "orders/create", rawBody: body, hmacHeader: sign(body), webhookIdHeader: "wh_2" },
      db as any,
    );
    expect(lead(db).status).toBe("nuevo");
  });
});
