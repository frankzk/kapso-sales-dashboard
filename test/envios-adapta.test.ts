import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Envíos se adapta al portátil con el cajón abierto y a la pantalla táctil.
 *
 * Audit del 12-09-2026. La tabla de 11 columnas usaba `TABLE_WRAP`, que suelta
 * el scroll horizontal desde `md`: con la barra lateral (240 px) y el cajón de
 * 34 rem abierto, en 1.280–1.600 px las columnas de la derecha quedaban bajo el
 * cajón o la PÁGINA entera scrolleaba en horizontal y la barra lateral se iba
 * de lado. Y los controles de 28–32 px, pensados para ratón, se fallan con el
 * dedo en una tablet o un portátil táctil.
 */

const src = readFileSync(resolve(process.cwd(), "components/shipments.tsx"), "utf8");
const css = readFileSync(resolve(process.cwd(), "app/globals.css"), "utf8");

describe("la tabla entra en el portátil", () => {
  it("tiene ancho propio y el contenedor scrollea hasta que entra de verdad", () => {
    expect(src).toContain('<div className={cn("hidden md:block", TABLE_WRAP_FROM[1800])}>');
    expect(src).toContain('<table className="w-full min-w-[1100px] text-sm xl:min-w-[1400px]">');
    expect(src).not.toContain("className={TABLE_WRAP}");
  });

  it("las dos columnas que el cajón ya muestra enteras se esconden por debajo de xl", () => {
    expect(src).toContain('const SECONDARY_COLUMN = "hidden xl:table-cell";');
    // Encabezado y celda, las dos veces: Producto y Última entrega Aliclik.
    expect(src.match(/className=\{SECONDARY_COLUMN\}/g)?.length).toBe(2);
    expect(src.match(/cn\(SECONDARY_COLUMN, /g)?.length).toBe(2);
    const header = src.slice(src.indexOf('label="Producto"'), src.indexOf('label="Producto"') + 140);
    expect(header).toContain("className={SECONDARY_COLUMN}");
  });

  it("el encabezado ordenable acepta la clase de la columna", () => {
    expect(src).toContain('className={cn("px-2 py-1 text-left font-medium first:pl-4 last:pr-4", className)}');
  });
});

describe("objetivos táctiles por método de entrada", () => {
  it("con puntero grueso los controles miden 44 px; el escritorio sigue denso", () => {
    expect(css).toContain("@media (pointer: coarse)");
    expect(css).toContain("min-height: 2.75rem;");
    // No se decide por ancho de pantalla.
    expect(css).not.toMatch(/@media \(max-width/);
  });
});
