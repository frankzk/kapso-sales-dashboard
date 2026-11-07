// «Llamar con Anura», fase 2: el teléfono DENTRO de Kapta (solo salidas). La
// lógica del teléfono, pura y testeable: NO importa jssip. El navegador carga
// JsSIP con `createJsSipUa` (lib/anura/jssip-client.ts, import dinámico) y se
// lo inyecta a `createAnuraPhone`; las pruebas le inyectan un doble.
//
// EL ORDEN (MOM §8.7, fase 2).
//   1. Candado entre pestañas: una sola pestaña con el teléfono por navegador.
//      Si otra lo tiene: «Tienes una llamada abierta en otra pestaña de Kapta».
//   2. Credenciales: el servidor las entrega SOLO a la dueña del anexo, en el
//      momento de llamar. Si la clave está rechazada, no se intenta nada.
//   3. Micrófono. Si lo niega, mensaje claro y NO se pide la llamada.
//   4. Registro en Anura (8 s como máximo). Ante el PRIMER rechazo de la clave
//      (401/403/407) el teléfono se detiene, el servidor marca «clave
//      rechazada» y no se reintenta: varios intentos hacen que Anura bloquee
//      la IP. Un 404 («Not Found») es otra cosa: Anura no reconoce el usuario
//      en ese dominio (casi siempre el dominio mal escrito). Se detiene igual y
//      se marca «dominio no reconocido», que no vuelve a intentarse con esa
//      misma clave y ese mismo dominio. Esta pestaña además recuerda la
//      versión rechazada y no vuelve a registrar con ella aunque el servidor no
//      haya llegado a marcarla. Tras
//      un corte después del REGISTER, un «no respondió» u otro rechazo, espera
//      un minuto antes de dejar intentar otra vez. Kapta no reintenta el
//      registro por su cuenta; JsSIP sí mandaría REGISTER solo en cada
//      reconexión del WebSocket, así que ante un fallo de registro ya en
//      llamada se le apaga (`unregister`) y se sigue solo con el audio.
//   5. `startAnuraCall` (Click2Dial, fase 1 sin cambios). Anura hace sonar la
//      terminal principal del anexo —la «-websocket», o sea este navegador— y
//      Kapta contesta sola ese aviso; luego Anura marca a la clienta y la
//      asesora oye el timbre de la clienta.
//   6. Al colgar (o si Anura no hace sonar el teléfono en 45 s) Kapta se
//      desregistra y suelta el micrófono y el candado.
//
// SOLO SALIDAS. Un INVITE que llega sin una llamada que esta persona acaba de
// pedir en esta pestaña (ventana de 45 s) se rechaza con 486, sin sonar, sin
// timbre, sin notificación. Nunca 603: un 6xx corta TODAS las ramas de la
// llamada en Anura, también la de otra terminal. El aviso que llega mientras
// el servidor todavía no confirmó que Anura aceptó el Click2Dial queda en
// espera (sin contestar) y se contesta solo si Anura lo aceptó; si no, 486.
// Kapta no puede saber, por lo que trae el INVITE, si es el de su Click2Dial:
// contesta el primero que llega en la ventana (por confirmar en la prueba
// real qué trae el aviso de Click2Dial para atarlo a la llamada pedida).
//
// Lo prueba `test/anura-sip-phone.test.ts`.

import type { AnuraStartErrorCode, AnuraStartResult } from "@/lib/anura/calls";
import { ANURA_KAPTA_PHONE_TEXT, ANURA_SIP_NOT_FOUND_REASON } from "@/lib/anura/sip";

// ---------------------------------------------------------------------------
// Tiempos
// ---------------------------------------------------------------------------

/** Registro en Anura: si no responde en 8 s, se abandona (sin reintentar). */
export const ANURA_PHONE_REGISTER_TIMEOUT_MS = 8_000;
/** La ventana en que Kapta contesta el aviso de su propio Click2Dial. */
export const ANURA_INVITE_WINDOW_MS = 45_000;
/** Lo que se espera a un candidato ICE público (srflx/relay) antes de seguir. */
export const ANURA_ICE_MAX_WAIT_MS = 1_500;
/** El registro dura poco: si la pestaña muere sin desregistrar, vence pronto. */
export const ANURA_REGISTER_EXPIRES_S = 60;
/** Lo que espera el candado de respaldo (BroadcastChannel) a otra pestaña. */
export const ANURA_TAB_LOCK_PROBE_MS = 300;
export const ANURA_TAB_LOCK_NAME = "kapta-anura-telefono";
/**
 * Tras un registro que no terminó por la clave (Anura cortó después del
 * REGISTER, no respondió u otro rechazo), lo que esta pestaña espera antes de
 * dejar intentar otra vez: muchos intentos seguidos pueden bloquear la IP.
 */
export const ANURA_PHONE_COOLDOWN_MS = 60_000;

// ---------------------------------------------------------------------------
// Credenciales (las entrega el servidor; ver lib/anura/phone-server.ts)
// ---------------------------------------------------------------------------

export interface AnuraIceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

/** Lo que el teléfono necesita para registrarse. La contraseña solo vive en memoria. */
export interface AnuraPhoneCredentials {
  extension: string;
  sipUser: string;
  password: string;
  domain: string;
  wsUrl: string;
  port: number;
  iceServers: AnuraIceServer[];
  /**
   * La versión de la clave (cuándo se guardó). Al reportar un rechazo se
   * manda de vuelta, para no marcar rechazada una clave más nueva.
   */
  credentialVersion: string;
}

export type AnuraPhoneCredentialsErrorCode =
  | "sesion"
  | "permiso"
  | "pedido"
  | "no_configurado"
  | "sin_anexo"
  | "sin_telefono"
  | "sin_dominio"
  | "clave_rechazada"
  | "dominio_no_reconocido"
  | "base";

export type AnuraPhoneCredentialsResult =
  | { ok: true; phone: AnuraPhoneCredentials }
  | { ok: false; code: AnuraPhoneCredentialsErrorCode; error: string };

/** La configuración de `new JsSIP.UA(...)`. `socket` es un `JsSIP.WebSocketInterface`. */
export function anuraJsSipConfig(creds: Pick<AnuraPhoneCredentials, "sipUser" | "password" | "domain" | "port">, socket: unknown) {
  return {
    sockets: [socket],
    uri: `sip:${creds.sipUser}@${creds.domain}`,
    authorization_user: creds.sipUser,
    password: creds.password,
    display_name: "Kapta",
    // Kapta registra a mano, una vez, solo al pedir una llamada.
    register: false,
    register_expires: ANURA_REGISTER_EXPIRES_S,
    // El puerto SIP de la central va en el registrador (Perú: 55090).
    registrar_server: `sip:${creds.domain}:${creds.port}`,
    session_timers: false,
    user_agent: "Kapta",
    no_answer_timeout: 30,
    connection_recovery_min_interval: 2,
    connection_recovery_max_interval: 30,
  };
}

