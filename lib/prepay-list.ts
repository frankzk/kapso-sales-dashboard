// «Lista de pago adelantado» (la lista negra) — la regla, pura (MOM §41,
// decisión del owner del 05-11-2026).
//
// QUÉ DECIDIÓ EL OWNER.
//   * Entra a la lista, por celular y por ORGANIZACIÓN (Kenku y Aurela
//     comparten la suya), quien tenga al menos UN pedido rechazado en la
//     puerta o no recogido en la agencia. También se agrega y se quita a mano,
//     con motivo, persona y fecha.
//   * Quien está en la lista paga el TOTAL por adelantado: sin contra entrega.
//
// UNA SOLA DEFINICIÓN DE «RECHAZÓ» Y «NO RECOGIÓ». Ya había dos detectores de
// rechazo en la puerta y no se inventa un tercero:
//   * `guideDoorRejection` (lib/reproprovincia.ts): el `REFUSED` de Aliclik
//     (`etiquetaDiceRechazoEnPuerta`, el mismo de `countDoorRejections` del
//     §8.2) más la novedad 15/16 de Swayp/Fénix. Se reusa tal cual.
//   * El «rechazado» del motorizado propio (`delivery_stops.outcome_reason`),
//     que ninguno de los dos miraba: es el mismo hecho —la clienta vio el
//     paquete y no lo quiso— reportado por Grupo GF.
//   * No recogido en agencia: el estado de recojo que dice que el paquete
//     vuelve o volvió al origen, o un pedido de agencia que salió y terminó
//     devuelto o anulado.
// `prepayTriggersOfOrder` junta las tres; la regla automática, el panel y las
// pruebas la usan a ella.
//
// UNA BAJA A MANO SE RESPETA. Si una persona quita a alguien, la regla no lo
// vuelve a meter por los mismos hechos. Al quitar se guarda lo que YA se sabía
// —los pedidos que en ese momento disparaban el alta, con esta misma regla:
// `removed_known_order_ids`— y solo un pedido que no esté ahí ni en la
// evidencia lo devuelve (`prepayAutoDecision`). NO se decide por la fecha del
// hecho: `last_report_at` avanza con cada reporte del courier y `status_since`
// con cada cambio de estado, así que un rechazo viejo «parecía» nuevo; y una
// guía de Swayp creada antes de la baja y rechazada después quedaba fechada
// antes. La fecha de cada hecho se guarda solo para mostrarla.
//
// Puro: sin base ni red.

import { normalizePhone } from "@/lib/phone";
import { guideDoorRejection } from "@/lib/reproprovincia";
import { orderFullyPaid, type OrderPaymentFacts } from "@/lib/order-paid";
import { remainingCents } from "@/lib/payment-rounding";

/** Cómo se llama en pantalla. «Lista negra» es su sinónimo en el habla del equipo. */
export const PREPAY_LIST_LABEL = "Lista de pago adelantado";
export const PREPAY_LIST_SYNONYM = "lista negra";
export const PREPAY_LIST_PATH = "/dashboard/clientes/pago-adelantado";

/** Lo que se le exige al cliente de la lista. */
export const PREPAY_REQUIREMENT_LABEL = "Pago completo por adelantado";

/** Cuánta historia mira la regla automática: seis meses (el tamaño medido, §41.2). */
export const PREPAY_LOOKBACK_DAYS = 183;

/** El motivo de un alta o una baja a mano: mínimo de caracteres, como una excepción del §8. */
export const PREPAY_REASON_MIN = 8;
export const PREPAY_REASON_MAX = 500;

/** Cuántos nombres de pedido guarda el resumen de una simulación. */
export const PREPAY_SIMULATION_SAMPLES = 200;

// ── El celular ──────────────────────────────────────────────────────────────

/**
 * La llave de la lista: `51` + móvil peruano de 9 dígitos (`normalizePhone`).
 * Lo que no es un móvil peruano no entra ni se busca: null. Un celular que no
 * se puede normalizar NUNCA está en la lista (no hay con qué compararlo).
 */
export function prepayPhoneKey(raw: string | null | undefined): string | null {
  const phone = normalizePhone(raw);
  return phone && /^519\d{8}$/.test(phone) ? phone : null;
}

