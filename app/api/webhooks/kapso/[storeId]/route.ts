import { NextResponse, type NextRequest } from "next/server";
import { authorizeKapsoRequest, processKapsoWebhook } from "@/lib/ingest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Single Kapso webhook receiver for a store. Handles both of Kapso's webhook
// systems pointed at this URL:
//   - Platform webhook  `workflow.execution.handoff`        → hot lead
//   - WhatsApp webhook  `whatsapp.conversation.ended/inactive` → abandono lead
// Configure the URL in Kapso as:
//   {SITE}/api/webhooks/kapso/<storeId>?secret=<STORE_WEBHOOK_SECRET>
//
// Auth is PER-STORE: the `secret` query param is matched (constant-time) against
// the store's own `kapso_webhook_secret` (set in Ajustes → "Rotar credenciales").
// This keeps one store owner from POSTing leads into another store. Stores that
// have not set a per-store secret yet fall back to the shared CRON_SECRET (see
// lib/ingest.ts → authorizeKapsoWebhook).

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ storeId: string }> },
) {
  const { storeId } = await ctx.params;

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid json" }, { status: 400 });
  }

  try {
    const result = await processKapsoWebhook({
      storeId,
      providedSecret: req.nextUrl.searchParams.get("secret"),
      eventHeader: req.headers.get("x-webhook-event"),
      body,
    });
    if (result.status === "unauthorized") {
      return new NextResponse("unauthorized", { status: 401 });
    }
    return NextResponse.json({ ok: true, kind: result.kind, reason: result.reason });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "error" },
      { status: 500 },
    );
  }
}

// Some providers ping with GET to validate the endpoint. Authorize it the same
// per-store way so the ping doubles as a "did I paste the right secret?" check.
export async function GET(req: NextRequest, ctx: { params: Promise<{ storeId: string }> }) {
  const { storeId } = await ctx.params;
  const creds = await authorizeKapsoRequest(storeId, req.nextUrl.searchParams.get("secret"));
  if (!creds) return new NextResponse("unauthorized", { status: 401 });
  return NextResponse.json({ ok: true });
}
