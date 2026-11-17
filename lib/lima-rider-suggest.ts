// El motorizado sugerido por distrito (owner, 17-11-2026: «¿puedes obtener la
// sugerencia de motorizado? Si en base a ese distrito se iría con Alexis, Roy,
// Yordani, Yhonny u otro»). La API de GF Courier solo dice el motorizado cuando
// ya lo asignó; Kapta lo sugiere con su historial de reparto
// (`lima_rider_district_share`, 0353: las paradas de los últimos 30 días por
// distrito y motorizado). Puro: la lectura vive en
// lib/repro-lima-pending-access.ts.
//
// LA REGLA. Por distrito (el mismo distrito escrito con o sin tilde es uno):
// - Menos de `MIN_DELIVERIES` paradas: no se sugiere nada (no se adivina).
// - Un motorizado con `ONE_RIDER_SHARE` o más: ese («Roy»).
// - Si no, los dos primeros si juntos llegan a `TWO_RIDER_SHARE`: «Yordani o
//   Alexis», el de más paradas primero.
// - Si no, nada: el distrito está repartido entre muchos.

import { districtKey, type LimaPendingOrder } from "@/lib/repro-lima-pending";
import { liveGuideCourier } from "@/lib/repro-lima-blocks";

export const MIN_DELIVERIES = 5;
export const ONE_RIDER_SHARE = 0.7;
export const TWO_RIDER_SHARE = 0.8;
export const RIDER_SHARE_DAYS = 30;

export interface RiderShareRow {
  district: string | null;
  rider_name: string | null;
  deliveries: number | string | null;
}

/** El nombre de pila: «Roy», «Alexis». */
export function riderFirstName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? name.trim();
}

/** Por distrito (`districtKey`), los motorizados sugeridos: uno, dos o ninguno. */
export function buildRiderSuggestions(rows: readonly RiderShareRow[]): Map<string, string[]> {
  const byDistrict = new Map<string, Map<string, number>>();
  for (const row of rows) {
    const name = row.rider_name?.trim();
    const n = Number(row.deliveries ?? 0);
    if (!row.district || !name || !Number.isFinite(n) || n <= 0) continue;
    const key = districtKey(row.district);
    const riders = byDistrict.get(key) ?? new Map<string, number>();
    const first = riderFirstName(name);
    riders.set(first, (riders.get(first) ?? 0) + n);
    byDistrict.set(key, riders);
  }
  const out = new Map<string, string[]>();
  for (const [key, riders] of byDistrict) {
    const ranked = [...riders.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "es"));
    const total = ranked.reduce((sum, [, n]) => sum + n, 0);
    if (total < MIN_DELIVERIES || !ranked.length) continue;
    const [top, second] = ranked;
    if (top![1] / total >= ONE_RIDER_SHARE) out.set(key, [top![0]]);
    else if (second && (top![1] + second[1]) / total >= TWO_RIDER_SHARE) out.set(key, [top![0], second[0]]);
  }
  return out;
}

/**
 * La sugerencia que se MUESTRA: con guía viva de GF Courier que todavía no tiene
 * motorizado. Lo demás no lleva sugerencia (null). La fila y el filtro
 * «Motorizado» (sin asignado) leen esto mismo (`LimaPendingOrder.suggestedRiders`). Pura.
 */
export function shownRiderSuggestion(
  row: Pick<LimaPendingOrder, "ops" | "courierPickup">,
  riders: readonly string[] | null | undefined,
): string[] | null {
  if (!riders?.length) return null;
  return liveGuideCourier(row) === "gf_courier" && gfAwaitingRider(row.ops?.reportedStatus) ? [...riders] : null;
}

/** «Roy» o «Yordani o Alexis». */
export function riderSuggestionText(names: readonly string[]): string {
  return names.join(" o ");
}

/**
 * ¿GF Courier todavía no le asignó motorizado? Sin estado o en sus etapas de
 * antes de asignar (guía creada, por preparar, en preparación, lista para
 * recojo, guía impresa, por asignar). Asignado o en la calle, ya no se sugiere.
 */
export function gfAwaitingRider(reportedStatus: string | null | undefined): boolean {
  const s = (reportedStatus ?? "").trim().toUpperCase();
  if (!s) return true;
  return ["CREATED", "CREATED:TO_PREPARE", "CREATED:PREPARING", "READY_FOR_PICKUP", "READY_FOR_PICKUP:LABELED", "READY_FOR_PICKUP:AWAITING_ASSIGNMENT"].includes(s);
}

/**
 * El motorizado que GF Courier YA asignó (owner, 17-11-2026: «agrega el
 * asignado»). GF lo avisa por webhook y Kapta deja la línea en el historial
 * (`lib/gf-webhook-note.ts`, etapa AWAITING_OFFICE_CHECK): «GF Courier:
 * asignado a Alexis para la ruta del 17/11.», a veces con «— por Daysi (GF).».
 * De esa línea sale el nombre y el día de la ruta; otra línea, null. Puro.
 */
export interface GfAssignedRider { rider: string; day: string | null }

const GF_ASSIGNED = /^GF Courier: asignado a (.+?)(?: para la ruta del (\d{2}\/\d{2}))?\.?(?: — por .*)?$/;

export function parseGfAssigned(note: string | null | undefined): GfAssignedRider | null {
  const m = GF_ASSIGNED.exec((note ?? "").trim());
  const rider = m?.[1]?.trim();
  return rider ? { rider: riderFirstName(rider), day: m?.[2] ?? null } : null;
}

