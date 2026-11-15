import { NextResponse, type NextRequest } from "next/server";
import { createAdminSupabase, createServerSupabase } from "@/lib/db";
import { hasOrgPermission } from "@/lib/permissions-access";
import { compareGfCatalog, gfCatalogCsv } from "@/lib/gf-courier-catalog";
import { loadGfProducts, loadStoreCatalogForGf } from "@/lib/gf-courier-catalog-server";
import { loadGfStore } from "@/lib/gf-courier-guide";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GF Courier (MOM §29.17): descarga «sku,nombre» del catálogo vivo de la tienda para importarlo en GF
// (Comercios → Catálogo). Solo lectura; quien administra la tienda («stores.manage»), como el resto de la sección.
export async function GET(req: NextRequest, ctx: { params: Promise<{ storeId: string }> }) {
  const { storeId } = await ctx.params;
  const admin = createAdminSupabase();
  const { data: store } = await admin.from("stores").select("id, org_id, name").eq("id", storeId).maybeSingle();
  if (!store) return new NextResponse("No encontrado.", { status: 404 });
  const sb = await createServerSupabase();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return new NextResponse("Inicia sesión.", { status: 401 });
  if (!(await hasOrgPermission(store.org_id, "stores.manage"))) return new NextResponse("Sin permiso.", { status: 403 });

  const result = await loadStoreCatalogForGf(admin, storeId);
  const problems = result.problems;
  // ?only=missing: solo los SKU que GF todavía no tiene (requiere el token de GF de la tienda).
  if (req.nextUrl.searchParams.get("only") === "missing") {
    const gfStore = await loadGfStore(admin, storeId);
    if (!gfStore?.token) return new NextResponse("Esta tienda no tiene token de GF Courier.", { status: 409 });
    const gf = await loadGfProducts(gfStore.token);
    if (!gf.ok) return new NextResponse(`GF Courier respondió: ${gf.message}`, { status: 502 });
    result.rows = compareGfCatalog(result.rows, gf.products).missingInGf;
  }
  if (!result.rows.length) {
    return new NextResponse(
      `No hay productos con SKU para exportar${req.nextUrl.searchParams.get("only") === "missing" ? " (GF ya tiene todos)" : ""}.${problems.length ? ` El catálogo no se pudo leer: ${problems.join(" ")}` : ""}`,
      { status: 409, headers: { "Content-Type": "text/plain; charset=utf-8" } },
    );
  }
  const slug = store.name.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").toLowerCase() || "tienda";
  return new NextResponse(gfCatalogCsv(result.rows), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="gf-catalogo-${slug}${req.nextUrl.searchParams.get("only") === "missing" ? "-faltantes" : ""}.csv"`,
      "Cache-Control": "no-store",
      // Para la pantalla: cuántas variantes quedaron fuera por no tener SKU, SKU repetidos y si se leyó en parte.
      "X-Gf-Without-Sku": String(result.withoutSku.length),
      "X-Gf-Repeated-Skus": String(result.repeatedSkus.length),
      "X-Gf-Partial": problems.length ? "1" : "0",
    },
  });
}
