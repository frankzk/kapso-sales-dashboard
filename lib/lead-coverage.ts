// Cobertura de un LEAD, para partir la cola de llamadas en Lima / Provincia.
// Puro.
//
// NO ES LA COBERTURA DEL PEDIDO. Esa tiene una sola definición,
// `order_coverage_for` en la base (MOM §5), y la recibe el pedido cuando nace.
// Esto es una pista para decidir a quién llamar primero, y por eso tiene un
// tercer valor que el pedido no tiene: «Sin identificar». Un lead que no dijo
// dónde vive no es de provincia; es un lead del que no se sabe.
//
// De dónde sale el dato, de más a menos fiable:
//   1. Lo que el lead dejó: la dirección del carrito de Shopify, la dirección
//      guardada del cliente (el Flow solo trae ciudad y departamento, en
//      `province`) o la respuesta del chat cuando el bot pregunta dónde enviar.
//   2. El último pedido del MISMO teléfono (`order_master.coverage`), si lo
//      propio no alcanza. Es una pista: puede haberse mudado, pero rara vez.
//
// Lo de Lima no se redefine aquí: es `isLimaMetropolitanaOrCallao`, el espejo
// en TS de `is_lima_metropolitana`, y las excepciones de `district_coverage`
// (Pucusana va por agencia) mandan igual que en el pedido.

import { findDistrictOverride, type DistrictCoverageRule } from "@/lib/district-coverage";
import {
  isAmbiguousLimaDistrict,
  isLimaMetropolitanaOrCallao,
  isNonMetroLimaLocation,
  limaRegionKind,
  normalizeCoverageLabel,
  resolveLimaDistrict,
} from "@/lib/order-coverage";
import { isKnownDepartment } from "@/lib/peru-departamentos";

export type LeadCoverage = "lima" | "provincia" | "sin_identificar";

export const LEAD_COVERAGES: { key: LeadCoverage; label: string }[] = [
  { key: "lima", label: "Lima" },
  { key: "provincia", label: "Provincia" },
  { key: "sin_identificar", label: "Sin identificar" },
];

export function isLeadCoverage(v: string | undefined | null): v is LeadCoverage {
  return !!v && LEAD_COVERAGES.some((c) => c.key === v);
}

export interface LeadCoverageSignals {
  store_id: string;
  region?: string | null;
  province?: string | null;
  district?: string | null;
}

/**
 * Lo que el texto del distrito trae delante del lugar y no es lugar: la
 * etiqueta del botón de Kapso («Selected: Lima») y las preposiciones con que
 * la gente contesta («En Comas», «De Arequipa», «Distrito de Piura»).
 *
 * Solo se quitan palabras que ningún distrito usa para empezar. «La» y «El» no
 * entran: La Molina, La Victoria y El Agustino empiezan así.
 */
const LEADING_FILLER =
  /^(?:selected|seleccionado|en|de|del|desde|a|al|para|soy|vivo|estoy|distrito|destrito|ciudad)\s+/;

function placeOf(raw: string | null | undefined): string {
  let place = normalizeCoverageLabel(raw);
  for (let prev = ""; prev !== place; ) {
    prev = place;
    place = place.replace(LEADING_FILLER, "");
  }
  return place;
}

/**
 * Departamentos, provincias y ciudades fuera de Lima Metropolitana y Callao,
 * para leer la respuesta libre del chat («Trujillo», «En HUANCAYO», «Arequipa
 * cuanto tarda en llegar»). Es la lista del INEI más las ciudades que la gente
 * nombra y no son provincia (Juliaca, Chimbote, Tarapoto, Pucallpa…).
 *
 * FUERA A PROPÓSITO:
 *   - Lo que también es Lima o Callao: «Santa» (Santa Anita, Santa Rosa),
 *     «San Miguel», «Bellavista», «San Martín» (San Martín de Porres). El
 *     departamento de San Martín sigue reconociéndose por la región; en el chat
 *     la gente dice Tarapoto o Moyobamba, que sí están.
 *   - Nombres de calles de Lima o palabras comunes: «Grau», «Bolívar», «Sucre»
 *     (avenidas) y «Canas» (las canas). Son provincias pequeñas; perderlas
 *     cuesta menos que mandar a provincia a alguien de la avenida Grau.
 */
