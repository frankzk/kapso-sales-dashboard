/**
 * Selección estable del almacén operativo de Aliclik.
 *
 * El catálogo puede repetir un mismo EAN en varios almacenes. Elegir la primera
 * fila hace que el resultado dependa del orden de Postgres y puede terminar
 * cotizando desde un almacén que no despacha los pedidos reales.
 */

export interface WarehouseCatalogRow {
  ean: string;
  warehouse_id: number | null;
}

/** El almacén más frecuente; a igualdad, el id más bajo. */
export function pickTopWarehouse(counts: ReadonlyMap<number, number>): number | undefined {
  let best: number | undefined;
  let bestCount = -1;
  for (const [id, n] of counts) {
    if (n > bestCount || (n === bestCount && (best === undefined || id < best))) {
      best = id;
      bestCount = n;
    }
  }
  return best;
}

/**
 * El almacén que cubre más EAN mapeados de la tienda.
 *
 * Cada combinación almacén/EAN cuenta una sola vez para que duplicados del
 * catálogo no inclinen la selección. Es la misma señal que usa el cron de
 * tarifas: productos que realmente están vinculados a Shopify.
 */
export function pickOperationalWarehouse(
  rows: readonly WarehouseCatalogRow[],
  mappedEans: ReadonlySet<string>,
): number | undefined {
  const covered = new Map<number, Set<string>>();
  for (const row of rows) {
    const id = row.warehouse_id;
    if (id === null || id === undefined || !mappedEans.has(row.ean)) continue;
    const eans = covered.get(id) ?? new Set<string>();
    eans.add(row.ean);
    covered.set(id, eans);
  }
  return pickTopWarehouse(new Map([...covered].map(([id, eans]) => [id, eans.size])));
}
