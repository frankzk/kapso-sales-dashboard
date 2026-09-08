// A/B sobre los leads que entran SIN NINGUNA SEÑAL de compra.
//
// POR QUÉ HACE FALTA UN EXPERIMENTO Y NO OTRA CONSULTA. El peso de `frio` en
// lib/lead-priority.ts es 1 (Kenku) y 0 (Aurela) — el último de la escala. Ese
// número está mal, y no se puede arreglar mirando el histórico, porque el
// histórico está contaminado por construcción: el segmento se calcula con el
// estado de HOY, y una llamada que funciona hace que el cliente dé su distrito o
// arme un carrito, con lo cual el lead DEJA de ser frío. De 1.259 leads sin
// señal al entrar y llamados dentro de la hora, hoy solo 101 (8%) siguen
// etiquetados frío — o sea que "la tasa del frío" mide el residuo donde la
// llamada NO funcionó. Es una tautología, y solo el sorteo la rompe.
//
// Van dos versiones. La primera falló de una forma que enseñó algo, así que las
// dos están documentadas abajo: v1 (parada) y v2 (la que corre).

// ---------------------------------------------------------------------------
// V1 — PARADO. Lo que enseñó, y por qué se cambió la pregunta.
// ---------------------------------------------------------------------------
// El tratamiento de v1 era "llámalo dentro de su primera hora", señalado en la
// cola. Nunca se administró. Dos mecanismos, los dos fallaron en la MISMA
// dirección:
//
//              % llamado en 1h    % llamado alguna vez
//   empujón     42,1 vs 35,0       (mediana 47 min vs 17 del control)
//   aviso 🧪     22,0 vs 29,7       23,5 vs 34,3  (p ≈ 0,04)
//
// O sea que marcar un lead como "de la prueba" hace que se llame MENOS. Es una
// reacción humana razonable: la etiqueta se lee como "esto no es un pedido de
// verdad". Con dos mecanismos distintos y el mismo signo, una tercera variante
// visual habría sido repetir el error.
//
// Y de paso enseñó que la pregunta estaba mal elegida. Dentro de la población
// aleatorizada:
//
//   llamado dentro de la hora   15,2%   (n=164)
//   llamado después             13,3%   (n=30)
//   NUNCA llamado                0,0%   (n=383)
//
// La hora vale ~2 puntos. Llamar o no llamar vale ~15. Se confirmó en la cola
// entera: desde que existe la columna Edad la velocidad subió (15,2% → 25,1% de
// leads llamados dentro de la hora) y la conversión NO se movió (~10,6% → ~11,0%
// corrigiendo por maduración), porque a la vez la cobertura cayó (48,7% → 39,4%)
// al subir el volumen sin subir la capacidad. Se optimizó la variable pequeña.
//
// v1 se deja de repartir pero sus filas se conservan: la tabla es append-only y
// `read_lead_experiment` sigue leyéndolas.

/** Identificador del experimento v1. PARADO — ya no se asigna. Se conserva
 *  porque las filas históricas lo llevan escrito. */
export const FRIO_GOLDEN_EXPERIMENT = "frio_hora_dorada_v1";

// ---------------------------------------------------------------------------
// V2 — ¿vale la pena LLAMAR a un lead sin señal, aunque sea tarde?
// ---------------------------------------------------------------------------
// Tres cambios respecto de v1, cada uno por algo que se midió:
//
//  1. EL TRATAMIENTO ES "que se llame", no "que se llame rápido". Ahí está el
//     salto de 15 puntos, y además es mucho más fácil de administrar: no hay
//     que ganarle una carrera al reloj.
//
//  2. NO SE ETIQUETA EN LA COLA. La marca 🧪 es lo que hacía que la saltaran.
//     La entrega va por Telegram, con enlace directo al lead, como trabajo
//     normal — que es el único mecanismo que ha funcionado en toda la serie:
//     cuando se le pidió a una persona que llamara una lista, cumplió el 81%
//     contra el 31% del resto del equipo.
//
//  3. SIN FRANJA HORARIA. En v1 el lead tenía que ENTRAR entre las 7 y las 18
//     porque su hora dorada debía caer en horario de trabajo. Aquí no hay prisa:
//     uno que entra a las 3 de la madrugada se llama a las 9 y recibe el
//     tratamiento igual. Eso duplica la población elegible — el 57% entraba
//     fuera de esa franja — y con ella la velocidad del experimento.
//
// TAMAÑO. Control: se llama al 34%, y llamado cierra ~15% ⇒ ~5,1% de conversión
// (medido en v1: 5,9%). Tratamiento al 80% de cobertura ⇒ ~12%. Con ~7 puntos de
// diferencia hacen falta ~254 por brazo: a 20% de ~256 elegibles/día son ~51/día
// y el brazo se llena en 5 días. Si al forzar la cobertura la mitad no contesta,
// el efecto baja a ~3 puntos y hacen falta ~2 semanas — sigue siendo detectable.
// Coste: ~41 llamadas más al día sobre las 378 primeras llamadas que ya se
// hacen, un 11% de la capacidad.

export const FRIO_COVERAGE_EXPERIMENT = "frio_cobertura_v1";

