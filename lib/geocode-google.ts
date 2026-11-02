// Coordenada por dirección (Google), solo cuando es exacta: el PILOTO.
// Propuesta y decisiones del owner en docs/kapta/geocodificacion-propuesta.md.
//
// Esto es la parte pura: qué se le manda a Google, cómo se lee lo que devuelve,
// el candado y la cuenta del piloto. La red, la base y la clave viven en
// lib/geocode-google-server.ts. Nada de aquí escribe ni guarda una coordenada:
// el piloto solo mide, y lo que devuelve son números agregados.
//
// QUÉ SE MANDA. Solo la dirección: la calle y el número, el distrito, la
// provincia y el departamento, más `region=pe` y `components=country:PE`. El
// constructor recibe esos cuatro campos y nada más, así que el nombre, el
// celular o el número del pedido no tienen por dónde entrar. Y si la clienta
// escribió su celular dentro de la dirección (pasa), se quita antes de salir.
//
// EL CANDADO, las cuatro condiciones a la vez:
//   1. `geometry.location_type` es ROOFTOP o RANGE_INTERPOLATED;
//   2. Google no marca `partial_match`;
//   3. el departamento (`administrative_area_level_1`) y el distrito
//      (`administrative_area_level_3`; si no viene, `locality`/`sublocality`)
//      son los del pedido, con las normalizaciones de siempre:
//      `departmentKey` (lib/peru-departamentos.ts) para el departamento y
//      `normalizeCoverageLabel` + `resolveLimaDistrict` (lib/order-coverage.ts)
//      para el distrito;
//   4. el punto cae en el Perú (`inPeru`, lib/chatby-conversation.ts: la misma
//      regla que la ubicación de WhatsApp).

import { inPeru } from "@/lib/chatby-conversation";
import { normalizeCoverageLabel, resolveLimaDistrict } from "@/lib/order-coverage";
import { departmentKey } from "@/lib/peru-departamentos";

/**
 * La Geocoding API CLÁSICA de Google (la que Google llama «v3»), en JSON. No la
 * v4 (GeocodeAddress): el candado lee `geometry.location_type` y
 * `partial_match`, que son campos de la respuesta v3, y el owner limita la cuota
 * «v3 requests per day» a 400 en Google Cloud (02-11-2026).
 */
export const GOOGLE_GEOCODE_ENDPOINT = "https://maps.googleapis.com/maps/api/geocode/json";

/** El tope diario que el owner pone a la cuota «v3 requests per day» (02-11-2026). */
export const GEOCODE_DAILY_QUOTA = 400;

/** Las dos coberturas del piloto (decisión C, 02-11-2026: Lima y Provincia COD). */
export const GEOCODE_PILOT_COVERAGES = ["lima", "provincia_cod"] as const;
export type GeocodeCoverage = (typeof GEOCODE_PILOT_COVERAGES)[number];

export const GEOCODE_COVERAGE_LABEL: Record<GeocodeCoverage, string> = {
  lima: "Lima",
  provincia_cod: "Provincia COD",
};

/** Criterio B (02-11-2026): al menos el 90 % de los que pasan el candado a 300 m o menos del pin real. */
export const GEOCODE_CRITERION_B = { withinMeters: 300, minShare: 0.9 } as const;
/** «A más de 1 km»: el error que manda el paquete a otro barrio. */
export const GEOCODE_FAR_METERS = 1000;
/**
 * Por debajo de esto el porcentaje se enseña con un aviso de muestra chica. No
 * cambia el criterio B (lo fija el owner): solo evita leer «100 %» de 3 puntos
 * como si fuera una medida.
 */
export const GEOCODE_SMALL_SAMPLE = 30;

/** Lo que dice Ajustes cuando la clave no está en el entorno (y entonces no se llama a nada). */
export const GEOCODE_KEY_MISSING = "Falta GOOGLE_GEOCODING_API_KEY en Vercel";

// ─── La petición ─────────────────────────────────────────────────────────────

