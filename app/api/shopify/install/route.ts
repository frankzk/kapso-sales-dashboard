import { NextResponse, type NextRequest } from "next/server";
import { randomBytes } from "node:crypto";
import { hasOrgPermission } from "@/lib/permissions-access";
import { createServerSupabase, createAdminSupabase } from "@/lib/db";
import { env } from "@/lib/env";
import { buildAuthorizeUrl, isValidShopDomain, SHOPIFY_APP_SCOPES } from "@/lib/shopify";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SCOPES = SHOPIFY_APP_SCOPES;

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
    .select("id, org_id, shopify_domain, shopify_app")
    .eq("id", storeId)
    .maybeSingle();
  if (!store) return new NextResponse("tienda no encontrada", { status: 404 });
  // Una tienda con su app propia (0271, MOM §36.4) no se instala con la app
  // interna: el callback pisaría su token y el secreto de sus webhooks.
  if ((store as { shopify_app?: string | null }).shopify_app === "propia") {
    return new NextResponse(
      "Esta tienda usa su app propia de Shopify: sus credenciales se cambian en Ajustes → Shopify.",
      { status: 409 },
    );
  }

  // «Administrar tiendas» (MOM §16): owner/admin, o el rol Administración.
  if (!(await hasOrgPermission(store.org_id, "stores.manage"))) {
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
