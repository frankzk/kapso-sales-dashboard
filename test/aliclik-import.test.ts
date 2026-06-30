import { describe, it, expect } from "vitest";
import { parseAliclikRow, parseAliclikReport, normalizeOrderName } from "@/lib/aliclik-import";

describe("normalizeOrderName", () => {
  it("normalizes to #KP… form", () => {
    expect(normalizeOrderName("#KP114985")).toBe("#KP114985");
    expect(normalizeOrderName("kp114985")).toBe("#KP114985");
    expect(normalizeOrderName("  #kp114985 ")).toBe("#KP114985");
    expect(normalizeOrderName("#1001-1")).toBe("#1001-1"); // Shopify edit suffix
    expect(normalizeOrderName("")).toBe(null);
    expect(normalizeOrderName(null)).toBe(null);
  });
});

describe("parseAliclikRow", () => {
  it("maps the spreadsheet headers seen in the real reports", () => {
    const row = parseAliclikRow({
      PEDIDO: "#KP114985",
      TIENDA: "Kenku",
      "GUÍA ALICLICK": "AUR5X114585",
      NOMBRE: "Juani Juani",
      CELULAR: "914699634",
      DISTRITO: "Cusco",
      PRODUCTO: "SUPER HUMAN Ethiopian Black Seed Oil",
      "ESTADO DE PEDIDO": "Por devolver",
    });
    expect(row.guide_code).toBe("AUR5X114585");
    expect(row.order_name).toBe("#KP114985");
    expect(row.customer_name).toBe("Juani Juani");
    expect(row.customer_phone).toBe("51914699634"); // normalized to Peru
    expect(row.product).toContain("SUPER HUMAN");
    expect(row.district).toBe("Cusco");
    expect(row.city).toBe("cusco"); // from district when no city column
    expect(row.delivery_status).toBe("por_devolver");
    expect(row.store_hint).toBe("Kenku");
  });

  it("prefers an explicit city/province column over district", () => {
    const row = parseAliclikRow({
      "Guia Aliclik": "AUR5X999",
      Distrito: "San Sebastián",
      Provincia: "Cusco",
      Estado: "Entregado",
    });
    expect(row.city).toBe("cusco");
    expect(row.district).toBe("San Sebastián");
  });

  it("flags rows with no guide code", () => {
    const row = parseAliclikRow({ NOMBRE: "x", Estado: "Entregado" });
    expect(row.guide_code).toBe(null);
  });

  it("parses a whole report", () => {
    const rows = parseAliclikReport([
      { "Guia Aliclik": "AUR5X1", Estado: "Entregado" },
      { "Guia Aliclik": "AUR5X2", Estado: "Por devolver" },
    ]);
    expect(rows.map((r) => r.delivery_status)).toEqual(["entregado", "por_devolver"]);
  });
});
