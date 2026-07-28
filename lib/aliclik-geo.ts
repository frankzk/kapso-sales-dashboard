// Coordenadas y ventanas horarias para la creación de guías en Aliclik.
// Puro: sin base de datos, sin red. Testeado.
//
// POR QUÉ ESTE MÓDULO EXISTE. `POST /integration/order` exige `shipping.lat` y
// `shipping.lng`, y Aliclik resuelve el ubigeo a partir de ellas. Pero este
// sistema NO tiene coordenadas de los pedidos: Shopify no las entrega (ver el
// comentario en lib/order-master.ts:555) y hoy solo llegan desde el propio Excel
// de Aliclik, es decir DESPUÉS de que la guía existe. De 6.548 pedidos
// pendientes sin guía, cero tenían coordenada.
//
// Lo que sí tiene el equipo es el enlace de Google Maps que la clienta manda por
// WhatsApp. De ahí `parseCoordinateInput`: acepta lo que una persona pega, no lo
// que a un formulario le gustaría recibir.

/** Latitud/longitud ya validadas. */
export interface Coordinate {
  lat: number;
  lng: number;
}

/**
 * Formatea una coordenada como la quiere Aliclik: string decimal.
 *
 * Dos trampas reales que esto evita:
 *   - `toLocaleString` o una plantilla en un entorno con coma decimal produciría
 *     "-12,04318", que la API rechaza.
 *   - Un número pequeño en JS se serializa en notación exponencial
 *     (0.0000071 → "7.1e-7"), que tampoco es un decimal válido para la API.
 */
export function toAliclikCoord(value: number): string {
  if (!Number.isFinite(value)) return "";
  // toFixed(7) ≈ 1 cm de precisión, muy por encima de lo que necesita un reparto,
  // y nunca exponencial. Se recortan los ceros de relleno por limpieza.
  let s = value.toFixed(7);
  if (s.includes(".")) s = s.replace(/0+$/, "").replace(/\.$/, "");
  // "-0" no es un valor útil y confunde al leer.
  return s === "-0" ? "0" : s;
}

const LAT_LIMIT = 90;
const LNG_LIMIT = 180;

function validPair(lat: number, lng: number): Coordinate | null {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (Math.abs(lat) > LAT_LIMIT || Math.abs(lng) > LNG_LIMIT) return null;
  // 0,0 es el "null island": en la práctica siempre es un dato vacío, nunca una
  // dirección de reparto en Perú.
  if (lat === 0 && lng === 0) return null;
  return { lat, lng };
}

const NUM = "[-+]?\\d{1,3}(?:\\.\\d+)?";

/**
 * Extrae una coordenada de lo que sea que haya pegado la operadora.
 *
 * Formatos aceptados (todos vistos en la práctica al copiar de Google Maps):
 *   -12.04318,-77.02824            par suelto, con o sin espacio
 *   -12.04318 / -77.02824          con separadores varios
 *   https://maps.google.com/?q=-12.04,-77.02
 *   https://www.google.com/maps/@-12.04,-77.02,17z
 *   https://www.google.com/maps/place/X/@-12.04,-77.02,17z/data=!3d-12.04!4d-77.02
 *   https://maps.app.goo.gl/…      NO: es un acortador, hay que abrirlo antes
 *
 * Devuelve null si no encuentra un par plausible. Prefiere !3d/!4d cuando están,
 * porque en una URL de "place" ese par es el punto EXACTO del sitio, mientras que
 * el de @ es el centro de la vista (que puede estar desplazado).
 */
