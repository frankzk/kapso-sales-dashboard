import { NextResponse, type NextRequest } from "next/server";
import { processFlowWebhook } from "@/lib/ingest";

// Needs Node crypto (constant-time secret compare) + the service-role client.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET: lightweight ping so the endpoint URL can be validated from a browser or
// Shopify Flow test without sending a real event.
export async function GET(_req: NextRequest, ctx: { params: Promise<{ storeId: string }> }) {
  const { storeId } = await ctx.params;
  return NextResponse.json({ ok: true, endpoint: "flow", storeId });
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ storeId: string }> }) {
  const { storeId } = await ctx.params;
  const rawBody = await req.text();

  // Validation-phase log: only the SHAPE (booleans/counts/ids), never raw PII —
  // confirms we receive what we expect (source, phone present, products, city).
  try {
    const p = JSON.parse(rawBody);
    console.log(
      "[flow-webhook]",
      JSON.stringify({
        storeId,
        source: p?.source ?? null,
        event: p?.event ?? null,
        abandonmentId: p?.abandonment?.id ?? null,
        hasPhone: Boolean(p?.customer?.phone ?? p?.customer?.defaultPhoneNumber?.phoneNumber),
        hasCity: Boolean(p?.customer?.defaultAddress?.city),
        added: Array.isArray(p?.productsAddedToCart) ? p.productsAddedToCart.length : 0,
        viewed: Array.isArray(p?.productsViewed) ? p.productsViewed.length : 0,
      }),
    );
  } catch {
    /* logging is best-effort */
  }

  try {
    const result = await processFlowWebhook({
      storeId,
      secretHeader: req.headers.get("x-recoverops-secret"),
      rawBody,
    });
    switch (result.status) {
      case "ok":
        return NextResponse.json({ ok: true });
      case "duplicate":
        return NextResponse.json({ ok: true, duplicate: true });
      case "unauthorized":
        return new NextResponse("invalid secret", { status: 401 });
      default:
        // 4xx: don't ask Flow to retry a permanently-bad payload.
        return NextResponse.json({ ok: false, error: result.message }, { status: 400 });
    }
  } catch (e) {
    // 5xx: transient failure — Flow's retry policy can re-deliver.
    const message = e instanceof Error ? e.message : "internal error";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
