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

/**
 * «por millonestania5@gmail.com», «automáticamente (envío programado)»,
 * «automáticamente (confirmó por Chatby)», «automáticamente (reintento Lima)»
 * o «por el sistema». `automatic` es el origen de la guía automática (`true` es
 * el del día programado, como antes).
 */
export function guideCreatorPhrase(
  creator: string | null | undefined,
  automatic: boolean | "envio_programado" | "confirmado_chatby" | "reintento_lima" = false,
): string {
  if (automatic === "confirmado_chatby") return "automáticamente (confirmó por Chatby)";
  // El reintento de la cadena de Lima que encendió el owner (MOM §9.5, entrega 3).
  if (automatic === "reintento_lima") return "automáticamente (reintento Lima)";
  if (automatic) return "automáticamente (envío programado)";
  const who = creator?.trim();
  return who ? `por ${who}` : "por el sistema";
}
