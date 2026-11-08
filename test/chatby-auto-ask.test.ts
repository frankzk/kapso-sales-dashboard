// Kapta pide sola la dirección o la ubicación (Confirmación por Chatby, MOM
// §6.1; owner, 08-11-2026; 0318): qué se pide y con qué texto, el límite de un
// mensaje de cada clase, la ventana de 24 h, la respuesta (ubicación, dirección
// completa o incompleta), Google otra vez y la pedida de la ubicación, el
// interruptor, la ficha y lo que el servidor tiene que respetar.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { ChatbyMessage } from "@/lib/chatby-conversation";
import { DEFAULT_CHATBY_AUTO_SETTINGS, chatbyAutoSettingsFrom, chatbyConfirmationNote } from "@/lib/chatby-autoconfirm";
import {
  CHATBY_ADDRESS_CORRECTION_NOTE,
  CHATBY_AUTO_ASK_SKIP_LABEL,
  CHATBY_ASK_ADDRESS_PURPOSE,
  chatbyAddressCorrectedAt,
  chatbyAutoAskCarry,
  chatbyAutoAskDecision,
  chatbyAutoAskEvidence,
  chatbyAutoAskGroup,
  chatbyAutoAskKindFor,
  chatbyAutoAskMarkedSkip,
  chatbyAutoAskMarks,
  chatbyAutoAskMessage,
  chatbyAutoAskPurpose,
  chatbyAutoAskReason,
  chatbyAutoAskSkipEvidence,
  type ChatbyMessageEvent,
} from "@/lib/chatby-auto-ask";
import {
  CHATBY_ASK_PURPOSE,
  chatbyAskExplanation,
  chatbyAskStatus,
  chatbyAskStatusAt,
  chatbyAskWatching,
  chatbyHeldInWindow,
  chatbyLocationHoldFrom,
} from "@/lib/chatby-location-ask";
import { chatbyAddressCandidate, chatbyAskKindFor, chatbyCorrectedWatch, chatbyReaskWatch } from "@/lib/chatby-reask";
import { AUTOMATIONS, CHATBY_ASK_KEY, isWhitelisted } from "@/lib/automations-catalog";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

const CREATED = "2026-11-01T14:00:00.000Z";
const NOW = new Date("2026-11-01T15:00:00.000Z");
const PIN = { lat: -6.4875, lng: -76.3653 };

let seq = 0;
function msg(over: Partial<ChatbyMessage> = {}): ChatbyMessage {
  seq++;
  return {
    id: `m${seq}`,
    kind: "cliente",
    at: "2026-11-01T14:10:00.000Z",
    text: "",
    template: null,
    button: false,
    media: null,
    mediaUrl: null,
    error: false,
    agent: null,
    location: null,
    ...over,
  };
}

const MASTER = { macro_stage: "por_confirmar", macro_substage: "sin_llamar", coverage: "provincia_cod", order_created_at: CREATED };
const decide = (over: Partial<Parameters<typeof chatbyAutoAskDecision>[0]> = {}) =>
  chatbyAutoAskDecision({
    mode: "activo",
    kind: "ubicacion",
    master: MASTER,
    messages: [msg({ text: "deseo confirmar mi pedido", at: "2026-11-01T14:50:00.000Z" })],
    events: [],
    evidence: {},
    now: NOW,
    ...over,
  });
const autoEvent = (ask: string, note = "texto"): ChatbyMessageEvent => ({ actor: null, note, payload: { auto: true, ask, purpose: "x" } });

