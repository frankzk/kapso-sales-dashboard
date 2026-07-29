// Adaptador del reporte diario de Axel Courier (Lima Metropolitana).
//
// Formato real (25/07/2026):
//
//   ITEM | CLIENTE | NOMBRE | DISTRITO | EFECTIVO | F. PAGO | GANANCIA | UTILIDAD | OBSERVACION
//
// Cuatro rarezas que definen este adaptador:
//
//   1. `CLIENTE` NO es el cliente: es la TIENDA ("AURELA"). El cliente es
//      `NOMBRE`. Confundirlas mandaría todas las filas a la tienda equivocada.
//
//   2. NO HAY GUÍA NI Nº DE PEDIDO. Cada entrega se identifica por nombre del
//      cliente y distrito. Se transcriben ambos y el emparejamiento — con lo
//      frágil que es un nombre — lo decide lib/settlement-ingest.ts, que manda a
//      revisión todo lo que no sea inequívoco.
//
//   3. `GANANCIA` es lo que AXEL SE COBRA por la entrega, no una ganancia
//      nuestra ni un pago a un motorizado: cobran S/ 2,219.73 y depositan
//      S/ 2,073.73, quedándose los S/ 146.00 de la columna. Varía por distrito
//      (S/ 10 en Lima, S/ 13 en Puente Piedra, S/ 18 en Cajamarquilla) y se
//      cobra incluso en algunas entregas fallidas ("CAIDA COBRO", "RECHAZO").
//
//   4. LA HOJA ES DE BLOQUES ACUMULATIVOS. Trae varias tandas del mismo día,
//      cada una con su cabecera, su fecha y su fila `TOTAL COBRADO`, y el total
//      de la segunda ARRASTRA el de la primera. Las filas de entrega no se
//      repiten entre bloques, así que se leen todas; lo que hay que descartar
//      con cuidado son las filas de total, "RECAUDADO" y "COMISION", que si se
//      colaran duplicarían toda la plata del día.

import { buildLookup, headerKey, parseNumber, pick } from "@/lib/couriers/sheet";
import type { ParsedSettlementLine, ParsedSettlementSheet } from "@/lib/settlement-sheet";

const STORE_KEYS = ["cliente"];
const NAME_KEYS = ["nombre"];
const DISTRICT_KEYS = ["distrito"];
const CASH_KEYS = ["efectivo"];
const METHOD_KEYS = ["f pago", "forma de pago", "f de pago"];
const FEE_KEYS = ["ganancia"];
const NOTE_KEYS = ["observacion", "observaciones"];
const ITEM_KEYS = ["item", "n", "nro"];

/**
 * Resultado de `F. PAGO`, normalizado.
 *
 * Solo EFECTIVO y PAGO POS son entregas. "CAIDA COBRO" y "RECHAZO" son fallos
 * por los que Axel igual cobra el flete: NO son entregas por más que traigan
 * comisión, y tratarlas como tales inflaría lo que el Master debería haber
 * cobrado. "LUNES" es una reprogramación, no un fracaso.
 */
export function axelDelivered(method: string | null): boolean {
  const m = headerKey(method ?? "");
  if (!m) return false;
  return [
    "efectivo",
    "pago pos",
    "pos",
    "transferencia",
    "transferencia bancaria",
    "yape",
    "plin",
    "deposito",
  ].includes(m);
}

/** Filas que NO son una entrega: totales, arrastres y comisiones. */
function isSummaryRow(raw: Record<string, string>): boolean {
  const values = Object.values(raw).map((v) => headerKey(String(v ?? "")));
  return values.some((v) =>
    /^(total|totales|total cobrado|total general|recaudado|comision|comisiones|suma|sumatoria)$/.test(v),
  );
}

/** Fila de cabecera repetida en mitad de la hoja (cada bloque trae la suya). */
function isHeaderRow(raw: Record<string, string>): boolean {
  const values = Object.values(raw).map((v) => headerKey(String(v ?? "")));
  return values.includes("nombre") && values.includes("distrito");
}

/**
 * `S/ -` y `S/.0.00` son cosas distintas de una celda vacía: ambas dicen "no
 * cobró", y así se guardan (0), mientras que la celda en blanco queda en null
 * ("no lo declaró"). El cuadre distingue las dos.
 */
