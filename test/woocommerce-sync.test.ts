// La pasada `woo_orders` de la sincronización (MOM §37.11): la red de seguridad
// de los webhooks de WooCommerce.
//
//   GET /wp-json/wc/v3/orders?modified_after=<cursor>&dates_are_gmt=true
//       &orderby=modified&order=asc&per_page=100&page=N
//
// Lo que se fija: solo corre en una tienda con las credenciales de WooCommerce;
// la primera vez parte de ORDERS_SYNC_FROM y después del cursor (menos 2 minutos
// de solape); guarda en sync_state el `date_modified` más nuevo; pagina por
// fecha (no se salta pedidos si la lista se mueve); para con el reloj y el tope
// de páginas; un fallo queda en sync_state y en woo_last_error sin borrar el
// cursor ni tumbar las pasadas de Shopify; y el hosting que borra la cabecera
// Authorization. Sin red: `fetch` es falso.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeDb, type Row } from "./woocommerce-fake-db";

const h = vi.hoisted(() => {
  process.env.ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");
  return {};
});
void h;

const spies = vi.hoisted(() => ({
  recompute: vi.fn(async (_admin: unknown, ids: readonly string[]) => ({ requested: ids.length, written: ids.length, error: null })),
  linkOrdersToLeads: vi.fn(async () => {}),
}));

vi.mock("@/lib/order-master", async (orig) => ({
  ...(await orig<typeof import("@/lib/order-master")>()),
  recomputeOrderMasterSafe: spies.recompute,
  reconcileOrderMaster: vi.fn(async () => ({ written: 0, failed: 0 })),
}));

// Lo de leads que corre en `runStoreSync` sin depender de WooCommerce: sin
// efectos, para que la prueba mire solo la pasada nueva.
vi.mock("@/lib/leads-ingest", async (orig) => ({
  ...(await orig<typeof import("@/lib/leads-ingest")>()),
  linkOrdersToLeads: spies.linkOrdersToLeads,
  closeCartLeadsWithOrders: vi.fn(async () => 0),
  flagOverdueFollowups: vi.fn(async () => 0),
  flagCartAttentionWaves: vi.fn(async () => 0),
  expireColdHandoffs: vi.fn(async () => 0),
  archiveStaleLeads: vi.fn(async () => 0),
}));

import { encrypt } from "@/lib/crypto";
import { runStoreSync, syncWooOrders } from "@/lib/ingest";
import { WOO_SYNC_OVERLAP_MS, WOO_SYNC_SOURCE, nextWooPage, wooSyncStart } from "@/lib/woocommerce-intake";

const STORE_ID = "11111111-1111-4111-8111-111111111111";
const CK = "ck_0123456789abcdef0123456789abcdef01234567";
const CS = "cs_0123456789abcdef0123456789abcdef01234567";

function storeRow(over: Row = {}): Row {
  return {
    id: STORE_ID,
    org_id: "org-1",
    name: "Kenku",
    shopify_domain: "kenku.myshopify.com",
    shopify_token_enc: null,
    status: "active",
    timezone: "America/Lima",
    platform: "shopify",
    woo_site_url: "https://kenku.pe",
    woo_site_key: "kp",
    woo_consumer_key_enc: encrypt(CK),
    woo_consumer_secret_enc: encrypt(CS),
    woo_webhook_secret_enc: encrypt("3f9a1c0d5e7b2a4c6d8e0f1a3b5c7d9e"),
    woo_last_error: null,
    ...over,
  };
}

function wooOrder(id: number, modified: string, over: Row = {}): Row {
  return {
    id,
    number: `KP${200000 + id}`,
    status: "processing",
    currency: "PEN",
    date_created_gmt: modified,
    date_modified_gmt: modified,
    total: "99.00",
    billing: { first_name: "Ana", address_1: "Jr. Uno 1", city: "Lince", state: "LMA", country: "PE", phone: `98765${String(id).padStart(4, "0")}` },
    shipping: { first_name: "Ana", address_1: "Jr. Uno 1", city: "Lince", state: "LMA", country: "PE" },
    payment_method: "cod",
    payment_method_title: "Pago contra entrega",
    meta_data: [],
    line_items: [{ name: "Polo", quantity: 1, subtotal: "99.00", sku: "POLO-M", product_id: 1, variation_id: 0 }],
    refunds: [],
    ...over,
  };
}

