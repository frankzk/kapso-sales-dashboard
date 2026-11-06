// «Llamar con Anura», fase 2: el teléfono dentro de Kapta (lib/anura/sip-phone.ts)
// con un UA de JsSIP simulado. Ninguna prueba abre un WebSocket ni habla SIP.
//   - el orden: candado → credenciales → micrófono → registro → Click2Dial →
//     Kapta contesta SOLA el aviso de su propia llamada;
//   - SOLO SALIDAS: un INVITE sin llamada pedida en esta pestaña (45 s) se
//     rechaza con 486, sin sonar; uno solo por llamada;
//   - ante el PRIMER rechazo de la clave se detiene, se marca en el servidor y
//     no se reintenta (ni siquiera si el WebSocket se reconecta);
//   - sin micrófono no se pide la llamada; otra pestaña con el teléfono no deja;
//   - se desregistra al colgar o si Anura no hace sonar el teléfono en 45 s;
//   - ICE: no espera toda la recolección (srflx en el acto, si no 1,5 s);
//   - el aviso que llega antes de que el servidor confirme el Click2Dial
//     espera sin contestar y se rechaza si Anura no lo aceptó;
//   - la pestaña recuerda la clave rechazada aunque el servidor no la marque,
//     y espera un minuto tras un corte o un «no respondió»;
//   - un fallo de registro ya en llamada apaga el registro automático de JsSIP.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ANURA_ICE_MAX_WAIT_MS,
  ANURA_INVITE_WINDOW_MS,
  ANURA_KAPTA_START_TEXT,
  ANURA_PHONE_COOLDOWN_MS,
  ANURA_PHONE_REGISTER_TIMEOUT_MS,
  ANURA_PHONE_TEXT,
  ANURA_REGISTRATION_TEST_TEXT,
  ANURA_REGISTRATION_TEXT,
  anuraJsSipConfig,
  createAnuraPhone,
  createAnuraPhoneMemory,
  createAnuraTabLock,
  iceCandidateType,
  iceReadyNow,
  registrationFailureKind,
  registrationFailureStatus,
  rejectionReason,
  shouldAnswerInvite,
  testAnuraRegistration,
  type AnuraPhoneCredentials,
  type AnuraPhoneDeps,
  type AnuraPhoneSnapshot,
  type BroadcastLike,
  type LockManagerLike,
} from "@/lib/anura/sip-phone";
import type { AnuraStartResult } from "@/lib/anura/calls";

type Listener = (e: any) => void;

class Emitter {
  listeners = new Map<string, Listener[]>();
  on(event: string, cb: Listener) {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), cb]);
    return this;
  }
  emit(event: string, data?: unknown) {
    for (const cb of this.listeners.get(event) ?? []) cb(data);
  }
}

class FakeUa extends Emitter {
  started = 0;
  stopped = 0;
  registers = 0;
  registered = false;
  start() {
    this.started += 1;
  }
  stop() {
    this.stopped += 1;
    this.registered = false;
  }
  register() {
    this.registers += 1;
  }
  unregisters = 0;
  unregister() {
    this.unregisters += 1;
  }
  isRegistered() {
    return this.registered;
  }
}

class FakeSession extends Emitter {
  answered: Record<string, unknown> | null = null;
  terminated: { status_code?: number }[] = [];
  muted = false;
  ended = false;
  answer(opts: Record<string, unknown>) {
    this.answered = opts;
  }
  terminate(opts?: { status_code?: number }) {
    this.terminated.push(opts ?? {});
    this.ended = true;
  }
  mute() {
    this.muted = true;
  }
  unmute() {
    this.muted = false;
  }
  isEnded() {
    return this.ended;
  }
}

const CREDS: AnuraPhoneCredentials = {
  extension: "101",
  sipUser: "101-websocket",
  password: "clave-sip-de-prueba",
  domain: "kenku.anura.pe",
  wsUrl: "wss://sipwss.anura.pe",
  port: 55090,
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
  credentialVersion: "2026-11-06T10:00:00.000Z",
};

const flush = () => vi.advanceTimersByTimeAsync(0);

