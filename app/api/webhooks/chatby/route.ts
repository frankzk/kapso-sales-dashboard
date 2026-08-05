import { NextResponse, type NextRequest } from "next/server";
import { chatbyWebhookConfigured, processChatbyWebhook } from "@/lib/chatby-ingest";
import { env } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Receptor del "Live Chat Webhook" de Chatby.
//
// Se registra del lado de Chatby (Ajustes → Integrations → Live Chat Support →
// Webhook), con:
//   Webhook URL    {NEXT_PUBLIC_SITE_URL}/api/webhooks/chatby
//   Custom Header  X-Webhook-Secret: <CHATBY_WEBHOOK_SECRET>
//
// A diferencia de los webhooks de Kapso/Shopify, este NO es por tienda: Chatby
// lo configura por CUENTA, y la cuenta "AURELA KENKU" cubre las dos tiendas. La
// tienda tendrá que salir del contenido del payload, y por eso hoy esto solo
// registra: ver el comentario de db/migrations/0104_chatby_webhook_log.sql.
export async function POST(req: NextRequest) {
  // Se lee como TEXTO, no como JSON: si el cuerpo viniera mal formado, un
  // `req.json()` que lanza nos haría perder la entrega — y este webhook es la
  // única fuente del texto de las conversaciones, sin forma de pedir lo perdido.
  let rawBody: string;
  try {
    rawBody = await req.text();
  } catch {
    return NextResponse.json({ ok: false, error: "unreadable body" }, { status: 400 });
  }

  const headers: Record<string, string> = {};
  req.headers.forEach((value, key) => {
    headers[key] = value;
  });

  try {
    const result = await processChatbyWebhook({ headers, rawBody });
    if (result.status === "unauthorized") {
      return NextResponse.json(
        {
          ok: false,
          error: "unauthorized",
          reason: result.reason,
          hint:
            result.reason === "not_configured"
              ? "CHATBY_WEBHOOK_SECRET no está configurado en este entorno."
              : result.reason === "missing_secret"
                ? "Falta la cabecera. En Chatby, Custom Header: `X-Webhook-Secret: <secreto>`."
                : "El secreto de la cabecera no coincide con el configurado.",
        },
        { status: 401 },
      );
    }
    if (result.status === "error") {
      return NextResponse.json({ ok: false, error: result.reason }, { status: 500 });
    }
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "error" },
      { status: 500 },
    );
  }
}

/**
 * Health-check para la puesta en marcha, igual que en Swayp. Acá importa más:
 * la URL se pega a mano en un panel de ajustes y se guarda, y la única forma de
 * comprobar que quedó bien sería que un cliente escriba y ver si llegó algo. Un
 * GET permite verificar la URL y si el secreto ya está cargado ANTES de darle a
 * Save. No revela el secreto: solo si está presente.
 */
export async function GET() {
  return NextResponse.json({
    ok: true,
    endpoint: "chatby-live-chat-webhook",
    configured: chatbyWebhookConfigured(),
    configure: {
      webhookUrl: `${env.siteUrl()}/api/webhooks/chatby`,
      customHeader: "X-Webhook-Secret: <CHATBY_WEBHOOK_SECRET>",
    },
    note: "Chatby solo envía mensajes ENTRANTES y solo con el bot pausado.",
  });
}
