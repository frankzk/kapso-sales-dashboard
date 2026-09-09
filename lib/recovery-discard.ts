// Descartar la recuperación de provincia: UN hecho, escrito igual desde donde sea.
//
// Se descarta desde dos sitios: el Master (botón «Descartar recuperación» en el
// drawer del pedido) y Envíos (disposición «Cliente no quiere» sobre la guía
// anulada). Si cada uno escribiera el evento a su manera, tarde o temprano uno
// pondría otro `kind`, otro `source` u otro mínimo de motivo, y el resolvedor
// —que solo mira `kind`— vería un descarte sí y otro no. Acá está la única
// forma de escribirlo.

import type { SupabaseClient } from "@supabase/supabase-js";
import { RECOVERY_DISCARDED_KIND } from "@/lib/reproprovincia";

export const DISCARD_REASON_MIN = 8;
export const DISCARD_REASON_MAX = 500;

/** El motivo es obligatorio y tiene que decir algo: es lo que se lee al cerrar. */
export function validarMotivoDescarte(motivo: string | null | undefined): { reason: string } | { error: string } {
  const reason = (motivo ?? "").trim();
  if (reason.length < DISCARD_REASON_MIN) {
    return { error: `Escribe el motivo (mínimo ${DISCARD_REASON_MIN} caracteres).` };
  }
  if (reason.length > DISCARD_REASON_MAX) {
    return { error: `El motivo es demasiado largo (máx. ${DISCARD_REASON_MAX}).` };
  }
  return { reason };
}

/**
 * Escribe el evento. No recalcula ni revalida: eso lo hace quien llama, que
 * sabe qué pantalla tiene delante. Devuelve el error de la base si lo hubo.
 */
export async function discardRecovery(
  admin: SupabaseClient,
  input: { storeId: string; orderId: string; actor: string; reason: string },
): Promise<{ error?: string }> {
  const { error } = await admin.from("order_events").insert({
    store_id: input.storeId,
    order_id: input.orderId,
    kind: RECOVERY_DISCARDED_KIND,
    actor: input.actor,
    source: "manual",
    reason: input.reason,
    note: `Recuperación de provincia descartada: ${input.reason}`,
  });
  return error ? { error: `No se pudo registrar el descarte: ${error.message}` } : {};
}
