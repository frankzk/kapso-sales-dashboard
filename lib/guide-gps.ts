// El GPS con el que se generó cada guía Aliclik, en la Actividad y en «Salidas
// y guías» (MOM §6.1 y §25, pedido del owner del 08-11-2026: «que en el
// historial mostremos ese GPS con el que se generó las guías de AliClick…
// solo aparece la anotación de que la guía fue generada, pero no expone el GPS»).
//
// QUÉ ES ESE GPS. La coordenada que Kapta le MANDÓ a Aliclik al crear la guía
// (o la que se cargó en su portal), guardada en `shipments.latitude/longitude`.
// Aliclik la devuelve tal cual en su reporte, así que NO es el GPS del
// motorizado: se rotula «GPS enviado a Aliclik», nunca «ubicación de la
// entrega».
//
// DE DÓNDE SE LEE. Del hecho cuando lo trae (`payload.gps`, desde el
// 08-11-2026) y si no, de la guía del mismo pedido (por `shipment_id` o por el
// código, también el ALC… provisional que queda en `external_order_number`).
// Así sale en TODOS los pedidos sin rellenar datos viejos: la ficha ya lee las
// guías del pedido en una sola consulta (`getOrderMasterDetail`).
//
// Puro y sin dependencias: lo usa la ficha en el navegador. Lo prueba
// `test/guide-gps.test.ts`.

/** De dónde salió la coordenada que se mandó a Aliclik. */
export type GuideGpsSource =
  /** La pegó una persona en «Ubicación» (enlace de Maps o par suelto). */
  | "persona"
  /** La ubicación que la clienta mandó por WhatsApp (Chatby). */
  | "whatsapp"
  /** La dirección escrita, ubicada en Google (el edificio). */
  | "google"
  /** La cuadra de la misma calle en Google (0316, «ubicación aproximada»). */
  | "aproximada"
  /** El GPS de la guía de una entrega anterior de la clienta (regla 0317 o la asesora). */
  | "historial"
  /** La coordenada que trajo el pedido de la tienda (Shopify o WooCommerce). */
  | "pedido_tienda"
  /** La ubicación del pedido, corregida a mano en el Master. */
  | "pedido_manual"
  /** La coordenada del pedido salió de una guía anterior del mismo pedido. */
  | "pedido_guia"
  /** La guía se creó en el portal de Aliclik y se vinculó (o entró por su reporte). */
  | "portal";

export const GUIDE_GPS_SOURCES: readonly GuideGpsSource[] = [
  "persona",
  "whatsapp",
  "google",
  "aproximada",
  "historial",
  "pedido_tienda",
  "pedido_manual",
  "pedido_guia",
  "portal",
];

export interface GuideGps {
  lat: number;
  lng: number;
  /** null: una guía de antes del 08-11-2026 que no lo dejó escrito. */
  source: GuideGpsSource | null;
  /** Con `historial`: el pedido entregado del que salió el GPS. */
  fromOrderId?: string | null;
  fromOrderName?: string | null;
}

/** Los hechos que dicen «se creó (o se vinculó) la guía». */
export const GUIDE_GPS_EVENT_KINDS: ReadonlySet<string> = new Set(["guide_registered", "guide_created"]);

/** El rótulo: lo que Kapta mandó, no el GPS del motorizado. */
export const GUIDE_GPS_PREFIX = "GPS enviado a Aliclik";

function num(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Number(String(value).trim());
  return Number.isFinite(n) ? n : null;
}

/** Una coordenada que se puede enseñar: finita, en rango y que no sea el 0,0 de un campo vacío. */
export function gpsPoint(lat: unknown, lng: unknown): { lat: number; lng: number } | null {
  const a = num(lat);
  const b = num(lng);
  if (a === null || b === null) return null;
  if (Math.abs(a) > 90 || Math.abs(b) > 180) return null;
  if (a === 0 && b === 0) return null;
  return { lat: a, lng: b };
}

/** «-13.53382, -71.92565»: cinco decimales (~1 m), lo que se lee y se dicta. */
export function formatGpsCoordinate(lat: number, lng: number): string {
  return `${round5(lat)}, ${round5(lng)}`;
}

