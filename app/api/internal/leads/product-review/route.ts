import { NextResponse, type NextRequest } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { createAdminSupabase } from "@/lib/db";
import { backfillLeadProducts, loadLeadProductCatalog, withProductOpeners, repairSevenProductNames } from "@/lib/lead-products-server";
import { PRODUCT_REVIEW_SOURCE, summarizeLeadProducts, type ProductReviewLead } from "@/lib/lead-product-review";
import type { AdDeclaration } from "@/lib/ad-products";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Manual, bounded review. Not scheduled; POST + bearer only. Never returns
 * private lead data and never invokes the general sync or customer messaging. */
export async function POST(req: NextRequest) {
  // Separate, expiring maintenance access; do not export the broad CRON_SECRET.
  let access: { token?: string; expiresAt?: string; storeIds?: string[] };
  try { access = JSON.parse(process.env.LEAD_PRODUCT_REVIEW_ACCESS ?? "{}"); }
  catch { return new NextResponse("unauthorized", { status: 401 }); }
  const expected = typeof access.token === "string" ? access.token : "";
  const header = req.headers.get("authorization");
  const provided = header?.startsWith("Bearer ") ? header.slice(7) : "";
  const a = Buffer.from(provided), b = Buffer.from(expected);
  if (!expected || a.length !== b.length || !timingSafeEqual(a, b) || !(Date.parse(access.expiresAt ?? "") > Date.now())) return new NextResponse("unauthorized", { status: 401 });
  const storeId = req.nextUrl.searchParams.get("storeId") ?? "";
  const mode = req.nextUrl.searchParams.get("mode") ?? "review";
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(storeId) || !["review", "counts", "repair"].includes(mode)) {
    return NextResponse.json({ ok: false, error: "Invalid review request" }, { status: 400 });
  }
  if (!Array.isArray(access.storeIds) || !access.storeIds.includes(storeId)) return new NextResponse("forbidden", { status: 403 });
  const admin = createAdminSupabase();
  const store = await admin.from("stores").select("id").eq("id", storeId).eq("status", "active").maybeSingle();
  if (store.error) return NextResponse.json({ ok: false, error: "Store unavailable" }, { status: 503 });
  if (!store.data) return NextResponse.json({ ok: false, error: "Store not found" }, { status: 404 });
  try {
    const catalogue = await loadLeadProductCatalog(admin, storeId);
    if (!catalogue.length) throw new Error("Catalogue unavailable");
    if (mode === "repair") return NextResponse.json({ ok: true, ...await repairSevenProductNames(admin, storeId, catalogue) });
    if (mode === "review") {
      const started = Date.now();
      let checked = 0, identified = 0, complete = false;
      for (let n = 0; n < 20 && Date.now() - started < 220_000; n++) {
        const batch = await backfillLeadProducts(admin, storeId, catalogue, 1000, PRODUCT_REVIEW_SOURCE);
        checked += batch.checked; identified += batch.identified;
        if (batch.checked < 1000) { complete = true; break; }
      }
      return NextResponse.json({ ok: true, source: PRODUCT_REVIEW_SOURCE, checked, identified, complete });
    }
    const rows: ProductReviewLead[] = [];
    let cursor: string | null = null;
    for (;;) {
      let query = admin.from("leads").select("id,store_id,first_seen_at,first_inbound_text,entry_product,interest_product,last_product_handle,cart_product_handle,ad_id,category,status,call_queue_ready,contact_opt_out_at,has_order,order_id,next_followup_at")
        .eq("store_id", storeId).in("category", ["open", "hot"]).neq("status", "yape_por_verificar").order("id").limit(1000);
      if (cursor) query = query.gt("id", cursor);
      const page = await query;
      if (page.error) throw new Error("Queue unavailable");
      const batch = (page.data ?? []) as ProductReviewLead[];
      rows.push(...batch);
      if (batch.length < 1000) break;
      cursor = batch[batch.length - 1]!.id;
    }
    const declarations: AdDeclaration[] = [];
    for (let offset = 0; ; offset += 1000) {
      const page = await admin.from("ad_product_declarations").select("id,store_id,ad_id,product_handle,valid_from").eq("store_id", storeId).order("id").range(offset, offset + 999);
      if (page.error) throw new Error("Declarations unavailable");
      declarations.push(...(page.data ?? []) as AdDeclaration[]);
      if ((page.data ?? []).length < 1000) break;
    }
    const projected = await withProductOpeners(admin, rows);
    return NextResponse.json({ ok: true, as_of: new Date().toISOString(), scope: "all_store_leads_no_advisor_filters", ...summarizeLeadProducts(projected, declarations) });
  } catch {
    return NextResponse.json({ ok: false, error: "Product review failed; progress is resumable" }, { status: 503 });
  }
}