describe("qué se le pide y con qué texto (owner, 08-11-2026)", () => {
  it("Google no la encuentra (A): solo la ubicación actual, el texto del botón de la ficha", () => {
    expect(chatbyAutoAskKindFor({ reason: "sin_ubicacion", ask: "ubicacion" })).toBe("ubicacion");
    expect(chatbyAutoAskMessage({ kind: "ubicacion", customerName: "ROSA quispe", orderName: "AUR900226" })).toBe(
      "Hola Rosa 😊 Para enviar tu pedido #AUR900226, ¿nos compartes tu ubicación actual de WhatsApp? (📎 → Ubicación → Enviar tu ubicación actual)",
    );
  });

  it("sin número de casa (B): calle, número y referencia, o la ubicación", () => {
    const ask = chatbyAskKindFor({ reason: "direccion_incompleta", messageText: "Dirección: Jr huallaga barrio huayco, Tarapoto", orderAddress: "Jr huallaga barrio huayco" });
    expect(ask).toBe("direccion");
    expect(chatbyAutoAskKindFor({ reason: "direccion_incompleta", ask })).toBe("direccion");
    expect(chatbyAutoAskMessage({ kind: "direccion", customerName: "Rosa", orderName: "#AUR900226" })).toBe(
      "Hola Rosa 😊 Para enviar tu pedido #AUR900226 nos falta el número de tu casa. ¿Nos escribes la calle, el número y una referencia? Si prefieres, compártenos tu ubicación actual de WhatsApp (📎 → Ubicación → Enviar tu ubicación actual).",
    );
  });

  it("incompleta por otra cosa (mercado, cruce, km, seña): la ubicación primero o la calle y el número, en UN mensaje", () => {
    for (const address of ["Mercado modelo Piura puesto número 12", "Entre Avenida Grau y Circunvalación", "Carretera Km 4.5", "Frente al grifo"]) {
      const ask = chatbyAskKindFor({ reason: "direccion_incompleta", messageText: null, orderAddress: address });
      expect(chatbyAutoAskKindFor({ reason: "direccion_incompleta", ask }), address).toBe("direccion_o_ubicacion");
    }
    expect(chatbyAutoAskMessage({ kind: "direccion_o_ubicacion", customerName: "Rosa", orderName: "AUR900226" })).toBe(
      "Hola Rosa 😊 Para enviar tu pedido #AUR900226 necesitamos ubicar bien tu dirección. ¿Nos compartes tu ubicación actual de WhatsApp? (📎 → Ubicación → Enviar tu ubicación actual) Si no puedes, escríbenos la calle y el número de tu casa, con una referencia.",
    );
  });

  it("escribió la dirección y Google tampoco la encontró: la ubicación, diciéndole por qué", () => {
    expect(chatbyAutoAskKindFor({ reason: "sin_ubicacion", ask: "ubicacion", corrected: true })).toBe("ubicacion_tras_direccion");
    expect(chatbyAutoAskMessage({ kind: "ubicacion_tras_direccion", customerName: "Rosa", orderName: "AUR900226" })).toBe(
      "Gracias, Rosa 😊 No logramos ubicar esa dirección en el mapa. Para enviar tu pedido #AUR900226, ¿nos compartes tu ubicación actual de WhatsApp? (📎 → Ubicación → Enviar tu ubicación actual)",
    );
    expect(chatbyAutoAskMessage({ kind: "ubicacion_tras_direccion", customerName: null, orderName: null })).toMatch(/^Gracias 😊 .*tu pedido,/);
  });

  it("dos clases, cada una con su propósito en el hecho chatby_message", () => {
    expect(chatbyAutoAskGroup("direccion")).toBe("direccion");
    expect(chatbyAutoAskGroup("direccion_o_ubicacion")).toBe("direccion");
    expect(chatbyAutoAskGroup("ubicacion")).toBe("ubicacion");
    expect(chatbyAutoAskGroup("ubicacion_tras_direccion")).toBe("ubicacion");
    expect(chatbyAutoAskPurpose("ubicacion")).toBe(CHATBY_ASK_PURPOSE);
    expect(chatbyAutoAskPurpose("direccion_o_ubicacion")).toBe(CHATBY_ASK_ADDRESS_PURPOSE);
    expect(chatbyAutoAskReason("ubicacion")).toBe("Kapta (automático) le pidió la ubicación a la clienta por WhatsApp.");
    expect(chatbyAutoAskReason("direccion")).toBe("Kapta (automático) le pidió la dirección completa a la clienta por WhatsApp.");
  });
});

