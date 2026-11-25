"use server";

// Leads → Redes (MOM §25.4): responder comentarios y mensajes directos de
// Facebook e Instagram desde Kapta, por Zernio. Cada acción lee el hilo con la
// sesión (RLS: solo tiendas a las que la asesora tiene acceso) y escribe con el
// cliente de servicio.

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { createAdminSupabase, createServerSupabase } from "@/lib/db";
import { getMasterPermissions } from "@/lib/permissions-access";
import { dmReplyMode, isSocialPlatform, privateReplyAllowed, type NormalizedComment, type NormalizedDm } from "@/lib/social-inbox";
import { applySocialEvent, upsertSocialAccount } from "@/lib/social-inbox-store";
import { sendSocial } from "@/lib/social-send";
import { zernio, zernioConfigured, ZernioError } from "@/lib/zernio";
import { socialAiConfigured } from "@/lib/social-ai-server";
import { answerPendingWithAi, draftAiReply, loadAutoThread, storeWhatsappPhone, type PendingAiResult } from "@/lib/social-auto-server";

const PATH = "/dashboard/leads/redes";
const MAX_TEXT = 1000;

export interface SocialMessageView {
  id: string;
  direction: "in" | "out";
  channel: "dm" | "comment_public" | "comment_private";
  text: string | null;
  attachments: Array<{ type: string | null; url: string | null }>;
  authorName: string | null;
  via: "cliente" | "kapta" | "auto" | "nativo";
  sentByName: string | null;
  occurredAt: string;
  status: "ok" | "enviando" | "fallo";
  error: string | null;
}

type Result = { ok: true; notice?: string } | { ok: false; error: string };

interface ThreadRow {
  id: string; store_id: string | null; account_id: string; platform: string; kind: "dm" | "comment";
  external_id: string; post_id: string | null; last_inbound_at: string | null; private_reply_at: string | null; created_at: string;
  claimed_by: string | null; claimed_at: string | null;
}

/** La reserva de un hilo: 10 minutos, como «Tomar» en Leads (fase 2). */
const CLAIM_MS = 10 * 60_000;

function heldByOther(thread: Pick<ThreadRow, "claimed_by" | "claimed_at">, userId: string, now = Date.now()): boolean {
  const at = Date.parse(thread.claimed_at ?? "");
  return Boolean(thread.claimed_by && thread.claimed_by !== userId && Number.isFinite(at) && now - at < CLAIM_MS);
}

async function userName(userId: string): Promise<string> {
  const { data } = await createAdminSupabase().auth.admin.getUserById(userId);
  const meta = (data?.user?.user_metadata ?? {}) as { full_name?: string; name?: string };
  return meta.full_name ?? meta.name ?? data?.user?.email?.split("@")[0] ?? "otra asesora";
}

async function sessionThread(threadId: string): Promise<{ thread: ThreadRow; userId: string } | { error: string }> {
  const sb = await createServerSupabase();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return { error: "Tu sesión venció. Vuelve a entrar." };
  const { data } = await sb.from("social_threads")
    .select("id,store_id,account_id,platform,kind,external_id,post_id,last_inbound_at,private_reply_at,created_at,claimed_by,claimed_at")
    .eq("id", threadId).maybeSingle();
  if (!data) return { error: "No tienes acceso a esta conversación." };
  return { thread: data as ThreadRow, userId: user.id };
}

