// Prueba A/B del mensaje 1 de carrito con la foto del producto (0233).

import { describe, expect, it } from "vitest";
import {
  cartImageVariant,
  cartProductWithImage,
  imageTestSummary,
  waImageUrl,
  IMAGE_TEST_MIN_PER_ARM,
} from "@/lib/cart-image-test";
import { runCartSequence } from "@/lib/cart-sequence";
import { productPhotoName } from "@/lib/product-photos";
import type { StoreCreds } from "@/lib/ingest";

describe("el sorteo", () => {
  it("es estable: el mismo carrito cae siempre en el mismo grupo", () => {
    const gid = "gid://shopify/DraftOrder/1352673755431";
    expect(cartImageVariant(gid)).toBe(cartImageVariant(gid));
  });

  it("reparte cerca de 50/50", () => {
    let imagen = 0;
    for (let i = 0; i < 4000; i++) if (cartImageVariant(`gid://shopify/DraftOrder/${1352670000000 + i}`) === "imagen") imagen++;
    expect(imagen / 4000).toBeGreaterThan(0.46);
    expect(imagen / 4000).toBeLessThan(0.54);
  });
});

describe("la foto del carrito", () => {
  const catalog = [
    { product_id: "111", catalog_title: "Nails Repairing – Sérum Tea Tree Ginger para Uñas (30ml)" },
    { product_id: "222", catalog_title: "Otro producto" },
  ];

  it("los carritos COD llegan sin product_id: casa por título, sin importar mayúsculas ni espacios", () => {
    expect(cartProductWithImage([{ product_id: null, title: "nails repairing –  Sérum Tea Tree Ginger para Uñas (30ml) " }], catalog)).toBe("111");
  });

  it("si llega el product_id, manda ese", () => {
    expect(cartProductWithImage([{ product_id: 222, title: "Nails Repairing – Sérum Tea Tree Ginger para Uñas (30ml)" }], catalog)).toBe("222");
  });

  it("sin foto en el catálogo, el carrito queda fuera de la prueba", () => {
    expect(cartProductWithImage([{ title: "Producto nuevo" }], catalog)).toBeNull();
    expect(cartProductWithImage([], catalog)).toBeNull();
  });

  it("la foto pasa por /api/wa-image en JPG", () => {
    expect(waImageUrl("https://kapso.example/", "store-1", "111")).toBe("https://kapso.example/api/wa-image/store-1/111.jpg");
  });
});

describe("lo que dice la prueba", () => {
  const row = (variant: "imagen" | "control", carritos: number, convertidos: number) =>
    ({ variant, carritos, convertidos, bot: 0, bot_asistido: 0, asesora: 0, ventas: 0 });

  it("con pocos carritos no concluye", () => {
    const r = imageTestSummary([row("imagen", 100, 20), row("control", 100, 15)]);
    expect(r.veredicto).toContain("Aún es pronto");
  });

  it("15 % contra 20 % con 1.000 por grupo: la foto gana y no es casualidad", () => {
    const r = imageTestSummary([row("imagen", 1000, 200), row("control", 1000, 150)]);
    expect(r.diferencia).toBeCloseTo(5, 5);
    expect(r.pValue!).toBeLessThan(0.01);
    expect(r.veredicto).toBe("Con foto cierra 5.0 puntos más, y no es casualidad.");
  });

  it("15 % contra 16 % con 400 por grupo: todavía puede ser casualidad", () => {
    const r = imageTestSummary([row("imagen", IMAGE_TEST_MIN_PER_ARM + 100, 64), row("control", IMAGE_TEST_MIN_PER_ARM + 100, 60)]);
    expect(r.veredicto).toContain("Todavía no hay diferencia clara");
  });

  it("acepta los conteos como texto, como los devuelve Postgres", () => {
    const r = imageTestSummary([{ ...row("imagen", 0, 0), carritos: "10" as never, convertidos: "2" as never }]);
    expect(r.imagen.tasa).toBeCloseTo(0.2);
  });
});

// --- runCartSequence con la prueba encendida ---------------------------------

function gidFor(variant: "imagen" | "control", start: number): string {
  for (let i = start; ; i++) {
    const gid = `gid://shopify/DraftOrder/${i}`;
    if (cartImageVariant(gid) === variant) return gid;
  }
}

const SERUM_URL = "https://cdn.shopify.com/s/files/1/x/files/serum.webp?v=1";
/** La fila de `stores` de Kenku o Aurela: token de Shopify y WooCommerce conectado. */
const PASA_A_WOO = { shopify_token_enc: "enc:token", platform: "shopify", woo_site_url: "https://kenku.pe" };

