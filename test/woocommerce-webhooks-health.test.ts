// La revisión de los webhooks de WooCommerce (MOM §38.14, 25-10-2026).
//
// WooCommerce desactiva un webhook tras 5 fallos seguidos y no avisa. Lo que se
// fija: cada tema de pedido necesita uno «Activo» que entregue a ESTA tienda
// (la ruta, no el host); la lectura es solo `GET /wp-json/wc/v3/webhooks` con
// los topes de siempre; de la respuesta solo sale el estado de cada tema (ni
// direcciones ni secretos); el resultado queda en `sync_state` (`woo_webhooks`)
// y en `woo_last_error` con su prefijo, que solo borra una revisión buena; el
// cron corre cada hora en el minuto 34 con CRON_SECRET; y el MOM dice lo mismo
// que el código. Sin red: `fetch` es falso.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeDb, type Row } from "./woocommerce-fake-db";

const h = vi.hoisted(() => {
  process.env.ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
  return { db: null as unknown as import("./woocommerce-fake-db").FakeDb };
});

vi.mock("@/lib/db", () => ({ createAdminSupabase: () => h.db.client() }));

import { encrypt } from "@/lib/crypto";
import { WOO_TIMEOUT_MS } from "@/lib/woocommerce";
import { WOO_INTAKE_TOPICS, WOO_SYNC_SOURCE } from "@/lib/woocommerce-intake";
import {
  WOO_WEBHOOKS_BUDGET_MS,
  WOO_WEBHOOKS_ERROR_PREFIX,
  WOO_WEBHOOKS_MAX_PAGES,
  WOO_WEBHOOKS_PATH,
  WOO_WEBHOOKS_PER_PAGE,
  WOO_WEBHOOKS_SOURCE,
  WOO_WEBHOOKS_TRANSIENT_ERRORS,
  checkWooWebhooks,
  evaluateWooWebhooks,
  recordWooWebhooksCheck,
  runWooWebhooksChecks,
  summarizeWooWebhooks,
  wooWebhookKaptaStore,
  wooWebhooksLastError,
  wooWebhooksNotice,
  type WooWebhooksCheck,
} from "@/lib/woocommerce-webhooks-health";

const route = await import("@/app/api/cron/woo-webhooks/route");

const STORE_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_STORE = "22222222-2222-4222-8222-222222222222";
const SHOPIFY_ONLY = "33333333-3333-4333-8333-333333333333";
const CK = "ck_0123456789abcdef0123456789abcdef01234567";
const CS = "cs_0123456789abcdef0123456789abcdef01234567";
const KAPTA = "https://kapta.example";
const SITE = "https://aurela.pe";

const deliveryUrl = (storeId = STORE_ID, host = KAPTA) => `${host}/api/webhooks/woocommerce/${storeId}`;

/** Un webhook como lo devuelve `GET /wp-json/wc/v3/webhooks`, con un secreto de más por si alguna versión lo mandara. */
function hook(id: number, topic: string, status = "active", url = deliveryUrl()): Row {
  const [resource, event] = topic.split(".");
  return {
    id,
    name: `Kapta ${topic} (pedido de Ana, 987654321)`,
    status,
    topic,
    resource,
    event,
    hooks: [`woocommerce_${event}_order`],
    delivery_url: url,
    secret: "secreto-del-webhook-que-no-debe-salir",
    date_created_gmt: "2026-10-24T17:30:00",
    date_modified_gmt: "2026-10-24T17:30:00",
  };
}

const healthy = () => WOO_INTAKE_TOPICS.map((t, i) => hook(i + 1, t));

interface Call {
  url: URL;
  method: string;
  auth: string | null;
}

/** Un WooCommerce falso que pagina la lista de webhooks con X-WP-Total y X-WP-TotalPages. */
function fakeWoo(list: Row[], opts: { stripAuth?: boolean; respond?: (url: URL) => Response | Promise<Response> } = {}) {
  const calls: Call[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ url, method: init?.method ?? "GET", auth: new Headers(init?.headers).get("authorization") });
    if (opts.respond) return opts.respond(url);
    if (opts.stripAuth && !url.searchParams.get("consumer_key")) {
      return new Response(JSON.stringify({ code: "woocommerce_rest_cannot_view", message: "Lo siento, no puedes listar los recursos." }), {
        status: 401,
      });
    }
    const perPage = Number(url.searchParams.get("per_page") ?? 10);
    const page = Number(url.searchParams.get("page") ?? 1);
    const items = list.slice((page - 1) * perPage, page * perPage);
    return new Response(JSON.stringify(items), {
      status: 200,
      headers: { "X-WP-Total": String(list.length), "X-WP-TotalPages": String(Math.max(1, Math.ceil(list.length / perPage))) },
    });
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
}

const client = (fetchImpl: typeof fetch) => ({ siteUrl: SITE, consumerKey: CK, consumerSecret: CS, fetchImpl });

