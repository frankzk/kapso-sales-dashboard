// Telegram Bot API — minimal client to push the daily sales summary to a store's
// configured chat. No SDK/deps; never throws (HTTP/network errors come back as
// { ok:false }).

export interface TelegramSendResult {
  ok: boolean;
  error?: string;
}

/** Send an HTML message to a Telegram chat via the Bot API. */
export async function sendTelegramMessage(
  botToken: string,
  chatId: string,
  text: string,
  opts: { fetchImpl?: typeof fetch } = {},
): Promise<TelegramSendResult> {
  const doFetch = opts.fetchImpl ?? fetch;
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  let res: Response;
  try {
    res = await doFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
    });
  } catch (e: any) {
    return { ok: false, error: e?.message ?? "network error" };
  }
  const json: any = await res.json().catch(() => null);
  if (!res.ok || (json && json.ok === false)) {
    return { ok: false, error: json?.description ?? `HTTP ${res.status}` };
  }
  return { ok: true };
}

/** Escape user-provided text for Telegram's HTML parse mode. */
export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Parse a chat-id field into individual recipients. The stored value may hold
 * several ids separated by commas / spaces / newlines so a single store can
 * notify more than one chat (e.g. the ops group + a personal Telegram). Accepts
 * numeric ids (users or groups, optionally negative) and @usernames; anything
 * else is dropped. Deduplicated, original order preserved. Pure.
 */
export function parseTelegramChatIds(raw: string | null | undefined): string[] {
  if (!raw) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const tok of raw.split(/[\s,;]+/)) {
    const t = tok.trim();
    if (!t) continue;
    if (!/^-?\d+$/.test(t) && !/^@[A-Za-z0-9_]+$/.test(t)) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

export interface TelegramFanoutResult {
  sent: number; // cuántos destinatarios recibieron el mensaje
  total: number; // destinatarios válidos en el campo
  results: { chatId: string; ok: boolean; error?: string }[];
}

/** Send the same message to every recipient encoded in a chat-id field.
 *  Best-effort: never throws; one chat failing doesn't stop the rest. */
export async function sendTelegramToAll(
  botToken: string,
  chatIdsRaw: string | null | undefined,
  text: string,
  opts: { fetchImpl?: typeof fetch } = {},
): Promise<TelegramFanoutResult> {
  const ids = parseTelegramChatIds(chatIdsRaw);
  const results: TelegramFanoutResult["results"] = [];
  let sent = 0;
  for (const chatId of ids) {
    const r = await sendTelegramMessage(botToken, chatId, text, opts);
    if (r.ok) sent += 1;
    results.push({ chatId, ok: r.ok, error: r.error });
  }
  return { sent, total: ids.length, results };
}
