import { describe, expect, it } from "vitest";
import {
  classifyOrderCoverage,
  isLimaMetropolitanaOrCallao,
  limaRegionKind,
  resolveLimaDistrict,
} from "@/lib/order-coverage";
import type { CostTariff } from "@/lib/costs";

const base = {
  storeId: "store-1",
  orgId: "org-1",
  region: "Lima",
  province: "Lima",
  district: "Miraflores",
};

const tariff = (patch: Partial<CostTariff> = {}): CostTariff => ({
  id: "tariff-1",
  org_id: "org-1",
  store_id: null,
  courier: "Aliclik",
  region: null,
  province: null,
  district: "Huancayo",
  concept: "primer_intento",
  amount: 10,
  effective_from: "2026-01-01",
  effective_to: null,
  ...patch,
});

describe("clasificación de cobertura", () => {
  it("considera Lima solo a Lima Metropolitana", () => {
    expect(isLimaMetropolitanaOrCallao(base)).toBe(true);
    expect(
      classifyOrderCoverage(
        { ...base, province: "Huaral", district: "Huaral" },
        [],
        "2026-07-28",
      ),
    ).toBe("agencia");
  });

  it("incluye Callao dentro de Lima", () => {
    expect(
      classifyOrderCoverage(
        { ...base, region: "Callao", province: "Callao", district: "Ventanilla" },
        [],
        "2026-07-28",
      ),
    ).toBe("lima");
  });

  it("usa una tarifa de reparto vigente como evidencia de Provincia COD", () => {
    expect(
      classifyOrderCoverage(
        { ...base, region: "Junín", province: "Huancayo", district: "Huancayo" },
        [tariff()],
        "2026-07-28",
      ),
    ).toBe("provincia_cod");
  });

  it("Shalom y Olva nunca prueban cobertura COD", () => {
    const location = { ...base, region: "Junín", province: "Huancayo", district: "Huancayo" };
    expect(
      classifyOrderCoverage(location, [tariff({ courier: "Shalom" })], "2026-07-28"),
    ).toBe("agencia");
    expect(
      classifyOrderCoverage(location, [tariff({ courier: "Olva Courier" })], "2026-07-28"),
    ).toBe("agencia");
  });

  it("una tarifa genérica o de devolución no prueba cobertura", () => {
    const location = { ...base, region: "Junín", province: "Huancayo", district: "Huancayo" };
    expect(
      classifyOrderCoverage(
        location,
        [tariff({ district: null }), tariff({ concept: "devolucion" })],
        "2026-07-28",
      ),
    ).toBe("agencia");
  });

  it("manda a revisión solo lo que no se puede ubicar", () => {
    expect(
      classifyOrderCoverage({ ...base, region: null, province: null, district: null }, [tariff()], "2026-07-28"),
    ).toBe("por_revisar");
  });
});

// Los nombres que manda Shopify Perú: "province" es el DEPARTAMENTO y tiene dos
// entradas distintas para Lima. Es la señal que decide la cobertura.
describe("región de Shopify", () => {
  it("distingue la provincia de Lima del departamento de Lima", () => {
    expect(limaRegionKind("Lima (provincia)")).toBe("metropolitana");
    expect(limaRegionKind("Lima (departamento)")).toBe("departamento");
    expect(limaRegionKind("Lima Metropolitana")).toBe("metropolitana");
    expect(limaRegionKind("PE-LMA")).toBe("metropolitana");
    expect(limaRegionKind("PE-LIM")).toBe("departamento");
    expect(limaRegionKind("Lima")).toBe("lima");
    expect(limaRegionKind("Callao")).toBe("callao");
    expect(limaRegionKind("Prov. Const. del Callao")).toBe("callao");
    expect(limaRegionKind("Junín")).toBe(null);
    expect(limaRegionKind(null)).toBe(null);
  });

  it('"Lima (provincia)" es Lima aunque falte la provincia del ubigeo', () => {
    for (const district of ["Pueblo Libre", "Chorrillos", "San Isidro"]) {
      expect(
        classifyOrderCoverage(
          { ...base, region: "Lima (provincia)", province: null, district },
          [tariff({ district })],
          "2026-07-28",
        ),
      ).toBe("lima");
    }
  });

  it('"Lima (provincia)" gana a una provincia mal resuelta por el ubigeo', () => {
    // `peru_districts` tiene el distrito como clave única y hay tres
    // Independencia en Perú: a este le pegó la provincia de Huaraz (Áncash).
    expect(
      classifyOrderCoverage(
        { ...base, region: "Lima (provincia)", province: "Huaraz", district: "Independencia" },
        [tariff({ district: "Independencia" })],
        "2026-07-28",
      ),
    ).toBe("lima");
  });

  it('"Lima (departamento)" nunca es cobertura Lima', () => {
    expect(
      classifyOrderCoverage(
        { ...base, region: "Lima (departamento)", province: null, district: "Yauyos" },
        [],
        "2026-07-28",
      ),
    ).toBe("agencia");
    expect(
      classifyOrderCoverage(
        { ...base, region: "Lima (departamento)", province: null, district: "Huaral" },
        [tariff({ district: "Huaral" })],
        "2026-07-28",
      ),
    ).toBe("provincia_cod");
  });

  it("un distrito homónimo de otra región no se cuela como Lima", () => {
    expect(
      isLimaMetropolitanaOrCallao({ ...base, region: "Áncash", province: "Huaraz", district: "Independencia" }),
    ).toBe(false);
    expect(
      isLimaMetropolitanaOrCallao({ ...base, region: "Lambayeque", province: "Chiclayo", district: "La Victoria" }),
    ).toBe(false);
    // Sin región tampoco se adivina: Independencia se repite fuera de Lima.
    expect(
      isLimaMetropolitanaOrCallao({ ...base, region: null, province: null, district: "Independencia" }),
    ).toBe(false);
    // San Isidro solo existe en Lima Metropolitana: ahí sí se puede asignar.
    expect(
      isLimaMetropolitanaOrCallao({ ...base, region: null, province: null, district: "San Isidro" }),
    ).toBe(true);
    // Con la provincia del ubigeo, el homónimo sí se resuelve.
    expect(
      isLimaMetropolitanaOrCallao({ ...base, region: null, province: "Lima", district: "Independencia" }),
    ).toBe(true);
  });
});

