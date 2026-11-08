// «Aceptar ubicación aproximada en la calle correcta» (Confirmación por Chatby,
// MOM §6.1 y §40; owner, 08-11-2026; 0316). La parte pura: la reja de la
// calle, qué hace cada posición del interruptor y la cuenta de la prueba.
//
// POR QUÉ. La guía automática del que confirmó por Chatby solo acepta de
// Google el EDIFICIO (`ROOFTOP`). Cuando Google da el número de la cuadra
// (`RANGE_INTERPOLATED`) el pedido quedaba «sin ubicación» para la asesora
// (#KP204092, «Jirón José Olaya 245», Huamanga). El owner quiere probar ese
// punto solo cuando, además del candado de siempre (lib/geocode-google.ts:
// exacto, sin coincidencia parcial, mismo departamento y distrito, en el
// Perú), es la MISMA CALLE, el MISMO NÚMERO y la MISMA PROVINCIA del pedido.
//
// LAS TRES POSICIONES (`chatby_auto_settings.approx_mode`):
//   · Apagado (nace así): lo de siempre. Solo el edificio.
//   · Simulación: el punto aproximado que pasa la reja se guarda («habría
//     confirmado con ubicación aproximada»), y el pedido queda para la
//     asesora exactamente como hoy: sin guía y sin confirmar.
//   · Activo: la guía automática lo usa como usa el edificio, por el mismo
//     camino, y deja escrito «coordenada: dirección en Google (aproximada en
//     la calle)».
//
// LA MEDICIÓN. Cuando Aliclik ya entregó o intentó el pedido, se compara el
// punto aproximado con el punto de la guía de Aliclik del pedido —el que el
// Master toma como «lo que el courier geolocalizó al ir a la puerta»
// (lib/order-master.ts, `geoPin`)—. Si esa guía se creó con el propio punto
// aproximado (Activo), su coordenada ES la que mandó Kapta: Aliclik la
// devuelve tal cual en su reporte, así que no se mide (daría 0 m y la prueba
// se confirmaría sola, como el pin de Google en las mediciones de Lima).

import { haversineMeters, median, GEOCODE_SAME_PIN_METERS, type GeocodeResult } from "@/lib/geocode-google";
import { RETRY_MODES, RETRY_MODE_LABEL, isRetryMode, type RetryMode } from "@/lib/lima-retry-auto";
import { normalizeCoverageLabel } from "@/lib/order-coverage";

// ─── Las posiciones ──────────────────────────────────────────────────────────

/** Las mismas tres posiciones que los reintentos de Lima y la lista de pago adelantado. */
export const APPROX_MODES = RETRY_MODES;
export type ApproxMode = RetryMode;
export const APPROX_MODE_LABEL = RETRY_MODE_LABEL;
export function isApproxMode(value: unknown): value is ApproxMode {
  return isRetryMode(value);
}
/** Lo que se lee de la fila: sin la columna (antes de la 0316) o con un valor raro, Apagado. */
export function approxModeFrom(value: unknown): ApproxMode {
  return isApproxMode(value) ? value : "apagado";
}

/** Lo que dice la guía creada con el punto aproximado (`guide_detail`). */
export const APPROX_COORDINATE_NOTE = "coordenada: dirección en Google (aproximada en la calle)";
/** La marca de la Simulación. */
export const APPROX_SIMULATED_NOTE = "habría confirmado con ubicación aproximada";

// ─── La reja de la calle ─────────────────────────────────────────────────────

export type ApproxRejection = "sin_calle" | "otra_calle" | "otro_numero" | "otra_provincia";
export type ApproxKind = "calle" | ApproxRejection;
export const APPROX_KINDS: readonly ApproxKind[] = ["calle", "sin_calle", "otra_calle", "otro_numero", "otra_provincia"];

export const APPROX_REJECTION_LABEL: Record<ApproxRejection, string> = {
  sin_calle: "Google no dio la calle y el número",
  otra_calle: "Otra calle",
  otro_numero: "Otro número",
  otra_provincia: "Otra provincia",
};

/** Tipos de vía: no distinguen una calle de otra («Jr.» y «Jirón» son lo mismo). */
const STREET_TYPES = new Set([
  "jiron", "jr", "jron", "jirn", "avenida", "av", "avda", "ave", "calle", "cl", "cll", "ca", "pasaje", "psje", "pje", "pj", "psj",
  "prolongacion", "prolong", "prol", "malecon", "mlc", "carretera", "carr", "ctra", "alameda", "alm", "via", "ovalo", "paseo", "camino",
]);
/** Palabras que no nombran la calle. «N°», «Nro.» y «No.» van delante del número. */
const FILLER = new Set(["de", "del", "la", "las", "los", "el", "y", "e", "n", "nro", "no", "num", "numero"]);
/** Abreviaturas de siempre en los nombres de calles. */
const ALIAS: Record<string, string> = {
  gral: "general",
  grl: "general",
  sta: "santa",
  sto: "santo",
  sn: "san",
  mcal: "mariscal",
  mrcal: "mariscal",
  cnel: "coronel",
  crnel: "coronel",
  tte: "teniente",
  pdte: "presidente",
  ing: "ingeniero",
  dr: "doctor",
};

