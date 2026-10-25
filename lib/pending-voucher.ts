// «Comprobante por validar»: la clienta ya mandó su pago y espera a una persona.
//
// POR QUÉ EXISTE (owner, 25-10-2026, #KP143616). La clienta depositó la
// diferencia, el comprobante entró por WhatsApp a la cobranza de Shalom y quedó
// «Pendiente de revisión»; escaló tres veces y ella seguía esperando su clave.
// El único aviso era el pop-up flotante de la cola de cobranza
// (components/collection-alerts.tsx) y la bandeja «Validar pagos». En el Master
// y en Leads, donde trabaja casi todo el equipo, ese pedido no se distinguía de
// ningún otro. MOM §16.1, «Un comprobante por validar se ve…».
//
// UNA SOLA DEFINICIÓN, LA DE LA ALERTA. El pop-up se cierra con el HECHO que lo
// resuelve (`sweepResolvedAlerts`): mientras el pago siga en
// `pendiente_revision` o `info_incompleta` hay una persona que tiene que
// decidir; cualquier otro estado —validado, rechazado, observado— ya es una
// decisión. El indicador del Master y el motivo de Leads leen ESTA lista, así
// que aparecen y desaparecen a la vez que el pop-up y nadie tiene que
// apagarlos a mano.
//
// SOLO LO QUE PAGA LA CLIENTA. `cobro_courier` es el efectivo que remite el
// motorizado (§9.4): lo revisa finanzas, no espera ninguna clave y no hay
// clienta del otro lado a quien atender.
//
// Puro: sin Supabase, para poder probarlo. La lectura vive en
// lib/pending-voucher-access.ts.

import { usesPickupKeyFlow } from "@/lib/pickup-key";
import { MASTER_OPEN_PARAM, MASTER_PATH } from "@/lib/order-drawer-href";

/** Estados de un pago que siguen esperando a una persona (los mismos que mantienen abierta la alerta). */
export const VOUCHER_AWAITING_STATUSES = ["pendiente_revision", "info_incompleta"] as const;

/** Los tipos de pago que manda la clienta. `cobro_courier` no entra. */
export const CUSTOMER_PAYMENT_KINDS = ["adelanto", "diferencia", "total"] as const;

/** El nombre del indicador, igual en el Master, en Leads y en el pop-up. */
export const PENDING_VOUCHER_LABEL = "Comprobante por validar";

/** ¿Este pago está esperando a que alguien lo valide o lo rechace? Pura. */
export function isAwaitingVoucher(payment: { kind: string; validation_status: string }): boolean {
  return (
    (CUSTOMER_PAYMENT_KINDS as readonly string[]).includes(payment.kind) &&
    (VOUCHER_AWAITING_STATUSES as readonly string[]).includes(payment.validation_status)
  );
}

export interface PendingVoucherPayment {
  order_id: string;
  kind: string;
  validation_status: string;
  amount: number | string | null;
  registered_at: string | null;
}

/** Lo que el Master y Leads necesitan saber del pedido: cuántos, cuánto y desde cuándo. */
export interface PendingVoucherSummary {
  count: number;
  /** Suma de los comprobantes por validar (un comprobante sin monto suma cero). */
  amount: number;
  /** El más antiguo: es lo que lleva esperando la clienta. */
  since: string | null;
}

/**
 * Los pedidos con comprobante por validar, a partir de sus pagos. Ignora lo
 * que no espera a nadie, así que se le puede pasar cualquier lista. Pura.
 */
export function indexPendingVouchers(
  payments: readonly PendingVoucherPayment[],
): Map<string, PendingVoucherSummary> {
  const out = new Map<string, PendingVoucherSummary>();
  for (const p of payments) {
    if (!p.order_id || !isAwaitingVoucher(p)) continue;
    const prev = out.get(p.order_id) ?? { count: 0, amount: 0, since: null };
    const amount = Number(p.amount);
    const since =
      prev.since === null ? p.registered_at : p.registered_at && p.registered_at < prev.since ? p.registered_at : prev.since;
    out.set(p.order_id, {
      count: prev.count + 1,
      amount: Math.round((prev.amount + (Number.isFinite(amount) && amount > 0 ? amount : 0)) * 100) / 100,
      since,
    });
  }
  return out;
}

