// Canonical shipment state model + helpers. Pure + unit-tested. The model is
// centered on the CALL-GESTIÓN + Fenix delivery flow (not Aliclik's dispatch
// states). Four global states:
//
//   pendiente → (confirma) → en_ruta → (entregado) → entregado
//        │                      │
//        │ no_contesta x7       └ no_contesta → back to pendiente (same intento)
//        ▼                      cancela → anulado
//     anulado
//
// A new guide is `pendiente` (sub-state = intento via reroute_attempts) unless
// the report already says ENTREGADO. The `pendiente` queue is split in the UI by
// `fenix_eligible` (only guides with Fenix stock in their city are worked).

export type ShipmentCategory = "pending" | "in_route" | "delivered" | "closed" | "transferred";

export interface DeliveryStatusDef {
  code: string;
  label: string;
  category: ShipmentCategory;
  callable: boolean; // agent can register a gestión call
  terminal: boolean;
}

export const DELIVERY_STATUSES: DeliveryStatusDef[] = [
  { code: "pendiente", label: "Pendiente", category: "pending", callable: true, terminal: false },
  { code: "en_ruta", label: "En ruta", category: "in_route", callable: true, terminal: false },
  { code: "entregado", label: "Entregado", category: "delivered", callable: false, terminal: true },
  { code: "anulado", label: "Anulado", category: "closed", callable: false, terminal: true },
  // Set on the Aliclik "parent" guide when a Fenix sub-guide is created for it — the
  // Fenix guide becomes the active shipment going forward, so the parent freezes here
  // instead of staying duplicated in the same active tabs as its child.
  { code: "transferido", label: "Transferido", category: "transferred", callable: false, terminal: true },
];

const BY_CODE = new Map(DELIVERY_STATUSES.map((s) => [s.code, s]));

