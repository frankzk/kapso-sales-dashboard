// «Distrito por revisar» (MOM §19.0.3, owner 08-11-2026).
//
// El formulario web deja elegir la provincia y el distrito, y muchas clientas
// eligen la capital: #KP202409 llegó con distrito «Arequipa» y dirección «AV
// solo 709 campo marte paucarpata». Kapta le pasa ese distrito a la guía del
// courier (Swayp, Aliclik, Olva) y Swayp fue a Arequipa Cercado y anuló la
// guía. La regla que los encuentra es esta, pura:
//
//   · el pedido es de provincia: la cobertura no es Lima ni Agencia;
//   · el distrito, normalizado, es igual a la provincia (la capital);
//   · la dirección menciona —palabra entera, sin tildes ni mayúsculas— OTRO
//     distrito de la MISMA provincia y departamento (`peru_districts`), de 5
//     letras o más (los nombres cortos casan con cualquier cosa).
//
// Es un AVISO: no hay estado nuevo ni se bloquea nada que no se pueda crear
// igual con un clic explícito. La corrección es la de siempre
// (`updateOrderGeo`), con solo el distrito y su nota.

export interface DistrictMismatchOrder {
  district: string | null | undefined;
  province: string | null | undefined;
  /** Departamento del pedido (`order_master.region`). */
  region: string | null | undefined;
  address: string | null | undefined;
  coverage?: string | null;
}

/** Una fila de `peru_districts`. */
export interface ProvinceDistrict {
  district: string;
  province: string | null;
  department: string | null;
}

export interface DistrictMismatch {
  /** El distrito que trae el pedido, tal cual («Arequipa»). */
  current: string;
  /** Los distritos que menciona la dirección, para corregir con un clic. */
  suggested: string[];
}

/** Los distritos de menos letras casan con cualquier dirección. */
export const DISTRICT_MISMATCH_MIN_LENGTH = 5;

export const DISTRICT_REVIEW_LABEL = "Distrito por revisar";

/** Minúsculas, sin tildes y con todo lo que no es letra o número como espacio. */
export function normalizeGeoName(value: string | null | undefined): string {
  return (value ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

const EXCLUDED_COVERAGE = new Set(["lima", "agencia"]);

/** Las palabras que van en minúscula dentro de un nombre («José Luis Bustamante y Rivero»). */
const PARTICLES = new Set(["de", "del", "la", "las", "los", "el", "y"]);

/**
 * El nombre como se enseña y como se guarda al corregir: la tabla trae a veces
 * «cayma» o «LA BANDA DE SHILCAYO» (filas que se escribieron a mano). Un nombre
 * con mayúsculas y minúsculas se respeta tal cual.
 */
export function displayDistrictName(name: string): string {
  const trimmed = name.trim().replace(/\s+/g, " ");
  if (trimmed !== trimmed.toLowerCase() && trimmed !== trimmed.toUpperCase()) return trimmed;
  return trimmed
    .toLowerCase()
    .split(" ")
    .map((word, i) => (i > 0 && PARTICLES.has(word) ? word : word.charAt(0).toUpperCase() + word.slice(1)))
    .join(" ");
}

/**
 * ¿El distrito del pedido es la capital de provincia y la dirección nombra otro
 * distrito de esa misma provincia? `null` si no hay nada que revisar.
 *
 * `provinceDistricts` puede traer distritos de cualquier provincia: aquí se
 * quedan solo los de la provincia y el departamento del pedido.
 */
export function districtMismatch(
  order: DistrictMismatchOrder,
  provinceDistricts: readonly ProvinceDistrict[],
): DistrictMismatch | null {
  if (order.coverage && EXCLUDED_COVERAGE.has(order.coverage)) return null;
  const current = (order.district ?? "").trim();
  const district = normalizeGeoName(current);
  const province = normalizeGeoName(order.province);
  const department = normalizeGeoName(order.region);
  if (!district || !province || !department || district !== province) return null;
  const address = normalizeGeoName(order.address);
  if (!address) return null;
  const haystack = ` ${address} `;

  const found = new Map<string, string>();
  for (const row of provinceDistricts) {
    if (normalizeGeoName(row.province) !== province) continue;
    if (normalizeGeoName(row.department) !== department) continue;
    const key = normalizeGeoName(row.district);
    if (!key || key === district || key.length < DISTRICT_MISMATCH_MIN_LENGTH) continue;
    if (!haystack.includes(` ${key} `)) continue;
    if (!found.has(key)) found.set(key, displayDistrictName(row.district));
  }
  if (!found.size) return null;

  // «San Jerónimo de Tunán» ya contiene «San Jerónimo»: si casan los dos, la
  // dirección dice el largo.
  const keys = [...found.keys()];
  const suggested = keys
    .filter((key) => !keys.some((other) => other !== key && ` ${other} `.includes(` ${key} `)))
    .map((key) => found.get(key)!)
    .sort((a, b) => a.localeCompare(b, "es"));
  return { current, suggested };
}

/** «Paucarpata», «Paucarpata o Cayma», «Paucarpata, Cayma o Sachaca». */
function joinOr(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} o ${names[names.length - 1]}`;
}

/** «La dirección dice Paucarpata y el distrito es Arequipa.» */
export function districtMismatchText(mismatch: DistrictMismatch): string {
  return `La dirección dice ${joinOr(mismatch.suggested)} y el distrito es ${mismatch.current}.`;
}

/** La nota que queda en la corrección y en el historial del pedido. */
export function districtFixNote(suggested: string): string {
  return `Distrito corregido: la dirección dice ${suggested}.`;
}

/** «Corregir a Paucarpata». */
export function districtFixLabel(suggested: string): string {
  return `Corregir a ${suggested}`;
}

/** «Crear con Arequipa igual»: crear la guía sin corregir, a sabiendas. */
export function districtKeepLabel(mismatch: DistrictMismatch): string {
  return `Crear con ${mismatch.current} igual`;
}

/**
 * Patrón `ilike` que casa una provincia escrita con o sin tildes y en
 * cualquier caja: cada letra que puede llevar tilde (y todo lo que no es una
 * letra simple) pasa a `_`, el comodín de un carácter. Lo afina después
 * `districtMismatch` con la comparación normalizada. Sirve para traer de
 * `peru_districts` solo las provincias que hacen falta en UNA consulta.
 */
export function provinceIlikePattern(province: string): string | null {
  const plain = province.trim().toLowerCase();
  if (!plain) return null;
  return [...plain].map((ch) => (/[bcdfghjklmnpqrstvwxz0-9]/.test(ch) ? ch : "_")).join("");
}

/** Las provincias distintas de un conjunto de pedidos que pueden tener el aviso. */
export function provincesToCheck(orders: readonly DistrictMismatchOrder[]): string[] {
  const out = new Map<string, string>();
  for (const order of orders) {
    if (order.coverage && EXCLUDED_COVERAGE.has(order.coverage)) continue;
    const province = normalizeGeoName(order.province);
    if (!province || normalizeGeoName(order.district) !== province) continue;
    if (!out.has(province)) out.set(province, (order.province ?? "").trim());
  }
  return [...out.values()];
}