function harness(over: Partial<AnuraPhoneDeps> = {}) {
  const ua = new FakeUa();
  const track = { stop: vi.fn() };
  const mic = { getTracks: () => [track] };
  const released = vi.fn();
  const snapshots: AnuraPhoneSnapshot[] = [];
  const streams: unknown[] = [];
  const deps: AnuraPhoneDeps = {
    createUa: vi.fn(async () => ua),
    getMicrophone: vi.fn(async () => mic),
    lock: { acquire: vi.fn(async () => ({ release: released })) },
    fetchCredentials: vi.fn(async () => ({ ok: true as const, phone: CREDS })),
    requestCall: vi.fn(async (): Promise<AnuraStartResult> => ({ ok: true, callId: "call-1", extension: "101", toMasked: "98••••321" })),
    reportRejected: vi.fn(async () => ({ ok: true })),
    onChange: (s) => snapshots.push(s),
    onRemoteStream: (s) => streams.push(s),
    ...over,
  };
  const phone = createAnuraPhone(deps);
  return { phone, deps, ua, mic, track, released, snapshots, streams };
}

/** Hasta el registro aceptado (Click2Dial ya pedido). */
async function untilRegistered(h: ReturnType<typeof harness>) {
  const done = h.phone.call();
  await flush();
  h.ua.emit("connected");
  h.ua.emit("registered");
  await flush();
  return { done };
}

function invite(h: ReturnType<typeof harness>, originator = "remote") {
  const session = new FakeSession();
  h.ua.emit("newRTCSession", { session, originator });
  return session;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-06T15:00:00.000Z"));
});
afterEach(() => {
  vi.useRealTimers();
});

describe("¿contesto este INVITE?", () => {
  const now = 1_000_000;
  it("solo el de la llamada que esta pestaña acaba de pedir", () => {
    expect(shouldAnswerInvite({ pending: { sinceMs: now - 3_000, answered: false }, nowMs: now, inCall: false })).toEqual({ answer: true });
    expect(shouldAnswerInvite({ pending: null, nowMs: now, inCall: false })).toMatchObject({ answer: false, statusCode: 486, why: "sin_llamada_pedida" });
    expect(shouldAnswerInvite({ pending: { sinceMs: now - ANURA_INVITE_WINDOW_MS - 1, answered: false }, nowMs: now, inCall: false })).toMatchObject({
      answer: false,
      why: "fuera_de_tiempo",
    });
    expect(shouldAnswerInvite({ pending: { sinceMs: now, answered: true }, nowMs: now, inCall: false })).toMatchObject({ why: "ya_contestada" });
    expect(shouldAnswerInvite({ pending: { sinceMs: now, answered: false }, nowMs: now, inCall: true })).toMatchObject({ why: "ya_en_llamada" });
  });
  it("nunca rechaza con 6xx (cortaría todas las ramas en Anura)", () => {
    const r = shouldAnswerInvite({ pending: null, nowMs: now, inCall: false });
    expect(r.answer ? 0 : r.statusCode).toBe(486);
  });
});

describe("los fallos de registro", () => {
  it("la clave: 401, 403, 407 o la causa de JsSIP", () => {
    for (const status_code of [401, 403, 407]) expect(registrationFailureKind({ response: { status_code } })).toBe("clave");
    expect(registrationFailureKind({ cause: "Authentication Error", response: null })).toBe("clave");
    expect(registrationFailureKind({ cause: "Rejected" })).toBe("clave");
  });
  it("el dominio: 404, 604 o «Not Found» (Anura no conoce ese usuario en ese dominio)", () => {
    for (const status_code of [404, 604]) expect(registrationFailureKind({ response: { status_code } })).toBe("dominio");
    expect(registrationFailureKind({ cause: "Not Found", response: null })).toBe("dominio");
    // El código manda sobre la causa.
    expect(registrationFailureKind({ cause: "Not Found", response: { status_code: 401 } })).toBe("clave");
    expect(registrationFailureKind({ cause: "Rejected", response: { status_code: 404 } })).toBe("dominio");
    expect(ANURA_REGISTRATION_TEXT.dominio).toMatch(/dominio de la central/);
    expect(ANURA_REGISTRATION_TEXT.dominio).not.toMatch(/vuelva a guardar/);
  });
  it("la red, el tiempo y lo demás", () => {
    expect(registrationFailureKind({ cause: "Connection Error", response: null })).toBe("red");
    expect(registrationFailureKind({})).toBe("red");
    expect(registrationFailureKind({ cause: "Request Timeout" })).toBe("tiempo");
    expect(registrationFailureKind({ response: { status_code: 408 } })).toBe("tiempo");
    expect(registrationFailureKind({ cause: "SIP Failure Code", response: { status_code: 500 } })).toBe("otro");
    expect(registrationFailureStatus({ response: { status_code: 403 } })).toBe(403);
    expect(registrationFailureStatus({ response: null })).toBeNull();
  });
  it("el motivo que se guarda no lleva datos de la persona", () => {
    expect(rejectionReason("clave", 401)).toBe("Anura rechazó el usuario o la clave del teléfono de Kapta (SIP 401).");
    expect(rejectionReason("clave", null)).not.toMatch(/SIP/);
    expect(rejectionReason("dominio", 404)).toBe("Anura no reconoce el usuario SIP en el dominio de la central (SIP 404).");
    expect(rejectionReason("dominio", null)).toBe("Anura no reconoce el usuario SIP en el dominio de la central.");
  });
});