// ---------------------------------------------------------------------------
// Lo inyectado: el UA y la sesión de JsSIP (solo lo que se usa)
// ---------------------------------------------------------------------------

/** Lo que el teléfono usa de `JsSIP.UA`. */
export interface SipUaLike {
  start(): void;
  stop(): void;
  register(): void;
  /** Apaga el registro automático de JsSIP en cada reconexión del WebSocket. */
  unregister?(options?: { all?: boolean }): void;
  isRegistered(): boolean;
  on(event: string, listener: (e: any) => void): unknown;
}

/** Lo que el teléfono usa de `JsSIP.RTCSession`. */
export interface SipSessionLike {
  answer(options: Record<string, unknown>): void;
  terminate(options?: { status_code?: number; reason_phrase?: string }): void;
  mute(options?: { audio?: boolean }): void;
  unmute(options?: { audio?: boolean }): void;
  isEnded(): boolean;
  on(event: string, listener: (e: any) => void): unknown;
  /** El RTCPeerConnection de JsSIP (para tomar el audio y las estadísticas). */
  connection?: unknown;
}

/** Lo que el teléfono usa de un MediaStream (el micrófono). */
export interface MediaStreamLike {
  getTracks(): { stop(): void }[];
}

// ---------------------------------------------------------------------------
// Decisiones puras
// ---------------------------------------------------------------------------

/** La llamada que esta pestaña acaba de pedir y cuyo aviso espera. */
export interface PendingKaptaCall {
  sinceMs: number;
  /** Ya se contestó (o quedó en espera) un aviso de esta llamada: uno solo por llamada. */
  answered: boolean;
  /**
   * El servidor ya confirmó que Anura aceptó el Click2Dial. Antes de eso, el
   * aviso que llegue queda en espera, sin contestar: si Anura no aceptó, se
   * rechaza con 486.
   */
  accepted?: boolean;
}

export type InviteDecision =
  | { answer: true }
  | { answer: false; statusCode: 486; why: "sin_llamada_pedida" | "fuera_de_tiempo" | "ya_contestada" | "ya_en_llamada" };

/**
 * ¿Contesta Kapta este INVITE? Solo si esta pestaña pidió una llamada hace
 * menos de 45 s, todavía no contestó su aviso y no hay otra en curso. Todo lo
 * demás se rechaza con 486 sin sonar (Kapta no recibe llamadas).
 */
export function shouldAnswerInvite(input: { pending: PendingKaptaCall | null; nowMs: number; inCall: boolean }): InviteDecision {
  const busy = { answer: false as const, statusCode: 486 as const };
  if (input.inCall) return { ...busy, why: "ya_en_llamada" };
  if (!input.pending) return { ...busy, why: "sin_llamada_pedida" };
  if (input.pending.answered) return { ...busy, why: "ya_contestada" };
  const age = input.nowMs - input.pending.sinceMs;
  if (!(age >= 0 && age <= ANURA_INVITE_WINDOW_MS)) return { ...busy, why: "fuera_de_tiempo" };
  return { answer: true };
}

/**
 * Por qué falló el registro:
 *   · `clave`: Anura rechazó usuario o clave (401/403/407, o la causa de
 *     JsSIP «Authentication Error» / «Rejected»). Se detiene y se marca: NO se
 *     reintenta.
 *   · `dominio`: Anura no reconoce ese usuario en ese dominio (404/604, o la
 *     causa «Not Found»): casi siempre el dominio de la central mal escrito o
 *     una terminal «-websocket» que no existe. Se detiene y se marca igual (no
 *     se reintenta con esa clave y ese dominio), pero lo que se corrige es el
 *     dominio o el usuario, no la contraseña.
 *   · `red`: no hubo conexión con el WebSocket de Anura.
 *   · `tiempo`: Anura no respondió.
 *   · `otro`: cualquier otra respuesta.
 */
export type AnuraRegistrationFailureKind = "clave" | "dominio" | "red" | "tiempo" | "otro";

/** Los rechazos que detienen el teléfono y se marcan en el servidor. */
export type AnuraRegistrationRejectionKind = Extract<AnuraRegistrationFailureKind, "clave" | "dominio">;

export function isRegistrationRejection(kind: AnuraRegistrationFailureKind | null | undefined): kind is AnuraRegistrationRejectionKind {
  return kind === "clave" || kind === "dominio";
}

const AUTH_STATUS = new Set([401, 403, 407]);
const AUTH_CAUSES = new Set(["authentication error", "rejected", "forbidden", "unauthorized"]);
/** «Not Found» / «Does Not Exist Anywhere»: Anura no conoce ese usuario en ese dominio. */
export const ANURA_SIP_NOT_FOUND_STATUS: ReadonlySet<number> = new Set([404, 604]);
const NOT_FOUND_CAUSES = new Set(["not found"]);

export function registrationFailureKind(e: { cause?: unknown; response?: { status_code?: unknown } | null } | null | undefined): AnuraRegistrationFailureKind {
  const status = Number(e?.response?.status_code);
  const cause = typeof e?.cause === "string" ? e.cause.trim().toLowerCase() : "";
  if (ANURA_SIP_NOT_FOUND_STATUS.has(status)) return "dominio";
  if (AUTH_STATUS.has(status)) return "clave";
  if (NOT_FOUND_CAUSES.has(cause)) return "dominio";
  if (AUTH_CAUSES.has(cause)) return "clave";
  if (status === 408 || cause === "request timeout") return "tiempo";
  if (cause === "connection error" || cause === "internal error" || (!status && !cause)) return "red";
  return "otro";
}

/** El código SIP del rechazo, si lo hay (para el motivo que guarda el servidor). */
export function registrationFailureStatus(e: { response?: { status_code?: unknown } | null } | null | undefined): number | null {
  const n = Number(e?.response?.status_code);
  return Number.isInteger(n) && n >= 100 && n < 700 ? n : null;
}

/** Al llamar desde la ficha. */
export const ANURA_REGISTRATION_TEXT: Record<AnuraRegistrationFailureKind, string> = {
  clave: "Anura rechazó la clave del teléfono de Kapta; pide a quien administra que la vuelva a guardar.",
  dominio: ANURA_KAPTA_PHONE_TEXT.dominio_no_reconocido,
  red: "No se pudo conectar con Anura (sipwss.anura.pe). Revisa tu internet e inténtalo otra vez.",
  tiempo: "Anura no respondió a tiempo al conectar el teléfono de Kapta. Espera un minuto antes de volver a intentar.",
  otro: "Anura no dejó conectar el teléfono de Kapta. Espera un minuto antes de volver a intentar; si se repite, avisa a quien administra.",
};