export async function getSocialThreadMessages(threadId: string): Promise<{ messages: SocialMessageView[] } | { error: string }> {
  const sb = await createServerSupabase();
  const { data, error } = await sb.from("social_messages")
    .select("id,direction,channel,text,attachments,author_name,via,sent_by,occurred_at,status,error")
    .eq("thread_id", threadId).order("occurred_at", { ascending: true }).limit(300);
  if (error) return { error: "No se pudieron leer los mensajes." };
  const rows = (data ?? []) as Array<Record<string, unknown>>;
  const senders = [...new Set(rows.map((r) => r.sent_by).filter((v): v is string => typeof v === "string"))];
  const names = new Map<string, string>();
  if (senders.length) {
    const admin = createAdminSupabase();
    for (const id of senders) {
      const { data: u } = await admin.auth.admin.getUserById(id);
      const meta = (u?.user?.user_metadata ?? {}) as { full_name?: string; name?: string };
      names.set(id, meta.full_name ?? meta.name ?? u?.user?.email?.split("@")[0] ?? "Asesora");
    }
  }
  return {
    messages: rows.map((r) => ({
      id: r.id as string,
      direction: r.direction as "in" | "out",
      channel: r.channel as SocialMessageView["channel"],
      text: (r.text as string | null) ?? null,
      attachments: Array.isArray(r.attachments) ? (r.attachments as SocialMessageView["attachments"]) : [],
      authorName: (r.author_name as string | null) ?? null,
      via: r.via as SocialMessageView["via"],
      sentByName: typeof r.sent_by === "string" ? names.get(r.sent_by) ?? null : null,
      occurredAt: r.occurred_at as string,
      status: r.status as SocialMessageView["status"],
      error: (r.error as string | null) ?? null,
    })),
  };
}

/**
 * Responde un hilo. `mode`: `dm` (mensaje directo), `public` (respuesta pública
 * al comentario) o `private` (al comentario por privado: una sola vez, 7 días).
 */
export async function replySocialThread(threadId: string, rawText: string, mode: "dm" | "public" | "private"): Promise<Result> {
  const text = rawText.trim();
  if (!text) return { ok: false, error: "Escribe la respuesta." };
  if (text.length > MAX_TEXT) return { ok: false, error: `La respuesta pasa de ${MAX_TEXT} caracteres.` };
  if (!zernioConfigured()) return { ok: false, error: "Falta conectar Zernio (ZERNIO_API_KEY en Vercel)." };
  const got = await sessionThread(threadId);
  if ("error" in got) return { ok: false, error: got.error };
  const { thread, userId } = got;
  const admin = createAdminSupabase();

  if (heldByOther(thread, userId)) return { ok: false, error: `La está atendiendo ${await userName(thread.claimed_by!)}. Se libera a los 10 minutos sin actividad.` };
  if (thread.kind === "dm" && mode !== "dm") return { ok: false, error: "En un mensaje directo se responde por el chat." };
  if (thread.kind === "comment" && mode === "dm") return { ok: false, error: "Elige si respondes en público o por privado." };

  let humanAgent = false;
  if (mode === "dm") {
    const window = dmReplyMode(thread.last_inbound_at);
    if (window === "cerrado") return { ok: false, error: "Pasaron más de 7 días desde su último mensaje: Meta no deja escribirle hasta que vuelva a escribir." };
    humanAgent = window === "humano";
  }
  if (mode === "private") {
    const { data: first } = await admin.from("social_messages").select("occurred_at").eq("thread_id", thread.id).eq("direction", "in").order("occurred_at").limit(1).maybeSingle();
    if (!privateReplyAllowed(thread, (first as { occurred_at: string } | null)?.occurred_at)) {
      return { ok: false, error: "Este comentario ya no admite respuesta por privado (ya se usó o pasaron 7 días)." };
    }
  }

  const res = await sendSocial(admin, thread, { text, mode, userId, via: "kapta", idempotencyKey: randomUUID(), humanAgent });
  // Responder renueva la reserva: la conversación sigue siendo de quien la atiende.
  await admin.from("social_threads").update({ claimed_by: userId, claimed_at: new Date().toISOString() }).eq("id", thread.id);
  revalidatePath(PATH);
  if (!res.ok) return { ok: false, error: res.error };
  return { ok: true, notice: mode === "private" ? "Enviado por privado." : "Enviado." };
}

