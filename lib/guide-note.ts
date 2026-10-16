// Quién creó la guía, dicho en la nota del historial del lead (16-10-2026,
// pedido de Frankz).
//
// La nota «Guía de Aliclik creada · …» va SIN vendedora a propósito: firmarla le
// daría la venta a quien creó la guía y no a la asesora que la cerró (ver
// `computeAdvisorConversionByDay`). Sin firma, la Actividad la enseñaba como
// «Automático (Leads)», y una guía creada a mano por una vendedora parecía
// salida de la nada (#KP134581). El nombre va en el texto, que no atribuye nada.
//
// Pura.

/** «por millonestania5@gmail.com», «automáticamente (envío programado)» o «por el sistema». */
export function guideCreatorPhrase(creator: string | null | undefined, automatic = false): string {
  if (automatic) return "automáticamente (envío programado)";
  const who = creator?.trim();
  return who ? `por ${who}` : "por el sistema";
}
