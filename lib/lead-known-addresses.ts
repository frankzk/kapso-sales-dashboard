// «Datos de entrega conocidos» en la ficha del lead (MOM §37.9, owner
// 07-11-2026): «en Leads estamos mostrando la información que ya tenemos
// grabada en la base de datos en base al número de celular… ¿Podemos mostrar
// esa información en el drawer de leads para que al equipo de leads le sea más
// fácil registrar las ventas?».
//
// Con el celular del lead, Kapta ya sabe a dónde se le mandó antes: los pedidos
// de Kapta (`order_master`, la ubicación ya resuelta que usa la logística) y el
// historial importado de Shopify (`shopify_history_orders`, MOM §37). La ficha
// muestra hasta 3 direcciones distintas, la más reciente primero, y «Usar en el
// pedido» abre el formulario de pedido con ellas ya escritas. Nunca se guardan
// solas: la asesora las confirma con la clienta antes de generar.
//
// Este fichero es la regla pura (sin base ni servidor): con qué celulares se
// busca, qué direcciones se ofrecen y cómo llenan el formulario. Lo importa el
// cajón (cliente), así que no puede importar nada del servidor. La lectura vive
// en `getCustomerKnownAddresses` (lib/leads-access.ts).

import { cartPhoneVariants } from "@/lib/customer-carts";
import { destinationKey, phoneLookupVariants } from "@/lib/last-known-destination";
import { normalizePhone } from "@/lib/phone";

/** Hasta cuántas direcciones distintas se muestran. */
export const KNOWN_ADDRESSES_MAX = 3;
/** Cuántos pedidos de la clienta se leen por fuente (los más recientes). */
export const KNOWN_ADDRESSES_SCAN = 25;

export type KnownAddressSource = "kapta" | "shopify_historial";

export interface KnownAddress {
  /** Dirección + distrito sin tildes, mayúsculas ni signos: no se repite. */
  key: string;
  /** Quién recibió (el nombre del envío), si se sabe. */
  recipient: string | null;
  address: string;
  /** Línea 2 / referencia. */
  reference: string | null;
  district: string | null;
  /** Provincia (solo la sabe Kapta: Shopify no la trae). */
  province: string | null;
  /** Región / departamento. */
  region: string | null;
  /** Celular de contacto del envío, solo si es otro que el del lead. */
  contactPhone: string | null;
  source: KnownAddressSource;
  /** Número del pedido de donde sale (#KP76022). */
  orderName: string | null;
  /** Fecha de ese pedido. */
  date: string | null;
  /** Ese pedido está anulado (y ningún otro a la misma dirección lo está menos). */
  cancelled: boolean;
  /** Kapta entregó algún pedido de la clienta en esta dirección. */
  delivered: boolean;
  /** Cuántos de los pedidos leídos fueron a esta misma dirección. */
  orders: number;
}

/** Fila de `order_master` con lo que la ficha necesita. */
export interface KaptaAddressRow {
  order_id: string;
  order_name: string | null;
  order_created_at: string | null;
  general_status: string | null;
  customer_name: string | null;
  address: string | null;
  reference: string | null;
  district: string | null;
  province: string | null;
  region: string | null;
}

/**
 * Fila de `shopify_history_orders` (MOM §37), anulados incluidos. En Perú
 * Shopify llama `province` al departamento y `city` al distrito; `address2` es
 * la referencia.
 */
export interface HistoryAddressRow {
  order_name: string;
  created_at: string | null;
  cancelled_at: string | null;
  customer_name: string | null;
  shipping_name: string | null;
  shipping_address1: string | null;
  shipping_address2: string | null;
  shipping_city: string | null;
  shipping_province: string | null;
  shipping_phone: string | null;
}

export const KAPTA_ADDRESS_COLUMNS =
  "order_id,order_name,order_created_at,general_status,customer_name,address,reference,district,province,region";
export const HISTORY_ADDRESS_COLUMNS =
  "order_name,created_at,cancelled_at,customer_name,shipping_name,shipping_address1,shipping_address2,shipping_city,shipping_province,shipping_phone";

const text = (v: string | null | undefined): string | null => {
  const t = (v ?? "").trim();
  return t ? t : null;
};

