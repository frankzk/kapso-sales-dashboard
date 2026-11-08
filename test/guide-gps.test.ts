import { describe, expect, it } from "vitest";
import {
  formatGpsCoordinate,
  gpsMapsUrl,
  gpsPoint,
  gpsSourceFromCreatedVia,
  gpsSourceFromGeoSource,
  gpsSourceLabel,
  guideGpsByEvent,
  guideGpsByShipment,
  guideGpsForCreation,
  guideGpsFromPayload,
  guideGpsPayload,
  guideGpsText,
  limaDayMonth,
  sameGpsPoint,
  type GuideGpsEvent,
  type GuideGpsShipment,
} from "@/lib/guide-gps";

// #KP131756: guía AUR5X134876314687, creada por una asesora el 01-09 con
// -13.5338163, -71.9256485 (el caso del owner, 08-11-2026).
const KP131756_GUIDE: GuideGpsShipment = {
  id: "s1",
  courier: "aliclik",
  guide_code: "AUR5X134876314687",
  external_order_number: "AUR5X134876314687",
  latitude: -13.5338163,
  longitude: -71.9256485,
  created_via: "aliclik_api",
};

const registered = (over: Partial<GuideGpsEvent> = {}): GuideGpsEvent => ({
  id: "e1",
  kind: "guide_registered",
  source: "aliclik",
  courier: "aliclik",
  guide_code: "AUR5X134876314687",
  shipment_id: null,
  occurred_at: "2026-09-01T17:23:06Z",
  payload: { transportName: "ALIDRIVER", deliveryCost: 18.5 },
  ...over,
});

describe("formato", () => {
  it("cinco decimales, redondeando bien los medios", () => {
    expect(formatGpsCoordinate(-13.5338163, -71.9256485)).toBe("-13.53382, -71.92565");
    expect(formatGpsCoordinate(-12.04318, -77.02824)).toBe("-12.04318, -77.02824");
    expect(formatGpsCoordinate(-8.1, -79)).toBe("-8.10000, -79.00000");
    expect(formatGpsCoordinate(0.000001, 1.5)).toBe("0.00000, 1.50000");
  });

  it("el enlace de Maps lleva la coordenada entera", () => {
    expect(gpsMapsUrl(-13.5338163, -71.9256485)).toBe("https://www.google.com/maps?q=-13.5338163,-71.9256485");
  });

  it("la línea completa, con su origen", () => {
    expect(guideGpsText({ lat: -13.5338163, lng: -71.9256485, source: "persona" })).toBe(
      "GPS enviado a Aliclik: -13.53382, -71.92565 · pegado por una persona",
    );
    expect(guideGpsText({ lat: -13.5338163, lng: -71.9256485, source: null })).toBe(
      "GPS enviado a Aliclik: -13.53382, -71.92565",
    );
  });

  it("una coordenada vacía, fuera de rango o 0,0 no se enseña", () => {
    expect(gpsPoint(null, -71)).toBeNull();
    expect(gpsPoint("", "")).toBeNull();
    expect(gpsPoint(0, 0)).toBeNull();
    expect(gpsPoint(-95, -71)).toBeNull();
    expect(gpsPoint("-13.5", "-71.9")).toEqual({ lat: -13.5, lng: -71.9 });
  });

  it("el día y el mes en Lima", () => {
    // 02:00 UTC del 3 de setiembre es todavía el 2 en Lima.
    expect(limaDayMonth("2026-09-03T02:00:00Z")).toBe("02-09");
    expect(limaDayMonth(null)).toBeNull();
  });
});

describe("de dónde salió", () => {
  it("cada origen dice lo suyo", () => {
    expect(gpsSourceLabel({ source: "persona" })).toBe("pegado por una persona");
    expect(gpsSourceLabel({ source: "whatsapp" })).toBe("ubicación de WhatsApp");
    expect(gpsSourceLabel({ source: "google" })).toBe("dirección ubicada en Google");
    expect(gpsSourceLabel({ source: "aproximada" })).toBe("ubicación aproximada (Google)");
    expect(gpsSourceLabel({ source: "historial", fromOrderName: "#KP131756" })).toBe("GPS de la entrega de #KP131756");
    expect(gpsSourceLabel({ source: "historial" })).toBe("GPS de una entrega anterior");
    expect(gpsSourceLabel({ source: "portal" })).toBe("cargado en el portal de Aliclik");
    expect(gpsSourceLabel({ source: null })).toBeNull();
  });

  it("la coordenada del pedido, según quién la puso", () => {
    expect(gpsSourceFromGeoSource("shopify")).toBe("pedido_tienda");
    expect(gpsSourceFromGeoSource("manual")).toBe("pedido_manual");
    expect(gpsSourceFromGeoSource("courier")).toBe("pedido_guia");
    expect(gpsSourceFromGeoSource(null)).toBeNull();
  });

  it("las guías del portal o del reporte no las armó Kapta", () => {
    expect(gpsSourceFromCreatedVia("aliclik_api")).toBeNull();
    expect(gpsSourceFromCreatedVia("aliclik_external_portal_link")).toBe("portal");
    expect(gpsSourceFromCreatedVia(null)).toBe("portal");
  });

  it("al crear: lo que sabe quien llama manda; si no, el campo o el pedido", () => {
    const coordinate = { lat: "-13.5338163", lng: "-71.9256485" };
    const known = { source: "historial" as const, fromOrderId: "o9", fromOrderName: "#KP131756" };
    expect(guideGpsForCreation({ coordinate, typed: true, automatic: false, geoSource: "shopify", known })).toEqual({
      lat: -13.5338163,
      lng: -71.9256485,
      source: "historial",
      fromOrderId: "o9",
      fromOrderName: "#KP131756",
    });
    expect(guideGpsForCreation({ coordinate, typed: true, automatic: false, geoSource: "shopify" }).source).toBe("persona");
    expect(guideGpsForCreation({ coordinate, typed: true, fromWhatsapp: true, automatic: false, geoSource: null }).source).toBe("whatsapp");
    expect(guideGpsForCreation({ coordinate, typed: true, automatic: true, geoSource: null }).source).toBeNull();
    expect(guideGpsForCreation({ coordinate, typed: false, automatic: false, geoSource: "manual" }).source).toBe("pedido_manual");
  });

  it("el payload se lee de vuelta igual", () => {
    const payload = { gps: guideGpsPayload({ lat: -13.5, lng: -71.9, source: "historial", fromOrderId: "o9", fromOrderName: "#KP1" }) };
    expect(guideGpsFromPayload(payload)).toEqual({
      point: { lat: -13.5, lng: -71.9 },
      source: "historial",
      fromOrderId: "o9",
      fromOrderName: "#KP1",
    });
    // La guía de la regla 0317 de antes: solo el pedido, sin la coordenada.
    expect(guideGpsFromPayload({ auto: { kind: "confirmado_chatby", gps_from: "#KP140751" } })).toEqual({
      point: null,
      source: "historial",
      fromOrderId: null,
      fromOrderName: "#KP140751",
    });
    expect(guideGpsFromPayload({ transportName: "ALIDRIVER" })).toBeNull();
    expect(guideGpsFromPayload({ gps: { lat: 1, lng: 2, source: "inventado" } })?.source).toBeNull();
  });
});

