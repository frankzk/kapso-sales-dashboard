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
// `distrito` pasó a ser `interes` cuando se le sumó "llegó desde la ficha de un
// producto" (ver leadSegment). Remedido con el mismo método:
//
//            Aurela   Kenku
//   carrito   43,5     35,6
//   interes   12,2     19,1      ← distrito + ficha de producto
//   converso   2,6      6,3
//   frío       0,5      1,3
//
// El orden sigue siendo idéntico en las dos tiendas, que es lo que sostiene la
// cascada. Las magnitudes de esta segunda tabla salen más altas que las de la
// primera (misma ventana, distinta corrida) y NO se mezclan: los pesos conservan
// la escala original, y `interes` se ubicó dentro de ella moviendo el peso que
// tenía `distrito` por la RAZÓN en que la fusión cambió su tasa medida —hacia
// arriba en Aurela (10,4 → 12,2) y hacia abajo en Kenku (21,0 → 19,1)—, no por
// el valor absoluto.
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

/** Un escalón de la tabla por antigüedad: vale `weight` mientras la edad del
 *  lead sea menor que `maxHours`. */
export interface AgeTier {
  maxHours: number;
  weight: number;
}

/** Tasa de cierre por segmento cuando se llama, por tienda (ver cabecera).
 *  En `carrito` e `interes` estos son el promedio sobre todas las antigüedades;
 *  el peso que se usa de verdad sale de WEIGHT_BY_AGE (ver abajo). Se conservan
 *  acá como respaldo para cuando no se puede calcular la antigüedad. */
