// «Llamar con Anura», fase 2 en el MOM (docs/mom/master-pedidos-v1.md §8.7,
// «Fase 2: teléfono dentro de Kapta (solo salidas, 06-11-2026)»): la
// subsección va dentro de §8.7, cita los textos y los tiempos del código tal
// cual (lib/anura/sip.ts, lib/anura/sip-phone.ts), Kapta solo hace salidas
// (486 a todo aviso no pedido, nunca 603), la clave rechazada no se reintenta,
// la clave es del anexo y solo la recibe su dueña, una pestaña por
// navegador, la grabación va por el mismo origen y la CSP es la del código.
// Sin red: nada llama a Anura ni abre un WebSocket (el UA es un doble).

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  ANURA_DEFAULT_ICE_SERVERS,
  ANURA_DEFAULT_SIP_PORT,
  ANURA_DEFAULT_WS_URL,
  ANURA_KAPTA_PHONE_OUTBOUND_ONLY,
  ANURA_KAPTA_PHONE_TEXT,
  ANURA_SIP_PASSWORD_HELP,
  defaultSipUser,
  normalizeAnuraWsUrl,
} from "@/lib/anura/sip";
import {
  ANURA_ICE_MAX_WAIT_MS,
  ANURA_INVITE_WINDOW_MS,
  ANURA_KAPTA_START_TEXT,
  ANURA_PHONE_COOLDOWN_MS,
  ANURA_PHONE_REGISTER_TIMEOUT_MS,
  ANURA_PHONE_TEXT,
  ANURA_REGISTER_EXPIRES_S,
  ANURA_REGISTRATION_TEST_TEXT,
  ANURA_REGISTRATION_TEXT,
  anuraJsSipConfig,
  createAnuraPhone,
  iceReadyNow,
  registrationFailureKind,
  rejectionReason,
  shouldAnswerInvite,
  type AnuraPhoneCredentials,
  type SipUaLike,
} from "@/lib/anura/sip-phone";
import { ANURA_AFTER_PANEL_STEPS, ANURA_PANEL_STEPS } from "@/lib/anura/ui";
import { ANURA_PHONE_RESUMED_HINT, anuraPhoneEndedLine, anuraPhoneHangUpLabel, anuraPhoneHint, anuraPhoneStatusLabel } from "@/lib/anura/phone-ui";
import { ANURA_POLL_INTERVAL_MS, maskPhone } from "@/lib/anura/events";
import nextConfig from "../next.config";

vi.mock("server-only", () => ({}));

const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");
const MOM = read("docs/mom/master-pedidos-v1.md");
const flat = (text: string) => text.replace(/\s+/g, " ");
function raw(start: string, end: string): string {
  const from = MOM.indexOf(start);
  expect(from, start).toBeGreaterThanOrEqual(0);
  const to = MOM.indexOf(end, from + start.length);
  expect(to, end).toBeGreaterThan(from);
  return MOM.slice(from, to);
}

const HEAD = "#### Fase 2: teléfono dentro de Kapta (solo salidas, 06-11-2026)";
const S87_RAW = raw("### 8.7 Llamar con Anura (fase 1, 05-11-2026; fase 2, 06-11-2026)", "\n## 9. Lima");
const S87 = flat(S87_RAW);
const F2_RAW = raw(HEAD, "\n## 9. Lima");
const f2 = flat(F2_RAW);
const S15 = flat(raw("## 15. Responsables actuales", "## 16. "));
const S16 = flat(raw("## 16. Permisos de alto riesgo", "### 16.1 "));
const S21 = flat(raw("## 21. Pendientes posteriores", "## 22. "));

const CREDS: AnuraPhoneCredentials = {
  extension: "101",
  sipUser: "101-websocket",
  password: "clave-de-prueba",
  domain: "kenku.anura.pe",
  wsUrl: ANURA_DEFAULT_WS_URL,
  port: ANURA_DEFAULT_SIP_PORT,
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
  credentialVersion: "2026-11-06T15:00:00.000Z",
};

