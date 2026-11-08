// «Guía automática para clientas con entregas» (MOM §6.1, decisión del owner
// del 08-11-2026; 0317).
//
// POR QUÉ. La clienta confirmó por Chatby y la guía Aliclik no sale sola por la
// dirección: está incompleta (`direccion_incompleta`) o Google no la ubica y
// no mandó su ubicación (`sin_ubicacion`). Pero esa misma clienta (el mismo
// celular) ya recibió en esa misma casa, sin un solo fallido, y la guía de esa
// entrega guardó la coordenada a la que fue el courier. Una asesora la
// confirmaría sin dudar. Caso que lo motivó: #KP204102 («Los cerezos Mz i L 5
// urb Arboleda», Trujillo), con tres entregados por Aliclik en esa dirección.
//
// LA REGLA (owner):
//   1. La clienta confirmó por Chatby (el pedido, confirmar, pagar en casa, el
//      monto, la dirección del mensaje es la del pedido y nada después que no
//      sea cortesía o su ubicación) y la guía no sale por `direccion_incompleta`
//      o `sin_ubicacion`. Nada más: sin un mensaje de confirmación no hay regla.
//   2. Su historial (mismo celular, misma organización) tiene AL MENOS UN
//      entregado y NINGÚN fallido: devuelto, anulado después de salir
//      (`isFailedDispatch`, §8.6), un intento de entrega que no se entregó
//      (`attempt_count`: lo que reportan los couriers y los «No entregado» de
//      nuestros motorizados, también en un pedido que al final sí se entregó),
//      un rechazo en la puerta (`countDoorRejections`, §8.2) ni otro pedido que
//      salió y sigue sin entregarse. Y el adelanto que exige la tabla del §8 no
//      frena la guía (`aliclikRiskGate`).
//   3. La dirección del pedido es la de un ENTREGADO del mismo distrito y
//      provincia (sin mayúsculas, tildes ni puntuación; «M», «Mz», «Mza»,
//      «Manzana» iguales; «L», «Lt», «Lote» iguales; sin palabras de relleno).
//   4. Ese entregado tiene GPS: la coordenada de su guía (`order_master`
//      `latitude/longitude` con `geo_source = 'courier'`, que sale de
//      `shipments.latitude/longitude`). Ojo: Aliclik devuelve en su reporte la
//      coordenada que le mandó Kapta (§6.1, «La prueba»), así que no es el GPS
//      del motorizado: es el punto con el que esa guía SE ENTREGÓ, y la
//      entrega es la prueba de que sirve. Una corrección a mano (`manual`) o
//      lo que geocodificó Shopify no cuentan. Si hay varios, el más reciente.
//   5. Esa coordenada va a la guía nueva por el camino de `forcePin` (como la
//      ubicación de WhatsApp), con todas las rejas de siempre.
//
// Este archivo es PURO. La pasada vive en lib/chatby-autoconfirm-server.ts.

import { dispatchRecord } from "@/lib/aliclik-route-risk";
import {
  addressMatchesOrder,
  evaluateChatbyConfirmation,
  isCourtesy,
  messageAddress,
  saysConfirm,
} from "@/lib/chatby-autoconfirm";
import { aliclikRiskGate, confirmationRisk, summarizeOutcomes, type PriorOrderSnapshot } from "@/lib/order-confirmation-brief";
import { approxModeFrom, type ApproxMode } from "@/lib/geocode-approx";

/** La versión de la regla, en la evidencia de cada marca. */
export const HISTORY_GUIDE_POLICY = "historial-entregas-v1";
/** El hecho de la línea de tiempo (`order_events.kind`). */
export const HISTORY_GUIDE_EVENT = "chatby_history_guide";

/** La posición del interruptor: Apagado / Simulación / Activo, como `approx_mode` y `ask_mode`. */
export type HistoryGuideMode = ApproxMode;

/** `chatby_auto_settings.history_guide_mode` (0317). Sin la columna o con un valor raro: Apagado. */
export function historyGuideModeFrom(value: unknown): HistoryGuideMode {
  return approxModeFrom(value);
}

/** Los motivos por los que la regla se mira: la guía no salió por la dirección. */
export const HISTORY_GUIDE_HOLD_REASONS = ["direccion_incompleta", "sin_ubicacion"] as const;
export type HistoryGuideHoldReason = (typeof HISTORY_GUIDE_HOLD_REASONS)[number];

// ---------------------------------------------------------------------------
// La confirmación de Chatby, con la dirección incompleta
// ---------------------------------------------------------------------------

