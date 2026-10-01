// El borrador del reporte de una parada, guardado en el teléfono (30-09-2026).
//
// Reportar una entrega obliga a salir de Chrome: abrir WhatsApp para pedir la
// captura del Yape, guardarla, volver por la galería, llamar al cliente. En un
// celular con poca memoria Android puede cerrar Chrome en cualquiera de esos
// saltos, y al volver la página se recarga en la misma parada con todo lo
// marcado perdido: el método, el monto y la foto ya subida. El borrador lo
// devuelve. No es la cola sin señal (otro PR): no envía nada, solo recuerda.
//
// Vive en `localStorage` del propio teléfono, una entrada por parada, y se
// borra al guardar el reporte. Si el reporte ya se guardó después del
// borrador, o el borrador es de hace más de un día de trabajo, se ignora.

/** Lo que el motorizado ya marcó en la ficha. */
export interface StopDraftFields {
  status: "entregado" | "no_entregado";
  method: string | null;
  amount: string;
  reason: string;
  note: string;
  photoPath: string | null;
  voucherPath: string | null;
  written: string;
  writtenPayment: string;
  reasonCode: string;
  reasonNote: string;
}

export interface StopDraft extends StopDraftFields {
  v: 1;
  /** Cuándo se guardó (ms desde epoch). */
  at: number;
}

/** Un borrador vale una jornada: el de ayer ya no describe la parada de hoy. */
export const DRAFT_TTL_MS = 12 * 60 * 60 * 1000;

export function draftKey(stopId: string): string {
  return `kapta.reparto.borrador.${stopId}`;
}

const str = (v: unknown): v is string => typeof v === "string";
const strOrNull = (v: unknown): v is string | null => v === null || typeof v === "string";

/**
 * Lee un borrador guardado. Null si no hay, si está roto, si venció o si la
 * parada se reportó DESPUÉS de guardarlo (lo que dice la base manda).
 */
export function parseDraft(raw: string | null | undefined, now: number, reportedAt: string | null | undefined): StopDraft | null {
  if (!raw) return null;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  if (d.v !== 1 || typeof d.at !== "number" || !Number.isFinite(d.at)) return null;
  if (now - d.at > DRAFT_TTL_MS || d.at > now + 60_000) return null;
  const reported = reportedAt ? Date.parse(reportedAt) : Number.NaN;
  if (Number.isFinite(reported) && reported >= d.at) return null;
  if (d.status !== "entregado" && d.status !== "no_entregado") return null;
  if (!strOrNull(d.method) || !str(d.amount) || !str(d.reason) || !str(d.note)) return null;
  if (!strOrNull(d.photoPath) || !strOrNull(d.voucherPath)) return null;
  if (!str(d.written) || !str(d.writtenPayment) || !str(d.reasonCode) || !str(d.reasonNote)) return null;
  return {
    v: 1,
    at: d.at,
    status: d.status,
    method: d.method,
    amount: d.amount,
    reason: d.reason,
    note: d.note,
    photoPath: d.photoPath,
    voucherPath: d.voucherPath,
    written: d.written,
    writtenPayment: d.writtenPayment,
    reasonCode: d.reasonCode,
    reasonNote: d.reasonNote,
  };
}

/** ¿Hay algo que recordar? Lo mismo que se ve al abrir la ficha no se guarda. */
export function draftDiffers(fields: StopDraftFields, pristine: StopDraftFields): boolean {
  return (Object.keys(pristine) as (keyof StopDraftFields)[]).some((k) => fields[k] !== pristine[k]);
}

export function serializeDraft(fields: StopDraftFields, now: number): string {
  return JSON.stringify({ v: 1, at: now, ...fields } satisfies StopDraft);
}
