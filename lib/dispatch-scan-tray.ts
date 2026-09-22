// Modo escaneo (MOM §29.13): lo puro de la bandeja temporal y de la lista
// viva. Sin base ni React, probado en test/dispatch-scan-tray.test.ts.

import { normalizeDispatchScan } from "@/lib/dispatch";

export interface TrayEntry {
  code: string;
  scannedAt: string;
}

/** Añade un código a la bandeja «escanear primero», sin repetidos. */
export function addToTray(tray: readonly TrayEntry[], rawCode: string, now = new Date().toISOString()): TrayEntry[] {
  const code = normalizeDispatchScan(rawCode).slice(0, 200);
  if (!code) return [...tray];
  // Un lector y la cámara pueden dar el mismo código en distinta caja; QR y
  // guías se buscan sin distinguirla (lib/dispatch), así que la bandeja tampoco.
  if (tray.some((entry) => entry.code.toLowerCase() === code.toLowerCase())) return [...tray];
  return [...tray, { code, scannedAt: now }];
}

export function removeFromTray(tray: readonly TrayEntry[], code: string): TrayEntry[] {
  return tray.filter((entry) => entry.code.toLowerCase() !== code.toLowerCase());
}

export interface ScanLineLike {
  status: "asignado" | "ya_en_caja" | "en_otra_caja" | "no_elegible" | "bloqueado_efectivo" | "desconocido";
  amount: number | null;
}

export interface ScanSummary {
  total: number;
  assigned: number;
  alreadyInBox: number;
  inOtherBox: number;
  blocked: number;
  unknown: number;
  /** Efectivo previsto de lo que quedó en la caja en esta sesión. */
  cash: number;
}

/** Contadores de la lista viva; el efectivo suma solo lo que entró en la caja. */
export function summarizeScans(lines: readonly ScanLineLike[]): ScanSummary {
  const out: ScanSummary = { total: lines.length, assigned: 0, alreadyInBox: 0, inOtherBox: 0, blocked: 0, unknown: 0, cash: 0 };
  for (const line of lines) {
    switch (line.status) {
      case "asignado":
        out.assigned += 1;
        out.cash += line.amount ?? 0;
        break;
      case "ya_en_caja":
        out.alreadyInBox += 1;
        break;
      case "en_otra_caja":
        out.inOtherBox += 1;
        break;
      case "no_elegible":
      case "bloqueado_efectivo":
        out.blocked += 1;
        break;
      case "desconocido":
        out.unknown += 1;
        break;
    }
  }
  out.cash = Math.round(out.cash * 100) / 100;
  return out;
}
