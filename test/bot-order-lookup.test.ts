// Consultar un pedido que ya existe, para el bot de Kapso (MOM §38.13,
// docs/kapso-pedidos-kapta.md sección 10): `POST
// /api/internal/orders/[storeId]/lookup` y `handleBotOrderLookup`
// (lib/bot-order-lookup.ts), de punta a punta con la base falsa de la entrada
// de WooCommerce. Lo que se fija:
//   - el secreto: el MISMO que al crear (`authenticateBotCall`); sin él o con
//     otro, 401 sin detalles y sin leer el cuerpo ni ningún pedido;
//   - el cuerpo, estricto: un campo desconocido es un error; el número de
//     pedido con o sin «#», en cualquier caja;
//   - la privacidad: el pedido se busca por número Y celular a la vez; con otro
//     celular la respuesta es EXACTAMENTE la de un pedido que no existe;
//   - lo que vuelve: el total de HOY, el modo de pago derivado de lo guardado,
//     la dirección vigente, los productos sin precios y el estado del Master;
//   - no encontrado: 404 reintentable una vez, a los 10 s;
//   - solo lectura: ninguna escritura, ninguna llamada a la red;
//   - una línea de registro por llamada, sin el celular ni la dirección.
// Sin red ni base real.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  db: null as unknown as import("./woocommerce-fake-db").FakeDb,
}));

vi.mock("@/lib/db", () => ({
  createAdminSupabase: () => h.db.client(),
  createServerSupabase: async () => {
    throw new Error("no se usa en estas pruebas");
  },
}));

import { NextRequest } from "next/server";
import { hashBotSecret } from "@/lib/bot-orders";
import {
  BOT_ORDER_LOOKUP_MAX_BODY_BYTES,
  BOT_ORDER_LOOKUP_RETRY_AFTER_S,
  BOT_ORDER_LOOKUP_NOT_FOUND_MESSAGE,
  botLookupItems,
  botLookupPayment,
  botOrderLookupUrl,
  handleBotOrderLookup,
  lookupPhoneVariants,
  normalizeBotOrderName,
  normalizeLookupPhone,
  parseBotOrderLookupBody,
  sameLookupPhone,
  type BotOrderLookupDeps,
} from "@/lib/bot-order-lookup";
import { POST } from "@/app/api/internal/orders/[storeId]/lookup/route";
import { FakeDb, type Row } from "./woocommerce-fake-db";

const STORE = "11111111-1111-4111-8111-111111111111";
const OTHER_STORE = "22222222-2222-4222-8222-222222222222";
const SECRET = "kbot_secreto-de-prueba-0123456789abcdefghijklmnop";
// Datos inventados.
const PHONE = "51999000111";
const OTHER_PHONE = "51988805509";
const ORDER_ID = "ord-kp-200001";

let t = Date.parse("2026-10-24T21:20:00Z");
let logs: { line: string; level: string }[] = [];

function order(over: Row = {}): Row {
  return {
    id: ORDER_ID,
    store_id: STORE,
    shopify_order_id: "wc-kp-1532",
    name: "#KP200001",
    platform: "woocommerce",
    created_at: "2026-10-24T21:14:03Z",
    total_amount: 599.6,
    currency: "PEN",
    financial_status: "pending",
    payment_gateway: "cod",
    total_refunded: 0,
    cancelled_at: null,
    customer_phone: PHONE,
    shipping_mode: null,
    tags: [],
    line_items: [
      { title: "Zapatilla Urbana", variant_title: "38 / Negro", quantity: 2, sku: "ZAP-38-N", price: 249.9, product_id: "10", variant_id: "11" },
      { title: "Medias deportivas", variant_title: null, quantity: 1, sku: "MED-1", price: 99.8, product_id: "12", variant_id: null },
    ],
    raw: {
      shipping_address: {
        address1: "Av. Ejemplo 123",
        address2: "Frente al parque",
        city: "Santiago de Surco",
        province: "Lima (provincia)",
        name: "María Prueba",
        phone: "999000111",
      },
      total_price: "599.60",
    },
    ...over,
  };
}

function master(over: Row = {}): Row {
  return {
    id: "om-1",
    store_id: STORE,
    order_id: ORDER_ID,
    order_name: "#KP200001",
    customer_phone: PHONE,
    general_status: "pendiente",
    macro_stage: "por_confirmar",
    macro_substage: "sin_llamar",
    district: "Santiago de Surco",
    address: "Av. Ejemplo 123, dpto. 401",
    payment_state: "sin_pago",
    payment_gateway: "cod",
    order_total: 599.6,
    ...over,
  };
}

