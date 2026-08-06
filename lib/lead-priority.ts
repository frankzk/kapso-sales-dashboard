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
//
// ADVERTENCIA sobre el peso de `frio`: está SUBESTIMADO y no sirve para concluir
// que no convenga llamar fríos. El segmento se calcula con el estado de HOY, y
// una llamada exitosa a un frío hace que el cliente dé su distrito o genere el
// pedido — con lo cual el lead deja de ser frío y su éxito se le atribuye a otro
// segmento. El balde "frío" es, por construcción, el de los casos donde llamar
// NO funcionó. El sesgo golpea solo a frío: un carrito que cierra sigue teniendo
// carrito, así que su 14–20% sí es sólido.
// Para el ORDEN esto no cambia nada (ningún ajuste razonable pone al frío por
// encima del carrito). Para decidir si vale la pena llamarlos hace falta otra
// medición: el segmento AL MOMENTO de la llamada, o un A/B sobre fríos nuevos.

import { leadSegment, type LeadSegment } from "@/lib/leads";

export type SegmentWeights = Record<LeadSegment, number>;

/** Tasa de cierre por segmento cuando se llama, por tienda (ver cabecera).
 *  `carrito` es el valor promedio sobre todas las antigüedades; el peso que se
 *  usa de verdad sale de CART_WEIGHT_BY_AGE (ver abajo). Se conserva acá como
 *  respaldo para cuando no se puede calcular la antigüedad. */
const WEIGHTS_BY_STORE: Record<string, SegmentWeights> = {
  aurela: { carrito: 20, distrito: 4, converso: 3, frio: 0 },
  "kenku peru": { carrito: 14, distrito: 9, converso: 4, frio: 1 },
};

// Un carrito es un momento PERECEDERO: la misma medición, cortada por horas
// hasta la primera llamada (solo `cod_cart`, cuya fuente se asigna al ingreso y
// por lo tanto no la reescribe el cron de atribución):
//
//                    Aurela   Kenku
//   < 1 h             44,3%    24,1%
//   1–6 h             13,8%    17,0%
//   6–24 h            11,7%    10,8%
//   +1 día              —       9,2%
//
// Casi toda la caída ocurre en la PRIMERA HORA. Con el desgaste diario del resto
// del puntaje (2%/día) esto era invisible: un carrito de 20 minutos y uno de 20
// horas puntuaban casi igual.
//
// Los tramos son escalones y no una curva suave a propósito: cada número es una
// tasa medida. Interpolar entre ellos sería inventar la forma intermedia, que es
// justamente lo que no queremos.
//
// NO se aplica a distrito/converso/frío: ahí la misma medición mostró que llamar
// rápido NO cambia nada dentro del primer día (Aurela fb_web: 9,5 / 10,4 / 10,2),
// así que no hay con qué justificar un desgaste horario.
const CART_WEIGHT_BY_AGE: Record<string, { maxHours: number; weight: number }[]> = {
  aurela: [
    { maxHours: 1, weight: 44 },
    { maxHours: 6, weight: 14 },
    { maxHours: 24, weight: 12 },
    { maxHours: Infinity, weight: 12 },
  ],
  "kenku peru": [
    { maxHours: 1, weight: 24 },
    { maxHours: 6, weight: 17 },
    { maxHours: 24, weight: 11 },
    { maxHours: Infinity, weight: 9 },
  ],
};

/** Promedio de las tiendas medidas: conserva el orden, que es lo que importa.
 *  Se usa en una tienda nueva, hasta tener historia propia para medirla. */
const DEFAULT_WEIGHTS: SegmentWeights = { carrito: 17, distrito: 6, converso: 3, frio: 0.5 };

const storeKey = (storeName: string | null | undefined) => (storeName ?? "").trim().toLowerCase();

/** Todo lo que el puntaje necesita saber de una tienda. Va junto a propósito: si
 *  los pesos y los tramos se pidieran por separado, se podría pasar la tienda
 *  equivocada a uno de los dos y nadie lo notaría. */
export interface ScoringProfile {
  segment: SegmentWeights;
  /** Tramos horarios del carrito; null si la tienda no tiene medición propia. */
  cartByAge: { maxHours: number; weight: number }[] | null;
}

