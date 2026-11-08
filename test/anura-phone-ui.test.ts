// «Llamar con Anura», fase 2: la UI del teléfono DENTRO de Kapta (solo
// salidas; MOM §8.7). Sin navegador: se prueban la lógica pura de la UI
// (lib/anura/phone-ui.ts) con el teléfono simulado de lib/anura/sip-phone.ts,
// y el cableado de la ficha y de Ajustes por su texto, como test/anura-ui.test.ts.
//   - la ficha elige el modo por `panel.kaptaPhone.status` (listo / fase 1 /
//     bloqueado) y dice en cada fase lo que pasa;
//   - Colgar y Silenciar solo con el teléfono de Kapta;
//   - «Probar y guardar»: UN registro con lo escrito y solo entonces se guarda;
//   - la clave nunca se guarda en el navegador ni se escribe en la consola;
//   - la grabación por la ruta del mismo origen.

import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ANURA_PHONE_BLOCKED_TITLE,
  ANURA_PHONE_RESUMED_HINT,
  anuraPhoneCanMute,
  anuraPhoneEndedLine,
  anuraPhoneErrorTitle,
  anuraPhoneHangUpLabel,
  anuraPhoneHint,
  anuraPhoneModeOf,
  anuraPhoneNeedsPanelReload,
  anuraPhoneOutlivesServer,
  anuraPhoneStatusLabel,
  anuraRecordingSrc,
  anuraSipPhoneBadge,
  anuraSipPhoneLines,
  anuraSipTestCredentials,
  anuraTestCallWay,
  anuraTestFallsBack,
  anuraDomainNotFoundBanner,
  anuraSipTestKey,
  anuraTalkClock,
  ANURA_SIP_TEST_REPEAT_TEXT,
  isAnuraPhoneBlocked,
  parseAnuraSipCentral,
  talkSecondsFrom,
  talkSecondsSince,
} from "@/lib/anura/phone-ui";
import {
  ANURA_PHONE_TEXT,
  ANURA_REGISTRATION_TEST_TEXT,
  createAnuraPhone,
  testAnuraRegistration,
  type AnuraPhoneCredentials,
  type AnuraPhoneSnapshot,
} from "@/lib/anura/sip-phone";
import { ANURA_KAPTA_PHONE_OUTBOUND_ONLY } from "@/lib/anura/sip";
import type { AnuraStartResult } from "@/lib/anura/calls";

