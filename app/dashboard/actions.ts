"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createServerSupabase, createAdminSupabase } from "@/lib/db";
import { encryptOrNull } from "@/lib/crypto";
import {
  fetchShopInfo,
  isValidShopDomain,
  registerOrderWebhooks,
  searchCatalogProducts,
} from "@/lib/shopify";
import { getStoreCreds, runStoreSync } from "@/lib/ingest";
import { filtroCampanaEnUtm } from "@/lib/cod-cart-attribution";
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

export async function saveAdPromotedProduct(input: {
  adId: string;
  productName: string;
  skus: string[];
  /** Cuántos anuncios del mismo conjunto heredaron la asignación. */
}): Promise<{ ok: true; heredados: number } | { ok: false; error: string }> {
  await requireUser();
  const adId = input.adId.trim();
  const productName = input.productName.trim();
  const skus = [...new Set(input.skus.map((sku) => sku.trim().toUpperCase()).filter(Boolean))];
  if (!adId || !productName) return { ok: false, error: "Indica el anuncio y el producto promovido." };

  // AUTORIZACIÓN POR DOS CAMINOS, y el segundo no es un añadido: sin él este
  // formulario es inusable para 3.314 de los 3.594 anuncios de las campañas que
  // venden.
  //
  // El de siempre es «un lead MÍO cita este anuncio», y era prueba suficiente
  // cuando toda fila del panel nacía de una conversación de WhatsApp. Los
  // anuncios que venden por el carrito COD de la web no producen NINGÚN lead
  // (lib/cod-cart-attribution.ts), así que desde que esas filas aparecen en el
  // panel —con sus pedidos y su ROAS— el guardado les contestaba «No tienes
  // acceso a este anuncio», que además es falso: son suyos.
  //
  // El segundo camino es el mismo estándar aplicado al canal nuevo: «un PEDIDO
  // mío cita su campaña». Va a nivel de campaña porque es lo que el pedido
  // guarda (`utm_id`); el anuncio concreto se deduce después y no siempre. Sigue
  // acotado por la RLS del llamante igual que el primero.
  const sb = await createServerSupabase();
  const admin = createAdminSupabase();
  const { data: visibleLead } = await sb.from("leads").select("id").eq("ad_id", adId).limit(1).maybeSingle();
  let authorized = Boolean(visibleLead);
  if (!authorized) {
    // `meta_ads` no es legible bajo RLS (0034), así que la campaña del anuncio
    // se busca con el cliente de servicio. No descubre nada: el ad_id lo trajo
    // el llamante, y lo único que se hace con la campaña es interrogar SUS
    // pedidos.
    const { data: ad } = await admin
      .from("meta_ads")
      .select("campaign_id")
      .eq("ad_id", adId)
      .maybeSingle();
    const campaignId = (ad as { campaign_id?: string | null } | null)?.campaign_id ?? null;
    if (campaignId) {
      const { data: visibleOrder } = await sb
        .from("orders")
        .select("id")
        // `utm_meta is not null` lo implica el contains, pero es lo que lleva la
        // consulta al índice parcial de la 0156 en vez de a un recorrido entero.
        .not("utm_meta", "is", null)
        .contains("utm_meta", filtroCampanaEnUtm(campaignId))
        .limit(1)
        .maybeSingle();
      authorized = Boolean(visibleOrder);
    }
  }
  if (!authorized) return { ok: false, error: "No tienes acceso a este anuncio." };

  const now = new Date().toISOString();
  const { error } = await admin.from("meta_ads").upsert(
    {
      ad_id: adId,
      promoted_product_name: productName,
      promoted_skus: skus,
      promoted_product_updated_at: now,
    },
    { onConflict: "ad_id" },
  );
  if (error) {
    const migrationHint = /promoted_product/i.test(error.message)
      ? " Falta aplicar la migración 0071."
      : "";
    return { ok: false, error: `No se pudo guardar el producto.${migrationHint}` };
  }

  const heredados = await heredarAlConjunto(admin, adId, productName, skus, now);
  revalidatePath("/dashboard");
  return { ok: true, heredados };
}

