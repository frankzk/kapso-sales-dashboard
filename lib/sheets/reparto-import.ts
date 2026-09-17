// Liquidaciones 2 — lector de la hoja de ruta de un motorizado. Puro y
// testeado (test/sheets-reparto-import.test.ts).
//
// EL FORMATO. La hoja del Excel «MASTER KEY 2.0» no es una tabla: son BLOQUES,
// uno por día de ruta, apilados de arriba abajo (el más reciente arriba):
//
//   Fecha        | 2026-05-12
//   Motorizado:  | ROY
//                | Vendedor | Nombre del cliente | # de Pedido | A cobrar | Efectivo | A cobrar | Método de Pago | Obs 1 | Obs 2 | Fecha
//   Punto 01     | Aurela   | Juan Navarro       | #AUR167846  | ENTREGADO| 89       | 89.0     | EFECTIVO       |       |       |
//   …
//   SUBTOTAL     | 35 ENTREGADOS
//   FK RECIBIO / AK RECIBIO / TOTAL A PAGAR A … / PTOS KAST / TOTAL PARA KAST
//
// La primera columna «A cobrar» es en realidad el ESTADO (así quedó la
// cabecera en la hoja y así la lee todo el mundo); la segunda es el monto del
// pedido. «Efectivo» es lo que el motorizado cobró en billetes.
//
// LO QUE NO SE ADIVINA. Un estado que no está en el vocabulario del dominio ni
// en los alias de la hoja se guarda literal y la fila queda a revisión. Una
// fecha ilegible deja la fila sin fecha, a revisión. Un monto que no es un
// número queda vacío, nunca cero. Un método de pago fuera de la lista se
// guarda literal en `metodo_pago_reportado`.

import { normalizeAlias, resolveStatus, type StatusLookup } from "./statuses";
import { REPARTO_PAYMENT_ALIASES, REPARTO_PAYMENT_METHODS, REPARTO_STORES } from "./templates";
import type { CellValue } from "./types";

export interface ParsedPuntoRow {
  row_key: string;
  /** YYYY-MM-DD del bloque; null si el bloque no tenía fecha legible. */
  fecha: string | null;
  punto: string | null;
  tienda: string | null;
  cliente: string | null;
  /** Normalizado a `#AUR123456` / `#KP123456` cuando es un pedido Shopify. */
  pedido: string | null;
  pedido_shopify: boolean;
  estado: string | null;
  estado_reportado: string | null;
  reprogramar_para: string | null;
  efectivo: number | null;
  a_cobrar: number | null;
  metodo_pago: string | null;
  metodo_pago_reportado: string | null;
  observacion_1: string | null;
  observacion_2: string | null;
  /** Por qué la fila necesita que la mire alguien. Vacío = limpia. */
  review: string[];
  /** Nº de fila en la hoja, para decirlo en pantalla. */
  source_row: number;
}

export interface ParsedReparto {
  rows: ParsedPuntoRow[];
  blocks: number;
  /** Alias de estado vistos sin equivalente, con cuántas veces. */
  unknownStatuses: Map<string, number>;
  /** Métodos de pago fuera de la lista, con cuántas veces. */
  unknownPayments: Map<string, number>;
  skipped: number;
}

const FOOTER_RE = /^(SUBTOTAL|FK RECIBIO|AK RECIBIO|TOTAL A PAGAR|PTOS KAST|TOTAL PARA KAST|TOTAL)\b/;
const ORDER_RE = /#?\s*(AUR|KP)\s*-?\s*(\d{4,7})/i;
const WEEKDAYS: Record<string, number> = { DOMINGO: 0, LUNES: 1, MARTES: 2, MIERCOLES: 3, JUEVES: 4, VIERNES: 5, SABADO: 6 };

/** `2025-12-02T00:00:00`, `12/05/2026`, `11/5/2026}` → `2026-05-11`. Null si no. */
export function parseBlockDate(raw: string | null | undefined): string | null {
  const v = (raw ?? "").trim();
  if (!v) return null;
  let y: number, m: number, d: number;
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(v);
  const dmy = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})/.exec(v);
  if (iso) [y, m, d] = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
  else if (dmy) [d, m, y] = [Number(dmy[1]), Number(dmy[2]), Number(dmy[3])];
  else return null;
  if (y < 2024 || y > 2027 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCMonth() !== m - 1) return null;
  return date.toISOString().slice(0, 10);
}