/** «987 654 321» para mostrar; el `51` se sobreentiende. */
export function prepayPhoneLabel(phone: string | null | undefined): string {
  if (typeof phone !== "string" || !phone) return "El celular";
  const national = phone.startsWith("51") && phone.length === 11 ? phone.slice(2) : phone;
  return national.length === 9 ? `${national.slice(0, 3)} ${national.slice(3, 6)} ${national.slice(6)}` : national;
}

/**
 * La llave de un alta viva para marcar filas: organización + celular canónico.
 * La lista es por organización (§41.1): el mismo celular listado en otra
 * organización no marca el pedido de esta. Pura.
 */
export function prepayListedKey(orgId: string, phone: string): string {
  return `${orgId}|${phone}`;
}

/**
 * Marca las filas de una página con `prepay_listed`, desde las altas vivas que
 * leyó el servidor en UNA consulta (llaves `prepayListedKey`). Cada fila se
 * compara con la organización de SU tienda (`storeOrg`); una tienda que no está
 * en el mapa no se marca. Sin lectura (`null`) las deja como estaban: no afirma
 * nada. Pura.
 */
export function withPrepayListed<T extends { customer_phone?: string | null; store_id?: string | null }>(
  rows: T[],
  listed: ReadonlySet<string> | null,
  storeOrg: ReadonlyMap<string, string>,
): (T & { prepay_listed?: boolean })[] {
  if (!listed) return rows;
  return rows.map((r) => {
    const key = prepayPhoneKey(r.customer_phone ?? null);
    const org = r.store_id ? storeOrg.get(r.store_id) : undefined;
    return { ...r, prepay_listed: !!key && !!org && listed.has(prepayListedKey(org, key)) };
  });
}

// ── Lo que dispara el alta ──────────────────────────────────────────────────

export const PREPAY_TRIGGER_KINDS = ["rechazo_en_puerta", "no_recogio_en_agencia"] as const;
export type PrepayTriggerKind = (typeof PREPAY_TRIGGER_KINDS)[number];

export const PREPAY_TRIGGER_LABEL: Record<PrepayTriggerKind, string> = {
  rechazo_en_puerta: "Rechazó en la puerta",
  no_recogio_en_agencia: "No recogió en la agencia",
};

/** El estado de recojo que dice que el paquete vuelve o volvió sin que la clienta lo recogiera. */
export const PREPAY_NO_PICKUP_STATES: readonly string[] = ["retorno_iniciado", "devuelto_al_origen", "devuelto"];

/** Una guía del pedido, con lo que hace falta para decidir. */
export interface PrepayShipmentFact {
  order_id: string | null;
  courier: string | null;
  reported_status: string | null;
  pickup_state?: string | null;
  closed_at?: string | null;
  returned_at?: string | null;
  created_at?: string | null;
}

/** Una parada del motorizado propio. */
export interface PrepayStopFact {
  order_id: string | null;
  status?: string | null;
  outcome_reason: string | null;
  reported_at: string | null;
}

/** El pedido (una fila de `order_master`). */
export interface PrepayOrderFact {
  order_id: string;
  store_id: string;
  order_name: string | null;
  customer_phone: string | null;
  order_created_at?: string | null;
  agency_branch?: string | null;
  pickup_state?: string | null;
  general_status?: string | null;
  dispatched_at?: string | null;
  returned_at?: string | null;
}

/** Un hecho que dispara el alta: un pedido, qué pasó y cuándo se supo. */
export interface PrepayTrigger {
  orderId: string;
  orderName: string | null;
  storeId: string;
  kind: PrepayTriggerKind;
  /** «Aliclik REFUSED», «Swayp · …», «Motorizado propio», «Agencia: devuelto al origen». */
  detail: string;
  /**
   * Cuándo pasó, para mostrarlo: la mejor fecha que NO se mueve con el mismo
   * hecho (cierre o devolución de la guía, el reporte del motorizado, la
   * devolución o la salida del pedido; la creación de la guía como último
   * recurso). Nunca `last_report_at` ni `status_since`. Null: no se sabe.
   */
  at: string | null;
}

