import { describe, expect, it } from "vitest";
import {
  campaignMatchesProduct,
  campaignProductKey,
  campaignProductOptions,
} from "@/lib/metrics";

// El filtro cruza dos nombres que NUNCA vienen escritos igual: el anunciado lo
// teclea el equipo y el vendido sale de la línea de pedido de Shopify. Si la
// clave no los junta, el desplegable muestra el mismo producto dos veces y cada
// entrada filtra la mitad de los anuncios.

function row(promoted: string | null, sold: string[] = []) {
  return {
    promotedProductName: promoted,
    productMix: sold.map((title) => ({ title, sku: null, orders: 1, units: 1 })),
  };
}

describe("campaignProductKey", () => {
  it("junta la marca registrada, que solo trae el nombre de Shopify", () => {
    expect(campaignProductKey("Shampoo Biru™ Anticaspa")).toBe(
      campaignProductKey("Shampoo Biru Anticaspa"),
    );
  });

  it("junta acentos, guion largo y espacios de más", () => {
    expect(campaignProductKey("Sérum Tea Tree — Ginger")).toBe(
      campaignProductKey("serum  tea tree - ginger"),
    );
  });

  it("un nombre vacío no es una clave", () => {
    expect(campaignProductKey(null)).toBe("");
    expect(campaignProductKey("   ")).toBe("");
  });
});

describe("campaignProductOptions", () => {
  it("sin el toggle, el catálogo son solo los productos ANUNCIADOS", () => {
    // Ofrecer un producto que nadie anuncia devolvería cero filas sin explicar
    // por qué: el toggle apagado no sabe buscar por producto vendido.
    const options = campaignProductOptions(
      [row("Shampoo Biru", ["BeeWax"]), row(null, ["Nattokinase"])],
      false,
    );
    expect(options.map((option) => option.label)).toEqual(["Shampoo Biru"]);
  });

  it("con el toggle entran también los que solo se venden", () => {
    const options = campaignProductOptions(
      [row("Shampoo Biru", ["BeeWax"]), row(null, ["Nattokinase"])],
      true,
    );
    expect(options.map((option) => option.label).sort()).toEqual([
      "BeeWax",
      "Nattokinase",
      "Shampoo Biru",
    ]);
  });

  it("cuenta anuncios, no pedidos: dos pedidos del mismo producto son un anuncio", () => {
    const options = campaignProductOptions([row(null, ["BeeWax", "BeeWax™"])], true);
    expect(options).toHaveLength(1);
    expect(options[0]!.soldAds).toBe(1);
  });

  it("muestra la grafía más frecuente entre los anuncios", () => {
    const options = campaignProductOptions(
      [row("Shampoo Biru™"), row("Shampoo Biru"), row("Shampoo Biru")],
      false,
    );
    expect(options[0]!.label).toBe("Shampoo Biru");
  });

  it("ordena por cuántos anuncios lo tocan", () => {
    const options = campaignProductOptions([row("A"), row("B"), row("B")], false);
    expect(options.map((option) => option.label)).toEqual(["B", "A"]);
  });
});

describe("campaignMatchesProduct", () => {
  const key = campaignProductKey("Shampoo Biru");

  it("sin clave, pasan todas las filas", () => {
    expect(campaignMatchesProduct(row("Otra cosa"), "", false)).toBe(true);
  });

  it("el anunciado entra siempre", () => {
    expect(campaignMatchesProduct(row("Shampoo Biru™"), key, false)).toBe(true);
  });

  it("el que solo lo VENDE queda fuera sin el toggle, y entra con él", () => {
    // Es la pregunta que destapa canibalización: un anuncio que promociona una
    // cosa y termina vendiendo otra. Con el toggle apagado no debe aparecer,
    // porque ahí se está preguntando «qué anuncio promociona esto».
    const canibaliza = row("Nattokinase", ["Shampoo Biru"]);
    expect(campaignMatchesProduct(canibaliza, key, false)).toBe(false);
    expect(campaignMatchesProduct(canibaliza, key, true)).toBe(true);
  });

  it("un anuncio ajeno no entra ni con el toggle", () => {
    expect(campaignMatchesProduct(row("Nattokinase", ["BeeWax"]), key, true)).toBe(false);
  });
});
