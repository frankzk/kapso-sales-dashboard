// Anomalías de ingesta: el trabajo que se descartó, contado por día.
//
// El modo de fallo recurrente de este sistema no es el error ruidoso sino el
// descarte silencioso — 58 `catch` que se tragan la excepción en `lib/` más los
// `return null` de las rutas de ingesta. Este módulo es la única puerta por la
// que un descarte se vuelve visible. Ver db/migrations/0107.
//
// REGLA DE ORO: esto es INSTRUMENTACIÓN. Nunca puede romper, ni retrasar de
// forma perceptible, lo que está observando. Un fallo aquí se traga en silencio
// a propósito — es la única excepción sensata a "no te tragues los errores",
// porque la alternativa es que el medidor tire abajo la producción que mide.

import type { SupabaseClient } from "@supabase/supabase-js";

/** Qué camino descartó. Cerrado a propósito: un `source` libre se convierte en
 *  seis variantes del mismo nombre y las comparaciones día a día dejan de cuadrar. */
export type AnomalySource =
  | "leads_sync"
  | "handoff"
  | "conversation_event"
  | "lead_enrich"
  | "won_sources"
  | "chatby_webhook";

export interface AnomalyInput {
  storeId: string;
  source: AnomalySource;
  /** Motivo corto y estable, en snake_case. Es la mitad de la clave del día. */
  reason: string;
  /** Cuántos de golpe. El sync descarta N en una pasada: una llamada con N vale
   *  lo mismo que N llamadas y cuesta una consulta en vez de N. */
  count?: number;
  /** Un ejemplo para poder reproducir. Se guarda el PRIMERO del día. */
  sample?: Record<string, unknown> | null;
}

/**
 * Suma una anomalía al contador del día. Nunca lanza.
 *
 * `count <= 0` no escribe nada: los sitios que instrumentan un bucle llaman con
 * el total al final, y un total de cero es la buena noticia — no una fila que
 * ensucia la comparación con "hoy hubo cero anomalías registradas" cuando lo
 * correcto es que no haya fila.
 */
export async function noteAnomaly(admin: SupabaseClient, input: AnomalyInput): Promise<void> {
  const count = input.count ?? 1;
  if (count <= 0) return;
  try {
    await admin.rpc("note_ingest_anomaly", {
      p_store_id: input.storeId,
      p_source: input.source,
      p_reason: input.reason,
      p_count: count,
      p_sample: input.sample ?? null,
    });
  } catch {
    /* la instrumentación jamás tumba lo que observa — ver la cabecera */
  }
}

export interface AnomalyRow {
  store_id: string;
  dia: string;
  source: string;
  reason: string;
  count: number;
  sample: Record<string, unknown> | null;
  last_seen_at: string;
}

export interface AnomalyDigest {
  /** Total de hoy en el alcance mirado. 0 = nada que ver. */
  hoy: number;
  /** Total del día anterior, para leer el SALTO y no el nivel. Sin esto, "25
   *  descartes" no dice nada: puede ser lo de siempre o el primer día de un
   *  problema nuevo. */
  ayer: number;
  /** Desglose de hoy, de mayor a menor. */
  detalle: { source: string; reason: string; count: number }[];
}

export const EMPTY_DIGEST: AnomalyDigest = { hoy: 0, ayer: 0, detalle: [] };

/**
 * Arma el resumen a partir de las filas crudas. Puro y testeable: la parte que
 * decide qué se muestra no depende de la base.
 */
export function buildAnomalyDigest(
  rows: AnomalyRow[],
  hoyISO: string,
  ayerISO: string,
): AnomalyDigest {
  const detalle = new Map<string, { source: string; reason: string; count: number }>();
  let hoy = 0;
  let ayer = 0;
  for (const row of rows) {
    const n = Number(row.count) || 0;
    if (row.dia === hoyISO) {
      hoy += n;
      // Se agrupa por (camino, motivo) SIN la tienda: con varias tiendas, el
      // mismo problema en las dos es un problema, no dos.
      const key = `${row.source}|${row.reason}`;
      const prev = detalle.get(key);
      if (prev) prev.count += n;
      else detalle.set(key, { source: row.source, reason: row.reason, count: n });
    } else if (row.dia === ayerISO) {
      ayer += n;
    }
  }
  return {
    hoy,
    ayer,
    detalle: [...detalle.values()].sort(
      (a, b) => b.count - a.count || `${a.source}|${a.reason}`.localeCompare(`${b.source}|${b.reason}`),
    ),
  };
}

/** Fecha local (Lima por defecto) en YYYY-MM-DD, igual que el `dia` de la tabla. */
export function localDay(tz: string, offsetDays = 0, now: Date = new Date()): string {
  const d = new Date(now.getTime() + offsetDays * 86_400_000);
  return d.toLocaleDateString("en-CA", { timeZone: tz });
}
