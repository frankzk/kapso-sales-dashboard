// Merge de mensajes del hilo de WhatsApp. Puro + testeado.
//
// El drawer pinta primero la sesión ACTIVA (barato) y luego funde las sesiones
// viejas, así que el hilo completo vive solo en memoria. El poll de 20s vuelve a
// pedir únicamente la sesión activa: si ese resultado REEMPLAZA el estado, el
// historial ya fundido desaparece solo (el usuario ve 45 mensajes y a los 20s
// quedan 2). Fundiendo en vez de reemplazar, el poll sigue siendo barato y el
// historial no se pierde.

export interface MergeableMessage {
  id: string | null;
  at: string; // ISO
  direction: string;
  text: string;
}

/** Los mensajes sin id (no todos los proveedores lo mandan) igual deben
 *  deduplicarse: instante + sentido + texto identifican al mismo mensaje. */
function keyOf(m: MergeableMessage): string {
  return m.id ?? `${m.at}|${m.direction}|${m.text}`;
}

/**
 * Une lo ya cargado con lo recién traído, sin perder mensajes de sesiones que la
 * respuesta nueva no incluye. Ante el mismo mensaje gana el ENTRANTE — trae el
 * estado de entrega más fresco (enviado → entregado → leído). Ordena por fecha
 * ascendente y, a igual fecha, conserva el orden de llegada (estable).
 */
export function mergeConversationMessages<T extends MergeableMessage>(
  existing: readonly T[],
  incoming: readonly T[],
): T[] {
  const byKey = new Map<string, T>();
  for (const m of existing) byKey.set(keyOf(m), m);
  for (const m of incoming) byKey.set(keyOf(m), m); // el entrante pisa al viejo

  return [...byKey.values()]
    .map((m, index) => ({ m, index }))
    .sort((a, b) => {
      const ta = Date.parse(a.m.at);
      const tb = Date.parse(b.m.at);
      // Una fecha ilegible no debe reordenar el hilo: cae al orden de llegada.
      if (Number.isNaN(ta) || Number.isNaN(tb) || ta === tb) return a.index - b.index;
      return ta - tb;
    })
    .map(({ m }) => m);
}
