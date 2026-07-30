import { NextResponse, type NextRequest } from "next/server";
import { processSwaypWebhook, swaypWebhookConfigured } from "@/lib/swayp-ingest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Receptor del webhook de Swayp. Ellos notifican CADA cambio de estado de una
// guía, lo que reemplaza el polling y el seguimiento manual del estado.
//
// La URL se registra del lado de Swayp (no hay endpoint para darla de alta):
//   {NEXT_PUBLIC_SITE_URL}/api/webhooks/swayp
// y el token que mandan en el body debe coincidir con SWAYP_WEBHOOK_TOKEN.
//
// A diferencia de los webhooks de Kapso/Shopify, este NO es por tienda: la
// cuenta de Swayp es una sola para toda la operación, y la guía se resuelve por
// `shipments.swayp_guide`.
export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid json" }, { status: 400 });
  }

  try {
    const result = await processSwaypWebhook({ body: body as Record<string, unknown> });
    if (result.status === "unauthorized") {
      return NextResponse.json(
        {
          ok: false,
          error: "unauthorized",
          reason: result.reason,
          hint:
            result.reason === "not_configured"
              ? "SWAYP_WEBHOOK_TOKEN no está configurado en este entorno."
              : "El campo `token` del body no coincide con el configurado.",
        },
        { status: 401 },
      );
    }
    // Un "ignored" responde 200 a propósito: si devolviéramos error, Swayp
    // reintentaría para siempre una guía que no es nuestra o un estado que no
    // conocemos. Recibido y descartado es la respuesta correcta.
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "error" },
      { status: 500 },
    );
  }
}

/**
 * Health-check para la puesta en marcha. Swayp registra la URL de su lado y
 * necesita comprobar que existe y que ya cargamos el token ANTES de disparar
 * notificaciones reales — sin este GET, su única forma de verificar es mandar
 * un POST y leer un 401 que no distingue "URL mal escrita" de "falta el token".
 * No expone el token ni ningún dato: sólo si está presente.
 */
export async function GET() {
  return NextResponse.json({
    ok: true,
    endpoint: "swayp-webhook",
    configured: swaypWebhookConfigured(),
    expects: { method: "POST", body: { token: "string", guide_number: "string", state: "string" } },
  });
}