/** Lo único que se lee del pedido para preguntar a Google. */
export interface GeocodeOrderAddress {
  /** La calle y el número (`order_master.address`). */
  address: string | null | undefined;
  district: string | null | undefined;
  province: string | null | undefined;
  /** El departamento (`order_master.region`). */
  region: string | null | undefined;
}

export interface GeocodeRequestParams {
  address: string;
  region: "pe";
  components: "country:PE";
  language: "es";
}

/**
 * Un celular peruano (9 dígitos que empiezan en 9, con o sin +51) o un fijo con
 * prefijo. Un número de calle no tiene nueve cifras; un celular escrito dentro
 * de la dirección sí, y no se le manda a Google.
 */
const PHONE_IN_TEXT = /(?<!\d)(?:\+?51[\s-]?)?9(?:[\s-]?\d){8}(?!\d)/g;

/** Una parte de la dirección, limpia: sin el «(provincia)» de «Lima (provincia)», sin blancos sobrantes. */
function part(value: string | null | undefined): string {
  return (value ?? "")
    .replace(/\(.*?\)/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[\s,.;-]+|[\s,.;-]+$/g, "")
    .trim();
}

/**
 * Los parámetros de la consulta a Google, o null si el pedido no trae calle (sin
 * calle, Google solo puede dar el centro del distrito, que el candado rechaza
 * igual: no se gasta la consulta).
 *
 * Solo lee `address`, `district`, `province` y `region`, aunque reciba la fila
 * entera del Master. Las partes repetidas («Lima, Lima, Lima») van una vez.
 */
export function geocodeRequestParams(order: GeocodeOrderAddress): GeocodeRequestParams | null {
  const street = part((order.address ?? "").replace(PHONE_IN_TEXT, " "));
  if (!/[a-z]/i.test(street)) return null;
  const parts: string[] = [street];
  const seen = new Set([normalizeCoverageLabel(street)]);
  for (const raw of [order.district, order.province, order.region]) {
    const p = part(raw);
    const k = normalizeCoverageLabel(p);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    parts.push(p);
  }
  return { address: parts.join(", "), region: "pe", components: "country:PE", language: "es" };
}

/** La consulta como query string, SIN la clave (la pone el servidor al pedir). */
export function geocodeQueryString(params: GeocodeRequestParams): string {
  return new URLSearchParams({
    address: params.address,
    region: params.region,
    components: params.components,
    language: params.language,
  }).toString();
}

// ─── La respuesta ────────────────────────────────────────────────────────────

export interface GeocodeAddressComponent {
  long_name: string;
  short_name: string;
  types: string[];
}

/** El primer resultado de Google, con lo que mira el candado. */
export interface GeocodeResult {
  lat: number;
  lng: number;
  /** ROOFTOP | RANGE_INTERPOLATED | GEOMETRIC_CENTER | APPROXIMATE. */
  locationType: string;
  partialMatch: boolean;
  components: GeocodeAddressComponent[];
}

/**
 * Estados de Google que no dependen de la dirección sino de la clave o la
 * cuenta: seguir consultando solo repetiría el mismo rechazo.
 */
const FATAL_STATUSES = new Set(["REQUEST_DENIED", "OVER_DAILY_LIMIT"]);

/** El cupo de la cuenta (el tope diario de 400 que pone el owner): no se sigue consultando. */
export const QUOTA_STATUS = "OVER_QUERY_LIMIT";

export type GeocodeParsed =
  | { kind: "ok"; result: GeocodeResult }
  | { kind: "zero_results" }
  /** `status` es el código de Google; su `error_message` no se guarda. */
  | { kind: "error"; status: string; fatal: boolean };

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/**
 * Lee la respuesta de la API. Se queda con el primer resultado, que es el que
 * Google da por mejor. Tolera cualquier forma: lo que no se entiende es un error.
 */
