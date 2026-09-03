// Qué producto vende cada anuncio de Meta.
//
// EL PROBLEMA. El filtro «Producto» de la cola saca el producto del link que el
// cliente trae en su primer mensaje. Sirve para quien llegó desde la ficha —602
// de los 1.902 sin llamar—, pero el 82 % de los que quedan sin producto (1.061
// de 1.294) vienen de un anuncio: tocan el anuncio, se les abre WhatsApp con un
// mensaje genérico y nunca pasan por la ficha. De ellos solo tenemos `ad_id`.
//
// POR QUÉ NO SIRVE EL TITULAR DEL ANUNCIO. Porque no nombra al producto:
//
//   «✨ Brillo Natural para tu Madera»   341 leads  → Beewax
//   «beewax 1107 fk (6).mp4»             114 leads  → Beewax
//   «beewax 1107 fk (5).mp4»              78 leads  → Beewax
//   «❄️ ¿Cansado de la caspa…?»          460 leads  → Shampoo Birú
//   «{{product.name}}»                     3 leads  → (sin renderizar)
//
// Cuatro anuncios de Beewax con tres titulares, dos de ellos nombres de archivo
// de video. Agrupar por titular parte un producto en tres baldes: el mismo
// error que agrupar handles por prefijo.
//
// LA FRONTERA. Una fila de `ad_products` puede traer una SUGERENCIA —qué
// compraron históricamente los leads de ese anuncio— y una DECLARACIÓN —qué
// vende, firmada por alguien—. Solo la segunda etiqueta leads. Mientras nadie
// firme, sus leads siguen en «Sin producto».
//
// Eso no es prudencia decorativa. La evidencia histórica es fuerte en unos
// anuncios (98 %, 93 %, 89 %) y floja en otros: hay uno con 42 %. Etiquetar con
// un 42 % manda a la asesora con el argumentario equivocado más de la mitad de
// las veces, y sin avisarle de que es una conjetura. Una cola que dice «no sé»
// se puede trabajar; una que miente con confianza, no.

export interface AdProductRow {
  ad_id: string;
  store_id: string;
  product_handle?: string | null;
  ad_headline?: string | null;
  suggested_label?: string | null;
  evidence_pct?: number | null;
  evidence_sample?: number | null;
  confirmed_at?: string | null;
  confirmed_by?: string | null;
}

/**
 * ¿Esta fila etiqueta a sus leads?
 *
 * Las dos condiciones son una sola idea: alguien firmó Y dijo qué. La base ya
 * lo exige con un CHECK, pero la pantalla lee filas que pudieron escribirse
 * antes de esa restricción, y un `confirmed_at` sin handle etiquetaría con
 * `undefined` — que es peor que no etiquetar, porque no se ve.
 */
export function adProductDeclarado(row: AdProductRow): boolean {
  return !!row.confirmed_at && (row.product_handle ?? "").trim().length > 0;
}

/**
 * El mapa `ad_id → handle` que usa la cola. Solo entra lo declarado.
 *
 * La clave incluye la tienda: dos tiendas pueden tener anuncios distintos y el
 * mismo `ad_id` no se repite entre ellas, pero mezclarlas en una clave plana
 * sería confiar en eso sin decirlo.
 */
export function mapaAnuncioProducto(rows: readonly AdProductRow[]): Map<string, string> {
  const mapa = new Map<string, string>();
  for (const row of rows) {
    if (!adProductDeclarado(row)) continue;
    mapa.set(claveAnuncio(row.store_id, row.ad_id), row.product_handle!.trim().toLowerCase());
  }
  return mapa;
}

/** La clave del mapa: tienda + anuncio. */
export function claveAnuncio(storeId: string, adId: string): string {
  return `${storeId}::${adId}`;
}

/**
 * Cuánta confianza merece una sugerencia, para pintarla al lado de la firma.
 *
 * No decide nada por sí sola —quien firma decide— pero sí cambia lo que se ve:
 * firmar un 98 % y firmar un 42 % no pueden verse igual, o la pantalla convierte
 * el segundo en el primero por omisión.
 */
export type FuerzaEvidencia = "fuerte" | "dudosa" | "ninguna";

export function fuerzaEvidencia(row: AdProductRow): FuerzaEvidencia {
  const pct = row.evidence_pct ?? 0;
  const muestra = row.evidence_sample ?? 0;
  if (!row.suggested_label || muestra < 5) return "ninguna";
  return pct >= 80 ? "fuerte" : "dudosa";
}

export const FUERZA_LABEL: Record<FuerzaEvidencia, string> = {
  fuerte: "Evidencia fuerte",
  dudosa: "Evidencia floja",
  ninguna: "Sin evidencia",
};

/**
 * El producto dominante entre lo que compraron los leads de un anuncio.
 *
 * Devuelve un TÍTULO, no un handle. Los pedidos guardan «Nails Repairing –
 * Sérum Tea Tree Ginger para Uñas» y el link guarda
 * `nails-repairing-suero-reparador-de-unas`: son el mismo producto escrito
 * distinto, y emparejarlos automáticamente sería la conjetura que esta tabla
 * existe para evitar. El título se MUESTRA; el handle lo elige quien firma.
 *
 * Puro y separado de la consulta para poder afirmar sobre él: es la aritmética
 * que decide qué se le propone a quien firma, y equivocarla es proponer el
 * producto que no es con cara de dato.
 */
export interface CompraDeAnuncio {
  /** El TÍTULO tal como quedó en el pedido. No es un handle y no se convierte. */
  title: string;
}

export function sugerenciaDeAnuncio(
  compras: readonly CompraDeAnuncio[],
): { label: string; pct: number; sample: number } | null {
  if (!compras.length) return null;
  const conteo = new Map<string, number>();
  for (const { title } of compras) {
    const key = title.trim().toLowerCase();
    if (!key) continue;
    conteo.set(key, (conteo.get(key) ?? 0) + 1);
  }
  const total = [...conteo.values()].reduce((a, b) => a + b, 0);
  if (!total) return null;
  // Empate: gana el alfabéticamente menor, para que dos ejecuciones sobre los
  // mismos datos propongan lo mismo. Una sugerencia que baila entre refrescos
  // no se puede revisar.
  let mejor: [string, number] | null = null;
  for (const entry of [...conteo.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
    mejor = entry;
    break;
  }
  return { label: mejor![0], pct: Math.round((100 * mejor![1]) / total), sample: total };
}