const ROOT = path.resolve(__dirname, "..");
const read = (file: string) => readFileSync(path.join(ROOT, file), "utf8");

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
  registers = 0;
  stopped = 0;
  start() {}
  stop() {
    this.stopped += 1;
  }
  register() {
    this.registers += 1;
  }
  isRegistered() {
    return false;
  }
}
class FakeSession extends Emitter {
  terminated: { status_code?: number }[] = [];
  ended = false;
  answer() {}
  terminate(opts?: { status_code?: number }) {
    this.terminated.push(opts ?? {});
    this.ended = true;
  }
  mute() {}
  unmute() {}
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

const live = (status: "solicitada" | "sonando" | "en_curso" | "contestada", active = true) => ({
  status,
  statusLabel: { solicitada: "Llamada pedida", sonando: "Sonando", en_curso: "En llamada", contestada: "Contestó" }[status],
  active,
  toMasked: "98••••321",
});

describe("la ficha elige cómo llamar", () => {
  it("listo → teléfono de Kapta; sin teléfono → fase 1; rechazada o sin dominio → no se llama", () => {
    expect(anuraPhoneModeOf({ status: "listo" })).toBe("kapta");
    expect(anuraPhoneModeOf({ status: "sin_telefono" })).toBe("fase1");
    expect(anuraPhoneModeOf(null)).toBe("fase1");
    expect(anuraPhoneModeOf(undefined)).toBe("fase1");
    expect(anuraPhoneModeOf({ status: "clave_rechazada" })).toBe("bloqueado");
    expect(anuraPhoneModeOf({ status: "sin_dominio" })).toBe("bloqueado");
    expect(ANURA_PHONE_BLOCKED_TITLE.clave_rechazada).toMatch(/rechazó la clave/);
  });
});

describe("lo que dice la tarjeta en cada fase", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("el recorrido entero con el teléfono simulado: conectando → llamando → en llamada → colgaste", async () => {
    const ua = new FakeUa();
    const seen: AnuraPhoneSnapshot[] = [];
    const phone = createAnuraPhone({
      createUa: async () => ua,
      getMicrophone: async () => ({ getTracks: () => [{ stop() {} }] }),
      lock: { acquire: async () => ({ release() {} }) },
      fetchCredentials: async () => ({ ok: true, phone: CREDS }),
      requestCall: async (): Promise<AnuraStartResult> => ({ ok: true, callId: "call-1", extension: "101", toMasked: "98••••321" }),
      reportRejected: async () => ({}),
      onChange: (s) => seen.push(s),
      onRemoteStream: () => {},
    });
    const done = phone.call();
    expect(anuraPhoneStatusLabel(phone.snapshot(), null)).toBe(ANURA_PHONE_TEXT.conectando);
    await vi.advanceTimersByTimeAsync(0);
    expect(anuraPhoneHint(phone.snapshot(), null)).toMatch(/solo para esta llamada/);
    expect(anuraPhoneHangUpLabel(phone.snapshot())).toBe("Cancelar");
    expect(anuraPhoneCanMute(phone.snapshot())).toBe(false);
    ua.emit("connected");
    ua.emit("registered");
    await vi.advanceTimersByTimeAsync(0);
    expect(phone.snapshot().phase).toBe("esperando_anura");
    expect(anuraPhoneStatusLabel(phone.snapshot(), live("solicitada"))).toBe(ANURA_PHONE_TEXT.esperando_anura);

    // El aviso de su propio Click2Dial: Kapta lo contesta sola.
    const session = new FakeSession();
    ua.emit("newRTCSession", { session, originator: "remote" });
    session.emit("confirmed");
    await done;
    const inCall = phone.snapshot();
    expect(inCall.phase).toBe("en_llamada");
    expect(anuraPhoneStatusLabel(inCall, live("solicitada"))).toBe("Llamando a 98••••321…");
    expect(anuraPhoneHint(inCall, live("sonando"))).toMatch(/oirás su timbre/);
    expect(anuraPhoneStatusLabel(inCall, live("en_curso"))).toBe("En llamada");
    expect(anuraPhoneHangUpLabel(inCall)).toBe("Colgar");
    expect(anuraPhoneCanMute(inCall)).toBe(true);

    // Colgar desregistra; mientras Anura no avisa el fin, se dice que colgó.
    phone.hangUp();
    expect(ua.stopped).toBe(1);
    expect(anuraPhoneStatusLabel(phone.snapshot(), live("en_curso"))).toBe("Colgaste");
    expect(anuraPhoneHint(phone.snapshot(), live("en_curso"))).toMatch(/espera el aviso de fin/);
    // Con el fin de Anura manda el estado final.
    expect(anuraPhoneStatusLabel(phone.snapshot(), live("contestada", false))).toBe("Contestó");
    expect(seen.length).toBeGreaterThan(3);
  });

  it("una llamada retomada sin teléfono en marcha muestra lo del sondeo", () => {
    expect(anuraPhoneStatusLabel(null, live("sonando"))).toBe("Sonando");
    expect(anuraPhoneHint(null, live("sonando"))).toBe(ANURA_PHONE_RESUMED_HINT);
    expect(ANURA_PHONE_RESUMED_HINT).toMatch(/otra pestaña de Kapta/);
    expect(ANURA_PHONE_RESUMED_HINT).not.toMatch(/teléfono de Anura/);
    expect(anuraPhoneStatusLabel(null, null)).toBe("");
  });

  it("si cortó Anura (la clienta colgó), no dice «Colgaste»", () => {
    const ended = { phase: "terminada" as const, toMasked: "98••••321", endedBy: "anura" as const };
    expect(anuraPhoneStatusLabel(ended, live("en_curso"))).toBe("Llamada terminada");
    expect(anuraPhoneHint(ended, live("en_curso"))).toMatch(/^Anura terminó la llamada/);
    expect(anuraPhoneStatusLabel({ ...ended, endedBy: "kapta" }, live("en_curso"))).toBe("Colgaste");
  });

  it("el plazo del servidor no corta una llamada en la que Kapta ya está", () => {
    const inCall = { phase: "en_llamada" as const, toMasked: "98••••321" };
    const closed = { ...live("solicitada", false), status: "fallida" as const, statusLabel: "No se pudo llamar", closedByTimeout: true };
    expect(anuraPhoneOutlivesServer(inCall, closed)).toBe(true);
    expect(anuraPhoneStatusLabel(inCall, closed)).toBe("En llamada");
    expect(anuraPhoneHint(inCall, closed)).toMatch(/sigues en ella/);
    // Un fin de verdad de Anura sí manda.
    expect(anuraPhoneOutlivesServer(inCall, { ...closed, closedByTimeout: false })).toBe(false);
    // Sin Kapta en la llamada, el plazo cierra como en la fase 1.
    expect(anuraPhoneOutlivesServer({ phase: "esperando_anura" }, closed)).toBe(false);
    // Lo que se dice al final, sin «tu teléfono de Anura».
    const line = anuraPhoneEndedLine({ status: "fallida", billSeconds: null, failureReason: "Revisa que tu teléfono de Anura esté conectado.", closedByTimeout: true });
    expect(line).toMatch(/Kapta no recibió los avisos de Anura/);
    expect(line).not.toMatch(/teléfono de Anura/);
    expect(anuraPhoneEndedLine({ status: "contestada", billSeconds: 0, failureReason: null, closedByTimeout: false })).toBe("Contestó");
  });

  it("los segundos hablados salen de la hora del servidor", () => {
    expect(talkSecondsSince("2026-11-06T10:00:00.000Z", Date.parse("2026-11-06T10:02:13.400Z"))).toBe(133);
    expect(talkSecondsSince(null, Date.now())).toBe(0);
    expect(talkSecondsSince("no es fecha", Date.now())).toBe(0);
  });

  describe("el reloj de la tarjeta (anuraTalkClock)", () => {
    const T0 = Date.parse("2026-11-06T10:00:00.000Z");
    const TALK = "2026-11-06T10:00:05.000Z";
    const live = { status: "en_curso" as const, active: true, answeredAt: TALK, closedByTimeout: false };
    // El servidor la cerró por su plazo: «No se pudo llamar», sin TALK.
    const closed = { status: "fallida" as const, active: false, answeredAt: null, closedByTimeout: true };

    it("en curso según Anura: desde el TALK del servidor", () => {
      expect(anuraTalkClock({ phase: "en_llamada", answeredAt: T0 }, live, true)).toEqual({ running: true, fromMs: Date.parse(TALK) });
      expect(anuraTalkClock(null, live, false)).toEqual({ running: true, fromMs: Date.parse(TALK) });
      // Con el teléfono de Kapta, al colgar se para aunque el fin de Anura no haya llegado.
      expect(anuraTalkClock({ phase: "terminada", answeredAt: T0 }, live, true).running).toBe(false);
    });

    it("cerrada por plazo del servidor con Kapta todavía en la llamada: desde que el teléfono contestó", () => {
      const clock = anuraTalkClock({ phase: "en_llamada", answeredAt: T0 }, closed, true);
      expect(clock).toEqual({ running: true, fromMs: T0 });
      expect(talkSecondsFrom(clock.fromMs, T0 + 95_400)).toBe(95);
      // Si el TALK sí llegó, pero el plazo de 2 h la cerró igual, manda el teléfono.
      expect(anuraTalkClock({ phase: "en_llamada", answeredAt: T0 }, { ...closed, answeredAt: TALK }, true).fromMs).toBe(T0);
      // Sin la hora del teléfono, la del servidor.
      expect(anuraTalkClock({ phase: "en_llamada", answeredAt: null }, { ...closed, answeredAt: TALK }, true).fromMs).toBe(Date.parse(TALK));
    });

    it("sin reloj: la llamada terminó de verdad, Kapta ya colgó, o no es el teléfono de Kapta", () => {
      expect(anuraTalkClock({ phase: "terminada", answeredAt: T0 }, closed, true).running).toBe(false);
      expect(anuraTalkClock(null, closed, false).running).toBe(false);
      expect(anuraTalkClock({ phase: "en_llamada", answeredAt: T0 }, { ...closed, closedByTimeout: false }, true).running).toBe(false);
      expect(anuraTalkClock({ phase: "esperando_anura", answeredAt: null }, { ...live, status: "sonando" }, true).running).toBe(false);
      expect(anuraTalkClock(null, null, true)).toEqual({ running: false, fromMs: null });
      expect(talkSecondsFrom(null, T0)).toBe(0);
    });

    it("la ficha y Ajustes usan el reloj, no el estado «en_curso»", () => {
      for (const f of ["components/anura-call.tsx", "components/anura-settings-section.tsx"]) {
        const src = read(f);
        expect(src, f).toContain("const clock = anuraTalkClock(snap, call, viaKapta);");
        expect(src, f).toContain("const talking = clock.running;");
        expect(src, f).toContain("formatTalkTime(talkSecondsFrom(clock.fromMs, now))");
        expect(src, f).not.toContain('const talking = call?.status === "en_curso"');
      }
    });
  });
});

