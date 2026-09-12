import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * En Envíos el color dice QUÉ ES una cosa, no EN QUÉ SECCIÓN está.
 *
 * Antes del 12-09-2026 el cajón tenía siete tintas de sección (sky, teal,
 * indigo, rose, amber, orange, violet) con su sombra copiada, cinco colores de
 * botón primario y emojis como iconografía. PRODUCT.md lo llama por su nombre
 * en las anti-referencias: «tarjetas anidadas, ruido visual». Ahora:
 *   * las secciones son neutras (`border-slate-200 bg-white`);
 *   * el color queda para el significado: estado de la guía (`CATEGORY_BADGE`),
 *     courier (Fenix naranja, Aliclik cielo), éxito (emerald), advertencia
 *     (amber) y lo irreversible o urgente (rose);
 *   * hay un solo acento de acción, el de la marca;
 *   * los iconos se dibujan (SVG), no se escriben.
 */

const src = readFileSync(resolve(process.cwd(), "components/shipments.tsx"), "utf8");

describe("las secciones del cajón son neutras", () => {
  it("ninguna sección lleva tinta ni sombra propia", () => {
    for (const m of src.matchAll(/<section className="([^"]*)"/g)) {
      const cls = m[1] ?? "";
      expect(cls, cls).not.toMatch(/shadow-\[/);
      expect(cls, cls).not.toMatch(/border-(sky|teal|indigo|violet|orange|amber)-/);
    }
    expect(src).not.toContain("shadow-[");
  });

  it("los títulos de sección son neutros", () => {
    for (const m of src.matchAll(/<h3 className="([^"]*)"/g)) {
      expect(m[1], m[1]).toContain("text-slate-900");
    }
  });

  it("teal, indigo y violet ya no visten secciones: solo quedan en estado y courier", () => {
    const allowed = new Set([
      'in_route: "bg-violet-50 text-violet-700",',
      '<td className="px-3 py-1.5 text-right text-violet-700 tabular-nums">{r.reprogramadas}</td>',
    ]);
    for (const line of src.split("\n")) {
      if (/(teal|violet)-[0-9]/.test(line)) {
        expect(allowed.has(line.trim()), line.trim()).toBe(true);
      }
    }
    // Indigo solo en la etiqueta «Directa»: fondo y texto, en la tabla, en las
    // tarjetas de teléfono y en el cajón.
    expect(src.match(/indigo-[0-9]/g)?.length).toBe(6);
  });
});

describe("un solo acento de acción", () => {
  it("los botones primarios son de la marca; rose solo para lo irreversible", () => {
    expect(src).not.toMatch(/bg-(orange|emerald|violet|indigo|sky|teal)-6\d\d px/);
    expect(src.match(/bg-brand-600/g)?.length).toBeGreaterThan(4);
    // Rose queda en lo irreversible: crear la guía de excepción, «no quiere»
    // (primer clic y confirmación), «Cliente cancela» (primer clic y
    // confirmación) y resolver la novedad de Swayp.
    expect(src.match(/(?<!hover:)bg-rose-(600|700)/g)?.length).toBe(6);
  });

  it("los filtros activos y la ruta elegida usan el acento, no el color del courier", () => {
    expect(src).not.toContain('"border-emerald-300 bg-emerald-50 text-emerald-800"');
    expect(src).not.toContain('"border-indigo-300 bg-indigo-50 text-indigo-800"');
    expect(src).toContain('? "border-brand-500 bg-brand-50 text-brand-800"');
  });
});

describe("los iconos se dibujan", () => {
  it("lupa, cerrar y flecha son SVG; no quedan emojis en la interfaz", () => {
    expect(src).toContain("function IconSearch(");
    expect(src).toContain("function IconClose(");
    expect(src).toContain("function IconArrowRight(");
    const ui = src.replace(/\/\/.*$/gm, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
    expect(ui).not.toMatch(/[🔍📸🔁✅✖🚚⚠️✏️◷]/u);
    expect(ui).not.toMatch(/>\s*✕\s*</);
  });
});