/**
 * Lo que dice la ficha cuando `startAnuraCall` falla con el teléfono de Kapta.
 * Los textos de la fase 1 hablan de «tu teléfono de Anura», que con el
 * teléfono en Kapta no existe.
 */
export const ANURA_KAPTA_START_TEXT: Partial<Record<AnuraStartErrorCode, string>> = {
  terminal_no_registrada:
    "Anura no ve conectado el teléfono de Kapta. Revisa que la terminal «<anexo>-websocket» sea la principal del anexo y que no tengas Kapta abierto en otro navegador, y vuelve a intentar.",
  sin_terminal: "Tu anexo no tiene terminal principal en Anura. Pide que enciendan la terminal «<anexo>-websocket» de tu anexo.",
  ocupada: "Ya tienes una llamada de Anura abierta. Cuélgala desde Kapta, en la pestaña donde la abriste; si se cortó, Kapta la libera sola en un momento.",
};

/** El título de esos fallos con el teléfono de Kapta (el resto, el de la fase 1). */
export const ANURA_KAPTA_START_TITLE: Partial<Record<AnuraStartErrorCode, string>> = {
  terminal_no_registrada: "Anura no ve conectado el teléfono de Kapta",
  sin_terminal: "Tu anexo no tiene terminal principal",
  ocupada: "Ya tienes una llamada abierta",
};

/** En «Probar y guardar» de Ajustes: no se guardó nada. */
export const ANURA_REGISTRATION_TEST_TEXT: Record<AnuraRegistrationFailureKind, string> = {
  clave:
    "Anura no aceptó ese usuario y contraseña, así que no se guardó. Usa la contraseña de la terminal «<anexo>-websocket» " +
    "(«Obtener credenciales»), no la del teléfono físico, y revisa el dominio. No lo intentes muchas veces seguidas: " +
    "varios intentos fallidos hacen que Anura bloquee la conexión de la oficina.",
  dominio:
    "Anura no reconoce ese usuario en ese dominio, así que no se guardó. Revisa el dominio de la central (tal como sale en " +
    "«Obtener credenciales») y que el usuario sea el de la terminal «<anexo>-websocket». No lo intentes muchas veces seguidas: " +
    "varios intentos fallidos hacen que Anura bloquee la conexión de la oficina.",
  red: "No se pudo conectar con Anura (sipwss.anura.pe). No se guardó nada: revisa tu internet y la URL WebSocket.",
  tiempo: "Anura no respondió a tiempo. No se guardó nada: revisa el dominio y el puerto e inténtalo en un momento.",
  otro: "Anura no aceptó la conexión. No se guardó nada: revisa el dominio, el usuario y el puerto.",
};

/**
 * El motivo que guarda el servidor al marcar el rechazo (sin datos
 * personales). El de `dominio` empieza siempre por
 * `ANURA_SIP_NOT_FOUND_REASON` (lib/anura/sip.ts): así se distingue en la base
 * sin una columna nueva.
 */
export function rejectionReason(kind: AnuraRegistrationFailureKind, status: number | null): string {
  const code = status ? ` (SIP ${status})` : "";
  if (kind === "clave") return `Anura rechazó el usuario o la clave del teléfono de Kapta${code}.`;
  if (kind === "dominio") return `${ANURA_SIP_NOT_FOUND_REASON}${code}.`;
  return `Anura no dejó conectar el teléfono de Kapta${code}.`;
}

/** El tipo de un candidato ICE (`host`, `srflx`, `relay`…), o null. */
export function iceCandidateType(candidate: { type?: unknown; candidate?: unknown } | null | undefined): string | null {
  if (!candidate) return null;
  if (typeof candidate.type === "string" && candidate.type) return candidate.type;
  const m = typeof candidate.candidate === "string" ? / typ (\w+)/.exec(candidate.candidate) : null;
  return m?.[1] ?? null;
}

/**
 * ¿Ya se puede contestar sin esperar el resto de la recolección ICE? JsSIP
 * espera a que termine TODA, y eso puede tardar decenas de segundos. Basta un
 * candidato público (srflx o relay); con solo los locales se sigue a los
 * 1,5 s del primero.
 */
export function iceReadyNow(candidate: { type?: unknown; candidate?: unknown } | null | undefined): boolean {
  const t = iceCandidateType(candidate);
  return t === "srflx" || t === "relay";
}

// ---------------------------------------------------------------------------
// El candado entre pestañas
// ---------------------------------------------------------------------------

export interface AnuraTabLockHandle {
  release(): void;
}

export interface AnuraTabLock {
  /** El candado, o null si otra pestaña lo tiene. */
  acquire(): Promise<AnuraTabLockHandle | null>;
}

/** Lo que se usa de `navigator.locks`. */
export interface LockManagerLike {
  request(name: string, options: { ifAvailable?: boolean }, callback: (lock: unknown) => Promise<unknown>): Promise<unknown>;
}

/** Lo que se usa de `BroadcastChannel`. */
export interface BroadcastLike {
  postMessage(message: unknown): void;
  addEventListener(type: "message", listener: (e: { data: unknown }) => void): void;
  removeEventListener(type: "message", listener: (e: { data: unknown }) => void): void;
  close(): void;
}

export interface TabLockEnv {
  locks?: LockManagerLike | null;
  broadcast?: ((name: string) => BroadcastLike | null) | null;
  name?: string;
  probeMs?: number;
  setTimeout?: (fn: () => void, ms: number) => unknown;
}

/**
 * Una sola pestaña con el teléfono: `navigator.locks` (lo normal); si no
 * existe, BroadcastChannel (pregunta «¿alguien lo tiene?» y espera 300 ms); si
 * tampoco, deja pasar. La base sostiene igual una sola llamada viva por
 * persona.
 */