export function parseGeocodeResponse(json: unknown): GeocodeParsed {
  const body = json && typeof json === "object" ? (json as Record<string, unknown>) : {};
  const status = str(body.status) || "INVALID_RESPONSE";
  if (status === "ZERO_RESULTS") return { kind: "zero_results" };
  if (status !== "OK") return { kind: "error", status, fatal: FATAL_STATUSES.has(status) };
  const results = Array.isArray(body.results) ? body.results : [];
  const first = results[0] && typeof results[0] === "object" ? (results[0] as Record<string, unknown>) : null;
  if (!first) return { kind: "zero_results" };
  const geometry = first.geometry && typeof first.geometry === "object" ? (first.geometry as Record<string, unknown>) : {};
  const location = geometry.location && typeof geometry.location === "object" ? (geometry.location as Record<string, unknown>) : {};
  const lat = typeof location.lat === "number" ? location.lat : NaN;
  const lng = typeof location.lng === "number" ? location.lng : NaN;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return { kind: "error", status: "INVALID_RESPONSE", fatal: false };
  const components: GeocodeAddressComponent[] = (Array.isArray(first.address_components) ? first.address_components : [])
    .filter((c): c is Record<string, unknown> => Boolean(c) && typeof c === "object")
    .map((c) => ({
      long_name: str(c.long_name),
      short_name: str(c.short_name),
      types: Array.isArray(c.types) ? c.types.filter((t): t is string => typeof t === "string") : [],
    }));
  return {
    kind: "ok",
    result: { lat, lng, locationType: str(geometry.location_type), partialMatch: first.partial_match === true, components },
  };
}

// ─── El candado ──────────────────────────────────────────────────────────────

export type GeocodePrecision = "ROOFTOP" | "RANGE_INTERPOLATED";
const PRECISE = new Set<string>(["ROOFTOP", "RANGE_INTERPOLATED"]);

/** Por qué el candado no deja pasar un punto. */
export type GeocodeRejection =
  | "sin_resultado"
  | "impreciso"
  | "coincidencia_parcial"
  | "pedido_sin_destino"
  | "departamento_distinto"
  | "distrito_distinto"
  | "fuera_del_peru";

export type GeocodeSafeguard =
  | { ok: true; lat: number; lng: number; precision: GeocodePrecision }
  | { ok: false; reason: GeocodeRejection };

/** El destino del pedido contra el que se compara: distrito y departamento del Master. */
export interface GeocodeOrderDestination {
  district: string | null | undefined;
  region: string | null | undefined;
}

/**
 * El departamento de Google, como clave de `departmentKey`. Google lo escribe a
 * veces con su prefijo administrativo («Región Lima», «Departamento de Cusco»,
 * «Gobierno Regional de Piura»); se quita antes de comparar. «Provincia de
 * Lima» y «Municipalidad Metropolitana de Lima» ya los entiende `departmentKey`.
 */
function googleDepartmentKey(name: string): string | null {
  const direct = departmentKey(name);
  if (direct) return direct;
  const bare = name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/^\s*(gobierno regional|departamento|region)(\s+(de|del))?\s+/i, "");
  return departmentKey(bare);
}

/**
 * Las claves con que se compara un distrito: la normalización de la cobertura
 * (`normalizeCoverageLabel`), con la z igualada a la s como en el pin respaldado
 * (Cusco/Cuzco, lib/pin-corroborado.ts). En Lima, además, el nombre canónico de
 * `resolveLimaDistrict` («Surco» → santiago de surco, «Cercado de Lima» → lima) y
 * cada mitad de un nombre doble («Lurigancho-Chosica»). Los alias de Lima solo
 * se aplican en Lima: «Jesús» es Jesús María en Lima y un distrito propio en
 * Cajamarca.
 */
