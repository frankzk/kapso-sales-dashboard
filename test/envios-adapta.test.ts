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

/**
 * Rediseño del 05-10-2026 (Repro Provincia, «Compacta, sin scroll»): la tabla
 * de once columnas que pedía 1.400 px y scrolleaba de lado pasó a ocho celdas
 * de dos líneas en una tabla fija que cabe desde 1.280 px. Por debajo, la cola
 * es una lista.
 */
describe("la tabla entra en el portátil", () => {
  it("es fija, sin ancho mínimo, y solo aparece desde xl", () => {
    expect(src).toContain('<div className="hidden xl:block">');
    expect(src).toContain('<table className="w-full table-fixed border-separate border-spacing-0 text-sm">');
    expect(src).not.toMatch(/min-w-\[1[0-9]{3}px\]/);
    expect(src).not.toContain("TABLE_WRAP");
  });

  it("lo que eran columnas secundarias va en la segunda línea, y se sigue ordenando", () => {
    // «Producto» se cambió por «Motivo anterior» (MOM §11.7): es lo que decide
    // si se reenvía, y el producto sigue entero en el cajón. Ahora es una
    // columna de todas las anchuras de la tabla, no una que se esconde.
    expect(src).toContain('label="Motivo anterior" sortKey="reason"');
    expect(src).not.toContain("SECONDARY_COLUMN");
    // La Fecha Aliclik y el pedido van bajo la programación y la guía, y sus
    // órdenes viven en el mismo encabezado.
    expect(src).toContain("Aliclik {fmtAliclikDate(s.aliclik_service_date)}");
    expect(src).toContain('also={{ label: "Aliclik", sortKey: "lastDelivery" }}');
    expect(src).toContain('also={{ label: "Pedido", sortKey: "order" }}');
  });

  it("el encabezado ordenable acepta la clase de la columna", () => {
    expect(src).toContain('<th scope="col" aria-sort={ariaSort} className={cn(TH, className)}>');
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
