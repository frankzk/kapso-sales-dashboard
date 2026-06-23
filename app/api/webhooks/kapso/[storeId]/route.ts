import { NextResponse, type NextRequest } from "next/server";
import { createAdminSupabase } from "@/lib/db";
import { applyHandoff } from "@/lib/leads-ingest";
import { env } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Kapso platform webhook for `workflow.execution.handoff` → hot lead.
// Configure the URL in Kapso as:
//   {SITE}/api/webhooks/kapso/<storeId>?secret=<CRON_SECRET>

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ storeId: string }> },
) {
  const { storeId } = await ctx.params;
  if (req.nextUrl.searchParams.get("secret") !== env.cronSecret()) {
    return new NextResponse("unauthorized", { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid json" }, { status: 400 });
  }

  try {
    const admin = createAdminSupabase();
    const res = await applyHandoff(admin, storeId, body);
    return NextResponse.json(res);
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "error" },
      { status: 500 },
    );
  }
}

// Some providers ping with GET to validate the endpoint.
export async function GET(req: NextRequest) {
  if (req.nextUrl.searchParams.get("secret") !== env.cronSecret()) {
    return new NextResponse("unauthorized", { status: 401 });
  }
  return NextResponse.json({ ok: true });
}
