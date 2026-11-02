// La provincia que Kapta «aprende» de un distrito (`peru_districts`, MOM §13).
//
// Cuando el equipo corrige a mano la ubicación de un pedido puede pedir que se
// recuerde la provincia para los próximos pedidos de ese distrito. La tabla va
// por NOMBRE de distrito, sin departamento, y en el Perú los nombres se
// repiten: Miraflores está en Lima y en Arequipa; Independencia, en Lima y en
// Huaraz. El 21-10-2026 una corrección correcta de un pedido de Miraflores de
// Arequipa (#KP143187) dejó «miraflores → arequipa» para todos, y durante cuatro
// días los pedidos de Miraflores de Lima salieron con provincia «arequipa». El
// 19-10-2026 otra dejó «independencia → HUARAZ (Lima)», que no existe.
//
// Dos guardas, puras:
//   · `districtLearnVerdict`: qué se puede recordar. Nunca un departamento que
//     no se reconoce, nunca una provincia que no es de ese departamento y nunca
//     un distrito que ya está guardado en OTRO departamento (el homónimo).
//   · `learnedDistrictFits`: lo ya aprendido solo vale para un pedido si no
//     contradice su propio departamento. Así una fila mala no se reparte.

import { isAmbiguousLimaDistrict, resolveLimaDistrict } from "@/lib/order-coverage";
import {
  departmentKey,
  departmentsConflict,
  isKnownDepartment,
  isLimaOrCallaoProvince,
  normalizeDepartment,
  orderDepartmentKey,
  pinInLimaMetro,
  provinceFitsDepartment,
  regionMentionsLima,
} from "@/lib/peru-departamentos";

export interface LearnedDistrict {
  province: string | null;
  department: string | null;
}

export type DistrictLearnVerdict = { ok: true } | { ok: false; reason: string };

/** ¿Se puede recordar esta provincia para el distrito? `existing` es lo que ya hay en la tabla. */
export function districtLearnVerdict(
  next: { district: string; province: string; department: string | null },
  existing: LearnedDistrict | null,
): DistrictLearnVerdict {
  const where = next.district.trim();
  if (!isKnownDepartment(next.department)) {
    return {
      ok: false,
      reason: `No se recordó para ${where}: «${next.department ?? ""}» no es un departamento reconocido.`,
    };
  }
  if (!provinceFitsDepartment(next.province, next.department)) {
    return {
      ok: false,
      reason: `No se recordó para ${where}: «${next.province}» no es una provincia de ${normalizeDepartment(next.department)}.`,
    };
  }
  if (existing && departmentsConflict(existing.department, next.department)) {
    return {
      ok: false,
      reason:
        `No se recordó para ${where}: ya está guardado como distrito de ${normalizeDepartment(existing.department)}, ` +
        `y hay distritos con el mismo nombre en otros departamentos. La corrección vale solo para este pedido.`,
    };
  }
  return { ok: true };
}

/**
 * ¿Se puede juzgar la provincia de este distrito? Solo la de un distrito de
 * Lima Metropolitana o el Callao: es donde los nombres se cruzan con los de
 * provincia (Miraflores, Independencia, San Luis, Santa Rosa…) y donde sabemos
 * la lista completa. Para «Huaraz» con el departamento «Lima» —la clienta eligió
 * mal el desplegable— lo aprendido del distrito es justo lo que acierta, y no
 * se toca.
 */
function judgeable(district: string | null | undefined): boolean {
  return resolveLimaDistrict(district) !== null;
}

/**
 * Lo aprendido de un distrito, si sirve para un pedido de `district` cuyo
 * departamento es `orderRegion` (25-10-2026):
 *   · contradice el departamento del pedido → null, se sigue con el siguiente dato;
 *   · su provincia no es de ese departamento (o del suyo) → se queda el
 *     departamento y la provincia va vacía: mejor ninguna que «HUARAZ» para
 *     Independencia de Lima.
 * Fuera de Lima Metropolitana y el Callao se devuelve tal cual (`judgeable`).
 */
export function learnedDistrictFits(
  learned: LearnedDistrict | null | undefined,
  orderRegion: string | null | undefined,
  district: string | null | undefined,
): LearnedDistrict | null {
  if (!learned) return null;
  if (!judgeable(district)) return learned;
  if (departmentsConflict(learned.department, orderRegion)) return null;
  const fits = provinceFitsDepartment(learned.province, orderRegion) && provinceFitsDepartment(learned.province, learned.department);
  return fits ? learned : { province: null, department: learned.department };
}

/**
 * La provincia de una guía, si cabe en el pedido. Una salida «por definir» la
 * copia de la fila del Master, así que una provincia mal aprendida volvía por
 * aquí aunque la tabla ya estuviera bien. Misma regla y mismo alcance.
 */
export function guideProvinceFits(
  province: string | null | undefined,
  orderRegion: string | null | undefined,
  district: string | null | undefined,
): boolean {
  if (!province) return false;
  return !judgeable(district) || provinceFitsDepartment(province, orderRegion);
}

/**
 * La provincia que se IMPRIME de una caja (el rótulo, 25-10-2026). La caja
 * guarda la provincia que copió del Master al crearse, y una caja de Miraflores
 * de Lima creada con «miraflores → arequipa» aprendido salía rotulada
 * «Miraflores / arequipa» aunque el pedido ya estuviera corregido (#KP143872).
 * Si no cabe en su departamento, se imprime el de Lima o el Callao; fuera de
 * Lima Metropolitana, lo que tenga la caja.
 */
