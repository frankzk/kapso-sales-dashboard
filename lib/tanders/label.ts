// El rótulo de envío de Tanders, compuesto por nosotros.
//
// Tanders NO tiene endpoint de PDF: su panel arma el rótulo en el navegador y lo
// descarga como `rotulos-tander-<epoch>.pdf`. Su API solo ofrece dos piezas:
//
//   GET   /external/generate-qr?text=…            (otro host, sin auth)
//   PATCH /orders/me/{id}/label {generated:true}  → marca "Rótulo generado"
//
// El QR codifica literalmente el N° de seguimiento, así que se genera en local
// con la librería que el proyecto ya usa para las claves de recojo — una llamada
// menos a un endpoint de terceros no documentado, y el rótulo se puede imprimir
// aunque ese host esté caído.
//
// Los datos salen de `tanders_raw`: es lo que Tanders tiene de verdad, no lo que
// nosotros creemos haberle mandado. Si un rótulo y su panel se contradijeran,
// gana el panel — es el que ve el repartidor.

/** Un rótulo listo para pintar. Todo ya resuelto y formateado. */
export interface TandersLabel {
  trackingCode: string;
  recipientName: string;
  recipientPhone: string;
  destination: string;
  origin: string;
  packageType: string;
  weightGrams: number;
  /** Formateado con dos decimales; "" cuando no hay cobro. */
  collectionAmount: string;
  note: string;
  status: string;
  /** dd/m/yyyy, como su rótulo. */
  createdAt: string;
}

/** Fila de `shipments` con lo que hace falta para el rótulo. */
export interface LabelShipment {
  guide_code: string;
  customer_name: string | null;
  customer_phone: string | null;
  delivery_address: string | null;
  delivery_reference: string | null;
  tanders_raw: Record<string, unknown> | null;
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/** Teléfono como lo muestra su rótulo: 9 dígitos, sin prefijo. */
function localPhone(raw: string | null | undefined): string {
  const d = String(raw ?? "").replace(/\D+/g, "");
  return d.startsWith("51") && d.length === 11 ? d.slice(2) : d;
}

/** dd/m/yyyy en hora de Lima — la zona en la que opera el almacén. */
function limaDate(iso: string | null | undefined): string {
  const d = iso ? new Date(iso) : new Date();
  if (Number.isNaN(+d)) return "";
  const parts = new Intl.DateTimeFormat("es-PE", {
    timeZone: "America/Lima",
    day: "numeric",
    month: "numeric",
    year: "numeric",
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("day")}/${get("month")}/${get("year")}`;
}

/**
 * Compone el rótulo. Prioriza `tanders_raw` sobre las columnas propias: la
 * columna es nuestra copia y el raw es la fuente. El importe llega como texto
 * ("198.00") o número según el campo, así que se normaliza a dos decimales.
 */
export function buildTandersLabel(shipment: LabelShipment): TandersLabel {
  const raw = shipment.tanders_raw ?? {};

  const amountRaw = raw.collectionAmount;
  const amount =
    typeof amountRaw === "number"
      ? amountRaw
      : typeof amountRaw === "string"
        ? Number(amountRaw)
        : NaN;

  return {
    trackingCode: str(raw.aliclikOrderNumber) || shipment.guide_code,
    recipientName: str(raw.recipientFullName) || str(shipment.customer_name),
    recipientPhone: localPhone(str(raw.recipientPhone) || shipment.customer_phone),
    destination: str(raw.destination) || str(shipment.delivery_address),
    origin: str(raw.origin),
    packageType: str(raw.packageType) || "XXS",
    weightGrams: typeof raw.weightGrams === "number" ? raw.weightGrams : 100,
    collectionAmount: Number.isFinite(amount) && amount > 0 ? amount.toFixed(2) : "",
    note: str(raw.note) || str(shipment.delivery_reference),
    status: str(raw.status) || "PENDING",
    createdAt: limaDate(str(raw.createdAt) || null),
  };
}
