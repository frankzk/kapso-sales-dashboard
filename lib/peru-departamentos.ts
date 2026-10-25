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