/**
 * Abrir un hilo lo reserva 10 minutos para quien lo abrió (fase 2), como
 * «Tomar» en Leads: otra asesora lo ve con «Lo atiende …» y no puede responder.
 * Pasados los 10 minutos sin actividad, se libera solo.
 */
export async function claimSocialThread(threadId: string): Promise<{ ok: true; mine: boolean; heldBy: string | null; until: string | null } | { ok: false; error: string }> {
  const got = await sessionThread(threadId);
  if ("error" in got) return { ok: false, error: got.error };
  const { thread, userId } = got;
  if (heldByOther(thread, userId)) {
    return { ok: true, mine: false, heldBy: await userName(thread.claimed_by!), until: new Date(Date.parse(thread.claimed_at!) + CLAIM_MS).toISOString() };
  }
  const now = new Date();
  const admin = createAdminSupabase();
  // Solo si sigue libre (o es suyo): dos asesoras abriendo a la vez no se pisan.
  const { data } = await admin.from("social_threads").update({ claimed_by: userId, claimed_at: now.toISOString() })
    .eq("id", thread.id).or(`claimed_by.is.null,claimed_by.eq.${userId},claimed_at.lt.${new Date(now.getTime() - CLAIM_MS).toISOString()}`)
    .select("id");
  if (!data?.length) {
    // Otra asesora la tomó en el mismo instante: se dice quién (una sola relectura, sin bucle).
    const again = await sessionThread(threadId);
    if ("thread" in again && heldByOther(again.thread, userId)) {
      return { ok: true, mine: false, heldBy: await userName(again.thread.claimed_by!), until: new Date(Date.parse(again.thread.claimed_at!) + CLAIM_MS).toISOString() };
    }
    return { ok: false, error: "No se pudo reservar la conversación. Vuelve a abrirla." };
  }
  return { ok: true, mine: true, heldBy: null, until: new Date(now.getTime() + CLAIM_MS).toISOString() };
}

/** Cerrar (no necesita respuesta) o reabrir un hilo. */
export async function setSocialThreadStatus(threadId: string, status: "abierto" | "cerrado"): Promise<Result> {
  const got = await sessionThread(threadId);
  if ("error" in got) return { ok: false, error: got.error };
  const admin = createAdminSupabase();
  await admin.from("social_threads").update({ status, updated_at: new Date().toISOString() }).eq("id", got.thread.id);
  revalidatePath(PATH);
  return { ok: true };
}

/** La tienda de una cuenta conectada (para lo que no calzó solo por nombre). Pide «Tiendas». */
export async function setSocialAccountStore(accountId: string, storeId: string): Promise<Result> {
  const perms = await getMasterPermissions();
  if (!perms.can("stores.manage")) return { ok: false, error: "Solo quien gestiona las tiendas puede asignar la cuenta." };
  const admin = createAdminSupabase();
  const { error } = await admin.from("social_accounts").update({ store_id: storeId, updated_at: new Date().toISOString() }).eq("account_id", accountId);
  if (error) return { ok: false, error: "No se pudo asignar la tienda." };
  const { data: threads } = await admin.from("social_threads").select("id").eq("account_id", accountId);
  const ids = ((threads as { id: string }[] | null) ?? []).map((t) => t.id);
  await admin.from("social_threads").update({ store_id: storeId }).eq("account_id", accountId);
  for (let i = 0; i < ids.length; i += 200) await admin.from("social_messages").update({ store_id: storeId }).in("thread_id", ids.slice(i, i + 200));
  revalidatePath(PATH);
  return { ok: true, notice: "Cuenta asignada." };
}

/**
 * Trae de Zernio las cuentas y lo reciente que llegó antes del webhook: las
 * últimas conversaciones con sus mensajes y los últimos posts con comentarios.
 * Acotado (30 conversaciones y 15 posts por cuenta) para no pasar el límite de
 * Zernio; lo nuevo llega solo por el webhook. Pide «Tiendas».
 */
