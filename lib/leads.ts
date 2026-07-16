// Canonical lead state model + derivation helpers. Pure + unit-tested.
//
// Four categories: won (closed-won) · hot (immediate attention) · open (work it)
// · lost (closed-lost). Each status is set automatically (from bot/CRM behavior)
// or manually (by the agent during a call).

export type LeadCategory = "won" | "hot" | "open" | "lost";
export type StatusSource = "auto" | "manual";

export interface LeadStatusDef {
  code: string;
  label: string;
  category: LeadCategory;
  source: StatusSource;
  callable: boolean; // appears in the "to call" queue
}

export const LEAD_STATUSES: LeadStatusDef[] = [
  // 🟢 won
  { code: "pedido_generado", label: "Pedido generado", category: "won", source: "auto", callable: false },
  { code: "ya_tiene_pedido", label: "Ya tiene pedido", category: "won", source: "auto", callable: false },
  // 🔥 hot
  { code: "yape_por_verificar", label: "Yape/Shalom por verificar", category: "hot", source: "auto", callable: true },
  { code: "casi_cierra", label: "Casi cierra (dio datos)", category: "hot", source: "auto", callable: true },
  // 🟡 open
  { code: "nuevo", label: "Nuevo / pendiente", category: "open", source: "auto", callable: true },
  { code: "contactado_dejo_wsp", label: "Contactado, dejó WhatsApp", category: "open", source: "manual", callable: true },
  { code: "no_responde", label: "No responde (NR)", category: "open", source: "manual", callable: true },
  { code: "cuelga", label: "Cuelga", category: "open", source: "manual", callable: true },
  { code: "buzon", label: "Buzón de voz", category: "open", source: "manual", callable: true },
  { code: "otros_productos", label: "Consultó otros productos", category: "open", source: "manual", callable: true },
  { code: "sin_stock", label: "Sin stock", category: "open", source: "manual", callable: true },
  { code: "repetido", label: "Repetido", category: "open", source: "manual", callable: true },
  { code: "volver_a_llamar", label: "Volver a llamar", category: "open", source: "manual", callable: true },
  // 🔴 lost
  { code: "cancelado_cliente", label: "Cancelado por cliente", category: "lost", source: "manual", callable: false },
  { code: "cancelado", label: "Cancelado", category: "lost", source: "manual", callable: false },
  { code: "ya_compro_otro_lado", label: "Ya compró en otro lado", category: "lost", source: "manual", callable: false },
  { code: "solo_informacion", label: "Solo quería información", category: "lost", source: "manual", callable: false },
  { code: "solo_miraba", label: "Solo miraba", category: "lost", source: "manual", callable: false },
  { code: "fuera_de_ciudad", label: "Fuera de la ciudad", category: "lost", source: "manual", callable: false },
  { code: "lista_negra", label: "Lista negra", category: "lost", source: "manual", callable: false },
  { code: "nr_no_existe", label: "Número no existe / incorrecto", category: "lost", source: "manual", callable: false },
  { code: "nr_extranjero", label: "Número extranjero", category: "lost", source: "manual", callable: false },
  { code: "duplicado", label: "Duplicado", category: "lost", source: "auto", callable: false },
];

const BY_CODE = new Map(LEAD_STATUSES.map((s) => [s.code, s]));

export function statusDef(code: string): LeadStatusDef | undefined {
  return BY_CODE.get(code);
}
export function categoryOf(code: string): LeadCategory {
  return BY_CODE.get(code)?.category ?? "open";
}
export function labelOf(code: string): string {
  return BY_CODE.get(code)?.label ?? code;
}
export function isCallable(code: string): boolean {
  return BY_CODE.get(code)?.callable ?? false;
}
export function isValidStatus(code: string): boolean {
  return BY_CODE.has(code);
}

/**
 * Guards a manual call disposition from silently downgrading a lead away from
 * `won` while its order is still ACTIVE (not cancelled) — that's a completed
 * sale, not a loss. Mirrors `shouldReopenWonCart`'s active-order check
 * (lib/leads-ingest.ts) from the opposite direction: there, an active order lets
 * a fresh cart reclaim a stale win; here, an active order stops a later manual
 * call from erasing a real one (e.g. an order placed directly in Shopify, then a
 * different advisor re-calls the same lead before the queue catches up).
 * Safe to apply when: the lead isn't currently won, the new status is ALSO won,
 * or the order backing the win is no longer active (a genuine loss/cancellation).
 */
