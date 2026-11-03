// El costo logístico de Grupo GF sale de su Tarifario (MOM §14, §29.8;
// decisión del dueño del 19-10-2026).
//
// Grupo GF es el courier «propio»: todos sus motorizados —Alexis, Roy, Yhoni,
// Duglas, Yukio— cobran la tarifa del distrito de `logistics_district_tariffs`
// (Grupo GF Courier › Tarifario), la misma que la Mesa de ruta valida al tomar
// el pedido. Costos › Costos logísticos (`cost_tariffs`) no se mira para
// «propio»: con el mismo precio en dos tablas, una de las dos acabaría vieja.
//
// Se resuelve con lo que ya usan el Tarifario y Rutas, no con una copia:
//   · el distrito, con `riderPayDistrictKey` (el catálogo canónico de Lima y
//     sus alias; Chosica y Lurigancho Chosica → Lurigancho);
//   · la tarifa, con `resolveDistrictTariff` (la del acuerdo de la tienda gana
//     a la general; activa y vigente el día del costo).
//
// FALTA NO ES CERO. Un distrito que no se reconoce, uno sin tarifa o un día
// anterior a su vigencia quedan sin tarifa y bloquean la conciliación; nunca
// S/ 0. Un Tarifario que no se pudo leer, tampoco: se dice así y no se recuerda.
// Puro salvo `loadGfTariffBook`; probado en test/gf-tariff-resolve.test.ts.

import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveDistrictTariff, type DistrictTariffRow } from "@/lib/grupo-gf-courier";
import { riderPayDistrictKey } from "@/lib/rider-pay";

/** Contrato de la tienda con Grupo GF (`logistics_service_agreements`). */
export interface GfAgreementRow {
  id: string;
  provider_id: string;
  store_id: string | null;
  status: string;
  effective_from: string;
  effective_to: string | null;
}

/**
 * Todo lo que hace falta para resolver la tarifa de un pedido, leído una vez
 * por recálculo (y recordado con las tarifas de `cost_tariffs`): el proveedor
 * de cada organización, sus contratos activos y sus tarifas activas.
 */
export interface GfTariffBook {
  /** `logistics_providers.id` de Grupo GF Courier (`grupo-gf-courier`) por organización. */
  providerByOrg: ReadonlyMap<string, string>;
  agreements: readonly GfAgreementRow[];
  tariffs: readonly DistrictTariffRow[];
  /**
   * La lectura falló: el libro está vacío porque no se pudo leer, no porque
   * Grupo GF falte. No se recuerda (`fetchTariffs`, lib/order-master.ts) y el
   * aviso no afirma que Grupo GF no esté activado.
   */
  unreadable?: boolean;
}

export const EMPTY_GF_TARIFF_BOOK: GfTariffBook = {
  providerByOrg: new Map(),
  agreements: [],
  tariffs: [],
};

/** Lo que devuelve `loadGfTariffBook` si una de sus lecturas falla. */
export const UNREADABLE_GF_TARIFF_BOOK: GfTariffBook = { ...EMPTY_GF_TARIFF_BOOK, unreadable: true };

/**
 * Por qué el Tarifario no le da tarifa a un pedido:
 *  - `sin_lectura`: no se pudo leer el Tarifario (ni la tienda del pedido): no
 *    se sabe si falta, así que no se afirma nada de Grupo GF.
 *  - `sin_proveedor`: la organización no tiene Grupo GF Courier.
 *  - `sin_distrito`: el distrito del pedido no se reconoce en el catálogo de
 *    Lima (se corrige en el pedido; no crea distritos).
 *  - `sin_tarifa`: el distrito no tiene tarifa vigente ese día, ni una después.
 *  - `antes_de_vigencia`: tiene tarifa, pero empieza DESPUÉS del día del costo.
 */
export type GfTariffMissingReason = "sin_lectura" | "sin_proveedor" | "sin_distrito" | "sin_tarifa" | "antes_de_vigencia";

/** Lo que el aviso de la conciliación necesita saber de una tarifa que falta. */
export interface GfTariffGap {
  reason: GfTariffMissingReason;
  /** Desde cuándo rige la tarifa de ese distrito (YYYY-MM-DD), con `antes_de_vigencia`. */
  since: string | null;
}

/**
 * Lo que la ficha sabe de la tarifa de un pedido sin costo: por qué falta o,
 * con `vigente`, que el Tarifario ya la tiene y es la fila la que está vieja
 * (el recálculo o «Conciliar liquidación» la pondrán). Solo la ficha: el
 * servidor recalcula y nunca dice `vigente`.
 */
export type GfTariffCheck = GfTariffGap | { reason: "vigente"; since: null };

export type GfCostTariff =
  | {
      kind: "found";
      /** S/ por entrega o rechazo, incluido IGV: un solo importe (MOM §29.8). */
      amount: number;
      tariffId: string;
      source: "agreement" | "general";
      districtKey: string;
    }
  | ({ kind: "missing"; districtKey: string | null } & GfTariffGap);

/** El contrato de la tienda que regía ese día; el más reciente si hay varios. */
function agreementOn(book: GfTariffBook, providerId: string, storeId: string, day: string): string | null {
  let best: GfAgreementRow | null = null;
  for (const agreement of book.agreements) {
    if (agreement.provider_id !== providerId || agreement.store_id !== storeId) continue;
    if (agreement.status !== "active") continue;
    if (agreement.effective_from > day) continue;
    if (agreement.effective_to != null && agreement.effective_to < day) continue;
    if (!best || agreement.effective_from > best.effective_from) best = agreement;
  }
  return best?.id ?? null;
}

