// «Sale mañana» (owner, 07-11-2026; MOM §29.16): qué pedidos de Lima salen a
// reparto con Grupo GF un día dado y qué le falta a cada uno para que, cuando
// lleguen los motorizados, todo esté armado, ruteado y asignado.
//
// No inventa estados: el día y cada paso se leen de lo que Kapta ya guarda.
// - El DÍA de un pedido es, en este orden: el de su caja de Grupo GF de hoy o
//   de un día que viene; el acuerdo vigente de Repro Lima o su programa
//   (`gf_dispatch_programs`); el de la solicitud que tomó Grupo GF
//   (`logistics_requests.scheduled_for`); y, sin nada de eso, el que da el corte
//   de las 12:00 (`scheduledDay`), que no se guarda en ningún lado y se calcula
//   al mirar. Un día sin reparto (domingo) pasa al lunes.
// - Una caja de un día que ya pasó no fija el día (07-11-2026, revisión): el
//   motorizado se quedó con el «No entregado» o la caja nunca salió. Manda el
//   programa; el paquete se recibe en oficina y va a una caja nueva.
// - Un pedido SALE el día D si está en una caja de D, o si no tiene caja y D es
//   el primer día que todavía se prepara a partir de su día (`planOpenDay`): hoy
//   antes del corte, y si no, el próximo reparto. Lo que no salió antes sale en
//   la próxima ruta que se prepara, y solo ahí cuenta como atrasado.
// - Los PASOS son los del MOM: el rótulo (la salida con su QR), el armado de
//   Almacén (`listo_despacho`) y la caja del día con su motorizado. En Grupo GF
//   «ruteado» y «asignado» son un mismo hecho: no hay caja sin motorizado. Ya en
//   la caja, el cotejo de oficina y la recepción del motorizado.
//
// Pura: la usan Despacho del día (todas las tiendas que atiende Grupo GF) y
// Repro Lima (solo nuestras tiendas), cada una con sus propias filas.

/** Lo primero que le falta al pedido, en el orden en que se hace. */
export type PlanStep = "sin_rotulo" | "sin_armar" | "sin_caja" | "en_caja";

export const PLAN_STEPS: readonly PlanStep[] = ["sin_rotulo", "sin_armar", "sin_caja", "en_caja"];

export const PLAN_STEP_LABEL: Record<PlanStep, { label: string; hint: string }> = {
  sin_rotulo: {
    label: "Sin rótulo",
    hint: "Todavía no tiene su salida con QR: Por generar rótulo, o un reintento que sale con salida nueva. Al tomarlo en Grupo GF nace la salida; después se imprime el rótulo y Almacén la arma.",
  },
  sin_armar: {
    label: "Sin armar",
    hint: "Tiene rótulo pero Almacén todavía no escaneó la caja como armada. Puede estar ya en la caja de un motorizado: igual hay que armarla antes de que la recoja.",
  },
  sin_caja: {
    label: "Sin caja",
    hint: "Armado pero sin motorizado: no está en ninguna caja de ese día. Asígnalo desde la lista con el día de la caja en ese día.",
  },
  en_caja: {
    label: "En caja",
    hint: "Armado y en la caja de un motorizado para ese día: ruteado y asignado. Después, el cotejo de oficina y la recepción del motorizado.",
  },
};

function shift(day: string, delta: number): string {
  return new Date(Date.parse(`${day}T12:00:00Z`) + delta * 86_400_000).toISOString().slice(0, 10);
}

/**
 * ¿Grupo GF reparte ese día? De lunes a sábado: en las 14 semanas hasta el
 * 07-11-2026 hubo cajas el domingo solo 3 veces, con 0 a 4 paquetes.
 */
export function isDeliveryDay(day: string): boolean {
  return new Date(`${day.slice(0, 10)}T12:00:00Z`).getUTCDay() !== 0;
}

/** Ese día si hay reparto; si cae domingo, el lunes. */
export function deliveryDayOnOrAfter(day: string): string {
  const d = day.slice(0, 10);
  return isDeliveryDay(d) ? d : shift(d, 1);
}

/** El próximo día de reparto de Grupo GF después de `today`: el siguiente, y si cae domingo, el lunes. */
export function nextDeliveryDay(today: string): string {
  return deliveryDayOnOrAfter(shift(today, 1));
}

/**
 * El primer día que todavía se prepara: hoy, si hay reparto y no pasó el corte;
 * si no, el próximo reparto. Pasado el corte los motorizados ya se fueron; el
 * domingo no hay reparto. Es también el día en que se abre la tarjeta.
 */
export function planOpenDay(today: string, afterCutoff: boolean): string {
  return isDeliveryDay(today) && !afterCutoff ? today : nextDeliveryDay(today);
}

/** ¿La caja es de hoy o de un día que viene? La de un día que pasó no fija el día. */
export function isCurrentBoxDay(boxDay: string, today: string): boolean {
  return boxDay.slice(0, 10) >= today;
}

/** Lo que el plan necesita de un pedido; cada pantalla lo arma con sus filas. */
export interface PlanCandidate {
  orderId: string;
  /** El día que le toca sin caja: programa o acuerdo, solicitud tomada o corte. */
  day: string | null;
  /** Su caja activa de Grupo GF, si ya está en una. */
  box: PlanBox | null;
  /** Tiene su salida con QR (rótulo). */
  labeled: boolean;
  /** Almacén la escaneó armada (`listo_despacho`). */
  armed: boolean;
  /**
   * Sigue en la caja de un día que pasó y el motorizado se la llevó («No
   * entregado»): se recibe en oficina antes de ir a una caja nueva.
   */
  awaitingOffice?: boolean;
}

