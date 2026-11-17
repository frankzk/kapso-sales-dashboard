// El SKU que el pedido no guardó (MOM §38.12, 17-11-2026).
//
// #AUR900965 (Aurela) se vendió el 16-11, cuando la variación «FourLines» del
// Pack de 10 Pares de Calcetines no tenía SKU propio: su línea quedó con
// `sku: null` y GF Courier no la despachaba aunque al día siguiente el producto
// ya tuviera SKU y estuviera sincronizado. La sincronización del catálogo
// completa ahora el SKU de los pedidos abiertos, solo por la identidad de la
// variante.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BACKFILL_STAGES,
  backfillLineSkus,
  catalogRefId,
  lineSkuBackfillNote,
} from "@/lib/order-line-sku-backfill";

const read = (...p: string[]) => readFileSync(join(process.cwd(), ...p), "utf8");

const CALCETINES = "Pack de 10 Pares de Calcetines FourLines Desodorantes Antibacterianos Transpirables";

/** La línea de #AUR900965 tal como la guardó el ingestor de WooCommerce. */
const LINEA = {
  sku: null,
  price: 89,
  title: CALCETINES,
  quantity: 1,
  product_id: "9930",
  variant_id: "9935",
  variant_title: "FourLines",
};

/** El catálogo de WooCommerce después de ponerle SKU a la variación. */
const CATALOGO = [
  { productId: "woo:9930", variantId: "woo:9935", shopifySku: "958737445" },
  // Un producto con tallas donde solo la M tiene SKU.
  { productId: "woo:11", variantId: "woo:111", shopifySku: "POLO-M" },
  { productId: "woo:11", variantId: "woo:112", shopifySku: null },
  // Un simple con SKU y otro sin.
  { productId: "woo:20", variantId: "woo:20", shopifySku: "ASTA-1" },
  { productId: "woo:21", variantId: "woo:21", shopifySku: null },
];

describe("los ids", () => {
  it("WooCommerce, Shopify o crudo, son el mismo id; «0» no es id", () => {
    expect(catalogRefId("woo:9935")).toBe("9935");
    expect(catalogRefId("gid://shopify/ProductVariant/9935")).toBe("9935");
    expect(catalogRefId(9935)).toBe("9935");
    expect(catalogRefId("0")).toBe("");
    expect(catalogRefId(null)).toBe("");
  });
});

describe("qué se completa", () => {
  it("#AUR900965: la variación sin SKU recibe el que ahora tiene en el catálogo", () => {
    const { lines, filled } = backfillLineSkus([LINEA], CATALOGO);
    expect(lines[0]).toEqual({ ...LINEA, sku: "958737445" });
    expect(filled).toEqual([{ index: 0, sku: "958737445", title: CALCETINES, variantTitle: "FourLines" }]);
  });

  it("una línea que ya tiene SKU no se toca, aunque el catálogo diga otro", () => {
    const vendida = { ...LINEA, sku: "VIEJO-1" };
    const { lines, filled } = backfillLineSkus([vendida], CATALOGO);
    expect(lines[0]).toBe(vendida);
    expect(filled).toEqual([]);
  });

  it("nunca por nombre: la L sin SKU no recibe el de la M", () => {
    const talla = { sku: null, title: "Polo", product_id: "11", variant_id: "112", variant_title: "L" };
    const { lines, filled } = backfillLineSkus([talla], CATALOGO);
    expect(lines[0]!.sku).toBeNull();
    expect(filled).toEqual([]);
  });

  it("un simple sin id de variante: por el producto, solo si en el catálogo tiene una variante", () => {
    const simple = { sku: "", title: "Astaxantina", product_id: "20", variant_id: null };
    expect(backfillLineSkus([simple], CATALOGO).lines[0]!.sku).toBe("ASTA-1");
    // El producto de tallas tiene dos variantes: sin id de variante, no se adivina.
    const sinVariante = { sku: null, title: "Polo", product_id: "11", variant_id: null };
    expect(backfillLineSkus([sinVariante], CATALOGO).lines[0]!.sku).toBeNull();
    // Y un simple que tampoco tiene SKU en el catálogo, sigue sin SKU.
    expect(backfillLineSkus([{ sku: null, product_id: "21", variant_id: null }], CATALOGO).filled).toEqual([]);
  });

  it("dos SKU distintos para la misma variante: ninguno", () => {
    const doble = [...CATALOGO, { productId: "woo:9930", variantId: "woo:9935", shopifySku: "OTRO" }];
    expect(backfillLineSkus([LINEA], doble).filled).toEqual([]);
  });

  it("varias líneas: completa las que puede y deja las demás", () => {
    const talla = { sku: null, title: "Polo", product_id: "11", variant_id: "112", variant_title: "L" };
    const { lines, filled } = backfillLineSkus([talla, LINEA], CATALOGO);
    expect(lines.map((l) => l.sku)).toEqual([null, "958737445"]);
    expect(filled.map((f) => f.index)).toEqual([1]);
  });

  it("la nota del historial dice qué se completó y por qué", () => {
    const { filled } = backfillLineSkus([LINEA], CATALOGO);
    expect(lineSkuBackfillNote(filled, "WooCommerce")).toBe(
      `SKU completado desde el catálogo de WooCommerce: «${CALCETINES}» (FourLines) → 958737445. El pedido se guardó cuando el producto no tenía SKU.`,
    );
  });
});

