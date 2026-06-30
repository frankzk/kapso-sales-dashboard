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

  it("parses the real 'order-delivery-report' export (AUR5X en NRO. PEDIDO)", () => {
    // Real column layout: the AUR5X code lives in "NRO. PEDIDO"; the Shopify
    // order ref (#KP…) is inside "NOTA"; state in "ESTADO DESPACHO".
    const row = parseAliclikRow({
      "NRO. PEDIDO": "AUR5X119633",
      NOTA: "#KP115879 - 100 metros adelante de la plaza",
      "NOMBRE COMPLETO": "Perla Guerrero Linares",
      "TELÉFONO": "51965956470",
      PRODUCTO: "SUPER HUMAN Ethiopian Black Seed Oil",
      DISTRITO: "Cusco",
      PROVINCIA: "Cusco",
      DEPARTAMENTO: "Cusco",
      "ESTADO DESPACHO": "POR DEVOLVER",
      CANAL: "KENKU",
    });
    expect(row.guide_code).toBe("AUR5X119633"); // detected by value, not header
    expect(row.order_name).toBe("#KP115879"); // extracted from NOTA
    expect(row.customer_name).toBe("Perla Guerrero Linares");
    expect(row.customer_phone).toBe("51965956470");
    expect(row.city).toBe("cusco");
    expect(row.delivery_status).toBe("por_devolver"); // from ESTADO DESPACHO
    expect(row.store_hint).toBe("KENKU");
  });

  it("uses ESTADO DESPACHO over other status columns", () => {
    const row = parseAliclikRow({
      "NRO. PEDIDO": "AUR5X1",
      "ESTADO DESPACHO": "VALIDADO",
      "ESTADO ENTREGA": "ENTREGADO",
    });
    expect(row.delivery_status).toBe("validado");
  });

  it("flags an Aurela row with no #KP as no order_name (matches by phone later)", () => {
    const row = parseAliclikRow({
      "NRO. PEDIDO": "AUR5X114314",
      NOTA: "114314 - referencia",
      "TELÉFONO": "919006661",
      "ESTADO DESPACHO": "ENTREGADO".replace("ENTREGADO", "VALIDADO"),
    });
    expect(row.guide_code).toBe("AUR5X114314");
    expect(row.order_name).toBe(null); // no #KP token → relies on phone match
    expect(row.customer_phone).toBe("51919006661");
  });

  it("parses a whole report", () => {
    const rows = parseAliclikReport([
      { "Guia Aliclik": "AUR5X1", Estado: "Entregado" },
      { "Guia Aliclik": "AUR5X2", Estado: "Por devolver" },
    ]);
    expect(rows.map((r) => r.delivery_status)).toEqual(["entregado", "por_devolver"]);
  });
});