function setup(opts: { orders?: Row[]; masters?: Row[]; secret?: boolean } = {}) {
  h.db = new FakeDb({
    bot_order_secrets: opts.secret === false ? [] : [{ store_id: STORE, secret_hash: hashBotSecret(SECRET) }],
    orders: opts.orders ?? [order()],
    order_master: opts.masters ?? [master()],
  });
}

function deps(over: Partial<BotOrderLookupDeps> = {}): BotOrderLookupDeps {
  return { admin: h.db.client(), log: (line, level) => logs.push({ line, level }), now: () => t, ...over };
}

function consulta(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { order_name: "KP200001", phone: PHONE, ...over };
}

function call(body: unknown = consulta(), auth: string | null = `Bearer ${SECRET}`, over: Partial<BotOrderLookupDeps> = {}, storeId = STORE) {
  return handleBotOrderLookup({ storeId, authorization: auth, rawBody: typeof body === "string" ? body : JSON.stringify(body) }, deps(over));
}

/** Lo que vuelve cuando el pedido es de esta clienta (con el `order()` y el `master()` de arriba). */
const FOUND = {
  ok: true,
  order: {
    name: "#KP200001",
    platform: "woocommerce",
    created_at: "2026-10-24T21:14:03Z",
    total: 599.6,
    currency: "PEN",
    payment: "contraentrega",
    cancelled: false,
    delivery: { mode: null, district: "Santiago de Surco", address1: "Av. Ejemplo 123, dpto. 401" },
    items: [
      { title: "Zapatilla Urbana", variant: "38 / Negro", quantity: 2 },
      { title: "Medias deportivas", variant: null, quantity: 1 },
    ],
    master: { stage: "por_confirmar", stage_label: "Por confirmar", substage: "sin_llamar", substage_label: "Sin llamar" },
  },
};

/** Lo único que dice un `not_found`, exista o no el pedido con otro celular. */
const NOT_FOUND = {
  status: 404,
  body: {
    ok: false,
    code: "not_found",
    message: BOT_ORDER_LOOKUP_NOT_FOUND_MESSAGE,
    retryable: true,
    retry_after_seconds: BOT_ORDER_LOOKUP_RETRY_AFTER_S,
  },
};

const forbiddenFetch = vi.fn(async () => {
  throw new Error("no debía llamar a la red");
});

/** Ninguna escritura en ninguna tabla. */
function expectReadOnly() {
  const writes = h.db.ops.filter((o) => o.op !== "select");
  expect(writes).toEqual([]);
}

