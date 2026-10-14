// «Todos» de Repro Lima (MOM §9.5, 14-10-2026): los pedidos de Lima sin estado
// final, por macroetapa y subetapa del Master. Aquí viven las reglas PURAS: sin
// IO, para el servidor y la pantalla.
//
// Lo que NO es: un estado nuevo. Agrupa por `order_master.macro_stage` y
// `macro_substage` (§6) con los nombres de lib/order-macro-stage.ts; las pistas
// de cada etapa son texto de pantalla que resume §6.1-6.5, no subetapas.
//
// La cifra de la tarjeta es lo que todavía no se entrega (Por confirmar,
// Preparación, Por despachar y En curso). En Lima lo que no se entrega vuelve a
// «Por reprogramar Lima» y solo la entrega lleva a «Por cerrar», que va aparte,
// con su total, y no suma a la tarjeta.
//
// «Por reprogramar Lima» no sale de la RPC: sale de las filas del propio tablero
// (`reproAging`), así su cifra es la suma de las cuatro listas.

import { masterQueueHref } from "@/lib/master-query";
import {
  MACRO_SUBSTAGES_BY_STAGE,
  ORDER_MACRO_STAGES,
  macroStageLabel,
  macroSubstageLabel,
  type MacroSubstage,
  type OrderMacroStage,
} from "@/lib/order-macro-stage";

// ---------------------------------------------------------------------------
// Vocabulario
// ---------------------------------------------------------------------------

/** Una fila de `order_master_lima_open_counts` (migración 0256), ya tipada. */
export interface LimaOpenCountRow {
  storeId: string;
  stage: OrderMacroStage;
  substage: string | null;
  total: number;
  over7: number;
  over30: number;
}

export interface LimaOpenCounts {
  /** Día de Lima con el que se contaron los días (`p_today`). */
  today: string;
  rows: LimaOpenCountRow[];
}

/** Cuántos hay y cuántos llevan más de 7 y más de 30 días en la etapa. */
export interface StageAging {
  total: number;
  over7: number;
  over30: number;
}

export interface TodosSubstage extends StageAging {
  /** Código de `macro_substage`; null si el pedido no tiene subetapa. */
  substage: string | null;
  label: string;
  /** Su cola en el Master. null en la fila que se abre en la propia pantalla. */
  href: string | null;
  /** Solo «Por reprogramar Lima»: se abre con las cuatro listas, no en el Master. */
  inPage: boolean;
}

export interface TodosStage extends StageAging {
  stage: OrderMacroStage;
  label: string;
  hint: string;
  substages: TodosSubstage[];
}

export interface TodosBreakdown {
  porEntregar: TodosStage[];
  porCerrar: TodosStage | null;
  totals: { porEntregar: number; porCerrar: number; all: number };
}

/** Las etapas que suman a la tarjeta, en el orden del MOM (§6). */
export const TODOS_POR_ENTREGAR: readonly OrderMacroStage[] = ["por_confirmar", "preparacion", "por_despachar", "en_curso"];

/** La etiqueta de los pedidos sin `macro_substage`. No es una subetapa. */
export const TODOS_SIN_SUBETAPA = "Sin subetapa";

/** Una línea por etapa, en palabras de §6.1-6.5. Texto de pantalla, no estados. */
export const TODOS_STAGE_HINT: Record<Exclude<OrderMacroStage, "finalizado">, string> = {
  por_confirmar: "Falta confirmar con el cliente.",
  preparacion: "Falta el rótulo o armar la caja.",
  por_despachar: "La caja está armada y sigue bajo custodia de la empresa.",
  en_curso:
    "Al menos una salida está con el courier o el motorizado, por reprogramar o volviendo; la venta sigue abierta.",
  por_cerrar:
    "El resultado ya se decidió y queda una obligación: la liquidación, la caja que vuelve, el reingreso al stock o validar el cierre.",
};

const REPRO_STAGE: OrderMacroStage = "en_curso";
const REPRO_SUBSTAGE: MacroSubstage = "por_reprogramar_lima";
const POR_CERRAR: OrderMacroStage = "por_cerrar";
const FINALIZADO: OrderMacroStage = "finalizado";
const STAGE_CODES: ReadonlySet<string> = new Set(ORDER_MACRO_STAGES.map((s) => s.code));
const LIMA: readonly string[] = ["lima"];

// ---------------------------------------------------------------------------
// Lectura de la RPC
// ---------------------------------------------------------------------------

/** Un conteo de Postgres: `bigint` llega como número o como texto. */
function countOf(value: unknown): number | null {
  if (typeof value === "number") return Number.isSafeInteger(value) && value >= 0 ? value : null;
  if (typeof value === "bigint") return value >= BigInt(0) ? Number(value) : null;
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    const n = Number(value.trim());
    return Number.isSafeInteger(n) ? n : null;
  }
  return null;
}

