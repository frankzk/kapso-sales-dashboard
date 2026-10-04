// El reporte de movimientos de Yape Empresa («YAPE_REPORTE_MOVIMIENTOS_*.xlsx»),
// el que Yape manda por correo desde notificaciones@yape.pe con el asunto «Te
// compartimos tus movimientos». Es el estado de cuenta de la billetera: lo que
// de verdad entró, no lo que dice una captura. MOM §16.2.
//
// La hoja trae un título, un par de filas vacías y la tabla:
//
//   Movimiento | Origen | Destino | Monto | Fecha de operación | Datos adicionales
//   Ingreso    | Carmen Tas* | GRUPO GF  S.A.C. | S/ 20.00 | 04/10/2026 11:43:05 | …
//
// Lo que NO trae, y condiciona todo el cruce: el nº de operación. Un movimiento
// se reconoce por monto, hora al segundo y quién pagó; quién pagó llega
// recortado cuando es un Yape («Carmen Tas*»: nombre y tres letras del primer
// apellido) y completo cuando viene de otra app, con su prefijo («PLIN - NICOLAS
// RICARDO VALDERRAMA», «BCP - …», «PREXPE - …»).

import { createHash } from "node:crypto";
import { parseWorkbookMatrices } from "@/lib/xlsx";

export type MovementKind = "ingreso" | "egreso";

export interface StatementMovement {
  /**
   * Identidad estable entre reportes. Cada reporte vuelve a traer los días que
   * ya trajo el anterior, así que el mismo movimiento tiene que dar la misma
   * llave: es la huella de la fila más su orden entre filas idénticas.
   */
  key: string;
  kind: MovementKind;
  origin: string;
  destination: string;
  /** «YAPE» para un Yape directo; si no, el prefijo de la app («PLIN», «BCP»…). */
  channel: string;
  /** El origen sin el prefijo de la app. */
  payerName: string;
  amount: number;
  /** ISO en UTC. La hoja escribe la hora de Lima. */
  occurredAt: string;
  extra: string | null;
}

export interface ParsedStatement {
  movements: StatementMovement[];
  /** Filas de la tabla que no se entendieron (monto o fecha ilegibles). */
  unreadable: number;
  /** El primer y el último movimiento, para saber qué días cubre. */
  from: string | null;
  to: string | null;
}

const HEADERS = ["movimiento", "origen", "destino", "monto", "fecha"] as const;

function fold(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();
}

/** «S/ 1,234.50» → 1234.5. */
export function parseStatementAmount(raw: string): number | null {
  const clean = raw.replace(/s\/\.?/i, "").replace(/,/g, "").trim();
  if (!/^-?\d+(\.\d+)?$/.test(clean)) return null;
  const n = Math.round(Number(clean) * 100) / 100;
  return Number.isFinite(n) ? Math.abs(n) : null;
}

/**
 * «04/10/2026 11:43:05», hora de Lima, a ISO en UTC. Si exceljs ya la convirtió
 * en fecha la devuelve en ISO, pero con la hora de la pared tal cual: se toma
 * esa hora como de Lima, que es lo que la hoja quería decir.
 */
export function parseStatementInstant(raw: string): string | null {
  const s = raw.trim();
  const local = /^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(s);
  const iso = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(s);
  let parts: [string, string, string, string, string, string] | null = null;
  if (local) {
    parts = [local[3]!, local[2]!, local[1]!, local[4]!, local[5]!, local[6] ?? "00"];
  } else if (iso) {
    parts = [iso[1]!, iso[2]!, iso[3]!, iso[4]!, iso[5]!, iso[6]!];
  }
  if (!parts) return null;
  const [y, mo, d, h, mi, se] = parts;
  const stamp = Date.parse(
    `${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}T${h.padStart(2, "0")}:${mi}:${se}-05:00`,
  );
  return Number.isFinite(stamp) ? new Date(stamp).toISOString() : null;
}

/** «PLIN - ROY RIDER LOPEZ» → PLIN / ROY RIDER LOPEZ; «Benito Cac*» → YAPE. */
export function splitOrigin(origin: string): { channel: string; payerName: string } {
  const m = /^([A-Z][A-Z0-9]{1,11})\s+-\s+(.+)$/.exec(origin.trim());
  if (m) return { channel: m[1]!, payerName: m[2]!.trim() };
  return { channel: "YAPE", payerName: origin.trim() };
}

function rowKey(kind: string, origin: string, destination: string, amount: number, at: string, extra: string | null) {
  return createHash("sha256")
    .update([kind, origin, destination, amount.toFixed(2), at, extra ?? ""].join("|"))
    .digest("hex")
    .slice(0, 40);
}

/** La tabla ya convertida en texto, fila por fila. Pura: es lo que se prueba. */
export function parseStatementRows(rows: string[][]): ParsedStatement {
  const headerAt = rows.findIndex((r) => {
    const cells = r.map((c) => fold(c ?? ""));
    return HEADERS.every((h) => cells.some((c) => c.startsWith(h)));
  });
  if (headerAt < 0) return { movements: [], unreadable: 0, from: null, to: null };

  const header = rows[headerAt]!.map((c) => fold(c ?? ""));
  const col = (name: string) => header.findIndex((c) => c.startsWith(name));
  const iKind = col("movimiento");
  const iOrigin = col("origen");
  const iDest = col("destino");
  const iAmount = col("monto");
  const iDate = col("fecha");
  const iExtra = col("datos");

  const movements: StatementMovement[] = [];
  const seen = new Map<string, number>();
  let unreadable = 0;
  for (const r of rows.slice(headerAt + 1)) {
    const kindRaw = fold(r[iKind] ?? "");
    if (!kindRaw) continue;
    const kind: MovementKind | null = kindRaw.startsWith("ingreso")
      ? "ingreso"
      : kindRaw.startsWith("egreso")
        ? "egreso"
        : null;
    const amount = parseStatementAmount(r[iAmount] ?? "");
    const occurredAt = parseStatementInstant(r[iDate] ?? "");
    if (!kind || amount === null || !occurredAt) {
      unreadable += 1;
      continue;
    }
    const origin = (r[iOrigin] ?? "").trim();
    const destination = (r[iDest] ?? "").trim();
    const extra = iExtra >= 0 ? (r[iExtra] ?? "").trim() || null : null;
    const base = rowKey(kind, origin, destination, amount, occurredAt, extra);
    // Dos filas idénticas (mismo pagador, monto y segundo) son dos pagos: la
    // llave lleva su orden para no fundirlas en una.
    const ordinal = seen.get(base) ?? 0;
    seen.set(base, ordinal + 1);
    const { channel, payerName } = splitOrigin(origin);
    movements.push({
      key: `${base}#${ordinal}`,
      kind,
      origin,
      destination,
      channel,
      payerName,
      amount,
      occurredAt,
      extra,
    });
  }
  const times = movements.map((m) => m.occurredAt).sort();
  return { movements, unreadable, from: times[0] ?? null, to: times[times.length - 1] ?? null };
}

export async function parseYapeStatement(buffer: Buffer): Promise<ParsedStatement> {
  const sheets = await parseWorkbookMatrices(buffer);
  for (const rows of sheets.values()) {
    const parsed = parseStatementRows(rows);
    if (parsed.movements.length || parsed.unreadable) return parsed;
  }
  return { movements: [], unreadable: 0, from: null, to: null };
}
