// Ubigeo (INEI) lookup for the cities Fenix/Swayp serves.
//
// Swayp identifies origin and destination by the 6-digit INEI ubigeo code, not
// by free text — `ciudadRemitente` / `ciudadDestinatario` in POST /v2/guias.
// The rest of this codebase stores `shipments.city` as a normalized coverage
// key ("arequipa", "juliaca"…) and `shipments.district` as the raw district
// label, so this module is the bridge between the two.
//
// The table holds EVERY district of the six provinces we operate in — not just
// the FENIX_DISTRICTS subset — because a customer can live in an uncovered
// district of a covered city and Swayp is the one that decides coverage (it
// answers "las areas de origen y entrega no permiten el servicio" when it
// can't serve the pair). Codes come from the INEI list (RENIEC uses different
// codes for the same districts — do not mix the two).
//
// Pure + unit-tested. No network.

import { normalizeCity, normalizeDistrict } from "@/lib/shipments";
import { fenixStockCityKey } from "@/lib/fenix";

/**
 * INEI ubigeo per coverage city → normalized district name → 6-digit code.
 * The first entry of each city is its cercado (the province capital), used as
 * the origin when a shipment has no resolvable district.
 */
export const UBIGEO_BY_CITY: Record<string, Record<string, string>> = {
  arequipa: {
    "arequipa": "040101",
    "alto selva alegre": "040102",
    "cayma": "040103",
    "cerro colorado": "040104",
    "characato": "040105",
    "chiguata": "040106",
    "jacobo hunter": "040107",
    "la joya": "040108",
    "mariano melgar": "040109",
    "miraflores": "040110",
    "mollebaya": "040111",
    "paucarpata": "040112",
    "pocsi": "040113",
    "polobaya": "040114",
    "quequena": "040115",
    "sabandia": "040116",
    "sachaca": "040117",
    "san juan de siguas": "040118",
    "san juan de tarucani": "040119",
    "santa isabel de siguas": "040120",
    "santa rita de siguas": "040121",
    "socabaya": "040122",
    "tiabaya": "040123",
    "uchumayo": "040124",
    "vitor": "040125",
    "yanahuara": "040126",
    "yarabamba": "040127",
    "yura": "040128",
    "jose luis bustamante y rivero": "040129",
  },
  cusco: {
    "cusco": "080101",
    "ccorca": "080102",
    "poroy": "080103",
    "san jeronimo": "080104",
    "san sebastian": "080105",
    "santiago": "080106",
    "saylla": "080107",
    "wanchaq": "080108",
  },
  trujillo: {
    "trujillo": "130101",
    "el porvenir": "130102",
    "florencia de mora": "130103",
    "huanchaco": "130104",
    "la esperanza": "130105",
    "laredo": "130106",
    "moche": "130107",
    "poroto": "130108",
    "salaverry": "130109",
    "simbal": "130110",
    "victor larco herrera": "130111",
  },
  huancayo: {
    "huancayo": "120101",
    "carhuacallanga": "120104",
    "chacapampa": "120105",
    "chicche": "120106",
    "chilca": "120107",
    "chongos alto": "120108",
    "chupuro": "120111",
    "colca": "120112",
    "cullhuas": "120113",
    "el tambo": "120114",
    "huacrapuquio": "120116",
    "hualhuas": "120117",
    "huancan": "120119",
    "huasicancha": "120120",
    "huayucachi": "120121",
    "ingenio": "120122",
    "pariahuanca": "120124",
    "pilcomayo": "120125",
    "pucara": "120126",
    "quichuay": "120127",
    "quilcas": "120128",
    "san agustin": "120129",
    "san jeronimo de tunan": "120130",
    "sano": "120132",
    "sapallanga": "120133",
    "sicaya": "120134",
    "santo domingo de acobamba": "120135",
    "viques": "120136",
  },
  juliaca: {
    "juliaca": "211101",
    "cabana": "211102",
    "cabanillas": "211103",
    "caracoto": "211104",
    "san miguel": "211105",
  },
  // Las cuatro ciudades nuevas entran SOLO con su cercado, a diferencia de las
  // seis de arriba que traen la provincia entera.
  //
  // El cercado es el único código que se puede afirmar sin la lista INEI
  // delante: es la capital de provincia y siempre termina en 01 (Ica es la
  // provincia 01 de Ica → 110101; Santa es la 18 de Áncash → 021801). Los
  // distritos restantes de cada provincia no se transcriben de memoria a
  // propósito: `resolveUbigeo` exige `exact` y un distrito ausente hace que
  // `buildSwaypGuideInput` se niegue con un mensaje claro, mientras que un
  // código equivocado crea la guía y desvía el paquete sin avisar. Faltar es
  // recuperable; mentir no.
  //
  // Para completar cada provincia hace falta su listado INEI (no RENIEC, que
  // numera distinto los mismos distritos).
  ica: {
    "ica": "110101",
  },
  piura: {
    "piura": "200101",
  },
  chimbote: {
    "chimbote": "021801",
  },
  chiclayo: {
    "chiclayo": "140101",
  },
  puno: {
    "puno": "210101",
    "acora": "210102",
    "amantani": "210103",
    "atuncolla": "210104",
    "capachica": "210105",
    "chucuito": "210106",
    "coata": "210107",
    "huata": "210108",
    "manazo": "210109",
    "paucarcolla": "210110",
    "pichacani": "210111",
    "plateria": "210112",
    "san antonio": "210113",
    "tiquillaca": "210114",
    "vilque": "210115",
  },
};

