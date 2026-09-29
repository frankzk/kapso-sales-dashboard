import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (f: string) => readFileSync(resolve(process.cwd(), f), "utf8");

// MOM §6: con filtros, las pestañas de macroetapa y los chips de subetapa
// cuentan lo mismo que la lista. Con «Courier: Tanders» la lista bajaba a 735
// y las pestañas seguían contando todo el Master (29-09-2026).
describe("Master: los contadores de las pestañas siguen a los filtros", () => {
  it("la página cuenta con filtros cuando hay alguno puesto", () => {
    const page = read("app/dashboard/pedidos/page.tsx");
    expect(page).toContain("hasActiveFilters(filters)");
    expect(page).toContain("getOrderMasterFilteredMomCounts(storeIds, { filters, view })");
  });

  it("los conteos filtrados usan el mismo applyServerFilters que la lista", () => {
    const access = read("lib/orders-master-access.ts");
    const start = access.indexOf("export async function getOrderMasterFilteredMomCounts(");
    expect(start).toBeGreaterThan(-1);
    const body = access.slice(start, access.indexOf("\n}\n", start));
    expect(body).toContain("applyServerFilters(q, params.filters, now)");
    expect(body).toContain('.in("store_id", storeIds)');
    // Solo las subetapas de la pestaña abierta: son los únicos chips a la vista.
    expect(body).toContain("MACRO_SUBSTAGES_BY_STAGE[params.view]");
  });

  it("el MOM lo documenta", () => {
    expect(read("docs/mom/master-pedidos-v1.md")).toContain("Los contadores cuentan lo mismo que la lista");
  });
});
