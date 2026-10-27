// Los formularios abandonados de COD Core → Leads (MOM §38.12, «Los formularios
// abandonados de WooCommerce», 27-10-2026, pedido del owner).
//
// Lo que se fija:
//   - El contrato (docs/kapta/cod-core-abandonados.md) se traduce a una fila de
//     `draft_orders` con platform woocommerce, que `isCodFormDraft` reconoce
//     como carrito de formulario: entra a la cola por `linkDraftOrdersToLeads`,
//     el mismo camino que los borradores de Releasit en Shopify.
//   - Firmado con el secreto de los webhooks de WooCommerce de la tienda.
//   - Un «abandonado» repetido o tardío no reabre un formulario recuperado.
//   - «Recuperado» saca el lead de la cola con el pedido que nombra.
//   - Su gid no se confunde con uno de Shopify: la ficha no enlaza a Shopify.

import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeDb, type Row } from "./woocommerce-fake-db";

const h = vi.hoisted(() => {
  process.env.ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
  return { db: null as unknown as import("./woocommerce-fake-db").FakeDb };
});

vi.mock("@/lib/db", () => ({
  createAdminSupabase: () => h.db.client(),
  createServerSupabase: async () => {
    throw new Error("no se usa en estas pruebas");
  },
}));

const spies = vi.hoisted(() => ({
  link: vi.fn(async () => [] as string[]),
  closeCart: vi.fn(async () => 0),
}));

vi.mock("@/lib/leads-ingest", async (orig) => ({
  ...(await orig<typeof import("@/lib/leads-ingest")>()),
  linkDraftOrdersToLeads: spies.link,
  closeCartLeadsWithOrders: spies.closeCart,
  lastDispositionAtByPhone: vi.fn(async () => new Map()),
}));

import { encrypt } from "@/lib/crypto";
import {
  codCoreAbandonedUrl,
  codCoreDate,
  codCoreFormGid,
  isCodCoreFormGid,
  parseCodCoreForm,
} from "@/lib/cod-core-abandoned";
import { codCoreHttpStatus, isPastLeadWindow, processCodCoreAbandoned, relinkCodCoreForms } from "@/lib/cod-core-abandoned-ingest";
import { isCodFormDraft } from "@/lib/shopify";
import { shopifyDraftOrderAdminUrl } from "@/lib/shopify-urls";
import { POST } from "@/app/api/webhooks/woocommerce/[storeId]/abandonados/route";

const STORE_ID = "11111111-1111-4111-8111-111111111111";
const SECRET = "3f9a1c0d5e7b2a4c6d8e0f1a3b5c7d9e1f2a3b4c5d6e7f80";
const read = (path: string) => readFileSync(join(__dirname, "..", path), "utf8");

function storeRow(over: Row = {}): Row {
  return {
    id: STORE_ID,
    status: "active",
    timezone: "America/Lima",
    platform: "woocommerce",
    woo_site_url: "https://kenku.pe",
    woo_site_key: "kp",
    woo_consumer_key_enc: encrypt("ck_0123456789abcdef0123456789abcdef01234567"),
    woo_consumer_secret_enc: encrypt("cs_0123456789abcdef0123456789abcdef01234567"),
    woo_webhook_secret_enc: encrypt(SECRET),
    woo_last_error: null,
    ...over,
  };
}

/** El ejemplo del contrato (docs/kapta/cod-core-abandonados.md). */
function form(over: Record<string, unknown> = {}) {
  return {
    evento: "abandonado",
    id: 812,
    creado: "2026-10-26T15:02:11-05:00",
    actualizado: "2026-10-26T15:32:11-05:00",
    ...FRESH,
    cliente: { nombre: "Karina Flores", celular: "964 668 948", email: null },
    lugar: { distrito: "Los Olivos", provincia: "Lima", departamento: "Lima", direccion: "MZ B LT 22", referencia: "frente al parque" },
    productos: [{ producto_id: 4512, variacion_id: 4519, sku: "KP-ZAP-38", nombre: "Zapatilla Urban", variante: "38 / Negro", cantidad: 1, precio: 79 }],
    total: 79,
    moneda: "PEN",
    pedido_id: null,
    enlace: "https://kenku.pe/wp-admin/admin.php?page=cod-core-abandonados",
    ...over,
  };
}

