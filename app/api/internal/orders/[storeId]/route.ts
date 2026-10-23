import { NextResponse, after, type NextRequest } from "next/server";
import { createAdminSupabase } from "@/lib/db";
import { handleBotOrder, readBodyCapped } from "@/lib/bot-orders";

// Pedidos del bot de Kapso, creados por Kapta en WooCommerce (MOM §38.13,
// docs/kapso-pedidos-kapta.md). El bot llama aquí desde el corte de Shopify en
// vez de crear el pedido él mismo; Kapta lo crea con el mismo núcleo que
// «Generar pedido» y contesta con el número para confirmarlo a la clienta.
//
//   POST /api/internal/orders/<storeId>
//   Authorization: Bearer <secreto del bot de esa tienda>   (Ajustes → «Bot de Kapso → pedidos por Kapta»)
//   Content-Type: application/json
//
// No está bajo /api/cron ni usa CRON_SECRET: el secreto es de cada tienda y se
// guarda solo como sha256 (0277). Todo lo demás (el candado, los códigos, el
// registro sin datos de la clienta) vive en lib/bot-orders.ts.
//
// El cuerpo NO se lee aquí: `handleBotOrder` lo lee recién después del secreto
// y con tope (`readBodyCapped`, 16 KB); un `Content-Length` de más es 413 sin
// leer nada ni consultar la base.

// Necesita crypto de Node (sha256, timingSafeEqual) y el cliente service-role.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// La venta termina a los 42 s de empezada la llamada (`BOT_ORDER_SALE_DEADLINE_MS`,
// lo que tardó la base antes se le descuenta) y después van el candado y la
// fila local, con 5 s de tope cada uno: la respuesta sale antes de 60 s. Y 60 s
// es menos que el plazo del candado (`BOT_ORDER_CLAIM_TTL_MS`, 120 s): un
// candado vivo nunca se toma por vencido.
export const maxDuration = 60;

export async function POST(req: NextRequest, ctx: { params: Promise<{ storeId: string }> }) {
  const { storeId } = await ctx.params;
  const result = await handleBotOrder(
    {
      storeId,
      authorization: req.headers.get("authorization"),
      contentLength: req.headers.get("content-length"),
      readBody: (maxBytes) => readBodyCapped(req.body, maxBytes),
    },
    { admin: createAdminSupabase(), defer: (work) => after(work) },
  );
  return NextResponse.json(result.body, {
    status: result.status,
    headers: {
      "cache-control": "no-store",
      ...(result.status === 401 ? { "www-authenticate": 'Bearer realm="kapta"' } : {}),
      ...(!result.body.ok && result.body.retry_after_seconds ? { "retry-after": String(result.body.retry_after_seconds) } : {}),
    },
  });
}