beforeEach(() => {
  t = Date.parse("2026-10-24T21:20:00Z");
  logs = [];
  vi.clearAllMocks();
  vi.stubGlobal("fetch", forbiddenFetch);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("el secreto: el mismo que al crear", () => {
  it("sin Authorization, con otro secreto, o con una tienda que no es un uuid: 401 sin detalles, sin leer ningún pedido", async () => {
    setup();
    for (const [auth, storeId] of [
      [null, STORE],
      ["Basic abc", STORE],
      [`Bearer ${SECRET}x`, STORE],
      [`Bearer ${SECRET.slice(0, -1)}`, STORE],
      [`Bearer ${SECRET}`, "kenku"],
      // El secreto de una tienda no abre otra.
      [`Bearer ${SECRET}`, OTHER_STORE],
    ] as const) {
      const res = await call(consulta(), auth, {}, storeId);
      expect(res).toEqual({ status: 401, body: { ok: false, code: "unauthorized", message: "No autorizado.", retryable: false } });
    }
    expect(h.db.opsOn("orders")).toHaveLength(0);
    expect(h.db.opsOn("order_master")).toHaveLength(0);
    expectReadOnly();
  });

  it("una tienda sin secreto (nunca generado, o «Desactivar»): 401", async () => {
    setup({ secret: false });
    expect((await call()).status).toBe(401);
    expect(h.db.opsOn("orders")).toHaveLength(0);
  });

  it("CRON_SECRET no abre la puerta", async () => {
    process.env.CRON_SECRET = "cron-secreto-compartido";
    setup();
    expect((await call(consulta(), "Bearer cron-secreto-compartido")).status).toBe(401);
    delete process.env.CRON_SECRET;
  });

  it("sin el secreto, el cuerpo ni se lee; un Content-Length de más es 413 sin tocar la base", async () => {
    setup();
    const readBody = vi.fn(async () => JSON.stringify(consulta()));
    const unauth = await handleBotOrderLookup({ storeId: STORE, authorization: "Bearer otro", readBody }, deps());
    expect(unauth.status).toBe(401);
    expect(readBody).not.toHaveBeenCalled();

    setup();
    const big = await handleBotOrderLookup(
      { storeId: STORE, authorization: `Bearer ${SECRET}`, contentLength: String(BOT_ORDER_LOOKUP_MAX_BODY_BYTES + 1), readBody },
      deps(),
    );
    expect(big.status).toBe(413);
    expect(big.body).toMatchObject({ ok: false, code: "body_too_large", retryable: false });
    expect(readBody).not.toHaveBeenCalled();
    expect(h.db.ops).toHaveLength(0);
  });

  it("con el secreto, el cuerpo se lee con tope: uno de más es 413", async () => {
    setup();
    const res = await handleBotOrderLookup(
      { storeId: STORE, authorization: `Bearer ${SECRET}`, readBody: async (max) => (max === BOT_ORDER_LOOKUP_MAX_BODY_BYTES ? null : "{}") },
      deps(),
    );
    expect(res.body).toMatchObject({ code: "body_too_large" });
    expect(h.db.opsOn("orders")).toHaveLength(0);
  });

  it("sin la 0277: 503 migration_missing; la base que no contesta: 503 store_unavailable reintentable", async () => {
    setup();
    h.db.failOn = (table) =>
      table === "bot_order_secrets" ? { code: "PGRST205", message: "Could not find the table 'public.bot_order_secrets' in the schema cache" } : null;
    const missing = await call();
    expect(missing.status).toBe(503);
    expect(missing.body).toMatchObject({ ok: false, code: "migration_missing", retryable: false });

    setup();
    h.db.hangOn = (table) => table === "bot_order_secrets";
    const slow = await call(consulta(), `Bearer ${SECRET}`, { dbTimeoutMs: 20 });
    expect(slow.status).toBe(503);
    expect(slow.body).toMatchObject({ code: "store_unavailable", retryable: true, retry_after_seconds: BOT_ORDER_LOOKUP_RETRY_AFTER_S });
    expect(h.db.opsOn("orders")).toHaveLength(0);
  });
});

describe("el cuerpo, estricto", () => {
  it("no es JSON, o no es un objeto: 400", async () => {
    setup();
    expect((await call("{no es json")).body).toMatchObject({ code: "invalid_body", message: "El cuerpo no es JSON." });
    expect((await call("[1,2]")).body).toMatchObject({ code: "invalid_body", errors: ["El cuerpo tiene que ser un objeto JSON."] });
    expect(h.db.opsOn("orders")).toHaveLength(0);
  });

  it("un campo desconocido no se ignora (tampoco el monto que dice el mensaje); cada problema en castellano", async () => {
    setup();
    const res = await call({ order_name: "KP-200001", phone: "12", total: 599.6, conversation_id: "conv-1" });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ ok: false, code: "invalid_body", retryable: false });
    expect((res.body as { errors: string[] }).errors).toEqual([
      "total: campo desconocido.",
      "conversation_id: campo desconocido.",
      expect.stringMatching(/^order_name: obligatorio/),
      expect.stringMatching(/^phone: obligatorio; el celular de la conversación/),
    ]);
    expect(h.db.opsOn("orders")).toHaveLength(0);
  });

  it("faltan los dos, o no son texto: 400 con los dos", async () => {
    setup();
    for (const body of [{}, { order_name: 200001, phone: 51999000111 }, { order_name: "", phone: "" }]) {
      const errors = ((await call(body)).body as { errors: string[] }).errors;
      expect(errors).toHaveLength(2);
      expect(errors[0]).toMatch(/^order_name:/);
      expect(errors[1]).toMatch(/^phone:/);
    }
  });

  it("parseBotOrderLookupBody normaliza el número y el celular", () => {
    expect(parseBotOrderLookupBody({ order_name: " #kp200001 ", phone: "+51 999 000 111" })).toEqual({
      ok: true,
      input: { orderName: "#KP200001", phone: PHONE },
    });
  });
});

