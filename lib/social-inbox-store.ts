import "server-only";

// Guarda en Kapta lo que llega de Zernio (MOM §25.4): la cuenta, el hilo y el
// mensaje o comentario. Lo usan el webhook y la sincronización manual. Con el
// cliente de servicio: quien llama ya validó la firma o el acceso.

import type { SupabaseClient } from "@supabase/supabase-js";
import { matchStoreForAccount, threadStatusAfter, type NormalizedAccount, type NormalizedComment, type NormalizedDm, type NormalizedEvent } from "@/lib/social-inbox";

/** La fila de la cuenta, creada si no existía, con su tienda (la que ya tenía, o la que calza por nombre). */
export async function upsertSocialAccount(admin: SupabaseClient, account: NormalizedAccount, active = true): Promise<string | null> {
  const { data: current } = await admin.from("social_accounts").select("store_id").eq("account_id", account.accountId).maybeSingle();
  let storeId = (current as { store_id: string | null } | null)?.store_id ?? null;
  if (!storeId) {
    const { data: stores } = await admin.from("stores").select("id,name");
    storeId = matchStoreForAccount(account, (stores as { id: string; name: string }[] | null) ?? []);
  }
  const { error } = await admin.from("social_accounts").upsert({
    account_id: account.accountId,
    store_id: storeId,
    profile_id: account.profileId,
    platform: account.platform,
    username: account.username,
    display_name: account.displayName,
    page_id: account.pageId,
    active,
    updated_at: new Date().toISOString(),
  }, { onConflict: "account_id" });
  if (error) throw new Error(`No se pudo guardar la cuenta de Zernio: ${error.message}`);
  return storeId;
}

interface ThreadUpsert {
  store_id: string | null;
  account_id: string;
  platform: string;
  kind: "dm" | "comment";
  external_id: string;
  post_id?: string | null;
  post_text?: string | null;
  post_permalink?: string | null;
  post_image_url?: string | null;
  ad_id?: string | null;
  participant_id?: string | null;
  participant_name?: string | null;
  participant_username?: string | null;
  participant_picture?: string | null;
}

/** El hilo: creado si no existía; los datos de la persona y del post solo se completan, nunca se borran. */
async function upsertThread(admin: SupabaseClient, t: ThreadUpsert): Promise<string> {
  const { data: existing } = await admin.from("social_threads").select("id,store_id,participant_name,participant_username,participant_picture,post_text,post_permalink,post_image_url,ad_id,participant_id")
    .eq("account_id", t.account_id).eq("kind", t.kind).eq("external_id", t.external_id).maybeSingle();
  const now = new Date().toISOString();
  if (existing) {
    const e = existing as Record<string, string | null>;
    const patch: Record<string, unknown> = { updated_at: now };
    for (const k of ["participant_id", "participant_name", "participant_username", "participant_picture", "post_text", "post_permalink", "post_image_url", "ad_id"] as const) {
      const v = t[k];
      if (v && !e[k]) patch[k] = v;
    }
    if (!e.store_id && t.store_id) patch.store_id = t.store_id;
    await admin.from("social_threads").update(patch).eq("id", e.id!);
    return e.id!;
  }
  const { data, error } = await admin.from("social_threads").upsert({ ...t, created_at: now, updated_at: now }, { onConflict: "account_id,kind,external_id" }).select("id").single();
  if (error || !data) throw new Error(`No se pudo guardar el hilo: ${error?.message ?? "sin fila"}`);
  return (data as { id: string }).id;
}

interface MessageInsert {
  thread_id: string;
  store_id: string | null;
  direction: "in" | "out";
  channel: "dm" | "comment_public" | "comment_private";
  external_id: string | null;
  text: string | null;
  attachments?: unknown;
  author_id?: string | null;
  author_name?: string | null;
  sent_by?: string | null;
  via: "cliente" | "kapta" | "auto" | "nativo";
  occurred_at: string;
  idempotency_key?: string | null;
  status?: "ok" | "enviando" | "fallo";
  error?: string | null;
}

/** Inserta el mensaje una sola vez (por hilo y id externo). Devuelve false si ya estaba. */
export async function insertSocialMessage(admin: SupabaseClient, m: MessageInsert): Promise<boolean> {
  if (m.external_id) {
    const { data } = await admin.from("social_messages").select("id").eq("thread_id", m.thread_id).eq("external_id", m.external_id).maybeSingle();
    if (data) return false;
  }
  const { error } = await admin.from("social_messages").insert({ attachments: [], ...m });
  if (error) {
    if (error.code === "23505") return false;
    throw new Error(`No se pudo guardar el mensaje: ${error.message}`);
  }
  return true;
}

