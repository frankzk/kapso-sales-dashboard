import { describe, expect, it } from "vitest";
import {
  orderPuntoSource,
  orderPuntoText,
  puntoBrand,
  puntoItemName,
  shopifyDecimal,
} from "@/lib/order-punto";

// #KP143817 tal como está en `orders.raw` (forma GraphQL), y el metacampo
// «Pedido» que Shopify guardó para ese pedido, leído por la API el 24-10-2026.
const KP143817_RAW = {
  note: "-8.077712018280039, -78.99295136644328",
  shippingAddress: {
    city: "Trujillo",
    name: "cristobal",
    phone: "+51944047566",
    address1: "Av. Revolución 1412, El Porvenir",
    address2: null,
    latitude: -8.0777134,
    province: "La Libertad",
    longitude: -78.992944,
  },
  billingAddress: { phone: "+51944047566" },
  currentTotalPriceSet: { shopMoney: { amount: "89.0", currencyCode: "PEN" } },
};
const KP143817_METAFIELD =
  "PUNTO\ncristobal\nAv. Revolución 1412, El Porvenir\n - \nTrujillo - \n+51944047566\nPedido de Kenku #KP143817\nCOBRAR 89.0 SOLES\n-8.077712018280039, -78.99295136644328\n\n\n  Nails Repairing – Sérum Tea Tree Ginger para Uñas (30ml)\n";

// #AUR178593: el raw de Kapta y el metacampo de la captura del owner.
const AUR178593_RAW = {
  note: "recibe lunes 26-10 escribir primero al whatsapp\n-12.112080368170556, -77.00215866220208",
  shippingAddress: {
    city: "Surquillo",
    name: "Luis Limaco Barnett",
    phone: "+51960197099",
    address1: "Calle Pascal 105",
    address2: "Altura 25 Angamos .",
    province: "Lima (provincia)",
  },
  billingAddress: { phone: "+51960197099" },
  currentTotalPriceSet: { shopMoney: { amount: "89.1", currencyCode: "PEN" } },
};

describe("orderPuntoText", () => {
  it("es idéntico al metacampo de Shopify de #KP143817 (Kenku)", () => {
    const text = orderPuntoText({
      source: orderPuntoSource(KP143817_RAW, 89),
      storeName: "Kenku Peru",
      orderName: "#KP143817",
      items: [{ title: "Nails Repairing – Sérum Tea Tree Ginger para Uñas (30ml)", variant_title: null }],
      fallbackPhone: "51944047566",
    });
    expect(text).toBe(KP143817_METAFIELD);
  });

  it("es el de la captura de #AUR178593 (Aurela), con dos productos", () => {
    const text = orderPuntoText({
      source: orderPuntoSource(AUR178593_RAW, 89.1),
      storeName: "Aurela",
      orderName: "#AUR178593",
      items: [
        { title: "Cinturón sin Hebilla (Pack de 5)", variant_title: null },
        { title: "Organizador de Polos", variant_title: null },
      ],
    });
    expect(text).toBe(
      [
        "PUNTO",
        "Luis Limaco Barnett",
        "Calle Pascal 105",
        "Altura 25 Angamos . - ",
        "Surquillo - ",
        "+51960197099",
        "Pedido de Aurela #AUR178593",
        "COBRAR 89.1 SOLES",
        "recibe lunes 26-10 escribir primero al whatsapp",
        "-12.112080368170556, -77.00215866220208",
        "",
        "",
        "  Cinturón sin Hebilla (Pack de 5)",
        "",
        "  Organizador de Polos",
        "",
      ].join("\n"),
    );
  });

  it("usa el teléfono del cliente solo si la dirección no trae uno", () => {
    const source = orderPuntoSource({ shippingAddress: { name: "Ana", address1: "Jr. Lima 1", city: "Ica" } }, 50);
    const text = orderPuntoText({ source, storeName: "Aurela", orderName: "#AUR1", items: [], fallbackPhone: "51999888777" });
    expect(text.split("\n")[5]).toBe("51999888777");
  });

  it("sin dirección ni nota deja las líneas vacías, como Liquid", () => {
    const text = orderPuntoText({
      source: orderPuntoSource({}, null),
      storeName: "Aurela",
      orderName: "#AUR2",
      items: [{ title: "Faja", variant_title: "M / Negro" }],
    });
    expect(text).toBe("PUNTO\n\n\n - \n - \n\nPedido de Aurela #AUR2\nCOBRAR  SOLES\n\n\n\n  Faja - M / Negro\n");
  });
});

describe("orderPuntoSource", () => {
  it("lee la forma REST: código postal y `current_total_price`", () => {
    const source = orderPuntoSource(
      {
        note: "dni 42771213",
        shipping_address: { name: "Rosa", address1: "Av. Sol 2", address2: "", zip: "15001", city: "Lima", phone: "+51911222333" },
        current_total_price: "120.50",
        total_price: "150.00",
      },
      150,
    );
    expect(source).toEqual({
      address: { name: "Rosa", address1: "Av. Sol 2", address2: "", zip: "15001", city: "Lima", phone: "+51911222333" },
      amount: "120.5",
      note: "dni 42771213",
    });
  });

  it("lee WooCommerce (forma REST con `total_price` y código postal numérico)", () => {
    const source = orderPuntoSource(
      { shipping_address: { name: "Lucía", address1: "Calle 3", zip: 4001, city: "Arequipa" }, total_price: "89.00" },
      89,
    );
    expect(source.address?.zip).toBe("4001");
    expect(source.amount).toBe("89.0");
  });

  it("sin dirección de envío usa la de facturación, como `displayAddress`", () => {
    const source = orderPuntoSource({ billingAddress: { name: "Pedro", address1: "Jr. Puno 5", city: "Cusco" } }, 10);
    expect(source.address?.name).toBe("Pedro");
  });

  it("sin total en el raw usa el de Kapta", () => {
    expect(orderPuntoSource({}, 75).amount).toBe("75.0");
    expect(orderPuntoSource(null, null)).toEqual({ address: null, amount: null, note: null });
  });
});

describe("piezas", () => {
  it("shopifyDecimal da la forma de Shopify", () => {
    expect(shopifyDecimal("89.10")).toBe("89.1");
    expect(shopifyDecimal("89.00")).toBe("89.0");
    expect(shopifyDecimal(89)).toBe("89.0");
    expect(shopifyDecimal("89.15")).toBe("89.15");
    expect(shopifyDecimal("")).toBeNull();
    expect(shopifyDecimal("abc")).toBeNull();
  });

  it("puntoBrand quita el país: «Kenku Peru» → «Kenku»", () => {
    expect(puntoBrand("Kenku Peru")).toBe("Kenku");
    expect(puntoBrand("Kenku Perú")).toBe("Kenku");
    expect(puntoBrand("Aurela")).toBe("Aurela");
  });

  it("puntoItemName es `lineItem.name`: la variante única no se pone", () => {
    expect(puntoItemName({ title: "Faja", variant_title: "Default Title" })).toBe("Faja");
    expect(puntoItemName({ title: "Faja", variant_title: "L" })).toBe("Faja - L");
    expect(puntoItemName({ title: "Faja" })).toBe("Faja");
  });
});
