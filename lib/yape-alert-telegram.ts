// Telegram alert for unattended Yapes/Shalom. The advisor rotation (v2) is
// poll-driven, so when nobody is connected (e.g. the madrugada) nothing advances
// it. This server-side cron step catches that: it pings the store's Telegram
// channel — the SAME one used for the 8am daily summary — when a Yape has been
// waiting too long without anyone taking it, with a dedup so it doesn't spam.

import type { SupabaseClient } from "@supabase/supabase-js";
import { CLAIM_TTL_MINUTES } from "@/lib/leads";
import { getStoreCreds } from "@/lib/ingest";
import { sendTelegramToAll } from "@/lib/telegram";

export const YAPE_PENDING_MIN = 10; // sin tomar por > este tiempo → alerta
export const YAPE_REALERT_MIN = 180; // re-alerta a lo más cada 3h mientras siga pendiente

export interface UnattendedYapeRow {
  id: string;
  name: string | null;
  phone: string;
  waitingSinceMs: number; // ≈ cuando el cliente mandó el Yape (último inbound)
  claimedFresh: boolean; // alguien la está atendiendo (claim vigente)
  alertSentAtMs: number | null;
}

/** Pure: which pending Yapes need a Telegram alert right now (threshold + dedup). */
export function selectUnattendedYapes(
  rows: UnattendedYapeRow[],
  nowMs: number,
  pendingMin = YAPE_PENDING_MIN,
  realertMin = YAPE_REALERT_MIN,
): UnattendedYapeRow[] {
  const pendingMs = pendingMin * 60_000;
  const realertMs = realertMin * 60_000;
  return rows.filter((r) => {
    if (r.claimedFresh) return false; // alguien la tiene
    if (nowMs - r.waitingSinceMs < pendingMs) return false; // aún no espera lo suficiente
    if (r.alertSentAtMs != null && nowMs - r.alertSentAtMs < realertMs) return false; // ya avisado hace poco
    return true;
  });
}

const esc = (x: string) => x.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Telegram HTML for the batch of unattended Yapes of one store. */
export function formatUnattendedYapeAlert(
  storeName: string,
  rows: UnattendedYapeRow[],
  nowMs: number,
): string {
  const n = rows.length;
  const lines = [`🔥 <b>${esc(storeName)}</b> — ${n} Yape/Shalom sin atender`, ""];
  for (const r of rows) {
    const mins = Math.max(1, Math.floor((nowMs - r.waitingSinceMs) / 60_000));
    lines.push(`• ${esc(r.name || r.phone)} · <code>+${esc(r.phone)}</code> · hace ${mins} min`);
  }
  lines.push("");
  lines.push("Nadie lo ha tomado. Entra al panel para verificarlo.");
  return lines.join("\n");
}

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Find unattended Yapes for a store, ping its Telegram channel, and mark them as
 * alerted. Best-effort: skips silently when the store has no Telegram configured.
 */
export async function alertUnattendedYapes(
  storeId: string,
  admin: SupabaseClient,
  nowMs: number = Date.now(),
): Promise<{ alerted: number; skipped?: string }> {
  const creds = await getStoreCreds(storeId, admin);
  if (!creds?.telegram_bot_token || !creds.telegram_chat_id) return { alerted: 0, skipped: "sin Telegram" };

  const claimCutoff = new Date(nowMs - CLAIM_TTL_MINUTES * 60_000).toISOString();
  const { data } = await admin
    .from("leads")
    .select("id, name, phone, last_inbound_at, last_interaction_at, created_at, claimed_by, claimed_at, yape_alert_sent_at")
    .eq("store_id", storeId)
    .eq("status", "yape_por_verificar")
    .eq("has_order", false);
  const rows: UnattendedYapeRow[] = ((data as any[]) ?? []).map((r) => ({
    id: r.id as string,
    name: (r.name as string | null) ?? null,
    phone: r.phone as string,
    waitingSinceMs: new Date((r.last_inbound_at ?? r.last_interaction_at ?? r.created_at) as string).getTime(),
    claimedFresh:
      !!r.claimed_by && typeof r.claimed_at === "string" && r.claimed_at >= claimCutoff,
    alertSentAtMs: r.yape_alert_sent_at ? new Date(r.yape_alert_sent_at as string).getTime() : null,
  }));

  const due = selectUnattendedYapes(rows, nowMs);
  if (!due.length) return { alerted: 0 };

  const text = formatUnattendedYapeAlert(creds.name, due, nowMs);
  const res = await sendTelegramToAll(creds.telegram_bot_token, creds.telegram_chat_id, text);
  // Solo marcamos como avisadas si al menos un destinatario recibió la alerta;
  // si ninguno llegó, se reintenta en el próximo ciclo.
  if (!res.sent) return { alerted: 0, skipped: res.results[0]?.error ?? "sin destinatarios" };

  await admin
    .from("leads")
    .update({ yape_alert_sent_at: new Date(nowMs).toISOString() })
    .in(
      "id",
      due.map((r) => r.id),
    );
  return { alerted: due.length };
}