interface Call {
  url: URL;
  auth: string | null;
}

/**
 * Un WooCommerce falso: filtra por `modified_after` (estricto, como
 * WP_Date_Query), ordena por fecha y pagina de a `per_page`, con las cabeceras
 * X-WP-Total y X-WP-TotalPages.
 */
function fakeWoo(orders: Row[], opts: { status?: number; body?: unknown; stripAuth?: boolean } = {}) {
  const calls: Call[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    calls.push({ url, auth: headers.get("authorization") });
    if (opts.status) {
      return new Response(JSON.stringify(opts.body ?? { code: "x", message: "falló" }), { status: opts.status });
    }
    if (opts.stripAuth && !url.searchParams.get("consumer_key")) {
      return new Response(JSON.stringify({ code: "woocommerce_rest_cannot_view", message: "Lo siento, no puedes listar los recursos." }), {
        status: 401,
      });
    }
    const after = url.searchParams.get("modified_after");
    const perPage = Number(url.searchParams.get("per_page") ?? 10);
    const page = Number(url.searchParams.get("page") ?? 1);
    const afterMs = after ? Date.parse(`${after}Z`) : -Infinity;
    const list = orders
      .filter((o) => Date.parse(`${o.date_modified_gmt}Z`) > afterMs)
      .sort((a, b) => Date.parse(`${a.date_modified_gmt}Z`) - Date.parse(`${b.date_modified_gmt}Z`) || a.id - b.id);
    const items = list.slice((page - 1) * perPage, page * perPage);
    return new Response(JSON.stringify(items), {
      status: 200,
      headers: { "X-WP-Total": String(list.length), "X-WP-TotalPages": String(Math.max(1, Math.ceil(list.length / perPage))) },
    });
  });
  return { calls, fetchImpl: fetchImpl as unknown as typeof fetch };
}

let db: FakeDb;
beforeEach(() => {
  db = new FakeDb({ stores: [storeRow()] });
  spies.recompute.mockClear();
  spies.linkOrdersToLeads.mockClear();
});

function syncRow() {
  return db.rows("sync_state").find((r) => r.source === WOO_SYNC_SOURCE);
}

describe("solo en tiendas con WooCommerce", () => {
  it("una tienda sin credenciales de WooCommerce no hace ni una llamada ni escribe sync_state", async () => {
    db = new FakeDb({
      stores: [storeRow({ woo_site_url: null, woo_site_key: null, woo_consumer_key_enc: null, woo_consumer_secret_enc: null })],
    });
    const woo = fakeWoo([]);
    const r = await syncWooOrders(db.client(), STORE_ID, { fetchImpl: woo.fetchImpl });
    expect(r).toMatchObject({ ran: false, orders: 0, error: null });
    expect(woo.calls).toEqual([]);
    expect(db.rows("sync_state")).toEqual([]);
  });

  it("con solo el secreto de webhooks (sin las claves de la API) tampoco", async () => {
    db = new FakeDb({ stores: [storeRow({ woo_consumer_key_enc: null, woo_consumer_secret_enc: null })] });
    const woo = fakeWoo([]);
    const r = await syncWooOrders(db.client(), STORE_ID, { fetchImpl: woo.fetchImpl });
    expect(r.ran).toBe(false);
    expect(woo.calls).toEqual([]);
  });

  it("claves guardadas que no se pueden descifrar: error visible, sin llamadas", async () => {
    db = new FakeDb({ stores: [storeRow({ woo_consumer_key_enc: "v1:basura:basura:basura" })] });
    const woo = fakeWoo([]);
    const r = await syncWooOrders(db.client(), STORE_ID, { fetchImpl: woo.fetchImpl });
    expect(r.ran).toBe(true);
    expect(r.error).toContain("no se pueden descifrar");
    expect(woo.calls).toEqual([]);
    expect(syncRow()).toMatchObject({ status: "error" });
  });
});

