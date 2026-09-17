// Liquidaciones 2 — el motor de columnas. Dada una hoja con sus columnas, los
// hechos del pedido (Master), las filas guardadas (manuales) y las hojas que
// se consultan por lookup, produce las filas listas para pintar.
//
// Cuatro tipos de columna y nada más (0168):
//   campo     lee un campo del pedido. Solo lectura.
//   manual    lo que se tecleó; vive en sheet_rows.values.
//   lookup    busca en otra hoja por un valor y devuelve una columna.
//   derivada  una regla con nombre de RULES. Aquí no hay fórmulas libres.
//
// Orden de evaluación: campo → manual → lookup → derivada (por posición). Una
// derivada puede leer lo que ya calcularon las anteriores (zona antes que
// intentos_lima, en la plantilla).

import { generalLabel } from "@/lib/order-status";
import {
  CONSOLIDADO_LABEL,
  districtKey,
  intentosLima,
  kaptaContribution,
  limaDate,
  limaMonthKey,
  resolveConsolidado,
  resolveZona,
} from "./resolver";
import { CATALOGO_ZONAS_KEY } from "./templates";
import type {
  CellValue,
  ComputedRow,
  Contribution,
  OrderFacts,
  SheetColumnRow,
  SheetRowKey,
  StoredRow,
} from "./types";

export interface LookupSheet {
  key: string;
  rows: readonly StoredRow[];
}

export interface EngineInput {
  rowKey: SheetRowKey;
  columns: readonly SheetColumnRow[];
  /** Hechos por pedido, solo para hojas con clave «pedido». */
  facts?: readonly OrderFacts[];
  /** Filas guardadas de ESTA hoja (valores manuales / importados). */
  stored: readonly StoredRow[];
  /** Hojas consultables por lookup y por la regla `zona`, por clave. */
  lookups?: readonly LookupSheet[];
  /** Aportes de otras hojas por nº de pedido (iteraciones 2 y 3). */
  contributions?: ReadonlyMap<string, readonly Contribution[]>;
}

/** Índice de una hoja consultable: columna → valor normalizado → fila. */
class LookupIndex {
  private readonly byColumn = new Map<string, Map<string, StoredRow>>();
  constructor(private readonly rows: readonly StoredRow[]) {}
  find(column: string, value: CellValue): StoredRow | null {
    let index = this.byColumn.get(column);
    if (!index) {
      index = new Map();
      for (const row of this.rows) {
        const k = normalizeKey(row.values[column]);
        if (k && !index.has(k)) index.set(k, row);
      }
      this.byColumn.set(column, index);
    }
    const key = normalizeKey(value);
    return key ? (index.get(key) ?? null) : null;
  }
}

function normalizeKey(value: CellValue | undefined): string {
  if (value === null || value === undefined) return "";
  return districtKey(String(value));
}

function factValue(facts: OrderFacts, field: string): CellValue {
  const v = (facts as unknown as Record<string, unknown>)[field];
  if (v === undefined || v === null) return null;
  if (typeof v === "number" || typeof v === "boolean" || typeof v === "string") return v;
  return String(v);
}

