// Confirmación automática por Chatby y guía Aliclik con tope diario (MOM §6.1,
// «Confirmó por Chatby», decisión del owner del 01-11-2026). Las reglas puras
// (lib/chatby-autoconfirm.ts) y lo que el servidor, el cron y la migración
// tienen que respetar.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { ChatbyMessage } from "@/lib/chatby-conversation";
import {
  CHATBY_HOLD_REASONS,
  DEFAULT_CHATBY_AUTO_SETTINGS,
  addressMatchesOrder,
  amountMatchesTotal,
  chatbyAutoSettingsFrom,
  chatbyCheckDue,
  chatbyConfirmationNote,
  chatbyGuideHold,
  chatbyGuideSkip,
  chatbyOperationId,
  chatbyOrderSkip,
  chatbyReadOrder,
  confirmationAmountCents,
  direccionCompleta,
  evaluateChatbyConfirmation,
  guideCapLeft,
  isCourtesy,
  limaDayStartIso,
  messageAddress,
  parseSolesCents,
  saysConfirm,
  saysPayAtHome,
  type ChatbyCandidate,
} from "@/lib/chatby-autoconfirm";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

const CREATED = "2026-11-01T14:00:00.000Z";
const CONFIRMA =
  "Hola equipo Aurela, deseo confirmar mi pedido AUR900226 y pagaré S/ 178.00 en casa.\n" +
  "Faja moldeadora x1\n" +
  "Dirección: Jr huallaga 765 barrio huayco, San Martín, Tarapoto";

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

const ORDER = {
  address: "Jr huallaga 765 barrio huayco",
  reference: null,
  district: "Tarapoto",
  province: "San Martin",
  region: "San Martín",
};

function evaluate(messages: ChatbyMessage[], over: { totalAmount?: number; order?: Partial<typeof ORDER> } = {}) {
  return evaluateChatbyConfirmation({
    messages,
    orderName: "#AUR900226",
    orderCreatedAt: CREATED,
    totalAmount: over.totalAmount ?? 178,
    order: { ...ORDER, ...(over.order ?? {}) },
  });
}