describe("los fallos del teléfono", () => {
  it("cada código tiene su título en español", () => {
    expect(anuraPhoneErrorTitle({ code: "otra_pestana", message: ANURA_PHONE_TEXT.otra_pestana })).toBe("Ya tienes una llamada abierta");
    expect(anuraPhoneErrorTitle({ code: "microfono_denegado", message: "" })).toMatch(/micrófono/);
    expect(anuraPhoneErrorTitle({ code: "microfono_no_disponible", message: "" })).toBe("No hay micrófono");
    expect(anuraPhoneErrorTitle({ code: "registro", registration: "clave", message: "" })).toMatch(/rechazó la clave/);
    expect(anuraPhoneErrorTitle({ code: "registro", registration: "red", message: "" })).toBe("Sin conexión con Anura");
    expect(anuraPhoneErrorTitle({ code: "registro", registration: "tiempo", message: "" })).toBe("Anura no respondió");
    expect(anuraPhoneErrorTitle({ code: "credenciales", credentialsCode: "clave_rechazada", message: "" })).toMatch(/rechazó la clave/);
    expect(anuraPhoneErrorTitle({ code: "registro", registration: "dominio", message: "" })).toBe("Anura no reconoce el usuario o el dominio");
    expect(anuraPhoneErrorTitle({ code: "credenciales", credentialsCode: "dominio_no_reconocido", message: "" })).toBe("Anura no reconoce el usuario o el dominio");
    expect(anuraPhoneErrorTitle({ code: "credenciales", credentialsCode: "base", message: "" })).toBe("No se pudo preparar el teléfono de Kapta");
    expect(anuraPhoneErrorTitle({ code: "anura_no_llamo", message: ANURA_PHONE_TEXT.anura_no_llamo })).toMatch(/no hizo sonar/);
    expect(anuraPhoneErrorTitle({ code: "audio", message: "" })).toBe("No se pudo conectar el audio");
    expect(anuraPhoneErrorTitle({ code: "espera", message: "" })).toBe("Espera un momento");
    // Los rechazos de Click2Dial: los que hablan del teléfono, dichos para Kapta; el resto, los de la fase 1.
    expect(anuraPhoneErrorTitle({ code: "llamada_rechazada", message: "", start: { ok: false, error: "", code: "ocupada" } })).toBe(
      "Ya tienes una llamada abierta",
    );
    expect(anuraPhoneErrorTitle({ code: "llamada_rechazada", message: "", start: { ok: false, error: "", code: "terminal_no_registrada" } })).toBe(
      "Anura no ve conectado el teléfono de Kapta",
    );
    expect(anuraPhoneErrorTitle({ code: "llamada_rechazada", message: "", start: { ok: false, error: "", code: "token" } })).toBe(
      "El token de Anura no es válido",
    );
  });

  it("tras una clave rechazada (o un teléfono que ya no está) la ficha vuelve a pedir su panel", () => {
    expect(anuraPhoneNeedsPanelReload({ code: "registro", registration: "clave", message: "" })).toBe(true);
    expect(anuraPhoneNeedsPanelReload({ code: "registro", registration: "red", message: "" })).toBe(false);
    expect(anuraPhoneNeedsPanelReload({ code: "registro", registration: "dominio", message: "" })).toBe(true);
    expect(anuraPhoneNeedsPanelReload({ code: "credenciales", credentialsCode: "dominio_no_reconocido", message: "" })).toBe(true);
    expect(anuraPhoneNeedsPanelReload({ code: "credenciales", credentialsCode: "clave_rechazada", message: "" })).toBe(true);
    expect(anuraPhoneNeedsPanelReload({ code: "credenciales", credentialsCode: "sin_telefono", message: "" })).toBe(true);
    expect(anuraPhoneNeedsPanelReload({ code: "microfono_denegado", message: "" })).toBe(false);
    expect(anuraPhoneNeedsPanelReload(null)).toBe(false);
  });
});