export function canDispositionLead(opts: {
  currentCategory: string | undefined;
  newStatus: string;
  hasActiveOrder: boolean;
}): boolean {
  if (opts.currentCategory !== "won") return true;
  if (categoryOf(opts.newStatus) === "won") return true;
  return !opts.hasActiveOrder;
}

/** Statuses an agent may set by hand (the call-disposition dropdown). */
export const MANUAL_STATUSES: LeadStatusDef[] = LEAD_STATUSES.filter((s) => s.source === "manual");

/** Kapso handoff reasons → our hot status. */
export const HANDOFF_REASON_STATUS: Record<string, string> = {
  validacion_logistica: "yape_por_verificar",
  validacion_pago: "yape_por_verificar",
  pago: "yape_por_verificar",
};

// Any handoff whose reason OR context is payment/logistics-flavoured routes to
// Yape/Shalom — so the bot's handoff lands in the right tab without having to
// match one of the exact strings above.
const YAPE_REASON_RE = /pago|yape|plin|voucher|comprobante|adelanto|dep[oó]sito|log[ií]stic/i;

/** Map a Kapso handoff reason (+optional context) → our auto status. Exact
 *  reason wins; otherwise any payment-flavoured reason/context → Yape/Shalom. */
export function handoffStatus(reason: string, context?: string | null): string {
  if (HANDOFF_REASON_STATUS[reason]) return HANDOFF_REASON_STATUS[reason];
  if (YAPE_REASON_RE.test(reason) || (context != null && YAPE_REASON_RE.test(context))) {
    return "yape_por_verificar";
  }
  return "casi_cierra";
}

/** Las dos mitades del bucket "Yape/Shalom": 💰 pago (verificar Yape/voucher) o
 *  📦 agencia (coordinar un envío por agencia — Shalom/Olva). */
export type YapeKind = "pago" | "agencia";

/** Señales de que el handoff Yape/Shalom es de AGENCIA (coordinar el envío) y no
 *  de pago. Solo se usa cuando el motivo exacto no lo decide. */
const AGENCY_HANDOFF_RE = /log[ií]stic|agencia|shalom|olva|sucursal|recojo/i;

/** Para un lead en la pestaña Yape/Shalom (`yape_por_verificar`), ¿qué mitad es?
 *  El motivo exacto del handoff manda (`validacion_logistica` → agencia;
 *  `validacion_pago`/`pago` → pago); si no, se busca una señal de agencia en el
 *  motivo/contexto. Por defecto **pago** — cubre el voucher detectado por visión,
 *  que deja el estado sin motivo de handoff. Puro (testeable). */
export function yapeKind(reason: string | null | undefined, context?: string | null): YapeKind {
  const r = (reason ?? "").trim().toLowerCase();
  if (r === "validacion_logistica") return "agencia";
  if (r === "validacion_pago" || r === "pago") return "pago";
  if (AGENCY_HANDOFF_RE.test(reason ?? "") || AGENCY_HANDOFF_RE.test(context ?? "")) return "agencia";
  return "pago";
}

export interface AutoSignals {
  hasOrder?: boolean;
  handoffReason?: string | null;
  handoffContext?: string | null;
  isDuplicate?: boolean;
}

export interface AutoState {
  status: string;
  category: LeadCategory;
  needsAttention: boolean;
}

/**
 * Derive the automatic state from CRM/bot signals. Precedence:
 *   order exists → won; duplicate → lost; handoff → hot; else → open(new).
 */
export function deriveAutoState(sig: AutoSignals): AutoState {
  if (sig.hasOrder) {
    return { status: "pedido_generado", category: "won", needsAttention: false };
  }
  if (sig.isDuplicate) {
    return { status: "duplicado", category: "lost", needsAttention: false };
  }
  if (sig.handoffReason) {
    const code = handoffStatus(sig.handoffReason, sig.handoffContext);
    return { status: code, category: categoryOf(code), needsAttention: true };
  }
  return { status: "nuevo", category: "open", needsAttention: false };
}