function storeRow(over: Row = {}): Row {
  return {
    id: STORE_ID,
    org_id: "org-1",
    name: "Aurela",
    status: "active",
    timezone: "America/Lima",
    platform: "shopify",
    woo_site_url: SITE,
    woo_site_key: "aur",
    woo_consumer_key_enc: encrypt(CK),
    woo_consumer_secret_enc: encrypt(CS),
    woo_webhook_secret_enc: encrypt("3f9a1c0d5e7b2a4c6d8e0f1a3b5c7d9e"),
    woo_last_error: null,
    woo_intake_from: "2026-10-24T17:24:54.000Z",
    shopify_token_enc: "token-cifrado-de-shopify",
    ...over,
  };
}

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

// ── La dirección de entrega ─────────────────────────────────────────────────

describe("wooWebhookKaptaStore: la tienda va en la ruta", () => {
  it("la ruta del webhook de Kapta, con cualquier host y con o sin barra final", () => {
    expect(wooWebhookKaptaStore(deliveryUrl())).toBe(STORE_ID);
    expect(wooWebhookKaptaStore(`${deliveryUrl()}/`)).toBe(STORE_ID);
    expect(wooWebhookKaptaStore(deliveryUrl(STORE_ID.toUpperCase(), "https://kapso-sales-dashboard.vercel.app"))).toBe(STORE_ID);
    expect(wooWebhookKaptaStore(deliveryUrl(OTHER_STORE))).toBe(OTHER_STORE);
  });

  it("cualquier otra cosa no es de Kapta", () => {
    for (const url of [
      "https://hook.us1.make.com/abc123",
      `${KAPTA}/api/webhooks/shopify/${STORE_ID}`,
      `${KAPTA}/api/webhooks/woocommerce/no-es-un-uuid`,
      `${KAPTA}/api/webhooks/woocommerce/${STORE_ID}/otra-cosa`,
      "no es una dirección",
      "",
      null,
      42,
    ]) {
      expect(wooWebhookKaptaStore(url), String(url)).toBeNull();
    }
  });

  it("de cada webhook solo quedan id, estado, tema y la tienda: ni la dirección, ni el nombre, ni el secreto", () => {
    const out = summarizeWooWebhooks([hook(7, "Order.Created", "Active"), null, "x", [1]]);
    expect(out).toEqual([{ id: 7, status: "active", topic: "order.created", kaptaStoreId: STORE_ID }]);
    const text = JSON.stringify(out);
    for (const leak of ["kapta.example", "secreto-del-webhook", "Ana", "987654321", "/api/webhooks"]) expect(text).not.toContain(leak);
  });
});

// ── Cada tema ───────────────────────────────────────────────────────────────

describe("evaluateWooWebhooks: cada tema necesita uno activo que entregue a esta tienda", () => {
  const evaluate = (list: Row[]) => evaluateWooWebhooks(summarizeWooWebhooks(list), STORE_ID);

  it("los cuatro activos: bien, sin texto", () => {
    expect(evaluate(healthy())).toEqual({
      ok: true,
      topics: { "order.created": "ok", "order.updated": "ok", "order.deleted": "ok", "order.restored": "ok" },
      problem: null,
    });
  });

  it("uno desactivado (WooCommerce lo apaga tras 5 fallos): lo dice, con qué revisar", () => {
    const list = healthy().map((w) => (w.topic === "order.created" ? { ...w, status: "disabled" } : w));
    const v = evaluate(list);
    expect(v.ok).toBe(false);
    expect(v.topics["order.created"]).toBe("desactivado");
    expect(v.topics["order.updated"]).toBe("ok");
    expect(v.problem).toMatch(/^order\.created está desactivado\. /);
    expect(v.problem).toContain("5 fallos seguidos");
    expect(v.problem).toContain("la dirección y el secreto de esta tienda");
    expect(v.problem).toContain("los pedidos llegan por la sincronización");
  });

  it("en pausa, en otro estado, a otra tienda de Kapta, o que falta", () => {
    const list = [
      hook(1, "order.created", "paused"),
      hook(2, "order.updated", "pending"),
      hook(3, "order.deleted", "active", deliveryUrl(OTHER_STORE)),
      // order.restored: ninguno.
    ];
    const v = evaluate(list);
    expect(v.topics).toEqual({
      "order.created": "en_pausa",
      "order.updated": "inactivo",
      "order.deleted": "otra_tienda",
      "order.restored": "falta",
    });
    expect(v.problem).toMatch(
      /^order\.created está en pausa, order\.updated no está activo, order\.deleted entrega a otra tienda de Kapta, falta order\.restored\. /,
    );
    // Sin desactivados, no habla de los 5 fallos.
    expect(v.problem).not.toContain("5 fallos");
  });

  it("uno activo cubre el tema aunque haya otros viejos desactivados del mismo tema", () => {
    const list = [...healthy(), hook(9, "order.created", "disabled"), hook(10, "order.updated", "disabled", deliveryUrl(OTHER_STORE))];
    expect(evaluate(list).ok).toBe(true);
  });

  it("el host no se compara: Kapta contesta en más de una dirección", () => {
    const list = healthy().map((w, i) => ({ ...w, delivery_url: deliveryUrl(STORE_ID, i % 2 ? "https://kapso-sales-dashboard.vercel.app" : KAPTA) }));
    expect(evaluate(list).ok).toBe(true);
  });

  it("los webhooks de otros servicios y de otros temas no cuentan", () => {
    const list = [
      ...WOO_INTAKE_TOPICS.map((t, i) => hook(20 + i, t, "active", "https://hook.us1.make.com/abc")),
      hook(30, "product.updated"),
      hook(31, "action.woocommerce_new_order"),
    ];
    const v = evaluate(list);
    expect(Object.values(v.topics)).toEqual(["falta", "falta", "falta", "falta"]);
  });

  it("el peor texto cabe en woo_last_error (500 caracteres) con su prefijo", () => {
    const worst = WOO_INTAKE_TOPICS.map((t, i) => hook(i + 1, t, "disabled", deliveryUrl(i % 2 ? STORE_ID : OTHER_STORE)));
    worst[0] = hook(1, "order.created", "pending");
    const v = evaluate(worst);
    expect(`${WOO_WEBHOOKS_ERROR_PREFIX}${v.problem}`.length).toBeLessThanOrEqual(500);
    const all = evaluate([]);
    expect(`${WOO_WEBHOOKS_ERROR_PREFIX}${all.problem}`.length).toBeLessThanOrEqual(500);
  });
});

