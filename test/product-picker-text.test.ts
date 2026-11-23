// Owner, 23-11-2026: «¿no aparece la astaxantina?». La astaxantina es de Kenku y
// el lead era de Aurela; el buscador decía «o falta el permiso read_products»,
// que es de Shopify y no explicaba nada en WooCommerce.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { productPickerEmptyText } from "@/lib/product-picker-text";

const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");

describe("el buscador sin resultados dice en qué catálogo buscó", () => {
  it("WooCommerce: el catálogo publicado de la tienda del lead", () => {
    expect(productPickerEmptyText("woocommerce", "Aurela")).toBe(
      "No está en el catálogo publicado de WooCommerce de Aurela. Si debería estar, publícalo allí con su SKU.",
    );
    expect(productPickerEmptyText("woocommerce", null)).toContain("de WooCommerce de esta tienda.");
    expect(productPickerEmptyText("woocommerce", "  ")).toContain("de WooCommerce de esta tienda.");
  });

  it("Shopify sigue con su aviso", () => {
    expect(productPickerEmptyText("shopify", "Kenku Peru")).toBe("Sin resultados (o falta el permiso read_products).");
    expect(productPickerEmptyText(null, null)).toBe("Sin resultados (o falta el permiso read_products).");
  });

  it("el formulario pasa la plataforma y el nombre de la tienda al buscador", () => {
    const ui = read("components/leads-drawer.tsx");
    expect(ui).toContain("{productPickerEmptyText(platform, storeName)}");
    expect(ui).toContain("setStoreName(res.storeName ?? null);");
    expect(ui).toMatch(/<ProductPicker\s+leadId=\{leadId\}\s+currency=\{currency\}\s+platform=\{platform\}\s+storeName=\{storeName\}/);
    const actions = read("app/dashboard/leads/actions.ts");
    expect(actions).toContain('admin.from("stores").select("name").eq("id", ctx.storeId).maybeSingle()');
  });
});
