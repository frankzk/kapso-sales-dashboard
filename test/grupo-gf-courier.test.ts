import { describe, expect, it } from "vitest";
import {
  merchantSettlement,
  resolveDistrictAvailability,
  resolveDistrictTariff,
  tariffForOutcome,
  yapeCommission,
  type DistrictTariffRow,
  type DistrictAvailabilityEventRow,
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

const pause: DistrictAvailabilityEventRow = {
  id: "pause-general",
  provider_id: "grupo-gf",
  agreement_id: null,
  district_key: "miraflores",
  action: "paused",
  reason: "Capacidad completa",
  paused_until: null,
  created_by: "daysi",
  created_at: "2026-08-30T15:00:00Z",
};

describe("disponibilidad distrital de Grupo GF Courier", () => {
  it("considera disponible un distrito sin eventos", () => {
    expect(resolveDistrictAvailability([], {
      providerId: "grupo-gf",
      agreementId: "aurela",
      districtKey: "miraflores",
      day: "2026-08-31",
    })).toEqual({ status: "available", source: "default" });
  });

  it("la pausa general bloquea también a una tienda", () => {
    expect(resolveDistrictAvailability([pause], {
      providerId: "grupo-gf",
      agreementId: "aurela",
      districtKey: "miraflores",
      day: "2026-08-31",
    })).toEqual({ status: "paused", source: "general", event: pause });
  });

  it("una pausa contractual no bloquea a otra tienda", () => {
    const storePause = { ...pause, id: "pause-aurela", agreement_id: "aurela" };
    expect(resolveDistrictAvailability([storePause], {
      providerId: "grupo-gf",
      agreementId: "kenku",
      districtKey: "miraflores",
      day: "2026-08-31",
    }).status).toBe("available");
    expect(resolveDistrictAvailability([storePause], {
      providerId: "grupo-gf",
      agreementId: "aurela",
      districtKey: "miraflores",
      day: "2026-08-31",
    }).status).toBe("paused");
  });

  it("la reactivación posterior levanta la pausa", () => {
    const resumed: DistrictAvailabilityEventRow = {
      ...pause,
      id: "resume-general",
      action: "reactivated",
      reason: null,
      paused_until: null,
      created_at: "2026-08-31T10:00:00Z",
    };
    expect(resolveDistrictAvailability([pause, resumed], {
      providerId: "grupo-gf",
      agreementId: null,
      districtKey: "miraflores",
      day: "2026-08-31",
    }).status).toBe("available");
  });

  it("reactiva automáticamente al pasar la fecha indicada", () => {
    expect(resolveDistrictAvailability([{ ...pause, paused_until: "2026-08-30" }], {
      providerId: "grupo-gf",
      agreementId: null,
      districtKey: "miraflores",
      day: "2026-08-31",
    }).status).toBe("available");
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

import { cashLimitVerdict } from "@/lib/grupo-gf-courier";

describe("cashLimitVerdict (MOM §29.9)", () => {
  it("avisa al pasar el umbral y bloquea al pasar el límite; sin límites no dice nada", () => {
    expect(cashLimitVerdict({ currentCod: 1000, addingCod: 500, warningAmount: 4000, limitAmount: 5000 })).toMatchObject({ status: "ok", total: 1500, message: null });
    expect(cashLimitVerdict({ currentCod: 3500, addingCod: 800, warningAmount: 4000, limitAmount: 5000 })).toMatchObject({ status: "warning", total: 4300 });
    expect(cashLimitVerdict({ currentCod: 4800, addingCod: 300, warningAmount: 4000, limitAmount: 5000 })).toMatchObject({ status: "blocked", total: 5100 });
    expect(cashLimitVerdict({ currentCod: 9000, addingCod: 1, warningAmount: null, limitAmount: null }).status).toBe("ok");
  });
});

import { custodyOnAssign, isRiderPickupMode, riderScreenFor, riderStopDecision } from "@/lib/grupo-gf-courier";

describe("modo de recojo del motorizado (0185, MOM §29.13)", () => {
  it("solo «exigir» manda a «Recibir mi caja»; en los otros modos la custodia pasa al asignar", () => {
    expect(riderScreenFor("exigir", ["ready_for_pickup"])).toBe("recibir_caja");
    expect(riderScreenFor("exigir", ["pickup_check", "in_custody"])).toBe("recibir_caja");
    expect(riderScreenFor("exigir", ["in_custody"])).toBe("ruta");
    expect(riderScreenFor("exigir", [])).toBe("ruta");
    expect(riderScreenFor("confirmar", ["ready_for_pickup", "pickup_check"])).toBe("ruta");
    expect(riderScreenFor("ninguno", ["ready_for_pickup"])).toBe("ruta");
    expect(custodyOnAssign("exigir")).toBe(false);
    expect(custodyOnAssign("confirmar")).toBe(true);
    expect(custodyOnAssign("ninguno")).toBe(true);
    expect(isRiderPickupMode("confirmar")).toBe(true);
    expect(isRiderPickupMode("true")).toBe(false);
  });

  it("modo × estado → qué ve y puede hacer el motorizado con cada parada", () => {
    const base = { status: "pendiente", pickupCheckedAt: null, hasManifestItem: true, routeClosed: false };
    // confirmar: nace «por confirmar», puede decir lo llevo / no lo llevo, y entregar igual (con rastro).
    expect(riderStopDecision("confirmar", base)).toEqual({ badge: "por_confirmar", canConfirm: true, canDecline: true, canReport: true, reportUnconfirmed: true });
    // confirmado: solo entregar.
    expect(riderStopDecision("confirmar", { ...base, pickupCheckedAt: "2026-09-19T10:00:00Z" })).toEqual({ badge: "lo_llevo", canConfirm: false, canDecline: false, canReport: true, reportUnconfirmed: false });
    // ya reportada: nada más que hacer; la insignia se conserva.
    expect(riderStopDecision("confirmar", { ...base, status: "entregado" })).toMatchObject({ badge: "por_confirmar", canConfirm: false, canDecline: false, canReport: false });
    // ruta cerrada: solo lectura.
    expect(riderStopDecision("confirmar", { ...base, routeClosed: true })).toMatchObject({ canConfirm: false, canDecline: false, canReport: false });
    // parada añadida a mano (sin caja): el modo no aplica.
    expect(riderStopDecision("confirmar", { ...base, hasManifestItem: false })).toEqual({ badge: null, canConfirm: false, canDecline: false, canReport: true, reportUnconfirmed: false });
    // exigir y ninguno: la parada se entrega y no se pide nada.
    expect(riderStopDecision("exigir", base)).toEqual({ badge: null, canConfirm: false, canDecline: false, canReport: true, reportUnconfirmed: false });
    expect(riderStopDecision("ninguno", base)).toEqual({ badge: null, canConfirm: false, canDecline: false, canReport: true, reportUnconfirmed: false });
  });
});
