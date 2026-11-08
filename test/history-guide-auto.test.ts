import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  HISTORY_GUIDE_EVENT,
  addressMatchKey,
  evaluateHistoryGuide,
  historyGuideCandidate,
  historyGuideConfirmation,
  historyGuideConfirmationSuffix,
  historyGuideCoordinateNote,
  historyGuideEvidence,
  historyGuideFactNote,
  historyGuideFactReason,
  historyGuideModeFrom,
  historyGuideReason,
  sameAddress,
  sameDestination,
  type HistoryPrior,
} from "@/lib/history-guide-auto";
import { DEFAULT_CHATBY_AUTO_SETTINGS, chatbyAutoSettingsFrom } from "@/lib/chatby-autoconfirm";
import type { ChatbyMessage } from "@/lib/chatby-conversation";
import { AUTOMATIONS, CHATBY_HISTORY_KEY, isWhitelisted } from "@/lib/automations-catalog";
import { guideCreatorPhrase } from "@/lib/guide-note";
import { timelineFact } from "@/lib/order-timeline-fact";

const read = (path: string) => readFileSync(join(__dirname, "..", path), "utf8");

// #KP204102 y sus tres entregados (datos reales, 08-11-2026).
const ORDER = {
  address: "Los cerezos Mz i L 5 urb Arboleda",
  district: "Trujillo",
  province: "Trujillo",
  payment_state: null,
};

const delivered = (over: Partial<HistoryPrior>): HistoryPrior => ({
  order_id: "x",
  order_name: "#KP0",
  order_created_at: "2026-07-22T12:57:02Z",
  general_status: "entregado",
  macro_stage: "por_cerrar",
  order_total: 149,
  guide_code: "AUR5X1",
  dispatched_at: "2026-07-23T12:00:00Z",
  attempt_count: 0,
  address: "Los cerezos mz i l 5 Arboleda",
  district: "Trujillo",
  province: "Trujillo",
  latitude: -8.12978395668635,
  longitude: -79.0341590214583,
  geo_source: "courier",
  delivered_at: "2026-08-01T01:30:47Z",
  ...over,
});

const KP123812 = delivered({ order_id: "a", order_name: "#KP123812" });
const KP136346 = delivered({
  order_id: "b",
  order_name: "#KP136346",
  order_created_at: "2026-09-24T12:40:27Z",
  address: "Los cerezos M i L 5 Arboleda",
  latitude: -8.129784,
  longitude: -79.034159,
  delivered_at: "2026-09-28T19:23:01Z",
});
const KP140751 = delivered({
  order_id: "c",
  order_name: "#KP140751",
  order_created_at: "2026-10-12T08:10:42Z",
  address: "Los cerezos  mz i l 5 Arboleda",
  latitude: -8.1292757,
  longitude: -79.0344804,
  delivered_at: "2026-10-17T16:56:24Z",
});
const HISTORY = [KP140751, KP136346, KP123812];

