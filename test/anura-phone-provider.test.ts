// «Llamar con Anura», fase 2: la llamada vive en Kapta, no en la ficha (MOM
// §8.7, «La llamada vive en Kapta, no en la ficha (07-11-2026)»). En
// producción una llamada se cortó 1 s después de conectar porque la ficha se
// cerró: el teléfono vivía dentro de ella y al desmontarse colgaba.
//
// Sin navegador: se prueban las reglas puras (lib/anura/phone-ui.ts) y el
// cableado por su texto, como test/anura-ui.test.ts y test/anura-phone-ui.test.ts:
//   - UN teléfono y UN `<audio>` por pestaña, en el layout del panel;
//   - solo «Colgar», el otro lado, un fallo o cerrar/recargar la pestaña cortan;
//   - cada llamada lleva las acciones de quien la pide, y `call` corre dentro
//     del clic (desbloquea el audio) sin esperas antes;
//   - la tarjeta global sale solo si ninguna pantalla muestra la llamada;
//   - con una llamada en marcha de otro pedido no se pide otra;
//   - el aviso nuevo cuando al anexo le falta la clave del teléfono de Kapta.

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ANURA_KAPTA_KEY_MISSING_TITLE,
  ANURA_PHONE_BUSY_TITLE,
  ANURA_PHONE_KEEPS_GOING,
  anuraFase1StartError,
  anuraGlobalCardVisible,
  anuraKaptaKeyMissingText,
  anuraPhoneBusyText,
  anuraPhoneCallContextLine,
  anuraPhoneCallIsFor,
  anuraPhoneStartDecision,
  anuraRequestedCall,
} from "@/lib/anura/phone-ui";
import { ANURA_KAPTA_START_TITLE } from "@/lib/anura/sip-phone";
import { ANURA_STATUS_LABEL } from "@/lib/anura/events";
import { anuraStartErrorTitle } from "@/lib/anura/ui";

const ROOT = path.resolve(__dirname, "..");
const read = (file: string) => readFileSync(path.join(ROOT, file), "utf8");
const flat = (text: string) => text.replace(/\s+/g, " ");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(path.join(ROOT, dir))) {
    const rel = path.join(dir, name);
    const st = statSync(path.join(ROOT, rel));
    if (st.isDirectory()) walk(rel, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(rel);
  }
  return out;
}

/** Lo que va entre dos marcas del texto (la primera aparición de cada una). */
function between(src: string, from: string, to: string): string {
  const a = src.indexOf(from);
  expect(a, from).toBeGreaterThanOrEqual(0);
  const b = src.indexOf(to, a + from.length);
  expect(b, to).toBeGreaterThan(a);
  return src.slice(a + from.length, b);
}

const A = "aaaaaaaa-1111-4222-8333-444444444444";
const B = "bbbbbbbb-1111-4222-8333-444444444444";

// ---------------------------------------------------------------------------
// Las reglas
// ---------------------------------------------------------------------------

