// «Usar este GPS»: el GPS de una entrega anterior de la clienta, al crear la
// guía Aliclik a mano (pedido del owner, 08-11-2026: «estaría bueno mostrarlo
// para estos clientes recurrentes y usar la misma GPS»). MOM §6.1.
//
// LA DIFERENCIA CON LA REGLA AUTOMÁTICA (lib/history-guide-auto.ts, 0317).
// Aquella crea la guía sola y por eso exige mucho: ningún fallido en TODO el
// historial y la misma dirección. Esta solo PROPONE, y decide la asesora: se
// listan los pedidos entregados de la clienta (mismo celular, misma
// organización) cuya guía Aliclik guardó coordenada, se avisa en ámbar si la
// dirección o el distrito no son los de este pedido, y un clic llena el campo.
// Después siguen todas las rejas de siempre (cotizar, pin respaldado, riesgo,
// duplicado…): elegir un GPS no levanta ninguna.
//
// QUÉ CUENTA. Solo pedidos entregados (`general_status = entregado`) y nunca
// uno que tuvo un fallido, con la misma idea de «fallido» que la regla 0317,
// aplicada a ESE pedido: un intento de entrega que no se entregó
// (`attempt_count > 0`, también si al final se entregó), una guía devuelta
// (`returned_at`, `delivery_status = devuelto`) o un rechazo en la puerta
// (`etiquetaDiceRechazoEnPuerta`). El GPS es el de su guía Aliclik ENTREGADA
// (`shipments.latitude/longitude`): el punto que Kapta le mandó a Aliclik y
// con el que se entregó, no el GPS del motorizado.
//
// Puro (y solo del servidor: la comparación de direcciones vive con la regla
// 0317). Lo carga `loadRecurringGpsCandidates` (app/dashboard/pedidos/aliclik-actions.ts)
// y lo prueba `test/recurring-gps.test.ts`.

import { isFailedDispatch } from "@/lib/aliclik-route-risk";
import { etiquetaDiceRechazoEnPuerta } from "@/lib/aliclik-status";
import { sameAddress, sameDestination } from "@/lib/history-guide-auto";
import { gpsPoint, limaDayMonth } from "@/lib/guide-gps";

/** Cuántos se proponen: los más recientes. */
export const RECURRING_GPS_LIMIT = 3;

/** Un pedido del mismo celular (de `order_master`). */
export interface RecurringGpsPrior {
  order_id: string;
  order_name: string | null;
  order_created_at: string | null;
  general_status: string | null;
  dispatched_at?: string | null;
  attempt_count?: number | null;
  delivered_at?: string | null;
  address?: string | null;
  district?: string | null;
  province?: string | null;
}

/** Una guía de esos pedidos (de `shipments`). */
export interface RecurringGpsShipment {
  order_id: string | null;
  courier: string | null;
  delivery_status: string | null;
  latitude: number | string | null;
  longitude: number | string | null;
  closed_at?: string | null;
  returned_at?: string | null;
  reported_status?: string | null;
  created_at?: string | null;
}

export interface RecurringGpsCandidate {
  orderId: string;
  orderName: string | null;
  deliveredAt: string | null;
  /** «02-09». */
  deliveredLabel: string | null;
  address: string | null;
  district: string | null;
  province: string | null;
  lat: number;
  lng: number;
  /** «lat, lng»: lo que se escribe en el campo y lo que la guía recibe. */
  coordinate: string;
  /** La dirección escrita no es la de este pedido. */
  addressDiffers: boolean;
  /** El distrito (o la provincia) no es el de este pedido. */
  districtDiffers: boolean;
  /** El aviso ámbar (`recurringGpsMismatch`), ya redactado; null si es la misma casa. */
  warning: string | null;
}

const lower = (v: string | null | undefined) => (v ?? "").trim().toLowerCase();
const ms = (iso: string | null | undefined) => {
  const at = Date.parse(iso ?? "");
  return Number.isFinite(at) ? at : 0;
};

