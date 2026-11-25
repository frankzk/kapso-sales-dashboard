import "server-only";

// Corre las respuestas automáticas de Leads → Redes después de guardar un aviso
// de Zernio (MOM §25.4). La regla y los textos viven en lib/social-auto.ts.
// Nada se manda dos veces: cada respuesta lleva una llave fija por comentario o
// conversación, única en `social_messages`.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { NormalizedEvent } from "@/lib/social-inbox";
import { autoTexts, DEFAULT_COMMENT_KEYWORDS, hasBuyingIntent, whatsappLink, type SocialAutoSettings } from "@/lib/social-auto";
import { sendSocial, type SendableThread } from "@/lib/social-send";
import { loadStoreOrderPlatform, wooSaleClient } from "@/lib/woocommerce-orders";
import { wooGetPage } from "@/lib/woocommerce";
import { withWooAuthFallback } from "@/lib/woocommerce-intake";
import { zernioConfigured } from "@/lib/zernio";

export async function loadAutoSettings(admin: SupabaseClient, storeId: string): Promise<SocialAutoSettings | null> {
  const { data } = await admin.from("social_auto_settings").select("enabled,comment_keywords,public_text,private_text,dm_text").eq("store_id", storeId).maybeSingle();
  return (data as SocialAutoSettings | null) ?? null;
}

/** El WhatsApp principal de la tienda (`stores.whatsapp_phone_number_id`). */
export async function storeWhatsappPhone(admin: SupabaseClient, storeId: string): Promise<string | null> {
  const { data: store } = await admin.from("stores").select("whatsapp_phone_number_id").eq("id", storeId).maybeSingle();
  const id = (store as { whatsapp_phone_number_id: string | null } | null)?.whatsapp_phone_number_id;
  if (!id) return null;
  const { data: line } = await admin.from("whatsapp_numbers").select("display_phone").eq("phone_number_id", id).maybeSingle();
  return (line as { display_phone: string | null } | null)?.display_phone ?? null;
}

/**
 * El producto (y su precio en vivo) del anuncio donde comentaron: el que se
 * declaró en «Producto por anuncio». Sin anuncio, sin declaración o sin
 * precio legible, lo que falte va null (el texto cae al que no lo usa).
 */
export async function productForAd(admin: SupabaseClient, storeId: string, adId: string | null): Promise<{ title: string | null; price: number | null }> {
  if (!adId) return { title: null, price: null };
  const { data: decl } = await admin.from("ad_product_declarations").select("product_handle,valid_from")
    .eq("store_id", storeId).eq("ad_id", adId).lte("valid_from", new Date().toISOString())
    .order("valid_from", { ascending: false }).limit(1).maybeSingle();
  const handle = (decl as { product_handle: string | null } | null)?.product_handle;
  if (!handle) return { title: null, price: null };
  try {
    const platform = await loadStoreOrderPlatform(admin, storeId);
    if (platform.ok && platform.platform === "woocommerce") {
      const client = wooSaleClient(platform.creds, { timeoutMs: 8_000 });
      const result = await withWooAuthFallback(client, (opts) => wooGetPage<{ name: string; price: string; status: string }>(opts, "/products", { slug: handle, _fields: "name,price,status", per_page: 1 }));
      const p = result.value.items[0];
      if (p) {
        const price = Number(p.price);
        return { title: p.name || null, price: Number.isFinite(price) && price > 0 ? price : null };
      }
    }
  } catch {
    // Sin WooCommerce no se inventa: se busca solo el nombre.
  }
  const { data: archived } = await admin.from("shopify_history_products").select("title").eq("store_id", storeId).eq("handle", handle).maybeSingle();
  return { title: (archived as { title: string | null } | null)?.title ?? null, price: null };
}

/**
 * Lo automático de un aviso ya guardado en `threadId`. No hace nada si la
 * tienda no lo encendió, si Zernio no está conectado o si el aviso no es de
 * una clienta. Devuelve qué mandó, para el registro.
 */
export async function runSocialAutoReplies(admin: SupabaseClient, ev: NormalizedEvent, threadId: string | null): Promise<string[]> {
  if (!threadId || ev.kind === "account" || !zernioConfigured()) return [];
  const { data: t } = await admin.from("social_threads")
    .select("id,store_id,account_id,kind,external_id,post_id,ad_id,participant_name,private_reply_at")
    .eq("id", threadId).maybeSingle();
  const thread = t as (SendableThread & { ad_id: string | null; participant_name: string | null; private_reply_at: string | null }) | null;
  if (!thread?.store_id) return [];
  const settings = await loadAutoSettings(admin, thread.store_id);
  if (!settings?.enabled) return [];
  const phone = await storeWhatsappPhone(admin, thread.store_id);
  const done: string[] = [];

  if (ev.kind === "comment") {
    // Solo el comentario principal de una clienta, no las respuestas ni lo nuestro.
    if (ev.comment.isOwn || ev.comment.id !== ev.comment.threadId) return [];
    const keywords = settings.comment_keywords?.length ? settings.comment_keywords : DEFAULT_COMMENT_KEYWORDS;
    if (!hasBuyingIntent(ev.comment.text, keywords)) return [];
    const product = await productForAd(admin, thread.store_id, thread.ad_id);
    const link = whatsappLink(phone, product.title ? `Hola, quiero ${product.title}` : "Hola, vengo de redes y quiero información");
    if (!link) return [];
    const texts = autoTexts(settings, { producto: product.title, precio: product.price, whatsapp: link, nombre: thread.participant_name });
    if (texts.publicText) {
      const r = await sendSocial(admin, thread, { text: texts.publicText, mode: "public", userId: null, via: "auto", idempotencyKey: `auto:pub:${ev.comment.id}` });
      if (r.ok) done.push("publico");
    }
    // El privado: uno solo por comentario, y solo si nadie lo usó.
    if (texts.privateText && !thread.private_reply_at) {
      const r = await sendSocial(admin, thread, { text: texts.privateText, mode: "private", userId: null, via: "auto", idempotencyKey: `auto:priv:${ev.comment.id}` });
      if (r.ok) done.push("privado");
    }
    return done;
  }

  // Mensaje directo: solo al primer mensaje de la clienta en la conversación.
  if (ev.message.direction !== "in") return [];
  const { count: inbound } = await admin.from("social_messages").select("id", { count: "exact", head: true }).eq("thread_id", thread.id).eq("direction", "in");
  const { count: outbound } = await admin.from("social_messages").select("id", { count: "exact", head: true }).eq("thread_id", thread.id).eq("direction", "out");
  if ((inbound ?? 0) !== 1 || (outbound ?? 0) > 0) return [];
  const link = whatsappLink(phone, "Hola, vengo de redes y quiero información");
  if (!link) return [];
  const { dmText } = autoTexts(settings, { whatsapp: link, nombre: thread.participant_name });
  if (!dmText) return [];
  const r = await sendSocial(admin, thread, { text: dmText, mode: "dm", userId: null, via: "auto", idempotencyKey: `auto:dm:${thread.id}` });
  if (r.ok) done.push("dm");
  return done;
}