/** Un UA de JsSIP de mentira: cuenta registros y deja disparar eventos. */
function fakeUa() {
  const listeners = new Map<string, ((e: any) => void)[]>();
  const ua = {
    registers: 0,
    starts: 0,
    stops: 0,
    start() {
      ua.starts += 1;
    },
    stop() {
      ua.stops += 1;
    },
    register() {
      ua.registers += 1;
    },
    isRegistered: () => false,
    on(event: string, fn: (e: any) => void) {
      listeners.set(event, [...(listeners.get(event) ?? []), fn]);
      return ua;
    },
    emit(event: string, e: unknown = {}) {
      for (const fn of listeners.get(event) ?? []) fn(e);
    },
  };
  return ua;
}
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("dónde va la fase 2", () => {
  it("es una subsección de §8.7, después de la fase 1 y antes de §9", () => {
    expect(MOM.match(/^### 8\.7 /gm)).toHaveLength(1);
    expect(MOM.split(HEAD)).toHaveLength(2);
    const i87 = MOM.indexOf("### 8.7 Llamar con Anura");
    const iF1end = MOM.indexOf("- **Por confirmar en la prueba real del owner.**");
    const iF2 = MOM.indexOf(HEAD);
    const i9 = MOM.indexOf("\n## 9. Lima");
    expect(iF1end).toBeGreaterThan(i87);
    expect(iF2).toBeGreaterThan(iF1end);
    expect(i9).toBeGreaterThan(iF2);
    // La intro de §8.7 la anuncia.
    expect(S87).toContain("Desde la **fase 2** (06-11-2026, al final de esta sección) ese teléfono puede ser el propio navegador de la asesora en Kapta");
  });

  it("tiene sus apartados, con el estilo de §8.7", () => {
    for (const head of [
      "**Qué ve la asesora.**",
      "**Cuándo se conecta: solo al llamar.**",
      "**No suena para entrantes.**",
      "**Colgar y Silenciar.**",
      "**Una sola pestaña.**",
      "**La clave SIP.**",
      "**Quién la recibe.**",
      "**Probar y guardar.**",
      "**Clave rechazada: no se reintenta.**",
      "**Grabaciones por el mismo origen.**",
      "**CSP.**",
      "**Audio e ICE.**",
      "**Por confirmar en la prueba real.**",
    ]) {
      expect(f2, head).toContain(head);
    }
  });

  it("cita el pedido del owner y se monta sobre la fase 1", () => {
    expect(f2).toContain(
      "«construye el teléfono dentro de Kapta. no quiero nada en mi celular ni computadora, todo en kapta. y el telefono es solo para salidas de llamadas, no quiero que kapta esté sonando que recibe llamadas por ahora o solo se lo canalizas a un usuario»",
    );
    expect(f2).toContain("La fase 2 se monta **sobre la fase 1**: Click2Dial, los avisos, la tabla de estados, el historial y las grabaciones siguen igual.");
    expect(f2).toContain("JsSIP 3.13.8 sobre `wss://sipwss.anura.pe`");
    expect(f2).toContain("Migración 0311.");
    const pkg = JSON.parse(read("package.json")) as { dependencies?: Record<string, string> };
    expect(pkg.dependencies?.jssip).toBe("3.13.8");
    expect(read("db/migrations/0311_anura_kapta_phone.sql")).toContain("anura_sip_credentials");
  });
});

describe("qué ve la asesora: el modo lo decide el teléfono de Kapta del anexo", () => {
  it("la tabla de estados cita los textos del código", () => {
    expect(F2_RAW).toContain("| `listo` | el anexo tiene su clave guardada y no rechazada, y la central tiene dominio | Llama con el teléfono dentro de Kapta |");
    // Con `sin_telefono` la ficha no dice nada: el texto solo sale al pedir la clave.
    expect(F2_RAW).toContain(
      `| \`sin_telefono\` | el anexo no tiene clave guardada | Fase 1 sin cambios, sin ningún aviso. «${ANURA_KAPTA_PHONE_TEXT.sin_telefono}» solo sale si el anexo perdió su clave entre abrir la ficha y llamar, o en la llamada de prueba |`,
    );
    expect(F2_RAW).toContain(`| \`clave_rechazada\` | Anura rechazó la clave guardada | No llama: «${ANURA_KAPTA_PHONE_TEXT.clave_rechazada}» |`);
    expect(F2_RAW).toContain(`| \`sin_dominio\` | hay clave pero falta el dominio SIP de la central | No llama: «${ANURA_KAPTA_PHONE_TEXT.sin_dominio}» |`);
  });

  it("los estados son los de kaptaPhoneStatus", async () => {
    const { kaptaPhoneStatus } = await import("@/lib/anura/sip-store");
    const ext = { id: "e1", extension: "101" };
    const meta = { extensionId: "e1", extension: "101", sipUser: "101-websocket", savedAt: "t", rejectedAt: null, rejectedReason: null };
    expect(kaptaPhoneStatus(ext, null, { domain: "kenku.anura.pe" })).toBe("sin_telefono");
    expect(kaptaPhoneStatus(ext, meta, { domain: "kenku.anura.pe" })).toBe("listo");
    expect(kaptaPhoneStatus(ext, meta, { domain: null })).toBe("sin_dominio");
    expect(kaptaPhoneStatus(ext, { ...meta, rejectedAt: "t", rejectedReason: "x" }, { domain: "kenku.anura.pe" })).toBe("clave_rechazada");
    // Una clave guardada para otro número de anexo no vale.
    expect(kaptaPhoneStatus({ id: "e1", extension: "102" }, meta, { domain: "kenku.anura.pe" })).toBe("sin_telefono");
  });

  it("la tarjeta: textos del teléfono, número enmascarado y el sondeo de la fase 1", () => {
    expect(f2).toContain(`«${ANURA_PHONE_TEXT.conectando}», «${ANURA_PHONE_TEXT.esperando_anura}», «${ANURA_PHONE_TEXT.llamando(maskPhone("987654321"))}»`);
    expect(f2).toContain("**Colgar** y **Silenciar**");
    expect(ANURA_POLL_INTERVAL_MS).toBe(2_500);
    expect(f2).toContain("con el mismo sondeo de 2,5 segundos");
    // El número entero puede llegar en la señalización SIP; no se muestra ni se registra.
    expect(f2).toContain("Kapta no manda el número al navegador, pero el número entero puede llegar en la señalización SIP de Anura (el aviso de Click2Dial); Kapta no lo muestra, no lo guarda y no lo escribe en la consola (el registro de JsSIP queda apagado).");
    expect(f2).not.toContain("sigue sin pasar por el navegador");
    expect(read("lib/anura/jssip-client.ts")).toContain("JsSIP.debug.disable();");
    // Quién cortó.
    expect(f2).toContain("dice «Colgaste» si colgó la asesora y «Llamada terminada» si cortó Anura");
    expect(anuraPhoneStatusLabel({ phase: "terminada", toMasked: null, endedBy: "kapta" }, null)).toBe("Colgaste");
    expect(anuraPhoneStatusLabel({ phase: "terminada", toMasked: null, endedBy: "anura" }, null)).toBe("Llamada terminada");
  });
});

describe("solo salidas: se conecta al llamar y no suena para entrantes", () => {
  it("el orden y los tiempos son los del código", () => {
    expect(ANURA_PHONE_REGISTER_TIMEOUT_MS).toBe(8_000);
    expect(ANURA_INVITE_WINDOW_MS).toBe(45_000);
    expect(ANURA_REGISTER_EXPIRES_S).toBe(60);
    expect(f2).toContain("Kapta no queda conectada a Anura esperando llamadas.");
    const order = [
      "1. el candado entre pestañas (abajo);",
      "2. la clave, que el servidor entrega en ese momento;",
      `3. el micrófono: si la asesora lo niega, «${ANURA_PHONE_TEXT.microfono_denegado}» y **no se pide la llamada**;`,
      "4. el registro en Anura, 8 segundos como mucho;",
      "5. el pedido de llamada de la fase 1 (Click2Dial);",
      "6. Anura hace sonar la terminal principal —este navegador— y Kapta contesta sola ese aviso, sin timbre;",
    ];
    let at = -1;
    for (const line of order) {
      const found = f2.indexOf(line);
      expect(found, line).toBeGreaterThan(at);
      at = found;
    }
    expect(f2).toContain(`Si Anura no hace sonar el teléfono de Kapta en 45 segundos, también: «${ANURA_PHONE_TEXT.anura_no_llamo}».`);
    expect(f2).toContain("El registro dura 60 segundos: si la pestaña se cierra de golpe sin desregistrar, vence solo.");
    expect(f2).toContain("Salir de la ficha o cerrar la pestaña (`pagehide`) cuelga y suelta todo.");
    // El UA no se registra solo: Kapta lo pide al conectar.
    expect(anuraJsSipConfig(CREDS, {})).toMatchObject({ register: false, register_expires: 60 });
  });

  it("si niega el micrófono, no se registra ni se pide la llamada", async () => {
    const ua = fakeUa();
    const requestCall = vi.fn();
    const phone = createAnuraPhone({
      createUa: () => ua as unknown as SipUaLike,
      getMicrophone: () => Promise.reject(Object.assign(new Error("no"), { name: "NotAllowedError" })),
      lock: { acquire: async () => ({ release() {} }) },
      fetchCredentials: async () => ({ ok: true, phone: CREDS }),
      requestCall,
      reportRejected: vi.fn(async () => undefined),
      onChange: () => {},
      onRemoteStream: () => {},
    });
    const snap = await phone.call();
    expect(snap.error).toMatchObject({ code: "microfono_denegado", message: ANURA_PHONE_TEXT.microfono_denegado });
    expect(ua.starts).toBe(0);
    expect(requestCall).not.toHaveBeenCalled();
  });

  it("todo aviso no pedido se rechaza con 486, nunca 603", () => {
    expect(f2).toContain("se rechaza con **486** («ocupado»), sin timbre, sin aviso y sin notificación. Nunca con 603: un 6xx corta todas las ramas de la llamada en Anura");
    const now = 1_000_000;
    expect(shouldAnswerInvite({ pending: { sinceMs: now - 1_000, answered: false }, nowMs: now, inCall: false })).toEqual({ answer: true });
    const cases = [
      { pending: null, nowMs: now, inCall: false },
      { pending: { sinceMs: now - ANURA_INVITE_WINDOW_MS - 1, answered: false }, nowMs: now, inCall: false },
      { pending: { sinceMs: now - 1_000, answered: true }, nowMs: now, inCall: false },
      { pending: { sinceMs: now - 1_000, answered: false }, nowMs: now, inCall: true },
    ];
    for (const c of cases) {
      const d = shouldAnswerInvite(c);
      expect(d.answer).toBe(false);
      if (!d.answer) expect(d.statusCode).toBe(486);
    }
    expect(read("lib/anura/sip-phone.ts")).not.toMatch(/status_code:\s*6\d\d/);
  });

  it("las entrantes: lo que dice Ajustes y lo que hace el dueño en Anura", () => {
    expect(f2).toContain(`Lo que dice Ajustes: «${ANURA_KAPTA_PHONE_OUTBOUND_ONLY}».`);
    expect(f2).toContain("una entrante que deba llegar a alguien se canaliza en Anura (abajo)");
    expect(f2).toContain("Las entrantes siguen el flujo de Anura (preatendedor, buzón) y el aviso de Anura las sigue guardando como en la fase 1.");
    expect(S21).toContain("entrantes en Kapta (hoy solo salidas; una entrante se reparte en Anura, «Flujo de llamada»)");
  });

  it("el aviso que llega antes de la confirmación espera; lo que falta confirmar", () => {
    expect(f2).toContain(
      "Si el aviso llega antes de que el servidor confirme que Anura aceptó el Click2Dial, queda en espera sin contestar: se contesta si Anura lo aceptó y se rechaza si no.",
    );
    expect(f2).toContain("Kapta no sabe, por lo que trae el aviso, si es el de su Click2Dial.");
    expect(f2).toContain("Por confirmar en la prueba real qué trae el aviso de Click2Dial para atarlo a la llamada pedida.");
    expect(f2).not.toContain("Kapta contesta **solo** el aviso de la llamada que esa pestaña acaba de pedir");
  });

  it("los fallos de Click2Dial y la llamada retomada, dichos para el teléfono de Kapta", () => {
    for (const code of ["terminal_no_registrada", "sin_terminal", "ocupada"] as const) {
      expect(f2, code).toContain(`«${ANURA_KAPTA_START_TEXT[code]}»`);
    }
    const line = anuraPhoneEndedLine({ status: "fallida", billSeconds: null, failureReason: "x", closedByTimeout: true });
    expect(f2).toContain(`dice «${line}».`);
    expect(f2).toContain(`«${ANURA_PHONE_RESUMED_HINT}».`);
  });

  it("el plazo del servidor no corta el audio de una llamada en la que Kapta ya está", () => {
    const hint = anuraPhoneHint({ phase: "en_llamada" }, { status: "fallida", active: false, closedByTimeout: true });
    expect(f2).toContain(`ese cierre por plazo **no corta el audio**: la tarjeta dice «${hint}»`);
    expect(read("components/anura-call.tsx")).toContain("if (callId && !active && phoneBusy && !outlives) hangUp();");
  });

  it("Kapta sí cuelga; si Anura ya aceptó, la fila sigue la fase 1", () => {
    expect(f2).toContain("Ahora Kapta sí cuelga: «Colgar» termina la llamada y desregistra; antes de que haya llamada, cancela y desregistra.");
    expect(f2).toContain(`Mientras conecta, el botón dice «${anuraPhoneHangUpLabel({ phase: "conectando" })}»; con Kapta en la llamada, «${anuraPhoneHangUpLabel({ phase: "en_llamada" })}».`);
    expect(f2).toContain("si Anura no avisa nada, se cierra sola al minuto.");
  });
});

describe("una sola pestaña por navegador", () => {
  it("navigator.locks con respaldo en BroadcastChannel, y su mensaje", () => {
    expect(f2).toContain("Kapta usa `navigator.locks` y, si el navegador no lo tiene, BroadcastChannel.");
    expect(f2).toContain(`La segunda pestaña dice «${ANURA_PHONE_TEXT.otra_pestana}».`);
    expect(f2).toContain("Dos navegadores de la misma persona no se ven entre sí");
  });

  it("sin candado no se piden credenciales", async () => {
    const fetchCredentials = vi.fn();
    const phone = createAnuraPhone({
      createUa: () => fakeUa() as unknown as SipUaLike,
      getMicrophone: vi.fn(),
      lock: { acquire: async () => null },
      fetchCredentials,
      requestCall: vi.fn(),
      reportRejected: vi.fn(async () => undefined),
      onChange: () => {},
      onRemoteStream: () => {},
    });
    const snap = await phone.call();
    expect(snap.error?.code).toBe("otra_pestana");
    expect(fetchCredentials).not.toHaveBeenCalled();
  });
});

describe("la clave SIP es del anexo y solo la recibe su dueña", () => {
  it("central por org (no secreta) y clave por anexo, cifrada y solo del servidor", () => {
    expect(ANURA_DEFAULT_WS_URL).toBe("wss://sipwss.anura.pe");
    expect(ANURA_DEFAULT_SIP_PORT).toBe(55090);
    expect(defaultSipUser("101")).toBe("101-websocket");
    expect(f2).toContain("la URL WebSocket, por defecto `wss://sipwss.anura.pe`; y el puerto SIP, por defecto 55090.");
    expect(f2).toContain("Solo se aceptan `wss://` a hosts de anura.pe y sin puerto: anura.dev es Argentina y no sirve.");
    expect(f2).toContain("Tiene que ser un subdominio (`sipwss.anura.pe`): el dominio raíz `anura.pe` no lo cubre la CSP.");
    expect(normalizeAnuraWsUrl("wss://anura.pe")).toBeNull();
    expect(normalizeAnuraWsUrl("wss://sipwss.anura.dev")).toBeNull();
    expect(normalizeAnuraWsUrl("wss://sipwss.anura.pe:8443")).toBeNull();
    expect(normalizeAnuraWsUrl("")).toBe(ANURA_DEFAULT_WS_URL);
    expect(f2).toContain("el usuario SIP, por defecto `<anexo>-websocket`, y la contraseña SIP **cifrada**");
    expect(f2).toContain("No va en `anura_extensions` porque esa tabla la leen los miembros de la organización.");

    const sql = read("db/migrations/0311_anura_kapta_phone.sql");
    expect(sql).toContain("password_cipher");
    expect(sql).toContain("on delete cascade");
    expect(sql).not.toMatch(/grant[^;]*on\s+(table\s+)?public\.anura_sip_credentials[^;]*to\s+authenticated/i);
    expect(read("lib/anura/sip-store.ts")).toContain('import { decrypt, encrypt } from "@/lib/crypto";');
  });

  it("quitar el anexo o cambiarle el número borra la clave; apagarlo no", () => {
    expect(f2).toContain("Quitar el anexo o cambiarle el número borra su clave; apagarlo no.");
    const sql = read("db/migrations/0311_anura_kapta_phone.sql");
    expect(sql).toContain("references public.anura_extensions(id) on delete cascade");
    expect(sql).toContain("after update of extension on public.anura_extensions");
  });

  it("quién la recibe: las condiciones del servidor", () => {
    expect(f2).toContain(
      "Solo la dueña del anexo, al llamar, por una acción del servidor que nunca la escribe en un log: con `master.edit` en la organización del pedido (no basta tenerlo en otra organización), el pedido visible para ella y con celular peruano, Anura encendido para la organización (token y `ANURA_ORG_ID`), su anexo activo, la clave guardada y no rechazada, y el dominio configurado.",
    );
    expect(f2).toContain("nunca en `localStorage` ni `sessionStorage`");
    expect(f2).toContain("Ajustes solo muestra «clave guardada: sí/no», la fecha y, si la hay, la fecha y el motivo del rechazo.");
    const server = read("lib/anura/server.ts");
    expect(server).toContain('if (!perms.can("master.edit")) return { ok: false, code: "permiso"');
    expect(server).toContain('if (!(await hasOrgPermission(target.orgId, "master.edit"))) return { ok: false, code: "permiso"');
    expect(server).toContain("if (!anuraPeruCalled(target.phone))");
    expect(server).toContain('if (!anuraConfigured(orgId)) return { ok: false, code: "no_configurado"');
    expect(read("lib/anura/sip-phone.ts")).not.toMatch(/localStorage|sessionStorage/);
  });

  it("la prueba de Ajustes con el anexo de otra persona no entrega la clave", () => {
    const m = /export const ANURA_PHONE_NOT_OWNER =\s*"([^"]+)";/.exec(read("lib/anura/server.ts"));
    expect(m).not.toBeNull();
    expect(f2).toContain(`Con el anexo de otra persona Kapta no entrega la clave («${m![1]}»).`);
  });
});

