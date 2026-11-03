// Lectura de «Pagado sin aviso» (MOM §12). La regla vive en
// lib/agency-pickup-alert.ts; aquí solo se trae lo que necesita.
//
// DOS CONSULTAS POR CARGA, NO UNA POR FILA. Primero, del Master, los pedidos
// pagados que siguen en la agencia con el plazo por vencer o vencido: medido el
// 25-10-2026 eran 4 (el filtro deja casi todo fuera: hace falta fecha de
// vencimiento, que solo deja el rastreo). Después, de la cola de avisos, cuáles
// de ESOS tienen un aviso de llegada enviado. Con el conjunto se decoran las 100
// filas de la página, se cuenta la píldora y se resuelve el filtro.

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  AGENCY_DEADLINE_ALERT_MS,
  ARRIVAL_NOTICE_KINDS,
  UNNOTIFIED_PICKUP_STATES,
  paidUnnotifiedCandidate,
  paidUnnotifiedOrderIds,
} from "@/lib/agency-pickup-alert";

/** Tope de seguridad: con más de esto el problema es otro. */
const MAX_CANDIDATES = 2000;
/** Lotes para los `.in(...)` de ids: URLs demasiado largas fallan. */
const ID_BATCH = 200;

/**
 * Los pedidos «Pagado sin aviso» de estas tiendas, o `null` si alguna lectura
 * falló. Null NO es «no hay» (MOM §12, «Una lectura fallida no es una
 * respuesta»): la píldora no enseña un cero y el filtro no trae ninguno.
 */
export async function loadPaidUnnotified(
  sb: SupabaseClient,
  storeIds: readonly string[],
  now: Date = new Date(),
): Promise<Set<string> | null> {
  if (!storeIds.length) return new Set();
  const nowIso = now.toISOString();
  try {
    const limit = new Date(now.getTime() + AGENCY_DEADLINE_ALERT_MS).toISOString();
    const { data, error } = await sb
      .from("order_master")
      .select("order_id,pickup_state,agency_expires_at,payment_state")
      .in("store_id", [...storeIds])
      .in("pickup_state", [...UNNOTIFIED_PICKUP_STATES])
      .eq("payment_state", "pago_completo")
      .not("agency_expires_at", "is", null)
      .lte("agency_expires_at", limit)
      .limit(MAX_CANDIDATES);
    if (error) {
      console.error("[paid-unnotified] order_master", error.code, error.message);
      return null;
    }
    // La misma regla, en memoria: la consulta solo acota.
    const candidates = ((data ?? []) as {
      order_id: string;
      pickup_state: string | null;
      agency_expires_at: string | null;
      payment_state: string | null;
    }[]).filter((r) => paidUnnotifiedCandidate(r, nowIso));
    if (!candidates.length) return new Set();

    const notified = new Set<string>();
    const ids = [...new Set(candidates.map((c) => c.order_id))];
    for (let i = 0; i < ids.length; i += ID_BATCH) {
      const { data: sent, error: sentErr } = await sb
        .from("shalom_transit_notifications")
        .select("order_id")
        .in("order_id", ids.slice(i, i + ID_BATCH))
        .in("kind", [...ARRIVAL_NOTICE_KINDS])
        .eq("status", "sent");
      if (sentErr) {
        console.error("[paid-unnotified] shalom_transit_notifications", sentErr.code, sentErr.message);
        return null;
      }
      for (const r of (sent ?? []) as { order_id: string | null }[]) if (r.order_id) notified.add(r.order_id);
    }
    return new Set(paidUnnotifiedOrderIds(candidates, notified));
  } catch (e) {
    console.error("[paid-unnotified]", e);
    return null;
  }
}
