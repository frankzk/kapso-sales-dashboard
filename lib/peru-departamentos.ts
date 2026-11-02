/**
 * El DEPARTAMENTO de una guía, escrito de una sola manera.
 *
 * La columna `region` viene del Excel de Aliclik y del checkout de Shopify, y
 * nadie la escribe igual dos veces. Medido en producción el 14-09-2026: **77
 * valores distintos** para 25 departamentos. El filtro de la cola agrupa por
 * esta columna, así que Junín aparecía dos veces en el desplegable —«Junín» con
 * 501 filas y «Junin» con 125—, y elegir una escondía la otra. Lo mismo con
 * Áncash, Huánuco, Apurímac, San Martín, Cusco/Cuzco e Ica.
 *
 * LO QUE ESTE MÓDULO **NO** HACE, Y ES LA PARTE IMPORTANTE.
 *
 * No fusiona «Lima (provincia)» con «Lima (departamento)». Parecen la misma
 * etiqueta mal escrita y no lo son: `limaRegionKind` (lib/order-coverage.ts) lee
 * exactamente ese sufijo para decidir la cobertura, y los distritos lo
 * confirman — en «(provincia)» están Miraflores, Surco y Puente Piedra; en
 * «(departamento)» están Barranca, Cañete, Canta y Sayán, que son otras
 * provincias del departamento de Lima. Unificarlas habría roto el ruteo.
 *
 * Tampoco adivina el departamento de un distrito suelto. En la columna se
 * cuelan «Trujillo», «Chorrillos» o «Av Mariátegui mercado orizonte»: se dejan
 * tal cual, porque un dato sucio que se ve es mejor que uno inventado que no.
 *
 * Es seguro para la cobertura por construcción: `normalizeCoverageLabel` ya
 * compara sin tildes y en minúsculas, así que arreglar la ortografía no cambia
 * ninguna decisión de courier.
 */