// ── La lectura ──────────────────────────────────────────────────────────────

describe("checkWooWebhooks: solo GET /webhooks, con los topes de siempre", () => {
  it("una página de 100, con Basic auth, y nada más que GET", async () => {
    const woo = fakeWoo(healthy());
    const r = await checkWooWebhooks(client(woo.fetchImpl), STORE_ID);
    expect(r).toMatchObject({ status: "ok", message: null, errorKind: null, webhooks: 4, pages: 1, auth: "basic" });
    expect(woo.calls).toHaveLength(1);
    const call = woo.calls[0]!;
    expect(call.method).toBe("GET");
    expect(`${call.url.origin}${call.url.pathname}`).toBe(`${SITE}/wp-json/wc/v3${WOO_WEBHOOKS_PATH}`);
    expect(call.url.searchParams.get("per_page")).toBe(String(WOO_WEBHOOKS_PER_PAGE));
    expect(call.url.searchParams.get("page")).toBe("1");
    expect(call.auth).toBe(`Basic ${Buffer.from(`${CK}:${CS}`).toString("base64")}`);
  });

  it("los topes: 100 por página, 2 páginas, 30 s por tienda y 15 s por llamada", () => {
    expect(WOO_WEBHOOKS_PER_PAGE).toBe(100);
    expect(WOO_WEBHOOKS_MAX_PAGES).toBe(2);
    expect(WOO_WEBHOOKS_BUDGET_MS).toBe(30_000);
    expect(WOO_TIMEOUT_MS).toBe(15_000);
    // La peor tienda: la última página empieza al borde del reloj y corta a los 15 s.
    expect(WOO_WEBHOOKS_BUDGET_MS + WOO_TIMEOUT_MS).toBeLessThan(route.maxDuration * 1000);
  });

  it("pagina hasta la última; los de esta tienda pueden estar en la segunda", async () => {
    const others = Array.from({ length: 100 }, (_, i) => hook(100 + i, "product.updated", "active", "https://otro.example/hook"));
    const woo = fakeWoo([...others, ...healthy()]);
    const r = await checkWooWebhooks(client(woo.fetchImpl), STORE_ID);
    expect(r).toMatchObject({ status: "ok", webhooks: 104, pages: 2 });
    expect(woo.calls.map((c) => c.url.searchParams.get("page"))).toEqual(["1", "2"]);
    expect(woo.calls.every((c) => c.method === "GET")).toBe(true);
  });

  it("con más de 2 páginas, si no encontró todo, no dice «falta»: dice que no alcanzó", async () => {
    const others = Array.from({ length: 200 }, (_, i) => hook(100 + i, "product.updated", "active", "https://otro.example/hook"));
    const woo = fakeWoo([...others, ...healthy()]);
    const r = await checkWooWebhooks(client(woo.fetchImpl), STORE_ID);
    expect(r.status).toBe("error");
    expect(r.message).toContain("no alcanzó a leerlos todos");
    expect(woo.calls).toHaveLength(2);
    // Si lo de esta tienda estaba en lo leído, igual está bien.
    const first = fakeWoo([...healthy(), ...others]);
    expect((await checkWooWebhooks(client(first.fetchImpl), STORE_ID)).status).toBe("ok");
  });

  it("pasado el reloj no pide otra página", async () => {
    const others = Array.from({ length: 100 }, (_, i) => hook(100 + i, "product.updated", "active", "https://otro.example/hook"));
    const woo = fakeWoo([...others, ...healthy()]);
    let t = 0;
    const r = await checkWooWebhooks(client(woo.fetchImpl), STORE_ID, { now: () => (t += WOO_WEBHOOKS_BUDGET_MS) });
    expect(woo.calls).toHaveLength(1);
    expect(r.status).toBe("error");
  });

  it("si la página siguiente falla pero lo leído ya tiene los cuatro bien, es «bien»; si no, no se pudo revisar", async () => {
    const others = Array.from({ length: 100 }, (_, i) => hook(100 + i, "product.updated", "active", "https://otro.example/hook"));
    const failSecond = (list: Row[]) =>
      fakeWoo(list, {
        respond: (url) => {
          if (url.searchParams.get("page") === "2") return new Response("{}", { status: 502 });
          return new Response(JSON.stringify(list.slice(0, 100)), { status: 200 });
        },
      });
    const first = failSecond([...healthy(), ...others]);
    const ok = await checkWooWebhooks(client(first.fetchImpl), STORE_ID);
    expect(ok).toMatchObject({ status: "ok", message: null, errorKind: null, pages: 1 });
    expect(first.calls).toHaveLength(2);

    const second = failSecond([...others, ...healthy()]);
    const r = await checkWooWebhooks(client(second.fetchImpl), STORE_ID);
    expect(r).toMatchObject({ status: "error", errorKind: "servidor", topics: null });
    expect(r.message).toMatch(/^no se pudieron revisar: WooCommerce falló \(HTTP 502\)/);
  });

  it("el hosting que borra la cabecera Authorization: una vez más con las claves en la dirección", async () => {
    const woo = fakeWoo(healthy(), { stripAuth: true });
    const r = await checkWooWebhooks(client(woo.fetchImpl), STORE_ID);
    expect(r).toMatchObject({ status: "ok", auth: "query" });
    expect(woo.calls).toHaveLength(2);
    expect(woo.calls[1]!.url.searchParams.get("consumer_key")).toBe(CK);
    // El mensaje nunca lleva las claves.
    expect(JSON.stringify(r)).not.toContain(CK);
  });

  it("sin permiso para leer webhooks, o WooCommerce que no contesta: error, sin lanzar", async () => {
    const denied = fakeWoo([], {
      respond: () =>
        new Response(JSON.stringify({ code: "woocommerce_rest_cannot_view", message: "Lo siento, no puedes listar los recursos." }), {
          status: 403,
        }),
    });
    const r = await checkWooWebhooks(client(denied.fetchImpl), STORE_ID);
    expect(r).toMatchObject({ status: "error", errorKind: "permisos", topics: null });
    expect(r.message).toMatch(/^no se pudieron revisar: WooCommerce no dio permiso \(HTTP 403\)/);

    const slow = fakeWoo([], {
      respond: () => {
        const e = new Error("The operation was aborted due to timeout");
        e.name = "TimeoutError";
        throw e;
      },
    });
    const t = await checkWooWebhooks(client(slow.fetchImpl), STORE_ID);
    expect(t).toMatchObject({ status: "error", errorKind: "tiempo" });
    expect(t.message).toContain("no respondió a tiempo (15 s)");
  });

  it("lo que falta: warning con el texto", async () => {
    const woo = fakeWoo(healthy().filter((w) => w.topic !== "order.restored"));
    const r = await checkWooWebhooks(client(woo.fetchImpl), STORE_ID);
    expect(r.status).toBe("warning");
    expect(r.topics!["order.restored"]).toBe("falta");
    expect(r.message).toMatch(/^falta order\.restored\. /);
  });
});