describe("el mensaje de la clienta", () => {
  it("el mensaje del owner confirma", () => {
    const m = msg({ text: CONFIRMA });
    expect(evaluate([msg({ kind: "bot", text: "Hemos recibido tu pedido #AUR900226", at: "2026-11-01T14:01:00Z" }), m])).toEqual({
      confirm: true,
      messageId: m.id,
      at: m.at,
      amountCents: 17800,
    });
  });

  it("con «#» delante del número, también", () => {
    expect(evaluate([msg({ text: CONFIRMA.replace("AUR900226", "#AUR900226") })]).confirm).toBe(true);
  });

  it("solo la clienta: el mismo texto escrito por el bot o por el equipo no confirma", () => {
    expect(evaluate([msg({ kind: "bot", text: CONFIRMA })])).toEqual({ confirm: false, final: false, reason: "sin_confirmacion" });
    expect(evaluate([msg({ kind: "equipo", text: CONFIRMA })])).toEqual({ confirm: false, final: false, reason: "sin_confirmacion" });
  });

  it("tiene que nombrar ESTE pedido: el de otra marca u otro número no cuenta", () => {
    expect(evaluate([msg({ text: CONFIRMA.replace("AUR900226", "KP200123") })]).confirm).toBe(false);
    expect(evaluate([msg({ text: CONFIRMA.replace("AUR900226", "AUR9002261") })]).confirm).toBe(false);
  });

  it("un mensaje de antes del pedido no es su confirmación", () => {
    expect(evaluate([msg({ text: CONFIRMA, at: "2026-10-20T10:00:00Z" })]).confirm).toBe(false);
  });

  it("sin «confirmar», no: un «hola, ¿cuándo llega mi pedido AUR900226?» espera", () => {
    expect(evaluate([msg({ text: "Hola, cuándo llega mi pedido AUR900226? pagaré S/ 178.00 en casa" })])).toEqual({
      confirm: false,
      final: false,
      reason: "sin_confirmacion",
    });
  });

  it("un botón tocado no es el mensaje de confirmación", () => {
    expect(evaluate([msg({ text: CONFIRMA, button: true })]).confirm).toBe(false);
  });

  it("sin pagar en casa o contraentrega, para la asesora", () => {
    const v = evaluate([msg({ text: CONFIRMA.replace(" en casa", " por Yape") })]);
    expect(v).toMatchObject({ confirm: false, final: true, reason: "sin_pago_en_casa" });
  });

  it("el monto: otro total para la asesora, céntimos de redondeo no", () => {
    expect(evaluate([msg({ text: CONFIRMA.replace("178.00", "150.00") })])).toMatchObject({
      final: true,
      reason: "monto_distinto",
      amountCents: 15000,
    });
    expect(evaluate([msg({ text: CONFIRMA })], { totalAmount: 178.5 }).confirm).toBe(true);
    expect(evaluate([msg({ text: CONFIRMA })], { totalAmount: 179 }).confirm).toBe(false);
    expect(evaluate([msg({ text: CONFIRMA.replace("S/ 178.00", "") })])).toMatchObject({ reason: "sin_monto" });
  });

  it("un «no lo quiero» de la clienta pesa más que la confirmación", () => {
    const v = evaluate([msg({ text: CONFIRMA }), msg({ text: "Ya no lo quiero, cancelar mi pedido", at: "2026-11-01T15:00:00Z" })]);
    expect(v).toMatchObject({ confirm: false, final: true, reason: "rechazo" });
    expect(evaluate([msg({ text: "No deseo el pedido AUR900226" })])).toMatchObject({ final: true, reason: "rechazo" });
    expect(evaluate([msg({ text: "Quiero anular mi pedido" })])).toMatchObject({ final: true, reason: "rechazo" });
    // Un «no» que no rechaza no cuenta.
    expect(evaluate([msg({ text: CONFIRMA }), msg({ text: "ok gracias", at: "2026-11-01T15:00:00Z" })]).confirm).toBe(true);
  });

  it("una nota de anulación del equipo, también", () => {
    const v = evaluate([msg({ text: CONFIRMA }), msg({ kind: "nota", text: "PEDIDO ANULADO", at: "2026-11-01T15:00:00Z" })]);
    expect(v).toMatchObject({ final: true, reason: "anulado_en_chat" });
  });

  it("después de confirmar: un «gracias 🙏» o la ubicación no cambian nada; una pregunta sí", () => {
    const later = (over: Partial<ChatbyMessage>) => evaluate([msg({ text: CONFIRMA }), msg({ at: "2026-11-01T14:20:00Z", ...over })]);
    expect(later({ text: "Muchas gracias 🙏" }).confirm).toBe(true);
    expect(later({ text: "Ubicación", location: { lat: -6.48, lng: -76.36 } }).confirm).toBe(true);
    expect(later({ text: "¿Puede llegar el lunes mejor?" })).toMatchObject({ final: true, reason: "mensaje_posterior" });
    expect(later({ text: "", media: "audio" })).toMatchObject({ reason: "mensaje_posterior" });
    // Un mensaje sobre otro pedido de la otra marca no es de este.
    expect(later({ text: "Y mi pedido KP200999 cuándo llega?" }).confirm).toBe(true);
  });
});

