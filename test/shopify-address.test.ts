import { describe, expect, it } from "vitest";
import { hasDeliverableAddress, shopifyShippingAddress } from "@/lib/shopify-address";

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

  // El caso que dejaba pedidos sin dirección en el Excel y en el panel: mientras
  // la app no tuvo acceso a datos protegidos, Shopify devolvía el bloque de
  // envío con solo el teléfono. Preguntar por la existencia del bloque da un
  // objeto truthy y "ya tengo dirección", así que nadie volvía a consultar.
  it("no considera despachable un bloque de envío que solo trae teléfono", () => {
    const soloTelefono = shopifyShippingAddress({ shippingAddress: { phone: "+51950635659" } });
    expect(soloTelefono).not.toBeNull();
    expect(hasDeliverableAddress(soloTelefono)).toBe(false);
  });

  it("considera despachable solo cuando hay calle", () => {
    expect(
      hasDeliverableAddress(
        shopifyShippingAddress({ shippingAddress: { address1: "Jr. Túpac Amaru 1240" } }),
      ),
    ).toBe(true);
    // Ciudad sin calle no alcanza para que el motorizado llegue.
    expect(
      hasDeliverableAddress(shopifyShippingAddress({ shippingAddress: { city: "Juliaca" } })),
    ).toBe(false);
    expect(
      hasDeliverableAddress(shopifyShippingAddress({ shippingAddress: { address1: "   " } })),
    ).toBe(false);
    expect(hasDeliverableAddress(null)).toBe(false);
  });
});
