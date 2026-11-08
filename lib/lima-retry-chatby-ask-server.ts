import "server-only";

// Kapta pide la ubicación por WhatsApp para un reintento Aliclik de Lima sin
// ninguna (MOM §9.5; owner, 08-11-2026; 0323). La parte con red y base; la
// regla está en lib/lima-retry-chatby-ask.ts. Su propio archivo: la
// confirmación por Chatby (lib/chatby-autoconfirm-server.ts) tiene contadas sus
// lecturas y envíos.
//
// EL ORDEN. Leer su conversación (la misma de `chatbyRetryPin`, en caché un
// minuto) y los mensajes del pedido; decidir; poner la marca
// (`lima_retry_chatby_asks`, una por pedido y episodio: si ya está, no se
// manda); mandar el texto y pausar el bot (`sendChatbyReply`); dejar el hecho
// `chatby_message`. Si Chatby no deja mandarlo, la marca se borra y se vuelve a
// intentar en la pasada siguiente. Nunca lanza.

import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchChatbyConversation, forgetChatbyConversation, sendChatbyReply } from "@/lib/chatby-api";
import { CHATBY_SOURCE } from "@/lib/chatby-autoconfirm";
import { CHATBY_REPLY_PAUSE_MINUTES } from "@/lib/chatby-conversation";
import { recomputeOrderMasterSafe } from "@/lib/order-master";
import {
  RETRY_ASK_DETAIL,
  RETRY_ASK_PURPOSE,
  RETRY_ASK_REASON,
  RETRY_ASK_SKIP_LABEL,
  retryAskDecision,
  retryAskMessage,
  type RetryAskEvent,
  type RetryAskMode,
} from "@/lib/lima-retry-chatby-ask";

export const RETRY_ASK_TABLE = "lima_retry_chatby_asks";

export interface RetryAskOrder {
  order_id: string;
  store_id: string;
  order_name?: string | null;
  customer_name?: string | null;
  customer_phone?: string | null;
}

export type RetryAskResult =
  | { outcome: "pedida"; detail: string }
  | { outcome: "simulada"; detail: string }
  | { outcome: "omitida"; detail: string }
  | { outcome: "error"; detail: string };

function missing(error: { code?: string | null; message?: string | null } | null | undefined): boolean {
  if (!error) return false;
  return ["42P01", "42703", "PGRST205", "PGRST204"].includes(error.code ?? "") || /does not exist|could not find/i.test(error.message ?? "");
}

/**
 * Pide (o simula pedir) la ubicación de un reintento de Lima que llegó a «Sin
 * ubicación». `mode` es el interruptor de la organización; con `dry` (la vista
 * previa del panel) nunca manda. `null` si está en Apagado: el log no dice nada.
 */
export async function askRetryLocation(
  admin: SupabaseClient,
  input: {
    orgId: string;
    row: RetryAskOrder;
    /** El intento que falló: desde cuándo cuenta «una vez». */
    episodeAt: string;
    attempt: number;
    of: number;
    mode: RetryAskMode;
    apiKey: string;
    dry: boolean;
    now?: Date;
    fetchImpl?: typeof fetch;
  },
): Promise<RetryAskResult | null> {
  const { row, mode } = input;
  if (mode === "apagado") return null;
  const skipped = (why: string): RetryAskResult => ({ outcome: "omitida", detail: RETRY_ASK_DETAIL.skipped(why) });
  const failed = (why: string): RetryAskResult => ({ outcome: "error", detail: RETRY_ASK_DETAIL.skipped(why) });
  try {
    if (!input.apiKey) return skipped("falta la clave de Chatby (CHATBY_API_KEY)");
    if (!Number.isFinite(Date.parse(input.episodeAt))) return skipped("no se sabe cuándo falló el intento");
    const conversation = await fetchChatbyConversation({ phone: row.customer_phone, apiKey: input.apiKey, fetchImpl: input.fetchImpl });
    if (conversation.status !== "ok") return skipped(RETRY_ASK_SKIP_LABEL.sin_conversacion);

    const { data: events, error: eventsError } = await admin
      .from("order_events")
      .select("actor,note,payload,occurred_at")
      .eq("order_id", row.order_id)
      .eq("kind", "chatby_message");
    if (eventsError) return failed("no se pudo leer la Actividad del pedido");
    const now = input.now ?? new Date();
    const decision = retryAskDecision({
      mode,
      episodeStart: input.episodeAt,
      messages: conversation.messages,
      events: (events ?? []) as RetryAskEvent[],
      now,
    });
    if (!decision.send) return skipped(RETRY_ASK_SKIP_LABEL[decision.skip]);
    if (decision.simulate || input.dry) return { outcome: "simulada", detail: RETRY_ASK_DETAIL.simulated };

    // La marca ANTES de mandar: el único (pedido, episodio) es el candado.
    const { data: mark, error: markError } = await admin
      .from(RETRY_ASK_TABLE)
      .insert({ org_id: input.orgId, store_id: row.store_id, order_id: row.order_id, episode_at: input.episodeAt, status: "enviando" })
      .select("id")
      .maybeSingle();
    if (markError) {
      if (markError.code === "23505") return skipped(RETRY_ASK_SKIP_LABEL.ya_pedida);
      if (missing(markError)) return skipped("falta la migración 0323 en la base de datos");
      return failed("no se pudo poner la marca");
    }
    const markId = (mark as { id?: number | string } | null)?.id ?? null;

    const text = retryAskMessage({ customerName: row.customer_name ?? conversation.name, orderName: row.order_name });
    const sent = await sendChatbyReply({
      userNs: conversation.userNs,
      text,
      apiKey: input.apiKey,
      pauseMinutes: CHATBY_REPLY_PAUSE_MINUTES,
      fetchImpl: input.fetchImpl,
    });
    forgetChatbyConversation(row.customer_phone);
    if (sent.status === "error") {
      // No salió: sin marca, la pasada siguiente lo vuelve a intentar. Si no se
      // puede borrar, queda y no se repite (nunca dos mensajes).
      if (markId != null) await admin.from(RETRY_ASK_TABLE).delete().eq("id", markId);
      return failed(sent.message);
    }
    const at = new Date().toISOString();
    if (markId != null) await admin.from(RETRY_ASK_TABLE).update({ status: "enviado", updated_at: at }).eq("id", markId);
    const { error: eventError } = await admin.from("order_events").insert({
      store_id: row.store_id,
      order_id: row.order_id,
      kind: "chatby_message",
      occurred_at: at,
      actor: null,
      source: CHATBY_SOURCE,
      reason: RETRY_ASK_REASON,
      note: text,
      payload: {
        auto: true,
        purpose: RETRY_ASK_PURPOSE,
        attempt: input.attempt,
        of: input.of,
        episode_at: input.episodeAt,
        paused_minutes: sent.paused ? CHATBY_REPLY_PAUSE_MINUTES : 0,
      },
    });
    await recomputeOrderMasterSafe(admin, [row.order_id]);
    return {
      outcome: "pedida",
      detail: eventError ? `${RETRY_ASK_DETAIL.sent} (Sin anotar en la Actividad: ${eventError.message}.)` : RETRY_ASK_DETAIL.sent,
    };
  } catch (e) {
    return failed(e instanceof Error ? e.message : String(e));
  }
}