function firstIso(...values: (string | null | undefined)[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && Number.isFinite(Date.parse(value))) return new Date(Date.parse(value)).toISOString();
  }
  return null;
}

function courierName(courier: string | null | undefined): string {
  const c = (courier ?? "").trim().toLowerCase();
  if (c === "aliclik") return "Aliclik";
  if (c === "swayp" || c === "fenix") return "Swayp";
  if (c === "shalom") return "Shalom";
  if (c === "olva") return "Olva";
  return c || "courier";
}

/**
 * LOS HECHOS DE UN PEDIDO QUE LO METEN EN LA LISTA. Uno por tipo como mucho
 * (un pedido rechazado dos veces es UNA venta rechazada, como en
 * `countDoorRejections`); de cada tipo se queda el hecho más antiguo, que es
 * cuando se supo. Pura.
 */
export function prepayTriggersOfOrder(input: {
  order: PrepayOrderFact;
  shipments?: readonly PrepayShipmentFact[];
  stops?: readonly PrepayStopFact[];
}): PrepayTrigger[] {
  const { order } = input;
  const found = new Map<PrepayTriggerKind, { detail: string; at: string | null }>();
  const keep = (kind: PrepayTriggerKind, detail: string, at: string | null) => {
    const prev = found.get(kind);
    if (!prev) return void found.set(kind, { detail, at });
    // El más antiguo con fecha gana: es cuando se supo.
    if (at && (!prev.at || Date.parse(at) < Date.parse(prev.at))) found.set(kind, { detail, at });
  };

  for (const s of input.shipments ?? []) {
    if (s.order_id !== order.order_id) continue;
    if (guideDoorRejection({ courier: s.courier ?? "", delivery_status: "", reported_status: s.reported_status })) {
      const label = (s.reported_status ?? "").split(" · ")[0]?.trim().toUpperCase() === "REFUSED" ? "Aliclik: REFUSED" : (s.reported_status ?? "").trim();
      keep("rechazo_en_puerta", label || courierName(s.courier), firstIso(s.closed_at, s.returned_at, s.created_at));
    }
    if (PREPAY_NO_PICKUP_STATES.includes((s.pickup_state ?? "").trim())) {
      keep(
        "no_recogio_en_agencia",
        `${courierName(s.courier)}: ${(s.pickup_state ?? "").replace(/_/g, " ")}`,
        firstIso(s.returned_at, s.closed_at, s.created_at),
      );
    }
  }

  for (const stop of input.stops ?? []) {
    if (stop.order_id !== order.order_id) continue;
    if ((stop.outcome_reason ?? "").trim().toLowerCase() !== "rechazado") continue;
    if (stop.status && stop.status !== "no_entregado") continue;
    keep("rechazo_en_puerta", "Motorizado propio: rechazado", firstIso(stop.reported_at));
  }

  if (PREPAY_NO_PICKUP_STATES.includes((order.pickup_state ?? "").trim())) {
    keep("no_recogio_en_agencia", `Agencia: ${(order.pickup_state ?? "").replace(/_/g, " ")}`, firstIso(order.returned_at, order.dispatched_at));
  }
  const status = (order.general_status ?? "").trim();
  if ((order.agency_branch ?? "").trim() && order.dispatched_at && (status === "devuelto" || status === "anulado")) {
    keep("no_recogio_en_agencia", `Agencia: salió y terminó ${status}`, firstIso(order.returned_at, order.dispatched_at));
  }

  return [...found].map(([kind, f]) => ({
    orderId: order.order_id,
    orderName: order.order_name,
    storeId: order.store_id,
    kind,
    detail: f.detail,
    at: f.at,
  }));
}

// ── La evidencia que se guarda ──────────────────────────────────────────────

export interface PrepayEvidenceItem {
  order_id: string;
  order_name: string | null;
  store_id: string;
  kind: PrepayTriggerKind;
  detail: string;
  at: string | null;
}

export type PrepayEvidence =
  | { kind: "auto"; counts: Record<PrepayTriggerKind, number>; orders: PrepayEvidenceItem[] }
  | { kind: "manual"; order_name?: string | null };