export interface LeadStateSnapshot {
  status: string;
  handoff_reason?: string | null;
}

/**
 * Decide the lead's state during a sync pass. Rules:
 *   - an order exists → won (sticky).
 *   - the agent already set a manual status → leave it (return null = no change).
 *   - otherwise re-derive from signals (handoff → hot, else new).
 */
export function nextLeadState(
  existing: LeadStateSnapshot | null,
  sig: { hasOrder?: boolean; hasRecentIntent?: boolean },
): AutoState | null {
  // A prior order wins the lead — UNLESS there's a newer buying signal (a fresh
  // open cart created after that order): a repeat customer working a NEW purchase.
  // Then we fall through and re-derive an actionable state instead of staying won.
  if (sig.hasOrder && !sig.hasRecentIntent) {
    return { status: "pedido_generado", category: "won", needsAttention: false };
  }
  if (existing) {
    const def = statusDef(existing.status);
    if (def?.source === "manual") return null; // the agent owns this lead now
    if (existing.handoff_reason) {
      return deriveAutoState({ handoffReason: existing.handoff_reason });
    }
  }
  return deriveAutoState({});
}

// ---------------------------------------------------------------------------
// Sub-segmentation of the "Por llamar" queue by buyer intent (informational).
// A lead lands in exactly one bucket — the highest-priority match. Priority
// order == call order: pago → carrito → distrito → converso → frio.
// ---------------------------------------------------------------------------

export type LeadSegment = "carrito" | "distrito" | "converso" | "frio";

export const LEAD_SEGMENTS: { key: LeadSegment; label: string }[] = [
  { key: "carrito", label: "🛒 Con carrito" },
  { key: "distrito", label: "📍 Dio distrito" },
  { key: "converso", label: "💬 Conversó" },
  { key: "frio", label: "❄️ Frío" },
];

export interface LeadSegmentSignals {
  status: string;
  cart_item_count?: number | null;
  district?: string | null;
  inbound_count?: number | null;
  draft_order_gid?: string | null;
}

/** Assign a "Por llamar" lead to one sub-segment (highest-priority match).
 *  (Leads en Yape ya tienen su propia pestaña superior, no un sub-bucket.) */
export function leadSegment(lead: LeadSegmentSignals): LeadSegment {
  // Cart from a real Shopify draft (draft_order_gid) OR parsed from the chat.
  if ((lead.cart_item_count ?? 0) > 0 || (lead.draft_order_gid ?? "").length > 0) return "carrito";
  if ((lead.district ?? "").trim()) return "distrito"; // dio distrito de envío
  if ((lead.inbound_count ?? 0) >= 2) return "converso"; // conversó (≥2 mensajes)
  return "frio"; // solo saludó / no respondió
}

export function isLeadSegment(v: string | undefined | null): v is LeadSegment {
  return !!v && LEAD_SEGMENTS.some((s) => s.key === v);
}

/** Tally a list of "Por llamar" leads into the sub-segment buckets. */
export function countLeadSegments(leads: LeadSegmentSignals[]): Record<LeadSegment, number> {
  const out: Record<LeadSegment, number> = {
    carrito: 0,
    distrito: 0,
    converso: 0,
    frio: 0,
  };
  for (const l of leads) out[leadSegment(l)] += 1;
  return out;
}

// ---------------------------------------------------------------------------
// Queue state: the PRIMARY axis over the "Por llamar" queue — has anyone called
// this lead yet? `sin_llamar` = status `nuevo` (nobody touched it; the priority);
// `seguimiento` = already gestioned but still pending (no responde, buzón, …).
// It's a SEPARATE axis from the buyer-intent segment (frío…carrito); the two
// combine — the segment row is scoped WITHIN the active state. Default `sin_llamar`.
// ---------------------------------------------------------------------------

export type QueueState = "sin_llamar" | "seguimiento";

export const QUEUE_STATES: { key: QueueState; label: string }[] = [
  { key: "sin_llamar", label: "Sin llamar" },
  { key: "seguimiento", label: "En seguimiento" },
];

