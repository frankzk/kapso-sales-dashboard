// El sonido del lector (owner, 13-11-2026: «cuando escanee, ¿es posible emitir
// un sonido?»). Acompaña a la vibración (`scanFeedbackVibration`): un pitido
// corto al leer un QR y, donde la pantalla dice cómo salió (Devoluciones), un
// tono por resultado: buena, dos notas que suben; repetida, dos pitidos
// medios; error, un zumbido grave. Un aviso neutro no suena.
//
// Web Audio, sin archivos. Suena por el volumen multimedia del teléfono. Es
// mejor esfuerzo: sin AudioContext, o si el navegador lo deja en pausa, no pasa
// nada y el escaneo sigue igual.

import type { ScanStatusTone } from "@/lib/scan-progress";

export interface ScanNote {
  /** Hz. */
  freq: number;
  /** Inicio, en ms desde ahora. */
  at: number;
  /** Duración en ms. */
  ms: number;
  type: OscillatorType;
}

/** El pitido al leer: corto y agudo, como un lector de caja. PURA. */
export const SCAN_READ_NOTES: readonly ScanNote[] = Object.freeze([{ freq: 1760, at: 0, ms: 70, type: "sine" }]);

/** El tono del resultado, o null si no suena. PURA. */
export function scanResultNotes(tone: ScanStatusTone): readonly ScanNote[] | null {
  if (tone === "ok") return [{ freq: 880, at: 0, ms: 110, type: "sine" }, { freq: 1320, at: 120, ms: 160, type: "sine" }];
  if (tone === "warn") return [{ freq: 660, at: 0, ms: 110, type: "triangle" }, { freq: 660, at: 180, ms: 110, type: "triangle" }];
  if (tone === "crit") return [{ freq: 196, at: 0, ms: 420, type: "square" }];
  return null;
}

let shared: AudioContext | null = null;

function audioContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  try {
    if (!shared || shared.state === "closed") {
      const Ctx: typeof AudioContext | undefined =
        window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      shared = Ctx ? new Ctx() : null;
    }
    if (shared && shared.state === "suspended") void shared.resume().catch(() => {});
    return shared;
  } catch {
    return null;
  }
}

/** Prepara el audio al abrir la cámara (tras el clic, Chrome lo deja sonar). */
export function primeScanSound(): void {
  audioContext();
}

export function playScanNotes(notes: readonly ScanNote[] | null): void {
  if (!notes?.length) return;
  const ctx = audioContext();
  if (!ctx) return;
  try {
    const start = ctx.currentTime + 0.01;
    for (const note of notes) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      const t0 = start + note.at / 1000;
      const t1 = t0 + note.ms / 1000;
      osc.type = note.type;
      osc.frequency.setValueAtTime(note.freq, t0);
      // Volumen moderado con entrada y salida suaves: sin «clic» al cortar.
      const peak = note.type === "square" ? 0.08 : 0.18;
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.exponentialRampToValueAtTime(peak, t0 + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, t1);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t0);
      osc.stop(t1 + 0.02);
    }
  } catch {
    // sin sonido
  }
}
