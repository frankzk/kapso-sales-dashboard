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
  // Las cuatro provincias de abajo se transcribieron del padrón INEI completo
  // (2095 filas: 25 departamentos + 196 provincias + 1874 distritos), no de
  // memoria. El padrón se validó primero contra las 100 entradas que ya estaban
  // en esta tabla —incluidas las siete confirmadas en vivo contra la API de
  // cotización de Swayp— y coincidió código por código y nombre por nombre, lo
  // que confirma que es la numeración INEI y no la de RENIEC.
  //
  // Los saltos no son errores de transcripción: Piura salta 200102, 200103 y
  // 200106 porque esos distritos pasaron a la provincia de Sechura en 1994.
  ica: {
    "ica": "110101",
    "la tinguina": "110102",
    "los aquijes": "110103",
    "ocucaje": "110104",
    "pachacutec": "110105",
    "parcona": "110106",
    "pueblo nuevo": "110107",
    "salas": "110108",
    "san jose de los molinos": "110109",
    "san juan bautista": "110110",
    "santiago": "110111",
    "subtanjalla": "110112",
    "tate": "110113",
    "yauca del rosario": "110114",
  },
  piura: {
    "piura": "200101",
    "castilla": "200104",
    "catacaos": "200105",
    "cura mori": "200107",
    "el tallan": "200108",
    "la arena": "200109",
    "la union": "200110",
    "las lomas": "200111",
    "tambo grande": "200114",
    "26 de octubre": "200115",
  },
  // Chimbote es la capital de la provincia de Santa, no una provincia propia.
  chimbote: {
    "chimbote": "021801",
    "caceres del peru": "021802",
    "coishco": "021803",
    "macate": "021804",
    "moro": "021805",
    "nepena": "021806",
    "samanco": "021807",
    "santa": "021808",
    "nuevo chimbote": "021809",
  },
  chiclayo: {
    "chiclayo": "140101",
    "chongoyape": "140102",
    "eten": "140103",
    "eten puerto": "140104",
    "jose leonardo ortiz": "140105",
    "la victoria": "140106",
    "lagunas": "140107",
    "monsefu": "140108",
    "nueva arica": "140109",
    "oyotun": "140110",
    "picsi": "140111",
    "pimentel": "140112",
    "reque": "140113",
    "santa rosa": "140114",
    "sana": "140115",
    "cayalti": "140116",
    "patapo": "140117",
    "pomalca": "140118",
    "pucala": "140119",
    "tuman": "140120",
  },
  // Lima y Callao se transcribieron del mismo padrón INEI, validado de nuevo
  // el 14-09-2026 contra las 149 entradas que ya estaban acá: coincidió código
  // por código (0 fallas) y clave por clave (148 de 149; la distinta es el alias
  // deliberado «26 de octubre» de Piura). Lima tiene 44 filas y no 43 porque
  // Santa María de Huachipa (150144) se creó en 2023 y el padrón ya lo trae.
  //
  // CALLAO ES SU PROPIA TABLA DE DESTINO pero se despacha desde la bodega de
  // Lima: `FENIX_CITY_ALIASES` lo manda a `lima` para el almacén y el stock,
  // igual que Puno se sirve desde Juliaca. Un destino del Callao con ubigeo de
  // Lima sería un distrito equivocado sin aviso; un origen del Callao sería
  // una bodega que no existe.
  lima: {
    "lima": "150101",
    "ancon": "150102",
    "ate": "150103",
    "barranco": "150104",
    "brena": "150105",
    "carabayllo": "150106",
    "chaclacayo": "150107",
    "chorrillos": "150108",
    "cieneguilla": "150109",
    "comas": "150110",
    "el agustino": "150111",
    "independencia": "150112",
    "jesus maria": "150113",
    "la molina": "150114",
    "la victoria": "150115",
    "lince": "150116",
    "los olivos": "150117",
    "lurigancho": "150118",
    "lurin": "150119",
    "magdalena del mar": "150120",
    "pueblo libre": "150121",
    "miraflores": "150122",
    "pachacamac": "150123",
    "pucusana": "150124",
    "puente piedra": "150125",
    "punta hermosa": "150126",
    "punta negra": "150127",
    "rimac": "150128",
    "san bartolo": "150129",
    "san borja": "150130",
    "san isidro": "150131",
    "san juan de lurigancho": "150132",
    "san juan de miraflores": "150133",
    "san luis": "150134",
    "san martin de porres": "150135",
    "san miguel": "150136",
    "santa anita": "150137",
    "santa maria del mar": "150138",
    "santa rosa": "150139",
    "santiago de surco": "150140",
    "surquillo": "150141",
    "villa el salvador": "150142",
    "villa maria del triunfo": "150143",
    "santa maria de huachipa": "150144",
  },
  callao: {
    "callao": "070101",
    "bellavista": "070102",
    "carmen de la legua reynoso": "070103",
    "la perla": "070104",
    "la punta": "070105",
    "ventanilla": "070106",
    "mi peru": "070107",
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

/**
 * Distritos que el padrón INEI escribe de una forma y la gente de otra.
 *
 * No son códigos alternativos —eso rompería la garantía de «un código, una
 * entrada»— sino grafías que apuntan a la clave canónica. Sin esto, una
 * dirección de Shopify que diga «Veintiséis de Octubre» (un distrito de 130 mil
 * habitantes en Piura) no resuelve y la guía se rechaza, aunque el distrito SÍ
 * esté en la tabla.
 *
 * Solo entran variantes inequívocas: ninguna de estas cadenas es el nombre de
 * otro distrito del padrón. La búsqueda sigue acotada a la ciudad, así que un
 * alias solo aplica si esa ciudad tiene la clave.
 */
const DISTRICT_ALIASES: Record<string, string> = {
  "veintiseis de octubre": "26 de octubre", // Piura
  "puerto eten": "eten puerto", // Chiclayo — el padrón lo invierte
  "zana": "sana", // Chiclayo — Zaña/Saña
  // Lima. Nadie escribe «Santiago de Surco» en una dirección: la calle dice
  // «Surco», y como no es prefijo de la clave no resolvía. Es inequívoco — no
  // hay otro distrito «surco» en el padrón — y sin él se rechazaría la guía de
  // uno de los distritos que más compra.
  "surco": "santiago de surco",
  "cercado de lima": "lima",
  "lima cercado": "lima",
  // El padrón dice «Lurigancho»; la calle, Shopify y el propio distrito dicen
  // «Chosica». Con el guion ya resuelve por prefijo, pero quien escribe solo la
  // mitad conocida no tenía cómo — y no hay otro «Chosica» en el padrón.
  "chosica": "lurigancho",
};

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

/**
 * Deja el nombre del distrito en palabras sueltas: sin el «(cercado)» que
 * teclean las operadoras y sin los guiones, barras y comas con que vienen las
 * direcciones.
 *
 * LO DEL GUION ES UN FALLO REAL, EL 15-09-2026 (#KP132394). Shopify escribe el
 * distrito con su nombre doble oficial —«Lurigancho-Chosica»— y la tabla lo
 * tiene como «lurigancho». La cobertura lo aceptaba, porque `isFenixDistrict`
 * compara sin límite de palabra; el ubigeo lo rechazaba, porque el prefijo de
 * aquí abajo sí exige un espacio. Resultado: se creó la salida pero Swayp no
 * emitió la guía, y quedó con código manual — la peor de las dos respuestas,
 * porque la operadora ya no sabe si el paquete está o no en el courier.
 *
 * Tratar el separador como espacio alinea las dos comparaciones. No afloja
 * nada: lo que decide sigue siendo la tabla, y un prefijo ambiguo sigue sin
 * resolver.
 */
function bareDistrict(district: string): string {
  return district
    .replace(/\(.*?\)/g, " ")
    .replace(/[-/,]+/g, " ")
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

  const bare = bareDistrict(raw);
  if (!bare) return fallback;
  const byBare = table[bare];
  if (byBare) return { code: byBare, district: bare, exact: true };

  // Una grafía conocida del mismo distrito, antes de intentar por prefijo.
  const alias = DISTRICT_ALIASES[bare];
  const byAlias = alias ? table[alias] : undefined;
  if (alias && byAlias) return { code: byAlias, district: alias, exact: true };

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