function districtKeys(raw: string | null | undefined, inLima: boolean): Set<string> {
  const keys = new Set<string>();
  const add = (value: string | null | undefined) => {
    const k = normalizeCoverageLabel(value).replace(/z/g, "s");
    if (!k) return;
    keys.add(k);
    if (inLima) {
      const lima = resolveLimaDistrict(value);
      if (lima) keys.add(lima.replace(/z/g, "s"));
    }
  };
  const cleaned = (raw ?? "").replace(/\(.*?\)/g, " ");
  add(cleaned);
  const halves = cleaned.split(/\s*[-/]\s*/).filter((h) => h.trim());
  if (halves.length > 1) halves.forEach(add);
  return keys;
}

/** El distrito según Google: `administrative_area_level_3`; si no viene, `locality` y `sublocality`. */
function googleDistricts(components: readonly GeocodeAddressComponent[]): string[] {
  const level3 = components.filter((c) => c.types.includes("administrative_area_level_3")).map((c) => c.long_name);
  if (level3.length) return level3;
  return components
    .filter((c) => c.types.includes("locality") || c.types.some((t) => t === "sublocality" || t.startsWith("sublocality_level_")))
    .map((c) => c.long_name);
}

/**
 * ¿Se acepta el punto de Google para este pedido? Devuelve el punto con su
 * precisión, o el primer motivo por el que no pasa, en el orden del candado.
 */
export function geocodeSafeguard(result: GeocodeResult | null, order: GeocodeOrderDestination): GeocodeSafeguard {
  if (!result) return { ok: false, reason: "sin_resultado" };
  if (!PRECISE.has(result.locationType)) return { ok: false, reason: "impreciso" };
  if (result.partialMatch) return { ok: false, reason: "coincidencia_parcial" };

  const orderDep = departmentKey(order.region);
  const orderDistrict = normalizeCoverageLabel(order.district);
  if (!orderDep || !orderDistrict) return { ok: false, reason: "pedido_sin_destino" };

  const googleDeps = result.components
    .filter((c) => c.types.includes("administrative_area_level_1"))
    .map((c) => googleDepartmentKey(c.long_name) ?? googleDepartmentKey(c.short_name));
  if (!googleDeps.some((d) => d === orderDep)) return { ok: false, reason: "departamento_distinto" };

  const inLima = orderDep === "lima";
  const ours = districtKeys(order.district, inLima);
  const theirs = googleDistricts(result.components).flatMap((d) => [...districtKeys(d, inLima)]);
  if (!theirs.some((k) => ours.has(k))) return { ok: false, reason: "distrito_distinto" };

  if (!inPeru(result.lat, result.lng)) return { ok: false, reason: "fuera_del_peru" };
  return { ok: true, lat: result.lat, lng: result.lng, precision: result.locationType as GeocodePrecision };
}

// ─── Distancia y cuenta del piloto ───────────────────────────────────────────

const EARTH_RADIUS_M = 6_371_008.8;

