// «Lima trabados» (MOM §9.6, 08-11-2026): los pedidos de Lima que se quedaron
// quietos en Preparación, Por despachar o En curso más tiempo del que deberían.
//
// Es una LECTURA de lo que la cola amplia de Repro Lima ya trae
// (`LimaPendingOrder`, lib/repro-lima-pending-access.ts): la etapa y su
// antigüedad (`order_master.macro_since`), el programa, la caja y la solicitud
// de Grupo GF, la guía de Aliclik que espera recojo y lo que dicen las salidas
// vivas (`ops`). No escribe nada, no cambia etapas ni inventa estados: dice por
// qué está trabado, qué toca y de quién es.
//
// Fuera, a propósito:
//   * Por reprogramar Lima: es la cola de Repro Lima (§9.5), con sus tarjetas.
//   * Disponible para recojo y Pendiente de pago de diferencia: Agencia (§12).
//   * Gestión Reproprovincia y Salida Swayp programada: no son de Lima o ya
//     tienen día.
//   * Por cerrar y Finalizado: liquidación y cierre (owner, 08-11-2026).
//
// El reloj cuenta DÍAS DE REPARTO COMPLETOS (lunes a sábado; el domingo no hay
// reparto, `isDeliveryDay`): los que pasaron enteros entre el día en que el
// pedido entró a su subetapa —o el día en que debía salir, si era después— y
// hoy, sin contar ninguno de los dos. Armado el viernes, el sábado debía salir:
// el domingo ya lleva uno; armado el sábado, recién el martes. Pura.
import { isDeliveryDay } from "@/lib/dispatch-plan";
import { limaDay, programDayLabel } from "@/lib/dispatch-day";
import { courierDisplayName } from "@/lib/dispatched-with";
import type { LimaPendingOrder } from "@/lib/repro-lima-pending";

export type LimaStuckOwner = "almacen" | "operaciones" | "asesora";

export const LIMA_STUCK_OWNER_LABEL: Record<LimaStuckOwner, string> = {
  almacen: "Almacén",
  operaciones: "Operaciones",
  asesora: "Asesora",
};

export type LimaStuckReason =
  // Por despachar
  | "armado_sin_caja"
  | "tomado_sin_caja"
  | "caja_vencida"
  | "sin_condiciones_gf"
  | "courier_no_recogio"
  // En curso
  | "reparto_sin_resultado"
  | "courier_sin_resultado"
  | "novedad_con_clienta"
  | "entregado_sin_cierre"
  | "retorno_sin_recibir"
  // Preparación
  | "sin_rotulo"
  | "rotulo_sin_armar"
  | "incidencia_sin_resolver"
  | "sin_rotulo_antiguo";

export interface LimaStuckRule {
  reason: LimaStuckReason;
  stage: "preparacion" | "por_despachar" | "en_curso";
  label: string;
  /** Días de reparto completos a partir de los cuales está trabado. */
  threshold: number;
  owner: LimaStuckOwner;
  /** Qué toca, dicho para quien lo hace. */
  action: string;
  /** La tarjeta: qué cuenta y desde cuándo. */
  hint: string;
}

/**
 * Las reglas, en el orden de las tarjetas: Por despachar y En curso primero
 * (owner, 08-11-2026: «son los que más importan»), Preparación después. Los
 * umbrales salen de lo medido en producción el 08-11-2026 (MOM §9.6).
 */
