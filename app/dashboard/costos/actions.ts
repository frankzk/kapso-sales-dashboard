"use server";

// Gestión de costos (§17). Sección propia, no una pestaña de Ajustes: la
// especificación anticipa que crecerá hacia algo financiero más amplio.
//
// Regla que atraviesa todo: **nada se edita en su sitio**. Cambiar una tarifa
// cierra la vigente (le pone fecha final) y abre otra desde el día indicado, de
// modo que los cálculos históricos no se muevan. Por eso no hay una acción
// "editar importe": hay "reemplazar tarifa".

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createAdminSupabase, createServerSupabase } from "@/lib/db";
import { getAdminOrgs, getCurrentUser } from "@/lib/access";
import { getMasterPermissions } from "@/lib/permissions-access";
import { COST_CONCEPTS, type CostConcept } from "@/lib/costs";
import { refreshOrderCoverage } from "@/lib/order-coverage";
import { getStoreCreds } from "@/lib/ingest";
import { searchProductVariants } from "@/lib/shopify";

const COSTS_PATH = "/dashboard/costos";

export interface CostActionState {
  error?: string;
  notice?: string;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

async function requireCostAdmin(orgId: string): Promise<{ userId: string } | { error: string }> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const perms = await getMasterPermissions();
  if (!perms.can("costs.manage")) {
    return { error: "Solo un administrador puede gestionar los costos." };
  }
  // getAdminOrgs devuelve TODAS las membresías, no solo las de administrador:
  // el rol se comprueba aquí, como en app/dashboard/envios/actions.ts.
  const orgs = await getAdminOrgs();
  const membership = orgs.find((m) => m.org_id === orgId);
  if (!membership || (membership.role !== "owner" && membership.role !== "admin")) {
    return { error: "Sin acceso a esta organización." };
  }
  return { userId: user.id };
}