function money(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/**
 * La tarifa del Tarifario de Grupo GF para el costo de un pedido, el día al
 * que se imputa (`costDay`). Mismo distrito y misma precedencia que la Mesa de
 * ruta; a diferencia de ella, no exige contrato (sin contrato rige la general)
 * ni mira pausas ni el estado del proveedor: el envío ya se hizo, y lo que se
 * pregunta es cuánto costó ese día.
 */
export function resolveGfCostTariff(
  book: GfTariffBook,
  input: { orgId: string | null; storeId: string; district: string | null; day: string },
): GfCostTariff {
  const districtKey = riderPayDistrictKey(input.district);
  // Sin libro o sin la organización de la tienda (su lectura falló) no se sabe
  // si Grupo GF está: no se dice que no lo esté.
  if (book.unreadable || !input.orgId) return { kind: "missing", reason: "sin_lectura", since: null, districtKey };
  const providerId = book.providerByOrg.get(input.orgId) ?? null;
  if (!providerId) return { kind: "missing", reason: "sin_proveedor", since: null, districtKey };
  if (!districtKey) return { kind: "missing", reason: "sin_distrito", since: null, districtKey: null };

  const agreementId = agreementOn(book, providerId, input.storeId, input.day);
  const resolution = resolveDistrictTariff(book.tariffs, {
    providerId,
    agreementId,
    districtKey,
    day: input.day,
  });
  if (resolution.kind === "found") {
    return {
      kind: "found",
      amount: money(resolution.tariff.delivery_amount),
      tariffId: resolution.tariff.id,
      source: resolution.source,
      districtKey,
    };
  }

  // ¿Hay una tarifa de ese distrito que todavía no regía ese día? Entonces el
  // aviso dice desde cuándo rige, en vez de pedir una que ya existe.
  const later = book.tariffs
    .filter(
      (row) =>
        row.provider_id === providerId &&
        row.district_key === districtKey &&
        row.status === "active" &&
        (row.agreement_id == null || row.agreement_id === agreementId) &&
        row.effective_from > input.day,
    )
    .map((row) => row.effective_from)
    .sort();
  return later.length
    ? { kind: "missing", reason: "antes_de_vigencia", since: later[0]!, districtKey }
    : { kind: "missing", reason: "sin_tarifa", since: null, districtKey };
}

/**
 * Lee el Tarifario de Grupo GF de esas organizaciones: tres consultas en total,
 * no una por pedido. Un error de lectura devuelve el libro ilegible
 * (`unreadable`): el costo de «propio» queda sin tarifa (bloquea), nunca en
 * S/ 0, y el aviso dice que no se pudo leer.
 */
export async function loadGfTariffBook(
  client: SupabaseClient,
  orgIds: readonly string[],
): Promise<GfTariffBook> {
  if (!orgIds.length) return EMPTY_GF_TARIFF_BOOK;
  // Las organizaciones de un recálculo son una o dos: no hace falta trocear.
  const providerByOrg = new Map<string, string>();
  const { data: providers, error: providerError } = await client
    .from("logistics_providers")
    .select("id,org_id")
    .eq("code", "grupo-gf-courier")
    .in("org_id", [...orgIds]);
  if (providerError) return UNREADABLE_GF_TARIFF_BOOK;
  for (const row of (providers ?? []) as { id: string; org_id: string }[]) providerByOrg.set(row.org_id, row.id);
  const providerIds = [...new Set(providerByOrg.values())];
  if (!providerIds.length) return { ...EMPTY_GF_TARIFF_BOOK, providerByOrg };

  const [agreementsResult, tariffsResult] = await Promise.all([
    client
      .from("logistics_service_agreements")
      .select("id,provider_id,store_id,status,effective_from,effective_to")
      .eq("status", "active")
      .in("provider_id", providerIds),
    client
      .from("logistics_district_tariffs")
      .select(
        "id,provider_id,agreement_id,district_key,zone,delivery_amount,rejection_amount,includes_igv,currency,effective_from,effective_to,status",
      )
      .eq("status", "active")
      .in("provider_id", providerIds),
  ]);
  if (agreementsResult.error || tariffsResult.error) return UNREADABLE_GF_TARIFF_BOOK;
  const tariffs = ((tariffsResult.data ?? []) as Record<string, unknown>[]).map((row) => ({
    ...row,
    delivery_amount: Number(row.delivery_amount),
    rejection_amount: Number(row.rejection_amount),
  })) as DistrictTariffRow[];
  return {
    providerByOrg,
    agreements: (agreementsResult.data ?? []) as GfAgreementRow[],
    tariffs,
  };
}

/**
 * Para la ficha: por qué el Tarifario no le da tarifa a ESE pedido de Grupo
 * GF, así la Mesa de cierre lo dice antes del clic con las mismas palabras que
 * el servidor (desde cuándo rige la del distrito, sobre todo). `vigente` si la
 * encuentra: la fila está vieja y el recálculo la pondrá, así que no se pide
 * cargar una que ya existe. null si no se pudo leer: sin proveedor visible no
 * se afirma que Grupo GF no esté activado.
 */
export async function loadGfCostTariffGap(
  client: SupabaseClient,
  input: { storeId: string; district: string | null; day: string },
): Promise<GfTariffCheck | null> {
  const { data: store, error } = await client.from("stores").select("org_id").eq("id", input.storeId).maybeSingle();
  const orgId = (store as { org_id?: string } | null)?.org_id;
  if (error || !orgId) return null;
  const book = await loadGfTariffBook(client, [orgId]);
  if (book.unreadable || !book.providerByOrg.size) return null;
  const tariff = resolveGfCostTariff(book, { orgId, storeId: input.storeId, district: input.district, day: input.day });
  return tariff.kind === "missing" ? { reason: tariff.reason, since: tariff.since } : { reason: "vigente", since: null };
}