describe("ICE", () => {
  it("un candidato público basta; con solo locales se espera", () => {
    expect(iceReadyNow({ type: "srflx" })).toBe(true);
    expect(iceReadyNow({ candidate: "candidate:1 1 udp 1 200.1.1.1 5000 typ relay" })).toBe(true);
    expect(iceReadyNow({ type: "host" })).toBe(false);
    expect(iceCandidateType({ candidate: "candidate:1 1 udp 1 10.0.0.2 5000 typ host" })).toBe("host");
    expect(iceCandidateType(null)).toBeNull();
  });
});

describe("la configuración de JsSIP", () => {
  it("registra a mano, con el puerto de la central en el registrador", () => {
    const socket = { fake: true };
    const cfg = anuraJsSipConfig(CREDS, socket);
    expect(cfg).toMatchObject({
      sockets: [socket],
      uri: "sip:101-websocket@kenku.anura.pe",
      authorization_user: "101-websocket",
      register: false,
      registrar_server: "sip:kenku.anura.pe:55090",
      session_timers: false,
    });
    expect(cfg.register_expires).toBeLessThanOrEqual(120);
  });
});

describe("el teléfono: el camino feliz", () => {
  it("registra, pide la llamada, contesta SOLA el aviso y cuelga", async () => {
    const h = harness();
    const { done } = await untilRegistered(h);
    expect(h.deps.fetchCredentials).toHaveBeenCalledTimes(1);
    expect(h.deps.getMicrophone).toHaveBeenCalledTimes(1);
    expect(h.ua.started).toBe(1);
    expect(h.ua.registers).toBe(1);
    expect(h.deps.requestCall).toHaveBeenCalledTimes(1);
    expect(h.phone.snapshot()).toMatchObject({ phase: "esperando_anura", callId: "call-1", toMasked: "98••••321", extension: "101", busy: true });

    const s = invite(h);
    expect(s.answered).toMatchObject({ mediaStream: h.mic, pcConfig: { iceServers: CREDS.iceServers } });
    expect(s.terminated).toEqual([]);
    s.emit("confirmed");
    const snap = await done;
    expect(snap).toMatchObject({ phase: "en_llamada", answeredAt: Date.now() });

    // Un segundo aviso mientras habla: 486, sin sonar.
    const other = invite(h);
    expect(other.answered).toBeNull();
    expect(other.terminated).toEqual([{ status_code: 486, reason_phrase: "Busy Here" }]);

    h.phone.setMuted(true);
    expect(s.muted).toBe(true);
    expect(h.phone.snapshot().muted).toBe(true);
    h.phone.setMuted(false);
    expect(s.muted).toBe(false);

    h.phone.hangUp();
    expect(s.terminated.length).toBe(1);
    expect(h.ua.stopped).toBe(1);
    expect(h.track.stop).toHaveBeenCalled();
    expect(h.released).toHaveBeenCalledTimes(1);
    expect(h.phone.snapshot()).toMatchObject({ phase: "terminada", busy: false });
    expect(h.streams.at(-1)).toBeNull();
  });

  it("el aviso puede llegar antes que la respuesta del servidor", async () => {
    let answer: (r: AnuraStartResult) => void = () => {};
    const h = harness({ requestCall: vi.fn(() => new Promise<AnuraStartResult>((r) => (answer = r))) });
    void h.phone.call();
    await flush();
    h.ua.emit("connected");
    h.ua.emit("registered");
    await flush();
    const s = invite(h);
    // Espera, sin contestar ni rechazar, a que el servidor confirme el Click2Dial.
    expect(s.answered).toBeNull();
    expect(s.terminated).toHaveLength(0);
    // Uno de más mientras espera: 486.
    const extra = invite(h);
    expect(extra.terminated).toEqual([{ status_code: 486, reason_phrase: "Busy Here" }]);
    answer({ ok: true, callId: "call-1", extension: "101", toMasked: "98••••321" });
    await flush();
    expect(s.answered).not.toBeNull();
    s.emit("confirmed");
    expect(h.phone.snapshot()).toMatchObject({ phase: "en_llamada", callId: "call-1" });
  });

  it("si el servidor no acepta el Click2Dial, el aviso que esperaba se rechaza con 486", async () => {
    let answer: (r: AnuraStartResult) => void = () => {};
    const h = harness({ requestCall: vi.fn(() => new Promise<AnuraStartResult>((r) => (answer = r))) });
    const done = h.phone.call();
    await flush();
    h.ua.emit("connected");
    h.ua.emit("registered");
    await flush();
    const s = invite(h);
    answer({ ok: false, code: "rechazo", error: "Anura rechazó la llamada." });
    const snap = await done;
    expect(s.answered).toBeNull();
    expect(s.terminated).toEqual([{ status_code: 486, reason_phrase: "Busy Here" }]);
    expect(snap.error).toMatchObject({ code: "llamada_rechazada" });
  });

  it("si el aviso en espera se corta, el siguiente de la ventana todavía vale", async () => {
    let answer: (r: AnuraStartResult) => void = () => {};
    const h = harness({ requestCall: vi.fn(() => new Promise<AnuraStartResult>((r) => (answer = r))) });
    void h.phone.call();
    await flush();
    h.ua.emit("connected");
    h.ua.emit("registered");
    await flush();
    const first = invite(h);
    first.emit("failed", { originator: "remote", cause: "Canceled" });
    expect(h.phone.snapshot().phase).toBe("pidiendo");
    const second = invite(h);
    answer({ ok: true, callId: "call-1", extension: "101", toMasked: "98••••321" });
    await flush();
    expect(first.answered).toBeNull();
    expect(second.answered).not.toBeNull();
  });

  it("el audio de Anura va al <audio>; al terminar se suelta", async () => {
    const h = harness();
    await untilRegistered(h);
    const s = invite(h);
    const listeners: ((e: unknown) => void)[] = [];
    s.emit("peerconnection", { peerconnection: { addEventListener: (_t: string, cb: (e: unknown) => void) => listeners.push(cb) } });
    const stream = { id: "remoto" };
    listeners[0]!({ streams: [stream], track: {} });
    expect(h.streams).toContain(stream);
    s.emit("confirmed");
    s.emit("ended", { originator: "remote" });
    expect(h.streams.at(-1)).toBeNull();
    // La clienta colgó (o Anura cortó): no fue la asesora.
    expect(h.phone.snapshot()).toMatchObject({ phase: "terminada", endedBy: "anura" });
    expect(h.ua.stopped).toBe(1);
  });

  it("colgar desde Kapta queda como «la asesora colgó»", async () => {
    const h = harness();
    await untilRegistered(h);
    const s = invite(h);
    s.emit("confirmed");
    h.phone.hangUp();
    expect(h.phone.snapshot()).toMatchObject({ phase: "terminada", endedBy: "kapta" });
    expect(s.terminated).toHaveLength(1);
  });

  it("ICE: srflx contesta en el acto; con solo host, a los 1,5 s", async () => {
    const h = harness();
    await untilRegistered(h);
    const s = invite(h);
    const ready = vi.fn();
    s.emit("icecandidate", { candidate: { type: "host" }, ready });
    await vi.advanceTimersByTimeAsync(ANURA_ICE_MAX_WAIT_MS - 10);
    expect(ready).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(20);
    expect(ready).toHaveBeenCalledTimes(1);
    const ready2 = vi.fn();
    s.emit("icecandidate", { candidate: { type: "srflx" }, ready: ready2 });
    expect(ready2).toHaveBeenCalledTimes(1);
  });
});

