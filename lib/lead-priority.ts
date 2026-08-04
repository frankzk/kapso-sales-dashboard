// Orden de la cola "Sin llamar" por probabilidad de cierre, no por reloj.
//
// La capacidad de llamada es fija (~34 llamadas/día contra ~1.300 en cola), así
// que el equipo toca ~2,5% de la cola por día. Lo que decide cuánto se vende no
// es cuántos se llaman sino CUÁLES — y ordenar por recencia es, respecto a la
// intención de compra, casi azar.
//
// Los pesos NO son criterio: son la tasa de cierre REAL medida sobre 60 días de
// historia, contando solo los leads que la asesora efectivamente llamó (2026-08).
//
//            Aurela   Kenku      ← % de cierre cuando se llama
//   carrito   20,3     13,9
//   distrito   3,7      9,2
//   converso   2,7      3,7
//   frío       0,1      0,7      ← 700 llamadas a fríos en Aurela = 1 venta
//
// El orden es idéntico en las dos tiendas (carrito > distrito > converso > frío);
// lo que cambia son las magnitudes, y por eso los pesos son POR TIENDA.
//
// Ojo al medir de nuevo: hay que mirar la tasa entre los LLAMADOS, no la global.
// Los leads que nadie llamó cierran mucho más (hasta 96%) porque el bot cierra
// los fáciles solo y a la asesora le llega lo que el bot no pudo — la tasa global
// mezcla las dos poblaciones y sugiere lo contrario de lo que hay que hacer.

import { leadSegment, type LeadSegment } from "@/lib/leads";

export type SegmentWeights = Record<LeadSegment, number>;

/** Tasa de cierre por segmento cuando se llama, por tienda (ver cabecera). */
const WEIGHTS_BY_STORE: Record<string, SegmentWeights> = {
  aurela: { carrito: 20, distrito: 4, converso: 3, frio: 0 },
  "kenku peru": { carrito: 14, distrito: 9, converso: 4, frio: 1 },
};

/** Promedio de las tiendas medidas: conserva el orden, que es lo que importa.
 *  Se usa en una tienda nueva, hasta tener historia propia para medirla. */
const DEFAULT_WEIGHTS: SegmentWeights = { carrito: 17, distrito: 6, converso: 3, frio: 0.5 };

export function segmentWeightsFor(storeName: string | null | undefined): SegmentWeights {
  const key = (storeName ?? "").trim().toLowerCase();
  return WEIGHTS_BY_STORE[key] ?? DEFAULT_WEIGHTS;
}

/** Entre dos carritos decide el ticket: +1 punto por cada S/50. */
const CART_VALUE_STEP = 50;
/** Tope del bono de carrito: un carrito enorme no debe aplastar al resto de la
 *  señal (sigue siendo una probabilidad de cierre, no un pronóstico de ingreso). */
const CART_VALUE_CAP = 10;
// La antigüedad se aplica como FACTOR, no como resta. Restando, un castigo
// suficientemente grande dejaba un carrito viejo por debajo de un frío recién
// llegado — o sea, el reloj invirtiendo el orden que SÍ está medido. Como el
// desgaste por antigüedad es criterio (no lo medimos) y los pesos son dato, el
// reloj solo puede degradar dentro de una escala, nunca dar vuelta la señal.
/** Desgaste diario de frescura (2% por día). */
const AGE_DECAY_PER_DAY = 0.02;
/** Piso de frescura: un lead viejo pierde fuerza, no desaparece. */
const AGE_FRESHNESS_FLOOR = 0.4;

/** Solo lo que el puntaje realmente lee. No extiende LeadSegmentSignals a
 *  propósito: ese tipo exige `status`, que leadSegment no mira, y obligaría a
 *  cada llamador (y a cada test) a arrastrar un campo que no influye en nada. */
export interface LeadPriorityInput {
  cart_item_count?: number | null;
  district?: string | null;
  inbound_count?: number | null;
  draft_order_gid?: string | null;
  first_inbound_text?: string | null;
  cart_value?: number | null;
  last_interaction_at?: string | null;
  first_seen_at?: string | null;
}

/**
 * Puntaje de prioridad de un lead. Más alto = llamar antes. Puro.
 *   (tasa de cierre del segmento + bono por ticket) × frescura
 */
export function leadPriorityScore(
  lead: LeadPriorityInput,
  weights: SegmentWeights,
  nowMs: number = Date.now(),
): number {
  // `status` va vacío: leadSegment no lo consulta, solo lo pide el tipo.
  const base = weights[leadSegment({ status: "", ...lead })];
  const cartBonus = Math.min(
    CART_VALUE_CAP,
    Math.max(0, (lead.cart_value ?? 0) / CART_VALUE_STEP),
  );
  // Antigüedad medida desde la última señal de vida del cliente; si nunca
  // interactuó, desde que entró. Sin fecha usable, se lo trata como fresco: es
  // mejor mostrarlo de más que esconderlo por un dato que falta.
  const ref = lead.last_interaction_at ?? lead.first_seen_at ?? null;
  let freshness = 1;
  if (ref) {
    const days = (nowMs - Date.parse(ref)) / 86_400_000;
    if (Number.isFinite(days) && days > 0) {
      freshness = Math.max(AGE_FRESHNESS_FLOOR, 1 - days * AGE_DECAY_PER_DAY);
    }
  }
  return (base + cartBonus) * freshness;
}

/**
 * Ordena de mayor a menor prioridad. NO muta la entrada. El desempate por `id`
 * mantiene el orden estable entre renders: sin él, dos leads con el mismo puntaje
 * podrían saltar de lugar y la asesora perdería la fila que estaba mirando.
 */
export function sortLeadsByPriority<T extends LeadPriorityInput & { id: string }>(
  leads: T[],
  weights: SegmentWeights,
  nowMs: number = Date.now(),
): T[] {
  return leads
    .map((lead) => ({ lead, score: leadPriorityScore(lead, weights, nowMs) }))
    .sort((a, b) => b.score - a.score || a.lead.id.localeCompare(b.lead.id))
    .map((entry) => entry.lead);
}
