// El buscador del Master y el eco de la URL.
//
// EL FALLO («tipeas y se borra la mitad»). El buscador manda lo escrito a la
// URL tras una pausa, el servidor trae los resultados y la URL vuelve al input
// como `value`. El input copiaba SIEMPRE ese `value` en lo que se estaba
// escribiendo, para que atrás/adelante y «Limpiar búsqueda» se vieran. Pero la
// respuesta tarda: quien escribe «KP12», duda medio segundo y sigue con «34»,
// ve volver «KP12» cuando ya tenía «KP1234», y el input se lo pisa. Cuanto más
// lenta la búsqueda, más letras se comía.
//
// LA REGLA. Lo que vuelve de la URL puede ser dos cosas:
//   * el ECO de algo que este input mandó — incluidos los intermedios, que
//     llegan en orden —: no se toca lo que la persona sigue escribiendo;
//   * un cambio de FUERA (atrás/adelante, «Limpiar búsqueda», un enlace): ése
//     sí manda, porque la URL es la fuente de verdad de lo que se está viendo.
//
// Puro, para poder probarlo sin navegador.

/** Qué hacer con un `value` que acaba de llegar de la URL. */
export function receiveSearchValue(
  pending: readonly string[],
  value: string,
): { adopt: boolean; pending: string[] } {
  const at = pending.indexOf(value);
  // Eco propio: se descartan ese envío y los anteriores, que ya no van a volver.
  if (at >= 0) return { adopt: false, pending: pending.slice(at + 1) };
  // Cambio de fuera: gana la URL y lo pendiente deja de importar.
  return { adopt: true, pending: [] };
}

/**
 * ¿Hay que mandar `next`? No, si es justo lo último que se mandó o, sin nada en
 * camino, lo que la URL ya dice: sería otra navegación idéntica.
 */
export function shouldSendSearch(next: string, value: string, pending: readonly string[]): boolean {
  const last = pending.length ? pending[pending.length - 1]! : value.trim();
  return next !== last;
}
