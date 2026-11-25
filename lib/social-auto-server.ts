import "server-only";

// Corre las respuestas automáticas de Leads → Redes después de guardar un aviso
// de Zernio (MOM §25.4). La regla y los textos viven en lib/social-auto.ts.
// Nada se manda dos veces: cada respuesta lleva una llave fija por comentario o
// conversación, única en `social_messages`.

import type { SupabaseClient } from "@supabase/supabase-js";
import { dmReplyMode, privateReplyAllowed, type NormalizedEvent } from "@/lib/social-inbox";
import { autoTexts, DEFAULT_COMMENT_KEYWORDS, hasBuyingIntent, whatsappLink, type SocialAutoSettings } from "@/lib/social-auto";
import { sendSocial, type SendableThread } from "@/lib/social-send";
import { loadStoreOrderPlatform, wooSaleClient } from "@/lib/woocommerce-orders";
import { wooGetPage } from "@/lib/woocommerce";
import { withWooAuthFallback } from "@/lib/woocommerce-intake";
import { zernioConfigured } from "@/lib/zernio";
import { generateSocialAiReply, socialAiConfigured, storeCatalog } from "@/lib/social-ai-server";
import type { SocialAiReply } from "@/lib/social-ai";

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

/** Una ráfaga de mensajes seguidos se contesta una vez: se espera un momento y responde el último. */
const DM_SETTLE_MS = 8_000;
/** Si una asesora abrió el hilo hace menos de 10 minutos, la IA no se mete. */
const HUMAN_HOLD_MS = 10 * 60_000;
/** «Responder pendientes con IA»: pausa entre envíos de cada uno de los tres turnos. */
const BULK_PAUSE_MS = 2_000;

/**
 * Lo automático de un aviso ya guardado en `threadId`. No hace nada si la
 * tienda no lo encendió, si Zernio no está conectado o si el aviso no es de
 * una clienta. Con la clave de Anthropic responde la IA (Claude Haiku 5.5,
 * lib/social-ai.ts) todo lo que escribe una clienta; si la IA falla o no hay
 * clave, los textos fijos de lib/social-auto.ts. Devuelve qué mandó.
 */
export async function runSocialAutoReplies(admin: SupabaseClient, ev: NormalizedEvent, threadId: string | null): Promise<string[]> {
  if (!threadId || ev.kind === "account" || !zernioConfigured()) return [];
  if (ev.kind === "comment" && (ev.comment.isOwn || ev.comment.id !== ev.comment.threadId)) return [];
  if (ev.kind === "dm" && ev.message.direction !== "in") return [];
  const thread = await loadThread(admin, threadId);
  if (!thread?.store_id) return [];
  const settings = await loadAutoSettings(admin, thread.store_id);
  if (!settings?.enabled) return [];
  const phone = await storeWhatsappPhone(admin, thread.store_id);

  if (socialAiConfigured()) {
    const ai = await runAi(admin, ev, thread, phone);
    if (ai) return ai;
  }
  return runTemplates(admin, ev, thread, settings, phone);
}

export type AutoThread = SendableThread & {
  ad_id: string | null; participant_name: string | null; private_reply_at: string | null; post_text: string | null;
  platform: string; claimed_by: string | null; claimed_at: string | null;
};

async function loadThread(admin: SupabaseClient, threadId: string): Promise<AutoThread | null> {
  const { data } = await admin.from("social_threads")
    .select("id,store_id,account_id,kind,external_id,post_id,ad_id,participant_name,private_reply_at,post_text,platform,claimed_by,claimed_at")
    .eq("id", threadId).maybeSingle();
  return (data as AutoThread | null) ?? null;
}

/**
 * La respuesta de la IA para un hilo, sin mandarla (la usa lo automático y el
 * botón «Sugerir con IA»). "sin_turno" si lo último no es de la clienta; null
 * si la IA no pudo (sin clave, sin WhatsApp de la tienda, error, negativa).
 */
