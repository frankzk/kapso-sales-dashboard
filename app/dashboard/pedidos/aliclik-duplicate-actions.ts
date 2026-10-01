"use server";

import { revalidatePath } from "next/cache";
import { createAdminSupabase, createServerSupabase } from "@/lib/db";
import { loadAliclikDuplicateHold, DUPLICATE_READ_ERROR } from "@/lib/aliclik-duplicate-access";
import { DUPLICATE_DECISIONS, duplicateResolutionProblem, type DuplicateDecision, type DuplicateHold } from "@/lib/aliclik-duplicate";

export async function getAliclikDuplicateHold(orderId: string): Promise<{ hold: DuplicateHold } | { error: string }> {
  try { return { hold: await loadAliclikDuplicateHold(orderId) }; }
  catch (error) { return { error: error instanceof Error ? error.message : DUPLICATE_READ_ERROR }; }
}

export async function resolveAliclikDuplicate(orderId: string, input: {
  decision: DuplicateDecision; reason: string; fingerprint: string;
}): Promise<{ hold: DuplicateHold } | { error: string }> {
  const sb = await createServerSupabase();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return { error: "Inicia sesión para resolver el caso." };
  const { data: order, error } = await sb.from("order_master").select("store_id").eq("order_id", orderId).single();
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
  const { error: saveError } = await createAdminSupabase().from("order_events").insert({
    store_id: order.store_id, order_id: orderId, kind: "aliclik_duplicate_resolution",
    source: "manual", courier: "aliclik", actor: user.id, occurred_at: new Date().toISOString(),
    reason, note: DUPLICATE_DECISIONS[input.decision],
    payload: { decision: input.decision, fingerprint: hold.fingerprint, conflicts: hold.conflicts,
      validated_amount: hold.validatedAmount, exception_authorized: input.decision === "exception" && canOverride },
  });
  if (saveError) return { error: "No se pudo guardar la resolución. La guía sigue retenida; reintenta." };
  revalidatePath("/dashboard/pedidos");
  return getAliclikDuplicateHold(orderId);
}
