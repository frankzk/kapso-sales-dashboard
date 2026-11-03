// La anulación y la reactivación de un pedido de WooCommerce en la Actividad de
// la ficha (MOM §38.3 y §25). Prueba del owner del 24-10-2026: #AUR900004 se
// anuló en wp-admin, Kapta lo dio por anulado y la Actividad no decía nada.
//
// Lo que se fija, con una base falsa (que aplica el índice único parcial de
// `order_events`) y un WooCommerce falso (pedidos y notas):
//   - La primera anulación deja UN hecho «Anulado en WooCommerce», con la hora
//     del cambio (`date_modified_gmt`) y quién lo hizo («por <usuario de
//     WordPress>»), sin tocar `order_events.actor`.
//   - El webhook repetido, un cambio posterior del anulado y la pasada no
//     repiten el hecho; el webhook y la pasada a la vez, tampoco.
//   - Una nota de WooCommerce solo → «WooCommerce (automático)».
//   - El texto de la nota no se guarda (puede llevar datos de la clienta y
//     `order_events` no se borra): solo cuál fue y su hora.
//   - Un comentario del equipo que nombra la anulación no dice quién anuló.
//   - Si las notas fallan, el hecho queda sin autor y el pedido entra igual.
//   - La reactivación → «Reactivado en WooCommerce»; otra anulación, otro hecho.
//     El reembolso de un anulado (`refunded`) no es una reactivación.
//   - La pasada que pisó la anulación y la vuelve a ver no la repite.
//   - La papelera sin respuesta de WooCommerce → «Enviado a la papelera».
//   - Shopify no deja hechos nuevos.
//   - La ficha lo enseña: título, detalle y origen «WooCommerce».
// Sin red ni base real.

import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeDb, type Row } from "./woocommerce-fake-db";

const h = vi.hoisted(() => {
  process.env.ENCRYPTION_KEY = Buffer.alloc(32, 5).toString("base64");
  return { db: null as unknown as import("./woocommerce-fake-db").FakeDb, eventsAtRecompute: [] as number[] };
});

vi.mock("@/lib/db", () => ({
  createAdminSupabase: () => h.db.client(),
  createServerSupabase: async () => {
    throw new Error("no se usa en estas pruebas");
  },
}));

const spies = vi.hoisted(() => ({
  recompute: vi.fn(async (_admin: unknown, ids: readonly string[]) => ({ requested: ids.length, written: ids.length, error: null })),
}));

vi.mock("@/lib/order-master", async (orig) => ({
  ...(await orig<typeof import("@/lib/order-master")>()),
  recomputeOrderMasterSafe: spies.recompute,
  reconcileOrderMaster: vi.fn(async () => ({ written: 0, failed: 0 })),
}));

vi.mock("@/lib/leads-ingest", async (orig) => ({
  ...(await orig<typeof import("@/lib/leads-ingest")>()),
  linkOrderToLead: vi.fn(async () => {}),
  linkOrdersToLeads: vi.fn(async () => {}),
  closeCartLeadsWithOrders: vi.fn(async () => 0),
  lastDispositionAtByPhone: vi.fn(async () => new Map()),
}));

import { encrypt } from "@/lib/crypto";
import { processShopifyWebhook, processWooWebhook, syncWooOrders, type WooWebhookParams } from "@/lib/ingest";
import { orderEventsToTimeline } from "@/lib/orders-master-access";
import { timelineFact, timelineOriginLabel } from "@/lib/order-timeline-fact";
import type { OrderEventRow } from "@/lib/types";
import {
  WOO_EVENT_KIND,
  WOO_NOTES_MAX_LOOKUPS,
  WOO_NOTE_WINDOW_AFTER_MS,
  WOO_NOTE_WINDOW_BEFORE_MS,
  latestWooTransitionKinds,
  pickWooStatusNote,
  recordWooStatusTransitions,
  wooNoteActor,
  wooNoteTransition,
  wooStatusTransition,
  wooTransitionDetail,
  wooTransitionOperationId,
  type WooTransitionItem,
} from "@/lib/woocommerce-activity";
import { WOO_NOTES_TIMEOUT_MS, type WooOrderNote } from "@/lib/woocommerce";

const STORE_ID = "33333333-3333-4333-8333-333333333333";
const SECRET = "7c1e0d5a9b3f2e4d6c8a0b1e3f5d7c9a1b2c3d4e5f60718293a4b5c6d7e8f901";
const SITE = "https://aurela.pe";
const SHOPIFY_SECRET = "shpss_aurela_secret";

function storeRow(over: Row = {}): Row {
  return {
    id: STORE_ID,
    org_id: "org-1",
    name: "Aurela",
    shopify_domain: "aurela.myshopify.com",
    shopify_token_enc: null,
    shopify_webhook_secret_enc: encrypt(SHOPIFY_SECRET),
    currency: "PEN",
    status: "active",
    timezone: "America/Lima",
    platform: "woocommerce",
    woo_site_url: SITE,
    woo_site_key: "aur",
    woo_consumer_key_enc: encrypt("ck_0123456789abcdef0123456789abcdef01234567"),
    woo_consumer_secret_enc: encrypt("cs_0123456789abcdef0123456789abcdef01234567"),
    woo_webhook_secret_enc: encrypt(SECRET),
    woo_last_error: null,
    woo_intake_from: "2026-10-01T00:00:00+00:00",
    ...over,
  };
}

/** #AUR900004: contraentrega del formulario, «Por confirmar» (COD Core). */
function wooOrder(over: Row = {}): Row {
  return {
    id: 4,
    number: "AUR900004",
    status: "cod-pending",
    currency: "PEN",
    prices_include_tax: true,
    date_created_gmt: "2026-10-24T14:02:10",
    date_modified_gmt: "2026-10-24T14:02:12",
    date_paid_gmt: "2026-10-24T14:02:12",
    total: "119.00",
    billing: { first_name: "Rosa", last_name: "Díaz", address_1: "Av. Arequipa 123", city: "Lince", state: "LMA", country: "PE", phone: "987 111 222" },
    shipping: { first_name: "Rosa", last_name: "Díaz", address_1: "Av. Arequipa 123", city: "Lince", state: "LMA", country: "PE" },
    payment_method: "cod",
    payment_method_title: "Pago contra entrega",
    customer_note: "",
    meta_data: [{ id: 1, key: "kapta_channel", value: "web_formulario" }],
    line_items: [{ id: 1, name: "Sérum", product_id: 10, variation_id: 0, quantity: 1, subtotal: "119.00", subtotal_tax: "0.00", total: "119.00", sku: "SER-1" }],
    shipping_lines: [],
    fee_lines: [],
    coupon_lines: [],
    refunds: [],
    ...over,
  };
}