describe("la dirección: la misma casa escrita de otra forma", () => {
  it("«Mz i L 5», «mz i l 5» y «M i L 5» son lo mismo, y «urb» no cuenta", () => {
    const key = ["cerezos", "mz", "i", "lt", "5", "arboleda"];
    expect(addressMatchKey("Los cerezos Mz i L 5 urb Arboleda")).toEqual(key);
    expect(addressMatchKey("Los cerezos mz i l 5 Arboleda")).toEqual(key);
    expect(addressMatchKey("Los cerezos M i L 5 Arboleda")).toEqual(key);
    expect(addressMatchKey("LOS CEREZOS MZ. I LT. 5, URB. ARBOLEDA")).toEqual(key);
    expect(addressMatchKey("Los Cerezos Manzana I Lote 5 Urbanización Arboleda")).toEqual(key);
    expect(addressMatchKey("Los cerezos Mza i Lt 5 Arboleda")).toEqual(key);
  });

  it("la manzana o el lote pegados a su código, y letras y cifras pegadas", () => {
    expect(addressMatchKey("Los cerezos mzi l5 Arboleda")).toEqual(["cerezos", "mz", "i", "lt", "5", "arboleda"]);
    expect(addressMatchKey("Calle Lima lt12")).toEqual(["lima", "lt", "12"]);
    expect(addressMatchKey("Mza12 Lote3")).toEqual(["mz", "12", "lt", "3"]);
    expect(addressMatchKey("lima")).toEqual(["lima"]);
    expect(addressMatchKey("mza")).toEqual(["mz"]);
    expect(sameAddress("Jr. los geranios A1", "Jr. geranios A 1")).toBe(true);
    expect(sameAddress("Urb TTio c3_2", "Urb.TTio C3-2")).toBe(true);
    expect(sameAddress("Viva el Perú ll 21comite comité 5", "Viva el Perú ll 21comite 5")).toBe(false);
  });

  it("los ceros a la izquierda no cuentan (#AUR900480 y su entrega #KP201632, réplica del 08-11-2026)", () => {
    expect(sameAddress("Calle alameda del sol mz. A lote 3", "Calle alameda del sol mz. A lote 03")).toBe(true);
    expect(addressMatchKey("Jr Lima 0")).toEqual(["jr", "lima", "0"]);
    expect(sameAddress("Jr Lima 105", "Jr Lima 15")).toBe(false);
  });

  it("tildes, puntuación, «N°» y las formas de jirón y avenida", () => {
    expect(sameAddress("Jirón Huallaga N° 765", "jr huallaga 765")).toBe(true);
    expect(sameAddress("Avenida Perú #123", "av peru 123")).toBe(true);
    expect(sameAddress("Av. Grau 123", "Jr. Grau 123")).toBe(false);
  });

  it("otra casa no es la misma: otro lote, otra manzana, otra calle o el orden cambiado", () => {
    expect(sameAddress(ORDER.address, "Los cerezos mz i l 6 Arboleda")).toBe(false);
    expect(sameAddress(ORDER.address, "Los cerezos mz j l 5 Arboleda")).toBe(false);
    expect(sameAddress(ORDER.address, "Los pinos mz i l 5 Arboleda")).toBe(false);
    expect(sameAddress(ORDER.address, "Los cerezos mz 5 l i Arboleda")).toBe(false);
    expect(sameAddress("", "")).toBe(false);
    expect(sameAddress(null, "Los cerezos")).toBe(false);
  });

  it("el destino: mismo distrito y provincia", () => {
    expect(sameDestination(ORDER, { district: "TRUJILLO", province: "Trujillo" })).toBe(true);
    expect(sameDestination(ORDER, { district: "Víctor Larco Herrera", province: "Trujillo" })).toBe(false);
    expect(sameDestination({ district: null }, { district: null })).toBe(false);
  });
});