describe("el cruce con las guías del pedido (sin rellenar datos viejos)", () => {
  it("#KP131756: el hecho viejo toma la coordenada de su guía, por el código", () => {
    const gps = guideGpsByEvent([registered()], [KP131756_GUIDE]).get("e1");
    expect(gps).toEqual({ lat: -13.5338163, lng: -71.9256485, source: null, fromOrderId: null, fromOrderName: null });
  });

  it("el ALC… provisional del hecho encuentra la guía ya promovida al AUR5X", () => {
    const guide = { ...KP131756_GUIDE, external_order_number: "ALC123" };
    expect(guideGpsByEvent([registered({ guide_code: "ALC123" })], [guide]).has("e1")).toBe(true);
  });

  it("por `shipment_id` aunque el código no cuadre", () => {
    expect(guideGpsByEvent([registered({ guide_code: "OTRO", shipment_id: "s1" })], [KP131756_GUIDE]).has("e1")).toBe(true);
  });

  it("el payload manda sobre la guía: es lo que se mandó", () => {
    const e = registered({ payload: { gps: { lat: -13.1, lng: -71.1, source: "persona" } } });
    expect(guideGpsByEvent([e], [KP131756_GUIDE]).get("e1")).toMatchObject({ lat: -13.1, lng: -71.1, source: "persona" });
  });

  it("la guía 0317 vieja dice de qué entrega salió el GPS", () => {
    const e = registered({ payload: { auto: { kind: "confirmado_chatby", gps_from: "#KP140751" } } });
    expect(guideGpsByEvent([e], [KP131756_GUIDE]).get("e1")).toMatchObject({ source: "historial", fromOrderName: "#KP140751" });
  });

  it("no toca otros hechos ni otros couriers, ni inventa sin coordenada", () => {
    const shalom: GuideGpsShipment = { ...KP131756_GUIDE, id: "s2", courier: "shalom", guide_code: "SH1", external_order_number: null };
    const map = guideGpsByEvent(
      [
        registered({ id: "e2", kind: "courier_status" }),
        registered({ id: "e3", kind: "guide_created", courier: "shalom", source: "shalom", guide_code: "SH1" }),
        registered({ id: "e4", guide_code: "SIN-GUIA" }),
      ],
      [KP131756_GUIDE, shalom],
    );
    expect([...map.keys()]).toEqual([]);
  });

  it("guía del portal sin hecho propio: «cargado en el portal de Aliclik»", () => {
    const portal = { ...KP131756_GUIDE, created_via: null };
    const byShipment = guideGpsByShipment([], [portal]);
    expect(byShipment.get("s1")).toMatchObject({ source: "portal" });
  });

  it("«Salidas y guías» toma el origen del último hecho de su guía", () => {
    const e = registered({ payload: { gps: { lat: -13.5338163, lng: -71.9256485, source: "historial", from_order_name: "#KP1" } } });
    expect(guideGpsByShipment([e], [KP131756_GUIDE]).get("s1")).toMatchObject({ source: "historial", fromOrderName: "#KP1" });
    // Si la guía cambió de punto después, el origen ya no es de ese punto.
    const moved = { ...KP131756_GUIDE, latitude: -13.6 };
    expect(guideGpsByShipment([e], [moved]).get("s1")).toMatchObject({ lat: -13.6, source: null });
  });

  it("el mismo punto, con la precisión que viaja a Aliclik", () => {
    expect(sameGpsPoint({ lat: -13.5338163, lng: -71.9256485 }, { lat: -13.5338163, lng: -71.9256485 })).toBe(true);
    expect(sameGpsPoint({ lat: -13.5338163, lng: -71.9256485 }, { lat: -13.53382, lng: -71.92565 })).toBe(false);
    expect(sameGpsPoint(null, { lat: 1, lng: 1 })).toBe(false);
  });
});
