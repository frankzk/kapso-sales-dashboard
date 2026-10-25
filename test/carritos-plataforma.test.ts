// Los carritos de Shopify en una tienda que ya crea en WooCommerce (MOM §38.12,
// 25-10-2026). `stores.platform` dice dónde crea Kapta los pedidos nuevos de la
// tienda (§38.1): lo que completaba un borrador de Shopify, o registraba una
// venta, sin mirarlo —la prueba de recompra sin llamada, `recoverCart` y
// `closeSale`— solo crea con `shopify`. Con `woocommerce` no crea nada y deja
// dicho por qué. Con `shopify`, todo como antes. Sin red ni base: Shopify y la
// base son falsos. Las reglas del procesador, a fondo, en
// test/auto-order-trials.test.ts.

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
});

const h = vi.hoisted(() => ({
  db: null as unknown as import("./woocommerce-fake-db").FakeDb,
  lead: { store_id: "", phone: null as string | null, kapso_conversation_id: null as string | null, wa_phone_number_id: null },
  shopify: {
    completeDraftOrder: vi.fn(),
    getDraftOrderOrder: vi.fn(),
  },
  getStoreCreds: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/server", () => ({ after: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: (p: string) => {
    throw new Error(`redirect:${p}`);
  },
}));
vi.mock("@/lib/agent-names", () => ({ resolveAgentName: vi.fn(), resolveAgentNames: vi.fn() }));
vi.mock("@/lib/db", () => ({
  createServerSupabase: async () => ({
    auth: { getClaims: async () => ({ data: { claims: { sub: "advisor-1" } } }) },
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: h.lead }) }) }) }),
  }),
  createAdminSupabase: () => h.db.client(),
}));
vi.mock("@/lib/ingest", async (orig) => ({
  ...(await orig<typeof import("@/lib/ingest")>()),
  getStoreCreds: h.getStoreCreds,
}));
vi.mock("@/lib/shopify", async (orig) => ({
  ...(await orig<typeof import("@/lib/shopify")>()),
  ...h.shopify,
}));

import { encrypt } from "@/lib/crypto";
import { closeSale, recoverCart } from "@/app/dashboard/leads/actions";
import { AUTO_TRIAL_PLATFORM_REASON, autoTrialDeps } from "@/lib/auto-order-trials";
import { LOCAL_SALE_IN_WOO_STORE, SHOPIFY_CART_IN_WOO_STORE } from "@/lib/woocommerce-orders";
import { FakeDb, type Row } from "./woocommerce-fake-db";

const STORE = "22222222-2222-4222-8222-222222222222";
const LEAD = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const DRAFT = "gid://shopify/DraftOrder/987654";

function storeRow(platform: "shopify" | "woocommerce"): Row {
  return {
    id: STORE,
    status: "active",
    timezone: "America/Lima",
    currency: "PEN",
    platform,
    platform_switched_at: platform === "woocommerce" ? "2026-10-27T23:00:00Z" : null,
    woo_intake_from: "2026-10-25T00:13:46Z",
    woo_site_url: "https://kenku.pe",
    woo_site_key: "kp",
    woo_consumer_key_enc: encrypt("ck_0123456789abcdef0123456789abcdef01234567"),
    woo_consumer_secret_enc: encrypt("cs_0123456789abcdef0123456789abcdef01234567"),
    woo_webhook_secret_enc: null,
    woo_last_error: null,
  };
}

function leadRow(): Row {
  return {
    id: LEAD,
    store_id: STORE,
    phone: "51988805509",
    kapso_conversation_id: null,
    draft_order_gid: DRAFT,
    draft_order_name: "#D4321",
    cart_value: 129,
    cart_summary: "EggMixer x1",
    district: "Juliaca",
    has_order: false,
    status: "nuevo",
    category: "open",
  };
}

function setup(platform: "shopify" | "woocommerce") {
  h.db = new FakeDb({ stores: [storeRow(platform)], leads: [leadRow()] });
  h.lead = { store_id: STORE, phone: "51988805509", kapso_conversation_id: null, wa_phone_number_id: null };
}