describe("Probar y guardar, y clave rechazada sin reintento", () => {
  it("los textos de Ajustes son los del código", () => {
    expect(f2).toContain(`se explica: «${ANURA_REGISTRATION_TEST_TEXT.clave}».`);
    expect(f2).toContain(`La ayuda junto al campo: «${ANURA_SIP_PASSWORD_HELP}».`);
    expect(f2).toContain("«Probar y guardar» hace que **su** navegador intente **un** registro con eso: solo si Anura lo acepta, el servidor guarda la clave cifrada.");
    expect(f2).toContain("El servidor no puede comprobar que la prueba del navegador salió bien: confía en quien administra");
  });

  it("401, 403 y 407 (o la causa de JsSIP) son clave rechazada; 404 es dominio; red y tiempo no", () => {
    expect(f2).toContain("(SIP 401, 403 o 407, o la causa de JsSIP «Authentication Error» o «Rejected»)");
    for (const status of [401, 403, 407]) expect(registrationFailureKind({ response: { status_code: status } }), String(status)).toBe("clave");
    for (const cause of ["Authentication Error", "Rejected"]) expect(registrationFailureKind({ cause }), cause).toBe("clave");
    expect(f2).toContain("Un 404 al registrar (o 604, o la causa de JsSIP «Not Found») no dice que la clave esté mal");
    for (const status of [404, 604]) expect(registrationFailureKind({ response: { status_code: status } }), String(status)).toBe("dominio");
    expect(registrationFailureKind({ cause: "Not Found" })).toBe("dominio");
    // La regla vieja («un 404 cuenta como clave rechazada») ya no está.
    expect(f2).not.toContain("Un 404 cuenta como clave rechazada");
    expect(registrationFailureKind({ cause: "Connection Error" })).toBe("red");
    expect(registrationFailureKind({ cause: "Request Timeout" })).toBe("tiempo");
    expect(f2).toContain("Un fallo de red o de tiempo no marca nada: la asesora puede volver a intentar.");
    // Pero sin reintentos seguidos: un minuto de espera.
    expect(ANURA_PHONE_COOLDOWN_MS).toBe(60_000);
    expect(f2).toContain(`la pestaña espera un minuto antes de dejar intentar otra vez: «${ANURA_PHONE_TEXT.espera}».`);
    // Y la pestaña recuerda la versión rechazada aunque el servidor no la marque.
    expect(f2).toContain("si el servidor no llegó a marcarla, el siguiente «Llamar con Anura» no vuelve a registrar con ella");
    expect(f2).toContain("Kapta apaga el registro automático de JsSIP, que si no mandaría otro REGISTER en cada reconexión.");
  });

  it("el motivo y el mensaje de la ficha son los del código", () => {
    expect(f2).toContain(`(«${rejectionReason("clave", 401)}»)`);
    expect(ANURA_REGISTRATION_TEXT.clave).toBe(ANURA_KAPTA_PHONE_TEXT.clave_rechazada);
    expect(f2).toContain(`mientras esté marcada, Kapta no la entrega y la ficha dice «${ANURA_REGISTRATION_TEXT.clave}». Guardar otra clave limpia la marca.`);
    expect(f2).toContain("solo en el anexo propio de quien llamaba y solo en la versión de la clave que se le entregó");
    const store = read("lib/anura/sip-store.ts");
    expect(store).toContain('.eq("saved_at", input.credentialVersion)');
    expect(store).toContain('.is("rejected_at", null)');
  });

  it("cerrada por plazo con Kapta en la llamada: «En llamada» y el reloj desde que el teléfono contestó", async () => {
    const { anuraTalkClock } = await import("@/lib/anura/phone-ui");
    expect(f2).toContain(
      "La tarjeta (en la ficha y en la llamada de prueba de Ajustes) sigue diciendo «En llamada» y muestra el reloj, contado desde que el teléfono de Kapta contestó, porque el servidor no sabe cuándo empezó.",
    );
    const closed = { status: "fallida" as const, active: false, answeredAt: null, closedByTimeout: true, statusLabel: "No se pudo llamar" };
    expect(anuraPhoneStatusLabel({ phase: "en_llamada", toMasked: null }, closed)).toBe("En llamada");
    expect(anuraTalkClock({ phase: "en_llamada", answeredAt: 1_000 }, closed, true)).toEqual({ running: true, fromMs: 1_000 });
  });

  it("dominio no reconocido: el MOM cita los textos y las reglas del código", async () => {
    const { ANURA_SIP_NOT_FOUND_REASON } = await import("@/lib/anura/sip");
    const { anuraDomainNotFoundBanner, anuraSipPhoneBadge, ANURA_PHONE_BLOCKED_TITLE, ANURA_SIP_TEST_REPEAT_TEXT } = await import("@/lib/anura/phone-ui");
    const { ANURA_SIP_NOT_FOUND_RETEST } = await import("@/lib/anura/sip");
    expect(F2_RAW).toContain(
      `| \`dominio_no_reconocido\` | Anura no reconoce el usuario en el dominio de la central (SIP 404) | No llama: «${ANURA_KAPTA_PHONE_TEXT.dominio_no_reconocido}» |`,
    );
    expect(ANURA_REGISTRATION_TEXT.dominio).toBe(ANURA_KAPTA_PHONE_TEXT.dominio_no_reconocido);
    expect(f2).toContain(`la ficha dice «${ANURA_KAPTA_PHONE_TEXT.dominio_no_reconocido}»`);
    expect(f2).toContain(`se explica: «${ANURA_REGISTRATION_TEST_TEXT.dominio}».`);
    expect(f2).toContain(`el motivo empieza por «${ANURA_SIP_NOT_FOUND_REASON}»`);
    expect(f2).toContain(`por ejemplo «${rejectionReason("dominio", 404)}»`);
    expect(f2).toContain(`un aviso: «${anuraDomainNotFoundBanner(1)}»`);
    expect(f2).toContain(`la chapa del anexo dice «${anuraSipPhoneBadge({ status: "dominio_no_reconocido", hasPassword: true }).label}»`);
    expect(ANURA_PHONE_BLOCKED_TITLE.dominio_no_reconocido).toMatch(/dominio/);
    expect(f2).toContain(`Ajustes avisa «${anuraDomainNotFoundBanner(1, 1)}»`);
    expect(f2).toContain("**guardar un dominio distinto con «Guardar central» no libera a nadie todavía**");
    expect(f2).toContain(`al motivo se le agrega «${ANURA_SIP_NOT_FOUND_RETEST.trim()}»`);
    expect(f2).toContain("Guardar el mismo dominio no cambia nada, y si Kapta no pudo leer el dominio anterior tampoco toca las marcas;");
    expect(f2).toContain("**cuando Anura acepta un «Probar y guardar»**");
    expect(f2).toContain("si la prueba misma cambió el dominio, todas; si el dominio ya estaba guardado, solo las que esperaban la prueba.");
    expect(f2).toContain("Una «clave rechazada» (401/403/407) nunca se quita por el dominio;");
    expect(f2).toContain("la pestaña recuerda en memoria el 404 de esa clave **con ese dominio**");
    expect(f2).toContain(`el botón queda apagado y dice «${ANURA_SIP_TEST_REPEAT_TEXT}»`);
    const server = read("lib/anura/server.ts");
    expect(server).toContain("if (settings.domain && settings.domain !== triedDomain) return { ok: true, marked: false };");
    expect(server).toContain("!before.failed && before.settings.domain !== parsed.domain ? await markNotFoundAwaitingTest(admin, target.orgId) : 0");
    expect(server).toContain("await clearNotFoundRejections(admin, target.orgId, { onlyAwaitingTest: !domainChanged })");
  });

  it("ante el primer rechazo el teléfono se detiene, avisa una vez y no reintenta", async () => {
    const ua = fakeUa();
    const reportRejected = vi.fn(async () => undefined);
    const requestCall = vi.fn();
    const phone = createAnuraPhone({
      createUa: () => ua as unknown as SipUaLike,
      getMicrophone: async () => ({ getTracks: () => [] }) as any,
      lock: { acquire: async () => ({ release() {} }) },
      fetchCredentials: async () => ({ ok: true, phone: CREDS }),
      requestCall,
      reportRejected,
      onChange: () => {},
      onRemoteStream: () => {},
      setTimeout: () => 0,
      clearTimeout: () => {},
    });
    const done = phone.call();
    for (let i = 0; i < 5 && ua.starts === 0; i++) await tick();
    ua.emit("connected");
    expect(ua.registers).toBe(1);
    ua.emit("registrationFailed", { cause: "Authentication Error", response: { status_code: 401 } });
    const snap = await done;
    expect(snap.error).toMatchObject({ code: "registro", registration: "clave", message: ANURA_REGISTRATION_TEXT.clave });
    expect(reportRejected).toHaveBeenCalledTimes(1);
    expect(reportRejected).toHaveBeenCalledWith({ credentialVersion: CREDS.credentialVersion, kind: "clave", status: 401 });
    expect(ua.stops).toBe(1);
    // El WebSocket se reconecta: no se vuelve a registrar ni a pedir llamada.
    ua.emit("connected");
    ua.emit("registrationFailed", { cause: "Authentication Error", response: { status_code: 401 } });
    expect(ua.registers).toBe(1);
    expect(reportRejected).toHaveBeenCalledTimes(1);
    expect(requestCall).not.toHaveBeenCalled();
    expect(f2).toContain("el teléfono se detiene y no reintenta, aunque el WebSocket se reconecte;");
  });
});

