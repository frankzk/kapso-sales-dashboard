// La bitácora del estado de cuenta de Yape (MOM §16.2): cada reporte que llegó
// por correo y los comprobantes que validó al cruzarlo.
//
// POR QUÉ. El cruce valida sin que nadie mire, y lo único que dejaba a la vista
// era la tarjeta de cada pago en «Validados hoy». Quien manda el correo a mano
// —o quien se pregunta por qué un pago no se validó solo— necesita la otra
// mitad: si el reporte llegó, cuándo, qué periodo traía y qué hizo con él. El
// 04-10-2026 el segundo correo del día «no validó nada» y no había dónde verlo
// sin abrir la base.
//
// Puro: arma la vista a partir de las filas. Las lee
// lib/yape-statement/log-access.ts.

import { paymentObservationLabel } from "@/lib/payment-review";

export interface StatementImportRow {
  id: string;
  message_id: string;
  file_name: string;
  received_at: string | null;
  period_from: string | null;
  period_to: string | null;
  movements: number;
  new_movements: number;
  unreadable: number;
  report: unknown;
  error: string | null;
  created_at: string;
  finished_at: string | null;
}

export interface StatementMatchRow {
  import_id: string | null;
  payment_id: string;
  order_id: string;
  movement_key: string;
  rule: string;
}

export interface StatementMovementRow {
  movement_key: string;
  origin: string;
  amount: number | string;
  occurred_at: string;
}

export interface StatementPaymentRow {
  id: string;
  kind: string;
  validation_status: string;
}

export interface StatementOrderRow {
  order_id: string;
  order_name: string | null;
  customer_name: string | null;
}

export interface StatementLogMatch {
  paymentId: string;
  orderId: string;
  orderName: string;
  customerName: string | null;
  kind: string;
  /** El movimiento que lo concilió: quién pagó, cuánto y a qué hora. */
  payer: string;
  amount: number;
  movementAt: string;
  rule: string;
  /** Si después una persona lo observó o rechazó, lo dice; si sigue validado, null. */
  laterStatus: string | null;
}

export interface StatementLogSkip {
  reason: string;
  label: string;
  count: number;
}

export interface StatementLogEntry {
  id: string;
  fileName: string;
  /** Cuándo llegó el correo al buzón. */
  receivedAt: string | null;
  /** Cuándo lo procesó Kapta. */
  processedAt: string;
  finished: boolean;
  periodFrom: string | null;
  periodTo: string | null;
  movements: number;
  newMovements: number;
  unreadable: number;
  matches: StatementLogMatch[];
  /** Comprobantes del periodo que quedaron sin validar, por motivo. */
  skipped: StatementLogSkip[];
  leftPending: number;
  courierTimesFilled: number;
  errors: string[];
  /** El mismo correo ya se había procesado: aquí la hora de esa vez. */
  repeatOf: string | null;
}

export interface StatementLog {
  entries: StatementLogEntry[];
  /** Hay más reportes que los que se muestran. */
  truncated: boolean;
}

/**
 * Lo que no validó, dicho como se lo diría una persona. Las llaves son las de
 * `SkipReason` (lib/yape-statement/match.ts) más las del orquestador.
 */
const SKIP_LABEL: Record<string, string> = {
  sin_movimiento: "Ningún movimiento cuadra en monto, minuto y quién pagó",
  varios_movimientos: "Más de un movimiento posible",
  movimiento_disputado: "Otro pago reclama el mismo movimiento",
  no_fue_a_yape: "Cobro del courier que no fue a Yape",
  operacion_transcrita: "Nº de operación escrito a mano (lo valida otra persona)",
  sin_operacion: "Sin nº de operación",
  sin_hora: "Sin hora de pago",
  sin_monto: "Sin monto",
  receptor_no_cuadra: "La constancia dice otra cuenta receptora",
  ya_conciliado: "Ya conciliado antes",
  cambio_de_estado: "Alguien lo decidió mientras tanto",
  sin_tiempo: "Quedó para el siguiente reporte",
  error: "Error al validar",
  no_pendiente: "No estaba pendiente",
};

export function statementSkipLabel(reason: string): string {
  if (SKIP_LABEL[reason]) return SKIP_LABEL[reason];
  const plain = reason.replace(/_/g, " ");
  return plain.charAt(0).toUpperCase() + plain.slice(1);
}

const RULE_LABEL: Record<string, string> = {
  minuto_y_clienta: "Monto, minuto y la clienta",
  minuto_y_clienta_pm: "Monto, minuto (con la hora p. m. corregida) y la clienta",
  minuto_y_canal: "Monto, minuto y el canal del courier",
};

/** Por qué ese movimiento era ese comprobante (MOM §16.2). */
export function statementRuleLabel(rule: string): string {
  return RULE_LABEL[rule] ?? rule;
}