/** Las palabras de un texto: sin tildes, en minúscula, la z igualada a la s (Núñez/Nuñes). */
function words(text: string | null | undefined): string[] {
  return normalizeCoverageLabel(text)
    .split(" ")
    .filter(Boolean)
    .map((w) => ALIAS[w] ?? w)
    .map((w) => w.replace(/z/g, "s"));
}

/** Lo que nombra la calle: sin el tipo de vía, sin rellenos y sin números. */
function streetCore(name: string | null | undefined): string[] {
  return words(name).filter((w) => !STREET_TYPES.has(w) && !FILLER.has(w) && !/^\d+$/.test(w));
}

/** La provincia como clave: sin «(provincia)» ni «Provincia de», con la z igualada a la s. */
function provinceKey(value: string | null | undefined): string {
  return normalizeCoverageLabel((value ?? "").replace(/\(.*?\)/g, " "))
    .replace(/^provincia (de |del )?/, "")
    .replace(/z/g, "s")
    .trim();
}

function component(result: GeocodeResult, type: string): { long_name: string; short_name: string } | null {
  return result.components.find((c) => c.types.includes(type)) ?? null;
}

export type ApproxStreetCheck = { ok: true } | { ok: false; reason: ApproxRejection };

/**
 * ¿El punto de la cuadra es de la calle del pedido? Las tres a la vez:
 *   1. Google da la calle (`route`) y el número (`street_number`);
 *   2. cada palabra del nombre de la calle de Google está en la dirección del
 *      pedido (sin el tipo de vía: «Jr.» = «Jirón») y el número de Google
 *      está en la dirección;
 *   3. la provincia de Google (`administrative_area_level_2`) es la del pedido.
 * Ante la duda, no: una abreviatura que no se reconoce («J. Olaya») rechaza.
 * Va DESPUÉS del candado (`geocodeSafeguard`), que ya exige el departamento,
 * el distrito y que no sea una coincidencia parcial. Pura.
 */
export function geocodeApproxStreet(
  result: GeocodeResult,
  order: { address: string | null | undefined; province: string | null | undefined },
): ApproxStreetCheck {
  const route = component(result, "route");
  const number = component(result, "street_number");
  const longCore = streetCore(route?.long_name);
  const numberWords = words(number?.long_name).filter((w) => /^\d+$/.test(w));
  if (!route || !longCore.length || !numberWords.length) return { ok: false, reason: "sin_calle" };

  const address = new Set(words(order.address));
  // El nombre largo de Google, palabra por palabra; el corto solo si el largo no está.
  const nameMatches = (names: string[]) => names.length > 0 && names.some((w) => w.length >= 3) && names.every((w) => address.has(w));
  if (!nameMatches(longCore) && !nameMatches(streetCore(route.short_name))) return { ok: false, reason: "otra_calle" };
  if (!numberWords.every((w) => address.has(w))) return { ok: false, reason: "otro_numero" };

  const ours = provinceKey(order.province);
  const theirs = [component(result, "administrative_area_level_2")]
    .filter((c): c is NonNullable<typeof c> => !!c)
    .flatMap((c) => [provinceKey(c.long_name), provinceKey(c.short_name)])
    .filter(Boolean);
  if (!ours || !theirs.includes(ours)) return { ok: false, reason: "otra_provincia" };
  return { ok: true };
}

// ─── Qué hace cada posición ──────────────────────────────────────────────────

/** Lo que devolvió la consulta, visto desde la guía automática (lib/geocode-google-server.ts). */
export type ApproxGeo =
  | { kind: "ok"; lat: number; lng: number }
  | { kind: "rejected"; approx?: { lat: number; lng: number } | null }
  | { kind: "unavailable" };

export type ApproxDecision =
  /** El edificio: como siempre, en cualquier posición. */
  | { use: "edificio"; lat: number; lng: number }
  /** Activo: el punto aproximado que pasó la reja, como coordenada de la guía. */
  | { use: "aproximada"; lat: number; lng: number }
  /** Para la asesora, como hoy. `simulated`: en Simulación habría confirmado con el punto aproximado. */
  | { use: "ninguna"; simulated: boolean };

/** La decisión de la guía automática según la posición. Pura. */
export function approxDecision(mode: ApproxMode, geo: ApproxGeo): ApproxDecision {
  if (geo.kind === "ok") return { use: "edificio", lat: geo.lat, lng: geo.lng };
  const approx = geo.kind === "rejected" ? (geo.approx ?? null) : null;
  if (!approx || mode === "apagado") return { use: "ninguna", simulated: false };
  if (mode === "activo") return { use: "aproximada", lat: approx.lat, lng: approx.lng };
  return { use: "ninguna", simulated: true };
}

// ─── La medición ─────────────────────────────────────────────────────────────

