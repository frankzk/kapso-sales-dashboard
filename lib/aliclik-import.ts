// Parse an Aliclik delivery report (already read into row objects by lib/csv-parse
// or lib/xlsx) into a canonical shape. Pure + tested. Tolerant header matching
// (lowercase/trim/accents). The AUR5X guide code is detected BY VALUE (any cell
// starting with AUR5X), so it works regardless of which column holds it —
// Aliclik exports vary ("GUÍA ALICLICK" in some, "NRO. PEDIDO" in others).

import { normalizePhone } from "./phone";
import { isFenixCity, normalizeCity } from "./shipments";

export interface ParsedShipmentRow {
  guide_code: string | null; // AUR5X… (required to be a real row)
  order_name: string | null; // normalized "#KP114985" (Shopify ref, when present)
  order_name_confirmed: boolean; // false when order_name is an unconfirmed bare-number
  // guess from free text (NOTA) — the matcher must cross-validate it (phone)
  // before trusting it; true when a literal "KP" token was found.
  customer_name: string | null;
  customer_phone: string | null; // normalized
  product: string | null;
  district: string | null;
  city: string | null; // normalized coverage key (Fenix city when covered)
  region: string | null;
  delivery_address: string | null;
  delivery_reference: string | null;
  latitude: number | null;
  longitude: number | null;
  delivery_status: string; // canonical code
  store_hint: string | null; // raw "Tienda"/"Canal" value (AURELA / KENKU)
  // Aliclik's own delivery-attempt counter and operative delivery date. These
  // are intentionally separate from reroute_attempts, which counts the team's
  // calls inside the dashboard.
  aliclik_attempts: number | null;
  aliclik_service_date: string | null; // YYYY-MM-DD
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
// Aurela's own Shopify order.name prefix is "AUR" (e.g. "#AUR173123") — a real,
// deliberate order reference, just like "KP" is for Kenku. The literal "#" is
// required (unlike KP, where it's optional) and at least 4 digits must follow
// "AUR" immediately: the AUR5X… guide code has a letter ("X") right after the
// leading digit, so it can never satisfy \d{4,} here — no collision risk.
const AUR_ORDER_RE = /#\s*(AUR\d{4,}[A-Za-z0-9-]*)/i;
// Sometimes NOTA has just the bare order number (no "KP"/"AUR" prefix), e.g.
// "119358 - referencia". A standalone 6-digit run is our best guess, but free
// text can coincidentally contain unrelated 6-digit numbers — so this is
// returned UNCONFIRMED; the matcher only trusts it after cross-validating a
// second signal (the customer phone) against the guessed order.
const BARE_ORDER_RE = /\b(\d{6})\b/;

interface ExtractedOrderRef {
  name: string | null;
  confirmed: boolean;
}

function extractOrderReference(
  nota: string | null | undefined,
  orderColumnValue: string | null | undefined,
): ExtractedOrderRef {
  for (const v of [nota, orderColumnValue]) {
    if (!v) continue;
    const s = String(v);
    const kp = s.match(KP_RE);
    if (kp && kp[1]) return { name: "#" + kp[1].toUpperCase(), confirmed: true };
    const aur = s.match(AUR_ORDER_RE);
    if (aur && aur[1]) return { name: "#" + aur[1].toUpperCase(), confirmed: true };
  }
  const m = nota ? String(nota).match(BARE_ORDER_RE) : null;
  if (m && m[1]) return { name: "#KP" + m[1], confirmed: false };
  return { name: null, confirmed: false };
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
const NAME_KEYS = ["nombre completo", "nombre", "cliente", "destinatario"];
const PHONE_KEYS = ["telefono", "celular", "telefono / celular", "whatsapp"];
const PRODUCT_KEYS = ["producto", "productos"];
const DISTRICT_KEYS = ["distrito"];
const PROVINCE_KEYS = ["provincia"];
const DEPARTMENT_KEYS = ["departamento", "region"];
const STORE_KEYS = ["tienda", "canal", "marca", "proveedor"];
const ORDER_KEYS = ["pedido", "numero de pedido", "n pedido", "orden", "order"];
const ALICLIK_ATTEMPT_KEYS = ["nro. intentos", "nro intentos", "numero de intentos", "intentos"];
const ALICLIK_SERVICE_DATE_KEYS = [
  "fecha entrega",
  "fecha de entrega",
  "fecha en ruta",
  "fecha de visita",
  "fecha de despacho",
];
const ADDRESS_KEYS = [
  "direccion completa",
  "direccion de entrega",
  "direccion entrega",
  "direccion destino",
  "direccion",
  "domicilio",
];
const REFERENCE_KEYS = ["referencia de entrega", "referencia entrega", "referencia", "ref"];
const LATITUDE_KEYS = ["latitud", "latitude"];
const LONGITUDE_KEYS = ["longitud", "longitude", "lng", "lon"];
// The customer-facing delivery outcome. In Aliclik's "order-delivery-report"
// the platform column ("ESTADO DESPACHO") tops out at "validado" — a confirmed
// delivery only ever shows up here, as "ENTREGADO". So we read this column to
// override the despacho-derived status when the order was actually delivered.
// Header drifts between exports: "ESTADO ENTREGA" / "ESTADO DE ENTREGA"; a bare
// "ESTADO" is used as a last-resort fallback (only ever fires when its value is
// exactly "entregado", so a dispatch-state "ESTADO" won't be misread).
const ENTREGA_KEYS = ["estado entrega", "estado de entrega", "estado"];

/** True when the delivery-outcome cell ("ESTADO [DE] ENTREGA") says delivered. */
function isDeliveredEntrega(raw: string | null): boolean {
  if (!raw) return false;
  return stripAccents(raw.trim().toLowerCase()) === "entregado";
}

export function parseAliclikAttempts(raw: string | null | undefined): number | null {
  if (raw == null || String(raw).trim() === "") return null;
  const match = String(raw).trim().match(/\d+/);
  if (!match) return null;
  const value = Number.parseInt(match[0], 10);
  return Number.isFinite(value) ? Math.max(0, value) : null;
}

export function parseAliclikCoordinate(
  raw: string | null | undefined,
  kind: "latitude" | "longitude",
): number | null {
  if (raw == null || String(raw).trim() === "") return null;
  const value = Number(String(raw).trim().replace(",", "."));
  const limit = kind === "latitude" ? 90 : 180;
  return Number.isFinite(value) && value >= -limit && value <= limit ? value : null;
}

/** Parse the date formats emitted by Aliclik/Excel into a calendar date. */
export function parseAliclikDate(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const value = String(raw).trim();
  if (!value) return null;

  const iso = value.match(/^(\d{4})-(\d{2})-(\d{2})(?:T|\s|$)/);
  if (iso) return validDateKey(Number(iso[1]), Number(iso[2]), Number(iso[3]));

  const local = value.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{2,4})/);
  if (!local) return null;
  const yearRaw = Number(local[3]);
  const year = yearRaw < 100 ? 2000 + yearRaw : yearRaw;
  return validDateKey(year, Number(local[2]), Number(local[1]));
}

