// Vigía del buzón (lib/inbox-watch.ts): tres veces al día mira cuándo llegó lo
// último de Yape y de Olva y, si alguna fuente está callada más de lo normal,
// avisa por el Telegram de las tiendas (una vez por chat, como la copia de
// seguridad). Solo lee; lo único que escribe es el aviso.
//
//   ?dry=1   contesta el estado sin mandar nada.

import { NextResponse, type NextRequest } from "next/server";
import { createAdminSupabase } from "@/lib/db";
import { getStoreCreds } from "@/lib/ingest";
import { formatInboxAlert, inboxStatus } from "@/lib/inbox-watch";
import { parseTelegramChatIds, sendTelegramMessage } from "@/lib/telegram";
import { internalAuthorized } from "@/lib/voice-recovery-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function latest(admin: ReturnType<typeof createAdminSupabase>, table: string, apply?: (q: any) => any): Promise<string | null> {
  let q = admin.from(table).select("created_at").order("created_at", { ascending: false }).limit(1);
  if (apply) q = apply(q);
  const { data, error } = await q;
  if (error) throw new Error(`${table}: ${error.message}`);
  return ((data ?? [])[0] as { created_at?: string } | undefined)?.created_at ?? null;
}

export async function GET(req: NextRequest) {
  if (!internalAuthorized(req)) return new NextResponse("unauthorized", { status: 401 });
  const dryRun = req.nextUrl.searchParams.get("dry") === "1";
  const admin = createAdminSupabase();

  let statuses;
  try {
    // Los recruces de cada media hora (§16.2) no son correos: no cuentan.
    const yape = await latest(admin, "yape_statement_imports", (q) => q.not("message_id", "like", "recruce:%"));
    const olva = await latest(admin, "olva_email_labels");
    statuses = inboxStatus({ yape, olva }, new Date());
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }

  const text = formatInboxAlert(statuses);
  const sentTo = new Set<string>();
  if (text && !dryRun) {
    try {
      const { data } = await admin.from("stores").select("id").eq("status", "active");
      for (const s of (data ?? []) as { id: string }[]) {
        const creds = await getStoreCreds(s.id, admin);
        if (!creds?.telegram_bot_token || !creds.telegram_chat_id) continue;
        for (const chatId of parseTelegramChatIds(creds.telegram_chat_id)) {
          if (sentTo.has(chatId)) continue;
          sentTo.add(chatId);
          await sendTelegramMessage(creds.telegram_bot_token, chatId, text);
        }
      }
    } catch {
      /* avisar es lo mejor que se puede: un Telegram caído no tumba la revisión */
    }
  }

  const stale = statuses.filter((s) => s.stale).map((s) => s.source);
  console.log("[inbox-watch]", JSON.stringify({ dryRun, stale, notified: sentTo.size }));
  // Con una fuente callada, un 503 para que el monitor de crons de Vercel también lo marque.
  return NextResponse.json(
    { ok: stale.length === 0, dryRun, statuses, notified: sentTo.size },
    { status: stale.length ? 503 : 200 },
  );
}