/** Distancia en metros entre dos puntos (haversine). */
export function haversineMeters(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Por qué un pedido de la muestra no aportó un punto: los motivos del candado
 * más los del propio piloto (sin calle que mandar, error de la API, se acabó el
 * tiempo de la pasada antes de consultarlo).
 */
export type GeocodePilotReason = GeocodeRejection | "sin_direccion" | "error_api" | "sin_tiempo" | "sin_cupo";

export const GEOCODE_REASON_LABEL: Record<GeocodePilotReason, string> = {
  sin_direccion: "Sin calle en el pedido",
  sin_resultado: "Google no encontró la dirección",
  impreciso: "No es exacta (centro de calle o zona)",
  coincidencia_parcial: "Coincidencia parcial",
  pedido_sin_destino: "El pedido no trae distrito o departamento",
  departamento_distinto: "Otro departamento",
  distrito_distinto: "Otro distrito",
  fuera_del_peru: "Fuera del Perú",
  error_api: "Error de la API",
  sin_tiempo: "No se llegó a consultar (tiempo)",
  sin_cupo: "No se consultó (cupo diario de Google)",
};

/** Un pedido de la muestra, ya sin dirección: su cobertura y lo que salió. */
export type GeocodePilotSample =
  | { coverage: GeocodeCoverage; ok: true; precision: GeocodePrecision; distanceM: number }
  | { coverage: GeocodeCoverage; ok: false; reason: GeocodePilotReason };

export interface GeocodeCoverageStats {
  /** «lima», «provincia_cod» o «total». */
  coverage: GeocodeCoverage | "total";
  sampled: number;
  passed: number;
  rejections: Partial<Record<GeocodePilotReason, number>>;
  /** De los que pasan, cuántos con cada precisión. */
  rooftop: number;
  rangeInterpolated: number;
  /** Mediana de la distancia al pin de la asesora, en metros. Null sin puntos. */
  medianM: number | null;
  /** % de los que pasan a 300 m o menos (0–100). */
  within300Pct: number | null;
  /** % de los que pasan a más de 1 km (0–100). */
  beyond1kmPct: number | null;
  /** Lo mismo solo con ROOFTOP: lo que usaría la guía automática (decisión A). */
  rooftopWithin300Pct: number | null;
  /** Criterio B. Null si ningún punto pasó el candado. */
  criterionBMet: boolean | null;
  /** Menos de `GEOCODE_SMALL_SAMPLE` puntos que pasan: el % se lee con cuidado. */
  smallSample: boolean;
}

export interface GeocodePilotReport {
  /** ISO de cuándo se corrió. */
  ranAt: string;
  days: number;
  cap: number;
  /** Consultas hechas a Google (las que se cobran). */
  apiCalls: number;
  elapsedMs: number;
  /** La pasada se cortó por tiempo antes de consultar toda la muestra. */
  truncated: boolean;
  /** Google contestó OVER_QUERY_LIMIT (el cupo diario): no se consultó nada más. */
  quotaHit: boolean;
  byCoverage: GeocodeCoverageStats[];
  total: GeocodeCoverageStats;
}

/** Mediana de una lista de números (promedio de los dos del medio si es par). Null si está vacía. */
export function median(values: readonly number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

const share = (part: number, whole: number): number | null => (whole > 0 ? (part / whole) * 100 : null);

function statsFor(coverage: GeocodeCoverage | "total", samples: readonly GeocodePilotSample[]): GeocodeCoverageStats {
  const rejections: Partial<Record<GeocodePilotReason, number>> = {};
  const distances: number[] = [];
  const rooftopDistances: number[] = [];
  let rangeInterpolated = 0;
  for (const s of samples) {
    if (!s.ok) {
      rejections[s.reason] = (rejections[s.reason] ?? 0) + 1;
      continue;
    }
    distances.push(s.distanceM);
    if (s.precision === "ROOFTOP") rooftopDistances.push(s.distanceM);
    else rangeInterpolated += 1;
  }
  const passed = distances.length;
  const within = distances.filter((d) => d <= GEOCODE_CRITERION_B.withinMeters).length;
  const far = distances.filter((d) => d > GEOCODE_FAR_METERS).length;
  const rooftopWithin = rooftopDistances.filter((d) => d <= GEOCODE_CRITERION_B.withinMeters).length;
  return {
    coverage,
    sampled: samples.length,
    passed,
    rejections,
    rooftop: rooftopDistances.length,
    rangeInterpolated,
    medianM: median(distances),
    within300Pct: share(within, passed),
    beyond1kmPct: share(far, passed),
    rooftopWithin300Pct: share(rooftopWithin, rooftopDistances.length),
    criterionBMet: passed > 0 ? within / passed >= GEOCODE_CRITERION_B.minShare : null,
    smallSample: passed < GEOCODE_SMALL_SAMPLE,
  };
}

/** La cuenta del piloto: por cobertura (Lima, Provincia COD) y el total. */
export function aggregateGeocodePilot(samples: readonly GeocodePilotSample[]): {
  byCoverage: GeocodeCoverageStats[];
  total: GeocodeCoverageStats;
} {
  return {
    byCoverage: GEOCODE_PILOT_COVERAGES.map((c) => statsFor(c, samples.filter((s) => s.coverage === c))),
    total: statsFor("total", samples),
  };
}