export function createAnuraTabLock(env: TabLockEnv): AnuraTabLock {
  const name = env.name ?? ANURA_TAB_LOCK_NAME;
  const wait = env.setTimeout ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const free: AnuraTabLockHandle = { release() {} };

  if (env.locks) {
    const locks = env.locks;
    return {
      acquire: () =>
        new Promise<AnuraTabLockHandle | null>((resolve) => {
          let settled = false;
          locks
            .request(name, { ifAvailable: true }, async (lock) => {
              if (!lock) {
                settled = true;
                resolve(null);
                return;
              }
              await new Promise<void>((done) => {
                settled = true;
                let released = false;
                resolve({
                  release() {
                    if (released) return;
                    released = true;
                    done();
                  },
                });
              });
            })
            .catch(() => {
              if (!settled) resolve(free);
            });
        }),
    };
  }

  const channel = env.broadcast?.(name) ?? null;
  if (!channel) return { acquire: async () => free };
  let holding = false;
  channel.addEventListener("message", (e) => {
    const data = e.data as { type?: string } | null;
    if (data?.type === "quien" && holding) channel.postMessage({ type: "mia" });
  });
  return {
    acquire: () =>
      new Promise<AnuraTabLockHandle | null>((resolve) => {
        if (holding) {
          resolve(null);
          return;
        }
        let taken = false;
        const onReply = (e: { data: unknown }) => {
          if ((e.data as { type?: string } | null)?.type === "mia") taken = true;
        };
        channel.addEventListener("message", onReply);
        channel.postMessage({ type: "quien" });
        wait(() => {
          channel.removeEventListener("message", onReply);
          if (taken || holding) {
            resolve(null);
            return;
          }
          holding = true;
          let released = false;
          resolve({
            release() {
              if (released) return;
              released = true;
              holding = false;
            },
          });
        }, env.probeMs ?? ANURA_TAB_LOCK_PROBE_MS);
      }),
  };
}

// ---------------------------------------------------------------------------
// El teléfono
// ---------------------------------------------------------------------------

/**
 * Las fases del teléfono:
 *   inactivo → credenciales → microfono → conectando (registro) → pidiendo
 *   (startAnuraCall) → esperando_anura (el aviso de Click2Dial) → en_llamada
 *   (Kapta contestó; Anura marca a la clienta y luego hablan) → terminada.
 * `error` termina con un código y un mensaje. Lo que diga si la clienta
 * contestó lo sigue diciendo el sondeo de la fase 1 (`getAnuraCallStatus`).
 */
export type AnuraPhonePhase =
  | "inactivo"
  | "credenciales"
  | "microfono"
  | "conectando"
  | "pidiendo"
  | "esperando_anura"
  | "en_llamada"
  | "terminada"
  | "error";

export type AnuraPhoneErrorCode =
  | "otra_pestana"
  | "credenciales"
  | "microfono_denegado"
  | "microfono_no_disponible"
  | "registro"
  | "llamada_rechazada"
  | "anura_no_llamo"
  | "audio"
  | "espera";

export interface AnuraPhoneError {
  code: AnuraPhoneErrorCode;
  message: string;
  /** Con `credenciales`: el código del servidor (p. ej. `clave_rechazada`). */
  credentialsCode?: AnuraPhoneCredentialsErrorCode;
  /** Con `registro`: por qué. */
  registration?: AnuraRegistrationFailureKind;
  /** Con `llamada_rechazada`: lo que respondió `startAnuraCall` (para los títulos de la fase 1). */
  start?: Extract<AnuraStartResult, { ok: false }>;
}

export interface AnuraPhoneSnapshot {
  phase: AnuraPhonePhase;
  /** Hay algo en marcha (no se puede pedir otra). */
  busy: boolean;
  muted: boolean;
  /** La llamada de Kapta (`anura_calls.id`), en cuanto el servidor la devuelve. */
  callId: string | null;
  /**
   * «98••••321», del servidor. Kapta nunca muestra, guarda ni escribe en la
   * consola el número entero, aunque la señalización SIP de Anura (el INVITE)
   * pueda traerlo.
   */
  toMasked: string | null;
  extension: string | null;
  /** Cuándo Kapta contestó el aviso de Anura (ms). */
  answeredAt: number | null;
  /** Con `terminada`: quién cortó (la asesora desde Kapta, o Anura: la clienta colgó o no contestó). */
  endedBy: "kapta" | "anura" | null;
  error: AnuraPhoneError | null;
}

export const ANURA_PHONE_TEXT = {
  otra_pestana: "Tienes una llamada abierta en otra pestaña de Kapta.",
  microfono_denegado:
    "Kapta necesita el micrófono para llamar. Permítelo en el candado de la barra de direcciones y vuelve a intentarlo.",
  microfono_no_disponible: "No se encontró un micrófono. Conecta tus audífonos con micrófono y vuelve a intentarlo.",
  anura_no_llamo:
    "Anura no hizo sonar el teléfono de Kapta. Revisa en Anura que la terminal «<anexo>-websocket» sea la principal del anexo.",
  audio: "No se pudo conectar el audio con Anura. Vuelve a intentarlo.",
  corte:
    "Anura cortó la conexión al conectar el teléfono de Kapta. Espera un minuto antes de volver a intentar; si se repite, avisa a quien administra.",
  espera:
    "Espera un minuto antes de volver a intentar: varios intentos fallidos seguidos pueden hacer que Anura bloquee la conexión de la oficina.",
  conectando: "Conectando…",
  esperando_anura: "Conectando con Anura…",
  llamando: (toMasked: string | null) => (toMasked ? `Llamando a ${toMasked}…` : "Llamando…"),
} as const;

/**
 * Lo que una pestaña recuerda entre llamadas, SOLO en memoria (nunca en el
 * almacenamiento del navegador): las versiones de clave que Anura ya rechazó aquí y la
 * espera tras un registro fallido. Así un segundo clic no vuelve a registrar
 * con una clave mala aunque el servidor no haya llegado a marcarla.
 */
export interface AnuraPhoneMemory {
  /**
   * Si Anura ya rechazó aquí esta clave: `clave` vale para esa versión con
   * cualquier dominio; `dominio`, solo para esa versión con ESE dominio (con
   * otro dominio es otra combinación y se puede probar).
   */
  rejectedKind(extension: string, credentialVersion: string, domain: string): AnuraRegistrationRejectionKind | null;
  markRejected(extension: string, credentialVersion: string, kind: AnuraRegistrationRejectionKind, domain: string): void;
  cooldownLeftMs(extension: string, nowMs: number): number;
  startCooldown(extension: string, nowMs: number): void;
}

export function createAnuraPhoneMemory(): AnuraPhoneMemory {
  const rejected = new Set<string>();
  const cooling = new Map<string, number>();
  const key = (extension: string, version: string, domain: string | null) =>
    domain === null ? `clave\u0000${extension}\u0000${version}` : `dominio\u0000${extension}\u0000${version}\u0000${domain.toLowerCase()}`;
  return {
    rejectedKind(extension, version, domain) {
      if (rejected.has(key(extension, version, null))) return "clave";
      if (rejected.has(key(extension, version, domain))) return "dominio";
      return null;
    },
    markRejected(extension, version, kind, domain) {
      rejected.add(key(extension, version, kind === "clave" ? null : domain));
    },
    cooldownLeftMs: (extension, nowMs) => Math.max(0, (cooling.get(extension) ?? 0) - nowMs),
    startCooldown(extension, nowMs) {
      cooling.set(extension, nowMs + ANURA_PHONE_COOLDOWN_MS);
    },
  };
}

