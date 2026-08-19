// Geometría de las columnas congeladas del Master.
//
// POR QUÉ VIVE FUERA DEL COMPONENTE. El desplazamiento de cada columna pegada es
// la SUMA de los anchos de las anteriores, así que los anchos tienen que ser
// reales, no sugerencias. En una tabla con `table-layout: auto` —la del Master—
// `width` sobre un `<td>` es exactamente eso: una sugerencia. El navegador
// ensancha la columna si el contenido lo pide, y en cuanto una crece, los
// offsets calculados con los anchos nominales dejan de corresponder y la tabla
// se cizalla.
//
// Pasó con un nombre de cliente de 94 caracteres —el mismo nombre concatenado
// cinco veces por el bot— que empujó fuera de pantalla todo lo que va detrás de
// «Cliente». La celda YA pedía `truncate`, pero `truncate` es
// `white-space: nowrap` + `overflow: hidden`, y sin un ancho que no se pueda
// rebasar no tiene contra qué recortar: la columna simplemente crece.
//
// El comentario del componente ya declaraba el invariante («necesitan ancho fijo
// porque el desplazamiento de cada una es la suma de las anteriores»); lo que
// faltaba era el `maxWidth` que lo hace cierto. Acá es comprobable.

/** Ancho de cada columna congelada, en píxeles. */
export const FROZEN_W = {
  check: 40,
  pedido: 132,
  tienda: 96,
  creado: 88,
  cliente: 190,
} as const;

export type FrozenKey = keyof typeof FROZEN_W;

/** Padding horizontal de una celda congelada (`px-2` = 8px por lado). */
export const FROZEN_PAD = 16;

/**
 * Orden de las columnas congeladas. «Tienda» solo existe en multitienda y corre
 * todo lo que viene después, así que el orden se calcula, no se escribe a mano.
 */
export function frozenOrder(multiStore: boolean): FrozenKey[] {
  return ["check", "pedido", ...(multiStore ? (["tienda"] as const) : []), "creado", "cliente"];
}

/** Desplazamiento izquierdo de cada columna: la suma de las anteriores. */
export function frozenOffsets(multiStore: boolean): Record<FrozenKey, number> {
  const left = {} as Record<FrozenKey, number>;
  let x = 0;
  for (const key of frozenOrder(multiStore)) {
    left[key] = x;
    x += FROZEN_W[key];
  }
  return left;
}

export interface FrozenCellStyle {
  left: number;
  width: number;
  minWidth: number;
  /**
   * LA CLAVE. Sin techo, `width` es una sugerencia que el contenido rebasa y los
   * offsets de las columnas siguientes dejan de cuadrar.
   */
  maxWidth: number;
  zIndex: number;
}

export function frozenCellStyle(
  key: FrozenKey,
  offsets: Record<FrozenKey, number>,
  zIndex: number,
): FrozenCellStyle {
  return {
    left: offsets[key],
    width: FROZEN_W[key],
    minWidth: FROZEN_W[key],
    maxWidth: FROZEN_W[key],
    zIndex,
  };
}

/**
 * Ancho máximo del texto DENTRO de una celda congelada.
 *
 * Va sobre un elemento de bloque propio y no sobre el `<td>` porque `max-width`
 * en una celda de tabla es terreno pantanoso —la especificación dice que no
 * aplica y los navegadores lo respetan de forma desigual—, mientras que sobre un
 * bloque normal es determinista. Con esto `truncate` sí tiene contra qué
 * recortar, y el nombre completo sigue disponible en el `title`.
 */
export function frozenTextWidth(key: FrozenKey, pad = FROZEN_PAD): number {
  return Math.max(0, FROZEN_W[key] - pad);
}