/** Las pruebas de la ruta usan un formulario de hace una hora (dentro de la ventana de la cola). */
let FRESH: Record<string, unknown> = {};
const freshDates = () => {
  const at = new Date(Date.now() - 3_600_000).toISOString();
  return { creado: at, actualizado: at };
};

const sign = (raw: string, secret = SECRET) => createHmac("sha256", secret).update(raw, "utf8").digest("base64");

describe("el contrato → la fila de draft_orders", () => {
  beforeEach(() => {
    FRESH = {};
  });

  it("un formulario abandonado es un carrito de formulario abierto, de WooCommerce", () => {
    const parsed = parseCodCoreForm(form(), { id: STORE_ID, siteKey: "kp" });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.row).toMatchObject({
      store_id: STORE_ID,
      shopify_draft_order_id: "cod-kp-812",
      draft_order_gid: "cod-core://kp/formulario/812",
      name: "#F812",
      status: "open",
      platform: "woocommerce",
      created_at: "2026-10-26T20:02:11.000Z",
      customer_phone: "51964668948",
      customer_name: "Karina Flores",
      district: "Los Olivos",
      province: "Lima",
      address1: "MZ B LT 22",
      referencia: "frente al parque",
      total_amount: 79,
      invoice_url: "https://kenku.pe/wp-admin/admin.php?page=cod-core-abandonados",
      order_gid: null,
    });
    expect(parsed.row.line_items).toEqual([
      { title: "Zapatilla Urban", variant_title: "38 / Negro", quantity: 1, sku: "KP-ZAP-38", product_id: "4512", variant_id: "4519", price: 79 },
    ]);
    // Lo que linkDraftOrdersToLeads exige para crear el lead «Carrito».
    expect(isCodFormDraft(parsed.row)).toBe(true);
  });

  it("recuperado: completado, con el pedido de WooCommerce como lo nombra Kapta", () => {
    const parsed = parseCodCoreForm(form({ evento: "recuperado", pedido_id: 11179 }), { id: STORE_ID, siteKey: "kp" });
    expect(parsed.ok && parsed.row).toMatchObject({ status: "completed", order_gid: "wc-kp-11179", completed_at: "2026-10-26T20:32:11.000Z" });
    expect(parsed.ok && parsed.orderId).toBe("wc-kp-11179");
  });

  it("sin id, sin celular o con otro evento no hay carrito", () => {
    const store = { id: STORE_ID, siteKey: "kp" };
    expect(parseCodCoreForm(form({ id: 0 }), store)).toMatchObject({ ok: false });
    expect(parseCodCoreForm(form({ cliente: { nombre: "Ana" } }), store)).toMatchObject({ ok: false, reason: "el formulario no trae celular" });
    expect(parseCodCoreForm(form({ evento: "borrado" }), store)).toMatchObject({ ok: false });
    expect(parseCodCoreForm([], store)).toMatchObject({ ok: false });
  });

  it("sin total, la suma de los productos; un precio con coma también se lee", () => {
    const parsed = parseCodCoreForm(
      form({ total: null, productos: [{ nombre: "Faja", cantidad: 2, precio: "59,90" }] }),
      { id: STORE_ID, siteKey: "kp" },
    );
    expect(parsed.ok && parsed.row.total_amount).toBe(119.8);
  });

  it("las fechas: ISO con zona, sin zona (hora de Lima) o unix", () => {
    expect(codCoreDate("2026-10-26T15:02:11Z")).toBe("2026-10-26T15:02:11.000Z");
    expect(codCoreDate("2026-10-26 10:02:11")).toBe("2026-10-26T15:02:11.000Z");
    expect(codCoreDate(1793030500)).toBe(new Date(1793030500 * 1000).toISOString());
    expect(codCoreDate("1793030500")).toBe(new Date(1793030500 * 1000).toISOString());
    expect(codCoreDate("ayer")).toBeNull();
  });

  it("el gid no es de Shopify: la ficha no arma un enlace a un borrador de Shopify con él", () => {
    const gid = codCoreFormGid("kp", "812");
    expect(isCodCoreFormGid(gid)).toBe(true);
    expect(isCodCoreFormGid("gid://shopify/DraftOrder/1234567890")).toBe(false);
    const drawer = read("components/leads-drawer.tsx");
    expect(drawer).toContain("const codCoreForm = isCodCoreFormGid(lead.draft_order_gid);");
    expect(drawer).toContain('{codCoreForm ? "Ver en COD Core" : "Ver borrador en Shopify"}');
    // Lo que pasaría sin el desvío: un enlace a un borrador ajeno.
    expect(shopifyDraftOrderAdminUrl("kenku.myshopify.com", gid)).toContain("/draft_orders/812");
  });

  it("la dirección para COD Core", () => {
    expect(codCoreAbandonedUrl("https://kapta.app/", STORE_ID)).toBe(`https://kapta.app/api/webhooks/woocommerce/${STORE_ID}/abandonados`);
  });
});