describe("quién muestra la llamada del teléfono de Kapta", () => {
  it("la ficha de ESE pedido, o la llamada de prueba de Ajustes", () => {
    const pedido = { origin: "pedido" as const, orderId: A };
    expect(anuraPhoneCallIsFor(pedido, { origin: "pedido", orderId: A })).toBe(true);
    expect(anuraPhoneCallIsFor(pedido, { origin: "pedido", orderId: B })).toBe(false);
    expect(anuraPhoneCallIsFor(pedido, { origin: "prueba" })).toBe(false);
    expect(anuraPhoneCallIsFor({ origin: "prueba", orderId: null }, { origin: "prueba" })).toBe(true);
    expect(anuraPhoneCallIsFor({ origin: "prueba", orderId: null }, { origin: "pedido", orderId: A })).toBe(false);
    // Sin pedido no hay ficha que la tome.
    expect(anuraPhoneCallIsFor({ origin: "pedido", orderId: null }, { origin: "pedido", orderId: null })).toBe(false);
    expect(anuraPhoneCallIsFor(null, { origin: "pedido", orderId: A })).toBe(false);
  });

  it("la tarjeta global: solo con llamada, y solo si ninguna pantalla la muestra", () => {
    const base = { hasSession: true, busy: true, endedUnseen: false, shownElsewhere: false, busyNotice: false };
    expect(anuraGlobalCardVisible(base)).toBe(true);
    // La ficha de ese pedido (o Ajustes) ya la muestra: nunca dos tarjetas.
    expect(anuraGlobalCardVisible({ ...base, shownElsewhere: true })).toBe(false);
    // …salvo para decir que ya hay una llamada en marcha.
    expect(anuraGlobalCardVisible({ ...base, shownElsewhere: true, busyNotice: true })).toBe(true);
    // Terminó con la ficha cerrada: se queda con cómo terminó hasta que la cierran.
    expect(anuraGlobalCardVisible({ ...base, busy: false, endedUnseen: true })).toBe(true);
    expect(anuraGlobalCardVisible({ ...base, busy: false, endedUnseen: false })).toBe(false);
    expect(anuraGlobalCardVisible({ ...base, hasSession: false })).toBe(false);
  });

  it("«Llamar con Anura» con el teléfono ocupado: la de este pedido se muestra; con otra, no se pide otra", () => {
    expect(anuraPhoneStartDecision({ phoneBusy: false, isThisCall: false })).toBe("llamar");
    expect(anuraPhoneStartDecision({ phoneBusy: false, isThisCall: true })).toBe("llamar");
    expect(anuraPhoneStartDecision({ phoneBusy: true, isThisCall: true })).toBe("mostrar");
    expect(anuraPhoneStartDecision({ phoneBusy: true, isThisCall: false })).toBe("ocupado");
  });

  it("los textos de la tarjeta global", () => {
    expect(ANURA_PHONE_BUSY_TITLE).toBe(ANURA_KAPTA_START_TITLE.ocupada);
    expect(anuraPhoneBusyText({ origin: "pedido", orderLabel: "#KP200108" })).toBe(
      "Estás en la llamada del pedido #KP200108. Kapta hace una llamada a la vez: cuélgala antes de llamar a otro cliente.",
    );
    expect(anuraPhoneBusyText({ origin: "prueba", orderLabel: null })).toMatch(/^Estás en la llamada de prueba\./);
    expect(anuraPhoneBusyText(null)).toMatch(/^Estás en una llamada con Anura\./);
    expect(anuraPhoneCallContextLine({ origin: "pedido", orderId: A, orderLabel: "#KP200108", storeLabel: "Kenku" })).toBe("Pedido #KP200108 · Kenku");
    expect(anuraPhoneCallContextLine({ origin: "pedido", orderId: A, orderLabel: null, storeLabel: null })).toBe("Pedido");
    expect(anuraPhoneCallContextLine({ origin: "prueba", orderId: null, orderLabel: null, storeLabel: null })).toMatch(/^Llamada de prueba/);
    expect(ANURA_PHONE_KEEPS_GOING).toMatch(/cerrar la ficha o ir a otra pantalla: la llamada sigue/);
  });

  it("la llamada recién pedida, hasta el primer sondeo: viva, con el número enmascarado", () => {
    const call = anuraRequestedCall({ id: "c1", mode: "prueba", orderId: null, extension: "101", toMasked: "98••••321", hint: null, nowIso: "2026-11-07T10:00:00.000Z" });
    expect(call).toMatchObject({ id: "c1", mode: "prueba", status: "solicitada", statusLabel: ANURA_STATUS_LABEL.solicitada, active: true, toMasked: "98••••321", inHistory: false });
    expect(call.requestedAt).toBe("2026-11-07T10:00:00.000Z");
    expect(anuraRequestedCall({ id: "c2", mode: "pedido", orderId: A, extension: null, toMasked: null, hint: null }).toMasked).toBe("");
  });
});

