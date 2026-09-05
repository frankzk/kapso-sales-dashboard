// A/B: ¿vale la pena llamar rápido a un lead SIN NINGUNA SEÑAL?
//
// POR QUÉ HACE FALTA UN EXPERIMENTO Y NO OTRA CONSULTA. El peso de `frio` en
// lib/lead-priority.ts es 1 (Kenku) y 0 (Aurela) — el último de la escala. Ese
// número está mal, y no se puede arreglar mirando el histórico, porque el
// histórico está contaminado por construcción: el segmento se calcula con el
// estado de HOY, y una llamada que funciona hace que el cliente dé su distrito o
// arme un carrito, con lo cual el lead DEJA de ser frío.
//
// Medido: de 1.259 leads que no tenían ninguna señal al entrar y se llamaron
// dentro de la hora, hoy están etiquetados así —
//
//   interés   853  (68%)   conversión 18,8%
//   conversó  240  (19%)              12,9%
//   carrito    65   (5%)              55,4%
//   frío      101   (8%)               4,0%
//
// El 92% se fue del balde. Medir "frío" por la etiqueta de hoy es mirar el 8% de
// residuo donde la llamada NO funcionó — literalmente una tautología.
//
// Reconstruyendo el segmento con lo que una llamada no puede reescribir
// (`source='cod_cart'`, draft orders anteriores a la llamada, y
// `first_inbound_text`, que se escribe una sola vez), un lead sin señal llamado
// dentro de la hora cierra 19,4% en Kenku y 5,9% en Aurela — contra 1,7% y 0,8%
// pasadas 6 horas.
//
// LO QUE ESA CIFRA TODAVÍA NO PRUEBA. Parte del salto es SELECCIÓN: un lead que
// se llama en veinte minutos es uno que estaba disponible, y estar disponible
// correlaciona con comprar. Con datos de observación eso no se separa. De ahí
// este experimento: asignar al azar ANTES de saber nada del resultado es lo
// único que rompe la correlación.
//
// DISEÑO. Intención de tratar (ITT): se compara por el brazo ASIGNADO, no por
// quién acabó llamándose dentro de la hora. Analizar por cumplimiento volvería a
// meter la selección por la puerta de atrás — los tratados que sí se alcanzaron
// serían otra vez "los disponibles". El incumplimiento diluye el efecto medido,
// no lo sesga, y la dilución se mide aparte.
//
// TAMAÑO. Entran ~256 leads sin señal al día y ~30 ya se llaman dentro de la
// hora por su cuenta (11,6%). Con un 20% al brazo de tratamiento son ~51/día;
// para distinguir 2,4% de 5,5% con 80% de potencia hacen falta ~650 por brazo,
// o sea unas dos semanas. La capacidad no estorba: se tocan ~796 leads al día.

/** Identificador del experimento. Va en la fila, no en el código que lee: si
 *  algún día corre un segundo experimento, las filas viejas siguen diciendo a
 *  cuál pertenecen. */
export const FRIO_GOLDEN_EXPERIMENT = "frio_hora_dorada_v1";

/** Fracción al brazo de tratamiento. Un quinto, no la mitad: el tratamiento
 *  desvía capacidad de la primera hora hacia leads que probablemente no cierren,
 *  y con ~650 por brazo en dos semanas no hace falta más. */
export const TREATMENT_FRACTION = 0.2;

export type ExperimentArm = "tratamiento" | "control";

/** Lo que hace falta saber de un lead para decidir si entra. Solo campos que una
 *  llamada NO puede reescribir — si entrara algo mutable, la elegibilidad
 *  dependería del resultado y el experimento no mediría nada. */
export interface ExperimentEligibility {
  source?: string | null;
  first_inbound_text?: string | null;
}

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
 */
export function assignArm(
  leadId: string,
  fraction: number = TREATMENT_FRACTION,
  experiment: string = FRIO_GOLDEN_EXPERIMENT,
): ExperimentArm {
  // Fuera de rango no se reparte: 0 y 1 son apagados válidos y cualquier otra
  // cosa es un error de configuración que no debe traducirse en un reparto raro.
  if (!(fraction > 0)) return "control";
  if (fraction >= 1) return "tratamiento";
  return hash32(`${experiment}:${leadId}`) / 0x100000000 < fraction
    ? "tratamiento"
    : "control";
}

/**
 * ¿Hay que empujar este lead al principio de la cola AHORA? PURA.
 *
 * Solo el brazo de tratamiento y solo mientras siga dentro de su hora dorada:
 * pasada la hora el tratamiento ya no se puede administrar, y dejarlo arriba
 * gastaría capacidad sin medir nada. Que después caiga al orden normal no
 * estropea el análisis — el brazo asignado no cambia, y ITT compara por brazo.
 */
export function shouldPin(
  arm: ExperimentArm | null | undefined,
  urgencyTier: string | null | undefined,
): boolean {
  return arm === "tratamiento" && urgencyTier === "dorada";
}