// ── Dónde queda ─────────────────────────────────────────────────────────────

describe("woo_last_error: su propio prefijo, que solo borra una revisión buena", () => {
  const ok: WooWebhooksCheck = { status: "ok", topics: null, message: null, errorKind: null, webhooks: 4, pages: 1, auth: "basic" };
  const warning: WooWebhooksCheck = { ...ok, status: "warning", message: "falta order.restored. …" };

  it("no choca con el del webhook ni con el de la pasada, que se limpian solos", () => {
    expect(WOO_WEBHOOKS_ERROR_PREFIX.startsWith("Webhook: ")).toBe(false);
    expect(WOO_WEBHOOKS_ERROR_PREFIX.startsWith("Sincronización: ")).toBe(false);
    expect(WOO_WEBHOOKS_ERROR_PREFIX.startsWith("Conexión: ")).toBe(false);
  });

  it("qué escribe cada resultado", () => {
    expect(wooWebhooksLastError(warning, null)).toBe(`${WOO_WEBHOOKS_ERROR_PREFIX}falta order.restored. …`);
    // Bien: borra solo su propio aviso.
    expect(wooWebhooksLastError(ok, `${WOO_WEBHOOKS_ERROR_PREFIX}falta order.restored.`)).toBeNull();
    expect(wooWebhooksLastError(ok, "Sincronización: WooCommerce falló (HTTP 500).")).toBeUndefined();
    expect(wooWebhooksLastError(ok, "Webhook: llegó un aviso firmado desde otro sitio.")).toBeUndefined();
    expect(wooWebhooksLastError(ok, null)).toBeUndefined();
    // WooCommerce caído, lento o pidiendo esperar: ya lo dice la pasada.
    expect([...WOO_WEBHOOKS_TRANSIENT_ERRORS].sort()).toEqual(["limite", "red", "servidor", "tiempo"]);
    for (const kind of WOO_WEBHOOKS_TRANSIENT_ERRORS) {
      expect(wooWebhooksLastError({ status: "error", message: "no se pudieron revisar: …", errorKind: kind }, "x"), kind).toBeUndefined();
    }
    // Sin permiso, la revisión está ciega: eso sí se dice.
    expect(wooWebhooksLastError({ status: "error", message: "no se pudieron revisar: sin permiso", errorKind: "permisos" }, null)).toBe(
      `${WOO_WEBHOOKS_ERROR_PREFIX}no se pudieron revisar: sin permiso`,
    );
  });

  it("deja la fila woo_webhooks en sync_state y el aviso en la tienda; bien, lo borra", async () => {
    h.db = new FakeDb({ stores: [storeRow()] });
    await recordWooWebhooksCheck(h.db.client(), STORE_ID, warning, null);
    const state = h.db.rows("sync_state").find((r) => r.source === WOO_WEBHOOKS_SOURCE);
    expect(state).toMatchObject({ store_id: STORE_ID, source: "woo_webhooks", status: "warning", error: warning.message });
    expect(Date.parse(state!.last_run_at)).not.toBeNaN();
    expect("cursor" in state!).toBe(false);
    expect(h.db.rows("stores")[0]!.woo_last_error).toBe(`${WOO_WEBHOOKS_ERROR_PREFIX}${warning.message}`);

    await recordWooWebhooksCheck(h.db.client(), STORE_ID, ok, h.db.rows("stores")[0]!.woo_last_error);
    expect(h.db.rows("sync_state")).toHaveLength(1);
    expect(h.db.rows("sync_state")[0]).toMatchObject({ status: "ok", error: null });
    expect(h.db.rows("stores")[0]!.woo_last_error).toBeNull();
  });

  it("una revisión buena no borra el fallo de la pasada; una caída no pisa nada", async () => {
    h.db = new FakeDb({ stores: [storeRow({ woo_last_error: "Sincronización: WooCommerce falló (HTTP 500)." })] });
    await recordWooWebhooksCheck(h.db.client(), STORE_ID, ok, "Sincronización: WooCommerce falló (HTTP 500).");
    expect(h.db.rows("stores")[0]!.woo_last_error).toBe("Sincronización: WooCommerce falló (HTTP 500).");
    await recordWooWebhooksCheck(
      h.db.client(),
      STORE_ID,
      { ...ok, status: "error", topics: null, message: "no se pudieron revisar: WooCommerce falló (HTTP 502).", errorKind: "servidor" },
      "Sincronización: WooCommerce falló (HTTP 500).",
    );
    expect(h.db.rows("stores")[0]!.woo_last_error).toBe("Sincronización: WooCommerce falló (HTTP 500).");
    expect(h.db.rows("sync_state").find((r) => r.source === WOO_WEBHOOKS_SOURCE)).toMatchObject({ status: "error" });
  });

  it("la línea de Ajustes", () => {
    expect(wooWebhooksNotice(ok)).toBe("Webhooks: los cuatro temas tienen uno activo que entrega a esta tienda.");
    expect(wooWebhooksNotice(warning)).toBe("Webhooks: falta order.restored. …");
    expect(wooWebhooksNotice({ status: "error", message: "no se pudieron revisar: sin permiso" })).toBe(
      "Los webhooks no se pudieron revisar: sin permiso",
    );
  });
});