/** Filas de la RPC (snake_case, bigint como número o texto) → tipadas. Descarta finalizado, etapas desconocidas y filas sin tienda. */
export function parseLimaOpenCounts(data: unknown): LimaOpenCountRow[] {
  if (!Array.isArray(data)) return [];
  const out: LimaOpenCountRow[] = [];
  for (const raw of data) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const storeId = typeof r.store_id === "string" ? r.store_id.trim() : "";
    if (!storeId) continue;
    const stage = typeof r.macro_stage === "string" ? r.macro_stage : "";
    if (!STAGE_CODES.has(stage) || stage === FINALIZADO) continue;
    const total = countOf(r.total);
    const over7 = countOf(r.over_7);
    const over30 = countOf(r.over_30);
    // Una cifra que no se entiende no se adivina: la fila no cuenta.
    if (total === null || over7 === null || over30 === null) continue;
    const substage = typeof r.macro_substage === "string" && r.macro_substage.trim() ? r.macro_substage.trim() : null;
    out.push({ storeId, stage: stage as OrderMacroStage, substage, total, over7, over30 });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Antigüedad de las filas del tablero
// ---------------------------------------------------------------------------

/** Total y >7 / >30 (estrictos) de las filas del tablero; null cuenta solo en el total. */
export function reproAging(rows: readonly { daysInStage: number | null }[]): StageAging {
  let over7 = 0;
  let over30 = 0;
  for (const row of rows) {
    if (row.daysInStage === null || !Number.isFinite(row.daysInStage)) continue;
    if (row.daysInStage > 7) over7 += 1;
    if (row.daysInStage > 30) over30 += 1;
  }
  return { total: rows.length, over7, over30 };
}

// ---------------------------------------------------------------------------
// El resumen
// ---------------------------------------------------------------------------

function addAging(into: StageAging, from: StageAging): void {
  into.total += from.total;
  into.over7 += from.over7;
  into.over30 += from.over30;
}

/** Orden de las claves sin canon: por código, como texto. */
function byCode(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Los pedidos de Lima sin estado final, por etapa y subetapa del Master.
 * `storeId` null suma todas las tiendas; `repro` es «Por reprogramar Lima»
 * contado sobre las filas del tablero, y reemplaza lo que diga la RPC.
 */
export function limaOpenBreakdown(
  rows: readonly LimaOpenCountRow[],
  opts: { storeId: string | null; repro: StageAging },
): TodosBreakdown {
  const storeIds = opts.storeId ? [opts.storeId] : [];

  // Etapa → subetapa (null es su propia clave) → cifras.
  const byStage = new Map<OrderMacroStage, Map<string | null, StageAging>>();
  for (const row of rows) {
    if (opts.storeId && row.storeId !== opts.storeId) continue;
    if (row.stage === FINALIZADO || !STAGE_CODES.has(row.stage)) continue;
    if (row.stage === REPRO_STAGE && row.substage === REPRO_SUBSTAGE) continue;
    const subs = byStage.get(row.stage) ?? new Map<string | null, StageAging>();
    byStage.set(row.stage, subs);
    const acc = subs.get(row.substage) ?? { total: 0, over7: 0, over30: 0 };
    subs.set(row.substage, acc);
    addAging(acc, row);
  }
  if (opts.repro.total > 0) {
    const subs = byStage.get(REPRO_STAGE) ?? new Map<string | null, StageAging>();
    byStage.set(REPRO_STAGE, subs);
    subs.set(REPRO_SUBSTAGE, { total: opts.repro.total, over7: opts.repro.over7, over30: opts.repro.over30 });
  }

  const buildStage = (stage: OrderMacroStage): TodosStage | null => {
    const subs = byStage.get(stage);
    if (!subs) return null;
    const canon: readonly string[] = MACRO_SUBSTAGES_BY_STAGE[stage];
    const stageOnlyHref = masterQueueHref({ view: stage, coverages: LIMA, storeIds });
    const item = (substage: string | null, aging: StageAging): TodosSubstage => {
      const inPage = stage === REPRO_STAGE && substage === REPRO_SUBSTAGE;
      const canonical = substage !== null && canon.includes(substage);
      return {
        substage,
        label: substage === null ? TODOS_SIN_SUBETAPA : macroSubstageLabel(substage),
        href: inPage
          ? null
          : canonical
            ? masterQueueHref({ view: stage, substage, coverages: LIMA, storeIds })
            : stageOnlyHref,
        inPage,
        total: aging.total,
        over7: aging.over7,
        over30: aging.over30,
      };
    };

    const substages: TodosSubstage[] = [];
    // 1) Las del canon, en su orden: una subetapa nueva aparece sola en su sitio.
    for (const code of canon) {
      const aging = subs.get(code);
      if (aging && aging.total > 0) substages.push(item(code, aging));
    }
    // 2) Las que el MOM ya no lista para esta etapa, por código, con el enlace a la etapa.
    const others = [...subs.keys()].filter((k): k is string => k !== null && !canon.includes(k)).sort(byCode);
    for (const code of others) {
      const aging = subs.get(code)!;
      if (aging.total > 0) substages.push(item(code, aging));
    }
    // 3) Sin subetapa, al final.
    const none = subs.get(null);
    if (none && none.total > 0) substages.push(item(null, none));

    const aging: StageAging = { total: 0, over7: 0, over30: 0 };
    for (const s of substages) addAging(aging, s);
    if (aging.total === 0) return null;
    return {
      stage,
      label: macroStageLabel(stage),
      hint: TODOS_STAGE_HINT[stage as Exclude<OrderMacroStage, "finalizado">],
      substages,
      ...aging,
    };
  };

  const porEntregar = TODOS_POR_ENTREGAR.map(buildStage).filter((s): s is TodosStage => s !== null);
  const porCerrar = buildStage(POR_CERRAR);
  const totalPorEntregar = porEntregar.reduce((sum, s) => sum + s.total, 0);
  const totalPorCerrar = porCerrar?.total ?? 0;
  return {
    porEntregar,
    porCerrar,
    totals: { porEntregar: totalPorEntregar, porCerrar: totalPorCerrar, all: totalPorEntregar + totalPorCerrar },
  };
}
