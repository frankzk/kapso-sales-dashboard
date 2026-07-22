import { NextResponse, type NextRequest } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { createAdminSupabase } from "@/lib/db";
import { getStoreCreds } from "@/lib/ingest";
import { runStorageBackup, formatBackupSummary } from "@/lib/backup";
import { parseTelegramChatIds, sendTelegramMessage } from "@/lib/telegram";
import { env } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Constant-time equality (length-gated) to avoid leaking the secret via timing. */
function secretEquals(provided: string | null, expected: string): boolean {
  if (!provided) return false;
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function authorized(req: NextRequest): boolean {
  const secret = env.cronSecret();
  // Vercel Cron sends `Authorization: Bearer <CRON_SECRET>` automatically.
  const bearer = req.headers.get("authorization");
  if (bearer?.startsWith("Bearer ") && secretEquals(bearer.slice(7), secret)) return true;
  return secretEquals(req.nextUrl.searchParams.get("secret"), secret);
}

async function run(req: NextRequest) {
  if (!authorized(req)) return new NextResponse("unauthorized", { status: 401 });
  const admin = createAdminSupabase();

  const report = await runStorageBackup(admin);

  // Best-effort Telegram ping so the team knows the backup ran (and hears about
  // any warning). Sent once per DISTINCT chat across active stores — several
  // stores often share one ops chat. A Telegram failure never fails the backup.
  const text = formatBackupSummary(report);
  const sentTo = new Set<string>();
  try {
    const { data } = await admin.from("stores").select("id").eq("status", "active");
    for (const s of (data ?? []) as { id: string }[]) {
      const creds = await getStoreCreds(s.id, admin);
      if (!creds?.telegram_bot_token || !creds.telegram_chat_id) continue;
      // Un campo de chat id puede listar varios destinatarios; dedup por chat
      // individual para no repetir el mismo aviso a un chat compartido entre
      // tiendas.
      for (const chatId of parseTelegramChatIds(creds.telegram_chat_id)) {
        if (sentTo.has(chatId)) continue;
        sentTo.add(chatId);
        await sendTelegramMessage(creds.telegram_bot_token, chatId, text);
      }
    }
  } catch {
    /* ignore — notifying is best-effort */
  }

  // Non-2xx on a failed/incomplete backup so Vercel's cron monitor flags it —
  // a second signal beyond the (best-effort) Telegram ping.
  return NextResponse.json(
    { ok: report.ok, notified: sentTo.size, report },
    { status: report.ok ? 200 : 500 },
  );
}

export async function GET(req: NextRequest) {
  return run(req);
}
export async function POST(req: NextRequest) {
  return run(req);
}
