// Pedido de Kapta → cuerpo de POST /v1/orders de GF Courier (COD_LIMA). Función pura: la lectura de la base vive en
// lib/gf-courier-guide.ts. Nunca envía datos inventados: si falta algo obligatorio, devuelve el motivo para mostrarlo.
//
// - Nombre: Kapta guarda un solo `customer_name`; se separa en primera palabra / resto (GF exige ambos).
// - Destino: Kapta no guarda ubigeo. Se manda el ubigeo del territorio de WooCommerce si vino; si no, el distrito en
//   texto (GF lo resuelve con alias y responde DISTRICT_NOT_COVERED con la lista válida si no lo cubre).
// - Precios: el total del pedido se reparte en CÉNTIMOS exactos entre las líneas, en proporción a precio × cantidad.
//   Si el importe de una línea no se divide entre sus unidades, se envía el mismo SKU en dos líneas que difieren en
//   S/ 0.01 (GF las agrupa). Así GF cobra exactamente el total, sin el redondeo a soles enteros de Aliclik.
// - Cobro: amount_to_collect = total − adelantos validados.
import type { GfOrderInput } from "@/lib/gf-courier";

export interface GfOrderSource {
  externalId: string;
  customerName: string | null;
  customerPhone: string | null;
  district: string | null;
  ubigeo?: string | null;
  address: string | null;
  reference?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  orderTotal: number | null;
  advancePaid: number;
  scheduledFor?: string | null;
  observations?: string | null;
  lines: { sku: string | null; title?: string | null; quantity: number; price: number }[];
}
export type GfOrderBuild = { ok: true; input: GfOrderInput } | { ok: false; reason: string };

const cents = (soles: number) => Math.round((soles + Number.EPSILON) * 100);
const soles = (c: number) => c / 100;
const clean = (v: unknown) => (typeof v === "string" ? v.replace(/\s+/gu, " ").trim() : "");

// GF acepta el pedido solo con el nombre (16-11-2026): sin apellido, se envía solo first_name.
export function splitName(full: string | null): { first_name: string; last_name?: string } | null {
  const parts = clean(full).split(" ").filter(Boolean);
  if (!parts.length) return null;
  if (parts.length === 1) return { first_name: parts[0]!.slice(0, 70) };
  return { first_name: parts[0]!.slice(0, 70), last_name: parts.slice(1).join(" ").slice(0, 70) };
}

/** Reparte `totalCents` entre las líneas y devuelve ítems de GF que suman exactamente ese total. */
export function allocateLines(lines: GfOrderSource["lines"], totalCents: number): GfOrderInput["items"] | null {
  if (!lines.length || totalCents <= 0 || lines.some((l) => !Number.isInteger(l.quantity) || l.quantity <= 0)) return null;
  const subtotal = lines.reduce((s, l) => s + cents(l.price) * l.quantity, 0);
  const units = lines.reduce((s, l) => s + l.quantity, 0);
  const amounts = lines.map((l) => Math.floor((totalCents * (subtotal > 0 ? cents(l.price) * l.quantity : l.quantity)) / (subtotal > 0 ? subtotal : units)));
  amounts[amounts.length - 1]! += totalCents - amounts.reduce((s, a) => s + a, 0);
  const items: GfOrderInput["items"] = [];
  lines.forEach((l, i) => {
    const amount = amounts[i]!, unit = Math.floor(amount / l.quantity), rest = amount - unit * l.quantity;
    const name = clean(l.title) || undefined;
    if (rest > 0) items.push({ sku: l.sku!, ...(name ? { name } : {}), quantity: rest, unit_price: soles(unit + 1) });
    if (l.quantity - rest > 0) items.push({ sku: l.sku!, ...(name ? { name } : {}), quantity: l.quantity - rest, unit_price: soles(unit) });
  });
  return items;
}

export function buildGfOrderInput(src: GfOrderSource): GfOrderBuild {
  const name = splitName(src.customerName);
  if (!name) return { ok: false, reason: "Falta el nombre del cliente." };
  const phone = clean(src.customerPhone);
  if (!phone) return { ok: false, reason: "Falta el teléfono del cliente." };
  const address = clean(src.address);
  if (address.length < 5) return { ok: false, reason: "Falta la dirección de entrega." };
  const ubigeo = clean(src.ubigeo);
  const district = clean(src.district);
  if (!/^\d{6}$/.test(ubigeo) && !district) return { ok: false, reason: "Falta el distrito de entrega." };
  if (src.lines.some((l) => !clean(l.sku))) return { ok: false, reason: "Hay un producto sin SKU: GF solo despacha productos de su catálogo." };
  if (src.orderTotal == null || !(src.orderTotal > 0)) return { ok: false, reason: "El pedido no tiene un total válido." };
  const total = cents(src.orderTotal), advance = Math.max(0, cents(src.advancePaid));
  if (advance > total) return { ok: false, reason: "Los adelantos validados superan el total del pedido." };
  const items = allocateLines(src.lines.map((l) => ({ ...l, sku: clean(l.sku) })), total);
  if (!items) return { ok: false, reason: "No se pudo repartir el total entre los productos." };
  const gps = src.latitude != null && src.longitude != null && Number.isFinite(src.latitude) && Number.isFinite(src.longitude)
    ? `${src.latitude},${src.longitude}` : undefined;
  const reference = clean(src.reference);
  const observations = clean(src.observations);
  return {
    ok: true,
    input: {
      external_id: src.externalId,
      service: "COD_LIMA",
      recipient: { ...name, phone },
      destination: { ...(/^\d{6}$/.test(ubigeo) ? { ubigeo } : {}), ...(district ? { district } : {}), address: address.slice(0, 300),
        ...(reference ? { reference: reference.slice(0, 300) } : {}), ...(gps ? { gps } : {}) },
      items,
      payment: { total: soles(total), advance_paid: soles(advance), amount_to_collect: soles(total - advance) },
      ...(src.scheduledFor ? { scheduled_date: src.scheduledFor } : {}),
      ...(observations ? { observations: observations.slice(0, 500) } : {}),
    },
  };
}
