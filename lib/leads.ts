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
  // 🔴 lost
  { code: "cancelado_cliente", label: "Cancelado por cliente", category: "lost", source: "manual", callable: false },
  { code: "cancelado", label: "Cancelado", category: "lost", source: "manual", callable: false },
  { code: "ya_compro_otro_lado", label: "Ya compró en otro lado", category: "lost", source: "manual", callable: false },
  { code: "solo_informacion", label: "Solo quería información", category: "lost", source: "manual", callable: false },
  { code: "sin_stock", label: "Sin stock", category: "lost", source: "manual", callable: false },
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

export interface AutoSignals {
  hasOrder?: boolean;
  handoffReason?: string | null;
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
    const code = HANDOFF_REASON_STATUS[sig.handoffReason] ?? "casi_cierra";
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