/**
 * Todas las formas en que puede estar guardado el celular de la clienta: el
 * guardado tal cual, el normalizado (51 + nueve), los nueve nacionales y los
 * prefijos que trae Shopify («051…», «0051…»). Van en un `in` sobre la columna
 * indexada, sin funciones sobre ella. Sin celular, ninguna.
 */
export function customerPhoneVariants(raw: string | null | undefined): string[] {
  return [...new Set([...phoneLookupVariants(raw), ...cartPhoneVariants(raw)])];
}

/** Una dirección sirve si trae la calle y al menos el distrito o la región. */
function usable(address: string | null, district: string | null, region: string | null): boolean {
  return Boolean(text(address) && (text(district) || text(region)));
}

const time = (v: string | null) => (v ? Date.parse(v) || 0 : 0);

export interface PickKnownAddressesInput {
  kapta: readonly KaptaAddressRow[];
  history: readonly HistoryAddressRow[];
  /** El celular del lead: un celular de contacto igual no se repite. */
  leadPhone?: string | null;
  /** El pedido propio del lead: no es «de antes», y su copia del historial tampoco. */
  excludeOrderId?: string | null;
  limit?: number;
}

/**
 * Las direcciones conocidas, de la más reciente a la más vieja, sin repetir la
 * misma dirección. Junta las dos fuentes:
 *
 *   · Kapta manda: un número de pedido que ya está en `order_master` no se toma
 *     del historial (la copia puede ser de antes de una corrección).
 *   · Los anulados entran —la dirección sigue sirviendo— y se marcan.
 *   · Varias veces la misma dirección: se muestra el pedido más reciente que
 *     NO está anulado (si todos lo están, el más reciente), se cuenta cuántos
 *     fueron ahí y se dice si Kapta entregó alguno ahí.
 */
export function pickKnownAddresses(input: PickKnownAddressesInput): KnownAddress[] {
  const limit = input.limit ?? KNOWN_ADDRESSES_MAX;
  const leadNorm = normalizePhone(input.leadPhone);
  const own = text(input.excludeOrderId);

  const all: KnownAddress[] = [];
  const kaptaNames = new Set<string>();
  for (const r of input.kapta) {
    if (r.order_name) kaptaNames.add(r.order_name);
    if (own && r.order_id === own) continue;
    if (!usable(r.address, r.district, r.region)) continue;
    all.push({
      key: destinationKey(r.address, r.district),
      recipient: text(r.customer_name),
      address: text(r.address)!,
      reference: text(r.reference),
      district: text(r.district),
      province: text(r.province),
      region: text(r.region),
      // `order_master.customer_phone` es el mismo celular con que se buscó.
      contactPhone: null,
      source: "kapta",
      orderName: text(r.order_name),
      date: r.order_created_at,
      cancelled: r.general_status === "anulado",
      delivered: r.general_status === "entregado",
      orders: 1,
    });
  }
  for (const r of input.history) {
    // Manda Kapta, también para el propio pedido del lead (su copia).
    if (kaptaNames.has(r.order_name)) continue;
    if (!usable(r.shipping_address1, r.shipping_city, r.shipping_province)) continue;
    const contact = normalizePhone(r.shipping_phone);
    all.push({
      key: destinationKey(r.shipping_address1, r.shipping_city),
      recipient: text(r.shipping_name) ?? text(r.customer_name),
      address: text(r.shipping_address1)!,
      reference: text(r.shipping_address2),
      district: text(r.shipping_city),
      province: null,
      region: text(r.shipping_province),
      contactPhone: contact && contact !== leadNorm ? text(r.shipping_phone) : null,
      source: "shopify_historial",
      orderName: text(r.order_name),
      date: r.created_at,
      cancelled: Boolean(r.cancelled_at),
      // El historial no sabe si se entregó: «fulfilled» en Shopify es despachado.
      delivered: false,
      orders: 1,
    });
  }

  const groups = new Map<string, KnownAddress[]>();
  for (const a of [...all].sort((x, y) => time(y.date) - time(x.date))) {
    const g = groups.get(a.key);
    if (g) g.push(a);
    else groups.set(a.key, [a]);
  }
  const out: KnownAddress[] = [];
  for (const g of groups.values()) {
    const pick = g.find((a) => !a.cancelled) ?? g[0]!;
    out.push({
      ...pick,
      // Lo que falte en el elegido (quién recibe, provincia), del siguiente que lo tenga.
      recipient: pick.recipient ?? g.find((a) => a.recipient)?.recipient ?? null,
      province: pick.province ?? g.find((a) => a.province)?.province ?? null,
      delivered: g.some((a) => a.delivered),
      orders: g.length,
    });
  }
  return out.sort((x, y) => time(y.date) - time(x.date)).slice(0, limit);
}