describe("fase 1 sin la clave del teléfono de Kapta", () => {
  const notRegistered = { ok: false as const, code: "terminal_no_registrada" as const, error: "Anura no encuentra conectado tu teléfono de Anura…" };
  const noTerminal = { ok: false as const, code: "sin_terminal" as const, error: "Tu anexo no tiene una terminal principal…" };

  it("terminal no conectada o sin terminal principal, sin clave: dice que falta la clave y dónde guardarla", () => {
    const a = anuraFase1StartError(notRegistered, { kaptaKeyMissing: true, extension: "101" });
    expect(a.title).toBe(ANURA_KAPTA_KEY_MISSING_TITLE);
    expect(a.text).toBe(anuraKaptaKeyMissingText("terminal_no_registrada", "101"));
    expect(a.text).toContain("El anexo 101 no tiene guardada la clave de su teléfono de Kapta");
    expect(a.text).toContain("«101-websocket»");
    expect(a.text).toContain("Ajustes › Telefonía Anura");
    expect(a.text).not.toContain("Tu teléfono de Anura no está conectado");
    const b = anuraFase1StartError(noTerminal, { kaptaKeyMissing: true, extension: "101" });
    expect(b.title).toBe(ANURA_KAPTA_KEY_MISSING_TITLE);
    expect(b.text).toMatch(/^El anexo 101 no tiene terminal principal en Anura ni clave del teléfono de Kapta\. Marca la «101-websocket» como principal/);
    // Sin el número del anexo, con la plantilla.
    expect(anuraKaptaKeyMissingText("terminal_no_registrada", null)).toMatch(/^Tu anexo no tiene guardada.*«<anexo>-websocket»/);
  });

  it("con clave guardada, u otro rechazo: lo de siempre", () => {
    expect(anuraFase1StartError(notRegistered, { kaptaKeyMissing: false, extension: "101" })).toEqual({
      title: anuraStartErrorTitle("terminal_no_registrada"),
      text: notRegistered.error,
    });
    for (const code of ["token", "ocupada", "tiempo", "red", "rechazo"] as const) {
      expect(anuraFase1StartError({ code, error: "x" }, { kaptaKeyMissing: true, extension: "101" })).toEqual({ title: anuraStartErrorTitle(code), text: "x" });
    }
    expect(anuraFase1StartError({ error: "x" }, { kaptaKeyMissing: true, extension: null }).title).toBe("No se pudo llamar");
  });

  it("la ficha y Ajustes lo usan en el camino de la fase 1", () => {
    const button = read("components/anura-call.tsx");
    expect(button).toContain('setError(anuraFase1StartError(res, { kaptaKeyMissing: kaptaPhone?.status === "sin_telefono", extension }));');
    const section = read("components/anura-settings-section.tsx");
    expect(section).toContain("const kaptaKeyMissing = !data.sipMigrationMissing && !selected?.phone.hasPassword;");
    expect(section).toContain("setError(anuraFase1StartError(res, { kaptaKeyMissing, extension: selected?.extension ?? null }));");
  });
});

// ---------------------------------------------------------------------------
// El cableado
// ---------------------------------------------------------------------------