export async function syncZernioInbox(): Promise<Result> {
  const perms = await getMasterPermissions();
  if (!perms.can("stores.manage")) return { ok: false, error: "Solo quien gestiona las tiendas puede sincronizar las redes." };
  if (!zernioConfigured()) return { ok: false, error: "Falta conectar Zernio (ZERNIO_API_KEY en Vercel)." };
  const admin = createAdminSupabase();
  let conversations = 0;
  let comments = 0;
  try {
    const { accounts } = await zernio.listAccounts();
    const social = accounts.filter((a) => isSocialPlatform(a.platform?.toLowerCase()) && a.isActive !== false);
    for (const a of social) {
      const account = { accountId: a._id, platform: a.platform.toLowerCase(), username: a.username ?? null, displayName: a.displayName ?? null, profileId: a.profileId ?? null, pageId: a.pageId ?? null };
      await upsertSocialAccount(admin, account);
      const convs = await zernio.listConversations({ accountId: a._id, limit: 30 });
      for (const c of convs.data ?? []) {
        const msgs = await zernio.listMessages(c.id, a._id, { limit: 30 });
        for (const m of msgs.messages ?? []) {
          const direction = m.direction === "outgoing" ? "out" : "in";
          const ev: NormalizedDm = {
            kind: "dm", account,
            conversation: { externalId: c.id, participantId: c.participantId ?? null, name: c.participantName ?? null, username: null, picture: c.participantPicture ?? null },
            message: {
              externalId: m.id, direction, text: m.message ?? null,
              attachments: (m.attachments ?? []).map((x) => ({ type: x.type ?? null, url: x.url ?? null })),
              authorId: m.senderId ?? null, authorName: m.senderName ?? null, occurredAt: m.createdAt, via: direction === "in" ? "cliente" : "nativo",
            },
          };
          await applySocialEvent(admin, ev);
        }
        conversations++;
      }
      const posts = await zernio.listPostsWithComments({ accountId: a._id, limit: 15 });
      for (const p of posts.data ?? []) {
        const list = await zernio.listPostComments(p.id, a._id, { limit: 50 });
        for (const top of list.comments ?? []) {
          for (const cm of [top, ...(top.replies ?? [])]) {
            if (!cm.id) continue;
            const ev: NormalizedComment = {
              kind: "comment", account,
              post: { id: p.id, text: p.content ?? null, permalink: p.permalink ?? null, imageUrl: p.thumbnailUrl ?? null },
              comment: {
                id: cm.id, threadId: top.id, text: cm.message ?? null, authorId: cm.from?.id ?? null,
                authorName: cm.from?.name ?? cm.from?.username ?? null, authorUsername: cm.from?.username ?? null,
                isOwn: cm.from?.isOwner === true, occurredAt: cm.createdTime ?? p.createdTime ?? new Date().toISOString(), adId: null,
              },
            };
            await applySocialEvent(admin, ev);
          }
          comments++;
        }
      }
    }
  } catch (e) {
    revalidatePath(PATH);
    return { ok: false, error: e instanceof ZernioError ? `Zernio: ${e.message}` : `No se pudo sincronizar: ${e instanceof Error ? e.message : String(e)}` };
  }
  revalidatePath(PATH);
  return { ok: true, notice: `Sincronizado: ${conversations} conversaciones y ${comments} comentarios.` };
}

/**
 * «Sugerir con IA»: la respuesta que escribiría Claude Haiku 5.5 para este hilo,
 * sin mandarla (la asesora la revisa y la envía). Misma regla y mismo filtro que
 * lo automático (MOM §25.4 fase 4). Lo ve quien ve el hilo.
 */