/** `toFixed` sobre el binario redondea mal los medios (-71.9256485 → …564); esto no. */
function round5(n: number): string {
  const sign = n < 0 ? "-" : "";
  const shifted = Number(`${Math.abs(n)}e5`);
  if (!Number.isFinite(shifted)) return n.toFixed(5);
  const scaled = Math.round(shifted);
  if (scaled === 0) return "0.00000";
  const text = String(scaled).padStart(6, "0");
  const int = text.slice(0, -5);
  return `${sign}${int}.${text.slice(-5)}`;
}

/** El enlace de Google Maps, con la coordenada entera (sin redondear). */
export function gpsMapsUrl(lat: number, lng: number): string {
  return `https://www.google.com/maps?q=${lat},${lng}`;
}

/** De dónde salió, en palabras. null si no se sabe (guías de antes del 08-11-2026). */
export function gpsSourceLabel(gps: Pick<GuideGps, "source" | "fromOrderName">): string | null {
  switch (gps.source) {
    case "persona":
      return "pegado por una persona";
    case "whatsapp":
      return "ubicación de WhatsApp";
    case "google":
      return "dirección ubicada en Google";
    case "aproximada":
      return "ubicación aproximada (Google)";
    case "historial": {
      const from = gps.fromOrderName?.trim();
      return from ? `GPS de la entrega de ${from}` : "GPS de una entrega anterior";
    }
    case "pedido_tienda":
      return "coordenada del pedido de la tienda";
    case "pedido_manual":
      return "ubicación corregida a mano en el pedido";
    case "pedido_guia":
      return "coordenada de una guía anterior del pedido";
    case "portal":
      return "cargado en el portal de Aliclik";
    default:
      return null;
  }
}

/** La línea completa en texto: «GPS enviado a Aliclik: -13.53382, -71.92565 · GPS de la entrega de #KP131756». */
export function guideGpsText(gps: GuideGps): string {
  const source = gpsSourceLabel(gps);
  return `${GUIDE_GPS_PREFIX}: ${formatGpsCoordinate(gps.lat, gps.lng)}${source ? ` · ${source}` : ""}`;
}

/** Lo que queda en `order_events.payload.gps` al crear la guía: el hecho se explica solo. */
export function guideGpsPayload(gps: GuideGps): Record<string, unknown> {
  return {
    lat: gps.lat,
    lng: gps.lng,
    source: gps.source,
    ...(gps.fromOrderId ? { from_order_id: gps.fromOrderId } : {}),
    ...(gps.fromOrderName ? { from_order_name: gps.fromOrderName } : {}),
  };
}

const asSource = (value: unknown): GuideGpsSource | null =>
  typeof value === "string" && (GUIDE_GPS_SOURCES as readonly string[]).includes(value) ? (value as GuideGpsSource) : null;

const asText = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.trim() : null);

/**
 * Lo que el hecho dice del GPS. `payload.gps` (desde el 08-11-2026) trae todo;
 * la guía de la regla 0317 de antes trae solo `payload.auto.gps_from` (el
 * pedido), sin la coordenada, que entonces sale de la guía.
 */
export function guideGpsFromPayload(payload: unknown): {
  point: { lat: number; lng: number } | null;
  source: GuideGpsSource | null;
  fromOrderId: string | null;
  fromOrderName: string | null;
} | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  const gps = p.gps && typeof p.gps === "object" ? (p.gps as Record<string, unknown>) : null;
  if (gps) {
    return {
      point: gpsPoint(gps.lat, gps.lng),
      source: asSource(gps.source),
      fromOrderId: asText(gps.from_order_id),
      fromOrderName: asText(gps.from_order_name),
    };
  }
  const auto = p.auto && typeof p.auto === "object" ? (p.auto as Record<string, unknown>) : null;
  const from = asText(auto?.gps_from);
  if (from) return { point: null, source: "historial", fromOrderId: null, fromOrderName: from };
  return null;
}

