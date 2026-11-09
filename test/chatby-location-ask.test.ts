// Pedir la ubicación desde la pestaña «Chatby» de la ficha y releer el chat
// cuando la clienta la manda (MOM §6.1, «Confirmó por Chatby», owner
// 08-11-2026): el aviso, el mensaje, la regla de relectura y lo que el
// servidor tiene que respetar.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { mapChatbyMessages, type ChatbyMessage } from "@/lib/chatby-conversation";
import { chatbyConfirmationNote, direccionSinNumeroDeCasa } from "@/lib/chatby-autoconfirm";
import {
  CHATBY_ASK_PURPOSE,
  chatbyAskBannerReason,
  chatbyAskEvidence,
  chatbyAskExplanation,
  chatbyAskMessage,
  chatbyAskStatus,
  chatbyAskTitle,
  chatbyAskWatching,
  chatbyFirstName,
  chatbyHeldAt,
  chatbyHeldWatchDue,
  chatbyLocationHoldFrom,
  chatbyNewCustomerMessage,
} from "@/lib/chatby-location-ask";
import { chatbyAskKindFor, chatbyReaskWatch } from "@/lib/chatby-reask";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

const CREATED = "2026-11-01T14:00:00.000Z";
const NOW = new Date("2026-11-02T10:00:00.000Z");
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

const MASTER = { macro_stage: "por_confirmar", macro_substage: "sin_llamar", coverage: "provincia_cod" };

describe("el aviso de la ficha", () => {
  it("sale con para_asesora y uno de los tres motivos, en Por confirmar y Provincia COD", () => {
    for (const reason of ["direccion_incompleta", "sin_ubicacion", "sin_ubicacion_cerrado"]) {
      expect(chatbyAskBannerReason({ check: { outcome: "para_asesora", reason }, master: MASTER })).toBe(reason);
    }
    expect(
      chatbyAskBannerReason({ check: { outcome: "para_asesora", reason: "sin_ubicacion" }, master: { ...MASTER, macro_substage: "por_confirmar" } }),
    ).toBe("sin_ubicacion");
  });

  it("no sale con otro motivo, otro resultado, sin marca, fuera de Por confirmar o fuera de Provincia COD", () => {
    expect(chatbyAskBannerReason({ check: { outcome: "para_asesora", reason: "monto_distinto" }, master: MASTER })).toBeNull();
    expect(chatbyAskBannerReason({ check: { outcome: "confirmado", reason: "sin_ubicacion" }, master: MASTER })).toBeNull();
    expect(chatbyAskBannerReason({ check: null, master: MASTER })).toBeNull();
    const held = { outcome: "para_asesora", reason: "direccion_incompleta" };
    expect(chatbyAskBannerReason({ check: held, master: { ...MASTER, macro_stage: "preparacion" } })).toBeNull();
    expect(chatbyAskBannerReason({ check: held, master: { ...MASTER, macro_substage: "volver_a_contactar" } })).toBeNull();
    expect(chatbyAskBannerReason({ check: held, master: { ...MASTER, coverage: "lima" } })).toBeNull();
  });

  it("el título dice por qué se paró la guía", () => {
    expect(chatbyAskTitle("direccion_incompleta")).toBe("La clienta confirmó, pero la dirección está incompleta");
    expect(chatbyAskTitle("sin_ubicacion")).toBe("La clienta confirmó, pero Google no encuentra la dirección");
    expect(chatbyAskTitle("sin_ubicacion_cerrado")).toBe("La clienta confirmó, pero Google no encuentra la dirección");
    expect(chatbyAskExplanation({ reason: "direccion_incompleta", ask: "direccion" })).toContain("número de la casa");
    expect(chatbyAskExplanation({ reason: "sin_ubicacion", ask: "ubicacion" })).toContain("Google no da el edificio");
  });

  it("qué pasa después: relee si se le pidió (o es sin_ubicacion), y después de 72 h ya no", () => {
    const base = { reason: "direccion_incompleta" as const, askedAt: null, inWindow: true, watching: false };
    expect(chatbyAskStatus(base, null)).toMatch(/^Pídesela desde aquí/);
    expect(chatbyAskStatus({ ...base, askedAt: "2026-11-02T09:00:00.000Z", watching: true }, "Hoy 04:00")).toMatch(/^Se la pediste: Hoy 04:00/);
    expect(chatbyAskStatus({ ...base, reason: "sin_ubicacion", watching: true }, null)).toMatch(/^Kapta vuelve a leer el chat/);
    expect(chatbyAskStatus({ ...base, inWindow: false }, null)).toMatch(/^Pasaron las 72 h/);
    expect(chatbyAskWatching({ reason: "sin_ubicacion", askedAt: null, orderCreatedAt: CREATED, now: NOW })).toBe(true);
    expect(chatbyAskWatching({ reason: "direccion_incompleta", askedAt: null, orderCreatedAt: CREATED, now: NOW })).toBe(false);
    expect(chatbyAskWatching({ reason: "direccion_incompleta", askedAt: NOW.toISOString(), orderCreatedAt: CREATED, now: NOW })).toBe(true);
    expect(
      chatbyAskWatching({ reason: "sin_ubicacion", askedAt: null, orderCreatedAt: CREATED, now: new Date("2026-11-05T15:00:00.000Z") }),
    ).toBe(false);
  });

  it("lo arma el servidor con la marca y el pedido", () => {
    const hold = chatbyLocationHoldFrom({
      reason: "direccion_incompleta",
      ask: "direccion",
      check: { outcome: "para_asesora", reason: "direccion_incompleta", checked_at: "2026-11-01T14:20:00.000Z", evidence: {} },
      master: { order_created_at: CREATED, customer_name: "ROSA quispe", order_name: "AUR900226" },
      now: NOW,
    });
    expect(hold).toMatchObject({ heldAt: "2026-11-01T14:20:00.000Z", askedAt: null, inWindow: true, watching: false, customerName: "ROSA quispe" });
  });
});

