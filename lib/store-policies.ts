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

// ---------------------------------------------------------------------------
// Importar desde Markdown (08-11-2026)
// ---------------------------------------------------------------------------
//
// El owner tiene sus políticas en un documento y no quiere pegarlas una por una.
// El formato es el del documento «Políticas escritas — Kenku Peru y Aurela»:
//
//   ## Kenku Peru          ← la tienda (un `##` que nombra una tienda que ves)
//   ### Cambios            ← una política: el título
//   Texto…                 ← su texto, con sus párrafos
//   Fuente: la web.        ← opcional: la fuente (la primera línea así)
//
// Un `##` que no es una tienda («Cómo usar este documento») cierra la tienda:
// sus `###` no se importan. Si ningún `##` nombra una tienda, todas las `###`
// van a la tienda elegida en la pantalla. Lo que todavía dice [CONFIRMAR] no se
// importa: el agente lo diría tal cual. La negrita y el código se quitan.

/** Cuántas políticas entran en una importación, como máximo. */
export const POLICY_IMPORT_MAX = 50;
/** El tamaño máximo del archivo o del texto pegado. */
export const POLICY_IMPORT_MAX_CHARS = 100_000;

export interface ImportStore {
  id: string;
  name: string;
}

export interface ImportedPolicy {
  storeId: string;
  storeName: string;
  title: string;
  body: string;
  source: string | null;
}

export interface SkippedPolicy {
  storeName: string | null;
  title: string;
  reason: string;
}

/** Sin tildes, minúsculas, sin espacios repetidos. PURA. */
function comparable(text: string): string {
  return text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
}

/** La tienda que nombra un `##`: igual, o uno contiene al otro; ambigua o ninguna, null. PURA. */
function storeForHeading(heading: string, stores: readonly ImportStore[]): ImportStore | null {
  const h = comparable(heading);
  if (h.length < 3) return null;
  const exact = stores.filter((s) => comparable(s.name) === h);
  if (exact.length === 1) return exact[0]!;
  const partial = stores.filter((s) => {
    const n = comparable(s.name);
    return n.includes(h) || h.includes(n);
  });
  return partial.length === 1 ? partial[0]! : null;
}

/**
 * El texto sin las marcas de Markdown que el agente diría tal cual: negrita,
 * código y los escapes (`\[` → `[`), que un documento exportado pone delante de
 * los corchetes. PURA.
 */
function plainInline(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\\([\\`*_{}\[\]()#+\-.!|>~])/g, "$1");
}

const HEADING_RE = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const SOURCE_RE = /^\s*(?:\*\*|__)?fuente(?:\*\*|__)?\s*:\s*(?:\*\*|__)?\s*(.*)$/i;
const NEEDS_CONFIRMATION_RE = /\[\s*confirmar/i;

/**
 * Las políticas de un Markdown, listas para crear desde `validFrom`, y las que
 * se saltan con su motivo. PURA: la usan la vista previa (navegador) y la
 * acción (servidor), así que las dos dicen lo mismo.
 */
export function parsePoliciesMarkdown(
  markdown: string,
  stores: readonly ImportStore[],
  fallbackStoreId: string | null,
  validFrom: string,
): { policies: (ImportedPolicy & { input: PolicyInput })[]; skipped: SkippedPolicy[] } {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const headings = lines.map((l) => HEADING_RE.exec(l));
  const byStoreHeadings = headings.some((m) => m && m[1]!.length === 2 && storeForHeading(m[2]!, stores));
  const fallback = stores.find((s) => s.id === fallbackStoreId) ?? null;

  type Draft = { store: ImportStore | null; title: string; lines: string[] };
  const drafts: Draft[] = [];
  let store: ImportStore | null = byStoreHeadings ? null : fallback;
  let current: Draft | null = null;
  lines.forEach((line, i) => {
    const m = headings[i];
    if (m) {
      const level = m[1]!.length;
      if (level <= 2) {
        current = null;
        if (level === 2 && byStoreHeadings) store = storeForHeading(m[2]!, stores);
        return;
      }
      if (level === 3) {
        // Un `###` fuera de una tienda (por ejemplo, bajo «Cómo usar») no se importa.
        current = store ? { store, title: plainInline(m[2]!).trim(), lines: [] } : null;
        if (current) drafts.push(current);
        return;
      }
    }
    if (current) (current as Draft).lines.push(line);
  });

  const policies: (ImportedPolicy & { input: PolicyInput })[] = [];
  const skipped: SkippedPolicy[] = [];
  const seen = new Set<string>();
  for (const d of drafts) {
    const storeName = d.store?.name ?? null;
    let source: string | null = null;
    const bodyLines: string[] = [];
    for (const l of d.lines) {
      const s: RegExpExecArray | null = source === null ? SOURCE_RE.exec(l) : null;
      if (s) source = plainInline(s[1]!).trim().replace(/\*\*|__/g, "") || null;
      else bodyLines.push(plainInline(l));
    }
    const raw = { title: d.title, body: bodyLines.join("\n"), validFrom, validUntil: "", source: source ?? "" };
    if ([raw.title, raw.body, raw.source].some((t) => NEEDS_CONFIRMATION_RE.test(t))) {
      skipped.push({ storeName, title: d.title, reason: "Todavía dice [CONFIRMAR]: complétala y vuelve a importarla." });
      continue;
    }
    const parsed = parsePolicyInput(raw);
    if (!parsed.ok) {
      skipped.push({ storeName, title: d.title || "(sin título)", reason: parsed.error });
      continue;
    }
    const key = `${d.store!.id}\u0000${comparable(parsed.value.title)}`;
    if (seen.has(key)) {
      skipped.push({ storeName, title: parsed.value.title, reason: "Está dos veces en el archivo: se importa la primera." });
      continue;
    }
    if (policies.length >= POLICY_IMPORT_MAX) {
      skipped.push({ storeName, title: parsed.value.title, reason: `Pasa del tope de ${POLICY_IMPORT_MAX} por importación.` });
      continue;
    }
    seen.add(key);
    policies.push({
      storeId: d.store!.id,
      storeName: d.store!.name,
      title: parsed.value.title,
      body: parsed.value.body,
      source: parsed.value.source,
      input: parsed.value,
    });
  }
  return { policies, skipped };
}

/** Dos títulos iguales para una persona («Garantía» y «garantia»). PURA. */
export function samePolicyTitle(a: string, b: string): boolean {
  return comparable(a) === comparable(b);
}
