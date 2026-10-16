// El matiz del segmento del lead, compartido por la cola, la tarjeta del
// siguiente lead y la ficha. Módulo aparte para que la ficha (que se carga
// sola) no arrastre la tarjeta.
import type { QueueBucket } from "@/lib/leads";
import type { CategoryTone } from "@/components/ops-ui";

/**
 * El matiz de cada segmento (DESIGN.md › Estados › Segmento del lead): una
 * escalera de intención, de lo frío a lo que está por cerrar, con matices que
 * ya usa el Master. Naranja el carrito (el de la macroetapa de cierre); verde
 * azulado quien dio su distrito (el de la cobertura: dónde se entrega); índigo
 * quien vio un producto; celeste quien conversó; pizarra el frío. Son
 * clasificación, no estado: van con anillo, y el texto dice siempre el
 * segmento.
 */
export const SEGMENT_TONE: Record<QueueBucket, CategoryTone> = {
  carrito: "orange",
  distrito: "teal",
  producto: "indigo",
  converso: "sky",
  frio: "slate",
};