export const LIMA_STUCK_RULES: readonly LimaStuckRule[] = [
  {
    reason: "armado_sin_caja", stage: "por_despachar", threshold: 1, owner: "operaciones",
    label: "Armado sin caja de reparto",
    action: "Ponerlo en la caja del próximo reparto en Despacho del día.",
    hint: "Por despachar: armado, sin solicitud de Grupo GF ni caja, y ya pasó un día de reparto entero.",
  },
  {
    reason: "tomado_sin_caja", stage: "por_despachar", threshold: 1, owner: "operaciones",
    label: "Grupo GF lo tomó y no lo puso en caja",
    action: "Pedir a Grupo GF que lo asigne a una caja o que libere la solicitud.",
    hint: "Por despachar: Grupo GF aceptó la solicitud para un día que ya pasó y el pedido no está en ninguna caja.",
  },
  {
    reason: "caja_vencida", stage: "por_despachar", threshold: 1, owner: "operaciones",
    label: "En una caja de un día que pasó",
    action: "Retirarlo de la caja vieja y asignarlo al próximo reparto.",
    hint: "Por despachar: está en la caja de un día que ya pasó y el motorizado no lo recogió.",
  },
  {
    reason: "sin_condiciones_gf", stage: "por_despachar", threshold: 1, owner: "operaciones",
    label: "Grupo GF no lo puede llevar",
    action: "Elegir otro courier (Aliclik) desde la ficha.",
    hint: "Por despachar: el distrito no tiene convenio, tarifa o está en pausa en Grupo GF y no tiene otra guía viva.",
  },
  {
    reason: "courier_no_recogio", stage: "por_despachar", threshold: 1, owner: "operaciones",
    label: "Guía creada y el courier no lo recogió",
    action: "Coordinar el recojo con el courier o crear la guía con otro.",
    hint: "Por despachar: la guía de otro courier espera su recojo y su día ya pasó.",
  },
  {
    reason: "reparto_sin_resultado", stage: "en_curso", threshold: 2, owner: "operaciones",
    label: "En reparto sin resultado del motorizado",
    action: "Pedir al motorizado el resultado de la parada o recibir el paquete en oficina.",
    hint: "En curso con Grupo GF: el motorizado lo recogió y lleva dos días de reparto enteros sin reportar la parada.",
  },
  {
    reason: "entregado_sin_cierre", stage: "en_curso", threshold: 1, owner: "operaciones",
    label: "El courier dice entregado y Kapta no cerró",
    action: "Validar el cobro del courier (Tanders: cargar su constancia en Validar pagos).",
    hint: "En curso: el courier reporta la entrega, pero falta la constancia o la validación que lo pasa a Por cerrar.",
  },
  {
    reason: "novedad_con_clienta", stage: "en_curso", threshold: 1, owner: "asesora",
    label: "El courier reporta una novedad con la clienta",
    action: "Llamar a la clienta y acordar la entrega o la devolución.",
    hint: "En curso: el último reporte del courier es de la clienta (no contesta, ausente, ya no lo quiere, rechazo o dirección) y no cambió en un día de reparto.",
  },
  {
    reason: "courier_sin_resultado", stage: "en_curso", threshold: 3, owner: "operaciones",
    label: "Sin resultado del courier",
    action: "Pedir al courier el estado de la guía y dónde está el paquete.",
    hint: "En curso con un courier externo: tres días de reparto enteros sin entrega ni fallo (Tanders, uno: su paquete queda libre al día hábil siguiente).",
  },
  {
    reason: "retorno_sin_recibir", stage: "en_curso", threshold: 3, owner: "almacen",
    label: "Retorno sin llegar al almacén",
    action: "Recibir la devolución en Almacén → Devoluciones o reclamarla al courier.",
    hint: "En curso: el courier lo está devolviendo y lleva tres días de reparto enteros sin llegar.",
  },
  {
    reason: "sin_rotulo", stage: "preparacion", threshold: 1, owner: "operaciones",
    label: "Sin rótulo",
    action: "Elegir la ruta y generar el rótulo en la ficha.",
    hint: "Preparación: sin guía ni rótulo, sin envío programado a futuro, y ya pasó un día de reparto entero.",
  },
  {
    reason: "rotulo_sin_armar", stage: "preparacion", threshold: 1, owner: "almacen",
    label: "Rótulo o guía creada y caja sin escanear",
    action: "Armar la caja y escanearla en Almacén.",
    hint: "Preparación · Por armar: tiene rótulo o guía y la caja no se escaneó en un día de reparto entero.",
  },
  {
    reason: "incidencia_sin_resolver", stage: "preparacion", threshold: 1, owner: "almacen",
    label: "Incidencia de preparación sin resolver",
    action: "Resolver la incidencia en Almacén (stock, producto o caja).",
    hint: "Preparación · Incidencia: lleva un día de reparto entero sin resolverse.",
  },
  {
    reason: "sin_rotulo_antiguo", stage: "preparacion", threshold: 1, owner: "asesora",
    label: "Sin rótulo hace más de 30 días",
    action: "Confirmar con la clienta si la venta sigue; si no, anularla en la tienda.",
    hint: "Preparación · Por generar rótulo con más de 30 días desde la compra: antes de despachar hay que saber si sigue.",
  },
];