const CANCEL_AT = "2026-10-24T15:20:31";
const cancelled = (over: Row = {}) => wooOrder({ status: "cancelled", date_modified_gmt: CANCEL_AT, ...over });

/** La nota que escribe WooCommerce (en español) cuando una persona anula en wp-admin. */
function note(over: Partial<WooOrderNote> = {}): WooOrderNote {
  return {
    id: 90,
    author: "María Torres",
    date_created: "2026-10-24T10:20:31",
    date_created_gmt: CANCEL_AT,
    note: "Estado del pedido cambiado de Por confirmar a Cancelado.",
    customer_note: false,
    added_by_user: true,
    ...over,
  };
}

const NOTES: WooOrderNote[] = [
  // Más nueva, pero para la clienta: no cuenta.
  note({ id: 92, customer_note: true, note: "Tu pedido fue cancelado.", date_created_gmt: "2026-10-24T15:21:00" }),
  note(),
  note({ id: 12, author: "system", added_by_user: false, note: "Pedido creado por COD Core.", date_created_gmt: "2026-10-24T14:02:12" }),
];

function sign(body: string, secret = SECRET): string {
  return createHmac("sha256", secret).update(body, "utf8").digest("base64");
}

function params(body: string, over: Partial<WooWebhookParams> = {}): WooWebhookParams {
  return {
    storeId: STORE_ID,
    rawBody: body,
    topic: "order.updated",
    signature: sign(body),
    deliveryId: "d1",
    source: `${SITE}/`,
    ...over,
  };
}

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { status: 200, ...init, headers: { "content-type": "application/json", ...(init.headers ?? {}) } });

/**
 * Un WooCommerce falso: la lista de pedidos de la pasada (por `modified_after`),
 * un pedido por id y sus notas. `notes` puede fallar (`notesStatus`), lanzar
 * (`notesThrow`, p. ej. «TimeoutError») o devolver algo que no es una lista.
 */
function wooSite(opts: {
  orders?: Row[];
  notes?: unknown;
  notesStatus?: number;
  notesThrow?: string;
  orderStatus?: number;
} = {}) {
  const calls: URL[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    calls.push(url);
    const path = url.pathname.replace(/^\/wp-json\/wc\/v3/, "");
    if (/^\/orders\/\d+\/notes$/.test(path)) {
      if (opts.notesThrow) throw Object.assign(new Error("se cortó"), { name: opts.notesThrow });
      if (opts.notesStatus) return json({ code: "internal_server_error", message: "falló" }, { status: opts.notesStatus });
      return json(opts.notes ?? NOTES);
    }
    const one = /^\/orders\/(\d+)$/.exec(path);
    if (one) {
      if (opts.orderStatus) return json({ code: "woocommerce_rest_shop_order_invalid_id" }, { status: opts.orderStatus });
      const found = (opts.orders ?? []).find((o) => String(o.id) === one[1]);
      return found ? json(found) : json({ code: "woocommerce_rest_shop_order_invalid_id" }, { status: 404 });
    }
    if (path === "/orders") {
      const after = url.searchParams.get("modified_after");
      const afterMs = after ? Date.parse(`${after}Z`) : -Infinity;
      const list = (opts.orders ?? []).filter((o) => Date.parse(`${o.date_modified_gmt}Z`) > afterMs);
      return json(list, { headers: { "X-WP-Total": String(list.length), "X-WP-TotalPages": "1" } });
    }
    return json({ code: "rest_no_route" }, { status: 404 });
  });
  return {
    calls,
    fetchImpl: fetchImpl as unknown as typeof fetch,
    notesCalls: () => calls.filter((u) => u.pathname.endsWith("/notes")),
  };
}

const events = () => h.db.rows("order_events");
const order = () => h.db.rows("orders").find((o) => o.shopify_order_id === "wc-aur-4");

/** El pedido ya está vivo en Kapta (entró por el webhook de alta). */
async function seedLive() {
  const body = JSON.stringify(wooOrder());
  const r = await processWooWebhook(params(body, { topic: "order.created", deliveryId: "alta" }), h.db.client(), {
    fetchImpl: wooSite().fetchImpl,
  });
  expect(r.status).toBe("ok");
  expect(order()).toMatchObject({ cancelled_at: null });
}

beforeEach(() => {
  h.db = new FakeDb({ stores: [storeRow()] });
  // Sin red: todo pasa por el WooCommerce falso.
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new TypeError("sin red en las pruebas");
    }),
  );
  h.eventsAtRecompute = [];
  spies.recompute.mockClear();
  spies.recompute.mockImplementation(async (_admin: unknown, ids: readonly string[]) => {
    h.eventsAtRecompute.push(h.db.rows("order_events").length);
    return { requested: ids.length, written: ids.length, error: null };
  });
});

