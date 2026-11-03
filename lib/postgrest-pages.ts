// Leer TODAS las filas de una consulta a PostgREST, de a páginas.
//
// PostgREST corta cada respuesta en 1000 filas y NO avisa: no hay error, solo
// menos filas. Un `.in("order_id", lote)` de 200 pedidos trae ~15 eventos por
// pedido, unas 3.000 filas, y se queda con las primeras 1000 en el orden físico
// de la tabla — o sea, pierde justo las más NUEVAS.
//
// Pasó el 03-11-2026 (MOM §7.1): el barrido del Master recalculó un lote de 99
// pedidos con 1.105 eventos, y los dos «Entregado» a mano escritos esa tarde
// eran las filas 1.104 y 1.105. El recálculo no los vio y devolvió los pedidos
// a «Por despachar»; lo mismo les pasó a 14 entregas marcadas a mano ese día.
//
// La consulta tiene que venir ORDENADA por una clave única: paginar sin orden
// puede repetir o saltarse filas entre una página y la siguiente.

/** El tope de PostgREST por respuesta. */
export const POSTGREST_PAGE = 1000;

type PageResult = { data: unknown[] | null; error: { message: string } | null };

/**
 * Pide páginas `[from, to]` hasta que una vuelva incompleta. Si una falla,
 * devuelve el error junto con lo que ya había: quien llama decide si eso le
 * sirve (casi nunca: un recálculo con la mitad de los hechos escribe mal).
 */
export async function readAllPages<T>(
  page: (from: number, to: number) => PromiseLike<PageResult>,
  pageSize: number = POSTGREST_PAGE,
): Promise<{ rows: T[]; error: { message: string } | null }> {
  const rows: T[] = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await page(from, from + pageSize - 1);
    if (error) return { rows, error };
    const got = (data ?? []) as T[];
    rows.push(...got);
    if (got.length < pageSize) return { rows, error: null };
  }
}
