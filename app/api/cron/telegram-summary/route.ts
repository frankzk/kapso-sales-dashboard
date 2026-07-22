import { NextResponse, type NextRequest } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { createAdminSupabase } from "@/lib/db";
import { getStoreCreds } from "@/lib/ingest";
import { buildStoreDailySummary, formatDailySummary, limaDayBounds } from "@/lib/daily-summary";
import { sendTelegramToAll } from "@/lib/telegram";
import { env } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const TZ = "America/Lima";

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
  const { date, startIso, endIso, label } = limaDayBounds(req.nextUrl.searchParams.get("date"));

  // Optionally target one store (?storeId=...), else all active stores.
  const single = req.nextUrl.searchParams.get("storeId");
  let storeIds: string[];
  if (single) {
    storeIds = [single];
  } else {
    const { data, error } = await admin.from("stores").select("id").eq("status", "active");
    if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    storeIds = (data ?? []).map((s: { id: string }) => s.id);
  }

  const reports = [];
  for (const id of storeIds) {
    try {
      const creds = await getStoreCreds(id, admin);
      if (!creds?.telegram_bot_token || !creds.telegram_chat_id) {
        reports.push({ storeId: id, skipped: "sin Telegram configurado" });
        continue;
      }
      const summary = await buildStoreDailySummary(admin, id, startIso, endIso, TZ);
      const text = formatDailySummary(creds.name, label, summary, creds.currency);
      const res = await sendTelegramToAll(creds.telegram_bot_token, creds.telegram_chat_id, text);
      const failed = res.results.filter((r) => !r.ok);
      reports.push({
        storeId: id,
        sent: res.sent,
        recipients: res.total,
        error: failed.length ? failed.map((r) => `${r.chatId}: ${r.error}`).join("; ") : undefined,
        orders: summary.totalOrders,
      });
    } catch (e) {
      reports.push({ storeId: id, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return NextResponse.json({ ok: true, date, stores: storeIds.length, reports });
}

export async function GET(req: NextRequest) {
  return run(req);
}
export async function POST(req: NextRequest) {
  return run(req);
}