describe("quién califica", () => {
  it("#KP204102: 3 entregados, ningún fallido, la misma casa → GPS de #KP140751 (el entregado más reciente)", () => {
    const v = evaluateHistoryGuide({ order: ORDER, priors: HISTORY, doorRejections: 0 });
    expect(v).toEqual({
      ok: true,
      delivered: 3,
      source: { orderId: "c", orderName: "#KP140751", deliveredAt: "2026-10-17T16:56:24Z" },
      coordinate: "-8.1292757, -79.0344804",
    });
  });

  it("el más reciente por entrega, sin importar el orden de la lista", () => {
    const v = historyGuideCandidate({ order: ORDER, priors: [KP123812, KP140751, KP136346] });
    expect(v.ok && v.source.orderName).toBe("#KP140751");
  });

  it("sin entregados no califica", () => {
    expect(historyGuideCandidate({ order: ORDER, priors: [delivered({ general_status: "pendiente" })] })).toMatchObject({
      ok: false,
      reason: "sin_entregas",
    });
    expect(historyGuideCandidate({ order: ORDER, priors: [] })).toMatchObject({ ok: false, reason: "sin_entregas" });
  });

  it("un devuelto o un anulado después de salir lo dejan como hoy, aunque tenga entregados", () => {
    const devuelto = delivered({ order_id: "d", general_status: "devuelto" });
    expect(historyGuideCandidate({ order: ORDER, priors: [...HISTORY, devuelto] })).toMatchObject({ ok: false, reason: "con_fallidos", failed: 1 });
    const anuladoEnCalle = delivered({ order_id: "e", general_status: "anulado", dispatched_at: "2026-10-01T00:00:00Z" });
    expect(historyGuideCandidate({ order: ORDER, priors: [...HISTORY, anuladoEnCalle] })).toMatchObject({ ok: false, reason: "con_fallidos" });
  });

  it("un «No entregado» cuenta aunque ese pedido se haya entregado después", () => {
    const conIntento = { ...KP136346, attempt_count: 1 };
    expect(historyGuideCandidate({ order: ORDER, priors: [KP140751, conIntento, KP123812] })).toMatchObject({
      ok: false,
      reason: "intento_fallido",
    });
  });

  it("otro pedido que salió y sigue sin entregarse también frena; uno que no salió, no", () => {
    const enCurso = delivered({ order_id: "r", general_status: "en_proceso", dispatched_at: "2026-10-20T20:59:08Z", delivered_at: null });
    expect(historyGuideCandidate({ order: ORDER, priors: [...HISTORY, enCurso] })).toMatchObject({ ok: false, reason: "despacho_en_curso" });
    const porConfirmar = delivered({ order_id: "s", general_status: "pendiente", dispatched_at: null, delivered_at: null });
    expect(historyGuideCandidate({ order: ORDER, priors: [...HISTORY, porConfirmar] }).ok).toBe(true);
  });

  it("un anulado que nunca salió no es un fallo (§8.6); dos exigen adelanto (§8) y no se intenta", () => {
    const anulado = (id: string) => delivered({ order_id: id, general_status: "anulado", dispatched_at: null, guide_code: null });
    expect(historyGuideCandidate({ order: ORDER, priors: [...HISTORY, anulado("f")] }).ok).toBe(true);
    expect(historyGuideCandidate({ order: ORDER, priors: [...HISTORY, anulado("g"), anulado("h")] })).toMatchObject({
      ok: false,
      reason: "adelanto_exigido",
    });
  });

  it("un rechazo en la puerta lo deja como hoy; no poder leer las guías, también", () => {
    expect(evaluateHistoryGuide({ order: ORDER, priors: HISTORY, doorRejections: 1 })).toMatchObject({ ok: false, reason: "rechazo_en_puerta" });
    expect(evaluateHistoryGuide({ order: ORDER, priors: HISTORY, doorRejections: null })).toMatchObject({ ok: false, reason: "historial_sin_leer" });
  });

  it("otra dirección, o la misma en otro distrito, no es la misma casa", () => {
    expect(historyGuideCandidate({ order: { ...ORDER, address: "Av. España 1234" }, priors: HISTORY })).toMatchObject({
      ok: false,
      reason: "direccion_distinta",
      delivered: 3,
    });
    expect(historyGuideCandidate({ order: { ...ORDER, district: "La Esperanza" }, priors: HISTORY })).toMatchObject({
      ok: false,
      reason: "direccion_distinta",
    });
  });

  it("solo el GPS de la guía (`geo_source = courier`): uno manual, de Shopify o vacío no vale", () => {
    for (const over of [{ geo_source: "shopify" }, { latitude: null, longitude: null }, { latitude: 0, longitude: 0 }]) {
      expect(historyGuideCandidate({ order: ORDER, priors: [delivered(over)] })).toMatchObject({ ok: false, reason: "sin_gps" });
    }
    // Si el más reciente no tiene GPS de su guía, vale el anterior que sí.
    const v = historyGuideCandidate({ order: ORDER, priors: [{ ...KP140751, geo_source: "manual" }, KP136346] });
    expect(v.ok && v.source.orderName).toBe("#KP136346");
  });

  it("un entregado en otra dirección no presta su GPS", () => {
    const otraCasa = delivered({ order_id: "z", order_name: "#KP9", address: "Jr Pizarro 500", delivered_at: "2026-11-01T00:00:00Z" });
    const v = historyGuideCandidate({ order: ORDER, priors: [otraCasa, KP123812] });
    expect(v.ok && v.source.orderName).toBe("#KP123812");
    expect(v.ok && v.delivered).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// La confirmación de Chatby con la dirección incompleta
// ---------------------------------------------------------------------------

const CREATED = "2026-11-08T14:00:00.000Z";
let seq = 0;
function msg(over: Partial<ChatbyMessage> = {}): ChatbyMessage {
  seq++;
  return {
    id: `m${seq}`,
    kind: "cliente",
    at: "2026-11-08T14:10:00.000Z",
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
const INCOMPLETE = { address: "Jr huallaga barrio huayco", reference: null, district: "Tarapoto", province: "San Martín", region: "San Martín" };
const confirmText = (addr: string, amount = "178.00") =>
  `Hola equipo Aurela, deseo confirmar mi pedido AUR900226 y pagaré S/ ${amount} en casa. Dirección: ${addr}`;
const input = (messages: ChatbyMessage[], order = INCOMPLETE) => ({
  messages,
  orderName: "#AUR900226",
  orderCreatedAt: CREATED,
  totalAmount: 178,
  order,
});

describe("la confirmación de Chatby con la dirección incompleta", () => {
  it("confirmó el pedido, el monto, pagar en casa y la dirección del pedido: vale", () => {
    const m = msg({ text: confirmText("Jr huallaga barrio huayco, San Martín, Tarapoto") });
    expect(historyGuideConfirmation(input([m, msg({ text: "gracias 🙏", at: "2026-11-08T14:11:00.000Z" })]))).toEqual({
      messageId: m.id,
      at: m.at,
      amountCents: 17800,
    });
  });

  it("otro monto, otra dirección o algo escrito después: no vale (es de la asesora como hoy)", () => {
    expect(historyGuideConfirmation(input([msg({ text: confirmText("Jr huallaga barrio huayco, San Martín, Tarapoto", "150.00") })]))).toBeNull();
    expect(historyGuideConfirmation(input([msg({ text: confirmText("Jr lima barrio huayco, San Martín, Tarapoto") })]))).toBeNull();
    expect(
      historyGuideConfirmation(
        input([
          msg({ text: confirmText("Jr huallaga barrio huayco, San Martín, Tarapoto") }),
          msg({ text: "¿puede ser el lunes?", at: "2026-11-08T14:12:00.000Z" }),
        ]),
      ),
    ).toBeNull();
  });

  it("sin mensaje de confirmación, o con la dirección completa, no es su caso", () => {
    expect(historyGuideConfirmation(input([msg({ text: "hola" })]))).toBeNull();
    const complete = { ...INCOMPLETE, address: "Jr huallaga 765 barrio huayco" };
    expect(historyGuideConfirmation(input([msg({ text: confirmText("Jr huallaga 765 barrio huayco, San Martín, Tarapoto") })], complete))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// El interruptor, el panel y la migración
// ---------------------------------------------------------------------------

describe("el interruptor: Apagado / Simulación / Activo", () => {
  it("nace Apagado; sin la columna (0317 sin aplicar) o con un valor raro, Apagado", () => {
    expect(DEFAULT_CHATBY_AUTO_SETTINGS.history_guide_mode).toBe("apagado");
    expect(historyGuideModeFrom(undefined)).toBe("apagado");
    expect(historyGuideModeFrom("encendido")).toBe("apagado");
    expect(historyGuideModeFrom("simulacion")).toBe("simulacion");
    expect(chatbyAutoSettingsFrom({ org_id: "o", enabled: true })?.history_guide_mode).toBe("apagado");
    expect(chatbyAutoSettingsFrom({ org_id: "o", enabled: true, history_guide_mode: "activo" })?.history_guide_mode).toBe("activo");
  });

  it("la migración: solo la columna, que nace apagada con sus tres valores", () => {
    const sql = read("db/migrations/0317_history_guide_auto.sql");
    expect(sql).toContain("add column if not exists history_guide_mode text not null default 'apagado'");
    expect(sql).toContain("check (history_guide_mode in ('apagado', 'simulacion', 'activo'))");
    expect(sql).not.toMatch(/alter table public\.chatby_auto_checks/);
    expect(read("scripts/verify-db.sh")).toContain("scripts/sql/history_guide_auto_smoke.sql");
  });

  it("DEPLOY: la entrada va primero, la migración no se aplica sola y nace Apagado", () => {
    const deploy = read("DEPLOY.md");
    const first = deploy.indexOf("\n### ");
    const body = deploy.slice(first, deploy.indexOf("\n### ", first + 10));
    expect(body).toContain("guía automática para clientas con entregas (0317");
    expect(body).toContain('psql "$DATABASE_URL" -f db/migrations/0317_history_guide_auto.sql');
    expect(body).toContain("**Apagado**");
  });

  it("el MOM lo dice en §6.1 y en §40", () => {
    const mom = read("docs/mom/master-pedidos-v1.md");
    expect(mom).toContain("- **Guía automática para clientas con entregas** (owner, 08-11-2026; 0317;");
    expect(mom).toContain("clave `chatby_auto_history`");
    expect(mom).toContain("`0316_chatby_approx_location.sql`, `0317_history_guide_auto.sql` y");
  });

  it("el panel: en «Confirmación», de tres posiciones, fuera de la lista blanca, con su acción", () => {
    const entry = AUTOMATIONS.find((e) => e.key === CHATBY_HISTORY_KEY)!;
    expect(CHATBY_HISTORY_KEY).toBe("chatby_auto_history");
    expect(entry.name).toBe("Guía automática para clientas con entregas");
    expect(entry.group).toBe("confirmacion");
    expect(entry.control).toEqual({ kind: "org_mode", table: "chatby_auto_settings", column: "history_guide_mode" });
    expect(isWhitelisted("chatby_auto_settings", "history_guide_mode")).toBe(false);
    // Va antes de pedir sola la dirección, como en la pasada.
    const keys = AUTOMATIONS.filter((e) => e.group === "confirmacion").map((e) => e.key);
    expect(keys.indexOf(CHATBY_HISTORY_KEY)).toBeGreaterThan(keys.indexOf("chatby_auto_ask"));
    const panel = read("components/automations-panel.tsx");
    expect(panel).toContain("save={setChatbyHistoryMode}");
    const actions = read("app/dashboard/automatizaciones/actions.ts");
    expect(actions).toContain("export async function setChatbyHistoryMode(");
    expect(actions).toContain("Falta la migración 0317");
  });
});

describe("la pasada: la regla va antes de pedirle la dirección o la ubicación", () => {
  const server = read("lib/chatby-autoconfirm-server.ts");
  const confirmPass = server.slice(server.indexOf("async function confirmPass("), server.indexOf("async function confirmWithGuide("));

  it("dirección incompleta: la regla antes de dejarla a la asesora y de pedirle la dirección", () => {
    const rule = confirmPass.indexOf('holdReason: "direccion_incompleta", item');
    const hold = confirmPass.indexOf("await holdForAdvisor(admin, key, item, { reason: verdict.reason");
    const ask = confirmPass.indexOf('kind: chatbyAutoAskKindFor({ reason: "direccion_incompleta", ask })');
    expect(rule).toBeGreaterThan(0);
    expect(hold).toBeGreaterThan(rule);
    expect(ask).toBeGreaterThan(hold);
  });

  it("Google no la ubica: la regla después de la guía de siempre y antes de pedirle la ubicación", () => {
    const first = confirmPass.indexOf("let g = await tryChatbyGuide(guide, master, conversation.messages");
    const rule = confirmPass.indexOf('holdReason: "sin_ubicacion", item');
    const ask = confirmPass.indexOf('kind: "ubicacion",');
    expect(first).toBeGreaterThan(0);
    expect(rule).toBeGreaterThan(first);
    expect(ask).toBeGreaterThan(rule);
    // También en la relectura de cada 30 minutos y después de una respuesta.
    const watch = server.slice(server.indexOf("async function watchPass("), server.indexOf("async function reaskWatch("));
    expect(watch.indexOf("historyGuideCheck(")).toBeLessThan(watch.indexOf("await autoAsk("));
    const outcome = server.slice(server.indexOf("async function guideOutcome("), server.indexOf("async function correctAddress("));
    expect(outcome.indexOf("historyGuideCheck(")).toBeLessThan(outcome.indexOf("await autoAsk("));
  });

  it("la guía va por el camino de `forcePin`: el GPS del historial, con las mismas rejas y el mismo tope", () => {
    expect(server).toContain("coordinate = opts.history.verdict.coordinate;");
    expect(server).toContain("gpsFrom: opts.history.verdict.source.orderName,");
    expect(server).toContain("await recordHistoryGuideFact(admin, row, result.orderNumber ?? null, opts.history);");
    // Simulación y Apagado no crean nada: solo Activo devuelve con qué crear la guía.
    const check = server.slice(server.indexOf("async function historyGuideCheck("));
    expect(check).toContain('if (mode === "apagado") return { evidence: null, use: null };');
    expect(check.indexOf('if (mode === "simulacion")')).toBeLessThan(check.indexOf("use: { verdict, holdReason: h.holdReason }"));
  });
});

describe("lo que se escribe", () => {
  const v = { delivered: 3, source: { orderName: "#KP140751" } };
  it("la guía, el hecho de la línea de tiempo y la confirmación nombran el pedido del GPS", () => {
    expect(historyGuideReason("#KP204102", v)).toBe(
      "Guía automática: #KP204102 confirmó por Chatby; GPS de la entrega de #KP140751 (historial de entregas).",
    );
    expect(historyGuideCoordinateNote(v)).toBe("coordenada: GPS de la entrega de #KP140751 (historial de entregas)");
    expect(historyGuideFactReason(v)).toBe("Guía creada con el GPS de la entrega de #KP140751.");
    expect(historyGuideFactNote("sin_ubicacion", v)).toBe(
      "La clienta confirmó por Chatby y Google no ubica la dirección y la clienta no mandó su ubicación, pero ya recibió en esta misma dirección " +
        "(3 entregados, ningún fallido): Kapta creó la guía Aliclik con el GPS de la entrega de #KP140751.",
    );
    expect(historyGuideConfirmationSuffix({ delivered: 1, source: { orderName: "#KP1" } })).toBe(
      " La guía va con el GPS de la entrega de #KP1: la clienta ya recibió en esta dirección (1 entregado, ningún fallido).",
    );
  });

  it("la nota del lead (la ficha) y el hecho en la Actividad", () => {
    expect(guideCreatorPhrase(null, "confirmado_chatby", "#KP140751")).toBe(
      "automáticamente (confirmó por Chatby · GPS de la entrega de #KP140751)",
    );
    expect(guideCreatorPhrase(null, "confirmado_chatby")).toBe("automáticamente (confirmó por Chatby)");
    expect(HISTORY_GUIDE_EVENT).toBe("chatby_history_guide");
    expect(timelineFact({ kind: HISTORY_GUIDE_EVENT, newStatus: null, origin: "master" })).toEqual({ icon: "ubicacion", stage: null });
    expect(read("components/order-master-shared.tsx")).toContain('chatby_history_guide: "Guía con el GPS de una entrega anterior"');
  });

  it("la evidencia de la marca: el pedido y los números, ni direcciones ni celulares", () => {
    const at = new Date("2026-11-08T15:00:00.000Z");
    const ok = evaluateHistoryGuide({ order: ORDER, priors: HISTORY, doorRejections: 0 });
    expect(historyGuideEvidence("simulacion", "sin_ubicacion", ok, at)).toEqual({
      policy: "historial-entregas-v1",
      mode: "simulacion",
      hold_reason: "sin_ubicacion",
      at: at.toISOString(),
      delivered: 3,
      outcome: "habria_usado",
      source_order_id: "c",
      source_order_name: "#KP140751",
    });
    const no = historyGuideCandidate({ order: { ...ORDER, address: "Av. España 1234" }, priors: HISTORY });
    expect(historyGuideEvidence("activo", "direccion_incompleta", no, at)).toMatchObject({ outcome: "no_califica", reason: "direccion_distinta" });
  });
});
