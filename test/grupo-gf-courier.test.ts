import { describe, expect, it } from "vitest";
import {
  merchantSettlement,
  resolveDistrictTariff,
  tariffForOutcome,
  yapeCommission,
  type DistrictTariffRow,
} from "@/lib/grupo-gf-courier";

const base: DistrictTariffRow = {
  id: "general",
  provider_id: "grupo-gf",
  agreement_id: null,
  district_key: "miraflores",
  zone: null,
  delivery_amount: 10,
  rejection_amount: 8,
  includes_igv: true,
  currency: "PEN",
  effective_from: "2026-08-01",
  effective_to: null,
  status: "active",
};

describe("tarifas configurables de Grupo GF Courier", () => {
  it("prefiere la excepción de la tienda sobre la tarifa general", () => {
    const particular = {
      ...base,
      id: "aurela",
      agreement_id: "agreement-aurela",
      delivery_amount: 9,
    };
    const result = resolveDistrictTariff([base, particular], {
      providerId: "grupo-gf",
      agreementId: "agreement-aurela",
      districtKey: "miraflores",
      day: "2026-08-30",
    });

    expect(result).toEqual({ kind: "found", tariff: particular, source: "agreement" });
  });

  it("usa la general si el contrato no tiene excepción", () => {
    const result = resolveDistrictTariff([base], {
      providerId: "grupo-gf",
      agreementId: "agreement-kenku",
      districtKey: "miraflores",
      day: "2026-08-30",
    });

    expect(result).toEqual({ kind: "found", tariff: base, source: "general" });
  });

  it("elige la vigencia más reciente del mismo ámbito", () => {
    const older = { ...base, id: "older", effective_from: "2026-01-01", delivery_amount: 7 };
    const result = resolveDistrictTariff([older, base], {
      providerId: "grupo-gf",
      agreementId: null,
      districtKey: "miraflores",
      day: "2026-08-30",
    });

    expect(result.kind).toBe("found");
    if (result.kind === "found") expect(result.tariff.id).toBe("general");
  });

  it("no inventa S/0 si el distrito no tiene tarifa vigente", () => {
    const result = resolveDistrictTariff(
      [{ ...base, effective_to: "2026-08-29" }],
      {
        providerId: "grupo-gf",
        agreementId: null,
        districtKey: "miraflores",
        day: "2026-08-30",
      },
    );

    expect(result).toEqual({ kind: "missing", reason: "district_without_tariff" });
  });

  it("cobra solo entrega y rechazo", () => {
    expect(tariffForOutcome(base, "entregado")).toBe(10);
    expect(tariffForOutcome(base, "rechazado")).toBe(10);
    expect(tariffForOutcome(base, "no_responde")).toBe(0);
    expect(tariffForOutcome(base, "direccion_incorrecta")).toBe(0);
    expect(tariffForOutcome(base, "cancelado")).toBe(0);
  });
});

describe("comisión Yape y liquidación de tienda", () => {
  it("calcula 3.5 % solo sobre el importe Yape", () => {
    expect(yapeCommission(100)).toBe(3.5);
    expect(yapeCommission(30)).toBe(1.05);
    expect(yapeCommission(0)).toBe(0);
  });

  it("redondea cada operación a dos decimales", () => {
    expect(yapeCommission(99.99)).toBe(3.5);
  });

  it("expone COD, tarifa, Yape y neto sin ocultar descuentos", () => {
    expect(
      merchantSettlement({ codCollected: 100, yapeCollected: 100, logisticsFee: 10 }),
    ).toEqual({
      codCollected: 100,
      logisticsFee: 10,
      yapeFee: 3.5,
      merchantNet: 86.5,
    });
  });

  it("en pago mixto cobra Yape únicamente sobre la parte electrónica", () => {
    expect(
      merchantSettlement({ codCollected: 100, yapeCollected: 30, logisticsFee: 10 }),
    ).toEqual({
      codCollected: 100,
      logisticsFee: 10,
      yapeFee: 1.05,
      merchantNet: 88.95,
    });
  });
});