describe("Ajustes: el teléfono de Kapta de cada anexo", () => {
  const base = { sipUser: "101-websocket", savedAt: "2026-11-06T15:00:00.000Z", rejectedAt: null, rejectedReason: null };
  const fmt = (iso: string | null) => (iso ? iso.slice(0, 10) : "—");

  it("la chapa y las líneas: clave guardada sí/no, fecha y rechazo; nunca la clave", () => {
    expect(anuraSipPhoneBadge({ status: "sin_telefono", hasPassword: false })).toEqual({ label: "Sin teléfono en Kapta", tone: "neutral" });
    expect(anuraSipPhoneBadge({ status: "listo", hasPassword: true })).toEqual({ label: "Teléfono en Kapta", tone: "ok" });
    expect(anuraSipPhoneBadge({ status: "clave_rechazada", hasPassword: true }).tone).toBe("crit");
    expect(anuraSipPhoneBadge({ status: "sin_dominio", hasPassword: true }).tone).toBe("warn");

    expect(anuraSipPhoneLines({ ...base, status: "sin_telefono", hasPassword: false, savedAt: null }, fmt)[0]).toMatch(/^Clave guardada: no/);
    expect(anuraSipPhoneLines({ ...base, status: "listo", hasPassword: true }, fmt)).toEqual(["Clave guardada: sí · 2026-11-06 · usuario 101-websocket"]);
    const rejected = anuraSipPhoneLines(
      { ...base, status: "clave_rechazada", hasPassword: true, rejectedAt: "2026-11-07T09:00:00.000Z", rejectedReason: "Anura rechazó el usuario o la clave del teléfono de Kapta (SIP 403)." },
      fmt,
    );
    expect(rejected[1]).toBe(
      "Anura la rechazó el 2026-11-07: Anura rechazó el usuario o la clave del teléfono de Kapta (SIP 403). Kapta no la vuelve a usar hasta que guardes otra.",
    );
  });

  it("dominio no reconocido (404): lleva a corregir el dominio, no a reescribir la clave", () => {
    expect(anuraSipPhoneBadge({ status: "dominio_no_reconocido", hasPassword: true })).toEqual({ label: "Revisa el dominio", tone: "crit" });
    const lines = anuraSipPhoneLines(
      {
        ...base,
        status: "dominio_no_reconocido",
        hasPassword: true,
        rejectedAt: "2026-11-07T09:00:00.000Z",
        rejectedReason: "Anura no reconoce el usuario SIP en el dominio de la central (SIP 404).",
      },
      fmt,
    );
    expect(lines[1]).toMatch(/^Anura no reconoció el usuario 101-websocket en el dominio de la central el 2026-11-07 \(SIP 404\)\. /);
    expect(lines[1]).toMatch(/Dominio SIP de la central/);
    expect(lines[1]).not.toMatch(/hasta que guardes otra/);
    expect(anuraDomainNotFoundBanner(2)).toMatch(/^Anura no reconoció 2 anexos con este dominio \(SIP 404\)/);
    // «Guardar central» ya no libera solo: hay que probar el dominio en un anexo.
    expect(anuraDomainNotFoundBanner(1)).toMatch(/pulsa «Guardar central» y pruébalo con «Probar y guardar» en un anexo/);
    expect(anuraDomainNotFoundBanner(1)).toMatch(/sin volver a escribir sus claves\.$/);
    // Todos marcados con el dominio anterior: el aviso pide probar el nuevo.
    expect(anuraDomainNotFoundBanner(2, 2)).toMatch(/^Se cambió el dominio de la central y quedan 2 anexos que Anura no reconocía con el anterior/);
    expect(anuraDomainNotFoundBanner(2, 1)).toMatch(/^Anura no reconoció 2 anexos con este dominio/);
    const waiting = anuraSipPhoneLines(
      {
        ...base,
        status: "dominio_no_reconocido",
        hasPassword: true,
        rejectedAt: "2026-11-07T09:00:00.000Z",
        rejectedReason: "Anura no reconoce el usuario SIP en el dominio de la central (SIP 404). Se cambió el dominio: falta probarlo.",
      },
      fmt,
    );
    expect(waiting[1]).toMatch(/^Anura no reconoció el usuario 101-websocket con el dominio anterior de la central el 2026-11-07 \(SIP 404\)\. Ya se guardó otro dominio: pruébalo con «Probar y guardar»/);
    expect(anuraPhoneModeOf({ status: "dominio_no_reconocido" })).toBe("bloqueado");
    expect(isAnuraPhoneBlocked("dominio_no_reconocido")).toBe(true);
    expect(isAnuraPhoneBlocked("listo")).toBe(false);
    expect(ANURA_PHONE_BLOCKED_TITLE.dominio_no_reconocido).toBe("Anura no reconoce el usuario o el dominio");
    // Ajustes: el aviso junto al dominio, y la contraseña no se borra con un 404.
    const card = read("components/anura-kapta-phone-settings.tsx");
    expect(card).toContain('e.phone.status === "dominio_no_reconocido"');
    expect(card).toContain("{anuraDomainNotFoundBanner(notFound, awaitingTest)}");
    expect(card).toContain('if (res.kind === "clave") setPassword("");');
    expect(read("components/anura-call.tsx")).toContain('if (way === "bloqueado" && kaptaPhone && isAnuraPhoneBlocked(kaptaPhone.status)) {');
  });

  it("«Probar y guardar» no deja repetir una combinación que Anura ya rechazó", () => {
    const built = anuraSipTestCredentials({ domain: "kenku-mal.anura.pe", wsUrl: "", port: "" }, "101", "", "Sup3r-clave");
    if (!built.ok) throw new Error(built.error);
    const key = anuraSipTestKey(built.creds);
    // La contraseña no queda en claro en la huella.
    expect(key).not.toContain("Sup3r-clave");
    // Lo mismo escrito otra vez (mayúsculas en el dominio incluidas) es la misma combinación.
    const again = anuraSipTestCredentials({ domain: "Kenku-Mal.anura.pe", wsUrl: "", port: "" }, "101", "101-websocket", "Sup3r-clave");
    expect(again.ok && anuraSipTestKey(again.creds)).toBe(key);
    // Cambiar el dominio, el usuario o la contraseña es otra combinación.
    for (const [domain, user, pass] of [
      ["kenku.anura.pe", "", "Sup3r-clave"],
      ["kenku-mal.anura.pe", "101-web", "Sup3r-clave"],
      ["kenku-mal.anura.pe", "", "Otra-clave"],
    ] as const) {
      const other = anuraSipTestCredentials({ domain, wsUrl: "", port: "" }, "101", user, pass);
      expect(other.ok && anuraSipTestKey(other.creds)).not.toBe(key);
    }
    // Otro anexo con lo mismo también es otra combinación.
    const otherExt = anuraSipTestCredentials({ domain: "kenku-mal.anura.pe", wsUrl: "", port: "" }, "102", "101-websocket", "Sup3r-clave");
    expect(otherExt.ok && anuraSipTestKey(otherExt.creds)).not.toBe(key);
    expect(ANURA_SIP_TEST_REPEAT_TEXT).toMatch(/^Anura ya rechazó este mismo dominio, usuario y contraseña\./);
    // La pantalla la recuerda con cualquier rechazo (clave o dominio), apaga el botón y lo explica.
    const card = read("components/anura-kapta-phone-settings.tsx");
    expect(card).toContain("if (isRegistrationRejection(res.kind)) rejectedTests.add(key);");
    expect(card).toContain("const repeated = Boolean(draft?.ok && rejectedTests.has(anuraSipTestKey(draft.creds)));");
    expect(card).toContain("disabled={pending || busy || !password || repeated}");
    expect(card).toContain("if (rejectedTests.has(key)) {");
    expect(card).toContain("{ANURA_SIP_TEST_REPEAT_TEXT}");
  });

  it("la central: dominio obligatorio; URL WebSocket y puerto por defecto de Perú; solo anura.pe", () => {
    expect(parseAnuraSipCentral({ domain: " sip:101-websocket@Kenku.Anura.PE:55090 ", wsUrl: "", port: "" })).toEqual({
      ok: true,
      domain: "kenku.anura.pe",
      wsUrl: "wss://sipwss.anura.pe",
      port: 55090,
    });
    expect(parseAnuraSipCentral({ domain: "", wsUrl: "", port: "" }).ok).toBe(false);
    expect(parseAnuraSipCentral({ domain: "kenku.anura.pe", wsUrl: "wss://sipwss.anura.dev", port: "" }).ok).toBe(false);
    expect(parseAnuraSipCentral({ domain: "kenku.anura.pe", wsUrl: "", port: "99999" }).ok).toBe(false);
  });

  it("«Probar y guardar» arma las credenciales con lo escrito (usuario por defecto <anexo>-websocket)", () => {
    const built = anuraSipTestCredentials({ domain: "kenku.anura.pe", wsUrl: "", port: "" }, "101", "  ", " secreta ");
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.sipUser).toBe("101-websocket");
    expect(built.creds).toMatchObject({ extension: "101", sipUser: "101-websocket", password: "secreta", domain: "kenku.anura.pe", wsUrl: "wss://sipwss.anura.pe", port: 55090 });
    expect(anuraSipTestCredentials({ domain: "kenku.anura.pe", wsUrl: "", port: "" }, "101", "101-websocket", "").ok).toBe(false);
    expect(anuraSipTestCredentials({ domain: "kenku.anura.pe", wsUrl: "", port: "" }, "101", "101 websocket", "x").ok).toBe(false);
    expect(anuraSipTestCredentials({ domain: "", wsUrl: "", port: "" }, "101", "", "x").ok).toBe(false);
  });

  it("UN solo intento de registro: si Anura rechaza, no hay segundo REGISTER y se dice por qué", async () => {
    const ua = new FakeUa();
    const pending = testAnuraRegistration({ createUa: async () => ua, timeoutMs: 8_000 }, CREDS);
    await new Promise((r) => setTimeout(r, 0));
    ua.emit("connected");
    ua.emit("registrationFailed", { cause: "Authentication Error", response: { status_code: 401 } });
    // Un WebSocket que se reconecta no vuelve a registrar.
    ua.emit("connected");
    const res = await pending;
    expect(res).toEqual({ ok: false, kind: "clave", message: ANURA_REGISTRATION_TEST_TEXT.clave });
    expect(ua.registers).toBe(1);
    expect(ua.stopped).toBe(1);
  });

  it("la llamada de prueba: teléfono de Kapta si el anexo tiene clave; «Mi anexo» lo intenta y si no, fase 1", () => {
    const exts = [
      { extension: "101", phone: { hasPassword: true } },
      { extension: "102", phone: { hasPassword: false } },
    ];
    expect(anuraTestCallWay("101", exts, false)).toBe("kapta");
    expect(anuraTestCallWay("102", exts, false)).toBe("fase1");
    expect(anuraTestCallWay("", exts, false)).toBe("kapta_o_fase1");
    expect(anuraTestCallWay("101", exts, true)).toBe("fase1");
    expect(anuraTestFallsBack({ code: "credenciales", credentialsCode: "sin_telefono", message: "" })).toBe(true);
    expect(anuraTestFallsBack({ code: "credenciales", credentialsCode: "sin_anexo", message: "" })).toBe(true);
    // Una clave rechazada o un anexo ajeno NO cae a la fase 1: sonaría una -websocket sin conectar.
    expect(anuraTestFallsBack({ code: "credenciales", credentialsCode: "clave_rechazada", message: "" })).toBe(false);
    expect(anuraTestFallsBack({ code: "credenciales", credentialsCode: "permiso", message: "" })).toBe(false);
    expect(anuraTestFallsBack({ code: "registro", registration: "clave", message: "" })).toBe(false);
  });
});