export async function suggestSocialReply(threadId: string): Promise<{ ok: true; publicText: string | null; privateText: string | null } | { ok: false; error: string }> {
  if (!socialAiConfigured()) return { ok: false, error: "Falta la clave de la IA (ANTHROPIC_API_KEY en Vercel)." };
  const got = await sessionThread(threadId);
  if ("error" in got) return { ok: false, error: got.error };
  const admin = createAdminSupabase();
  const thread = await loadAutoThread(admin, threadId);
  if (!thread?.store_id) return { ok: false, error: "La conversación no tiene tienda." };
  const draft = await draftAiReply(admin, thread, await storeWhatsappPhone(admin, thread.store_id));
  if (draft === "sin_turno") return { ok: false, error: "Lo último ya lo respondió la tienda." };
  if (!draft) return { ok: false, error: "La IA no pudo responder ahora. Inténtalo otra vez o escribe la respuesta." };
  if (draft.skip) return { ok: false, error: "La IA no lo respondería: es solo emojis, una etiqueta o spam." };
  return { ok: true, publicText: draft.publicText, privateText: draft.privateText };
}

/**
 * «Responder pendientes con IA»: la IA contesta lo que está en «Por responder»
 * (comentarios en público y por privado; mensajes directos dentro de 24 h).
 * Pide «Tiendas». Ver `answerPendingWithAi`.
 */
export async function answerPendingSocialWithAi(): Promise<{ ok: true; result: PendingAiResult } | { ok: false; error: string }> {
  const perms = await getMasterPermissions();
  if (!perms.can("stores.manage")) return { ok: false, error: "Solo quien gestiona las tiendas puede responder lo pendiente con IA." };
  if (!socialAiConfigured()) return { ok: false, error: "Falta la clave de la IA (ANTHROPIC_API_KEY en Vercel)." };
  if (!zernioConfigured()) return { ok: false, error: "Falta conectar Zernio (ZERNIO_API_KEY en Vercel)." };
  const sb = await createServerSupabase();
  const { data: stores } = await sb.from("stores").select("id");
  const result = await answerPendingWithAi(createAdminSupabase(), ((stores as Array<{ id: string }> | null) ?? []).map((s) => s.id));
  revalidatePath(PATH);
  return { ok: true, result };
}

export interface SocialAutoSettingsView {
  storeId: string;
  enabled: boolean;
  keywords: string;
  publicText: string;
  privateText: string;
  dmText: string;
}

/** Guarda las respuestas automáticas de una tienda (fase 3). Pide «Tiendas». Vacío = el texto por defecto. */
export async function saveSocialAutoSettings(input: SocialAutoSettingsView): Promise<Result> {
  const perms = await getMasterPermissions();
  if (!perms.can("stores.manage")) return { ok: false, error: "Solo quien gestiona las tiendas cambia las respuestas automáticas." };
  const sb = await createServerSupabase();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return { ok: false, error: "Tu sesión venció. Vuelve a entrar." };
  const { data: store } = await sb.from("stores").select("id").eq("id", input.storeId).maybeSingle();
  if (!store) return { ok: false, error: "No tienes acceso a esa tienda." };
  const clean = (t: string, max: number) => t.trim().slice(0, max) || null;
  for (const [label, t] of [["público", input.publicText], ["privado", input.privateText], ["mensaje directo", input.dmText]] as const) {
    if (t.length > 640) return { ok: false, error: `El texto ${label} pasa de 640 caracteres.` };
  }
  const keywords = input.keywords.split(/[,\n]/).map((k) => k.trim()).filter(Boolean).slice(0, 80);
  const { error } = await createAdminSupabase().from("social_auto_settings").upsert({
    store_id: input.storeId, enabled: input.enabled, comment_keywords: keywords.length ? keywords : null,
    public_text: clean(input.publicText, 640), private_text: clean(input.privateText, 640), dm_text: clean(input.dmText, 640),
    updated_by: user.id, updated_at: new Date().toISOString(),
  }, { onConflict: "store_id" });
  if (error) return { ok: false, error: "No se pudo guardar." };
  revalidatePath(PATH);
  return { ok: true, notice: input.enabled ? "Respuestas automáticas encendidas." : "Respuestas automáticas apagadas." };
}
