// La lista de Compras por páginas (MOM §45.2): reglas PURAS y probadas
// (test/compras-lista.test.ts). Sin dependencias del servidor: la usan la
// página, la acción de «Ver más» y el componente del navegador.
//
//   - Las pestañas filtran en la base por su lista de estados (`tabStatuses`),
//     igual que `inImportTab`; el proveedor (`?proveedor=`) y el tipo
//     (`?tipo=`), también en la base.
//   - Orden fijo: la más reciente primero, por `created_at` y, a igual
//     instante, por `id` (los dos descendentes). «Ver más» sigue desde la
//     última fila mostrada (keyset, `keysetFilter`), no por desplazamiento:
//     una compra creada mientras tanto no repite ni salta filas.
//   - Las cifras de las tarjetas, del tipo y de cada proveedor se cuentan en la
//     base (lib/compras-server.ts `loadImportListCounts`), nunca sobre la
//     página cargada.

import {
  IMPORT_STATUSES,
  RECEIVED_STATUSES,
  importAlerts,
  importChecklist,
  isActiveStatus,
  isUuid,
  traceCodes,
  type ImportStatus,
  type ImportTab,
} from "@/lib/compras";
import type { ImportListRow } from "@/lib/compras-server";

/** Filas por página: «Ver más» trae las siguientes. */
export const IMPORT_LIST_PAGE = 100;

/** Los estados de cada pestaña, como `inImportTab`; «Todas», sin filtro (null). */
export function tabStatuses(tab: ImportTab): ImportStatus[] | null {
  const all = IMPORT_STATUSES.map((s) => s.id as ImportStatus);
  if (tab === "todas") return null;
  if (tab === "canceladas") return ["cancelado"];
  if (tab === "recibidas") return [...RECEIVED_STATUSES];
  return all.filter((s) => isActiveStatus(s));
}

/** Dónde quedó la página: la última fila mostrada. */
export interface ImportListCursor {
  createdAt: string;
  id: string;
}

// Un instante de PostgREST: `2026-11-14T15:00:00.123456+00:00` (o con `Z`).
const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}(:?\d{2})?)?$/;

/** El cursor para el navegador: `<created_at>~<id>`. */
export function encodeListCursor(c: ImportListCursor): string {
  return `${c.createdAt}~${c.id}`;
}

/**
 * El cursor que vuelve del navegador, VALIDADO: solo un instante y un UUID
 * (va dentro de un filtro de PostgREST; nada más puede pasar). Null si no es.
 */
export function decodeListCursor(raw: unknown): ImportListCursor | null {
  if (typeof raw !== "string" || raw.length > 80) return null;
  const at = raw.lastIndexOf("~");
  if (at <= 0) return null;
  const createdAt = raw.slice(0, at);
  const id = raw.slice(at + 1);
  if (!TIMESTAMP_RE.test(createdAt) || !isUuid(id)) return null;
  return { createdAt, id };
}

/**
 * Las filas DESPUÉS del cursor en el orden de la lista (created_at desc, id
 * desc), como filtro `or` de PostgREST: más viejas, o del mismo instante con
 * un id menor. El instante va entre comillas (lleva `:` y `+`).
 */
export function keysetFilter(c: ImportListCursor): string {
  return `created_at.lt."${c.createdAt}",and(created_at.eq."${c.createdAt}",id.lt.${c.id})`;
}

/**
 * Una página: se piden `size + 1` filas y, si llegó la de más, hay otra
 * página y el cursor es la última que se muestra.
 */
export function pageOf<T extends { created_at: string; id: string }>(rows: readonly T[], size: number): { rows: T[]; next: ImportListCursor | null } {
  const shown = rows.slice(0, size);
  const last = shown[shown.length - 1];
  return { rows: shown, next: rows.length > size && last ? { createdAt: last.created_at, id: last.id } : null };
}

// ---------------------------------------------------------------------------
// Lo que se calcula de cada fila al dibujarla (servidor y navegador)
// ---------------------------------------------------------------------------

export type ImportAlertFilter = "avisar" | "atrasadas" | "sin_novedades";

export interface EnrichedImportRow {
  row: ImportListRow;
  alerts: ReturnType<typeof importAlerts>;
  /** `tracking` null: una compra local no tiene guía. */
  checklist: ReturnType<typeof importChecklist>;
  /** Los tres códigos de trazabilidad de una importación (MOM §45.15). */
  codes: ReturnType<typeof traceCodes>;
}

export function enrichImportRow(row: ImportListRow, today: string): EnrichedImportRow {
  return {
    row,
    alerts: importAlerts(
      { status: row.imp.status, kind: row.imp.kind, eta: row.imp.eta, reportedAt: row.imp.reported_to_warehouse_at, lastMovementAt: row.lastMovementAt },
      today,
    ),
    checklist: importChecklist(row.docKinds, row.imp.tracking_number, row.imp.kind),
    codes: traceCodes(row.imp),
  };
}

/** ¿Entra en la píldora de excepción? Solo las activas tienen alertas. */
export function matchesAlert(e: EnrichedImportRow, alerta: ImportAlertFilter | null): boolean {
  if (!alerta) return true;
  if (!isActiveStatus(e.row.imp.status)) return false;
  if (alerta === "avisar") return e.alerts.notifyWarehouse;
  if (alerta === "atrasadas") return e.alerts.late;
  return e.alerts.stale;
}
