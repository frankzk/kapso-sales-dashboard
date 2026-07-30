// Registro de formatos de liquidación. Añadir un courier es un archivo en este
// directorio y una entrada aquí; la ingesta no cambia.
//
// Hay dos niveles a propósito:
//
//   - ADAPTADORES CON NOMBRE (Axel y los que vengan): conocen las rarezas de UN
//     formato — que su columna "CLIENTE" es la tienda, que su "GANANCIA" es la
//     comisión del courier, que la hoja trae varios bloques acumulativos.
//   - EL LECTOR GENÉRICO (lib/settlement-sheet.ts): alias de cabecera para todo
//     lo demás. Es lo que evita tener que escribir un adaptador antes de poder
//     cargar la hoja de un coordinador nuevo.
//
// Se elige por contenido, no por lo que diga el operador, y si nadie reconoce la
// hoja se usa el genérico: peor que acertar el formato es rechazar el archivo.

import { parseSettlementSheet, type ParsedSettlementLine } from "@/lib/settlement-sheet";
import { parseAxelSheet, scoreAxelSheet } from "./axel";

export interface SettlementParseResult {
  /** Identificador del formato reconocido, o "generico". */
  format: string;
  label: string;
  riderName: string | null;
  settlementDate: string | null;
  /** Pista de tienda que traiga la hoja ("AURELA"), para avisar si el operador
   *  eligió otra. Nunca decide la tienda por su cuenta. */
  storeHint: string | null;
  /** Comisión declarada aparte de las entregas (la fila COMISION de Axel). */
  posFee: number;
  lines: ParsedSettlementLine[];
}

export interface SettlementAdapter {
  id: string;
  label: string;
  /** Cuántas de las primeras filas reconoce como suyas (0 = no es su formato). */
  score: (rows: readonly Record<string, string>[]) => number;
  parse: (rows: readonly Record<string, string>[]) => SettlementParseResult;
}

export const AXEL: SettlementAdapter = {
  id: "axel",
  label: "Axel Courier",
  score: scoreAxelSheet,
  parse: (rows) => {
    const r = parseAxelSheet(rows);
    return {
      format: "axel",
      label: "Axel Courier",
      riderName: r.riderName,
      settlementDate: r.settlementDate,
      storeHint: r.storeHint,
      posFee: r.posFee,
      lines: r.lines,
    };
  },
};

export const SETTLEMENT_ADAPTERS: SettlementAdapter[] = [AXEL];

/**
 * Lee la hoja con el adaptador que mejor la reconozca, y con el lector genérico
 * si ninguno la reconoce. `format` dice cuál se usó, para poder mostrarlo y para
 * que un formato mal detectado se note en vez de pasar desapercibido.
 */
export function parseSettlementFile(
  rows: readonly Record<string, string>[],
  forcedFormat?: string | null,
): SettlementParseResult {
  const forced = forcedFormat
    ? SETTLEMENT_ADAPTERS.find((a) => a.id === forcedFormat)
    : undefined;
  if (forced) return forced.parse(rows);

  let best: { adapter: SettlementAdapter; score: number } | null = null;
  for (const adapter of SETTLEMENT_ADAPTERS) {
    const score = adapter.score(rows);
    if (score > 0 && (!best || score > best.score)) best = { adapter, score };
  }
  if (best) return best.adapter.parse(rows);

  const generic = parseSettlementSheet(rows);
  return {
    format: "generico",
    label: "Formato genérico",
    riderName: generic.riderName,
    settlementDate: generic.settlementDate,
    storeHint: null,
    posFee: 0,
    lines: generic.lines,
  };
}