const forbiddenFetch = vi.fn(async () => {
  throw new Error("no debía llamar a la red");
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  h.getStoreCreds.mockImplementation(async () => ({
    id: STORE,
    shopify_domain: "kenku.myshopify.com",
    shopify_token: "shpat_x",
    currency: "PEN",
  }));
  h.shopify.completeDraftOrder.mockResolvedValue({
    orderGid: "gid://shopify/Order/5550009",
    orderName: "#KP143999",
    status: "completed",
  });
  vi.stubGlobal("fetch", forbiddenFetch);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("recoverCart: completar el borrador de Shopify solo con stores.platform = 'shopify'", () => {
  it("en una tienda que crea en WooCommerce no completa el borrador ni registra nada", async () => {
    setup("woocommerce");
    const res = await recoverCart(LEAD);
    expect(res).toEqual({ error: SHOPIFY_CART_IN_WOO_STORE });
    expect(h.shopify.completeDraftOrder).not.toHaveBeenCalled();
    expect(h.getStoreCreds).not.toHaveBeenCalled();
    expect(forbiddenFetch).not.toHaveBeenCalled();
    expect(h.db.rows("orders")).toEqual([]);
    expect(h.db.rows("lead_calls")).toEqual([]);
    expect(h.db.rows("order_sales")).toEqual([]);
    expect(h.db.rows("leads")[0]).toMatchObject({ has_order: false, status: "nuevo", category: "open" });
  });

  it("si la tienda no se pudo leer, tampoco: no se adivina «Shopify»", async () => {
    setup("shopify");
    h.db.failOn = (table, op) => (table === "stores" && op === "select" ? { message: "canceling statement due to statement timeout" } : null);
    const res = await recoverCart(LEAD);
    expect(res.error).toBe("No se pudo leer la tienda. Intenta de nuevo en unos segundos.");
    expect(h.shopify.completeDraftOrder).not.toHaveBeenCalled();
    expect(h.db.rows("orders")).toEqual([]);
  });

  it("en una tienda de Shopify, lo de siempre: completa el borrador y registra el pedido", async () => {
    setup("shopify");
    const res = await recoverCart(LEAD);
    expect(res.error).toBeUndefined();
    expect(h.shopify.completeDraftOrder).toHaveBeenCalledWith({
      domain: "kenku.myshopify.com",
      token: "shpat_x",
      draftGid: DRAFT,
      paymentPending: true,
    });
    expect(h.db.rows("orders")).toHaveLength(1);
    expect(h.db.rows("orders")[0]).toMatchObject({ shopify_order_id: "5550009", name: "#KP143999" });
  });
});

describe("closeSale: una venta solo en Kapta solo con stores.platform = 'shopify'", () => {
  it("en una tienda que crea en WooCommerce no registra la venta", async () => {
    setup("woocommerce");
    const res = await closeSale(LEAD, { amount: 129, products: "EggMixer", district: "Juliaca" });
    expect(res).toEqual({ error: LOCAL_SALE_IN_WOO_STORE });
    expect(h.db.rows("orders")).toEqual([]);
    expect(h.db.rows("lead_calls")).toEqual([]);
    expect(h.db.rows("order_sales")).toEqual([]);
    expect(h.db.rows("leads")[0]).toMatchObject({ has_order: false, status: "nuevo" });
  });

  it("en una tienda de Shopify, lo de siempre: inserta la fila `manual-…`", async () => {
    setup("shopify");
    await closeSale(LEAD, { amount: 129 });
    // La base falsa no devuelve la fila insertada (`insert().select("id")`), así
    // que aquí basta con ver que la venta pasó la plataforma y llegó a insertar.
    const inserts = h.db.opsOn("orders", "insert");
    expect(inserts).toHaveLength(1);
    expect(String(inserts[0]!.payload.shopify_order_id)).toMatch(/^manual-/);
    expect(inserts[0]!.payload).toMatchObject({ store_id: STORE, total_amount: 129, financial_status: "pending" });
  });

  it("los dos textos nombran WooCommerce y mandan a «Generar pedido»", () => {
    for (const text of [SHOPIFY_CART_IN_WOO_STORE, LOCAL_SALE_IN_WOO_STORE]) {
      expect(text).toMatch(/^La tienda crea sus pedidos nuevos en WooCommerce: /);
      expect(text).toContain("Usa «Generar pedido»");
    }
  });
});

describe("la prueba de recompra lee stores.platform de la tienda", () => {
  it("las dependencias reales leen la plataforma de su tienda, sin claves", async () => {
    for (const platform of ["shopify", "woocommerce"] as const) {
      setup(platform);
      const deps = autoTrialDeps(h.db.client(), STORE, { domain: "kenku.myshopify.com", token: "shpat_x" });
      expect(await deps.storePlatform()).toBe(platform);
      const read = h.db.opsOn("stores", "select");
      expect(read.at(-1)!.cols).toBe("platform");
    }
  });

  it("la sincronización cuenta lo que no se generó y dice si no pudo leer la plataforma", () => {
    const ingest = readFileSync(resolve(process.cwd(), "lib/ingest.ts"), "utf8");
    const step = ingest.slice(ingest.indexOf("// 1d) Prueba de pedidos automáticos de recompra"), ingest.indexOf("// 2) Kapso pull"));
    expect(step).toContain("report.autoOrdersBlockedByPlatform = trials.blockedByPlatform;");
    expect(step).toContain("if (trials.error) report.errors.push(`pedidos_auto: ${trials.error}`);");
    expect(ingest).toContain("autoOrdersBlockedByPlatform: 0,");
  });
});

// --- El MOM dice lo que corre --------------------------------------------------

const MOM = readFileSync(resolve(process.cwd(), "docs/mom/master-pedidos-v1.md"), "utf8");
const flat = (text: string) => text.replace(/\s+/g, " ");

function section(title: string): string {
  const start = MOM.indexOf(title);
  expect(start, title).toBeGreaterThan(-1);
  const level = title.match(/^#+/)![0].length;
  const rest = MOM.slice(start + title.length);
  const next = rest.search(new RegExp(`\\n#{1,${level}} `));
  return flat(next === -1 ? rest : rest.slice(0, next));
}

describe("MOM §38.12 · Los carritos de Shopify en una tienda que ya crea en WooCommerce", () => {
  const SEC = section("#### Los carritos de Shopify en una tienda que ya crea en WooCommerce (25-10-2026)");

  it("la regla: solo crea con shopify; con woocommerce, omitido con su motivo y sin tocar Shopify", () => {
    expect(SEC).toContain("Esto no es una regla nueva: aplica 38.1.");
    expect(SEC).toContain("Solo crea en Shopify lo que corre en una tienda con `stores.platform = 'shopify'`");
    expect(SEC).toContain(`\`omitido\` con el motivo **\`${AUTO_TRIAL_PLATFORM_REASON}\`**`);
    expect(SEC).toContain("sin ninguna llamada a Shopify");
    expect(SEC).toContain(
      "la fila no se toma (o, si ya estaba tomada, vuelve a `pendiente`), las que faltaban también siguen `pendiente`, la corrida no genera nada más",
    );
    expect(SEC).toContain("«pedidos_auto: no se pudo leer en qué plataforma crea sus pedidos la tienda …»");
    expect(SEC).toContain("con cuántos pedidos se generaron antes en esa misma corrida (`platformUnreadableError`)");
    expect(SEC).toContain("**Con `shopify` no cambia nada:**");
  });

  it("se vuelve a leer justo antes de completar el borrador", () => {
    expect(SEC).toContain("**La vuelve a leer justo antes de completar el borrador:**");
    expect(SEC).toContain("completar es lo único que no se deshace");
    expect(SEC).toContain(
      "Si para entonces la tienda ya crea en WooCommerce, la fila queda `omitido` con el mismo motivo: pudo consultar el borrador en Shopify y ponerle la dirección, pero no crea el pedido.",
    );
  });

  it("lo que no se tocó: la inscripción (decisión del owner), la captura y la fecha del cierre", () => {
    expect(SEC).toContain("**La inscripción de la prueba A/B** (`enrollAbCohorts`, paso 1d-0) no mira la plataforma");
    expect(SEC).toContain("**Cómo se mide lo inscrito después del cambio lo decide el owner**");
    expect(SEC).toContain("cohorte antes del 30-10 (pendiente, arriba)");
    expect(SEC).toContain("Separar solo por `reason` no es un corte parejo");
    expect(SEC).toContain("es un ejemplo, no una decisión");
    expect(SEC).toContain("**La captura del carrito recuperado** (`linkCompletedDraftToLead`, paso 1b) no crea");
    expect(SEC).toContain("**El cierre de Shopify no se adivina por la fecha** ni por `woo_site_url`");
  });

  it("los archivos que nombra existen", () => {
    expect(SEC).toContain("`platformUnreadableError`");
    for (const f of [
      "lib/auto-order-trials.ts",
      "lib/ingest.ts",
      "lib/woocommerce-orders.ts",
      "app/dashboard/leads/actions.ts",
      "test/auto-order-trials.test.ts",
      "test/carritos-plataforma.test.ts",
    ]) {
      expect(SEC, f).toContain(`\`${f}\``);
      expect(existsSync(resolve(process.cwd(), f)), f).toBe(true);
    }
  });

  it("el pendiente de los carritos ya no dice que nada mira stores.platform, y deja la decisión del owner", () => {
    const S38_12 = section("### 38.12 Lo que decide la plataforma del pedido");
    expect(S38_12).not.toContain("completan o leen borradores de Shopify y no miran `stores.platform`");
    expect(S38_12).toContain("**Pendiente, decisión del owner:** qué hace la prueba A/B `ab-recompra-prov-1`");
    expect(S38_12).toContain("y cómo se mide lo inscrito después del cambio de plataforma.");
  });

  it("el MOM no da por tomada una forma de medir la cohorte (la decide el owner)", () => {
    // Separar por `reason` solo quita filas de la mitad `auto`: un corte que el
    // owner no decidió y que sesga la comparación (revisión del 25-10-2026).
    expect(flat(MOM)).not.toMatch(/se separan? por `reason`/);
    expect(flat(MOM)).toContain(
      "En `auto_order_ab_results` esas filas salen `sin_pedido`; cómo se mide lo inscrito después del cambio de plataforma lo decide el owner (pendiente, §38.12).",
    );
  });

  it("§38.1 nombra a la prueba y a las dos acciones entre quienes leen stores.platform", () => {
    const S38_1 = section("### 38.1 La plataforma de la tienda y la del pedido");
    expect(S38_1).toContain(
      "la prueba de recompra sin llamada (`auto_order_trials`) y las acciones viejas de Leads `recoverCart` y `closeSale`, que solo crean con `shopify`",
    );
  });

  it("§11, la prueba A/B, lo dice donde se describe la prueba", () => {
    expect(flat(MOM)).toContain(
      "solo se genera en una tienda con `stores.platform = 'shopify'`. En una que ya crea en WooCommerce la fila queda `omitido` con el motivo `tienda_en_woocommerce`",
    );
  });
});

// --- DEPLOY.md: la comprobación y la medición ----------------------------------

describe("DEPLOY.md · Los carritos de Shopify en una tienda que ya crea en WooCommerce", () => {
  const DEPLOY = readFileSync(resolve(process.cwd(), "DEPLOY.md"), "utf8");
  const title = "### 25-10-2026 · Los carritos de Shopify en una tienda que ya crea en WooCommerce";
  const start = DEPLOY.indexOf(title);
  const rest = DEPLOY.slice(start + title.length);
  const next = rest.search(/\n#{1,3} /);
  const ENTRY = flat(next === -1 ? rest : rest.slice(0, next));

  it("existe y dice que el owner lo aprobó", () => {
    expect(start).toBeGreaterThan(-1);
    expect(ENTRY).toContain("**Aprobado por el owner el 25-10-2026.**");
  });

  it("la comprobación filtra por la hora del cambio, no por las últimas 48 h", () => {
    // Con «las últimas 48 h» salían las `generado` legítimas de antes del cambio
    // como si fueran pedidos creados en Shopify después (revisión del 25-10-2026).
    expect(ENTRY).not.toContain("interval '2 days'");
    expect(ENTRY).toContain("join stores s on s.id = t.store_id");
    expect(ENTRY).toContain("and s.platform = 'woocommerce'");
    expect(ENTRY).toContain("and t.processed_at > s.platform_switched_at");
  });

  it("no manda a medir separando por `reason`: cómo se mide lo decide el owner", () => {
    expect(ENTRY).not.toMatch(/se separan? por `reason`/);
    expect(ENTRY).toContain("Cómo se mide lo inscrito después del cambio lo decide el owner");
    expect(ENTRY).toContain("Separar solo por `reason` no es un corte parejo");
  });

  it("dice las dos lecturas de la plataforma y el error con lo generado antes", () => {
    expect(ENTRY).toContain("una antes de tomarla y otra justo antes de completar el borrador");
    expect(ENTRY).toContain("con cuántos pedidos se generaron antes en esa corrida");
  });
});
