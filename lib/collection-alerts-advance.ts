// Quién hace avanzar los avisos de cobranza, y cada cuánto.
//
// «Avanzar» una tienda son tres pasos, en este orden: retirar los avisos cuyo
// pago ya tiene decisión, retirar los «sin atribuir» cuyo celular ya no debe
// nada, y pasar a la siguiente persona de la escalera los que vencieron su
// turno (lib/collection-alerts-access.ts). Antes de escalar se retira: al
// revés, un aviso resuelto subiría a otra persona justo antes de irse.
//
// CÓMO ERA. Lo hacía CADA consulta de CADA pestaña abierta: el aviso flotante
// pregunta cada 20 s «¿qué avisos me tocan?», y esa pregunta hacía avanzar
// antes los avisos de todas sus tiendas. Medido del 14 al 25-11-2026: unas 150
// consultas por minuto, cada una con los tres pasos por tienda. Y sin nadie
// con Kapta abierto, los avisos no avanzaban.
//
// CÓMO ES (owner, 25-11-2026: «sí» a que avancen solos y las pestañas lean).
//   * Un proceso (`/api/cron/collection-alerts`, cada 5 minutos) hace avanzar
//     las tiendas con avisos abiertos, haya o no alguien conectado.
//   * La consulta de una pestaña sigue pudiendo hacerlas avanzar, pero cada
//     servidor lo hace COMO MUCHO UNA VEZ POR MINUTO por tienda
//     (`claimAdvanceTurn`). Con Kapta abierto, un aviso vencido pasa a la
//     siguiente persona en un minuto y pico; antes, en 20 segundos.
//
// POR QUÉ LA CONSULTA NO DEJA DE HACERLO DEL TODO. El diseño original lo dejó
// escrito: un cron es «una pieza que puede caerse en silencio». Si el proceso
// dejara de correr, los avisos seguirían avanzando mientras alguien tenga
// Kapta abierto, como siempre. Los tres pasos aguantan correr dos veces a la
// vez (la escalera se mueve con una guarda por `offered_at`).
//
// El turno vive en la memoria de cada servidor: no es exacto entre servidores,
// ni hace falta. Lo que importa es que deje de ser «en cada consulta».

import type { SupabaseClient } from "@supabase/supabase-js";
import { reconcileCollectionOffers, sweepResolvedAlerts, sweepUnattributedAlerts } from "@/lib/collection-alerts-access";

/** Cada servidor hace avanzar una tienda, por las consultas de las pestañas, como mucho así de seguido. */
export const COLLECTION_ADVANCE_MIN_GAP_MS = 60_000;

/** ¿Ya toca hacer avanzar esta tienda? Pura. */
export function advanceDue(lastAt: number | undefined, nowMs: number, gapMs: number = COLLECTION_ADVANCE_MIN_GAP_MS): boolean {
  return lastAt === undefined || nowMs - lastAt >= gapMs || nowMs < lastAt;
}

const lastAdvanceAt = new Map<string, number>();

/**
 * Toma el turno de una tienda en este servidor: `true` si le toca avanzar ahora.
 * Lo marca ANTES de trabajar, para que dos consultas seguidas no lo hagan las dos.
 */
export function claimAdvanceTurn(storeId: string, nowMs: number = Date.now()): boolean {
  if (!advanceDue(lastAdvanceAt.get(storeId), nowMs)) return false;
  lastAdvanceAt.set(storeId, nowMs);
  return true;
}

/** Solo para las pruebas: olvida los turnos tomados. */
export function resetAdvanceTurns(): void {
  lastAdvanceAt.clear();
}

export interface CollectionAdvanceReport {
  /** Avisos retirados porque su pago ya tiene decisión. */
  resolved: number;
  /** Avisos «sin atribuir» retirados porque ese celular ya no debe nada. */
  unattributed: number;
  /** Avisos que pasaron a la siguiente persona de la escalera. */
  moved: number;
}

/** Hace avanzar los avisos de una tienda: retira lo resuelto y después mueve la escalera. */
export async function advanceCollectionAlerts(admin: SupabaseClient, storeId: string, nowMs: number = Date.now()): Promise<CollectionAdvanceReport> {
  const nowIso = new Date(nowMs).toISOString();
  const resolved = await sweepResolvedAlerts(admin, storeId, nowIso);
  const unattributed = await sweepUnattributedAlerts(admin, storeId, nowIso);
  const moved = await reconcileCollectionOffers(admin, storeId, nowMs);
  return { resolved, unattributed, moved };
}

/** Las tiendas con algún aviso abierto: las únicas que el proceso tiene que mirar. */
export async function storesWithOpenAlerts(admin: SupabaseClient): Promise<string[]> {
  const { data, error } = await admin.from("collection_alerts").select("store_id").eq("status", "abierta").limit(1000);
  if (error) throw new Error(error.message);
  return [...new Set(((data ?? []) as Array<{ store_id: string }>).map((row) => row.store_id))];
}

export interface CollectionAdvanceSweep extends CollectionAdvanceReport {
  stores: number;
  errors: number;
}

/** La pasada del proceso: todas las tiendas con avisos abiertos. Una que falla no detiene a las demás. */
export async function runCollectionAdvanceSweep(admin: SupabaseClient, nowMs: number = Date.now()): Promise<CollectionAdvanceSweep> {
  const stores = await storesWithOpenAlerts(admin);
  const total: CollectionAdvanceSweep = { stores: stores.length, resolved: 0, unattributed: 0, moved: 0, errors: 0 };
  for (const storeId of stores) {
    try {
      const report = await advanceCollectionAlerts(admin, storeId, nowMs);
      total.resolved += report.resolved;
      total.unattributed += report.unattributed;
      total.moved += report.moved;
      // La consulta de una pestaña no repite enseguida lo que el proceso acaba de hacer en este servidor.
      lastAdvanceAt.set(storeId, nowMs);
    } catch {
      total.errors += 1;
    }
  }
  return total;
}