export async function draftAiReply(admin: SupabaseClient, thread: AutoThread, phone: string | null): Promise<SocialAiReply | "sin_turno" | null> {
  const storeId = thread.store_id;
  if (!storeId) return null;
  const [{ data: store }, catalog, adProduct, { data: rows }] = await Promise.all([
    admin.from("stores").select("name").eq("id", storeId).maybeSingle(),
    storeCatalog(admin, storeId),
    productForAd(admin, storeId, thread.ad_id),
    admin.from("social_messages").select("direction,text").eq("thread_id", thread.id).neq("status", "fallo")
      .order("occurred_at", { ascending: false }).limit(12),
  ]);
  const link = whatsappLink(phone, adProduct.title ? `Hola, quiero ${adProduct.title}` : "Hola, vengo de redes y quiero información");
  if (!link) return null;
  const history = ((rows as Array<{ direction: "in" | "out"; text: string | null }> | null) ?? [])
    .reverse().filter((m) => m.text?.trim()).map((m) => ({ from: m.direction === "in" ? "cliente" as const : "tienda" as const, text: m.text! }));
  if (!history.length || history[history.length - 1]!.from !== "cliente") return "sin_turno";
  return generateSocialAiReply({
    storeName: (store as { name: string } | null)?.name ?? "la tienda",
    platform: thread.platform, kind: thread.kind, whatsapp: link, catalog,
    adProduct: adProduct.title ? { name: adProduct.title, price: adProduct.price } : null,
    postText: thread.post_text, customerName: thread.participant_name, history,
  });
}

/** El hilo con lo que necesita lo automático. */
export async function loadAutoThread(admin: SupabaseClient, threadId: string): Promise<AutoThread | null> {
  return loadThread(admin, threadId);
}

/** La IA: null si no pudo responder (se cae a los textos fijos); [] si decidió no responder o no le toca. */
async function runAi(admin: SupabaseClient, ev: Exclude<NormalizedEvent, { kind: "account" }>, initial: AutoThread, phone: string | null): Promise<string[] | null> {
  const storeId = initial.store_id!;
  let thread = initial;
  if (ev.kind === "dm") {
    await new Promise((r) => setTimeout(r, DM_SETTLE_MS));
    const fresh = await loadThread(admin, thread.id);
    if (!fresh) return [];
    thread = fresh;
    // Solo si lo último sigue siendo este mensaje de la clienta (otro más nuevo responde por todos).
    const { data: last } = await admin.from("social_messages").select("direction,external_id")
      .eq("thread_id", thread.id).neq("status", "fallo").order("occurred_at", { ascending: false }).limit(1).maybeSingle();
    const l = last as { direction: string; external_id: string | null } | null;
    if (!l || l.direction !== "in" || (ev.message.externalId && l.external_id !== ev.message.externalId)) return [];
  }
  const claimedAt = Date.parse(thread.claimed_at ?? "");
  if (thread.claimed_by && Number.isFinite(claimedAt) && Date.now() - claimedAt < HUMAN_HOLD_MS) return [];

  const draft = await draftAiReply(admin, thread, phone);
  if (draft === "sin_turno") return [];
  const reply = draft;
  if (!reply) return null;
  if (reply.skip) return [];

  const done: string[] = [];
  if (ev.kind === "comment") {
    // Los dos: el público y el privado (owner, 25-11-2026). El privado es uno solo por comentario.
    if (reply.publicText) {
      const r = await sendSocial(admin, thread, { text: reply.publicText, mode: "public", userId: null, via: "auto", idempotencyKey: `ai:pub:${ev.comment.id}` });
      if (r.ok) done.push("publico");
    }
    if (reply.privateText && !thread.private_reply_at) {
      const r = await sendSocial(admin, thread, { text: reply.privateText, mode: "private", userId: null, via: "auto", idempotencyKey: `ai:priv:${ev.comment.id}` });
      if (r.ok) done.push("privado");
    }
    return done;
  }
  if (!reply.privateText) return null;
  const key = `ai:dm:${ev.message.externalId ?? `${thread.id}:${ev.message.occurredAt}`}`;
  const r = await sendSocial(admin, thread, { text: reply.privateText, mode: "dm", userId: null, via: "auto", idempotencyKey: key });
  if (r.ok) done.push("dm");
  return done;
}

