// «Pago de diferencia» (MOM §44, owner 10-11-2026): la bandeja de los pedidos de
// Agencia que ya están en la sucursal y esperan que la clienta pague lo que
// falta (`macro_substage = pendiente_pago_diferencia`, §6.4). Dice cuánto
// falta, desde cuándo espera y cuál fue la ÚLTIMA GESTIÓN del equipo —quién,
// cuándo, por dónde y qué dijo—, para que quien llama sepa a quién le toca hoy.
//
// Tres grupos (owner, 10-11-2026), cada uno su pestaña:
//   - «En agencia»: `pendiente_pago_diferencia` (§6.4), el foco.
//   - «En camino»: Agencia (`macro_operation = agencia`) en `en_transito` o
//     `en_destino` sin pago completo: se pide la diferencia antes de que llegue.
//   - «Recogidos sin pago»: `recogido_sin_pago_completo` (Por cerrar): ya lo
//     recogió y falta cobrar.
// Y aparte, fuera de «Todos» (owner, 13-11-2026: «cómo saber cuáles están
// retornando de la provincia a Lima porque el cliente nunca pagó la
// diferencia»):
//   - «Retornando»: `devolucion_fisica_pendiente` (Por cerrar). La agencia sacó
//     el paquete sin recojo ni pago (el «entregado» que es el retorno, §12) y
//     viene de vuelta; se recibe en Almacén → Devoluciones (§9.4).
// Todos, solo con Shalom u Olva (`PAGO_DIFERENCIA_COURIERS`).
//
// Es una LECTURA: no escribe nada ni cambia etapas. La gestión se registra en
// la ficha del pedido (comentario con foto de constancia §43, mensaje por
// Chatby, llamada), y de ahí sale aquí. Pura y probada.

/** Los hechos que cuentan como gestión del equipo: los de una PERSONA. */
export const PAGO_DIFERENCIA_GESTION_KINDS = [
  "comment",
  "chatby_message",
  "kapso_message",
  "confirmation_contact",
  "browser_call",
  "anura_call",
] as const;

const GESTION_LABEL: Record<string, string> = {
  comment: "Comentario",
  chatby_message: "WhatsApp (Chatby)",
  kapso_message: "WhatsApp (Kapso)",
  confirmation_contact: "Contacto",
  browser_call: "Llamada desde Kapta",
  anura_call: "Llamada con Anura",
};

export type PagoDiferenciaGroup = "en_agencia" | "en_camino" | "recogido_sin_pago" | "retornando";

/** Los grupos por cobrar: los que suma «Todos». «Retornando» va aparte. */
export const PAGO_DIFERENCIA_GROUPS: readonly PagoDiferenciaGroup[] = ["en_agencia", "en_camino", "recogido_sin_pago"];

export const PAGO_DIFERENCIA_GROUP_LABEL: Record<PagoDiferenciaGroup, string> = {
  en_agencia: "En agencia",
  en_camino: "En camino",
  recogido_sin_pago: "Recogidos sin pago",
  retornando: "Retornando",
};

/** Con estos días en retorno el paquete ya debería estar en Lima: buscarlo o reclamarlo. */
export const RETORNO_OVERDUE_DAYS = 15;

/** ¿Cuenta para lo que se cobra (la bandeja, «Todos»)? «Retornando» no. */
export function isPagoDiferenciaCobro(group: PagoDiferenciaGroup): boolean {
  return group !== "retornando";
}

/** A qué grupo va un pedido del Master; null si no es de la bandeja. */
/**
 * Los couriers de agencia: solo Shalom y Olva dejan el paquete en una sucursal
 * a la espera de la diferencia (owner, 10-11-2026). Un Fenix de Repro
 * Provincia o un pedido sin guía en Kapta no son de la bandeja.
 */
export const PAGO_DIFERENCIA_COURIERS: readonly string[] = ["shalom", "olva"];

export function pagoDiferenciaGroup(o: {
  macro_substage: string | null;
  macro_operation: string | null;
  payment_state: string | null;
  current_courier: string | null;
}): PagoDiferenciaGroup | null {
  if (!PAGO_DIFERENCIA_COURIERS.includes((o.current_courier ?? "").trim().toLowerCase())) return null;
  if (o.macro_substage === "pendiente_pago_diferencia") return "en_agencia";
  if (o.macro_substage === "recogido_sin_pago_completo") return "recogido_sin_pago";
  if (o.macro_substage === "devolucion_fisica_pendiente") return "retornando";
  if (
    o.macro_operation === "agencia" &&
    (o.macro_substage === "en_transito" || o.macro_substage === "en_destino") &&
    o.payment_state !== "pago_completo"
  ) {
    return "en_camino";
  }
  return null;
}

