import { describe, expect, it } from "vitest";
import { CODE39_PATTERNS, code39Layout, code39Sanitize } from "@/lib/labels/barcode39";
import { orderBarcodeValue } from "@/lib/labels/rotulo-pdf";

describe("tabla Code 39", () => {
  it("cada carácter son 9 elementos con exactamente 3 anchos", () => {
    // La regla del estándar. Si un patrón se transcribió mal, el lector
    // devolvería otro carácter —o nada— y eso solo se descubre con el pistolete
    // en la mano, delante de una caja ya rotulada.
    for (const [char, pattern] of Object.entries(CODE39_PATTERNS)) {
      expect(pattern, char).toHaveLength(9);
      expect(pattern.split("").filter((bit) => bit === "1"), char).toHaveLength(3);
    }
  });

  it("ningún patrón se repite en dos caracteres", () => {
    const seen = new Set(Object.values(CODE39_PATTERNS));
    expect(seen.size).toBe(Object.keys(CODE39_PATTERNS).length);
  });

  it("los caracteres tienen 2 barras anchas y 1 espacio ancho; $ / + % son la excepción", () => {
    for (const [char, pattern] of Object.entries(CODE39_PATTERNS)) {
      const wideBars = [0, 2, 4, 6, 8].filter((i) => pattern[i] === "1").length;
      expect(wideBars, char).toBe("$/+%".includes(char) ? 0 : 2);
    }
  });
});

describe("code39Sanitize", () => {
  it("mayúsculas y solo el alfabeto del estándar", () => {
    expect(code39Sanitize("kp126875")).toBe("KP126875");
    expect(code39Sanitize("KP-12")).toBe("KP-12");
  });

  it("descarta lo que no sabe codificar en vez de sustituirlo", () => {
    // Sustituir cambiaría el texto que el lector entrega al Excel.
    expect(code39Sanitize("KP#12ñ8")).toBe("KP128");
  });

  it("el delimitador no puede venir en el dato", () => {
    // Un `*` en medio cerraría el símbolo antes de tiempo.
    expect(code39Sanitize("KP*12")).toBe("KP12");
  });

  it("vacío y nulos", () => {
    expect(code39Sanitize(null)).toBe("");
    expect(code39Sanitize("###")).toBe("");
  });
});

describe("code39Layout", () => {
  const innerW = 238; // el ancho útil del rótulo, en puntos

  it("sin nada que codificar no dibuja nada", () => {
    expect(code39Layout("", innerW)).toBeNull();
    expect(code39Layout("###", innerW)).toBeNull();
  });

  it("empieza y termina en barra, y alterna barra/espacio", () => {
    const layout = code39Layout("KP1", innerW)!;
    expect(layout).toBeTruthy();
    // 5 caracteres (`*KP1*`) × 5 barras cada uno.
    expect(layout.bars).toHaveLength(25);
    expect(layout.bars[0]!.x).toBe(0);
    const last = layout.bars.at(-1)!;
    expect(last.x + last.width).toBeCloseTo(layout.width, 6);
  });

  it("nunca se sale del ancho disponible", () => {
    for (const value of ["KP1", "KP126875", "AUR175061", "KP1268751234567890"]) {
      const layout = code39Layout(value, innerW)!;
      expect(layout.width, value).toBeLessThanOrEqual(innerW + 1e-9);
    }
  });

  it("un pedido corto no se dibuja con barras absurdas", () => {
    // Sin tope, `*KP1*` se comería el ancho del rótulo.
    const layout = code39Layout("KP1", innerW)!;
    expect(layout.narrow).toBeLessThanOrEqual(1.8);
  });

  it("un pedido largo baja a 2:1 antes que estrechar la barra fina", () => {
    // Por debajo de ~0,25 mm la térmica muerde la barra fina y el lector falla.
    const largo = code39Layout("KP1268751234567890AB", innerW)!;
    expect(largo).toBeTruthy();
    expect(largo.narrow).toBeGreaterThanOrEqual(0.72);
    const anchoRelativo = largo.bars.map((bar) => bar.width / largo.narrow);
    expect(Math.max(...anchoRelativo)).toBeCloseTo(2, 6);
  });

  it("la zona muda exigida cabe en el margen del rótulo", () => {
    // 10 barras estrechas a cada lado. El rótulo tiene 8 mm (22,7 pt) de margen.
    const layout = code39Layout("KP1", innerW)!;
    expect(layout.quietZone).toBeLessThanOrEqual(8 * (72 / 25.4));
  });
});

describe("orderBarcodeValue", () => {
  it("el pedido de Shopify, sin el numeral", () => {
    expect(orderBarcodeValue("#KP126875", "KP126875-S01")).toBe("KP126875");
  });

  it("nunca la salida: el sufijo -Sxx no entra en el código de barras", () => {
    // Es la razón de ser del cambio: el Excel del almacén se cuadra por pedido.
    expect(orderBarcodeValue("#AUR175061", "AUR175061-S02-ALICLIK")).not.toContain("-S02");
  });

  it("sin order_name lo deriva del código de salida", () => {
    expect(orderBarcodeValue(null, "KP126875-S01")).toBe("KP126875");
    expect(orderBarcodeValue("", "KP126875-S03-SHALOM")).toBe("KP126875");
  });

  it("un código de guía del courier NO se pistolea como si fuera el pedido", () => {
    // Pistolear una guía dentro de la columna del pedido contamina el Excel en
    // silencio; mejor un rótulo sin barras.
    expect(orderBarcodeValue(null, "1234567890")).toBe("");
    expect(orderBarcodeValue(null, "G-1")).toBe("");
    expect(orderBarcodeValue(null, "")).toBe("");
  });
});