describe("¿toca mandarlo?", () => {
  it("Activo y todo en orden: se manda; en Simulación, se simula; en Apagado, nada", () => {
    expect(decide()).toEqual({ send: true, simulate: false });
    expect(decide({ mode: "simulacion" })).toEqual({ send: true, simulate: true });
    expect(decide({ mode: "apagado" })).toEqual({ send: false, skip: "apagado" });
  });

  it("solo en Por confirmar de Provincia COD", () => {
    expect(decide({ master: { ...MASTER, macro_stage: "preparacion" } })).toEqual({ send: false, skip: "fuera" });
    expect(decide({ master: { ...MASTER, macro_substage: "volver_a_contactar" } })).toEqual({ send: false, skip: "fuera" });
    expect(decide({ master: { ...MASTER, coverage: "agencia" } })).toEqual({ send: false, skip: "fuera" });
  });

  it("lo que manda es la ventana de 24 h desde el ÚLTIMO mensaje de la clienta, con 1 h de margen (owner)", () => {
    const last = Date.parse("2026-11-01T14:50:00.000Z");
    const at = (ms: number) => new Date(last + ms);
    const H = 3_600_000;
    const M = 60_000;
    expect(decide({ now: at(22 * H + 59 * M) })).toEqual({ send: true, simulate: false });
    // 23 h 01: dentro de las 24 h de Meta pero fuera del margen: no se manda.
    expect(decide({ now: at(23 * H + M) })).toEqual({ send: false, skip: "ventana_cerrada" });
    expect(decide({ now: at(23 * H + 59 * M) })).toEqual({ send: false, skip: "ventana_cerrada" });
    expect(decide({ now: at(24 * H + M) })).toEqual({ send: false, skip: "ventana_cerrada" });
  });

  it("un pedido de más de 72 h cuya clienta acaba de escribir: sí se le pide", () => {
    const old = { ...MASTER, order_created_at: "2026-10-25T10:00:00.000Z" };
    const now = new Date("2026-11-01T15:00:00.000Z");
    expect(decide({ master: old, now })).toEqual({ send: true, simulate: false });
    expect(
      chatbyHeldInWindow({ orderCreatedAt: old.order_created_at, now, messages: [msg({ at: "2026-11-01T14:50:00.000Z" })] }),
    ).toBe(true);
  });

  it("UN mensaje de cada clase: la dirección una vez y la ubicación una vez", () => {
    // Ya salió la ubicación: no se repite (ni con el otro texto de la ubicación).
    expect(decide({ events: [autoEvent("ubicacion")] })).toEqual({ send: false, skip: "ya_pedida" });
    expect(decide({ kind: "ubicacion_tras_direccion", events: [autoEvent("ubicacion")] })).toEqual({ send: false, skip: "ya_pedida" });
    // Ya salió la dirección: la ubicación todavía se puede pedir (B → A).
    expect(decide({ kind: "ubicacion_tras_direccion", events: [autoEvent("direccion")] })).toEqual({ send: true, simulate: false });
    expect(decide({ kind: "direccion_o_ubicacion", events: [autoEvent("direccion")] })).toEqual({ send: false, skip: "ya_pedida" });
    // La marca también cuenta (por si el hecho no se pudo escribir).
    const sent = chatbyAutoAskEvidence({}, { kind: "ubicacion", mode: "activo" }, NOW);
    expect(decide({ evidence: sent })).toEqual({ send: false, skip: "ya_pedida" });
  });

  it("lo simulado cuenta para la Simulación, no para el Activo", () => {
    const simulated = chatbyAutoAskEvidence({}, { kind: "ubicacion", mode: "simulacion" }, NOW);
    expect(decide({ mode: "simulacion", evidence: simulated })).toEqual({ send: false, skip: "ya_pedida" });
    expect(decide({ mode: "activo", evidence: simulated })).toEqual({ send: true, simulate: false });
    expect(simulated.asked_at).toBeUndefined();
  });

  it("si una persona del equipo ya le escribió, es de la asesora", () => {
    expect(decide({ events: [{ actor: "u1", note: "Hola", payload: {} }] })).toEqual({ send: false, skip: "asesora_escribio" });
    // `asked_at` sin ninguna pedida automática: lo escribió la ficha.
    expect(decide({ evidence: { asked_at: "2026-11-01T14:55:00.000Z" } })).toEqual({ send: false, skip: "asesora_escribio" });
    expect(chatbyAutoAskMarkedSkip({ asked_at: "2026-11-01T14:55:00.000Z" }, "ubicacion", "activo")).toBe("asesora_escribio");
  });

  it("alguien del equipo escribiendo en Chatby después de su último mensaje: no; el mensaje de Kapta no cuenta", () => {
    const messages = [
      msg({ text: "deseo confirmar", at: "2026-11-01T14:40:00.000Z" }),
      msg({ kind: "equipo", text: "Hola, ¿a qué hora estás?", at: "2026-11-01T14:45:00.000Z" }),
    ];
    expect(decide({ messages })).toEqual({ send: false, skip: "equipo_atendiendo" });
    const ours = [msg({ text: "deseo confirmar", at: "2026-11-01T14:40:00.000Z" }), msg({ kind: "equipo", text: "texto", at: "2026-11-01T14:45:00.000Z" })];
    expect(decide({ kind: "ubicacion_tras_direccion", messages: ours, events: [autoEvent("direccion", "texto")] })).toEqual({ send: true, simulate: false });
    // El bot hablando después no es una persona.
    expect(decide({ messages: [msg({ text: "ok", at: "2026-11-01T14:40:00.000Z" }), msg({ kind: "bot", text: "Gracias", at: "2026-11-01T14:41:00.000Z" })] }).send).toBe(true);
  });

  it("con la ventana de 24 h de WhatsApp cerrada no se manda: queda para la asesora y dice por qué", () => {
    expect(CHATBY_AUTO_ASK_SKIP_LABEL.ventana_cerrada).toMatch(/^La ventana de 24 h de WhatsApp está cerrada/);
    const old = [msg({ text: "deseo confirmar", at: "2026-11-01T14:10:00.000Z" })];
    expect(decide({ messages: old, now: new Date("2026-11-02T15:00:00.000Z") })).toEqual({ send: false, skip: "ventana_cerrada" });
    expect(decide({ messages: [] })).toEqual({ send: false, skip: "ventana_cerrada" });
    const ev = chatbyAutoAskSkipEvidence({ policy: "p" }, "ventana_cerrada", "ubicacion", NOW);
    expect(ev).toMatchObject({ policy: "p", auto_ask_skip: { kind: "ubicacion", reason: "ventana_cerrada" } });
  });
});

