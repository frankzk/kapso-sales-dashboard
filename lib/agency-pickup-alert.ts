// El plazo de la agencia en el Master: «vence pronto» en la fila y «Pagado sin
// aviso» como filtro rápido (MOM §12, «El plazo de la agencia en el Master»,
// decisión del owner del 25-10-2026).
//
// POR QUÉ EXISTE. Un paquete en la oficina de Olva vuelve a Lima a los 6 días.
// La clienta que ya pagó todo no recibía el aviso de llegada —es de cobro—, y en
// Olva no hay clave que le haya dicho «preséntala cuando llegue»: no se entera
// (#KP141593, #KP142910, #KP140003). Desde la 0281 le sale su propio aviso, pero
// mientras esa plantilla no esté aprobada —o si el envío falla— alguien tiene
// que verlo en el Master antes de que venza. Vale igual para Shalom cuando el
// rastreo dejó la fecha de vencimiento.
//
// NO ES UN ESTADO NUEVO. Lee lo que el Master ya tiene: `pickup_state`,
// `agency_expires_at` (lo que hace funcionar «Próximos a vencer») y
// `payment_state = 'pago_completo'` (que ya incluye lo pagado en el checkout,
// lib/order-paid.ts). Lo único que no está en el Master es «nadie le avisó»,
// que se lee de la cola de avisos (lib/agency-pickup-alert-access.ts).
//
// Puro: sin Supabase, para poder probarlo.

import type { OrderMasterRow } from "@/lib/types";
import { canStillExpire } from "@/lib/order-master-filters";
import { limaDayKey } from "@/lib/order-confirmation";
import { NO_ORDER_ID } from "@/lib/pending-voucher";

/**
 * El margen con el que un plazo se considera «próximo a vencer»: el MISMO que
 * cuentan la píldora y el filtro «Próximos a vencer» del servidor
 * (lib/orders-master-access.ts). Así «Pagado sin aviso» es siempre un subconjunto
 * de lo que esa píldora cuenta.
 */
export const AGENCY_DEADLINE_ALERT_MS = 2 * 86_400_000;

/** El nombre del filtro y de la chapa, igual en los dos sitios. */
export const PAID_UNNOTIFIED_LABEL = "Pagado sin aviso";

/**
 * Los sub-estados de «sigue en la agencia» en los que NADIE HA DICHO que se le
 * avisó. `cliente_notificado` lo declara el courier («notificado», «avisado»,
 * lib/couriers/agency.ts): ahí ya hubo aviso.
 */
export const UNNOTIFIED_PICKUP_STATES = ["disponible_para_recojo", "pendiente_de_recojo", "proximo_a_vencer"] as const;

/**
 * Los avisos de la cola que le dicen a la clienta que su paquete YA ESTÁ en la
 * agencia: el de llegada (con cobro o, desde la 0281, el de pagados de Olva,
 * que viaja en la misma fila) y los recordatorios de recojo. El de tránsito no:
 * dice que va en camino.
 */
export const ARRIVAL_NOTICE_KINDS = ["disponible", "recordatorio_d3", "recordatorio_d7"] as const;

type DeadlineRow = Pick<OrderMasterRow, "pickup_state" | "agency_expires_at">;

/**
 * ¿El plazo de la agencia vence pronto o ya venció, con el paquete todavía en
 * la agencia? `canStillExpire` es la misma guarda de «Próximos a vencer»: un
 * pedido recogido o entregado conserva la fecha pero ya no vence. Pura.
 */
export function agencyDeadlineSoon(row: DeadlineRow, nowIso: string): boolean {
  if (!canStillExpire(row)) return false;
  const left = Date.parse(row.agency_expires_at!) - Date.parse(nowIso);
  return Number.isFinite(left) && left <= AGENCY_DEADLINE_ALERT_MS;
}

/**
 * ¿Es candidato a «Pagado sin aviso» con lo que ya dice el Master? Falta mirar
 * la cola de avisos para saber si de verdad nadie le avisó. Pura.
 */
export function paidUnnotifiedCandidate(
  row: DeadlineRow & Pick<OrderMasterRow, "payment_state">,
  nowIso: string,
): boolean {
  if (row.payment_state !== "pago_completo") return false;
  if (!(UNNOTIFIED_PICKUP_STATES as readonly string[]).includes(row.pickup_state ?? "")) return false;
  return agencyDeadlineSoon(row, nowIso);
}

/** Los candidatos que no tienen ningún aviso de llegada enviado. Pura. */
export function paidUnnotifiedOrderIds(
  candidates: readonly { order_id: string }[],
  notifiedOrderIds: ReadonlySet<string>,
): string[] {
  const out = new Set<string>();
  for (const c of candidates) if (c.order_id && !notifiedOrderIds.has(c.order_id)) out.add(c.order_id);
  return [...out];
}

/**
 * Le pone a cada fila de la página si es «Pagado sin aviso». Una pasada en
 * memoria con el conjunto que ya se leyó: ni una consulta por fila. Sin
 * conjunto (la lectura falló) deja las filas como estaban. Pura.
 */
export function withPaidUnnotified<T extends { order_id: string }>(
  rows: readonly T[],
  ids: ReadonlySet<string> | null,
): (T & { paid_unnotified?: boolean })[] {
  if (!ids) return [...rows];
  return rows.map((r) => ({ ...r, paid_unnotified: ids.has(r.order_id) }));
}

/** Como el de «Comprobante por validar»: sin pedidos (o sin lectura), ninguno, nunca todos. */
export function paidUnnotifiedFilterIds(ids: readonly string[] | null | undefined): string[] {
  return ids && ids.length ? [...ids] : [NO_ORDER_ID];
}

export interface AgencyDeadlineBadge {
  tone: "warn" | "crit";
  text: string;
  title: string;
}

/**
 * La chapa de la fila: cuándo vence el plazo de la agencia. `null` si no vence
 * pronto. En crítico lo vencido y lo pagado sin aviso —la clienta pagó y puede
 * perder el paquete sin saber que llegó—; en atención el resto. Pura.
 */
export function agencyDeadlineBadge(
  row: DeadlineRow & { paid_unnotified?: boolean | null },
  nowIso: string,
): AgencyDeadlineBadge | null {
  if (!agencyDeadlineSoon(row, nowIso)) return null;
  const expires = row.agency_expires_at!;
  const venceMs = Date.parse(expires);
  const vencido = venceMs <= Date.parse(nowIso);
  const hoy = limaDayKey(nowIso);
  const dia = limaDayKey(expires);
  const manana = limaDayKey(new Date(Date.parse(`${hoy}T12:00:00-05:00`) + 86_400_000).toISOString());
  const plazo = vencido ? "Plazo vencido" : dia === hoy ? "Vence hoy" : dia === manana ? "Vence mañana" : "Vence pronto";
  const fecha = new Intl.DateTimeFormat("es-PE", { timeZone: "America/Lima", day: "numeric", month: "long" }).format(
    new Date(venceMs),
  );
  if (row.paid_unnotified) {
    return {
      tone: "crit",
      text: `${PAID_UNNOTIFIED_LABEL} · ${plazo.toLowerCase()}`,
      title: `Ya pagó y no tiene ningún aviso de llegada enviado. La agencia lo guarda hasta el ${fecha}: avísale que lo recoja con su DNI.`,
    };
  }
  return {
    tone: vencido ? "crit" : "warn",
    text: plazo,
    title: vencido
      ? `El plazo de la agencia venció el ${fecha}: si nadie lo recoge, lo devuelve.`
      : `La agencia lo guarda hasta el ${fecha}.`,
  };
}
