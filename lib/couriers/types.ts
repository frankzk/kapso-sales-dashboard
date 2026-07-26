// Contrato de los adaptadores de courier. Puro: sin base de datos, sin red.
//
// La especificación (§5, §19.12) insiste en que cada courier entrega la
// información a su manera — Excel, CSV, capturas, documentos, reportes manuales,
// y algún día una API — y que la arquitectura no debe depender de un formato.
// De ahí este contrato: cada courier aporta un adaptador que traduce SU formato
// a un registro canónico, y el resto del sistema (vinculación con el pedido,
// escritura de guías, auditoría, recálculo del Master) es común a todos.
//
// Añadir un courier nuevo = un archivo en lib/couriers/ + una línea en el
// registro. No se toca la ingesta.

/**
 * Un registro de reporte ya normalizado. Todos los campos son opcionales salvo
 * `raw`: un courier que solo informa "guía X entregada" es perfectamente válido.
 */
export interface CanonicalReportRow {
  /** Guía o código de seguimiento del courier. Identificador prioritario. */
  guide_code: string | null;
  /** Nº de pedido de Shopify, normalizado a "#KP114985". Identificador prioritario. */
  order_name: string | null;
  /**
   * false cuando `order_name` es una conjetura (p. ej. un número suelto extraído
   * de un texto libre): el emparejador debe validarla con el teléfono antes de
   * fiarse. Ver lib/shipment-match.ts.
   */
  order_name_confirmed: boolean;
  customer_name: string | null;
  customer_phone: string | null; // normalizado con lib/phone.ts
  product: string | null;
  district: string | null;
  province: string | null;
  region: string | null;
  delivery_address: string | null;
  delivery_reference: string | null;
  /** Estado normalizado de la guía: pendiente | en_ruta | entregado | anulado. */
  delivery_status: string;
  /** Lo que decía el reporte, literal — para poder auditar la normalización. */
  reported_status: string | null;
  /** Sub-estado de agencia (§10), del catálogo de lib/order-status.ts. */
  pickup_state: string | null;
  attempts: number | null;
  non_delivery_reason: string | null;
  assigned_at: string | null;
  dispatched_at: string | null;
  out_for_delivery_at: string | null;
  rescheduled_at: string | null;
  closed_at: string | null;
  returned_at: string | null;
  agency_branch: string | null;
  agency_arrived_at: string | null;
  agency_expires_at: string | null;
  /** Costo logístico informado por el courier, cuando viene en el reporte. */
  cost: number | null;
  /** Pista de tienda ("AURELA" / "KENKU") cuando el reporte la trae. */
  store_hint: string | null;
  /** La fila original, tal cual. Se conserva en `import_rows.raw` (§19.8). */
  raw: Record<string, string>;
}

/** Valores por defecto: un adaptador solo rellena lo que su formato aporta. */
export function emptyReportRow(raw: Record<string, string> = {}): CanonicalReportRow {
  return {
    guide_code: null,
    order_name: null,
    order_name_confirmed: false,
    customer_name: null,
    customer_phone: null,
    product: null,
    district: null,
    province: null,
    region: null,
    delivery_address: null,
    delivery_reference: null,
    delivery_status: "pendiente",
    reported_status: null,
    pickup_state: null,
    attempts: null,
    non_delivery_reason: null,
    assigned_at: null,
    dispatched_at: null,
    out_for_delivery_at: null,
    rescheduled_at: null,
    closed_at: null,
    returned_at: null,
    agency_branch: null,
    agency_arrived_at: null,
    agency_expires_at: null,
    cost: null,
    store_hint: null,
    raw,
  };
}

export interface CourierAdapter {
  /** Identificador estable: es el valor que va a `shipments.courier`. */
  id: string;
  label: string;
  /** Si el courier entrega físicamente en agencia (Shalom, Olva) en vez de a domicilio. */
  agency: boolean;
  /**
   * Traduce las filas ya leídas del archivo (por lib/xlsx o lib/csv-parse) a
   * registros canónicos. PURA: mismas filas → mismo resultado.
   */
  parse: (rows: Record<string, string>[]) => CanonicalReportRow[];
  /**
   * Pista para elegir adaptador cuando el operador no lo indica: cuántas de las
   * primeras filas reconoce como suyas (0 = no es su formato). Permite detectar
   * el formato en vez de obligar a elegirlo en un desplegable.
   */
  score: (rows: Record<string, string>[]) => number;
}