/** «14 jun 2025», en hora de Lima. */
export function limaDayShort(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d
    .toLocaleDateString("es-PE", { day: "numeric", month: "short", year: "numeric", timeZone: "America/Lima" })
    .replace(/\./g, "");
}

/** «del pedido #KP76022 · 14 jun 2025 · anulado · historial de Shopify». */
export function knownAddressSourceLine(a: KnownAddress): string {
  const parts = [a.orderName ? `del pedido ${a.orderName}` : "de un pedido anterior"];
  const day = limaDayShort(a.date);
  if (day) parts.push(day);
  if (a.cancelled) parts.push("anulado");
  if (a.source === "shopify_historial") parts.push("historial de Shopify");
  return parts.join(" · ");
}

/** Distrito · provincia · región, sin repetir («Lima · Lima · Lima» → «Lima»). */
export function knownAddressPlace(a: Pick<KnownAddress, "district" | "province" | "region">): string | null {
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const p of [a.district, a.province, a.region]) {
    const t = text(p);
    if (!t) continue;
    const k = destinationKey(t, null);
    if (seen.has(k)) continue;
    seen.add(k);
    parts.push(t);
  }
  return parts.length ? parts.join(" · ") : null;
}

/**
 * Lo que «Usar en el pedido» escribe en el formulario de pedido: solo los
 * campos que el formulario tiene. El celular NO se toca: es el del lead, por
 * donde va la confirmación de WhatsApp; el de contacto del envío se copia a
 * mano si la clienta lo pide. La región va al campo «Provincia / Región» (que
 * es el departamento) y el formulario la ajusta a su lista.
 */
export interface OrderFormAddressPrefill {
  /** Null: se queda el nombre que ya trae el formulario. */
  name: string | null;
  address1: string;
  referencia: string;
  district: string;
  province: string;
  /** La nota que el formulario muestra arriba de la dirección. */
  sourceLine: string;
}

export function orderFormPrefill(a: KnownAddress): OrderFormAddressPrefill {
  return {
    name: text(a.recipient),
    address1: a.address,
    // La referencia es de ESTA dirección: sin ella, se vacía la del borrador.
    referencia: text(a.reference) ?? "",
    district: text(a.district) ?? "",
    province: text(a.region) ?? text(a.province) ?? "",
    sourceLine: knownAddressSourceLine(a),
  };
}

/** El texto que copia «Copiar dirección»: lo que se le dicta al courier. */
export function knownAddressCopyText(a: KnownAddress): string {
  return [a.address, a.reference, knownAddressPlace(a)].map(text).filter(Boolean).join(", ");
}

/** Los campos de dirección del formulario de pedido, tal como los tiene. */
export interface OrderFormAddressFields {
  name: string;
  address1: string;
  referencia: string;
  district: string;
  province: string;
}

/**
 * Lo que queda en el formulario después de cargar su borrador: sin prellenado,
 * lo cargado; con él, la dirección elegida entera (calle, referencia, distrito
 * y región van juntas: mezclar la referencia de una con la calle de otra manda
 * el paquete a ninguna) y el nombre de quien recibió, si se sabe.
 */
export function applyOrderFormPrefill(
  loaded: OrderFormAddressFields,
  prefill: OrderFormAddressPrefill | null | undefined,
): OrderFormAddressFields {
  if (!prefill) return loaded;
  return {
    name: prefill.name ?? loaded.name,
    address1: prefill.address1,
    referencia: prefill.referencia,
    district: prefill.district,
    province: prefill.province,
  };
}
