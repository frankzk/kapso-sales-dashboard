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
  sig: { hasOrder?: boolean },
): AutoState | null {
  if (sig.hasOrder) {
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
