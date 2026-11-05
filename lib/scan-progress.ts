// Texto del avance del escaneo continuo (MOM §30.9): la cámara se queda
// abierta y debajo del visor dice cuántos van y cuántos faltan.
export interface ScanProgress {
  done: number;
  /** Sin total, solo se cuenta lo hecho («3 en la caja de Roy»). */
  total?: number;
  /** Texto propio cuando no hay total. */
  label?: string;
  /** Qué se cuenta: «Confirmados» por defecto, «Verificados» en oficina, «Recibidos» al recibir la caja. */
  verb?: string;
}

export function scanProgressText(p: ScanProgress): string {
  if (p.total == null) return p.label ?? `${p.done} escaneados`;
  const left = Math.max(0, p.total - p.done);
  const verb = p.verb ?? "Confirmados";
  return left === 0 ? `${verb} ${p.done} de ${p.total} · listo` : `${verb} ${p.done} de ${p.total} · faltan ${left}`;
}

export function scanProgressDone(p: ScanProgress): boolean {
  return p.total != null && p.total > 0 && p.done >= p.total;
}

/** El tono de la última lectura en el aviso de la cámara (05-11-2026). */
export type ScanStatusTone = "ok" | "warn" | "neutral" | "crit";

/**
 * La vibración que distingue el resultado, además del pulso corto al leer
 * (80 ms): una repetida, dos pulsos; un error, dos largos. Una lectura buena o
 * un aviso no añaden nada. Lo que devuelve va tal cual a `navigator.vibrate`.
 */
export function scanFeedbackVibration(tone: ScanStatusTone): number[] | null {
  if (tone === "warn") return [60, 90, 60];
  if (tone === "crit") return [220, 100, 220];
  return null;
}
