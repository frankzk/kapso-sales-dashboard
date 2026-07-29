import { isEffectiveOn, specificity, type CostTariff } from "@/lib/costs";
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
 * ¿El pedido va a Lima Metropolitana o Callao?
 *
 * Se decide con la primera señal fiable, de más a menos:
 *   1. La región, cuando distingue metropolitana / departamento / Callao.
 *   2. La provincia del ubigeo, cuando la región dice "Lima" a secas o falta.
 *   3. El distrito, si es un nombre que solo existe en Lima Metropolitana.
 *
 * Una región que habla de otro departamento CIERRA la puerta: no se mira el
 * distrito, porque los nombres se repiten por todo el país.
 */
export function isLimaMetropolitanaOrCallao(location: CoverageLocation): boolean {
  const kind = limaRegionKind(location.region);
  if (kind === "metropolitana" || kind === "callao") return true;
  if (kind === "departamento") return false;

  const district = normalizeCoverageLabel(location.district);
  const inLimaDistricts = LIMA_METROPOLITANA.has(district) || CALLAO.has(district);

  // Región "Lima" a secas: el distrito desempata entre la metropolitana y el
  // resto del departamento (Huaral, Cañete, Yauyos…).
  if (kind === "lima") return inLimaDistricts;

  // Región de otro departamento: no es Lima, aunque el distrito se llame igual
  // que uno de Lima (Independencia/Huaraz, La Victoria/Chiclayo…).
  if (normalizeCoverageLabel(location.region)) return false;

  // Sin región: la provincia manda si es concluyente; si no, solo un distrito
  // que no se repita fuera de Lima.
  if (provinceIsLimaOrCallao(location.province) && inLimaDistricts) return true;
  return inLimaDistricts && !AMBIGUOUS_DISTRICTS.has(district);
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
): OrderCoverage {
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
  // Best effort para permitir desplegar código y migración en dos pasos.
  await admin.rpc("refresh_order_coverage", { p_org_id: orgId });
}