export function isQueueState(v: string | undefined | null): v is QueueState {
  return v === "sin_llamar" || v === "seguimiento";
}

/** Split the queue by whether anyone has called the lead yet (status `nuevo`). */
export function matchesQueueState(lead: { status: string }, state: QueueState): boolean {
  return state === "sin_llamar" ? lead.status === "nuevo" : lead.status !== "nuevo";
}

/** State counts for a loaded queue batch: { sin_llamar, seguimiento }. */
export function countQueueStates(leads: { status: string }[]): Record<QueueState, number> {
  let sinLlamar = 0;
  for (const l of leads) if (l.status === "nuevo") sinLlamar += 1;
  return { sin_llamar: sinLlamar, seguimiento: leads.length - sinLlamar };
}

// ---------------------------------------------------------------------------
// Last-interaction date drill-down. The “Sin llamar · últimos 7 días” chart and
// the date input in Filters share this exact model so their results cannot
// diverge. `older.before` is exclusive: every local date before it belongs to
// the chart's aggregated “+7d” bucket.
// ---------------------------------------------------------------------------

export type LeadInteractionDateFilter =
  | { kind: "day"; date: string }
  | { kind: "older"; before: string };

export function isDateKey(value: string | null | undefined): value is string {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function leadInteractionDateFilterFromParams(
  date: string | null | undefined,
  before: string | null | undefined,
): LeadInteractionDateFilter | null {
  if (isDateKey(date)) return { kind: "day", date };
  if (isDateKey(before)) return { kind: "older", before };
  return null;
}

/** Calendar key of the signal used by the chart: last interaction, falling back
 * to first seen when the conversation has no interaction timestamp. */
export function leadInteractionDateKey(
  lead: { last_interaction_at?: string | null; first_seen_at?: string | null },
  timeZone: string,
): string | null {
  const iso = lead.last_interaction_at ?? lead.first_seen_at;
  if (!iso) return null;
  const atMs = Date.parse(iso);
  if (!Number.isFinite(atMs)) return null;
  return localParts(atMs, timeZone).date;
}

export function matchesLeadInteractionDate(
  lead: { last_interaction_at?: string | null; first_seen_at?: string | null },
  filter: LeadInteractionDateFilter | null,
  timeZone: string,
): boolean {
  if (!filter) return true;
  const date = leadInteractionDateKey(lead, timeZone);
  if (!date) return false;
  return filter.kind === "day" ? date === filter.date : date < filter.before;
}

// ---------------------------------------------------------------------------
// Gestión: a second axis over the "Por llamar" queue — the advisor's call
// state (the disposition set in "registrar llamada"). Orthogonal to leadSegment
// (buyer intent); the two combine. Lost dispositions live in the "Perdidos"
// tab so they're not buckets here; casi_cierra (hot) maps to none.
// ---------------------------------------------------------------------------

export type LeadGestion = "sin_llamar" | "nr" | "buzon_cuelga" | "contactados" | "sin_stock";

export const LEAD_GESTIONES: { key: LeadGestion; label: string }[] = [
  { key: "sin_llamar", label: "🆕 Sin llamar" },
  { key: "nr", label: "📵 No responde" },
  { key: "buzon_cuelga", label: "📞 Buzón/Cuelga" },
  { key: "contactados", label: "💬 Contactados" },
  { key: "sin_stock", label: "📦 Sin stock" },
];

const GESTION_BY_STATUS: Record<string, LeadGestion> = {
  nuevo: "sin_llamar",
  no_responde: "nr",
  buzon: "buzon_cuelga",
  cuelga: "buzon_cuelga",
  contactado_dejo_wsp: "contactados",
  otros_productos: "contactados",
  sin_stock: "sin_stock",
};

/** The advisor-gestión bucket for a lead's status, or null (e.g. casi_cierra). */
export function gestionOf(status: string): LeadGestion | null {
  return GESTION_BY_STATUS[status] ?? null;
}

export function isLeadGestion(v: string | undefined | null): v is LeadGestion {
  return !!v && LEAD_GESTIONES.some((g) => g.key === v);
}

// ---------------------------------------------------------------------------
// Seguimiento automático de re-contacto. "Casi cierra (dio datos)" y "Volver a
// llamar" son leads que SÍ o SÍ hay que volver a tocar; si la asesora no pone
// fecha, se agenda solo: al final del MISMO día (18:00 local) cuando la llamada
// fue antes de las 16:00, o mañana a las 10:00 si ya es tarde. Con la fecha
// puesta, el sistema hace el resto: el lead aparece en la vista Seguimientos al
// vencer, sube con needs_attention (cron) y queda protegido del auto-archivado
// de 7 días. Una fecha explícita del formulario siempre gana.
// ---------------------------------------------------------------------------

export const AUTO_FOLLOWUP_STATUSES = ["casi_cierra", "volver_a_llamar"] as const;
export const AUTO_FOLLOWUP_CUTOFF_HOUR = 16; // antes de las 16 → hoy; después → mañana
export const AUTO_FOLLOWUP_EOD_HOUR = 18; // "al final del día"
export const AUTO_FOLLOWUP_MORNING_HOUR = 10; // "mañana a primera hora"

/** Local calendar parts of an instant in `tz` via Intl (self-contained so this
 *  client-safe module doesn't pull other libs). */
function localParts(atMs: number, tz: string): { date: string; hour: number } {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
  });
  const p: Record<string, string> = {};
  for (const part of dtf.formatToParts(new Date(atMs))) p[part.type] = part.value;
  const hour = p.hour === "24" ? 0 : Number(p.hour);
  return { date: `${p.year}-${p.month}-${p.day}`, hour };
}

