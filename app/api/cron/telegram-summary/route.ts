import { NextResponse, type NextRequest } from "next/server";
import { createAdminSupabase } from "@/lib/db";
import { getStoreCreds } from "@/lib/ingest";
import { buildStoreDailySummary, formatDailySummary, limaDayBounds } from "@/lib/daily-summary";
import { sendTelegramMessage } from "@/lib/telegram";
import { env } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const TZ = "America/Lima";

function authorized(req: NextRequest): boolean {
  const secret = env.cronSecret();
  // Vercel Cron sends `Authorization: Bearer <CRON_SECRET>` automatically.
  if (req.headers.get("authorization") === `Bearer ${secret}`) return true;
  return req.nextUrl.searchParams.get("secret") === secret;
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
      const res = await sendTelegramMessage(creds.telegram_bot_token, creds.telegram_chat_id, text);
      reports.push({ storeId: id, sent: res.ok, error: res.ok ? undefined : res.error, orders: summary.totalOrders });
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
