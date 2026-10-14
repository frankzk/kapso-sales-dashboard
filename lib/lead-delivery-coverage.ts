// La cobertura de ENTREGA de un lead: la del Master (`order_coverage_for`),
// preguntada con la dirección que dejó en el carrito. Puro.
//
// NO es la pista de la cola (`lib/lead-coverage.ts`: Lima / Provincia / Sin
// identificar), que reparte llamadas y mira también pedidos anteriores. Esta
// responde lo que la vendedora dice en la llamada —contra entrega o adelanto—,
// así que pregunta a la base lo mismo que preguntaría el pedido si naciera con
// esa dirección (MOM §11, «La cobertura en Entrega», 14-10-2026).
//
// La ubicación se arma como la del pedido en `lib/order-master.ts`: la
// provincia del INEI sale del distrito (`peru_districts`), porque Shopify llama
// `province` al departamento; y la coordenada es la que Shopify geocodificó en
// el carrito. Sin coordenada, 1 de cada 7 «Agencia» sería Provincia COD (el
// desempate por cercanía a un punto donde Aliclik ya entregó, 0100).

import { usableAddress } from "@/lib/leads";
import { normalizeDistrict } from "@/lib/shipments";
import type { OrderCoverage } from "@/lib/order-coverage";
import type { OrderShippingAddress } from "@/lib/types";

export interface LeadDeliveryProbe {
  region: string | null;
  province: string | null;
  district: string;
  latitude: number | null;
  longitude: number | null;
}

const text = (v: string | null | undefined) => (v ?? "").trim() || null;

/**
 * Lo que se le pregunta a `order_coverage_for`, o null si el lead no dejó un
 * distrito que sirva: sin distrito, la base clasifica por el departamento y por
 * un punto que Shopify ubicó en el centro de la región, y eso no es una
 * dirección («-» en el formulario del carrito).
 *
 * La coordenada del carrito solo entra si es del MISMO distrito: si el lead
 * dio otro por el chat, el punto del carrito decidiría por un lugar que ya no
 * es el suyo.
 */
export function leadDeliveryProbe(
  lead: { district: string | null; province: string | null; region: string | null },
  geo: { province: string | null; department: string | null } | null,
  shipping: OrderShippingAddress | null,
): LeadDeliveryProbe | null {
  const district = usableAddress(lead.district);
  if (!district) return null;
  const sameDistrict = !!shipping?.city && normalizeDistrict(shipping.city) === normalizeDistrict(district);
  const located = sameDistrict && shipping!.latitude != null && shipping!.longitude != null;
  return {
    region: text(lead.region) ?? text(geo?.department) ?? text(lead.province),
    province: text(geo?.province) ?? text(lead.province),
    district,
    latitude: located ? shipping!.latitude : null,
    longitude: located ? shipping!.longitude : null,
  };
}

const KNOWN: readonly OrderCoverage[] = ["lima", "provincia_cod", "agencia", "por_revisar"];

/** Lo que devolvió la base, si es una cobertura que conocemos. */
export function asOrderCoverage(value: unknown): OrderCoverage | null {
  return typeof value === "string" && (KNOWN as readonly string[]).includes(value) ? (value as OrderCoverage) : null;
}