describe("la marca", () => {
  it("al pedirla en Activo: asked_at, held_at y la pedida, conservando lo demás", () => {
    const ev = chatbyAutoAskEvidence({ policy: "p", amount_cents: 17800, auto_ask_skip: { reason: "x" } }, { kind: "direccion", mode: "activo" }, NOW, "2026-11-01T14:59:00.000Z");
    expect(ev).toMatchObject({ policy: "p", amount_cents: 17800, asked_at: NOW.toISOString(), held_at: "2026-11-01T14:59:00.000Z" });
    expect(ev.auto_ask_skip).toBeUndefined();
    expect(chatbyAutoAskMarks(ev)).toEqual([{ kind: "direccion", group: "direccion", at: NOW.toISOString(), mode: "activo" }]);
    const twice = chatbyAutoAskEvidence(ev, { kind: "ubicacion_tras_direccion", mode: "activo" }, new Date("2026-11-01T16:00:00.000Z"));
    expect(chatbyAutoAskMarks(twice).map((m) => m.group)).toEqual(["direccion", "ubicacion"]);
    expect(twice.held_at).toBe("2026-11-01T14:59:00.000Z");
  });

  it("pasa a la marca nueva cuando vuelve a quedar para la asesora", () => {
    const ev = { ...chatbyAutoAskEvidence({}, { kind: "direccion", mode: "activo" }, NOW), corrected_at: NOW.toISOString(), amount_cents: 1, total_cents: 2 };
    expect(Object.keys(chatbyAutoAskCarry(ev)).sort()).toEqual(["asked_at", "auto_asks", "corrected_at", "held_at"]);
    expect(chatbyAddressCorrectedAt(ev)).toBe(NOW.toISOString());
    expect(chatbyAddressCorrectedAt({})).toBeNull();
    expect(chatbyAutoAskMarks({ auto_asks: [{ kind: "otro", at: "x", mode: "activo" }, null] })).toEqual([]);
  });
});

describe("la respuesta de la clienta", () => {
  const INCOMPLETA =
    "Hola equipo Aurela, deseo confirmar mi pedido AUR900226 y pagaré S/ 178.00 en casa.\nFaja moldeadora x1\nDirección: Jr huallaga barrio huayco, San Martín, Tarapoto";
  const ORDER = { address: "Jr huallaga barrio huayco", reference: null, district: "Tarapoto", province: "San Martin", region: "San Martín" };
  const ASKED = "2026-11-01T14:30:00.000Z";
  const watch = (messages: ChatbyMessage[], since: string | null = ASKED, order = ORDER) =>
    chatbyReaskWatch({ messages, orderName: "#AUR900226", orderCreatedAt: CREATED, totalAmount: 178, order }, { correctionSince: since });
  const confirma = () => msg({ text: INCOMPLETA, at: "2026-11-01T14:10:00.000Z" });
  const pide = () => msg({ kind: "equipo", text: "¿nos escribes la calle y el número?", at: ASKED });

  it("con su ubicación: la guía va con esa ubicación (pin), como en A", () => {
    const c = confirma();
    expect(watch([c, pide(), msg({ location: PIN, at: "2026-11-01T14:40:00.000Z" })])).toEqual({
      kind: "confirm",
      messageId: c.id,
      at: c.at,
      amountCents: 17800,
      pin: true,
    });
  });

  it("con una dirección completa: es la dirección corregida (Google la vuelve a buscar)", () => {
    const c = confirma();
    expect(watch([c, pide(), msg({ text: "Jr huallaga 765 barrio huayco", at: "2026-11-01T14:40:00.000Z" })])).toEqual({
      kind: "correct",
      messageId: c.id,
      at: c.at,
      amountCents: 17800,
      address: "Jr huallaga 765 barrio huayco",
    });
    // Un «gracias» después no cambia nada; «Dirección:» se quita.
    const v = watch([c, pide(), msg({ text: "Dirección: Jr Lima 120, frente al parque", at: "2026-11-01T14:40:00.000Z" }), msg({ text: "gracias 🙏", at: "2026-11-01T14:41:00.000Z" })]);
    expect(v).toMatchObject({ kind: "correct", address: "Jr Lima 120, frente al parque" });
  });

  it("en dos mensajes: se juntan en orden", () => {
    const v = watch([confirma(), pide(), msg({ text: "Jr Lima", at: "2026-11-01T14:40:00.000Z" }), msg({ text: "120", at: "2026-11-01T14:41:00.000Z" })]);
    expect(v).toMatchObject({ kind: "correct", address: "Jr Lima, 120" });
  });

  it("si sigue incompleta: queda para la asesora (espera, sin otra pedida de la dirección)", () => {
    expect(watch([confirma(), pide(), msg({ text: "por el mercado central", at: "2026-11-01T14:40:00.000Z" })])).toEqual({ kind: "wait", reply: "incompleta" });
  });

  it("lo que escribió antes de la pedida, una pregunta o un audio no son la dirección", () => {
    const antes = msg({ text: "Jr Lima 120", at: "2026-11-01T14:20:00.000Z" });
    expect(watch([confirma(), antes, pide()]).kind).toBe("wait");
    expect(watch([confirma(), pide(), msg({ text: "¿Jr Lima 120 sirve?", at: "2026-11-01T14:40:00.000Z" })])).toEqual({ kind: "wait" });
    expect(watch([confirma(), pide(), msg({ text: "Jr Lima 120", at: "2026-11-01T14:40:00.000Z" }), msg({ media: "audio", at: "2026-11-01T14:41:00.000Z" })])).toEqual({ kind: "wait" });
  });

  it("sin el interruptor (sin `correctionSince`), como antes: una dirección que no es la del pedido espera", () => {
    expect(watch([confirma(), pide(), msg({ text: "Jr huallaga 765 barrio huayco", at: "2026-11-01T14:40:00.000Z" })], null)).toEqual({ kind: "wait" });
  });

  it("si dice que no lo quiere, se aplica el rechazo de siempre", () => {
    expect(watch([confirma(), pide(), msg({ text: "ya no lo deseo, quiero anular", at: "2026-11-01T14:40:00.000Z" })])).toEqual({ kind: "hold", reason: "rechazo" });
  });

  it("la dirección que se toma", () => {
    expect(chatbyAddressCandidate([msg({ text: "ok", at: "2026-11-01T14:40:00.000Z" })], ASKED)).toBeNull();
    expect(chatbyAddressCandidate([msg({ text: "Jr Lima 120\nfrente al parque", at: "2026-11-01T14:40:00.000Z" })], ASKED)).toEqual({
      address: "Jr Lima 120, frente al parque",
      complete: true,
    });
    expect(chatbyAddressCandidate([msg({ kind: "equipo", text: "Jr Lima 120", at: "2026-11-01T14:40:00.000Z" })], ASKED)).toBeNull();
    expect(chatbyAddressCandidate([msg({ text: "Jr Lima 120", at: "2026-11-01T14:40:00.000Z" })], "no es fecha")).toBeNull();
  });
});

