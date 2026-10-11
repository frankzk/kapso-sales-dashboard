// El recordatorio de recojo (MOM §12, migración 0242): QUIÉN lo recibe y
// CUÁNDO entra a la cola. El envío es el mismo de los otros dos avisos
// (`processTransitNotifications`, lib/shalom/transit-notify.ts), con su tope,
// su horario y sus botones.
//
// EL HUECO. El aviso de llegada sale una vez, el día que el paquete llega, y
// después nada. Medido el 10-10-2026: Kenku tenía 230 pedidos en la agencia
// (Shalom 224, Olva 6) que todavía debían el saldo, S/ 37.087 — 82 llegados
// hace 3 días o menos, 28 de 4 a 7, 39 de 8 a 14, 36 de 15 a 21 y 9 de 22 o
// más, con Shalom devolviendo a los 28. Un paquete que se queda en el mostrador
// sin cobrar vuelve a Lima con el flete pagado dos veces.
//
// CUÁNDO. Al día 3 y al día 7 desde que la guía quedó disponible en la
// agencia. Olva guarda el paquete solo 6 días (`OLVA_PICKUP_WINDOW_DAYS`):
// para Olva, únicamente el del día 3. Pasada la fecha límite del courier no
// sale ninguno — un «recógelo antes del 16» el 17 es mentira.
//
// A QUIÉN. Solo a la guía que SIGUE en la agencia y cuyo pedido TODAVÍA DEBE:
// las mismas reglas de cobro que los otros avisos (`noticeSkipReason`: ni
// «ya pagó todo», ni «pagado en el checkout», ni un pedido cerrado). Se mira al
// encolar —para no llenar la cola de filas que se van a omitir— y otra vez al
// enviar, porque entre una cosa y otra puede haber pagado o recogido.
//
// UNA VEZ CADA UNO. Son dos `kind` de la cola —`recordatorio_d3` y
// `recordatorio_d7`— y la unique (shipment_id, kind) hace el resto.
//
// EL PRIMER ENCENDIDO NO DISPARA DOS. Se encola solo el recordatorio MÁS
// AVANZADO que ya toca: una guía que lleva 10 días en la agencia cuando la
// tienda lo enciende recibe el de día 7 y nunca el de día 3. Y nunca entra un
// recordatorio con otro aviso de esa guía en la cola, ni a menos de 48 h de
// otro enviado: así el de día 3 retenido por el tope no sale el mismo día que
// el de día 7, ni el recordatorio pisa al aviso de llegada que salió tarde.

import type { SupabaseClient } from "@supabase/supabase-js";
import { AGENCY_AVAILABLE_STATES } from "@/lib/order-master-filters";
import { isWebPrepaid } from "@/lib/order-paid";
import type { PaymentGateway } from "@/lib/payment-gateway";
import {
  REMINDER_KINDS,
  enqueueTransitNotification,
  guideArrivalAt,
  noticeSkipReason,
  pendingBalance,
  pickupWindowDays,
  stillAtAgency,
  type NoticeCourier,
  type ReminderKind,
} from "@/lib/shalom/transit-notify";

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

/** Qué recordatorio toca en qué día desde la llegada, por courier. Olva
 *  devuelve a los 6 días: un «día 7» de Olva no existiría. */
export const REMINDER_STAGES: Record<NoticeCourier, readonly { kind: ReminderKind; day: number }[]> = {
  shalom: [
    { kind: "recordatorio_d3", day: 3 },
    { kind: "recordatorio_d7", day: 7 },
  ],
  olva: [{ kind: "recordatorio_d3", day: 3 }],
};

/** Mínimo entre un aviso enviado a la guía y su recordatorio. */
export const REMINDER_MIN_GAP_HOURS = 48;

/**
 * Cuántos recordatorios puede tener una tienda ESPERANDO en la cola a la vez.
 *
 * POR QUÉ. La cola sale por orden de llegada y con el tope de la tienda (0194).
 * El primer encendido en Kenku encolaría ~140 recordatorios de golpe (medido
 * el 11-10-2026), y los avisos de tránsito y de llegada que entren detrás —los
 * que no pueden esperar:
 * un «va en camino» que llega con el paquete ya en la agencia no sirve—
 * saldrían un día tarde. Con este techo el recordatorio se va sirviendo a
 * goteo, pasada a pasada, y nunca tapa a los otros dos.
 */
export const REMINDER_PENDING_CAP = 10;

/** Lo que ya hay en la cola para esta guía, de cualquier tipo. */
export interface GuideNotice {
  kind: string;
  status: string;
  sentAt: string | null;
}