/** ¿Este pedido tuvo un fallido? Intento no entregado, guía devuelta o rechazo en la puerta. */
export function priorHadFailure(prior: RecurringGpsPrior, guides: readonly RecurringGpsShipment[]): boolean {
  if ((Number(prior.attempt_count) || 0) > 0) return true;
  if (isFailedDispatch({ ...prior, macro_stage: null, order_total: null })) return true;
  return guides.some(
    (g) =>
      Boolean((g.returned_at ?? "").trim()) ||
      lower(g.delivery_status) === "devuelto" ||
      etiquetaDiceRechazoEnPuerta(g.reported_status ?? null),
  );
}

/** El aviso ámbar: qué no coincide con este pedido. null si es la misma casa. */
export function recurringGpsMismatch(c: Pick<RecurringGpsCandidate, "addressDiffers" | "districtDiffers" | "district">): string | null {
  if (c.districtDiffers && c.addressDiffers) {
    return `Otra dirección y otro distrito${c.district ? ` (${c.district})` : ""}: confirma con la clienta que recibe ahí.`;
  }
  if (c.districtDiffers) return `Otro distrito${c.district ? ` (${c.district})` : ""}: confirma con la clienta que recibe ahí.`;
  if (c.addressDiffers) return "La dirección no es la de este pedido: confirma con la clienta que recibe ahí.";
  return null;
}

/**
 * Los entregados de la clienta con GPS de Aliclik, el más reciente primero,
 * hasta `limit`. `priors` son los OTROS pedidos del mismo celular en la
 * organización; `shipments`, las guías de esos pedidos.
 */
export function recurringGpsCandidates(input: {
  order: { order_id: string; address?: string | null; district?: string | null; province?: string | null };
  priors: readonly RecurringGpsPrior[];
  shipments: readonly RecurringGpsShipment[];
  limit?: number;
}): RecurringGpsCandidate[] {
  const byOrder = new Map<string, RecurringGpsShipment[]>();
  for (const s of input.shipments) {
    if (!s.order_id) continue;
    const list = byOrder.get(s.order_id) ?? [];
    list.push(s);
    byOrder.set(s.order_id, list);
  }
  const out: RecurringGpsCandidate[] = [];
  for (const prior of input.priors) {
    if (prior.order_id === input.order.order_id) continue;
    if (lower(prior.general_status) !== "entregado") continue;
    const guides = byOrder.get(prior.order_id) ?? [];
    if (priorHadFailure(prior, guides)) continue;
    const delivered = guides
      .filter((g) => lower(g.courier) === "aliclik" && lower(g.delivery_status) === "entregado" && gpsPoint(g.latitude, g.longitude))
      .sort((a, b) => ms(b.closed_at ?? b.created_at) - ms(a.closed_at ?? a.created_at))[0];
    if (!delivered) continue;
    const point = gpsPoint(delivered.latitude, delivered.longitude)!;
    const deliveredAt = prior.delivered_at ?? delivered.closed_at ?? null;
    const addressDiffers = !sameAddress(input.order.address, prior.address);
    const districtDiffers = !sameDestination(input.order, prior);
    out.push({
      orderId: prior.order_id,
      orderName: prior.order_name,
      deliveredAt,
      deliveredLabel: limaDayMonth(deliveredAt),
      address: prior.address ?? null,
      district: prior.district ?? null,
      province: prior.province ?? null,
      lat: point.lat,
      lng: point.lng,
      coordinate: `${point.lat}, ${point.lng}`,
      addressDiffers,
      districtDiffers,
      warning: recurringGpsMismatch({ addressDiffers, districtDiffers, district: prior.district ?? null }),
    });
  }
  return out
    .sort((a, b) => ms(b.deliveredAt ?? null) - ms(a.deliveredAt ?? null))
    .slice(0, input.limit ?? RECURRING_GPS_LIMIT);
}
