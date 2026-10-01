// La normalización de lo que escriben motorizados y couriers, sola y sin
// dependencias: la usa la pantalla del motorizado (`resolveWrittenForStop`) y
// no debe arrastrar al teléfono el catálogo de estados ni sus importaciones de
// servidor (30-09-2026).

/**
 * Normaliza lo que escribe la gente para compararlo: mayúsculas, sin acentos,
 * sin puntuación al final y con un solo espacio entre palabras. «Reprogramado»,
 * «REPROGRAMADO.» y « reprogramado » son el mismo alias.
 */
export function normalizeAlias(raw: string | null | undefined): string {
  return (raw ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.,;:!¡?¿]+$/g, "")
    .trim();
}
