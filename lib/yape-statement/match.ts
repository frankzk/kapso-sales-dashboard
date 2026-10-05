// Cruce de los comprobantes por validar con el estado de cuenta de Yape.
// MOM §16.2. Puro: la base la lee y la escribe lib/yape-statement/ingest.ts.
//
// EL REPORTE NO TRAE Nº DE OPERACIÓN. Un comprobante y un movimiento son el
// mismo pago solo si coinciden A LA VEZ:
//
//   1. el MONTO, al céntimo;
//   2. el MINUTO: la constancia imprime la hora al minuto y el reporte al
//      segundo, así que el movimiento cae dentro de ese minuto. Un Yape directo
//      lo sella la misma Yape y cae exacto; lo que viene de otra app (Plin,
//      BCP, Prex…) trae la hora del reloj de esa app y se le da un minuto de
//      holgura a cada lado;
//   3. QUIÉN PAGÓ: en un adelanto o una diferencia, el pagador del reporte es la
//      clienta del pedido («Benito Cac*» ↔ Benito Cachique Puga). En el cobro de
//      un courier paga el motorizado, así que el nombre no dice nada; ahí se
//      exige que el canal del reporte sea el de la constancia (un Yape sale
//      como Yape directo, un Plin o un BBVA como «PLIN - …», un BCP como
//      «BCP - …»);
//   4. y que sea INEQUÍVOCO: un solo movimiento encaja con el comprobante, y
//      ningún otro pago vivo —validado o no, de cualquier pedido— encaja con
//      ese movimiento.
//
// Más dos imposibles que se descartan: un movimiento posterior a la carga del
// comprobante (nadie sube la constancia de un pago que aún no hizo) y uno que
// ya concilió otro comprobante.
//
// LA HORA LEÍDA 12 H ANTES. Hasta el 04-10-2026 el lector perdía el «p. m.» de
// Yape («02:15 p. m.» se guardaba como 02:15). Para no dejar esos comprobantes
// fuera, a uno con hora de mañana se le prueba también la misma hora por la
// tarde. No afloja nada: lo que sigue exigiendo es el mismo minuto, el mismo
// monto y el nombre de la clienta, y que el pago sea anterior a la carga.

/** Un comprobante en la cola, con lo necesario para cruzarlo. */
export interface StatementPayment {
  id: string;
  orderName: string | null;
  kind: string;
  amount: number | null;
  /** ISO. La hora de la constancia, al minuto. */
  paidAt: string | null;
  registeredAt: string;
  status: string;
  operationNumber: string | null;
  /** Quién transcribió a mano el nº de operación (cuatro ojos). */
  operationTypedBy: string | null;
  customerName: string | null;
  payerName: string | null;
  /** Solo cobro de courier: la app que emitió la constancia. */
  courierMethod: string | null;
  /** Solo cobro de courier: la constancia dice que el dinero fue a un Yape. */
  courierToYape: boolean | null;
}

export interface MatchableMovement {
  key: string;
  channel: string;
  payerName: string;
  origin: string;
  amount: number;
  occurredAt: string;
}

export type MatchRule = "minuto_y_clienta" | "minuto_y_clienta_pm" | "minuto_y_canal";

export interface StatementMatch {
  paymentId: string;
  movementKey: string;
  rule: MatchRule;
  /** Segundos entre el inicio del minuto de la constancia y el movimiento. */
  deltaSeconds: number;
}

export type SkipReason =
  | "no_pendiente"
  | "sin_monto"
  | "sin_hora"
  | "sin_operacion"
  | "operacion_transcrita"
  | "no_fue_a_yape"
  | "sin_movimiento"
  | "varios_movimientos"
  | "movimiento_disputado"
  | "ya_conciliado";

export interface StatementSkip {
  paymentId: string;
  reason: SkipReason;
  detail?: string;
}

export const COURIER_KIND = "cobro_courier";
const CUSTOMER_KINDS = new Set(["adelanto", "diferencia", "total"]);

const MINUTE = 60_000;
const HOUR = 3_600_000;
const LIMA_OFFSET = 5 * HOUR;
/** Reloj de la app que subió la constancia frente al del servidor. */
const UPLOAD_SKEW = 2 * MINUTE;

