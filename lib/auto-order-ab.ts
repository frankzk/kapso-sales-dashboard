// Prueba A/B de pedidos de recompra sin llamada (MOM, 09-10-2026; migración 0238).
//
// QUÉ HACE. Inscribe en una cohorte A/B cada carrito de recompra que cumple la
// regla de `auto_order_ab_candidates` y lo sortea:
//   - `auto`    → fila `pendiente`, que el generador de 0214
//                 (lib/auto-order-trials.ts) convierte en pedido;
//   - `control` → fila `control`, que nadie toca: la asesora lo llama como
//                 siempre y se mide qué pasó con él.
//
// POR QUÉ UNA MONEDA DETERMINISTA y no `Math.random()`. El cron puede ver el
// mismo carrito en varias corridas (si una falla a medias, por ejemplo). Con el
// hash del gid, el mismo carrito cae siempre en la misma mitad y un reintento
// no puede cambiarlo de grupo.
//
// QUÉ NO HACE. No decide la regla de elegibilidad (vive en SQL, en un solo
// sitio) ni genera pedidos (eso sigue siendo del procesador de 0214).

import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

export type AbArm = "auto" | "control";

export interface AbCohort {
  cohort: string;
  enabled: boolean;
  starts_at: string | null;
  ends_at: string | null;
  max_enroll_per_day: number;
}

export interface AbCandidate {
  lead_id: string;
  draft_order_gid: string;
  draft_name: string | null;
  cart_created_at: string;
  phone9: string;
  same_district: boolean | null;
}

/** Mitad del carrito: misma entrada, misma mitad, siempre. PURA. */
export function abArm(cohort: string, draftGid: string): AbArm {
  const byte = createHash("sha256").update(`${cohort}:${draftGid}`).digest()[0]!;
  return byte % 2 === 0 ? "auto" : "control";
}

/** ¿La cohorte inscribe ahora? Encendida y dentro de su ventana. PURA. */
export function cohortIsLive(c: AbCohort, nowMs: number): boolean {
  if (!c.enabled) return false;
  const from = c.starts_at ? Date.parse(c.starts_at) : NaN;
  const to = c.ends_at ? Date.parse(c.ends_at) : NaN;
  // Sin ventana no se inscribe: una cohorte sin fin sería una automatización
  // completa encendida sin que nadie lo haya decidido.
  if (!Number.isFinite(from) || !Number.isFinite(to)) return false;
  return nowMs >= from && nowMs < to;
}

/** La fila que se inscribe para un candidato. PURA. */
export function abRow(storeId: string, cohort: string, c: AbCandidate) {
  const arm = abArm(cohort, c.draft_order_gid);
  return {
    store_id: storeId,
    lead_id: c.lead_id,
    draft_order_gid: c.draft_order_gid,
    draft_name: c.draft_name,
    cohort,
    // El grupo de 0214 dice qué dirección lleva el pedido. En el A/B siempre
    // va la del carrito: A si es el distrito donde ya recibió, C si es otro.
    grupo: c.same_district ? "A" : "C",
    arm,
    status: arm === "auto" ? "pendiente" : "control",
    phone9: c.phone9,
    cart_created_at: c.cart_created_at,
  };
}

export interface AbDeps {
  listCohorts(): Promise<AbCohort[]>;
  /** Inscripciones de hoy (las dos mitades) de la cohorte en la tienda. */
  countToday(cohort: string): Promise<number>;
  candidates(cohort: string): Promise<AbCandidate[]>;
  /** Inserta las filas; las que ya existían se ignoran. Devuelve cuántas entraron. */
  insert(rows: ReturnType<typeof abRow>[]): Promise<number>;
  now(): number;
}

export interface AbReport {
  enrolledAuto: number;
  enrolledControl: number;
}

/** Inscribe los candidatos de cada cohorte encendida, respetando el tope diario. */
export async function enrollAbCohorts(storeId: string, deps: AbDeps): Promise<AbReport> {
  const report: AbReport = { enrolledAuto: 0, enrolledControl: 0 };
  const nowMs = deps.now();
  for (const cohort of await deps.listCohorts()) {
    if (!cohortIsLive(cohort, nowMs)) continue;
    const room = cohort.max_enroll_per_day - (await deps.countToday(cohort.cohort));
    if (room <= 0) continue;
    // Más viejo primero: es el que más cerca está de salirse de la ventana.
    const picked = (await deps.candidates(cohort.cohort))
      .sort((a, b) => Date.parse(a.cart_created_at) - Date.parse(b.cart_created_at))
      .slice(0, room);
    if (!picked.length) continue;
    const rows = picked.map((c) => abRow(storeId, cohort.cohort, c));
    await deps.insert(rows);
    for (const r of rows) {
      if (r.arm === "auto") report.enrolledAuto += 1;
      else report.enrolledControl += 1;
    }
  }
  return report;
}

/** Inicio del día en Lima (UTC-5, sin horario de verano), para el tope diario. */
export function limaDayStartIso(nowMs: number): string {
  const lima = new Date(nowMs - 5 * 3_600_000);
  lima.setUTCHours(0, 0, 0, 0);
  return new Date(lima.getTime() + 5 * 3_600_000).toISOString();
}

/** Dependencias reales: Supabase con service role. */
export function abDeps(admin: SupabaseClient, storeId: string): AbDeps {
  return {
    async listCohorts() {
      const { data, error } = await admin
        .from("auto_order_cohorts")
        .select("cohort, enabled, starts_at, ends_at, max_enroll_per_day")
        .eq("enabled", true);
      if (error) throw new Error(`auto_order_cohorts: ${error.message}`);
      return (data ?? []) as AbCohort[];
    },
    async countToday(cohort) {
      const { count, error } = await admin
        .from("auto_order_trials")
        .select("id", { count: "exact", head: true })
        .eq("store_id", storeId)
        .eq("cohort", cohort)
        .gte("created_at", limaDayStartIso(Date.now()));
      if (error) throw new Error(`auto_order_trials (conteo): ${error.message}`);
      return count ?? 0;
    },
    async candidates(cohort) {
      const { data, error } = await admin.rpc("auto_order_ab_candidates", {
        p_store_id: storeId,
        p_cohort: cohort,
      });
      if (error) throw new Error(`auto_order_ab_candidates: ${error.message}`);
      return (data ?? []) as AbCandidate[];
    },
    async insert(rows) {
      const { data, error } = await admin
        .from("auto_order_trials")
        .upsert(rows, { onConflict: "store_id,draft_order_gid,cohort", ignoreDuplicates: true })
        .select("id");
      if (error) throw new Error(`auto_order_trials (inscripción): ${error.message}`);
      return ((data ?? []) as unknown[]).length;
    },
    now: () => Date.now(),
  };
}