/** Recalcula el resumen del hilo desde sus mensajes: lo último, lo último de la clienta y si espera respuesta. */
export async function refreshThreadSummary(admin: SupabaseClient, threadId: string): Promise<void> {
  const { data } = await admin.from("social_messages").select("direction,text,occurred_at,attachments")
    .eq("thread_id", threadId).neq("status", "fallo").order("occurred_at", { ascending: false }).limit(200);
  const rows = (data as Array<{ direction: "in" | "out"; text: string | null; occurred_at: string; attachments: unknown[] | null }> | null) ?? [];
  if (!rows.length) return;
  const last = rows[0]!;
  const lastIn = rows.find((r) => r.direction === "in");
  const unread = rows.findIndex((r) => r.direction === "out");
  const pendingIn = unread === -1 ? rows.length : unread;
  const { data: thread } = await admin.from("social_threads").select("status").eq("id", threadId).maybeSingle();
  const status = (thread as { status: string } | null)?.status ?? "abierto";
  await admin.from("social_threads").update({
    last_message_at: last.occurred_at,
    last_message_text: last.text ?? ((last.attachments?.length ?? 0) > 0 ? "[adjunto]" : null),
    last_direction: last.direction,
    last_inbound_at: lastIn?.occurred_at ?? null,
    unread: pendingIn,
    // Un mensaje nuevo de la clienta reabre el hilo; uno nuestro lo deja respondido; lo de +7 días entra resuelto.
    status: threadStatusAfter(status as "abierto" | "respondido" | "cerrado", { direction: last.direction, occurredAt: last.occurred_at }),
    updated_at: new Date().toISOString(),
  }).eq("id", threadId);
}

async function applyDm(admin: SupabaseClient, ev: NormalizedDm): Promise<string> {
  const storeId = await upsertSocialAccount(admin, ev.account);
  const threadId = await upsertThread(admin, {
    store_id: storeId, account_id: ev.account.accountId, platform: ev.account.platform, kind: "dm", external_id: ev.conversation.externalId,
    participant_id: ev.conversation.participantId, participant_name: ev.conversation.name, participant_username: ev.conversation.username, participant_picture: ev.conversation.picture,
  });
  await insertSocialMessage(admin, {
    thread_id: threadId, store_id: storeId, direction: ev.message.direction, channel: "dm", external_id: ev.message.externalId,
    text: ev.message.text, attachments: ev.message.attachments, author_id: ev.message.authorId, author_name: ev.message.authorName,
    via: ev.message.via, occurred_at: ev.message.occurredAt,
  });
  await refreshThreadSummary(admin, threadId);
  return threadId;
}

async function applyComment(admin: SupabaseClient, ev: NormalizedComment): Promise<string> {
  const storeId = await upsertSocialAccount(admin, ev.account);
  const own = ev.comment.isOwn;
  const threadId = await upsertThread(admin, {
    store_id: storeId, account_id: ev.account.accountId, platform: ev.account.platform, kind: "comment", external_id: ev.comment.threadId,
    post_id: ev.post.id, post_text: ev.post.text, post_permalink: ev.post.permalink, post_image_url: ev.post.imageUrl, ad_id: ev.comment.adId,
    // La persona del hilo es quien hizo el comentario principal; una respuesta nuestra no la cambia.
    ...(own ? {} : { participant_id: ev.comment.authorId, participant_name: ev.comment.authorName, participant_username: ev.comment.authorUsername }),
  });
  await insertSocialMessage(admin, {
    thread_id: threadId, store_id: storeId, direction: own ? "out" : "in", channel: "comment_public", external_id: ev.comment.id,
    text: ev.comment.text, author_id: ev.comment.authorId, author_name: ev.comment.authorName,
    via: own ? "nativo" : "cliente", occurred_at: ev.comment.occurredAt,
  });
  await refreshThreadSummary(admin, threadId);
  return threadId;
}

/** Aplica un aviso ya leído. Devuelve el hilo tocado, o null si era de la cuenta. */
export async function applySocialEvent(admin: SupabaseClient, ev: NormalizedEvent): Promise<string | null> {
  if (ev.kind === "account") {
    await upsertSocialAccount(admin, ev.account, ev.active);
    return null;
  }
  return ev.kind === "dm" ? applyDm(admin, ev) : applyComment(admin, ev);
}
