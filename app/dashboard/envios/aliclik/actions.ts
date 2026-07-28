"use server";

// Acciones de la pantalla de catálogo de Aliclik: sincronizar y mapear SKUs.
//
// El mapeo SKU de Shopify → EAN de Aliclik es la pieza sin la cual no se puede
// crear ninguna guía, y no es automática por accidente: los SKUs de las dos
// plataformas no tienen ninguna relación (Shopify usa numéricos, Aliclik códigos
// propios). El sync siembra lo que puede por NOMBRE; el resto lo decide una
// persona aquí, y esa decisión (`source='manual'`) ya no la pisa ningún sync.

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createAdminSupabase, createServerSupabase } from "@/lib/db";
import { getAccessibleStores } from "@/lib/access";
import { getMasterPermissions } from "@/lib/permissions-access";
import { getStoreCreds } from "@/lib/ingest";
import {
  loadAllAliclikSkus,
  loadShopifySkuNames,
  normalizeProductName,
  normalizeSku,
  syncAliclikCatalog,
} from "@/lib/aliclik-catalog";

const PATH = "/dashboard/envios/aliclik";

export interface CatalogActionState {
  error?: string;
  notice?: string;
}

async function authorize(
  storeId: string,
): Promise<{ userId: string; admin: ReturnType<typeof createAdminSupabase> } | null> {
  const perms = await getMasterPermissions();
  if (!perms.can("aliclik.manage_catalog")) return null;

  const sb = await createServerSupabase();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) redirect("/login");

  // La tienda tiene que estar entre las accesibles: el mapeo escribe con el rol
  // de servicio, así que aquí no protege RLS y hay que comprobarlo a mano.
  const stores = await getAccessibleStores();
  if (!stores.some((s) => s.id === storeId)) return null;

  return { userId: user.id, admin: createAdminSupabase() };
}

/** Sincroniza el catálogo bajo demanda. Solo lectura hacia Aliclik. */
export async function syncCatalog(
  _prev: CatalogActionState,
  formData: FormData,
): Promise<CatalogActionState> {
  const storeId = String(formData.get("store_id") ?? "");
  const ctx = await authorize(storeId);
  if (!ctx) return { error: "Tu rol no permite gestionar el catálogo de Aliclik." };

  const creds = await getStoreCreds(storeId, ctx.admin);
  if (!creds?.aliclik_api_token) return { error: "Esta tienda no tiene token de Aliclik." };

  const report = await syncAliclikCatalog(storeId, { apiToken: creds.aliclik_api_token }, ctx.admin);
  revalidatePath(PATH);
  if (!report.ok) return { error: report.errors.join("; ") || "No se pudo sincronizar." };
  return {
    notice: `Catálogo actualizado: ${report.skus} SKUs, ${report.agencies} agencias. ${report.autoMapped} mapeos nuevos automáticos.`,
  };
}

/** Asocia un SKU de Shopify a un EAN de Aliclik. Decisión humana: `manual`. */
export async function mapSku(
  _prev: CatalogActionState,
  formData: FormData,
): Promise<CatalogActionState> {
  const storeId = String(formData.get("store_id") ?? "");
  const shopifySku = normalizeSku(String(formData.get("shopify_sku") ?? ""));
  const ean = String(formData.get("ean") ?? "").trim();

  const ctx = await authorize(storeId);
  if (!ctx) return { error: "Tu rol no permite gestionar el catálogo de Aliclik." };
  if (!shopifySku || !ean) return { error: "Falta el SKU o el EAN." };

  // El EAN tiene que existir en el espejo: mapear a un EAN inventado produciría
  // un 400 de Aliclik en el peor momento posible, con la clienta esperando.
  const { data: exists } = await ctx.admin
    .from("aliclik_skus")
    .select("ean")
    .eq("store_id", storeId)
    .eq("ean", ean)
    .maybeSingle();
  if (!exists) return { error: "Ese EAN no está en el catálogo de Aliclik. Sincroniza primero." };

  const { error } = await ctx.admin.from("aliclik_sku_map").upsert(
    { store_id: storeId, shopify_sku: shopifySku, ean, source: "manual", created_by: ctx.userId },
    { onConflict: "store_id,shopify_sku" },
  );
  if (error) return { error: error.message };

  revalidatePath(PATH);
  return { notice: `${shopifySku} asociado.` };
}

export async function unmapSku(
  _prev: CatalogActionState,
  formData: FormData,
): Promise<CatalogActionState> {
  const storeId = String(formData.get("store_id") ?? "");
  const shopifySku = normalizeSku(String(formData.get("shopify_sku") ?? ""));

  const ctx = await authorize(storeId);
  if (!ctx) return { error: "Tu rol no permite gestionar el catálogo de Aliclik." };

  const { error } = await ctx.admin
    .from("aliclik_sku_map")
    .delete()
    .eq("store_id", storeId)
    .eq("shopify_sku", shopifySku);
  if (error) return { error: error.message };

  revalidatePath(PATH);
  return { notice: `${shopifySku} desasociado.` };
}

// ---------------------------------------------------------------------------
// Lectura para la pantalla
// ---------------------------------------------------------------------------

export interface CatalogRow {
  shopifySku: string;
  title: string;
  ean: string | null;
  source: string | null;
  aliclikName: string | null;
  warehouseName: string | null;
  stockVirtual: number | null;
  agencyEligible: boolean;
  /** Candidato propuesto por nombre, cuando no hay mapeo. */
  suggestion: { ean: string; name: string } | null;
}

