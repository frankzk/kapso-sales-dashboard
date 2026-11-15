// GF Courier por API (MOM §29.17): exportación del catálogo de la tienda para importarlo en GF.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildGfCatalogExport, gfCatalogCsv, gfCatalogName } from "@/lib/gf-courier-catalog";

describe("catálogo de la tienda → GF", () => {
  it("una fila por SKU con «título – variante»; sin SKU y repetidos se informan", () => {
    const r = buildGfCatalogExport([
      { shopifySku: "BOX-4XL", title: "Bóxer Confort (Pack de 4)", variantTitle: "4XL" },
      { shopifySku: " box-4xl ", title: "Bóxer Confort (Pack de 4)", variantTitle: "4XL copia" },
      { shopifySku: "FAJ-M", title: "Faja", variantTitle: "Default Title" },
      { shopifySku: null, title: "Gel", variantTitle: "200 ml" },
      { shopifySku: "__SHOPIFY_NO_SKU__:9", title: "Crema", variantTitle: null },
    ]);
    expect(r.rows).toEqual([{ sku: "BOX-4XL", name: "Bóxer Confort (Pack de 4) – 4XL" }, { sku: "FAJ-M", name: "Faja" }]);
    expect(r.withoutSku).toEqual(["Gel – 200 ml", "Crema"]);
    expect(r.repeatedSkus).toEqual(["box-4xl"]);
  });
  it("el CSV cita comas y comillas y no altera el SKU", () => {
    expect(gfCatalogCsv([{ sku: "-A1", name: 'Faja "Pro", talla M' }])).toBe('sku,nombre\r\n-A1,"Faja ""Pro"", talla M"\r\n');
    expect(gfCatalogName("Faja talla M", "M")).toBe("Faja talla M");
  });
  it("la descarga pide administrar la tienda y la sección la enlaza", () => {
    const route = readFileSync(join(process.cwd(), "app/api/stores/[storeId]/gf-catalog/route.ts"), "utf8");
    expect(route).toContain('hasOrgPermission(store.org_id, "stores.manage")');
    expect(readFileSync(join(process.cwd(), "components/store-settings.tsx"), "utf8")).toContain("/gf-catalog");
  });
});

describe("comparar con el catálogo de GF", () => {
  it("faltantes, agotados y los que solo tiene GF, sin distinguir mayúsculas", async () => {
    const { compareGfCatalog } = await import("@/lib/gf-courier-catalog");
    const c = compareGfCatalog(
      [{ sku: "FAJ-M", name: "Faja M" }, { sku: "faj-l", name: "Faja L" }, { sku: "GEL", name: "Gel" }],
      [{ merchant_sku: "FAJ-M", name: "Faja M", sales_status: "OUT_OF_STOCK" }, { merchant_sku: "FAJ-L", name: "Faja L", sales_status: "IN_STOCK" }, { merchant_sku: "VIEJO", name: "Viejo" }],
    );
    expect(c.missingInGf).toEqual([{ sku: "GEL", name: "Gel" }]);
    expect(c.outOfStock).toEqual([{ sku: "FAJ-M", name: "Faja M" }]);
    expect(c.onlyInGf).toEqual(["VIEJO"]);
  });
  it("la descarga «solo los que faltan» y el botón «Comparar catálogo con GF» existen", () => {
    expect(readFileSync(join(process.cwd(), "app/api/stores/[storeId]/gf-catalog/route.ts"), "utf8")).toContain('"only") === "missing"');
    const ui = readFileSync(join(process.cwd(), "components/store-settings.tsx"), "utf8");
    expect(ui).toContain("Comparar catálogo con GF");expect(ui).toContain("?only=missing");
  });
});