/** La evidencia de un alta automática: cuántos pedidos de cada tipo y cuáles. Pura. */
export function prepayEvidenceOf(triggers: readonly PrepayTrigger[]): PrepayEvidence {
  const counts: Record<PrepayTriggerKind, number> = { rechazo_en_puerta: 0, no_recogio_en_agencia: 0 };
  const seen = new Set<string>();
  const orders: PrepayEvidenceItem[] = [];
  for (const t of triggers) {
    const key = `${t.orderId}:${t.kind}`;
    if (seen.has(key)) continue;
    seen.add(key);
    counts[t.kind]++;
    orders.push({ order_id: t.orderId, order_name: t.orderName, store_id: t.storeId, kind: t.kind, detail: t.detail, at: t.at });
  }
  orders.sort((a, b) => (a.at ?? "").localeCompare(b.at ?? ""));
  return { kind: "auto", counts, orders };
}

/** Los pedidos que nombra una evidencia (para respetar una baja). Tolera lo que venga de la base. Pura. */
export function prepayEvidenceOrderIds(evidence: unknown): string[] {
  const orders = (evidence as { orders?: unknown } | null)?.orders;
  if (!Array.isArray(orders)) return [];
  return orders.map((o) => (o as { order_id?: unknown })?.order_id).filter((id): id is string => typeof id === "string" && id !== "");
}

/** La evidencia leída de la base, sin fiarse de su forma. Pura. */
export function parsePrepayEvidence(raw: unknown): PrepayEvidence {
  const r = (raw ?? {}) as Record<string, unknown>;
  if (r.kind === "auto" && Array.isArray(r.orders)) {
    const orders: PrepayEvidenceItem[] = [];
    for (const o of r.orders as Record<string, unknown>[]) {
      if (!o || typeof o.order_id !== "string") continue;
      const kind = (PREPAY_TRIGGER_KINDS as readonly string[]).includes(String(o.kind)) ? (o.kind as PrepayTriggerKind) : "rechazo_en_puerta";
      orders.push({
        order_id: o.order_id,
        order_name: typeof o.order_name === "string" ? o.order_name : null,
        store_id: typeof o.store_id === "string" ? o.store_id : "",
        kind,
        detail: typeof o.detail === "string" ? o.detail : "",
        at: typeof o.at === "string" ? o.at : null,
      });
    }
    const counts: Record<PrepayTriggerKind, number> = { rechazo_en_puerta: 0, no_recogio_en_agencia: 0 };
    for (const o of orders) counts[o.kind]++;
    return { kind: "auto", counts, orders };
  }
  return { kind: "manual", order_name: typeof r.order_name === "string" ? r.order_name : null };
}

/** «Rechazó en la puerta 1 pedido (#KP123) · No recogió en la agencia 1 pedido (#AUR9)». Pura. */
export function prepayAutoReason(evidence: PrepayEvidence): string {
  if (evidence.kind !== "auto") return "Agregado a mano.";
  const parts: string[] = [];
  for (const kind of PREPAY_TRIGGER_KINDS) {
    const of = evidence.orders.filter((o) => o.kind === kind);
    if (!of.length) continue;
    const names = of.map((o) => o.order_name ?? "pedido").slice(0, 3).join(", ");
    parts.push(`${PREPAY_TRIGGER_LABEL[kind]} ${of.length} ${of.length === 1 ? "pedido" : "pedidos"} (${names}${of.length > 3 ? "…" : ""})`);
  }
  return parts.length ? `${parts.join(" · ")}.` : "Rechazo en la puerta o no recogido en la agencia.";
}

// ── La decisión de la regla automática ──────────────────────────────────────

/** Una fila de `prepay_list_entries`, con lo que la decisión necesita. */
export interface PrepayEntryFact {
  source: string;
  added_at: string;
  removed_at: string | null;
  evidence: unknown;
  /** Los pedidos que ya disparaban el alta cuando se quitó (0309). Null: una baja sin ese dato. */
  removed_known_order_ids?: unknown;
}

/** Los ids de `removed_known_order_ids`, o null si la baja no los guardó. Tolera lo que venga de la base. Pura. */
export function prepayKnownOrderIds(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  return raw.filter((id): id is string => typeof id === "string" && id !== "");
}

