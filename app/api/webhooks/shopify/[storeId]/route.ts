import { NextResponse, type NextRequest } from "next/server";
import { processShopifyWebhook } from "@/lib/ingest";

// Needs Node crypto (HMAC) + the service-role client.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ storeId: string }> },
) {
  const { storeId } = await ctx.params;
  const rawBody = await req.text(); // raw body required for HMAC

  try {
    const result = await processShopifyWebhook({
      storeId,
      topic: req.headers.get("x-shopify-topic") ?? "orders/unknown",
      rawBody,
      hmacHeader: req.headers.get("x-shopify-hmac-sha256"),
      webhookIdHeader: req.headers.get("x-shopify-webhook-id"),
    });

    switch (result.status) {
      case "ok":
        return NextResponse.json({ ok: true });
      case "duplicate":
        return NextResponse.json({ ok: true, duplicate: true });
      case "unauthorized":
        return new NextResponse("invalid hmac", { status: 401 });
      default:
        // 4xx: don't ask Shopify to retry a permanently-bad payload.
        return NextResponse.json({ ok: false, error: result.message }, { status: 400 });
    }
  } catch (e) {
    // 5xx: transient failure — Shopify will retry.
    const message = e instanceof Error ? e.message : "internal error";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
