import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Envíos tiene UNA escala tipográfica, la de Tailwind, con piso de 12 px.
 *
 * Evaluación del 12-09-2026: convivían dos escalas (111 `text-xs` y 49
 * tamaños arbitrarios de 9, 10 y 11 px), el mismo rol con tres tratamientos
 * (timestamps a 14, 11 y 10 px; etiquetas con y sin peso), versalitas a 10 px
 * con tracking insuficiente, y las señales de decisión operativa —«Fuera de
 * cobertura», «hace N d», «varados»— en colores de 3,2–3,9:1.
 *
 * Roles (solo sans + mono): título de página `text-lg`; título de cajón
 * `text-base`; sección `text-sm font-semibold`; cuerpo `text-sm`; etiqueta
 * `text-xs font-medium text-slate-600`; metadato `text-xs tabular-nums
 * text-slate-500`; eyebrow `text-xs uppercase tracking-[0.12em]`; chip y tag
 * `text-xs font-medium`.
 */

const src = readFileSync(resolve(process.cwd(), "components/shipments.tsx"), "utf8");

describe("una sola escala", () => {
  it("no quedan tamaños arbitrarios por debajo de 12 px", () => {
    expect(src).not.toMatch(/text-\[(9|10|11)px\]/);
  });

  it("las versalitas llevan el tracking de la casa (el mismo que el Master)", () => {
    expect(src).not.toMatch(/tracking-wide\b/);
    for (const m of src.matchAll(/className="[^"]*uppercase[^"]*"/g)) {
      expect(m[0]).toContain("tracking-[0.12em]");
    }
  });

  it("las sublíneas no se pegan a su línea principal", () => {
    expect(src).not.toMatch(/leading-3 /);
    expect(src).not.toContain("leading-tight");
  });
});

describe("el mismo rol, el mismo tratamiento", () => {
  it("el título del cajón pesa más que sus secciones", () => {
    expect(src).toContain('id="shipment-drawer-title" className="font-mono text-base font-semibold text-slate-900"');
  });

  it("las etiquetas de formulario del cajón comparten peso y tono", () => {
    expect(src).not.toContain('<label className="block text-xs text-slate-500">');
    expect(src.match(/<label className="block text-xs font-medium text-slate-600">/g)?.length).toBeGreaterThan(8);
  });

  it("fechas y cifras van en cifras tabulares donde se comparan en columna", () => {
    expect(src).toContain('<td className="px-4 py-2.5 tabular-nums text-slate-600">');
    expect(src).toContain("py-2 text-xs tabular-nums text-slate-600");
    expect(src).toContain('<span className="shrink-0 text-right text-xs tabular-nums text-slate-500">');
  });

  it("los códigos de guía no se parten por la mitad", () => {
    expect(src).not.toContain("break-all");
    expect(src).toContain("whitespace-nowrap font-mono text-xs font-semibold text-slate-800");
  });
});

describe("las señales de decisión se leen", () => {
  it("ningún texto informativo en 600/500 de color sobre fondo claro (< 4,5:1)", () => {
    expect(src).not.toContain("text-rose-500");
    expect(src).not.toContain("text-teal-600");
    expect(src).not.toContain("text-sky-600");
    expect(src).not.toContain("text-emerald-600");
    expect(src).not.toContain("text-amber-600");
  });

  it("los párrafos de consecuencia respiran", () => {
    const i = src.indexOf("Primero realiza la reprogramación en Aliclik");
    expect(src.slice(i - 140, i)).toContain("leading-relaxed");
    const j = src.indexOf("Sin N° de pedido no se puede autogenerar");
    expect(src.slice(j - 140, j)).toContain("leading-relaxed");
  });
});
