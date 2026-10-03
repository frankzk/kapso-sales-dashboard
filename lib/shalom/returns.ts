// El cuadre de las devoluciones de Shalom en la pantalla Devoluciones (MOM
// §9.4). Sin dependencias: lo importan el servidor, que lo calcula, y el
// navegador, que lo pinta. La decisión de recibir una caja está en
// lib/shalom/return-reception.ts.

/**
 * La guía de retorno que trae la etiqueta de Shalom («cambio de destino»). No
 * está en el sistema —la crea Shalom al devolver—, así que solo se anota.
 * Devuelve `null` si viene vacía y `false` si no tiene forma de guía.
 */
export function normalizeReturnGuide(raw: string | null | undefined): string | null | false {
  const value = (raw ?? "").replace(/\s+/g, "").toUpperCase();
  if (!value) return null;
  return /^[A-Z0-9-]{4,30}$/.test(value) ? value : false;
}

/** Una guía de Shalom que vuelve o ya volvió. */
export interface ShalomReturnRow {
  id: string;
  guide_code: string | null;
  order_name: string | null;
  custody_state: string | null;
  returned_at: string | null;
  /** Cuándo Shalom la sacó de la agencia para devolverla. */
  closed_at: string | null;
  updated_at: string | null;
  /** Cuándo la registró una persona en almacén. Null = todavía no. */
  received_at: string | null;
}

export interface ShalomReturnBuckets {
  /** Shalom la devolvió y nadie la ha escaneado. */
  porRecibir: ShalomReturnRow[];
  /** Confirmadas por una persona con la caja en la mano. */
  recibidas: ShalomReturnRow[];
}

/** Desde cuándo vuelve: la salida de la agencia, o lo último que se sabe. */
export function shalomReturnSince(row: ShalomReturnRow): string | null {
  return row.closed_at ?? row.returned_at ?? row.updated_at ?? null;
}

/**
 * Reparte las guías en por recibir / recibidas. «Por recibir» va de la más
 * antigua a la más reciente: una caja que Shalom devolvió hace semanas y no
 * aparece no es un retraso, hay que ir a buscarla.
 */
export function bucketShalomReturns(rows: readonly ShalomReturnRow[]): ShalomReturnBuckets {
  const porRecibir: ShalomReturnRow[] = [];
  const recibidas: ShalomReturnRow[] = [];
  for (const row of rows) {
    if (row.received_at) recibidas.push(row);
    // Sellada sin evento de recepción: en Shalom no hay sello del courier, la
    // pone una persona, así que cuenta como recibida en esa fecha.
    else if (row.custody_state === "devuelto") recibidas.push({ ...row, received_at: row.returned_at });
    else if (row.custody_state === "retorno") porRecibir.push(row);
  }
  porRecibir.sort((a, b) => (shalomReturnSince(a) ?? "9999").localeCompare(shalomReturnSince(b) ?? "9999"));
  recibidas.sort((a, b) => (b.received_at ?? "").localeCompare(a.received_at ?? ""));
  return { porRecibir, recibidas };
}
