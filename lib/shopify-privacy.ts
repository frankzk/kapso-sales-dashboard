/**
 * Avisos de privacidad de la app de clientes (MOM §29.15.9): Shopify exige
 * atender `customers/data_request`, `customers/redact` y `shop/redact`, y
 * verifica en su revisión que el endpoint exista, responda 200 y rechace con 401
 * una firma inválida.
 *
 * Aquí se VERIFICA y se REGISTRA cada aviso en `shopify_privacy_requests`
 * (0240), antes de responder. Atenderlo —anonimizar o entregar los datos a la
 * tienda— es un trabajo aparte que deja la solicitud `atendida`; Shopify da
 * hasta 30 días. Lo único que se hace en el acto es cortar el acceso de la
 * tienda en un `shop/redact`, que llega 48 horas después de desinstalar.
 */
import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { verifyShopifyHmac } from "@/lib/shopify";
import { asPrivacyTopic, parsePrivacyPayload } from "@/lib/shopify-client-app";

export type PrivacyWebhookStatus = "ok" | "duplicate" | "ignored" | "unauthorized" | "invalid";

export interface PrivacyWebhookParams {
  topic: string | null;
  rawBody: string;
  hmacHeader: string | null;
  webhookIdHeader: string | null;
  /** Secreto de la app de clientes; vacío = no configurada = todo se rechaza. */
  secret: string;
  now?: Date;
}

export async function recordShopifyPrivacyRequest(
  admin: SupabaseClient,
  params: PrivacyWebhookParams,
): Promise<{ status: PrivacyWebhookStatus; message?: string }> {
  if (!params.secret || !verifyShopifyHmac(params.rawBody, params.hmacHeader, params.secret)) {
    return { status: "unauthorized" };
  }
  const topic = asPrivacyTopic(params.topic);
  // Un tema que no es de privacidad no es asunto de este endpoint: 200 para
  // que Shopify no lo reintente, sin escribir nada.
  if (!topic) return { status: "ignored" };

  const parsed = parsePrivacyPayload(params.rawBody);
  if (!parsed) return { status: "invalid", message: "aviso sin tienda válida" };

  const webhookId =
    params.webhookIdHeader?.trim() ||
    createHash("sha256").update(params.rawBody, "utf8").digest("hex");

  const { data: store, error: storeError } = await admin
    .from("stores")
    .select("id")
    .eq("shopify_domain", parsed.shopDomain)
    .eq("shopify_app", "clientes")
    .maybeSingle();
  if (storeError) throw new Error(`stores: ${storeError.message}`);
  const storeId = (store as { id: string } | null)?.id ?? null;

  const { error: insertError } = await admin.from("shopify_privacy_requests").insert({
    topic,
    shop_domain: parsed.shopDomain,
    shop_id: parsed.shopId,
    store_id: storeId,
    webhook_id: webhookId,
    payload: parsed.payload,
  });
  if (insertError) {
    if ((insertError as { code?: string }).code === "23505") return { status: "duplicate" };
    // 5xx en la ruta: Shopify reintenta y el aviso no se pierde.
    throw new Error(`shopify_privacy_requests: ${insertError.message}`);
  }

  if (topic === "shop/redact" && storeId) {
    const now = (params.now ?? new Date()).toISOString();
    const { error: cutError } = await admin
      .from("stores")
      .update({ shopify_token_enc: null, status: "disabled" })
      .eq("id", storeId);
    if (cutError) throw new Error(`stores: ${cutError.message}`);
    // Si el `app/uninstalled` se perdió, la fecha queda puesta aquí.
    await admin
      .from("stores")
      .update({ shopify_uninstalled_at: now })
      .eq("id", storeId)
      .is("shopify_uninstalled_at", null);
  }

  return { status: "ok" };
}
