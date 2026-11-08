import "server-only";

// Guardar la dirección que completó la clienta por Chatby como la dirección
// corregida del pedido (Confirmación por Chatby, MOM §6.1; 0318). Es el mismo
// camino que «Corregir ubicación» (`updateOrderGeo`): la fila de
// `order_geo_overrides` (que gana sobre la tienda al recalcular), el hecho
// `comment` · `ubicacion` en la Actividad, el recálculo del Master y el
// `coverage_changed` si la cobertura se moviera. Solo cambia la dirección: el
// distrito, la provincia, la referencia y la coordenada que ya tuviera la
// corrección se conservan (un nulo en la fila es «esto no lo toco», 0051).
// Sin actor: lo escribe la pasada de Chatby.

import type { SupabaseClient } from "@supabase/supabase-js";
import { recordCoverageChanges } from "@/lib/coverage-change";
import { recomputeOrderMasterSafe } from "@/lib/order-master";
import { CHATBY_SOURCE } from "@/lib/chatby-autoconfirm";
import { CHATBY_ADDRESS_CORRECTION_NOTE } from "@/lib/chatby-auto-ask";

export async function saveChatbyAddressCorrection(
  admin: SupabaseClient,
  input: { orderId: string; storeId: string; address: string; coverage: string | null },
): Promise<{ error: string | null; warning: string | null }> {
  const address = input.address.trim();
  if (!address) return { error: "La dirección está vacía.", warning: null };
  const { data: existing, error: readError } = await admin
    .from("order_geo_overrides")
    .select("region,province,district,reference,latitude,longitude")
    .eq("order_id", input.orderId)
    .maybeSingle();
  if (readError) return { error: `No se pudo leer la corrección de la ubicación: ${readError.message}`, warning: null };
  const { error } = await admin.from("order_geo_overrides").upsert(
    {
      ...((existing as Record<string, unknown> | null) ?? {}),
      order_id: input.orderId,
      store_id: input.storeId,
      address,
      note: CHATBY_ADDRESS_CORRECTION_NOTE,
      updated_by: null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "order_id" },
  );
  if (error) return { error: `No se pudo guardar la dirección: ${error.message}`, warning: null };

  const { error: eventError } = await admin.from("order_events").insert({
    store_id: input.storeId,
    order_id: input.orderId,
    kind: "comment",
    comment_type: "ubicacion",
    occurred_at: new Date().toISOString(),
    actor: null,
    source: CHATBY_SOURCE,
    reason: CHATBY_ADDRESS_CORRECTION_NOTE,
    note: `Ubicación corregida automáticamente (${CHATBY_ADDRESS_CORRECTION_NOTE.toLowerCase()}). dirección: ${address}`,
    payload: { auto: true, origin: "chatby_auto_ask" },
  });

  await recomputeOrderMasterSafe(admin, [input.orderId]);
  const coverage = await recordCoverageChanges(
    admin,
    [{ order_id: input.orderId, store_id: input.storeId, coverage: input.coverage }],
    { cause: "ubicacion_corregida", actor: null, reason: CHATBY_ADDRESS_CORRECTION_NOTE },
  );
  const warning = eventError ? `La dirección se guardó, pero no se pudo anotar en la Actividad: ${eventError.message}` : coverage.error;
  return { error: null, warning };
}
