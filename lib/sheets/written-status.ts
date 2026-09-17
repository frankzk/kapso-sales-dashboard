// Liquidaciones 2 — edición a mano del estado y del método de pago en una
// hoja cuaderno. Puro y testeado (test/sheets-written-status.test.ts).
//
// LA REGLA DE TRES NIVELES (MOM §30.7). El estado escrito es el dato y no se
// normaliza en la base; el estado del grupo es una lectura por alias; el
// estado de Kapta es una lectura del grupo. Por eso editar a mano es TEXTO
// LIBRE: lo tecleado se guarda tal cual en `estado_reportado`, y `estado` se
// deriva con los mismos alias que usa la importación. Si no resuelve, la fila
// queda a revisión y el alias aparece sin equivalente para que alguien lo
// asigne una vez y valga para siempre.

import { interpretStatus, resolvePayment } from "./reparto-import";
import type { StatusLookup } from "./statuses";
import type { CellValue } from "./types";

export interface WrittenStatusResult {
  /** Celdas que cambian; se aplican sobre `values` de la fila. */
  changes: Record<string, CellValue>;
  /** Alias que quedó sin equivalente y hay que registrar en la hoja. */
  unknownAlias: string | null;
}

const REVIEW_TAG = "estado_sin_equivalente";

function withReview(current: CellValue, add: boolean): CellValue {
  const tags = String(current ?? "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean)
    .filter((t) => t !== REVIEW_TAG);
  if (add) tags.push(REVIEW_TAG);
  return tags.length ? tags.join(", ") : null;
}

/**
 * Lo tecleado en «Estado» de una fila cuaderno. `values` son las celdas
 * guardadas de la fila (para leer la fecha y la revisión actual).
 */
export function applyWrittenStatus(
  values: Record<string, CellValue>,
  text: string | null,
  lookup: StatusLookup,
): WrittenStatusResult {
  const raw = (text ?? "").trim();
  if (!raw) {
    return {
      changes: { estado_reportado: null, estado: null, reprogramar_para: null, revision: withReview(values.revision ?? null, false) },
      unknownAlias: null,
    };
  }
  const fecha = typeof values.fecha === "string" ? values.fecha : null;
  const res = interpretStatus(raw, fecha, lookup);
  return {
    changes: {
      estado_reportado: raw,
      estado: res.estado,
      reprogramar_para: res.reprogramar_para ?? (res.estado === "reprogramado" ? (values.reprogramar_para ?? null) : null),
      revision: withReview(values.revision ?? null, res.estado === null),
    },
    unknownAlias: res.unknown,
  };
}

/** Lo tecleado en «Método de pago»: se guarda literal y se traduce a la lista. */
export function applyWrittenPayment(text: string | null): Record<string, CellValue> {
  const raw = (text ?? "").trim();
  if (!raw) return { metodo_pago_reportado: null, metodo_pago: null };
  const pay = resolvePayment(raw);
  return { metodo_pago_reportado: raw, metodo_pago: pay.method };
}