describe("la grabación por la ruta del mismo origen", () => {
  it("se vuelve a pedir con otra marca tras un error", () => {
    expect(anuraRecordingSrc("/api/anura/recordings/abc", 0)).toBe("/api/anura/recordings/abc");
    expect(anuraRecordingSrc("/api/anura/recordings/abc", 1)).toBe("/api/anura/recordings/abc?intento=1");
    expect(anuraRecordingSrc("/api/anura/recordings/abc?x=1", 2)).toBe("/api/anura/recordings/abc?x=1&intento=2");
  });
});

// ---------------------------------------------------------------------------
// El cableado
// ---------------------------------------------------------------------------

describe("el cableado de la ficha", () => {
  const button = read("components/anura-call.tsx");
  const hook = read("components/anura-phone.tsx");
  const drawer = read("components/order-drawer.tsx");

  it("la ficha pasa el estado del teléfono y recarga el panel si cambia", () => {
    expect(drawer).toContain("kaptaPhone={anura.panel.kaptaPhone}");
    expect(drawer).toContain("onPhoneChanged={() => void anura.reload()}");
    expect(button).toContain("const way = anuraPhoneModeOf(kaptaPhone);");
    expect(button).toContain('if (way === "kapta") {');
  });

  it("el teléfono usa las acciones de la ficha: credenciales, Click2Dial y clave rechazada", () => {
    expect(button).toContain("fetchCredentials: () => getAnuraPhone(orderId)");
    expect(button).toContain("requestCall: (input) => startAnuraCall(orderId, input?.reservationId ?? null)");
    expect(button).toContain("releaseReservation: (reservationId) => releaseAnuraReservation(reservationId)");
    expect(button).toContain("reportRejected: (input) => reportAnuraPhoneRejected(orderId, input)");
    // Lo que dice si la clienta contestó sigue llegando por el sondeo.
    expect(button).toContain("await getAnuraCallStatus(callId)");
    // Si Anura da la llamada por terminada, el teléfono cuelga y se desconecta;
    // no si solo la cerró el plazo del servidor con Kapta en la llamada. Desde
    // el 07-11-2026 lo hace el panel (AnuraPhoneProvider), con la ficha abierta o no.
    expect(button).toContain("const outlives = anuraPhoneOutlivesServer(snap, call);");
    expect(hook).toContain("const outlives = anuraPhoneOutlivesServer(snapshot, serverCall);");
    expect(hook).toContain("if (callId && !active && phoneBusy && !outlives) hangUp();");
    expect(button).not.toContain("hangUp();\n  }, [callId");
    // Una llamada retomada con teléfono en Kapta usa sus textos (no «cuelga en tu teléfono de Anura»).
    expect(button).toContain('setViaKapta(way !== "fase1");');
    expect(button).toContain("viaKapta ? anuraPhoneEndedLine(ended) : anuraEndedLine(ended)");
    // Colgar y Silenciar solo con el teléfono de Kapta, y solo si la llamada es de este pedido.
    expect(button).toContain("const kaptaBusy = owned !== null && phone.busy;");
    expect(button).toContain("{viaKapta && kaptaBusy && (");
    expect(button).toContain("phone.setMuted(!snap?.muted)");
    // El audio ya no está en la ficha: es UNO por pestaña, en el panel.
    expect(button).not.toContain("<AnuraPhoneAudio");
    expect(hook).toContain("<AnuraPhoneAudio audioRef={audioRef} />");
  });

  it("el teléfono del panel: JsSIP con import dinámico, micrófono, candado; suelta todo al cerrar la pestaña", () => {
    expect(hook.startsWith('"use client";')).toBe(true);
    expect(hook).toContain("createUa: createJsSipUa");
    expect(hook).toContain("getMicrophone: browserMicrophone");
    expect(hook).toContain("lock: browserAnuraTabLock()");
    // Lo que la pestaña recuerda (clave rechazada, espera) vive en el módulo, no en la ficha.
    expect(hook).toContain("memory: browserAnuraPhoneMemory()");
    expect(hook).toContain("makeStream: (tracks) => new MediaStream(");
    expect(hook).toContain('window.addEventListener("pagehide", onPageHide)');
    expect(hook).toContain("phoneRef.current?.dispose();");
    expect(hook).toContain('window.addEventListener("beforeunload", warn)');
    expect(hook).toContain("<audio ref={audioRef} autoPlay hidden />");
    expect(hook).toContain("el.srcObject =");
  });

  it("la grabación ya no habla de un enlace que vence", () => {
    expect(button).toContain("src={anuraRecordingSrc(url, attempt)}");
    expect(button).not.toContain("dura 5 minutos");
    expect(button).toContain('aria-label="Grabación de la llamada con Anura"');
  });
});