export function parseMoney(raw: string | null | undefined): number | null {
  const v = (raw ?? "").trim();
  if (!v || !/\d/.test(v)) return null;
  const cleaned = v.replace(/S\/\.?/gi, "").replace(/[^\d,.-]/g, "").replace(/\.(?=\d{3}\b)/g, "").replace(",", ".");
  const n = Number(cleaned);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

/** `#aur 167846`, `AUR167846`, `#KP-94649` → `#AUR167846`. Null si no parece pedido Shopify. */
export function normalizeOrderCode(raw: string | null | undefined): string | null {
  const m = ORDER_RE.exec(raw ?? "");
  if (!m) return null;
  return `#${m[1]!.toUpperCase()}${m[2]}`;
}

export function normalizeStore(raw: string | null | undefined): string | null {
  const v = normalizeAlias(raw);
  if (!v) return null;
  if (v.startsWith("AUR")) return "Aurela";
  if (v.startsWith("KENK") || v === "KP") return "Kenku";
  if (v.startsWith("KAST")) return "Kast";
  return REPARTO_STORES.find((s) => normalizeAlias(s) === v) ?? "Otra";
}

export function resolvePayment(raw: string | null | undefined): { method: string | null; reported: string | null } {
  const v = normalizeAlias(raw);
  if (!v) return { method: null, reported: null };
  const direct = REPARTO_PAYMENT_METHODS.find((m) => normalizeAlias(m) === v);
  if (direct) return { method: direct, reported: v };
  const alias = REPARTO_PAYMENT_ALIASES[v];
  return { method: alias ?? null, reported: v };
}

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Próximo «jueves» estrictamente después de `from`. */
export function nextWeekday(from: string, weekday: number): string {
  const d = new Date(`${from}T00:00:00Z`);
  const diff = (weekday - d.getUTCDay() + 7) % 7 || 7;
  return addDays(from, diff);
}

/**
 * Interpreta lo escrito en la columna de estado. Los días de la semana, «hoy»
 * y «mañana» son reprogramaciones con fecha; el resto va al vocabulario.
 */
export function interpretStatus(
  raw: string | null | undefined,
  fecha: string | null,
  lookup: StatusLookup,
): { estado: string | null; reprogramar_para: string | null; unknown: string | null } {
  const alias = normalizeAlias(raw);
  if (!alias) return { estado: null, reprogramar_para: null, unknown: null };
  const word = alias.replace(/\s+\d.*$/, ""); // «LUNES 29» → «LUNES»
  if (word in WEEKDAYS && lookup.codes.has("reprogramado")) {
    return { estado: "reprogramado", reprogramar_para: fecha ? nextWeekday(fecha, WEEKDAYS[word]!) : null, unknown: null };
  }
  if ((word === "MANANA" || word === "PARA MANANA") && lookup.codes.has("reprogramado")) {
    return { estado: "reprogramado", reprogramar_para: fecha ? addDays(fecha, 1) : null, unknown: null };
  }
  if (word === "HOY" && lookup.codes.has("reprogramado")) {
    return { estado: "reprogramado", reprogramar_para: fecha, unknown: null };
  }
  const res = resolveStatus(alias, lookup);
  if (res.kind === "ok") return { estado: res.code, reprogramar_para: null, unknown: null };
  // «MISMO CLIENTE PTO 37», «ANULADO SOLO PTO 10»: el número es del día, no del estado.
  if (word !== alias) {
    const again = resolveStatus(word, lookup);
    if (again.kind === "ok") return { estado: again.code, reprogramar_para: null, unknown: null };
  }
  return { estado: null, reprogramar_para: null, unknown: alias };
}

export function puntoRowKey(fecha: string | null, pedido: string | null, cliente: string | null, seq: number): string {
  const day = fecha ?? "s-f";
  const who = pedido ?? (normalizeAlias(cliente).toLowerCase().replace(/\s+/g, "_").slice(0, 40) || `fila_${seq}`);
  return `${day}#${who}`;
}

/** Lo que necesita una fila para construirse, venga de la matriz o de la foto. */
export interface PuntoInput {
  fecha: string | null;
  punto: string | null;
  tienda: string | null;
  cliente: string | null;
  pedidoRaw: string | null;
  estadoRaw: string | null;
  efectivoRaw: string | null;
  aCobrarRaw: string | null;
  metodoRaw: string | null;
  observacion_1: string | null;
  observacion_2: string | null;
  /** Nº de fila de origen (matriz) o correlativo (foto). */
  source_row: number;
}

/** Estado acumulado durante una lectura: claves vistas y vocabulario desconocido. */
export interface PuntoBuildContext {
  lookup: StatusLookup;
  seen: Map<string, number>;
  unknownStatuses: Map<string, number>;
  unknownPayments: Map<string, number>;
}

export function newBuildContext(lookup: StatusLookup): PuntoBuildContext {
  return { lookup, seen: new Map(), unknownStatuses: new Map(), unknownPayments: new Map() };
}

/**
 * Construye una fila de cuaderno a partir de sus celdas. Devuelve null si no
 * hay nada que guardar (punto vacío al final del bloque). La misma función
 * sirve para la matriz del Excel y para las líneas leídas de una foto: así
 * las dos entradas siguen las mismas reglas de estado, monto y revisión.
 */
export function buildPuntoRow(input: PuntoInput, ctx: PuntoBuildContext): ParsedPuntoRow | null {
  const pedidoRaw = (input.pedidoRaw ?? "").trim();
  const pedido = normalizeOrderCode(pedidoRaw);
  const cliente = input.cliente?.trim() || null;
  if (!pedido && !pedidoRaw && !cliente) return null;

  const review: string[] = [];
  if (!input.fecha) review.push("sin_fecha");
  const status = interpretStatus(input.estadoRaw, input.fecha, ctx.lookup);
  if (status.unknown) {
    review.push("estado_sin_equivalente");
    ctx.unknownStatuses.set(status.unknown, (ctx.unknownStatuses.get(status.unknown) ?? 0) + 1);
  }
  const pay = resolvePayment(input.metodoRaw);
  if (pay.reported && !pay.method) {
    ctx.unknownPayments.set(pay.reported, (ctx.unknownPayments.get(pay.reported) ?? 0) + 1);
  }
  if (!pedido && pedidoRaw) review.push("pedido_no_shopify");

  const baseKey = puntoRowKey(input.fecha, pedido ?? (pedidoRaw ? normalizeAlias(pedidoRaw).toLowerCase() : null), cliente, input.source_row);
  const n = (ctx.seen.get(baseKey) ?? 0) + 1;
  ctx.seen.set(baseKey, n);
  if (n > 1) review.push("pedido_repetido_en_el_dia");

  return {
    row_key: n > 1 ? `${baseKey}#${n}` : baseKey,
    fecha: input.fecha,
    punto: input.punto?.trim() || null,
    tienda: normalizeStore(input.tienda),
    cliente,
    pedido: pedido ?? (pedidoRaw || null),
    pedido_shopify: Boolean(pedido),
    estado: status.estado,
    estado_reportado: input.estadoRaw?.trim() || null,
    reprogramar_para: status.reprogramar_para,
    efectivo: parseMoney(input.efectivoRaw),
    a_cobrar: parseMoney(input.aCobrarRaw),
    metodo_pago: pay.method,
    metodo_pago_reportado: pay.reported,
    observacion_1: input.observacion_1?.trim() || null,
    observacion_2: input.observacion_2?.trim() || null,
    review,
    source_row: input.source_row,
  };
}

/**
 * Lee la matriz de una hoja de motorizado. `lookup` trae el vocabulario del
 * dominio más los alias de la hoja.
 */
export function parseRepartoMatrix(matrix: readonly (readonly string[])[], lookup: StatusLookup): ParsedReparto {
  const rows: ParsedPuntoRow[] = [];
  const ctx = newBuildContext(lookup);
  let fecha: string | null = null;
  let blocks = 0;
  let skipped = 0;

  matrix.forEach((cells, index) => {
    const col = (i: number) => (cells[i] ?? "").trim();
    const a = col(0);
    const aNorm = normalizeAlias(a);
    if (!cells.some((c) => c && c.trim())) return;

    if (aNorm === "FECHA") {
      const date = parseBlockDate(col(1));
      fecha = date;
      blocks += 1;
      return;
    }
    if (aNorm.startsWith("MOTORIZADO") || FOOTER_RE.test(aNorm)) return;
    if (normalizeAlias(col(1)) === "VENDEDOR" && normalizeAlias(col(3)).includes("PEDIDO")) return; // cabecera

    const pedidoRaw = col(3);
    const isPunto = /^PUNTO\b/.test(aNorm) || /^PTO\b/.test(aNorm);
    if (!isPunto && !normalizeOrderCode(pedidoRaw)) {
      skipped += 1;
      return;
    }
    const row = buildPuntoRow(
      {
        fecha,
        punto: a || null,
        tienda: col(1) || null,
        cliente: col(2) || null,
        pedidoRaw,
        estadoRaw: col(4) || null,
        efectivoRaw: col(5) || null,
        aCobrarRaw: col(6) || null,
        metodoRaw: col(7) || null,
        observacion_1: col(8) || null,
        observacion_2: col(9) || null,
        source_row: index + 1,
      },
      ctx,
    );
    if (!row) {
      skipped += 1; // «Punto 88» vacío al final del bloque
      return;
    }
    rows.push(row);
  });

  return { rows, blocks, unknownStatuses: ctx.unknownStatuses, unknownPayments: ctx.unknownPayments, skipped };
}

/** Una línea tal como la devuelve la lectura por visión (lib/settlement-vision). */
export interface VisionLineInput {
  order_name: string | null;
  customer_name: string | null;
  declared_status: string | null;
  declared_amount: number | null;
  payment_method?: string | null;
  store_hint?: string | null;
}

/**
 * Las líneas leídas de una FOTO del cuaderno, como filas de una sola ruta.
 * `fecha` es la que leyó la visión o la que tecleó quien subió la foto; sin
 * fecha las filas quedan a revisión igual que un bloque ilegible del Excel.
 */
export function parsedFromVisionLines(lines: readonly VisionLineInput[], fecha: string | null, lookup: StatusLookup): ParsedReparto {
  const ctx = newBuildContext(lookup);
  const rows: ParsedPuntoRow[] = [];
  let skipped = 0;
  lines.forEach((line, i) => {
    const row = buildPuntoRow(
      {
        fecha,
        punto: `Punto ${String(i + 1).padStart(2, "0")}`,
        tienda: line.store_hint ?? null,
        cliente: line.customer_name,
        pedidoRaw: line.order_name,
        estadoRaw: line.declared_status,
        efectivoRaw: null,
        aCobrarRaw: line.declared_amount === null || line.declared_amount === undefined ? null : String(line.declared_amount),
        metodoRaw: line.payment_method ?? null,
        observacion_1: null,
        observacion_2: null,
        source_row: i + 1,
      },
      ctx,
    );
    if (row) rows.push(row);
    else skipped += 1;
  });
  return { rows, blocks: 1, unknownStatuses: ctx.unknownStatuses, unknownPayments: ctx.unknownPayments, skipped };
}

/** Los valores que se guardan en `sheet_rows.values` para una fila leída. */
export function puntoRowValues(row: ParsedPuntoRow): Record<string, CellValue> {
  return {
    fecha: row.fecha,
    punto: row.punto,
    tienda: row.tienda,
    cliente: row.cliente,
    pedido: row.pedido,
    estado: row.estado,
    estado_reportado: row.estado_reportado,
    reprogramar_para: row.reprogramar_para,
    efectivo: row.efectivo,
    a_cobrar: row.a_cobrar,
    metodo_pago: row.metodo_pago,
    metodo_pago_reportado: row.metodo_pago_reportado,
    observacion_1: row.observacion_1,
    observacion_2: row.observacion_2,
    revision: row.review.length ? row.review.join(", ") : null,
  };
}
