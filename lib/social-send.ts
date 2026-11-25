import "server-only";

// Un envío de Leads → Redes por Zernio (MOM §25.4), el de una asesora o el
// automático. Primero deja la fila «enviando» con su llave de idempotencia (única
// en `social_messages`: la misma llave no se manda dos veces, ni aunque Zernio
// reintente el aviso), después llama a Zernio y la deja «ok» o «fallo».

import type { SupabaseClient } from "@supabase/supabase-js";
import { refreshThreadSummary } from "@/lib/social-inbox-store";
import { zernio, ZernioError } from "@/lib/zernio";

export interface SendableThread {
  id: string;
  store_id: string | null;
  account_id: string;
  kind: "dm" | "comment";
  external_id: string;
  post_id: string | null;
}

export type SendMode = "dm" | "public" | "private";

/** Lo que dice la pantalla cuando Zernio o Meta rechazan un envío. */
export function sendErrorText(e: unknown): string {
  if (e instanceof ZernioError) {
    const details = (e.details ?? {}) as { privateReplyConsumed?: boolean };
    if (details.privateReplyConsumed) return "Ese comentario ya usó su única respuesta por privado. Contesta en público o en el chat.";
    if (e.code === "not_thread_owner") return "Otra app tiene esta conversación (la bandeja de Meta). En Meta Business Suite pon a Zernio como app principal de las conversaciones.";
    if (e.code === "message_allowance_exceeded") return "Se acabaron los 10,000 mensajes gratis del mes en Zernio: agrega una tarjeta en Zernio.";
    if (e.code === "not_configured") return e.message;
    if (e.status === 429) return "Zernio pidió esperar unos segundos. Vuelve a intentarlo.";
    return `Zernio no lo envió: ${e.message}`;
  }
  return `No se pudo enviar: ${e instanceof Error ? e.message : String(e)}`;
}

export async function sendSocial(admin: SupabaseClient, thread: SendableThread, input: {
  text: string;
  mode: SendMode;
  /** La asesora; null en lo automático. */
  userId: string | null;
  via: "kapta" | "auto";
  idempotencyKey: string;
  /** Mensaje directo entre 24 h y 7 días: solo lo escrito por una persona. */
  humanAgent?: boolean;
}): Promise<{ ok: true } | { ok: false; error: string; duplicate?: boolean }> {
  const channel = input.mode === "dm" ? "dm" : input.mode === "public" ? "comment_public" : "comment_private";
  const { data: pending, error: pendingError } = await admin.from("social_messages").insert({
    thread_id: thread.id, store_id: thread.store_id, direction: "out", channel, external_id: null, text: input.text,
    sent_by: input.userId, via: input.via, occurred_at: new Date().toISOString(), idempotency_key: input.idempotencyKey, status: "enviando",
  }).select("id").single();
  if (pendingError || !pending) {
    if (pendingError?.code === "23505") return { ok: false, error: "Ya se envió.", duplicate: true };
    return { ok: false, error: "No se pudo registrar la respuesta." };
  }
  const rowId = (pending as { id: string }).id;
  try {
    let externalId: string | null = null;
    if (input.mode === "dm") {
      const res = await zernio.sendMessage(thread.external_id, { accountId: thread.account_id, message: input.text, humanAgent: input.humanAgent }, input.idempotencyKey);
      externalId = res.data?.messageId ?? res.data?.messageIds?.[0] ?? null;
    } else {
      if (!thread.post_id) throw new Error("El comentario no tiene su post: sincroniza las redes y vuelve a intentarlo.");
      if (input.mode === "public") {
        const res = await zernio.replyToComment(thread.post_id, { accountId: thread.account_id, commentId: thread.external_id, message: input.text }, input.idempotencyKey);
        externalId = res.data?.commentId ?? null;
      } else {
        // Se marca ANTES de llamar: el privado es uno solo y Zernio no acepta llave aquí.
        await admin.from("social_threads").update({ private_reply_at: new Date().toISOString() }).eq("id", thread.id);
        const res = await zernio.privateReply(thread.post_id, thread.external_id, { accountId: thread.account_id, message: input.text });
        externalId = res.messageId ?? null;
      }
    }
    // Si el aviso de Zernio de este mismo envío llegó antes, ya hay una fila con ese id: la nuestra queda sin id.
    const { error: upErr } = await admin.from("social_messages").update({ status: "ok", external_id: externalId }).eq("id", rowId);
    if (upErr) await admin.from("social_messages").update({ status: "ok" }).eq("id", rowId);
  } catch (e) {
    const message = sendErrorText(e);
    await admin.from("social_messages").update({ status: "fallo", error: message }).eq("id", rowId);
    const consumed = e instanceof ZernioError && (e.details as { privateReplyConsumed?: boolean } | null)?.privateReplyConsumed;
    // Un privado que Meta no aceptó por otra razón se puede volver a intentar; uno ya gastado, no.
    if (input.mode === "private" && !consumed) await admin.from("social_threads").update({ private_reply_at: null }).eq("id", thread.id);
    await refreshThreadSummary(admin, thread.id);
    return { ok: false, error: message };
  }
  await refreshThreadSummary(admin, thread.id);
  return { ok: true };
}