/** Fracción al brazo de tratamiento. Un quinto, no la mitad: cada lead tratado
 *  son llamadas forzadas a leads que probablemente no cierren, y con ~254 por
 *  brazo el experimento se llena igual en días. */
export const TREATMENT_FRACTION = 0.2;

/** El experimento que se está repartiendo AHORA. El resto del código lo lee de
 *  aquí en vez de nombrarlo: cuando llegue v3, se cambia esta línea y no hay que
 *  ir buscando literales por el repo — que es como v1 se habría quedado a medio
 *  parar. */
export const ACTIVE_EXPERIMENT = FRIO_COVERAGE_EXPERIMENT;

export type ExperimentArm = "tratamiento" | "control";

/** Lo que hace falta saber de un lead para decidir si entra. Solo campos que una
 *  llamada NO puede reescribir — si entrara algo mutable, la elegibilidad
 *  dependería del resultado y el experimento no mediría nada. */
export interface ExperimentEligibility {
  source?: string | null;
  first_inbound_text?: string | null;
  first_seen_at?: string | null;
}

/** El enlace a una ficha de producto que el botón de WhatsApp inserta solo.
 *  Misma expresión que `hasProductLink` en lib/leads: aquí va aparte a propósito
 *  para que este módulo no dependa de la definición de segmentos, que SÍ cambia
 *  —y si cambiara, movería la elegibilidad de un experimento ya en marcha. */
const PRODUCT_LINK_RE = /https?:\/\/\S*\/products\/\S/i;

/**
 * ¿Este lead entra en el experimento? PURA.
 *
 * Entra el que NO trae señal de compra al nacer: ni viene de un carrito
 * abandonado (`cod_cart`, fuente que se fija en el ingreso) ni llegó desde la
 * ficha de un producto (`first_inbound_text`, write-once).
 *
 * `district` NO se mira, aunque hoy lo miraría `leadSegment`: es el campo
 * contaminado. Tras una llamada el cliente lo manda por WhatsApp y el bot lo
 * ingesta, así que usarlo para elegir a quién meter en el experimento haría que
 * la elegibilidad dependiera de lo que queremos medir.
 */
export function isExperimentEligible(lead: ExperimentEligibility): boolean {
  if (lead.source === "cod_cart") return false;
  if (PRODUCT_LINK_RE.test(lead.first_inbound_text ?? "")) return false;
  // SIN FRANJA HORARIA desde v2. En v1 el lead tenía que entrar entre las 7 y
  // las 18 porque su hora dorada debía caer en horario de trabajo; aquí el
  // tratamiento es "que se llame", sin prisa, así que uno de madrugada se llama
  // por la mañana y lo recibe igual. La franja de v1 sigue viva donde importa:
  // en el SQL de la migración 0147, que acota SU población histórica.
  return true;
}

/**
 * Hash FNV-1a de 32 bits. Determinista y sin estado: el mismo lead cae siempre
 * en el mismo brazo, aunque el ingreso lo reprocese.
 *
 * Se hashea en vez de leer los primeros dígitos del UUID a propósito. Hoy los
 * ids son v4 (aleatorios) y bastaría, pero si algún día pasaran a ser ordenados
 * —v7, o una secuencia— los primeros bits dejarían de ser uniformes y el brazo
 * quedaría correlacionado con la HORA DE ENTRADA. Eso rompería el experimento en
 * silencio: las horas del día no convierten igual.
 */
function hash32(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  // MEZCLA FINAL, y no es adorno. FNV-1a mete el último carácter en los bits
  // BAJOS y ya no vuelve a mezclar; como el reparto lee los bits ALTOS
  // (h / 2^32), dos ids que solo se diferencian al final caían casi en el mismo
  // sitio. Medido sin esto, con 20.000 ids consecutivos el brazo de tratamiento
  // salía al 18,0% en vez del 20% — dos puntos de desvío correlacionados con el
  // orden de los ids, que es tanto como correlacionarlos con la hora de entrada.
  // Estas cuatro líneas (avalancha lowbias32) llevan cada bit bajo a los altos.
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d) >>> 0;
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

/**
 * Brazo de un lead. PURA y determinista.
 *
 * Se saliniza con el nombre del experimento para que un segundo experimento no
 * reparta a la MISMA gente al mismo lado: sin sal, quien cayó en tratamiento una
 * vez caería siempre, y los dos experimentos dejarían de ser independientes.
 *
 * `experiment` VA SIN VALOR POR DEFECTO y va segundo a propósito. Lo tenía, y
 * apuntaba a v1; cuando v1 se paró, el defecto se quedó nombrando un
 * experimento muerto sin que nada fallara, porque el único caller pasaba el
 * nombre explícito. Un defecto que nadie ejerce es un defecto que nadie prueba.
 */
export function assignArm(
  leadId: string,
  experiment: string,
  fraction: number = TREATMENT_FRACTION,
): ExperimentArm {
  // Fuera de rango no se reparte: 0 y 1 son apagados válidos y cualquier otra
  // cosa es un error de configuración que no debe traducirse en un reparto raro.
  if (!(fraction > 0)) return "control";
  if (fraction >= 1) return "tratamiento";
  return hash32(`${experiment}:${leadId}`) / 0x100000000 < fraction
    ? "tratamiento"
    : "control";
}
