"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createServerSupabase, createAdminSupabase } from "@/lib/db";
import { encryptOrNull } from "@/lib/crypto";
import { fetchShopInfo, isValidShopDomain, registerOrderWebhooks } from "@/lib/shopify";
import { runStoreSync } from "@/lib/ingest";
import { env } from "@/lib/env";

export interface ActionState {
  error?: string;
  warnings?: string[];
}

async function requireUser() {
  const sb = await createServerSupabase();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) redirect("/login");
  return user;
}

export async function signOut() {
  const sb = await createServerSupabase();
  await sb.auth.signOut();
  redirect("/login");
}

/** Bootstrap: create an organization and make the current user its owner. */
export async function createOrganization(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const user = await requireUser();
  const name = String(formData.get("name") ?? "").trim();
  if (!name) return { error: "El nombre de la organización es obligatorio." };

  const admin = createAdminSupabase();
  const { data: org, error } = await admin
    .from("organizations")
    .insert({ name })
    .select("id")
    .single();
  if (error || !org) return { error: error?.message ?? "No se pudo crear la organización." };

  const { error: mErr } = await admin
    .from("memberships")
    .insert({ user_id: user.id, org_id: org.id, role: "owner" });
  if (mErr) return { error: mErr.message };

  revalidatePath("/dashboard");
  redirect("/dashboard/stores/new");
}

/**
 * "Connect store": persist a store with AES-GCM-encrypted credentials, grant
 * the creator access, register Shopify order webhooks, and kick off an initial
 * backfill. Tokens are encrypted here and never returned to the client.
 */
export async function createStore(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const user = await requireUser();
  const orgId = String(formData.get("org_id") ?? "").trim();

  // Authorize: must be owner/admin of the target org.
  const sb = await createServerSupabase();
  const { data: membership } = await sb
    .from("memberships")
    .select("role")
    .eq("org_id", orgId)
    .eq("user_id", user.id)
    .maybeSingle();
  if (!membership || !["owner", "admin"].includes(membership.role)) {
    return { error: "No tienes permiso para crear tiendas en esta organización." };
  }

  const name = String(formData.get("name") ?? "").trim();
  let shopify_domain = String(formData.get("shopify_domain") ?? "").trim().toLowerCase();
  const shopify_token = String(formData.get("shopify_token") ?? "").trim();
  const shopify_webhook_secret = String(formData.get("shopify_webhook_secret") ?? "").trim();
  const kapso_project_id = String(formData.get("kapso_project_id") ?? "").trim();
  const kapso_api_key = String(formData.get("kapso_api_key") ?? "").trim();
  const whatsapp_phone_number_id = String(formData.get("whatsapp_phone_number_id") ?? "").trim();
  let currency = String(formData.get("currency") ?? "PEN").trim() || "PEN";
  let timezone = String(formData.get("timezone") ?? "America/Lima").trim() || "America/Lima";

  if (!name || !shopify_domain) {
    return { error: "Nombre y dominio de Shopify son obligatorios." };
  }
  // Normalise to the bare *.myshopify.com host.
  shopify_domain = shopify_domain.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  // Reject anything that isn't a real *.myshopify.com host. Without this, the
  // domain is fetched verbatim (fetchShopInfo below + every sync), so a value
  // like an internal IP / hostname would be an SSRF sink. isValidShopDomain is
  // the same guard used on the OAuth install/callback paths.
  if (!isValidShopDomain(shopify_domain)) {
    return { error: "Dominio de Shopify inválido. Debe ser tu-tienda.myshopify.com." };
  }

  const warnings: string[] = [];

  // Optionally validate the token + pull currency/timezone from the shop.
  if (shopify_token) {
    try {
      const info = await fetchShopInfo({ domain: shopify_domain, token: shopify_token });
      currency = info.currencyCode || currency;
      timezone = info.ianaTimezone || timezone;
    } catch (e) {
      warnings.push(`No se pudo validar el token de Shopify: ${errMsg(e)}`);
    }
  }

  const admin = createAdminSupabase();
  const { data: store, error } = await admin
    .from("stores")
    .insert({
      org_id: orgId,
      name,
      shopify_domain,
      shopify_token_enc: encryptOrNull(shopify_token),
      shopify_webhook_secret_enc: encryptOrNull(shopify_webhook_secret),
      kapso_project_id: kapso_project_id || null,
      kapso_api_key_enc: encryptOrNull(kapso_api_key),
      whatsapp_phone_number_id: whatsapp_phone_number_id || null,
      currency,
      timezone,
      status: "active",
    })
    .select("id")
    .single();
  if (error || !store) {
    return { error: error?.message ?? "No se pudo crear la tienda." };
  }

  await admin.from("user_store_access").insert({ user_id: user.id, store_id: store.id });

  // Register webhooks + initial backfill (best-effort; never blocks creation).
  if (shopify_token) {
    try {
      const callbackUrl = `${env.siteUrl()}/api/webhooks/shopify/${store.id}`;
      const results = await registerOrderWebhooks({
        domain: shopify_domain,
        token: shopify_token,
        callbackUrl,
      });
      const failed = results.filter((r) => r.error);
      if (failed.length) {
        warnings.push(`Webhooks con problemas: ${failed.map((f) => `${f.topic}: ${f.error}`).join("; ")}`);
      }
    } catch (e) {
      warnings.push(`No se pudieron registrar los webhooks: ${errMsg(e)}`);
    }
    try {
      await runStoreSync(store.id, admin);
    } catch (e) {
      warnings.push(`Backfill inicial incompleto: ${errMsg(e)}`);
    }
  }

  revalidatePath("/dashboard");
  redirect(`/dashboard/${store.id}`);
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
