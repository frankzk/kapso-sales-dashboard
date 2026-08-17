// Procedencia del sello de devolución (0118).
//
// `returned_at` abre la cola de recuperación (MOM §11.1), y desde esa cola sale
// un mensaje que le pide un adelanto a la clienta. Antes de pulsar «Enviar» hace
// falta saber una cosa que hasta ahora no estaba en ninguna pantalla: si la
// devolución la reportó el courier o la escribió una persona. Las dos son
// válidas —el paquete sobre la mesa del almacén es tan real como un CSV— pero no
// son igual de firmes, y quien decide tiene derecho a verlo.
//
// Módulo puro y sin imports: lo leen el servidor (al sellar) y el cliente (al
// pintar la cola).

/** Los valores que escribe el sistema. Los de courier se componen con el nombre
 *  del courier porque `report-ingest` sirve a varios (`shalom_report`, …). */
export const RETURNED_SOURCE_MANUAL = "manual";

/** `true` cuando el sello lo puso una persona y no hay constancia del courier
 *  detrás. Es la única distinción que cambia una decisión. */
export function isManualReturn(source: string | null | undefined): boolean {
  return String(source ?? "").trim().toLowerCase() === RETURNED_SOURCE_MANUAL;
}

/**
 * Fecha y procedencia de la devolución al fusionar un reporte con lo que ya
 * había en la guía. Pura.
 *
 * La devolución se sella una sola vez y no se borra: un reporte posterior que ya
 * no la mencione no puede deshacerla, igual que `entregado` no se reabre. La
 * procedencia sigue esa misma suerte —si se conserva el sello, se conserva de
 * quién venía—, porque reescribirla convertiría en «reporte del courier» una
 * devolución que en realidad recibió una persona en el almacén.
 */
export function sealReturn(
  existing: { returned_at: string | null; returned_source: string | null } | null | undefined,
  incoming: { returned: boolean; at: string; source: string },
): { returned_at: string | null; returned_source: string | null } {
  if (existing?.returned_at) {
    return { returned_at: existing.returned_at, returned_source: existing.returned_source };
  }
  if (!incoming.returned) return { returned_at: null, returned_source: null };
  return { returned_at: incoming.at, returned_source: incoming.source };
}

const COURIER_LABEL: Record<string, string> = {
  aliclik: "Aliclik",
  fenix: "Fenix",
  shalom: "Shalom",
  urpi: "Urpi",
  tanders: "Tanders",
  propio: "reparto propio",
};

/**
 * Cómo se nombra la procedencia en pantalla, o `null` cuando no hay nada que
 * decir. `null` NO se traduce a «courier»: las guías selladas antes de 0118 sin
 * rastro se quedan sin etiqueta en vez de recibir una inventada.
 */
export function returnedSourceLabel(source: string | null | undefined): string | null {
  const s = String(source ?? "").trim().toLowerCase();
  if (!s) return null;
  if (s === RETURNED_SOURCE_MANUAL) return "sellada a mano";
  const m = /^(.+)_(api|report)$/.exec(s);
  if (!m) return s;
  const courier = COURIER_LABEL[m[1]!] ?? m[1]!;
  return m[2] === "api" ? `API de ${courier}` : `reporte de ${courier}`;
}
