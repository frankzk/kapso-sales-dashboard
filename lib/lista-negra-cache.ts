// El índice en memoria de la «Lista negra» por organización (11-11-2026,
// lib/lista-negra-server.ts, `listaNegraMarksAmong`). Módulo hoja, sin
// dependencias, para que quien da de alta, quita o exceptúa un celular —o
// corre una lista nueva— lo olvide sin importar el lector (ciclos).

/** Cuánto vive el índice de una organización en memoria. */
export const LISTA_NEGRA_INDEX_TTL_MS = 2 * 60_000;

export const listaNegraIndexCache = new Map<string, { at: number; index: Promise<unknown> }>();

/** Olvida el índice de una organización (o de todas): la próxima lectura va a la base. */
export function forgetListaNegraIndex(orgId?: string | null): void {
  if (orgId) listaNegraIndexCache.delete(orgId);
  else listaNegraIndexCache.clear();
}