// ── Todas las tiendas ───────────────────────────────────────────────────────

describe("runWooWebhooksChecks: solo las tiendas activas con WooCommerce conectado", () => {
  beforeEach(() => {
    h.db = new FakeDb({
      stores: [
        storeRow(),
        // Una tienda solo de Shopify, sin nada de WooCommerce.
        storeRow({
          id: SHOPIFY_ONLY,
          name: "Tienda solo de Shopify",
          woo_site_url: null,
          woo_site_key: null,
          woo_consumer_key_enc: null,
          woo_consumer_secret_enc: null,
          woo_webhook_secret_enc: null,
        }),
        // Con el sitio pero sin las claves de la API: tampoco hay a quién preguntar.
        storeRow({ id: OTHER_STORE, woo_site_url: "https://kenku.example", woo_site_key: "kp", woo_consumer_key_enc: null, woo_consumer_secret_enc: null }),
        // Deshabilitada: no se revisa (como la sincronización).
        storeRow({ id: "44444444-4444-4444-8444-444444444444", status: "disabled", woo_site_url: "https://vieja.example", woo_site_key: "vj" }),
      ],
    });
  });

  it("una tienda sin las claves no hace ni una llamada; la conectada sí, y queda registrada", async () => {
    const woo = fakeWoo(healthy().map((w) => (w.topic === "order.deleted" ? { ...w, status: "disabled" } : w)));
    const r = await runWooWebhooksChecks(h.db.client(), { fetchImpl: woo.fetchImpl });
    expect(woo.calls.every((c) => c.url.host === "aurela.pe")).toBe(true);
    expect(woo.calls).toHaveLength(1);
    expect(r.ok).toBe(false);
    const byId = Object.fromEntries(r.stores.map((s) => [s.storeId, s.status]));
    expect(byId).toEqual({ [STORE_ID]: "warning", [SHOPIFY_ONLY]: "skipped", [OTHER_STORE]: "skipped" });
    expect(r.stores.find((s) => s.storeId === STORE_ID)!.topics!["order.deleted"]).toBe("desactivado");

    const aurela = h.db.rows("stores").find((s) => s.id === STORE_ID)!;
    expect(aurela.woo_last_error).toMatch(/^Webhooks en WooCommerce: order\.deleted está desactivado\. /);
    // Lo demás de la tienda no se toca.
    expect(aurela.platform).toBe("shopify");
    expect(aurela.shopify_token_enc).toBe("token-cifrado-de-shopify");
    expect(h.db.rows("sync_state").map((x) => [x.store_id, x.source])).toEqual([[STORE_ID, "woo_webhooks"]]);
    // Las otras no reciben ni una escritura.
    expect(h.db.opsOn("stores", "update").every((o) => o.filters.some(([, c, v]) => c === "id" && v === STORE_ID))).toBe(true);
    // El reporte no lleva direcciones, claves ni secretos.
    const text = JSON.stringify(r);
    for (const leak of ["aurela.pe", "kapta.example", CK, CS, "secreto-del-webhook", "/api/webhooks"]) expect(text).not.toContain(leak);
  });

  it("?dry: revisa sin escribir nada", async () => {
    const woo = fakeWoo([]);
    const r = await runWooWebhooksChecks(h.db.client(), { fetchImpl: woo.fetchImpl, dry: true });
    expect(r.dry).toBe(true);
    expect(r.stores.find((s) => s.storeId === STORE_ID)!.status).toBe("warning");
    expect(h.db.opsOn("stores", "update")).toEqual([]);
    expect(h.db.opsOn("sync_state")).toEqual([]);
  });

  it("una sola tienda; un id que no es uuid no consulta nada", async () => {
    const woo = fakeWoo(healthy());
    const one = await runWooWebhooksChecks(h.db.client(), { fetchImpl: woo.fetchImpl, storeId: SHOPIFY_ONLY });
    expect(one.stores).toEqual([{ storeId: SHOPIFY_ONLY, status: "skipped" }]);
    expect(woo.calls).toEqual([]);
    const bad = await runWooWebhooksChecks(h.db.client(), { fetchImpl: woo.fetchImpl, storeId: "abc" });
    expect(bad).toMatchObject({ ok: false, error: "storeId inválido", stores: [] });
    expect(h.db.opsOn("stores", "select")).toHaveLength(1);
  });

  it("todo bien: ok, y la revisión no toca la fila de la pasada", async () => {
    h.db.rows("sync_state").push({ store_id: STORE_ID, source: WOO_SYNC_SOURCE, cursor: "2026-10-25T05:00:00.000Z", status: "ok" });
    const r = await runWooWebhooksChecks(h.db.client(), { fetchImpl: fakeWoo(healthy()).fetchImpl });
    expect(r.ok).toBe(true);
    expect(h.db.rows("sync_state").find((x) => x.source === WOO_SYNC_SOURCE)).toEqual({
      store_id: STORE_ID,
      source: WOO_SYNC_SOURCE,
      cursor: "2026-10-25T05:00:00.000Z",
      status: "ok",
    });
  });

  it("sin la 0274: nada que revisar", async () => {
    h.db.failOn = (table, op) => (table === "stores" && op === "select" ? { code: "42703", message: 'column stores.woo_site_url does not exist' } : null);
    expect(await runWooWebhooksChecks(h.db.client(), {})).toMatchObject({ ok: true, skipped: "sin_migracion", stores: [] });
    h.db.failOn = (table, op) => (table === "stores" && op === "select" ? { message: "canceling statement due to statement timeout" } : null);
    expect(await runWooWebhooksChecks(h.db.client(), {})).toMatchObject({ ok: false, error: "No se pudieron leer las tiendas." });
  });
});