describe("la anulación en WooCommerce deja un hecho en la Actividad", () => {
  it("la primera anulación (webhook): «Anulado en WooCommerce», a la hora del cambio y por quién", async () => {
    await seedLive();
    expect(events()).toEqual([]);
    const site = wooSite();
    const r = await processWooWebhook(params(JSON.stringify(cancelled())), h.db.client(), { fetchImpl: site.fetchImpl });
    expect(r.status).toBe("ok");
    expect(order()).toMatchObject({ cancelled_at: `${CANCEL_AT}Z`, financial_status: "voided" });

    expect(events()).toHaveLength(1);
    const ev = events()[0]!;
    expect(ev).toMatchObject({
      store_id: STORE_ID,
      order_id: order()!.id,
      kind: "cancelled_woocommerce",
      source: "woocommerce",
      occurred_at: "2026-10-24T15:20:31.000Z",
      // Quien anuló no es un usuario de Kapta: va en la nota, nunca en `actor`.
      actor: null,
      note: "por María Torres",
      payload: {
        woo_order_id: "4",
        woo_status: "cancelled",
        woo_by: "user",
        woo_author: "María Torres",
        woo_note_id: 90,
        woo_note_at: "2026-10-24T15:20:31Z",
      },
    });
    // Qué nota fue, no lo que dice (revisión del 24-10-2026).
    expect(ev.payload).not.toHaveProperty("woo_note");
    expect(ev.operation_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(ev.new_status).toBeUndefined();

    // Una sola lectura de notas, solo las internas, del pedido de WooCommerce.
    expect(site.notesCalls()).toHaveLength(1);
    expect(site.notesCalls()[0]!.pathname).toBe("/wp-json/wc/v3/orders/4/notes");
    expect(site.notesCalls()[0]!.searchParams.get("type")).toBe("internal");
    // La fila del Master se recalcula con el hecho ya escrito.
    expect(h.eventsAtRecompute.at(-1)).toBe(1);
  });

  it("el webhook repetido, un cambio posterior del anulado y la pasada: sigue habiendo un solo hecho", async () => {
    await seedLive();
    const site = wooSite({ orders: [cancelled()] });
    const body = JSON.stringify(cancelled());
    await processWooWebhook(params(body), h.db.client(), { fetchImpl: site.fetchImpl });
    expect((await processWooWebhook(params(body, { deliveryId: "d2" }), h.db.client(), { fetchImpl: site.fetchImpl })).status).toBe(
      "duplicate",
    );
    // Alguien edita el pedido ya anulado (otra fecha de modificación): no es otra anulación.
    const later = JSON.stringify(cancelled({ date_modified_gmt: "2026-10-24T18:00:00", customer_note: "llamar antes" }));
    expect((await processWooWebhook(params(later, { deliveryId: "d3" }), h.db.client(), { fetchImpl: site.fetchImpl })).status).toBe("ok");
    expect(order()!.cancelled_at).toBe(`${CANCEL_AT}Z`);
    // La pasada de 5 minutos ve el mismo pedido anulado.
    const sync = await syncWooOrders(h.db.client(), STORE_ID, { fetchImpl: site.fetchImpl, floor: "2026-10-01" });
    expect(sync.error).toBeNull();
    expect(events()).toHaveLength(1);
    expect(site.notesCalls()).toHaveLength(1);
  });

  it("la pasada que ve la anulación primero la registra, y el webhook que llega después no la repite", async () => {
    await seedLive();
    const site = wooSite({ orders: [cancelled()] });
    const sync = await syncWooOrders(h.db.client(), STORE_ID, { fetchImpl: site.fetchImpl, floor: "2026-10-01" });
    expect(sync).toMatchObject({ orders: 1, error: null });
    expect(events()).toHaveLength(1);
    expect(events()[0]).toMatchObject({ kind: "cancelled_woocommerce", note: "por María Torres", occurred_at: "2026-10-24T15:20:31.000Z" });
    await processWooWebhook(params(JSON.stringify(cancelled())), h.db.client(), { fetchImpl: site.fetchImpl });
    expect(events()).toHaveLength(1);
    expect(h.eventsAtRecompute.every((n) => n <= 1)).toBe(true);
  });

  it("el webhook y la pasada a la vez: un solo hecho", async () => {
    await seedLive();
    const site = wooSite({ orders: [cancelled()] });
    await Promise.all([
      processWooWebhook(params(JSON.stringify(cancelled())), h.db.client(), { fetchImpl: site.fetchImpl }),
      syncWooOrders(h.db.client(), STORE_ID, { fetchImpl: site.fetchImpl, floor: "2026-10-01" }),
    ]);
    expect(events()).toHaveLength(1);
  });

  it("dos escrituras que leyeron el mismo pedido vivo dan la misma clave, aunque vieran versiones distintas", async () => {
    await seedLive();
    const before = { cancelled_at: null, updated_at: order()!.updated_at };
    const item = (changedAt: string): WooTransitionItem => ({
      shopifyOrderId: "wc-aur-4",
      wooId: 4,
      transition: "cancelled",
      before,
      changedAt,
      status: "cancelled",
    });
    expect(await recordWooStatusTransitions(h.db.client(), STORE_ID, [item("2026-10-24T15:20:31Z")], null)).toBe(1);
    expect(await recordWooStatusTransitions(h.db.client(), STORE_ID, [item("2026-10-24T15:25:00Z")], null)).toBe(0);
    expect(events()).toHaveLength(1);
  });

  it("un cambio masivo: como mucho WOO_NOTES_MAX_LOOKUPS lecturas de notas; los demás, sin autor", async () => {
    const ids = [4, 5, 6];
    for (const id of ids) {
      const body = JSON.stringify(wooOrder({ id, number: `AUR90000${id}` }));
      await processWooWebhook(params(body, { topic: "order.created", deliveryId: `alta-${id}` }), h.db.client(), {
        fetchImpl: wooSite().fetchImpl,
      });
    }
    const site = wooSite();
    const items: WooTransitionItem[] = ids.map((id) => ({
      shopifyOrderId: `wc-aur-${id}`,
      wooId: id,
      transition: "cancelled",
      before: { cancelled_at: null, updated_at: "2026-10-24T14:02:12Z" },
      changedAt: `${CANCEL_AT}Z`,
      status: "cancelled",
    }));
    const client = { siteUrl: SITE, consumerKey: "ck_x123", consumerSecret: "cs_x123", fetchImpl: site.fetchImpl };
    expect(await recordWooStatusTransitions(h.db.client(), STORE_ID, items, client, { maxLookups: 2 })).toBe(3);
    expect(site.notesCalls().map((u) => u.pathname)).toEqual(["/wp-json/wc/v3/orders/4/notes", "/wp-json/wc/v3/orders/5/notes"]);
    expect(events().map((e) => e.note)).toEqual(["por María Torres", "por María Torres", null]);
    // Pasado el tope no se leen: sin autor, sin `woo_notes_error` (MOM §38.3).
    expect(events()[2]!.payload).toMatchObject({ woo_by: null, woo_note_id: null });
    expect(events()[2]!.payload).not.toHaveProperty("woo_notes_error");
  });

  it("anulado por WooCommerce solo (un plugin, un pedido sin pagar que venció): «WooCommerce (automático)»", async () => {
    await seedLive();
    const auto = wooSite({
      notes: [note({ author: "WooCommerce", added_by_user: false, note: "Pedido no pagado cancelado - se alcanzó el límite de tiempo. Estado del pedido cambiado de Por confirmar a Cancelado." })],
    });
    await processWooWebhook(params(JSON.stringify(cancelled())), h.db.client(), { fetchImpl: auto.fetchImpl });
    expect(events()[0]).toMatchObject({ note: "WooCommerce (automático)", actor: null, payload: { woo_by: "system", woo_author: null } });
  });

  it("el texto de la nota no se guarda: un prefijo con datos de la clienta no queda en el hecho", async () => {
    await seedLive();
    const site = wooSite({
      notes: [
        note({
          note: "Clienta Rosa Quispe (DNI 45678912, cel 987654321, Av. Arequipa 123) pidió cancelar. Estado del pedido cambiado de Por confirmar a Cancelado.",
        }),
      ],
    });
    await processWooWebhook(params(JSON.stringify(cancelled())), h.db.client(), { fetchImpl: site.fetchImpl });
    expect(events()).toHaveLength(1);
    // Quién sí (es la nota del cambio de estado) y cuál fue la nota, no lo que dice:
    // `order_events` no se edita ni se borra (0045).
    expect(events()[0]).toMatchObject({ note: "por María Torres", payload: { woo_note_id: 90, woo_note_at: "2026-10-24T15:20:31Z" } });
    const stored = JSON.stringify(events()[0]);
    for (const dato of ["Quispe", "45678912", "987654321", "Arequipa", "pidió cancelar"]) expect(stored).not.toContain(dato);
  });

  it("un comentario del equipo que nombra la anulación no dice quién anuló (no se adivina)", async () => {
    await seedLive();
    const site = wooSite({
      notes: [note({ id: 80, author: "Ana (operaciones)", note: "Clienta pidió cancelar por WhatsApp.", date_created_gmt: "2026-10-24T15:19:00" })],
    });
    await processWooWebhook(params(JSON.stringify(cancelled())), h.db.client(), { fetchImpl: site.fetchImpl });
    expect(events()).toHaveLength(1);
    expect(events()[0]).toMatchObject({ note: null, payload: { woo_by: null, woo_author: null, woo_note_id: null } });
  });

  it("la pasada que pisó la anulación con una versión anterior y la vuelve a ver: sigue habiendo un solo hecho", async () => {
    await seedLive();
    const site = wooSite({ orders: [cancelled()] });
    await processWooWebhook(params(JSON.stringify(cancelled())), h.db.client(), { fetchImpl: site.fetchImpl });
    expect(events()).toHaveLength(1);
    // La pasada había leído el pedido vivo antes de la anulación y guarda encima
    // su versión anterior (su lectura y su upsert no son atómicos).
    Object.assign(order()!, { cancelled_at: null, financial_status: "pending", updated_at: "2026-10-24T15:10:00Z" });
    // La pasada siguiente vuelve a ver la anulación, desde otro estado guardado (otra clave).
    const sync = await syncWooOrders(h.db.client(), STORE_ID, { fetchImpl: site.fetchImpl, floor: "2026-10-01" });
    expect(sync.error).toBeNull();
    expect(order()).toMatchObject({ cancelled_at: `${CANCEL_AT}Z` });
    expect(events()).toHaveLength(1);
    // Ni vuelve a leer las notas.
    expect(site.notesCalls()).toHaveLength(1);
  });

  it("si no se puede leer el último hecho del pedido, la anulación entra igual", async () => {
    await seedLive();
    h.db.failOn = (table, op) => (table === "order_events" && op === "select" ? { message: "se cayó" } : null);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await processWooWebhook(params(JSON.stringify(cancelled())), h.db.client(), { fetchImpl: wooSite().fetchImpl });
    } finally {
      errors.mockRestore();
    }
    expect(events()).toHaveLength(1);
    expect(events()[0]).toMatchObject({ kind: "cancelled_woocommerce", note: "por María Torres" });
  });

  it("si las notas fallan (error, tiempo, otra cosa que una lista): el hecho sin autor y el pedido entra igual", async () => {
    for (const site of [wooSite({ notesStatus: 500 }), wooSite({ notesThrow: "TimeoutError" }), wooSite({ notes: { code: "x" } })]) {
      h.db = new FakeDb({ stores: [storeRow()] });
      await seedLive();
      const r = await processWooWebhook(params(JSON.stringify(cancelled())), h.db.client(), { fetchImpl: site.fetchImpl });
      expect(r).toEqual({ status: "ok" });
      expect(order()).toMatchObject({ cancelled_at: `${CANCEL_AT}Z`, financial_status: "voided" });
      expect(events()).toHaveLength(1);
      expect(events()[0]).toMatchObject({ kind: "cancelled_woocommerce", note: null, actor: null, payload: { woo_by: null } });
      expect(events()[0]!.payload.woo_notes_error).toEqual(expect.any(String));
      expect(spies.recompute).toHaveBeenCalled();
    }
  });

  it("sin nota de cambio de estado cerca de la anulación: sin autor (no se adivina)", async () => {
    await seedLive();
    const site = wooSite({ notes: [note({ date_created_gmt: "2026-10-23T09:00:00" })] });
    await processWooWebhook(params(JSON.stringify(cancelled())), h.db.client(), { fetchImpl: site.fetchImpl });
    expect(events()[0]).toMatchObject({ note: null, payload: { woo_by: null, woo_note_id: null } });
  });

  it("una tienda sin las claves de la API (solo el secreto del webhook): el hecho sin autor y ninguna llamada", async () => {
    h.db = new FakeDb({ stores: [storeRow({ woo_consumer_key_enc: null, woo_consumer_secret_enc: null })] });
    await seedLive();
    const site = wooSite();
    await processWooWebhook(params(JSON.stringify(cancelled())), h.db.client(), { fetchImpl: site.fetchImpl });
    expect(site.calls).toEqual([]);
    expect(events()).toHaveLength(1);
    expect(events()[0]).toMatchObject({ note: null, payload: { woo_by: null } });
    // No es un fallo de lectura: las notas no se leyeron (MOM §38.3).
    expect(events()[0]!.payload).not.toHaveProperty("woo_notes_error");
  });

  it("un pedido que entra ya anulado (llegó a processing antes de que Kapta lo viera) también lo registra", async () => {
    const site = wooSite();
    await processWooWebhook(params(JSON.stringify(cancelled())), h.db.client(), { fetchImpl: site.fetchImpl });
    expect(order()).toMatchObject({ cancelled_at: `${CANCEL_AT}Z` });
    expect(events()).toHaveLength(1);
    expect(events()[0]).toMatchObject({ kind: "cancelled_woocommerce", note: "por María Torres" });
  });

  it("un pedido vivo que cambia sin anularse no deja hecho", async () => {
    await seedLive();
    const site = wooSite();
    await processWooWebhook(params(JSON.stringify(wooOrder({ status: "processing", date_modified_gmt: "2026-10-24T15:00:00" }))), h.db.client(), {
      fetchImpl: site.fetchImpl,
    });
    expect(events()).toEqual([]);
    expect(site.calls).toEqual([]);
  });
});