export interface ReminderCandidate {
  courier: NoticeCourier;
  /** Ver `guideArrivalAt`. */
  arrivedAt: string | null;
  pickupState: string | null;
  deliveryStatus: string | null;
  generalStatus: string | null;
  orderTotal: number | null;
  validatedAmount: number | null;
  webPrepaid: boolean;
  notices: GuideNotice[];
}

export type ReminderDecision =
  | { due: true; kind: ReminderKind; deadlineIso: string }
  | { due: false; reason: string };

/**
 * ¿Toca encolar un recordatorio para esta guía, y cuál? Pura.
 *
 * Las razones vuelven SIN números dentro, a propósito: el cron las agrupa y
 * las cuenta («aún no toca: 140»), y una por día no se podría leer.
 */
export function dueReminder(g: ReminderCandidate, nowIso: string): ReminderDecision {
  if (!stillAtAgency(g.pickupState, g.deliveryStatus)) return { due: false, reason: "ya no está en la agencia" };

  const llegada = g.arrivedAt ? Date.parse(g.arrivedAt) : NaN;
  // Sin llegada no hay día 3 ni fecha límite que decir: no se adivina.
  if (!Number.isFinite(llegada)) return { due: false, reason: "sin fecha de llegada a la agencia" };
  const now = Date.parse(nowIso);
  const limite = llegada + pickupWindowDays(g.courier) * DAY;
  if (now >= limite) return { due: false, reason: "ya pasó la fecha límite de recojo" };

  // Las mismas reglas de cobro que los otros avisos: es un aviso de COBRO.
  const noCobrar = noticeSkipReason({
    generalStatus: g.generalStatus,
    orderTotal: g.orderTotal,
    validatedAmount: g.validatedAmount,
    webPrepaid: g.webPrepaid,
  });
  if (noCobrar) return { due: false, reason: noCobrar };
  // Sin total no se sabe el saldo, y el saldo es la mitad del mensaje.
  if (pendingBalance(g.orderTotal, g.validatedAmount) == null) {
    return { due: false, reason: "sin total del pedido: no se sabe el saldo" };
  }

  const dias = (now - llegada) / DAY;
  const tocan = REMINDER_STAGES[g.courier].filter((s) => dias >= s.day);
  if (!tocan.length) return { due: false, reason: "aún no toca" };
  // EL MÁS AVANZADO, y solo ése: con la guía en el día 10 y sin recordatorios
  // —el primer encendido— sale el de día 7, no los dos.
  const etapa = tocan[tocan.length - 1]!;
  if (g.notices.some((n) => n.kind === etapa.kind)) return { due: false, reason: "ya tiene ese recordatorio" };
  if (g.notices.some((n) => n.status === "pending")) {
    return { due: false, reason: "hay otro aviso de esta guía en la cola" };
  }
  const reciente = g.notices.some(
    (n) => n.status === "sent" && n.sentAt && now - Date.parse(n.sentAt) < REMINDER_MIN_GAP_HOURS * HOUR,
  );
  if (reciente) return { due: false, reason: "se le escribió hace menos de 48 h" };

  return { due: true, kind: etapa.kind, deadlineIso: new Date(limite).toISOString() };
}

export interface ReminderEnqueueReport {
  /** Tiendas con el recordatorio de este courier encendido. */
  tiendas: number;
  /** Guías en la agencia que se miraron. */
  guias: number;
  encolados: number;
  /** Tocaban, pero la tienda ya tiene la cola llena de recordatorios. */
  porTope: number;
  /** Por qué no se encoló el resto, contado. */
  motivos: Record<string, number>;
  errores: string[];
}

/** Techo de guías por pasada: muy por encima de las que esperan hoy (~350). */
const MAX_GUIDES = 2000;
/** Ids por consulta: cabe en la URL y deja las filas lejos del tope de 1000
 *  de PostgREST. */
const CHUNK = 100;

type Result = { data: unknown; error: { message: string } | null };

async function inChunks<T>(
  ids: string[],
  query: (part: string[]) => PromiseLike<Result>,
): Promise<{ rows: T[]; error: string | null }> {
  const rows: T[] = [];
  for (let i = 0; i < ids.length; i += CHUNK) {
    const { data, error } = await query(ids.slice(i, i + CHUNK));
    if (error) return { rows, error: error.message };
    rows.push(...((data ?? []) as T[]));
  }
  return { rows, error: null };
}

