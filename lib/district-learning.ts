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

import { resolveLimaDistrict } from "@/lib/order-coverage";
import { departmentsConflict, isKnownDepartment, normalizeDepartment, provinceFitsDepartment } from "@/lib/peru-departamentos";

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
