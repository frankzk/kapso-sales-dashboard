import type { OrderShippingAddress } from "@/lib/types";

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function text(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

/**
 * Coordenada de Shopify. Puede llegar como número o como string según el
 * endpoint, y `null` cuando Shopify no logró geocodificar la dirección.
 *
 * Se descarta 0,0 ("null island"): en la práctica siempre es un dato vacío
 * mal serializado, nunca una dirección de reparto en Perú.
 */
function coord(value: unknown, limit: number): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(n) || n === 0 || Math.abs(n) > limit) return null;
  return n;
}

/**
 * La NOTA del pedido, tal como la escribió una persona en Shopify.
 *
 * POR QUÉ IMPORTA. Es texto libre, pero en la operación no se usa como adorno:
 * ahí es donde la asesora apunta lo que Shopify no tiene campo para guardar. El
 * caso que motivó esto (#KP128879) decía «dni 42771213 shalom SAN JUAN DE
 * MARCONA» — el documento del destinatario y la agencia de destino, que son
 * exactamente los dos datos que el modal de Shalom pide a mano porque «el pedido
 * no los trae». Los traía; nadie los estaba leyendo.
 *
 * SE DEVUELVE TAL CUAL, y eso es una decisión, no pereza. Es tentador sacarle el
 * DNI con una expresión regular y rellenar el campo solo, pero lo escribe una
 * persona distinta cada vez: «dni 42771213», «DNI: 42771213», «doc 42771213»,
 * o el número de otra persona que pagó. Una regla así acertaría casi siempre y
 * fallaría en silencio el resto — y el modo de fallo es emitir una guía a nombre
 * de quien no es. Se muestra el texto y decide quien mira.
 *
 * Vale para las dos formas del payload: REST manda `note` y GraphQL `note`
 * también, pero se acepta `customAttributes`/`note_attributes` aparte (ver
 * `noteAttributesToMap`), que es otra cosa y no se mezcla acá.
 */
export function shopifyOrderNote(raw: unknown): string | null {
  return text(record(raw)?.note);
}

/** Extracts the delivery address from either REST or GraphQL Shopify payloads. */
export function shopifyShippingAddress(raw: unknown): OrderShippingAddress | null {
  const source = record(raw);
  const address = record(source?.shipping_address) ?? record(source?.shippingAddress);
  if (!address) return null;

  const latitude = coord(address.latitude, 90);
  const longitude = coord(address.longitude, 180);

  const result: OrderShippingAddress = {
    address1: text(address.address1),
    address2: text(address.address2),
    city: text(address.city),
    province: text(address.province),
    name: text(address.name),
    phone: text(address.phone),
    // Media coordenada no ubica nada: o las dos o ninguna.
    latitude: latitude !== null && longitude !== null ? latitude : null,
    longitude: latitude !== null && longitude !== null ? longitude : null,
  };
  return Object.values(result).some((v) => v !== null) ? result : null;
}

/** El destino que guarda la propia guía, tal cual sale de `shipments`. */
export interface ShipmentDestination {
  customer_name?: string | null;
  customer_phone?: string | null;
  delivery_address?: string | null;
  delivery_reference?: string | null;
  district?: string | null;
  province?: string | null;
  region?: string | null;
  city?: string | null;
}

/**
 * El destino de una REPROGRAMACIÓN: manda el de la guía, no el del pedido.
 *
 * POR QUÉ. `resolveDirectGuideAddress` busca la dirección en el pedido —el
 * `shippingAddress` de Shopify, el carrito COD, el lead— porque para una guía
 * DIRECTA no hay otra: la salida todavía no existe. Al reprogramar sí existe, y
 * su destino es mejor dato por tres razones: es el que el courier usó, es el que
 * la operadora ve en el drawer («Destino de entrega · Importado desde Aliclik»),
 * y es el que ella puede haber CORREGIDO a mano. Usar el del pedido por encima
 * de una corrección mandaría el paquete de vuelta a la dirección mala.
 *
 * EL CASO: #KP131632, Arequipa, Cerro Colorado. El pedido no tenía
 * `shippingAddress` —ni carrito ni lead—, así que la reprogramación se quedaba
 * sin destino, `buildSwaypGuideInput` fallaba por ciudad vacía y la guía salía
 * con código manual sin decir por qué. La dirección estaba ahí todo el tiempo,
 * en el envío, importada de Aliclik: «AV los incas 203, cerro colorado». Con
 * ella el payload valida y el ubigeo sale exacto (040104). Son 90 envíos de
 * Arequipa con el pedido sin dirección, 51 de ellos con la dirección en la guía.
 *
 * Es el mismo error que la cobertura (MOM §19.0.2): el dato existe, la función
 * lo buscaba donde no estaba.
 *
 * Se resuelve CAMPO A CAMPO y no en bloque: una guía puede traer el distrito y
 * no el teléfono, y quedarse con el bloque entero perdería lo que sí tiene el
 * pedido. Pura.
 */
export function reprogramDestination(
  shipment: ShipmentDestination | null | undefined,
  fromOrder: OrderShippingAddress | null,
): OrderShippingAddress | null {
  const pick = (a: string | null | undefined, b: string | null | undefined): string | null =>
    (a ?? "").trim() || (b ?? "").trim() || null;

  const address: OrderShippingAddress = {
    address1: pick(shipment?.delivery_address, fromOrder?.address1),
    address2: pick(shipment?.delivery_reference, fromOrder?.address2),
    // `city` en `shipments` es la clave de cobertura normalizada («arequipa»),
    // NO el distrito: el distrito vive en `district`. Confundirlos mandaría
    // «arequipa» como distrito y el ubigeo saldría del cercado.
    city: pick(shipment?.district, fromOrder?.city),
    province: pick(shipment?.province ?? shipment?.region, fromOrder?.province),
    name: pick(shipment?.customer_name, fromOrder?.name),
    phone: pick(shipment?.customer_phone, fromOrder?.phone),
    // El envío no guarda coordenadas geocodificadas por Shopify; si el pedido
    // las trae, se conservan.
    latitude: fromOrder?.latitude ?? null,
    longitude: fromOrder?.longitude ?? null,
  };

  // Sin dirección ni distrito no hay destino que valga: devolver un objeto de
  // nulos haría creer al llamador que hay dato.
  return address.address1 || address.city ? address : null;
}
