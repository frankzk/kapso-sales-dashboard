// Canonical shipment state model + helpers. Pure + unit-tested. The model is
// centered on the CALL-GESTIÓN flow. A confirmed reprogramming first stays on
// Aliclik when its weekly/attempt rules allow it; otherwise it can spin off a
// Fenix guide. The shared state machine remains courier-agnostic:
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

/** Whether the shipment already has at least one logged customer call. */
export function hasShipmentContact(contactCount: number | null | undefined): boolean {
  return (contactCount ?? 0) > 0;
}

/** Calendar date selected by the operator is stored as UTC midnight. Compare
 * calendar keys (rather than instants) so a follow-up for July 21 does not
 * become due at 7 p.m. Lima on July 20. */
function dateKeyInTimeZone(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const part = (type: "year" | "month" | "day") =>
    parts.find((p) => p.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

/** UTC interval for the current Lima calendar day. The upper bound is
 * exclusive, ready to use with PostgREST's gte/lt filters. Peru is UTC-5 and
 * does not observe daylight saving time. */
export function limaCalendarDayBounds(now: Date = new Date()): {
  startIso: string;
  endIso: string;
} {
  const limaDate = dateKeyInTimeZone(now, "America/Lima");
  const startMs = Date.parse(`${limaDate}T00:00:00-05:00`);
  return {
    startIso: new Date(startMs).toISOString(),
    endIso: new Date(startMs + 86_400_000).toISOString(),
  };
}

export type AliclikRescheduleReason =
  | "eligible"
  | "not_aliclik"
  | "missing_attempts"
  | "three_attempts"
  | "missing_service_date"
  | "outside_week";

export interface AliclikRescheduleDecision {
  eligible: boolean;
  reason: AliclikRescheduleReason;
  cutoffDate: string;
  today: string;
}

export type AliclikRouteFilter = "all" | "aliclik_available" | "fenix_required";

/**
 * Aliclik permits a reprogramming only for guides dated from the most recent
 * Saturday through today, and only while its own report shows fewer than three
 * delivery attempts. On Saturday the window resets, so older guides move to
 * Fenix. Missing source data fails closed; the UI still offers an audited
 * manual override for exceptional cases.
 */
export function evaluateAliclikReschedule(
  input: {
    courier?: string | null;
    attempts?: number | null;
    serviceDate?: string | null;
  },
  now: Date = new Date(),
): AliclikRescheduleDecision {
  const today = dateKeyInTimeZone(now, "America/Lima");
  const todayUtc = new Date(`${today}T12:00:00.000Z`);
  const daysSinceSaturday = (todayUtc.getUTCDay() + 1) % 7;
  const cutoffDate = new Date(todayUtc.getTime() - daysSinceSaturday * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const result = (eligible: boolean, reason: AliclikRescheduleReason): AliclikRescheduleDecision => ({
    eligible,
    reason,
    cutoffDate,
    today,
  });

  if ((input.courier ?? "aliclik").toLowerCase() !== "aliclik") {
    return result(false, "not_aliclik");
  }
  if (input.attempts == null) return result(false, "missing_attempts");
  if (input.attempts >= 3) return result(false, "three_attempts");
  if (!input.serviceDate || !/^\d{4}-\d{2}-\d{2}$/.test(input.serviceDate)) {
    return result(false, "missing_service_date");
  }
  if (input.serviceDate < cutoffDate || input.serviceDate > today) {
    return result(false, "outside_week");
  }
  return result(true, "eligible");
}

/** Matches the operational route shown in the pending-shipment queue. Non-Aliclik
 * guides are intentionally excluded from the two route-specific options: the
 * filter answers whether an original Aliclik guide can still be managed there. */
export function matchesAliclikRouteFilter(
  input: {
    courier?: string | null;
    statusCategory?: string | null;
    attempts?: number | null;
    serviceDate?: string | null;
  },
  filter: AliclikRouteFilter,
  now: Date = new Date(),
): boolean {
  if (filter === "all") return true;
  if ((input.courier ?? "").toLowerCase() !== "aliclik" || input.statusCategory !== "pending") {
    return false;
  }

  const decision = evaluateAliclikReschedule(input, now);
  return filter === "aliclik_available" ? decision.eligible : !decision.eligible;
}

function selectedUtcDateKey(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0"),
  ].join("-");
}

/** Whether a date-only follow-up is due today (Lima) or overdue. */
export function isShipmentFollowupDue(
  nextFollowupAt: string | null | undefined,
  now: Date = new Date(),
): boolean {
  const selected = selectedUtcDateKey(nextFollowupAt);
  return !!selected && selected <= dateKeyInTimeZone(now, "America/Lima");
}

/** Queue rule used by “Solo sin contactar”: untouched guides are ready now;
 * contacted guides return automatically on their scheduled follow-up date. */
export function isShipmentReadyForContact(
  contactCount: number | null | undefined,
  nextFollowupAt: string | null | undefined,
  now: Date = new Date(),
): boolean {
  return !hasShipmentContact(contactCount) || isShipmentFollowupDue(nextFollowupAt, now);
}

/** Daily queue rule used by “Solo sin contactar hoy”. A guide disappears after
 * any team member calls it today and returns on the next Lima calendar day.
 * Future programmed calls remain hidden until their selected date. */
export function isShipmentReadyForContactToday(
  todayContactCount: number | null | undefined,
  nextFollowupAt: string | null | undefined,
  now: Date = new Date(),
): boolean {
  if (hasShipmentContact(todayContactCount)) return false;
  return !nextFollowupAt || isShipmentFollowupDue(nextFollowupAt, now);
}

/** A programmed call must be at least the next Lima calendar day. */
export function isFutureShipmentFollowup(
  nextFollowupAt: string | null | undefined,
  now: Date = new Date(),
): boolean {
  const selected = selectedUtcDateKey(nextFollowupAt);
  return !!selected && selected > dateKeyInTimeZone(now, "America/Lima");
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

export interface FenixDeliverySchedule {
  hours: string;
  note?: string;
}

const AREQUIPA_SHORT_SCHEDULE_DISTRICTS = [
  "cayma",
  "cerro colorado",
  "tiabaya",
  "socabaya",
  "characato",
  "sabandia",
  "sachaca",
  "jacobo hunter",
];

const AREQUIPA_LONG_SCHEDULE_DISTRICTS = [
  "arequipa",
  "cercado",
  "cercado de arequipa",
  "yanahuara",
  "jose luis bustamante y rivero",
  "alto selva alegre",
  "miraflores",
  "mariano melgar",
  "paucarpata",
];

function belongsToDistrictGroup(district: string, group: string[]): boolean {
  if (!district) return false;
  return group.some(
    (candidate) =>
      district === candidate ||
      district.startsWith(`${candidate} `) ||
      candidate.startsWith(`${district} `),
  );
}

/** Operational delivery hours supplied by Fenix. District takes precedence in
 * cities whose schedule changes within the same province. */
export function getFenixDeliverySchedule(
  city: string | null | undefined,
  district: string | null | undefined,
): FenixDeliverySchedule | null {
  const normalizedCity = normalizeCity(city);
  const normalizedDistrict = normalizeDistrict(district);

  if (normalizedCity === "huancayo") return { hours: "9 a. m.–6 p. m." };
  if (normalizedCity === "trujillo") return { hours: "9 a. m.–5 p. m." };
  if (normalizedCity === "juliaca") return { hours: "9 a. m.–4 p. m." };

  if (normalizedCity === "cusco") {
    if (belongsToDistrictGroup(normalizedDistrict, ["san sebastian", "san jeronimo"])) {
      return { hours: "10 a. m.–1 p. m." };
    }
    if (
      !normalizedDistrict ||
      belongsToDistrictGroup(normalizedDistrict, ["cusco", "wanchaq", "santiago"])
    ) {
      return { hours: "9 a. m.–4 p. m." };
    }
    return null;
  }

  if (normalizedCity === "arequipa") {
    if (belongsToDistrictGroup(normalizedDistrict, AREQUIPA_SHORT_SCHEDULE_DISTRICTS)) {
      return { hours: "9 a. m.–1 p. m.", note: "Sin express ni retorno" };
    }
    if (belongsToDistrictGroup(normalizedDistrict, AREQUIPA_LONG_SCHEDULE_DISTRICTS)) {
      return { hours: "9 a. m.–6 p. m.", note: "No aplica los sábados" };
    }
    return { hours: "Confirmar según distrito" };
  }

  return null;
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
  | "programar" // customer asks for a later call; keep state + intento
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
    case "programar":
      // A real contact that only schedules the next conversation. Do not make
      // it look like a failed attempt and do not change an in-route shipment.
      return { status: current, attempts, deliveredSource: null, closed: false };
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
// Resultado del reporte Fenix — traduce lo que informa el courier a nuestros
// estados internos. La asesora nunca debe elegir directamente `transferido`:
// ese estado se reserva para la guía anterior cuando el sistema crea una hija.
// ---------------------------------------------------------------------------

export const COURIER_REPORT_RESULTS = [
  {
    code: "entregado",
    label: "Entregado",
    optionLabel: "Entregado — cerrar la guía",
    effect: "La guía quedará cerrada como Entregada por Fenix.",
    resultingStatus: "entregado",
    requiresDate: false,
    requiresNote: false,
  },
  {
    code: "no_contesta",
    label: "No contesta",
    optionLabel: "No contesta — volver a gestión",
    effect: "La guía volverá a Pendiente para contactar al cliente; no suma un intento de llamada.",
    resultingStatus: "pendiente",
    requiresDate: false,
    requiresNote: false,
  },
  {
    code: "reprogramado",
    label: "Reprogramado por Fenix",
    optionLabel: "Reprogramado — indicar nueva fecha",
    effect: "La guía continuará En ruta con una nueva fecha de entrega.",
    resultingStatus: "en_ruta",
    requiresDate: true,
    requiresNote: false,
  },
  {
    code: "en_ruta",
    label: "Sigue en ruta / enviado a provincia",
    optionLabel: "Sigue en ruta / enviado a provincia",
    effect: "La guía continuará En ruta sin cambiar la fecha registrada.",
    resultingStatus: "en_ruta",
    requiresDate: false,
    requiresNote: false,
  },
  {
    code: "cancelado",
    label: "Cancelado o rechazado",
    optionLabel: "Cancelado / rechazado — anular la guía",
    effect: "La guía quedará Anulada y saldrá de la gestión activa.",
    resultingStatus: "anulado",
    requiresDate: false,
    requiresNote: true,
  },
] as const;

export type CourierReportResult = (typeof COURIER_REPORT_RESULTS)[number]["code"];

/** An active Fenix dispatch must receive the motorizado/courier outcome before
 * the customer-management flow can create another reprogramming. */
export function shipmentRequiresCourierResult(
  courier: string | null | undefined,
  deliveryStatus: string | null | undefined,
): boolean {
  return courier === "fenix" && deliveryStatus === "en_ruta";
}

export interface CourierReportTransition {
  status: "pendiente" | "en_ruta" | "entregado" | "anulado";
  outcome: string;
  deliveredSource: "fenix" | null;
  closed: boolean;
  clearScheduledDate: boolean;
}

/** Pure transition used by the individual report-entry flow. It deliberately
 * allows a courier correction to reopen an incorrectly closed Fenix guide
 * (e.g. Anulado → No contesta → Pendiente), while `transferido` is blocked by
 * the server action because its active result belongs on the child guide. */
export function courierReportTransition(result: CourierReportResult): CourierReportTransition {
  switch (result) {
    case "entregado":
      return {
        status: "entregado",
        outcome: "courier_entregado",
        deliveredSource: "fenix",
        closed: true,
        clearScheduledDate: true,
      };
    case "no_contesta":
      return {
        status: "pendiente",
        outcome: "courier_no_contesta",
        deliveredSource: null,
        closed: false,
        clearScheduledDate: true,
      };
    case "reprogramado":
      return {
        status: "en_ruta",
        outcome: "courier_reprogramado",
        deliveredSource: null,
        closed: false,
        clearScheduledDate: false,
      };
    case "en_ruta":
      return {
        status: "en_ruta",
        outcome: "courier_en_ruta",
        deliveredSource: null,
        closed: false,
        clearScheduledDate: false,
      };
    case "cancelado":
      return {
        status: "anulado",
        outcome: "courier_cancelado",
        deliveredSource: null,
        closed: true,
        clearScheduledDate: true,
      };
  }
}

// ---------------------------------------------------------------------------
// Claim / lock — "Tomar envío", one at a time, auto-released after a TTL.
// Same shape as leads (CLAIM_TTL_MINUTES / isClaimActive).
// ---------------------------------------------------------------------------

export const CLAIM_TTL_MINUTES = 10;
/** Refresh an open drawer's reservation well before the 10-minute TTL. */
export const SHIPMENT_CLAIM_HEARTBEAT_MS = 4 * 60_000;

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

// ── Métricas de reprogramación (guías Fénix hijas creadas desde el dashboard) ─
// El universo es EXACTO por construcción: cada reprogramación confirmada en el
// dashboard genera una guía Fénix nueva vinculada a la guía Aliclik original
// (fenix_shipment_id) — las entregas de primer intento de Aliclik no entran.
// "En curso" es el RESTO (todo lo que no cerró en entregado/anulado): cubre
// pendiente, en_ruta, transferido, por_preparar y cualquier estado futuro sin
// listas que se desactualicen. La tasa se calcula SOLO sobre casos cerrados
// para que un lote recién reprogramado no la hunda artificialmente.

export const REPROGRAM_STALE_DAYS = 7;

export interface ReprogramChildRow {
  storeId: string | null;
  createdAt: string | null; // cuándo se confirmó la reprogramación
  status: string; // delivery_status actual de la guía
  agent?: string | null; // user id de quien confirmó la reprogramación (null = histórico sin log)
  fenix?: boolean; // true (o ausente) = guía Fénix; false = reprogramación Aliclik
}

/** Clave del asesor no atribuible (guías previas a que se registrara el agente). */
export const REPROGRAM_UNASSIGNED = "sin_asignar";

export interface ReprogramCounts {
  total: number; // reprogramaciones confirmadas (Aliclik + Fénix)
  entregados: number; // entregados de ambos couriers
  entregadosFenix: number; // de `entregados`, los que salieron por una guía Fénix (dato aparte)
  anulados: number;
  enCurso: number; // resto: aún sin desenlace
  enCursoViejos: number; // en curso hace más de REPROGRAM_STALE_DAYS días (probables muertos)
  tasa: number | null; // entregados / (entregados + anulados); null sin cerrados
}

export interface ReprogramWeek {
  start: string; // lunes (fecha local Lima) de la semana
  total: number;
  entregados: number;
  anulados: number;
}

export interface ReprogramStats {
  last30: ReprogramCounts;
  historico: ReprogramCounts;
  porTienda: Record<string, ReprogramCounts>; // histórico, por store id ("otras" si falta)
  porAsesor: Record<string, ReprogramCounts>; // histórico, por user id (REPROGRAM_UNASSIGNED si falta)
  asesorNames: Record<string, string>; // user id → etiqueta legible (la llena el access layer)
  semanas: ReprogramWeek[]; // últimas 8 semanas, la actual al final
}

const LIMA_OFFSET_MS = 5 * 3_600_000; // UTC−5 sin DST (misma convención que limaCalendarDayBounds)

/** Lunes (fecha local Lima, YYYY-MM-DD) de la semana que contiene el instante. */
function limaWeekStart(ms: number): string {
  const shifted = new Date(ms - LIMA_OFFSET_MS);
  const sinceMonday = (shifted.getUTCDay() + 6) % 7;
  return new Date(shifted.getTime() - sinceMonday * 86_400_000).toISOString().slice(0, 10);
}

function emptyReprogramCounts(): ReprogramCounts {
  return { total: 0, entregados: 0, entregadosFenix: 0, anulados: 0, enCurso: 0, enCursoViejos: 0, tasa: null };
}

type ReprogramKind = "entregado" | "anulado" | "curso";

function bumpCounts(c: ReprogramCounts, kind: ReprogramKind, viejo: boolean, fenix: boolean): void {
  c.total += 1;
  if (kind === "entregado") {
    c.entregados += 1;
    if (fenix) c.entregadosFenix += 1;
  } else if (kind === "anulado") c.anulados += 1;
  else {
    c.enCurso += 1;
    if (viejo) c.enCursoViejos += 1;
  }
}

function finishCounts(c: ReprogramCounts): void {
  const cerrados = c.entregados + c.anulados;
  c.tasa = cerrados ? c.entregados / cerrados : null;
}

function reprogramKindOf(status: string): ReprogramKind {
  return status === "entregado" ? "entregado" : status === "anulado" ? "anulado" : "curso";
}

export interface ReprogramRangeStats {
  counts: ReprogramCounts;
  porTienda: Record<string, ReprogramCounts>;
  porAsesor: Record<string, ReprogramCounts>;
}

/** Cortes de reprogramación acotados a [startMs, endMs) por fecha de confirmación
 *  (createdAt de la guía hija) — insumo de los chips de rango del popup. Pure. */
export function reprogramRangeStats(
  rows: ReprogramChildRow[],
  startMs: number,
  endMs: number,
  nowMs: number,
): ReprogramRangeStats {
  const staleCut = nowMs - REPROGRAM_STALE_DAYS * 86_400_000;
  const counts = emptyReprogramCounts();
  const porTienda: Record<string, ReprogramCounts> = {};
  const porAsesor: Record<string, ReprogramCounts> = {};
  for (const r of rows) {
    const ms = r.createdAt ? Date.parse(r.createdAt) : NaN;
    if (!Number.isFinite(ms) || ms < startMs || ms >= endMs) continue;
    const kind = reprogramKindOf(r.status);
    const viejo = kind === "curso" && ms < staleCut;
    const fenix = r.fenix !== false;
    bumpCounts(counts, kind, viejo, fenix);
    bumpCounts((porTienda[r.storeId ?? "otras"] ??= emptyReprogramCounts()), kind, viejo, fenix);
    bumpCounts((porAsesor[r.agent ?? REPROGRAM_UNASSIGNED] ??= emptyReprogramCounts()), kind, viejo, fenix);
  }
  finishCounts(counts);
  for (const c of Object.values(porTienda)) finishCounts(c);
  for (const c of Object.values(porAsesor)) finishCounts(c);
  return { counts, porTienda, porAsesor };
}

/** [startMs, endMs) en UTC para un rango de días-calendario Lima (UTC−5, sin
 *  DST), fin exclusivo. `fromYmd`/`toYmd` son "YYYY-MM-DD". */
export function limaRangeBounds(fromYmd: string, toYmd: string): { startMs: number; endMs: number } {
  return {
    startMs: Date.parse(`${fromYmd}T00:00:00-05:00`),
    endMs: Date.parse(`${toYmd}T00:00:00-05:00`) + 86_400_000,
  };
}

/** Fecha de hoy en Lima como "YYYY-MM-DD". */
export function limaTodayKey(now: Date = new Date()): string {
  return dateKeyInTimeZone(now, "America/Lima");
}

/** Agrega las guías hijas en los cortes del strip/popup. Pure (nowMs inyectable). */
export function computeReprogramStats(rows: ReprogramChildRow[], nowMs: number): ReprogramStats {
  const last30Cut = nowMs - 30 * 86_400_000;
  const staleCut = nowMs - REPROGRAM_STALE_DAYS * 86_400_000;
  const historico = emptyReprogramCounts();
  const last30 = emptyReprogramCounts();
  const porTienda: Record<string, ReprogramCounts> = {};
  const porAsesor: Record<string, ReprogramCounts> = {};
  const semanas = new Map<string, ReprogramWeek>();
  for (let i = 7; i >= 0; i--) {
    const start = limaWeekStart(nowMs - i * 7 * 86_400_000);
    semanas.set(start, { start, total: 0, entregados: 0, anulados: 0 });
  }

  for (const r of rows) {
    const ms = r.createdAt ? Date.parse(r.createdAt) : NaN;
    const kind = reprogramKindOf(r.status);
    const viejo = kind === "curso" && Number.isFinite(ms) && ms < staleCut;
    const fenix = r.fenix !== false;
    bumpCounts(historico, kind, viejo, fenix);
    if (Number.isFinite(ms) && ms >= last30Cut) bumpCounts(last30, kind, viejo, fenix);
    bumpCounts((porTienda[r.storeId ?? "otras"] ??= emptyReprogramCounts()), kind, viejo, fenix);
    bumpCounts((porAsesor[r.agent ?? REPROGRAM_UNASSIGNED] ??= emptyReprogramCounts()), kind, viejo, fenix);
    if (Number.isFinite(ms)) {
      const wk = semanas.get(limaWeekStart(ms));
      if (wk) {
        wk.total += 1;
        if (kind === "entregado") wk.entregados += 1;
        else if (kind === "anulado") wk.anulados += 1;
      }
    }
  }

  finishCounts(historico);
  finishCounts(last30);
  for (const c of Object.values(porTienda)) finishCounts(c);
  for (const c of Object.values(porAsesor)) finishCounts(c);
  return { historico, last30, porTienda, porAsesor, asesorNames: {}, semanas: [...semanas.values()] };
}
