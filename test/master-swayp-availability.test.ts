import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { FenixStockRow } from "@/lib/fenix";
import { buildMasterQuery, parseMasterQuery } from "@/lib/master-query";
import { swaypAvailabilityFor, SWAYP_AVAILABILITY_STAGES } from "@/lib/master-swayp-availability";
import { emptyFilters, matchesFilters, SWAYP_AVAILABILITY_OPTIONS } from "@/lib/order-master-filters";
import type { OrderMasterRow } from "@/lib/types";

/**
 * El filtro «Swayp» del Master (08-10-2026): la misma pregunta que el de Repro
 * Provincia —¿lo puede llevar Swayp hoy?— sobre el pedido en vez de la guía.
 */

const read = (...p: string[]) => readFileSync(resolve(process.cwd(), ...p), "utf8");

const stock: FenixStockRow[] = [
  { city: "piura", product: "NAILS REPAIRING - SERUM PARA UÑAS", sku: "AURE020", quantity: 5 },
  { city: "huancayo", product: "ETHIOPIAN OIL", sku: "AURE003", quantity: 2 },
  { city: "arequipa", product: "ETHIOPIAN OIL", sku: "AURE003", quantity: 0 },
];
const serum = [{ title: "NAILS REPAIRING - SERUM PARA UÑAS", sku: "AURE020" }];
const oil = [{ title: "ETHIOPIAN OIL", sku: "AURE003" }];
const pedido = (over: Partial<{ macro_stage: string | null; district: string | null; province: string | null; region: string | null }> = {}) => ({
  macro_stage: "por_confirmar",
  district: "26 de Octubre",
  province: "Piura",
  region: "Piura",
  ...over,
});

describe("la regla es la de Repro Provincia", () => {
  it("ciudad con almacén y stock del producto: ok", () => {
    expect(swaypAvailabilityFor(pedido(), stock, serum)).toBe("ok");
  });

  it("ciudad con almacén sin stock del producto: sin_stock", () => {
    expect(swaypAvailabilityFor(pedido(), stock, oil)).toBe("sin_stock");
    expect(swaypAvailabilityFor(pedido({ district: "Cayma", province: "Arequipa", region: "Arequipa" }), stock, oil)).toBe("sin_stock");
  });

  it("sin almacén en la ciudad: sin_cobertura", () => {
    expect(swaypAvailabilityFor(pedido({ district: "Iquitos", province: "Maynas", region: "Loreto" }), stock, serum)).toBe("sin_cobertura");
  });

  it("una localidad atendida desde otro almacén cuenta con el stock de ese almacén", () => {
    // Chupaca se reparte desde Huancayo (lib/shipments.ts).
    expect(swaypAvailabilityFor(pedido({ district: "Chupaca", province: "Chupaca", region: "Junín" }), stock, oil)).toBe("ok");
  });

  it("sin provincia del ubigeo, usa el departamento", () => {
    expect(swaypAvailabilityFor(pedido({ district: "Castilla", province: null, region: "Piura" }), stock, serum)).toBe("ok");
  });

  it("sin destino no inventa cobertura", () => {
    expect(swaypAvailabilityFor(pedido({ district: null, province: null, region: null }), stock, serum)).toBe("sin_cobertura");
  });
});

describe("solo en las etapas donde el stock de hoy decide algo", () => {
  it.each([...SWAYP_AVAILABILITY_STAGES])("se calcula en %s", (stage) => {
    expect(swaypAvailabilityFor(pedido({ macro_stage: stage }), stock, serum)).toBe("ok");
  });

  it.each(["por_cerrar", "finalizado", null])("queda vacía en %s", (stage) => {
    expect(swaypAvailabilityFor(pedido({ macro_stage: stage }), stock, serum)).toBeNull();
  });
});

describe("el filtro del Master", () => {
  it("viaja por la URL como `sw` y vuelve igual", () => {
    const filters = { ...emptyFilters(), swaypAvailability: new Set(["ok"]) };
    const params = buildMasterQuery({ filters, sortKey: "created", page: 1 });
    expect(params.get("sw")).toBe("ok");
    expect([...parseMasterQuery(params).filters.swaypAvailability]).toEqual(["ok"]);
  });

  it("filtra las filas por la columna", () => {
    const f = { ...emptyFilters(), swaypAvailability: new Set(["ok"]) };
    const row = (v: OrderMasterRow["swayp_availability"]) => ({ swayp_availability: v }) as OrderMasterRow;
    expect(matchesFilters(row("ok"), f)).toBe(true);
    expect(matchesFilters(row("sin_stock"), f)).toBe(false);
    expect(matchesFilters(row(null), f)).toBe(false);
    expect(matchesFilters(row(null), emptyFilters())).toBe(true);
  });

  it("se aplica en la base, no en la página", () => {
    const src = read("lib/orders-master-access.ts");
    expect(src).toContain('if (f.swaypAvailability.size) q = q.in("swayp_availability", [...f.swaypAvailability]);');
    expect(src).toContain('"coverage,swayp_availability," +');
  });

  it("enseña los mismos textos que Repro Provincia", () => {
    expect(SWAYP_AVAILABILITY_OPTIONS.map((o) => o.label)).toEqual(["Swayp ok · con stock", "Sin stock Swayp", "Fuera de cobertura"]);
    expect(read("components/shipments.tsx")).toContain('{ value: "ok", label: "Swayp ok · con stock" }');
  });

  it("la pantalla no importa el módulo que escribe en la base", () => {
    expect(read("components/orders-master.tsx")).not.toContain("@/lib/master-swayp-availability");
  });
});

describe("se mantiene al día sin depender del recálculo del pedido", () => {
  it("lo refresca el sync de inventario y, las demás horas, el cron", () => {
    expect(read("lib/swayp-inventory-sync.ts")).toContain("await recalcularDisponibilidadSwaypMaster(admin, input.orgId);");
    expect(read("app/api/cron/swayp-inventory/route.ts")).toContain("recalcularDisponibilidadSwaypMasterTodas(admin)");
  });
});