describe("el número del pedido, como venga", () => {
  it("con o sin «#», en cualquier caja, con espacios o en ancho completo: el nombre de Kapta", () => {
    for (const raw of ["KP200001", "#KP200001", "kp200001", "#kp200001", " # kp 200001 ", "Kp200001", "##KP200001", "ＫＰ２０００01"]) {
      expect(normalizeBotOrderName(raw), raw).toBe("#KP200001");
    }
    expect(normalizeBotOrderName("aur900001")).toBe("#AUR900001");
    expect(normalizeBotOrderName("#KP143817")).toBe("#KP143817");
  });

  it("lo que no es un número de pedido: null", () => {
    for (const raw of ["", "#", "KP", "200001", "KP-200001", "KP200001X", "KP 2000 01 extra", "pedido KP200001", "K".repeat(11) + "1", "KP" + "1".repeat(13), "x".repeat(41)]) {
      expect(normalizeBotOrderName(raw), raw).toBeNull();
    }
    for (const raw of [null, undefined, 200001, ["KP200001"], { name: "KP200001" }]) expect(normalizeBotOrderName(raw)).toBeNull();
  });

  it("de punta a punta: «kp200001», «#KP200001» y « #Kp 200001 » encuentran el mismo pedido", async () => {
    setup();
    for (const name of ["kp200001", "#KP200001", " #Kp 200001 "]) {
      const res = await call(consulta({ order_name: name }));
      expect(res.status, name).toBe(200);
      expect(res.body, name).toEqual(FOUND);
    }
  });
});

describe("encontrado, y el celular es el de la conversación", () => {
  it("devuelve el pedido como lo tiene Kapta HOY, y nada más", async () => {
    setup();
    const res = await call();
    expect(res).toEqual({ status: 200, body: FOUND });
    // Sin precios por línea ni el celular: el monto que se le dice es `total`.
    const json = JSON.stringify(res.body);
    for (const absent of ["249.9", "99.8", "ZAP-38-N", PHONE, "999000111", "María", "Frente al parque", "wc-kp-1532", ORDER_ID]) {
      expect(json, absent).not.toContain(absent);
    }
  });

  it("el celular con o sin 51, +51, espacios, guiones o 00: es el mismo", async () => {
    setup();
    for (const phone of ["51999000111", "999000111", "+51 999 000 111", "+51-999-000-111", "0051999000111", " 999 000 111 "]) {
      const res = await call(consulta({ phone }));
      expect(res.status, phone).toBe(200);
    }
  });

  it("el total es el de HOY (`orders.total_amount`), no el del mensaje ni el que trajo la tienda al crearlo", async () => {
    setup({ orders: [order({ total_amount: 549.6, raw: { ...(order().raw as object), total_price: "599.60" } })], masters: [master({ order_total: 599.6 })] });
    const res = await call();
    expect((res.body as typeof FOUND).order.total).toBe(549.6);
  });

  it("solo lectura: ninguna escritura, ninguna llamada a la red, y no lee la tienda ni el candado de crear", async () => {
    setup();
    await call();
    await call(consulta({ phone: OTHER_PHONE }));
    await call(consulta({ order_name: "KP999999" }));
    expectReadOnly();
    expect(forbiddenFetch).not.toHaveBeenCalled();
    expect(h.db.opsOn("stores")).toHaveLength(0);
    expect(h.db.opsOn("bot_order_requests")).toHaveLength(0);
    // Tampoco el «último uso» de Ajustes: ese es del endpoint que crea.
    expect(h.db.opsOn("bot_order_secrets", "update")).toHaveLength(0);
  });

  it("no mira la plataforma: un pedido de Shopify que Kapta tiene también se encuentra", async () => {
    setup({
      orders: [order({ id: "ord-s", name: "#KP143817", platform: "shopify", payment_gateway: "cod", shipping_mode: "cod" })],
      masters: [master({ order_id: "ord-s", order_name: "#KP143817" })],
    });
    const res = await call(consulta({ order_name: "KP143817" }));
    expect(res.status).toBe(200);
    expect((res.body as typeof FOUND).order).toMatchObject({ name: "#KP143817", platform: "shopify", delivery: { mode: "contraentrega" } });
  });

  it("dos pedidos con el mismo número y el mismo celular (no debería pasar): el más reciente", async () => {
    setup({
      orders: [order({ id: "viejo", created_at: "2026-10-01T10:00:00Z", total_amount: 100 }), order({ id: "nuevo", total_amount: 200 })],
      masters: [],
    });
    expect(((await call()).body as typeof FOUND).order.total).toBe(200);
  });
});