describe("la reactivación en WooCommerce", () => {
  it("«Reactivado en WooCommerce» por quien lo reactivó; una nueva anulación es otro hecho", async () => {
    await seedLive();
    await processWooWebhook(params(JSON.stringify(cancelled())), h.db.client(), { fetchImpl: wooSite().fetchImpl });
    const REACT_AT = "2026-10-24T16:02:00";
    const site = wooSite({
      notes: [
        note({ id: 95, author: "Ana Ruiz", note: "Estado del pedido cambiado de Cancelado a Procesando.", date_created_gmt: REACT_AT }),
        ...NOTES,
      ],
    });
    const back = JSON.stringify(wooOrder({ status: "processing", date_modified_gmt: REACT_AT }));
    expect((await processWooWebhook(params(back, { topic: "order.updated" }), h.db.client(), { fetchImpl: site.fetchImpl })).status).toBe("ok");
    expect(order()).toMatchObject({ cancelled_at: null });
    expect(events().map((e) => e.kind)).toEqual(["cancelled_woocommerce", "reactivated_woocommerce"]);
    expect(events()[1]).toMatchObject({
      occurred_at: "2026-10-24T16:02:00.000Z",
      note: "por Ana Ruiz",
      source: "woocommerce",
      actor: null,
      payload: { woo_status: "processing", woo_author: "Ana Ruiz", woo_note_id: 95 },
    });

    // Y otra anulación después: es otro cambio, otro hecho.
    const AGAIN = "2026-10-25T09:00:00";
    await processWooWebhook(params(JSON.stringify(cancelled({ date_modified_gmt: AGAIN }))), h.db.client(), {
      fetchImpl: wooSite({ notes: [note({ id: 99, date_created_gmt: AGAIN })] }).fetchImpl,
    });
    expect(events().map((e) => e.kind)).toEqual(["cancelled_woocommerce", "reactivated_woocommerce", "cancelled_woocommerce"]);
    expect(events()[2]).toMatchObject({ occurred_at: "2026-10-25T09:00:00.000Z", payload: { woo_note_id: 99 } });
    expect(new Set(events().map((e) => e.operation_id)).size).toBe(3);
  });

  it("el reembolso de un anulado (`refunded`) no es una reactivación: ni el webhook ni la pasada dejan hecho", async () => {
    const REFUND_AT = "2026-10-24T16:30:00";
    const refundNotes = [note({ id: 96, note: "Estado del pedido cambiado de Cancelado a Reembolsado.", date_created_gmt: REFUND_AT }), ...NOTES];
    const refunded = wooOrder({ status: "refunded", date_modified_gmt: REFUND_AT, refunds: [{ id: 1, total: "-119.00" }] });
    for (const via of ["webhook", "pasada"] as const) {
      h.db = new FakeDb({ stores: [storeRow()] });
      await seedLive();
      await processWooWebhook(params(JSON.stringify(cancelled())), h.db.client(), { fetchImpl: wooSite().fetchImpl });
      const site = wooSite({ orders: [refunded], notes: refundNotes });
      if (via === "webhook") {
        const r = await processWooWebhook(params(JSON.stringify(refunded), { deliveryId: "r1" }), h.db.client(), { fetchImpl: site.fetchImpl });
        expect(r.status, via).toBe("ok");
      } else {
        const sync = await syncWooOrders(h.db.client(), STORE_ID, { fetchImpl: site.fetchImpl, floor: "2026-10-01" });
        expect(sync.error, via).toBeNull();
      }
      // Sigue anulado (owner, 24-10-2026): conserva su `cancelled_at`…
      expect(order(), via).toMatchObject({ financial_status: "refunded" });
      expect(order()?.cancelled_at, via).not.toBeNull();
      // …pero WooCommerce no lo reactivó: ningún «Reactivado en WooCommerce».
      expect(events().map((e) => e.kind), via).toEqual(["cancelled_woocommerce"]);
      expect(site.notesCalls(), via).toEqual([]);
    }
  });
});

