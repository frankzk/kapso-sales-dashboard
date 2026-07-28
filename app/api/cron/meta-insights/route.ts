import { timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { createAdminSupabase } from "@/lib/db";
import { env } from "@/lib/env";
import { getStoreCreds } from "@/lib/ingest";
import { metaInsightsRange, syncMetaInsightsHistory } from "@/lib/meta-insights-sync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

function secretEquals(provided: string | null, expected: string): boolean {
  if (!provided) return false;
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

function authorized(req: NextRequest): boolean {
  const secret = env.cronSecret();
  const bearer = req.headers.get("authorization");
  if (bearer?.startsWith("Bearer ") && secretEquals(bearer.slice(7), secret)) return true;
  return secretEquals(req.nextUrl.searchParams.get("secret"), secret);
}

async function run(req: NextRequest) {
  if (!authorized(req)) return new NextResponse("unauthorized", { status: 401 });
  const admin = createAdminSupabase();
  const requestedStore = req.nextUrl.searchParams.get("storeId");
  const daysParam = Number(req.nextUrl.searchParams.get("days"));

  let storeIds: string[];
  if (requestedStore) {
    storeIds = [requestedStore];
  } else {
    const { data, error } = await admin.from("stores").select("id").eq("status", "active");
    if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    storeIds = (data ?? []).map((row: { id: string }) => row.id);
  }

  const reports = [];
  for (const storeId of storeIds) {
    const creds = await getStoreCreds(storeId, admin);
    if (!creds?.meta_access_token || !creds.meta_ad_accounts.length) {
      reports.push({ storeId, skipped: true, reason: "Meta no configurado" });
      continue;
    }
    const { data: state } = await admin
      .from("sync_state")
      .select("cursor")
      .eq("store_id", storeId)
      .eq("source", "meta_insights")
      .maybeSingle();
    // Primera ejecución: 90 días. Después: reescribe los últimos 3 para
    // capturar atribución tardía y correcciones que Meta hace retroactivamente.
    const days = Number.isFinite(daysParam) && daysParam > 0
      ? Math.min(365, Math.trunc(daysParam))
      : state?.cursor
        ? 3
        : 90;
    reports.push(
      await syncMetaInsightsHistory(
        admin,
        storeId,
        creds.meta_access_token,
        creds.meta_ad_accounts,
        metaInsightsRange(days),
      ),
    );
  }
  return NextResponse.json({ ok: true, stores: storeIds.length, reports });
}

export async function GET(req: NextRequest) {
  return run(req);
}

export async function POST(req: NextRequest) {
  return run(req);
}
