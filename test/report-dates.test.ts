import { describe, expect, it } from "vitest";
import {
  latestReportDeliveryDate,
  parseReportDeliveryDate,
  reportDeliveryClosedAt,
} from "@/lib/report-dates";

describe("parseReportDeliveryDate", () => {
  it("convierte DD/MM/YYYY de Aliclik a YYYY-MM-DD", () => {
    expect(parseReportDeliveryDate("24/07/2026")).toBe("2026-07-24");
    expect(parseReportDeliveryDate("01/12/2026")).toBe("2026-12-01");
  });

  it("acepta ISO ya normalizado", () => {
    expect(parseReportDeliveryDate("2026-07-24")).toBe("2026-07-24");
    expect(parseReportDeliveryDate("2026-07-24T10:00:00Z")).toBe("2026-07-24");
  });

  it("devuelve null ante vacío o formato raro, en vez de inventar una fecha", () => {
    expect(parseReportDeliveryDate("")).toBeNull();
    expect(parseReportDeliveryDate(null)).toBeNull();
    expect(parseReportDeliveryDate("ENTREGADO")).toBeNull();
    expect(parseReportDeliveryDate("7/24/2026")).toBeNull();
  });

  it("rechaza fechas de calendario imposibles", () => {
    expect(parseReportDeliveryDate("32/01/2026")).toBeNull();
    expect(parseReportDeliveryDate("15/13/2026")).toBeNull();
    expect(parseReportDeliveryDate("15/07/1899")).toBeNull();
  });
});

describe("latestReportDeliveryDate", () => {
  it("toma la entrega más reciente entre varios reportes", () => {
    expect(latestReportDeliveryDate(["20/07/2026", "24/07/2026", "22/07/2026"])).toBe("2026-07-24");
  });
  it("ignora los valores inválidos", () => {
    expect(latestReportDeliveryDate(["", "ENTREGADO", "24/07/2026"])).toBe("2026-07-24");
  });
  it("devuelve null si ninguno es válido", () => {
    expect(latestReportDeliveryDate(["", null, "x"])).toBeNull();
  });
});

describe("reportDeliveryClosedAt", () => {
  it("fija mediodía de Lima para no saltar de día", () => {
    // 17:00Z = 12:00 en Lima (UTC−5): el mismo día en ambas zonas.
    expect(reportDeliveryClosedAt("2026-07-24")).toBe("2026-07-24T17:00:00.000Z");
  });
});