function normalizeAmount(raw: unknown): number | null {
  const n = typeof raw === "number" ? raw : Number(String(raw ?? "").replace(",", "."));
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

function scopeText(value: string | null | undefined): string | null {
  const v = (value ?? "").trim();
  return v || null;
}

// ---------------------------------------------------------------------------
// Tarifas logísticas
// ---------------------------------------------------------------------------

export interface TariffInput {
  orgId: string;
  storeId?: string | null;
  courier?: string | null;
  region?: string | null;
  province?: string | null;
  district?: string | null;
  concept: string;
  amount: number | string;
  effectiveFrom: string;
  note?: string | null;
}

/**
 * Crea una tarifa. Si ya hay una vigente para EXACTAMENTE el mismo ámbito y
 * concepto, se la cierra el día anterior en vez de dejar dos solapadas — dos
 * tarifas vigentes a la vez para el mismo ámbito harían el resultado dependiente
 * del orden de lectura.
 */
export async function upsertTariff(input: TariffInput): Promise<CostActionState> {
  const auth = await requireCostAdmin(input.orgId);
  if ("error" in auth) return auth;

  if (!COST_CONCEPTS.some((c) => c.code === input.concept)) {
    return { error: "Concepto de costo inválido." };
  }
  const amount = normalizeAmount(input.amount);
  if (amount === null || amount < 0) return { error: "Importe inválido." };
  if (!DATE_RE.test(input.effectiveFrom)) return { error: "Fecha de vigencia inválida." };

  const scope = {
    store_id: input.storeId || null,
    courier: scopeText(input.courier),
    region: scopeText(input.region),
    province: scopeText(input.province),
    district: scopeText(input.district),
  };

  const admin = createAdminSupabase();
  let query = admin
    .from("cost_tariffs")
    .select("id,effective_from")
    .eq("org_id", input.orgId)
    .eq("concept", input.concept)
    .is("effective_to", null);
  for (const [column, value] of Object.entries(scope)) {
    query = value === null ? query.is(column, null) : query.eq(column, value);
  }
  const { data: current } = await query;

  const previousDay = new Date(Date.parse(`${input.effectiveFrom}T00:00:00Z`) - 86_400_000)
    .toISOString()
    .slice(0, 10);

  for (const row of (current ?? []) as { id: string; effective_from: string }[]) {
    // Una tarifa que empezaría después de cerrarse sería invisible; en ese caso
    // se elimina la anterior en vez de dejar un intervalo imposible.
    if (row.effective_from > previousDay) {
      await admin.from("cost_tariffs").delete().eq("id", row.id);
    } else {
      await admin.from("cost_tariffs").update({ effective_to: previousDay }).eq("id", row.id);
    }
  }

  const { error } = await admin.from("cost_tariffs").insert({
    org_id: input.orgId,
    ...scope,
    concept: input.concept as CostConcept,
    amount,
    effective_from: input.effectiveFrom,
    note: input.note?.trim() || null,
    created_by: auth.userId,
  });
  if (error) return { error: error.message };

  await refreshOrderCoverage(admin, input.orgId);
  revalidatePath(COSTS_PATH);
  revalidatePath("/dashboard/pedidos");
  return { notice: "Tarifa registrada. La anterior queda cerrada, no borrada." };
}

/** Cierra una tarifa a partir de una fecha, sin borrar el histórico. */
export async function closeTariff(
  orgId: string,
  tariffId: string,
  effectiveTo: string,
): Promise<CostActionState> {
  const auth = await requireCostAdmin(orgId);
  if ("error" in auth) return auth;
  if (!DATE_RE.test(effectiveTo)) return { error: "Fecha inválida." };

  const admin = createAdminSupabase();
  const { error } = await admin
    .from("cost_tariffs")
    .update({ effective_to: effectiveTo })
    .eq("id", tariffId)
    .eq("org_id", orgId);
  if (error) return { error: error.message };
  await refreshOrderCoverage(admin, orgId);
  revalidatePath(COSTS_PATH);
  revalidatePath("/dashboard/pedidos");
  return { notice: "Tarifa cerrada." };
}

// ---------------------------------------------------------------------------
// Costos de producto
// ---------------------------------------------------------------------------

export interface ProductCostInput {
  orgId: string;
  storeId?: string | null;
  sku: string;
  productName?: string | null;
  supplier?: string | null;
  batch?: string | null;
  unitCost: number | string;
  effectiveFrom: string;
}

export interface ProductCatalogItem {
  key: string;
  sku: string | null;
  title: string;
  storeIds: string[];
  storeNames: string[];
  variantIds: string[];
}

async function loadOrgProductCatalog(orgId: string): Promise<ProductCatalogItem[]> {
  const admin = createAdminSupabase();
  const { data: storeRows } = await admin
    .from("stores")
    .select("id,name")
    .eq("org_id", orgId)
    .eq("status", "active")
    .order("name");
  const stores = (storeRows ?? []) as { id: string; name: string }[];
  const byProduct = new Map<string, ProductCatalogItem>();

  await Promise.all(
    stores.map(async (store) => {
      const creds = await getStoreCreds(store.id, admin);
      if (!creds?.shopify_token) return;
      try {
        const variants = await searchProductVariants({
          domain: creds.shopify_domain,
          token: creds.shopify_token,
          query: "",
          first: 250,
        });
        for (const variant of variants) {
          const sku = variant.sku?.trim() || null;
          const key = sku
            ? `sku:${sku.toLowerCase()}`
            : `variant:${store.id}:${variant.variantId}`;
          const current = byProduct.get(key);
          if (current) {
            if (!current.storeIds.includes(store.id)) {
              current.storeIds.push(store.id);
              current.storeNames.push(store.name);
            }
            if (!current.variantIds.includes(variant.variantId)) {
              current.variantIds.push(variant.variantId);
            }
          } else {
            byProduct.set(key, {
              key,
              sku,
              title: variant.title,
              storeIds: [store.id],
              storeNames: [store.name],
              variantIds: [variant.variantId],
            });
          }
        }
      } catch {
        // Una tienda sin read_products no debe impedir abrir todo el módulo.
      }
    }),
  );

  return [...byProduct.values()].sort(
    (a, b) => a.title.localeCompare(b.title) || (a.sku ?? "").localeCompare(b.sku ?? ""),
  );
}

async function validateCatalogSku(
  orgId: string,
  storeId: string | null | undefined,
  sku: string,
): Promise<{ title: string } | { error: string }> {
  const admin = createAdminSupabase();
  let storesQuery = admin
    .from("stores")
    .select("id")
    .eq("org_id", orgId)
    .eq("status", "active");
  if (storeId) storesQuery = storesQuery.eq("id", storeId);
  const { data: storeRows } = await storesQuery;
  const stores = (storeRows ?? []) as { id: string }[];
  if (!stores.length) return { error: "La tienda seleccionada no pertenece a la organización." };

  let catalogAvailable = false;
  for (const store of stores) {
    const creds = await getStoreCreds(store.id, admin);
    if (!creds?.shopify_token) continue;
    try {
      const variants = await searchProductVariants({
        domain: creds.shopify_domain,
        token: creds.shopify_token,
        query: `sku:${sku}`,
        first: 50,
      });
      catalogAvailable = true;
      const exact = variants.find(
        (variant) => variant.sku?.trim().toLowerCase() === sku.trim().toLowerCase(),
      );
      if (exact) return { title: exact.title };
    } catch {
      // Probamos las demás tiendas antes de devolver un error de catálogo.
    }
  }

  return {
    error: catalogAvailable
      ? "Selecciona un producto o variante existente del catálogo de Aurela o Kenku Perú."
      : "No se pudo validar el catálogo de Shopify. Revisa el permiso read_products.",
  };
}

export async function upsertProductCost(input: ProductCostInput): Promise<CostActionState> {
  const auth = await requireCostAdmin(input.orgId);
  if ("error" in auth) return auth;

  const sku = input.sku.trim();
  if (!sku) return { error: "Indica el SKU." };
  const catalogProduct = await validateCatalogSku(input.orgId, input.storeId, sku);
  if ("error" in catalogProduct) return catalogProduct;
  const unitCost = normalizeAmount(input.unitCost);
  if (unitCost === null || unitCost < 0) return { error: "Costo unitario inválido." };
  if (!DATE_RE.test(input.effectiveFrom)) return { error: "Fecha de vigencia inválida." };

  const admin = createAdminSupabase();
  const previousDay = new Date(Date.parse(`${input.effectiveFrom}T00:00:00Z`) - 86_400_000)
    .toISOString()
    .slice(0, 10);

  let query = admin
    .from("product_costs")
    .select("id,effective_from")
    .eq("org_id", input.orgId)
    .eq("sku", sku)
    .is("effective_to", null);
  query = input.storeId ? query.eq("store_id", input.storeId) : query.is("store_id", null);
  const { data: current } = await query;

  for (const row of (current ?? []) as { id: string; effective_from: string }[]) {
    if (row.effective_from > previousDay) {
      await admin.from("product_costs").delete().eq("id", row.id);
    } else {
      await admin.from("product_costs").update({ effective_to: previousDay }).eq("id", row.id);
    }
  }

  const { error } = await admin.from("product_costs").insert({
    org_id: input.orgId,
    store_id: input.storeId || null,
    sku,
    product_name: catalogProduct.title,
    supplier: input.supplier?.trim() || null,
    batch: input.batch?.trim() || null,
    unit_cost: unitCost,
    effective_from: input.effectiveFrom,
    created_by: auth.userId,
  });
  if (error) return { error: error.message };
  revalidatePath(COSTS_PATH);
  return { notice: "Costo de producto registrado." };
}

// ---------------------------------------------------------------------------
// Costos adicionales
// ---------------------------------------------------------------------------

export interface AdditionalCostInput {
  orgId: string;
  storeId?: string | null;
  concept: string;
  label?: string | null;
  amount: number | string;
  basis: string;
  effectiveFrom: string;
}

export async function upsertAdditionalCost(input: AdditionalCostInput): Promise<CostActionState> {
  const auth = await requireCostAdmin(input.orgId);
  if ("error" in auth) return auth;

  const concept = input.concept.trim();
  if (!concept) return { error: "Indica el concepto." };
  const amount = normalizeAmount(input.amount);
  if (amount === null || amount < 0) return { error: "Importe inválido." };
  const basis = input.basis === "porcentaje" ? "porcentaje" : "pedido";
  if (!DATE_RE.test(input.effectiveFrom)) return { error: "Fecha de vigencia inválida." };

  const admin = createAdminSupabase();
  const previousDay = new Date(Date.parse(`${input.effectiveFrom}T00:00:00Z`) - 86_400_000)
    .toISOString()
    .slice(0, 10);

  let query = admin
    .from("additional_costs")
    .select("id,effective_from")
    .eq("org_id", input.orgId)
    .eq("concept", concept)
    .is("effective_to", null);
  query = input.storeId ? query.eq("store_id", input.storeId) : query.is("store_id", null);
  const { data: current } = await query;

  for (const row of (current ?? []) as { id: string; effective_from: string }[]) {
    if (row.effective_from > previousDay) {
      await admin.from("additional_costs").delete().eq("id", row.id);
    } else {
      await admin.from("additional_costs").update({ effective_to: previousDay }).eq("id", row.id);
    }
  }

  const { error } = await admin.from("additional_costs").insert({
    org_id: input.orgId,
    store_id: input.storeId || null,
    concept,
    label: input.label?.trim() || null,
    amount,
    basis,
    effective_from: input.effectiveFrom,
    created_by: auth.userId,
  });
  if (error) return { error: error.message };
  revalidatePath(COSTS_PATH);
  return { notice: "Costo adicional registrado." };
}

// ---------------------------------------------------------------------------
// Lecturas (RLS)
// ---------------------------------------------------------------------------

export interface CostsSnapshot {
  tariffs: Record<string, unknown>[];
  productCosts: Record<string, unknown>[];
  additionalCosts: Record<string, unknown>[];
  productCatalog: ProductCatalogItem[];
}

/** Todo lo configurado, incluido el histórico cerrado (§17: historial de cambios). */
export async function loadCosts(orgId: string): Promise<CostsSnapshot> {
  const sb = await createServerSupabase();
  const [tariffs, productCosts, additionalCosts, productCatalog] = await Promise.all([
    sb.from("cost_tariffs").select("*").eq("org_id", orgId).order("effective_from", { ascending: false }),
    sb.from("product_costs").select("*").eq("org_id", orgId).order("effective_from", { ascending: false }),
    sb.from("additional_costs").select("*").eq("org_id", orgId).order("effective_from", { ascending: false }),
    loadOrgProductCatalog(orgId),
  ]);
  return {
    tariffs: (tariffs.data ?? []) as Record<string, unknown>[],
    productCosts: (productCosts.data ?? []) as Record<string, unknown>[],
    additionalCosts: (additionalCosts.data ?? []) as Record<string, unknown>[],
    productCatalog,
  };
}
