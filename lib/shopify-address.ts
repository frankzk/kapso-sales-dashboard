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