describe("la dirección", () => {
  it("lo que sigue a «Dirección:»", () => {
    expect(messageAddress(CONFIRMA)).toBe("Jr huallaga 765 barrio huayco, San Martín, Tarapoto");
    expect(messageAddress("Dirección: Av. Perú 123, Lima. Referencia: frente al parque")).toBe("Av. Perú 123, Lima");
    expect(messageAddress("sin dirección aquí")).toBeNull();
  });

  it("completa: tipo de vía y número, o manzana y lote", () => {
    expect(direccionCompleta("Jr huallaga 765 barrio huayco")).toBe(true);
    expect(direccionCompleta("Av. Los Incas N° 1203")).toBe(true);
    expect(direccionCompleta("Psje. Las Flores 12")).toBe(true);
    expect(direccionCompleta("AA.HH. Villa Sol Mz B Lt 3")).toBe(true);
    expect(direccionCompleta("Huallaga 765")).toBe(false);
    expect(direccionCompleta("Av. Las Torres")).toBe(false);
    expect(direccionCompleta("Av. 31 de Octubre")).toBe(false);
    expect(direccionCompleta("Agencia Shalom Av. Grau 120")).toBe(false);
    expect(direccionCompleta("")).toBe(false);
  });

  it("la del pedido, con su distrito o provincia", () => {
    expect(addressMatchesOrder("Jr huallaga 765 barrio huayco, San Martín, Tarapoto", ORDER)).toEqual({ ok: true });
    expect(addressMatchesOrder("Jr. Huallaga N° 765 Barrio Huayco - Tarapoto", ORDER)).toEqual({ ok: true });
  });

  it("otro número u otra calle es otra dirección", () => {
    expect(addressMatchesOrder("Jr huallaga 999 barrio huayco, San Martín, Tarapoto", ORDER)).toEqual({ ok: false, reason: "direccion_distinta" });
    expect(addressMatchesOrder("Jr ucayali 765 barrio huayco, San Martín, Tarapoto", ORDER)).toEqual({ ok: false, reason: "direccion_distinta" });
  });

  it("otro distrito, o solo el departamento, es otro destino", () => {
    expect(addressMatchesOrder("Jr huallaga 765 barrio huayco, San Martín, Morales", ORDER)).toEqual({ ok: false, reason: "destino_distinto" });
    expect(addressMatchesOrder("Jr huallaga 765 barrio huayco, Moyobamba", ORDER)).toEqual({ ok: false, reason: "destino_distinto" });
    expect(
      addressMatchesOrder("Jr huallaga 765 barrio huayco, La Libertad", { ...ORDER, region: "La Libertad", province: "Trujillo", district: "Trujillo" }),
    ).toEqual({ ok: false, reason: "destino_distinto" });
  });

  it("en el veredicto: la dirección distinta o incompleta queda para la asesora", () => {
    expect(evaluate([msg({ text: CONFIRMA.replace("765", "766") })])).toMatchObject({ final: true, reason: "direccion_distinta" });
    expect(evaluate([msg({ text: CONFIRMA })], { order: { address: "Huallaga 765" } })).toMatchObject({ reason: "direccion_incompleta" });
    expect(evaluate([msg({ text: CONFIRMA.split("\nDirección")[0]! })])).toMatchObject({ reason: "sin_direccion" });
    expect(evaluate([msg({ text: CONFIRMA })], { order: { district: "Morales" } })).toMatchObject({ final: true });
  });
});

describe("las piezas del mensaje", () => {
  it("confirmar y pagar en casa", () => {
    expect(saysConfirm("Deseo confirmar mi pedido")).toBe(true);
    expect(saysConfirm("Confirmo")).toBe(true);
    expect(saysConfirm("Hola")).toBe(false);
    expect(saysPayAtHome("pagaré en casa")).toBe(true);
    expect(saysPayAtHome("pago contraentrega")).toBe(true);
    expect(saysPayAtHome("pago contra entrega")).toBe(true);
    expect(saysPayAtHome("pago por Yape")).toBe(false);
  });

  it("los soles, con punto o coma", () => {
    expect(parseSolesCents("178.00")).toBe(17800);
    expect(parseSolesCents("178,00")).toBe(17800);
    expect(parseSolesCents("1,178.00")).toBe(117800);
    expect(parseSolesCents("1.178,50")).toBe(117850);
    expect(parseSolesCents("1,178")).toBe(117800);
    expect(parseSolesCents("178")).toBe(17800);
    expect(parseSolesCents("abc")).toBeNull();
  });

  it("el monto es el que dice que paga, no el precio del producto", () => {
    expect(confirmationAmountCents("Producto S/ 89 x2. Pagaré S/ 178.00 en casa")).toBe(17800);
    expect(confirmationAmountCents("total S/.178")).toBe(17800);
    expect(confirmationAmountCents("sin monto")).toBeNull();
  });

  it("menos de S/ 1 de diferencia es redondeo (lib/payment-rounding.ts)", () => {
    expect(amountMatchesTotal(17800, 178)).toBe(true);
    expect(amountMatchesTotal(17800, 178.99)).toBe(true);
    expect(amountMatchesTotal(17800, 177.01)).toBe(true);
    expect(amountMatchesTotal(17800, 179)).toBe(false);
    expect(amountMatchesTotal(null, 178)).toBe(false);
    expect(amountMatchesTotal(17800, null)).toBe(false);
  });

  it("cortesía", () => {
    expect(isCourtesy("ok gracias")).toBe(true);
    expect(isCourtesy("👍")).toBe(true);
    expect(isCourtesy("Buenas tardes, muchas gracias señorita")).toBe(true);
    expect(isCourtesy("a qué hora llega")).toBe(false);
  });

  it("cada motivo tiene su texto para la línea de tiempo", () => {
    for (const text of Object.values(CHATBY_HOLD_REASONS)) expect(text.length).toBeGreaterThan(10);
  });
});