describe("el mensaje ya escrito (owner, 08-11-2026)", () => {
  it("Google no la encuentra: SOLO la ubicación actual de WhatsApp, sin calle, número ni referencia", () => {
    const text = chatbyAskMessage({ ask: "ubicacion", customerName: "ROSA MARIA quispe", orderName: "#AUR900226" });
    expect(text).toBe(
      "Hola Rosa 😊 Para enviar tu pedido #AUR900226, ¿nos compartes tu ubicación actual de WhatsApp? (📎 → Ubicación → Enviar tu ubicación actual)",
    );
    expect(text).not.toMatch(/calle|número|referencia/i);
  });

  it("sin el número de la casa: la calle, el número y una referencia, con la ubicación como alternativa", () => {
    const text = chatbyAskMessage({ ask: "direccion", customerName: "rosa", orderName: "AUR900226" });
    expect(text).toMatch(/^Hola Rosa 😊 Para enviar tu pedido #AUR900226 /);
    expect(text).toContain("la calle, el número y una referencia");
    expect(text).toContain("ubicación actual de WhatsApp");
  });

  it("sin nombre ni número, igual se entiende", () => {
    expect(chatbyAskMessage({ ask: "ubicacion" })).toMatch(/^Hola 😊 Para enviar tu pedido, ¿nos compartes/);
    expect(chatbyFirstName("  ")).toBeNull();
    expect(chatbyFirstName("123")).toBeNull();
    expect(chatbyFirstName("ÁNGELA ruiz")).toBe("Ángela");
  });

  it("qué se pide: la calle y el número solo si falta el número de la casa", () => {
    const ask = (orderAddress: string, reason: "direccion_incompleta" | "sin_ubicacion" = "direccion_incompleta") =>
      chatbyAskKindFor({ reason, messageText: null, orderAddress });
    expect(ask("Jr huallaga 765 barrio huayco", "sin_ubicacion")).toBe("ubicacion");
    expect(ask("Calle Cordova")).toBe("direccion");
    expect(ask("Tupac Amaru, barrio huayco")).toBe("direccion");
    expect(ask("Jr Lima s/n")).toBe("direccion");
    expect(ask("Calle Sucre sin número")).toBe("direccion");
    expect(ask("Jr. Lima frente a la plaza")).toBe("direccion");
    // Incompleta por otra cosa: solo la ubicación.
    expect(ask("Mercado modelo Piura puesto número 12")).toBe("ubicacion");
    expect(ask("Entre Avenida Grau y Circunvalación")).toBe("ubicacion");
    expect(ask("Carretera Km 4.5")).toBe("ubicacion");
    expect(ask("Frente al grifo Primax")).toBe("ubicacion");
    expect(ask("Paradero penal de bajada")).toBe("ubicacion");
    expect(ask("Magisterial III y 501")).toBe("ubicacion");
    expect(direccionSinNumeroDeCasa("Agencia Shalom Tarapoto")).toBe(false);
  });

  it("qué se pide: mira la dirección del mensaje de confirmación si esa es la incompleta", () => {
    expect(
      chatbyAskKindFor({
        reason: "direccion_incompleta",
        messageText: "Deseo confirmar mi pedido\nDirección: Calle Cordova, Tarapoto",
        orderAddress: "Jr huallaga 765 barrio huayco",
      }),
    ).toBe("direccion");
  });
});

describe("releer el chat cuando la clienta responde", () => {
  const S = { recheck_minutes: 30 };
  const asked = { asked_at: "2026-11-02T08:00:00.000Z", held_at: "2026-11-01T14:20:00.000Z" };
  const held = (over: Record<string, unknown> = {}) => ({
    outcome: "para_asesora",
    reason: "direccion_incompleta",
    checked_at: "2026-11-02T09:00:00.000Z",
    evidence: asked,
    ...over,
  });

  it("dirección incompleta (o cerrado) y se le pidió: toca releer cada recheck_minutes", () => {
    expect(chatbyHeldWatchDue(held(), NOW, S)).toBe(true);
    expect(chatbyHeldWatchDue(held({ reason: "sin_ubicacion_cerrado" }), NOW, S)).toBe(true);
    expect(chatbyHeldWatchDue(held({ checked_at: "2026-11-02T09:45:00.000Z" }), NOW, S)).toBe(false);
  });

  it("sin pedírsela, con otro motivo o con otro resultado, sigue siendo final", () => {
    expect(chatbyHeldWatchDue(held({ evidence: {} }), NOW, S)).toBe(false);
    expect(chatbyHeldWatchDue(held({ evidence: { asked_at: null } }), NOW, S)).toBe(false);
    expect(chatbyHeldWatchDue(held({ reason: "monto_distinto" }), NOW, S)).toBe(false);
    expect(chatbyHeldWatchDue(held({ outcome: "confirmado" }), NOW, S)).toBe(false);
    // `sin_ubicacion` ya lo relee la pasada de la ubicación, como desde el 02-11.
    expect(chatbyHeldWatchDue(held({ reason: "sin_ubicacion" }), NOW, S)).toBe(false);
    expect(chatbyHeldWatchDue(null, NOW, S)).toBe(false);
  });

  it("con un mensaje nuevo de la clienta desde que quedó para la asesora: se evalúa; sin él, no", () => {
    const since = chatbyHeldAt({ evidence: asked });
    expect(since).toBe("2026-11-01T14:20:00.000Z");
    expect(chatbyNewCustomerMessage([msg({ at: "2026-11-01T14:10:00.000Z" }), msg({ location: PIN, at: "2026-11-02T08:30:00.000Z" })], since)).toBe(true);
    expect(chatbyNewCustomerMessage([msg({ text: "Jr huallaga 765", at: "2026-11-02T08:30:00.000Z" })], since)).toBe(true);
    // Solo lo que escribió el equipo (la pedida) no es nuevo de la clienta.
    expect(chatbyNewCustomerMessage([msg({ at: "2026-11-01T14:10:00.000Z" }), msg({ kind: "equipo", at: "2026-11-02T08:00:00.000Z" })], since)).toBe(false);
    expect(chatbyNewCustomerMessage([msg({ at: null })], since)).toBe(false);
    expect(chatbyNewCustomerMessage([msg({ at: "2026-11-02T08:30:00.000Z" })], null)).toBe(false);
  });

  it("la marca al pedirla: asked_at ahora, held_at el de la marca, y lo demás se conserva", () => {
    const evidence = chatbyAskEvidence(
      { outcome: "para_asesora", reason: "direccion_incompleta", checked_at: "2026-11-01T14:20:00.000Z", evidence: { amount_cents: 17800 } },
      NOW,
    );
    expect(evidence).toEqual({ amount_cents: 17800, held_at: "2026-11-01T14:20:00.000Z", asked_at: NOW.toISOString() });
    // Pedirla otra vez no mueve held_at (la marca se relee y su checked_at cambia).
    expect(
      chatbyAskEvidence({ outcome: "para_asesora", reason: "direccion_incompleta", checked_at: "2026-11-02T09:00:00.000Z", evidence }, NOW).held_at,
    ).toBe("2026-11-01T14:20:00.000Z");
    expect(CHATBY_ASK_PURPOSE).toBe("pedir_ubicacion");
  });
});

describe("la relectura: la ubicación primero, la dirección escrita después", () => {
  const INCOMPLETA =
    "Hola equipo Aurela, deseo confirmar mi pedido AUR900226 y pagaré S/ 178.00 en casa.\n" +
    "Faja moldeadora x1\n" +
    "Dirección: Barrio huayco, San Martín, Tarapoto";
  const ORDER_INC = { address: "Barrio huayco", reference: null, district: "Tarapoto", province: "San Martin", region: "San Martín" };
  const watch = (messages: ChatbyMessage[], order = ORDER_INC) =>
    chatbyReaskWatch({ messages, orderName: "#AUR900226", orderCreatedAt: CREATED, totalAmount: 178, order });
  const confirma = (text = INCOMPLETA) => msg({ text, at: "2026-11-01T14:10:00.000Z" });
  const pide = () => msg({ kind: "equipo", text: "¿nos compartes tu ubicación actual?", at: "2026-11-02T08:00:00.000Z" });

  it("la ubicación que manda la clienta (leída como siempre de Chatby) confirma, con pin", () => {
    const c = confirma();
    const shared = mapChatbyMessages({
      data: [{ id: "loc1", type: "in", msg_type: "location", payload: { latitude: PIN.lat, longitude: PIN.lng }, ts: 1_793_608_200 }],
    });
    expect(shared[0]!.location).toEqual(PIN);
    expect(watch([c, pide(), ...shared])).toEqual({ kind: "confirm", messageId: c.id, at: c.at, amountCents: 17800, pin: true });
    // «ya te mando» antes de la ubicación no la anula: lo último es su ubicación.
    expect(watch([c, pide(), msg({ text: "ya le mando", at: "2026-11-02T08:20:00.000Z" }), msg({ location: PIN, at: "2026-11-02T08:21:00.000Z" })]).kind).toBe("confirm");
  });

  it("un enlace de Maps con la coordenada también es su ubicación; una fuera del Perú, no", () => {
    const c = confirma();
    const maps = msg({ text: "https://maps.google.com/?q=-6.4875,-76.3653", at: "2026-11-02T08:30:00.000Z" });
    const parsed = mapChatbyMessages({ data: [{ id: "t1", type: "in", msg_type: "text", content: maps.text, ts: 1_793_608_200 }] });
    expect(parsed[0]!.location).toEqual(PIN);
    expect(watch([c, pide(), ...parsed]).kind).toBe("confirm");
    const lejos = mapChatbyMessages({
      data: [{ id: "loc2", type: "in", msg_type: "location", payload: { latitude: 40.4, longitude: -3.7 }, ts: 1_793_608_200 }],
    });
    expect(lejos[0]!.location).toBeNull();
    expect(watch([c, pide(), ...lejos]).kind).toBe("wait");
  });

  it("con la ubicación, lo demás tiene que cuadrar como hoy: otra dirección en el mensaje queda para la asesora", () => {
    const otra = confirma(INCOMPLETA.replace("Barrio huayco", "Barrio Suchiche"));
    expect(watch([otra, pide(), msg({ location: PIN, at: "2026-11-02T08:30:00.000Z" })])).toEqual({ kind: "hold", reason: "direccion_distinta" });
  });

  it("una ubicación del bot o del equipo no cuenta", () => {
    expect(watch([confirma(), msg({ kind: "equipo", location: PIN, at: "2026-11-02T08:30:00.000Z" })]).kind).toBe("wait");
  });

  it("una dirección escrita: completa y la del pedido, confirma (sin pin); si no, espera", () => {
    const ORDER_OK = { ...ORDER_INC, address: "Jr huallaga 765 barrio huayco" };
    const sinNumero = confirma(INCOMPLETA.replace("Barrio huayco", "Jr huallaga barrio huayco"));
    const corrige = msg({ text: "Jr huallaga 765 barrio huayco, Tarapoto", at: "2026-11-02T08:30:00.000Z" });
    expect(watch([sinNumero, pide(), corrige], ORDER_OK)).toEqual({
      kind: "confirm",
      messageId: sinNumero.id,
      at: sinNumero.at,
      amountCents: 17800,
      pin: false,
    });
    expect(watch([sinNumero, pide(), corrige, msg({ text: "gracias 🙏", at: "2026-11-02T08:31:00.000Z" })], ORDER_OK).kind).toBe("confirm");
    // Otra dirección que la del pedido: no confirma, espera (puede mandar la ubicación).
    expect(watch([sinNumero, pide(), msg({ text: "Jr Lima 120, Tarapoto", at: "2026-11-02T08:30:00.000Z" })], ORDER_OK).kind).toBe("wait");
    // La del pedido también incompleta: la escrita no alcanza.
    expect(watch([confirma(), pide(), msg({ text: "Jr huallaga 765 barrio huayco, Tarapoto", at: "2026-11-02T08:30:00.000Z" })]).kind).toBe("wait");
  });

  it("un «no lo quiero» lo deja para la asesora", () => {
    expect(watch([confirma(), pide(), msg({ text: "ya no lo deseo, quiero anular", at: "2026-11-02T08:30:00.000Z" })])).toEqual({
      kind: "hold",
      reason: "rechazo",
    });
  });

  it("con la dirección completa (sin_ubicacion…): la evaluación de siempre de la pasada de la ubicación", () => {
    const COMPLETA = INCOMPLETA.replace("Barrio huayco", "Jr huallaga 765 barrio huayco");
    const order = { ...ORDER_INC, address: "Jr huallaga 765 barrio huayco" };
    const c = confirma(COMPLETA);
    expect(watch([c, pide(), msg({ location: PIN, at: "2026-11-02T08:30:00.000Z" })], order)).toEqual({
      kind: "confirm",
      messageId: c.id,
      at: c.at,
      amountCents: 17800,
      pin: false,
    });
    expect(watch([c, pide(), msg({ text: "¿puede ser el lunes?", at: "2026-11-02T08:30:00.000Z" })], order).kind).toBe("wait");
  });

  it("la nota de la confirmación dice que va con su ubicación", () => {
    expect(chatbyConfirmationNote({ orderName: "#AUR900226", at: null, amountCents: 17800, location: true })).toContain(
      "su ubicación de WhatsApp (la dirección escrita estaba incompleta)",
    );
    expect(chatbyConfirmationNote({ orderName: "#AUR900226", at: null, amountCents: 17800 })).toMatch(/y la dirección del pedido\.$/);
  });
});

describe("el servidor y la ficha", () => {
  const server = read("lib/chatby-autoconfirm-server.ts");
  const actions = read("app/dashboard/pedidos/actions.ts");
  const panel = read("components/order-chatby-panel.tsx");

  it("la pasada de la ubicación lee a los que se les pidió, dentro de su tope y su ventana", () => {
    expect(server).toContain('.in("reason", ["direccion_incompleta", "sin_ubicacion_cerrado"])');
    expect(server).toContain('.not("evidence->>asked_at", "is", null)');
    expect(server).toContain(".filter((r) => chatbyHeldWatchDue(r, now, settings))");
    // El mismo tope de la pasada de la ubicación (watchLimit), sin otra pasada.
    expect(server.match(/\.limit\(limit\)/g)?.length).toBe(3);
    // Pasadas las 72 h, solo si la clienta escribió hace menos de 24 h (owner, 08-11-2026; 0318).
    expect(server).toContain('const pastOrderWindow = r.kind !== "confirmado" && !inWindow;');
    expect(server).toContain("if (pastOrderWindow && !chatbyHeldInWindow(");
  });

  it("sin mensaje nuevo de la clienta no evalúa; con su ubicación, la guía va con ESA ubicación", () => {
    const gate = server.indexOf("chatbyNewCustomerMessage(messages, chatbyHeldAt(");
    const evaluate = server.indexOf("chatbyReaskWatch({");
    expect(gate).toBeGreaterThan(0);
    expect(evaluate).toBeGreaterThan(gate);
    expect(server).toContain("tryChatbyGuide(guide, master, messages, { forcePin: verdict.pin })");
    expect(server).toMatch(/if \(opts\.forcePin\) \{[\s\S]*?chatbyGuidePin\(messages, row\.order_created_at\)/);
    // Con la ubicación pasa igual por la cotización con el pin respaldado.
    expect(server).toContain("preview.pinSinCorroborar");
  });

  it("la ficha manda por el mismo envío, marca la pedida y deja el hecho chatby_message", () => {
    expect(panel).toContain("sendOrderChatbyReply(orderId, text, { purpose: CHATBY_ASK_PURPOSE })");
    expect(panel).toContain("Pedir ubicación por WhatsApp");
    expect(panel).toContain('<Banner tone="warn" title={chatbyAskTitle(hold.reason, hold.google)}');
    expect(actions).toContain("const askedFor = await markChatbyLocationAsked(admin, ctx.row)");
    expect(actions).toContain('kind: "chatby_message"');
    expect(actions).toContain("purpose: CHATBY_ASK_PURPOSE");
    // La ventana de 24 h se vuelve a comprobar en el servidor antes de mandar.
    expect(actions.indexOf("chatbyReplyWindow(conversation.messages).open")).toBeLessThan(actions.indexOf("markChatbyLocationAsked(admin, ctx.row)"));
  });
});
