// El último reporte de cada guía de un pedido, para la regla «sin reporte, deja de ser activa al día siguiente de su
// ruta» (`salidaActiva`, lib/shipment-output.ts; owner, 23-11-2026). Lo da la Actividad: Kapta escribe un hecho
// `courier_status` cada vez que el courier cambia el estado de una guía (también cuando vuelve a recogerla). Sin
// poder leerlo, las salidas quedan como estaban (cuentan como activas).
import type { SupabaseClient } from "@supabase/supabase-js";

export async function withLastCourierChange<T extends { guide_code?: string | null; last_courier_change_at?: string | null }>(
  admin: SupabaseClient, orderId: string, outputs: T[],
): Promise<T[]> {
  const codes = [...new Set(outputs.map((o) => o.guide_code).filter((c): c is string => Boolean(c)))];
  if (!codes.length) return outputs;
  try {
    const { data, error } = await admin.from("order_events").select("guide_code,occurred_at")
      .eq("order_id", orderId).eq("kind", "courier_status").in("guide_code", codes)
      .order("occurred_at", { ascending: false });
    if (error) return outputs;
    const last = new Map<string, string>();
    for (const e of (data ?? []) as { guide_code: string; occurred_at: string }[]) if (!last.has(e.guide_code)) last.set(e.guide_code, e.occurred_at);
    // Leído: con su último reporte, o null si su courier todavía no reportó nada (vale entonces la fecha de salida).
    for (const o of outputs) o.last_courier_change_at = (o.guide_code && last.get(o.guide_code)) || null;
  } catch {
    /* sin la Actividad, cuentan como antes */
  }
  return outputs;
}

/** Columnas de `shipments` que lee `salidaActiva`, para sumarlas al select de quien decide. */
export const SALIDA_ACTIVA_COLUMNS = "returned_at,swayp_state,next_followup_at,out_for_delivery_at,dispatched_at,reported_status,custody_state,custody_transferred_at,created_via";
