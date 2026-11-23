// «Ordenar» en la lista de Repro Lima (owner, 23-11-2026: «dame la opción para
// ordenar por fecha de creación, fecha de última ruta y lo que creas
// conveniente, ascendente y descendente»). El orden de siempre (el del flujo,
// `limaBoardRows`) sigue por defecto; los demás reordenan la misma lista, sin
// cambiar qué pedidos hay ni las cifras. Puras.

import type { LimaRowClass } from "@/lib/repro-lima-blocks";
import type { LimaPendingOrder } from "@/lib/repro-lima-pending";

export type LimaSortKey = "flujo" | "creacion" | "ultima_ruta" | "fecha_agendada" | "en_etapa" | "ultima_llamada" | "intentos";
export type LimaSortDir = "asc" | "desc";
export interface LimaSort { key: LimaSortKey; dir: LimaSortDir }

export const LIMA_SORT_DEFAULT: LimaSort = { key: "flujo", dir: "asc" };

/** Las opciones, en el orden en que se ofrecen. `asc` y `desc` dicen qué va primero. */
export const LIMA_SORT_OPTIONS: readonly { key: LimaSortKey; label: string; short: string; asc: string; desc: string }[] = [
  { key: "flujo", label: "El orden del flujo", short: "Flujo", asc: "Primero lo que pide al equipo", desc: "Primero lo que pide al equipo" },
  { key: "creacion", label: "Fecha de creación", short: "Creación", asc: "Más antiguo primero", desc: "Más reciente primero" },
  { key: "ultima_ruta", label: "Fecha de la última ruta", short: "Última ruta", asc: "Más antigua primero", desc: "Más reciente primero" },
  { key: "fecha_agendada", label: "Fecha agendada", short: "Fecha agendada", asc: "La más temprana primero", desc: "La más tardía primero" },
  { key: "en_etapa", label: "Tiempo en la etapa", short: "En la etapa", asc: "Menos tiempo primero", desc: "Más tiempo primero" },
  { key: "ultima_llamada", label: "Última llamada", short: "Última llamada", asc: "Más antigua primero", desc: "Más reciente primero" },
  { key: "intentos", label: "Intentos de entrega", short: "Intentos", asc: "Menos intentos primero", desc: "Más intentos primero" },
];

const KEYS = new Set<string>(LIMA_SORT_OPTIONS.map((o) => o.key));

/** El orden de la URL (`orden`, `dir`); lo desconocido vuelve al del flujo. */
export function readLimaSort(params: Pick<URLSearchParams, "get">): LimaSort {
  const key = params.get("orden");
  if (!key || !KEYS.has(key) || key === "flujo") return LIMA_SORT_DEFAULT;
  return { key: key as LimaSortKey, dir: params.get("dir") === "desc" ? "desc" : "asc" };
}

/** Escribe el orden en la URL; el del flujo no deja rastro. */
export function writeLimaSort(params: URLSearchParams, sort: LimaSort): void {
  params.delete("orden");
  params.delete("dir");
  if (sort.key === "flujo") return;
  params.set("orden", sort.key);
  params.set("dir", sort.dir);
}

/** Lo que dice la píldora: «Creación · más antiguo primero»; nada con el del flujo. */
export function limaSortLabel(sort: LimaSort): string | null {
  if (sort.key === "flujo") return null;
  const option = LIMA_SORT_OPTIONS.find((o) => o.key === sort.key)!;
  return `${option.short} · ${option[sort.dir].toLocaleLowerCase("es-PE")}`;
}

/** Lo que no tiene ese dato, en una línea para la ayuda de la lista. */
export function limaSortMissingNote(key: LimaSortKey): string | null {
  switch (key) {
    case "ultima_ruta": return "Los que nunca salieron a ruta van al final.";
    case "fecha_agendada": return "Los que no tienen día van al final.";
    case "ultima_llamada": return "Los que no tienen llamada van al final.";
    case "creacion":
    case "en_etapa": return "Los que no traen fecha van al final.";
    default: return null;
  }
}

function ms(value: string | null | undefined): number | null {
  if (!value) return null;
  const t = Date.parse(value.length === 10 ? `${value}T00:00:00-05:00` : value);
  return Number.isFinite(t) ? t : null;
}

/**
 * El valor de un pedido para ese orden (más grande = más reciente, más
 * tiempo o más intentos); null = no lo tiene.
 * - Última ruta: la última salida a reparto; si no, la fecha de despacho.
 * - En la etapa: desde cuándo está en su macroetapa (antes = más tiempo;
 *   se guarda en negativo para que «más» sea «más tiempo»).
 */
export function limaSortValue(row: LimaPendingOrder, cls: LimaRowClass | undefined, key: LimaSortKey): number | null {
  switch (key) {
    case "creacion": return ms(row.createdAt);
    case "ultima_ruta": return ms(row.lastDepartureAt) ?? ms(row.dispatchedAt);
    case "fecha_agendada": return ms(cls?.agendaDay ?? null);
    case "en_etapa": {
      const since = ms(row.macroSince ?? row.createdAt);
      return since == null ? null : -since;
    }
    case "ultima_llamada": return ms(row.management?.lastCallAt ?? null);
    case "intentos": return row.attempts;
    default: return null;
  }
}

/**
 * Reordena la lista ya armada (con su paso, filtros y trabados). Sin el dato,
 * al final, en cualquier dirección. Empates: el orden del flujo. Estable.
 */
export function sortLimaRows(
  rows: readonly LimaPendingOrder[],
  classes: ReadonlyMap<string, LimaRowClass>,
  sort: LimaSort,
): LimaPendingOrder[] {
  if (sort.key === "flujo") return [...rows];
  const sign = sort.dir === "asc" ? 1 : -1;
  return rows
    .map((row, index) => ({ row, index, value: limaSortValue(row, classes.get(row.orderId), sort.key) }))
    .sort((a, b) => {
      if (a.value == null || b.value == null) return a.value == null && b.value == null ? a.index - b.index : a.value == null ? 1 : -1;
      return (a.value - b.value) * sign || a.index - b.index;
    })
    .map((r) => r.row);
}
