import { describe, expect, it } from "vitest";
import { reprogramDestination, shopifyShippingAddress } from "@/lib/shopify-address";

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

/**
 * El destino de una reprogramación.
 *
 * EL CASO: #KP131632, Arequipa / Cerro Colorado. Se pidió guía por API y salió
 * con código manual. El pedido no tenía `shippingAddress` de Shopify, ni carrito
 * COD, ni lead — las tres fuentes que mira `resolveDirectGuideAddress`—, así que
 * la reprogramación se quedaba sin destino y el payload fallaba por ciudad
 * vacía. La dirección estaba en el ENVÍO todo el tiempo, importada de Aliclik.
 * 90 envíos de Arequipa con el pedido sin dirección, 51 con la dirección en la
 * guía.
 */
describe("reprogramDestination: manda el destino de la guía", () => {
  const delPedido = {
    address1: "Calle Vieja 1", address2: null, city: "Yanahuara", province: "Arequipa",
    name: "Nombre Viejo", phone: "959000111", latitude: -16.4, longitude: -71.5,
  };

  it("EL CASO #KP131632: sin dirección en el pedido, usa la del envío", () => {
    const r = reprogramDestination(
      {
        customer_name: "Cliente AQP", customer_phone: "51981125862",
        delivery_address: "AV los incas 203, cerro colorado", delivery_reference: null,
        district: "Cerro Colorado", province: "Arequipa", region: "Arequipa", city: "arequipa",
      },
      null,
    );
    expect(r).not.toBeNull();
    expect(r!.address1).toBe("AV los incas 203, cerro colorado");
    // El DISTRITO, no la clave de cobertura: mandar «arequipa» sacaría el
    // ubigeo del cercado y el paquete iría al distrito equivocado.
    expect(r!.city).toBe("Cerro Colorado");
    expect(r!.phone).toBe("51981125862");
  });

  it("la corrección manual de la guía gana sobre el pedido", () => {
    // Si la operadora corrigió el destino, usar el del pedido devolvería el
    // paquete a la dirección mala. Es el motivo de que la guía mande.
    const r = reprogramDestination(
      { delivery_address: "Av. Corregida 500", district: "Cayma", province: "Arequipa" },
      delPedido,
    );
    expect(r!.address1).toBe("Av. Corregida 500");
    expect(r!.city).toBe("Cayma");
  });

  it("se resuelve campo a campo: lo que falta en la guía lo pone el pedido", () => {
    // Una guía puede traer distrito y no teléfono. Quedarse con el bloque
    // entero perdería el dato bueno del pedido.
    const r = reprogramDestination(
      { delivery_address: "Av. Nueva 9", district: "Cayma", customer_phone: null },
      delPedido,
    );
    expect(r!.address1).toBe("Av. Nueva 9");
    expect(r!.phone).toBe("959000111");
    expect(r!.name).toBe("Nombre Viejo");
  });

  it("sin destino en la guía, el pedido manda entero", () => {
    expect(reprogramDestination(null, delPedido)).toEqual(delPedido);
    expect(reprogramDestination({}, delPedido)).toMatchObject({ address1: "Calle Vieja 1" });
  });

  it("blancos no cuentan como dato", () => {
    const r = reprogramDestination({ delivery_address: "   ", district: "  " }, delPedido);
    expect(r!.address1).toBe("Calle Vieja 1");
    expect(r!.city).toBe("Yanahuara");
  });

  it("`region` sirve de respaldo cuando no hay `province`", () => {
    const r = reprogramDestination(
      { delivery_address: "X 1", district: "Cayma", province: null, region: "Arequipa" },
      null,
    );
    expect(r!.province).toBe("Arequipa");
  });

  it("sin dirección ni distrito devuelve null, no un objeto de nulos", () => {
    // Devolver el objeto haría creer al llamador que hay destino.
    expect(reprogramDestination({ customer_phone: "959111222" }, null)).toBeNull();
    expect(reprogramDestination(null, null)).toBeNull();
  });

  it("conserva las coordenadas del pedido: el envío no las tiene", () => {
    const r = reprogramDestination({ delivery_address: "Av. Nueva 9", district: "Cayma" }, delPedido);
    expect(r!.latitude).toBe(-16.4);
    expect(r!.longitude).toBe(-71.5);
  });
});