describe("ya corregida: Google otra vez y, si no la encuentra, la ubicación", () => {
  const INCOMPLETA =
    "Hola equipo Aurela, deseo confirmar mi pedido AUR900226 y pagaré S/ 178.00 en casa.\nDirección: Jr huallaga barrio huayco, San Martín, Tarapoto";
  // El pedido ya tiene la dirección nueva; el mensaje sigue con la vieja.
  const ORDER = { address: "Jr huallaga 765 barrio huayco", reference: null, district: "Tarapoto", province: "San Martin", region: "San Martín" };
  const corrected = (messages: ChatbyMessage[]) =>
    chatbyCorrectedWatch({ messages, orderName: "#AUR900226", orderCreatedAt: CREATED, totalAmount: 178, order: ORDER });

  it("la dirección vieja del mensaje ya no se compara: confirma (la guía prueba Google con la nueva)", () => {
    const c = msg({ text: INCOMPLETA, at: "2026-11-01T14:10:00.000Z" });
    const v = corrected([c, msg({ text: "Jr huallaga 765 barrio huayco", at: "2026-11-01T14:40:00.000Z" })]);
    expect(v).toEqual({ kind: "confirm", messageId: c.id, at: c.at, amountCents: 17800, pin: false });
  });

  it("después de la pedida de la ubicación, su ubicación: con pin", () => {
    const c = msg({ text: INCOMPLETA, at: "2026-11-01T14:10:00.000Z" });
    const v = corrected([c, msg({ text: "Jr huallaga 765 barrio huayco", at: "2026-11-01T14:40:00.000Z" }), msg({ location: PIN, at: "2026-11-01T15:10:00.000Z" })]);
    expect(v).toMatchObject({ kind: "confirm", pin: true });
  });

  it("lo demás sigue igual: otro monto o un «no lo quiero» no confirman", () => {
    expect(corrected([msg({ text: INCOMPLETA.replace("178.00", "150.00"), at: "2026-11-01T14:10:00.000Z" })])).toEqual({ kind: "hold", reason: "monto_distinto" });
    expect(
      corrected([msg({ text: INCOMPLETA, at: "2026-11-01T14:10:00.000Z" }), msg({ text: "mejor cancelen, ya no lo quiero", at: "2026-11-01T14:40:00.000Z" })]),
    ).toEqual({ kind: "hold", reason: "rechazo" });
  });

  it("la cadena B → A: dirección pedida, respondió, Google no la encontró → se pide la ubicación una sola vez", () => {
    const afterAddress = chatbyAutoAskEvidence({}, { kind: "direccion", mode: "activo" }, NOW);
    const kind = chatbyAutoAskKindFor({ reason: "sin_ubicacion", ask: "ubicacion", corrected: true });
    const reply = [msg({ text: "Jr huallaga 765", at: "2026-11-01T15:20:00.000Z" })];
    const now = new Date("2026-11-01T15:40:00.000Z");
    expect(decide({ kind, evidence: afterAddress, messages: reply, events: [autoEvent("direccion")], now })).toEqual({ send: true, simulate: false });
    const afterLocation = chatbyAutoAskEvidence(afterAddress, { kind, mode: "activo" }, now);
    expect(
      decide({ kind: "ubicacion", evidence: afterLocation, messages: reply, events: [autoEvent("direccion"), autoEvent(kind)], now }),
    ).toEqual({ send: false, skip: "ya_pedida" });
  });

  it("la nota de la confirmación dice que la dirección la completó por Chatby", () => {
    expect(chatbyConfirmationNote({ orderName: "#AUR900226", at: null, amountCents: 17800, addressCorrected: true })).toMatch(
      /y la dirección que completó por Chatby\.$/,
    );
    expect(chatbyConfirmationNote({ orderName: "#AUR900226", at: null, amountCents: 17800, addressCorrected: true, location: true })).toMatch(
      /la dirección que completó por Chatby y su ubicación de WhatsApp\.$/,
    );
    expect(CHATBY_ADDRESS_CORRECTION_NOTE).toBe("Dirección completada por la clienta en Chatby");
  });
});

