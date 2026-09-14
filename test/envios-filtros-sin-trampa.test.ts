import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * El filtro que no se podía apagar.
 *
 * «Por recuperar» se dibuja solo en Pendiente, pero su cláusula no tenía guarda
 * de vista y `setSoloPorRecuperar(false)` no existía en ninguno de los tres
 * sitios de reseteo ni en la condición que decide si «Limpiar filtros» se
 * dibuja. Marcarlo y cambiar de pestaña dejaba la lista vacía, con el contador
 * diciendo «1 filtro» y sin ningún control a la vista para quitarlo: la única
 * salida era recargar la página.
 *
 * El arreglo es estructural —una sola lista— porque el defecto era de tener
 * cuatro listas a mano y olvidarse en todas menos una.
 */

const ui = readFileSync(resolve(process.cwd(), "components/shipments.tsx"), "utf8");

describe("una sola lista de filtros", () => {
  it("existe y de ella salen el contador y el reseteo", () => {
    expect(ui).toContain("const clientFilters: { active: boolean; reset: () => void; survivesViewChange?: boolean }[]");
    expect(ui).toContain("const activeFilters = clientFilters.filter((f) => f.active).length;");
    expect(ui).toContain("function resetClientFilters(opts?: { keepAcrossViews?: boolean })");
  });

  it("«Por recuperar» está en la lista, así que se apaga en los tres sitios", () => {
    expect(ui).toContain("{ active: soloPorRecuperar, reset: () => setSoloPorRecuperar(false) },");
    // Un solo `setSoloPorRecuperar` fuera de la casilla: el de la lista.
    const apagados = ui.match(/setSoloPorRecuperar\(false\)/g) ?? [];
    expect(apagados).toHaveLength(1);
  });

  it("ya no quedan listas de reseteo escritas a mano", () => {
    // Las tres listas viejas empezaban todas por esta línea.
    const listasViejas = ui.match(/setDepartmentFilter\(new Set\(\)\);\n\s+setDistrictFilter\(new Set\(\)\);/g) ?? [];
    expect(listasViejas).toHaveLength(0);
    expect(ui).toContain("resetClientFilters({ keepAcrossViews: true });");
  });

  it("el botón de limpiar aparece exactamente cuando hay algo que limpiar", () => {
    // Antes su condición enumeraba diez filtros y omitía el undécimo.
    const apariciones = ui.match(/\{activeFilters > 0 && \(/g) ?? [];
    expect(apariciones.length).toBeGreaterThanOrEqual(2);
  });

  it("la cláusula tiene la misma guarda de vista que sus dos vecinas", () => {
    expect(ui).toContain('(!soloPorRecuperar || view !== "pendiente" || esPorRecuperar(s)) &&');
  });
});

describe("limpiar filtros devuelve a como abre la vista", () => {
  it("«Sin contactar hoy» vuelve a su valor por defecto, no a apagado", () => {
    // Poniéndolo en `false` en Pendiente —donde el defecto es `true`— limpiar
    // filtros SUBÍA el contador a uno y agrandaba la cola.
    expect(ui).toContain("const uncontactedTodayDefault = view === \"pendiente\";");
    expect(ui).toContain("reset: () => setUncontactedTodayOnly(uncontactedTodayDefault),");
  });

  it("la tienda sobrevive al cambio de pestaña", () => {
    expect(ui).toContain("survivesViewChange: true");
  });
});

describe("un filtro que toca a otro lo dice", () => {
  it("quitar la provincia por elegir «sin stock» deja aviso", () => {
    expect(ui).toContain("Se quitó el filtro de provincia: esta pregunta es sobre todo el país.");
    expect(ui).toContain("const [filterNotice, setFilterNotice]");
  });
});
