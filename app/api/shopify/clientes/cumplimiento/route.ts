import { NextResponse, type NextRequest } from "next/server";
import { createAdminSupabase } from "@/lib/db";
import { env } from "@/lib/env";
import { recordShopifyPrivacyRequest } from "@/lib/shopify-privacy";

// Webhooks obligatorios de privacidad de la app de clientes (MOM §29.15.9):
// customers/data_request, customers/redact y shop/redact. Es la URL que se
// configura en el Dev Dashboard para los tres. Firma con el secreto de la app
// (no el de la tienda): una firma inválida responde 401, como pide Shopify.
//   POST /api/shopify/clientes/cumplimiento
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const rawBody = await req.text(); // crudo: la firma es sobre el cuerpo exacto
  try {
    const result = await recordShopifyPrivacyRequest(createAdminSupabase(), {
      topic: req.headers.get("x-shopify-topic"),
      rawBody,
      hmacHeader: req.headers.get("x-shopify-hmac-sha256"),
      webhookIdHeader: req.headers.get("x-shopify-webhook-id"),
      secret: env.shopifyClientAppApiSecret(),
    });
    switch (result.status) {
      case "unauthorized":
        return new NextResponse("invalid hmac", { status: 401 });
      case "invalid":
        return NextResponse.json({ ok: false, error: result.message }, { status: 400 });
      default:
        return NextResponse.json({ ok: true, status: result.status });
    }
  } catch (e) {
    // 5xx: Shopify reintenta y el aviso no se pierde.
    const message = e instanceof Error ? e.message : "internal error";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