function harness(
  opts: {
    imageSendFails?: boolean;
    /** El día de la corrida (`AAAA-MM-DD`); el carrito se armó ese día a las 10:00 UTC. */
    day?: string;
    /** Los archivos guardados en el bucket de fotos de producto (MOM §39). */
    stored?: string[];
    /** Storage no contesta el listado. */
    storageDown?: boolean;
    /** La fila de la tienda (`shopifyGoneForStore`). Por defecto, Kenku. */
    store?: Record<string, unknown>;
  } = {},
) {
  const imagenGid = gidFor("imagen", 1000);
  const controlGid = gidFor("control", 2000);
  const sinFotoGid = gidFor("imagen", 3000);
  const day = opts.day ?? "2026-10-07";
  const created = `${day}T10:00:00Z`;
  const lead = (id: string, gid: string) => ({
    id, phone: `5190000000${id.slice(-1)}`, name: "Ana", category: "open", has_order: false,
    draft_order_gid: gid, draft_order_status: "open", last_inbound_at: null, cart_seq_touches: 0,
    last_cart_seq_at: null, cart_seq_gid: null, cart_summary: null, cart_value: 89,
    address1: "Jr Lima 123", district: "Ilo", referencia: null, wa_phone_number_id: "pn-1",
  });
  const leads = [lead("l1", imagenGid), lead("l2", controlGid), lead("l3", sinFotoGid)];
  const drafts = [
    { draft_order_gid: imagenGid, created_at: created, line_items: [{ title: "Sérum Uñas", quantity: 1, product_id: null }], total_amount: 89, currency: "PEN" },
    { draft_order_gid: controlGid, created_at: created, line_items: [{ title: "Sérum Uñas", quantity: 1, product_id: null }], total_amount: 89, currency: "PEN" },
    { draft_order_gid: sinFotoGid, created_at: created, line_items: [{ title: "Producto sin foto", quantity: 1 }], total_amount: 89, currency: "PEN" },
  ];
  const inserts: { table: string; row: Record<string, unknown> }[] = [];
  const listed: string[] = [];
  const admin = {
    storage: {
      from: () => ({
        list: async (prefix: string, o: { offset: number }) => {
          listed.push(prefix);
          if (opts.storageDown) return { data: null, error: { message: "storage caído" } };
          return { data: o.offset ? [] : (opts.stored ?? []).map((name) => ({ name, id: name })), error: null };
        },
      }),
    },
    from(table: string) {
      const q: Record<string, unknown> = {};
      for (const m of ["select", "eq", "in", "not", "order", "limit", "update"]) q[m] = () => q;
      q.insert = (row: Record<string, unknown>) => { inserts.push({ table, row }); return q; };
      q.maybeSingle = async () => ({ data: table === "stores" ? (opts.store ?? PASA_A_WOO) : null, error: null });
      const data = table === "leads" ? leads
        : table === "draft_orders" ? drafts
        : table === "shopify_product_images" ? [{ product_id: "111", catalog_title: "Sérum Uñas", image_url: SERUM_URL }]
        : null;
      q.then = (resolve: (r: unknown) => unknown) => Promise.resolve({ data, error: null }).then(resolve);
      return q;
    },
  };
  const sends: Record<string, unknown>[] = [];
  const sendTemplate = async (_o: unknown, p: Record<string, unknown>) => {
    sends.push(p);
    if (opts.imageSendFails && p.headerImage) return { ok: false, error: "template does not exist", code: 132001 };
    return { ok: true };
  };
  const creds = {
    cart_seq_enabled: true, kapso_api_key: "k", timezone: "America/Lima", cart_seq_hour_start: 0, cart_seq_hour_end: 24,
    cart_seq_hours_1: 3, cart_seq_hours_2: 24, whatsapp_phone_number_id: "pn-1",
    cart_seq_template_1_name: "carrito_abandonado_1", cart_seq_template_1_language: "es",
    cart_seq_template_2_name: "carrito_abandonado_2", cart_seq_template_2_language: "es",
    cart_seq_image_test_enabled: true, cart_seq_image_template_1_name: "carrito_abandonado_1_img", cart_seq_image_template_1_language: "es",
  } as unknown as StoreCreds;
  const run = () => runCartSequence(admin as never, "store-1", creds, sendTemplate as never, `${day}T15:00:00Z`, "https://kapso.example");
  return { run, sends, inserts, listed, imagenGid, controlGid, sinFotoGid };
}

