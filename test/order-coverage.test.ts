import { describe, expect, it } from "vitest";
import {
  classifyOrderCoverage,
  isLimaMetropolitanaOrCallao,
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

  it("manda a revisión cualquier ubicación incompleta", () => {
    expect(
      classifyOrderCoverage({ ...base, province: null }, [tariff()], "2026-07-28"),
    ).toBe("por_revisar");
  });
});

