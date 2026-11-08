// El ubigeo que la clienta ELIGIÓ en el formulario de la web (08-11-2026, MOM §38.6).
//
// El formulario contra entrega de WooCommerce (COD Core) no le pide a la clienta
// que escriba su provincia: le hace elegir departamento, provincia y distrito de
// tres desplegables encadenados y guarda el resultado en `meta_data` con la
// clave `_cod_territorio`:
//
//     { "codigo": "050101", "region": "Ayacucho", "provincia": "Huamanga", "distrito": "Ayacucho" }
//
// La dirección de envío con forma de Shopify que arma `mapWooOrder` solo lleva
// el distrito (`city`) y el departamento (`state`): la provincia se perdía, y el
// Master la deducía del NOMBRE del distrito en `peru_districts`. Ahí había filas
// aprendidas a mano que estaban mal —«Ayacucho → CORACORA» desde el 15-10 y
// «Puno → San Roman» desde el 24-08— y los pedidos de la web de esos distritos
// salían con la provincia de otro sitio aunque la clienta la hubiera elegido
// bien. Medido el 08-11-2026: 2.579 pedidos con `_cod_territorio`, 214 con otra
// provincia en el Master.
//
// Dos funciones, puras:
//   · `wooTerritorio`: lee el ubigeo de `orders.raw`, con desconfianza (puede
//     faltar, venir como texto JSON, a medias o contradiciéndose).
//   · `territorioForOrder`: si ese ubigeo vale para el pedido tal como está hoy.
//     No vale si el departamento del pedido (la corrección del equipo o el
//     desplegable de la dirección) es otro, ni si el distrito del pedido ya no
//     es el del ubigeo (el equipo lo corrigió, o se editó en WooCommerce): en
//     esos casos la provincia del ubigeo es la de OTRO lugar.

import { departmentsConflict, isKnownDepartment, normalizeDepartment, provinceFitsDepartment } from "@/lib/peru-departamentos";
import { normalizeDistrict } from "@/lib/shipments";

/** La clave de `meta_data` donde COD Core guarda el ubigeo elegido. */
export const WOO_TERRITORIO_META_KEY = "_cod_territorio";

export interface WooTerritorio {
  /** El código INEI de 6 dígitos, si vino bien formado. No se guarda en el Master (no hay columna). */
  code: string | null;
  /** El departamento tal como lo eligió la clienta («Lima», «Junín»…). */
  department: string;
  province: string;
  district: string;
}

/**
 * Los departamentos por los dos primeros dígitos del ubigeo del INEI. Solo para
 * comprobar que el código y el nombre dicen lo mismo, y para separar Lima
 * Metropolitana (1501) del resto del departamento.
 */
const DEPARTAMENTO_POR_CODIGO: Readonly<Record<string, string>> = Object.freeze({
  "01": "Amazonas",
  "02": "Áncash",
  "03": "Apurímac",
  "04": "Arequipa",
  "05": "Ayacucho",
  "06": "Cajamarca",
  "07": "Callao",
  "08": "Cusco",
  "09": "Huancavelica",
  "10": "Huánuco",
  "11": "Ica",
  "12": "Junín",
  "13": "La Libertad",
  "14": "Lambayeque",
  "15": "Lima",
  "16": "Loreto",
  "17": "Madre de Dios",
  "18": "Moquegua",
  "19": "Pasco",
  "20": "Piura",
  "21": "Puno",
  "22": "San Martín",
  "23": "Tacna",
  "24": "Tumbes",
  "25": "Ucayali",
});

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function text(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().replace(/\s+/g, " ");
  return trimmed || null;
}

/** El código de 6 dígitos. Un número pierde el cero de la izquierda (50101 → «050101»). */
function ubigeoCode(value: unknown): string | null {
  const raw = typeof value === "number" && Number.isInteger(value) && value > 0 ? String(value).padStart(6, "0") : text(value);
  return raw && /^\d{6}$/.test(raw) ? raw : null;
}

/** «Lima» y «Lima (provincia)» son el mismo departamento para el código; el Callao, el suyo. */
function codeDepartmentKey(name: string): string {
  const n = normalizeDepartment(name) ?? name;
  if (n === "Callao") return "callao";
  return n.startsWith("Lima") ? "lima" : n;
}