describe("qué pedido se lee", () => {
  const NOW = new Date("2026-11-01T18:00:00Z");
  const settings = { ...DEFAULT_CHATBY_AUTO_SETTINGS, org_id: "org" };
  const cand = (over: { master?: Partial<ChatbyCandidate["master"]>; order?: Partial<ChatbyCandidate["order"]>; notes?: string[] } = {}): ChatbyCandidate => ({
    master: {
      macro_stage: "por_confirmar",
      macro_substage: "sin_llamar",
      shipping_mode: "cod",
      coverage: "provincia_cod",
      region: "San Martín",
      province: "San Martin",
      district: "Tarapoto",
      address: ORDER.address,
      reference: null,
      payment_state: null,
      customer_phone: "+51987654321",
      ...(over.master ?? {}),
    },
    order: {
      name: "#AUR900226",
      created_at: CREATED,
      cancelled_at: null,
      total_amount: 178,
      total_refunded: 0,
      currency: "PEN",
      shopify_note: null,
      ...(over.order ?? {}),
    },
    contactNotes: over.notes ?? [],
  });

  it("Provincia COD en Por confirmar, sin llamar o por confirmar, de las últimas 72 h", () => {
    expect(chatbyOrderSkip(cand(), settings, NOW)).toBeNull();
    expect(chatbyOrderSkip(cand({ master: { macro_substage: "por_confirmar" } }), settings, NOW)).toBeNull();
  });

  it("Lima y Agencia no", () => {
    expect(chatbyOrderSkip(cand({ master: { coverage: "lima", region: "Lima", province: "Lima" } }), settings, NOW)).toBe("no_provincia_cod");
    expect(chatbyOrderSkip(cand({ master: { coverage: "agencia" } }), settings, NOW)).toBe("no_provincia_cod");
    expect(chatbyOrderSkip(cand({ master: { shipping_mode: "agency" } }), settings, NOW)).toBe("no_provincia_cod");
    expect(chatbyOrderSkip(cand({ master: { address: "Recojo en agencia Shalom" } }), settings, NOW)).toBe("agencia");
  });

  it("con fecha pactada, abono pendiente u otra etapa, no", () => {
    expect(chatbyOrderSkip(cand({ master: { macro_substage: "volver_a_contactar" } }), settings, NOW)).toBe("etapa");
    expect(chatbyOrderSkip(cand({ master: { macro_stage: "preparacion", macro_substage: "por_generar_rotulo" } }), settings, NOW)).toBe("etapa");
  });

  it("anulado, viejo, con pago o con un rechazo anotado, no", () => {
    expect(chatbyOrderSkip(cand({ order: { cancelled_at: "2026-11-01T15:00:00Z" } }), settings, NOW)).toBe("pedido_invalido");
    expect(chatbyOrderSkip(cand({ order: { created_at: "2026-10-28T10:00:00Z" } }), settings, NOW)).toBe("fuera_de_ventana");
    expect(chatbyOrderSkip(cand({ master: { payment_state: "adelanto_cargado" } }), settings, NOW)).toBe("con_pago");
    expect(chatbyOrderSkip(cand({ master: { customer_phone: null } }), settings, NOW)).toBe("sin_celular");
    expect(chatbyOrderSkip(cand({ notes: ["La clienta no desea el pedido"] }), settings, NOW)).toBe("rechazo_registrado");
  });

  it("lo resuelto no se vuelve a leer; lo pendiente, cada `recheck_minutes`", () => {
    expect(chatbyCheckDue(null, NOW, settings)).toBe(true);
    expect(chatbyCheckDue({ outcome: "confirmado", checked_at: "2026-10-01T00:00:00Z" }, NOW, settings)).toBe(false);
    expect(chatbyCheckDue({ outcome: "para_asesora", checked_at: "2026-10-01T00:00:00Z" }, NOW, settings)).toBe(false);
    expect(chatbyCheckDue({ outcome: "sin_confirmacion", checked_at: "2026-11-01T17:45:00Z" }, NOW, settings)).toBe(false);
    expect(chatbyCheckDue({ outcome: "sin_confirmacion", checked_at: "2026-11-01T17:30:00Z" }, NOW, settings)).toBe(true);
    expect(chatbyCheckDue({ outcome: "error", checked_at: "2026-11-01T17:00:00Z" }, NOW, settings)).toBe(true);
  });

  it("primero los que nunca se leyeron (el más nuevo), después el que se leyó hace más", () => {
    const rows = [
      { id: "a", createdAt: "2026-11-01T10:00:00Z", checkedAt: "2026-11-01T17:00:00Z" },
      { id: "b", createdAt: "2026-11-01T09:00:00Z", checkedAt: null },
      { id: "c", createdAt: "2026-11-01T11:00:00Z", checkedAt: null },
      { id: "d", createdAt: "2026-11-01T08:00:00Z", checkedAt: "2026-11-01T16:00:00Z" },
    ];
    expect([...rows].sort(chatbyReadOrder).map((r) => r.id)).toEqual(["c", "b", "d", "a"]);
  });
});