/** `date` (YYYY-MM-DD) + `hour` LOCAL en `tz` → instante UTC ISO. */
function localToUtcIso(date: string, hour: number, tz: string): string {
  // Offset de la zona alrededor de ese instante (exacto para zonas de offset
  // fijo como Lima; el error DST en el borde es irrelevante para una agenda).
  const guess = Date.parse(`${date}T${String(hour).padStart(2, "0")}:00:00Z`);
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const p: Record<string, string> = {};
  for (const part of dtf.formatToParts(new Date(guess))) p[part.type] = part.value;
  const asUtc = Date.parse(
    `${p.year}-${p.month}-${p.day}T${p.hour === "24" ? "00" : p.hour}:${p.minute}:${p.second}Z`,
  );
  return new Date(guess - (asUtc - guess)).toISOString();
}

/** Seguimiento por defecto para casi_cierra / volver_a_llamar sin fecha. Pure. */
export function defaultFollowupAt(nowIso: string, tz: string): string {
  const nowMs = Date.parse(nowIso);
  const now = localParts(nowMs, tz);
  if (now.hour < AUTO_FOLLOWUP_CUTOFF_HOUR) return localToUtcIso(now.date, AUTO_FOLLOWUP_EOD_HOUR, tz);
  const tomorrow = localParts(nowMs + 86_400_000, tz);
  return localToUtcIso(tomorrow.date, AUTO_FOLLOWUP_MORNING_HOUR, tz);
}

// ---------------------------------------------------------------------------
// 24h WhatsApp session window. The window opens on each inbound (customer)
// message and lasts 24h; outside it we can't send free text. We classify by how
// much time is LEFT (from the last inbound), so the queue can prioritise leads
// about to close. Pure: `nowMs` is passed in.
// ---------------------------------------------------------------------------
export type LeadWindow = "fresca" | "por_vencer" | "critica" | "cerrada";

export const SESSION_WINDOW_MS = 24 * 60 * 60 * 1000;
const POR_VENCER_MS = 6 * 60 * 60 * 1000; // ≤6h left
const CRITICA_MS = 2 * 60 * 60 * 1000; // ≤2h left