/**
 * La cuenta del reporte, comparable: solo letras y dígitos. «GRUPO GF  S.A.C.»
 * y «Grupo GF S.A.C.» son la misma cuenta.
 */
export function statementAccountKey(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function tokens(s: string | null | undefined): string[] {
  return (s ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z ]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * ¿El pagador del reporte es esta persona?
 *
 * Yape recorta: «Benito Cac*» es el nombre y las tres primeras letras del
 * primer apellido. Encaja si el nombre es uno de los de la persona y algún
 * OTRO de sus nombres empieza por esas letras. Las demás apps traen el nombre
 * completo («BCP - QUISPE ARELA JUAN MARTIN»): encaja con dos palabras suyas,
 * en cualquier orden, porque los bancos ponen los apellidos delante.
 */
export function payerIsPerson(payerName: string, channel: string, person: string | null): boolean {
  const who = tokens(person);
  if (!who.length) return false;
  if (channel === "YAPE" && payerName.trim().endsWith("*")) {
    const shown = tokens(payerName);
    if (shown.length < 2) return false;
    const prefix = shown[shown.length - 1]!;
    const names = shown.slice(0, -1);
    if (!names.every((n) => who.includes(n))) return false;
    return who.some((w) => !names.includes(w) && w.startsWith(prefix));
  }
  const shown = tokens(payerName);
  const hits = shown.filter(
    (s) =>
      who.includes(s) ||
      (s.length >= 4 && who.some((w) => w.length >= 4 && (w.startsWith(s) || s.startsWith(w)))),
  );
  return new Set(hits).size >= 2;
}

/** ¿El canal del reporte es el de la app que emitió la constancia del courier? */
export function channelFitsCourier(method: string | null, channel: string): boolean {
  switch (method) {
    case "yape":
      return channel === "YAPE";
    case "bcp":
      return channel === "BCP";
    // Plin entra como «PLIN - …», venga del banco que venga (BBVA, Interbank,
    // Scotiabank). «otro» es Prex, BBVA y compañía: nunca un Yape directo.
    case "plin":
    case "otro":
      return channel !== "YAPE";
    default:
      return false;
  }
}

/** Las horas en que pudo ocurrir el pago según la constancia. */
function voucherMinutes(p: StatementPayment): { start: number; pm: boolean }[] {
  const start = Date.parse(p.paidAt!);
  const out = [{ start, pm: false }];
  const limaHour = new Date(start - LIMA_OFFSET).getUTCHours();
  if (CUSTOMER_KINDS.has(p.kind) && limaHour < 12) out.push({ start: start + 12 * HOUR, pm: true });
  return out;
}

/** ¿Cae el movimiento dentro del minuto de la constancia? */
function inMinute(m: MatchableMovement, start: number): number | null {
  const delta = Date.parse(m.occurredAt) - start;
  const ok = m.channel === "YAPE" ? delta >= 0 && delta < MINUTE : delta >= -MINUTE && delta < 2 * MINUTE;
  return ok ? Math.round(delta / 1000) : null;
}

/** ¿Este movimiento puede ser el pago de este comprobante? Devuelve cómo. */
function fits(p: StatementPayment, m: MatchableMovement): { rule: MatchRule; delta: number } | null {
  if (p.amount == null || !p.paidAt) return null;
  if (Math.round(p.amount * 100) !== Math.round(m.amount * 100)) return null;
  // Nadie sube la constancia de un pago que todavía no hizo.
  if (Date.parse(m.occurredAt) > Date.parse(p.registeredAt) + UPLOAD_SKEW) return null;
  for (const { start, pm } of voucherMinutes(p)) {
    const delta = inMinute(m, start);
    if (delta === null) continue;
    if (p.kind === COURIER_KIND) {
      if (channelFitsCourier(p.courierMethod, m.channel)) return { rule: "minuto_y_canal", delta };
      continue;
    }
    const who = [p.customerName, p.payerName];
    if (who.some((name) => payerIsPerson(m.payerName, m.channel, name))) {
      return { rule: pm ? "minuto_y_clienta_pm" : "minuto_y_clienta", delta };
    }
  }
  return null;
}

/** Por qué un comprobante no entra al cruce, antes de mirar el reporte. */
function ineligible(p: StatementPayment): StatementSkip | null {
  const skip = (reason: SkipReason): StatementSkip => ({ paymentId: p.id, reason });
  if (p.status !== "pendiente_revision") return skip("no_pendiente");
  if (p.amount == null) return skip("sin_monto");
  if (!p.paidAt) return skip("sin_hora");
  // Validar exige el nº de operación: sin él, el índice único no impide que el
  // mismo Yape cobre otro pedido.
  if (!p.operationNumber) return skip("sin_operacion");
  // Cuatro ojos: si una persona transcribió el nº, lo da por bueno otra
  // persona. El reporte no trae el nº, así que no puede ser ese segundo par.
  if (p.operationTypedBy) return skip("operacion_transcrita");
  if (p.kind === COURIER_KIND) {
    const toYape = p.courierToYape === true || p.courierMethod === "yape" || p.courierMethod === "plin";
    if (!toYape) return skip("no_fue_a_yape");
  } else if (!CUSTOMER_KINDS.has(p.kind)) {
    return skip("no_pendiente");
  }
  return null;
}

/**
 * Decide qué comprobantes concilian con qué movimiento.
 *
 * @param pending  los comprobantes a decidir
 * @param live     TODOS los pagos vivos que podrían reclamar un movimiento
 *                 (validados incluidos); puede contener a los de `pending`
 * @param linked   movimientos y pagos que ya conciliaron en una pasada anterior
 */
export function matchStatement(
  movements: MatchableMovement[],
  pending: StatementPayment[],
  live: StatementPayment[],
  linked: { movementKeys: ReadonlySet<string>; paymentIds: ReadonlySet<string> },
): { matches: StatementMatch[]; skipped: StatementSkip[] } {
  const matches: StatementMatch[] = [];
  const skipped: StatementSkip[] = [];
  const free = movements.filter((m) => !linked.movementKeys.has(m.key));
  const byAmount = new Map<number, MatchableMovement[]>();
  for (const m of free) {
    const cents = Math.round(m.amount * 100);
    byAmount.set(cents, [...(byAmount.get(cents) ?? []), m]);
  }
  const claimants = live.filter((q) => q.status !== "rechazado" && !linked.paymentIds.has(q.id));
  const used = new Set<string>();

  for (const p of pending) {
    if (linked.paymentIds.has(p.id)) {
      skipped.push({ paymentId: p.id, reason: "ya_conciliado" });
      continue;
    }
    const why = ineligible(p);
    if (why) {
      skipped.push(why);
      continue;
    }
    const same = byAmount.get(Math.round(p.amount! * 100)) ?? [];
    const found = same
      .map((m) => ({ m, fit: fits(p, m) }))
      .filter((x): x is { m: MatchableMovement; fit: { rule: MatchRule; delta: number } } => x.fit !== null);
    if (!found.length) {
      skipped.push({ paymentId: p.id, reason: "sin_movimiento" });
      continue;
    }
    if (found.length > 1) {
      skipped.push({
        paymentId: p.id,
        reason: "varios_movimientos",
        detail: found.map((x) => x.m.origin).join(", "),
      });
      continue;
    }
    const { m, fit } = found[0]!;
    // El movimiento tiene que ser SOLO de este comprobante. Si otro pago vivo
    // también encaja —aunque ya esté validado a mano—, no hay forma de saber de
    // cuál es, y adivinar es justo lo que este cruce no hace.
    const rivals = claimants.filter((q) => q.id !== p.id && fits(q, m) !== null);
    if (rivals.length || used.has(m.key)) {
      skipped.push({
        paymentId: p.id,
        reason: "movimiento_disputado",
        detail: rivals.map((q) => q.orderName ?? q.id).join(", ") || undefined,
      });
      continue;
    }
    used.add(m.key);
    matches.push({ paymentId: p.id, movementKey: m.key, rule: fit.rule, deltaSeconds: fit.delta });
  }
  return { matches, skipped };
}