describe("processCodCoreAbandoned", () => {
  beforeEach(() => {
    FRESH = freshDates();
    h.db = new FakeDb({ stores: [storeRow()] });
    spies.link.mockClear();
    spies.closeCart.mockClear();
  });

  const run = (raw: string, signature: string | null = sign(raw)) =>
    processCodCoreAbandoned(h.db.client(), { storeId: STORE_ID, rawBody: raw, signature });

  it("firmado: guarda el formulario y lo enlaza a la cola como carrito", async () => {
    const raw = JSON.stringify(form());
    const res = await run(raw);
    expect(res).toEqual({ status: "ok", event: "abandonado", formId: "812" });
    expect(h.db.rows("draft_orders")).toHaveLength(1);
    expect(h.db.rows("draft_orders")[0]).toMatchObject({ platform: "woocommerce", status: "open", customer_phone: "51964668948" });
    expect(spies.link).toHaveBeenCalledTimes(1);
    expect((spies.link.mock.calls[0] as unknown[])[1]).toBe(STORE_ID);

    // El reenvío no duplica.
    await run(raw);
    expect(h.db.rows("draft_orders")).toHaveLength(1);
  });

  it("uno de más de 2 días queda como historia y no entra a la cola", async () => {
    const old = new Date(Date.now() - 3 * 86_400_000).toISOString();
    const res = await run(JSON.stringify(form({ creado: old, actualizado: old })));
    expect(res).toMatchObject({ status: "ok", message: "guardado como historia: tiene más de 2 días" });
    expect(h.db.rows("draft_orders")).toHaveLength(1);
    expect(spies.link).not.toHaveBeenCalled();
    expect(isPastLeadWindow(old, Date.now())).toBe(true);
    expect(isPastLeadWindow(null, Date.now())).toBe(false);
  });

  it("una firma mala, o sin secreto, es 401 y no escribe nada", async () => {
    const raw = JSON.stringify(form());
    const bad = await run(raw, sign(raw, "otro-secreto"));
    expect(bad.status).toBe("unauthorized");
    expect(codCoreHttpStatus(bad)).toBe(401);
    h.db = new FakeDb({ stores: [storeRow({ woo_webhook_secret_enc: null })] });
    expect((await run(raw)).status).toBe("unauthorized");
    expect(h.db.rows("draft_orders")).toHaveLength(0);
    expect(spies.link).not.toHaveBeenCalled();
  });

  it("un formulario sin celular es 422; una tienda que no existe, 404", async () => {
    const res = await run(JSON.stringify(form({ cliente: { nombre: "Ana" } })));
    expect(codCoreHttpStatus(res)).toBe(422);
    h.db = new FakeDb({ stores: [] });
    expect(codCoreHttpStatus(await run(JSON.stringify(form())))).toBe(404);
  });

  it("un «abandonado» que llega después del «recuperado» no lo reabre", async () => {
    await run(JSON.stringify(form({ evento: "recuperado", pedido_id: 11179 })));
    const res = await run(JSON.stringify(form()));
    expect(res).toMatchObject({ status: "ok", message: "ya estaba recuperado" });
    expect(h.db.rows("draft_orders")[0]).toMatchObject({ status: "completed" });
    expect(spies.link).not.toHaveBeenCalled();
  });

  it("recuperado: el lead del formulario sale de la cola con el pedido que nombra", async () => {
    h.db = new FakeDb({
      stores: [storeRow()],
      orders: [{ id: "o-1", store_id: STORE_ID, shopify_order_id: "wc-kp-11179", name: "#KP200123", created_at: "2026-10-26T21:00:00Z", cancelled_at: null }],
      leads: [{ id: "l-1", store_id: STORE_ID, phone: "51964668948", category: "open", status: "nuevo", draft_order_gid: "cod-core://kp/formulario/812", draft_order_status: "open" }],
    });
    const res = await run(JSON.stringify(form({ evento: "recuperado", pedido_id: 11179 })));
    expect(res).toMatchObject({ status: "ok", event: "recuperado" });
    expect(h.db.rows("leads")[0]).toMatchObject({ category: "won", status: "ya_tiene_pedido", order_id: "o-1", draft_order_status: "completed" });
    expect(h.db.rows("lead_calls")[0]).toMatchObject({ lead_id: "l-1", kind: "system", new_status: "ya_tiene_pedido" });
    expect(h.db.rows("lead_calls")[0]!.note).toContain("#KP200123");
    // Y el barrido de siempre, por si nombraba otro pedido o todavía no llegó.
    expect(spies.closeCart).toHaveBeenCalledWith(expect.anything(), STORE_ID, { phones: ["51964668948"] });
  });

  it("la pasada vuelve a enlazar los formularios abiertos de los últimos días", async () => {
    const recent = new Date(Date.now() - 3_600_000).toISOString();
    h.db = new FakeDb({
      draft_orders: [
        { store_id: STORE_ID, shopify_draft_order_id: "cod-kp-1", platform: "woocommerce", status: "open", created_at: recent, tags: ["cod_form"], line_items: [] },
        { store_id: STORE_ID, shopify_draft_order_id: "cod-kp-2", platform: "woocommerce", status: "completed", created_at: recent, tags: ["cod_form"], line_items: [] },
        { store_id: STORE_ID, shopify_draft_order_id: "123", platform: "shopify", status: "open", created_at: recent, tags: ["releasit"], line_items: [] },
      ],
    });
    expect(await relinkCodCoreForms(h.db.client(), STORE_ID)).toBe(1);
    expect(spies.link).toHaveBeenCalledTimes(1);
    expect((spies.link.mock.calls[0] as unknown[])[2]).toHaveLength(1);
    expect(read("lib/ingest.ts")).toContain("await relinkCodCoreForms(admin, storeId);");
  });
});