export interface PagoDiferenciaOrderInput {
  order_id: string;
  macro_substage: string | null;
  macro_operation: string | null;
  payment_state: string | null;
  store_id: string;
  order_name: string | null;
  customer_name: string | null;
  customer_phone: string | null;
  order_total: number | string | null;
  current_courier: string | null;
  guide_code: string | null;
  agency_branch: string | null;
  agency_arrived_at: string | null;
  agency_expires_at: string | null;
  macro_since: string | null;
  province: string | null;
  district: string | null;
}

export interface PagoDiferenciaPaymentInput {
  order_id: string;
  kind: string;
  amount: number | string | null;
  validation_status: string;
}

export interface PagoDiferenciaEventInput {
  order_id: string;
  kind: string;
  occurred_at: string;
  actor: string | null;
  note: string | null;
  comment_type: string | null;
  payload?: Record<string, unknown> | null;
}

export interface PagoDiferenciaGestion {
  at: string;
  /** Quién (nombre resuelto); null si no se pudo resolver. */
  actorName: string | null;
  /** «Comentario», «WhatsApp (Chatby)», «Llamada con Anura»… */
  channel: string;
  /** El tipo del comentario («Pago de diferencia»), si lo tiene. */
  commentType: string | null;
  note: string | null;
  photoCount: number;
}

export interface PagoDiferenciaRow {
  orderId: string;
  group: PagoDiferenciaGroup;
  /** «En tránsito», «En destino»… para En camino; null en los otros. */
  substage: string | null;
  storeId: string;
  orderName: string;
  customerName: string | null;
  customerPhone: string | null;
  orderTotal: number | null;
  /** Lo validado hasta hoy. */
  paidValidated: number;
  /** Lo que falta por cobrar contra lo VALIDADO (null sin total). */
  remaining: number | null;
  /** Hay un comprobante cargado que todavía no se valida. */
  paymentToValidate: boolean;
  courier: string | null;
  guideCode: string | null;
  destination: string | null;
  /** Desde cuándo espera en la sucursal (llegada, o el ingreso a la subetapa). */
  waitingSince: string | null;
  /** Días calendario de Lima esperando. */
  waitingDays: number | null;
  /** Vencimiento de la agencia (Olva lo informa; Shalom no). */
  expiresAt: string | null;
  expired: boolean;
  lastGestion: PagoDiferenciaGestion | null;
  gestionCount: number;
  /** ¿Ya lo gestionó alguien HOY (día de Lima)? */
  gestionadoHoy: boolean;
}