/** Los textos fijos (sin IA): comentario con palabras de compra y primer mensaje directo. */
async function runTemplates(admin: SupabaseClient, ev: Exclude<NormalizedEvent, { kind: "account" }>, thread: AutoThread, settings: SocialAutoSettings, phone: string | null): Promise<string[]> {
  const done: string[] = [];
  if (ev.kind === "comment") {
    const keywords = settings.comment_keywords?.length ? settings.comment_keywords : DEFAULT_COMMENT_KEYWORDS;
    if (!hasBuyingIntent(ev.comment.text, keywords)) return [];
    const product = await productForAd(admin, thread.store_id!, thread.ad_id);
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

export interface PendingAiResult {
  respondidas: number;
  omitidas: number;
  /** Mensajes directos de más de 24 h: Meta solo deja escribir a una persona (la asesora, con «Sugerir con IA»). */
  fueraDeVentana: number;
  tomadas: number;
  fallidas: number;
}

/**
 * «Responder pendientes con IA» (owner, 25-11-2026: «¿no puedes responder todo
 * lo pendiente?»): pasa la IA por lo que está en «Por responder» de las tiendas
 * dadas. Comentario: público y privado (si aún se puede). Mensaje directo: solo
 * dentro de las 24 h (después Meta exige una persona). No toca lo que una
 * asesora abrió hace menos de 10 minutos. Las llaves son las de lo automático:
 * nada sale dos veces.
 */
export async function answerPendingWithAi(admin: SupabaseClient, storeIds: string[]): Promise<PendingAiResult> {
  const out: PendingAiResult = { respondidas: 0, omitidas: 0, fueraDeVentana: 0, tomadas: 0, fallidas: 0 };
  if (!storeIds.length || !socialAiConfigured() || !zernioConfigured()) return out;
  const { data } = await admin.from("social_threads").select("id,kind,last_inbound_at")
    .in("store_id", storeIds).eq("status", "abierto").eq("last_direction", "in")
    .order("last_message_at", { ascending: false }).limit(80);
  const rows = (data as Array<{ id: string; kind: "dm" | "comment"; last_inbound_at: string | null }> | null) ?? [];
  const phones = new Map<string, string | null>();
  const queue = [...rows];
  const worker = async () => {
    for (let row = queue.shift(); row; row = queue.shift()) {
      if (row.kind === "dm" && dmReplyMode(row.last_inbound_at) !== "libre") { out.fueraDeVentana++; continue; }
      const thread = await loadThread(admin, row.id);
      if (!thread?.store_id) { out.fallidas++; continue; }
      const claimedAt = Date.parse(thread.claimed_at ?? "");
      if (thread.claimed_by && Number.isFinite(claimedAt) && Date.now() - claimedAt < HUMAN_HOLD_MS) { out.tomadas++; continue; }
      if (!phones.has(thread.store_id)) phones.set(thread.store_id, await storeWhatsappPhone(admin, thread.store_id));
      const draft = await draftAiReply(admin, thread, phones.get(thread.store_id) ?? null);
      if (draft === "sin_turno" || draft?.skip) { out.omitidas++; continue; }
      if (!draft) { out.fallidas++; continue; }
      const { data: lastIn } = await admin.from("social_messages").select("external_id,occurred_at").eq("thread_id", thread.id)
        .eq("direction", "in").order("occurred_at", { ascending: false }).limit(1).maybeSingle();
      const last = lastIn as { external_id: string | null; occurred_at: string } | null;
      let sent = false;
      if (thread.kind === "comment") {
        if (draft.publicText) sent = (await sendSocial(admin, thread, { text: draft.publicText, mode: "public", userId: null, via: "auto", idempotencyKey: `ai:pub:${thread.external_id}` })).ok || sent;
        // Los 7 días cuentan desde el comentario (no desde que Kapta lo trajo).
        const { data: firstIn } = await admin.from("social_messages").select("occurred_at").eq("thread_id", thread.id)
          .eq("direction", "in").order("occurred_at").limit(1).maybeSingle();
        const commentAt = (firstIn as { occurred_at: string } | null)?.occurred_at ?? null;
        if (draft.privateText && privateReplyAllowed({ kind: "comment", private_reply_at: thread.private_reply_at }, commentAt)) {
          sent = (await sendSocial(admin, thread, { text: draft.privateText, mode: "private", userId: null, via: "auto", idempotencyKey: `ai:priv:${thread.external_id}` })).ok || sent;
        }
      } else if (draft.privateText) {
        const key = `ai:dm:${last?.external_id ?? `${thread.id}:${last?.occurred_at ?? ""}`}`;
        sent = (await sendSocial(admin, thread, { text: draft.privateText, mode: "dm", userId: null, via: "auto", idempotencyKey: key })).ok;
      }
      if (sent) out.respondidas++; else out.fallidas++;
      // Sin ráfagas: una pausa entre envíos para no parecer spam ante Meta.
      await new Promise((r) => setTimeout(r, BULK_PAUSE_MS));
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  return out;
}
