import { describe, expect, it } from "vitest";
import {
  labelItemsFor,
  parseLabelItemsFromText,
  parseLabelLineItems,
} from "@/lib/labels/line-items";

describe("parseLabelLineItems", () => {
  it("saca cantidad, título y variante de las líneas de Shopify", () => {
    const items = parseLabelLineItems([
      { title: "Colágeno Hidrolizado", quantity: 2, variant_title: "300g" },
    ]);
    expect(items).toEqual([{ quantity: 2, name: "Colágeno Hidrolizado", variant: "300g" }]);
  });

  it("conserva la variante que distingue líneas del MISMO producto", () => {
    // Caso real: tres tallas del mismo título. Sin la variante, el almacén no
    // sabe qué empacar.
    const items = parseLabelLineItems([
      { title: "SoftFlex Plantillas", quantity: 1, variant_title: "37-38:24cm" },
      { title: "SoftFlex Plantillas", quantity: 1, variant_title: "39-40:25cm" },
      { title: "SoftFlex Plantillas", quantity: 1, variant_title: "41-42:26cm" },
    ]);
    expect(items).toHaveLength(3);
    expect(items.map((i) => i.variant)).toEqual(["37-38:24cm", "39-40:25cm", "41-42:26cm"]);
  });

  it("agrupa el mismo producto y variante sumando unidades", () => {
    const items = parseLabelLineItems([
      { title: "Omega 3", quantity: 1, variant_title: null },
      { title: "Omega 3", quantity: 2, variant_title: null },
    ]);
    expect(items).toEqual([{ quantity: 3, name: "Omega 3", variant: null }]);
  });

  it("ignora la variante ficticia de Shopify", () => {
    const items = parseLabelLineItems([
      { title: "Producto simple", quantity: 1, variant_title: "Default Title" },
    ]);
    expect(items[0]!.variant).toBeNull();
  });

  it("cantidad inválida o ausente cuenta como 1", () => {
    expect(parseLabelLineItems([{ title: "X" }])[0]!.quantity).toBe(1);
    expect(parseLabelLineItems([{ title: "X", quantity: 0 }])[0]!.quantity).toBe(1);
    expect(parseLabelLineItems([{ title: "X", quantity: "3" }])[0]!.quantity).toBe(3);
  });

  it("tolera basura sin romper el rótulo", () => {
    expect(parseLabelLineItems(null)).toEqual([]);
    expect(parseLabelLineItems("no es un array")).toEqual([]);
    expect(parseLabelLineItems([null, 3])).toEqual([]);
  });

  it("sin título usa un nombre genérico en vez de quedar vacío", () => {
    expect(parseLabelLineItems([{ quantity: 2 }])[0]!.name).toBe("Producto");
  });
});

describe("parseLabelItemsFromText (salidas sin pedido vinculado)", () => {
  it("reconstruye cantidad del formato que escribe el sistema", () => {
    expect(parseLabelItemsFromText("Colágeno ×2 | Magnesio")).toEqual([
      { quantity: 2, name: "Colágeno", variant: null },
      { quantity: 1, name: "Magnesio", variant: null },
    ]);
  });
  it("vacío o nulo no produce líneas", () => {
    expect(parseLabelItemsFromText(null)).toEqual([]);
    expect(parseLabelItemsFromText("   ")).toEqual([]);
  });
});

describe("labelItemsFor", () => {
  it("prefiere las líneas del pedido sobre el texto guardado", () => {
    const items = labelItemsFor(
      [{ title: "Del pedido", quantity: 1, variant_title: "M" }],
      "Del texto ×5",
    );
    expect(items).toEqual([{ quantity: 1, name: "Del pedido", variant: "M" }]);
  });
  it("cae al texto guardado cuando no hay líneas del pedido", () => {
    expect(labelItemsFor(null, "Del texto ×5")).toEqual([
      { quantity: 5, name: "Del texto", variant: null },
    ]);
  });
});