// ── El cron ─────────────────────────────────────────────────────────────────

describe("/api/cron/woo-webhooks", () => {
  const call = (q = "", auth: string | null = "Bearer cron") =>
    route.GET(new NextRequest(`https://kapta.test/api/cron/woo-webhooks${q}`, { headers: auth ? { authorization: auth } : {} }));

  beforeEach(() => {
    vi.stubEnv("CRON_SECRET", "cron");
    h.db = new FakeDb({ stores: [storeRow()] });
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("corre en Node, sin caché y con 60 s, por GET y por POST", () => {
    expect(route.runtime).toBe("nodejs");
    expect(route.dynamic).toBe("force-dynamic");
    expect(route.maxDuration).toBe(60);
    expect(route.POST).toBe(route.GET);
  });

  it("sin el secreto del cron: 401, sin leer tiendas ni llamar a WooCommerce", async () => {
    const woo = fakeWoo(healthy());
    vi.stubGlobal("fetch", woo.fetchImpl);
    expect((await call("", null)).status).toBe(401);
    expect((await call("", "Bearer otro")).status).toBe(401);
    expect(woo.calls).toEqual([]);
    expect(h.db.ops).toEqual([]);
  });

  it("todo bien: 200; algo mal: 502; una línea de log sin direcciones", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.stubGlobal("fetch", fakeWoo(healthy()).fetchImpl);
    const ok = await call();
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ ok: true, dry: false, stores: [{ storeId: STORE_ID, status: "ok" }] });

    vi.stubGlobal("fetch", fakeWoo(healthy().slice(1)).fetchImpl);
    const bad = await call();
    expect(bad.status).toBe(502);
    expect(h.db.rows("stores")[0]!.woo_last_error).toMatch(/^Webhooks en WooCommerce: falta order\.created\. /);

    expect(log).toHaveBeenCalledTimes(2);
    for (const [line] of log.mock.calls) {
      expect(String(line).startsWith("[woo-webhooks] ")).toBe(true);
      for (const leak of ["aurela.pe", "kapta.example", CK, "secreto-del-webhook"]) expect(String(line)).not.toContain(leak);
    }
  });

  it("?storeId que no es uuid: 400; ?dry=1 no escribe", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.stubGlobal("fetch", fakeWoo([]).fetchImpl);
    for (const bad of ["abc", `${STORE_ID}x`, ""]) expect((await call(`?storeId=${bad}`)).status, bad).toBe(400);
    const dry = await call(`?dry=1&storeId=${STORE_ID}`);
    expect(dry.status).toBe(502);
    expect(await dry.json()).toMatchObject({ dry: true });
    expect(h.db.opsOn("stores", "update")).toEqual([]);
    expect(h.db.opsOn("sync_state")).toEqual([]);
  });

  it("la ruta usa el mismo candado que los demás crons", () => {
    const src = read("app/api/cron/woo-webhooks/route.ts");
    expect(src).toContain("if (!internalAuthorized(req)) return new NextResponse(\"unauthorized\", { status: 401 });");
  });
});

