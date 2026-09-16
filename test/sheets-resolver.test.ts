// Liquidaciones 2 — el resolver de Estatus, la zona y las fechas de Lima.
import { describe, expect, it } from "vitest";
import {
  districtKey,
  intentosLima,
  kaptaContribution,
  limaDate,
  limaMonthKey,
  resolveConsolidado,
  resolveZona,
} from "@/lib/sheets/resolver";
import type { Contribution, OrderFacts } from "@/lib/sheets/types";

const c = (sheet_key: string, mark: Contribution["mark"]): Contribution => ({ sheet_key, mark });

describe("resolveConsolidado", () => {
  it("Entregado > Devuelto > Anulado > Tránsito > Pendiente, como la hoja «Revisar»", () => {
    expect(resolveConsolidado([c("roy", "T"), c("aliclik", "E")], true)).toMatchObject({ status: "entregado", by: "aliclik" });
    expect(resolveConsolidado([c("roy", "T"), c("aliclik", "D")], true)).toMatchObject({ status: "devuelto", by: "aliclik" });
    expect(resolveConsolidado([c("roy", "T")], true)).toMatchObject({ status: "anulado", by: null });
    expect(resolveConsolidado([c("roy", "T"), c("yhoni", "T")], false)).toMatchObject({ status: "transito", transitCount: 2 });
    expect(resolveConsolidado([], false)).toMatchObject({ status: "pendiente", transitCount: 0 });
  });

  it("un aporte «0» no cuenta para nada", () => {
    expect(resolveConsolidado([c("roy", "0")], false).status).toBe("pendiente");
  });
});

const facts = (over: Partial<OrderFacts> = {}): OrderFacts => ({
  order_id: "o1",
  store_id: "s1",
  order_name: "#KP1",
  customer_name: null,
  customer_phone: null,
  district: null,
  province: null,
  region: null,
  coverage: null,
  shipping_mode: null,
  order_created_at: "2026-09-16T03:30:00Z",
  order_total: 89,
  general_status: "pendiente",
  operational_status: "sin_confirmar",
  current_courier: null,
  delivered_courier: null,
  attempt_count: 0,
  delivered_at: null,
  returned_at: null,
  guide_code: null,
  cancelled_at: null,
  cancel_reason: null,
  ...over,
});

describe("kaptaContribution", () => {
  it("traduce el estado general de Kapta al alfabeto E/T/D con el courier que lo hizo", () => {
    expect(kaptaContribution(facts({ general_status: "entregado", delivered_courier: "aliclik" }))).toEqual({ sheet_key: "kapta:aliclik", mark: "E" });
    expect(kaptaContribution(facts({ general_status: "devuelto", current_courier: "shalom" }))).toEqual({ sheet_key: "kapta:shalom", mark: "D" });
    expect(kaptaContribution(facts({ general_status: "en_proceso" }))).toEqual({ sheet_key: "kapta:sin_courier", mark: "T" });
    expect(kaptaContribution(facts({ general_status: "pendiente" }))).toBeNull();
    expect(kaptaContribution(facts({ general_status: "anulado" }))).toBeNull();
  });
});

describe("resolveZona", () => {
  const catalog = (key: string) => ({ surquillo: "Lima Centrico", carabayllo: "Lima Periferica", huancayo: "Provincia" })[key] ?? null;

  it("el catálogo manda cuando conoce el distrito, sin importar acentos ni guiones", () => {
    expect(resolveZona(facts({ district: "- SURQUILLO", region: "Lima" }), catalog)).toBe("Lima Centrico");
    expect(resolveZona(facts({ district: "Carabayllo", region: "Lima (departamento)" }), catalog)).toBe("Lima Periferica");
  });

  it("Lima sin catálogo cae a Periférica; Provincia se parte por la cobertura de Kapta", () => {
    expect(resolveZona(facts({ district: "Distrito Nuevo", region: "Lima" }), catalog)).toBe("Lima Periferica");
    expect(resolveZona(facts({ district: "Callao", region: "Callao", coverage: "lima" }), catalog)).toBe("Lima Periferica");
    expect(resolveZona(facts({ district: "Huancayo", region: "Junín", coverage: "provincia_cod" }), catalog)).toBe("Provincia COD");
    expect(resolveZona(facts({ district: "Ilo", region: "Moquegua", coverage: "agencia" }), catalog)).toBe("Provincia Sin COD");
    expect(resolveZona(facts({ district: "Ilo", region: "Moquegua", shipping_mode: "agency" }), catalog)).toBe("Provincia Sin COD");
    expect(resolveZona(facts({ district: "Ilo", region: "Moquegua" }), catalog)).toBeNull();
  });

  it("districtKey normaliza como lo hacía el VLOOKUP tolerante", () => {
    expect(districtKey("\n San Borja")).toBe("san borja");
    expect(districtKey("- CERCADO DE LIMA")).toBe("cercado de lima");
    expect(districtKey("Jesús María")).toBe("jesus maria");
  });
});

describe("intentosLima", () => {
  it("cuenta intentos solo en pedidos abiertos de Lima", () => {
    expect(intentosLima("transito", "Lima Centrico", 2)).toBe(2);
    expect(intentosLima("pendiente", "Lima Periferica", 0)).toBe(0);
    expect(intentosLima("entregado", "Lima Centrico", 2)).toBeNull();
    expect(intentosLima("transito", "Provincia COD", 2)).toBeNull();
    expect(intentosLima("transito", null, 2)).toBeNull();
  });
});

describe("fechas de Lima", () => {
  it("un pedido de las 22:30 de Lima es de ese día, no del siguiente UTC", () => {
    expect(limaDate("2026-09-16T03:30:00Z")).toBe("2026-09-15");
    expect(limaMonthKey("2026-09-01T04:59:00Z")).toBe("2026/8");
    expect(limaMonthKey("2026-09-01T05:00:00Z")).toBe("2026/9");
    expect(limaDate("no es fecha")).toBeNull();
  });
});
