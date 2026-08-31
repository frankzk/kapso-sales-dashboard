import type { SupabaseClient } from "@supabase/supabase-js";
import {
  resolveDistrictAvailability,
  resolveDistrictTariff,
  type DistrictAvailabilityEventRow,
  type DistrictTariffRow,
  type GroupGfCourierRouteCheck,
} from "@/lib/grupo-gf-courier";
import {
  isLimaMetropolitanaOrCallao,
  resolveLimaDistrict,
} from "@/lib/order-coverage";
import { limaTodayKey } from "@/lib/shipments";

type RouteOrderLocation = {
  store_id: string;
  region: string | null;
  province: string | null;
  district: string | null;
};

const unavailable = (
  reason: string,
  overrides: Partial<GroupGfCourierRouteCheck> = {},
): GroupGfCourierRouteCheck => ({
  known: true,
  eligible: false,
  reason,
  districtKey: null,
  agreementId: null,
  tariffAmount: null,
  currency: "PEN",
  sameDayCutoff: "11:30",
  ...overrides,
});

/**
 * Lee la configuración vigente que hace elegible a un pedido para Grupo GF.
 * No crea nada. La misma función se usa al dibujar la Mesa y justo antes de
 * escribir la salida, cerrando la carrera entre una pantalla abierta y una
 * pausa o cambio de tarifa posterior.
 */
export async function loadGroupGfCourierRouteCheck(
  sb: SupabaseClient,
  row: RouteOrderLocation,
  day = limaTodayKey(),
): Promise<GroupGfCourierRouteCheck> {
  if (!isLimaMetropolitanaOrCallao({
    storeId: row.store_id,
    region: row.region,
    province: row.province,
    district: row.district,
  })) {
    return unavailable("Grupo GF Courier atiende solo Lima Metropolitana y Callao.");
  }

  let districtKey = resolveLimaDistrict(row.district, { searchInText: true });
  if (districtKey === "lurigancho chosica") districtKey = "lurigancho";
  if (!districtKey) {
    return unavailable("Corrige el distrito para validar la cobertura de Grupo GF Courier.");
  }

  const { data: store, error: storeError } = await sb
    .from("stores")
    .select("org_id")
    .eq("id", row.store_id)
    .maybeSingle();
  const orgId = (store as { org_id?: string } | null)?.org_id;
  if (storeError || !orgId) {
    return {
      ...unavailable("No se pudo validar la organización de la tienda.", { districtKey }),
      known: false,
    };
  }

  const { data: providerData, error: providerError } = await sb
    .from("logistics_providers")
    .select("id,status,same_day_cutoff")
    .eq("org_id", orgId)
    .eq("code", "grupo-gf-courier")
    .maybeSingle();
  if (providerError) {
    return {
      ...unavailable("No se pudo leer la configuración de Grupo GF Courier.", { districtKey }),
      known: false,
    };
  }
  const provider = providerData as {
    id: string;
    status: string;
    same_day_cutoff: string | null;
  } | null;
  if (!provider) {
    return unavailable("Grupo GF Courier todavía no está activado.", { districtKey });
  }
  const sameDayCutoff = (provider.same_day_cutoff ?? "11:30").slice(0, 5);
  if (provider.status !== "active") {
    return unavailable("Grupo GF Courier está suspendido para nuevas asignaciones.", {
      districtKey,
      sameDayCutoff,
    });
  }

  const { data: agreementData, error: agreementError } = await sb
    .from("logistics_service_agreements")
    .select("id")
    .eq("provider_id", provider.id)
    .eq("store_id", row.store_id)
    .eq("status", "active")
    .lte("effective_from", day)
    .or(`effective_to.is.null,effective_to.gte.${day}`)
    .order("effective_from", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (agreementError) {
    return {
      ...unavailable("No se pudo validar el contrato de la tienda.", {
        districtKey,
        sameDayCutoff,
      }),
      known: false,
    };
  }
  const agreementId = (agreementData as { id?: string } | null)?.id ?? null;
  if (!agreementId) {
    return unavailable("La tienda no tiene un contrato activo con Grupo GF Courier.", {
      districtKey,
      sameDayCutoff,
    });
  }

  const [{ data: tariffData, error: tariffError }, { data: eventData, error: eventError }] =
    await Promise.all([
      sb
        .from("logistics_district_tariffs")
        .select(
          "id,provider_id,agreement_id,district_key,zone,delivery_amount,rejection_amount,includes_igv,currency,effective_from,effective_to,status",
        )
        .eq("provider_id", provider.id)
        .eq("district_key", districtKey),
      sb
        .from("logistics_district_availability_events")
        .select(
          "id,provider_id,agreement_id,district_key,action,reason,paused_until,created_by,created_at",
        )
        .eq("provider_id", provider.id)
        .eq("district_key", districtKey)
        .or(`agreement_id.is.null,agreement_id.eq.${agreementId}`),
    ]);
  if (tariffError || eventError) {
    return {
      ...unavailable("No se pudo validar tarifa y disponibilidad de este distrito.", {
        districtKey,
        agreementId,
        sameDayCutoff,
      }),
      known: false,
    };
  }

  const tariffs = ((tariffData ?? []) as Record<string, unknown>[]).map((tariff) => ({
    ...tariff,
    delivery_amount: Number(tariff.delivery_amount),
    rejection_amount: Number(tariff.rejection_amount),
  })) as DistrictTariffRow[];
  const tariff = resolveDistrictTariff(tariffs, {
    providerId: provider.id,
    agreementId,
    districtKey,
    day,
  });
  if (tariff.kind === "missing") {
    return unavailable("Sin tarifa configurada para este distrito.", {
      districtKey,
      agreementId,
      sameDayCutoff,
    });
  }

  const availability = resolveDistrictAvailability(
    (eventData ?? []) as DistrictAvailabilityEventRow[],
    { providerId: provider.id, agreementId, districtKey, day },
  );
  if (availability.status === "paused") {
    const until = availability.event.paused_until
      ? ` hasta el ${availability.event.paused_until}`
      : "";
    return unavailable(
      `Servicio pausado${until}: ${availability.event.reason ?? "revisión operativa"}.`,
      {
        districtKey,
        agreementId,
        tariffAmount: tariff.tariff.delivery_amount,
        currency: tariff.tariff.currency,
        sameDayCutoff,
      },
    );
  }

  return {
    known: true,
    eligible: true,
    reason: `Tarifa S/ ${tariff.tariff.delivery_amount.toFixed(2)} incluida IGV.`,
    districtKey,
    agreementId,
    tariffAmount: tariff.tariff.delivery_amount,
    currency: tariff.tariff.currency,
    sameDayCutoff,
  };
}
