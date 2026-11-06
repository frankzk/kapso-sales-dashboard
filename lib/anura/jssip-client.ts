// «Llamar con Anura», fase 2: carga JsSIP SOLO en el navegador. SOLO CLIENTE.
//
// JsSIP (3.13.8, la versión que probó Rentabilify con Anura Perú) se trae con
// import dinámico cuando la asesora pide una llamada: no entra al bundle del
// servidor ni al de la primera carga de la ficha. Este archivo solo lo
// importan componentes de cliente (lo vigila `test/anura-ui.test.ts`); la
// lógica del teléfono vive en lib/anura/sip-phone.ts, que no importa jssip.
//
// El logger de JsSIP queda APAGADO: con él encendido, la consola mostraría el
// REGISTER con el usuario SIP y los avisos con el número de la clienta.

import {
  anuraJsSipConfig,
  createAnuraTabLock,
  type AnuraPhoneCredentials,
  type AnuraTabLock,
  type BroadcastLike,
  type LockManagerLike,
  type SipUaLike,
} from "@/lib/anura/sip-phone";

let loaded: Promise<typeof import("jssip")> | null = null;

function loadJsSip(): Promise<typeof import("jssip")> {
  if (typeof window === "undefined") return Promise.reject(new Error("JsSIP solo corre en el navegador."));
  loaded ??= import("jssip").then((m) => {
    const JsSIP = ((m as unknown as { default?: typeof import("jssip") }).default ?? m) as typeof import("jssip");
    try {
      JsSIP.debug.disable();
    } catch {
      // sin logger
    }
    return JsSIP;
  });
  return loaded;
}

/** El UA de JsSIP para `createAnuraPhone` / `testAnuraRegistration`. */
export async function createJsSipUa(creds: AnuraPhoneCredentials): Promise<SipUaLike> {
  const JsSIP = await loadJsSip();
  const socket = new JsSIP.WebSocketInterface(creds.wsUrl);
  const config = anuraJsSipConfig(creds, socket) as unknown as ConstructorParameters<typeof JsSIP.UA>[0];
  return new JsSIP.UA(config) as unknown as SipUaLike;
}

/** El candado entre pestañas del navegador (navigator.locks o BroadcastChannel). */
export function browserAnuraTabLock(): AnuraTabLock {
  const nav = typeof navigator !== "undefined" ? (navigator as Navigator & { locks?: LockManagerLike }) : null;
  return createAnuraTabLock({
    locks: nav?.locks ?? null,
    broadcast:
      typeof BroadcastChannel !== "undefined"
        ? (name: string) => new BroadcastChannel(name) as unknown as BroadcastLike
        : null,
  });
}

/** El micrófono, solo audio (con cancelación de eco). */
export function browserMicrophone(): Promise<MediaStream> {
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
    return Promise.reject(Object.assign(new Error("Sin micrófono"), { name: "NotFoundError" }));
  }
  return navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
}
