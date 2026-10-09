// Los estados de una guía Swayp, con el nombre que les da su panel (vistos el
// 29-09-2026). Sin dependencias: lo usan el cliente de la API (lib/swayp.ts) y
// el cajón de Envíos, que no puede cargar ese cliente.

/**
 * Los estados de Swayp con el nombre que Swayp les da.
 *
 * CORREGIDO CON DATOS REALES (29-09-2026). El catálogo original llamaba
 * «Revisión» al 8, «Cancelación» al 9 y «Devolución confirmada» al 12. El
 * historial de las 147 guías vivas leído del tracking público de Swayp dice
 * otra cosa, sin excepción: 8 es «Devolucion» («marcado para devolución,
 * pendiente por entregar al origen»), 9 es «Devolucion Confirmada» y 12
 * «Devolucion Confirmada Con Cobro». El 2 y el 11 no aparecieron en ninguna:
 * se conservan con el nombre de la documentación. El 5 aparece también como
 * «Solucionado»: es el Reparto al que vuelve una novedad resuelta.
 */
export const SWAYP_STATES: Record<number, string> = {
  1: "Generada",
  2: "Preparada",
  3: "Por recolectar",
  4: "Asignada",
  5: "Reparto",
  6: "Novedad",
  7: "Entregada",
  8: "Devolución",
  9: "Devolución confirmada",
  10: "Cancelada",
  11: "Indemnizada",
  12: "Devolución confirmada con cobro",
};