describe("runCartSequence con la prueba de imagen", () => {
  it("«imagen» va con la plantilla con foto; «control» y el carrito sin foto, con la de siempre", async () => {
    const h = harness();
    const report = await h.run();
    expect(report).toMatchObject({ sent: 3, failed: 0, withImage: 1 });

    const byTo = (to: string) => h.sends.find((s) => s.to === to)!;
    expect(byTo("51900000001")).toMatchObject({
      templateName: "carrito_abandonado_1_img",
      headerImage: { link: "https://kapso.example/api/wa-image/store-1/111.jpg" },
    });
    expect(byTo("51900000002")).toMatchObject({ templateName: "carrito_abandonado_1" });
    expect(byTo("51900000002")).not.toHaveProperty("headerImage");
    expect(byTo("51900000003")).toMatchObject({ templateName: "carrito_abandonado_1" });

    const sendRows = h.inserts.filter((i) => i.table === "cart_seq_sends").map((i) => i.row);
    expect(sendRows.map((r) => [r.draft_order_gid, r.variant, r.ok])).toEqual([
      [h.imagenGid, "imagen", true],
      [h.controlGid, "control", true],
      [h.sinFotoGid, null, true],
    ]);
    expect(sendRows[0]!.image_url).toBe("https://kapso.example/api/wa-image/store-1/111.jpg");
  });

  it("si la plantilla con foto falla, el cliente recibe la de siempre y queda fuera de la prueba", async () => {
    const h = harness({ imageSendFails: true });
    const report = await h.run();
    expect(report).toMatchObject({ sent: 3, failed: 0 });
    const toImagen = h.sends.filter((s) => s.to === "51900000001");
    expect(toImagen.map((s) => s.templateName)).toEqual(["carrito_abandonado_1_img", "carrito_abandonado_1"]);
    const rows = h.inserts
      .filter((i) => i.table === "cart_seq_sends" && i.row.draft_order_gid === h.imagenGid)
      .map((i) => [i.row.template_name, i.row.variant, i.row.ok]);
    expect(rows).toEqual([
      ["carrito_abandonado_1_img", "imagen", false],
      ["carrito_abandonado_1", null, true],
    ]);
  });
});

describe("runCartSequence desde el cierre de Shopify (MOM §39)", () => {
  // Shopify cierra Kenku y Aurela el 28-10-2026 00:00 UTC y su CDN deja de
  // servir las fotos: desde entonces solo cuenta la que tiene copia guardada.
  const conCopia = () => [productPhotoName("111", SERUM_URL)];

  it("antes del cierre, la foto del espejo entra como siempre, sin mirar Storage", async () => {
    const h = harness({ day: "2026-10-27" });
    expect(await h.run()).toMatchObject({ withImage: 1 });
    expect(h.listed).toEqual([]);
  });

  it("una tienda cliente sigue en Shopify: desde el cierre, la foto entra como siempre, sin mirar Storage", async () => {
    const h = harness({ day: "2026-10-29", stored: [], store: { ...PASA_A_WOO, woo_site_url: null } });
    expect(await h.run()).toMatchObject({ withImage: 1 });
    expect(h.listed).toEqual([]);
  });

  it("sin token de Shopify (cerró antes y se vació), solo con copia aunque no sea el 28-10", async () => {
    const h = harness({ day: "2026-10-27", stored: [], store: { ...PASA_A_WOO, shopify_token_enc: null } });
    expect((await h.run()).withImage ?? 0).toBe(0);
    expect(h.listed).toEqual(["store-1"]);
  });

  it("si Storage no contesta, ninguna foto: el carrito queda fuera de la prueba y sale el de siempre", async () => {
    const h = harness({ day: "2026-10-29", storageDown: true });
    const report = await h.run();
    expect(report).toMatchObject({ sent: 3, failed: 0 });
    expect(report.withImage ?? 0).toBe(0);
    expect(h.sends.every((s) => s.templateName === "carrito_abandonado_1")).toBe(true);
  });

  it("con su copia guardada, el carrito sigue en la prueba con su foto", async () => {
    const h = harness({ day: "2026-10-29", stored: conCopia() });
    expect(await h.run()).toMatchObject({ sent: 3, withImage: 1 });
    // La página con los nombres y la vacía.
    expect(h.listed).toEqual(["store-1", "store-1"]);
    expect(h.sends.find((s) => s.to === "51900000001")).toMatchObject({
      templateName: "carrito_abandonado_1_img",
      headerImage: { link: "https://kapso.example/api/wa-image/store-1/111.jpg" },
    });
  });

  it("sin copia, el carrito queda fuera de la prueba ANTES del sorteo: la de siempre, sin foto", async () => {
    const h = harness({ day: "2026-10-29", stored: [] });
    const report = await h.run();
    expect(report).toMatchObject({ sent: 3, failed: 0 });
    expect(report.withImage ?? 0).toBe(0);
    expect(h.sends.every((s) => s.templateName === "carrito_abandonado_1" && !("headerImage" in s))).toBe(true);
    const variants = h.inserts.filter((i) => i.table === "cart_seq_sends").map((i) => i.row.variant);
    expect(variants).toEqual([null, null, null]);
  });
});