describe("la privacidad: otro celular es lo mismo que no existir", () => {
  it("el mismo pedido consultado desde otro celular: EXACTAMENTE la respuesta de un número que no existe", async () => {
    setup();
    const ajeno = await call(consulta({ phone: OTHER_PHONE }));
    const inexistente = await call(consulta({ order_name: "KP999999" }));
    expect(ajeno).toEqual(NOT_FOUND);
    expect(inexistente).toEqual(NOT_FOUND);
    expect(ajeno).toEqual(inexistente);
    // Nada del pedido en la respuesta.
    const json = JSON.stringify(ajeno.body);
    for (const absent of ["599", "Ejemplo", "Surco", "Zapatilla", "woocommerce", "2026-10-24", "por_confirmar"]) {
      expect(json, absent).not.toContain(absent);
    }
  });

  it("el pedido se busca por número Y celular en la MISMA consulta: nunca se lee el de otro celular", async () => {
    setup();
    await call(consulta({ phone: OTHER_PHONE }));
    const reads = h.db.opsOn("orders", "select");
    expect(reads).toHaveLength(1);
    expect(reads[0]!.filters).toEqual(
      expect.arrayContaining([
        ["eq", "store_id", STORE],
        ["eq", "name", "#KP200001"],
        ["in", "customer_phone", [OTHER_PHONE, "988805509"]],
      ]),
    );
    // Sin pedido, ni siquiera se mira el Master.
    expect(h.db.opsOn("order_master")).toHaveLength(0);
  });

  it("el celular de la guía (el Master) no cuenta: un pedido sin celular propio no se devuelve", async () => {
    setup({ orders: [order({ customer_phone: null })], masters: [master({ customer_phone: PHONE })] });
    expect(await call()).toEqual(NOT_FOUND);
  });

  it("aunque la base devolviera una fila de otro celular, se vuelve a comparar en memoria", async () => {
    setup({ orders: [order({ customer_phone: OTHER_PHONE })] });
    // Una base que ignora el filtro del celular (no debería pasar): la fila ajena no sale.
    const realFrom = h.db.from.bind(h.db);
    h.db.from = ((table: string) => {
      const q = realFrom(table);
      if (table !== "orders") return q;
      const realIn = q.in.bind(q);
      q.in = ((col: string, vals: unknown[]) => (col === "customer_phone" ? q : realIn(col, vals as never[]))) as typeof q.in;
      return q;
    }) as typeof h.db.from;
    expect(await call()).toEqual(NOT_FOUND);
  });

  it("el pedido de otra tienda con el mismo número y el mismo celular no sale", async () => {
    setup({ orders: [order({ store_id: OTHER_STORE })], masters: [master({ store_id: OTHER_STORE })] });
    expect(await call()).toEqual(NOT_FOUND);
  });
});

describe("no encontrado: el pedido puede no haber llegado todavía", () => {
  it("404 not_found, reintentable UNA vez a los 10 s; cuando llega, la segunda consulta lo encuentra", async () => {
    setup({ orders: [], masters: [] });
    const first = await call();
    expect(first).toEqual(NOT_FOUND);
    // El webhook de WooCommerce lo trae unos segundos después.
    t += BOT_ORDER_LOOKUP_RETRY_AFTER_S * 1000;
    h.db.rows("orders").push(order());
    const second = await call();
    expect(second.status).toBe(200);
    // Todavía sin fila del Master: la dirección del pedido y `master: null`.
    expect((second.body as typeof FOUND).order).toMatchObject({
      master: null,
      delivery: { district: "Santiago de Surco", address1: "Av. Ejemplo 123" },
      payment: "contraentrega",
    });
  });

  it("la lectura del pedido falla o no contesta: 503 store_unavailable, reintentable", async () => {
    setup();
    h.db.failOn = (table) => (table === "orders" ? { message: "boom" } : null);
    expect((await call()).body).toMatchObject({ ok: false, code: "store_unavailable", retryable: true, retry_after_seconds: 10 });

    setup();
    h.db.hangOn = (table) => table === "orders";
    const res = await call(consulta(), `Bearer ${SECRET}`, { dbTimeoutMs: 20 });
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ code: "store_unavailable", retryable: true });
  });

  it("la fila del Master falla o no contesta: el pedido sale igual, con `master: null` y su propia dirección", async () => {
    for (const mode of ["fail", "hang"] as const) {
      setup();
      if (mode === "fail") h.db.failOn = (table) => (table === "order_master" ? { message: "boom" } : null);
      else h.db.hangOn = (table) => table === "order_master";
      const res = await call(consulta(), `Bearer ${SECRET}`, { dbTimeoutMs: 20 });
      expect(res.status, mode).toBe(200);
      expect((res.body as typeof FOUND).order, mode).toMatchObject({
        name: "#KP200001",
        total: 599.6,
        master: null,
        delivery: { district: "Santiago de Surco", address1: "Av. Ejemplo 123" },
      });
    }
  });
});

