import { describe, expect, it } from "vitest";
import { findDistrictOverride, normalizeDistrictKey } from "@/lib/district-coverage";
import { classifyOrderCoverage } from "@/lib/order-coverage";

// EXCEPCIONES DE COBERTURA POR DISTRITO (0121).
//
// Qué cobertura tiene un distrito es una decisión COMERCIAL, no geográfica.
// Pucusana está en la provincia de Lima y la regla general lo da por reparto
// propio; la operación lo atiende por agencia. Antes eso solo se cambiaba
// tocando código.
//
// Lo que se prueba acá es la PRECEDENCIA, que es lo único con reglas, y que el
// respaldo en TypeScript aplique la misma que la base — dos precedencias
// distintas darían dos respuestas a la misma pregunta, que es el bug que motivó
// la 0104.

describe("normalizeDistrictKey — la misma clave que coverage_norm", () => {
  it("quita tildes, mayúsculas y puntuación", () => {
    expect(normalizeDistrictKey("Pucusana")).toBe("pucusana");
    expect(normalizeDistrictKey("  SAN JUAN de   Miraflores ")).toBe("san juan de miraflores");
    expect(normalizeDistrictKey("Ancón")).toBe("ancon");
    expect(normalizeDistrictKey("Lurigancho-Chosica")).toBe("lurigancho chosica");
  });

  it("es vacío cuando no hay distrito", () => {
    expect(normalizeDistrictKey(null)).toBe("");
    expect(normalizeDistrictKey("   ")).toBe("");
  });
});

const global = (district: string, coverage: "lima" | "provincia_cod" | "agencia") => ({
  store_id: null,
  district,
  coverage,
});

describe("findDistrictOverride — cuál de las reglas aplica", () => {
  it("encuentra la global por el nombre normalizado", () => {
    expect(findDistrictOverride([global("pucusana", "agencia")], "tienda-1", "Pucusana")).toBe(
      "agencia",
    );
  });

  it("la regla de la TIENDA gana sobre la global", () => {
    // Es lo que permite que dos tiendas difieran en un destino sin duplicar el
    // resto de la lista.
    const rules = [
      global("pucusana", "agencia"),
      { store_id: "tienda-1", district: "pucusana", coverage: "lima" as const },
    ];
    expect(findDistrictOverride(rules, "tienda-1", "Pucusana")).toBe("lima");
    expect(findDistrictOverride(rules, "tienda-2", "Pucusana")).toBe("agencia");
  });

  it("no aplica la regla de otra tienda", () => {
    const rules = [{ store_id: "tienda-1", district: "pucusana", coverage: "lima" as const }];
    expect(findDistrictOverride(rules, "tienda-2", "Pucusana")).toBeNull();
  });

  it("devuelve null sin distrito o sin regla que case", () => {
    expect(findDistrictOverride([global("pucusana", "agencia")], "t", null)).toBeNull();
    expect(findDistrictOverride([global("pucusana", "agencia")], "t", "Miraflores")).toBeNull();
    expect(findDistrictOverride([], "t", "Pucusana")).toBeNull();
  });
});

describe("classifyOrderCoverage — la excepción manda sobre todo lo demás", () => {
  const lima = {
    storeId: "tienda-1",
    orgId: "org-1",
    region: "Lima (provincia)",
    province: null,
    district: "Pucusana",
  };

  it("sin excepción, Pucusana es Lima porque el ubigeo lo pone ahí", () => {
    expect(classifyOrderCoverage(lima, [], "2026-08-14")).toBe("lima");
  });

  it("con excepción, es Agencia — y ese es todo el objetivo de la tabla", () => {
    expect(
      classifyOrderCoverage(lima, [], "2026-08-14", [global("pucusana", "agencia")]),
    ).toBe("agencia");
  });

  it("gana incluso sobre Cañete, que era la única decisión comercial cableada", () => {
    // Si una excepción no pudiera contradecir a las reglas automáticas, no
    // serviría para nada: existe justamente para eso.
    const canete = { ...lima, province: "Cañete", district: "Cañete" };
    expect(classifyOrderCoverage(canete, [], "2026-08-14")).toBe("agencia");
    expect(
      classifyOrderCoverage(canete, [], "2026-08-14", [global("canete", "provincia_cod")]),
    ).toBe("provincia_cod");
  });

  it("un distrito sin excepción sigue la regla general de siempre", () => {
    const miraflores = { ...lima, district: "Miraflores" };
    expect(
      classifyOrderCoverage(miraflores, [], "2026-08-14", [global("pucusana", "agencia")]),
    ).toBe("lima");
  });
});