/** Ayaviri (Melgar, Puno) — served out of the Juliaca warehouse but a different
 *  province, so it isn't in the Juliaca table above. */
export const UBIGEO_AYAVIRI = "210801";

export interface UbigeoMatch {
  /** 6-digit INEI code to send as ciudadRemitente / ciudadDestinatario. */
  code: string;
  /** Normalized district the code resolved to. */
  district: string;
  /**
   * true when the district itself matched. false when we fell back to the
   * city's cercado because the district was blank or unrecognised — callers
   * that create real guides should require `exact`, since a wrong ubigeo
   * misroutes the package silently.
   */
  exact: boolean;
}

/** Strip the "(cercado)" / "cercado de X" decorations operators type in. */
function stripCercado(district: string): string {
  return district
    .replace(/\(.*?\)/g, " ")
    .replace(/\bcercado de\b/g, " ")
    .replace(/\bcercado\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Resolve a (city, district) pair to its INEI ubigeo.
 *
 * Matching is tolerant in the same spirit as `isFenixDistrict`: exact first,
 * then a prefix match in either direction ("San Jerónimo" → "san jeronimo de
 * tunan" in Huancayo), but ONLY when exactly one district matches — an
 * ambiguous prefix resolves to nothing rather than to a guess.
 *
 * Returns null when the city isn't one we serve. Pure.
 */
export function resolveUbigeo(
  city: string | null | undefined,
  district: string | null | undefined,
): UbigeoMatch | null {
  const cityKey = normalizeCity(city);
  const table = UBIGEO_BY_CITY[cityKey];
  if (!table) return null;

  // Every city's cercado is keyed by the city name itself ("arequipa" →
  // 040101), so the fallback needs no assumption about key order.
  const cercadoCode = table[cityKey];
  if (!cercadoCode) return null;
  const fallback: UbigeoMatch = { code: cercadoCode, district: cityKey, exact: false };

  const raw = normalizeDistrict(district);
  if (!raw) return fallback;

  const direct = table[raw];
  if (direct) return { code: direct, district: raw, exact: true };

  const bare = stripCercado(raw);
  if (!bare) return fallback;
  const byBare = table[bare];
  if (byBare) return { code: byBare, district: bare, exact: true };

  // Ayaviri is served from Juliaca but lives in another province.
  if (bare === "ayaviri" && (cityKey === "juliaca" || cityKey === "puno")) {
    return { code: UBIGEO_AYAVIRI, district: "ayaviri", exact: true };
  }

  const candidates = Object.keys(table).filter(
    (known) => known.startsWith(`${bare} `) || bare.startsWith(`${known} `),
  );
  const only = candidates.length === 1 ? candidates[0] : undefined;
  const byPrefix = only ? table[only] : undefined;
  if (only && byPrefix) return { code: byPrefix, district: only, exact: true };

  return fallback;
}

/**
 * Origin ubigeo for a shipment's city — the cercado of the warehouse that
 * serves it. Uses `fenixStockCityKey` so Puno draws from the Juliaca warehouse,
 * exactly like the stock gate does. Swayp only serves intra-city pairs, so the
 * origin must belong to the destination's own area.
 */
export function warehouseUbigeo(city: string | null | undefined): string | null {
  const key = fenixStockCityKey(city);
  return UBIGEO_BY_CITY[key]?.[key] ?? null;
}