export function statusDef(code: string): DeliveryStatusDef | undefined {
  return BY_CODE.get(code);
}
export function categoryOf(code: string): ShipmentCategory {
  return BY_CODE.get(code)?.category ?? "pending";
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

/** Whether a status is in the managed "Pendiente" bucket (evaluated for Fenix). */
export function isPending(code: string): boolean {
  return categoryOf(code) === "pending";
}

/**
 * ISO time the shipment ENTERED its current status, derived from its call history
 * (the most recent state transition INTO `status`). Lets the panel show "En ruta
 * desde el <día>" — the status alone doesn't say when it was dispatched. Null
 * when no such transition is recorded (e.g. the initial state). Pure.
 */
export function statusSince(
  calls: { new_status: string | null; occurred_at?: string | null }[],
  status: string,
): string | null {
  let best: string | null = null;
  for (const c of calls) {
    if (c.new_status === status && c.occurred_at && (!best || c.occurred_at > best)) {
      best = c.occurred_at;
    }
  }
  return best;
}

/** Sub-state label of a pending shipment, derived from its intento counter. */
export function attemptLabel(attempts: number | null | undefined): string {
  const n = attempts ?? 0;
  if (n <= 0) return "Ingestión";
  return `Intento ${Math.min(n, MAX_INTENTOS)}`;
}

function stripAccents(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
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

// The specific districts Fenix serves within each covered city. Used to
// pre-select the district filter by default (the "routable" districts). City
// (cercado) forms are stored bare so a district cell of just "Arequipa" matches.
export const FENIX_DISTRICTS = [
  // Arequipa
  "jose luis bustamante y rivero", "cerro colorado", "alto selva alegre", "yanahuara",
  "sachaca", "tiabaya", "jacobo hunter", "paucarpata", "arequipa", "sabandia", "socabaya",
  // Trujillo
  "florencia de mora", "el porvenir", "trujillo", "victor larco herrera", "la esperanza",
  "huanchaco", "laredo", "moche", "salaverry",
  // Cusco
  "san sebastian", "san jeronimo", "wanchaq", "santiago", "cusco",
  // Juliaca / Puno
  "juliaca", "san miguel", "puno", "ayaviri",
];

/** Normalize a district label for comparison (lowercase, no accents, collapsed). */
export function normalizeDistrict(raw: string | null | undefined): string {
  if (!raw) return "";
  return stripAccents(String(raw).trim().toLowerCase()).replace(/\s+/g, " ");
}

/** Whether a district is in the Fenix-served set (tolerant: handles "(cercado)"
 *  and longer official names like "… y Rivero"). */
export function isFenixDistrict(raw: string | null | undefined): boolean {
  const d = normalizeDistrict(raw);
  if (!d) return false;
  return FENIX_DISTRICTS.some((c) => d === c || d.startsWith(c) || c.startsWith(d));
}

// ---------------------------------------------------------------------------
// Gestión decision flow — up to 7 call attempts ("intentos") in Pendiente.
//
//   Pendiente:  no_contesta → Intento N+1 ; en el 7º sin respuesta → Anulado
//               confirma    → En ruta (sale a reparto Fenix, mismo intento)
//               cancela     → Anulado ; entregado → Entregado (por Fenix)
//   En ruta:    entregado   → Entregado (Fenix)
//               no_contesta → vuelve a Pendiente al mismo intento
//               cancela     → Anulado
// ---------------------------------------------------------------------------

export const MAX_INTENTOS = 7;

/** The disposition an agent records at the end of a gestión call. */
export type RerouteDisposition =
  | "confirma" // customer confirmed → goes out with Fenix (en_ruta)
  | "no_contesta" // no answer
  | "cancela" // customer cancels / refuses → anulado
  | "entregado"; // delivery confirmed (por Fenix)

export interface ShipmentTransition {
  status: string; // the delivery_status to set
  attempts: number; // the intento counter after this call
  deliveredSource: "fenix" | null; // set when it becomes entregado via gestión
  closed: boolean; // terminal → drop claim + clear follow-up
}

/**
 * Decide the next shipment state from a gestión disposition. `current` is the
 * current delivery_status (pendiente | en_ruta) and `attempts` the current
 * intento counter (0 = ingestión).
 */
export function nextShipmentTransition(
  current: string,
  disposition: RerouteDisposition,
  attempts: number,
): ShipmentTransition {
  const inRoute = current === "en_ruta";
  switch (disposition) {
    case "entregado":
      return { status: "entregado", attempts, deliveredSource: "fenix", closed: true };
    case "cancela":
      return { status: "anulado", attempts, deliveredSource: null, closed: true };
    case "confirma":
      // customer accepts → out for delivery with Fenix (keep the intento reached)
      return { status: "en_ruta", attempts, deliveredSource: null, closed: false };
    case "no_contesta":
    default:
      if (inRoute) {
        // Fenix couldn't reach them → back to the queue at the SAME intento
        return { status: "pendiente", attempts, deliveredSource: null, closed: false };
      }
      // pending: advance the intento; failing past intento 7 gives up → anulado
      {
        const next = attempts + 1;
        if (next > MAX_INTENTOS) {
          return { status: "anulado", attempts: MAX_INTENTOS, deliveredSource: null, closed: true };
        }
        return { status: "pendiente", attempts: next, deliveredSource: null, closed: false };
      }
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

// ---------------------------------------------------------------------------
// Re-import reconciliation — a re-imported report must NOT reset progress the
// team already made (a confirmed guide En ruta, an intento advance). We keep the
// status that is "further along". Import only ever brings `pendiente` (new/being
// worked) or `entregado` (delivered per the report); the agent-only states
// (en_ruta, anulado) must not be regressed by a re-import. Terminal outcomes rank
// highest so they always win / never reopen.
// ---------------------------------------------------------------------------

const STATUS_PRECEDENCE: Record<string, number> = {
  pendiente: 1,
  en_ruta: 2,
  anulado: 3,
  entregado: 3,
  transferido: 4,
};

/** Lifecycle rank used to reconcile a re-imported status (0 = unknown). */
export function statusPrecedence(code: string | null | undefined): number {
  return (code && STATUS_PRECEDENCE[code]) || 0;
}

/**
 * Reconcile the delivery status when re-importing an existing guide: the report
 * only wins if it is strictly further along than what we already have. This
 * preserves agent progress (`en_ruta` survives a report that still says
 * `pendiente`), lets a fresh `entregado` close the guide, and never reopens a
 * terminal (entregado/anulado) state.
 */
export function reconcileDeliveryStatus(existing: string | null | undefined, incoming: string): string {
  if (!existing) return incoming;
  return statusPrecedence(incoming) > statusPrecedence(existing) ? incoming : existing;
}

/**
 * Suggest a Fenix guide code from the linked Shopify order + today's date
 * (DDMMYYYY), e.g. order "#KP118847" on 2026-07-01 → "#KP11884701072026".
 * Just a starting point the operator can edit before creating the guide —
 * `now` is injectable for tests.
 */
export function autoFenixGuideCode(orderName: string | null | undefined, now: Date = new Date()): string {
  if (!orderName?.trim()) return "";
  const dd = String(now.getDate()).padStart(2, "0");
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const yyyy = now.getFullYear();
  return `${orderName.trim()}${dd}${mm}${yyyy}`;
}

/**
 * Guide code for a confirmed re-dispatch (reprogramación). Each confirmed
 * reprogramación must produce a NEW, unique Fenix guide — Fenix rejects
 * re-uploading a guide code it has already seen — so the code carries the
 * reprogramación date (DDMMYYYY) to disambiguate successive dispatches of the
 * same order.
 *
 * `reprogramIso` is the operator-picked date (from `<input type="date">`, encoded
 * by the client as UTC midnight). We read its UTC calendar day so the code
 * reflects the date the operator chose regardless of the server's timezone. When
 * no date is picked, falls back to `now`. Empty string when there's no order name
 * (the caller then keeps the manual "Generar guía Fenix" path). Pure.
 */
export function rescheduleGuideCode(
  orderName: string | null | undefined,
  reprogramIso: string | null | undefined,
  now: Date = new Date(),
): string {
  let date = now;
  if (reprogramIso) {
    const d = new Date(reprogramIso);
    if (!Number.isNaN(d.getTime())) {
      // rebuild at local midnight of the UTC calendar day so autoFenixGuideCode's
      // local getters yield the exact day the operator picked (server-TZ safe)
      date = new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    }
  }
  return autoFenixGuideCode(orderName, date);
}
