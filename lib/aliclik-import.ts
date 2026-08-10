// Parse an Aliclik delivery report (already read into row objects by lib/csv-parse
// or lib/xlsx) into a canonical shape. Pure + tested. Tolerant header matching
// (lowercase/trim/accents). The AUR5X guide code is detected BY VALUE (any cell
// starting with AUR5X), so it works regardless of which column holds it —
// Aliclik exports vary ("GUÍA ALICLICK" in some, "NRO. PEDIDO" in others).

import { normalizePhone } from "./phone";
import { isFenixCity, normalizeCity } from "./shipments";
import { mapAliclikStatus } from "./aliclik-status";

export interface ParsedShipmentRow {
  guide_code: string | null; // AUR5X… (required to be a real row)
  order_name: string | null; // normalized "#KP114985" (Shopify ref, when present)
  order_name_confirmed: boolean; // false when order_name is an unconfirmed bare-number
  // guess from free text (NOTA) — the matcher must cross-validate it (phone)
  // before trusting it; true when a literal "KP" token was found.
  customer_name: string | null;
  customer_phone: string | null; // normalized
  product: string | null;
  district: string | null;
  province: string | null; // exact PROVINCIA value from the Aliclik report
  city: string | null; // normalized coverage key (Fenix city when covered)
  region: string | null;
  delivery_address: string | null;
  delivery_reference: string | null;
  latitude: number | null;
  longitude: number | null;
  delivery_status: string; // canonical code
  // El paquete volvió al origen. Va aparte de delivery_status porque el
  // vocabulario de guías no tiene código `devuelto`: la guía se cierra como
  // "anulado" y este flag es lo que la ingesta convierte en `returned_at`, que
  // es de donde sale el `devuelto` del PEDIDO.
  returned: boolean;
  // FECHA DESPACHO del reporte (YYYY-MM-DD). El parser solo informa lo que dice
  // el fichero; quién y cuándo lo convierte en `dispatched_at` lo decide la
  // ingesta, porque esa columna alimenta métricas de despacho (MOM §17.1).
  dispatch_date: string | null;
  store_hint: string | null; // raw "Tienda"/"Canal" value (AURELA / KENKU)
  // Aliclik's own delivery-attempt counter and operative delivery date. These
  // are intentionally separate from reroute_attempts, which counts the team's
  // calls inside the dashboard.
  aliclik_attempts: number | null;
  aliclik_service_date: string | null; // YYYY-MM-DD
  raw: Record<string, string>;
}