/** El día calendario de Lima de un instante, `AAAA-MM-DD`. */
export function limaDayOf(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Lima", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

function daysBetween(fromDay: string, toDay: string): number | null {
  if (!fromDay || !toDay) return null;
  const a = Date.parse(`${fromDay}T00:00:00Z`);
  const b = Date.parse(`${toDay}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.round((b - a) / 86_400_000));
}

function cents(value: number | string | null | undefined): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : 0;
}

function photoCount(payload: Record<string, unknown> | null | undefined): number {
  const photos = payload && (payload as { photos?: unknown }).photos;
  return Array.isArray(photos) ? photos.filter((p) => typeof p === "string" && p).length : 0;
}

/** ¿Es este hecho una gestión de una persona? */
export function isPagoDiferenciaGestion(e: Pick<PagoDiferenciaEventInput, "kind" | "actor"> & { comment_type?: string | null }): boolean {
  if (!e.actor || !(PAGO_DIFERENCIA_GESTION_KINDS as readonly string[]).includes(e.kind)) return false;
  // La nota que deja corregir la dirección (`comment_type = 'ubicacion'`,
  // lib/order-address-correction.ts) es un arreglo del pedido, no un contacto.
  return !(e.kind === "comment" && e.comment_type?.trim().toLowerCase() === "ubicacion");
}

/**
 * Arma las filas. Orden: primero lo que NADIE gestionó hoy; dentro, lo vencido
 * o por vencer, luego lo que lleva más tiempo esperando.
 */
export function buildPagoDiferenciaRows(input: {
  orders: readonly PagoDiferenciaOrderInput[];
  payments: readonly PagoDiferenciaPaymentInput[];
  events: readonly PagoDiferenciaEventInput[];
  names: ReadonlyMap<string, string>;
  now: Date;
}): PagoDiferenciaRow[] {
  const today = limaDayOf(input.now.toISOString());
  const paymentsBy = new Map<string, PagoDiferenciaPaymentInput[]>();
  for (const p of input.payments) paymentsBy.set(p.order_id, [...(paymentsBy.get(p.order_id) ?? []), p]);
  const gestionesBy = new Map<string, PagoDiferenciaEventInput[]>();
  for (const e of input.events) {
    if (!isPagoDiferenciaGestion(e)) continue;
    gestionesBy.set(e.order_id, [...(gestionesBy.get(e.order_id) ?? []), e]);
  }

  const rows = input.orders.flatMap((o): PagoDiferenciaRow[] => {
    const group = pagoDiferenciaGroup(o);
    if (!group) return [];
    const live = (paymentsBy.get(o.order_id) ?? []).filter((p) => p.validation_status !== "rechazado");
    const validatedCents = live.filter((p) => p.validation_status === "validado").reduce((s, p) => s + cents(p.amount), 0);
    const totalCents = cents(o.order_total);
    // Menos de S/ 1 es redondeo (lib/payment-rounding.ts): no es saldo.
    const remainingCents = totalCents > 0 ? Math.max(0, totalCents - validatedCents) : null;
    const remaining = remainingCents === null ? null : remainingCents < 100 ? 0 : remainingCents / 100;

    const gestiones = (gestionesBy.get(o.order_id) ?? []).slice().sort((a, b) => (a.occurred_at < b.occurred_at ? 1 : -1));
    const last = gestiones[0] ?? null;
    // En agencia: desde la llegada a la sucursal; en los otros, desde que
    // entró a su subetapa (en Retornando, desde que salió de la agencia).
    const waitingSince = group === "en_agencia" ? (o.agency_arrived_at ?? o.macro_since) : o.macro_since;
    return [{
      orderId: o.order_id,
      group,
      substage: group === "en_camino" ? (o.macro_substage === "en_destino" ? "En destino" : "En tránsito") : null,
      storeId: o.store_id,
      orderName: o.order_name ?? o.order_id,
      customerName: o.customer_name,
      customerPhone: o.customer_phone,
      orderTotal: totalCents > 0 ? totalCents / 100 : null,
      paidValidated: validatedCents / 100,
      remaining,
      paymentToValidate: live.some((p) => p.validation_status !== "validado"),
      courier: o.current_courier,
      guideCode: o.guide_code,
      destination: o.agency_branch ?? ([o.district, o.province].filter(Boolean).join(", ") || null),
      waitingSince,
      waitingDays: waitingSince ? daysBetween(limaDayOf(waitingSince), today) : null,
      expiresAt: o.agency_expires_at,
      expired: group === "en_agencia" && Boolean(o.agency_expires_at && Date.parse(o.agency_expires_at) < input.now.getTime()),
      lastGestion: last
        ? {
            at: last.occurred_at,
            actorName: last.actor ? (input.names.get(last.actor) ?? null) : null,
            channel: GESTION_LABEL[last.kind] ?? last.kind,
            commentType: last.kind === "comment" ? last.comment_type?.trim() || null : null,
            note: last.note?.trim() || null,
            photoCount: photoCount(last.payload),
          }
        : null,
      gestionCount: gestiones.length,
      gestionadoHoy: Boolean(last && limaDayOf(last.occurred_at) === today),
    }];
  });

  const expiry = (r: PagoDiferenciaRow) => (r.expiresAt ? Date.parse(r.expiresAt) : Number.POSITIVE_INFINITY);
  return rows.sort(
    (a, b) =>
      Number(a.gestionadoHoy) - Number(b.gestionadoHoy) ||
      expiry(a) - expiry(b) ||
      (b.waitingDays ?? -1) - (a.waitingDays ?? -1) ||
      a.orderName.localeCompare(b.orderName),
  );
}

export type PagoDiferenciaFilter = "por_gestionar" | "gestionados_hoy" | "sin_gestion" | "todos";

export const PAGO_DIFERENCIA_FILTER_LABEL: Record<PagoDiferenciaFilter, string> = {
  por_gestionar: "Por gestionar hoy",
  gestionados_hoy: "Gestionados hoy",
  sin_gestion: "Nunca gestionados",
  todos: "Todos",
};

export function filterPagoDiferencia(rows: readonly PagoDiferenciaRow[], filter: PagoDiferenciaFilter): PagoDiferenciaRow[] {
  if (filter === "por_gestionar") return rows.filter((r) => !r.gestionadoHoy);
  if (filter === "gestionados_hoy") return rows.filter((r) => r.gestionadoHoy);
  if (filter === "sin_gestion") return rows.filter((r) => r.gestionCount === 0);
  return [...rows];
}