/** Lo que se guarda al quitar: los pedidos (sin repetir) que hoy disparan el alta. Pura. */
export function prepayKnownOrderIdsOf(triggers: readonly PrepayTrigger[]): string[] {
  return [...new Set(triggers.map((t) => t.orderId))].sort();
}

export type PrepayAutoDecision =
  | { add: true; triggers: PrepayTrigger[]; evidence: PrepayEvidence; reason: string }
  | { add: false; why: "ya_en_lista" | "sin_hechos" | "quitado_sin_hecho_nuevo" };

/**
 * ¿La regla agrega este celular? Pura.
 *
 *   * Si ya tiene un alta viva, no (una sola por celular).
 *   * Sin bajas previas, cualquier hecho de la ventana lo agrega.
 *   * Con bajas previas, SOLO los hechos de un pedido que no estaba en lo que
 *     se sabía al quitar (`removed_known_order_ids`) ni en la evidencia de
 *     ninguna alta quitada. Un pedido así es nuevo para la regla aunque su
 *     fecha sea anterior a la baja (la guía de Swayp creada antes y rechazada
 *     después).
 *   * Una baja que no guardó lo sabido (no debería haber: la 0309 lo escribe
 *     siempre) cae a la fecha: solo cuenta un hecho con fecha estable posterior
 *     a esa baja. Un hecho sin fecha no cuenta: manda la persona.
 */
export function prepayAutoDecision(input: { triggers: readonly PrepayTrigger[]; entries: readonly PrepayEntryFact[] }): PrepayAutoDecision {
  if (input.entries.some((e) => e.removed_at == null)) return { add: false, why: "ya_en_lista" };
  if (!input.triggers.length) return { add: false, why: "sin_hechos" };
  const removed = input.entries.filter((e) => e.removed_at != null);
  let fresh = [...input.triggers];
  if (removed.length) {
    const known = new Set(removed.flatMap((e) => [...prepayEvidenceOrderIds(e.evidence), ...(prepayKnownOrderIds(e.removed_known_order_ids) ?? [])]));
    const legacy = removed.filter((e) => prepayKnownOrderIds(e.removed_known_order_ids) == null);
    const legacyCut = legacy.length ? Math.max(...legacy.map((e) => Date.parse(e.removed_at!))) : null;
    fresh = fresh.filter((t) => {
      if (known.has(t.orderId)) return false;
      if (legacyCut == null) return true;
      const at = t.at ? Date.parse(t.at) : NaN;
      return Number.isFinite(at) && Number.isFinite(legacyCut) && at > legacyCut;
    });
    if (!fresh.length) return { add: false, why: "quitado_sin_hecho_nuevo" };
  }
  const evidence = prepayEvidenceOf(fresh);
  return { add: true, triggers: fresh, evidence, reason: prepayAutoReason(evidence) };
}

// ── Lo que se exige en cada punto ───────────────────────────────────────────

/**
 * ¿El pedido de un cliente de la lista puede seguir como está? Solo si ya
 * está pagado completo (prepago web o comprobantes que cubren el total), la
 * misma definición de `orderFullyPaid` que pone la guía en cobro cero. Pura.
 */
export function prepayRequirementMet(facts: OrderPaymentFacts): boolean {
  return orderFullyPaid(facts);
}

/** Lo que hace falta de cada comprobante del pedido (`order_payments`). */
export interface PrepayPaymentRow {
  kind: string;
  validation_status: string;
  amount: number | string | null;
}

/**
 * EL COBRO QUE FALTA, para «Enviar link de pago». Un cliente de la lista paga
 * el total, pero lo que ya pagó no se le vuelve a cobrar, y el comprobante
 * tiene que caber en el plan de cobro del pedido (0092: un solo primer pago
 * vivo, adelanto O total; después solo diferencias). Pura.
 *
 *   * Sin comprobantes vivos: `total` por el total del pedido.
 *   * Con un adelanto vivo (y quizá diferencias), todos validados: `diferencia`
 *     por lo que falta del total. Un `total` encima chocaría con el índice
 *     0092 y el pago de Flow entraría sin registrarse.
 *   * Con algún comprobante por validar: nada todavía. Validarlo puede cambiar
 *     lo que falta (o completar el pago), y cobrar antes es cobrar dos veces.
 *   * Con un pago total vivo, una diferencia sin su adelanto, o nada que cobrar:
 *     nada, con el motivo.
 */
