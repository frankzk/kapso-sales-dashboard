// Agendar la salida de Grupo GF para un día (MOM §29.6). Un solo camino para
// «Programar» de Grupo GF y para Repro Lima (12-10-2026, §9.5): el programa,
// la solicitud movida a ese día y el evento en el historial del pedido,
// escritos igual desde los dos lados. El reporte de la parada ya no programa:
// la fecha que da el cliente en la puerta queda como «Fecha que pidió el
// cliente» y la tienda la confirma (§29.7). Quitar la fecha también vive aquí
// (`clearGfDispatchPrograms`), condicionada a lo que se leyó.

import type { createAdminSupabase } from "@/lib/db";
import { programDayLabel } from "@/lib/dispatch-day";

type Admin = ReturnType<typeof createAdminSupabase>;

export interface GfProgramWrite {
  orderId: string;
  storeId: string;
  /** YYYY-MM-DD, en Lima. */
  day: string;
  reason: string;
  actor: string;
  /** La solicitud vigente de Grupo GF para el pedido, si hay. */
  request: { id: string; scheduled_for: string | null; shipment_id: string | null } | null;
  /** El día al que estaba programado antes, para decirlo en el historial. */
  from: string | null;
  now?: string;
}

/**
 * Escribe el programa. `written`: el programa quedó (y su evento). `error`: lo
 * que falló, también si quedó pero no se pudo mover la solicitud a ese día.
 */
export async function writeGfDispatchProgram(admin: Admin, w: GfProgramWrite): Promise<{ written: boolean; error: string | null }> {
  const now = w.now ?? new Date().toISOString();
  const { error } = await admin.from("gf_dispatch_programs").upsert({
    order_id: w.orderId,
    store_id: w.storeId,
    scheduled_for: w.day,
    reason: w.reason,
    set_by: w.actor,
    set_at: now,
  }, { onConflict: "order_id" });
  if (error) return { written: false, error: error.message };
  let moveError: string | null = null;
  if (w.request && w.request.scheduled_for !== w.day) {
    const { error: e } = await admin.from("logistics_requests").update({ scheduled_for: w.day }).eq("id", w.request.id);
    if (e) moveError = e.message;
  }
  await admin.from("order_events").insert({
    store_id: w.storeId,
    order_id: w.orderId,
    kind: "dispatch_programmed",
    occurred_at: now,
    actor: w.actor,
    source: "grupo_gf_courier",
    courier: "propio",
    shipment_id: w.request?.shipment_id ?? null,
    note: `Salida programada para el ${programDayLabel(w.day)}${w.from && w.from !== w.day ? ` (antes el ${programDayLabel(w.from)})` : ""}: ${w.reason}.`,
    payload: { from: w.from, to: w.day, reason: w.reason, requestId: w.request?.id ?? null },
  });
  return { written: true, error: moveError };
}

/** Hasta cuántos días adelante acepta el reporte una fecha de reprogramación. */
export const RESCHEDULE_MAX_DAYS = 60;

/**
 * ¿Sirve esta fecha para reprogramar desde el reporte? Null si sí; si no, por
 * qué. Hoy vale (el cliente pide que se vuelva más tarde); antes de hoy o más
 * allá de dos meses, no.
 */
export function rescheduleDateProblem(day: string, today: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || Number.isNaN(Date.parse(`${day}T12:00:00Z`))) return "Elige una fecha válida.";
  if (day < today) return "La nueva fecha no puede ser anterior a hoy.";
  const max = new Date(Date.parse(`${today}T12:00:00Z`) + RESCHEDULE_MAX_DAYS * 86_400_000).toISOString().slice(0, 10);
  if (day > max) return `La nueva fecha no puede pasar de ${RESCHEDULE_MAX_DAYS} días.`;
  return null;
}

/** La solicitud vigente de Grupo GF del pedido (la última no cancelada). */
export interface GfRequestRow {
  id: string;
  scheduled_for: string | null;
  shipment_id: string | null;
}

/**
 * La solicitud vigente de Grupo GF del pedido, o null: la que mueve
 * `writeGfDispatchProgram` al día programado. Sin proveedor no hay solicitud.
 */
export async function loadGfRequest(admin: Admin, providerId: string | null | undefined, orderId: string): Promise<GfRequestRow | null> {
  if (!providerId) return null;
  const { data } = await admin
    .from("logistics_requests")
    .select("id,scheduled_for,shipment_id")
    .eq("provider_id", providerId)
    .eq("order_id", orderId)
    .neq("status", "cancelled")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data as GfRequestRow | null) ?? null;
}

/** Un programa como se leyó: `set_at` es la ficha del borrado condicionado. */
export interface GfProgramRow {
  order_id: string;
  store_id: string;
  scheduled_for: string;
  reason: string;
  set_at?: string | null;
}

/**
 * «Quitar la fecha»: borra cada programa SOLO si sigue siendo el que se leyó
 * (mismo día y, si se leyó, mismo `set_at`), y deja `dispatch_program_cleared`
 * solo de los que de verdad se borraron (E22). Si alguien lo reprogramó entre
 * la lectura y el borrado, el programa nuevo se queda. `noteSuffix` dice por
 * qué, por ejemplo « Repro Lima: el cliente ya no lo quiere.».
 */
export async function clearGfDispatchPrograms(
  admin: Admin,
  programs: readonly GfProgramRow[],
  actor: string,
  noteSuffix = "",
  now: string = new Date().toISOString(),
): Promise<{ cleared: GfProgramRow[]; error: string | null }> {
  const cleared: GfProgramRow[] = [];
  const errors: string[] = [];
  for (const program of programs) {
    let query = admin
      .from("gf_dispatch_programs")
      .delete()
      .eq("order_id", program.order_id)
      .eq("scheduled_for", program.scheduled_for);
    if (program.set_at) query = query.eq("set_at", program.set_at);
    const { data, error } = await query.select("order_id");
    if (error) {
      errors.push(error.message);
      continue;
    }
    if ((data as unknown[] | null)?.length) cleared.push(program);
  }
  if (cleared.length) {
    const suffix = noteSuffix.trim() ? ` ${noteSuffix.trim()}` : "";
    await admin.from("order_events").insert(cleared.map((program) => ({
      store_id: program.store_id,
      order_id: program.order_id,
      kind: "dispatch_program_cleared",
      occurred_at: now,
      actor,
      source: "grupo_gf_courier",
      courier: "propio",
      note: `Se quitó la salida programada para el ${programDayLabel(program.scheduled_for)} («${program.reason}»).${suffix}`,
      payload: { from: program.scheduled_for, reason: program.reason, ...(suffix ? { why: suffix.trim() } : {}) },
    })));
  }
  return { cleared, error: errors.length ? [...new Set(errors)].join(" ") : null };
}
