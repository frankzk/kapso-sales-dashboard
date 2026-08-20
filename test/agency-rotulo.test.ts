import { describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";
import {
  agencyInnerWidth,
  agencyPageHeight,
  bandContentHeight,
  buildAgencyRotuloPdf,
  courierDrawHeight,
  fitScale,
  maxCourierHeight,
} from "@/lib/labels/agency-rotulo";
import { MM, PAGE_H, PAGE_W } from "@/lib/labels/rotulo-pdf";

// Un PNG 1×1 válido: el QR real lo pinta `qrcode`, acá solo hace falta que
// `embedPng` no reviente.
const QR_PNG = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    "base64",
  ),
);

/**
 * Un PDF que se parece al de un courier: página del tamaño pedido y algo
 * dibujado dentro. Lo dibujado importa — `embedPdf` rechaza una página sin
 * contenido, y una hoja vacía no representa a ningún rótulo real.
 */
async function courierLabel(widthMm: number, heightMm: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([widthMm * MM, heightMm * MM]);
  page.drawRectangle({ x: 4, y: 4, width: widthMm * MM - 8, height: heightMm * MM - 8 });
  return doc.save();
}

const DATA = {
  code: "KP128875-S01",
  guideCode: "92594863",
  storeName: "Kenku Peru",
  orderName: "#KP128875",
  customerName: "Sully Alvarez Nuñez",
  items: [{ quantity: 1, name: "SUPER HUMAN Ethiopian Black Seed", variant: null }],
  qrPng: QR_PNG,
};

/** La proporción medida del rótulo real de Shalom: apaisado, ~1,85:1. */
const SHALOM = { w: 185 * MM, h: 100 * MM };

describe("la medida del rótulo del courier no se supone", () => {
  const boxW = agencyInnerWidth();
  const boxH = maxCourierHeight(DATA.items, true);

  it("una página A4 se reduce hasta caber entera", () => {
    const scale = fitScale(210 * MM, 297 * MM, boxW, maxCourierHeight(DATA.items, true));
    expect(scale).toBeLessThan(1);
    expect(297 * MM * scale).toBeLessThanOrEqual(maxCourierHeight() + 0.01);
  });

  it("conserva la proporción: nunca deforma su etiqueta", () => {
    const scale = fitScale(SHALOM.w, SHALOM.h, boxW, maxCourierHeight(DATA.items, true));
    expect((SHALOM.w * scale) / (SHALOM.h * scale)).toBeCloseTo(SHALOM.w / SHALOM.h, 6);
  });

  it("no amplía una etiqueta pequeña", () => {
    expect(fitScale(40 * MM, 30 * MM, boxW, maxCourierHeight(DATA.items, true))).toBe(1);
  });

  it("una página degenerada no rompe la división", () => {
    expect(fitScale(0, 0, boxW, maxCourierHeight(DATA.items, true))).toBe(1);
    expect(Number.isFinite(fitScale(10, 0, boxW, maxCourierHeight(DATA.items, true)))).toBe(true);
  });
});

describe("margen estrecho: al imprimir 4 por hoja manda el ancho", () => {
  // En A4 la celda de 4-up son 105 × 148,5 mm y nuestra página mide 100 de
  // ancho: sale casi 1:1, así que la etiqueta de Shalom es tan grande como el
  // ancho útil que le dejemos. Con 8 mm de margen eran 84; ahora son 92.
  it("el ancho útil es 92 mm, no 84", () => {
    expect(agencyInnerWidth() / MM).toBeCloseTo(92, 5);
  });

  it("la etiqueta de Shalom sale ~10% más alta que con los márgenes anchos", () => {
    const ahora = courierDrawHeight(SHALOM.w, SHALOM.h);
    const antes = SHALOM.h * fitScale(SHALOM.w, SHALOM.h, (PAGE_W - 8 * MM * 2), 97 * MM);
    expect(ahora).toBeGreaterThan(antes);
    expect(ahora / antes).toBeCloseTo(92 / 84, 2);
  });
});