/** Compara sin tildes, sin mayúsculas y sin puntuación. Solo para cotejar. */
function clave(raw: string): string {
  return raw
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Los 24 departamentos del Perú más la Provincia Constitucional del Callao,
 * en su grafía oficial. Lima queda fuera a propósito: la resuelve `limaCanonica`
 * porque arrastra un matiz de cobertura que los demás no tienen.
 */
const DEPARTAMENTOS = [
  "Amazonas",
  "Áncash",
  "Apurímac",
  "Arequipa",
  "Ayacucho",
  "Cajamarca",
  "Callao",
  "Cusco",
  "Huancavelica",
  "Huánuco",
  "Ica",
  "Junín",
  "La Libertad",
  "Lambayeque",
  "Loreto",
  "Madre de Dios",
  "Moquegua",
  "Pasco",
  "Piura",
  "Puno",
  "San Martín",
  "Tacna",
  "Tumbes",
  "Ucayali",
] as const;

const POR_CLAVE = new Map(DEPARTAMENTOS.map((d) => [clave(d), d as string]));

/** Grafías alternativas que son el MISMO departamento, no otro sitio. */
const ALIAS: Record<string, string> = {
  // Cusco/Cuzco conviven en el Excel; la grafía oficial desde 1976 es Cusco.
  cuzco: "Cusco",
  // La Provincia Constitucional, como la escribe medio Perú.
  "provincia constitucional del callao": "Callao",
  // Erratas vistas en producción, sin ambigüedad posible.
  arequira: "Arequipa",
};

/**
 * Lima, que es la que tiene matiz.
 *
 * Devuelve la grafía canónica CONSERVANDO cuál de las tres Limas es, porque
 * `limaRegionKind` la necesita:
 *   - «Lima (provincia)» / «Lima Metropolitana» → la ciudad.
 *   - «Lima (departamento)» / «Región Lima»     → el resto del departamento.
 *   - «Lima» a secas                            → no consta cuál. Se respeta.
 */
function limaCanonica(k: string): string | null {
  if (k.includes("callao")) return "Callao";
  if (!k.includes("lima")) return null;
  if (k.includes("provincia") || k.includes("metropolitan")) return "Lima (provincia)";
  if (k.includes("departamento") || k.includes("depto") || k.includes("dpto") || k.includes("region")) {
    return "Lima (departamento)";
  }
  // «Lima» sola, o con basura pegada («La Molina, Lima»): solo se canoniza la
  // que ES exactamente Lima; lo demás se deja como vino.
  return k === "lima" ? "Lima" : null;
}

/**
 * La grafía canónica de un departamento, o el valor original si no se reconoce.
 *
 * Nunca devuelve algo que no venga del dato: o es un departamento conocido, o
 * es lo que escribieron, limpio de espacios sobrantes.
 */
export function normalizeDepartment(raw: string | null | undefined): string | null {
  const limpio = (raw ?? "").trim().replace(/\s+/g, " ");
  if (!limpio) return null;

  const k = clave(limpio);
  if (!k) return null;

  const lima = limaCanonica(k);
  if (lima) return lima;

  return ALIAS[k] ?? POR_CLAVE.get(k) ?? limpio;
}

/** ¿Es un departamento que sabemos nombrar? Útil para separar dato de basura. */
export function isKnownDepartment(raw: string | null | undefined): boolean {
  const n = normalizeDepartment(raw);
  if (!n) return false;
  return n.startsWith("Lima") || n === "Callao" || POR_CLAVE.has(clave(n));
}

/**
 * El departamento como CLAVE para comparar: las tres Limas y el Callao son la
 * misma (el área metropolitana, que es lo que separa una Miraflores de otra);
 * los demás, su nombre sin tildes. Lo que no se reconoce como departamento da
 * null: no se puede usar para descartar nada.
 */
export function departmentKey(raw: string | null | undefined): string | null {
  if (!isKnownDepartment(raw)) return null;
  const n = normalizeDepartment(raw)!;
  return n.startsWith("Lima") || n === "Callao" ? "lima" : clave(n);
}

/**
 * Provincias CAPITAL de departamento cuyo nombre no es el del departamento
 * (02-11-2026, #KP142611). Shopify llama `province` al departamento, y un
 * carrito del bot antiguo de Kapso dejó ahí «Chiclayo»: una provincia. Con un
 * «departamento» que no se reconoce no había con qué descartar «la victoria →
 * lima» aprendido, y el pedido de La Victoria de Chiclayo salió a Lima.
 *
 * FUENTE Y LÍMITE. Solo las capitales —la provincia XX01 de cada departamento
 * del INEI— cuyo nombre difiere del departamento (las que se llaman igual,
 * Arequipa o Cusco, ya se reconocen como departamento). Cotejadas con lo que
 * hay en el repo: `PROVINCE_PLACES` de lib/lead-coverage.ts (provincias del
 * INEI, una línea por departamento y la capital primero), los códigos INEI de
 * lib/ubigeo.ts (Chiclayo 1401, Huancayo 1201, Trujillo 1301), Ayacucho /
 * Huamanga en lib/costs.ts y la 0085, «CORONEL PORTILLO, UCAYALI» en
 * lib/aliclik-status.ts, Iquitos / Maynas / Loreto y Tambopata / Madre de Dios
 * en las pruebas, y el ubigeo de Aliclik del propio #KP142611 (Chiclayo,
 * Lambayeque). No es el catálogo del INEI: no hay uno completo en el repo, y
 * no se inventa de memoria.
 *
 * FUERA A PROPÓSITO lo ambiguo: «Bellavista» es distrito del Callao y provincia
 * de San Martín; «Santa», «San Martín» o «Castilla» chocan con Lima o con un
 * departamento. Para esos solo decide el pin.
 */
const PROVINCIA_CAPITAL_A_DEPARTAMENTO: Readonly<Record<string, string>> = Object.freeze({
  chachapoyas: "Amazonas",
  huaraz: "Áncash",
  abancay: "Apurímac",
  huamanga: "Ayacucho",
  huancayo: "Junín",
  trujillo: "La Libertad",
  chiclayo: "Lambayeque",
  maynas: "Loreto",
  tambopata: "Madre de Dios",
  "mariscal nieto": "Moquegua",
  moyobamba: "San Martín",
  "coronel portillo": "Ucayali",
});

/** El departamento de una provincia capital escrita donde iba el departamento, o null. */
export function departmentFromCapitalProvince(raw: string | null | undefined): string | null {
  const k = clave((raw ?? "").replace(/\s+/g, " "));
  return k ? (PROVINCIA_CAPITAL_A_DEPARTAMENTO[k] ?? null) : null;
}

/**
 * La clave del departamento de un PEDIDO: la de `departmentKey` y, si el texto
 * es una provincia capital («Chiclayo»), la de su departamento. Solo para
 * juzgar la ubicación (Master y guarda de Swayp): no cambia cómo se agrupa ni
 * cómo se muestra la región, que sigue siendo lo que vino.
 */
export function orderDepartmentKey(raw: string | null | undefined): string | null {
  return departmentKey(raw) ?? departmentKey(departmentFromCapitalProvince(raw));
}

/** ¿El texto nombra Lima o el Callao, aunque venga con más cosas («La Molina, Lima»)? */
export function regionMentionsLima(raw: string | null | undefined): boolean {
  const words = clave(raw ?? "").split(" ");
  return words.includes("lima") || words.includes("callao");
}

/**
 * ¿La provincia es Lima Metropolitana o el Callao? «lima», «LIMA», «Lima
 * (provincia)», «Callao»… Las otras nueve provincias del departamento de Lima
 * (Huaral, Cañete…) no lo son.
 */
export function isLimaOrCallaoProvince(province: string | null | undefined): boolean {
  return departmentKey(province) === "lima";
}

/**
 * Caja CONSERVADORA de Lima Metropolitana y el Callao (02-11-2026): de Ancón y
 * Ventanilla a Pucusana, del mar a Chosica y Cieneguilla. Es más grande que el
 * área metropolitana a propósito —deja dentro Chancay o Chilca—, porque sirve
 * para decir «este pin NO es de Lima» y ahí solo vale lo que está claramente
 * fuera: Chiclayo (-6,8), Huaraz (-9,5) o Huacho (-11,1).
 */
export const LIMA_METRO_BBOX = Object.freeze({ minLat: -12.6, maxLat: -11.5, minLng: -77.3, maxLng: -76.6 });

/**
 * ¿El pin cae en Lima Metropolitana o el Callao? null si no hay pin utilizable
 * (falta una de las dos, no son números o es el 0,0 de un geocodificador que no
 * encontró nada).
 */
export function pinInLimaMetro(
  latitude: number | null | undefined,
  longitude: number | null | undefined,
): boolean | null {
  if (latitude == null || longitude == null) return null;
  const lat = Number(latitude);
  const lng = Number(longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || (lat === 0 && lng === 0)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  const b = LIMA_METRO_BBOX;
  return lat >= b.minLat && lat <= b.maxLat && lng >= b.minLng && lng <= b.maxLng;
}

/** ¿Dos departamentos se contradicen? Solo si los dos se conocen y son distintos. */
export function departmentsConflict(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = departmentKey(a);
  const y = departmentKey(b);
  return Boolean(x && y && x !== y);
}

/**
 * Las provincias del departamento de Lima (INEI) y el Callao, como claves: la
 * provincia de un pedido de Lima solo puede ser una de estas. «HUARAZ» o «LA
 * MOLINA» (un distrito) no lo son.
 */
const PROVINCIAS_DE_LIMA = new Set([
  "lima",
  "lima provincia",
  "lima metropolitana",
  // Shopify llama `province` al departamento y esa etiqueta se cuela como
  // provincia: es Lima, no otro sitio.
  "lima departamento",
  "callao",
  "provincia constitucional del callao",
  "barranca",
  "cajatambo",
  "canta",
  "canete",
  "huaral",
  "huarochiri",
  "huaura",
  "oyon",
  "yauyos",
]);

/** Provincias que se llaman como OTRO departamento: Ucayali es una provincia de Loreto. */
const PROVINCIA_EN_OTRO_DEPARTAMENTO: Record<string, string> = { ucayali: "loreto" };

/**
 * ¿La provincia cabe en el departamento? (25-10-2026, caso Miraflores.)
 *
 * Sin departamento conocido no se sabe, y se acepta. En Lima, solo sus diez
 * provincias y el Callao. En otro departamento se descarta una provincia que se
 * llama como un departamento distinto —«arequipa» para un pedido de Lima,
 * «lima» para uno de Arequipa—: las capitales llevan el nombre de su
 * departamento, así que esa provincia es de allá. El resto no se puede juzgar
 * sin el catálogo completo del INEI, y se acepta.
 */
export function provinceFitsDepartment(province: string | null | undefined, department: string | null | undefined): boolean {
  const dep = departmentKey(department);
  if (!dep) return true;
  const p = clave(province ?? "");
  if (!p) return true;
  if (dep === "lima") return PROVINCIAS_DE_LIMA.has(p);
  if (PROVINCIA_EN_OTRO_DEPARTAMENTO[p]) return PROVINCIA_EN_OTRO_DEPARTAMENTO[p] === dep || p === dep;
  const asDep = departmentKey(province);
  return !asDep || asDep === dep;
}