describe("el cableado de Ajustes", () => {
  const section = read("components/anura-settings-section.tsx");
  const card = read("components/anura-kapta-phone-settings.tsx");

  it("la sección explica que Kapta solo hace salidas e incluye la tarjeta del teléfono", () => {
    expect(section).toContain("<KaptaPhoneCard storeId={storeId} data={data} pending={pending} mutate={mutate}");
    expect(section).not.toContain("Kapta no guarda usuarios ni claves SIP");
    expect(section).toContain("solo hace salidas");
    expect(card).toContain("{ANURA_KAPTA_PHONE_OUTBOUND_ONLY}");
    expect(ANURA_KAPTA_PHONE_OUTBOUND_ONLY).toMatch(/NO suena en Kapta/);
    expect(card).toContain("{ANURA_SIP_PASSWORD_HELP}");
    expect(card).toContain("Falta aplicar la migración 0311");
  });

  it("«Probar y guardar»: primero UN registro en el navegador y solo si Anura acepta, guardar", () => {
    const test = card.indexOf("await testAnuraRegistration({ createUa: createJsSipUa }, built.creds)");
    const save = card.indexOf("await saveAnuraSipCredentials(storeId, ext.id, {");
    expect(test).toBeGreaterThan(0);
    expect(save).toBeGreaterThan(test);
    expect(card.slice(test, save)).toContain("if (!res.ok) {");
    // Candado entre pestañas también para la prueba; el campo se vacía tras cada intento.
    expect(card).toContain("await lock().acquire()");
    expect(card).toContain('if (res.kind === "clave") setPassword("");');
    expect(card).toContain('type="password"');
    expect(card).toContain('autoComplete="new-password"');
    expect(card).toContain("removeAnuraSipCredentials(storeId, ext.id)");
    expect(card).toContain("saveAnuraSipSettings(storeId, { domain: parsed.domain, wsUrl: parsed.wsUrl, port: parsed.port })");
  });

  it("la llamada de prueba usa el teléfono de Kapta con las acciones de Ajustes", () => {
    expect(section).toContain("fetchCredentials: () => getAnuraTestPhone(storeId, extension || null, phone)");
    expect(section).toContain("requestCall: (input) => startAnuraTestCall(storeId, phone, extension || null, input?.reservationId ?? null)");
    expect(section).toContain("releaseReservation: (reservationId) => releaseAnuraReservation(reservationId)");
    expect(section).toContain("reportRejected: (input) => reportAnuraTestPhoneRejected(storeId, input)");
    expect(section).toContain('if (way === "kapta_o_fase1" && anuraTestFallsBack(result.error)) {');
    // El teléfono y el audio son los del panel: Ajustes no monta otro.
    expect(section).toContain('const result = await kapta.call(server, { origin: "prueba", orderId: null, orderLabel: null, storeLabel: null });');
    expect(section).not.toContain("<AnuraPhoneAudio");
  });

  it("la clave SIP no se guarda en el navegador ni se escribe en la consola", () => {
    for (const f of ["components/anura-call.tsx", "components/anura-phone.tsx", "components/anura-kapta-phone-settings.tsx", "components/anura-settings-section.tsx", "lib/anura/phone-ui.ts"]) {
      const src = read(f);
      expect(src, f).not.toMatch(/localStorage|sessionStorage|indexedDB/);
      expect(src, f).not.toMatch(/console\.(log|info|warn|error|debug)/);
    }
  });
});