describe("la página se ajusta al contenido", () => {
  it("con el rótulo real de Shalom deja de medir 150 mm", () => {
    // Antes eran 150 fijos con ~50 en blanco al pie; impreso 4 por hoja, ese
    // blanco se llevaba un tercio de la celda sin decir nada.
    const alto = agencyPageHeight(SHALOM.w, SHALOM.h, DATA.items, true);
    expect(alto).toBeLessThan(PAGE_H);
    expect(PAGE_H - alto).toBeGreaterThan(30 * MM);
  });

  it("es exactamente la suma de sus partes: no sobra ni falta", () => {
    const alto = agencyPageHeight(SHALOM.w, SHALOM.h, DATA.items, true);
    const partes =
      4 * MM * 2 + courierDrawHeight(SHALOM.w, SHALOM.h) + 3 * MM + 3.5 * MM +
      bandContentHeight(DATA.items, true);
    expect(alto).toBeCloseTo(partes, 6);
  });

  it("el QR marca el suelo de la banda: los productos van topados en 6 líneas", () => {
    // Esto es una ETIQUETA, no una factura. Con el tope de líneas el bloque de
    // productos nunca llega a los 26 mm del QR, así que el suelo de la banda lo
    // pone el QR y el papel no se estira por un pedido largo — lo que sobra se
    // dice con «+ N productos mas» y el detalle completo está en el pedido.
    const uno = agencyPageHeight(SHALOM.w, SHALOM.h, DATA.items, true);
    const muchos = agencyPageHeight(
      SHALOM.w,
      SHALOM.h,
      Array.from({ length: 8 }, (_, i) => ({
        quantity: i + 1,
        name: `Producto ${i + 1}`,
        variant: "M",
      })),
      true,
    );
    expect(muchos).toBe(uno);
    expect(bandContentHeight(DATA.items, true)).toBeGreaterThan(26 * MM);
  });

  it("sin destinatario la página encoge esa línea", () => {
    expect(agencyPageHeight(SHALOM.w, SHALOM.h, DATA.items, false)).toBeLessThan(
      agencyPageHeight(SHALOM.w, SHALOM.h, DATA.items, true),
    );
  });

  it("una etiqueta más alta da una página más alta, sin excepción", () => {
    const altos = [30, 60, 100, 150, 297].map((h) =>
      agencyPageHeight(210 * MM, h * MM, DATA.items, true),
    );
    for (let i = 1; i < altos.length; i += 1) {
      expect(altos[i]!).toBeGreaterThanOrEqual(altos[i - 1]! - 0.001);
    }
  });
});

describe("rótulo compuesto de agencia", () => {
  it("sale UNA página de 100 mm de ancho, cualquiera sea la de Shalom", async () => {
    for (const [w, h] of [
      [210, 297], // A4
      [185, 100], // el real de Shalom
      [80, 50], // térmica chica
      [297, 210], // apaisada
    ]) {
      const pdf = await buildAgencyRotuloPdf(await courierLabel(w!, h!), DATA);
      const out = await PDFDocument.load(pdf);
      expect(out.getPageCount()).toBe(1);
      const page = out.getPage(0);
      expect(page.getWidth()).toBeCloseTo(PAGE_W, 1);
      // El alto ya no es fijo: sigue al contenido, y nunca pasa del papel.
      expect(page.getHeight()).toBeLessThanOrEqual(PAGE_H + 0.01);
      expect(page.getHeight()).toBeGreaterThan(40 * MM);
    }
  });

  it("si el courier manda varias páginas se queda con la primera", async () => {
    const doc = await PDFDocument.create();
    for (const [w, h] of [[185, 100], [210, 297]]) {
      const page = doc.addPage([w! * MM, h! * MM]);
      page.drawRectangle({ x: 4, y: 4, width: w! * MM - 8, height: h! * MM - 8 });
    }
    const pdf = await buildAgencyRotuloPdf(await doc.save(), DATA);
    expect((await PDFDocument.load(pdf)).getPageCount()).toBe(1);
  });

  it("un pedido sin productos sigue imprimiendo", async () => {
    const pdf = await buildAgencyRotuloPdf(await courierLabel(185, 100), { ...DATA, items: [] });
    expect((await PDFDocument.load(pdf)).getPageCount()).toBe(1);
  });

  it("sin número de guía no falla: la salida ya se identifica sola", async () => {
    const pdf = await buildAgencyRotuloPdf(await courierLabel(185, 100), {
      ...DATA,
      guideCode: null,
      storeName: null,
      orderName: null,
      customerName: null,
    });
    expect((await PDFDocument.load(pdf)).getPageCount()).toBe(1);
  });

  it("un nombre con emoji no tumba la impresión", async () => {
    const pdf = await buildAgencyRotuloPdf(await courierLabel(185, 100), {
      ...DATA,
      customerName: "María 🎉 Ñandú",
      items: [{ quantity: 1, name: "Polo 🔥 edición", variant: "M" }],
    });
    expect((await PDFDocument.load(pdf)).getPageCount()).toBe(1);
  });
});