const WEIGHTS_BY_STORE: Record<string, SegmentWeights> = {
  aurela: { carrito: 20, interes: 5, converso: 3, frio: 0 },
  "kenku peru": { carrito: 14, interes: 8, converso: 4, frio: 1 },
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
// `interes` TAMBIÉN DECAE (2026-09). Antes esto decía que no: "la misma medición
// mostró que llamar rápido NO cambia nada dentro del primer día (Aurela fb_web:
// 9,5 / 10,4 / 10,2)". Esa medición era de UNA fuente de UNA tienda, y al
// repetirla sobre el balde entero y las dos tiendas dice lo contrario:
//
//                    Aurela   Kenku
//   < 1 h             17,0%    27,6%
//   1–6 h              6,9%    14,5%
//   6–24 h             6,0%    12,9%
//   +1 día             4,4%     4,7%
//
// No es composición: `interes` mezcla producto+distrito (44,9 → 14,0), solo
// distrito (20,3 → 8,3) y solo ficha (12,0 → 0,5), y el gradiente aparece DENTRO
// de cada uno de los tres por separado. Lo que sí explica el hallazgo viejo es
// que en Aurela «solo distrito» apenas se mueve (7,4 / 5,8 / 5,8) — o sea, aquel
// número no estaba mal, estaba mirando el único trozo del balde que no decae.
//
// ESCALAS SEPARADAS. Los tramos de `interes` NO son las tasas de arriba: salen de
// mover el peso plano del segmento (5 y 8) por la RAZÓN entre cada tramo y el
// promedio del propio balde, igual que se hizo al fusionar distrito+ficha. Las
// dos tablas se midieron con corridas y recortes distintos, y mezclar magnitudes
// pondría un `interes` fresco de Kenku (27,6) por encima de un carrito fresco
// (24,1) por un artefacto de medición, no por lo que pasa.
// Control de que el método no miente: con estos pesos, en Kenku un `interes`
// fresco (16) pasa a un carrito de 6-24h (11) —medido: 27,6% contra 24,9%, sí—
// y en Aurela NO lo pasa (11 contra 12) —medido: 17,0% contra 19,9%, tampoco—.
// El orden que producen los pesos coincide con el orden medido en las dos.
//
// `converso` Y `frio` TAMBIÉN DECAEN (2026-09-12). Hasta acá no tenían tramos, y
// eso no era una decisión sino un hueco: sin tramos el peso es plano, no hay bono
// de ticket y el desgaste diario corre sobre `last_interaction_at` —que NO es la
// edad del lead y que el 23,5% de la cola tiene puesto en hoy—, así que los 1.245
// fríos «sin llamar» puntuaban EXACTAMENTE IGUAL. Empatados todos, el orden lo
// decidía el desempate por vencimiento, que pone al más viejo primero: en la
// pantalla salía un lead de 39 días por delante del de esta mañana. El desempate
// está bien para un carrito, que vence; en un balde sin tramos no vence nada y
// ese criterio no significa nada.
//
// Medido con el mismo método (60 días, solo los que se llamaron, por horas hasta
// la PRIMERA llamada):
//
//              converso            frio
//            Aurela  Kenku     Aurela  Kenku
//   < 1 h      3,45   7,09       0,00   2,49
//   1–6 h      2,46   2,94       0,64   1,48
//   6–24 h     1,50   2,65       0,26   1,05
//   +1 día     0,35   1,85       0,48   1,15
//
// `converso` es sólido: juntando tiendas, 6,43% antes de la hora contra 2,00%
// después (z = 5,3). `frio` apunta al mismo lado y NO es concluyente: 1,72%
// contra 0,72%, z = 1,8, p ≈ 0,07. Se le ponen tramos igual porque el hueco
// actual no es «plano», es «empatado», y un empate lo resuelve hoy un criterio
// que apunta al revés de la única evidencia que hay.
//
// El sesgo del balde juega A FAVOR, no en contra: el segmento se calcula con el
// estado de HOY, así que el frío o el conversó al que la llamada le funcionó
// normalmente salió del balde. Eso APLANA el gradiente; encontrarlo igual es
// conservador.
//
// NORMALIZADOS POR EL MEJOR TRAMO, no por el promedio del balde. Los de `carrito`
// e `interes` se hicieron contra el promedio, que reparte hacia arriba y hacia
// abajo; acá eso SUBIRÍA al conversó fresco por encima de segmentos que lo ganan
// medidos (Kenku: conversó <1h 7,09% contra `interes` de 6-24h 9,30%). Contra el
// mejor tramo, el más fresco conserva el peso plano que el balde ya tenía y los
// demás bajan: nadie sube de sitio, y los que estaban de más caen a donde la
// medición los pone. Los tramos que la muestra no separa comparten peso (Kenku
// frío 6-24h y +1d: 1,05% contra 1,15%; conversó 1-6h y 6-24h: 2,94% contra
// 2,65%), porque partirlos sería inventar la diferencia.
//
// Control, en Kenku: un frío recién llegado (1) pasa a un conversó de más de un
// día (0,9) —medido 2,49% contra 1,85%, sí— y NO pasa a uno de 1-6h (1,5)
// —medido 2,49% contra 2,94%, tampoco—.
//
// AURELA FRÍO SE QUEDA SIN TRAMOS a propósito: son 5 cierres en 1.274 llamadas y
// el tramo de <1h tiene CERO. No hay gradiente que copiar, y su peso plano ya es
// 0, así que el balde está al fondo de la cola de todas formas. Su orden interno
// sigue siendo el del desempate; cuando haya muestra se mide y se pone.
//
// DENTRO DE «+1 DÍA» NO SE PARTE MÁS, y esto es lo que hay que leer antes de
// volver a tocar esto. La queja que originó el cambio era ver, en «Frío», un lead
// de 8 días por delante de uno de 2; los dos están en «+1 día» y ahí siguen, uno
// al lado del otro. Se midió si se podían separar (90 días, los dos baldes):
//
//              converso        frio
//   1–3 días    2,11 (665)    1,15 (608)
//   3–7 días    2,12 (660)    0,58 (866)
//   +7 días    15,15  (33)    6,90  (29)
//
// 1-3 y 3-7 son indistinguibles. Y el salto de «+7 días» NO es señal: son 33 y 29
// llamadas, y un lead de más de una semana que alguien decide llamar no es un
// lead cualquiera —lo eligieron a mano, o el cliente volvió a escribir—. Es
// selección, y codificarla pondría lo más muerto de la cola en cabeza.
//
// Así que dentro de «+1 día» los leads empatan de verdad, y el desempate por
// vencimiento los deja en FIFO: primero el que lleva más esperando. A tasa de
// cierre igual eso no cuesta nada y acota cuánto puede esperar un lead, en vez de
// dejar que el fondo de la cola se pudra. Lo que sí estaba mal —y es lo que esto
// arregla— era que un lead de 40 minutos EMPATARA con uno de 8 días y perdiera el
// desempate. Medido en la cola real de Kenku al aplicarlo: el frío más fresco
// pasa de la posición 213 a la 1.
const WEIGHT_BY_AGE: Record<string, Partial<Record<LeadSegment, AgeTier[]>>> = {
  aurela: {
    carrito: [
      { maxHours: 1, weight: 44 },
      { maxHours: 6, weight: 14 },
      { maxHours: 24, weight: 12 },
      { maxHours: Infinity, weight: 12 },
    ],
    interes: [
      { maxHours: 1, weight: 11 },
      { maxHours: 6, weight: 4 },
      { maxHours: 24, weight: 4 },
      { maxHours: Infinity, weight: 3 },
    ],
    // 2,9 y no 3 para que el `interes` de más de un día (3) le siga ganando:
    // medido, 6,37% contra 3,45%.
    converso: [
      { maxHours: 1, weight: 2.9 },
      { maxHours: 6, weight: 1.6 },
      { maxHours: 24, weight: 1.6 },
      { maxHours: Infinity, weight: 0.3 },
    ],
  },
  "kenku peru": {
    carrito: [
      { maxHours: 1, weight: 24 },
      { maxHours: 6, weight: 17 },
      { maxHours: 24, weight: 11 },
      { maxHours: Infinity, weight: 9 },
    ],
    interes: [
      { maxHours: 1, weight: 16 },
      { maxHours: 6, weight: 9 },
      { maxHours: 24, weight: 8 },
      { maxHours: Infinity, weight: 3 },
    ],
    converso: [
      { maxHours: 1, weight: 4 },
      { maxHours: 6, weight: 1.5 },
      { maxHours: 24, weight: 1.5 },
      // 0,9 y no 1 para que un frío recién llegado (1) le pase: medido, 2,49%
      // contra 1,85%.
      { maxHours: Infinity, weight: 0.9 },
    ],
    frio: [
      { maxHours: 1, weight: 1 },
      { maxHours: 6, weight: 0.6 },
      { maxHours: 24, weight: 0.45 },
      { maxHours: Infinity, weight: 0.45 },
    ],
  },
};

/** Promedio de las tiendas medidas: conserva el orden, que es lo que importa.
 *  Se usa en una tienda nueva, hasta tener historia propia para medirla. */
const DEFAULT_WEIGHTS: SegmentWeights = { carrito: 17, interes: 7, converso: 3, frio: 0.5 };

const storeKey = (storeName: string | null | undefined) => (storeName ?? "").trim().toLowerCase();

/** Todo lo que el puntaje necesita saber de una tienda. Va junto a propósito: si
 *  los pesos y los tramos se pidieran por separado, se podría pasar la tienda
 *  equivocada a uno de los dos y nadie lo notaría. */
export interface ScoringProfile {
  segment: SegmentWeights;
  /** Tramos horarios por segmento. Un segmento ausente (o una tienda sin
   *  medición propia) usa su peso plano. */
  byAge: Partial<Record<LeadSegment, AgeTier[]>>;
}

export function scoringProfileFor(storeName: string | null | undefined): ScoringProfile {
  const key = storeKey(storeName);
  return {
    segment: WEIGHTS_BY_STORE[key] ?? DEFAULT_WEIGHTS,
    byAge: WEIGHT_BY_AGE[key] ?? {},
  };
}

/**
 * Peso de un segmento según la antigüedad del lead en horas. Sin tramos medidos
 * (tienda nueva, o segmento que no decae) o sin antigüedad calculable, cae al
 * peso plano de la tienda. Mejor el dato viejo que una curva inventada. Puro.
 */
export function weightForAge(
  tiers: AgeTier[] | null | undefined,
  ageHours: number | null,
  fallback: number,
): number {
  if (!tiers || ageHours == null || !Number.isFinite(ageHours)) return fallback;
  const horas = Math.max(0, ageHours);
  for (const tramo of tiers) {
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
// Y se cuenta por DÍAS ENTEROS, no en continuo. Aplicado en continuo, una hora
// de diferencia movía el puntaje un 0,08% — ruido puro— pero era suficiente para
// mandar POR ENCIMA de los tramos, que sí están medidos. En la cola real, cinco
// carritos de S/99 del mismo tramo (donde la conversión es plana: 24,1%) salían
// ordenados 12,2 h · 13,0 h · 14,2 h · 15,2 h · 15,7 h — el más cerca de cruzar
// a "+24 h" y perder 2 puntos de peso quedaba ÚLTIMO, porque su cliente no había
// vuelto a escribir hace un rato. Un criterio que no medimos decidiendo contra un
// dato que sí.
// Por días enteros, todo lo que entró hoy vale igual y el orden dentro del tramo
// lo decide el vencimiento (ver sortLeadsByPriorityScoped). La cola larga de
// semanas se sigue castigando igual, que es para lo que se puso.
/** Desgaste de frescura: 2% por cada día ENTERO transcurrido. */
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
  //  - el tramo por antigüedad se mide desde `first_seen_at`, porque así se
  //    midió (desde que entró el lead hasta la primera llamada);
  //  - la frescura general usa la última señal de vida del cliente.
  // Consecuencia conocida: un cliente que entró hace 3 días y volvió a escribir
  // hoy cuenta como lead viejo. Intuitivamente debería re-calentarse, pero no
  // hay medición de eso y no se inventa.
  const base = weightForAge(
    profile.byAge[segment],
    hoursSince(lead.first_seen_at ?? lead.last_interaction_at, nowMs),
    profile.segment[segment],
  );
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
    const days = Math.floor((nowMs - Date.parse(ref)) / 86_400_000);
    if (Number.isFinite(days) && days > 0) {
      freshness = Math.max(AGE_FRESHNESS_FLOOR, 1 - days * AGE_DECAY_PER_DAY);
    }
  }
  return (base + cartBonus) * freshness;
}

/**
 * Ordena de mayor a menor prioridad. NO muta la entrada.
 *
 * DESEMPATE: primero el MÁS VIEJO, y solo después el `id`.
 *
 * Los tramos son escalones planos —dentro de "6-24 h" un carrito de 7 horas y
 * uno de 23 cierran igual (24,1%)—, así que a igual segmento y ticket el puntaje
 * empata y hace falta un criterio. Antes no había ninguno explícito: desempataba
 * el resto decimal de `freshness`, que iba en la dirección contraria. En la cola
 * real, cinco carritos de S/99 del mismo tramo salían 12,2 h · 13,0 h · 14,2 h ·
 * 15,2 h · 15,7 h, o sea el más cerca de cruzar a "+24 h" —y perder 2 puntos de
 * peso, 11 → 9— quedaba ÚLTIMO.
 *
 * Llamar primero al que está por vencer es el resultado clásico de planificación
 * por vencimiento más próximo: a igual valor AHORA, se atiende antes lo que
 * antes deja de valer. Y no inventa ninguna curva —los escalones siguen siendo
 * los medidos—: solo desempata dentro de uno.
 *
 * Estable entre renders, que es lo que protegía el desempate por `id`: la edad
 * relativa de dos leads no cambia nunca, así que la fila que la asesora está
 * mirando no se le mueve bajo el dedo.
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
// SIN LLAVE DE "EMPUJÓN". Hubo una: el experimento de la hora dorada subía su
// brazo de tratamiento al principio de la cola. Se quitó porque medido salía al
// revés —47 minutos de mediana hasta la llamada contra 14 del control— y porque
// tenía un coste cierto: ponía un frío (~9-19% de cierre) por encima de un
// carrito fresco (41%). Si alguna vez hace falta reordenar por una razón que no
// sea el valor medido, que vuelva como llave aparte y NUNCA sumada al puntaje:
// inflar un peso haría que la escala dejara de significar la probabilidad que
// dice significar.
export function sortLeadsByPriorityScoped<T extends LeadPriorityInput & { id: string }>(
  leads: T[],
  profileFor: (lead: T) => ScoringProfile,
  nowMs: number = Date.now(),
): T[] {
  return leads
    .map((lead) => ({
      lead,
      score: leadPriorityScore(lead, profileFor(lead), nowMs),
      // Mismo reloj con el que se eligió el tramo, para que el desempate empuje
      // hacia el mismo lado que el escalón. Sin fecha va al final del empate: no
      // se puede afirmar que esté por vencer.
      age: hoursSince(lead.first_seen_at ?? lead.last_interaction_at, nowMs) ?? -1,
    }))
    .sort((a, b) => b.score - a.score || b.age - a.age || a.lead.id.localeCompare(b.lead.id))
    .map((entry) => entry.lead);
}
