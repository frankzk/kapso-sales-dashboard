"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createAdminSupabase, createServerSupabase } from "@/lib/db";
import { decryptOrNull, encrypt } from "@/lib/crypto";
import { env } from "@/lib/env";
import { fetchShopInfo } from "@/lib/shopify";
import { PENDING_INSTALL_COOKIE, pendingInstallUsable } from "@/lib/shopify-client-app";
import { finishClientStoreConnection } from "@/lib/shopify-client-install";

export interface ClaimInstallState {
  error?: string;
}

/**
 * Crea la tienda de una instalación pendiente de la app de clientes (MOM
 * §29.15.1) en una organización donde el usuario es owner o admin. El token ya
 * viene cifrado desde el callback; aquí no se escribe ningún dominio a mano.
 */
export async function claimShopifyInstall(
  _prev: ClaimInstallState,
  formData: FormData,
): Promise<ClaimInstallState> {
  const sb = await createServerSupabase();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return { error: "Inicia sesión para continuar." };

  const jar = await cookies();
  const installId = jar.get(PENDING_INSTALL_COOKIE)?.value;
  if (!installId) {
    return { error: "No encontramos la instalación. Vuelve a abrir la app desde el admin de tu Shopify." };
  }

  const orgId = String(formData.get("org_id") ?? "").trim();
  const name = String(formData.get("name") ?? "").trim();
  if (!orgId) return { error: "Elige la organización." };
  if (!name) return { error: "Escribe el nombre de la tienda." };

  const { data: membership } = await sb
    .from("memberships")
    .select("role")
    .eq("org_id", orgId)
    .eq("user_id", user.id)
    .maybeSingle();
  if (!membership || !["owner", "admin"].includes((membership as { role: string }).role)) {
    return { error: "No tienes permiso para crear tiendas en esa organización." };
  }

  const admin = createAdminSupabase();
  const { data: pendingRow } = await admin
    .from("shopify_pending_installs")
    .select("id, shop_domain, token_enc, expires_at, claimed_at")
    .eq("id", installId)
    .maybeSingle();
  const pending = pendingRow as {
    id: string;
    shop_domain: string;
    token_enc: string;
    expires_at: string;
    claimed_at: string | null;
  } | null;
  if (!pending || !pendingInstallUsable(pending, new Date())) {
    return { error: "La instalación venció o ya se usó. Vuelve a abrir la app desde el admin de tu Shopify." };
  }
  const token = decryptOrNull(pending.token_enc);
  if (!token) return { error: "No se pudo leer el acceso de Shopify. Vuelve a instalar la app." };

  let currency = "PEN";
  let timezone = "America/Lima";
  try {
    const info = await fetchShopInfo({ domain: pending.shop_domain, token });
    currency = info.currencyCode || currency;
    timezone = info.ianaTimezone || timezone;
  } catch {
    /* la moneda y la zona se corrigen en ajustes; no frena la conexión */
  }

  const { data: store, error } = await admin
    .from("stores")
    .insert({
      org_id: orgId,
      name,
      shopify_domain: pending.shop_domain,
      shopify_app: "clientes",
      shopify_token_enc: pending.token_enc,
      shopify_webhook_secret_enc: encrypt(env.shopifyClientAppApiSecret()),
      currency,
      timezone,
      status: "active",
    })
    .select("id")
    .single();
  if (error || !store) {
    if ((error as { code?: string } | null)?.code === "23505") {
      return { error: "Esa tienda de Shopify ya está conectada a Kapta." };
    }
    return { error: error?.message ?? "No se pudo crear la tienda." };
  }
  const storeId = (store as { id: string }).id;

  await admin
    .from("shopify_pending_installs")
    .update({ claimed_at: new Date().toISOString(), claimed_store_id: storeId, claimed_by: user.id })
    .eq("id", pending.id)
    .is("claimed_at", null);
  await admin.from("user_store_access").insert({ user_id: user.id, store_id: storeId });
  await finishClientStoreConnection(admin, { storeId, shop: pending.shop_domain, token });

  jar.delete(PENDING_INSTALL_COOKIE);
  revalidatePath("/dashboard");
  redirect(`/dashboard/${storeId}`);
}
