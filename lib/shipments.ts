// Canonical shipment (delivery) state model + helpers. Pure + unit-tested.
// Mirrors lib/leads.ts. Models the Aliclik delivery state machine plus the Fenix
// re-routing overlay used when a delivery fails in a covered city with stock.
//
// Happy path:  por_preparar → preparado → recolectado → en_agencia → validado → entregado
// Failure:     por_devolver / dejado_almacen / remanente_transito → reprogramado → devuelto

export type ShipmentCategory = "in_transit" | "delivered" | "failure" | "rerouting" | "closed";

export interface DeliveryStatusDef {
  code: string;
  label: string;
  category: ShipmentCategory;
  callable: boolean; // appears in the "Por reprogramar" call queue
  terminal: boolean;
}

export const DELIVERY_STATUSES: DeliveryStatusDef[] = [
  // happy path
  { code: "por_preparar", label: "Por preparar", category: "in_transit", callable: false, terminal: false },
  { code: "preparado", label: "Preparado", category: "in_transit", callable: false, terminal: false },
  { code: "recolectado", label: "Recolectado", category: "in_transit", callable: false, terminal: false },
  { code: "en_agencia", label: "En agencia", category: "in_transit", callable: false, terminal: false },
  { code: "validado", label: "Validado", category: "in_transit", callable: false, terminal: false },
  { code: "entregado", label: "Entregado", category: "delivered", callable: false, terminal: true },
  // failure branch — these enter the re-route / call queue
  { code: "por_devolver", label: "Por devolver", category: "failure", callable: true, terminal: false },
  { code: "dejado_almacen", label: "Dejado en almacén", category: "failure", callable: true, terminal: false },
  { code: "remanente_transito", label: "Remanente en tránsito", category: "failure", callable: true, terminal: false },
  { code: "reprogramado", label: "Reprogramado", category: "rerouting", callable: true, terminal: false },
  { code: "devuelto", label: "Devuelto", category: "closed", callable: false, terminal: true },
];

const BY_CODE = new Map(DELIVERY_STATUSES.map((s) => [s.code, s]));

export function statusDef(code: string): DeliveryStatusDef | undefined {
  return BY_CODE.get(code);
}
export function categoryOf(code: string): ShipmentCategory {
  return BY_CODE.get(code)?.category ?? "in_transit";
}
export function labelOf(code: string): string {
  return BY_CODE.get(code)?.label ?? code;
}
export function isCallable(code: string): boolean {
  return BY_CODE.get(code)?.callable ?? false;
}
export function isTerminal(code: string): boolean {
  return BY_CODE.get(code)?.terminal ?? false;
}
export function isValidStatus(code: string): boolean {
  return BY_CODE.has(code);
}

/** A failure-branch state that should be evaluated for Fenix re-routing. */
export function isFailureState(code: string): boolean {
  return categoryOf(code) === "failure";
}
/** Whether a status enters the active "Por reprogramar" call queue. */
export function entersRerouteQueue(code: string): boolean {
  const c = categoryOf(code);
  return c === "failure" || c === "rerouting";
}

// ---------------------------------------------------------------------------
// Aliclik report status text → canonical code (best-effort, fuzzy). Mirrors
// mapExcelStatus in lib/leads.ts. Keys are lowercased/trimmed.
// ---------------------------------------------------------------------------

const ALICLIK_STATUS_MAP: Record<string, string> = {
  "por preparar": "por_preparar",
  preparado: "preparado",
  recolectado: "recolectado",
  "en agencia": "en_agencia",
  validado: "validado",
  entregado: "entregado",
  "por devolver": "por_devolver",
  "dejado en almacen": "dejado_almacen",
  "dejado en almacén": "dejado_almacen",
  "remanente en transito": "remanente_transito",
  "remanente en tránsito": "remanente_transito",
  reprogramado: "reprogramado",
  devuelto: "devuelto",
};