describe("la ruta", () => {
  beforeEach(() => {
    FRESH = freshDates();
    h.db = new FakeDb({ stores: [storeRow()] });
    spies.link.mockClear();
  });

  const post = (raw: string, signature?: string) =>
    POST(
      new NextRequest(`https://kapta.example/api/webhooks/woocommerce/${STORE_ID}/abandonados`, {
        method: "POST",
        body: raw,
        headers: { "content-type": "application/json", ...(signature ? { "x-kapta-signature": signature } : {}) },
      }),
      { params: Promise.resolve({ storeId: STORE_ID }) },
    );

  it("200 con el id, 401 sin firma", async () => {
    const raw = JSON.stringify(form());
    const ok = await post(raw, sign(raw));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true, evento: "abandonado", id: "812" });
    const no = await post(raw);
    expect(no.status).toBe(401);
  });
});

describe("el MOM, Ajustes y el contrato para COD Core", () => {
  it("lo cuentan", () => {
    const mom = read("docs/mom/master-pedidos-v1.md");
    expect(mom).toContain("#### Los formularios abandonados de WooCommerce (27-10-2026)");
    const doc = read("docs/kapta/cod-core-abandonados.md");
    expect(doc).toContain("X-Kapta-Signature");
    expect(doc).toContain('"evento": "abandonado"');
    expect(read("components/woocommerce-settings-section.tsx")).toContain("Formularios abandonados de COD Core");
  });
});
