import { describe, expect, it } from "vitest";
import { buildProductos, normalizeSku } from "@/lib/swayp-productos";

/**
 * Los productos de la guía van por CÓDIGO, no por nombre. Swayp acepta las dos
 * formas y descarta la segunda: «tiende a ser inestable porque se busca por
 * nombre y no por código». Un nombre que deja de coincidir no da error — deja
 * de descontar stock, en silencio, hasta que el inventario no cuadre.
 */
const mapa = new Map([
  ["765545233", { codbar: "AURE001", nombre: "CANDIDA CLEANSE" }],
  ["PRUEBA-ETHIOPIAN", { codbar: "AURE003", nombre: "ETHIOPIAN OIL" }],
  ["33478034", { codbar: "AURE011", nombre: "TURKESTERONE" }],
]);

describe("buildProductos", () => {
  it("traduce las líneas del pedido a codbar + cantidad", () => {
    const r = buildProductos(
      [
        { sku: "765545233", title: "Cándida Cleanse - Fórmula Ayurvédica…", quantity: 2 },
        { sku: "33478034", title: "Turkesterone - Cápsulas…", quantity: 1 },
      ],
      mapa,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.productos).toEqual([
      { codbar: "AURE001", cantidad: 2, nombre: "CANDIDA CLEANSE" },
      { codbar: "AURE011", cantidad: 1, nombre: "TURKESTERONE" },
    ]);
  });

  describe("no adivina", () => {
    it("un producto sin mapear se reporta, no se manda con codbar vacío", () => {
      const r = buildProductos(
        [
          { sku: "765545233", title: "Cándida Cleanse", quantity: 1 },
          { sku: "64565434", title: "Pulsera Magnética de Cobre", quantity: 1 },
        ],
        mapa,
      );
      expect(r.ok).toBe(false);
      if (r.ok) return;
      // El TÍTULO, que es lo que la operadora reconoce; el SKU no le dice nada.
      expect(r.faltan).toEqual(["Pulsera Magnética de Cobre"]);
    });

    it("los reporta TODOS, no solo el primero", () => {
      // Que la operadora los mapee de una vez y no de uno en uno.
      const r = buildProductos(
        [
          { sku: "AAA", title: "Uno", quantity: 1 },
          { sku: "BBB", title: "Dos", quantity: 1 },
        ],
        mapa,
      );
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.faltan).toEqual(["Uno", "Dos"]);
    });

    it("una línea sin SKU también falta: no hay nada que buscar", () => {
      const r = buildProductos([{ sku: null, title: "Sin SKU", quantity: 1 }], mapa);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.faltan).toEqual(["Sin SKU"]);
    });

    it("un pedido sin líneas no devuelve productos vacíos", () => {
      // `productos: []` lo aceptaría Swayp sin quejarse y la guía saldría sin
      // descontar nada.
      const r = buildProductos([], mapa);
      expect(r.ok).toBe(false);
    });
  });

  describe("cantidades", () => {
    it("agrupa dos líneas del mismo codbar en una sola", () => {
      // Dos variantes que mapean al mismo producto tienen que llegar como
      // cantidad 3, no como dos ítems que Swayp descontaría por separado.
      const r = buildProductos(
        [
          { sku: "765545233", title: "Cándida Cleanse", quantity: 2 },
          { sku: "765545233", title: "Cándida Cleanse", quantity: 1 },
        ],
        mapa,
      );
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.productos).toEqual([{ codbar: "AURE001", cantidad: 3, nombre: "CANDIDA CLEANSE" }]);
    });

    it("nunca manda 0: sería decirle a Swayp que no descuente", () => {
      for (const quantity of [0, null, undefined, -3, Number.NaN]) {
        const r = buildProductos([{ sku: "765545233", title: "X", quantity }], mapa);
        expect(r.ok, String(quantity)).toBe(true);
        if (r.ok) expect(r.productos[0]!.cantidad, String(quantity)).toBe(1);
      }
    });

    it("trunca los decimales en vez de mandarlos", () => {
      const r = buildProductos([{ sku: "765545233", title: "X", quantity: 2.7 }], mapa);
      if (r.ok) expect(r.productos[0]!.cantidad).toBe(2);
    });
  });

  describe("normalización del SKU", () => {
    // La misma que guarda la migración 0151. Sin ella «abc» y «ABC » serían dos
    // entradas y una nunca se encontraría — guía sin descuento, en silencio.
    it("encuentra el mapeo con espacios y minúsculas", () => {
      const r = buildProductos([{ sku: "  765545233 ", title: "X", quantity: 1 }], mapa);
      expect(r.ok).toBe(true);
      const r2 = buildProductos([{ sku: "prueba-ethiopian", title: "X", quantity: 1 }], mapa);
      expect(r2.ok).toBe(true);
    });

    it("normalizeSku recorta y sube a mayúsculas", () => {
      expect(normalizeSku("  abc ")).toBe("ABC");
      expect(normalizeSku(null)).toBe("");
      expect(normalizeSku(undefined)).toBe("");
    });
  });

  describe("el nombre", () => {
    it("manda el de Swayp para que su panel muestre su propio catálogo", () => {
      const r = buildProductos([{ sku: "765545233", title: "Nuestro título largo", quantity: 1 }], mapa);
      if (r.ok) expect(r.productos[0]!.nombre).toBe("CANDIDA CLEANSE");
    });

    it("cae al nuestro cuando el mapeo no guardó nombre", () => {
      const sinNombre = new Map([["X", { codbar: "AURE099", nombre: null }]]);
      const r = buildProductos([{ sku: "X", title: "Nuestro título", quantity: 1 }], sinNombre);
      if (r.ok) expect(r.productos[0]!.nombre).toBe("Nuestro título");
    });

    it("y al codbar cuando no hay ninguno de los dos", () => {
      const sinNombre = new Map([["X", { codbar: "AURE099" }]]);
      const r = buildProductos([{ sku: "X", title: "  ", quantity: 1 }], sinNombre);
      if (r.ok) expect(r.productos[0]!.nombre).toBe("AURE099");
    });
  });
});
