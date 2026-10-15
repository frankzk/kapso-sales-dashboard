// «Salió con»: con quién salió de verdad un pedido (MOM §9.3, 15-10-2026).
//
// El filtro «Courier» del Master mira el courier VIGENTE (y el último), y para
// Grupo GF solo dice «Propio». No responde lo que el owner pregunta al revisar
// un pedido con intentos: ¿con quién salió? ¿Con Roy, con Alexis, con Tanders?
// Esta es la lista de todos: cada motorizado de Grupo GF que tuvo una parada
// con el pedido, y cada courier externo cuya guía llegó a salir.
//
// Los códigos se guardan en `order_master.dispatched_with` (0266):
//   gf:<Nombre>  una parada de Grupo GF con ese motorizado (delivery_stops)
//   gf           una salida de Grupo GF sin parada conocida
//   aliclik, fenix (Swayp), tanders, urpi, shalom, olva, axel…  el courier
//
// Pura: el recálculo del Master la llama con lo que ya leyó.

import { courierVisitAttempts } from "@/lib/order-status";

/** Una parada de una ruta de Grupo GF, con el motorizado de su ruta. */
export interface RiderStop {
  id: string;
  status: string | null;
  shipment_id: string | null;
  rider: string | null;
}

export interface DispatchGuide {
  id: string;
  courier: string | null;
  delivery_status: string | null;
  dispatched_at?: string | null;
  out_for_delivery_at?: string | null;
  pickup_state?: string | null;
  returned_at?: string | null;
  custody_state?: string | null;
  reported_status?: string | null;
  swayp_state?: number | null;
  aliclik_attempts?: number | null;
  reroute_attempts?: number | null;
}

const OUT_CUSTODY = new Set(["courier", "retorno", "devuelto"]);
const OUT_STATUS = new Set(["en_ruta", "entregado"]);
/** Una parada que el motorizado ya reportó: fue a la puerta. */
export const REPORTED_STOP = new Set(["entregado", "no_entregado"]);

function guideLeft(guide: DispatchGuide, events: Parameters<typeof courierVisitAttempts>[1]): boolean {
  return Boolean(
    guide.dispatched_at ||
      guide.out_for_delivery_at ||
      guide.pickup_state ||
      guide.returned_at ||
      OUT_STATUS.has(guide.delivery_status ?? "") ||
      OUT_CUSTODY.has(guide.custody_state ?? "") ||
      (guide.aliclik_attempts ?? guide.reroute_attempts ?? 0) > 0 ||
      courierVisitAttempts(guide, events) > 0,
  );
}

/**
 * Con quién salió el pedido. Una parada de Grupo GF cuenta si el motorizado la
 * reportó (entregado o no entregado) o si la caja está ahora con él (parada
 * pendiente y custodia del courier). Una guía externa cuenta si llegó a salir:
 * despachada, en ruta, entregada, de vuelta o con intentos. Urpi, por los
 * intentos de su reporte.
 */
export function dispatchedWith(input: {
  guides: readonly DispatchGuide[];
  stops: readonly RiderStop[];
  events: Parameters<typeof courierVisitAttempts>[1];
  urpiAttempts: number;
}): string[] {
  const out = new Set<string>();
  const custodyByShipment = new Map(input.guides.map((g) => [g.id, g.custody_state ?? null]));
  const gfShipments = new Set<string>();
  for (const stop of input.stops) {
    const reported = REPORTED_STOP.has(stop.status ?? "");
    const outNow = stop.status === "pendiente" && stop.shipment_id != null && custodyByShipment.get(stop.shipment_id) === "courier";
    if (!reported && !outNow) continue;
    const rider = stop.rider?.trim();
    out.add(rider ? `gf:${rider}` : "gf");
    if (stop.shipment_id) gfShipments.add(stop.shipment_id);
  }
  for (const guide of input.guides) {
    const courier = (guide.courier ?? "").trim().toLowerCase();
    if (!courier || courier === "por_definir") continue;
    if (!guideLeft(guide, input.events)) continue;
    if (courier === "propio") {
      if (!gfShipments.has(guide.id) && ![...out].some((code) => code.startsWith("gf"))) out.add("gf");
      continue;
    }
    out.add(courier);
  }
  if (input.urpiAttempts > 0) out.add("urpi");
  return [...out].sort(compareDispatchCodes);
}

const COURIER_NAMES: Record<string, string> = {
  aliclik: "Aliclik",
  fenix: "Swayp",
  tanders: "Tanders",
  urpi: "Urpi",
  shalom: "Shalom",
  olva: "Olva",
  axel: "Axel",
};

/** Cómo se enseña un código de «Salió con». */
export function dispatchedWithLabel(code: string): string {
  if (code === "gf") return "Grupo GF";
  if (code.startsWith("gf:")) return `Grupo GF · ${code.slice(3)}`;
  return COURIER_NAMES[code] ?? code.charAt(0).toUpperCase() + code.slice(1);
}

/** El courier vigente o último de la fila y del filtro «Courier», con su nombre. */
export function courierDisplayName(code: string | null | undefined): string {
  const value = (code ?? "").trim().toLowerCase();
  if (!value) return "—";
  if (value === "propio") return "Grupo GF";
  if (value === "por_definir") return "Por definir";
  return dispatchedWithLabel(value);
}

/** El nombre corto, para la fila: el motorizado o el courier. */
export function dispatchedWithShort(code: string): string {
  return code.startsWith("gf:") ? code.slice(3) : dispatchedWithLabel(code);
}

/** Primero los motorizados de Grupo GF, luego los couriers, cada grupo por nombre. */
export function compareDispatchCodes(a: string, b: string): number {
  const ga = a.startsWith("gf") ? 0 : 1;
  const gb = b.startsWith("gf") ? 0 : 1;
  return ga - gb || dispatchedWithLabel(a).localeCompare(dispatchedWithLabel(b), "es");
}