describe("la papelera", () => {
  it("sin respuesta de WooCommerce: «Anulado en WooCommerce» · «Enviado a la papelera», una sola vez", async () => {
    await seedLive();
    const down = wooSite({ orderStatus: 500 });
    const del = (d: string) => params(JSON.stringify({ id: 4 }), { topic: "order.deleted", deliveryId: d });
    expect((await processWooWebhook(del("x1"), h.db.client(), { fetchImpl: down.fetchImpl })).status).toBe("ok");
    expect(order()!.cancelled_at).toEqual(expect.any(String));
    expect(events()).toHaveLength(1);
    expect(events()[0]).toMatchObject({
      kind: "cancelled_woocommerce",
      note: "Enviado a la papelera",
      occurred_at: order()!.cancelled_at,
      payload: { woo_status: "trash", woo_by: null },
    });
    expect(down.notesCalls()).toEqual([]);
    await processWooWebhook(del("x2"), h.db.client(), { fetchImpl: down.fetchImpl });
    expect(events()).toHaveLength(1);
  });

  it("releído por la API: la papelera con su fecha de WooCommerce", async () => {
    await seedLive();
    const TRASH_AT = "2026-10-24T17:00:00";
    const site = wooSite({ orders: [wooOrder({ status: "trash", date_modified_gmt: TRASH_AT })], notes: [] });
    await processWooWebhook(params(JSON.stringify({ id: 4 }), { topic: "order.deleted", deliveryId: "t1" }), h.db.client(), {
      fetchImpl: site.fetchImpl,
    });
    expect(events()).toHaveLength(1);
    expect(events()[0]).toMatchObject({ occurred_at: "2026-10-24T17:00:00.000Z", note: "Enviado a la papelera", payload: { woo_status: "trash" } });
  });

  it("releída por la API, con notas cerca que no dicen «a Papelera»: sin autor (no se adivina quién la mandó)", async () => {
    await seedLive();
    const TRASH_AT = "2026-10-24T17:00:00";
    const site = wooSite({
      orders: [wooOrder({ status: "trash", date_modified_gmt: TRASH_AT })],
      notes: [
        note({ id: 81, author: "Ana (operaciones)", note: "Clienta pidió cancelar, va a la papelera.", date_created_gmt: "2026-10-24T16:59:30" }),
        note({ id: 82, author: "system", added_by_user: false, note: "Pago cancelado por la pasarela.", date_created_gmt: "2026-10-24T16:59:00" }),
        note({ id: 83, author: "Luis", note: "Estado del pedido cambiado de Por confirmar a Cancelado.", date_created_gmt: "2026-10-24T16:55:00" }),
      ],
    });
    await processWooWebhook(params(JSON.stringify({ id: 4 }), { topic: "order.deleted", deliveryId: "t2" }), h.db.client(), {
      fetchImpl: site.fetchImpl,
    });
    expect(site.notesCalls()).toHaveLength(1);
    expect(events()).toHaveLength(1);
    expect(events()[0]).toMatchObject({
      note: "Enviado a la papelera",
      payload: { woo_status: "trash", woo_by: null, woo_author: null, woo_note_id: null },
    });
  });
});

