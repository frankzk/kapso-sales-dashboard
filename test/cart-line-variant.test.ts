// Owner, 19-11-2026: «¿qué hacemos para que no vuelva a suceder?». #AUR901173
// (y #AUR900973 el 16-11) venían del formulario abandonado de COD Core con el
// producto con variaciones y «variante: sin elegir»: la clienta no eligió talla
// ni color. «Generar pedido» lo mandaba por el SKU del padre, WooCommerce creaba
// el pedido y Kapta lo borraba. Ahora el formulario lo marca y pide elegir la
// variante, y el servidor lo frena ANTES de crear nada.

import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { cartLineNeedsVariant, NEEDS_VARIANT_TEXT, variableLinesProblem } from "@/lib/cart-line-variant";
import { wooSkuIsOnlyVariable, wooVariableSkuLines } from "@/lib/woocommerce-orders";

const read = (p: string) => readFileSync(p, "utf8");

// La línea tal como la guardó la ingesta de COD Core (`draft_orders.line_items`).
const codCoreLine = {
  sku: "SOYKORA-POSTUREFIT",
  price: 99,
  title: "PostureFit Brasier Corrector de Postura con Soporte Ergonómico SoyKora®",
  quantity: 1,
  product_id: "11681",
  variant_id: null,
  variant_title: "sin elegir",
};

describe("la línea del carrito sin su variante", () => {
  it("«sin elegir» y sin variación: hay que elegirla", () => {
    expect(cartLineNeedsVariant(codCoreLine)).toBe(true);
    expect(cartLineNeedsVariant({ ...codCoreLine, variant_title: "  Sin Elegir " })).toBe(true);
  });

  it("con su variante, o un producto sin variaciones, no", () => {
    expect(cartLineNeedsVariant({ ...codCoreLine, variant_title: "M / Negro", variant_id: "11690" })).toBe(false);
    expect(cartLineNeedsVariant({ ...codCoreLine, variant_id: "11690" })).toBe(false);
    expect(cartLineNeedsVariant({ ...codCoreLine, variant_title: null })).toBe(false);
    expect(cartLineNeedsVariant(null)).toBe(false);
  });

  it("el aviso y el rechazo dicen qué falta y que no se creó nada", () => {
    expect(NEEDS_VARIANT_TEXT).toMatch(/^Falta elegir la variante \(talla, color…\)/);
    expect(variableLinesProblem([])).toBeNull();
    expect(variableLinesProblem([codCoreLine.title])).toBe(
      `Pedido NO generado: «${codCoreLine.title}» es un producto con variaciones y falta elegir la variante (talla, color…). ` +
        "No se creó nada en la tienda. Quítalo y agrégalo desde «Producto del catálogo» eligiendo la variante.",
    );
  });
});

describe("el servidor lo frena antes de crear el pedido en WooCommerce", () => {
  it("el SKU es solo el del producto con variaciones", () => {
    expect(wooSkuIsOnlyVariable("SOYKORA-POSTUREFIT", [{ type: "variable", sku: "SOYKORA-POSTUREFIT" }])).toBe(true);
    // Si una variación o un producto simple tiene ese mismo SKU, WooCommerce lo resuelve: no se frena.
    expect(wooSkuIsOnlyVariable("X", [{ type: "variable", sku: "X" }, { type: "variation", sku: "X" }])).toBe(false);
    expect(wooSkuIsOnlyVariable("X", [{ type: "simple", sku: "X" }])).toBe(false);
    expect(wooSkuIsOnlyVariable("X", [{ type: "variable", sku: "X-M" }])).toBe(false);
    expect(wooSkuIsOnlyVariable("X", [])).toBe(false);
  });

  const site = (products: Record<string, { type: string; sku: string }[]>, fail = false) => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      if (fail) throw new Error("se cortó");
      const url = new URL(String(input));
      return Response.json(products[url.searchParams.get("sku") ?? ""] ?? []);
    });
    return { fetchImpl, client: { siteUrl: "https://aurela.pe", consumerKey: "ck_x", consumerSecret: "cs_x", fetchImpl: fetchImpl as unknown as typeof fetch } };
  };

  it("pregunta solo por las líneas que van por SKU y devuelve las del producto con variaciones", async () => {
    const { fetchImpl, client } = site({
      "SOYKORA-POSTUREFIT": [{ type: "variable", sku: "SOYKORA-POSTUREFIT" }],
      "SOYKORA-POSTUREFIT-M-NEGRO": [{ type: "variation", sku: "SOYKORA-POSTUREFIT-M-NEGRO" }],
    });
    const out = await wooVariableSkuLines(client, [
      { title: codCoreLine.title, sku: "SOYKORA-POSTUREFIT", variantId: null },
      { title: "Otra · M / Negro", sku: "SOYKORA-POSTUREFIT-M-NEGRO", variantId: null },
      // Del buscador: ya trae su variación, no se pregunta.
      { title: "Del buscador", sku: "OTRO", variantId: "woo:11690" },
    ]);
    expect(out).toEqual([codCoreLine.title]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("si WooCommerce no responde, no frena (queda la comprobación de después)", async () => {
    const { client } = site({}, true);
    await expect(wooVariableSkuLines(client, [{ title: "A", sku: "A", variantId: null }])).resolves.toEqual([]);
  });

  it("generateWooOrder lo mira antes del candado y de crear el pedido", () => {
    const src = read("app/dashboard/leads/actions.ts");
    const at = src.indexOf("const sinVariante = variableLinesProblem(await wooVariableSkuLines(wooSaleClient(woo), lineItemsInput));");
    expect(at).toBeGreaterThan(0);
    expect(at).toBeLessThan(src.indexOf("const guard = await claimWooFormSale("));
    expect(src).toContain("...(cartLineNeedsVariant(li) ? { needsVariant: true } : {}),");
  });
});

describe("el formulario pide elegir la variante", () => {
  it("la línea dice qué falta, ofrece «Elegir variante» y no deja generar el pedido", () => {
    const drawer = read("components/leads-drawer.tsx");
    expect(drawer).toContain("<span>{NEEDS_VARIANT_TEXT}</span>");
    expect(drawer).toContain("Elegir variante");
    expect(drawer).toContain("!items.some((it) => it.needsVariant);");
    // La variante elegida reemplaza la línea con su cantidad.
    expect(drawer).toContain("x.map((it) => (it.key === replaceKey ? { ...it, ...picked, needsVariant: false } : it))");
  });
});
