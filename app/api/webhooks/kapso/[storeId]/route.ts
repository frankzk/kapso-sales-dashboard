import { NextResponse, type NextRequest } from "next/server";
import { createAdminSupabase } from "@/lib/db";
import { applyHandoff, ingestConversationEvent } from "@/lib/leads-ingest";
import { classifyKapsoEvent } from "@/lib/kapso";
import { env } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Single Kapso webhook receiver for a store. Handles both of Kapso's webhook
// systems pointed at this URL:
//   - Platform webhook  `workflow.execution.handoff`        → hot lead
//   - WhatsApp webhook  `whatsapp.conversation.ended/inactive` → abandono lead
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

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid json" }, { status: 400 });
  }

  const kind = classifyKapsoEvent(req.headers.get("x-webhook-event"), body);

  try {
    const admin = createAdminSupabase();
    let res: { ok: boolean; reason?: string };
    if (kind === "handoff") {
      res = await applyHandoff(admin, storeId, body);
    } else if (kind === "conversation") {
      res = await ingestConversationEvent(admin, storeId, body);
    } else {
      res = { ok: true, reason: "skipped" }; // message events: acknowledged, ignored
    }
    return NextResponse.json({ ...res, kind });
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
