import { NextResponse, type NextRequest } from "next/server";
import { createAdminSupabase } from "@/lib/db";
import { encrypt } from "@/lib/crypto";
import { env } from "@/lib/env";
import { exchangeCodeForToken, isValidShopDomain, verifyShopifyOAuthHmac } from "@/lib/shopify";
import {
  CLIENT_OAUTH_STATE_COOKIE,
  decideClientInstall,
  PENDING_INSTALL_COOKIE,
  PENDING_INSTALL_TTL_MINUTES,
  type StoreForShop,
} from "@/lib/shopify-client-app";
import { finishClientStoreConnection } from "@/lib/shopify-client-install";

// Vuelta del OAuth de la app de clientes (MOM §29.15.1). Cambia el código por
// el token y decide:
//   - la tienda ya estaba conectada con esta app → se reconecta (reinstalación);
//   - el dominio es de una tienda con la app interna → no se mezcla;
//   - es nueva → el token queda cifrado en una instalación pendiente y el
//     dueño elige su organización en /dashboard/conectar-shopify.
//   GET /api/shopify/clientes/callback?code=…&shop=…&state=…&hmac=…
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function toKapta(req: NextRequest, path: string, params: Record<string, string> = {}) {
  const url = new URL(path, env.siteUrl());
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = NextResponse.redirect(url);
  res.cookies.delete(CLIENT_OAUTH_STATE_COOKIE);
  return res;
}

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const shop = (sp.get("shop") ?? "").toLowerCase();
  const code = sp.get("code") ?? "";
  const state = sp.get("state") ?? "";
  const fail = (motivo: string) => toKapta(req, "/dashboard/conectar-shopify", { error: motivo });

  if (!env.shopifyClientAppConfigured()) return fail("app-no-configurada");
  if (!isValidShopDomain(shop) || !code || !state) return fail("parametros-invalidos");

  // CSRF: el `state` tiene que ser el que `entrada` dejó en este navegador.
  const cookieState = req.cookies.get(CLIENT_OAUTH_STATE_COOKIE)?.value;
  if (!cookieState || cookieState !== state) return fail("state-invalido");
  if (!verifyShopifyOAuthHmac(sp, env.shopifyClientAppApiSecret())) return fail("hmac-invalido");

  let token: string;
  let scope: string;
  try {
    const r = await exchangeCodeForToken({
      shop,
      apiKey: env.shopifyClientAppApiKey(),
      apiSecret: env.shopifyClientAppApiSecret(),
      code,
    });
    token = r.access_token;
    scope = r.scope;
  } catch {
    return fail("intercambio-fallo");
  }

  const admin = createAdminSupabase();
  const { data: stores, error: storesError } = await admin
    .from("stores")
    .select("id, org_id, shopify_app")
    .eq("shopify_domain", shop);
  if (storesError) return fail("lectura-fallo");
  const decision = decideClientInstall((stores ?? []) as StoreForShop[]);

  if (decision.kind === "conflict") return fail("tienda-con-app-interna");

  if (decision.kind === "reconnect") {
    const { error } = await admin
      .from("stores")
      .update({
        shopify_token_enc: encrypt(token),
        shopify_webhook_secret_enc: encrypt(env.shopifyClientAppApiSecret()),
        status: "active",
        shopify_uninstalled_at: null,
      })
      .eq("id", decision.storeId);
    if (error) return fail("guardado-fallo");
    await finishClientStoreConnection(admin, { storeId: decision.storeId, shop, token });
    return toKapta(req, `/dashboard/${decision.storeId}`, { installed: "1" });
  }

  const { data: pending, error: pendingError } = await admin
    .from("shopify_pending_installs")
    .insert({ shop_domain: shop, token_enc: encrypt(token), scope })
    .select("id")
    .single();
  if (pendingError || !pending) return fail("guardado-fallo");

  const res = toKapta(req, "/dashboard/conectar-shopify");
  res.cookies.set(PENDING_INSTALL_COOKIE, String((pending as { id: string }).id), {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    maxAge: PENDING_INSTALL_TTL_MINUTES * 60,
    path: "/",
  });
  return res;
}