describe("el teléfono: solo salidas", () => {
  it("un INVITE con el teléfono apagado no existe; uno local se corta", async () => {
    const h = harness();
    await untilRegistered(h);
    const local = invite(h, "local");
    expect(local.answered).toBeNull();
    expect(local.terminated[0]).toMatchObject({ status_code: 486 });
  });

  it("si Anura no hace sonar el teléfono en 45 s, se desregistra y lo dice", async () => {
    const h = harness();
    const { done } = await untilRegistered(h);
    await vi.advanceTimersByTimeAsync(ANURA_INVITE_WINDOW_MS + 1);
    const snap = await done;
    expect(snap).toMatchObject({ phase: "error", error: { code: "anura_no_llamo", message: ANURA_PHONE_TEXT.anura_no_llamo } });
    expect(h.ua.stopped).toBe(1);
    expect(h.released).toHaveBeenCalled();
    // Y un aviso que llegara después ya no se contesta.
    const late = invite(h);
    expect(late.answered).toBeNull();
    expect(late.terminated[0]).toMatchObject({ status_code: 486 });
  });
});

describe("el teléfono: la clave rechazada", () => {
  it("se detiene al PRIMER rechazo, lo marca y no reintenta", async () => {
    const h = harness();
    const done = h.phone.call();
    await flush();
    h.ua.emit("connected");
    h.ua.emit("registrationFailed", { cause: "Authentication Error", response: { status_code: 401 } });
    const snap = await done;
    expect(snap).toMatchObject({ phase: "error", error: { code: "registro", registration: "clave", message: ANURA_REGISTRATION_TEXT.clave } });
    expect(h.deps.reportRejected).toHaveBeenCalledWith({ credentialVersion: CREDS.credentialVersion, kind: "clave", status: 401 });
    expect(h.ua.stopped).toBe(1);
    expect(h.deps.requestCall).not.toHaveBeenCalled();
    // Un WebSocket que se reconecta no vuelve a registrar.
    h.ua.emit("connected");
    h.ua.emit("disconnected");
    expect(h.ua.registers).toBe(1);
    expect(h.deps.reportRejected).toHaveBeenCalledTimes(1);
    expect(h.released).toHaveBeenCalledTimes(1);
  });

  it("con la clave ya rechazada en el servidor no se intenta nada", async () => {
    const h = harness({
      fetchCredentials: vi.fn(async () => ({ ok: false as const, code: "clave_rechazada" as const, error: "Anura rechazó la clave del teléfono de Kapta; pide a quien administra que la vuelva a guardar." })),
    });
    const snap = await h.phone.call();
    expect(snap.error).toMatchObject({ code: "credenciales", credentialsCode: "clave_rechazada" });
    expect(h.deps.getMicrophone).not.toHaveBeenCalled();
    expect(h.deps.createUa).not.toHaveBeenCalled();
    expect(h.released).toHaveBeenCalled();
  });

  it("si el servidor no llega a marcarla, la pestaña no vuelve a registrar con esa clave", async () => {
    const memory = createAnuraPhoneMemory();
    const reportRejected = vi.fn(async () => Promise.reject(new Error("red")));
    const h = harness({ memory, reportRejected });
    const done = h.phone.call();
    await flush();
    h.ua.emit("connected");
    h.ua.emit("registrationFailed", { cause: "Authentication Error", response: { status_code: 401 } });
    await done;
    // El panel sigue diciendo «listo» y el servidor vuelve a entregar la misma clave.
    const again = await h.phone.call();
    expect(again.error).toMatchObject({ code: "registro", registration: "clave", message: ANURA_REGISTRATION_TEXT.clave });
    expect(h.deps.createUa).toHaveBeenCalledTimes(1);
    expect(h.deps.getMicrophone).toHaveBeenCalledTimes(1);
    // Se vuelve a avisar al servidor (no a Anura).
    expect(reportRejected).toHaveBeenCalledTimes(2);
    // Otro teléfono de la misma pestaña (la ficha cerrada y abierta) tampoco.
    const h2 = harness({ memory, reportRejected });
    expect((await h2.phone.call()).error).toMatchObject({ code: "registro", registration: "clave" });
    expect(h2.deps.createUa).not.toHaveBeenCalled();
    // Con otra clave guardada (otra versión) sí se intenta.
    const h3 = harness({ memory, fetchCredentials: vi.fn(async () => ({ ok: true as const, phone: { ...CREDS, credentialVersion: "2026-11-06T11:00:00.000Z" } })) });
    void h3.phone.call();
    await flush();
    expect(h3.deps.createUa).toHaveBeenCalledTimes(1);
  });

  it("un 404 se detiene igual, avisa «dominio» con el dominio probado y no reintenta", async () => {
    const h = harness();
    const done = h.phone.call();
    await flush();
    h.ua.emit("connected");
    h.ua.emit("registrationFailed", { cause: "Not Found", response: { status_code: 404 } });
    const snap = await done;
    expect(snap).toMatchObject({ phase: "error", error: { code: "registro", registration: "dominio", message: ANURA_REGISTRATION_TEXT.dominio } });
    expect(h.deps.reportRejected).toHaveBeenCalledWith({ credentialVersion: CREDS.credentialVersion, kind: "dominio", status: 404, domain: CREDS.domain });
    expect(h.deps.requestCall).not.toHaveBeenCalled();
    h.ua.emit("connected");
    expect(h.ua.registers).toBe(1);
  });

  it("la pestaña recuerda el 404 de esa clave CON ese dominio: con el dominio corregido vuelve a intentar", async () => {
    const memory = createAnuraPhoneMemory();
    const reportRejected = vi.fn(async () => Promise.reject(new Error("red")));
    const h = harness({ memory, reportRejected });
    const done = h.phone.call();
    await flush();
    h.ua.emit("connected");
    h.ua.emit("registrationFailed", { cause: "Not Found", response: { status_code: 404 } });
    await done;
    // Mismo dominio: no se registra otra vez, se vuelve a avisar al servidor.
    const again = await h.phone.call();
    expect(again.error).toMatchObject({ code: "registro", registration: "dominio" });
    expect(h.deps.createUa).toHaveBeenCalledTimes(1);
    expect(reportRejected).toHaveBeenCalledTimes(2);
    // Con el dominio corregido (misma versión de la clave) sí.
    const h2 = harness({ memory, fetchCredentials: vi.fn(async () => ({ ok: true as const, phone: { ...CREDS, domain: "kenku-pe.anura.pe" } })) });
    void h2.phone.call();
    await flush();
    expect(h2.deps.createUa).toHaveBeenCalledTimes(1);
    // Una clave rechazada (401) no la arregla otro dominio.
    const memory2 = createAnuraPhoneMemory();
    memory2.markRejected(CREDS.extension, CREDS.credentialVersion, "clave", CREDS.domain);
    expect(memory2.rejectedKind(CREDS.extension, CREDS.credentialVersion, "otro.anura.pe")).toBe("clave");
    expect(memory.rejectedKind(CREDS.extension, CREDS.credentialVersion, CREDS.domain)).toBe("dominio");
    expect(memory.rejectedKind(CREDS.extension, CREDS.credentialVersion, "kenku-pe.anura.pe")).toBeNull();
  });

  it("si Anura rechaza la clave ya en llamada, el audio sigue y no se manda otro REGISTER", async () => {
    const h = harness();
    await untilRegistered(h);
    const s = invite(h);
    s.emit("confirmed");
    h.ua.emit("registrationFailed", { cause: "Authentication Error", response: { status_code: 401 } });
    expect(h.phone.snapshot().phase).toBe("en_llamada");
    expect(h.ua.unregisters).toBe(1);
    expect(h.deps.reportRejected).toHaveBeenCalledWith({ credentialVersion: CREDS.credentialVersion, kind: "clave", status: 401 });
  });

  it("tras un corte después del REGISTER o un «no respondió», espera un minuto", async () => {
    const memory = createAnuraPhoneMemory();
    const h = harness({ memory });
    const done = h.phone.call();
    await flush();
    h.ua.emit("connected");
    h.ua.emit("disconnected");
    expect((await done).error).toMatchObject({ code: "registro", registration: "red", message: ANURA_PHONE_TEXT.corte });
    expect(h.deps.reportRejected).not.toHaveBeenCalled();
    const again = await h.phone.call();
    expect(again.error).toMatchObject({ code: "espera", message: ANURA_PHONE_TEXT.espera });
    expect(h.deps.createUa).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(ANURA_PHONE_COOLDOWN_MS + 1);
    void h.phone.call();
    await flush();
    expect(h.deps.createUa).toHaveBeenCalledTimes(2);

    const h2 = harness({ memory: createAnuraPhoneMemory() });
    const done2 = h2.phone.call();
    await flush();
    h2.ua.emit("connected");
    await vi.advanceTimersByTimeAsync(ANURA_PHONE_REGISTER_TIMEOUT_MS + 1);
    await done2;
    expect((await h2.phone.call()).error?.code).toBe("espera");
  });

  it("sin conexión o sin respuesta no se marca la clave", async () => {
    const h = harness();
    const done = h.phone.call();
    await flush();
    h.ua.emit("disconnected");
    expect((await done).error).toMatchObject({ code: "registro", registration: "red" });
    expect(h.deps.reportRejected).not.toHaveBeenCalled();

    const h2 = harness();
    const done2 = h2.phone.call();
    await flush();
    h2.ua.emit("connected");
    await vi.advanceTimersByTimeAsync(ANURA_PHONE_REGISTER_TIMEOUT_MS + 1);
    expect((await done2).error).toMatchObject({ code: "registro", registration: "tiempo" });
    expect(h2.deps.reportRejected).not.toHaveBeenCalled();
    expect(h2.ua.stopped).toBe(1);
    expect(h2.ua.registers).toBe(1);
  });
});