describe("vercel.json: la revisión de los webhooks", () => {
  const crons = (JSON.parse(read("vercel.json")) as { crons: { path: string; schedule: string }[] }).crons;

  it("corre cada hora, en el minuto 34", () => {
    expect(crons.filter((c) => c.path === "/api/cron/woo-webhooks")).toEqual([{ path: "/api/cron/woo-webhooks", schedule: "34 * * * *" }]);
  });

  it("no cae en el minuto de ningún barrido que corre cada hora o más seguido", () => {
    const minutesOf = (schedule: string): number[] => {
      const [minute, hour] = schedule.split(" ");
      if (hour !== "*" && !hour!.startsWith("*/")) return [];
      const out: number[] = [];
      for (const part of minute!.split(",")) {
        const [range, stepText] = part.split("/");
        const step = stepText === undefined ? 1 : Number(stepText);
        const [from, to] =
          range === "*" ? [0, 59] : range!.includes("-") ? range!.split("-").map(Number) : [Number(range), stepText ? 59 : Number(range)];
        for (let m = from!; m <= to!; m += step) out.push(m);
      }
      return out;
    };
    for (const c of crons.filter((x) => x.path !== "/api/cron/woo-webhooks")) {
      expect(minutesOf(c.schedule), c.path).not.toContain(34);
    }
  });
});

// ── El MOM ──────────────────────────────────────────────────────────────────

