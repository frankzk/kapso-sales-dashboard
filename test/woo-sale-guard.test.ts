// El candado de «Generar pedido» en WooCommerce (MOM §38.12, «El candado del
// formulario», 25-10-2026): el mismo del bot (`bot_order_requests`, 0277), con
// la llave `form-<id del intento>`. Las decisiones, sobre la base falsa; de
// punta a punta (timeout del POST, WordPress que guarda tarde, doble clic) en
// test/woocommerce-generate-order.test.ts.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BOT_ORDER_CLAIM_TTL_MS, BOT_ORDER_RETAKE_MAX_AGE_MS, WOO_FORM_GUARD_PREFIX } from "@/lib/bot-orders";
import { WOO_SALE_BUDGET_MS } from "@/lib/woocommerce-orders";
import {
  WOO_FORM_DB_ERROR_TEXT,
  WOO_FORM_EXPIRED_TEXT,
  claimWooFormSale,
  finishWooFormClaim,
  noteWooFormOrder,
  rearmWooFormClaim,
  releaseWooFormClaim,
  wooFormBusyText,
  wooFormGuardKey,
  wooFormPostUnansweredText,
  wooFormRetryAfter,
} from "@/lib/woo-sale-guard";
import { FakeDb } from "./woocommerce-fake-db";

const STORE = "11111111-1111-4111-8111-111111111111";
const REQ = "5d1c2f7e-0b1a-4c3d-9e8f-123456789abc";
const KEY = `form-${REQ}`;
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const T0 = Date.parse("2026-10-25T15:00:00Z");

let db: FakeDb;
let t = T0;
const now = () => t;
const claim = (bodyHash = HASH_A) => claimWooFormSale({ admin: db.client(), storeId: STORE, requestId: REQ, bodyHash, now, log: () => {} });
const row = () => db.rows("bot_order_requests").find((r) => r.request_id === KEY)!;

beforeEach(() => {
  db = new FakeDb();
  t = T0;
});
afterEach(() => vi.restoreAllMocks());

describe("la llave", () => {
  it("`form-<id>`, y con el sha256 si no cabe en los 64 de la 0277", () => {
    expect(WOO_FORM_GUARD_PREFIX).toBe("form-");
    expect(wooFormGuardKey(REQ)).toBe(KEY);
    const largo = "x".repeat(64);
    const k = wooFormGuardKey(largo);
    expect(k).toMatch(/^form-[0-9a-f]{59}$/);
    expect(k).toHaveLength(64);
    expect(wooFormGuardKey(largo)).toBe(k);
  });
});

describe("tomar el candado", () => {
  it("sin fila: inserta processing con la huella y un token", async () => {
    const r = await claim();
    expect(r.kind).toBe("claim");
    expect(row()).toMatchObject({ store_id: STORE, request_id: KEY, body_hash: HASH_A, status: "processing", attempts: 1 });
  });

  it("processing dentro del plazo: busy, con lo que le falta, sin tocar la fila", async () => {
    await claim();
    t += 30_000;
    const r = await claim();
    expect(r).toEqual({ kind: "busy", retryAfterSeconds: 90, message: wooFormBusyText(90) });
    expect(row().attempts).toBe(1);
  });

  it("failed, done o processing vencido: se retoma con un token nuevo, la huella de ahora y el pedido anotado", async () => {
    const first = await claim();
    if (first.kind !== "claim") throw new Error(first.kind);
    await noteWooFormOrder(db.client(), first.claim, 501);
    await releaseWooFormClaim(db.client(), first.claim, "price_mismatch", now);
    expect(row()).toMatchObject({ status: "failed", error_code: "price_mismatch", woo_order_id: 501 });

    const again = await claim(HASH_B);
    if (again.kind !== "claim") throw new Error(again.kind);
    expect(again.claim).toMatchObject({ attempts: 2, wooOrderId: 501 });
    expect(again.claim.token).not.toBe(first.claim.token);
    expect(row()).toMatchObject({ status: "processing", body_hash: HASH_B, error_code: null, finished_at: null });

    await finishWooFormClaim(db.client(), again.claim, { wooOrderId: 501, orderId: "wc-aur-501", orderName: "#AUR900501", total: 89, currency: "PEN" }, now);
    expect(row()).toMatchObject({ status: "done", order_id: "wc-aur-501", order_name: "#AUR900501", order_total: 89 });
    const third = await claim(HASH_B);
    expect(third.kind === "claim" && third.claim.wooOrderId).toBe(501);

    // Vencido: el plazo del bot.
    if (third.kind !== "claim") throw new Error(third.kind);
    t += BOT_ORDER_CLAIM_TTL_MS - 1;
    expect((await claim(HASH_B)).kind).toBe("busy");
    t += 2;
    expect((await claim(HASH_B)).kind).toBe("claim");
  });

  it("quien llega con el token viejo pierde: escribir con él no toca la fila", async () => {
    const first = await claim();
    if (first.kind !== "claim") throw new Error(first.kind);
    t += BOT_ORDER_CLAIM_TTL_MS + 1;
    const second = await claim();
    if (second.kind !== "claim") throw new Error(second.kind);
    await releaseWooFormClaim(db.client(), first.claim, "conflict", now);
    expect(row().status).toBe("processing");
  });

  it("un POST sin respuesta re-arma el candado desde ahora", async () => {
    const first = await claim();
    if (first.kind !== "claim") throw new Error(first.kind);
    t += 40_000;
    await rearmWooFormClaim(db.client(), first.claim, now);
    expect(row()).toMatchObject({ status: "processing", claimed_at: new Date(t).toISOString(), error_code: "woocommerce_unavailable" });
    t += 100_000;
    const r = await claim();
    expect(r.kind).toBe("busy");
    expect(r.kind === "busy" && r.retryAfterSeconds).toBe(20);
  });

  it("sin woo_order_id y empezado hace más de 90 min: expired; con woo_order_id se retoma a cualquier edad", async () => {
    await claim();
    t += BOT_ORDER_RETAKE_MAX_AGE_MS + 1;
    expect(await claim()).toEqual({ kind: "expired", message: WOO_FORM_EXPIRED_TEXT });
    row().woo_order_id = 777;
    const r = await claim();
    expect(r.kind === "claim" && r.claim.wooOrderId).toBe(777);
  });

  it("dos retoman a la vez un processing vencido: solo gana quien todavía ve el token que leyó, el otro queda busy", async () => {
    const first = await claim();
    if (first.kind !== "claim") throw new Error(first.kind);
    await noteWooFormOrder(db.client(), first.claim, 501);
    t += BOT_ORDER_CLAIM_TTL_MS + 1;
    const events: { event: string; data: Record<string, unknown> }[] = [];
    const log = (event: string, data: Record<string, unknown>) => events.push({ event, data });
    const one = () => claimWooFormSale({ admin: db.client(), storeId: STORE, requestId: REQ, bodyHash: HASH_A, now, log });
    const [a, b] = await Promise.all([one(), one()]);
    expect([a.kind, b.kind].sort()).toEqual(["busy", "claim"]);
    expect(row().attempts).toBe(2);
    expect(events.filter((e) => e.event === "retaken")).toHaveLength(1);
    expect(events.find((e) => e.event === "busy")?.data).toMatchObject({ lost_retake: true });
  });

  it("dos a la vez: uno toma el candado, el otro choca con su fila (23505) y queda busy", async () => {
    const [a, b] = await Promise.all([claim(), claim()]);
    expect([a.kind, b.kind].sort()).toEqual(["busy", "claim"]);
    expect(db.rows("bot_order_requests")).toHaveLength(1);
  });

  it("la base falla o no contesta: error, sin candado; sin la 0277: unguarded", async () => {
    db.failOn = () => ({ message: "canceling statement due to statement timeout" });
    expect(await claim()).toEqual({ kind: "error", message: WOO_FORM_DB_ERROR_TEXT });
    db.failOn = () => ({ code: "42P01", message: 'relation "bot_order_requests" does not exist' });
    expect(await claim()).toEqual({ kind: "unguarded" });
    db.failOn = null;
    db.hangOn = () => true;
    const r = await claimWooFormSale({ admin: db.client(), storeId: STORE, requestId: REQ, bodyHash: HASH_A, now, dbTimeoutMs: 10, log: () => {} });
    expect(r).toEqual({ kind: "error", message: WOO_FORM_DB_ERROR_TEXT });
  });

  it("un código de error que la 0277 no acepta se guarda como `error`", async () => {
    const first = await claim();
    if (first.kind !== "claim") throw new Error(first.kind);
    await releaseWooFormClaim(db.client(), first.claim, "Algo-Raro", now);
    expect(row().error_code).toBe("error");
  });
});

