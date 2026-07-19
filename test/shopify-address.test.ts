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