describe("el teléfono: antes de registrar", () => {
  it("sin micrófono no se registra ni se pide la llamada", async () => {
    const h = harness({ getMicrophone: vi.fn(async () => Promise.reject(Object.assign(new Error("no"), { name: "NotAllowedError" }))) });
    const snap = await h.phone.call();
    expect(snap.error).toMatchObject({ code: "microfono_denegado", message: ANURA_PHONE_TEXT.microfono_denegado });
    expect(h.deps.createUa).not.toHaveBeenCalled();
    expect(h.deps.requestCall).not.toHaveBeenCalled();
    expect(h.released).toHaveBeenCalled();

    const h2 = harness({ getMicrophone: vi.fn(async () => Promise.reject(Object.assign(new Error("no"), { name: "NotFoundError" }))) });
    expect((await h2.phone.call()).error?.code).toBe("microfono_no_disponible");
  });

  it("con el teléfono abierto en otra pestaña no hace nada", async () => {
    const h = harness({ lock: { acquire: async () => null } });
    const snap = await h.phone.call();
    expect(snap.error).toMatchObject({ code: "otra_pestana", message: "Tienes una llamada abierta en otra pestaña de Kapta." });
    expect(h.deps.fetchCredentials).not.toHaveBeenCalled();
  });

  it("si el servidor no acepta la llamada, se desregistra y devuelve su respuesta", async () => {
    const h = harness({
      requestCall: vi.fn(async (): Promise<AnuraStartResult> => ({ ok: false, code: "ocupada", error: "Ya tienes una llamada en curso.", activeCallId: "x" })),
    });
    const snap = await (await untilRegistered(h)).done;
    expect(snap.error).toMatchObject({ code: "llamada_rechazada", start: { code: "ocupada" } });
    expect(h.ua.stopped).toBe(1);
  });

  it("con el teléfono de Kapta, los fallos de Click2Dial no hablan de «tu teléfono de Anura»", async () => {
    const h = harness({
      requestCall: vi.fn(async (): Promise<AnuraStartResult> => ({ ok: false, code: "terminal_no_registrada", error: "Anura no encuentra conectado tu teléfono de Anura." })),
    });
    const snap = await (await untilRegistered(h)).done;
    expect(snap.error).toMatchObject({ code: "llamada_rechazada", message: ANURA_KAPTA_START_TEXT.terminal_no_registrada });
    for (const text of Object.values(ANURA_KAPTA_START_TEXT)) expect(text).not.toMatch(/tu teléfono de Anura/);
  });

  it("si Click2Dial no respondió a tiempo, espera el aviso igual", async () => {
    const h = harness({
      requestCall: vi.fn(async (): Promise<AnuraStartResult> => ({ ok: false, code: "tiempo", error: "Anura no respondió.", activeCallId: "call-9" })),
    });
    await untilRegistered(h);
    expect(h.phone.snapshot()).toMatchObject({ phase: "esperando_anura", callId: "call-9" });
    const s = invite(h);
    expect(s.answered).not.toBeNull();
  });

  it("colgar mientras conecta cancela y suelta todo", async () => {
    const h = harness();
    void h.phone.call();
    await flush();
    h.phone.hangUp();
    expect(h.phone.snapshot().phase).toBe("terminada");
    expect(h.ua.stopped).toBe(1);
    h.ua.emit("connected");
    h.ua.emit("registered");
    await flush();
    expect(h.ua.registers).toBe(0);
    expect(h.deps.requestCall).not.toHaveBeenCalled();
  });
});

