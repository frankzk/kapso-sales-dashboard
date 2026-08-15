import { describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";
import {
  bandHeight,
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
  code: "KP127579-S02",
  guideCode: "91676459",
  storeName: "Kenku Peru",
  orderName: "#KP127579",
  customerName: "Maritza Huiza",
  items: [{ quantity: 2, name: "Zapatilla urbana", variant: "39-40" }],
  qrPng: QR_PNG,
};

describe("la medida del rótulo del courier no se supone", () => {
  // No hay contrato que fije el tamaño de página que devuelve Shalom: puede
  // llegar A4, puede llegar en etiqueta térmica, y puede cambiar el día que
  // rehagan su plantilla. Un número medido de una muestra habría fallado en
  // silencio —rótulo deformado o cortado, no un error— la primera vez.
  const boxW = PAGE_W - 8 * MM * 2;
  const boxH = maxCourierHeight();

  it("una página A4 se reduce hasta caber entera", () => {
    const scale = fitScale(210 * MM, 297 * MM, boxW, boxH);
    expect(scale).toBeLessThan(1);
    expect(210 * MM * scale).toBeLessThanOrEqual(boxW + 0.01);
    expect(297 * MM * scale).toBeLessThanOrEqual(boxH + 0.01);
  });

  it("conserva la proporción: nunca deforma su etiqueta", () => {
    const w = 100 * MM;
    const h = 150 * MM;
    const scale = fitScale(w, h, boxW, boxH);
    expect((w * scale) / (h * scale)).toBeCloseTo(w / h, 6);
  });

  it("no amplía una etiqueta pequeña", () => {
    // Agrandar un térmico chico hasta llenar la caja lo deja borroso, y su
    // código de barras es lo único que Shalom escanea de verdad.
    expect(fitScale(40 * MM, 30 * MM, boxW, boxH)).toBe(1);
  });

  it("una página degenerada no rompe la división", () => {
    expect(fitScale(0, 0, boxW, boxH)).toBe(1);
    expect(Number.isFinite(fitScale(10, 0, boxW, boxH))).toBe(true);
  });
});

describe("rótulo compuesto de agencia", () => {
  it("sale UNA página de 100 × 150, cualquiera sea la de Shalom", async () => {
    for (const [w, h] of [
      [210, 297], // A4
      [100, 150], // térmica igual a la nuestra
      [80, 50], // térmica chica
      [297, 210], // apaisada
    ]) {
      const pdf = await buildAgencyRotuloPdf(await courierLabel(w!, h!), DATA);
      const out = await PDFDocument.load(pdf);
      expect(out.getPageCount()).toBe(1);
      const page = out.getPage(0);
      expect(page.getWidth()).toBeCloseTo(PAGE_W, 1);
      expect(page.getHeight()).toBeCloseTo(PAGE_H, 1);
    }
  });

  it("la banda nuestra deja sitio de sobra al papel del courier", () => {
    // Quien lee en el mostrador es una persona: la mayor parte del alto es suya.
    expect(maxCourierHeight()).toBeGreaterThan((PAGE_H - 16 * MM) * 0.6);
  });

  it("si el courier manda varias páginas se queda con la primera", async () => {
    // La etiqueta es la primera; lo que sigue suelen ser condiciones del
    // servicio, que no viajan pegadas a la caja.
    const doc = await PDFDocument.create();
    for (const [w, h] of [[100, 150], [210, 297]]) {
      const page = doc.addPage([w! * MM, h! * MM]);
      page.drawRectangle({ x: 4, y: 4, width: w! * MM - 8, height: h! * MM - 8 });
    }
    const pdf = await buildAgencyRotuloPdf(await doc.save(), DATA);
    expect((await PDFDocument.load(pdf)).getPageCount()).toBe(1);
  });

  it("un pedido sin productos sigue imprimiendo", async () => {
    // El rótulo nunca puede faltar por un dato de catálogo: la caja existe.
    const pdf = await buildAgencyRotuloPdf(await courierLabel(100, 150), { ...DATA, items: [] });
    expect((await PDFDocument.load(pdf)).getPageCount()).toBe(1);
  });

  it("sin número de guía no falla: la salida ya se identifica sola", async () => {
    const pdf = await buildAgencyRotuloPdf(await courierLabel(100, 150), {
      ...DATA,
      guideCode: null,
      storeName: null,
      orderName: null,
      customerName: null,
    });
    expect((await PDFDocument.load(pdf)).getPageCount()).toBe(1);
  });

  it("un nombre con emoji no tumba la impresión", async () => {
    // Las fuentes estándar son WinAnsi; un carácter fuera de tabla haría fallar
    // la escritura entera si no se saneara.
    const pdf = await buildAgencyRotuloPdf(await courierLabel(100, 150), {
      ...DATA,
      customerName: "María 🎉 Ñandú",
      items: [{ quantity: 1, name: "Polo 🔥 edición", variant: "M" }],
    });
    expect((await PDFDocument.load(pdf)).getPageCount()).toBe(1);
  });
});

describe("la banda arranca donde termina su etiqueta, no en una altura fija", () => {
  // El fallo que se vio impreso: la primera versión partía la hoja en 88 mm
  // arriba y 46 abajo. El rótulo de Shalom es APAISADO —a todo el ancho ocupa
  // unos 45 mm— así que quedaban ~43 mm de aire muerto en mitad de la etiqueta.
  const SHALOM = { w: 185, h: 100 }; // proporción medida del rótulo real

  it("un rótulo apaisado no llena la caja que se le concedía", () => {
    const alto = courierDrawHeight(SHALOM.w * MM, SHALOM.h * MM);
    expect(alto).toBeLessThan(maxCourierHeight());
    // Y lo que sobra es mucho: justo el hueco que se veía en el papel.
    expect(maxCourierHeight() - alto).toBeGreaterThan(20 * MM);
  });

  it("ese sobrante se lo queda la banda en vez de quedar en blanco", () => {
    // Suma exacta: nada se pierde entre las dos piezas.
    const usable = PAGE_H - 8 * MM * 2;
    const alto = courierDrawHeight(SHALOM.w * MM, SHALOM.h * MM);
    expect(alto + bandHeight(SHALOM.w * MM, SHALOM.h * MM)).toBeCloseTo(usable - 3 * MM, 6);
  });

  it("cuanto más baja su etiqueta, más banda — sin excepción", () => {
    // La relación es monótona: no hay proporción que rompa el reparto.
    const alturas = [40, 60, 100, 150, 297];
    const bandas = alturas.map((h) => bandHeight(210 * MM, h * MM));
    for (let i = 1; i < bandas.length; i += 1) {
      expect(bandas[i]!).toBeLessThanOrEqual(bandas[i - 1]! + 0.001);
    }
  });

  it("una etiqueta muy alta no deja la banda por debajo de su mínimo", () => {
    // A4 vertical es el peor caso: aun así la banda conserva su suelo.
    expect(bandHeight(210 * MM, 297 * MM)).toBeGreaterThanOrEqual(34 * MM - 0.001);
  });
});