export interface AnuraPhoneDeps {
  /** Crea el UA de JsSIP (en el navegador: `createJsSipUa`). */
  createUa(creds: AnuraPhoneCredentials): SipUaLike | Promise<SipUaLike>;
  /** `navigator.mediaDevices.getUserMedia({ audio: true })`. */
  getMicrophone(): Promise<MediaStreamLike>;
  lock: AnuraTabLock;
  /** La server action que entrega las credenciales de la dueña del anexo. */
  fetchCredentials(): Promise<AnuraPhoneCredentialsResult>;
  /** `startAnuraCall(orderId)` (o la llamada de prueba de Ajustes). */
  requestCall(): Promise<AnuraStartResult>;
  /**
   * La server action que marca «clave rechazada» o «dominio no reconocido».
   * Con `dominio` manda también el dominio con el que se probó, para que el
   * servidor no marque si mientras tanto alguien lo corrigió. Nunca debe lanzar.
   */
  reportRejected(input: { credentialVersion: string; kind: AnuraRegistrationRejectionKind; status: number | null; domain?: string }): Promise<unknown>;
  onChange(snapshot: AnuraPhoneSnapshot): void;
  /** El audio de Anura, para un `<audio autoplay>` con `srcObject`; null al terminar. */
  onRemoteStream(stream: unknown): void;
  /** Si el evento `track` no trae stream, se arma uno (`new MediaStream([track])`). */
  makeStream?(tracks: unknown[]): unknown;
  /**
   * Lo que recuerda la pestaña (claves rechazadas, espera). En el navegador,
   * uno por pestaña (`browserAnuraPhoneMemory`); si falta, uno por teléfono.
   */
  memory?: AnuraPhoneMemory;
  now?(): number;
  setTimeout?(fn: () => void, ms: number): unknown;
  clearTimeout?(handle: unknown): void;
  /**
   * Diagnóstico de cada paso (lib/anura/phone-diag.ts → log `[anura-phone]`).
   * Sin datos personales; nunca debe lanzar.
   */
  diag?(event: string, data?: Record<string, string | number | boolean | null>): void;
}

export interface AnuraPhone {
  /** Hace todo el recorrido. Resuelve con la foto cuando ya hay llamada o error. */
  call(): Promise<AnuraPhoneSnapshot>;
  /** Cuelga (o cancela si todavía no hay llamada) y desregistra. */
  hangUp(): void;
  setMuted(muted: boolean): void;
  /** Al desmontar o cerrar la pestaña: cuelga y suelta todo. */
  dispose(): void;
  snapshot(): AnuraPhoneSnapshot;
}

const AMBIGUOUS_START = new Set(["tiempo", "red"]);
const IDLE: AnuraPhoneSnapshot = {
  phase: "inactivo",
  busy: false,
  muted: false,
  callId: null,
  toMasked: null,
  extension: null,
  answeredAt: null,
  endedBy: null,
  error: null,
};

function isBusyPhase(p: AnuraPhonePhase): boolean {
  return p !== "inactivo" && p !== "terminada" && p !== "error";
}

function micErrorCode(err: unknown): "microfono_denegado" | "microfono_no_disponible" {
  const name = (err as { name?: string } | null)?.name ?? "";
  return name === "NotAllowedError" || name === "SecurityError" || name === "PermissionDeniedError" ? "microfono_denegado" : "microfono_no_disponible";
}

/** El texto de un `startAnuraCall` fallido, dicho para el teléfono de Kapta. */
export function anuraKaptaStartMessage(result: Extract<AnuraStartResult, { ok: false }>): string {
  return (result.code && ANURA_KAPTA_START_TEXT[result.code]) || result.error;
}

function rejectBusy(s: SipSessionLike) {
  try {
    s.terminate({ status_code: 486, reason_phrase: "Busy Here" });
  } catch {
    // nada que colgar
  }
}

/**
 * El teléfono de Kapta. Una instancia por pestaña; cada `call()` hace un
 * recorrido completo y al final suelta todo (UA, micrófono, candado).
 */
/**
 * Lo técnico de la propuesta de audio de Anura (SDP del INVITE), para el
 * diagnóstico: protocolo, rtcp-mux, DTLS, ICE, bundle y códecs. Sin IPs ni
 * números (solo banderas y nombres de códec).
 */