const RULE = new Map(LIMA_STUCK_RULES.map((rule) => [rule.reason, rule]));

export function limaStuckRule(reason: LimaStuckReason): LimaStuckRule {
  return RULE.get(reason)!;
}

/** Más de esto desde la compra, un pedido sin rótulo se pregunta antes de armarlo (como «Antiguo por revisar»). */
export const STUCK_OLD_ORDER_DAYS = 30;
/** Tanders: el paquete que recolectó queda libre el día hábil siguiente (§9, `tandersReleaseCutoff`). */
const TANDERS_THRESHOLD = 1;

/** Subetapas de En curso que tienen su propia cola o no son de este flujo. */
const EN_CURSO_OUT = new Set(["por_reprogramar_lima", "disponible_para_recojo", "pendiente_pago_diferencia", "gestion_reproprovincia", "salida_swayp_programada"]);
const EN_CURSO_RETURN = new Set(["en_retorno", "retorno_solicitado"]);
const POR_DESPACHAR_IN_BOX = new Set(["asignado_a_ruta", "en_cotejo", "cotejo_incompleto", "listo_para_recojo"]);
/** Las salidas que son de Grupo GF: la «por definir» que rellena y la propia. */
const GF_COURIERS = new Set(["propio", "por_definir"]);
/** Lo que el courier reporta de la clienta, no del paquete. «Reprogramado» no: el courier vuelve a intentarlo. */
const CUSTOMER_NOVELTY = /NOT_RESPOND|REFUSED|REJECTED|no contesta|ausente|no desea|ya no (lo )?quiere|rechaz|direcci[oó]n (incorrecta|errada|incompleta)/i;

export interface LimaStuckItem {
  orderId: string;
  reason: LimaStuckReason;
  owner: LimaStuckOwner;
  /** Días de calendario desde el día que ancla el reloj. */
  daysStuck: number;
  /** Días de reparto completos desde ese día (lo que se compara con el umbral). */
  deliveryDays: number;
  /** El día que ancla el reloj (`YYYY-MM-DD` de Lima). */
  since: string;
  /** El courier, con su nombre («Grupo GF», «Aliclik»…), o null. */
  courier: string | null;
  /** El dato que lo explica: «Alexis lo lleva desde el vie 06/11», «Último estado: PICKED». */
  detail: string | null;
}

function shiftDay(day: string, delta: number): string {
  return new Date(Date.parse(`${day}T12:00:00Z`) + delta * 86_400_000).toISOString().slice(0, 10);
}

