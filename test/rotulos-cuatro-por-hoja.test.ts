// Cuatro rótulos por hoja A4 para «Imprimir los que faltan» de Swayp Lima (owner, 17-11-2026).
import { describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";
import { MM, PAGE_H, PAGE_W, rotulosFourPerPage } from "@/lib/labels/rotulo-pdf";
import { swaypLabelsHref } from "@/lib/warehouse-swayp";

async function labels(n: number) {
  const doc = await PDFDocument.create();
  for (let i = 0; i < n; i++) doc.addPage([PAGE_W, PAGE_H]).drawRectangle({ x: 10, y: 10, width: 50, height: 50 });
  return doc.save();
}

describe("rotulosFourPerPage", () => {
  it("6 rótulos → 2 hojas A4", async () => {
    const out = await PDFDocument.load(await rotulosFourPerPage(await labels(6)));
    expect(out.getPageCount()).toBe(2);
    const { width, height } = out.getPage(0).getSize();
    expect(Math.round(width / MM)).toBe(210);
    expect(Math.round(height / MM)).toBe(297);
  });
  it("el enlace pide la hoja de 4 solo cuando se indica", () => {
    expect(swaypLabelsHref(["a", "b", "a"], { fourPerPage: true })).toBe("/api/pedidos/rotulos?ids=a,b&layout=4");
    expect(swaypLabelsHref(["a"])).toBe("/api/pedidos/rotulos?ids=a");
  });
});
