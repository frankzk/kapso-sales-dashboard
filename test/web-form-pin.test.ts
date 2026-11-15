// El «Punto de entrega» del formulario de la web, rotulado en la ficha (15-11-2026).

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { WEB_FORM_PIN_LABEL, isWebFormPin, webFormPin } from "@/lib/web-form-pin";

const note = "Punto de entrega: https://www.google.com/maps?q=-18.010635,-70.254577";

describe("webFormPin", () => {
  it("lee el punto de la nota, también con texto antes", () => {
    expect(webFormPin(note)).toEqual({ lat: -18.010635, lng: -70.254577 });
    expect(webFormPin("// DIRECCIÓN SIN NÚMERO - PEDIR UBICACIÓN POR WHATSAPP Punto de entrega: https://www.google.com/maps?q=-15.469992,-70.120145")).toEqual({
      lat: -15.469992,
      lng: -70.120145,
    });
  });

  it("sin «Punto de entrega», o sin coordenadas, nada", () => {
    expect(webFormPin("https://www.google.com/maps?q=-12.1,-77.0")).toBeNull();
    expect(webFormPin("Punto de entrega: https://maps.app.goo.gl/abc")).toBeNull();
    expect(webFormPin(null)).toBeNull();
  });
});

describe("isWebFormPin", () => {
  it("solo si la ubicación del pedido es ese mismo punto", () => {
    expect(isWebFormPin(note, -18.010635, -70.254577)).toBe(true);
    expect(isWebFormPin(note, "-18.01064", "-70.25458")).toBe(true);
    // Corregida a otro sitio: ya no es el punto de la clienta.
    expect(isWebFormPin(note, -18.02, -70.254577)).toBe(false);
    expect(isWebFormPin(note, null, null)).toBe(false);
  });

  it("la ficha lo rotula así", () => {
    expect(WEB_FORM_PIN_LABEL).toBe("punto que marcó la clienta en la web");
    const drawer = readFileSync(resolve(process.cwd(), "components/order-drawer.tsx"), "utf8");
    expect(drawer).toContain("webPin={isWebFormPin(detail.shopifyNote, detail.row.latitude, detail.row.longitude)}");
    expect(drawer).toContain('if (source === "shopify" && webPin) return WEB_FORM_PIN_LABEL;');
  });
});