describe("los ajustes", () => {
  it("la fila de la base, con sus rangos", () => {
    expect(chatbyAutoSettingsFrom({ org_id: "o", enabled: true, daily_cap: 20 })).toEqual({ ...DEFAULT_CHATBY_AUTO_SETTINGS, org_id: "o" });
    expect(chatbyAutoSettingsFrom({ org_id: "o", enabled: false })?.enabled).toBe(false);
    expect(chatbyAutoSettingsFrom({ org_id: "o", enabled: true, daily_cap: 5, guide_enabled: false })).toMatchObject({ daily_cap: 5, guide_enabled: false });
    expect(chatbyAutoSettingsFrom({ org_id: "o", enabled: true, daily_cap: -3, max_orders_per_run: 900 })).toMatchObject({ daily_cap: 20, max_orders_per_run: 20 });
    expect(chatbyAutoSettingsFrom({ enabled: true })).toBeNull();
  });

  it("los valores por defecto que pidió el owner: encendido y 20 guías por día", () => {
    expect(DEFAULT_CHATBY_AUTO_SETTINGS.enabled).toBe(true);
    expect(DEFAULT_CHATBY_AUTO_SETTINGS.daily_cap).toBe(20);
    expect(DEFAULT_CHATBY_AUTO_SETTINGS.window_hours).toBe(72);
  });
});

