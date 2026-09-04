// La hora dorada: cuánto le queda a un lead antes de que llamarlo valga la mitad.
//
// PARA QUÉ. Medido sobre 60 días (leads con ≥7 días de maduración, contando solo
// los que la asesora llamó, venta atada por `order_sales.lead_id`), la tasa de
// cierre según cuánto tardó la PRIMERA llamada:
//
//                        <1h    1-6h   6-24h   +24h
//   carrito             40,5%   22,2%  24,1%   22,6%
//   producto+distrito   44,9%   23,0%  18,5%   14,0%
//   solo distrito       20,3%   11,5%  11,0%    8,3%
//   solo ficha          12,0%    2,3%   3,3%    0,5%
//   sin señal           12,9%    4,0%   2,5%    0,5%
//
// Los cinco segmentos caen a la mitad o menos pasada la primera hora, y el
// gradiente se sostiene DENTRO de cada balde homogéneo y en LAS DOS tiendas —o
// sea, no es composición: no es que el balde rápido tenga mejores leads, es que
// llegar tarde los apaga. En carrito la caída además no continúa: llamarlo a las
// 2 horas (22,2%) rinde igual que a los tres días (22,6%). Es un ACANTILADO en la
// primera hora, no una pendiente.
//
// POR QUÉ ESTE MÓDULO Y NO LA VENTANA DE 24H. En la fila conviven dos relojes que
// no tienen nada que ver:
//
//   - `leadWindowInfo` (lib/leads) mide la ventana de sesión de WhatsApp desde el
//     último mensaje ENTRANTE. Responde «¿puedo mandarle texto libre?». Es un
//     permiso de mensajería: no dice nada de la probabilidad de cierre.
//   - esto mide la EDAD del lead desde que entró. Responde «¿cuánto me queda para
//     que llamarlo siga valiendo el doble?».
//
// Se estaban pintando como si fueran el mismo. Con la cola real (1.966 sin
// llamar): de los 366 leads que la ventana pinta de verde, las edades van de 0,2h
// a 1.604h — el mismo verde para uno de doce minutos y otro de 67 días. Solo 24
// estaban de verdad dentro de la hora dorada, escondidos entre 342 que no.
//
// Y el contador de la ventana se muestra redondeado a horas, así que dentro de la
// hora dorada marca «24h» constante: por construcción no puede distinguir «quedan
// 50 minutos» de «quedan 10». Toda la decisión ocurre dentro de un solo escalón
// suyo.

/** Tramos de la edad de un lead. Los cortes son los mismos con los que se midió
 *  la tabla de arriba: cambiarlos aquí sin volver a medir rompe la relación
 *  entre lo que se pinta y lo que se sabe. */
export type UrgencyTier = "dorada" | "tibia" | "enfriando" | "fria";

/** Duración de la hora dorada, en minutos. */
export const GOLDEN_MINUTES = 60;

const TIBIA_MINUTES = 6 * 60;
const ENFRIANDO_MINUTES = 24 * 60;

export interface LeadUrgency {
  tier: UrgencyTier;
  /** Minutos desde que entró el lead. Nunca negativo. */
  ageMinutes: number;
  /** Minutos que quedan de hora dorada; null fuera de ella. Es un descuento a
   *  propósito: «quedan 43 min» empuja a actuar, «hace 17 min» no. */
  minutesLeft: number | null;
  /** Texto corto para la columna: «43 min», «2 h», «9 h», «5 d». */
  label: string;
}

/** Etiqueta compacta de una edad ya pasada la hora dorada. Sube de unidad para
 *  que quepa en la columna sin recortarse: 5h, 18h, 3d, 67d. */
function ageLabel(ageMinutes: number): string {
  const horas = ageMinutes / 60;
  if (horas < ENFRIANDO_MINUTES / 60) return `${Math.round(horas)} h`;
  return `${Math.round(horas / 24)} d`;
}

/**
 * Urgencia de un lead por su edad. PURA.
 *
 * `null` cuando no hay fecha usable: sin edad no hay urgencia que afirmar, y
 * pintar un lead de verde por un dato que falta sería inventar la señal justo
 * donde no la hay.
 */
export function leadUrgency(
  firstSeenAt: string | null | undefined,
  nowMs: number,
): LeadUrgency | null {
  if (!firstSeenAt) return null;
  const t = Date.parse(firstSeenAt);
  if (!Number.isFinite(t)) return null;
  // Una fecha del futuro (reloj torcido del ingreso) se trata como recién
  // llegado en vez de descartarse: es lo que casi seguro es.
  const ageMinutes = Math.max(0, (nowMs - t) / 60_000);

  if (ageMinutes < GOLDEN_MINUTES) {
    const minutesLeft = Math.max(1, Math.ceil(GOLDEN_MINUTES - ageMinutes));
    return { tier: "dorada", ageMinutes, minutesLeft, label: `${minutesLeft} min` };
  }
  const tier: UrgencyTier =
    ageMinutes < TIBIA_MINUTES ? "tibia" : ageMinutes < ENFRIANDO_MINUTES ? "enfriando" : "fria";
  return { tier, ageMinutes, minutesLeft: null, label: ageLabel(ageMinutes) };
}

/** Los segmentos donde entrar en la hora dorada cambia de verdad el resultado.
 *  `converso` y `frio` también caen, pero desde 12,9% a 4,0%: llamarlos rápido
 *  importa mucho menos que no dejar pasar un carrito, y meterlos en el aviso lo
 *  llenaría de ruido (son 243 leads/día contra 168 de los otros dos juntos). */
export const GOLDEN_SEGMENTS = ["carrito", "interes"] as const;

export interface GoldenTally {
  total: number;
  carrito: number;
  interes: number;
}

/**
 * Cuenta los leads que están dentro de la hora dorada, por segmento. PURA.
 *
 * Solo cuenta `carrito` e `interes` (ver GOLDEN_SEGMENTS): el aviso existe para
 * que no se escape lo caro, no para anunciar que entraron leads.
 */
export function tallyGolden<T extends { first_seen_at?: string | null }>(
  leads: readonly T[],
  segmentOf: (lead: T) => string,
  nowMs: number,
): GoldenTally {
  let carrito = 0;
  let interes = 0;
  for (const lead of leads) {
    if (leadUrgency(lead.first_seen_at, nowMs)?.tier !== "dorada") continue;
    const seg = segmentOf(lead);
    if (seg === "carrito") carrito += 1;
    else if (seg === "interes") interes += 1;
  }
  return { total: carrito + interes, carrito, interes };
}
