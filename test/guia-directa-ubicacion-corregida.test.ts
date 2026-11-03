import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { withGeoOverride } from "@/lib/shopify-address";
import { deriveFenixCoverageCity } from "@/lib/shipments";
import { resolveUbigeo } from "@/lib/ubigeo";
import type { OrderShippingAddress } from "@/lib/types";

const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");

const shopify: OrderShippingAddress = {
  address1: "Calle Real 120",
  address2: "Al lado del mercado",
  city: "Castilla",
  province: "Piura",
  name: "Ana Pérez",
  phone: "51999888777",
  latitude: -5.19,
  longitude: -80.62,
};

describe("la guía directa usa la ubicación corregida, como el Master (02-11-2026)", () => {
  it("#KP144042: sin dirección de Shopify, la corrección es el destino y Sullana sale de Piura", () => {
    const address = withGeoOverride(null, {
      region: "Piura",
      province: "Piura",
      district: "Sullana",
      address: "Av. Santa Rosa 409",
      reference: "Frente al hospital de Sullana",
      latitude: -4.8964922,
      longitude: -80.6871,
    });
    expect(address).toMatchObject({
      address1: "Av. Santa Rosa 409",
      address2: "Frente al hospital de Sullana",
      city: "Sullana",
      province: "Piura",
      latitude: -4.8964922,
    });
    // Lo que antes decía «Swayp no tiene cobertura en este destino».
    const city = deriveFenixCoverageCity(address!.city, address!.province);
    expect(city).toBe("piura");
    expect(resolveUbigeo(city, address!.city)).toMatchObject({ code: "200601", exact: true });
  });

  it("gana campo a campo: un nulo en la corrección no borra lo que trae el pedido", () => {
    const address = withGeoOverride(shopify, { district: "Veintiséis de Octubre" });
    expect(address).toMatchObject({
      address1: "Calle Real 120",
      address2: "Al lado del mercado",
      city: "Veintiséis de Octubre",
      province: "Piura",
      name: "Ana Pérez",
      phone: "51999888777",
    });
  });

  it("la provincia de la corrección, o su región si no la hay", () => {
    expect(withGeoOverride(shopify, { region: "Lambayeque", district: "Chiclayo" })?.province).toBe("Lambayeque");
    expect(withGeoOverride(shopify, { region: "Lima", province: "Lima", district: "Surco" })?.province).toBe("Lima");
  });

  it("media coordenada no ubica nada; sin corrección queda la dirección del pedido", () => {
    expect(withGeoOverride(shopify, { latitude: -4.9, longitude: null })?.latitude).toBe(-5.19);
    expect(withGeoOverride(shopify, null)).toBe(shopify);
    expect(withGeoOverride(null, null)).toBeNull();
    expect(withGeoOverride(null, { latitude: -4.9, longitude: -80.6 })).toBeNull();
  });

  it("el resolvedor lee order_geo_overrides y el panel dice de dónde salió", () => {
    const resolver = read("lib/swayp-reenvio.ts");
    expect(resolver).toMatch(/from\("order_geo_overrides"\)/);
    expect(resolver).toContain("withGeoOverride(base.address, override)");
    expect(read("components/direct-fenix-guide-modal.tsx")).toContain('"Ubicación corregida"');
  });
});
