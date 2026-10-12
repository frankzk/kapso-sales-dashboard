// Los nombres que Productividad muestra para las fuentes y los tipos de lead.
// Módulo PURO y client-safe: lo importan el tablero (servidor) y la tabla
// ("use client"), y no debe traer el data layer de lib/productivity.
import type { LeadSegment } from "@/lib/leads";
import type { SourceBucket } from "@/lib/productivity";

/** Las fuentes de un cierre, con su nombre a la vista (sin emojis). */
export const SOURCE_LABEL: Record<SourceBucket, string> = {
  meta_ad: "Campaña",
  fb_web: "Meta/Web",
  cod_cart: "Carrito",
  abandoned_browse: "Búsqueda",
  organic: "Orgánico",
};

/** Los tipos de lead (lib/leads LEAD_SEGMENTS) sin sus emojis, en el orden de calidad. */
export const SEGMENT_LABEL: Record<LeadSegment, string> = {
  carrito: "Con carrito",
  interes: "Distrito o producto",
  converso: "Conversó",
  frio: "Frío",
};