/** Cómo llegó la guía, cuando el hecho no lo dice: las del portal (o del reporte) no las armó Kapta. */
export function gpsSourceFromCreatedVia(createdVia: string | null | undefined): GuideGpsSource | null {
  const via = (createdVia ?? "").trim();
  if (via === "aliclik_api") return null;
  // `aliclik_external_link`, `aliclik_external_portal_link` y las que entraron
  // por el reporte de Aliclik sin pasar por Kapta (`created_via` vacío).
  return "portal";
}

/** La coordenada del pedido que tomó la guía, según quién la puso en el pedido (`geo_source`). */
export function gpsSourceFromGeoSource(geoSource: string | null | undefined): GuideGpsSource | null {
  switch ((geoSource ?? "").trim()) {
    case "shopify":
      return "pedido_tienda";
    case "manual":
      return "pedido_manual";
    case "courier":
      return "pedido_guia";
    default:
      return null;
  }
}

/**
 * De dónde salió el GPS que se manda a Aliclik, cuando lo sabe quien llama y
 * no el navegador: la pasada de Chatby (WhatsApp, Google, aproximada o el GPS
 * de una entrega anterior), el reintento de Lima con Google, o la entrega
 * anterior que eligió la asesora, ya comprobada por la acción
 * (`createAliclikGuideFor`, lib/aliclik-guide.ts).
 */
export interface GuideGpsOrigin {
  source: GuideGpsSource;
  fromOrderId?: string | null;
  fromOrderName?: string | null;
}

/**
 * El GPS que queda en el hecho `guide_registered` (`payload.gps`, MOM §25):
 * la coordenada que se mandó y de dónde salió. Pura y exportada para probarla.
 */
export function guideGpsForCreation(input: {
  coordinate: { lat: string | number; lng: string | number };
  typed: boolean;
  fromWhatsapp?: boolean;
  automatic: boolean;
  geoSource: string | null | undefined;
  known?: GuideGpsOrigin | null;
}): GuideGps {
  const base = { lat: Number(input.coordinate.lat), lng: Number(input.coordinate.lng) };
  if (input.known) {
    return { ...base, source: input.known.source, fromOrderId: input.known.fromOrderId ?? null, fromOrderName: input.known.fromOrderName ?? null };
  }
  // Escrita en el campo: la pegó la asesora (o eligió la de WhatsApp). Una
  // automática que la escribe sin decir de dónde, queda sin origen.
  if (input.typed) return { ...base, source: input.automatic ? null : input.fromWhatsapp ? "whatsapp" : "persona" };
  // La del pedido: según quién la puso ahí.
  return { ...base, source: gpsSourceFromGeoSource(input.geoSource) };
}

// ---------------------------------------------------------------------------
// El cruce con las guías del pedido
// ---------------------------------------------------------------------------

export interface GuideGpsEvent {
  id: string;
  kind: string;
  source?: string | null;
  courier?: string | null;
  guide_code?: string | null;
  shipment_id?: string | null;
  occurred_at?: string | null;
  payload?: unknown;
}

export interface GuideGpsShipment {
  id: string;
  courier: string | null;
  guide_code: string | null;
  external_order_number?: string | null;
  latitude: number | string | null;
  longitude: number | string | null;
  created_via?: string | null;
}

const codeKey = (v: string | null | undefined) => (v ?? "").trim().toUpperCase();
const isAliclik = (v: string | null | undefined) => (v ?? "").trim().toLowerCase() === "aliclik";

/** La guía Aliclik del hecho: por su `shipment_id` o por su código (también el ALC… provisional). */
function shipmentOf(event: GuideGpsEvent, shipments: readonly GuideGpsShipment[]): GuideGpsShipment | null {
  const aliclik = shipments.filter((s) => isAliclik(s.courier));
  if (event.shipment_id) {
    const byId = aliclik.find((s) => s.id === event.shipment_id);
    if (byId) return byId;
  }
  const code = codeKey(event.guide_code);
  if (!code) return null;
  return aliclik.find((s) => codeKey(s.guide_code) === code || codeKey(s.external_order_number) === code) ?? null;
}