describe("grabación, CSP e ICE", () => {
  it("la grabación por el mismo origen, con Range", () => {
    expect(f2).toContain("La ficha oye la grabación por `/api/anura/recordings/<id>`, con `Range` para que el reproductor pueda adelantar");
    expect(f2).toContain("—quien hizo la llamada o quien ve la tienda del pedido, como el historial—");
    expect(f2).toContain("La regla es siempre la de la tienda (RLS): quien hizo la llamada y ya no ve esa tienda no la oye. El navegador no guarda el audio (`no-store`).");
    expect(f2).toContain("Se eligió la ruta en vez de abrir `media-src` a Supabase para que el enlace firmado no llegue al navegador.");
    const route = read("app/api/anura/recordings/[callId]/route.ts");
    expect(route).toContain('req.headers.get("range")');
    expect(route).toContain("anuraRecordingAccessFor(callId)");
  });

  it("la CSP del MOM es la de next.config.ts", async () => {
    const headers = await nextConfig.headers!();
    const csp = headers.flatMap((h) => h.headers).find((h) => h.key === "Content-Security-Policy")!.value;
    const directive = (name: string) => csp.split(";").map((d) => d.trim()).find((d) => d.startsWith(`${name} `)) ?? "";
    const connect = directive("connect-src").split(/\s+/);
    expect(connect).toContain("wss://sipwss.anura.pe");
    expect(connect).toContain("wss://*.anura.pe");
    expect(directive("media-src")).toBe("media-src 'self'");
    expect(f2).toContain("`connect-src` agrega `wss://sipwss.anura.pe` y `wss://*.anura.pe`");
    expect(f2).toContain("`media-src 'self'` queda explícito; se comporta como antes.");
    expect(f2).toContain("no tenía `media-src`, caía en `default-src 'self'`");
  });

  it("ICE: STUN público y no esperar toda la recolección", () => {
    expect(ANURA_DEFAULT_ICE_SERVERS).toEqual([{ urls: "stun:stun.l.google.com:19302" }]);
    expect(ANURA_ICE_MAX_WAIT_MS).toBe(1_500);
    expect(iceReadyNow({ type: "srflx" })).toBe(true);
    expect(iceReadyNow({ type: "relay" })).toBe(true);
    expect(iceReadyNow({ type: "host" })).toBe(false);
    expect(f2).toContain("STUN público (`stun:stun.l.google.com:19302`); no hay TURN propio");
    expect(f2).toContain(`(«${ANURA_PHONE_TEXT.audio}»)`);
    expect(f2).toContain("Kapta contesta en cuanto hay un candidato público (srflx o relay) y, si no llega, 1,5 segundos después del primero.");
  });

  it("el registro va al puerto 55090 del dominio (por confirmar con Anura)", () => {
    const cfg = anuraJsSipConfig(CREDS, {});
    expect(cfg.registrar_server).toBe("sip:kenku.anura.pe:55090");
    expect(cfg.uri).toBe("sip:101-websocket@kenku.anura.pe");
    expect(f2).toContain("El registro va a `sip:<dominio>:55090` con la dirección `sip:<usuario>@<dominio>`; no se pudo probar contra Anura.");
  });
});