describe("el cursor", () => {
  it("la primera vez parte de ORDERS_SYNC_FROM, con los parámetros del plan", async () => {
    const woo = fakeWoo([wooOrder(1, "2026-10-27T15:00:00"), wooOrder(2, "2026-10-27T16:30:05")]);
    const r = await syncWooOrders(db.client(), STORE_ID, { fetchImpl: woo.fetchImpl, floor: "2026-06-01" });
    expect(r).toMatchObject({ ran: true, orders: 2, pages: 1, done: true, error: null, cursor: "2026-10-27T16:30:05.000Z" });

    const q = woo.calls[0]!.url;
    expect(q.pathname).toBe("/wp-json/wc/v3/orders");
    expect(Object.fromEntries(q.searchParams)).toMatchObject({
      modified_after: "2026-06-01T00:00:00",
      dates_are_gmt: "true",
      orderby: "modified",
      order: "asc",
      per_page: "100",
      page: "1",
      status: "any",
    });
    // Las claves van por cabecera, nunca en la URL.
    expect(woo.calls[0]!.auth).toMatch(/^Basic /);
    expect(q.search).not.toContain("consumer_secret");

    expect(db.rows("orders").map((o) => o.shopify_order_id).sort()).toEqual(["wc-kp-1", "wc-kp-2"]);
    expect(db.rows("orders").every((o) => o.platform === "woocommerce")).toBe(true);
    expect(syncRow()).toMatchObject({ cursor: "2026-10-27T16:30:05.000Z", status: "ok", error: null });
    expect(spies.recompute).toHaveBeenCalledTimes(1);
  });

  it("después sigue desde el cursor menos el solape de 2 minutos", async () => {
    db.rows("sync_state").push({ store_id: STORE_ID, source: WOO_SYNC_SOURCE, cursor: "2026-10-27T16:30:05.000Z", status: "ok" });
    const woo = fakeWoo([wooOrder(1, "2026-10-27T15:00:00"), wooOrder(2, "2026-10-27T16:29:00"), wooOrder(3, "2026-10-27T16:40:00")]);
    const r = await syncWooOrders(db.client(), STORE_ID, { fetchImpl: woo.fetchImpl });
    expect(woo.calls[0]!.url.searchParams.get("modified_after")).toBe("2026-10-27T16:28:05");
    // El 2 está dentro del solape (se relee, inocuo); el 1 no.
    expect(db.rows("orders").map((o) => o.shopify_order_id).sort()).toEqual(["wc-kp-2", "wc-kp-3"]);
    expect(r.cursor).toBe("2026-10-27T16:40:00.000Z");
    expect(syncRow()!.cursor).toBe("2026-10-27T16:40:00.000Z");
  });

  it("sin pedidos nuevos no mueve el cursor ni lo deja en blanco", async () => {
    db.rows("sync_state").push({ store_id: STORE_ID, source: WOO_SYNC_SOURCE, cursor: "2026-10-27T16:30:05.000Z", status: "ok" });
    const woo = fakeWoo([]);
    await syncWooOrders(db.client(), STORE_ID, { fetchImpl: woo.fetchImpl });
    expect(syncRow()).toMatchObject({ cursor: "2026-10-27T16:30:05.000Z", status: "ok" });
  });

  it("wooSyncStart y nextWooPage, puros", () => {
    expect(wooSyncStart(null, "2026-06-01")).toBe("2026-06-01T00:00:00.000Z");
    expect(wooSyncStart("2026-10-27T16:30:05.000Z", "2026-06-01")).toBe(
      new Date(Date.parse("2026-10-27T16:30:05.000Z") - WOO_SYNC_OVERLAP_MS).toISOString(),
    );
    // Avanza por fecha: un segundo antes del último leído, página 1.
    expect(nextWooPage({ modifiedAfter: "2026-10-27T10:00:00.000Z", page: 1 }, "2026-10-27T11:00:00.000Z")).toEqual({
      modifiedAfter: "2026-10-27T10:59:59.000Z",
      page: 1,
    });
    // Una página entera del mismo segundo: no hay avance por fecha → página siguiente.
    expect(nextWooPage({ modifiedAfter: "2026-10-27T10:59:59.000Z", page: 1 }, "2026-10-27T11:00:00.000Z")).toEqual({
      modifiedAfter: "2026-10-27T10:59:59.000Z",
      page: 2,
    });
  });
});

