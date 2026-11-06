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
  anuraPhoneCanMute,
  anuraPhoneErrorTitle,
  anuraPhoneHangUpLabel,
  anuraPhoneHint,
  anuraPhoneModeOf,
  anuraPhoneNeedsPanelReload,
  anuraPhoneStatusLabel,
  anuraRecordingSrc,
  anuraSipPhoneBadge,
  anuraSipPhoneLines,
  anuraSipTestCredentials,
  anuraTestCallWay,
  anuraTestFallsBack,
  parseAnuraSipCentral,
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
    expect(anuraPhoneHint(null, live("sonando"))).toMatch(/antes de recargar la ficha/);
    expect(anuraPhoneStatusLabel(null, null)).toBe("");
  });

  it("los segundos hablados salen de la hora del servidor", () => {
    expect(talkSecondsSince("2026-11-06T10:00:00.000Z", Date.parse("2026-11-06T10:02:13.400Z"))).toBe(133);
    expect(talkSecondsSince(null, Date.now())).toBe(0);
    expect(talkSecondsSince("no es fecha", Date.now())).toBe(0);
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
    expect(anuraPhoneErrorTitle({ code: "credenciales", credentialsCode: "base", message: "" })).toBe("No se pudo preparar el teléfono de Kapta");
    expect(anuraPhoneErrorTitle({ code: "anura_no_llamo", message: ANURA_PHONE_TEXT.anura_no_llamo })).toMatch(/no hizo sonar/);
    expect(anuraPhoneErrorTitle({ code: "audio", message: "" })).toBe("No se pudo conectar el audio");
    // Los rechazos de Click2Dial usan los títulos de la fase 1.
    expect(anuraPhoneErrorTitle({ code: "llamada_rechazada", message: "", start: { ok: false, error: "", code: "ocupada" } })).toBe(
      "Ya tienes una llamada en curso",
    );
  });

  it("tras una clave rechazada (o un teléfono que ya no está) la ficha vuelve a pedir su panel", () => {
    expect(anuraPhoneNeedsPanelReload({ code: "registro", registration: "clave", message: "" })).toBe(true);
    expect(anuraPhoneNeedsPanelReload({ code: "registro", registration: "red", message: "" })).toBe(false);
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
    expect(button).toContain("requestCall: () => startAnuraCall(orderId)");
    expect(button).toContain("reportRejected: (input) => reportAnuraPhoneRejected(orderId, input)");
    // Lo que dice si la clienta contestó sigue llegando por el sondeo.
    expect(button).toContain("await getAnuraCallStatus(callId)");
    // Si Anura da la llamada por terminada, el teléfono cuelga y se desconecta.
    expect(button).toContain("if (callId && !active && phoneBusy) hangUp();");
    // Colgar y Silenciar solo con el teléfono de Kapta.
    expect(button).toContain("{viaKapta && phone.busy && (");
    expect(button).toContain("phone.setMuted(!snap?.muted)");
    expect(button).toContain("<AnuraPhoneAudio audioRef={phone.audioRef} />");
  });

  it("el hook: JsSIP con import dinámico, micrófono, candado; suelta todo al cerrar", () => {
    expect(hook.startsWith('"use client";')).toBe(true);
    expect(hook).toContain("createUa: createJsSipUa");
    expect(hook).toContain("getMicrophone: browserMicrophone");
    expect(hook).toContain("lock: browserAnuraTabLock()");
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
    expect(section).toContain("fetchCredentials: () => getAnuraTestPhone(storeId, extension || null)");
    expect(section).toContain("requestCall: () => startAnuraTestCall(storeId, phone, extension || null)");
    expect(section).toContain("reportRejected: (input) => reportAnuraTestPhoneRejected(storeId, input)");
    expect(section).toContain('if (way === "kapta_o_fase1" && anuraTestFallsBack(result.error)) {');
    expect(section).toContain("<AnuraPhoneAudio audioRef={kapta.audioRef} />");
  });

  it("la clave SIP no se guarda en el navegador ni se escribe en la consola", () => {
    for (const f of ["components/anura-call.tsx", "components/anura-phone.tsx", "components/anura-kapta-phone-settings.tsx", "components/anura-settings-section.tsx", "lib/anura/phone-ui.ts"]) {
      const src = read(f);
      expect(src, f).not.toMatch(/localStorage|sessionStorage|indexedDB/);
      expect(src, f).not.toMatch(/console\.(log|info|warn|error|debug)/);
    }
  });
});
