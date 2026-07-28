// Detección de comprobantes Yape repetidos. Puro + testeado.
//
// La regla del negocio es tajante: un mismo pago no puede registrarse dos veces,
// asociarse a dos pedidos, servir de adelanto y de diferencia a la vez, ni
// volver a subirse desde otra tienda, otro módulo u otro usuario.
//
// Tres capas, de más fuerte a más débil:
//
//   1. Nº DE OPERACIÓN — el identificador natural del pago. Índice único global
//      en 0049. Es además lo que atrapa una captura RECORTADA del mismo
//      comprobante: el recorte conserva el número, y lib/vision.ts lo lee de la
//      imagen. (Un hash perceptual detectaría el recorte por píxeles, pero
//      exigiría decodificar imágenes en el servidor y el nº de operación ya
//      cubre el caso real.)
//   2. HUELLA DEL ARCHIVO — sha256. Atrapa el mismo archivo renombrado. Índice
//      único global en 0049.
//   3. COINCIDENCIA DIFUSA — mismo monto, misma fecha y hora (± unos minutos) y
//      mismo pagador. No se puede expresar como constraint, así que se comprueba
//      aquí antes de insertar. Es la red para cuando el nº de operación no se
//      pudo leer de la imagen.
//
// Ante una posible duplicidad NO se registra en silencio: se bloquea, se muestra
// a qué pedido está ya asociado el pago y qué datos coinciden, y solo un
// administrador resuelve la incidencia.

/** Un pago ya registrado, tal como se lee de `order_payments`. */
export interface ExistingPayment {
  id: string;
  order_id: string;
  order_name?: string | null;
  kind: string;
  amount: number | null;
  operation_number: string | null;
  paid_at: string | null;
  payer_name: string | null;
  payer_phone: string | null;
  file_sha256: string | null;
  validation_status: string;
}

/** El comprobante que se intenta registrar. */
export interface CandidatePayment {
  order_id: string;
  kind: string;
  amount: number | null;
  operation_number: string | null;
  paid_at: string | null;
  payer_name: string | null;
  payer_phone: string | null;
  file_sha256: string | null;
}

export type DuplicateSignal =
  | "operation_number"
  | "file_sha256"
  | "amount"
  | "paid_at"
  | "payer";

export interface DuplicateVerdict {
  duplicate: boolean;
  /** Qué datos coinciden — se le muestran al operador tal cual. */
  signals: DuplicateSignal[];
  /** El pago ya registrado con el que choca. */
  conflict: ExistingPayment | null;
  /** true cuando el choque es contra el MISMO pedido (re-carga, no fraude). */
  sameOrder: boolean;
}

/** Ventana para considerar que dos movimientos son el mismo: 3 minutos. */
export const FUZZY_WINDOW_MS = 3 * 60 * 1000;

/** Un pago rechazado libera su sitio: pudo ser un error de carga. */
function isLive(payment: ExistingPayment): boolean {
  return payment.validation_status !== "rechazado";
}

/** Normaliza el nº de operación: solo dígitos y letras, en mayúsculas. */
export function normalizeOperationNumber(value: string | null | undefined): string | null {
  if (!value) return null;
  const cleaned = String(value).toUpperCase().replace(/[^A-Z0-9]/g, "");
  return cleaned || null;
}

/** Nombre comparable: minúsculas, sin acentos ni puntuación. */
function normalizeName(value: string | null | undefined): string | null {
  if (!value) return null;
  const cleaned = String(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  return cleaned || null;
}

function samePayer(a: CandidatePayment, b: ExistingPayment): boolean {
  if (a.payer_phone && b.payer_phone && a.payer_phone === b.payer_phone) return true;
  const an = normalizeName(a.payer_name);
  const bn = normalizeName(b.payer_name);
  return Boolean(an && bn && an === bn);
}

function sameInstant(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  const diff = Math.abs(Date.parse(a) - Date.parse(b));
  return Number.isFinite(diff) && diff <= FUZZY_WINDOW_MS;
}

function sameAmount(a: number | null, b: number | null): boolean {
  if (a === null || b === null) return false;
  // Los comprobantes están en soles con dos decimales; se compara en céntimos
  // para no depender de la aritmética de punto flotante.
  return Math.round(a * 100) === Math.round(b * 100);
}

/**
 * ¿Este comprobante ya está registrado? Devuelve además QUÉ datos coinciden,
 * porque el operador tiene que poder entender el bloqueo sin adivinar.
 *
 * `existing` son los pagos candidatos ya leídos de la base (por nº de operación,
 * por huella, o por monto y ventana de fecha) — este módulo no consulta nada.
 */
export function findDuplicate(
  candidate: CandidatePayment,
  existing: readonly ExistingPayment[],
): DuplicateVerdict {
  const none: DuplicateVerdict = { duplicate: false, signals: [], conflict: null, sameOrder: false };
  const live = existing.filter(isLive);
  if (!live.length) return none;

  const candidateOp = normalizeOperationNumber(candidate.operation_number);

  let best: { payment: ExistingPayment; signals: DuplicateSignal[] } | null = null;

  for (const payment of live) {
    const signals: DuplicateSignal[] = [];

    if (candidateOp && normalizeOperationNumber(payment.operation_number) === candidateOp) {
      signals.push("operation_number");
    }
    if (candidate.file_sha256 && payment.file_sha256 === candidate.file_sha256) {
      signals.push("file_sha256");
    }
    if (sameAmount(candidate.amount, payment.amount)) signals.push("amount");
    if (sameInstant(candidate.paid_at, payment.paid_at)) signals.push("paid_at");
    if (samePayer(candidate, payment)) signals.push("payer");

    // Un identificador fuerte basta por sí solo. La coincidencia difusa exige
    // las tres señales a la vez: monto, instante y pagador. Solo el monto —o
    // solo la hora— pasa continuamente entre pedidos distintos y bloquearía
    // pagos legítimos.
    const strong = signals.includes("operation_number") || signals.includes("file_sha256");
    const fuzzy =
      signals.includes("amount") && signals.includes("paid_at") && signals.includes("payer");
    if (!strong && !fuzzy) continue;

    // Gana el choque con más señales; a igualdad, el primero encontrado.
    if (!best || signals.length > best.signals.length) best = { payment, signals };
  }

  if (!best) return none;
  return {
    duplicate: true,
    signals: best.signals,
    conflict: best.payment,
    sameOrder: best.payment.order_id === candidate.order_id,
  };
}

/** Explicación en castellano del bloqueo, para mostrarla sin construirla en la UI. */
export function describeDuplicate(verdict: DuplicateVerdict): string {
  if (!verdict.duplicate || !verdict.conflict) return "";
  const labels: Record<DuplicateSignal, string> = {
    operation_number: "el nº de operación",
    file_sha256: "la imagen del comprobante",
    amount: "el monto",
    paid_at: "la fecha y hora",
    payer: "el pagador",
  };
  const matched = verdict.signals.map((s) => labels[s]).join(", ");
  const where = verdict.sameOrder
    ? "este mismo pedido"
    : (verdict.conflict.order_name ?? "otro pedido");
  const kind = verdict.conflict.kind === "adelanto" ? "adelanto" : "diferencia";
  return `Este comprobante ya está registrado como ${kind} en ${where}. Coincide ${matched}.`;
}