/** State + remaining ms of the 24h window, from the last inbound time. */
export function leadWindowInfo(
  inboundAt: string | null | undefined,
  nowMs: number,
): { state: LeadWindow | null; msLeft: number | null } {
  if (!inboundAt) return { state: null, msLeft: null };
  const t = new Date(inboundAt).getTime();
  if (!Number.isFinite(t)) return { state: null, msLeft: null };
  const left = SESSION_WINDOW_MS - (nowMs - t);
  if (left <= 0) return { state: "cerrada", msLeft: 0 };
  if (left <= CRITICA_MS) return { state: "critica", msLeft: left };
  if (left <= POR_VENCER_MS) return { state: "por_vencer", msLeft: left };
  return { state: "fresca", msLeft: left };
}

export function isLeadWindowFilter(
  v: string | undefined | null,
): v is "fresca" | "por_vencer" | "cerrada" {
  return v === "fresca" || v === "por_vencer" || v === "cerrada";
}

/** Tally leads into actionable window buckets (por_vencer groups ≤6h incl. crítica). */
export function countLeadWindows(
  leads: { last_inbound_at?: string | null; last_interaction_at?: string | null }[],
  nowMs: number,
): { a_tiempo: number; por_vencer: number; cerrada: number } {
  let a_tiempo = 0;
  let por_vencer = 0;
  let cerrada = 0;
  for (const l of leads) {
    const { state } = leadWindowInfo(l.last_inbound_at ?? l.last_interaction_at, nowMs);
    if (state === "fresca") a_tiempo += 1;
    else if (state === "por_vencer" || state === "critica") por_vencer += 1;
    else if (state === "cerrada") cerrada += 1;
  }
  return { a_tiempo, por_vencer, cerrada };
}

/** Tally "Por llamar" leads into gestión buckets (unmapped statuses ignored). */
export function countGestiones(leads: { status: string }[]): Record<LeadGestion, number> {
  const out: Record<LeadGestion, number> = { sin_llamar: 0, nr: 0, buzon_cuelga: 0, contactados: 0, sin_stock: 0 };
  for (const l of leads) {
    const g = gestionOf(l.status);
    if (g) out[g] += 1;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Claim / lock — "Tomar lead", one at a time, auto-released after a TTL.
// ---------------------------------------------------------------------------

export const CLAIM_TTL_MINUTES = 10;

/** A claim is active while it's fresh (within the TTL). */
export function isClaimActive(
  claimedAt: string | Date | null | undefined,
  now: Date = new Date(),
): boolean {
  if (!claimedAt) return false;
  const t = typeof claimedAt === "string" ? new Date(claimedAt) : claimedAt;
  return now.getTime() - t.getTime() < CLAIM_TTL_MINUTES * 60_000;
}

// ---------------------------------------------------------------------------
// Excel → canonical (best-effort, for reference / optional future import)
// ---------------------------------------------------------------------------

const EXCEL_STATUS_MAP: Record<string, string> = {
  "ya tiene pedido": "ya_tiene_pedido",
  "pedido generado": "pedido_generado",
  pendiente: "nuevo",
  "contactado dejo wsp": "contactado_dejo_wsp",
  nr: "no_responde",
  "nr no existe": "nr_no_existe",
  "nr incorrecto": "nr_no_existe",
  "sin nr tlf": "nr_no_existe",
  "nr- extranjero": "nr_extranjero",
  "nr-extranjero": "nr_extranjero",
  cuelga: "cuelga",
  "buzon-ce-sin wsp": "buzon",
  "soloqueria informacion": "solo_informacion",
  "solo miraba": "solo_miraba",
  "fuera de la ciudad": "fuera_de_ciudad",
  "fuera de la cuidad": "fuera_de_ciudad",
  "volver a llamar": "volver_a_llamar",
  repetido: "repetido",
  "cns x otro productos": "otros_productos",
  "sin stock": "sin_stock",
  "lista negra": "lista_negra",
  duplicado: "duplicado",
  "ya compro en otro lado": "ya_compro_otro_lado",
  "cancelado por cliente": "cancelado_cliente",
  cancelado: "cancelado",
};

/** Map a raw Excel "Comentario" value to a canonical status (best-effort). */
export function mapExcelStatus(raw: string): string {
  const key = raw.trim().toLowerCase();
  if (key.startsWith("pedido generado")) return "pedido_generado"; // "... Daphne/TM/..."
  return EXCEL_STATUS_MAP[key] ?? "nuevo";
}