export type PrepayLinkPlan =
  | { ok: true; kind: "total" | "diferencia"; amount: number; alreadyPaid: number }
  | { ok: false; error: string };

export function prepayLinkPlan(payments: readonly PrepayPaymentRow[], orderTotal: number | string | null | undefined): PrepayLinkPlan {
  const totalCents = Math.round(Number(orderTotal) * 100);
  if (!Number.isFinite(totalCents) || totalCents <= 0) return { ok: false, error: "El pedido no tiene un total que cobrar." };
  const live = payments.filter((p) => p.validation_status !== "rechazado");
  if (!live.length) return { ok: true, kind: "total", amount: totalCents / 100, alreadyPaid: 0 };
  if (live.some((p) => p.validation_status !== "validado")) {
    return { ok: false, error: "Este pedido tiene un comprobante por validar: valídalo (o recházalo) antes de crear otro cobro." };
  }
  if (live.some((p) => p.kind === "total")) return { ok: false, error: "Este pedido ya tiene un pago total registrado: no hace falta otro cobro." };
  if (!live.some((p) => p.kind === "adelanto")) {
    return { ok: false, error: "Los comprobantes de este pedido no tienen su adelanto: revísalos antes de crear otro cobro." };
  }
  const paidCents = live.reduce((sum, p) => {
    const c = Math.round(Number(p.amount) * 100);
    return sum + (Number.isFinite(c) && c > 0 ? c : 0);
  }, 0);
  // Menos de S/ 1 por cubrir es redondeo y está pagado (MOM §6.5).
  const dueCents = remainingCents(paidCents, totalCents);
  if (dueCents <= 0) return { ok: false, error: "Lo validado ya cubre el total del pedido: no hace falta otro cobro." };
  return { ok: true, kind: "diferencia", amount: dueCents / 100, alreadyPaid: paidCents / 100 };
}

export const PREPAY_POINTS = ["confirmar", "guia", "pedido", "bot"] as const;
export type PrepayPoint = (typeof PREPAY_POINTS)[number];

/** Lo que se le dice a quien intenta lo que la lista no deja. Pura. */
export function prepayBlockMessage(point: PrepayPoint): string {
  const head = `${PREPAY_LIST_LABEL}: este cliente paga el total por adelantado.`;
  switch (point) {
    case "confirmar":
      return `${head} No se confirma contra entrega: envíale el link de pago del total (o que pague el total por Yape) y confirma cuando el pago esté validado.`;
    case "guia":
      return `${head} La guía sale solo con el pedido pagado completo, con cobro cero. Valida el pago total antes de crearla.`;
    case "pedido":
      return `${head} Kapta no crea pedidos contra entrega para este celular: cobra el total por adelantado (link de pago o Yape) antes de generarlo.`;
    case "bot":
      return `${head} El bot no crea pedidos contra entrega para este celular: deriva la conversación a una asesora, que cobra el total por adelantado.`;
  }
}

// ── Etiquetas y validaciones ────────────────────────────────────────────────

export const PREPAY_SOURCES = ["auto", "manual"] as const;
export type PrepaySource = (typeof PREPAY_SOURCES)[number];
export const PREPAY_SOURCE_LABEL: Record<PrepaySource, string> = { auto: "Automático", manual: "Manual" };

export function prepaySourceLabel(source: string): string {
  return source === "auto" || source === "manual" ? PREPAY_SOURCE_LABEL[source] : source;
}

export const PREPAY_MODES = ["apagado", "simulacion", "activo"] as const;
export type PrepayMode = (typeof PREPAY_MODES)[number];
export const PREPAY_MODE_LABEL: Record<PrepayMode, string> = { apagado: "Apagado", simulacion: "Simulación", activo: "Activo" };

export function isPrepayMode(value: unknown): value is PrepayMode {
  return typeof value === "string" && (PREPAY_MODES as readonly string[]).includes(value);
}

