// Lectura de una liquidación en hoja de cálculo (Excel o CSV). Pura + testeada.
//
// A diferencia de los reportes de courier (lib/couriers/*), aquí NO hay un
// formato por proveedor que valga la pena modelar: cada courier — y a veces cada
// coordinador — arma su hoja de liquidación a su manera. Por eso hay UN lector
// tolerante por alias de cabecera en vez de un adaptador por courier.
//
// La regla que lo sostiene es la misma de siempre: lo que no se reconoce NO se
// adivina. Una fila sin guía ni nº de pedido no se inventa un vínculo, se marca
// para que la mire una persona; una columna de monto ausente deja el monto en
// null (que el cuadre leerá como "no declaró"), no en cero.

import { normalizeOrderName } from "@/lib/aliclik-import";
import { buildLookup, headerKey, parseDate, parseNumber, pick } from "@/lib/couriers/sheet";

/** Una línea leída de la hoja, antes de vincularse con un pedido. */
export interface ParsedSettlementLine {
  guide_code: string | null;
  order_name: string | null;
  declared_status: string | null;
  declared_amount: number | null;
  raw: Record<string, string>;
}

export interface ParsedSettlementSheet {
  /** Nombre del motorizado si la hoja lo trae. Es una PISTA: quién liquida lo
   *  confirma una persona, porque de ello depende a quién se le paga. */
  riderName: string | null;
  /** Fecha de la liquidación (YYYY-MM-DD) si la hoja la trae. */
  settlementDate: string | null;
  lines: ParsedSettlementLine[];
}

// Alias de cabecera, ya normalizados por headerKey (minúsculas, sin acentos, sin
// puntuación). Añadir una variante nueva es añadir una cadena a la lista.
const GUIDE_KEYS = [
  "guia",
  "n guia",
  "nro guia",
  "numero de guia",
  "codigo de guia",
  "tracking",
  "codigo de rastreo",
  "codigo",
];
const ORDER_KEYS = [
  "pedido",
  "n pedido",
  "nro pedido",
  "numero de pedido",
  "orden",
  "order",
  "nro orden",
];
const AMOUNT_KEYS = [
  "monto",
  "monto cobrado",
  "importe",
  "cobrado",
  "recaudado",
  "total",
  "total cobrado",
  "efectivo",
  "monto a cobrar",
  "cobro",
];
const STATUS_KEYS = [
  "estado",
  "estado entrega",
  "estado de entrega",
  "situacion",
  "resultado",
  "observacion",
  "observaciones",
];
const RIDER_KEYS = [
  "motorizado",
  "repartidor",
  "conductor",
  "responsable",
  "personal",
  "encargado",
];
const DATE_KEYS = [
  "fecha",
  "fecha liquidacion",
  "fecha de liquidacion",
  "fecha entrega",
  "dia",
];

/** Guía suelta: un código alfanumérico largo sin espacios. Se usa solo para
 *  puntuar la hoja, nunca para decidir un vínculo. */
const GUIDE_LIKE = /^[A-Za-z0-9][A-Za-z0-9-]{5,}$/;

/** Fecha ISO (YYYY-MM-DD) del valor de la hoja, o null. */
function toDay(value: string | null): string | null {
  const iso = parseDate(value);
  return iso ? iso.slice(0, 10) : null;
}

/**
 * ¿Esta hoja parece una liquidación? Cuántas de las primeras filas traen a la
 * vez algo que identifique la guía o el pedido Y un monto. Se usa para avisar al
 * operador antes de importar, no para rechazar: si él dice que es una
 * liquidación, se importa igual y lo dudoso cae en revisión.
 */
export function scoreSettlementSheet(rows: readonly Record<string, string>[]): number {
  let hits = 0;
  for (const raw of rows.slice(0, 20)) {
    const map = buildLookup(raw);
    const hasId =
      pick(map, GUIDE_KEYS) !== null ||
      pick(map, ORDER_KEYS) !== null ||
      Object.values(raw).some((v) => GUIDE_LIKE.test(String(v ?? "").trim()));
    const hasMoney = parseNumber(pick(map, AMOUNT_KEYS)) !== null;
    if (hasId && hasMoney) hits++;
  }
  return hits;
}

/** ¿La fila está vacía de contenido útil? Las hojas traen filas de separación y
 *  de totales que no son entregas. */
function isBlank(raw: Record<string, string>): boolean {
  return !Object.values(raw).some((v) => String(v ?? "").trim());
}

/** Filas de total ("TOTAL", "SUMA", "TOTAL RECAUDADO") que no son una entrega.
 *  Colarlas duplicaría toda la plata del día en el cuadre. */
function isTotalRow(raw: Record<string, string>): boolean {
  const values = Object.values(raw)
    .map((v) => headerKey(String(v ?? "")))
    .filter(Boolean);
  if (!values.length) return false;
  return values.some((v) => /^(total|totales|suma|sumatoria|total general|total recaudado)$/.test(v));
}

/**
 * Lee la hoja entera. Devuelve TODAS las filas con contenido, incluidas las que
 * no traen guía ni pedido: esas quedan con ambos en null y la ingesta las manda
 * a revisión. Descartarlas aquí escondería plata declarada que nadie revisaría.
 */
export function parseSettlementSheet(
  rows: readonly Record<string, string>[],
): ParsedSettlementSheet {
  const lines: ParsedSettlementLine[] = [];
  let riderName: string | null = null;
  let settlementDate: string | null = null;

  for (const raw of rows) {
    if (isBlank(raw) || isTotalRow(raw)) continue;
    const map = buildLookup(raw);

    // El motorizado y la fecha suelen venir repetidos en cada fila, o una sola
    // vez arriba. Se toma el primero que aparezca y no se cambia: dos nombres
    // distintos en una hoja son un problema para una persona, no para el lector.
    riderName ??= pick(map, RIDER_KEYS);
    settlementDate ??= toDay(pick(map, DATE_KEYS));

    const guide = pick(map, GUIDE_KEYS);
    const order = pick(map, ORDER_KEYS);

    lines.push({
      guide_code: guide,
      order_name: normalizeOrderName(order),
      declared_status: pick(map, STATUS_KEYS),
      declared_amount: parseNumber(pick(map, AMOUNT_KEYS)),
      raw,
    });
  }

  return { riderName, settlementDate, lines };
}
