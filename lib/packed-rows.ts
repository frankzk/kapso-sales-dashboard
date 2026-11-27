// Una lista de filas con los nombres de los campos una sola vez.
//
// POR QUÉ (owner, 27-11-2026: «sigue con la etapa 2»). «Por llamar» manda la cola
// entera al navegador: ~6.700 leads por tienda con 47 campos, ~11 MB en cada carga
// y recarga. Como objetos, cada lead repite el nombre de sus 47 campos
// («last_interaction_at», «kapso_conversation_id»…): medido el 27-11, eso es el
// 38 % de lo que viaja. Como filas, los nombres van una vez arriba y cada lead es
// solo sus valores: 7 MB en vez de 11.
//
// No cambia nada de lo que llega: el navegador rearma los mismos objetos, con los
// mismos campos y valores (también los que valen `undefined`). Solo se empaqueta
// cuando todas las filas tienen los mismos campos; si no, la lista va como antes.
// Sin dependencias del servidor: lo usan la página y el navegador.

export interface PackedRows {
  packed: 1;
  columns: string[];
  rows: unknown[][];
}

export function isPackedRows(value: unknown): value is PackedRows {
  return Boolean(value) && !Array.isArray(value) && (value as PackedRows).packed === 1
    && Array.isArray((value as PackedRows).columns) && Array.isArray((value as PackedRows).rows);
}

/** Empaqueta si todas las filas tienen exactamente los mismos campos; si no, devuelve la lista tal cual. */
export function packRows<T extends object>(rows: readonly T[]): T[] | PackedRows {
  if (!rows.length) return [...rows];
  const columns = Object.keys(rows[0]!);
  const width = columns.length;
  for (const row of rows) {
    const keys = Object.keys(row);
    if (keys.length !== width) return [...rows];
    for (const column of columns) if (!Object.prototype.hasOwnProperty.call(row, column)) return [...rows];
  }
  return {
    packed: 1,
    columns,
    rows: rows.map((row) => columns.map((column) => (row as Record<string, unknown>)[column])),
  };
}

/** Rearma los objetos. Una lista sin empaquetar se devuelve igual. */
export function unpackRows<T>(wire: readonly T[] | PackedRows): T[] {
  if (!isPackedRows(wire)) return wire as T[];
  const { columns, rows } = wire;
  return rows.map((values) => {
    const row: Record<string, unknown> = {};
    for (let i = 0; i < columns.length; i += 1) row[columns[i]!] = values[i];
    return row as T;
  });
}
