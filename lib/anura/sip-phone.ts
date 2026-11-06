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
//      (401/403/407/404) el teléfono se detiene, el servidor marca «clave
//      rechazada» y no se reintenta: varios intentos hacen que Anura bloquee
//      la IP. Nunca hay reintentos automáticos de registro.
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
// llamada en Anura, también la de otra terminal.
//
// Lo prueba `test/anura-sip-phone.test.ts`.

import type { AnuraStartResult } from "@/lib/anura/calls";

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
  /** Ya se contestó un aviso de esta llamada: uno solo por llamada. */
  answered: boolean;
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
 *   · `clave`: Anura rechazó usuario o clave (401/403/407/404, o la causa de
 *     JsSIP lo dice). Se detiene y se marca: NO se reintenta.
 *   · `red`: no hubo conexión con el WebSocket de Anura.
 *   · `tiempo`: Anura no respondió.
 *   · `otro`: cualquier otra respuesta.
 */
export type AnuraRegistrationFailureKind = "clave" | "red" | "tiempo" | "otro";

const AUTH_STATUS = new Set([401, 403, 404, 407]);
const AUTH_CAUSES = new Set(["authentication error", "rejected", "not found", "forbidden", "unauthorized"]);

export function registrationFailureKind(e: { cause?: unknown; response?: { status_code?: unknown } | null } | null | undefined): AnuraRegistrationFailureKind {
  const status = Number(e?.response?.status_code);
  const cause = typeof e?.cause === "string" ? e.cause.trim().toLowerCase() : "";
  if (AUTH_STATUS.has(status) || AUTH_CAUSES.has(cause)) return "clave";
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
  red: "No se pudo conectar con Anura (sipwss.anura.pe). Revisa tu internet e inténtalo otra vez.",
  tiempo: "Anura no respondió a tiempo al conectar el teléfono de Kapta. Inténtalo otra vez en un momento.",
  otro: "Anura no dejó conectar el teléfono de Kapta. Inténtalo otra vez; si se repite, avisa a quien administra.",
};

/** En «Probar y guardar» de Ajustes: no se guardó nada. */
export const ANURA_REGISTRATION_TEST_TEXT: Record<AnuraRegistrationFailureKind, string> = {
  clave:
    "Anura no aceptó ese usuario y contraseña, así que no se guardó. Usa la contraseña de la terminal «<anexo>-websocket» " +
    "(«Obtener credenciales»), no la del teléfono físico, y revisa el dominio. No lo intentes muchas veces seguidas: " +
    "varios intentos fallidos hacen que Anura bloquee la conexión de la oficina.",
  red: "No se pudo conectar con Anura (sipwss.anura.pe). No se guardó nada: revisa tu internet y la URL WebSocket.",
  tiempo: "Anura no respondió a tiempo. No se guardó nada: revisa el dominio y el puerto e inténtalo en un momento.",
  otro: "Anura no aceptó la conexión. No se guardó nada: revisa el dominio, el usuario y el puerto.",
};

/** El motivo que guarda el servidor al marcar «clave rechazada» (sin datos personales). */
export function rejectionReason(kind: AnuraRegistrationFailureKind, status: number | null): string {
  const code = status ? ` (SIP ${status})` : "";
  return kind === "clave" ? `Anura rechazó el usuario o la clave del teléfono de Kapta${code}.` : `Anura no dejó conectar el teléfono de Kapta${code}.`;
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
  | "audio";

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
  /** «98••••321», del servidor. El número entero nunca pasa por el navegador. */
  toMasked: string | null;
  extension: string | null;
  /** Cuándo Kapta contestó el aviso de Anura (ms). */
  answeredAt: number | null;
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
  conectando: "Conectando…",
  esperando_anura: "Conectando con Anura…",
  llamando: (toMasked: string | null) => (toMasked ? `Llamando a ${toMasked}…` : "Llamando…"),
} as const;

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
  /** La server action que marca «clave rechazada». Nunca debe lanzar. */
  reportRejected(input: { credentialVersion: string; kind: AnuraRegistrationFailureKind; status: number | null }): Promise<unknown>;
  onChange(snapshot: AnuraPhoneSnapshot): void;
  /** El audio de Anura, para un `<audio autoplay>` con `srcObject`; null al terminar. */
  onRemoteStream(stream: unknown): void;
  /** Si el evento `track` no trae stream, se arma uno (`new MediaStream([track])`). */
  makeStream?(tracks: unknown[]): unknown;
  now?(): number;
  setTimeout?(fn: () => void, ms: number): unknown;
  clearTimeout?(handle: unknown): void;
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
  error: null,
};

function isBusyPhase(p: AnuraPhonePhase): boolean {
  return p !== "inactivo" && p !== "terminada" && p !== "error";
}

function micErrorCode(err: unknown): "microfono_denegado" | "microfono_no_disponible" {
  const name = (err as { name?: string } | null)?.name ?? "";
  return name === "NotAllowedError" || name === "SecurityError" || name === "PermissionDeniedError" ? "microfono_denegado" : "microfono_no_disponible";
}

/**
 * El teléfono de Kapta. Una instancia por pestaña; cada `call()` hace un
 * recorrido completo y al final suelta todo (UA, micrófono, candado).
 */