describe("Shopify no cambia", () => {
  it("un pedido de Shopify anulado por su webhook no deja hechos nuevos", async () => {
    const body = JSON.stringify({
      id: 7406190100775,
      name: "#AUR178541",
      created_at: "2026-10-24T09:10:56-05:00",
      updated_at: "2026-10-24T10:20:31-05:00",
      cancelled_at: "2026-10-24T10:20:31-05:00",
      total_price: "119.00",
      currency: "PEN",
      financial_status: "voided",
      tags: "easysell_cod_form",
      phone: "+51 987 111 222",
      line_items: [{ title: "Sérum", sku: "SER-1", product_id: 1, quantity: 1, price: "119.00" }],
    });
    const hmac = createHmac("sha256", SHOPIFY_SECRET).update(body, "utf8").digest("base64");
    const r = await processShopifyWebhook(
      { storeId: STORE_ID, topic: "orders/cancelled", rawBody: body, hmacHeader: hmac, webhookIdHeader: "wh_1" },
      h.db.client(),
    );
    expect(r.status).toBe("ok");
    expect(h.db.rows("orders").find((o) => o.shopify_order_id === "7406190100775")).toMatchObject({ cancelled_at: expect.any(String) });
    expect(h.db.opsOn("order_events", "insert")).toEqual([]);
  });

  it("los procesadores de Shopify no llaman al registro de WooCommerce", () => {
    const ingest = readFileSync(resolve(process.cwd(), "lib/ingest.ts"), "utf8");
    const shopify = ingest.slice(ingest.indexOf("export async function processShopifyWebhook("), ingest.indexOf("// WooCommerce: webhooks de pedidos"));
    expect(shopify.length).toBeGreaterThan(200);
    expect(shopify).not.toContain("recordWooStatusTransitions");
  });
});