/**
 * ¿La clienta confirmó y lo ÚNICO que falla es que la dirección está
 * incompleta? Las mismas reglas de `evaluateChatbyConfirmation` después de la
 * completitud: la dirección del mensaje es la del pedido (`addressMatchesOrder`)
 * y después no escribió nada más que cortesía, su ubicación o un botón de
 * confirmar. Null si no es `direccion_incompleta` o si algo más no cuadra.
 */
export function historyGuideConfirmation(
  input: Parameters<typeof evaluateChatbyConfirmation>[0],
): { messageId: string; at: string | null; amountCents: number } | null {
  const v = evaluateChatbyConfirmation(input);
  if (v.confirm || !v.final || v.reason !== "direccion_incompleta" || !v.messageId || v.amountCents == null) return null;
  const message = input.messages.find((m) => m.id === v.messageId);
  if (!message) return null;
  const addr = messageAddress(message.text);
  if (!addr || !addressMatchesOrder(addr, input.order).ok) return null;
  const fromClient = input.messages.filter((m) => m.kind === "cliente");
  const later = fromClient.slice(fromClient.indexOf(message) + 1);
  const changes = later.some((m) => {
    if (m.location) return false;
    if (m.media) return true;
    if (m.button) return !saysConfirm(m.text);
    return !isCourtesy(m.text);
  });
  if (changes) return null;
  return { messageId: message.id, at: message.at, amountCents: v.amountCents };
}

// ---------------------------------------------------------------------------
// La dirección
// ---------------------------------------------------------------------------

const sinTildes = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

/** Palabras que no distinguen una casa de otra: no cuentan al comparar. */
const RELLENO = new Set([
  "n", "nro", "nros", "no", "num", "numero", "de", "del", "la", "las", "el", "los", "y", "e",
  "urb", "urbanizacion", "calle", "cl", "cll",
]);

/** Las formas de escribir lo mismo, a una sola. */
const SINONIMOS: Record<string, string> = {
  m: "mz",
  mz: "mz",
  mza: "mz",
  mzn: "mz",
  manzana: "mz",
  l: "lt",
  lt: "lt",
  lte: "lt",
  lot: "lt",
  lote: "lt",
  av: "av",
  avda: "av",
  avenida: "av",
  jr: "jr",
  jiron: "jr",
  psje: "psje",
  pje: "psje",
  psj: "psje",
  pasaje: "psje",
};

/** «mzi», «mzb»: la manzana pegada a su letra (las cifras ya se separan solas). */
const MANZANA_PEGADA = /^(mz)([a-z])$/;

/**
 * La dirección como lista de palabras comparables, en su orden. «Los cerezos
 * Mz i L 5 urb Arboleda», «Los cerezos mz i l 5 Arboleda» y «Los cerezos M i
 * L 5 Arboleda» dan las tres `cerezos mz i lt 5 arboleda`. Las letras y las
 * cifras pegadas se separan («A1» es «A 1», «lt5» es «lt 5», «c3-2» es «c 3 2»)
 * y los ceros a la izquierda no cuentan («lote 03» es «lote 3»).
 */
export function addressMatchKey(address: string | null | undefined): string[] {
  const words = sinTildes(address ?? "")
    .replace(/n[°º]/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/([a-z])(?=\d)|(\d)(?=[a-z])/g, "$1$2 ")
    .trim()
    .split(" ")
    .filter(Boolean);
  const out: string[] = [];
  for (const raw of words) {
    const glued = SINONIMOS[raw] ? null : MANZANA_PEGADA.exec(raw);
    for (const w of glued ? [glued[1]!, glued[2]!] : [raw]) {
      // «lote 03» es «lote 3» (#AUR900480 y su entrega #KP201632).
      const word = SINONIMOS[w] ?? w.replace(/^0+(?=\d)/, "");
      if (!RELLENO.has(word)) out.push(word);
    }
  }
  return out;
}

/** ¿Las dos direcciones son la misma casa? Mismas palabras, en el mismo orden. */
export function sameAddress(a: string | null | undefined, b: string | null | undefined): boolean {
  const ka = addressMatchKey(a);
  const kb = addressMatchKey(b);
  return ka.length > 0 && ka.length === kb.length && ka.every((w, i) => w === kb[i]);
}

const placeKey = (v: string | null | undefined) => sinTildes(v ?? "").replace(/[^a-z0-9]+/g, "");