describe("MOM §38.14 dice lo mismo que el código", () => {
  const MOM = read("docs/mom/master-pedidos-v1.md");
  const flat = (text: string) => text.replace(/\s+/g, " ");
  function section(title: string): string {
    const start = MOM.indexOf(title);
    expect(start, title).toBeGreaterThan(-1);
    const level = title.match(/^#+/)![0].length;
    const rest = MOM.slice(start + title.length);
    const next = rest.search(new RegExp(`\\n#{1,${level}} `));
    return flat(next === -1 ? rest : rest.slice(0, next));
  }
  const S = section("### 38.14 La revisión de los webhooks de WooCommerce");

  it("qué lee, con qué topes y que nunca cambia nada", () => {
    expect(S).toContain(`**solo con \`GET /wp-json/wc/v3${WOO_WEBHOOKS_PATH}\`**`);
    expect(S).toContain(`de a **${WOO_WEBHOOKS_PER_PAGE}**, como mucho **${WOO_WEBHOOKS_MAX_PAGES} páginas** y **${WOO_WEBHOOKS_BUDGET_MS / 1000} segundos** por tienda`);
    expect(S).toContain(`cada llamada corta a los ${WOO_TIMEOUT_MS / 1000} s`);
    for (const t of WOO_INTAKE_TOPICS) expect(S).toContain(`\`${t}\``);
    expect(S).toContain("**Solo lectura.** Kapta nunca crea, reactiva, cambia ni borra un webhook.");
    expect(S).toContain("**El host de la dirección no se compara.**");
  });

  it("cuándo corre y dónde queda", () => {
    expect(S).toContain("`/api/cron/woo-webhooks`, `34 * * * *`");
    expect(S).toContain("autenticado con `CRON_SECRET`");
    expect(S).toContain(`**\`sync_state\`, fuente \`${WOO_WEBHOOKS_SOURCE}\`:**`);
    expect(S).toContain(`con el prefijo «${WOO_WEBHOOKS_ERROR_PREFIX.trim()} »`);
    expect(S).toContain("**Solo lo borra una revisión que encuentra todo bien**");
    for (const kind of WOO_WEBHOOKS_TRANSIENT_ERRORS) expect(S).toContain(`\`${kind}\``);
    expect(S).toContain("**Sin migración.**");
  });

  it("los textos de Ajustes son los de la sección", () => {
    const SECTION = read("components/woocommerce-settings-section.tsx");
    for (const text of ["los cuatro activos y con la dirección de esta tienda", "falta algo", "no se pudo revisar"]) {
      expect(S, text).toContain(text);
      expect(SECTION, text).toContain(text);
    }
    expect(S).toContain("Revisión de los webhooks en WooCommerce (cada hora)");
    expect(SECTION).toContain("Revisión de los webhooks en WooCommerce (cada hora)");
  });

  it("dice lo que la lista no trae y por eso no se revisa: la versión de la API y el secreto", () => {
    expect(S).toContain("**Lo que la lista no dice, y por eso no se revisa.**");
    expect(S).toContain("**no la versión de la API**");
    expect(S).toContain("la revisión lo ve cuando WooCommerce lo desactiva, no antes");
    // Ni el resumen ni la evaluación miran una versión: no la hay.
    expect(read("lib/woocommerce-webhooks-health.ts")).not.toMatch(/api_version/);
    const SECTION = read("components/woocommerce-settings-section.tsx");
    expect(SECTION).toContain("La versión de la API y el secreto no los muestra WooCommerce");
  });

  it("hoy revisa Aurela y Kenku, y Ajustes da el motivo cuando no se pudo revisar", () => {
    expect(S).toContain("**Hoy (25-10-2026).** Las tiendas que revisa son Aurela y Kenku");
    expect(S).toContain("esta última con el motivo cuando el último fallo no lo dice ya");
    const SECTION = read("components/woocommerce-settings-section.tsx");
    expect(SECTION).toContain("`no se pudo revisar${hooksReason ? `: ${hooksReason}` : \"\"}`");
  });

  it("38.8 y 38.11 apuntan a la revisión", () => {
    expect(section("### 38.8 Webhooks y API")).toContain("Kapta lo revisa cada hora leyendo la lista de webhooks del sitio, sin cambiarla nunca (38.14)");
    const s38_11 = section("### 38.11 La entrada de pedidos de WooCommerce");
    expect(s38_11).toContain("la última revisión de los webhooks (38.14)");
    // Al cambiar la dirección (el día del corte), «Guardar» ya dice cómo están.
    expect(s38_11).toContain("El aviso de «Guardar» suma la revisión de los webhooks del sitio nuevo («Webhooks: …», 38.14).");
  });

  it("los archivos que nombra existen", () => {
    for (const f of [
      "lib/woocommerce-webhooks-health.ts",
      "app/api/cron/woo-webhooks/route.ts",
      "app/dashboard/[storeId]/settings/woo-actions.ts",
      "components/woocommerce-settings-section.tsx",
      "test/woocommerce-webhooks-health.test.ts",
      "test/woocommerce-settings.test.ts",
    ]) {
      expect(S, f).toContain(`\`${f}\``);
      expect(() => read(f), f).not.toThrow();
    }
  });

  it("cada función que nombra la exporta el código", async () => {
    const lib = await import("@/lib/woocommerce-webhooks-health");
    const names = [...S.matchAll(/`((?:check|summarize|evaluate|record|run)WooWebhooks\w*|wooWebhook\w+|WOO_WEBHOOKS_\w+)`/g)].map((m) => m[1]!);
    expect(names.length).toBeGreaterThan(10);
    for (const n of names) expect(lib, n).toHaveProperty(n);
  });
});