describe("cómo se paga, anulado y la entrega: derivados de lo que Kapta guarda", () => {
  it("botLookupPayment: pagado, contraentrega, o no se sabe", () => {
    const base = { financialStatus: "pending", paymentGateway: "cod", totalRefunded: 0, paymentState: null };
    expect(botLookupPayment(base)).toBe("contraentrega");
    expect(botLookupPayment({ ...base, paymentState: "sin_pago" })).toBe("contraentrega");
    // Pagado en el checkout confirmado (Flow «Tarjeta o Yape»).
    expect(botLookupPayment({ ...base, financialStatus: "paid", paymentGateway: "checkout" })).toBe("pagado");
    // Con un reembolso ya no está pagado; y sin la pasarela confirmada, no se sabe.
    expect(botLookupPayment({ ...base, financialStatus: "paid", paymentGateway: "checkout", totalRefunded: 10 })).toBeNull();
    expect(botLookupPayment({ ...base, financialStatus: "paid", paymentGateway: null })).toBeNull();
    expect(botLookupPayment({ ...base, financialStatus: "paid", paymentGateway: "manual" })).toBeNull();
    // Las constancias cubren el total: pagado.
    expect(botLookupPayment({ ...base, paymentState: "pago_completo" })).toBe("pagado");
    // Un pago a medias: el monto lo dice una asesora.
    for (const paymentState of ["adelanto_cargado", "adelanto_validado", "diferencia_cargada", "pago_total_cargado", "posible_duplicado"]) {
      expect(botLookupPayment({ ...base, paymentState }), paymentState).toBeNull();
    }
    // Otra pasarela, o ninguna (transferencia, wp-admin «N/D»): no se sabe.
    expect(botLookupPayment({ ...base, paymentGateway: null })).toBeNull();
  });

  it("de punta a punta: pagado en la web, y agencia", async () => {
    setup({ orders: [order({ financial_status: "paid", payment_gateway: "checkout", shipping_mode: "agency" })] });
    const o = ((await call()).body as typeof FOUND).order;
    expect(o.payment).toBe("pagado");
    expect(o.delivery.mode).toBe("agencia");
  });

  it("anulado en la tienda (`cancelled_at`) o en Kapta (estado general «Anulado»)", async () => {
    setup({
      orders: [order({ cancelled_at: "2026-10-24T22:00:00Z", financial_status: "voided" })],
      masters: [master({ general_status: "anulado", macro_stage: "finalizado", macro_substage: "anulado_cerrado" })],
    });
    const o = ((await call()).body as typeof FOUND).order;
    expect(o.cancelled).toBe(true);
    expect(o.master).toEqual({ stage: "finalizado", stage_label: "Finalizado", substage: "anulado_cerrado", substage_label: "Anulado y cerrado" });

    setup({ masters: [master({ general_status: "anulado" })] });
    expect(((await call()).body as typeof FOUND).order.cancelled).toBe(true);
  });

  it("los productos: sin precios, sin líneas sin unidades ni sin título", () => {
    expect(
      botLookupItems([
        { title: "EggMixer", variant_title: "", quantity: 1, price: 89 },
        { title: "Quitado", quantity: 0, price: 10 },
        { title: "  ", quantity: 1 },
        { title: "Papel", variant_title: " Pack x 50 ", quantity: "2" },
        null,
        "basura",
      ]),
    ).toEqual([
      { title: "EggMixer", variant: null, quantity: 1 },
      { title: "Papel", variant: "Pack x 50", quantity: 2 },
    ]);
    expect(botLookupItems(null)).toEqual([]);
  });
});

