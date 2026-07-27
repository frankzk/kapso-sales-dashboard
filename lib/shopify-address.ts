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