/**
 * UN CONJUNTO DE ANUNCIOS PROMOCIONA UN SOLO PRODUCTO.
 *
 * Es como se arma la cuenta: el conjunto es la unidad de prueba —mismo público,
 * mismo presupuesto, mismo producto— y lo que cambia entre sus anuncios es el
 * creativo. Por eso asignar uno y dejar los otros treinta «Por mapear» no es
 * información que falte: es la misma información sin copiar.
 *
 * Medido el 14-09-2026: 5.213 anuncios, 68 asignados a mano, y **cero conjuntos
 * con dos productos distintos asignados** — la regla ya se cumplía a mano. Esas
 * 68 asignaciones alcanzan a **523 anuncios** por herencia.
 *
 * Se hereda solo hacia los que NO tienen producto. Una asignación existente
 * nunca se pisa: si alguien mapeó un anuncio a otra cosa a propósito, esa
 * decisión gana, y el conjunto queda con dos productos (lo que hoy no pasa)
 * sin que este código lo «arregle» por su cuenta.
 *
 * La campaña NO sirve para esto: en la de «Cayenne Pepper 0608» conviven 23
 * conjuntos, y el producto se decide por conjunto.
 */
async function heredarAlConjunto(
  admin: ReturnType<typeof createAdminSupabase>,
  adId: string,
  productName: string,
  skus: string[],
  now: string,
): Promise<number> {
  const { data: origen } = await admin
    .from("meta_ads")
    .select("adset_id")
    .eq("ad_id", adId)
    .maybeSingle();
  const adsetId = (origen as { adset_id?: string | null } | null)?.adset_id ?? null;
  if (!adsetId) return 0;

  const { data: hermanos, error } = await admin
    .from("meta_ads")
    .update({
      promoted_product_name: productName,
      promoted_skus: skus,
      promoted_product_updated_at: now,
    })
    .eq("adset_id", adsetId)
    .neq("ad_id", adId)
    .is("promoted_product_name", null)
    .select("ad_id");
  // Best-effort: el anuncio que se pidió ya quedó guardado. Si la herencia
  // falla, se informa cero y la próxima asignación en ese conjunto lo reintenta.
  if (error) return 0;
  return hermanos?.length ?? 0;
}

export interface PromotedProductSuggestion {
  title: string;
  skus: string[];
  imageUrl: string | null;
  stores: string[];
}

/** Search the authorized Shopify catalog(s) attached to an attributed ad. */
export async function searchPromotedProducts(
  storeIds: string[],
  query: string,
): Promise<{ products: PromotedProductSuggestion[]; error?: string }> {
  await requireUser();
  const q = query.trim();
  const requested = [...new Set(storeIds.map((id) => id.trim()).filter(Boolean))].slice(0, 10);
  if (q.length < 2 || !requested.length) return { products: [] };

  // RLS is the authorization boundary before service-role credentials are read.
  const sb = await createServerSupabase();
  const { data: visibleStores, error } = await sb
    .from("stores")
    .select("id, name")
    .in("id", requested);
  if (error) return { products: [], error: "No se pudo validar el acceso al catálogo." };

  const allowed = new Map(
    (visibleStores ?? []).map((store) => [String(store.id), String(store.name ?? "Tienda")]),
  );
  if (!allowed.size) {
    return { products: [], error: "No tienes acceso al catálogo de este anuncio." };
  }

  const searches = await Promise.all(
    [...allowed.entries()].map(async ([storeId, storeName]) => {
      const creds = await getStoreCreds(storeId);
      if (!creds?.shopify_token) return { storeName, products: [] };
      try {
        const products = await searchCatalogProducts({
          domain: creds.shopify_domain,
          token: creds.shopify_token,
          query: q,
          first: 12,
        });
        return { storeName, products };
      } catch {
        return { storeName, products: [] };
      }
    }),
  );

  const merged = new Map<string, PromotedProductSuggestion>();
  for (const result of searches) {
    for (const product of result.products) {
      const skus = [
        ...new Set(
          product.variants
            .map((variant) => variant.sku?.trim().toUpperCase())
            .filter((sku): sku is string => Boolean(sku)),
        ),
      ];
      const key = `${product.title.trim().toLocaleLowerCase("es")}|${skus.join(",")}`;
      const current = merged.get(key);
      if (current) {
        if (!current.stores.includes(result.storeName)) current.stores.push(result.storeName);
      } else {
        merged.set(key, {
          title: product.title.trim(),
          skus,
          imageUrl: product.imageUrl,
          stores: [result.storeName],
        });
      }
    }
  }

  return {
    products: [...merged.values()]
      .sort((a, b) => a.title.localeCompare(b.title, "es"))
      .slice(0, 20),
  };
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