/** ¿El mismo distrito y la misma provincia? Sin distrito no se puede decir que sí. */
export function sameDestination(
  a: { district?: string | null; province?: string | null },
  b: { district?: string | null; province?: string | null },
): boolean {
  const da = placeKey(a.district);
  if (!da || da !== placeKey(b.district)) return false;
  const pa = placeKey(a.province);
  const pb = placeKey(b.province);
  return !pa || !pb || pa === pb;
}

// ---------------------------------------------------------------------------
// El veredicto
// ---------------------------------------------------------------------------

/** Un pedido del historial de la clienta, con la ficha del §8 y su destino. */
export interface HistoryPrior extends PriorOrderSnapshot {
  address?: string | null;
  district?: string | null;
  province?: string | null;
  latitude?: number | string | null;
  longitude?: number | string | null;
  geo_source?: string | null;
  delivered_at?: string | null;
}

export type HistoryGuideSkip =
  | "sin_entregas"
  | "con_fallidos"
  | "intento_fallido"
  | "despacho_en_curso"
  | "rechazo_en_puerta"
  | "historial_sin_leer"
  | "adelanto_exigido"
  | "direccion_distinta"
  | "sin_gps";

export const HISTORY_GUIDE_SKIP_LABEL: Record<HistoryGuideSkip, string> = {
  sin_entregas: "La clienta no tiene ningún pedido entregado.",
  con_fallidos: "La clienta tiene un pedido que salió y no se entregó (devuelto o anulado después de salir).",
  intento_fallido: "La clienta tiene un intento de entrega fallido («No entregado»).",
  despacho_en_curso: "La clienta tiene otro pedido que salió y todavía no se entregó.",
  rechazo_en_puerta: "La clienta rechazó un pedido en la puerta.",
  historial_sin_leer: "No se pudieron leer las guías de la clienta.",
  adelanto_exigido: "Los antecedentes de la clienta exigen un adelanto validado antes de Aliclik.",
  direccion_distinta: "La dirección no es la de ningún pedido entregado.",
  sin_gps: "Los entregados en esa dirección no tienen el GPS de su guía.",
};

export interface HistoryGuideSource {
  orderId: string;
  orderName: string | null;
  deliveredAt: string | null;
}

export type HistoryGuideVerdict =
  | {
      ok: true;
      delivered: number;
      /** El entregado del que sale el GPS. */
      source: HistoryGuideSource;
      /** «lat, lng», como la guía la recibe. */
      coordinate: string;
    }
  | { ok: false; reason: HistoryGuideSkip; delivered: number; failed: number };

interface HistoryGuideInput {
  order: {
    address?: string | null;
    district?: string | null;
    province?: string | null;
    payment_state?: string | null;
  };
  /** Los OTROS pedidos del mismo celular en la organización. */
  priors: readonly HistoryPrior[];
}

function coordinateOf(row: HistoryPrior): { lat: number; lng: number } | null {
  if (row.latitude == null || row.longitude == null) return null;
  const lat = Number(row.latitude);
  const lng = Number(row.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || (lat === 0 && lng === 0)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat, lng };
}

const statusOf = (row: HistoryPrior) => (row.general_status ?? "").trim().toLowerCase();

/** Salió (`dispatched_at`) y no está entregado ni cerrado como fallido. */
function inFlight(row: HistoryPrior): boolean {
  const status = statusOf(row);
  return Boolean((row.dispatched_at ?? "").trim()) && status !== "entregado" && status !== "devuelto" && status !== "anulado";
}

const deliveredMs = (row: HistoryPrior) => {
  const at = Date.parse(row.delivered_at ?? row.order_created_at ?? "");
  return Number.isFinite(at) ? at : 0;
};

/**
 * Lo que se decide con el historial del Master: entregas, fallidos, intentos,
 * adelanto exigido, dirección y GPS. Los rechazos en la puerta salen de las
 * guías (`evaluateHistoryGuide`) y solo se leen para los que pasan esto.
 */
