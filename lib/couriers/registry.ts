// Registro de adaptadores de courier. Añadir un courier nuevo es un archivo en
// este directorio y una entrada aquí; la ingesta (lib/report-ingest.ts) no
// cambia.

import type { CourierAdapter } from "./types";
import { courierName } from "./catalog";
import { aliclikAdapter } from "./aliclik";
import { olvaAdapter, shalomAdapter } from "./agency";

export const COURIER_ADAPTERS: CourierAdapter[] = [
  aliclikAdapter,
  shalomAdapter,
  olvaAdapter,
];

const BY_ID = new Map(COURIER_ADAPTERS.map((a) => [a.id, a]));

export function courierAdapter(id: string | null | undefined): CourierAdapter | null {
  return id ? (BY_ID.get(id) ?? null) : null;
}

/**
 * Nombre presentable de un courier. Cae al catálogo (lib/couriers/catalog.ts)
 * cuando no hay adaptador: no mandar reporte no es motivo para pintarse con el
 * id en crudo, y Axel — que solo manda liquidación — nunca tendrá adaptador.
 */
export function courierLabel(id: string | null | undefined): string {
  return courierAdapter(id)?.label ?? courierName(id);
}

export function isAgencyAdapter(id: string | null | undefined): boolean {
  return courierAdapter(id)?.agency ?? false;
}

/**
 * Elige el adaptador que mejor reconoce estas filas. Permite subir un reporte
 * sin decir de quién es: si ninguno lo reconoce devuelve null y la interfaz pide
 * al operador que lo indique, en vez de adivinar mal y ensuciar las guías.
 */
export function detectAdapter(rows: Record<string, string>[]): CourierAdapter | null {
  let best: { adapter: CourierAdapter; score: number } | null = null;
  for (const adapter of COURIER_ADAPTERS) {
    const score = adapter.score(rows);
    if (score > 0 && (!best || score > best.score)) best = { adapter, score };
  }
  return best?.adapter ?? null;
}

export type { CanonicalReportRow, CourierAdapter } from "./types";