describe("paginación, reloj y tope", () => {
  const many = Array.from({ length: 7 }, (_, i) => wooOrder(i + 1, `2026-10-27T10:0${i}:00`));

  it("recorre todo por fecha y no repite pedidos en orders", async () => {
    const woo = fakeWoo(many);
    const r = await syncWooOrders(db.client(), STORE_ID, { fetchImpl: woo.fetchImpl, perPage: 3, floor: "2026-10-01" });
    expect(r.done).toBe(true);
    expect(db.rows("orders")).toHaveLength(7);
    expect(r.cursor).toBe("2026-10-27T10:06:00.000Z");
    // La segunda página pide desde un segundo antes del último pedido leído.
    expect(woo.calls[1]!.url.searchParams.get("modified_after")).toBe("2026-10-27T10:01:59");
    expect(woo.calls[1]!.url.searchParams.get("page")).toBe("1");
  });

  it("un pedido que se modifica mientras se pagina no hace saltar a otro", async () => {
    const list = [...many];
    const woo = fakeWoo(list);
    const inner = woo.fetchImpl;
    let n = 0;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const res = await (inner as any)(input, init);
      // Tras la primera página, el pedido 1 cambia y se va al final de la lista.
      if (n++ === 0) list[0] = { ...list[0]!, date_modified_gmt: "2026-10-27T10:30:00" };
      return res;
    }) as typeof fetch;
    await syncWooOrders(db.client(), STORE_ID, { fetchImpl, perPage: 3, floor: "2026-10-01" });
    expect(db.rows("orders").map((o) => o.shopify_order_id).sort()).toEqual(
      ["wc-kp-1", "wc-kp-2", "wc-kp-3", "wc-kp-4", "wc-kp-5", "wc-kp-6", "wc-kp-7"].sort(),
    );
  });

  it("para con el tope de páginas y la próxima pasada sigue desde donde quedó", async () => {
    const woo = fakeWoo(many);
    const first = await syncWooOrders(db.client(), STORE_ID, { fetchImpl: woo.fetchImpl, perPage: 3, maxPages: 1, floor: "2026-10-01" });
    expect(first).toMatchObject({ done: false, orders: 3, cursor: "2026-10-27T10:02:00.000Z" });
    expect(syncRow()!.cursor).toBe("2026-10-27T10:02:00.000Z");
    const second = await syncWooOrders(db.client(), STORE_ID, { fetchImpl: woo.fetchImpl, perPage: 3, floor: "2026-10-01" });
    expect(second.done).toBe(true);
    expect(db.rows("orders")).toHaveLength(7);
  });

  it("para con el reloj (nunca antes de la primera página)", async () => {
    const woo = fakeWoo(many);
    let t = 0;
    const r = await syncWooOrders(db.client(), STORE_ID, {
      fetchImpl: woo.fetchImpl,
      perPage: 3,
      budgetMs: 1000,
      now: () => (t += 1000),
      floor: "2026-10-01",
    });
    expect(r.pages).toBe(1);
    expect(r.done).toBe(false);
  });

  it("los pendientes de pago no entran; los anulados conservan su fecha de anulación", async () => {
    db.rows("orders").push({ id: "o-9", store_id: STORE_ID, shopify_order_id: "wc-kp-9", cancelled_at: "2026-10-20T00:00:00.000Z" });
    const woo = fakeWoo([
      wooOrder(8, "2026-10-27T10:00:00", { status: "pending" }),
      wooOrder(9, "2026-10-27T10:01:00", { status: "cancelled" }),
    ]);
    const r = await syncWooOrders(db.client(), STORE_ID, { fetchImpl: woo.fetchImpl, floor: "2026-10-01" });
    expect(r).toMatchObject({ orders: 1, skipped: 1 });
    expect(db.rows("orders").find((o) => o.shopify_order_id === "wc-kp-9")).toMatchObject({
      cancelled_at: "2026-10-20T00:00:00.000Z",
      financial_status: "voided",
    });
    expect(db.rows("orders").find((o) => o.shopify_order_id === "wc-kp-8")).toBeUndefined();
  });

  it("un anulado que Kapta no tiene y que nunca se pagó (checkout abandonado) no entra", async () => {
    const woo = fakeWoo([
      wooOrder(20, "2026-10-27T10:00:00", { status: "cancelled", payment_method: "flow" }),
      wooOrder(21, "2026-10-27T10:01:00", { status: "cancelled", date_paid_gmt: "2026-10-27T09:00:00" }),
    ]);
    const r = await syncWooOrders(db.client(), STORE_ID, { fetchImpl: woo.fetchImpl, floor: "2026-10-01" });
    expect(r).toMatchObject({ orders: 1, skipped: 1 });
    expect(db.rows("orders").map((o) => o.shopify_order_id)).toEqual(["wc-kp-21"]);
  });

  it("no pisa lo que un webhook ya dejó más nuevo entre la lectura y la escritura", async () => {
    db.rows("orders").push({
      id: "o-3",
      store_id: STORE_ID,
      shopify_order_id: "wc-kp-3",
      cancelled_at: "2026-10-27T10:05:00Z",
      financial_status: "voided",
      updated_at: "2026-10-27T10:05:00Z",
    });
    const woo = fakeWoo([wooOrder(3, "2026-10-27T10:00:00"), wooOrder(4, "2026-10-27T10:01:00")]);
    const r = await syncWooOrders(db.client(), STORE_ID, { fetchImpl: woo.fetchImpl, floor: "2026-10-01" });
    expect(r).toMatchObject({ orders: 1, skipped: 1 });
    expect(db.rows("orders").find((o) => o.shopify_order_id === "wc-kp-3")).toMatchObject({
      cancelled_at: "2026-10-27T10:05:00Z",
      financial_status: "voided",
    });
  });

  it("los pedidos del bot ganan su lead y dan los días para los rollups", async () => {
    const woo = fakeWoo([wooOrder(5, "2026-10-27T15:00:00", { meta_data: [{ key: "kapso_conversation_id", value: "c1" }] })]);
    const r = await syncWooOrders(db.client(), STORE_ID, { fetchImpl: woo.fetchImpl, floor: "2026-10-01" });
    expect(spies.linkOrdersToLeads).toHaveBeenCalledTimes(1);
    expect(r.kapsoDates).toEqual(["2026-10-27"]);
  });
});

