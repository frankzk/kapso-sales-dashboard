import { isEffectiveOn, specificity, type CostTariff } from "@/lib/costs";
import { findDistrictOverride, type DistrictCoverageRule } from "@/lib/district-coverage";
import type { SupabaseClient } from "@supabase/supabase-js";

export type OrderCoverage = "lima" | "provincia_cod" | "agencia" | "por_revisar";

export const ORDER_COVERAGE_LABEL: Record<OrderCoverage, string> = {
  lima: "Lima",
  provincia_cod: "Provincia COD",
  agencia: "Agencia",
  por_revisar: "Por revisar",
};

const LIMA_METROPOLITANA = new Set(
  [
    "ancon",
    "ate",
    "barranco",
    "brena",
    "carabayllo",
    "chaclacayo",
    "chorrillos",
    "cieneguilla",
    "comas",
    "el agustino",
    "independencia",
    "jesus maria",
    "la molina",
    "la victoria",
    "lima",
    "lince",
    "los olivos",
    "lurigancho",
    "lurigancho chosica",
    "lurin",
    "magdalena del mar",
    "miraflores",
    "pachacamac",
    "pucusana",
    "pueblo libre",
    "puente piedra",
    "punta hermosa",
    "punta negra",
    "rimac",
    "san bartolo",
    "san borja",
    "san isidro",
    "san juan de lurigancho",
    "san juan de miraflores",
    "san luis",
    "san martin de porres",
    "san miguel",
    "santa anita",
    "santa maria del mar",
    "santa rosa",
    "santiago de surco",
    "surquillo",
    "villa el salvador",
    "villa maria del triunfo",
  ].map(normalizeCoverageLabel),
);

const CALLAO = new Set(
  [
    "bellavista",
    "callao",
    "carmen de la legua reynoso",
    "la perla",
    "la punta",
    "mi peru",
    "ventanilla",
  ].map(normalizeCoverageLabel),
);

/** Provincias del departamento de Lima que no pertenecen a Lima
 * Metropolitana. Esta señal corrige pedidos cuyo selector de Shopify quedó en
 * "Lima (provincia)" aunque la dirección escrita diga Cañete, Huaral, etc. */
const NON_METRO_LIMA_PROVINCES = new Set(
  ["barranca", "cajatambo", "canete", "canta", "huaral", "huarochiri", "huaura", "oyon", "yauyos"],
);

export function isCaneteLocation(
  location: Pick<CoverageLocation, "province" | "district">,
): boolean {
  const province = normalizeCoverageLabel(location.province);
  const district = normalizeCoverageLabel(location.district);
  return province === "canete" || district === "canete" || district.includes(" canete");
}

/**
 * ¿El pedido va a una provincia del departamento de Lima que NO es la
 * metropolitana? Esas van por agencia, no por reparto propio.
 *
 * SE MIRA TAMBIÉN EL DISTRITO, y ahí estaba el fallo. Shopify guarda a menudo el
 * nombre de la provincia en el campo del distrito: un pedido de Barranca llega
 * como región "Lima (provincia)" · provincia "Lima (provincia)" · distrito
 * "Barranca". Comparando solo `province` no casaba nada, el pedido salía como
 * Lima COD y la mesa de ruta ofrecía motorizado propio para un destino a 200 km
 * — sin ofrecer Shalom, que es la única vía real.
 *
 * Cañete ya se comprobaba en los dos campos y por eso funcionaba; las otras ocho
 * provincias no. El criterio es el mismo que el código ya aplica en la
 * contradicción inversa: el desplegable de región de Shopify es confuso, pero el
 * distrito lo escribe la clienta, así que el distrito gana.
 *
 * Se compara por palabras y no por substring para no confundir un distrito
 * metropolitano que contenga el nombre por casualidad.
 */
export function isNonMetroLimaLocation(
  location: Pick<CoverageLocation, "province" | "district">,
): boolean {
  const province = normalizeCoverageLabel(location.province);
  if (NON_METRO_LIMA_PROVINCES.has(province)) return true;
  if (isCaneteLocation(location)) return true;
  const district = normalizeCoverageLabel(location.district);
  if (NON_METRO_LIMA_PROVINCES.has(district)) return true;
  return district.split(/\s+/).some((word) => NON_METRO_LIMA_PROVINCES.has(word));
}

