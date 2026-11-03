import { NextResponse, type NextRequest } from "next/server";
import { createAdminSupabase } from "@/lib/db";
import { botResponseHeaders, readBodyCapped } from "@/lib/bot-orders";
import { handleBotOrderLookup } from "@/lib/bot-order-lookup";

// Consultar un pedido que YA existe, para el bot de Kapso (MOM §38.13,
// docs/kapso-pedidos-kapta.md sección 10; caso de la página de gracias del
// 24-10-2026). Solo lectura: no crea, no escribe y no llama a WooCommerce ni a
// Shopify.
//
//   POST /api/internal/orders/<storeId>/lookup
//   Authorization: Bearer <el mismo secreto del bot que para crear>
//   Content-Type: application/json
//   { "order_name": "KP200001", "phone": "51965391481" }
//
// POST y no GET a propósito: el celular va en el cuerpo, nunca en la dirección,
// que queda en los registros de acceso. Todo lo demás (el secreto, la
// privacidad, los códigos) vive en lib/bot-order-lookup.ts.

// Necesita crypto de Node (sha256, timingSafeEqual) y el cliente service-role.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Tres pasos de la base como mucho (el secreto, el pedido, su fila del Master),
// con 5 s de tope cada uno (`BOT_ORDER_DB_TIMEOUT_MS`): 15 s en el peor caso.
// Lo normal es menos de un segundo.
export const maxDuration = 20;

export async function POST(req: NextRequest, ctx: { params: Promise<{ storeId: string }> }) {
  const { storeId } = await ctx.params;
  const result = await handleBotOrderLookup(
    {
      storeId,
      authorization: req.headers.get("authorization"),
      contentLength: req.headers.get("content-length"),
      readBody: (maxBytes) => readBodyCapped(req.body, maxBytes),
    },
    { admin: createAdminSupabase() },
  );
  return NextResponse.json(result.body, { status: result.status, headers: botResponseHeaders(result.status, result.body) });
}
