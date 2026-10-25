// Lecturas de «Comprobante por validar» (MOM §16.1). La regla vive en
// lib/pending-voucher.ts; aquí solo se trae lo que necesita.
//
// SE LEE EN VIVO DE `order_payments`, NO DEL MASTER. La cobranza de WhatsApp
// (lib/shalom/voucher-intake.ts) registra el pago sin recalcular `order_master`,
// y es exactamente el camino del caso que motivó esto (#KP143616): un indicador
// materializado habría salido tarde en el único pedido que importaba. La
// consulta va por `order_payments_store_idx (store_id, validation_status)` y
// devuelve unas decenas de filas (20 pedidos el 25-10-2026), así que se paga
// UNA vez por carga del Master o de «Atender ahora», no una por fila.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { LeadPendingVoucher } from "@/lib/types";
import {
  CUSTOMER_PAYMENT_KINDS,
  VOUCHER_AWAITING_STATUSES,
  awaitsPickupKey,
  indexPendingVouchers,
  pendingVoucherReason,
  type PendingVoucherPayment,
  type PendingVoucherSummary,
} from "@/lib/pending-voucher";

/** Tope de seguridad: con más de esto la bandeja tiene un problema mayor que este indicador. */
const MAX_PENDING = 2000;
/** Lotes para los `.in(...)` de ids: URLs demasiado largas fallan (como en lib/order-master.ts). */
const ID_BATCH = 200;

/**
 * Los pedidos con comprobante por validar en estas tiendas, o `null` si la
 * lectura falló. Null NO es «no hay»: quien lo recibe no puede afirmar que
 * ningún pedido espera (MOM §12, «Una lectura fallida no es una respuesta»).
 */
export async function loadPendingVouchers(
  sb: SupabaseClient,
  storeIds: readonly string[],
): Promise<Map<string, PendingVoucherSummary> | null> {
  if (!storeIds.length) return new Map();
  try {
    const { data, error } = await sb
      .from("order_payments")
      .select("order_id,kind,validation_status,amount,registered_at")
      .in("store_id", [...storeIds])
      .in("validation_status", [...VOUCHER_AWAITING_STATUSES])
      .in("kind", [...CUSTOMER_PAYMENT_KINDS])
      .limit(MAX_PENDING);
    if (error) {
      console.error("[pending-voucher] order_payments", error.code, error.message);
      return null;
    }
    return indexPendingVouchers((data ?? []) as PendingVoucherPayment[]);
  } catch (e) {
    console.error("[pending-voucher] order_payments", e);
    return null;
  }
}

function chunk<T>(values: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < values.length; i += size) out.push(values.slice(i, i + size));
  return out;
}

/**
 * Los leads de esos pedidos, con su motivo, para subirlos en «Atender ahora».
 *
 * Por `leads.order_id`, el vínculo que deja la venta. Un lead que no quedó
 * atado a su pedido no se encuentra: no se adivina por teléfono, porque el
 * mismo celular puede tener otro lead en otra tienda o de otra compra, y
 * subirlo con un «espera su clave» ajeno sería peor que no subirlo (MOM §16.1).
 *
 * Dos consultas en paralelo sobre unas decenas de ids: los leads y, del Master,
 * lo justo para saber si espera una clave. `select` es el de la vista, para que
 * la fila llegue igual que las demás.
 */
export async function loadPendingVoucherLeads<T extends { id: string; order_id: string | null }>(
  sb: SupabaseClient,
  storeIds: readonly string[],
  index: ReadonlyMap<string, PendingVoucherSummary>,
  select: string,
): Promise<(T & { pending_voucher: LeadPendingVoucher })[]> {
  const orderIds = [...index.keys()];
  if (!orderIds.length || !storeIds.length) return [];
  const batches = chunk(orderIds, ID_BATCH);
  const leadSelect = select.split(",").includes("order_id") ? select : `${select},order_id`;
  const [leadPages, masterPages] = await Promise.all([
    Promise.all(
      batches.map((ids) => sb.from("leads").select(leadSelect).in("store_id", [...storeIds]).in("order_id", ids)),
    ),
    Promise.all(
      batches.map((ids) =>
        sb
          .from("order_master")
          .select("order_id,order_name,current_courier,shipping_mode,key_state")
          .in("order_id", ids),
      ),
    ),
  ]);
  const master = new Map<
    string,
    { order_name: string | null; current_courier: string | null; shipping_mode: string | null; key_state: string | null }
  >();
  for (const page of masterPages) {
    for (const m of (page.data ?? []) as {
      order_id: string;
      order_name: string | null;
      current_courier: string | null;
      shipping_mode: string | null;
      key_state: string | null;
    }[]) {
      master.set(m.order_id, m);
    }
  }
  const out: (T & { pending_voucher: LeadPendingVoucher })[] = [];
  for (const page of leadPages) {
    if (page.error) {
      console.error("[pending-voucher] leads", page.error.code, page.error.message);
      continue;
    }
    for (const lead of (page.data ?? []) as unknown as T[]) {
      const summary = lead.order_id ? index.get(lead.order_id) : undefined;
      if (!summary || !lead.order_id) continue;
      const m = master.get(lead.order_id);
      out.push({
        ...lead,
        pending_voucher: {
          orderId: lead.order_id,
          orderName: m?.order_name ?? null,
          // Sin la fila del Master no se sabe si es de agencia: se dice lo
          // seguro, sin prometer una clave.
          reason: pendingVoucherReason(m ? awaitsPickupKey(m) : false),
          amount: summary.amount,
          since: summary.since,
        },
      });
    }
  }
  return out;
}

/**
 * Cuántos leads suben a «Atender ahora» por un comprobante por validar y NO
 * estaban ya ahí por un handoff fresco: lo que hay que sumarle al contador de
 * la pestaña para que diga lo mismo que la lista. 0 si algo falla: el contador
 * vuelve a ser el de siempre, que no miente sobre los handoffs.
 */
export async function countExtraPendingVoucherLeads(
  sb: SupabaseClient,
  storeIds: readonly string[],
  handoffCutoffIso: string,
): Promise<{ extra: number; signature: string }> {
  const index = await loadPendingVouchers(sb, storeIds);
  // Firma vacía cuando no hay nadie: la de la cola queda idéntica a la de antes.
  if (!index || !index.size) return { extra: 0, signature: "" };
  let extra = 0;
  const ids: string[] = [];
  for (const batch of chunk([...index.keys()], ID_BATCH)) {
    const { data, error } = await sb
      .from("leads")
      .select("id,needs_attention,handoff_at")
      .in("store_id", [...storeIds])
      .in("order_id", batch);
    if (error) return { extra: 0, signature: "" };
    for (const l of (data ?? []) as { id: string; needs_attention: boolean; handoff_at: string | null }[]) {
      ids.push(l.id);
      const yaEsta =
        l.needs_attention && !!l.handoff_at && Date.parse(l.handoff_at) >= Date.parse(handoffCutoffIso);
      if (!yaEsta) extra++;
    }
  }
  // La firma cambia cuando entra o sale un lead por comprobante: el refresco en
  // vivo de Leads compara firmas y, sin esto, no se enteraría de que se validó.
  if (!ids.length) return { extra: 0, signature: "" };
  return { extra, signature: `${ids.length}:${hash(ids.sort().join("."))}` };
}

/** Huella corta y estable de una cadena (djb2). No es seguridad: solo detectar cambios. */
function hash(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}