function validDateKey(year: number, month: number, day: number): string | null {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return [year, String(month).padStart(2, "0"), String(day).padStart(2, "0")].join("-");
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

  // Classification is customer-outcome centric: only a report that already says
  // ENTREGADO (in "ESTADO [DE] ENTREGA") is delivered; everything else enters the
  // gestión queue as "pendiente" (Ingestión). The Aliclik dispatch state is not
  // used to classify anymore.
  const delivery_status = isDeliveredEntrega(pick(map, ENTREGA_KEYS)) ? "entregado" : "pendiente";

  const orderRef = extractOrderReference(map.get("nota"), pick(map, ORDER_KEYS));

  return {
    guide_code: findGuideCode(raw),
    order_name: orderRef.name,
    order_name_confirmed: orderRef.confirmed,
    customer_name: pick(map, NAME_KEYS),
    customer_phone: normalizePhone(pick(map, PHONE_KEYS)),
    product: pick(map, PRODUCT_KEYS),
    district: district || null,
    city: city || null,
    region: department || null,
    delivery_address: pick(map, ADDRESS_KEYS),
    delivery_reference: pick(map, REFERENCE_KEYS),
    latitude: parseAliclikCoordinate(pick(map, LATITUDE_KEYS), "latitude"),
    longitude: parseAliclikCoordinate(pick(map, LONGITUDE_KEYS), "longitude"),
    delivery_status,
    store_hint: pick(map, STORE_KEYS),
    aliclik_attempts: parseAliclikAttempts(pick(map, ALICLIK_ATTEMPT_KEYS)),
    aliclik_service_date: parseAliclikDate(pick(map, ALICLIK_SERVICE_DATE_KEYS)),
    raw,
  };
}

/** Parse a whole report. Rows without a guide code are flagged via guide_code=null
 *  (the ingest layer marks them as errors and keeps them for review). */
export function parseAliclikReport(rows: Record<string, string>[]): ParsedShipmentRow[] {
  return rows.map(parseAliclikRow);
}