/** ¿Es un hecho de guía Aliclik? El tipo y que sea de Aliclik (por el hecho o por su guía). */
function isAliclikGuideEvent(event: GuideGpsEvent, shipment: GuideGpsShipment | null): boolean {
  if (!GUIDE_GPS_EVENT_KINDS.has(event.kind)) return false;
  return isAliclik(event.courier) || isAliclik(event.source) || Boolean(shipment);
}

/**
 * El GPS de cada hecho de guía Aliclik, por id del hecho. La coordenada del
 * payload manda (es la que se mandó); sin ella, la de la guía. El origen: el
 * del payload, y si no, el de la guía del portal. Sin coordenada, no hay línea.
 */
export function guideGpsByEvent(
  events: readonly GuideGpsEvent[],
  shipments: readonly GuideGpsShipment[],
): Map<string, GuideGps> {
  const out = new Map<string, GuideGps>();
  for (const event of events) {
    const shipment = shipmentOf(event, shipments);
    if (!isAliclikGuideEvent(event, shipment)) continue;
    const fromPayload = guideGpsFromPayload(event.payload);
    const point = fromPayload?.point ?? (shipment ? gpsPoint(shipment.latitude, shipment.longitude) : null);
    if (!point) continue;
    const source = fromPayload?.source ?? (shipment ? gpsSourceFromCreatedVia(shipment.created_via) : null);
    out.set(event.id, {
      ...point,
      source,
      fromOrderId: fromPayload?.fromOrderId ?? null,
      fromOrderName: fromPayload?.fromOrderName ?? null,
    });
  }
  return out;
}

/**
 * El GPS de cada guía Aliclik del pedido, por id de la guía, para «Salidas y
 * guías». El origen sale del último hecho de creación de esa guía; sin él, el
 * de la guía (portal) o ninguno.
 */
export function guideGpsByShipment(
  events: readonly GuideGpsEvent[],
  shipments: readonly GuideGpsShipment[],
): Map<string, GuideGps> {
  const byEvent = guideGpsByEvent(events, shipments);
  const out = new Map<string, GuideGps>();
  for (const s of shipments) {
    if (!isAliclik(s.courier)) continue;
    const own = gpsPoint(s.latitude, s.longitude);
    const facts = events
      .filter((e) => byEvent.has(e.id) && shipmentOf(e, shipments)?.id === s.id)
      .sort((a, b) => ((a.occurred_at ?? "") < (b.occurred_at ?? "") ? -1 : 1));
    const fact = facts.length ? byEvent.get(facts[facts.length - 1]!.id)! : null;
    // La coordenada que tiene hoy la guía; el origen, el del hecho. Si la guía
    // la perdió, la del hecho.
    const point = own ?? (fact ? { lat: fact.lat, lng: fact.lng } : null);
    if (!point) continue;
    const sameAsFact = fact && Math.abs(fact.lat - point.lat) < 1e-6 && Math.abs(fact.lng - point.lng) < 1e-6;
    out.set(s.id, {
      ...point,
      source: sameAsFact ? fact!.source : fact ? null : gpsSourceFromCreatedVia(s.created_via),
      fromOrderId: sameAsFact ? fact!.fromOrderId ?? null : null,
      fromOrderName: sameAsFact ? fact!.fromOrderName ?? null : null,
    });
  }
  return out;
}

/** «02-09»: el día y el mes en Lima, como se escriben en la operación. */
export function limaDayMonth(iso: string | null | undefined): string | null {
  const at = Date.parse(iso ?? "");
  if (!Number.isFinite(at)) return null;
  // Lima no cambia de hora: UTC−5 todo el año (y así no depende del ICU del entorno).
  const lima = new Date(at - 5 * 60 * 60 * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(lima.getUTCDate())}-${pad(lima.getUTCMonth() + 1)}`;
}

/**
 * ¿El mismo punto? Con la precisión que viaja a Aliclik (7 decimales). Así se
 * sabe si la asesora cambió el campo después de pulsar «Usar este GPS».
 */
export function sameGpsPoint(
  a: { lat: number; lng: number } | null | undefined,
  b: { lat: number; lng: number } | null | undefined,
): boolean {
  if (!a || !b) return false;
  return Math.abs(a.lat - b.lat) < 1e-7 && Math.abs(a.lng - b.lng) < 1e-7;
}