export interface PlanBox {
  day: string;
  riderName: string | null;
  /** Oficina la cotejó en la caja. */
  officeChecked: boolean;
  /** El motorizado la recibió (se la llevó). */
  pickedUp: boolean;
}

/** El día en que sale sin caja: el suyo (sin domingos), o el primero que todavía se prepara. */
export function planDayOf(candidate: PlanCandidate, openDay: string): string | null {
  if (candidate.box || !candidate.day) return null;
  const day = deliveryDayOnOrAfter(candidate.day);
  return day < openDay ? openDay : day;
}

/**
 * ¿Sale el día `planDay`? En una caja, solo si es de ese día; sin caja, si ese
 * es el día en que le toca salir (`planDayOf`): lo de antes del primer día que
 * se prepara (`openDay`) sale ese día, no uno posterior.
 */
export function inPlan(candidate: PlanCandidate, planDay: string, openDay: string): boolean {
  if (candidate.box) return candidate.box.day.slice(0, 10) === planDay;
  return planDayOf(candidate, openDay) === planDay;
}

/** Lo primero que le falta. En la caja pero sin armar cuenta como «Sin armar». */
export function planStep(candidate: PlanCandidate): PlanStep {
  if (!candidate.labeled) return "sin_rotulo";
  if (!candidate.armed) return "sin_armar";
  if (!candidate.box) return "sin_caja";
  return "en_caja";
}

/**
 * El día que debía salir y no salió: sin caja y anterior al primer día que
 * todavía se prepara. Antes del corte, lo de hoy aún sale hoy; un domingo no
 * es un día perdido.
 */
export function planOverdueSince(candidate: PlanCandidate, openDay: string): string | null {
  if (candidate.box || !candidate.day) return null;
  const day = deliveryDayOnOrAfter(candidate.day);
  return day < openDay ? day : null;
}

export interface PlanItem {
  orderId: string;
  step: PlanStep;
  riderName: string | null;
  officeChecked: boolean;
  pickedUp: boolean;
  /** Debía salir este día (anterior al primero que se prepara); null si no. */
  overdueSince: string | null;
  /** Sigue con el motorizado en una caja anterior: se recibe en oficina. */
  awaitingOffice: boolean;
}

/**
 * Lo que sale ese día, un pedido una vez: si la misma orden llega en dos filas
 * (la caja y la cola), cuenta la de la caja.
 */
export function planItems(candidates: readonly PlanCandidate[], planDay: string, openDay: string): PlanItem[] {
  const byOrder = new Map<string, PlanCandidate>();
  for (const c of candidates) {
    if (!inPlan(c, planDay, openDay)) continue;
    const seen = byOrder.get(c.orderId);
    if (!seen || (!seen.box && c.box)) byOrder.set(c.orderId, c);
  }
  return [...byOrder.values()].map((c) => ({
    orderId: c.orderId,
    step: planStep(c),
    riderName: c.box?.riderName ?? null,
    officeChecked: Boolean(c.box?.officeChecked),
    pickedUp: Boolean(c.box?.pickedUp),
    overdueSince: planOverdueSince(c, openDay),
    awaitingOffice: !c.box && Boolean(c.awaitingOffice),
  }));
}

export interface PlanSummary {
  total: number;
  steps: Record<PlanStep, number>;
  /** De los que están en caja: cotejados por oficina y recibidos por el motorizado. */
  officeChecked: number;
  pickedUp: number;
  /** Los que debían salir un día anterior al primero que se prepara. */
  overdue: number;
  /** Sin caja y todavía con el motorizado en una caja anterior. */
  awaitingOffice: number;
  /** Por motorizado: cuántos tiene en su caja de ese día y cuántos le faltan armar. */
  riders: Array<{ name: string; count: number; unarmed: number }>;
}

export function planSummary(items: readonly PlanItem[]): PlanSummary {
  const steps = Object.fromEntries(PLAN_STEPS.map((s) => [s, 0])) as Record<PlanStep, number>;
  const riders = new Map<string, { count: number; unarmed: number }>();
  let officeChecked = 0;
  let pickedUp = 0;
  let overdue = 0;
  let awaitingOffice = 0;
  for (const item of items) {
    steps[item.step] += 1;
    if (item.overdueSince) overdue += 1;
    if (item.awaitingOffice) awaitingOffice += 1;
    if (item.riderName) {
      const r = riders.get(item.riderName) ?? { count: 0, unarmed: 0 };
      r.count += 1;
      if (item.step === "sin_armar") r.unarmed += 1;
      riders.set(item.riderName, r);
      if (item.officeChecked) officeChecked += 1;
      if (item.pickedUp) pickedUp += 1;
    }
  }
  return {
    total: items.length,
    steps,
    officeChecked,
    pickedUp,
    overdue,
    awaitingOffice,
    riders: [...riders.entries()].map(([name, r]) => ({ name, ...r })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, "es")),
  };
}

/**
 * La línea de lo que falta, para decirla sin colores: «Faltan 40 sin rótulo,
 * 5 sin armar y 97 sin caja», «Falta 1 sin caja» o «Todo armado y en caja».
 */
export function planMissingText(summary: PlanSummary): string {
  if (!summary.total) return "Nada que sacar ese día.";
  const parts = (["sin_rotulo", "sin_armar", "sin_caja"] as const)
    .filter((s) => summary.steps[s] > 0)
    .map((s) => `${summary.steps[s].toLocaleString("es-PE")} ${PLAN_STEP_LABEL[s].label.toLowerCase()}`);
  if (!parts.length) return "Todo armado y en caja.";
  const list = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(", ")} y ${parts[parts.length - 1]}`;
  const one = parts.length === 1 && summary.total - summary.steps.en_caja === 1;
  return `${one ? "Falta" : "Faltan"} ${list}.`;
}