describe("la ficha dice lo que ya hizo Kapta", () => {
  const check = (evidence: Record<string, unknown>) => ({ outcome: "para_asesora", reason: "sin_ubicacion", checked_at: "2026-11-01T14:20:00.000Z", evidence });
  const master = { order_created_at: CREATED, customer_name: "Rosa", order_name: "AUR900226" };

  it("«Kapta le pidió la ubicación … · esperando respuesta», con la hora de la pedida automática", () => {
    const evidence = chatbyAutoAskEvidence({}, { kind: "ubicacion", mode: "activo" }, NOW);
    const hold = chatbyLocationHoldFrom({ reason: "sin_ubicacion", ask: "ubicacion", check: check(evidence), master, now: NOW });
    expect(hold.autoAsk).toEqual({ what: "ubicacion", at: NOW.toISOString() });
    expect(chatbyAskStatusAt(hold)).toBe(NOW.toISOString());
    expect(chatbyAskStatus(hold, "Hoy 10:00")).toMatch(/^Kapta le pidió la ubicación: Hoy 10:00 · esperando respuesta\. No hace falta volver a pedírsela/);
  });

  it("lo simulado no se dice; si una persona la pidió después, manda lo de la persona", () => {
    const sim = chatbyAutoAskEvidence({}, { kind: "ubicacion", mode: "simulacion" }, NOW);
    expect(chatbyLocationHoldFrom({ reason: "sin_ubicacion", ask: "ubicacion", check: check(sim), master, now: NOW }).autoAsk).toBeNull();
    const later = { ...chatbyAutoAskEvidence({}, { kind: "ubicacion", mode: "activo" }, NOW), asked_at: "2026-11-01T16:00:00.000Z" };
    const hold = chatbyLocationHoldFrom({ reason: "sin_ubicacion", ask: "ubicacion", check: check(later), master, now: NOW });
    expect(chatbyAskStatus(hold, "Hoy 11:00")).toMatch(/^Se la pediste: Hoy 11:00/);
  });

  it("la dirección completa pedida, la respuesta incompleta y la dirección corregida", () => {
    const asked = chatbyAutoAskEvidence({}, { kind: "direccion", mode: "activo" }, NOW);
    const dirCheck = { ...check(asked), reason: "direccion_incompleta" };
    const hold = chatbyLocationHoldFrom({ reason: "direccion_incompleta", ask: "direccion", check: dirCheck, master, now: NOW });
    expect(chatbyAskStatus(hold, null)).toMatch(/^Kapta le pidió la dirección completa · esperando respuesta/);
    const incomplete = chatbyLocationHoldFrom({
      reason: "direccion_incompleta",
      ask: "direccion",
      check: { ...dirCheck, evidence: { ...asked, reply_incomplete_at: NOW.toISOString() } },
      master,
      now: NOW,
    });
    expect(chatbyAskStatus(incomplete, null)).toMatch(/^La clienta respondió, pero la dirección que escribió sigue incompleta/);
    const fixed = chatbyLocationHoldFrom({ reason: "sin_ubicacion", ask: "ubicacion", check: check({ ...asked, corrected_at: NOW.toISOString() }), master, now: NOW });
    expect(fixed.corrected).toBe(true);
    expect(chatbyAskExplanation(fixed)).toMatch(/^La clienta completó la dirección por Chatby/);
  });
});