export function parseCoordinateInput(raw: string | null | undefined): Coordinate | null {
  const s = (raw ?? "").trim();
  if (!s) return null;

  // 1. El par exacto de un enlace de "place": !3d<lat>!4d<lng>.
  const data = s.match(new RegExp(`!3d(${NUM})!4d(${NUM})`));
  if (data) {
    const hit = validPair(Number(data[1]), Number(data[2]));
    if (hit) return hit;
  }

  // 2. ?q= / &query= / ?ll= — lo que produce "compartir ubicación".
  const query = s.match(new RegExp(`[?&](?:q|query|ll|destination)=(${NUM})\\s*,\\s*(${NUM})`, "i"));
  if (query) {
    const hit = validPair(Number(query[1]), Number(query[2]));
    if (hit) return hit;
  }

  // 3. El centro de la vista: /@lat,lng,17z
  const at = s.match(new RegExp(`@(${NUM})\\s*,\\s*(${NUM})`));
  if (at) {
    const hit = validPair(Number(at[1]), Number(at[2]));
    if (hit) return hit;
  }

  // 4. Un par suelto en cualquier parte del texto. Se exige punto decimal en al
  //    menos uno de los dos: sin él, "1, 2" o un rango de fechas darían falsos
  //    positivos, y una coordenada real de reparto siempre trae decimales.
  const loose = s.match(new RegExp(`(${NUM})\\s*[,;/|\\s]\\s*(${NUM})`));
  const a = loose?.[1];
  const b = loose?.[2];
  if (a && b && (a.includes(".") || b.includes("."))) {
    const hit = validPair(Number(a), Number(b));
    if (hit) return hit;
  }

  return null;
}

/** ¿Es un acortador de Google Maps? No se puede resolver sin abrirlo. */
export function isShortenedMapsLink(raw: string | null | undefined): boolean {
  const s = (raw ?? "").trim().toLowerCase();
  return s.includes("maps.app.goo.gl") || s.includes("goo.gl/maps");
}

// ---------------------------------------------------------------------------
// Hora de Lima y ventana express
// ---------------------------------------------------------------------------

/**
 * "HH:mm" en America/Lima. Perú es UTC-5 fijo y no aplica horario de verano,
 * pero se resuelve con Intl igualmente para no codificar el desfase a mano
 * (mismo criterio que limaCalendarDayBounds en lib/shipments.ts).
 */
export function limaTimeHHMM(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "America/Lima",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const get = (t: "hour" | "minute") => parts.find((p) => p.type === t)?.value ?? "00";
  // Intl puede devolver "24" a medianoche en algunos runtimes.
  const hh = get("hour") === "24" ? "00" : get("hour");
  return `${hh}:${get("minute")}`;
}

/** Fecha de Lima como "YYYY-MM-DD". */
export function limaDateKey(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Lima",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const get = (t: "year" | "month" | "day") => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** Valida "HH:mm" y lo pasa a minutos. null si no es una hora usable. */
export function parseHHMM(value: string | null | undefined): number | null {
  const m = (value ?? "").trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/**
 * ¿Se puede agendar HOY un courier express?
 *
 * Regla de Aliclik: con `flagDeliveryExpress = true`, la hora local de Lima debe
 * caer dentro de [scheduleExpressStart, scheduleExpressEnd]; fuera de ahí
 * responde 400 "courier express no disponible para agendar pedidos hoy".
 *
 * Comprobarlo aquí deshabilita la opción en la interfaz en vez de dejar que la
 * operadora rellene todo el formulario para comerse el error al final.
 *
 * Ventana inclusiva en ambos extremos: en el borde exacto se ofrece la opción y
 * es Aliclik quien decide. Preferimos un 400 puntual a esconder una opción que
 * sí estaba disponible.
 */
export function canScheduleExpress(
  nowHHMM: string,
  start: string | null | undefined,
  end: string | null | undefined,
): boolean {
  const now = parseHHMM(nowHHMM);
  const from = parseHHMM(start);
  const to = parseHHMM(end);
  if (now === null || from === null || to === null) return false;
  // Una ventana que cruza medianoche (23:00 → 02:00) es válida.
  if (from <= to) return now >= from && now <= to;
  return now >= from || now <= to;
}
