import { NextResponse, type NextRequest } from "next/server";
import { createAdminSupabase, createServerSupabase } from "@/lib/db";
import { hasOrgPermission } from "@/lib/permissions-access";
import { getStoreCreds } from "@/lib/ingest";
import { loadShopifySkuDetails, loadSkuCatalogSource } from "@/lib/aliclik-catalog";
import { buildGfCatalogExport, gfCatalogCsv } from "@/lib/gf-courier-catalog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GF Courier (MOM §29.17): descarga «sku,nombre» del catálogo vivo de la tienda para importarlo en GF
// (Comercios → Catálogo). Solo lectura; quien administra la tienda («stores.manage»), como el resto de la sección.
export async function GET(_req: NextRequest, ctx: { params: Promise<{ storeId: string }> }) {
  const { storeId } = await ctx.params;
  const admin = createAdminSupabase();
  const { data: store } = await admin.from("stores").select("id, org_id, name").eq("id", storeId).maybeSingle();
  if (!store) return new NextResponse("No encontrado.", { status: 404 });
  const sb = await createServerSupabase();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return new NextResponse("Inicia sesión.", { status: 401 });
  if (!(await hasOrgPermission(store.org_id, "stores.manage"))) return new NextResponse("Sin permiso.", { status: 403 });

  const problems: string[] = [];
  const source = await loadSkuCatalogSource(admin, storeId, await getStoreCreds(storeId, admin));
  const details = await loadShopifySkuDetails(storeId, admin, 0, source, { onSourceError: (d) => problems.push(d), fresh: true });
  const result = buildGfCatalogExport(details.values());
  if (!result.rows.length) {
    return new NextResponse(
      `No hay productos con SKU para exportar.${problems.length ? ` El catálogo no se pudo leer: ${problems.join(" ")}` : ""}`,
      { status: 409, headers: { "Content-Type": "text/plain; charset=utf-8" } },
    );
  }
  const slug = store.name.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").toLowerCase() || "tienda";
  return new NextResponse(gfCatalogCsv(result.rows), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="gf-catalogo-${slug}.csv"`,
      "Cache-Control": "no-store",
      // Para la pantalla: cuántas variantes quedaron fuera por no tener SKU, SKU repetidos y si se leyó en parte.
      "X-Gf-Without-Sku": String(result.withoutSku.length),
      "X-Gf-Repeated-Skus": String(result.repeatedSkus.length),
      "X-Gf-Partial": problems.length ? "1" : "0",
    },
  });
}
