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

export function isLimaMetropolitanaOrCallao(location: CoverageLocation): boolean {
  const region = normalizeCoverageLabel(location.region);
  const province = normalizeCoverageLabel(location.province);
  const district = normalizeCoverageLabel(location.district);

  if (CALLAO.has(district)) {
    return region.includes("callao") || province.includes("callao");
  }
  return (
    LIMA_METROPOLITANA.has(district) &&
    region === "lima" &&
    (province === "lima" || province === "lima metropolitana")
  );
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

export function classifyOrderCoverage(
  location: CoverageLocation,
  tariffs: readonly CostTariff[],
  day: string,
): OrderCoverage {
  if (!location.region || !location.province || !location.district) return "por_revisar";
  if (isLimaMetropolitanaOrCallao(location)) return "lima";
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