describe("los fallos", () => {
  it("WooCommerce caído: error en sync_state y woo_last_error, sin lanzar y sin borrar el cursor", async () => {
    db.rows("sync_state").push({ store_id: STORE_ID, source: WOO_SYNC_SOURCE, cursor: "2026-10-27T16:30:05.000Z", status: "ok" });
    const woo = fakeWoo([], { status: 500 });
    const r = await syncWooOrders(db.client(), STORE_ID, { fetchImpl: woo.fetchImpl });
    expect(r.error).toMatch(/HTTP 500/);
    expect(syncRow()).toMatchObject({ cursor: "2026-10-27T16:30:05.000Z", status: "error" });
    expect(db.rows("stores")[0]!.woo_last_error).toMatch(/^Sincronización: .*HTTP 500/);
    // Ni las claves ni la dirección de la llamada en el error.
    expect(r.error).not.toContain(CK);
    expect(r.error).not.toContain("wp-json");
  });

  it("lo que avanzó antes del fallo se guarda", async () => {
    const list = Array.from({ length: 4 }, (_, i) => wooOrder(i + 1, `2026-10-27T10:0${i}:00`));
    const woo = fakeWoo(list);
    let n = 0;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (n++ === 1) return new Response("{}", { status: 503 });
      return (woo.fetchImpl as any)(input, init);
    }) as typeof fetch;
    const r = await syncWooOrders(db.client(), STORE_ID, { fetchImpl, perPage: 2, floor: "2026-10-01" });
    expect(r.error).toBeTruthy();
    expect(syncRow()).toMatchObject({ cursor: "2026-10-27T10:01:00.000Z", status: "error" });
  });

  it("al volver a salir bien limpia el error que dejó la pasada (no el de un webhook)", async () => {
    db = new FakeDb({ stores: [storeRow({ woo_last_error: "Sincronización: WooCommerce falló (HTTP 500)." })] });
    await syncWooOrders(db.client(), STORE_ID, { fetchImpl: fakeWoo([]).fetchImpl });
    expect(db.rows("stores")[0]!.woo_last_error).toBeNull();

    db = new FakeDb({ stores: [storeRow({ woo_last_error: "Webhook: llegó un aviso firmado desde otro sitio" })] });
    await syncWooOrders(db.client(), STORE_ID, { fetchImpl: fakeWoo([]).fetchImpl });
    expect(db.rows("stores")[0]!.woo_last_error).toContain("Webhook:");
  });

  it("el hosting que borra la cabecera Authorization: reintenta con las claves en la query (https)", async () => {
    const woo = fakeWoo([wooOrder(1, "2026-10-27T15:00:00")], { stripAuth: true });
    const r = await syncWooOrders(db.client(), STORE_ID, { fetchImpl: woo.fetchImpl, floor: "2026-10-01" });
    expect(r.error).toBeNull();
    expect(r.orders).toBe(1);
    expect(woo.calls).toHaveLength(2);
    expect(woo.calls[1]!.url.protocol).toBe("https:");
    expect(woo.calls[1]!.url.searchParams.get("consumer_key")).toBe(CK);
  });
});

