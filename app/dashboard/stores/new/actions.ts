"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createAdminSupabase, createServerSupabase } from "@/lib/db";
import { encrypt } from "@/lib/crypto";
import { hasOrgPermission } from "@/lib/permissions-access";
import { fetchShopInfo } from "@/lib/shopify";
import { storeNameFromShop } from "@/lib/shopify-client-app";
import { finishClientStoreConnection } from "@/lib/shopify-client-install";
import {
  isOwnAppMigrationMissing,
  missingScopes,
  missingScopesMessage,
  normalizeShopDomain,
  OWN_APP,
  OWN_APP_MIGRATION_MISSING_MESSAGE,
  requestClientCredentialsToken,
} from "@/lib/shopify-own-app";

export interface OwnAppConnectState {
  error?: string;
  /** Avisos de una conexión que SÍ quedó hecha (webhooks, primera sincronización). */
  warnings?: string[];
  /** La tienda creada, cuando hay avisos y no se redirige. */
  storeId?: string;
}

/** Lo que mide un Client ID o un Client secret, con holgura. Sin espacios. */
const CREDENTIAL_RE = /^\S{8,256}$/;

/**
 * «Conectar con app propia de Shopify» (owner, 23-10-2026; MOM §36.2).
 *
 * Para la tienda cuya organización de Shopify creó su propia app en el Dev
 * Dashboard y la instaló: con el dominio, el Client ID y el Client secret,
 * Kapta pide un token (client credentials grant), comprueba los permisos, crea
 * la tienda con `shopify_app = 'propia'`, registra los webhooks (con
 * `app/uninstalled`) y hace la primera sincronización.
 *
 * NUNCA TOCA OTRA TIENDA. Si ya hay en Kapta una tienda con ese dominio —sea de
 * la app interna (Kenku, Aurela), de la de clientes o de otra app propia— se
 * rechaza sin escribir nada. Solo inserta; no actualiza ninguna fila.
 *
 * El permiso es el de crear tiendas hoy: «Administrar tiendas» en la
 * organización (MOM §16).
 */
export async function connectOwnAppStore(
  _prev: OwnAppConnectState,
  formData: FormData,
): Promise<OwnAppConnectState> {
  const sb = await createServerSupabase();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) redirect("/login");

  const orgId = String(formData.get("org_id") ?? "").trim();
  if (!orgId) return { error: "Elige la organización." };
  if (!(await hasOrgPermission(orgId, "stores.manage"))) {
    return { error: "No tienes permiso para crear tiendas en esta organización." };
  }

  const shop = normalizeShopDomain(String(formData.get("shopify_domain") ?? ""));
  if (!shop) return { error: "Dominio de Shopify inválido. Debe ser tu-tienda.myshopify.com." };
  const clientId = String(formData.get("client_id") ?? "").trim();
  const clientSecret = String(formData.get("client_secret") ?? "").trim();
  if (!CREDENTIAL_RE.test(clientId)) return { error: "Pega el Client ID de la app (Dev Dashboard → Configuración)." };
  if (!CREDENTIAL_RE.test(clientSecret)) {
    return { error: "Pega el Client secret de la app (Dev Dashboard → Configuración)." };
  }

  const admin = createAdminSupabase();

  // ¿Ya está en Kapta? En cualquier organización y con cualquier app: no se toca.
  const { data: existing, error: existingError } = await admin
    .from("stores")
    .select("id")
    .ilike("shopify_domain", shop)
    .limit(1);
  if (existingError) return { error: "No se pudo comprobar si la tienda ya está en Kapta. No se creó nada." };
  if ((existing ?? []).length > 0) {
    return { error: "Esa tienda de Shopify ya está conectada a Kapta. No se cambió nada en ella." };
  }

  const got = await requestClientCredentialsToken({ shop, clientId, clientSecret });
  if (!got.ok) return { error: got.message };
  const missing = missingScopes(got.scopes);
  if (missing.length) return { error: missingScopesMessage(missing) };

  const warnings: string[] = [];
  let currency = "PEN";
  let timezone = "America/Lima";
  let shopName = "";
  try {
    const info = await fetchShopInfo({ domain: shop, token: got.token });
    currency = info.currencyCode || currency;
    timezone = info.ianaTimezone || timezone;
    shopName = (info.name ?? "").trim();
  } catch {
    warnings.push("No se pudo leer la moneda y la zona horaria de la tienda: quedaron PEN y America/Lima (se cambian en Ajustes).");
  }
  const name = String(formData.get("name") ?? "").trim() || shopName || storeNameFromShop(shop);

  const now = new Date();
  const { data: store, error } = await admin
    .from("stores")
    .insert({
      org_id: orgId,
      name,
      shopify_domain: shop,
      shopify_app: OWN_APP,
      shopify_token_enc: encrypt(got.token),
      // Los webhooks que registra la app llegan firmados con su Client secret.
      shopify_webhook_secret_enc: encrypt(clientSecret),
      shopify_client_id: clientId,
      shopify_client_secret_enc: encrypt(clientSecret),
      shopify_token_expires_at: got.expiresAt.toISOString(),
      shopify_token_renewed_at: now.toISOString(),
      currency,
      timezone,
      status: "active",
    })
    .select("id")
    .single();
  if (error || !store) {
    if (isOwnAppMigrationMissing(error)) return { error: OWN_APP_MIGRATION_MISSING_MESSAGE };
    if ((error as { code?: string } | null)?.code === "23505") {
      return { error: "Esa tienda de Shopify ya está conectada a Kapta. No se cambió nada en ella." };
    }
    return { error: "No se pudo crear la tienda. No se guardó nada." };
  }
  const storeId = (store as { id: string }).id;

  await admin.from("user_store_access").insert({ user_id: user.id, store_id: storeId });
  // Webhooks de pedidos, borradores y `app/uninstalled` al handler por tienda,
  // y la primera sincronización: lo mismo que la app de clientes.
  warnings.push(...(await finishClientStoreConnection(admin, { storeId, shop, token: got.token })));

  revalidatePath("/dashboard");
  if (warnings.length) return { warnings, storeId };
  redirect(`/dashboard/${storeId}`);
}