export function computeRows(input: EngineInput): ComputedRow[] {
  const indexes = new Map<string, LookupIndex>();
  for (const sheet of input.lookups ?? []) indexes.set(sheet.key, new LookupIndex(sheet.rows));
  const zonaCatalog = (key: string): string | null => {
    const hit = indexes.get(CATALOGO_ZONAS_KEY)?.find("distrito", key);
    const zona = hit?.values.zona;
    return typeof zona === "string" && zona ? zona : null;
  };

  const byKind = (kind: SheetColumnRow["kind"]) =>
    input.columns.filter((c) => c.kind === kind).sort((a, b) => a.position - b.position);
  const campos = byKind("campo");
  const manuales = byKind("manual");
  const lookups = byKind("lookup");
  const derivadas = byKind("derivada");

  const storedByKey = new Map(input.stored.map((r) => [r.row_key, r]));

  const buildRow = (facts: OrderFacts | null, stored: StoredRow | null, rowKey: string): ComputedRow => {
    const cells: Record<string, CellValue> = {};
    for (const c of campos) cells[c.key] = facts ? factValue(facts, fieldOf(c)) : null;
    for (const c of manuales) cells[c.key] = stored?.values[c.key] ?? null;
    for (const c of lookups) {
      const src = c.source as { sheet?: string; match?: string; by?: string; return?: string };
      const index = src.sheet ? indexes.get(src.sheet) : null;
      const by = src.by ? (cells[src.by] ?? (facts ? factValue(facts, src.by) : null)) : null;
      const hit = index && src.match ? index.find(src.match, by) : null;
      cells[c.key] = hit && src.return ? (hit.values[src.return] ?? null) : null;
    }
    const contributions: Contribution[] = [];
    if (facts) {
      const own = kaptaContribution(facts);
      if (own) contributions.push(own);
      const extra = facts.order_name ? input.contributions?.get(facts.order_name) : undefined;
      if (extra) contributions.push(...extra);
    }
    const cancelled = Boolean(facts?.cancelled_at) || facts?.general_status === "anulado";
    const resolution = facts ? resolveConsolidado(contributions, cancelled) : null;

    for (const c of derivadas) {
      const rule = (c.source as { rule?: string }).rule ?? "";
      cells[c.key] = applyRule(rule, { facts, cells, resolution, zonaCatalog, contributions, stored });
    }
    return { row_key: rowKey, order_id: facts?.order_id ?? stored?.order_id ?? null, stored_id: stored?.id ?? null, cells };
  };

  if (input.rowKey === "pedido") {
    return (input.facts ?? []).map((facts) => {
      const key = facts.order_name ?? facts.order_id;
      return buildRow(facts, storedByKey.get(key) ?? null, key);
    });
  }
  return input.stored.map((stored) => buildRow(null, stored, stored.row_key));
}

function fieldOf(column: SheetColumnRow): string {
  return (column.source as { field?: string }).field ?? column.key;
}

interface RuleContext {
  facts: OrderFacts | null;
  cells: Record<string, CellValue>;
  resolution: ReturnType<typeof resolveConsolidado> | null;
  zonaCatalog: (districtKey: string) => string | null;
  contributions: readonly Contribution[];
  stored: StoredRow | null;
}

/** Reglas con nombre. Añadir una es añadir un caso aquí y una prueba. */
export const RULES = [
  "fecha_lima",
  "mes",
  "anulado",
  "estado_kapta",
  "zona",
  "estatus_consolidado",
  "estatus_por",
  "intentos_lima",
  "diferencia_estatus",
  "aportes",
  "vinculado",
] as const;

function applyRule(rule: string, ctx: RuleContext): CellValue {
  const { facts, cells, resolution } = ctx;
  switch (rule) {
    case "fecha_lima":
      return limaDate(facts?.order_created_at);
    case "mes":
      return limaMonthKey(facts?.order_created_at);
    case "anulado":
      return facts ? Boolean(facts.cancelled_at) || facts.general_status === "anulado" : null;
    case "estado_kapta":
      return facts ? generalLabel(facts.general_status) : null;
    case "zona":
      return facts ? resolveZona(facts, ctx.zonaCatalog) : null;
    case "estatus_consolidado":
      return resolution ? CONSOLIDADO_LABEL[resolution.status] : null;
    case "estatus_por":
      return resolution?.by ? contributorLabel(resolution.by) : null;
    case "intentos_lima": {
      if (!resolution) return null;
      const zona = cells.zona;
      return intentosLima(resolution.status, typeof zona === "string" ? zona : null, resolution.transitCount);
    }
    case "aportes":
      return ctx.contributions.length
        ? ctx.contributions.map((c) => `${contributorLabel(c.sheet_key)}: ${c.mark}`).join(" · ")
        : null;
    case "vinculado":
      return ctx.stored ? Boolean(ctx.stored.order_id) : null;
    case "diferencia_estatus": {
      if (!facts || !resolution) return null;
      const kapta = facts.general_status;
      const mine = resolution.status === "transito" ? "en_proceso" : resolution.status;
      if (mine === kapta) return "Coincide";
      return `Hoja: ${CONSOLIDADO_LABEL[resolution.status]} · Kapta: ${generalLabel(kapta)}`;
    }
    default:
      return null;
  }
}

/** `kapta:aliclik` → «Aliclik (Kapta)»; `reparto_roy` → «reparto_roy» hasta
 *  que la hoja lo pinte con su nombre. */
function contributorLabel(key: string): string {
  if (key.startsWith("kapta:")) {
    const courier = key.slice("kapta:".length);
    return courier === "sin_courier" ? "Kapta" : `${courier} (Kapta)`;
  }
  return key;
}