describe("el candado entre pestañas", () => {
  function fakeLocks(): LockManagerLike {
    const held = new Set<string>();
    return {
      async request(name, opts, cb) {
        if (held.has(name) && opts.ifAvailable) return cb(null);
        held.add(name);
        try {
          return await cb({ name });
        } finally {
          held.delete(name);
        }
      },
    };
  }

  it("navigator.locks: la segunda pestaña no lo obtiene hasta que la primera lo suelta", async () => {
    const locks = fakeLocks();
    const a = createAnuraTabLock({ locks });
    const b = createAnuraTabLock({ locks });
    const first = await a.acquire();
    expect(first).not.toBeNull();
    expect(await b.acquire()).toBeNull();
    first!.release();
    await flush();
    expect(await b.acquire()).not.toBeNull();
  });

  it("BroadcastChannel: la que lo tiene responde", async () => {
    const bus: BroadcastLike[] = [];
    const make = (): BroadcastLike => {
      const listeners = new Set<(e: { data: unknown }) => void>();
      const ch: BroadcastLike = {
        postMessage: (data) => {
          for (const other of bus) if (other !== ch) (other as any)._deliver(data);
        },
        addEventListener: (_t, l) => listeners.add(l),
        removeEventListener: (_t, l) => listeners.delete(l),
        close: () => {},
      };
      (ch as any)._deliver = (data: unknown) => listeners.forEach((l) => l({ data }));
      bus.push(ch);
      return ch;
    };
    const a = createAnuraTabLock({ broadcast: make });
    const b = createAnuraTabLock({ broadcast: make });
    const pa = a.acquire();
    await vi.advanceTimersByTimeAsync(400);
    const first = await pa;
    expect(first).not.toBeNull();
    const pb = b.acquire();
    await vi.advanceTimersByTimeAsync(400);
    expect(await pb).toBeNull();
    first!.release();
    const pc = b.acquire();
    await vi.advanceTimersByTimeAsync(400);
    expect(await pc).not.toBeNull();
  });

  it("sin locks ni BroadcastChannel deja pasar", async () => {
    expect(await createAnuraTabLock({}).acquire()).not.toBeNull();
  });
});

