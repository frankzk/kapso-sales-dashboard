import { describe, expect, it } from "vitest";
import { shopifyShippingAddress } from "@/lib/shopify-address";

describe("shopifyShippingAddress", () => {
  it("reads a REST shipping address", () => {
    expect(
      shopifyShippingAddress({
        shipping_address: {
          address1: "Av. Los Incas 123",
          address2: "Puerta azul",
          city: "Wanchaq",
          province: "Cusco",
          name: "Mario Quispe",
          phone: "51984743939",
        },
      }),
    ).toEqual({
      address1: "Av. Los Incas 123",
      address2: "Puerta azul",
      city: "Wanchaq",
      province: "Cusco",
      name: "Mario Quispe",
      phone: "51984743939",
      latitude: null,
      longitude: null,
    });
  });

  it("reads GraphQL camelCase and ignores empty payloads", () => {
    expect(
      shopifyShippingAddress({
        shippingAddress: { address1: " Calle Comercio 8 ", city: "Cusco" },
      }),
    ).toMatchObject({ address1: "Calle Comercio 8", city: "Cusco" });
    expect(shopifyShippingAddress({ shippingAddress: {} })).toBeNull();
    expect(shopifyShippingAddress(null)).toBeNull();
  });
});

describe("coordenadas de Shopify", () => {
  // Shopify geocodifica la dirección del checkout y devuelve el punto en el
  // mismo `shipping_address`. Son las coordenadas que Aliclik exige para
  // cotizar y crear una guía, y estuvieron en `orders.raw` sin leerse porque la
  // consulta GraphQL no las pedía.
  const base = { address1: "Av. Larco 123", city: "Miraflores", province: "Lima" };

  it("las lee como número (REST)", () => {
    const r = shopifyShippingAddress({
      shipping_address: { ...base, latitude: -12.04318, longitude: -77.02824 },
    });
    expect(r?.latitude).toBe(-12.04318);
    expect(r?.longitude).toBe(-77.02824);
  });

  it("las lee como string (algunos endpoints las serializan así)", () => {
    const r = shopifyShippingAddress({
      shippingAddress: { ...base, latitude: "-12.04318", longitude: "-77.02824" },
    });
    expect(r?.latitude).toBe(-12.04318);
    expect(r?.longitude).toBe(-77.02824);
  });

  it("una dirección sin geocodificar deja las dos en null", () => {
    const r = shopifyShippingAddress({
      shipping_address: { ...base, latitude: null, longitude: null },
    });
    expect(r?.latitude).toBeNull();
    expect(r?.longitude).toBeNull();
    // La dirección de texto sigue siendo útil aunque no haya punto.
    expect(r?.address1).toBe("Av. Larco 123");
  });

  it("media coordenada no ubica nada: o las dos o ninguna", () => {
    const r = shopifyShippingAddress({
      shipping_address: { ...base, latitude: -12.04318, longitude: null },
    });
    expect(r?.latitude).toBeNull();
    expect(r?.longitude).toBeNull();
  });

  it("descarta 0,0 y los valores fuera de rango", () => {
    const nullIsland = shopifyShippingAddress({
      shipping_address: { ...base, latitude: 0, longitude: 0 },
    });
    expect(nullIsland?.latitude).toBeNull();

    const fuera = shopifyShippingAddress({
      shipping_address: { ...base, latitude: -91.5, longitude: -77.02824 },
    });
    expect(fuera?.latitude).toBeNull();
  });

  it("un payload con SOLO coordenadas sigue siendo una dirección válida", () => {
    // `Object.values(...).some(Boolean)` descartaba esto: -12.04 es verdadero,
    // pero un 0 no lo sería. Se comprueba contra null, no contra falsy.
    const r = shopifyShippingAddress({
      shipping_address: { latitude: -12.04318, longitude: -77.02824 },
    });
    expect(r).not.toBeNull();
    expect(r?.latitude).toBe(-12.04318);
  });
});