/** El motivo de un alta o una baja a mano: null si sirve, o qué le falta. Pura. */
export function prepayReasonProblem(raw: unknown): string | null {
  const reason = typeof raw === "string" ? raw.trim() : "";
  if (reason.length < PREPAY_REASON_MIN) return `Escribe el motivo (al menos ${PREPAY_REASON_MIN} caracteres).`;
  if (reason.length > PREPAY_REASON_MAX) return `El motivo es demasiado largo (máx. ${PREPAY_REASON_MAX}).`;
  return null;
}

/** El celular escrito para un alta a mano: la llave, o qué le falta. Pura. */
export function prepayPhoneInput(raw: unknown): { ok: true; phone: string } | { ok: false; error: string } {
  const phone = prepayPhoneKey(typeof raw === "string" ? raw : null);
  return phone ? { ok: true, phone } : { ok: false, error: "Escribe un celular peruano de 9 dígitos que empiece por 9." };
}

// ── El resumen de la simulación (`prepay_list_settings.last_simulation`) ────

export interface PrepaySimulationSummary {
  at: string;
  mode: PrepayMode;
  /** Celulares con al menos un hecho en la ventana. */
  phonesWithFacts: number;
  /** Los que entrarían (o entraron, en Activo). */
  wouldAdd: number;
  /** Ya estaban en la lista. */
  alreadyListed: number;
  /** Quitados a mano, sin hecho posterior a la baja: la regla los respeta. */
  respectedRemovals: number;
  /** Hechos sin celular válido: no se pueden listar. */
  withoutPhone: number;
  byKind: Record<PrepayTriggerKind, number>;
  /** Hasta `PREPAY_SIMULATION_SAMPLES` nombres de pedido de los que entrarían. Nunca celulares. */
  samples: string[];
  /** Solo en Activo: cuántas altas se escribieron de verdad. */
  inserted?: number;
  error?: string | null;
}

/** El resumen leído de la base, sin fiarse de su forma. Null si no sirve. Pura. */
export function parsePrepaySimulationSummary(raw: unknown): PrepaySimulationSummary | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  if (typeof r.at !== "string") return null;
  const byKindRaw = (r.byKind ?? {}) as Record<string, unknown>;
  return {
    at: r.at,
    mode: isPrepayMode(r.mode) ? r.mode : "simulacion",
    phonesWithFacts: n(r.phonesWithFacts),
    wouldAdd: n(r.wouldAdd),
    alreadyListed: n(r.alreadyListed),
    respectedRemovals: n(r.respectedRemovals),
    withoutPhone: n(r.withoutPhone),
    byKind: { rechazo_en_puerta: n(byKindRaw.rechazo_en_puerta), no_recogio_en_agencia: n(byKindRaw.no_recogio_en_agencia) },
    samples: Array.isArray(r.samples) ? r.samples.filter((s): s is string => typeof s === "string").slice(0, PREPAY_SIMULATION_SAMPLES) : [],
    inserted: typeof r.inserted === "number" ? r.inserted : undefined,
    error: typeof r.error === "string" ? r.error : null,
  };
}

/** «Entrarían 12 clientes: 10 por rechazo en la puerta y 2 por no recoger.» Pura. */
export function prepaySimulationHeadline(s: PrepaySimulationSummary): string {
  const verb = s.mode === "activo" ? "Entraron" : "Entrarían";
  if (s.wouldAdd === 0) return s.mode === "activo" ? "No entró ningún cliente nuevo." : "No entraría ningún cliente nuevo.";
  const who = s.wouldAdd === 1 ? "1 cliente" : `${s.wouldAdd.toLocaleString("es-PE")} clientes`;
  const parts: string[] = [];
  if (s.byKind.rechazo_en_puerta) parts.push(`${s.byKind.rechazo_en_puerta} por rechazo en la puerta`);
  if (s.byKind.no_recogio_en_agencia) parts.push(`${s.byKind.no_recogio_en_agencia} por no recoger en la agencia`);
  return `${verb} ${who}${parts.length ? `: ${parts.join(" y ")}` : ""}.`;
}