export interface CatalogView {
  rows: CatalogRow[];
  mapped: number;
  unmapped: number;
  catalogSize: number;
  syncedAt: string | null;
}

/** Una opción del buscador de productos de Aliclik. */
export interface AliclikSkuOption {
  ean: string;
  label: string;
  warehouseName: string | null;
  stockVirtual: number | null;
}

/**
 * Lo que la pantalla necesita: cada SKU de Shopify con su mapeo (si lo tiene) y,
 * si no, el candidato que sale de comparar nombres normalizados. La sugerencia
 * se calcula aquí y NO se guarda: proponerla es útil, decidir por el equipo no.
 */
export async function loadCatalogView(storeId: string): Promise<CatalogView> {
  const admin = createAdminSupabase();

  // `loadAllAliclikSkus` PAGINA. Sin eso se leían solo los primeros 1000 de los
  // ~3.700 del catálogo (PostgREST corta ahí), y dos tercios de los productos
  // aparecían "sin candidato automático" cuando su candidato sí existía.
  const [shopify, skus, mapRes] = await Promise.all([
    loadShopifySkuNames(storeId, admin),
    loadAllAliclikSkus(storeId, admin),
    admin.from("aliclik_sku_map").select("shopify_sku,ean,source").eq("store_id", storeId),
  ]);

  const byEan = new Map(skus.map((s) => [s.ean, s]));
  const mapping = new Map(
    ((mapRes.data ?? []) as { shopify_sku: string; ean: string; source: string }[]).map((m) => [
      m.shopify_sku,
      m,
    ]),
  );

  // Índice por nombre normalizado, descartando los ambiguos (un mismo nombre en
  // dos EAN distintos no puede sugerirse: habría que adivinar).
  const byName = new Map<string, string | null>();
  for (const s of skus) {
    const n = normalizeProductName(s.product_name);
    if (!n) continue;
    if (!byName.has(n)) byName.set(n, s.ean);
    else if (byName.get(n) !== s.ean) byName.set(n, null);
  }

  const rows: CatalogRow[] = [...shopify.entries()]
    .map(([shopifySku, title]) => {
      const m = mapping.get(shopifySku);
      const hit = m ? byEan.get(m.ean) : undefined;
      const suggestedEan = m ? null : (byName.get(normalizeProductName(title)) ?? null);
      const suggested = suggestedEan ? byEan.get(suggestedEan) : undefined;
      return {
        shopifySku,
        title,
        ean: m?.ean ?? null,
        source: m?.source ?? null,
        aliclikName: hit?.product_name ?? null,
        warehouseName: hit?.warehouse_name ?? null,
        stockVirtual: hit?.stock_virtual ?? null,
        agencyEligible: Boolean(hit?.is_agency_eligible),
        suggestion:
          suggested && suggestedEan
            ? { ean: suggestedEan, name: suggested.product_name ?? suggestedEan }
            : null,
      };
    })
    // Sin mapear primero: es la cola de trabajo.
    .sort((a, b) => {
      if (!a.ean !== !b.ean) return a.ean ? 1 : -1;
      return a.title.localeCompare(b.title, "es");
    });

  return {
    rows,
    mapped: rows.filter((r) => r.ean).length,
    unmapped: rows.filter((r) => !r.ean).length,
    catalogSize: skus.length,
    syncedAt: skus[0]?.synced_at ?? null,
  };
}

/**
 * Busca productos en el catálogo de Aliclik.
 *
 * En el SERVIDOR y no en el cliente, a propósito: el catálogo pasa de 3.600
 * SKUs, y mandarlos todos al navegador son cientos de kilobytes que alguien
 * acaba descargando con datos móviles para elegir UN producto. Además, un
 * `<select>` nativo con miles de opciones es inmanejable en el móvil — que es
 * justo desde donde se está usando esta pantalla.
 */
export async function searchAliclikSkus(
  storeId: string,
  query: string,
): Promise<AliclikSkuOption[]> {
  const ctx = await authorize(storeId);
  if (!ctx) return [];

  let sel = ctx.admin
    .from("aliclik_skus")
    .select("ean,sku,product_name,sku_name,stock_virtual,warehouse_name")
    .eq("store_id", storeId);

  // Se busca por nombre, por SKU y por EAN: quien mapea a mano tiene a la vista
  // cualquiera de los tres, según de dónde venga mirando.
  const safe = query.trim().replace(/[%,()]/g, " ").trim();
  if (safe) {
    sel = sel.or(
      `product_name.ilike.%${safe}%,sku_name.ilike.%${safe}%,sku.ilike.%${safe}%,ean.ilike.%${safe}%`,
    );
  }

  const { data } = await sel.order("product_name", { ascending: true }).limit(40);

  return (
    (data ?? []) as {
      ean: string;
      sku: string | null;
      product_name: string | null;
      sku_name: string | null;
      stock_virtual: number | null;
      warehouse_name: string | null;
    }[]
  ).map((s) => ({
    ean: s.ean,
    label: `${s.product_name ?? s.sku_name ?? s.ean}${s.sku ? ` · ${s.sku}` : ""}`,
    warehouseName: s.warehouse_name,
    stockVirtual: s.stock_virtual,
  }));
}
