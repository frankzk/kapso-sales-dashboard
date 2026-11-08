import "server-only";

// Lecturas de «Distrito por revisar» (MOM §19.0.3). La regla es pura y vive en
// `lib/district-mismatch.ts`; aquí solo se traen los datos, con la sesión de
// quien mira (la RLS decide qué pedidos ve; `peru_districts` es de lectura para
// todo usuario autenticado).
//
// Coste por carga del Master: DOS lecturas, a la par del resto. Una de
// `order_master` con los pedidos abiertos que no son de Lima ni de Agencia
// (columnas cortas: unos 1.500 el 08-11-2026) y una de `peru_districts` con
// SOLO las provincias que hacen falta (una consulta, no una por fila). Sin
// sondeo: se recalcula al recargar, y «Corregir» recarga.

import type { SupabaseClient } from "@supabase/supabase-js";
import { createServerSupabase } from "@/lib/db";
import {
  districtMismatch,
  provinceIlikePattern,
  provincesToCheck,
  type DistrictMismatch,
  type DistrictMismatchOrder,
  type ProvinceDistrict,
} from "@/lib/district-mismatch";

/** Los estados generales de un pedido abierto (MOM §6). */
export const DISTRICT_REVIEW_OPEN_STATUSES = ["pendiente", "en_proceso"] as const;

/** Tope de filas leídas del Master; hoy son ~1.500. */
const CANDIDATE_LIMIT = 5000;

/**
 * `peru_districts` de las provincias pedidas, en UNA consulta. La tabla es
 * texto libre («Arequipa», «arequipa», «Huánuco», «Huanuco»): se pide con un
 * `ilike` tolerante (`provinceIlikePattern`) y la regla compara normalizado.
 * `null` si la lectura falló.
 */
export async function loadProvinceDistricts(
  sb: SupabaseClient,
  provinces: readonly string[],
): Promise<ProvinceDistrict[] | null> {
  const patterns = [...new Set(provinces.map(provinceIlikePattern).filter((p): p is string => !!p))];
  if (!patterns.length) return [];
  const { data, error } = await sb
    .from("peru_districts")
    .select("district,province,department")
    .or(patterns.map((p) => `province.ilike.${p}`).join(","))
    .limit(5000);
  if (error) return null;
  return (data ?? []) as ProvinceDistrict[];
}

export interface DistrictReviewItem {
  orderId: string;
  orderName: string | null;
  storeId: string;
  /** Lo que dice el pedido hoy («Arequipa»). */
  current: string;
  suggested: string[];
  address: string | null;
  /** La guía que ya tiene, si salió: corregir aquí no se la cambia al courier. */
  courier: string | null;
  guideCode: string | null;
}

interface CandidateRow extends DistrictMismatchOrder {
  order_id: string;
  order_name: string | null;
  store_id: string;
  current_courier: string | null;
  guide_code: string | null;
}

/** Los pedidos que caen en la regla, de un conjunto ya leído. Pura: se prueba sin base. */
export function districtReviewItems(
  rows: readonly CandidateRow[],
  provinceDistricts: readonly ProvinceDistrict[],
): DistrictReviewItem[] {
  const out: DistrictReviewItem[] = [];
  for (const row of rows) {
    const mismatch = districtMismatch(row, provinceDistricts);
    if (!mismatch) continue;
    out.push({
      orderId: row.order_id,
      orderName: row.order_name,
      storeId: row.store_id,
      current: mismatch.current,
      suggested: mismatch.suggested,
      address: row.address ?? null,
      courier: row.current_courier,
      guideCode: row.guide_code,
    });
  }
  return out.sort((a, b) => (b.orderName ?? "").localeCompare(a.orderName ?? "", "es"));
}

/**
 * «Distrito por revisar» del Master: los pedidos abiertos de las tiendas que
 * ve quien mira cuyo distrito es la capital y cuya dirección nombra otro
 * distrito de la provincia. `null` = no se pudo leer (la píldora no enseña un
 * cero que nadie contó).
 */
export async function getDistrictReview(storeIds: string[]): Promise<DistrictReviewItem[] | null> {
  if (!storeIds.length) return [];
  try {
    const sb = await createServerSupabase();
    const { data, error } = await sb
      .from("order_master")
      .select("order_id,order_name,store_id,district,province,region,address,coverage,current_courier,guide_code")
      .in("store_id", storeIds)
      .in("general_status", [...DISTRICT_REVIEW_OPEN_STATUSES])
      .or("coverage.is.null,coverage.not.in.(lima,agencia)")
      .not("district", "is", null)
      .not("address", "is", null)
      .limit(CANDIDATE_LIMIT);
    if (error) return null;
    const rows = (data ?? []) as CandidateRow[];
    const provinces = provincesToCheck(rows);
    if (!provinces.length) return [];
    const districts = await loadProvinceDistricts(sb, provinces);
    if (!districts) return null;
    return districtReviewItems(rows, districts);
  } catch {
    return null;
  }
}

/**
 * El aviso de UN pedido antes de crear su guía. `destination` pisa lo que diga
 * el Master cuando la guía sale con otro destino (el reenvío por Swayp usa el
 * de la salida anterior, MOM §11.6.2). Dos lecturas pequeñas.
 */
export async function loadOrderDistrictMismatch(
  orderId: string,
  destination?: Partial<Pick<DistrictMismatchOrder, "district" | "province" | "region" | "address">> | null,
): Promise<DistrictMismatch | null> {
  const sb = await createServerSupabase();
  const { data, error } = await sb
    .from("order_master")
    .select("district,province,region,address,coverage")
    .eq("order_id", orderId)
    .maybeSingle();
  if (error || !data) return null;
  const row = data as DistrictMismatchOrder;
  const pick = (a: string | null | undefined, b: string | null | undefined) => (a ?? "").trim() || b || null;
  const order: DistrictMismatchOrder = {
    coverage: row.coverage ?? null,
    district: pick(destination?.district, row.district),
    province: pick(destination?.province, row.province),
    region: pick(destination?.region, row.region),
    address: pick(destination?.address, row.address),
  };
  const provinces = provincesToCheck([order]);
  if (!provinces.length) return null;
  const districts = await loadProvinceDistricts(sb, provinces);
  return districts ? districtMismatch(order, districts) : null;
}