describe("dentro de runStoreSync", () => {
  it("corre sin token de Shopify, cuenta sus pedidos y no rompe el resto", async () => {
    const realFetch = globalThis.fetch;
    const woo = fakeWoo([wooOrder(1, "2026-10-27T15:00:00")]);
    globalThis.fetch = woo.fetchImpl;
    try {
      const report = await runStoreSync(STORE_ID, db.client(), { skipMasterReconcile: true });
      expect(report.wooOrders).toBe(1);
      expect(report.errors.filter((e) => e.startsWith("woo_orders"))).toEqual([]);
      expect(db.rows("orders")[0]).toMatchObject({ shopify_order_id: "wc-kp-1", platform: "woocommerce" });
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("si WooCommerce falla, el error va al reporte y la sincronización sigue", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = fakeWoo([], { status: 500 }).fetchImpl;
    try {
      const report = await runStoreSync(STORE_ID, db.client(), { skipMasterReconcile: true });
      expect(report.errors.some((e) => e.startsWith("woo_orders: ") && e.includes("HTTP 500"))).toBe(true);
      expect(report.wooOrders).toBe(0);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("una tienda sin WooCommerce no suma nada al reporte", async () => {
    db = new FakeDb({
      stores: [storeRow({ woo_site_url: null, woo_site_key: null, woo_consumer_key_enc: null, woo_consumer_secret_enc: null })],
    });
    const realFetch = globalThis.fetch;
    const woo = fakeWoo([]);
    globalThis.fetch = woo.fetchImpl;
    try {
      const report = await runStoreSync(STORE_ID, db.client(), { skipMasterReconcile: true });
      expect(report.wooOrders).toBe(0);
      expect(report.errors.filter((e) => e.startsWith("woo_orders"))).toEqual([]);
      expect(woo.calls).toEqual([]);
      expect(db.rows("sync_state").filter((r) => r.source === WOO_SYNC_SOURCE)).toEqual([]);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
