"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createAdminSupabase, createServerSupabase } from "@/lib/db";
import { getAdminOrgs, getCurrentUser } from "@/lib/access";
import { getMasterPermissions } from "@/lib/permissions-access";
import type { DistrictTariffRow } from "@/lib/grupo-gf-courier";

const COURIER_PATH = "/dashboard/courier";
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface CourierActionResult {
  error?: string;
  notice?: string;
}

export interface CourierProviderRow {
  id: string;
  org_id: string;
  code: string;
  name: string;
  status: string;
  same_day_cutoff: string;
  cash_warning_amount: number;
  cash_limit_amount: number;
}

export interface CourierAgreementRow {
  id: string;
  store_id: string | null;
  client_label: string;
  status: string;
}

export interface PeruDistrictRow {
  district_key: string;
  district: string;
  province: string;
  department: string | null;
  order_count: number;
}

export interface CourierConfigSnapshot {
  provider: CourierProviderRow | null;
  agreements: CourierAgreementRow[];
  tariffs: DistrictTariffRow[];
  districts: PeruDistrictRow[];
  yapePercentage: number;
}

async function requireManager(orgId: string): Promise<{ userId: string } | { error: string }> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const [permissions, memberships] = await Promise.all([
    getMasterPermissions(),
    getAdminOrgs(),
  ]);
  if (!permissions.can("logistics.manage")) {
    return { error: "No tienes permiso para administrar Grupo GF Courier." };
  }
  if (!memberships.some((membership) => membership.org_id === orgId)) {
    return { error: "No perteneces a esta organización." };
  }
  return { userId: user.id };
}

function amount(raw: unknown): number | null {
  const parsed = Number(String(raw ?? "").replace(",", "."));
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.round((parsed + Number.EPSILON) * 100) / 100;
}

function previousDay(day: string): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
}