describe("«Probar y guardar»: UN registro, sin llamada", () => {
  it("acepta y se desconecta", async () => {
    const ua = new FakeUa();
    const p = testAnuraRegistration({ createUa: async () => ua }, CREDS);
    await flush();
    ua.emit("connected");
    ua.emit("registered");
    expect(await p).toEqual({ ok: true });
    expect(ua.stopped).toBe(1);
    expect(ua.registers).toBe(1);
  });

  it("rechaza una vez, se detiene y explica la clave de la -websocket", async () => {
    const ua = new FakeUa();
    const p = testAnuraRegistration({ createUa: async () => ua }, CREDS);
    await flush();
    ua.emit("connected");
    ua.emit("registrationFailed", { cause: "Rejected", response: { status_code: 403 } });
    const r = await p;
    expect(r).toMatchObject({ ok: false, kind: "clave" });
    expect(r.ok ? "" : r.message).toMatch(/-websocket/);
    expect(r.ok ? "" : r.message).toMatch(/bloquee la conexión de la oficina/);
    ua.emit("connected");
    expect(ua.registers).toBe(1);
    expect(ua.stopped).toBe(1);
  });

  it("un 404 dice que revise el dominio, no la contraseña", async () => {
    const ua = new FakeUa();
    const p = testAnuraRegistration({ createUa: async () => ua }, CREDS);
    await flush();
    ua.emit("connected");
    ua.emit("registrationFailed", { cause: "Not Found", response: { status_code: 404 } });
    const r = await p;
    expect(r).toMatchObject({ ok: false, kind: "dominio", message: ANURA_REGISTRATION_TEST_TEXT.dominio });
    expect(r.ok ? "" : r.message).toMatch(/Revisa el dominio de la central/);
    expect(r.ok ? "" : r.message).toMatch(/bloquee la conexión de la oficina/);
    expect(ua.registers).toBe(1);
  });

  it("si Anura no responde, se abandona a los 8 s", async () => {
    const ua = new FakeUa();
    const p = testAnuraRegistration({ createUa: async () => ua }, CREDS);
    await vi.advanceTimersByTimeAsync(ANURA_PHONE_REGISTER_TIMEOUT_MS + 1);
    expect(await p).toMatchObject({ ok: false, kind: "tiempo" });
    expect(ua.stopped).toBe(1);
  });

  it("un INVITE durante la prueba no suena", async () => {
    const ua = new FakeUa();
    void testAnuraRegistration({ createUa: async () => ua }, CREDS);
    await flush();
    const s = new FakeSession();
    ua.emit("newRTCSession", { session: s, originator: "remote" });
    expect(s.answered).toBeNull();
    expect(s.terminated[0]).toMatchObject({ status_code: 486 });
  });
});