function stripAccents(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

/** Map a raw Aliclik delivery-status label to a canonical code (best-effort). */
export function mapAliclikStatus(raw: string | null | undefined): string {
  if (!raw) return "por_preparar";
  const key = stripAccents(raw.trim().toLowerCase()).replace(/\s+/g, " ");
  if (ALICLIK_STATUS_MAP[key]) return ALICLIK_STATUS_MAP[key];
  // fall back to the accent-insensitive lookup over the canonical labels
  for (const def of DELIVERY_STATUSES) {
    if (stripAccents(def.label.toLowerCase()) === key) return def.code;
  }
  return "por_preparar";
}

// ---------------------------------------------------------------------------
// City normalization for Fenix coverage. Collapses "Juliaca/Puno", accents and
// casing to coverage keys. Real gating uses the fenix_stock table; FENIX_CITIES
// is just the known coverage set (extensible later).
// ---------------------------------------------------------------------------

export const FENIX_CITIES = ["huancayo", "juliaca", "puno", "cusco", "arequipa", "trujillo"];

/** Normalize a raw city/district label to a coverage key (lowercase, no accents). */
export function normalizeCity(raw: string | null | undefined): string {
  if (!raw) return "";
  let s = stripAccents(String(raw).trim().toLowerCase());
  s = s.replace(/\s+/g, " ");
  // "Juliaca/Puno", "Juliaca - Puno" → match the first known city token present
  for (const city of FENIX_CITIES) {
    if (s === city || new RegExp(`(^|[^a-z])${city}([^a-z]|$)`).test(s)) return city;
  }
  return s;
}

/** Is this (normalized) city in the Fenix coverage set? */
export function isFenixCity(city: string | null | undefined): boolean {
  return FENIX_CITIES.includes(normalizeCity(city));
}

// ---------------------------------------------------------------------------
// Re-route decision flow — up to 5 call attempts on different days.
//
//   Entregado            → FIN (delivered)
//   No contesta          → dejado en almacén → we call again
//   ¿Acepta reprogramar? Sí → reprogramado → nuevo intento
//                        No → por devolver → devuelto
//   attempts ≥ 5             → devuelto (give up)
// ---------------------------------------------------------------------------

export const MAX_REROUTE_ATTEMPTS = 5;

/** The disposition an agent records at the end of a re-route call. */
export type RerouteDisposition =
  | "entregado" // delivery confirmed
  | "reprograma" // customer agreed to reschedule
  | "no_contesta" // no answer / voicemail
  | "rechaza"; // customer refuses → return

export interface RerouteOutcome {
  status: string; // the delivery_status to set
  outcome: string; // reroute_outcome label
  closed: boolean; // queue should drop this shipment
}

/**
 * Decide the resulting state of a re-route attempt. `attempts` is the count
 * AFTER this attempt is recorded. `eligible` is the Fenix coverage+stock gate.
 */
export function nextRerouteOutcome(
  disposition: RerouteDisposition,
  attempts: number,
  eligible: boolean,
): RerouteOutcome {
  if (!eligible) {
    return { status: "por_devolver", outcome: "sin_cobertura", closed: true };
  }
  switch (disposition) {
    case "entregado":
      return { status: "entregado", outcome: "entregado", closed: true };
    case "rechaza":
      return { status: "devuelto", outcome: "devuelto", closed: true };
    case "reprograma":
      return { status: "reprogramado", outcome: "reprogramado", closed: false };
    case "no_contesta":
    default:
      // out of attempts → give up; otherwise leave it in the queue for another day
      if (attempts >= MAX_REROUTE_ATTEMPTS) {
        return { status: "devuelto", outcome: "devuelto", closed: true };
      }
      return { status: "dejado_almacen", outcome: "fin", closed: false };
  }
}

// ---------------------------------------------------------------------------
// Claim / lock — "Tomar envío", one at a time, auto-released after a TTL.
// Same shape as leads (CLAIM_TTL_MINUTES / isClaimActive).
// ---------------------------------------------------------------------------

export const CLAIM_TTL_MINUTES = 10;

export function isClaimActive(
  claimedAt: string | Date | null | undefined,
  now: Date = new Date(),
): boolean {
  if (!claimedAt) return false;
  const t = typeof claimedAt === "string" ? new Date(claimedAt) : claimedAt;
  return now.getTime() - t.getTime() < CLAIM_TTL_MINUTES * 60_000;
}
