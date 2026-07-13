// Semáforo de ritmo del heatmap de Productividad. Módulo PURO y client-safe
// (lo importa un componente "use client"; no debe traer nada del server).

/** Mínimo de leads gestionados por hora que se espera de una asesora activa. */
export const RITMO_MIN_HORA = 6;

export type HeatCellStatus = "fuera" | "muerta" | "bajo" | "ok";

/**
 * Estado de cada celda del heatmap respecto del ritmo mínimo, juzgado SOLO
 * dentro de la jornada real (de su primera a su última hora con actividad):
 * lo anterior a empezar, lo posterior a terminar (incluye horas futuras de hoy)
 * y los días sin trabajar quedan "fuera" (gris neutro, no se juzgan). Dentro
 * de la jornada: 0 = "muerta" (hora sin registrar nada en pleno turno),
 * 1..min−1 = "bajo", ≥min = "ok". En rangos multi-día el valor es el promedio
 * por día de esa hora y se compara contra el mismo mínimo. Pure.
 */
export function heatStatuses(heat: number[], min = RITMO_MIN_HORA): HeatCellStatus[] {
  let first = -1;
  let last = -1;
  heat.forEach((v, i) => {
    if (v > 0) {
      if (first < 0) first = i;
      last = i;
    }
  });
  return heat.map((v, i) => {
    if (first < 0 || i < first || i > last) return "fuera";
    if (v === 0) return "muerta";
    return v < min ? "bajo" : "ok";
  });
}

/** Ritmo global de la fila: leads trabajados ÷ horas activas (1 decimal).
 *  null cuando no hay horas inferidas (no se puede juzgar el ritmo). */
export function ritmoPorHora(leads: number, horas: number): number | null {
  if (!horas || horas <= 0) return null;
  return Math.round((leads / horas) * 10) / 10;
}
