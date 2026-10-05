import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Envíos en el teléfono, como extensión: escritorio no cambia.
 *
 * PRODUCT.md deja el flujo móvil de motorizados para una etapa posterior; esto
 * no lo inventa. Lo que hace es que la cola de llamadas se pueda trabajar
 * desde un celular: una lista en vez de la tabla, «Llamar» con `tel:` al
 * alcance del pulgar, filtros plegados, las seis vistas en dos columnas,
 * búsqueda a todo el ancho, y un cajón cuya cabecera («Cerrar») no se va con
 * el scroll.
 */

const src = readFileSync(resolve(process.cwd(), "components/shipments.tsx"), "utf8");
const layout = readFileSync(resolve(process.cwd(), "app/layout.tsx"), "utf8");

describe("la cola es una lista por debajo de xl", () => {
  it("la tabla se esconde y la lista aparece, con la MISMA ventana de filas", () => {
    expect(src).toContain('<div className="hidden xl:block">');
    expect(src).toContain('<ul className="divide-y divide-line border-t border-line xl:hidden">');
    expect(src.match(/\{shownRows\.map\(\(s\) => /g)?.length).toBe(2);
  });

  it("cada fila abre la guía y ofrece llamar con tel:", () => {
    const cards = src.slice(src.indexOf('<ul className="divide-y divide-line border-t border-line xl:hidden">'), src.indexOf("{hiddenCount > 0 && ("));
    expect(cards).toContain("onClick={() => onOpen(s.id)}");
    expect(cards).toContain("href={`tel:${s.customer_phone.replace(/[^\\d+]/g, \"\")}`}");
    expect(cards).toContain("<StatusBadge category={s.status_category} status={s.delivery_status} suffix={subState(s)} />");
    expect(cards).toContain("<AliclikRouteCell shipment={s} />");
    // Interactivo dentro de interactivo no: el enlace va al lado del botón, no dentro.
    const button = cards.slice(cards.indexOf("<button"), cards.indexOf("</button>"));
    expect(button).not.toContain("<a ");
  });
});

describe("lo demás cabe en 360 px", () => {
  it("búsqueda a todo el ancho, vistas en rejilla, filtros plegados", () => {
    expect(src).toContain('<div role="search" className="relative w-full sm:w-64">');
    // Seis vistas en dos columnas: no se parten ni se deslizan.
    expect(src).toContain('className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6"');
    expect(src).toContain('filtersOpen ? "flex" : "hidden md:flex"');
    expect(src).toContain("expanded={filtersOpen}");
    expect(src).toContain("{activeFilters > 0 && (");
  });

  it("la cabecera del cajón queda fija y el pie respeta la barra de inicio", () => {
    expect(src).toContain('className="sticky top-0 z-10 -mx-3.5 -mt-3.5 flex items-start justify-between gap-3 border-b border-slate-100 bg-white');
    expect(src).toContain("pb-[max(1rem,env(safe-area-inset-bottom))]");
    expect(layout).toContain('viewportFit: "cover"');
  });
});
