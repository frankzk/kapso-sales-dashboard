// Parse an Aliclik delivery report (already read into row objects by lib/csv-parse
// or lib/xlsx) into a canonical shape. Pure + tested. Tolerant header matching
// (lowercase/trim/accents). The AUR5X guide code is detected BY VALUE (any cell
// starting with AUR5X), so it works regardless of which column holds it —
// Aliclik exports vary ("GUÍA ALICLICK" in some, "NRO. PEDIDO" in others).

import { normalizePhone } from "./phone";
import { isFenixCity, mapAliclikStatus, normalizeCity } from "./shipments";

export interface ParsedShipmentRow {
  guide_code: string | null; // AUR5X… (required to be a real row)
  order_name: string | null; // normalized "#KP114985" (Shopify ref, when present)
  customer_name: string | null;
  customer_phone: string | null; // normalized
  product: string | null;
  district: string | null;
  city: string | null; // normalized coverage key (Fenix city when covered)
  delivery_status: string; // canonical code
  store_hint: string | null; // raw "Tienda"/"Canal" value (AURELA / KENKU)
  raw: Record<string, string>;
}

function stripAccents(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

/** Canonical header key: lowercased, de-accented, collapsed whitespace. */
function headerKey(h: string): string {
  return stripAccents(h.trim().toLowerCase()).replace(/\s+/g, " ");
}

/** Build a normalized header→value lookup (first non-empty value per key wins). */
function buildLookup(raw: Record<string, string>): Map<string, string> {
  const map = new Map<string, string>();
  for (const [h, v] of Object.entries(raw)) {
    const k = headerKey(h);
    if (v != null && String(v).trim() && !map.has(k)) map.set(k, String(v).trim());
  }
  return map;
}

/** First non-empty value among the given alias keys. */
function pick(map: Map<string, string>, keys: string[]): string | null {
  for (const k of keys) {
    const v = map.get(k);
    if (v && v.trim()) return v.trim();
  }
  return null;
}

// The guide code is always an AUR5X… token; detect it by value, not by header.
const GUIDE_RE = /AUR5X[A-Za-z0-9]+/i;
function findGuideCode(raw: Record<string, string>): string | null {
  for (const v of Object.values(raw)) {
    const m = String(v ?? "").match(GUIDE_RE);
    if (m) return m[0].toUpperCase();
  }
  return null;
}

// A Shopify order name looks like "#KP114985". The Aliclik "NOTA" field often
// carries it (esp. for Kenku) mixed with reference text, so we extract the token.
const KP_RE = /#?\s*(KP\d[A-Za-z0-9-]*)/i;
function extractKpOrderName(...values: (string | null | undefined)[]): string | null {
  for (const v of values) {
    if (!v) continue;
    const m = String(v).match(KP_RE);
    if (m && m[1]) return "#" + m[1].toUpperCase();
  }
  return null;
}

/** Normalize a Shopify-style order name to the "#KP114985" form (used by the
 *  matcher to compare both sides consistently). */
export function normalizeOrderName(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const t = String(raw).trim();
  if (!t) return null;
  const m = t.match(/#?\s*([A-Za-z]*\d[A-Za-z0-9-]*)/);
  if (!m || !m[1]) return null;
  return "#" + m[1].toUpperCase();
}

// Header aliases per canonical field (normalized keys).
const STATUS_KEYS = [
  "estado despacho", // Aliclik "order-delivery-report" — the platform state
  "estado de pedido",
  "estado del pedido",
  "estado de entrega",
  "estado plataforma",
  "estado de plataforma",
  "estado",
  "situacion",
];
const NAME_KEYS = ["nombre completo", "nombre", "cliente", "destinatario"];
const PHONE_KEYS = ["telefono", "celular", "telefono / celular", "whatsapp"];
const PRODUCT_KEYS = ["producto", "productos"];
const DISTRICT_KEYS = ["distrito"];
const PROVINCE_KEYS = ["provincia"];
const DEPARTMENT_KEYS = ["departamento", "region"];
const STORE_KEYS = ["tienda", "canal", "marca", "proveedor"];
const ORDER_KEYS = ["pedido", "numero de pedido", "n pedido", "orden", "order"];
// The customer-facing delivery outcome. In Aliclik's "order-delivery-report"
// the platform column ("ESTADO DESPACHO") tops out at "validado" — a confirmed
// delivery only ever shows up here, as "ENTREGADO". So we read this column to
// override the despacho-derived status when the order was actually delivered.
const ENTREGA_KEYS = ["estado entrega"];

/** True when the "ESTADO ENTREGA" cell says the order was delivered. */
function isDeliveredEntrega(raw: string | null): boolean {
  if (!raw) return false;
  return stripAccents(raw.trim().toLowerCase()) === "entregado";
}

/** Map one report row object → canonical ParsedShipmentRow. */
export function parseAliclikRow(raw: Record<string, string>): ParsedShipmentRow {
  const map = buildLookup(raw);

  const district = pick(map, DISTRICT_KEYS);
  const province = pick(map, PROVINCE_KEYS);
  const department = pick(map, DEPARTMENT_KEYS);
  // city for Fenix coverage: search district + province + department for a known
  // Fenix city; otherwise fall back to the normalized district.
  const combined = [district, province, department].filter(Boolean).join(" ");
  const fenixCity = normalizeCity(combined);
  const city = isFenixCity(fenixCity) ? fenixCity : district ? normalizeCity(district) : null;

  // A confirmed delivery only appears in "ESTADO ENTREGA"; otherwise derive the
  // status from the platform's "ESTADO DESPACHO" (which never reaches entregado).
  const delivery_status = isDeliveredEntrega(pick(map, ENTREGA_KEYS))
    ? "entregado"
    : mapAliclikStatus(pick(map, STATUS_KEYS));

  return {
    guide_code: findGuideCode(raw),
    order_name: extractKpOrderName(map.get("nota"), pick(map, ORDER_KEYS)),
    customer_name: pick(map, NAME_KEYS),
    customer_phone: normalizePhone(pick(map, PHONE_KEYS)),
    product: pick(map, PRODUCT_KEYS),
    district: district || null,
    city: city || null,
    delivery_status,
    store_hint: pick(map, STORE_KEYS),
    raw,
  };
}

/** Parse a whole report. Rows without a guide code are flagged via guide_code=null
 *  (the ingest layer marks them as errors and keeps them for review). */
export function parseAliclikReport(rows: Record<string, string>[]): ParsedShipmentRow[] {
  return rows.map(parseAliclikRow);
}