/** Días de calendario de `from` a `to` (días de Lima, `YYYY-MM-DD`). */
export function calendarDaysBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T12:00:00Z`);
  const b = Date.parse(`${to}T12:00:00Z`);
  return Number.isFinite(a) && Number.isFinite(b) ? Math.max(0, Math.round((b - a) / 86_400_000)) : 0;
}

/**
 * Los días de reparto (lunes a sábado) que pasaron ENTEROS entre `from` y
 * `today`, sin contar ninguno de los dos. Viernes → domingo: 1 (el sábado);
 * sábado → martes: 1 (el lunes); el mismo día: 0.
 */
export function fullDeliveryDaysBetween(from: string, today: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(today) || from >= today) return 0;
  let count = 0;
  for (let day = shiftDay(from, 1); day < today; day = shiftDay(day, 1)) if (isDeliveryDay(day)) count += 1;
  return count;
}

/** El día en que debía salir y todavía no salió, si ya llegó: el programa, el envío programado, la solicitud o el recojo. */
function plannedDay(row: LimaPendingOrder): string | null {
  const days = [row.programmedFor, row.scheduledOn, row.gf?.requestDay, row.courierPickup?.date]
    .map((d) => d?.slice(0, 10))
    .filter((d): d is string => Boolean(d));
  return days.length ? days.sort().at(-1)! : null;
}

function riderDetail(row: LimaPendingOrder): string | null {
  const box = row.ops?.lastGfBox;
  if (!box) return null;
  return `${box.riderName ?? "El motorizado"} lo lleva desde el ${programDayLabel(box.day)}`;
}

function reportedDetail(row: LimaPendingOrder): string | null {
  const status = row.ops?.reportedStatus?.trim();
  return status ? `Último estado del courier: ${status}` : "El courier no reportó ningún estado.";
}

/** El courier de la fila: el de la salida viva que no es de Grupo GF, o el del Master. */
function rowCourier(row: LimaPendingOrder): string | null {
  const external = row.ops?.liveCouriers.find((c) => !GF_COURIERS.has(c));
  // En curso, la «por definir» ya la lleva un motorizado de Grupo GF; antes de salir, todavía no tiene courier.
  // Con su detalle si es el courier del Master («Grupo GF · Alexis», «Aliclik · AUTOECOM»).
  const detail = row.courierDetail?.trim() || null;
  if (!external && row.stage === "en_curso" && isGfOutput(row)) {
    return detail && row.courier === "propio" ? `${courierDisplayName("propio")} · ${detail}` : courierDisplayName("propio");
  }
  const code = external ?? row.courier;
  if (!code) return null;
  return detail && code === row.courier ? `${courierDisplayName(code)} · ${detail}` : courierDisplayName(code);
}

function isGfOutput(row: LimaPendingOrder): boolean {
  const live = row.ops?.liveCouriers ?? [];
  if (live.length) return live.every((c) => GF_COURIERS.has(c));
  return GF_COURIERS.has(row.courier ?? "");
}

/**
 * Por qué está trabado el pedido, o null si no lo está. `today` es el día de
 * Lima (`limaClock(now).day`). La regla, el umbral y el responsable salen de
 * `LIMA_STUCK_RULES`.
 */
export function limaStuck(row: LimaPendingOrder, today: string): LimaStuckItem | null {
  const sinceDay = limaDay(row.macroSince ?? row.createdAt);
  if (!sinceDay) return null;
  const planned = plannedDay(row);
  const preDispatch = row.stage === "preparacion" || row.stage === "por_despachar";
  // Con un día a futuro (programa, envío programado, solicitud o recojo) o en
  // una caja de hoy o de un día que viene, todavía no debía haber salido.
  if (preDispatch && ((planned && planned >= today) || row.gf?.box || (row.ops?.lastGfBox && row.ops.lastGfBox.day >= today))) return null;
  // Si debía salir un día que ya pasó y es posterior a su subetapa, el reloj corre desde ese día.
  const anchor = preDispatch && planned && planned > sinceDay ? planned : sinceDay;
  const deliveryDays = fullDeliveryDaysBetween(anchor, today);
  const make = (reason: LimaStuckReason, detail: string | null, threshold = limaStuckRule(reason).threshold): LimaStuckItem | null =>
    deliveryDays >= threshold
      ? { orderId: row.orderId, reason, owner: limaStuckRule(reason).owner, daysStuck: calendarDaysBetween(anchor, today), deliveryDays, since: anchor, courier: rowCourier(row), detail }
      : null;
  const plannedNote = planned && planned < today ? `Debía salir el ${programDayLabel(planned)}.` : null;

  if (row.stage === "preparacion") {
    if (row.substage === "por_generar_rotulo") {
      const created = limaDay(row.createdAt);
      if (created && calendarDaysBetween(created, today) > STUCK_OLD_ORDER_DAYS) {
        return make("sin_rotulo_antiguo", `Compra del ${programDayLabel(created)}.`);
      }
      return make("sin_rotulo", plannedNote);
    }
    if (row.substage === "por_armar") return make("rotulo_sin_armar", plannedNote ?? (row.courierPickup ? `Guía de ${courierDisplayName(row.courierPickup.courier)} lista para recojo.` : null));
    if (row.substage === "incidencia_preparacion") return make("incidencia_sin_resolver", null);
    return null;
  }

  if (row.stage === "por_despachar") {
    const external = row.ops?.liveCouriers.find((c) => !GF_COURIERS.has(c));
    if (row.courierPickup || external) {
      const who = courierDisplayName(row.courierPickup?.courier ?? external ?? null);
      return make("courier_no_recogio", row.courierPickup ? `${who} debía recogerlo el ${programDayLabel(row.courierPickup.date)}.` : `Guía de ${who} sin recojo.`);
    }
    const lastBox = row.ops?.lastGfBox;
    if (POR_DESPACHAR_IN_BOX.has(row.substage ?? "") || (lastBox && lastBox.day < today)) {
      return make("caja_vencida", lastBox ? `Caja del ${programDayLabel(lastBox.day)}${lastBox.riderName ? ` de ${lastBox.riderName}` : ""}.` : null);
    }
    if (!row.gf) return make("sin_condiciones_gf", row.district ? `Distrito: ${row.district}.` : "Sin distrito.");
    if (row.gf.requestDay) return make("tomado_sin_caja", `Solicitud para el ${programDayLabel(row.gf.requestDay)}.`);
    return make("armado_sin_caja", plannedNote);
  }

  if (row.stage === "en_curso") {
    const sub = row.substage ?? "";
    if (EN_CURSO_OUT.has(sub)) return null;
    if (EN_CURSO_RETURN.has(sub)) return make("retorno_sin_recibir", reportedDetail(row));
    if (row.ops?.courierDelivered) {
      return make("entregado_sin_cierre", `${courierDisplayName(row.ops.courierDelivered.courier)} lo reporta entregado.`);
    }
    if (isGfOutput(row)) return make("reparto_sin_resultado", riderDetail(row));
    const status = row.ops?.reportedStatus ?? "";
    if (CUSTOMER_NOVELTY.test(status)) return make("novedad_con_clienta", reportedDetail(row));
    const courier = (row.ops?.liveCouriers.find((c) => !GF_COURIERS.has(c)) ?? row.courier ?? "").toLowerCase();
    return make("courier_sin_resultado", reportedDetail(row), courier === "tanders" ? TANDERS_THRESHOLD : undefined);
  }
  return null;
}

const REASON_ORDER = new Map(LIMA_STUCK_RULES.map((rule, i) => [rule.reason, i]));

/** Los trabados de las filas, del que más días lleva al que menos dentro de cada motivo, en el orden de las tarjetas. */
export function limaStuckItems(rows: readonly LimaPendingOrder[], today: string): LimaStuckItem[] {
  return rows.flatMap((row) => {
    const item = limaStuck(row, today);
    return item ? [item] : [];
  }).sort((a, b) => REASON_ORDER.get(a.reason)! - REASON_ORDER.get(b.reason)! || b.deliveryDays - a.deliveryDays || b.daysStuck - a.daysStuck || a.orderId.localeCompare(b.orderId));
}

/** Cuántos hay por motivo; los motivos sin pedidos quedan en cero. */
export function limaStuckCounts(items: readonly LimaStuckItem[]): Record<LimaStuckReason, number> {
  const counts = Object.fromEntries(LIMA_STUCK_RULES.map((rule) => [rule.reason, 0])) as Record<LimaStuckReason, number>;
  for (const item of items) counts[item.reason] += 1;
  return counts;
}

/** El motivo que viaja por la URL (`trabado`), o «todos», o null si no se eligió. */
export function stuckFilter(value: string | null): LimaStuckReason | "todos" | null {
  if (value === "todos") return "todos";
  return value && RULE.has(value as LimaStuckReason) ? value as LimaStuckReason : null;
}