export function printedProvince(
  province: string | null | undefined,
  region: string | null | undefined,
  district: string | null | undefined,
): string | null {
  const p = province?.trim() || null;
  if (!p || guideProvinceFits(p, region, district)) return p;
  return normalizeDepartment(region) === "Callao" ? "Callao" : "Lima";
}

// ── El homónimo de Lima contra la evidencia del propio pedido (02-11-2026) ────
//
// #KP142611: un pedido de provincia COD de La Victoria, CHICLAYO, llegó del bot
// antiguo de Kapso con «Chiclayo» donde Shopify pone el departamento. Como
// «Chiclayo» no es un departamento, `departmentKey` daba null y ninguna de las
// guardas de arriba podía descartar «la victoria → lima» aprendido: el Master
// resolvió provincia «lima», la salida la copió, y la guía de reenvío de Swayp
// salió a La Victoria de LIMA. El pedido tenía con qué saberlo: el pin estaba
// en Chiclayo (-6,83, -79,83) y la primera guía de Aliclik guardó el ubigeo
// La Victoria / Chiclayo / Lambayeque.

/** Lo que el pedido dice de dónde está, aparte del nombre del distrito. */
export interface OrderLocationEvidence {
  /** El «departamento» del pedido, tal cual vino (Shopify `province`, corrección, guía…). */
  region?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  /** El departamento del ubigeo que Aliclik dedujo del pin en la primera guía. */
  ubigeoDepartment?: string | null;
}

/**
 * ¿Se puede dar Lima o el Callao como provincia de este distrito?
 *
 * Solo se juzga un distrito de Lima Metropolitana o el Callao (`judgeable`).
 * De la prueba más fuerte a la más débil:
 *   1. El pin: dentro de Lima, sí; claramente fuera (`pinInLimaMetro`), no.
 *   2. El departamento del ubigeo de la primera guía de Aliclik.
 *   3. La región del pedido, leyendo una provincia capital como su
 *      departamento («Chiclayo» → Lambayeque, `orderDepartmentKey`). Sin región,
 *      como hasta hoy: no hay nada que contradiga.
 *   4. Una región que no es ningún departamento: vale si nombra Lima o un
 *      distrito de Lima que no se repite fuera («La Molina, Lima», «HUACHIPA»);
 *      si no, Lima no se da para un distrito HOMÓNIMO (La Victoria,
 *      Independencia, Miraflores… la lista de `lima_ambiguous_districts`). Un
 *      distrito que solo existe en Lima (Comas, Surquillo) sigue siendo Lima:
 *      su propio nombre es la prueba.
 */
export function limaProvinceTrusted(
  district: string | null | undefined,
  evidence: OrderLocationEvidence,
): boolean {
  if (!judgeable(district)) return true;
  const pin = pinInLimaMetro(evidence.latitude, evidence.longitude);
  if (pin !== null) return pin;
  const ubigeo = orderDepartmentKey(evidence.ubigeoDepartment);
  if (ubigeo) return ubigeo === "lima";
  const region = evidence.region?.trim();
  if (!region) return true;
  const dep = orderDepartmentKey(region);
  if (dep) return dep === "lima";
  if (regionMentionsLima(region)) return true;
  const regionAsDistrict = resolveLimaDistrict(region);
  if (regionAsDistrict && !isAmbiguousLimaDistrict(regionAsDistrict)) return true;
  return !isAmbiguousLimaDistrict(resolveLimaDistrict(district));
}

/** ¿Lo aprendido de un distrito es la fila de Lima (provincia o departamento)? */
export function learnedIsLima(learned: LearnedDistrict | null | undefined): boolean {
  if (!learned) return false;
  return isLimaOrCallaoProvince(learned.province) || departmentKey(learned.department) === "lima";
}

/** El ubigeo que Aliclik dedujo del pin al registrar una guía. */
export interface AliclikUbigeo {
  department: string | null;
  province: string | null;
  district: string | null;
}

interface UbigeoEventLike {
  kind: string;
  occurred_at?: string | null;
  courier?: string | null;
  source?: string | null;
  payload?: unknown;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * El ubigeo de la PRIMERA guía de Aliclik del pedido (`guide_registered`,
 * `payload.ubigeo`): es el que Aliclik sacó del pin la primera vez, antes de
 * que nada del Master se copiara a una salida. null si no hay.
 */
export function firstAliclikUbigeo(events: readonly UbigeoEventLike[]): AliclikUbigeo | null {
  const registered = events
    .filter((e) => e.kind === "guide_registered" && (e.courier === "aliclik" || e.source === "aliclik"))
    .slice()
    .sort((a, b) => String(a.occurred_at ?? "").localeCompare(String(b.occurred_at ?? "")));
  for (const event of registered) {
    const payload = event.payload as { ubigeo?: Record<string, unknown> | null } | null | undefined;
    const u = payload?.ubigeo;
    if (!u || typeof u !== "object") continue;
    const found = { department: str(u.department), province: str(u.province), district: str(u.district) };
    if (found.department || found.province) return found;
  }
  return null;
}

/**
 * La provincia del ubigeo de Aliclik, solo para un pedido al que se le negó
 * Lima (`limaProvinceTrusted` en false): es la respuesta que sí casa con el pin.
 * Nunca Lima, y nunca contra el departamento del pedido.
 */
export function ubigeoProvinceFor(
  ubigeo: AliclikUbigeo | null | undefined,
  region: string | null | undefined,
): string | null {
  const province = ubigeo?.province ?? null;
  if (!province || isLimaOrCallaoProvince(province)) return null;
  const own = orderDepartmentKey(region);
  const theirs = orderDepartmentKey(ubigeo?.department);
  if (own && theirs && own !== theirs) return null;
  return province;
}
