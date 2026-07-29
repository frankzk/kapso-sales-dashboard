// Quién es cada courier. Deliberadamente separado de lib/couriers/registry.ts:
// ese registro es de ADAPTADORES DE REPORTE — quién sabe traducir un Excel a
// guías— y no todos los couriers mandan uno.
//
// La confusión costaba cosas visibles: `courierLabel()` solo conocía a los tres
// que traen adaptador, así que Fénix, Tanders y Axel se pintaban en la interfaz
// con su id en crudo ("axel"), y "¿qué couriers existen?" no tenía respuesta en
// ningún sitio del código. Axel es el caso extremo: reparte todo Lima
// Metropolitana y no manda ningún reporte de guías — solo su liquidación diaria
// (lib/settlements/axel.ts) — así que jamás va a tener adaptador, y sin embargo
// es tan courier como Aliclik.
//
// `id` es el valor que va a `shipments.courier`: cambiarlo desliga las guías ya
// escritas de su courier, y las tarifas de Costos dejan de resolver.

export interface CourierInfo {
  /** Identificador estable. Es lo que se guarda en `shipments.courier`. */
  id: string;
  label: string;
  /** Entrega en sucursal y el cliente recoge (§10) en vez de a domicilio. */
  agency: boolean;
  /**
   * Se le puede crear una guía DIRECTA desde un pedido, sin guía madre. Es una
   * decisión operativa, no técnica: son los couriers a los que el equipo
   * despacha por su cuenta, en vez de recibir la guía ya creada por una API o
   * por el reporte del propio courier.
   */
  direct: boolean;
}

export const COURIERS: CourierInfo[] = [
  { id: "aliclik", label: "Aliclik", agency: false, direct: false },
  { id: "fenix", label: "Fenix", agency: false, direct: true },
  // Lima Metropolitana y Callao. Cobra por entrega (su columna GANANCIA) y
  // liquida en efectivo el mismo día; no emite reporte de guías.
  { id: "axel", label: "Axel Courier", agency: false, direct: true },
  { id: "tanders", label: "Tanders", agency: false, direct: false },
  { id: "shalom", label: "Shalom", agency: true, direct: false },
  { id: "olva", label: "Olva", agency: true, direct: false },
];

const BY_ID = new Map(COURIERS.map((c) => [c.id, c]));

export function courierInfo(id: string | null | undefined): CourierInfo | null {
  return id ? (BY_ID.get(id.toLowerCase()) ?? null) : null;
}

/** Nombre presentable. Cae al id en crudo antes que a un vacío: un courier que
 *  todavía no está en el catálogo debe verse, no desaparecer. */
export function courierName(id: string | null | undefined): string {
  return courierInfo(id)?.label ?? (id ?? "—");
}

/** Couriers a los que se les puede crear una guía directa desde un pedido. */
export const DIRECT_GUIDE_COURIERS: CourierInfo[] = COURIERS.filter((c) => c.direct);

export function isDirectGuideCourier(id: string | null | undefined): boolean {
  return courierInfo(id)?.direct ?? false;
}

/** Ids de los couriers de agencia. Fuente única de lib/order-status.ts. */
export const AGENCY_COURIER_IDS: string[] = COURIERS.filter((c) => c.agency).map((c) => c.id);
