import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  REPRO_COVERAGE_OPTIONS,
  REPRO_SIN_PEDIDO,
  reproCoverageDefault,
  reproCoverageKey,
  reproCoverageLabel,
} from "@/lib/order-coverage";

/**
 * «¿Puedes agregar un filtro como en Master de Pedidos, que se llama Cobertura?
 * Y por default está marcado todos menos Lima.»
 *
 * Repro Provincia es la cola de provincia, pero cada salida «por definir» de
 * Lima también caía ahí: nace pendiente y sin courier. Medido el 24-09-2026, de
 * la cola pendiente ~3.770 guías eran salidas de Lima contra ~200 de provincia.
 */

describe("el filtro abre con todo menos Lima", () => {
  it("marca provincia, agencia, por revisar y sin pedido; Lima no", () => {
    const d = reproCoverageDefault();
    expect(d.has("lima")).toBe(false);
    for (const key of ["provincia_cod", "agencia", "por_revisar", REPRO_SIN_PEDIDO]) {
      expect(d.has(key), key).toBe(true);
    }
  });

  /**
   * Un conjunto vacío significa «todo» en ChecklistFilter. Si el valor por
   * defecto saliera vacío, Lima volvería a entrar sin que nadie la marcara.
   */
  it("nunca es el conjunto vacío, que significaría «todo»", () => {
    expect(reproCoverageDefault().size).toBeGreaterThan(0);
  });

  it("cada llamada devuelve un conjunto nuevo: resetear no comparte estado", () => {
    const a = reproCoverageDefault();
    a.add("lima");
    expect(reproCoverageDefault().has("lima")).toBe(false);
  });

  it("Lima se puede marcar: está entre las opciones", () => {
    expect(REPRO_COVERAGE_OPTIONS).toContain("lima");
  });
});

describe("la cobertura de una guía es la de su pedido", () => {
  it("usa la cobertura del pedido tal cual", () => {
    expect(reproCoverageKey("lima")).toBe("lima");
    expect(reproCoverageKey("provincia_cod")).toBe("provincia_cod");
  });

  /**
   * Una guía sin pedido vinculado no tiene cobertura que leer, y NO se esconde:
   * «sin pedido» viene marcado por defecto. Si la lectura de cobertura falla en
   * el servidor, las filas caen aquí también — nunca se oculta una guía por no
   * saber su cobertura.
   */
  it("sin pedido va aparte y se ve por defecto", () => {
    expect(reproCoverageKey(null)).toBe(REPRO_SIN_PEDIDO);
    expect(reproCoverageKey("")).toBe(REPRO_SIN_PEDIDO);
    expect(reproCoverageDefault().has(reproCoverageKey(null))).toBe(true);
  });

  it("las etiquetas son las del Master", () => {
    expect(reproCoverageLabel("lima")).toBe("Lima");
    expect(reproCoverageLabel("provincia_cod")).toBe("Provincia COD");
    expect(reproCoverageLabel("agencia")).toBe("Agencia");
    expect(reproCoverageLabel(REPRO_SIN_PEDIDO)).toBe("Sin pedido vinculado");
  });
});

describe("la pantalla lo usa como un filtro más", () => {
  const board = readFileSync(resolve(process.cwd(), "components/shipments.tsx"), "utf8");
  const access = readFileSync(resolve(process.cwd(), "lib/shipments-access.ts"), "utf8");

  it("el estado arranca en el valor por defecto", () => {
    expect(board).toContain("useState<Set<string>>(reproCoverageDefault)");
  });

  /**
   * «Limpiar filtros» vuelve a como abre la pestaña (el patrón de
   * `clientFilters`), no a «todo». Si volviera a vacío, limpiar metería Lima.
   */
  it("limpiar filtros vuelve a todo menos Lima, no a vacío", () => {
    expect(board).toContain("reset: () => setCoverageFilter(reproCoverageDefault())");
    expect(board).toContain("active: !sameSet(coverageFilter, reproCoverageDefault())");
  });

  it("filtra por la cobertura del pedido de cada fila", () => {
    expect(board).toContain("coverageFilter.has(reproCoverageKey(s.order_coverage))");
  });

  it("la cobertura se lee de order_master, la misma columna que filtra el Master", () => {
    expect(access).toContain('.select("order_id,coverage")');
    expect(access).toContain("withOrderCoverage(");
  });
});