// El distrito casi nunca se elige de una lista: lo escribe la clienta o la
// asesora, y no lo escribe como el INEI.
describe("distrito escrito a mano", () => {
  it("resuelve el nombre corto, la sigla y el nombre viejo", () => {
    expect(resolveLimaDistrict("Surco")).toBe("santiago de surco");
    expect(resolveLimaDistrict("SJL")).toBe("san juan de lurigancho");
    expect(resolveLimaDistrict("S.J.M.")).toBe("san juan de miraflores");
    expect(resolveLimaDistrict("smp")).toBe("san martin de porres");
    expect(resolveLimaDistrict("Ate Vitarte")).toBe("ate");
    expect(resolveLimaDistrict("Cercado de Lima")).toBe("lima");
    expect(resolveLimaDistrict("Huachipa")).toBe("lurigancho");
    expect(resolveLimaDistrict("Chosica")).toBe("lurigancho");
    expect(resolveLimaDistrict("Huancayo")).toBe(null);
  });

  it("encuentra el distrito dentro de una referencia, solo si se lo permite", () => {
    const frase = "A 2 cuadras del mercado de Magdalena";
    expect(resolveLimaDistrict(frase)).toBe(null);
    expect(resolveLimaDistrict(frase, { searchInText: true })).toBe("magdalena del mar");
    expect(resolveLimaDistrict("Coop universal Santa Anita", { searchInText: true })).toBe("santa anita");
    expect(resolveLimaDistrict("La victoria en la tarde", { searchInText: true })).toBe("la victoria");
    expect(resolveLimaDistrict("Santa Maria - San Bartolo", { searchInText: true })).toBe("san bartolo");
    // "Zárate" es un barrio de SJL: no puede colar "Ate" como distrito.
    expect(resolveLimaDistrict("Zarate", { searchInText: true })).toBe(null);
  });

  it('el caso del pedido #AUR174763: región "Lima" + distrito "Surco"', () => {
    expect(
      classifyOrderCoverage(
        { ...base, region: "Lima", province: null, district: "Surco" },
        [tariff({ district: "Surco" })],
        "2026-07-28",
      ),
    ).toBe("lima");
  });
});

// Región y distrito se contradicen dentro del propio departamento de Lima.
describe('"Lima (departamento)" con distrito metropolitano', () => {
  it("gana el distrito, que es el que escribe la clienta", () => {
    for (const district of ["Miraflores", "Los Olivos", "San Isidro", "La Molina", "Surco", "Lima"]) {
      expect(
        isLimaMetropolitanaOrCallao({ ...base, region: "Lima (departamento)", province: null, district }),
      ).toBe(true);
    }
  });

  it("las provincias del departamento siguen fuera de Lima", () => {
    for (const district of ["Cañete", "Huaura", "Barranca", "Huaral", "Yauyos", "Canta", "Oyón"]) {
      expect(
        isLimaMetropolitanaOrCallao({ ...base, region: "Lima (departamento)", province: null, district }),
      ).toBe(false);
    }
  });

  it("San Luis no se puede desempatar: también es un distrito de Cañete", () => {
    expect(
      isLimaMetropolitanaOrCallao({ ...base, region: "Lima (departamento)", province: null, district: "San Luis" }),
    ).toBe(false);
    // Con la región metropolitana no hay nada que desempatar.
    expect(
      isLimaMetropolitanaOrCallao({ ...base, region: "Lima (provincia)", province: null, district: "San Luis" }),
    ).toBe(true);
  });

  it("un distrito de otro departamento sigue sin colarse", () => {
    expect(
      isLimaMetropolitanaOrCallao({ ...base, region: "Áncash", province: null, district: "Independencia" }),
    ).toBe(false);
    expect(
      isLimaMetropolitanaOrCallao({ ...base, region: "Arequipa", province: null, district: "Cerca de Miraflores" }),
    ).toBe(false);
  });
});