describe("la ventana de lo que quedó para la asesora: 72 h del pedido o 24 h de la clienta", () => {
  const CREATED_OLD = "2026-10-28T10:00:00.000Z";
  const now = new Date("2026-11-01T15:00:00.000Z");
  const H = 3_600_000;
  const lastAt = (ago: number) => [msg({ at: new Date(now.getTime() - ago).toISOString() })];

  it("pasadas las 72 h, se sigue mirando si la clienta escribió hace menos de 24 h", () => {
    expect(chatbyHeldInWindow({ orderCreatedAt: CREATED_OLD, now })).toBe(false);
    expect(chatbyHeldInWindow({ orderCreatedAt: CREATED_OLD, now, messages: lastAt(23 * H + 59 * 60_000) })).toBe(true);
    expect(chatbyHeldInWindow({ orderCreatedAt: CREATED_OLD, now, messages: lastAt(24 * H + 60_000) })).toBe(false);
    // El equipo o el bot no abren la ventana.
    expect(chatbyHeldInWindow({ orderCreatedAt: CREATED_OLD, now, messages: [msg({ kind: "equipo", at: now.toISOString() })] })).toBe(false);
    // Dentro de las 72 h, como siempre.
    expect(chatbyHeldInWindow({ orderCreatedAt: "2026-11-01T10:00:00.000Z", now })).toBe(true);
  });

  it("la ficha lo dice igual", () => {
    expect(chatbyAskWatching({ reason: "sin_ubicacion", askedAt: null, orderCreatedAt: CREATED_OLD, now, messages: lastAt(2 * H) })).toBe(true);
    expect(chatbyAskWatching({ reason: "sin_ubicacion", askedAt: null, orderCreatedAt: CREATED_OLD, now, messages: lastAt(30 * H) })).toBe(false);
    const hold = chatbyLocationHoldFrom({
      reason: "sin_ubicacion",
      ask: "ubicacion",
      check: { outcome: "para_asesora", reason: "sin_ubicacion", checked_at: CREATED_OLD, evidence: {} },
      master: { order_created_at: CREATED_OLD, customer_name: "Rosa", order_name: "AUR1" },
      now,
      messages: lastAt(2 * H),
    });
    expect(hold.inWindow).toBe(true);
    expect(chatbyAskStatus({ ...hold, inWindow: false }, null)).toMatch(/^Pasaron las 72 h del pedido y la clienta no escribió en las últimas 24 h/);
  });

  it("el servidor: el pedido viejo se lee en la misma búsqueda y solo se deja de mirar si la clienta no escribió en 24 h", () => {
    const server = read("lib/chatby-autoconfirm-server.ts");
    expect(server).toContain('const pastOrderWindow = r.kind !== "confirmado" && !inWindow;');
    expect(server).toContain("if (pastOrderWindow && !chatbyHeldInWindow({ orderCreatedAt: master.order_created_at, now, windowHours: settings.window_hours, messages: conversation.messages })) {");
    // La edad del pedido ya no frena el mensaje: lo frena la ventana de la clienta.
    expect(read("lib/chatby-auto-ask.ts")).toContain("if (!chatbyAutoAskWindowOpen(input.messages, now)) return { send: false, skip: \"ventana_cerrada\" };");
  });
});

describe("el interruptor (0318)", () => {
  it("nace Apagado; sin la columna o con un valor raro, Apagado", () => {
    expect(DEFAULT_CHATBY_AUTO_SETTINGS.ask_mode).toBe("apagado");
    expect(chatbyAutoSettingsFrom({ org_id: "o", enabled: true })?.ask_mode).toBe("apagado");
    expect(chatbyAutoSettingsFrom({ org_id: "o", enabled: true, ask_mode: "activo" })?.ask_mode).toBe("activo");
    expect(chatbyAutoSettingsFrom({ org_id: "o", enabled: true, ask_mode: "simulacion" })?.ask_mode).toBe("simulacion");
    expect(chatbyAutoSettingsFrom({ org_id: "o", enabled: true, ask_mode: "si" })?.ask_mode).toBe("apagado");
  });

  it("en Automatizaciones, grupo «confirmacion», con las tres posiciones y fuera de la lista blanca de on/off", () => {
    const entry = AUTOMATIONS.find((e) => e.key === CHATBY_ASK_KEY)!;
    expect(entry.group).toBe("confirmacion");
    expect(entry.effect).toBe("Envía WhatsApp");
    expect(entry.control).toEqual({ kind: "org_mode", table: "chatby_auto_settings", column: "ask_mode" });
    expect(isWhitelisted("chatby_auto_settings", "ask_mode")).toBe(false);
    const actions = read("app/dashboard/automatizaciones/actions.ts");
    expect(actions).toContain("export async function setChatbyAskMode(");
    expect(actions).toContain('.update({ ask_mode: mode, updated_by: g.actor, updated_at: new Date().toISOString() })');
    expect(actions).toContain('Falta la migración 0318 en la base de datos.');
    const panel = read("components/automations-panel.tsx");
    expect(panel).toContain("<AskModeRow key={entry.key} entry={entry} orgId={org.orgId} view={org.chatbyAsk} writable={writable} />");
    // La fila es la misma para la guía con historial (0317), con su acción.
    expect(panel).toContain("save = setChatbyAskMode,");
    expect(panel).toContain("await save(orgId, next)");
  });

  it("la migración: aditiva, nace apagada y solo sus tres valores; con su prueba en verify-db", () => {
    const sql = read("db/migrations/0318_chatby_auto_ask.sql");
    expect(sql).toContain("add column if not exists ask_mode text not null default 'apagado'");
    expect(sql).toContain("check (ask_mode in ('apagado', 'simulacion', 'activo'))");
    expect(sql).not.toMatch(/\bupdate\b|\bdelete\b|drop table/i);
    expect(read("scripts/verify-db.sh")).toContain("scripts/sql/chatby_auto_ask_smoke.sql");
  });
});

