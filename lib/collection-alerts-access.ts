// La cola de cobranza: levantar alertas, moverlas por la escalera y cerrarlas.
//
// Las decisiones de a-quién-le-toca viven en `lib/collection-escalation.ts`,
// que es puro. Aquí solo está lo que toca la base.

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  nextOffer,
  passToNext,
  type AlertRouting,
  type EscalationStep,
} from "@/lib/collection-escalation";

export type CollectionAlertKind = "registrado" | "sin_atribuir";

export interface RaiseAlertInput {
  storeId: string;
  kind: CollectionAlertKind;
  orderId?: string | null;
  paymentId?: string | null;
  phone?: string | null;
  inboundMessageId?: string | null;
  amount?: number | null;
  detail?: string | null;
}

/** La escalera de la tienda, en orden. Vacía si nadie la configuró. */
export async function loadEscalation(
  admin: SupabaseClient,
  storeId: string,
): Promise<EscalationStep[]> {
  const { data } = await admin
    .from("store_collection_escalation")
    .select("user_id,minutes,sort")
    .eq("store_id", storeId)
    .order("sort", { ascending: true });
  return ((data ?? []) as { user_id: string; minutes: number }[]).map((r) => ({
    userId: r.user_id,
    minutes: r.minutes,
  }));
}

/**
 * Levanta una alerta y se la ofrece al primero de la escalera. Idempotente por
 * mensaje entrante: Kapso reentrega webhooks, y dos alertas del mismo
 * comprobante son dos personas mirando lo mismo.
 *
 * Nunca lanza: esto cuelga del webhook, y que falle la alerta no puede tumbar
 * el registro del comprobante, que es lo importante.
 */
export async function raiseCollectionAlert(
  admin: SupabaseClient,
  input: RaiseAlertInput,
  nowIso: string = new Date().toISOString(),
): Promise<string | null> {
  try {
    const ladder = await loadEscalation(admin, input.storeId);
    // Sin escalera se crea igual, sin dueño: la alerta existe y se ve en la
    // cola de la tienda. Perderla porque nadie configuró Ajustes sería el peor
    // de los dos errores.
    const primero = ladder[0]?.userId ?? null;
    const { data, error } = await admin
      .from("collection_alerts")
      .insert({
        store_id: input.storeId,
        kind: input.kind,
        order_id: input.orderId ?? null,
        payment_id: input.paymentId ?? null,
        phone: input.phone ?? null,
        inbound_message_id: input.inboundMessageId ?? null,
        amount: input.amount ?? null,
        detail: input.detail ?? null,
        offered_to: primero,
        offered_at: primero ? nowIso : null,
      })
      .select("id")
      .single();
    if (error) return null; // 23505 = reentrega del mismo webhook; nada que hacer
    return (data as { id: string } | null)?.id ?? null;
  } catch {
    return null;
  }
}

/**
 * Hace avanzar la escalera de las alertas abiertas de una tienda. Se llama
 * antes de pintar la cola: así el escalamiento ocurre aunque no haya ningún
 * cron mirando, y el que abre la pantalla ve el estado de verdad.
 */
export async function reconcileCollectionOffers(
  admin: SupabaseClient,
  storeId: string,
  nowMs: number = Date.now(),
): Promise<number> {
  const ladder = await loadEscalation(admin, storeId);
  if (!ladder.length) return 0;
  const { data } = await admin
    .from("collection_alerts")
    .select("id,offered_to,offered_at,passed,claimed_by")
    .eq("store_id", storeId)
    .eq("status", "abierta")
    .limit(200);
  const rows = (data ?? []) as {
    id: string;
    offered_to: string | null;
    offered_at: string | null;
    passed: string[] | null;
    claimed_by: string | null;
  }[];

  let movidas = 0;
  const nowIso = new Date(nowMs).toISOString();
  for (const r of rows) {
    const routing: AlertRouting = {
      offeredTo: r.offered_to,
      offeredAt: r.offered_at,
      passed: r.passed ?? [],
      claimedBy: r.claimed_by,
    };
    const decision = nextOffer(routing, ladder, nowMs);
    if (!decision) continue;
    // La guarda por `offered_at` hace el cambio atómico: si dos pantallas
    // reconcilian a la vez, la segunda ya no encuentra la fila como estaba.
    const q = admin
      .from("collection_alerts")
      .update({ offered_to: decision.offeredTo, offered_at: nowIso, passed: decision.passed, updated_at: nowIso })
      .eq("id", r.id);
    const { error } = await (r.offered_at ? q.eq("offered_at", r.offered_at) : q.is("offered_at", null));
    if (!error) movidas += 1;
  }
  return movidas;
}

/** «Es mía»: la reclama para que salga de la cola de los demás. */
export async function claimCollectionAlert(
  admin: SupabaseClient,
  alertId: string,
  userId: string,
  nowIso: string = new Date().toISOString(),
): Promise<boolean> {
  const { error } = await admin
    .from("collection_alerts")
    .update({ claimed_by: userId, claimed_at: nowIso, updated_at: nowIso })
    .eq("id", alertId)
    .is("claimed_by", null); // atómico: el segundo que pulse no gana
  return !error;
}

/** «No es mía»: sube ya al siguiente, sin esperar sus minutos. */
export async function passCollectionAlert(
  admin: SupabaseClient,
  storeId: string,
  alertId: string,
  nowIso: string = new Date().toISOString(),
): Promise<boolean> {
  const ladder = await loadEscalation(admin, storeId);
  const { data } = await admin
    .from("collection_alerts")
    .select("offered_to,offered_at,passed,claimed_by")
    .eq("id", alertId)
    .maybeSingle();
  const r = data as {
    offered_to: string | null;
    offered_at: string | null;
    passed: string[] | null;
    claimed_by: string | null;
  } | null;
  if (!r) return false;
  const decision = passToNext(
    { offeredTo: r.offered_to, offeredAt: r.offered_at, passed: r.passed ?? [], claimedBy: r.claimed_by },
    ladder,
  );
  if (!decision) return false;
  const { error } = await admin
    .from("collection_alerts")
    .update({ offered_to: decision.offeredTo, offered_at: nowIso, passed: decision.passed, updated_at: nowIso })
    .eq("id", alertId);
  return !error;
}

/** Cerrarla: validada, subida a mano, o descartada con su motivo. */
export async function resolveCollectionAlert(
  admin: SupabaseClient,
  alertId: string,
  userId: string,
  resolution: string,
  status: "atendida" | "descartada" = "atendida",
  nowIso: string = new Date().toISOString(),
): Promise<boolean> {
  const { error } = await admin
    .from("collection_alerts")
    .update({ status, resolution, resolved_by: userId, resolved_at: nowIso, updated_at: nowIso })
    .eq("id", alertId)
    .eq("status", "abierta");
  return !error;
}
