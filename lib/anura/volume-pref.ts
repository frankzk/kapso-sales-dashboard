// El volumen de la llamada con Anura que eligió quien llama, en este navegador
// (07-11-2026). Va en un archivo aparte a propósito: los archivos del teléfono
// tienen prohibido el almacenamiento del navegador (la clave SIP nunca se
// guarda, test/anura-phone-ui.test.ts). Aquí solo vive un número de 1 a 4.

import { ANURA_VOLUME_DEFAULT, clampAnuraVolume } from "@/lib/anura/phone-ui";

const KEY = "kapta.anura.volume";

export function readAnuraVolumePref(): number {
  try {
    const raw = window.localStorage.getItem(KEY);
    return raw == null ? ANURA_VOLUME_DEFAULT : clampAnuraVolume(Number(raw));
  } catch {
    return ANURA_VOLUME_DEFAULT;
  }
}

export function saveAnuraVolumePref(volume: number): void {
  try {
    window.localStorage.setItem(KEY, String(clampAnuraVolume(volume)));
  } catch {
    // sin almacenamiento: vale solo para esta llamada
  }
}
