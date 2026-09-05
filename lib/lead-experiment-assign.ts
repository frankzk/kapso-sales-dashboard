// Reparto de brazos del experimento. La parte que toca la base; la decisión en
// sí es pura y vive en lib/lead-experiment.ts.

import type { createAdminSupabase } from "@/lib/db";
import {
  FRIO_GOLDEN_EXPERIMENT,
  assignArm,
  isExperimentEligible,
  type ExperimentArm,
} from "@/lib/lead-experiment";

type Admin = ReturnType<typeof createAdminSupabase>;

/**
 * Cuánto hacia atrás mira el barrido. El cron corre cada 5 minutos, así que una
 * hora es doce pasadas de margen: si el cron falla un rato, al volver recupera
 * los leads que entraron mientras tanto en vez de perderlos.
 *
 * No más de una hora a propósito. Pasada la hora dorada el tratamiento ya no se
 * puede administrar —consiste justamente en llamar dentro de ella—, así que
 * asignar un lead más viejo solo añadiría ruido a los dos brazos.
 */
export const ASSIGN_LOOKBACK_MS = 60 * 60_000;

/** Cuántos leads mira una pasada. Entran ~570 al día (~2 por minuto), así que
 *  500 cubre una hora entera con holgura incluso tras una caída del cron. */
const ASSIGN_BATCH = 500;

export interface AssignReport {
  vistos: number;
  elegibles: number;
  asignados: number;
  tratamiento: number;
}

/**
 * Asigna brazo a los leads nuevos que aún no lo tienen.
 *
 * SOLO A LEADS SIN LLAMAR. Repartir después de la primera llamada sería asignar
 * conociendo (parte de) el resultado, que es exactamente lo que un experimento
 * no puede hacer. Un lead llamado antes de la pasada se queda FUERA del estudio;
 * eso reduce la población, no sesga la comparación, porque la exclusión ocurre
 * antes del sorteo y por tanto le pasa igual a los dos brazos.
 *
 * IDEMPOTENTE. `assignArm` es determinista y la PK (lead_id, experiment) rechaza
 * la segunda escritura, así que repetir la pasada no mueve a nadie de brazo.
 * `ignoreDuplicates` deja que una carrera entre dos pasadas termine sin error.
 *
 * NO ABORTA EL CRON. El reparto es telemetría de un experimento: si falla, se
 * pierde una tanda de asignaciones, no un pedido. Devolver el parte y seguir es
 * preferible a tumbar el sync por esto.
 */
export async function assignPendingExperimentArms(
  admin: Admin,
  storeIds: string[],
  nowMs: number = Date.now(),
  experiment: string = FRIO_GOLDEN_EXPERIMENT,
): Promise<AssignReport> {
  const vacio: AssignReport = { vistos: 0, elegibles: 0, asignados: 0, tratamiento: 0 };
  if (storeIds.length === 0) return vacio;

  const desde = new Date(nowMs - ASSIGN_LOOKBACK_MS).toISOString();
  const { data: candidatos, error } = await admin
    .from("leads")
    .select("id,store_id,source,first_inbound_text,first_seen_at")
    .in("store_id", storeIds)
    .eq("status", "nuevo")
    .gte("first_seen_at", desde)
    .order("first_seen_at", { ascending: false })
    .limit(ASSIGN_BATCH);
  if (error || !candidatos) return vacio;

  const filas = candidatos as {
    id: string;
    store_id: string;
    source: string | null;
    first_inbound_text: string | null;
  }[];

  const elegibles = filas.filter(isExperimentEligible);
  if (elegibles.length === 0) return { ...vacio, vistos: filas.length };

  // Quién ya tiene brazo. Se consulta en vez de confiar en el `on conflict`
  // porque el parte tiene que decir cuántos se asignaron DE VERDAD en esta
  // pasada: si contara los duplicados, el número crecería sin parar y no
  // serviría para ver si el reparto está vivo.
  const { data: yaAsignados } = await admin
    .from("lead_experiments")
    .select("lead_id")
    .eq("experiment", experiment)
    .in("lead_id", elegibles.map((l) => l.id));
  const conBrazo = new Set(((yaAsignados ?? []) as { lead_id: string }[]).map((r) => r.lead_id));

  const nuevas = elegibles
    .filter((l) => !conBrazo.has(l.id))
    .map((l) => ({
      lead_id: l.id,
      store_id: l.store_id,
      experiment,
      arm: assignArm(l.id, undefined, experiment) satisfies ExperimentArm as ExperimentArm,
    }));

  if (nuevas.length === 0) {
    return { vistos: filas.length, elegibles: elegibles.length, asignados: 0, tratamiento: 0 };
  }

  const { error: insErr } = await admin
    .from("lead_experiments")
    .insert(nuevas, { count: "exact" });
  if (insErr) {
    // 23505 = choque con una asignación que metió otra pasada en paralelo. No es
    // un fallo: la primera manda, que es justo la garantía de la tabla.
    if (insErr.code !== "23505") {
      return { vistos: filas.length, elegibles: elegibles.length, asignados: 0, tratamiento: 0 };
    }
  }

  return {
    vistos: filas.length,
    elegibles: elegibles.length,
    asignados: nuevas.length,
    tratamiento: nuevas.filter((n) => n.arm === "tratamiento").length,
  };
}

/**
 * Brazos de un puñado de leads, para pintarlos en la cola.
 *
 * Devuelve un Map vacío si algo falla: sin brazo la cola se comporta como
 * siempre. Un experimento no puede romper la pantalla de trabajo.
 */
export async function fetchExperimentArms(
  admin: Admin,
  leadIds: string[],
  experiment: string = FRIO_GOLDEN_EXPERIMENT,
): Promise<Map<string, ExperimentArm>> {
  const out = new Map<string, ExperimentArm>();
  if (leadIds.length === 0) return out;
  const { data } = await admin
    .from("lead_experiments")
    .select("lead_id,arm")
    .eq("experiment", experiment)
    .in("lead_id", leadIds);
  for (const r of (data ?? []) as { lead_id: string; arm: ExperimentArm }[]) {
    out.set(r.lead_id, r.arm);
  }
  return out;
}
