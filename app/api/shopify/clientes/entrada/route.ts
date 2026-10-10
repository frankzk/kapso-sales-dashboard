import { NextResponse, type NextRequest } from "next/server";
import { randomBytes } from "node:crypto";
import { createAdminSupabase } from "@/lib/db";
import { env } from "@/lib/env";
import { buildAuthorizeUrl, SHOPIFY_APP_SCOPES } from "@/lib/shopify";
import { CLIENT_OAUTH_STATE_COOKIE, verifyShopifyLaunch } from "@/lib/shopify-client-app";

// URL de la app de clientes (la que se pone como «App URL» en el Dev
// Dashboard). Shopify la abre al instalar y cada vez que el dueño entra a la
// app desde su admin, con `shop`, `timestamp` y `hmac`.
//
// La revisión de Shopify exige dos cosas aquí: no pedir el dominio a mano y
// autorizar (OAuth) en el acto al instalar. Si la tienda ya está conectada,
// lleva directo a Kapta.
//   GET /api/shopify/clientes/entrada?shop=…&timestamp=…&hmac=…
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  if (!env.shopifyClientAppConfigured()) {
    return new NextResponse(
      "La app de Shopify para tiendas cliente no está configurada (faltan SHOPIFY_CLIENT_APP_API_KEY / SHOPIFY_CLIENT_APP_API_SECRET).",
      { status: 500 },
    );
  }

  const check = verifyShopifyLaunch(
    req.nextUrl.searchParams,
    env.shopifyClientAppApiSecret(),
    Math.floor(Date.now() / 1000),
  );
  if (!check.ok) {
    return new NextResponse(`No se pudo verificar que la apertura venga de Shopify (${check.reason}).`, {
      status: check.reason === "hmac-invalido" ? 401 : 400,
    });
  }
  const shop = check.shop;

  // Ya conectada con esta app y con token: no hay nada que autorizar.
  const admin = createAdminSupabase();
  const { data: store } = await admin
    .from("stores")
    .select("id, status, shopify_token_enc")
    .eq("shopify_domain", shop)
    .eq("shopify_app", "clientes")
    .maybeSingle();
  const connected = store as { id: string; status: string; shopify_token_enc: string | null } | null;
  if (connected && connected.status === "active" && connected.shopify_token_enc) {
    return NextResponse.redirect(new URL(`/dashboard/${connected.id}`, env.siteUrl()));
  }

  const state = randomBytes(16).toString("hex");
  const authorizeUrl = buildAuthorizeUrl({
    shop,
    apiKey: env.shopifyClientAppApiKey(),
    scopes: SHOPIFY_APP_SCOPES,
    redirectUri: `${env.siteUrl()}/api/shopify/clientes/callback`,
    state,
  });
  const res = NextResponse.redirect(authorizeUrl);
  // CSRF: el callback exige este mismo `state` desde este navegador.
  res.cookies.set(CLIENT_OAUTH_STATE_COOKIE, state, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    maxAge: 600,
    path: "/",
  });
  return res;
}
