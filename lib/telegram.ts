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