const PROVINCE_PLACES: readonly string[] = [
  // Departamentos (Lima y Callao aparte).
  "amazonas", "ancash", "apurimac", "arequipa", "ayacucho", "cajamarca", "cusco", "cuzco",
  "huancavelica", "huanuco", "ica", "junin", "la libertad", "lambayeque", "loreto",
  "madre de dios", "moquegua", "pasco", "piura", "puno", "tacna", "tumbes", "ucayali",
  // Provincias del INEI.
  "chachapoyas", "bagua", "bongara", "condorcanqui", "luya", "rodriguez de mendoza", "utcubamba",
  "huaraz", "aija", "antonio raymondi", "asuncion", "bolognesi", "carhuaz", "carlos fermin fitzcarrald",
  "casma", "corongo", "huari", "huarmey", "huaylas", "mariscal luzuriaga", "ocros", "pallasca",
  "pomabamba", "recuay", "sihuas", "yungay",
  "abancay", "andahuaylas", "antabamba", "aymaraes", "cotabambas", "chincheros",
  "camana", "caraveli", "castilla", "caylloma", "condesuyos", "islay", "la union",
  "huamanga", "cangallo", "huanca sancos", "huanta", "la mar", "lucanas", "parinacochas",
  "paucar del sara sara", "victor fajardo", "vilcas huaman",
  "cajabamba", "celendin", "chota", "contumaza", "cutervo", "hualgayoc", "jaen", "san ignacio",
  "san marcos", "san pablo", "santa cruz",
  "acomayo", "anta", "calca", "canchis", "chumbivilcas", "espinar", "la convencion", "paruro",
  "paucartambo", "quispicanchi", "urubamba",
  "acobamba", "angaraes", "castrovirreyna", "churcampa", "huaytara", "tayacaja",
  "ambo", "dos de mayo", "huacaybamba", "huamalies", "leoncio prado", "maranon", "pachitea",
  "puerto inca", "lauricocha", "yarowilca",
  "chincha", "nasca", "nazca", "palpa", "pisco",
  "huancayo", "concepcion", "chanchamayo", "jauja", "satipo", "tarma", "yauli", "chupaca",
  "trujillo", "ascope", "chepen", "julcan", "otuzco", "pacasmayo", "pataz", "sanchez carrion",
  "santiago de chuco", "gran chimu", "viru",
  "chiclayo", "ferrenafe",
  "barranca", "cajatambo", "canta", "canete", "huaral", "huarochiri", "huaura", "oyon", "yauyos",
  "maynas", "alto amazonas", "mariscal ramon castilla", "requena", "datem del maranon", "putumayo",
  "tambopata", "manu", "tahuamanu",
  "mariscal nieto", "general sanchez cerro", "ilo",
  "daniel alcides carrion", "oxapampa",
  "ayabaca", "huancabamba", "morropon", "paita", "sullana", "talara", "sechura",
  "azangaro", "carabaya", "chucuito", "el collao", "huancane", "lampa", "melgar", "moho",
  "san antonio de putina", "san roman", "sandia", "yunguyo",
  "moyobamba", "el dorado", "huallaga", "lamas", "mariscal caceres", "picota", "rioja", "tocache",
  "candarave", "jorge basadre", "tarata",
  "contralmirante villar", "zarumilla",
  "coronel portillo", "atalaya", "padre abad", "purus",
  // Ciudades que no se llaman como su provincia.
  "juliaca", "chimbote", "nuevo chimbote", "tarapoto", "pucallpa", "iquitos", "puerto maldonado",
  "huacho", "chancay", "sicuani", "pichanaki", "pichanaqui", "majes", "la oroya", "tingo maria",
  "yurimaguas", "bagua grande", "chulucanas", "catacaos", "chincha alta", "huamachuco", "juanjui",
  "la merced", "quillabamba", "ayaviri", "ilave", "mollendo", "cerro de pasco", "paramonga",
];

function hasWord(haystack: string, term: string): boolean {
  return (
    haystack === term ||
    haystack.startsWith(`${term} `) ||
    haystack.endsWith(` ${term}`) ||
    haystack.includes(` ${term} `)
  );
}

