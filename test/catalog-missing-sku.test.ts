// La pestaña «Sin SKU» del Catálogo de productos (MOM §38.12, owner 17-11-2026).
//
// El caso: Aurela le puso el SKU 958737445 al «Pack de 10 Pares de Calcetines
// FourLines», en la pestaña Inventario del producto variable, y la pantalla
// siguió diciendo «Falta SKU en WooCommerce»: la variación «FourLines» no tenía
// el suyo. La pestaña separa ese caso (el SKU está en el producto, no en la
// variación) del que no lo tiene en ningún lado, porque se arreglan distinto.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  MISSING_SKU_KIND_LABEL,
  groupMissingSku,
  lacksSku,
  missingSkuCounts,
  missingSkuFix,
  missingSkuSummary,
} from "@/lib/catalog-missing-sku";
import { collectActiveShopifyCatalogDetails } from "@/lib/aliclik-catalog";

const read = (...p: string[]) => readFileSync(join(process.cwd(), ...p), "utf8");

const fila = (title: string, variantTitle: string | null, shopifySku: string | null, parentSku: string | null = null) => ({
  rowKey: `${title}|${variantTitle}`,
  title,
  variantTitle,
  shopifySku,
  parentSku,
});

const CALCETINES = "Pack de 10 Pares de Calcetines FourLines Desodorantes Antibacterianos Transpirables";

describe("qué falta", () => {
  it("sin SKU, o con uno de solo espacios", () => {
    expect(lacksSku({ shopifySku: null })).toBe(true);
    expect(lacksSku({ shopifySku: "  " })).toBe(true);
    expect(lacksSku({ shopifySku: "958737445" })).toBe(false);
  });
});

describe("la clasificación", () => {
  const rows = [
    fila("Zapatillas", "40", null),
    fila("Zapatillas", "38", null),
    fila(CALCETINES, "FourLines", null, "958737445"),
    fila("Faja", "M", "FAJA-M"),
    fila("Astaxantina", null, null),
  ];
  const groups = groupMissingSku(rows);

  it("una tarjeta por producto; los que tienen SKU no salen", () => {
    expect(groups.map((g) => g.title)).toEqual([CALCETINES, "Astaxantina", "Zapatillas"]);
    expect(groups.flatMap((g) => g.rows).every((r) => !r.shopifySku)).toBe(true);
  });

  it("primero el SKU que está en el producto y no en la variación, con su SKU a la vista", () => {
    expect(groups[0]).toMatchObject({ kind: "solo_en_producto", parentSku: "958737445" });
    expect(groups[1]).toMatchObject({ kind: "sin_sku", parentSku: null });
    expect(MISSING_SKU_KIND_LABEL.solo_en_producto).toBe("El SKU está en el producto, no en la variación");
  });

  it("las variaciones de un producto van juntas y en orden", () => {
    expect(groups[2]!.rows.map((r) => r.variantTitle)).toEqual(["38", "40"]);
  });

  it("los conteos y el resumen", () => {
    expect(missingSkuCounts(groups)).toEqual({ solo_en_producto: 1, sin_sku: 2 });
    expect(missingSkuSummary(groups)).toBe("4 variantes de 3 productos");
    expect(missingSkuSummary(groupMissingSku([fila("A", null, null)]))).toBe("1 variante de 1 producto");
    expect(groupMissingSku([])).toEqual([]);
  });

  it("cada caso dice cómo se arregla", () => {
    expect(missingSkuFix("solo_en_producto", "en WooCommerce")).toContain("ve a Variaciones y pon el SKU en cada variación");
    expect(missingSkuFix("solo_en_producto", "en WooCommerce")).toContain("WooCommerce no deja repetirlo");
    expect(missingSkuFix("sin_sku", "en WooCommerce")).toContain("Abre el producto en WooCommerce");
  });
});

describe("el SKU del producto llega a la fila", () => {
  it("solo cuando la variación no tiene el suyo", () => {
    const out = collectActiveShopifyCatalogDetails([
      { productId: "woo:9930", productTitle: CALCETINES, variantId: "woo:9931", variantTitle: "FourLines", sku: null, parentSku: "958737445", inventory: null },
      { productId: "woo:11", productTitle: "Polo", variantId: "woo:111", variantTitle: "M", sku: "POLO-M", parentSku: null, inventory: null },
    ] as never);
    const rows = [...out.values()];
    expect(rows.find((r) => r.title === CALCETINES)).toMatchObject({ shopifySku: null, parentSku: "958737445" });
    expect(rows.find((r) => r.title === "Polo")).not.toHaveProperty("parentSku");
  });

  it("la lectura de WooCommerce y la fila de la pantalla lo llevan", () => {
    expect(read("lib/woocommerce-orders.ts")).toContain("parentSku: sku && sku !== parentSku ? null : parentSku || null,");
    expect(read("app/dashboard/envios/aliclik/actions.ts")).toContain(
      "parentSku: shopifySku ? null : (shopifyProduct.parentSku ?? null),",
    );
  });
});

describe("la pantalla", () => {
  const src = read("components/aliclik-catalog.tsx");

  it("tiene la pestaña, con su conteo, y la pinta agrupada", () => {
    expect(src).toContain('["sin_mapear", "mapeados", "sin_swayp", "sin_sku", "todos"]');
    expect(src).toContain("`Sin SKU ${catalogSourceIn(view.source)} (${view.missingSku})`");
    expect(src).toContain('if (filter === "sin_sku" && r.shopifySku) return false;');
    expect(src).toContain("<MissingSkuGroups groups={missingGroups} source={view.source} />");
  });

  it("la fila suelta también dice que el SKU está en el producto", () => {
    expect(src).toContain("está en el producto, no en la");
  });

  it("y el MOM lo dice", () => {
    const mom = read("docs/mom/master-pedidos-v1.md").replace(/\s+/g, " ");
    expect(mom).toContain("**La pestaña «Sin SKU» (17-11-2026).**");
    expect(mom).toContain("El SKU está en el producto, no en la variación");
  });
});
