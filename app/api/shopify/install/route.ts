import { NextResponse, type NextRequest } from "next/server";
import { randomBytes } from "node:crypto";
import { createServerSupabase, createAdminSupabase } from "@/lib/db";
import { env } from "@/lib/env";
import { buildAuthorizeUrl, isValidShopDomain } from "@/lib/shopify";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// read_draft_orders + write_draft_orders power the abandoned-cart (Releasit COD)
// feature: read open/completed drafts, and "Generar pedido" completes a draft
// into a real order. read_products powers the order form's catalog picker
// (productos reales con stock + precio). read_orders stays for the order sync.
const SCOPES = "read_orders,read_draft_orders,write_draft_orders,read_products";

// Start the Shopify OAuth install for a store the caller owns/admins.
//   GET /api/shopify/install?storeId=<id>
export async function GET(req: NextRequest) {
  if (!env.shopifyOAuthConfigured()) {
    return new NextResponse(
      "Shopify OAuth no configurado (faltan SHOPIFY_APP_API_KEY / SHOPIFY_APP_API_SECRET).",
      { status: 500 },
    );
  }
  const storeId = req.nextUrl.searchParams.get("storeId");
  if (!storeId) return new NextResponse("storeId requerido", { status: 400 });

  const sb = await createServerSupabase();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return NextResponse.redirect(new URL("/login", req.url));

  const admin = createAdminSupabase();
  const { data: store } = await admin
    .from("stores")
    .select("id, org_id, shopify_domain")
    .eq("id", storeId)
    .maybeSingle();
  if (!store) return new NextResponse("tienda no encontrada", { status: 404 });

  const { data: m } = await sb
    .from("memberships")
    .select("role")
    .eq("org_id", store.org_id)
    .eq("user_id", user.id)
    .maybeSingle();
  if (!m || (m.role !== "owner" && m.role !== "admin")) {
    return new NextResponse("sin permiso", { status: 403 });
  }

  const shop = String(store.shopify_domain).toLowerCase();
  if (!isValidShopDomain(shop)) {
    return new NextResponse(`Dominio inválido: ${shop} (debe ser *.myshopify.com)`, { status: 400 });
  }

  const state = `${storeId}.${randomBytes(16).toString("hex")}`;
  const authorizeUrl = buildAuthorizeUrl({
    shop,
    apiKey: env.shopifyAppApiKey(),
    scopes: SCOPES,
    redirectUri: `${env.siteUrl()}/api/shopify/callback`,
    state,
  });

  const res = NextResponse.redirect(authorizeUrl);
  // CSRF guard: bind the state to this browser for the callback to check.
  res.cookies.set("shopify_oauth_state", state, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    maxAge: 600,
    path: "/",
  });
  return res;
}