export function scoringProfileFor(storeName: string | null | undefined): ScoringProfile {
  const key = storeKey(storeName);
  return {
    segment: WEIGHTS_BY_STORE[key] ?? DEFAULT_WEIGHTS,
    cartByAge: CART_WEIGHT_BY_AGE[key] ?? null,
  };
}

/**
 * Peso del carrito según su antigüedad en horas. Sin tramos medidos (tienda
 * nueva) o sin antigüedad calculable, cae al promedio de la tienda — que es
 * exactamente lo que hacía antes. Mejor el dato viejo que una curva inventada. Puro.
 */
export function cartWeightForAge(
  cartByAge: ScoringProfile["cartByAge"],
  ageHours: number | null,
  fallback: number,
): number {
  if (!cartByAge || ageHours == null || !Number.isFinite(ageHours)) return fallback;
  const horas = Math.max(0, ageHours);
  for (const tramo of cartByAge) {
    if (horas < tramo.maxHours) return tramo.weight;
  }
  return fallback;
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

/** Horas transcurridas desde `iso`, o null si no hay fecha usable. */
function hoursSince(iso: string | null | undefined, nowMs: number): number | null {
  if (!iso) return null;
  const horas = (nowMs - Date.parse(iso)) / 3_600_000;
  return Number.isFinite(horas) ? Math.max(0, horas) : null;
}

/**
 * Puntaje de prioridad de un lead. Más alto = llamar antes. Puro.
 *   (peso del segmento + bono por ticket) × frescura
 * En `carrito` el peso depende de la antigüedad (ver CART_WEIGHT_BY_AGE).
 */
export function leadPriorityScore(
  lead: LeadPriorityInput,
  profile: ScoringProfile,
  nowMs: number = Date.now(),
): number {
  // `status` va vacío: leadSegment no lo consulta, solo lo pide el tipo.
  const segment = leadSegment({ status: "", ...lead });
  // DOS RELOJES distintos, a propósito:
  //  - el tramo del carrito se mide desde `first_seen_at`, porque así se midió
  //    (desde que entró el lead hasta la primera llamada);
  //  - la frescura general usa la última señal de vida del cliente.
  // Consecuencia conocida: un cliente que entró hace 3 días y volvió a escribir
  // hoy cuenta como carrito viejo. Intuitivamente debería re-calentarse, pero no
  // hay medición de eso y no se inventa.
  const base =
    segment === "carrito"
      ? cartWeightForAge(
          profile.cartByAge,
          hoursSince(lead.first_seen_at ?? lead.last_interaction_at, nowMs),
          profile.segment.carrito,
        )
      : profile.segment[segment];
  const cartBonus = Math.min(
    CART_VALUE_CAP,
    Math.max(0, (lead.cart_value ?? 0) / CART_VALUE_STEP),
  );
  // Sin fecha usable se lo trata como fresco: mejor mostrarlo de más que
  // esconderlo por un dato que falta. Dentro del primer día esta curva es
  // ~1,0, así que no duplica el efecto de los tramos horarios del carrito;
  // solo sigue castigando la cola larga de semanas.
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
  profile: ScoringProfile,
  nowMs: number = Date.now(),
): T[] {
  return sortLeadsByPriorityScoped(leads, () => profile, nowMs);
}

/**
 * Igual, pero con un perfil POR LEAD — para la cola combinada de varias tiendas.
 *
 * Mezclar dos escalas suena a error y no lo es: los pesos de cada tienda salen
 * de su conversión medida, así que son la misma unidad (probabilidad de cierre)
 * y se comparan sin traducción. Un carrito fresco de Aurela cierra 44 % y uno de
 * Kenku 24 %; ponerlos en ese orden es exactamente lo correcto.
 *
 * Lo que sí sería un error es lo que hacía la versión anterior en vista
 * combinada: aplicarle a TODAS las filas el perfil de la tienda del selector.
 */
export function sortLeadsByPriorityScoped<T extends LeadPriorityInput & { id: string }>(
  leads: T[],
  profileFor: (lead: T) => ScoringProfile,
  nowMs: number = Date.now(),
): T[] {
  return leads
    .map((lead) => ({ lead, score: leadPriorityScore(lead, profileFor(lead), nowMs) }))
    .sort((a, b) => b.score - a.score || a.lead.id.localeCompare(b.lead.id))
    .map((entry) => entry.lead);
}