describe("el servidor", () => {
  const server = read("lib/chatby-autoconfirm-server.ts");
  const autoAsk = server.slice(server.indexOf("async function autoAsk("), server.indexOf("async function askBlockedForPerson("));

  it("pide sola al quedar para la asesora por la dirección incompleta o sin ubicación", () => {
    expect(server).toContain('if (verdict.reason === "direccion_incompleta" && item.outcome !== "error") {');
    expect(server).toContain('kind: chatbyAutoAskKindFor({ reason: "direccion_incompleta", ask }),');
    expect(server).toContain('if (g.reason === "sin_ubicacion" && item.outcome !== "error") {');
    // Lo que ya esperaba la ubicación también (lo que quedó antes de encenderlo), en la misma pasada.
    expect(server).toContain('kind: chatbyAutoAskKindFor({ reason: "sin_ubicacion", ask: "ubicacion", corrected }),');
  });

  it("sin nuevas lecturas: la misma pasada de la ubicación y su tope", () => {
    expect(server.match(/\.limit\(limit\)/g)?.length).toBe(3);
    expect(server.match(/fetchChatbyConversation\(/g)?.length).toBe(2);
    expect(autoAsk).not.toContain("fetchChatbyConversation(");
  });

  it("Apagado corta antes de nada; la decisión, las rejas de una persona y luego el envío de la ficha", () => {
    const off = autoAsk.indexOf('if (ctx.askMode === "apagado") return;');
    const decision = autoAsk.indexOf("chatbyAutoAskDecision({");
    const person = autoAsk.indexOf("askBlockedForPerson(admin, master)");
    const simulate = autoAsk.indexOf("if (decision.simulate) {");
    const send = autoAsk.indexOf("sendChatbyReply({");
    expect(off).toBeGreaterThan(0);
    expect(decision).toBeGreaterThan(off);
    expect(person).toBeGreaterThan(decision);
    expect(simulate).toBeGreaterThan(person);
    expect(send).toBeGreaterThan(simulate);
    expect(autoAsk).toContain("pauseMinutes: CHATBY_REPLY_PAUSE_MINUTES");
    // El hecho de la ficha, sin actor y marcado como automático.
    expect(autoAsk).toContain('kind: "chatby_message"');
    expect(autoAsk).toContain("actor: null,");
    expect(autoAsk).toContain("auto: true,");
    expect(autoAsk).toContain("purpose: chatbyAutoAskPurpose(kind),");
    // La lista de pago adelantado, como en la guía.
    expect(server).toContain('prepayOrderCheck(admin, row as unknown as PrepayOrderRow, "confirmar")');
  });

  it("la dirección corregida va por el camino de «Corregir ubicación» y la guía se vuelve a intentar con Google", () => {
    const correct = server.slice(server.indexOf("async function correctAddress("), server.indexOf("async function autoAsk("));
    expect(correct.indexOf('if (ctx.askMode !== "activo") {')).toBeLessThan(correct.indexOf("saveChatbyAddressCorrection("));
    expect(correct.indexOf("saveChatbyAddressCorrection(")).toBeLessThan(correct.indexOf("tryChatbyGuide(guide, updated, w.conversation.messages)"));
    expect(correct).toContain("corrected: true,");
    const save = read("lib/order-address-correction.ts");
    expect(save).toContain('.from("order_geo_overrides")');
    expect(save).toContain('onConflict: "order_id"');
    expect(save).toContain("note: CHATBY_ADDRESS_CORRECTION_NOTE,");
    expect(save).toContain('comment_type: "ubicacion"');
    expect(save).toContain("recomputeOrderMasterSafe(admin, [input.orderId])");
    expect(save).toContain('cause: "ubicacion_corregida"');
    // Solo la dirección: el distrito y la provincia que ya tuviera se conservan.
    expect(save).toContain('.select("region,province,district,reference,latitude,longitude")');
  });
});
