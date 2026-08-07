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

/** Una fila del informe: un problema concreto, con su tendencia. */
export interface AnomalyReportRow {
  source: string;
  reason: string;
  /** Hoy y ayer juntos son la señal: el SALTO, no el nivel. Un motivo con 30 hoy
   *  y 28 ayer es rutina conocida; 30 hoy y 0 ayer es algo que empezó. */
  hoy: number;
  ayer: number;
  /** Total del período mirado, para distinguir un pico de un goteo constante. */
  total: number;
  ultimaVez: string;
  sample: Record<string, unknown> | null;
}

export interface AnomalyReport {
  hoy: number;
  ayer: number;
  filas: AnomalyReportRow[];
}

export const EMPTY_REPORT: AnomalyReport = { hoy: 0, ayer: 0, filas: [] };

/**
 * Arma el informe a partir de las filas crudas. Puro y testeable: la parte que
 * decide qué se muestra no depende de la base.
 *
 * Agrupa por (camino, motivo) SIN la tienda: con varias tiendas, el mismo
 * problema en las dos es UN problema, no dos.
 */
export function buildAnomalyReport(
  rows: AnomalyRow[],
  hoyISO: string,
  ayerISO: string,
): AnomalyReport {
  const byKey = new Map<string, AnomalyReportRow>();
  let hoy = 0;
  let ayer = 0;
  for (const row of rows) {
    const n = Number(row.count) || 0;
    if (row.dia === hoyISO) hoy += n;
    if (row.dia === ayerISO) ayer += n;

    const key = `${row.source}|${row.reason}`;
    const prev = byKey.get(key);
    const fila: AnomalyReportRow = prev ?? {
      source: row.source,
      reason: row.reason,
      hoy: 0,
      ayer: 0,
      total: 0,
      ultimaVez: row.last_seen_at,
      sample: row.sample,
    };
    fila.total += n;
    if (row.dia === hoyISO) fila.hoy += n;
    if (row.dia === ayerISO) fila.ayer += n;
    if (row.last_seen_at > fila.ultimaVez) fila.ultimaVez = row.last_seen_at;
    // Se conserva el primer ejemplo que aparezca: uno estable sirve para
    // reproducir; uno que cambia en cada render, no.
    fila.sample = fila.sample ?? row.sample;
    byKey.set(key, fila);
  }
  return {
    hoy,
    ayer,
    // Primero lo que está pasando HOY; entre empates, lo que más acumula.
    filas: [...byKey.values()].sort(
      (a, b) =>
        b.hoy - a.hoy ||
        b.total - a.total ||
        `${a.source}|${a.reason}`.localeCompare(`${b.source}|${b.reason}`),
    ),
  };
}

/** Fecha local (Lima por defecto) en YYYY-MM-DD, igual que el `dia` de la tabla. */
export function localDay(tz: string, offsetDays = 0, now: Date = new Date()): string {
  const d = new Date(now.getTime() + offsetDays * 86_400_000);
  return d.toLocaleDateString("en-CA", { timeZone: tz });
}