describe("la nota de WooCommerce: cuál es y quién la escribió", () => {
  const at = `${CANCEL_AT}Z`;

  it("lee el cambio de estado en español y en inglés, también detrás de un prefijo", () => {
    expect(wooNoteTransition("Estado del pedido cambiado de Por confirmar a Cancelado.")).toEqual({ from: "Por confirmar", to: "Cancelado" });
    expect(wooNoteTransition("El estado del pedido cambió de Procesando a Cancelado.")).toEqual({ from: "Procesando", to: "Cancelado" });
    expect(wooNoteTransition("Order status changed from Pending payment to Cancelled.")).toEqual({ from: "Pending payment", to: "Cancelled" });
    expect(
      wooNoteTransition("Pedido no pagado cancelado - se alcanzó el límite de tiempo. Estado del pedido cambiado de Pendiente de pago a Cancelado."),
    ).toEqual({ from: "Pendiente de pago", to: "Cancelado" });
    expect(wooNoteTransition("Order status changed by bulk edit: Order status changed from Processing to Cancelled.")).toMatchObject({
      to: "Cancelled",
    });
    expect(wooNoteTransition("Estado del pedido cambiado de <b>Procesando</b> a <b>Cancelado</b>.")).toEqual({ from: "Procesando", to: "Cancelado" });
    expect(wooNoteTransition("Pedido creado por COD Core.")).toBeNull();
  });

  it("la anulación toma la nota más nueva «… a Cancelado» cerca del cambio; nunca una de la clienta", () => {
    expect(pickWooStatusNote(NOTES, "cancelled", at)?.id).toBe(90);
    const newer = note({ id: 91, author: "Luis", date_created_gmt: "2026-10-24T15:20:40" });
    expect(pickWooStatusNote([note(), newer], "cancelled", at)?.id).toBe(91);
    expect(pickWooStatusNote([note({ customer_note: true })], "cancelled", at)).toBeNull();
  });

  it("fuera de la ventana (10 minutos antes, 2 después) no cuenta", () => {
    expect(pickWooStatusNote([note({ date_created_gmt: "2026-10-24T15:09:00" })], "cancelled", at)).toBeNull();
    expect(pickWooStatusNote([note({ date_created_gmt: "2026-10-24T15:11:00" })], "cancelled", at)?.id).toBe(90);
    expect(pickWooStatusNote([note({ date_created_gmt: "2026-10-24T15:23:00" })], "cancelled", at)).toBeNull();
    expect(pickWooStatusNote([note()], "cancelled", null)).toBeNull();
  });

  it("una reactivación nunca toma la nota de una anulación, ni al revés", () => {
    const back = note({ id: 95, note: "Estado del pedido cambiado de Cancelado a Procesando.", date_created_gmt: "2026-10-24T15:21:00" });
    expect(pickWooStatusNote([back, note()], "cancelled", at)?.id).toBe(90);
    expect(pickWooStatusNote([back, note()], "reactivated", at)?.id).toBe(95);
    expect(pickWooStatusNote([note()], "reactivated", at)).toBeNull();
  });

  it("sin nota de cambio de estado, la anulación toma la más nueva que la nombre si la escribió WooCommerce solo (un plugin)", () => {
    const plugin = note({ id: 70, author: "system", added_by_user: false, note: "Flow: pedido anulado por falta de pago." });
    expect(pickWooStatusNote([plugin], "cancelled", at)?.id).toBe(70);
    expect(wooNoteActor(pickWooStatusNote([plugin], "cancelled", at))).toEqual({ by: "system" });
    // El comentario de una persona no dice quién anuló, aunque sea más nuevo.
    const staff = note({ id: 72, author: "Ana (operaciones)", note: "Clienta pidió cancelar.", date_created_gmt: "2026-10-24T15:20:50" });
    expect(pickWooStatusNote([staff], "cancelled", at)).toBeNull();
    expect(pickWooStatusNote([staff, plugin], "cancelled", at)?.id).toBe(70);
    // Sin `added_by_user`, un autor que no es `system` ni `WooCommerce` es una persona.
    expect(pickWooStatusNote([note({ id: 73, added_by_user: undefined, author: "Ana", note: "Anulado: no contesta." })], "cancelled", at)).toBeNull();
    expect(pickWooStatusNote([note({ id: 74, added_by_user: undefined, author: "WooCommerce", note: "Anulado: no contesta." })], "cancelled", at)?.id).toBe(74);
    // Pero no una nota de otro cambio de estado.
    const other = note({ id: 71, note: "Estado del pedido cambiado de Por confirmar a Procesando. Cupón cancelado." });
    expect(pickWooStatusNote([other], "cancelled", at)).toBeNull();
    expect(pickWooStatusNote([plugin], "reactivated", at)).toBeNull();
  });

  it("la papelera: solo una nota que diga que fue a la papelera, y nunca el respaldo", () => {
    const plugin = note({ id: 70, author: "system", added_by_user: false, note: "Flow: pedido anulado por falta de pago." });
    const staff = note({ id: 72, author: "Ana (operaciones)", note: "Clienta pidió cancelar." });
    // WooCommerce no escribe nota al mandar a la papelera: «a Cancelado» de otro momento no la explica.
    expect(pickWooStatusNote([plugin, staff, note()], "cancelled", at, "trash")).toBeNull();
    expect(pickWooStatusNote([note()], "cancelled", at, "wc-trash")).toBeNull();
    const toTrash = note({ id: 75, author: "Luis", note: "Estado del pedido cambiado de Cancelado a Papelera.", date_created_gmt: "2026-10-24T15:20:00" });
    expect(pickWooStatusNote([plugin, staff, note(), toTrash], "cancelled", at, "trash")?.id).toBe(75);
    // Fuera de la papelera, como siempre.
    expect(pickWooStatusNote([note()], "cancelled", at, "cancelled")?.id).toBe(90);
  });

  it("quién: el usuario (added_by_user), WooCommerce solo, o el autor si la versión no manda added_by_user", () => {
    expect(wooNoteActor(note())).toEqual({ by: "user", name: "María Torres" });
    expect(wooNoteActor(note({ added_by_user: false }))).toEqual({ by: "system" });
    expect(wooNoteActor(note({ added_by_user: undefined, author: "system" }))).toEqual({ by: "system" });
    expect(wooNoteActor(note({ added_by_user: undefined, author: "WooCommerce" }))).toEqual({ by: "system" });
    expect(wooNoteActor(note({ added_by_user: undefined, author: "  Ana  <b>Ruiz</b> " }))).toEqual({ by: "user", name: "Ana Ruiz" });
    expect(wooNoteActor(note({ author: "" }))).toBeNull();
    expect(wooNoteActor(null)).toBeNull();
  });

  it("el detalle del hecho", () => {
    expect(wooTransitionDetail({ by: "user", name: "María Torres" })).toBe("por María Torres");
    expect(wooTransitionDetail({ by: "system" })).toBe("WooCommerce (automático)");
    expect(wooTransitionDetail(null)).toBeNull();
    expect(wooTransitionDetail(null, { trash: true })).toBe("Enviado a la papelera");
    expect(wooTransitionDetail({ by: "user", name: "Ana" }, { trash: true })).toBe("por Ana · enviado a la papelera");
  });

  it("cuándo hay cambio y su clave", () => {
    expect(wooStatusTransition({ cancelled_at: null }, { cancelled_at: "x" })).toBe("cancelled");
    expect(wooStatusTransition(null, { cancelled_at: "x" })).toBe("cancelled");
    expect(wooStatusTransition({ cancelled_at: "x" }, { cancelled_at: null })).toBe("reactivated");
    expect(wooStatusTransition({ cancelled_at: "x" }, { cancelled_at: "x" })).toBeNull();
    expect(wooStatusTransition({ cancelled_at: null }, { cancelled_at: null })).toBeNull();
    expect(wooStatusTransition(null, { cancelled_at: null })).toBeNull();
    // El reembolso de un anulado no lo reactiva en WooCommerce.
    expect(wooStatusTransition({ cancelled_at: "x" }, { cancelled_at: null }, "refunded")).toBeNull();
    expect(wooStatusTransition({ cancelled_at: "x" }, { cancelled_at: null }, " wc-Refunded ")).toBeNull();
    expect(wooStatusTransition({ cancelled_at: "x" }, { cancelled_at: null }, "processing")).toBe("reactivated");
    expect(wooStatusTransition({ cancelled_at: "x" }, { cancelled_at: null }, "cod-pending")).toBe("reactivated");
    expect(wooStatusTransition({ cancelled_at: null }, { cancelled_at: "x" }, "trash")).toBe("cancelled");

    const live = { cancelled_at: null, updated_at: "2026-10-24T14:02:12+00:00" };
    const k = wooTransitionOperationId(STORE_ID, "wc-aur-4", "cancelled", live);
    // Misma clave con la fecha escrita de otra forma: es el mismo estado guardado.
    expect(wooTransitionOperationId(STORE_ID, "wc-aur-4", "cancelled", { ...live, updated_at: "2026-10-24T14:02:12Z" })).toBe(k);
    expect(wooTransitionOperationId(STORE_ID, "wc-aur-4", "cancelled", { ...live, updated_at: "2026-10-24T16:02:00Z" })).not.toBe(k);
    expect(wooTransitionOperationId(STORE_ID, "wc-aur-5", "cancelled", live)).not.toBe(k);
    expect(wooTransitionOperationId(STORE_ID, "wc-aur-4", "cancelled", null)).not.toBe(k);
    expect(WOO_EVENT_KIND).toEqual({ cancelled: "cancelled_woocommerce", reactivated: "reactivated_woocommerce" });
  });

  it("el último hecho de WooCommerce de cada pedido", () => {
    const last = latestWooTransitionKinds([
      { order_id: "a", kind: "cancelled_woocommerce", occurred_at: "2026-10-24T15:20:31Z" },
      { order_id: "a", kind: "reactivated_woocommerce", occurred_at: "2026-10-24T16:02:00Z" },
      { order_id: "b", kind: "reactivated_woocommerce", occurred_at: "2026-10-24T09:00:00Z" },
      { order_id: "b", kind: "cancelled_woocommerce", occurred_at: "2026-10-24T10:00:00+00:00" },
      // A igual hora, el que entró después.
      { order_id: "c", kind: "cancelled_woocommerce", occurred_at: "2026-10-24T10:00:00Z", created_at: "2026-10-24T10:00:05Z" },
      { order_id: "c", kind: "reactivated_woocommerce", occurred_at: "2026-10-24T10:00:00Z", created_at: "2026-10-24T10:00:09Z" },
    ]);
    expect(Object.fromEntries(last)).toEqual({ a: "reactivated_woocommerce", b: "cancelled_woocommerce", c: "reactivated_woocommerce" });
    expect(latestWooTransitionKinds([]).size).toBe(0);
  });
});

