import { NextResponse, type NextRequest } from "next/server";
import { processWooWebhook, type WooWebhookResult } from "@/lib/ingest";
import { wooWebhookHttpStatus } from "@/lib/woocommerce-intake";

// Webhooks de pedidos de WooCommerce (MOM §38.11). Apartada de la de Shopify a
// propósito: otra firma, otro secreto, otra regla para los fallos.
//
// WooCommerce NO reintenta un aviso fallido y desactiva el webhook después de 5
// fallos seguidos. Por eso esta ruta contesta 2xx a todo lo que reintentar no
// arregla —y aquí, como nada se reintenta, eso es todo salvo una firma mala—; lo
// que se pierda lo trae la pasada `woo_orders` cada 5 minutos. Las excepciones:
//   · 401 si la firma no cuadra (el secreto está mal: que se vea en WooCommerce);
//   · 404 al ping de alta de una tienda que no existe (dirección mal pegada:
//     WooCommerce lo muestra al crear el webhook);
//   · 503 al ping si no se pudo leer la tienda (se vuelve a guardar el webhook).

// Necesita crypto de Node (HMAC, sha256) y el cliente service-role.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, ctx: { params: Promise<{ storeId: string }> }) {
  const { storeId } = await ctx.params;
  const rawBody = await req.text(); // crudo: la firma es sobre estos bytes

  let result: WooWebhookResult;
  try {
    result = await processWooWebhook({
      storeId,
      rawBody,
      topic: req.headers.get("x-wc-webhook-topic"),
      resource: req.headers.get("x-wc-webhook-resource"),
      event: req.headers.get("x-wc-webhook-event"),
      signature: req.headers.get("x-wc-webhook-signature"),
      deliveryId: req.headers.get("x-wc-webhook-delivery-id"),
      source: req.headers.get("x-wc-webhook-source"),
    });
  } catch (e) {
    // Un fallo inesperado tampoco se arregla reintentando (WooCommerce no lo
    // hace): 200 con el motivo, y la pasada lo recoge.
    const message = e instanceof Error ? e.message : "error interno";
    console.error(`[woo-webhook] ${JSON.stringify({ storeId, error: message })}`);
    result = { status: "error", message };
  }

  const status = wooWebhookHttpStatus(result);
  if (status === 401) return new NextResponse("invalid signature", { status });
  const ok = result.status === "ok" || result.status === "duplicate" || result.status === "ping" || result.status === "ignored";
  return NextResponse.json(
    {
      ok,
      ...(result.status === "duplicate" ? { duplicate: true } : {}),
      ...(result.status === "ping" ? { ping: true } : {}),
      ...(result.status === "ignored" ? { ignored: true } : {}),
      ...(result.message ? { [ok ? "message" : "error"]: result.message } : {}),
    },
    { status },
  );
}