function stripAccents(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

/** Canonical header key: lowercased, de-accented, collapsed whitespace. */
function headerKey(h: string): string {
  return stripAccents(h.trim().toLowerCase()).replace(/\s+/g, " ");
}

/** Build a normalized header→value lookup (first non-empty value per key wins). */
function buildLookup(raw: Record<string, string>): Map<string, string> {
  const map = new Map<string, string>();
  for (const [h, v] of Object.entries(raw)) {
    const k = headerKey(h);
    if (v != null && String(v).trim() && !map.has(k)) map.set(k, String(v).trim());
  }
  return map;
}

/** First non-empty value among the given alias keys. */
function pick(map: Map<string, string>, keys: string[]): string | null {
  for (const k of keys) {
    const v = map.get(k);
    if (v && v.trim()) return v.trim();
  }
  return null;
}

// The guide code is always an AUR5X… token; detect it by value, not by header.
const GUIDE_RE = /AUR5X[A-Za-z0-9]+/i;
function findGuideCode(raw: Record<string, string>): string | null {
  for (const v of Object.values(raw)) {
    const m = String(v ?? "").match(GUIDE_RE);
    if (m) return m[0].toUpperCase();
  }
  return null;
}

// A Shopify order name looks like "#KP114985". The Aliclik "NOTA" field often
// carries it (esp. for Kenku) mixed with reference text, so we extract the token.
const KP_RE = /#?\s*(KP\d[A-Za-z0-9-]*)/i;
// Aurela's own Shopify order.name prefix is "AUR" (e.g. "#AUR173123") — a real,
// deliberate order reference, just like "KP" is for Kenku. The literal "#" is
// required (unlike KP, where it's optional) and at least 4 digits must follow
// "AUR" immediately: the AUR5X… guide code has a letter ("X") right after the
// leading digit, so it can never satisfy \d{4,} here — no collision risk.
const AUR_ORDER_RE = /#\s*(AUR\d{4,}[A-Za-z0-9-]*)/i;
// Sometimes NOTA has just the bare order number (no "KP"/"AUR" prefix), e.g.
// "119358 - referencia". A standalone 6-digit run is our best guess, but free
// text can coincidentally contain unrelated 6-digit numbers — so this is
// returned UNCONFIRMED; the matcher only trusts it after cross-validating a
// second signal (the customer phone) against the guessed order.
const BARE_ORDER_RE = /\b(\d{6})\b/;

interface ExtractedOrderRef {
  name: string | null;
  confirmed: boolean;
}

/**
 * El número de pedido que lleva escrito el propio código de guía.
 *
 * Aliclik numera `AUR5X` + el número del pedido: AUR5X121336 es de #KP121336 y
 * AUR5X174316 de #AUR174316 — se cumple en las dos tiendas y en todas las guías
 * comprobadas. Es la mejor pista que traen estas filas, y no se estaba usando.
 *
 * Vuelve SIN CONFIRMAR a propósito, aunque el patrón acierte siempre en los
 * datos de hoy: es una convención del courier, no una garantía, así que el
 * emparejador solo la aceptará si el TELÉFONO del cliente también apunta a ese
 * mismo pedido. Dos señales independientes que coinciden es lo que faltaba —el
 * respaldo por teléfono a secas amontonó 15 guías en pedidos ajenos, todas de
 * clientes con más de un pedido, mientras el número correcto venía escrito en el
 * código de la guía.
 */
export function orderNameFromGuideCode(
  guideCode: string | null | undefined,
  orderPrefix: string | null | undefined,
): string | null {
  const prefix = String(orderPrefix ?? "").trim().replace(/^#/, "").toUpperCase();
  if (!prefix) return null;
  const m = String(guideCode ?? "").trim().toUpperCase().match(/^AUR5X(\d{5,})$/);
  return m && m[1] ? `#${prefix}${m[1]}` : null;
}

function extractOrderReference(
  nota: string | null | undefined,
  orderColumnValue: string | null | undefined,
  orderPrefix: string | null | undefined,
  guideCode: string | null | undefined,
): ExtractedOrderRef {
  for (const v of [nota, orderColumnValue]) {
    if (!v) continue;
    const s = String(v);
    const kp = s.match(KP_RE);
    if (kp && kp[1]) return { name: "#" + kp[1].toUpperCase(), confirmed: true };
    const aur = s.match(AUR_ORDER_RE);
    if (aur && aur[1]) return { name: "#" + aur[1].toUpperCase(), confirmed: true };
  }
  // El número pelado se completa con el prefijo de LA TIENDA que está
  // importando, no con uno fijo. Antes acá había "#KP" hardcodeado: para Kenku
  // acertaba de casualidad y para Aurela fabricaba un pedido inexistente que
  // además desviaba la búsqueda del auto-match a la otra tienda
  // (`pickStoresForOrderQuery` enruta por el prefijo).
  //
  // Sin prefijo conocido NO se adivina. Un nombre sin prefijo no serviría para
  // enrutar, y ponerle el de otra tienda es peor que no poner nada: convierte
  // "no sé de quién es" en "es de aquella", que es una respuesta falsa.
  const prefix = String(orderPrefix ?? "").trim().replace(/^#/, "").toUpperCase();
  if (!prefix) return { name: null, confirmed: false };
  const m = nota ? String(nota).match(BARE_ORDER_RE) : null;
  if (m && m[1]) return { name: `#${prefix}${m[1]}`, confirmed: false };
  // Último recurso, y el más fiable de los no confirmados: el número que lleva
  // el propio código de guía. Va detrás de la NOTA porque ahí el número lo
  // escribió una persona sobre ESTE envío; el del código es una convención del
  // courier. Los dos se cotejan contra el teléfono antes de vincular nada.
  const fromGuide = orderNameFromGuideCode(guideCode, prefix);
  if (fromGuide) return { name: fromGuide, confirmed: false };
  return { name: null, confirmed: false };
}

/** De dónde sale el prefijo al parsear. `orderPrefix` es el de
 *  `stores.order_prefix` (0115); sin él, un número suelto no se convierte en
 *  pedido. */
export interface AliclikParseOpts {
  orderPrefix?: string | null;
}

/** Normalize a Shopify-style order name to the "#KP114985" form (used by the
 *  matcher to compare both sides consistently). */
export function normalizeOrderName(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const t = String(raw).trim();
  if (!t) return null;
  const m = t.match(/#?\s*([A-Za-z]*\d[A-Za-z0-9-]*)/);
  if (!m || !m[1]) return null;
  return "#" + m[1].toUpperCase();
}

// Header aliases per canonical field (normalized keys).
const NAME_KEYS = ["nombre completo", "nombre", "cliente", "destinatario"];
const PHONE_KEYS = ["telefono", "celular", "telefono / celular", "whatsapp"];
const PRODUCT_KEYS = ["producto", "productos"];
const DISTRICT_KEYS = ["distrito"];
const PROVINCE_KEYS = ["provincia"];
const DEPARTMENT_KEYS = ["departamento", "region"];
const STORE_KEYS = ["tienda", "canal", "marca", "proveedor"];
const ORDER_KEYS = ["pedido", "numero de pedido", "n pedido", "orden", "order"];
const ALICLIK_ATTEMPT_KEYS = ["nro. intentos", "nro intentos", "numero de intentos", "intentos"];
const ALICLIK_SERVICE_DATE_KEYS = [
  "fecha entrega",
  "fecha de entrega",
  "fecha en ruta",
  "fecha de visita",
  "fecha de despacho",
];
const ADDRESS_KEYS = [
  "direccion completa",
  "direccion de entrega",
  "direccion entrega",
  "direccion destino",
  "direccion",
  "domicilio",
];
const REFERENCE_KEYS = ["referencia de entrega", "referencia entrega", "referencia", "ref"];
const LATITUDE_KEYS = ["latitud", "latitude"];
const LONGITUDE_KEYS = ["longitud", "longitude", "lng", "lon"];
// The customer-facing delivery outcome ("ESTADO [DE] ENTREGA") and the dispatch
// column ("ESTADO [DE] DESPACHO"). Both feed the status classification below.
// Header drifts between exports; a bare "ESTADO" is a last-resort fallback for
// ENTREGA (only ever fires as "entregado", so a dispatch-state "ESTADO" won't be
// misread as delivered).
const ENTREGA_KEYS = ["estado entrega", "estado de entrega", "estado"];
// El despacho EN ESPAÑOL, que es lo que alimenta el mapeo del trío. Ver
// deliveryStatusFromReport para por qué la variante inglesa queda fuera de aquí.
const DESPACHO_KEYS = ["estado despacho", "estado de despacho"];

/** True when the delivery-outcome cell ("ESTADO [DE] ENTREGA") says delivered. */
function isDeliveredEntrega(raw: string | null): boolean {
  if (!raw) return false;
  return stripAccents(raw.trim().toLowerCase()) === "entregado";
}

// ── Estado de la guía desde el reporte de Aliclik ───────────────────────────
//
// El Excel trae los estados en ESPAÑOL (ESTADO ENTREGA / DESPACHO / LLAMADA); la
// API de Aliclik expone esos mismos estados como enums en inglés, y
// mapAliclikStatus (lib/aliclik-status.ts) ya resuelve el trío al vocabulario
// canónico (pendiente | en_ruta | entregado | anulado) con toda la precedencia
// probada: ENTREGADO manda, DEVUELTO y CANCELADO cierran, RECHAZADO/NO CONTESTA/
// REPROGRAMADO siguen en calle, y el despacho afina el resto. Para no duplicar
// ese cerebro, aquí solo se TRADUCE español→enum y se delega en él.
//
// OJO: las columnas inglesas "ÚLTIMO ESTADO …" del propio Excel NO se usan — son
// un snapshot rezagado que contradice al español (un pedido ENTREGADO aparece
// ahí como PENDING_DELIVERY). El español de ESTADO ENTREGA/DESPACHO es la fuente
// autoritativa del estado actual.

/** Clave de comparación de un enum en español: sin acentos, mayúsculas,
 *  espacios colapsados ("Remanente en tránsito" → "REMANENTE EN TRANSITO"). */
function enumKey(v: string | null | undefined): string {
  return stripAccents(String(v ?? "").trim().toUpperCase()).replace(/\s+/g, " ");
}

/** ESTADO ENTREGA (español) → `status` de la API. */
const ENTREGA_TO_STATUS: Record<string, string> = {
  ENTREGADO: "DELIVERED",
  "POR ENTREGAR": "PENDING_DELIVERY",
  CANCELADO: "CANCEL",
  ANULADO: "ANNULLED",
  RECHAZADO: "REFUSED",
  "NO CONTESTA": "NOT_RESPOND",
  REPROGRAMADO: "RESCHEDULED",
};

/** ESTADO DESPACHO (español) → `dispatchStatus` de la API. */
const DESPACHO_TO_DISPATCH: Record<string, string> = {
  "POR PREPARAR": "TO_PREPARE",
  VALIDADO: "PREPARED",
  RECOLECTADO: "PICKED",
  "EN TRANSITO": "IN_TRANSIT",
  "REMANENTE EN TRANSITO": "REMAINING_IN_TRANSIT",
  "ALMACEN CENTRAL": "STORE_CENTRAL",
  "POR DEVOLVER": "TO_RETURN",
  DEVUELTO: "RETURNED",
  "EN AGENCIA": "IN_AGENCY",
  "DEJADO EN ALMACEN": "LEFT_IN_WAREHOUSE",
};

/** ESTADO LLAMADA (español) → `callStatus` de la API. */
const LLAMADA_TO_CALL: Record<string, string> = {
  CONFIRMADO: "CONFIRMED",
  IMPORTADO: "IMPORTED",
};

/**
 * Estado canónico de la guía a partir de las columnas del reporte de Aliclik.
 * Traduce español→enum y delega en mapAliclikStatus. Si Aliclik no da ninguna
 * señal reconocible, cae al binario histórico entregado-vs-pendiente para no
 * inventar un estado a partir de un valor que no conocemos. Pura.
 */
export function deliveryStatusFromReport(
  entrega: string | null,
  despacho: string | null,
  llamada: string | null,
): string {
  const mapped = mapAliclikStatus({
    status: ENTREGA_TO_STATUS[enumKey(entrega)],
    dispatchStatus: DESPACHO_TO_DISPATCH[enumKey(despacho)],
    callStatus: LLAMADA_TO_CALL[enumKey(llamada)],
  });
  if (mapped.deliveryStatus) return mapped.deliveryStatus;
  return isDeliveredEntrega(entrega) ? "entregado" : "pendiente";
}

// La DEVOLUCIÓN, que se lee aparte del trío de arriba.
//
// POR QUÉ TIENE SU PROPIA SONDA. El mapeo del trío ya resuelve DEVUELTO cuando
// el reporte trae el despacho en español. Pero el retorno es el único desenlace
// que también aparece —a veces SOLO aparece— en la columna inglesa "ÚLTIMO
// ESTADO DESPACHO" (RETURNED), y perderlo tiene consecuencias que ningún otro
// estado tiene: sin él, `returned_at` no se sella y el pedido nunca llega a
// `devuelto`, que es la entrada a Reproprovincia (MOM §10-§11). "ESTADO
// ENTREGA" no sirve de respaldo: en una guía devuelta dice CANCELADO, NO
// CONTESTA o RECHAZADO, que es el MOTIVO, no el desenlace.
//
// Es la única lectura que se hace de las columnas "ÚLTIMO ESTADO …". El resto
// se ignora a propósito (ver deliveryStatusFromReport): son un snapshot rezagado
// que contradice al español. Aquí no molesta porque RETURNED es terminal — una
// guía no deja de estar devuelta —, así que un valor rezagado no puede mentir
// hacia el lado que importa.
const DESPACHO_RETURN_KEYS = ["ultimo estado despacho", "estado despacho"];
// La fecha en que el paquete SALIÓ. Ojo con el alias: la cabecera real es
// "FECHA DESPACHO", sin "de" — ALICLIK_SERVICE_DATE_KEYS solo tenía la variante
// con "de", así que esta columna no la leía nadie.
const DISPATCH_DATE_KEYS = ["fecha despacho", "fecha de despacho"];

/**
 * True cuando el paquete YA VOLVIÓ al origen.
 *
 * Ojo con el estado anterior: TO_RETURN / "POR DEVOLVER" es un paquete que
 * todavía está viajando de vuelta, no una devolución consumada. Se deja fuera a
 * propósito —igual que hace el mapeo de la API (lib/aliclik-status.ts)— porque
 * mientras se mueve la guía sigue viva y el equipo la puede interceptar.
 */
export function isReturnedDespacho(raw: string | null, entrega?: string | null): boolean {
  if (!raw) return false;
  const value = stripAccents(raw.trim().toLowerCase());
  if (value === "returned" || value === "devuelto") return true;
  // "DEJADO EN ALMACÉN" es la MISMA etiqueta para el paquete que aún no ha
  // salido y para el que ya volvió. Lo que las separa es si hubo intento de
  // entrega: con un resultado en ESTADO ENTREGA —cancelado, rechazado, no
  // contesta, reprogramado— el paquete salió y regresó. Con POR ENTREGAR, o sin
  // dato, nunca se movió.
  //
  // Sin esta lectura la devolución no se sellaba nunca para las guías cuyo
  // desenlace Aliclik reporta así, que son muchas: la caja estaba en el almacén
  // y la cola de recuperación seguía vacía.
  if (value === "left_in_warehouse" || value === "dejado en almacen") {
    return ATTEMPTED_ENTREGA.has(enumKey(entrega));
  }
  return false;
}

/** ESTADO ENTREGA que acredita que el paquete SALIÓ y el intento falló.
 *  ENTREGADO queda fuera: esa guía terminó bien. */
const ATTEMPTED_ENTREGA = new Set([
  "CANCELADO",
  "ANULADO",
  "RECHAZADO",
  "NO CONTESTA",
  "REPROGRAMADO",
]);

// Aliclik marca con ESTADO LLAMADA = IMPORTADO los pedidos que subió a su
// plataforma pero que TODAVÍA NO gestiona: no tienen despacho ni entrega, así
// que no son guías reales. Si entran al sistema quedan como envíos "pendiente"
// fantasma que nadie puede gestionar y ensucian la cola de Repro Provincia
// (pasó con ~2.300 filas de un reporte, que hubo que borrar a mano). Se omiten
// al importar. Ojo: la clave normalizada es "estado llamada", distinta del
// "estado" suelto de ENTREGA_KEYS, así que no se pisan entre sí.
const ESTADO_LLAMADA_KEYS = ["estado llamada", "estado de llamada"];

/** True cuando la fila viene marcada IMPORTADO en "ESTADO LLAMADA" — Aliclik aún
 *  no la gestiona, no es una guía real y no debe entrar al sistema. */
export function isImportadoRow(raw: Record<string, string>): boolean {
  const value = pick(buildLookup(raw), ESTADO_LLAMADA_KEYS);
  return value != null && stripAccents(value.toLowerCase()) === "importado";
}

export function parseAliclikAttempts(raw: string | null | undefined): number | null {
  if (raw == null || String(raw).trim() === "") return null;
  const match = String(raw).trim().match(/\d+/);
  if (!match) return null;
  const value = Number.parseInt(match[0], 10);
  return Number.isFinite(value) ? Math.max(0, value) : null;
}

export function parseAliclikCoordinate(
  raw: string | null | undefined,
  kind: "latitude" | "longitude",
): number | null {
  if (raw == null || String(raw).trim() === "") return null;
  const value = Number(String(raw).trim().replace(",", "."));
  const limit = kind === "latitude" ? 90 : 180;
  return Number.isFinite(value) && value >= -limit && value <= limit ? value : null;
}

/** Parse the date formats emitted by Aliclik/Excel into a calendar date. */
export function parseAliclikDate(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const value = String(raw).trim();
  if (!value) return null;

  const iso = value.match(/^(\d{4})-(\d{2})-(\d{2})(?:T|\s|$)/);
  if (iso) return validDateKey(Number(iso[1]), Number(iso[2]), Number(iso[3]));

  const local = value.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{2,4})/);
  if (!local) return null;
  const yearRaw = Number(local[3]);
  const year = yearRaw < 100 ? 2000 + yearRaw : yearRaw;
  return validDateKey(year, Number(local[2]), Number(local[1]));
}

function validDateKey(year: number, month: number, day: number): string | null {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return [year, String(month).padStart(2, "0"), String(day).padStart(2, "0")].join("-");
}

/** Map one report row object → canonical ParsedShipmentRow. */
export function parseAliclikRow(
  raw: Record<string, string>,
  opts: AliclikParseOpts = {},
): ParsedShipmentRow {
  const map = buildLookup(raw);

  const district = pick(map, DISTRICT_KEYS);
  const province = pick(map, PROVINCE_KEYS);
  const department = pick(map, DEPARTMENT_KEYS);
  // city for Fenix coverage: search district + province + department for a known
  // Fenix city; otherwise fall back to the normalized district.
  const combined = [district, province, department].filter(Boolean).join(" ");
  const fenixCity = normalizeCity(combined);
  const city = isFenixCity(fenixCity) ? fenixCity : district ? normalizeCity(district) : null;

  // Estado de la guía, en tres escalones y en este orden.
  //
  // 1) ENTREGADO gana sobre todo lo demás, y el orden importa: una guía
  //    entregada trae basura en las columnas de despacho y entrega (PICKED, y
  //    CANCEL o NOT_RESPOND heredados de intentos previos). Si el despacho se
  //    evaluara primero, esas entregas se reclasificarían como anuladas.
  // 2) La devolución consumada cierra la guía como "anulado". Va antes del
  //    mapeo del trío porque su sonda lee también la columna inglesa, así que
  //    atrapa retornos que el español no reporta (ver DESPACHO_RETURN_KEYS).
  //    Devuelto = "anulado" para la GUÍA, igual que en el camino por API: el
  //    vocabulario de guías no tiene un código `devuelto`. Ese matiz lo pone
  //    `resolveOrderState` (lib/order-status.ts) leyendo `returned_at`, que es
  //    lo que convierte el PEDIDO en `devuelto`.
  // 3) El resto sale del trío ENTREGA + DESPACHO + LLAMADA (ver
  //    deliveryStatusFromReport): CANCELADO/ANULADO/RECHAZADO cierran (anulado),
  //    RECOLECTADO/EN TRÁNSITO/POR DEVOLVER/EN AGENCIA y RECHAZADO/NO CONTESTA/
  //    REPROGRAMADO ya salieron (en_ruta), y lo que sigue en almacén (POR
  //    PREPARAR/VALIDADO/DEJADO EN ALMACÉN o POR ENTREGAR sin despacho) queda
  //    pendiente.
  const delivered = isDeliveredEntrega(pick(map, ENTREGA_KEYS));
  const returned =
    !delivered && isReturnedDespacho(pick(map, DESPACHO_RETURN_KEYS), pick(map, ENTREGA_KEYS));
  const delivery_status = delivered
    ? "entregado"
    : returned
      ? "anulado"
      : deliveryStatusFromReport(
          pick(map, ENTREGA_KEYS),
          pick(map, DESPACHO_KEYS),
          pick(map, ESTADO_LLAMADA_KEYS),
        );

  const guideCode = findGuideCode(raw);
  const orderRef = extractOrderReference(
    map.get("nota"),
    pick(map, ORDER_KEYS),
    opts.orderPrefix,
    guideCode,
  );

  return {
    guide_code: guideCode,
    order_name: orderRef.name,
    order_name_confirmed: orderRef.confirmed,
    customer_name: pick(map, NAME_KEYS),
    customer_phone: normalizePhone(pick(map, PHONE_KEYS)),
    product: pick(map, PRODUCT_KEYS),
    district: district || null,
    province: province || null,
    city: city || null,
    region: department || null,
    delivery_address: pick(map, ADDRESS_KEYS),
    delivery_reference: pick(map, REFERENCE_KEYS),
    latitude: parseAliclikCoordinate(pick(map, LATITUDE_KEYS), "latitude"),
    longitude: parseAliclikCoordinate(pick(map, LONGITUDE_KEYS), "longitude"),
    delivery_status,
    returned,
    dispatch_date: parseAliclikDate(pick(map, DISPATCH_DATE_KEYS)),
    store_hint: pick(map, STORE_KEYS),
    aliclik_attempts: parseAliclikAttempts(pick(map, ALICLIK_ATTEMPT_KEYS)),
    aliclik_service_date: parseAliclikDate(pick(map, ALICLIK_SERVICE_DATE_KEYS)),
    raw,
  };
}

/** Parse a whole report. Rows without a guide code are flagged via guide_code=null
 *  (the ingest layer marks them as errors and keeps them for review). Las filas
 *  con ESTADO LLAMADA = IMPORTADO se DESCARTAN acá (ver isImportadoRow): no son
 *  guías reales, así que ni siquiera llegan a la capa de ingesta. */
export function parseAliclikReport(
  rows: Record<string, string>[],
  opts: AliclikParseOpts = {},
): ParsedShipmentRow[] {
  // `.map(parseAliclikRow)` pasaría el índice como segundo argumento, que acá ya
  // no es inocuo: el segundo parámetro son las opciones.
  return rows.filter((r) => !isImportadoRow(r)).map((r) => parseAliclikRow(r, opts));
}
