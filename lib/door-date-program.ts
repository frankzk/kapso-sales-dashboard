// La fecha que el cliente da en la puerta programa la salida (MOM §29.7, «La
// fecha que pidió el cliente», 01-11-2026, decisión del owner).
//
// Del 12-10 al 01-11-2026 esa fecha solo se anotaba y la tienda la confirmaba
// llamando en Repro Lima (decisión 7). Ahora Grupo GF le impone el acuerdo a la
// tienda: si el motorizado reporta «No entregado · Reprogramado» con la fecha
// que pidió el cliente, Kapta programa la salida de Grupo GF para ese día, sin
// llamada. En Repro Lima el pedido sale en «Programados» como «Acordado en la
// puerta»; la tienda puede cambiarlo o cancelarlo, como cualquier acuerdo.
//
// El programa lleva el motivo del motorizado (`RIDER_PROGRAM_REASON_PREFIX`,
// `programOrigin` → «motorizado»), así Repro Lima y la cola saben de dónde vino.

import type { SupabaseClient } from "@supabase/supabase-js";
import { clearGfDispatchPrograms, writeGfDispatchProgram, type GfProgramRow } from "@/lib/gf-dispatch-program";
import { RIDER_PROGRAM_REASON_PREFIX, programOrigin } from "@/lib/repro-lima";

/** «Reprogramado por el cliente (reporte de la parada de Alexis del 31/10): acordado en la puerta.» Cabe en 3-200 (0199). */
export function doorProgramReason(riderName: string | null | undefined, routeDate: string): string {
  const who = (riderName ?? "").trim().slice(0, 60);
  const day = /^\d{4}-\d{2}-\d{2}$/.test(routeDate) ? `${routeDate.slice(8, 10)}/${routeDate.slice(5, 7)}` : routeDate;
  return `${RIDER_PROGRAM_REASON_PREFIX}${who ? ` de ${who}` : ""} del ${day}): acordado en la puerta.`;
}

/**
 * Después de guardar el reporte: con fecha, programa la salida de ese día;
 * sin ella (o con otro resultado), quita el programa que había puesto un
 * reporte anterior de la puerta. Nunca toca un programa de Repro Lima ni de
 * Despacho. Nunca lanza: el reporte ya quedó.
 */
export async function syncDoorDateProgram(
  admin: SupabaseClient,
  input: { orderId: string; routeId: string; day: string | null; actor: string },
): Promise<{ programmed: boolean }> {
  try {
    const [{ data: order }, { data: route }, { data: current }] = await Promise.all([
      admin.from("orders").select("store_id").eq("id", input.orderId).maybeSingle(),
      admin.from("delivery_routes").select("route_date,rider_id").eq("id", input.routeId).maybeSingle(),
      admin.from("gf_dispatch_programs").select("order_id,store_id,scheduled_for,reason,set_at").eq("order_id", input.orderId).maybeSingle(),
    ]);
    const storeId = (order as { store_id: string | null } | null)?.store_id ?? null;
    const program = current as GfProgramRow | null;
    if (!input.day) {
      if (program && programOrigin(program.reason) === "motorizado") {
        await clearGfDispatchPrograms(admin, [program], input.actor, "El reporte de la parada ya no trae fecha.");
      }
      return { programmed: false };
    }
    if (!storeId) return { programmed: false };
    if (program && program.scheduled_for.slice(0, 10) === input.day && programOrigin(program.reason) === "motorizado") {
      return { programmed: true };
    }
    const r = route as { route_date: string; rider_id: string | null } | null;
    let riderName: string | null = null;
    if (r?.rider_id) {
      const { data: rider } = await admin.from("riders").select("full_name").eq("id", r.rider_id).maybeSingle();
      riderName = (rider as { full_name: string | null } | null)?.full_name ?? null;
    }
    const res = await writeGfDispatchProgram(admin, {
      orderId: input.orderId,
      storeId,
      day: input.day,
      reason: doorProgramReason(riderName, String(r?.route_date ?? "")),
      actor: input.actor,
      from: program?.scheduled_for?.slice(0, 10) ?? null,
      request: null,
    });
    return { programmed: res.written };
  } catch (error) {
    console.error("[puerta] no se pudo programar la fecha del cliente", error instanceof Error ? error.message : error);
    return { programmed: false };
  }
}
