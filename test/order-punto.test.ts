import { describe, expect, it } from "vitest";
import {
  orderPuntoSource,
  orderPuntoText,
  puntoBrand,
  puntoCollect,
  puntoItemLine,
  puntoItemName,
  shopifyDecimal,
} from "@/lib/order-punto";

/** Sin pagos registrados: el saldo es el total (contraentrega pura). */
const sinPagos = (total: number | null) => puntoCollect(total, { paymentGateway: "cod" }, []);

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
  it("es el metacampo de Shopify de #KP143817 (Kenku), con la cantidad delante del producto", () => {
    const source = orderPuntoSource(KP143817_RAW, 89);
    const text = orderPuntoText({
      source,
      collect: sinPagos(source.total),
      storeName: "Kenku Peru",
      orderName: "#KP143817",
      items: [{ title: "Nails Repairing – Sérum Tea Tree Ginger para Uñas (30ml)", variant_title: null, quantity: 1 }],
      fallbackPhone: "51944047566",
    });
    // Sin adelanto el saldo es el total: lo único distinto de Shopify es «1 x»
    // (decisión del owner, 25-10-2026).
    expect(text).toBe(KP143817_METAFIELD.replace("\n  Nails Repairing", "\n  1 x Nails Repairing"));
  });

  it("es el de la captura de #AUR178593 (Aurela), con dos productos", () => {
    const source = orderPuntoSource(AUR178593_RAW, 89.1);
    const text = orderPuntoText({
      source,
      collect: sinPagos(source.total),
      storeName: "Aurela",
      orderName: "#AUR178593",
      items: [
        { title: "Cinturón sin Hebilla (Pack de 5)", variant_title: null, quantity: 1 },
        { title: "Organizador de Polos", variant_title: null, quantity: 1 },
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
        "  1 x Cinturón sin Hebilla (Pack de 5)",
        "",
        "  1 x Organizador de Polos",
        "",
      ].join("\n"),
    );
  });

  it("usa el teléfono del cliente solo si la dirección no trae uno", () => {
    const source = orderPuntoSource({ shippingAddress: { name: "Ana", address1: "Jr. Lima 1", city: "Ica" } }, 50);
    const text = orderPuntoText({ source, collect: sinPagos(source.total), storeName: "Aurela", orderName: "#AUR1", items: [], fallbackPhone: "51999888777" });
    expect(text.split("\n")[5]).toBe("51999888777");
  });

  it("sin dirección ni nota deja las líneas vacías, como Liquid", () => {
    const text = orderPuntoText({
      source: orderPuntoSource({}, null),
      collect: null,
      storeName: "Aurela",
      orderName: "#AUR2",
      items: [{ title: "Faja", variant_title: "M / Negro" }],
    });
    expect(text).toBe("PUNTO\n\n\n - \n - \n\nPedido de Aurela #AUR2\nCOBRAR  SOLES\n\n\n\n  Faja - M / Negro\n");
  });

  it("COBRAR es el saldo: el total menos el adelanto validado (25-10-2026)", () => {
    const source = orderPuntoSource({ currentTotalPriceSet: { shopMoney: { amount: "318.5" } } }, 318.5);
    const collect = puntoCollect(source.total, { paymentGateway: "cod" }, [
      { kind: "adelanto", amount: 100, validation_status: "validado" },
    ]);
    const text = orderPuntoText({ source, collect, storeName: "Kenku Peru", orderName: "#KP141876", items: [] });
    expect(text).toContain("\nCOBRAR 218.5 SOLES\n");
  });

  it("un producto con cantidad va como «2 x …», y uno quitado del pedido no va", () => {
    const text = orderPuntoText({
      source: orderPuntoSource({}, 10),
      collect: sinPagos(10),
      storeName: "Kenku Peru",
      orderName: "#KP1",
      items: [
        { title: "Black Seed Oil", variant_title: null, quantity: 5 },
        { title: "Quitado", variant_title: null, quantity: 0 },
        { title: "Vital Moo", variant_title: "Default Title", quantity: 1 },
      ],
    });
    expect(text.endsWith("\n\n  5 x Black Seed Oil\n\n  1 x Vital Moo\n")).toBe(true);
    expect(text).not.toContain("Quitado");
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
      total: 120.5,
      note: "dni 42771213",
    });
  });

  it("lee WooCommerce (forma REST con `total_price` y código postal numérico)", () => {
    const source = orderPuntoSource(
      { shipping_address: { name: "Lucía", address1: "Calle 3", zip: 4001, city: "Arequipa" }, total_price: "89.00" },
      89,
    );
    expect(source.address?.zip).toBe("4001");
    expect(source.total).toBe(89);
  });

  it("sin dirección de envío usa la de facturación, como `displayAddress`", () => {
    const source = orderPuntoSource({ billingAddress: { name: "Pedro", address1: "Jr. Puno 5", city: "Cusco" } }, 10);
    expect(source.address?.name).toBe("Pedro");
  });

  it("sin total en el raw usa el de Kapta", () => {
    expect(orderPuntoSource({}, 75).total).toBe(75);
    expect(orderPuntoSource(null, null)).toEqual({ address: null, total: null, note: null });
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

describe("puntoCollect: lo que cobra el punto (25-10-2026)", () => {
  it("sin pagos es el total", () => {
    expect(puntoCollect(89, { paymentGateway: "cod" }, [])).toEqual({ amount: 89, paid: 0, pending: 0 });
  });

  it("resta solo lo validado de la clienta: ni la rendición del courier ni lo rechazado", () => {
    const c = puntoCollect(300, { paymentGateway: "cod" }, [
      { kind: "adelanto", amount: 50, validation_status: "validado" },
      { kind: "diferencia", amount: 20, validation_status: "validado" },
      { kind: "cobro_courier", amount: 230, validation_status: "validado" },
      { kind: "adelanto", amount: 40, validation_status: "rechazado" },
      { kind: "diferencia", amount: 30, validation_status: "pendiente_revision" },
    ]);
    expect(c).toEqual({ amount: 230, paid: 70, pending: 30 });
  });

  it("pagado en el checkout de la web: no se cobra nada", () => {
    expect(puntoCollect(150, { financialStatus: "paid", paymentGateway: "checkout" }, []).amount).toBe(0);
  });

  it("nunca negativo, y sin pagos legibles no adivina", () => {
    expect(puntoCollect(50, { paymentGateway: "cod" }, [{ kind: "total", amount: 80, validation_status: "validado" }]).amount).toBe(0);
    expect(puntoCollect(50, { paymentGateway: "cod" }, null)).toEqual({ amount: null, paid: 0, pending: 0 });
  });

  it("puntoItemLine: la cantidad delante; sin cantidad legible, solo el nombre", () => {
    expect(puntoItemLine({ title: "Faja", variant_title: "L", quantity: 2 })).toBe("2 x Faja - L");
    expect(puntoItemLine({ title: "Faja" })).toBe("Faja");
  });
});
