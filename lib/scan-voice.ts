// La voz del lector (owner, 19-11-2026: «mi tía escanea y no logra ver bien, se
// le dificulta el escaneo, ¿cómo la ayudamos?»). Además del tono y la
// vibración, el teléfono dice cómo salió cada lectura —«Recibida», «Repetida»,
// «Error»— para no tener que leer la pantalla. Se apaga y se prende con «Voz»
// en la cámara y se recuerda en el teléfono.
//
// Mejor esfuerzo, como el sonido: sin `speechSynthesis` (o si el navegador no
// habla) no pasa nada y el escaneo sigue igual.

import type { ScanStatusTone } from "@/lib/scan-progress";

/** La palabra grande de la pantalla para cada resultado. PURA. */
export function scanVerdictWord(tone: ScanStatusTone): string {
  if (tone === "ok") return "RECIBIDA";
  if (tone === "warn") return "REPETIDA";
  if (tone === "crit") return "ERROR";
  return "AVISO";
}

/** Lo que dice la voz para cada resultado. PURA. */
export function scanVoiceText(tone: ScanStatusTone): string {
  if (tone === "ok") return "Recibida";
  if (tone === "warn") return "Repetida, no suma";
  if (tone === "crit") return "Error, mira la pantalla";
  return "Aviso, mira la pantalla";
}

const VOICE_KEY = "kapta.scan.voice";

/** ¿La voz está prendida en este teléfono? Prendida si nunca se tocó. */
export function readScanVoicePref(): boolean {
  try {
    return window.localStorage.getItem(VOICE_KEY) !== "off";
  } catch {
    return true;
  }
}

export function writeScanVoicePref(on: boolean): void {
  try {
    window.localStorage.setItem(VOICE_KEY, on ? "on" : "off");
  } catch {
    // sin almacenamiento: dura lo que dure la pantalla
  }
}

/** Dice el texto en español, cortando lo que estuviera diciendo antes. */
export function speakScan(text: string): void {
  try {
    const synth = window.speechSynthesis;
    if (!synth || typeof window.SpeechSynthesisUtterance !== "function") return;
    synth.cancel();
    const u = new window.SpeechSynthesisUtterance(text);
    const voices = synth.getVoices?.() ?? [];
    const es = voices.find((v) => /^es[-_]PE/i.test(v.lang)) ?? voices.find((v) => /^es\b|^es[-_]/i.test(v.lang));
    if (es) u.voice = es;
    u.lang = es?.lang ?? "es-PE";
    u.rate = 1.05;
    u.volume = 1;
    synth.speak(u);
  } catch {
    // sin voz
  }
}