/**
 * El ubigeo `_cod_territorio` de un pedido de WooCommerce (`orders.raw.woo`), o
 * null. Acepta el valor como objeto o como texto JSON; si hay más de una entrada
 * con esa clave manda la última, que es la más reciente en WooCommerce.
 *
 * Solo se devuelve completo y coherente: con departamento, provincia y
 * distrito; un departamento que se reconoce; una provincia que cabe en él
 * (`provinceFitsDepartment`) y, si el código vino, un código del mismo
 * departamento. Un ubigeo a medias o que se contradice no es «el que eligió».
 */
export function wooTerritorio(raw: unknown): WooTerritorio | null {
  const meta = record(record(raw)?.woo)?.meta_data;
  if (!Array.isArray(meta)) return null;
  let value: unknown = undefined;
  for (const entry of meta) {
    const m = record(entry);
    if (m && m.key === WOO_TERRITORIO_META_KEY) value = m.value;
  }
  if (typeof value === "string" && value.trim().startsWith("{")) {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      return null;
    }
  }
  const v = record(value);
  if (!v) return null;
  const department = text(v.region);
  const province = text(v.provincia);
  const district = text(v.distrito);
  if (!department || !province || !district) return null;
  if (!isKnownDepartment(department) || !provinceFitsDepartment(province, department)) return null;
  const code = ubigeoCode(v.codigo);
  if (code) {
    const fromCode = DEPARTAMENTO_POR_CODIGO[code.slice(0, 2)];
    if (!fromCode || codeDepartmentKey(fromCode) !== codeDepartmentKey(department)) return null;
  }
  return { code, department, province, district };
}

/**
 * El departamento como lo guarda Kapta (la forma de Shopify, MOM §38.6): las
 * dos Limas se separan —«Lima (provincia)» es la provincia de Lima, la ciudad;
 * «Lima (departamento)», Huaral, Cañete, Barranca…—, porque es lo que lee
 * `limaRegionKind` para decidir la cobertura. El código manda si vino (1501 es
 * Lima Metropolitana); si no, la provincia.
 */
export function territorioRegion(t: WooTerritorio): string {
  const dep = normalizeDepartment(t.department) ?? t.department;
  if (dep === "Callao") return "Callao";
  if (!dep.startsWith("Lima")) return dep;
  const metro = t.code ? t.code.startsWith("1501") : normalizeDistrict(t.province) === "lima";
  return metro ? "Lima (provincia)" : "Lima (departamento)";
}

/** Lo que el pedido dice hoy de sí mismo, aparte del ubigeo del formulario. */
export interface TerritorioOrderContext {
  /** El departamento del pedido: la corrección del equipo o, si no, el de la dirección. */
  region?: string | null;
  /** El distrito del pedido: la corrección del equipo o, si no, el de la dirección. */
  district?: string | null;
}

/**
 * El ubigeo del formulario, si sigue siendo el del pedido; null si no.
 *
 *   · LA GUARDA DEL DEPARTAMENTO, la de siempre (25-10-2026): un dato de
 *     ubicación no manda contra el departamento del propio pedido. Si la
 *     corrección del equipo o el desplegable de la dirección dicen otro
 *     departamento (`departmentsConflict`), no se usa.
 *   · EL MISMO DISTRITO: si el distrito del pedido es otro —el equipo lo
 *     corrigió con «Corregir ubicación» o «Distrito por revisar», o se cambió la
 *     dirección en WooCommerce—, la provincia del ubigeo es la de un lugar que
 *     ya no es el del pedido, y tampoco se usa. Sin distrito en el pedido, el
 *     del ubigeo es el que hay.
 */
export function territorioForOrder(
  t: WooTerritorio | null | undefined,
  order: TerritorioOrderContext,
): WooTerritorio | null {
  if (!t) return null;
  if (departmentsConflict(t.department, order.region)) return null;
  const district = normalizeDistrict(order.district);
  if (district && district !== normalizeDistrict(t.district)) return null;
  return t;
}
