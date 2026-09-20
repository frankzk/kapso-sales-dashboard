// Texto del avance del escaneo continuo (MOM §30.9): la cámara se queda
// abierta y debajo del visor dice cuántos van y cuántos faltan.
export interface ScanProgress {
  done: number;
  /** Sin total, solo se cuenta lo hecho («3 en la caja de Roy»). */
  total?: number;
  /** Texto propio cuando no hay total. */
  label?: string;
}

export function scanProgressText(p: ScanProgress): string {
  if (p.total == null) return p.label ?? `${p.done} escaneados`;
  const left = Math.max(0, p.total - p.done);
  return left === 0 ? `Confirmados ${p.done} de ${p.total} · listo` : `Confirmados ${p.done} de ${p.total} · faltan ${left}`;
}

export function scanProgressDone(p: ScanProgress): boolean {
  return p.total != null && p.total > 0 && p.done >= p.total;
}