describe("lo que se escribe", () => {
  it("el operation_id es el mismo para el mismo pedido y mensaje: no se duplica", () => {
    const a = chatbyOperationId("11111111-1111-4111-8111-111111111111", "m1");
    expect(a).toBe(chatbyOperationId("11111111-1111-4111-8111-111111111111", "m1"));
    expect(a).not.toBe(chatbyOperationId("11111111-1111-4111-8111-111111111111", "m2"));
    // El formato que acepta la mesa (uuid v4).
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("la nota no copia la dirección ni el nombre", () => {
    const note = chatbyConfirmationNote({ orderName: "#AUR900226", at: "2026-11-01T15:32:00Z", amountCents: 17800 });
    expect(note).toBe("Confirmó por Chatby: mensaje de la clienta del 01-11 a las 10:32 con el pedido #AUR900226, S/ 178.00 contra entrega y la dirección del pedido.");
    expect(note).not.toContain("huallaga");
  });
});

describe("la guía automática", () => {
  const prep = {
    macro_stage: "preparacion",
    macro_substage: "por_generar_rotulo",
    dispatch_scheduled_on: null,
    shipping_mode: "cod",
    coverage: "provincia_cod",
    region: "San Martín",
    province: "San Martin",
    district: "Tarapoto",
  };

  it("Provincia COD en Por generar rótulo, sin fecha programada", () => {
    expect(chatbyGuideSkip(prep)).toBeNull();
    expect(chatbyGuideSkip({ ...prep, macro_stage: "por_confirmar", macro_substage: "por_confirmar" })).toBe("sin_recalcular");
    expect(chatbyGuideSkip({ ...prep, macro_substage: "por_armar" })).toBe("otra_etapa");
    expect(chatbyGuideSkip({ ...prep, coverage: "agencia" })).toBe("no_provincia_cod");
    // Con envío programado, la guía es la del día programado (§6.2).
    expect(chatbyGuideSkip({ ...prep, dispatch_scheduled_on: "2026-11-03" })).toBe("programado");
  });

  it("Shalom elegido o un pago registrado son de una persona (§6.2)", () => {
    expect(chatbyGuideHold({ hasShalomDraft: false, paymentState: null })).toBeNull();
    expect(chatbyGuideHold({ hasShalomDraft: false, paymentState: "sin_pago" })).toBeNull();
    expect(chatbyGuideHold({ hasShalomDraft: true, paymentState: null })).toBe("shalom");
    expect(chatbyGuideHold({ hasShalomDraft: false, paymentState: "adelanto_validado" })).toBe("con_pago");
  });

  it("el tope del día", () => {
    expect(guideCapLeft(0, 20)).toBe(20);
    expect(guideCapLeft(19, 20)).toBe(1);
    expect(guideCapLeft(20, 20)).toBe(0);
    expect(guideCapLeft(25, 20)).toBe(0);
    expect(guideCapLeft(0, 0)).toBe(0);
  });

  it("el día de Lima empieza a medianoche de Lima", () => {
    expect(limaDayStartIso(new Date("2026-11-02T03:00:00Z"))).toBe("2026-11-01T00:00:00-05:00");
    expect(limaDayStartIso(new Date("2026-11-02T06:00:00Z"))).toBe("2026-11-02T00:00:00-05:00");
  });
});

describe("el servidor, el cron y la migración", () => {
  const server = read("lib/chatby-autoconfirm-server.ts");
  const route = read("app/api/cron/chatby-autoconfirm/route.ts");
  const migration = read("db/migrations/0297_chatby_autoconfirm.sql");

  it("confirma por el registro de la mesa, sin actor y con origen chatby", () => {
    expect(server).toContain('admin.rpc("register_confirmation_attempt_v2"');
    expect(server).toContain("p_actor: null");
    expect(server).toContain('p_result: "confirmado"');
    expect(server).toContain('p_channel: "mensaje"');
    expect(server).toContain("p_source: CHATBY_SOURCE");
  });

  it("la guía, por el camino del botón", () => {
    expect(server).toContain("createAliclikGuideFor(");
    expect(server).toContain("previewAliclikGuideFor(");
    expect(server).toContain("activeAliclikBlocker(");
    expect(server).toContain("env.aliclikWriteEnabled()");
    expect(server).toContain("kind: CHATBY_GUIDE_ORIGIN");
  });

  it("Chatby solo se lee: la misma función de la ficha, nada de POST", () => {
    expect(server).toContain("fetchChatbyConversation(");
    expect(server).not.toMatch(/method:\s*"POST"/);
    expect(read("lib/chatby-api.ts")).not.toMatch(/method:\s*"(POST|PUT|PATCH|DELETE)"/);
  });

  it("sin la 0297 no hace nada", () => {
    expect(server).toContain("isMissingTable(error)");
    expect(route).toContain('skipped: "sin_migracion_0297"');
  });

  it("el cron pide CRON_SECRET y no escribe fuera de producción", () => {
    expect(route).toContain("internalAuthorized(req)");
    expect(route).toContain('process.env.VERCEL_ENV !== "production"');
    const cron = JSON.parse(read("vercel.json")) as { crons: { path: string; schedule: string }[] };
    expect(cron.crons.find((c) => c.path === "/api/cron/chatby-autoconfirm")?.schedule).toBe("9,19,29,39,49,59 * * * *");
  });

  it("la migración nace encendida con 20 guías por día, y no para las tiendas cliente (§29.15.1)", () => {
    expect(migration).toContain("enabled            boolean not null default true");
    expect(migration).toContain("daily_cap          integer not null default 20");
    expect(migration).toContain("logistics_service_agreements");
    // No guarda la conversación: ni texto ni dirección.
    expect(migration).not.toMatch(/\b(text_body|message_text|address)\b\s+text/);
  });

  it("el MOM lo cuenta", () => {
    const mom = read("docs/mom/master-pedidos-v1.md").replace(/\s+/g, " ");
    expect(mom).toContain("#### Confirmó por Chatby (decisión del owner, 01-11-2026)");
    expect(mom).toContain("`/api/cron/chatby-autoconfirm`");
    expect(mom).toContain("`chatby_auto_settings`");
  });
});