/**
 * ¿La clienta está esperando su clave de recojo? Solo en el flujo de agencia
 * (Shalom u otra agencia, `usesPickupKeyFlow`) y mientras la clave no se le haya
 * enviado. Fuera de ese flujo no hay clave que esperar, y decirlo sería
 * inventarle a la asesora una promesa que nadie hizo. Pura.
 */
export function awaitsPickupKey(order: {
  current_courier?: string | null;
  shipping_mode?: string | null;
  key_state?: string | null;
}): boolean {
  if (order.key_state === "clave_enviada") return false;
  return usesPickupKeyFlow(order.current_courier ?? null, order.shipping_mode ?? null);
}

/** El motivo que lee la asesora en «Atender ahora». Pura. */
export function pendingVoucherReason(awaitsKey: boolean): string {
  return awaitsKey ? `${PENDING_VOUCHER_LABEL} · espera su clave` : PENDING_VOUCHER_LABEL;
}

/** El título (tooltip) del indicador del Master: cuánto, desde cuándo y dónde se resuelve. Pura. */
export function pendingVoucherHint(summary: PendingVoucherSummary, awaitsKey: boolean): string {
  const cuantos = summary.count === 1 ? "1 comprobante" : `${summary.count} comprobantes`;
  const monto = summary.amount > 0 ? ` por S/ ${summary.amount.toFixed(2)}` : "";
  const accion = awaitsKey ? "Validar y enviar la clave, en Cobro" : "Validar en Cobro";
  return `${cuantos}${monto} esperando validación. ${accion}.`;
}

/**
 * Los pedidos con comprobante por validar que tiene que traer el filtro del
 * Master. Sin ninguno (o si la lectura falló) el filtro no puede quedarse sin
 * efecto —traería TODOS los pedidos bajo un título que dice lo contrario—, así
 * que pide un id que no existe y la lista sale vacía.
 */
export const NO_ORDER_ID = "00000000-0000-0000-0000-000000000000";

export function pendingVoucherFilterIds(ids: readonly string[] | null | undefined): string[] {
  return ids && ids.length ? [...ids] : [NO_ORDER_ID];
}

/**
 * El orden de «Atender ahora» con los comprobantes por validar delante.
 *
 * NO toca el puntaje de Por llamar (lib/lead-priority.ts): esa escala es una
 * probabilidad de cierre medida y su cabecera prohíbe sumarle empujones. Esto
 * es una llave APARTE, como pide esa misma nota: primero quien ya pagó y espera
 * —el más antiguo arriba, igual que el resto de la vista—, y debajo los
 * handoffs en el orden en que llegaron, sin reordenarlos. Pura y estable.
 */
export function sortHandoffWithPendingVouchers<T extends { id: string; pending_voucher?: { since: string | null } | null }>(
  leads: readonly T[],
): T[] {
  const withVoucher = leads.filter((l) => l.pending_voucher);
  const rest = leads.filter((l) => !l.pending_voucher);
  const key = (l: T) => l.pending_voucher?.since ?? "";
  withVoucher.sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    // Sin fecha va al final de su grupo: no se puede afirmar que lleve más.
    if (ka !== kb) return !ka ? 1 : !kb ? -1 : ka < kb ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return [...withVoucher, ...rest];
}

/**
 * Le pone a cada fila del Master su comprobante por validar, si lo tiene. Una
 * pasada en memoria sobre las 100 filas de la página con el índice que ya se
 * leyó: ni una consulta por fila. Sin índice (la lectura falló) deja las filas
 * como estaban, sin afirmar que no hay. Pura.
 */
export function withPendingVouchers<T extends { order_id: string }>(
  rows: readonly T[],
  index: ReadonlyMap<string, PendingVoucherSummary> | null,
): (T & { pending_voucher?: PendingVoucherSummary | null })[] {
  if (!index) return [...rows];
  return rows.map((r) => ({ ...r, pending_voucher: index.get(r.order_id) ?? null }));
}

/**
 * A la ficha del pedido en Cobro, donde está «Validar y enviar la clave». El
 * mismo enlace que el pop-up de cobranza («Ir a validar»). Pura.
 */
export function pendingVoucherHref(orderId: string): string {
  return `${MASTER_PATH}?${MASTER_OPEN_PARAM}=${encodeURIComponent(orderId)}&ir=pagos`;
}
