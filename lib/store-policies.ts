// Las políticas escritas por tienda (MOM §42.6, parte 2; 0315): lo que el
// agente de IA lee en `consultar_politicas` además de lo que Kapta calcula.
// Cambios, devoluciones, garantías, horarios… escritos por la tienda, cada uno
// con su vigencia en días de Lima.
//
// Este archivo es PURO: el estado de una política en un día, la validación de
// lo que llega del formulario y lo que ve el agente. Quién puede escribirlas y
// dónde se guardan, en app/dashboard/automatizaciones/conector/actions.ts.

export const POLICY_TITLE_MAX = 80;
export const POLICY_BODY_MAX = 4000;
export const POLICY_SOURCE_MAX = 200;
/** Cuántas políticas vigentes de una tienda recibe el agente, como máximo. */
export const POLICIES_FOR_AGENT_MAX = 20;

export type PolicyStatus = "vigente" | "programada" | "vencida" | "retirada";

export const POLICY_STATUS_LABEL: Record<PolicyStatus, string> = {
  vigente: "Vigente",
  programada: "Programada",
  vencida: "Vencida",
  retirada: "Retirada",
};

export interface StorePolicyRow {
  id: string;
  store_id: string;
  title: string;
  body: string;
  valid_from: string;
  valid_until: string | null;
  source: string | null;
  version: number;
  updated_at: string;
  retired_at: string | null;
}

/**
 * El estado en un día de Lima (`YYYY-MM-DD`). Retirada gana a todo; si no,
 * programada antes de `valid_from`, vencida después de `valid_until` (ese día
 * todavía vale) y vigente en medio. PURA.
 */
export function policyStatus(p: Pick<StorePolicyRow, "valid_from" | "valid_until" | "retired_at">, today: string): PolicyStatus {
  if (p.retired_at) return "retirada";
  if (p.valid_from > today) return "programada";
  if (p.valid_until && p.valid_until < today) return "vencida";
  return "vigente";
}

/** Las vigentes hoy, por título, hasta el tope que recibe el agente. PURA. */
export function policiesInForce<T extends StorePolicyRow>(rows: readonly T[], today: string): T[] {
  return rows
    .filter((p) => policyStatus(p, today) === "vigente")
    .sort((a, b) => a.title.localeCompare(b.title, "es") || a.valid_from.localeCompare(b.valid_from))
    .slice(0, POLICIES_FOR_AGENT_MAX);
}

/** Una política como la ve el agente: el texto de la tienda, sin quién la escribió. PURA. */
export function agentWrittenPolicy(p: StorePolicyRow) {
  return {
    titulo: p.title,
    texto: p.body,
    vigente_desde: p.valid_from,
    vigente_hasta: p.valid_until,
    fuente: p.source,
    version: p.version,
    actualizada: p.updated_at,
  };
}

export const POLICY_MIGRATION_MISSING = "Falta aplicar la migración 0315 (políticas escritas) en la base.";

/** «No existe» de Postgres (42P01) y de PostgREST (PGRST205), solo para estas tablas. PURA. */
export function isPolicyMigrationMissing(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const e = error as { code?: unknown; message?: unknown; details?: unknown; hint?: unknown };
  if (e.code !== "42P01" && e.code !== "PGRST205") return false;
  return [e.message, e.details, e.hint].some((t) => typeof t === "string" && /\bstore_polic(?:ies|y_versions)\b/.test(t));
}

export interface PolicyInput {
  title: string;
  body: string;
  validFrom: string;
  validUntil: string | null;
  source: string | null;
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function isRealDay(day: string): boolean {
  if (!DAY_RE.test(day)) return false;
  const d = new Date(`${day}T12:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === day;
}

/** Una línea: sin espacios repetidos ni de los bordes. */
function oneLine(v: unknown): string {
  return typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "";
}

/** Un texto con párrafos: conserva los saltos de línea, sin espacios de sobra ni más de una línea en blanco. */
function paragraphs(v: unknown): string {
  if (typeof v !== "string") return "";
  return v
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((l) => l.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Lo que llega del formulario, validado. Los mensajes son los de la pantalla.
 * PURA.
 */
export function parsePolicyInput(raw: {
  title: unknown;
  body: unknown;
  validFrom: unknown;
  validUntil: unknown;
  source: unknown;
}): { ok: true; value: PolicyInput } | { ok: false; error: string } {
  const title = oneLine(raw.title);
  if (title.length < 2 || title.length > POLICY_TITLE_MAX) {
    return { ok: false, error: `Ponle un título de 2 a ${POLICY_TITLE_MAX} caracteres (por ejemplo «Cambios y devoluciones»).` };
  }
  const body = paragraphs(raw.body);
  if (body.length < 2) return { ok: false, error: "Escribe el texto de la política." };
  if (body.length > POLICY_BODY_MAX) return { ok: false, error: `El texto pasa de ${POLICY_BODY_MAX} caracteres: divídelo en dos políticas.` };
  const validFrom = oneLine(raw.validFrom);
  if (!isRealDay(validFrom)) return { ok: false, error: "Indica desde qué día vale." };
  const until = oneLine(raw.validUntil);
  if (until && !isRealDay(until)) return { ok: false, error: "La fecha «hasta» no es válida." };
  if (until && until < validFrom) return { ok: false, error: "La fecha «hasta» no puede ser antes de la fecha «desde»." };
  const source = oneLine(raw.source);
  if (source.length > POLICY_SOURCE_MAX) return { ok: false, error: `La fuente pasa de ${POLICY_SOURCE_MAX} caracteres.` };
  return { ok: true, value: { title, body, validFrom, validUntil: until || null, source: source || null } };
}