/** «A menos de 150 m»: lo que el owner mira para decidir. */
export const APPROX_NEAR_METERS = 150;
/** Pedidos de la prueba que enseña el panel, como mucho. */
export const APPROX_REPORT_LIMIT = 200;
/**
 * Una guía creada hasta estos minutos después de usar el punto aproximado es
 * la que se creó con él (Activo): su coordenada es la que mandó Kapta.
 */
export const APPROX_OWN_GUIDE_MINUTES = 15;

export interface ApproxShipment {
  delivery_status: string | null;
  aliclik_attempts: number | null;
  latitude: number | string | null;
  longitude: number | string | null;
  created_at: string | null;
}

export type ApproxReference =
  /** Aliclik todavía no lo entregó ni lo intentó. */
  | { state: "sin_entregar" }
  /** Lo entregó o lo intentó, pero su guía no trae coordenada. */
  | { state: "sin_punto" }
  /** La coordenada de la guía es el punto aproximado que mandó Kapta: no mide nada. */
  | { state: "mismo_punto"; point: { lat: number; lng: number } }
  | { state: "medido"; point: { lat: number; lng: number }; distanceM: number };

const isAttempted = (s: ApproxShipment) => s.delivery_status === "entregado" || (Number(s.aliclik_attempts) || 0) > 0;

function pointOf(s: ApproxShipment): { lat: number; lng: number } | null {
  if (s.latitude == null || s.longitude == null) return null;
  const lat = Number(s.latitude);
  const lng = Number(s.longitude);
  return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
}

/**
 * El punto del motorizado de un pedido de la prueba: la guía de Aliclik que
 * se entregó o se intentó (la entregada primero; si no, la más reciente), y la
 * distancia al punto aproximado. Pura.
 */
export function approxReference(
  approx: { lat: number; lng: number; usedAt: string | null },
  shipments: readonly ApproxShipment[],
): ApproxReference {
  const attempted = shipments.filter(isAttempted);
  if (!attempted.length) return { state: "sin_entregar" };
  const ranked = [...attempted].sort((a, b) => {
    const delivered = Number(b.delivery_status === "entregado") - Number(a.delivery_status === "entregado");
    return delivered || Date.parse(b.created_at ?? "") - Date.parse(a.created_at ?? "") || 0;
  });
  const guide = ranked.find((s) => pointOf(s)) ?? null;
  const point = guide ? pointOf(guide) : null;
  if (!guide || !point) return { state: "sin_punto" };
  const usedMs = approx.usedAt ? Date.parse(approx.usedAt) : NaN;
  const createdMs = Date.parse(guide.created_at ?? "");
  const ownGuide = Number.isFinite(usedMs) && (!Number.isFinite(createdMs) || createdMs <= usedMs + APPROX_OWN_GUIDE_MINUTES * 60_000);
  const distanceM = haversineMeters(approx, point);
  if (ownGuide || distanceM <= GEOCODE_SAME_PIN_METERS) return { state: "mismo_punto", point };
  return { state: "medido", point, distanceM };
}

export interface ApproxSummary {
  /** Pedidos de la prueba (con punto aproximado guardado). */
  total: number;
  /** Con la distancia medida. */
  measured: number;
  /** De los medidos, a menos de `APPROX_NEAR_METERS`. */
  near: number;
  /** % de los medidos a menos de 150 m (0–100), o null sin medidos. */
  nearPct: number | null;
  /** Mediana de la distancia, en metros, o null sin medidos. */
  medianM: number | null;
  /** Aún sin entregar ni intentar. */
  pending: number;
}

/** La cuenta de la prueba. Pura. */
export function approxSummary(references: readonly ApproxReference[]): ApproxSummary {
  const distances = references.flatMap((r) => (r.state === "medido" ? [r.distanceM] : []));
  const near = distances.filter((d) => d < APPROX_NEAR_METERS).length;
  return {
    total: references.length,
    measured: distances.length,
    near,
    nearPct: distances.length ? (near / distances.length) * 100 : null,
    medianM: median(distances),
    pending: references.filter((r) => r.state === "sin_entregar").length,
  };
}

const fmtInt = (n: number) => n.toLocaleString("es-PE");

/** «N pedidos medidos · M a menos de 150 m · distancia típica X m». Pura. */
export function approxSummaryLine(s: ApproxSummary): string {
  const measured = `${fmtInt(s.measured)} ${s.measured === 1 ? "pedido medido" : "pedidos medidos"}`;
  if (!s.measured) return `${measured} todavía`;
  const typical = s.medianM == null ? "—" : `${fmtInt(Math.round(s.medianM))} m`;
  return `${measured} · ${fmtInt(s.near)} a menos de ${APPROX_NEAR_METERS} m · distancia típica ${typical}`;
}

/** Un enlace de Google Maps al punto. */
export function mapsHref(p: { lat: number; lng: number }): string {
  return `https://www.google.com/maps?q=${p.lat},${p.lng}`;
}