function mentionsProvincePlace(place: string): boolean {
  return PROVINCE_PLACES.some((term) => hasWord(place, term));
}

/** Lo que dice SU PROPIA dirección, sin mirar pedidos anteriores. */
function coverageFromLocation(
  lead: LeadCoverageSignals,
  overrides: readonly DistrictCoverageRule[],
): LeadCoverage {
  // El Flow de Shopify deja el departamento en `province` y nada en `region`;
  // el carrito llena las dos con lo mismo. Sin esto, «Lima (provincia)» con un
  // distrito ilegible salía como agencia en vez de Lima.
  const region = (lead.region ?? "").trim() || (lead.province ?? "").trim() || null;
  const place = placeOf(lead.district);

  // La respuesta al botón «¿Lima o provincia?» del bot. «Lima» la resuelve la
  // regla de Lima de abajo, como cualquier distrito.
  if (place === "provincia" || place === "provincias") return "provincia";

  // La decisión explícita de la operación gana, como en el pedido.
  const override = findDistrictOverride(overrides, lead.store_id, place);
  if (override) return override === "lima" ? "lima" : "provincia";

  const location = { storeId: lead.store_id, region, province: lead.province ?? null, district: place };
  if (isLimaMetropolitanaOrCallao(location)) return "lima";
  if (isNonMetroLimaLocation(location)) return "provincia";

  // «Lima (provincia)» y Callao ya respondieron arriba; aquí solo llegan las
  // dos Limas que no distinguen la ciudad del resto del departamento.
  const kind = limaRegionKind(region);
  if (kind === "departamento" || kind === "lima") {
    // «Lima (departamento)» NO alcanza para decir provincia: el desplegable de
    // Shopify confunde, y de los pedidos con esa región de los últimos 120 días
    // 188 de 633 (30 %) resultaron de Lima Metropolitana por su distrito.
    // Sin un distrito legible no se sabe.
    return mentionsProvincePlace(place) ? "provincia" : "sin_identificar";
  }
  // Otra región conocida (Arequipa, Cusco…): provincia, diga lo que diga el
  // distrito — «Miraflores» en Arequipa es Arequipa.
  if (region && isKnownDepartment(region)) return "provincia";

  // Sin región que sirva: leer la respuesta libre del chat.
  if (!place) return "sin_identificar";
  // Un distrito que existe en Lima y en provincia (Independencia, La
  // Victoria…) dicho a secas no se puede ubicar.
  if (isAmbiguousLimaDistrict(resolveLimaDistrict(place))) return "sin_identificar";
  const limaMention = resolveLimaDistrict(place, { searchInText: true });
  const lima = limaMention !== null && !isAmbiguousLimaDistrict(limaMention);
  const provincia = mentionsProvincePlace(place);
  // Si nombra las dos («Av. Arequipa, Chorrillos»: calle con nombre de
  // provincia en un distrito de Lima), no se adivina.
  if (lima && !provincia) return "lima";
  if (provincia && !lima) return "provincia";
  return "sin_identificar";
}

/**
 * Cobertura del lead para la cola de llamadas.
 *
 * `priorCoverage` es la cobertura del último pedido del mismo teléfono
 * (`order_master.coverage`), o null si no compró antes. Solo decide cuando la
 * dirección del propio lead no dice nada: lo que contestó hoy es más nuevo.
 */
export function leadCoverage(
  lead: LeadCoverageSignals,
  {
    priorCoverage = null,
    overrides = [],
  }: { priorCoverage?: string | null; overrides?: readonly DistrictCoverageRule[] } = {},
): LeadCoverage {
  const own = coverageFromLocation(lead, overrides);
  if (own !== "sin_identificar") return own;
  if (priorCoverage === "lima") return "lima";
  if (priorCoverage === "provincia_cod" || priorCoverage === "agencia") return "provincia";
  return "sin_identificar";
}

export function countLeadCoverage(coverages: Iterable<LeadCoverage>): Record<LeadCoverage, number> {
  const out: Record<LeadCoverage, number> = { lima: 0, provincia: 0, sin_identificar: 0 };
  for (const c of coverages) out[c] += 1;
  return out;
}
