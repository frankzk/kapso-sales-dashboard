import type { OrderShippingAddress } from "@/lib/types";

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function text(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

/** Extracts the delivery address from either REST or GraphQL Shopify payloads. */
export function shopifyShippingAddress(raw: unknown): OrderShippingAddress | null {
  const source = record(raw);
  const address = record(source?.shipping_address) ?? record(source?.shippingAddress);
  if (!address) return null;

  const result: OrderShippingAddress = {
    address1: text(address.address1),
    address2: text(address.address2),
    city: text(address.city),
    province: text(address.province),
    name: text(address.name),
    phone: text(address.phone),
  };
  return Object.values(result).some(Boolean) ? result : null;
}

/**
 * ¿Esta dirección sirve para despachar? Mientras la app no tuvo acceso aprobado
 * a los datos protegidos del cliente, Shopify devolvía el bloque de envío con
 * SOLO el teléfono: hay objeto, pero no hay calle. Ese objeto es truthy, así que
 * preguntar por su mera existencia da "sí tengo dirección" y corta la
 * recuperación en vivo justo en los pedidos que más la necesitan. Quien decida
 * si vale la pena reconsultar a Shopify debe usar esto, no la presencia del
 * bloque.
 */
export function hasDeliverableAddress(address: OrderShippingAddress | null): boolean {
  return Boolean(address?.address1?.trim());
}