describe("la ficha lo enseña", () => {
  const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");
  const row = (over: Partial<OrderEventRow>): OrderEventRow => ({
    id: "ev-1",
    store_id: STORE_ID,
    order_id: "ord-1",
    kind: "cancelled_woocommerce",
    occurred_at: "2026-10-24T15:20:31+00:00",
    actor: null,
    source: "woocommerce",
    courier: null,
    guide_code: null,
    previous_status: null,
    new_status: null,
    previous_operational: null,
    new_operational: null,
    attempt_number: null,
    reason: null,
    note: "por María Torres",
    comment_type: null,
    shipment_id: null,
    batch_id: null,
    payload: { woo_author: "María Torres" },
    ...over,
  });

  it("la línea de tiempo lleva el hecho con su detalle, sin actor de Kapta, y origen «WooCommerce»", () => {
    const [t] = orderEventsToTimeline([row({})], new Map([["u-1", "alguien@kapta.pe"]]));
    expect(t).toMatchObject({
      id: "event:ev-1",
      kind: "cancelled_woocommerce",
      source: "woocommerce",
      note: "por María Torres",
      actorName: null,
      newStatus: null,
      origin: "master",
    });
    expect(timelineOriginLabel(t!)).toBe("WooCommerce");
    // Hito de cierre, como la anulación en Shopify.
    expect(timelineFact(t!)).toEqual({ icon: "anulado", stage: "por_cerrar" });
    const [r] = orderEventsToTimeline([row({ kind: "reactivated_woocommerce", note: "WooCommerce (automático)" })], new Map());
    expect(timelineFact(r!)).toEqual({ icon: "estado", stage: null });
    expect(r!.note).toBe("WooCommerce (automático)");
  });

  it("los demás orígenes se leen como antes", () => {
    expect(timelineOriginLabel({ origin: "gestion", source: "repro_provincia" })).toBe("Repro Provincia");
    expect(timelineOriginLabel({ origin: "leads", source: "leads" })).toBe("Leads");
    expect(timelineOriginLabel({ origin: "master", source: "shopify" })).toBe("shopify");
    expect(timelineOriginLabel({ origin: "master", source: "manual" })).toBe("manual");
  });

  it("los títulos y el origen en la ficha", () => {
    const shared = read("components/order-master-shared.tsx");
    expect(shared).toContain('cancelled_woocommerce: "Anulado en WooCommerce"');
    expect(shared).toContain('reactivated_woocommerce: "Reactivado en WooCommerce"');
    const drawer = read("components/order-drawer.tsx");
    expect(drawer).toContain("timelineOriginLabel(t)");
  });
});

describe("MOM §38.3 y §25", () => {
  const flat = (text: string) => text.replace(/\s+/g, " ");
  const MOM = readFileSync(resolve(process.cwd(), "docs/mom/master-pedidos-v1.md"), "utf8");
  const section = (title: string, next: string) => {
    const start = MOM.indexOf(title);
    expect(start, title).toBeGreaterThan(-1);
    return flat(MOM.slice(start, MOM.indexOf(next, start)));
  };
  const S383 = section("### 38.3 Estados", "### 38.4 Cobro");
  const S25 = section("## 25. User journey del drawer del Master", "### 25.1");

  it("§38.3 promete lo que hace el código", () => {
    expect(S383).toContain("**La Actividad lo dice, y quién fue (24-10-2026).**");
    expect(S383).toContain("**«Anulado en WooCommerce»**");
    expect(S383).toContain("**«Reactivado en WooCommerce»**");
    expect(S383).toContain("**«por <nombre>»**");
    expect(S383).toContain("**«WooCommerce (automático)»**");
    expect(S383).toContain("`GET /wp-json/wc/v3/orders/<id>/notes?type=internal`");
    expect(S383).toContain(`corta a los ${WOO_NOTES_TIMEOUT_MS / 1000} segundos`);
    expect(S383).toContain(`como mucho ${WOO_NOTES_MAX_LOOKUPS} por llamada`);
    expect(S383).toContain(
      `entre ${WOO_NOTE_WINDOW_BEFORE_MS / 60_000} minutos antes y ${WOO_NOTE_WINDOW_AFTER_MS / 60_000} después del cambio`,
    );
    expect(S383).toContain("`order_events_operation_kind_uniq`");
    expect(S383).toContain(`\`${WOO_EVENT_KIND.cancelled}\` y \`${WOO_EVENT_KIND.reactivated}\``);
    expect(S383).toContain("nunca en `order_events.actor`");
    // Revisión del 24-10-2026.
    expect(S383).toContain("**El texto de la nota no se guarda**");
    expect(S383).not.toContain("`woo_note`");
    expect(S383).toContain("no dice quién anuló: nunca cuenta");
    expect(S383).toContain("el autor sale solo de una nota que diga que fue a la papelera");
    expect(S383).toContain("Si la lectura falla, el hecho queda sin autor y `payload.woo_notes_error` dice por qué.");
    expect(S383).toContain("o pasado el tope, las notas no se leen: el hecho queda sin autor, sin ese campo.");
    expect(S383).toContain("si el último hecho de WooCommerce del pedido ya es del mismo tipo, no se escribe otro");
    expect(S383).toContain("**El reembolso no reactiva.**");
    expect(S383).toContain("no deja «Reactivado en WooCommerce»");
  });

  it("§25 dice cómo se ve en la ficha", () => {
    expect(S25).toContain("**La anulación en WooCommerce está en la Actividad (24-10-2026, §38.3).**");
    expect(S25).toContain("el origen **«WooCommerce»**");
    expect(S25).toContain("**«Reactivado en WooCommerce»**");
  });
});