describe("un teléfono por pestaña, en el panel", () => {
  const provider = read("components/anura-phone.tsx");
  const button = read("components/anura-call.tsx");
  const section = read("components/anura-settings-section.tsx");
  const layout = read("app/dashboard/layout.tsx");

  it("el layout de /dashboard monta el teléfono alrededor de todo el panel (la ficha global incluida)", () => {
    expect(layout).toContain('import { AnuraPhoneProvider } from "@/components/anura-phone";');
    const open = layout.indexOf("<AnuraPhoneProvider>");
    const close = layout.indexOf("</AnuraPhoneProvider>");
    expect(open).toBeGreaterThan(0);
    for (const inside of ["<DashboardShell", "{children}", "<OrderDrawerHost"]) {
      const at = layout.indexOf(inside);
      expect(at, inside).toBeGreaterThan(open);
      expect(at, inside).toBeLessThan(close);
    }
    // Todas las pantallas que llaman están bajo ese layout: el Master, la ficha global y Ajustes.
    expect(read("app/dashboard/pedidos/page.tsx")).toMatch(/orders-master/);
    expect(read("components/orders-master.tsx")).toContain("<OrderDrawer");
    expect(read("components/order-drawer-host.tsx")).toContain("<OrderDrawer");
    expect(read("components/order-drawer.tsx")).toContain("<AnuraCallButton");
    expect(read("app/dashboard/[storeId]/settings/page.tsx")).toMatch(/store-settings/);
    expect(read("components/store-settings.tsx")).toContain("<AnuraSettingsSection");
  });

  it("solo el panel crea el teléfono y el audio; nadie más usa el teléfono", () => {
    const files = ["app", "components"].flatMap((d) => walk(d));
    const creators = files.filter((f) => /\bcreateAnuraPhone\(/.test(read(f)));
    expect(creators).toEqual([path.join("components", "anura-phone.tsx")]);
    const audio = files.filter((f) => read(f).includes("<AnuraPhoneAudio"));
    expect(audio).toEqual([path.join("components", "anura-phone.tsx")]);
    expect(provider.match(/<audio ref=\{audioRef\} autoPlay hidden \/>/g)).toHaveLength(1);
    const users = files.filter((f) => /\buseAnuraKaptaPhone\(/.test(read(f))).sort();
    expect(users).toEqual([path.join("components", "anura-call.tsx"), path.join("components", "anura-phone.tsx"), path.join("components", "anura-settings-section.tsx")].sort());
    // La ficha y Ajustes no traen el hook viejo con sus acciones ni el audio.
    expect(button).toContain("const phone = useAnuraKaptaPhone();");
    expect(section).toContain("const kapta = useAnuraKaptaPhone();");
  });

  it("solo cortan «Colgar», el otro lado, un fallo o cerrar/recargar la pestaña: la ficha y Ajustes no sueltan el teléfono", () => {
    for (const [name, src] of [
      ["anura-call", button],
      ["anura-settings-section", section],
    ] as const) {
      expect(src, name).not.toMatch(/\.dispose\(/);
      expect(src, name).not.toMatch(/AudioContext/);
    }
    // El panel suelta todo solo al cerrar/recargar la pestaña (o al salir del panel).
    expect(provider).toContain('const onPageHide = () => phoneRef.current?.dispose();');
    expect(provider).toContain('window.addEventListener("pagehide", onPageHide)');
    expect(provider.match(/\.dispose\(\)/g)).toHaveLength(2);
    // Mientras hay llamada, el navegador pregunta antes de cerrar o recargar.
    expect(provider).toContain('window.addEventListener("beforeunload", warn)');
    // El otro lado: si Anura da la llamada por terminada, el panel cuelga (no si solo venció el plazo).
    expect(provider).toContain("if (callId && !active && phoneBusy && !outlives) hangUp();");
    // El sondeo vive en el panel: sigue con la ficha cerrada.
    expect(provider).toContain("const res = await getAnuraCallStatus(callId);");
  });

  it("cada llamada lleva las acciones de quien la pide; `call` corre dentro del clic, sin esperas antes", () => {
    const body = between(provider, "(server: AnuraPhoneServer, meta: AnuraPhoneCallMeta) => {", "return p.call();");
    expect(body).not.toContain("await");
    expect(body).toContain("unlockAudio();");
    expect(body).toContain("serverRef.current = server;");
    expect(body.indexOf("if (p.snapshot().busy) return Promise.resolve(p.snapshot());")).toBeLessThan(body.indexOf("serverRef.current = server;"));
    expect(provider).toContain("fetchCredentials: () => serverRef.current.fetchCredentials(),");
    expect(provider).toContain("requestCall: () => serverRef.current.requestCall(),");
    expect(provider).toContain("reportRejected: (input) => serverRef.current.reportRejected(input),");
    // El amplificador sigue comprobando que le llega sonido antes de tomar la salida.
    expect(provider).toContain("const signal = hearsSignal(amp);");
    expect(provider).toContain("el.muted = false;");
    expect(provider).not.toContain("el.muted = true");
    // La ficha: del clic a `phone.call` no hay esperas.
    const toKapta = between(button, "async function start() {", "await startWithKapta();");
    expect(toKapta).not.toContain("await");
    const kaptaStart = between(button, "async function startWithKapta() {", "await phone.call(server, {");
    expect(kaptaStart).not.toContain("await");
    expect(button).toContain('await phone.call(server, { origin: "pedido", orderId, orderLabel: orderName ?? null, storeLabel: storeName ?? null });');
    // Ajustes: la única espera antes es la de la fase 1, en su propia rama.
    const testStart = between(section, "async function start() {", "await kapta.call(server, {");
    expect(testStart.match(/await /g)).toEqual(["await "]);
    expect(testStart).toContain("await startFase1();");
  });

  it("la ficha toma la llamada de su pedido; con otra en marcha no pide otra", () => {
    expect(button).toContain('const owned = anuraPhoneCallIsFor(phone.session?.meta, { origin: "pedido", orderId }) ? phone.session : null;');
    expect(button).toContain("useAnuraPhoneClaim(owned?.seq ?? null);");
    expect(button).toContain("const snap = owned ? phone.snapshot : null;");
    const decide = between(button, "const decision = anuraPhoneStartDecision(", 'if (way === "bloqueado"');
    expect(decide).toContain('if (decision === "ocupado") {\n      phone.notifyBusy();\n      return;');
    expect(decide.indexOf('if (decision === "ocupado")')).toBeLessThan(decide.indexOf("setOpen(true);\n    setError(null);"));
    // Al abrir la ficha del pedido de la llamada en marcha, su tarjeta la muestra.
    expect(button).toContain("const ownedShows = owned !== null && (phone.busy || owned.endedUnseen);");
    // La llamada que tiene el teléfono de esta pestaña no se «retoma» como si fuera de otra.
    expect(button).toContain("resume.id === phoneCallId");
    expect(button).toContain("{viaKapta && kaptaBusy && <p className=\"mt-1 text-xs text-ink-600\">{ANURA_PHONE_KEEPS_GOING}</p>}");
    expect(button).not.toContain("Si cierras la ficha o la pestaña, la llamada se corta.");
    // La fase 1 sigue igual.
    expect(button).toContain("const res = await startAnuraCall(orderId);");
    expect(button).toContain("Para colgar, cuelga en tu teléfono de Anura. Puedes ocultar este aviso: la llamada sigue.");
    // Ajustes toma la prueba igual.
    expect(section).toContain('const owned = anuraPhoneCallIsFor(kapta.session?.meta, { origin: "prueba" }) ? kapta.session : null;');
    expect(section).toContain("useAnuraPhoneClaim(owned?.seq ?? null);");
    expect(section).toContain("if (!owned) kapta.notifyBusy();");
  });

  it("la tarjeta global: donde la de la ficha, encima de los avisos de cobro, accesible, y abre el pedido sin recargar", () => {
    const card = between(provider, "function AnuraGlobalCallCard(", "/** Volumen de lo que se oye de la llamada");
    expect(card).toContain('role="status" aria-live="polite"');
    expect(card).toContain("fixed bottom-4 right-4 z-[60]");
    expect(read("components/collection-alerts.tsx")).toContain("fixed right-4 bottom-4 z-50");
    expect(card).toContain("Llamada con Anura desde Kapta");
    expect(card).toContain("<AnuraVolumeControl volume={volume} onChange={onVolume} />");
    expect(card).toContain("{anuraPhoneHangUpLabel(snap)}");
    expect(card).toContain('{snap?.muted ? "Activar micrófono" : "Silenciar"}');
    expect(card).toContain("const clock = anuraTalkClock(snap, call, true);");
    expect(card).toContain("<OrderLink orderId={meta.orderId}");
    expect(card).toContain("Abrir el pedido");
    // Un <a href> normal recargaría la página y cortaría la llamada.
    expect(card).not.toMatch(/<a href/);
    expect(provider).toContain("const showCard = anuraGlobalCardVisible({ hasSession: session !== null, busy, endedUnseen, shownElsewhere, busyNotice });");
    expect(provider).toContain("createPortal(");
    // Nada del número entero ni de la clave en el estado: solo lo enmascarado.
    expect(provider).not.toMatch(/customer_phone|customerPhone|password/);
  });
});

describe("el MOM lo dice (§8.7)", () => {
  const MOM = flat(read("docs/mom/master-pedidos-v1.md"));

  it("la llamada vive en Kapta, la tarjeta global y el aviso de la clave que falta", () => {
    expect(MOM).toContain("**La llamada vive en Kapta, no en la ficha (07-11-2026).**");
    expect(MOM).toContain("Solo la terminan **«Colgar»**, **el otro lado** (la clienta cuelga o Anura da la llamada por terminada), **un fallo**, o **cerrar o recargar la pestaña**");
    expect(MOM).toContain(`Dice «${ANURA_PHONE_KEEPS_GOING}».`);
    expect(MOM).toContain("**Nunca dos tarjetas.**");
    expect(MOM).toContain(`la tarjeta global dice «${ANURA_PHONE_BUSY_TITLE}» y, por ejemplo, «${anuraPhoneBusyText({ origin: "pedido", orderLabel: "#KP200108" })}»`);
    expect(MOM).toContain(`«${ANURA_KAPTA_KEY_MISSING_TITLE}»`);
    expect(MOM).toContain(`«${anuraKaptaKeyMissingText("terminal_no_registrada", null)}»`);
    expect(MOM).toContain(`«${anuraKaptaKeyMissingText("sin_terminal", null)}»`);
  });
});