export async function loadCourierConfig(orgId: string): Promise<CourierConfigSnapshot> {
  const auth = await requireManager(orgId);
  if ("error" in auth) {
    return { provider: null, agreements: [], tariffs: [], districts: [], yapePercentage: 3.5 };
  }
  const sb = await createServerSupabase();
  const admin = createAdminSupabase();
  const [{ data: providerData }, districtsResult] = await Promise.all([
    sb
      .from("logistics_providers")
      .select("id,org_id,code,name,status,same_day_cutoff,cash_warning_amount,cash_limit_amount")
      .eq("org_id", orgId)
      .eq("code", "grupo-gf-courier")
      .maybeSingle(),
    admin.rpc("courier_lima_districts", { p_org_id: orgId }),
  ]);
  if (districtsResult.error) {
    throw new Error(`No se pudo cargar el universo de distritos Lima: ${districtsResult.error.message}`);
  }
  const districtsData = districtsResult.data;
  const districts = ((districtsData ?? []) as Record<string, unknown>[]).map((row) => ({
    district_key: String(row.district_key),
    district: String(row.district),
    province: String(row.province),
    department: row.department == null ? null : String(row.department),
    order_count: Number(row.order_count ?? 0),
  })) satisfies PeruDistrictRow[];
  const provider = providerData as CourierProviderRow | null;
  if (!provider) {
    return {
      provider: null,
      agreements: [],
      tariffs: [],
      districts,
      yapePercentage: 3.5,
    };
  }

  const [{ data: agreements }, { data: tariffs }, { data: fee }] = await Promise.all([
    sb
      .from("logistics_service_agreements")
      .select("id,store_id,client_label,status")
      .eq("provider_id", provider.id)
      .eq("status", "active")
      .order("client_label"),
    sb
      .from("logistics_district_tariffs")
      .select(
        "id,provider_id,agreement_id,district_key,zone,delivery_amount,rejection_amount,includes_igv,currency,effective_from,effective_to,status",
      )
      .eq("provider_id", provider.id)
      .order("effective_from", { ascending: false }),
    sb
      .from("logistics_fee_rules")
      .select("percentage")
      .eq("provider_id", provider.id)
      .eq("kind", "yape_commission")
      .eq("status", "active")
      .is("agreement_id", null)
      .lte("effective_from", new Date().toISOString().slice(0, 10))
      .or(`effective_to.is.null,effective_to.gte.${new Date().toISOString().slice(0, 10)}`)
      .order("effective_from", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  return {
    provider,
    agreements: (agreements ?? []) as CourierAgreementRow[],
    tariffs: ((tariffs ?? []) as Record<string, unknown>[]).map((row) => ({
      ...row,
      delivery_amount: Number(row.delivery_amount),
      rejection_amount: Number(row.rejection_amount),
    })) as DistrictTariffRow[],
    districts,
    yapePercentage: Number(fee?.percentage ?? 3.5),
  };
}

export async function activateGroupGfCourier(orgId: string): Promise<CourierActionResult> {
  const auth = await requireManager(orgId);
  if ("error" in auth) return auth;
  const admin = createAdminSupabase();

  let { data: provider } = await admin
    .from("logistics_providers")
    .select("id")
    .eq("org_id", orgId)
    .eq("code", "grupo-gf-courier")
    .maybeSingle();
  if (!provider) {
    const created = await admin
      .from("logistics_providers")
      .insert({
        org_id: orgId,
        code: "grupo-gf-courier",
        name: "Grupo GF Courier",
        legal_name: "Grupo GF",
        coverage_note: "Lima Metropolitana y Callao",
        same_day_cutoff: "11:30",
        cash_warning_amount: 4000,
        cash_limit_amount: 5000,
        created_by: auth.userId,
      })
      .select("id")
      .single();
    if (created.error) return { error: created.error.message };
    provider = created.data;
  }

  const { data: stores, error: storesError } = await admin
    .from("stores")
    .select("id,name")
    .eq("org_id", orgId)
    .eq("status", "active");
  if (storesError) return { error: storesError.message };
  for (const store of stores ?? []) {
    const { data: existing, error: agreementLookupError } = await admin
      .from("logistics_service_agreements")
      .select("id")
      .eq("provider_id", provider.id)
      .eq("store_id", store.id)
      .eq("status", "active")
      .maybeSingle();
    if (agreementLookupError) return { error: agreementLookupError.message };
    if (!existing) {
      const { error: agreementError } = await admin.from("logistics_service_agreements").insert({
        provider_id: provider.id,
        client_org_id: orgId,
        store_id: store.id,
        client_label: store.name,
        assignment_mode: "direct",
        settlement_frequency: "daily",
        same_day_cutoff: "11:30",
        coverage_note: "Lima Metropolitana y Callao",
        created_by: auth.userId,
      });
      if (agreementError) return { error: agreementError.message };
    }
  }

  const { data: fee, error: feeLookupError } = await admin
    .from("logistics_fee_rules")
    .select("id")
    .eq("provider_id", provider.id)
    .eq("kind", "yape_commission")
    .eq("status", "active")
    .is("agreement_id", null)
    .maybeSingle();
  if (feeLookupError) return { error: feeLookupError.message };
  if (!fee) {
    const { error: feeError } = await admin.from("logistics_fee_rules").insert({
      provider_id: provider.id,
      kind: "yape_commission",
      percentage: 3.5,
      created_by: auth.userId,
      note: "Comisión general de Grupo GF sobre el importe efectivamente recibido por Yape.",
    });
    if (feeError) return { error: feeError.message };
  }

  const { data: pool, error: poolLookupError } = await admin
    .from("inventory_pools")
    .select("id")
    .eq("custodian_provider_id", provider.id)
    .eq("code", "proveeduria-grupo-gf")
    .maybeSingle();
  if (poolLookupError) return { error: poolLookupError.message };
  let poolId = pool?.id as string | undefined;
  if (!poolId) {
    const createdPool = await admin
      .from("inventory_pools")
      .insert({
        custodian_provider_id: provider.id,
        owner_org_id: orgId,
        code: "proveeduria-grupo-gf",
        name: "Proveeduría Grupo GF",
        owner_label: "Grupo GF",
        strict_control: false,
        created_by: auth.userId,
      })
      .select("id")
      .single();
    if (createdPool.error) return { error: createdPool.error.message };
    poolId = createdPool.data?.id as string | undefined;
  }
  if (poolId && stores?.length) {
    const { error: accessError } = await admin.from("inventory_pool_store_access").upsert(
      stores.map((store) => ({
        pool_id: poolId,
        store_id: store.id,
        active: true,
        created_by: auth.userId,
      })),
      { onConflict: "pool_id,store_id" },
    );
    if (accessError) return { error: accessError.message };
  }

  revalidatePath(COURIER_PATH);
  return { notice: "Grupo GF Courier quedó activado con Yape 3.5 % y contratos para las tiendas activas." };
}

export interface DistrictTariffInput {
  orgId: string;
  providerId: string;
  agreementId?: string | null;
  districtKey: string;
  zone?: string | null;
  deliveryAmount: number | string;
  rejectionAmount: number | string;
  effectiveFrom: string;
}

export async function saveDistrictTariff(
  input: DistrictTariffInput,
): Promise<CourierActionResult> {
  const auth = await requireManager(input.orgId);
  if ("error" in auth) return auth;
  const delivery = amount(input.deliveryAmount);
  const rejection = amount(input.rejectionAmount);
  if (delivery == null || rejection == null) return { error: "Completa ambos importes." };
  if (!DATE_RE.test(input.effectiveFrom)) return { error: "Fecha de vigencia inválida." };
  const admin = createAdminSupabase();

  const { data: provider } = await admin
    .from("logistics_providers")
    .select("id")
    .eq("id", input.providerId)
    .eq("org_id", input.orgId)
    .maybeSingle();
  if (!provider) return { error: "Operador no válido." };
  if (input.agreementId) {
    const { data: agreement } = await admin
      .from("logistics_service_agreements")
      .select("id")
      .eq("id", input.agreementId)
      .eq("provider_id", input.providerId)
      .maybeSingle();
    if (!agreement) return { error: "Contrato de tienda no válido." };
  }
  const { data: district } = await admin
    .from("peru_districts")
    .select("district_key,province")
    .eq("district_key", input.districtKey)
    .in("province", ["Lima", "Callao"])
    .maybeSingle();
  if (!district) return { error: "El distrito no pertenece a Lima Metropolitana o Callao." };

  let currentQuery = admin
    .from("logistics_district_tariffs")
    .select("id,effective_from")
    .eq("provider_id", input.providerId)
    .eq("district_key", input.districtKey)
    .eq("status", "active")
    .is("effective_to", null);
  currentQuery = input.agreementId
    ? currentQuery.eq("agreement_id", input.agreementId)
    : currentQuery.is("agreement_id", null);
  const { data: current } = await currentQuery.maybeSingle();
  if (current && current.effective_from >= input.effectiveFrom) {
    return {
      error: `La tarifa vigente comenzó el ${current.effective_from}. El cambio debe iniciar después para conservar el historial.`,
    };
  }
  if (current) {
    const { error } = await admin
      .from("logistics_district_tariffs")
      .update({ effective_to: previousDay(input.effectiveFrom) })
      .eq("id", current.id);
    if (error) return { error: error.message };
  }

  const { error } = await admin.from("logistics_district_tariffs").insert({
    provider_id: input.providerId,
    agreement_id: input.agreementId || null,
    district_key: input.districtKey,
    zone: input.zone?.trim() || null,
    delivery_amount: delivery,
    rejection_amount: rejection,
    includes_igv: true,
    effective_from: input.effectiveFrom,
    created_by: auth.userId,
  });
  if (error) return { error: error.message };

  revalidatePath(COURIER_PATH);
  return { notice: "Tarifa guardada. La vigencia anterior quedó conservada." };
}