export function sdpTraits(body: unknown): Record<string, string | number | boolean | null> {
  if (typeof body !== "string" || !body.trim()) return { sdp: false };
  const proto = /m=audio \d+ ([A-Z/]+)/.exec(body)?.[1] ?? null;
  const codecs = [...body.matchAll(/a=rtpmap:\d+ ([A-Za-z0-9-]+)\//g)].map((m) => m[1]).slice(0, 8).join(",");
  return {
    sdp: true,
    proto,
    mux: /a=rtcp-mux/.test(body),
    dtls: /a=fingerprint/.test(body),
    crypto: /a=crypto/.test(body),
    ice: /a=ice-ufrag/.test(body),
    bundle: /a=group:BUNDLE/.test(body),
    setup: /a=setup:([a-z]+)/.exec(body)?.[1] ?? null,
    codecs: codecs || null,
  };
}

export function createAnuraPhone(deps: AnuraPhoneDeps): AnuraPhone {
  const now = deps.now ?? (() => Date.now());
  const later = deps.setTimeout ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const cancel = deps.clearTimeout ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const memory = deps.memory ?? createAnuraPhoneMemory();

  let state: AnuraPhoneSnapshot = { ...IDLE };
  let run = 0;
  let ua: SipUaLike | null = null;
  let mic: MediaStreamLike | null = null;
  let lock: AnuraTabLockHandle | null = null;
  let session: SipSessionLike | null = null;
  /** El aviso que llegó antes de que el servidor confirmara el Click2Dial. */
  let held: SipSessionLike | null = null;
  let pending: PendingKaptaCall | null = null;
  let timers: unknown[] = [];
  let settle: ((s: AnuraPhoneSnapshot) => void) | null = null;

  const d = (event: string, data?: Record<string, string | number | boolean | null>) => {
    try {
      deps.diag?.(event, data);
    } catch {
      // diagnóstico: nunca rompe el teléfono
    }
  };
  const set = (patch: Partial<AnuraPhoneSnapshot>) => {
    if (patch.phase && patch.phase !== state.phase) {
      d("fase", { fase: patch.phase, error: patch.error?.code ?? null, registro: patch.error?.registration ?? null });
    }
    state = { ...state, ...patch };
    state.busy = isBusyPhase(state.phase);
    deps.onChange({ ...state });
  };
  const resolveCall = () => {
    const s = settle;
    settle = null;
    s?.({ ...state });
  };
  const timer = (fn: () => void, ms: number) => {
    const h = later(fn, ms);
    timers.push(h);
    return h;
  };

  /** Suelta todo. `ua.stop()` desregistra si estaba registrado. */
  const teardown = () => {
    for (const h of timers) cancel(h);
    timers = [];
    pending = null;
    const h = held;
    held = null;
    if (h && !h.isEnded()) rejectBusy(h);
    const s = session;
    session = null;
    if (s && !s.isEnded()) {
      try {
        s.terminate();
      } catch {
        // ya terminó
      }
    }
    const u = ua;
    ua = null;
    if (u) {
      try {
        u.stop();
      } catch {
        // ya parado
      }
    }
    const m = mic;
    mic = null;
    for (const t of m?.getTracks() ?? []) {
      try {
        t.stop();
      } catch {
        // ya parado
      }
    }
    deps.onRemoteStream(null);
    const l = lock;
    lock = null;
    l?.release();
  };

  const fail = (myRun: number, error: AnuraPhoneError) => {
    if (myRun !== run) return;
    run += 1;
    teardown();
    set({ phase: "error", error, muted: false });
    resolveCall();
  };

  const finish = (myRun: number, endedBy: "kapta" | "anura") => {
    if (myRun !== run) return;
    run += 1;
    teardown();
    set({ phase: "terminada", muted: false, endedBy });
    resolveCall();
  };

  /** Anura rechazó esta clave (o no reconoce el dominio): la pestaña la recuerda y se avisa al servidor. */
  const reportRejection = (phone: AnuraPhoneCredentials, kind: AnuraRegistrationRejectionKind, status: number | null) => {
    memory.markRejected(phone.extension, phone.credentialVersion, kind, phone.domain);
    try {
      const input =
        kind === "dominio"
          ? { credentialVersion: phone.credentialVersion, kind, status, domain: phone.domain }
          : { credentialVersion: phone.credentialVersion, kind, status };
      void Promise.resolve(deps.reportRejected(input)).catch(() => {});
    } catch {
      // el aviso no debe romper el teléfono; la pestaña ya la recuerda
    }
  };

  const answer = (myRun: number, creds: AnuraPhoneCredentials, s: SipSessionLike) => {
    try {
      s.answer({
        mediaStream: mic,
        mediaConstraints: { audio: true, video: false },
        // Valores del navegador para bundle y rtcp-mux (06-11-2026): con
        // `max-bundle` + `rtcpMuxPolicy: require` la primera prueba real con
        // Anura falló al contestar con «WebRTC Error».
        pcConfig: { iceServers: creds.iceServers },
      });
    } catch {
      fail(myRun, { code: "audio", message: ANURA_PHONE_TEXT.audio });
    }
  };

  /** El servidor confirmó el Click2Dial: se contesta el aviso que esperaba, si lo hay. */
  const accept = (myRun: number, creds: AnuraPhoneCredentials) => {
    if (pending) pending = { ...pending, accepted: true };
    const h = held;
    held = null;
    if (!h || h.isEnded()) return;
    session = h;
    answer(myRun, creds, h);
  };

  const onInvite = (myRun: number, creds: AnuraPhoneCredentials, e: { session?: SipSessionLike; originator?: string }) => {
    const s = e?.session;
    if (!s) return;
    if (myRun !== run || e.originator !== "remote") {
      d("invite", { decision: "rechazo", why: myRun !== run ? "otra_vuelta" : "no_remoto", originator: e?.originator ?? null });
      rejectBusy(s);
      return;
    }
    const decision = shouldAnswerInvite({ pending, nowMs: now(), inCall: session !== null || held !== null });
    d("invite", {
      decision: decision.answer ? (pending?.accepted ? "contesta" : "espera") : "rechazo",
      why: decision.answer ? null : decision.why,
      edadMs: pending ? now() - pending.sinceMs : null,
    });
    if (!decision.answer || !pending) {
      // Sin sonar: Kapta no recibe llamadas.
      rejectBusy(s);
      return;
    }
    pending = { ...pending, answered: true };
    let iceTimer: unknown = null;
    s.on("icecandidate", (ev: { candidate?: { type?: unknown; candidate?: unknown }; ready?: () => void }) => {
      const ready = ev?.ready;
      if (typeof ready !== "function") return;
      if (iceReadyNow(ev.candidate)) {
        ready();
        return;
      }
      if (iceTimer === null) iceTimer = timer(() => ready(), ANURA_ICE_MAX_WAIT_MS);
    });
    let remoteSet = false;
    s.on("peerconnection", (ev: { peerconnection?: { addEventListener?: (t: string, cb: (x: any) => void) => void } }) => {
      ev?.peerconnection?.addEventListener?.("track", (t: { streams?: readonly unknown[]; track?: { kind?: unknown } }) => {
        d("audio_remoto", { via: "track", streams: t?.streams?.length ?? 0, kind: typeof t?.track?.kind === "string" ? t.track.kind : null });
        if (myRun !== run) return;
        const stream = t?.streams?.[0] ?? (t?.track && deps.makeStream ? deps.makeStream([t.track]) : null);
        if (stream) {
          remoteSet = true;
          deps.onRemoteStream(stream);
        }
      });
    });
    /**
     * Al contestar: el audio de Anura sale de los receptores de la conexión
     * (por si el evento `track` no llegó o llegó sin stream), y a los 4 y 15 s
     * se anota cuánto audio llega y sale (diagnóstico, 07-11-2026).
     */
    const afterConfirmed = () => {
      const pc = s.connection as
        | { getReceivers?: () => { track?: { kind?: string; muted?: boolean; readyState?: string } | null }[]; getStats?: () => Promise<{ forEach(cb: (r: any) => void): void }> }
        | undefined;
      const tracks = (pc?.getReceivers?.() ?? []).map((r) => r.track).filter((t): t is { kind?: string; muted?: boolean; readyState?: string } => !!t && t.kind === "audio");
      d("audio_receptores", { pistas: tracks.length, muted: tracks[0]?.muted ?? null, estado: tracks[0]?.readyState ?? null, yaHabia: remoteSet });
      if (tracks.length && deps.makeStream) deps.onRemoteStream(deps.makeStream(tracks));
      for (const ms of [4000, 15000]) {
        timer(() => {
          if (myRun !== run || !pc?.getStats) return;
          void pc
            .getStats()
            .then((stats) => {
              const out: Record<string, string | number | boolean | null> = { a_los_ms: ms };
              stats.forEach((r: any) => {
                if (r?.type === "inbound-rtp" && (r.kind === "audio" || r.mediaType === "audio")) {
                  out.recibidos = Number(r.packetsReceived ?? 0);
                  out.bytesRecibidos = Number(r.bytesReceived ?? 0);
                  out.perdidos = Number(r.packetsLost ?? 0);
                  out.nivel = typeof r.audioLevel === "number" ? Math.round(r.audioLevel * 1000) / 1000 : null;
                  out.energia = typeof r.totalAudioEnergy === "number" ? Math.round(r.totalAudioEnergy * 1000) / 1000 : null;
                }
                if (r?.type === "outbound-rtp" && (r.kind === "audio" || r.mediaType === "audio")) out.enviados = Number(r.packetsSent ?? 0);
                if (r?.type === "candidate-pair" && r.nominated && r.state === "succeeded") out.par = "ok";
              });
              d("rtp", out);
            })
            .catch(() => d("rtp", { a_los_ms: ms, error: true }));
        }, ms);
      }
    };
    for (const step of ["setremotedescriptionfailed", "createanswerfailed", "setlocaldescriptionfailed"]) {
      s.on(`peerconnection:${step}`, (err: unknown) => {
        const e = err as { name?: unknown; message?: unknown } | null;
        d("webrtc_error", { paso: step, name: typeof e?.name === "string" ? e.name : null, msg: typeof e?.message === "string" ? e.message : null });
      });
    }
    s.on("getusermediafailed", (err: unknown) => {
      const e = err as { name?: unknown } | null;
      d("webrtc_error", { paso: "getusermedia", name: typeof e?.name === "string" ? e.name : null, msg: null });
    });
    s.on("confirmed", () => {
      d("sesion_confirmada");
      if (myRun !== run) return;
      try {
        afterConfirmed();
      } catch {
        // diagnóstico: nunca rompe la llamada
      }
      set({ phase: "en_llamada", answeredAt: state.answeredAt ?? now() });
      resolveCall();
    });
    s.on("ended", (ev: { originator?: string; cause?: unknown } | undefined) => {
      d("sesion_fin", { originator: ev?.originator ?? null, cause: typeof ev?.cause === "string" ? ev.cause : null });
      finish(myRun, ev?.originator === "local" ? "kapta" : "anura");
    });
    s.on("failed", (ev: { originator?: string; cause?: unknown; message?: { status_code?: unknown } | null } | undefined) => {
      d("sesion_fallo", {
        originator: ev?.originator ?? null,
        cause: typeof ev?.cause === "string" ? ev.cause : null,
        status: Number.isFinite(Number(ev?.message?.status_code)) ? Number(ev?.message?.status_code) : null,
      });
      if (myRun !== run) return;
      if (held === s) {
        // Se cortó mientras esperaba la confirmación: el siguiente aviso de la ventana todavía vale.
        held = null;
        if (pending) pending = { ...pending, answered: false };
        return;
      }
      if (state.phase === "en_llamada") finish(myRun, "anura");
      else fail(myRun, { code: "audio", message: ANURA_PHONE_TEXT.audio });
    });
    if (pending.accepted) {
      session = s;
      answer(myRun, creds, s);
    } else {
      held = s;
    }
  };

  const placeCall = async (myRun: number, creds: AnuraPhoneCredentials) => {
    // La ventana empieza ANTES de pedir: el aviso de Anura puede llegar antes
    // que la respuesta del servidor (entonces espera, sin contestar).
    pending = { sinceMs: now(), answered: false, accepted: false };
    set({ phase: "pidiendo" });
    timer(() => {
      if (myRun !== run || session) return;
      d("sin_invite", { held: held !== null, accepted: pending?.accepted ?? null });
      fail(myRun, { code: "anura_no_llamo", message: ANURA_PHONE_TEXT.anura_no_llamo });
    }, ANURA_INVITE_WINDOW_MS);
    let result: AnuraStartResult;
    try {
      result = await deps.requestCall();
    } catch {
      result = { ok: false, code: "red", error: "No se pudo pedir la llamada. Revisa tu internet." };
    }
    d("click2dial", { ok: result.ok, code: result.ok ? null : (result.code ?? null), conAviso: session !== null || held !== null });
    if (myRun !== run) return;
    if (result.ok) {
      set({ callId: result.callId, toMasked: result.toMasked, ...(session ? {} : { phase: "esperando_anura" as const }) });
      accept(myRun, creds);
      return;
    }
    if (result.activeCallId && result.code && AMBIGUOUS_START.has(result.code)) {
      // Anura pudo haber llamado igual: se espera su aviso dentro de la ventana.
      set({ callId: result.activeCallId, ...(session ? {} : { phase: "esperando_anura" as const }) });
      accept(myRun, creds);
      return;
    }
    fail(myRun, { code: "llamada_rechazada", message: anuraKaptaStartMessage(result), start: result });
  };

  const call = (): Promise<AnuraPhoneSnapshot> => {
    if (isBusyPhase(state.phase)) return Promise.resolve({ ...state });
    run += 1;
    const myRun = run;
    state = { ...IDLE };
    const done = new Promise<AnuraPhoneSnapshot>((resolve) => {
      settle = resolve;
    });
    void (async () => {
      set({ phase: "credenciales" });
      const gotLock = await deps.lock.acquire().catch(() => null);
      if (myRun !== run) {
        gotLock?.release();
        return;
      }
      if (!gotLock) {
        fail(myRun, { code: "otra_pestana", message: ANURA_PHONE_TEXT.otra_pestana });
        return;
      }
      lock = gotLock;

      let creds: AnuraPhoneCredentialsResult;
      try {
        creds = await deps.fetchCredentials();
      } catch {
        creds = { ok: false, code: "base", error: "No se pudo preparar el teléfono de Kapta. Revisa tu internet." };
      }
      if (myRun !== run) return;
      if (!creds.ok) {
        fail(myRun, { code: "credenciales", message: creds.error, credentialsCode: creds.code });
        return;
      }
      const phone = creds.phone;
      const remembered = memory.rejectedKind(phone.extension, phone.credentialVersion, phone.domain);
      if (remembered) {
        // Anura ya rechazó esta clave (o este dominio) en esta pestaña y el
        // servidor no llegó a marcarla: no se registra otra vez (se vuelve a
        // avisar al servidor).
        reportRejection(phone, remembered, null);
        fail(myRun, { code: "registro", registration: remembered, message: ANURA_REGISTRATION_TEXT[remembered] });
        return;
      }
      if (memory.cooldownLeftMs(phone.extension, now()) > 0) {
        fail(myRun, { code: "espera", message: ANURA_PHONE_TEXT.espera });
        return;
      }
      set({ phase: "microfono", extension: phone.extension });

      try {
        const stream = await deps.getMicrophone();
        if (myRun !== run) {
          for (const t of stream.getTracks()) t.stop();
          return;
        }
        mic = stream;
      } catch (err) {
        const code = micErrorCode(err);
        fail(myRun, { code, message: ANURA_PHONE_TEXT[code] });
        return;
      }

      set({ phase: "conectando" });
      let agent: SipUaLike;
      try {
        agent = await deps.createUa(phone);
      } catch {
        fail(myRun, { code: "registro", registration: "otro", message: ANURA_REGISTRATION_TEXT.otro });
        return;
      }
      if (myRun !== run) {
        try {
          agent.stop();
        } catch {
          // nada
        }
        return;
      }
      ua = agent;
      let registered = false;
      let askedRegister = false;
      /** JsSIP volvería a mandar REGISTER solo en cada reconexión: se le apaga. */
      const stopAutoRegister = () => {
        try {
          agent.unregister?.({ all: false });
        } catch {
          // nada que desregistrar
        }
      };
      const regFail = (kind: AnuraRegistrationFailureKind, status: number | null, afterRegister = false) => {
        if (myRun !== run) return;
        if (isRegistrationRejection(kind)) {
          // El PRIMER rechazo detiene todo y se marca en el servidor.
          reportRejection(phone, kind, status);
        } else if (kind === "tiempo" || kind === "otro" || afterRegister) {
          memory.startCooldown(phone.extension, now());
        }
        const message = kind === "red" && afterRegister ? ANURA_PHONE_TEXT.corte : ANURA_REGISTRATION_TEXT[kind];
        fail(myRun, { code: "registro", registration: kind, message });
      };
      agent.on("newRTCSession", (e: { session?: SipSessionLike; originator?: string; request?: { body?: unknown } }) => {
        d("invite_sdp", sdpTraits(e?.request?.body));
        onInvite(myRun, phone, e);
      });
      agent.on("connected", () => {
        d("ws_conectado");
        if (myRun !== run || askedRegister) return;
        askedRegister = true;
        try {
          agent.register();
        } catch {
          regFail("otro", null);
        }
      });
      agent.on("disconnected", () => {
        d("ws_desconectado", { registrado: registered });
        // Antes del REGISTER es la red; después, puede ser Anura cortando.
        if (!registered) regFail("red", null, askedRegister);
      });
      agent.on("registrationFailed", (e: { cause?: unknown; response?: { status_code?: unknown } | null }) => {
        if (myRun !== run) return;
        const kind = registrationFailureKind(e);
        const status = registrationFailureStatus(e);
        d("registro_fallo", { kind, status, cause: typeof e?.cause === "string" ? e.cause : null });
        stopAutoRegister();
        if (registered && session) {
          // En llamada: el audio sigue, pero no se manda otro REGISTER.
          if (isRegistrationRejection(kind)) reportRejection(phone, kind, status);
          return;
        }
        regFail(kind, status);
      });
      agent.on("registered", () => {
        d("registrado");
        if (myRun !== run || registered) return;
        registered = true;
        void placeCall(myRun, phone);
      });
      timer(() => {
        if (!registered) regFail("tiempo", null);
      }, ANURA_PHONE_REGISTER_TIMEOUT_MS);
      try {
        agent.start();
      } catch {
        regFail("red", null);
      }
    })();
    return done;
  };

  return {
    call,
    hangUp() {
      if (!isBusyPhase(state.phase)) return;
      finish(run, "kapta");
    },
    setMuted(muted: boolean) {
      const s = session;
      if (!s || state.phase !== "en_llamada") return;
      try {
        if (muted) s.mute({ audio: true });
        else s.unmute({ audio: true });
        set({ muted });
      } catch {
        // la llamada ya terminó
      }
    },
    dispose() {
      if (isBusyPhase(state.phase)) finish(run, "kapta");
      else teardown();
    },
    snapshot: () => ({ ...state }),
  };
}

// ---------------------------------------------------------------------------
// «Probar y guardar» de Ajustes: UN registro, sin llamada
// ---------------------------------------------------------------------------

export type AnuraRegistrationTestResult = { ok: true } | { ok: false; kind: AnuraRegistrationFailureKind; message: string };

/**
 * Intenta UN registro con lo que escribió quien administra y se desconecta.
 * No reintenta. Solo si Anura acepta, la pantalla manda guardar la clave.
 */
export function testAnuraRegistration(
  deps: Pick<AnuraPhoneDeps, "createUa" | "setTimeout" | "clearTimeout"> & { timeoutMs?: number },
  creds: AnuraPhoneCredentials,
): Promise<AnuraRegistrationTestResult> {
  const later = deps.setTimeout ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const cancel = deps.clearTimeout ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));
  return new Promise((resolve) => {
    let done = false;
    let agent: SipUaLike | null = null;
    let handle: unknown = null;
    const end = (r: AnuraRegistrationTestResult) => {
      if (done) return;
      done = true;
      if (handle !== null) cancel(handle);
      try {
        agent?.stop();
      } catch {
        // nada
      }
      resolve(r);
    };
    const bad = (kind: AnuraRegistrationFailureKind) => end({ ok: false, kind, message: ANURA_REGISTRATION_TEST_TEXT[kind] });
    handle = later(() => bad("tiempo"), deps.timeoutMs ?? ANURA_PHONE_REGISTER_TIMEOUT_MS);
    Promise.resolve()
      .then(() => deps.createUa(creds))
      .then((u) => {
        agent = u;
        if (done) {
          u.stop();
          return;
        }
        let asked = false;
        let registered = false;
        u.on("newRTCSession", (e: { session?: SipSessionLike }) => {
          try {
            e?.session?.terminate({ status_code: 486, reason_phrase: "Busy Here" });
          } catch {
            // nada
          }
        });
        u.on("connected", () => {
          if (asked) return;
          asked = true;
          u.register();
        });
        u.on("disconnected", () => {
          if (!registered) bad("red");
        });
        u.on("registrationFailed", (e: { cause?: unknown; response?: { status_code?: unknown } | null }) => bad(registrationFailureKind(e)));
        u.on("registered", () => {
          registered = true;
          end({ ok: true });
        });
        u.start();
      })
      .catch(() => bad("otro"));
  });
}
