// Parse an Aliclik delivery report (already read into row objects by lib/csv-parse
// or lib/xlsx) into a canonical shape. Pure + tested. Tolerant header matching
// (lowercase/trim/accents), like mapExcelStatus in lib/leads.ts.

import { normalizePhone } from "./phone";
import { mapAliclikStatus, normalizeCity } from "./shipments";

export interface ParsedShipmentRow {
  guide_code: string | null; // AUR5X… (required to be a real row)
  order_name: string | null; // normalized "#KP114985"
  customer_name: string | null;
  customer_phone: string | null; // normalized
  product: string | null;
  district: string | null;
  city: string | null; // normalized coverage key
  delivery_status: string; // canonical code
  store_hint: string | null; // raw "Tienda" value from the report (Kenku/Aurela)
  raw: Record<string, string>;
}

function stripAccents(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

/** Canonical header key: lowercased, de-accented, collapsed whitespace. */
function headerKey(h: string): string {
  return stripAccents(h.trim().toLowerCase()).replace(/\s+/g, " ");
}

// Known Aliclik / spreadsheet header aliases → canonical field. Add aliases as
// new report layouts appear; unknown headers are ignored (kept in `raw`).
const HEADER_ALIASES: Record<string, keyof Omit<ParsedShipmentRow, "raw" | "city" | "delivery_status">> = {
  // guide code
  "guia aliclick": "guide_code",
  "guia aliclik": "guide_code",
  guia: "guide_code",
  "codigo de guia": "guide_code",
  "codigo guia": "guide_code",
  "numero de guia": "guide_code",
  tracking: "guide_code",
  // order
  pedido: "order_name",
  "numero de pedido": "order_name",
  "n pedido": "order_name",
  orden: "order_name",
  order: "order_name",
  // customer
  nombre: "customer_name",
  cliente: "customer_name",
  destinatario: "customer_name",
  // phone
  celular: "customer_phone",
  telefono: "customer_phone",
  "telefono / celular": "customer_phone",
  whatsapp: "customer_phone",
  // product
  producto: "product",
  productos: "product",
  // district
  distrito: "district",
  // store
  tienda: "store_hint",
  marca: "store_hint",
};

// Headers that carry the delivery state (handled specially via mapAliclikStatus).
const STATUS_HEADERS = new Set([
  "estado",
  "estado de pedido",
  "estado del pedido",
  "estado de entrega",
  "estado plataforma",
  "estado de plataforma",
  "situacion",
]);

// Headers that carry the city (separate from district when present).
const CITY_HEADERS = new Set(["ciudad", "provincia", "departamento", "region"]);

/** Normalize a Shopify-style order name to the "#KP114985" form. */
export function normalizeOrderName(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const t = String(raw).trim();
  if (!t) return null;
  // strip surrounding noise, keep the leading # + alphanumerics
  const m = t.match(/#?\s*([A-Za-z]*\d[A-Za-z0-9-]*)/);
  if (!m || !m[1]) return null;
  return "#" + m[1].toUpperCase();
}

/** Map one report row object → canonical ParsedShipmentRow. */
export function parseAliclikRow(raw: Record<string, string>): ParsedShipmentRow {
  const fields: Partial<Record<string, string>> = {};
  let statusRaw: string | null = null;
  let cityRaw: string | null = null;

  for (const [header, value] of Object.entries(raw)) {
    const key = headerKey(header);
    if (STATUS_HEADERS.has(key)) {
      if (!statusRaw && value?.trim()) statusRaw = value;
      continue;
    }
    if (CITY_HEADERS.has(key)) {
      if (!cityRaw && value?.trim()) cityRaw = value;
      continue;
    }
    const field = HEADER_ALIASES[key];
    if (field && fields[field] == null) fields[field] = value;
  }

  const district = fields.district ?? null;
  // city preference: an explicit city/province column, else the district
  const citySource = cityRaw ?? district;

  return {
    guide_code: fields.guide_code?.trim() ? fields.guide_code.trim().toUpperCase() : null,
    order_name: normalizeOrderName(fields.order_name),
    customer_name: fields.customer_name?.trim() || null,
    customer_phone: normalizePhone(fields.customer_phone),
    product: fields.product?.trim() || null,
    district: district?.trim() || null,
    city: citySource ? normalizeCity(citySource) : null,
    delivery_status: mapAliclikStatus(statusRaw),
    store_hint: fields.store_hint?.trim() || null,
    raw,
  };
}

/** Parse a whole report. Rows without a guide code are flagged via guide_code=null
 *  (the ingest layer marks them as errors and keeps them for review). */
export function parseAliclikReport(rows: Record<string, string>[]): ParsedShipmentRow[] {
  return rows.map(parseAliclikRow);
}