describe("los celulares", () => {
  it("normalizeLookupPhone: cualquier forma de un número; uno extranjero también (8 a 15 dígitos)", () => {
    expect(normalizeLookupPhone("999000111")).toBe(PHONE);
    expect(normalizeLookupPhone("+51 999-000-111")).toBe(PHONE);
    expect(normalizeLookupPhone("+58 412 1234567")).toBe("584121234567");
    for (const raw of ["", "12", "abc", "1".repeat(16), null, 51999000111]) expect(normalizeLookupPhone(raw)).toBeNull();
  });

  it("lookupPhoneVariants y sameLookupPhone", () => {
    expect(lookupPhoneVariants(PHONE)).toEqual([PHONE, "999000111"]);
    expect(lookupPhoneVariants("584121234567")).toEqual(["584121234567"]);
    expect(sameLookupPhone("999000111", "+51 999 000 111")).toBe(true);
    expect(sameLookupPhone(PHONE, OTHER_PHONE)).toBe(false);
    expect(sameLookupPhone(null, PHONE)).toBe(false);
    expect(sameLookupPhone("", "")).toBe(false);
  });
});

describe("el registro: una línea por llamada, sin el celular ni la dirección", () => {
  it("tienda, el número consultado, el resultado, el código y los ms", async () => {
    setup();
    await call();
    await call(consulta({ phone: OTHER_PHONE }));
    await call(consulta({ phone: "12" }));
    await call(consulta(), "Bearer otro");
    expect(logs).toHaveLength(4);
    for (const { line } of logs) {
      expect(line.startsWith("[bot-orders-lookup] {")).toBe(true);
      for (const pii of [PHONE, "999000111", OTHER_PHONE, "988805509", "María", "Ejemplo", "Surco", SECRET]) expect(line).not.toContain(pii);
    }
    const parse = (i: number) => JSON.parse(logs[i]!.line.replace("[bot-orders-lookup] ", ""));
    expect(parse(0)).toEqual({ store: STORE, order: "#KP200001", outcome: "ok", status: 200, ms: 0, platform: "woocommerce" });
    expect(logs[0]!.level).toBe("info");
    expect(parse(1)).toEqual({ store: STORE, order: "#KP200001", outcome: "not_found", status: 404, ms: 0 });
    expect(logs[1]!.level).toBe("info");
    expect(parse(2)).toMatchObject({ outcome: "invalid_body", status: 400 });
    expect(logs[2]!.level).toBe("warn");
    expect(parse(3)).toEqual({ store: STORE, outcome: "unauthorized", status: 401, ms: 0 });
  });
});

describe("la ruta", () => {
  const url = `https://kapta.app/api/internal/orders/${STORE}/lookup`;
  const params = { params: Promise.resolve({ storeId: STORE }) };

  it("POST con Bearer: el JSON y el código de handleBotOrderLookup, sin caché", async () => {
    setup();
    vi.spyOn(console, "info").mockImplementation(() => {});
    const res = await POST(
      new NextRequest(url, {
        method: "POST",
        headers: { authorization: `Bearer ${SECRET}`, "content-type": "application/json" },
        body: JSON.stringify(consulta({ order_name: "#kp200001" })),
      }),
      params,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("retry-after")).toBeNull();
    expect(await res.json()).toEqual(FOUND);
  });

  it("404 con Retry-After de 10 s; 401 con WWW-Authenticate; un Content-Length de más es 413 sin tocar la base", async () => {
    setup();
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const missing = await POST(
      new NextRequest(url, { method: "POST", headers: { authorization: `Bearer ${SECRET}` }, body: JSON.stringify(consulta({ phone: OTHER_PHONE })) }),
      params,
    );
    expect(missing.status).toBe(404);
    expect(missing.headers.get("retry-after")).toBe(String(BOT_ORDER_LOOKUP_RETRY_AFTER_S));
    expect(await missing.json()).toEqual(NOT_FOUND.body);

    const unauth = await POST(new NextRequest(url, { method: "POST", body: "{}" }), params);
    expect(unauth.status).toBe(401);
    expect(unauth.headers.get("www-authenticate")).toContain("Bearer");

    setup();
    const big = await POST(
      new NextRequest(url, { method: "POST", headers: { "content-length": "999999", "content-type": "application/json" }, body: "{}" }),
      params,
    );
    expect(big.status).toBe(413);
    expect(h.db.ops).toHaveLength(0);
  });

  it("la dirección es la de crear + /lookup", () => {
    expect(botOrderLookupUrl("https://kapta.app/", STORE)).toBe(`https://kapta.app/api/internal/orders/${STORE}/lookup`);
  });
});