describe("dónde corre", () => {
  it("solo en pedidos donde todavía se crea una guía", () => {
    expect([...BACKFILL_STAGES]).toEqual(["por_confirmar", "preparacion", "por_despachar", "en_curso"]);
  });

  it("la sincronización del catálogo lo hace con el catálogo recién leído, sin cortarse si falla", () => {
    const src = read("lib/aliclik-catalog.ts");
    const load = src.indexOf("const storeDetails = await loadShopifySkuDetails(storeId, admin, 365, skuSource, {");
    const fill = src.indexOf("const filled = await backfillOpenOrderLineSkus(");
    expect(load).toBeGreaterThan(0);
    expect(fill).toBeGreaterThan(load);
    expect(src).toContain("out.ordersSkuFilled = filled.orders.length;");
    expect(src).toContain("out.errors.push(`SKU de pedidos: ${e instanceof Error ? e.message : String(e)}`);");
  });

  it("escribe la línea y deja la nota en el historial", () => {
    const server = read("lib/order-line-sku-backfill-server.ts");
    expect(server).toContain('.update({ line_items: next }).eq("id", order.id);');
    expect(server).toContain("note: lineSkuBackfillNote(filled, sourceName),");
  });

  it("y el MOM lo dice", () => {
    const mom = read("docs/mom/master-pedidos-v1.md").replace(/\s+/g, " ");
    expect(mom).toContain("**El SKU que el pedido no guardó (17-11-2026).**");
  });
});

describe("la escritura (cliente simulado)", () => {
  it("completa #AUR900965, deja la nota y no toca un pedido que ya tiene SKU", async () => {
    const { backfillOpenOrderLineSkus } = await import("@/lib/order-line-sku-backfill-server");
    const writes: { table: string; op: string; value: any; id?: string }[] = [];
    const orders = [
      { id: "o-900965", line_items: [LINEA] },
      { id: "o-con-sku", line_items: [{ ...LINEA, sku: "958737445" }] },
    ];
    const admin = {
      from(table: string) {
        const q: any = {};
        let updateValue: any = null;
        Object.assign(q, {
          select: () => q,
          eq: (_c: string, v: string) => {
            if (updateValue) {
              writes.push({ table, op: "update", value: updateValue, id: v });
              return Promise.resolve({ error: null });
            }
            return q;
          },
          in: () => (table === "orders" ? Promise.resolve({ data: orders, error: null }) : q),
          gte: () => q,
          order: () => q,
          range: async () => ({ data: orders.map((o) => ({ order_id: o.id })), error: null }),
          update: (value: any) => {
            updateValue = value;
            return q;
          },
          insert: async (value: any) => {
            writes.push({ table, op: "insert", value });
            return { error: null };
          },
        });
        return q;
      },
    };
    const res = await backfillOpenOrderLineSkus(admin as never, "store-aurela", CATALOGO, "WooCommerce");
    expect(res).toEqual({ orders: ["o-900965"], errors: [] });
    expect(writes.filter((w) => w.op === "update")).toEqual([
      { table: "orders", op: "update", value: { line_items: [{ ...LINEA, sku: "958737445" }] }, id: "o-900965" },
    ]);
    const nota = writes.find((w) => w.op === "insert")!;
    expect(nota.table).toBe("order_events");
    expect(nota.value).toMatchObject({ order_id: "o-900965", kind: "comment", source: "system" });
    expect(nota.value.note).toContain("→ 958737445");
  });

  it("sin nada con SKU en el catálogo, no lee pedidos", async () => {
    const { backfillOpenOrderLineSkus } = await import("@/lib/order-line-sku-backfill-server");
    const admin = { from: () => { throw new Error("no debía leer"); } };
    const res = await backfillOpenOrderLineSkus(admin as never, "s", [{ productId: "woo:1", variantId: "woo:1", shopifySku: null }], "WooCommerce");
    expect(res).toEqual({ orders: [], errors: [] });
  });
});