describe("los pasos del panel y los permisos, con la fase 2", () => {
  it("los pasos ya no piden instalar la app: la -websocket es la principal", () => {
    const text = ANURA_PANEL_STEPS.map((p) => `${p.title} ${p.text}`).join(" ");
    expect(text).toContain("encender el interruptor de la terminal `<anexo>-websocket`");
    expect(text).toContain("con eso ya no se instala la app ni un softphone de Anura.");
    // El aviso del MOM también lo muestra Ajustes: sin clave en Kapta, la principal no es la -websocket.
    expect(text).toContain(
      "Hazlo cuando guardes la clave de ese anexo en Kapta: mientras un anexo no tenga clave guardada en Kapta, su principal tiene que ser un teléfono que la asesora contesta (la app de Anura o un teléfono físico), porque la -websocket sin Kapta conectada no suena y Click2Dial falla.",
    );
    expect(text).toContain("«Obtener credenciales»");
    expect(text).toContain("el dominio de la central");
    expect(text).toContain("Avanzado → «Click 2 Dial»");
    expect(text).toContain("Auto answer apagado.");
    // Sin nombres de opciones de Anura que no estén documentados (Rentabilify: «lo decide el dueño de la cuenta o Anura»).
    expect(text).toContain("celulares permitidos. Si no, las llamadas a celular terminan en CONGESTION («destino restringido»). Qué opción de Límites lo permite lo decide el dueño de la cuenta o Anura.");
    expect(text).not.toContain("Internacional restringido");
    expect(text).not.toContain("hay audio");
    expect(text).toContain("Petición, `POST`");
    expect(text).toContain("Encabezados, tipo JSON y sin autenticación; Cuerpo, la plantilla que da Kapta.");
    expect(text).toContain("«Se inicia una llamada» (`START`), «La llamada es atendida» (`TALK`) y «Se finaliza una llamada» (`END`)");
    expect(text).toContain("dirección «Entrante/Saliente»");
    expect(text).not.toContain("Ambas");
    expect(ANURA_AFTER_PANEL_STEPS).toContain("el dominio SIP de la central");
    expect(ANURA_AFTER_PANEL_STEPS).toContain("(«Probar y guardar»)");
    // Sin clave en Kapta, la principal tiene que ser un teléfono que se contesta.
    expect(S87).toContain("Mientras un anexo no tenga clave guardada en Kapta, la ficha sigue la fase 1 para esa persona");
  });

  it("sin permiso nuevo; responsables y permisos lo dicen", () => {
    expect(S87).toContain("En la fase 2 tampoco: el dominio SIP, «Probar y guardar» y «Quitar clave» piden `stores.manage`");
    expect(S16).toContain("Fase 2 (06-11-2026): tampoco hay permiso nuevo.");
    expect(S15).toContain("| Dominio SIP de la central y clave del teléfono de Kapta de cada anexo (§8.7, fase 2) | Administración (`stores.manage`) |");
    const settings = read("app/dashboard/[storeId]/settings/anura-actions.ts");
    for (const fn of ["saveAnuraSipSettings", "saveAnuraSipCredentials", "removeAnuraSipCredentials", "getAnuraTestPhone"]) {
      expect(settings, fn).toContain(`export async function ${fn}(`);
    }
  });
});