function laterStatusLabel(status: string | undefined): string | null {
  if (!status || status === "validado") return null;
  if (status === "rechazado") return "Rechazado después";
  if (status === "pendiente_revision") return "Volvió a pendientes";
  return `Después: ${paymentObservationLabel(status)}`;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

const HOUR = 3_600_000;

/** «2026-10-04T22:37:03Z» → partes en hora de Lima (UTC-5 fijo, sin horario de verano). */
function limaParts(iso: string) {
  const t = new Date(Date.parse(iso) - 5 * HOUR).toISOString();
  const h24 = Number(t.slice(11, 13));
  return {
    day: t.slice(8, 10),
    month: t.slice(5, 7),
    year: t.slice(0, 4),
    h24: t.slice(11, 13),
    h12: String(h24 % 12 === 0 ? 12 : h24 % 12),
    minute: t.slice(14, 16),
    second: t.slice(17, 19),
    meridiem: h24 < 12 ? "a. m." : "p. m.",
  };
}

/**
 * «04/10/2026, 5:37 p. m.». A mano y no con Intl por lo mismo que
 * `describePaymentValidator`: el formato de `es-PE` cambia con la versión de ICU.
 */
export function limaDateTime(iso: string | null): string {
  if (!iso || Number.isNaN(Date.parse(iso))) return "—";
  const p = limaParts(iso);
  return `${p.day}/${p.month}/${p.year}, ${p.h12}:${p.minute} ${p.meridiem}`;
}

/** «04/10, 17:37:03»: la hora del movimiento, al segundo, como la trae el reporte. */
export function limaMovementTime(iso: string): string {
  if (Number.isNaN(Date.parse(iso))) return "—";
  const p = limaParts(iso);
  return `${p.day}/${p.month}, ${p.h24}:${p.minute}:${p.second}`;
}

/** «28/09 al 04/10». */
export function limaPeriod(from: string | null, to: string | null): string | null {
  if (!from || !to) return null;
  const a = limaParts(from);
  const b = limaParts(to);
  return `${a.day}/${a.month} al ${b.day}/${b.month}`;
}

function ms(iso: string | null): number {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isNaN(t) ? 0 : t;
}

/** Cuándo llegó el correo; sin ese dato, cuándo se procesó. */
function receivedMs(row: StatementImportRow): number {
  return ms(row.received_at) || ms(row.created_at);
}

export function buildStatementLog(input: {
  imports: StatementImportRow[];
  matches: StatementMatchRow[];
  movements: StatementMovementRow[];
  payments: StatementPaymentRow[];
  orders: StatementOrderRow[];
  truncated?: boolean;
}): StatementLog {
  const movements = new Map(input.movements.map((m) => [m.movement_key, m]));
  const payments = new Map(input.payments.map((p) => [p.id, p]));
  const orders = new Map(input.orders.map((o) => [o.order_id, o]));

  const byImport = new Map<string, StatementLogMatch[]>();
  for (const match of input.matches) {
    if (!match.import_id) continue;
    const m = movements.get(match.movement_key);
    if (!m) continue;
    const payment = payments.get(match.payment_id);
    const order = orders.get(match.order_id);
    const list = byImport.get(match.import_id) ?? [];
    list.push({
      paymentId: match.payment_id,
      orderId: match.order_id,
      orderName: order?.order_name ?? "Pedido sin código",
      customerName: order?.customer_name ?? null,
      kind: payment?.kind ?? "",
      payer: m.origin,
      amount: Number(m.amount),
      movementAt: m.occurred_at,
      rule: match.rule,
      laterStatus: laterStatusLabel(payment?.validation_status),
    });
    byImport.set(match.import_id, list);
  }

  // El primero que procesó cada correo, para marcar los reenvíos.
  const firstByMessage = new Map<string, string>();
  for (const row of [...input.imports].sort((a, b) => ms(a.created_at) - ms(b.created_at))) {
    if (!firstByMessage.has(row.message_id)) firstByMessage.set(row.message_id, row.id);
  }
  const createdById = new Map(input.imports.map((row) => [row.id, row.created_at]));

  // Por el CORREO, del más reciente al más antiguo: lo que importa es qué
  // reporte llegó último, no cuándo se reprocesó uno viejo. El mismo correo
  // procesado dos veces queda junto, primero la vez que contó.
  const entries = [...input.imports]
    .sort((a, b) => receivedMs(b) - receivedMs(a) || ms(a.created_at) - ms(b.created_at))
    .map((row): StatementLogEntry => {
      const report = record(row.report);
      const omitidos = record(report.omitidos);
      const skipped = Object.entries(omitidos)
        .map(([reason, count]) => ({ reason, label: statementSkipLabel(reason), count: Number(count) || 0 }))
        .filter((s) => s.count > 0)
        .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
      const errors = Array.isArray(report.errores)
        ? report.errores.filter((e): e is string => typeof e === "string")
        : [];
      if (!errors.length && row.error) errors.push(row.error);
      const first = firstByMessage.get(row.message_id);
      const matches = (byImport.get(row.id) ?? []).sort((a, b) => ms(b.movementAt) - ms(a.movementAt));
      return {
        id: row.id,
        fileName: row.file_name,
        receivedAt: row.received_at,
        processedAt: row.created_at,
        finished: Boolean(row.finished_at),
        periodFrom: row.period_from,
        periodTo: row.period_to,
        movements: row.movements,
        newMovements: row.new_movements,
        unreadable: row.unreadable,
        matches,
        skipped,
        leftPending: skipped.reduce((sum, s) => sum + s.count, 0),
        courierTimesFilled: Number(record(report.horas_courier).filled) || 0,
        errors,
        repeatOf: first && first !== row.id ? (createdById.get(first) ?? null) : null,
      };
    });

  return { entries, truncated: Boolean(input.truncated) };
}
