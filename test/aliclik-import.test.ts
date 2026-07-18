import { describe, it, expect } from "vitest";
import {
  parseAliclikAttempts,
  parseAliclikCoordinate,
  parseAliclikDate,
  parseAliclikRow,
  parseAliclikReport,
  normalizeOrderName,
} from "@/lib/aliclik-import";

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
  it("reads Aliclik's NRO. INTENTOS and operative delivery date", () => {
    const row = parseAliclikRow({
      "NRO. PEDIDO": "AUR5X120731",
      "NRO. INTENTOS": "3",
      "FECHA ENTREGA": "14/07/2026",
    });
    expect(row.aliclik_attempts).toBe(3);
    expect(row.aliclik_service_date).toBe("2026-07-14");
  });

  it("normalizes Excel ISO dates and rejects invalid source values", () => {
    expect(parseAliclikDate("2026-07-18T00:00:00.000Z")).toBe("2026-07-18");
    expect(parseAliclikDate("18/07/26")).toBe("2026-07-18");
    expect(parseAliclikDate("31/02/2026")).toBeNull();
    expect(parseAliclikAttempts("Intento 2")).toBe(2);
    expect(parseAliclikAttempts("")).toBeNull();
  });

  it("reads the full delivery destination and coordinates from Aliclik", () => {
    const row = parseAliclikRow({
      "NRO. PEDIDO": "AUR5X763370265582",
      DIRECCION: "Av. José Gálvez 145, Urb. Miramar",
      REFERENCIA: "Puerta azul, frente al parque",
      DISTRITO: "Ilo",
      PROVINCIA: "Ilo",
      DEPARTAMENTO: "Moquegua",
      LATITUD: "-17.6468721185573",
      LONGITUD: "-71.3448429172091",
    });

    expect(row.delivery_address).toBe("Av. José Gálvez 145, Urb. Miramar");
    expect(row.delivery_reference).toBe("Puerta azul, frente al parque");
    expect(row.region).toBe("Moquegua");
    expect(row.latitude).toBe(-17.6468721185573);
    expect(row.longitude).toBe(-71.3448429172091);
  });

  it("accepts decimal commas and rejects coordinates outside the valid range", () => {
    expect(parseAliclikCoordinate("-16,442941896382326", "latitude")).toBeCloseTo(
      -16.442941896382326,
    );
    expect(parseAliclikCoordinate("-71,5566983697624", "longitude")).toBeCloseTo(
      -71.5566983697624,
    );
    expect(parseAliclikCoordinate("-91", "latitude")).toBeNull();
    expect(parseAliclikCoordinate("181", "longitude")).toBeNull();
    expect(parseAliclikCoordinate("sin coordenada", "latitude")).toBeNull();
  });

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
    // classification is customer-outcome centric: anything not delivered → pendiente
    expect(row.delivery_status).toBe("pendiente");
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
    // order ref (#KP…) is inside "NOTA"; the delivery outcome in "ESTADO ENTREGA".
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
    expect(row.delivery_status).toBe("pendiente"); // not delivered → gestión queue
    expect(row.store_hint).toBe("KENKU");
  });

  it("treats ESTADO ENTREGA=ENTREGADO as delivered even when ESTADO DESPACHO=VALIDADO", () => {
    // A confirmed delivery only shows up in "ESTADO ENTREGA" (the despacho column
    // tops out at "validado"). This is the most common pair.
    const row = parseAliclikRow({
      "NRO. PEDIDO": "AUR5X1",
      "ESTADO DESPACHO": "VALIDADO",
      "ESTADO ENTREGA": "ENTREGADO",
    });
    expect(row.delivery_status).toBe("entregado");
  });

  it("detects delivery via the 'ESTADO DE ENTREGA' header variant too", () => {
    // some exports name the column with "DE" — must still classify as entregado.
    expect(
      parseAliclikRow({
        "NRO. PEDIDO": "AUR5X108281725702",
        "ESTADO DESPACHO": "VALIDADO",
        "ESTADO DE ENTREGA": "ENTREGADO",
      }).delivery_status,
    ).toBe("entregado");
    // entregado closes even with a failure-branch despacho (ciclo ya finalizado)
    expect(
      parseAliclikRow({
        "NRO. PEDIDO": "AUR5X2",
        "ESTADO DESPACHO": "POR DEVOLVER",
        "ESTADO DE ENTREGA": "ENTREGADO",
      }).delivery_status,
    ).toBe("entregado");
  });

  it("classifies every non-delivered outcome as pendiente (enters gestión)", () => {
    // CANCELADO / NO CONTESTA / POR ENTREGAR / etc. → pendiente, regardless of despacho
    for (const entrega of ["CANCELADO", "NO CONTESTA", "POR ENTREGAR", "RECHAZADO"]) {
      expect(
        parseAliclikRow({
          "NRO. PEDIDO": "AUR5X1",
          "ESTADO DESPACHO": "POR DEVOLVER",
          "ESTADO ENTREGA": entrega,
        }).delivery_status,
      ).toBe("pendiente");
    }
  });

  it("extracts a bare-number NOTA token as an unconfirmed candidate (needs phone cross-check)", () => {
    const row = parseAliclikRow({
      "NRO. PEDIDO": "AUR5X114314",
      NOTA: "114314 - referencia",
      "TELÉFONO": "919006661",
      "ESTADO DESPACHO": "VALIDADO",
    });
    expect(row.guide_code).toBe("AUR5X114314");
    // no literal "KP" token → best-effort guess from the bare 6-digit run, but
    // NOT confirmed — the matcher must cross-validate it via phone before using it.
    expect(row.order_name).toBe("#KP114314");
    expect(row.order_name_confirmed).toBe(false);
    expect(row.customer_phone).toBe("51919006661");
  });

  it("matches the real report's bare-number NOTA case (e.g. '119358 -')", () => {
    const row = parseAliclikRow({
      "NRO. PEDIDO": "AUR5X119358",
      NOTA: "119358 -",
    });
    expect(row.order_name).toBe("#KP119358");
    expect(row.order_name_confirmed).toBe(false);
  });

  it("still marks a literal 'KP' token as confirmed", () => {
    const row = parseAliclikRow({
      "NRO. PEDIDO": "AUR5X1",
      NOTA: "#KP115879 - 100 metros adelante de la plaza",
    });
    expect(row.order_name).toBe("#KP115879");
    expect(row.order_name_confirmed).toBe(true);
  });

  it("recognizes '#AUR######' (Aurela's real Shopify order.name) as confirmed", () => {
    const inNota = parseAliclikRow({
      "NRO. PEDIDO": "AUR5X342527857589",
      NOTA: "#AUR173127 - /cliente confirma pedido en llamada>aliclick (mm",
    });
    expect(inNota.order_name).toBe("#AUR173127");
    expect(inNota.order_name_confirmed).toBe(true);

    const inOrderColumn = parseAliclikRow({
      "NRO. PEDIDO": "AUR5X613",
      PEDIDO: "#AUR173123",
    });
    expect(inOrderColumn.order_name).toBe("#AUR173123");
    expect(inOrderColumn.order_name_confirmed).toBe(true);
  });

  it("does not mistake the guide code itself for an order reference", () => {
    // "AUR5X342527857589" has a digit ("5") then a LETTER ("X") right after
    // "AUR" — never satisfies AUR_ORDER_RE's \d{4,} requirement — and it's not
    // 6 digits alone either, so no order_name should be inferred from it.
    const row = parseAliclikRow({
      "NRO. PEDIDO": "AUR5X342527857589",
      NOTA: "AUR5X342527857589",
    });
    expect(row.order_name).toBe(null);
  });

  it("parses a whole report", () => {
    const rows = parseAliclikReport([
      { "Guia Aliclik": "AUR5X1", Estado: "Entregado" },
      { "Guia Aliclik": "AUR5X2", Estado: "Por devolver" },
    ]);
    expect(rows.map((r) => r.delivery_status)).toEqual(["entregado", "pendiente"]);
  });
});