/**
 * Encola los recordatorios que tocan, para las guías de UN courier. Lo corre
 * el cron de ese courier ANTES de drenar la cola (shalom-reconcile para
 * Shalom, olva-reconcile para Olva).
 *
 * FALLA CERRADO: si alguna lectura falla no se encola nada y se informa. Un
 * pago que no se pudo leer no es «no pagó», y mandarle un cobro a quien ya
 * pagó es justo lo que el aviso no puede hacer.
 */
export async function enqueueDueReminders(
  admin: SupabaseClient,
  opts: { courier: NoticeCourier; nowIso?: string; pendingCap?: number },
): Promise<ReminderEnqueueReport> {
  const { courier } = opts;
  const nowIso = opts.nowIso ?? new Date().toISOString();
  const pendingCap = opts.pendingCap ?? REMINDER_PENDING_CAP;
  const report: ReminderEnqueueReport = { tiendas: 0, guias: 0, encolados: 0, porTope: 0, motivos: {}, errores: [] };
  const fallo = (que: string, msg: string): ReminderEnqueueReport => {
    report.errores.push(`recordatorio ${courier}: ${que}: ${msg}`);
    return report;
  };

  // Nace apagado: solo entran las tiendas que lo encendieron.
  const flag = courier === "olva" ? "olva_reminder_template_enabled" : "shalom_reminder_template_enabled";
  const tiendasRes = await admin.from("stores").select("id").eq(flag, true);
  if (tiendasRes.error) return fallo("tiendas", tiendasRes.error.message);
  const storeIds = ((tiendasRes.data ?? []) as { id: string }[]).map((s) => s.id);
  report.tiendas = storeIds.length;
  if (!storeIds.length) return report;

  const guiasRes = await admin
    .from("shipments")
    .select("id,store_id,order_id,guide_code,pickup_state,delivery_status,agency_arrived_at")
    .eq("courier", courier)
    .in("store_id", storeIds)
    .in("pickup_state", [...AGENCY_AVAILABLE_STATES])
    .not("delivery_status", "in", "(entregado,anulado,transferido,devuelto)")
    .not("order_id", "is", null)
    .limit(MAX_GUIDES);
  if (guiasRes.error) return fallo("guías", guiasRes.error.message);
  const guias = (guiasRes.data ?? []) as {
    id: string;
    store_id: string;
    order_id: string;
    guide_code: string | null;
    pickup_state: string | null;
    delivery_status: string | null;
    agency_arrived_at: string | null;
  }[];
  report.guias = guias.length;
  if (!guias.length) return report;

  const orderIds = [...new Set(guias.map((g) => g.order_id))];
  const shipmentIds = guias.map((g) => g.id);

  const [eventos, avisos, master, pedidos, pagos, enCola] = await Promise.all([
    // La PRIMERA llegada de cada guía, como en `guideArrivalAt`.
    inChunks<{ order_id: string; guide_code: string | null; occurred_at: string }>(orderIds, (part) =>
      admin
        .from("order_events")
        .select("order_id,guide_code,occurred_at")
        .eq("kind", "courier_status")
        .eq("new_operational", "disponible_para_recojo")
        .in("order_id", part),
    ),
    inChunks<{ shipment_id: string; kind: string; status: string; sent_at: string | null }>(shipmentIds, (part) =>
      admin.from("shalom_transit_notifications").select("shipment_id,kind,status,sent_at").in("shipment_id", part),
    ),
    inChunks<{ order_id: string; order_total: number | null; general_status: string | null }>(orderIds, (part) =>
      admin.from("order_master").select("order_id,order_total,general_status").in("order_id", part),
    ),
    inChunks<{
      id: string;
      total_amount: number | null;
      financial_status: string | null;
      total_refunded: number | string | null;
      payment_gateway: PaymentGateway | null;
    }>(orderIds, (part) =>
      admin.from("orders").select("id,total_amount,financial_status,total_refunded,payment_gateway").in("id", part),
    ),
    // Lo VALIDADO, igual que el saldo del aviso: un comprobante en revisión
    // todavía no es dinero.
    inChunks<{ order_id: string; amount: number | null }>(orderIds, (part) =>
      admin.from("order_payments").select("order_id,amount").eq("validation_status", "validado").in("order_id", part),
    ),
    // Recordatorios que ya esperan en la cola, de cualquier guía de la tienda.
    admin
      .from("shalom_transit_notifications")
      .select("store_id")
      .eq("status", "pending")
      .in("kind", [...REMINDER_KINDS])
      .limit(5000)
      .then((r) => ({ rows: (r.data ?? []) as { store_id: string }[], error: r.error?.message ?? null })),
  ]);
  for (const [que, r] of [
    ["llegadas", eventos],
    ["avisos", avisos],
    ["pedidos (Master)", master],
    ["pedidos", pedidos],
    ["pagos", pagos],
    ["cola", enCola],
  ] as const) {
    if (r.error) return fallo(que, r.error);
  }

  const primeraLlegada = new Map<string, string>();
  for (const e of eventos.rows) {
    const k = `${e.order_id}|${e.guide_code ?? ""}`;
    const prev = primeraLlegada.get(k);
    if (!prev || Date.parse(e.occurred_at) < Date.parse(prev)) primeraLlegada.set(k, e.occurred_at);
  }
  const avisosDe = new Map<string, { kind: string; status: string; sentAt: string | null }[]>();
  for (const a of avisos.rows) {
    const list = avisosDe.get(a.shipment_id) ?? [];
    list.push({ kind: a.kind, status: a.status, sentAt: a.sent_at });
    avisosDe.set(a.shipment_id, list);
  }
  const masterDe = new Map(master.rows.map((m) => [m.order_id, m]));
  const pedidoDe = new Map(pedidos.rows.map((o) => [o.id, o]));
  const validadoDe = new Map<string, number>();
  for (const p of pagos.rows) validadoDe.set(p.order_id, (validadoDe.get(p.order_id) ?? 0) + (Number(p.amount) || 0));
  const pendientes = new Map<string, number>();
  for (const r of enCola.rows) pendientes.set(r.store_id, (pendientes.get(r.store_id) ?? 0) + 1);

  const motivo = (m: string) => {
    report.motivos[m] = (report.motivos[m] ?? 0) + 1;
  };

  const tocan: { guia: (typeof guias)[number]; kind: ReminderKind; deadline: number }[] = [];
  for (const g of guias) {
    const notices = avisosDe.get(g.id) ?? [];
    const m = masterDe.get(g.order_id);
    const o = pedidoDe.get(g.order_id);
    const decision = dueReminder(
      {
        courier,
        arrivedAt: guideArrivalAt({
          firstArrivalEventAt: g.guide_code ? primeraLlegada.get(`${g.order_id}|${g.guide_code}`) : null,
          arrivalNoticeSentAt: notices.find((n) => n.kind === "disponible" && n.status === "sent")?.sentAt ?? null,
          agencyArrivedAt: g.agency_arrived_at,
        }),
        pickupState: g.pickup_state,
        deliveryStatus: g.delivery_status,
        generalStatus: m?.general_status ?? null,
        orderTotal: m?.order_total ?? o?.total_amount ?? null,
        validatedAmount: validadoDe.get(g.order_id) ?? 0,
        webPrepaid: isWebPrepaid({
          financialStatus: o?.financial_status ?? null,
          totalRefunded: o?.total_refunded == null ? null : Number(o.total_refunded),
          paymentGateway: o?.payment_gateway ?? null,
        }),
        notices,
      },
      nowIso,
    );
    if (decision.due) tocan.push({ guia: g, kind: decision.kind, deadline: Date.parse(decision.deadlineIso) });
    else motivo(decision.reason);
  }

  // Lo que vence antes, primero: con la cola a goteo, el que está a dos días de
  // volver a Lima no puede esperar detrás del que tiene tres semanas.
  tocan.sort((a, b) => a.deadline - b.deadline);
  const pedidosEnPasada = new Set<string>();
  for (const t of tocan) {
    // Un pedido con dos guías en la misma agencia recibe UN recordatorio por
    // pasada: el otro entra en la siguiente, con las 48 h de por medio.
    if (pedidosEnPasada.has(t.guia.order_id)) {
      motivo("otro recordatorio del mismo pedido en esta pasada");
      continue;
    }
    const enEspera = pendientes.get(t.guia.store_id) ?? 0;
    if (enEspera >= pendingCap) {
      report.porTope += 1;
      continue;
    }
    const ok = await enqueueTransitNotification(admin, {
      storeId: t.guia.store_id,
      shipmentId: t.guia.id,
      orderId: t.guia.order_id,
      kind: t.kind,
      courier,
    });
    if (ok) {
      report.encolados += 1;
      pendientes.set(t.guia.store_id, enEspera + 1);
      pedidosEnPasada.add(t.guia.order_id);
    } else {
      report.errores.push(`recordatorio ${courier}: no se pudo encolar ${t.guia.id}`);
    }
  }
  return report;
}
