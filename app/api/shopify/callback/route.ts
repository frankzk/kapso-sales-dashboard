import { NextResponse, type NextRequest } from "next/server";
import { createServerSupabase, createAdminSupabase } from "@/lib/db";
import { encrypt } from "@/lib/crypto";
import { env } from "@/lib/env";
import {
  exchangeCodeForToken,
  isValidShopDomain,
  registerOrderWebhooks,
  verifyShopifyOAuthHmac,
} from "@/lib/shopify";
import { runStoreSync } from "@/lib/ingest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function back(req: NextRequest, storeId: string | null, params: Record<string, string>) {
  const url = new URL(storeId ? `/dashboard/${storeId}/settings` : "/dashboard", req.url);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = NextResponse.redirect(url);
  res.cookies.delete("shopify_oauth_state");
  return res;
}

// OAuth callback: verify, exchange the code for a token, persist it encrypted,
// register webhooks and run the initial backfill.
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const shop = (sp.get("shop") ?? "").toLowerCase();
  const code = sp.get("code") ?? "";
  const state = sp.get("state") ?? "";
  const storeId = state.includes(".") ? state.split(".")[0]! : null;

  if (!env.shopifyOAuthConfigured()) return back(req, storeId, { shopify_error: "oauth-no-config" });
  if (!isValidShopDomain(shop) || !code || !state) {
    return back(req, storeId, { shopify_error: "parametros-invalidos" });
  }

  // CSRF: state must match the cookie set at /install
  const cookieState = req.cookies.get("shopify_oauth_state")?.value;
  if (!cookieState || cookieState !== state) {
    return back(req, storeId, { shopify_error: "state-invalido" });
  }

  // Authenticity of the callback itself
  if (!verifyShopifyOAuthHmac(sp, env.shopifyAppApiSecret())) {
    return back(req, storeId, { shopify_error: "hmac-invalido" });
  }

  // Re-check the caller is owner/admin of the store, and the shop matches.
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
  if (!store) return back(req, storeId, { shopify_error: "tienda-no-encontrada" });
  if (String(store.shopify_domain).toLowerCase() !== shop) {
    return back(req, storeId, { shopify_error: "shop-no-coincide" });
  }
  const { data: m } = await sb
    .from("memberships")
    .select("role")
    .eq("org_id", store.org_id)
    .eq("user_id", user.id)
    .maybeSingle();
  if (!m || (m.role !== "owner" && m.role !== "admin")) {
    return back(req, storeId, { shopify_error: "sin-permiso" });
  }

  // Exchange the code for an Admin API token.
  let token: string;
  try {
    const r = await exchangeCodeForToken({
      shop,
      apiKey: env.shopifyAppApiKey(),
      apiSecret: env.shopifyAppApiSecret(),
      code,
    });
    token = r.access_token;
  } catch {
    return back(req, storeId, { shopify_error: "intercambio-fallo" });
  }

  // Persist the token + the app secret (used to verify webhook HMAC), then
  // register webhooks and run the initial backfill (best-effort).
  const { error } = await admin
    .from("stores")
    .update({
      shopify_token_enc: encrypt(token),
      shopify_webhook_secret_enc: encrypt(env.shopifyAppApiSecret()),
      status: "active",
    })
    .eq("id", storeId);
  if (error) return back(req, storeId, { shopify_error: "guardado-fallo" });

  try {
    await registerOrderWebhooks({
      domain: shop,
      token,
      callbackUrl: `${env.siteUrl()}/api/webhooks/shopify/${storeId}`,
    });
  } catch {
    /* best-effort */
  }
  try {
    await runStoreSync(storeId!, admin);
  } catch {
    /* best-effort */
  }

  return back(req, storeId, { installed: "1" });
}
