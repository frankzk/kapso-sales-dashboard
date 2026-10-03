// Cuántos envíos de Olva esperan a una persona en «Cotejar Olva» (MOM §12):
// el número que el menú lateral pinta al lado de la entrada.
//
// La MISMA cuenta que la pantalla: del último cotejo de cada organización,
// los envíos «por revisar» y «sin pareja» cuyo tracking HOY no está en ninguna
// salida. Lo que alguien vinculó después —con «Es este», «Vincular a pedido»
// o desde el Master— ya no cuenta, aunque la bitácora siga diciendo lo que
// vio entonces.

import type { SupabaseClient } from "@supabase/supabase-js";
import { formatOlvaTracking, parseOlvaTracking } from "@/lib/olva/tracking";
import type { CotejoResumen } from "@/lib/olva/portal-sync";

/** Los trackings que esperan a una persona en un cotejo. PURA. */
export function waitingTrackings(resumen: CotejoResumen | null | undefined): string[] {
  return (resumen?.rows ?? [])
    .filter((r) => r.outcome === "revisar" || r.outcome === "sin_pareja")
    .map((r) => r.tracking);
}

/** De esos, los que hoy no están en ninguna salida. PURA. */
export function stillWaiting(trackings: string[], linked: Set<string>): string[] {
  return [...new Set(trackings)].filter((t) => !linked.has(t));
}

export async function countOlvaCotejoPending(admin: SupabaseClient, orgIds: string[]): Promise<number> {
  if (!orgIds.length) return 0;
  const { data } = await admin
    .from("olva_portal_runs")
    .select("org_id,resumen,created_at")
    .in("org_id", orgIds)
    .eq("ok", true)
    .order("created_at", { ascending: false })
    .limit(orgIds.length * 10);
  const latest = new Map<string, CotejoResumen>();
  for (const r of (data ?? []) as { org_id: string; resumen: CotejoResumen }[]) {
    if (!latest.has(r.org_id)) latest.set(r.org_id, r.resumen);
  }
  const trackings = [...latest.values()].flatMap(waitingTrackings);
  if (!trackings.length) return 0;

  const ids = trackings.map((t) => parseOlvaTracking(t)).flatMap((p) => (p.ok ? [p.value] : []));
  const linked = new Set<string>();
  const { data: rows } = await admin
    .from("shipments")
    .select("olva_tracking,olva_emision")
    .in("olva_tracking", [...new Set(ids.map((i) => i.tracking))]);
  for (const s of (rows ?? []) as { olva_tracking: string; olva_emision: string }[]) {
    linked.add(formatOlvaTracking({ tracking: s.olva_tracking, emision: s.olva_emision }));
  }
  return stillWaiting(trackings, linked).length;
}