export function createAnuraPhone(deps: AnuraPhoneDeps): AnuraPhone {
  const now = deps.now ?? (() => Date.now());
  const later = deps.setTimeout ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const cancel = deps.clearTimeout ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));

  let state: AnuraPhoneSnapshot = { ...IDLE };
  let run = 0;
  let ua: SipUaLike | null = null;
  let mic: MediaStreamLike | null = null;
  let lock: AnuraTabLockHandle | null = null;
  let session: SipSessionLike | null = null;
  let pending: PendingKaptaCall | null = null;
  let timers: unknown[] = [];
  let settle: ((s: AnuraPhoneSnapshot) => void) | null = null;

  const set = (patch: Partial<AnuraPhoneSnapshot>) => {
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

  const finish = (myRun: number) => {
    if (myRun !== run) return;
    run += 1;
    teardown();
    set({ phase: "terminada", muted: false });
    resolveCall();
  };

  const onInvite = (myRun: number, creds: AnuraPhoneCredentials, e: { session?: SipSessionLike; originator?: string }) => {
    const s = e?.session;
    if (!s) return;
    if (myRun !== run || e.originator !== "remote") {
      try {
        s.terminate({ status_code: 486, reason_phrase: "Busy Here" });
      } catch {
        // nada que colgar
      }
      return;
    }
    const decision = shouldAnswerInvite({ pending, nowMs: now(), inCall: session !== null });
    if (!decision.answer) {
      // Sin sonar: Kapta no recibe llamadas.
      try {
        s.terminate({ status_code: decision.statusCode, reason_phrase: "Busy Here" });
      } catch {
        // nada que colgar
      }
      return;
    }
    pending = pending ? { ...pending, answered: true } : null;
    session = s;
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
    s.on("peerconnection", (ev: { peerconnection?: { addEventListener?: (t: string, cb: (x: any) => void) => void } }) => {
      ev?.peerconnection?.addEventListener?.("track", (t: { streams?: readonly unknown[]; track?: unknown }) => {
        if (myRun !== run) return;
        const stream = t?.streams?.[0] ?? (t?.track && deps.makeStream ? deps.makeStream([t.track]) : null);
        if (stream) deps.onRemoteStream(stream);
      });
    });
    s.on("confirmed", () => {
      if (myRun !== run) return;
      set({ phase: "en_llamada", answeredAt: state.answeredAt ?? now() });
      resolveCall();
    });
    s.on("ended", () => finish(myRun));
    s.on("failed", () => {
      if (myRun !== run) return;
      if (state.phase === "en_llamada") finish(myRun);
      else fail(myRun, { code: "audio", message: ANURA_PHONE_TEXT.audio });
    });
    try {
      s.answer({
        mediaStream: mic,
        mediaConstraints: { audio: true, video: false },
        pcConfig: { iceServers: creds.iceServers, bundlePolicy: "max-bundle", rtcpMuxPolicy: "require" },
      });
    } catch {
      fail(myRun, { code: "audio", message: ANURA_PHONE_TEXT.audio });
    }
  };

  const placeCall = async (myRun: number) => {
    // La ventana empieza ANTES de pedir: el aviso de Anura puede llegar antes
    // que la respuesta del servidor.
    pending = { sinceMs: now(), answered: false };
    set({ phase: "pidiendo" });
    timer(() => {
      if (myRun !== run || session) return;
      fail(myRun, { code: "anura_no_llamo", message: ANURA_PHONE_TEXT.anura_no_llamo });
    }, ANURA_INVITE_WINDOW_MS);
    let result: AnuraStartResult;
    try {
      result = await deps.requestCall();
    } catch {
      result = { ok: false, code: "red", error: "No se pudo pedir la llamada. Revisa tu internet." };
    }
    if (myRun !== run) return;
    if (result.ok) {
      set({ callId: result.callId, toMasked: result.toMasked, ...(session ? {} : { phase: "esperando_anura" as const }) });
      return;
    }
    if (result.activeCallId && result.code && AMBIGUOUS_START.has(result.code)) {
      // Anura pudo haber llamado igual: se espera su aviso dentro de la ventana.
      set({ callId: result.activeCallId, ...(session ? {} : { phase: "esperando_anura" as const }) });
      return;
    }
    fail(myRun, { code: "llamada_rechazada", message: result.error, start: result });
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
      const held = await deps.lock.acquire().catch(() => null);
      if (myRun !== run) {
        held?.release();
        return;
      }
      if (!held) {
        fail(myRun, { code: "otra_pestana", message: ANURA_PHONE_TEXT.otra_pestana });
        return;
      }
      lock = held;

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
      const regFail = (kind: AnuraRegistrationFailureKind, status: number | null) => {
        if (myRun !== run) return;
        if (kind === "clave") {
          // El PRIMER rechazo detiene todo y se marca en el servidor.
          void deps.reportRejected({ credentialVersion: phone.credentialVersion, kind, status }).catch(() => {});
        }
        fail(myRun, { code: "registro", registration: kind, message: ANURA_REGISTRATION_TEXT[kind] });
      };
      agent.on("newRTCSession", (e: { session?: SipSessionLike; originator?: string }) => onInvite(myRun, phone, e));
      agent.on("connected", () => {
        if (myRun !== run || askedRegister) return;
        askedRegister = true;
        try {
          agent.register();
        } catch {
          regFail("otro", null);
        }
      });
      agent.on("disconnected", () => {
        if (!registered) regFail("red", null);
      });
      agent.on("registrationFailed", (e: { cause?: unknown; response?: { status_code?: unknown } | null }) => {
        if (registered && session) return; // en llamada: el audio sigue; JsSIP no reintenta solo
        regFail(registrationFailureKind(e), registrationFailureStatus(e));
      });
      agent.on("registered", () => {
        if (myRun !== run || registered) return;
        registered = true;
        void placeCall(myRun);
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
      finish(run);
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
      if (isBusyPhase(state.phase)) finish(run);
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