/**
 * Distritos de Lima Metropolitana / Callao cuyo NOMBRE se repite en otro
 * departamento (Independencia está en Lima, en Huaraz y en Pisco; La Victoria
 * también es Chiclayo; Miraflores también es Arequipa…).
 *
 * Solo se consultan cuando el pedido no trae una región utilizable: con región
 * la decisión ya está tomada y el nombre repetido da igual. Sin región, adivinar
 * "Independencia = Lima" manda un pedido de Áncash al reparto propio.
 */
const AMBIGUOUS_DISTRICTS = new Set(
  [
    "bellavista",
    "independencia",
    "la victoria",
    "miraflores",
    "pueblo libre",
    "san luis",
    "san miguel",
    "santa rosa",
  ].map(normalizeCoverageLabel),
);

const NON_COD_COURIERS = new Set(["shalom", "olva", "olva courier"]);

export function normalizeCoverageLabel(value: string | null | undefined): string {
  return (value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export interface CoverageLocation {
  storeId: string;
  orgId?: string | null;
  region: string | null;
  province: string | null;
  district: string | null;
}

/**
 * Qué dice la REGIÓN del pedido sobre Lima.
 *
 * Perú tiene dos subdivisiones distintas que se llaman Lima, y Shopify las
 * manda con su nombre completo (es lo que termina en `order_master.region`):
 *
 *   "Lima (provincia)"     PE-LMA — la provincia de Lima = Lima Metropolitana.
 *   "Lima (departamento)"  PE-LIM — el resto del departamento: Huaral, Cañete,
 *                                   Yauyos, Barranca, Huaura, Canta, Oyón…
 *
 * Esa diferencia es exactamente la que separa "Lima" de "Provincia" en la
 * operación, así que la región sola ya decide y no hace falta la provincia del
 * ubigeo (que Shopify no manda y que la tabla `peru_districts` adivina mal
 * cuando el nombre del distrito se repite).
 *
 *   "metropolitana"  Lima Metropolitana — cobertura Lima.
 *   "callao"         Callao entero (una sola provincia) — cobertura Lima.
 *   "departamento"   departamento de Lima sin la metropolitana — nunca Lima.
 *   "lima"           dice "Lima" a secas y no distingue cuál de las dos: pasa
 *                    por Excel de Aliclik, ubigeo o carga a mano. Decide el
 *                    distrito.
 *   null             no habla de Lima (otra región, o vacío).
 */
export type LimaRegionKind = "metropolitana" | "callao" | "departamento" | "lima" | null;

export function limaRegionKind(region: string | null | undefined): LimaRegionKind {
  const r = normalizeCoverageLabel(region);
  if (!r) return null;

  // Códigos ISO, por si la región llega ya codificada ("PE-LMA", "LMA").
  if (r === "cal" || r === "pe cal") return "callao";
  if (r === "lma" || r === "pe lma") return "metropolitana";
  if (r === "lim" || r === "pe lim") return "departamento";

  if (r.includes("callao")) return "callao";
  if (!r.includes("lima")) return null;

  // "Lima (provincia)" / "Lima Metropolitana" / "Municipalidad Metropolitana de Lima"
  if (r.includes("provincia") || r.includes("metropolitan")) return "metropolitana";
  // "Lima (departamento)" / "Dpto. de Lima" / "Región Lima"
  if (r.includes("departamento") || r.includes("depto") || r.includes("dpto") || r.includes("region")) {
    return "departamento";
  }
  return "lima";
}

/** ¿La PROVINCIA del ubigeo dice por sí sola que es Lima Metropolitana o Callao? */
function provinceIsLimaOrCallao(province: string | null | undefined): boolean {
  const p = normalizeCoverageLabel(province);
  if (!p) return false;
  return p === "lima" || p === "lima metropolitana" || p.includes("callao");
}

/**
 * Cómo escribe la gente los distritos de Lima, que no es como los llama el INEI.
 *
 * El distrito casi nunca lo elige de una lista: lo escribe la clienta por
 * WhatsApp o la asesora al armar el pedido. "Surco" (por Santiago de Surco) es
 * el caso más común —Surco a secas no está en el ubigeo—, y detrás vienen las
 * siglas (SJL, SMP, VMT), los nombres viejos (Ate Vitarte, Cercado de Lima) y
 * los centros poblados que la gente nombra como si fueran distrito (Huachipa,
 * que es Lurigancho).
 */
const DISTRICT_ALIASES: Record<string, string> = {
  agustino: "el agustino",
  "ate vitarte": "ate",
  cercado: "lima",
  "cercado de lima": "lima",
  "carmen de la legua": "carmen de la legua reynoso",
  chosica: "lurigancho",
  colonial: "lima",
  "el cercado": "lima",
  huachipa: "lurigancho",
  jesus: "jesus maria",
  "la colonial": "lima",
  "lima cercado": "lima",
  magdalena: "magdalena del mar",
  molina: "la molina",
  "pantanos de villa": "chorrillos",
  "puente de piedra": "puente piedra",
  "s j l": "san juan de lurigancho",
  "s j m": "san juan de miraflores",
  "s m p": "san martin de porres",
  "san juan de lurigancho sjl": "san juan de lurigancho",
  "san martin de porras": "san martin de porres",
  "sanjuan de lurigancho": "san juan de lurigancho",
  "sanjuan de miraflores": "san juan de miraflores",
  "santa beatriz": "lima",
  "santa maria de huachipa": "lurigancho",
  sjl: "san juan de lurigancho",
  sjm: "san juan de miraflores",
  smp: "san martin de porres",
  surco: "santiago de surco",
  "surco viejo": "santiago de surco",
  ves: "villa el salvador",
  "villa maria": "villa maria del triunfo",
  vitarte: "ate",
  vmt: "villa maria del triunfo",
};

/**
 * Términos demasiado genéricos para buscarlos dentro de una frase: aparecen en
 * cualquier dirección ("Av. Colonial", "casa de Jesús", "Zárate"). Se siguen
 * resolviendo cuando el distrito es exactamente eso, solo no se buscan sueltos.
 */
const TOO_GENERIC_TO_SEARCH = new Set([
  "ancon",
  "ate",
  "brena",
  "cercado",
  "comas",
  "jesus",
  "lima",
  "lince",
  "lurin",
  "rimac",
]);

/**
 * Términos reconocibles dentro de un texto más largo ("A 2 cuadras del mercado
 * de Magdalena", "Coop. Universal Santa Anita", "La Victoria en la tarde"),
 * cada uno con el distrito al que apunta.
 *
 * De más largo a más corto, para que "san juan de lurigancho" gane antes de que
 * "lurigancho" —que también está en la lista— se lo lleve.
 */
const SEARCHABLE_DISTRICTS: [term: string, district: string][] = [
  ...[...LIMA_METROPOLITANA, ...CALLAO].map((d): [string, string] => [d, d]),
  ...Object.entries(DISTRICT_ALIASES),
]
  .filter(([term]) => !TOO_GENERIC_TO_SEARCH.has(term))
  .sort((a, b) => b[0].length - a[0].length);

function containsDistrictWord(haystack: string, district: string): boolean {
  // `haystack` ya viene normalizado a palabras separadas por un espacio, así que
  // basta comparar bordes: evita que "zarate" cuente como "ate".
  return (
    haystack === district ||
    haystack.startsWith(`${district} `) ||
    haystack.endsWith(` ${district}`) ||
    haystack.includes(` ${district} `)
  );
}

/**
 * El distrito de Lima Metropolitana / Callao al que apunta el texto, o null.
 *
 * La búsqueda dentro del texto solo se usa cuando ya sabemos que el pedido es de
 * Lima por la región: fuera de ahí, "Independencia" o "La Victoria" dentro de
 * una referencia mandarían un pedido de Áncash o Chiclayo al reparto propio.
 */
export function resolveLimaDistrict(
  raw: string | null | undefined,
  { searchInText = false }: { searchInText?: boolean } = {},
): string | null {
  const d = normalizeCoverageLabel(raw);
  if (!d) return null;
  if (LIMA_METROPOLITANA.has(d) || CALLAO.has(d)) return d;
  const alias = DISTRICT_ALIASES[d];
  if (alias) return alias;
  if (!searchInText) return null;
  return SEARCHABLE_DISTRICTS.find(([term]) => containsDistrictWord(d, term))?.[1] ?? null;
}

/**
 * Distritos de Lima Metropolitana que tienen un homónimo DENTRO del propio
 * departamento de Lima: San Luis es un distrito metropolitano y también uno de
 * Cañete. Son los únicos que la región "Lima (departamento)" no puede desempatar.
 */
const LIMA_DEPT_HOMONYMS = new Set(["san luis"].map(normalizeCoverageLabel));

/**
 * ¿El pedido va a Lima Metropolitana o Callao?
 *
 * Se decide con la primera señal fiable, de más a menos:
 *   1. La región, cuando distingue metropolitana / Callao.
 *   2. El distrito, cuando la región ya nos sitúa en el departamento de Lima.
 *   3. La provincia del ubigeo, cuando no hay región.
 *
 * Una región de OTRO departamento cierra la puerta: no se mira el distrito,
 * porque los nombres se repiten por todo el país.
 */
export function isLimaMetropolitanaOrCallao(location: CoverageLocation): boolean {
  if (isNonMetroLimaLocation(location)) return false;

  const kind = limaRegionKind(location.region);
  if (kind === "metropolitana" || kind === "callao") return true;

  // Con la región ya dentro del departamento de Lima, el texto del distrito se
  // puede leer con confianza: no hay otro departamento con el que confundirlo.
  const inLima = kind !== null;
  const district = resolveLimaDistrict(location.district, { searchInText: inLima });

  // "Lima (departamento)" con un distrito metropolitano es una contradicción, y
  // la gana el distrito: en Shopify el desplegable ofrece "Lima (provincia)" y
  // "Lima (departamento)" sin explicar cuál es cuál, mientras que el distrito lo
  // escribe la clienta. Miraflores, Los Olivos o San Isidro no existen en el
  // departamento de Lima fuera de la metropolitana, así que no hay ambigüedad —
  // salvo por San Luis, que también es un distrito de Cañete.
  if (kind === "departamento") return district !== null && !LIMA_DEPT_HOMONYMS.has(district);

  // Región "Lima" a secas: el distrito desempata entre la metropolitana y el
  // resto del departamento (Huaral, Cañete, Yauyos…).
  if (kind === "lima") return district !== null;

  // Región de otro departamento: no es Lima, aunque el distrito se llame igual
  // que uno de Lima (Independencia/Huaraz, La Victoria/Chiclayo…).
  if (normalizeCoverageLabel(location.region)) return false;

  // Sin región: la provincia manda si es concluyente; si no, solo un distrito
  // que no se repita fuera de Lima.
  if (district === null) return false;
  if (provinceIsLimaOrCallao(location.province)) return true;
  return !AMBIGUOUS_DISTRICTS.has(district);
}

/**
 * Una tarifa solo prueba cobertura COD cuando:
 * - corresponde a un primer intento de reparto;
 * - identifica un courier real (una tarifa general sin courier no prueba cobertura);
 * - no pertenece a Shalom u Olva;
 * - tiene al menos un ámbito geográfico y está vigente.
 */
export function hasCodCoverage(
  tariffs: readonly CostTariff[],
  location: CoverageLocation,
  day: string,
): boolean {
  return tariffs.some((tariff) => {
    if (tariff.org_id && location.orgId && tariff.org_id !== location.orgId) return false;
    if (tariff.concept !== "primer_intento" || !isEffectiveOn(tariff, day)) return false;
    const courier = normalizeCoverageLabel(tariff.courier);
    if (!courier || NON_COD_COURIERS.has(courier)) return false;
    if (!tariff.region && !tariff.province && !tariff.district) return false;
    return specificity(tariff, {
      storeId: location.storeId,
      courier: tariff.courier,
      region: location.region,
      province: location.province,
      district: location.district,
    }) !== null;
  });
}

/**
 * QUÉ couriers tienen cobertura COD en ese destino, no solo si alguno la tiene.
 *
 * `hasCodCoverage` contesta sí/no y con eso basta para clasificar el pedido.
 * Pero quien está por llamar necesita el nombre: la pregunta de la llamada es
 * «¿esto sale por Aliclik o hay que mandarlo a agencia?», y hoy la única forma
 * de saberlo era cotizar —un paso que vive en la creación de la guía, después
 * de la llamada—. Sale de la MISMA matriz de tarifas que ya decide la cobertura,
 * así que no puede contradecirla.
 */
export function codCouriersFor(
  tariffs: readonly CostTariff[],
  location: CoverageLocation,
  day: string,
): string[] {
  const found = new Set<string>();
  for (const tariff of tariffs) {
    if (tariff.org_id && location.orgId && tariff.org_id !== location.orgId) continue;
    if (tariff.concept !== "primer_intento" || !isEffectiveOn(tariff, day)) continue;
    const courier = normalizeCoverageLabel(tariff.courier);
    if (!courier || NON_COD_COURIERS.has(courier)) continue;
    if (!tariff.region && !tariff.province && !tariff.district) continue;
    const score = specificity(tariff, {
      storeId: location.storeId,
      courier: tariff.courier,
      region: location.region,
      province: location.province,
      district: location.district,
    });
    if (score !== null && tariff.courier) found.add(tariff.courier.trim());
  }
  return [...found].sort();
}

/**
 * Cobertura operativa del pedido.
 *
 * La provincia NO es requisito: Shopify Perú no la manda (solo distrito +
 * región) y exigirla dejaba en "Por revisar" pedidos cuya región ya decía
 * "Lima (provincia)". "Por revisar" queda para lo que de verdad no se puede
 * ubicar: sin región utilizable y sin distrito.
 */
export function classifyOrderCoverage(
  location: CoverageLocation,
  tariffs: readonly CostTariff[],
  day: string,
  overrides: readonly DistrictCoverageRule[] = [],
): OrderCoverage {
  // Excepción explícita del distrito (0121). Va PRIMERO, por delante de Cañete y
  // de Lima Metropolitana: es una decisión de la operación y existe justamente
  // para poder contradecir a las reglas automáticas.
  //
  // El orden es el MISMO que el de `order_coverage_for` en la base a propósito.
  // Esta función es solo el respaldo de cuando la base no pudo responder, y dos
  // precedencias distintas darían dos respuestas a la misma pregunta — que es el
  // bug que motivó la 0104.
  const override = findDistrictOverride(overrides, location.storeId, location.district);
  if (override) return override;

  // Decisión comercial explícita: Cañete se atiende por agencia, aunque exista
  // una tarifa histórica de otro courier que accidentalmente coincida.
  if (isCaneteLocation(location)) return "agencia";
  if (isLimaMetropolitanaOrCallao(location)) return "lima";
  // Sin distrito no hay a dónde despachar ni tarifa que consultar; tampoco se
  // puede afirmar que sea agencia.
  if (!normalizeCoverageLabel(location.district)) return "por_revisar";
  return hasCodCoverage(tariffs, location, day) ? "provincia_cod" : "agencia";
}

/** Refresca la clasificación materializada tras cambiar la matriz de costos. */
export async function refreshOrderCoverage(
  admin: SupabaseClient,
  orgId: string,
): Promise<void> {
  // Primero el mapa de puntos COD (que la cobertura por coordenada consulta) y
  // luego la reclasificación. El orden importa: una tarifa nueva puede sumar
  // envíos COD a un distrito, y esos puntos deben existir antes de reclasificar.
  // Best effort, y tolerante a que la migración 0100 no esté aún desplegada:
  // si la función no existe, se sigue con la reclasificación por nombre.
  await admin.rpc("refresh_aliclik_cod_points", { p_org_id: orgId });
  await admin.rpc("refresh_order_coverage", { p_org_id: orgId });
}