describe("los textos y los plazos", () => {
  it("lo que le falta al candado, al menos 1 s", () => {
    expect(wooFormRetryAfter(T0, T0)).toBe(BOT_ORDER_CLAIM_TTL_MS / 1000);
    expect(wooFormRetryAfter(T0, T0 + BOT_ORDER_CLAIM_TTL_MS + 5_000)).toBe(1);
    expect(wooFormBusyText(90)).toContain("espera unos 2 minutos");
    expect(wooFormBusyText(20)).toContain("espera 20 s");
    expect(wooFormPostUnansweredText("No se pudo crear el pedido en WooCommerce: x")).toContain("espera 2 minutos y vuelve a pulsar «Generar pedido»");
  });

  it("del candado a su cierre cabe la venta entera con los topes de la base, dentro del plazo", () => {
    expect(WOO_SALE_BUDGET_MS + 3 * 5_000).toBeLessThan(BOT_ORDER_CLAIM_TTL_MS);
  });

  it("el MOM lo cuenta con los nombres del código", () => {
    const flat = readFileSync(resolve(process.cwd(), "docs/mom/master-pedidos-v1.md"), "utf8").replace(/\s+/g, " ");
    expect(flat).toContain("**El candado del formulario (25-10-2026).** Cuando una tienda pasa a crear sus pedidos en WooCommerce");
    // El estado de las tiendas no se afirma aquí: Aurela y Kenku pasan en el corte del 27-10.
    expect(flat).not.toContain("Desde el domingo 25-10 las asesoras de Aurela crean sus pedidos en WooCommerce");
    // El candado se cierra con la venta registrada, no antes de la fila local.
    expect(flat).toContain("(`done`, con el número, el total y la moneda: `finishWooFormClaim`) **recién cuando la venta quedó registrada**");
    expect(flat).toContain("`onSaleRecorded`, antes de la confirmación por WhatsApp");
    expect(flat).toContain("`form-<id del intento>` (`wooFormGuardKey`");
    expect(flat).toContain("**Un POST sin respuesta en «Generar pedido»:** **hecho (25-10-2026)**");
    expect(flat).not.toContain("El bot ya espera (38.13); el formulario todavía no.");
    expect(flat).toContain("**La tabla la comparte «Generar pedido» (25-10-2026).**");
    expect(flat).toContain(`menos que su plazo de ${BOT_ORDER_CLAIM_TTL_MS / 1000} s`);
    expect(flat).toContain(`empezado hace más de ${BOT_ORDER_RETAKE_MAX_AGE_MS / 60_000} min`);
  });
});