function axelMoney(value: string | null): number | null {
  if (value === null) return null;
  const t = value.trim();
  if (!t) return null;
  // "S/ -" o "-" con cualquier separador: cero declarado.
  if (/^s?\/?\.?\s*-+$/i.test(t)) return 0;
  return parseNumber(t);
}

/** ¿Esta hoja es un reporte de Axel? */
export function scoreAxelSheet(rows: readonly Record<string, string>[]): number {
  let hits = 0;
  for (const raw of rows.slice(0, 40)) {
    const map = buildLookup(raw);
    // La firma del formato: NOMBRE + DISTRITO + GANANCIA juntos. Ningún otro
    // reporte que manejamos trae una columna llamada "ganancia".
    if (pick(map, NAME_KEYS) && pick(map, DISTRICT_KEYS) && map.has("ganancia")) hits++;
  }
  return hits;
}

/**
 * Lee el reporte entero, con todos sus bloques. Las filas numeradas vacías (los
 * huecos del 26 al 30) se descartan; las que traen nombre pero sin plata se
 * conservan, porque una entrega caída sigue siendo información del día.
 */
export function parseAxelSheet(
  rows: readonly Record<string, string>[],
): ParsedSettlementSheet & { storeHint: string | null; posFee: number } {
  const lines: ParsedSettlementLine[] = [];
  let storeHint: string | null = null;
  let posFee = 0;

  for (const raw of rows) {
    // La comisión de POS viene en su propia fila, fuera de las entregas, y hay
    // que capturarla antes de descartar los resúmenes: también se descuenta del
    // depósito, igual que las comisiones por entrega.
    const values = Object.values(raw).map((v) => String(v ?? ""));
    if (values.some((v) => headerKey(v) === "comision")) {
      // Se lee de las columnas de dinero, NO del primer número de la fila: el
      // "19" de la columna ITEM llegaría antes que el importe y registraría una
      // comisión de S/ 19.00 que nadie cobró.
      const feeMap = buildLookup(raw);
      const n = axelMoney(pick(feeMap, [...FEE_KEYS, ...CASH_KEYS]));
      if (n !== null && n > 0) posFee = n;
      continue;
    }
    if (isSummaryRow(raw) || isHeaderRow(raw)) continue;

    const map = buildLookup(raw);
    const name = pick(map, NAME_KEYS);
    const district = pick(map, DISTRICT_KEYS);
    const method = pick(map, METHOD_KEYS);
    const rowStore = pick(map, STORE_KEYS);
    const cash = axelMoney(pick(map, CASH_KEYS));
    const fee = axelMoney(pick(map, FEE_KEYS));

    // Una fila sin nombre y sin resultado es un hueco del formato (los ITEM 26
    // al 30 que la plantilla deja en blanco), no una entrega.
    if (!name && !method) continue;

    storeHint ??= rowStore;

    lines.push({
      // Axel no da ninguno de los dos; la ingesta empareja por nombre y distrito.
      guide_code: null,
      order_name: null,
      declared_status: method,
      declared_amount: cash,
      declared_fee: fee,
      customer_name: name,
      district,
      store_hint: rowStore,
      payment_method: axelDelivered(method) ? method : null,
      raw: {
        item: pick(map, ITEM_KEYS) ?? "",
        cliente: pick(map, STORE_KEYS) ?? "",
        nombre: name ?? "",
        distrito: district ?? "",
        efectivo: pick(map, CASH_KEYS) ?? "",
        f_pago: method ?? "",
        ganancia: pick(map, FEE_KEYS) ?? "",
        observacion: pick(map, NOTE_KEYS) ?? "",
      },
    });
  }

  return {
    // El nombre del motorizado no aparece en el reporte: la hoja es del courier
    // entero, no de una persona. Se deja en null en vez de inventarlo.
    riderName: null,
    // Cada bloque trae su fecha en una fila suelta que no es tabular; la fecha
    // la pone quien importa, que es lo que ya manda sobre la leída del archivo.
    settlementDate: null,
    lines,
    storeHint,
    posFee,
  };
}