export function historyGuideCandidate(input: HistoryGuideInput): HistoryGuideVerdict {
  const record = dispatchRecord(input.priors);
  const no = (reason: HistoryGuideSkip): HistoryGuideVerdict => ({ ok: false, reason, delivered: record.delivered, failed: record.failed });
  if (record.delivered < 1) return no("sin_entregas");
  if (record.failed > 0) return no("con_fallidos");
  // «Cero entregas fallidas» (owner): un «No entregado» cuenta aunque el pedido
  // se haya entregado después.
  if (input.priors.some((p) => (Number(p.attempt_count) || 0) > 0)) return no("intento_fallido");
  if (input.priors.some(inFlight)) return no("despacho_en_curso");
  // La tabla del §8 cuenta todos los anulados (también los que nunca salieron):
  // dos o más exigen un adelanto validado, y la creación lo rechazaría.
  const risk = confirmationRisk(summarizeOutcomes(input.priors), input.priors);
  if (!aliclikRiskGate(risk.requirement, input.order.payment_state).allowed) return no("adelanto_exigido");

  const sameHome = input.priors.filter(
    (p) => statusOf(p) === "entregado" && sameDestination(input.order, p) && sameAddress(input.order.address, p.address),
  );
  if (!sameHome.length) return no("direccion_distinta");
  const best = sameHome
    .filter((p) => p.geo_source === "courier" && coordinateOf(p))
    .sort((a, b) => deliveredMs(b) - deliveredMs(a))[0];
  if (!best) return no("sin_gps");
  const c = coordinateOf(best)!;
  return {
    ok: true,
    delivered: record.delivered,
    source: { orderId: best.order_id, orderName: best.order_name, deliveredAt: best.delivered_at ?? null },
    coordinate: `${c.lat}, ${c.lng}`,
  };
}

/** El veredicto completo: lo del Master y los rechazos en la puerta (§8.2). */
export function evaluateHistoryGuide(input: HistoryGuideInput & { doorRejections: number | null }): HistoryGuideVerdict {
  const candidate = historyGuideCandidate(input);
  if (!candidate.ok) return candidate;
  const no = (reason: HistoryGuideSkip): HistoryGuideVerdict => ({ ok: false, reason, delivered: candidate.delivered, failed: 0 });
  if (input.doorRejections === null) return no("historial_sin_leer");
  if (input.doorRejections > 0) return no("rechazo_en_puerta");
  return candidate;
}

// ---------------------------------------------------------------------------
// Lo que se escribe
// ---------------------------------------------------------------------------

type Named = { delivered: number; source: { orderName: string | null } };

const sourceName = (v: Named) => v.source.orderName ?? "un pedido entregado";
const deliveredText = (n: number) => `${n} entregado${n === 1 ? "" : "s"}`;

/** El motivo del `guide_registered`. */
export function historyGuideReason(orderName: string | null, v: Named): string {
  return `Guía automática: ${orderName ?? "el pedido"} confirmó por Chatby; GPS de la entrega de ${sourceName(v)} (historial de entregas).`;
}

/** Lo que dice `guide_detail` de la coordenada. */
export function historyGuideCoordinateNote(v: Named): string {
  return `coordenada: GPS de la entrega de ${sourceName(v)} (historial de entregas)`;
}

/** El motivo del hecho de la línea de tiempo (`chatby_history_guide`). */
export function historyGuideFactReason(v: Named): string {
  return `Guía creada con el GPS de la entrega de ${sourceName(v)}.`;
}

/** La nota del hecho: por qué se pudo, sin copiar la dirección. */
export function historyGuideFactNote(holdReason: HistoryGuideHoldReason, v: Named): string {
  const why =
    holdReason === "direccion_incompleta"
      ? "la dirección está incompleta"
      : "Google no ubica la dirección y la clienta no mandó su ubicación";
  return (
    `La clienta confirmó por Chatby y ${why}, pero ya recibió en esta misma dirección ` +
    `(${deliveredText(v.delivered)}, ningún fallido): Kapta creó la guía Aliclik con el GPS de la entrega de ${sourceName(v)}.`
  );
}

/** Lo que se agrega a la nota de la confirmación. */
export function historyGuideConfirmationSuffix(v: Named): string {
  return ` La guía va con el GPS de la entrega de ${sourceName(v)}: la clienta ya recibió en esta dirección (${deliveredText(v.delivered)}, ningún fallido).`;
}

/** La evidencia que queda en la marca (`chatby_auto_checks.evidence.history_guide`): números y el pedido, ni direcciones ni celulares. */
export function historyGuideEvidence(
  mode: HistoryGuideMode,
  holdReason: HistoryGuideHoldReason,
  v: HistoryGuideVerdict,
  at: Date,
): Record<string, unknown> {
  const base = { policy: HISTORY_GUIDE_POLICY, mode, hold_reason: holdReason, at: at.toISOString(), delivered: v.delivered };
  if (!v.ok) return { ...base, outcome: "no_califica", reason: v.reason, failed: v.failed };
  return {
    ...base,
    outcome: mode === "activo" ? "usada" : "habria_usado",
    source_order_id: v.source.orderId,
    source_order_name: v.source.orderName,
  };
}
