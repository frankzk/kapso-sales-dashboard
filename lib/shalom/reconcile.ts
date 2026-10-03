// Lo que el cron `shalom-reconcile` hace con la respuesta de UNA guía: leer el
// hito, decidir si un «entregado» fue el recojo o el retorno (MOM §12) y
// escribirlo en la guía y en la línea de tiempo. Vive aquí, y no en la ruta,
// para poder probarlo con una base de mentira.

import type { SupabaseClient } from "@supabase/supabase-js";
import { loadShalomExitFacts } from "@/lib/shalom/pickup-facts";
import {
  readShalomTracking,
  shalomExitIsReturn,
  shalomGuideWrite,
  shalomTrackingChanged,
  type ShalomTrackingStatus,
} from "@/lib/shalom/tracking";

export interface ShalomLiveGuide {
  id: string;
  store_id: string;
  order_id: string | null;
  guide_code: string | null;
  delivery_status: string;
  pickup_state: string | null;
}

export type ShalomApplyOutcome =
  | { kind: "sin_cambio" }
  | { kind: "error"; message: string }
  | { kind: "aplicado"; retorno: boolean; pickupState: string };

export async function applyShalomTracking(
  admin: SupabaseClient,
  guide: ShalomLiveGuide,
  status: ShalomTrackingStatus | null | undefined,
  now: string = new Date().toISOString(),
): Promise<ShalomApplyOutcome> {
  const read = readShalomTracking(status);

  // Un «entregado» se mira dos veces antes de escribirlo: si la clienta nunca
  // tuvo la clave ni pagó y el paquete llevaba días en la agencia, Shalom lo
  // sacó para devolverlo. Si no se pueden leer esos hechos no se escribe nada:
  // la guía sigue viva y la pasada siguiente lo vuelve a intentar.
  let isReturn = false;
  if (read.deliveryStatus === "entregado" && guide.order_id) {
    const facts = await loadShalomExitFacts(admin, guide.order_id);
    if (!facts.ok) return { kind: "error", message: `${guide.guide_code}: ${facts.error}` };
    isReturn = shalomExitIsReturn(read, facts.facts);
  }

  const write = shalomGuideWrite(read, isReturn);
  const next = { deliveryStatus: write.patch.delivery_status, pickupState: write.patch.pickup_state };
  if (!shalomTrackingChanged(guide, next)) return { kind: "sin_cambio" };

  const upd = await admin
    .from("shipments")
    .update({ ...write.patch, last_report_at: now, updated_at: now })
    .eq("id", guide.id);
  if (upd.error) return { kind: "error", message: `${guide.guide_code}: ${upd.error.message}` };

  if (guide.order_id) {
    await admin.from("order_events").insert({
      store_id: guide.store_id,
      order_id: guide.order_id,
      kind: "courier_status",
      occurred_at: read.at ?? now,
      actor: null,
      source: "shalom",
      courier: "shalom",
      guide_code: guide.guide_code,
      new_status: write.event.new_status,
      new_operational: write.event.new_operational,
      note: write.event.note,
      payload: write.event.payload,
    });
  }
  return { kind: "aplicado", retorno: isReturn, pickupState: write.patch.pickup_state };
}
