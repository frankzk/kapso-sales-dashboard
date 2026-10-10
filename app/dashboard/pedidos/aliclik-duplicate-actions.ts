"use server";

import { revalidatePath } from "next/cache";
import { createAdminSupabase, createServerSupabase } from "@/lib/db";
import { loadAliclikDuplicateHold, DUPLICATE_READ_ERROR } from "@/lib/aliclik-duplicate-access";
import {
  DECLARED_OUTCOME_KIND,
  DUPLICATE_DECISIONS,
  PRIOR_SHIPMENT_OUTCOMES,
  duplicateResolutionProblem,
  replacementOutcomesProblem,
  type DuplicateConflict,
  type DuplicateDecision,
  type DuplicateHold,
  type PriorShipmentOutcome,
} from "@/lib/aliclik-duplicate";
import { recomputeOrderMasterSafe } from "@/lib/order-master";
import { registerClosureAction } from "@/app/dashboard/pedidos/actions";

export async function getAliclikDuplicateHold(orderId: string): Promise<{ hold: DuplicateHold } | { error: string }> {
  try { return { hold: await loadAliclikDuplicateHold(orderId) }; }
  catch (error) { return { error: error instanceof Error ? error.message : DUPLICATE_READ_ERROR }; }
}

export async function resolveAliclikDuplicate(orderId: string, input: {
  decision: DuplicateDecision; reason: string; fingerprint: string;
  /** Solo con «reemplaza»: qué pasó con cada salida anterior, por `shipmentId`. */
  outcomes?: Record<string, PriorShipmentOutcome>;
}): Promise<{ hold: DuplicateHold } | { error: string }> {
  const sb = await createServerSupabase();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return { error: "Inicia sesión para resolver el caso." };
  const { data: order, error } = await sb.from("order_master").select("store_id,order_name").eq("order_id", orderId).single();
  if (error || !order) return { error: "Sin acceso a este pedido." };
  const result = await getAliclikDuplicateHold(orderId);
  if ("error" in result) return result;
  const hold = result.hold;
  if (!hold.conflicts.length || hold.fingerprint !== input.fingerprint) {
    return { error: "Los envíos o productos cambiaron. Actualiza la revisión antes de resolver." };
  }
  if (!hold.canResolve) return { error: "No tienes permiso para resolver este caso." };
  const canOverride = hold.canOverride;
  const reason = typeof input?.reason === "string" ? input.reason.trim() : "";
  const problem = duplicateResolutionProblem(input?.decision, reason, canOverride);
  if (problem) return { error: problem };

  const admin = createAdminSupabase();
  let outcomes: Record<string, PriorShipmentOutcome> | null = null;
  if (input.decision === "replacement") {
    const outcomesProblem = replacementOutcomesProblem(hold.conflicts, input.outcomes);
    if (outcomesProblem) return { error: outcomesProblem };
    outcomes = input.outcomes as Record<string, PriorShipmentOutcome>;
    // Las declaraciones van ANTES de la resolución: la resolución dice «está
    // resuelto», y no puede quedar escrita sobre una salida que no se resolvió.
    const declared = await declarePriorOutcomes(admin, {
      actor: user.id, reason, orderId, orderName: (order as { order_name?: string | null }).order_name ?? null,
      fingerprint: hold.fingerprint!, conflicts: hold.conflicts, outcomes,
    });
    if (declared) return { error: declared };
  }

  const { error: saveError } = await admin.from("order_events").insert({
    store_id: order.store_id, order_id: orderId, kind: "aliclik_duplicate_resolution",
    source: "manual", courier: "aliclik", actor: user.id, occurred_at: new Date().toISOString(),
    reason, note: DUPLICATE_DECISIONS[input.decision],
    payload: { decision: input.decision, fingerprint: hold.fingerprint, conflicts: hold.conflicts,
      validated_amount: hold.validatedAmount, exception_authorized: input.decision === "exception" && canOverride,
      ...(outcomes ? { outcomes } : {}) },
  });
  if (saveError) return { error: "No se pudo guardar la resolución. La guía sigue retenida; reintenta." };
  revalidatePath("/dashboard/pedidos");
  return getAliclikDuplicateHold(orderId);
}

/**
 * Escribe el destino de cada salida anterior por su puerta (MOM §8.3). Devuelve
 * el error de la primera que falla, diciendo cuáles ya quedaron registradas:
 * las escrituras previas no se deshacen —`order_events` es append-only— y quien
 * reintenta tiene que saber que esas salidas ya no le van a aparecer.
 */
async function declarePriorOutcomes(
  admin: ReturnType<typeof createAdminSupabase>,
  input: {
    actor: string; reason: string; orderId: string; orderName: string | null; fingerprint: string;
    conflicts: readonly DuplicateConflict[]; outcomes: Record<string, PriorShipmentOutcome>;
  },
): Promise<string | null> {
  const done: string[] = [];
  const failed = (guide: string, why: string) =>
    `${guide}: ${why}${done.length ? ` Ya quedaron registradas: ${done.join(", ")}.` : ""}`;
  const replacedBy = input.orderName ?? input.orderId;

  for (const conflict of input.conflicts) {
    const outcome = input.outcomes[conflict.shipmentId]!;
    const note = `${PRIOR_SHIPMENT_OUTCOMES[outcome].label}. Declarado al reemplazarlo con ${replacedBy}: ${input.reason}`;

    if (outcome === "devuelto") {
      // La MISMA puerta que «Recepción de devolución» del pedido anterior, con
      // su permiso y sus reglas: no se reimplementa aquí.
      const received = await registerClosureAction(conflict.orderId, {
        action: "return_receive", note, shipmentId: conflict.shipmentId,
      });
      if (received.error) return failed(conflict.guideCode, received.error);
      done.push(conflict.guideCode);
      continue;
    }

    const { data: prior, error: priorError } = await admin.from("order_master")
      .select("store_id").eq("order_id", conflict.orderId).single();
    if (priorError || !prior) return failed(conflict.guideCode, "no se pudo leer el pedido anterior.");
    const { error: eventError } = await admin.from("order_events").insert({
      store_id: (prior as { store_id: string }).store_id, order_id: conflict.orderId,
      shipment_id: conflict.shipmentId, kind: DECLARED_OUTCOME_KIND[outcome],
      source: "manual", courier: conflict.courier, guide_code: conflict.guideCode,
      actor: input.actor, occurred_at: new Date().toISOString(), reason: input.reason, note,
      payload: { outcome, replaced_by_order_id: input.orderId, duplicate_fingerprint: input.fingerprint },
    });
    if (eventError) return failed(conflict.guideCode, "no se pudo registrar la declaración; reintenta.");
    await recomputeOrderMasterSafe(admin, [conflict.orderId]);
    done.push(conflict.guideCode);
  }
  return null;
}
